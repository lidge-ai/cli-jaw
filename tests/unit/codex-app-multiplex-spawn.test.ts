import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { RuntimeEnd } from '../../src/agent/runtime/projection.ts';

const runtimeEvents: RuntimeEvent[] = [];
test.mock.module('../../src/agent/runtime/events.js', {
    namedExports: {
        recordRuntimeEvent: (context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent => {
            const event: RuntimeEvent = { ...context, version: 1, seq: 3 * (runtimeEvents.length + 1), ...body };
            runtimeEvents.push(event);
            return event;
        },
        // A partial namedExports replaces the whole module, so every symbol the
        // real projection imports has to be present here or the import throws
        // before a single assertion runs.
        recordRuntimeProjectionLoss: () => undefined,
    },
});

type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

type TurnHandlers = {
    role: 'lifecycle' | 'consumer';
    onNotification(method: string, params: Record<string, unknown>, owner?: { threadId: string; turnId: string }): void;
};

const harness = {
    clients: [] as FakeCodexAppClient[],
    directSpawns: 0,
    throwDirectSpawn: false,
    genericAcquires: [] as Array<Record<string, unknown>>,
    prepares: [] as Array<Record<string, unknown>>,
    laneAcquires: [] as Array<Record<string, unknown>>,
    startPrompts: [] as Array<{ scope: string; prompt: string; threadId: string }>,
    releases: 0,
    prepareStale: 0,
    acquireStale: 0,
    alwaysPrepareStale: false,
    recoverableResumeFailure: false,
    acquireGate: null as Deferred<FakeLaneLease> | null,
    acquireSignal: null as (() => void) | null,
    prepareGate: null as Deferred<{ laneMode: 'fallback' }> | null,
    hostClient: null as FakeCodexAppClient | null,
    laneThreads: new Map<string, string>(),
    genericThreads: new Map<string, string>(),
    nextThread: 1,
    processQueueCalls: [] as string[],
    finalized: [] as Array<{ runId: string | null | undefined; status: string }>,
    clearLiveRunCalls: [] as string[],
    lifecycleCalls: [] as Array<Record<string, unknown>>,
    traceEvents: [] as Array<Record<string, unknown>>,
    emitCompositeNotifications: false,
};

class FakeCodexAppClient extends EventEmitter {
    proc = Object.assign(new EventEmitter(), {
        pid: 50_000 + harness.clients.length,
        exitCode: null as number | null,
        signalCode: null as string | null,
        killed: false,
    });
    private readonly scopedThreads = new Map<string, string>();
    private readonly scopedTurns = new Map<string, string>();
    private readonly scopedHandlers = new Map<string, TurnHandlers>();

    constructor(_options: unknown = {}) {
        super();
        harness.clients.push(this);
    }

    spawn(): void {
        harness.directSpawns += 1;
        if (harness.throwDirectSpawn) throw new Error('fixture direct spawn failed');
    }

    initialize(): Promise<Record<string, never>> {
        return Promise.resolve({});
    }

    bindScope(scope: string, threadId: string): void {
        this.scopedThreads.set(scope, threadId);
    }

    getThreadId(scope: string): string | null {
        return this.scopedThreads.get(scope) ?? null;
    }

    getActiveTurnId(scope: string): string | null {
        return this.scopedTurns.get(scope) ?? null;
    }

    async startThread(scope: string, _options: Record<string, unknown>): Promise<string> {
        const threadId = `thread-${harness.nextThread++}`;
        this.scopedThreads.set(scope, threadId);
        return threadId;
    }

    async resumeThread(scope: string, threadId: string, _options: Record<string, unknown>): Promise<string> {
        this.scopedThreads.set(scope, threadId);
        return threadId;
    }

    listenTurn(scope: string, handlers: TurnHandlers): { dispose(): void } {
        this.scopedHandlers.set(scope, handlers);
        return { dispose: () => { this.scopedHandlers.delete(scope); } };
    }

    listenHostNotifications(handlers: {
        onNotification(method: string, params: Record<string, unknown>): void;
    }): { dispose(): void } {
        const listener = (method: string, params: Record<string, unknown>) => {
            handlers.onNotification(method, params);
        };
        this.on('host-notification', listener);
        this.on('notification', listener);
        let disposed = false;
        return { dispose: () => {
            if (disposed) return;
            disposed = true;
            this.off('host-notification', listener);
            this.off('notification', listener);
        } };
    }

    async startTurn(scope: string, prompt: string): Promise<Record<string, never>> {
        const threadId = this.scopedThreads.get(scope)!;
        const turnId = `turn-${harness.startPrompts.length + 1}`;
        harness.startPrompts.push({ scope, prompt, threadId });
        this.scopedTurns.set(scope, turnId);
        const handlers = this.scopedHandlers.get(scope);
        const owner = { threadId, turnId };
        if (harness.emitCompositeNotifications) {
            this.emit('host-notification', 'configWarning', { message: 'known host' });
            this.emit('host-notification', 'error', {
                error: { message: 'ownerless host error' }, willRetry: false,
            });
            this.emit('unrouted-notification', {
                method: 'future/raw', params: { value: 1 }, reason: 'unknown-method',
            });
        }
        handlers?.onNotification('turn/started', { threadId, turn: { id: turnId } }, owner);
        handlers?.onNotification('turn/completed', {
            threadId,
            turn: { id: turnId, status: 'completed' },
        }, owner);
        this.scopedTurns.delete(scope);
        return {};
    }

    interruptTurn(_scope: string): Promise<void> {
        return Promise.resolve();
    }

    closeGracefully(): Promise<void> {
        this.proc.killed = true;
        return Promise.resolve();
    }

    cleanup(): void {}
    kill(): void { this.proc.killed = true; }
}

type FakeLaneLease = {
    client: FakeCodexAppClient;
    scopeKey: string;
    laneScope: string;
    bucketKey: string;
    threadId: string;
    laneMode: 'fallback';
    reused: boolean;
    resumedThread: boolean;
    release(): void;
    cancel(): Promise<void>;
};

class CodexHostGenerationStaleError extends Error {
    readonly code = 'CODEX_HOST_GENERATION_STALE';
}

function createLaneLease(options: Record<string, unknown>): FakeLaneLease {
    const scopeKey = String(options['scopeKey']);
    const bucketKey = String(options['bucketKey']);
    const laneScope = `${scopeKey}:gpt-multiplex:high`;
    const storedThreadId = typeof options['storedThreadId'] === 'string' ? options['storedThreadId'] : null;
    const existing = harness.laneThreads.get(scopeKey) ?? null;
    let threadId: string;
    let reused = false;
    let resumedThread = false;
    if (existing) {
        threadId = existing;
        reused = true;
    } else if (storedThreadId && !harness.recoverableResumeFailure) {
        threadId = storedThreadId;
        resumedThread = true;
    } else {
        threadId = `thread-${harness.nextThread++}`;
    }
    harness.laneThreads.set(scopeKey, threadId);
    const client = harness.hostClient ??= new FakeCodexAppClient();
    client.bindScope(laneScope, threadId);
    return {
        client, scopeKey, laneScope, bucketKey, threadId, laneMode: 'fallback', reused, resumedThread,
        release: () => { harness.releases += 1; },
        cancel: async () => {},
    };
}

// This fixture exercises only the Codex App routing layer. Make CLI detection
// deterministic so CI does not require a real `codex` binary on PATH; otherwise
// spawnAgent exits at its preflight guard before any of the mocked pool/client
// behavior can run.
const realConfig = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', {
    namedExports: {
        ...realConfig,
        detectCli: () => ({ available: true, path: null }),
    },
});

