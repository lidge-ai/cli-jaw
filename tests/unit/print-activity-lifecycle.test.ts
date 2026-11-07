import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.js';
import { settings } from '../../src/core/config.js';
import { startTraceRun, getTraceRun } from '../../src/trace/store.js';
import { readActivityPage } from '../../src/trace/activity-journal.js';
import { createPrintActivity } from '../../src/agent/runtime/print-activity.js';
import { extractFromEvent } from '../../src/agent/events/index.js';
import { handleAgentExit, clearGoalTimers, setSpawnAgent, type ExitHandlerParams } from '../../src/agent/lifecycle-handler.js';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.js';
import { subscribe, type BusEvent } from '../../src/core/event-bus.js';
import { createSlackForwarder } from '../../src/slack/forwarder.js';
import { resetGoalStore } from '../../src/goal/store.js';
import { beginLiveRun, appendLiveRunTool, clearLiveRun } from '../../src/agent/live-run-state.js';
import type { SpawnContext } from '../../src/types/agent.js';

let serial = 0;
test.beforeEach(() => {
    resetGoalStore(); clearGoalTimers();
    settings.memory.enabled = false; settings.fallbackOrder = [];
});
test.afterEach(() => { clearGoalTimers(); resetGoalStore(); });

function fixture() {
    const n = ++serial;
    const sessionId = `print-chat-${n}`, scope = `print-scope-${n}`;
    db.prepare('INSERT INTO chat_sessions(id,seq,label) VALUES(?,?,?)').run(sessionId, 8000 + n, 'print fixture');
    const runId = startTraceRun({ cli: 'codex', sessionId, scopeKey: scope });
    const ctx: SpawnContext = { fullText: '', toolLog: [], traceLog: [], stderrBuf: '', seenToolKeys: new Set(),
        hasClaudeStreamEvents: false, sessionId: 'provider-private', cost: null, turns: null, duration: null, tokens: null,
        traceRunId: runId, traceAudience: 'public', liveScope: scope, activityIdentity: { sessionId, scope } };
    ctx.printActivity = createPrintActivity({ runId, sessionId, scope, turnId: runId, audience: 'public' }, 'codex');
    let result: Parameters<ExitHandlerParams['resolve']>[0] | undefined;
    let resolves = 0, ends = 0, respawns = 0;
    setSpawnAgent(() => { respawns++; return { promise: Promise.resolve({ text: 'unexpected retry', code: 0 }) }; });
    const params: ExitHandlerParams = {
        ctx, code: 0, cli: 'codex', model: 'fixture', resumeKey: null, agentLabel: 'fixture', mainManaged: true,
        origin: 'web', prompt: 'fixture', opts: { _skipSessionPersist: true, _isSmokeContinuation: true, target: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C-fixture' } }, cfg: {},
        ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null,
        isResume: false, wasKilled: false, wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: '', costLine: '', resolve: value => { resolves++; result = value; },
        activeProcesses: new Map(), scopeKey: scope, chatSessionId: sessionId, childProcess: null,
        releaseMainRun: () => false, retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
        fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
        onRuntimeEnd: end => { ends++; ctx.printActivity?.finish(end); },
    };
    return { ctx, params, runId, sessionId, scope,
        result: () => result, calls: () => ({ resolves, ends, respawns }),
        rows: () => db.prepare("SELECT content,trace_run_id FROM messages WHERE session_id=? AND role='assistant'").all(sessionId) as { content: string; trace_run_id: string }[] };
}

for (const fault of ['none', 'append', 'terminal', 'link', 'finalize', 'preview'] as const) {
    test(`accepted print parser → real lifecycle → journal; ${fault} failure never changes one final send`, async t => {
        let sends = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            sends++;
            return new Response(JSON.stringify({ ok: true, ts: 'fixture-ts' }), { headers: { 'content-type': 'application/json' } });
        });
        t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
        const events: BusEvent[] = [], legacy: Array<{ type: string; data: Record<string, unknown> }> = [];
        const pending: Promise<void>[] = [];
        const forward = createSlackForwarder({ getToken: () => 'fixture-token' });
        const listener = (type: string, data: Record<string, unknown>) => { legacy.push({ type, data }); pending.push(forward(type, data)); };
        addBroadcastListener(listener); const unsubscribe = subscribe(e => events.push(e));
        const f = fixture();
        let trigger = false;
        try {
            if (fault === 'append' || fault === 'terminal') {
                db.exec(`CREATE TRIGGER print_fault BEFORE INSERT ON trace_events
                    WHEN new.source='runtime' ${fault === 'terminal' ? "AND new.event_type='turn-end'" : ''}
                    BEGIN SELECT RAISE(ABORT,'print fixture fault'); END`);
                trigger = true;
            } else if (fault === 'link' || fault === 'finalize') {
                db.exec(`CREATE TRIGGER print_fault BEFORE UPDATE OF ${fault === 'link' ? 'message_id' : 'status'} ON trace_runs
                    BEGIN SELECT RAISE(ABORT,'print fixture fault'); END`);
                trigger = true;
            }
            extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: fault === 'preview' ? 'p'.repeat(4000) : 'prelude', channel: 'commentary' } }, f.ctx, 'fixture');
            extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'selected answer' } }, f.ctx, 'fixture');
            await assert.doesNotReject(handleAgentExit(f.params));
            await Promise.all(pending);
            assert.deepEqual(f.calls(), { resolves: 1, ends: 1, respawns: 0 });
            assert.equal(f.result()?.runtimeOutcome, undefined, 'print never invents native outcome');
            assert.deepEqual(f.rows(), [{ content: 'selected answer', trace_run_id: f.runId }]);
            const final = legacy.filter(e => e.type === 'agent_done');
            assert.equal(final.length, 1); assert.equal(final[0]?.data['text'], 'selected answer');
            assert.equal(sends, 1, 'real forwarder called only the stubbed HTTP boundary once');
            assert.equal(legacy.some(e => e.type === 'agent_runtime' || e.type === 'agent_runtime_gap'), false);
            const p = readActivityPage({ runId: f.runId, sessionId: f.sessionId, after: 0, limit: 40 })!;
            if (fault === 'append' || fault === 'terminal') {
                assert.equal(p.incomplete, true); assert.equal(p.events.some(e => e.kind === 'turn-end'), false);
                assert.equal(events.filter(e => e.event === 'agent_runtime_gap' && e.data['runId'] === f.runId).length, 1);
            } else {
                const end = p.events.at(-1); assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, 'selected answer');
                assert.ok(p.events.some(e => e.kind === 'message' && e.phase === 'commentary' && e.text === (fault === 'preview' ? 'p'.repeat(3000) : 'prelude')));
                if (fault === 'preview') {
                    assert.ok(p.events.some(e => e.kind === 'message' && e.text === 'selected answer'));
                    assert.equal(p.events.filter(e => e.kind === 'turn-end').length, 1);
                    assert.equal(p.loss, 'projection_degraded'); assert.equal(p.incomplete, true);
                    assert.equal(events.filter(e => e.event === 'agent_runtime_gap' && e.data['runId'] === f.runId).length, 1);
                }
                const compat = events.findIndex(e => e.event === 'agent_done');
                const canonical = events.findIndex(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-end');
                assert.ok(compat >= 0 && canonical > compat, 'existing compatibility-first ordering preserved');
            }
            if (fault === 'link') assert.equal(getTraceRun(f.runId)?.message_id, null);
            else assert.ok(getTraceRun(f.runId)?.message_id);
        } finally {
            if (trigger) db.exec('DROP TRIGGER print_fault');
            unsubscribe(); removeBroadcastListener(listener);
        }
    });
}

