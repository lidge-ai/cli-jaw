import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { settings } from '../../src/core/config.ts';
import { registerMessagingRoutes } from '../../src/routes/messaging.ts';
import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { SlackActionRuntime } from '../../src/slack/action-runtime.ts';
import { SlackActionStore } from '../../src/slack/action-store.ts';
import { defineAction } from '../../src/slack/action-types.ts';
import { baseAction } from '../../src/slack/task-input.ts';
import { publishSlackQuote } from '../../src/slack/quote.ts';
import { activeServerOwnedChannels, activateSlackToolGrant, reserveSlackToolGrant, resolveSlackToolGrant, revokeSlackToolGrant, revokeSlackToolScope, slackCredentialKey } from '../../src/slack/tool-context.ts';
import { assertSlackWriteAllowed } from '../../src/slack/write-guard.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import type { SlackToolPrincipal } from '../../src/slack/tool-access.ts';

const TOKEN = 'fixture-token';
const LEASED = 'C0TESTLEASE';
const OTHER = 'C0TESTOTHER';
const THREAD = '1700000000.000001';
const operator: SlackToolPrincipal = { kind: 'operator' };
const target = (channel: string, threadId?: string) => ({ channel: 'slack' as const, targetKind: 'channel' as const,
    peerKind: 'channel' as const, targetId: channel, ...(threadId ? { threadId } : {}) });
let sequence = 0;
function grant(channel = LEASED, owned = true) {
    const id = `write-guard-${++sequence}`;
    assert.equal(reserveSlackToolGrant({ teamId: 'T0TEST', actorId: 'U0TEST', destination: target(channel, THREAD),
        credentialKey: slackCredentialKey(TOKEN), enforceDestination: true, ...(owned ? { serverOwnedDelivery: true } : {}) },
    { requestId: id, scope: 'test', chatSessionId: 'chat' }), true);
    const secret = activateSlackToolGrant(id, 'test', 'chat'); assert.ok(secret);
    const value = resolveSlackToolGrant(secret); assert.ok(value);
    return { id, secret, value };
}
const refusal = (code: string) => (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    assert.equal((error as { statusCode?: number }).statusCode, 409);
    return true;
};
test.beforeEach(() => { revokeSlackToolScope(); resetVerifiedSlackWorkspace(); });
test.afterEach(() => revokeSlackToolScope());

test('live lease and frozen grant distinguish server-owned, operator, turn, and ordinary grants', () => {
    const owned = grant();
    assert.equal(Object.isFrozen(owned.value), true);
    assert.equal(owned.value.serverOwnedDelivery, true);
    assert.deepEqual([...activeServerOwnedChannels()], [LEASED]);
    assert.throws(() => assertSlackWriteAllowed({ kind: 'turn', grant: owned.value }, owned.value, LEASED), refusal('slack_server_owned_delivery'));
    assert.throws(() => assertSlackWriteAllowed({ kind: 'operator', context: owned.value }, owned.value, OTHER), refusal('slack_server_owned_delivery'));
    assert.throws(() => assertSlackWriteAllowed(operator, null, LEASED), refusal('slack_channel_leased_by_heartbeat'));
    assert.doesNotThrow(() => assertSlackWriteAllowed(operator, null, OTHER));
    const ordinary = grant(OTHER, false);
    assert.doesNotThrow(() => assertSlackWriteAllowed({ kind: 'turn', grant: ordinary.value }, ordinary.value, LEASED));
    assert.doesNotThrow(() => assertSlackWriteAllowed({ kind: 'operator', context: ordinary.value }, ordinary.value, OTHER));
    revokeSlackToolGrant(owned.id);
    assert.deepEqual([...activeServerOwnedChannels()], []);
    assert.doesNotThrow(() => assertSlackWriteAllowed(operator, null, LEASED));
});

