import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { CodeContextUsage, CodeItem, CodeModelCatalog, CodePermissionRequest, CodeSessionInfo, CodeSnapshot } from '../../src/code-mode/wire.ts';
import { loadCodeDraftStorage } from '../../public/manager/src/code/code-controller-draft-storage.ts';
import { CodeController } from '../../public/manager/src/code/code-controller-runtime.ts';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function session(id: string, patch: Partial<CodeSessionInfo> = {}): CodeSessionInfo {
    return { sessionId: id, provider: 'codex-app', cwd: `/workspace/${id}`, title: id, model: 'native-model', effort: null,
        permissionMode: 'ask', status: 'idle', turnId: null, epoch: 1, sequence: 3, revision: 2, archivedAt: null, error: null,
        resume: { available: true, reason: null }, capabilities: { resume: true, interrupt: true, permissions: true,
            setModelMidSession: false, efforts: ['medium', 'high'], permissionModes: ['ask', 'auto'] }, createdAt: 1, lastUsedAt: 2, lastTurnCompletedAt: null, lastVisitedAt: null, thinking: null, ...patch };
}
function snap(info: CodeSessionInfo, items: CodeItem[] = [], pendingPermissions: CodePermissionRequest[] = []): CodeSnapshot {
    return { session: info, items, sequence: info.sequence, pendingPermissions, truncated: false };
}
const catalog: CodeModelCatalog = { defaultProvider: 'codex-app', providers: ['codex-app', 'claude', 'cursor', 'grok'].map(id => ({
    id: id as CodeSessionInfo['provider'], label: id, available: true, reason: null, models: id === 'cursor' ? ['composer'] : ['native-model', 'other-model'],
    defaultModel: id === 'cursor' ? 'composer' : 'native-model', defaultEffort: id === 'cursor' ? null : 'medium', modelSource: 'native',
    capabilities: { resume: true, interrupt: true, permissions: id !== 'grok', setModelMidSession: false,
        efforts: id === 'cursor' ? [] : ['medium', 'high'], permissionModes: id === 'grok' ? ['auto'] : ['ask', 'auto'] },
})) };
let port = 51000;
function fixture(t: TestContext) {
    const savedFetch = globalThis.fetch;
    const calls: { path: string; method: string; body: Record<string, unknown>; url: URL }[] = [];
    const snapshots = new Map([['a', snap(session('a'))], ['b', snap(session('b'))]]);
    let intercept: ((call: typeof calls[number]) => Promise<Response> | Response | undefined) | undefined;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/api/code', '');
        const call = { path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, url };
        calls.push(call);
        const result = intercept?.(call);
        if (result) return result;
        if (path === '/models') return response({ ok: true, ...catalog });
        if (path === '/git-info') return response({ ok: true, isRepo: true, branch: url.searchParams.get('cwd'), worktrees: [] });
        if (path === '/sessions' && call.method === 'GET') return response({ ok: true, sessions: [...snapshots.values()].map(s => s.session), limit: 100, nextCursor: null, hasMore: false });
        const id = path.split('/')[2] ?? '';
        const snapshot = snapshots.get(id);
        // Read receipts are counted separately (visits()); they never change a session's turn state.
        if (snapshot && path.endsWith('/visit') && call.method === 'POST') {
            return response({ ok: true, session: { ...snapshot.session, lastVisitedAt: Date.now() } });
        }
        if (snapshot && path.endsWith('/events')) return response({ ok: true, events: [], nextSequence: snapshot.sequence, throughSequence: snapshot.sequence, hasMore: false });
        if (snapshot && call.method === 'GET') return response({ ok: true, ...snapshot });
        throw new Error(`Unhandled fixture request ${call.method} ${path}`);
    };
    const options = { port: port++, workingDir: '/workspace/new' };
    const controller = new CodeController(options);
    const cleanups = [controller.mount()];
    t.after(() => { for (const cleanup of cleanups) cleanup(); globalThis.fetch = savedFetch; });
    return { controller, options, snapshots, calls, cleanups,
        intercept(fn: NonNullable<typeof intercept>) { intercept = fn; },
        posts() { return calls.filter(call => call.method === 'POST' && !call.path.endsWith('/visit')); },
        visits() { return calls.filter(call => call.method === 'POST' && call.path.endsWith('/visit')); },
    };
}
function until(controller: CodeController, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise(resolve => { const unsubscribe = controller.subscribe(() => { if (predicate()) { unsubscribe(); resolve(); } }); });
}

test('catalog defaults use native model, nullable effort and explicit capability-backed policy', async t => {
    const f = fixture(t); await f.controller.refresh();
    assert.equal(f.controller.getModel().selection.model, 'native-model');
    assert.equal(f.controller.getModel().selection.effort, null);
    await f.controller.setSelection({ provider: 'cursor' });
    assert.equal(f.controller.getModel().selection.model, 'composer');
    assert.equal(f.controller.getModel().selection.effort, null);
    await f.controller.setSelection({ provider: 'grok' });
    assert.equal(f.controller.getModel().selection.permissionMode, 'auto');
    f.controller.setInput('preserved new draft');
    await f.controller.selectSession('a');
    f.controller.setInput('A draft');
    f.controller.newSession();
    assert.equal(f.controller.getModel().input, 'preserved new draft');
    f.controller.newSession();
    assert.equal(f.controller.getModel().input, 'preserved new draft');
    assert.equal(f.posts().length, 0);
});

test('delayed A snapshot and git result cannot paint B or move selection', async t => {
    const f = fixture(t); await f.controller.refresh();
    const delayed = deferred<Response>();
    f.intercept(call => call.path === '/sessions/a' ? delayed.promise : undefined);
    const selectingA = f.controller.selectSession('a');
    f.controller.setInput('draft A');
    await f.controller.selectSession('b');
    f.controller.setInput('draft B');
    delayed.resolve(response({ ok: true, ...snap(session('a'), [{ itemId: 'a-answer', firstSequence: 1, turnId: null,
        kind: 'assistant_message', status: 'done', text: 'A only', createdAt: 1, updatedAt: 1 }]) }));
    await selectingA;
    assert.equal(f.controller.getModel().selectedId, 'b');
    assert.equal(f.controller.getModel().input, 'draft B');
    assert.deepEqual(f.controller.getModel().items, []);
    assert.equal(f.controller.getModel().gitInfo?.branch, '/workspace/b');
    assert.equal(f.posts().length, 0);
});

