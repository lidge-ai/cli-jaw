import type { HeartbeatDestination } from '../core/config.js';
import { slackApi, type SlackFetch, type SlackApiResult } from '../slack/api.js';
import { verifiedSlackWorkspace } from '../slack/verified-workspace.js';
import type { CapturedPeriod } from './period-thread-key.js';
import { capturePeriodKey } from './period-thread-key.js';
import {
    claimPeriodThreadCreation, periodThreadRootHash, readPeriodRootInfo,
    registerPeriodThreadMarker, rejectPeriodThreadCreation, writePeriodRootInfo,
} from './period-thread-state.js';

export type PeriodThreadCode =
    | 'root_missing' | 'root_multiple' | 'root_identity_mismatch' | 'root_marker_ambiguous'
    | 'history_incomplete' | 'history_unavailable' | 'slack_rate_limited' | 'slack_auth_failed'
    | 'parent_invalid' | 'parent_unverified' | 'create_uncertain' | 'create_rejected'
    | 'create_in_progress' | 'period_rolled_over' | 'slot_already_attempted'
    | 'consumer_concurrency_full' | 'replies_unverified';
export type PeriodRootResult = { ok: true; ts: string; teamId: string; botUserId: string } | { ok: false; code: PeriodThreadCode };
export type PeriodRootDeps = {
    token: string;
    fetchImpl?: SlackFetch;
    now?: () => number;
    verifyWorkspace?: (token: string) => Promise<{ teamId: string; userId: string | null } | null>;
};
type SlackMessage = { ts?: string; thread_ts?: string; user?: string; text?: string };
type Page = { messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
const REJECTED_CODES = new Set([
    'not_in_channel', 'channel_not_found', 'is_archived', 'invalid_auth', 'not_authed',
    'account_inactive', 'token_revoked', 'missing_scope', 'restricted_action',
    'msg_too_long', 'no_text', 'invalid_blocks',
]);
const firstLine = (text: string) => text.split(/\r?\n/, 1)[0];
export function periodThreadFirstLine(destination: HeartbeatDestination, captured: CapturedPeriod): string {
    return `${destination.periodThread!.title} ${captured.label}`;
}
function call<T>(deps: PeriodRootDeps, method: string, body: Record<string, unknown>): Promise<SlackApiResult<T>> {
    return slackApi<T>(deps.token, method, body, { sensitiveResponse: true, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
}
function pageFailure(result: SlackApiResult<unknown>, fallback: PeriodThreadCode): PeriodThreadCode {
    return result.status === 429 || result.error === 'ratelimited' ? 'slack_rate_limited' : fallback;
}
function inPeriod(ts: string, captured: CapturedPeriod): boolean {
    const ms = Number(ts) * 1000;
    return Number.isFinite(ms) && ms >= captured.startMs && ms < captured.endMs;
}
export async function verifyPeriodThreadParent(
    destination: HeartbeatDestination, captured: CapturedPeriod, ts: string, expectedAuthor: string, deps: PeriodRootDeps,
): Promise<{ ok: true } | { ok: false; code: PeriodThreadCode }> {
    const result = await call<Page>(deps, 'conversations.replies', { channel: destination.targetId, ts, limit: 1 });
    if (!result.ok) return { ok: false, code: 'parent_unverified' };
    const parent = result.data?.messages?.[0];
    return parent?.ts === ts && parent.user === expectedAuthor
        && firstLine(parent.text ?? '') === periodThreadFirstLine(destination, captured)
        && (!parent.thread_ts || parent.thread_ts === ts) && inPeriod(ts, captured)
        ? { ok: true } : { ok: false, code: 'parent_invalid' };
}
export async function ensurePeriodThreadRoot(
    destination: HeartbeatDestination, captured: CapturedPeriod, deps: PeriodRootDeps,
): Promise<PeriodRootResult> {
    const p = destination.periodThread!;
    const now = deps.now ?? Date.now;
    const verified = await (deps.verifyWorkspace
        ? deps.verifyWorkspace(deps.token)
        : verifiedSlackWorkspace(deps.token, { refresh: true, sensitiveResponse: true, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }));
    if (!verified?.teamId || !verified.userId) return { ok: false, code: 'slack_auth_failed' };
    const botUserId = verified.userId;
    const expectedAuthor = p.role === 'creator' ? botUserId : p.creatorUserId!;
    if (p.role === 'creator' && p.creatorUserId && p.creatorUserId !== botUserId) return { ok: false, code: 'root_identity_mismatch' };
    if (!registerPeriodThreadMarker(destination, captured)) return { ok: false, code: 'root_marker_ambiguous' };
    const rootHash = periodThreadRootHash(verified.teamId, destination, captured);
    const record = (code: string, ts?: string) => writePeriodRootInfo(rootHash, {
        schema: 1, teamId: verified.teamId, channelId: destination.targetId,
        rootKey: p.rootKey, period: p.period, periodKey: captured.periodKey,
        ...(ts ? { ts, authorUserId: expectedAuthor } : {}), lastCode: code, updatedAt: now(),
    });
    const maxPages = p.maxPages ?? 20;
    const candidates: SlackMessage[] = [];
    const visited = new Set<string>();
    let cursor = '';
    let complete = false;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
        const result = await call<Page>(deps, 'conversations.history', {
            channel: destination.targetId, oldest: String(captured.startMs / 1000),
            latest: String(Math.min(captured.endMs, now()) / 1000), inclusive: true,
            limit: 200, ...(cursor ? { cursor } : {}),
        });
        if (!result.ok) { const code = pageFailure(result, 'history_unavailable'); record(code); return { ok: false, code }; }
        if (!Array.isArray(result.data?.messages)) { record('history_unavailable'); return { ok: false, code: 'history_unavailable' }; }
        for (const message of result.data.messages) {
            if (message.ts && firstLine(message.text ?? '') === periodThreadFirstLine(destination, captured)
                && (!message.thread_ts || message.thread_ts === message.ts) && inPeriod(message.ts, captured)) candidates.push(message);
        }
        const next = result.data.response_metadata?.next_cursor ?? '';
        if (!result.data.has_more && !next) { complete = true; break; }
        if (!next || visited.has(next)) break;
        visited.add(next);
        cursor = next;
    }
    if (!complete) { record('history_incomplete'); return { ok: false, code: 'history_incomplete' }; }
    if (candidates.length > 1) { record('root_multiple'); return { ok: false, code: 'root_multiple' }; }
    if (candidates.length === 1) {
        const candidate = candidates[0]!;
        if (candidate.user !== expectedAuthor) { record('root_identity_mismatch'); return { ok: false, code: 'root_identity_mismatch' }; }
        const checked = await verifyPeriodThreadParent(destination, captured, candidate.ts!, expectedAuthor, deps);
        if (!checked.ok) { record(checked.code); return checked; }
        record('adopted', candidate.ts);
        return { ok: true, ts: candidate.ts!, teamId: verified.teamId, botUserId };
    }
    if (p.role === 'consumer') { record('root_missing'); return { ok: false, code: 'root_missing' }; }
    if (capturePeriodKey(now(), p.period).periodKey !== captured.periodKey) {
        record('period_rolled_over'); return { ok: false, code: 'period_rolled_over' };
    }
    const previous = readPeriodRootInfo(rootHash);
    record('creating');
    const claimed = claimPeriodThreadCreation(rootHash);
    if (claimed.status !== 'claimed') {
        const code = claimed.status === 'exhausted' ? 'create_rejected'
            : claimed.status === 'in_progress' && previous?.lastCode !== 'create_uncertain' ? 'create_in_progress'
            : 'create_uncertain';
        record(code); return { ok: false, code };
    }
    const result = await slackApi<{ ts?: string }>(deps.token, 'chat.postMessage', {
        channel: destination.targetId, text: periodThreadFirstLine(destination, captured) + (p.intro ? `\n${p.intro}` : ''),
    }, { maxResponseBytes: 1024 * 1024, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    if (result.ok && typeof result.data?.ts === 'string' && result.data.ts) {
        record('created', result.data.ts);
        const checked = await verifyPeriodThreadParent(destination, captured, result.data.ts, expectedAuthor, deps);
        if (!checked.ok) { record(checked.code, result.data.ts); return checked; }
        return { ok: true, ts: result.data.ts, teamId: verified.teamId, botUserId };
    }
    const rejected = result.status === 429 || REJECTED_CODES.has(result.error ?? '');
    if (rejected) rejectPeriodThreadCreation(rootHash, claimed.attempt);
    const code = rejected ? 'create_rejected' : 'create_uncertain';
    record(code); return { ok: false, code };
}

export async function listBotRepliesSince(
    destination: HeartbeatDestination, ts: string, botUserId: string, startedAt: number, deps: PeriodRootDeps,
): Promise<{ ok: true; found: boolean } | { ok: false; code: 'replies_unverified' }> {
    const maxPages = destination.periodThread?.maxPages ?? 20;
    const seen = new Set<string>();
    let cursor = '';
    let found = false;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
        const result = await call<Page>(deps, 'conversations.replies', {
            channel: destination.targetId, ts, limit: 200, ...(cursor ? { cursor } : {}),
        });
        if (!result.ok || !Array.isArray(result.data?.messages)) return { ok: false, code: 'replies_unverified' };
        found ||= result.data.messages.some(m => m.ts !== ts && m.user === botUserId && Number(m.ts) * 1000 >= startedAt);
        const next = result.data.response_metadata?.next_cursor ?? '';
        if (!result.data.has_more && !next) return { ok: true, found };
        if (!next || seen.has(next)) return { ok: false, code: 'replies_unverified' };
        seen.add(next); cursor = next;
    }
    return { ok: false, code: 'replies_unverified' };
}
