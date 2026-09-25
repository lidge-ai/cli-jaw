import type { CodeSessionInfo } from '../../../../src/code-mode/wire';

/**
 * Which workspaces the draft empty state offers, kept apart from rendering so
 * the rule can be tested on its own.
 *
 * "Recent" is last use, not creation: a session created months ago and used
 * this morning is a more useful suggestion than one created yesterday and
 * abandoned. Uniqueness is on the directory — the workspace, not the session —
 * so the list never offers the same folder twice.
 */
export function recentCodeWorkspaces(sessions: readonly CodeSessionInfo[], max = 5): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const ordered = [...sessions].sort((left, right) => right.lastUsedAt - left.lastUsedAt
        || right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId));
    for (const session of ordered) {
        const cwd = session.cwd;
        if (!cwd.trim() || seen.has(cwd)) continue;
        seen.add(cwd);
        out.push(cwd);
        if (out.length >= max) break;
    }
    return out;
}
