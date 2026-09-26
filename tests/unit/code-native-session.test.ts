import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { CodeSessionManager, CodeServiceError } from '../../src/code-mode/manager.js';
import { CodeSession } from '../../src/code-mode/session.js';
import { CodeStore, CodeStoreError, type CodeStoreLimits } from '../../src/code-mode/store.js';
import type { CodeOpenOptions, CodeProvider, CodeProviderSession, CodeRuntimeResource } from '../../src/code-mode/provider.js';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.js';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.js';
import type { CodeCreateSessionRequest, CodeProviderCatalog, CodeProviderId, CodeWireEvent } from '../../src/code-mode/wire.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const done: RuntimeTurnOutcome = { status: 'done', finalText: 'complete answer', partialText: '' };
const prompt = { text: 'hello', clientTurnKey: 'key-one' };

class NativeHandle implements CodeProviderSession {
    alive = true;
    sends: string[] = [];
    cancellations = 0;
    closes = 0;
    readonly sent = deferred<void>();
    readonly closeCalled = deferred<void>();
    closed = false;
    readonly closedEvent = deferred<void>();
    completeClose = true;
    private readonly outcomes = [deferred<RuntimeTurnOutcome>()];
    private readonly sentSignals = new Map([[0, this.sent]]);
    closeGate: Promise<void> | null = null;
    cancelGate: Promise<void> | null = null;
    beforeSend: (() => void) | null = null;
    private closing: Promise<void> | null = null;
    constructor(readonly nativeSessionId = 'private-native-cursor') {}
    get outcome() { return this.outcomes.at(-1)!; }
    waitSent(index: number): Promise<void> {
        if (this.sends.length > index) return Promise.resolve();
        let signal = this.sentSignals.get(index);
        if (!signal) { signal = deferred<void>(); this.sentSignals.set(index, signal); }
        return signal.promise;
    }
    send(text: string): Promise<RuntimeTurnOutcome> {
        assert.equal(this.alive, true, 'closed handles must never receive a new prompt');
        this.beforeSend?.();
        const index = this.sends.length;
        if (!this.outcomes[index]) this.outcomes[index] = deferred<RuntimeTurnOutcome>();
        this.sends.push(text);
        this.sentSignals.get(index)?.resolve();
        return this.outcomes[index]!.promise;
    }
    async cancel(): Promise<void> { this.cancellations++; await this.cancelGate; }
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closes++;
        this.closeCalled.resolve();
        this.closing = Promise.resolve().then(async () => {
            await this.closeGate;
            this.alive = false;
            if (this.completeClose) { this.closed = true; this.closedEvent.resolve(); }
        });
        return this.closing;
    }
}

class Provider implements CodeProvider {
    readonly calls: CodeOpenOptions[] = [];
    readonly handles: NativeHandle[] = [];
    readonly opens = new Map<number, ReturnType<typeof deferred<CodeOpenOptions>>>();
    gate: Promise<void> | null = null;
    beforeOpen: ((options: CodeOpenOptions) => void) | null = null;
    registerBeforeOpen = true;
    catalog: CodeProviderCatalog;
    constructor(readonly id: CodeProviderId) {
        this.catalog = { id, label: id, available: true, reason: null, models: ['model-a', 'model-b'],
            defaultModel: 'model-a', defaultEffort: 'low', modelSource: 'registry',
            capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false,
                efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] } };
    }
    describe(): CodeProviderCatalog { return structuredClone(this.catalog); }
    opened(index = 0): Promise<CodeOpenOptions> {
        if (this.calls[index]) return Promise.resolve(this.calls[index]);
        let signal = this.opens.get(index);
        if (!signal) { signal = deferred<CodeOpenOptions>(); this.opens.set(index, signal); }
        return signal.promise;
    }
    async open(options: CodeOpenOptions): Promise<CodeProviderSession> {
        const index = this.calls.length;
        this.calls.push(options);
        const handle = this.handles[index] ?? new NativeHandle(options.nativeCursor ?? undefined);
        this.handles[index] = handle;
        if (this.registerBeforeOpen) options.onResource(handle);
        this.opens.get(index)?.resolve(options);
        try {
            this.beforeOpen?.(options);
            await this.gate;
            return handle;
        } catch (error) { await handle.close(); throw error; }
    }
}

function fixture(t: TestContext, config: { capacity?: number; idleReapMs?: number; defaults?: boolean;
    storeLimits?: Partial<CodeStoreLimits>; publish?: (event: CodeWireEvent) => void } = {}) {
    const db = new Database(':memory:');
    let next = 0;
    const store = new CodeStore(db, { newId: () => `local-${++next}`,
        ...(config.storeLimits ? { limits: config.storeLimits } : {}) });
    const providers = { 'codex-app': new Provider('codex-app'), claude: new Provider('claude'),
        cursor: new Provider('cursor'), grok: new Provider('grok') };
    const events: CodeWireEvent[] = [];
    const waiters: Array<{ predicate: (event: CodeWireEvent) => boolean; resolve: (event: CodeWireEvent) => void }> = [];
    const manager = new CodeSessionManager({ store, providers,
        ...(config.defaults ? {} : { maxConcurrentSessions: config.capacity ?? 4, idleReapMs: config.idleReapMs ?? 60_000 }),
        publish(event) {
            events.push(event);
            for (const waiter of [...waiters]) {
                if (!waiter.predicate(event)) continue;
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
            }
            config.publish?.(event);
        } });
    t.after(async () => { await manager.dispose(); db.close(); });
    const waitEvent = (predicate: (event: CodeWireEvent) => boolean): Promise<CodeWireEvent> => {
        const existing = events.find(predicate);
        return existing ? Promise.resolve(existing) : new Promise(resolve => { waiters.push({ predicate, resolve }); });
    };
    const create = (provider: CodeProviderId = 'codex-app', overrides: Partial<CodeCreateSessionRequest> = {}) =>
        manager.create({ provider, cwd: '/workspace/a', model: 'model-a', effort: 'low', permissionMode: 'ask', ...overrides });
    const terminal = (id: string, epoch: number) => waitEvent(event => event.sessionId === id && event.epoch === epoch
        && event.event === 'code_session' && event.session?.turnId === null && event.session.status !== 'starting');
    return { db, store, providers, manager, events, waitEvent, create, terminal };
}

function errorCode(code: string, statusCode?: number) {
    return (error: unknown) => (error instanceof CodeStoreError || error instanceof CodeServiceError)
        && error.code === code && (statusCode === undefined || error.statusCode === statusCode);
}

function approval(options: CodeOpenOptions, question = false) {
    const context = options.getTurnContext();
    return options.registry.open({ ...context, requestType: question ? 'question' : 'approval',
        view: { title: 'Allow command?', fields: [{ id: 'decision', label: 'Run the command',
            multiSelect: false, allowFreeform: false,
            options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }] },
        isCurrent: context.isCurrent, cancelled: { optionId: null as string | null },
        validate(value: unknown) {
            assert.deepEqual(Object.keys(value as object), ['optionId']);
            const answer = value as { optionId: string };
            if (answer.optionId !== 'allow' && answer.optionId !== 'deny') throw new Error('invalid_response');
            return answer;
        } });
}

test('index attention counts hydrate unloaded sessions without transcript reads or native opens', async t => {
    const f = fixture(t);
    const a = f.create('claude');
    const b = f.create('cursor');
    assert.equal(f.manager.list().find(row => row.sessionId === a.sessionId)?.pendingPermissionCount, 0);
    assert.equal(f.providers.claude.calls.length, 0);
    const { receipt } = f.manager.prompt(a.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    const pending = approval(options);
    const rows = f.manager.list();
    assert.equal(rows.find(row => row.sessionId === a.sessionId)?.pendingPermissionCount, 1);
    assert.equal(rows.find(row => row.sessionId === b.sessionId)?.pendingPermissionCount, 0);
    assert.equal(f.providers.cursor.calls.length, 0);
    f.manager.answerPermission(pending.requestId, { sessionId: a.sessionId, turnId: receipt.turnId, epoch: 1, optionId: 'allow' });
    await pending.answer;
    assert.equal(f.manager.list().find(row => row.sessionId === a.sessionId)?.pendingPermissionCount, 0);
    handle.outcome.resolve(done);
    await f.terminal(a.sessionId, 1);
});

test('constructor and metadata reads are pure; create snapshots fixed capabilities without native open', async t => {
    const f = fixture(t);
    const row = f.create();
    f.providers['codex-app'].catalog.capabilities.permissionModes = ['auto'];
    assert.deepEqual(f.manager.snapshot(row.sessionId).session.capabilities.permissionModes, ['ask', 'auto']);
    assert.equal(f.manager.list().length, 1);
    assert.equal(f.manager.readEvents(row.sessionId).events.length, 1);
    assert.equal(f.manager.models().providers.length, 4);
    await Promise.resolve();
    assert.equal(f.providers['codex-app'].calls.length, 0);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
});

test('slow open reserves capacity synchronously while matching duplicate returns its durable receipt', async t => {
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const a = f.create(), b = f.create('claude');
    const first = f.manager.prompt(a.sessionId, prompt);
    assert.equal(first.receipt.status, 'accepted');
    assert.equal(f.store.snapshot(a.sessionId).session.status, 'starting');
    assert.equal(f.store.readTurn(a.sessionId, prompt.clientTurnKey)?.turnId, first.receipt.turnId);
    assert.deepEqual(f.manager.prompt(a.sessionId, prompt), { ...first, duplicate: true });
    assert.throws(() => f.manager.prompt(a.sessionId, { ...prompt, text: 'different' }), errorCode('turn_key_conflict'));
    assert.throws(() => f.manager.prompt(a.sessionId, { ...prompt, clientTurnKey: 'second' }), errorCode('session_busy'));
    assert.throws(() => f.manager.prompt(b.sessionId, prompt), errorCode('session_capacity', 503));
    assert.equal(f.store.readTurn(b.sessionId, prompt.clientTurnKey), null);
    const options = await f.providers['codex-app'].opened();
    assert.equal(options.getTurnContext().audience, 'internal');
    gate.resolve();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(a.sessionId, 1);
    assert.equal(f.manager.prompt(a.sessionId, prompt).receipt.status, 'completed');
    assert.equal(handle.sends.length, 1);
});

test('two providers run independently and one native exit cannot settle or cancel the other', async t => {
    const f = fixture(t);
    const a = f.create(), b = f.create('claude');
    f.manager.prompt(a.sessionId, prompt);
    f.manager.prompt(b.sessionId, prompt);
    const ac = await f.providers['codex-app'].opened(), bc = await f.providers.claude.opened();
    const ah = f.providers['codex-app'].handles[0]!, bh = f.providers.claude.handles[0]!;
    await Promise.all([ah.sent.promise, bh.sent.promise]);
    assert.notEqual(ac.registry, bc.registry);
    ac.onExit(new Error('private protocol failure'));
    await f.terminal(a.sessionId, 1);
    assert.equal(f.manager.snapshot(a.sessionId).session.error?.code, 'native_exit');
    assert.equal(f.manager.snapshot(b.sessionId).session.status, 'streaming');
    assert.equal(bh.cancellations, 0);
    bh.outcome.resolve(done);
    await f.terminal(b.sessionId, 1);
    assert.doesNotMatch(JSON.stringify(f.events), /private protocol failure|private-native-cursor/);
});

test('cancel during slow open is bounded, duplicate cancel is harmless, late handle closes without send', async t => {
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const row = f.create();
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const input = { turnId: receipt.turnId, epoch: 1 };
    const [a, b] = await Promise.all([f.manager.cancel(row.sessionId, input), f.manager.cancel(row.sessionId, input)]);
    assert.equal(a.status, 'idle');
    assert.equal(b.status, 'idle');
    assert.equal(options.signal.aborted, true);
    const other = f.create('claude');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    options.onNativeCursor('late-cursor');
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, null);
    gate.resolve();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.closedEvent.promise;
    assert.deepEqual(handle.sends, []);
    assert.equal(handle.closes, 1);
    assert.equal(f.events.filter(event => event.item?.kind === 'turn_cancelled').length, 1);
});

