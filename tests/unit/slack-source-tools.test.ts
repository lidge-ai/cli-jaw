import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRtsOutputStore, getRtsOutputStore, RtsOutputStore } from '../../src/slack/rts-output-store.ts';
import { reserveSlackToolGrant, activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolScope, slackCredentialKey } from '../../src/slack/tool-context.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import { searchAndQuoteSlack } from '../../src/slack/search-quote.ts';
import { fetchSlackHistory, formatHistoryForAgent } from '../../src/slack/history.ts';
import { readExactSlackMessage, readSlackMessageSnapshot } from '../../src/slack/message.ts';
import { resolveThreadInfo, resetSlackConversationCache } from '../../src/slack/conversation.ts';
import { publishSlackQuote, runSlackQuoteInvocation } from '../../src/slack/quote.ts';
import { slackApi } from '../../src/slack/api.ts';
import { log } from '../../src/core/logger.ts';
let grantedHeader = '';
const TOKEN = 'fixture-token';
const CANARY = 'RTS_PRIVATE_BODY_CANARY';
const LINK = 'https://example.slack.com/archives/C1/p1000000';
const SOURCE = { ts: '1.000000', user: 'U2', text: CANARY, edited: { ts: '1.100000' } };
function fixture(options: { uncertainPost?: boolean; changeSource?: boolean; wrongLink?: boolean } = {}) {
    const posts: Array<Record<string, unknown>> = [];
    const methods: string[] = [];
    let sourceReads = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
        const method = String(url).split('/').at(-1)!; methods.push(method);
        const raw = String(init?.body ?? '');
        const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        let data: Record<string, unknown>;
        if (method === 'auth.test') data = { team_id: 'T1', user_id: 'UBOT' };
        else if (method === 'conversations.info') data = { channel: body.channel === 'D1'
            ? { id: 'D1', is_im: true, is_org_shared: false, user: 'U1' }
            : { id: body.channel, is_shared: false, is_ext_shared: false, context_team_id: 'T1' } };
        else if (method === 'users.info') data = { user: { id: 'U1', team_id: 'T1' } };
        else if (method === 'conversations.members') data = { members: body.channel === 'D1' ? ['U1', 'UBOT'] : ['U1', 'U2', 'UBOT'], response_metadata: { next_cursor: '' } };
        else if (method === 'assistant.search.context') {
            assert.equal(body.action_token, 'action-fixture'); assert.equal(body.limit, 20);
            data = { results: { messages: [{ channel_id: 'C1', message_ts: SOURCE.ts, author_user_id: 'U2', content: CANARY, permalink: LINK }] }, response_metadata: { next_cursor: '' } };
        } else if (method === 'chat.getPermalink') data = { permalink: options.wrongLink ? LINK.replace('/C1/', '/C2/') : LINK };
        else if (method === 'chat.postMessage') {
            posts.push({ ...body, ts: `20.${String(posts.length + 1).padStart(6, '0')}`, user: 'UBOT', bot_id: 'B1' });
            if (options.uncertainPost) {
                for (const block of posts.at(-1)!.blocks as Array<Record<string, unknown>>) delete block.block_id;
                throw new Error(CANARY);
            }
            data = { ts: posts.at(-1)!.ts };
        } else if (method === 'conversations.history' || method === 'conversations.replies') {
            if (body.channel === 'C1') {
                sourceReads++;
                data = { messages: [{ ...SOURCE, ...(options.changeSource && sourceReads > 1 ? { text: 'changed', edited: { ts: '2.0' } } : {}) }], response_metadata: { next_cursor: '' } };
            } else data = { messages: posts.filter(post => !body.oldest || post.ts === body.oldest), response_metadata: { next_cursor: '' } };
        } else throw new Error(`unexpected ${method}`);
        return new Response(JSON.stringify({ ok: true, ...data }));
    };
    return { fetchImpl, posts, methods };
}
function principal() {
    const destination = { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'direct' as const, targetId: 'D1', threadId: '10.000000' };
    reserveSlackToolGrant({ teamId: 'T1', actorId: 'U1', destination, credentialKey: slackCredentialKey(TOKEN), actionToken: 'action-fixture' }, { requestId: 'request', scope: 'scope', chatSessionId: 'chat' });
    const secret = activateSlackToolGrant('request', 'scope', 'chat')!;
    grantedHeader = secret;
    return { kind: 'turn' as const, grant: resolveSlackToolGrant(secret)! };
}
test.beforeEach(() => { revokeSlackToolScope(); resetVerifiedSlackWorkspace(); resetSlackConversationCache(); configureRtsOutputStore(undefined); });
test.afterEach(() => { configureRtsOutputStore(undefined); revokeSlackToolScope(); });

