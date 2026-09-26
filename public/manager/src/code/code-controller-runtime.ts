import type {
    CodeContextUsage, CodeCreateSessionRequest, CodeModelCatalog, CodePatchSessionRequest,
    CodePermissionRequest, CodePromptReceipt, CodeSessionInfo, CodeWireEvent,
} from '../../../../src/code-mode/wire';
import type { CodeControllerModel, CodeControllerOptions, CodeSessionFilter, CodeTransportState } from './code-controller-types';
import { CodeClientError, codeBaseOrigin, createCodeSessionClient, type CodeGitInfo } from './code-session-client';
import { emptyCodeSession, reduceCodeSession, codeSessionBusy, type CodeSessionState } from './code-session-state';
import {
    acknowledgeCodeSend, acknowledgeCodeSteer, catalogSelection, codeDraftBook, createCodeDraft, persistCodeDraftBook, sessionSelection,
    type CodeDraft, type CodeDraftBook,
} from './code-controller-drafts';
import { withPendingUserItem } from './pending-user-item';
import { codeCanResume, codeCanRollback } from './code-types';

const MAX_DETAILS = 6;
const MAX_INDEX = 1000;
const INDEX_PAGE_SIZE = 100;
const MAX_CATCHUP_PAGES = 32;
const INDEX_DEBOUNCE_MS = 150;
const message = (error: unknown) => error instanceof CodeClientError ? error.message : 'Connection lost. Refresh to check the current state.';
const rejected = (error: unknown) => error instanceof CodeClientError && error.status >= 400 && error.status < 500;
// A lost response may still be committed, so its message can arrive; a `steer_outcome_unknown` answer
// means the server could not record it, so it never will.
const FOLLOW_UP_UNCONFIRMED = 'Follow-up delivery not confirmed. It was not resent; it appears in the conversation if Claude received it.';
const FOLLOW_UP_UNRECORDED = 'Follow-up delivery not confirmed. Claude may have received it, but it will not appear in the conversation. It was not resent.';
// A rollback posts the revision and epoch the user chose the row at; PATCH's settings copy does not fit its conflict.
const ROLLBACK_CONFLICT = 'The conversation changed since you chose this point. Review it and try again.';
const newer = (incoming: CodeSessionInfo, current?: CodeSessionInfo | null) => !current
    || incoming.epoch > current.epoch || (incoming.epoch === current.epoch && (incoming.sequence > current.sequence
        || (incoming.sequence === current.sequence && incoming.revision >= current.revision)));

/**
 * A receipt status that means the send is spent without having produced work.
 *
 * The server consumes a `clientTurnKey` once. After a restart seals an
 * interrupted turn, the same key returns only a duplicate receipt — HTTP 200,
 * `ok:true`, and the stored status — and starts nothing. Answering a retry with
 * that receipt as if it were an admission is what left the composer idle on a
 * session that had failed.
 *
 * `completed` is deliberately absent: that turn ran, and its output is in the
 * transcript, so closing the send is the honest outcome.
 */
const spent = (status: CodePromptReceipt['status']): boolean => status === 'failed' || status === 'cancelled';

/**
 * Did the transcript already settle the turn this send belongs to?
 *
 * The HTTP receipt is only visible when the client actually posts. After a
 * reload the draft is restored with its original key and the first refresh sees
 * the orphaned turn's own `user_message` still in history, so the guard has to
 * read the transcript rather than the response.
 */
function deadSend(state: CodeSessionState | undefined, key: string): boolean {
    const sent = state?.items.find(item => item.kind === 'user_message' && item.clientTurnKey === key);
    if (!sent) return false;
    return state!.items.some(item => item.turnId === sent.turnId
        && (item.kind === 'turn_failed' || item.kind === 'turn_cancelled'));
}

/**
 * What a read that could actually observe the runtime said about attention.
 *
 * `contextUsage` and `pendingPermissionCount` are attached at read time and never
 * persisted, so only the two server reads that overlay them — list and snapshot —
 * can speak for them. A stored `code_session` frame and the create/patch/cancel/
 * attach responses carry neither field, and `newer()` ranks only epoch, sequence
 * and revision, so without a separate owner a payload that simply cannot carry a
 * field would outrank one that measured it.
 *
 * Absence is recorded, not skipped: once the runtime is reaped the owning read
 * stops reporting usage, and the meter has to hide in that same turn.
 */
interface CodeSessionAttention {
    epoch: number;
    sequence: number;
    revision: number;
    pendingPermissionCount?: number;
    contextUsage?: CodeContextUsage;
}

/** Code's async owner; React only subscribes and supplies the single SSE transport. */
export class CodeController {
    private client;
    private book: CodeDraftBook;
    private details = new Map<string, CodeSessionState>();
    private summaries = new Map<string, CodeSessionInfo>();
    private attention = new Map<string, CodeSessionAttention>();
    private rows: string[] = [];
    private catalog: CodeModelCatalog | null = null;
    private catalogError: string | null = null;
    private transport: CodeTransportState = 'disconnected';
    private filter: CodeSessionFilter = { scope: 'all', archived: false };
    private workingDir: string;
    private gitInfo: CodeGitInfo | null = null;
    private gitError: string | null = null;
    private gitGeneration = 0;
    private pickerGeneration = 0;
    private workspacePicking = false;
    private indexGeneration = 0;
    private catalogGeneration = 0;
    private lifetime = 0;
    private active = false;
    private abort = new AbortController();
    private syncing = new Map<string, Promise<void>>();
    private detailReads = new Map<string, AbortController>();
    private historyLoading = new Set<string>();
    private indexLoading = false;
    private moreSessions = false;
    private cursor: string | null = null;
    private fetched = 0;
    private indexError: string | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private listeners = new Set<() => void>();
    private model: CodeControllerModel;
    private draftSyncQueued = false;

