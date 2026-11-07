import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SlackActionRuntime } from '../../src/slack/action-runtime.ts';
import { SlackActionStore } from '../../src/slack/action-store.ts';
import { SlackActionRateLimiter } from '../../src/slack/action-rate.ts';
import { defineAction, type ActionContext, type ActionResult } from '../../src/slack/action-types.ts';
import { baseAction, requiredText } from '../../src/slack/task-input.ts';
import { reserveSlackToolGrant, activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolGrant, revokeSlackToolScope, slackCredentialKey } from '../../src/slack/tool-context.ts';
import { interactionActions, consumeSlackInteractionCallback } from '../../src/slack/actions-interactions.ts';
import { SlackInteractionStore, configureSlackInteractionStore, type SlackInteraction } from '../../src/slack/interaction-store.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import { RtsOutputStore, configureRtsOutputStore } from '../../src/slack/rts-output-store.ts';
import type { SlackToolPrincipal } from '../../src/slack/tool-access.ts';

const TOKEN = 'fixture-action-token';
const operator: SlackToolPrincipal = { kind: 'operator' };
const input = { operation: 'fixture.write', channel: 'C1', invocationId: 'one', text: 'hello' };
const json = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify(data), { headers });
test.beforeEach(() => { resetVerifiedSlackWorkspace(); revokeSlackToolScope(); configureRtsOutputStore(undefined); });
test.afterEach(() => { revokeSlackToolScope(); configureRtsOutputStore(undefined); });
function turn(threadId?: string, requestId = 'request', actorId = 'U1'): SlackToolPrincipal {
    assert.equal(reserveSlackToolGrant({ teamId: 'T1', actorId, credentialKey: slackCredentialKey(TOKEN),
        destination: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1', ...(threadId ? { threadId } : {}) } },
    { requestId, scope: 'scope', chatSessionId: 'chat' }), true);
    const secret = activateSlackToolGrant(requestId, 'scope', 'chat'); assert.ok(secret);
    const grant = resolveSlackToolGrant(secret); assert.ok(grant); return { kind: 'turn', grant };
}
function fixture(t: TestContext, scopes: string | null = 'chat:write,channels:history', identity = { team: 'T1', user: 'UBOT' }) {
    const db = new Database(':memory:'); t.after(() => db.close());
    const store = new SlackActionStore(db); const calls: string[] = [];
    let currentToken = TOKEN; let actorPresent = true;
    let reply: (method: string, body: Record<string, unknown>) => Promise<Response> = async () => json({ ok: true, ts: '2.000001' });
    const fetchImpl: typeof fetch = async (url, init) => {
        const method = new URL(String(url)).pathname.split('/').at(-1)!; calls.push(method);
        const headers = new Headers(init?.headers);
        const body = headers.get('content-type')?.includes('application/json')
            ? JSON.parse(String(init?.body)) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(String(init?.body)));
        if (method === 'auth.test') return json({ ok: true, team_id: identity.team, user_id: identity.user }, scopes === null ? {} : { 'x-oauth-scopes': scopes });
        if (method === 'conversations.info') return json({ ok: true, channel: { id: body.channel, is_shared: false, is_ext_shared: false, context_team_id: identity.team } });
        if (method === 'conversations.members') return json({ ok: true, members: actorPresent ? ['U1', identity.user] : [identity.user], response_metadata: { next_cursor: '' } });
        return reply(method, body);
    };
    const waits: number[] = []; let now = 0;
    const rateLimiter = new SlackActionRateLimiter(() => now, async ms => { waits.push(ms); now += ms; });
    const options = { getToken: () => currentToken, store, fetchImpl, rateLimiter, evidenceSource: 'fixture' as const };
    return { db, store, calls, waits, runtime: new SlackActionRuntime(options), options,
        reply(fn: typeof reply) { reply = fn; }, rotate() { currentToken = 'fixture-replacement'; }, removeActor() { actorPresent = false; } };
}

