import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { PiRuntimeEvent } from '../../src/agent/pi-runtime.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';

type Callbacks = { onEvent?: (event: PiRuntimeEvent) => void; onRawRecord?: (record: unknown) => void; cwd?: string };
type CleanupReceipt = Readonly<{ rpc: 'not-started' | 'closed' | 'unconfirmed';
    version: 'not-started' | 'closed' | 'unconfirmed'; cwdDisposition: 'removable' | 'retain'; reason: string | null }>;
const removable: CleanupReceipt = Object.freeze({ rpc: 'closed', version: 'closed', cwdDisposition: 'removable', reason: null });
const retained: CleanupReceipt = Object.freeze({ rpc: 'closed', version: 'unconfirmed', cwdDisposition: 'retain', reason: 'fixture-unconfirmed' });
const ownedFixturePaths = new Set<string>();
function ownFixtureDirectory(): string {
    const root = mkdtempSync(join(tmpdir(), 'pi-deletion-workspace-'));
    ownedFixturePaths.add(root); return root;
}
const fixture = {
    mode: 'ok' as 'ok' | 'acquire-failure' | 'direct-failure' | 'turn-failure' | 'raw-limit',
    calls: [] as Callbacks[], acquisitions: [] as Array<Record<string, unknown>>,
    direct: 0, releases: 0, watchdogStops: 0, cancels: 0,
    acquireGate: null as Promise<void> | null,
    lifecycleGate: null as Promise<void> | null, lifecycleFailure: false,
    turnGate: null as Promise<void> | null, cancelGate: null as Promise<void> | null,
    deferredResult: false,
    cleanupMode: 'removable' as 'removable' | 'retain' | 'missing' | 'reject',
    cleanupGate: null as Promise<CleanupReceipt> | null,
    directPaths: [] as string[],
    onDirectCreate: null as ((cwd: string) => void) | null,
    contexts: [] as RuntimeEventContext[], events: [] as RuntimeEvent[],
    lifecycle: [] as ExitHandlerParams[], legacy: [] as Array<{ type: string; data: Record<string, unknown> }>,
};

// Keep normalization/capability exports real; only launch and availability are fake.
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: {
    ...config, detectCli: () => ({ available: true, path: null }),
} });
const runtimeEvents = await import('../../src/agent/runtime/events.ts');
test.mock.module('../../src/agent/runtime/events.js', { namedExports: {
    ...runtimeEvents,
    recordRuntimeEvent: (context: RuntimeEventContext, body: RuntimeEventBody) => {
        fixture.contexts.push({ ...context });
        const event = runtimeEvents.recordRuntimeEvent(context, body);
        if (event) fixture.events.push(event);
        return event;
    },
} });

