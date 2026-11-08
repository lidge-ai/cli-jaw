import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { settings } from '../../src/core/config.ts';
import { SlackSocketClient, type SlackEnvelope, type SlackSocketLike } from '../../src/slack/socket.ts';
import { matchingTrustedBotTriggers, shouldProcessSlackEvent, slackBlockActionEvent, type SlackGateConfig } from '../../src/slack/events.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';
import { activateSlackToolGrant, resolveSlackToolGrant, revokeSlackToolGrant, type SlackToolGrant } from '../../src/slack/tool-context.ts';

let botLookupWait: Promise<void> | undefined;
let botLookupStarted: (() => void) | undefined;
let lookupWait: Promise<void> | undefined;
let lookupStarted: (() => void) | undefined;
let clicker: Record<string, unknown> | Error = { id: 'UCEO', is_bot: false };
let authResponse: Record<string, unknown> = { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'BBOT' };
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('users.info')) {
        lookupStarted?.();
        await lookupWait;
        if (clicker instanceof Error) throw clicker;
        if (clicker['http429']) return new Response('{}', { status: 429 });
        if (clicker['apiError']) return new Response(JSON.stringify({ ok: false, error: clicker['apiError'] }));
        return new Response(JSON.stringify({ ok: true, user: clicker }), { status: 200 });
    }
    if (url.includes('bots.info')) { botLookupStarted?.(); await botLookupWait; return new Response(JSON.stringify({ ok: true, bot: { id: 'BBOT', user_id: 'UBOT', app_id: 'AAPP' } })); }
    if (url.includes('auth.test')) return new Response(JSON.stringify(authResponse));
    throw new Error('unexpected fetch ' + url);
});
const SELF = { userId: 'UBOT', botId: 'BBOT', appId: 'AAPP' };
const blockEvent = slackBlockActionEvent as unknown as (payload: unknown, teamId: string, self: { userId: string | null; botId: string | null; appId: string | null }) => ReturnType<typeof slackBlockActionEvent>;
const submissions: Array<{ prompt: string; meta: Record<string, unknown> }> = [];
let inspectGrant = false;
let capturedGrant: SlackToolGrant | null = null;
mock.module('../../src/orchestrator/gateway.ts', { namedExports: {
    submitMessage: (prompt: string, meta: Record<string, unknown>) => {
        submissions.push({ prompt, meta });
        if (inspectGrant && typeof meta['onAdmitted'] === 'function') {
            const binding = { requestId: 'control-grant', scope: 'control', chatSessionId: 'control' };
            (meta['onAdmitted'] as (binding: typeof binding) => void)(binding);
            const secret = activateSlackToolGrant(binding.requestId, binding.scope, binding.chatSessionId);
            capturedGrant = secret ? resolveSlackToolGrant(secret) : null;
            revokeSlackToolGrant(binding.requestId);
        }
        return { action: 'started', disposition: 'new_run', requestId: `click-${submissions.length}` };
    },
    dedupKey: () => 'fixture',
} });
mock.module('../../src/orchestrator/collect.ts', { namedExports: { orchestrateAndCollectData: async () => ({ text: 'ok', data: {} }) } });
mock.module('../../src/slack/send-only-client.ts', { namedExports: {
    getSlackSendClient: () => ({ token: 'xoxb-test' }),
    sendSlackText: async () => ({ ok: true, ts: '1800.1' }),
} });
mock.module('../../src/slack/forwarder.ts', { namedExports: { createSlackForwarder: () => () => {}, relaySlackImages: async () => {} } });
const progress = await import('../../src/slack/progress.ts');
mock.module('../../src/slack/progress.ts', { namedExports: { ...progress, startSlackProgress: async () => ({
    update() {}, tool() {}, projectedTool() {}, phase() {}, finish: async () => {}, ready: async () => ({ mode: 'none', ts: null }),
    abort() {}, terminalConfirmed: () => false, ts: () => null,
}) } });
const identity = await import('../../src/slack/identity.ts');
mock.module('../../src/slack/identity.ts', { namedExports: { ...identity,
    resolveSenderIdentity: async () => ({ id: 'UCEO', name: 'CEO', kind: 'user', isBot: false, resolved: true }) } });
