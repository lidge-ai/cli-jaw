// The mention-watch tick against the REAL sqlite bookkeeping (isolated
// CLI_JAW_HOME temp DB via tests/setup/test-home.ts). The durable half is the
// part worth testing: an in-memory fake would pass while the frontier, the
// receipts and the resume bound all disagreed on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMentionWatchTick } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionWatchDeps } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionHit } from '../../src/slack/mention-watch.ts';
import {
    watchNamespace, hasSeenMention, readCursor, readRotation,
} from '../../src/memory/mention-watch-ledger.ts';
import type { WatchNamespace } from '../../src/memory/mention-watch-ledger.ts';
import type { HeartbeatMentionWatch } from '../../src/core/config.ts';
import { recordSelfDelivery, resetTurnDeliveryState, wasSelfDelivered } from '../../src/messaging/turn-delivery.ts';

const SUJI = 'U08PYEQACDN';
const MENTION = '<@' + SUJI + '>';
const CHANNEL = 'C0BDW33068P';

function watchConfig(overrides: Partial<HeartbeatMentionWatch> = {}): HeartbeatMentionWatch {
    return { channel: 'slack', userId: SUJI, channelIds: [CHANNEL], ...overrides };
}

/** Slack history over a fixed message set, both bounds exclusive. */
function historyFetch(byChannel: Record<string, Array<{ ts: string; text: string; user?: string }>>) {
    const reads: string[] = [];
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel') || '';
        const oldest = params.get('oldest') || undefined;
        reads.push(channel);
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
    return { impl, reads };
}

type Recorder = { asked: MentionHit[]; sent: Array<{ hit: MentionHit; text: string }> };

function deps(
    impl: typeof fetch,
    overrides: Partial<MentionWatchDeps> = {},
): { deps: MentionWatchDeps; recorder: Recorder } {
    const recorder: Recorder = { asked: [], sent: [] };
    return {
        recorder,
        deps: {
            token: 'xoxb-test',
            selfUserId: 'U0BR8UB1AAX',
            allowlist: [CHANNEL],
            fetchImpl: impl,
            yieldNow: () => null,
            answer: async (hit) => { recorder.asked.push(hit); return 'answer for ' + hit.ts; },
            send: async (hit, text) => { recorder.sent.push({ hit, text }); return true; },
            ...overrides,
        },
    };
}

const TEAM = 'T08PYEQA064';

/** A fresh namespace per test. Distinct job ids give isolation without any
 *  cleanup: the ledger is keyed by identity, so two tests cannot collide. */
function job(id: string): { id: string; name: string; ns: WatchNamespace } {
    const ns = watchNamespace(id, TEAM, SUJI);
    assert.ok(ns);
    return { id, name: id, ns };
}

test('answers a mention in its thread and records the receipt', async () => {
    const { id, ns } = job('mw_basic');
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '100.000100', text: MENTION + ' 이거 어떻게 생각해?', user: 'U0BME0C36SV' }],
    });
    const { deps: d, recorder } = deps(impl);
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);

    assert.equal(result.answered, 1);
    assert.equal(result.failed, 0);
    assert.equal(recorder.sent.length, 1);
    assert.equal(recorder.sent[0]?.hit.threadTs, '100.000100');
    // The cursor passes the answered message, which is what makes the next tick
    // cheap. Its receipt is pruned in the same step precisely BECAUSE the cursor
    // now covers it: the next scan reads strictly above, so it can never be
    // consulted again. Idempotence after this point is the cursor's job, and the
    // next test is the one that proves it.
    const cursor = readCursor(ns, CHANNEL) as { lastTs?: string };
    assert.equal(cursor?.lastTs, '100.000100');
    assert.equal(hasSeenMention(ns, CHANNEL, '100.000100'), false);
});

test('an answered mention below an unanswered one keeps the channel pinned', async () => {
    // One failed send holds the whole channel: the cursor may not pass a message
    // this tick could not answer, even though a LATER one succeeded.
    const { id, ns } = job('mw_partial');
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '150.000100', text: MENTION + ' 첫 질문', user: 'U0BME0C36SV' },
            { ts: '150.000200', text: MENTION + ' 둘째 질문', user: 'U0BME0C36SV' },
        ],
    });
    const { deps: d } = deps(impl, {
        send: async (hit) => hit.ts !== '150.000100',
    });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.equal(result.failed, 1);
    assert.equal(result.answered, 1);
    const cursor = readCursor(ns, CHANNEL) as { lastTs?: string };
    assert.ok(!cursor?.lastTs, 'cursor moved past a mention that failed to send');
    // The delivered one keeps its receipt, so the retry tick does not re-answer it.
    assert.equal(hasSeenMention(ns, CHANNEL, '150.000200'), true);
});

