// ─── Telegram Bot ────────────────────────────────────

import nodeFetch, { type RequestInit } from 'node-fetch';
import { Bot, type Context } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { resolveHubCallback } from './hub-callback.js';
import { requiresStreamingFetchBody } from './fetch-body.js';
import { StatusUpdateBuffer } from './status-update-buffer.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { makeCommandCtx } from '../cli/command-context.js';
import {
    saveUpload, buildMediaPrompt,
    resetFallbackState,
} from '../agent/spawn.js';
import { bumpGenerationForSessionLocalReset, bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { authorizePrivilegedRemote, isPrivilegedRemoteCommand } from '../cli/handlers/remote-session-commands.js';
import { getTelegramMenuCommands } from '../command-contract/policy.js';
import { downloadTelegramFile, TELEGRAM_DOWNLOAD_LIMITS } from '../../lib/upload.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';
import { handleVoice } from './voice.js';
import {
    registerTransport, setLastActiveTarget, setLatestSeenTarget,
    transportNotStarted, transportStarted, type TransportStartOutcome,
} from '../messaging/runtime.js';
import {
    admitIngress, getIngressJournal, settleIngress, type IngressAdmission,
} from '../messaging/durable-ingress.js';
import { getQueueNoticeStore } from '../messaging/queue-notice-store.js';
import { restoreQueueNotices } from '../messaging/queue-notice-restore.js';
import { currentGenerationForEnvelope } from '../messaging/ingress-generation.js';
import { createHash } from 'node:crypto';
import { telegramInboundEnvelope } from '../messaging/inbound-envelope.js';
import type { InboundEnvelope } from '../messaging/types.js';
import { registerSendTransport, sendChannelOutput } from '../messaging/send.js';
import { nextDeliverySeq, pendingDeliveryAnchor, wasSelfDelivered } from '../messaging/turn-delivery.js';
import { shouldSkipForwarding } from '../messaging/forwarder-origin.js';
import { requiresNativeBodyDelivery } from '../messaging/native-body.js';
import { createQueueNoticeRecorder } from '../messaging/queue-notice-record.js';
import { admitTargetReply } from '../messaging/target-reply-guard.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ChannelSendRequest } from '../messaging/send.js';
import {
    escapeHtmlTg,
    createForwarderLifecycle,
    createTelegramForwarder,
    relayTelegramImages,
} from './forwarder.js';
import { sendTelegramMarkdown, type RichSendOpts } from './rich-message.js';
import { db } from '../core/db.js';
import { TelegramDurablePoller, TelegramUpdateOffsetStore } from './update-offset.js';

export {
    escapeHtmlTg,
    markdownToTelegramHtml,
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
} from './forwarder.js';

// Re-exported from collect.ts (extracted in Phase B)
import { orchestrateAndCollect, orchestrateAndCollectData } from '../orchestrator/collect.js';
import { log } from '../core/logger.js';
import { createIpv4Fetch } from './ipv4-fetch.js';
import {
    createAckHandle,
    resolveAckConfig,
    shouldAck,
    TELEGRAM_ACK_DEFAULTS,
    type AckHandle,
} from '../messaging/ack-reaction.js';
import { createQueueNotice, QueueNoticeRegistry } from '../messaging/queue-notice.js';
import { OutboundSendRegistry } from '../messaging/outbound-lifecycle.js';
import {
    createTelegramAckTransport,
    createTelegramNoticeTransport,
    TELEGRAM_REACTION_TIMEOUT_MS,
} from './reactions.js';
export { orchestrateAndCollect };
import {
    startPendingElicitation,
    handleElicitationCallback,
    discardPendingElicitation,
} from './elicitation-buttons.js';
import { redactOutboundPayload, redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';
import { sendWithRetryPolicy } from '../messaging/retry.js';
import { deliveryFailed, deliverySent, type TransportSendResult } from '../messaging/delivery-outcome.js';
import { handleApprovalCommand, handleApprovalCallback, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';
import { parseApprovalCallbackData } from '../messaging/approval-presentation.js';
import { answerCallbackQueryBestEffort } from './callback-query.js';

// ─── State ───────────────────────────────────────────

export let telegramBot: Bot | null = null;
export const telegramActiveChatIds = new Set<number>();
let tgRetryTimer: ReturnType<typeof setTimeout> | null = null;
let tgInitLock = false;
let tg409RetryCount = 0;
const TG_MAX_RETRIES = 3;
let botUsername: string | null = null;
let telegramPoller: TelegramDurablePoller | null = null;
const telegramFinalDeliveryFailures = new Set<number>();
/**
 * The bot's own user id, learned from getMe at startup.
 *
 * Needed for the self-echo guard. Until it is known the guard falls back to
 * the is_bot flag, which is why those are two separate checks.
 */
let botUserId: number | null = null;
export function setTelegramBotUserIdForTest(value: number | null): void { botUserId = value; }
let telegramApprovalIngress: DispatchApprovalTransport | null = null;
function createTelegramPollingIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'telegram' as const });
    registerProductionTransport(transport);
    return transport;
}
export function handleTelegramUpdate(update: Record<string, unknown>, transport = telegramApprovalIngress): boolean {
    const message = update['message'] as { text?: unknown; from?: { id?: unknown; is_bot?: boolean } } | undefined;
    const text = typeof message?.text === 'string' ? message.text : '';
    const fromIdRaw = message?.from?.id;
    const fromId = typeof fromIdRaw === 'number' ? fromIdRaw : undefined;
    const approval = handleApprovalCommand(transport, {
        ...update,
        __jawSelf: isSelfEcho({ fromId, isBot: message?.from?.is_bot, botUserId, allowBots: settings["telegram"]?.allowBots }),
    }, text);
    return approval.handled;
}

/**
 * Whether an update should be dropped as our own output or another bot's.
 *
 * Extracted from the middleware so it can be exercised directly: the guard is
 * two checks, and the reason for two is the window before getMe returns, which
 * is exactly the case a test needs to reach.
 */
export function isSelfEcho(input: {
    fromId?: number | undefined;
    isBot?: boolean | undefined;
    botUserId: number | null;
    allowBots?: boolean | undefined;
}): boolean {
    // Our own id, once we know it.
    if (input.fromId !== undefined && input.botUserId !== null && input.fromId === input.botUserId) return true;
    // Until then — and for every other bot — fall back on the is_bot flag.
    if (input.isBot && !input.allowBots) return true;
    return false;
}
const telegramUpdateOffsets = new TelegramUpdateOffsetStore(db);
let targetReplyForwarderInstalled = false;
const telegramForwarderLifecycle = createForwarderLifecycle({
    addListener: addBroadcastListener,
    removeListener: removeBroadcastListener,
    buildForwarder: ({ bot }: Record<string, unknown>) => createTelegramForwarder({
        bot: bot as Bot,
        // Own origin: handled by tgOrchestrate already. Producer-owned origins
        // (heartbeat) deliver to their own destination — see forwarder-origin.ts.
        shouldSkip: (data: Record<string, unknown>) => shouldSkipForwarding(data, 'telegram'),
        log: ({ chatId, preview }: { chatId: string | number; preview: string }) => {
            log.info(`[tg:forward] → chat ${chatId}: ${String(preview).slice(0, 60)}...`);
        },
    }),
});


function currentLocale() {
    return normalizeLocale(settings["locale"], 'ko');
}