const conversation = await import('../../src/slack/conversation.ts');
mock.module('../../src/slack/conversation.ts', { namedExports: { ...conversation,
    resolveConversationInfo: async (_token: string, channel: string) => ({ id: channel, name: 'decisions', kind: 'channel', resolved: true }),
    resolveThreadInfo: async (_token: string, _channel: string, ts: string) => ({ threadTs: ts, replyCount: 0, resolved: true, participants: [], messages: [] }),
} });
const completions: Promise<void>[] = [];
const ingress = await import('../../src/slack/ingress.ts');
mock.module('../../src/slack/ingress.ts', { namedExports: { ...ingress,
    enqueueSlackIngress: (key: string, task: (signal: AbortSignal) => Promise<void>) => {
        const done = Promise.withResolvers<void>(); void done.promise.catch(() => undefined);
        const admitted = ingress.enqueueSlackIngress(key, async signal => { try { await task(signal); done.resolve(); } catch (error) { done.reject(error); throw error; } });
        if (admitted) completions.push(done.promise);
        return admitted;
    },
} });
const { preflightSlackEnvelope, handleSlackEnvelope, setSlackSelfIdentityForTest, shutdownSlack, initSlack, getSlackSelfUserId } = await import('../../src/slack/bot.ts');
const { initIngressJournal, getIngressJournal, __resetIngressJournalForTests } = await import('../../src/messaging/durable-ingress.ts');

const click = (patch: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
    type: 'block_actions', token: 'LEGACY-VERIFICATION-TOKEN', response_url: 'https://hooks.slack.com/actions/never-fetch',
    trigger_id: 'TRIGGER-SENTINEL', user: { id: 'UCEO' }, team: { id: 'T1' }, channel: { id: 'C1' },
    container: { type: 'message', channel_id: 'C1', message_ts: '1700.1', is_ephemeral: false },
    message: { ts: '1700.1', user: 'UBOT', bot_id: 'BBOT', text: 'Decision card', blocks: [] },
    actions: [{ type: 'button', action_id: 'agent:decision:approve', block_id: 'card_42', value: 'approve', action_ts: '1730000000.123456', ...action }],
    ...patch,
});
const envelope = (payload: Record<string, unknown>, id = 'E-click'): SlackEnvelope => ({ envelope_id: id, type: 'interactive', payload });
async function deliver(env: SlackEnvelope): Promise<string> {
    const preflight = await preflightSlackEnvelope(env);
    if (preflight === 'committed') await handleSlackEnvelope(env);
    while (completions.length) await Promise.allSettled(completions.splice(0));
    return preflight;
}

test.beforeEach(() => {
    submissions.length = 0; completions.length = 0;
    inspectGrant = false; capturedGrant = null;
    settings.slack = { ...settings.slack, enabled: true, botToken: 'xoxb-test', teamId: 'T1', mentionOnly: true, channelIds: [], allowBots: false, replyInThread: true };
    settings.multiSession = { ...settings.multiSession, enabled: false, channels: { ...settings.multiSession.channels, slack: false } };
    clicker = { id: 'UCEO', is_bot: false }; lookupWait = undefined; lookupStarted = undefined; botLookupWait = undefined; botLookupStarted = undefined;
    authResponse = { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'BBOT' };
    resetVerifiedSlackWorkspace();
    setSlackSelfIdentityForTest(SELF);
    ingress.clearSlackEventDedupForTest();
    __resetIngressJournalForTests();
    initIngressJournal(new Database(':memory:') as never, { now: () => 1_700_000_000_000, bootId: 'block-actions' });
});

for (const [name, response] of [
    ['different team', { ok: true, team_id: 'T2', user_id: 'UBOT' }],
    ['different bot user', { ok: true, team_id: 'T1', user_id: 'UOTHER' }],
    ['auth failure', { ok: false, error: 'invalid_auth' }],
] as const) {
    test('workspace refused before journal: ' + name, async () => {
        authResponse = response;
        assert.equal(await deliver(envelope(click())), 'ignored');
        assert.equal(getIngressJournal()!.list({}).length, 0);
        assert.equal(submissions.length, 0);
    });
}

