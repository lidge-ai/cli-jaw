import { CodexAppClient, isRecoverableResumeError } from './codex-app-client.js';
import { resolveCodexAppLaneKey } from './args.js';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { SessionOwnerToken } from './session-persistence.js';
import { createCursorSession, type CursorSessionOptions } from './runtime/acp/cursor-session.js';
import { createGrokSession, type GrokSessionOptions } from './runtime/acp/grok-session.js';
import { grokAcpArgs } from './runtime/acp/grok-options.js';
import { validateAcpSessionOptions, type AcpSession } from './runtime/acp/session.js';
import { normalizeNativePermissions } from './runtime/acp/permissions.js';
import type { ManagedRuntime, AcquireWaiter, PoolEntry, RuntimeLease, RuntimePoolAccess,
    RuntimePoolEntry as AnyEntry, RuntimePoolStore as EngineStore } from './runtime-pool-contract.js';
import { acquireClaudeRuntimeLease, retireClaudePoolEntry, type ClaudeAcquireOptions, type ClaudeLease } from './claude-runtime-pool.js';
export type { ManagedRuntime, RuntimeLease, RuntimePoolAccess, RuntimePoolEntry, RuntimePoolStore } from './runtime-pool-contract.js';
export type { ClaudeAcquireOptions, ClaudeLease } from './claude-runtime-pool.js';
import {
    normalizePiSettings,
    spawnPersistentPiRpc,
    type PiApiKind,
    type PiRpcSession,
} from './pi-runtime.js';

const DEFAULT_POOL_WAIT_MS = 60_000;
const DEFAULT_POOL_IDLE_MS = 15 * 60_000;
const POOL_SWEEP_MS = 60_000;
const INTERRUPT_LATCH_MS = 10_000;

export interface CodexAppPoolKey {
    scopeKey: string;
    cwd: string;
    model: string;
    effort: string;
    fastMode: boolean;
}

type ReadyEntry<R extends ManagedRuntime, S> = Extract<PoolEntry<R, S>, { state: 'ready' }>;

export interface AcquireOptions {
    binary: string;
    env: NodeJS.ProcessEnv;
    route: 'legacy' | 'multiplex';
    key: CodexAppPoolKey;
    storedThreadId?: string | null;
    instructions?: string;
    forceNew?: boolean;
    waitMs?: number;
}

export interface CodexAppLease extends RuntimeLease<ManagedRuntime, string> {
    client: CodexAppClient;
    threadId: string;
    laneScope: string;
    resumedThread: boolean;
}

export interface PiLease extends RuntimeLease<ManagedRuntime, string | null> {
    session: PiRpcSession;
    retire(reason?: Error): Promise<void>;
}

export interface PiAcquireOptions {
    key: {
        scopeKey: string;
        cwd: string;
        profileId: string;
        fullEndpoint: string;
        apiKind: PiApiKind;
        model: string;
        effort: string;
        profileFp: string;
    };
    piSettings: unknown;
    env?: NodeJS.ProcessEnv;
    storedSessionId?: string | null;
    instructions?: string;
    forceNew?: boolean;
    waitMs?: number;
    signal?: AbortSignal;
}

export interface CursorAcquireOptions {
    key: { scopeKey: string; cwd: string; model: string; effort: string; permissions: unknown };
    binary: string; env: NodeJS.ProcessEnv; promptTimeoutMs: number;
    persistenceOwner: SessionOwnerToken;
    isCurrentOwner(owner: SessionOwnerToken): boolean;
    canAcquire(): boolean;
    storedSessionId?: string | null;
    lifetime?: 'pooled' | 'request';
    forceNew?: boolean;
    waitMs?: number;
    signal?: AbortSignal;
    createSession?: (options: CursorSessionOptions) => Promise<AcpSession>;
}
export interface CursorLease extends RuntimeLease<ManagedRuntime, string> {
    session: AcpSession;
    retire(reason?: Error): Promise<void>;
}

export interface GrokAcquireOptions extends Omit<CursorAcquireOptions, 'createSession'> {
    createSession?: (options: GrokSessionOptions) => Promise<AcpSession>;
}

type Engine = 'codex-app' | 'pi' | 'cursor' | 'grok' | 'claude';

const stores = new Map<Engine, EngineStore>();
let nextWaiterId = 1;
let reaper: NodeJS.Timeout | null = null;

function storeFor(engine: Engine): EngineStore {
    let store = stores.get(engine);
    if (!store) {
        store = { entries: new Map(), scopeIndex: new Map() };
        stores.set(engine, store);
    }
    return store;
}

function fullKey(key: CodexAppPoolKey): string {
    return JSON.stringify([key.scopeKey, key.cwd, key.model, key.effort, key.fastMode]);
}

