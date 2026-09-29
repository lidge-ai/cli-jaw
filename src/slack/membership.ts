import { createHash } from 'node:crypto';
import { slackApi, type SlackFetch } from './api.js';

const MEMBER_TTL_MS = 60_000;
const NON_MEMBER_TTL_MS = 30_000;
const CACHE_LIMIT = 1024;
const cache = new Map<string, { member: boolean; expiresAt: number }>();
const pending = new Map<string, Promise<boolean>>();

/** Credential identity only; never store or log the token in a cache key. */
export function slackBotTokenKey(botToken: string): string {
    return createHash('sha256').update(botToken).digest('hex').slice(0, 16);
}

/** Fail closed on API uncertainty. Only an exact channel ID and boolean membership are cacheable. */
export async function verifySlackChannelMembership(
    botToken: string,
    channelId: string,
    options: { fetchImpl?: SlackFetch; now?: () => number } = {},
): Promise<boolean> {
    if (!botToken || !/^[CG][A-Z0-9]+$/.test(channelId)) return false;
    const key = `${slackBotTokenKey(botToken)}:${channelId}`;
    const now = options.now ?? Date.now;
    const stored = cache.get(key);
    if (stored && stored.expiresAt > now()) return stored.member;
    if (stored) cache.delete(key);
    const running = pending.get(key);
    if (running) return running;

    const lookup = (async () => {
        try {
            const response = await slackApi<{ channel?: { id?: unknown; is_member?: unknown } }>(
                botToken, 'conversations.info', { channel: channelId },
                { form: true, sensitiveResponse: true, timeoutMs: 10_000,
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
            );
            if (!response.ok || response.data?.channel?.id !== channelId) return false;
            const member = response.data.channel.is_member;
            if (typeof member !== 'boolean') return false;
            cache.set(key, { member, expiresAt: now() + (member ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS) });
            if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            return member;
        } catch {
            return false;
        } finally {
            pending.delete(key);
        }
    })();
    pending.set(key, lookup);
    return lookup;
}
