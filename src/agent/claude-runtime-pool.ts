import { createHmac, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ManagedRuntime, RuntimeLease, RuntimePoolAccess, RuntimePoolEntry } from './runtime-pool-contract.js';
import type { SessionOwnerToken } from './session-persistence.js';
import { createClaudeSdkSession, type ClaudeSdkSession, type ClaudeSessionOptions, type ClaudeTurnContext,
    type ClaudeResultMetadata } from './runtime/claude-sdk-session.js';
import { buildClaudeSdkOptions, type PreparedClaudeOptions } from './runtime/claude-sdk-options.js';
import { recordRuntimeEvent, type RuntimeEventContext } from './runtime/events.js';
import type { RuntimeEventBody } from '../shared/runtime-contract.js';
import { CLAUDE_AGENT_SDK_PINNED_VERSION } from './runtime/claude-sdk-version.js';

type Binding = Pick<ClaudeSessionOptions, 'getTurnContext' | 'onMetadata' | 'record'>;
export interface ClaudeAcquireOptions {
    scopeKey: string; chatSessionId: string; workerId?: string;
    prepared: PreparedClaudeOptions; storedSessionId?: string | null;
    persistenceOwner: SessionOwnerToken;
    isCurrentOwner(owner: SessionOwnerToken): boolean;
    canAcquire(): boolean;
    binding: Binding;
    promptTimeoutMs: number; closeTimeoutMs?: number; forceNew?: boolean;
    lifetime?: 'pooled' | 'request';
    waitMs?: number; signal?: AbortSignal;
    createSession?: (options: ClaudeSessionOptions) => Promise<ClaudeSdkSession>;
}
export interface ClaudeLease extends RuntimeLease<ManagedRuntime, string> {
    session: ClaudeSdkSession;
    child: ChildProcessWithoutNullStreams;
    retire(reason?: Error): Promise<void>;
}
/** Failure delivery can precede a late factory's proven physical cleanup. */
export class ClaudeAcquireFailure extends Error {
    constructor(cause: unknown, readonly cleanup: Promise<void>) {
        super(cause instanceof Error ? cause.message : 'claude runtime acquisition failed', { cause });
    }
}
type TurnBinding = Binding & { context: Readonly<ClaudeTurnContext> };
type Holder = { current?: Binding; captured?: TurnBinding };
type Creating = Extract<RuntimePoolEntry, { state: 'creating' }> & { claudeCreation?: Promise<void> };
type Ready = Extract<RuntimePoolEntry, { state: 'ready' }> & {
    claude: { session: ClaudeSdkSession; child: ChildProcessWithoutNullStreams; holder: Holder;
        retirement?: Promise<void>; closedSuccessfully: boolean };
};
const privateKey = randomBytes(32);
const error = (message: string) => new Error(`claude runtime ${message}`);
const remaining = (deadline: number) => Math.max(1, Math.ceil(deadline - performance.now()));

function timeout(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw error('invalid timeout');
}
function sameContext(binding: TurnBinding | undefined, context: RuntimeEventContext): boolean {
    const own = binding?.context;
    return !!own && own.runId === context.runId && own.sessionId === context.sessionId
        && own.scope === context.scope && own.turnId === context.turnId;
}
/** Stable functions survive factory snapshots; only a send captures a new turn binding. */
function sessionOptions(opts: ClaudeAcquireOptions, holder: Holder, signal: AbortSignal): ClaudeSessionOptions {
    return {
        prepared: opts.prepared, promptTimeoutMs: opts.promptTimeoutMs,
        ...(opts.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: opts.closeTimeoutMs }),
        signal, deferTurnEnd: true,
        getTurnContext(): ClaudeTurnContext {
            const binding = holder.current;
            if (!binding) throw error('lease not bound');
            const context = Object.freeze({ ...binding.getTurnContext() });
            holder.captured = { ...binding, context };
            return context;
        },
        onMetadata(context: Readonly<ClaudeTurnContext>, metadata: ClaudeResultMetadata): void {
            const binding = holder.captured;
            if (sameContext(binding, context)) binding?.onMetadata?.(context, metadata);
        },
        record(context: RuntimeEventContext, body: RuntimeEventBody) {
            const binding = holder.captured;
            const record = binding?.record ?? recordRuntimeEvent;
            return sameContext(binding, context) ? record(context, body) : null;
        },
    };
}
function remove(access: RuntimePoolAccess, key: string, entry: RuntimePoolEntry): void {
    if (access.store.entries.get(key) !== entry) return;
    access.wake(entry);
    access.remove(access.store, key, entry, error('retired'));
}
function removeClosed(access: RuntimePoolAccess, key: string, entry: Ready): void {
    if (entry.claude.closedSuccessfully && !entry.busy) remove(access, key, entry);
}

