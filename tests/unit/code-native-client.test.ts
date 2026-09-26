import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeSessionInfo } from '../../src/code-mode/wire.ts';
import { CodeClientError, createCodeSessionClient } from '../../public/manager/src/code/code-session-client.ts';

const session: CodeSessionInfo = {
    sessionId: 's', provider: 'cursor', cwd: '/work', title: null, model: 'composer', effort: null, permissionMode: 'auto',
    status: 'idle', turnId: null, archivedAt: null, error: null, resume: { available: true, reason: null },
    capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: true, efforts: [], permissionModes: ['ask', 'auto'] },
    epoch: 9, sequence: 17, revision: 3, createdAt: 1, lastUsedAt: 2, lastTurnCompletedAt: null, lastVisitedAt: null,
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('native client sends final paths, encoded IDs, exact command identities and bounded read cursors', async () => {
    const original = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const parsed = new URL(String(url));
        const path = parsed.pathname;
        if (path.endsWith('/events')) return reply({ ok: true, events: [], nextSequence: 17, throughSequence: 17, hasMore: false });
        if (path.endsWith('/items')) return reply({ ok: true, items: [{ itemId: 'old', firstSequence: 4, turnId: 'old-turn', kind: 'user_message',
            status: 'done', text: 'earlier', createdAt: 1, updatedAt: 1 }], beforeSequence: 4, hasMore: true, sequence: 90 });
        if (path.endsWith('/prompt')) return reply({ ok: true, turnId: 'turn', clientTurnKey: 'key', sequence: 20, status: 'accepted' }, 202);
        if (path.includes('/permissions/')) return reply({ ok: true, accepted: true });
        if (path.endsWith('/sessions') && init.method === 'GET') return reply({ ok: true, sessions: [session], limit: 100, offset: 100, hasMore: false });
        if (init.method === 'GET') return reply({ ok: true, session, items: [], sequence: 17, pendingPermissions: [], truncated: false });
        if (path.endsWith('/cancel')) return reply({ ok: true, session: { ...session, status: 'stopping', turnId: 'turn', sequence: 21 } });
        return reply({ ok: true, session }, path.endsWith('/sessions') ? 201 : 200);
    };
    try {
        const client = createCodeSessionClient(4567);
        const controller = new AbortController();
        await client.listSessions({ scope: 'cwd', cwd: '/work a', archived: false, offset: 100, limit: 100 }, controller.signal);
        await client.snapshot('s/a', controller.signal);
        await client.events('s/a', 17, controller.signal);
        const history = await client.history('s/a', 8, controller.signal);
        await client.createSession({ provider: 'cursor', cwd: '/work', model: 'composer', effort: null, permissionMode: 'auto' });
        await client.patchSession('s/a', { expectedRevision: 3, model: 'm', effort: null, permissionMode: 'ask' });
        const receipt = await client.sendPrompt('s/a', { text: '  /model literal\n', clientTurnKey: 'key' });
        assert.deepEqual(receipt, { ok: true, turnId: 'turn', clientTurnKey: 'key', sequence: 20, status: 'accepted' });
        await client.cancelPrompt('s/a', { turnId: 'turn', epoch: 9 });
        await client.attachSession('s/a');
        await client.answerPermission('opaque/p', { sessionId: 's/a', turnId: 'turn', epoch: 9, optionId: 'native:allow/once' });
        assert.equal(calls.length, 10);
        assert.equal(new URL(calls[0]!.url).searchParams.get('cwd'), '/work a');
        assert.equal(calls[0]!.init.signal, controller.signal);
        assert.equal(calls[1]!.url, 'http://127.0.0.1:4567/api/code/sessions/s%2Fa');
        assert.match(calls[2]!.url, /events\?afterSequence=17&limit=500$/);
        assert.match(calls[3]!.url, /items\?beforeSequence=8&limit=200$/);
        assert.equal(history.sequence, 90);
        assert.equal(history.beforeSequence, 4);
        assert.deepEqual(JSON.parse(String(calls[4]!.init.body)), { provider: 'cursor', cwd: '/work', model: 'composer', effort: null, permissionMode: 'auto' });
        assert.equal(calls[5]!.init.method, 'PATCH');
        assert.deepEqual(JSON.parse(String(calls[6]!.init.body)), { text: '  /model literal\n', clientTurnKey: 'key' });
        assert.deepEqual(JSON.parse(String(calls[7]!.init.body)), { turnId: 'turn', epoch: 9 });
        assert.match(calls[8]!.url, /\/attach$/);
        assert.match(calls[9]!.url, /permissions\/opaque%2Fp$/);
        assert.deepEqual(JSON.parse(String(calls[9]!.init.body)), { sessionId: 's/a', turnId: 'turn', epoch: 9, optionId: 'native:allow/once' });
    } finally { globalThis.fetch = original; }
});

