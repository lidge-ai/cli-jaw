import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
    CodeStore, CodeStoreError, toCodeSessionInfo,
    CODE_MAX_EVENT_BYTES, CODE_MAX_REPLAY_PAGE_BYTES, CODE_MAX_SNAPSHOT_BYTES, CODE_MAX_TURN_EVENT_BYTES,
    CODE_TERMINAL_RESERVE_BYTES, CREATE_CODE_SCHEMA_SQL,
    type CodeSessionCreate, type CodeSessionRecord, type CodeStoreOwner, type CodeStoreOptions,
} from '../../src/code-mode/store.js';
import type { CodeItem, CodeSessionInfo, CodeWireEvent } from '../../src/code-mode/wire.js';

const capabilities = {
    resume: true, interrupt: true, permissions: true, setModelMidSession: false,
    efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] as Array<'ask' | 'auto'>,
};
const creation: CodeSessionCreate = {
    sessionId: 'session-a', provider: 'claude', cwd: '/workspace/a', title: null,
    model: 'model-a', effort: 'high', permissionMode: 'ask', capabilities,
};
const dtoKeys = [
    'sessionId', 'provider', 'cwd', 'title', 'model', 'effort', 'permissionMode', 'status',
    'turnId', 'archivedAt', 'error', 'resume', 'capabilities', 'epoch', 'sequence', 'revision',
    'createdAt', 'lastUsedAt', 'lastTurnCompletedAt', 'lastVisitedAt', 'thinking', 'rollback', 'historyGeneration',
].sort();

function fixture(t: { after(fn: () => void): void }, options: CodeStoreOptions = {}) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    let id = 0;
    const store = new CodeStore(db, { now: () => 1234, newId: () => `turn-${++id}`, ...options });
    store.create(creation);
    return { db, store };
}

function admit(store: CodeStore, key = 'key-a', sessionId = 'session-a', text = 'hello') {
    return store.admitTurn({ sessionId, clientTurnKey: key, text });
}

function owner(session: CodeSessionInfo): CodeStoreOwner {
    return { sessionId: session.sessionId, turnId: session.turnId, epoch: session.epoch };
}

function message(turnId: string, itemId = 'answer', text = 'retained answer'): CodeItem {
    return { itemId, turnId, kind: 'assistant_message', status: 'running', text, createdAt: 1234, updatedAt: 1234 };
}

function expectError(fn: () => unknown, code: string, statusCode = 409) {
    assert.throws(fn, (error: unknown) => error instanceof CodeStoreError && error.code === code && error.statusCode === statusCode);
}

// Independent client reducer: expected content below comes from literal fixtures,
// not the store's compact-update detector or materialized-row mapper.
function replayItems(events: CodeWireEvent[]): CodeItem[] {
    const items = new Map<string, CodeItem>();
    for (const event of events) {
        if (event.event === 'code_item') {
            assert.ok(event.item);
            items.set(event.item.itemId, structuredClone(event.item));
        } else if (event.event === 'code_item_update') {
            assert.ok(event.update);
            const item = items.get(event.update.itemId);
            assert.ok(item, 'compact update requires its first item');
            assert.equal(event.update.firstSequence, item.firstSequence);
            if (event.update.appendText !== undefined) item.text = (item.text ?? '') + event.update.appendText;
            if (event.update.appendToolOutput !== undefined) {
                assert.ok(item.tool);
                item.tool.output = (item.tool.output ?? '') + event.update.appendToolOutput;
            }
            if (event.update.status !== undefined) item.status = event.update.status;
            if (event.update.phase !== undefined) item.phase = event.update.phase;
            item.updatedAt = event.update.updatedAt;
        }
    }
    return [...items.values()].sort((a, b) => a.firstSequence! - b.firstSequence!);
}

test('append text/output and status/phase updates reconstruct fixture content without repeating full items', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const item: CodeItem = { ...message(admitted.receipt.turnId), kind: 'tool_call', text: 'Hello ', phase: 'commentary',
        tool: { name: 'example', input: '{}', detail: 'detail', output: 'line one\n' } };
    const created = store.commitItem(current, item);
    const appended = store.commitItem(current, { ...item, text: 'Hello world', status: 'done', phase: 'final', updatedAt: 2000,
        tool: { ...item.tool!, output: 'line one\nline two\n' } });
    assert.equal(created.events[0]?.event, 'code_item');
    assert.deepEqual(appended.events[0]?.update, { itemId: 'answer', turnId: 'turn-1', firstSequence: 5, updatedAt: 2000,
        appendText: 'world', appendToolOutput: 'line two\n', status: 'done', phase: 'final' });
    assert.equal(appended.events[0]?.item, undefined);
    const expected: CodeItem = { itemId: 'answer', firstSequence: 5, turnId: 'turn-1', kind: 'tool_call', status: 'done',
        phase: 'final', text: 'Hello world', tool: { name: 'example', input: '{}', detail: 'detail', output: 'line one\nline two\n' },
        createdAt: 1234, updatedAt: 2000 };
    assert.deepEqual(replayItems(store.readEvents('session-a', 4).events), [expected]);
    assert.deepEqual(store.snapshot('session-a').items.at(-1), expected);
});

test('non-prefix replacement, phase removal and metadata changes retain full events', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const initial = { ...message(admitted.receipt.turnId, 'answer', 'prefix'), phase: 'commentary' as const };
    store.commitItem(current, initial);
    const replaced = store.commitItem(current, { ...initial, text: 'replacement' });
    assert.equal(replaced.events[0]?.event, 'code_item');
    const metadata = store.commitItem(current, { ...initial, text: 'replacement extended', parentItemId: 'new-parent' });
    assert.equal(metadata.events[0]?.event, 'code_item');
    const unknown = { ...initial, text: 'replacement extended again', parentItemId: 'new-parent', futureMetadata: 'private' };
    const changed = store.commitItem(current, unknown);
    assert.equal(changed.events[0]?.event, 'code_item');
    assert.doesNotMatch(JSON.stringify(changed), /futureMetadata|private/);
    const removedPhase = store.commitItem(current, { ...message(admitted.receipt.turnId, 'answer', 'replacement extended again'), parentItemId: 'new-parent' });
    assert.equal(removedPhase.events[0]?.event, 'code_item');
    assert.equal(removedPhase.events[0]?.item?.phase, undefined);
});

test('one million characters streamed in 100-character chunks stays bounded in SQLite', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const expected = '0123456789'.repeat(100_000);
    for (let end = 100; end <= expected.length; end += 100) {
        store.commitItem(current, message(admitted.receipt.turnId, 'answer', expected.slice(0, end)));
    }
    const stored = db.prepare(`SELECT SUM(length(CAST(event_json AS BLOB))) AS bytes,
        SUM(json_extract(event_json, '$.event') = 'code_item_update') AS updates FROM code_events`).get() as { bytes: number; updates: number };
    assert.equal(stored.updates, 9999);
    assert.ok(stored.bytes < 6 * 1024 * 1024, `event bytes: ${stored.bytes}`);
    const pages = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    assert.ok(pages * pageSize < 16 * 1024 * 1024, `SQLite bytes: ${pages * pageSize}`);
    const events: CodeWireEvent[] = [];
    let after = 0;
    do {
        const page = store.readEvents('session-a', after);
        events.push(...page.events);
        after = page.nextSequence;
        if (!page.hasMore) break;
    } while (true);
    assert.equal(replayItems(events).find(item => item.itemId === 'answer')?.text, expected);
    assert.equal(store.snapshot('session-a').items.at(-1)?.text, expected);
});

test('non-prefix replacement rolls back on turn byte budget exhaustion and failure still settles', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    store.commitItem(current, message(admitted.receipt.turnId, 'answer', 'a'.repeat(1800)));
    const usage = db.prepare('SELECT event_bytes FROM code_turns WHERE session_id = ? AND turn_id = ?')
        .get('session-a', admitted.receipt.turnId) as { event_bytes: number };
    const bounded = new CodeStore(db, { now: () => 2000, limits: { maxTurnEventBytes: usage.event_bytes + 200 } });
    const before = bounded.snapshot('session-a');
    expectError(() => bounded.commitItem(current, message(admitted.receipt.turnId, 'answer', 'b'.repeat(1800))), 'transcript_limit');
    assert.deepEqual(bounded.snapshot('session-a'), before);
    assert.deepEqual(bounded.readEvents('session-a', before.sequence).events, []);
    assert.deepEqual(db.prepare('SELECT event_bytes FROM code_turns WHERE session_id = ? AND turn_id = ?')
        .get('session-a', admitted.receipt.turnId), usage);
    bounded.setRuntimeState(current, 'stopping');
    const failed = bounded.settleTurn(current, { status: 'failed', error: { code: 'transcript_limit', message: 'Transcript limit reached', at: 2000, recoverable: true } });
    assert.equal(failed.receipt.status, 'failed');
    assert.equal(failed.session.error?.code, 'transcript_limit');
    assert.equal(bounded.snapshot('session-a').items.find(item => item.itemId === 'answer')?.text, 'a'.repeat(1800));
    const budget = db.prepare('SELECT event_bytes, control_event_bytes, settlement_bytes FROM code_turns WHERE session_id = ? AND turn_id = ?')
        .get('session-a', admitted.receipt.turnId) as { event_bytes: number; control_event_bytes: number; settlement_bytes: number };
    assert.equal(budget.event_bytes - budget.control_event_bytes, usage.event_bytes);
    assert.ok(budget.control_event_bytes > 0 && budget.control_event_bytes <= CODE_TERMINAL_RESERVE_BYTES);
    assert.equal(budget.settlement_bytes, 0);
});

test('terminal tool status events remain compact while materialized output stays complete', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const output = 'x'.repeat(1_000_000);
    store.commitItem(owner(admitted.session), { ...message(admitted.receipt.turnId, 'tool', ''), kind: 'tool_call', tool: { name: 'tool', output } });
    const result = store.settleTurn(owner(admitted.session), { status: 'failed', error: { code: 'failed', message: 'Provider exited', at: 1234, recoverable: true } });
    const toolEvent = result.events.find(event => event.update?.itemId === 'tool');
    assert.equal(toolEvent?.event, 'code_item_update');
    assert.equal(toolEvent?.update?.status, 'error');
    assert.equal(toolEvent?.update?.appendToolOutput, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result.events), 'utf8') < 4096);
    assert.equal(store.snapshot('session-a').items.find(item => item.itemId === 'tool')?.tool?.output, output);
});

test('new unresolved items cannot consume the reserve needed to settle already-admitted items', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    let accepted = 0;
    for (let index = 0; index < 40; index++) {
        try {
            store.commitItem(current, message(admitted.receipt.turnId, `${'x'.repeat(60_000)}-${index}`, 'small output'));
            accepted += 1;
        } catch (error) {
            assert.ok(error instanceof CodeStoreError);
            assert.equal(error.code, 'transcript_limit');
            break;
        }
    }
    assert.ok(accepted > 0 && accepted < 40);
    const result = store.settleTurn(current, { status: 'failed' });
    assert.equal(result.receipt.status, 'failed');
    const budget = db.prepare('SELECT control_event_bytes, settlement_bytes FROM code_turns').get() as { control_event_bytes: number; settlement_bytes: number };
    assert.ok(budget.control_event_bytes <= CODE_TERMINAL_RESERVE_BYTES);
    assert.equal(budget.settlement_bytes, 0);
});