test.mock.module('../../src/agent/codex-app-client.js', {
    namedExports: {
        CodexAppClient: FakeCodexAppClient,
        // wp2: spawn.ts imports the typed steer error; the fake client never
        // throws it, but the export must exist for the module mock to link.
        CodexSteerError: class CodexSteerError extends Error {},
        isRecoverableResumeError: (message: string) => /not found|no rollout|unknown thread/i.test(message),
    },
});

test.mock.module('../../src/agent/codex-host-pool.js', {
    namedExports: {
        CodexHostGenerationStaleError,
        prepareCodexAppHost: async (options: Record<string, unknown>) => {
            harness.prepares.push(options);
            if (harness.alwaysPrepareStale || harness.prepareStale > 0) {
                harness.prepareStale = Math.max(0, harness.prepareStale - 1);
                throw new CodexHostGenerationStaleError('prepare stale');
            }
            if (harness.prepareGate) return harness.prepareGate.promise;
            return { laneMode: 'fallback' as const };
        },
        acquireCodexAppLane: async (_prepared: unknown, options: Record<string, unknown>) => {
            harness.laneAcquires.push(options);
            harness.acquireSignal?.();
            if (harness.acquireStale > 0) {
                harness.acquireStale -= 1;
                throw new CodexHostGenerationStaleError('acquire stale');
            }
            if (harness.acquireGate) return harness.acquireGate.promise;
            return createLaneLease(options);
        },
    },
});

function forbiddenProviderAcquire(provider: string): never {
    assert.fail(`${provider} runtime acquisition is outside this Codex App fixture`);
}