test('verified click cannot start a turn when its grant becomes unavailable', async () => {
    const env = envelope(click());
    assert.equal(await preflightSlackEnvelope(env), 'committed');
    resetVerifiedSlackWorkspace();
    authResponse = { ok: false, error: 'invalid_auth' };
    await handleSlackEnvelope(env);
    while (completions.length) await Promise.allSettled(completions.splice(0));
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'completed');
});

test('team changed while clicker lookup is pending refuses before journal', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const pending = preflightSlackEnvelope(envelope(click()));
    await started.promise;
    settings.slack!.teamId = 'T2';
    wait.resolve();
    assert.equal(await pending, 'ignored');
    assert.equal(getIngressJournal()!.list({}).length, 0);
    assert.equal(submissions.length, 0);
});

test('team changed after preflight cannot authorize the click grant', async () => {
    const env = envelope(click());
    assert.equal(await preflightSlackEnvelope(env), 'committed');
    settings.slack!.teamId = 'T2';
    await handleSlackEnvelope(env);
    while (completions.length) await Promise.allSettled(completions.splice(0));
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'completed');
});

test('control: verified click submits the workspace and clicker grant', async () => {
    inspectGrant = true;
    assert.equal(await deliver(envelope(click())), 'committed');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]!.meta['ownedExecution'], true);
    assert.equal(capturedGrant?.actorId, 'UCEO');
    assert.equal(capturedGrant?.teamId, 'T1');
});

test('click admission uses followup policy', async () => {
    await deliver(envelope(click()));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]!.meta['midRunPolicy'], 'followup');
});

test('control: ordinary message admission keeps the default policy', async () => {
    const result = ingress.admitSlackRun({
        target: { channel: 'slack', targetKind: 'channel', peerKind: 'direct', targetId: 'D1' },
        prompt: 'ordinary message', displayText: 'ordinary message', chatId: 'D1',
        preSendContext: { requester: 'UCEO', jobKind: 'slack_turn' }, runReply: async () => {},
    });
    await result.laneTail;
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]!.meta['midRunPolicy'], undefined);
});

test('an agent: click becomes one journaled turn answering in the card thread', { timeout: 5000 }, async () => {
    await deliver(envelope(click()));
    assert.equal(submissions.length, 1);
    const { prompt, meta } = submissions[0]!;
    for (const line of ['[Slack block action]', 'action_id: "agent:decision:approve"', 'block_id: "card_42"', 'value: "approve"', 'message_ts: "1700.1"']) assert.ok(prompt.includes(line), line);
    for (const secret of ['LEGACY-VERIFICATION-TOKEN', 'never-fetch', 'TRIGGER-SENTINEL']) assert.ok(!prompt.includes(secret), secret);
    const target = meta['target'] as { targetId: string; threadId: string };
    assert.equal(target.targetId, 'C1');
    assert.equal(target.threadId, '1700.1');
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'completed');
});

test('a redelivered click under a new envelope id runs once', { timeout: 5000 }, async () => {
    await deliver(envelope(click(), 'E-first'));
    assert.equal(await deliver(envelope(click(), 'E-redelivered')), 'duplicate');
    assert.equal(submissions.length, 1);
});

test('select, multi-select and picker values reach the turn', () => {
    const select = blockEvent(click({}, { type: 'static_select', value: undefined, selected_option: { value: 'defer' } }), 'T1', SELF);
    assert.match(select!.text!, /value: "defer"/);
    const multi = blockEvent(click({}, { type: 'multi_static_select', value: undefined, selected_options: [{ value: 'a' }, { value: 'b' }] }), 'T1', SELF);
    assert.match(multi!.text!, /value: "a,b"/);
    const date = blockEvent(click({}, { type: 'datepicker', value: undefined, selected_date: '2026-11-09' }), 'T1', SELF);
    assert.match(date!.text!, /value: "2026-11-09"/);
    const threaded = blockEvent(click({ container: { type: 'message', channel_id: 'C1', message_ts: '1700.1', thread_ts: '1600.1' } }), 'T1', SELF);
    assert.equal(threaded!.thread_ts, '1600.1');
});

