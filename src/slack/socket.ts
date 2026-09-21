// ─── Slack Socket Mode Client ────────────────────────
// Protocol (docs.slack.dev/apis/events-api/using-socket-mode):
//   1. POST apps.connections.open with the app-level token -> wss:// URL
//   2. Connect; Slack sends {"type":"hello"} when it is ready
//   3. Each delivery is an envelope; reply {"envelope_id": "<id>"} within 3s
//   4. Slack recycles sockets every few hours and warns ~10s before closing
//
// Design rules this file enforces:
//   - ACK BEFORE WORK. Slack retries un-acked envelopes, so acking after the
//     agent run is how one message becomes three agent runs.
//   - Envelope-id dedupe. Retries carry the same envelope_id.
//   - Frames arriving while NOT connected are left UN-acked on purpose: that
//     is what makes Slack redeliver them on the new socket. Acking then
//     dropping would be permanent message loss.
//   - link_disabled is terminal, not transient: do not reconnect into a wall.
//   - A transient network outage is NOT terminal. The reconnect ceiling is
//     unlimited by default, because a bounded one turns a few minutes of lost
//     connectivity into a permanently deaf bot that only a restart can fix.

import { log } from '../core/logger.js';
import { slackApi, redactSlackTokens, type SlackFetch } from './api.js';

export type SlackConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disabled';

export type SlackEnvelope = {
    envelope_id?: string;
    type: string;
    payload?: Record<string, unknown>;
    accepts_response_payload?: boolean;
    retry_attempt?: number;
    retry_reason?: string;
    reason?: string;
};

const HANDLED_ENVELOPE_TYPES = new Set(['events_api', 'slash_commands', 'interactive']);
const CONTROL_FRAME_TYPES = new Set(['hello', 'disconnect']);

/**
 * Retry dedupe memory. Slack retries an un-acked delivery for a bounded
 * period, so entries expire by TIME rather than by count: a count-only window
 * lets a busy channel evict an id before its retry arrives, which recreates
 * the duplicate-agent-run failure this dedupe exists to prevent.
 */
const DEDUPE_TTL_MS = 10 * 60 * 1000;
/**
 * Soft ceiling that triggers expiry sweeps. It deliberately does NOT evict
 * unexpired ids: dropping one before its retry horizon reopens the duplicate-
 * agent-run hole this map exists to close. Memory stays bounded by the TTL
 * instead — a workspace would have to exceed 30k distinct deliveries within
 * the window to grow past this, and each entry is a short id plus a number.
 */
const DEDUPE_SWEEP_AT = 5000;
/** Slack sends `hello` promptly; without it the socket is not usable. */
export const HELLO_DEADLINE_MS = 15000;
/** Backoff ceiling: one handshake attempt per minute once the socket is down. */
const MAX_RECONNECT_DELAY_MS = 60000;
/**
 * Exponent ceiling for the backoff doubling. The delay is clamped anyway, but
 * an unbounded attempt counter would otherwise compute 2 ** 1000 forever.
 */
const RECONNECT_EXPONENT_CAP = 20;

/**
 * Unlimited unless a caller asks for a bounded client. A long-running server
 * that gives up cannot recover on its own: the process stays healthy, the Web
 * API still sends, and inbound is silently dead until someone restarts it.
 * Tests and one-shot callers can still pass a finite ceiling.
 */
function normalizeReconnectCeiling(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(value);
}

/** Minimal socket surface used here — keeps the module testable without a real WebSocket. */
export type SlackSocketLike = {
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
};

/** What the durable preflight decided about an envelope, before it is acknowledged. */
export type SlackPreflightResult = 'committed' | 'duplicate' | 'ignored';

export type SlackSocketOptions = {
    appToken: string;
    onEnvelope: (envelope: SlackEnvelope) => void | Promise<void>;
    /**
     * Runs BEFORE the ack and must reach durable storage. Returning normally is what
     * permits the ack; throwing withholds it so Slack redelivers on a fresh socket.
     * Absent means the old ack-first behaviour, which is what CLI and test callers get.
     */
    preflightEnvelope?: (envelope: SlackEnvelope) => Promise<SlackPreflightResult>;
    fetchImpl?: SlackFetch;
    /** Injected for tests; defaults to the global WebSocket (Node 22+). */
    socketFactory?: (url: string) => SlackSocketLike;
    /**
     * Finite ceiling after which the client gives up. Omitted, zero, or
     * non-finite means retry until connected, which is what a long-running
     * server needs to survive an outage longer than the fast backoff.
     */
    maxReconnectAttempts?: number;
    baseReconnectDelayMs?: number;
    onStateChange?: (state: SlackConnectionState, meta: { attempts: number }) => void;
};

