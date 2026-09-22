import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastListener, removeBroadcastListener, broadcast } from '../../src/core/bus.ts';
import { handleAgentExit, type ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import { handoffRuntimeOutcome } from '../../src/agent/runtime/outcome.ts';
import { orchestrateAndCollectData } from '../../src/orchestrator/collect.ts';
import { admitRequest, resetRequestRegistryForTest } from '../../src/orchestrator/request-registry.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

type LifecycleResult = Parameters<ExitHandlerParams['resolve']>[0];

let lifecycleSerial = 0;

function lifecycleResult(options: {
    code: number | null;
    childExitCode?: number | null;
    killReason?: string | null;
    outcome?: RuntimeTurnOutcome;
    wasKilled?: boolean;
    wasSteer?: boolean;
}): Promise<LifecycleResult> {
    const id = ++lifecycleSerial;
    const scopeKey = `stop-cause-e2e-${id}`;
    const ctx: ExitHandlerParams['ctx'] = {
        fullText: '', liveOutputText: '', requestId: `stop-cause-e2e-request-${id}`,
        sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', turns: 0,
        traceRunId: `tr_stop_cause_e2e_${id}`,
    };
    if (options.outcome) handoffRuntimeOutcome(ctx, options.outcome);
    return new Promise((resolve, reject) => {
        void handleAgentExit({
            ctx, code: options.code, childExitCode: options.childExitCode,
            killReason: options.killReason,
            cli: 'cursor', model: 'fixture', resumeKey: null,
            agentLabel: 'stop-cause-e2e', mainManaged: true, origin: 'slack', prompt: 'test',
            opts: { _skipSessionPersist: true, _isSmokeContinuation: true }, cfg: {},
            ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false,
            empSid: null, isResume: false,
            wasKilled: options.wasKilled ?? false, wasSteer: options.wasSteer ?? false,
            smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
            effortDefault: '', costLine: '', resolve,
            activeProcesses: new Map(), scopeKey, chatSessionId: 'default',
            childProcess: null, releaseMainRun: () => false,
            retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
            fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
        }).catch(reject);
    });
}

async function collectLifecycleResult(
    id: string,
    result: () => Promise<LifecycleResult>,
    beforeResult?: (identity: { requestId: string; scope: string; chatSessionId: string; origin: string }) => void,
) {
    const identity = {
        requestId: `stop-cause-${id}`,
        scope: `stop-cause-${id}-scope`,
        chatSessionId: 'default',
        origin: 'slack',
    };
    admitRequest(identity.requestId, identity.scope);
    return orchestrateAndCollectData('stop cause fixture', {
        ...identity,
        _skipInsert: true,
        _skipReplayDrain: true,
        _spawnAgent: () => {
            beforeResult?.(identity);
            return { child: null, promise: result() };
        },
    });
}

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

test('pipeline: orchestrate() keeps unattributed on orchestrate_done and omits it from request_settled', async () => {
    resetRequestRegistryForTest();
    const capture: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { capture.push({ type, data }); };
    addBroadcastListener(listener);
    try {
        const identity = { requestId: 'stop-cause-unattr', scope: 'stop-cause-unattr-scope', chatSessionId: 'default', origin: 'slack' };
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
                    stopCause: 'unattributed',
                }),
            }),
        });
        const done = capture.find(entry => entry.type === 'orchestrate_done');
        const settledEvent = capture.find(entry => entry.type === 'request_settled');
        assert.ok(done, 'orchestrate_done');
        assert.equal(done.data['runtimeStatus'], 'stopped');
        assert.equal(done.data['stopCause'], 'unattributed');
        assert.ok(settledEvent, 'request_settled');
        assert.equal(settledEvent.data['runtimeStatus'], 'stopped');
        assert.equal('stopCause' in settledEvent.data, false);
    } finally {
        removeBroadcastListener(listener);
        resetRequestRegistryForTest();
    }
});

test('raw ACP 130 reaches the collector as an unattributed stopped terminal', async () => {
    resetRequestRegistryForTest();
    try {
        const collected = await collectLifecycleResult('raw-acp-130', () => lifecycleResult({
            code: 0,
            childExitCode: 130,
        }));
        assert.equal(collected.text, 'tg.stoppedUnattributed');
        assert.equal(collected.data['executionInterrupted'], true);
        assert.equal(collected.data['stopCause'], 'unattributed');
        assert.equal(collected.data['runtimeStatus'], undefined);
    } finally {
        resetRequestRegistryForTest();
    }
});

test('captured explicit Stop provenance reaches the terminal as user_stop', async () => {
    resetRequestRegistryForTest();
    try {
        const collected = await collectLifecycleResult('explicit-interrupt', () => lifecycleResult({
            code: 130,
            killReason: 'explicit-user-stop',
            outcome: { status: 'stopped', finalText: null, partialText: '' },
            wasKilled: true,
            wasSteer: true,
        }));
        assert.equal(collected.text, 'tg.stoppedUser');
        assert.equal(collected.data['runtimeStatus'], 'stopped');
        assert.equal(collected.data['stopCause'], 'user_stop');
    } finally {
        resetRequestRegistryForTest();
    }
});

test('captured unmapped kill reasons reach the collector as generic stopped terminals', async () => {
    resetRequestRegistryForTest();
    try {
        for (const killReason of ['planned-restart', 'shutdown', 'unknown']) {
            const collected = await collectLifecycleResult(`captured-${killReason}`, () => lifecycleResult({
                code: 130,
                killReason,
                outcome: { status: 'stopped', finalText: null, partialText: '' },
                wasKilled: true,
                wasSteer: true,
            }));
            assert.equal(collected.text, 'tg.stopped', killReason);
            assert.equal(collected.data['runtimeStatus'], 'stopped', killReason);
            assert.equal(collected.data['stopCause'], undefined, killReason);
        }
    } finally {
        resetRequestRegistryForTest();
    }
});

test('gateway interrupt terminal settles before a later steer event with steer provenance', async () => {
    resetRequestRegistryForTest();
    try {
        const collected = await collectLifecycleResult(
            'replacement',
            () => lifecycleResult({
                code: 130,
                killReason: 'interrupt',
                outcome: { status: 'stopped', finalText: null, partialText: '' },
                wasKilled: true,
                wasSteer: true,
            }),
        );
        assert.equal(collected.text, 'tg.stoppedSteer');
        assert.equal(collected.data['stopCause'], 'steer_kill');
        assert.equal(collected.data['superseded'], undefined);
        broadcast('steer_started', {
            requestId: 'stop-cause-replacement-late',
            scope: 'stop-cause-replacement-scope',
            sessionId: 'default',
            origin: 'slack',
        });
    } finally {
        resetRequestRegistryForTest();
    }
});

test('a replacement event observed before terminal still suppresses the old turn', async () => {
    resetRequestRegistryForTest();
    try {
        const collected = await collectLifecycleResult(
            'replacement-before-terminal',
            () => lifecycleResult({
                code: 130,
                killReason: 'interrupt',
                outcome: { status: 'stopped', finalText: null, partialText: '' },
                wasKilled: true,
                wasSteer: true,
            }),
            identity => broadcast('steer_started', {
                requestId: `${identity.requestId}-replacement`,
                scope: identity.scope,
                sessionId: identity.chatSessionId,
                origin: identity.origin,
            }),
        );
        assert.equal(collected.text, '');
        assert.equal(collected.data['superseded'], true);
    } finally {
        resetRequestRegistryForTest();
    }
});