function child(): ChildProcess {
    // No real PID: cleanup cannot accidentally signal a host process.
    return Object.assign(new EventEmitter(), {
        pid: undefined, exitCode: null, signalCode: null, killed: false,
        stdin: Object.assign(new EventEmitter(), { write: () => true, end() {} }),
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
    }) as unknown as ChildProcess;
}
async function protocol(callbacks: Callbacks, turnGate = fixture.turnGate) {
    fixture.calls.push(callbacks);
    if (turnGate) await turnGate;
    if (fixture.mode === 'turn-failure') throw new Error('fixture Pi turn failed');
    const raw = (record: unknown) => callbacks.onRawRecord?.(record);
    const semantic = (event: PiRuntimeEvent) => callbacks.onEvent?.(event);
    if (fixture.mode === 'raw-limit') raw({ type: 'fixture_oversize', payload: 'x'.repeat(70_000) });
    raw({ type: 'message_start', message: { role: 'assistant' } });
    semantic({ kind: 'session', sessionId: 'provider-session-private' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'consider' } });
    semantic({ kind: 'thinking', text: 'consider' });
    raw({ type: 'tool_execution_start', toolCallId: 'provider-tool-private', toolName: 'bash',
        args: { command: 'printf fixture', password: 'RAW_SECRET_CANARY' } });
    raw({ type: 'tool_execution_update', toolCallId: 'provider-tool-private', toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'part' }] } });
    raw({ type: 'tool_execution_end', toolCallId: 'provider-tool-private', toolName: 'bash',
        result: { content: [{ type: 'text', text: 'complete' }, { type: 'image', data: 'IMAGE_MUST_NOT_PROJECT' }] } });
    semantic({ kind: 'tool', label: 'bash', status: 'done', detail: 'legacy tool detail' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello ' } });
    semantic({ kind: 'text', text: 'Hello ' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Pi' } });
    semantic({ kind: 'text', text: 'Pi' });
    raw({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unaccepted raw snapshot' }] }] });
    return { text: 'adapter fallback must not overwrite stream', stderr: '', code: 0, sessionId: 'provider-session-private' };
}
const pi = await import('../../src/agent/pi-runtime.ts');
test.mock.module('../../src/agent/pi-runtime.js', { namedExports: {
    ...pi,
    openPiRpc: (_profile: unknown, _settings: unknown, callbacks: Callbacks) => {
        fixture.direct++;
        assert.ok(callbacks.cwd);
        fixture.directPaths.push(callbacks.cwd);
        const canonical = realpathSync(callbacks.cwd);
        assert.ok(ownedFixturePaths.has(callbacks.cwd) || (dirname(canonical) === realpathSync(tmpdir())
            && basename(canonical).startsWith('jaw-emp-pi-fixture-worker-')),
            `unexpected test cwd: ${callbacks.cwd}`);
        ownedFixturePaths.add(callbacks.cwd);
        fixture.onDirectCreate?.(callbacks.cwd);
        fixture.calls.push(callbacks);
        if (fixture.mode === 'direct-failure') throw new Error('fixture direct creation failed');
        const turnGate = fixture.turnGate;
        const cleanup = fixture.cleanupGate ?? (fixture.cleanupMode === 'reject'
            ? Promise.reject(new Error('fixture cleanup receipt rejected'))
            : Promise.resolve(fixture.cleanupMode === 'retain' ? retained : removable));
        void cleanup.catch(() => {});
        const openedChild = child();
        return {
            child: openedChild,
            prepared: Promise.resolve(),
            ...(fixture.cleanupMode === 'missing' ? {} : { cleanup }),
            sessionId: null as string | null,
            get alive() { return true; },
            get abortEffective() { return false; },
            sendPrompt: (_message: string, opts?: Callbacks) =>
                Promise.resolve().then(() => protocol({ ...callbacks, ...opts }, turnGate)),
            abort: async () => {},
            close() {},
            kill() {},
        };
    },
    spawnPiRpc: (_profile: unknown, _settings: unknown, callbacks: Callbacks) => {
        fixture.direct++;
        assert.ok(callbacks.cwd);
        fixture.directPaths.push(callbacks.cwd);
        const canonical = realpathSync(callbacks.cwd);
        assert.ok(ownedFixturePaths.has(callbacks.cwd) || (dirname(canonical) === realpathSync(tmpdir())
            && basename(canonical).startsWith('jaw-emp-pi-fixture-worker-')),
            `unexpected test cwd: ${callbacks.cwd}`);
        ownedFixturePaths.add(callbacks.cwd);
        fixture.onDirectCreate?.(callbacks.cwd);
        if (fixture.mode === 'direct-failure') { fixture.calls.push(callbacks); throw new Error('fixture direct creation failed'); }
        const turnGate = fixture.turnGate;
        const cleanup = fixture.cleanupGate ?? (fixture.cleanupMode === 'reject'
            ? Promise.reject(new Error('fixture cleanup receipt rejected'))
            : Promise.resolve(fixture.cleanupMode === 'retain' ? retained : removable));
        void cleanup.catch(() => {});
        return { child: child(), done: Promise.resolve().then(() => protocol(callbacks, turnGate)),
            ...(fixture.cleanupMode === 'missing' ? {} : { cleanup }) };
    },
} });
const pool = await import('../../src/agent/runtime-pool.ts');
test.mock.module('../../src/agent/runtime-pool.js', { namedExports: {
    ...pool,
    acquirePiRuntime: async (options: Record<string, unknown>) => {
        fixture.acquisitions.push(options);
        if (fixture.acquireGate) await fixture.acquireGate;
        if (fixture.mode === 'acquire-failure') throw new Error('fixture acquire failed');
        return {
            reused: false, sessionId: 'provider-session-private',
            session: { child: child(), sessionId: 'provider-session-private', alive: true, abortEffective: false,
                sendPrompt: (_prompt: string, callbacks: Callbacks) => Promise.resolve().then(() => protocol(callbacks)),
                abort: async () => {}, close() {}, kill() {} },
            release: () => { fixture.releases++; }, cancel: async () => { fixture.cancels++; if(fixture.cancelGate) await fixture.cancelGate; },
        };
    },
} });
const watchdog = await import('../../src/agent/watchdog.ts');
test.mock.module('../../src/agent/watchdog.js', { namedExports: {
    ...watchdog, attachWatchdog: () => ({ markProgress() {}, extendDeadline() {}, stop() { fixture.watchdogStops++; } }),
} });
const traces = await import('../../src/trace/store.ts');
const live = await import('../../src/agent/live-run-state.ts');
const lifecycle = await import('../../src/agent/lifecycle-handler.ts');
test.mock.module('../../src/agent/lifecycle-handler.js', { namedExports: {
    ...lifecycle,
    handleAgentExit: async (params: ExitHandlerParams) => {
        fixture.lifecycle.push(params);
        if (fixture.lifecycleGate) await fixture.lifecycleGate;
        if (fixture.lifecycleFailure) throw new Error('fixture lifecycle failure');
        if (fixture.deferredResult) return;
        const finalText = params.code === 0 ? 'lifecycle-selected final' : null;
        params.onRuntimeEnd?.({ kind: 'turn-end', status: params.code === 0 ? 'done' : 'error', finalText });
        params.activeProcesses.delete(params.agentLabel);
        params.releaseMainRun(params.scopeKey, params.childProcess, params.ownerGeneration);
        live.clearLiveRun(params.ctx.liveScope || 'default');
        traces.finalizeTraceRun(params.ctx.traceRunId, params.code === 0 ? 'done' : 'error');
        params.resolve({ text: finalText ?? '', code: params.code ?? 0, tools: params.ctx.toolLog });
    },
} });
const { spawnAgent, activeProcesses, activeMainProcesses, armExitSettle, waitForExitSettled, settleExit, killActiveAgent } = await import('../../src/agent/spawn.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
let chatId = '';
const legacyListener = (type: string, data: Record<string, unknown>) => { fixture.legacy.push({ type, data }); };
const publicEvents: string[] = [];
let unsubscribe = () => {};

test.beforeEach(() => {
    chatId = createChatSession('Pi journal fixture').id; setActiveChatSession('default');
    fixture.mode = 'ok'; fixture.calls.length = 0; fixture.acquisitions.length = 0;
    fixture.contexts.length = 0; fixture.events.length = 0; fixture.lifecycle.length = 0; fixture.legacy.length = 0;
    fixture.direct = 0; fixture.releases = 0; fixture.watchdogStops = 0; fixture.cancels = 0; publicEvents.length = 0;
    fixture.acquireGate = null;
    fixture.lifecycleGate = null; fixture.lifecycleFailure = false; fixture.deferredResult = false;
    fixture.turnGate = null; fixture.cancelGate = null;
    fixture.cleanupMode = 'removable'; fixture.cleanupGate = null; fixture.directPaths.length = 0; fixture.onDirectCreate = null;
    activeMainProcesses.clear(); activeProcesses.clear();
    config.settings['workingDir'] = ownFixtureDirectory();
    mkdirSync(join(config.settings['workingDir'], 'prompts'), { recursive: true });
    mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    config.settings['fallbackOrder'] = []; config.settings['activeOverrides'] = {};
    config.settings['pi'] = pi.normalizePiSettings(pi.DEFAULT_PI_SETTINGS);
    config.settings['perCli'] = { ...config.settings['perCli'], pi: { model: 'fixture-pi', effort: 'high', provider: 'progrok' } };
    config.settings['multiSession'] = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer',
        channels: { telegram: true, discord: true, slack: true } };
    addBroadcastListener(legacyListener);
    unsubscribe = subscribe(event => { if (event.event === 'agent_runtime' || event.event === 'agent_runtime_gap') publicEvents.push(event.event); });
});
test.afterEach(() => {
    removeBroadcastListener(legacyListener); unsubscribe();
    // These tests launch no OS children: every direct/pool child is an EventEmitter without a PID.
    for (const root of ownedFixturePaths) rmSync(root, { recursive: true, force: true });
    ownedFixturePaths.clear();
});
function opts(employee = false) {
    return { cli: 'pi', model: 'fixture-pi', effort: 'high', scopeKey: 'pi-test-scope', chatSessionId: chatId,
        requestId: 'pi-test-request', runtimeParentItemId: 'jaw-parent-item', origin: 'web',
        sysPrompt: employee ? 'employee fixture instructions' : '', _skipInsert: true, _skipHistory: true,
        _skipResume: true, _isSmokeContinuation: true, ...(employee ? { agentId: 'pi-fixture-worker' } : {}) };
}
function assertCanonicalContext(employee: boolean) {
    assert.ok(fixture.events.length > 0, 'real spawn must feed the shared runtime emitter');
    for (const context of fixture.contexts) {
        assert.equal(context.sessionId, chatId); assert.equal(context.scope, 'pi-test-scope');
        assert.equal(context.parentItemId, 'jaw-parent-item');
        assert.equal(context.audience, employee ? 'internal' : 'public');
        assert.equal(context.turnId, context.runId);
    }
    assert.equal(fixture.events.filter(e => e.kind === 'turn-start').length, 1);
    assert.equal(fixture.events.filter(e => e.kind === 'turn-end').length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.events), /RAW_SECRET_CANARY|IMAGE_MUST_NOT_PROJECT|provider-session-private|provider-tool-private/);
}

for (const employee of [false, true]) {
    test(`real Pi ${employee ? 'employee direct' : 'main pooled'} spawn wires raw, semantic and lifecycle observers`, async () => {
        const run = spawnAgent('fixture prompt', opts(employee));
        assert.equal(Boolean(run.child), employee);
        const result = await run.promise;
        assert.equal(result.text, 'lifecycle-selected final'); assert.equal(result.code, 0);
        assert.equal(fixture.direct, employee ? 1 : 0); assert.equal(fixture.acquisitions.length, employee ? 0 : 1);
        assert.equal(fixture.releases, employee ? 0 : 1); assert.equal(fixture.watchdogStops, 1);
        assert.equal(typeof fixture.calls[0]?.onRawRecord, 'function'); assert.equal(typeof fixture.calls[0]?.onEvent, 'function');
        assert.equal(fixture.lifecycle.length, 1); assert.equal(typeof fixture.lifecycle[0]?.onRuntimeEnd, 'function');
        assert.equal(fixture.lifecycle[0]?.ctx.fullText, 'Hello Pi');
        assert.equal(fixture.lifecycle[0]?.ctx.sessionId, 'provider-session-private');
        assert.equal(fixture.lifecycle[0]?.ctx.runtimeOutcome?.status, 'done');
        assert.equal(fixture.lifecycle[0]?.ctx.runtimeOutcome?.partialText, 'adapter fallback must not overwrite stream');
        assert.equal(fixture.lifecycle[0]?.ctx.toolLog.filter(tool => tool.label === 'bash').length, 1);
        assertCanonicalContext(employee);
        const traceId = fixture.events[0]!.runId;
        assert.equal(traces.getTraceRun(traceId)?.session_id, chatId);
        assert.equal(traces.getTraceRun(traceId)?.scope_key, 'pi-test-scope');
        const page = readActivityPage({ runId: traceId, sessionId: chatId, after: 0, limit: 40 });
        if (employee) assert.equal(page, null);
        else { assert.deepEqual(page!.events, fixture.events); assert.equal(page!.incomplete, false); }
        assert.equal(fixture.events.at(-1)?.kind, 'turn-end');
        assert.equal((fixture.events.at(-1) as Extract<RuntimeEvent, { kind: 'turn-end' }>).finalText, 'lifecycle-selected final');
        const tools = fixture.events.filter((e): e is Extract<RuntimeEvent, { kind: 'tool' }> => e.kind === 'tool');
        assert.deepEqual(tools.map(e => e.status), ['running', 'running', 'done']);
        assert.equal(new Set(tools.map(e => e.itemId)).size, 1);
        assert.equal(tools.at(-1)?.output, 'complete');
        const messages = fixture.events.filter((e): e is Extract<RuntimeEvent, { kind: 'message' }> => e.kind === 'message');
        assert.ok(messages.length > 0); assert.ok(messages.every(e => e.phase === 'unknown'));
        assert.equal(messages.at(-1)?.text, 'Hello Pi');
        assert.equal(fixture.legacy.filter(e => e.type === 'agent_output').map(e => e.data['text']).join(''), 'Hello Pi');
        const rows = traces.listTraceEvents(fixture.events[0]!.runId, 0, 200).events;
        assert.ok(rows.some(row => row.event_type === 'pi_rpc:tool_execution_start' && row.source === 'cli_raw'));
        assert.ok(rows.find(row => row.event_type === 'pi_rpc:tool_execution_start')!.seq < tools[0]!.seq);
        assert.equal(activeMainProcesses.has('pi-test-scope'), false); assert.equal(activeProcesses.has('pi-fixture-worker'), false);
        if (employee) { assert.equal(publicEvents.length, 0); assert.equal(existsSync(fixture.calls[0]!.cwd!), false); }
        else assert.ok(publicEvents.includes('agent_runtime'));
    });
}

test('Pi raw budget loss keeps canonical final, accepted tools and legacy result alive', async () => {
    fixture.mode = 'raw-limit';
    const result = await spawnAgent('budget fixture', opts()).promise;
    assert.equal(result.text, 'lifecycle-selected final'); assertCanonicalContext(false);
    assert.equal(publicEvents.includes('agent_runtime_gap'), false, 'retention loss is not persistence failure');
    const rows = traces.listTraceEvents(fixture.events[0]!.runId, 0, 200).events;
    assert.equal(rows.filter(row => row.event_type === 'pi_rpc:raw_retention_limited').length, 1);
    assert.equal(rows.filter(row => row.event_type === 'pi_rpc:agent_end').length, 1);
    assert.ok(rows.filter(row => row.source === 'cli_raw').reduce((bytes, row) => bytes + (row.bytes ?? 0), 0) <= 4 * 1024 * 1024);
    assert.ok(fixture.events.some(e => e.kind === 'tool' && e.status === 'done'));
    assert.equal(fixture.lifecycle[0]?.ctx.fullText, 'Hello Pi');
});

test('rejected Pi turn uses error lifecycle observer once and releases pooled lease', async () => {
    fixture.mode = 'turn-failure';
    const result = await spawnAgent('failure fixture', opts()).promise;
    assert.equal(result.code, 1); assert.equal(fixture.releases, 1); assert.equal(fixture.watchdogStops, 1);
    assert.equal(fixture.lifecycle.length, 1); assert.equal(typeof fixture.lifecycle[0]?.onRuntimeEnd, 'function');
    assertCanonicalContext(false);
    assert.ok(fixture.events.some(e => e.kind === 'turn-end' && e.status === 'error' && e.finalText === null));
    assert.equal(activeMainProcesses.has('pi-test-scope'), false);
});

for (const invalidation of ['stop', 'replacement', 'generation'] as const) {
    test(`late successful Pi acquire after ${invalidation} cannot dispatch or insert a user message`, { timeout: 10_000 }, async () => {
        const gate = Promise.withResolvers<void>(); fixture.acquireGate = gate.promise;
        const { db } = await import('../../src/core/db.ts');
        const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
        const run = spawnAgent('cancelled pending acquisition', { ...opts(), _skipInsert: false });
        const owner = activeMainProcesses.get('pi-test-scope')!;
        let replacement: typeof owner | undefined;
        if (invalidation === 'stop') killActiveAgent('pi-test-scope', 'user');
        else if (invalidation === 'generation') bumpScopeSessionGeneration('pi-test-scope');
        else {
            replacement = { ...owner, meta: { ...owner.meta, requestId: 'replacement' } };
            activeMainProcesses.set('pi-test-scope', replacement);
            live.beginLiveRun('pi-test-scope', 'pi');
            live.setLiveRunTraceId('pi-test-scope', 'replacement-trace');
            live.appendLiveRunText('pi-test-scope', 'kept replacement');
        }
        gate.resolve(); const result = await run.promise;
        assert.notEqual(result.code, 0);
        assert.equal(fixture.calls.length, 0);
        assert.equal(fixture.releases, 1);
        assert.equal(fixture.watchdogStops, 0);
        assert.equal(fixture.lifecycle.length, 0);
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(chatId, 'user'), []);
        assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'interrupted');
        if (replacement) {
            assert.equal(activeMainProcesses.get('pi-test-scope') === replacement, true);
            assert.equal(live.getLiveRun('pi-test-scope').traceRunId, 'replacement-trace');
        } else assert.equal(activeMainProcesses.has('pi-test-scope'), false);
    });
}

test('Pi keeps its lease and caller pending through application settlement', { timeout: 10_000 }, async () => {
    const gate = Promise.withResolvers<void>(); fixture.lifecycleGate = gate.promise;
    const run = spawnAgent('held lifecycle', opts());
    let completed = false; void run.promise.then(() => { completed = true; });
    try {
        for (let i = 0; i < 50 && fixture.lifecycle.length === 0; i++) await new Promise<void>(r => setImmediate(r));
        assert.equal(fixture.lifecycle.length, 1);
        assert.equal(fixture.releases, 0, 'lease must remain exclusive during lifecycle');
        assert.equal(completed, false);
    } finally { gate.resolve(); await run.promise; }
    assert.equal(fixture.releases, 1);
});

for (const mode of ['ok', 'turn-failure'] as const) test(`Pi ${mode} lifecycle rejection cannot re-enter finalization or strand caller`, { timeout: 10_000 }, async () => {
    fixture.mode = mode; fixture.lifecycleFailure = true;
    const result = await spawnAgent('lifecycle failure', opts()).promise;
    assert.equal(result.code, 1); assert.equal(fixture.lifecycle.length, 1); assert.equal(fixture.releases, 1);
    assert.equal(fixture.events.filter(e => e.kind === 'turn-end').length, 1);
    assert.equal(activeMainProcesses.has('pi-test-scope'), false);
    assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'error');
});

test('Pi late legacy continuation result remains pending until its actual callback after cleanup', { timeout: 10_000 }, async () => {
    fixture.deferredResult = true;
    const run = spawnAgent('late callback', opts()); let completed = false;
    void run.promise.then(() => { completed = true; });
    for (let i = 0; i < 50 && fixture.releases === 0; i++) await new Promise<void>(r => setImmediate(r));
    assert.equal(fixture.releases, 1); assert.equal(fixture.lifecycle.length, 1); assert.equal(completed, false);
    fixture.lifecycle[0]!.resolve({ text: 'late continuation', code: 0 });
    assert.equal((await run.promise).text, 'late continuation');
});

test('old Pi application finalization cannot settle a newer scope barrier', { timeout: 10_000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = Promise.withResolvers<void>(); fixture.lifecycleGate = gate.promise;
    const scope = 'pi-test-scope'; armExitSettle(scope);
    const oldBarrier = waitForExitSettled(scope, 10);
    const run = spawnAgent('old barrier owner', opts());
    for (let i = 0; i < 50 && fixture.lifecycle.length === 0; i++) await new Promise<void>(r => setImmediate(r));
    t.mock.timers.tick(10); await oldBarrier;
    armExitSettle(scope); let successorSettled = false;
    const successor = waitForExitSettled(scope, 1000).then(() => { successorSettled = true; });
    try {
        gate.resolve(); await run.promise; await new Promise<void>(r => setImmediate(r));
        assert.equal(successorSettled, false, 'old cleanup must not resolve a new barrier identity');
    } finally { settleExit(scope); await successor; t.mock.timers.reset(); }
});

test('Pi actual steer replaces an expired prearm with its own new barrier', {timeout:10_000}, async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const gate=Promise.withResolvers<void>();fixture.lifecycleGate=gate.promise;
    const scope='pi-test-scope';armExitSettle(scope);const old=waitForExitSettled(scope,10);
    const run=spawnAgent('real cancel after timeout',opts());
    for(let i=0;i<50&&fixture.lifecycle.length===0;i++)await new Promise<void>(r=>setImmediate(r));
    t.mock.timers.tick(10);await old;
    killActiveAgent(scope,'steer');let settled=false;const barrier=waitForExitSettled(scope,1000).then(()=>{settled=true;});
    try {gate.resolve();await run.promise;await new Promise<void>(r=>setImmediate(r));assert.equal(settled,true);}
    finally{settleExit(scope);await barrier;t.mock.timers.reset();}
});