export class SlackSocketClient {
    private ws: SlackSocketLike | null = null;
    private state: SlackConnectionState = 'disconnected';
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private helloTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set when a reconnect is requested while a connect is already running. */
    private reconnectPending = false;
    private seenEnvelopes = new Map<string, number>();
    private stopped = false;
    private connecting = false;
    private readonly maxReconnectAttempts: number;
    private readonly baseReconnectDelayMs: number;
    private readyWaiters = new Set<(result: 'connected' | 'stopped') => void>();

    constructor(private readonly options: SlackSocketOptions) {
        this.maxReconnectAttempts = normalizeReconnectCeiling(options.maxReconnectAttempts);
        this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
    }

    getState(): SlackConnectionState { return this.state; }
    getReconnectAttempts(): number { return this.reconnectAttempts; }

    waitForReady(timeoutMs = HELLO_DEADLINE_MS + 1000): Promise<'connected' | 'timeout' | 'stopped'> {
        if (this.state === 'connected') return Promise.resolve('connected');
        if (this.stopped) return Promise.resolve('stopped');
        return new Promise(resolve => {
            let settled = false;
            const finish = (result: 'connected' | 'timeout' | 'stopped') => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.readyWaiters.delete(waiter);
                resolve(result);
            };
            const waiter = (result: 'connected' | 'stopped') => finish(result);
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            timer.unref?.();
            this.readyWaiters.add(waiter);
        });
    }

    private setState(state: SlackConnectionState): void {
        this.state = state;
        this.options.onStateChange?.(state, { attempts: this.reconnectAttempts });
        if (state === 'connected') {
            for (const waiter of [...this.readyWaiters]) waiter('connected');
        }
    }

    async start(): Promise<void> {
        this.stopped = false;
        await this.connect();
    }

    /**
     * Stop the client. `terminalState` preserves WHY it stopped so health and
     * diagnostics can distinguish "Socket Mode is off in app settings" from a
     * generic disconnect.
     */
    stop(terminalState: SlackConnectionState = 'disconnected'): void {
        this.stopped = true;
        this.clearReconnectTimer();
        this.clearHelloTimer();
        this.setState(terminalState);
        for (const waiter of [...this.readyWaiters]) waiter('stopped');
        try { this.ws?.close(); } catch { /* already closing */ }
        this.ws = null;
    }

    private clearReconnectTimer(): void {
        // Clearing before scheduling prevents timer leaks on rapid disconnects.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private clearHelloTimer(): void {
        if (this.helloTimer) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
    }

    private defaultSocketFactory(url: string): SlackSocketLike {
        // Node 22+ ships a global WebSocket, which is why this transport needs
        // no SDK.
        const socket = new WebSocket(url);
        return {
            send: (data: string) => socket.send(data),
            close: () => socket.close(),
            addEventListener: (type: string, listener: (event: unknown) => void) =>
                socket.addEventListener(type, listener as EventListener),
        };
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;
        // Single-flight: a second concurrent connect would overwrite this.ws
        // and orphan a live socket against Slack's connection cap.
        if (this.connecting) return;
        this.connecting = true;
        try {
            await this.connectOnce();
        } finally {
            this.connecting = false;
            // A reconnect requested DURING this attempt was deferred so it
            // could not stack; drain it now, or a failed
            // apps.connections.open would stall the transport forever.
            if (this.reconnectPending) {
                this.reconnectPending = false;
                this.scheduleReconnect();
            }
        }
    }

    private async connectOnce(): Promise<void> {
        this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
        // The socket being replaced must stop influencing lifecycle decisions
        // the moment a replacement is under way: its close event would
        // otherwise schedule a second reconnect on top of this one.
        const superseded = this.ws;
        this.ws = null;
        if (superseded) {
            try { superseded.close(); } catch { /* already closing */ }
        }

        const opened = await slackApi<{ url?: string }>(
            this.options.appToken,
            'apps.connections.open',
            undefined,
            this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {},
        );
        const url = opened.data?.url;
        if (!opened.ok || !url) {
            log.warn('[slack:socket] apps.connections.open failed:', opened.error || 'no url');
            this.scheduleReconnect();
            return;
        }

        const factory = this.options.socketFactory ?? ((u: string) => this.defaultSocketFactory(u));
        const ws = factory(url);
        // A stopped client must not adopt a socket that opened while the
        // handshake was in flight.
        if (this.stopped) {
            try { ws.close(); } catch { /* already closing */ }
            return;
        }
        this.ws = ws;

        // Slack signals readiness with `hello`. If it never arrives the socket
        // is useless and inbound would stall forever, because frames are
        // deliberately left un-acked while not connected.
        this.clearHelloTimer();
        this.helloTimer = setTimeout(() => {
            this.helloTimer = null;
            if (this.stopped || this.ws !== ws || this.state === 'connected') return;
            log.warn(`[slack:socket] no hello within ${HELLO_DEADLINE_MS}ms — recycling socket`);
            try { ws.close(); } catch { /* already closing */ }
            this.ws = null;
            this.scheduleReconnect();
        }, HELLO_DEADLINE_MS);

        // Every listener below checks that IT still owns the live socket.
        // Slack recycles sockets, and a superseded socket's late `close` would
        // otherwise schedule an extra reconnect, compounding into a storm of
        // parallel connections.
        const isCurrent = () => this.ws === ws;

        ws.addEventListener('open', () => {
            if (!isCurrent()) return;
            // 'open' means the WS handshake finished, not that Slack accepted
            // us. Slack's readiness signal is the `hello` frame.
            log.info('[slack:socket] websocket open, awaiting hello');
        });
        ws.addEventListener('message', (event: unknown) => {
            if (!isCurrent()) return;
            const data = (event as { data?: unknown })?.data;
            void this.handleFrame(typeof data === 'string' ? data : String(data));
        });
        ws.addEventListener('error', (event: unknown) => {
            if (!isCurrent()) return;
            const message = (event as { message?: unknown })?.message;
            log.warn('[slack:socket] error', redactSlackTokens(String(message ?? 'socket error')));
        });
        ws.addEventListener('close', () => {
            if (!isCurrent() || this.stopped || this.state === 'disabled') return;
            // Detach so a repeated close from this same dead socket cannot
            // schedule a second reconnect.
            this.ws = null;
            this.clearHelloTimer();
            log.info('[slack:socket] closed, scheduling reconnect');
            this.scheduleReconnect();
        });
    }

    private async handleFrame(raw: string): Promise<void> {
        let envelope: SlackEnvelope;
        try {
            envelope = JSON.parse(raw) as SlackEnvelope;
        } catch {
            log.warn('[slack:socket] unparseable frame dropped');
            return;
        }
        if (!envelope || typeof envelope.type !== 'string') return;

        if (CONTROL_FRAME_TYPES.has(envelope.type)) {
            if (envelope.type === 'hello') {
                this.setState('connected');
                this.reconnectAttempts = 0;
                this.clearHelloTimer();
                log.info('[slack:socket] hello received, connected');
                return;
            }
            // 'link_disabled' means Socket Mode was turned off in app settings.
            // Reconnecting would burn attempts against a closed door.
            if (envelope.reason === 'link_disabled') {
                log.warn('[slack:socket] link_disabled — Socket Mode is off in app settings');
                this.stop('disabled');
                return;
            }
            log.info(`[slack:socket] disconnect (${envelope.reason || 'unspecified'}), reconnecting`);
            this.scheduleReconnect();
            return;
        }

        // Reconnect-window guard — BEFORE the ack. Leaving the envelope
        // un-acked is what makes Slack redeliver it on the new connection.
        if (this.state !== 'connected') {
            log.info(`[slack:socket] frame left un-acked while state=${this.state} (Slack will redeliver)`);
            return;
        }

        // An envelope this connection already saw is acked and dropped: the work
        // was done, only our acknowledgement failed to land.
        if (envelope.envelope_id && this.hasSeenEnvelope(envelope.envelope_id)) {
            log.info(`[slack:socket] duplicate envelope ignored (retry_attempt=${envelope.retry_attempt ?? 0})`);
            this.ack(envelope.envelope_id);
            return;
        }

        // Types we never act on are acked immediately, as before, so Slack stops
        // retrying payloads that have nowhere to go.
        if (!HANDLED_ENVELOPE_TYPES.has(envelope.type)) {
            if (envelope.envelope_id && this.ack(envelope.envelope_id)) {
                this.rememberEnvelope(envelope.envelope_id);
            }
            return;
        }

        // Durable preflight BEFORE the ack. Acking first means an envelope whose
        // record never reached disk is one Slack considers delivered: it will not be
        // sent again, and a crash here loses the message with no trace. Withholding
        // the ack turns that into a redelivery instead.
        let preflight: SlackPreflightResult = 'committed';
        if (this.options.preflightEnvelope) {
            try {
                preflight = await this.options.preflightEnvelope(envelope);
            } catch (error) {
                log.error(redactSlackTokens(
                    '[slack:socket] durable preflight failed, withholding ack so Slack redelivers: '
                    + (error as Error).message,
                ));
                this.recycleSocket();
                return;
            }
        }

        if (envelope.envelope_id) {
            if (!this.ack(envelope.envelope_id)) {
                // The ack did not reach Slack, so this delivery WILL be retried. Running
                // the agent now would duplicate that work. Do not remember the id until
                // the ack succeeds, or the retry would be mistaken for completed work.
                log.warn('[slack:socket] ack failed — skipping dispatch, awaiting Slack retry');
                this.recycleSocket();
                return;
            }
            this.rememberEnvelope(envelope.envelope_id);
        }

        // Acked, but already handled on an earlier run: the ack is what Slack was
        // still waiting for, and re-dispatching would repeat the work.
        if (preflight !== 'committed') return;

        try {
            await this.options.onEnvelope(envelope);
        } catch (error) {
            log.error('[slack:socket] handler error', redactSlackTokens((error as Error).message));
        }
    }

    /** @returns true when the ack was handed to the socket successfully. */
    private ack(envelopeId: string): boolean {
        const socket = this.ws;
        if (!socket) return false;
        try {
            socket.send(JSON.stringify({ envelope_id: envelopeId }));
            return true;
        } catch (error) {
            log.warn('[slack:socket] ack failed', (error as Error).message);
            return false;
        }
    }

    /** Drop the current socket and reconnect — used when an ack cannot be sent. */
    private recycleSocket(): void {
        if (this.stopped || this.state === 'disabled') return;
        const socket = this.ws;
        this.ws = null;
        this.clearHelloTimer();
        try { socket?.close(); } catch { /* already closing */ }
        this.scheduleReconnect();
    }

    private hasSeenEnvelope(envelopeId: string): boolean {
        const now = Date.now();
        const seenAt = this.seenEnvelopes.get(envelopeId);
        if (seenAt !== undefined && now - seenAt < DEDUPE_TTL_MS) return true;
        if (seenAt !== undefined) this.seenEnvelopes.delete(envelopeId);
        return false;
    }

    private rememberEnvelope(envelopeId: string): void {
        const now = Date.now();
        this.seenEnvelopes.set(envelopeId, now);
        // Lazy sweep of EXPIRED entries only. Evicting an unexpired id to hit
        // a size target would let a busy workspace reprocess a delayed retry,
        // which is precisely the failure this dedupe prevents.
        if (this.seenEnvelopes.size > DEDUPE_SWEEP_AT) {
            for (const [id, at] of this.seenEnvelopes) {
                if (now - at >= DEDUPE_TTL_MS) this.seenEnvelopes.delete(id);
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.state === 'disabled') return;
        // An already-pending reconnect wins; a second trigger (e.g. a
        // `disconnect` frame immediately followed by `close`) must not stack.
        if (this.reconnectTimer) return;
        // A connect already in flight cannot be stacked on, but the demand
        // must not be dropped either: record it and let connect()'s finally
        // drain it once the attempt settles.
        if (this.connecting) {
            this.reconnectPending = true;
            return;
        }
        if (Number.isFinite(this.maxReconnectAttempts) && this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error(`[slack:socket] max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`);
            this.setState('disconnected');
            return;
        }
        this.clearReconnectTimer();
        const delay = Math.min(
            this.baseReconnectDelayMs * 2 ** Math.min(this.reconnectAttempts, RECONNECT_EXPONENT_CAP),
            MAX_RECONNECT_DELAY_MS,
        );
        this.reconnectAttempts++;
        this.setState('reconnecting');
        log.info(Number.isFinite(this.maxReconnectAttempts)
            ? `[slack:socket] reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
            : `[slack:socket] reconnect in ${delay}ms (attempt ${this.reconnectAttempts}, retrying until connected)`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
}