test('foreign, forged and jaw-owned payloads store nothing and start no turn', { timeout: 5000 }, async () => {
    const refused: Array<[string, Record<string, unknown>]> = [
        ['foreign team', click({ team: { id: 'T2' } })],
        ['ephemeral message', click({ container: { type: 'message', channel_id: 'C1', message_ts: '1700.1', is_ephemeral: true } })],
        ['view container', click({ container: { type: 'view', view_id: 'V1' } })],
        ['channel mismatch', click({ channel: { id: 'C2' } })],
        ['message mismatch', click({ message: { ts: '1699.1' } })],
        ['no prefix', click({}, { action_id: 'decision_approve' })],
        ['choice control', click({}, { action_id: 'jaw_choice_' + 'b'.repeat(32) })],
        ['approval control', click({}, { action_id: 'appr:opaque' })],
        ['missing action_ts', click({}, { action_ts: undefined })],
        ['two actions', click({ actions: [click().actions[0], click().actions[0]] })],
        ['bot clicker', click({ user: { id: 'B123' } })],
        ['not block_actions', click({ type: 'view_submission' })],
    ];
    for (const [name, payload] of refused) {
        assert.equal(blockEvent(payload, 'T1', SELF), null, name);
        await deliver(envelope(payload, 'E-' + name));
    }
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

test('a click is addressed to the bot but keeps the channel allowlist', () => {
    const gate: SlackGateConfig = { selfUserId: 'UBOT', allowBots: false, mentionOnly: true, channelIds: ['C1'], threadRequireMention: false, threadParticipation: () => null };
    const event = blockEvent(click(), 'T1', SELF)!;
    assert.deepEqual(shouldProcessSlackEvent(event, gate, 'interactive'), { process: true });
    assert.deepEqual(shouldProcessSlackEvent(event, { ...gate, channelIds: ['C9'] }, 'interactive'), { process: false, reason: 'channel_not_allowed' });
    assert.deepEqual(shouldProcessSlackEvent({ ...event, type: 'message' }, gate, 'events_api'), { process: false, reason: 'mention_required' });
});

const message = (patch: Record<string, unknown> = {}) => ({
    ts: '1700.1', user: 'UBOT', bot_id: 'BBOT', blocks: [], ...patch,
});

for (const [name, payload, self] of [
    ['human author', click({ message: { ts: '1700.1', user: 'UCEO' } }), SELF],
    ['other bot', click({ message: message({ user: 'UOTHER', bot_id: 'BOTHER' }) }), SELF],
    ['foreign user', click({ message: message({ user: 'UOTHER' }) }), SELF],
    ['foreign bot', click({ message: message({ bot_id: 'BOTHER' }) }), SELF],
    ['missing message', click({ message: undefined }), SELF],
    ['missing bot_id', click({ message: { ts: '1700.1', user: 'UBOT' } }), SELF],
    ['foreign app', click({ message: message({ app_id: 'AOTHER' }) }), SELF],
    ['conflicting profile', click({ message: message({ app_id: 'AAPP', bot_profile: { app_id: 'AOTHER' } }) }), SELF],
    ['unknown app', click({ message: message({ app_id: 'AAPP' }) }), { ...SELF, appId: null }],
    ['profile id mismatch', click({ message: message({ bot_profile: { id: 'BOTHER' } }) }), SELF],
    ['deleted profile', click({ message: message({ bot_profile: { deleted: true } }) }), SELF],
    ['unknown self', click(), { ...SELF, botId: null }],
] as const) {
    test('ownership: ' + name, () => assert.equal(blockEvent(payload, 'T1', self), null));
}
test('synthetic: bot_id alone proves unstamped scheduled card', () => {
    assert.ok(blockEvent(click({ message: { ts: '1700.1', bot_id: 'BBOT' } }), 'T1', SELF));
});
test('synthetic: updated card with matching app is accepted', () => {
    assert.ok(blockEvent(click({ message: message({ app_id: 'AAPP', edited: {} }) }), 'T1', SELF));
});

const clickGate: SlackGateConfig = { selfUserId: 'UBOT', allowBots: false, mentionOnly: true, channelIds: ['C1'], threadRequireMention: false, threadParticipation: () => null };
test('control: self clicker is refused', () => {
    const event = blockEvent(click({ user: { id: 'UBOT' } }), 'T1', SELF)!;
    assert.equal(shouldProcessSlackEvent(event, clickGate, 'interactive').process, false);
});
test('payload bot marker is subject to bot policy', () => {
    const event = blockEvent(click({ user: { id: 'UCEO', is_bot: true } }), 'T1', SELF)!;
    assert.equal(shouldProcessSlackEvent(event, clickGate, 'interactive').process, false);
    assert.equal(shouldProcessSlackEvent(event, { ...clickGate, allowBots: true }, 'interactive').process, true);
});
test('trusted bot triggers do not admit synthesized click text', () => {
    const event = { ...blockEvent(click({}, { value: '<@UBOT> READY_NOW ' }), 'T1', SELF)!, channel: 'C11', bot_id: 'BOTHER', bot_profile: { id: 'BOTHER', user_id: 'UCEO' } };
    const gate = { ...clickGate, channelIds: ['C11'], trustedBotTriggers: [{ channelId: 'C11', botId: 'BOTHER', userId: 'UCEO', textMarker: 'READY_NOW' }] };
    assert.deepEqual(matchingTrustedBotTriggers(event, gate), []);
    assert.equal(shouldProcessSlackEvent(event, gate, 'interactive').process, false);
});

for (const [name, user] of [
    ['bot', { id: 'UCEO', is_bot: true }],
    ['workflow', { id: 'UCEO', is_bot: false, is_workflow_bot: true }],
    ['agentforce', { id: 'UCEO', is_bot: false, is_agentforce_bot: true }],
    ['sidekick', { id: 'UCEO', is_bot: false, profile: { is_sidekick_bot: true } }],
    ['profile bot', { id: 'UCEO', is_bot: false, profile: { bot_id: 'BOTHER' } }],
    ['deleted', { id: 'UCEO', is_bot: false, deleted: true }],
    ['missing is_bot', { id: 'UCEO' }],
    ['wrong user', { id: 'UOTHER', is_bot: false }],
] as const) {
    test('clicker refused before journal: ' + name, async () => {
        clicker = user;
        assert.equal(await deliver(envelope(click())), 'ignored');
        assert.equal(submissions.length, 0);
        assert.equal(getIngressJournal()!.list({}).length, 0);
    });
}
test('clicker refused before journal: Slackbot', async () => {
    clicker = { id: 'USLACKBOT', is_bot: false };
    assert.equal(await deliver(envelope(click({ user: { id: 'USLACKBOT' } }))), 'ignored');
    assert.equal(getIngressJournal()!.list({}).length, 0);
});
test('clicker refused before journal: transport error', async () => {
    clicker = new Error('network failure');
    assert.equal(await deliver(envelope(click())), 'ignored');
    assert.equal(getIngressJournal()!.list({}).length, 0);
});
test('control: app user without bot markers is admitted', async () => {
    clicker = { id: 'UCEO', is_bot: false, is_app_user: true };
    assert.equal(await deliver(envelope(click())), 'committed');
    assert.equal(submissions.length, 1);
});
test('control: allowBots admits verified bot', async () => {
    clicker = { id: 'UCEO', is_bot: true };
    settings.slack!.allowBots = true;
    assert.equal(await deliver(envelope(click())), 'committed');
    assert.equal(submissions.length, 1);
});
test('dispatch rechecks allowBots using verified clicker markers', async () => {
    clicker = { id: 'UCEO', is_bot: true };
    settings.slack!.allowBots = true;
    const env = envelope(click());
    assert.equal(await preflightSlackEnvelope(env), 'committed');
    settings.slack!.allowBots = false;
    await handleSlackEnvelope(env);
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'completed');
});
test('unknown identity at preflight cannot be repaired by dispatch', async () => {
    setSlackSelfIdentityForTest({ userId: null, botId: null });
    const env = envelope(click());
    assert.equal(await preflightSlackEnvelope(env), 'committed');
    setSlackSelfIdentityForTest(SELF);
    await handleSlackEnvelope(env);
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

test('overlap waits for first lookup before its own admission', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const first = preflightSlackEnvelope(envelope(click(), 'overlap-1'));
    assert.equal(await Promise.race([started.promise.then(() => true), first.then(() => false)]), true);
    let secondDone = false;
    const second = preflightSlackEnvelope(envelope(click(), 'overlap-2')).then(result => { secondDone = true; return result; });
    await Promise.resolve();
    assert.equal(secondDone, false);
    wait.resolve();
    assert.equal(await first, 'committed');
    assert.equal(await second, 'committed');
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'processing');
});

test('overlap retries admission after first append throws', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const journal = getIngressJournal()!;
    const original = journal.append.bind(journal);
    let calls = 0;
    const append = mock.method(journal, 'append', (...args: Parameters<typeof journal.append>) => {
        if (++calls === 1) throw new Error('disk full');
        return original(...args);
    });
    try {
        const first = preflightSlackEnvelope(envelope(click(), 'write-1'));
        const firstResult = first.then(() => false, () => true);
        assert.equal(await Promise.race([started.promise.then(() => true), firstResult.then(() => false)]), true);
        const second = preflightSlackEnvelope(envelope(click(), 'write-2'));
        wait.resolve();
        assert.equal(await firstResult, true);
        assert.equal(await second, 'committed');
        assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'processing');
    } finally { append.mock.restore(); }
});


