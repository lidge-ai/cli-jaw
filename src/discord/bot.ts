// ─── Discord Bot ─────────────────────────────────────
// Discord transport implementation for cli-jaw messaging runtime.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollectData } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { saveUpload, buildMediaPromptMany } from '../agent/spawn.js';
import {
    setLastActiveTarget,
    setLatestSeenTarget,
    transportStarted,
    transportNotStarted,
    type TransportStartOutcome,
} from '../messaging/runtime.js';
import { createHash } from 'node:crypto';
import {
    admitIngress, getIngressJournal, settleIngress, type IngressAdmission,
} from '../messaging/durable-ingress.js';
import { getQueueNoticeStore } from '../messaging/queue-notice-store.js';
import { restoreQueueNotices } from '../messaging/queue-notice-restore.js';
import { currentGenerationForEnvelope } from '../messaging/ingress-generation.js';
import { discordInboundEnvelope } from '../messaging/inbound-envelope.js';
import { t, normalizeLocale } from '../core/i18n.js';
import type { RemoteTarget } from '../messaging/types.js';
import { sendChannelOutput, type ChannelSendRequest } from '../messaging/send.js';
import { handleApprovalCommand, handleApprovalCallback, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';
import { parseApprovalCallbackData } from '../messaging/approval-presentation.js';
import { handleDiscordSlashCommand, registerDiscordSlashCommands } from './commands.js';
import { createDiscordForwarder, relayDiscordImages } from './forwarder.js';
import { nextDeliverySeq, pendingDeliveryAnchor, wasSelfDelivered } from '../messaging/turn-delivery.js';
import { shouldSkipForwarding } from '../messaging/forwarder-origin.js';
import { requiresNativeBodyDelivery } from '../messaging/native-body.js';
import { createQueueNoticeRecorder } from '../messaging/queue-notice-record.js';
import { admitTargetReply } from '../messaging/target-reply-guard.js';
import { sendDiscordFile } from './discord-file.js';
import { describeDiscordSendFailure, getDiscordSendClient, sendDiscordFileRest, sendDiscordTextRest } from './send-only-client.js';
import { invalidateDiscordSendClient } from './send-only-client.js';
import { deliverySent, type TransportSendResult } from '../messaging/delivery-outcome.js';
import { OutboundSendRegistry } from '../messaging/outbound-lifecycle.js';
import type { Attachment, Interaction, Message } from 'discord.js';
import { asSendable, asThreadLike, asTypingChannel } from './channel-types.js';
import { log } from '../core/logger.js';
import {
    createAckHandle,
    resolveAckConfig,
    shouldAck,
    DISCORD_ACK_DEFAULTS,
    type AckHandle,
} from '../messaging/ack-reaction.js';
import { createQueueNotice, QueueNoticeRegistry } from '../messaging/queue-notice.js';
import {
    createDiscordAckTransport,
    createDiscordNoticeTransport,
    createDiscordNoticeTransportByIds,
    DISCORD_REACTION_TIMEOUT_MS,
} from './reactions.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';
import { createSeenSet, DELIVERY_DEDUPE_TTL_MS } from '../messaging/dedupe.js';
import {
    DiscordGatewaySupervisor,
    type DiscordGatewayClientPort,
    type DiscordGatewaySnapshot,
    type GatewayEventMap,
    type GatewayEventName,
} from './gateway-supervisor.js';

/** Redelivered message ids, so a gateway resume does not run the agent twice. */
const discordSeenMessages = createSeenSet(DELIVERY_DEDUPE_TTL_MS);

// ─── State ───────────────────────────────────────────

export let discordClient: Client | null = null;
export const discordActiveChannelIds = new Set<string>();
let forwarderHandler: BroadcastListener | null = null;
let dcInitLock = false;
let gatewaySupervisor: DiscordGatewaySupervisor | null = null;
let lastGatewayEventCode: string | null = null;
let discordApprovalIngress: DispatchApprovalTransport | null = null;
function createDiscordGatewayIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'discord' as const });
    registerProductionTransport(transport);
    return transport;
}
interface DiscordGenerationResources {
    client: Client;
    messageHandler: (msg: Message) => void;
    interactionHandler: (interaction: Interaction) => void;
    forwarder: BroadcastListener | null;
}

const generationResources = new Map<DiscordGatewayClientPort, DiscordGenerationResources>();

export class DiscordJsGatewayClientPort implements DiscordGatewayClientPort {
    constructor(readonly client: Client) {}

    login(token: string): Promise<string> { return this.client.login(token); }
    destroy(): void { this.client.destroy(); }
    shardIds(): readonly number[] { return [...this.client.ws.shards.keys()]; }

    on<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void {
        this.client.on(event, listener);
    }

    off<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void {
        this.client.off(event, listener);
    }
}

type SavedDiscordAttachment = { name: string; filePath: string };
type FailedDiscordAttachment = { name: string; reason: string };

// ─── Helpers ────────────────────────────────────────