function markChatActive(chatId: number, ctx?: Context) {
    // Refresh insertion order so Array.from(set).at(-1) points to latest active chat.
    telegramActiveChatIds.delete(chatId);
    telegramActiveChatIds.add(chatId);
    // Auto-persist to settings.json so forwarding survives server restart
    const allowed = settings["telegram"]?.allowedChatIds || [];
    if (!allowed.includes(chatId)) {
        settings["telegram"].allowedChatIds = [...allowed, chatId];
        import('../core/config.js').then(m => m.saveSettings(settings)).catch(() => { });
    }
    // Update messaging runtime targets
    if (ctx) {
        const target = buildTelegramTarget(ctx);
        setLastActiveTarget('telegram', target);
        setLatestSeenTarget('telegram', target);
    }
}

function detachTelegramForwarder() {
    telegramForwarderLifecycle.detach();
}

function attachTelegramForwarder(bot: Bot) {
    telegramForwarderLifecycle.attach({ bot });
}

// Private request identity, never accepted from a send payload or saved settings.
const nativeBodyRequests = new WeakSet<ChannelSendRequest>();

function installTelegramTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        // Telegram admits ONLY hub-forwarded replies: its own queued and direct
        // turns are answered by the dispatch path that is still awaiting them.
        const admitted = admitTargetReply(type, data, {
            channel: 'telegram',
            event: 'orchestrate_done',
            accept: ['replyViaTarget'],
            requireText: true,
        });
        if (!admitted) return;
        const { target } = admitted;
        const request: ChannelSendRequest = {
            channel: 'telegram',
            type: 'text',
            text: admitted.text,
            target,
        };
        if (admitted.requireBodyDelivery) {
            if (!request.text?.trim()) return;
            nativeBodyRequests.add(request);
        }
        void sendChannelOutput(request).then((result) => {
            if (!result.ok) log.error('[tg:target-reply]', logErrorText(result.error || 'send failed'));
            // Forward elicitation keyboards through hub if present.
            const specs = data["elicitationSpecs"];
            const raw = Array.isArray(specs) ? specs[0] : undefined;
            if (typeof raw === 'string' && raw) {
                const keyboards = startPendingElicitation(String(target.targetId || ''), raw);
                for (const kb of keyboards ?? []) {
                    void sendChannelOutput({
                        channel: 'telegram', type: 'keyboard',
                        text: kb.text, reply_markup: kb.reply_markup, target,
                    }).catch(() => {});
                }
            }
        }).catch((err: unknown) => {
            log.error('[tg:target-reply]', logErrorText(err));
        });
    });
}

/**
 * Queue-notice teardowns. Module scope because tgOrchestrate is a closure inside
 * _initTelegramInner, and both shutdown and re-init have to reach these.
 */
const telegramNoticeRegistry = new QueueNoticeRegistry();
/** In-flight ANSWER sends (#417): body sends + retry sleeps. grammY's default
 *  API timeout is 500s, so an un-signalled send can outlive shutdown by
 *  minutes; the ipv4 fetch adapter destroys the request on abort. */
const telegramOutboundRegistry = new OutboundSendRegistry();
/** Covers the worst honest chain: a notice edit plus a replace-mode reaction. */
const TELEGRAM_NOTICE_DRAIN_MS = TELEGRAM_REACTION_TIMEOUT_MS * 2 + 3000;

/**
 * Stop polling and close out queued notices, in the one order that is safe.
 *
 * stop() aborts synchronously and only THEN awaits its running loop, so starting
 * it without awaiting closes the admission window before the drain snapshots the
 * registry. Draining first would let a newly-received update register after that
 * snapshot, and the awaited stop would block on its undrained delivery.
 *
 * The catch is attached at construction, not after the drain: stop() can reject
 * through its loop, and the drain in between is a window where nothing would be
 * listening.
 */
async function disposeTelegramRuntime(poller: { stop(): Promise<void> } | null): Promise<void> {
    const stopping = poller?.stop().catch((e: unknown) => {
        log.warn('[telegram:poller-stop]', logErrorText(e));
    });
    // Outbound abort FIRST (#417 review): the notice drain awaits the queued
    // waiter's in-flight send; aborting it up front frees that budget for the
    // actual cleanup instead of a hung vendor POST.
    await telegramOutboundRegistry.drain();
    await telegramNoticeRegistry.drain(TELEGRAM_NOTICE_DRAIN_MS);
    await stopping;
}

// ─── Durable notice records (#418) ──────────────────
// The registry above is process-local; this wraps the store that outlives the
// process. Best-effort by contract: a durable write is a convenience for the NEXT
// boot, so letting it throw would fail the turn the user is waiting on. The
// contract is shared with the other two bots (#699).
const telegramNoticeRecord = createQueueNoticeRecorder('telegram', '[tg:queue-notice]');

/**
 * Rewrite notices left behind by a previous run.
 *
 * A record whose bot cannot be resolved yet is kept rather than closed: that is a
 * temporary condition, unlike a vendor rejection (#418).
 */
export async function restoreTelegramQueueNotices(): Promise<void> {
    const store = getQueueNoticeStore();
    if (!store) return;
    const bot = resolveTelegramSendBot();
    await restoreQueueNotices({
        store,
        channel: 'telegram',
        expiredText: t('tg.queueExpired', {}, currentLocale()),
        transport: (record) => {
            if (!bot) return null;
            const messageId = Number(record.messageId);
            // A message id that did not survive as a number cannot address
            // anything; closing the record is the only way out of that loop.
            if (!Number.isFinite(messageId)) return null;
            return createTelegramNoticeTransport(bot.api, record.target.targetId, messageId);
        },
        onError: (e) => log.info('[tg:queue-notice] restore failed', logErrorText(e)),
    });
}

// ─── Transport Contract Exports ─────────────────────

export async function shutdownTelegram() {
    if (tgRetryTimer) { clearTimeout(tgRetryTimer); tgRetryTimer = null; }
    detachTelegramForwarder();
    const oldPoller = telegramPoller;
    telegramPoller = null;
    await disposeTelegramRuntime(oldPoller);
    if (!telegramBot) return;
    const old = telegramBot;
    telegramBot = null;
    try { await old.stop(); } catch (e: unknown) {
        log.warn('[telegram:stop]', logErrorText(e));
    }
}

export function getLatestTelegramChatId(): string | number | null {
    return Array.from(telegramActiveChatIds).at(-1) as string | number | null ?? null;
}

export function getTelegramTargetIds(): Array<string | number> {
    return settings["telegram"].allowedChatIds?.length
        ? [...settings["telegram"].allowedChatIds]
        : ([...telegramActiveChatIds] as Array<string | number>);
}

export async function sendTelegramText(
    chatId: string,
    text: string,
    extra?: { reply_markup?: import('@grammyjs/types').InlineKeyboardMarkup },
) {
    const bot = resolveTelegramSendBot();
    if (!bot) throw new Error('Telegram not configured');
    const markup = extra?.reply_markup;
    return bot.api.sendMessage(
        chatId,
        redactOutboundText(text),
        markup ? { reply_markup: redactOutboundPayload(markup) } : undefined,
    );
}

export type TelegramSendClientResult =
    | { client: Bot; reason?: never; status?: never }
    | { client: null; reason: string; status: 400 | 503 };

let telegramSendOnlyBot: Bot | null = null;
let telegramSendOnlyToken: string | null = null;

export function invalidateTelegramSendClient(): void {
    telegramSendOnlyBot = null;
    telegramSendOnlyToken = null;
}

