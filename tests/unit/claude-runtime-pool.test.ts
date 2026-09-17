import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { RuntimePoolAccess } from '../../src/agent/runtime-pool-contract.js';
import type { ClaudeSessionOptions, ClaudeSdkSession } from '../../src/agent/runtime/claude-sdk-session.js';
import type { ClaudeAcquireOptions } from '../../src/agent/claude-runtime-pool.js';
import { runNativeRuntime } from '../../src/agent/native-runtime-run.js';
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
let sdkFactory: NonNullable<ClaudeSessionOptions['queryFactory']>;
mock.module('../../src/agent/runtime/claude-sdk-loader.js', { namedExports: { loadClaudeSdk: async () => ({ query: sdkFactory }) } });
const { acquireClaudeRuntimeLease: acquire, retireClaudePoolEntry: retire } = await import('../../src/agent/claude-runtime-pool.js');
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.js');

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function accessFixture() {
    let id = 0;
    const waited = deferred();
    const access: RuntimePoolAccess = {
        store: { entries: new Map(), scopeIndex: new Map() },
        wake(entry) {
            for (const waiter of entry.waiters.splice(0)) {
                clearTimeout(waiter.timer); waiter.cleanup?.(); waiter.resolve();
            }
        },
        remove(store, key, entry) {
            if (store.entries.get(key) !== entry) return;
            access.wake(entry); store.entries.delete(key);
            const keys = store.scopeIndex.get(entry.scopeKey); keys?.delete(key);
            if (!keys?.size) store.scopeIndex.delete(entry.scopeKey);
            if (entry.state === 'ready') entry.disposeExit();
        },
        wait(entry, ms, signal) {
            waited.resolve();
            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(waiter.timer); signal?.removeEventListener('abort', abort);
                    const i = entry.waiters.indexOf(waiter); if (i >= 0) entry.waiters.splice(i, 1);
                };
                const abort = () => { cleanup(); reject(new Error('acquire aborted')); };
                const waiter = { id: ++id, resolve, reject,
                    timer: setTimeout(() => { cleanup(); reject(new Error('acquire timed out')); }, ms), cleanup };
                entry.waiters.push(waiter); signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            });
        },
    };
    return { access, waited };
}
function binding(turnId: string) {
    const events: string[] = [], metadata: string[] = [];
    return { events, metadata,
        getTurnContext: () => ({ runId: `run-${turnId}`, sessionId: 'chat', scope: 'scope', turnId,
            audience: 'internal' as const, isCurrent: () => true }),
        record: (context: { turnId: string }) => { events.push(context.turnId); return null; },
        onMetadata: (context: { turnId: string }) => { metadata.push(context.turnId); },
    };
}
function fakeSession() {
    const child = new ChildProcess() as ChildProcessWithoutNullStreams;
    const exits = new Set<(code: number | null) => void>();
    const closed = deferred();
    const state = { alive: true, idle: true, sid: '', closes: 0, readiness: [] as Array<{ timeoutMs?: number; signal?: AbortSignal }>,
        close: async () => {}, wait: async () => child };
    const session = {
        get alive() { return state.alive; }, get idle() { return state.idle; }, get nativeSessionId() { return state.sid; },
        waitForPrimaryChild: async (options = {}) => { state.readiness.push(options); return state.wait(); },
        close: async () => { state.closes++; state.alive = false; closed.resolve(); await state.close(); for (const cb of exits) cb(0); },
        cancel: async () => session.close(),
        onExit: (cb: (code: number | null) => void) => { exits.add(cb); return () => { exits.delete(cb); }; },
        send: async () => ({ status: 'done', finalText: 'answer', partialText: '' }),
        claimTurnOutcome: () => ({ status: 'done', finalText: 'answer', partialText: '' }), finalizeTurn: () => true,
    } as unknown as ClaudeSdkSession;
    return { session, state, child, exits, closed };
}
function options(extra: Partial<ClaudeAcquireOptions> = {}): ClaudeAcquireOptions {
    return { scopeKey: 'scope', chatSessionId: 'chat',
        prepared: { cwd: process.cwd(), binary: process.execPath, env: { PRIVATE_KEY: 'test-secret' }, model: 'default',
            systemPrompt: 'private instructions', permissions: 'safe', fastMode: false },
        persistenceOwner: { global: 1, scope: 1 }, isCurrentOwner: () => true, canAcquire: () => true,
        binding: binding('one'), promptTimeoutMs: 1000, closeTimeoutMs: 100, waitMs: 1000,
        createSession: async () => fakeSession().session, ...extra };
}
async function drain(access: RuntimePoolAccess) {
    for (const [key, entry] of access.store.entries) {
        if (entry.state === 'ready') entry.busy = false;
        await retire(access, key, entry, new Error('test cleanup')).catch(() => {});
    }
}