test('socket ACK follows verified lookup and durable admission', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<string>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const listeners = new Map<string, (event: unknown) => void>();
    const socket: SlackSocketLike = {
        send: data => { const id = (JSON.parse(data) as { envelope_id?: string }).envelope_id; if (id) ack.resolve(id); },
        close: () => {}, addEventListener: (type, listener) => { listeners.set(type, listener); },
    };
    const client = new SlackSocketClient({
        appToken: 'xapp-test', fetchImpl: async () => new Response(JSON.stringify({ ok: true, url: 'wss://example.invalid' })),
        socketFactory: () => socket, preflightEnvelope: preflightSlackEnvelope, onEnvelope: async () => {},
    });
    try {
        await client.start();
        listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        listeners.get('message')!({ data: JSON.stringify(envelope(click(), 'socket-1')) });
        assert.equal(await Promise.race([started.promise.then(() => true), ack.promise.then(() => false)]), true);
        assert.equal(getIngressJournal()!.list({}).length, 0);
        wait.resolve();
        assert.equal(await ack.promise, 'socket-1');
        assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'processing');
    } finally { client.stop(); }
});

test('socket ACKs a refused bot click without journal or dispatch', async () => {
    clicker = { id: 'UCEO', is_bot: true };
    const ack = Promise.withResolvers<void>();
    const listeners = new Map<string, (event: unknown) => void>();
    let dispatched = 0;
    const socket: SlackSocketLike = {
        send: () => { assert.equal(getIngressJournal()!.list({}).length, 0); ack.resolve(); },
        close: () => {}, addEventListener: (type, listener) => { listeners.set(type, listener); },
    };
    const client = new SlackSocketClient({
        appToken: 'xapp-test', fetchImpl: async () => new Response(JSON.stringify({ ok: true, url: 'wss://example.invalid' })),
        socketFactory: () => socket, preflightEnvelope: preflightSlackEnvelope, onEnvelope: () => { dispatched++; },
    });
    try {
        await client.start();
        listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        listeners.get('message')!({ data: JSON.stringify(envelope(click(), 'socket-refused')) });
        await ack.promise;
        assert.equal(dispatched, 0);
        assert.equal(submissions.length, 0);
    } finally { client.stop(); }
});

