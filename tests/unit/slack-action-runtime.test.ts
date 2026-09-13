import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SlackActionRuntime } from '../../src/slack/action-runtime.ts';
import { SlackActionStore } from '../../src/slack/action-store.ts';
import { SlackActionRateLimiter } from '../../src/slack/action-rate.ts';
import { defineAction, type ActionContext, type ActionResult } from '../../src/slack/action-types.ts';
import { baseAction, requiredText } from '../../src/slack/task-input.ts';
import { reserveSlackToolGrant, activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolScope, slackCredentialKey } from '../../src/slack/tool-context.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import { RtsOutputStore, configureRtsOutputStore } from '../../src/slack/rts-output-store.ts';
import type { SlackToolPrincipal } from '../../src/slack/tool-access.ts';

const TOKEN = 'fixture-action-token';
const operator: SlackToolPrincipal = { kind: 'operator' };
const input = { operation: 'fixture.write', channel: 'C1', invocationId: 'one', text: 'hello' };
const json = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify(data), { headers });
test.beforeEach(() => { resetVerifiedSlackWorkspace(); revokeSlackToolScope(); configureRtsOutputStore(undefined); });
test.afterEach(() => { revokeSlackToolScope(); configureRtsOutputStore(undefined); });
function turn(threadId?: string): SlackToolPrincipal {
    assert.equal(reserveSlackToolGrant({ teamId: 'T1', actorId: 'U1', credentialKey: slackCredentialKey(TOKEN),
        destination: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1', ...(threadId ? { threadId } : {}) } },
    { requestId: 'request', scope: 'scope', chatSessionId: 'chat' }), true);
    const secret = activateSlackToolGrant('request', 'scope', 'chat'); assert.ok(secret);
    const grant = resolveSlackToolGrant(secret); assert.ok(grant); return { kind: 'turn', grant };
}
function fixture(t: TestContext, scopes: string | null = 'chat:write,channels:history') {
    const db = new Database(':memory:'); t.after(() => db.close());
    const store = new SlackActionStore(db); const calls: string[] = [];
    let currentToken = TOKEN; let actorPresent = true;
    let reply: (method: string, body: Record<string, unknown>) => Promise<Response> = async () => json({ ok: true, ts: '2.000001' });
    const fetchImpl: typeof fetch = async (url, init) => {
        const method = new URL(String(url)).pathname.split('/').at(-1)!; calls.push(method);
        const headers = new Headers(init?.headers);
        const body = headers.get('content-type')?.includes('application/json')
            ? JSON.parse(String(init?.body)) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(String(init?.body)));
        if (method === 'auth.test') return json({ ok: true, team_id: 'T1', user_id: 'UBOT' }, scopes === null ? {} : { 'x-oauth-scopes': scopes });
        if (method === 'conversations.info') return json({ ok: true, channel: { id: body.channel, is_shared: false, is_ext_shared: false, context_team_id: 'T1' } });
        if (method === 'conversations.members') return json({ ok: true, members: actorPresent ? ['U1', 'UBOT'] : ['UBOT'], response_metadata: { next_cursor: '' } });
        return reply(method, body);
    };
    const waits: number[] = []; let now = 0;
    const rateLimiter = new SlackActionRateLimiter(() => now, async ms => { waits.push(ms); now += ms; });
    const options = { getToken: () => currentToken, store, fetchImpl, rateLimiter, evidenceSource: 'fixture' as const };
    return { db, store, calls, waits, runtime: new SlackActionRuntime(options), options,
        reply(fn: typeof reply) { reply = fn; }, rotate() { currentToken = 'fixture-replacement'; }, removeActor() { actorPresent = false; } };
}
function action(execute: (ctx: ActionContext, text: string) => Promise<ActionResult>, options: { mutates?: boolean; methods?: string[]; scopes?: string[]; requiresInbound?: boolean } = {}) {
    const mutates = options.mutates ?? true;
    return defineAction({ operation: 'fixture.write', mutates, scopes: options.scopes ?? ['chat:write'], methods: options.methods ?? ['chat.postMessage'],
        ...(options.requiresInbound ? { requiresInbound: true } : {}),
        parse(raw) { return { ...baseAction(raw, ['text'], mutates), text: requiredText(raw.text, 2000) }; },
        execute(ctx, args) { return execute(ctx, args.text); } });
}
const write = action(async (ctx, text) => { const result = await ctx.api('chat.postMessage', { channel: ctx.channel, text }); return result.ok ? ctx.result('verified') : ctx.fail('slack_write_failed'); });