/** Resolves physical close only: the shared runner retires BEFORE releasing its lease. */
export function retireClaudePoolEntry(access: RuntimePoolAccess, key: string, value: RuntimePoolEntry,
    _reason: Error): Promise<void> {
    if (access.store.entries.get(key) !== value) return Promise.resolve();
    if (value.state === 'creating') {
        value.abortCreate?.();
        return (value as Creating).claudeCreation ?? Promise.resolve();
    }
    const entry = value as Ready;
    if (entry.claude.retirement) return entry.claude.retirement;
    entry.dead = true;
    // Install the promise before calling SDK close, which can emit exit synchronously.
    entry.claude.retirement = Promise.resolve().then(() => entry.runtime.close()).then(() => {
        entry.claude.closedSuccessfully = true;
        removeClosed(access, key, entry);
        access.wake(entry);
    });
    void entry.claude.retirement.catch(() => {}); // Failed close deliberately retains its fence.
    return entry.claude.retirement;
}

function makeLease(access: RuntimePoolAccess, key: string, entry: Ready, binding: Binding, reused: boolean,
    requestLifetime = false): ClaudeLease {
    const token = Symbol('claude-lease'), { session, child, holder } = entry.claude;
    entry.leaseOwner = token; entry.busy = true; entry.lastUsedAt = Date.now();
    holder.current = { ...binding };
    let released = false;
    const owns = () => access.store.entries.get(key) === entry && entry.leaseOwner === token;
    const retire = (reason = error('lease retired')) => released || !owns()
        ? Promise.resolve() : retireClaudePoolEntry(access, key, entry, reason);
    return { runtime: entry.runtime, session, child, sessionId: session.nativeSessionId, reused,
        ...(requestLifetime ? { retireOnFinish: true } : {}),
        retire,
        async cancel() {
            if (released || !owns()) return;
            // Claude cancellation is physical close, so use the same irreversible fence.
            await retire(error('lease cancelled'));
        },
        release() {
            if (released) return;
            released = true;
            if (!owns()) return;
            delete entry.leaseOwner; delete holder.current;
            entry.busy = false; entry.lastUsedAt = Date.now(); entry.sessionId = session.nativeSessionId;
            if (entry.claude.retirement) { removeClosed(access, key, entry); access.wake(entry); return; }
            if (requestLifetime || entry.dead || !session.alive || !session.idle) {
                void retireClaudePoolEntry(access, key, entry,
                    error(requestLifetime ? 'request released' : 'released before idle')); return;
            }
            access.wake(entry);
        },
    };
}
function install(access: RuntimePoolAccess, key: string, creating: Creating, session: ClaudeSdkSession,
    child: ChildProcessWithoutNullStreams, holder: Holder, opts: ClaudeAcquireOptions): ClaudeLease {
    const runtime: ManagedRuntime = { get alive() { return session.alive; }, supportsInterrupt: true,
        close: () => session.close(), interrupt: () => session.cancel(), kill: () => session.kill(),
        onExit: cb => session.onExit(cb) };
    const entry: Ready = { state: 'ready', scopeKey: creating.scopeKey, runtime, sessionId: session.nativeSessionId,
        busy: true, dead: false, waiters: [], lastUsedAt: Date.now(), disposeExit: () => {}, nativeOwner: opts.persistenceOwner,
        claude: { session, child, holder, closedSuccessfully: false } };
    access.store.entries.set(key, entry);
    entry.disposeExit = runtime.onExit(() => {
        if (access.store.entries.get(key) !== entry) return;
        entry.dead = true;
        // Exit notification cannot undo an earlier failed close.
        void retireClaudePoolEntry(access, key, entry, error('session exited'));
        access.wake(entry);
    });
    access.wake(creating);
    return makeLease(access, key, entry, opts.binding, false, opts.lifetime === 'request');
}

