import { reserveSlackToolGrant, activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolScope, slackCredentialKey } from '../../src/slack/tool-context.ts';
import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as traceStore from '../../src/trace/store.ts';
import { db, getMaxMessageId, getSteerSalvageAfter, insertMessage } from '../../src/core/db.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { resetGoalStore, setGoal, updateGoal, getActiveGoal } from '../../src/goal/store.ts';
import { resetFlushCountersForTest } from '../../src/agent/memory-flush-controller.ts';
import { withSteerContext } from '../../src/agent/prompt-context.ts';
import { handoffRuntimeOutcome, lifecycleRuntimeOutcome, runtimeOutcomeExitCode } from '../../src/agent/runtime/outcome.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

let failTrace = false;
let traceFailures = 0;
mock.module('../../src/trace/store.js', { namedExports: {
    ...traceStore,
    finalizeTraceRun: (...args: Parameters<typeof traceStore.finalizeTraceRun>) => {
        if (failTrace) { traceFailures++; throw new Error('fixture journal failure'); }
        return traceStore.finalizeTraceRun(...args);
    },
    linkTraceRunToMessage: (...args: Parameters<typeof traceStore.linkTraceRunToMessage>) => {
        if (failTrace) { traceFailures++; throw new Error('fixture journal link failure'); }
        return traceStore.linkTraceRunToMessage(...args);
    },
} });
const { handleAgentExit, clearGoalTimers, setSpawnAgent } = await import('../../src/agent/lifecycle-handler.js');
const { armExitSettle, settleExit, waitForExitSettled } = await import('../../src/agent/spawn.js');

type Result = Parameters<ExitHandlerParams['resolve']>[0];
type End = Parameters<NonNullable<ExitHandlerParams['onRuntimeEnd']>>[0];
let serial = 0;
let spawnCalls = 0;
test.beforeEach(t => {
    failTrace = false;
    traceFailures = 0;
    spawnCalls = 0;
    resetFlushCountersForTest();
    resetGoalStore();
    clearGoalTimers();
    setSpawnAgent(() => {
        spawnCalls++;
        return { promise: Promise.resolve({ text: 'CONTINUATION-STUB', code: 0 }) };
    });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in lifecycle fixture'); });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
});
test.afterEach(() => { clearGoalTimers(); resetGoalStore(); });

function fixture(outcome?: RuntimeTurnOutcome) {
    const id = ++serial;
    const sessionId = 'outcome-chat-' + id;
    const scopeKey = 'outcome-scope-' + id;
    let result: Result | undefined;
    const ctx: ExitHandlerParams['ctx'] = {
        fullText: 'PROVISIONAL-FULL', liveOutputText: 'PROVISIONAL-LIVE', requestId: 'request-' + id,
        sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', turns: 0,
        traceRunId: 'tr_missing_journal_' + id,
    };
    if (outcome !== undefined) handoffRuntimeOutcome(ctx, outcome);
    const ends: End[] = [];
    const params: ExitHandlerParams = {
        ctx, code: 0, cli: 'codex-app', model: 'fixture', resumeKey: null,
        agentLabel: 'outcome-fixture', mainManaged: true, origin: 'web', prompt: 'test',
        opts: { _skipSessionPersist: true, _isSmokeContinuation: true }, cfg: {},
        ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false,
        empSid: null, isResume: false, wasKilled: false, wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: '', costLine: 'COST-MUST-NOT-CREATE-FINAL',
        resolve: value => { result = value; }, activeProcesses: new Map(), scopeKey, chatSessionId: sessionId,
        childProcess: null, releaseMainRun: () => false,
        retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
        fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
        onRuntimeEnd: end => { ends.push(end); },
    };
    const rows = () => db.prepare('SELECT content, trace_run_id FROM messages WHERE session_id = ? AND role = ? ORDER BY id')
        .all(sessionId, 'assistant') as Array<{ content: string; trace_run_id: string | null }>;
    return { params, ctx, ends, rows, sessionId, scopeKey, result: () => result };
}

async function capture(run: () => Promise<void>) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
    addBroadcastListener(listener);
    try { await run(); return events; }
    finally { removeBroadcastListener(listener); }
}

