// ─── Slack Web API Client ────────────────────────────
// Thin fetch wrapper. No SDK: Slack's HTTP surface is small and cli-jaw's
// Discord transport already establishes the house pattern (REST via fetch,
// lazily imported).
//
// The critical Slack-specific rule: Slack returns HTTP 200 with
// {"ok": false, "error": "..."} for application errors. Checking response.ok
// alone silently swallows every auth, scope, and argument failure.

import { log } from '../core/logger.js';
import { redactChannelSecrets } from '../messaging/redact.js';

const SLACK_API_BASE = 'https://slack.com/api';
const SENSITIVE_ERROR_CODES = new Set(['missing_scope', 'not_authed', 'invalid_auth', 'account_inactive', 'token_expired', 'token_revoked', 'ratelimited', 'rate_limited', 'invalid_arguments', 'invalid_action_token', 'action_token_expired', 'not_allowed_token_type', 'not_in_channel', 'channel_not_found', 'thread_not_found', 'message_not_found', 'no_permission', 'team_access_not_granted', 'already_reacted', 'no_reaction', 'not_pinned', 'already_pinned', 'bookmark_not_found', 'invalid_scheduled_message_id', 'invalid_name', 'permission_denied', 'restricted_action', 'list_not_found', 'row_not_found', 'canvas_not_found', 'invalid_input_type', 'invalid_row_id', 'invalid_date', 'time_in_past', 'time_too_far', 'restricted_too_many', 'cant_update_message', 'cant_delete_message', 'edit_window_closed', 'msg_too_long', 'no_text', 'invalid_blocks', 'invalid_blocks_format', 'block_mismatch', 'too_many_attachments', 'update_failed']);

export type SlackApiResult<T = Record<string, unknown>> = {
    ok: boolean;
    error?: string;
    status?: number;
    retryAfterMs?: number;
    /**
     * Raw `x-oauth-scopes` response header when the transport exposed one.
     * Slack returns the token's whole granted set on every Web API response,
     * so a scope-drift check costs no extra call.
     *
     * `undefined` means "not observed" — NOT "no scopes". Test fetch mocks
     * routinely omit headers, and a proxy could strip them, so consumers must
     * treat absence as unknown rather than as a gap. See
     * `missingSlackScopes()`, which returns [] for a missing header for the
     * same reason.
     */
    grantedScopes?: string;
    data?: T;
};

/** Errors that justify a retry rather than surfacing to the user. */
const RETRYABLE_SLACK_ERRORS = new Set([
    'ratelimited',
    'service_unavailable',
    'internal_error',
    'request_timeout',
    'fatal_error',
]);

export function isRetryableSlackError(error: string | undefined): boolean {
    return !!error && RETRYABLE_SLACK_ERRORS.has(error);
}

/** Map a Slack error code to an actionable operator message. */
/**
 * Slack reports the scope it wanted in `response_metadata` (or a bare
 * `needed` field). Surfacing it turns "add the required scope" into
 * "add files:write", which is the difference between a fixable message and a
 * support round-trip (observed live: a DOCX upload failed on missing_scope and
 * the operator had to be told which scope by hand).
 */
