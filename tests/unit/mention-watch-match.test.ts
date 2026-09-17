import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SlackHistoryMessage } from '../../src/slack/history.ts';
import {
    HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS,
    HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS,
    areMentionWatchConditionsValid,
    areMentionWatchUserIdsValid,
    classifyMentionWatch,
    isHeartbeatMentionWatchCondition,
    isMentionWatchCandidate,
    mentionWatchSubjects,
} from '../../src/slack/mention-watch-match.ts';

const SUJI = 'U08PYEQACDN';
const OTHER = 'U0BME0C36SV';
const SELF = 'U0BR8UB1AAX';
const CHANNEL = 'C0BDW33068P';
const CHANNEL_B = 'C0BDW33069Q';

function msg(overrides: Partial<SlackHistoryMessage> & { text: string }): SlackHistoryMessage {
    return { ts: '100.000100', ...overrides };
}

function classify(
    message: SlackHistoryMessage,
    extra: Partial<Parameters<typeof classifyMentionWatch>[1]> = {},
) {
    return classifyMentionWatch(message, {
        subjects: mentionWatchSubjects({ userId: SUJI }),
        channelId: CHANNEL,
        ...extra,
    });
}

test('subjects keep userId first and unique extra ids', () => {
    assert.deepEqual(mentionWatchSubjects({ userId: SUJI }), [SUJI]);
    assert.deepEqual(mentionWatchSubjects({ userId: SUJI, userIds: [OTHER, SUJI, OTHER] }), [SUJI, OTHER]);
    assert.deepEqual(mentionWatchSubjects({ userId: SUJI, userIds: [] }), [SUJI]);
});

test('no conditions: a mention of userId is a hit; untagged talk is not', () => {
    assert.equal(isMentionWatchCandidate(msg({ text: `<@${SUJI}> 이거`, user: OTHER }), {
        subjects: [SUJI], channelId: CHANNEL,
    }), true);
    assert.equal(isMentionWatchCandidate(msg({ text: '관계 없는 잡담', user: SUJI }), {
        subjects: [SUJI], channelId: CHANNEL,
    }), false);
});

test('no conditions: userless non-bot mention of userId is still a hit', () => {
    const hit = classify(msg({ text: `<@${SUJI}> 첨부만` }));
    assert.deepEqual(hit, { match: 'mention', subjectId: SUJI });
});

test('no conditions: self posts, bot-only, subtypes, and empty text are skipped', () => {
    const base = { subjects: [SUJI], channelId: CHANNEL };
    assert.equal(isMentionWatchCandidate(msg({ text: `<@${SUJI}>`, user: SELF }), { ...base, selfUserId: SELF }), false);
    assert.equal(isMentionWatchCandidate(msg({ text: `<@${SUJI}>`, botId: 'B1' }), base), false);
    assert.equal(isMentionWatchCandidate(msg({ text: `<@${SUJI}>`, user: OTHER, subtype: 'channel_join' }), base), false);
    assert.equal(isMentionWatchCandidate(msg({ text: '' }), base), false);
});

test('an agent posting as a real user is still a bot, so it is skipped', () => {
    // A granular-permission app carries BOTH a user id and a bot id. Reading only
    // the userless shape let agent accounts through, and a watch that answers an
    // agent answers something that answers back — the 2026-09-17 runaway.
    const base = { subjects: [SUJI], channelId: CHANNEL };
    const agent = msg({ text: `<@${SUJI}> 결정할 게 1건 있습니다`, user: 'U0BJUMYBELB', botId: 'B0BK0V44WR0' });
    assert.equal(isMentionWatchCandidate(agent, base), false);
    // The human case the watch exists for is untouched.
    const human = msg({ text: `<@${SUJI}> 이거 봐주세요`, user: OTHER });
    assert.deepEqual(classify(human), { match: 'mention', subjectId: SUJI });
});

test('userIds: a tag of the extra subject is a hit; subjectId is that person', () => {
    const hit = classify(msg({ text: `<@${OTHER}> 봐주세요`, user: 'U_AUTHOR' }), {
        subjects: mentionWatchSubjects({ userId: SUJI, userIds: [OTHER] }),
    });
    assert.deepEqual(hit, { match: 'mention', subjectId: OTHER });
});

