import { CodeSession, CodeServiceError } from './session.js';
import { CodeStore, CodeStoreError, type CodeSessionListOptions, type CodeSessionRecord } from './store.js';
import type { CodeProviders } from './provider.js';
import { DEFAULT_CODE_SETTINGS } from './types.js';
import type {
    CodeCancelRequest, CodeCapabilities, CodeCreateSessionRequest, CodeEventsPage, CodeHistoryPage,
    CodeModelCatalog, CodePatchSessionRequest, CodePermissionAnswer, CodePromptReceipt,
    CodePromptRequest, CodeProviderCatalog, CodeProviderId, CodeSessionInfo, CodeSnapshot, CodeSteerRequest, CodeWireEvent,
} from './wire.js';

export { CodeServiceError } from './session.js';
export type { CodeSessionListOptions } from './store.js';

const PROVIDER_IDS: readonly CodeProviderId[] = ['codex-app', 'claude', 'cursor', 'grok'];

export interface CodeSessionManagerOptions {
    store: CodeStore;
    providers: CodeProviders;
    publish: (event: CodeWireEvent) => void;
    maxConcurrentSessions?: number;
    idleReapMs?: number;
    now?: () => number;
}

/** Injectable composition owner. Construction neither reads storage nor starts runtimes. */
export class CodeSessionManager {
    private readonly sessions = new Map<string, CodeSession>();
    private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly maxConcurrentSessions: number;
    private readonly idleReapMs: number;
    private readonly now: () => number;
    private recovered = false;
    private admitted = false;
    private disposed = false;
    private disposePromise: Promise<void> | null = null;

    constructor(private readonly options: CodeSessionManagerOptions) {
        this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_CODE_SETTINGS.maxConcurrentSessions;
        this.idleReapMs = options.idleReapMs ?? DEFAULT_CODE_SETTINGS.idleReapMs;
        this.now = options.now ?? Date.now;
        if (!Number.isSafeInteger(this.maxConcurrentSessions) || this.maxConcurrentSessions < 1
            || !Number.isSafeInteger(this.idleReapMs) || this.idleReapMs < 0) {
            throw new CodeStoreError('invalid_limits', 'Code capacity and idle timeout must be nonnegative integers with positive capacity', 400);
        }
    }

    private ready(): void {
        if (this.disposed) throw new CodeServiceError('manager_disposed', 'Code session manager is disposed');
        this.reconcileSessions();
    }

    private storage<T>(action: () => T): T {
        try { return action(); }
        catch (error) {
            if (error instanceof CodeStoreError || error instanceof CodeServiceError) throw error;
            throw new CodeServiceError('persistence_failed', 'Code storage is unavailable');
        }
    }

    private record(id: string): CodeSessionRecord {
        const record = this.storage(() => this.options.store.readRecord(id));
        if (!record) throw new CodeStoreError('session_not_found', 'Code session not found', 404);
        return record;
    }

    private publish(events: CodeWireEvent[]): void {
        for (const event of events) {
            try {
                void Promise.resolve(this.options.publish(event)).catch(() => console.warn('[code] subscriber_failed'));
            } catch { console.warn('[code] subscriber_failed'); }
        }
    }

    private catalog(id: CodeProviderId): CodeProviderCatalog {
        const provider = this.options.providers[id];
        if (!provider || provider.id !== id) throw new CodeStoreError('unsupported_provider', 'Code provider is unsupported', 400);
        return provider.describe();
    }