test('request lifetime keeps resume, rotates private identity and retires on plain release', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    const captured: ClaudeSessionOptions[] = [], sessions: ReturnType<typeof fakeSession>[] = [];
    const base = options({ createSession: async input => {
        captured.push(input); const f = fakeSession(); f.state.sid = 'stored-session'; sessions.push(f); return f.session;
    } });
    const pooled = await acquire(access, base); pooled.release();
    const request = { ...base, lifetime: 'request' as const, storedSessionId: 'stored-session' };
    const a = await acquire(access, request);
    const keyA = [...access.store.entries.keys()][0]!;
    assert.equal(a.reused, false); assert.notEqual(a.child, pooled.child);
    assert.equal(a.retireOnFinish, true);
    assert.equal(captured[1]!.prepared.resumeSessionId, 'stored-session');
    a.release();
    assert.equal([...access.store.entries.values()][0]!.state, 'ready');
    assert.equal(( [...access.store.entries.values()][0]! as { dead: boolean }).dead, true);
    const b = await acquire(access, request);
    const keyB = [...access.store.entries.keys()][0]!;
    assert.notEqual(keyA, keyB); assert.match(keyA, /^[a-f0-9]{64}$/); assert.match(keyB, /^[a-f0-9]{64}$/);
    assert.notEqual(a.child, b.child); assert.equal(b.reused, false);
    assert.equal(captured[2]!.prepared.resumeSessionId, 'stored-session'); b.release();
    const fresh = await acquire(access, { ...request, forceNew: true });
    assert.equal(captured[3]!.prepared.resumeSessionId, undefined); fresh.release();
    const ordinary = await acquire(access, { ...base, lifetime: 'pooled' });
    assert.equal(ordinary.retireOnFinish, undefined); ordinary.release();
    const again = await acquire(access, base);
    assert.equal(again.child, ordinary.child); assert.equal(again.reused, true); again.release();
    assert.equal(sessions[1]!.state.closes, 1); assert.equal(sessions[2]!.state.closes, 1);
});

test('request leases capture environment and lifetime without contaminating the next child', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    const captured: ClaudeSessionOptions[] = [];
    const sessions: ReturnType<typeof fakeSession>[] = [];
    for (const grant of ['request-a', 'request-b', undefined]) {
        const input = options({ lifetime: 'request', createSession: async config => {
            captured.push(config); const f = fakeSession(); sessions.push(f); return f.session;
        } });
        if (grant !== undefined) input.prepared.env['JAW_SLACK_TURN_GRANT'] = grant;
        input.canAcquire = () => {
            input.prepared.env['JAW_SLACK_TURN_GRANT'] = 'mutated';
            input.lifetime = 'pooled';
            return true;
        };
        const lease = await acquire(access, input);
        assert.equal(lease.retireOnFinish, true);
        assert.equal(captured.at(-1)!.prepared.env['JAW_SLACK_TURN_GRANT'], grant);
        lease.release();
        assert.equal([...access.store.entries.values()][0]!.state, 'ready');
        await sessions.at(-1)!.closed.promise;
    }
    assert.equal(new Set(sessions.map(f => f.child)).size, 3);
    assert.deepEqual(sessions.map(f => f.state.closes), [1, 1, 1]);
});