test('a second tick does not answer the same message twice', async () => {
    const { id, ns } = job('mw_idempotent');
    const messages = [{ ts: '200.000100', text: MENTION + ' 확인해줘', user: 'U0BME0C36SV' }];
    for (let tick = 0; tick < 2; tick += 1) {
        const { impl } = historyFetch({ [CHANNEL]: messages });
        const { deps: d, recorder } = deps(impl);
        const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
        assert.equal(result.answered, tick === 0 ? 1 : 0, 'tick ' + tick);
        assert.equal(recorder.sent.length, tick === 0 ? 1 : 0, 'tick ' + tick);
    }
});

test('a failed send leaves no receipt, so the next tick retries it', async () => {
    const { id, ns } = job('mw_send_fails');
    const messages = [{ ts: '300.000100', text: MENTION + ' 답 좀', user: 'U0BME0C36SV' }];
    const first = historyFetch({ [CHANNEL]: messages });
    const { deps: d1 } = deps(first.impl, { send: async () => false });
    const failed = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d1);
    assert.equal(failed.failed, 1);
    assert.equal(failed.answered, 0);
    assert.equal(hasSeenMention(ns, CHANNEL, '300.000100'), false);
    // The frontier must NOT have moved past an undelivered message.
    const stalled = readCursor(ns, CHANNEL) as { lastTs?: string };
    assert.ok(!stalled?.lastTs, 'cursor moved past an undelivered mention');

    const second = historyFetch({ [CHANNEL]: messages });
    const { deps: d2, recorder } = deps(second.impl);
    const retried = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d2);
    assert.equal(retried.answered, 1);
    assert.equal(recorder.sent.length, 1);
});

test('a quiet answer is recorded, so the agent is not asked again', async () => {
    const { id, ns } = job('mw_quiet');
    const messages = [{ ts: '400.000100', text: MENTION + ' 참고만', user: 'U0BME0C36SV' }];
    const first = historyFetch({ [CHANNEL]: messages });
    const { deps: d1, recorder: r1 } = deps(first.impl, { answer: async () => null });
    const quiet = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d1);
    assert.equal(quiet.quiet, 1);
    assert.equal(r1.sent.length, 0);

    const second = historyFetch({ [CHANNEL]: messages });
    const { deps: d2, recorder: r2 } = deps(second.impl);
    await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d2);
    assert.equal(r2.asked.length, 0, 'a decided-quiet message was asked again');
});

test('a yield between items abandons the rest of the batch', async () => {
    const { id, ns } = job('mw_yield');
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '500.000100', text: MENTION + ' 첫째', user: 'U0BME0C36SV' },
            { ts: '500.000200', text: MENTION + ' 둘째', user: 'U0BME0C36SV' },
            { ts: '500.000300', text: MENTION + ' 셋째', user: 'U0BME0C36SV' },
        ],
    });
    let calls = 0;
    const { deps: d, recorder } = deps(impl, {
        // Busy from the second item onward: a user started typing during the
        // first answer, and they outrank the rest of this backlog.
        yieldNow: () => { calls += 1; return calls > 1 ? 'yielded' : null; },
    });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 1);
    assert.equal(result.stoppedBecause, 'yielded');
    assert.equal(recorder.sent.length, 1);
    // The two it did not reach must remain unrecorded for the next tick.
    assert.equal(hasSeenMention(ns, CHANNEL, '500.000200'), false);
    assert.equal(hasSeenMention(ns, CHANNEL, '500.000300'), false);
});

test('channels outside the live allowlist are skipped, not scanned', async () => {
    // Re-derived every tick: the allowlist can shrink after the job was saved,
    // and an answer addressed to a dropped channel would be refused with a 403.
    const { id, ns } = job('mw_allowlist');
    const { impl, reads } = historyFetch({ [CHANNEL]: [] });
    const { deps: d } = deps(impl, { allowlist: ['C_ONLY_THIS'] });
    const result = await runMentionWatchTick(
        ns, { id, name: id }, watchConfig({ channelIds: [CHANNEL, 'C_ONLY_THIS'] }), d,
    );
    assert.deepEqual(result.unauthorized, [CHANNEL]);
    assert.deepEqual(reads, ['C_ONLY_THIS']);
});

