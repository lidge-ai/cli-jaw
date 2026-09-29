import test from 'node:test';
import assert from 'node:assert/strict';
import { noticeInterruptedSlackRequests, type InterruptNoticeDeps } from '../../src/slack/interrupt-notice.ts';
import type { IngressEventRecord } from '../../src/messaging/durable-ingress.ts';

const target = { channel: 'slack' as const, targetKind: 'channel' as const,
    peerKind: 'channel' as const, targetId: 'C1', threadId: '1700.1' };
function row(index = 0, storedTarget: unknown = target): IngressEventRecord {
    return { channel: 'slack', accountId: 'T1', eventId: `T1:C1:1700.${index + 1}`,
        conversationKey: 'slack:T1:C1', actorId: 'U1', targetJson: JSON.stringify(storedTarget),
        ackPolicy: 'after-durable-append', traceId: 'trace', payloadDigest: 'digest', payloadJson: null,
        state: 'dead_letter', attemptCount: 1, receivedAt: 1700000000000, startedAt: null,
        completedAt: null, nextAttemptAt: null, lastError: 'interrupted_by_restart',
        tombstoneUntil: null, sessionGeneration: 0 };
}
function harness(rows = [row()]) {
    const outcomes: string[] = [];
    const sent: string[] = [];
    const deps: InterruptNoticeDeps = {
        rows, mark: (_row, outcome) => { outcomes.push(outcome); },
        hasQueued: () => false, hasActiveRun: () => false, hasBgTask: () => false,
        replies: async () => ({ ok: true, messages: [], hasMore: false }),
        send: async (_target, text) => { sent.push(text); return { ok: true }; },
        selfUserId: 'UBOT', locale: 'ko', isCurrent: () => true, sleep: async () => {},
    };
    return { deps, outcomes, sent };
}

test('root placement stays skipped despite later replyInThread setting changes', async () => {
    const h = harness([row(0, { ...target, threadId: undefined })]);
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(h.outcomes, ['skipped:root_placement']);
    assert.deepEqual(h.sent, []);
});

for (const [name, key, outcome] of [
    ['queue', 'hasQueued', 'skipped:queued'],
    ['active run', 'hasActiveRun', 'skipped:active_run'],
    ['background task', 'hasBgTask', 'skipped:bg_task'],
] as const) {
    test(`${name} suppresses the interruption notice`, async () => {
        const h = harness();
        h.deps[key] = () => true;
        await noticeInterruptedSlackRequests(h.deps);
        assert.deepEqual(h.outcomes, [outcome]);
        assert.deepEqual(h.sent, []);
    });
}

test('a bot answer on page two suppresses the notice', async () => {
    const h = harness();
    const cursors: Array<string | undefined> = [];
    h.deps.replies = async (_target, _ts, cursor) => {
        cursors.push(cursor);
        return cursor ? { ok: true, messages: [{ ts: '1700.3', text: 'answer', botId: 'B1' }], hasMore: false }
            : { ok: true, messages: [], hasMore: true, nextCursor: 'next' };
    };
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(cursors, [undefined, 'next']);
    assert.deepEqual(h.outcomes, ['answered']);
});

test('unfinished pagination is inconclusive', async () => {
    const h = harness();
    h.deps.replies = async () => ({ ok: true, messages: [], hasMore: true });
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(h.outcomes, ['skipped:inconclusive']);
});

test('invalid saved target never authorizes a post', async () => {
    const h = harness([row(0, { ...target, channel: 'telegram' })]);
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(h.outcomes, ['skipped:bad_target']);
});

test('a failed post is recorded as send_failed', async () => {
    const h = harness();
    h.deps.send = async () => { throw new Error('send failed'); };
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(h.outcomes, ['skipped:send_failed']);
});

test('complete unanswered thread posts once in the selected locale', async () => {
    const h = harness();
    h.deps.locale = 'en';
    await noticeInterruptedSlackRequests(h.deps);
    assert.deepEqual(h.outcomes, ['notified']);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0]!, /Mention me again/);
});

test('only twenty rows are checked; overflow is recorded without a post', async () => {
    const h = harness(Array.from({ length: 22 }, (_, index) => row(index)));
    await noticeInterruptedSlackRequests(h.deps);
    assert.equal(h.sent.length, 20);
    assert.deepEqual(h.outcomes.slice(20), ['skipped:cap', 'skipped:cap']);
});