test('RTS response canary stays in Slack publication and is excluded from read, prefetch and reopened store', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'rts-canary-')); const path = join(dir, 'test.db');
    let db = new Database(path); let store = new RtsOutputStore(db); configureRtsOutputStore(store);
    t.after(() => { configureRtsOutputStore(undefined); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const logs: unknown[] = [];
    for (const level of ['info', 'warn', 'error'] as const) t.mock.method(log, level, (...args: unknown[]) => { logs.push(args); });
    const fake = fixture(); const actor = principal();
    const result = await searchAndQuoteSlack(TOKEN, actor, { query: 'find prior statement', invocationId: 'search1' }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(fake.posts.length, 1);
    assert.ok(JSON.stringify(fake.posts).includes(CANARY));
    assert.ok(!JSON.stringify(result).includes(CANARY)); assert.ok(!JSON.stringify(result).includes(LINK));
    const again = await searchAndQuoteSlack(TOKEN, actor, { query: 'find prior statement', invocationId: 'search1' }, { fetchImpl: fake.fetchImpl });
    assert.deepEqual(again, result); assert.equal(fake.posts.length, 1);
    for (const block of fake.posts[0]!.blocks as Array<Record<string, unknown>>) delete block.block_id;
    db.close(); db = new Database(path); store = new RtsOutputStore(db); configureRtsOutputStore(store);
    const history = await fetchSlackHistory(TOKEN, 'D1', { fetchImpl: fake.fetchImpl }); assert.ok(history.ok);
    assert.equal(history.messages[0]?.contentExcluded, true); assert.ok(!formatHistoryForAgent(history.messages).includes(CANARY));
    await assert.rejects(readExactSlackMessage(TOKEN, { channel: 'D1', ts: result.messageTs[0]!, threadTs: '10.000000' }, { fetchImpl: fake.fetchImpl }), /restricted/);
    const thread = await resolveThreadInfo(TOKEN, 'D1', '10.000000', { teamId: 'T1', fetchImpl: fake.fetchImpl });
    assert.ok(!JSON.stringify(thread).includes(CANARY));
    const stored = JSON.stringify(db.prepare('SELECT * FROM slack_rts_outputs').all());
    assert.ok(!stored.includes(CANARY) && !stored.includes(LINK) && !stored.includes('U2'));
    assert.ok(!JSON.stringify(logs).includes(CANARY) && !JSON.stringify(logs).includes(LINK));
});

test('uncertain unmarked publication keeps a destination hold and hides content', async t => {
    const db = new Database(':memory:'); const store = new RtsOutputStore(db); configureRtsOutputStore(store);
    t.after(() => { configureRtsOutputStore(undefined); db.close(); });
    const fake = fixture({ uncertainPost: true });
    const result = await searchAndQuoteSlack(TOKEN, principal(), { query: 'find', invocationId: 'unknown' }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, false); assert.equal(result.sent, 'unknown'); assert.equal(result.retryable, false);
    assert.equal(store.held('T1', 'D1'), true);
    const history = await fetchSlackHistory(TOKEN, 'D1', { fetchImpl: fake.fetchImpl }); assert.ok(history.ok);
    assert.ok(!JSON.stringify(history).includes(CANARY));
});

test('concurrent holds clear only their own invocation', () => {
    const db = new Database(':memory:'); const store = new RtsOutputStore(db);
    try { assert.ok(store.begin('T1', 'D1', 'a')); assert.ok(store.begin('T1', 'D1', 'b')); store.finish('T1', 'D1', 'a'); assert.equal(store.held('T1', 'D1'), true); }
    finally { db.close(); }
});

test('source mutation, excerpt mismatch and wrong permalink cannot publish', async () => {
    const actor = principal();
    for (const options of [{ changeSource: true }, { wrongLink: true }]) {
        const fake = fixture(options);
        await assert.rejects(publishSlackQuote(TOKEN, actor, { source: { channel: 'C1', ts: SOURCE.ts } }, { fetchImpl: fake.fetchImpl }));
        assert.equal(fake.posts.length, 0);
    }
    const fake = fixture();
    await assert.rejects(publishSlackQuote(TOKEN, actor, { source: { channel: 'C1', ts: SOURCE.ts }, excerpt: 'not in source' }, { fetchImpl: fake.fetchImpl }), /not_in_source/);
});

test('sensitive API errors, throws and oversized bodies cannot expose payload canaries', async t => {
    const logs: unknown[] = []; t.mock.method(log, 'warn', (...args: unknown[]) => { logs.push(args); });
    for (const fetchImpl of [async () => new Response(JSON.stringify({ ok: false, error: CANARY, body: CANARY })),
        async () => { throw new Error(CANARY); }, async () => new Response(CANARY.repeat(100000))]) {
        const result = await slackApi(TOKEN, 'assistant.search.context', {}, { fetchImpl, sensitiveResponse: true });
        assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(CANARY));
    }
    assert.deepEqual(logs, []);
});

