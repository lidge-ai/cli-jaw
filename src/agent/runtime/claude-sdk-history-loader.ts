import type { deleteSession, forkSession, getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

/** The SDK transcript helpers Code rollback uses; each reads the local projects dir in process. */
export interface ClaudeHistoryHelpers {
    getSessionInfo: typeof getSessionInfo;
    getSessionMessages: typeof getSessionMessages;
    forkSession: typeof forkSession;
    deleteSession: typeof deleteSession;
}
type SdkImporter = () => Promise<unknown>;
const importSdk: SdkImporter = () => import('@anthropic-ai/claude-agent-sdk');
const pending = new WeakMap<SdkImporter, Promise<ClaudeHistoryHelpers>>();
const HELPERS = ['getSessionInfo', 'getSessionMessages', 'forkSession', 'deleteSession'] as const;

/** Optional SDK absence only disables rollback. Failed loads remain retryable. */
export function loadClaudeHistory(importer: SdkImporter = importSdk): Promise<ClaudeHistoryHelpers> {
    const existing = pending.get(importer);
    if (existing) return existing;
    const loading = Promise.resolve().then(importer).then(mod => {
        if (!mod || typeof mod !== 'object' || HELPERS.some(name => typeof Reflect.get(mod, name) !== 'function')) {
            throw new Error('Claude native SDK has no session history helpers');
        }
        // Each public export's callable shape is checked before exposing its SDK declaration.
        const sdk = mod as ClaudeHistoryHelpers;
        return { getSessionInfo: sdk.getSessionInfo, getSessionMessages: sdk.getSessionMessages,
            forkSession: sdk.forkSession, deleteSession: sdk.deleteSession };
    }).catch(() => {
        pending.delete(importer);
        throw new Error('Claude session history helpers unavailable; install the vetted optional dependency');
    });
    pending.set(importer, loading);
    return loading;
}