const choice = interactionActions.find(definition => definition.operation === 'interaction.choice')!;
const choiceInput = { operation: 'interaction.choice', channel: 'C1', invocationId: 'choice', text: 'Choose', choices: [{ label: 'Approve', value: 'approve' }] };
function choiceFixture(t: TestContext, identity = { team: 'T1', user: 'UBOT' }) {
    const f = fixture(t, undefined, identity);
    const interactions = new SlackInteractionStore(f.db);
    configureSlackInteractionStore(interactions, { getToken: () => f.options.getToken() });
    configureRtsOutputStore(new RtsOutputStore(f.db));
    t.after(() => { configureSlackInteractionStore(null); configureRtsOutputStore(undefined); });
    let posted: Record<string, unknown> | undefined;
    f.reply(async (method, body) => {
        if (method === 'chat.postMessage') { posted = structuredClone(body); return json({ ok: true, channel: 'C1', ts: '2.000001' }); }
        if (method === 'conversations.history') return json({ ok: true, messages: [{ ts: '2.000001', user: identity.user, text: posted?.text, blocks: posted?.blocks }] });
        throw new Error(`unexpected method ${method}`);
    });
    function row() {
        const record = f.db.prepare('SELECT id FROM slack_choice_interactions').get() as { id: string } | undefined;
        return record ? interactions.get(record.id) : undefined;
    }
    function count(table: 'slack_choice_interactions' | 'slack_tool_invocations') {
        return (f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return { ...f, interactions, row, count, runtime: new SlackActionRuntime({ ...f.options, inboundReady: () => true }) };
}
function capturedOperator(actor = 'U1') {
    const captured = turn(undefined, 'request', actor);
    if (captured.kind !== 'turn') throw new Error('expected a captured turn grant');
    return { kind: 'operator', source: 'full-local', context: captured.grant } as const;
}
function callback(row: SlackInteraction, user = 'U1') {
    const option = row.options[0]!;
    return { type: 'block_actions', team: { id: row.workspace }, user: { id: user },
        container: { type: 'message', channel_id: row.channel, message_ts: row.messageTs ?? '2.000001' },
        actions: [{ type: 'button', block_id: row.blockId, action_id: option.actionId, value: option.wireValue }] };
}

test('T-a real choice binds the captured actor and accepts only their callback', async t => {
    const f = choiceFixture(t); const principal = capturedOperator();
    const result = await f.runtime.execute(choice, choiceInput, principal);
    assert.equal(result.verification, 'verified');
    const row = f.row(); assert.ok(row); assert.equal(row.actor, 'U1');
    assert.deepEqual(await consumeSlackInteractionCallback(callback(row, 'UOTHER'), TOKEN, f.options.fetchImpl), { accepted: false });
    assert.equal(f.row()?.selectedValue, null);
    assert.deepEqual(await consumeSlackInteractionCallback(callback(row), TOKEN, f.options.fetchImpl), { accepted: true });
    assert.equal(f.row()?.selectedValue, 'approve');
});

for (const [name, principal] of [
    ['plain operator', { kind: 'operator' }],
    ['full-local without context', { kind: 'operator', source: 'full-local' }],
] as const) test(`T-b real choice rejects ${name}`, async t => {
    const f = choiceFixture(t);
    const result = await f.runtime.execute(choice, choiceInput, principal);
    assert.equal(result.verification, 'failed'); assert.equal(result.error, 'slack_interaction_turn_required');
    assert.equal(f.count('slack_choice_interactions'), 0);
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 0);
});

for (const mode of ['revoked', 'expired', 'credential rotated', 'team mismatch'] as const) test(`T-c real choice rejects ${mode} grant before reservation`, async t => {
    if (mode === 'expired') t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
    const f = choiceFixture(t, { team: mode === 'team mismatch' ? 'T2' : 'T1', user: 'UBOT' });
    const principal = capturedOperator();
    if (mode === 'revoked') revokeSlackToolGrant(principal.context.requestId);
    if (mode === 'expired') t.mock.timers.setTime(principal.context.expiresAt);
    if (mode === 'credential rotated') f.rotate();
    await assert.rejects(f.runtime.execute(choice, choiceInput, principal), { code: 'slack_turn_grant_expired' });
    assert.equal(f.count('slack_tool_invocations'), 0); assert.equal(f.count('slack_choice_interactions'), 0);
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 0);
});

test('T-d captured grant does not change the operator actor on other operations', async t => {
    const f = choiceFixture(t); const principal = capturedOperator();
    const probe = action(async ctx => ctx.result('verified', { actor: ctx.actor, operator: ctx.operator }), { methods: [], scopes: [] });
    const result = await f.runtime.execute(probe, input, principal);
    assert.equal(result.verification, 'verified'); assert.deepEqual(result.data, { actor: 'operator', operator: true });
});