test('request lifetime validates before callbacks and cannot retire a healthy pooled child', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    const f = fakeSession(), base = options({ createSession: async () => f.session });
    const one = await acquire(access, base); one.release(); let admissions = 0;
    await assert.rejects(acquire(access, { ...base, lifetime: 'invalid' as 'request', forceNew: true,
        canAcquire: () => { admissions++; return true; } }), /invalid lifetime/);
    assert.equal(admissions, 0); assert.equal(f.state.closes, 0);
});

test('request waits for active borrower then plain release waits for observed close', { timeout: 5000 }, async t => {
    const { access, waited } = accessFixture();
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const close = deferred(); t.after(() => { close.resolve(); return drain(access); });
    const base = options({ createSession: async () => { const f = fakeSession(); sessions.push(f); return f.session; } });
    const one = await acquire(access, base);
    const pending = acquire(access, { ...base, lifetime: 'request' });
    await waited.promise; assert.equal(sessions[0]!.state.closes, 0); one.release();
    const two = await pending;
    assert.notEqual(two.child, one.child);
    sessions[1]!.state.close = () => close.promise;
    two.release(); await sessions[1]!.closed.promise;
    let admitted = false;
    const next = acquire(access, { ...base, lifetime: 'request' }).then(lease => { admitted = true; return lease; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(admitted, false);
    close.resolve(); const three = await next;
    assert.notEqual(three.child, two.child); three.release();
});

test('stable callbacks capture on send, retain passive binding until next send, and match current SID', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    const f = fakeSession(); let captured!: ClaudeSessionOptions, creates = 0;
    const first = binding('one'), second = binding('two');
    const base = options({ binding: first, createSession: async value => { creates++; captured = { ...value }; return f.session; } });
    const one = await acquire(access, base);
    assert.equal(captured.deferTurnEnd, true); assert.equal(one.child, f.child);
    assert.equal(captured.getTurnContext().turnId, 'one');
    const getContext = captured.getTurnContext, passive = captured.record!, metadata = captured.onMetadata!;
    f.state.sid = 'actual-session'; one.release();
    const two = await acquire(access, { ...base, binding: second, storedSessionId: 'actual-session',
        prepared: { ...base.prepared, resumeSessionId: 'actual-session' } });
    assert.equal(two.reused, true); assert.equal(two.sessionId, 'actual-session'); assert.equal(creates, 1);
    assert.equal(f.state.readiness.length, 2);
    assert.equal(captured.getTurnContext, getContext); assert.equal(captured.record, passive); assert.equal(captured.onMetadata, metadata);
    // Merely rebinding a lease does not redirect passive work to its new owner.
    passive(first.getTurnContext(), { kind: 'turn-end', status: 'done', finalText: null });
    metadata(first.getTurnContext(), {});
    assert.equal(captured.getTurnContext().turnId, 'two');
    captured.record!(second.getTurnContext(), { kind: 'turn-start', provider: 'claude' });
    captured.onMetadata!(second.getTurnContext(), {});
    // A delayed old event must never be routed into the newly bound callbacks.
    captured.record!(first.getTurnContext(), { kind: 'turn-start', provider: 'claude' });
    captured.onMetadata!(first.getTurnContext(), {});
    assert.equal(passive(first.getTurnContext(), { kind: 'turn-end', status: 'done', finalText: null }), null);
    assert.deepEqual(first.events, ['one']); assert.deepEqual(first.metadata, ['one']);
    assert.deepEqual(second.events, ['two']); assert.deepEqual(second.metadata, ['two']);
    const key = [...access.store.entries.keys()][0]!;
    assert.ok(!key.includes('test-secret') && !key.includes('private instructions'));
    two.release();
});

test('SDK ambient defaults appearing after lazy import do not replace the query', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    let creates = 0;
    const base = options({ createSession: async () => { creates++; return fakeSession().session; } });
    const first = await acquire(access, base); first.release();
    const importedEnv = { ...base.prepared.env, NoDefaultCurrentDirectoryInExePath: '1', CLAUDE_AGENT_SDK_VERSION: '0.3.261',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
    const second = await acquire(access, { ...base, prepared: { ...base.prepared, env: importedEnv } });
    assert.equal(second.reused, true); assert.equal(creates, 1); second.release();
    const changed = await acquire(access, { ...base, prepared: { ...base.prepared, env: { ...importedEnv, CLAUDE_AGENT_SDK_VERSION: 'explicit-other' } } });
    assert.equal(changed.reused, false); assert.equal(creates, 2); changed.release();
});

test('explicit caller background-task setting is preserved in the SDK snapshot', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    let captured!: ClaudeSessionOptions;
    const base = options({ createSession: async input => { captured = input; return fakeSession().session; } });
    base.prepared.env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '0';
    const lease = await acquire(access, base);
    assert.equal(captured.prepared.env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'], '0');
    lease.release();
});

for (const factoryMode of ['default', 'public factory with spread'] as const) {
test(`${factoryMode} reuses one injected SDK query with fresh bindings and an actual child`, async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    let queries = 0, queryCloses = 0, messages = 0;
    const inputDone = deferred();
    let child!: ChildProcessWithoutNullStreams;
    sdkFactory = ({ prompt, options: sdk }) => {
        queries++;
        child = sdk.spawnClaudeCodeProcess!({ command: process.execPath,
            args: ['-e', 'process.stdin.resume(); setTimeout(() => process.exit(0), 5000)'],
            env: process.env, signal: new AbortController().signal }) as ChildProcessWithoutNullStreams;
        const values: unknown[] = [];
        let waiter: ((value: IteratorResult<unknown>) => void) | undefined, ended = false;
        void (async () => {
            for await (const message of prompt) {
                messages++;
                const value = { type: 'result', subtype: 'success', is_error: false, result: `answer-${messages}`,
                    session_id: 'sdk-session', user_message_uuid: message.uuid, usage: { input_tokens: 1 } };
                if (waiter) { const resolve = waiter; waiter = undefined; resolve({ done: false, value }); }
                else values.push(value);
            }
            inputDone.resolve();
        })();
        return {
            close() { queryCloses++; ended = true; waiter?.({ done: true, value: undefined }); waiter = undefined; },
            [Symbol.asyncIterator]() { return this; },
            next() {
                if (values.length) return Promise.resolve({ done: false, value: values.shift() });
                if (ended) return Promise.resolve({ done: true, value: undefined });
                return new Promise(resolve => { waiter = resolve; });
            },
        } as ReturnType<NonNullable<ClaudeSessionOptions['queryFactory']>>;
    };
    const first = binding('sdk-one'), second = binding('sdk-two');
    const base = options({ binding: first }); delete base.createSession;
    if (factoryMode === 'public factory with spread') base.createSession = value => createClaudeSdkSession({ ...value });
    const one = await acquire(access, base);
    assert.equal(one.child, child); assert.ok(child.pid! > 0);
    const firstResult = await one.session.send({ text: 'one' }, () => {});
    assert.equal(firstResult.finalText, 'answer-1');
    assert.ok(one.session.claimTurnOutcome('sdk-one'));
    assert.equal(one.session.finalizeTurn('sdk-one', { kind: 'turn-end', status: 'done', finalText: 'answer-1' }), true);
    one.release();
    const two = await acquire(access, { ...base, binding: second, storedSessionId: 'sdk-session' });
    assert.equal(two.reused, true);
    assert.equal((await two.session.send({ text: 'two' }, () => {})).finalText, 'answer-2');
    assert.ok(two.session.claimTurnOutcome('sdk-two'));
    assert.equal(two.session.finalizeTurn('sdk-two', { kind: 'turn-end', status: 'done', finalText: 'answer-2' }), true);
    assert.ok(first.events.length > 0 && first.events.every(value => value === 'sdk-one'));
    assert.ok(second.events.length > 0 && second.events.every(value => value === 'sdk-two'));
    assert.deepEqual(first.metadata, ['sdk-one']); assert.deepEqual(second.metadata, ['sdk-two']);
    assert.equal(queries, 1); assert.equal(messages, 2); assert.equal(queryCloses, 0);
    await two.retire(); assert.equal(access.store.entries.size, 1);
    two.release(); await inputDone.promise;
    assert.equal(queryCloses, 1); assert.equal(access.store.entries.size, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
});
}

test('logical lease blocks another acquisition while SDK reports idle', async t => {
    const { access, waited } = accessFixture(); t.after(() => drain(access));
    const base = options(); const one = await acquire(access, base);
    const pending = acquire(access, base); await waited.promise;
    assert.equal(access.store.entries.size, 1); one.release();
    const two = await pending; assert.equal(two.reused, true); two.release();
});

for (const change of ['forceNew', 'owner', 'env', 'prompt', 'sid', 'model', 'fast', 'permission', 'chat'] as const) {
    test(`${change} replacement waits for physical close AND logical release`, async t => {
        const { access, waited } = accessFixture(); t.after(() => drain(access));
        const f = fakeSession(), close = deferred(); f.state.close = () => close.promise;
        let creates = 0; const base = options({ createSession: async () => ++creates === 1 ? f.session : fakeSession().session });
        const one = await acquire(access, base);
        const next = { ...base, prepared: { ...base.prepared } };
        if (change === 'forceNew') next.forceNew = true;
        if (change === 'owner') next.persistenceOwner = { global: 2, scope: 1 };
        if (change === 'env') next.prepared.env = { PRIVATE_KEY: 'changed' };
        if (change === 'prompt') next.prepared.systemPrompt += '!';
        if (change === 'sid') next.storedSessionId = 'different';
        if (change === 'model') next.prepared.model = 'other';
        if (change === 'fast') next.prepared.fastMode = true;
        if (change === 'permission') next.prepared.permissions = 'auto';
        if (change === 'chat') next.chatSessionId = 'other';
        const pending = acquire(access, next); await waited.promise;
        if (change !== 'forceNew' && change !== 'owner') one.release();
        await f.closed.promise; close.resolve();
        await one.retire();
        assert.equal(creates, 1);
        one.release(); const two = await pending;
        assert.equal(creates, 2); assert.equal(two.reused, false); two.release();
    });
}

test('main and individual workers do not serialize each other', async t => {
    const { access } = accessFixture(); t.after(() => drain(access)); const base = options();
    const leases = await Promise.all([acquire(access, base), acquire(access, { ...base, workerId: 'a' }), acquire(access, { ...base, workerId: 'b' })]);
    assert.equal(access.store.entries.size, 3); leases.forEach(lease => lease.release());
});

test('retire resolves physical close before release, including actual runNativeRuntime failure path', async () => {
    const { access } = accessFixture(); const f = fakeSession(), order: string[] = [];
    const lease = await acquire(access, options({ createSession: async () => f.session }));
    f.state.close = async () => { order.push('close'); };
    const run = runNativeRuntime({ prompt: { text: 'test' }, turnId: 'one', isCurrent: () => true,
        acquire: async () => ({ ...lease, release() { order.push('release'); lease.release(); } }),
        ready: () => { throw new Error('attachment failed'); }, event() {}, settle: async () => 'unused',
        failed: async () => 'handled', finalized() { order.push('finalized'); } });
    assert.equal(await run.done, 'handled');
    assert.deepEqual(order, ['close', 'release', 'finalized']); assert.equal(access.store.entries.size, 0);
});

test('close rejection remains fenced across forceNew, generation change, exit, and repeated retire', async () => {
    const { access } = accessFixture(); const f = fakeSession(); f.state.close = async () => { throw new Error('close failed'); };
    let creates = 0; const base = options({ createSession: async () => { creates++; return f.session; } });
    const one = await acquire(access, base); const exit = [...f.exits][0]!;
    await assert.rejects(one.retire(), /close failed/); one.release(); exit(0);
    const [key, entry] = [...access.store.entries][0]!;
    await assert.rejects(retire(access, key, entry, new Error('again')), /close failed/);
    await assert.rejects(acquire(access, { ...base, forceNew: true, persistenceOwner: { global: 2, scope: 1 }, waitMs: 20 }), /timed out/);
    assert.equal(creates, 1); assert.equal(f.state.closes, 1); assert.equal(access.store.entries.size, 1);
});

for (const lateFails of [false, true]) {
    test(`aborted creating sentinel survives late factory and ${lateFails ? 'failed' : 'pending'} close`, async () => {
        const { access } = accessFixture(), started = deferred(), factory = deferred<ClaudeSdkSession>(), close = deferred();
        const f = fakeSession(); f.state.close = () => close.promise;
        const controller = new AbortController(); let creates = 0;
        const base = options({ signal: controller.signal, createSession: async () => { creates++; started.resolve(); return factory.promise; } });
        const pending = acquire(access, base); await started.promise; controller.abort();
        await assert.rejects(pending, /abort/); assert.equal(access.store.entries.size, 1);
        factory.resolve(f.session); await f.closed.promise;
        await assert.rejects(acquire(access, { ...base, signal: undefined, forceNew: true, waitMs: 20 }), /timed out/);
        assert.equal(creates, 1);
        const [key, entry] = [...access.store.entries][0]!;
        const retirement = retire(access, key, entry, new Error('test')); void retirement.catch(() => {});
        if (lateFails) {
            close.reject(new Error('late close failed')); await assert.rejects(retirement, /late close failed/);
            await assert.rejects(acquire(access, { ...base, signal: undefined, forceNew: true, waitMs: 20 }), /timed out/);
            assert.equal(creates, 1); assert.equal(f.state.closes, 1);
        }
        else { close.resolve(); await retirement; }
        assert.equal(access.store.entries.size, lateFails ? 1 : 0);
    });
}

test('factory that never returns fails caller within deadline without removing its fence', async () => {
    const { access } = accessFixture();
    await assert.rejects(acquire(access, options({ waitMs: 20, createSession: () => new Promise(() => {}) })), /timed out/);
    assert.equal(access.store.entries.size, 1);
});

for (const invalidation of ['owner', 'admission', 'abort', 'deadline'] as const) {
    test(`readiness rechecks ${invalidation} and closes candidate before removing entry`, async () => {
        const { access } = accessFixture(); const f = fakeSession(), entered = deferred(), ready = deferred<ChildProcessWithoutNullStreams>(), close = deferred();
        const controller = new AbortController(); let current = true;
        f.state.wait = () => { entered.resolve(); return ready.promise; }; f.state.close = () => close.promise;
        const pending = acquire(access, options({ createSession: async () => f.session,
            isCurrentOwner: () => invalidation !== 'owner' || current,
            canAcquire: () => invalidation !== 'admission' || current,
            signal: controller.signal, waitMs: invalidation === 'deadline' ? 20 : 1000 }));
        const rejected = assert.rejects(pending, /invalidated|abort|timed out/);
        await entered.promise; current = false;
        if (invalidation === 'abort') controller.abort();
        if (invalidation !== 'deadline') ready.resolve(f.child);
        await f.closed.promise; assert.equal(access.store.entries.size, 1);
        close.resolve(); ready.resolve(f.child); await rejected;
        const entry = [...access.store.entries][0];
        if (entry) await retire(access, entry[0], entry[1], new Error('test'));
        assert.equal(access.store.entries.size, 0);
        assert.ok(f.state.readiness[0]!.timeoutMs! > 0 && f.state.readiness[0]!.timeoutMs! <= 1000);
    });
}

test('preflight rejects contradictory resume and invalid admission before any factory', async () => {
    const { access } = accessFixture(); let creates = 0;
    const base = options({ createSession: async () => { creates++; return fakeSession().session; } });
    await assert.rejects(acquire(access, { ...base, storedSessionId: 'b', prepared: { ...base.prepared, resumeSessionId: 'a' } }), /resume/);
    await assert.rejects(acquire(access, { ...base, canAcquire: () => false }), /invalidated/);
    assert.equal(creates, 0); assert.equal(access.store.entries.size, 0);
});

test('prepared snapshot is captured before await and canonical cwd/env order reuse', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    const f = fakeSession(), started = deferred(), finish = deferred(); let captured!: ClaudeSessionOptions;
    const base = options({ createSession: async input => { captured = input; started.resolve(); await finish.promise; return f.session; } });
    const expected = { ...base.prepared, cwd: realpathSync(base.prepared.cwd), env: { ...base.prepared.env,
        NoDefaultCurrentDirectoryInExePath: '1', CLAUDE_AGENT_SDK_VERSION: '0.3.261',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } };
    const pending = acquire(access, base); await started.promise;
    base.prepared.model = 'mutated'; base.prepared.env.PRIVATE_KEY = 'mutated'; base.binding = binding('mutated');
    finish.resolve(); const one = await pending;
    assert.deepEqual(captured.prepared, expected); assert.equal(captured.getTurnContext().turnId, 'one'); one.release();
    const two = await acquire(access, { ...base, prepared: Object.fromEntries(Object.entries(expected).reverse()) as typeof expected });
    assert.equal(two.reused, true); two.release();
});

