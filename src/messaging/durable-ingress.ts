// ─── Durable ingress journal ─────────────────────────
// One persistent record of every inbound event, so "already handled" survives a
// restart the same way "still to handle" does. Each channel arrived at a different
// answer for that — Telegram an offset frontier, Slack a ten-minute dedupe table,
// Discord a memory set — and this is where those converge.
//
// The connection is injected rather than imported. `src/core/db.ts` opens the real
// database and runs its DDL at import time, so a module that reaches for that
// singleton cannot be tested against a temporary one.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InboundEnvelope, MessengerChannel } from './types.js';
import { isInboundEnvelope } from './types.js';
import { enterMessagingTrace } from './trace-context.js';
import { inc } from './metrics.js';

export const INGRESS_EVENTS_TABLE = 'ingress_events';

export const CREATE_INGRESS_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS ingress_events (
    channel          TEXT NOT NULL CHECK(channel IN ('telegram', 'slack', 'discord')),
    account_id       TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    thread_key       TEXT,
    actor_id         TEXT NOT NULL,
    target_json      TEXT NOT NULL,
    ack_policy       TEXT NOT NULL,
    trace_id         TEXT NOT NULL,
    payload_digest   TEXT NOT NULL,
    payload_json     TEXT,
    state            TEXT NOT NULL DEFAULT 'received'
                     CHECK(state IN ('received', 'processing', 'completed', 'dead_letter')),
    attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    received_at      INTEGER NOT NULL,
    started_at       INTEGER,
    completed_at     INTEGER,
    next_attempt_at  INTEGER,
    last_error       TEXT,
    tombstone_until  INTEGER,
    session_generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_ingress_events_ready
    ON ingress_events (state, next_attempt_at, received_at);
CREATE INDEX IF NOT EXISTS idx_ingress_events_retention
    ON ingress_events (channel, tombstone_until, completed_at);
`;

export type IngressState = 'received' | 'processing' | 'completed' | 'dead_letter';

export type IngressEventRecord = {
    channel: MessengerChannel;
    accountId: string;
    eventId: string;
    conversationKey: string;
    threadKey?: string;
    actorId: string;
    ackPolicy: string;
    traceId: string;
    payloadDigest: string;
    payloadJson: string | null;
    state: IngressState;
    attemptCount: number;
    receivedAt: number;
    startedAt: number | null;
    completedAt: number | null;
    nextAttemptAt: number | null;
    lastError: string | null;
    tombstoneUntil: number | null;
    sessionGeneration: number;
};

export type ReplayOutcome =
    | { replayed: false; reason: 'not_found' | 'already_completed' | 'payload_discarded' | 'in_flight' }
    | { replayed: true; record: IngressEventRecord };

export type AppendResult =
    | { appended: true; record: IngressEventRecord }
    | { appended: false; reason: 'duplicate'; record: IngressEventRecord };

const INGRESS_STATES = new Set<IngressState>(['received', 'processing', 'completed', 'dead_letter']);

/**
 * A child table may only be swept around if it declares how to tell that its own rows
 * are finished. The registry is empty here because M3a ships no children; the boot
 * guard below is what makes that emptiness safe rather than merely true today.
 */
export type ChildRetentionPredicate = {
    /** Table that references ingress_events. */
    table: string;
    /** SQL fragment, correlated to `e`, that is TRUE when this child still blocks deletion. */
    blockingExistsSql: string;
    /** Deletes this child's terminal rows for one parent, bound (channel, accountId, eventId).
     *  Required because foreign_keys is ON: a surviving child makes the parent DELETE
     *  fail, so the sweep has to go child-before-parent rather than parent-only. */
    deleteTerminalSql: string;
};

const childRetentionPredicates = new Map<string, ChildRetentionPredicate>();

export function registerChildRetentionPredicate(predicate: ChildRetentionPredicate): void {
    childRetentionPredicates.set(predicate.table, predicate);
}

/** Test seam: the registry is module state, and a suite that adds one must undo it. */
export function __resetChildRetentionPredicatesForTests(): void {
    childRetentionPredicates.clear();
}

/**
 * Refuse to run if some table references the journal without saying when its rows are
 * done. Without this, the sweeper stays correct only by accident: today no child
 * exists, so any DELETE passes, and the day an outbox lands the sweeper would start
 * removing parents of live attempts. That regression is authored by a different
 * milestone, so no test inside this one could catch it — this guard can.
 */
export function assertChildRetentionPredicatesRegistered(database: SqliteDatabase): void {
    const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
    const unregistered: string[] = [];
    for (const { name } of tables) {
        if (name === INGRESS_EVENTS_TABLE) continue;
        const foreignKeys = database.pragma(`foreign_key_list(${JSON.stringify(name)})`) as Array<{ table: string }>;
        const referencesJournal = foreignKeys.some(fk => fk.table === INGRESS_EVENTS_TABLE);
        if (referencesJournal && !childRetentionPredicates.has(name)) unregistered.push(name);
    }
    if (unregistered.length > 0) {
        throw new Error(
            `ingress retention: ${unregistered.join(', ')} reference ${INGRESS_EVENTS_TABLE} `
            + 'without a registered retention predicate. Register one with '
            + 'registerChildRetentionPredicate() so the sweeper cannot delete a parent '
            + 'whose child rows are still live.',
        );
    }
}

function rowToRecord(row: Record<string, unknown>): IngressEventRecord {
    const state = row['state'];
    // The CHECK constraint is the first boundary, but a row can also arrive from an
    // older or newer binary sharing this file. An unknown state is not something to
    // guess at.
    if (typeof state !== 'string' || !INGRESS_STATES.has(state as IngressState)) {
        throw new Error(`ingress journal: unknown state ${JSON.stringify(state)}`);
    }
    const threadKey = row['thread_key'];
    return {
        channel: row['channel'] as MessengerChannel,
        accountId: String(row['account_id']),
        eventId: String(row['event_id']),
        conversationKey: String(row['conversation_key']),
        ...(typeof threadKey === 'string' ? { threadKey } : {}),
        actorId: String(row['actor_id']),
        ackPolicy: String(row['ack_policy']),
        traceId: String(row['trace_id']),
        payloadDigest: String(row['payload_digest']),
        payloadJson: (row['payload_json'] as string | null) ?? null,
        state: state as IngressState,
        attemptCount: Number(row['attempt_count']),
        receivedAt: Number(row['received_at']),
        startedAt: (row['started_at'] as number | null) ?? null,
        completedAt: (row['completed_at'] as number | null) ?? null,
        nextAttemptAt: (row['next_attempt_at'] as number | null) ?? null,
        lastError: (row['last_error'] as string | null) ?? null,
        tombstoneUntil: (row['tombstone_until'] as number | null) ?? null,
        sessionGeneration: Number(row['session_generation'] ?? 0),
    };
}

export type IngressJournalOptions = {
    now?: () => number;
    /** Correlates every event this process admits. */
    bootId?: string;
    /** How long a completed tombstone is kept before the sweeper may remove it. */
    tombstoneTtlMs?: Partial<Record<MessengerChannel, number>>;
};

// Telegram keeps updates for 24h and Slack's delayed-events retry can run hourly for
// 24h, so both TTLs cover their vendor replay horizon with room for one recovery.
// Discord publishes no replay-retention number at all, so 24h is a deliberate
// placeholder to be revised by measurement rather than a claim about the platform.
const DEFAULT_TOMBSTONE_TTL_MS: Record<MessengerChannel, number> = {
    telegram: 48 * 60 * 60 * 1000,
    slack: 26 * 60 * 60 * 1000,
    discord: 24 * 60 * 60 * 1000,
};

export class IngressJournal {
    private readonly now: () => number;
    private readonly bootId: string;
    private readonly tombstoneTtlMs: Record<MessengerChannel, number>;

    constructor(
        private readonly database: SqliteDatabase,
        options: IngressJournalOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.bootId = options.bootId ?? randomUUID();
        this.tombstoneTtlMs = { ...DEFAULT_TOMBSTONE_TTL_MS, ...options.tombstoneTtlMs };
        this.database.exec(CREATE_INGRESS_EVENTS_SQL);
        const cols = this.database.prepare('PRAGMA table_info(ingress_events)').all() as Array<{ name: string }>;
        if (!cols.some(c => c.name === 'session_generation')) {
            this.database.exec('ALTER TABLE ingress_events ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0');
        }
    }

    /**
     * Only a validated envelope gets in. A raw vendor id would be bound with its own
     * type, and a numeric Telegram update_id lands in this TEXT column as "12345.0"
     * while the same id as a string lands as "12345" — two rows for one logical event,
     * and dedupe silently stops working.
     */
    append(envelope: InboundEnvelope, payloadDigest: string, payloadJson?: string, sessionGeneration = 0): AppendResult {
        if (!isInboundEnvelope(envelope)) {
            throw new Error('ingress journal: append requires a valid InboundEnvelope');
        }
        const existing = this.find(envelope.channel, envelope.accountId, envelope.eventId);
        if (existing) return { appended: false, reason: 'duplicate', record: existing };

        const traceId = this.mintTraceId(envelope);
        try {
            this.database.prepare(`
                INSERT INTO ingress_events (
                    channel, account_id, event_id, conversation_key, thread_key, actor_id,
                    target_json, ack_policy, trace_id, payload_digest, payload_json,
                    state, attempt_count, received_at, session_generation
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)
            `).run(
                envelope.channel,
                envelope.accountId,
                envelope.eventId,
                envelope.conversationKey,
                envelope.threadKey ?? null,
                envelope.actorId,
                JSON.stringify(envelope.target),
                envelope.ackPolicy,
                traceId,
                payloadDigest,
                payloadJson ?? null,
                envelope.receivedAt,
                sessionGeneration,
            );
        } catch (error) {
            // Another connection won the insert. Locked / disk-full must still throw
            // so Slack can refuse ACK; only a primary-key clash is a duplicate.
            if (!isUniqueConstraint(error)) throw error;
            const raced = this.find(envelope.channel, envelope.accountId, envelope.eventId);
            if (!raced) throw error;
            return { appended: false, reason: 'duplicate', record: raced };
        }
        const record = this.find(envelope.channel, envelope.accountId, envelope.eventId);
        if (!record) throw new Error('ingress journal: append did not persist');
        return { appended: true, record };
    }

    /**
     * This tree has no correlation-id producer — the one `traceId` declaration in it has
     * no consumers — so the journal mints its own rather than requiring every future
     * caller to invent one for a NOT NULL column.
     */
    private mintTraceId(envelope: InboundEnvelope): string {
        const base = `${this.bootId}:${envelope.channel}:${envelope.eventId}`;
        return envelope.rawEnvelopeRef ? `${base}:${envelope.rawEnvelopeRef}` : base;
    }

    find(channel: MessengerChannel, accountId: string, eventId: string): IngressEventRecord | null {
        const row = this.database.prepare(`
            SELECT * FROM ingress_events
            WHERE channel = ? AND account_id = ? AND event_id = ?
        `).get(channel, accountId, eventId) as Record<string, unknown> | undefined;
        return row ? rowToRecord(row) : null;
    }

    /**
     * Anything not already completed -> processing. Bumps the attempt so a retry is
     * visible.
     *
     * `processing` is deliberately an allowed source. A row sits in that state only
     * because a previous run died between claiming the event and finishing it; the
     * transport is about to redeliver precisely because nothing was ever acknowledged.
     * Refusing to re-claim it would strand the one delivery the message has left.
     */
    markProcessing(channel: MessengerChannel, accountId: string, eventId: string): boolean {
        const changes = this.database.prepare(`
            UPDATE ingress_events
            SET state = 'processing', started_at = ?, attempt_count = attempt_count + 1,
                last_error = NULL, next_attempt_at = NULL
            WHERE channel = ? AND account_id = ? AND event_id = ?
              AND state IN ('received', 'processing', 'dead_letter')
        `).run(this.now(), channel, accountId, eventId).changes;
        return changes === 1;
    }

    /**
     * True when this event has already been handled to completion. The append path
     * uses it to tell a genuine duplicate from a row a crash left mid-flight: only the
     * former may be skipped.
     */
    isSettled(channel: MessengerChannel, accountId: string, eventId: string): boolean {
        return this.find(channel, accountId, eventId)?.state === 'completed';
    }

    /**
     * Completion drops the payload and sets the tombstone in one transaction. Deleting
     * the row outright would lose the fact that this event was handled, which is the
     * one thing a redelivery needs to know.
     */
    markCompleted(channel: MessengerChannel, accountId: string, eventId: string): boolean {
        const completedAt = this.now();
        const tombstoneUntil = completedAt + this.tombstoneTtlMs[channel];
        const run = this.database.transaction(() => this.database.prepare(`
            UPDATE ingress_events
            SET state = 'completed', completed_at = ?, tombstone_until = ?,
                payload_json = NULL, last_error = NULL, next_attempt_at = NULL
            WHERE channel = ? AND account_id = ? AND event_id = ? AND state = 'processing'
        `).run(completedAt, tombstoneUntil, channel, accountId, eventId).changes);
        return run.immediate() === 1;
    }

    /** Keeps the payload: a dead letter exists to be replayed, and replay needs input. */
    markDeadLetter(
        channel: MessengerChannel,
        accountId: string,
        eventId: string,
        lastError: string,
    ): boolean {
        const changes = this.database.prepare(`
            UPDATE ingress_events
            SET state = 'dead_letter', last_error = ?, next_attempt_at = NULL
            WHERE channel = ? AND account_id = ? AND event_id = ? AND state = 'processing'
        `).run(lastError, channel, accountId, eventId).changes;
        return changes === 1;
    }

    /** Schedules a retry without consuming the dead-letter budget. */
    markRetryScheduled(
        channel: MessengerChannel,
        accountId: string,
        eventId: string,
        nextAttemptAt: number,
        lastError: string,
    ): boolean {
        const changes = this.database.prepare(`
            UPDATE ingress_events
            SET state = 'received', next_attempt_at = ?, last_error = ?
            WHERE channel = ? AND account_id = ? AND event_id = ? AND state = 'processing'
        `).run(nextAttemptAt, lastError, channel, accountId, eventId).changes;
        return changes === 1;
    }


    /** Operator listing. Filters are all optional so an empty journal reads cleanly. */
    list(filter: {
        channel?: MessengerChannel;
        state?: IngressState;
        olderThanMs?: number;
        limit?: number;
    } = {}): IngressEventRecord[] {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
        if (filter.state) { clauses.push('state = ?'); params.push(filter.state); }
        if (filter.olderThanMs !== undefined) {
            clauses.push('received_at <= ?');
            params.push(this.now() - filter.olderThanMs);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        params.push(filter.limit ?? 50);
        const rows = this.database.prepare(
            'SELECT * FROM ingress_events ' + where + ' ORDER BY received_at DESC LIMIT ?',
        ).all(...params) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }

    /**
     * Hand a row back for another attempt. Returns why it was refused rather than
     * throwing, because every refusal here is a normal operator answer.
     *
     * A completed row is refused unless forced: its effects already happened, and
     * re-running them is a worse outcome than not replaying. A tombstone whose payload
     * was dropped at completion cannot be replayed at all, forced or not.
     */
    requestReplay(
        channel: MessengerChannel,
        accountId: string,
        eventId: string,
        options: { force?: boolean } = {},
    ): ReplayOutcome {
        const record = this.find(channel, accountId, eventId);
        if (!record) return { replayed: false, reason: 'not_found' };
        if (record.state === 'processing') return { replayed: false, reason: 'in_flight' };
        if (record.state === 'completed') {
            if (!options.force) return { replayed: false, reason: 'already_completed' };
            if (record.payloadJson === null) return { replayed: false, reason: 'payload_discarded' };
        }
        // CAS on the state we just classified. Without this, a handler that claimed
        // the row after find() would be reset to received and run twice.
        const eligible = record.state === 'completed'
            ? "state = 'completed' AND payload_json IS NOT NULL"
            : "state IN ('received', 'dead_letter')";
        const changes = this.database.prepare(
            "UPDATE ingress_events SET state = 'received', next_attempt_at = ?, " +
            'completed_at = NULL, tombstone_until = NULL, last_error = NULL ' +
            'WHERE channel = ? AND account_id = ? AND event_id = ? AND ' + eligible,
        ).run(this.now(), channel, accountId, eventId).changes;
        if (changes !== 1) {
            const latest = this.find(channel, accountId, eventId);
            if (!latest) return { replayed: false, reason: 'not_found' };
            if (latest.state === 'processing') return { replayed: false, reason: 'in_flight' };
            if (latest.state === 'completed' && latest.payloadJson === null) {
                return { replayed: false, reason: 'payload_discarded' };
            }
            if (latest.state === 'completed') return { replayed: false, reason: 'already_completed' };
            return { replayed: false, reason: 'not_found' };
        }
        const replayed = this.find(channel, accountId, eventId);
        if (!replayed) return { replayed: false, reason: 'not_found' };
        return { replayed: true, record: replayed };
    }

    /** Aggregate counts for a health or status surface. */
    counts(): Record<IngressState, number> {
        const rows = this.database.prepare(
            'SELECT state, COUNT(*) AS n FROM ingress_events GROUP BY state',
        ).all() as Array<{ state: string; n: number }>;
        const out: Record<IngressState, number> = {
            received: 0, processing: 0, completed: 0, dead_letter: 0,
        };
        for (const row of rows) {
            if (INGRESS_STATES.has(row.state as IngressState)) out[row.state as IngressState] = row.n;
        }
        return out;
    }

    /** Oldest live row. Completed and dead_letter are history, not backlog. */
    oldestOpenReceivedAt(): number | null {
        const row = this.database.prepare(
            "SELECT MIN(received_at) AS n FROM ingress_events WHERE state IN ('received', 'processing')",
        ).get() as { n: number | null } | undefined;
        return typeof row?.n === 'number' ? row.n : null;
    }

    /**
     * Age-only drain of processing rows left by a crash or an ACK that never
     * reached handle. `session_generation` is per-conversation, not a boot epoch.
     */
    abandonStaleProcessing(opts: { maxAgeMs?: number } = {}): number {
        const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
        const cutoff = this.now() - maxAgeMs;
        return this.database.prepare(`
            UPDATE ingress_events
            SET state = 'dead_letter', last_error = 'abandoned_stale_processing', next_attempt_at = NULL
            WHERE state = 'processing'
              AND COALESCE(started_at, received_at) < ?
        `).run(cutoff).changes;
    }

    listByState(state: IngressState, limit = 100): IngressEventRecord[] {
        const rows = this.database.prepare(`
            SELECT * FROM ingress_events WHERE state = ?
            ORDER BY received_at LIMIT ?
        `).all(state, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }

    /**
     * Removes expired completed tombstones only. Every registered child predicate is
     * ANDed in as a NOT EXISTS, so a parent whose child rows are still live stays put.
     */
    sweepExpiredTombstones(limit = 1000): number {
        assertChildRetentionPredicatesRegistered(this.database);
        const predicates = [...childRetentionPredicates.values()];
        const blocking = predicates
            .map(p => `AND NOT EXISTS (${p.blockingExistsSql})`)
            .join('\n              ');
        const selectSweepable = this.database.prepare(`
            SELECT e.channel, e.account_id, e.event_id FROM ingress_events e
            WHERE e.state = 'completed'
              AND e.tombstone_until IS NOT NULL
              AND e.tombstone_until <= ?
              ${blocking}
            LIMIT ?
        `);
        const deleteParent = this.database.prepare(`
            DELETE FROM ingress_events
            WHERE channel = ? AND account_id = ? AND event_id = ?
        `);
        const deleteChildren = predicates.map(p => this.database.prepare(p.deleteTerminalSql));
        const run = this.database.transaction(() => {
            const rows = selectSweepable.all(this.now(), limit) as Array<{
                channel: string; account_id: string; event_id: string;
            }>;
            let removed = 0;
            for (const row of rows) {
                const key = [row.channel, row.account_id, row.event_id] as const;
                // Children first: foreign_keys is ON, so a parent DELETE with a surviving
                // child fails outright rather than orphaning anything.
                for (const statement of deleteChildren) statement.run(...key);
                removed += deleteParent.run(...key).changes;
            }
            return removed;
        });
        return run.immediate();
    }
}

/** What the journal decided about one inbound event, carried to the completion call. */
export type IngressAdmission =
    | { admit: false; reason: 'already_handled' | 'stale_generation' }
    | { admit: true; journaled: false }
    | { admit: true; journaled: true; envelope: InboundEnvelope };

/**
 * The append/claim half of the durable-ingress protocol, shared by every transport so
 * the ordering is written once. A transport calls this before handling an event and
 * `settleIngress` after. Telegram's offset follows settle. Slack's ACK follows
 * preflight admit, not settle — Socket Mode would otherwise miss the 3s window.
 *
 * `admit: false` means the event completed on an earlier run and must not be handled
 * again. Anything else is admitted — including a row a crash left mid-flight, because
 * the transport is redelivering precisely because nothing was ever acknowledged.
 */

function isUniqueConstraint(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
    const message = error instanceof Error ? error.message : String(error);
    return code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
        || code === 'SQLITE_CONSTRAINT_UNIQUE'
        || /UNIQUE constraint failed: ingress_events/i.test(message);
}
export function admitIngress(
    journal: IngressJournal | null,
    envelope: InboundEnvelope | null,
    payloadDigest: string,
    payloadJson?: string,
    sessionGeneration = 0,
): IngressAdmission {
    // No journal (CLI processes, tests) or an event with no durable identity: behave
    // exactly as this path did before the journal existed.
    if (!journal || !envelope) {
        inc('ingress.admit', { result: 'unjournaled' });
        return { admit: true, journaled: false };
    }
    const result = journal.append(envelope, payloadDigest, payloadJson, sessionGeneration);
    if (!result.appended && result.record.state === 'completed') {
        inc('ingress.admit', { channel: envelope.channel, result: 'already_handled' });
        return { admit: false, reason: 'already_handled' };
    }
    if (!result.appended && result.record.sessionGeneration !== sessionGeneration) {
        inc('ingress.admit', { channel: envelope.channel, result: 'stale_generation' });
        return { admit: false, reason: 'stale_generation' };
    }
    journal.markProcessing(envelope.channel, envelope.accountId, envelope.eventId);
    // Reuse the journal row's identity. A second minted id here is the bug M5 exists to stop.
    enterMessagingTrace({ traceId: result.record.traceId, channel: envelope.channel });
    inc('ingress.admit', {
        channel: envelope.channel,
        result: result.appended ? 'fresh' : 'redelivery',
    });
    return { admit: true, journaled: true, envelope };
}

/** Terminal half of the protocol. `error` present means the run failed. */
export function settleIngress(
    journal: IngressJournal | null,
    admission: IngressAdmission,
    error?: unknown,
    opts?: { onError?: 'retry' | 'dead_letter' },
): void {
    if (!journal || !admission.admit || !admission.journaled) return;
    const { channel, accountId, eventId } = admission.envelope;
    if (error === undefined) {
        journal.markCompleted(channel, accountId, eventId);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (opts?.onError === 'dead_letter') {
        journal.markDeadLetter(channel, accountId, eventId, message);
        return;
    }
    // Back to received rather than dead-lettered: the transport is about to redeliver,
    // so the redelivery is itself the retry. Slack cannot use this after ACK.
    journal.markRetryScheduled(channel, accountId, eventId, Date.now(), message);
}

let journal: IngressJournal | null = null;

/**
 * Called explicitly at boot rather than on import: an owner module that creates its
 * tables as a side effect of being imported would also drag the database singleton in
 * behind it, and the table's existence would depend on who happened to import what.
 */
export function initIngressJournal(
    database: SqliteDatabase,
    options: IngressJournalOptions = {},
): IngressJournal {
    journal = new IngressJournal(database, options);
    journal.abandonStaleProcessing();
    assertChildRetentionPredicatesRegistered(database);
    return journal;
}

export function getIngressJournal(): IngressJournal | null {
    return journal;
}

/** Test seam: the module-level handle outlives a single test otherwise. */
export function __resetIngressJournalForTests(): void {
    journal = null;
}
