import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    shouldProcessSlackEvent,
    matchesTrustedBotTrigger,
    readTrustedBotTriggers,
    type SlackGateConfig,
    type SlackMessageEvent,
} from '../../src/slack/events.ts';
import { slackEventKey } from '../../src/slack/ingress.ts';
import { mergeSettingsPatch } from '../../src/core/settings-merge.ts';

const SELF = 'U0SELF00001';
const RULE = { channelId: 'C0TRIGGER1', botId: 'B0TRIGGER1', userId: 'U0TRIGGER1', textMarker: 'REELBRAIN_MEDIA_V1' };

function config(overrides: Partial<SlackGateConfig> = {}): SlackGateConfig {
    return {
        selfUserId: SELF,
        allowBots: false,
        mentionOnly: true,
        channelIds: [],
        threadRequireMention: false,
        trustedBotTriggers: [RULE],
        threadParticipation: () => null,
        ...overrides,
    };
}

function botPost(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
        type: 'message',
        subtype: 'bot_message',
        channel: RULE.channelId,
        bot_id: RULE.botId,
        user: RULE.userId,
        ts: '1789000000.000100',
        text: `<@${SELF}> REELBRAIN_MEDIA_V1 ready`,
        ...overrides,
    };
}

test('a configured trigger admits the bot post it names', () => {
    assert.deepEqual(shouldProcessSlackEvent(botPost(), config(), 'events_api'), { process: true });
});

test('the same post is refused without a configured rule', () => {
    const decision = shouldProcessSlackEvent(botPost(), config({ trustedBotTriggers: [] }), 'events_api');
    assert.deepEqual(decision, { process: false, reason: 'subtype_bot_message' });
});

for (const [label, event] of [
    ['another channel', botPost({ channel: 'C0ELSEWHERE' })],
    ['another bot', botPost({ bot_id: 'B0OTHERBOT' })],
    ['another sender', botPost({ user: 'U0OTHERUSR' })],
    ['no marker', botPost({ text: `<@${SELF}> ready` })],
    ['marker inside a longer token', botPost({ text: `<@${SELF}> REELBRAIN_MEDIA_V1X` })],
    ['no mention of this instance', botPost({ text: 'REELBRAIN_MEDIA_V1 ready' })],
    ['a deleted bot profile', botPost({ bot_profile: { id: RULE.botId, user_id: RULE.userId, deleted: true } })],
    ['a bot id that contradicts its profile', botPost({ bot_profile: { id: 'B0OTHERBOT', user_id: RULE.userId } })],
    ['a sender that contradicts its profile', botPost({ bot_profile: { id: RULE.botId, user_id: 'U0OTHERUSR' } })],
] as const) test(`a trigger stays refused for ${label}`, () => {
    assert.equal(matchesTrustedBotTrigger(event, config()), false);
    assert.equal(shouldProcessSlackEvent(event, config(), 'events_api').process, false);
});

for (const [label, rules] of [
    ['a missing field', [{ channelId: RULE.channelId, botId: RULE.botId, userId: RULE.userId }]],
    ['an extra field', [{ ...RULE, note: 'why' }]],
    ['a lowercase marker', [{ ...RULE, textMarker: 'reelbrain_media_v1' }]],
    ['a user id shaped like a channel', [{ ...RULE, userId: RULE.channelId }]],
    ['one bad rule beside a good one', [RULE, { ...RULE, botId: 'nope' }]],
    ['more rules than the cap', Array.from({ length: 17 }, () => RULE)],
    ['a rule that is not an object', ['REELBRAIN_MEDIA_V1']],
] as const) test(`the whole list is refused for ${label}`, () => {
    assert.deepEqual(readTrustedBotTriggers(rules), []);
    assert.equal(matchesTrustedBotTrigger(botPost(), config({ trustedBotTriggers: rules })), false);
});

test('a rule naming this instance cannot make it answer itself', () => {
    const selfRule = { ...RULE, userId: SELF };
    const selfConfig = config({ trustedBotTriggers: [selfRule] });
    const echo = botPost({ user: SELF, bot_id: RULE.botId });
    assert.equal(matchesTrustedBotTrigger(echo, selfConfig), false);
    assert.equal(shouldProcessSlackEvent(echo, selfConfig, 'events_api').process, false);
    // Without the bot subtype the self-echo gate is the one that answers, and it
    // runs before any bot handling, so no rule can reopen it.
    assert.deepEqual(
        shouldProcessSlackEvent(botPost({ user: SELF, subtype: undefined }), selfConfig, 'events_api'),
        { process: false, reason: 'self_message' },
    );
});

