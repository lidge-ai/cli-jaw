import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeDraft, type CodeDraftBook } from '../../public/manager/src/code/code-controller-drafts.ts';
import { loadCodeDraftStorage, saveCodeDraftStorage } from '../../public/manager/src/code/code-controller-draft-storage.ts';

function storage(): Storage {
    const values = new Map<string, string>();
    return { get length() { return values.size; }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function book(store: Storage, endpoint = 'http://127.0.0.1:3457'): CodeDraftBook {
    return { endpoint, storage: store, storageWarning: null, recoveryWarning: null, selectedId: null, navigation: 0,
        fresh: createCodeDraft({ provider: 'codex-app', cwd: '/workspace', model: 'model', effort: 'high', permissionMode: 'auto' }),
        sessions: new Map(), listeners: new Set() };
}

test('pending settings survive storage and remain protected under draft pressure', () => {
    const store = storage(), b = book(store);
    const draft = createCodeDraft(b.fresh.selection);
    Object.assign(draft, { settings: { fields: [{ field: 'effort', baseline: 'high', value: null }], state: 'sent', mutationId: '00000000000000000000000001', expectedRevision: 2, watermark: null, expired: false, autoRetried: false, error: null, op: null } });
    b.sessions.set('protected', draft);
    for (let i = 0; i < 40; i++) { const other = createCodeDraft(b.fresh.selection); other.input = 'draft'; b.sessions.set(String(i), other); }
    assert.ok(saveCodeDraftStorage(store, b.endpoint, b));
    const saved = loadCodeDraftStorage(store, b.endpoint).data!.sessions.find(row => row.id === 'protected');
    assert.equal(saved?.draft.settings?.state, 'sent');
    assert.equal(saved?.draft.settings?.fields[0]?.value, null);
});

test('settings checkpoints refuse endpoint eviction and malformed settings do not restore', () => {
    const store = storage();
    for (let i = 0; i < 4; i++) {
        const b = book(store, `http://127.0.0.1:${5000 + i}`);
        Object.assign(b.fresh, { settings: { fields: [{ field: 'model', baseline: 'model', value: 'next' }], state: 'pending', mutationId: null,
            expectedRevision: null, watermark: null, expired: false, autoRetried: false, error: null, op: null } });
        assert.equal(saveCodeDraftStorage(store, b.endpoint, b), null);
    }
    const checkpoint = store.getItem('cli-jaw:code-drafts:v1');
    const extra = book(store, 'http://127.0.0.1:6000');
    assert.match(saveCodeDraftStorage(store, extra.endpoint, extra)!, /incomplete/);
    assert.equal(store.getItem('cli-jaw:code-drafts:v1'), checkpoint);
    const raw = JSON.parse(checkpoint!); raw.endpoints[0].fresh.settings.fields[0].value = { invalid: true };
    store.setItem('cli-jaw:code-drafts:v1', JSON.stringify(raw));
    assert.equal(loadCodeDraftStorage(store, 'http://127.0.0.1:5000').data, null);
});

test('pending settings transferred to a session survive pressure and reload', () => {
    const store = storage(), b = book(store), draft = createCodeDraft(b.fresh.selection);
    Object.assign(draft, { settings: { fields: [{ field: 'effort', baseline: 'high', value: null }], state: 'pending', mutationId: null,
        expectedRevision: null, watermark: null, expired: false, autoRetried: false, error: null, op: null } });
    b.sessions.set('created', draft);
    for (let i = 0; i < 40; i++) { const other = createCodeDraft(b.fresh.selection); other.input = 'other'; b.sessions.set(String(i), other); }
    saveCodeDraftStorage(store, b.endpoint, b);
    const restored = loadCodeDraftStorage(store, b.endpoint).data!.sessions.find(row => row.id === 'created');
    assert.equal(restored?.draft.settings?.state, 'pending');
    assert.equal(restored?.draft.settings?.fields[0]?.value, null);
});

test('storage allowlist retains draft intent and request identity, excluding authority and permission choices', () => {
    const store = storage(), draftBook = book(store);
    const draft = createCodeDraft(draftBook.fresh.selection);
    draft.input = 'newer draft'; draft.edit = 2;
    draft.retry = { text: 'original prompt', key: 'original-key', edit: 1 };
    draft.operation = { kind: 'sending', error: 'private error' };
    draft.stopTarget = { turnId: 'turn', epoch: 4, outcome: 'pending' };
    draft.permissionOperations = { approval: { pending: true, error: 'opaque choice' } };
    Object.assign(draft, { nativeCursor: 'private-native-cursor', transcript: ['private transcript'], token: 'secret-token' });
    draftBook.sessions.set('s', draft); draftBook.selectedId = 's';
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    const loaded = loadCodeDraftStorage(store, draftBook.endpoint).data!;
    assert.deepEqual(loaded.sessions[0]!.draft.retry, { text: 'original prompt', key: 'original-key', edit: 1 });
    assert.deepEqual(loaded.sessions[0]!.draft.stop, { turnId: 'turn', epoch: 4 });
    assert.equal(loaded.sessions[0]!.draft.input, 'newer draft');
    const serialized = store.getItem('cli-jaw:code-drafts:v1')!;
    assert.equal(loaded.sessions[0]!.draft.selection.permissionMode, 'auto');
    for (const excluded of ['permissionOperations', 'nativeCursor', 'transcript', 'token', 'private error', 'opaque choice']) assert.equal(serialized.includes(excluded), false);
    assert.equal(loadCodeDraftStorage(store, 'http://127.0.0.1:3458').data, null);
});

test('pending creation is checkpointed as uncertain and corrupt/version-mismatched payloads never become commands', () => {
    const store = storage(), draftBook = book(store);
    draftBook.fresh.input = 'keep exact\ntext'; draftBook.fresh.operation.kind = 'creating';
    saveCodeDraftStorage(store, draftBook.endpoint, draftBook);
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data!.fresh.creating, true);
    for (const raw of ['{broken', '{"version":99,"endpoints":[]}', '{"version":1,"endpoints":[null]}']) {
        store.setItem('cli-jaw:code-drafts:v1', raw);
        const loaded = loadCodeDraftStorage(store, draftBook.endpoint);
        assert.equal(loaded.data, null); assert.ok(loaded.warning);
    }
});

test('oversize input keeps its full RAM value, bounds stored data, and records an incomplete-recovery warning for reload', () => {
    const store = storage(), draftBook = book(store);
    draftBook.fresh.input = 'last checkpoint'; saveCodeDraftStorage(store, draftBook.endpoint, draftBook);
    draftBook.fresh.input = 'x'.repeat(300 * 1024);
    assert.match(saveCodeDraftStorage(store, draftBook.endpoint, draftBook)!, /incomplete/);
    assert.equal(draftBook.fresh.input.length, 300 * 1024);
    const loaded = loadCodeDraftStorage(store, draftBook.endpoint);
    assert.equal(loaded.data!.fresh.input, 'last checkpoint');
    assert.match(loaded.warning!, /not saved for reload/);
    assert.ok(store.getItem('cli-jaw:code-drafts:v1')!.length < 2 * 1024 * 1024);
});

test('quota/read failures are handled without erasing RAM or pretending persistence succeeded', () => {
    const store = storage(), draftBook = book(store);
    draftBook.fresh.input = 'unsaved';
    store.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    assert.match(saveCodeDraftStorage(store, draftBook.endpoint, draftBook)!, /unavailable/);
    assert.equal(draftBook.fresh.input, 'unsaved');
    store.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    assert.ok(loadCodeDraftStorage(store, draftBook.endpoint).warning);
});

test('per-tab storage remains bounded across sessions and endpoints', () => {
    const store = storage();
    for (let endpoint = 0; endpoint < 8; endpoint++) {
        const draftBook = book(store, `http://127.0.0.1:${4000 + endpoint}`);
        for (let id = 0; id < 40; id++) {
            const draft = createCodeDraft(draftBook.fresh.selection); draft.input = `draft ${id}`;
            draftBook.sessions.set(String(id), draft);
        }
        draftBook.selectedId = '39';
        assert.ok(saveCodeDraftStorage(store, draftBook.endpoint, draftBook));
        const restored = loadCodeDraftStorage(store, draftBook.endpoint).data!;
        assert.equal(restored.selectedId, '39'); assert.equal(restored.sessions.length, 32);
    }
    const envelope = JSON.parse(store.getItem('cli-jaw:code-drafts:v1')!);
    assert.equal(envelope.endpoints.length, 4);
    assert.ok(store.getItem('cli-jaw:code-drafts:v1')!.length <= 2 * 1024 * 1024);
});

test('oversized model preserves both endpoints and warns without poisoning the next save', () => {
    const store = storage(), first = book(store), other = book(store, 'http://127.0.0.1:3458');
    first.fresh.input = 'saved first draft';
    first.fresh.selection.model = 'm'.repeat(1024);
    other.fresh.input = 'saved other draft';
    assert.equal(saveCodeDraftStorage(store, first.endpoint, first), null);
    assert.equal(saveCodeDraftStorage(store, other.endpoint, other), null);
    const checkpoint = store.getItem('cli-jaw:code-drafts:v1');

    first.fresh.input = 'unsaved new text';
    first.fresh.selection.model = 'm'.repeat(1025);
    assert.match(saveCodeDraftStorage(store, first.endpoint, first)!, /incomplete/);
    assert.equal(store.getItem('cli-jaw:code-drafts:v1'), checkpoint);
    assert.equal(first.fresh.selection.model.length, 1025);
    const restored = loadCodeDraftStorage(store, first.endpoint);
    assert.equal(restored.data!.fresh.input, 'saved first draft');
    assert.equal(restored.data!.fresh.selection.model.length, 1024);
    assert.match(restored.warning!, /not saved for reload/);
    assert.equal(loadCodeDraftStorage(store, other.endpoint).data!.fresh.input, 'saved other draft');

    other.fresh.input = 'updated other draft';
    assert.equal(saveCodeDraftStorage(store, other.endpoint, other), null);
    assert.equal(loadCodeDraftStorage(store, first.endpoint).data!.fresh.input, 'saved first draft');
    assert.ok(loadCodeDraftStorage(store, first.endpoint).warning);
    assert.equal(loadCodeDraftStorage(store, other.endpoint).data!.fresh.input, 'updated other draft');
});

test('invalid background draft fields retain the previous complete checkpoint', () => {
    const store = storage(), draftBook = book(store);
    const background = createCodeDraft(draftBook.fresh.selection);
    background.input = 'background draft';
    draftBook.sessions.set('background', background);
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    const checkpoint = store.getItem('cli-jaw:code-drafts:v1');
    background.selection.cwd = '/'.repeat(4097);
    assert.match(saveCodeDraftStorage(store, draftBook.endpoint, draftBook)!, /incomplete/);
    assert.equal(store.getItem('cli-jaw:code-drafts:v1'), checkpoint);
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data!.sessions[0]!.draft.selection.cwd, '/workspace');
});