test('stale exit/release/retire/cancel cannot touch successor', async t => {
    const { access } = accessFixture(); t.after(() => drain(access)); const f = fakeSession(); let count = 0;
    const base = options({ createSession: async () => ++count === 1 ? f.session : fakeSession().session });
    const one = await acquire(access, base), exit = [...f.exits][0]!;
    await one.retire(); one.release(); const two = await acquire(access, base);
    exit(1); one.release(); await one.retire(); await one.cancel();
    const entry = [...access.store.entries.values()][0]!;
    assert.equal(entry.state, 'ready'); assert.equal(entry.state === 'ready' && entry.busy, true); assert.equal(two.runtime.alive, true); two.release();
});

test('factory rejection removes its sentinel so a later request can create', async t => {
    const { access } = accessFixture(); t.after(() => drain(access));
    await assert.rejects(acquire(access, options({ createSession: async () => { throw new Error('factory rejected'); } })), /factory rejected/);
    assert.equal(access.store.entries.size, 0); assert.equal(access.store.scopeIndex.size, 0);
    const lease = await acquire(access, options()); lease.release();
});

for (const closeFailure of ['claude_close_failed', 'claude_close_timeout'] as const) {
test(`public factory ${closeFailure} before returning a candidate preserves the creating fence`, async () => {
    const { access } = accessFixture(), entered = deferred(), controller = new AbortController();
    let queries = 0;
    sdkFactory = () => {
        queries++; controller.abort(); entered.resolve();
        return {
            close() { if (closeFailure === 'claude_close_failed') throw new Error('fixture close failed'); },
            [Symbol.asyncIterator]() { return this; },
            next: () => closeFailure === 'claude_close_timeout' ? new Promise(() => {})
                : Promise.resolve({ done: true, value: undefined }),
        } as ReturnType<NonNullable<ClaudeSessionOptions['queryFactory']>>;
    };
    const base = options({ signal: controller.signal, closeTimeoutMs: 5 }); delete base.createSession;
    const pending = acquire(access, base), rejected = assert.rejects(pending, /aborted/);
    await entered.promise;
    const [key, entry] = [...access.store.entries][0]!;
    const closed = assert.rejects(retire(access, key, entry, new Error('test')), new RegExp(closeFailure));
    await rejected; await closed;
    assert.equal(access.store.entries.size, 1);
    await assert.rejects(acquire(access, { ...base, signal: undefined, forceNew: true, waitMs: 20 }), /timed out/);
    assert.equal(queries, 1);
});
}

