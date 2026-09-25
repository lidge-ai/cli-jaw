import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import type { RuntimeEvent, RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';
import type { NativeRuntimeSession } from '../../src/agent/runtime/session.ts';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { ClaudeNativeRunOptions } from '../../src/agent/claude-runtime-run.ts';
import type { ToolEntry } from '../../src/types/agent.ts';
import { beginLiveRun, setLiveRunTraceId, getLiveRun, clearLiveRun } from '../../src/agent/live-run-state.ts';
import * as controls from '../../src/agent/runtime/claude-run-controls.ts';

const { hasClaudeRuns, hasClaudeWorker } = controls;
const reserved: Array<ReturnType<typeof controls.reserveClaudeRun>> = [];
const retainedForTeardown = new Set<ReturnType<typeof controls.reserveClaudeRun>>();
// Keep real reservation/fencing behavior. Handles are captured solely so test
// teardown can remove intentionally retained failed-close fences.
mock.module('../../src/agent/runtime/claude-run-controls.js', { namedExports: { ...controls,
    reserveClaudeRun: (input: Parameters<typeof controls.reserveClaudeRun>[0]) => {
        const handle = controls.reserveClaudeRun(input); reserved.push(handle); return handle;
    },
} });

// Exercise the real shared runner and Claude adapter. Replace process/DB edges;
// the application/SDK/SQLite integration belongs to native-claude-spawn.test.ts.
let serial = 0;
const traceEnds: Array<{ id: string; status: string }> = [];
const traceClosePolicies: unknown[] = [];
const traceTools: ToolEntry[] = [];
const broadcasts: Array<{ name: string; value: Record<string, unknown> }> = [];
const ordered: string[] = [];
let failCompat = false;
const workerUpdates: Array<{ id: string; tools: unknown[] }> = [];
let slot: object | undefined;
let acquire: (input: { binding: Pick<ClaudeSessionOptions, 'getTurnContext' | 'record'> }) => Promise<unknown>;
let exit: (params: ExitHandlerParams) => Promise<void>;
mock.module('../../src/agent/runtime-pool.js', { namedExports: { acquireClaudeRuntime: (input: Parameters<typeof acquire>[0]) => acquire(input) } });
class ClaudeAcquireFailure extends Error {
    constructor(readonly cleanup: Promise<void>) { super('fixture acquisition failed'); }
}
mock.module('../../src/agent/claude-runtime-pool.js', { namedExports: { ClaudeAcquireFailure } });
mock.module('../../src/agent/lifecycle-handler.js', { namedExports: { handleAgentExit: (params: ExitHandlerParams) => exit(params) } });
mock.module('../../src/trace/store.js', { namedExports: {
    startTraceRun: () => `trace-${++serial}`, createTraceId: () => `trace-${++serial}`,
    stampTraceTool() {}, updateTraceToolRow: (tool: ToolEntry) => { traceTools.push(structuredClone(tool)); },
    finalizeTraceRun: (id: string, status: string, _error: unknown, policy: unknown) => {
        traceEnds.push({ id, status }); traceClosePolicies.push(policy);
    },
} });
// Records the user rows the adapter stores (claude-runtime-run.ts insert site).
const insertedRows: unknown[][] = [];
mock.module('../../src/core/db.js', { namedExports: { insertMessage: { run(...args: unknown[]) { insertedRows.push(args); } } } });
mock.module('../../src/core/bus.js', { namedExports: {
    broadcast: (name: string, value: Record<string, unknown>) => {
        broadcasts.push({ name, value });
        if (name === 'agent_done') { ordered.push('compat'); if (failCompat) throw new Error('compatibility observer failed'); }
    },
} });
mock.module('../../src/agent/events/helpers.js', { namedExports: { syncLiveTools() {} } });
mock.module('../../src/orchestrator/worker-registry.js', { namedExports: {
    getWorkerSlot: () => slot,
    updateWorkerTools: (id: string, tools: unknown[]) => { workerUpdates.push({ id, tools: structuredClone(tools) }); },
} });
mock.module('../../src/agent/watchdog.js', { namedExports: { attachWatchdog: () => ({ stop() {} }) } });
mock.module('../../src/agent/smoke-detector.js', { namedExports: { detectSmokeResponse: () => ({ isSmoke: false }) } });
mock.module('../../src/agent/runtime/projection.js', { namedExports: { RuntimeProjection: class {
    start() { ordered.push('start'); }
    close() { ordered.push('end'); }
} } });
mock.module('../../src/agent/runtime/events.js', { namedExports: { recordRuntimeEvent: () => null } });
const { startClaudeNativeRun, claudeFailureDiagnostic } = await import('../../src/agent/claude-runtime-run.ts');
const { withSkillMentions } = await import('../../src/core/skill-mentions.ts');

const outcome: RuntimeTurnOutcome = { status: 'done', finalText: 'answer', partialText: 'partial' };
function fixture(worker = false) {
    const child = Object.assign(new ChildProcess(), { pid: 41001 });
    let send: NativeRuntimeSession['send'] = async prompt => { if (prompt.images?.length) throw new Error('claude_images_unavailable'); return outcome; };
    let turnContext!: ReturnType<ClaudeSessionOptions['getTurnContext']>;
    let admitted = false;
    let admittedOutcome = outcome;
    let retire = async () => {};
    let retireCount = 0, releaseCount = 0, exitCount = 0;
    const session = {
        nativeSessionId: 'provider-id',
        lastError: null as string | null,
        send: async (...args: Parameters<NativeRuntimeSession['send']>) => {
            const result = await send(...args); admitted = true; admittedOutcome = result; return result;
        },
        claimTurnOutcome: () => admitted ? admittedOutcome : null,
        finalizeTurn: () => true,
        cancel: async () => {},
    };
    acquire = async input => {
        turnContext = input.binding.getTurnContext();
        return { session, child, release: () => { releaseCount++; },
            retire: async () => { retireCount++; await retire(); } };
    };
    exit = async params => {
        exitCount++;
        const selected = params.ctx.runtimeOutcome!;
        params.onRuntimeEnd?.({ kind: 'turn-end', ...selected });
        params.resolve({ text: selected.finalText ?? '', code: selected.status === 'done' ? 0 : selected.status === 'stopped' ? 130 : 1,
            runtimeOutcome: selected, tools: params.ctx.toolLog });
    };
    // Static lifecycle plumbing is intentionally absent: this fixture replaces
    // that consumer, while retaining every field the adapter itself consumes.
    const options = {
        prepared: { cwd: '/tmp', binary: 'unused', env: {}, model: 'test', systemPrompt: '', permissions: 'auto', fastMode: false },
        prompt: { text: 'prompt' }, fresh: false, timeoutMs: 1000,
        audience: worker ? 'internal' : 'public', liveScope: worker ? null : 'scope', parentLiveScope: null,
        exit: { mainManaged: !worker, agentLabel: worker ? 'worker' : 'main', scopeKey: 'scope', chatSessionId: 'chat',
            origin: 'web', model: 'test', prompt: 'prompt', opts: {}, persistenceOwner: { global: 0, scope: 0 } },
        isCurrent: () => true, isCurrentOwner: () => true, starting() {}, ready() {}, finished() {}, consumeKillReason: () => null,
    } as ClaudeNativeRunOptions;
    return { options, child, session, start: () => startClaudeNativeRun(options), setSend: (fn: typeof send) => { send = fn; },
        setRetire: (fn: typeof retire) => { retire = fn; },
        context: () => turnContext, counts: () => ({ retireCount, releaseCount, exitCount }) };
}

test.beforeEach(() => {
    reserved.length = 0; retainedForTeardown.clear();
    traceEnds.length = 0; traceTools.length = 0; broadcasts.length = 0; workerUpdates.length = 0; slot = undefined; clearLiveRun('scope');
    ordered.length = 0;
    traceClosePolicies.length = 0;
    failCompat = false;
});
test.afterEach(() => {
    try {
        const current = reserved.filter(handle => handle.current());
        assert.equal(current.length, retainedForTeardown.size, 'unexpected retained controls');
        for (const handle of current) assert.ok(retainedForTeardown.has(handle));
    } finally {
        for (const handle of reserved) handle.finish();
        assert.equal(hasClaudeRuns(), false); clearLiveRun('scope');
    }
});

for (const worker of [false, true]) test(`${worker ? 'worker' : 'main'} acquire failure settles logically while captured cleanup control remains pending`, async () => {
    const f = fixture(worker), cleanup = Promise.withResolvers<void>();
    const flags: boolean[] = [];
    let lateCleanup = 0, doneCount = 0;
    f.options.finished = (child, _cancel, queued, safe) => {
        assert.equal(child, null); assert.equal(queued, false); flags.push(safe);
    };
    f.options.cleanupUnleased = () => { lateCleanup++; };
    acquire = async () => { throw new ClaudeAcquireFailure(cleanup.promise); };
    const run = f.start(), control = reserved[0]!;
    void control.done.then(() => { doneCount++; });
    try {
        const result = await run.promise;
        assert.equal(result.code, 1); assert.equal(result.runtimeOutcome?.status, 'error');
        assert.deepEqual(flags, [false]); assert.equal(f.counts().exitCount, 0);
        assert.equal(control.current(), true, 'logical failure must not release pending physical cleanup');
        assert.equal(hasClaudeRuns('scope'), true); assert.equal(doneCount, 0);
        assert.equal(lateCleanup, 0);
        const terminal = structuredClone({ ordered, traceEnds, broadcasts });
        assert.deepEqual(ordered, ['start', 'compat', 'end']);
        cleanup.resolve(); await cleanup.promise;
        assert.equal(control.current(), false); await control.done;
        assert.equal(doneCount, 1); assert.deepEqual(flags, [false]);
        assert.equal(lateCleanup, worker ? 1 : 0, 'only workers own unleased directory cleanup');
        assert.strictEqual(await run.promise, result);
        assert.deepEqual({ ordered, traceEnds, broadcasts }, terminal, 'physical completion must not replay terminal/lifecycle work');
    } finally { cleanup.resolve(); await cleanup.promise; await run.promise; }
});

test('main acquire cleanup fulfilled early is safe at the single ordinary finalization', async () => {
    const f = fixture(), flags: boolean[] = [];
    let lateCleanup = 0;
    f.options.finished = (_child, _cancel, _queued, safe) => { flags.push(safe); };
    f.options.cleanupUnleased = () => { lateCleanup++; };
    acquire = async () => { throw new ClaudeAcquireFailure(Promise.resolve()); };
    const result = await f.start().promise, control = reserved[0]!;
    assert.equal(result.code, 1); assert.deepEqual(flags, [true]);
    assert.equal(control.current(), false); await control.done;
    assert.equal(lateCleanup, 0); assert.deepEqual(ordered, ['start', 'compat', 'end']);
});

test('main rejected acquire cleanup retains only its synthetic fence without rewriting logical failure', async () => {
    const f = fixture(), cleanup = Promise.withResolvers<void>(), flags: boolean[] = [];
    void cleanup.promise.catch(() => {});
    let done = false, lateCleanup = 0;
    f.options.finished = (_child, _cancel, _queued, safe) => { flags.push(safe); };
    f.options.cleanupUnleased = () => { lateCleanup++; };
    acquire = async () => { throw new ClaudeAcquireFailure(cleanup.promise); };
    const run = f.start(), control = reserved[0]!;
    void control.done.then(() => { done = true; });
    try {
        const result = await run.promise;
        assert.equal(control.current(), true); assert.equal(done, false);
        const terminal = structuredClone({ ordered, traceEnds, broadcasts });
        cleanup.reject(new Error('synthetic physical cleanup rejection'));
        await assert.rejects(cleanup.promise, /synthetic physical cleanup rejection/); await Promise.resolve();
        assert.equal(control.current(), true); assert.equal(hasClaudeRuns('scope'), true); assert.equal(done, false);
        assert.deepEqual(flags, [false]); assert.equal(lateCleanup, 0);
        assert.strictEqual(await run.promise, result); assert.equal(result.code, 1);
        assert.deepEqual({ ordered, traceEnds, broadcasts }, terminal);
    } finally {
        cleanup.reject(new Error('synthetic physical cleanup rejection')); await cleanup.promise.catch(() => {});
        // No SDK/process resource was acquired: only this deliberately rejected
        // synthetic handle is eligible for the existing captured-handle teardown.
        if (control.current()) retainedForTeardown.add(control);
    }
});

test('main cancellation before acquire needs no receipt and releases its control once', async () => {
    const f = fixture(), flags: boolean[] = [];
    let acquisitions = 0, lateCleanup = 0;
    acquire = async () => { acquisitions++; throw new Error('must not acquire'); };
    f.options.starting = cancel => { cancel('user'); };
    f.options.finished = (child, _cancel, _queued, safe) => { assert.equal(child, null); flags.push(safe); };
    f.options.cleanupUnleased = () => { lateCleanup++; };
    const result = await f.start().promise;
    assert.equal(result.code, 130); assert.equal(acquisitions, 0);
    assert.deepEqual(flags, [true]); assert.equal(lateCleanup, 0);
    assert.equal(reserved[0]!.current(), false); await reserved[0]!.done;
    assert.deepEqual(f.counts(), { retireCount: 0, releaseCount: 0, exitCount: 1 });
});

test('late main acquire cleanup finishes its captured control without touching a newer same-scope owner', async () => {
    const f = fixture(), cleanup = Promise.withResolvers<void>(), flags: boolean[] = [];
    let lateCleanup = 0, replacementDone = false;
    let replacement: ReturnType<typeof controls.reserveClaudeRun> | undefined;
    f.options.finished = (_child, _cancel, _queued, safe) => { flags.push(safe); };
    f.options.cleanupUnleased = () => { lateCleanup++; };
    acquire = async () => { throw new ClaudeAcquireFailure(cleanup.promise); };
    const run = f.start(), captured = reserved[0]!;
    try {
        const result = await run.promise;
        assert.equal(captured.current(), true);
        replacement = controls.reserveClaudeRun({ runId: 'replacement-' + result.traceRunId, scope: 'scope', cancel() {} });
        reserved.push(replacement); void replacement.done.then(() => { replacementDone = true; });
        f.options.isCurrent = () => false; f.options.isCurrentOwner = () => false;
        beginLiveRun('scope', 'replacement'); setLiveRunTraceId('scope', 'replacement-trace');
        const terminal = structuredClone({ ordered, traceEnds, broadcasts });
        cleanup.resolve(); await cleanup.promise;
        assert.equal(captured.current(), false); await captured.done;
        assert.equal(replacement.current(), true); assert.equal(replacementDone, false);
        assert.equal(hasClaudeRuns('scope'), true); assert.equal(getLiveRun('scope').traceRunId, 'replacement-trace');
        assert.equal(getLiveRun('scope').running, true); assert.equal(lateCleanup, 0); assert.deepEqual(flags, [false]);
        assert.deepEqual({ ordered, traceEnds, broadcasts }, terminal); assert.strictEqual(await run.promise, result);
    } finally { cleanup.resolve(); await cleanup.promise; await run.promise; replacement?.finish(); }
});

test('main plain acquire failure without a cleanup receipt preserves ordinary control release', async () => {
    const f = fixture(), flags: boolean[] = [];
    f.options.finished = (_child, _cancel, _queued, safe) => { flags.push(safe); };
    acquire = async () => { throw new Error('plain failure'); };
    assert.equal((await f.start().promise).code, 1); assert.deepEqual(flags, [false]);
    assert.equal(reserved[0]!.current(), false); await reserved[0]!.done;
});

test('send image rejection finishes its trace and live state without invoking lifecycle', async () => {
    const f = fixture();
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'bad' }];
    const result = await f.start().promise;
    assert.equal(result.code, 1);
    assert.deepEqual(traceEnds, [{ id: result.traceRunId, status: 'error' }]);
    assert.equal(getLiveRun('scope').running, false);
    assert.deepEqual(f.counts(), { retireCount: 1, releaseCount: 1, exitCount: 0 });
    assert.equal(broadcasts.filter(value => value.name === 'agent_done').length, 1);
    assert.equal(broadcasts.filter(value => value.name === 'agent_status' && value.value.running === false).length, 1);
    assert.deepEqual(ordered, ['start', 'compat', 'end']);
});

