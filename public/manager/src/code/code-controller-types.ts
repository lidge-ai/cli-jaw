import type {
    CodeCreateSessionRequest, CodeItem, CodeModelCatalog, CodePermissionRequest, CodeSessionInfo,
} from '../../../../src/code-mode/wire';
import type { CodeGitInfo } from './code-session-client';

export type CodeTransportState = 'connected' | 'reconnecting' | 'disconnected';
export type CodeSessionFilter = { scope: 'all' | 'cwd'; archived: boolean };
export type CodeOperationKind = 'idle' | 'creating' | 'sending' | 'stopping' | 'resuming' | 'patching' | 'rolling-back' | 'unknown-send';
export interface CodeControllerOptions { port: number; workingDir: string }

export interface CodeControllerModel {
    catalog: CodeModelCatalog | null;
    sessions: CodeSessionInfo[];
    selectedId: string | null;
    session: CodeSessionInfo | null;
    items: CodeItem[];
    permissions: CodePermissionRequest[];
    input: string;
    /** The fresh (un-sent) draft holds content or an unreconciled attempt. */
    hasUnsentDraft: boolean;
    selection: CodeCreateSessionRequest;
    gitInfo: CodeGitInfo | null;
    loading: boolean;
    pending: boolean;
    busy: boolean;
    /** The selected session is working: a send awaiting its turn, or a busy runtime. */
    working: boolean;
    /** Rows that are working, by session id. */
    workingIds: ReadonlySet<string>;
    /** The selected, synchronized Claude session is streaming a turn that takes a follow-up. */
    followUp: boolean;
    /** That turn's one follow-up is already in the transcript, so Send follow-up stays closed. */
    followUpSent: boolean;
    /** A follow-up for the selected session is in flight. */
    steering: boolean;
    workspacePicking: boolean;
    synced: boolean;
    error: string | null;
    transport: CodeTransportState;
    operation: { kind: CodeOperationKind; error: string | null };
    retryText: string | null;
    canRetrySameSend: boolean;
    /** The previous key is spent: Retry sends a new message rather than reusing it. */
    resendRequired?: boolean;
    permissionOperations: Record<string, { pending: boolean; error: string | null }>;
    hasMoreSessions: boolean;
    hasOlderHistory: boolean;
    filter: CodeSessionFilter;
    creationUnknown: boolean;
    startAnotherSession(): void;
    newSession(): void;
    selectSession(id: string): Promise<void>;
    setInput(text: string): void;
    setSelection(patch: Partial<CodeCreateSessionRequest>): Promise<void>;
    pickWorkspace(): Promise<void>;
    send(): Promise<void>;
    retrySameSend(): Promise<void>;
    stop(): Promise<void>;
    resume(): Promise<void>;
    /** Claude only: remove the turns after this `${turnId}:user` row. Files are not reverted and nothing is sent. */
    rollbackSession(itemId: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    archive(id: string, archived: boolean): Promise<void>;
    answer(permission: CodePermissionRequest, optionId: string): Promise<void>;
    refresh(): Promise<void>;
    loadMoreSessions(): Promise<void>;
    loadOlderHistory(): Promise<void>;
    setFilter(filter: CodeSessionFilter): void;
    clearError(): void;
}
