import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import type { SlackWorkflowMetadata } from '../../src/slack/workflow.ts';

type SubmitMeta = { scope: string; chatSessionId: string; remoteKey?: string; midRunPolicy?: string };
let disposition: 'new_run' | 'steered' = 'new_run';
let requestSequence = 0;
const submitCalls: Array<{ prompt: string; meta: SubmitMeta & { displayText?: string } }> = [];

mock.module('../../src/orchestrator/gateway.ts', {
    namedExports: {
        submitMessage: (prompt: string, meta: SubmitMeta & { displayText?: string }) => {
            submitCalls.push({ prompt, meta });
            return {
                action: 'started', disposition, requestId: `R${++requestSequence}`,
                sessionContext: {
                    scope: meta.scope,
                    chatSessionId: meta.chatSessionId,
                    ...(meta.remoteKey ? { remoteKey: meta.remoteKey } : {}),
                },
            };
        },
    },
});

const { admitSlackRun, enqueueSlackIngress, resetSlackIngress, withSlackDownloadSlot } =
    await import('../../src/slack/ingress.ts');
const { SessionLanes } = await import('../../src/orchestrator/session-lanes.ts');

const target = (id: string) => ({
    channel: 'slack' as const,
    targetKind: 'channel' as const,
    peerKind: 'channel' as const,
    targetId: id,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test.beforeEach(async () => {
    await resetSlackIngress();
    disposition = 'new_run';
    settings.multiSession.enabled = true;
    settings.multiSession.channels.slack = true;
    settings.multiSession.maxConcurrent = 2;
    submitCalls.length = 0;
});

test('same-scope reply work waits behind a stalled first progress/send task', async () => {
    const release = deferred();
    const entered: string[] = [];
    const first = admitSlackRun({
        target: target('C1'), prompt: 'one', displayText: 'one', chatId: 'C1',
        runReply: async () => { entered.push('one'); await release.promise; },
    });
    const second = admitSlackRun({
        target: target('C1'), prompt: 'two', displayText: 'two', chatId: 'C1',
        runReply: async () => { entered.push('two'); },
    });
    await Promise.resolve();
    assert.deepEqual(entered, ['one']);
    release.resolve();
    await Promise.all([first.laneTail, second.laneTail]);
    assert.deepEqual(entered, ['one', 'two']);
});

test('different Slack scopes may enter concurrently', async () => {
    const release = deferred();
    const entered: string[] = [];
    const first = admitSlackRun({
        target: target('C1'), prompt: 'one', displayText: 'one', chatId: 'C1',
        runReply: async () => { entered.push('one'); await release.promise; },
    });
    const second = admitSlackRun({
        target: target('C2'), prompt: 'two', displayText: 'two', chatId: 'C2',
        runReply: async () => { entered.push('two'); },
    });
    await Promise.resolve();
    assert.deepEqual(entered.sort(), ['one', 'two']);
    release.resolve();
    await Promise.all([first.laneTail, second.laneTail]);
});

test('parallel workflow lanes isolate both execution scope and prompt-history session', async () => {
    const workflow: SlackWorkflowMetadata = {
        skillId: 'example', skillSha256: 'a'.repeat(64), channelId: 'C1',
        senderUserId: 'U1', senderBotId: 'B1', messageTs: '100.1',
        threadTs: '100.1', markers: ['EXAMPLE_V1'], parallelLane: true,
    };
    const first = admitSlackRun({
        target: target('C1'), prompt: 'ticket one', displayText: 'ticket one', chatId: 'C1',
        workflow, preResolvedScope: 'slack:C1:lane:100.1', runReply: async () => {},
    });
    const second = admitSlackRun({
        target: target('C1'), prompt: 'ticket two', displayText: 'ticket two', chatId: 'C1',
        workflow: { ...workflow, messageTs: '100.2', threadTs: '100.2' },
        preResolvedScope: 'slack:C1:lane:100.2', runReply: async () => {},
    });
    await Promise.all([first.laneTail, second.laneTail]);
    assert.notEqual(first.sessionContext.scope, second.sessionContext.scope);
    assert.notEqual(first.sessionContext.chatSessionId, second.sessionContext.chatSessionId);
});

test('a synthetic top-level reply address forces followup without changing real threads', async () => {
    const synthetic = { ...target('C1'), threadId: '100.1', threadIsSynthetic: true };
    const first = admitSlackRun({
        target: synthetic, prompt: 'top-level B', displayText: 'top-level B', chatId: 'C1',
        runReply: async () => {},
    });
    const second = admitSlackRun({
        target: { ...target('C1'), threadId: '200.2' }, prompt: 'thread', displayText: 'thread', chatId: 'C1',
        runReply: async () => {},
    });
    await Promise.all([first.laneTail, second.laneTail]);
    assert.equal(submitCalls[0]?.meta.midRunPolicy, 'followup'); assert.equal(submitCalls[1]?.meta.midRunPolicy, undefined);
});

test('a detached queued turn cannot start while the first reply send is stalled', async () => {
    const lanes = new SessionLanes(() => 2);
    const release = deferred();
    const entered: string[] = [];
    const first = lanes.run('scope', async () => { entered.push('reply'); await release.promise; });
    const queued = lanes.runDetachedTurn('scope', async () => { entered.push('queued'); });
    await Promise.resolve();
    assert.deepEqual(entered, ['reply']);
    release.resolve();
    await Promise.all([first, queued]);
    assert.deepEqual(entered, ['reply', 'queued']);
});

test('the process-wide download semaphore enforces its configured cap', async () => {
    settings.slack.inboundDownloadConcurrency = 2;
    const release = deferred();
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 10 }, () => withSlackDownloadSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await release.promise;
        active -= 1;
    }));
    await Promise.resolve();
    assert.equal(peak, 2);
    release.resolve();
    await Promise.all(jobs);
    assert.equal(peak, 2);
});

