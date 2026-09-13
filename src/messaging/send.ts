// ─── Messaging Send ──────────────────────────────────
// Unified outbound message routing for all channels.

import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { assertSendFilePath, hostPathEnvironment } from '../security/path-guards.js';
import { isRemoteTarget, type MessengerChannel, type OutboundType, type RemoteTarget } from './types.js';
import { getLastActiveTarget, getLatestSeenTarget, clearTargetState, getHomeChannel } from './runtime.js';
import { slackTargetFromId, slackPeerKind } from './slack-target.js';
import { readSlackAllowlist, MALFORMED_SLACK_ALLOWLIST } from '../slack/events.js';
import { buildRemoteBindingKey } from './session-key.js';
import { decodeTurnConversation, turnConversationForChannel } from './turn-conversation.js';
import { getRemoteBoundSessionId } from '../core/chat-sessions.js';
import { applyOutputPolicy } from '../core/policy-hooks.js';
import { redactChannelSecrets } from './redact.js';
import { type TransportSendResult } from './delivery-outcome.js';
import { isUnconfirmedSend } from './file-receipt.js';
import { log } from '../core/logger.js';
import { recordSelfDelivery } from './turn-delivery.js';
import { normalizeSlackBlocks, type SlackBlock } from '../slack/blocks.js';

/** The one record of an outbound send attempt.
 *
 *  `channel` and `result` alone cannot answer the question this event exists to
 *  answer. Auditing 'did one turn answer twice' needs to know WHERE it went and
 *  WHAT KIND of send it was: a heartbeat report, a progress edit, and a turn's
 *  final answer are all `outbound.send` on the same channel, and counting them
 *  together makes a duplicate indistinguishable from ordinary traffic.
 *
 *  This records the sends that pass through THIS function: mention-watch
 *  answers, heartbeat reports, agent `/api/channel/send` tool calls. It is not
 *  every Slack post — the dispatch settle path, the queued reply, and the
 *  forwarders call the transport directly, and those are recorded by
 *  `slack.post` in `src/slack/send-only-client.ts`. A census needs BOTH records;
 *  neither one alone is complete, so both must be inspected.
 *
 *  The message body is deliberately absent. A duplicate audit needs the surface
 *  and destination; the body is redacted elsewhere at real cost. */
export function stampOutboundSend(
    channel: MessengerChannel,
    ok: boolean,
    detail: { targetId?: string | undefined; type?: string | undefined; viaAgent?: boolean | undefined } = {},
): void {
    log.event('outbound.send', {
        channel,
        result: ok ? 'ok' : 'error',
        ...(detail.targetId ? { target: detail.targetId } : {}),
        ...(detail.type ? { type: detail.type } : {}),
        ...(detail.viaAgent ? { via: 'agent' } : {}),
    });
}

/** How long a caption may be before the channel refuses the whole send.
 *
 *  These are rejection ceilings, not style guidance. Telegram caps a caption at
 *  1024 characters and answers 400 — which `isTransient` in
 *  `src/telegram/telegram-file.ts` correctly does NOT retry, so the upload fails
 *  outright. Discord's `content` caps at 2000 and returns
 *  `BASE_TYPE_MAX_LENGTH`; `payload_json` is only the multipart wrapper and does
 *  not lift it. Slack posts `initial_comment` as message text, where the ceiling
 *  is the 40000-character message limit and overflow truncates rather than
 *  refuses.
 *
 *  This matters because an answer promoted into a caption is arbitrarily long.
 *  Without a clamp, fixing the empty-message bug would convert a working bare
 *  attachment into a hard failure on two of three channels — a worse outcome
 *  than the defect. `src/manager/routes/telegram-hub.ts` already clamps this way. */
const CAPTION_LIMITS: Record<MessengerChannel, number> = {
    slack: 40_000,
    telegram: 1024,
    discord: 2000,
};

/** Fit a promoted answer into the caption field without losing that it was cut. */
export function clampCaptionForChannel(text: string, channel: MessengerChannel): string {
    const limit = CAPTION_LIMITS[channel];
    if (!limit || [...text].length <= limit) return text;
    // Count by code point: a Korean or emoji-heavy answer is what pushes a
    // caption over, and slicing by UTF-16 unit can split a surrogate pair.
    const ellipsis = '…';
    return [...text].slice(0, limit - ellipsis.length).join('') + ellipsis;
}

