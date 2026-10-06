import { slackCredentialKey } from '../slack/tool-context.js';
import type { Express, Request, Response } from 'express';
import { resolveSlackToolPrincipal, slackToolContext, withSlackToolAccess, slackToolDenied, type SlackOperatorValidator } from '../slack/tool-access.js';
import { assertSlackWriteAllowed } from '../slack/write-guard.js';
import { getHomeChannel, getLastActiveTarget, getLatestSeenTarget } from '../messaging/runtime.js';
import type { AuthMiddleware } from './types.js';
import { httpStatus, httpCode, httpDetail } from './_http-error.js';
import fs from 'fs';
import os from 'os';
import { execFileSync, spawn } from 'node:child_process';
import { basename, dirname, extname, normalize, resolve, relative, isAbsolute } from 'path';
import express from 'express';
import { ok, fail } from '../http/response.js';
import { saveUpload } from '../agent/spawn.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { getTelegramSendClient, getLatestTelegramChatId } from '../telegram/bot.js';
import { validateFileSize, sendTelegramFile } from '../telegram/telegram-file.js';
import { assertSendFilePath, hostPathEnvironment } from '../security/path-guards.js';
import { decodeFilenameSafe } from '../security/decode.js';
import { sendChannelOutput, normalizeChannelSendRequest, targetFromChatId, validateExplicitChatId, validateTarget } from '../messaging/send.js';
import { recordSelfDelivery } from '../messaging/turn-delivery.js';
import type { RemoteTarget } from '../messaging/types.js';

/**
 * The claim address for a send made through the legacy `/api/telegram/send`.
 *
 * It must agree field-for-field with what `buildTelegramTarget` produces on the
 * dispatch side, because the claim is keyed on the whole address: a key that
 * disagrees is the same as no claim at all, and the duplicate simply survives.
 *
 * `peerKind` is the one field this route cannot observe, having no `Context` to
 * read `chat.type` from. Telegram's own id convention settles it — group and
 * supergroup ids are negative, private chats positive — which is the same
 * distinction `isGroup` makes there. `threadId` follows the dispatch rule of
 * ignoring the General topic (id 1).
 */
function telegramTargetForClaim(chatId: string | number, threadId?: number): RemoteTarget {
    const targetId = String(chatId);
    return stripUndefined({
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: targetId.startsWith('-') ? 'group' : 'direct',
        targetId,
        threadId: threadId !== undefined && threadId > 1 ? String(threadId) : undefined,
    }) as RemoteTarget;
}
import { validateChannelCredentials } from '../messaging/channel-validate.js';
import { sendResultHttpStatus } from '../messaging/send-result.js';
import { isUnconfirmedSend } from '../messaging/file-receipt.js';
import { getSlackSendClient } from '../slack/send-only-client.js';
import { getSlackSelfUserId } from '../slack/bot.js';
import { fetchSlackHistory, fetchSlackReplies, formatHistoryForAgentDetailed, slackHistoryForAgent } from '../slack/history.js';
import { getCachedSlackIdentities } from '../slack/identity.js';
import { fetchSlackChannelMembers, fetchSlackWorkspaceUsers, formatRosterForAgent } from '../slack/roster.js';
import type { SlackHistoryMessage } from '../slack/history.js';

/**
 * Best-effort author names for a history window. Every failure path yields an
 * empty map, which renders exactly as the pre-existing mention syntax.
 *
 * Cache-first by design: a 200-message window of unseen users must not turn into
 * a burst of users.info calls, and two concurrent history reads would each pace
 * themselves independently. Only names already resolved (by inbound traffic or a
 * roster read) are used here; unknown ids simply render as before.
 */
