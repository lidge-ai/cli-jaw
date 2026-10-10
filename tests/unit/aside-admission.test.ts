import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AsideCatalog } from '../../src/shared/aside-contract.ts';
import type { AsideRunInput, AsideRunCallbacks, AsideRunResult } from '../../src/agent/aside-runtime.ts';
import type { SpawnOpts, MainRunState } from '../../src/agent/spawn/types.ts';
import { COMPUTER_USE_APPROVAL_ENV } from '../../lib/mcp/computer-use-constants.ts';
import { SLACK_TOOL_GRANT_ENV } from '../../src/slack/tool-context.ts';

const catalog: AsideCatalog = {
    context: { account: 'u7', host: 'local' }, entries: [{ id: 'p/model', provider: 'p', modelId: 'model',
        name: 'Model', efforts: ['high'], thinkingLevelMap: { high: 'high' }, capability: 'registered' }],
    cachedIds: [], configuredDefault: { provider: 'p', modelId: 'model', thinkingLevel: 'high' },
    defaultModel: 'p/model', source: 'local-files', status: 'available', diagnostics: [],
};
const catalogs = await import('../../src/agent/aside-catalog.ts');
let readGate: PromiseWithResolvers<void> | undefined;
let readCount = 0;
const contexts: unknown[] = [];
mock.module('../../src/agent/aside-catalog.js', { namedExports: { ...catalogs,
    readAsideCatalog: async (context: unknown) => {
        readCount++; contexts.push(structuredClone(context));
        if (readGate) await readGate.promise;
        return { ...catalog, context };
    },
} });
const runs: Array<{ input: AsideRunInput; callbacks: AsideRunCallbacks; result: PromiseWithResolvers<AsideRunResult>; cancelCount: number }> = [];
mock.module('../../src/agent/aside-runtime.js', { namedExports: {
    startAsideRun(input: AsideRunInput, callbacks: AsideRunCallbacks = {}) {
        const run = { input, callbacks, result: Promise.withResolvers<AsideRunResult>(), cancelCount: 0 };
        runs.push(run);
        return { result: run.result.promise, cancel() { run.cancelCount++; return Promise.resolve(); } };
    },
} });
const config = await import('../../src/core/config.ts');
const testSettings = { ...config.settings };
// Detection is the process boundary. This suite must never inspect a live CLI or provider.
mock.module('../../src/core/config.js', { namedExports: { ...config, settings: testSettings,
    replaceSettings: (value: Record<string, unknown>) => {
        for (const key of Object.keys(testSettings)) delete testSettings[key];
        Object.assign(testSettings, value);
    },
    detectCli: () => ({ available: true, path: '/fixture/aside' }) } });
