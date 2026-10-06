// ─── Heartbeat destination binding ───────────────────
// A scheduled report is written for one conversation. An operator picked it;
// nothing about the job says "wherever someone last spoke". Yet a job with no
// stored destination used to fall through to the active-channel path, and a job
// that stored only a channel was delivered to that channel's root with no way to
// tell an intentional root post from a half-filled form (#437, #745).
//
// So a destination is either complete or it is held. Complete means a thread —
// the conversation the operator pointed at — or an explicit `channel_root`
// saying the channel itself is the intended audience. A job that says neither
// has not been configured yet, and the honest response to that is silence with
// a reason in the log, not a guess that lands in someone else's thread.

import { isHeartbeatDestination, type HeartbeatDestination } from '../core/config.js';
import { targetFromChatId } from '../messaging/send.js';
import type { RemoteTarget } from '../messaging/types.js';
import { fetchSlackReplies } from '../slack/history.js';
import type { SlackFetch } from '../slack/api.js';
import type { PeriodThreadCode } from './period-thread-root.js';

export type HeartbeatHoldReason =
    | 'unbound_destination'
    | 'incomplete_destination'
    | 'malformed_destination'
    | 'thread_channel_mismatch'
    | 'stale_thread'
    | 'live_lookup_failed'
    | 'slack_grant_unavailable'
    | PeriodThreadCode;

/** Whether the bound conversation was actually PROVEN to exist this tick.
 *
 *  Three states, not a boolean, because "no check exists for this shape" and "a
 *  check failed" must not be the same word. A Discord target, a Telegram target and
 *  a Slack `channel_root` have no live check to perform — reporting them as
 *  unverified would make every healthy tick on those transports look like a failed
 *  lookup, which is a new false signal rather than an honest one. */
export type HeartbeatVerification = 'verified' | 'unverified' | 'unsupported';

export type HeartbeatBinding =
    | { state: 'bound'; target: RemoteTarget; verification: HeartbeatVerification }
    | { state: 'deferred'; kind: 'period_thread'; destination: HeartbeatDestination }
    | { state: 'held'; reason: HeartbeatHoldReason };

/** True when a stored destination names a conversation precisely enough to send.
 *
 *  Slack is the strict case because Slack is where threads exist: either a
 *  non-empty `threadId`, or `scope: 'channel_root'` written on purpose. An
 *  empty-string `threadId` is not a thread; it used to pass validation and then
 *  read as falsy at send time, quietly turning a threaded job into a root post. */
export function isCompleteHeartbeatDestination(value: unknown): value is HeartbeatDestination {
    if (!isHeartbeatDestination(value)) return false;
    const dest = value as HeartbeatDestination;
    if (dest.threadId !== undefined && !dest.threadId.trim()) return false;
    if (dest.channel !== 'slack') return true;
    return Boolean(dest.threadId?.trim()) || dest.scope === 'channel_root' || dest.scope === 'period_thread';
}

/**
 * Resolve a stored destination into the one target this job may use.
 *
 * There is deliberately no "no destination" success case. The previous contract
 * had one, and it is the reason a report reached a conversation that had never
 * asked for it.
 */
export function resolveHeartbeatBinding(destination: unknown): HeartbeatBinding {
    if (destination === undefined || destination === null) {
        return { state: 'held', reason: 'unbound_destination' };
    }
    if (!isHeartbeatDestination(destination)) {
        return { state: 'held', reason: 'malformed_destination' };
    }
    if (!isCompleteHeartbeatDestination(destination)) {
        return { state: 'held', reason: 'incomplete_destination' };
    }
    const dest = destination as HeartbeatDestination;
    if (dest.scope === 'period_thread') return { state: 'deferred', kind: 'period_thread', destination: dest };
    const base = targetFromChatId(dest.channel, dest.targetId);
    const threadId = dest.threadId?.trim();
    // A pure parse proves the destination is well formed, never that the
    // conversation still exists. Saying `unverified` here is what lets a caller
    // tell this result from one that came back through the live check.
    return { state: 'bound', target: threadId ? { ...base, threadId } : base, verification: 'unverified' };
}

