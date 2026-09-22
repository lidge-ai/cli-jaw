import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { settings } from '../../src/core/config.ts';
import { SlackSocketClient, type SlackEnvelope, type SlackSocketLike } from '../../src/slack/socket.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';
import { getSessionOwnershipGeneration } from '../../src/agent/session-persistence.ts';
import {
    claimThreadPrefetch,
    releaseThreadPrefetch,
    resetThreadPrefetchClaims,
} from '../../src/slack/thread-tracker.ts';

mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected live fetch'); });
mock.module('../../src/orchestrator/gateway.ts', {
    namedExports: {
        submitMessage: () => ({ action: 'started', disposition: 'new_run', requestId: 'req-1' }),
        dedupKey: () => 'fixture',
    },
});
let collectImpl: () => Promise<{ text: string; data: Record<string, unknown> }> = async () => ({ text: 'ok', data: {} });
mock.module('../../src/orchestrator/collect.ts', {
    namedExports: { orchestrateAndCollectData: () => collectImpl() },
});
mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async () => ({ ok: true, ts: '1800.1' }),
    },
});
mock.module('../../src/slack/forwarder.ts', {
    namedExports: { createSlackForwarder: () => () => {}, relaySlackImages: async () => {} },
});
const progress = await import('../../src/slack/progress.ts');
mock.module('../../src/slack/progress.ts', {
    namedExports: {
        ...progress,
        startSlackProgress: async () => ({
            update() {}, tool() {}, projectedTool() {}, phase() {},
            finish: async () => {}, ready: async () => ({ mode: 'none', ts: null }),
            abort() {}, terminalConfirmed: () => false, ts: () => null,
        }),
    },
});
mock.module('../../src/slack/attachment-recovery.ts', {
    namedExports: {
        recoverSlackAttachments: async () => {
            throw new Error('recover_boom');
        },
    },
});

const completions: Promise<void>[] = [];
const ingress = await import('../../src/slack/ingress.ts');
type EnqueueOptions = {
    onDropped?: (reason: 'ingress_cancelled' | 'stale_generation') => void;
};
mock.module('../../src/slack/ingress.ts', {
    namedExports: {
        ...ingress,
        enqueueSlackIngress: (key: string, task: (signal: AbortSignal) => Promise<void>, options?: EnqueueOptions) => {
            const done = Promise.withResolvers<void>();
            void done.promise.catch(() => undefined);
            const admitted = ingress.enqueueSlackIngress(key, async signal => {
                try {
                    await task(signal);
                    done.resolve();
                } catch (error) {
                    done.reject(error);
                    throw error;
                }
            }, {
                onDropped: reason => {
                    try { options?.onDropped?.(reason); }
                    finally { done.resolve(); }
                },
            });
            if (admitted) completions.push(done.promise);
            return admitted;
        },
    },
});

const {
    preflightSlackEnvelope,
    handleSlackEnvelope,
    setSlackSelfUserIdForTest,
} = await import('../../src/slack/bot.ts');
const {
    initIngressJournal,
    getIngressJournal,
    __resetIngressJournalForTests,
} = await import('../../src/messaging/durable-ingress.ts');

function messageEnvelope(ts = '1700.1'): SlackEnvelope {
    return {
        envelope_id: `E-${ts}`,
        type: 'events_api',
        payload: { event: { type: 'message', channel: 'C1', ts, user: 'U1', text: 'hello' } },
    };
}

async function drain(): Promise<void> {
    while (completions.length) {
        await Promise.allSettled(completions.splice(0));
    }
}

