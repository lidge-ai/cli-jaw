import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMentionWatchTick } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionWatchDeps } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionHit } from '../../src/slack/mention-watch.ts';
import { watchNamespace } from '../../src/memory/mention-watch-ledger.ts';
import type { WatchNamespace } from '../../src/memory/mention-watch-ledger.ts';
import {
    HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS,
    HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS,
    isHeartbeatMentionWatch,
} from '../../src/core/config.ts';
import type { HeartbeatMentionWatch } from '../../src/core/config.ts';
import { resolveHeartbeatMentionWatch } from '../../src/routes/heartbeat.ts';
import { buildMentionWatchPrompt } from '../../src/memory/heartbeat.ts';

const SUJI = 'U08PYEQACDN';
const OTHER = 'U0BME0C36SV';
const CHANNEL = 'C0BDW33068P';
const CHANNEL_B = 'C0BDW33069Q';
const TEAM = 'T08PYEQA064';

function watchConfig(overrides: Partial<HeartbeatMentionWatch> = {}): HeartbeatMentionWatch {
    return { channel: 'slack', userId: SUJI, channelIds: [CHANNEL], ...overrides };
}

function historyFetch(byChannel: Record<string, Array<{ ts: string; text: string; user?: string }>>) {
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel') || '';
        const oldest = params.get('oldest') || undefined;
        const all = byChannel[channel] ?? [];
        const inRange = all.filter(m => (oldest ? Number(m.ts) > Number(oldest) : true));
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({
                ok: true,
                messages: [...inRange].sort((a, b) => Number(b.ts) - Number(a.ts)),
                has_more: false,
            }),
        };
    }) as unknown as typeof fetch;
    return impl;
}

function deps(impl: typeof fetch): { deps: MentionWatchDeps; asked: MentionHit[] } {
    const asked: MentionHit[] = [];
    return {
        asked,
        deps: {
            token: 'xoxb-test',
            selfUserId: 'U0BR8UB1AAX',
            allowlist: [CHANNEL, CHANNEL_B],
            fetchImpl: impl,
            yieldNow: () => null,
            answer: async (hit) => { asked.push(hit); return 'answer for ' + hit.ts; },
            send: async () => true,
        },
    };
}

function job(id: string): { id: string; name: string; ns: WatchNamespace } {
    const ns = watchNamespace(id, TEAM, SUJI);
    assert.ok(ns);
    return { id, name: id, ns };
}

test('talk condition answers a subject post and names talk in the prompt', async () => {
    const { id, ns } = job('mw_talk');
    const impl = historyFetch({
        [CHANNEL]: [{ ts: '100.000100', text: '오늘 일정입니다', user: SUJI }],
    });
    const { deps: d, asked } = deps(impl);
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig({
        conditions: [{ match: 'talk' }],
    }), d);
    assert.equal(result.answered, 1);
    assert.equal(asked[0]?.match, 'talk');
    assert.equal(asked[0]?.subjectId, SUJI);
    const prompt = buildMentionWatchPrompt({ name: id }, watchConfig(), asked[0]!);
    assert.match(prompt, new RegExp(`<@${SUJI}> spoke in a message`));
    assert.doesNotMatch(prompt, /was mentioned/);
});

test('userIds mention hits the extra subject; ledger identity stays watch.userId', async () => {
    const { id, ns } = job('mw_other');
    const impl = historyFetch({
        [CHANNEL]: [{ ts: '200.000100', text: `<@${OTHER}> 확인 부탁`, user: 'U_AUTHOR' }],
    });
    const { deps: d, asked } = deps(impl);
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig({
        userIds: [OTHER],
    }), d);
    assert.equal(result.answered, 1);
    assert.equal(asked[0]?.subjectId, OTHER);
    const prompt = buildMentionWatchPrompt({ name: id }, watchConfig({ userIds: [OTHER] }), asked[0]!);
    assert.match(prompt, new RegExp(`<@${OTHER}> was mentioned`));
    assert.doesNotMatch(prompt, new RegExp(`<@${SUJI}> was mentioned`));
    assert.equal(ns.userId, SUJI);
});

test('legacy chatter still does not invoke the agent', async () => {
    const { id, ns } = job('mw_chatter');
    const impl = historyFetch({
        [CHANNEL]: [{ ts: '300.000100', text: '관계 없는 잡담', user: SUJI }],
    });
    const { deps: d, asked } = deps(impl);
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 0);
    assert.equal(asked.length, 0);
});

test('over-cap userIds or conditions are invalid heartbeat mention watches', () => {
    const tooManyUsers = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS + 1 }, (_, i) => 'U' + i);
    assert.equal(isHeartbeatMentionWatch(watchConfig({ userIds: tooManyUsers })), false);
    assert.equal(resolveHeartbeatMentionWatch({ mentionWatch: watchConfig({ userIds: tooManyUsers }) }, undefined).ok, false);
    const tooMany = Array.from({ length: HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS + 1 }, () => ({ match: 'talk' as const }));
    assert.equal(isHeartbeatMentionWatch(watchConfig({ conditions: tooMany })), false);
});

test('condition channels outside the watch list and paired authors are invalid', () => {
    assert.equal(isHeartbeatMentionWatch(watchConfig({
        conditions: [{ match: 'talk', channelIds: [CHANNEL_B] }],
    })), false);
    assert.equal(isHeartbeatMentionWatch(watchConfig({
        conditions: [{ match: 'mention', authors: { mode: 'paired' } }],
    })), false);
    assert.equal(isHeartbeatMentionWatch(watchConfig({
        conditions: [{ match: 'talk', channelIds: [CHANNEL] }],
    })), true);
});

test('conditions:[] and leftover keys stay valid', () => {
    assert.equal(isHeartbeatMentionWatch({ ...watchConfig({ conditions: [] }), leftover: true }), true);
    assert.equal(isHeartbeatMentionWatch(watchConfig({ userIds: [] })), true);
});