function fullPiKey(key: PiAcquireOptions['key']): string {
    return JSON.stringify([
        'pi', key.scopeKey, key.cwd, key.profileId, key.fullEndpoint.replace(/\/+$/, ''),
        key.apiKind, key.model, key.effort, key.profileFp,
    ]);
}

function configuredMs(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function drainWaiters(entry: { waiters: AcquireWaiter[] }, outcome: 'wake' | Error): void {
    const pending = entry.waiters.splice(0);
    for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.cleanup?.();
        if (outcome instanceof Error) waiter.reject(outcome);
        else waiter.resolve();
    }
}

function removeWaiter(entry: { waiters: AcquireWaiter[] }, id: number): void {
    const index = entry.waiters.findIndex((waiter) => waiter.id === id);
    if (index >= 0) {
        const waiter = entry.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer); waiter.cleanup?.();
    }
}

function waitForEntry(entry: { waiters: AcquireWaiter[] }, waitMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('runtime pool acquire aborted')); return; }
        const id = nextWaiterId++;
        const timer = setTimeout(() => {
            removeWaiter(entry, id);
            reject(new Error(`runtime pool acquire timed out after ${waitMs}ms`));
        }, waitMs);
        const abort = () => { removeWaiter(entry, id); reject(new Error('runtime pool acquire aborted')); };
        entry.waiters.push({ id, resolve, reject, timer,
            ...(signal ? { cleanup: () => signal.removeEventListener('abort', abort) } : {}) });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

function unindex(store: EngineStore, scopeKey: string, key: string): void {
    const keys = store.scopeIndex.get(scopeKey);
    keys?.delete(key);
    if (keys?.size === 0) store.scopeIndex.delete(scopeKey);
}

function removeEntry(store: EngineStore, key: string, entry: AnyEntry, reason: Error): void {
    if (store.entries.get(key) !== entry) return;
    store.entries.delete(key);
    unindex(store, entry.scopeKey, key);
    drainWaiters(entry, reason);
    if (entry.state === 'ready') entry.disposeExit();
}

function closeEntry(store: EngineStore, key: string, entry: AnyEntry, reason: Error): void {
    removeEntry(store, key, entry, reason);
    if (entry.state === 'creating') entry.abortCreate?.();
    if (entry.state === 'ready') {
        void Promise.resolve(entry.runtime.close()).catch((err: unknown) => {
            console.warn('[runtime-pool] close failed:', (err as Error).message);
        });
    }
}

function replaceScopeEntries(store: EngineStore, scopeKey: string, keepKey: string | null): void {
    for (const key of [...(store.scopeIndex.get(scopeKey) ?? [])]) {
        if (key === keepKey) continue;
        const entry = store.entries.get(key);
        if (entry) closeEntry(store, key, entry, new Error('runtime pool entry replaced'));
    }
}

type CodexManagedRuntime = ManagedRuntime & {
    readonly client: CodexAppClient;
    readonly laneScope: string;
};

export async function interruptCodexRuntime(
    client: CodexAppClient,
    laneScope: string,
): Promise<void> {
    if (client.getActiveTurnId(laneScope)) {
        await client.interruptTurn(laneScope);
        return;
    }
    const expectedThreadId = client.getThreadId(laneScope);
    await new Promise<void>((resolve, reject) => {
        let disposed = false;
        let timer: NodeJS.Timeout;
        let listener: { dispose(): void } | null = null;
        const cleanup = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            listener?.dispose();
        };
        const onFailed = (err: Error) => { cleanup(); reject(err); };
        listener = client.listenTurn(laneScope, {
            role: 'lifecycle',
            onNotification: (method, _params, owner) => {
                const expectedTurnId = client.getActiveTurnId(laneScope);
                if (
                    method !== 'turn/completed'
                    || !expectedThreadId
                    || !expectedTurnId
                    || !owner
                    || owner.threadId !== expectedThreadId
                    || owner.turnId !== expectedTurnId
                ) return;
                cleanup();
                resolve();
            },
            onStderr: () => {},
            onExit: (code, signal) => {
                onFailed(new Error(`Codex AppServer exited (code=${code}, signal=${signal})`));
            },
            onError: onFailed,
            onInterruptFailed: onFailed,
        });
        timer = setTimeout(() => {
            onFailed(new Error('interrupt latch timeout'));
        }, INTERRUPT_LATCH_MS);
        void client.interruptTurn(laneScope).catch(onFailed);
    });
}

