import { RuntimeRequests } from '../agent/runtime/requests.js';
import type { RuntimeEventContext } from '../agent/runtime/events.js';
import type { RuntimeTranscriptObserver } from '../agent/runtime/projection.js';
import type { RuntimeEventBody, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { CodeTurnNormalizer, redactCodeText } from './normalize.js';
import type { CodeLiveSettings, CodeOpenOptions, CodeProvider, CodeProviderSession, CodeRuntimeResource, CodeTurnContext } from './provider.js';
import { CodeStore, CodeStoreError, type CodeSessionRecord, type CodeStoreOwner } from './store.js';
import type {
    CodeCancelRequest, CodeContextUsage, CodeItem, CodePermissionAnswer, CodePermissionMode, CodePermissionRequest,
    CodeSessionError, CodeWireEvent,
} from './wire.js';

const CLEANUP_TIMEOUT_MS = 2_000;
const OPEN_TIMEOUT_MS = 30_000;
const TRANSCRIPT_COALESCE_MS = 50;

export class CodeServiceError extends Error {
    readonly statusCode = 503;
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'CodeServiceError';
    }
}

interface Operation {
    owner: CodeStoreOwner;
    context: CodeTurnContext;
    binding: HandleBinding;
    registry: RuntimeRequests;
    normalizer: CodeTurnNormalizer | null;
    permissions: Map<string, CodePermissionRequest>;
    syncingPermissions: boolean;
    stopped: boolean;
    callbacksClosed: boolean;
    settled: boolean;
    failure: CodeSessionError | null;
    persistenceFailure: boolean;
    wake: () => void;
    interrupted: Promise<void>;
    work: Promise<void>;
}

type NativeConfiguration = Pick<CodeSessionRecord, 'provider' | 'cwd' | 'model' | 'effort' | 'permissionMode' | 'thinking'>;
interface HandleBinding {
    configuration: Readonly<NativeConfiguration>;
    controller: AbortController;
    opening: boolean;
    openingContext: CodeTurnContext | null;
    handle: CodeProviderSession | null;
    resources: Set<CodeRuntimeResource>;
    resourceCloses: Map<CodeRuntimeResource, Promise<boolean>>;
    retiring: boolean;
    exited: boolean;
    closed: boolean;
    cancelPromise: Promise<boolean> | null;
}

function sameConfiguration(a: NativeConfiguration, b: NativeConfiguration): boolean {
    return a.provider === b.provider && a.cwd === b.cwd && a.model === b.model
        && a.effort === b.effort && a.permissionMode === b.permissionMode && a.thinking === b.thinking;
}

function isResourceClosed(resource: CodeRuntimeResource): boolean {
    return resource.closed === true;
}

export interface CodeSessionOptions {
    sessionId: string;
    store: CodeStore;
    provider: CodeProvider;
    publish: (event: CodeWireEvent) => void;
    now: () => number;
    changed: () => void;
}

/** A resident native handle and registry outlive each separately captured Code turn. */
export class CodeSession {
    private operation: Operation | null = null;
    private binding: HandleBinding | null = null;
    /**
     * Latest usage the live runtime reported, held only for as long as this
     * service is up. It is not persisted: it describes a native process, and a
     * number that outlived that process would be a claim about a session that
     * no longer holds.
     */
    private usage: CodeContextUsage | null = null;
    private readonly bindings = new Set<HandleBinding>();
    private readonly registry = new RuntimeRequests(() => {
        if (this.operation) this.syncPermissions(this.operation);
    });
    private disposed = false;
    private disposePromise: Promise<void> | null = null;
    private persistenceError: CodeServiceError | null = null;
    private settingsChange = false;
    lastUsedAt: number;

    constructor(private readonly options: CodeSessionOptions) {
        this.lastUsedAt = options.now();
    }

    get busy(): boolean { return this.settingsChange || (this.operation !== null && !this.operation.settled); }
    get reconfiguring(): boolean { return this.settingsChange; }