test('socket overlapping deliveries each ACK only after durable admission and dispatch once', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const bothAcked = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const listeners = new Map<string, (event: unknown) => void>();
    let acks = 0;
    let handled = 0;
    const socket: SlackSocketLike = {
        send: () => {
            assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1:1730000000.123456')?.state, 'processing');
            if (++acks === 2) bothAcked.resolve();
        },
        close: () => {}, addEventListener: (type, listener) => { listeners.set(type, listener); },
    };
    const client = new SlackSocketClient({
        appToken: 'xapp-test', fetchImpl: async () => new Response(JSON.stringify({ ok: true, url: 'wss://example.invalid' })),
        socketFactory: () => socket, preflightEnvelope: preflightSlackEnvelope,
        onEnvelope: async env => {
            await releaseDispatch.promise;
            await handleSlackEnvelope(env);
            if (++handled === 2) completed.resolve();
        },
    });
    try {
        await client.start();
        listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        listeners.get('message')!({ data: JSON.stringify(envelope(click(), 'socket-overlap-1')) });
        await started.promise;
        listeners.get('message')!({ data: JSON.stringify(envelope(click(), 'socket-overlap-2')) });
        assert.equal(acks, 0);
        wait.resolve();
        await bothAcked.promise;
        releaseDispatch.resolve();
        await completed.promise;
        while (completions.length) await Promise.allSettled(completions.splice(0));
        assert.equal(submissions.length, 1);
    } finally { client.stop(); }
});

