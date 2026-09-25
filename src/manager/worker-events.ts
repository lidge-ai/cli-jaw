// ─── Worker Event Bridge (subscriptions + message cache) ──
// P4-full of runtime SSE refactoring.
// Owns the manager-side lifecycle of worker SSE subscriptions, driven by
// InstanceRegistry diffs on the event-bus ('worker' topic, Phase 4a):
//   appeared / status→online  → subscribe
//   disappeared / status→offline → unsubscribe + invalidate cache
//   version changed → clear the unsupported mark and resubscribe
//   terminal transient disconnect while the latest snapshot is online →
//   one bounded-backoff reconnect, generation-fenced per port (#791)
// On message/agent activity it prefetches the worker's latest-message
// payload once (debounced), so jaw-ceo reads are served from cache while
// the stream is live. Cache misses fall back to the caller's HTTP path.

import { subscribe as subscribeBus, publish } from '../core/event-bus.js';
import { internalFetch } from './internal-fetch.js';
import {
    subscribeToWorker,
    type EventSourceCtor,
    type WorkerEventHandlers,
} from './worker-sse-client.js';
import type { InstanceDiff } from './instance-registry.js';

export const PREFETCH_DEBOUNCE_MS = 250;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Shape of GET /api/messages/latest?includeContent=1 → body.data */
export type WorkerLatestData = {
    latestAssistant?: { id?: number; role?: string; created_at?: string; text?: string; content?: string } | null;
    activity?: { messageId?: number; role?: string; title?: string; updatedAt?: string } | null;
} | null;

type MinimalFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface WorkerEventBridgeDeps {
    fetchImpl?: MinimalFetch;
    EventSourceImpl?: EventSourceCtor;
    debounceMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
}

type BridgeState = {
    deps: Required<Pick<WorkerEventBridgeDeps, 'fetchImpl' | 'debounceMs' | 'reconnectBaseMs' | 'reconnectMaxMs'>> & Pick<WorkerEventBridgeDeps, 'EventSourceImpl'>;
    unsubBus: () => void;
    conns: Map<number, () => void>;
    unsupported: Set<number>;
    cache: Map<number, WorkerLatestData>;
    timers: Map<number, ReturnType<typeof setTimeout>>;
    /** Bumped per connect() — fences a pending reconnect timer to the
     *  generation that scheduled it, so a stale timer never replaces a
     *  newer connection for the same port. */
    connGen: Map<number, number>;
    /** Consecutive terminal disconnects — resets on any registry diff or
     *  live-stream evidence; drives the bounded reconnect backoff. */
    connFailures: Map<number, number>;
    /** Pending delayed reconnect per port (at most one). */
    retry: Map<number, { timer: ReturnType<typeof setTimeout>; gen: number }>;
    /** Latest registry status seen per port — the bridge's snapshot proxy.
     *  A stable-online worker emits no diffs, so this is what a terminal
     *  disconnect consults before scheduling a reconnect. */
    knownStatus: Map<number, string>;
};

let state: BridgeState | null = null;

function schedulePrefetch(s: BridgeState, port: number): void {
    const existing = s.timers.get(port);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        s.timers.delete(port);
        void (async () => {
            try {
                const res = await s.deps.fetchImpl(`http://127.0.0.1:${port}/api/messages/latest?includeContent=1`);
                // A drop() may have raced this in-flight fetch — a late cache.set
                // would resurrect pre-disconnect data and get served as a hit
                // after the next reconnect. Only live streams may populate.
                if (!s.conns.has(port)) return;
                if (!res.ok) { s.cache.delete(port); return; }
                const body = await res.json() as { data?: WorkerLatestData };
                s.cache.set(port, body?.data ?? null);
            } catch {
                s.cache.delete(port); // stale-cache risk > refetch cost — miss falls back to HTTP
            }
        })();
    }, s.deps.debounceMs);
    timer.unref?.();
    s.timers.set(port, timer);
}

function connect(s: BridgeState, port: number): void {
    if (s.conns.has(port) || s.unsupported.has(port)) return;
    s.connGen.set(port, (s.connGen.get(port) ?? 0) + 1);
    // Any live-stream event proves the connection works — reset the
    // consecutive-failure count that grows the reconnect backoff.
    const markLive = () => s.connFailures.delete(port);
    const handlers: WorkerEventHandlers = {
        onMessage: () => { markLive(); schedulePrefetch(s, port); },
        onAgentDone: () => { markLive(); schedulePrefetch(s, port); },
        // Internal eventsource reconnect: agent_done/new_message pings during
        // the gap were lost (ping-style client, no replay) — refresh the
        // latest-message cache so jaw-ceo reads don't serve pre-gap data.
        onReopen: () => { markLive(); schedulePrefetch(s, port); },
        // #233: worker cli/model/projectDirs changed — relay to the manager UI
        // (the /api/manager/events/stream route forwards this bus event).
        onSettingsChange: (p, data) => {
            s.connFailures.delete(p);
            publish('worker', 'worker_settings_change', {
                port: p,
                changedKeys: data["changedKeys"] ?? null,
            });
        },
        onUnsupported: () => { s.unsupported.add(port); drop(s, port); },
        onDisconnect: () => { drop(s, port); scheduleReconnect(s, port); },
    };
    const unsub = s.deps.EventSourceImpl
        ? subscribeToWorker(port, handlers, s.deps.EventSourceImpl)
        : subscribeToWorker(port, handlers);
    s.conns.set(port, unsub);
    // Hydrate the cache once on connect so the first jaw-ceo read hits.
    schedulePrefetch(s, port);
}