test('unknown send retains original key/text; reconnect never retries and an explicit retry preserves later edits', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('original text');
    const sending = f.controller.send();
    f.controller.setInput('edited follow-up');
    pending.reject(new TypeError('connection dropped'));
    await sending;
    const original = f.posts()[0]!;
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send');
    assert.equal(f.controller.getModel().retryText, 'original text');
    assert.equal(f.controller.getModel().input, 'edited follow-up');
    f.controller.onTransport('connected');
    await f.controller.refresh();
    assert.equal(f.posts().length, 1);
    await f.controller.send();
    assert.equal(f.posts().length, 1);
    f.intercept(call => call.path.endsWith('/prompt') ? response({ ok: true, turnId: 't', clientTurnKey: call.body['clientTurnKey'], sequence: 3, status: 'completed' }) : undefined);
    await f.controller.retrySameSend();
    assert.deepEqual(f.posts()[1]!.body, original.body);
    assert.equal(f.controller.getModel().input, 'edited follow-up');
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    await f.controller.send();
    assert.notEqual(f.posts()[2]!.body['clientTurnKey'], original.body['clientTurnKey']);
});

test('committed user key resolves HTTP acknowledgement loss without clearing a later draft', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('accepted'); const sending = f.controller.send();
    f.controller.setInput('new edit');
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    const user: CodeItem = { itemId: 'user', firstSequence: 4, turnId: 'turn', kind: 'user_message', status: 'done',
        text: 'accepted', clientTurnKey: key, createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', snap(session('a', { sequence: 4 }), [user]));
    f.controller.onEvent({ topic: 'code', event: 'code_item', sessionId: 'a', sequence: 4, epoch: 1, item: user });
    pending.reject(new TypeError('response lost'));
    await sending;
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    assert.equal(f.controller.getModel().retryText, null);
    assert.equal(f.controller.getModel().input, 'new edit');
    assert.equal(f.posts().length, 1);
});

test('create admission captures original selection; late create never jumps from another session', async t => {
    const f = fixture(t); await f.controller.refresh();
    const creating = deferred<Response>();
    f.intercept(call => {
        if (call.path === '/sessions' && call.method === 'POST') return creating.promise;
        if (call.path.endsWith('/prompt')) return response({ ok: true, turnId: 't', clientTurnKey: call.body['clientTurnKey'], sequence: 3, status: 'completed' });
        return undefined;
    });
    f.controller.setInput('original new'); const sending = f.controller.send();
    f.controller.setInput('newer edit');
    await f.controller.selectSession('b'); f.controller.setInput('B stays');
    const created = session('created'); f.snapshots.set('created', snap(created));
    creating.resolve(response({ ok: true, session: created }, 201));
    await sending;
    assert.equal(f.controller.getModel().selectedId, 'b');
    assert.equal(f.controller.getModel().input, 'B stays');
    assert.equal(f.posts()[1]!.body['text'], 'original new');
    await f.controller.selectSession('created');
    assert.equal(f.controller.getModel().input, 'newer edit');
    assert.equal(f.posts()[0]!.body['cwd'], '/workspace/new');
});

test('late send completion after remount preserves newer edits and endpoint separation', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('before unmount'); const sending = f.controller.send();
    f.cleanups[0]!();
    const remounted = new CodeController(f.options); f.cleanups.push(remounted.mount());
    await remounted.refresh(); remounted.setInput('after remount');
    const other = new CodeController({ ...f.options, port: port++ }); f.cleanups.push(other.mount()); await other.refresh();
    other.setInput('other endpoint');
    const key = f.posts()[0]!.body['clientTurnKey'];
    pending.resolve(response({ ok: true, turnId: 't', clientTurnKey: key, sequence: 3, status: 'completed' }));
    await sending;
    assert.equal(remounted.getModel().input, 'after remount');
    assert.equal(remounted.getModel().operation.kind, 'idle');
    assert.equal(other.getModel().input, 'other endpoint');
    assert.equal(other.getModel().selectedId, null);
});

test('idle PATCH carries expectedRevision and accepted tuple; conflict cannot affect selected B', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.method === 'PATCH' ? pending.promise : undefined);
    const changing = f.controller.setSelection({ effort: 'high' });
    assert.deepEqual(f.calls.find(call => call.method === 'PATCH')!.body,
        { expectedRevision: 2, model: 'native-model', effort: 'high', permissionMode: 'ask' });
    await f.controller.selectSession('b'); f.controller.setInput('B edit');
    const revised = session('a', { revision: 9, model: 'remote-model' }); f.snapshots.set('a', snap(revised));
    pending.resolve(response({ ok: false, error: 'revision_conflict', session: revised }, 409)); await changing;
    assert.equal(f.controller.getModel().selectedId, 'b');
    assert.equal(f.controller.getModel().error, null);
    assert.equal(f.controller.getModel().input, 'B edit');
    await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().selection.model, 'remote-model');
    assert.match(f.controller.getModel().operation.error!, /changed elsewhere/);
});

test('permission requests have independent pending/error state and real stale-option recovery', async t => {
    const f = fixture(t);
    const permission = (id: string): CodePermissionRequest => ({ permissionId: id, sessionId: 'a', turnId: 't', epoch: 1,
        title: 'Write', detail: 'file', requestedAt: 1, options: [{ optionId: `opaque:${id}`, label: 'Allow once', kind: 'approval' }] });
    const p1 = permission('p1'), p2 = permission('p2');
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' }), [], [p1, p2]));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const first = deferred<Response>();
    f.intercept(call => {
        if (call.path === '/permissions/p1') return first.promise;
        if (call.path === '/permissions/p2') return response({ ok: false, error: 'invalid_option' }, 409);
        return undefined;
    });
    const answering = f.controller.answer(p1, 'opaque:p1');
    assert.equal(f.controller.getModel().permissionOperations['p1']!.pending, true);
    await f.controller.answer(p2, 'opaque:p2');
    assert.equal(f.controller.getModel().permissionOperations['p1']!.pending, true);
    assert.equal(f.controller.getModel().permissionOperations['p2']!.pending, false);
    assert.match(f.controller.getModel().permissionOperations['p2']!.error!, /option/);
    assert.equal(f.posts().length, 2);
    first.resolve(response({ ok: false, error: 'request_not_current' }, 409)); await answering;
    assert.equal(f.controller.getModel().permissions.length, 2);
    assert.match(f.controller.getModel().permissionOperations['p1']!.error!, /no longer current/);
    assert.deepEqual(f.posts()[0]!.body, { sessionId: 'a', turnId: 't', epoch: 1, optionId: 'opaque:p1' });
});

test('transport open stays unsynchronized until snapshot and contiguous catch-up settle', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path === '/sessions/a' ? pending.promise : undefined);
    f.controller.onTransport('reconnecting');
    f.controller.onTransport('connected');
    assert.equal(f.controller.getModel().transport, 'connected');
    assert.equal(f.controller.getModel().synced, false);
    pending.resolve(response({ ok: true, ...f.snapshots.get('a')! }));
    await until(f.controller, () => f.controller.getModel().synced);
    assert.equal(f.posts().length, 0);
    assert.equal(f.controller.getModel().sessions.find(row => row.sessionId === 'b')!.pendingPermissionCount, undefined);
});