test('Claude permission modes round-trip in a stored draft; unknown modes still drop it', () => {
    const store = storage(), draftBook = book(store);
    draftBook.fresh = createCodeDraft({ provider: 'claude', cwd: '/workspace', model: 'model', effort: null, permissionMode: 'plan' });
    draftBook.fresh.input = 'plan this';
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data!.fresh.selection.permissionMode, 'plan');
    const raw = JSON.parse(store.getItem(store.key(0)!)!);
    const swap = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace('"plan"', '"yolo"'));
    store.setItem(store.key(0)!, JSON.stringify(swap(raw)));
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data?.fresh.selection.permissionMode === 'yolo', false);
});

test('a Claude thinking switch round-trips in a stored draft; a non-boolean drops it', () => {
    const store = storage(), draftBook = book(store);
    draftBook.fresh = createCodeDraft({ provider: 'claude', cwd: '/workspace', model: 'model', effort: null, permissionMode: 'ask', thinking: false });
    draftBook.fresh.input = 'think less';
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data!.fresh.selection.thinking, false);
    const raw = JSON.parse(store.getItem(store.key(0)!)!);
    store.setItem(store.key(0)!, JSON.stringify(raw).replace('"thinking":false', '"thinking":"no"'));
    assert.equal(loadCodeDraftStorage(store, draftBook.endpoint).data, null);
    draftBook.fresh = createCodeDraft({ provider: 'claude', cwd: '/workspace', model: 'model', effort: null, permissionMode: 'ask' });
    draftBook.fresh.input = 'older draft';
    saveCodeDraftStorage(store, draftBook.endpoint, draftBook);
    assert.equal('thinking' in loadCodeDraftStorage(store, draftBook.endpoint).data!.fresh.selection, false);
});