test('event size rejection is transactional and old oversized replay rows are not silently skipped', t => {
    const { store, db } = fixture(t, { limits: { maxEventBytes: 2048 } });
    const admitted = admit(store);
    const before = store.snapshot('session-a');
    expectError(() => store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'large', 'x'.repeat(2048))), 'event_too_large');
    assert.deepEqual(store.snapshot('session-a'), before);
    store.commitItem(owner(admitted.session), message(admitted.receipt.turnId));
    db.prepare(`UPDATE code_events SET event_json = json_set(event_json, '$.item.text', ?) WHERE session_id = ? AND sequence = 5`)
        .run('x'.repeat(3000), 'session-a');
    const page = store.readEvents('session-a');
    assert.equal(page.nextSequence, 4);
    assert.equal(page.hasMore, true);
    expectError(() => store.readEvents('session-a', 4), 'event_too_large');
});

test('replay pages obey UTF-8 byte budgets and retain contiguous cursor semantics', t => {
    const { store } = fixture(t, { limits: { maxReplayPageBytes: 1600 } });
    const admitted = admit(store);
    for (let index = 0; index < 5; index++) store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, `item-${index}`, '💻'.repeat(80)));
    const sequences: number[] = [];
    let after = 0;
    let pages = 0;
    do {
        const page = store.readEvents('session-a', after);
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 1600);
        assert.ok(page.events.length > 0);
        assert.equal(page.events[0]?.sequence, after + 1);
        assert.equal(page.nextSequence, page.events.at(-1)?.sequence);
        assert.equal(page.throughSequence, 9);
        sequences.push(...page.events.map(event => event.sequence));
        after = page.nextSequence;
        pages += 1;
        if (!page.hasMore) break;
    } while (true);
    assert.ok(pages > 1);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('snapshots include complete active items or fail explicitly on the byte cap', t => {
    const { store } = fixture(t, { limits: { maxSnapshotBytes: 4096 } });
    const admitted = admit(store);
    store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'first', 'a'.repeat(1800)));
    const complete = store.snapshot('session-a', { limit: 1 });
    assert.deepEqual(complete.items.map(item => item.itemId), ['turn-1:user', 'turn-1:started', 'first']);
    assert.equal(complete.truncated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(complete), 'utf8') <= 4096);
    store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'second', 'b'.repeat(1800)));
    expectError(() => store.snapshot('session-a', { limit: 1 }), 'snapshot_limit');
});

test('snapshot byte budget retains newest history after reserving all current-turn items', t => {
    const { store } = fixture(t, { limits: { maxSnapshotBytes: 3000 } });
    const first = admit(store);
    for (let index = 0; index < 5; index++) store.commitItem(owner(first.session), { ...message(first.receipt.turnId, `old-${index}`, 'x'.repeat(700)), status: 'done' });
    store.settleTurn(owner(first.session), { status: 'completed' });
    const current = admit(store, 'next-key');
    const snapshot = store.snapshot('session-a');
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 3000);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.items.filter(item => item.turnId === current.receipt.turnId).map(item => item.kind), ['user_message', 'turn_started']);
    assert.ok(snapshot.items.some(item => item.itemId === 'old-4'));
    assert.ok(!snapshot.items.some(item => item.itemId === 'old-0'));
    const order = snapshot.items.map(item => item.firstSequence!);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('legacy turn schema gains durable byte accounting without losing keys or blocking orphan settlement', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE code_turns (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, client_turn_key TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, status TEXT NOT NULL, accepted_sequence INTEGER NOT NULL,
        PRIMARY KEY(session_id, turn_id), UNIQUE(session_id, client_turn_key));`);
    db.exec(CREATE_CODE_SCHEMA_SQL);
    db.prepare(`INSERT INTO code_sessions (session_id, provider, cwd, model, permission_mode, status, active_turn_id,
        capabilities_json, epoch, sequence, created_at, last_used_at) VALUES ('legacy', 'claude', '/workspace', 'model', 'ask',
        'starting', 'old-turn', ?, 1, 4, 1, 1)`).run(JSON.stringify(capabilities));
    db.exec("INSERT INTO code_turns VALUES ('legacy', 'old-turn', 'consumed-key', 'old-hash', 'accepted', 4)");
    const oldItems: CodeItem[] = [
        { itemId: 'old-item', turnId: 'old-turn', kind: 'user_message', status: 'done', text: 'retained history', createdAt: 1, updatedAt: 1 },
        { itemId: 'old-started', turnId: 'old-turn', kind: 'turn_started', status: 'running', createdAt: 1, updatedAt: 1 },
    ];
    const oldSession: CodeSessionInfo = {
        sessionId: 'legacy', provider: 'claude', cwd: '/workspace', title: null, model: 'model', effort: null,
        permissionMode: 'ask', status: 'starting', turnId: 'old-turn', archivedAt: null, error: null,
        capabilities, resume: { available: false, reason: 'not_started' }, epoch: 1, sequence: 4, revision: 0, createdAt: 1, lastUsedAt: 1,
        lastTurnCompletedAt: null, lastVisitedAt: null,
    };
    const oldEvents: CodeWireEvent[] = [
        { topic: 'code', event: 'code_session', sessionId: 'legacy', sequence: 1, epoch: 0,
            session: { ...oldSession, status: 'idle', turnId: null, epoch: 0, sequence: 1 } },
        ...oldItems.map((item, index): CodeWireEvent => ({ topic: 'code', event: 'code_item', sessionId: 'legacy', sequence: index + 2, epoch: 1, item })),
        { topic: 'code', event: 'code_session', sessionId: 'legacy', sequence: 4, epoch: 1, session: oldSession },
    ];
    oldItems.forEach((item, index) => db.prepare('INSERT INTO code_items VALUES (?, ?, ?, ?)').run('legacy', item.itemId, index + 2, JSON.stringify(item)));
    for (const event of oldEvents) db.prepare('INSERT INTO code_events VALUES (?, ?, ?)').run('legacy', event.sequence, JSON.stringify(event));
    const store = new CodeStore(db, { now: () => 100, limits: { maxTurnEventBytes: 1 } });
    const usage = db.prepare('SELECT event_bytes, control_event_bytes, settlement_bytes FROM code_turns').get() as { event_bytes: number; control_event_bytes: number; settlement_bytes: number };
    assert.equal(usage.event_bytes, oldEvents.slice(1).reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0));
    assert.equal(usage.control_event_bytes, 0);
    assert.ok(usage.settlement_bytes > 0);
    assert.equal(store.readTurn('legacy', 'consumed-key')?.status, 'accepted');
    store.recoverInterrupted();
    assert.equal(store.readTurn('legacy', 'consumed-key')?.status, 'failed');
    assert.equal(store.snapshot('legacy').items[0]?.text, 'retained history');
    assert.deepEqual(store.readEvents('legacy').events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    const settled = db.prepare('SELECT event_bytes FROM code_turns').get();
    new CodeStore(db);
    assert.deepEqual(db.prepare('SELECT event_bytes FROM code_turns').get(), settled);
});

test('exported hard byte limits cannot be raised by constructor configuration', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    assert.deepEqual([CODE_MAX_EVENT_BYTES, CODE_MAX_REPLAY_PAGE_BYTES, CODE_MAX_SNAPSHOT_BYTES, CODE_MAX_TURN_EVENT_BYTES],
        [4, 8, 8, 32].map(value => value * 1024 * 1024));
    expectError(() => new CodeStore(db, { limits: { maxEventBytes: CODE_MAX_EVENT_BYTES + 1 } }), 'invalid_limit', 400);
});

test('constructor adds only Code schema and repeated initialization preserves records', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec("CREATE TABLE messages (content TEXT); INSERT INTO messages VALUES ('existing history')");
    const store = new CodeStore(db);
    const created = store.create(creation);
    const reopened = new CodeStore(db);
    assert.deepEqual(reopened.read(creation.sessionId!), created.session);
    assert.deepEqual(db.prepare('SELECT content FROM messages').all(), [{ content: 'existing history' }]);
    assert.deepEqual(reopened.snapshot('session-a').items, []);
    assert.deepEqual(reopened.readEvents('session-a').events, created.events);
});

test('materialized history pages return older complete rows without advancing live sequence', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    for (let i = 0; i < 6; i++) store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, `m${i}`, `value-${i}`));
    store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'm0', 'updated full value'));
    store.settleTurn(owner(admitted.session), { status: 'completed' });
    const watermark = store.read('session-a')!.sequence;
    const newest = store.history('session-a', Number.MAX_SAFE_INTEGER, 2);
    assert.deepEqual(newest.items.map(item => item.itemId), ['m5', 'turn-1:terminal']);
    const older = store.history('session-a', newest.beforeSequence!, 2);
    assert.deepEqual(older.items.map(item => item.itemId), ['m3', 'm4']);
    const first = store.history('session-a', older.beforeSequence!, 10);
    assert.equal(first.items.find(item => item.itemId === 'm0')?.text, 'updated full value');
    assert.equal(first.hasMore, false);
    assert.equal(first.sequence, watermark);
    assert.equal(store.read('session-a')!.sequence, watermark);
    expectError(() => store.history('session-a', -1), 'invalid_sequence', 400);
    expectError(() => store.history('missing'), 'session_not_found', 404);
});

test('materialized history respects serialized byte budget and rejects an oversized first row', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const store = new CodeStore(db, { limits: { maxSnapshotBytes: 1200 }, newId: () => 'history-turn' });
    store.create(creation);
    const active = admit(store);
    for (let i = 0; i < 4; i++) store.commitItem(owner(active.session), message(active.receipt.turnId, `m${i}`, 'x'.repeat(500)));
    const page = store.history('session-a', Number.MAX_SAFE_INTEGER, 100);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.itemId, 'm3');
    assert.equal(page.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1200);
    store.commitItem(owner(active.session), message(active.receipt.turnId, 'large', 'x'.repeat(2000)));
    expectError(() => store.history('session-a'), 'snapshot_limit');
});

test('first prompt supplies a bounded Unicode title without overwriting a user title', t => {
    const { store } = fixture(t);
    const first = admit(store, 'first', 'session-a', '  세션 💻 요청\nMore details');
    assert.equal(first.session.title, '세션 💻 요청');
    store.settleTurn(owner(first.session), { status: 'completed' });
    assert.equal(admit(store, 'second', 'session-a', 'Different prompt').session.title, '세션 💻 요청');

    store.create({ ...creation, sessionId: 'pinned', title: 'My title' });
    assert.equal(admit(store, 'pinned-key', 'pinned', 'Generated candidate').session.title, 'My title');

    store.create({ ...creation, sessionId: 'unicode' });
    const prefix = '가'.repeat(119);
    assert.equal(admit(store, 'unicode-key', 'unicode', prefix + '👨‍👩‍👧‍👦').session.title, prefix);
});

test('full row mapping includes every field and public surfaces exclude private native metadata', t => {
    const { store, db } = fixture(t);
    db.prepare(`UPDATE code_sessions SET title = ?, model = ?, effort = ?, permission_mode = ?,
        status = ?, active_turn_id = ?, archived_at = ?, error_json = ?, native_cursor = ?, native_started = ?,
        native_policy_json = ?, epoch = ?, revision = ?, created_at = ?, last_used_at = ? WHERE session_id = ?`)
        .run('Stored title', 'stored-model', 'low', 'auto', 'suspended', null, null,
            JSON.stringify({ code: 'stored_error', message: 'diagnostic', at: 56, recoverable: true, nativeCursor: 'nested-private' }),
            'private-native-id', 1, JSON.stringify({ model: 'old-model', effort: null, permissionMode: 'ask' }),
            7, 8, 111, 222, 'session-a');
    const expected: CodeSessionInfo = {
        sessionId: 'session-a', provider: 'claude', cwd: '/workspace/a', title: 'Stored title',
        model: 'stored-model', effort: 'low', permissionMode: 'auto', status: 'suspended', turnId: null,
        archivedAt: null, error: { code: 'stored_error', message: 'diagnostic', at: 56, recoverable: true },
        resume: { available: true, reason: null }, capabilities, epoch: 7, sequence: 1, revision: 8,
        createdAt: 111, lastUsedAt: 222, lastTurnCompletedAt: null, lastVisitedAt: null, thinking: true,
        rollback: { available: false, reason: 'no_boundary', sinceSequence: null }, historyGeneration: 0,
    };
    assert.deepEqual(store.read('session-a'), expected);
    const record = store.readRecord('session-a')!;
    assert.equal(record.nativeCursor, 'private-native-id');
    assert.equal(record.nativeStarted, true);
    assert.deepEqual(record.nativePolicy, { model: 'old-model', effort: null, permissionMode: 'ask' });
    assert.deepEqual(store.list(), [expected]);
    assert.deepEqual(store.snapshot('session-a').session, expected);
    const patched = store.patchSession('session-a', { expectedRevision: 8, title: 'Renamed' });
    assert.deepEqual(Object.keys(patched.session).sort(), dtoKeys);
    for (const value of [store.read('session-a'), store.list(), store.snapshot('session-a'), patched, store.readEvents('session-a')]) {
        assert.doesNotMatch(JSON.stringify(value), /nativeCursor|nativeStarted|nativePolicy|private-native-id|nested-private|old-model/);
    }
});

test('public mapper also strips future private properties nested in capabilities', () => {
    const record: CodeSessionRecord = {
        ...creation, sessionId: 's', title: null, status: 'idle', turnId: null,
        archivedAt: null, error: null, epoch: 0, sequence: 0, revision: 0, createdAt: 1, lastUsedAt: 2,
        lastTurnCompletedAt: null, lastVisitedAt: null, thinking: null, nativeCursor: 'secret', nativeStarted: true, nativePolicy: null,
        replayFloorSequence: 0, historyGeneration: 0, rollbackSince: null,
    };
    const extra = { ...record, privateFutureField: 'private', capabilities: { ...capabilities, nativeCursor: 'hidden' } };
    assert.deepEqual(Object.keys(toCodeSessionInfo(extra)).sort(), dtoKeys);
    assert.doesNotMatch(JSON.stringify(toCodeSessionInfo(extra)), /private|secret|hidden|nativeCursor/);
});

test('admission commits turn, complete user text, start item, receipt and consecutive events before return', t => {
    const { store, db } = fixture(t);
    const text = '  exact prompt\n' + 'x'.repeat(4000);
    const result = admit(store, 'key-a', 'session-a', text);
    assert.equal(db.inTransaction, false);
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.receipt, { turnId: 'turn-1', clientTurnKey: 'key-a', sequence: 4, status: 'accepted' });
    assert.deepEqual(result.events.map(event => event.sequence), [2, 3, 4]);
    assert.equal(result.session.status, 'starting');
    assert.equal(result.session.epoch, 1);
    assert.equal(store.snapshot('session-a').items[0]?.text, text);
    assert.deepEqual(store.readEvents('session-a', 1).events, result.events);
    assert.deepEqual(store.readTurn('session-a', 'key-a'), result.receipt);
    assert.equal(store.readRecord('session-a')?.nativeStarted, false);
    assert.deepEqual(store.readRecord('session-a')?.nativePolicy, { model: 'model-a', effort: 'high', permissionMode: 'ask' });
});

test('matching key wins over busy; mismatching content and competing keys cannot alter admitted work', t => {
    const { store } = fixture(t);
    const first = admit(store);
    const duplicate = admit(store);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.deepEqual(duplicate.events, []);
    expectError(() => admit(store, 'key-a', 'session-a', 'hello '), 'turn_key_conflict');
    expectError(() => admit(store, 'key-b'), 'session_busy');
    assert.equal(store.read('session-a')?.sequence, 4);
    assert.equal(store.readTurn('session-a', 'key-b'), null);
    assert.equal(store.snapshot('session-a').items.length, 2);
});

test('terminal duplicate receipts win over archive and stale revision while conflicts and new keys stay rejected', t => {
    const { store } = fixture(t);
    for (const [index, status] of (['completed', 'failed', 'cancelled'] as const).entries()) {
        const sessionId = index === 0 ? 'session-a' : `session-${index}`;
        if (index > 0) store.create({ ...creation, sessionId });
        const text = `prompt-${status}`;
        const key = `key-${status}`;
        const admitted = admit(store, key, sessionId, text);
        const settled = store.settleTurn(owner(admitted.session), {
            status,
            ...(status === 'failed' ? { error: { code: 'provider_failed', message: 'Provider failed', at: 1234, recoverable: true } } : {}),
        });
        const archived = store.patchSession(sessionId, { expectedRevision: 0, archived: true });

        const duplicate = store.admitTurn({ sessionId, text, clientTurnKey: key,
            expectedRevision: archived.session.revision + 100 });
        assert.equal(duplicate.duplicate, true);
        assert.deepEqual(duplicate.receipt, settled.receipt);
        assert.deepEqual(duplicate.events, []);
        expectError(() => store.admitTurn({ sessionId, text: `${text}-different`, clientTurnKey: key,
            expectedRevision: archived.session.revision }), 'turn_key_conflict');
        expectError(() => store.admitTurn({ sessionId, text, clientTurnKey: `${key}-new`,
            expectedRevision: archived.session.revision }), 'session_archived');
    }
});

test('a second store instance observes the durable admission before any native open', t => {
    const { store, db } = fixture(t);
    const accepted = admit(store);
    const other = new CodeStore(db);
    assert.deepEqual(admit(other).receipt, accepted.receipt);
    expectError(() => admit(other, 'competing-key'), 'session_busy');
    assert.equal(other.read('session-a')?.status, 'starting');
    assert.equal(other.readRecord('session-a')?.nativeCursor, null);
});

test('session/client key uniqueness is enforced in SQLite and keys are independent across sessions', t => {
    const { store, db } = fixture(t);
    admit(store);
    store.create({ ...creation, sessionId: 'session-b' });
    assert.equal(admit(store, 'key-a', 'session-b').duplicate, false);
    assert.throws(() => db.prepare(`INSERT INTO code_turns
        (session_id, turn_id, client_turn_key, prompt_hash, status, accepted_sequence)
        VALUES ('session-a', 'another-turn', 'key-a', 'hash', 'accepted', 99)`).run(), /UNIQUE/);
});

test('failed admission rolls back all rows, watermark and key consumption', t => {
    const { store, db } = fixture(t);
    db.exec(`CREATE TRIGGER reject_code_start BEFORE INSERT ON code_events
        WHEN NEW.sequence = 3 BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
    assert.throws(() => admit(store), /injected event failure/);
    assert.equal(store.read('session-a')?.status, 'idle');
    assert.equal(store.read('session-a')?.sequence, 1);
    assert.equal(store.readTurn('session-a', 'key-a'), null);
    assert.deepEqual(store.snapshot('session-a').items, []);
    assert.equal(store.readEvents('session-a').events.length, 1);
    db.exec('DROP TRIGGER reject_code_start');
    assert.equal(admit(store).duplicate, false);
});