test('operator quote idempotency survives reopening without retaining source content', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'quote-operation-')); const path = join(dir, 'test.db');
    let db = new Database(path); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { configureRtsOutputStore(undefined); db.close(); rmSync(dir, { recursive: true, force: true }); });
    let posts = 0;
    const input = { operation: 'quote', source: { channel: 'C1', ts: SOURCE.ts }, excerpt: CANARY };
    const run = async () => { posts++; return { ok: true, sent: true, messageTs: ['20.000001'] }; };
    await runSlackQuoteInvocation(TOKEN, { kind: 'operator' }, 'operator1', input, run);
    db.close(); db = new Database(path); configureRtsOutputStore(new RtsOutputStore(db));
    await runSlackQuoteInvocation(TOKEN, { kind: 'operator' }, 'operator1', input, run);
    assert.equal(posts, 1);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM slack_quote_operations').all()).includes(CANARY));
    await assert.rejects(runSlackQuoteInvocation(TOKEN, { kind: 'operator' }, 'operator1', { ...input, excerpt: 'different' }, run), /conflict/);
});

test('access failure on an RTS-discovered channel cannot expose source-pointer canaries', async t => {
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { configureRtsOutputStore(undefined); db.close(); });
    const logs: unknown[] = []; t.mock.method(log, 'warn', (...args: unknown[]) => { logs.push(args); });
    const base = fixture();
    const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).endsWith('conversations.info') && String(init?.body).includes('channel=C1')) {
            return new Response(JSON.stringify({ ok: false, error: LINK, detail: CANARY }));
        }
        return base.fetchImpl(url, init);
    };
    const result = await searchAndQuoteSlack(TOKEN, principal(), { query: 'find', invocationId: 'failure' }, { fetchImpl });
    assert.equal(result.ok, false); assert.equal(base.posts.length, 0);
    assert.ok(!JSON.stringify({ result, logs }).includes(CANARY)); assert.ok(!JSON.stringify({ result, logs }).includes(LINK));
});