test('channel sends reject root, thread and file writes; lease release and other channel remain usable', async () => {
    const previous = settings.slack;
    settings.slack = { ...previous, enabled: true, botToken: TOKEN, channelIds: [LEASED, OTHER] };
    const delivered: Array<{ target?: { targetId: string }; type: string }> = [];
    registerSendTransport('slack', async request => { delivered.push(request); return { ok: true, sent: true }; });
    const app = express(); app.use(express.json());
    registerMessagingRoutes(app, (_req, _res, next) => next(), { validateSlackOperator: token => token === 'test-operator', isFullAccess: () => true });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const post = async (body: object, header?: string) => {
        const response = await fetch(base + '/api/channel/send', { method: 'POST', headers: { 'content-type': 'application/json',
            ...(header ? { 'x-jaw-slack-grant': header } : { 'x-jaw-slack-operator': 'test-operator' }) }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as { code?: string; ok?: boolean } };
    };
    const dir = mkdtempSync(join(tmpdir(), 'slack-write-file-'));
    const file = join(dir, 'fixture.txt'); writeFileSync(file, 'fixture');
    try {
        const owned = grant();
        for (const thread of [undefined, THREAD]) {
            const body = { channel: 'slack', type: 'text', text: 'test', target: target(LEASED, thread) };
            assert.deepEqual(await post(body), { status: 409, body: { error: 'slack_channel_leased_by_heartbeat', code: 'slack_channel_leased_by_heartbeat' } });
            const ownedBody = { ...body, target: target(LEASED, THREAD) };
            assert.equal((await post(ownedBody, owned.secret)).body.code, 'slack_server_owned_delivery');
        }
        assert.equal((await post({ channel: 'slack', type: 'document', file_path: file, target: target(LEASED) })).body.code, 'slack_channel_leased_by_heartbeat');
        assert.equal((await post({ channel: 'slack', type: 'document', file_path: file, target: target(LEASED, THREAD) }, owned.secret)).body.code, 'slack_server_owned_delivery');
        assert.equal((await post({ channel: 'slack', type: 'text', text: 'other', target: target(OTHER) })).body.ok, true);
        assert.equal(delivered.length, 1);
        // Heartbeat final delivery calls sendChannelOutput directly.
        assert.equal((await sendChannelOutput({ channel: 'slack', type: 'text', text: 'server', target: target(LEASED) })).ok, true);
        assert.equal(delivered.length, 2);
        revokeSlackToolGrant(owned.id);
        assert.equal((await post({ channel: 'slack', type: 'text', text: 'released', target: target(LEASED) })).body.ok, true);
        assert.equal(delivered.length, 3);
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        settings.slack = previous; rmSync(dir, { recursive: true, force: true });
    }
});

test('action post, schedule and reaction reject writes while history and replies remain readable', async () => {
    const db = new Database(':memory:');
    try {
        const methods: string[] = [];
        const fetchImpl: typeof fetch = async (url, init) => {
            const method = String(url).split('/').at(-1)!; methods.push(method);
            const body = String(init?.body ?? '');
            if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, team_id: 'T0TEST', user_id: 'U0TESTBOT' }), { headers: { 'x-oauth-scopes': 'chat:write,channels:history,reactions:write' } });
            if (method === 'conversations.info') return new Response(JSON.stringify({ ok: true, channel: { id: LEASED, is_shared: false, is_ext_shared: false, context_team_id: 'T0TEST' } }));
            if (method === 'conversations.members') return new Response(JSON.stringify({ ok: true, members: ['U0TEST', 'U0TESTBOT'], response_metadata: { next_cursor: '' } }));
            if (method === 'conversations.history' || method === 'conversations.replies') return new Response(JSON.stringify({ ok: true, messages: [], response_metadata: { next_cursor: '' } }));
            return new Response(JSON.stringify({ ok: true, ts: '1700000000.000002' }));
        };
        const runtime = new SlackActionRuntime({ getToken: () => TOKEN, store: new SlackActionStore(db), fetchImpl, evidenceSource: 'fixture' });
        const write = (operation: string, method: string) => defineAction({ operation, mutates: true, scopes: [], methods: [method],
            parse(raw) { return baseAction(raw, ['threadTs'], true); },
            async execute(ctx) { await ctx.api(method, { channel: ctx.channel, text: 'test', name: 'eyes', timestamp: THREAD }); return ctx.result('verified'); } });
        const read = (method: string) => defineAction({ operation: `fixture.${method}`, mutates: false, scopes: [], methods: [method],
            parse(raw) { return baseAction(raw, [], false); },
            async execute(ctx) { await ctx.api(method, { channel: ctx.channel, ...(method.endsWith('replies') ? { ts: THREAD } : {}) }); return ctx.result('verified'); } });
        const owned = grant();
        for (const [index, [operation, method]] of [['interaction.url', 'chat.postMessage'], ['schedule.create', 'chat.scheduleMessage'], ['reaction.add', 'reactions.add']].entries()) {
            const input = { operation, channel: LEASED, invocationId: `inv-${index}` };
            await assert.rejects(runtime.execute(write(operation, method), input, operator), refusal('slack_channel_leased_by_heartbeat'));
            await assert.rejects(runtime.execute(write(operation, method), input, { kind: 'turn', grant: owned.value }), refusal('slack_server_owned_delivery'));
        }
        for (const method of ['conversations.history', 'conversations.replies']) {
            const input = { operation: `fixture.${method}`, channel: LEASED };
            assert.equal((await runtime.execute(read(method), input, operator)).ok, true);
            assert.equal((await runtime.execute(read(method), input, { kind: 'turn', grant: owned.value })).ok, true);
        }
        assert.equal(methods.some(method => ['chat.postMessage', 'chat.scheduleMessage', 'reactions.add'].includes(method)), false);
    } finally { db.close(); }
});

