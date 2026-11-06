import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settings } from '../../src/core/config.ts';
import { registerMessagingRoutes } from '../../src/routes/messaging.ts';
import { registerSendTransport } from '../../src/messaging/send.ts';
import { slackSendHandler } from '../../src/slack/send-handler.ts';
import { SlackActionStore } from '../../src/slack/action-store.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import { withSlackToolAccess } from '../../src/slack/tool-access.ts';
import { reserveSlackToolGrant, activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolScope,
    configureSlackDeliveryRecovery, slackRecoveryPromptForRequest, slackRecoveryBlocksRoot,
    slackCredentialKey, type SlackToolGrant } from '../../src/slack/tool-context.ts';

const TOKEN = 'fixture-delivery-token';
const target = (threadId?: string) => ({ channel: 'slack' as const, targetKind: 'channel' as const,
    peerKind: 'channel' as const, targetId: 'C1', ...(threadId ? { threadId } : {}) });

for (const hadDenial of [false, true]) for (const fullLocal of [false, true]) for (const unknown of [false, true]) test(`channel send recovery; blocked=${hadDenial}, unknown=${unknown}, fullLocal=${fullLocal}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'jaw-delivery-recovery-'));
    const file = join(directory, 'actions.db');
    let db = new Database(file);
    let store = new SlackActionStore(db);
    const oldSlack = settings.slack, oldHome = settings.messaging.homeChannel;
    const oldFetch = globalThis.fetch, oldEnv = process.env['JAW_SLACK_FAILURE_DM'];
    process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATOR';
    settings.slack = { ...oldSlack, enabled: true, botToken: TOKEN };
    settings.messaging.homeChannel = 'slack';
    registerSendTransport('slack', slackSendHandler);
    resetVerifiedSlackWorkspace();
    revokeSlackToolScope();
    t.after(() => {
        configureSlackDeliveryRecovery(undefined); revokeSlackToolScope(); resetVerifiedSlackWorkspace();
        globalThis.fetch = oldFetch; settings.slack = oldSlack; settings.messaging.homeChannel = oldHome;
        if (oldEnv === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = oldEnv;
        db.close(); rmSync(directory, { recursive: true, force: true });
    });
    const posts: Record<string, unknown>[] = [];
    let actorPresent = true;
    globalThis.fetch = async (url, init) => {
        const method = new URL(String(url)).pathname.split('/').at(-1)!;
        const jsonBody = new Headers(init?.headers).get('content-type')?.includes('application/json');
        const body = jsonBody ? JSON.parse(String(init?.body)) : Object.fromEntries(new URLSearchParams(String(init?.body)));
        let data: Record<string, unknown>;
        if (method === 'auth.test') data = { team_id: 'T1', user_id: 'UBOT' };
        else if (method === 'conversations.info') data = { channel: { id: body.channel, is_member: true, is_shared: false, is_ext_shared: false, context_team_id: 'T1' } };
        else if (method === 'conversations.members') data = { members: actorPresent ? ['U1', 'UBOT'] : ['UBOT'], response_metadata: { next_cursor: '' } };
        else if (method === 'chat.postMessage') {
            posts.push(body);
            if (unknown) throw new Error('fixture: response lost after vendor accepted POST');
            data = { channel: 'C1', ts: '2.000001', message: { text: 'pending report' } };
        } else if (method === 'conversations.replies' || method === 'conversations.history') {
            data = { messages: [{ user: 'UBOT', ts: '2.000001', thread_ts: '2.0', text: 'pending report' }], has_more: false, response_metadata: { next_cursor: '' } };
        } else throw new Error(`unexpected Slack method ${method}`);
        return new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'chat:write,channels:history' } });
    };
    type Handler = (req: unknown, res: unknown) => Promise<void>;
    const handlers = new Map<string, Handler>();
    const register = (path: string, ...fns: Handler[]) => { handlers.set(path, fns.at(-1)!); };
    const routes = () => registerMessagingRoutes({ get: register, post: register, use() {} } as never,
        ((_req: unknown, _res: unknown, next: () => void) => next()) as never, { slackActionStore: store, isFullAccess: () => fullLocal });
    routes();
    const reserve = (id: string, threadId?: string) => {
        assert.ok(reserveSlackToolGrant({ teamId: 'T1', actorId: 'U1', credentialKey: slackCredentialKey(TOKEN), destination: target(threadId), enforceDestination: true },
            { requestId: id, scope: 'scope', chatSessionId: 'chat' }));
    };
    const activate = (id: string) => {
        const secret = activateSlackToolGrant(id, 'scope', 'chat'); assert.ok(secret);
        const grant = resolveSlackToolGrant(secret); assert.ok(grant); return { secret, grant };
    };
    const send = async (secret: string, threadId: string | null = '2.0') => {
        let status = 200; let output: Record<string, unknown> = {};
        const req = { body: { channel: 'slack', type: 'text', text: 'pending report', target: target(threadId ?? undefined) },
            query: {}, headers: { 'x-jaw-slack-grant': secret } };
        const res = { status(code: number) { status = code; return this; }, json(value: Record<string, unknown>) { output = value; return this; } };
        await handlers.get('/api/channel/send')!(req, res);
        return { status, output };
    };
    const firstId = `blocked-${hadDenial}-${unknown}-${fullLocal}`;
    reserve(firstId, hadDenial ? undefined : '2.0'); const first = activate(firstId);
    if (!hadDenial) {
        await send(first.secret);
        assert.equal(posts.length, 1);
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM slack_blocked_actions').get() as { n: number }).n, 0,
            'a normal or unknown vendor dispatch is never added to automatic recovery');
        return;
    }
    assert.equal((await send(first.secret)).status, 403);
    assert.equal(posts.length, 0, 'definite destination rejection performs no POST');
    assert.equal(slackRecoveryBlocksRoot(firstId, target()), true, 'a final body cannot substitute the channel root');
    assert.equal((await send(first.secret, null)).status, 409, 'an explicit root POST cannot substitute for the thread either');
    assert.equal(posts.length, 0);
    db.close(); db = new Database(file); store = new SlackActionStore(db); routes();
    configureSlackDeliveryRecovery({
        prompt: async (grant: SlackToolGrant) => withSlackToolAccess(TOKEN, { kind: 'turn', grant }, 'C1', async () => JSON.stringify(store.blockedFor(grant))),
        blocksRoot: (requestId, destination) => store.blocksRoot(requestId, destination),
    });
    const nextId = `next-${unknown}-${fullLocal}`;
    reserve(nextId, '2.0');
    actorPresent = false;
    await assert.rejects(slackRecoveryPromptForRequest(nextId, 'scope', 'chat'));
    actorPresent = true;
    const context = await slackRecoveryPromptForRequest(nextId, 'scope', 'chat');
    const held = JSON.parse(context);
    assert.equal(held[0].operation, 'channel.send');
    assert.deepEqual(held[0].originalTarget, { channel: 'C1', threadTs: '2.0' });
    assert.equal(await slackRecoveryPromptForRequest(nextId, 'other-scope', 'chat'), '');
    const next = activate(nextId);
    const retried = await send(next.secret);
    assert.equal(posts.length, 1, JSON.stringify(retried));
    assert.equal(posts[0]!.channel, 'C1'); assert.equal(posts[0]!.thread_ts, '2.0');
    reserve(`repeat-${unknown}-${fullLocal}`, '2.0');
    const repeated = activate(`repeat-${unknown}-${fullLocal}`);
    assert.equal((await send(repeated.secret)).status, 409);
    assert.equal(posts.length, 1, 'attempted or unknown delivery is never silently replayed');
});