test('a later search-page failure retains the already-published receipt and stops retries', async t => {
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { configureRtsOutputStore(undefined); db.close(); });
    const base = fixture(); let pages = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).endsWith('assistant.search.context')) {
            pages++;
            if (pages === 2) return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { headers: { 'retry-after': '10' } });
            return new Response(JSON.stringify({ ok: true, results: { messages: [{ channel_id: 'C1', message_ts: SOURCE.ts, author_user_id: 'U2', content: CANARY }] }, response_metadata: { next_cursor: 'next' } }));
        }
        return base.fetchImpl(url, init);
    };
    const result = await searchAndQuoteSlack(TOKEN, principal(), { query: 'find', invocationId: 'later-fail' }, { fetchImpl });
    assert.equal(result.ok, false); assert.equal(result.sent, true); assert.equal(result.partial, true);
    assert.deepEqual(result.messageTs, ['20.000001']); assert.equal(pages, 2); assert.equal(base.posts.length, 1);
});

test('summary publication distinguishes reference proof from an exact quote', async () => {
    const fake = fixture();
    const result = await publishSlackQuote(TOKEN, principal(), { source: { channel: 'C1', ts: SOURCE.ts }, summary: 'A supplied summary' }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, true); assert.equal(result.sourceVerification, 'references_only');
    assert.ok(JSON.stringify(fake.posts).includes('요약'));
});

test('typed HTTP serialization excludes RTS data and rejects replay through message lookup', async t => {
    const { settings } = await import('../../src/core/config.ts');
    const { registerSlackToolRoutes } = await import('../../src/routes/slack-tools.ts');
    const previous = settings.slack; const originalFetch = globalThis.fetch;
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { settings.slack = previous; globalThis.fetch = originalFetch; configureRtsOutputStore(undefined); db.close(); });
    settings.slack = { ...previous, enabled: true, botToken: TOKEN };
    const fake = fixture(); globalThis.fetch = fake.fetchImpl; principal();
    let handler!: (req: unknown, res: unknown) => Promise<void>;
    registerSlackToolRoutes({ post: (_path: string, ...handlers: Array<typeof handler>) => { handler = handlers.at(-1)!; } } as never,
        ((_req: unknown, _res: unknown, next: () => void) => next()) as never, () => false);
    let status = 200; let payload: Record<string, unknown> = {};
    const res = { status(value: number) { status = value; return res; }, json(value: Record<string, unknown>) { payload = value; } };
    await handler({ headers: { 'x-jaw-slack-grant': grantedHeader }, body: { operation: 'search.quote', invocationId: 'http1', query: 'find' } }, res);
    assert.equal(status, 200); assert.equal(payload.ok, true);
    assert.ok(!JSON.stringify(payload).includes(CANARY) && !JSON.stringify(payload).includes(LINK));
    await handler({ headers: { 'x-jaw-slack-grant': grantedHeader }, body: { operation: 'message', source: { channel: 'D1', ts: '20.000001', threadTs: '10.000000' } } }, res);
    assert.equal(status, 403); assert.equal(payload.error, 'slack_source_content_restricted');
    const before = fake.methods.length;
    await handler({ headers: {}, body: { operation: 'chat.delete', method: 'chat.delete' } }, res);
    assert.equal(status, 400);
    await handler({ headers: {}, body: { operation: 'search.info' } }, res);
    assert.equal(status, 401); assert.equal(fake.methods.length, before);
});

test('permalink query cannot redirect an otherwise matching source path to another thread', async () => {
    const fake = fixture();
    const fetchImpl: typeof fetch = (url, init) => String(url).endsWith('chat.getPermalink')
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, permalink: `${LINK}?thread_ts=2.000000&cid=C1` })))
        : fake.fetchImpl(url, init);
    await assert.rejects(readSlackMessageSnapshot(TOKEN, { channel: 'C1', ts: SOURCE.ts }, { fetchImpl }), /source_mismatch/);
});