test('every channel being unauthorized asks Slack for nothing', async () => {
    const { id, ns } = job('mw_all_denied');
    const { impl, reads } = historyFetch({ [CHANNEL]: [] });
    const { deps: d } = deps(impl, { allowlist: ['C_SOMEWHERE_ELSE'] });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.deepEqual(reads, []);
    assert.deepEqual(result.unauthorized, [CHANNEL]);
    assert.equal(result.answered, 0);
});

test('the rotation anchor is persisted for the next tick', async () => {
    const { id, ns } = job('mw_rotation');
    const { impl } = historyFetch({ [CHANNEL]: [], C_SECOND: [] });
    const { deps: d } = deps(impl, { allowlist: [CHANNEL, 'C_SECOND'] });
    await runMentionWatchTick(ns, { id, name: id }, watchConfig({ channelIds: [CHANNEL, 'C_SECOND'] }), d);
    const rotation = readRotation(ns);
    assert.equal(rotation, 'C_SECOND');
});

test('an empty inbound allowlist keeps the explicitly configured watch channels active', async () => {
    const { id, ns } = job('mw_no_allowlist');
    const { impl, reads } = historyFetch({
        [CHANNEL]: [{ ts: '650.000100', text: MENTION + ' 답해줘', user: 'U0BME0C36SV' }],
    });
    const { deps: d, recorder } = deps(impl, { allowlist: [] });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.deepEqual(reads, [CHANNEL]);
    assert.deepEqual(result.unauthorized, []);
    assert.equal(recorder.asked.length, 1);
    assert.equal(recorder.sent.length, 1);
});

test('an agent that posted the answer itself is not answered twice', async () => {
    // The prompt tells the agent the server posts, and `/api/channel/send` stays
    // reachable. When it uses it, these words are already in the thread; posting
    // them again is exactly the duplicate the user reported.
    const { id, ns } = job('mw_self_delivered');
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '800.000100', text: MENTION + ' 이거 어때?', user: 'U0BME0C36SV' }],
    });
    resetTurnDeliveryState();
    const answerText = '제 생각은 이렇습니다';
    const posts: string[] = [];
    const { deps: d } = deps(impl, {
        answer: async (hit) => {
            // Stand in for the agent calling POST /api/channel/send mid-turn.
            recordSelfDelivery({
                target: { channel: 'slack', targetId: hit.channelId, threadId: hit.threadTs } as never,
                channel: 'slack', text: answerText,
            });
            return answerText;
        },
        send: async (_hit, text) => { posts.push(text); return true; },
    });
    // The real path reads its anchor and consults the claim; the fake `send` here
    // would hide that, so the check lives in heartbeat.ts and this test proves the
    // claim is visible and matches at the moment the send would run.
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 1);
    assert.equal(
        wasSelfDelivered({
            target: { channel: 'slack', targetId: CHANNEL, threadId: '800.000100' } as never,
            text: answerText, since: 0,
        }),
        true,
        'the agent self-delivery claim was not visible to the send path',
    );
});

test('nothing found means the agent is never invoked', async () => {
    const { id, ns } = job('mw_empty');
    const { impl } = historyFetch({ [CHANNEL]: [{ ts: '600.000100', text: '관계 없는 잡담', user: 'U0BME0C36SV' }] });
    const { deps: d, recorder } = deps(impl);
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 0);
    assert.equal(recorder.asked.length, 0, 'the agent was invoked with no mentions to answer');
});

// ─── wp4: a bounded tick, and drain state the scanner already knew ───
//
// The answering loop is a loop of orchestrator turns and `heartbeatBusy` is held
// across all of it, so one busy morning queues every other heartbeat job behind
// it. MWB-003 is a guard against a REJECTED design rather than a red-today test:
// an audit caught that clocking the whole tick would let a slow scan — 2s pacing
// across up to 60 channels and 4 windows — expire the budget having answered
// nothing. It is kept because that mistake is easy to reintroduce.

const CHANNEL_B = 'C0BDW33069Q';

/** A history fetch whose reads advance a shared clock, standing in for the pacing
 *  sleeps and HTTP the real scan spends before any answering happens. */