    /**
     * `fixed` carries an existing session's stored capabilities. `accepted`
     * names the values that session already runs with: a Codex catalog is live
     * now, so its model list can shift under a running session, and rejecting a
     * value that was legal at creation would break prompt, attach and patch for
     * a reason the user can neither see nor act on. A value the caller is
     * newly choosing is always checked against what the runtime serves today.
     */
    private validate(input: Pick<CodeCreateSessionRequest, 'provider' | 'model' | 'effort' | 'permissionMode'>
        & { thinking?: boolean | null }, fixed?: CodeCapabilities,
        accepted?: Pick<CodeCreateSessionRequest, 'model' | 'effort' | 'permissionMode'>): CodeProviderCatalog {
        const catalog = this.catalog(input.provider);
        if (!catalog.available) throw new CodeServiceError('provider_unavailable', 'Code provider is unavailable');
        const keptModel = accepted !== undefined && accepted.model === input.model;
        if (!keptModel && !catalog.models.includes(input.model)) {
            throw new CodeStoreError('unsupported_model', 'Code model is unsupported', 400);
        }
        const keptEffort = keptModel && accepted !== undefined && accepted.effort === input.effort;
        if (input.provider !== 'claude' && typeof input.thinking === 'boolean') {
            throw new CodeStoreError('unsupported_capability', 'Thinking is only switchable for Claude sessions', 400);
        }
        if (input.provider === 'claude') {
            // Claude modes switch live, so a newly chosen mode answers to the live catalog
            // alone; the mode a session already runs with may also stand on its snapshot.
            const kept = accepted !== undefined && accepted.permissionMode === input.permissionMode;
            const allowed = catalog.capabilities.permissionModes.includes(input.permissionMode)
                || (kept && fixed?.permissionModes.includes(input.permissionMode) === true);
            if (!allowed) throw new CodeStoreError('unsupported_policy', 'Code permission mode is unsupported', 400);
        }
        for (const capabilities of fixed ? [fixed, catalog.capabilities] : [catalog.capabilities]) {
            if (input.provider !== 'claude' && !capabilities.permissionModes.includes(input.permissionMode)) {
                throw new CodeStoreError('unsupported_policy', 'Code permission mode is unsupported', 400);
            }
            // A kept effort skips the live union for the same reason a kept model
            // skips the live model list: the catalog moves under a running session.
            // The session's own stored capabilities still apply, since those are
            // the contract the native runtime was opened with.
            const live = capabilities === catalog.capabilities;
            if (input.effort !== null && !(keptEffort && live) && !capabilities.efforts.includes(input.effort)) {
                throw new CodeStoreError('unsupported_effort', 'Code effort is unsupported', 400);
            }
        }
        // The union above is the widest legal set. When the runtime publishes a
        // per-model set, narrow to it: routed models often accept no effort at
        // all while a sibling model reaches `ultra`, and the chosen value is
        // forwarded to the native wire.
        const perModel = keptEffort ? undefined : catalog.effortsByModel?.[input.model];
        if (input.effort !== null && perModel && !perModel.includes(input.effort)) {
            throw new CodeStoreError('unsupported_effort', 'Code effort is unsupported', 400);
        }
        return catalog;
    }

    create(input: CodeCreateSessionRequest): CodeSessionInfo {
        this.ready();
        const catalog = this.validate(input);
        const result = this.storage(() => this.options.store.create({ ...input, capabilities: catalog.capabilities }));
        this.publish(result.events);
        return result.session;
    }

    list(options?: CodeSessionListOptions): CodeSessionInfo[] {
        this.ready();
        return this.storage(() => this.options.store.list(options)).map(row => {
            const service = this.sessions.get(row.sessionId);
            const cleanupPending = this.cleanupReadout(row.sessionId, service);
            try {
                const usage = service?.contextUsage() ?? null;
                return { ...row, cleanupPending, pendingPermissionCount: service?.pendingPermissions().length ?? 0,
                    ...(usage ? { contextUsage: usage } : {}) };
            }
            catch { return { ...row, cleanupPending }; } // An unavailable attention read stays unknown, never inferred zero.
        });
    }

    snapshot(id: string): CodeSnapshot {
        this.ready();
        const session = this.sessions.get(id);
        session?.assertHealthy();
        // Registry pruning can commit settled permission items; do it before capturing H.
        const pendingPermissions = session?.pendingPermissions() ?? [];
        const snapshot = this.storage(() => this.options.store.snapshot(id));
        const current = pendingPermissions.filter(permission =>
            permission.turnId === snapshot.session.turnId && permission.epoch === snapshot.session.epoch);
        // Reading the residue can release a closed runtime and its usage; do it first.
        const cleanupPending = this.cleanupReadout(id, session);
        const usage = session?.contextUsage() ?? null;
        return { ...snapshot, session: { ...snapshot.session, cleanupPending,
            pendingPermissionCount: current.length,
            ...(usage ? { contextUsage: usage } : {}) }, pendingPermissions: current };
    }