function codexRuntime(client: CodexAppClient, laneScope: string): CodexManagedRuntime {
    return {
        client,
        laneScope,
        get alive() { return client.alive; },
        supportsInterrupt: true,
        close: () => client.closeGracefully(),
        interrupt: () => interruptCodexRuntime(client, laneScope),
        kill: () => client.kill(),
        onExit: (cb) => {
            const listener = (code: number | null) => { cb(code); };
            const errorListener = () => { cb(null); };
            client.on('exit', listener);
            client.on('error', errorListener);
            return () => {
                client.off('exit', listener);
                client.off('error', errorListener);
            };
        },
    };
}

type PiManagedRuntime = ManagedRuntime & { readonly session: PiRpcSession };

function piRuntime(session: PiRpcSession): PiManagedRuntime {
    return {
        session,
        get alive() { return session.alive; },
        get supportsInterrupt() { return session.abortEffective; },
        close: () => session.close(),
        interrupt: () => session.abort(),
        kill: () => session.kill(),
        onExit: (cb) => {
            const listener = (code: number | null) => { cb(code); };
            session.child.on('exit', listener);
            return () => { session.child.off('exit', listener); };
        },
    };
}

async function cancelLease<R extends ManagedRuntime, S>(entry: ReadyEntry<R, S>): Promise<void> {
    if (entry.runtime.supportsInterrupt) {
        try {
            await entry.runtime.interrupt();
            return;
        } catch {
            // Fall through: cancellation must not be lost when interrupt fails.
        }
    }
    entry.runtime.kill();
    entry.dead = true;
    drainWaiters(entry, new Error('runtime cancelled and discarded'));
}

function makeCodexLease(
    store: EngineStore,
    key: string,
    entry: ReadyEntry<ManagedRuntime, unknown>,
    client: CodexAppClient,
    threadId: string,
    reused: boolean,
    resumedThread: boolean,
): CodexAppLease {
    let released = false;
    const laneScope = (entry.runtime as CodexManagedRuntime).laneScope;
    return {
        runtime: entry.runtime,
        sessionId: threadId,
        client,
        threadId,
        laneScope,
        reused,
        resumedThread,
        release: () => {
            if (released) return;
            released = true;
            entry.lastUsedAt = Date.now();
            entry.busy = false;
            if (entry.dead || !entry.runtime.alive) {
                removeEntry(store, key, entry, new Error('runtime exited'));
                return;
            }
            drainWaiters(entry, 'wake');
        },
        cancel: () => cancelLease(entry),
    };
}

function piSessionForLease(session: PiRpcSession, instructions?: string): PiRpcSession {
    if (!instructions) return session;
    return {
        child: session.child,
        get alive() { return session.alive; },
        get abortEffective() { return session.abortEffective; },
        get sessionId() { return session.sessionId; },
        set sessionId(value) { session.sessionId = value; },
        sendPrompt: (message, opts) => session.sendPrompt(`${instructions}\n\n${message}`, opts),
        abort: () => session.abort(),
        close: () => session.close(),
        kill: () => session.kill(),
    };
}

function retirePiEntry(
    store: EngineStore,
    key: string,
    entry: ReadyEntry<ManagedRuntime, unknown>,
    reason: Error,
): Promise<void> {
    if (store.entries.get(key) !== entry) return Promise.resolve();
    entry.dead = true;
    return Promise.resolve(entry.runtime.close()).then(() => {
        removeEntry(store, key, entry, reason);
    }, (error: unknown) => {
        removeEntry(store, key, entry, reason);
        throw error;
    });
}

function makePiLease(
    store: EngineStore,
    key: string,
    entry: ReadyEntry<ManagedRuntime, unknown>,
    session: PiRpcSession,
    reused: boolean,
    instructions?: string,
): PiLease {
    let released = false;
    return {
        runtime: entry.runtime,
        sessionId: session.sessionId,
        session: piSessionForLease(session, instructions),
        reused,
        release: () => {
            if (released) return;
            released = true;
            entry.sessionId = session.sessionId;
            entry.lastUsedAt = Date.now();
            entry.busy = false;
            if (entry.dead || !entry.runtime.alive) {
                removeEntry(store, key, entry, new Error('runtime exited'));
                return;
            }
            drainWaiters(entry, 'wake');
        },
        retire(reason = new Error('pi lease retired')) {
            if (released) return Promise.resolve();
            released = true;
            return retirePiEntry(store, key, entry, reason);
        },
        cancel: () => cancelLease(entry),
    };
}