async function resolveHistoryNames(
    _token: string, messages: readonly SlackHistoryMessage[],
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const ids = new Set<string>();
    for (const message of messages) {
        if (message.user) ids.add(message.user);
        else if (message.botId) ids.add(message.botId);
    }
    if (!ids.size) return names;
    try {
        const teamId = String(settings["slack"]?.teamId || 'unknown');
        for (const [id, identity] of getCachedSlackIdentities(teamId, [...ids])) {
            if (identity.resolved) names.set(id, identity.name);
        }
    } catch {
        // Identity is decoration; a history read must never fail because of it.
    }
    return names;
}
import { settings, JAW_HOME, UPLOADS_DIR } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { log } from '../core/logger.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';

function resolveTelegramChatId(body: Record<string, unknown>): string | number | null {
    const raw = body?.['chat_id'] ?? body?.['chatId'];
    if (raw != null && String(raw).trim()) return raw as string | number;
    return getLatestTelegramChatId()
        ?? settings["telegram"]?.allowedChatIds?.[0]
        ?? null;
}

// ─── File open helpers ──────────────────────────────

const FILE_LINE_SUFFIX_RE = /^(.*?)(?::\d+(?::\d+)?)$/;
const DOCUMENT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.md', '.txt', '.yml', '.yaml',
    '.css', '.html', '.xml', '.svg',
    '.py', '.go', '.rs', '.java', '.sh',
    '.docx', '.xlsx', '.pptx', '.pdf',
]);

type OpenTarget = {
    openedPath: string;
    resolvedTarget: string;
    strategy: 'reveal' | 'folder' | 'directory';
};

function expandOpenPath(rawPath: string): string {
    return expandHomePath(rawPath, os.homedir());
}

function getExistingNormalizedPath(candidatePath: string): string | null {
    const normalized = normalize(resolve(candidatePath));
    return fs.existsSync(normalized) ? normalized : null;
}

function classifyOpenTarget(normalized: string): OpenTarget {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
        return { openedPath: normalized, resolvedTarget: normalized, strategy: 'directory' };
    }
    const ext = extname(normalized).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(ext)) {
        return { openedPath: normalized, resolvedTarget: normalized, strategy: 'reveal' };
    }
    return { openedPath: dirname(normalized), resolvedTarget: normalized, strategy: 'folder' };
}

function resolveOpenTarget(rawPath: string): OpenTarget {
    const expanded = expandOpenPath(rawPath);
    const exactMatch = getExistingNormalizedPath(expanded);
    if (exactMatch) return classifyOpenTarget(exactMatch);

    const strippedMatch = expanded.match(FILE_LINE_SUFFIX_RE)?.[1];
    if (strippedMatch) {
        const strippedPath = getExistingNormalizedPath(strippedMatch);
        if (strippedPath) return classifyOpenTarget(strippedPath);
    }

    throw new Error('file_not_found');
}

