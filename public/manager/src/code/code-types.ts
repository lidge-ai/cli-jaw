import type { CodeItem, CodePermissionMode, CodeProviderId, CodeSessionInfo, CodeSessionStatus } from '../../../../src/code-mode/wire';

export const CODE_RUNTIME_LABELS: Record<CodeProviderId, string> = {
    'codex-app': 'Codex', claude: 'Claude', cursor: 'Cursor', grok: 'Grok',
};
export const CODE_POLICY_LABELS: Record<CodePermissionMode, string> = {
    ask: 'Ask first', auto: 'Auto (YOLO)', 'read-only': 'Read only',
    plan: 'Plan', 'accept-edits': 'Accept edits', 'dont-ask': "Don't ask", 'auto-review': 'Auto review',
};
export const CODE_POLICY_DETAILS: Record<CodePermissionMode, string> = {
    ask: 'Review native permission requests before allowing actions.',
    auto: 'The native runtime may execute actions without asking for approval.',
    'read-only': 'The native runtime restricts actions to read-only access.',
    plan: 'Claude plans without applying edits.',
    'accept-edits': 'File edits proceed; other actions still ask.',
    'dont-ask': 'Actions not already allowed for this session are denied without asking.',
    'auto-review': 'A classifier approves or denies each action; unsure calls still ask.',
};
export const CODE_SESSION_LABELS: Record<CodeSessionStatus, string> = {
    idle: 'Ready', starting: 'Starting', streaming: 'Running', stopping: 'Stopping', suspended: 'Suspended', failed: 'Runtime failed',
};
export function codeSessionBusy(session: CodeSessionInfo): boolean {
    return session.status === 'starting' || session.status === 'streaming' || session.status === 'stopping';
}
export function codeCanResume(session: CodeSessionInfo): boolean {
    return session.archivedAt === null && session.capabilities.resume && session.resume.available
        && (session.status === 'suspended' || (session.status === 'failed' && session.error?.recoverable === true));
}
/**
 * Whether the open session may roll its conversation back right now. An older server
 * without the `rollback` field reads as unavailable.
 */
export function codeCanRollback(session: CodeSessionInfo | null, synced: boolean, idleOperation: boolean): boolean {
    return !!session && session.rollback?.available === true && session.archivedAt === null && synced && idleOperation
        && (session.status === 'idle' || session.status === 'failed');
}

/**
 * User rows a rollback may target: a settled turn's own `${turnId}:user` row (never the
 * unsent row or a follow-up), at or after the first recorded boundary, with a later turn.
 */
export function codeRollbackRows(items: readonly CodeItem[], sinceSequence: number | null | undefined): ReadonlySet<string> {
    const rows = new Set<string>();
    if (sinceSequence == null) return rows;
    const settled = new Set(items.filter(item => item.kind === 'turn_completed' || item.kind === 'turn_failed'
        || item.kind === 'turn_cancelled').map(item => item.turnId));
    const turns = items.filter(item => item.kind === 'user_message' && item.turnId !== null
        && item.itemId === `${item.turnId}:user` && item.firstSequence !== undefined);
    // One row per turn, so a later turn exists exactly when the row is not the newest one.
    const newest = Math.max(...turns.map(row => row.firstSequence!));
    for (const row of turns) {
        if (row.firstSequence! >= sinceSequence && row.firstSequence! < newest && settled.has(row.turnId)) rows.add(row.itemId);
    }
    return rows;
}

export function codeItemStatus(item: CodeItem): string {
    if (item.kind === 'turn_cancelled' || item.status === 'cancelled') return 'Stopped';
    if (item.kind === 'turn_failed' || item.status === 'error') return 'Failed';
    if (item.kind === 'turn_completed') return 'Completed';
    return { pending: 'Pending', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Stopped' }[item.status];
}