export function neededScopeFrom(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const record = data as Record<string, unknown>;
    const direct = record['needed'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const meta = record['response_metadata'];
    if (meta && typeof meta === 'object') {
        const messages = (meta as Record<string, unknown>)['messages'];
        if (Array.isArray(messages)) {
            const hit = messages.find(m => typeof m === 'string' && m.includes('scope'));
            if (typeof hit === 'string') return hit.trim();
        }
    }
    return '';
}

export function describeSlackError(error: string | undefined, data?: unknown): string {
    switch (error) {
        case 'invalid_auth':
        case 'not_authed':
            return 'Slack token is invalid or missing (check the bot token, xoxb-...)';
        case 'account_inactive':
            return 'Slack bot token belongs to a deactivated app or workspace';
        case 'missing_scope': {
            const needed = neededScopeFrom(data);
            return needed
                ? `Slack app is missing the "${needed}" OAuth scope — add it under OAuth & Permissions, then reinstall the app`
                : 'Slack app is missing a required OAuth scope — add it under OAuth & Permissions, then reinstall the app';
        }
        case 'channel_not_found':
            return 'Slack conversation not found, or the bot is not a member of it';
        case 'not_in_channel':
            return 'Slack bot is not in that channel — invite it first (/invite @bot)';
        case 'is_archived':
            return 'Slack conversation is archived';
        case 'msg_too_long':
            return 'Slack message exceeded the length limit after chunking';
        case 'already_reacted':
            return 'Slack reaction is already on that message';
        case 'no_reaction':
            return 'Slack reaction was not there to remove';
        case 'invalid_name':
            return 'Slack emoji name is not valid in this workspace';
        case 'message_not_found':
            return 'Slack message not found — it may already be deleted';
        case 'ratelimited':
            return 'Slack rate limit hit — retry shortly';
        default:
            return error ? `Slack API error: ${error}` : 'Unknown Slack API error';
    }
}

/**
 * Redact Slack credentials before they reach a log sink or an API response.
 *
 * Delegates to the shared masker: error strings cross channel boundaries (the
 * unified send path collects results from all three transports), so a
 * Slack-only masker leaks the moment a Telegram error travels through Slack
 * code. The name is kept because it reads correctly at the call sites here.
 */
export const redactSlackTokens = redactChannelSecrets;

export type SlackFetch = typeof fetch;

/**
 * Build a failure result without emitting explicit `undefined` members.
 * The repo runs `exactOptionalPropertyTypes`, so `{ status: undefined }` is not
 * assignable to `{ status?: number }` — the key has to be absent instead.
 */
export function slackFailure(
    error: string,
    status?: number,
    retryAfterMs?: number,
    grantedScopes?: string,
): { ok: false; error: string; status?: number; retryAfterMs?: number; grantedScopes?: string } {
    return {
        ok: false,
        error,
        ...(status !== undefined ? { status } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(grantedScopes !== undefined ? { grantedScopes } : {}),
    };
}

export function parseRetryAfterMs(headers: Pick<Headers, 'get'>): number | undefined {
    const raw = headers.get('retry-after');
    if (raw == null || raw.trim() === '') return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
}

export async function readBoundedResponse(response: Response, limit: number, signal?: AbortSignal | null): Promise<string> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error('invalid_response_limit');
    if (!response.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text) > limit) throw new Error('slack_response_too_large');
        return text;
    }
    const reader = response.body.getReader();
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => { void reader.cancel().catch(() => {}); reject(new DOMException('aborted', 'AbortError')); };
        signal?.addEventListener('abort', cancel, { once: true });
    });
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        if (signal?.aborted) { void reader.cancel().catch(() => {}); throw new DOMException('aborted', 'AbortError'); }
        while (true) {
            const part = await Promise.race([reader.read(), aborted]);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > limit || chunks.length >= 4096) { void reader.cancel().catch(() => {}); throw new Error('slack_response_too_large'); }
            chunks.push(part.value);
        }
        return Buffer.concat(chunks, size).toString('utf8');
    } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/**
 * Call a Slack Web API method.
 * `fetchImpl` is injectable so tests capture payloads without a workspace.
 *
 * Every method used by this transport is POST. Some Slack methods (notably
 * files.getUploadURLExternal) take form-encoded arguments rather than JSON,
 * which is what `form: true` selects — NOT a GET request.
 */
