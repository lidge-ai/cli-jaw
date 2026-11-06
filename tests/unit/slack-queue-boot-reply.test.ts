import Database from 'better-sqlite3';
import { configureSlackFailureStore, SlackFailureStore } from '../../src/slack/failure-store.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadLocales, t } from '../../src/core/i18n.ts';
loadLocales(fileURLToPath(new URL('../../public/locales/', import.meta.url)));
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in Slack boot test'); });

// A boot-drained turn has no live requester. Isolated in its own file because it
// mocks the Slack send path, and a partial mock of that module would change what
// every other Slack test observes.

const sent: Array<{ targetId: string; threadId?: string; text: string }> = [];

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ ok: true, token: 'xoxb-boot-reply' }),
        invalidateSlackSendClient: () => {},
        resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
        sendSlackText: async (
            _token: string,
            target: { targetId: string; threadId?: string },
            text: string,
        ) => {
            sent.push({ targetId: target.targetId, threadId: target.threadId, text });
            return { ok: true };
        },
    },
});

mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => () => {},
        relaySlackImages: async () => {},
        chunkSlackText: (s: string) => [s],
    },
});

const slackTarget = (targetId: string, threadId?: string) => ({
    channel: 'slack' as const,
    targetKind: 'channel' as const,
    peerKind: 'channel' as const,
    targetId,
    ...(threadId ? { threadId } : {}),
});

/**
 * The ordinary queued reply rides a listener armed by the request that was
 * queued. A restart destroys it, and the boot drain (#407) runs exactly those
 * messages — so without a standing forwarder the drain consumes the item,
 * deletes its row, and the answer goes nowhere. The user does not wait longer;
 * the user never gets an answer.
 */