test('conditions:[] is omit, not OR-of-empty', () => {
    const mentioned = msg({ text: `<@${SUJI}>`, user: OTHER });
    const chatter = msg({ text: '잡담', user: SUJI });
    assert.ok(classify(mentioned, { conditions: [] }));
    assert.equal(classify(chatter, { conditions: [] }), null);
});

test('talk condition: subject post is a hit; non-subject post is not', () => {
    const talk = [{ match: 'talk' as const }];
    const spoken = classify(msg({ text: '오늘 일정 공유합니다', user: SUJI }), { conditions: talk });
    assert.deepEqual(spoken, { match: 'talk', subjectId: SUJI });
    assert.equal(classify(msg({ text: '다른 사람 잡담', user: OTHER }), { conditions: talk }), null);
});

test('allowlist authors: in-list tagged subject hits; out-of-list does not', () => {
    const conditions = [{
        match: 'mention' as const,
        authors: { mode: 'allowlist' as const, allowlist: [OTHER] },
    }];
    const hit = classify(msg({ text: `<@${SUJI}>`, user: OTHER }), { conditions });
    assert.deepEqual(hit, { match: 'mention', subjectId: SUJI });
    assert.equal(classify(msg({ text: `<@${SUJI}>`, user: 'U_STRANGER' }), { conditions }), null);
});

test('authors.mode all still denies a userless mention', () => {
    const conditions = [{ match: 'mention' as const, authors: { mode: 'all' as const } }];
    assert.equal(classify(msg({ text: `<@${SUJI}>` }), { conditions }), null);
    assert.ok(classify(msg({ text: `<@${SUJI}>`, user: OTHER }), { conditions }));
});

test('authorDeny is a local list, not default-deny', () => {
    const conditions = [{ match: 'mention' as const, authorDeny: ['U_SPAM'] }];
    assert.equal(classify(msg({ text: `<@${SUJI}>`, user: 'U_SPAM' }), { conditions }), null);
    assert.ok(classify(msg({ text: `<@${SUJI}>`, user: OTHER }), { conditions }));
    assert.equal(classify(msg({ text: `<@${SUJI}>` }), { conditions }), null);
});

test('condition channelIds exclude other channels', () => {
    const conditions = [{ match: 'mention' as const, channelIds: [CHANNEL] }];
    assert.ok(classify(msg({ text: `<@${SUJI}>`, user: OTHER }), { conditions, channelId: CHANNEL }));
    assert.equal(classify(msg({ text: `<@${SUJI}>`, user: OTHER }), { conditions, channelId: CHANNEL_B }), null);
});

test('paired authors are invalid on disk; leftover keys are not', () => {
    assert.equal(isHeartbeatMentionWatchCondition({ match: 'talk' }), true);
    assert.equal(isHeartbeatMentionWatchCondition({ match: 'mention', leftover: true }), true);
    assert.equal(isHeartbeatMentionWatchCondition({ match: 'mention', authors: { mode: 'paired' } }), false);
    assert.equal(isHeartbeatMentionWatchCondition({ authors: { mode: 'all' } }), false);
});

test('caps reject rather than truncate', () => {
    const tooManyUsers = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS + 1 }, (_, i) => 'U' + i);
    assert.equal(areMentionWatchUserIdsValid(tooManyUsers), false);
    assert.equal(areMentionWatchUserIdsValid(tooManyUsers.slice(1)), true);
    const tooMany = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS + 1 }, () => ({ match: 'talk' }));
    assert.equal(areMentionWatchConditionsValid(tooMany, [CHANNEL]), false);
    assert.equal(areMentionWatchConditionsValid([{ match: 'talk', channelIds: [CHANNEL_B] }], [CHANNEL]), false);
    assert.equal(areMentionWatchConditionsValid([{ match: 'talk', channelIds: [CHANNEL] }], [CHANNEL]), true);
});
