// Request-scoped Slack task streams. Final answer delivery has a separate owner.
import { createHash } from 'node:crypto';
import { slackApi, type SlackApiResult, type SlackFetch } from './api.js';
import type { DraftStreamOptions } from '../messaging/draft-stream.js';
import type { RemoteTarget } from '../messaging/types.js';
import { log } from '../core/logger.js';
import { redactOutboundPayload } from '../messaging/redact.js';
import { inc } from '../messaging/metrics.js';
import { t } from '../core/i18n.js';
import {
    createSlackActivity, projectSlackPrintTool,
    type SlackActivitySnapshot, type SlackActivityTool,
    type SlackProgressOutcome, type SlackProgressPhase,
} from './progress-activity.js';

export type { SlackProgressOutcome, SlackProgressPhase } from './progress-activity.js';
const NATIVE_INTERVAL_MS = 1000;
const FALLBACK_INTERVAL_MS = 3200;
/** Consecutive failed live edits before the card stops trying.
 *
 *  Not a cap on updating: a stream that expires mid-job keeps its message and
 *  keeps editing it, which is how a long run stays visible. This bounds the
 *  case where those edits stop landing — a transport that has rejected the same
 *  request three times running is not about to accept the fourth. */
const MAX_CONSECUTIVE_LIVE_FAILURES = 3;
// chat.appendStream is Tier 4 (100+/minute). Reserve at most 90/minute
// across this process's streams sharing one credential, including tool updates.
const APPEND_SPACING_MS = 667;
// Share chat.update pacing per credential across live and terminal edits in this process.
const UPDATE_SPACING_MS = 1100;
const OPERATION_TIMEOUT_MS = 5000;
const MAX_EMBARGO_KEYS = 128;
const embargoes = new Map<string, number>();
let overflowEmbargo = 0;
const UNSUPPORTED = new Set(['unknown_method', 'method_not_supported_for_channel_type', 'channel_type_not_supported']);
const DEFINITE_REJECTION = new Set([
    ...UNSUPPORTED, 'invalid_auth', 'not_authed', 'missing_scope', 'not_in_channel',
    'channel_not_found', 'invalid_arguments', 'invalid_chunks', 'no_permission',
    'not_allowed_token_type', 'ratelimited', 'rate_limited', 'is_archived',
]);

type Ready = { mode: 'native' | 'fallback'; ts: string } | { mode: 'none' | 'ambiguous'; ts: null };
export type SlackProgressHandle = {
    update(text: string): void;
    tool(data: Record<string, unknown>): void;
    projectedTool(entry: SlackActivityTool): void;
    runtimeLiveness(at: number): void;
    phase(value: SlackProgressPhase): void;
    finish(outcome?: SlackProgressOutcome, options?: { reason?: 'merged' | 'removed'; bodyDelivered?: boolean }): Promise<void>;
    ready(): Promise<Ready>;
    abort(): void;
    terminalConfirmed(): boolean;
    ts(): string | null;
};
export type SlackProgressOptions = {
    workflowResponse?: boolean;
    fetchImpl?: SlackFetch;
    draftClock?: Pick<DraftStreamOptions, 'now' | 'setTimer' | 'clearTimer'>;
    recipientUserId?: string;
    locale?: string;
    initialPhase?: 'queued' | 'running';
    workingDir?: string;
    signal?: AbortSignal;
    onPosted?: (ts: string) => void;
};

function embargoUntil(key: string, now: number): number {
    for (const [entry, until] of embargoes) if (until <= now) embargoes.delete(entry);
    if (overflowEmbargo <= now) overflowEmbargo = 0;
    return Math.max(embargoes.get(key) ?? 0, overflowEmbargo);
}
function rememberEmbargo(key: string, result: SlackApiResult, now: number): void {
    if (!result.retryAfterMs || !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0) return;
    if (result.status !== 429 && result.error !== 'ratelimited' && result.error !== 'rate_limited') return;
    extendEmbargo(key, now + result.retryAfterMs, now);
}
function extendEmbargo(key: string, until: number, now: number): void {
    embargoUntil(key, now);
    if (embargoes.has(key) || embargoes.size < MAX_EMBARGO_KEYS) {
        embargoes.set(key, Math.max(embargoes.get(key) ?? 0, until));
    } else overflowEmbargo = Math.max(overflowEmbargo, until);
}
function chunks(snapshot: SlackActivitySnapshot): Record<string, unknown>[] {
    return [
        { type: 'plan_update', title: snapshot.title },
        { type: 'task_update', id: 'work', title: snapshot.summary, status: snapshot.workStatus },
        ...snapshot.activities.map((activity, index) => ({ type: 'task_update', id: `recent-${index}`,
            title: activity.title, status: activity.status })),
        ...(snapshot.delivery ? [{ type: 'task_update', id: 'delivery',
            title: snapshot.delivery.title, status: snapshot.delivery.status }] : []),
    ];
}
function fallbackBody(snapshot: SlackActivitySnapshot): Record<string, unknown> {
    return { text: snapshot.text, blocks: [{ type: 'section',
        text: { type: 'plain_text', text: snapshot.text } }] };
}

