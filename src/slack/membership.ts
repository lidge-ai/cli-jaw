import { createHash } from 'node:crypto';
import { slackApi, type SlackFetch } from './api.js';

const MEMBER_TTL_MS = 60_000;
const NON_MEMBER_TTL_MS = 30_000;
const CACHE_LIMIT = 1024;
const cache = new Map<string, { member: boolean; expiresAt: number }>();
const pending = new Map<string, Promise<SlackMembershipVerdict>>();

/** Credential identity only; never store or log the token in a cache key. */
export function slackBotTokenKey(botToken: string): string {
    return createHash('sha256').update(botToken).digest('hex').slice(0, 16);
}

/**
 * What the membership lookup could say. 'unknown' covers every case where
 * Slack did not give a usable boolean answer — no token, API error, timeout,
 * id mismatch, non-boolean field — and is never cached, so one transient
 * failure cannot pin a channel shut or open. Only Slack's own boolean answers
 * (including the definitive not-authorized verdict for shared channels below)
 * are cacheable.
 */
export type SlackMembershipVerdict = 'member' | 'not_member' | 'unknown';

/**
 * Fail closed on API uncertainty. A Slack Connect channel (is_ext_shared /
 * is_pending_ext_shared) is additionally NEVER authorized by membership: the
 * bot belonging there answers "do we belong", not "may we post to an external
 * conversation", so the verdict is a cached, definitive 'not_member' rather
 * than an uncertainty.
 */
export async function verifySlackChannelMembership(
    botToken: string,
    channelId: string,
    options: { fetchImpl?: SlackFetch; now?: () => number } = {},
): Promise<SlackMembershipVerdict> {
    if (!botToken || !/^[CG][A-Z0-9]+$/.test(channelId)) return 'unknown';
    const key = `${slackBotTokenKey(botToken)}:${channelId}`;
    const now = options.now ?? Date.now;
    const stored = cache.get(key);
    if (stored && stored.expiresAt > now()) return stored.member ? 'member' : 'not_member';
    if (stored) cache.delete(key);
    const running = pending.get(key);
    if (running) return running;

    const lookup = (async (): Promise<SlackMembershipVerdict> => {
        try {
            const response = await slackApi<{
                channel?: {
                    id?: unknown; is_member?: unknown;
                    is_ext_shared?: unknown; is_pending_ext_shared?: unknown;
                };
            }>(
                botToken, 'conversations.info', { channel: channelId },
                { form: true, sensitiveResponse: true, timeoutMs: 10_000,
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
            );
            if (!response.ok || response.data?.channel?.id !== channelId) return 'unknown';
            const member = response.data.channel.is_member;
            if (typeof member !== 'boolean') return 'unknown';
            if (response.data.channel.is_ext_shared === true
                || response.data.channel.is_pending_ext_shared === true) {
                cache.set(key, { member: false, expiresAt: now() + NON_MEMBER_TTL_MS });
                if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
                return 'not_member';
            }
            cache.set(key, { member, expiresAt: now() + (member ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS) });
            if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            return member ? 'member' : 'not_member';
        } catch {
            return 'unknown';
        } finally {
            pending.delete(key);
        }
    })();
    pending.set(key, lookup);
    return lookup;
}