export async function slackApi<T = Record<string, unknown>>(
    token: string,
    method: string,
    body?: Record<string, unknown>,
    options: { fetchImpl?: SlackFetch; form?: boolean; signal?: AbortSignal; timeoutMs?: number; sensitiveResponse?: boolean; maxResponseBytes?: number } = {},
): Promise<SlackApiResult<T>> {
    const doFetch = options.fetchImpl || fetch;
    const url = `${SLACK_API_BASE}/${method}`;
    // The catch below only recognises an abort when fetch actually throws for it.
    // A caller that hands over an already-aborted signal deserves the same answer
    // without a request going out at all — otherwise the cancellation surfaces
    // downstream as whatever the response happened to parse to (#464).
    if (options.signal?.aborted) {
        return { ok: false, error: 'slack_send_aborted', status: 499 };
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method: 'POST', headers };
    const timeoutMs = options.timeoutMs ?? (options.sensitiveResponse ? 10000 : undefined);
    if (options.signal && timeoutMs !== undefined) {
        init.signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    } else if (options.signal) {
        init.signal = options.signal;
    } else if (timeoutMs !== undefined) {
        init.signal = AbortSignal.timeout(timeoutMs);
    }
    if (options.form && body) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null) params.set(k, String(v));
        }
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        init.body = params.toString();
    } else if (body) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(body);
    }

    try {
        const response = await doFetch(url, init);
        const retryAfterMs = response.headers
            ? parseRetryAfterMs(response.headers)
            : undefined;
        // Same defensive read as retry-after: mocks and non-standard fetch
        // implementations may not carry headers at all.
        const grantedScopes = response.headers?.get?.('x-oauth-scopes') ?? undefined;
        const responseLimit = options.maxResponseBytes ?? (options.sensitiveResponse ? 1024 * 1024 : undefined);
        const text = responseLimit !== undefined ? await readBoundedResponse(response, responseLimit, init.signal) : await response.text();
        let parsed: Record<string, unknown> = {};
        try {
            parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch {
            return {
                ok: false,
                error: 'invalid_json_response',
                status: response.status,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                ...(grantedScopes !== undefined ? { grantedScopes } : {}),
            };
        }
        // Slack signals application errors with HTTP 200 + ok:false.
        if (parsed['ok'] !== true) {
            const rawError = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown_error';
            const err = options.sensitiveResponse && !SENSITIVE_ERROR_CODES.has(rawError) ? 'slack_request_failed' : rawError;
            if (!options.sensitiveResponse) log.warn('[slack:api]', redactSlackTokens(`${method} failed: ${err}`));
            return {
                ok: false,
                error: err,
                status: response.status,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                ...(grantedScopes !== undefined ? { grantedScopes } : {}),
                ...(options.sensitiveResponse ? {} : { data: parsed as T }),
            };
        }
        return {
            ok: true,
            status: response.status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(grantedScopes !== undefined ? { grantedScopes } : {}),
            data: parsed as T,
        };
    } catch (error) {
        // A lifecycle abort (#417) is a cancellation, not a vendor failure:
        // callers must be able to tell "we cut this short" from "the network
        // failed", or an aborted queued send would be recorded as a Slack
        // rejection.
        if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
            return { ok: false, error: 'slack_send_aborted', status: 499 };
        }
        // A network-level throw has no response, so there is no header to read.
        return {
            ok: false,
            error: options.sensitiveResponse ? 'slack_sensitive_request_failed' : redactSlackTokens((error as Error).message),
            status: 502,
        };
    }
}

// ─── Reactions and notice cleanup ────────────────────
// Two Slack quirks these wrappers absorb, both of which produce confusing errors
// when got wrong:
//   1. the emoji NAME goes in WITHOUT colons — the docs' own example is
//      `thumbsup`, and `:thumbsup:` fails with invalid_name;
//   2. reactions.add/remove take `timestamp` while chat.delete/chat.update take
//      `ts`. Same value, different parameter name.

/** `:eyes:` and `eyes` are the same reaction to a human, and different to Slack. */
export function stripEmojiColons(name: string): string {
    return name.replace(/^:+|:+$/g, '');
}

/** `timeoutMs` matters even though these calls are best-effort: without a bound a
 *  hung request outlives the shutdown drain that is waiting on it. */
export type SlackCallOptions = { fetchImpl?: SlackFetch; signal?: AbortSignal; timeoutMs?: number; sensitiveResponse?: boolean; maxResponseBytes?: number };

/** Long enough for a normal Slack round trip, short enough that a shutdown drain
 *  is not held open by one stuck cleanup call. */
export const SLACK_CLEANUP_TIMEOUT_MS = 5000;

function callOptions(
    options: SlackCallOptions,
): SlackCallOptions {
    // exactOptionalPropertyTypes: an explicit undefined is not assignable here,
    // so absent keys rather than undefined values.
    return {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.sensitiveResponse !== undefined ? { sensitiveResponse: options.sensitiveResponse } : {}),
        ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
        timeoutMs: options.timeoutMs ?? SLACK_CLEANUP_TIMEOUT_MS,
    };
}