test('owner change during factory await closes the returned session without waiting for readiness', async () => {
    const { access } = accessFixture(), entered = deferred(), factory = deferred<ClaudeSdkSession>();
    const f = fakeSession(); let current = true;
    const pending = acquire(access, options({ isCurrentOwner: () => current,
        createSession: async () => { entered.resolve(); return factory.promise; } }));
    await entered.promise; current = false; factory.resolve(f.session);
    await assert.rejects(pending, /invalidated/);
    assert.equal(f.state.closes, 1); assert.equal(f.state.readiness.length, 0); assert.equal(access.store.entries.size, 0);
});

test('ownership invalidation at installation cannot return an already-stale lease', async () => {
    const { access } = accessFixture(); const f = fakeSession(); let current = true;
    const original = f.session.onExit;
    f.session.onExit = cb => { current = false; return original(cb); };
    await assert.rejects(acquire(access, options({ createSession: async () => f.session, isCurrentOwner: () => current })), /invalidated/);
    assert.equal(f.state.closes, 1); assert.equal(access.store.entries.size, 0);
});

test('abort fired during installation retires and releases the lease even when the abort race wins', async () => {
    const { access } = accessFixture(), controller = new AbortController(); const f = fakeSession();
    const original = f.session.onExit;
    f.session.onExit = cb => { controller.abort(); return original(cb); };
    await assert.rejects(acquire(access, options({ createSession: async () => f.session, signal: controller.signal })), /abort/);
    const entry = [...access.store.entries][0];
    if (entry) await retire(access, entry[0], entry[1], new Error('test'));
    assert.equal(f.state.closes, 1); assert.equal(access.store.entries.size, 0);
});