test('throwing compatibility observer still closes one pre-start fallback and its trace', async () => {
    const f = fixture(); failCompat = true;
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'unsupported' }];
    const result = await f.start().promise;
    assert.equal(result.code, 1);
    assert.deepEqual(ordered, ['start', 'compat', 'end']);
    assert.deepEqual(traceEnds, [{ id: result.traceRunId, status: 'error' }]);
    assert.equal(hasClaudeRuns(), false);
});

test('failed old run cannot clear or stop its replacement live trace', async () => {
    const f = fixture();
    f.setSend(async () => {
        beginLiveRun('scope', 'replacement'); setLiveRunTraceId('scope', 'replacement-trace');
        throw new Error('send failed after replacement');
    });
    const result = await f.start().promise;
    assert.deepEqual(traceEnds, [{ id: result.traceRunId, status: 'error' }]);
    assert.equal(getLiveRun('scope').traceRunId, 'replacement-trace');
    assert.equal(getLiveRun('scope').running, true);
    assert.equal(broadcasts.filter(value => value.name === 'agent_status' && value.value.running === false).length, 0);
});

test('lifecycle exception is not retried and still closes trace and live state', async () => {
    const f = fixture(); let calls = 0;
    exit = async () => { calls++; throw new Error('lifecycle failed'); };
    const result = await f.start().promise;
    assert.equal(calls, 1);
    assert.equal(result.code, 1);
    assert.deepEqual(traceEnds, [{ id: result.traceRunId, status: 'error' }]);
    assert.equal(getLiveRun('scope').running, false);
});