test('rename and archive reject row failures after recording the target error', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('b');
    f.intercept(call => call.method === 'PATCH' ? response({ ok: false, error: 'session_busy' }, 409) : undefined);
    await assert.rejects(f.controller.rename('a', 'unsaved title'), /busy/);
    assert.equal(f.controller.getModel().selectedId, 'b');
    assert.equal(f.controller.getModel().error, null);
    await f.controller.selectSession('a');
    assert.match(f.controller.getModel().operation.error!, /busy/);
    await assert.rejects(f.controller.archive('a', true), /busy/);
    assert.equal(f.controller.getModel().session?.archivedAt, null);
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('unknown creation remains frozen and is never automatically retried', async t => {
    const f = fixture(t); await f.controller.refresh();
    f.intercept(call => call.path === '/sessions' && call.method === 'POST' ? Promise.reject(new TypeError('lost create response')) : undefined);
    f.controller.setInput('keep this'); await f.controller.send();
    assert.equal(f.controller.getModel().operation.kind, 'creating');
    assert.equal(f.controller.getModel().input, 'keep this');
    await f.controller.setSelection({ cwd: '/changed' });
    assert.equal(f.controller.getModel().selection.cwd, '/workspace/new');
    await f.controller.refresh(); f.controller.newSession(); await f.controller.send();
    assert.equal(f.posts().length, 1);
});

test('Stop captures turn/epoch once and stays stopping until durable settlement', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/cancel') ? response({ ok: true, session: session('a', { status: 'stopping', turnId: 't', sequence: 4 }) }) : undefined);
    f.snapshots.set('a', snap(session('a', { status: 'stopping', turnId: 't', sequence: 4 })));
    await f.controller.stop(); await f.controller.stop();
    assert.deepEqual(f.posts()[0]!.body, { turnId: 't', epoch: 1 });
    assert.equal(f.posts().length, 1);
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    f.controller.onEvent({ topic: 'code', event: 'code_session', sessionId: 'a', sequence: 5, epoch: 1,
        session: session('a', { status: 'idle', sequence: 5 }) });
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    assert.equal(f.controller.getModel().busy, false);
});

test('snapshot capacity failure keeps authoritative Stop metadata without inventing history', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh();
    f.intercept(call => call.path === '/sessions/a' ? response({ ok: false, error: 'snapshot_limit' }, 413) : undefined);
    await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().session?.turnId, 't');
    assert.equal(f.controller.getModel().busy, true);
    assert.equal(f.controller.getModel().synced, false);
    assert.deepEqual(f.controller.getModel().items, []);
    assert.match(f.controller.getModel().error!, /snapshot limit/);
});