    history(id: string, beforeSequence?: number, limit?: number): CodeHistoryPage {
        this.ready();
        return this.storage(() => this.options.store.history(id, beforeSequence, limit));
    }

    readEvents(id: string, afterSequence?: number, limit?: number): CodeEventsPage {
        this.ready();
        this.sessions.get(id)?.assertHealthy();
        return this.storage(() => this.options.store.readEvents(id, afterSequence, limit));
    }

    private clearIdle(id: string): void {
        const timer = this.idleTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        this.idleTimers.delete(id);
    }

    private reconcileSessions(): void {
        for (const [id, session] of this.sessions) {
            const resident = session.resident;
            // Retain unresolved persistence faults for reads, independently of residency.
            if (session.busy || resident || session.poisoned) continue;
            this.clearIdle(id);
            this.sessions.delete(id);
        }
    }

    /** Residue readout; a session left non-resident by the read is released from the map. */
    private cleanupReadout(id: string, session: CodeSession | undefined): boolean {
        if (!session) return false;
        const pending = session.cleanupPending;
        if (!session.resident && this.sessions.get(id) === session) this.changed(id, session);
        return pending;
    }

    private changed(id: string, session: CodeSession): void {
        this.reconcileSessions();
        if (this.sessions.get(id) !== session) return;
        this.clearIdle(id);
        if (session.busy || session.poisoned) return;
        if (!session.resident) { this.sessions.delete(id); return; }
        if (this.disposed || session.closing) return;
        const delay = Math.max(0, this.idleReapMs - (this.now() - session.lastUsedAt));
        const timer = setTimeout(() => {
            this.idleTimers.delete(id);
            if (this.sessions.get(id) !== session || session.busy) return;
            void session.dispose().then(() => this.changed(id, session))
                .catch(() => console.warn('[code] idle_cleanup_failed'));
        }, delay);
        timer.unref();
        this.idleTimers.set(id, timer);
    }

    private reserve(record: CodeSessionRecord): CodeSession {
        this.reconcileSessions();
        let session = this.sessions.get(record.sessionId);
        if (session) {
            session.assertHealthy();
            if (session.closing) throw new CodeServiceError('session_closing', 'Code session is closing');
            if (session.busy) throw new CodeStoreError('session_busy', 'Code session already has active work', 409);
            if (session.cleanupPending) throw new CodeServiceError('cleanup_pending', 'Previous Code runtime has not closed');
            this.clearIdle(record.sessionId);
            return session;
        }
        const occupied = [...this.sessions.values()].filter(entry => entry.busy || entry.resident).length;
        if (occupied >= this.maxConcurrentSessions) {
            throw new CodeServiceError('session_capacity', 'Code runtime capacity is full');
        }
        session = new CodeSession({ sessionId: record.sessionId, store: this.options.store,
            provider: this.options.providers[record.provider], publish: event => this.publish([event]),
            now: this.now, changed: () => this.changed(record.sessionId, reserved) });
        const reserved = session;
        // Count opening reservations before any native/provider await.
        this.sessions.set(record.sessionId, session);
        return session;
    }

    prompt(id: string, input: CodePromptRequest): { receipt: CodePromptReceipt; duplicate: boolean } {
        this.ready();
        this.sessions.get(id)?.assertHealthy();
        const record = this.record(id);
        if (this.storage(() => this.options.store.readTurn(id, input.clientTurnKey))) {
            const duplicate = this.storage(() => this.options.store.admitTurn({ ...input, sessionId: id }));
            return { receipt: duplicate.receipt, duplicate: true };
        }
        this.validate(record, record.capabilities, record);
        const session = this.reserve(record);
        try {
            const result = this.storage(() => this.options.store.admitTurn({ ...input, sessionId: id,
                expectedRevision: record.revision }));
            if (!result.duplicate) {
                this.admitted = true;
                session.start({ ...record, ...result.session }, input.text, result.promptUuid);
            }
            this.publish(result.events);
            return { receipt: result.receipt, duplicate: result.duplicate };
        } catch (error) { this.changed(id, session); throw error; }
    }

