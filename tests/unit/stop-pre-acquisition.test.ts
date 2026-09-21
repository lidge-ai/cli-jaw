import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: {
    ...config, detectCli: () => ({ available: true, path: process.execPath }),
} });
let entered = Promise.withResolvers<void>();
let acquisition = Promise.withResolvers<void>();
let releases = 0;
const forbidden = () => assert.fail('cancelled acquisition dispatched provider work');
const pool = await import('../../src/agent/runtime-pool.ts');
test.mock.module('../../src/agent/runtime-pool.js', { namedExports: {
    ...pool,
    acquirePiRuntime: async () => {
        entered.resolve(); await acquisition.promise;
        return { session: { sendPrompt: forbidden }, release: () => { releases++; } };
    },
    acquireCodexAppRuntime: async () => {
        entered.resolve(); await acquisition.promise;
        return { client: { startTurn: forbidden }, release: () => { releases++; } };
    },
} });
const hosts = await import('../../src/agent/codex-host-pool.ts');
let stage: 'prepare' | 'acquire' = 'acquire';
test.mock.module('../../src/agent/codex-host-pool.js', { namedExports: {
    ...hosts,
    prepareCodexAppHost: async () => {
        if (stage === 'prepare') { entered.resolve(); await acquisition.promise; }
        return { laneMode: 'fallback' };
    },
    acquireCodexAppLane: async () => {
        assert.equal(stage, 'acquire', 'stopped prepare must never acquire a lane');
        entered.resolve(); await acquisition.promise;
        return { client: { startTurn: forbidden }, release: () => { releases++; } };
    },
} });
const { spawnAgent, activeMainProcesses } = await import('../../src/agent/spawn.ts');
const { remoteStopHandler } = await import('../../src/cli/handlers/remote-session-commands.ts');
const { withSessionScope } = await import('../../src/core/session-context.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const { orchestrateAndCollectData } = await import('../../src/orchestrator/collect.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { db } = await import('../../src/core/db.ts');
const live = await import('../../src/agent/live-run-state.ts');
const { normalizePiSettings, DEFAULT_PI_SETTINGS } = await import('../../src/agent/pi-runtime.ts');
const { beginRuntimeSettingsMutation } = await import('../../src/core/runtime-settings-gate.ts');

test.beforeEach(t => {
    entered = Promise.withResolvers<void>(); acquisition = Promise.withResolvers<void>(); releases = 0;
    t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected network'));
    config.settings.workingDir = config.JAW_HOME;
    mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    config.settings.pi = normalizePiSettings(DEFAULT_PI_SETTINGS);
    config.settings.perCli = { ...config.settings.perCli, pi: { model: 'fixture', provider: 'progrok' },
        'codex-app': { model: 'fixture', effort: 'high' } };
});

for (const route of ['pi', 'codex-legacy', 'codex-multiplex', 'codex-prepare'] as const) {
    for (const completion of ['lease', 'rejection', 'lease-without-map', 'rejection-without-map'] as const) {
        test(`actual remote /stop during ${route} acquisition survives late ${completion}`, { timeout: 5000 }, async () => {
            const cli = route === 'pi' ? 'pi' : 'codex-app';
            const leaseReturned = completion.startsWith('lease');
            const mapRemoved = completion.endsWith('without-map');
            stage = route === 'codex-prepare' ? 'prepare' : 'acquire';
            config.settings.runtime = { ...config.settings.runtime, codexApp: {
                ...config.settings.runtime?.codexApp, multiplex: route !== 'codex-legacy',
            } };
            const session = createChatSession(`stop ${route} ${completion}`);
            const scope = `stop-${route}-${completion}`;
            const events: Array<{ type: string; data: Record<string, unknown> }> = [];
            const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
            addBroadcastListener(listener);
            let result: Awaited<ReturnType<typeof spawnAgent>['promise']> | undefined;
            const pending = orchestrateAndCollectData('held acquisition', {
                scope, chatSessionId: session.id, origin: 'slack', requestId: scope,
                _skipInsert: true, _skipReplayDrain: true,
                _spawnAgent: (prompt: string, options: Parameters<typeof spawnAgent>[1]) => {
                    const run = spawnAgent(prompt, { ...options, cli, model: 'fixture', sysPrompt: '',
                        _skipInsert: true, _skipHistory: true, _skipResume: true, _isSmokeContinuation: true });
                    return { ...run, promise: run.promise.then(value => { result = value; return value; }) };
                },
            });
            try {
                await entered.promise;
                const old = activeMainProcesses.get(scope)!;
                assert.equal(old.starting, true); assert.equal(old.process, null);
                await withSessionScope({ scope, chatSessionId: session.id }, () => remoteStopHandler());
                assert.equal(activeMainProcesses.has(scope), false, 'Stop removes the starting run synchronously');
                const replacement = { ...old, cancelPending: undefined, starting: false,
                    meta: { ...old.meta, requestId: 'replacement' } };
                activeMainProcesses.set(scope, replacement);
                live.beginLiveRun(scope, cli); live.setLiveRunTraceId(scope, 'replacement-trace');
                live.appendLiveRunText(scope, 'replacement output');
                const replacementLive = live.getLiveRun(scope);
                if (mapRemoved) activeMainProcesses.delete(scope);
                const afterReplacement = events.length;
                if (leaseReturned) acquisition.resolve(); else acquisition.reject(new Error('late acquisition rejection'));
                const collected = await pending;
                assert.equal(collected.text, 'tg.stoppedUser');
                assert.equal(collected.data.runtimeStatus, 'stopped');
                assert.equal(collected.data.stopCause, 'user_stop');
                assert.equal(collected.data.executionFailed, undefined);
                assert.equal(result?.code, 130);
                assert.deepEqual(result?.runtimeOutcome, { status: 'stopped', finalText: null, partialText: '' });
                assert.equal(releases, leaseReturned && stage === 'acquire' ? 1 : 0);
                assert.equal(activeMainProcesses.get(scope), mapRemoved ? undefined : replacement);
                assert.deepEqual(live.getLiveRun(scope), replacementLive);
                assert.equal(events.slice(afterReplacement).filter(e =>
                    e.type === 'agent_status' && e.data.running === false).length, 0,
                'old acquisition must not announce a foreign live run as stopped');
                assert.equal(old.starting, false);
                assert.equal(old.cancelPending, undefined, 'captured acquire hook is retired');
                assert.equal(events.filter(e => e.type === 'orchestrate_done' && e.data.requestId === scope).length, 1);
                assert.deepEqual(db.prepare('SELECT role FROM messages WHERE session_id=?').all(session.id), []);
            } finally {
                acquisition.resolve(); await pending;
                removeBroadcastListener(listener); activeMainProcesses.delete(scope); live.clearLiveRun(scope);
            }
        });
    }
}

test('actual remote /stop before settings gate opens returns interrupted receipt without acquiring', { timeout: 5000 }, async () => {
    const scope = 'stop-settings-gate', session = createChatSession(scope);
    const finish = beginRuntimeSettingsMutation();
    try {
        const run = spawnAgent('held settings', { cli: 'codex-app', scopeKey: scope, chatSessionId: session.id,
            sysPrompt: '', _skipHistory: true });
        await withSessionScope({ scope, chatSessionId: session.id }, () => remoteStopHandler());
        assert.equal(activeMainProcesses.has(scope), false);
        finish();
        const result = await run.promise;
        assert.equal(result.code, 130); assert.equal(result.executionInterrupted, true);
        assert.equal(result.stopCause, 'user_stop'); assert.equal(result.executionFailed, undefined);
    } finally { finish(); }
});

for (const multiplex of [false, true]) {
    test(`Codex /stop at acquire-to-ready handoff retains provenance, multiplex=${multiplex}`, { timeout: 5000 }, async () => {
        stage = 'acquire';
        config.settings.runtime = { ...config.settings.runtime, codexApp: {
            ...config.settings.runtime?.codexApp, multiplex,
        } };
        const scope = `handoff-${multiplex}`, session = createChatSession(scope);
        const run = spawnAgent('held acquisition handoff', { cli: 'codex-app', model: 'fixture',
            scopeKey: scope, chatSessionId: session.id, sysPrompt: '', _skipInsert: true,
            _skipHistory: true, _isSmokeContinuation: true });
        await entered.promise;
        const owner = activeMainProcesses.get(scope)!;
        let starting = owner.starting;
        let stopped: Promise<unknown> | undefined;
        Object.defineProperty(owner, 'starting', { configurable: true, get: () => starting,
            set: (value: boolean) => {
                starting = value;
                if (!value && !stopped) stopped = withSessionScope({ scope, chatSessionId: session.id }, () => remoteStopHandler());
            },
        });
        acquisition.resolve();
        const result = await run.promise;
        await stopped;
        assert.equal(result.stopCause, 'user_stop');
        assert.equal(result.runtimeOutcome?.status, 'stopped');
        assert.equal(releases, 1);
        assert.equal(activeMainProcesses.has(scope), false);
        assert.equal(owner.cancelPending, undefined);
    });
}