for (const finalText of [null, '', ' \n\t ', ' REAL FINAL ']) {
    test('native final MESSAGE/outcome exact; compatibility terminal tagged: ' + JSON.stringify(finalText), async () => {
        const f = fixture({ status: 'done', finalText, partialText: 'PARTIAL-ONLY' });
        const requestId = f.ctx.requestId;
        const traceRunId = f.ctx.traceRunId;
        f.ctx.sessionId = 'provider-session-not-jaw';
        f.params.releaseMainRun = () => {
            f.ctx.requestId = 'changed-after-capture';
            f.ctx.traceRunId = 'tr_changed_after_capture';
            return false;
        };
        const events = await capture(() => handleAgentExit(f.params));
        const expectedText = finalText === null || finalText.trim() === '' ? '' : finalText;
        assert.equal(f.result()?.runtimeOutcome?.finalText, finalText);
        assert.equal(f.result()?.runtimeOutcome?.partialText, 'PARTIAL-ONLY');
        assert.equal(f.result()?.traceRunId, traceRunId);
        assert.equal(f.result()?.text, expectedText);
        assert.deepEqual(f.rows().map(row => row.content), finalText === null ? [] : [finalText]);
        if (finalText !== null) assert.equal(f.rows()[0]?.trace_run_id, traceRunId);
        assert.equal(f.ends.length, 1);
        assert.equal(f.ends[0]?.finalText, finalText);
        const done = events.filter(event => event.type === 'agent_done');
        assert.equal(done.length, 1);
        assert.equal(done[0]?.data['text'], expectedText);
        assert.equal(done[0]?.data['runtimeFinality'], finalText === null ? 'absent' : 'present');
        assert.equal(done[0]?.data['runtimeStatus'], 'done');
        assert.equal(done[0]?.data['requestId'], requestId);
        assert.equal(done[0]?.data['sessionId'], f.sessionId);
        assert.equal(done[0]?.data['scope'], f.scopeKey);
        assert.equal(done[0]?.data['traceRunId'], traceRunId);
        assert.equal(done[0]?.data['traceRunId'], f.result()?.traceRunId);
        assert.equal(Object.hasOwn(done[0]!.data, 'runtimeOutcome'), false);
        assert.equal(Object.hasOwn(done[0]!.data, 'partialText'), false);
        assert.equal(f.ctx.fullText, 'PROVISIONAL-FULL');
        assert.equal(f.ctx.liveOutputText, 'PROVISIONAL-LIVE');
    });
}

test('native request identity falls back only to captured opts, not provider session', async () => {
    const f = fixture({ status: 'done', finalText: null, partialText: '' });
    delete f.ctx.requestId;
    f.params.opts.requestId = 'opts-request';
    delete f.ctx.traceRunId;
    f.ctx.sessionId = 'provider-id-is-not-a-trace-id';
    const events = await capture(() => handleAgentExit(f.params));
    assert.equal(events.find(event => event.type === 'agent_done')?.data['requestId'], 'opts-request');
    assert.equal(Object.hasOwn(f.result()!, 'traceRunId'), false);
    assert.equal(Object.hasOwn(events.find(event => event.type === 'agent_done')!.data, 'traceRunId'), false);
});

for (const status of ['error', 'stopped'] as const) {
    test('explicit ' + status + ' dominates clean process exit and emits empty terminal', async () => {
        const f = fixture({ status, finalText: null, partialText: 'unfinished' });
        const events = await capture(() => handleAgentExit(f.params));
        assert.notEqual(f.result()?.code, 0);
        assert.equal(f.result()?.runtimeOutcome?.status, status);
        assert.equal(f.result()?.text, '');
        assert.deepEqual(f.rows(), []);
        const done = events.filter(event => event.type === 'agent_done');
        assert.equal(done.length, 1);
        assert.equal(done[0]?.data['runtimeStatus'], status);
        assert.equal(done[0]?.data['runtimeFinality'], 'absent');
        assert.equal(done[0]?.data['error'], true);
        assert.equal(f.ends[0]?.status, status);
    });
}

