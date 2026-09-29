// What a tick did, and why 'the model finished' is not 'the recipient got it'.
//
// Before this record the heartbeat had one durable trace of a tick — the anchor
// row, written only on a successful send. Everything else was a log line, so a job
// that refused on every tick for a week looked exactly like a job with nothing to
// say. Four of these cases are regression guards for defects an independent audit
// found in the first design of this phase.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    foldRunRecord,
    isHeartbeatJobFailing,
    HEARTBEAT_FAILURE_HOLD_THRESHOLD,
    type HeartbeatRunRecord,
} from '../../src/memory/heartbeat-run-record.ts';
import {
    runHeartbeatJob,
    getHeartbeatRunRecord,
    getHeartbeatRuntimeState,
    mentionWatchBackoffUntil,
    recordMentionWatchTick,
    pruneMentionWatchBackoff,
    resetMentionWatchBackoffForTests,
    MENTION_WATCH_BACKOFF_BASE_MS,
} from '../../src/memory/heartbeat.ts';

function outcome(over: Partial<HeartbeatRunRecord> = {}): Omit<HeartbeatRunRecord, 'consecutiveFailures' | 'consecutiveSkips'> {
    return { jobId: 'j', startedAt: 0, finishedAt: 1, superseded: false, execution: 'ok', delivery: 'delivered', ...over };
}

test('HRR-001 an execution failure increments the streak and an ok resets it', () => {
    let record = foldRunRecord(undefined, outcome({ execution: 'error', delivery: 'not_requested' }));
    assert.equal(record.consecutiveFailures, 1);
    record = foldRunRecord(record, outcome({ execution: 'error', delivery: 'not_requested' }));
    assert.equal(record.consecutiveFailures, 2);
    record = foldRunRecord(record, outcome());
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.consecutiveSkips, 0);
});

test('HRR-002 a delivery failure is not an execution failure', () => {
    // The work succeeded; the transport did not. Counting it against the streak
    // would make a flaky channel look like a broken job.
    const record = foldRunRecord(undefined, outcome({ execution: 'ok', delivery: 'not_delivered', reason: 'send_failed' }));
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.consecutiveSkips, 0);
    assert.equal(record.delivery, 'not_delivered');
});

test('HRR-003 a skip gets its own counter instead of being ignored', () => {
    // A job that refuses every tick would otherwise sit at zero forever and never
    // become visible, which is the invisibility this record exists to end.
    let record = foldRunRecord(undefined, outcome({ execution: 'skipped', delivery: 'not_requested', reason: 'unbound_destination' }));
    assert.equal(record.consecutiveSkips, 1);
    assert.equal(record.consecutiveFailures, 0);
    for (let i = 1; i < HEARTBEAT_FAILURE_HOLD_THRESHOLD; i += 1) {
        record = foldRunRecord(record, outcome({ execution: 'skipped', delivery: 'not_requested' }));
    }
    assert.equal(record.consecutiveSkips, HEARTBEAT_FAILURE_HOLD_THRESHOLD);
    assert.ok(isHeartbeatJobFailing(record), 'a permanently skipped job must be visible');
});

test('HRR-004 a superseded run records its outcome and freezes both counters', () => {
    // Its outcome is true, but it describes a schedule stopHeartbeat already replaced.
    const base = foldRunRecord(undefined, outcome({ execution: 'error', delivery: 'not_requested' }));
    const late = foldRunRecord(base, outcome({ execution: 'ok', delivery: 'delivered', superseded: true }));
    assert.equal(late.execution, 'ok', 'the outcome is still recorded');
    assert.equal(late.consecutiveFailures, 1, 'a superseded ok must not reset the streak');
    const aborted = foldRunRecord(base, outcome({ execution: 'error', delivery: 'not_requested', superseded: true }));
    assert.equal(aborted.consecutiveFailures, 1, 'a post-abort throw must not increment it either');
});

test('HRR-005 neither threshold is reached by an empty or healthy record', () => {
    assert.equal(isHeartbeatJobFailing(undefined), false);
    assert.equal(isHeartbeatJobFailing(foldRunRecord(undefined, outcome())), false);
});