test('worker tool state reaches its captured slot during inference', async () => {
    slot = {};
    const f = fixture(true);
    f.setSend(async (_prompt, observer) => {
        const event: RuntimeEvent = { ...f.context(), version: 1, seq: 1, kind: 'tool', itemId: 'tool-1', name: 'Read', status: 'running' };
        observer(event);
        observer({ ...event, seq: 2, status: 'completed', output: 'content' });
        assert.deepEqual(workerUpdates.map(update => update.tools.map(tool => Reflect.get(tool as object, 'status'))),
            [['running'], ['completed']]);
        assert.equal(Reflect.get(workerUpdates[1]!.tools[0] as object, 'detail'), 'content');
        assert.deepEqual(workerUpdates.map(update => update.id), ['worker', 'worker']);
        return outcome;
    });
    assert.equal((await f.start().promise).code, 0);
});

test('worker tool event cannot update a replacement slot with the same ID', async () => {
    slot = {};
    const f = fixture(true);
    f.setSend(async (_prompt, observer) => {
        slot = {};
        observer({ ...f.context(), version: 1, seq: 1, kind: 'tool', itemId: 'tool-1', name: 'Read', status: 'running' });
        return outcome;
    });
    await f.start().promise;
    assert.deepEqual(workerUpdates, []);
});