/** Kept for callers of the old helper; raw detail is no longer a display input. */
export function sanitizeProgressDetail(_detail: string): string { return ''; }
export function truncateStatus(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length <= 140 ? line : `${line.slice(0, 139)}…`;
}
export function statusFromToolEvent(data: Record<string, unknown>, _fallback: string): string | null {
    const entry = projectSlackPrintTool(data);
    return entry ? t(`slack.progress.category.${entry.category}`) : null;
}

export async function startSlackProgress(
    token: string, target: RemoteTarget, _initialText: string,
    options: SlackProgressOptions = {},
): Promise<SlackProgressHandle> {
    const address = { ...target };
    const recipient = options.recipientUserId;
    const workingDir = options.workingDir;
    const now = options.draftClock?.now ?? Date.now;
    const setTimer = options.draftClock?.setTimer ?? setTimeout;
    const clearTimer = options.draftClock?.clearTimer ?? clearTimeout;
    const model = createSlackActivity(now, options.locale ?? 'ko', options.initialPhase ?? 'running', options.workflowResponse === true);
    const controller = new AbortController();
    const updateWait = new AbortController();
    const parentSignal = options.signal;
    const fetchImpl = options.fetchImpl;
    const onPosted = options.onPosted;
    const abortParent = () => abortProgress();
    const credential = createHash('sha256').update(token).digest('hex');
    const bucket = (method: string) => `${credential}:${method}`;
    let state: Ready = { mode: 'none', ts: null };
    let closed = false;
    let remoteEnded = false;
    // A status card whose message is gone: Slack will refuse every later edit
    // for the same reason, so there is nothing left to try.
    let messageGone = false;
    let consecutiveLiveFailures = 0;
    let confirmed = false;
    let dirty = false;
    let lastAttemptAt = -Infinity;
    let lastSignature = '';
    let lastSnapshot: SlackActivitySnapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let terminal: Promise<void> | null = null;

    function useMessageUpdates(): void {
        if (state.mode !== 'native') return;
        // Slack may expire a stream while the job continues. Keep its known
        // message identity; edit that message, never post a replacement.
        state = { mode: 'fallback', ts: state.ts };
        lastSignature = '';
        lastSnapshot = null;
        dirty = true;
    }

    const clearScheduled = () => {
        if (timer) clearTimer(timer);
        if (idleTimer) clearTimer(idleTimer);
        timer = idleTimer = null;
    };

    /** Stop live updating this card, once, for a stated reason.
     *
     *  The idle loop re-dirtied the snapshot every 3.2s and `schedule()` sent it
     *  again, so a card whose message had been deleted produced 47 consecutive
     *  `chat.update` → `message_not_found` calls over two and a half minutes and
     *  would have kept going for the life of the job (#744). Ending the live loop
     *  is the whole fix: the card freezes at its last known state, which is
     *  honest, and the answer still arrives by its own path. */
    function endLive(reason: string, gone: boolean): void {
        if (remoteEnded) return;
        if (gone) messageGone = true;
        remoteEnded = true;
        clearScheduled();
        inc('slack.progress.stream_state_lost', { channel: 'slack', result: reason });
    }
    function abortProgress(): void {
        closed = true;
        clearScheduled();
        controller.abort();
        parentSignal?.removeEventListener('abort', abortParent);
    }
    parentSignal?.addEventListener('abort', abortParent, { once: true });
    if (parentSignal?.aborted) abortProgress();
    const wait = (ms: number, dispatchSignal?: AbortSignal): Promise<void> => new Promise(resolve => {
        if (controller.signal.aborted || dispatchSignal?.aborted) { resolve(); return; }
        const done = () => {
            clearTimer(handle);
            controller.signal.removeEventListener('abort', done);
            dispatchSignal?.removeEventListener('abort', done);
            resolve();
        };
        const handle = setTimer(done, ms);
        controller.signal.addEventListener('abort', done, { once: true });
        dispatchSignal?.addEventListener('abort', done, { once: true });
    });
    async function call(method: string, body: Record<string, unknown> | (() => Record<string, unknown>), deadline: number,
        canDispatch: () => boolean = () => true, dispatchSignal?: AbortSignal): Promise<{
        result: SlackApiResult; attempted: boolean;
    }> {
        while (!controller.signal.aborted && !dispatchSignal?.aborted) {
            const delay = Math.max(0, embargoUntil(bucket(method), now()) - now());
            if (!delay) break;
            if (delay >= deadline - now()) return { result: { ok: false, error: 'progress_backoff' }, attempted: false };
            await wait(delay, dispatchSignal);
        }
        const remaining = Math.min(OPERATION_TIMEOUT_MS, deadline - now());
        if (controller.signal.aborted || dispatchSignal?.aborted || remaining <= 0 || !canDispatch()) {
            return { result: { ok: false, error: 'slack_send_aborted' }, attempted: false };
        }
        if (method === 'chat.appendStream') extendEmbargo(bucket(method), now() + APPEND_SPACING_MS, now());
        if (method === 'chat.update') extendEmbargo(bucket(method), now() + UPDATE_SPACING_MS, now());
        const request = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let cancel: () => void = () => {};
        const cancelled = new Promise<SlackApiResult>(resolve => {
            cancel = () => { request.abort(); resolve({ ok: false, error: 'slack_send_aborted', status: 499 }); };
            timeout = setTimer(cancel, remaining);
            controller.signal.addEventListener('abort', cancel, { once: true });
        });
        try {
            if (controller.signal.aborted) cancel();
            const operation = slackApi(token, method, typeof body === 'function' ? body() : body, {
                ...(fetchImpl ? { fetchImpl } : {}),
                signal: request.signal, timeoutMs: remaining,
            });
            const result = await Promise.race([operation, cancelled]);
            rememberEmbargo(bucket(method), result, now());
            if (!result.ok) log.warn('[slack:progress]', redactOutboundPayload({ method, outcome: result.status === 429 ? 'rate_limited' : 'unconfirmed' }));
            return { result, attempted: true };
        } finally {
            if (timeout) clearTimer(timeout);
            controller.signal.removeEventListener('abort', cancel);
        }
    }
    function schedule(): void {
        if (closed || remoteEnded || !dirty || !state.ts || timer || inFlight) return;
        const method = state.mode === 'native' ? 'chat.appendStream' : 'chat.update';
        const interval = state.mode === 'native' ? NATIVE_INTERVAL_MS : FALLBACK_INTERVAL_MS;
        const delay = Math.max(0, lastAttemptAt + interval - now(), embargoUntil(bucket(method), now()) - now());
        timer = setTimer(() => {
            timer = null;
            if (closed || remoteEnded) return;
            inFlight = flush().catch(() => { log.warn('[slack:progress] update failed'); });
            void inFlight.finally(() => { inFlight = null; schedule(); });
        }, Math.min(delay, 60000));
        timer.unref?.();
    }
    async function flush(): Promise<void> {
        if (!state.ts || closed || remoteEnded) return;
        let snapshot = model.snapshot();
        let signature = JSON.stringify(snapshot);
        dirty = false;
        if (signature === lastSignature) return;
        const method = state.mode === 'native' ? 'chat.appendStream' : 'chat.update';
        const response = await call(method, () => {
            // Shared throttling/Retry-After may have waited. Serialize current time
            // and latest tool state only once we can actually send them.
            snapshot = model.snapshot();
            signature = JSON.stringify(snapshot);
            lastAttemptAt = now();
            const previous = new Set(lastSnapshot ? chunks(lastSnapshot).map(chunk => JSON.stringify(chunk)) : []);
            const body = state.mode === 'native'
                ? { chunks: chunks(snapshot).filter(chunk => !previous.has(JSON.stringify(chunk))) }
                : fallbackBody(snapshot);
            return { channel: address.targetId, ts: state.ts, ...body };
        }, now() + OPERATION_TIMEOUT_MS,
            () => !closed && !remoteEnded, updateWait.signal);
        if (!response.attempted) { dirty = true; return; }
        if (response.result.ok) { lastSignature = signature; lastSnapshot = snapshot; }
        if (response.result.status === 429 || response.result.error === 'ratelimited' || response.result.error === 'rate_limited') dirty = true;
        const error = response.result.error ?? '';
        if (response.result.ok) consecutiveLiveFailures = 0;
        // The message itself is unreachable. Retrying cannot bring it back, and
        // posting a replacement would put a second status card in the thread.
        if (error === 'message_not_found' || error === 'cant_update_message') {
            endLive(error, true);
            return;
        }
        if (error === 'stopped_by_user') { endLive(error, false); return; }
        if (method === 'chat.appendStream' && error === 'message_not_in_streaming_state') {
            // Slack expires a stream while a long job continues. Keep the message
            // this stream already owns and edit it from here on, so the card stays
            // current instead of freezing at the five-minute mark.
            useMessageUpdates();
            return;
        }
        // A rate limit is a "later", not a "no": the embargo already spaces it out
        // and `dirty` was set above so the same content is retried.
        if (!response.result.ok && response.result.status !== 429
            && error !== 'ratelimited' && error !== 'rate_limited') {
            if (++consecutiveLiveFailures >= MAX_CONSECUTIVE_LIVE_FAILURES) {
                endLive(error || 'repeated_update_failure', false);
            }
        }
    }
    function startIdle(): void {
        if (closed || remoteEnded || !state.ts) return;
        idleTimer = setTimer(() => {
            idleTimer = null;
            // The flag can be raised while this timer is pending.
            if (closed || remoteEnded) return;
            dirty = true;
            schedule();
            startIdle();
        }, state.mode === 'native' ? NATIVE_INTERVAL_MS : FALLBACK_INTERVAL_MS);
        idleTimer.unref?.();
    }
    async function begin(): Promise<Ready> {
        const direct = address.targetId.startsWith('D');
        if (!address.threadId || (!direct && (!recipient || !address.guildId)) || controller.signal.aborted) return state;
        const deadline = now() + OPERATION_TIMEOUT_MS;
        let snapshot = model.snapshot();
        const first = await call('chat.startStream', () => {
            snapshot = model.snapshot();
            return {
            channel: address.targetId, thread_ts: address.threadId, task_display_mode: 'plan',
            chunks: chunks(snapshot),
            ...(!direct ? { recipient_user_id: recipient, recipient_team_id: address.guildId } : {}),
            };
        }, deadline);
        let response = first;
        let mode: 'native' | 'fallback' = 'native';
        if (!first.result.ok && UNSUPPORTED.has(first.result.error ?? '') && !controller.signal.aborted) {
            mode = 'fallback';
            response = await call('chat.postMessage', () => {
                snapshot = model.snapshot();
                return { channel: address.targetId, thread_ts: address.threadId, ...fallbackBody(snapshot) };
            }, deadline);
        }
        const ts = response.result.data?.['ts'];
        if (response.result.ok && typeof ts === 'string' && ts) {
            state = { mode, ts };
            lastSignature = JSON.stringify(snapshot);
            lastSnapshot = snapshot;
            try { onPosted?.(ts); } catch { log.warn('[slack:progress] receipt callback failed'); }
            if (!closed) { dirty = true; schedule(); startIdle(); }
        } else {
            const definite = !response.attempted || DEFINITE_REJECTION.has(response.result.error ?? '') || response.result.status === 429;
            state = { mode: definite ? 'none' : 'ambiguous', ts: null };
        }
        return state;
    }
    const ready = begin().catch((): Ready => {
        log.warn('[slack:progress] startup failed');
        state = { mode: 'ambiguous', ts: null };
        return state;
    });
    function projectedTool(entry: SlackActivityTool): void {
        if (!closed && model.tool(entry)) { dirty = true; schedule(); }
    }
    return {
        update(text) {
            const entry = projectSlackPrintTool({ label: text, toolType: 'tool' });
            if (entry) projectedTool(entry);
        },
        tool(data) { const entry = projectSlackPrintTool(data, workingDir); if (entry) projectedTool(entry); },
        projectedTool,
        runtimeLiveness(at) { if (!closed && model.runtimeLiveness(at)) { dirty = true; schedule(); } },
        phase(value) { if (!closed && model.phase(value)) { dirty = true; schedule(); } },
        ready: async () => { await ready; return state; },
        ts: () => state.ts,
        terminalConfirmed: () => confirmed,
        abort: abortProgress,
        finish(outcome = 'complete', finishOptions = {}) {
            if (terminal) return terminal;
            closed = true;
            clearScheduled();
            updateWait.abort();
            model.finish(outcome, finishOptions.reason, finishOptions.bodyDelivered);
            const deadline = now() + OPERATION_TIMEOUT_MS;
            const finishTimer = setTimer(() => controller.abort(), OPERATION_TIMEOUT_MS);
            terminal = (async () => {
                try {
                    await ready;
                    await inFlight;
                    if (!state.ts || controller.signal.aborted) return;
                    // A card whose message is gone takes no terminal edit either.
                    // `message_not_found` already counted as confirmation before;
                    // the difference now is that no request is spent proving it.
                    if (messageGone) { confirmed = true; return; }
                    const snapshot = model.snapshot();
                    let response = await call(state.mode === 'native' ? 'chat.stopStream' : 'chat.update', {
                        channel: address.targetId, ts: state.ts,
                        ...(state.mode === 'native' ? { chunks: chunks(snapshot) } : fallbackBody(snapshot)),
                    }, deadline);
                    if (state.mode === 'native' && response.result.error === 'message_not_in_streaming_state') {
                        useMessageUpdates();
                        response = await call('chat.update', {
                            channel: address.targetId, ts: state.ts, ...fallbackBody(snapshot),
                        }, deadline);
                    }
                    confirmed = response.result.ok || response.result.error === 'message_not_found';
                } catch { log.warn('[slack:progress] terminal update failed'); }
                finally {
                    clearTimer(finishTimer);
                    parentSignal?.removeEventListener('abort', abortParent);
                }
            })();
            return terminal;
        },
    };
}