test('approval answers use current flat options and cancelling a pending approval invalidates eligibility', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const pending = approval(options);
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.pendingPermissions.length, 1);
    assert.equal(snapshot.items.filter(item => item.kind === 'permission_request').length, 1);
    assert.deepEqual(snapshot.pendingPermissions[0]?.options.map(option => option.optionId), ['allow', 'deny']);
    const input = { sessionId: row.sessionId, turnId: receipt.turnId, epoch: 1, optionId: 'allow' };
    assert.throws(() => f.manager.answerPermission(pending.requestId, { ...input, epoch: 2 }), errorCode('request_not_current'));
    assert.throws(() => f.manager.answerPermission(pending.requestId, { ...input, optionId: 'foreign' }), errorCode('invalid_option'));
    f.manager.answerPermission(pending.requestId, input);
    assert.deepEqual(await pending.answer, { optionId: 'allow' });
    assert.deepEqual(f.manager.snapshot(row.sessionId).pendingPermissions, []);
    const pendingTwo = approval(options);
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.deepEqual(await pendingTwo.answer, { optionId: null });
    assert.deepEqual(options.registry.list(row.sessionId), []);
    assert.throws(() => f.manager.answerPermission(pendingTwo.requestId, input), errorCode('request_not_current'));
});

test('unsupported native questions are cancelled with an explicit failed-turn diagnostic', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const question = approval(options, true);
    assert.deepEqual(await question.answer, { optionId: null });
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'unsupported_request');
    assert.deepEqual(f.manager.snapshot(row.sessionId).pendingPermissions, []);
});

test('two healthy turns reuse one handle and registry while fencing old captured frames', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const old = await f.providers['codex-app'].opened();
    const first = f.providers['codex-app'].handles[0]!;
    await first.sent.promise;
    const oldContext = old.getTurnContext();
    const oldObserver = old.transcript(oldContext);
    const oldPending = approval(old);
    oldObserver.tool('parent', { name: 'task', status: 'running' }, {});
    const oldParent = old.resolveTranscriptParent(oldContext, 'parent');
    assert.ok(oldParent);
    first.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.deepEqual(await oldPending.answer, { optionId: null });
    assert.deepEqual(old.registry.list(row.sessionId), []);
    assert.equal(first.closes, 0);
    assert.equal(old.signal.aborted, false);
    f.manager.prompt(row.sessionId, { text: 'new turn', clientTurnKey: 'new-key' });
    await first.waitSent(1);
    const current = old;
    const secondContext = current.getTurnContext();
    assert.equal(f.providers['codex-app'].calls.length, 1);
    assert.deepEqual(first.sends, ['hello', 'new turn']);
    assert.notEqual(secondContext.turnId, oldContext.turnId);
    assert.equal(secondContext.epoch, 2);
    assert.equal(oldContext.isCurrent(), false);
    assert.equal(secondContext.isCurrent(), true);
    const before = f.store.snapshot(row.sessionId).sequence;
    oldObserver.text('message', 'late', 'stale output', 'replace', 'final');
    old.onNativeCursor('stale-cursor');
    current.onNativeCursor('foreign-cursor', oldContext);
    old.record(oldContext, { kind: 'usage', inputTokens: 3 });
    current.transcript(oldContext).text('message', 'also-late', 'stale factory output', 'replace', 'final');
    const wrongEpoch = { ...secondContext, epoch: 1 };
    current.onNativeCursor('wrong-epoch', wrongEpoch);
    assert.equal(current.resolveTranscriptParent(oldContext, 'parent'), null);
    assert.equal(f.store.snapshot(row.sessionId).sequence, before);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    const { epoch: _epoch, isCurrent: _isCurrent, ...plain } = current.getTurnContext();
    current.onNativeCursor('current-cursor', plain satisfies RuntimeEventContext);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'current-cursor');
    await assert.rejects(f.manager.cancel(row.sessionId, { turnId: oldContext.turnId, epoch: 1 }), errorCode('stale_owner'));
    assert.equal(first.cancellations, 0);
    const secondObserver = current.transcript(secondContext);
    secondObserver.tool('parent', { name: 'task', status: 'running' }, {});
    assert.notEqual(current.resolveTranscriptParent(secondContext, 'parent'), oldParent);
    secondObserver.text('message', 'same-native-ref', 'second turn content', 'replace', 'final');
    const pending = approval(current);
    f.manager.answerPermission(pending.requestId, { sessionId: row.sessionId,
        turnId: secondContext.turnId, epoch: 2, optionId: 'allow' });
    assert.deepEqual(await pending.answer, { optionId: 'allow' });
    first.outcome.resolve({ ...done, finalText: 'second turn content' });
    await f.terminal(row.sessionId, 2);
    assert.equal(first.closes, 0);
    assert.equal(current.signal.aborted, false);
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.items.some(item => item.turnId === secondContext.turnId && item.text === 'second turn content'), true);
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_completed').length, 2);
});

test('nativeStarted without a cursor never falls back to fresh open or replays the consumed key', async t => {
    const f = fixture(t);
    f.providers.claude.handles.push(new NativeHandle(''));
    const row = f.create('claude');
    let startedAtSend: boolean | undefined;
    f.providers.claude.beforeOpen = options => {
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
        options.onNativeCursor(null, options.getTurnContext());
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    };
    f.providers.claude.handles[0]!.beforeSend = () => {
        startedAtSend = f.store.readRecord(row.sessionId)?.nativeStarted;
    };
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    assert.equal(startedAtSend, true);
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.resume.reason, 'resume_unavailable');
    assert.equal(f.manager.prompt(row.sessionId, prompt).duplicate, true);
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'new-key' }), errorCode('resume_unavailable'));
    await assert.rejects(f.manager.attach(row.sessionId), errorCode('resume_unavailable'));
    assert.equal(f.providers.claude.calls.length, 1);
});

for (const failure of ['spawn', 'auth', 'model'] as const) {
    test(`${failure} open failure without native input permits a repaired first-open under a new key only`, async t => {
        const f = fixture(t);
        const row = f.create('claude');
        const provider = f.providers.claude;
        provider.handles.push(new NativeHandle(''));
        provider.beforeOpen = options => {
            options.onNativeCursor(null, options.getTurnContext());
            throw new Error(`${failure} opening failure`);
        };
        const first = f.manager.prompt(row.sessionId, prompt);
        await provider.opened();
        await f.terminal(row.sessionId, 1);
        assert.equal(provider.handles[0]!.closes, 1);
        assert.equal(provider.handles[0]!.sends.length, 0);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, null);
        assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
        provider.beforeOpen = null;
        const duplicate = f.manager.prompt(row.sessionId, prompt);
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.receipt.turnId, first.receipt.turnId);
        assert.equal(duplicate.receipt.status, 'failed');
        assert.equal(provider.calls.length, 1);
        f.manager.prompt(row.sessionId, { text: 'retry after repair', clientTurnKey: 'repaired-open' });
        const options = await provider.opened(1);
        const repaired = provider.handles[1]!;
        await repaired.sent.promise;
        assert.equal(options.nativeCursor, null);
        assert.deepEqual(repaired.sends, ['retry after repair']);
        repaired.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.store.readTurn(row.sessionId, 'repaired-open')?.status, 'completed');
        assert.equal(provider.calls.length, 2);
    });
}

test('cancelled unknown-ID opening can first-open again only after its late handle has closed', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const provider = f.providers.claude;
    const gate = deferred<void>();
    provider.gate = gate.promise;
    provider.handles.push(new NativeHandle(''));
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-close' }), errorCode('cleanup_pending'));
    gate.resolve();
    await provider.handles[0]!.closedEvent.promise;
    await yieldEventLoop();
    assert.equal(provider.handles[0]!.sends.length, 0);
    assert.equal(provider.handles[0]!.closes, 1);
    assert.equal(f.manager.prompt(row.sessionId, prompt).receipt.status, 'cancelled');
    provider.gate = null;
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-close' });
    const options = await provider.opened(1);
    const next = provider.handles[1]!;
    await next.sent.promise;
    assert.equal(options.nativeCursor, null);
    next.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
});

test('an ID-less send that throws still consumes the key and prevents a fresh-history retry', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const handle = new NativeHandle('');
    let startedAtSend: boolean | undefined;
    handle.beforeSend = () => {
        startedAtSend = f.store.readRecord(row.sessionId)?.nativeStarted;
        throw new Error('dispatch outcome unknown');
    };
    f.providers.claude.handles.push(handle);
    const original = f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    await f.terminal(row.sessionId, 1);
    assert.equal(startedAtSend, true);
    assert.equal(handle.closes, 1);
    const duplicate = f.manager.prompt(row.sessionId, prompt);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.turnId, original.receipt.turnId);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'unsafe-retry' }), errorCode('resume_unavailable'));
    assert.equal(f.store.readTurn(row.sessionId, 'unsafe-retry'), null);
    assert.equal(f.providers.claude.calls.length, 1);
});

test('an actual cursor observed before an open failure is preserved and used for the next explicit resume', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const provider = f.providers.claude;
    provider.handles.push(new NativeHandle(''));
    provider.beforeOpen = options => {
        const context = options.getTurnContext();
        options.onNativeCursor('observed-native-cursor', context);
        options.onNativeCursor(null, context);
        throw new Error('startup failed after receiving thread identity');
    };
    f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await f.terminal(row.sessionId, 1);
    assert.equal(provider.handles[0]!.sends.length, 0);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, true);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'observed-native-cursor');
    provider.beforeOpen = null;
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'resume-observed' });
    const options = await provider.opened(1);
    const resumed = provider.handles[1]!;
    await resumed.sent.promise;
    assert.equal(options.nativeCursor, 'observed-native-cursor');
    resumed.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
});

test('constructor never recovers interrupted rows; explicit recover orphans once and never launches native replay', t => {
    const f = fixture(t);
    const row = f.create();
    const admitted = f.store.admitTurn({ ...prompt, sessionId: row.sessionId });
    const second = new CodeSessionManager({ store: f.store, providers: f.providers, publish: () => {} });
    t.after(() => second.dispose());
    assert.equal(f.store.read(row.sessionId)?.status, 'starting');
    second.recover();
    const snapshot = second.snapshot(row.sessionId);
    assert.equal(snapshot.session.status, 'failed');
    assert.equal(snapshot.session.error?.code, 'orphaned_turn');
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_failed').length, 1);
    second.recover();
    assert.equal(second.snapshot(row.sessionId).sequence, snapshot.sequence);
    assert.equal(second.prompt(row.sessionId, prompt).receipt.turnId, admitted.receipt.turnId);
    assert.equal(second.prompt(row.sessionId, prompt).receipt.status, 'failed');
    assert.equal(f.providers['codex-app'].calls.length, 0);
});

test('database admission failure returns 503 before publication or native execution and releases reservation', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create();
    const count = f.events.length;
    f.db.exec("CREATE TRIGGER reject_turn BEFORE INSERT ON code_turns BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('persistence_failed', 503));
    assert.equal(f.events.length, count);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey), null);
    assert.equal(f.providers['codex-app'].calls.length, 0);
    f.db.exec('DROP TRIGGER reject_turn');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
});

