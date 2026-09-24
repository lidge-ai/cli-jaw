import type { DashboardLifecycleResult } from './types.js';

export type DashboardShutdownMode = 'full' | 'locked-skip';

export interface DashboardShutdownLifecycle {
    stopAll(mode?: DashboardShutdownMode): Promise<DashboardLifecycleResult[]>;
}

export interface DashboardShutdownPreviewProxy {
    close(): Promise<void>;
}

export interface DashboardShutdownServer {
    close(callback?: (error?: Error) => void): void;
    closeAllConnections?(): void;
}

export interface DashboardShutdownOptions {
    lifecycle: DashboardShutdownLifecycle;
    previewProxy: DashboardShutdownPreviewProxy;
    server: DashboardShutdownServer;
    // Drains Manager-owned SSE responses before server.close() — an open stream
    // is an in-flight request and would otherwise hold close() open (#790).
    closeSseConnections?: () => void;
    serverCloseTimeoutMs?: number;
    exit?: (code: number) => void;
    log?: Pick<Console, 'error' | 'warn'>;
}

const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 5_000;

function closeServer(server: DashboardShutdownServer, timeoutMs: number): Promise<Error | null> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (error: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(error);
        };
        // Stays ref'd so the bound holds even when nothing else keeps the loop
        // alive — a pending close() alone must not stall shutdown forever.
        const timer = setTimeout(() => {
            finish(new Error(`server.close() did not complete within ${timeoutMs}ms`));
        }, timeoutMs);
        server.close(error => finish(error || null));
        // Whatever graceful teardown missed (in-flight requests, untracked
        // streams) is destroyed outright — same policy as the worker shutdown.
        server.closeAllConnections?.();
    });
}

function warnLifecycleFailures(
    results: DashboardLifecycleResult[],
    log: Pick<Console, 'warn'>,
): void {
    for (const result of results) {
        if (result.ok) continue;
        log.warn(`[dashboard] failed to stop managed Jaw on port ${result.port}: ${result.message}`);
    }
}

export function createDashboardShutdown(options: DashboardShutdownOptions): (mode?: DashboardShutdownMode) => Promise<void> {
    const exit = options.exit || ((code: number): never => process.exit(code));
    const log = options.log || console;
    let shutdownPromise: Promise<void> | null = null;

    return async (mode?: DashboardShutdownMode): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            // End Manager-owned SSE responses first — their cleanup clears the
            // bus subscription and heartbeat, and an open stream would hold
            // server.close() open indefinitely (#790).
            try {
                options.closeSseConnections?.();
            } catch (error) {
                log.error(`[dashboard] failed to close SSE connections: ${(error as Error).message}`);
            }

            try {
                if (process.env['CLI_JAW_TEST_MODE'] === '1') {
                    log.warn('[dashboard] test mode: skipping stopAll() to protect running instances');
                } else {
                    const lifecycleResults = await options.lifecycle.stopAll(mode ?? 'locked-skip');
                    warnLifecycleFailures(lifecycleResults, log);
                }
            } catch (error) {
                log.error(`[dashboard] failed to stop managed Jaw instances: ${(error as Error).message}`);
            }

            try {
                await options.previewProxy.close();
            } catch (error) {
                log.error(`[dashboard] failed to close preview proxy: ${(error as Error).message}`);
            }

            const serverError = await closeServer(
                options.server,
                options.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS,
            );
            if (serverError) {
                log.error(`[dashboard] failed to close manager server: ${serverError.message}`);
            }

            exit(0);
        })();

        return shutdownPromise;
    };
}