    /**
     * One Claude follow-up for the captured running turn. A committed key replays its receipt
     * whatever the turn became since; a new key never reserves capacity, attaches or starts a turn.
     */
    async steer(id: string, input: CodeSteerRequest): Promise<{ receipt: CodePromptReceipt; duplicate: boolean }> {
        this.ready();
        this.sessions.get(id)?.assertHealthy();
        const record = this.record(id);
        if (record.provider !== 'claude') {
            throw new CodeStoreError('unsupported_capability', 'This Code runtime does not take in-band follow-ups', 400);
        }
        const replay = this.storage(() => this.options.store.readSteer(id, input));
        if (replay) return { receipt: replay, duplicate: true };
        if (record.epoch !== input.epoch || record.turnId !== input.turnId) {
            throw new CodeStoreError('stale_owner', 'Code turn ownership has changed', 409);
        }
        if (record.archivedAt !== null || record.status !== 'streaming') {
            throw new CodeStoreError('session_not_steerable', 'This turn does not take a follow-up right now', 409);
        }
        const session = this.sessions.get(id);
        if (!session) throw new CodeServiceError('orphaned_turn', 'Code turn has no live owner; recovery is required');
        return session.steer(input);
    }

    async cancel(id: string, input: CodeCancelRequest): Promise<CodeSessionInfo> {
        this.ready();
        const record = this.record(id);
        const session = this.sessions.get(id);
        session?.assertHealthy();
        if (record.epoch !== input.epoch || (record.turnId !== null && record.turnId !== input.turnId)) {
            throw new CodeStoreError('stale_owner', 'Code turn ownership has changed', 409);
        }
        if (record.turnId !== null) {
            if (!session) throw new CodeServiceError('orphaned_turn', 'Code turn has no live owner; recovery is required');
            await session.cancel(input);
        }
        // The turn view may already read `idle` while a retired runtime is
        // still draining; the residency readout is what separates the two.
        return { ...this.storage(() => this.options.store.snapshot(id)).session,
            cleanupPending: this.cleanupReadout(id, session) };
    }

    /** Read receipt from the Manager; drives the unread marker (lastTurnCompletedAt > lastVisitedAt). */
    visit(id: string): CodeSessionInfo {
        this.ready();
        const result = this.storage(() => this.options.store.markVisited(id));
        this.publish(result.events);
        return result.session;
    }

    async attach(id: string): Promise<CodeSessionInfo> {
        this.ready();
        const record = this.record(id);
        this.validate(record, record.capabilities, record);
        const session = this.reserve(record);
        try {
            const result = this.storage(() => this.options.store.beginAttach(id, record.revision));
            this.admitted = true;
            session.start({ ...record, ...result.session }, null);
            this.publish(result.events);
        } catch (error) { this.changed(id, session); throw error; }
        await session.wait();
        return { ...this.storage(() => this.options.store.snapshot(id)).session,
            cleanupPending: this.cleanupReadout(id, session) };
    }