test.beforeEach(() => {
    completions.length = 0;
    collectImpl = async () => ({ text: 'ok', data: {} });
    settings.slack = {
        ...settings.slack,
        enabled: true,
        botToken: 'xoxb-test',
        teamId: 'T1',
        mentionOnly: false,
        channelIds: [],
        allowBots: false,
        replyInThread: true,
    };
    settings.multiSession = {
        ...settings.multiSession,
        enabled: false,
        channels: { ...settings.multiSession.channels, slack: false },
    };
    setSlackSelfUserIdForTest('UBOT');
    ingress.resetSlackEventDedup();
    resetThreadPrefetchClaims();
    __resetIngressJournalForTests();
    initIngressJournal(new Database(':memory:') as never, { now: () => 1_700_000_000_000, bootId: 'settle' });
});

test('preflight plus handle plus lane success completes the journal row', { timeout: 5000 }, async () => {
    const envelope = messageEnvelope();
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    await handleSlackEnvelope(envelope);
    await drain();
    const journal = getIngressJournal()!;
    const counts = journal.counts();
    assert.equal(counts.completed, 1);
    assert.equal(counts.processing, 0);
    assert.equal(journal.find('slack', 'T1', 'T1:C1:1700.1')?.state, 'completed');
});

test('collect error inside the lane still completes because processSlackMessageEvent returns', { timeout: 5000 }, async () => {
    collectImpl = async () => { throw new Error('lane_boom'); };
    const envelope = messageEnvelope('1701.1');
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    await handleSlackEnvelope(envelope);
    await drain();
    const journal = getIngressJournal()!;
    const row = journal.find('slack', 'T1', 'T1:C1:1701.1');
    assert.equal(row?.state, 'completed');
    assert.equal(journal.oldestOpenReceivedAt(), null);
});

test('handle throw after ACK before enqueue dead-letters', { timeout: 5000 }, async () => {
    const envelope: SlackEnvelope = {
        envelope_id: 'E-recover',
        type: 'events_api',
        payload: {
            event: {
                type: 'app_mention',
                channel: 'C1',
                ts: '1702.1',
                user: 'U1',
                text: '<@UBOT> files',
            },
        },
    };
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    await assert.rejects(() => handleSlackEnvelope(envelope), /recover_boom/);
    const journal = getIngressJournal()!;
    const row = journal.find('slack', 'T1', 'T1:C1:1702.1');
    assert.equal(row?.state, 'dead_letter');
    assert.match(String(row?.lastError), /recover_boom/);
    assert.equal(journal.oldestOpenReceivedAt(), null);
});

test('duplicate_event after admit still completes', { timeout: 5000 }, async () => {
    const envelope = messageEnvelope('1703.1');
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    assert.equal(ingress.claimSlackEvent('T1:C1:1703.1'), false);
    await handleSlackEnvelope(envelope);
    await drain();
    const journal = getIngressJournal()!;
    assert.equal(journal.find('slack', 'T1', 'T1:C1:1703.1')?.state, 'completed');
    assert.equal(journal.counts().processing, 0);
});

test('ack failure retry dispatches once and completes the journal row', { timeout: 5000 }, async () => {
    const envelope = messageEnvelope('1704.1');
    const sockets: Array<{ listeners: Map<string, (event: unknown) => void>; failAck: boolean }> = [];
    const reconnected = Promise.withResolvers<Map<string, (event: unknown) => void>>();
    const fetchImpl = (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    } as unknown as Response)) as unknown as typeof fetch;
    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 0,
        maxReconnectAttempts: 2,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            const row = { listeners, failAck: sockets.length === 0 };
            sockets.push(row);
            if (sockets.length === 2) reconnected.resolve(listeners);
            return {
                send: () => { if (row.failAck) throw new Error('socket closing'); },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            } satisfies SlackSocketLike;
        },
        preflightEnvelope: preflightSlackEnvelope,
        onEnvelope: handleSlackEnvelope,
    });
    try {
        await client.start();
        sockets[0]!.listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));
        sockets[0]!.listeners.get('message')!({ data: JSON.stringify(envelope) });

        const retrySocket = await reconnected.promise;
        retrySocket.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));
        retrySocket.get('message')!({ data: JSON.stringify({ ...envelope, retry_attempt: 1 }) });
        await new Promise(resolve => setImmediate(resolve));
        await drain();

        const journal = getIngressJournal()!;
        assert.equal(journal.find('slack', 'T1', 'T1:C1:1704.1')?.state, 'completed');
        assert.equal(journal.counts().processing, 0);
        assert.equal(journal.counts().completed, 1);
    } finally {
        client.stop();
    }
});