test('no output ID preserves unknown delivery and the RTS hold', async t => {
    const db = new Database(':memory:'); const store = new RtsOutputStore(db); configureRtsOutputStore(store);
    t.after(() => { configureRtsOutputStore(undefined); db.close(); });
    const base = fixture();
    const fetchImpl: typeof fetch = async (url, init) => String(url).endsWith('chat.postMessage')
        ? new Response(JSON.stringify({ ok: true })) : base.fetchImpl(url, init);
    const result = await searchAndQuoteSlack(TOKEN, principal(), { query: 'find', invocationId: 'no-id' }, { fetchImpl });
    assert.equal(result.ok, false); assert.equal(result.sent, 'unknown'); assert.deepEqual(result.messageTs, []);
    assert.equal(result.retryable, false); assert.equal(store.held('T1', 'D1'), true);
});

test('typed reads discard credential-changed data before permalink lookup', async t => {
    const { settings } = await import('../../src/core/config.ts');
    const { registerSlackToolRoutes } = await import('../../src/routes/slack-tools.ts');
    const previous = settings.slack; const savedFetch = globalThis.fetch;
    t.after(() => { settings.slack = previous; globalThis.fetch = savedFetch; });
    settings.slack = { ...previous, enabled: true, botToken: TOKEN };
    const fake = fixture();
    globalThis.fetch = async (url, init) => {
        const result = await fake.fetchImpl(url, init);
        if (String(url).endsWith('conversations.history')) settings.slack = { ...settings.slack, botToken: 'changed-token' };
        return result;
    };
    let handler!: (req: unknown, res: unknown) => Promise<void>;
    registerSlackToolRoutes({ post: (_path: string, ...handlers: Array<typeof handler>) => { handler = handlers.at(-1)!; } } as never,
        ((_req: unknown, _res: unknown, next: () => void) => next()) as never, secret => secret === 'operator-fixture');
    let status = 200; let payload: unknown;
    const res = { status(value: number) { status = value; return res; }, json(value: unknown) { payload = value; } };
    await handler({ headers: { 'x-jaw-slack-operator': 'operator-fixture' }, body: { operation: 'message', source: { channel: 'C1', ts: SOURCE.ts } } }, res);
    assert.equal(status, 409); assert.ok(!JSON.stringify(payload).includes(CANARY));
    assert.equal(fake.methods.includes('chat.getPermalink'), false);
});

test('unavailable privacy store prevents any RTS call', async () => {
    configureRtsOutputStore(null);
    const fake = fixture();
    await assert.rejects(searchAndQuoteSlack(TOKEN, principal(), { query: 'find', invocationId: 'no-store' }, { fetchImpl: fake.fetchImpl }), /privacy_unavailable/);
    assert.equal(fake.methods.length, 0);
});

test('RTS adapter reports excluded cross-workspace records as partial', async () => {
    const { searchSlackContext } = await import('../../src/slack/search.ts');
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, results: { messages: [{ team_id: 'T2', channel_id: 'C2', message_ts: SOURCE.ts, author_user_id: 'U2', content: CANARY }] }, response_metadata: { next_cursor: '' } }));
    };
    const result = await searchSlackContext(TOKEN, principal().grant, { query: 'find', channelTypes: ['im'] }, { fetchImpl });
    assert.equal(result.partial, true); assert.deepEqual(result.messages, []); assert.deepEqual(body.channel_types, ['im']);
});

test('quote expectations use redacted author display as actually sent', async () => {
    const fake = fixture(); const secret = ['xoxb', '1234567890', '1234567890', 'abcdefghijklmnopqrstuv'].join('-');
    const fetchImpl: typeof fetch = (url, init) => String(url).endsWith('users.info') && String(init?.body).includes('U2')
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, user: { id: 'U2', name: secret } })))
        : fake.fetchImpl(url, init);
    const result = await publishSlackQuote(TOKEN, principal(), { source: { channel: 'C1', ts: SOURCE.ts } }, { fetchImpl });
    assert.equal(result.ok, true); assert.ok(!JSON.stringify(fake.posts).includes(secret));
});