test('handoff snapshots null/empty/partial and stop signals dominate provider done', () => {
    const f = fixture();
    const original: RuntimeTurnOutcome = { status: 'done', finalText: '', partialText: 'keep' };
    handoffRuntimeOutcome(f.ctx, original);
    original.finalText = 'later mutation';
    assert.deepEqual(f.ctx.runtimeOutcome, { status: 'done', finalText: '', partialText: 'keep' });
    assert.deepEqual(lifecycleRuntimeOutcome(f.ctx, true), { status: 'stopped', finalText: '', partialText: 'keep' });
    assert.equal(runtimeOutcomeExitCode(undefined, null), null);
    assert.equal(runtimeOutcomeExitCode(lifecycleRuntimeOutcome(f.ctx, true), 0), 130);
});

test('watchdog without a kill reason overrides native done and cannot execute its goal marker', async () => {
    activeGoalFixture();
    const f = fixture({ status: 'done', finalText: '/goal done', partialText: 'unfinished' });
    f.ctx.stallReason = 'idle watchdog timeout';
    const events = await capture(() => handleAgentExit(f.params));
    assert.equal(f.params.wasKilled, false);
    assert.equal(f.result()?.runtimeOutcome?.status, 'stopped');
    assert.equal(f.result()?.runtimeOutcome?.finalText, '/goal done');
    assert.notEqual(f.result()?.code, 0);
    assert.equal(getActiveGoal()?.status, 'active');
    assert.equal(events.filter(event => markerEvents.has(event.type)).length, 0);
    assert.equal(events.find(event => event.type === 'agent_done')?.data['runtimeStatus'], 'stopped');
});

test('wasSteer commits MESSAGE salvage before real exit barrier despite observer/trace failure', async () => {
    const f = fixture({ status: 'done', finalText: null, partialText: 'FRESH-PARTIAL' });
    f.params.wasSteer = true;
    f.params.wasKilled = true;
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nOLD', 'codex-app', '', null, f.sessionId);
    const watermark = getMaxMessageId(f.sessionId);
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nFOREIGN', 'codex-app', '', null, f.sessionId + '-other');
    failTrace = true;
    f.params.onRuntimeEnd = end => {
        f.ends.push(end);
        assert.equal(getSteerSalvageAfter(f.sessionId, watermark), '⏹️ [interrupted]\n\nFRESH-PARTIAL');
        throw new Error('projection unavailable');
    };
    armExitSettle(f.scopeKey);
    let settled = false;
    const barrier = waitForExitSettled(f.scopeKey, 5000).then(() => { settled = true; });
    try {
        const events = await capture(() => handleAgentExit(f.params));
        assert.equal(settled, false);
        const salvage = getSteerSalvageAfter(f.sessionId, watermark);
        assert.equal(salvage, '⏹️ [interrupted]\n\nFRESH-PARTIAL');
        // The salvage row owns the run so the web can mount its Activity view
        // instead of the legacy tool chip.
        assert.equal(f.rows().at(-1)?.trace_run_id, f.ctx.traceRunId);
        assert.equal(f.ctx.fullText, 'PROVISIONAL-FULL');
        assert.equal(f.result()?.runtimeOutcome?.status, 'stopped');
        assert.equal(f.result()?.runtimeOutcome?.finalText, null);
        assert.equal(f.result()?.runtimeOutcome?.partialText, 'FRESH-PARTIAL');
        assert.equal(f.result()?.text, '');
        // finalizeTraceRun plus the salvage link both hit the failing journal; neither
        // blocks the salvage row.
        assert.equal(traceFailures, 2);
        assert.equal(f.ends.length, 1);
        const done = events.filter(event => event.type === 'agent_done');
        assert.equal(done.length, 1);
        assert.equal(done[0]?.data['steered'], true);
        assert.equal(done[0]?.data['runtimeStatus'], 'stopped');
        const prompt = withSteerContext('NEW REQUEST', salvage?.replace(/^⏹️ \[interrupted\]\s*/, ''));
        assert.ok(prompt.includes('FRESH-PARTIAL') && prompt.includes('INCOMPLETE'));
        assert.ok(!prompt.includes('FOREIGN') && !prompt.includes('OLD'));
    } finally { settleExit(f.scopeKey); await barrier; }
    assert.equal(settled, true);
});