    constructor(options: CodeControllerOptions) {
        this.client = createCodeSessionClient(options.port);
        this.workingDir = options.workingDir;
        this.book = codeDraftBook(codeBaseOrigin(options.port), options.workingDir);
        this.model = this.makeModel();
    }
    getModel = (): CodeControllerModel => this.model;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    private changed = (): void => {
        this.model = this.makeModel();
        for (const listener of this.listeners) listener();
        const id = this.book.selectedId;
        const state = id ? this.details.get(id) : undefined;
        if (this.active && id && !state?.error && (!state || this.draft(id).requiredSequence > state.cursor) && !this.draftSyncQueued) {
            this.draftSyncQueued = true;
            queueMicrotask(() => {
                this.draftSyncQueued = false;
                if (this.active && this.book.selectedId === id && !this.syncing.has(id)) void this.sync(id);
            });
        }
    };
    private notify(): void {
        persistCodeDraftBook(this.book);
        this.changed();
        for (const listener of this.book.listeners) if (listener !== this.changed) listener();
    }
    mount = (): (() => void) => {
        this.active = true;
        this.lifetime++;
        this.abort = new AbortController();
        this.book.listeners.add(this.changed);
        void this.refresh();
        return () => {
            persistCodeDraftBook(this.book);
            this.active = false;
            this.lifetime++;
            this.abort.abort();
            this.syncing.clear();
            for (const read of this.detailReads.values()) read.abort();
            this.detailReads.clear();
            if (this.timer !== undefined) clearTimeout(this.timer);
            this.timer = undefined;
            this.book.listeners.delete(this.changed);
            this.details.clear();
            this.summaries.clear();
            this.attention.clear();
            this.rows = [];
            this.cursor = null;
            this.fetched = 0;
            this.gitGeneration++;
            this.pickerGeneration++;
        };
    };
    setWorkingDir(cwd: string): void {
        if (cwd === this.workingDir) return;
        this.workingDir = cwd;
        // The shell's Files selection only seeds an untouched new-session draft.
        const draft = this.book.fresh;
        if (!draft.selectionEdit && !draft.input && draft.operation.kind === 'idle' && !draft.createUnknown) {
            draft.selection = { ...draft.selection, cwd };
        }
        if (this.filter.scope === 'cwd') void this.readIndex();
        void this.readGit();
        this.notify();
    }
    private draft(id = this.book.selectedId): CodeDraft {
        if (id === null) return this.book.fresh;
        let draft = this.book.sessions.get(id);
        if (!draft) {
            const session = this.info(id);
            draft = createCodeDraft(session ? sessionSelection(session) : this.book.fresh.selection);
            this.book.sessions.set(id, draft);
        }
        return draft;
    }
    private info(id: string | null): CodeSessionInfo | null {
        if (!id) return null;
        const detail = this.details.get(id)?.session;
        const summary = this.summaries.get(id);
        return summary && newer(summary, detail) ? summary : detail ?? summary ?? null;
    }
    /**
     * Record what an owning read saw. Call this BEFORE accept() on the same object:
     * accept() copies rather than mutates, but the ordering keeps the rule obvious.
     */
    private observe(session: CodeSessionInfo): void {
        const known = this.attention.get(session.sessionId);
        if (known && !newer(session, { ...session, epoch: known.epoch, sequence: known.sequence, revision: known.revision })) return;
        this.attention.set(session.sessionId, {
            epoch: session.epoch, sequence: session.sequence, revision: session.revision,
            ...(session.pendingPermissionCount === undefined ? {} : { pendingPermissionCount: session.pendingPermissionCount }),
            ...(session.contextUsage === undefined ? {} : { contextUsage: session.contextUsage }),
        });
    }
    /** Publish `base` with attention resolved from its owner, absence included. */
    private resolve(id: string, base: CodeSessionInfo): CodeSessionInfo {
        const seen = this.attention.get(id);
        const { contextUsage: _usage, pendingPermissionCount: _count, ...rest } = base;
        return {
            ...rest,
            ...(seen?.pendingPermissionCount === undefined ? {} : { pendingPermissionCount: seen.pendingPermissionCount }),
            ...(seen?.contextUsage === undefined ? {} : { contextUsage: seen.contextUsage }),
        };
    }
    private accept(incoming: CodeSessionInfo): void {
        if (!this.active) return;
        const before = this.info(incoming.sessionId);
        if (!newer(incoming, before)) return;
        // A turn that finishes while its session is open was seen: receipt it so the
        // sidebar does not mark it unread. The receipt's own echo leaves the clock alone.
        if (incoming.sessionId === this.book.selectedId && before
            && (incoming.lastTurnCompletedAt ?? 0) > (before.lastTurnCompletedAt ?? 0)) {
            void this.markVisited(incoming.sessionId);
        }
        // The ranked record carries identity and lifecycle only. Attached fields are
        // dropped by copy, never by mutation: readIndex hands the same row to
        // observe(), and update() hands over details.session, which the reducer may
        // still be holding (code-session-state.ts snapshot replace).
        const { contextUsage: _usage, pendingPermissionCount: _count, ...session } = incoming;
        this.summaries.set(session.sessionId, session);
        if (this.summaries.size > MAX_INDEX + MAX_DETAILS) {
            const victim = [...this.summaries.keys()].find(id => id !== this.book.selectedId && !this.details.has(id) && !this.rows.includes(id));
            if (victim) { this.summaries.delete(victim); this.attention.delete(victim); }
        }
        const draft = this.book.sessions.get(session.sessionId);
        // Once the server reports the turn, its own status carries the working state.
        if (draft?.awaitingTurn && codeSessionBusy(session)) draft.awaitingTurn = null;
        if (draft?.stopTarget && (session.turnId !== draft.stopTarget.turnId || session.epoch !== draft.stopTarget.epoch
            || !codeSessionBusy(session))) {
            draft.stopTarget = null;
            if (draft.operation.kind === 'stopping') draft.operation = draft.retry
                ? { kind: 'unknown-send', error: 'The original message still needs reconciliation.' } : { kind: 'idle', error: null };
        }
    }
    private state(id: string): CodeSessionState {
        let state = this.details.get(id);
        if (!state) {
            state = emptyCodeSession(id);
            this.details.set(id, state);
            this.trimDetails();
        }
        return state;
    }
    private trimDetails(): void {
        for (const id of this.details.keys()) {
            if (this.details.size <= MAX_DETAILS) break;
            if (id !== this.book.selectedId) {
                this.details.delete(id);
                this.detailReads.get(id)?.abort();
                this.detailReads.delete(id);
                this.syncing.delete(id);
            }
        }
    }
    private update(id: string, state: CodeSessionState): void {
        const before = this.details.get(id)?.session;
        this.details.set(id, state);
        if (state.session) this.accept(state.session);
        const draft = this.book.sessions.get(id);
        if (draft && before && state.session && state.hydrated && !state.needsSnapshot
            && (state.session.historyGeneration ?? 0) > (before.historyGeneration ?? 0)) this.rolledBack(draft, state);
        if (draft?.retry && state.items.some(item => item.kind === 'user_message' && item.clientTurnKey === draft.retry!.key)) {
            if (deadSend(state, draft.retry.key)) this.requireNewKey(draft);
            else acknowledgeCodeSend(draft, draft.retry.key);
        }
        if (draft?.steer && state.items.some(item => item.kind === 'user_message' && item.clientTurnKey === draft.steer!.key)) {
            acknowledgeCodeSteer(draft, draft.steer.key);
        }
        if (draft?.awaitingTurn) {
            // Only this send's own turn ending clears the marker: a stale read receipt or
            // an older sequence must not switch a fresh send's spinner off.
            const turnId = state.items.find(item => item.kind === 'user_message' && item.clientTurnKey === draft.awaitingTurn)?.turnId;
            if (turnId && state.items.some(item => item.turnId === turnId
                && (item.kind === 'turn_completed' || item.kind === 'turn_failed' || item.kind === 'turn_cancelled'))) {
                draft.awaitingTurn = null;
            }
        }
        if (draft && state.synced) {
            const current = new Set(state.permissions.map(p => p.permissionId));
            for (const key of Object.keys(draft.permissionOperations)) {
                if (!current.has(key) && !draft.permissionOperations[key].pending) delete draft.permissionOperations[key];
            }
        }
        this.notify();
    }
    /**
     * Keep the message, retire the key.
     *
     * The server will answer that spent key with the same duplicate receipt
     * forever, so retrying it is not a retry. Rotating gives Retry something that
     * can actually be admitted, and it also stops the settled turn's own
     * `user_message` from matching, so this fires once rather than on every read.
     */
    private requireNewKey(draft: CodeDraft, reason = 'The original attempt ended on the server without running.'): void {
        if (!draft.retry) return;
        draft.retry = { ...draft.retry, key: crypto.randomUUID(), resend: true };
        draft.operation = { kind: 'unknown-send', error: `${reason} The message was not resent; Retry will submit it as a new message.` };
    }
    /**
     * A rollback removed turns, possibly the one this draft is waiting on. A send whose own
     * row is gone no longer has a turn to wait for, and its key may now be a removed turn's.
     * An unconfirmed follow-up of a removed turn can no longer appear, so its notice goes too;
     * one still in flight settles on its own answer.
     */
    private rolledBack(draft: CodeDraft, state: CodeSessionState): void {
        const kept = (key: string) => state.items.some(item => item.kind === 'user_message' && item.clientTurnKey === key);
        if (draft.awaitingTurn && !kept(draft.awaitingTurn)) draft.awaitingTurn = null;
        if (draft.retry && !kept(draft.retry.key) && (draft.operation.kind === 'idle' || draft.operation.kind === 'unknown-send')) {
            this.requireNewKey(draft, 'The conversation was rolled back.');
        }
        const steer = draft.steer;
        if (steer?.state === 'unknown' && !state.items.some(item => item.turnId === steer.turnId)) draft.steer = null;
    }
    private makeModel(): CodeControllerModel {
        const id = this.book.selectedId;
        const canonical = this.info(id);
        const draft = this.draft(id);
        const detail = id ? this.details.get(id) : undefined;
        // One place decides what either screen may show, so the meter and the
        // sidebar cannot disagree about the same read.
        const publish = (row: CodeSessionInfo, state?: CodeSessionState): CodeSessionInfo => {
            const resolved = this.resolve(row.sessionId, row);
            return state?.synced ? { ...resolved, pendingPermissionCount: state.permissions.length } : resolved;
        };
        const session = canonical ? publish(canonical, detail) : canonical;
        const operation = draft.operation;
        const persistenceWarning = this.book.storageWarning ?? this.book.recoveryWarning;
        const pending = ['creating', 'sending', 'stopping', 'resuming', 'patching', 'rolling-back'].includes(operation.kind) && !operation.error;
        const synced = id === null ? !!this.catalog : !!detail?.synced && (!session || session.sequence <= detail.cursor) && draft.requiredSequence <= (detail?.cursor ?? 0);
        const followUp = !!session && synced && session.provider === 'claude' && session.status === 'streaming'
            && !!session.turnId && session.archivedAt === null;
        // The turn's one follow-up is already in the transcript.
        const followUpSent = followUp && !!session && (detail?.items ?? []).some(item => item.kind === 'user_message'
            && item.itemId.startsWith(`${session.turnId}:steer:`));
        const unconfirmed = draft.steer?.state !== 'unknown' ? null : draft.steer.unrecorded ? FOLLOW_UP_UNRECORDED : FOLLOW_UP_UNCONFIRMED;
        return {
            catalog: this.catalog, sessions: this.rows.map(id => {
                const row = this.info(id), detail = this.details.get(id);
                return row ? publish(row, detail) : row;
            }).filter((row): row is CodeSessionInfo => !!row),
            selectedId: id, session, items: withPendingUserItem(draft, detail?.items ?? []),
            hasUnsentDraft: !!this.book.fresh.input.trim() || this.book.fresh.createUnknown || !!this.book.fresh.retry,
            permissions: detail?.permissions ?? [],
            input: draft.input, selection: session ? sessionSelection(session) : draft.selection,
            gitInfo: this.gitInfo, loading: this.indexLoading || !!detail?.hydrating || (!!id && !detail?.hydrated && !detail?.error),
            pending, busy: codeSessionBusy(session), working: !!draft.awaitingTurn || codeSessionBusy(session),
            workingIds: new Set(this.rows.filter(rowId => {
                const row = this.info(rowId);
                return !!this.book.sessions.get(rowId)?.awaitingTurn || (!!row && codeSessionBusy(row));
            })), followUp, followUpSent, steering: draft.steer?.state === 'sending', synced, transport: this.transport, workspacePicking: this.workspacePicking,
            error: [operation.error ?? unconfirmed ?? detail?.error ?? this.indexError ?? this.catalogError ?? this.gitError ?? session?.error?.message, persistenceWarning].filter(Boolean).join(' ') || null,
            operation: { ...operation, error: operation.error && persistenceWarning ? `${operation.error} ${persistenceWarning}` : operation.error }, retryText: draft.retry?.text ?? null,
            canRetrySameSend: !!id && operation.kind === 'unknown-send' && !!draft.retry && synced && session?.archivedAt === null,
            resendRequired: !!draft.retry?.resend,
            permissionOperations: { ...draft.permissionOperations }, hasMoreSessions: this.moreSessions,
            hasOlderHistory: detail?.hasOlder ?? false, filter: this.filter,
            creationUnknown: id === null && draft.createUnknown, startAnotherSession: this.startAnotherSession,
            newSession: this.newSession, selectSession: this.selectSession, setInput: this.setInput,
            setSelection: this.setSelection, pickWorkspace: this.pickWorkspace, send: this.send,
            retrySameSend: this.retrySameSend, stop: this.stop, resume: this.resume, rollbackSession: this.rollbackSession, rename: this.rename,
            archive: this.archive, answer: this.answer, refresh: this.refresh, loadMoreSessions: this.loadMoreSessions,
            loadOlderHistory: this.loadOlderHistory, setFilter: this.setFilter, clearError: this.clearError,
        };
    }
    private async readCatalog(): Promise<void> {
        const generation = ++this.catalogGeneration;
        const life = this.lifetime;
        try {
            const catalog = await this.client.listModelOptions(this.abort.signal);
            if (!this.active || life !== this.lifetime || generation !== this.catalogGeneration) return;
            this.catalog = catalog;
            this.catalogError = null;
            const draft = this.book.fresh;
            if (!draft.selection.model && !draft.selectionEdit && draft.operation.kind === 'idle') {
                draft.selection = catalogSelection(catalog, { ...draft.selection, provider: catalog.defaultProvider });
            }
            this.notify();
        } catch (error) {
            if (this.active && life === this.lifetime && generation === this.catalogGeneration) { this.catalogError = message(error); this.notify(); }
        }
    }
    private async readIndex(more = false): Promise<void> {
        const generation = ++this.indexGeneration;
        const life = this.lifetime;
        // Pages are keyset slices of the stable creation order; a refresh
        // re-reads a grown prefix instead of resuming the stream.
        const cursor = more ? this.cursor : null;
        const limit = more ? INDEX_PAGE_SIZE : Math.min(MAX_INDEX, Math.max(INDEX_PAGE_SIZE, this.fetched));
        this.indexLoading = true;
        this.notify();
        try {
            const page = await this.client.listSessions({ ...this.filter, limit,
                ...(cursor === null ? {} : { cursor }),
                ...(this.filter.scope === 'cwd' ? { cwd: this.workingDir } : {}) }, this.abort.signal);
            if (!this.active || life !== this.lifetime || generation !== this.indexGeneration) return;
            for (const session of page.sessions) {
                // A listing is one of the two reads that can see the live runtime.
                this.observe(session);
                this.accept(session);
                const state = this.details.get(session.sessionId);
                if (state?.hydrated && !state.hydrating && session.sequence > state.cursor) {
                    this.details.set(session.sessionId, reduceCodeSession(state, { type: 'stale' }));
                    void this.sync(session.sessionId);
                }
            }
            this.rows = [...new Set([...(more ? this.rows : []), ...page.sessions.map(row => row.sessionId)])].slice(0, MAX_INDEX);
            this.cursor = page.nextCursor;
            this.fetched = (more ? this.fetched : 0) + page.sessions.length;
            this.moreSessions = page.hasMore && this.rows.length < MAX_INDEX;
            this.indexError = null;
            const retained = new Set([...this.rows, ...this.details.keys(), ...(this.book.selectedId ? [this.book.selectedId] : [])]);
            for (const id of this.summaries.keys()) if (!retained.has(id)) { this.summaries.delete(id); this.attention.delete(id); }
        } catch (error) {
            if (this.active && life === this.lifetime && generation === this.indexGeneration) this.indexError = message(error);
        } finally {
            if (this.active && life === this.lifetime && generation === this.indexGeneration) { this.indexLoading = false; this.notify(); }
        }
    }
    private scheduleIndex(): void {
        if (!this.active || this.timer !== undefined) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.readIndex(); }, INDEX_DEBOUNCE_MS);
    }
    private sync(id: string, forceSnapshot = false): Promise<void> {
        const existing = this.syncing.get(id);
        if (existing) return existing;
        const life = this.lifetime;
        const read = new AbortController();
        this.detailReads.set(id, read);
        this.state(id);
        const current = () => this.active && life === this.lifetime && this.detailReads.get(id) === read && this.details.has(id);
        const run = async () => {
            let snapshots = 0;
            let checkedStop: CodeDraft['stopTarget'] = null;
            try {
                for (let pageCount = 0; pageCount < MAX_CATCHUP_PAGES && current(); pageCount++) {
                    let state = this.state(id);
                    if (forceSnapshot || !state.hydrated || state.needsSnapshot) {
                        if (++snapshots > 2) throw new Error('snapshot did not cover live updates');
                        forceSnapshot = false;
                        this.update(id, reduceCodeSession(state, { type: 'snapshot-start' }));
                        const stopTarget = this.book.sessions.get(id)?.stopTarget;
                        const checkingStop = stopTarget?.outcome === 'unknown' ? stopTarget : null;
                        const snapshot = await this.client.snapshot(id, read.signal);
                        if (!current()) return;
                        checkedStop = checkingStop;
                        // The other owning read. Absence here is the idle reap.
                        this.observe(snapshot.session);
                        this.update(id, reduceCodeSession(this.state(id), { type: 'snapshot', snapshot }));
                    }
                    state = this.state(id);
                    if (state.needsSnapshot) continue;
                    const before = state.cursor;
                    const page = await this.client.events(id, before, read.signal);
                    if (!current()) return;
                    const next = reduceCodeSession(this.state(id), { type: 'page', page });
                    this.update(id, next);
                    if (next.needsSnapshot) continue;
                    if (next.synced && next.cursor >= (this.book.sessions.get(id)?.requiredSequence ?? 0)) {
                        this.reconcileStop(id, checkedStop);
                        return;
                    }
                    if (next.cursor <= before) { forceSnapshot = true; continue; }
                }
                if (current()) this.update(id, reduceCodeSession(this.state(id), { type: 'error', error: 'History is still catching up. Refresh to continue.' }));
            } catch (error) {
                if (!current()) return;
                if (error instanceof CodeClientError && error.code === 'invalid_sequence' && snapshots < 2) {
                    const snapshot = await this.client.snapshot(id, read.signal).catch(() => null);
                    if (!current()) return;
                    if (snapshot) { this.update(id, reduceCodeSession(this.state(id), { type: 'snapshot', snapshot })); return; }
                }
                this.update(id, reduceCodeSession(this.state(id), { type: 'error', error: message(error) }));
                if (error instanceof CodeClientError && error.code === 'session_not_found') this.scheduleIndex();
            }
        };
        const promise = run().finally(() => {
            if (this.syncing.get(id) === promise) this.syncing.delete(id);
            if (this.detailReads.get(id) === read) this.detailReads.delete(id);
            this.trimDetails();
        });
        this.syncing.set(id, promise);
        return promise;
    }
    onEvent = (event: CodeWireEvent): void => {
        if (!this.active) return;
        if (event.session?.sessionId === event.sessionId) this.accept(event.session);
        if (event.event === 'code_session' || event.item?.kind === 'permission_request' || event.update?.status) this.scheduleIndex();
        const draft = this.book.sessions.get(event.sessionId);
        if (event.item?.kind === 'user_message' && event.item.clientTurnKey && draft?.steer?.key === event.item.clientTurnKey) {
            draft.requiredSequence = Math.max(draft.requiredSequence, event.sequence);
            acknowledgeCodeSteer(draft, event.item.clientTurnKey);
        }
        if (event.item?.kind === 'user_message' && event.item.clientTurnKey && draft?.retry?.key === event.item.clientTurnKey) {
            draft.requiredSequence = Math.max(draft.requiredSequence, event.sequence);
            if (deadSend(this.details.get(event.sessionId), event.item.clientTurnKey)) this.requireNewKey(draft);
            else acknowledgeCodeSend(draft, event.item.clientTurnKey);
        }
        const previous = this.details.get(event.sessionId);
        if (!previous) { this.notify(); return; }
        const next = reduceCodeSession(previous, { type: 'event', event });
        this.update(event.sessionId, next);
        if (!next.synced && !next.hydrating) void this.sync(event.sessionId);
    };
    onTransport = (transport: CodeTransportState): void => {
        this.transport = transport;
        for (const [id, state] of this.details) this.details.set(id, reduceCodeSession(state, { type: 'stale' }));
        this.notify();
        if (transport === 'connected' && this.active) {
            void this.readIndex();
            for (const id of this.details.keys()) void this.sync(id, true);
        }
    };
    refresh = async (): Promise<void> => {
        const id = this.book.selectedId;
        await Promise.all([this.readCatalog(), this.readIndex(), id ? this.sync(id, true) : Promise.resolve(), this.readGit()]);
    };
    loadMoreSessions = async (): Promise<void> => { if (this.moreSessions && !this.indexLoading) await this.readIndex(true); };
    setFilter = (filter: CodeSessionFilter): void => { this.filter = { ...filter }; this.cursor = null; this.fetched = 0; this.rows = []; this.moreSessions = false; this.notify(); void this.readIndex(); };
    // Explicitly abandon only the local uncertain attempt. The server session may exist.
    startAnotherSession = (): void => {
        const previous = this.book.fresh;
        if (this.book.selectedId !== null || !previous.createUnknown) return;
        const draft = createCodeDraft(previous.selection);
        draft.input = previous.input; draft.edit = previous.edit; draft.selectionEdit = previous.selectionEdit;
        draft.operation.error = 'The original session may still exist. Your text is preserved; Send will create another session.';
        this.book.fresh = draft;
        this.book.navigation++;
        this.pickerGeneration++;
        this.notify();
    };
    newSession = (): void => { this.book.selectedId = null; this.book.navigation++; this.gitInfo = null; this.notify(); void this.readGit(); };
    selectSession = async (id: string): Promise<void> => {
        this.book.selectedId = id;
        this.book.navigation++;
        this.draft(id);
        this.state(id);
        this.gitInfo = null;
        this.notify();
        await this.sync(id, true);
        if (this.book.selectedId === id) void this.markVisited(id);
        if (this.book.selectedId === id) await this.readGit();
    };
    /** Read receipt for the unread marker. A failure only leaves the marker on; selection never waits for it. */
    private async markVisited(id: string): Promise<void> {
        try {
            this.accept(await this.client.visitSession(id));
            this.notify();
        } catch { /* the next open retries */ }
    }
    setInput = (text: string): void => { const draft = this.draft(); draft.input = text; draft.edit++; this.notify(); };
    clearError = (): void => {
        const draft = this.draft();
        if (draft.operation.kind === 'idle') draft.operation = { kind: 'idle', error: null };
        if (draft.steer?.state === 'unknown') draft.steer = null;
        this.indexError = null;
        this.book.recoveryWarning = null;
        this.notify();
    };
    private async readGit(): Promise<void> {
        const generation = ++this.gitGeneration;
        const life = this.lifetime;
        const id = this.book.selectedId;
        const cwd = this.info(id)?.cwd ?? (id === null ? this.book.fresh.selection.cwd : '');
        this.gitInfo = null;
        this.gitError = null;
        if (!cwd || !this.active) return;
        try {
            const info = await this.client.getGitInfo(cwd, this.abort.signal);
            if (this.active && life === this.lifetime && generation === this.gitGeneration && id === this.book.selectedId) { this.gitInfo = info; this.notify(); }
        } catch (error) {
            if (this.active && life === this.lifetime && generation === this.gitGeneration && id === this.book.selectedId) {
                this.gitError = message(error); this.notify();
            }
        }
    }
    pickWorkspace = async (): Promise<void> => {
        const draft = this.book.fresh;
        if (this.book.selectedId !== null || draft.operation.kind !== 'idle' || draft.createUnknown || this.workspacePicking) return;
        const navigation = this.book.navigation, selectionEdit = draft.selectionEdit, generation = ++this.pickerGeneration;
        this.workspacePicking = true;
        this.notify();
        try {
            const result = await this.client.pickWorkspace();
            if (!this.active || generation !== this.pickerGeneration || navigation !== this.book.navigation
                || selectionEdit !== draft.selectionEdit || draft !== this.book.fresh || draft.operation.kind !== 'idle') return;
            if (!result.cancelled && result.path) {
                draft.selection = { ...draft.selection, cwd: result.path }; draft.selectionEdit++;
                this.notify(); await this.readGit();
            }
        } catch (error) {
            if (this.active && generation === this.pickerGeneration && navigation === this.book.navigation
                && selectionEdit === draft.selectionEdit && draft === this.book.fresh && draft.operation.kind === 'idle') { draft.operation.error = message(error); this.notify(); }
        } finally {
            this.workspacePicking = false;
            this.notify();
        }
    };
    setSelection = async (patch: Partial<CodeCreateSessionRequest>): Promise<void> => {
        const id = this.book.selectedId;
        const session = this.info(id);
        if (session && patch.provider && patch.provider !== session.provider) {
            this.newSession();
            await this.setSelection({ ...patch, cwd: session.cwd });
            return;
        }
        const draft = this.draft();
        if (draft.operation.kind !== 'idle' || draft.createUnknown) return;
        if (session && id) {
            if ((patch.cwd !== undefined && patch.cwd !== session.cwd) || (patch.provider && patch.provider !== session.provider)) {
                draft.operation.error = 'Runtime and workspace are fixed for this session. Create a new session to change them.';
                this.notify(); return;
            }
            if (session.status !== 'idle' || !this.model.synced || session.archivedAt !== null) {
                draft.operation.error = 'Wait for this session to be idle and synchronized before changing settings.';
                this.notify(); return;
            }
            await this.patch(id, { model: patch.model ?? session.model,
                effort: patch.effort === undefined ? session.effort : patch.effort,
                permissionMode: patch.permissionMode ?? session.permissionMode,
                ...(session.provider === 'claude' ? { thinking: patch.thinking ?? session.thinking ?? true } : {}) });
            return;
        }
        if (id) return;
        const changedProvider = patch.provider !== undefined && patch.provider !== draft.selection.provider;
        let selection = { ...draft.selection, ...patch };
        if (this.catalog && changedProvider) selection = catalogSelection(this.catalog, selection, true);
        const provider = this.catalog?.providers.find(row => row.id === selection.provider);
        if (selection.effort !== null && provider && !provider.capabilities.efforts.includes(selection.effort)) selection.effort = null;
        draft.selection = selection;
        draft.selectionEdit++;
        this.notify();
        if (patch.cwd !== undefined) await this.readGit();
    };
    private async patch(id: string, input: Omit<CodePatchSessionRequest, 'expectedRevision'>, rejectFailure = false): Promise<void> {
        const draft = this.draft(id);
        const session = this.info(id);
        if (!session || draft.operation.kind !== 'idle' || codeSessionBusy(session)) {
            const error = new Error(!session ? 'Refresh this session before changing it.' : 'Wait for the current session action to finish before changing it.');
            draft.operation.error = error.message; this.notify();
            if (rejectFailure) throw error;
            return;
        }
        let failure: Error | null = null;
        draft.operation = { kind: 'patching', error: null }; this.notify();
        try {
            this.accept(await this.client.patchSession(id, { ...input, expectedRevision: session.revision }));
            draft.operation = { kind: 'idle', error: null };
        } catch (error) {
            if (error instanceof CodeClientError && error.session?.sessionId === id) {
                // A revision conflict answers with the snapshot session, overlay included.
                this.observe(error.session);
                this.accept(error.session);
            }
            failure = error instanceof CodeClientError ? error : new Error(message(error));
            draft.operation = { kind: 'idle', error: failure.message };
        }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
        if (rejectFailure && failure) throw failure;
    }
    // Row editors require rejection to distinguish a saved value from retained edits.
    // Other actions report handled failures through the controller model.
    rename = async (id: string, title: string): Promise<void> => { await this.patch(id, { title }, true); };
    archive = async (id: string, archived: boolean): Promise<void> => { await this.patch(id, { archived }, true); };
    send = async (): Promise<void> => {
        let id = this.book.selectedId;
        let draft = this.draft(id);
        if (draft.operation.kind !== 'idle' || draft.createUnknown || !draft.input.trim() || draft.steer?.state === 'sending') return;
        let session = this.info(id);
        // A running Claude turn takes the text as its follow-up; an idle session starts a new turn.
        if (id && session && this.model.followUp) {
            if (!this.model.followUpSent) await this.steer(id, draft, session);
            return;
        }
        if (draft.steer?.state === 'unknown') draft.steer = null;
        // t3code continues a session on the next send; a suspended (or recoverably
        // failed) session attaches first instead of asking for a separate Resume.
        if (id && session && codeCanResume(session) && this.model.synced) {
            draft.operation = { kind: 'resuming', error: null }; this.notify();
            try { this.accept(await this.client.attachSession(id)); draft.operation = { kind: 'idle', error: null }; }
            catch (error) { draft.operation = { kind: 'idle', error: message(error) }; this.notify(); this.scheduleIndex(); return; }
            this.notify(); this.scheduleIndex();
            if (this.active) await this.sync(id, true);
            session = this.info(id);
        }
        if (id && (!session || session.status !== 'idle' || session.archivedAt !== null || !this.model.synced)) {
            draft.operation.error = 'Wait for the session to be idle and synchronized before sending.'; this.notify(); return;
        }
        const captured = { text: draft.input, edit: draft.edit, key: crypto.randomUUID() };
        const navigation = this.book.navigation;
        if (!id) {
            const selection = { ...draft.selection };
            const provider = this.catalog?.providers.find(row => row.id === selection.provider);
            if (!provider?.available || !selection.cwd.trim() || !provider.models.includes(selection.model)
                || !provider.capabilities.permissionModes.includes(selection.permissionMode)
                || (selection.effort !== null && !provider.capabilities.efforts.includes(selection.effort))) {
                draft.operation.error = 'Choose an available runtime, workspace, model and supported settings before sending.';
                this.notify(); return;
            }
            draft.operation = { kind: 'creating', error: null }; this.notify();
            try {
                const created = await this.client.createSession(selection);
                id = created.sessionId;
                this.book.sessions.set(id, draft);
                if (this.book.fresh === draft) this.book.fresh = createCodeDraft(selection);
                if (this.book.navigation === navigation && this.book.selectedId === null) {
                    this.book.selectedId = id;
                    this.book.navigation++;
                }
                this.accept(created);
                if (this.active) this.state(id);
                this.scheduleIndex();
            } catch (error) {
                draft.createUnknown = !rejected(error);
                draft.operation = { kind: draft.createUnknown ? 'creating' : 'idle', error: draft.createUnknown
                    ? 'Session creation could not be confirmed. The original session may exist. Refresh the list, or choose Start another session to keep this text in a new draft.' : message(error) };
                this.notify(); this.scheduleIndex(); return;
            }
        }
        draft = this.draft(id);
        draft.retry = captured;
        await this.submit(id, draft);
    };
    private async submit(id: string, draft: CodeDraft): Promise<void> {
        const attempt = draft.retry;
        if (!attempt) return;
        draft.operation = { kind: 'sending', error: null };
        draft.awaitingTurn = attempt.key;
        this.notify();
        try {
            const receipt = await this.client.sendPrompt(id, { text: attempt.text, clientTurnKey: attempt.key });
            if (receipt.clientTurnKey !== attempt.key) throw new Error('Mismatched prompt receipt');
            draft.requiredSequence = Math.max(draft.requiredSequence, receipt.sequence);
            const state = this.details.get(id);
            if (state) this.details.set(id, reduceCodeSession(state, { type: 'stale' }));
            // A duplicate receipt for a spent key is a report about a turn that is
            // already over, not an admission of this one.
            if (spent(receipt.status)) { this.requireNewKey(draft); draft.awaitingTurn = null; }
            else acknowledgeCodeSend(draft, attempt.key);
        } catch (error) {
            // The committed user event may already have acknowledged a lost HTTP response.
            if (draft.retry?.key === attempt.key) {
                draft.operation = { kind: rejected(error) ? 'idle' : 'unknown-send', error: rejected(error) ? message(error)
                    : 'Message acceptance is unknown. Refresh, or explicitly retry the original message with the same key.' };
                if (rejected(error)) { draft.retry = null; draft.awaitingTurn = null; }
            }
        }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
    }
    /**
     * Post one follow-up for the captured turn. Only a matching receipt or the follow-up's own
     * `user_message` clears the input; a refusal keeps it; an unconfirmed outcome is never resent.
     * The send's operation is left alone, so a Stop in progress keeps its state.
     */
    private async steer(id: string, draft: CodeDraft, session: CodeSessionInfo): Promise<void> {
        if (!session.turnId || (draft.stopTarget && draft.stopTarget.outcome !== 'retryable')) return;
        const attempt: NonNullable<CodeDraft['steer']> = { key: crypto.randomUUID(), text: draft.input, edit: draft.edit,
            turnId: session.turnId, epoch: session.epoch, state: 'sending' };
        draft.steer = attempt;
        if (draft.operation.error) draft.operation = { ...draft.operation, error: null };
        this.notify();
        try {
            const receipt = await this.client.steerSession(id, { text: attempt.text, clientTurnKey: attempt.key,
                turnId: attempt.turnId, epoch: attempt.epoch });
            if (receipt.clientTurnKey !== attempt.key) throw new Error('Mismatched follow-up receipt');
            draft.requiredSequence = Math.max(draft.requiredSequence, receipt.sequence);
            const state = this.details.get(id);
            if (state) this.details.set(id, reduceCodeSession(state, { type: 'stale' }));
            acknowledgeCodeSteer(draft, attempt.key);
        } catch (error) {
            if (draft.steer === attempt) {
                if (!rejected(error)) {
                    attempt.state = 'unknown';
                    attempt.unrecorded = error instanceof CodeClientError && error.code === 'steer_outcome_unknown';
                } else {
                    draft.steer = null;
                    if (draft.operation.kind === 'idle') draft.operation = { kind: 'idle', error: message(error) };
                }
            }
        }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
    }
    retrySameSend = async (): Promise<void> => {
        const id = this.book.selectedId;
        const draft = this.draft(id);
        if (!id || !this.model.canRetrySameSend || draft.operation.kind !== 'unknown-send') return;
        await this.submit(id, draft);
    };
    private reconcileStop(id: string, target: CodeDraft['stopTarget']): void {
        const draft = this.book.sessions.get(id), state = this.details.get(id), session = this.info(id);
        if (!target || target.outcome !== 'unknown' || draft?.stopTarget !== target || !state?.synced || !session
            || session.sequence > state.cursor || session.turnId !== target.turnId || session.epoch !== target.epoch) return;
        if (session.status === 'starting' || session.status === 'streaming') {
            target.outcome = 'retryable';
            draft.operation = { kind: draft.retry ? 'unknown-send' : 'idle', error: 'Stop could not be confirmed. The same turn is still running. Press Stop to retry for this turn.' };
        } else if (session.status === 'stopping') {
            target.outcome = 'accepted';
            draft.operation = { kind: 'stopping', error: null };
        }
        this.notify();
    }
    stop = async (): Promise<void> => {
        const id = this.book.selectedId, session = this.info(id);
        if (!id || !session?.turnId || !codeSessionBusy(session) || !session.capabilities.interrupt || session.status === 'stopping') return;
        const draft = this.draft(id);
        const previous = draft.stopTarget;
        if (previous && (previous.outcome !== 'retryable' || !this.model.synced
            || previous.turnId !== session.turnId || previous.epoch !== session.epoch)) return;
        const target: NonNullable<CodeDraft['stopTarget']> = previous ?? { turnId: session.turnId, epoch: session.epoch, outcome: 'pending' };
        target.outcome = 'pending';
        draft.stopTarget = target;
        draft.operation = { kind: 'stopping', error: null }; this.notify();
        try {
            const result = await this.client.cancelPrompt(id, { turnId: target.turnId, epoch: target.epoch });
            if (draft.stopTarget === target) target.outcome = 'accepted';
            this.accept(result);
        } catch (error) {
            if (draft.stopTarget === target) {
                target.outcome = 'unknown';
                draft.operation = { kind: 'stopping', error: message(error) };
                if (rejected(error)) { draft.stopTarget = null; draft.operation.kind = 'idle'; }
            }
        }
        this.notify(); this.scheduleIndex();
        if (this.active) {
            // An earlier read cannot prove what happened to this failed cancel.
            if (target.outcome === 'unknown') await this.syncing.get(id);
            if (this.active) await this.sync(id, true);
        }
    };
    resume = async (): Promise<void> => {
        const id = this.book.selectedId, session = this.info(id), draft = this.draft(id);
        if (!id || !session || !this.model.synced || draft.operation.kind !== 'idle' || session.archivedAt !== null
            || !['suspended', 'failed'].includes(session.status) || !session.capabilities.resume || !session.resume.available
            || (session.status === 'failed' && !session.error?.recoverable)) return;
        draft.operation = { kind: 'resuming', error: null }; this.notify();
        try { this.accept(await this.client.attachSession(id)); draft.operation = { kind: 'idle', error: null }; }
        catch (error) { draft.operation = { kind: 'idle', error: message(error) }; }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
    };
    rollbackSession = async (itemId: string): Promise<void> => {
        const id = this.book.selectedId, session = this.info(id), draft = this.draft(id);
        // A follow-up still in flight settles first: its answer may name the turn this would remove.
        if (!id || !session || !codeCanRollback(session, this.model.synced, draft.operation.kind === 'idle' && draft.steer?.state !== 'sending')) return;
        draft.operation = { kind: 'rolling-back', error: null }; this.notify();
        try {
            this.accept(await this.client.rollbackSession(id, { expectedRevision: session.revision, expectedEpoch: session.epoch, upToItemId: itemId }));
            draft.operation = { kind: 'idle', error: null };
        } catch (error) {
            if (error instanceof CodeClientError && error.session?.sessionId === id) { this.observe(error.session); this.accept(error.session); }
            draft.operation = { kind: 'idle', error: error instanceof CodeClientError && error.code === 'revision_conflict' ? ROLLBACK_CONFLICT : message(error) };
        }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
    };
    answer = async (permission: CodePermissionRequest, optionId: string): Promise<void> => {
        const id = permission.sessionId;
        const state = this.details.get(id), session = this.info(id), draft = this.draft(id);
        if (draft.permissionOperations[permission.permissionId]?.pending) return;
        const current = state?.permissions.find(row => row.permissionId === permission.permissionId);
        if (!state?.synced || !session || session.sequence > state.cursor || !current
            || current.turnId !== permission.turnId || current.epoch !== permission.epoch
            || session.turnId !== permission.turnId || session.epoch !== permission.epoch
            || !current.options.some(option => option.optionId === optionId)) {
            draft.permissionOperations[permission.permissionId] = { pending: false, error: 'This approval is no longer current. Refresh its status.' };
            this.notify(); if (this.active) await this.sync(id, true); return;
        }
        draft.permissionOperations[permission.permissionId] = { pending: true, error: null }; this.notify();
        try {
            await this.client.answerPermission(permission.permissionId, { sessionId: id, turnId: permission.turnId, epoch: permission.epoch, optionId });
            draft.permissionOperations[permission.permissionId] = { pending: true, error: null };
        } catch (error) {
            draft.permissionOperations[permission.permissionId] = { pending: true, error: message(error) };
        }
        this.notify(); this.scheduleIndex();
        if (this.active) await this.sync(id, true);
        const refreshed = this.details.get(id);
        const remaining = !refreshed?.synced || refreshed.permissions.some(row => row.permissionId === permission.permissionId);
        const operation = draft.permissionOperations[permission.permissionId];
        if (remaining && operation) draft.permissionOperations[permission.permissionId] = { pending: false, error: operation.error };
        else delete draft.permissionOperations[permission.permissionId];
        this.notify();
    };
    loadOlderHistory = async (): Promise<void> => {
        const id = this.book.selectedId;
        if (!id || this.historyLoading.has(id)) return;
        const state = this.details.get(id);
        if (!state?.hydrated || !state.hasOlder || state.beforeSequence === null) return;
        const life = this.lifetime;
        this.historyLoading.add(id);
        try {
            const page = await this.client.history(id, state.beforeSequence, this.abort.signal);
            if (this.active && life === this.lifetime && this.details.get(id)?.beforeSequence === state.beforeSequence) {
                this.update(id, reduceCodeSession(this.state(id), { type: 'history', page }));
            }
        } catch (error) {
            if (this.active && life === this.lifetime) { this.draft(id).operation.error = message(error); this.notify(); }
        } finally { this.historyLoading.delete(id); }
    };
}