test('Pi running status observer failure still cancels and releases the dispatched turn', {timeout:10_000}, async t => {
    let hit=0;
    const throwing=(type:string,data:Record<string,unknown>)=>{
        if(type==='agent_status'&&data.cli==='pi'&&data.running===true&&hit++===0)throw Error('fixture setup observer');
    };
    addBroadcastListener(throwing);t.after(()=>removeBroadcastListener(throwing));
    const run=spawnAgent('setup failure',opts());const result=await run.promise;
    assert.ok(hit>0);assert.equal(result.code,1);assert.equal(fixture.cancels,1);assert.equal(fixture.releases,1);
    assert.equal(fixture.watchdogStops,1);assert.equal(activeMainProcesses.has('pi-test-scope'),false);
    assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status,'error');
});

test('Pi acquisition diagnostic failure cannot strand caller or prearmed barrier', {timeout:10_000}, async t => {
    fixture.mode='acquire-failure';let hit=0;
    const throwing=(type:string)=>{if(type==='agent_done'){hit++;throw Error('fixture diagnostic observer');}};
    addBroadcastListener(throwing);t.after(()=>removeBroadcastListener(throwing));
    armExitSettle('pi-test-scope');let settled=false;const barrier=waitForExitSettled('pi-test-scope').then(()=>{settled=true;});
    const result=await spawnAgent('acquire failure diagnostic',opts()).promise;await barrier;
    assert.equal(result.code,1);assert.equal(hit,1);assert.equal(settled,true);assert.equal(activeMainProcesses.has('pi-test-scope'),false);
});