async function createCodexEntry(
    store: EngineStore,
    key: string,
    creating: Extract<AnyEntry, { state: 'creating' }>,
    opts: AcquireOptions,
): Promise<CodexAppLease> {
    const client = new CodexAppClient({
        binary: opts.binary,
        workDir: opts.key.cwd,
        env: opts.env,
    });
    const laneScope = resolveCodexAppLaneKey(
        opts.key.scopeKey,
        opts.key.model,
        opts.key.effort,
        'fallback',
    );
    const threadOptions = {
        model: opts.key.model,
        effort: opts.key.effort,
        cwd: opts.key.cwd,
        fastMode: opts.key.fastMode,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
    };
    client.spawn();
    try {
        await client.initialize();
        let resumedThread = false;
        let threadId: string;
        const storedThreadId = opts.forceNew ? null : opts.storedThreadId;
        if (storedThreadId) {
            try {
                threadId = await client.resumeThread(laneScope, storedThreadId, threadOptions);
                resumedThread = true;
            } catch (err: unknown) {
                if (!isRecoverableResumeError((err as Error).message)) throw err;
                threadId = await client.startThread(laneScope, threadOptions);
            }
        } else {
            threadId = await client.startThread(laneScope, threadOptions);
        }
        if (store.entries.get(key) !== creating) {
            await client.closeGracefully();
            throw new Error('runtime pool creation superseded');
        }
        const runtime = codexRuntime(client, laneScope);
        let ready!: ReadyEntry<ManagedRuntime, unknown>;
        const disposeExit = runtime.onExit(() => {
            if (store.entries.get(key) !== ready) return;
            ready.dead = true;
            drainWaiters(ready, new Error('runtime exited'));
            if (!ready.busy) removeEntry(store, key, ready, new Error('runtime exited'));
        });
        ready = {
            state: 'ready', scopeKey: opts.key.scopeKey, runtime, sessionId: threadId,
            busy: true, dead: false, waiters: [], lastUsedAt: Date.now(), disposeExit,
        };
        store.entries.set(key, ready);
        drainWaiters(creating, 'wake');
        return makeCodexLease(store, key, ready, client, threadId, false, resumedThread);
    } catch (err: unknown) {
        client.kill();
        removeEntry(store, key, creating, err as Error);
        throw err;
    }
}

export async function acquireCodexAppRuntime(opts: AcquireOptions): Promise<CodexAppLease> {
    if (opts.route === 'multiplex') {
        throw new Error('multiplex route reached generic Codex App runtime pool');
    }
    startPoolReaper();
    const store = storeFor('codex-app');
    const key = fullKey(opts.key);
    const waitMs = opts.waitMs ?? configuredMs(process.env["CODEX_APP_POOL_WAIT_MS"], DEFAULT_POOL_WAIT_MS);
    replaceScopeEntries(store, opts.key.scopeKey, opts.forceNew ? null : key);
    let forceNewApplied = !opts.forceNew;

    for (;;) {
        let entry = store.entries.get(key);
        if (!forceNewApplied) {
            forceNewApplied = true;
            if (entry) closeEntry(store, key, entry, new Error('runtime pool forceNew replacement'));
            entry = undefined;
        }
        if (!entry) {
            const creating: Extract<AnyEntry, { state: 'creating' }> = {
                state: 'creating', scopeKey: opts.key.scopeKey, waiters: [], lastUsedAt: Date.now(),
            };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(opts.key.scopeKey);
            if (!keys) {
                keys = new Set();
                store.scopeIndex.set(opts.key.scopeKey, keys);
            }
            keys.add(key);
            return createCodexEntry(store, key, creating, opts);
        }
        if (entry.state === 'creating') {
            await waitForEntry(entry, waitMs);
            continue;
        }
        if (entry.dead || !entry.runtime.alive || (opts.storedThreadId && entry.sessionId !== opts.storedThreadId)) {
            closeEntry(store, key, entry, new Error('runtime pool entry stale'));
            continue;
        }
        if (!entry.busy) {
            entry.busy = true;
            entry.lastUsedAt = Date.now();
            const client = (entry.runtime as CodexManagedRuntime).client;
            return makeCodexLease(store, key, entry, client, entry.sessionId as string, true, true);
        }
        await waitForEntry(entry, waitMs);
    }
}