for (const callback of ['text', 'tool', 'close', 'child', 'cursor', 'recorder', 'finish'] as const) {
    test(`persistence failure in ${callback} dominates subsequent native success and cancels only its owned handle`, async t => {
        const f = fixture(t);
        const row = f.create('claude'), other = f.create('cursor');
        f.manager.prompt(row.sessionId, prompt);
        f.manager.prompt(other.sessionId, prompt);
        const options = await f.providers.claude.opened();
        await f.providers.cursor.opened();
        const handle = f.providers.claude.handles[0]!, peer = f.providers.cursor.handles[0]!;
        await Promise.all([handle.sent.promise, peer.sent.promise]);
        const context = options.getTurnContext();
        const observer = options.transcript(context);
        observer.tool('parent-tool', { name: 'task', status: 'running' }, {});
        const parentItemId = options.resolveTranscriptParent(context, 'parent-tool');
        assert.ok(parentItemId);
        const child = options.transcript({ ...context, parentItemId });
        const table = callback === 'cursor' ? 'code_sessions' : 'code_items';
        f.db.exec(`CREATE TRIGGER reject_write BEFORE ${callback === 'cursor' ? 'UPDATE' : 'INSERT'} ON ${table}
            WHEN NEW.session_id = '${row.sessionId}' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
        if (callback === 'text') observer.text('message', 'a', 'answer', 'replace', 'final');
        if (callback === 'tool') observer.tool('a', { name: 'read', status: 'running' }, {});
        if (callback === 'close') observer.close({ kind: 'turn-end', status: 'done', finalText: 'answer' });
        if (callback === 'child') child.text('message', 'a', 'child answer', 'replace', 'final');
        if (callback === 'cursor') options.onNativeCursor('new-native-id', context);
        if (callback === 'recorder') approval(options);
        handle.outcome.resolve(done);
        await handle.closedEvent.promise;
        assert.throws(() => f.manager.snapshot(row.sessionId), errorCode('persistence_failed', 503));
        assert.equal(handle.closes, 1);
        assert.equal(peer.cancellations, 0);
        assert.equal(f.store.snapshot(row.sessionId).items.some(item => item.kind === 'turn_completed'), false);
        assert.equal(f.events.some(event => event.sessionId === row.sessionId && event.item?.kind === 'turn_completed'), false);
        f.db.exec('DROP TRIGGER reject_write');
        peer.outcome.resolve(done);
        await f.terminal(other.sessionId, 1);
    });
}

test('subscriber exceptions never become persistence failures or prevent committed terminal events', async t => {
    const f = fixture(t, { publish: () => { throw new Error('subscriber error'); } });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    options.transcript(options.getTurnContext()).text('message', 'a', 'stored content', 'replace', 'final');
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.status, 'idle');
    assert.equal(f.manager.snapshot(row.sessionId).items.some(item => item.text === 'stored content'), true);
});

for (const quotaCode of ['transcript_limit', 'event_too_large'] as const) {
    test(`${quotaCode} from the item commit fails the turn without poisoning reads or the next explicit resume`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        const f = fixture(t);
        const row = f.create('claude');
        const originalCommit = f.store.commitItem.bind(f.store);
        let exhausted = false;
        // Exercise the service's typed Store boundary; byte accounting belongs to Store tests.
        const fault = t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => {
            if (exhausted && args[0].sessionId === row.sessionId && args[1].kind === 'assistant_message') {
                throw new CodeStoreError(quotaCode, 'Ordinary event byte budget exceeded', 409);
            }
            return originalCommit(...args);
        });
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const options = await f.providers.claude.opened();
        const handle = f.providers.claude.handles[0]!;
        await handle.sent.promise;
        const observer = options.transcript(options.getTurnContext());
        observer.text('message', 'answer', 'retained answer', 'replace', 'final');
        exhausted = true;
        observer.text('message', 'answer', ' beyond the byte budget', 'append', 'final');
        t.mock.timers.tick(50);
        assert.doesNotThrow(() => f.manager.snapshot(row.sessionId));
        handle.outcome.resolve(done);
        await f.terminal(row.sessionId, 1);
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'transcript_limit');
        assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
        assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
        assert.equal(f.manager.prompt(row.sessionId, prompt).duplicate, true);
        assert.equal(handle.closes, 1);
        exhausted = false;
        fault.mock.restore();
        f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-budget-repair' });
        const resumedOptions = await f.providers.claude.opened(1);
        const resumed = f.providers.claude.handles[1]!;
        await resumed.sent.promise;
        assert.equal(resumedOptions.nativeCursor, 'private-native-cursor');
        resumed.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.manager.snapshot(row.sessionId).session.error, null);
        assert.equal(f.store.readTurn(row.sessionId, 'after-budget-repair')?.status, 'completed');
    });
}

for (const budget of ['event', 'turn'] as const) {
    test(`real ${budget} byte exhaustion uses the terminal reserve and allows a new small turn`, async t => {
        const f = fixture(t, { storeLimits: budget === 'event'
            ? { maxEventBytes: 4096, maxTurnEventBytes: 65536 }
            : { maxEventBytes: 16384, maxTurnEventBytes: 8192 } });
        const row = f.create();
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const options = await f.providers['codex-app'].opened();
        const handle = f.providers['codex-app'].handles[0]!;
        await handle.sent.promise;
        options.transcript(options.getTurnContext()).text('message', 'large', 'x'.repeat(12000), 'replace', 'final');
        handle.outcome.resolve(done);
        await f.terminal(row.sessionId, 1);
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'transcript_limit');
        assert.equal(failed.items.some(item => item.turnId === receipt.turnId && item.kind === 'turn_failed'), true);
        assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
        f.manager.prompt(row.sessionId, { text: 'small follow-up', clientTurnKey: 'small-turn' });
        const resumedOptions = await f.providers['codex-app'].opened(1);
        const resumed = f.providers['codex-app'].handles[1]!;
        await resumed.sent.promise;
        assert.equal(resumedOptions.nativeCursor, 'private-native-cursor');
        resumed.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.store.readTurn(row.sessionId, 'small-turn')?.status, 'completed');
    });
}

test('a real DB failure settling a quota failure still poisons the affected session', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const originalCommit = f.store.commitItem.bind(f.store);
    t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => {
        if (args[1].kind === 'assistant_message') throw new CodeStoreError('transcript_limit', 'Byte budget exceeded', 409);
        return originalCommit(...args);
    });
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    f.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON code_turns BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    options.transcript(options.getTurnContext()).text('message', 'answer', 'over budget', 'replace', 'final');
    handle.outcome.resolve(done);
    await assert.rejects(f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 }), errorCode('persistence_failed', 503));
    assert.throws(() => f.manager.snapshot(row.sessionId), errorCode('persistence_failed', 503));
    assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
});

test('production sessions coalesce updates for 50ms and finish flushes pending text before its terminal commit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const observer = options.transcript(options.getTurnContext());
    const readText = () => f.manager.snapshot(row.sessionId).items.find(item => item.kind === 'assistant_message')?.text;
    observer.text('message', 'answer', 'A', 'replace', 'final');
    observer.text('message', 'answer', 'B', 'append', 'final');
    observer.text('message', 'answer', 'C', 'append', 'final');
    assert.equal(readText(), 'A');
    t.mock.timers.tick(49);
    assert.equal(readText(), 'A');
    t.mock.timers.tick(1);
    assert.equal(readText(), 'ABC');
    observer.text('message', 'answer', 'D', 'append', 'final');
    assert.equal(readText(), 'ABC');
    handle.outcome.resolve({ ...done, finalText: 'ABCD' });
    await f.terminal(row.sessionId, 1);
    assert.equal(readText(), 'ABCD');
    const lastItem = f.events.findLastIndex(event => event.item?.kind === 'assistant_message');
    const terminal = f.events.findIndex(event => event.item?.kind === 'turn_completed');
    assert.ok(lastItem < terminal);
    const committed = f.events.length;
    t.mock.timers.tick(100);
    assert.equal(f.events.length, committed);
});

test('pending permission labels redact embedded JSON secrets without changing opaque option answers', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const context = options.getTurnContext();
    const pending = options.registry.open({ ...context, requestType: 'approval', isCurrent: context.isCurrent,
        cancelled: { optionId: null as string | null },
        view: {
            title: 'Review configuration\n```json\n{"token":"title-sensitive-value"}\n```',
            fields: [{ id: 'decision',
                label: 'Details\n```json\n{"password":"detail-sensitive-value"}\n```',
                multiSelect: false, allowFreeform: false,
                options: [{ id: 'opaque-allow',
                    label: 'Allow once\n```json\n{"apiKey":"option-sensitive-value"}\n```' }] }],
        },
        validate(value: unknown) {
            assert.deepEqual(value, { optionId: 'opaque-allow' });
            return { optionId: 'opaque-allow' };
        },
    });
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.pendingPermissions.length, 1);
    assert.deepEqual(snapshot.pendingPermissions[0]?.options.map(option => option.optionId), ['opaque-allow']);
    assert.doesNotMatch(JSON.stringify(snapshot.pendingPermissions), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    assert.doesNotMatch(JSON.stringify(snapshot.items), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    assert.doesNotMatch(JSON.stringify(f.events), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    f.manager.answerPermission(pending.requestId, { sessionId: row.sessionId, turnId: context.turnId,
        epoch: context.epoch, optionId: 'opaque-allow' });
    assert.deepEqual(await pending.answer, { optionId: 'opaque-allow' });
});

test('policy patch closes idle runtime and resumes the same cursor with the complete updated tuple', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'auto' }), errorCode('session_busy'));
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b', effort: 'high', permissionMode: 'auto' });
    assert.equal(handle.closes, 1);
    const attaching = f.manager.attach(row.sessionId);
    const options = await f.providers['codex-app'].opened(1);
    const attached = await attaching;
    assert.equal(attached.status, 'idle');
    assert.equal(options.nativeCursor, 'private-native-cursor');
    assert.equal(options.model, 'model-b');
    assert.equal(options.effort, 'high');
    assert.equal(options.permissionMode, 'auto');
    assert.equal(f.providers['codex-app'].handles[1]?.sends.length, 0);
    assert.equal(attached.revision, patched.revision);
    assert.equal(f.providers['codex-app'].calls.length, 2);
    f.manager.prompt(row.sessionId, { text: 'after policy change', clientTurnKey: 'new-policy' });
    const resumed = f.providers['codex-app'].handles[1]!;
    await resumed.sent.promise;
    assert.equal(f.providers['codex-app'].calls.length, 2);
    resumed.outcome.resolve(done);
    await f.terminal(row.sessionId, 4);
});

test('rename revision race rejects stale metadata and archive preserves history while rejecting prompt/attach', async t => {
    const f = fixture(t);
    const row = f.create();
    const first = f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'chosen title' });
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'stale title' }), errorCode('revision_conflict'));
    const renamed = await first;
    const archived = await f.manager.patch(row.sessionId, { expectedRevision: renamed.revision, archived: true });
    assert.equal(f.manager.snapshot(row.sessionId).session.title, 'chosen title');
    assert.ok(archived.archivedAt);
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('session_archived'));
    await assert.rejects(f.manager.attach(row.sessionId), errorCode('session_archived'));
    assert.equal(f.manager.list({ archived: true }).length, 1);
    assert.equal(f.providers['codex-app'].calls.length, 0);
});

test('unsupported model, effort and permission mode fail before provider open', async t => {
    const f = fixture(t);
    assert.throws(() => f.create('cursor', { model: 'unknown' }), errorCode('unsupported_model', 400));
    assert.throws(() => f.create('cursor', { effort: 'unknown' }), errorCode('unsupported_effort', 400));
    assert.throws(() => f.create('grok', { permissionMode: 'read-only' }), errorCode('unsupported_policy', 400));
    const row = f.create('cursor');
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'read-only' }), errorCode('unsupported_policy'));
    assert.equal(f.providers.cursor.calls.length, 0);
});

test('a catalog that drops a model keeps the running session usable but blocks new choices', async t => {
    const f = fixture(t);
    const row = f.create('cursor', { model: 'model-b' });
    // A live catalog can change under a running session. Its own model must stay
    // legal, or prompt and attach would fail for a reason the user cannot act on.
    f.providers.cursor.catalog = { ...f.providers.cursor.catalog, models: ['model-a'] };
    assert.doesNotThrow(() => f.manager.prompt(row.sessionId, { text: 'still works', clientTurnKey: 'k-drift' }));
    // Choosing something the runtime no longer serves is still refused.
    assert.throws(() => f.create('cursor', { model: 'model-b' }), errorCode('unsupported_model', 400));
    const idle = f.create('cursor', { model: 'model-a' });
    await assert.rejects(f.manager.patch(idle.sessionId, { expectedRevision: idle.revision, model: 'model-b' }),
        errorCode('unsupported_model', 400));
    // Re-selecting the value the session already runs with is not a new choice.
    await assert.doesNotReject(f.manager.patch(idle.sessionId, { expectedRevision: idle.revision, model: 'model-a' }));
});

test('a catalog that drops an effort keeps the running session usable', async t => {
    const f = fixture(t);
    const row = f.create('cursor', { effort: 'high' });
    // Same drift, one level down: the live union can lose an effort the session
    // was opened with. Its own stored capabilities still bound it, so the value
    // stays legal; a newly chosen one is checked against the current catalog.
    f.providers.cursor.catalog = { ...f.providers.cursor.catalog,
        capabilities: { ...f.providers.cursor.catalog.capabilities, efforts: ['low'] } };
    assert.doesNotThrow(() => f.manager.prompt(row.sessionId, { text: 'still works', clientTurnKey: 'k-effort' }));
    assert.throws(() => f.create('cursor', { effort: 'high' }), errorCode('unsupported_effort', 400));
});

test('drift exemption covers only the values a session actually kept', async t => {
    const f = fixture(t);
    const row = f.create('cursor', { model: 'model-b', effort: 'high' });
    // The whole catalog moves: this session's model and effort both disappear.
    f.providers.cursor.catalog = { ...f.providers.cursor.catalog, models: ['model-a'],
        capabilities: { ...f.providers.cursor.catalog.capabilities, efforts: ['low'] } };
    // Keeping both is the only combination the session is allowed to carry
    // forward; the exemption must not leak into a partial change.
    assert.doesNotThrow(() => f.manager.prompt(row.sessionId, { text: 'both kept', clientTurnKey: 'k-both' }));
    const live = f.manager.snapshot(row.sessionId).session;
    // Changing the model forfeits the effort exemption too, because the pair is
    // what the runtime was opened with.
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: live.revision, model: 'model-a' }),
        errorCode('unsupported_effort', 400));
    // And a value that was never accepted is refused even while the rest is kept.
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: live.revision, effort: 'medium' }),
        errorCode('unsupported_effort', 400));
});

test('dispose is idempotent during pending open and later closes orphaned startup without replay', async t => {
    const f = fixture(t);
    const gate = deferred<void>();
    f.providers.claude.gate = gate.promise;
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const first = f.manager.dispose();
    assert.equal(f.manager.dispose(), first);
    await first;
    assert.equal(options.signal.aborted, true);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('manager_disposed'));
    gate.resolve();
    const handle = f.providers.claude.handles[0]!;
    await handle.closedEvent.promise;
    assert.equal(handle.closes, 1);
    assert.deepEqual(handle.sends, []);
});

test('idle reap closes only resident idle handles and retains transcript and cursor', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { idleReapMs: 100 });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const before = f.manager.snapshot(row.sessionId);
    t.mock.timers.tick(100);
    await handle.closedEvent.promise;
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, before.items);
});

test('cleanup timeout retains capacity and prevents overlapping reopen until physical close', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    const row = f.create(), other = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.closeGate = gate.promise;
    const cancelling = f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    await handle.closeCalled.promise;
    t.mock.timers.tick(4000);
    const cancelled = await cancelling;
    assert.equal(handle.alive, true);
    // The turn view stays `idle` while unproven native residue carries its own readout.
    assert.equal(cancelled.status, 'idle');
    assert.equal(cancelled.error, null);
    assert.equal(cancelled.turnId, null);
    assert.equal(cancelled.cleanupPending, true);
    assert.equal(f.manager.snapshot(row.sessionId).session.cleanupPending, true);
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.cleanupPending, true);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'no-overlap' }), errorCode('cleanup_pending'));
    assert.equal(f.store.readTurn(row.sessionId, 'no-overlap'), null);
    gate.resolve();
    await handle.closedEvent.promise;
    assert.equal(handle.closes, 1);
    // The first read to observe physical close clears the readout and frees the held capacity.
    const released = f.manager.snapshot(row.sessionId).session;
    assert.equal(released.cleanupPending, false);
    assert.equal(released.contextUsage, undefined, 'the clearing snapshot carries no usage from the closed runtime');
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.cleanupPending, false);
    const admitted = f.manager.prompt(other.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const next = f.providers.claude.handles[0]!;
    await next.sent.promise;
    // A Stop whose native close is proven keeps the ordinary idle-only readout.
    const stopped = await f.manager.cancel(other.sessionId, { turnId: admitted.receipt.turnId, epoch: 1 });
    assert.equal(stopped.status, 'idle');
    assert.equal(stopped.cleanupPending, false);
    assert.equal(f.manager.snapshot(other.sessionId).session.cleanupPending, false);
    assert.equal(f.events.filter(event => event.item?.kind === 'turn_cancelled').length, 2);
});

for (const reconcileAt of ['snapshot', 'same-session', 'other-session'] as const) {
    test(`late closed proof after a rejected close releases ${reconcileAt} admission without clearing the stored failure`, async t => {
        const f = fixture(t, { capacity: 1 });
        const row = f.create(), other = f.create('claude');
        f.manager.prompt(row.sessionId, prompt);
        await f.providers['codex-app'].opened();
        const handle = f.providers['codex-app'].handles[0]!;
        await handle.sent.promise;
        const close = deferred<void>();
        handle.closeGate = close.promise;
        handle.outcome.resolve({ ...done, status: 'error' });
        await handle.closeCalled.promise;
        handle.alive = false;
        close.reject(new Error('native drain incomplete'));
        await f.terminal(row.sessionId, 1);
        // Keep a disposed owner too: checking `closing` before reconciliation would block forever.
        await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'native_failed');
        // A failed settlement carries the same cleanup-pending readout while residue is undrained.
        assert.equal(failed.session.cleanupPending, true);
        assert.equal(handle.closed, false);
        assert.equal(handle.alive, false);
        assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'late-retry' }), errorCode('session_closing'));
        assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
        assert.equal(f.store.readTurn(row.sessionId, 'late-retry'), null);
        assert.equal(f.store.readTurn(other.sessionId, prompt.clientTurnKey), null);
        const eventCount = f.events.length;
        // No callback and no timer: the next existing read/admission observes the native receipt.
        handle.closed = true;
        if (reconcileAt === 'snapshot') {
            // Only the read-time readout flips: the stored failure frame itself is untouched.
            assert.deepEqual(f.manager.snapshot(row.sessionId),
                { ...failed, session: { ...failed.session, cleanupPending: false } });
            assert.equal(f.events.length, eventCount);
        }
        const target = reconcileAt === 'other-session' ? other : row;
        const provider = reconcileAt === 'other-session' ? f.providers.claude : f.providers['codex-app'];
        const index = reconcileAt === 'other-session' ? 0 : 1;
        f.manager.prompt(target.sessionId, { ...prompt, clientTurnKey: 'late-retry' });
        const options = await provider.opened(index);
        const next = provider.handles[index]!;
        await next.sent.promise;
        assert.equal(options.nativeCursor, reconcileAt === 'other-session' ? null : 'private-native-cursor');
        assert.equal(handle.closes, 1, 'the rejected native close is never retried or relabelled');
        if (reconcileAt === 'other-session') assert.deepEqual(f.manager.snapshot(row.sessionId),
            { ...failed, session: { ...failed.session, cleanupPending: false } });
        next.outcome.resolve(done);
        await f.terminal(target.sessionId, reconcileAt === 'other-session' ? 1 : 3);
    });
}

test('a returned handle is registered even without an early callback and requires physical close proof', async t => {
    const f = fixture(t, { capacity: 1 });
    f.providers['codex-app'].registerBeforeOpen = false;
    const row = f.create(), other = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.completeClose = false;
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(handle.alive, false);
    assert.equal(handle.closed, false);
    assert.equal(handle.closes, 1);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'still-draining' }), errorCode('cleanup_pending'));
    handle.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(handle.closes, 1);
});

test('open rejection plus failed cleanup retains its preregistered resource until late physical exit', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const provider = f.providers['codex-app'];
    const resource = new NativeHandle('');
    const drain = deferred<void>();
    resource.closeGate = drain.promise;
    provider.handles.push(resource);
    provider.beforeOpen = () => { throw new Error('native initialization failed'); };
    const admitted = f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await resource.closeCalled.promise;
    drain.reject(new Error('native cleanup deadline expired'));
    await f.terminal(row.sessionId, 1);
    assert.equal(resource.closed, false);
    assert.equal(resource.sends.length, 0);
    assert.equal(resource.closes, 1);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    const failed = f.manager.snapshot(row.sessionId);
    assert.equal(failed.session.status, 'failed');
    assert.equal(failed.session.cleanupPending, true);
    const duplicate = f.manager.prompt(row.sessionId, prompt);
    assert.equal(duplicate.receipt.turnId, admitted.receipt.turnId);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'too-early' }), errorCode('cleanup_pending'));
    assert.equal(f.store.readTurn(other.sessionId, prompt.clientTurnKey), null);
    resource.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    // Observing physical close clears only the read-time readout, never the stored frame.
    assert.deepEqual(f.manager.snapshot(row.sessionId),
        { ...failed, session: { ...failed.session, cleanupPending: false } });
    assert.equal(resource.closes, 1);
    assert.equal(provider.calls.length, 1);
});

test('late onResource after cancellation closes only the owned resource and waits for all startup receipts', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const provider = f.providers['codex-app'];
    const opening = deferred<void>();
    provider.gate = opening.promise;
    const startup = new NativeHandle('');
    startup.completeClose = false;
    provider.handles.push(startup);
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await provider.opened();
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(startup.closed, false, 'a pre-start resource is not already drained');
    const late = new NativeHandle('');
    const drain = deferred<void>();
    late.closeGate = drain.promise;
    const registered: CodeRuntimeResource = late;
    options.onResource(registered);
    options.onResource(registered);
    await late.closeCalled.promise;
    assert.equal(late.closes, 1);
    assert.equal(late.sends.length, 0);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    opening.resolve();
    await yieldEventLoop();
    startup.closed = true;
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    drain.resolve();
    await late.closedEvent.promise;
    await yieldEventLoop();
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(startup.closes, 1);
    assert.equal(startup.sends.length, 0);
    assert.equal(late.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
});

test('a closed successful handle cannot release capacity while another registered resource is undrained', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const childResource = new NativeHandle('');
    childResource.completeClose = false;
    f.providers['codex-app'].beforeOpen = options => options.onResource(childResource);
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve({ ...done, status: 'error' });
    await f.terminal(row.sessionId, 1);
    assert.equal(handle.closed, true);
    assert.equal(childResource.closed, false);
    assert.equal(childResource.closes, 1);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    childResource.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(childResource.closes, 1);
});

test('observer failure during open aborts startup and retires the returned handle without calling send', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON code_items
        WHEN json_extract(NEW.item_json, '$.kind') = 'assistant_message'
        BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    f.providers.claude.beforeOpen = options => {
        options.transcript(options.getTurnContext()).text('message', 'startup', 'content', 'replace', 'commentary');
    };
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.closedEvent.promise;
    await f.terminal(row.sessionId, 1);
    assert.equal(options.signal.aborted, true);
    assert.equal(handle.sends.length, 0);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'persistence_failed');
});

test('attach reserves capacity before await and rejected resume keeps history without fresh fallback', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const before = f.manager.snapshot(row.sessionId).items;
    await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const attaching = f.manager.attach(row.sessionId);
    const options = await f.providers['codex-app'].opened(1);
    const other = f.create('claude');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.equal(options.nativeCursor, 'private-native-cursor');
    gate.reject(new Error('resume rejected'));
    const failed = await attaching;
    assert.equal(failed.status, 'failed');
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, before);
    assert.equal(f.providers['codex-app'].calls.length, 2);
    assert.equal(f.providers['codex-app'].handles[1]?.sends.length, 0);
});

test('rename during slow open keeps its revision/title and cannot change the captured native policy', async t => {
    const f = fixture(t);
    const gate = deferred<void>();
    f.providers.cursor.gate = gate.promise;
    const row = f.create('cursor');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.cursor.opened();
    const renamed = await f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'user title' });
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: renamed.revision, model: 'model-b' }), errorCode('session_busy'));
    gate.resolve();
    const handle = f.providers.cursor.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(options.model, 'model-a');
    assert.equal(options.permissionMode, 'ask');
    assert.equal(f.manager.snapshot(row.sessionId).session.title, 'user title');
    assert.equal(f.manager.snapshot(row.sessionId).session.revision, 1);
});

test('dispose resolves pending approvals and settles despite a native send that never resolves', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    const pending = approval(options);
    await f.manager.dispose();
    assert.deepEqual(await pending.answer, { optionId: null });
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.equal(handle.closes, 1);
    assert.deepEqual(options.registry.list(row.sessionId), []);
});

test('a cancel requested from final-item publication still cleans up before cancelled terminal commit', async t => {
    let cancelAtFinal: (() => void) | null = null;
    const f = fixture(t, { publish(event) {
        if (event.item?.kind === 'assistant_message') cancelAtFinal?.();
    } });
    const row = f.create();
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const cancelled = deferred<void>();
    cancelAtFinal = () => {
        cancelAtFinal = null;
        void f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 }).then(
            () => cancelled.resolve(), error => cancelled.reject(error));
    };
    handle.outcome.resolve(done);
    await cancelled.promise;
    assert.equal(handle.alive, false);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
});

for (const ending of ['cancel', 'native-error', 'native-stop', 'exit'] as const) {
    test(`${ending} retires the owned handle and the next prompt opens a fresh binding with the same native cursor`, async t => {
        const f = fixture(t);
        const row = f.create();
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const old = await f.providers['codex-app'].opened();
        const first = f.providers['codex-app'].handles[0]!;
        await first.sent.promise;
        const captured = old.getTurnContext();
        if (ending === 'cancel') await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
        if (ending === 'native-error') first.outcome.resolve({ ...done, status: 'error' });
        if (ending === 'native-stop') first.outcome.resolve({ ...done, status: 'stopped' });
        if (ending === 'exit') old.onExit(new Error('native exit'));
        await f.terminal(row.sessionId, 1);
        assert.equal(first.closes, 1);
        assert.equal(old.signal.aborted, true);
        f.manager.prompt(row.sessionId, { text: 'continue explicitly', clientTurnKey: 'new-run' });
        const current = await f.providers['codex-app'].opened(1);
        const second = f.providers['codex-app'].handles[1]!;
        await second.sent.promise;
        assert.equal(f.providers['codex-app'].calls.length, 2);
        assert.equal(current.nativeCursor, 'private-native-cursor');
        const currentContext = current.getTurnContext();
        const before = f.store.snapshot(row.sessionId).sequence;
        old.onNativeCursor('old-binding-with-current-context', currentContext);
        old.transcript(currentContext).text('message', 'foreign', 'foreign content', 'replace', 'final');
        assert.equal(old.record(currentContext, { kind: 'usage', inputTokens: 10 }), null);
        assert.equal(old.record(captured, { kind: 'usage', inputTokens: 20 }), null);
        assert.throws(() => old.getTurnContext(), errorCode('stale_owner'));
        old.onExit(new Error('late exit from replaced handle'));
        assert.equal(f.store.snapshot(row.sessionId).sequence, before);
        assert.equal(second.cancellations, 0);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
        second.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
    });
}

test('native exit on a reused handle fails its current second turn and leaves the first terminal intact', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    f.manager.prompt(row.sessionId, { text: 'second turn', clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    options.onExit(new Error('resident process exited'));
    await f.terminal(row.sessionId, 2);
    assert.equal(f.providers.claude.calls.length, 1);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'completed');
    assert.equal(f.store.readTurn(row.sessionId, 'second-key')?.status, 'failed');
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'native_exit');
});

test('observer persistence failure on a reused handle cannot target the old turn or publish second-turn success', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const { receipt } = f.manager.prompt(row.sessionId, { text: 'second turn', clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    f.db.exec(`CREATE TRIGGER reject_second_assistant BEFORE INSERT ON code_items
        WHEN json_extract(NEW.item_json, '$.kind') = 'assistant_message'
        BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    options.transcript(options.getTurnContext()).text('message', 'a', 'lost answer', 'replace', 'final');
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
    assert.equal(f.providers.claude.calls.length, 1);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'completed');
    assert.equal(f.store.readTurn(row.sessionId, 'second-key')?.status, 'failed');
    assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
});

test('a no-op policy patch retains the handle and idle exit follows the updated metadata epoch', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-a' });
    assert.equal(handle.closes, 0);
    options.onExit(new Error('idle exit'));
    await handle.closedEvent.promise;
    assert.equal(f.manager.snapshot(row.sessionId).session.epoch, patched.epoch);
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'native_exit');
});