for(const first of ['done','cancel']) test(`Pi setup cleanup waits for both completion and cancellation: ${first} first`, {timeout:10_000}, async t => {
    const done=Promise.withResolvers<void>(),cancel=Promise.withResolvers<void>();
    fixture.turnGate=done.promise;fixture.cancelGate=cancel.promise;
    let hit=false;
    const throwing=(type:string,data:Record<string,unknown>)=>{if(!hit&&type==='agent_status'&&data.cli==='pi'&&data.running===true){hit=true;throw Error('setup gated');}};
    addBroadcastListener(throwing);t.after(()=>removeBroadcastListener(throwing));
    const run=spawnAgent('gated cleanup',opts());let completed=false;void run.promise.then(()=>{completed=true;});
    try {
        for(let i=0;i<50&&!hit;i++)await new Promise<void>(r=>setImmediate(r));
        assert.equal(hit,true);assert.equal(fixture.cancels,1);
        (first==='done'?done:cancel).resolve();await new Promise<void>(r=>setImmediate(r));
        assert.equal(fixture.releases,0);assert.equal(completed,false);
    } finally {done.resolve();cancel.resolve();await run.promise;}
    assert.equal(fixture.releases,1);assert.equal(fixture.watchdogStops,1);
});

test('Pi exceptional cleanup preserves a replacement main and its live trace', {timeout:10_000}, async () => {
    const gate=Promise.withResolvers<void>();fixture.lifecycleGate=gate.promise;fixture.lifecycleFailure=true;
    const run=spawnAgent('old failure',opts());
    for(let i=0;i<50&&fixture.lifecycle.length===0;i++)await new Promise<void>(r=>setImmediate(r));
    const old=activeMainProcesses.get('pi-test-scope')!;
    const replacement={...old,meta:{...old.meta,requestId:'new-owner'}};
    activeMainProcesses.set('pi-test-scope',replacement);
    live.beginLiveRun('pi-test-scope','pi');live.setLiveRunTraceId('pi-test-scope','replacement-trace');
    live.appendLiveRunText('pi-test-scope','replacement content');
    gate.resolve();const result=await run.promise;
    assert.equal(result.code,1);assert.equal(activeMainProcesses.get('pi-test-scope')===replacement,true);
    assert.equal(live.getLiveRun('pi-test-scope').traceRunId,'replacement-trace');assert.equal(fixture.releases,1);
});