for (const [label, scopes, error] of [['unknown', null, /scopes_unverified/], ['missing', 'channels:history', /scopes_missing/]] as const) {
    test(`${label} scopes reject before action dispatch or reservation`, async t => {
        const f = fixture(t, scopes);
        await assert.rejects(f.runtime.execute(write, input, operator), error);
        assert.deepEqual(f.calls, ['auth.test']); assert.equal(f.store.invocation('T1', 'operator', 'one'), undefined);
    });
}
test('strict input rejects oversized text and unknown fields before even auth', async t => {
    const f = fixture(t);
    for (const raw of [{ ...input, text: 'x'.repeat(2001) }, { ...input, method: 'chat.delete' }]) await assert.rejects(f.runtime.execute(write, raw, operator));
    assert.deepEqual(f.calls, []);
});
test('undeclared methods, read-only writes and changed destination never reach Slack', async t => {
    const f = fixture(t);
    const definitions = [
        action(async ctx => { await ctx.api('chat.delete', { channel: 'C1', ts: '1.0' }); return ctx.result('verified'); }),
        action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C1', text: 'no' }); return ctx.result('verified'); }, { mutates: false }),
        action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C2', text: 'no' }); return ctx.result('verified'); }),
    ];
    for (const [i, definition] of definitions.entries()) {
        const result = await f.runtime.execute(definition, { ...input, invocationId: `bad${i}` }, operator);
        assert.equal(result.verification, 'failed'); assert.equal(result.retryable, false);
    }
    assert.deepEqual(f.calls, ['auth.test']);
});
test('completed invocation replays after store wrapper reopen; changed payload conflicts', async t => {
    const f = fixture(t); const first = await f.runtime.execute(write, input, operator);
    assert.equal(first.verification, 'verified'); assert.deepEqual(first.resourceIds, ['2.000001']);
    const reopened = new SlackActionRuntime({ ...f.options, store: new SlackActionStore(f.db) });
    assert.deepEqual(await reopened.execute(write, input, operator), first);
    await assert.rejects(reopened.execute(write, { ...input, text: 'different' }, operator), /conflict/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
    assert.equal(f.store.verified('T1', slackCredentialKey(TOKEN), 'fixture.write'), null);
});
test('pending concurrent invocation cannot dispatch twice', async t => {
    const f = fixture(t); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.reply(async () => { entered(); await gate; return json({ ok: true, ts: '2.000001' }); });
    const first = f.runtime.execute(write, input, operator); await ready;
    try { await assert.rejects(f.runtime.execute(write, input, operator), /conflict_or_unknown/); }
    finally { release(); }
    await first; assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
});
test('turn fixture proves membership and rejects foreign destination and revoked membership', async t => {
    const f = fixture(t); const principal = turn();
    await assert.rejects(f.runtime.execute(write, { ...input, channel: 'C2' }, principal), /destination_mismatch/);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.runtime.execute(write, input, principal)).ok, true);
    f.removeActor();
    await assert.rejects(f.runtime.execute(write, { ...input, invocationId: 'two' }, principal), /actor_not_member/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
    assert.equal(f.store.verified('T1', slackCredentialKey(TOKEN), 'fixture.write'), null);
});
for (const mode of ['rotate', 'cancel'] as const) test(`${mode} immediately before write leaves zero mutations`, async t => {
    const f = fixture(t); const controller = new AbortController();
    const definition = action(async ctx => {
        await ctx.api('chat.postMessage', { channel: 'C1', text: 'no' }, () => { if (mode === 'rotate') f.rotate(); else controller.abort(); });
        return ctx.result('verified');
    });
    const result = await f.runtime.execute(definition, input, operator, controller.signal);
    assert.equal(result.ok, false); assert.match(result.error!, mode === 'rotate' ? /credential_changed/ : /cancelled/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 0);
});
test('acknowledged IDs survive later failure; unknown invocation is never retried', async t => {
    const f = fixture(t);
    const definition = action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C1', text: 'sent' }); throw new Error('private failure body'); });
    const result = await f.runtime.execute(definition, input, operator);
    assert.equal(result.verification, 'unknown'); assert.deepEqual(result.resourceIds, ['2.000001']); assert.equal(result.retryable, false);
    assert.equal(result.error, 'slack_action_failed');
    assert.equal(f.store.invocation('T1', 'operator', 'one')?.status, 'unknown');
    await assert.rejects(new SlackActionRuntime({ ...f.options, store: new SlackActionStore(f.db) }).execute(definition, input, operator), /conflict_or_unknown/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
});
test('429 stops handler batch without retry or subsequent mutation', async t => {
    const f = fixture(t); f.reply(async () => json({ ok: false, error: 'ratelimited' }, { 'retry-after': '1' }));
    const definition = action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C1', text: 'first' }); await ctx.api('chat.postMessage', { channel: 'C1', text: 'second' }); return ctx.result('verified'); });
    const result = await f.runtime.execute(definition, input, operator);
    assert.equal(result.verification, 'unknown'); assert.equal(result.status, 429); assert.equal(result.retryable, false);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
});
test('missing inbound readiness denies choice operation before network', async t => {
    const f = fixture(t);
    await assert.rejects(f.runtime.execute(action(async ctx => ctx.result('verified'), { requiresInbound: true }), input, operator), /inbound_unavailable/);
    assert.deepEqual(f.calls, []);
});
test('response body cap cancels streaming input and cannot report verified', async t => {
    const f = fixture(t); let pulls = 0; let cancelled = false;
    f.reply(async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(262144)); if (pulls === 40) c.close(); }, cancel() { cancelled = true; } })));
    const read = action(async ctx => { const response = await ctx.api('pins.list', { channel: 'C1' }); return response.ok ? ctx.result('verified', response.data) : ctx.fail('slack_read_failed'); }, { mutates: false, methods: ['pins.list'], scopes: [] });
    const result = await f.runtime.execute(read, input, operator);
    assert.equal(result.ok, false); assert.equal(cancelled, true); assert.ok(pulls < 40); assert.equal(result.retryable, false);
});
test('model result and persisted resource metadata redact fixture secrets', async t => {
    const f = fixture(t); const secret = 'xoxb-test-only-redaction-canary';
    const definition = action(async ctx => { ctx.remember('canvas', 'F1', { note: secret }); return ctx.result('verified', { note: secret }); });
    const result = await f.runtime.execute(definition, input, operator);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!f.store.invocation('T1', 'operator', 'one')!.receipt_json!.includes(secret));
    assert.ok(!JSON.stringify(f.store.resource('T1', 'canvas', 'F1')).includes(secret));
});
test('RTS marker, registered output and held destination reads exclude bodies and links', async t => {
    const f = fixture(t); const privacy = new RtsOutputStore(f.db); configureRtsOutputStore(privacy);
    privacy.record('T1', 'C1', '3.0');
    f.reply(async () => json({ ok: true, items: [{ message: { ts: '2.0', text: 'RTS_CANARY', permalink: 'https://example.com/RTS_CANARY', blocks: [{ type: 'rich_text', block_id: 'jaw_rts_response_v1:old' }] } }, { message: { ts: '3.0', text: 'RTS_CANARY' } }, { message: { ts: '4.0', text: 'ordinary' } }] }));
    const read = action(async ctx => { const response = await ctx.api('pins.list', { channel: 'C1' }); return ctx.result('verified', response.data); }, { mutates: false, methods: ['pins.list'], scopes: [] });
    const first = await f.runtime.execute(read, input, operator);
    assert.ok(!JSON.stringify(first).includes('RTS_CANARY')); assert.ok(JSON.stringify(first).includes('ordinary'));
    assert.equal(privacy.begin('T1', 'C1', 'held'), true);
    const second = await f.runtime.execute(read, input, operator);
    assert.ok(!JSON.stringify(second).includes('ordinary')); assert.ok(JSON.stringify(second).includes('contentExcluded'));
});
test('shared limiter separates workspace/method while serializing same-key reservations', async () => {
    const waits: number[] = [];
    const limiter = new SlackActionRateLimiter(() => 0, async ms => { waits.push(ms); });
    await limiter.admit('T1', 'pins.list'); await limiter.admit('T1', 'pins.list');
    await limiter.admit('T2', 'pins.list'); await limiter.admit('T1', 'chat.postMessage'); await limiter.admit('T1', 'chat.postMessage');
    assert.deepEqual(waits, [3000, 1200]);
    await limiter.admit('T1', 'pins.list'); await limiter.admit('T1', 'pins.list');
    await assert.rejects(limiter.admit('T1', 'pins.list'), /rate_limited/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(limiter.admit('T3', 'pins.list', controller.signal), /cancelled/);
});

test('cancellation after acknowledged post preserves ID and durable unknown outcome', async t => {
    const f = fixture(t); const controller = new AbortController();
    f.reply(async () => json({ ok: true, ts: '9.000001' }));
    const definition = action(async ctx => {
        const response = await ctx.api('chat.postMessage', { channel: 'C1', text: 'sent' });
        assert.equal(response.ok, true);
        controller.abort();
        return ctx.result('verified');
    });
    const result = await f.runtime.execute(definition, input, operator, controller.signal);
    assert.equal(result.ok, false); assert.equal(result.verification, 'unknown');
    assert.deepEqual(result.resourceIds, ['9.000001']); assert.equal(result.retryable, false);
    assert.equal(f.store.invocation('T1', 'operator', 'one')?.status, 'unknown');
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 1);
});
test('revoked turn before dispatch cannot exploit already completed membership checks', async t => {
    const f = fixture(t); const principal = turn();
    const definition = action(async ctx => {
        await ctx.api('chat.postMessage', { channel: 'C1', text: 'no' }, () => revokeSlackToolScope());
        return ctx.result('verified');
    });
    const result = await f.runtime.execute(definition, input, principal);
    assert.equal(result.ok, false); assert.equal(result.retryable, false);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 0);
});
test('oversized model-facing result is partial and never creates verified evidence', async t => {
    const f = fixture(t);
    const definition = action(async ctx => ctx.result('verified', { text: 'x'.repeat(100000) }), { mutates: false, scopes: [], methods: [] });
    const result = await f.runtime.execute(definition, input, operator);
    assert.equal(result.ok, false); assert.equal(result.verification, 'partial'); assert.equal(result.partial, true);
    assert.ok(JSON.stringify(result).length < 100000);
    assert.equal(f.store.verified('T1', slackCredentialKey(TOKEN), 'fixture.write'), null);
});