test('print tool-only completion links its authoritative empty MESSAGE to journal discovery', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
    const f = fixture();
    extractFromEvent('codex', { type: 'item.completed', item: { id: 'tool-only', type: 'command_execution',
        command: 'echo fixture', status: 'completed', exit_code: 0, aggregated_output: '' } }, f.ctx, 'fixture');
    assert.ok(f.ctx.toolLog.length > 0);
    await handleAgentExit(f.params);
    assert.deepEqual(f.rows(), [{ content: '', trace_run_id: f.runId }]);
    assert.ok(getTraceRun(f.runId)?.message_id);
    const p = readActivityPage({ runId: f.runId, sessionId: f.sessionId, after: 0, limit: 40 })!;
    const end = p.events.at(-1); assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, '');
    assert.equal(p.incomplete, false); assert.deepEqual(f.calls(), { resolves: 1, ends: 1, respawns: 0 });
});

test('real lifecycle persists and broadcasts the same bounded boss/worker tool union', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
    const f = fixture(); f.ctx.fullText = 'final';
    f.ctx.toolLog = Array.from({ length: 200 }, (_, i) => ({ icon: 'x', label: `boss-${i}`, toolType: 'tool',
        stepRef: `boss-${i}`, traceRunId: f.runId, detail: 'x'.repeat(2000), status: 'done' }));
    beginLiveRun(f.scope, 'codex');
    appendLiveRunTool(f.scope, { icon: 'x', label: 'worker mirror', toolType: 'tool', stepRef: 'worker',
        traceRunId: 'tr_worker1234567890', isEmployee: true, detail: 'worker detail' });
    let broadcastTools: unknown;
    const listener = (type: string, data: Record<string, unknown>) => { if (type === 'agent_done') broadcastTools = data['toolLog']; };
    addBroadcastListener(listener);
    try {
        await handleAgentExit(f.params);
        const row = db.prepare("SELECT tool_log FROM messages WHERE trace_run_id=? AND role='assistant'").get(f.runId) as { tool_log: string };
        const stored = JSON.parse(row.tool_log) as Array<{ stepRef?: string; label: string }>;
        assert.equal(stored.length, 160); assert.equal(stored.filter(tool => tool.stepRef).length, 159);
        assert.ok(stored.some(tool => tool.label === 'worker mirror'));
        assert.ok(stored.some(tool => tool.label.startsWith('boss-')));
        assert.ok(row.tool_log.length <= 64_000);
        assert.deepEqual(broadcastTools, stored);
    } finally { removeBroadcastListener(listener); clearLiveRun(f.scope); }
});