test('a trigger cannot reach a conversation outside the allowlist', () => {
    const decision = shouldProcessSlackEvent(botPost(), config({ channelIds: ['C0ALLOWED1'] }), 'events_api');
    assert.deepEqual(decision, { process: false, reason: 'channel_not_allowed' });
});

test('a human writing the marker in the same channel takes none of the bot skips', () => {
    // The rule names a bot identity Slack attests. Copying the words is not
    // holding the token, so this must read as an ordinary channel mention.
    const impostor: SlackMessageEvent = {
        type: 'message',
        channel: RULE.channelId,
        user: 'U0HUMAN001',
        ts: '1789000000.000200',
        text: `<@${SELF}> REELBRAIN_MEDIA_V1 ready`,
    };
    assert.equal(matchesTrustedBotTrigger(impostor, config()), false);
    assert.deepEqual(
        shouldProcessSlackEvent(impostor, config(), 'events_api'),
        { process: false, reason: 'mention_via_app_mention' },
    );
    // The same words from a bot that is not the named one stay refused too.
    const otherBot = botPost({ bot_id: 'B0OTHERBOT', user: 'U0OTHERUSR' });
    assert.deepEqual(
        shouldProcessSlackEvent(otherBot, config(), 'events_api'),
        { process: false, reason: 'subtype_bot_message' },
    );
});

test('an ordinary channel mention still defers to its app_mention twin', () => {
    const human = { type: 'message', channel: 'C0PUBLIC01', user: 'U0HUMAN001', ts: '1.1', text: `<@${SELF}> hi` };
    const decision = shouldProcessSlackEvent(human, config(), 'events_api');
    assert.deepEqual(decision, { process: false, reason: 'mention_via_app_mention' });
});

test('both envelopes of one trigger post are admitted but share a duplicate key', () => {
    const message = botPost();
    const mention = botPost({ type: 'app_mention', subtype: undefined });
    assert.equal(shouldProcessSlackEvent(message, config(), 'events_api').process, true);
    assert.equal(shouldProcessSlackEvent(mention, config(), 'events_api').process, true);
    // slack/bot.ts claims this key before dispatch, so only one of them runs.
    assert.equal(
        slackEventKey('T1', message.channel!, message.ts!),
        slackEventKey('T1', mention.channel!, mention.ts!),
    );
});

test('a settings write beside the rules leaves them intact', () => {
    const merged = mergeSettingsPatch(
        { slack: { allowBots: false, trustedBotTriggers: [RULE], channelIds: [] } },
        { slack: { allowBots: true } },
    );
    assert.deepEqual(merged['slack'].trustedBotTriggers, [RULE]);
    assert.equal(merged['slack'].allowBots, true);
});

test('an invalid list is distinguishable from an absent one', () => {
    // The boot warning in slack/bot.ts is built on exactly this difference:
    // rules were declared, and none of them survived validation.
    const declared = [{ ...RULE, botId: 'not-a-bot-id' }];
    assert.equal(Array.isArray(declared) && declared.length > 0, true);
    assert.deepEqual(readTrustedBotTriggers(declared), []);
    assert.deepEqual(readTrustedBotTriggers(undefined), []);
    assert.equal(readTrustedBotTriggers([RULE]).length, 1);
});

test('a workflow rule may ask for a lane per message; a plain rule may not', () => {
    const workflowRule = { ...RULE, workflowSkill: 'hellobot-marketing-video-ima2', parallelLane: true,
        workflowCli: 'codex', workflowModel: 'gpt-5.6-luna', workflowEffort: 'xhigh' };
    assert.deepEqual(readTrustedBotTriggers([workflowRule]), [workflowRule]);
    assert.deepEqual(readTrustedBotTriggers([{ ...workflowRule, parallelLane: false }]), [{ ...workflowRule, parallelLane: false }]);
    // Without a workflow skill there is no ticket to isolate; the conversation keeps one lane.
    assert.deepEqual(readTrustedBotTriggers([{ ...RULE, parallelLane: true }]), []);
    assert.deepEqual(readTrustedBotTriggers([{ ...workflowRule, parallelLane: 'yes' }]), []);
    assert.deepEqual(readTrustedBotTriggers([{ ...workflowRule, workflowEffort: 'unbounded' }]), []);
    assert.deepEqual(readTrustedBotTriggers([{ ...RULE, workflowCli: 'codex' }]), []);
});