test('unloaded attention is read from the index without hydration; selected snapshot permissions take precedence', async t => {
    const f = fixture(t);
    f.snapshots.set('b', snap(session('b', { pendingPermissionCount: 2 })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().sessions.find(row => row.sessionId === 'b')!.pendingPermissionCount, 2);
    assert.equal(f.controller.getModel().session?.pendingPermissionCount, 0);
    assert.equal(f.calls.some(call => call.path === '/sessions/b'), false);
});

test('older HTTP materialized page racing live final cannot overwrite it or advance the live cursor', async t => {
    const f = fixture(t);
    const recent: CodeItem = { itemId: 'answer', firstSequence: 3, turnId: 't', kind: 'assistant_message', status: 'running',
        text: 'partial', createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', { ...snap(session('a'), [recent]), truncated: true });
    await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/items') ? pending.promise : undefined);
    const loading = f.controller.loadOlderHistory();
    f.controller.onEvent({ topic: 'code', event: 'code_item', sessionId: 'a', sequence: 4, epoch: 1,
        item: { ...recent, text: 'exact final', status: 'done', phase: 'final', updatedAt: 2 } });
    pending.resolve(response({ ok: true, items: [recent, { ...recent, itemId: 'older', firstSequence: 1, text: 'earlier' }],
        beforeSequence: 1, hasMore: false, sequence: 800 }));
    await loading;
    assert.deepEqual(f.controller.getModel().items.map(item => [item.itemId, item.text]), [['older', 'earlier'], ['answer', 'exact final']]);
    f.controller.onEvent({ topic: 'code', event: 'code_item', sessionId: 'a', sequence: 5, epoch: 1,
        item: { ...recent, itemId: 'next', firstSequence: 5, text: 'next message' } });
    assert.equal(f.controller.getModel().items[2]!.text, 'next message');
});

test('late picker and git responses are fenced by target and local workspace edits', async t => {
    const f = fixture(t); await f.controller.refresh();
    const pick = deferred<Response>(), git = deferred<Response>();
    f.intercept(call => {
        if (call.path === '/workspace/pick') return pick.promise;
        if (call.path === '/git-info' && call.url.searchParams.get('cwd') === '/workspace/edited') return git.promise;
        return undefined;
    });
    const picking = f.controller.pickWorkspace();
    const editing = f.controller.setSelection({ cwd: '/workspace/edited' });
    await f.controller.selectSession('b');
    pick.resolve(response({ ok: true, path: '/late/pick' }));
    git.resolve(response({ ok: true, isRepo: true, branch: 'late branch', worktrees: [] }));
    await Promise.all([picking, editing]);
    assert.equal(f.controller.getModel().gitInfo?.branch, '/workspace/b');
    f.controller.newSession();
    assert.equal(f.controller.getModel().selection.cwd, '/workspace/edited');
});

test('SSE compact updates received during a deferred snapshot are folded once after H', async t => {
    const f = fixture(t); await f.controller.refresh();
    const pending = deferred<Response>();
    f.intercept(call => call.path === '/sessions/a' ? pending.promise : undefined);
    const selecting = f.controller.selectSession('a');
    const append = { topic: 'code' as const, event: 'code_item_update' as const, sessionId: 'a', sequence: 4, epoch: 1,
        update: { itemId: 'answer', turnId: 't', firstSequence: 3, updatedAt: 4, appendText: 'B' } };
    f.controller.onEvent(append); f.controller.onEvent(append);
    assert.equal(f.controller.getModel().synced, false);
    const before = snap(session('a'), [{ itemId: 'answer', firstSequence: 3, turnId: 't', kind: 'assistant_message',
        status: 'running', text: 'A', createdAt: 1, updatedAt: 1 }]);
    f.snapshots.set('a', snap(session('a', { sequence: 4 }), [{ ...before.items[0]!, text: 'AB', updatedAt: 4 }]));
    pending.resolve(response({ ok: true, ...before }));
    await selecting;
    assert.equal(f.controller.getModel().items[0]!.text, 'AB');
    assert.equal(f.controller.getModel().synced, true);
    assert.equal(f.posts().length, 0);
});

test('idle model and effort PATCH remain available when hot switching is unsupported', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().session!.capabilities.setModelMidSession, false);
    f.intercept(call => {
        if (call.method !== 'PATCH') return undefined;
        const revised = session('a', { model: String(call.body['model']), effort: String(call.body['effort']), revision: 3, sequence: 4 });
        f.snapshots.set('a', snap(revised));
        return response({ ok: true, session: revised });
    });
    await f.controller.setSelection({ model: 'other-model', effort: 'high' });
    assert.deepEqual(f.calls.find(call => call.method === 'PATCH')!.body,
        { expectedRevision: 2, model: 'other-model', effort: 'high', permissionMode: 'ask' });
    assert.equal(f.controller.getModel().selection.model, 'other-model');
    assert.equal(f.controller.getModel().selection.effort, 'high');
    f.snapshots.set('a', snap(session('a', { sequence: 5, status: 'streaming', turnId: 't' })));
    await f.controller.refresh();
    await f.controller.setSelection({ model: 'native-model', effort: 'medium' });
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('initial and changed-provider effort stay null despite a medium catalog default; explicit valid choice survives refresh', async t => {
    const f = fixture(t); await f.controller.refresh();
    assert.equal(f.controller.getModel().catalog!.providers.find(p => p.id === 'codex-app')!.defaultEffort, 'medium');
    assert.equal(f.controller.getModel().selection.effort, null);
    await f.controller.setSelection({ effort: 'high' });
    await f.controller.refresh();
    assert.equal(f.controller.getModel().selection.effort, 'high');
    await f.controller.setSelection({ provider: 'claude' });
    assert.equal(f.controller.getModel().selection.effort, null);
    await f.controller.setSelection({ effort: 'medium' });
    await f.controller.refresh();
    assert.equal(f.controller.getModel().selection.effort, 'medium');
    await f.controller.setSelection({ provider: 'cursor' });
    assert.equal(f.controller.getModel().selection.effort, null);
    await f.controller.setSelection({ provider: 'codex-app' });
    assert.equal(f.controller.getModel().selection.effort, null);
});

test('explicit creation recovery preserves current text and warns of the possible original without creating or sending', async t => {
    const f = fixture(t); await f.controller.refresh();
    f.intercept(call => call.path === '/sessions' && call.method === 'POST' ? Promise.reject(new TypeError('response lost')) : undefined);
    f.controller.setInput('original'); await f.controller.send();
    f.controller.setInput('edited after loss');
    assert.equal(f.controller.getModel().creationUnknown, true);
    await f.controller.refresh(); f.controller.newSession();
    assert.equal(f.controller.getModel().creationUnknown, true);
    assert.equal(f.posts().length, 1);
    f.controller.startAnotherSession();
    assert.equal(f.controller.getModel().creationUnknown, false);
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    assert.equal(f.controller.getModel().input, 'edited after loss');
    assert.equal(f.controller.getModel().selection.cwd, '/workspace/new');
    assert.match(f.controller.getModel().error!, /original session may still exist/i);
    await f.controller.refresh();
    assert.equal(f.posts().length, 1);
    f.intercept(call => {
        if (call.path === '/sessions' && call.method === 'POST') {
            const created = session('second'); f.snapshots.set('second', snap(created));
            return response({ ok: true, session: created }, 201);
        }
        if (call.path.endsWith('/prompt')) return response({ ok: true, turnId: 'new-turn', clientTurnKey: call.body['clientTurnKey'], sequence: 3, status: 'accepted' }, 202);
        return undefined;
    });
    await f.controller.send();
    assert.equal(f.posts().filter(call => call.path === '/sessions').length, 2);
    assert.equal(f.posts().filter(call => call.path.endsWith('/prompt')).length, 1);
    assert.equal(f.posts().at(-1)!.body['text'], 'edited after loss');
});

test('failed Stop waits for a fresh snapshot then permits only an explicit retry of the same turn and epoch', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const cancel = deferred<Response>(), reread = deferred<Response>(), readStarted = deferred<void>();
    let holdRead = true, cancels = 0;
    f.intercept(call => {
        if (call.path.endsWith('/cancel')) {
            if (++cancels === 1) return cancel.promise;
            const stopping = session('a', { status: 'stopping', turnId: 't', sequence: 4 });
            f.snapshots.set('a', snap(stopping)); return response({ ok: true, session: stopping });
        }
        if (call.path === '/sessions/a' && holdRead) { holdRead = false; readStarted.resolve(undefined); return reread.promise; }
        return undefined;
    });
    const stopping = f.controller.stop();
    cancel.reject(new TypeError('cancel response lost'));
    await readStarted.promise;
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    await f.controller.stop();
    assert.equal(cancels, 1);
    reread.resolve(response({ ok: true, ...f.snapshots.get('a')! })); await stopping;
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    assert.equal(f.controller.getModel().busy, true);
    assert.match(f.controller.getModel().operation.error!, /Press Stop to retry/);
    f.controller.onTransport('connected'); await f.controller.refresh();
    assert.equal(cancels, 1);
    await f.controller.stop();
    assert.equal(cancels, 2);
    assert.deepEqual(f.posts().filter(call => call.path.endsWith('/cancel')).map(call => call.body),
        [{ turnId: 't', epoch: 1 }, { turnId: 't', epoch: 1 }]);
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    await f.controller.stop(); assert.equal(cancels, 2);
});

test('lost cancel acknowledged as stopping by snapshot is not made retryable', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => {
        if (!call.path.endsWith('/cancel')) return undefined;
        f.snapshots.set('a', snap(session('a', { status: 'stopping', turnId: 't', sequence: 4 })));
        return Promise.reject(new TypeError('lost response'));
    });
    await f.controller.stop();
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    assert.equal(f.controller.getModel().operation.error, null);
    await f.controller.refresh(); await f.controller.stop();
    assert.equal(f.posts().length, 1);
});

test('a snapshot started before the failed cancel cannot unlock Stop retry', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const oldRead = deferred<Response>(), freshRead = deferred<Response>(), freshStarted = deferred<void>();
    let reads = 0;
    f.intercept(call => {
        if (call.path === '/sessions/a') {
            if (++reads === 1) return oldRead.promise;
            freshStarted.resolve(undefined); return freshRead.promise;
        }
        if (call.path.endsWith('/cancel')) return Promise.reject(new TypeError('cancel failed'));
        return undefined;
    });
    const refreshing = f.controller.refresh();
    const stopping = f.controller.stop();
    await until(f.controller, () => !!f.controller.getModel().operation.error);
    oldRead.resolve(response({ ok: true, ...f.snapshots.get('a')! }));
    await freshStarted.promise;
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    await f.controller.stop(); assert.equal(f.posts().length, 1);
    freshRead.resolve(response({ ok: true, ...f.snapshots.get('a')! }));
    await Promise.all([refreshing, stopping]);
    assert.equal(f.controller.getModel().operation.kind, 'idle');
    assert.match(f.controller.getModel().operation.error!, /same turn is still running/);
});

function browserDraftStorage(t: TestContext) {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const values = new Map<string, string>();
    const wrap = (): Storage => ({ get length() { return values.size; }, clear: () => values.clear(),
        key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
    let current = wrap();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        location: { origin: 'http://127.0.0.1:0', port: '0' }, get sessionStorage() { return current; },
    } });
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    });
    return {
        checkpoint: () => new Map(values),
        reload(saved = new Map(values)) { values.clear(); for (const [key, value] of saved) values.set(key, value); current = wrap(); },
        saved: (endpoint: string) => loadCodeDraftStorage(current, endpoint).data!,
    };
}

