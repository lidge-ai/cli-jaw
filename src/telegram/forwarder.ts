// ─── Telegram Forwarding Utilities ───────────────────

import { safeCut } from '../messaging/chunk.js';
import { redactOutboundText, logErrorText } from '../messaging/redact.js';

export function escapeHtmlTg(text: string) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md: string) {
    if (!md) return '';
    let html = escapeHtmlTg(md);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![*])\*(?![*])(.+?)(?<![*])\*(?![*])/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    return html;
}

const TELEGRAM_SUPPORTED_TAGS = new Set(['pre', 'code', 'b', 'i', 's']);

function tagBalanceDelta(chunk: string): number {
    let balance = 0;
    const tagRe = /<\/?([a-z]+)>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(chunk)) !== null) {
        const full = match[0];
        const tag = String(match[1] || '').toLowerCase();
        if (!TELEGRAM_SUPPORTED_TAGS.has(tag)) continue;
        balance += full.startsWith('</') ? -1 : 1;
    }
    return balance;
}

function isBalancedTelegramHtml(chunk: string): boolean {
    return tagBalanceDelta(chunk) === 0;
}

function isInsideTagToken(text: string, index: number): boolean {
    const lastLt = text.lastIndexOf('<', index - 1);
    const lastGt = text.lastIndexOf('>', index - 1);
    return lastLt > lastGt;
}

function findHtmlSafeSplit(raw: string, limit: number): number {
    if (isInsideTagToken(raw, limit)) {
        // Always just past a '>', so never inside a surrogate pair.
        const close = raw.indexOf('>', limit);
        if (close >= 0) return close + 1;
    }

    const candidates: number[] = [];
    for (let i = Math.min(limit, raw.length); i > 0; i -= 1) {
        const ch = raw[i - 1];
        if (ch !== '\n' && ch !== ' ' && ch !== '>') continue;
        if (isInsideTagToken(raw, i)) continue;
        candidates.push(i);
    }
    // Hard-split fallback must land on a code-point boundary: cutting between
    // a surrogate pair ships half an emoji.
    const hardSplit = safeCut(raw, limit);
    candidates.push(hardSplit);

    for (const candidate of candidates) {
        if (candidate < limit * 0.3 && candidate !== hardSplit) continue;
        const chunk = raw.slice(0, candidate);
        if (isBalancedTelegramHtml(chunk)) return candidate;
    }
    return hardSplit;
}

export function chunkTelegramHtmlMessage(html: string, limit = 4096): string[] {
    const raw = String(html || '');
    if (raw.length <= limit) return [raw];
    const chunks: string[] = [];
    let remaining = raw;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        const splitAt = findHtmlSafeSplit(remaining, limit);
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks;
}

export function chunkTelegramMessage(text: string, limit = 4096) {
    return chunkTelegramHtmlMessage(text, limit);
}

function isUserSafeWatchdogDiagnostic(text: string) {
    return /^❌\s*⏱️\s*응답 없음\s*—\s+/.test(String(text || '').trim());
}

/**
 * Listener lifecycle helper used by telegram bridge and unit tests.
 * Ensures attach/detach idempotency so re-init does not leak listeners.
 */
import type { Bot } from 'grammy';
import { settings } from '../core/config.js';
import { log as appLog } from '../core/logger.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { extractLocalImagePaths } from '../messaging/extract-images.js';
import { threadIdNumber } from '../messaging/thread-target.js';
import type { RemoteTarget } from '../messaging/types.js';
import { resolveForwarderTarget } from '../messaging/forwarder-origin.js';
import { classifySendFailure } from '../messaging/retry.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { sendTelegramMarkdown } from './rich-message.js';
import { sendTelegramFile, validateFileSize } from './telegram-file.js';

type BroadcastForwarder = (type: string, data: Record<string, unknown>) => void | Promise<void>;

interface ForwarderLifecycleOptions {
    addListener?: (listener: BroadcastForwarder) => void;
    removeListener?: (listener: BroadcastForwarder) => void;
    buildForwarder?: (args: Record<string, unknown>) => BroadcastForwarder | null;
}

