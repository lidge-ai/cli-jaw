import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    killed = false;
}

class FakePiSession {
    child = new FakeChild();
    sessionId: string | null;
    abortEffective: boolean;
    abortCount = 0;
    killCount = 0;
    closeCount = 0;
    poisoned = false;
    closeGate: Promise<void> | null = null;

    constructor(sessionId: string | null, abortEffective: boolean) {
        this.sessionId = sessionId;
        this.abortEffective = abortEffective;
    }

    get alive(): boolean { return !this.poisoned && !this.child.killed && this.child.exitCode === null; }
    async sendPrompt(message: string): Promise<{ text: string; stderr: string }> {
        if (!this.alive) throw new Error('fixture Pi readiness failed');
        this.sessionId ||= `session-${fakeSessions.length}`;
        return { text: message, stderr: '' };
    }
    async abort(): Promise<void> { this.abortCount += 1; }
    close(): Promise<void> | void {
        this.closeCount += 1;
        if (this.closeGate) return this.closeGate.then(() => { this.die(); });
        this.die();
    }
    kill(): void { this.killCount += 1; this.die(); }
    die(): void {
        if (this.child.exitCode !== null) return;
        this.child.exitCode = 1;
        this.child.killed = true;
        this.child.emit('exit', 1);
    }
}

const fakeSessions: FakePiSession[] = [];
let nextAbortEffective = true;
let nextAbortReject = false;
let lastSpawnOptions: Record<string, unknown> | null = null;
test.afterEach(() => {
    nextAbortEffective = true; nextAbortReject = false;
    for (const session of fakeSessions) session.die();
});

mock.module('../../src/agent/codex-app-client.js', {
    namedExports: {
        CodexAppClient: class {},
        isRecoverableResumeError: () => false,
    },
});
mock.module('../../src/agent/pi-runtime.js', {
    namedExports: {
        normalizePiSettings: (input: unknown) => input,
        spawnPersistentPiRpc: (_profile: unknown, _settings: unknown, options: Record<string, unknown>) => {
            lastSpawnOptions = options;
            const session = new FakePiSession((options['sessionId'] as string | undefined) ?? null, nextAbortEffective);
            if (nextAbortReject) session.abort = async () => { session.abortCount += 1; throw new Error('abort transport failed'); };
            fakeSessions.push(session);
            return session;
        },
    },
});

const { acquirePiRuntime } = await import('../../src/agent/runtime-pool.js');

let sequence = 1;
function options(overrides: Record<string, unknown> = {}) {
    const scopeKey = String(overrides['scopeKey'] ?? `pi-scope-${sequence++}`);
    return {
        key: {
            scopeKey,
            cwd: '/tmp/pi-pool',
            profileId: 'progrok',
            fullEndpoint: String(overrides['fullEndpoint'] ?? 'http://127.0.0.1:18645/v1'),
            apiKind: String(overrides['apiKind'] ?? 'openai-completions'),
            model: String(overrides['model'] ?? 'model-a'),
            effort: String(overrides['effort'] ?? 'medium'),
            profileFp: String(overrides['profileFp'] ?? 'fp-a'),
        },
        piSettings: {
            defaultProfileId: 'progrok',
            profiles: [{ id: 'progrok' }],
        },
        ...(overrides['storedSessionId'] === undefined ? {} : { storedSessionId: overrides['storedSessionId'] }),
        ...(overrides['instructions'] === undefined ? {} : { instructions: String(overrides['instructions']) }),
        ...(overrides['signal'] === undefined ? {} : { signal: overrides['signal'] as AbortSignal }),
    };
}

test('Pi pool reuses a released live runtime', async () => {
    const scopeKey = `reuse-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const session = first.session as unknown as FakePiSession;
    await first.session.sendPrompt('one');
    first.release();
    const second = await acquirePiRuntime(options({ scopeKey, storedSessionId: session.sessionId }));
    assert.equal(second.reused, true);
    assert.equal(second.session.child, first.session.child);
    second.release();
    session.die();
});

test('dead Pi runtime is recreated with stored --session-id resume input', async () => {
    const scopeKey = `dead-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const old = first.session as unknown as FakePiSession;
    await first.session.sendPrompt('one');
    const storedSessionId = old.sessionId;
    first.release();
    old.die();
    const second = await acquirePiRuntime(options({ scopeKey, storedSessionId }));
    assert.notEqual(second.session.child, first.session.child);
    assert.equal(lastSpawnOptions?.['sessionId'], storedSessionId);
    second.release();
    (second.session as unknown as FakePiSession).die();
});