test('shutdown aborts files.info, stream, and pre-admit phases with zero admission', async () => {
    for (const phase of ['files.info', 'stream', 'pre-admit']) {
        let admissions = 0;
        enqueueSlackIngress(`lane-${phase}`, async signal => {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            if (!signal.aborted) admissions += 1;
        });
        await Promise.resolve();
        await resetSlackIngress();
        assert.equal(admissions, 0, phase);
    }
});

test('reset drops queued ingress before a noncooperative predecessor settles', async t => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const dropped: string[] = [];
    let queuedRan = false;
    const realSetTimeout = globalThis.setTimeout;
    let observedDrainTimeout = false;
    t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...rest] = args;
        if (delay === 5_000) observedDrainTimeout = true;
        return realSetTimeout(callback, delay === 5_000 ? 0 : delay, ...rest);
    });
    assert.equal(enqueueSlackIngress('drop-lane', async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
    }), true);
    await firstStarted.promise;
    assert.equal(enqueueSlackIngress('drop-lane', async () => {
        queuedRan = true;
    }, {
        onDropped: reason => { dropped.push(reason); },
    }), true);

    await resetSlackIngress();

    assert.equal(observedDrainTimeout, true, 'test did not exercise the bounded reset timeout');
    assert.equal(queuedRan, false);
    assert.deepEqual(dropped, ['ingress_cancelled']);
    releaseFirst.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queuedRan, false, 'dropped work ran after its predecessor settled');
    assert.deepEqual(dropped, ['ingress_cancelled'], 'drop callback ran more than once');
});

let fileOutcome = {
    saved: [{ id: 'F1', name: 'one.txt', filePath: '/tmp/one.txt', size: 3 }],
    failed: [{ id: 'F2', name: 'two.txt', code: 'size_exceeded' }],
};
const sent: string[] = [];
const collected: string[] = [];

mock.module('../../src/slack/inbound-file.ts', {
    namedExports: {
        downloadAndSaveSlackFiles: async () => fileOutcome,
    },
});
mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async (_token: string, _target: unknown, text: string) => {
            sent.push(text);
            return { ok: true };
        },
        resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
    },
});
mock.module('../../src/slack/progress.ts', {
    namedExports: {
        startSlackProgress: async () => ({ update() {}, tool() {}, projectedTool() {}, phase() {}, finish: async () => {}, ready: async () => ({ mode: 'none', ts: null }), abort() {}, terminalConfirmed: () => false, ts: () => null }),
        statusFromToolEvent: () => '',
    },
});
mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => async () => undefined,
        relaySlackImages: async () => undefined,
    },
});
mock.module('../../src/orchestrator/collect.ts', {
    namedExports: {
        orchestrateAndCollectData: async (prompt: string) => {
            collected.push(prompt);
            return { text: 'reply', data: {} };
        },
    },
});

const { processSlackMessageEvent } = await import('../../src/slack/bot.ts');

test('partial files warn first and batch survivors into one run without exposing paths in displayText', async () => {
    fileOutcome = {
        saved: [{ id: 'F1', name: 'one.txt', filePath: '/tmp/one.txt', size: 3 }],
        failed: [{ id: 'F2', name: 'two.txt', code: 'size_exceeded' }],
    };
    sent.length = 0;
    collected.length = 0;
    await processSlackMessageEvent({ files: [{ id: 'F1' }, { id: 'F2' }] }, target('C1'), 'caption', new AbortController().signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(submitCalls.length, 1);
    assert.match(submitCalls[0]!.prompt, /\/tmp\/one\.txt/);
    assert.equal(submitCalls[0]!.meta.displayText, '[📎 one.txt] caption');
    assert.ok(!String(submitCalls[0]!.meta.displayText).includes('/tmp/'));
    assert.match(sent[0] || '', /two\.txt/);
    assert.equal(collected.length, 1);
});

test('total file failure warns without admitting a caption-only run', async () => {
    fileOutcome = {
        saved: [],
        failed: [{ id: 'F1', name: 'one.txt', code: 'missing_scope' }],
    };
    sent.length = 0;
    collected.length = 0;
    await processSlackMessageEvent({ files: [{ id: 'F1' }] }, target('C1'), '/clear', new AbortController().signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(submitCalls.length, 0);
    assert.equal(collected.length, 0);
    assert.match(sent[0] || '', /missing_scope/);
});