async function createPiEntry(
    store: EngineStore,
    key: string,
    creating: Extract<AnyEntry, { state: 'creating' }>,
    opts: PiAcquireOptions,
): Promise<PiLease> {
    const pi = normalizePiSettings(opts.piSettings);
    const profile = pi.profiles.find((entry) => entry.id === opts.key.profileId);
    if (!profile) {
        const error = new Error(`Pi profile not found: ${opts.key.profileId}`);
        removeEntry(store, key, creating, error);
        throw error;
    }
    let session: PiRpcSession | null = null;
    try {
        session = spawnPersistentPiRpc(profile, pi, {
            model: opts.key.model,
            effort: opts.key.effort,
            cwd: opts.key.cwd,
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.forceNew || !opts.storedSessionId ? {} : { sessionId: opts.storedSessionId }),
        });
        if (store.entries.get(key) !== creating) {
            try {
                void Promise.resolve(session.close()).catch(() => { console.warn('[runtime-pool] superseded Pi close unconfirmed'); });
            } catch { console.warn('[runtime-pool] superseded Pi close unconfirmed'); }
            throw new Error('runtime pool creation superseded');
        }
        const runtime = piRuntime(session);
        let ready!: ReadyEntry<ManagedRuntime, unknown>;
        const disposeExit = runtime.onExit(() => {
            if (store.entries.get(key) !== ready) return;
            ready.dead = true;
            drainWaiters(ready, new Error('runtime exited'));
            if (!ready.busy) removeEntry(store, key, ready, new Error('runtime exited'));
        });
        ready = {
            state: 'ready', scopeKey: opts.key.scopeKey, runtime, sessionId: session.sessionId,
            busy: true, dead: false, waiters: [], lastUsedAt: Date.now(), disposeExit,
        };
        store.entries.set(key, ready);
        drainWaiters(creating, 'wake');
        return makePiLease(store, key, ready, session, false, opts.instructions);
    } catch (err: unknown) {
        session?.kill();
        removeEntry(store, key, creating, err as Error);
        throw err;
    }
}

export async function acquirePiRuntime(opts: PiAcquireOptions): Promise<PiLease> {
    startPoolReaper();
    const store = storeFor('pi');
    const key = fullPiKey(opts.key);
    const waitMs = opts.waitMs ?? configuredMs(process.env["PI_POOL_WAIT_MS"], DEFAULT_POOL_WAIT_MS);
    replaceScopeEntries(store, opts.key.scopeKey, opts.forceNew ? null : key);
    let forceNewApplied = !opts.forceNew;

    for (;;) {
        let entry = store.entries.get(key);
        if (!forceNewApplied) {
            forceNewApplied = true;
            if (entry) closeEntry(store, key, entry, new Error('runtime pool forceNew replacement'));
            entry = undefined;
        }
        if (!entry) {
            const creating: Extract<AnyEntry, { state: 'creating' }> = {
                state: 'creating', scopeKey: opts.key.scopeKey, waiters: [], lastUsedAt: Date.now(),
            };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(opts.key.scopeKey);
            if (!keys) {
                keys = new Set();
                store.scopeIndex.set(opts.key.scopeKey, keys);
            }
            keys.add(key);
            return createPiEntry(store, key, creating, opts);
        }
        if (entry.state === 'creating') {
            await waitForEntry(entry, waitMs, opts.signal);
            continue;
        }
        const session = (entry.runtime as PiManagedRuntime).session;
        if (entry.dead || !entry.runtime.alive
            || (opts.storedSessionId && entry.sessionId !== opts.storedSessionId)) {
            closeEntry(store, key, entry, new Error('runtime pool entry stale'));
            continue;
        }
        if (!entry.busy) {
            entry.busy = true;
            entry.lastUsedAt = Date.now();
            return makePiLease(store, key, entry, session, true, opts.instructions);
        }
        await waitForEntry(entry, waitMs, opts.signal);
    }
}

type CursorManagedRuntime = ManagedRuntime & { session: AcpSession };

function removeRetiredCursorEntry(store: EngineStore, key: string, entry: AnyEntry): void {
    if (store.entries.get(key) !== entry) return;
    // A completed fence wakes acquisitions to rescan the scope, not to fail them.
    drainWaiters(entry, 'wake');
    removeEntry(store, key, entry, new Error('cursor runtime retired'));
}

function retireCursorEntry(store: EngineStore, key: string, entry: ReadyEntry<ManagedRuntime, unknown>,
    reason: Error): Promise<void> {
    if (entry.cursorRetirement) return entry.cursorRetirement;
    if (store.entries.get(key) !== entry) return Promise.resolve();
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Install before invoking session code: retire/close can synchronously emit exit.
    entry.dead = true;
    entry.cursorRetirement = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void entry.cursorRetirement.catch(() => {
        console.warn('[runtime-pool] cursor retirement failed; awaiting captured child exit');
    });
    try {
        (entry.runtime as CursorManagedRuntime).session.retire(reason);
        void Promise.resolve(entry.runtime.close()).then(() => {
            removeRetiredCursorEntry(store, key, entry);
            resolve();
        }, reject);
    } catch (error) { reject(error); }
    // A rejected close remains fenced. Only observed close or this child's exit removes it.
    return entry.cursorRetirement;
}