test('Pi key mutations replace endpoint path, api kind, model, effort, and credential fingerprint', async () => {
    const scopeKey = `mutate-${sequence++}`;
    const variants = [
        {},
        { fullEndpoint: 'http://127.0.0.1:18645/v2' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b', effort: 'high' },
        { fullEndpoint: 'http://127.0.0.1:18645/v2', apiKind: 'openai-responses', model: 'model-b', effort: 'high', profileFp: 'fp-rotated' },
    ];
    const children = [];
    for (const variant of variants) {
        const lease = await acquirePiRuntime(options({ scopeKey, ...variant }));
        children.push(lease.session.child);
        lease.release();
    }
    assert.equal(new Set(children).size, variants.length);
    (fakeSessions.at(-1))?.die();
});

test('Pi pool cancellation falls back to kill when abort support is false', async () => {
    nextAbortEffective = false;
    const lease = await acquirePiRuntime(options());
    const session = lease.session as unknown as FakePiSession;
    await lease.cancel();
    assert.equal(session.abortCount, 0);
    assert.equal(session.killCount, 1);
    lease.release();
    nextAbortEffective = true;
});

test('Pi pool cancellation falls back to kill when an effective abort rejects', async () => {
    nextAbortReject = true;
    const lease = await acquirePiRuntime(options());
    const session = lease.session as unknown as FakePiSession;
    await lease.cancel();
    assert.equal(session.abortCount, 1);
    assert.equal(session.killCount, 1);
    lease.release();
    nextAbortReject = false;
});

for (const instructions of [undefined, 'captured instructions']) {
    test(`Pi lease forwards live capability through both getters, instructions=${Boolean(instructions)}`, async () => {
        nextAbortEffective = false;
        const lease = await acquirePiRuntime(options({ instructions }));
        const session = fakeSessions.at(-1)!;
        try {
            assert.equal(lease.session.abortEffective, false); assert.equal(lease.runtime.supportsInterrupt, false);
            session.abortEffective = true;
            assert.equal(lease.session.abortEffective, true, 'instruction wrapper must not freeze false');
            assert.equal(lease.runtime.supportsInterrupt, true, 'runtime wrapper must not freeze false');
            await lease.cancel(); assert.equal(session.abortCount, 1); assert.equal(session.killCount, 0);
            session.abortEffective = false;
            assert.equal(lease.session.abortEffective, false); assert.equal(lease.runtime.supportsInterrupt, false);
            await lease.cancel(); assert.equal(session.abortCount, 1); assert.equal(session.killCount, 1);
        } finally { lease.release(); session.die(); }
    });

    test(`Pi pre-ready cancellation never borrows future abort support, instructions=${Boolean(instructions)}`, async () => {
        nextAbortEffective = false;
        const lease = await acquirePiRuntime(options({ instructions })); const session = fakeSessions.at(-1)!;
        await lease.cancel(); session.abortEffective = true;
        assert.equal(session.abortCount, 0); assert.equal(session.killCount, 1); assert.equal(lease.runtime.alive, false);
        lease.release();
    });

    test(`Pi close forwards an owned Promise and rejection, instructions=${Boolean(instructions)}`, async () => {
        const lease = await acquirePiRuntime(options({ instructions })); const session = fakeSessions.at(-1)!;
        const close = Promise.withResolvers<void>(); session.closeGate = close.promise;
        const result = lease.session.close(); let completed = false;
        const observed = Promise.resolve(result).then(() => { completed = true; });
        const rejected = assert.rejects(observed, /fixture UNCERTIFIED/);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(completed, false); assert.equal(session.closeCount, 1);
        close.reject(new Error('fixture UNCERTIFIED')); await rejected;
        session.die(); lease.release();
    });
}

test('Pi poisoned-but-not-exited session is removed on release and cannot be borrowed again', async () => {
    const scopeKey = `poison-${sequence++}`, opts = options({ scopeKey, instructions: 'wrapped' });
    const first = await acquirePiRuntime(opts); const old = fakeSessions.at(-1)!;
    old.poisoned = true; old.abortEffective = false;
    assert.equal(old.child.exitCode, null, 'no physical exit callback is needed to observe poison');
    assert.equal(first.runtime.alive, false);
    await assert.rejects(first.session.sendPrompt('forbidden'), /readiness failed/);
    first.release();
    const second = await acquirePiRuntime(opts);
    assert.equal(second.reused, false); assert.notEqual(second.session.child, old.child);
    await assert.rejects(first.session.sendPrompt('late retry'), /readiness failed/);
    second.release();
});

test('Pi scope replacement observes rejected asynchronous close without claiming a global drain', async t => {
    const scopeKey = `async-close-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey })); const old = fakeSessions.at(-1)!;
    const close = Promise.withResolvers<void>(); old.closeGate = close.promise;
    const warnings: string[] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
    first.release();
    const second = await acquirePiRuntime(options({ scopeKey, model: 'replacement' }));
    assert.equal(old.closeCount, 1); assert.notEqual(second.session.child, old.child);
    assert.equal(warnings.length, 0, 'a held close is not a rejection yet');
    close.reject(new Error('fixture UNCERTIFIED close'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(warnings.filter(line => line.includes('fixture UNCERTIFIED close')).length, 1);
    assert.equal(second.runtime.alive, true); second.release(); old.die();
});

test('Pi lease retire marks dead, closes, and cannot be reused', async () => {
    const scopeKey = `retire-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const session = first.session as unknown as FakePiSession;
    await first.retire(new Error('test retire'));
    assert.equal(session.closeCount, 1);
    assert.equal(session.alive, false);
    const second = await acquirePiRuntime(options({ scopeKey }));
    assert.equal(second.reused, false);
    assert.notEqual(second.session.child, session.child);
    second.release();
    (second.session as unknown as FakePiSession).die();
});

test('Pi acquire signal aborts waitForEntry without cancelLease or retire', async () => {
    const scopeKey = `signal-${sequence++}`;
    const first = await acquirePiRuntime(options({ scopeKey }));
    const session = first.session as unknown as FakePiSession;
    const ac = new AbortController();
    const pending = acquirePiRuntime(options({ scopeKey, signal: ac.signal }));
    ac.abort();
    await assert.rejects(pending, /runtime pool acquire aborted/);
    assert.equal(session.abortCount, 0);
    assert.equal(session.killCount, 0);
    assert.equal(session.closeCount, 0);
    first.release();
    session.die();
});
