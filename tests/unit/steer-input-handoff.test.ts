import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelSteerInputs, cancelAllSteerInputs } from '../../src/agent/steer-input-guard.ts';
import { settings } from '../../src/core/config.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import { settleOnce, settleAllPending } from '../../src/orchestrator/request-registry.ts';

let mode: 'scoped-stop' | 'aggregate-stop' | 'natural' | 'dispatched' | 'new-run' | 'failure' = 'natural';
const queued: unknown[][] = [];
const steered: unknown[][] = [];
const killed: unknown[][] = [];
const purged: unknown[][] = [];
test.mock.module('../../src/agent/spawn.js', { namedExports: {
    isAgentBusy: () => true, messageQueue: [],
    purgeQueueOnStop: (...args: unknown[]) => { purged.push(args); },
    getCurrentMainMeta: () => null,
    hasActiveMainReplacement: () => false,
    canSteerAgent: () => assert.fail('gateway must delegate capability choice, not pre-queue'),
    killActiveAgent: (...args: unknown[]) => { killed.push(args); return true; },
    enqueueMessage: (...args: unknown[]) => { queued.push(args); return 'fixture-queued'; },
    steerAgent: (scope: string, _text: string, _origin: string, meta: { requestId: string }) => {
        steered.push([scope, _text, _origin, meta]);
        if (mode === 'failure') return Promise.reject(new Error('fixture steer failure'));
        if (mode === 'dispatched') settleOnce(meta.requestId, 'steered');
        const result = Promise.resolve(mode === 'dispatched' ? 'steered' : mode === 'new-run' ? 'new-run' : 'fallback-queue');
        // Producer has already returned its outcome. Stop wins before the consumer's queued continuation.
        if (mode === 'scoped-stop' || mode === 'dispatched') queueMicrotask(() => cancelSteerInputs(scope));
        if (mode === 'aggregate-stop') queueMicrotask(cancelAllSteerInputs);
        return result;
    },
} });
test.mock.module('../../src/orchestrator/pipeline.js', { namedExports: {
    orchestrate: () => assert.fail('handoff must not start inference'),
    orchestrateContinue: () => assert.fail('unexpected continue'),
    orchestrateReset: () => assert.fail('unexpected reset'),
    isContinueIntent: () => false, isResetIntent: () => false,
} });
const { submitMessage, __resetSubmitDedupForTest } = await import('../../src/orchestrator/gateway.ts');
test.beforeEach(t => {
    queued.length = 0; steered.length = 0; killed.length = 0; purged.length = 0;
    cancelAllSteerInputs(); __resetSubmitDedupForTest();
    settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected network'));
    t.mock.method(console, 'error', () => {});
});
test.afterEach(() => { cancelAllSteerInputs(); settleAllPending('dropped', 'test-cleanup'); });

for (const scenario of ['scoped-stop', 'aggregate-stop', 'natural', 'dispatched', 'new-run', 'failure'] as const) {
    test(`gateway's final enqueue boundary handles ${scenario} after producer resolution`, async () => {
        mode = scenario;
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        const off = subscribe(event => events.push(event));
        try {
            const result = submitMessage('handoff-' + scenario, { origin: 'web', scope: 'handoff-scope', chatSessionId: 'handoff-chat' });
            assert.equal(result.action, 'started'); assert.ok(result.requestId);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(steered.length, 1, 'every steer policy call delegates exactly once');
            assert.equal(killed.length, 0, 'steer policy must not call the interrupt kill seam');
            assert.deepEqual(steered[0]!.slice(0, 3), ['handoff-scope', 'handoff-' + scenario, 'web']);
            const receipts = events.filter(event => event.event === 'request_settled' && event.data['requestId'] === result.requestId);
            if (scenario === 'natural') {
                assert.equal(queued.length, 1); assert.equal(receipts.length, 0);
            } else if (scenario === 'new-run') {
                assert.equal(queued.length, 0); assert.equal(receipts.length, 0, 'the actual new run owns its later terminal');
            } else {
                assert.equal(queued.length, 0); assert.equal(receipts.length, 1);
                assert.equal(receipts[0]!.data['outcome'], scenario === 'dispatched' ? 'steered' : scenario === 'failure' ? 'failed' : 'cancelled');
            }
        } finally { off(); }
    });
}

test('gateway interrupt captures interrupt provenance and emits no steer_started event', () => {
    settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'interrupt' };
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = subscribe(event => events.push(event));
    try {
        const result = submitMessage('interrupt replacement', {
            origin: 'web', scope: 'interrupt-scope', chatSessionId: 'interrupt-chat',
        });
        assert.equal(result.action, 'queued');
        assert.deepEqual(killed, [['interrupt-scope', 'interrupt']]);
        assert.deepEqual(purged, [['interrupt-scope', 'interrupt']]);
        assert.equal(events.some(event => event.event === 'steer_started'), false);
    } finally {
        off();
    }
});