/** Operator-facing explanation. Never includes tokens or report content. */
export function heartbeatHoldMessage(reason: HeartbeatHoldReason): string {
    switch (reason) {
        case 'unbound_destination':
            return 'no destination configured — set a channel and thread before enabling';
        case 'incomplete_destination':
            return 'destination names a channel but no thread — add a thread, or set scope:"channel_root" to post to the channel itself';
        case 'malformed_destination':
            return 'destination is malformed';
        case 'thread_channel_mismatch':
            return 'the configured Slack thread does not belong to the configured channel';
        case 'stale_thread':
            return 'the configured Slack thread no longer exists';
        case 'live_lookup_failed':
            return 'the configured Slack thread could not be verified for this tick';
        case 'slack_grant_unavailable':
            return 'destination-bound Slack authority could not be reserved for this tick';
        case 'root_missing': return 'the period root has not been posted';
        case 'root_multiple': return 'multiple period roots match the marker';
        case 'root_identity_mismatch': return 'the period root author differs from the configured creator';
        case 'root_marker_ambiguous': return 'another root key owns this marker for the period';
        case 'shared_state_corrupt': return 'the shared period marker is corrupt; manual review is required';
        case 'history_incomplete': return 'Slack history could not be scanned completely';
        case 'history_unavailable': return 'Slack history is unavailable';
        case 'slack_rate_limited': return 'Slack rate limited the period scan';
        case 'slack_auth_failed': return 'Slack bot identity could not be verified';
        case 'parent_invalid': return 'the period root no longer matches its verified parent';
        case 'parent_unverified': return 'the period root could not be verified';
        case 'create_uncertain': return 'root creation may have reached Slack; automatic retry is held';
        case 'create_rejected': return 'Slack rejected root creation';
        case 'create_in_progress': return 'another execution claimed root creation';
        case 'period_rolled_over': return 'the captured period ended before root creation';
        case 'slot_already_attempted': return 'this bot already claimed the period reply slot';
        case 'consumer_concurrency_full': return 'consumer concurrency limit was reached';
        case 'replies_unverified': return 'bot replies could not be scanned completely';
    }
}

export type HeartbeatThreadVerificationOptions = {
    token: string;
    fetchImpl?: SlackFetch;
    signal?: AbortSignal;
};

const STALE_THREAD_CODES = new Set(['thread_not_found', 'message_not_found']);
const MISMATCH_CODES = new Set(['channel_not_found', 'not_in_channel']);

/**
 * Prove a threaded Slack destination still names a parent in that channel.
 *
 * The check deliberately has no positive cache. A success from the previous
 * tick says nothing about a thread that was deleted or a bot removed from its
 * channel before this one. A 429 is not retried here either: the heartbeat owns
 * a future tick, so waiting and issuing a second read only spends more shared
 * Slack budget. Every uncertain result fails this tick closed.
 */
export async function verifyHeartbeatThreadBindingLive(
    destination: unknown,
    options: HeartbeatThreadVerificationOptions,
): Promise<HeartbeatBinding> {
    const binding = resolveHeartbeatBinding(destination);
    if (binding.state === 'held') return binding;
    if (binding.state === 'deferred') return binding;
    const { target } = binding;
    // No live check exists for these shapes: only Slack has threads to read, and a
    // `channel_root` job names the channel itself. `unsupported` says that, rather
    // than leaving a healthy job looking unverified forever.
    if (target.channel !== 'slack' || !target.threadId) return { ...binding, verification: 'unsupported' };
    if (!options.token.trim()) return { state: 'held', reason: 'live_lookup_failed' };

    try {
        const result = await fetchSlackReplies(options.token, target.targetId, target.threadId, {
            limit: 1,
            noRetry: true,
            noRetryOnRateLimit: true,
            sensitiveResponse: true,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!result.ok) {
            if (result.code && STALE_THREAD_CODES.has(result.code)) {
                return { state: 'held', reason: 'stale_thread' };
            }
            if (result.code && MISMATCH_CODES.has(result.code)) {
                return { state: 'held', reason: 'thread_channel_mismatch' };
            }
            return { state: 'held', reason: 'live_lookup_failed' };
        }
        return result.messages[0]?.ts === target.threadId
            ? { ...binding, verification: 'verified' }
            : { state: 'held', reason: 'thread_channel_mismatch' };
    } catch {
        return { state: 'held', reason: 'live_lookup_failed' };
    }
}