test('Pi acquire failure closes trace/live state and settles the armed exit barrier without timeout', async context => {
    fixture.mode = 'acquire-failure';
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const scope = 'pi-test-scope';
    armExitSettle(scope);
    let settled = false;
    const barrier = waitForExitSettled(scope).then(() => { settled = true; });
    try {
        await Promise.resolve();
        assert.equal(settled, false, 'the waiter must observe an armed, unresolved barrier');
        const result = await spawnAgent('acquire fixture', opts()).promise;
        // Drain promise continuations via one event-loop turn. Fake setTimeout
        // is NEVER advanced: the waiter's fallback deadline cannot pass this.
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(settled, true, 'acquire cleanup must call settleExit, not rely on waiter timeout');
        assert.equal(result.code, 1); assertCanonicalContext(false);
        assert.equal(fixture.lifecycle.length, 0); assert.equal(fixture.releases, 0);
        assert.equal(activeMainProcesses.has(scope), false);
        assert.equal(live.getLiveRun(scope).running, false);
        assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'error');
    } finally {
        settleExit(scope);
        await barrier;
        context.mock.timers.reset();
    }
});

test('synchronous employee Pi creation failure closes trace and removes its temporary cwd', () => {
    fixture.mode = 'direct-failure';
    assert.throws(() => spawnAgent('direct fixture', opts(true)), /fixture direct creation failed/);
    assertCanonicalContext(true);
    assert.equal(fixture.lifecycle.length, 0); assert.equal(fixture.acquisitions.length, 0);
    assert.equal(existsSync(fixture.calls[0]!.cwd!), false);
    assert.equal(activeProcesses.has('pi-fixture-worker'), false);
    assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'error');
    assert.equal(publicEvents.length, 0);
});

