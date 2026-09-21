import { JAW_HOME, settings } from '../core/config.js';
import { MALFORMED_SLACK_ALLOWLIST, readSlackAllowlist, shouldAttachSlack } from '../slack/events.js';
import {
    getHomeChannel,
    getLastActiveTarget,
    getRunningMessagingTransports,
    getMessagingTransportNotice,
    isMessagingTransportRunning,
} from './runtime.js';
import { inspectSlackTokenClaim } from '../slack/token-claim.js';
import { getIngressJournal, type IngressJournal } from './durable-ingress.js';
import { snapshotMetrics, type MessagingMetricsSnapshot } from './metrics.js';
import { getSlackScopeStatus, type SlackScopeStatus } from '../slack/scope-status.js';
import { slackPeerKind } from './slack-target.js';
import { isRemoteTarget } from './types.js';
import type { MessengerChannel } from './types.js';

export type TransportCapability = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type IngressHealthSnapshot = {
    received: number;
    /** Current in-flight admits. Stale processing is abandoned at journal boot. */
    processing: number;
    completed: number;
    dead_letter: number;
    /** Oldest received/processing row. Completed and dead_letter are excluded. */
    oldestOpenReceivedAt: number | null;
};

export type ChannelHealthSnapshot = {
    /** @deprecated Remove in the next major after legacy-client telemetry is zero. */
    activeInbound: MessengerChannel;
    activeInboundChannels: MessengerChannel[];
    telegram: TransportCapability;
    discord: TransportCapability;
    slack: TransportCapability;
    /**
     * Additive, Slack-only, so it stays out of the shared TransportCapability
     * shape that Telegram and Discord also use. External monitoring needs this
     * because cli-jaw's own heartbeat runs INSIDE the process whose grant is
     * wrong and therefore cannot report on it (#340).
     */
    slackScopes: SlackScopeStatus;
    /** Additive. Classic/Manager parsers ignore unknown keys. */
    ingress: IngressHealthSnapshot;
    metrics: MessagingMetricsSnapshot;
};

function telegramHasSendTarget(): boolean {
    const tg = settings["telegram"];
    if (tg?.allowedChatIds?.length) return true;
    const messaging = settings["messaging"] as Record<string, unknown> | undefined;
    const last = messaging?.['lastActive'] as Record<string, unknown> | undefined;
    const telegramLast = last?.['telegram'] as { targetId?: string } | undefined;
    return Boolean(telegramLast?.targetId);
}

function discordHasSendTarget(): boolean {
    const dc = settings["discord"];
    if (dc?.channelIds?.length) return true;
    const messaging = settings["messaging"] as Record<string, unknown> | undefined;
    const last = messaging?.['lastActive'] as Record<string, unknown> | undefined;
    const discordLast = last?.['discord'] as { targetId?: string } | undefined;
    return Boolean(discordLast?.targetId);
}

function slackHasSendTarget(): boolean {
    const sc = settings["slack"];
    // Through the gate's reader: a raw string like "C1" has a truthy .length and
    // used to read as a configured target the gate was refusing outright (#406).
    //
    // The sentinel has a truthy .length too, and it is not a conversation.
    const ids = readSlackAllowlist(sc?.channelIds);
    // The runtime slot first, the persisted one only as a fallback.
    // `setLastActiveTarget` updates the in-memory map immediately and writes
    // settings 5s later, so reading the file alone reports a conversation the
    // bot is talking in RIGHT NOW as unreachable — the same disagreement
    // between a report and the live path that #406 is about.
    const messagingBlock = settings["messaging"] as Record<string, unknown> | undefined;
    const lastActive = messagingBlock?.['lastActive'] as Record<string, unknown> | undefined;
    const lastSlack = getLastActiveTarget('slack')
        ?? (lastActive?.['slack'] as { targetId?: string } | undefined);
    if (ids.length === 1 && ids[0] === MALFORMED_SLACK_ALLOWLIST) {
        // An unreadable allowlist denies every CHANNEL target, including whatever
        // sits in the last-active slot. Falling through to that slot put health
        // back where it started: sendCapable:true while `validateTarget` refused
        // the very target it was vouching for.
        //
        // A DM is the exception on both sides — `validateTarget` lets D.../U...
        // through before it ever reads the allowlist — so reporting false for a
        // DM slot would understate a send that does work.
        //
        // The shape has to hold up too: `hydrateTargetsFromSettings` drops a slot
        // that is not a full RemoteTarget, so a bare `{targetId:"D_..."}` is a
        // target no send can actually use.
        return isRemoteTarget(lastSlack) && lastSlack.channel === 'slack'
            && slackPeerKind(lastSlack.targetId) === 'direct';
    }
    if (ids.length) return true;
    // An EMPTY allowlist is "every conversation", not "no destination". That is
    // the shipped default, and `validateTarget` implements it literally: with no
    // ids configured it admits every Slack target it is handed. Requiring a
    // last-active slot on top of that made health disagree with the send path it
    // reports on — a fresh install reported `missing_channel_id` while every
    // send would in fact have been permitted, so `jaw slack setup` and
    // `jaw doctor` called the state "all conversations allowed" while health
    // called it broken (#476).
    //
    // doctor stopped degrading on this in #406 and `slackChannelScope()` names
    // it `all_conversations`; this is health catching up to that reading.
    //
    // The malformed branch above still fails closed, and it must stay above this
    // line: that sentinel is an unmatchable id, so it denies every channel
    // target instead of widening to all of them.
    return true;
}