test.mock.module('../../src/agent/runtime-pool.js', {
    namedExports: {
        acquireCodexAppRuntime: async (options: Record<string, unknown>) => {
            harness.genericAcquires.push(options);
            const key = options['key'] as { scopeKey: string; model: string; effort: string };
            const laneScope = `${key.scopeKey}:${key.model}:${key.effort}`;
            const storedThreadId = typeof options['storedThreadId'] === 'string' ? options['storedThreadId'] : null;
            const threadId = storedThreadId
                ?? harness.genericThreads.get(key.scopeKey)
                ?? `generic-${harness.nextThread++}`;
            harness.genericThreads.set(key.scopeKey, threadId);
            const client = new FakeCodexAppClient();
            client.bindScope(laneScope, threadId);
            return {
                client,
                threadId,
                laneScope,
                reused: false,
                resumedThread: storedThreadId !== null,
                release: () => { harness.releases += 1; },
                cancel: async () => {},
            };
        },
        acquirePiRuntime: async () => forbiddenProviderAcquire('Pi'),
        acquireCursorRuntime: async () => forbiddenProviderAcquire('Cursor'),
        acquireGrokRuntime: async () => forbiddenProviderAcquire('Grok'),
        acquireClaudeRuntime: async () => forbiddenProviderAcquire('Claude'),
    },
});

test.mock.module('../../src/agent/spawn/queue.js', {
    namedExports: {
        FALLBACK_MAX_RETRIES: 3,
        createQueueController: () => {
            const fallbackByScope = new Map<string, Map<string, { fallbackCli?: string; retriesLeft: number }>>();
            const retryState = {
                setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {},
            };
            return {
                messageQueue: [],
                enqueueMessage: () => 'queued',
                removeQueuedMessage: () => false,
                processQueue: async (scopeKey: string) => { harness.processQueueCalls.push(scopeKey); },
                setQueueHold() {}, clearQueueHold() {}, getQueueHoldId: () => null,
                isRetryPending: () => false, isQueueBusy: () => false, clearRetryTimer: () => false,
                retryStateForScope: () => retryState,
                resetFallbackState() {},
                getFallbackState: () => null,
                getQueuedMessageSnapshotForScope: () => [],
                purgeQueueOnStop: () => 0,
                fallbackStateForScope: (scopeKey: string) => {
                    let state = fallbackByScope.get(scopeKey);
                    if (!state) { state = new Map(); fallbackByScope.set(scopeKey, state); }
                    return state;
                },
            };
        },
    },
});

test.mock.module('../../src/agent/live-run-state.js', {
    namedExports: {
        beginLiveRun() {}, appendLiveRunText() {}, setLiveRunTraceId() {}, replaceLiveRunTools() {}, appendLiveRunTool() {},
        clearLiveRun: (scopeKey: string) => { harness.clearLiveRunCalls.push(scopeKey); },
        getLiveRun: () => ({ text: '', toolLog: [], traceRunId: null, truncated: false }),
    },
});

test.mock.module('../../src/trace/store.js', {
    namedExports: {
        appendTraceEvent: (entry: Record<string, unknown>) => { harness.traceEvents.push(entry); },
        stampTraceTool() {}, stampTraceToolEntries() {},
        updateTraceToolRow() {}, getTraceEvent: () => null, linkTraceRunToMessage() {},
        getTraceToolEntry() { throw new Error('unexpected Claude tool lookup in Codex multiplex fixture'); },
        createTraceId: () => 'tr_multiplexfixture0001',
        startTraceRun: () => 'tr_multiplexfixture0001',
        finalizeTraceRun: (runId: string | null | undefined, status: string) => {
            harness.finalized.push({ runId, status });
        },
    },
});

test.mock.module('../../src/agent/lifecycle-handler.js', {
    namedExports: {
        setSpawnAgent() {}, setMainMetaHandler() {},
        handleAgentExit: async (params: Record<string, unknown>) => {
            harness.lifecycleCalls.push(params);
            const onRuntimeEnd = params['onRuntimeEnd'] as ((end: RuntimeEnd) => void) | undefined;
            onRuntimeEnd?.({ kind: 'turn-end', status: 'done', finalText: 'lifecycle fixture' });
            const activeProcesses = params['activeProcesses'] as Map<string, unknown>;
            activeProcesses.delete(String(params['agentLabel']));
            const releaseMainRun = params['releaseMainRun'] as (scopeKey: string, child: unknown, owner: number) => boolean;
            releaseMainRun(String(params['scopeKey']), params['childProcess'], Number(params['ownerGeneration']));
            const resolve = params['resolve'] as (result: { text: string; code: number }) => void;
            resolve({ text: '', code: Number(params['code'] ?? 0) });
            const processQueue = params['processQueue'] as (scopeKey: string) => void;
            processQueue(String(params['scopeKey']));
        },
    },
});