test('cleanup failure preserves an already selected worker outcome and trace status', async () => {
    const f = fixture(true);
    f.options.finished = () => { throw new Error('attachment cleanup failed'); };
    const result = await f.start().promise;
    assert.equal(result.code, 0);
    assert.equal(result.runtimeOutcome?.finalText, 'answer');
    assert.deepEqual(traceEnds, [{ id: f.context().runId, status: 'done' }]);
    assert.equal(broadcasts.filter(value => value.name === 'agent_done').length, 0);
    assert.deepEqual(traceClosePolicies, [{ onlyIfRunning: true }]);
});

test('stopped unfinished worker tool is terminal in trace and snapshots before lifecycle, preserving completed tools', async () => {
    slot = {};
    const f = fixture(true);
    const stopped: RuntimeTurnOutcome = { status: 'stopped', finalText: null, partialText: 'interrupted work' };
    f.setSend(async (_prompt, observer) => {
        const event: RuntimeEvent = { ...f.context(), version: 1, seq: 1, kind: 'tool', itemId: 'unfinished', name: 'Read', status: 'running' };
        observer(event);
        observer({ ...event, seq: 2, itemId: 'finished', status: 'completed', output: 'already read' });
        return stopped;
    });
    const lifecycle = exit;
    exit = async params => {
        assert.deepEqual(params.ctx.toolLog.map(tool => tool.status), ['stopped', 'completed']);
        assert.deepEqual(traceTools.map(tool => tool.status), ['stopped']);
        assert.deepEqual(workerUpdates.at(-1)!.tools.map(tool => Reflect.get(tool as object, 'status')), ['stopped', 'completed']);
        assert.equal(params.ctx.toolLog[1]!.detail, 'already read');
        await lifecycle(params);
    };
    const result = await f.start().promise;
    assert.equal(f.counts().exitCount, 1);
    assert.equal(result.code, 130);
    assert.deepEqual(result.runtimeOutcome, stopped);
    assert.deepEqual(result.tools?.map(tool => tool.status), ['stopped', 'completed']);
});