test('an in-flight follow-up is never checkpointed: a reload cannot resend it or resurrect its owner', () => {
    const store = storage(), draftBook = book(store);
    const draft = createCodeDraft(draftBook.fresh.selection);
    assert.equal(draft.steer, null);
    draft.input = 'kept draft'; draft.edit = 3;
    draft.steer = { key: 'steer-key', text: 'follow-up text', edit: 3, turnId: 'turn-steer', epoch: 7, state: 'unknown' };
    draftBook.sessions.set('s', draft); draftBook.selectedId = 's';
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    const serialized = store.getItem('cli-jaw:code-drafts:v1')!;
    for (const excluded of ['steer', 'follow-up text', 'turn-steer']) assert.equal(serialized.includes(excluded), false);
    const loaded = loadCodeDraftStorage(store, draftBook.endpoint).data!;
    assert.equal(loaded.sessions[0]!.draft.input, 'kept draft');
    assert.equal(loaded.sessions[0]!.draft.retry, null);
});

test('a rolled-back retry keeps its reason across reload; an unknown reason falls back to the spent-key copy', () => {
    const store = storage(), draftBook = book(store);
    const draft = createCodeDraft(draftBook.fresh.selection);
    draft.retry = { text: 'third prompt', key: 'new-key', edit: 0, resend: true, resendReason: 'rolled-back' };
    draftBook.sessions.set('s', draft); draftBook.selectedId = 's';
    assert.equal(saveCodeDraftStorage(store, draftBook.endpoint, draftBook), null);
    assert.deepEqual(loadCodeDraftStorage(store, draftBook.endpoint).data!.sessions[0]!.draft.retry,
        { text: 'third prompt', key: 'new-key', edit: 0, resend: true, resendReason: 'rolled-back' });
    const raw = store.getItem('cli-jaw:code-drafts:v1')!;
    store.setItem('cli-jaw:code-drafts:v1', raw.replace('"resendReason":"rolled-back"', '"resendReason":"elsewhere"'));
    assert.deepEqual(loadCodeDraftStorage(store, draftBook.endpoint).data!.sessions[0]!.draft.retry,
        { text: 'third prompt', key: 'new-key', edit: 0, resend: true });
    draft.retry = { text: 'unsent', key: 'k', edit: 0, resendReason: 'rolled-back' };
    saveCodeDraftStorage(store, draftBook.endpoint, draftBook);
    assert.deepEqual(loadCodeDraftStorage(store, draftBook.endpoint).data!.sessions[0]!.draft.retry, { text: 'unsent', key: 'k', edit: 0 },
        'a reason means nothing without a spent key');
});