test('reset during running ingress dead-letters the acknowledged event instead of completing it', { timeout: 5000 }, async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    collectImpl = async () => {
        started.resolve();
        await release.promise;
        return { text: 'late cancelled result', data: {} };
    };
    const envelope = messageEnvelope('1705.1');
    try {
        assert.equal(await preflightSlackEnvelope(envelope), 'committed');
        await handleSlackEnvelope(envelope);
        await started.promise;
        const resetting = ingress.resetSlackIngress();
        release.resolve();
        await resetting;
        await drain();
        const journal = getIngressJournal()!;
        const row = journal.find('slack', 'T1', 'T1:C1:1705.1');
        assert.equal(row?.state, 'dead_letter');
        assert.equal(row?.lastError, 'ingress_cancelled');
        assert.equal(row?.payloadJson, null, 'Slack keeps its existing digest-only retention policy');
        assert.equal(journal.counts().completed, 0);
        assert.equal(journal.counts().processing, 0);
    } finally {
        release.resolve();
        await drain();
    }
});

test('reset immediately dead-letters and releases prefetch behind a noncooperative predecessor', { timeout: 5000 }, async t => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const realSetTimeout = globalThis.setTimeout;
    let observedDrainTimeout = false;
    t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...rest] = args;
        if (delay === 5_000) observedDrainTimeout = true;
        return realSetTimeout(callback, delay === 5_000 ? 0 : delay, ...rest);
    });
    settings.multiSession = {
        ...settings.multiSession,
        enabled: true,
        channels: { ...settings.multiSession.channels, slack: true },
    };
    const channel = 'C1705';
    const threadTs = '1705.0';
    const target = slackTargetFromId(channel, { threadTs, teamId: 'T1' });
    const scope = ingress.resolveSlackScopeForTarget(target);
    assert.ok(scope);
    const owner = getSessionOwnershipGeneration(scope);
    const lane = ingress.slackIngressLaneKey(target);
    assert.equal(ingress.enqueueSlackIngress(lane, async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
    }), true);
    await firstStarted.promise;

    const envelope: SlackEnvelope = {
        envelope_id: 'E-1705.1',
        type: 'events_api',
        payload: { event: {
            type: 'message', channel, channel_type: 'channel', thread_ts: threadTs,
            ts: '1705.1', user: 'U1', text: 'hello',
        } },
    };
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    await handleSlackEnvelope(envelope);
    assert.equal(getIngressJournal()!.find('slack', 'T1', 'T1:C1705:1705.1')?.state, 'processing');
    assert.equal(claimThreadPrefetch(channel, threadTs, owner), 0, 'prefetch claim was not held while queued');

    await ingress.resetSlackIngress();

    assert.equal(observedDrainTimeout, true, 'test did not exercise the bounded reset timeout');
    const journal = getIngressJournal()!;
    const row = journal.find('slack', 'T1', 'T1:C1705:1705.1');
    assert.equal(row?.state, 'dead_letter');
    assert.equal(row?.lastError, 'ingress_cancelled');
    assert.equal(journal.oldestOpenReceivedAt(), null);
    const reclaimed = claimThreadPrefetch(channel, threadTs, owner);
    assert.ok(reclaimed > 0, 'prefetch remained claimed until predecessor settlement');

    releaseFirst.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claimThreadPrefetch(channel, threadTs, owner), 0, 'late dropped work released a replacement prefetch token');
    releaseThreadPrefetch(channel, threadTs, owner, reclaimed);
});