/**
 * The outbound side of the same allowlist the inbound gate reads.
 *
 * Reading the raw array here was its own disagreement: the gate refused every
 * channel on a malformed value while `validateTarget` saw `undefined.length`,
 * treated it as "nothing configured", and let an explicit target through. One
 * reader, one verdict (#406).
 */
function slackAllowlist(): { ids: string[]; malformed: boolean } {
    const ids = readSlackAllowlist(settings["slack"]?.channelIds);
    const malformed = ids.length === 1 && ids[0] === MALFORMED_SLACK_ALLOWLIST;
    return { ids, malformed };
}

// ─── Request Model ──────────────────────────────────

export type ChannelSendRequest = {
    /** Server-created resource authority; never accepted from HTTP JSON. */
    fullAccess?: boolean;
    /** Server-owned cancellation; never accepted from HTTP JSON. */
    signal?: AbortSignal;
    /** Captured server credential identity, never read from HTTP JSON. */
    slackCredentialKey?: string;
    channel?: MessengerChannel | 'active';
    type: OutboundType;
    text?: string;
    blocks?: SlackBlock[];
    filePath?: string;
    caption?: string;
    target?: RemoteTarget;
    chatId?: string | number;
    reply_markup?: unknown;
    /** Opt in to a lesser delivery when the channel cannot render the requested
     *  fidelity. Absent means the caller would rather be told it is unsupported
     *  than have the message quietly arrive as something else. */
    interactiveFallback?: 'text';
    /** Interactive senders (live operator/agent reply) leave this unset so omit-target
     *  still walks last-active / turnTarget / latest-seen (#397, #474).
     *  Scheduled senders (reminders, web-ai drain, alerts) and producer-owned
     *  senders (heartbeat job, mention-watch server post, channel forwarders) set
     *  this to false so a missing target FAILS instead of inheriting a stranger's
     *  thread (#437). Absent keeps the Interactive default. */
    allowActiveFallback?: boolean;
    /** Skip the two volatile slots and resolve straight to the configured
     *  allowlist. Scheduled callers must also set allowActiveFallback: false.
     *  The pair plus a missing allowlist/home is silence, not last-active.
     *  preferConfiguredTarget alone still last-resorts (historical #438); that
     *  leftover is closed by the callers, not by inverting this default. */
    preferConfiguredTarget?: boolean;
    /** The conversation the CALLING TURN is answering for, echoed back by the
     *  agent from its per-turn prompt. Trusted only as far as the same allowlist
     *  any explicit target faces — a better-informed default, not a bypass. */
    turnTarget?: RemoteTarget;
    /** This send arrived over the HTTP surface an AGENT uses, so the message it
     *  carries is something the user can already see by the time the turn
     *  settles. Recorded as a delivery claim so the dispatch path does not post
     *  the same answer a second time.
     *
     *  Set ONLY by the agent-facing routes. Every other caller of
     *  `sendChannelOutput` — heartbeats, reminders, alert escalation, the
     *  target-reply forwarders — leaves it absent, because recording those
     *  would let an unrelated background message suppress a real answer, and a
     *  swallowed answer is far worse than a repeated one. */
    fromAgentSurface?: boolean;
};

// ─── Transport Send Registry ────────────────────────

type TransportSendFn = (req: ChannelSendRequest) => Promise<TransportSendResult>;

const sendFns = new Map<MessengerChannel, TransportSendFn>();
const OUTBOUND_TYPES = new Set<OutboundType>(['text', 'voice', 'photo', 'document', 'keyboard']);
const CHANNELS = new Set<MessengerChannel | 'active'>(['telegram', 'discord', 'slack', 'active']);

export function registerSendTransport(channel: MessengerChannel, fn: TransportSendFn) {
    sendFns.set(channel, fn);
}

// ─── Normalize ──────────────────────────────────────

function badRequest(code: string, message = code): Error & { statusCode: number; code: string } {
    return Object.assign(new Error(message), { statusCode: 400, code });
}

function normalizeOutboundType(value: unknown): OutboundType {
    const type = value == null || value === ''
        ? 'text'
        : String(value).trim().toLowerCase();
    if (!OUTBOUND_TYPES.has(type as OutboundType)) {
        throw badRequest('invalid_outbound_type');
    }
    return type as OutboundType;
}