test('a fresh tab storage object restores exact new/session drafts and choices with no server cache', async t => {
    const browser = browserDraftStorage(t), f = fixture(t); await f.controller.refresh();
    await f.controller.setSelection({ effort: 'medium', permissionMode: 'auto' });
    f.controller.setInput('new draft\n  trailing ');
    await f.controller.selectSession('a'); f.controller.setInput('session A draft');
    const saved = browser.checkpoint();
    f.cleanups[0]!(); f.cleanups[0] = () => {};
    browser.reload(saved);
    const restored = new CodeController(f.options);
    assert.equal(restored.getModel().input, 'session A draft');
    assert.equal(restored.getModel().session, null);
    assert.equal(restored.getModel().synced, false);
    assert.deepEqual(restored.getModel().items, []);
    f.cleanups.push(restored.mount()); await restored.refresh();
    restored.newSession();
    assert.equal(restored.getModel().input, 'new draft\n  trailing ');
    assert.equal(restored.getModel().selection.effort, 'medium');
    assert.equal(restored.getModel().selection.permissionMode, 'auto');
    const other = new CodeController({ ...f.options, port: port++ }); f.cleanups.push(other.mount()); await other.refresh();
    assert.equal(other.getModel().input, '');
    assert.equal(f.posts().length, 0);
});

test('create intent is stored before HTTP and restores as creationUnknown without replaying create', async t => {
    const browser = browserDraftStorage(t), f = fixture(t); await f.controller.refresh();
    const pending = deferred<Response>();
    f.intercept(call => {
        if (call.path !== '/sessions' || call.method !== 'POST') return undefined;
        assert.equal(browser.saved(`http://127.0.0.1:${f.options.port}`).fresh.creating, true);
        return pending.promise;
    });
    f.controller.setInput('create original'); const creating = f.controller.send();
    f.controller.setInput('create newer edit'); const saved = browser.checkpoint();
    pending.reject(new TypeError('old page disposed')); await creating;
    f.cleanups[0]!(); f.cleanups[0] = () => {}; browser.reload(saved);
    const restored = new CodeController(f.options); f.cleanups.push(restored.mount()); await restored.refresh();
    assert.equal(restored.getModel().creationUnknown, true);
    assert.equal(restored.getModel().input, 'create newer edit');
    restored.onTransport('connected'); await restored.refresh(); await restored.send();
    assert.equal(f.posts().length, 1);
    restored.startAnotherSession();
    assert.equal(restored.getModel().creationUnknown, false);
    assert.equal(restored.getModel().input, 'create newer edit');
    assert.equal(f.posts().length, 1);
});

test('send key is stored before HTTP and reload reconciles a committed key without resending or clearing newer text', async t => {
    const browser = browserDraftStorage(t), f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => {
        if (!call.path.endsWith('/prompt')) return undefined;
        assert.equal(browser.saved(`http://127.0.0.1:${f.options.port}`).sessions[0].draft.retry.key, call.body['clientTurnKey']);
        assert.equal(browser.saved(`http://127.0.0.1:${f.options.port}`).sessions[0].draft.retry.text, 'original message');
        return pending.promise;
    });
    f.controller.setInput('original message'); const sending = f.controller.send();
    f.controller.setInput('later draft'); const saved = browser.checkpoint();
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    pending.reject(new TypeError('old page disposed')); await sending;
    f.cleanups[0]!(); f.cleanups[0] = () => {}; browser.reload(saved);
    const restored = new CodeController(f.options); f.cleanups.push(restored.mount()); await restored.refresh();
    assert.equal(restored.getModel().operation.kind, 'unknown-send');
    assert.equal(restored.getModel().retryText, 'original message');
    assert.equal(restored.getModel().input, 'later draft');
    await restored.send(); restored.onTransport('connected'); await restored.refresh();
    assert.equal(f.posts().length, 1);
    const accepted: CodeItem = { itemId: 'accepted', firstSequence: 4, turnId: 't', kind: 'user_message', status: 'done',
        text: 'original message', clientTurnKey: key, createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', snap(session('a', { sequence: 4 }), [accepted]));
    await restored.refresh();
    assert.equal(restored.getModel().operation.kind, 'idle');
    assert.equal(restored.getModel().input, 'later draft');
    assert.equal(f.posts().length, 1);
});

test('reloaded in-flight Stop stays captured and reconciles through reads without a cancellation retry', async t => {
    const browser = browserDraftStorage(t), f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'streaming', turnId: 't' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/cancel') ? pending.promise : undefined);
    const stopping = f.controller.stop(); const saved = browser.checkpoint();
    assert.deepEqual(browser.saved(`http://127.0.0.1:${f.options.port}`).sessions[0].draft.stop, { turnId: 't', epoch: 1 });
    pending.reject(new TypeError('old page disposed')); await stopping;
    f.cleanups[0]!(); f.cleanups[0] = () => {}; browser.reload(saved);
    const restored = new CodeController(f.options);
    assert.equal(restored.getModel().operation.kind, 'stopping');
    f.cleanups.push(restored.mount()); await restored.refresh();
    assert.equal(restored.getModel().operation.kind, 'idle');
    assert.match(restored.getModel().operation.error!, /Press Stop to retry/);
    assert.equal(f.posts().length, 1);
});

// --- #702: one owner for read-time-attached session meta ---
// contextUsage and pendingPermissionCount are attached at read time and never
// persisted, so only list and snapshot can speak for them. Everything else —
// stored code_session frames, and the create/patch/cancel/attach responses —
// carries neither, and newer() cannot tell "absent because reaped" from
// "absent because this payload could never carry it".
const usage = (totalTokens: number, updatedAt = 9): CodeContextUsage => ({ totalTokens, inputTokens: null,
    cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, processedTokens: null,
    modelContextWindow: 200_000, updatedAt });
const meter = (controller: CodeController) => controller.getModel().session?.contextUsage?.totalTokens;
const row = (controller: CodeController, id: string) => controller.getModel().sessions.find(entry => entry.sessionId === id);

test('a session event alone never blanks the meter, and the owning read still hides it on the same turn it stops reporting', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { contextUsage: usage(345) })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(meter(f.controller), 345);
    // A stored frame cannot carry usage. It must not be read as "the runtime reports none".
    f.controller.onEvent({ topic: 'code', event: 'code_session', sessionId: 'a', sequence: 4, epoch: 1,
        session: session('a', { sequence: 4 }) });
    assert.equal(meter(f.controller), 345, 'an SSE frame is not an observation of occupancy');
    assert.equal(row(f.controller, 'a')?.contextUsage?.totalTokens, 345, 'the sidebar follows the same observation');
    // Idle reap: the runtime is gone, so the owning reads stop attaching a figure.
    f.snapshots.set('a', snap(session('a', { sequence: 5 })));
    await f.controller.refresh();
    assert.equal(meter(f.controller), undefined, 'the read that owns the figure withdrew it');
    assert.equal(row(f.controller, 'a')?.contextUsage, undefined);
});

