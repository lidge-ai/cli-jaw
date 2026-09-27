import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeItem, CodeSessionInfo, CodeSnapshot, CodeWireEvent } from '../../src/code-mode/wire.ts';
import { emptyCodeSession, reduceCodeSession } from '../../public/manager/src/code/code-session-state.ts';

const session: CodeSessionInfo = {
    sessionId: 's', provider: 'codex-app', cwd: '/workspace', title: null, model: 'native', effort: null,
    permissionMode: 'ask', status: 'streaming', turnId: 't', epoch: 1, sequence: 3, revision: 1,
    archivedAt: null, error: null, resume: { available: true, reason: null },
    capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: true, efforts: [], permissionModes: ['ask', 'auto'] },
    createdAt: 1, lastUsedAt: 2, lastTurnCompletedAt: null, lastVisitedAt: null,
    pinnedAt: null, markedUnread: false,
};
const item = (id = 'answer', text = 'A', firstSequence = 3): CodeItem => ({ itemId: id, firstSequence,
    turnId: 't', kind: 'assistant_message', status: 'running', text, phase: 'commentary', createdAt: 1, updatedAt: 1 });
const snapshot = (items = [item()], sequence = 3): CodeSnapshot => ({ session: { ...session, sequence }, items, sequence, pendingPermissions: [], truncated: false });
const update = (sequence: number, text = 'B'): CodeWireEvent => ({ topic: 'code', event: 'code_item_update', sessionId: 's', sequence, epoch: 1,
    update: { itemId: 'answer', turnId: 't', firstSequence: 3, updatedAt: sequence, appendText: text } });
const seeded = () => reduceCodeSession(emptyCodeSession('s'), { type: 'snapshot', snapshot: snapshot() });

test('out-of-order duplicate compact updates cannot double append or advance over a hole', () => {
    let state = seeded();
    state = reduceCodeSession(state, { type: 'event', event: update(5, 'C') });
    assert.equal(state.cursor, 3);
    assert.equal(state.synced, false);
    state = reduceCodeSession(state, { type: 'event', event: update(5, 'C') });
    state = reduceCodeSession(state, { type: 'event', event: update(4) });
    state = reduceCodeSession(state, { type: 'event', event: update(4) });
    assert.equal(state.cursor, 5);
    assert.equal(state.items[0]!.text, 'ABC');
    assert.equal(state.items[0]!.firstSequence, 3);
    state = reduceCodeSession(state, { type: 'page', page: { events: [update(4), update(5, 'C')], nextSequence: 5, throughSequence: 5, hasMore: false } });
    assert.equal(state.items[0]!.text, 'ABC');
    assert.equal(state.synced, true);
});

test('snapshot H plus buffered catch-up excludes covered deltas and preserves an exact empty final', () => {
    let state = reduceCodeSession(seeded(), { type: 'snapshot-start' });
    for (const sequence of [4, 5, 6]) state = reduceCodeSession(state, { type: 'event', event: update(sequence) });
    assert.equal(state.cursor, 3);
    state = reduceCodeSession(state, { type: 'snapshot', snapshot: snapshot([item('answer', 'ABB')], 5) });
    assert.equal(state.items[0]!.text, 'ABBB');
    assert.equal(state.cursor, 6);
    const final: CodeWireEvent = { topic: 'code', event: 'code_item', sessionId: 's', sequence: 7, epoch: 1,
        item: { ...item('answer', '', 7), status: 'done', phase: 'final' } };
    state = reduceCodeSession(state, { type: 'event', event: final });
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]!.text, '');
    assert.equal(state.items[0]!.phase, 'final');
    assert.equal(state.items[0]!.firstSequence, 3);
});

test('missing compact update base requests snapshot instead of fabricating a partial item', () => {
    let state = reduceCodeSession(emptyCodeSession('s'), { type: 'snapshot', snapshot: snapshot([]) });
    state = reduceCodeSession(state, { type: 'event', event: update(4) });
    assert.equal(state.needsSnapshot, true);
    assert.equal(state.cursor, 3);
    assert.deepEqual(state.items, []);
    state = reduceCodeSession(state, { type: 'snapshot', snapshot: snapshot([item('answer', 'AB')], 4) });
    assert.equal(state.synced, true);
    assert.equal(state.items[0]!.text, 'AB');
});

test('older materialized rows never replace newer values or advance the replay cursor', () => {
    let state = seeded();
    state = reduceCodeSession(state, { type: 'history', page: { items: [item('old', 'past', 1), item('answer', 'stale', 3)], beforeSequence: 1, hasMore: false, sequence: 900 } });
    assert.deepEqual(state.items.map(row => [row.itemId, row.text]), [['old', 'past'], ['answer', 'A']]);
    assert.equal(state.cursor, 3);
    assert.equal(state.beforeSequence, 1);
    state = reduceCodeSession(state, { type: 'event', event: update(4) });
    assert.equal(state.items[1]!.text, 'AB');
});