test('shared defaults admit four residents and idle eviction at 30000ms releases capacity without deleting history', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const f = fixture(t, { defaults: true });
    const rows = Array.from({ length: 5 }, () => f.create());
    for (const row of rows.slice(0, 4)) f.manager.prompt(row.sessionId, prompt);
    const provider = f.providers['codex-app'];
    await Promise.all([0, 1, 2, 3].map(index => provider.opened(index)));
    await Promise.all(provider.handles.map(handle => handle.sent.promise));
    const first = provider.handles[0]!;
    const row = rows[0]!, fifth = rows[4]!;
    first.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const history = f.manager.snapshot(row.sessionId).items;
    assert.throws(() => f.manager.prompt(fifth.sessionId, prompt), errorCode('session_capacity'));
    t.mock.timers.tick(29_999);
    assert.equal(first.closes, 0);
    t.mock.timers.tick(1);
    await first.closedEvent.promise;
    // Drain the completed close continuation, without advancing wall-clock time.
    await yieldEventLoop();
    assert.equal(first.closes, 1);
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, history);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    f.manager.prompt(fifth.sessionId, prompt);
    await provider.opened(4);
    assert.equal(provider.calls.length, 5);
});

async function streamingFixture(t: TestContext, config: Parameters<typeof fixture>[1] = {}) {
    const f = fixture(t, config);
    const row = f.create();
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const context = options.getTurnContext();
    return { ...f, row, receipt, options, handle, context, observer: options.transcript(context) };
}