export function getTelegramSendClient(): TelegramSendClientResult {
    const tg = settings["telegram"];
    if (!tg?.enabled) {
        return { client: null, reason: 'telegram_disabled', status: 503 };
    }
    const token = typeof tg.token === 'string' ? tg.token.trim() : '';
    if (!token) {
        return { client: null, reason: 'telegram_token_missing', status: 503 };
    }
    if (telegramSendOnlyBot && telegramSendOnlyToken === token) {
        return { client: telegramSendOnlyBot };
    }
    telegramSendOnlyBot = new Bot(token);
    telegramSendOnlyToken = token;
    return { client: telegramSendOnlyBot };
}

function resolveTelegramSendBot(): Bot | null {
    if (telegramBot) return telegramBot;
    return getTelegramSendClient().client;
}

function buildTelegramTarget(ctx: Context): RemoteTarget {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const messageThreadId = ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined;
    return stripUndefined({
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: isGroup ? 'group' : 'direct',
        targetId: String(ctx.chat?.id ?? ''),
        threadId: messageThreadId !== undefined && messageThreadId > 1
            ? String(messageThreadId)
            : undefined,
    });
}

/**
 * Pull the routing fields out of a raw update. The poller sees `Update`, not the
 * grammY `Context` that `buildTelegramTarget` consumes, and only some update kinds
 * carry a chat at all — a poll answer has no conversation to journal against.
 * Returns null for those rather than inventing an identity for them.
 */
function telegramUpdateEnvelope(update: Record<string, unknown>): InboundEnvelope | null {
    if (botUserId === null) return null;
    const message = (update['message'] ?? update['edited_message'] ?? update['channel_post']
        ?? update['edited_channel_post']) as Record<string, unknown> | undefined;
    const callback = update['callback_query'] as Record<string, unknown> | undefined;
    const carrier = message ?? (callback?.['message'] as Record<string, unknown> | undefined);
    const chat = carrier?.['chat'] as Record<string, unknown> | undefined;
    const from = (message?.['from'] ?? callback?.['from']) as Record<string, unknown> | undefined;
    if (!chat || from?.['id'] === undefined) return null;

    const chatType = chat['type'];
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isTopicMessage = carrier?.['is_topic_message'] === true;
    const threadId = isTopicMessage ? Number(carrier?.['message_thread_id']) : NaN;
    const target: RemoteTarget = stripUndefined({
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: isGroup ? 'group' : 'direct',
        targetId: String(chat['id']),
        threadId: Number.isFinite(threadId) && threadId > 1 ? String(threadId) : undefined,
    }) as RemoteTarget;

    return telegramInboundEnvelope({
        botUserId,
        updateId: update['update_id'] as number,
        chatId: chat['id'] as number,
        fromId: from['id'] as number,
        isTopicMessage,
        messageThreadId: carrier?.['message_thread_id'] as number | undefined,
        target,
    });
}

/**
 * Append the update before it is handled. The shared protocol in durable-ingress owns
 * the ordering; this only supplies the Telegram-shaped envelope and digest.
 */
function admitTelegramUpdate(update: Record<string, unknown>): IngressAdmission {
    const journal = getIngressJournal();
    const envelope = journal ? telegramUpdateEnvelope(update) : null;
    const admission = admitIngress(journal, envelope, telegramPayloadDigest(update), undefined, envelope ? currentGenerationForEnvelope(envelope) : 0);
    if (!admission.admit) {
        log.info(`[tg:ingress] update ${String(update['update_id'])} already handled — not re-running`);
    }
    return admission;
}

/** Identity of the update body, for detecting an edit that reuses an id. Never the
 *  body itself: the journal is not a message archive. */
function telegramPayloadDigest(update: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(update)).digest('hex');
}

async function telegramSendHandler(req: ChannelSendRequest): Promise<TransportSendResult> {
    // P2b: hub-member mode — this instance's own bot is disabled; relay outbound through the
    // dashboard hub (it owns the single forum-group bot token). hubCallbackUrl is SSRF-guarded.
    const hub = settings["telegramHub"];
    if (hub?.mode === 'hub-member' && req.target?.channel === 'telegram' && req.target?.targetId) {
        const base = resolveHubCallback(hub.hubCallbackUrl);
        try {
            const r = await fetch(`${base}/api/dashboard/telegram-hub/outbound`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(stripUndefined({
                    chatId: req.target.targetId, threadId: req.target.threadId,
                    type: req.type, text: req.text, filePath: req.filePath, caption: req.caption, reply_markup: req.reply_markup,
                })),
                signal: AbortSignal.timeout(15_000),
            });
            const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
            if (nativeBodyRequests.has(req) && (j['ok'] !== true || j['bodyDelivered'] !== true)) {
                // Older hubs cannot confirm delivery. Never replay an ambiguous send.
                return { ok: false, error: j['ok'] === false ? String(j['error'] || 'hub outbound failed')
                    : 'telegram_hub_body_delivery_unconfirmed', status: 502 };
            }
            // The hub reports an unconfirmed file upload the same way a local
            // send does. Forwarding that word is what lets sendChannelOutput
            // still claim the caption, instead of the dispatch path posting it a
            // second time next to a file that probably did arrive.
            const hubConfirmation = j['confirmation'] === 'unconfirmed' || j['confirmation'] === 'confirmed'
                ? { confirmation: j['confirmation'] } : {};
            return j['ok'] ? { ok: true, via: 'hub', type: req.type, ...hubConfirmation }
                : { ok: false, error: String(j['error'] || 'hub outbound failed'), status: 502, ...hubConfirmation };
        } catch (e) {
            return { ok: false, error: (e as Error).message, status: 502 };
        }
    }

    const bot = resolveTelegramSendBot();
    if (!bot) {
        const send = getTelegramSendClient();
        return { ok: false, error: send.reason ?? 'Telegram not configured', status: send.status ?? 503 };
    }

    const chatId = req.chatId || req.target?.targetId || getLatestTelegramChatId();
    if (!chatId) return { ok: false, error: 'No telegram chatId available', status: 400 };

    // P0: thread-aware send. Programmatic sends must carry message_thread_id so
    // replies/files land in the originating forum topic (ctx.reply already auto-threads).
    // stripUndefined drops the key for non-forum chats → identical wire payload.
    const { threadIdNumber } = await import('../messaging/thread-target.js');
    const messageThreadId = threadIdNumber(req.target);

    if (req.type === 'text') {
        const text = req.text?.trim();
        if (!text) return { ok: false, error: 'text required' };
        // Rich-first default (Bot API 10.1): raw markdown via sendRichMessage, with the
        // legacy HTML→plaintext chain as per-chunk fallback inside the helper.
        // Scoped for shutdown cancellation (#417).
        const outbound = telegramOutboundRegistry.start();
        let sendResult;
        // The markdown helper's return shape is pinned by an existing suite, so
        // the id travels out through the body observer instead (#687).
        let platformMessageId: string | null = null;
        try {
            sendResult = await sendTelegramMarkdown(bot.api, chatId, text, stripUndefined({
                ...(nativeBodyRequests.has(req) ? { requireBodyDelivery: true } : {}),
                message_thread_id: messageThreadId,
                signal: outbound.signal,
                onBodyDelivered: (id?: string) => {
                    if (id && platformMessageId === null) platformMessageId = id;
                },
            }));
        } finally {
            outbound.done();
        }
        // Previously the abort threw past this return, so the handler answered
        // 500 with a raw message. A cancelled send is a 499, and it is not ok.
        if (!sendResult.ok) {
            return { ok: false, error: 'telegram_send_aborted', status: 499, chat_id: chatId, type: 'text',
                ...deliveryFailed(platformMessageId) };
        }
        return { ok: true, chat_id: chatId, type: 'text', ...deliverySent(platformMessageId) };
    }

    if (req.type === 'keyboard') {
        const text = req.text?.trim();
        if (!text || !req.reply_markup) return { ok: false, error: 'text and reply_markup required for keyboard type' };
        // sendWithRetryPolicy discards the vendor return and is shared with other
        // callers, so capture the id inside the thunk rather than change it.
        let platformMessageId: string | null = null;
        const sent = await sendWithRetryPolicy(
            async () => {
                const sentMessage = await bot.api.sendMessage(chatId, redactOutboundText(text), stripUndefined({
                    message_thread_id: messageThreadId,
                    reply_markup: redactOutboundPayload(req.reply_markup) as import("@grammyjs/types").InlineKeyboardMarkup,
                }));
                const id = (sentMessage as { message_id?: unknown } | undefined)?.message_id;
                if (typeof id === 'number' || typeof id === 'string') platformMessageId = String(id);
            },
            (err) => log.warn('[tg:keyboard] send failed:', logErrorText(err)),
        );
        if (!sent) return { ok: false, error: 'keyboard send failed', ...deliveryFailed(null) };
        return { ok: true, chat_id: chatId, type: 'keyboard', ...deliverySent(platformMessageId) };
    }

    // File types
    const filePath = req.filePath;
    if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
    const { validateFileSize, sendTelegramFile } = await import('./telegram-file.js');
    validateFileSize(filePath, req.type);
    const result = await sendTelegramFile(bot, chatId, filePath, req.type, stripUndefined({ caption: req.caption, threadId: messageThreadId }));
    return result;
}