/** Tier 3 (50+/min). Scope: reactions:write. */
export async function addSlackReaction(
    token: string,
    channel: string,
    timestamp: string,
    name: string,
    options: SlackCallOptions = {},
): Promise<SlackApiResult> {
    return slackApi(token, 'reactions.add',
        { channel, timestamp, name: stripEmojiColons(name) }, callOptions(options));
}

/** Tier 2 (20+/min) — half of reactions.add's budget. Scope: reactions:write. */
export async function removeSlackReaction(
    token: string,
    channel: string,
    timestamp: string,
    name: string,
    options: SlackCallOptions = {},
): Promise<SlackApiResult> {
    return slackApi(token, 'reactions.remove',
        { channel, timestamp, name: stripEmojiColons(name) }, callOptions(options));
}

/**
 * Delete a message this bot posted. Uses `ts`, NOT `timestamp`.
 *
 * A bot token may delete only its own messages, so this needs no ownership check
 * before being called on a notice we posted ourselves. Scope: chat:write.
 */
export async function deleteSlackMessage(
    token: string,
    channel: string,
    ts: string,
    options: SlackCallOptions = {},
): Promise<SlackApiResult> {
    return slackApi(token, 'chat.delete', { channel, ts }, callOptions(options));
}

/**
 * Rewrite a message in place.
 *
 * Used for the timeout/shutdown path, where deleting the queue notice would
 * leave no trace of a turn that never answered. Scope: chat:write.
 */
export async function updateSlackMessage(
    token: string,
    channel: string,
    ts: string,
    text: string,
    options: SlackCallOptions = {},
): Promise<SlackApiResult> {
    return slackApi(token, 'chat.update', { channel, ts, text }, callOptions(options));
}

// ─── Conversation discovery and membership ───────
// A bot token may not read a channel it has not joined: conversations.history
// answers not_in_channel. Listing is different — conversations.list returns
// public channels the bot is NOT in, which is what makes boot-time auto-join
// possible at all. See src/slack/auto-join.ts for the policy that drives these.

/** One row of conversations.list. Every field optional: Slack omits freely. */
export type SlackConversationSummary = {
    id?: string;
    name?: string;
    is_member?: boolean;
    is_archived?: boolean;
    is_private?: boolean;
};

export type SlackConversationListData = {
    channels?: SlackConversationSummary[];
    response_metadata?: { next_cursor?: string };
};

/**
 * Page through workspace conversations. Tier 2 (20+/min) — the slowest budget
 * any of these wrappers carries, so the caller must pace itself.
 *
 * Scope: channels:read for public channels. Returns channels the bot has not
 * joined, with `is_member` telling the two apart.
 *
 * Form-encoded like history/replies: these read methods take their arguments as
 * query-style parameters and a JSON body is not universally accepted.
 */
export async function listSlackConversations(
    token: string,
    params: {
        cursor?: string;
        limit?: number;
        types?: string;
        excludeArchived?: boolean;
    } = {},
    options: SlackCallOptions = {},
): Promise<SlackApiResult<SlackConversationListData>> {
    const body: Record<string, unknown> = {
        limit: params.limit ?? 200,
        types: params.types ?? 'public_channel',
        exclude_archived: params.excludeArchived !== false,
    };
    // Slack rejects an empty cursor string on some methods; omit it entirely
    // for the first page rather than sending an empty cursor parameter.
    if (params.cursor) body['cursor'] = params.cursor;
    return slackApi<SlackConversationListData>(token, 'conversations.list', body, {
        ...callOptions(options),
        form: true,
    });
}

/**
 * Join a PUBLIC channel. Tier 3 (50+/min). Scope: channels:join.
 *
 * Has no effect on private channels — those answer
 * method_not_supported_for_channel_type and can only be entered by invitation.
 * Joining posts a visible "<bot> has joined the channel" line, so this is a
 * user-observable mutation, not a silent read.
 */
export async function joinSlackConversation(
    token: string,
    channel: string,
    options: SlackCallOptions = {},
): Promise<SlackApiResult<{ channel?: { id?: string } }>> {
    return slackApi<{ channel?: { id?: string } }>(
        token, 'conversations.join', { channel }, { ...callOptions(options), form: true },
    );
}