for (const ending of ['cancel', 'exit', 'rejection', 'dispose', 'native-stop', 'native-error'] as const) {
    test(`RT01: ${ending} retains accepted AB before settlement and rejects late C`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
        const f = await streamingFixture(t);
        f.observer.text('message', 'answer', 'A', 'replace', 'final');
        f.observer.text('message', 'answer', 'B', 'append', 'final');
        const before = f.store.snapshot(f.row.sessionId).items.find(item => item.kind === 'assistant_message')!;
        assert.equal(before.text, 'A');
        t.mock.timers.tick(49);
        if (ending === 'cancel') await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
        if (ending === 'dispose') await f.manager.dispose();
        if (ending === 'exit') f.options.onExit(new Error('native exit'));
        if (ending === 'rejection') f.handle.outcome.reject(new Error('native send failed'));
        if (ending === 'native-stop' || ending === 'native-error') {
            f.handle.outcome.resolve({ status: ending === 'native-stop' ? 'stopped' : 'error', finalText: null, partialText: 'AB' });
        }
        await f.terminal(f.row.sessionId, 1);
        const snapshot = f.store.snapshot(f.row.sessionId);
        const item = snapshot.items.find(entry => entry.itemId === before.itemId)!;
        const failed = ['exit', 'rejection', 'native-error'].includes(ending);
        assert.equal(item.text, 'AB');
        assert.equal(item.firstSequence, before.firstSequence);
        assert.equal(item.status, failed ? 'error' : 'cancelled');
        assert.equal(f.store.readTurn(f.row.sessionId, prompt.clientTurnKey)?.status, failed ? 'failed' : 'cancelled');
        const terminalKind = failed ? 'turn_failed' : 'turn_cancelled';
        assert.equal(f.events.filter(event => event.item?.kind === terminalKind).length, 1);
        assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
        let replayText = '';
        for (const event of f.store.readEvents(f.row.sessionId).events) {
            if (event.item?.itemId === item.itemId) replayText = event.item.text ?? '';
            if (event.update?.itemId === item.itemId) replayText += event.update.appendText ?? '';
        }
        assert.equal(replayText, 'AB');
        assert.equal(f.store.history(f.row.sessionId).items.find(entry => entry.itemId === item.itemId)?.text, 'AB');
        const sequence = snapshot.sequence;
        f.observer.text('message', 'answer', 'C', 'append', 'final');
        f.observer.close({ kind: 'turn-end', status: 'done', finalText: 'ABC' });
        f.options.onNativeCursor('late-cursor', f.context);
        assert.equal(f.options.record(f.context, { kind: 'usage', inputTokens: 1 }), null);
        t.mock.timers.tick(1000);
        assert.equal(f.store.snapshot(f.row.sessionId).sequence, sequence);
        assert.equal(f.store.readRecord(f.row.sessionId)?.nativeCursor, 'private-native-cursor');
        assert.equal(f.handle.closes, 1);
    });
}

test('RT01: Stop drains reasoning, child/tool content and empty replacements without changing finished tools', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await streamingFixture(t);
    f.observer.tool('parent', { name: 'Agent' }, {});
    const parent = f.options.resolveTranscriptParent(f.context, 'parent');
    assert.ok(parent);
    const child = f.options.transcript({ ...f.context, parentItemId: parent });
    child.text('message', 'child', 'child', 'replace', 'unknown');
    child.text('message', 'child', ' suffix', 'append', 'unknown');
    f.observer.text('reasoning', 'thought', 'think', 'replace', 'unknown');
    f.observer.text('reasoning', 'thought', ' more', 'append', 'unknown');
    f.observer.tool('running', { name: 'Read', output: 'out' }, {});
    f.observer.tool('running', { delta: 'put' }, {});
    f.observer.tool('finished', { name: 'done-tool', status: 'done', output: 'done' }, {});
    f.observer.text('message', 'empty', 'old', 'replace', 'unknown');
    f.observer.text('message', 'empty', '', 'replace', 'final');
    await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
    const items = f.store.snapshot(f.row.sessionId).items;
    const childItem = items.find(item => item.parentItemId === parent)!;
    assert.equal(childItem.text, 'child suffix'); assert.equal(childItem.status, 'cancelled');
    assert.equal(items.find(item => item.kind === 'reasoning')?.text, 'think more');
    assert.equal(items.find(item => item.tool?.name === 'Read')?.tool?.output, 'output');
    assert.equal(items.find(item => item.tool?.name === 'Read')?.status, 'cancelled');
    assert.equal(items.find(item => item.tool?.name === 'done-tool')?.status, 'done');
    const empty = items.find(item => item.kind === 'assistant_message' && !item.parentItemId)!;
    assert.equal(empty.text, ''); assert.equal(empty.phase, 'final');
    assert.equal(items.filter(item => item.kind === 'assistant_message').length, 2);
});