test('payload bot evidence wins over a human lookup', async () => {
    clicker = { id: 'UCEO', is_bot: false };
    assert.equal(await deliver(envelope(click({ user: { id: 'UCEO', is_bot: true } }))), 'ignored');
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

test('verified click dispatch works without a journal', async () => {
    __resetIngressJournalForTests();
    assert.equal(await deliver(envelope(click())), 'committed');
    assert.equal(submissions.length, 1);
});

test('ownership refusals never create journal rows or turns', async () => {
    const cases = [
        click({ message: { ts: '1700.1', user: 'UCEO' } }),
        click({ message: message({ bot_id: 'BOTHER' }) }),
        click({ message: message({ app_id: 'AOTHER' }) }),
        click({ message: undefined }),
    ];
    for (const [index, payload] of cases.entries()) await deliver(envelope(payload, 'foreign-' + index));
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

for (const [name, answer] of [
    ['user_not_found', { apiError: 'user_not_found' }],
    ['rate limited', { http429: true }],
    ['aborted lookup', Object.assign(new Error('aborted'), { name: 'AbortError' })],
] as const) {
    test('clicker refused before journal: ' + name, async () => {
        clicker = answer;
        assert.equal(await deliver(envelope(click())), 'ignored');
        assert.equal(submissions.length, 0);
        assert.equal(getIngressJournal()!.list({}).length, 0);
    });
}

test('allowBots changes during lookup are rechecked before admission', async () => {
    clicker = { id: 'UCEO', is_bot: true };
    settings.slack!.allowBots = true;
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const pending = preflightSlackEnvelope(envelope(click()));
    await started.promise;
    settings.slack!.allowBots = false;
    wait.resolve();
    assert.equal(await pending, 'ignored');
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

test('queued click re-derives ownership after identity changes', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    lookupWait = wait.promise; lookupStarted = started.resolve;
    const first = preflightSlackEnvelope(envelope(click(), 'old-1'));
    assert.equal(await Promise.race([started.promise.then(() => true), first.then(() => false)]), true);
    const second = preflightSlackEnvelope(envelope(click(), 'old-2'));
    await shutdownSlack();
    setSlackSelfIdentityForTest({ userId: 'UBOTB', botId: 'BBOTB', appId: 'AAPP' });
    wait.resolve();
    assert.equal(await first, 'ignored');
    assert.equal(await second, 'committed');
    assert.equal(getIngressJournal()!.list({}).length, 0);
});


test('superseded bot lookup cannot publish old identity', async () => {
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    botLookupWait = wait.promise; botLookupStarted = started.resolve;
    settings.port = 3459;
    settings.slack = { ...settings.slack, enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', attachPort: '3459' };
    const init = initSlack();
    await started.promise;
    assert.equal(getSlackSelfUserId(), null);
    await shutdownSlack();
    setSlackSelfIdentityForTest({ userId: 'UBOTB', botId: 'BBOTB', appId: 'AAPP' });
    wait.resolve();
    assert.deepEqual(await init, { started: false, reason: 'superseded' });
    assert.equal(getSlackSelfUserId(), 'UBOTB');
});