const { settings } = await import('../../src/core/config.ts');
const { db, getSessionBucket, insertMessage, upsertSessionBucket } = await import('../../src/core/db.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { resolveScopedSessionBucket } = await import('../../src/agent/args.ts');
const { shouldBuildHistoryBlock } = await import('../../src/agent/prompt-context.ts');
const {
    activeMainProcesses,
    activeProcesses,
    killActiveAgent,
    armExitSettle,
    waitForExitSettled,
    settleExit,
    spawnAgent,
} = await import('../../src/agent/spawn.ts');

const workingDir = process.env['CLI_JAW_HOME']!;
const model = 'gpt-multiplex';
const effort = 'high';

function resetHarness(): void {
    runtimeEvents.length = 0;
    harness.acquireSignal = null;
    harness.throwDirectSpawn = false;
    harness.clients.length = 0;
    harness.directSpawns = 0;
    harness.genericAcquires.length = 0;
    harness.prepares.length = 0;
    harness.laneAcquires.length = 0;
    harness.startPrompts.length = 0;
    harness.releases = 0;
    harness.prepareStale = 0;
    harness.acquireStale = 0;
    harness.alwaysPrepareStale = false;
    harness.recoverableResumeFailure = false;
    harness.acquireGate = null;
    harness.prepareGate = null;
    harness.hostClient = null;
    harness.laneThreads.clear();
    harness.genericThreads.clear();
    harness.nextThread = 1;
    harness.processQueueCalls.length = 0;
    harness.finalized.length = 0;
    harness.clearLiveRunCalls.length = 0;
    harness.lifecycleCalls.length = 0;
    harness.traceEvents.length = 0;
    harness.emitCompositeNotifications = false;
    activeMainProcesses.clear();
    activeProcesses.clear();
    db.prepare('DELETE FROM session_buckets').run();
    db.prepare('DELETE FROM messages').run();
    delete process.env['CODEX_APP_ACQUIRE_WAIT_MS'];
    settings['cli'] = 'codex-app';
    settings['model'] = model;
    settings['workingDir'] = workingDir;
    mkdirSync(`${workingDir}/prompts`, { recursive: true });
    settings['fallbackOrder'] = [];
    settings['activeOverrides'] = {};
    settings['perCli'] = {
        ...settings['perCli'],
        'codex-app': { model, effort },
    };
    settings['multiSession'] = {
        enabled: true,
        maxConcurrent: 4,
        midRunPolicy: 'steer',
        channels: { telegram: true, discord: true, slack: true },
    };
}

function setMultiplex(enabled: boolean): void {
    settings['runtime'] = {
        ...settings['runtime'],
        codexApp: {
            ...settings['runtime']?.codexApp,
            multiplex: enabled,
        },
    };
}

function spawnOptions(scopeKey: string, extra: Record<string, unknown> = {}) {
    return {
        cli: 'codex-app', model, effort, scopeKey,
        chatSessionId: `chat-${scopeKey}`,
        _isSmokeContinuation: true,
        _skipInsert: true,
        ...extra,
    };
}

async function runMain(scopeKey: string): Promise<{ text: string; code: number }> {
    return spawnAgent(`prompt-${scopeKey}`, spawnOptions(scopeKey)).promise;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await new Promise<void>((done) => { setTimeout(done, 2); });
    }
    assert.fail('condition was not reached');
}

test('multiplex ON, OFF, and employee select host, generic, and direct process routes respectively', async () => {
    resetHarness();
    setMultiplex(true);
    assert.equal((await runMain('route-on')).code, 0);
    assert.equal(harness.prepares.length, 1);
    assert.equal(harness.laneAcquires.length, 1);
    assert.equal(harness.genericAcquires.length, 0);
    assert.equal(harness.directSpawns, 0);
    assert.equal(harness.clients.length, 1);
    assert.equal(harness.startPrompts.at(-1)?.scope, `route-on:${model}:${effort}`);

    resetHarness();
    setMultiplex(false);
    assert.equal((await runMain('route-off')).code, 0);
    assert.equal(harness.prepares.length, 0);
    assert.equal(harness.laneAcquires.length, 0);
    assert.equal(harness.genericAcquires.length, 1);
    assert.equal(harness.directSpawns, 0);
    assert.equal(harness.clients.length, 1);
    assert.equal(harness.startPrompts.at(-1)?.scope, `route-off:${model}:${effort}`,
        'OFF main startTurn must use the generic lease lane scope');

    resetHarness();
    setMultiplex(true);
    const employee = spawnAgent('employee prompt', spawnOptions('employee', {
        agentId: 'employee-1',
        chatSessionId: 'chat-employee',
    }));
    assert.ok(employee.child, 'employee keeps the synchronous direct-process child result');
    assert.equal((await employee.promise).code, 0);
    assert.equal(harness.prepares.length, 0, 'employee must never prepare a shared host');
    assert.equal(harness.laneAcquires.length, 0, 'employee must never acquire a shared lane');
    assert.equal(harness.genericAcquires.length, 0, 'employee must not enter the main generic pool');
    assert.equal(harness.directSpawns, 1);
    assert.equal(harness.clients.length, 1);
    assert.equal(harness.startPrompts.at(-1)?.scope, 'employee:employee-1');
});