function drop(s: BridgeState, port: number): void {
    const unsub = s.conns.get(port);
    s.conns.delete(port);
    unsub?.();
    const timer = s.timers.get(port);
    if (timer) { clearTimeout(timer); s.timers.delete(port); }
    cancelRetry(s, port);
    s.cache.delete(port);
}

function cancelRetry(s: BridgeState, port: number): void {
    const pending = s.retry.get(port);
    if (!pending) return;
    clearTimeout(pending.timer);
    s.retry.delete(port);
}

// #791: eventsource@3 treats every non-2xx as terminal (e.g. the /api/events
// 256-connection capacity 503) — the bridge used to drop the stream and wait
// for a diff that a stable-online worker never emits. Schedule exactly one
// delayed reconnect per disconnect while the latest registry snapshot is
// still online; consecutive failures widen the delay up to a cap, and the
// timer is fenced to the dead connection's generation.
function scheduleReconnect(s: BridgeState, port: number): void {
    if (s.knownStatus.get(port) !== 'online' || s.unsupported.has(port)) return;
    cancelRetry(s, port);
    const attempt = s.connFailures.get(port) ?? 0;
    s.connFailures.set(port, attempt + 1);
    const gen = s.connGen.get(port) ?? 0;
    const delay = Math.min(s.deps.reconnectBaseMs * 2 ** attempt, s.deps.reconnectMaxMs);
    const timer = setTimeout(() => {
        s.retry.delete(port);
        if (s.connGen.get(port) !== gen || s.conns.has(port)) return;
        if (s.knownStatus.get(port) !== 'online' || s.unsupported.has(port)) return;
        connect(s, port);
    }, delay);
    timer.unref?.();
    s.retry.set(port, { timer, gen });
}

function onDiff(s: BridgeState, diff: InstanceDiff): void {
    // Every registry transition is a new epoch for the port: refresh the
    // status snapshot the reconnect scheduler consults and reset its
    // terminal-failure budget.
    s.connFailures.delete(diff.port);
    if (diff.change === 'disappeared') {
        s.knownStatus.delete(diff.port);
        s.connGen.delete(diff.port);
        drop(s, diff.port);
        return;
    }
    if (diff.next) s.knownStatus.set(diff.port, diff.next.status);
    if (diff.change === 'version') {
        // Worker restarted onto a different build — a legacy worker may now
        // support SSE. Clear the permanent mark and try again if online.
        s.unsupported.delete(diff.port);
        drop(s, diff.port);
        if (diff.next?.status === 'online') connect(s, diff.port);
        return;
    }
    const online = diff.next?.status === 'online';
    if (diff.change === 'appeared' && online) { s.unsupported.delete(diff.port); connect(s, diff.port); return; }
    if (diff.change === 'status') {
        if (online) {
            // The realistic upgrade flow (stop legacy → start new build) shows up
            // as two 'status' diffs with the version change swallowed (offline
            // rows carry version:null, and computeDiffs prefers status) — so a
            // 'version' diff may never fire. Any transition back to online means
            // the worker process restarted: retire the unsupported mark and
            // re-probe ONCE. A stable worker emits no diffs, so a legacy worker
            // costs exactly one 404 per restart — not a retry loop.
            s.unsupported.delete(diff.port);
            connect(s, diff.port);
        } else {
            drop(s, diff.port);
        }
    }
}

export function startWorkerEventBridge(deps: WorkerEventBridgeDeps = {}): void {
    if (state) return;
    const s: BridgeState = {
        deps: {
            fetchImpl: deps.fetchImpl ?? internalFetch,
            debounceMs: deps.debounceMs ?? PREFETCH_DEBOUNCE_MS,
            reconnectBaseMs: deps.reconnectBaseMs ?? RECONNECT_BASE_DELAY_MS,
            reconnectMaxMs: deps.reconnectMaxMs ?? RECONNECT_MAX_DELAY_MS,
            ...(deps.EventSourceImpl ? { EventSourceImpl: deps.EventSourceImpl } : {}),
        },
        unsubBus: () => { },
        conns: new Map(),
        unsupported: new Set(),
        cache: new Map(),
        timers: new Map(),
        connGen: new Map(),
        connFailures: new Map(),
        retry: new Map(),
        knownStatus: new Map(),
    };
    s.unsubBus = subscribeBus((entry) => {
        if (entry.topic !== 'worker' || entry.event !== 'instance-status-changed') return;
        onDiff(s, entry.data as unknown as InstanceDiff);
    });
    state = s;
}

export function stopWorkerEventBridge(): void {
    if (!state) return;
    const s = state;
    state = null;
    s.unsubBus();
    for (const port of [...s.conns.keys()]) drop(s, port);
    for (const timer of s.timers.values()) clearTimeout(timer);
    s.timers.clear();
    for (const pending of s.retry.values()) clearTimeout(pending.timer);
    s.retry.clear();
    s.connGen.clear();
    s.connFailures.clear();
    s.knownStatus.clear();
    s.cache.clear();
    s.unsupported.clear();
}

/** Cache read for jaw-ceo's fetchLatestMessage. `undefined` = no live
 *  stream / no data yet → caller must use its HTTP path. A `null` hit is
 *  a real answer ("worker has no messages"). */
export function getCachedLatestMessage(port: number): WorkerLatestData | undefined {
    if (!state || !state.conns.has(port)) return undefined;
    return state.cache.has(port) ? state.cache.get(port)! : undefined;
}