test('RT01: drain and stopping publication cannot admit callbacks, grants or a timer flush', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let inspect: ((event: CodeWireEvent) => void) | undefined;
    const f = await streamingFixture(t, { publish: event => inspect?.(event) });
    const request = approval(f.options);
    f.observer.text('message', 'first', 'A', 'replace', 'final');
    f.observer.text('message', 'first', 'B', 'append', 'final');
    f.observer.text('message', 'second', 'X', 'replace', 'final');
    f.observer.text('message', 'second', 'Y', 'append', 'final');
    const observations: Array<{ stage: string; current: boolean; record: unknown; request: unknown; permission: string }> = [];
    inspect = event => {
        const stage = event.update?.appendText === 'B' ? 'drain' : event.session?.status === 'stopping' ? 'stopping' : '';
        if (!stage) return;
        f.observer.text('message', 'first', 'LATE', 'append', 'final');
        f.observer.tool('late-tool', { output: 'LATE' }, {});
        f.observer.close({ kind: 'turn-end', status: 'done', finalText: 'LATE' });
        f.options.onNativeCursor('late-cursor', f.context);
        let permission = 'accepted';
        try { f.manager.answerPermission(request.requestId, { sessionId: f.row.sessionId,
            turnId: f.receipt.turnId, epoch: 1, optionId: 'allow' }); }
        catch (error) { permission = error instanceof CodeStoreError ? error.code : 'unexpected'; }
        observations.push({ stage, current: f.context.isCurrent(),
            record: f.options.record(f.context, { kind: 'usage', inputTokens: 1 }),
            request: f.options.record(f.context, { kind: 'request', requestId: 'late-request',
                requestType: 'approval', view: request.view }), permission });
        t.mock.timers.tick(100);
    };
    await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
    inspect = undefined;
    assert.deepEqual(observations, ['drain', 'stopping'].map(stage => ({ stage,
        current: false, record: null, request: null, permission: 'request_not_current' })));
    assert.deepEqual(await request.answer, { optionId: null });
    const snapshot = f.store.snapshot(f.row.sessionId);
    assert.deepEqual(snapshot.items.filter(item => item.kind === 'assistant_message').map(item => item.text), ['AB', 'XY']);
    assert.equal(JSON.stringify(snapshot).includes('LATE'), false);
    assert.equal(f.store.readRecord(f.row.sessionId)?.nativeCursor, 'private-native-cursor');
});

for (const trigger of ['timer', 'native-final'] as const) {
    test(`RT01: reentrant Stop during ${trigger} publication drains only the remaining pending items`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let inspect: ((event: CodeWireEvent) => void) | undefined;
        const f = await streamingFixture(t, { publish: event => inspect?.(event) });
        for (const [ref, first, suffix] of [['first', 'A', 'B'], ['second', 'X', 'Y']] as const) {
            f.observer.text('message', ref, first, 'replace', 'final');
            f.observer.text('message', ref, suffix, 'append', 'final');
        }
        let cancellation: Promise<unknown> | undefined;
        inspect = event => {
            if (event.update?.appendText !== 'B') return;
            inspect = undefined;
            cancellation = f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
        };
        if (trigger === 'timer') t.mock.timers.tick(50);
        else f.handle.outcome.resolve({ ...done, finalText: 'ABXY' });
        await f.terminal(f.row.sessionId, 1);
        assert.ok(cancellation); await cancellation;
        const snapshot = f.store.snapshot(f.row.sessionId);
        assert.deepEqual(snapshot.items.filter(item => item.kind === 'assistant_message').map(item => item.text), ['AB', 'XY']);
        for (const suffix of ['B', 'Y']) assert.equal(f.events.filter(event => event.update?.appendText === suffix).length, 1);
        assert.equal(f.events.some(event => event.update && event.update.appendText === undefined
            && event.update.appendToolOutput === undefined && event.update.status === undefined && event.update.phase === undefined), false);
        assert.equal(f.events.filter(event => event.item?.kind === 'turn_cancelled').length, 1);
        assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
        const sequence = snapshot.sequence; t.mock.timers.tick(1000);
        assert.equal(f.store.snapshot(f.row.sessionId).sequence, sequence);
    });
}

test('RT01: each drain item rechecks DB ownership after reentrant recovery and successor admission', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let revoke: ((event: CodeWireEvent) => void) | undefined;
    const f = await streamingFixture(t, { publish: event => revoke?.(event) });
    for (const [ref, first, suffix] of [['first', 'A', 'B'], ['second', 'X', 'Y']] as const) {
        f.observer.text('message', ref, first, 'replace', 'final');
        f.observer.text('message', ref, suffix, 'append', 'final');
    }
    // Deliberate store-owner revocation, not an HTTP takeover of a busy session.
    const otherStore = new CodeStore(f.db);
    let successor: string | undefined;
    revoke = event => {
        if (event.update?.appendText !== 'B') return;
        revoke = undefined;
        otherStore.recoverInterrupted();
        successor = otherStore.admitTurn({ sessionId: f.row.sessionId, text: 'new owner', clientTurnKey: 'successor' }).receipt.turnId;
    };
    await assert.rejects(f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 }), errorCode('stale_owner'));
    await f.manager.dispose();
    assert.ok(successor);
    assert.equal(f.store.readRecord(f.row.sessionId)?.turnId, successor);
    const items = f.store.snapshot(f.row.sessionId).items.filter(item => item.kind === 'assistant_message');
    assert.deepEqual(items.map(item => item.text), ['AB', 'X']);
    assert.equal(f.events.some(event => event.update?.appendText === 'Y'), false);
    assert.equal(f.store.readTurn(f.row.sessionId, 'successor')?.status, 'accepted');
});

for (const fault of ['first-write', 'later-write', 'later-read'] as const) {
    test(`RT01: ${fault} failure stops the detached batch without retrying content`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let inject: ((event: CodeWireEvent) => void) | undefined;
        const f = await streamingFixture(t, { publish: event => inject?.(event) });
        for (const [ref, first, suffix] of [['first', 'A', 'B'], ['second', 'X', 'Y']] as const) {
            f.observer.text('message', ref, first, 'replace', 'final');
            f.observer.text('message', ref, suffix, 'append', 'final');
        }
        const rejectAppend = () => f.db.exec(`CREATE TEMP TRIGGER fail_drain BEFORE INSERT ON code_events
            WHEN json_extract(NEW.event_json, '$.update.appendText') IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'drain storage failure'); END`);
        const read = f.store.readRecord.bind(f.store);
        const commit = f.store.commitItem.bind(f.store);
        const attempts = t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => commit(...args));
        let failRead = false, failures = 0;
        const faultRead = t.mock.method(f.store, 'readRecord', (id: string) => {
            if (failRead) { failRead = false; failures++; throw new Error('owner read failed'); }
            return read(id);
        });
        if (fault === 'first-write') rejectAppend();
        else inject = event => {
            if (event.update?.appendText !== 'B') return;
            inject = undefined;
            if (fault === 'later-write') rejectAppend(); else failRead = true;
        };
        await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
        faultRead.mock.restore();
        assert.equal(attempts.mock.callCount(), fault === 'later-write' ? 2 : 1);
        attempts.mock.restore();
        const snapshot = f.store.snapshot(f.row.sessionId);
        assert.equal(snapshot.session.status, 'failed');
        assert.equal(snapshot.session.error?.code, 'persistence_failed');
        assert.deepEqual(snapshot.items.filter(item => item.kind === 'assistant_message').map(item => item.text),
            fault === 'first-write' ? ['A', 'X'] : ['AB', 'X']);
        if (fault === 'later-read') assert.equal(failures, 1);
        assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
        assert.equal(f.handle.closes, 1);
        const sequence = snapshot.sequence; t.mock.timers.tick(1000);
        assert.equal(f.store.snapshot(f.row.sessionId).sequence, sequence);
    });
}

for (const budget of ['event', 'turn'] as const) {
    test(`RT01: drain ${budget} quota failure uses no terminal reserve for pending content`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = await streamingFixture(t, { storeLimits: budget === 'event'
            ? { maxEventBytes: 4096, maxTurnEventBytes: 65536 }
            : { maxEventBytes: 16384, maxTurnEventBytes: 8192 } });
        f.observer.text('message', 'large', 'A', 'replace', 'final');
        f.observer.text('message', 'large', 'z'.repeat(12000), 'replace', 'final');
        f.observer.text('message', 'remaining', 'X', 'replace', 'final');
        f.observer.text('message', 'remaining', 'Y', 'append', 'final');
        const commit = f.store.commitItem.bind(f.store);
        const writes = t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => commit(...args));
        await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
        assert.equal(writes.mock.callCount(), 1, 'failed pending content is never retried by interrupt/finish');
        writes.mock.restore();
        const failed = f.store.snapshot(f.row.sessionId);
        assert.equal(failed.session.error?.code, 'transcript_limit');
        assert.equal(f.store.readTurn(f.row.sessionId, prompt.clientTurnKey)?.status, 'failed');
        assert.deepEqual(failed.items.filter(item => item.kind === 'assistant_message').map(item => item.text), ['A', 'X']);
        assert.equal(f.events.filter(event => event.item?.kind === 'turn_failed').length, 1);
        f.manager.prompt(f.row.sessionId, { text: 'small follow-up', clientTurnKey: 'after-drain-quota' });
        const options = await f.providers['codex-app'].opened(1);
        const next = f.providers['codex-app'].handles[1]!;
        await next.sent.promise;
        assert.equal(options.nativeCursor, 'private-native-cursor');
        f.observer.text('message', 'large', 'LATE', 'append', 'final');
        next.outcome.resolve(done);
        await f.terminal(f.row.sessionId, 2);
        assert.equal(f.store.readTurn(f.row.sessionId, 'after-drain-quota')?.status, 'completed');
        assert.equal(JSON.stringify(f.store.snapshot(f.row.sessionId)).includes('LATE'), false);
    });
}

test('RT01: session dispose caches its promise before a drain subscriber disposes again', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    const row = f.create();
    const admitted = f.store.admitTurn({ sessionId: row.sessionId, ...prompt });
    let reentrant: Promise<void> | undefined;
    const session = new CodeSession({ sessionId: row.sessionId, store: f.store, provider: f.providers['codex-app'],
        now: Date.now, changed() {}, publish(event) {
            if (event.update?.appendText === 'B') reentrant = session.dispose();
        } });
    t.after(() => session.dispose());
    session.start(f.store.readRecord(row.sessionId)!, prompt.text);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const observer = options.transcript(options.getTurnContext());
    const permission = approval(options);
    observer.text('message', 'answer', 'A', 'replace', 'final');
    observer.text('message', 'answer', 'B', 'append', 'final');
    const disposal = session.dispose();
    assert.equal(reentrant, disposal);
    await disposal;
    assert.deepEqual(await permission.answer, { optionId: null });
    assert.equal(f.store.snapshot(row.sessionId).items.find(item => item.kind === 'assistant_message')?.text, 'AB');
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.turnId, admitted.receipt.turnId);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.equal(handle.closes, 1);
});