test('a metadata write that cannot observe the runtime does not blank a live meter', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { contextUsage: usage(345) })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(meter(f.controller), 345);
    // patch answers from the store, at a higher revision and with no overlay.
    f.intercept(call => call.method === 'PATCH'
        ? response({ ok: true, session: session('a', { title: 'renamed', revision: 9 }) }) : undefined);
    await f.controller.rename('a', 'renamed');
    assert.equal(f.controller.getModel().session?.title, 'renamed');
    assert.equal(meter(f.controller), 345, 'a rename is not evidence that the runtime stopped reporting');
});

test('ranking a listing never strips the figure off the row the owner just read', async t => {
    const f = fixture(t);
    // The fixture serves the same session object for the listing and the snapshot,
    // which is exactly the aliasing that an in-place strip would corrupt.
    const live = snap(session('a', { contextUsage: usage(1234) }));
    f.snapshots.set('a', live);
    await f.controller.refresh();
    assert.equal(live.session.contextUsage?.totalTokens, 1234, 'the caller object is left intact');
    assert.equal(row(f.controller, 'a')?.contextUsage?.totalTokens, 1234);
    await f.controller.selectSession('a');
    assert.equal(meter(f.controller), 1234);
});

test('loadMoreSessions continues the index from the server cursor without refetching the prefix', async t => {
    const f = fixture(t);
    const nextCursor = JSON.stringify({ createdAt: 3, sessionId: 's3' });
    f.intercept(call => {
        if (call.path !== '/sessions' || call.method !== 'GET') return undefined;
        if (call.url.searchParams.get('cursor') === null) {
            return response({ ok: true, sessions: ['s1', 's2', 's3'].map(id => session(id)),
                limit: 3, nextCursor, hasMore: true });
        }
        return response({ ok: true, sessions: ['s4', 's5'].map(id => session(id)),
            limit: 100, nextCursor: null, hasMore: false });
    });
    await f.controller.refresh();
    assert.equal(f.controller.getModel().hasMoreSessions, true);
    assert.deepEqual(f.controller.getModel().sessions.map(s => s.sessionId), ['s1', 's2', 's3']);
    await f.controller.loadMoreSessions();
    const page = f.calls.filter(call => call.path === '/sessions' && call.method === 'GET').at(-1)!;
    assert.equal(page.url.searchParams.get('cursor'), nextCursor);
    assert.deepEqual(f.controller.getModel().sessions.map(s => s.sessionId), ['s1', 's2', 's3', 's4', 's5']);
    assert.equal(f.controller.getModel().hasMoreSessions, false);
});

// --- #703: a spent clientTurnKey is a report, not an admission ---
// The server consumes a key once. After a restart seals the turn, the same key
// returns HTTP 200 with the stored status and starts nothing, and the orphaned
// turn's own user_message stays in history.

test('a duplicate receipt for a spent key does not close the send, and Retry then carries a key the server can admit', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('original message');
    const sending = f.controller.send();
    pending.reject(new TypeError('connection dropped'));
    await sending;
    const first = String(f.posts()[0]!.body['clientTurnKey']);
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send');
    f.intercept(call => call.path.endsWith('/prompt')
        ? response({ ok: true, turnId: 't', clientTurnKey: call.body['clientTurnKey'], sequence: 3, status: 'failed' }) : undefined);
    await f.controller.retrySameSend();
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send', 'a failed duplicate is not an admission');
    assert.match(f.controller.getModel().operation.error!, /not resent/);
    assert.equal(f.controller.getModel().retryText, 'original message', 'the message is kept');
    f.intercept(call => call.path.endsWith('/prompt')
        ? response({ ok: true, turnId: 'second', clientTurnKey: call.body['clientTurnKey'], sequence: 4, status: 'accepted' }) : undefined);
    await f.controller.retrySameSend();
    assert.notEqual(f.posts()[2]!.body['clientTurnKey'], first, 'the spent key is retired');
    assert.equal(f.posts()[2]!.body['text'], 'original message');
    assert.equal(f.controller.getModel().operation.kind, 'idle');
});

test('an orphaned turn does not acknowledge itself through its own transcript', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('original message');
    const sending = f.controller.send();
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    pending.reject(new TypeError('old page disposed'));
    await sending;
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send');
    // recoverInterrupted() seals the turn: the user message stays in history and a
    // turn_failed lands beside it. Matching the key alone would read that as success.
    const sent: CodeItem = { itemId: 't:user', firstSequence: 4, turnId: 't', kind: 'user_message', status: 'done',
        text: 'original message', clientTurnKey: key, createdAt: 1, updatedAt: 1 };
    const terminal: CodeItem = { itemId: 't:terminal', firstSequence: 5, turnId: 't', kind: 'turn_failed', status: 'done',
        createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', snap(session('a', { sequence: 5, status: 'failed', error: { code: 'orphaned_turn',
        message: 'Code turn interrupted by server restart', at: 1, recoverable: true } }), [sent, terminal]));
    f.intercept(() => undefined);
    await f.controller.refresh();
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send', 'the settled turn is not an acknowledgement');
    assert.match(f.controller.getModel().operation.error!, /not resent/);
    assert.equal(f.controller.getModel().retryText, 'original message');
    assert.equal(f.posts().length, 1, 'nothing was resent automatically');
});

test('a user message whose turn actually ran still acknowledges the send', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('original message');
    const sending = f.controller.send();
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    const sent: CodeItem = { itemId: 't:user', firstSequence: 4, turnId: 't', kind: 'user_message', status: 'done',
        text: 'original message', clientTurnKey: key, createdAt: 1, updatedAt: 1 };
    const finished: CodeItem = { itemId: 't:terminal', firstSequence: 5, turnId: 't', kind: 'turn_completed', status: 'done',
        createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', snap(session('a', { sequence: 5 }), [sent, finished]));
    pending.reject(new TypeError('response lost'));
    await sending;
    f.intercept(() => undefined);
    await f.controller.refresh();
    assert.equal(f.controller.getModel().operation.kind, 'idle', 'a turn that ran is a real acknowledgement');
    assert.equal(f.controller.getModel().retryText, null);
    assert.equal(f.posts().length, 1);
});

// --- after a re-key, nothing is in flight and the UI must stop saying otherwise ---