for (const mode of ['cancel', 'rotate'] as const) test(`${mode} during shared pacing cannot dispatch a reserved invocation`, async t => {
    const f = fixture(t); const controller = new AbortController();
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rateLimiter = new SlackActionRateLimiter(() => 0, async () => { entered(); await gate; });
    await rateLimiter.admit('T1', 'chat.postMessage');
    const runtime = new SlackActionRuntime({ ...f.options, rateLimiter });
    const pending = runtime.execute(write, input, operator, controller.signal);
    await waiting;
    try {
        assert.equal(f.store.invocation('T1', 'operator', 'one')?.status, 'reserved');
        const reopened = new SlackActionRuntime({ ...f.options, store: new SlackActionStore(f.db), rateLimiter });
        await assert.rejects(reopened.execute(write, input, operator), /conflict_or_unknown/);
        if (mode === 'cancel') controller.abort(); else f.rotate();
    } finally { release(); }
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.verification, 'failed');
    assert.match(result.error!, mode === 'cancel' ? /cancelled/ : /credential_changed/);
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 0);
    assert.equal(f.store.invocation('T1', 'operator', 'one')?.status, 'failed');
});

test('limiter capacity fails closed and expired keys can be reclaimed with injected time', async () => {
    let now = 0;
    const limiter = new SlackActionRateLimiter(() => now, async () => { throw new Error('unexpected pacing wait'); });
    for (let i = 0; i < 1024; i++) await limiter.admit(`T${i}`, 'pins.list');
    await assert.rejects(limiter.admit('TNEW', 'pins.list'), /rate_capacity/);
    now = 3001;
    await limiter.admit('TNEW', 'pins.list');
});