test('successful parent result cannot mark a tool done when no native tool terminal arrived', async () => {
    const f = fixture();
    f.setSend(async (_prompt, observer) => {
        observer({ ...f.context(), version: 1, seq: 1, kind: 'tool', itemId: 'unfinished', name: 'Read', status: 'running' });
        return outcome;
    });
    const result = await f.start().promise;
    assert.equal(result.code, 0); assert.equal(result.runtimeOutcome?.finalText, 'answer');
    assert.equal(result.tools?.[0]?.status, 'stopped');
    assert.equal(traceTools.at(-1)?.status, 'stopped');
});

test('admitted background-task failure supplies the foreground-only runtime diagnostic', async () => {
    const f = fixture();
    const failed: RuntimeTurnOutcome = { status: 'error', finalText: null, partialText: '' };
    f.setSend(async () => {
        f.session.lastError = 'claude_background_tasks_unsupported';
        return failed;
    });
    const lifecycle = exit;
    exit = async params => {
        assert.equal(params.ctx.runtimeDiagnostic,
            'Claude native supports foreground tasks only. Set run_in_background:false.');
        await lifecycle(params);
    };
    const result = await f.start().promise;
    assert.equal(result.code, 1);
    assert.deepEqual(result.runtimeOutcome, failed);
});