test('context usage answers for the live runtime only, and never outlives it', async t => {
    const f = fixture(t);
    const row = f.create('codex-app');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.contextUsage, undefined,
        'nothing reported means nothing to say, not zero');
    options.onContextUsage({ totalTokens: 345, inputTokens: 300, cachedInputTokens: 100,
        outputTokens: 40, reasoningOutputTokens: 5, modelContextWindow: 272000, updatedAt: 7 });
    const listed = f.manager.list().find(entry => entry.sessionId === row.sessionId)?.contextUsage;
    assert.equal(listed?.totalTokens, 345);
    assert.equal(listed?.modelContextWindow, 272000);
    assert.equal(f.manager.snapshot(row.sessionId).session.contextUsage?.totalTokens, 345);
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    // The process that measured this is gone. Its last figure is history, not
    // the current size of anything, so it is not reported as if it still held.
    options.onExit(null);
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.contextUsage, undefined);
});

test('retiring a runtime retires its context figure, not just an explicit exit', async t => {
    const f = fixture(t);
    const row = f.create('codex-app');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    options.onContextUsage({ totalTokens: 400_000, inputTokens: null, cachedInputTokens: null,
        outputTokens: null, reasoningOutputTokens: null, processedTokens: null,
        modelContextWindow: 1_000_000, updatedAt: 7 });
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.contextUsage?.totalTokens, 400_000);
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    // Disposal never reaches onExit's clear, because it retires the binding
    // first. Leaving the figure would report 400k against a window belonging to
    // a model that is no longer selected, for a runtime that is gone.
    await f.manager.deleteSession?.(row.sessionId).catch(() => {});
    const service = (f.manager as unknown as { sessions: Map<string, { dispose(): Promise<void> }> }).sessions.get(row.sessionId);
    await service?.dispose();
    assert.equal(f.manager.list().find(entry => entry.sessionId === row.sessionId)?.contextUsage, undefined);
});

// ─── Claude permission modes switch the resident query instead of restarting it ───

function claudeModes(f: ReturnType<typeof fixture>) {
    f.providers.claude.catalog.capabilities.permissionModes = ['ask', 'accept-edits', 'plan', 'auto-review', 'dont-ask', 'auto'];
}
function switchable(handle: object) {
    const modes: string[] = [];
    let fail = false;
    Object.assign(handle, { async setPermissionMode(mode: string) { if (fail) throw new Error('switch_failed'); modes.push(mode); } });
    return { modes, failNext() { fail = true; } };
}

test('Claude permission-only patch switches the idle resident runtime in place', async t => {
    const f = fixture(t); claudeModes(f);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    const sw = switchable(handle);
    await handle.sent.promise; handle.outcome.resolve(done); await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'plan' });
    assert.equal(patched.permissionMode, 'plan');
    assert.deepEqual(sw.modes, ['plan']);
    assert.equal(handle.closes, 0, 'no restart for a permission-only change');
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    assert.equal(f.providers.claude.calls.length, 1, 'the next prompt reuses the same runtime');
});

test('Claude permission-only patch with no live runtime is stored and applied on the next open', async t => {
    const f = fixture(t); claudeModes(f);
    const row = f.create('claude');
    await f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'auto-review' });
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    assert.equal(options.permissionMode, 'auto-review');
});

test('Claude permission patch is refused while busy and restores the runtime when persistence fails', async t => {
    const f = fixture(t); claudeModes(f);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    const sw = switchable(handle);
    await handle.sent.promise;
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'plan' }), errorCode('session_busy'));
    assert.deepEqual(sw.modes, [], 'no SDK call while a turn runs');
    handle.outcome.resolve(done); await f.terminal(row.sessionId, 1);
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 99, permissionMode: 'plan' }), errorCode('revision_conflict'));
    assert.deepEqual(sw.modes, ['plan', 'ask'], 'the stored mode is put back on the runtime');
    assert.equal(handle.closes, 0);
});

test('a newly chosen Claude mode must be in the live catalog; other providers keep both-list rules', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'plan' }), errorCode('unsupported_policy'));
    claudeModes(f);
    await assert.doesNotReject(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'plan' }));
    const codex = f.create('codex-app');
    await assert.rejects(f.manager.patch(codex.sessionId, { expectedRevision: 0, permissionMode: 'plan' }), errorCode('unsupported_policy'));
});

// ─── Claude model and effort switch the resident query too; thinking reopens ───

function liveTunable(handle: object) {
    const calls: Array<{ next: unknown; previous: unknown }> = [];
    const failures = new Set<number>();
    const entered = deferred<void>();
    let gate: Promise<void> | null = null;
    let count = 0;
    Object.assign(handle, { async reconfigure(next: unknown, previous: unknown) {
        const call = ++count;
        entered.resolve();
        await gate;
        if (failures.delete(call)) throw new Error('reconfigure_failed');
        calls.push({ next, previous });
    } });
    return { calls, entered: entered.promise, fail(call = count + 1) { failures.add(call); },
        hold(promise: Promise<void>) { gate = promise; } };
}

async function idleClaude(f: ReturnType<typeof fixture>) {
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    const live = liveTunable(handle);
    await handle.sent.promise; handle.outcome.resolve(done); await f.terminal(row.sessionId, 1);
    return { row, options, handle, live };
}

const usageOf = (f: ReturnType<typeof fixture>, id: string) => f.manager.list().find(entry => entry.sessionId === id)?.contextUsage;

test('Claude sessions default thinking on; other providers refuse the switch', async t => {
    const f = fixture(t);
    assert.equal(f.create('claude').thinking, true);
    assert.equal(f.create('claude', { thinking: false }).thinking, false);
    assert.equal(f.create('codex-app').thinking, null);
    assert.throws(() => f.create('codex-app', { thinking: true }), errorCode('unsupported_capability'));
    const codex = f.create('cursor');
    await assert.rejects(f.manager.patch(codex.sessionId, { expectedRevision: 0, thinking: false }), errorCode('unsupported_capability'));
});

test('Claude model and effort patch reconfigures the idle runtime without a restart', async t => {
    const f = fixture(t);
    const { row, options, handle, live } = await idleClaude(f);
    assert.equal(options.thinking, true, 'the stored switch reaches the open');
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b', effort: 'high', thinking: true });
    assert.equal(patched.model, 'model-b');
    assert.equal(patched.effort, 'high');
    assert.deepEqual(live.calls, [{ next: { model: 'model-b', effort: 'high' }, previous: { model: 'model-a', effort: 'low' } }]);
    assert.equal(handle.closes, 0, 'no restart for a live change');
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    assert.equal(f.providers.claude.calls.length, 1, 'the next prompt reuses the same runtime');
});

test('a Claude thinking change, alone or with effort, retires the runtime without a live call', async t => {
    const f = fixture(t);
    const { row, handle, live } = await idleClaude(f);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, thinking: false });
    assert.equal(patched.thinking, false);
    assert.deepEqual(live.calls, [], 'thinking is fixed at open');
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readRecord(row.sessionId)?.thinking, false);
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' });
    assert.equal((await f.providers.claude.opened(1)).thinking, false, 'the next turn opens with the stored switch');
    const reopened = f.providers.claude.handles[1]!;
    const second = liveTunable(reopened);
    await reopened.sent.promise; reopened.outcome.resolve(done);
    await f.terminal(row.sessionId, f.store.readRecord(row.sessionId)!.epoch);
    const mixed = await f.manager.patch(row.sessionId, { expectedRevision: f.store.readRecord(row.sessionId)!.revision,
        effort: 'high', thinking: true });
    assert.equal(mixed.effort, 'high');
    assert.equal(mixed.thinking, true);
    assert.deepEqual(second.calls, [], 'an effort change riding with thinking is not switched live');
    assert.equal(reopened.closes, 1);
});

test('a Claude permission plus model change disposes instead of switching live', async t => {
    const f = fixture(t); claudeModes(f);
    const { row, handle, live } = await idleClaude(f);
    const sw = switchable(handle);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b', permissionMode: 'plan' });
    assert.equal(patched.model, 'model-b');
    assert.equal(patched.permissionMode, 'plan');
    assert.deepEqual(live.calls, []);
    assert.deepEqual(sw.modes, []);
    assert.equal(handle.closes, 1);
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' });
    const reopened = await f.providers.claude.opened(1);
    assert.equal(reopened.model, 'model-b');
    assert.equal(reopened.permissionMode, 'plan');
});

test('a live Claude handle without reconfigure falls back to retiring the runtime', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise; handle.outcome.resolve(done); await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
    assert.equal(patched.model, 'model-b');
    assert.equal(handle.closes, 1);
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' });
    assert.equal((await f.providers.claude.opened(1)).model, 'model-b');
});

test('a refused Claude reconfigure is reported and leaves the stored row unchanged', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    const live = liveTunable(handle);
    await handle.sent.promise;
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' }), errorCode('session_busy'));
    assert.deepEqual(live.calls, [], 'no SDK call while a turn runs');
    handle.outcome.resolve(done); await f.terminal(row.sessionId, 1);
    live.fail();
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' }), /reconfigure_failed/);
    assert.equal(f.store.readRecord(row.sessionId)?.model, 'model-a');
    assert.equal(handle.closes, 0);
});

test('a failed store write puts the Claude model back; a failed rollback retires the runtime', async t => {
    const f = fixture(t);
    const { row, handle, live } = await idleClaude(f);
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 99, model: 'model-b' }), errorCode('revision_conflict'));
    assert.deepEqual(live.calls.map(call => call.next), [{ model: 'model-b', effort: 'low' }, { model: 'model-a', effort: 'low' }]);
    assert.equal(handle.closes, 0);
    live.fail(live.calls.length + 2);
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 99, effort: 'high' }), errorCode('revision_conflict'));
    assert.equal(handle.closes, 1, 'the runtime no longer matches the stored row, so it is retired');
    assert.equal(f.store.readRecord(row.sessionId)?.effort, 'low');
});

test('a prompt during an in-flight Claude reconfigure is refused and the switch completes', async t => {
    const f = fixture(t);
    const { row, handle, live } = await idleClaude(f);
    const gate = deferred<void>();
    live.hold(gate.promise);
    const patching = f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
    await live.entered;
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'second-key' }), errorCode('session_busy', 409));
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, effort: 'high' }), errorCode('session_busy', 409));
    await assert.rejects(f.manager.attach(row.sessionId), errorCode('session_busy', 409));
    gate.resolve();
    const patched = await patching;
    assert.equal(patched.model, 'model-b');
    assert.equal(handle.sends.length, 1, 'the refused prompt never reached the runtime');
    assert.equal(handle.closes, 0);
    assert.equal(f.store.readTurn(row.sessionId, 'second-key'), null);
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'third-key' });
    await handle.waitSent(1);
    assert.equal(f.providers.claude.calls.length, 1, 'the next prompt reuses the switched runtime');
});

