import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import { acquireCursorRuntime, acquireGrokRuntime, poolStats,
    type CursorAcquireOptions } from '../../src/agent/runtime-pool.ts';

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
let sequence = 0;
class Candidate {
    child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
    alive = true; idle = true; nativeSessionId = `candidate-${++sequence}`;
    closes = 0; retires = 0; sends = 0;
    closeGate = deferred(); closeStarted = deferred();
    hold = false;
    retire() { this.retires++; this.alive = false; this.idle = false; }
    close() {
        this.closes++; this.closeStarted.resolve();
        if (this.hold) return this.closeGate.promise;
        this.exit(); return Promise.resolve();
    }
    exit() { this.alive = false; this.child.exitCode = 0; this.child.emit('exit', 0); }
    async cancel() { this.retire(); }
    async prompt() { assert.equal(this.alive, true); this.sends++; }
    get session() { return this as unknown as AcpSession; }
}
function fixture(t: TestContext) {
    const candidates: Candidate[] = [], started = deferred(), gate = deferred<AcpSession>();
    let generation = 0, creations = 0;
    const options: CursorAcquireOptions = {
        key: { scopeKey: `creation-${++sequence}`, cwd: process.cwd(), model: '', effort: '', permissions: 'auto' },
        binary: 'fixture', env: {}, promptTimeoutMs: 1000, waitMs: 1000,
        persistenceOwner: { global: 0, scope: 0 }, isCurrentOwner: owner => owner.global === generation,
        canAcquire: () => true,
        createSession: async () => { creations++; const c = new Candidate(); candidates.push(c); return c.session; },
    };
    const old = new Candidate(); old.hold = true; candidates.push(old);
    const held = { ...options, createSession: async () => { started.resolve(); return gate.promise; } };
    t.after(() => { gate.resolve(old.session); for (const c of candidates) { c.exit(); c.closeGate.resolve(); } });
    return { options, held, old, gate, started, get creations() { return creations; },
        reset: () => { generation++; }, candidates };
}

