import type {
    CodeCancelRequest, CodeCreateSessionRequest, CodeEventsPage, CodeHistoryPage, CodeModelCatalog,
    CodePatchSessionRequest, CodePermissionAnswer, CodePromptReceipt, CodePromptRequest,
    CodeSessionInfo, CodeSessionPage, CodeSnapshot,
} from '../../../../src/code-mode/wire';

export interface CodeGitInfo {
    isRepo: boolean;
    repoRoot?: string;
    relativePath?: string;
    branch: string | null;
    head?: string | null;
    status?: {
        dirty: boolean;
        changed: number;
        untracked: number;
    };
    worktrees: Array<{
        path: string;
        branch: string | null;
        head?: string | null;
        current?: boolean;
    }>;
    currentWorktree?: {
        path: string;
        branch: string | null;
        head?: string | null;
    };
}

export interface CodeListOptions {
    scope?: 'all' | 'cwd'; cwd?: string; archived?: boolean; cursor?: string; limit?: number;
}
export interface CodeSessionClient {
    listSessions(options?: CodeListOptions, signal?: AbortSignal): Promise<CodeSessionPage>;
    listModelOptions(signal?: AbortSignal): Promise<CodeModelCatalog>;
    snapshot(id: string, signal?: AbortSignal): Promise<CodeSnapshot>;
    events(id: string, afterSequence: number, signal?: AbortSignal): Promise<CodeEventsPage>;
    history(id: string, beforeSequence: number, signal?: AbortSignal): Promise<CodeHistoryPage>;
    createSession(input: CodeCreateSessionRequest): Promise<CodeSessionInfo>;
    patchSession(id: string, input: CodePatchSessionRequest): Promise<CodeSessionInfo>;
    sendPrompt(id: string, input: CodePromptRequest): Promise<CodePromptReceipt>;
    cancelPrompt(id: string, input: CodeCancelRequest): Promise<CodeSessionInfo>;
    attachSession(id: string): Promise<CodeSessionInfo>;
    visitSession(id: string): Promise<CodeSessionInfo>;
    answerPermission(id: string, input: CodePermissionAnswer): Promise<void>;
    getGitInfo(cwd: string, signal?: AbortSignal): Promise<CodeGitInfo>;
    pickWorkspace(): Promise<{ ok: boolean; path?: string; cancelled?: boolean }>;
}

const ERROR_COPY: Record<string, string> = {
    session_busy: 'This session is busy. Wait for it to finish or stop the current turn.',
    request_not_current: 'This approval is no longer current. Refreshing its status.',
    invalid_option: 'This approval option is no longer available. Refreshing its status.',
    revision_conflict: 'Session settings changed elsewhere. Review the updated values and try again.',
    invalid_sequence: 'Conversation history needs to be refreshed.',
    snapshot_limit: 'This conversation exceeds the snapshot limit. Stop and recovery controls remain available.',
    transcript_limit: 'The conversation has reached its storage limit.',
    event_too_large: 'A conversation update exceeds the supported size.',
    provider_unavailable: 'This runtime is unavailable. Check its installation and authentication.',
    unsupported_model: 'This model is not available for the selected runtime.',
    unsupported_effort: 'This effort is not supported by the selected runtime.',
    unsupported_policy: 'This permission mode is not supported by the selected runtime.',
    unsupported_capability: 'This runtime does not support this action.',
    session_not_found: 'This session is no longer available. Its local draft is retained.',
    unauthorized: 'Authentication is required to access this instance.',
};

export class CodeClientError extends Error {
    constructor(readonly code: string, readonly status: number, readonly session?: CodeSessionInfo) {
        super(ERROR_COPY[code] ?? 'The request could not be completed. Refresh the session and try again.');
        this.name = 'CodeClientError';
    }
}

export function codeBaseOrigin(port: number): string {
    return typeof window !== 'undefined' && window.location.port === String(port)
        ? window.location.origin : `http://127.0.0.1:${port}`;
}

export function createCodeSessionClient(port: number): CodeSessionClient {
    const base = codeBaseOrigin(port);
    async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        const response = await fetch(`${base}/api/code${path}`, {
            method, ...(signal === undefined ? {} : { signal }),
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
        const data = await response.json();
        if (!response.ok || data.ok !== true) {
            throw new CodeClientError(typeof data.error === 'string' ? data.error : 'code_request_failed', response.status, data.session);
        }
        return data as T;
    }
    const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
    const sessionRequest = async (method: string, path: string, body?: unknown) =>
        (await request<{ session: CodeSessionInfo }>(method, path, body)).session;
    return {
        listSessions(options = {}, signal) {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
            return request('GET', `/sessions?${query}`, undefined, signal);
        },
        listModelOptions: signal => request('GET', '/models', undefined, signal),
        snapshot: (id, signal) => request('GET', sessionPath(id), undefined, signal),
        events: (id, afterSequence, signal) => request('GET', `${sessionPath(id)}/events?afterSequence=${afterSequence}&limit=500`, undefined, signal),
        history: (id, beforeSequence, signal) => request('GET', `${sessionPath(id)}/items?beforeSequence=${beforeSequence}&limit=200`, undefined, signal),
        createSession: input => sessionRequest('POST', '/sessions', input),
        patchSession: (id, input) => sessionRequest('PATCH', sessionPath(id), input),
        sendPrompt: (id, input) => request('POST', `${sessionPath(id)}/prompt`, input),
        cancelPrompt: (id, input) => sessionRequest('POST', `${sessionPath(id)}/cancel`, input),
        attachSession: id => sessionRequest('POST', `${sessionPath(id)}/attach`, {}),
        visitSession: id => sessionRequest('POST', `${sessionPath(id)}/visit`, {}),
        async answerPermission(id, input) { await request('POST', `/permissions/${encodeURIComponent(id)}`, input); },
        getGitInfo: (cwd, signal) => request('GET', `/git-info?cwd=${encodeURIComponent(cwd)}`, undefined, signal),
        pickWorkspace: () => request('POST', '/workspace/pick'),
    };
}