function normalizeInteractiveFallback(value: unknown): 'text' | undefined {
    if (value == null || value === '') return undefined;
    const fallback = String(value).trim().toLowerCase();
    // Only one lesser delivery exists today. Accepting anything else would let a
    // typo read as consent to a downgrade the caller did not ask for.
    if (fallback !== 'text') throw badRequest('invalid_interactive_fallback');
    return 'text';
}

function normalizeChannel(value: unknown): MessengerChannel | 'active' {
    const channel = value == null || value === ''
        ? 'active'
        : String(value).trim().toLowerCase();
    if (!CHANNELS.has(channel as MessengerChannel | 'active')) {
        if (/^[CDG][A-Z0-9]+$/i.test(channel)) {
            throw badRequest(
                'invalid_channel',
                'invalid_channel: channel is a transport; use channel:"slack" with chat_id or target.targetId for a Slack conversation id',
            );
        }
        throw badRequest('invalid_channel');
    }
    return channel as MessengerChannel | 'active';
}

export function normalizeChannelSendRequest(body: Record<string, any>, internal: { fullAccess?: boolean } = {}): ChannelSendRequest {
    const rawPath = body["file_path"] || body["filePath"];
    let filePath: string | undefined;
    if (rawPath) {
        filePath = assertSendFilePath(String(rawPath), settings["workingDir"] || undefined, settings["projectDirs"] || null,
            hostPathEnvironment, { fullAccess: internal.fullAccess === true });
    }
    return stripUndefined({
        ...(internal.fullAccess === true ? { fullAccess: true } : {}),
        channel: normalizeChannel(body["channel"]),
        type: normalizeOutboundType(body["type"]),
        text: body["text"],
        blocks: normalizeSlackBlocks(body['blocks']),
        filePath,
        caption: body["caption"],
        target: body["target"],
        chatId: body["chat_id"] ?? body["chatId"],
        // This normalizer is an allowlist, so an opt-in the caller sent would be
        // dropped here and every HTTP keyboard send to a channel without
        // interactive support would come back unsupported.
        interactiveFallback: normalizeInteractiveFallback(
            body["interactive_fallback"] ?? body["interactiveFallback"],
        ),
        // The agent echoes its turn's `reply_to` here. Dropping it in this
        // allowlist normalizer would leave every HTTP send back on the volatile
        // slots, which is the bug (#474).
        turnTarget: decodeTurnConversation(body["turn_conversation"] ?? body["turnConversation"]) ?? undefined,
    });
}

// ─── Resolve Target ─────────────────────────────────

function resolveChannel(req: ChannelSendRequest): MessengerChannel {
    if (req.target) {
        if (req.channel && req.channel !== 'active' && req.channel !== req.target.channel) {
            throw badRequest('channel_target_mismatch');
        }
        return req.target.channel;
    }
    if (req.channel && req.channel !== 'active') return req.channel;
    return getHomeChannel();
}

// ─── Send ───────────────────────────────────────────

/**
 * Resolve configured fallback target from settings.
 * Used when no lastActive or latestSeen target is available.
 */
function getConfiguredFallbackTarget(channel: MessengerChannel): RemoteTarget | null {
    if (channel === 'telegram') {
        const chatIds = settings["telegram"]?.allowedChatIds;
        if (chatIds?.length) {
            return {
                channel: 'telegram',
                targetKind: 'user',
                peerKind: 'direct',
                targetId: String(chatIds[0]),
            };
        }
    } else if (channel === 'discord') {
        const channelIds = settings["discord"]?.channelIds;
        if (channelIds?.length) {
            return {
                channel: 'discord',
                targetKind: 'channel',
                peerKind: 'channel',
                targetId: String(channelIds[0]),
            };
        }
    } else if (channel === 'slack') {
        // A sentinel is not a conversation. Falling back to it would address a
        // channel that does not exist; falling back to the raw first element of
        // an unreadable list would address whatever happened to be there (#406).
        const { ids, malformed } = slackAllowlist();
        if (!malformed && ids.length) {
            return slackTargetFromId(String(ids[0]));
        }
    }
    return null;
}

/**
 * Validate a target against the current channel's configured allowlist.
 * Returns true if the target is valid for the given channel.
 */
