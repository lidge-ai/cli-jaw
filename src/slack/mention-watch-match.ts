// ─── Mention-watch match ─────────────────────────────
// Who a heartbeat mention-watch job may answer: extra subjects, plus optional
// mention-vs-talk conditions. The scan in mention-watch.ts still walks history;
// this file only decides whether one already-fetched message is a hit.
//
// evaluateMessagingAccess is called ONLY when a condition names `authors`.
// Passing authorDeny (or the default deny policy) into it matches nobody.
// The no-conditions path must not call it either: empty actorId is deny even
// for mode:'all', but today's scan still treats a userless non-bot mention
// as a hit.

import { evaluateMessagingAccess, type MessagingAccessPolicy } from '../messaging/access-policy.js';
import type { SlackHistoryMessage } from './history.js';
import { mentionsUser } from './events.js';

export const HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS = 16;
export const HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS = 16;

export type MentionWatchMatch = 'mention' | 'talk';

export interface HeartbeatMentionWatchCondition {
    match: MentionWatchMatch;
    channelIds?: string[];
    authors?: MessagingAccessPolicy;
    authorDeny?: readonly string[];
}

export function mentionWatchSubjects(
    watch: { userId: string; userIds?: readonly string[] | undefined },
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [watch.userId, ...(watch.userIds ?? [])]) {
        if (typeof id !== 'string') continue;
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function isOptionalStringList(value: unknown): value is string[] | undefined {
    if (value === undefined) return true;
    return Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim().length > 0);
}

function isPersistedAuthors(value: unknown): value is MessagingAccessPolicy {
    if (!value || typeof value !== 'object') return false;
    const mode = (value as { mode?: unknown }).mode;
    if (mode !== 'deny' && mode !== 'allowlist' && mode !== 'all') return false;
    const allowlist = (value as { allowlist?: unknown }).allowlist;
    if (allowlist !== undefined) {
        if (!Array.isArray(allowlist) || !allowlist.every(id => typeof id === 'string')) return false;
    }
    return true;
}

export function isHeartbeatMentionWatchCondition(value: unknown): value is HeartbeatMentionWatchCondition {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    if (c['match'] !== 'mention' && c['match'] !== 'talk') return false;
    if (c['channelIds'] !== undefined && !isOptionalStringList(c['channelIds'])) return false;
    if (c['authors'] !== undefined && !isPersistedAuthors(c['authors'])) return false;
    if (c['authorDeny'] !== undefined && !isOptionalStringList(c['authorDeny'])) return false;
    return true;
}

export function areMentionWatchConditionsValid(
    conditions: unknown,
    watchChannelIds: readonly string[],
): conditions is HeartbeatMentionWatchCondition[] {
    if (!Array.isArray(conditions)) return false;
    if (conditions.length > HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS) return false;
    const allowed = new Set(watchChannelIds);
    for (const condition of conditions) {
        if (!isHeartbeatMentionWatchCondition(condition)) return false;
        const subset = condition.channelIds;
        if (subset && subset.some(id => !allowed.has(id))) return false;
    }
    return true;
}

export function areMentionWatchUserIdsValid(value: unknown): value is string[] {
    if (!Array.isArray(value)) return false;
    if (value.length > HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS) return false;
    return value.every(id => typeof id === 'string' && id.trim().length > 0);
}

function isSkipped(
    message: SlackHistoryMessage,
    selfUserId: string | null | undefined,
): boolean {
    if (!message.text) return true;
    if (selfUserId && message.user === selfUserId) return true;
    if (message.botId && !message.user) return true;
    if (message.subtype) return true;
    return false;
}

function firstMentionedSubject(text: string, subjects: readonly string[]): string | null {
    for (const id of subjects) {
        if (mentionsUser(text, id)) return id;
    }
    return null;
}

export type MentionWatchClassification = {
    match: MentionWatchMatch;
    subjectId: string;
};

function conditionMatches(
    message: SlackHistoryMessage,
    channelId: string,
    subjects: readonly string[],
    condition: HeartbeatMentionWatchCondition,
): MentionWatchClassification | null {
    if (condition.channelIds?.length && !condition.channelIds.includes(channelId)) return null;
    if (condition.authorDeny?.length) {
        if (!message.user) return null;
        if (condition.authorDeny.includes(message.user)) return null;
    }
    if (condition.authors) {
        const decision = evaluateMessagingAccess({
            actorId: message.user ?? '',
            conversationKey: channelId,
        }, condition.authors);
        if (decision !== 'allow') return null;
    }
    if (condition.match === 'mention') {
        const subjectId = firstMentionedSubject(message.text, subjects);
        return subjectId ? { match: 'mention', subjectId } : null;
    }
    if (!message.user) return null;
    const subjectId = subjects.find(id => id === message.user);
    return subjectId ? { match: 'talk', subjectId } : null;
}

export type MentionWatchClassifyInput = {
    subjects: readonly string[];
    // `| undefined` is required under exactOptionalPropertyTypes: callers
    // forward optional scan fields that may be absent.
    selfUserId?: string | null | undefined;
    channelId: string;
    conditions?: readonly HeartbeatMentionWatchCondition[] | undefined;
};

export function classifyMentionWatch(
    message: SlackHistoryMessage,
    input: MentionWatchClassifyInput,
): MentionWatchClassification | null {
    if (isSkipped(message, input.selfUserId)) return null;
    if (!input.subjects.length) return null;
    if (!input.conditions?.length) {
        const subjectId = firstMentionedSubject(message.text, input.subjects);
        return subjectId ? { match: 'mention', subjectId } : null;
    }
    for (const condition of input.conditions) {
        const hit = conditionMatches(message, input.channelId, input.subjects, condition);
        if (hit) return hit;
    }
    return null;
}

export function isMentionWatchCandidate(
    message: SlackHistoryMessage,
    input: MentionWatchClassifyInput,
): boolean {
    return classifyMentionWatch(message, input) !== null;
}