test('failure diagnostic names the guard instead of blaming model or login', () => {
    const owner = claudeFailureDiagnostic('claude_owner_stale');
    assert.match(owner, /session was reset or a setting that changes how it runs/);
    assert.doesNotMatch(owner, /login/);
    assert.equal(claudeFailureDiagnostic('claude_eof'),
        'Claude native runtime failed (claude_eof). Check the selected model, permissions and existing CLI login.');
    assert.equal(claudeFailureDiagnostic(null),
        'Claude native runtime failed. Check the selected model, permissions and existing CLI login.');
    assert.equal(claudeFailureDiagnostic('claude_background_tasks_unsupported'),
        'Claude native supports foreground tasks only. Set run_in_background:false.');
});

test('a superseded run reports the settings/reset cause and logs its guard code once', async t => {
    const f = fixture();
    const failed: RuntimeTurnOutcome = { status: 'error', finalText: null, partialText: '' };
    f.setSend(async () => {
        f.session.lastError = 'claude_owner_stale';
        return failed;
    });
    const warn = t.mock.method(console, 'warn', () => {});
    const lifecycle = exit;
    exit = async params => {
        assert.equal(params.ctx.runtimeDiagnostic, claudeFailureDiagnostic('claude_owner_stale'));
        await lifecycle(params);
    };
    const result = await f.start().promise;
    assert.equal(result.code, 1);
    const codeLines = warn.mock.calls.filter(call => String(call.arguments[0]).includes('turn failed code=claude_owner_stale'));
    assert.equal(codeLines.length, 1);
});

test('worker send failure permits directory cleanup only after successful awaited retirement', async () => {
    const f = fixture(true), entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
    const cleanupFlags: boolean[] = [];
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'bad' }];
    f.options.finished = (_child, _cancel, _queued, safe) => { cleanupFlags.push(safe); };
    f.setRetire(async () => { entered.resolve(); await closed.promise; });
    const run = f.start();
    try {
        await entered.promise;
        assert.deepEqual(cleanupFlags, []);
        assert.equal(hasClaudeRuns(), true);
        assert.equal(f.counts().releaseCount, 0);
    } finally { closed.resolve(); }
    const result = await run.promise;
    assert.equal(result.code, 1);
    assert.deepEqual(cleanupFlags, [true]);
    assert.deepEqual(f.counts(), { retireCount: 1, releaseCount: 1, exitCount: 0 });
});

test('worker retirement rejection retains directory and real control, rejecting duplicate ID until fixture teardown', async () => {
    const f = fixture(true), cleanupFlags: boolean[] = [];
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'bad' }];
    f.options.finished = (_child, _cancel, _queued, safe) => { cleanupFlags.push(safe); };
    f.setRetire(async () => { throw new Error('physical close failed'); });
    assert.equal((await f.start().promise).code, 1);
    assert.deepEqual(cleanupFlags, [false]);
    assert.deepEqual(f.counts(), { retireCount: 1, releaseCount: 1, exitCount: 0 });
    const handle = reserved[0]!;
    assert.equal(handle.current(), true);
    assert.equal(hasClaudeRuns('scope'), true);
    assert.equal(hasClaudeWorker('worker'), true);
    let completed = false;
    void handle.done.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.throws(() => f.start(), /claude_run_already_registered_or_capacity/);
    assert.equal(reserved.length, 1);
    assert.equal(handle.current(), true);
    retainedForTeardown.add(handle);
});