test('pending snapshot controls can outlive their visible row; session ownership retires them', () => {
    const permission = { permissionId: 'p', sessionId: 's', turnId: 't', epoch: 1, title: 'Write file', detail: '/workspace/file',
        requestedAt: 1, options: [{ optionId: 'opaque', label: 'Allow once', kind: 'approval' }] };
    let state = reduceCodeSession(emptyCodeSession('s'), { type: 'snapshot', snapshot: { ...snapshot([]), pendingPermissions: [permission] } });
    assert.equal(state.permissions.length, 1);
    state = reduceCodeSession(state, { type: 'event', event: { topic: 'code', event: 'code_session', sessionId: 's', sequence: 4, epoch: 2,
        session: { ...session, epoch: 2, sequence: 4, status: 'idle', turnId: null } } });
    assert.deepEqual(state.permissions, []);
});

test('full tool items retain stable order; compact output/status appends exactly once', () => {
    const tool: CodeItem = { ...item('tool', '', 2), kind: 'tool_call', tool: { name: 'shell', input: 'pwd', output: 'first' } };
    let state = reduceCodeSession(emptyCodeSession('s'), { type: 'snapshot', snapshot: snapshot([tool, item()]) });
    const event: CodeWireEvent = { topic: 'code', event: 'code_item_update', sessionId: 's', sequence: 4, epoch: 1,
        update: { itemId: 'tool', turnId: 't', firstSequence: 2, updatedAt: 4, appendToolOutput: '\nsecond', status: 'done' } };
    state = reduceCodeSession(state, { type: 'event', event });
    state = reduceCodeSession(state, { type: 'event', event });
    assert.deepEqual(state.items.map(row => row.itemId), ['tool', 'answer']);
    assert.equal(state.items[0]!.tool!.output, 'first\nsecond');
    assert.equal(state.items[0]!.status, 'done');
});

test('page watermark is not a cursor and foreign sessions never enter the projection', () => {
    let state = seeded();
    state = reduceCodeSession(state, { type: 'page', page: { events: [update(5)], nextSequence: 5, throughSequence: 8, hasMore: false } });
    assert.equal(state.cursor, 3);
    assert.equal(state.synced, false);
    const before = state;
    state = reduceCodeSession(state, { type: 'event', event: { ...update(4), sessionId: 'foreign' } });
    assert.equal(state, before);
});

test('overflow bounds buffered data and requires authoritative recovery', () => {
    let state = emptyCodeSession('s');
    for (let sequence = 1; sequence <= 600; sequence++) state = reduceCodeSession(state, { type: 'event', event: update(sequence) });
    assert.equal(state.needsSnapshot, true);
    assert.equal(state.synced, false);
    assert.ok(state.buffered.length <= 512);
    assert.equal(state.cursor, 0);
    assert.ok(state.error);
});

test('a session event does not blank context usage it was never able to carry', () => {
    // Usage is attached at read time, so it travels on snapshots and listings
    // and never on a stored session event. Replacing the record wholesale would
    // clear the meter on every unrelated status change.
    const usage = { totalTokens: 345, inputTokens: 300, cachedInputTokens: 100,
        outputTokens: 40, reasoningOutputTokens: 5, modelContextWindow: 272000, updatedAt: 7 };
    let state = reduceCodeSession(emptyCodeSession('s'), { type: 'snapshot',
        snapshot: { ...snapshot(), session: { ...session, contextUsage: usage } } });
    assert.equal(state.session?.contextUsage?.totalTokens, 345);
    state = reduceCodeSession(state, { type: 'event', event: { topic: 'code', event: 'code_session',
        sessionId: 's', sequence: 4, epoch: 1, session: { ...session, sequence: 4, status: 'idle' } } });
    assert.equal(state.session?.status, 'idle', 'the event still applies');
    assert.equal(state.session?.contextUsage?.totalTokens, 345, 'the last known figure stands');
    // A newer read replaces it outright, including a read that reports none --
    // a runtime that has exited has nothing to say about its context.
    state = reduceCodeSession(state, { type: 'snapshot', snapshot: snapshot([item()], 5) });
    assert.equal(state.session?.contextUsage, undefined);
});

test('a session event with a higher history generation discards held items through a new snapshot', () => {
    let state = seeded();
    const rolled: CodeWireEvent = { topic: 'code', event: 'code_session', sessionId: 's', sequence: 4, epoch: 2,
        session: { ...session, status: 'idle', turnId: null, epoch: 2, sequence: 4, historyGeneration: 1 } };
    state = reduceCodeSession(state, { type: 'event', event: rolled });
    assert.deepEqual({ needsSnapshot: state.needsSnapshot, synced: state.synced, cursor: state.cursor }, { needsSnapshot: true, synced: false, cursor: 3 });
    assert.equal(state.items.length, 1, 'nothing is applied from a stale history');
    state = reduceCodeSession(state, { type: 'snapshot', snapshot: { ...snapshot([], 4), session: rolled.session! } });
    assert.deepEqual({ needsSnapshot: state.needsSnapshot, synced: state.synced, items: state.items.length }, { needsSnapshot: false, synced: true, items: 0 });
    const same: CodeWireEvent = { ...rolled, sequence: 5, session: { ...rolled.session!, sequence: 5 } };
    assert.equal(reduceCodeSession(state, { type: 'event', event: same }).needsSnapshot, false, 'an equal generation applies normally');
    const older = reduceCodeSession(seeded(), { type: 'event', event: { ...rolled, session: { ...rolled.session!, historyGeneration: undefined as never } } });
    assert.equal(older.needsSnapshot, false, 'an older server without the field is generation 0');
});
