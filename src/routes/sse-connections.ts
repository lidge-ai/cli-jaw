// ─── Live SSE response registry ─────────────────────
// Every long-lived text/event-stream response registers its cleanup here so a
// graceful shutdown can end the streams before closing the HTTP server. An
// untracked open SSE response counts as an in-flight request and holds
// server.close() open indefinitely (#790).
//
// The registry is process-wide: the core server never drains it, so entries
// registered there are removed only by their own req-close/res-error cleanup
// (same as today). Only the Manager drains the set on shutdown.

const sseCleanups = new Set<() => void>();

// Register the response's idempotent teardown; returns the matching untrack so
// normal close paths do not leak the entry.
export function trackSseConnection(cleanup: () => void): () => void {
    sseCleanups.add(cleanup);
    return () => { sseCleanups.delete(cleanup); };
}

export function closeSseConnections(): number {
    const pending = [...sseCleanups];
    for (const cleanup of pending) {
        // One broken cleanup must not skip the rest of the drain.
        try { cleanup(); } catch { /* keep draining */ }
    }
    return pending.length;
}

export function trackedSseConnectionCount(): number {
    return sseCleanups.size;
}