test('late Pi acquire rejection cannot clean up a replacement owner with the same generation', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let rejectAcquire!: (reason: Error) => void;
    fixture.acquireGate = new Promise<void>((_resolve, reject) => { rejectAcquire = reject; });
    const scope = 'pi-test-scope';
    const oldRun = spawnAgent('old deferred acquire', opts());
    let barrier: Promise<void> = Promise.resolve();
    try {
        assert.equal(fixture.acquisitions.length, 1, 'old acquire is waiting on the explicit gate');
        const capturedOwner = activeMainProcesses.get(scope);
        assert.ok(capturedOwner);
        const oldTraceId = fixture.events[0]!.runId;
        // Equal generation and equal null process deliberately defeat a
        // generation/PID-only guard; only captured object ownership is enough.
        const replacement = { ...capturedOwner, meta: { ...capturedOwner.meta, requestId: 'replacement-request' } };
        assert.notEqual(replacement, capturedOwner);
        assert.equal(replacement.ownerGeneration, capturedOwner.ownerGeneration);
        assert.equal(replacement.process, capturedOwner.process);
        activeMainProcesses.set(scope, replacement);
        live.beginLiveRun(scope, 'pi');
        live.setLiveRunTraceId(scope, 'tr_replacement_fixture0001');
        live.appendLiveRunText(scope, 'replacement live content');
        const replacementLive = live.getLiveRun(scope);
        armExitSettle(scope);
        let barrierSettled = false;
        barrier = waitForExitSettled(scope).then(() => { barrierSettled = true; });
        await Promise.resolve();
        assert.equal(barrierSettled, false);
        const beforeFailure = fixture.legacy.length;
        rejectAcquire(new Error('old acquire rejected after replacement'));
        const result = await oldRun.promise;
        // Promise callbacks drain without advancing ANY fake timeout. The new
        // barrier cannot appear preserved/settled merely because of a deadline.
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(result.code, 1, 'old invocation still resolves its own failure');
        assert.equal(traces.getTraceRun(oldTraceId)?.status, 'error');
        assertCanonicalContext(false);
        assert.deepEqual({
            ownerPreserved: activeMainProcesses.get(scope) === replacement,
            startingPreserved: replacement.starting,
            live: live.getLiveRun(scope),
            barrierSettled,
            cleanupEvents: fixture.legacy.slice(beforeFailure).filter(event =>
                event.type === 'agent_status' || event.type === 'agent_done').map(event => event.type),
        }, {
            ownerPreserved: true, startingPreserved: true, live: replacementLive,
            barrierSettled: false, cleanupEvents: [],
        });
    } finally {
        rejectAcquire(new Error('fixture cleanup'));
        settleExit(scope);
        await barrier;
        await oldRun.promise;
        activeMainProcesses.delete(scope);
        live.clearLiveRun(scope);
        fixture.acquireGate = null;
        context.mock.timers.reset();
    }
});