test('old tool updates retain firstSequence and first-appearance order while events advance', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    store.commitItem(current, { ...message(admitted.receipt.turnId, 'first', 'first value'), kind: 'tool_call', tool: { name: 'tool' } });
    store.commitItem(current, message(admitted.receipt.turnId, 'second', 'second value'));
    const longText = 'whole retained value '.repeat(2000);
    store.commitItem(current, { ...message(admitted.receipt.turnId, 'first', longText), kind: 'tool_call', tool: { name: 'tool', output: longText }, status: 'done' });
    const snapshot = store.snapshot('session-a');
    assert.deepEqual(snapshot.items.map(item => item.itemId), ['turn-1:user', 'turn-1:started', 'first', 'second']);
    assert.equal(snapshot.items[2]?.text, longText);
    assert.deepEqual(snapshot.items.map(item => item.firstSequence), [2, 3, 5, 6]);
    assert.equal(snapshot.sequence, 7);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.sequence), [5, 6, 7]);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.firstSequence), [5, 6, 5]);
    assert.deepEqual(store.snapshot('session-a', { limit: 1 }).items.map(item => item.itemId), ['turn-1:user', 'turn-1:started', 'first', 'second']);
});

test('snapshot retains the newest 1000 items in ascending firstSequence order', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    for (let index = 0; index < 1005; index++) {
        store.commitItem(owner(admitted.session), { ...message(admitted.receipt.turnId, `item-${index}`, `message ${index}`), status: 'done' });
    }
    store.settleTurn(owner(admitted.session), { status: 'completed' });
    const snapshot = store.snapshot('session-a');
    assert.equal(snapshot.items.length, 1000);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.items.map(item => item.itemId), [...Array.from({ length: 999 }, (_, index) => `item-${index + 6}`), 'turn-1:terminal']);
    assert.deepEqual(snapshot.items.slice(0, -1).map(item => item.firstSequence), Array.from({ length: 999 }, (_, index) => index + 11));
    assert.equal(snapshot.items.at(-2)?.text, 'message 1004');
    assert.equal(snapshot.sequence, 1012);
    assert.equal(snapshot.session.sequence, 1012);
});

test('caller firstSequence is ignored on insertion and update; projected row owns snapshot and replay order', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const first = store.commitItem(current, { ...message(admitted.receipt.turnId), firstSequence: -999 });
    assert.equal(first.events[0]?.item?.firstSequence, 5);
    const update = store.commitItem(current, { ...message(admitted.receipt.turnId, 'answer', 'updated'), firstSequence: 999999 });
    assert.equal(update.events[0]?.sequence, 6);
    assert.equal(update.events[0]?.item?.firstSequence, 5);
    assert.deepEqual(db.prepare('SELECT first_sequence FROM code_items WHERE session_id = ? AND item_id = ?')
        .get('session-a', 'answer'), { first_sequence: 5 });
    // Old or inconsistent JSON metadata cannot override the retained relational identity.
    db.prepare(`UPDATE code_items SET item_json = json_set(item_json, '$.firstSequence', 999999)
        WHERE session_id = ? AND item_id = ?`).run('session-a', 'answer');
    db.prepare(`UPDATE code_events SET event_json = json_remove(event_json, '$.item.firstSequence')
        WHERE session_id = ? AND sequence = ?`).run('session-a', 5);
    assert.equal(store.snapshot('session-a').items.at(-1)?.firstSequence, 5);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.firstSequence), [5, 5]);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.text), ['retained answer', 'updated']);
});

test('item write failure rolls back projection and event sequence', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    db.exec(`CREATE TRIGGER reject_item BEFORE INSERT ON code_items
        WHEN NEW.item_id = 'answer' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`);
    assert.throws(() => store.commitItem(owner(admitted.session), message(admitted.receipt.turnId)), /injected projection failure/);
    assert.equal(store.read('session-a')?.sequence, 4);
    assert.equal(store.readEvents('session-a', 4).events.length, 0);
    assert.equal(store.snapshot('session-a').items.length, 2);
});

