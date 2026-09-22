import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintActivityProjection } from '../../src/agent/runtime/print-projection.js';
import { createPrintActivity, finishPrintActivity } from '../../src/agent/runtime/print-activity.js';
import { startTraceRun, finalizeTraceRun, getTraceRun } from '../../src/trace/store.js';
import { db } from '../../src/core/db.js';
import { readActivityPage } from '../../src/trace/activity-journal.js';
import { subscribe, type BusEvent } from '../../src/core/event-bus.js';
import { settings } from '../../src/core/config.js';
import { emitAgentTool } from '../../src/agent/events/helpers.js';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.js';
import { extractFromEvent } from '../../src/agent/events.js';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.js';
import type { SpawnContext } from '../../src/types/agent.js';

test('pure observer keeps message boundaries, operations, unknown phase and stable tool references', () => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.message('A', 'append'); observer.message('B', 'append'); observer.nextMessage();
    observer.message('commentary', 'replace', 'commentary');
    observer.reasoning('think', 'append'); observer.reasoning(' more', 'append');
    observer.tool({ icon: 'x', label: 'cmd', toolType: 'tool', stepRef: 'stable', status: 'running' });
    observer.tool({ icon: 'x', label: 'cmd', toolType: 'tool', stepRef: 'stable', status: 'done', detail: '' });
    assert.equal(seen[0]?.kind, 'message');
    assert.equal(seen[0]?.kind === 'message' && seen[0].phase, 'unknown');
    assert.equal(seen[0]?.kind === 'message' && seen[0].itemId, seen[1]?.kind === 'message' && seen[1].itemId);
    assert.notEqual(seen[0]?.kind === 'message' && seen[0].itemId, seen[2]?.kind === 'message' && seen[2].itemId);
    assert.equal(seen[3]?.kind === 'reasoning' && seen[3].itemId, seen[4]?.kind === 'reasoning' && seen[4].itemId);
    assert.equal(seen[5]?.kind === 'tool' && seen[5].itemId, seen[6]?.kind === 'tool' && seen[6].itemId);
    assert.equal(seen[6]?.kind === 'tool' && seen[6].detail, '');
});

test('anonymous tools stay distinct; narration and thinking never become real tools', () => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.tool({ icon: '💬', label: 'narration', toolType: 'thinking' });
    observer.tool({ icon: '💭', label: 'thought', toolType: 'thinking' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool', traceSeq: 2 });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool', stepRef: 'trace:2' });
    assert.deepEqual(seen.map(e => e.kind), ['message', 'reasoning', 'tool', 'tool', 'tool', 'tool']);
    assert.equal(new Set(seen.filter(e => e.kind === 'tool').map(e => e.itemId)).size, 4);
});

test('pure observer finishes exactly once and contains a throwing sink', t => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.finish({ kind: 'turn-end', status: 'done', finalText: '' });
    observer.finish({ kind: 'turn-end', status: 'done', finalText: 'late' });
    observer.message('late', 'append');
    assert.deepEqual(seen, [{ kind: 'turn-end', status: 'done', finalText: '' }]);
    t.mock.method(console, 'warn', () => {});
    let calls = 0;
    const failed = createPrintActivityProjection(() => { calls++; throw new Error('fixture'); });
    assert.doesNotThrow(() => { failed.message('A', 'append'); failed.message('B', 'append'); failed.finish({ kind: 'turn-end', status: 'error', finalText: null }); });
    assert.equal(calls, 1);
});

test('factory uses actual journal and preserves selected null/empty/whitespace application finals', () => {
    for (const finalText of [null, '', ' \n', 'selected final']) {
        const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
        const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
        observer.message('unfinished narration', 'append');
        observer.finish({ kind: 'turn-end', status: 'done', finalText }); finalizeTraceRun(runId, 'done');
        const p = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!;
        const end = p.events.at(-1);
        assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, finalText); assert.equal(p.incomplete, false);
        assert.equal(p.events.filter(e => e.kind === 'turn-start').length, 1);
    }
});

test('preview capacity fails visibly through one gap, with no fabricated terminal', () => {
    const seen: BusEvent[] = []; const unsubscribe = subscribe(e => seen.push(e));
    const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
    try {
        const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
        observer.message('x'.repeat(4000), 'append'); observer.message('late', 'append');
        observer.finish({ kind: 'turn-end', status: 'done', finalText: 'still selected by lifecycle' });
        const p = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(p.incomplete, true); assert.equal(p.loss, 'run_limit');
        assert.equal(p.events.some(e => e.kind === 'turn-end'), false);
        assert.equal(seen.filter(e => e.event === 'agent_runtime_gap').length, 1);
    } finally { unsubscribe(); }
});

test('bypass observer failure and trace failure are independently contained', t => {
    t.mock.method(console, 'warn', () => {});
    const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
    const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
    let calls = 0;
    assert.doesNotThrow(() => finishPrintActivity({ traceRunId: runId, printActivity: { ...observer,
        finish: () => { calls++; throw new Error('fixture observer'); },
    } }, { kind: 'turn-end', status: 'error', finalText: null }));
    assert.equal(calls, 1); assert.equal(getTraceRun(runId)?.status, 'error', 'trace still finalized after observer throw');
    db.exec("CREATE TRIGGER bypass_trace_failure BEFORE UPDATE OF status ON trace_runs BEGIN SELECT RAISE(ABORT,'fixture'); END");
    try {
        assert.doesNotThrow(() => finishPrintActivity({ traceRunId: runId, printActivity: { ...observer,
            finish: () => { calls++; },
        } }, { kind: 'turn-end', status: 'error', finalText: null }));
        assert.equal(calls, 2, 'observer still called exactly once before trace failure');
    } finally { db.exec('DROP TRIGGER bypass_trace_failure'); }
});