test('large mutating readback persists an omission receipt without losing acknowledged IDs', async t => {
    const f = fixture(t);
    // Below the agent projection cap, but above the durable receipt cap.
    const body = '한'.repeat(7000);
    f.reply(async method => method === 'chat.postMessage'
        ? json({ ok: true, ts: '8.000001' })
        : json({ ok: true, details: body }));
    const definition = action(async ctx => {
        const posted = await ctx.api('chat.postMessage', { channel: 'C1', text: 'sent' });
        assert.equal(posted.ok, true);
        const readback = await ctx.api('pins.list', { channel: 'C1' });
        assert.equal(readback.ok, true);
        const result = ctx.result('verified', readback.data);
        // Prove this exercises receipt compaction, not earlier projection truncation.
        assert.equal(result.verification, 'verified');
        assert.ok(Buffer.byteLength(JSON.stringify(result)) > 16384);
        return result;
    }, { methods: ['chat.postMessage', 'pins.list'] });
    const result = await f.runtime.execute(definition, input, operator);
    assert.equal(result.ok, false); assert.equal(result.verification, 'partial');
    assert.equal(result.partial, true); assert.equal(result.retryable, false);
    assert.deepEqual(result.resourceIds, ['8.000001']);
    assert.deepEqual(result.data, { omitted: true, reason: 'receipt_byte_limit' });
    const reopenedStore = new SlackActionStore(f.db);
    const saved = reopenedStore.invocation('T1', 'operator', 'one');
    assert.equal(saved?.status, 'unknown'); assert.ok(saved?.receipt_json);
    assert.ok(Buffer.byteLength(saved.receipt_json) <= 16384);
    assert.ok(!saved.receipt_json.includes(body));
    assert.deepEqual(JSON.parse(saved.receipt_json), result);
    assert.equal(reopenedStore.verified('T1', slackCredentialKey(TOKEN), 'fixture.write'), null);
    const callsBeforeReplay = [...f.calls];
    await assert.rejects(new SlackActionRuntime({ ...f.options, store: reopenedStore }).execute(definition, input, operator), /conflict_or_unknown/);
    assert.deepEqual(f.calls, callsBeforeReplay);
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 1);
});


