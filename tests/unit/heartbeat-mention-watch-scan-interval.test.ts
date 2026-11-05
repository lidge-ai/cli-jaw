// historyScanMinutes: the conversations.history walk runs once per interval,
// not every tick, so a 5-minute watch over many channels stops spending the bot
// token's Tier 3 history budget every tick (the event-captured inbox still
// drains every tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMentionWatchTick } from '../../src/memory/heartbeat-mention-watch.ts';
import { watchNamespace } from '../../src/memory/mention-watch-ledger.ts';
import { isHeartbeatMentionWatch } from '../../src/core/config.ts';

const SUBJECT = 'U000TEST01';
const CHANNEL = 'C000TEST01';
const TEAM = 'T000TEST01';

function countingFetch() {
    const calls: string[] = [];
    const impl = (async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ ok: true, messages: [], has_more: false }) };
    }) as unknown as typeof fetch;
    return { calls, impl };
}

test('historyScanMinutes validates as a positive integer of minutes', () => {
    const base = { channel: 'slack', userId: SUBJECT, channelIds: [CHANNEL] };
    assert.equal(isHeartbeatMentionWatch({ ...base, historyScanMinutes: 30 }), true);
    assert.equal(isHeartbeatMentionWatch({ ...base, historyScanMinutes: 0 }), false);
    assert.equal(isHeartbeatMentionWatch({ ...base, historyScanMinutes: 1.5 }), false);
    assert.equal(isHeartbeatMentionWatch({ ...base, historyScanMinutes: '30' }), false);
});

test('a second tick inside the interval reads no history; after it, it does', async () => {
    const ns = watchNamespace('mw_scan_interval', TEAM, SUBJECT);
    assert.ok(ns);
    const { calls, impl } = countingFetch();
    let clock = 1_000_000;
    const deps = {
        token: 'xoxb-test', selfUserId: 'U000TEST02', allowlist: [CHANNEL], fetchImpl: impl,
        yieldNow: () => null, answer: async () => null, send: async () => true, now: () => clock,
        sleep: async () => {},
    };
    const watch = { channel: 'slack' as const, userId: SUBJECT, channelIds: [CHANNEL], historyScanMinutes: 30 };
    await runMentionWatchTick(ns, { id: 'mw_scan_interval' }, watch, deps);
    const first = calls.length;
    assert.ok(first > 0, 'first tick scans');
    clock += 5 * 60_000;
    await runMentionWatchTick(ns, { id: 'mw_scan_interval' }, watch, deps);
    assert.equal(calls.length, first, 'inside the interval: no history read');
    clock += 26 * 60_000;
    await runMentionWatchTick(ns, { id: 'mw_scan_interval' }, watch, deps);
    assert.ok(calls.length > first, 'after the interval: scans again');
});