test('all item fields round-trip and retained events are detached from mutable input', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const input = {
        ...message(admitted.receipt.turnId), status: 'done' as const, phase: 'final' as const, text: '', clientTurnKey: 'key-a', parentItemId: 'parent',
        tool: { name: 'tool', input: '{"a":1}', detail: 'detail', output: 'result', nativeCursor: 'tool-private' },
        truncation: { storedChars: 10, sourceChars: 100, reason: 'field_limit', privatePolicy: 'hidden' },
        nativeCursor: 'item-private',
    };
    const expected: CodeItem = {
        itemId: 'answer', firstSequence: 5, turnId: admitted.receipt.turnId, kind: 'assistant_message', status: 'done', phase: 'final',
        text: '', clientTurnKey: 'key-a', parentItemId: 'parent', createdAt: 1234, updatedAt: 1234,
        tool: { name: 'tool', input: '{"a":1}', detail: 'detail', output: 'result' },
        truncation: { storedChars: 10, sourceChars: 100, reason: 'field_limit' },
    };
    const committed = store.commitItem(owner(admitted.session), input);
    input.tool.output = 'later mutation';
    input.text = 'later text';
    assert.deepEqual(committed.events[0]?.item, expected);
    assert.deepEqual(store.readEvents('session-a', 4).events[0]?.item, expected);
    assert.deepEqual(store.snapshot('session-a').items.at(-1), expected);
    assert.doesNotMatch(JSON.stringify(committed), /nativeCursor|privatePolicy|hidden|private/);
});

test('replay advances only to last returned sequence and snapshot never clips an active turn by row count', t => {
    const { store } = fixture(t);
    admit(store);
    const first = store.readEvents('session-a', 0, 2);
    assert.deepEqual([first.nextSequence, first.throughSequence, first.hasMore], [2, 4, true]);
    const next = store.readEvents('session-a', first.nextSequence, 2);
    assert.deepEqual(next.events.map(event => event.sequence), [3, 4]);
    assert.deepEqual([next.nextSequence, next.throughSequence, next.hasMore], [4, 4, false]);
    assert.deepEqual(store.readEvents('session-a', 4), { events: [], nextSequence: 4, throughSequence: 4, hasMore: false });
    const snapshot = store.snapshot('session-a', { limit: 1 });
    assert.equal(snapshot.truncated, false);
    assert.equal(snapshot.items.length, 2);
    assert.deepEqual(snapshot.items.map(item => item.itemId), ['turn-1:user', 'turn-1:started']);
    assert.deepEqual(snapshot.items.map(item => item.firstSequence), [2, 3]);
    assert.equal(snapshot.sequence, 4);
    assert.equal(snapshot.session.sequence, 4);
    expectError(() => store.readEvents('session-a', 5), 'invalid_sequence');
    expectError(() => store.readEvents('session-a', -1), 'invalid_sequence', 400);
});

test('event page size is capped at 500 even when a larger limit is requested', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    for (let index = 0; index < 500; index++) {
        store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'answer', String(index)));
    }
    const page = store.readEvents('session-a', 0, 5000);
    assert.equal(page.events.length, 500);
    assert.equal(page.nextSequence, 500);
    assert.equal(page.throughSequence, 504);
    assert.equal(page.hasMore, true);
    assert.deepEqual(store.readEvents('session-a', page.nextSequence).events.map(event => event.sequence), [501, 502, 503, 504]);
});

test('permission mapping retains full public fields and rejects another owner before storage', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const permission = {
        permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
        title: 'Allow tool', detail: 'Full detail', requestedAt: 4321, nativeCursor: 'hidden-permission',
        options: [{ optionId: 'yes', label: 'Allow once', kind: 'allow_once', nativeCursor: 'hidden-option' }],
    };
    const item: CodeItem = {
        itemId: 'permission', turnId: admitted.receipt.turnId, kind: 'permission_request', status: 'pending',
        permission, createdAt: 1234, updatedAt: 4321,
    };
    expectError(() => store.commitItem(current, { ...item, permission: { ...permission, epoch: current.epoch + 1 } }), 'stale_owner');
    expectError(() => store.commitItem(current, { ...item, permission: { ...permission, sessionId: 'other-session' } }), 'stale_owner');
    assert.equal(store.read('session-a')?.sequence, 4);
    const committed = store.commitItem(current, item);
    const expected = {
        permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
        title: 'Allow tool', detail: 'Full detail', requestedAt: 4321,
        options: [{ optionId: 'yes', label: 'Allow once', kind: 'allow_once' }],
    };
    assert.deepEqual(committed.events[0]?.item?.permission, expected);
    assert.deepEqual(store.snapshot('session-a').pendingPermissions, [expected]);
    assert.doesNotMatch(JSON.stringify(store.readEvents('session-a')), /nativeCursor|hidden-option|hidden-permission/);
});

test('metadata revision prevents lost edits; busy rename works and busy archive/policy fail', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const renamed = store.patchSession('session-a', { expectedRevision: 0, title: 'User title' });
    assert.equal(renamed.session.revision, 1);
    assert.equal(renamed.session.turnId, admitted.receipt.turnId);
    assert.equal(renamed.session.epoch, admitted.session.epoch);
    expectError(() => store.patchSession('session-a', { expectedRevision: 0, title: 'Stale title' }), 'revision_conflict');
    expectError(() => store.patchSession('session-a', { expectedRevision: 1, archived: true }), 'session_busy');
    expectError(() => store.patchSession('session-a', { expectedRevision: 1, model: 'other-model' }), 'session_busy');
    expectError(() => store.admitTurn({ sessionId: 'session-a', text: 'new', clientTurnKey: 'new', expectedRevision: 0 }), 'revision_conflict');
    assert.equal(store.read('session-a')?.title, 'User title');
    assert.equal(store.read('session-a')?.revision, 1);
});