for (const mode of ['ok', 'turn-failure'] as const) {
    for (const cleanupMode of ['removable', 'retain', 'missing', 'reject'] as const) {
        test(`direct Pi ${mode} consumes ${cleanupMode} cleanup at the actual employee deletion boundary`, { timeout: 10_000 }, async t => {
            fixture.mode = mode; fixture.cleanupMode = cleanupMode;
            const warnings: string[] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
            const run = spawnAgent('cleanup receipt', opts(true));
            const cwd = fixture.directPaths[0]!; const sentinel = join(cwd, 'owned-sentinel');
            writeFileSync(sentinel, 'owned worker');
            const result = await run.promise;
            assert.equal(result.code, mode === 'ok' ? 0 : 1);
            assert.equal(fixture.lifecycle.length, 1);
            assert.equal(fixture.events.filter(event => event.kind === 'turn-end').length, 1);
            assert.equal(existsSync(cwd), cleanupMode !== 'removable', `cleanup mode=${cleanupMode}`);
            if (cleanupMode !== 'removable') {
                assert.equal(readFileSync(sentinel, 'utf8'), 'owned worker');
                assert.ok(warnings.some(line => line.includes(cwd)), 'retention has a real local path diagnostic');
            }
        });
    }
}

test('direct Pi setup failure retains cwd when physical cleanup is uncertified', { timeout: 10_000 }, async t => {
    fixture.cleanupMode = 'retain'; let hit = 0;
    const throwing = (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_status' && data.cli === 'pi' && data.running === true && hit++ === 0) throw Error('direct setup fixture');
    };
    addBroadcastListener(throwing); t.after(() => removeBroadcastListener(throwing));
    const run = spawnAgent('setup failure retain', opts(true));
    const cwd = fixture.directPaths[0]!; writeFileSync(join(cwd, 'sentinel'), 'retain');
    const result = await run.promise;
    assert.ok(hit > 0); assert.equal(result.code, 1);
    assert.equal(readFileSync(join(cwd, 'sentinel'), 'utf8'), 'retain');
    assert.equal(fixture.events.filter(event => event.kind === 'turn-end').length, 1);
});