test('HRR-006 a held destination is recorded as a skip carrying the hold reason', async () => {
    const job = { id: 'hb-held', name: 'hb-held', enabled: true, prompt: 'x', schedule: { kind: 'every', minutes: 5 } };
    await runHeartbeatJob(job, { verifyDestination: async () => ({ state: 'held', reason: 'stale_thread' }) });
    const record = getHeartbeatRunRecord('hb-held');
    assert.equal(record?.execution, 'skipped');
    assert.equal(record?.delivery, 'not_requested');
    assert.equal(record?.reason, 'stale_thread');
    assert.equal(record?.consecutiveSkips, 1);
    assert.equal(record?.consecutiveFailures, 0);
});

test('HRR-007 an unreservable grant is a skip, not a silent nothing', async () => {
    const job = { id: 'hb-grant', name: 'hb-grant', enabled: true, prompt: 'x', schedule: { kind: 'every', minutes: 5 } };
    await runHeartbeatJob(job, {
        verifyDestination: async () => ({ state: 'bound', target: { channel: 'slack', targetId: 'C1', threadId: '1.0' } }),
        reserveDestinationGrant: async () => null,
    });
    const record = getHeartbeatRunRecord('hb-grant');
    assert.equal(record?.execution, 'skipped');
    assert.equal(record?.reason, 'slack_grant_unavailable');
});

test('HRR-008 a job that refuses every tick reaches the failing list', async () => {
    const job = { id: 'hb-forever', name: 'hb-forever', enabled: true, prompt: 'x', schedule: { kind: 'every', minutes: 5 } };
    for (let i = 0; i < HEARTBEAT_FAILURE_HOLD_THRESHOLD; i += 1) {
        await runHeartbeatJob(job, { verifyDestination: async () => ({ state: 'held', reason: 'unbound_destination' }) });
    }
    const record = getHeartbeatRunRecord('hb-forever');
    assert.equal(record?.consecutiveSkips, HEARTBEAT_FAILURE_HOLD_THRESHOLD);
    assert.ok(getHeartbeatRuntimeState().failing.includes('hb-forever'),
        'a job refusing on every tick must be reported, not merely logged');
});

test('HRR-020 consecutive failing mention-watch ticks back off 5, 10, 20, 40 then 60 minutes; a clean tick clears it', () => {
    resetMentionWatchBackoffForTests();
    const minute = 60_000;
    let now = 1_000_000;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
        recordMentionWatchTick('mw-job', 1, now);
        const until = mentionWatchBackoffUntil('mw-job', now);
        assert.ok(until !== null);
        delays.push((until - now) / minute);
        now = until;
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 60, 60]);
    assert.equal(mentionWatchBackoffUntil('mw-job', now), null, 'the hold ends at its boundary');
    recordMentionWatchTick('mw-job', 0, now);
    recordMentionWatchTick('mw-job', 1, now);
    assert.equal(mentionWatchBackoffUntil('mw-job', now), now + MENTION_WATCH_BACKOFF_BASE_MS, 'a clean tick restarts the ladder');
    pruneMentionWatchBackoff(new Set());
    assert.equal(mentionWatchBackoffUntil('mw-job', now), null, 'a removed job keeps no hold');
});

test('HRR-021 a mention watch in backoff is skipped before any Slack or model work', async () => {
    resetMentionWatchBackoffForTests();
    const job = { id: 'hb-mw-backoff', name: 'hb-mw-backoff', enabled: true, schedule: { kind: 'every', minutes: 5 },
        mentionWatch: { channel: 'slack', userId: 'U_BACKOFF', channelIds: ['C_BACKOFF'], since: '1700000000.000100' } };
    recordMentionWatchTick('hb-mw-backoff', 2, Date.now());
    await runHeartbeatJob(job);
    assert.equal(getHeartbeatRunRecord('hb-mw-backoff')?.reason, 'mention_watch_backoff');
    resetMentionWatchBackoffForTests();
    await runHeartbeatJob(job);
    // Without the hold the watch runs and refuses on its own terms (Slack is off here).
    assert.equal(getHeartbeatRunRecord('hb-mw-backoff')?.reason, 'mention_watch_not_runnable');
});