for (const mode of ['unavailable', 'changed'] as const) test(`quote never verifies transport-success with ${mode} saved content`, async () => {
    const f = fixture();
    const fetchImpl: typeof fetch = async (url, init) => {
        const method = String(url).split('/').at(-1);
        const raw = String(init?.body ?? '');
        const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        if ((method === 'conversations.history' || method === 'conversations.replies') && body.channel === 'D1') {
            if (mode === 'unavailable') return new Response(JSON.stringify({ ok: false, error: 'missing_scope' }));
            const response = await f.fetchImpl(url, init);
            const saved = await response.json();
            for (const message of saved.messages) {
                for (const block of message.blocks) {
                    for (const element of block.elements ?? []) {
                        if (element.type === 'rich_text_quote') element.elements = [{ type: 'text', text: 'different saved content' }];
                    }
                }
            }
            return new Response(JSON.stringify(saved));
        }
        return f.fetchImpl(url, init);
    };
    const result = await publishSlackQuote(TOKEN, principal(), { source: { channel: 'C1', ts: SOURCE.ts } }, { fetchImpl });
    assert.equal(f.posts.length, 1, 'a successful POST must never be repeated for failed verification');
    assert.equal(result.sent, true);
    assert.equal(result.ok, false);
    assert.equal(result.contentVerification, 'failed');
    assert.equal(result.sourceVerification, 'failed');
    assert.equal(result.messageTs.length, 1);
});


test('full-local search.quote reuses the turn workflow and keeps the RTS canary out of the receipt', async t => {
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { configureRtsOutputStore(undefined); db.close(); });
    const fake = fixture();
    const turn = principal();
    const full = { kind: 'operator' as const, source: 'full-local' as const, context: turn.grant };
    const result = await searchAndQuoteSlack(TOKEN, full as typeof turn, { query: 'find prior statement', invocationId: 'full-search' }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fake.posts.length, 1);
    assert.ok(JSON.stringify(fake.posts).includes(CANARY));
    assert.ok(!JSON.stringify(result).includes(CANARY));
    assert.ok(fake.methods.includes('assistant.search.context'));
    assert.ok(fake.methods.includes('conversations.members'));
});

test('operator without action-token context cannot search.quote', async () => {
    const fake = fixture();
    await assert.rejects(searchAndQuoteSlack(TOKEN, { kind: 'operator' }, { query: 'find', invocationId: 'no-ctx' }, { fetchImpl: fake.fetchImpl }), /action_token/);
    await assert.rejects(searchAndQuoteSlack(TOKEN, { kind: 'operator', source: 'full-local' } as never, { query: 'find', invocationId: 'no-ctx-full' }, { fetchImpl: fake.fetchImpl }), /action_token/);
    assert.equal(fake.methods.includes('assistant.search.context'), false);
});

test('HTTP search.quote under full without a grant is action_token_unavailable, with a grant it stays private', async t => {
    const { settings } = await import('../../src/core/config.ts');
    const { registerSlackToolRoutes } = await import('../../src/routes/slack-tools.ts');
    const previous = settings.slack; const originalFetch = globalThis.fetch;
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    t.after(() => { settings.slack = previous; globalThis.fetch = originalFetch; configureRtsOutputStore(undefined); db.close(); });
    settings.slack = { ...previous, enabled: true, botToken: TOKEN };
    const fake = fixture(); globalThis.fetch = fake.fetchImpl; principal();
    let handler!: (req: unknown, res: unknown) => Promise<void>;
    type Register = typeof registerSlackToolRoutes & ((app: never, auth: never, op: (s: string) => boolean, actions?: undefined, options?: { isFullAccess?: () => boolean }) => void);
    (registerSlackToolRoutes as Register)({ post: (_path: string, ...handlers: Array<typeof handler>) => { handler = handlers.at(-1)!; } } as never,
        ((_req: unknown, _res: unknown, next: () => void) => next()) as never, () => false, undefined, { isFullAccess: () => true });
    let status = 200; let payload: Record<string, unknown> = {};
    const res = { status(value: number) { status = value; return res; }, json(value: Record<string, unknown>) { payload = value; } };
    await handler({ headers: {}, body: { operation: 'search.quote', invocationId: 'http-full', query: 'find' } }, res);
    assert.equal(status, 409);
    assert.match(String(payload.error ?? ''), /action_token/);
    await handler({ headers: { 'x-jaw-slack-grant': grantedHeader }, body: { operation: 'search.quote', invocationId: 'http-full-grant', query: 'find' } }, res);
    assert.equal(status, 200);
    assert.ok(!JSON.stringify(payload).includes(CANARY));
});