function buildDiscordTarget(msg: Message): RemoteTarget {
    const isGroup = msg.guild !== null;
    return stripUndefined({
        channel: 'discord',
        targetKind: isGroup ? 'channel' : 'user',
        peerKind: isGroup ? 'channel' : 'direct',
        targetId: msg.channelId,
        threadId: msg.channel?.isThread?.() ? msg.channelId : undefined,
        guildId: msg.guildId ?? undefined,
        parentTargetId: msg.channel?.isThread?.() ? (asThreadLike(msg.channel)?.parentId ?? undefined) : undefined,
    });
}

function markChannelActive(channelId: string) {
    discordActiveChannelIds.delete(channelId);
    discordActiveChannelIds.add(channelId);
}

/**
 * Answer a queued turn nobody is waiting on any more.
 *
 * The ordinary queued reply rides a temporary listener armed by the request that
 * was queued (see `dcOrchestrate`). A restart destroys it — and the boot drain
 * (#407) runs exactly those messages. Without this the drain consumes the item,
 * deletes its row, and the answer goes nowhere.
 *
 * Keyed on the target the item carried through the queue, not on whoever spoke
 * most recently, and skipped when a live waiter would post the same result.
 */
const pendingQueueRequestIds = new Set<string>();
let targetReplyForwarderInstalled = false;
// Identity-local option: survives the existing router without adding an HTTP field.
const nativeBodyRequests = new WeakSet<ChannelSendRequest>();

function installDiscordTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        // Queued turns only: an ordinary reply is posted by the dispatch path
        // that is still awaiting it, and answering here too would double-post.
        // Errors included: after a restart nothing else will show them.
        const admitted = admitTargetReply(type, data, {
            channel: 'discord',
            event: 'orchestrate_done',
            accept: ['fromQueue'],
            requireText: true,
            hasPendingWaiter: requestId => pendingQueueRequestIds.has(requestId),
        });
        if (!admitted) return;
        const { target, text } = admitted;
        const request: ChannelSendRequest = { channel: 'discord', type: 'text', text, target };
        if (admitted.requireBodyDelivery) {
            if (!text.trim()) return;
            nativeBodyRequests.add(request);
        }
        void sendChannelOutput(request)
            .then(async result => {
                if (!result.ok) {
                    log.error('[discord:target-reply]', logErrorText(result.error || 'send failed'));
                    return;
                }
                // The forwarder delivered the answer, so it also keeps the
                // queue-notice promise the missing waiter could not.
                if (data["requestId"]) {
                    await closeDiscordNoticeAsAnsweredByRequestId(String(data["requestId"]));
                }
            })
            .catch((e: unknown) => log.error('[discord:target-reply]', logErrorText(e)));
    });
}

installDiscordTargetReplyForwarder();

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50 MiB

async function downloadDiscordAttachment(attachment: Attachment): Promise<{ buffer: Buffer; name: string }> {
    if (attachment.size && attachment.size > MAX_ATTACHMENT_SIZE) {
        throw new Error(`Attachment too large: ${(attachment.size / 1024 / 1024).toFixed(1)} MiB (max 50 MiB)`);
    }
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, name: attachment.name || 'attachment' };
}

