import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySlackChannelMembership, slackBotTokenKey } from '../../src/slack/membership.ts';

const channel = 'C123CACHETEST';

function fakeFetch(answer: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
    let calls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls++;
        assert.equal(url, 'https://slack.com/api/conversations.info');
        assert.equal(new URLSearchParams(String(init.body)).get('channel'), channel);
        return new Response(JSON.stringify(await answer()), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, get calls() { return calls; } };
}

test('positive and negative membership cache TTLs use token-scoped keys', async () => {
    let now = 1_000;
    let member = true;
    const fake = fakeFetch(() => ({ ok: true, channel: { id: channel, is_member: member } }));
    const options = { fetchImpl: fake.fetchImpl, now: () => now };
    const token = 'xoxb-membership-ttl';
    assert.equal(slackBotTokenKey(token).length, 16);
    assert.equal(await verifySlackChannelMembership(token, channel, options), true);
    member = false;
    now += 59_999;
    assert.equal(await verifySlackChannelMembership(token, channel, options), true);
    now++;
    assert.equal(await verifySlackChannelMembership(token, channel, options), false);
    member = true;
    now += 29_999;
    assert.equal(await verifySlackChannelMembership(token, channel, options), false);
    now++;
    assert.equal(await verifySlackChannelMembership(token, channel, options), true);
    assert.equal(fake.calls, 3);
    assert.equal(await verifySlackChannelMembership(token + '-new', channel, options), true);
    assert.equal(fake.calls, 4);
});

test('concurrent lookups coalesce; errors, missing scope, and mismatched IDs do not cache', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    let answer: Promise<Record<string, unknown>> | Record<string, unknown> = response;
    const fake = fakeFetch(() => answer);
    const token = 'xoxb-membership-coalesce';
    const options = { fetchImpl: fake.fetchImpl, now: () => 0 };
    const first = verifySlackChannelMembership(token, channel, options);
    const second = verifySlackChannelMembership(token, channel, options);
    release({ ok: false, error: 'missing_scope' });
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(fake.calls, 1);
    answer = { ok: true, channel: { id: 'C_DIFFERENT', is_member: true } };
    assert.equal(await verifySlackChannelMembership(token, channel, options), false);
    answer = { ok: true, channel: { id: channel, is_member: true } };
    assert.equal(await verifySlackChannelMembership(token, channel, options), true);
    assert.equal(fake.calls, 3);
});