test('ordinary quote under full-local still requires an explicit destination', async () => {
    const turn = principal();
    const full = { kind: 'operator' as const, source: 'full-local' as const, context: turn.grant };
    await assert.rejects(publishSlackQuote(TOKEN, full as typeof turn, { source: { channel: 'C1', ts: SOURCE.ts } }), /destination_required/);
    const fake = fixture();
    const posted = await publishSlackQuote(TOKEN, full as typeof turn, {
        source: { channel: 'C1', ts: SOURCE.ts },
        destination: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'CEXPLICIT' },
    }, { fetchImpl: fake.fetchImpl });
    assert.equal(posted.ok, true);
    assert.equal((fake.posts[0] as { channel?: string } | undefined)?.channel, 'CEXPLICIT');
});

test('Auto plus enforced grant cannot quote off C_HIT / 1710000000.000200', async () => {
    const dest = {
        channel: 'slack' as const,
        targetKind: 'channel' as const,
        peerKind: 'channel' as const,
        targetId: 'CHIT0000001',
        threadId: '1710000000.000200',
    };
    assert.ok(reserveSlackToolGrant({
        teamId: 'T1', actorId: 'U1', destination: dest, credentialKey: slackCredentialKey(TOKEN),
        enforceDestination: true,
    }, { requestId: 'mw-quote', scope: 'mention-watch:slack:CHIT0000001:1710000000.000200', chatSessionId: 'sess-hit' }));
    const secret = activateSlackToolGrant('mw-quote', 'mention-watch:slack:CHIT0000001:1710000000.000200', 'sess-hit')!;
    const grant = resolveSlackToolGrant(secret)!;
    const auto = { kind: 'operator' as const, source: 'full-local' as const, context: grant };
    await assert.rejects(publishSlackQuote(TOKEN, auto, {
        source: { channel: 'C1', ts: SOURCE.ts },
        destination: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'COTHER00001', threadId: '1710000000.000300' },
    }), (error: unknown) => (error as { code?: string }).code === 'slack_destination_mismatch');
    const fake = fixture();
    const posted = await publishSlackQuote(TOKEN, auto, {
        source: { channel: 'C1', ts: SOURCE.ts },
        destination: dest,
    }, { fetchImpl: fake.fetchImpl });
    assert.equal(posted.ok, true);
    assert.equal((fake.posts[0] as { channel?: string } | undefined)?.channel, 'CHIT0000001');
    assert.equal((fake.posts[0] as { thread_ts?: string } | undefined)?.thread_ts, '1710000000.000200');
});

test('full-local search.quote with a valid action token still needs a privacy store', async () => {
    const turn = principal();
    assert.ok(turn.kind === 'turn');
    const full: { kind: 'operator'; source: 'full-local'; context: typeof turn.grant } = {
        kind: 'operator', source: 'full-local', context: turn.grant,
    };
    const previous = getRtsOutputStore();
    try {
        configureRtsOutputStore(null);
        const fake = fixture();
        await assert.rejects(
            searchAndQuoteSlack(TOKEN, full, { query: 'find', invocationId: 'full-no-store' }, { fetchImpl: fake.fetchImpl }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, 'slack_rts_privacy_unavailable');
                return true;
            },
        );
        assert.equal(fake.methods.length, 0);
        assert.equal(fake.methods.includes('assistant.search.context'), false);
    } finally {
        configureRtsOutputStore(previous ?? undefined);
    }
});
