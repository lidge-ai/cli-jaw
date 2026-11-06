import { createHash } from 'node:crypto';
import { requiresNativeBodyDelivery } from '../messaging/native-body.js';
import { getSlackFailureStore } from './failure-store.js';
import { slackApi } from './api.js';
import { log } from '../core/logger.js';
import type { RemoteTarget } from '../messaging/types.js';

// Presence opts in. Invalid destinations still suppress public failure output.
export function slackFailureRoutingEnabled(): boolean {
    return process.env['JAW_SLACK_FAILURE_DM'] !== undefined;
}

export function isSlackTurnFailure(data: Record<string, unknown>): boolean {
    const native = requiresNativeBodyDelivery(data);
    return (!native && (data['error'] === true || data['executionFailed'] === true))
        || (native && data['runtimeStatus'] === 'error') || data['collectionFailure'] === 'error'
        || data['collectionFailure'] === 'timeout';
}

/** Claim before dispatch; rejected, ambiguous and successful sends are never replayed.
 * No source body/exception is forwarded, and the configured recipient must be an IM.
 */
export async function reportSlackFailure(
    token: string, target: RemoteTarget | undefined, identity: unknown, reason: 'turn' | 'destination' | 'delivery' = 'turn',
): Promise<void> {
    if (!slackFailureRoutingEnabled() || !token) return;
    const dm = process.env['JAW_SLACK_FAILURE_DM']?.trim() ?? '';
    if (!/^D[A-Z0-9]+$/.test(dm)) { log.warn('[slack:failure] invalid operator DM; notification suppressed'); return; }
    const source = JSON.stringify([target?.targetId, target?.threadId, identity]);
    const key = createHash('sha256').update(source).digest('hex');
    try {
        const store = getSlackFailureStore();
        if (!store) { log.warn('[slack:failure] durable claim store unavailable; notification suppressed'); return; }
        if (!store.claim(key)) return;
    } catch { log.warn('[slack:failure] durable claim failed; notification suppressed'); return; }
    try {
        const result = await slackApi(token, 'chat.postMessage', {
            channel: dm, text: `Jaw ${reason} failed (ref ${key.slice(0, 12)}). Check the local trace.`,
            unfurl_links: false, unfurl_media: false,
        }, { timeoutMs: 5000 });
        if (!result.ok) log.warn('[slack:failure] operator notification unconfirmed; no retry');
    } catch { log.warn('[slack:failure] operator notification unconfirmed; no retry'); }
}
