import type { CodeSessionInfo } from '../../../../src/code-mode/wire';

/**
 * How the session list is ordered and grouped, kept apart from rendering so the
 * rules can be stated and tested on their own.
 *
 * The server pages sessions by `created_at DESC` — the stable key that keeps a
 * paged read complete while `last_used_at` moves under it. Order here is
 * anchored to that same creation order: a row holds its place until something
 * actually changes about it, so the list moves when a session is created or
 * archived and not merely because it is busy. Which session is running is
 * carried by the row's own status, which is where a changing fact belongs.
 * The one exception is the Activity view the reader switches to on purpose,
 * which is ordered by last activity with unread sessions on top.
 */
export type CodeSessionSection = 'active' | 'archived';

export function codeSessionSection(session: CodeSessionInfo): CodeSessionSection {
    return session.archivedAt === null ? 'active' : 'archived';
}

/** Creation order, newest first. Ties break on id so the order is total. */
export function compareCodeSessions(left: CodeSessionInfo, right: CodeSessionInfo): number {
    return right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId);
}

/**
 * Pinned rows leave their workspace or activity group and sit together on top,
 * most recently pinned first. `null` sorts below any real pin.
 */
export function comparePinnedCodeSessions(left: CodeSessionInfo, right: CodeSessionInfo): number {
    return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) || compareCodeSessions(left, right);
}

export type CodeSessionGroup = {
    section: CodeSessionSection;
    sessions: CodeSessionInfo[];
};

/**
 * Active first, then archived. Archived sessions are history: they are ordered
 * by when they were archived, because "when did I put this away" is the
 * question that section answers, and they fall back to creation order when a
 * record predates the field.
 */
export function groupCodeSessions(sessions: readonly CodeSessionInfo[]): CodeSessionGroup[] {
    const active = sessions.filter(session => codeSessionSection(session) === 'active').sort(compareCodeSessions);
    const archived = sessions.filter(session => codeSessionSection(session) === 'archived')
        .sort((left, right) => (right.archivedAt ?? right.createdAt) - (left.archivedAt ?? left.createdAt)
            || left.sessionId.localeCompare(right.sessionId));
    const groups: CodeSessionGroup[] = [];
    if (active.length) groups.push({ section: 'active', sessions: active });
    if (archived.length) groups.push({ section: 'archived', sessions: archived });
    return groups;
}

/**
 * What a row says about itself, beyond its title.
 *
 * Idle is the common case and says nothing: a label on every row is a label on
 * no row, and it costs the one session that is actually waiting its visibility.
 * Unknown stays unknown -- an unhydrated approval count is not zero approvals.
 */
export type CodeSessionAttention =
    | { kind: 'none' }
    | { kind: 'unknown' }
    | { kind: 'approvals'; count: number };

export function codeSessionAttention(count: number | undefined): CodeSessionAttention {
    if (count === undefined) return { kind: 'unknown' };
    return count > 0 ? { kind: 'approvals', count } : { kind: 'none' };
}

export function codeSessionAttentionLabel(attention: CodeSessionAttention): string {
    if (attention.kind === 'unknown') return 'Approval status unknown';
    if (attention.kind === 'none') return 'No pending approvals';
    return `${attention.count} pending approval${attention.count === 1 ? '' : 's'}`;
}


/**
 * t3code's hasUnseenCompletion: a finished turn the reader has not opened since.
 * A session never opened, or one archived, is never unread — an update must not
 * light up every historical row.
 */
export function codeSessionUnread(session: CodeSessionInfo): boolean {
    if (session.archivedAt !== null) return false;
    if (session.markedUnread) return true;
    const completed = session.lastTurnCompletedAt;
    const visited = session.lastVisitedAt;
    if (completed === null || visited === null) return false;
    return completed > visited;
}

export type CodeWorkspaceGroup = { cwd: string; sessions: CodeSessionInfo[] };

/**
 * Projects view. Rows keep creation order inside their workspace, and a workspace
 * is placed by its newest session: creating a session brings its workspace up,
 * a busy session moves nothing.
 */
export function groupCodeSessionsByWorkspace(sessions: readonly CodeSessionInfo[]): CodeWorkspaceGroup[] {
    const map = new Map<string, CodeSessionInfo[]>();
    for (const session of [...sessions].sort(compareCodeSessions)) {
        const rows = map.get(session.cwd) ?? [];
        rows.push(session);
        map.set(session.cwd, rows);
    }
    return [...map].map(([cwd, rows]) => ({ cwd, sessions: rows }));
}

export type CodeActivityBucket = 'priority' | 'today' | 'yesterday' | 'earlier';
export type CodeActivityGroup = { bucket: CodeActivityBucket; sessions: CodeSessionInfo[] };

const ACTIVITY_BUCKET_ORDER: CodeActivityBucket[] = ['priority', 'today', 'yesterday', 'earlier'];

export const CODE_ACTIVITY_BUCKET_LABELS: Record<CodeActivityBucket, string> = {
    priority: 'Priority', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier',
};

function startOfLocalDay(ms: number): number {
    const day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
}

/**
 * Activity view, which the reader opts into: unread sessions first (newest
 * completion first), then the rest by last activity in local-day buckets. The
 * open session is never in Priority, even before its read receipt lands.
 */
export function groupCodeSessionsByActivity(sessions: readonly CodeSessionInfo[], now = Date.now(),
    openSessionId: string | null = null): CodeActivityGroup[] {
    const today = startOfLocalDay(now);
    const yesterday = startOfLocalDay(today - 1);
    const byBucket = new Map<CodeActivityBucket, CodeSessionInfo[]>();
    for (const session of sessions) {
        const bucket: CodeActivityBucket = session.sessionId !== openSessionId && codeSessionUnread(session) ? 'priority'
            : session.lastUsedAt >= today ? 'today'
                : session.lastUsedAt >= yesterday ? 'yesterday' : 'earlier';
        const rows = byBucket.get(bucket) ?? [];
        rows.push(session);
        byBucket.set(bucket, rows);
    }
    const key = (bucket: CodeActivityBucket, session: CodeSessionInfo) =>
        bucket === 'priority' ? (session.lastTurnCompletedAt ?? session.lastUsedAt) : session.lastUsedAt;
    return ACTIVITY_BUCKET_ORDER.filter(bucket => byBucket.has(bucket)).map(bucket => ({
        bucket,
        sessions: byBucket.get(bucket)!.sort((left, right) =>
            key(bucket, right) - key(bucket, left) || left.sessionId.localeCompare(right.sessionId)),
    }));
}

/** Last path segment for labels; callers keep the full path in a title attribute. */
export function codeWorkspaceName(cwd: string): string {
    const trimmed = cwd.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() || cwd;
}
