import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { admitRequest, resetRequestRegistryForTest } from '../../src/orchestrator/request-registry.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

test('pipeline: orchestrate_done carries stopCause; runtimeStatus stays stopped; request_settled does not copy it', async () => {
    resetRequestRegistryForTest();
    const capture: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { capture.push({ type, data }); };
    addBroadcastListener(listener);
    try {
        const identity = { requestId: 'stop-cause-pipe', scope: 'stop-cause-scope', chatSessionId: 'default', origin: 'slack' };
        const outcome: RuntimeTurnOutcome = { status: 'stopped', finalText: null, partialText: '' };
        admitRequest(identity.requestId, identity.scope);
        await orchestrate('native task', {
            ...identity,
            _skipInsert: true,
            _skipReplayDrain: true,
            _spawnAgent: () => ({
                child: null,
                promise: Promise.resolve({
                    text: '',
                    code: 130,
                    runtimeOutcome: outcome,
                    stopCause: 'watchdog',
                }),
            }),
        });
        const done = capture.find(entry => entry.type === 'orchestrate_done');
        const settledEvent = capture.find(entry => entry.type === 'request_settled');
        assert.ok(done, 'orchestrate_done');
        assert.equal(done.data['runtimeStatus'], 'stopped');
        assert.equal(done.data['stopCause'], 'watchdog');
        assert.ok(settledEvent, 'request_settled');
        assert.equal(settledEvent.data['runtimeStatus'], 'stopped');
        assert.equal('stopCause' in settledEvent.data, false);
    } finally {
        removeBroadcastListener(listener);
        resetRequestRegistryForTest();
    }
});