export function registerMessagingRoutes(app: Express, requireAuth: AuthMiddleware,
    options: { validateSlackOperator?: SlackOperatorValidator; isFullAccess?: (req: Request) => boolean } = {}): void {
    const fullFor = (req: Request) => options.isFullAccess?.(req) === true;
    const principalFor = (req: Request, full: boolean) => {
        for (const input of [req.body, req.query]) if (input && typeof input === 'object'
            && ['requesterId', 'actorId', 'actionToken', 'botToken'].some(key => Object.hasOwn(input, key))) throw slackToolDenied('slack_caller_identity_forbidden', 400);
        return resolveSlackToolPrincipal(req.headers, options.validateSlackOperator ?? (() => false), { isFullAccess: full });
    };
    const lookup = async <T>(req: Request, res: Response, token: string, channel: string | undefined,
        operation: (signal?: AbortSignal) => Promise<T>): Promise<T | undefined> => {
        try { return await withSlackToolAccess(token, principalFor(req, fullFor(req)), channel, async signal => {
            if (getSlackSendClient().token !== token) throw slackToolDenied('slack_credential_changed', 409);
            const result = await operation(signal);
            if (getSlackSendClient().token !== token) throw slackToolDenied('slack_credential_changed', 409);
            return result;
        }); }
        catch (error) { res.status(httpStatus(error, 403)).json({ ok: false, error: userErrorText(error), code: httpCode(error) }); return undefined; }
    };
    const sendSlackAware = async (req: Request, request: ReturnType<typeof normalizeChannelSendRequest>, full: boolean) => {
        const channel = request.target?.channel ?? (request.channel && request.channel !== 'active' ? request.channel : getHomeChannel());
        if (channel !== 'slack') return sendChannelOutput({ ...request, fromAgentSurface: true });
        const principal = principalFor(req, full);
        const client = getSlackSendClient();
        if (!client.token) throw slackToolDenied('slack_unavailable', 503);
        const scopedGrant = slackToolContext(principal);
        if (principal.kind === 'turn' || scopedGrant?.enforceDestination === true) {
            if (request.filePath) {
                const inside = (root: string) => {
                    const rel = relative(fs.realpathSync(root), request.filePath!);
                    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
                };
                if (inside(JAW_HOME) && (!fs.existsSync(UPLOADS_DIR) || !inside(UPLOADS_DIR))) throw slackToolDenied('slack_private_home_file_denied');
            }
            const destination = scopedGrant!.destination;
            const candidate = request.target ?? request.turnTarget;
            if ((candidate && (candidate.targetId !== destination.targetId || (candidate.threadId ?? '') !== (destination.threadId ?? '')))
                || (request.chatId !== undefined && String(request.chatId) !== destination.targetId)) throw slackToolDenied('slack_destination_mismatch');
            request = { ...request, target: destination, channel: 'slack' };
        }
        const implicitTarget = !request.target && request.chatId === undefined
            ? [request.turnTarget, getLastActiveTarget('slack'), getLatestSeenTarget('slack'),
                settings['slack']?.channelIds?.[0] ? targetFromChatId('slack', settings['slack'].channelIds[0]) : null]
                .find(candidate => candidate && validateTarget(candidate, 'slack'))
            : null;
        const targetId = request.target?.targetId ?? (request.chatId !== undefined ? String(request.chatId) : implicitTarget?.targetId);
        if (scopedGrant?.serverOwnedDelivery === true) {
            assertSlackWriteAllowed(principal, scopedGrant, targetId ?? scopedGrant.destination.targetId);
        }
        if (targetId) assertSlackWriteAllowed(principal, scopedGrant ?? null, targetId);
        return withSlackToolAccess(client.token, principal, principal.kind === 'turn' ? principal.grant.destination.targetId : undefined,
            signal => {
                if (targetId) assertSlackWriteAllowed(principal, scopedGrant ?? null, targetId);
                return sendChannelOutput({ ...request, slackCredentialKey: slackCredentialKey(client.token!), ...(signal ? { signal } : {}), fromAgentSurface: true });
            }, undefined,
            result => ({ ...result, ok: false, error: 'slack_grant_cancelled_after_dispatch', sent: result['sent'] === 'unknown' ? 'unknown' : result.ok || result['sent'] === true, retryable: false, status: 409 }));
    };
    app.post('/api/upload', requireAuth, express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
        try {
            const filename = decodeFilenameSafe(req.headers['x-filename'] as string | undefined);
            const filePath = saveUpload(req.body, filename);
            res.json({ path: filePath, filename: basename(filePath) });
        } catch (e: unknown) {
            res.status(httpStatus(e, 400)).json({ error: userErrorText(e) });
        }
    });

    // Open file in system file manager (Finder reveal)
    // NOTE: cli-jaw is a localhost-only program. No remote access.
    app.post('/api/file/open', requireAuth, async (req, res) => {
        const { path: rawPath } = req.body;
        if (!rawPath || typeof rawPath !== 'string') {
            return fail(res, 400, 'path_required');
        }
        try {
            const target = resolveOpenTarget(rawPath);
            if (process.platform === 'darwin') {
                if (target.strategy === 'reveal') {
                    execFileSync('open', ['-R', target.resolvedTarget]);
                } else {
                    execFileSync('open', [target.openedPath]);
                }
            } else if (process.platform === 'win32') {
                // explorer.exe exits 1 even on success, so its exit code carries
                // no information and execFileSync would always throw (#383).
                // resolveOpenTarget already stat'ed the path, so a missing file
                // was rejected with 404 before any spawn. /select, and the path
                // must be ONE argv entry.
                const arg = target.strategy === 'reveal'
                    ? '/select,' + target.resolvedTarget
                    : target.openedPath;
                const child = spawn('explorer', [arg], { detached: true, stdio: 'ignore' });
                child.once('error', () => { /* explorer missing is not actionable here */ });
                child.unref();
            } else {
                // xdg-open may live as long as the desktop application (#540).
                // Acknowledge launch, not exit, without retaining server pipes.
                await new Promise<void>((resolve, reject) => {
                    const child = spawn('xdg-open', [target.openedPath], { detached: true, stdio: 'ignore' });
                    child.once('error', reject);
                    child.once('spawn', () => {
                        child.unref();
                        resolve();
                    });
                });
            }
            ok(res, {
                opened: target.openedPath,
                resolvedTarget: target.resolvedTarget,
                strategy: target.strategy,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'open_failed';
            if (message === 'file_not_found') {
                return fail(res, 404, 'file_not_found');
            }
            fail(res, 500, 'open_failed');
        }
    });

    // Voice STT endpoint — receives raw audio blob, transcribes, submits as message
    app.post('/api/voice', requireAuth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }), async (req, res) => {
        try {
            const ext = (req.headers['x-voice-ext'] as string) || '.webm';
            const mime = req.headers['content-type'] || 'audio/webm';
            const filePath = saveUpload(req.body, `voice${ext}`);

            const { transcribeVoice } = await import('../../lib/stt.js');
            const result = await transcribeVoice(filePath, mime);

            if (!result.text.trim()) {
                res.status(422).json({ error: 'Empty transcription' });
                return;
            }

            log.info(`[web:voice] STT (${result.engine}, ${result.elapsed.toFixed(1)}s): ${redactOutboundText(result.text).slice(0, 80)}`);

            const sttOnly = String(req.headers['x-stt-only'] || '') === 'true';
            if (!sttOnly) {
                const prompt = `🎤 ${result.text}`;
                submitMessage(prompt, { origin: 'web' });
            }

            // A transcript is user-supplied text reflected back over HTTP.
            res.json({ ok: true, text: redactOutboundText(result.text), engine: result.engine, elapsed: result.elapsed });
        } catch (e: unknown) {
            log.error('[web:voice] STT failed:', logErrorText(e));
            res.status(500).json({ error: userErrorText(e) });
        }
    });

    // Telegram direct send
    app.post('/api/telegram/send', requireAuth, async (req, res) => {
        try {
            const full = fullFor(req);
            const sendClient = getTelegramSendClient();
            if (!sendClient.client) {
                res.status(sendClient.status ?? 503).json({ ok: false, error: sendClient.reason ?? 'Telegram not configured' });
                return;
            }

            const type = String(req.body?.type || '').trim().toLowerCase();
            const supportedTypes = new Set(['text', 'voice', 'photo', 'document']);
            if (!supportedTypes.has(type)) {
                res.status(400).json({ error: 'type must be one of: text, voice, photo, document' });
                return;
            }

            const explicitChatId = req.body?.chat_id ?? req.body?.chatId;
            if (full && (explicitChatId == null || !String(explicitChatId).trim())) {
                res.status(400).json({ ok: false, code: 'full_access_destination_required',
                    error: 'Full-local Telegram send requires an explicit chat_id; active-conversation defaults are not used.' });
                return;
            }
            if (full && (typeof explicitChatId !== 'string' && typeof explicitChatId !== 'number'
                || typeof explicitChatId === 'number' && !Number.isFinite(explicitChatId))) {
                res.status(400).json({ ok: false, error: 'invalid_chat_id' }); return;
            }
            const chatId = full ? explicitChatId as string | number : resolveTelegramChatId(req.body || {});
            if (!chatId) {
                res.status(400).json({ error: 'chat_id required (or send a Telegram message first)' });
                return;
            }
            if (explicitChatId != null && String(explicitChatId).trim()
                && !validateExplicitChatId('telegram', explicitChatId as string | number, { fullAccess: full })) {
                res.status(403).json({ error: full ? 'invalid_chat_id' : 'chat_id is not in the configured Telegram allowlist' });
                return;
            }

            // P0: optional message_thread_id (alias thread_id). General topic id=1 sends as
            // usual (n > 1), matching threadIdNumber + sendToTopic semantics.
            const rawThread = req.body?.message_thread_id ?? req.body?.thread_id;
            const threadNum = Number(rawThread);
            const messageThreadId = rawThread != null && Number.isInteger(threadNum) && threadNum > 1 ? threadNum : undefined;

            if (type === 'text') {
                const text = String(req.body?.text || '').trim();
                if (!text) {
                    res.status(400).json({ error: 'text required for type=text' });
                    return;
                }
                await sendClient.client.api.sendMessage(chatId, redactOutboundText(text), stripUndefined({ message_thread_id: messageThreadId }));
                // This legacy route is still advertised to agents, and it talks to
                // the Bot API directly instead of going through sendChannelOutput
                // — so it needs its own claim, or an answer delivered here would
                // be posted a second time when the turn settles.
                recordSelfDelivery({
                    target: telegramTargetForClaim(chatId, messageThreadId),
                    channel: 'telegram',
                    text,
                });
                res.json({ ok: true, chat_id: chatId, type });
                return;
            }

            const filePath = String(req.body?.file_path || '').trim();
            if (!filePath) {
                res.status(400).json({ error: 'file_path required for non-text types' });
                return;
            }
            const safePath = assertSendFilePath(filePath, settings["workingDir"] || undefined, settings["projectDirs"] || null,
                hostPathEnvironment, { fullAccess: full });
            if (!fs.existsSync(safePath)) {
                res.status(400).json({ error: `file not found: ${safePath}` });
                return;
            }

            validateFileSize(safePath, type);

            const caption = req.body?.caption ? String(req.body.caption) : undefined;
            const result = await sendTelegramFile(sendClient.client, chatId, safePath, type, stripUndefined({ caption, threadId: messageThreadId }));

            // The FILE is never claimed: whether those bytes reached the user
            // cannot be proven from a path later (see messaging/turn-delivery.ts).
            // The caption is different — Telegram renders it as the message text
            // under the upload, so the user can see it, and an answer equal to it
            // would otherwise be posted a second time. Same rule the canonical
            // route follows for file sends.
            //
            // An UNCONFIRMED upload is claimed too. Telegram took the bytes and
            // would not name the message it made, so the caption may well be on
            // screen; gating the claim on `ok` alone is exactly what let the
            // dispatch path post the same words a second time beside a file that
            // had most likely arrived. A hard refusal (400, 413, auth) still
            // claims nothing, because it delivered nothing.
            const unconfirmed = isUnconfirmedSend(result);
            if (caption && (result.ok || unconfirmed)) {
                recordSelfDelivery({
                    target: telegramTargetForClaim(chatId, messageThreadId),
                    channel: 'telegram',
                    text: caption,
                });
            }
            if (!result.ok) {
                const sc = result.statusCode || 502;
                res.status(sc).json({
                    error: result.error, attempts: result.attempts,
                    ...(result.confirmation ? { confirmation: result.confirmation } : {}),
                    ...(result.retryAfter != null && { retry_after: result.retryAfter }),
                });
                return;
            }
            res.json({ ok: true, chat_id: chatId, type, attempts: result.attempts,
                ...(result.confirmation ? { confirmation: result.confirmation } : {}) });
        } catch (e: unknown) {
            log.error('[telegram:send]', logErrorText(e));
            const statusCode = httpStatus(e, 500);
            res.status(statusCode).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    // Onboarding wizard live credential check. Validates WITHOUT persisting —
    // the wizard saves through PUT /api/settings after this passes.
    app.post('/api/channels/validate', requireAuth, async (req, res) => {
        const result = await validateChannelCredentials(req.body || {});
        res.json(result.ok
            ? {
                ok: true,
                identity: result.identity,
                teamId: result.teamId,
                ...(result.missingCapabilities?.length
                    ? { missingCapabilities: result.missingCapabilities }
                    : {}),
            }
            : { ok: false, error: result.error, ...(result.missing?.length ? { missing: result.missing } : {}) });
    });

    // Canonical channel send
    app.post('/api/channel/send', requireAuth, async (req, res) => {
        try {
            // `fromAgentSurface` is set HERE rather than inside the normalizer:
            // it is a fact about how the send arrived, not about its body, and
            // an agent must not be able to claim it by putting a field in JSON.
            const full = fullFor(req);
            // A server-owned scheduled turn carries an enforced grant even when
            // the instance runs Auto/full-local. Let that grant supply the
            // destination before the full-access normalizer rejects an omitted
            // address; sendSlackAware then pins or rejects any supplied address.
            const preflightGrant = full && req.body?.channel === 'slack'
                ? slackToolContext(principalFor(req, full))
                : undefined;
            const enforcedDestination = preflightGrant?.enforceDestination === true
                ? preflightGrant.destination
                : undefined;
            const result = await sendSlackAware(
                req,
                normalizeChannelSendRequest(enforcedDestination && req.body?.target === undefined
                    ? { ...req.body, target: enforcedDestination }
                    : req.body, { fullAccess: full }),
                full,
            );
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[channel:send]', logErrorText(e));
            // The refusal reason alone left the caller nowhere to go: the allowed
            // roots live in settings an agent never reads (#404).
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    app.post('/api/discord/send', requireAuth, async (req, res) => {
        try {
            const full = fullFor(req);
            const result = await sendChannelOutput({
                ...normalizeChannelSendRequest(req.body, { fullAccess: full }),
                channel: 'discord',
                fromAgentSurface: true,
            });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[discord:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    app.post('/api/slack/send', requireAuth, async (req, res) => {
        try {
            const full = fullFor(req);
            const result = await sendSlackAware(req, { ...normalizeChannelSendRequest(req.body, { fullAccess: full }), channel: 'slack' }, full);
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[slack:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    // Dynamic Slack lookup for the agent: a channel window or one thread.
    // GET /api/slack/history?channel=C..[&thread_ts=..][&limit=..][&format=text]
    // Read-only and loopback-friendly (requireAuth bypasses localhost), so the
    // running agent can pull conversation context it was not mentioned into.
    app.get('/api/slack/history', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            // `!token` does not narrow the union (an empty string would land
            // here too), so default the status for the type system's sake.
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const channel = String(req.query['channel'] || '').trim();
        if (!channel) {
            res.status(400).json({ ok: false, error: 'channel_required' });
            return;
        }
        const allowed = new Set(['channel', 'thread_ts', 'limit', 'cursor', 'oldest', 'latest', 'inclusive', 'format']);
        const query = req.query;
        const invalid = Object.entries(query).some(([key, value]) => !allowed.has(key)
            || typeof value !== 'string' || value.length > 2048)
            || ['thread_ts', 'oldest', 'latest'].some(key => query[key] !== undefined && !/^\d+(?:\.\d+)?$/.test(String(query[key])))
            || (query['limit'] !== undefined && (!/^\d+$/.test(String(query['limit'])) || Number(query['limit']) < 1 || !Number.isSafeInteger(Number(query['limit']))))
            || (query['inclusive'] !== undefined && !['true', 'false', '1', '0'].includes(String(query['inclusive'])))
            || (query['format'] !== undefined && !['text', 'json'].includes(String(query['format'])))
            || (query['oldest'] !== undefined && query['latest'] !== undefined && Number(query['oldest']) > Number(query['latest']));
        if (invalid) { res.status(400).json({ ok: false, error: 'invalid_history_query' }); return; }
        const threadTs = String(query['thread_ts'] || '');
        const opts = {
            ...(query['limit'] ? { limit: Number(query['limit']) } : {}),
            ...(query['cursor'] ? { cursor: String(query['cursor']) } : {}),
            ...(query['oldest'] ? { oldest: String(query['oldest']) } : {}),
            ...(query['latest'] ? { latest: String(query['latest']) } : {}),
            inclusive: ['true', '1'].includes(String(query['inclusive'])),
        };
        const result = await lookup(req, res, client.token, channel, signal => threadTs
            ? fetchSlackReplies(client.token!, channel, threadTs, { ...opts, ...(signal ? { signal } : {}) })
            : fetchSlackHistory(client.token!, channel, { ...opts, ...(signal ? { signal } : {}) }));
        if (!result) return;
        if (!result.ok) {
            // Keep the provider code separate from Jaw authorization failures;
            // never return the raw upstream payload.
            res.status(502).json({ ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) });
            return;
        }
        const messages = slackHistoryForAgent(result.messages);
        const contentTruncated = messages.some(message => message.contentTruncated);
        const metadata = { hasMore: result.hasMore, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            partial: result.hasMore || contentTruncated, fetchedCount: messages.length, contentTruncated,
            ...(opts.oldest ? { oldest: opts.oldest } : {}), ...(opts.latest ? { latest: opts.latest } : {}), inclusive: opts.inclusive };
        if (String(req.query['format'] || '') === 'text') {
            const names = await resolveHistoryNames(client.token, messages);
            const formatted = formatHistoryForAgentDetailed(messages, getSlackSelfUserId(), names);
            const text = formatted.text;
            const truncated = contentTruncated || formatted.truncated;
            res.json({ ok: true, ...metadata, partial: metadata.partial || truncated, contentTruncated: truncated, text });
            return;
        }
        res.json({ ok: true, ...metadata, messages });
    });

    // Who is in this conversation? Same contract shape as /api/slack/history:
    // read-only, loopback-friendly, prose errors only.
    // GET /api/slack/members?channel=C..[&limit=N][&format=text]
    app.get('/api/slack/members', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const channel = String(req.query['channel'] || '').trim();
        if (!channel) {
            res.status(400).json({ ok: false, error: 'channel_required' });
            return;
        }
        const limit = Number(req.query['limit']) || undefined;
        const result = await lookup(req, res, client.token, channel, signal => fetchSlackChannelMembers(client.token!, channel, {
            ...(signal ? { signal } : {}),
            teamId: String(settings["slack"]?.teamId || 'unknown'),
            ...(limit ? { limit } : {}),
        }));
        if (!result) return;
        if (!result.ok) {
            res.status(502).json({ ok: false, error: result.error });
            return;
        }
        if (String(req.query['format'] || '') === 'text') {
            res.json({ ok: true, text: formatRosterForAgent(result, { channel }) });
            return;
        }
        res.json({ ok: true, members: result.members, hasMore: result.hasMore, partial: result.partial });
    });

    // GET /api/slack/users[?limit=N][&include_bots=1][&include_deleted=1][&format=text]
    app.get('/api/slack/users', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const limit = Number(req.query['limit']) || undefined;
        const result = await lookup(req, res, client.token, undefined, signal => fetchSlackWorkspaceUsers(client.token!, {
            ...(signal ? { signal } : {}),
            teamId: String(settings["slack"]?.teamId || 'unknown'),
            ...(limit ? { limit } : {}),
            ...(req.query['include_bots'] ? { includeBots: true } : {}),
            ...(req.query['include_deleted'] ? { includeDeleted: true } : {}),
        }));
        if (!result) return;
        if (!result.ok) {
            res.status(502).json({ ok: false, error: result.error });
            return;
        }
        if (String(req.query['format'] || '') === 'text') {
            res.json({ ok: true, text: formatRosterForAgent(result) });
            return;
        }
        res.json({
            ok: true, members: result.members, hasMore: result.hasMore,
            partial: result.partial, ...(result.teamName ? { teamName: result.teamName } : {}),
        });
    });
}