function slowHistoryFetch(
    byChannel: Record<string, Array<{ ts: string; text: string; user?: string }>>,
    clock: { at: number },
    costMs: number,
) {
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel') || '';
        const oldest = params.get('oldest') || undefined;
        clock.at += costMs;
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

/** Always more history, with a descending window, so the backward walk spends its
 *  per-channel budget and the scan reports an unfinished walk. */
function endlessHistoryFetch() {
    let floor = 900;
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const latest = params.get('latest');
        const top = latest ? Number(latest) : floor;
        floor = top - 1;
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({
                ok: true,
                messages: [{ ts: (top - 0.5).toFixed(6), text: '잡담', user: 'U0BME0C36SV' }],
                has_more: true,
            }),
        };
    }) as unknown as typeof fetch;
    return impl;
}

test('MWB-001 an expired answer budget stops the tick BEFORE spending a turn', async () => {
    const { id, ns } = job('mw_budget_stop');
    const clock = { at: 1_000 };
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '700.000100', text: MENTION + ' 첫 번째', user: 'U0BME0C36SV' },
            { ts: '700.000200', text: MENTION + ' 두 번째', user: 'U0BME0C36SV' },
        ],
    });
    const { deps: d, recorder } = deps(impl, {
        now: () => clock.at,
        answerBudgetMs: 0,
    });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);

    assert.equal(result.stoppedBecause, 'budget');
    assert.equal(result.answered, 0);
    assert.equal(recorder.asked.length, 0, 'an expired budget must cost zero agent turns');
});

test('MWB-002 a budget break leaves no receipt, so the next tick retries it', async () => {
    const { id, ns } = job('mw_budget_retry');
    const clock = { at: 1_000 };
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '710.000100', text: MENTION + ' 답해줘', user: 'U0BME0C36SV' }],
    });
    const { deps: d } = deps(impl, { now: () => clock.at, answerBudgetMs: 0 });
    await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);

    assert.equal(hasSeenMention(ns, CHANNEL, '710.000100'), false, 'an unanswered hit must keep no receipt');
    const cursor = readCursor(ns, CHANNEL) as { lastTs?: string };
    assert.notEqual(cursor?.lastTs, '710.000100', 'the cursor must not pass an unanswered mention');
});

test('MWB-003 the budget clocks the answering phase, not the scan', async () => {
    // A scan far more expensive than the whole budget still answers its first hit,
    // because the allowance is for answering. Charging the scan to it would end
    // the tick having done nothing while the rotation anchor had already moved.
    const { id, ns } = job('mw_budget_scanclock');
    const clock = { at: 1_000 };
    const impl = slowHistoryFetch(
        { [CHANNEL]: [{ ts: '720.000100', text: MENTION + ' 안녕', user: 'U0BME0C36SV' }] },
        clock,
        20 * 60_000,
    );
    const { deps: d, recorder } = deps(impl, { now: () => clock.at, answerBudgetMs: 10 * 60_000 });
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);

    assert.equal(result.answered, 1);
    assert.equal(result.stoppedBecause, undefined);
    assert.equal(recorder.asked.length, 1);
});

test('MWB-004 an unfinished walk reaches the tick result as scanIncomplete', async () => {
    const { id, ns } = job('mw_scan_incomplete');
    const { deps: d } = deps(endlessHistoryFetch());
    const result = await runMentionWatchTick(ns, { id, name: id }, watchConfig(), d);

    assert.equal(result.scanIncomplete, true, 'the scanner computed this and the tick used to drop it');
    assert.equal(result.hitCapReached, false);
});

test('MWB-005 the hit cap is reported separately, because scanIncomplete stays false', async () => {
    // Five hits on a busy morning leave later channels unread while the unfinished-walk
    // flag says nothing at all. Reading caught-up off that flag alone would be a new
    // false claim, which is the reason this second flag exists.
    const { id, ns } = job('mw_hit_cap');
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '730.000100', text: MENTION + ' 하나', user: 'U0BME0C36SV' }],
        [CHANNEL_B]: [{ ts: '731.000100', text: MENTION + ' 둘', user: 'U0BME0C36SV' }],
    });
    const { deps: d } = deps(impl, { allowlist: [CHANNEL, CHANNEL_B] });
    const result = await runMentionWatchTick(
        ns, { id, name: id },
        watchConfig({ channelIds: [CHANNEL, CHANNEL_B], maxHits: 1 }),
        d,
    );

    assert.equal(result.hitCapReached, true);
    assert.equal(result.scanIncomplete, false, 'the cap does not set the unfinished-walk flag');
});
