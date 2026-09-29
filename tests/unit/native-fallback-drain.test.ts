import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The first run of a native failure skips its queue drain because the
// orchestrator is about to re-run the request on the fallback runtime. These
// cases pin what happens around that hand-off: the drain still happens when the
// re-run cannot start, and the hand-off names both runtimes.
const realSpawn = await import('../../src/agent/spawn.ts');
const drained: string[] = [];
mock.module('../../src/agent/spawn.ts', {
    namedExports: { ...realSpawn, processQueue: async (scope: string) => { drained.push(scope); } },
});
const { broadcast, addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { orchestrateAndCollectData } = await import('../../src/orchestrator/collect.ts');

type Options = Record<string, any>;

function failedFirstRun(opts: Options, runId: string) {
    const identity = { runId, scope: opts['scopeKey'], sessionId: opts['chatSessionId'], origin: opts['origin'],
        ...(opts['requestId'] ? { requestId: opts['requestId'] } : {}) };
    opts['lifecycle']?.onActivity?.('native-runtime', identity);
    const pin = { scope: identity.scope, sessionId: identity.sessionId, origin: identity.origin,
        requestId: opts['requestId'], traceRunId: runId, runtimeFinality: 'absent' };
    return Promise.resolve().then(() => {
        broadcast('agent_done', { ...pin, runtimeStatus: 'error', text: '', fallbackPending: 'cursor' });
        return { text: '', code: 1, traceRunId: runId, nativeFallbackCli: 'cursor',
            runtimeOutcome: { status: 'error' as const, finalText: null, partialText: '' } };
    });
}

test('a fallback re-run that cannot start drains the scope queue and ends with the failure', async () => {
    drained.length = 0;
    const calls: Options[] = [];
    const spawn = (_prompt: string, opts: Options) => {
        calls.push(opts);
        if (calls.length === 2) throw new Error('fallback runtime unavailable');
        return { child: null, promise: failedFirstRun(opts, 'claude-run') };
    };
    const collected = await Promise.race([
        orchestrateAndCollectData('task', { origin: 'heartbeat', scope: 'fb-drain-scope', chatSessionId: 'fb-drain-chat',
            requestId: 'fb-drain-request', _skipReplayDrain: true, _spawnAgent: spawn }, 'en'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request never settled')), 3000)),
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(drained, ['fb-drain-scope']);
    assert.equal(collected.data['runtimeStatus'], 'error');
});

test('the native hand-off names the runtime that failed and the one taking over', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (type: string, data: Record<string, unknown>) => { if (type === 'agent_fallback') seen.push(data); };
    addBroadcastListener(listener);
    try {
        const calls: Options[] = [];
        const spawn = (_prompt: string, opts: Options) => {
            calls.push(opts);
            if (calls.length === 1) return { child: null, promise: failedFirstRun(opts, 'from-claude-run') };
            const pin = { scope: opts['scopeKey'], sessionId: opts['chatSessionId'], origin: opts['origin'],
                requestId: opts['requestId'], traceRunId: 'from-cursor-run' };
            opts['lifecycle']?.onActivity?.('native-runtime', { runId: 'from-cursor-run', scope: pin.scope,
                sessionId: pin.sessionId, origin: pin.origin, requestId: opts['requestId'] });
            return { child: null, promise: Promise.resolve().then(() => {
                broadcast('agent_done', { ...pin, runtimeFinality: 'present', runtimeStatus: 'done', text: 'OK' });
                return { text: 'OK', code: 0, traceRunId: 'from-cursor-run',
                    runtimeOutcome: { status: 'done' as const, finalText: 'OK', partialText: '' } };
            }) };
        };
        await orchestrateAndCollectData('task', { origin: 'heartbeat', scope: 'fb-from-scope', chatSessionId: 'fb-from-chat',
            requestId: 'fb-from-request', _skipReplayDrain: true, _spawnAgent: spawn,
            overrides: { cli: 'claude' } }, 'en');
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!['from'], 'claude');
        assert.equal(seen[0]!['to'], 'cursor');
    } finally {
        removeBroadcastListener(listener);
    }
});

