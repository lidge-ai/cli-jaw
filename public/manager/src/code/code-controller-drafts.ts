import type { CodeCreateSessionRequest, CodeModelCatalog, CodeSessionInfo } from '../../../../src/code-mode/wire';
import type { CodeControllerModel } from './code-controller-types';
import { browserCodeDraftStorage, loadCodeDraftStorage, saveCodeDraftStorage, type StoredCodeDraft } from './code-controller-draft-storage';
import { codeResendCopy, type CodeResendReason } from './code-types';

export interface CodeDraft {
    input: string;
    edit: number;
    selection: CodeCreateSessionRequest;
    selectionEdit: number;
    operation: CodeControllerModel['operation'];
    /**
     * `resend` marks an attempt whose key the server already spent. Acceptance is
     * then known — it failed — so the surfaces that describe an unconfirmed send
     * must stop hedging. `resendReason` says why, when it was not the server's own settlement.
     */
    retry: { text: string; key: string; edit: number; resend?: boolean; resendReason?: CodeResendReason } | null;
    createUnknown: boolean;
    requiredSequence: number;
    stopTarget: { turnId: string; epoch: number; outcome: 'pending' | 'unknown' | 'retryable' | 'accepted' } | null;
    permissionOperations: CodeControllerModel['permissionOperations'];
    /**
     * The clientTurnKey of a send whose turn has not visibly started or ended yet.
     * Bridges the gap between pressing Send and the server reporting the turn, so
     * the session reads as working the whole time. In-memory only: a reloaded page
     * must not show a phantom spinner.
     */
    awaitingTurn: string | null;
    /**
     * A follow-up for the running Claude turn, captured with that turn's owner. In-memory only
     * and never the send's `operation`/`retry`: it settles on its receipt or on its own
     * `user_message`, and `unknown` means acceptance could not be confirmed (never resent).
     */
    steer: {
        key: string; text: string; edit: number; turnId: string; epoch: number; state: 'sending' | 'unknown';
        /** The server answered `steer_outcome_unknown`: Claude may have it, but the transcript never will. */
        unrecorded?: boolean;
    } | null;
}
export interface CodeDraftBook {
    endpoint: string;
    storage: Storage | null;
    storageWarning: string | null;
    recoveryWarning: string | null;
    selectedId: string | null;
    navigation: number;
    fresh: CodeDraft;
    sessions: Map<string, CodeDraft>;
    listeners: Set<() => void>;
}
// RAM owns active commands across remounts; a fresh tab storage object restores
// only local intent. Native/session state always comes from new server reads.
const memoryBooks = new Map<string, CodeDraftBook>();
const tabBooks = new WeakMap<Storage, Map<string, CodeDraftBook>>();
export function createCodeDraft(selection: CodeCreateSessionRequest): CodeDraft {
    return { input: '', edit: 0, selection: { ...selection }, selectionEdit: 0,
        operation: { kind: 'idle', error: null }, retry: null, createUnknown: false, requiredSequence: 0,
        stopTarget: null, permissionOperations: {}, awaitingTurn: null, steer: null };
}
function restoreDraft(saved: StoredCodeDraft): CodeDraft {
    const draft = createCodeDraft(saved.selection);
    draft.input = saved.input; draft.edit = saved.edit; draft.selectionEdit = saved.selectionEdit;
    draft.createUnknown = saved.creating;
    draft.retry = saved.retry;
    if (saved.creating) draft.operation = { kind: 'creating', error: 'Creation was interrupted by reload. The original session may exist; no request has been retried.' };
    if (saved.retry) draft.operation = { kind: 'unknown-send', error: saved.retry.resend
        ? codeResendCopy(saved.retry.resendReason).error
        : 'The original message has not been reconciled after reload. It will not be sent automatically.' };
    if (saved.stop) {
        draft.stopTarget = { ...saved.stop, outcome: 'unknown' };
        draft.operation = { kind: 'stopping', error: 'Checking the captured Stop after reload. No cancellation has been resent.' };
    }
    return draft;
}
export function codeDraftBook(endpoint: string, cwd: string): CodeDraftBook {
    const access = browserCodeDraftStorage();
    let books = access.storage ? tabBooks.get(access.storage) : memoryBooks;
    if (!books) { books = new Map(); tabBooks.set(access.storage!, books); }
    let book = books.get(endpoint);
    if (!book) {
        const restored = access.storage ? loadCodeDraftStorage(access.storage, endpoint) : { data: null, warning: access.warning };
        book = { endpoint, storage: access.storage, storageWarning: access.warning, recoveryWarning: restored.warning,
            selectedId: restored.data?.selectedId ?? null, navigation: 0,
            fresh: restored.data ? restoreDraft(restored.data.fresh) : createCodeDraft({
                provider: 'codex-app', cwd, model: '', effort: null, permissionMode: 'ask',
            }), sessions: new Map<string, CodeDraft>(restored.data?.sessions.map(row => [row.id, restoreDraft(row.draft)]) ?? []), listeners: new Set() };
        books.set(endpoint, book);
    }
    return book;
}
export function persistCodeDraftBook(book: CodeDraftBook): void {
    if (book.storage) book.storageWarning = saveCodeDraftStorage(book.storage, book.endpoint, book);
}
export function sessionSelection(session: CodeSessionInfo): CodeCreateSessionRequest {
    return { provider: session.provider, cwd: session.cwd, model: session.model,
        effort: session.effort, permissionMode: session.permissionMode,
        ...(session.thinking === null ? {} : { thinking: session.thinking }) };
}
export function catalogSelection(catalog: CodeModelCatalog, previous: CodeCreateSessionRequest, changedProvider = false): CodeCreateSessionRequest {
    const provider = catalog.providers.find(row => row.id === previous.provider);
    if (!provider) return previous;
    const capabilities = provider.capabilities;
    // Thinking is a Claude switch; it must not travel into a create for another runtime.
    const { thinking, ...rest } = previous;
    return { ...rest, ...(provider.id === 'claude' && thinking !== undefined ? { thinking } : {}),
        model: !changedProvider && provider.models.includes(previous.model) ? previous.model : provider.defaultModel,
        effort: !changedProvider && previous.effort !== null && capabilities.efforts.includes(previous.effort)
            ? previous.effort : null,
        permissionMode: !capabilities.permissions ? 'auto'
            : !changedProvider && capabilities.permissionModes.includes(previous.permissionMode) ? previous.permissionMode
            : capabilities.permissions && capabilities.permissionModes.includes('ask') ? 'ask'
                : capabilities.permissionModes.includes('auto') ? 'auto' : 'read-only',
    };
}
/** The follow-up is in the transcript: clear the input only if it was not edited since. */
export function acknowledgeCodeSteer(draft: CodeDraft, key: string): void {
    if (draft.steer?.key !== key) return;
    if (draft.edit === draft.steer.edit) { draft.input = ''; draft.edit++; }
    draft.steer = null;
}
export function acknowledgeCodeSend(draft: CodeDraft, key: string): void {
    if (draft.retry?.key !== key) return;
    if (draft.edit === draft.retry.edit) { draft.input = ''; draft.edit++; }
    draft.retry = null;
    if (draft.operation.kind === 'sending' || draft.operation.kind === 'unknown-send') {
        draft.operation = { kind: 'idle', error: null };
    }
}
