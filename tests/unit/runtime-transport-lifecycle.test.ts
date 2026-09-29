import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';

const compactions: Array<{ sessionBucket?: string; scopeKey?: string; expectedSessionId?: string }> = [];
mock.module('../../src/core/compact.js', { namedExports: {
    autoCompactRefresh: async (opts: { sessionBucket?: string; scopeKey?: string; expectedSessionId?: string }) => { compactions.push(opts); },
    isCompactMarkerRow: () => false,
} });
const config = await import('../../src/core/config.ts');
const settings = { ...config.settings, workingDir: '', cli: 'cursor', model: 'fixture',
    perCli: { cursor: { model: 'fixture', transport: 'print' } }, fallbackOrder: [] as string[],
};
mock.module('../../src/core/config.js', { namedExports: {
    ...config, settings, detectCli: () => ({ available: true }),
} });
const { db, getSession, updateSession, getSessionBucket, upsertSessionBucket } = await import('../../src/core/db.ts');
const { getSessionOwnershipGeneration, resetSessionOwnershipGenerationForTest } = await import('../../src/agent/session-persistence.ts');
const { resetFlushCountersForTest } = await import('../../src/agent/memory-flush-controller.ts');
const { handleAgentExit, setSpawnAgent, clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
type Result = Parameters<ExitHandlerParams['resolve']>[0];
let serial = 0;
const spawned: Array<Record<string, unknown> | undefined> = [];
setSpawnAgent((_prompt, opts) => {
    spawned.push(opts);
    return { promise: Promise.resolve({ text: 'fixture followup', code: 0 }) };
});
test.beforeEach(t => {
    compactions.length = 0;
    spawned.length = 0;
    settings.fallbackOrder = [];
    resetSessionOwnershipGenerationForTest();
    resetFlushCountersForTest();
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
});
test.afterEach(() => clearGoalTimers());

function fixture(): { params: ExitHandlerParams; result: () => Result | undefined } {
    const id = ++serial;
    const scopeKey = 'transport-lifecycle-' + id;
    let result: Result | undefined;
    return { result: () => result, params: {
        ctx: { fullText: 'fixture final', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', turns: 0 },
        code: 0, cli: 'cursor', model: 'fixture', resumeKey: null, agentLabel: 'main', mainManaged: true,
        origin: 'web', prompt: 'fixture input', opts: { _skipSessionPersist: true, _isSmokeContinuation: true },
        cfg: {}, ownerGeneration: 0, persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        forceNew: false, empSid: null, isResume: false, wasKilled: false, wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: '', costLine: '', resolve: value => { result = value; }, activeProcesses: new Map(),
        scopeKey, chatSessionId: scopeKey, childProcess: null, releaseMainRun: () => false,
        scopedBucket: 'native-v1:cursor:' + scopeKey, runtimeTransport: 'native',
        retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
        fallbackState: new Map(), fallbackMaxRetries: 1, processQueue() {},
    } };
}

for (const activation of ['native-compact', 'turn-count', 'kiro-stale', 'stall', 'fallback'] as const) {
    test(`${activation} passes the captured whole bucket into real lifecycle compaction`, async () => {
        const { params } = fixture();
        if (activation === 'native-compact') params.ctx.cliNativeCompactDetected = true;
        if (activation === 'turn-count') {
            params.ctx.turns = 35;
            params.ctx.sessionId = 'cursor-turn-count-' + serial;
            params.opts = { _isSmokeContinuation: true };
        }
        if (activation === 'kiro-stale') {
            params.cli = 'kiro-code';
            params.runtimeTransport = 'print';
            params.scopedBucket = 'kiro-code:' + params.scopeKey;
            params.isResume = true;
            params.ctx.fullText = 'no saved chat sessions';
        }
        if (activation === 'stall') {
            params.code = 1;
            params.ctx.fullText = '';
            params.ctx.stallReason = 'no output for 900s';
            params.ctx.stderrBuf = 'stall detected';
        }
        if (activation === 'fallback') {
            params.code = 1;
            params.ctx.fullText = '';
            params.ctx.stderrBuf = 'fixture provider error';
            settings.fallbackOrder = ['gemini'];
        }
        await handleAgentExit(params);
        assert.equal(compactions.length, 1, 'the named branch must actually execute compaction');
        assert.equal(compactions[0]?.sessionBucket, params.scopedBucket,
            'later print settings cannot redirect a captured native/scoped run');
        assert.equal(compactions[0]?.scopeKey, params.scopeKey);
        if (activation === 'turn-count') assert.equal(compactions[0]?.expectedSessionId, params.ctx.sessionId);
        assert.equal(spawned.length, activation === 'kiro-stale' || activation === 'fallback' ? 1 : 0);
    });
}

test('turn guards skip an unsaved run even when runtime reports 35 turns', async () => {
    const { params } = fixture();
    params.ctx.sessionId = 'unsaved-' + serial;
    params.ctx.turns = 35;
    await handleAgentExit(params);
    assert.equal(compactions.length, 0);
    assert.equal(getSessionBucket.get(params.scopedBucket!), undefined);
});

function codexTurnFixture(previousTurns: number) {
    const { params } = fixture();
    params.cli = 'codex';
    params.runtimeTransport = 'print';
    params.scopedBucket = 'codex:' + params.scopeKey;
    params.ctx.sessionId = 'codex-session-' + serial;
    params.ctx.turns = null;
    params.opts = { _isSmokeContinuation: true };
    upsertSessionBucket.run(params.scopedBucket, params.ctx.sessionId, params.model, null, 0);
    db.prepare('UPDATE session_buckets SET turn_count=? WHERE bucket=?').run(previousTurns, params.scopedBucket);
    return params;
}

for (const [before, shouldClear] of [[14, false], [15, true]] as const) {
    test(`codex ${shouldClear ? 'clears at 16' : 'keeps at 15'} persisted turns`, async () => {
        const params = codexTurnFixture(before);
        await handleAgentExit(params);
        const row = getSessionBucket.get(params.scopedBucket!) as { session_id: string; turn_count: number } | undefined;
        assert.equal(row === undefined, shouldClear);
        if (!shouldClear) assert.equal(row?.turn_count, 15);
    });
}

test('codex high-turn clear leaves a newly owned bucket intact', async () => {
    const params = codexTurnFixture(15);
    db.exec(`CREATE TRIGGER replace_bucket_owner_after_turn
        AFTER UPDATE OF turn_count ON session_buckets
        WHEN NEW.bucket = '${params.scopedBucket}'
        BEGIN UPDATE session_buckets SET session_id='new-owner', turn_count=0 WHERE bucket=NEW.bucket; END`);
    try {
        await handleAgentExit(params);
        const row = getSessionBucket.get(params.scopedBucket!) as { session_id: string; turn_count: number } | undefined;
        assert.equal(row?.session_id, 'new-owner');
        assert.equal(row?.turn_count, 0);
    } finally {
        db.exec('DROP TRIGGER replace_bucket_owner_after_turn');
    }
});

for (const smoke of [false, true]) {
    test(`lifecycle ${smoke ? 'smoke' : 'normal'} save forwards native transport and preserves print singleton`, async () => {
        const f = fixture(), { params } = f;
        params.opts = smoke ? {} : { _isSmokeContinuation: true };
        params.ctx.sessionId = 'native-provider-session-' + serial;
        if (smoke) params.smokeResult = { isSmoke: true, confidence: 'high', matchedPattern: null, reason: 'fixture' };
        else params.ctx.runtimeOutcome = { status: 'done', finalText: 'final', partialText: '' };
        updateSession.run('cursor', 'print-singleton', 'fixture', 'auto', '', '');
        const before = getSession();
        await handleAgentExit(params);
        await Promise.resolve();
        assert.equal((getSessionBucket.get(params.scopedBucket!) as { session_id?: string })?.session_id, params.ctx.sessionId);
        assert.deepEqual(getSession(), before);
        assert.equal(spawned.length, smoke ? 1 : 0);
        assert.equal(f.result()?.code, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_buckets WHERE bucket = ?').get('cursor:' + params.scopeKey).n, 0);
    });
}