test('ON production records host and unrouted diagnostics and disposes the composite subscription', async () => {
    resetHarness();
    setMultiplex(true);
    harness.emitCompositeNotifications = true;
    assert.equal((await runMain('composite-events')).code, 0);

    const eventTypes = harness.traceEvents
        .filter((entry) => entry['source'] === 'codex_app_raw')
        .map((entry) => String(entry['eventType']));
    assert.equal(eventTypes.filter((eventType) => eventType === 'configWarning').length, 1);
    assert.equal(eventTypes.filter((eventType) => eventType === 'error').length, 1,
        'ownerless host errors remain raw trace events');
    assert.equal(eventTypes.filter((eventType) => eventType === 'unrouted-notification').length, 1);
    assert.equal(eventTypes.includes('future/raw'), false,
        'diagnostic-only unknowns are not delivered as raw consumer events');
    const diagnostic = harness.traceEvents.find(
        (entry) => entry['eventType'] === 'unrouted-notification',
    )?.['raw'] as { method?: string; reason?: string } | undefined;
    assert.deepEqual(diagnostic, {
        method: 'future/raw', params: { value: 1 }, reason: 'unknown-method',
    });

    const countAfterRun = harness.traceEvents.length;
    harness.hostClient!.emit('host-notification', 'configWarning', { message: 'after dispose' });
    harness.hostClient!.emit('unrouted-notification', {
        method: 'future/after', params: {}, reason: 'unknown-method',
    });
    assert.equal(harness.traceEvents.length, countAfterRun,
        'the one adapter disposer removes host and diagnostic subscriptions');
});

test('optimistic history eligibility changes only multiplex main resume turns', () => {
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: false, isResume: true, cli: 'codex-app', codexMultiplexMain: true,
    }), true);
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: false, isResume: true, cli: 'codex-app', codexMultiplexMain: false,
    }), false, 'OFF main and employee keep the legacy resume rule');
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: false, isResume: true, cli: 'claude', codexMultiplexMain: false,
    }), false, 'other CLIs keep the legacy resume rule');
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: false, isResume: true, cli: 'pi', codexMultiplexMain: false,
    }), true, 'Pi keeps its existing resume-history exception');
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: true, isResume: false, cli: 'codex-app', codexMultiplexMain: true,
    }), false, '_skipHistory remains authoritative on every route');
});

test('composite persistence is read back on restart and first ON ignores the legacy thread', async () => {
    resetHarness();
    setMultiplex(true);
    const scopeKey = 'resume-scope';
    const bucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKey, effort, 'fallback');
    upsertSessionBucket.run('codex-app', 'legacy-thread', model, null, 0);

    assert.equal((await runMain(scopeKey)).code, 0);
    assert.equal(harness.laneAcquires[0]?.['storedThreadId'], null);
    const firstRow = getSessionBucket.get(bucket) as { session_id: string };
    assert.notEqual(firstRow.session_id, 'legacy-thread');
    assert.equal(harness.lifecycleCalls[0]?.['codexAppBucket'], bucket);

    const firstThread = firstRow.session_id;
    harness.hostClient = null;
    harness.laneThreads.clear();
    assert.equal((await runMain(scopeKey)).code, 0);
    assert.equal(harness.laneAcquires[1]?.['storedThreadId'], firstThread);
    assert.equal(harness.startPrompts.at(-1)?.threadId, firstThread);
});

test('live lane reuse does not prepend history a second time', async () => {
    resetHarness();
    setMultiplex(true);
    const scopeKey = 'history-reuse';
    const chatSessionId = `chat-${scopeKey}`;
    insertMessage.run('assistant', 'prior-history-marker', 'codex-app', model, workingDir, chatSessionId);

    assert.equal((await runMain(scopeKey)).code, 0);
    assert.match(harness.startPrompts[0]!.prompt, /prior-history-marker/);
    assert.equal((await runMain(scopeKey)).code, 0);
    assert.doesNotMatch(harness.startPrompts[1]!.prompt, /prior-history-marker|\[Recent Context\]/);
});