test('quote checks posting channel in both source/destination directions', async () => {
    const owned = grant();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
        const method = String(url).split('/').at(-1)!; calls.push(method);
        const body = String(init?.body ?? '');
        if (method === 'chat.getPermalink') return new Response(JSON.stringify({ ok: true, permalink: `https://example.slack.com/archives/${new URLSearchParams(body).get('channel')}/p1700000000000001` }));
        if (method === 'conversations.history') return new Response(JSON.stringify({ ok: true, messages: new URLSearchParams(body).get('channel') === OTHER
            ? [{ ts: '1700000000.000002', user: 'U0TESTBOT', text: 'source' }] : [{ ts: THREAD, user: 'U0TEST', text: 'source' }] }));
        if (method === 'users.info') return new Response(JSON.stringify({ ok: true, user: { id: 'U0TEST', name: 'test' } }));
        if (method === 'chat.postMessage') return new Response(JSON.stringify({ ok: true, ts: '1700000000.000002' }));
        if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, team_id: 'T0TEST', user_id: 'U0TESTBOT' }));
        if (method === 'conversations.info') return new Response(JSON.stringify({ ok: true, channel: { id: new URLSearchParams(body).get('channel'), is_shared: false, is_ext_shared: false, context_team_id: 'T0TEST' } }));
        if (method === 'conversations.members') return new Response(JSON.stringify({ ok: true, members: ['U0TEST', 'U0TESTBOT'], response_metadata: { next_cursor: '' } }));
        throw new Error(method);
    };
    await assert.rejects(publishSlackQuote(TOKEN, operator, { source: { channel: OTHER, ts: THREAD }, destination: target(LEASED) }, { fetchImpl }), refusal('slack_channel_leased_by_heartbeat'));
    await assert.rejects(publishSlackQuote(TOKEN, { kind: 'turn', grant: owned.value }, { source: { channel: OTHER, ts: THREAD } }, { fetchImpl }), refusal('slack_server_owned_delivery'));
    assert.deepEqual(calls, []);
    const result = await publishSlackQuote(TOKEN, operator, { source: { channel: LEASED, ts: THREAD }, destination: target(OTHER) }, { fetchImpl });
    assert.notEqual(result.error, 'slack_channel_leased_by_heartbeat');
    assert.ok(calls.includes('chat.postMessage'));
});