test('T-e grant revoked during pacing fails before dispatch and leaves an unbound choice', async t => {
    const f = choiceFixture(t); const principal = capturedOperator();
    const limiter = new SlackActionRateLimiter(() => 0, async () => { revokeSlackToolGrant(principal.context.requestId); });
    await limiter.admit('T1', 'chat.postMessage');
    const runtime = new SlackActionRuntime({ ...f.options, rateLimiter: limiter, inboundReady: () => true });
    const result = await runtime.execute(choice, choiceInput, principal);
    assert.equal(result.verification, 'failed'); assert.equal(result.error, 'slack_turn_grant_expired');
    assert.equal(f.store.invocation('T1', 'U1', 'choice')?.status, 'failed');
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 0);
    const row = f.row(); assert.ok(row); assert.equal(row.messageTs, null);
    assert.deepEqual(await consumeSlackInteractionCallback(callback(row), TOKEN, f.options.fetchImpl), { accepted: false });
});

test('T-f grant revoked during dispatched post remains unknown and replay never resends', async t => {
    const f = choiceFixture(t); const principal = capturedOperator();
    f.reply(async method => {
        assert.equal(method, 'chat.postMessage'); revokeSlackToolGrant(principal.context.requestId);
        return json({ ok: true, channel: 'C1', ts: '2.000001' });
    });
    const result = await f.runtime.execute(choice, choiceInput, principal);
    assert.equal(result.verification, 'unknown');
    assert.equal(f.store.invocation('T1', 'U1', 'choice')?.status, 'unknown');
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 1);
    const renewed = capturedOperator();
    await assert.rejects(f.runtime.execute(choice, choiceInput, renewed), { code: 'slack_invocation_conflict_or_unknown' });
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 1);
});

test('T-g bot-user captured actor cannot create a choice', async t => {
    const f = choiceFixture(t); const principal = capturedOperator('UBOT');
    await assert.rejects(f.runtime.execute(choice, choiceInput, principal), { code: 'slack_interaction_turn_required' });
    assert.equal(f.count('slack_tool_invocations'), 0); assert.equal(f.count('slack_choice_interactions'), 0);
    assert.equal(f.calls.filter(method => method === 'chat.postMessage').length, 0);
});
function action(execute: (ctx: ActionContext, text: string) => Promise<ActionResult>, options: { mutates?: boolean; methods?: string[]; scopes?: string[]; requiresInbound?: boolean } = {}) {
    const mutates = options.mutates ?? true;
    return defineAction({ operation: 'fixture.write', mutates, scopes: options.scopes ?? ['chat:write'], methods: options.methods ?? ['chat.postMessage'],
        ...(options.requiresInbound ? { requiresInbound: true } : {}),
        parse(raw) { return { ...baseAction(raw, ['text'], mutates), text: requiredText(raw.text, 2000) }; },
        execute(ctx, args) { return execute(ctx, args.text); } });
}
const write = action(async (ctx, text) => { const result = await ctx.api('chat.postMessage', { channel: ctx.channel, text }); return result.ok ? ctx.result('verified') : ctx.fail('slack_write_failed'); });

const interactiveActorProbe = defineAction({ operation: 'interaction.choice', mutates: true, scopes: [], methods: [], requiresInbound: true,
    parse(raw) { return { ...baseAction(raw, ['text'], true), text: requiredText(raw.text, 2000) }; },
    execute(ctx) { return Promise.resolve(ctx.result(ctx.operator ? 'failed' : 'verified', { actor: ctx.actor, operator: ctx.operator })); },
});

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