test('creation and attach Stop identities round-trip, while malformed identities are rejected', () => {
    const store = storage(), b = book(store);
    b.fresh.operation.kind = 'creating'; b.fresh.creationKey = 'create-key_1';
    const d = createCodeDraft(b.fresh.selection);
    d.stopTarget = { turnId: null, operationId: 'op', epoch: 2, outcome: 'unknown' };
    b.sessions.set('s', d); b.selectedId = 's';
    assert.equal(saveCodeDraftStorage(store, b.endpoint, b), null);
    const saved = loadCodeDraftStorage(store, b.endpoint).data!;
    assert.equal(saved.fresh.creationKey, 'create-key_1');
    assert.deepEqual(saved.sessions[0]!.draft.stop, { turnId: null, operationId: 'op', epoch: 2 });
    const raw = JSON.parse(store.getItem('cli-jaw:code-drafts:v1')!);
    raw.endpoints[0].fresh.creationKey = 'bad/key';
    store.setItem('cli-jaw:code-drafts:v1', JSON.stringify(raw));
    assert.equal(loadCodeDraftStorage(store, b.endpoint).data, null);
    raw.endpoints[0].fresh.creationKey = 'valid'; raw.endpoints[0].sessions[0].draft.stop.turnId = 'turn';
    store.setItem('cli-jaw:code-drafts:v1', JSON.stringify(raw));
    assert.equal(loadCodeDraftStorage(store, b.endpoint).data, null);
});