function autoEnforced(threadId = '1710000000.000200'): SlackToolPrincipal {
    // C_HIT = C1 / 1710000000.000200. Auto + enforceDestination is kind:operator.
    assert.equal(reserveSlackToolGrant({
        teamId: 'T1', actorId: 'U1', credentialKey: slackCredentialKey(TOKEN),
        destination: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1', threadId },
        enforceDestination: true,
    }, { requestId: 'mw-hit', scope: 'mention-watch:slack:C1:1710000000.000200', chatSessionId: 'sess-hit' }), true);
    const secret = activateSlackToolGrant('mw-hit', 'mention-watch:slack:C1:1710000000.000200', 'sess-hit');
    assert.ok(secret);
    const grant = resolveSlackToolGrant(secret); assert.ok(grant);
    return { kind: 'operator', source: 'full-local', context: grant };
}

test('turn writes inherit the captured thread and cannot override it', async t => {
    const f = fixture(t); const principal = turn('10.000001');
    const bodies: Record<string, unknown>[] = [];
    f.reply(async (_method, body) => { bodies.push(body); return json({ ok: true, ts: '11.000001' }); });
    assert.equal((await f.runtime.execute(write, input, principal)).ok, true);
    assert.equal(bodies[0]?.thread_ts, '10.000001');
    const bad = action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C1', text: 'bad', thread_ts: '20.000001' }); return ctx.result('verified'); });
    const refused = await f.runtime.execute(bad, { ...input, invocationId: 'bad-thread' }, principal);
    assert.equal(refused.error, 'slack_destination_thread_mismatch');
    assert.equal(bodies.length, 1);
    const owned = f.store.resource('T1', 'message', '11.000001');
    assert.equal(owned?.actor, 'U1'); assert.equal(owned?.metadata.threadTs, '10.000001');
});