test('full-local Auto uses its captured turn grant for interactive choices', async t => {
    const f = fixture(t); const captured = turn();
    const runtime = new SlackActionRuntime({ ...f.options, inboundReady: () => true });
    const principal: SlackToolPrincipal = { kind: 'operator', source: 'full-local', context: captured.grant };
    const result = await runtime.execute(interactiveActorProbe,
        { operation: 'interaction.choice', channel: 'C1', invocationId: 'interactive-choice', text: 'Approve' }, principal);
    assert.equal(result.verification, 'verified');
    assert.deepEqual(result.data, { actor: 'U1', operator: false });
    assert.deepEqual(f.calls, ['auth.test']);
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

const threadWrite = defineAction({ operation: 'fixture.thread-write', mutates: true, scopes: ['chat:write'], methods: ['chat.postMessage'],
    parse(raw) { return { ...baseAction(raw, ['text', 'threadTs'], true), text: requiredText(raw['text'], 2000), threadTs: requiredText(raw['threadTs'], 100) }; },
    async execute(ctx, args) {
        const res = await ctx.api('chat.postMessage', { channel: ctx.channel, thread_ts: args.threadTs, text: args.text });
        return res.ok ? ctx.result('verified') : ctx.result('unknown');
    },
});
const heldInput = { operation: 'fixture.thread-write', channel: 'C1', invocationId: 'held-one', threadTs: '9.9', text: 'original intended operation' };
const readForRecovery = action(async ctx => ctx.result('verified', { checked: true }), { mutates: false, methods: [], scopes: [] });

for (const unknown of [false, true]) test(`persisted pre-dispatch thread denial resumes with new matching authority, unknown=${unknown}`, async t => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    t.after(() => { if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior; });
    const f = fixture(t);
    const old = turn('1.1', 'old-turn');
    await assert.rejects(f.runtime.execute(threadWrite, heldInput, old), /thread_mismatch/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 0);
    assert.equal(f.store.invocation('T1', 'U1', 'held-one'), undefined);
    revokeSlackToolScope();
    const reopened = new SlackActionRuntime({ ...f.options, store: new SlackActionStore(f.db) });
    const wrongThread = turn('1.1', 'wrong-turn');
    assert.equal((await reopened.execute(readForRecovery, input, wrongThread)).recovery, undefined);
    await assert.rejects(reopened.execute(threadWrite, { ...heldInput, threadTs: '1.1' }, wrongThread), /blocked_intent_mismatch/);
    const fresh = turn('9.9', 'new-turn');
    const context = await reopened.execute(readForRecovery, input, fresh);
    assert.equal(context.recovery?.held.length, 1);
    const held = context.recovery!.held[0]!;
    assert.deepEqual(held.requested, heldInput);
    assert.deepEqual(held.originalTarget, { channel: 'C1', threadTs: '9.9' });
    assert.deepEqual(held.sourceTarget, { channel: 'C1', threadTs: '1.1' });
    assert.doesNotMatch(JSON.stringify(context), /jaw-slack-grant|fixture-action-token/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 0, 'exposing intent never sends it');
    const bodies: Record<string, unknown>[] = [];
    f.reply(async (method, body) => {
        assert.equal(method, 'chat.postMessage'); bodies.push(body);
        if (unknown) throw new Error('response lost after dispatch');
        return json({ ok: true, ts: '9.91' });
    });
    assert.equal((await reopened.execute(threadWrite, held.requested, fresh)).verification, unknown ? 'unknown' : 'verified');
    assert.deepEqual(bodies.map(body => [body.channel, body.thread_ts]), [['C1', '9.9']]);
    const again = new SlackActionRuntime({ ...f.options, store: new SlackActionStore(f.db) });
    const next = turn('9.9', 'later-turn');
    assert.equal((await again.execute(readForRecovery, input, next)).recovery, undefined);
    if (unknown) await assert.rejects(again.execute(threadWrite, held.requested, next), /conflict_or_unknown/);
    else assert.equal((await again.execute(threadWrite, held.requested, next)).verification, 'verified');
    assert.equal(bodies.length, 1, 'neither successful nor unknown resumed writes are replayed');
});

test('held intent stays private when next turn cannot reauthorize membership', async t => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    t.after(() => { if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior; });
    const f = fixture(t); await assert.rejects(f.runtime.execute(threadWrite, heldInput, turn('1.1', 'old')), /thread_mismatch/);
    const fresh = turn('9.9', 'new'); f.removeActor();
    await assert.rejects(f.runtime.execute(readForRecovery, input, fresh), /actor_not_member/);
    await assert.rejects(f.runtime.execute(threadWrite, heldInput, fresh), /actor_not_member/);
    assert.equal(f.calls.filter(m => m === 'chat.postMessage').length, 0);
    assert.equal((f.db.prepare("SELECT state FROM slack_blocked_actions").get() as { state: string }).state, 'held');
});

test('revoked old authority or malformed intent cannot create a recovery record', async t => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    t.after(() => { if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior; });
    const f = fixture(t); const old = turn('1.1'); revokeSlackToolScope();
    await assert.rejects(f.runtime.execute(threadWrite, heldInput, old), /thread_mismatch/);
    const fresh = turn('1.1', 'valid');
    await assert.rejects(f.runtime.execute(threadWrite, { ...heldInput, unexpected: true }, fresh), /thread_mismatch/);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM slack_blocked_actions').get() as { n: number }).n, 0);
});