interface TelegramForwarderOptions {
    bot: Bot;
    shouldSkip?: (data: Record<string, unknown>) => boolean;
    log?: (info: { chatId: string | number; preview: string }) => void;
    prefix?: string;
}

export async function relayTelegramImages(
    bot: Bot,
    chatId: string | number,
    text: string,
    target?: RemoteTarget | null,
    options: { signal?: AbortSignal } = {},
): Promise<void> {
    for (const candidate of extractLocalImagePaths(text)) {
        if (options.signal?.aborted) return;
        try {
            const filePath = assertSendFilePath(
                candidate,
                settings["workingDir"] || undefined,
                settings["projectDirs"] || null,
            );
            validateFileSize(filePath, 'photo');
            const result = await sendTelegramFile(
                bot,
                chatId,
                filePath,
                'photo',
                stripUndefined({ threadId: threadIdNumber(target ?? undefined), signal: options.signal }),
            );
            if (!result.ok) {
                appLog.warn('[tg:image-relay] send failed', {
                    path: candidate,
                    error: result.error || 'unknown error',
                });
            }
        } catch (error: unknown) {
            appLog.warn('[tg:image-relay] skipped', {
                path: candidate,
                error: logErrorText(error),
            });
        }
    }
}

export function createForwarderLifecycle({
    addListener,
    removeListener,
    buildForwarder,
}: ForwarderLifecycleOptions = {}) {
    let forwarder: BroadcastForwarder | null = null;
    return {
        attach(args: Record<string, unknown> = {}) {
            if (forwarder) return forwarder;
            const next = typeof buildForwarder === 'function' ? buildForwarder(args) : null;
            if (typeof next !== 'function') {
                throw new TypeError('buildForwarder must return a function');
            }
            forwarder = next;
            if (typeof addListener === 'function') addListener(forwarder);
            return forwarder;
        },
        detach() {
            if (!forwarder) return;
            if (typeof removeListener === 'function') removeListener(forwarder);
            forwarder = null;
        },
        getCurrent() {
            return forwarder;
        },
    };
}

/**
 * Build a pure forwarder handler for `agent_done` broadcasts.
 * Side-effects are limited to bot API calls, so logic is unit-testable.
 */
export function createTelegramForwarder({
    bot,
    shouldSkip = (_data: Record<string, unknown>) => false,
    log = (_info: { chatId: string | number; preview: string }) => { },
    prefix = '📡 ',
}: TelegramForwarderOptions) {
    return (type: string, data: Record<string, unknown>) => {
        void (async () => {
            if (type !== 'agent_done' || !data?.["text"]) return;
            if (data["error"] && !isUserSafeWatchdogDiagnostic(String(data["text"]))) return;
            if (shouldSkip(data)) return;

            // The run's own destination only. `getLastTarget`/`getLastChatId`
            // answer "who spoke here most recently", which a concurrent
            // conversation moves out from under a running turn (#742).
            const target = resolveForwarderTarget(data, 'telegram');
            const chatId = target?.targetId ?? null;
            if (!chatId) return;

            const text = String(data["text"]);
            // Rich-first default; helper owns format fallback and bounded 429 retry.
            await sendTelegramMarkdown(bot.api, chatId, text, stripUndefined({
                prefix,
                message_thread_id: threadIdNumber(target ?? undefined),
                requireBodyDelivery: true,
            }));

            // Redact BEFORE slicing: the preview goes to a log file, and
            // a token in the first 200 characters would be stored raw.
            const preview = redactOutboundText(text).slice(0, 200).replace(/\n/g, ' ');
            log({ chatId, preview });
            await relayTelegramImages(bot, chatId, text, target);
        })().catch((error: unknown) => {
            const failureKind = classifySendFailure(error);
            appLog.warn('[tg:forward] delivery failed', {
                error: logErrorText(error),
                outcome: failureKind === 'ambiguous' ? 'unknown' : 'failed',
                retryable: false,
            });
        });
    };
}
