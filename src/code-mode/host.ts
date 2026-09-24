import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { publish } from '../core/event-bus.js';
import { CodeSessionManager } from './manager.js';
import { createCodeProviders } from './providers/catalog.js';
import { primeProviderLiveModels } from './providers/provider-live-models.js';
import { CodeStore } from './store.js';
import type { CodeProviders } from './provider.js';

export interface CodeHostOptions {
    home: string;
    role: 'worker' | 'manager';
    port: number | (() => number);
    maxConcurrentSessions?: number;
    idleReapMs?: number;
    providers?: CodeProviders;
    /** Live-model inventory filler; defaults to the shared provider probe.
     *  Resolving `false` (or rejecting) means the inventory came back incomplete. */
    primeLiveModels?: () => Promise<boolean | void>;
    /** Delay before the single follow-up probe after an incomplete prime. */
    primeRetryMs?: number;
}

const PRIME_RETRY_MS = 300_000;

/** No database, recovery or native runtime is opened until the service is used. */
export function createCodeHost(options: CodeHostOptions): { get(): CodeSessionManager; prime(): Promise<void>; dispose(): Promise<void> } {
    let database: SqliteDatabase | undefined;
    let manager: CodeSessionManager | undefined;
    let disposal: Promise<void> | undefined;
    let primed: Promise<void> | undefined;
    let primeRetry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const probe = options.primeLiveModels ?? primeProviderLiveModels;
    return {
        get() {
            if (closed) throw Object.assign(new Error('Code host is closed'), { code: 'code_host_closed', statusCode: 503 });
            if (manager) return manager;
            const port = typeof options.port === 'function' ? options.port() : options.port;
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Code host port');
            mkdirSync(options.home, { recursive: true, mode: 0o700 });
            const candidate = new Database(join(options.home, `code-${options.role}-${port}.sqlite`));
            try {
                candidate.pragma('journal_mode = WAL');
                candidate.pragma('busy_timeout = 5000');
                candidate.pragma('foreign_keys = ON');
                const service = new CodeSessionManager({
                    store: new CodeStore(candidate),
                    providers: options.providers ?? createCodeProviders(),
                    publish: event => { publish('code', event.event, { ...event }); },
                    ...(options.maxConcurrentSessions === undefined ? {} : { maxConcurrentSessions: options.maxConcurrentSessions }),
                    ...(options.idleReapMs === undefined ? {} : { idleReapMs: options.idleReapMs }),
                });
                service.recover();
                database = candidate;
                manager = service;
                return service;
            } catch (error) {
                candidate.close();
                throw error;
            }
        },
        /**
         * Fill the Cursor and Grok snapshots once per host. This is the ONLY
         * owner allowed to start provider inventory: those probes spawn a CLI,
         * and a catalog read must never do that — so get() does not call this.
         * The explicit caller is server startup. Failure is silent by design —
         * the static registry list stands. An incomplete first pass schedules
         * exactly one delayed follow-up so a CLI installed after boot is found.
         */
        prime() {
            if (closed) throw Object.assign(new Error('Code host is closed'), { code: 'code_host_closed', statusCode: 503 });
            if (primed) return primed;
            const scheduleRetry = (): void => {
                if (closed) return;
                primeRetry = setTimeout(() => {
                    primeRetry = undefined;
                    if (!closed) void probe().catch(() => { /* static registry lists stand */ });
                }, options.primeRetryMs ?? PRIME_RETRY_MS);
                primeRetry.unref?.();
            };
            primed = probe().then(
                complete => { if (complete === false) scheduleRetry(); },
                error => { scheduleRetry(); throw error; },
            );
            return primed;
        },
        dispose() {
            closed = true;
            if (primeRetry) clearTimeout(primeRetry);
            primeRetry = undefined;
            return disposal ??= (async () => {
                // Keep the database alive until owned runtimes finish their last callbacks.
                await manager?.dispose();
                database?.close();
                database = undefined;
                manager = undefined;
            })();
        },
    };
}