for (const [engine, acquire] of [['cursor', acquireCursorRuntime], ['grok', acquireGrokRuntime]] as const) {
    for (const trigger of ['abort', 'forceNew', 'generation', 'deadline'] as const) {
        test(`${engine} ${trigger} retains pooled creation before request until late candidate close`, async t => {
            const f = fixture(t), controller = new AbortController();
            if (trigger === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
            const pending = acquire({ ...f.held, signal: controller.signal, waitMs: 100 });
            const rejected = assert.rejects(pending, /aborted|replaced|timed out/);
            await f.started.promise;
            if (trigger === 'abort') controller.abort();
            if (trigger === 'deadline') t.mock.timers.tick(100);
            if (trigger === 'generation') f.reset();
            let admitted = false;
            const next = acquire({ ...f.options, lifetime: 'request', forceNew: trigger === 'forceNew',
                persistenceOwner: { global: trigger === 'generation' ? 1 : 0, scope: 0 } })
                .then(lease => { admitted = true; return lease; });
            await rejected; await checkpoint();
            assert.equal(admitted, false); assert.equal(f.creations, 0);
            f.gate.resolve(f.old.session); await f.old.closeStarted.promise;
            assert.equal(admitted, false); assert.equal(f.old.closes, 1); assert.equal(f.old.sends, 0);
            f.old.closeGate.resolve(); const lease = await next;
            assert.equal(f.creations, 1); assert.equal(lease.retireOnFinish, true); lease.release();
        });
    }

    for (const completion of ['pending-exit', 'reject-exit', 'already-exited', 'sync-throw-exit'] as const) {
        test(`${engine} abandoned candidate ${completion} observes exact exit and detaches its listener`, async t => {
            const f = fixture(t), controller = new AbortController();
            const pending = acquire({ ...f.held, signal: controller.signal });
            const rejected = assert.rejects(pending, /aborted/);
            await f.started.promise; controller.abort(); await rejected;
            if (completion === 'already-exited') f.old.exit();
            if (completion === 'sync-throw-exit') {
                t.mock.method(f.old, 'close', () => { f.old.closes++; f.old.closeStarted.resolve(); throw new Error('fixture'); });
            }
            f.gate.resolve(f.old.session); await f.old.closeStarted.promise;
            if (completion === 'reject-exit') f.old.closeGate.reject(new Error('fixture'));
            let admitted = false;
            const next = acquire(f.options).then(lease => { admitted = true; return lease; });
            await checkpoint();
            if (completion !== 'already-exited') {
                assert.equal(admitted, false); assert.equal(f.old.child.listenerCount('exit'), 1);
                f.old.exit();
            }
            const lease = await next;
            assert.equal(f.old.closes, 1); assert.equal(f.old.retires, 1);
            assert.equal(f.old.child.listenerCount('exit'), 0);
            // A late close settlement cannot remove or close the same-key successor.
            f.old.closeGate.resolve(); await checkpoint();
            assert.equal(lease.runtime.alive, true); lease.release();
            const again = await acquire(f.options); assert.equal(again.session, lease.session); again.release();
        });
    }

    for (const code of ['cursor_acp_startup_cleanup_failed', 'grok_acp_startup_cleanup_failed', 'acp_reap_timeout']) {
        test(`${engine} ${code} without candidate survives waiter cancellation timeout forceNew and owner change`, async t => {
            const f = fixture(t), before = poolStats().size;
            t.mock.timers.enable({ apis: ['setTimeout'] });
            await assert.rejects(acquire({ ...f.options, createSession: async () => { throw new Error(code); } }),
                error => error instanceof Error && error.message === code);
            assert.equal(poolStats().size, before + 1);
            const controller = new AbortController();
            const cancelled = assert.rejects(acquire({ ...f.options, signal: controller.signal }), /aborted/);
            controller.abort(); await cancelled;
            f.reset();
            const timed = assert.rejects(acquire({ ...f.options, lifetime: 'request', forceNew: true,
                persistenceOwner: { global: 1, scope: 0 }, waitMs: 10 }), /timed out/);
            t.mock.timers.tick(10); await timed;
            assert.equal(poolStats().size, before + 1); assert.equal(f.creations, 0);
        });
    }

    test(`${engine} ordinary factory rejection after abandonment is observed and frees only its sentinel`, async t => {
        const f = fixture(t), controller = new AbortController();
        const pending = acquire({ ...f.held, signal: controller.signal });
        const rejected = assert.rejects(pending, /aborted/);
        await f.started.promise; controller.abort(); await rejected;
        let admitted = false;
        const next = acquire(f.options).then(lease => { admitted = true; return lease; });
        await checkpoint(); assert.equal(admitted, false);
        f.gate.reject(new Error('fixture_pre_spawn_failure')); const lease = await next;
        assert.equal(f.old.closes, 0); assert.equal(f.creations, 1); lease.release();
    });

    test(`${engine} ordinary factory rejection and pre-invocation abort permit safe later acquisition`, async t => {
        const f = fixture(t);
        await assert.rejects(acquire({ ...f.options, createSession: async () => { throw new Error('no spawn'); } }), /no spawn/);
        const controller = new AbortController();
        const rejected = assert.rejects(acquire({ ...f.options, signal: controller.signal }), /aborted/);
        controller.abort(); await rejected; await checkpoint(); assert.equal(f.creations, 0);
        const lease = await acquire(f.options); assert.equal(f.creations, 1); lease.release();
    });

    test(`${engine} caller expiry never releases a factory that still has not returned`, async t => {
        const f = fixture(t), clearKeepAlive = globalThis.clearTimeout;
        // MockTimers removes the only ref'd timeout while the factory is pending.
        const keepAlive = setTimeout(() => {}, 5_000);
        t.after(() => clearKeepAlive(keepAlive));
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = acquire({ ...f.held, waitMs: 10 });
        const rejected = assert.rejects(pending, /timed out/);
        await f.started.promise; t.mock.timers.tick(10); await rejected;
        const again = assert.rejects(acquire({ ...f.options, lifetime: 'request', forceNew: true, waitMs: 10 }), /timed out/);
        t.mock.timers.tick(10); await again; assert.equal(f.creations, 0);
    });

    test(`${engine} abort during installation retires an installed lease once and holds physical fence`, async t => {
        const f = fixture(t), controller = new AbortController();
        const on = f.old.child.on.bind(f.old.child);
        t.mock.method(f.old.child, 'on', (event, listener) => {
            const result = on(event, listener);
            if (event === 'exit') controller.abort();
            return result;
        });
        const pending = acquire({ ...f.options, signal: controller.signal, createSession: async () => f.old.session });
        await assert.rejects(pending, /aborted/); await f.old.closeStarted.promise;
        let admitted = false;
        const next = acquire(f.options).then(lease => { admitted = true; return lease; });
        await checkpoint(); assert.equal(admitted, false); assert.equal(f.old.closes, 1);
        f.old.closeGate.resolve(); const lease = await next;
        assert.equal(f.old.child.listenerCount('exit'), 0); lease.release();
    });

    test(`${engine} installation failure wakes an existing creating waiter into the ready retirement fence`, async t => {
        const f = fixture(t), controller = new AbortController();
        const on = f.old.child.on.bind(f.old.child);
        t.mock.method(f.old.child, 'on', (event, listener) => {
            const result = on(event, listener);
            if (event === 'exit') controller.abort();
            return result;
        });
        const pending = acquire({ ...f.held, signal: controller.signal });
        const rejected = assert.rejects(pending, /aborted/);
        await f.started.promise;
        let admitted = false;
        const next = acquire({ ...f.options, waitMs: 100 }).then(lease => { admitted = true; return lease; });
        f.gate.resolve(f.old.session); await rejected; await f.old.closeStarted.promise;
        await checkpoint(); assert.equal(admitted, false);
        f.old.closeGate.resolve(); const lease = await next;
        assert.equal(f.creations, 1); lease.release();
    });

    test(`${engine} late cleanup-unknown factory rejection preserves the original abort and sentinel`, async t => {
        const f = fixture(t), controller = new AbortController();
        const pending = acquire({ ...f.held, signal: controller.signal });
        const rejected = assert.rejects(pending, /aborted/);
        await f.started.promise; controller.abort(); await rejected;
        f.gate.reject(new Error(`${engine}_acp_startup_cleanup_failed`)); await checkpoint();
        const waiter = new AbortController();
        const refused = assert.rejects(acquire({ ...f.options, forceNew: true, signal: waiter.signal }), /aborted/);
        await checkpoint(); assert.equal(f.creations, 0); waiter.abort(); await refused;
    });
}