export function validateTarget(
    target: RemoteTarget,
    channel: MessengerChannel,
    options: { requireConfiguredAllowlist?: boolean; fullAccess?: boolean } = {},
): boolean {
    if (!isRemoteTarget(target)) return false;
    if (target.channel !== channel) return false;
    if (options.fullAccess === true) return true;
    if (channel === 'discord') {
        const allowed = settings["discord"]?.channelIds;
        if (allowed?.length) {
            // Allow if targetId or parentTargetId (for threads) is in channelIds
            const inAllowlist = allowed.includes(target.targetId)
                || (target.parentTargetId && allowed.includes(target.parentTargetId));
            if (!inAllowlist) return false;
        } else if (options.requireConfiguredAllowlist) {
            return false;
        }
    } else if (channel === 'telegram') {
        const allowed = settings["telegram"]?.allowedChatIds;
        if (allowed?.length && !allowed.map(String).includes(String(target.targetId))) return false;
        if (!allowed?.length && options.requireConfiguredAllowlist) return false;
    } else if (channel === 'slack') {
        // DMs are always permitted: a user messaging the bot directly is
        // self-authorizing, and D.../U... ids cannot be enumerated up front.
        //
        // The bypass is derived from the ID PREFIX, not from target.peerKind:
        // peerKind is caller-supplied metadata, so trusting it would let a
        // forged `{peerKind:'direct', targetId:'C999'}` evade the channel
        // allowlist entirely.
        if (slackPeerKind(target.targetId) === 'direct') return true;
        // Through the gate's reader, so a malformed list denies here too instead
        // of reading as "nothing configured" and admitting any target (#406).
        const { ids: allowed } = slackAllowlist();
        if (allowed.length && !allowed.includes(target.targetId)) return false;
        if (!allowed.length && options.requireConfiguredAllowlist) return false;
    }
    return true;
}

export function targetFromChatId(channel: MessengerChannel, chatId: string | number): RemoteTarget {
    const targetId = String(chatId);
    switch (channel) {
        case 'telegram':
            return { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId };
        case 'slack':
            return slackTargetFromId(targetId);
        case 'discord':
        default:
            return { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId };
    }
}

export function validateExplicitChatId(channel: MessengerChannel, chatId: string | number, options: { fullAccess?: boolean } = {}): boolean {
    return validateTarget(targetFromChatId(channel, chatId), channel, { requireConfiguredAllowlist: true, ...options });
}

function sameSlackDestination(explicit: RemoteTarget, known: RemoteTarget): boolean {
    if (!isRemoteTarget(known) || known.channel !== 'slack') return false;
    if (!validateTarget(known, 'slack')) return false;
    if (explicit.targetId !== known.targetId) return false;
    if (explicit.threadId != null && explicit.threadId !== known.threadId) return false;
    return true;
}

/**
 * Does this conversation already own a chat session?
 *
 * A binding is written when the bot is addressed in a conversation, so its presence
 * is evidence the bot belongs there — the same evidence the last-active slot carries,
 * except it does not move when a different conversation speaks.
 *
 * The lookup is read-only on purpose: authorizing a send must never CREATE the
 * binding that authorizes it.
 */
function isRemoteBoundConversation(target: RemoteTarget): boolean {
    try {
        return getRemoteBoundSessionId(buildRemoteBindingKey(target)) !== null;
    } catch {
        // No database (CLI paths, tests without a home) simply means no evidence.
        return false;
    }
}

function authorizeExplicitTarget(target: RemoteTarget, channel: MessengerChannel, fullAccess = false): RemoteTarget | null {
    if (!isRemoteTarget(target) || target.channel !== channel) return null;
    if (fullAccess) return target;
    if (validateTarget(target, channel, { requireConfiguredAllowlist: true })) return target;
    // Same reading again: an unreadable allowlist is a configured one for this
    // purpose, so the vouching path below stays closed rather than standing in
    // for a list nobody can parse (#406).
    if (channel !== 'slack' || slackAllowlist().ids.length) return null;
    for (const known of [getLastActiveTarget('slack'), getLatestSeenTarget('slack')]) {
        // Vouching decides WHETHER this send is allowed, never WHERE it goes.
        // Returning `known` here rewrote an explicitly addressed channel-root
        // send into whichever thread had spoken most recently — a caller that
        // named its destination correctly still had it moved (#745).
        if (known && sameSlackDestination(target, known)) return target;
    }
    // With no configured allowlist, the two slots above are the only conversations
    // this process can vouch for — and both hold whatever spoke MOST RECENTLY. So an
    // agent that correctly addressed the channel it was actually working in got a 403
    // as soon as another channel messaged the bot, while omitting the target
    // succeeded and delivered to that other channel. The safe answer was rejected and
    // the unsafe one accepted, which is why the prompt learned to omit it (#397).
    //
    // A conversation the bot is bound to is equally vouched for, and unlike the slots
    // it does not change when someone else talks. Binding requires the bot to have
    // been addressed there, so this widens nothing an allowlist would have closed;
    // with a configured allowlist we never reach this line at all.
    if (isRemoteBoundConversation(target)) return target;
    return null;
}