test('a re-keyed send stops claiming it might already be accepted, and shows the text once', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('original message');
    const sending = f.controller.send();
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    pending.reject(new TypeError('connection dropped'));
    await sending;
    // Before the server speaks, acceptance really is unknown and the old copy holds.
    assert.equal(f.controller.getModel().resendRequired, false);
    // The orphaned turn is in history, so the transcript already carries the text.
    const sent: CodeItem = { itemId: 't:user', firstSequence: 4, turnId: 't', kind: 'user_message', status: 'done',
        text: 'original message', clientTurnKey: key, createdAt: 1, updatedAt: 1 };
    const terminal: CodeItem = { itemId: 't:terminal', firstSequence: 5, turnId: 't', kind: 'turn_failed', status: 'done',
        createdAt: 1, updatedAt: 1 };
    f.snapshots.set('a', snap(session('a', { sequence: 5, status: 'failed' }), [sent, terminal]));
    f.intercept(() => undefined);
    await f.controller.refresh();
    assert.equal(f.controller.getModel().operation.kind, 'unknown-send');
    assert.equal(f.controller.getModel().resendRequired, true, 'the key is spent, so acceptance is known');
    const copies = f.controller.getModel().items.filter(item => item.kind === 'user_message' && item.text === 'original message');
    assert.equal(copies.length, 1, 'no second copy claiming to be in flight');
    assert.equal(copies[0]!.itemId, 't:user', 'the surviving copy is the real failed attempt');
    assert.equal(f.controller.getModel().retryText, 'original message', 'the strip still previews the text');
});

test('opening a session sends one read receipt and a visit failure never surfaces', async t => {
    const f = fixture(t); await f.controller.refresh();
    await f.controller.selectSession('a');
    await until(f.controller, () => f.visits().length === 1);
    assert.equal(f.visits()[0]?.path, '/sessions/a/visit');
    f.intercept(call => call.path.endsWith('/visit') ? response({ ok: false, error: { code: 'boom', message: 'boom' } }, 500) : undefined);
    await f.controller.selectSession('b');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.controller.getModel().error, null);
});

// ─── Working marker: from Send until this send's own turn ends ───

test('a send reads as working from the click until its own turn ends, not before', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/prompt') ? pending.promise : undefined);
    f.controller.setInput('do the thing');
    const sending = f.controller.send();
    assert.equal(f.controller.getModel().working, true, 'working before the HTTP receipt');
    assert.ok(f.controller.getModel().workingIds.has('a'));
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    pending.resolve(response({ ok: true, turnId: 't1', clientTurnKey: key, sequence: 4, status: 'accepted' }));
    await sending;
    assert.equal(f.controller.getModel().working, true, 'still working while the server has not reported the turn');

    // A later idle snapshot without this turn's end (e.g. a read-receipt echo) must not clear it.
    f.snapshots.set('a', snap(session('a', { sequence: 9, lastVisitedAt: 5 })));
    await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().working, true, 'an unrelated newer snapshot does not end the send');

    // The turn's own terminal item ends it.
    f.snapshots.set('a', snap(session('a', { sequence: 12 }), [
        { itemId: 'u1', turnId: 't1', kind: 'user_message', status: 'done', text: 'do the thing', clientTurnKey: key, createdAt: 1, updatedAt: 1, firstSequence: 10 },
        { itemId: 't1:terminal', turnId: 't1', kind: 'turn_completed', status: 'done', createdAt: 2, updatedAt: 2, firstSequence: 11 },
    ] as CodeItem[]));
    await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().working, false);
    assert.equal(f.controller.getModel().workingIds.has('a'), false);
});

test('a rejected send stops reading as working and keeps the text', async t => {
    const f = fixture(t); await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/prompt') ? response({ ok: false, error: 'session_busy' }, 409) : undefined);
    f.controller.setInput('keep me');
    await f.controller.send();
    assert.equal(f.controller.getModel().working, false);
    assert.equal(f.controller.getModel().input, 'keep me');
});

test('sending to a suspended session attaches it first, then sends', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'suspended' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => {
        if (call.path.endsWith('/attach')) {
            f.snapshots.set('a', snap(session('a', { status: 'idle', sequence: 5 })));
            return response({ ok: true, session: session('a', { status: 'idle', sequence: 5 }) });
        }
        if (call.path.endsWith('/prompt')) return response({ ok: true, turnId: 't', clientTurnKey: call.body['clientTurnKey'], sequence: 6, status: 'accepted' });
        return undefined;
    });
    f.controller.setInput('continue please');
    await f.controller.send();
    assert.deepEqual(f.posts().map(call => call.path), ['/sessions/a/attach', '/sessions/a/prompt']);
});

test('a failed attach sends nothing, surfaces the error and keeps the draft', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { status: 'suspended' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/attach') ? response({ ok: false, error: 'resume_unavailable' }, 409) : undefined);
    f.controller.setInput('continue please');
    await f.controller.send();
    assert.deepEqual(f.posts().map(call => call.path), ['/sessions/a/attach']);
    assert.ok(f.controller.getModel().operation.error);
    assert.equal(f.controller.getModel().input, 'continue please');
});

test('a Claude session PATCHes its thinking switch; a draft leaving Claude drops it', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(session('a', { provider: 'claude', thinking: true })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().selection.thinking, true);
    f.intercept(call => call.method === 'PATCH'
        ? response({ ok: true, session: session('a', { provider: 'claude', thinking: false, revision: 3 }) }) : undefined);
    await f.controller.setSelection({ thinking: false });
    assert.deepEqual(f.calls.find(call => call.method === 'PATCH')!.body,
        { expectedRevision: 2, model: 'native-model', effort: null, permissionMode: 'ask', thinking: false });
    await f.controller.setSelection({ effort: 'high' });
    assert.equal(f.calls.filter(call => call.method === 'PATCH').at(-1)!.body['thinking'], false, 'an effort change keeps the stored switch');
    f.controller.newSession();
    await f.controller.setSelection({ provider: 'claude' });
    await f.controller.setSelection({ thinking: false });
    assert.equal(f.controller.getModel().selection.thinking, false);
    await f.controller.setSelection({ provider: 'codex-app' });
    assert.equal('thinking' in f.controller.getModel().selection, false);
});

// Claude in-band follow-ups: a streaming Claude turn takes Send as a follow-up for its captured owner.
const streamingClaude = (patch: Partial<CodeSessionInfo> = {}) =>
    session('a', { provider: 'claude', status: 'streaming', turnId: 'turn-a', epoch: 4, thinking: true, ...patch });
const steerItem = (key: string, sequence: number): CodeItem => ({ itemId: `turn-a:steer:${key}`, turnId: 'turn-a', kind: 'user_message',
    status: 'done', text: 'also run the tests', clientTurnKey: key, createdAt: 1, updatedAt: 1, firstSequence: sequence });