test('recoverable multiplex resume failure sends real history in the first new-thread prompt', async () => {
    resetHarness();
    setMultiplex(true);
    harness.recoverableResumeFailure = true;
    const scopeKey = 'resume-fallback';
    const chatSessionId = `chat-${scopeKey}`;
    const bucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKey, effort, 'fallback');
    upsertSessionBucket.run(bucket, 'missing-thread', model, null, 0);
    insertMessage.run('assistant', 'resume-history-marker', 'codex-app', model, workingDir, chatSessionId);

    assert.equal((await runMain(scopeKey)).code, 0);
    assert.equal(harness.laneAcquires[0]?.['storedThreadId'], 'missing-thread');
    assert.match(harness.startPrompts[0]!.prompt, /\[Recent Context\][\s\S]*resume-history-marker/);
    assert.notEqual(harness.startPrompts[0]!.threadId, 'missing-thread');
});

test('prepare stale retries from prepare and succeeds', async () => {
    resetHarness();
    setMultiplex(true);
    harness.prepareStale = 1;
    assert.equal((await runMain('prepare-stale')).code, 0);
    assert.equal(harness.prepares.length, 2);
    assert.equal(harness.laneAcquires.length, 1);
});

test('acquire stale retries from prepare while starting stays true until the outer finally', async () => {
    resetHarness();
    setMultiplex(true);
    harness.acquireStale = 1;
    harness.acquireGate = deferred<FakeLaneLease>();
    const scopeKey = 'acquire-stale';
    const result = spawnAgent('stale prompt', spawnOptions(scopeKey));
    await waitFor(() => harness.laneAcquires.length === 2);
    const run = activeMainProcesses.get(scopeKey)!;
    assert.equal(run.starting, true);
    let starting = run.starting;
    let falseWrites = 0;
    Object.defineProperty(run, 'starting', {
        configurable: true,
        get: () => starting,
        set: (value: boolean) => {
            starting = value;
            if (!value) falseWrites += 1;
        },
    });
    harness.acquireGate.resolve(createLaneLease(harness.laneAcquires[1]!));
    assert.equal((await result.promise).code, 0);
    assert.equal(harness.prepares.length, 2);
    assert.equal(harness.laneAcquires.length, 2);
    assert.equal(run.starting, false);
    assert.equal(falseWrites, 1, 'the acquire function outer finally exclusively clears starting');
});

test('cancelling a pending acquire releases its late lease and settles once without an error broadcast', async () => {
    resetHarness();
    setMultiplex(true);
    harness.acquireGate = deferred<FakeLaneLease>();
    const scopeKey = 'cancel-acquire';
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
    addBroadcastListener(listener);
    try {
        const spawned = spawnAgent('cancel prompt', spawnOptions(scopeKey));
        let resolutions = 0;
        void spawned.promise.then(() => { resolutions += 1; });
        await waitFor(() => harness.laneAcquires.length === 1);
        const run = activeMainProcesses.get(scopeKey)!;
        assert.equal(run.starting, true);
        assert.equal(killActiveAgent(scopeKey, 'user'), true);
        harness.acquireGate.resolve(createLaneLease(harness.laneAcquires[0]!));
        const result = await spawned.promise;
        await Promise.resolve();
        assert.deepEqual(result, { text: '', code: 130, traceRunId: 'tr_multiplexfixture0001',
            runtimeOutcome: { status: 'stopped', finalText: null, partialText: '' }, stopCause: 'user_stop' });
        assert.equal(resolutions, 1);
        assert.equal(harness.startPrompts.length, 0, 'cancelled acquire must not start a turn');
        assert.equal(harness.releases, 1, 'the acquired lease must be released once');
        assert.equal(run.starting, false);
        assert.deepEqual(harness.finalized, [{ runId: 'tr_multiplexfixture0001', status: 'interrupted' }]);
        assert.deepEqual(harness.clearLiveRunCalls, [scopeKey]);
        assert.deepEqual(harness.processQueueCalls, [scopeKey]);
        assert.equal(events.filter((event) => event.type === 'agent_done').length, 0);
        assert.equal(events.filter((event) => event.type === 'agent_status' && event.data['running'] === false).length, 1);
    } finally {
        removeBroadcastListener(listener);
    }
});