let failTraceStart = false, failLifecycleFinalize = false;
const trace = await import('../../src/trace/store.ts');
mock.module('../../src/trace/store.js', { namedExports: { ...trace,
    startTraceRun: (...args: Parameters<typeof trace.startTraceRun>) => {
        if (failTraceStart) throw new Error('fixture missing journal');
        return trace.startTraceRun(...args);
    },
} });
const realLifecycle = await import('../../src/agent/lifecycle-handler.ts');
mock.module('../../src/agent/lifecycle-handler.js', { namedExports: { ...realLifecycle,
    handleAgentExit: (...args: Parameters<typeof realLifecycle.handleAgentExit>) => {
        if (failLifecycleFinalize) throw new Error('fixture lifecycle observer failure');
        return realLifecycle.handleAgentExit(...args);
    },
} });
const spawn = await import('../../src/agent/spawn.ts');
const { asideAdmissionError } = await import('../../src/agent/spawn/backend-aside.ts');
const { submitMessage, __resetSubmitDedupForTest } = await import('../../src/orchestrator/gateway.ts');
const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
const { withSessionScope } = await import('../../src/core/session-context.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const terminalNotices = new Map<string, string>();
addBroadcastListener((type, data) => {
    if (type === 'agent_done' && typeof data['scope'] === 'string') terminalNotices.set(data['scope'], String(data['text'] || ''));
});
function tokenFor(scope: string): string {
    const token = terminalNotices.get(scope)?.match(/Acknowledgement token: ([0-9a-f-]{36})\./)?.[1];
    assert.ok(token, 'uncertainty diagnostic must carry its captured reconciliation token');
    return token;
}
const { getSessionBucket, upsertSessionBucket, db } = await import('../../src/core/db.ts');
const { buildAsideResumeKey } = await import('../../src/agent/spawn-env.ts');
const { getSessionOwnershipGeneration } = await import('../../src/agent/session-persistence.ts');
const { setPendingBootstrapPrompt, peekPendingBootstrapPrompt } = await import('../../src/core/main-session.ts');
const { triggerMemoryFlushForCurrentSession } = await import('../../src/agent/memory-flush-controller.ts');
const { seedDefaultEmployees, checkModelSupport, resolveDispatchableEmployee } = await import('../../src/core/employees.ts');
const { reloadSettingsFromDisk } = await import('../../src/core/settings-watch.ts');
const { settingsPatchPreservesActiveRun } = await import('../../src/core/runtime-settings.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { settleAllPending, admitRequest, pendingRequestIds } = await import('../../src/orchestrator/request-registry.ts');
const { resolveSelectedContext } = await import('../../src/orchestrator/dispatch-admission.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const snapshot = config.snapshotSettingsState();
let serial = 0;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const success = (sessionId = 'provider-new', finalText = 'ANSWER'): AsideRunResult => ({
    status: 'done', finalText, partialText: '', sessionId, reusable: true, exitCode: 0, cleanup: 'confirmed',
});
test.beforeEach(t => {
    failTraceStart = false; failLifecycleFinalize = false;
    readCount = 0; contexts.length = 0; runs.length = 0; readGate = undefined;
    for (const key of Object.keys(testSettings)) delete testSettings[key];
    Object.assign(testSettings, { ...structuredClone(snapshot.value), cli: 'aside', workingDir: config.JAW_HOME,
        permissions: 'safe', perCli: { aside: { account: 'u7', host: 'local', model: '', effort: '' } },
        fallbackOrder: ['aside', 'codex-app'], multiSession: { ...snapshot.value.multiSession,
            enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' } });
    __resetSubmitDedupForTest();
    t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network'));
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
});
test.afterEach(() => {
    readGate?.resolve(); clearGoalTimers(); spawn.activeMainProcesses.clear();
    spawn.messageQueue.splice(0); settleAllPending('cancelled', 'fixture-cleanup');
    Object.assign(testSettings, structuredClone(snapshot.value));
});
function start(opts: SpawnOpts = {}) {
    const id = ++serial;
    const scopeKey = `aside-scope-${id}`, chatSessionId = `aside-chat-${id}`;
    return { scopeKey, chatSessionId, ...spawn.spawnAgent('current task', { scopeKey, chatSessionId, cli: 'aside', ...opts }) };
}

for (const [name, opts, policy, expected] of [
    ['employee', { agentId: 'worker' }, 'safe', 'aside_main_only'],
    ['employee receipt', { employeeSessionId: 'old' }, 'safe', 'aside_main_only'],
    ['internal flush', { internal: true }, 'safe', 'aside_main_only'],
    ['forced worker', { forceNew: true }, 'safe', 'aside_main_only'],
    ['fallback', { _isFallback: true }, 'safe', 'aside_automatic_retry_unsupported'],
    ['retry zero', { _retryAttempt: 0 }, 'safe', 'aside_automatic_retry_unsupported'],
    ['smoke', { _isSmokeContinuation: true }, 'safe', 'aside_automatic_retry_unsupported'],
    ['goal', { _isGoalContinuation: true }, 'safe', 'aside_automatic_retry_unsupported'],
    ['images', { images: [{ path: '/fixture/image' }] }, 'safe', 'aside_images_unsupported'],
    ['array', {}, ['safe'], 'aside_policy_unsupported'],
    ['deny', {}, 'deny', 'aside_policy_unsupported'],
    ['empty policy', {}, '', 'aside_policy_unsupported'],
] as const) {
    test(`real spawn rejects ${name} before catalog/bootstrap/runtime`, async () => {
        const scopeKey = `reject-${++serial}`;
        setPendingBootstrapPrompt('KEEP BOOTSTRAP', scopeKey);
        const options = { ...opts, permissions: policy, cli: 'aside', scopeKey, chatSessionId: scopeKey } as SpawnOpts;
        const result = await spawn.spawnAgent('reject me', options).promise;
        assert.equal(result.code, 78); assert.equal(result.text, expected);
        assert.equal(readCount, 0); assert.equal(runs.length, 0);
        assert.equal(peekPendingBootstrapPrompt(scopeKey), 'KEEP BOOTSTRAP');
    });
}

test('heartbeat fails closed before catalog/bootstrap/runtime and settles the captured request once', async t => {
    const scopeKey = `heartbeat-reject-${++serial}`, requestId = `heartbeat-request-${serial}`;
    setPendingBootstrapPrompt('KEEP SCHEDULED BOOTSTRAP', scopeKey);
    admitRequest(requestId, scopeKey);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => {
        if (data['requestId'] === requestId) events.push({ type, data });
    };
    addBroadcastListener(listener);
    t.after(() => removeBroadcastListener(listener));
    const exits: number[] = [];
    const result = await spawn.spawnAgent('scheduled input', { cli: 'aside', origin: 'heartbeat',
        scopeKey, chatSessionId: scopeKey, requestId, lifecycle: { onExit: code => { exits.push(code); } } }).promise;
    assert.equal(result.code, 78); assert.equal(result.text, 'aside_scheduled_unsupported');
    assert.equal(readCount, 0); assert.equal(runs.length, 0);
    assert.equal(peekPendingBootstrapPrompt(scopeKey), 'KEEP SCHEDULED BOOTSTRAP');
    assert.deepEqual(exits, [78]);
    assert.equal(spawn.activeMainProcesses.has(scopeKey), false);
    assert.equal(pendingRequestIds().includes(requestId), false);
    const settlements = events.filter(event => event.type === 'request_settled');
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.data['outcome'], 'failed');
    assert.equal(settlements[0]!.data['error'], 'aside_scheduled_unsupported');
    const done = events.filter(event => event.type === 'agent_done');
    assert.equal(done.length, 1); assert.equal(done[0]!.data['text'], 'aside_scheduled_unsupported');
    assert.equal(done[0]!.data['error'], true);
    assert.equal(asideAdmissionError(false, {}, 'safe', 'heartbeat'), 'aside_main_only');
});

test('web origin remains admitted', async () => {
    const first = start({ origin: 'web' }); await turn();
    assert.equal(readCount, 1); assert.equal(runs.length, 1);
    runs[0]!.result.resolve(success());
    assert.equal((await first.promise).code, 0);
});

for (const policy of ['safe', 'auto'] as const) {
    test(`captured ${policy} pins computer-use approval and strips parent/option Slack grants`, async t => {
        const oldApproval = process.env[COMPUTER_USE_APPROVAL_ENV];
        const oldGrant = process.env[SLACK_TOOL_GRANT_ENV];
        t.after(() => {
            if (oldApproval === undefined) delete process.env[COMPUTER_USE_APPROVAL_ENV];
            else process.env[COMPUTER_USE_APPROVAL_ENV] = oldApproval;
            if (oldGrant === undefined) delete process.env[SLACK_TOOL_GRANT_ENV];
            else process.env[SLACK_TOOL_GRANT_ENV] = oldGrant;
        });
        process.env[COMPUTER_USE_APPROVAL_ENV] = 'auto';
        process.env[SLACK_TOOL_GRANT_ENV] = 'fixture-parent-grant';
        readGate = Promise.withResolvers<void>();
        const first = start({ permissions: policy, env: {
            [COMPUTER_USE_APPROVAL_ENV]: policy === 'safe' ? 'auto' : 'safe',
            [SLACK_TOOL_GRANT_ENV]: 'fixture-option-grant',
        } });
        testSettings.permissions = policy === 'safe' ? 'auto' : 'safe';
        readGate.resolve(); await turn();
        const run = runs[0]!;
        assert.equal(run.input.env?.[COMPUTER_USE_APPROVAL_ENV], policy);
        assert.equal(Object.hasOwn(run.input.env!, SLACK_TOOL_GRANT_ENV), false);
        assert.equal(run.input.permission, policy === 'auto' ? 'full-access' : 'guard');
        run.result.resolve(success()); await first.promise;
    });
}

test('running Aside main captures request policy and delivery for request-bound dispatch', async () => {
    const scopeKey = `meta-aside-${++serial}`, requestId = `meta-request-${serial}`;
    const chatSessionId = createChatSession('Aside dispatch fixture', { activate: false }).id;
    const target: NonNullable<SpawnOpts['target']> = { channel: 'slack', targetKind: 'channel',
        peerKind: 'channel', targetId: 'C_FIXTURE', threadId: '123.456' };
    readGate = Promise.withResolvers<void>();
    const first = spawn.spawnAgent('captured metadata', { cli: 'aside', origin: 'web', scopeKey,
        chatSessionId, requestId, target, chatId: 'C_FIXTURE', replyViaTarget: true,
        remoteKey: 'fixture-remote-key', model: 'p/model', permissions: 'safe' });
    // The main metadata must already exist before asynchronous catalog preparation.
    assert.equal(spawn.getCurrentMainMeta(scopeKey)?.model, 'p/model');
    testSettings.permissions = 'auto';
    readGate.resolve(); await turn();
    assert.equal(runs.length, 1);
    assert.deepEqual(spawn.getCurrentMainMeta(scopeKey), { origin: 'web', cli: 'aside', permissions: 'safe',
        target, chatId: 'C_FIXTURE', requestId, replyViaTarget: true, scopeId: scopeKey,
        chatSessionId, remoteKey: 'fixture-remote-key', model: 'p/model', effectiveProvider: 'aside' });
    const selected = resolveSelectedContext({ scopeKey, chatSessionId, requestId });
    assert.equal(selected.ok, true);
    if (!selected.ok) assert.fail(selected.error);
    assert.equal(selected.ctx.parentRequestId, requestId);
    assert.equal(selected.ctx.scopeKey, scopeKey); assert.equal(selected.ctx.chatSessionId, chatSessionId);
    assert.equal(selected.ctx.permissions, 'safe');
    assert.deepEqual(selected.ctx.replayMeta.target, target);
    assert.equal(selected.ctx.replayMeta.replyViaTarget, true);
    assert.deepEqual(resolveSelectedContext({ scopeKey, chatSessionId, requestId: `${requestId}-wrong` }),
        { ok: false, status: 409, error: 'dispatch_context_conflict' });
    runs[0]!.result.resolve(success()); await first.promise;
    assert.equal(spawn.getCurrentMainMeta(scopeKey), null);
});

test('capture account/cwd/policy before await; resolve empty defaults once; persist concrete identity and exact final', async () => {
    readGate = Promise.withResolvers<void>();
    const first = start({ sysPrompt: 'OWNED SYSTEM', _skipHistory: true });
    const capturedCwd = testSettings.workingDir;
    testSettings.perCli.aside = { account: 'u9', host: 'local', model: 'other/nope', effort: 'low' };
    testSettings.workingDir = '/different'; testSettings.permissions = 'auto';
    readGate.resolve(); await turn();
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.deepEqual(contexts, [{ account: 'u7', host: 'local' }]);
    assert.deepEqual(run.input.selection, { account: 'u7', host: 'local', provider: 'p', modelId: 'model', model: 'p/model', effort: 'high' });
    assert.equal(run.input.cwd, capturedCwd); assert.equal(run.input.permission, 'guard');
    assert.match(run.input.prompt, /OWNED SYSTEM/); assert.match(run.input.prompt, /Project root:/);
    run.callbacks.onSession?.('provisional'); run.callbacks.onOutput?.('DIAGNOSTIC ONLY');
    run.result.resolve(success('captured-provider', ' \n\t '));
    const result = await first.promise;
    assert.equal(result.runtimeOutcome?.finalText, ' \n\t ');
    const saved = getSessionBucket.get(`aside:${first.scopeKey}`) as { session_id: string; model: string; resume_key: string };
    assert.equal(saved.session_id, 'captured-provider'); assert.equal(saved.model, 'p/model');
    assert.equal(saved.resume_key, JSON.stringify(['aside-v1', 'u7', 'local', 'p', 'model', 'high', capturedCwd, 'safe']));
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE role = ? AND session_id = ?').all('assistant', first.chatSessionId), [{ content: ' \n\t ' }]);
});

test('Stop during catalog read cancels before dispatch and preserves bootstrap', async () => {
    readGate = Promise.withResolvers<void>();
    const first = start();
    setPendingBootstrapPrompt('KEEP STOPPED BOOTSTRAP', first.scopeKey);
    assert.equal(spawn.killActiveAgent(first.scopeKey, 'user'), true);
    readGate.resolve(); const result = await first.promise;
    assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(runs.length, 0);
    assert.equal(peekPendingBootstrapPrompt(first.scopeKey), 'KEEP STOPPED BOOTSTRAP');
});

test('Stop before session ID uses runtime handle once and cannot persist a late final', async () => {
    const first = start(); await turn(); const run = runs[0]!;
    spawn.killActiveAgent(first.scopeKey, 'user'); spawn.killActiveAgent(first.scopeKey, 'user');
    assert.equal(run.cancelCount, 1);
    run.callbacks.onSession?.('cancelled-provider'); run.result.resolve(success('cancelled-provider', 'LATE ANSWER'));
    const result = await first.promise;
    assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
    assert.equal(getSessionBucket.get(`aside:${first.scopeKey}`), undefined);
});

for (const entry of ['gateway', 'slash'] as const) {
    test(`${entry} steer queues exactly once, never replaces/stops, and Stop purges input`, async () => {
        const scope = `steer-aside-${++serial}`, chatSessionId = `steer-chat-${serial}`;
        let cancels = 0, replacements = 0;
        const owner: MainRunState = { process: null, starting: true, steering: false,
            ownerGeneration: getSessionOwnershipGeneration(scope).global,
            meta: { cli: 'aside', origin: 'web', scopeId: scope, chatSessionId },
            cancelTurn: () => { cancels++; }, replaceTurn: async () => { replacements++; return { kind: 'dispatched' }; } };
        spawn.activeMainProcesses.set(scope, owner);
        if (entry === 'gateway') {
            const result = submitMessage('NEW ASIDE INPUT', { origin: 'web', scope, chatSessionId });
            assert.equal(result.action, 'queued');
        } else {
            const ctx = makeCommandCtx('web', 'en', { applySettings: async () => ({}) });
            const result = await withSessionScope({ scope, chatSessionId }, () => steerHandler(['NEW ASIDE INPUT'], ctx));
            assert.equal(result.ok, true);
        }
        await turn();
        assert.equal(spawn.messageQueue.filter(row => row.scope === scope).length, 1);
        assert.equal(cancels, 0); assert.equal(replacements, 0);
        spawn.killActiveAgent(scope, 'user');
        await turn(); assert.equal(spawn.messageQueue.filter(row => row.scope === scope).length, 0);
    });
}

test('complete resume identity includes account, host, provider, model, effort, cwd and policy', () => {
    const selection = { account: 'u7', host: 'local' as const, provider: 'p', modelId: 'model', model: 'p/model', effort: 'high' as const };
    const key = buildAsideResumeKey(selection, '/owned', 'safe');
    assert.notEqual(key, buildAsideResumeKey({ ...selection, account: 'u8' }, '/owned', 'safe'));
    assert.notEqual(key, buildAsideResumeKey({ ...selection, provider: 'q' }, '/owned', 'safe'));
    assert.notEqual(key, buildAsideResumeKey({ ...selection, modelId: 'changed' }, '/owned', 'safe'));
    assert.notEqual(key, buildAsideResumeKey({ ...selection, effort: null }, '/owned', 'safe'));
    assert.notEqual(key, buildAsideResumeKey(selection, '/other', 'safe'));
    assert.notEqual(key, buildAsideResumeKey(selection, '/owned', 'auto'));
    assert.equal(asideAdmissionError(true, {}, 'safe'), null);
});

test('nonreusable error clears only captured bucket and makes no blind fallback', async () => {
    const first = start(); await turn(); const run = runs[0]!;
    upsertSessionBucket.run(`aside:${first.scopeKey}`, 'old', 'p/model', 'old-key', 0);
    const otherBucket = `aside:unrelated-${serial}`;
    upsertSessionBucket.run(otherBucket, 'OTHER', 'p/model', 'other-key', 0);
    run.result.resolve({ status: 'error', finalText: null, partialText: '', sessionId: 'error-provider',
        reusable: false, exitCode: 0, cleanup: 'confirmed', diagnostic: 'provider failed' });
    const result = await first.promise;
    assert.equal(result.runtimeOutcome?.status, 'error'); assert.equal(result.code, 1); assert.equal(runs.length, 1);
    assert.equal(getSessionBucket.get(`aside:${first.scopeKey}`), undefined);
    assert.equal((getSessionBucket.get(otherBucket) as { session_id: string }).session_id, 'OTHER');
});

test('typed cleanup uncertainty retains captured owner and blocks queued automatic continuation without local cancel', async () => {
    const first = start(); await turn(); const run = runs[0]!;
    const owner = spawn.activeMainProcesses.get(first.scopeKey);
    const queued = submitMessage('QUEUED AFTER DEADLINE', { origin: 'web', scope: first.scopeKey, chatSessionId: first.chatSessionId });
    assert.equal(queued.action, 'queued');
    run.result.resolve(Object.assign({ status: 'error' as const, finalText: null, partialText: '',
        sessionId: 'uncertain-provider', reusable: false, exitCode: 0, diagnostic: 'fixture uncertainty' }, { cleanup: 'uncertain' }));
    const result = await first.promise;
    await turn();
    assert.equal(result.code, 1); assert.equal(result.runtimeOutcome?.status, 'error');
    assert.equal(spawn.activeMainProcesses.get(first.scopeKey), owner);
    assert.equal(spawn.isAgentBusy(first.scopeKey), true);
    assert.equal(spawn.messageQueue.filter(row => row.scope === first.scopeKey).length, 1);
    assert.equal(runs.length, 1); assert.equal(getSessionBucket.get(`aside:${first.scopeKey}`), undefined);
});

test('late uncertain result never retains or clears a newer run', async () => {
    const first = start(); await turn(); const old = runs[0]!;
    const newer: MainRunState = { process: null, starting: true, steering: false,
        ownerGeneration: getSessionOwnershipGeneration(first.scopeKey).global,
        meta: { cli: 'aside', origin: 'web', chatSessionId: first.chatSessionId } };
    spawn.activeMainProcesses.set(first.scopeKey, newer);
    upsertSessionBucket.run(`aside:${first.scopeKey}`, 'NEWER', 'p/model', 'new-key', 0);
    old.result.resolve(Object.assign({ status: 'stopped' as const, finalText: null, partialText: '',
        sessionId: 'OLD', reusable: false, exitCode: null }, { cleanup: 'uncertain' }));
    await first.promise;
    assert.equal(spawn.activeMainProcesses.get(first.scopeKey), newer);
    assert.equal((getSessionBucket.get(`aside:${first.scopeKey}`) as { session_id: string }).session_id, 'NEWER');
    assert.equal(newer.cancelTurn, undefined);
});

test('complete resume identity is honored by real backend and changed account starts fresh', async () => {
    const scopeKey = `resume-${++serial}`, chatSessionId = `resume-chat-${serial}`;
    const selection = { account: 'u7', host: 'local' as const, provider: 'p', modelId: 'model', model: 'p/model', effort: 'high' as const };
    upsertSessionBucket.run(`aside:${scopeKey}`, 'RESUME-OWNED', 'p/model', buildAsideResumeKey(selection, testSettings.workingDir, 'safe'), 0);
    const first = spawn.spawnAgent('resume task', { cli: 'aside', scopeKey, chatSessionId });
    await turn(); assert.equal(runs[0]?.input.sessionId, 'RESUME-OWNED');
    runs[0]!.result.resolve(success('RESUME-OWNED')); await first.promise;
    testSettings.perCli.aside.account = 'u8';
    const second = spawn.spawnAgent('fresh task', { cli: 'aside', scopeKey, chatSessionId });
    await turn(); assert.equal(runs[1]?.input.sessionId, undefined);
    runs[1]!.result.resolve(success('FRESH-ACCOUNT')); await second.promise;
});

for (const fault of ['trace-admission', 'lifecycle-observer'] as const) {
    test(`${fault} cannot overwrite a selected runtime final`, async () => {
        failTraceStart = fault === 'trace-admission';
        failLifecycleFinalize = fault === 'lifecycle-observer';
        const first = start(); await turn();
        assert.equal(runs.length, 1);
        runs[0]!.result.resolve(success('SUCCESS-OWNED', ' AUTHORITATIVE FINAL '));
        const result = await first.promise;
        assert.equal(result.code, 0); assert.equal(result.runtimeOutcome?.status, 'done');
        assert.equal(result.runtimeOutcome?.finalText, ' AUTHORITATIVE FINAL ');
        assert.equal(result.text, ' AUTHORITATIVE FINAL ');
        assert.equal(spawn.activeMainProcesses.has(first.scopeKey), false);
    });
}

test('failed catalog boundary before dispatch leaves bootstrap intact and closes once', async () => {
    testSettings.perCli.aside.account = '../invalid';
    const scopeKey = `catalog-reject-${++serial}`;
    setPendingBootstrapPrompt('UNCHANGED', scopeKey);
    let exits = 0;
    const result = await spawn.spawnAgent('input', { cli: 'aside', scopeKey, chatSessionId: scopeKey,
        lifecycle: { onExit: () => { exits++; } } }).promise;
    assert.equal(result.code, 78); assert.equal(exits, 1); assert.equal(readCount, 0); assert.equal(runs.length, 0);
    assert.equal(peekPendingBootstrapPrompt(scopeKey), 'UNCHANGED');
});

test('manual reconciliation requires captured child close, purges old input and permits a fresh run', async () => {
    const { ChildProcess } = await import('node:child_process');
    const first = start(); await turn(); const run = runs[0]!;
    const child = new ChildProcess(); run.callbacks.onChild?.(child);
    submitMessage('OLD QUEUED WORK', { origin: 'web', scope: first.scopeKey, chatSessionId: first.chatSessionId });
    run.result.resolve({ status: 'stopped', finalText: null, partialText: '', sessionId: 'UNCERTAIN',
        reusable: false, exitCode: null, cleanup: 'uncertain' });
    await first.promise;
    assert.equal(spawn.reconcileAsideScope(first.scopeKey, first.chatSessionId, tokenFor(first.scopeKey)), false);
    child.emit('close', null, 'SIGTERM');
    assert.equal(spawn.reconcileAsideScope(first.scopeKey, 'wrong-chat', tokenFor(first.scopeKey)), false);
    assert.equal(spawn.reconcileAsideScope(first.scopeKey, first.chatSessionId, tokenFor(first.scopeKey)), true);
    assert.equal(spawn.messageQueue.filter(row => row.scope === first.scopeKey).length, 0);
    assert.equal(spawn.activeMainProcesses.has(first.scopeKey), false);
    const fresh = spawn.spawnAgent('FRESH USER INPUT', { cli: 'aside', scopeKey: first.scopeKey, chatSessionId: first.chatSessionId });
    await turn(); assert.equal(runs[1]?.input.sessionId, undefined);
    runs[1]!.result.resolve(success()); await fresh.promise;
});

test('worker seeding and memory flush cannot inherit Aside', async () => {
    const before = db.prepare('SELECT * FROM employees').all();
    const seeded = await seedDefaultEmployees({ reset: true });
    assert.equal(seeded.skipped, true);
    assert.deepEqual(db.prepare('SELECT * FROM employees').all(), before);
    assert.equal(await triggerMemoryFlushForCurrentSession(), 'unavailable');
    assert.equal(runs.length, 0);
    assert.deepEqual(checkModelSupport('aside', 'p/model').fail, ['Aside supports main sessions only.']);
    assert.equal(await resolveDispatchableEmployee('AsideWorker', [{ id: 'blocked-worker', name: 'AsideWorker',
        cli: 'aside', model: 'p/model', role: 'fixture' }]), null);
});

test('watch selector changes invalidate captured ownership and malformed selector retains prior selection', () => {
    const before = getSessionOwnershipGeneration('watch-aside');
    assert.equal(settingsPatchPreservesActiveRun({ perCli: { aside: { account: 'u8' } } }), false);
    assert.equal(reloadSettingsFromDisk({ lastSavedRaw: null, readImpl: () => JSON.stringify({
        perCli: { aside: { account: 'u8' } } }) }), true);
    assert.notEqual(getSessionOwnershipGeneration('watch-aside').global, before.global);
    assert.equal(testSettings.perCli.aside.account, 'u8');
    assert.equal(reloadSettingsFromDisk({ lastSavedRaw: null, readImpl: () => JSON.stringify({
        perCli: { aside: { host: 'remote' } } }) }), false);
    assert.equal(testSettings.perCli.aside.host, 'local');
});

test('registered reconciliation route rejects stale run token, wrong or unknown chat with multi-session off', async () => {
    const { registerOrchestrateRoutes } = await import('../../src/routes/orchestrate.ts');
    const { createChatSession } = await import('../../src/core/chat-sessions.ts');
    const wrongChat = createChatSession('reconciliation wrong chat');
    testSettings.multiSession.enabled = false;
    type Handler = import('express').RequestHandler;
    const routes = new Map<string, Handler[]>();
    const capture = (method: string) => (url: string, ...handlers: Handler[]) => { routes.set(`${method} ${url}`, handlers); };
    const auth: Handler = (_req, _res, next) => { next(); };
    registerOrchestrateRoutes({ post: capture('POST'), get: capture('GET'), put: capture('PUT'),
        delete: capture('DELETE'), patch: capture('PATCH') } as unknown as import('express').Express, auth);
    const route = routes.get('POST /api/orchestrate/aside/reconcile')!;
    assert.equal(route[0], auth);
    const invoke = async (sessionId: string, acknowledgementToken: string) => {
        const result = { status: 200, body: undefined as unknown };
        const response = { status(value: number) { result.status = value; return response; },
            json(value: unknown) { result.body = value; return response; } };
        await route.at(-1)!({ body: { sessionId, acknowledgementToken, acknowledged: true } } as import('express').Request,
            response as unknown as import('express').Response, error => { if (error) throw error; });
        return result;
    };
    const uncertain = async (externalId: string) => {
        const next = spawn.spawnAgent('RECONCILIATION FIXTURE', { cli: 'aside', scopeKey: 'default', chatSessionId: 'default' });
        await turn();
        runs.at(-1)!.result.resolve({ status: 'stopped', finalText: null, partialText: '', sessionId: externalId,
            reusable: false, exitCode: null, cleanup: 'uncertain' });
        await next.promise;
        const notice = terminalNotices.get('default')!;
        assert.match(notice, /Jaw chat ID: default\./);
        assert.ok(notice.includes(`External Aside ID: ${externalId}`));
        return tokenFor('default');
    };
    const tokenA = await uncertain('EXTERNAL-A');
    assert.equal((await invoke('default', tokenA)).status, 200);
    const tokenB = await uncertain('EXTERNAL-B');
    assert.notEqual(tokenB, tokenA);
    const ownerB = spawn.activeMainProcesses.get('default');
    submitMessage('KEEP QUEUED B', { origin: 'web', scope: 'default', chatSessionId: 'default' });
    assert.equal(spawn.messageQueue.length, 1);
    assert.equal((await invoke('default', tokenA)).status, 409);
    assert.equal((await invoke(wrongChat.id, tokenB)).status, 409);
    assert.equal((await invoke('unknown-reconciliation-chat', tokenB)).status, 404);
    assert.equal(spawn.activeMainProcesses.get('default'), ownerB);
    assert.equal(spawn.messageQueue.length, 1);
    assert.equal((await invoke('default', tokenB)).status, 200);
    assert.equal(spawn.activeMainProcesses.has('default'), false);
    assert.equal(spawn.messageQueue.length, 0);
});
