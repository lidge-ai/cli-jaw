import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addBroadcastListener, removeBroadcastListener, broadcast } from '../../src/core/bus.ts';
import { handleAgentExit, type ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import { handoffRuntimeOutcome } from '../../src/agent/runtime/outcome.ts';

test.mock.module('../../src/orchestrator/pipeline.ts', {
    namedExports: {
        isContinueIntent: () => false,
        isResetIntent: () => false,
        orchestrateContinue: () => undefined,
        orchestrateReset: () => undefined,
        orchestrate: (_prompt: string, _meta: Record<string, unknown>) => undefined,
    },
});

type Result = Parameters<ExitHandlerParams['resolve']>[0];

let serial = 0;

function fixture(opts?: { outcome?: Parameters<typeof handoffRuntimeOutcome>[1]; code?: number | null; childExitCode?: number | null }) {
    const id = ++serial;
    const sessionId = 'unattr-chat-' + id;
    const scopeKey = 'unattr-scope-' + id;
    let result: Result | undefined;
    const ctx: ExitHandlerParams['ctx'] = {
        fullText: '', liveOutputText: '', requestId: 'request-' + id,
        sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', turns: 0,
        traceRunId: 'tr_unattr_' + id,
    };
    if (opts?.outcome !== undefined) handoffRuntimeOutcome(ctx, opts.outcome);
    const params: ExitHandlerParams = {
        ctx, code: opts?.code ?? 0, childExitCode: opts?.childExitCode,
        cli: 'cursor', model: 'fixture', resumeKey: null,
        agentLabel: 'unattr-fixture', mainManaged: true, origin: 'slack', prompt: 'test',
        opts: { _skipSessionPersist: true, _isSmokeContinuation: true }, cfg: {},
        ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false,
        empSid: null, isResume: false, wasKilled: false, wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: '', costLine: '',
        resolve: value => { result = value; }, activeProcesses: new Map(), scopeKey, chatSessionId: sessionId,
        childProcess: null, releaseMainRun: () => false,
        retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
        fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
    };
    return { params, result: () => result };
}

async function capture(run: () => Promise<void>) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
    addBroadcastListener(listener);
    try { await run(); return events; }
    finally { removeBroadcastListener(listener); }
}

test('native settle 130 without kill is unattributed on resolve and agent_done', async () => {
    const f = fixture({
        outcome: { status: 'stopped', finalText: null, partialText: '' },
        code: 130,
    });
    const events = await capture(() => handleAgentExit(f.params));
    assert.equal(f.result()?.stopCause, 'unattributed');
    assert.equal(f.result()?.code, 130);
    const done = events.filter(event => event.type === 'agent_done');
    assert.equal(done.length, 1);
    assert.equal(done[0]?.data['runtimeStatus'], 'stopped');
    assert.equal(done[0]?.data['stopCause'], 'unattributed');
});

test('print remap keeps lifecycle code 0 and still classifies unattributed', async () => {
    const f = fixture({ childExitCode: 130, code: 0 });
    const events = await capture(() => handleAgentExit(f.params));
    assert.equal(f.result()?.stopCause, 'unattributed');
    assert.equal(f.result()?.code, 0);
    assert.equal(f.result()?.executionInterrupted, true);
    assert.equal(f.result()?.executionFailed, undefined);
    assert.equal(f.result()?.runtimeOutcome, undefined);
    const done = events.filter(event => event.type === 'agent_done');
    for (const event of done) {
        assert.equal('stopCause' in event.data, false);
    }
});

test('collector: unattributed stopped terminal uses tg.stoppedUnattributed', async () => {
    const { orchestrateAndCollectData } = await import('../../src/orchestrator/collect.ts');
    const pending = orchestrateAndCollectData('질문', {
        origin: 'slack', requestId: 'req-unattr-new', scope: 'default', chatSessionId: 'default',
    });
    broadcast('orchestrate_done', {
        requestId: 'req-unattr-new', origin: 'slack', scope: 'default', sessionId: 'default',
        text: '', runtimeFinality: 'absent', runtimeStatus: 'stopped', stopCause: 'unattributed',
    });
    const result = await pending;
    assert.equal(result.text, 'tg.stoppedUnattributed');
});