export async function sendChannelOutput(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const channel = resolveChannel(req);
    if (req.signal?.aborted) return { ok: false, error: 'send_aborted', status: 499, retryable: false };
    if (req.blocks && (channel !== 'slack' || req.type !== 'text')) {
        return { ok: false, status: 400, error: 'blocks_supported_only_for_slack_text' };
    }

    if (!OUTBOUND_TYPES.has(req.type)) {
        return { ok: false, status: 400, error: `Invalid outbound type: ${String(req.type)}` };
    }

    if (req.fullAccess === true) {
        if (req.target != null && !isRemoteTarget(req.target)) {
            return { ok: false, status: 400, error: 'invalid_outbound_target' };
        }
        if (req.chatId != null && (typeof req.chatId !== 'string' && typeof req.chatId !== 'number'
            || typeof req.chatId === 'number' && !Number.isFinite(req.chatId))) {
            return { ok: false, status: 400, error: 'invalid_chat_id' };
        }
        const echoed = turnConversationForChannel(req.turnTarget, channel);
        if (!req.target && !(req.chatId != null && String(req.chatId).trim())) {
            if (!echoed) return { ok: false, status: 400, code: 'full_access_destination_required',
                error: 'Full-local send requires an explicit target, chat_id, or turn_conversation; active-conversation defaults are not used.' };
            req = { ...req, target: echoed };
        }
        req = { ...req, allowActiveFallback: false };
    }

    if (req.chatId != null && String(req.chatId).trim()) {
        const explicitTarget = targetFromChatId(channel, req.chatId);
        if (req.target && (req.target.targetId !== explicitTarget.targetId || req.target.channel !== explicitTarget.channel)) {
            return { ok: false, status: 400, error: 'chatId and target refer to different destinations' };
        }
        const authorized = authorizeExplicitTarget(req.target || explicitTarget, channel, req.fullAccess === true);
        if (!authorized) {
            return { ok: false, status: 403, error: `Explicit ${channel} chatId is not configured or the current active conversation` };
        }
        req.target = authorized;
    }

    // Validate explicit target (shape + allowlist)
    if (req.target) {
        const authorized = authorizeExplicitTarget(req.target, channel, req.fullAccess === true);
        if (!authorized) {
            return { ok: false, status: 403, error: `Invalid or disallowed target for ${channel}: ${req.target.targetId || '(empty)'}` };
        }
        req.target = authorized;
    }

    // Resolve target: explicit > validated lastActive > validated latestSeen > configured fallback > error
    //
    // Scheduled pair (preferConfiguredTarget + allowActiveFallback:false): configured
    // dest only. That helper used to live inside the last-active gate, so opting out
    // of last-active also skipped the allowlist (SEND-RESOLVE-01).
    // Interactive omit-target still walks the chain below (#397, #474).
    if (!req.target && req.preferConfiguredTarget === true && req.allowActiveFallback === false) {
        const configured = getConfiguredFallbackTarget(channel);
        if (configured) req.target = configured;
    } else if (!req.target && req.allowActiveFallback !== false) {
        const configuredFirst = req.preferConfiguredTarget ? getConfiguredFallbackTarget(channel) : null;
        if (configuredFirst) req.target = configuredFirst;
        // The turn's OWN conversation outranks both volatile slots. Those slots
        // answer "who spoke to the bot most recently", which stops being this
        // conversation the moment anyone else writes — so a DM turn that omitted
        // the target was delivering to whichever PUBLIC channel happened to
        // interleave (#474). This answers "who am I replying to", which does not
        // move for the life of the turn.
        //
        // Still allowlist-checked: it narrows the default, it does not widen access.
        const turnTarget = req.target ? null : turnConversationForChannel(req.turnTarget, channel);
        if (turnTarget && validateTarget(turnTarget, channel)) {
            req.target = turnTarget;
        }
        const last = req.target ? null : getLastActiveTarget(channel);
        if (last && validateTarget(last, channel)) {
            req.target = last;
        } else if (!req.target) {
            if (last) clearTargetState(channel); // stale cached target — clear it
            const seen = getLatestSeenTarget(channel);
            if (seen && validateTarget(seen, channel)) {
                req.target = seen;
            } else {
                const fallback = getConfiguredFallbackTarget(channel);
                if (fallback) req.target = fallback;
            }
        }
    }

    if (!req.target && !req.chatId) {
        return { ok: false, error: `No target available for ${channel} — send a message first or configure fallback IDs` };
    }

    const sendFn = sendFns.get(channel);
    if (!sendFn) {
        return { ok: false, error: `No send transport registered for ${channel}` };
    }

    if (typeof req.text === 'string') {
        req.text = applyOutputPolicy(req.text, { scope: 'main', channel }).text;
    }
    // A file send renders exactly one piece of text: its caption. An agent that
    // wrote its answer into `text` and attached a chart had that answer dropped
    // on the floor — the transports read `caption` and nothing else, so the user
    // received a bare upload under no explanation. 33% of one bot's Slack posts
    // were empty messages with a file attached (#517).
    //
    // Promoted here rather than in a transport handler because `deliveredText`
    // below is computed from `req`: a handler-side fallback would put the caption
    // on screen while the ledger recorded `null`, and the turn's dispatch post
    // would then fire again with the same words.
    //
    // Only when `caption` is absent. An explicit caption is a deliberate choice
    // about what belongs beside the file.
    if ((req.type === 'photo' || req.type === 'document' || req.type === 'voice')
        && !req.caption?.trim()
        && typeof req.text === 'string' && req.text.trim()) {
        req.caption = clampCaptionForChannel(req.text, channel);
    }
    // Single choke point for every outbound send. A transport builds its error
    // string from a vendor SDK, and the Telegram Bot API puts the token in the
    // request URL — so the failure result is a credential sink, and it flows
    // straight into HTTP response bodies via res.json(result). Masking at each
    // call site was tried and missed several; masking here cannot be bypassed.
    const result = await sendFn(req);
    const sanitized = result.ok === false && typeof result.error === 'string'
        ? { ...result, error: redactChannelSecrets(result.error) }
        : result;
    // An unconfirmed file send is not an outbound failure and not a proven
    // success: the vendor took the bytes but would not name what it made. It is
    // counted as dispatched here, because the alternative — counting it as a
    // failed send — would report a channel as broken every time an intermediary
    // answered with an empty body.
    const unconfirmed = isUnconfirmedSend(sanitized);
    stampOutboundSend(channel, sanitized.ok !== false || unconfirmed, {
        targetId: req.target?.targetId,
        type: typeof req.type === 'string' ? req.type : undefined,
        viaAgent: req.fromAgentSurface === true,
    });
    // Only a send that actually reached the user can excuse skipping the
    // dispatch post, and only `req.target` is the resolved destination — the
    // caller's target may have been absent and filled in by the chain above.
    // `unconfirmed` is admitted here and a hard refusal is not, which is the
    // whole distinction: a 400, a 413 or an auth failure put nothing on screen,
    // so the turn's own answer still has to be posted. An unconfirmed upload may
    // already be visible, and posting the same caption again is the louder bug.
    if (req.fromAgentSurface && (sanitized.ok !== false || unconfirmed)) {
        // Only what the transport ACTUALLY put on screen may be claimed. A
        // `photo`/`document`/`voice` send carries the file and the CAPTION, and
        // reading `req.caption` here is what keeps that true: the promotion above
        // already moved `text` into it, clamped to what the channel will accept,
        // so this names the string the transport displayed. Reading `req.text`
        // directly would go wrong the moment a caller passes BOTH — the explicit
        // caption is what ships, and claiming the unshipped text would let an
        // invisible string cancel the turn's real written answer.
        const deliveredText = req.type === 'text' || req.type === 'keyboard'
            ? (typeof req.text === 'string' ? req.text : null)
            : (typeof req.caption === 'string' ? req.caption : null);
        recordSelfDelivery({
            target: req.target ?? null,
            channel,
            text: deliveredText,
        });
    }
    return sanitized;
}