test('a cancelled acquire must not delete the replacement run that took its slot', async () => {
    resetHarness();
    setMultiplex(true);
    harness.acquireGate = deferred<FakeLaneLease>();
    const scopeKey = 'cancel-replacement';
    const first = spawnAgent('first prompt', spawnOptions(scopeKey));
    void first.promise.catch(() => {});
    await waitFor(() => harness.laneAcquires.length === 1);
    const abandoned = activeMainProcesses.get(scopeKey)!;
    assert.equal(killActiveAgent(scopeKey, 'user'), true);

    // The stopped run is still holding a pending acquire. A replacement claims the
    // scope while that acquire is in flight; cleanup from the first run must not
    // reach it. releaseMainRun() matches on (process, ownerGeneration), and both
    // runs have process=null and the same global generation, so identity is the
    // only thing that tells them apart.
    const replacement: MainRunEntry = { ...abandoned, starting: false, cancelTurn: undefined };
    activeMainProcesses.set(scopeKey, replacement);

    harness.acquireGate.resolve(createLaneLease(harness.laneAcquires[0]!));
    assert.deepEqual(await first.promise, { text: '', code: 130, traceRunId: 'tr_multiplexfixture0001',
        runtimeOutcome: { status: 'stopped', finalText: null, partialText: '' }, stopCause: 'user_stop' });
    await Promise.resolve();
    assert.equal(activeMainProcesses.get(scopeKey), replacement,
        'the abandoned run must leave the replacement registered');
    assert.equal(harness.releases, 1, 'its late lease is still released');
    assert.equal(harness.startPrompts.length, 0);
});

test('stale retry budget terminates through the existing failure cleanup exactly once', async () => {
    resetHarness();
    setMultiplex(true);
    process.env['CODEX_APP_ACQUIRE_WAIT_MS'] = '35';
    harness.alwaysPrepareStale = true;
    const scopeKey = 'stale-deadline';
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
    addBroadcastListener(listener);
    try {
        const spawned = spawnAgent('deadline prompt', spawnOptions(scopeKey));
        const run = activeMainProcesses.get(scopeKey)!;
        assert.deepEqual(await spawned.promise, { text: '', code: 1 });
        assert.equal(run.starting, false);
        assert.deepEqual(harness.processQueueCalls, [scopeKey]);
        assert.equal(harness.finalized.filter(entry => entry.status === 'error').length, 1);
        assert.equal(harness.finalized[0]?.runId, runtimeEvents.find(event => event.kind === 'turn-start')?.runId);
        assert.equal(events.filter((event) => event.type === 'agent_done' && event.data['error'] === true).length, 1);
        assert.equal(events.filter((event) => event.type === 'agent_status' && event.data['running'] === false).length, 1);
    } finally {
        removeBroadcastListener(listener);
    }
});

test('an acquire lease arriving after the shared deadline is released without starting a turn', async () => {
    resetHarness();
    setMultiplex(true);
    process.env['CODEX_APP_ACQUIRE_WAIT_MS'] = '25';
    harness.acquireGate = deferred<FakeLaneLease>();
    const scopeKey = 'late-deadline-lease';
    const spawned = spawnAgent('late lease prompt', spawnOptions(scopeKey));
    await waitFor(() => harness.laneAcquires.length === 1);
    assert.deepEqual(await spawned.promise, { text: '', code: 1 });
    harness.acquireGate.resolve(createLaneLease(harness.laneAcquires[0]!));
    await new Promise<void>((done) => { setImmediate(done); });
    assert.equal(harness.releases, 1);
    assert.equal(harness.startPrompts.length, 0);
});

test('route tokens survive both gate-flip directions without re-reading settings', async () => {
    resetHarness();
    setMultiplex(true);
    harness.prepareGate = deferred<{ laneMode: 'fallback' }>();
    const onScope = 'flip-on-to-off';
    const onBucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', onScope, effort, 'fallback');
    const onRun = spawnAgent('captured ON', spawnOptions(onScope));
    await waitFor(() => harness.prepares.length === 1);
    setMultiplex(false);
    harness.prepareGate.resolve({ laneMode: 'fallback' });
    assert.equal((await onRun.promise).code, 0);
    assert.equal(harness.laneAcquires.length, 1);
    assert.equal(harness.genericAcquires.length, 0);
    assert.ok(getSessionBucket.get(onBucket));

    resetHarness();
    setMultiplex(false);
    const offScope = 'flip-off-to-on';
    // Multiplex off still keys the bucket by scope: the read path resolves it that way
    // (resolveScopedSessionBucket), and before 073 only the WRITE fell back to the bare
    // name — which is the default session's row.
    const offBucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', offScope, effort, 'fallback', false);
    const offRun = spawnAgent('captured OFF', spawnOptions(offScope));
    setMultiplex(true);
    assert.equal((await offRun.promise).code, 0);
    assert.equal(harness.prepares.length, 0);
    assert.equal(harness.laneAcquires.length, 0);
    assert.equal(harness.genericAcquires.length, 1);
    assert.ok(getSessionBucket.get(offBucket));
    assert.equal(getSessionBucket.get('codex-app'), undefined,
        'a non-default scope must not write into the default session bucket');
});