test('factory preserves a newer terminal tool detail on the same canonical item', () => {
    const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
    const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
    const tool = { icon: 'x', label: 'command', toolType: 'tool', stepRef: 'stable' };
    observer.tool({ ...tool, status: 'running', detail: 'start' });
    observer.tool({ ...tool, status: 'done', detail: 'first result' });
    observer.tool({ ...tool, status: 'done', detail: 'updated result' });
    observer.tool({ ...tool, status: 'running', detail: 'stale start' });
    const tools = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!.events.filter(e => e.kind === 'tool');
    assert.equal(tools.length, 3);
    assert.equal(new Set(tools.map(e => e.itemId)).size, 1);
    assert.equal(tools.at(-1)?.status, 'done'); assert.equal(tools.at(-1)?.detail, 'updated result');
});

test('print opt-in follows explicit terminal status updates without inferring recovery from a running update', () => {
    const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
    const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
    const tool = { icon: 'x', label: 'command', toolType: 'tool', stepRef: 'severity' };
    observer.tool({ ...tool, status: 'error', detail: 'failed' });
    observer.tool({ ...tool, status: 'running', detail: 'stale' });
    let tools = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!.events.filter(e => e.kind === 'tool');
    assert.equal(tools.length, 1); assert.equal(tools[0]?.status, 'error'); assert.equal(tools[0]?.detail, 'failed');
    // Legacy print providers explicitly revise completed snapshots. Native callers
    // retain their existing frozen error/result policy unless they opt in.
    observer.tool({ ...tool, status: 'done', detail: '' });
    tools = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!.events.filter(e => e.kind === 'tool');
    assert.equal(tools.length, 2); assert.equal(tools[1]?.status, 'done'); assert.equal(tools[1]?.detail, '');
    assert.equal(tools[0]?.itemId, tools[1]?.itemId);
});

test('completed Codex web searches stay terminal through extractor, print projection, and close', () => {
    const runId = startTraceRun({ cli: 'codex', sessionId: 'default', scopeKey: 'default' });
    const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'codex');
    const ctx = { ...context(), traceRunId: runId, traceAudience: 'public' as const, printActivity: observer };
    const events = [
        { type: 'item.completed', item: { id: 'search-1', type: 'web_search', action: { type: 'search', query: 'fixture query' } } },
        { type: 'item.completed', item: { id: 'page-1', type: 'web_search', action: { type: 'open_page', url: 'https://example.com/source' } } },
        { type: 'item.completed', item: { id: 'invalid-page-1', type: 'web_search', action: { type: 'open_page', url: 'not a URL' } } },
        { type: 'item.completed', item: { id: 'fallback-1', type: 'web_search', query: 'fallback query', action: { type: 'other' } } },
        { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'anonymous one' } } },
        { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'anonymous two' } } },
    ];
    for (const event of events) extractFromEvent('codex', event, ctx, 'fixture');
    assert.deepEqual(ctx.toolLog.map(tool => tool.stepRef), [
        'codex:item:search-1',
        'codex:item:page-1',
        'codex:item:invalid-page-1',
        'codex:item:fallback-1',
        undefined,
        undefined,
    ]);
    observer.finish({ kind: 'turn-end', status: 'done', finalText: '' });

    const eventsAfterClose = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!.events;
    const tools = eventsAfterClose.filter(event => event.kind === 'tool');
    const terminal = eventsAfterClose.filter(event => event.kind === 'turn-end');
    assert.equal(tools.length, 6);
    assert.deepEqual(tools.map(tool => tool.status), ['done', 'done', 'done', 'done', 'done', 'done']);
    assert.equal(tools.some(tool => tool.detail === 'No native terminal tool result received'), false);
    assert.equal(new Set(tools.map(tool => tool.itemId)).size, 6);
    assert.notEqual(tools[4]?.itemId, tools[5]?.itemId, 'ID-less completed searches remain distinct');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, 'done');
});

function context(): SpawnContext {
    return { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(), hasClaudeStreamEvents: false,
        sessionId: 'native-private', cost: null, turns: null, duration: null, tokens: null, stderrBuf: '',
        traceRunId: 'tr_captured1234567890', activityIdentity: { sessionId: 'jaw-captured', scope: 'captured-scope' } };
}

test('tool wire identity is captured after payload overrides even with multi-session disabled', () => {
    const before = settings.multiSession.enabled; settings.multiSession.enabled = false;
    const seen: BusEvent[] = []; const legacy: Record<string, unknown>[] = [];
    const unsubscribe = subscribe(e => seen.push(e));
    const listener = (_type: string, data: Record<string, unknown>) => legacy.push(data);
    addBroadcastListener(listener);
    try {
        const ctx = context();
        emitAgentTool(ctx, 'fixture', { icon: 'x', label: 'cmd', toolType: 'tool', traceRunId: 'spoof', sessionId: 'spoof', scope: 'spoof' },
            { sessionId: 'emp-spoof', scope: 'emp-spoof', traceRunId: 'emp-spoof' });
        assert.equal(seen[0]?.data['sessionId'], 'jaw-captured'); assert.equal(seen[0]?.data['scope'], 'captured-scope');
        assert.equal(seen[0]?.data['traceRunId'], ctx.traceRunId);
        assert.ok(!JSON.stringify(seen).includes('native-private'));
        ctx.traceAudience = 'internal'; emitAgentTool(ctx, undefined, { icon: 'x', label: 'cmd', toolType: 'tool' }, {});
        assert.equal(seen.length, 1, 'internal audience has no public SSE');
        assert.equal(legacy.length, 2, 'legacy internal listener contract remains');
    } finally { unsubscribe(); removeBroadcastListener(listener); settings.multiSession.enabled = before; }
});