async function create(access: RuntimePoolAccess, key: string, creating: Creating, opts: ClaudeAcquireOptions,
    deadline: number, check: () => void): Promise<ClaudeLease> {
    const controller = new AbortController(), holder: Holder = {};
    let candidate: ClaudeSdkSession | undefined, installedLease: ClaudeLease | undefined, interruptedSet = false;
    let rejectAbort!: (reason: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    void interrupted.catch(() => {});
    const abort = (reason: Error) => {
        if (interruptedSet) return;
        interruptedSet = true;
        controller.abort(reason); rejectAbort(reason);
    };
    const onAbort = () => abort(error('acquire aborted'));
    creating.abortCreate = () => abort(error('creation invalidated'));
    const timer = setTimeout(() => abort(error('acquire timed out')), remaining(deadline));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const verify = () => {
        check();
        if (controller.signal.aborted || access.store.entries.get(key) !== creating) throw error('creation invalidated');
    };
    const operation = Promise.resolve().then(async () => {
        try {
            verify();
            const config = sessionOptions(opts, holder, controller.signal);
            candidate = await (opts.createSession ?? createClaudeSdkSession)(config); verify();
            if (!candidate.alive || !candidate.idle) throw error('created session unavailable');
            const child = await Promise.race([
                candidate.waitForPrimaryChild({ timeoutMs: remaining(deadline), signal: controller.signal }), interrupted,
            ]);
            verify();
            if (!candidate.alive || !candidate.idle) throw error('created session unavailable');
            installedLease = install(access, key, creating, candidate, child, holder, opts);
            return installedLease;
        } catch (failure) {
            controller.abort(failure);
            // Known candidates close before removal. A failed or never-resolving factory
            // retains this same sentinel until its late result has physically closed.
            if (candidate && !installedLease) await candidate.close();
            // The public factory can fail its own startup cleanup before returning a
            // candidate. These SDK close failures still mean physical ownership is unknown.
            if (!candidate && failure instanceof Error
                && (failure.message === 'claude_close_failed' || failure.message === 'claude_close_timeout')) throw failure;
            remove(access, key, creating);
            throw failure;
        }
    });
    // A separate cleanup receipt has physical-close semantics even after caller timeout.
    creating.claudeCreation = operation.then(() => {}, failure => {
        if (access.store.entries.get(key) === creating) throw failure;
    });
    void creating.claudeCreation.catch(() => {});
    let lease: ClaudeLease | undefined;
    try {
        lease = await Promise.race([operation, interrupted]);
        check();
        if (!lease.runtime.alive) throw error('created session unavailable');
        return lease;
    } catch (failure) {
        // Abort can win the race synchronously inside installation's onExit registration.
        lease ??= installedLease;
        let cleanup = creating.claudeCreation;
        if (lease) {
            cleanup = lease.retire(error('admission invalidated'));
            lease.release();
            await Promise.race([cleanup, interrupted]).catch(() => {});
        }
        throw new ClaudeAcquireFailure(failure, cleanup);
    }
    finally {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
        // Keep abortCreate while a late factory still owns the sentinel.
        if (access.store.entries.get(key) !== creating) delete creating.abortCreate;
    }
}

async function borrow(access: RuntimePoolAccess, key: string, entry: Ready, opts: ClaudeAcquireOptions,
    deadline: number, check: () => void): Promise<ClaudeLease> {
    const lease = makeLease(access, key, entry, opts.binding, true), token = entry.leaseOwner;
    const controller = new AbortController();
    let rejectAbort!: (reason: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = (reason: Error) => { controller.abort(reason); rejectAbort(reason); };
    const onAbort = () => abort(error('acquire aborted'));
    const timer = setTimeout(() => abort(error('acquire timed out')), remaining(deadline));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        check();
        const child = await Promise.race([
            lease.session.waitForPrimaryChild({ timeoutMs: remaining(deadline), signal: controller.signal }), interrupted,
        ]);
        check();
        if (access.store.entries.get(key) !== entry || entry.leaseOwner !== token || entry.dead
            || !lease.session.alive || !lease.session.idle || child !== lease.child) throw error('lease invalidated');
        return lease;
    } catch (failure) {
        const cleanup = lease.retire(error('readiness invalidated'));
        lease.release();
        await Promise.race([cleanup, interrupted]).catch(() => {});
        throw new ClaudeAcquireFailure(failure, cleanup);
    } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); }
}

