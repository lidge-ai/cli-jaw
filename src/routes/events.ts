// ─── GET /api/events — multiplexed SSE event stream ──
// data-only wire format: no `event:` SSE field —
// topic + event travel inside the JSON payload so client onmessage fires.

import type { Router, Request, Response, RequestHandler } from 'express';
import {
    subscribe, replaySince, hasReplayGap, currentSeq,
    MAX_SSE_LISTENERS, isPublicSseTopic, setDeliveryKeyResolver, type BusEvent,
} from '../core/event-bus.js';
import { deliveryKeyForEntry, shouldDeliverToScope } from '../core/event-scope.js';
import { trackSseConnection } from './sse-connections.js';

const HEARTBEAT_MS = 15_000;
let activeConnections = 0;

// Close a client whose Node send buffer grows past this many bytes — a stalled
// reader otherwise makes res.write() buffer frames in memory without bound
// (260628 phase 10 SSE safety). 1 MB is large enough that a brief network stall
// on a healthy client never trips it; only a truly stuck reader does.
export const SSE_MAX_BUFFER_BYTES = 1_000_000;

let droppedInternalTopicEvents = 0;
let slowClientClosed = 0;
let replayGapCount = 0;

export function getActiveSseConnections(): number { return activeConnections; }

export function getSseMetrics(): {
    activeConnections: number;
    droppedInternalTopicEvents: number;
    slowClientClosed: number;
    replayGapCount: number;
} {
    return { activeConnections, droppedInternalTopicEvents, slowClientClosed, replayGapCount };
}

// Pure helper so backpressure policy is unit-testable without a live socket.
export function exceedsBackpressureLimit(writableLength: number, limit = SSE_MAX_BUFFER_BYTES): boolean {
    return writableLength > limit;
}

function formatSse(entry: BusEvent, replay = false): string {
    return `id: ${entry.id}\ndata: ${JSON.stringify({ ...entry.data, topic: entry.topic, event: entry.event, ...(replay ? { sseReplay: true } : {}) })}\n\n`;
}

function parseLastEventId(req: Request): number {
    const header = req.headers['last-event-id'];
    const query = req.query['lastEventId'];
    const raw = typeof header === 'string' ? header
        : typeof query === 'string' ? query : '';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function registerEventsRoutes(app: Router, requireAuth: RequestHandler): void {
    // Both the core server and the manager call this, so every process that serves SSE
    // teaches the bus how deliveries are classified before it can evict anything.
    setDeliveryKeyResolver(deliveryKeyForEntry);

    app.get('/api/events', requireAuth, (req: Request, res: Response) => {
        const scopeFilter = typeof req.query['scope'] === 'string' ? req.query['scope'] : undefined;
        if (activeConnections >= MAX_SSE_LISTENERS) {
            res.status(503).json({ error: 'SSE_CAPACITY' });
            return;
        }
        activeConnections++;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
        });
        // Flush headers immediately — without a first write the client's
        // fetch/EventSource would hang until the 15s heartbeat.
        res.write(': connected\n\n');

        // Replay missed events (Last-Event-ID header or ?lastEventId= query).
        // A cursor AHEAD of the current seq means the client kept a lastEventId
        // from a previous server process (ids reset to 0 on restart) — without
        // the explicit gap signal it would be treated as "caught up" and every
        // event since the restart would be silently lost.
        const lastId = parseLastEventId(req);
        if (lastId > 0) {
            if (lastId > currentSeq() || hasReplayGap(lastId, scopeFilter)) {
                replayGapCount++;
                res.write(`data: ${JSON.stringify({ topic: 'system', event: 'replay_gap' })}\n\n`);
            }
            // Filter internal topics on replay too (defense in depth: the ring
            // could hold a trace entry from a future/mistaken publisher).
            for (const entry of replaySince(lastId)) {
                if (!isPublicSseTopic(entry.topic)) { droppedInternalTopicEvents++; continue; }
                if (!shouldDeliverToScope(entry, scopeFilter)) continue;
                res.write(formatSse(entry, true));
            }
        }

        // close fires on both req and res for the same teardown — guard so
        // activeConnections is decremented exactly once per connection. Declared
        // before subscribe() because the backpressure close path below calls it.
        let closed = false;
        let hb: ReturnType<typeof setInterval> | undefined;
        let unsub: (() => void) | undefined;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            untrack();
            unsub?.();
            if (hb) clearInterval(hb);
            activeConnections--;
            if (!res.writableEnded) res.end();
        };
        // Tracked so shutdown can end the stream before server.close() (#790).
        const untrack = trackSseConnection(cleanup);

        // Live delivery — enforce the public-topic allowlist so internal topics
        // (e.g. `trace`) never serialize out, and apply bounded backpressure so a
        // stalled client cannot grow the send buffer without limit.
        unsub = subscribe((entry) => {
            if (res.writableEnded) return;
            if (!isPublicSseTopic(entry.topic)) { droppedInternalTopicEvents++; return; }
            if (!shouldDeliverToScope(entry, scopeFilter)) return;
            res.write(formatSse(entry));
            if (exceedsBackpressureLimit(res.writableLength)) {
                slowClientClosed++;
                cleanup();
            }
        });

        // Keep-alive ping. A DATA event, not an SSE comment: comments are
        // invisible to client JS, so a silently dead socket (sleep, network
        // change, proxy restart) was indistinguishable from a quiet healthy
        // channel. The client staleness watchdog keys off this event
        // (260613 doc 40). No id: pings must not advance lastEventId.
        hb = setInterval(() => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify({ topic: 'system', event: 'ping' })}\n\n`);
        }, HEARTBEAT_MS);
        hb.unref();

        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
    });
}