    async patch(id: string, input: CodePatchSessionRequest): Promise<CodeSessionInfo> {
        this.ready();
        const record = this.record(id);
        const session = this.sessions.get(id);
        session?.assertHealthy();
        if (session?.reconfiguring) throw new CodeStoreError('session_busy', 'Code session settings are already changing', 409);
        const policy = input.model !== undefined || input.effort !== undefined || input.permissionMode !== undefined
            || input.thinking !== undefined;
        const modelChanged = input.model !== undefined && input.model !== record.model;
        const effortChanged = input.effort !== undefined && input.effort !== record.effort;
        const thinkingChanged = input.thinking !== undefined && input.thinking !== record.thinking;
        const permissionChanged = input.permissionMode !== undefined && input.permissionMode !== record.permissionMode;
        const policyChanged = modelChanged || effortChanged || thinkingChanged || permissionChanged;
        if (policy) {
            this.validate({ ...record, ...input }, record.capabilities, record);
            if (policyChanged && record.nativeStarted && (!record.nativeCursor || !record.capabilities.resume)) {
                throw new CodeStoreError('resume_unavailable', 'Code policy change requires resumable native history', 409);
            }
        }
        // Claude switches the permission mode alone, or model and effort together, on the
        // resident query. Thinking is fixed at open, so a thinking or mixed change, other
        // providers and archiving retire the runtime and the next turn reopens.
        const live = record.provider === 'claude' && input.archived === undefined && !thinkingChanged;
        const permissionOnly = live && permissionChanged && !modelChanged && !effortChanged;
        const tupleOnly = live && (modelChanged || effortChanged) && !permissionChanged;
        if (session && !session.closing && (permissionOnly || tupleOnly)) {
            return session.exclusive(() => this.patchLive(record, session, input, permissionOnly));
        }
        const result = this.storage(() => this.options.store.patchSession(id, input));
        return this.patched(id, session, result, policyChanged || input.archived === true);
    }

    /** Runs inside the session's exclusive section, from the SDK switch through any rollback. */
    private async patchLive(record: CodeSessionRecord, session: CodeSession, input: CodePatchSessionRequest,
        permissionOnly: boolean): Promise<CodeSessionInfo> {
        const apply = (target: Pick<CodeSessionRecord, 'model' | 'effort' | 'permissionMode'>) => permissionOnly
            ? session.applyPermissionMode(target.permissionMode) : session.reconfigure({ model: target.model, effort: target.effort });
        const outcome = await apply({ model: input.model ?? record.model,
            effort: input.effort !== undefined ? input.effort : record.effort, permissionMode: input.permissionMode ?? record.permissionMode });
        let result: ReturnType<CodeStore['patchSession']>;
        try { result = this.storage(() => this.options.store.patchSession(record.sessionId, input)); }
        catch (error) {
            // Put the runtime back where the stored row still is; if that fails, retire it.
            if (outcome === 'applied') {
                try { await apply(record); }
                catch { await session.dispose(); }
            }
            throw error;
        }
        // A live handle that cannot switch in place is retired like any other policy change.
        return this.patched(record.sessionId, session, result, outcome === 'unsupported');
    }

    private async patched(id: string, session: CodeSession | undefined, result: ReturnType<CodeStore['patchSession']>,
        retire: boolean): Promise<CodeSessionInfo> {
        // Invalidate residency before exposing the new metadata to subscribers.
        const closing = session && retire ? session.dispose() : null;
        this.publish(result.events);
        if (closing) await closing;
        return { ...result.session, cleanupPending: this.cleanupReadout(id, session) };
    }

    answerPermission(permissionId: string, input: CodePermissionAnswer): void {
        this.ready();
        this.record(input.sessionId);
        const session = this.sessions.get(input.sessionId);
        if (!session) throw new CodeStoreError('request_not_current', 'Code permission is no longer current', 409);
        session.answerPermission(permissionId, input);
    }

    models(): CodeModelCatalog {
        this.ready();
        return { providers: PROVIDER_IDS.map(id => structuredClone(this.catalog(id))), defaultProvider: 'codex-app' };
    }

    recover(): void {
        this.ready();
        if (this.recovered) return;
        if (this.admitted || this.sessions.size) throw new CodeStoreError('recovery_after_admission', 'Recover Code sessions before admitting work', 409);
        const events = this.storage(() => this.options.store.recoverInterrupted());
        this.recovered = true;
        this.publish(events);
    }

    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        for (const id of this.idleTimers.keys()) this.clearIdle(id);
        this.disposePromise = Promise.all([...this.sessions.values()].map(session => session.dispose())).then(() => undefined);
        return this.disposePromise;
    }
}