test('busy Claude sends /steer for the captured turn; idle Claude sends /prompt; busy Codex sends neither', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude()));
    f.snapshots.set('b', snap(session('b', { status: 'streaming', turnId: 'turn-b' })));
    await f.controller.refresh(); await f.controller.selectSession('a');
    assert.equal(f.controller.getModel().followUp, true);
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/steer') ? pending.promise : undefined);
    f.controller.setInput('also run the tests');
    const sending = f.controller.send();
    assert.equal(f.controller.getModel().steering, true);
    await f.controller.send();
    assert.equal(f.posts().length, 1, 'Send is closed while the follow-up is in flight');
    f.controller.setInput('also run the tests, then lint');
    const posted = f.posts()[0]!;
    assert.equal(posted.path, '/sessions/a/steer');
    const key = String(posted.body['clientTurnKey']);
    assert.deepEqual(posted.body, { text: 'also run the tests', clientTurnKey: key, turnId: 'turn-a', epoch: 4 });
    f.snapshots.set('a', snap(streamingClaude({ sequence: 4 }), [steerItem(key, 4)]));
    pending.resolve(response({ ok: true, turnId: 'turn-a', clientTurnKey: key, sequence: 4, status: 'running' }, 202));
    await sending;
    assert.equal(f.controller.getModel().steering, false);
    assert.equal(f.controller.getModel().input, 'also run the tests, then lint', 'an edit made after capture survives the receipt');
    assert.equal(f.controller.getModel().synced, true);
    assert.equal(f.controller.getModel().operation.kind, 'idle');

    f.snapshots.set('a', snap(session('a', { provider: 'claude', epoch: 4, sequence: 6, thinking: true })));
    await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/prompt') ? response({ ok: true, turnId: 't2', clientTurnKey: call.body['clientTurnKey'], sequence: 7, status: 'accepted' }, 202) : undefined);
    await f.controller.send();
    assert.equal(f.posts().at(-1)!.path, '/sessions/a/prompt');

    await f.controller.selectSession('b');
    assert.equal(f.controller.getModel().followUp, false);
    const before = f.posts().length;
    f.controller.setInput('codex follow-up');
    await f.controller.send();
    assert.equal(f.posts().length, before, 'a busy non-Claude session takes Stop only');
});

test('a refused follow-up keeps the text editable and is never retried', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude()));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/steer') ? response({ ok: false, error: 'steer_queue_full' }, 409) : undefined);
    f.controller.setInput('one more thing');
    await f.controller.send();
    const model = f.controller.getModel();
    assert.equal(model.input, 'one more thing');
    assert.equal(model.steering, false);
    assert.match(model.error ?? '', /already has its follow-up/);
    f.controller.onTransport('connected'); await f.controller.refresh();
    assert.equal(f.posts().length, 1);
});

test('an unconfirmed follow-up is not resent and settles when its own message arrives', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude()));
    await f.controller.refresh(); await f.controller.selectSession('a');
    f.intercept(call => call.path.endsWith('/steer') ? response({ ok: false, error: 'steer_outcome_unknown' }, 503) : undefined);
    f.controller.setInput('did this arrive?');
    await f.controller.send();
    assert.match(f.controller.getModel().error ?? '', /Follow-up delivery not confirmed/);
    assert.match(f.controller.getModel().error ?? '', /Claude may have received it, but it will not appear in the conversation/);
    assert.doesNotMatch(f.controller.getModel().error ?? '', /appears in the conversation if/, 'the server could not record it');
    assert.equal(f.controller.getModel().input, 'did this arrive?');
    f.controller.onTransport('connected'); await f.controller.refresh();
    assert.equal(f.posts().length, 1, 'no automatic resend after reconnect');
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    f.controller.onEvent({ topic: 'code', event: 'code_item', sessionId: 'a', sequence: 4, epoch: 4, item: steerItem(key, 4) });
    assert.equal(f.controller.getModel().input, '', 'its own user_message settles the attempt');
    assert.doesNotMatch(f.controller.getModel().error ?? '', /not confirmed/);

    const g = fixture(t);
    g.snapshots.set('a', snap(streamingClaude()));
    await g.controller.refresh(); await g.controller.selectSession('a');
    g.intercept(call => call.path.endsWith('/steer') ? Promise.reject(new TypeError('connection dropped')) : undefined);
    g.controller.setInput('lost in transit');
    await g.controller.send();
    assert.match(g.controller.getModel().error ?? '', /Follow-up delivery not confirmed.*appears in the conversation if Claude received it/);
    assert.equal(g.posts().length, 1);
});

test('a follow-up lost in transit settles from the next snapshot that holds it', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude()));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const pending = deferred<Response>();
    f.intercept(call => call.path.endsWith('/steer') ? pending.promise : undefined);
    f.controller.setInput('did this arrive?');
    const sending = f.controller.send();
    const key = String(f.posts()[0]!.body['clientTurnKey']);
    // The server committed it; only the response was lost, and no event reaches this client.
    f.snapshots.set('a', snap(streamingClaude({ sequence: 4 }), [steerItem(key, 4)]));
    pending.reject(new TypeError('connection dropped'));
    await sending;
    const model = f.controller.getModel();
    assert.deepEqual({ input: model.input, steering: model.steering }, { input: '', steering: false });
    assert.doesNotMatch(model.error ?? '', /not confirmed/);
    assert.equal(f.posts().length, 1);
});

test('Send follow-up closes once the running turn\'s follow-up is in the transcript', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude({ sequence: 4 }), [steerItem('earlier', 4)]));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const model = f.controller.getModel();
    assert.deepEqual({ followUp: model.followUp, followUpSent: model.followUpSent }, { followUp: true, followUpSent: true });
    f.controller.setInput('a second follow-up');
    await f.controller.send();
    assert.equal(f.posts().length, 0, 'the turn took its one follow-up; nothing is posted');
    assert.equal(f.controller.getModel().input, 'a second follow-up');
    // Only the current turn's follow-up counts.
    f.snapshots.set('a', snap(streamingClaude({ turnId: 'turn-b', sequence: 6 }), [steerItem('earlier', 4)]));
    await f.controller.refresh();
    assert.deepEqual({ followUp: f.controller.getModel().followUp, followUpSent: f.controller.getModel().followUpSent }, { followUp: true, followUpSent: false });
});

test('a follow-up outcome never overwrites a Stop in progress', async t => {
    const f = fixture(t);
    f.snapshots.set('a', snap(streamingClaude()));
    await f.controller.refresh(); await f.controller.selectSession('a');
    const steer = deferred<Response>(), cancel = deferred<Response>();
    f.intercept(call => call.path.endsWith('/steer') ? steer.promise : call.path.endsWith('/cancel') ? cancel.promise : undefined);
    f.controller.setInput('late follow-up');
    const sending = f.controller.send();
    const stopping = f.controller.stop();
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    steer.resolve(response({ ok: false, error: 'session_not_steerable' }, 409));
    await sending;
    assert.equal(f.controller.getModel().operation.kind, 'stopping');
    assert.equal(f.controller.getModel().input, 'late follow-up');
    f.snapshots.set('a', snap(streamingClaude({ status: 'stopping', sequence: 4 })));
    cancel.resolve(response({ ok: true, session: streamingClaude({ status: 'stopping', sequence: 4 }) }));
    await stopping;
    assert.equal(f.controller.getModel().followUp, false, 'a stopping turn takes no follow-up');
});