test('steer salvage links its row to a recorded trace run', async () => {
    const f = fixture({ status: 'stopped', finalText: null, partialText: 'LINKED-PARTIAL' });
    f.params.wasSteer = true;
    f.params.wasKilled = true;
    const runId = traceStore.startTraceRun({ cli: 'codex-app', model: 'fixture', sessionId: f.sessionId, scopeKey: f.scopeKey });
    f.ctx.traceRunId = runId;
    await capture(() => handleAgentExit(f.params));
    const row = db.prepare('SELECT id, trace_run_id FROM messages WHERE session_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
        .get(f.sessionId, 'assistant') as { id: number; trace_run_id: string | null };
    assert.equal(row.trace_run_id, runId);
    const run = db.prepare('SELECT message_id FROM trace_runs WHERE id = ?').get(runId) as { message_id: number | null };
    assert.equal(run.message_id, row.id);
});

test('steer salvage without a run id stores no pointer and does not throw', async () => {
    const f = fixture({ status: 'stopped', finalText: null, partialText: 'NO-RUN-PARTIAL' });
    f.params.wasSteer = true;
    f.params.wasKilled = true;
    delete f.ctx.traceRunId;
    await capture(() => handleAgentExit(f.params));
    assert.deepEqual(f.rows().map(row => row.trace_run_id), [null]);
    assert.equal(f.rows()[0]?.content, '⏹️ [interrupted]\n\nNO-RUN-PARTIAL');
});

test('when a steered run also has a final answer, only the final row owns the run', async () => {
    const f = fixture({ status: 'done', finalText: 'FINAL', partialText: 'PART' });
    f.params.wasSteer = true;
    f.params.wasKilled = true;
    await capture(() => handleAgentExit(f.params));
    const owners = f.rows().filter(row => row.trace_run_id === f.ctx.traceRunId);
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.content.startsWith('⏹️ [interrupted]'), false);
    assert.equal(f.rows().find(row => row.content.startsWith('⏹️ [interrupted]'))?.trace_run_id, null);
});