async function downloadAndSaveDiscordAttachments(
    attachments: Message['attachments'],
): Promise<{ saved: SavedDiscordAttachment[]; failed: FailedDiscordAttachment[] }> {
    const attachmentList = Array.from(attachments.values());
    const results = await Promise.allSettled(
        attachmentList.map(async (attachment) => {
            const dl = await downloadDiscordAttachment(attachment);
            const filePath = saveUpload(dl.buffer, dl.name);
            return { name: dl.name, filePath };
        }),
    );

    const saved: SavedDiscordAttachment[] = [];
    const failed: FailedDiscordAttachment[] = [];

    for (const [index, result] of results.entries()) {
        const fallbackName = attachmentList[index]?.name || `attachment-${index + 1}`;
        if (result.status === 'fulfilled') {
            saved.push(result.value);
        } else {
            failed.push({
                name: fallbackName,
                reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    }

    return { saved, failed };
}

function stripBotMention(text: string, botId: string): string {
    return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

function buildAttachmentFailureWarning(failed: FailedDiscordAttachment[]): string | null {
    if (!failed.length) return null;
    return `⚠️ 제외된 첨부파일:\n${failed.map(item => `- ${item.name}: ${item.reason}`).join('\n')}`;
}

function currentLocale() {
    return normalizeLocale(settings["locale"], 'ko');
}

// ─── Discord Orchestrate (full reply path) ──────────

/**
 * Queue-notice teardowns, drained on shutdown so a turn that never answered gets
 * its notice rewritten rather than left claiming the agent is still working.
 */
const discordNoticeRegistry = new QueueNoticeRegistry();
/** In-flight ANSWER sends (#417): REST body sends carry these scopes' signals
 *  so shutdown can abort them; the notice registry above only covers cleanup. */
const discordOutboundRegistry = new OutboundSendRegistry();
/** Covers a notice edit plus a remove-then-add reaction chain. */
const DISCORD_NOTICE_DRAIN_MS = DISCORD_REACTION_TIMEOUT_MS * 2 + 3000;

// ─── Durable notice records (#418) ──────────────────
// The registry above is process-local; this wraps the store that outlives the
// process. Best-effort by contract: a durable write is a convenience for the NEXT
// boot, so letting it throw would fail the turn the user is waiting on. The
// contract is shared with the other two bots (#699).
const discordNoticeRecord = createQueueNoticeRecorder('discord', '[discord:queue-notice]');

/**
 * Close a queue notice as ANSWERED from the standing forwarder, which never
 * held the live handle. Mirrors the Slack fix: when the forwarder delivers a
 * queued answer (restart / missed waiter), the "added to queue" message must
 * still be deleted, or it sits in the channel next to the answer (#411 family).
 * Best-effort — the answer is already out.
 */
async function closeDiscordNoticeAsAnsweredByRequestId(requestId: string): Promise<void> {
    try {
        const record = getQueueNoticeStore()?.findByRequestId(requestId);
        if (!record) return;
        const client = discordClient;
        if (record.messageId && !client) {
            // The forwarder can deliver over the outbound-only REST path while
            // no gateway client exists, but this transport needs client.rest.
            // KEEP the record: dropping it here would strand the posted notice
            // forever, while a later boot's restore can still close it out.
            log.info('[discord:queue-notice] answered-close deferred (no client) — record kept for restore');
            return;
        }
        if (record.messageId && client) {
            try {
                await createDiscordNoticeTransportByIds(client, record.target.targetId, record.messageId)
                    .delete();
            } catch (e) {
                // 10008 Unknown Message: the notice is already gone, which is a
                // deletion that succeeded (same contract as Slack's
                // message_not_found). Anything else keeps the record so restore
                // can retry on the next boot.
                const code = (e as { code?: number; status?: number })?.code
                    ?? (e as { status?: number })?.status;
                if (code !== 10008 && code !== 404) throw e;
            }
        }
        discordNoticeRecord.close(requestId);
    } catch (e) {
        log.info('[discord:queue-notice] answered-close failed', logErrorText(e));
    }
}

/**
 * Rewrite notices left behind by a previous run.
 *
 * Addressed by ids rather than a fetched Message: a restart has the two ids from
 * its record, and re-fetching would turn a rewrite into a fetch that can fail on
 * its own. A record is kept when no client is connected yet — that is temporary,
 * unlike a vendor rejection (#418).
 */
export async function restoreDiscordQueueNotices(): Promise<void> {
    const store = getQueueNoticeStore();
    if (!store) return;
    const client = discordClient;
    await restoreQueueNotices({
        store,
        channel: 'discord',
        expiredText: t('tg.queueExpired', {}, currentLocale()),
        transport: (record) => (client
            ? createDiscordNoticeTransportByIds(client, record.target.targetId, record.messageId)
            : null),
        onError: (e) => log.info('[discord:queue-notice] restore failed', logErrorText(e)),
    });
}

async function dcOrchestrate(msg: Message, prompt: string, displayMsg: string) {
    const target = buildDiscordTarget(msg);
    const chatId = msg.channelId;
    const result = submitMessage(prompt, {
        origin: 'discord', displayText: displayMsg, skipOrchestrate: true, target, chatId,
    });

    // Built before the queued/started split: a queued turn is exactly the case
    // this acknowledgement exists for, so the handle cannot live inside the
    // normal-path branch.
    const ackConfig = resolveAckConfig(settings["discord"]?.ack, DISCORD_ACK_DEFAULTS);
    const selfId = msg.client.user?.id;
    const ack: AckHandle | null = shouldAck(ackConfig, {
        isDirect: !msg.guildId,
        isMention: !!selfId && msg.mentions.has(selfId),
    })
        ? createAckHandle(ackConfig, createDiscordAckTransport(msg),
            (e) => log.info('[discord:ack]', logErrorText(e)))
        : null;

    if (result.action === 'queued') {
        // Anchored when this queued run STARTS, not when it was queued: the turn
        // ahead of it is still running and can record a claim after this point,
        // which would otherwise sort as "after this turn began" and swallow the
        // queued answer. Unlatched it reads as Infinity, so nothing is
        // suppressed. A restart drops claims entirely, which keeps the orphan
        // delivery (#407) intact.
        const queuedAnchor = pendingDeliveryAnchor();
        const queuedRunStarted = (type: string, data: Record<string, any>) => {
            // Keyed on THIS request. A scope-blind "an agent started" signal can
            // fire for the turn ahead of this one, latching the anchor while that
            // turn is still running — and a claim it records afterwards would then
            // sort as newer than the anchor and swallow this answer.
            if (type === 'queued_run_started' && data['requestId'] === requestId) queuedAnchor.latch();
        };
        addBroadcastListener(queuedRunStarted);
        log.info(`[discord:queue] agent busy, queued (${result.pending} pending)`);
        const requestId = result.requestId;
        let queueTimeout: ReturnType<typeof setTimeout>;
        let disposed = false;
        const notice = createQueueNotice({
            expiredText: t('tg.queueExpired', {}, currentLocale()),
            onError: (e) => log.info('[discord:queue-notice]', logErrorText(e)),
        });
        const disposeListener = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(queueTimeout);
            removeBroadcastListener(queueHandler);
            removeBroadcastListener(queuedRunStarted);
            if (requestId) pendingQueueRequestIds.delete(requestId);
        };
        // One terminal outcome per turn, shared by whoever reaches it first.
        //
        // A boolean would pick a winner and let the loser return immediately —
        // and the loser here is the shutdown drain, which would then destroy the
        // client while the winner is still sending. The broadcast bus never
        // awaits listener promises, so nothing else would hold it.
        let terminal: Promise<void> | null = null;
        const claimTerminal = (run: () => Promise<void>): Promise<void> => {
            if (!terminal) {
                terminal = run().catch(e => log.info('[discord:queue]', logErrorText(e)));
            }
            return terminal;
        };
        // Registered before the closures that use it so the terminal winner can
        // always unregister, whichever path wins.
        let unregister = () => { };
        const finishExpired = (signal?: AbortSignal) => claimTerminal(async () => {
            disposeListener();
            try {
                // Started together, not in sequence: awaiting the notice first can
                // eat the whole drain deadline before the reaction is attempted.
                await Promise.allSettled([
                    notice.close('expired', signal),
                    ack?.settle('failure') ?? Promise.resolve(),
                ]);
                // Closed in-process, so the durable record has nothing left to
                // restore on the next boot.
                if (requestId) discordNoticeRecord.close(requestId);
            } finally {
                // Centralized here: every terminal path routes through a claim, so
                // unregistering in one place is what makes "exactly once" true.
                unregister();
            }
        });
        unregister = discordNoticeRegistry.add((signal) => finishExpired(signal));
        const queueHandler = async (type: string, data: Record<string, any>) => {
            // No !data.text gate (matches the Slack fix): an empty completion
            // must still claim the terminal, or the notice waits out the full
            // timeout before being rewritten instead of closed.
            if (type !== 'orchestrate_done' || data["origin"] !== 'discord'
                || data["requestId"] !== requestId) return;
            if (disposed) return;
            // Dispose FIRST so a duplicate broadcast cannot double-post, but the
            // notice deliberately outlives it: removing it before the answer is
            // out would leave a failed send with neither answer nor notice.
            disposeListener();
            await claimTerminal(async () => {
                try {
                    await deliverQueued(data);
                } finally {
                    unregister();
                }
            });
        };
        const deliverQueued = async (data: Record<string, any>) => {
            {
                const requireBodyDelivery = requiresNativeBodyDelivery(data);
                const rawBody = String(data["text"] ?? '');
                const body = requireBodyDelivery && !rawBody.trim() ? '' : rawBody;
                if (!body) {
                    // Empty completion: nothing to send, but the notice must not
                    // linger until the timeout rewrite.
                    await Promise.allSettled([
                        notice.close('expired'),
                        ack?.settle('failure') ?? Promise.resolve(),
                    ]);
                    if (requestId) discordNoticeRecord.close(requestId);
                    return;
                }
                const channel = asSendable(msg.channel);
                if (!channel) {
                    log.warn('[discord:queue-send] channel not sendable, dropping queued reply', { channelId: msg.channelId });
                    await Promise.allSettled([
                        notice.close('expired'),
                        ack?.settle('failure') ?? Promise.resolve(),
                    ]);
                    return;
                }
                let delivered = true;
                // Same REST migration as the normal path (#417 3/3): a queued
                // body must be cancellable at shutdown. An abort reports as a
                // failed delivery below, which closes the notice as EXPIRED —
                // never 'answered' for a send we cut short.
                {
                    const outbound = discordOutboundRegistry.start();
                    try {
                        const restToken = msg.client.token;
                        if (!restToken) throw new Error('Discord client token unavailable');
                        // Same rule as the normal dispatch: an answer the queued
                        // agent already posted itself must not be posted again.
                        const sendResult = wasSelfDelivered({ target, text: body, since: queuedAnchor.value() })
                            ? { ok: true as const, error: undefined as string | undefined }
                            : await sendDiscordTextRest(restToken, msg.channelId, body, { signal: outbound.signal,
                                ...(requireBodyDelivery ? { requireBodyDelivery: true } : {}) });
                        if (!sendResult.ok) {
                            delivered = false;
                            log.error('[discord:queue-send]', logErrorText(describeDiscordSendFailure(sendResult)));
                        }
                    } catch (e) {
                        delivered = false;
                        log.error('[discord:queue-send]', logErrorText(e));
                    } finally {
                        outbound.done();
                    }
                }
                // Settled before the relay for the same reason as the normal
                // path: an uncancellable upload must not hold the reaction.
                await Promise.allSettled([
                    notice.close(delivered ? 'answered' : 'expired'),
                    ack?.settle(delivered ? 'success' : 'failure') ?? Promise.resolve(),
                ]);
                if (requestId) discordNoticeRecord.close(requestId);
                {
                    const relayScope = discordOutboundRegistry.start();
                    await relayDiscordImages(msg.client, target, body, {
                        signal: relayScope.signal
                    })
                        .catch(e => log.error('[discord:queue-relay]', logErrorText(e)))
                        .finally(() => relayScope.done());
                }
            }
        };
        // Everything is armed SYNCHRONOUSLY, before any reaction or notice post.
        // A reaction call that takes a moment must not outlive the completion it
        // acknowledges: without the listener and the request-id claim in place, a
        // fast queued job would be missed here or answered by the fallback.
        addBroadcastListener(queueHandler);
        if (requestId) pendingQueueRequestIds.add(requestId);
        // The registry is the single shutdown path for the notice lifecycle: a
        // signal-less trigger would pin QueueNotice's first close and make the
        // drain's own cancellation unreachable.
        queueTimeout = setTimeout(() => { void finishExpired(); }, 300000);
        // Not awaited: the notice is what the user needs to see.
        void ack?.to('running', { wasQueued: true });
        // Reserved BEFORE the post: a record with no id restores to nothing, while
        // a posted message with no record is unreachable forever (#418).
        if (requestId) discordNoticeRecord.reserve(requestId, target);
        const posted = await msg.reply(
            t('tg.queued', { count: result.pending }, currentLocale()),
        ).catch((e: unknown) => {
            log.info('[discord:queue-notice] post failed', logErrorText(e));
            return undefined;
        });
        if (posted) {
            notice.bind(createDiscordNoticeTransport(posted));
            if (requestId) discordNoticeRecord.attach(requestId, posted.id);
        } else {
            // No handle will ever arrive, so a deferred close would wait for a
            // bind that cannot happen and the drain would burn its deadline.
            notice.abandon();
            // The reservation describes a message that does not exist.
            if (requestId) discordNoticeRecord.close(requestId);
            // Then close the turn out properly: abandoning the notice alone would
            // leave the listener, the request-id claim, the timer and the running
            // reaction alive until the 5-minute timeout or shutdown.
            await finishExpired();
        }
        return;
    }

    if (result.action === 'rejected') {
        await msg.reply(`❌ ${result.reason}`);
        return;
    }

    // result.action === 'started' — orchestrate and collect result
    markChannelActive(msg.channelId);

    // Typing indicator: start + periodic refresh (8s, Discord expires at 10s)
    const typingChannel = asTypingChannel(msg.channel);
    typingChannel?.sendTyping?.()
        ?.then(() => log.info('[discord:typing] ✅ sent'))
        ?.catch((e: Error) => log.info('[discord:typing] ❌', logErrorText(e)));
    const typingInterval = setInterval(() => {
        typingChannel?.sendTyping?.()
            ?.then(() => log.info('[discord:typing] ✅ refresh'))
            ?.catch((e: Error) => log.info('[discord:typing] ❌ refresh', logErrorText(e)));
    }, 8000);

    // Recorded through the body, settled once in the finally below: the image
    // relay can throw after the text is already out, and the user did get their
    // answer in that case.
    let ackOutcome: 'success' | 'failure' = 'failure';
    let ackSettled = false;
    // Anchors the delivery claim: only a send made during THIS turn can
    // suppress this turn's post. An identical answer from an earlier turn must
    // still be delivered.
    const turnStartedAt = nextDeliverySeq();
    void ack?.to('running');
    try {
        const collected = await orchestrateAndCollectData(prompt, stripUndefined({
            origin: 'discord', target, chatId, requestId: result.requestId, _skipInsert: true,
            scope: result.sessionContext?.scope,
            chatSessionId: result.sessionContext?.chatSessionId,
            remoteKey: result.sessionContext?.remoteKey,
        }));
        const text = collected.text;
        const channel = asSendable(msg.channel);
        if (!channel) throw new Error('Discord channel is not text-based');
        // The agent may already have posted this exact answer itself through
        // /api/channel/send while the turn was running. Skipping the POST is all
        // this does — the outcome stays success because the user has the answer,
        // so the ACK settles and the notice closes as before (#417/#418).
        const selfDelivered = wasSelfDelivered({ target, text, since: turnStartedAt });
        // REST scheduler, not channel.send(): discord.js's high-level send
        // accepts no AbortSignal, so a shutdown could never cancel the body
        // (#417 3/3). The scheduler owns rate-limit pacing and honours the
        // scope's signal; the gateway client still receives events as before.
        {
            const outbound = discordOutboundRegistry.start();
            try {
                const restToken = msg.client.token;
                if (!restToken) throw new Error('Discord client token unavailable');
                if (!selfDelivered) {
                    const sendResult = await sendDiscordTextRest(restToken, msg.channelId, text, { signal: outbound.signal,
                        ...(requiresNativeBodyDelivery(collected.data) ? { requireBodyDelivery: true } : {}) });
                    if (!sendResult.ok) throw new Error(describeDiscordSendFailure(sendResult));
                }
            } finally {
                outbound.done();
            }
        }
        ackOutcome = 'success';
        // Settled BEFORE the relay: image upload is uncancellable (#417), so
        // awaiting it first can strand the reaction on `running` while the
        // answer is already visible.
        await ack?.settle(ackOutcome);
        ackSettled = true;
        {
            const relayScope = discordOutboundRegistry.start();
            try {
                await relayDiscordImages(msg.client, target, text, {
                    signal: relayScope.signal
                });
            } finally {
                relayScope.done();
            }
        }
        log.info(`[discord:out${selfDelivered ? ':skipped-self-delivered' : ''}] ${msg.channelId}: ${redactOutboundText(text).slice(0, 80)}`);
    } catch (err: unknown) {
        log.error('[discord:error]', logErrorText(err));
        await msg.reply(`❌ Error: ${userErrorText(err)}`).catch(() => { });
    } finally {
        clearInterval(typingInterval);
        // Exactly one settle per turn, whichever way the body exited.
        // The happy path already settled before the image relay.
        if (!ackSettled) await ack?.settle(ackOutcome);
    }
}

// ─── Init / Shutdown ────────────────────────────────

async function handleDiscordApprovalButton(interaction: import('discord.js').ButtonInteraction): Promise<void> {
    const parsed = parseApprovalCallbackData(interaction.customId);
    if (!parsed) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
    }
    await interaction.deferUpdate();
    const result = handleApprovalCallback(
        discordApprovalIngress,
        { author: interaction.user },
        parsed.opaqueId,
        parsed.action,
        { conversationKey: interaction.user.id, sessionGeneration: 0 },
    );
    const reply = result.approved ? 'approved' : (result.reason || 'rejected');
    await interaction.editReply({ components: [] }).catch(() => undefined);
    await interaction.followUp({ content: redactOutboundText(reply), ephemeral: true }).catch(() => undefined);
}

async function installDiscordGeneration(
    port: DiscordGatewayClientPort,
    client: Client,
): Promise<void> {
    const messageHandler = (msg: Message): void => {
        void handleDiscordMessage(client, msg, discordApprovalIngress).catch((error) => {
            log.error('[discord:message]', logErrorText(error));
        });
    };
    const interactionHandler = (interaction: Interaction): void => {
        if (interaction.isButton()) {
            void handleDiscordApprovalButton(interaction).catch((error) => {
                log.error('[discord:approval]', logErrorText(error));
            });
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        void handleDiscordSlashCommand(interaction).catch((error) => {
            log.error('[discord:command]', logErrorText(error));
        });
    };

    client.on(Events.MessageCreate, messageHandler);
    client.on(Events.InteractionCreate, interactionHandler);
    const resources: DiscordGenerationResources = {
        client,
        messageHandler,
        interactionHandler,
        forwarder: null,
    };
    generationResources.set(port, resources);
    await registerDiscordSlashCommands(client);

    if (settings["discord"]?.forwardAll !== false) {
        const forwarder = createDiscordForwarder({
            client,
            shouldSkip: (data) => shouldSkipForwarding(data, 'discord'),
            log: ({ channelId, preview }) => {
                log.info(`[discord:forward] → ${channelId}: ${preview}...`);
            },
        });
        addBroadcastListener(forwarder);
        resources.forwarder = forwarder;
        forwarderHandler = forwarder;
    }

    discordClient = client;
}

async function retireDiscordGeneration(port: DiscordGatewayClientPort): Promise<void> {
    const resources = generationResources.get(port);
    generationResources.delete(port);
    if (!resources) return;

    resources.client.off(Events.MessageCreate, resources.messageHandler);
    resources.client.off(Events.InteractionCreate, resources.interactionHandler);
    if (resources.forwarder) {
        removeBroadcastListener(resources.forwarder);
        if (forwarderHandler === resources.forwarder) forwarderHandler = null;
    }
    if (discordClient === resources.client) discordClient = null;
}


/**
 * Journal the message before it is handled. Discord differs from the other two
 * channels in where the account id comes from: `client.user.id` is null before READY
 * and can change across reconnects, so it is read here at handler time rather than
 * captured at startup.
 *
 * When it cannot be resolved the message is NOT admitted. Handling it would put work
 * through a path whose durability record could not be written, and dropping it
 * silently is what this milestone exists to stop; the gateway still has it and will
 * redeliver on the next generation.
 */
function admitDiscordMessage(client: Client, msg: Message, target: RemoteTarget): IngressAdmission {
    const journal = getIngressJournal();
    if (!journal) return { admit: true, journaled: false };

    const botUserId = client.user?.id;
    if (!botUserId) {
        log.warn(redactOutboundText(`[discord:ingress] bot identity unavailable — not admitting message ${msg.id}`));
        return { admit: false, reason: 'already_handled' };
    }

    const envelope = discordInboundEnvelope({
        botUserId,
        messageId: msg.id,
        channelId: msg.channelId,
        authorId: msg.author.id,
        guildId: msg.guildId,
        isThread: msg.channel?.isThread?.() ?? false,
        parentId: asThreadLike(msg.channel)?.parentId,
        target,
    });
    const admission = admitIngress(journal, envelope, discordPayloadDigest(msg), undefined, envelope ? currentGenerationForEnvelope(envelope) : 0);
    if (!admission.admit) {
        log.info(redactOutboundText(`[discord:ingress] message ${msg.id} already handled — not re-running`));
    }
    return admission;
}

/** Identity of the message body. Never the body itself: the journal is not an archive. */
function discordPayloadDigest(msg: Message): string {
    return createHash('sha256')
        .update(JSON.stringify({ id: msg.id, content: msg.content ?? '', attachments: msg.attachments.size }))
        .digest('hex');
}

export async function handleDiscordMessage(client: Client, msg: Message, transport = discordApprovalIngress): Promise<void> {
    const approval = handleApprovalCommand(transport, {
        ...msg,
        author: msg.author,
        __jawSelf: msg.author.id === client.user?.id,
    }, msg.content || '');
    if (approval.handled) return;
    if (msg.author.id === client.user?.id) return; // never process own messages
    if (msg.author.bot && !settings["discord"].allowBots) return;
    if (settings["discord"].channelIds?.length) {
        const parentId = asThreadLike(msg.channel)?.parentId;
        if (!settings["discord"].channelIds.includes(msg.channelId)
            && !(parentId && settings["discord"].channelIds.includes(parentId))) return;
    }

    if (settings["discord"].mentionOnly && msg.guild) {
        if (!client.user || !msg.mentions.has(client.user, { ignoreRepliedUser: true })) return;
    }

    if (discordSeenMessages.seen(msg.id)) {
        log.info(`[discord:duplicate] id=${msg.id}`);
        return;
    }

    markChannelActive(msg.channelId);
    const target = buildDiscordTarget(msg);

    // Durable record of this message. The seen-set above stays as the hot in-process
    // filter; this is what survives a restart, which is the whole difference between
    // Discord and the other two channels before M3.
    const admission = admitDiscordMessage(client, msg, target);
    if (!admission.admit) return;
    const settle = (error?: unknown) => settleIngress(getIngressJournal(), admission, error);
    setLastActiveTarget('discord', target);
    setLatestSeenTarget('discord', target);

    let normalizedText = msg.content?.trim() || '';
    if (settings["discord"].mentionOnly && client.user) {
        normalizedText = stripBotMention(normalizedText, client.user.id);
    }

    if (msg.attachments.size > 0) {
        try {
            const { saved, failed } = await downloadAndSaveDiscordAttachments(msg.attachments);
            if (saved.length === 0) {
                const warning = buildAttachmentFailureWarning(failed) || '❌ No attachment could be processed';
                await msg.reply(warning).catch(() => { });
                // The user was told; there is nothing left to retry on redelivery.
                settle();
                return;
            }

            const prompt = buildMediaPromptMany(saved.map(item => item.filePath), normalizedText);
            const fileLabel = saved.length === 1
                ? `[📎 ${saved[0]!.name}] ${normalizedText}`.trim()
                : `[📎 ${saved.length} files] ${normalizedText}`.trim();
            const warning = buildAttachmentFailureWarning(failed);
            if (warning) await msg.reply(warning).catch(() => { });
            dcOrchestrate(msg, prompt, fileLabel).catch(e => log.error('[discord:orchestrate]', logErrorText(e)));
            settle();
        } catch (error) {
            log.error('[discord:attachment]', logErrorText(error));
            await msg.reply(`❌ ${userErrorText(error)}`).catch(() => { });
            settle(error);
        }
        return;
    }

    const text = normalizedText;
    if (!text) {
        settle();
        return;
    }
    log.info(`[discord:in] ${msg.channelId}: ${redactOutboundText(text).slice(0, 80)}`);

    // Reset intent: use submitMessage gateway for consistency
    if (isResetIntent(text)) {
        const result = submitMessage(text, { origin: 'discord', target });
        if (result.action === 'rejected') {
            await msg.reply(t('ws.agentBusy', {}, currentLocale()));
        } else {
            await msg.reply(t('tg.resetDone', {}, currentLocale()));
        }
        settle();
        return;
    }

    dcOrchestrate(msg, text, text).catch(e => log.error('[discord:orchestrate]', logErrorText(e)));
    settle();
}

function observeGatewaySnapshot(snapshot: DiscordGatewaySnapshot): void {
    if (snapshot.lastEventCode === lastGatewayEventCode) return;
    lastGatewayEventCode = snapshot.lastEventCode;
    if (snapshot.lastEventCode?.startsWith('client_error:')
        || snapshot.lastEventCode?.startsWith('shard_error:')) {
        log.warn(`[discord:gateway] ${snapshot.lastEventCode}`);
    } else if (snapshot.state === 'blocked') {
        log.error(logErrorText(`[discord:gateway] blocked (${snapshot.lastEventCode ?? 'unknown'})`));
    } else if (snapshot.state === 'recovering') {
        log.warn(`[discord:gateway] recovering (${snapshot.lastEventCode ?? 'unknown'})`);
    }
}

export async function initDiscord(): Promise<TransportStartOutcome> {
    if (dcInitLock) {
        log.warn('[discord] initDiscord already in progress, skipping');
        return transportNotStarted('superseded');
    }
    dcInitLock = true;
    try {
    await shutdownDiscord();
    if (!settings["discord"]?.enabled || !settings["discord"]?.token) {
        log.info('[discord] ⏭️  Discord pending (disabled or no token)');
        return transportNotStarted('not_configured');
    }

    const supervisor = new DiscordGatewaySupervisor({
        token: settings["discord"].token,
        createClient: () => new DiscordJsGatewayClientPort(new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
            partials: [Partials.Channel],
            allowedMentions: { parse: [] },
        })),
        onGenerationReady: async (port) => {
            const adapter = port as DiscordJsGatewayClientPort;
            await installDiscordGeneration(port, adapter.client);
        },
        onConnectionReady: (port) => {
            const adapter = port as DiscordJsGatewayClientPort;
            log.info(`[discord] ✅ Bot logged in as ${adapter.client.user?.tag || 'unknown'}`);
        },
        onClientRetired: retireDiscordGeneration,
        onSnapshot: observeGatewaySnapshot,
    });
    gatewaySupervisor = supervisor;
    discordApprovalIngress = createDiscordGatewayIngress();
    await supervisor.start();
    // ACCEPTED, not ready. start() resolves once replaceClient has been issued, and
    // replaceClient swallows a login failure into scheduleReplacement('login_failed')
    // instead of rethrowing; the message handler is installed later by
    // onGenerationReady. Readiness belongs to channel health — do not "fix" this
    // into a guarantee the supervisor never makes.
    return transportStarted;
    } finally { dcInitLock = false; }
}

export async function shutdownDiscord() {
    discordActiveChannelIds.clear();
    // Drop queued-result waiters immediately. Left armed, they would fire
    // against a destroyed channel for the next five minutes, and their claimed
    // request ids would keep the standing forwarder silent too.
    pendingQueueRequestIds.clear();
    // Before the client goes away: a rewrite issued after destruction has no
    // transport to travel on. Bounded, because a stuck cleanup must not hold
    // shutdown open — the drain's signal cancels whatever is still in flight.
    // Outbound abort FIRST (#417 review): the notice drain awaits a queued
    // waiter's in-flight send, so the abort must precede it or a hung vendor
    // POST eats the whole budget. Closing the cached REST scheduler aborts its
    // queue and in-flight fetches too — shutdownDiscord never called
    // invalidateDiscordSendClient before (#417).
    await discordOutboundRegistry.drain();
    invalidateDiscordSendClient();
    await discordNoticeRegistry.drain(DISCORD_NOTICE_DRAIN_MS);
    const supervisor = gatewaySupervisor;
    gatewaySupervisor = null;
    if (supervisor) {
        try {
            await supervisor.stop();
        } catch (error) {
            log.warn('[discord:stop]', logErrorText(error));
            await new Promise(r => setTimeout(r, 2000));
        }
    } else if (discordClient) {
        const old = discordClient;
        discordClient = null;
        try {
            await old.destroy();
        } catch (error) {
            log.warn('[discord:stop]', logErrorText(error));
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    forwarderHandler = null;
    log.info('[discord] stopped');
}

// ─── Send Handler ───────────────────────────────────

export async function discordSendHandler(req: ChannelSendRequest): Promise<TransportSendResult> {
    const channelId = req.chatId || req.target?.threadId || req.target?.targetId
        || (Array.from(discordActiveChannelIds).at(-1))
        || settings["discord"]?.channelIds?.[0];
    if (!channelId) {
        return { ok: false, error: 'No discord channelId available — send a message first or set channelIds', status: 400 };
    }

    if (discordClient) {
        if (req.type === 'text') {
            const text = req.text?.trim();
            if (!text) return { ok: false, error: 'text required' };
            try {
                // REST with a registry scope, same as the reply paths (#417):
                // channel.send() cannot be cancelled at shutdown.
                const restToken = discordClient.token;
                if (!restToken) return { ok: false, error: 'Discord client token unavailable' };
                const outbound = discordOutboundRegistry.start();
                let restResult;
                try {
                    restResult = await sendDiscordTextRest(restToken, String(channelId), text, { signal: outbound.signal,
                        ...(nativeBodyRequests.has(req) ? { requireBodyDelivery: true } : {}) });
                    // Failure keeps the transport's receipt — a partial send's
                    // posted prefix must survive to the caller (#785).
                    if (!restResult.ok) return restResult;
                } finally {
                    outbound.done();
                }
                return { ok: true, channel_id: channelId, type: 'text', ...deliverySent(restResult.platformMessageId) };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        }

        const filePath = req.filePath;
        if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
        const target: RemoteTarget = req.target || {
            channel: 'discord',
            targetKind: 'channel',
            peerKind: 'channel',
            targetId: String(channelId),
        };
        const fileResult = await sendDiscordFile(discordClient, target, filePath, stripUndefined({ caption: req.caption }));
        if (!fileResult.ok) return fileResult;
        return { ok: true, channel_id: channelId, type: req.type,
            ...(fileResult.confirmation ? { confirmation: fileResult.confirmation } : {}),
            ...deliverySent(fileResult.platformMessageId ?? null) };
    }

    const sendClient = getDiscordSendClient();
    if (!sendClient.token) {
        return { ok: false, error: sendClient.reason ?? 'Discord not configured', status: sendClient.status ?? 503 };
    }

    if (req.type === 'text') {
        const text = req.text?.trim();
        if (!text) return { ok: false, error: 'text required' };
        const result = await sendDiscordTextRest(sendClient.token, String(channelId), text,
            nativeBodyRequests.has(req) ? { requireBodyDelivery: true } : undefined);
        if (!result.ok) return result;
        return { ok: true, channel_id: channelId, type: 'text', ...deliverySent(result.platformMessageId) };
    }

    const filePath = req.filePath;
    if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
    const fileResult = await sendDiscordFileRest(sendClient.token, String(channelId), filePath, req.caption);
    if (!fileResult.ok) return fileResult;
    return { ok: true, channel_id: channelId, type: req.type,
        ...(fileResult.confirmation ? { confirmation: fileResult.confirmation } : {}),
        ...deliverySent(fileResult.platformMessageId) };
}

// Transport registration moved to ./register.js (lazy loader) so importing
// this module — and discord.js's ~48MB with it — happens on first use only.