test('a live Claude model switch drops the context figure; an effort switch keeps it', async t => {
    const f = fixture(t);
    const { row, options, live } = await idleClaude(f);
    const report = () => options.onContextUsage({ totalTokens: 900, inputTokens: null, cachedInputTokens: null,
        outputTokens: null, reasoningOutputTokens: null, processedTokens: null, modelContextWindow: 200_000, updatedAt: 3 });
    report();
    assert.equal(usageOf(f, row.sessionId)?.totalTokens, 900);
    const effort = await f.manager.patch(row.sessionId, { expectedRevision: 0, effort: 'high' });
    assert.equal(usageOf(f, row.sessionId)?.totalTokens, 900, 'the window still belongs to the same model');
    await f.manager.patch(row.sessionId, { expectedRevision: effort.revision, model: 'model-b' });
    assert.equal(usageOf(f, row.sessionId), undefined);
    report();
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-a' }), errorCode('revision_conflict'));
    assert.equal(live.calls.length, 4, 'switched to model-a and back to model-b');
    assert.equal(usageOf(f, row.sessionId), undefined, 'the rollback is a model change too');
});

test('with no live Claude runtime a thinking change is stored and read by the next open', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    await f.manager.patch(row.sessionId, { expectedRevision: 0, thinking: false });
    f.manager.prompt(row.sessionId, prompt);
    assert.equal((await f.providers.claude.opened()).thinking, false);
});

// Code in-band follow-ups (Claude only).
class SteerHandle extends NativeHandle {
    readonly steers: string[] = [];
    steerResult: Awaited<ReturnType<NonNullable<CodeProviderSession['steer']>>> | Error = { accepted: true, turnId: 'native-turn', nativeId: 'native-follow' };
    steerGate: Promise<void> | null = null;
    unconsumed: string[] = [];
    async steer(text: string) {
        this.steers.push(text);
        await this.steerGate;
        if (this.steerResult instanceof Error) throw this.steerResult;
        return this.steerResult;
    }
    unconsumedFollowUps(): readonly string[] { return this.unconsumed; }
}
async function runningClaude(t: TestContext, handle: NativeHandle = new SteerHandle()) {
    const f = fixture(t);
    f.providers.claude.handles[0] = handle;
    const row = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await handle.sent.promise;
    const follow = (key: string, text = 'also check the tests', patch: Partial<{ turnId: string; epoch: number }> = {}) =>
        f.manager.steer(row.sessionId, { text, clientTurnKey: key, turnId: receipt.turnId, epoch: 1, ...patch });
    return { ...f, row, receipt, handle, follow };
}
const userItems = (f: { manager: CodeSessionManager }, id: string) =>
    f.manager.snapshot(id).items.filter(item => item.kind === 'user_message');

test('a follow-up joins the running Claude turn once and replays its receipt after the turn ends', async t => {
    const f = await runningClaude(t);
    const handle = f.handle as SteerHandle;
    const admitted = await f.follow('steer-1');
    assert.equal(admitted.duplicate, false);
    assert.deepEqual({ turnId: admitted.receipt.turnId, key: admitted.receipt.clientTurnKey, status: admitted.receipt.status },
        { turnId: f.receipt.turnId, key: 'steer-1', status: 'running' });
    assert.deepEqual(handle.steers, ['also check the tests']);
    assert.deepEqual(handle.sends, ['hello'], 'a follow-up never starts another native send');
    const session = f.manager.snapshot(f.row.sessionId).session;
    assert.deepEqual({ epoch: session.epoch, turnId: session.turnId, status: session.status }, { epoch: 1, turnId: f.receipt.turnId, status: 'streaming' });
    assert.deepEqual(userItems(f, f.row.sessionId).map(item => [item.turnId, item.clientTurnKey, item.status]),
        [[f.receipt.turnId, 'key-one', 'done'], [f.receipt.turnId, 'steer-1', 'done']]);
    await assert.rejects(f.follow('steer-2'), errorCode('steer_queue_full', 409));
    assert.equal(handle.steers.length, 1, 'the durable quota refuses before any native offer');
    const again = await f.follow('steer-1');
    assert.deepEqual(again, { receipt: admitted.receipt, duplicate: true });
    handle.outcome.resolve(done);
    await f.terminal(f.row.sessionId, 1);
    const replay = await f.follow('steer-1');
    assert.deepEqual(replay, { receipt: { ...admitted.receipt, status: 'completed' }, duplicate: true });
    assert.equal(handle.steers.length, 1);
    const snapshot = f.manager.snapshot(f.row.sessionId);
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_completed').length, 1);
    assert.equal(snapshot.items.find(item => item.clientTurnKey === 'steer-1')?.phase, undefined);
});

test('a native queue-full refusal is a 409 that spends the key, adds no transcript item and never interrupts', async t => {
    const f = await runningClaude(t);
    const handle = f.handle as SteerHandle;
    handle.steerResult = { accepted: false, turnId: 'native-turn', reason: 'queue-full' };
    await assert.rejects(f.follow('steer-1'), errorCode('steer_queue_full', 409));
    assert.equal(userItems(f, f.row.sessionId).length, 1);
    assert.deepEqual({ cancel: handle.cancellations, close: handle.closes }, { cancel: 0, close: 0 });
    assert.equal(f.manager.snapshot(f.row.sessionId).session.status, 'streaming');
    await assert.rejects(f.follow('steer-1'), errorCode('steer_key_spent', 409));
    handle.steerResult = { accepted: false, turnId: 'native-turn', reason: 'not-ready' };
    await assert.rejects(f.follow('steer-2'), errorCode('session_not_steerable', 409));
    handle.steerResult = { accepted: false, turnId: 'native-turn', reason: 'not-current' };
    await assert.rejects(f.follow('steer-3'), errorCode('stale_owner', 409));
    handle.steerResult = new Error('claude_prompt_limit');
    await assert.rejects(f.follow('steer-4'), errorCode('session_not_steerable', 409));
    assert.equal(handle.steers.length, 4);
    assert.equal(f.manager.list()[0]?.sessionId, f.row.sessionId, 'expected refusals never poison the session');
    handle.steerResult = { accepted: true, turnId: 'native-turn', nativeId: 'native-follow' };
    assert.equal((await f.follow('steer-5')).duplicate, false, 'a refused offer left the slot free');
    handle.outcome.resolve(done);
    await f.terminal(f.row.sessionId, 1);
});

test('stale owners, starting turns, slash commands and other runtimes never reach native steer', async t => {
    const f = await runningClaude(t);
    const handle = f.handle as SteerHandle;
    await assert.rejects(f.follow('s1', 'x', { epoch: 2 }), errorCode('stale_owner', 409));
    await assert.rejects(f.follow('s2', 'x', { turnId: 'other-turn' }), errorCode('stale_owner', 409));
    const session = f.manager['sessions'].get(f.row.sessionId)!;
    await assert.rejects(session.steer({ text: ' /compact', clientTurnKey: 's3', turnId: f.receipt.turnId, epoch: 1 }),
        errorCode('steer_command_unsupported', 400));
    const codex = f.create('codex-app');
    await assert.rejects(f.manager.steer(codex.sessionId, { text: 'x', clientTurnKey: 's4', turnId: 't', epoch: 0 }),
        errorCode('unsupported_capability', 400));
    const starting = f.create('claude');
    const gate = deferred<void>();
    f.providers.claude.gate = gate.promise;
    const second = f.manager.prompt(starting.sessionId, { text: 'hi', clientTurnKey: 'k2' });
    await assert.rejects(f.manager.steer(starting.sessionId, { text: 'x', clientTurnKey: 's5', turnId: second.receipt.turnId, epoch: 1 }),
        errorCode('session_not_steerable', 409));
    assert.deepEqual(handle.steers, []);
    gate.resolve();
    handle.outcome.resolve(done);
    await f.terminal(f.row.sessionId, 1);
    await assert.rejects(f.follow('s6'), errorCode('stale_owner', 409), 'an idle session has no turn to follow');
    await f.providers.claude.handles[1]!.sent.promise;
    f.providers.claude.handles[1]!.outcome.resolve(done);
    await f.terminal(starting.sessionId, 1);
});

test('a runtime without the optional steer answers unsupported_capability with no native input', async t => {
    const plain = new NativeHandle();
    const f = await runningClaude(t, plain);
    await assert.rejects(f.follow('steer-1'), errorCode('unsupported_capability', 400));
    assert.equal(userItems(f, f.row.sessionId).length, 1);
    await assert.rejects(f.follow('steer-1'), errorCode('steer_key_spent', 409));
    plain.outcome.resolve(done);
    await f.terminal(f.row.sessionId, 1);
});

test('a turn with no live owner answers orphaned_turn', async t => {
    const f = await runningClaude(t);
    const orphan = new CodeSessionManager({ store: f.store, providers: f.providers, publish() {} });
    t.after(() => orphan.dispose());
    await assert.rejects(orphan.steer(f.row.sessionId, { text: 'x', clientTurnKey: 's', turnId: f.receipt.turnId, epoch: 1 }),
        errorCode('orphaned_turn', 503));
    (f.handle as SteerHandle).outcome.resolve(done);
    await f.terminal(f.row.sessionId, 1);
});

test('Stop before the runtime consumed a follow-up leaves its item delivery unconfirmed; a consumed one stays plain', async t => {
    const f = await runningClaude(t);
    const handle = f.handle as SteerHandle;
    await f.follow('steer-1');
    handle.unconsumed = ['native-follow'];
    await f.manager.cancel(f.row.sessionId, { turnId: f.receipt.turnId, epoch: 1 });
    const stopped = f.manager.snapshot(f.row.sessionId);
    assert.equal(stopped.items.find(item => item.clientTurnKey === 'steer-1')?.phase, 'unknown');
    assert.equal(stopped.items.find(item => item.clientTurnKey === 'steer-1')?.status, 'done');
    assert.equal(stopped.items.filter(item => item.kind === 'turn_cancelled').length, 1);

    const g = await runningClaude(t);
    await g.follow('steer-1');
    (g.handle as SteerHandle).unconsumed = [];
    await g.manager.cancel(g.row.sessionId, { turnId: g.receipt.turnId, epoch: 1 });
    assert.equal(g.manager.snapshot(g.row.sessionId).items.find(item => item.clientTurnKey === 'steer-1')?.phase, undefined,
        'a follow-up folded before Stop was consumed');
});

test('a failure after native acceptance is an unknown outcome that is never replayed as unsent', async t => {
    const f = await runningClaude(t);
    const commit = f.store.commitSteer.bind(f.store);
    f.store.commitSteer = () => { throw new Error('disk full'); };
    await assert.rejects(f.follow('steer-1'), errorCode('steer_outcome_unknown', 503));
    f.store.commitSteer = commit;
    assert.equal(f.db.prepare("SELECT status FROM code_steers WHERE client_turn_key = 'steer-1'").pluck().get(), 'unknown');
    await f.terminal(f.row.sessionId, 1);
    assert.equal(f.handle.cancellations + f.handle.closes > 0, true, 'unrecorded text cannot keep running');
    const settled = f.manager.snapshot(f.row.sessionId);
    assert.equal(settled.session.status, 'failed');
    assert.equal(userItems(f, f.row.sessionId).length, 1);
    await assert.rejects(f.follow('steer-1'), errorCode('steer_outcome_unknown', 503));

    // Stop that lands while the offer is in flight: the outcome is unknown, the session is not poisoned.
    const g = await runningClaude(t);
    const handle = g.handle as SteerHandle;
    const gate = deferred<void>();
    handle.steerGate = gate.promise;
    const pending = g.follow('steer-1');
    await yieldEventLoop();
    const stopping = g.manager.cancel(g.row.sessionId, { turnId: g.receipt.turnId, epoch: 1 });
    gate.resolve();
    await assert.rejects(pending, errorCode('steer_outcome_unknown', 503));
    await stopping;
    assert.equal(g.db.prepare("SELECT status FROM code_steers WHERE client_turn_key = 'steer-1'").pluck().get(), 'unknown');
    assert.equal(g.manager.snapshot(g.row.sessionId).session.status, 'idle');
    assert.equal(userItems(g, g.row.sessionId).length, 1);
});
