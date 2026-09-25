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
 */
export type CodeSessionSection = 'active' | 'archived';

export function codeSessionSection(session: CodeSessionInfo): CodeSessionSection {
    return session.archivedAt === null ? 'active' : 'archived';
}

/** Creation order, newest first. Ties break on id so the order is total. */
export function compareCodeSessions(left: CodeSessionInfo, right: CodeSessionInfo): number {
    return right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId);
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

