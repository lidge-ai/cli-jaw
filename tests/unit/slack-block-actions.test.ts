import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { settings } from '../../src/core/config.ts';
import type { SlackEnvelope } from '../../src/slack/socket.ts';
import { shouldProcessSlackEvent, slackBlockActionEvent, type SlackGateConfig } from '../../src/slack/events.ts';

mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected live fetch'); });
const submissions: Array<{ prompt: string; meta: Record<string, unknown> }> = [];
mock.module('../../src/orchestrator/gateway.ts', { namedExports: {
    submitMessage: (prompt: string, meta: Record<string, unknown>) => {
        submissions.push({ prompt, meta });
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
const { preflightSlackEnvelope, handleSlackEnvelope, setSlackSelfUserIdForTest } = await import('../../src/slack/bot.ts');
const { initIngressJournal, getIngressJournal, __resetIngressJournalForTests } = await import('../../src/messaging/durable-ingress.ts');

const click = (patch: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
    type: 'block_actions', token: 'LEGACY-VERIFICATION-TOKEN', response_url: 'https://hooks.slack.com/actions/never-fetch',
    trigger_id: 'TRIGGER-SENTINEL', user: { id: 'UCEO' }, team: { id: 'T1' }, channel: { id: 'C1' },
    container: { type: 'message', channel_id: 'C1', message_ts: '1700.1', is_ephemeral: false },
    message: { ts: '1700.1', text: 'Decision card' },
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
    settings.slack = { ...settings.slack, enabled: true, botToken: 'xoxb-test', teamId: 'T1', mentionOnly: true, channelIds: [], allowBots: false, replyInThread: true };
    settings.multiSession = { ...settings.multiSession, enabled: false, channels: { ...settings.multiSession.channels, slack: false } };
    setSlackSelfUserIdForTest('UBOT');
    ingress.clearSlackEventDedupForTest();
    __resetIngressJournalForTests();
    initIngressJournal(new Database(':memory:') as never, { now: () => 1_700_000_000_000, bootId: 'block-actions' });
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
    const select = slackBlockActionEvent(click({}, { type: 'static_select', value: undefined, selected_option: { value: 'defer' } }), 'T1');
    assert.match(select!.text!, /value: "defer"/);
    const multi = slackBlockActionEvent(click({}, { type: 'multi_static_select', value: undefined, selected_options: [{ value: 'a' }, { value: 'b' }] }), 'T1');
    assert.match(multi!.text!, /value: "a,b"/);
    const date = slackBlockActionEvent(click({}, { type: 'datepicker', value: undefined, selected_date: '2026-11-09' }), 'T1');
    assert.match(date!.text!, /value: "2026-11-09"/);
    const threaded = slackBlockActionEvent(click({ container: { type: 'message', channel_id: 'C1', message_ts: '1700.1', thread_ts: '1600.1' } }), 'T1');
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
        assert.equal(slackBlockActionEvent(payload, 'T1'), null, name);
        await deliver(envelope(payload, 'E-' + name));
    }
    assert.equal(submissions.length, 0);
    assert.equal(getIngressJournal()!.list({}).length, 0);
});

test('a click is addressed to the bot but keeps the channel allowlist', () => {
    const gate: SlackGateConfig = { selfUserId: 'UBOT', allowBots: false, mentionOnly: true, channelIds: ['C1'], threadRequireMention: false, threadParticipation: () => null };
    const event = slackBlockActionEvent(click(), 'T1')!;
    assert.deepEqual(shouldProcessSlackEvent(event, gate, 'interactive'), { process: true });
    assert.deepEqual(shouldProcessSlackEvent(event, { ...gate, channelIds: ['C9'] }, 'interactive'), { process: false, reason: 'channel_not_allowed' });
    assert.deepEqual(shouldProcessSlackEvent({ ...event, type: 'message' }, gate, 'events_api'), { process: false, reason: 'mention_required' });
});
