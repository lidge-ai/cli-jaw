/** Public Code contracts. Native runtime identities never belong on this wire. */
export type CodeProviderId = 'codex-app' | 'claude' | 'cursor' | 'grok';
export type CodePermissionMode = 'ask' | 'auto' | 'read-only';
export type CodeSessionStatus = 'idle' | 'starting' | 'streaming' | 'stopping' | 'suspended' | 'failed';

export interface CodeCapabilities {
    resume: boolean;
    interrupt: boolean;
    permissions: boolean;
    setModelMidSession: boolean;
    efforts: string[];
    permissionModes: CodePermissionMode[];
}

export interface CodeSessionError {
    code: string;
    message: string;
    at: number;
    recoverable: boolean;
}

export interface CodeSessionInfo {
    sessionId: string;
    provider: CodeProviderId;
    cwd: string;
    title: string | null;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
    status: CodeSessionStatus;
    turnId: string | null;
    archivedAt: number | null;
    error: CodeSessionError | null;
    resume: { available: boolean; reason: string | null };
    capabilities: CodeCapabilities;
    epoch: number;
    sequence: number;
    revision: number;
    createdAt: number;
    lastUsedAt: number;
    /** When the latest turn ended completed or failed; null until one has. A cancelled turn does not move it. */
    lastTurnCompletedAt: number | null;
    /** When the Manager last opened this session; null if it never has (never counts as unread). */
    lastVisitedAt: number | null;
    /** Current index/snapshot attention, absent when not hydrated. */
    pendingPermissionCount?: number;
    /**
     * Latest reported context usage, absent when the runtime has not reported
     * any. Like `pendingPermissionCount` this is attached at read time and
     * never persisted: a number that was true for a process that has since
     * exited is not a fact about the session now.
     */
    contextUsage?: CodeContextUsage;
    /**
     * True while a retired native runtime still holds resources without
     * physical close proof. Attached at read time like the attention fields
     * above and never persisted: `idle` means the turn is over, not that the
     * session can take new work — while this reads true the same session
     * refuses with `cleanup_pending` and the residue still counts toward
     * `session_capacity`. It clears on the first read or admission that
     * observes every resource closed.
     */
    cleanupPending?: boolean;
}

/**
 * What the native runtime said about the conversation's size.
 *
 * Every field except the total is nullable, because the runtime may report a
 * breakdown without a window or a window without a breakdown, and an absent
 * measurement must not be shown as zero.
 */
export interface CodeContextUsage {
    /** Tokens resident in the context, from the runtime's last turn. */
    totalTokens: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    /** Tokens billed across the conversation. Cost, not occupancy. */
    processedTokens: number | null;
    modelContextWindow: number | null;
    updatedAt: number;
}

export interface CodePermissionRequest {
    permissionId: string;
    sessionId: string;
    turnId: string;
    epoch: number;
    title: string;
    detail: string;
    options: Array<{ optionId: string; label: string; kind: string }>;
    requestedAt: number;
}

export type CodeItemKind = 'user_message' | 'assistant_message' | 'reasoning'
    | 'tool_call' | 'file_change' | 'permission_request' | 'turn_started'
    | 'turn_completed' | 'turn_failed' | 'turn_cancelled' | 'session_runtime' | 'notice';

export interface CodeItem {
    itemId: string;
    /** Store-owned first appearance order, unchanged by later updates. */
    firstSequence?: number;
    turnId: string | null;
    kind: CodeItemKind;
    status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
    phase?: 'commentary' | 'final' | 'unknown';
    text?: string;
    clientTurnKey?: string;
    tool?: { name: string; input?: string; detail?: string; output?: string };
    permission?: CodePermissionRequest;
    truncation?: { storedChars: number; sourceChars: number; reason: string };
    parentItemId?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CodeWireEvent {
    topic: 'code';
    event: 'code_item' | 'code_item_update' | 'code_session';
    sessionId: string;
    sequence: number;
    epoch: number;
    item?: CodeItem;
    update?: CodeItemUpdate;
    session?: CodeSessionInfo;
}

/** Sequence-ordered compact update; snapshots always contain complete items. */
export interface CodeItemUpdate {
    itemId: string;
    turnId: string | null;
    firstSequence: number;
    updatedAt: number;
    appendText?: string;
    appendToolOutput?: string;
    status?: CodeItem['status'];
    phase?: CodeItem['phase'];
}

export interface CodeSnapshot {
    session: CodeSessionInfo;
    items: CodeItem[];
    sequence: number;
    pendingPermissions: CodePermissionRequest[];
    truncated: boolean;
}

export interface CodePromptReceipt {
    turnId: string;
    clientTurnKey: string;
    sequence: number;
    status: 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed';
}

export interface CodeEventsPage {
    events: CodeWireEvent[];
    nextSequence: number;
    throughSequence: number;
    hasMore: boolean;
}

export interface CodeHistoryPage {
    items: CodeItem[];
    beforeSequence: number | null;
    hasMore: boolean;
    sequence: number;
}

/**
 * Position inside the session index's stable creation order (created_at DESC,
 * session_id ASC). Pages are keyset slices: pass the cursor back to read the
 * strictly-lower rows. The order key never moves, so a stream covers every
 * session matching the filter when it started, once each; sessions created or
 * newly matching ahead of the cursor belong to a later from-scratch read.
 */
export interface CodeSessionCursor {
    createdAt: number;
    sessionId: string;
}

export interface CodeSessionPage {
    sessions: CodeSessionInfo[];
    limit: number;
    /** Opaque cursor for the next page; null when the stream is exhausted. */
    nextCursor: string | null;
    hasMore: boolean;
}

export interface CodeCreateSessionRequest {
    provider: CodeProviderId;
    cwd: string;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
}

export interface CodePatchSessionRequest {
    expectedRevision: number;
    title?: string | null;
    model?: string;
    effort?: string | null;
    permissionMode?: CodePermissionMode;
    archived?: boolean;
}

export interface CodePromptRequest { text: string; clientTurnKey: string }
export interface CodeCancelRequest { turnId: string; epoch: number }
export interface CodePermissionAnswer {
    sessionId: string;
    turnId: string;
    epoch: number;
    optionId: string;
}

export interface CodeProviderCatalog {
    id: CodeProviderId;
    label: string;
    available: boolean;
    reason: string | null;
    models: string[];
    defaultModel: string;
    defaultEffort: string | null;
    capabilities: CodeCapabilities;
    modelSource: 'registry' | 'cache' | 'native' | 'live';
    /**
     * Per-model reasoning-effort sets, when the runtime advertises them.
     * An entry may be an EMPTY array, which means the model takes no effort at
     * all — that is different from an absent entry, which means "unknown, fall
     * back to `capabilities.efforts`".
     */
    effortsByModel?: Record<string, string[]>;
    defaultEffortByModel?: Record<string, string>;
}

export interface CodeModelCatalog {
    providers: CodeProviderCatalog[];
    defaultProvider: CodeProviderId;
}