function cursorRuntime(session: AcpSession): CursorManagedRuntime {
    return { session, get alive() { return session.alive; }, supportsInterrupt: true,
        close: () => session.close(), interrupt: () => session.cancel(), kill: () => session.retire(),
        onExit: cb => {
            const listener = (code: number | null) => cb(code);
            session.child.on('exit', listener);
            return () => { session.child.off('exit', listener); };
        } };
}
function makeCursorLease(store: EngineStore, key: string, entry: ReadyEntry<ManagedRuntime, unknown>, reused: boolean,
    requestLifetime = false): CursorLease {
    const runtime = entry.runtime as CursorManagedRuntime;
    const token = Symbol('cursor-lease');
    entry.leaseOwner = token;
    let released = false;
    const owns = () => store.entries.get(key) === entry && entry.leaseOwner === token;
    return { runtime, session: runtime.session, sessionId: runtime.session.nativeSessionId, reused,
        ...(requestLifetime ? { retireOnFinish: true } : {}),
        release() {
            if (released) return;
            released = true;
            if (!owns()) return;
            delete entry.leaseOwner;
            entry.busy = false; entry.lastUsedAt = Date.now();
            if (requestLifetime || entry.cursorRetirement || entry.dead || !runtime.alive || !runtime.session.idle) {
                void retireCursorEntry(store, key, entry, new Error('cursor runtime released before idle'));
                return;
            }
            drainWaiters(entry, 'wake');
        },
        retire(reason = new Error('cursor lease retired')) {
            if (released || !owns()) return Promise.resolve();
            return retireCursorEntry(store, key, entry, reason);
        },
        async cancel() {
            if (released || !owns()) return;
            try { await runtime.interrupt(); }
            catch {
                if (released || !owns()) return;
                await retireCursorEntry(store, key, entry, new Error('cursor runtime cancelled and discarded'));
            }
        },
    };
}

type AcpCreating = Extract<AnyEntry, { state: 'creating' }> & { acpCreation?: Promise<void> };

function unknownAcpCleanup(error: unknown): boolean {
    return error instanceof Error && ['cursor_acp_startup_cleanup_failed', 'grok_acp_startup_cleanup_failed',
        'acp_reap_timeout'].includes(error.message);
}

/** A factory-returned, uninstalled candidate stays owned until close or its exact exit. */
function closeAcpCandidate(session: AcpSession): Promise<void> {
    return new Promise(resolve => {
        const child = session.child;
        let closed = false;
        const complete = () => {
            if (closed) return;
            closed = true; child.off('exit', complete); resolve();
        };
        const failed = () => { if (!closed) console.warn('[runtime-pool] acp_creation_cleanup_unknown'); };
        child.on('exit', complete);
        if (child.exitCode != null || child.signalCode != null) complete();
        try {
            session.retire(new Error('cursor runtime creation discarded'));
            void Promise.resolve(session.close()).then(complete, failed);
        } catch { failed(); }
    });
}

async function createCursorEntry(store: EngineStore, key: string, creating: AcpCreating,
    opts: CursorAcquireOptions, deadline: number, check: () => void): Promise<CursorLease> {
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void interrupted.catch(() => undefined);
    let abandoned = false, candidate: AcpSession | null = null, installedLease: CursorLease | undefined;
    let cleanupStarted = false, resolveCleanup!: () => void;
    creating.acpCreation = new Promise<void>(resolve => { resolveCleanup = resolve; });
    const complete = () => {
        drainWaiters(creating, 'wake');
        if (store.entries.get(key) === creating) removeRetiredCursorEntry(store, key, creating);
        delete creating.abortCreate; resolveCleanup();
    };
    const abort = (error: Error) => {
        if (controller.signal.aborted) return;
        abandoned = true;
        controller.abort(error); rejectAbort(error);
    };
    creating.abortCreate = () => abort(new Error('cursor runtime creation replaced'));
    const onAbort = () => abort(new Error('cursor runtime acquire aborted'));
    const timer = setTimeout(() => abort(new Error('cursor runtime acquire timed out')), Math.max(1, deadline - performance.now()));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (error: unknown) => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (installedLease) {
            const retiring = installedLease.retire(new Error('cursor runtime admission invalidated'));
            installedLease.release();
            // Physical ownership has transferred to the ready-entry retirement fence.
            complete(); void retiring.catch(() => {});
        } else if (candidate) {
            void closeAcpCandidate(candidate).then(complete);
        } else if (!unknownAcpCleanup(error)) complete();
    };
    const verify = () => {
        if (abandoned || controller.signal.aborted) throw new Error('cursor runtime acquire aborted');
        check();
    };
    const creation = Promise.resolve().then(async () => {
        try {
            if (opts.signal?.aborted) onAbort();
            verify();
            const session = candidate = await (opts.createSession ?? createCursorSession)({ binary: opts.binary, env: opts.env, cwd: opts.key.cwd,
                permissions: opts.key.permissions, model: opts.key.model, effort: opts.key.effort,
                promptTimeoutMs: opts.promptTimeoutMs, signal: controller.signal,
                ...(opts.forceNew || !opts.storedSessionId ? {} : { resumeSessionId: opts.storedSessionId }) });
            verify();
            if (controller.signal.aborted || store.entries.get(key) !== creating || !session.alive || !session.idle) {
                throw new Error('cursor runtime creation superseded');
            }
            const runtime = cursorRuntime(session);
            const ready: ReadyEntry<ManagedRuntime, unknown> = { state: 'ready', scopeKey: opts.key.scopeKey, runtime,
                sessionId: session.nativeSessionId, busy: true, dead: false, waiters: [], lastUsedAt: Date.now(),
                disposeExit: () => {}, nativeOwner: opts.persistenceOwner };
            store.entries.set(key, ready);
            installedLease = makeCursorLease(store, key, ready, false, opts.lifetime === 'request');
            ready.disposeExit = runtime.onExit(() => {
                if (store.entries.get(key) !== ready) return;
                ready.dead = true;
                if (ready.cursorRetirement || !ready.busy) removeRetiredCursorEntry(store, key, ready);
                else drainWaiters(ready, 'wake');
            });
            verify();
            if (ready.dead || !runtime.alive || !session.idle) throw new Error('cursor runtime creation superseded');
            complete();
            return installedLease;
        } catch (error) {
            abort(error instanceof Error ? error : new Error('cursor runtime creation failed'));
            cleanup(error); throw error;
        }
    });
    try {
        const lease = await Promise.race([creation, interrupted]);
        verify();
        if (!lease.runtime.alive) throw new Error('cursor runtime creation superseded');
        return lease;
    } catch (error) {
        abort(error instanceof Error ? error : new Error('cursor runtime creation failed'));
        // A still-pending factory retains its sentinel; only the operation can classify its result.
        if (installedLease) cleanup(error);
        throw error;
    } finally {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
        if (store.entries.get(key) !== creating) delete creating.abortCreate;
    }
}