// Register transport at module load time
registerTransport('telegram', {
    init: () => initTelegram(),
    shutdown: shutdownTelegram,
});
registerSendTransport('telegram', telegramSendHandler);
installTelegramTargetReplyForwarder();

function toTelegramCommandDescription(desc: string) {
    const text = String(desc || '').trim();
    return text.length >= 3 ? text.slice(0, 256) : 'Run command';
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function syncTelegramCommands(bot: Bot) {
    const locale = currentLocale();
    const cmds = getTelegramMenuCommands()
        .map((c: { name: string; desc?: string; descKey?: string; tgDescKey?: string }) => ({
            command: c.name,
            description: toTelegramCommandDescription(
                (c.tgDescKey ? t(c.tgDescKey, {}, locale) : (c.descKey ? t(c.descKey, {}, locale) : c.desc)) ?? ''
            ),
        }));
    // Set commands with language_code per Telegram Bot API
    // Also set default (no language_code) for users without language preference
    return Promise.all([
        bot.api.setMyCommands(cmds),
        bot.api.setMyCommands(cmds, { language_code: locale as 'en' | 'ko' }),
    ]);
}

function makeTelegramCommandCtx() {
    return makeCommandCtx('telegram', currentLocale(), {
        applySettings: async (patch) => {
            bumpSessionOwnershipGeneration();
            return applyRuntimeSettingsPatch(patch, {
                resetFallbackState: () => resetFallbackState(null),
            });
        },
        clearSession: () => {
            bumpGenerationForSessionLocalReset();
            clearMainSessionState();
        },
        resetSession: () => {
            bumpGenerationForSessionLocalReset();
            resetSessionPreservingHistory();
        },
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
        resetEmployeeSessions: () => resetEmployeeSessions(),
    });
}

// ─── Init ────────────────────────────────────────────

export async function initTelegram(): Promise<TransportStartOutcome> {
    if (tgInitLock) {
        log.warn('[tg] initTelegram already in progress, skipping');
        return transportNotStarted('superseded');
    }
    tgInitLock = true;
    try { return await _initTelegramInner(); } finally { tgInitLock = false; }
}

async function _initTelegramInner(): Promise<TransportStartOutcome> {
    // Dedupe retry timer — cancel pending retry if initTelegram called again
    if (tgRetryTimer) { clearTimeout(tgRetryTimer); tgRetryTimer = null; }

    detachTelegramForwarder();
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try {
            await old.stop();
        } catch (e: unknown) {
            log.warn('[telegram:stop]', logErrorText(e));
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    const reinitPoller = telegramPoller;
    telegramPoller = null;
    // Same helper as shutdown: a re-init that skipped the drain would strand
    // every queued notice from the previous run.
    await disposeTelegramRuntime(reinitPoller);
    const envToken = process.env["TELEGRAM_TOKEN"];
    if (envToken) settings["telegram"].token = envToken;

    const envChatIds = process.env["TELEGRAM_ALLOWED_CHAT_IDS"];
    if (envChatIds) {
        settings["telegram"].allowedChatIds = envChatIds
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id));
    }

    if (!settings["telegram"]?.enabled || !settings["telegram"]?.token) {
        log.info('[tg] ⏭️  Telegram pending (disabled or no token)');
        return transportNotStarted('not_configured');
    }

    // Pre-seed telegramActiveChatIds from persisted allowedChatIds
    if (settings["telegram"].allowedChatIds?.length) {
        for (const id of settings["telegram"].allowedChatIds) telegramActiveChatIds.add(id);
        log.info(`[tg] Pre-seeded ${settings["telegram"].allowedChatIds.length} chat(s) from allowedChatIds`);
    }

    // The factory, not an inline closure: production and the cancellation test
    // must drive the same implementation, or the test proves only itself.
    const ipv4Fetch = createIpv4Fetch({
        streamingFetch: (url, init) => nodeFetch(url, init as RequestInit) as Promise<unknown>,
        isStreamingBody: requiresStreamingFetchBody,
    });

    const bot = new Bot(settings["telegram"].token, {
        client: { fetch: ipv4Fetch as never },
    });
    bot.catch((err) => log.error('[tg:error]', logErrorText(err)));
    bot.use(sequentialize((ctx) => `tg:${ctx.chat?.id || 'unknown'}`));

    // Never process our own output, and skip other bots unless allowed.
    //
    // Discord has had this since inception (see Events.MessageCreate below);
    // Telegram did not, so a bridge that re-injects bot output — or simply
    // another bot in the same group — could drive a loop. It sits ahead of the
    // logging middleware so an echo does not pollute the log either.
    //
    // Two checks rather than one: botUserId is only known once getMe returns,
    // and is_bot still covers the window before that.
    bot.use(async (ctx, next) => {
        const from = ctx.from;
        if (isSelfEcho({ fromId: from?.id, isBot: from?.is_bot, botUserId, allowBots: settings["telegram"]?.allowBots })) return;
        await next();
    });

    bot.use(async (ctx, next) => {
        // Inbound text is logged too, and a user can paste a token into chat.
        log.info(`[tg:update] chat=${ctx.chat?.id} text=${redactOutboundText(ctx.message?.text || '').slice(0, 40)}`);
        await next();
    });

    bot.use(async (ctx, next) => {
        const allowed = settings["telegram"].allowedChatIds;
        if (allowed?.length > 0 && !allowed.includes(ctx.chat?.id)) {
            log.info(`[tg:blocked] chatId=${ctx.chat?.id}`);
            return;
        }
        await next();
    });

    // Group chat @mention gating (configurable)
    bot.use(async (ctx, next) => {
        if (settings["telegram"].mentionOnly === false) {
            await next();
            return;
        }
        const chatType = ctx.chat?.type;
        if (chatType === 'group' || chatType === 'supergroup') {
            const text = ctx.message?.text || ctx.message?.caption || '';
            if (!botUsername || !text.includes(`@${botUsername}`)) {
                return;
            }
        }
        await next();
    });

    bot.command('start', (ctx) => ctx.reply(t('tg.connected', {}, currentLocale())));
    bot.command('id', (ctx) => ctx.reply(`Chat ID: <code>${ctx.chat?.id ?? ''}</code>`, { parse_mode: 'HTML' }));

    // Inline-keyboard elicitation answers (single_select fences → buttons).
    bot.callbackQuery(/^(appr|aprd):/, async (ctx) => {
        await answerCallbackQueryBestEffort(() => ctx.answerCallbackQuery());
        const data = ctx.callbackQuery.data ?? '';
        const parsed = parseApprovalCallbackData(data);
        const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : '';
        if (!parsed || !chatId) return;
        const result = handleApprovalCallback(
            telegramApprovalIngress,
            { message: { from: ctx.from } },
            parsed.opaqueId,
            parsed.action,
            { conversationKey: chatId, sessionGeneration: 0 },
        );
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
        const reply = result.approved ? 'approved' : (result.reason || 'rejected');
        await ctx.reply(redactOutboundText(reply)).catch(() => { });
    });

    bot.callbackQuery(/^elic:/, async (ctx) => {
        const cbChatId = ctx.chat?.id;
        if (!cbChatId) {
            await answerCallbackQueryBestEffort(() => ctx.answerCallbackQuery());
            return;
        }
        const result = handleElicitationCallback(String(cbChatId), ctx.callbackQuery.data ?? '');
        if (result.kind === 'stale') {
            await answerCallbackQueryBestEffort(() => ctx.answerCallbackQuery({ text: t('tg.elicitationExpired', {}, currentLocale()) }));
            return;
        }
        await answerCallbackQueryBestEffort(() => ctx.answerCallbackQuery({ text: redactOutboundText(result.ack) }));
        // Best-effort: freeze the tapped question's keyboard so the choice reads as taken.
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
        if (result.kind === 'complete') {
            await tgOrchestrate(ctx, result.combinedAnswer, result.combinedAnswer);
        }
    });

    async function tgOrchestrate(
        ctx: Context,
        prompt: string,
        displayMsg: string,
        ackInput: { anchorId?: number; isMention?: boolean } = {},
        steerContext?: string,
    ) {
        const chatId = ctx.chat?.id;
        if (!ctx.chat) return;
        const chat = ctx.chat;
        const responseTarget = buildTelegramTarget(ctx);
        const result = submitMessage(prompt, stripUndefined({ origin: 'telegram' as const, displayText: displayMsg, skipOrchestrate: true, target: responseTarget, chatId }));
        // Narrowed once so the closures below capture a definite number.
        const anchorId = ackInput.anchorId;
        const ackConfig = resolveAckConfig(settings["telegram"]?.ack, TELEGRAM_ACK_DEFAULTS);
        const ackHandle: AckHandle | null = anchorId !== undefined && shouldAck(ackConfig, {
            isDirect: chat.type === 'private',
            isMention: ackInput.isMention ?? false,
        })
            ? createAckHandle(
                ackConfig,
                createTelegramAckTransport(ctx.api, chat.id, anchorId),
                (e) => log.info('[tg:ack]', logErrorText(e)),
            )
            : null;
        // Reproduce grammy ctx.reply's auto-injected routing (context.js: thread/business/DM-topic)
        // so the rich-first send helper lands replies exactly where ctx.reply would.
        const replyOptsOf = (c: Context): RichSendOpts => stripUndefined({
            business_connection_id: c.businessConnectionId,
            message_thread_id: c.msg?.is_topic_message ? c.msg.message_thread_id : undefined,
            direct_messages_topic_id: c.msg?.direct_messages_topic?.topic_id,
        });
        // Single_select elicitation fences arrive as raw specs on orchestrate_done;
        // render the first one as inline-keyboard messages after the text body.
        const sendElicitationKeyboards = async (targetChatId: number | string, specs: unknown) => {
            const raw = Array.isArray(specs) ? specs[0] : undefined;
            if (typeof raw !== 'string' || !raw) return;
            const keyboards = startPendingElicitation(String(targetChatId), raw);
            for (const kb of keyboards ?? []) {
                await ctx.api.sendMessage(targetChatId, redactOutboundText(kb.text), { ...replyOptsOf(ctx), reply_markup: redactOutboundPayload(kb.reply_markup) })
                    .catch(() => { });
            }
        };

        if (result.action === 'queued') {
            log.info(`[tg:queue] agent busy, queued (${result.pending} pending)`);
            // 큐 처리 후 응답을 이 채팅으로 전달 — requestId로 request-level 격리
            const requestId = result.requestId;
            // Anchored when this queued run STARTS, not when it was queued: the
            // turn ahead of it is still running and can record a claim after this
            // point, which would otherwise sort as "after this turn began" and
            // swallow the queued answer. Unlatched it reads as Infinity, so
            // nothing is suppressed. A restart drops claims entirely, which keeps
            // the orphan delivery (#407) intact.
            const queuedAnchor = pendingDeliveryAnchor();
            const queuedRunStarted = (type: string, data: Record<string, unknown>) => {
                // Keyed on THIS request. A scope-blind "an agent started" signal
                // can fire for the turn ahead of this one, latching the anchor
                // while that turn is still running — and a claim it records
                // afterwards would then sort as newer and swallow this answer.
                if (type === 'queued_run_started' && data['requestId'] === requestId) queuedAnchor.latch();
            };
            addBroadcastListener(queuedRunStarted);
            const notice = createQueueNotice({
                expiredText: t('tg.queueExpired', {}, currentLocale()),
                onError: (e) => log.info('[tg:queue-notice]', logErrorText(e)),
            });
            // One terminal outcome per turn, shared by whoever reaches it first.
            //
            // A boolean would pick a winner and let the loser return immediately —
            // and the loser here is the shutdown drain, which would then stop the
            // poller while the winner is still delivering. Handing back the
            // winner's promise makes every path converge on one completion.
            let terminal: Promise<void> | null = null;
            const claimTerminal = (run: () => Promise<void>): Promise<void> => {
                if (!terminal) {
                    terminal = run().catch(e => log.info('[tg:queue]', logErrorText(e)));
                }
                return terminal;
            };
            const finalDeliveryControl: { cancel?: (reason: unknown) => void } = {};
            let unregister = () => { };
            const finalDelivery = new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout>;
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    removeBroadcastListener(queueHandler);
                    removeBroadcastListener(queuedRunStarted);
                };
                // Timeout, shutdown and an explicit cancel all land here.
                const expire = (reason: unknown, signal?: AbortSignal) => claimTerminal(async () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    // Started together rather than in sequence: awaiting the notice
                    // first can eat the whole drain deadline before the reaction is
                    // even attempted.
                    await Promise.allSettled([
                        notice.close('expired', signal),
                        ackHandle?.settle('failure') ?? Promise.resolve(),
                    ]);
                    // Closed in-process, so the durable record has nothing left to
                    // restore on the next boot.
                    if (requestId) telegramNoticeRecord.close(requestId);
                    unregister();
                    reject(reason);
                });
                finalDeliveryControl.cancel = (reason) => { void expire(reason); };
                const queueHandler = (type: string, data: Record<string, unknown>) => {
                    // No !data.text gate (matches Slack/Discord): an empty
                    // completion claims the terminal and expires the notice now
                    // instead of letting the timeout rewrite it later.
                    if (type !== 'orchestrate_done' || data["origin"] !== 'telegram' || data["requestId"] !== requestId) return;
                    if (settled) return;
                    settled = true;
                    cleanup();
                    void claimTerminal(async () => {
                        const requireBodyDelivery = requiresNativeBodyDelivery(data);
                        const rawBody = String(data["text"] ?? '');
                        const body = requireBodyDelivery && !rawBody.trim() ? '' : rawBody;
                        if (!body) {
                            await Promise.allSettled([
                                notice.close('expired'),
                                ackHandle?.settle('failure') ?? Promise.resolve(),
                            ]);
                            if (requestId) telegramNoticeRecord.close(requestId);
                            unregister();
                            resolve();
                            return;
                        }
                        try {
                            // Scoped for shutdown cancellation (#417). An abort
                            // lands in the catch below, which closes the notice
                            // as EXPIRED — a cancelled send is never 'answered'.
                            const outbound = telegramOutboundRegistry.start();
                            let sendResult;
                            try {
                                // Same rule as the normal dispatch: an answer the
                                // queued agent already posted itself must not be
                                // posted again. The notice still closes as
                                // answered, because the user has the answer.
                                sendResult = wasSelfDelivered({ target: responseTarget, text: body, since: queuedAnchor.value() })
                                    ? { ok: true as const }
                                    : await sendTelegramMarkdown(ctx.api, chat.id, body,
                                        { ...replyOptsOf(ctx), signal: outbound.signal,
                                            ...(requireBodyDelivery ? { requireBodyDelivery: true } : {}) });
                            } finally {
                                outbound.done();
                            }
                            // A cancelled send delivered nothing, so it takes the
                            // same path a vendor failure does: the notice stays as
                            // the only trace of the turn. Reported rather than
                            // thrown now, so it needs an explicit branch.
                            if (!sendResult.ok) {
                                await Promise.allSettled([
                                    notice.close('expired'),
                                    ackHandle?.settle('failure') ?? Promise.resolve(),
                                ]);
                                if (requestId) telegramNoticeRecord.close(requestId);
                                unregister();
                                reject(new Error('telegram_send_aborted'));
                                return;
                            }
                        } catch (error) {
                            // The answer never landed, so the notice is not stale —
                            // it is the only trace this turn happened.
                            await Promise.allSettled([
                                notice.close('expired'),
                                ackHandle?.settle('failure') ?? Promise.resolve(),
                            ]);
                            if (requestId) telegramNoticeRecord.close(requestId);
                            unregister();
                            reject(error);
                            return;
                        }
                        // Only now is the notice redundant.
                        await Promise.allSettled([
                            notice.close('answered'),
                            ackHandle?.settle('success') ?? Promise.resolve(),
                        ]);
                        if (requestId) telegramNoticeRecord.close(requestId);
                        unregister();
                        resolve();
                        {
                            const relayScope = telegramOutboundRegistry.start();
                            void relayTelegramImages(bot, chat.id, body, responseTarget, {
                                signal: relayScope.signal
                            })
                                .catch(() => { }).finally(() => relayScope.done());
                        }
                        void sendElicitationKeyboards(chat.id, data["elicitationSpecs"]).catch(() => { });
                    });
                };
                // Armed synchronously, before any reaction call: a delayed
                // setMessageReaction must not be able to outlive the completion it
                // is acknowledging, or the result arrives with no listener here.
                timer = setTimeout(() => {
                    void expire(new Error('telegram_queue_delivery_timeout'));
                }, 300000);
                addBroadcastListener(queueHandler);
                unregister = telegramNoticeRegistry.add((signal) =>
                    expire(new Error('telegram_queue_shutdown'), signal));
            });
            void finalDelivery.catch(() => { });
            // Not awaited: the notice below is what the user needs to see, and the
            // reaction is decoration on top of it.
            void ackHandle?.to('running', { wasQueued: true });
            try {
                // Reserved BEFORE the post: a record with no id restores to
                // nothing, while a posted message with no record is unreachable
                // forever (#418).
                if (requestId) telegramNoticeRecord.reserve(requestId, responseTarget);
                const posted = await ctx.reply(t('tg.queued', { count: result.pending }, currentLocale()));
                // The exported factory, not an inline object: tests drive the same
                // binding production uses.
                notice.bind(createTelegramNoticeTransport(ctx.api, chat.id, posted.message_id));
                if (requestId) telegramNoticeRecord.attach(requestId, String(posted.message_id));
                await finalDelivery;
            } catch (error) {
                // A failed notice post means no handle will ever arrive; without
                // this a deferred close waits for a bind that cannot happen and the
                // drain burns its whole deadline.
                notice.abandon();
                // The reservation describes a message that was never posted, or a
                // turn that just ended; either way the next boot must not hunt it.
                if (requestId) telegramNoticeRecord.close(requestId);
                finalDeliveryControl.cancel?.(error);
                await finalDelivery.catch(() => { });
                telegramFinalDeliveryFailures.add(ctx.update.update_id);
                throw error;
            }
            return;
        }

        if (result.action === 'rejected') {
            await ctx.reply(`❌ ${result.reason}`);
            return;
        }

        // result.action === 'started' — TG 출력 로직 진입
        const submitRequestId = result.requestId;
        markChatActive(chat.id, ctx);

        await ctx.replyWithChatAction('typing')
            .then(() => log.info('[tg:typing] ✅ sent'))
            .catch((e: unknown) => log.info('[tg:typing] ❌', logErrorText(e)));
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing')
                .then(() => log.info('[tg:typing] ✅ refresh'))
                .catch((e: unknown) => log.info('[tg:typing] ❌ refresh', logErrorText(e)));
        }, 4000);

        const showTools = settings["telegram"]?.showToolUse !== false;
        let statusMsgId: number | null = null;
        let statusMsgCreatePromise: Promise<number | null> | null = null;
        let statusUpdateTimer: ReturnType<typeof setTimeout> | null = null;
        let statusUpdateRunning = false;
        const statusUpdateBuffer = new StatusUpdateBuffer();
        let toolLines: string[] = [];

        const flushStatusUpdate = async () => {
            const display = statusUpdateBuffer.take();
            if (!display) return;

            if (!statusMsgId) {
                if (!statusMsgCreatePromise) {
                    statusMsgCreatePromise = ctx.reply(`🔄 ${redactOutboundText(display)}`)
                        .then((m: { message_id: number }) => {
                            statusMsgId = m.message_id;
                            return statusMsgId;
                        })
                        .catch(() => null)
                        .finally(() => {
                            statusMsgCreatePromise = null;
                        });
                }
                await statusMsgCreatePromise;
                return;
            }

            await ctx.api.editMessageText(chat.id, statusMsgId, `🔄 ${redactOutboundText(display)}`)
                .catch(() => { });
        };

        const scheduleStatusUpdate = () => {
            if (statusUpdateTimer) return;
            statusUpdateTimer = setTimeout(async () => {
                statusUpdateTimer = null;
                if (statusUpdateRunning) return;
                statusUpdateRunning = true;
                try {
                    await flushStatusUpdate();
                } finally {
                    statusUpdateRunning = false;
                    // If pending text changed while updating, flush once more.
                    if (statusUpdateBuffer.hasPending() && !statusUpdateTimer) scheduleStatusUpdate();
                }
            }, 180);
        };

        const pushToolLine = (line: string) => {
            if (!line) return;
            if (toolLines[toolLines.length - 1] === line) return;
            toolLines.push(line);
            if (toolLines.length > 24) toolLines = toolLines.slice(-24);
            statusUpdateBuffer.set(toolLines.slice(-5).join('\n'));
            scheduleStatusUpdate();
        };

        const toolHandler = showTools ? (type: string, data: Record<string, any>) => {
            if (type === 'agent_retry') {
                const retryReason = escapeHtmlTg(data["reason"] || '429');
                const retryDelay = data["delay"] > 0 ? ` — ${data["delay"]}s 후 재시도` : ' — 재시도';
                pushToolLine(`⏳ ${escapeHtmlTg(data["cli"])} ${retryReason}${retryDelay}`);
            } else if (type === 'agent_fallback') {
                pushToolLine(`⚡ ${data["from"]} → ${data["to"]}`);
            } else if (type === 'agent_smoke') {
                log.info(`[tg:smoke] ${data["cli"]} smoke detected — auto-continuing`);
            } else if (type === 'agent_tool' && data["icon"] && data["label"]) {
                // Copilot ACP emits many thought chunks; hide them on Telegram to avoid message storms.
                // 💬 (assistant-message narration badge) and thinking-type entries
                // are live-UI-only for the same reason (Slack drops them too).
                if (data["icon"] === '💭' || data["icon"] === '💬' || data["toolType"] === 'thinking') return;
                pushToolLine(`${data["icon"]} ${data["label"]}`);
            } else {
                return;
            }
        } : null;

        if (toolHandler) addBroadcastListener(toolHandler);

        let finalDeliveryStarted = false;
        // Set when the agent already delivered this answer itself, so the log
        // line below can say so instead of implying we posted it.
        let selfDelivered = false;
        // Anchors the delivery claim: only a send made during THIS turn can
        // suppress this turn's post. An identical answer from an earlier turn
        // must still be delivered.
        const turnStartedAt = nextDeliverySeq();
        // The started path is the COMMON one — the agent is idle — and it never
        // touched the handle, so an ACK-enabled command got no reaction at all
        // unless it happened to be queued.
        let ackOutcome: 'success' | 'failure' = 'failure';
        void ackHandle?.to('running');
        try {
            const { text: collectedText, data: doneData } = await orchestrateAndCollectData(prompt, stripUndefined({
                origin: 'telegram', chatId: chat.id, requestId: submitRequestId, _skipInsert: true,
                target: responseTarget,
                scope: result.sessionContext?.scope,
                chatSessionId: result.sessionContext?.chatSessionId,
                remoteKey: result.sessionContext?.remoteKey,
                _steerContext: steerContext,
            }));
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(chat.id, statusMsgId).catch(() => { });
            }
            finalDeliveryStarted = true;
            {
                // Scoped for shutdown cancellation (#417).
                const outbound = telegramOutboundRegistry.start();
                let finalResult;
                try {
                    // The agent may already have posted this exact answer itself
                    // through /api/channel/send while the turn was running.
                    // Skipping the POST is all this does — the outcome stays
                    // success, because the user has the answer, so the ACK and
                    // the notice lifecycle behave as if we had sent it (#417/#418).
                    selfDelivered = wasSelfDelivered({
                        target: responseTarget, text: collectedText, since: turnStartedAt,
                    });
                    finalResult = selfDelivered
                        ? { ok: true as const }
                        : await sendTelegramMarkdown(ctx.api, chat.id, collectedText,
                            { ...replyOptsOf(ctx), signal: outbound.signal,
                                ...(requiresNativeBodyDelivery(doneData) ? { requireBodyDelivery: true } : {}) });
                } finally {
                    outbound.done();
                }
                // Nothing reached the user, so this turn must not be recorded as
                // a success or relay images for an answer that was never sent.
                if (!finalResult.ok) {
                    ackOutcome = 'failure';
                    return;
                }
            }
            // The text is what the user was waiting for. Image relay is
            // fire-and-forget below, so it cannot hold the outcome open.
            ackOutcome = 'success';
            log.info(`[tg:out${selfDelivered ? ':skipped-self-delivered' : ''}] ${chat.id}: ${redactOutboundText(collectedText).slice(0, 80)}`);
            {
                const relayScope = telegramOutboundRegistry.start();
                void relayTelegramImages(bot, chat.id, collectedText, responseTarget, {
                    signal: relayScope.signal
                })
                    .catch(() => { }).finally(() => relayScope.done());
            }
            void sendElicitationKeyboards(chat.id, doneData["elicitationSpecs"]).catch(() => { });
        } catch (err: unknown) {
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(chat.id, statusMsgId).catch(() => { });
            }
            log.error('[tg:error]', logErrorText(err));
            await ctx.reply(`❌ Error: ${userErrorText(err)}`);
            if (finalDeliveryStarted) telegramFinalDeliveryFailures.add(ctx.update.update_id);
        } finally {
            // Exactly one settle per turn, whichever way the body exited.
            await ackHandle?.settle(ackOutcome);
        }
    }

    bot.on('message:text', async (ctx) => {
        if (!ctx.chat) return;
        markChatActive(ctx.chat.id, ctx);
        let text = ctx.message.text;
        // Captured BEFORE the mention is stripped below — afterwards there is
        // nothing left to detect, and the ACK scope gate needs to know.
        const isMention = !!botUsername && text.includes(`@${botUsername}`);
        if (botUsername) {
            text = text.replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'g'), '').trim();
        }
        if (text.startsWith('/')) {
            const parsed = parseCommand(text);
            if (!parsed) return;
            const cmdName = parsed.type === 'known' ? (parsed.cmd?.name ?? parsed.name) : parsed.name;
            if (isPrivilegedRemoteCommand(cmdName)) {
                const fromId = ctx.from?.id;
                const auth = authorizePrivilegedRemote(cmdName, {
                    channel: 'telegram',
                    ...(fromId !== undefined ? { actorId: String(fromId) } : {}),
                    conversationKey: String(ctx.chat.id),
                    chatSessionId: getActiveChatSession(),
                });
                if (!auth.ok) {
                    await ctx.reply(redactOutboundText(auth.text));
                    return;
                }
            }
            const result = await executeCommand(parsed, makeTelegramCommandCtx());

            // ── /steer special path: kill + re-orchestrate with full TG UX ──
            // steerHandler already killed the agent and waited for exit.
            // Just start tgOrchestrate for typing indicator + result delivery.
            if (result?.steerPrompt) {
                const steerPrompt = result.steerPrompt;
                await ctx.reply(redactOutboundText(result.text || '🔄'));
                try {
                    await tgOrchestrate(ctx, steerPrompt, steerPrompt, {}, result.steerContext as string | undefined);
                } catch (err: unknown) {
                    log.error('[tg:steer]', logErrorText(err));
                    await ctx.reply(`❌ Steer failed: ${userErrorText(err)}`.slice(0, 500)).catch(() => {});
                }
                return;
            }

            if (result?.text) {
                const out = redactOutboundText(String(result.text));
                try {
                    await ctx.reply(out);
                } catch {
                    await ctx.reply(out.slice(0, 4000));
                }
            }
            return;
        }
        log.info(`[tg:in] ${ctx.chat?.id}: ${redactOutboundText(text).slice(0, 80)}`);

        // Typed reply supersedes any pending elicitation buttons (placed after the
        // /command branch so slash commands do not discard the pending session).
        discardPendingElicitation(String(ctx.chat.id));

        // Reset intent: use submitMessage gateway for consistency
        if (isResetIntent(text)) {
            const target = buildTelegramTarget(ctx);
            const result = submitMessage(text, { origin: 'telegram', target, chatId: ctx.chat?.id });
            if (result.action === 'rejected') {
                await ctx.reply(t('ws.agentBusy', {}, currentLocale()));
            } else {
                await ctx.reply(t('tg.resetDone', {}, currentLocale()));
            }
            return;
        }
        await tgOrchestrate(ctx, text, text, { anchorId: ctx.message.message_id, isMention });
    });

    bot.on('message:photo', async (ctx) => {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!;
        const caption = ctx.message.caption || '';
        log.info(`[tg:photo] ${ctx.chat?.id}: fileId=${largest.file_id.slice(0, 20)}... caption=${redactOutboundText(caption).slice(0, 40)}`);
        try {
            const dlResult = await downloadTelegramFile(largest.file_id, settings["telegram"].token, stripUndefined({
                kind: 'photo',
                maxBytes: TELEGRAM_DOWNLOAD_LIMITS.photo,
                fileSize: largest.file_size,
            })) as Record<string, unknown>;
            const filePath = saveUpload(dlResult["buffer"] as Buffer, `photo${dlResult["ext"]}`);
            const prompt = buildMediaPrompt(filePath, caption);
            await tgOrchestrate(ctx, prompt, `${t('tg.imageCaption', { caption }, currentLocale())}`, { anchorId: ctx.message.message_id });
        } catch (err: unknown) {
            log.error('[tg:photo:error]', logErrorText(err));
            await ctx.reply(t('tg.imageFail', { msg: userErrorText(err) }, currentLocale()));
        }
    });

    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        log.info(`[tg:doc] ${ctx.chat?.id}: ${doc.file_name} (${doc.file_size} bytes)`);
        try {
            const dlResult = await downloadTelegramFile(doc.file_id, settings["telegram"].token, stripUndefined({
                kind: 'document',
                maxBytes: TELEGRAM_DOWNLOAD_LIMITS.document,
                fileSize: doc.file_size,
            })) as Record<string, any>;
            const filePath = saveUpload(dlResult["buffer"], doc.file_name || 'document');
            const prompt = buildMediaPrompt(filePath, caption);
            await tgOrchestrate(ctx, prompt, `[📎 ${doc.file_name || 'file'}] ${caption}`, { anchorId: ctx.message.message_id });
        } catch (err: unknown) {
            log.error('[tg:doc:error]', logErrorText(err));
            await ctx.reply(t('tg.fileFail', { msg: userErrorText(err) }, currentLocale()));
        }
    });

    bot.on('message:voice', async (ctx) => {
        // handleVoice's callback contract is three parameters, so the anchor is
        // injected here rather than widening that module's signature.
        await handleVoice(ctx, currentLocale, (c, prompt, display) =>
            tgOrchestrate(c, prompt, display, { anchorId: ctx.message?.message_id }));
    });

    // Identity first: the self-echo guard needs it, and the refusal below has
    // to happen BEFORE anything is attached. Returning after attaching left the
    // forwarder wired to a bot that never starts, still trying to send.
    //
    // Reset before asking, so a restart cannot inherit the previous bot's
    // identity and check incoming messages against the wrong id.
    botUsername = null;
    botUserId = null;
    try {
        const me = await bot.api.getMe();
        bot.botInfo = me;
        botUsername = me.username || null;
        botUserId = me.id ?? null;
    } catch (err: unknown) {
        log.warn('[tg] getMe failed; bot identity unknown', logErrorText(err));
    }

    // The durable offset is scoped by bot identity, so polling must not start
    // when getMe cannot provide that identity.
    if (botUserId === null) {
        log.error(logErrorText('[tg] refusing to start durable polling: bot identity could not be read'));
        return transportNotStarted('failed', 'get_me_identity_unavailable');
    }

    // ─── Global Forwarding: non-Telegram responses → Telegram ───
    if (settings["telegram"]?.forwardAll !== false) {
        attachTelegramForwarder(bot);
    }

    void syncTelegramCommands(bot).catch((e) => {
        log.warn('[tg:commands] setMyCommands failed:', logErrorText(e));
    });

    const poller = new TelegramDurablePoller({
        api: bot.api,
        key: String(botUserId),
        store: telegramUpdateOffsets,
        handleUpdateThroughFinalDelivery: async (update) => {
            // Journal before the handler and complete before returning, because the
            // caller advances the offset only after this resolves. A throw from the
            // append leaves the offset where it was and Telegram redelivers, which is
            // the whole reason the ordering is this way round.
            const admission = admitTelegramUpdate(update as unknown as Record<string, unknown>);
            if (!admission.admit) return;
            try {
                if (!handleTelegramUpdate(update as unknown as Record<string, unknown>, telegramApprovalIngress)) {
                    await bot.handleUpdate(update);
                    if (telegramFinalDeliveryFailures.has(update.update_id)) {
                        throw new Error('telegram_final_delivery_failed');
                    }
                }
                settleIngress(getIngressJournal(), admission);
            } catch (error) {
                settleIngress(getIngressJournal(), admission, error);
                throw error;
            } finally {
                telegramFinalDeliveryFailures.delete(update.update_id);
            }
        },
        onStart: (info) => {
            tg409RetryCount = 0;
            const skipped = info.skippedThroughUpdateId === null ? '' : `; skipped through update ${info.skippedThroughUpdateId}`;
            log.info(`[tg] ✅ @${botUsername ?? botUserId} durable polling active at offset ${info.nextOffset}${skipped}`);
        },
    });
    telegramPoller = poller;
    telegramApprovalIngress = createTelegramPollingIngress();
    poller.start().catch((err: unknown) => {
        const telegramError = err as { error_code?: number; message?: string };
        const is409 = telegramError.error_code === 409 || telegramError.message?.includes('409');
        if (is409) {
            tg409RetryCount++;
            if (tg409RetryCount > TG_MAX_RETRIES) {
                log.error(`[tg:409] Max retries (${TG_MAX_RETRIES}) exceeded. Restart server to retry.`);
                return;
            }
            const delay = Math.min(5000 * Math.pow(2, tg409RetryCount - 1), 30000);
            log.warn(`[tg:409] Polling conflict — retry ${tg409RetryCount}/${TG_MAX_RETRIES} in ${delay / 1000}s...`);
            if (!tgRetryTimer) {
                tgRetryTimer = setTimeout(() => { tgRetryTimer = null; void initTelegram(); }, delay);
            }
        } else {
            log.error('[tg:fatal] Telegram durability bootstrap/polling failed; no uncommitted backlog consumed', logErrorText(err));
        }
    });
    telegramBot = bot;
    log.info('[tg] Bot starting...');
    // Accepted, not yet receiving: poller.start() above is deliberately not awaited so
    // boot does not block on a Telegram round trip. Readiness is reported by health.
    return transportStarted;
}