test('SQB-001: a queued result with no live requester still reaches its conversation', async () => {
    sent.length = 0;
    const { settings } = await import('../../src/core/config.ts');
    (settings as Record<string, unknown>)['slack'] = { enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' };
    await import('../../src/slack/bot.ts');   // installs the standing forwarder
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'answer for a conversation nobody is waiting in',
        origin: 'slack',
        requestId: 'req-boot-drain',
        fromQueue: true,
        target: slackTarget('C_BOOT', '1710000000.000100'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.length, 1, `the reply must be delivered; saw ${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.targetId, 'C_BOOT', 'it must go to the conversation the item carried');
    assert.equal(sent[0]!.threadId, '1710000000.000100', 'and into the thread it came from');
});

// The dispatch path posts an ordinary reply itself while still awaiting it. If
// the fallback fires for those too, EVERY Slack answer goes out twice — a worse
// bug than the one it fixes, and invisible to a test that only ever broadcasts
// queued events.
test('SQB-001b: an ordinary reply is not posted a second time', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'ordinary reply, already posted by the dispatch path',
        origin: 'slack',
        requestId: 'req-ordinary',
        target: slackTarget('C_BOOT', '1710000000.000200'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(sent, [], `a non-queued completion must not be echoed; saw ${JSON.stringify(sent)}`);
});

test('SQB-002: a result addressed to another channel is not answered here', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'telegram answer', origin: 'telegram', requestId: 'req-tg',
        fromQueue: true,
        target: { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId: '123' },
    });
    // No target at all: nowhere to send, and the last-active fallback belongs to
    // the ordinary forwarder, not to this one.
    broadcast('orchestrate_done', { text: 'targetless', origin: 'slack', requestId: 'req-none', fromQueue: true });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(sent, [], `nothing may be sent; saw ${JSON.stringify(sent)}`);
});

// A queued turn that FAILED has the same problem as one that succeeded: after a
// restart no waiter is left to show the failure. Dropping it here does not route
// it elsewhere — it means the user's message disappears with no reply at all,
// which is the exact silence #407 is about.
test('SQB-003: a queued turn that failed still says so', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: '[error] boom', error: true, origin: 'slack', requestId: 'req-err',
        fromQueue: true,
        target: slackTarget('C_BOOT'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.length, 1, `a failure must still reach the user; saw ${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.text, t('slack.progress.failure'));
    assert.doesNotMatch(sent[0]!.text, /boom/);
});

// The other half of SQB-003: while a requester IS still waiting, the failure is
// its to report. Delivering errors here was the fix for a restart, and it must
// not turn every ordinary failure into two messages.
test('SQB-003b: a failure with a live requester is reported once', async () => {
    sent.length = 0;
    const { broadcast, addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
    const bot = await import('../../src/slack/bot.ts');

    // Stand in for the dispatch path's queued-reply listener: claim the id, post
    // the result, release. This is the shape src/slack/bot.ts uses.
    const requestId = 'req-live-err';
    const posted: string[] = [];
    const waiter = (type: string, data: Record<string, unknown>) => {
        if (type !== 'orchestrate_done' || data["requestId"] !== requestId) return;
        posted.push(String(data["text"]));
    };
    addBroadcastListener(waiter);
    bot.claimSlackQueueRequestForTest(requestId);
    try {
        broadcast('orchestrate_done', {
            text: '[error] boom', error: true, origin: 'slack', requestId,
            fromQueue: true, target: slackTarget('C_BOOT'),
        });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(posted.length, 1, 'the live requester reports it');
        assert.deepEqual(sent, [], `the fallback must stay out of it; saw ${JSON.stringify(sent)}`);
    } finally {
        removeBroadcastListener(waiter);
        bot.releaseSlackQueueRequestForTest(requestId);
    }
});

// The reported leak (#411 family): the forwarder delivered the queued answer
// but never closed the "대기열에 추가됨" notice, so it sat in the thread next to
// the answer. The durable record (#418) knows the posted ts; the forwarder must
// use it to delete the notice and drop the record after a successful delivery.
test('SQB-004: forwarder delivery also deletes the leftover queue notice', async () => {
    sent.length = 0;
    const { initQueueNoticeStore, __resetQueueNoticeStoreForTests, getQueueNoticeStore } =
        await import('../../src/messaging/queue-notice-store.ts');
    const { default: Database } = await import('better-sqlite3');
    __resetQueueNoticeStoreForTests();
    initQueueNoticeStore(new Database(':memory:'));
    const store = getQueueNoticeStore()!;
    const requestId = 'req-forwarder-close';
    const target = slackTarget('C_BOOT', '1710000000.000400');
    store.reserve({ requestId, channel: 'slack', target });
    store.attachMessageId(requestId, '1710000000.000401');

    // ES module exports are frozen, so intercept at the fetch seam slackApi
    // actually calls. chat.delete carries {channel, ts} in its JSON body.
    const deletes: Array<{ channel: string; ts: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith('/chat.stopStream')) {
            return new Response(JSON.stringify({ ok: false, error: 'message_not_in_streaming_state' }));
        }
        if (String(url).endsWith('/chat.delete')) {
            const body = JSON.parse(String(init?.body || '{}')) as { channel: string; ts: string };
            deletes.push({ channel: body.channel, ts: body.ts });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error('Unexpected method in Slack boot test');
    }) as typeof fetch;

    try {
        const { broadcast } = await import('../../src/core/bus.ts');
        broadcast('orchestrate_done', {
            text: 'queued answer after restart', origin: 'slack', requestId,
            fromQueue: true, target,
        });
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(sent.length, 1, 'the answer is delivered');
        assert.deepEqual(deletes, [{ channel: 'C_BOOT', ts: '1710000000.000401' }],
            'the queue notice message is deleted');
        assert.equal(store.findByRequestId(requestId), null,
            'the durable record is dropped so no later boot rewrites it');
    } finally {
        globalThis.fetch = realFetch;
        __resetQueueNoticeStoreForTests();
    }
});

test('opt-in orphan failure posts only once to the operator DM and never replays into a root', async () => {
    const prior = process.env['JAW_SLACK_FAILURE_DM'];
    const priorFetch = globalThis.fetch;
    const database = new Database(':memory:');
    configureSlackFailureStore(new SlackFailureStore(database));
    const notifications: Record<string, unknown>[] = [];
    process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    globalThis.fetch = (async (_url, init) => {
        notifications.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: '123.4' }));
    }) as typeof fetch;
    sent.length = 0;
    try {
        const { broadcast } = await import('../../src/core/bus.ts');
        const data = { text: 'PRIVATE failure', error: true, origin: 'slack', requestId: 'optin-orphan-failure',
            fromQueue: true, target: slackTarget('C_BOOT', '1710000000.000100') };
        broadcast('orchestrate_done', data);
        await new Promise(resolve => setTimeout(resolve, 30));
        broadcast('orchestrate_done', data);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(sent, []);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.['channel'], 'DOPERATORTEST');
        assert.doesNotMatch(String(notifications[0]?.['text']), /PRIVATE/);
    } finally {
        configureSlackFailureStore(null); database.close();
        globalThis.fetch = priorFetch;
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});