test('terminal settlement is atomic and preserves accepted receipt sequence', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    store.setRuntimeState(owner(admitted.session), 'streaming');
    assert.equal(store.readTurn('session-a', 'key-a')?.status, 'running');
    db.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE ON code_turns
        WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END`);
    const before = store.snapshot('session-a');
    assert.throws(() => store.settleTurn(owner(admitted.session), { status: 'completed' }), /injected terminal failure/);
    assert.deepEqual(store.snapshot('session-a'), before);
    db.exec('DROP TRIGGER reject_terminal');
    const result = store.settleTurn(owner(admitted.session), { status: 'completed' });
    assert.equal(result.session.status, 'idle');
    assert.equal(result.session.turnId, null);
    assert.equal(result.receipt.status, 'completed');
    assert.equal(result.receipt.sequence, 4);
    const repeated = store.settleTurn(owner(admitted.session), { status: 'cancelled' });
    assert.equal(repeated.receipt.status, 'completed');
    assert.deepEqual(repeated.events, []);
    assert.deepEqual(admit(store).receipt, result.receipt);
    assert.equal(store.snapshot('session-a').items.filter(item => item.kind === 'turn_completed').length, 1);
});

test('old epoch/turn callbacks cannot mutate a newer turn or reuse another turn item identity', t => {
    const { store } = fixture(t);
    const first = admit(store);
    store.commitItem(owner(first.session), message(first.receipt.turnId));
    store.settleTurn(owner(first.session), { status: 'completed' });
    const next = admit(store, 'key-b');
    const before = store.snapshot('session-a');
    expectError(() => store.commitItem(owner(first.session), message(first.receipt.turnId)), 'stale_owner');
    expectError(() => store.writeNativeCursor(owner(first.session), 'late-cursor'), 'stale_owner');
    expectError(() => store.settleTurn(owner(first.session), { status: 'failed' }), 'stale_owner');
    expectError(() => store.setRuntimeState(owner(first.session), 'stopping'), 'stale_owner');
    expectError(() => store.commitItem(owner(next.session), message(next.receipt.turnId)), 'item_owner_conflict');
    assert.deepEqual(store.snapshot('session-a'), before);
});

test('only settlement can commit a terminal turn and unfinished tools are not reported as successful', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    expectError(() => store.commitItem(current, { ...message(admitted.receipt.turnId), kind: 'turn_completed', status: 'done' }), 'terminal_item_owned');
    store.commitItem(current, { ...message(admitted.receipt.turnId), kind: 'tool_call', tool: { name: 'unfinished' } });
    const settled = store.settleTurn(current, { status: 'completed' });
    assert.equal(settled.receipt.status, 'completed');
    assert.equal(store.snapshot('session-a').items.find(item => item.itemId === 'answer')?.status, 'cancelled');
    assert.equal(store.snapshot('session-a').items.filter(item => item.kind === 'turn_completed').length, 1);
});

test('archive is non-destructive, rejects sends and fences idle native callbacks', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'stored-cursor');
    const finished = store.settleTurn(owner(admitted.session), { status: 'completed' });
    const archived = store.patchSession('session-a', { expectedRevision: 0, archived: true });
    assert.equal(archived.session.archivedAt, 1234);
    assert.equal(archived.session.resume.reason, 'archived');
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'stored-cursor');
    assert.equal(store.snapshot('session-a').items.length, 3);
    assert.equal(store.list({ archived: true }).length, 1);
    assert.equal(store.list({ archived: false }).length, 0);
    expectError(() => admit(store, 'key-b'), 'session_archived');
    expectError(() => store.writeNativeCursor(owner(finished.session), 'late'), 'stale_owner');
    store.patchSession('session-a', { expectedRevision: 1, archived: false });
    assert.equal(store.read('session-a')?.resume.available, true);
    assert.equal(store.list({ cwd: '/another/workspace' }).length, 0);
});

test('restart expires approvals, fails orphaned work, fences callbacks and preserves consumed keys', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    store.writeNativeCursor(current, 'durable-native-cursor');
    store.commitItem(current, {
        itemId: 'permission', turnId: admitted.receipt.turnId, kind: 'permission_request', status: 'pending',
        createdAt: 1234, updatedAt: 1234,
        permission: { permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
            title: 'Run command', detail: 'tool detail', options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }], requestedAt: 1234 },
    });
    store.commitItem(current, message(admitted.receipt.turnId, 'after-permission'));
    const recent = store.snapshot('session-a', { limit: 1 });
    assert.deepEqual(recent.items.map(item => item.itemId), ['turn-1:user', 'turn-1:started', 'permission', 'after-permission']);
    assert.equal(recent.pendingPermissions.length, 1);
    assert.equal(recent.pendingPermissions[0]?.permissionId, 'p');
    store.create({ ...creation, sessionId: 'session-b' });
    const unaffected = store.snapshot('session-b');
    const restarted = new CodeStore(db, { now: () => 5678 });
    const events = restarted.recoverInterrupted();
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.sessionId === 'session-a'));
    const snapshot = restarted.snapshot('session-a');
    assert.equal(snapshot.session.status, 'failed');
    assert.equal(snapshot.session.turnId, null);
    assert.equal(snapshot.session.epoch, current.epoch + 1);
    assert.equal(snapshot.session.error?.code, 'orphaned_turn');
    assert.equal(snapshot.items.find(item => item.itemId === 'permission')?.status, 'cancelled');
    assert.deepEqual(snapshot.pendingPermissions, []);
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_failed').length, 1);
    const duplicate = admit(restarted);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.deepEqual(duplicate.events, []);
    expectError(() => restarted.writeNativeCursor(current, 'stale'), 'stale_owner');
    assert.deepEqual(restarted.recoverInterrupted(), []);
    assert.deepEqual(restarted.snapshot('session-b'), unaffected);
    assert.equal(admit(restarted, 'new-key').duplicate, false);
});

test('missing native identity after actual start cannot silently start fresh, but receipt is still consumed', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), null);
    assert.equal(store.read('session-a')?.resume.reason, 'resume_unavailable');
    store.recoverInterrupted();
    assert.equal(admit(store).duplicate, true);
    expectError(() => admit(store, 'new-key'), 'resume_unavailable');
    assert.equal(store.readTurn('session-a', 'new-key'), null);
});

test('never-started metadata can first-open after recovery and cursor cannot regress to null', t => {
    const { store } = fixture(t);
    assert.equal(store.read('session-a')?.resume.reason, 'not_started');
    assert.deepEqual(store.recoverInterrupted(), []);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'real-native-id');
    store.writeNativeCursor(owner(admitted.session), null);
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'real-native-id');
    expectError(() => store.writeNativeCursor(owner(admitted.session), ' '), 'invalid_cursor', 400);
    store.setRuntimeState(owner(admitted.session), 'stopping');
    expectError(() => store.writeNativeCursor(owner(admitted.session), 'late'), 'stale_owner');
    expectError(() => store.setRuntimeState(owner(admitted.session), 'streaming'), 'stale_owner');
});

test('explicit attach reserves a fresh epoch, blocks new prompts, and stores resume failure without losing history', t => {
    const { store } = fixture(t);
    expectError(() => store.beginAttach('session-a'), 'resume_unavailable');
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'durable-id');
    const finished = store.settleTurn(owner(admitted.session), { status: 'completed' });
    const attached = store.beginAttach('session-a', 0);
    assert.equal(attached.session.turnId, null);
    assert.equal(attached.session.status, 'starting');
    assert.equal(attached.session.epoch, finished.session.epoch + 1);
    expectError(() => admit(store, 'new-key'), 'session_busy');
    expectError(() => store.beginAttach('session-a'), 'session_busy');
    expectError(() => store.writeNativeCursor(owner(finished.session), 'late'), 'stale_owner');
    const failed = store.setRuntimeState(owner(attached.session), 'failed', {
        code: 'resume_failed', message: 'Native resume failed', at: 1234, recoverable: true,
    });
    assert.equal(failed.session.error?.code, 'resume_failed');
    assert.equal(store.snapshot('session-a').items.length, 3);
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'durable-id');
    assert.equal(store.readTurn('session-a', 'new-key'), null);
    const retried = store.beginAttach('session-a');
    assert.equal(store.setRuntimeState(owner(retried.session), 'idle').session.status, 'idle');
});

test('restart during attach fails residency without inventing a turn or erasing transcript', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'durable-id');
    store.settleTurn(owner(admitted.session), { status: 'completed' });
    const before = store.snapshot('session-a').items;
    const attached = store.beginAttach('session-a');
    store.recoverInterrupted();
    const after = store.snapshot('session-a');
    assert.equal(after.session.epoch, attached.session.epoch + 1);
    assert.equal(after.session.status, 'failed');
    assert.deepEqual(after.items, before);
    assert.equal(store.readTurn('session-a', 'key-a')?.status, 'completed');
});

test('independent backend connections recover only their own sessions even with identical IDs', t => {
    const first = fixture(t);
    const second = fixture(t);
    admit(first.store);
    admit(second.store);
    const before = second.store.snapshot('session-a');
    first.store.recoverInterrupted();
    assert.equal(first.store.read('session-a')?.status, 'failed');
    assert.deepEqual(second.store.snapshot('session-a'), before);
    assert.equal(second.store.read('session-a')?.status, 'starting');
});

test('metadata and cursor event failures cannot commit private or public state ahead of publication', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const before = store.readRecord('session-a');
    db.exec(`CREATE TRIGGER reject_session_event BEFORE INSERT ON code_events
        WHEN json_extract(NEW.event_json, '$.event') = 'code_session'
        BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`);
    assert.throws(() => store.patchSession('session-a', { expectedRevision: 0, title: 'Uncommitted' }), /injected metadata failure/);
    assert.throws(() => store.writeNativeCursor(owner(admitted.session), 'uncommitted-cursor'), /injected metadata failure/);
    assert.deepEqual(store.readRecord('session-a'), before);
    assert.deepEqual(store.readEvents('session-a', 4).events, []);
});

test('writes cannot hand out uncommitted events from an outer transaction', t => {
    const { store, db } = fixture(t);
    db.transaction(() => expectError(() => admit(store), 'nested_transaction'))();
    assert.equal(store.read('session-a')?.sequence, 1);
    assert.equal(store.readTurn('session-a', 'key-a'), null);
});

test('missing sessions and invalid prompts do not allocate durable work', t => {
    const { store } = fixture(t);
    assert.equal(store.read('missing'), null);
    expectError(() => store.snapshot('missing'), 'session_not_found', 404);
    expectError(() => admit(store, 'key', 'missing'), 'session_not_found', 404);
    expectError(() => admit(store, 'key', 'session-a', '  '), 'invalid_prompt', 400);
    expectError(() => admit(store, ' '), 'invalid_prompt', 400);
    assert.equal(store.read('session-a')?.sequence, 1);
});

// --- #781: paged reads follow a stable creation order ---
// last_used_at moves forward on every write, so OFFSET pages over that key
// skipped a session that was renamed between pages. The cursor stream walks
// (created_at, session_id) — an immutable position — so a row matching the
// filter when the stream started is seen exactly once; rows created or newly
// matching ahead of the cursor belong to a later from-scratch read.
function cursorOf(page: CodeSessionInfo[]) {
    const last = page.at(-1)!;
    return { createdAt: last.createdAt, sessionId: last.sessionId };
}
const sessionIds = (page: CodeSessionInfo[]) => page.map(session => session.sessionId);

test('cursor pages cover the filtered stream once each while writes move rows between reads', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    let now = 0;
    const store = new CodeStore(db, { now: () => ++now });
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    for (const sessionId of ids) store.create({ ...creation, sessionId });

    const first = store.list({ limit: 2 });
    assert.deepEqual(sessionIds(first), ['s5', 's4']);
    // Rename, a completed turn, an archive and a create all move last_used_at
    // or the filter between pages; none may move this stream's membership.
    store.patchSession('s1', { expectedRevision: 0, title: 'Renamed' });
    const admitted = store.admitTurn({ sessionId: 's2', clientTurnKey: 'turn-key', text: 'hello' });
    store.settleTurn(owner(admitted.session), { status: 'completed' });
    store.patchSession('s3', { expectedRevision: 0, archived: true });
    store.create({ ...creation, sessionId: 's6' });
    const second = store.list({ limit: 2, cursor: cursorOf(first) });
    assert.deepEqual(sessionIds(second), ['s3', 's2']);
    const third = store.list({ limit: 2, cursor: cursorOf(second) });
    assert.deepEqual(sessionIds(third), ['s1']);
    const seen = [...first, ...second, ...third].map(session => session.sessionId);
    assert.equal(seen.length, new Set(seen).size, 'a stable stream never repeats a row');
    assert.deepEqual(new Set(seen), new Set(ids));
    // s6 sorts ahead of the cursor: it belongs to a fresh read, not this stream.
    assert.deepEqual(sessionIds(store.list({ limit: 10 })), ['s6', 's5', 's4', 's3', 's2', 's1']);
});

test('cursor streams stay inside the archived and cwd filters and creation ties order by id', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const store = new CodeStore(db, { now: () => 1000 });
    for (const sessionId of ['b2', 'a1', 'd4', 'c3']) store.create({ ...creation, sessionId });
    // Equal creation times: the session id tie-break makes the order total.
    const first = store.list({ limit: 2 });
    assert.deepEqual(sessionIds(first), ['a1', 'b2']);
    store.patchSession('c3', { expectedRevision: 0, archived: true });
    const rest = store.list({ limit: 2, cursor: cursorOf(first) });
    assert.deepEqual(sessionIds(rest), ['c3', 'd4']);
    // The same stream under archived=false drops the row archived mid-read;
    // it has left the filter rather than being lost by the pagination.
    assert.deepEqual(sessionIds(store.list({ archived: false, limit: 2, cursor: cursorOf(first) })), ['d4']);
    assert.deepEqual(sessionIds(store.list({ archived: true })), ['c3']);
    assert.deepEqual(sessionIds(store.list({ cwd: '/workspace/a' })), ['a1', 'b2', 'c3', 'd4']);
    assert.deepEqual(store.list({ cwd: '/another/workspace' }), []);
    expectError(() => store.list({ cursor: { createdAt: -1, sessionId: 'x' } }), 'invalid_cursor', 400);
    expectError(() => store.list({ cursor: { createdAt: 1, sessionId: '' } }), 'invalid_cursor', 400);
});

test('session list index is upgraded once and left alone when it already matches', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    new CodeStore(db);
    db.exec('DROP INDEX idx_code_sessions_list; CREATE INDEX idx_code_sessions_list ON code_sessions(archived_at, last_used_at)');
    const indexColumns = () => (db.prepare("PRAGMA index_info('idx_code_sessions_list')").all() as { name: string }[])
        .map(column => column.name);
    new CodeStore(db);
    assert.deepEqual(indexColumns(), ['archived_at', 'created_at', 'session_id']);
    const before = db.pragma('schema_version', { simple: true });
    new CodeStore(db);
    assert.equal(db.pragma('schema_version', { simple: true }), before, 'a matching index is not dropped and rebuilt');
});

// ─── Sidebar activity clocks (unread = lastTurnCompletedAt > lastVisitedAt) ───

test('activity clocks start null and move only on completed/failed turns and on visits', t => {
    let clock = 1000;
    const { store } = fixture(t, { now: () => clock });
    assert.equal(store.read('session-a').lastTurnCompletedAt, null);
    assert.equal(store.read('session-a').lastVisitedAt, null);

    clock = 2000;
    const first = admit(store);
    store.settleTurn(owner(first.session), { status: 'completed' });
    assert.equal(store.read('session-a').lastTurnCompletedAt, 2000);

    clock = 3000;
    const cancelled = admit(store, 'key-b');
    store.settleTurn(owner(cancelled.session), { status: 'cancelled' });
    assert.equal(store.read('session-a').lastTurnCompletedAt, 2000, 'a stopped turn is not unread news');

    clock = 4000;
    const failed = admit(store, 'key-c');
    store.settleTurn(owner(failed.session), { status: 'failed', error: { code: 'x', message: 'x', at: 4000, recoverable: true } });
    assert.equal(store.read('session-a').lastTurnCompletedAt, 4000);

    clock = 5000;
    const before = store.read('session-a');
    const visited = store.markVisited('session-a');
    assert.equal(visited.session.lastVisitedAt, 5000);
    assert.equal(visited.session.revision, before.revision, 'a read receipt is not a metadata change');
    assert.equal(visited.events.length, 1);
    assert.equal(visited.events[0]?.event, 'code_session');
    assert.equal(store.read('session-a').lastVisitedAt, 5000);
});

test('databases created before the activity clocks gain both columns as null', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(CREATE_CODE_SCHEMA_SQL.replace(',\n    last_turn_completed_at INTEGER, last_visited_at INTEGER, thinking INTEGER', ''));
    const legacyColumns = (db.prepare('PRAGMA table_info(code_sessions)').all() as { name: string }[]).map(c => c.name);
    assert.equal(legacyColumns.includes('last_visited_at'), false);
    const store = new CodeStore(db, { now: () => 1234, newId: () => 'turn-x' });
    store.create(creation);
    const columns = (db.prepare('PRAGMA table_info(code_sessions)').all() as { name: string }[]).map(c => c.name);
    assert.ok(columns.includes('last_turn_completed_at') && columns.includes('last_visited_at') && columns.includes('thinking'));
    assert.equal(store.read('session-a').lastVisitedAt, null);
});

test('a database that already has the activity clocks gains only thinking; its legacy Claude row reads on', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const schema = CREATE_CODE_SCHEMA_SQL.replace(', last_visited_at INTEGER, thinking INTEGER', ', last_visited_at INTEGER');
    assert.notEqual(schema, CREATE_CODE_SCHEMA_SQL);
    db.exec(schema);
    const legacyColumns = (db.prepare('PRAGMA table_info(code_sessions)').all() as { name: string }[]).map(c => c.name);
    assert.ok(legacyColumns.includes('last_turn_completed_at') && legacyColumns.includes('last_visited_at'));
    assert.equal(legacyColumns.includes('thinking'), false);
    db.prepare(`INSERT INTO code_sessions (session_id, provider, cwd, title, model, effort, permission_mode, status,
        capabilities_json, created_at, last_used_at, last_visited_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'idle', ?, 1, 1, 7)`)
        .run('session-legacy', 'claude', '/workspace/a', 'model-a', 'high', 'ask', JSON.stringify(capabilities));
    const store = new CodeStore(db, { now: () => 1234, newId: () => 'turn-x' });
    const columns = (db.prepare('PRAGMA table_info(code_sessions)').all() as { name: string }[]).map(c => c.name);
    assert.ok(columns.includes('thinking'));
    assert.equal(store.read('session-legacy').thinking, true);
    assert.equal(store.read('session-legacy').lastVisitedAt, 7, 'the existing clock is kept');
});

test('thinking: Claude rows read on when unset, persist a switch, and fence the old owner', t => {
    const { store } = fixture(t);
    assert.equal(store.read('session-a').thinking, true);
    const before = store.read('session-a');
    const off = store.patchSession('session-a', { expectedRevision: before.revision, thinking: false });
    assert.equal(off.session.thinking, false);
    assert.equal(store.read('session-a').thinking, false);
    assert.ok(off.session.epoch > before.epoch, 'a thinking change is a policy change');
});

test('thinking chosen at creation is stored as given', t => {
    const { store } = fixture(t);
    store.create({ ...creation, sessionId: 'session-off', thinking: false });
    assert.equal(store.read('session-off').thinking, false);
});

test('a non-Claude session reads thinking as null', t => {
    const { store } = fixture(t);
    store.create({ ...creation, sessionId: 'session-codex', provider: 'codex-app' });
    assert.equal(store.read('session-codex').thinking, null);
});

// Code in-band follow-ups: one durable slot per running turn, reserved before the native
// offer and recorded in the transcript only after the runtime accepted it.
function streamingTurn(t: { after(fn: () => void): void }, options: CodeStoreOptions = {}) {
    const f = fixture(t, options);
    const admitted = admit(f.store);
    const running = f.store.setRuntimeState(owner(admitted.session), 'streaming').session;
    const steer = (key: string, text = 'follow-up', session = running) =>
        f.store.reserveSteer({ sessionId: 'session-a', clientTurnKey: key, text, turnId: session.turnId!, epoch: session.epoch });
    return { ...f, admitted, running, steer };
}
const steerRows = (db: Database.Database) => db.prepare('SELECT client_turn_key, status, native_uuid FROM code_steers ORDER BY client_turn_key').all();

test('a follow-up reservation holds the turn slot without events, a new turn, or a new epoch', t => {
    const f = streamingTurn(t);
    const before = f.store.read('session-a')!;
    assert.deepEqual(f.steer('steer-1'), { reservationId: 'steer-1', receipt: null });
    const after = f.store.read('session-a')!;
    assert.deepEqual({ sequence: after.sequence, epoch: after.epoch, turnId: after.turnId, status: after.status },
        { sequence: before.sequence, epoch: before.epoch, turnId: before.turnId, status: 'streaming' });
    expectError(() => f.steer('steer-2'), 'steer_queue_full');
    f.store.rejectSteer('session-a', 'steer-1');
    assert.deepEqual(f.steer('steer-2').receipt, null, 'a refused offer frees the slot');
    const committed = f.store.commitSteer('session-a', 'steer-2', 'follow-up', 'native-2');
    expectError(() => f.steer('steer-3'), 'steer_queue_full');
    assert.deepEqual(committed.events.map(event => event.item?.itemId), [`${f.running.turnId}:steer:steer-2`]);
    const item = committed.events[0]!.item!;
    assert.deepEqual({ kind: item.kind, status: item.status, turnId: item.turnId, text: item.text, key: item.clientTurnKey },
        { kind: 'user_message', status: 'done', turnId: f.running.turnId, text: 'follow-up', key: 'steer-2' });
    assert.deepEqual(committed.receipt, { turnId: f.running.turnId, clientTurnKey: 'steer-2', sequence: committed.events[0]!.sequence, status: 'running' });
    const session = f.store.read('session-a')!;
    assert.deepEqual({ epoch: session.epoch, turnId: session.turnId, status: session.status }, { epoch: f.running.epoch, turnId: f.running.turnId, status: 'streaming' });
    assert.equal(f.store.snapshot('session-a').items.filter(row => row.kind === 'turn_started').length, 1);
    assert.deepEqual(steerRows(f.db), [
        { client_turn_key: 'steer-1', status: 'rejected', native_uuid: null },
        { client_turn_key: 'steer-2', status: 'committed', native_uuid: 'native-2' }]);
});

test('SQLite itself refuses a second live follow-up for one turn', t => {
    const f = streamingTurn(t);
    f.steer('steer-1');
    assert.throws(() => f.db.prepare(`INSERT INTO code_steers (session_id, turn_id, client_turn_key, prompt_hash, status)
        VALUES ('session-a', ?, 'forged', 'x', 'unknown')`).run(f.running.turnId), /UNIQUE/);
    f.db.prepare(`INSERT INTO code_steers (session_id, turn_id, client_turn_key, prompt_hash, status)
        VALUES ('session-a', ?, 'forged', 'x', 'rejected')`).run(f.running.turnId);
});

test('the follow-up key state machine answers every stored state without a second offer', t => {
    const f = streamingTurn(t);
    f.steer('steer-1', 'same text');
    expectError(() => f.steer('steer-1', 'same text'), 'steer_in_flight');
    expectError(() => f.steer('steer-1', 'other text'), 'turn_key_conflict');
    f.store.markSteerUnknown('session-a', 'steer-1');
    expectError(() => f.steer('steer-1', 'same text'), 'steer_outcome_unknown', 503);
    expectError(() => f.store.readSteer('session-a', { clientTurnKey: 'steer-1', text: 'same text' }), 'steer_outcome_unknown', 503);
    expectError(() => f.steer('steer-2'), 'steer_queue_full', 409);
    expectError(() => f.steer('key-a', 'hello'), 'turn_key_conflict');
    expectError(() => f.steer('', 'hello'), 'invalid_prompt', 400);
    expectError(() => f.steer('steer-3', '   '), 'invalid_prompt', 400);

    const g = streamingTurn(t);
    g.steer('steer-1');
    g.store.rejectSteer('session-a', 'steer-1');
    expectError(() => g.steer('steer-1'), 'steer_key_spent');
    g.steer('steer-2');
    const committed = g.store.commitSteer('session-a', 'steer-2', 'follow-up', 'native');
    assert.deepEqual(g.steer('steer-2'), { reservationId: 'steer-2', receipt: committed.receipt });
    assert.deepEqual(g.store.readSteer('session-a', { clientTurnKey: 'steer-2', text: 'follow-up' }), committed.receipt);
    expectError(() => g.store.readSteer('session-a', { clientTurnKey: 'steer-2', text: 'changed' }), 'turn_key_conflict');
    expectError(() => g.store.commitSteer('session-a', 'steer-2', 'follow-up', 'native'), 'stale_owner');
    // One key names one message across prompts and follow-ups.
    expectError(() => g.store.readTurn('session-a', 'steer-2'), 'turn_key_conflict');
    expectError(() => admit(g.store, 'steer-1', 'session-a', 'follow-up'), 'turn_key_conflict');
});

test('only the captured streaming turn takes a follow-up', t => {
    const f = fixture(t);
    const idle = f.store.read('session-a')!;
    expectError(() => f.store.reserveSteer({ sessionId: 'session-a', clientTurnKey: 's', text: 'x', turnId: 'turn-1', epoch: idle.epoch }), 'stale_owner');
    const admitted = admit(f.store);
    const starting = admitted.session;
    expectError(() => f.store.reserveSteer({ sessionId: 'session-a', clientTurnKey: 's', text: 'x', turnId: starting.turnId!, epoch: starting.epoch }),
        'session_not_steerable');
    const running = f.store.setRuntimeState(owner(starting), 'streaming').session;
    expectError(() => f.store.reserveSteer({ sessionId: 'session-a', clientTurnKey: 's', text: 'x', turnId: running.turnId!, epoch: running.epoch + 1 }),
        'stale_owner');
    const stopping = f.store.setRuntimeState(owner(running), 'stopping').session;
    expectError(() => f.store.reserveSteer({ sessionId: 'session-a', clientTurnKey: 's', text: 'x', turnId: stopping.turnId!, epoch: stopping.epoch }),
        'session_not_steerable');
    expectError(() => f.store.reserveSteer({ sessionId: 'missing', clientTurnKey: 's', text: 'x', turnId: 't', epoch: 1 }), 'session_not_found', 404);
    assert.deepEqual(steerRows(f.db), []);
});

test('a follow-up the turn budget cannot store is refused before any reservation', t => {
    const f = streamingTurn(t, { limits: { maxTurnEventBytes: 4096 } });
    expectError(() => f.steer('steer-1', 'x'.repeat(4096)), 'transcript_limit');
    assert.deepEqual(steerRows(f.db), []);
    assert.equal(f.steer('steer-2', 'small').receipt, null);
});

test('settlement marks an unconsumed follow-up unconfirmed, keeps a consumed one, and leaves a leftover reservation unknown', t => {
    const f = streamingTurn(t);
    f.steer('steer-1');
    const committed = f.store.commitSteer('session-a', 'steer-1', 'follow-up', 'native-1');
    const settled = f.store.settleTurn(owner(f.running), { status: 'cancelled', undeliveredFollowUps: ['native-1', 'foreign'] });
    const itemId = `${f.running.turnId}:steer:steer-1`;
    const update = settled.events.find(event => event.update?.itemId === itemId)?.update;
    assert.deepEqual(update && { phase: update.phase, firstSequence: update.firstSequence, status: update.status },
        { phase: 'unknown', firstSequence: committed.events[0]!.sequence, status: undefined });
    assert.equal(f.store.snapshot('session-a').items.find(item => item.itemId === itemId)?.phase, 'unknown');
    assert.equal(replayItems(f.store.readEvents('session-a').events).find(item => item.itemId === itemId)?.phase, 'unknown');
    assert.deepEqual(f.store.readSteer('session-a', { clientTurnKey: 'steer-1', text: 'follow-up' }),
        { ...committed.receipt, status: 'cancelled' }, 'a committed replay reports the turn as it ended');

    const g = streamingTurn(t);
    g.steer('steer-1');
    g.store.commitSteer('session-a', 'steer-1', 'follow-up', 'native-1');
    const completed = g.store.settleTurn(owner(g.running), { status: 'completed', undeliveredFollowUps: [] });
    assert.equal(completed.events.some(event => event.update?.phase === 'unknown'), false);
    assert.equal(g.store.snapshot('session-a').items.find(item => item.kind === 'user_message' && item.clientTurnKey === 'steer-1')?.phase, undefined);

    // The offer may still be in flight when the turn settles: the key answers unknown, never "send it again".
    const h = streamingTurn(t);
    h.steer('steer-1');
    h.store.settleTurn(owner(h.running), { status: 'completed' });
    expectError(() => h.steer('steer-1', 'follow-up', h.running), 'steer_outcome_unknown', 503);
    expectError(() => h.store.readSteer('session-a', { clientTurnKey: 'steer-1', text: 'follow-up' }), 'steer_outcome_unknown', 503);
    expectError(() => h.store.commitSteer('session-a', 'steer-1', 'follow-up', 'late'), 'stale_owner');
    h.store.markSteerUnknown('session-a', 'steer-1');
    assert.equal(steerRows(h.db).find(row => (row as { client_turn_key: string }).client_turn_key === 'steer-1')?.status, 'unknown');
    // The in-flight call that then learns the runtime refused it records the refusal.
    h.store.rejectSteer('session-a', 'steer-1');
    expectError(() => h.steer('steer-1', 'follow-up', h.running), 'steer_key_spent');
});

test('restart leaves a reservation the lost process may have offered unknown', t => {
    const f = streamingTurn(t);
    f.steer('steer-1');
    const restarted = new CodeStore(f.db, { now: () => 5678 });
    restarted.recoverInterrupted();
    assert.deepEqual(steerRows(f.db), [{ client_turn_key: 'steer-1', status: 'unknown', native_uuid: null }]);
    expectError(() => restarted.readSteer('session-a', { clientTurnKey: 'steer-1', text: 'follow-up' }), 'steer_outcome_unknown', 503);
});

test('restart marks every committed follow-up of the recovered turn delivery not confirmed', t => {
    const f = streamingTurn(t);
    f.steer('steer-1');
    const committed = f.store.commitSteer('session-a', 'steer-1', 'follow-up', 'native-1');
    const restarted = new CodeStore(f.db, { now: () => 5678 });
    const events = restarted.recoverInterrupted();
    const itemId = `${f.running.turnId}:steer:steer-1`;
    const update = events.find(event => event.update?.itemId === itemId)?.update;
    assert.deepEqual(update && { phase: update.phase, firstSequence: update.firstSequence },
        { phase: 'unknown', firstSequence: committed.events[0]!.sequence });
    assert.equal(events.at(-1)?.session?.status, 'failed');
    const snapshot = restarted.snapshot('session-a');
    assert.deepEqual(snapshot.items.filter(item => item.kind === 'user_message').map(item => [item.clientTurnKey, item.phase]),
        [['key-a', undefined], ['steer-1', 'unknown']]);
    assert.equal(replayItems(restarted.readEvents('session-a').events).find(item => item.itemId === itemId)?.phase, 'unknown');
    assert.deepEqual(restarted.readSteer('session-a', { clientTurnKey: 'steer-1', text: 'follow-up' }), { ...committed.receipt, status: 'failed' });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function settled(store: CodeStore, key: string, options: { cursor?: string | null; status?: 'completed' | 'failed' | 'cancelled'; dispatched?: boolean } = {}) {
    const admitted = admit(store, key, 'session-a', `prompt ${key}`);
    const current = owner(admitted.session);
    const cursor = options.cursor === undefined ? 'native-a' : options.cursor;
    if (cursor !== null) store.writeNativeCursor(current, cursor);
    store.commitItem(current, message(admitted.receipt.turnId, `${admitted.receipt.turnId}:answer`, `answer ${key}`));
    store.settleTurn(current, { status: options.status ?? 'completed', ...(options.dispatched === undefined ? {} : { dispatched: options.dispatched }) });
    return admitted;
}
function boundaries(db: InstanceType<typeof Database>): Record<string, string | null> {
    return Object.fromEntries((db.prepare('SELECT turn_id, native_prompt_uuid FROM code_turns ORDER BY accepted_sequence')
        .all() as Array<{ turn_id: string; native_prompt_uuid: string | null }>).map(row => [row.turn_id, row.native_prompt_uuid]));
}
const FORK_UUID = '6f2b1d4e-8a1c-4c3e-9b7a-2d5e8f1a3c9b';

test('Claude admissions carry a private prompt UUID that never reaches the wire; other providers carry none', t => {
    const { store, db } = fixture(t);
    const first = settled(store, 'k1');
    const stored = boundaries(db)['turn-1']!;
    assert.match(stored, UUID);
    assert.equal(first.promptUuid, stored);
    const surfaces = [first.events, first.receipt, first.session, store.snapshot('session-a'), store.readEvents('session-a'),
        store.history('session-a'), store.list(), store.readTurn('session-a', 'k1')];
    assert.doesNotMatch(JSON.stringify(surfaces), new RegExp(stored));
    store.create({ ...creation, sessionId: 'session-codex', provider: 'codex-app' });
    const codex = admit(store, 'k-codex', 'session-codex');
    assert.equal(codex.promptUuid, null);
    assert.equal((db.prepare("SELECT native_prompt_uuid FROM code_turns WHERE session_id = 'session-codex'").get() as { native_prompt_uuid: null }).native_prompt_uuid, null);
    assert.equal(admit(store, 'k1', 'session-a', 'prompt k1').promptUuid, null, 'a duplicate receipt starts nothing');
});

test('rollback availability names why it is off and where recorded boundaries start', t => {
    const { store, db } = fixture(t);
    assert.deepEqual(store.read('session-a')!.rollback, { available: false, reason: 'not_started', sinceSequence: null });
    store.create({ ...creation, sessionId: 'session-codex', provider: 'codex-app' });
    assert.equal(store.read('session-codex')!.rollback.reason, 'unsupported');
    settled(store, 'k1');
    db.prepare("UPDATE code_turns SET native_prompt_uuid = NULL WHERE turn_id = 'turn-1'").run();
    assert.deepEqual(store.read('session-a')!.rollback, { available: false, reason: 'no_boundary', sinceSequence: null },
        'a turn without a boundary (admitted before this change) is not a target');
    const second = settled(store, 'k2');
    const secondUser = store.snapshot('session-a').items.find(item => item.itemId === `${second.receipt.turnId}:user`)!;
    assert.deepEqual(store.read('session-a')!.rollback, { available: true, reason: null, sinceSequence: secondUser.firstSequence });
    assert.equal(second.events.at(-1)?.session?.rollback.sinceSequence, secondUser.firstSequence, 'the admission event already carries it');
    const revision = store.read('session-a')!.revision;
    store.patchSession('session-a', { expectedRevision: revision, archived: true });
    assert.equal(store.read('session-a')!.rollback.reason, 'archived');
});

test('a rollback plan targets only a settled user row with a boundary and a later turn with one', t => {
    const { store, db } = fixture(t);
    for (const key of ['k1', 'k2', 'k3']) settled(store, key);
    const ids = boundaries(db);
    const plan = store.readRollbackPlan('session-a', 'turn-1:user');
    const session = store.read('session-a')!;
    assert.deepEqual(plan, { target: { turnId: 'turn-1', promptUuid: ids['turn-1'] },
        kept: [{ turnId: 'turn-1', promptUuid: ids['turn-1'] }],
        later: [{ turnId: 'turn-2', promptUuid: ids['turn-2'] }, { turnId: 'turn-3', promptUuid: ids['turn-3'] }],
        revision: session.revision, epoch: session.epoch, nativeCursor: 'native-a', title: 'prompt k1' });
    assert.deepEqual(store.readRollbackPlan('session-a', 'turn-2:user').kept.map(turn => turn.turnId), ['turn-1', 'turn-2']);
    expectError(() => store.readRollbackPlan('session-a', 'turn-3:user'), 'rollback_noop');
    expectError(() => store.readRollbackPlan('session-a', 'turn-1:answer'), 'rollback_target_not_found', 404);
    expectError(() => store.readRollbackPlan('session-a', 'turn-9:user'), 'rollback_target_not_found', 404);
    db.prepare("UPDATE code_turns SET native_prompt_uuid = NULL WHERE turn_id = 'turn-2'").run();
    assert.deepEqual(store.readRollbackPlan('session-a', 'turn-1:user').later.map(turn => turn.promptUuid), [null, ids['turn-3']],
        'an undispatched later turn is carried for the provider to skip');
    db.prepare("UPDATE code_turns SET native_prompt_uuid = NULL WHERE turn_id = 'turn-3'").run();
    expectError(() => store.readRollbackPlan('session-a', 'turn-1:user'), 'rollback_boundary_unavailable');
    db.prepare("UPDATE code_turns SET native_prompt_uuid = ? WHERE turn_id = 'turn-3'").run(ids['turn-3']);
    db.prepare("UPDATE code_turns SET native_prompt_uuid = NULL WHERE turn_id = 'turn-1'").run();
    expectError(() => store.readRollbackPlan('session-a', 'turn-1:user'), 'rollback_boundary_unavailable');
    const active = admit(store, 'k4', 'session-a', 'prompt k4');
    expectError(() => store.readRollbackPlan('session-a', `${active.receipt.turnId}:user`), 'session_busy');
});

test('a rollback commit is one compare-and-swap that removes later turns, floors replay and keeps receipts', t => {
    const { store, db } = fixture(t);
    for (const key of ['k1', 'k2', 'k3']) settled(store, key);
    const plan = store.readRollbackPlan('session-a', 'turn-1:user');
    const commit = { sessionId: 'session-a', upToItemId: 'turn-1:user', expectedRevision: plan.revision, expectedEpoch: plan.epoch,
        expectedCursor: plan.nativeCursor, forkCursor: 'fork-a', remapped: [{ turnId: 'turn-1', promptUuid: FORK_UUID }], cleared: [] };
    const before = { snapshot: store.snapshot('session-a'), boundaries: boundaries(db) };
    for (const stale of [{ expectedRevision: plan.revision + 1 }, { expectedEpoch: plan.epoch + 1 }, { expectedCursor: 'other-native' }]) {
        expectError(() => store.commitRollback({ ...commit, ...stale }), 'revision_conflict');
    }
    expectError(() => store.commitRollback({ ...commit, forkCursor: 'native-a' }), 'invalid_cursor', 400);
    expectError(() => store.commitRollback({ ...commit, remapped: [{ turnId: 'turn-2', promptUuid: FORK_UUID }] }), 'rollback_unavailable');
    assert.deepEqual(store.snapshot('session-a'), before.snapshot, 'a refused commit changes nothing');
    assert.deepEqual(boundaries(db), before.boundaries);
    // A read receipt moves the sequence, not the swap's identity.
    store.markVisited('session-a');
    const floorBefore = store.read('session-a')!.sequence;
    const result = store.commitRollback(commit);
    assert.deepEqual(result.events.map(event => event.event), ['code_session']);
    const session = result.session;
    assert.equal(session.sequence, floorBefore + 1);
    assert.equal(result.events[0]!.sequence, session.sequence);
    assert.deepEqual({ generation: session.historyGeneration, revision: session.revision, epoch: session.epoch, status: session.status, error: session.error },
        { generation: 1, revision: plan.revision + 1, epoch: plan.epoch + 1, status: 'idle', error: null });
    assert.deepEqual([...new Set(store.snapshot('session-a').items.map(item => item.turnId))], ['turn-1']);
    const events = db.prepare("SELECT event_json FROM code_events WHERE session_id = 'session-a'").all() as Array<{ event_json: string }>;
    assert.ok(!events.some(row => /turn-2|turn-3/.test(row.event_json)), 'removed turns take their events with them');
    expectError(() => store.readEvents('session-a', session.sequence - 1), 'invalid_sequence');
    expectError(() => store.readEvents('session-a', 0), 'invalid_sequence');
    assert.deepEqual(store.readEvents('session-a', session.sequence).events, []);
    assert.equal(store.readRecord('session-a')!.nativeCursor, 'fork-a');
    assert.deepEqual(boundaries(db), { 'turn-1': FORK_UUID, 'turn-2': null, 'turn-3': null });
    assert.deepEqual((db.prepare('SELECT removed_generation FROM code_turns ORDER BY accepted_sequence').all() as Array<{ removed_generation: number | null }>)
        .map(row => row.removed_generation), [null, 1, 1]);
    assert.equal(store.readTurn('session-a', 'k1')?.status, 'completed');
    assert.equal(store.readTurn('session-a', 'k2')?.status, 'cancelled', 'a removed turn is not current');
    const duplicate = admit(store, 'k3', 'session-a', 'prompt k3');
    assert.deepEqual({ duplicate: duplicate.duplicate, status: duplicate.receipt.status, events: duplicate.events }, { duplicate: true, status: 'cancelled', events: [] });
    expectError(() => store.commitRollback(commit), 'revision_conflict', 409);
    expectError(() => store.readRollbackPlan('session-a', 'turn-2:user'), 'rollback_target_not_found', 404);
    const next = settled(store, 'k4', { cursor: 'fork-a' });
    assert.deepEqual(store.readEvents('session-a', session.sequence).events.map(event => event.sequence)[0], session.sequence + 1);
    assert.match(boundaries(db)[next.receipt.turnId]!, UUID);
    assert.equal(boundaries(db)['turn-1'], FORK_UUID, 'the fork cursor is the same identity, not a replaced one');
});

test('a rollback commit clears a failed session and drops kept boundaries the fork did not align', t => {
    const { store, db } = fixture(t);
    settled(store, 'k1'); settled(store, 'k2');
    settled(store, 'k3', { status: 'failed' });
    assert.equal(store.read('session-a')!.status, 'failed');
    const plan = store.readRollbackPlan('session-a', 'turn-2:user');
    const result = store.commitRollback({ sessionId: 'session-a', upToItemId: 'turn-2:user', expectedRevision: plan.revision,
        expectedEpoch: plan.epoch, expectedCursor: plan.nativeCursor, forkCursor: 'fork-b',
        remapped: [{ turnId: 'turn-2', promptUuid: FORK_UUID }], cleared: ['turn-1'] });
    assert.deepEqual({ status: result.session.status, error: result.session.error }, { status: 'idle', error: null });
    assert.deepEqual(boundaries(db), { 'turn-1': null, 'turn-2': FORK_UUID, 'turn-3': null });
    const user = store.snapshot('session-a').items.find(item => item.itemId === 'turn-2:user')!;
    assert.deepEqual(result.session.rollback, { available: true, reason: null, sinceSequence: user.firstSequence });
});

test('a replaced native identity retires recorded boundaries; the first identity and the active turn keep theirs', t => {
    const { store, db } = fixture(t);
    // A settled turn that never reported an identity keeps its boundary (dispatch unknown).
    settled(store, 'k1', { cursor: null });
    const second = admit(store, 'k2', 'session-a', 'prompt k2');
    store.writeNativeCursor(owner(second.session), null);
    store.writeNativeCursor(owner(second.session), 'native-a');
    store.settleTurn(owner(second.session), { status: 'completed' });
    assert.match(boundaries(db)['turn-1']!, UUID, 'null -> first id keeps every recorded boundary, not only the active one');
    assert.match(boundaries(db)['turn-2']!, UUID);
    settled(store, 'k3', { cursor: 'native-a' });
    assert.match(boundaries(db)['turn-1']!, UUID, 'the same id keeps them');
    const fourth = admit(store, 'k4', 'session-a', 'prompt k4');
    store.writeNativeCursor(owner(fourth.session), 'native-b');
    const ids = boundaries(db);
    assert.deepEqual([ids['turn-1'], ids['turn-2'], ids['turn-3']], [null, null, null]);
    assert.match(ids['turn-4']!, UUID, 'the active prompt is sent to the new identity');
    store.settleTurn(owner(fourth.session), { status: 'completed' });
    assert.equal(store.read('session-a')!.rollback.sinceSequence,
        store.snapshot('session-a').items.find(item => item.itemId === 'turn-4:user')!.firstSequence);
});

test('a turn that settles before its prompt was dispatched is not a boundary; an unknown dispatch keeps it', t => {
    const { store, db } = fixture(t);
    settled(store, 'k1');
    settled(store, 'k2', { status: 'failed', dispatched: false });
    settled(store, 'k3', { status: 'failed' });
    const interrupted = admit(store, 'k4', 'session-a', 'prompt k4');
    store.recoverInterrupted();
    const ids = boundaries(db);
    assert.equal(ids['turn-2'], null);
    assert.match(ids['turn-3']!, UUID);
    assert.match(ids[interrupted.receipt.turnId]!, UUID, 'a restart cannot prove the prompt stayed local');
    assert.deepEqual(store.readRollbackPlan('session-a', 'turn-1:user').later.map(turn => turn.promptUuid === null), [true, false, false]);
});

/** A settled Claude turn that took one committed follow-up while it streamed. */
function steered(store: CodeStore, key: string, steerKey: string) {
    const admitted = admit(store, key, 'session-a', `prompt ${key}`);
    store.writeNativeCursor(owner(admitted.session), 'native-a');
    const running = store.setRuntimeState(owner(admitted.session), 'streaming').session;
    store.reserveSteer({ sessionId: 'session-a', clientTurnKey: steerKey, text: `follow ${steerKey}`, turnId: running.turnId!, epoch: running.epoch });
    const committed = store.commitSteer('session-a', steerKey, `follow ${steerKey}`, `native-${steerKey}`);
    store.commitItem(owner(running), message(running.turnId!, `${running.turnId}:answer`, `answer ${key}`));
    store.settleTurn(owner(running), { status: 'completed' });
    return { turnId: running.turnId!, receipt: committed.receipt };
}

test('a rollback keeps follow-up rows as they are, removes the follow-ups of removed turns and reads their receipts cancelled', t => {
    const { store, db } = fixture(t);
    const first = steered(store, 'k1', 's1');
    const second = steered(store, 'k2', 's2');
    settled(store, 'k3');
    expectError(() => store.readRollbackPlan('session-a', `${first.turnId}:steer:s1`), 'rollback_target_not_found', 404);
    expectError(() => store.readRollbackPlan('session-a', `${second.turnId}:steer:s2`), 'rollback_target_not_found', 404);
    const plan = store.readRollbackPlan('session-a', `${first.turnId}:user`);
    assert.deepEqual([...plan.kept, ...plan.later].map(turn => turn.turnId), ['turn-1', 'turn-2', 'turn-3'], 'follow-ups never bound a rollback');
    const rows = () => db.prepare('SELECT * FROM code_steers ORDER BY client_turn_key').all();
    const before = rows();
    assert.equal(before.length, 2);
    store.commitRollback({ sessionId: 'session-a', upToItemId: `${first.turnId}:user`, expectedRevision: plan.revision, expectedEpoch: plan.epoch,
        expectedCursor: plan.nativeCursor, forkCursor: 'fork-a', remapped: [{ turnId: first.turnId, promptUuid: FORK_UUID }], cleared: [] });
    assert.deepEqual(rows(), before, 'status, sequence and native id of every follow-up row are unchanged');
    assert.deepEqual(store.snapshot('session-a').items.filter(item => item.kind === 'user_message').map(item => item.itemId),
        [`${first.turnId}:user`, `${first.turnId}:steer:s1`]);
    const events = db.prepare("SELECT event_json FROM code_events WHERE session_id = 'session-a'").all() as Array<{ event_json: string }>;
    assert.ok(!events.some(row => row.event_json.includes(':steer:s2')), 'the removed follow-up takes its events with it');
    assert.deepEqual(store.readSteer('session-a', { clientTurnKey: 's1', text: 'follow s1' }), { ...first.receipt, status: 'completed' });
    assert.deepEqual(store.readSteer('session-a', { clientTurnKey: 's2', text: 'follow s2' }), { ...second.receipt, status: 'cancelled' },
        'a follow-up of a removed turn reads cancelled, like its prompt');
    assert.equal(store.readTurn('session-a', 'k2')?.status, 'cancelled');
    const replay = store.reserveSteer({ sessionId: 'session-a', clientTurnKey: 's2', text: 'follow s2', turnId: second.turnId, epoch: plan.epoch });
    assert.deepEqual(replay, { reservationId: 's2', receipt: { ...second.receipt, status: 'cancelled' } });
    expectError(() => store.readSteer('session-a', { clientTurnKey: 's2', text: 'changed' }), 'turn_key_conflict');
    expectError(() => admit(store, 's2', 'session-a', 'follow s2'), 'turn_key_conflict', 409);
    expectError(() => store.readTurn('session-a', 's2'), 'turn_key_conflict');
    assert.deepEqual(rows(), before);
});

test('databases created before rollback gain its columns: old turns have no boundary, floors and generations start at 0', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const legacy = CREATE_CODE_SCHEMA_SQL
        .replace(',\n    replay_floor_sequence INTEGER NOT NULL DEFAULT 0, history_generation INTEGER NOT NULL DEFAULT 0', '')
        .replace('\n    native_prompt_uuid TEXT, removed_generation INTEGER,', '');
    assert.ok(!legacy.includes('replay_floor_sequence') && !legacy.includes('native_prompt_uuid'));
    db.exec(legacy);
    db.prepare(`INSERT INTO code_sessions (session_id, provider, cwd, model, permission_mode, status, native_cursor, native_started,
        capabilities_json, epoch, sequence, created_at, last_used_at) VALUES ('legacy', 'claude', '/workspace', 'model', 'ask',
        'idle', 'native-old', 1, ?, 1, 4, 1, 1)`).run(JSON.stringify(capabilities));
    db.exec("INSERT INTO code_turns (session_id, turn_id, client_turn_key, prompt_hash, status, accepted_sequence) VALUES ('legacy', 'old', 'old-key', 'h', 'completed', 4)");
    db.prepare('INSERT INTO code_items VALUES (?, ?, ?, ?)').run('legacy', 'old:user', 2,
        JSON.stringify({ itemId: 'old:user', turnId: 'old', kind: 'user_message', status: 'done', text: 'old', createdAt: 1, updatedAt: 1 }));
    const store = new CodeStore(db);
    const record = store.readRecord('legacy')!;
    assert.deepEqual({ floor: record.replayFloorSequence, generation: record.historyGeneration, since: record.rollbackSince }, { floor: 0, generation: 0, since: null });
    assert.deepEqual(store.read('legacy')!.rollback, { available: false, reason: 'no_boundary', sinceSequence: null });
    assert.deepEqual(boundaries(db), { old: null });
    assert.equal(store.readTurn('legacy', 'old-key')?.status, 'completed');
    new CodeStore(db);
});