test('native final survives failed trace link/finalization and a throwing observer', async () => {
    const f = fixture({ status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' });
    failTrace = true;
    f.params.onRuntimeEnd = end => { f.ends.push(end); throw new Error('observer'); };
    await assert.doesNotReject(handleAgentExit(f.params));
    assert.equal(traceFailures, 2);
    assert.equal(f.rows()[0]?.content, 'FINAL');
    assert.equal(f.rows()[0]?.trace_run_id, f.ctx.traceRunId);
    assert.equal(f.result()?.text, 'FINAL');
    assert.equal(f.ends.length, 1);
});

test('employee/internal results resolve canonically without a public final', async () => {
    for (const mainManaged of [true, false]) {
        const f = fixture({ status: 'done', finalText: ' \n ', partialText: 'PARTIAL' });
        f.params.mainManaged = mainManaged;
        f.params.opts.internal = true;
        const events = await capture(() => handleAgentExit(f.params));
        assert.equal(events.filter(event => event.type === 'agent_done').length, 0);
        assert.equal(f.result()?.text, '');
        assert.equal(f.result()?.runtimeOutcome?.finalText, ' \n ');
        assert.deepEqual(f.rows(), []);
        assert.equal(f.ends[0]?.finalText, ' \n ');
    }
});

for (const cli of ['codex-app', 'pi']) {
    test(cli + ' without outcome retains legacy final and interrupted salvage behavior', async () => {
        const f = fixture();
        f.params.cli = cli;
        f.params.costLine = '';
        f.params.wasSteer = true;
        f.params.wasKilled = true;
        f.params.code = 1;
        f.ctx.fullText = 'LEGACY PARTIAL';
        delete f.ctx.liveOutputText;
        const watermark = getMaxMessageId(f.sessionId);
        const events = await capture(() => handleAgentExit(f.params));
        assert.equal(f.result()?.runtimeOutcome, undefined);
        assert.equal(Object.hasOwn(f.result()!, 'traceRunId'), false, 'legacy result shape is unchanged');
        assert.equal(f.result()?.text, 'LEGACY PARTIAL');
        assert.equal(getSteerSalvageAfter(f.sessionId, watermark), '⏹️ [interrupted]\n\nLEGACY PARTIAL');
        const done = events.find(event => event.type === 'agent_done');
        assert.equal(Object.hasOwn(done!.data, 'runtimeFinality'), false);
        assert.equal(Object.hasOwn(done!.data, 'runtimeStatus'), false);
        assert.equal(f.ends[0]?.finalText, done?.data['text']);
    });
}

const markerEvents = new Set(['goal_done', 'goal_done_rejected', 'goal_cancel_requested', 'goal_pause_detected']);
const continuationEvents = new Set(['agent_smoke', 'schedule_wakeup', 'goal_continuation', 'agent_retry', 'agent_fallback']);
function activeGoalFixture() {
    resetGoalStore(); clearGoalTimers(); resetFlushCountersForTest();
    setGoal('isolated lifecycle fixture');
    updateGoal('fixture evidence', '', ['unit fixture']);
}

for (const marker of ['done', 'cancel', 'pause']) {
    test('partial /goal ' + marker + ' cannot control a native run', async () => {
        for (const outcome of [
            { status: 'done', finalText: null }, { status: 'done', finalText: '' },
            { status: 'done', finalText: 'SAFE FINAL' }, { status: 'error', finalText: '/goal ' + marker },
            { status: 'stopped', finalText: '/goal ' + marker },
        ] as const) {
            activeGoalFixture();
            const f = fixture({ ...outcome, partialText: '/goal ' + marker });
            f.ctx.fullText = '/goal ' + marker;
            const events = await capture(() => handleAgentExit(f.params));
            assert.equal(getActiveGoal()?.status, 'active');
            assert.deepEqual(events.filter(event => markerEvents.has(event.type)), []);
            assert.equal(f.ctx.fullText, '/goal ' + marker);
            assert.equal(spawnCalls, 0);
        }
    });

    test('successful native final and legacy fullText still control /goal ' + marker, async () => {
        for (const native of [true, false]) {
            activeGoalFixture();
            const text = '/goal ' + marker;
            const f = fixture(native ? { status: 'done', finalText: text, partialText: 'PARTIAL' } : undefined);
            f.params.costLine = '';
            f.ctx.fullText = native ? 'NOT A CONTROL' : text;
            delete f.ctx.liveOutputText;
            const events = await capture(() => handleAgentExit(f.params));
            const expected = marker === 'done' ? 'goal_done' : marker === 'cancel' ? 'goal_cancel_requested' : 'goal_pause_detected';
            assert.deepEqual(events.filter(event => markerEvents.has(event.type)).map(event => event.type), [expected]);
            assert.equal(f.result()?.text, text);
        }
    });
}

test('native no-final done/error/stopped cannot smoke, schedule wakeup or auto-continue', async () => {
    for (const status of ['done', 'error', 'stopped'] as const) {
        for (const wakeup of [true, false]) {
            activeGoalFixture();
            const f = fixture({ status, finalText: null, partialText: '/goal done' });
            f.params.opts = { _skipSessionPersist: true };
            f.params.smokeResult = { isSmoke: true, confidence: 'high', matchedPattern: 'fixture', reason: 'fixture' };
            f.ctx.fullText = '/goal done';
            if (wakeup) f.ctx.scheduleWakeup = { delaySeconds: 60, prompt: 'SHOULD NOT RUN', reason: 'fixture' };
            const events = await capture(() => handleAgentExit(f.params));
            assert.deepEqual(events.filter(event => markerEvents.has(event.type) || continuationEvents.has(event.type)), []);
            assert.equal(spawnCalls, 0);
            assert.equal(f.result()?.text, '');
            assert.equal(f.ctx.fullText, '/goal done');
        }
    }
});

test('legacy smoke and successful native wakeup admission remain reachable', async () => {
    const legacy = fixture();
    legacy.params.opts = { _skipSessionPersist: true };
    legacy.params.smokeResult = { isSmoke: true, confidence: 'high', matchedPattern: 'fixture', reason: 'fixture' };
    await handleAgentExit(legacy.params);
    assert.equal(spawnCalls, 1);
    assert.equal(legacy.result()?.text, 'CONTINUATION-STUB');
    activeGoalFixture();
    const native = fixture({ status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' });
    native.ctx.scheduleWakeup = { delaySeconds: 60, prompt: 'LATER', reason: 'fixture' };
    const events = await capture(() => handleAgentExit(native.params));
    assert.equal(events.filter(event => event.type === 'schedule_wakeup').length, 1);
    assert.equal(spawnCalls, 1, 'the scheduled fixture is cleared without firing');
});

for (const scenario of [
    { name: 'owned kill with null exit', code: null, killed: true, steer: false, stall: undefined, native: false, interrupted: true, failed: false },
    { name: 'owned steer with code one', code: 1, killed: true, steer: true, stall: undefined, native: false, interrupted: true, failed: false },
    { name: 'stall beats owned kill', code: 0, killed: true, steer: false, stall: 'watchdog timeout', native: false, interrupted: false, failed: true },
    { name: 'classified legacy error', code: 2, killed: false, steer: false, stall: undefined, native: false, interrupted: false, failed: true },
    { name: 'legacy code zero', code: 0, killed: false, steer: false, stall: undefined, native: false, interrupted: false, failed: false },
    { name: 'native physical failure', code: 2, killed: false, steer: false, stall: undefined, native: true, interrupted: false, failed: false },
    { name: 'native owned interruption', code: null, killed: true, steer: true, stall: undefined, native: true, interrupted: false, failed: false },
]) {
    test(`real lifecycle legacy provenance: ${scenario.name}`, async () => {
        const f = fixture(scenario.native ? { status: 'done', finalText: 'FINAL', partialText: 'PARTIAL' } : undefined);
        f.params.code = scenario.code;
        f.params.wasKilled = scenario.killed;
        f.params.wasSteer = scenario.steer;
        f.params.mainManaged = false;
        f.params.opts.internal = true;
        f.params.opts._isFallback = true;
        f.ctx.stallReason = scenario.stall;
        await handleAgentExit(f.params);
        const result = f.result();
        assert.ok(result);
        assert.equal(result.executionInterrupted, scenario.interrupted ? true : undefined);
        assert.equal(result.executionFailed, scenario.failed ? true : undefined);
        assert.equal(result.text, scenario.native ? 'FINAL' : 'PROVISIONAL-FULL');
        if (!scenario.native) assert.equal(result.code, scenario.code ?? 0);
        else assert.equal(result.runtimeOutcome?.status, scenario.killed ? 'stopped' : 'done');
        assert.equal(spawnCalls, 0);
    });
}


for (const mode of ['print-active', 'native-reserved', 'worker'] as const) test(`Slack grant lifecycle cleanup: ${mode}`, async t => {
    t.after(() => revokeSlackToolScope());
    const f = fixture(mode === 'native-reserved' ? { status: 'done', finalText: 'FINAL', partialText: '' } : undefined);
    const requestId = f.ctx.requestId!;
    const source = { teamId: 'T1', actorId: 'U1', credentialKey: slackCredentialKey('fixture-lifecycle-token'),
        destination: { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'channel' as const, targetId: 'C1' } };
    assert.equal(reserveSlackToolGrant(source, { requestId, scope: f.scopeKey, chatSessionId: f.sessionId }), true);
    const secret = mode === 'native-reserved' ? undefined : activateSlackToolGrant(requestId, f.scopeKey, f.sessionId);
    const grant = secret ? resolveSlackToolGrant(secret) : null;
    if (mode !== 'native-reserved') assert.ok(grant);
    if (mode === 'worker') f.params.mainManaged = false;
    // The unrelated queued request must retain its reservation.
    assert.equal(reserveSlackToolGrant(source, { requestId: requestId + '-next', scope: f.scopeKey, chatSessionId: f.sessionId }), true);
    const resolve = f.params.resolve;
    f.params.resolve = value => {
        if (mode === 'print-active') assert.equal(grant!.signal.aborted, true, 'process authority ends before outer request settlement');
        resolve(value);
    };
    await handleAgentExit(f.params);
    if (mode === 'worker') { assert.equal(grant!.signal.aborted, false); assert.ok(resolveSlackToolGrant(secret!)); }
    else if (secret) assert.equal(resolveSlackToolGrant(secret), null);
    else assert.equal(typeof activateSlackToolGrant(requestId, f.scopeKey, f.sessionId), 'undefined');
    assert.ok(activateSlackToolGrant(requestId + '-next', f.scopeKey, f.sessionId));
});