function snapshot(input: ClaudeAcquireOptions): ClaudeAcquireOptions {
    if (input.lifetime !== undefined && input.lifetime !== 'pooled' && input.lifetime !== 'request') throw error('invalid lifetime');
    timeout(input.waitMs ?? 60_000); timeout(input.promptTimeoutMs); timeout(input.closeTimeoutMs ?? 5000);
    for (const value of [input.scopeKey, input.chatSessionId, ...(input.workerId === undefined ? [] : [input.workerId])]) {
        if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw error('invalid identity');
    }
    if (!input.persistenceOwner || ![input.persistenceOwner.global, input.persistenceOwner.scope]
        .every(value => Number.isSafeInteger(value) && value >= 0)) throw error('invalid ownership');
    if (typeof input.isCurrentOwner !== 'function' || typeof input.canAcquire !== 'function'
        || typeof input.binding?.getTurnContext !== 'function') throw error('admission required');
    buildClaudeSdkOptions(input.prepared);
    if (input.storedSessionId != null && (typeof input.storedSessionId !== 'string'
        || !input.storedSessionId || input.storedSessionId.includes('\0'))) throw error('invalid resume');
    if (input.prepared.resumeSessionId && input.storedSessionId
        && input.prepared.resumeSessionId !== input.storedSessionId) throw error('contradictory resume');
    const prepared = { ...input.prepared, cwd: realpathSync(input.prepared.cwd), env: { ...input.prepared.env } };
    // The pinned SDK mutates these ambient defaults at import/query time. Seed
    // them before the first snapshot so that lazy loading cannot change its key.
    // Explicit values remain part of the profile and can still retire a query.
    if (prepared.env['NoDefaultCurrentDirectoryInExePath'] === undefined) prepared.env['NoDefaultCurrentDirectoryInExePath'] = '1';
    if (prepared.env['CLAUDE_AGENT_SDK_VERSION'] === undefined) prepared.env['CLAUDE_AGENT_SDK_VERSION'] = CLAUDE_AGENT_SDK_PINNED_VERSION;
    // A backgrounded task has no result this runtime can correlate, so observing
    // one ends the whole turn (claude_background_tasks_unsupported in
    // claude-sdk-session.ts). The PreToolUse hook only refuses an EXPLICIT
    // run_in_background:true, and Claude moves a long foreground Bash command to
    // the background on its own, which killed answered turns whose command then
    // completed normally seconds later. Disabling the feature at its source keeps
    // that command in the foreground instead. An explicit value is preserved and
    // remains part of the pooled profile.
    if (prepared.env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] === undefined) prepared.env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '1';
    if (input.forceNew) delete prepared.resumeSessionId;
    else if (input.storedSessionId) prepared.resumeSessionId = input.storedSessionId;
    return { ...input, prepared, persistenceOwner: Object.freeze({ ...input.persistenceOwner }), binding: { ...input.binding } };
}
function configKey(opts: ClaudeAcquireOptions, scope: string, requestNonce?: string): string {
    const { resumeSessionId: _resume, ...prepared } = opts.prepared;
    const sorted = (value: object) => Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const canonical = sorted({ ...prepared, env: sorted(prepared.env) });
    return createHmac('sha256', privateKey).update(JSON.stringify([scope, opts.chatSessionId,
        canonical, opts.promptTimeoutMs, opts.closeTimeoutMs ?? 5000,
        ...(requestNonce === undefined ? [] : ['request', requestNonce])])).digest('hex');
}