test('cancel before acquisition permits directory cleanup without acquiring or retiring a lease', async () => {
    const f = fixture(true), cleanupFlags: boolean[] = [];
    let acquisitions = 0;
    acquire = async () => { acquisitions++; throw new Error('must not acquire'); };
    const beforeExit = exit;
    exit = async params => { ordered.push('compat'); await beforeExit(params); };
    f.options.starting = cancel => { cancel('user'); };
    f.options.finished = (child, _cancel, _queued, safe) => {
        assert.equal(child, null); cleanupFlags.push(safe);
    };
    const result = await f.start().promise;
    assert.equal(result.code, 130);
    assert.deepEqual(result.runtimeOutcome, { status: 'stopped', finalText: null, partialText: '' });
    assert.equal(acquisitions, 0);
    assert.deepEqual(cleanupFlags, [true]);
    assert.deepEqual(f.counts(), { retireCount: 0, releaseCount: 0, exitCount: 1 });
    assert.deepEqual(ordered, ['start', 'compat', 'end']);
});

test('settlement consumes the PID kill reason even when the captured Stop reason takes precedence', async () => {
    const f = fixture(true), reasons = new Map([[f.child.pid, 'user'], [41002, 'unrelated']]);
    const consumed: Array<number | undefined> = [];
    f.options.consumeKillReason = pid => {
        consumed.push(pid);
        const reason = reasons.get(pid) ?? null; reasons.delete(pid); return reason;
    };
    f.options.ready = (_child, cancel) => { cancel('steer'); };
    const lifecycle = exit;
    exit = async params => {
        assert.equal(params.wasKilled, true);
        assert.equal(params.wasSteer, true, 'captured steer must win over recorded user reason');
        assert.deepEqual(consumed, [41001], 'PID reason must be consumed before lifecycle');
        assert.equal(reasons.has(41001), false);
        await lifecycle(params);
        reasons.set(41001, 'replacement');
    };
    assert.equal((await f.start().promise).code, 130);
    assert.equal(f.counts().exitCount, 1);
    assert.deepEqual(consumed, [41001]);
    assert.deepEqual([...reasons], [[41002, 'unrelated'], [41001, 'replacement']]);
});

test('failure before settlement consumes only its captured PID kill reason during finalization', async () => {
    const f = fixture(true), reasons = new Map([[f.child.pid, 'user'], [41002, 'unrelated']]);
    const consumed: Array<number | undefined> = [];
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'bad' }];
    f.options.consumeKillReason = pid => {
        consumed.push(pid);
        const reason = reasons.get(pid) ?? null; reasons.delete(pid); return reason;
    };
    assert.equal((await f.start().promise).code, 1);
    assert.equal(f.counts().exitCount, 0);
    assert.deepEqual(consumed, [41001]);
    assert.deepEqual([...reasons], [[41002, 'unrelated']]);
});

test('late successful owned retirement releases its retained control only after exact cleanup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(true), entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
    const cleanupFlags: boolean[] = [];
    let lateCleanup = 0;
    f.options.prompt.images = [{ mimeType: 'image/png', data: 'bad' }];
    f.options.finished = (_child, _cancel, _queued, safe) => { cleanupFlags.push(safe); };
    f.options.cleanupUnleased = () => { assert.equal(hasClaudeWorker('worker'), true); lateCleanup++; };
    f.setRetire(async () => { entered.resolve(); await closed.promise; });
    const run = f.start();
    try {
        await entered.promise;
        t.mock.timers.tick(6000);
        assert.equal((await run.promise).code, 1);
        assert.deepEqual(cleanupFlags, [false]);
        assert.equal(hasClaudeWorker('worker'), true);
        assert.equal(lateCleanup, 0);
        assert.throws(() => f.start(), /claude_run_already_registered_or_capacity/);
    } finally { closed.resolve(); }
    await reserved[0]!.done;
    assert.equal(lateCleanup, 1);
    assert.equal(reserved[0]!.current(), false);
    assert.equal(hasClaudeWorker('worker'), false);
});

test('a main run stores what the user wrote, not the appended inline-skill block', async () => {
    const f = fixture();
    const typed = 'job text $jaw-browser';
    const skills = [{ id: 'jaw-browser', name: 'jaw-browser', description: 'Chrome', content: '# Browser skill body' }];
    const sent = withSkillMentions(typed, typed, { skills, cli: 'claude' });
    assert.ok(sent.includes('# Browser skill body'));
    f.options.exit.prompt = sent;
    insertedRows.length = 0;
    await f.start().promise;
    const userRows = insertedRows.filter(args => args[0] === 'user');
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0]?.[1], typed);
});