export async function acquireCursorRuntime(input: CursorAcquireOptions): Promise<CursorLease> {
    return acquireAcpRuntime(input, 'cursor');
}

export async function acquireGrokRuntime(input: GrokAcquireOptions): Promise<CursorLease> {
    // Snapshot before caller admission/ownership callbacks can retarget the request.
    const opts: GrokAcquireOptions = { ...input, key: { ...input.key }, env: { ...input.env },
        persistenceOwner: { ...input.persistenceOwner }, createSession: input.createSession ?? createGrokSession };
    grokAcpArgs(opts.key.permissions);
    const authFingerprint = createHash('sha256').update(JSON.stringify(
        ['XAI_API_KEY', 'GROK_AUTH', 'HOME', 'USERPROFILE', 'GROK_HOME', 'GROK_AUTH_PATH'].map(name => [name, opts.env[name]]),
    )).digest('hex');
    return acquireAcpRuntime(opts, 'grok', authFingerprint);
}

async function acquireAcpRuntime(input: CursorAcquireOptions, engine: 'cursor' | 'grok',
    authFingerprint?: string): Promise<CursorLease> {
    input = { ...input, key: { ...input.key }, env: { ...input.env },
        persistenceOwner: Object.freeze({ ...input.persistenceOwner }) };
    if (input.lifetime !== undefined && input.lifetime !== 'pooled' && input.lifetime !== 'request') {
        throw new Error('cursor runtime invalid lifetime');
    }
    if (typeof input.canAcquire !== 'function') throw new Error('cursor runtime caller admission required');
    const waitMs = input.waitMs ?? DEFAULT_POOL_WAIT_MS;
    if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || waitMs > 2_147_483_647) throw new Error('cursor runtime invalid acquire timeout');
    validateAcpSessionOptions({ permissions: input.key.permissions, promptTimeoutMs: input.promptTimeoutMs });
    for (const value of [input.binary, input.key.scopeKey, input.key.cwd]) {
        if (typeof value !== 'string' || !value) throw new Error('cursor runtime invalid key');
    }
    for (const value of [input.key.model, input.key.effort]) {
        if (typeof value !== 'string' || value.length > 1024) throw new Error('cursor runtime invalid key');
    }
    if (![input.persistenceOwner.global, input.persistenceOwner.scope].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('cursor runtime invalid ownership');
    }
    const deadline = performance.now() + waitMs;
    const owner = input.persistenceOwner;
    const permissions = normalizeNativePermissions(input.key.permissions);
    const isCurrentOwner = input.isCurrentOwner, canAcquire = input.canAcquire, signal = input.signal;
    const check = () => {
        let current = false;
        try { current = isCurrentOwner(owner) === true && canAcquire() === true; } catch { /* fail closed */ }
        if (!current || signal?.aborted) throw new Error('cursor runtime ownership invalidated');
        if (performance.now() >= deadline) throw new Error('cursor runtime acquire timed out');
    };
    check();
    const opts: CursorAcquireOptions = { ...input, persistenceOwner: owner,
        key: { ...input.key, cwd: realpathSync(input.key.cwd), permissions } };
    check(); startPoolReaper();
    const store = storeFor(engine);
    const key = JSON.stringify([engine, opts.key.scopeKey, opts.key.cwd, opts.binary,
        opts.key.model, opts.key.effort, opts.key.permissions, 'native',
        ...(engine === 'grok' ? [authFingerprint] : []),
        ...(opts.lifetime === 'request' ? ['request', randomBytes(32).toString('hex')] : [])]);
    // forceNew invalidates the captured entries only, never a borrower admitted after an await.
    const forced = new Set(opts.forceNew
        ? [...(store.scopeIndex.get(opts.key.scopeKey) ?? [])].map(k => store.entries.get(k)) : []);
    for (;;) {
        check();
        // Every await returns here. A key-local check alone can admit two different keys.
        let blocked = false;
        for (const scopeKey of store.scopeIndex.get(opts.key.scopeKey) ?? []) {
            const candidate = store.entries.get(scopeKey);
            if (!candidate) continue;
            const invalidated = forced.has(candidate) || candidate.nativeOwner?.global !== owner.global
                || candidate.nativeOwner?.scope !== owner.scope;
            if (candidate.state === 'creating') {
                if (invalidated) candidate.abortCreate?.();
                if (store.entries.get(scopeKey) === candidate) {
                    await waitForEntry(candidate, Math.max(1, deadline - performance.now()), signal);
                }
            } else if (candidate.cursorRetirement) {
                await waitForEntry(candidate, Math.max(1, deadline - performance.now()), signal);
            } else if (candidate.busy && !invalidated) {
                // Protocol idle/exit is not application settlement. Never interrupt a normal owner.
                await waitForEntry(candidate, Math.max(1, deadline - performance.now()), signal);
            } else if (invalidated || scopeKey !== key || candidate.dead || !candidate.runtime.alive
                || (opts.storedSessionId && opts.storedSessionId !== candidate.sessionId)
                || !(candidate.runtime as CursorManagedRuntime).session.idle) {
                void retireCursorEntry(store, scopeKey, candidate, new Error('cursor runtime entry stale'));
                if (store.entries.get(scopeKey) === candidate) {
                    await waitForEntry(candidate, Math.max(1, deadline - performance.now()), signal);
                }
            } else continue;
            blocked = true;
            break;
        }
        if (blocked) continue;
        const entry = store.entries.get(key);
        if (!entry) {
            const creating: Extract<AnyEntry, { state: 'creating' }> = { state: 'creating', scopeKey: opts.key.scopeKey,
                waiters: [], lastUsedAt: Date.now(), nativeOwner: owner };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(opts.key.scopeKey);
            if (!keys) { keys = new Set(); store.scopeIndex.set(opts.key.scopeKey, keys); }
            keys.add(key);
            return createCursorEntry(store, key, creating, opts, deadline, check);
        }
        if (entry.state === 'ready') {
            entry.busy = true; entry.lastUsedAt = Date.now();
            return makeCursorLease(store, key, entry, true);
        }
    }
}