test('ON to OFF to ON returns to the composite thread instead of the legacy OFF thread', async () => {
    resetHarness();
    const scopeKey = 'route-roundtrip';
    const bucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKey, effort, 'fallback');
    const offBucket = resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKey, effort, 'fallback', false);

    setMultiplex(true);
    assert.equal((await runMain(scopeKey)).code, 0);
    const onThread = (getSessionBucket.get(bucket) as { session_id: string }).session_id;

    setMultiplex(false);
    assert.equal((await runMain(scopeKey)).code, 0);
    const offThread = (getSessionBucket.get(offBucket) as { session_id: string }).session_id;
    assert.notEqual(offThread, onThread);

    setMultiplex(true);
    assert.equal((await runMain(scopeKey)).code, 0);
    assert.equal(harness.laneAcquires.at(-1)?.['storedThreadId'], onThread);
    assert.equal(harness.startPrompts.at(-1)?.threadId, onThread);
    assert.notEqual(harness.startPrompts.at(-1)?.threadId, offThread);
});

test('three Codex routes bind the canonical side channel to jaw identity', async () => {
    for (const route of ['on', 'off', 'employee']) {
        resetHarness();
        setMultiplex(route !== 'off');
        const scope = 'projection-' + route;
        const result = spawnAgent('projection fixture', spawnOptions(scope, {
            runtimeParentItemId: 'trusted-parent',
            ...(route === 'employee' ? { agentId: 'projection-employee' } : {}),
        }));
        await result.promise;
        const starts = runtimeEvents.filter(event => event.kind === 'turn-start');
        const ends = runtimeEvents.filter(event => event.kind === 'turn-end');
        assert.equal(starts.length, 1);
        assert.equal(ends.length, 1);
        assert.equal(ends[0]?.finalText, 'lifecycle fixture');
        assert.ok(runtimeEvents.every(event => event.scope === scope
            && event.sessionId === 'chat-' + scope && event.parentItemId === 'trusted-parent'));
        assert.ok(runtimeEvents.every(event => event.turnId === event.runId && event.seq % 3 === 0));
        assert.equal(harness.lifecycleCalls.length, 1);
    }
});

test("employee synchronous spawn failure closes its canonical attempt before propagating", () => {
    resetHarness();
    harness.throwDirectSpawn = true;
    assert.throws(() => spawnAgent("fixture", spawnOptions("failed-employee", { agentId: "failed-employee" })), /fixture direct spawn failed/);
    const starts = runtimeEvents.filter(event => event.kind === "turn-start");
    const ends = runtimeEvents.filter(event => event.kind === "turn-end");
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.status, "error");
    assert.equal(ends[0]?.finalText, null);
});

test('late ordinary Codex acquisition error cannot settle a replacement owner', async context => {
    resetHarness();
    setMultiplex(true);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred<void>();
    const gate = deferred<FakeLaneLease>();
    harness.acquireGate = gate;
    harness.acquireSignal = () => { entered.resolve(undefined); };
    const scope = 'codex-replacement-error';
    const first = spawnAgent('old request', spawnOptions(scope));
    let resolutions = 0;
    void first.promise.then(() => { resolutions++; });
    let barrier: Promise<void> | undefined;
    let barrierSettled = false;
    const cleanupEvents: string[] = [];
    const listener = (type: string) => {
        if (type === 'agent_status' || type === 'agent_done') cleanupEvents.push(type);
    };
    try {
        await entered.promise;
        const old = activeMainProcesses.get(scope)!;
        const replacement = { ...old, starting: true };
        delete replacement.cancelPending;
        delete replacement.cancelTurn;
        activeMainProcesses.set(scope, replacement);
        armExitSettle(scope);
        barrier = waitForExitSettled(scope).then(() => { barrierSettled = true; });
        addBroadcastListener(listener);
        gate.reject(new Error('ordinary old acquisition error'));
        assert.deepEqual(await first.promise, { text: '', code: 1 });
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(resolutions, 1);
        assert.equal(harness.finalized.at(-1)?.status, 'error');
        assert.equal(runtimeEvents.filter(event => event.kind === 'turn-end').length, 1);
        assert.deepEqual({ owner: activeMainProcesses.get(scope) === replacement,
            starting: replacement.starting, barrierSettled, cleanupEvents,
            liveClears: harness.clearLiveRunCalls, queueDrains: harness.processQueueCalls }, {
            owner: true, starting: true, barrierSettled: false, cleanupEvents: [], liveClears: [], queueDrains: [],
        });
    } finally {
        gate.reject(new Error('fixture cleanup'));
        removeBroadcastListener(listener);
        settleExit(scope);
        await barrier;
        await first.promise;
        activeMainProcesses.delete(scope);
        context.mock.timers.reset();
    }
});