test('readiness rejection followed by never-ending close still bounds the caller and retains the fence', { timeout: 1000 }, async () => {
    const { access } = accessFixture(); const f = fakeSession();
    f.state.wait = async () => { throw new Error('root failed'); };
    f.state.close = () => new Promise(() => {});
    await assert.rejects(acquire(access, options({ createSession: async () => f.session, waitMs: 20 })), /timed out/);
    assert.equal(access.store.entries.size, 1); assert.equal(f.state.closes, 1);
});

for (const failure of ['owner', 'abort', 'readiness'] as const) {
    test(`reused lease rejects ${failure} after child wait and releases only after fencing`, async () => {
        const { access } = accessFixture(), entered = deferred(), child = deferred<ChildProcessWithoutNullStreams>();
        const f = fakeSession(), controller = new AbortController(); let current = true;
        const base = options({ createSession: async () => f.session, isCurrentOwner: () => current });
        const one = await acquire(access, base); one.release();
        f.state.wait = () => { entered.resolve(); return child.promise; };
        const pending = acquire(access, { ...base, signal: controller.signal });
        const rejected = assert.rejects(pending, /invalidated|abort|root exited/);
        await entered.promise;
        if (failure === 'owner') current = false;
        if (failure === 'abort') controller.abort();
        if (failure === 'readiness') child.reject(new Error('root exited')); else child.resolve(f.child);
        await rejected;
        const entry = [...access.store.entries][0];
        if (entry) await retire(access, entry[0], entry[1], new Error('test'));
        assert.equal(f.state.closes, 1); assert.equal(access.store.entries.size, 0);
    });
}

test('waiting borrower rechecks admission on wake without rebinding the released session', async t => {
    const { access, waited } = accessFixture(); t.after(() => drain(access));
    const f = fakeSession(); let captured!: ClaudeSessionOptions, current = true;
    const base = options({ createSession: async value => { captured = value; return f.session; } });
    const one = await acquire(access, base);
    const pending = acquire(access, { ...base, binding: binding('never-bound'), canAcquire: () => current });
    const rejected = assert.rejects(pending, /invalidated/);
    await waited.promise; current = false; one.release(); await rejected;
    assert.throws(() => captured.getTurnContext(), /not bound/); assert.equal(f.state.closes, 0);
});