export function getTransportCapability(channel: MessengerChannel): TransportCapability {
    const activeInbound = isMessagingTransportRunning(channel);
    if (channel === 'telegram') {
        const tg = settings["telegram"];
        const token = typeof tg?.token === 'string' ? tg.token.trim() : '';
        const configured = Boolean(tg?.enabled && token);
        if (!configured) {
            return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
        }
        if (!telegramHasSendTarget()) {
            return { configured: true, activeInbound, sendCapable: false, reason: 'missing_chat_id' };
        }
        return { configured: true, activeInbound, sendCapable: true };
    }

    if (channel === 'slack') {
        const sc = settings["slack"];
        const botToken = typeof sc?.botToken === 'string' ? sc.botToken.trim() : '';
        const appToken = typeof sc?.appToken === 'string' ? sc.appToken.trim() : '';
        if (!sc?.enabled || !botToken) {
            return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
        }
        // Mirror the bot's own decision (slack/bot.ts runSlackInit): an EXPLICIT
        // owner that is not us refuses the socket; an unset owner gets one
        // provisional attach and elects itself, so health must not call a fresh
        // install degraded. Send capability never depended on the socket anyway.
        const attachPort = String(sc.attachPort ?? '').trim();
        if (attachPort && !shouldAttachSlack(attachPort, settings["port"])) {
            // Tokens are present but this instance must not open the socket —
            // surface WHY instead of looking broken.
            return { configured: true, activeInbound: false, sendCapable: false, reason: 'not_attach_instance' };
        }
        if (!appToken) {
            // Outbound-only: the Web API works with just the bot token, but no
            // inbound events can arrive without the app-level socket token.
            return {
                configured: true,
                activeInbound,
                sendCapable: slackHasSendTarget(),
                reason: 'missing_app_token',
            };
        }
        const ownershipNotice = getMessagingTransportNotice('slack') === 'token_shared_other_home';
        const foreignConnected = !activeInbound
            && process.env['CLI_JAW_SLACK_ALLOW_SHARED_TOKEN'] !== '1'
            && inspectSlackTokenClaim({
                appToken,
                home: JAW_HOME,
                port: String(settings['port'] ?? ''),
                connected: true,
            }).kind === 'foreign_live';
        if (ownershipNotice || foreignConnected) {
            return {
                configured: true,
                activeInbound: false,
                sendCapable: slackHasSendTarget(),
                reason: 'token_shared_other_home',
            };
        }
        if (!slackHasSendTarget()) {
            return { configured: true, activeInbound, sendCapable: false, reason: 'missing_channel_id' };
        }
        return { configured: true, activeInbound, sendCapable: true };
    }

    const dc = settings["discord"];
    const token = typeof dc?.token === 'string' ? dc.token.trim() : '';
    const guildId = typeof dc?.guildId === 'string' ? dc.guildId.trim() : '';
    const configured = Boolean(dc?.enabled && token && guildId);
    if (!configured) {
        return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
    }
    if (!discordHasSendTarget()) {
        return { configured: true, activeInbound, sendCapable: false, reason: 'missing_channel_id' };
    }
    return { configured: true, activeInbound, sendCapable: true };
}

const EMPTY_INGRESS: IngressHealthSnapshot = {
    received: 0, processing: 0, completed: 0, dead_letter: 0, oldestOpenReceivedAt: null,
};

export function buildIngressHealthSnapshot(journal: IngressJournal | null = getIngressJournal()): IngressHealthSnapshot {
    if (!journal) return { ...EMPTY_INGRESS };
    const counts = journal.counts();
    return {
        received: counts.received,
        processing: counts.processing,
        completed: counts.completed,
        dead_letter: counts.dead_letter,
        oldestOpenReceivedAt: journal.oldestOpenReceivedAt(),
    };
}

export function buildChannelHealthSnapshot(): ChannelHealthSnapshot {
    return {
        activeInbound: getHomeChannel(),
        activeInboundChannels: getRunningMessagingTransports(),
        telegram: getTransportCapability('telegram'),
        discord: getTransportCapability('discord'),
        slack: getTransportCapability('slack'),
        slackScopes: getSlackScopeStatus(),
        ingress: buildIngressHealthSnapshot(),
        metrics: snapshotMetrics(),
    };
}