    /**
     * Run a live settings change with admission held off: the session reads busy from this
     * check through the caller's store write and any rollback, so no prompt, attach or
     * second change lands between the runtime switch and the stored row.
     */
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
        if (this.busy) throw new CodeStoreError('session_busy', 'Stop the current turn before changing session settings', 409);
        this.settingsChange = true;
        try { return await work(); }
        finally { this.settingsChange = false; this.options.changed(); }
    }

    /**
     * Switch the resident runtime's permission mode in place. 'deferred' means there is
     * no live handle to switch; the next open reads the stored mode instead.
     */
    async applyPermissionMode(mode: CodePermissionMode): Promise<'applied' | 'deferred'> {
        const binding = this.binding;
        const handle = binding?.handle;
        if (!binding || !handle || handle.alive !== true || handle.closed === true || binding.retiring || binding.exited) return 'deferred';
        if (!handle.setPermissionMode) throw new Error('code_permission_mode_unavailable');
        await handle.setPermissionMode(mode);
        binding.configuration = Object.freeze({ ...binding.configuration, permissionMode: mode });
        return 'applied';
    }

    /**
     * Change model and effort on the resident runtime in place. The binding moves only
     * once the runtime confirmed, so a refused change leaves it describing the process
     * that is actually running. 'deferred' means no live handle; 'unsupported' means a
     * live handle that can only be retired.
     */
    async reconfigure(next: CodeLiveSettings): Promise<'applied' | 'deferred' | 'unsupported'> {
        const binding = this.binding;
        const handle = binding?.handle;
        if (!binding || !handle || handle.alive !== true || handle.closed === true || binding.retiring || binding.exited) return 'deferred';
        if (!handle.reconfigure) return 'unsupported';
        const current = binding.configuration;
        await handle.reconfigure(next, { model: current.model, effort: current.effort });
        binding.configuration = Object.freeze({ ...current, model: next.model, effort: next.effort });
        // The figure is a proportion of the previous model's window.
        if (next.model !== current.model) this.usage = null;
        return 'applied';
    }
    get resident(): boolean {
        this.reconcileBindings();
        return [...this.bindings].some(binding => binding.opening || this.hasOpenResources(binding));
    }
    get poisoned(): boolean { return this.persistenceError !== null; }
    get closing(): boolean { return this.disposed; }
    get cleanupPending(): boolean {
        this.reconcileBindings();
        return [...this.bindings].some(binding => binding.opening
            || (binding.retiring && this.hasOpenResources(binding)));
    }

    private hasOpenResources(binding: HandleBinding): boolean {
        return [...binding.resources].some(resource => resource.closed !== true);
    }

    private reconcileBindings(): void {
        for (const binding of this.bindings) {
            if (binding.handle?.closed === true && !binding.retiring && !binding.exited) this.onExit(binding);
            if (binding.opening || this.hasOpenResources(binding)
                || (binding.resources.size === 0 && !binding.retiring)) continue;
            // Physical proof retires residency without changing the cached close result.
            binding.closed = true;
            binding.retiring = true;
            if (this.binding === binding) this.usage = null;
            this.bindings.delete(binding);
        }
    }

    assertHealthy(): void {
        if (this.persistenceError) throw this.persistenceError;
    }

    private diagnostic(code: string, message: string): CodeSessionError {
        return { code, message, at: this.options.now(), recoverable: true };
    }

    private owns(op: Operation): boolean {
        if (this.operation !== op || this.disposed) return false;
        try {
            const row = this.options.store.readRecord(this.options.sessionId);
            return row?.epoch === op.owner.epoch && row.turnId === op.owner.turnId;
        } catch (error) { this.failPersistence(op, error); return false; }
    }

    private current(op: Operation, context?: RuntimeEventContext): boolean {
        if (op.callbacksClosed || op.settled || op.stopped || op.failure || op.persistenceFailure) return false;
        if (this.binding !== op.binding || op.binding.retiring || op.binding.closed || op.binding.exited || op.binding.controller.signal.aborted) return false;
        if (context && (context.audience !== 'internal' || context.runId !== op.context.runId || context.sessionId !== op.context.sessionId
            || context.scope !== op.context.scope || context.turnId !== op.context.turnId
            || ('epoch' in context && context.epoch !== op.owner.epoch))) return false;
        return this.owns(op);
    }

    private failPersistence(op: Operation, error: unknown): void {
        if (op.persistenceFailure) return;
        if (error instanceof CodeStoreError && (error.code === 'transcript_limit' || error.code === 'event_too_large')) {
            if (op.failure?.code === 'transcript_limit') return;
            op.failure = this.diagnostic('transcript_limit', 'Code transcript storage limit reached');
        } else {
            op.persistenceFailure = true;
            this.persistenceError = new CodeServiceError('persistence_failed', 'Code session persistence failed');
            op.failure = this.diagnostic('persistence_failed', 'Code session persistence failed');
        }
        this.interrupt(op);
        void this.cleanup(op.binding, true).catch(() => console.warn('[code] cleanup_failed'));
    }

    private write<T>(op: Operation, action: () => T): T {
        try { return action(); }
        catch (error) { this.failPersistence(op, error); throw error; }
    }

    private publish(events: CodeWireEvent[]): void {
        for (const event of events) {
            try {
                void Promise.resolve(this.options.publish(event)).catch(() => console.warn('[code] subscriber_failed'));
            } catch { console.warn('[code] subscriber_failed'); }
        }
    }

    private commitItem(op: Operation, item: CodeItem): { publish(): void } | null {
        if (!this.current(op)) return null;
        const result = this.write(op, () => this.options.store.commitItem(op.owner, item));
        return { publish: () => this.publish(result.events) };
    }

    private sealAndDrainAccepted(op: Operation): void {
        op.callbacksClosed = true;
        const binding = op.binding;
        const owner = Object.freeze({ ...op.owner });
        try {
            const batch = op.normalizer?.sealAccepted() ?? [];
            for (const item of batch) {
                // Terminal persistence owns only this captured turn, even when
                // Stop/disposal has already revoked native callback admission.
                if (this.operation !== op || this.binding !== binding || op.settled || owner.turnId === null
                    || op.persistenceFailure || this.persistenceError || op.failure?.code === 'transcript_limit') return;
                const row = this.options.store.readRecord(owner.sessionId);
                if (!row || row.sessionId !== owner.sessionId || row.epoch !== owner.epoch || row.turnId !== owner.turnId
                    || row.archivedAt !== null || !['starting', 'streaming', 'stopping'].includes(row.status)) return;
                const result = this.write(op, () => this.options.store.commitItem(owner, item));
                this.publish(result.events);
                // Reentrant publication can revoke ownership or fail storage;
                // the next item must obtain its own fresh authority above.
            }
        } catch (error) { this.failPersistence(op, error); }
    }

    private interrupt(op: Operation): void {
        this.sealAndDrainAccepted(op);
        op.wake();
        op.registry.cancelRun(op.context.runId);
        op.binding.retiring = true;
        op.binding.controller.abort();
    }

    /** Install ownership synchronously, before admission events can call subscribers. */
    start(record: CodeSessionRecord, text: string | null): void {
        if (this.operation) this.registry.cancelRun(this.operation.context.runId);
        const previous = this.binding;
        const reuse = previous !== null && previous.handle?.alive === true && previous.handle.closed !== true && !previous.retiring
            && !previous.exited && !previous.controller.signal.aborted && sameConfiguration(previous.configuration, record);
        const binding: HandleBinding = reuse && previous ? previous : {
            configuration: Object.freeze({ provider: record.provider, cwd: record.cwd, model: record.model,
                effort: record.effort, permissionMode: record.permissionMode, thinking: record.thinking }),
            controller: new AbortController(), opening: false, openingContext: null,
            handle: null, resources: new Set(), resourceCloses: new Map(),
            retiring: false, exited: false, closed: false, cancelPromise: null,
        };
        if (previous && !reuse) previous.retiring = true;
        this.binding = binding;
        // A usage figure belongs to the runtime that reported it. Replacing the
        // runtime without reusing it means the numbers describe a process that
        // is being retired, so they stop being an answer about this session.
        if (previous && !reuse) this.usage = null;
        this.bindings.add(binding);
        const owner = { sessionId: record.sessionId, turnId: record.turnId, epoch: record.epoch };
        let wake!: () => void;
        const interrupted = new Promise<void>(resolve => { wake = resolve; });
        const context: CodeTurnContext = Object.freeze({
            runId: `code:${record.sessionId}:${record.epoch}`, sessionId: record.sessionId,
            scope: `code:${record.sessionId}`, turnId: record.turnId ?? `attach:${record.epoch}`,
            epoch: record.epoch, audience: 'internal', isCurrent: () => this.current(op),
        });
        const op: Operation = {
            owner, context, binding, registry: this.registry,
            normalizer: null, permissions: new Map(), syncingPermissions: false,
            stopped: false, callbacksClosed: false, settled: false, failure: null, persistenceFailure: false,
            interrupted, wake, work: Promise.resolve(),
        };
        this.operation = op;
        this.lastUsedAt = this.options.now();
        // Defer even synchronous factory callbacks until the caller has its receipt.
        op.work = Promise.resolve().then(async () => {
            if (record.turnId !== null) op.normalizer = new CodeTurnNormalizer({
                context, now: this.options.now, coalesceMs: TRANSCRIPT_COALESCE_MS,
                commitItem: item => this.commitItem(op, item),
                failPersistence: error => this.failPersistence(op, error),
            });
            await this.run(op, record, text, reuse ? null : previous);
        }).catch(async error => {
            this.failPersistence(op, error);
            await this.finish(op, null);
        });
    }

    private async bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([promise, new Promise<undefined>(resolve => {
                timer = setTimeout(() => resolve(undefined), ms);
            })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
    }

    private registerResource(binding: HandleBinding, resource: CodeRuntimeResource): void {
        // Resource ownership survives turn cancellation, open rejection and manager disposal.
        binding.resources.add(resource);
        binding.closed = false;
        this.bindings.add(binding);
        if (binding.retiring || binding.controller.signal.aborted || this.disposed || this.binding !== binding) {
            void this.cleanup(binding, true).catch(() => console.warn('[code] cleanup_failed'));
        }
        this.options.changed();
    }

    private closeResource(binding: HandleBinding, resource: CodeRuntimeResource): Promise<boolean> {
        const previous = binding.resourceCloses.get(resource);
        if (previous) return previous;
        const closing = Promise.resolve().then(async () => {
            try {
                if (isResourceClosed(resource)) return true;
                if (resource === binding.handle && binding.cancelPromise) {
                    await this.bounded(binding.cancelPromise, CLEANUP_TIMEOUT_MS);
                }
                await resource.close();
                return isResourceClosed(resource);
            } catch { console.warn('[code] native_close_failed'); return false; }
            finally { this.reconcileBindings(); this.options.changed(); }
        });
        binding.resourceCloses.set(resource, closing);
        return closing;
    }

    private async cleanup(binding: HandleBinding, cancel: boolean): Promise<boolean> {
        binding.retiring = true;
        // Retiring the runtime that produced the figure retires the figure.
        // Disposal, an idle reap and a model change all arrive here, and none
        // of them reach onExit's clear because they set `retiring` first.
        if (this.binding === binding) this.usage = null;
        binding.controller.abort();
        const handle = binding.handle;
        if (cancel && handle && !handle.closed && !binding.cancelPromise && !binding.resourceCloses.has(handle)) {
            binding.cancelPromise = Promise.resolve().then(() => handle.cancel()).then(() => true,
                () => { console.warn('[code] native_cancel_failed'); return false; });
        }
        const results = await this.bounded(Promise.all([...binding.resources].map(resource =>
            this.closeResource(binding, resource))), CLEANUP_TIMEOUT_MS * 2);
        this.reconcileBindings();
        return results !== undefined && results.every(Boolean) && !binding.opening && !this.hasOpenResources(binding);
    }

    private onExit(binding: HandleBinding): void {
        // Before the guards, not after: a runtime that is retiring, already
        // exited, superseded or disposed is exactly the case where its last
        // measurement stops describing anything, and every one of those
        // returns early below.
        if (this.binding === binding) this.usage = null;
        if (binding.retiring || binding.exited || this.binding !== binding || this.disposed) return;
        const op = this.operation;
        if (!op || op.binding !== binding) return;
        if (!op.settled) {
            if (!this.current(op)) return;
            binding.exited = true;
            op.failure = this.diagnostic('native_exit', 'Code provider exited before completing the turn');
            this.interrupt(op);
            return;
        }
        binding.exited = true;
        binding.retiring = true;
        // A no-op metadata patch may advance the idle epoch without changing this handle.
        try {
            const row = this.options.store.readRecord(this.options.sessionId);
            if (row && row.turnId === null && row.archivedAt === null && sameConfiguration(row, binding.configuration)) {
                const result = this.options.store.setRuntimeState({ sessionId: row.sessionId, epoch: row.epoch, turnId: null }, 'failed',
                    this.diagnostic('native_exit', 'Idle Code provider exited'));
                this.publish(result.events);
            }
        } catch (error) { this.failPersistence(op, error); }
        void this.cleanup(binding, false).catch(() => console.warn('[code] cleanup_failed'));
    }

    private operationFor(binding: HandleBinding, context?: RuntimeEventContext): Operation | null {
        const op = this.operation;
        return op && op.binding === binding && this.current(op, context) ? op : null;
    }

    private transcript(binding: HandleBinding, context: RuntimeEventContext): RuntimeTranscriptObserver {
        const captured = Object.freeze({ ...context });
        const op = this.operationFor(binding, captured);
        let observer: RuntimeTranscriptObserver | undefined;
        try { observer = op?.normalizer?.observer(captured); }
        catch (error) { if (op) this.failPersistence(op, error); }
        return {
            text: (...args) => {
                if (!op || this.operationFor(binding, captured) !== op) return;
                try { observer?.text(...args); } catch (error) { this.failPersistence(op, error); }
            },
            tool: (...args) => {
                if (!op || this.operationFor(binding, captured) !== op) return;
                try { observer?.tool(...args); } catch (error) { this.failPersistence(op, error); }
            },
            close: end => {
                if (!op || this.operationFor(binding, captured) !== op) return;
                try { observer?.close(end); } catch (error) { this.failPersistence(op, error); }
            },
        };
    }

    private openOptions(binding: HandleBinding, record: CodeSessionRecord): CodeOpenOptions {
        return {
            sessionId: record.sessionId, cwd: record.cwd, model: record.model,
            effort: record.effort, permissionMode: record.permissionMode, thinking: record.thinking,
            nativeCursor: record.nativeCursor,
            signal: binding.controller.signal, registry: this.registry,
            onResource: resource => this.registerResource(binding, resource),
            getTurnContext: () => {
                const op = this.operationFor(binding);
                if (!op) throw new CodeStoreError('stale_owner', 'Code handle has no current turn', 409);
                return op.context;
            },
            record: (context, body) => {
                const op = this.operationFor(binding, context);
                return op ? this.record(op, context, body) : null;
            },
            transcript: context => this.transcript(binding, context),
            resolveTranscriptParent: (context, ref) => {
                const op = this.operationFor(binding, context);
                if (!op) return null;
                try { return op.normalizer?.resolveParent(context, ref) ?? null; }
                catch (error) { this.failPersistence(op, error); return null; }
            },
            onNativeCursor: (cursor, context) => {
                // Missing startup metadata is not evidence that native input was dispatched.
                if (cursor === null) return;
                // Unscoped metadata is attributable only while this handle is opening.
                const captured = context ?? binding.openingContext;
                if (!captured) return;
                const op = this.operationFor(binding, captured);
                if (!op) return;
                try {
                    const result = this.write(op, () => this.options.store.writeNativeCursor(op.owner, cursor));
                    this.publish(result.events);
                } catch (error) { this.failPersistence(op, error); }
            },
            onContextUsage: usage => {
                // Only the handle that currently owns this session, and is not
                // on its way out, may speak for it. A binding can still be
                // `this.binding` while retiring, and a report from a runtime
                // being torn down is not news about the session.
                if (this.binding !== binding || binding.retiring || binding.exited || this.disposed) return;
                this.usage = usage;
            },
            onExit: () => this.onExit(binding),
        };
    }

    contextUsage(): CodeContextUsage | null {
        return this.usage;
    }

    private record(op: Operation, context: RuntimeEventContext, body: RuntimeEventBody) {
        if (!this.current(op, context) || !op.normalizer) return null;
        try {
            if (body.kind === 'request' && body.requestType === 'question') {
                op.failure = this.diagnostic('unsupported_request', 'Code provider requested an unsupported question');
                this.interrupt(op);
                return null;
            }
            if (body.kind === 'request' || body.kind === 'request-settled') this.syncPermissions(op);
            if (!this.current(op, context)) return null;
            if (body.kind === 'request') {
                // Only the live registry can introduce actionable permission rows.
                return op.permissions.has(body.requestId)
                    ? op.normalizer.record(op.context, body)
                    : op.normalizer.record(op.context, { kind: 'request-settled', requestId: body.requestId });
            }
            if (body.kind === 'request-settled') return op.normalizer.record(op.context, body);
            return op.normalizer.record(context, body);
        } catch (error) { this.failPersistence(op, error); return null; }
    }

    private async open(op: Operation, record: CodeSessionRecord): Promise<CodeProviderSession | null> {
        if (record.nativeStarted && (!record.nativeCursor || !record.capabilities.resume)) {
            throw new CodeStoreError('resume_unavailable', 'Code session cannot resume native history', 409);
        }
        const binding = op.binding;
        if (!this.current(op)) return null;
        binding.opening = true;
        binding.openingContext = op.context;
        const opening = Promise.resolve().then(() => this.current(op)
            ? this.options.provider.open(this.openOptions(binding, record)) : null).then(async handle => {
            binding.opening = false;
            binding.openingContext = null;
            binding.handle = handle;
            if (handle) this.registerResource(binding, handle);
            if (handle && !this.current(op)) await this.cleanup(binding, true);
            return handle;
        }).finally(() => { binding.opening = false; binding.openingContext = null; this.options.changed(); });
        const opened = await this.bounded(Promise.race([opening, op.interrupted.then(() => null)]), OPEN_TIMEOUT_MS);
        if (!this.current(op)) return null;
        if (!opened) throw new CodeServiceError('native_open_failed', 'Code provider did not open within the startup deadline');
        if (!opened.alive) throw new CodeServiceError('native_exit', 'Code provider exited during startup');
        if (opened.nativeSessionId) {
            const cursor = this.write(op, () => this.options.store.writeNativeCursor(op.owner, opened.nativeSessionId));
            this.publish(cursor.events);
        }
        return opened;
    }

    private async run(op: Operation, record: CodeSessionRecord, text: string | null, previous: HandleBinding | null): Promise<void> {
        let outcome: RuntimeTurnOutcome | null = null;
        try {
            if (previous && !await this.cleanup(previous, false)) {
                throw new CodeServiceError('cleanup_pending', 'Previous Code runtime has not closed');
            }
            if (!this.current(op)) return;
            const handle = op.binding.handle ?? await this.open(op, record);
            if (!handle || !this.current(op)) return;
            if (!handle.alive) throw new CodeServiceError('native_exit', 'Code provider exited before dispatch');
            if (!this.current(op)) return;
            if (text === null) return;
            const streaming = this.write(op, () => this.options.store.setRuntimeState(op.owner, 'streaming'));
            this.publish(streaming.events);
            if (!this.current(op)) return;
            outcome = await Promise.race([Promise.resolve().then(() => {
                if (!this.current(op)) return null;
                if (!handle.nativeSessionId) {
                    // Commit the ambiguity marker before native input can leave this process.
                    // A stored cursor, including one just reported by a callback, is preserved.
                    const started = this.write(op, () => this.options.store.writeNativeCursor(op.owner, null));
                    this.publish(started.events);
                    if (!this.current(op)) return null;
                }
                return handle.send(text);
            }), op.interrupted.then(() => null)]);
        } catch (error) {
            if (!op.stopped && !op.failure) op.failure = this.diagnostic(
                error instanceof CodeServiceError || error instanceof CodeStoreError ? error.code : 'native_failed',
                'Code provider operation failed');
        } finally {
            await this.finish(op, outcome);
        }
    }

    private async finish(op: Operation, outcome: RuntimeTurnOutcome | null): Promise<void> {
        if (op.settled) return;
        if (op.stopped || op.failure || op.persistenceFailure) this.sealAndDrainAccepted(op);
        try {
            // Healthy completion still owns outcome normalization; interrupted
            // turns have already sealed their accepted content above.
            op.normalizer?.finish(outcome ?? { status: op.stopped ? 'stopped' : 'error', finalText: null, partialText: '' });
        } catch (error) { this.failPersistence(op, error); }
        if (outcome?.status === 'error' && !op.failure) {
            op.failure = this.diagnostic('native_failed', op.binding.handle?.lastTurnFailureText ?? 'Code provider turn failed');
        }
        // Normalization can publish to a subscriber that cancels this very turn.
        if (op.failure || op.stopped || op.persistenceFailure || outcome?.status === 'stopped') {
            this.interrupt(op);
            await this.cleanup(op.binding, true);
        }
        op.settled = true;
        op.registry.cancelRun(op.context.runId);
        op.permissions.clear();
        try {
            const status = op.failure || op.persistenceFailure || outcome?.status === 'error' ? 'failed'
                : op.stopped || outcome?.status === 'stopped' ? 'cancelled' : 'completed';
            const error = op.failure ?? (status === 'failed'
                ? this.diagnostic('native_failed', 'Code provider turn failed') : null);
            const result = op.owner.turnId === null
                ? this.options.store.setRuntimeState(op.owner, status === 'failed' ? 'failed' : 'idle', error)
                : this.options.store.settleTurn(op.owner, { status, error });
            // A durable failed terminal restores reads; the captured turn latch stays closed.
            if (op.persistenceFailure && result.session.status === 'failed' && this.operation === op) {
                this.persistenceError = null;
            }
            this.publish(result.events);
        } catch (error) { this.failPersistence(op, error); }
        this.lastUsedAt = this.options.now();
        this.options.changed();
    }

    private syncPermissions(op: Operation): void {
        if (op.syncingPermissions || !this.current(op) || !op.owner.turnId) return;
        op.syncingPermissions = true;
        try {
            const entries = op.registry.list(this.options.sessionId);
            const live = new Set<string>();
            for (const entry of entries) {
                if (entry.runId !== op.context.runId || entry.scope !== op.context.scope || entry.turnId !== op.context.turnId) continue;
                const field = entry.view.fields[0];
                if (entry.requestType !== 'approval' || entry.view.fields.length !== 1 || !field
                    || field.multiSelect || field.allowFreeform || field.options.length === 0) {
                    op.failure = this.diagnostic('unsupported_request', 'Code provider requested an unsupported question or permission shape');
                    this.interrupt(op);
                    return;
                }
                live.add(entry.requestId);
                if (op.permissions.has(entry.requestId)) continue;
                const permission: CodePermissionRequest = {
                    permissionId: entry.requestId, sessionId: this.options.sessionId,
                    turnId: op.owner.turnId, epoch: op.owner.epoch, title: redactCodeText(entry.view.title),
                    detail: redactCodeText(field.label), requestedAt: this.options.now(),
                    options: field.options.map(option => ({ optionId: option.id, label: redactCodeText(option.label), kind: 'approval' })),
                };
                op.permissions.set(entry.requestId, permission);
                op.normalizer?.record(op.context, { kind: 'request', requestId: entry.requestId,
                    requestType: 'approval', view: entry.view });
            }
            for (const [id] of op.permissions) {
                if (live.has(id)) continue;
                op.permissions.delete(id);
                op.normalizer?.record(op.context, { kind: 'request-settled', requestId: id });
            }
        } catch (error) { this.failPersistence(op, error); }
        finally { op.syncingPermissions = false; }
    }

    pendingPermissions(): CodePermissionRequest[] {
        const op = this.operation;
        if (!op || !this.current(op)) return [];
        this.syncPermissions(op);
        this.assertHealthy();
        const currentIds = new Set(op.registry.list(this.options.sessionId).filter(entry =>
            entry.runId === op.context.runId && entry.turnId === op.context.turnId
            && entry.scope === op.context.scope).map(entry => entry.requestId));
        return this.current(op) ? structuredClone([...op.permissions.values()].filter(permission =>
            currentIds.has(permission.permissionId))) : [];
    }

    answerPermission(permissionId: string, input: CodePermissionAnswer): void {
        this.assertHealthy();
        const op = this.operation;
        if (!op || !this.current(op) || input.sessionId !== this.options.sessionId
            || input.epoch !== op.owner.epoch || input.turnId !== op.owner.turnId) {
            throw new CodeStoreError('request_not_current', 'Code permission is no longer current', 409);
        }
        this.syncPermissions(op);
        this.assertHealthy();
        if (!op.permissions.get(permissionId)?.options.some(option => option.optionId === input.optionId)) {
            throw new CodeStoreError('invalid_option', 'Code permission option is not current', 409);
        }
        try { op.registry.respond(permissionId, op.context, { optionId: input.optionId }); }
        catch { throw new CodeStoreError('request_not_current', 'Code permission is no longer current', 409); }
        this.assertHealthy();
    }

    async cancel(input: CodeCancelRequest): Promise<void> {
        this.assertHealthy();
        const op = this.operation;
        if (!op || op.owner.turnId !== input.turnId || op.owner.epoch !== input.epoch) {
            throw new CodeStoreError('stale_owner', 'Code turn ownership has changed', 409);
        }
        if (op.settled) return;
        if (!op.stopped) {
            op.stopped = true;
            try {
                this.sealAndDrainAccepted(op);
                const result = this.write(op, () => this.options.store.setRuntimeState(op.owner, 'stopping'));
                this.publish(result.events);
            } finally { this.interrupt(op); }
        }
        await op.work;
        this.assertHealthy();
    }

    async wait(): Promise<void> {
        await this.operation?.work;
        this.assertHealthy();
    }

    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        this.registry.setChangeObserver(undefined);
        const op = this.operation;
        // Install the receipt before synchronous drain publication can dispose again.
        this.disposePromise = Promise.resolve().then(async () => {
            if (op) await op.work;
            await Promise.all([...this.bindings].map(binding => this.cleanup(binding, true)));
            this.options.changed();
        }).catch(() => console.warn('[code] dispose_failed'));
        if (op && !op.settled) { op.stopped = true; this.interrupt(op); }
        return this.disposePromise;
    }
}