test('direct Pi release waits for its cleanup receipt before deleting or resolving the caller', { timeout: 10_000 }, async () => {
    const gate = Promise.withResolvers<CleanupReceipt>(); fixture.cleanupGate = gate.promise;
    const run = spawnAgent('held cleanup', opts(true)); const cwd = fixture.directPaths[0]!;
    let completed = false; void run.promise.then(() => { completed = true; });
    try {
        for (let i = 0; i < 50 && fixture.lifecycle.length === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(fixture.lifecycle.length, 1);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(completed, false); assert.equal(existsSync(cwd), true);
    } finally { gate.resolve(removable); await run.promise; }
    assert.equal(existsSync(cwd), false);
});

for (const creationFailure of [false, true]) test(`Pi empty custom sysPrompt never owns workspace deletion, creationFailure=${creationFailure}`, { timeout: 10_000 }, async () => {
    const workspace = config.settings['workingDir']; const sentinel = join(workspace, 'workspace-sentinel');
    writeFileSync(sentinel, 'workspace must survive');
    const replacementSettings = ownFixtureDirectory();
    fixture.onDirectCreate = cwd => {
        assert.equal(cwd, workspace, 'explicit empty prompt reaches the no-allocation branch');
        config.settings['workingDir'] = replacementSettings;
    };
    if (creationFailure) {
        fixture.mode = 'direct-failure';
        assert.throws(() => spawnAgent('no allocated cwd', { ...opts(true), sysPrompt: '' }), /fixture direct creation failed/);
    } else {
        const gate = Promise.withResolvers<void>(); fixture.turnGate = gate.promise;
        const run = spawnAgent('no allocated cwd', { ...opts(true), sysPrompt: '' });
        gate.resolve(); await run.promise;
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'workspace must survive');
    assert.equal(existsSync(replacementSettings), true);
});

test('same Pi employee label and fixed clock allocate independent owned directories', { timeout: 10_000 }, async t => {
    const now = Date.now(); t.mock.method(Date, 'now', () => now);
    const firstGate = Promise.withResolvers<void>(), secondGate = Promise.withResolvers<void>();
    fixture.turnGate = firstGate.promise; const first = spawnAgent('first', opts(true));
    fixture.turnGate = secondGate.promise; const second = spawnAgent('second', { ...opts(true), scopeKey: 'pi-second-scope' });
    const [a, b] = fixture.directPaths;
    try {
        assert.ok(a && b); assert.notEqual(a, b, 'same label/time is not allocation identity');
        writeFileSync(join(a, 'sentinel'), 'first'); writeFileSync(join(b, 'sentinel'), 'second');
        firstGate.resolve(); await first.promise;
        assert.equal(existsSync(a), false); assert.equal(readFileSync(join(b, 'sentinel'), 'utf8'), 'second');
    } finally { firstGate.resolve(); secondGate.resolve(); await Promise.all([first.promise, second.promise]); }
    assert.equal(existsSync(b!), false);
});

for (const replacement of ['directory', 'symlink'] as const) test(`Pi cleanup retains a replaced ${replacement} despite removable receipt`, { timeout: 10_000 }, async () => {
    const gate = Promise.withResolvers<void>(); fixture.turnGate = gate.promise;
    const run = spawnAgent('replace owner', opts(true)); const cwd = fixture.directPaths[0]!;
    const preserved = cwd + '-preserved'; renameSync(cwd, preserved); ownedFixturePaths.add(preserved);
    const target = replacement === 'directory' ? cwd : ownFixtureDirectory();
    if (replacement === 'directory') mkdirSync(target);
    else symlinkSync(target, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(target, 'sentinel'), 'replacement must survive');
    gate.resolve(); await run.promise;
    assert.equal(existsSync(cwd), true, 'cleanup must not delete even the replacement symlink');
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'replacement must survive');
    assert.equal(existsSync(preserved), true);
});
