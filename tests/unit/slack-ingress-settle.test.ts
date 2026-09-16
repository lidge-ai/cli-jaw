import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { settings } from '../../src/core/config.ts';
import type { SlackEnvelope } from '../../src/slack/socket.ts';

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
mock.module('../../src/slack/ingress.ts', {
    namedExports: {
        ...ingress,
        enqueueSlackIngress: (key: string, task: (signal: AbortSignal) => Promise<void>) => {
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
    setSlackSelfUserIdForTest('UBOT');
    ingress.resetSlackEventDedup();
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

test('ack-failed skip leaves the row in processing', { timeout: 5000 }, async () => {
    const envelope = messageEnvelope('1704.1');
    assert.equal(await preflightSlackEnvelope(envelope), 'committed');
    const journal = getIngressJournal()!;
    assert.equal(journal.find('slack', 'T1', 'T1:C1:1704.1')?.state, 'processing');
    assert.equal(journal.counts().processing, 1);
    assert.equal(journal.counts().completed, 0);
});