test('Auto plus enforced grant cannot leave C1 / 1710000000.000200 via chat.postMessage', async t => {
    const f = fixture(t); const principal = autoEnforced();
    const bodies: Record<string, unknown>[] = [];
    f.reply(async (_method, body) => { bodies.push(body); return json({ ok: true, ts: '12.000001' }); });
    assert.equal((await f.runtime.execute(write, input, principal)).ok, true);
    assert.equal(bodies[0]?.thread_ts, '1710000000.000200');
    await assert.rejects(
        f.runtime.execute(write, { ...input, channel: 'C2', invocationId: 'other-channel' }, principal),
        (error: unknown) => (error as { code?: string }).code === 'slack_destination_mismatch',
    );
    const bad = action(async ctx => { await ctx.api('chat.postMessage', { channel: 'C1', text: 'bad', thread_ts: '1710000000.000300' }); return ctx.result('verified'); });
    const refused = await f.runtime.execute(bad, { ...input, invocationId: 'other-thread' }, principal);
    assert.equal(refused.error, 'slack_destination_thread_mismatch');
    assert.equal(bodies.length, 1);
});

test('Interactive Auto without enforceDestination may still name another dest', async t => {
    const f = fixture(t);
    const bodies: Record<string, unknown>[] = [];
    f.reply(async (_method, body) => { bodies.push(body); return json({ ok: true, ts: '13.000001' }); });
    const result = await f.runtime.execute(write, { ...input, channel: 'C2', invocationId: 'interactive-other' }, { kind: 'operator', source: 'full-local' });
    assert.equal(result.ok, true);
    assert.equal(bodies[0]?.channel, 'C2');
});

for (const defect of ['absent', 'actor', 'thread', 'credential'] as const) test(`message mutation rejects ${defect} ownership before write`, async t => {
    const f = fixture(t); const principal = turn('10.000001');
    if (defect !== 'absent') f.store.remember({ workspace: 'T1', kind: 'message', id: '11.000001', channel: 'C1', botUserId: 'UBOT',
        actor: defect === 'actor' ? 'UOTHER' : 'U1', credentialKey: defect === 'credential' ? 'old-key' : slackCredentialKey(TOKEN),
        metadata: { threadTs: defect === 'thread' ? '20.000001' : '10.000001' } });
    const modify = action(async ctx => { await ctx.api('chat.delete', { channel: 'C1', ts: '11.000001' }); return ctx.result('verified'); }, { methods: ['chat.delete'] });
    const result = await f.runtime.execute(modify, input, principal);
    assert.equal(result.error, 'slack_resource_ownership_unverified');
    assert.equal(f.calls.includes('chat.delete'), false);
});

test('known actor-owned message mutation succeeds while operator can manage untracked messages', async t => {
    const f = fixture(t); const principal = turn('10.000001');
    f.store.remember({ workspace: 'T1', kind: 'message', id: '11.000001', channel: 'C1', botUserId: 'UBOT', actor: 'U1', credentialKey: slackCredentialKey(TOKEN), metadata: { threadTs: '10.000001' } });
    const modify = action(async ctx => { await ctx.api('chat.delete', { channel: 'C1', ts: '11.000001' }); return ctx.result('verified'); }, { methods: ['chat.delete'] });
    assert.equal((await f.runtime.execute(modify, input, principal)).verification, 'verified');
    assert.equal((await f.runtime.execute(modify, { ...input, invocationId: 'operator-write' }, operator)).verification, 'verified');
    assert.equal(f.calls.filter(method => method === 'chat.delete').length, 2);
});