async function acquire(access: RuntimePoolAccess, input: ClaudeAcquireOptions): Promise<ClaudeLease> {
    const deadline = performance.now() + (input.waitMs ?? 60_000), opts = snapshot(input);
    const owner = opts.persistenceOwner;
    const check = () => {
        if (opts.signal?.aborted) throw error('acquire aborted');
        let current = false;
        try { current = opts.isCurrentOwner(owner) === true && opts.canAcquire() === true; } catch { /* fail closed */ }
        if (!current) throw error('ownership invalidated');
        if (performance.now() >= deadline) throw error('acquire timed out');
    };
    check();
    const scope = JSON.stringify([opts.scopeKey, opts.workerId === undefined ? ['main'] : ['worker', opts.workerId]]);
    const key = configKey(opts, scope, opts.lifetime === 'request' ? randomBytes(32).toString('hex') : undefined), { store } = access;
    const forced = new Set(opts.forceNew ? [...(store.scopeIndex.get(scope) ?? [])].map(k => store.entries.get(k)) : []);
    for (;;) {
        check();
        let blocked = false;
        for (const candidateKey of store.scopeIndex.get(scope) ?? []) {
            const candidate = store.entries.get(candidateKey);
            if (!candidate) continue;
            const invalidated = forced.has(candidate) || candidate.nativeOwner?.global !== owner.global
                || candidate.nativeOwner?.scope !== owner.scope;
            if (candidate.state === 'creating') {
                if (invalidated) void retireClaudePoolEntry(access, candidateKey, candidate, error('creation replaced'));
            } else {
                const entry = candidate as Ready;
                if (!entry.claude.retirement && !(entry.busy && !invalidated)) {
                    const resume = opts.storedSessionId ?? opts.prepared.resumeSessionId;
                    if (invalidated || candidateKey !== key || entry.dead || !entry.runtime.alive || !entry.claude.session.idle
                        || (resume && resume !== entry.sessionId)) {
                        void retireClaudePoolEntry(access, candidateKey, entry, error('entry stale'));
                    } else continue;
                }
            }
            if (store.entries.get(candidateKey) === candidate) {
                await access.wait(candidate, remaining(deadline), opts.signal); check();
            }
            blocked = true; break; // Rescan the whole scope after every await.
        }
        if (blocked) continue;
        const entry = store.entries.get(key);
        if (entry?.state === 'ready') return borrow(access, key, entry as Ready, opts, deadline, check);
        if (!entry) {
            const creating: Creating = { state: 'creating', scopeKey: scope, waiters: [], lastUsedAt: Date.now(), nativeOwner: owner };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(scope);
            if (!keys) { keys = new Set(); store.scopeIndex.set(scope, keys); }
            keys.add(key);
            return create(access, key, creating, opts, deadline, check);
        }
    }
}

export async function acquireClaudeRuntimeLease(access: RuntimePoolAccess, input: ClaudeAcquireOptions): Promise<ClaudeLease> {
    try { return await acquire(access, input); }
    catch (failure) {
        if (failure instanceof ClaudeAcquireFailure) throw failure;
        // Preflight and waiter failures have not borrowed or created a child.
        // Creation/readiness paths above carry their own physical-close receipt.
        throw new ClaudeAcquireFailure(failure, Promise.resolve());
    }
}