test('real error envelopes retain machine codes and conflict session; HTTP errors are never retried', async () => {
    const original = globalThis.fetch;
    let count = 0;
    try {
        for (const code of ['session_busy', 'request_not_current', 'invalid_option', 'revision_conflict']) {
            globalThis.fetch = async () => { count++; return reply({ ok: false, error: code, session: { ...session, sessionId: 'current', revision: 6 } }, 409); };
            await assert.rejects(createCodeSessionClient(4567).sendPrompt('s', { text: 'hello', clientTurnKey: 'k' }), error => {
                assert.ok(error instanceof CodeClientError);
                assert.equal(error.code, code);
                assert.equal(error.status, 409);
                assert.equal(error.session?.revision, 6);
                assert.notEqual(error.message, code);
                return true;
            });
        }
        assert.equal(count, 4);
        globalThis.fetch = async () => { count++; throw new TypeError('fetch failed'); };
        await assert.rejects(createCodeSessionClient(4567).createSession({ provider: 'grok', cwd: '/w', model: 'grok', effort: null, permissionMode: 'auto' }), TypeError);
        assert.equal(count, 5);
    } finally { globalThis.fetch = original; }
});

test('duplicate prompt 200 returns the existing receipt without creating another request', async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; return reply({ ok: true, turnId: 'same-turn', clientTurnKey: 'same-key', sequence: 24, status: 'completed' }, 200); };
    try {
        const receipt = await createCodeSessionClient(4567).sendPrompt('s', { text: 'same input', clientTurnKey: 'same-key' });
        assert.equal(receipt.turnId, 'same-turn');
        assert.equal(receipt.status, 'completed');
        assert.equal(requests, 1);
    } finally { globalThis.fetch = original; }
});

test('steerSession posts the captured follow-up once and names every refusal', async () => {
    const original = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    let answer = reply({ ok: true, turnId: 'turn', clientTurnKey: 'steer-key', sequence: 21, status: 'running' }, 202);
    globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return answer; };
    try {
        const client = createCodeSessionClient(4567);
        const input = { text: 'also the tests', clientTurnKey: 'steer-key', turnId: 'turn', epoch: 9 };
        assert.deepEqual(await client.steerSession('s/a', input), { ok: true, turnId: 'turn', clientTurnKey: 'steer-key', sequence: 21, status: 'running' });
        assert.equal(calls[0]!.url, 'http://127.0.0.1:4567/api/code/sessions/s%2Fa/steer');
        assert.equal(calls[0]!.init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), input);
        for (const [code, status] of [['session_not_steerable', 409], ['steer_queue_full', 409], ['steer_in_flight', 409],
            ['steer_key_spent', 409], ['steer_command_unsupported', 400], ['steer_outcome_unknown', 503]] as const) {
            answer = reply({ ok: false, error: code }, status);
            await assert.rejects(client.steerSession('s', input), (error: unknown) => {
                assert.ok(error instanceof CodeClientError);
                assert.equal(error.code, code); assert.equal(error.status, status);
                assert.doesNotMatch(error.message, /could not be completed/, `${code} has its own copy`);
                return true;
            });
        }
        assert.equal(calls.length, 7, 'no request is retried');
    } finally { globalThis.fetch = original; }
});

test('rollback posts only the opaque row, revision and epoch, and a refusal carries its reason and current session', async () => {
    const original = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    let refuse: { error: string; session?: CodeSessionInfo } | null = null;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return refuse ? reply({ ok: false, ...refuse }, 409) : reply({ ok: true, session: { ...session, historyGeneration: 1 } });
    };
    try {
        const client = createCodeSessionClient(4567);
        const rolled = await client.rollbackSession('s/a', { expectedRevision: 3, expectedEpoch: 9, upToItemId: 'turn:user' });
        assert.equal(rolled.historyGeneration, 1);
        assert.equal(calls[0]!.url, 'http://127.0.0.1:4567/api/code/sessions/s%2Fa/rollback');
        assert.equal(calls[0]!.init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { expectedRevision: 3, expectedEpoch: 9, upToItemId: 'turn:user' });
        for (const [code, copy] of [['rollback_unavailable', /compacted/], ['rollback_boundary_unavailable', /no longer be a rollback point/],
            ['rollback_noop', /latest turn/]] as const) {
            refuse = { error: code };
            await assert.rejects(client.rollbackSession('s', { expectedRevision: 3, expectedEpoch: 9, upToItemId: 'turn:user' }),
                (error: unknown) => error instanceof CodeClientError && error.code === code && error.status === 409 && copy.test(error.message));
        }
        refuse = { error: 'revision_conflict', session };
        await assert.rejects(client.rollbackSession('s', { expectedRevision: 2, expectedEpoch: 9, upToItemId: 'turn:user' }),
            (error: unknown) => error instanceof CodeClientError && error.session?.revision === 3);
    } finally { globalThis.fetch = original; }
});