function claudePoolAccess(): RuntimePoolAccess {
    return { store: storeFor('claude'), wait: waitForEntry, remove: removeEntry,
        wake: entry => drainWaiters(entry, 'wake') };
}

export function acquireClaudeRuntime(input: ClaudeAcquireOptions): Promise<ClaudeLease> {
    startPoolReaper();
    return acquireClaudeRuntimeLease(claudePoolAccess(), input);
}

export function startPoolReaper(idleMs = DEFAULT_POOL_IDLE_MS): void {
    if (reaper) return;
    reaper = setInterval(() => {
        const now = Date.now();
        for (const [engine, store] of stores) {
            for (const [key, entry] of store.entries) {
                if (entry.state === 'ready' && !entry.busy && now - entry.lastUsedAt >= idleMs) {
                    if (engine === 'cursor' || engine === 'grok') void retireCursorEntry(store, key, entry, new Error('runtime pool idle timeout'));
                    else if (engine === 'claude') void retireClaudePoolEntry(claudePoolAccess(), key, entry, new Error('runtime pool idle timeout'));
                    else closeEntry(store, key, entry, new Error('runtime pool idle timeout'));
                }
            }
        }
    }, POOL_SWEEP_MS);
    reaper.unref();
}

export function poolStats(): { size: number; busy: number } {
    let size = 0;
    let busy = 0;
    for (const store of stores.values()) {
        size += store.entries.size;
        for (const entry of store.entries.values()) {
            if (entry.state === 'ready' && entry.busy) busy += 1;
        }
    }
    return { size, busy };
}
