import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
    CodeCapabilities, CodeCreateSessionRequest, CodeEventsPage, CodeHistoryPage, CodeItem, CodeItemUpdate,
    CodePatchSessionRequest, CodePermissionRequest, CodePromptReceipt, CodePromptRequest, CodeSessionCursor,
    CodeSessionError, CodeSessionInfo, CodeSessionStatus, CodeSnapshot, CodeSteerRequest, CodeWireEvent,
} from './wire.js';

export const CODE_EVENT_PAGE_MAX = 500;
export const CODE_SNAPSHOT_ITEM_MAX = 1000;
export const CODE_MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const CODE_MAX_REPLAY_PAGE_BYTES = 8 * 1024 * 1024;
export const CODE_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const CODE_MAX_TURN_EVENT_BYTES = 32 * 1024 * 1024;
export const CODE_TERMINAL_RESERVE_BYTES = 2 * 1024 * 1024;
const CODE_CONTROL_FRAME_BYTES = 64 * 1024;
const CODE_SETTLEMENT_TAIL_BYTES = 2 * CODE_CONTROL_FRAME_BYTES;
const CODE_ERROR_MAX_CHARS = 1024;
const CODE_AUTO_TITLE_MAX_CHARS = 120;

export interface CodeStoreLimits {
    maxEventBytes: number;
    maxReplayPageBytes: number;
    maxSnapshotBytes: number;
    maxTurnEventBytes: number;
}
export const CODE_STORE_LIMITS: Readonly<CodeStoreLimits> = Object.freeze({
    maxEventBytes: CODE_MAX_EVENT_BYTES, maxReplayPageBytes: CODE_MAX_REPLAY_PAGE_BYTES,
    maxSnapshotBytes: CODE_MAX_SNAPSHOT_BYTES, maxTurnEventBytes: CODE_MAX_TURN_EVENT_BYTES,
});

function initialTitle(text: string): string {
    const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
    let title = '';
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)) {
        if (title.length + segment.length > CODE_AUTO_TITLE_MAX_CHARS) break;
        title += segment;
    }
    return title;
}

// Capabilities and the captured policy are stored alongside the durable session,
// so metadata reads never require a provider import or a live runtime.
const SESSION_LIST_INDEX_COLUMNS = 'archived_at,created_at,session_id';

export const CREATE_CODE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS code_sessions (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, cwd TEXT NOT NULL,
    title TEXT, model TEXT NOT NULL, effort TEXT, permission_mode TEXT NOT NULL,
    status TEXT NOT NULL, active_turn_id TEXT, archived_at INTEGER, error_json TEXT,
    native_cursor TEXT, native_started INTEGER NOT NULL DEFAULT 0,
    native_policy_json TEXT, capabilities_json TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
    last_turn_completed_at INTEGER, last_visited_at INTEGER, thinking INTEGER,
    replay_floor_sequence INTEGER NOT NULL DEFAULT 0, history_generation INTEGER NOT NULL DEFAULT 0,
    rollback_since INTEGER
);
CREATE TABLE IF NOT EXISTS code_turns (
    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, client_turn_key TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, status TEXT NOT NULL, accepted_sequence INTEGER NOT NULL,
    event_bytes INTEGER NOT NULL DEFAULT 0, control_event_bytes INTEGER NOT NULL DEFAULT 0,
    settlement_bytes INTEGER NOT NULL DEFAULT 0,
    native_prompt_uuid TEXT, removed_generation INTEGER,
    PRIMARY KEY(session_id, turn_id), UNIQUE(session_id, client_turn_key)
);
CREATE TABLE IF NOT EXISTS code_events (
    session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
    PRIMARY KEY(session_id, sequence)
);
CREATE TABLE IF NOT EXISTS code_items (
    session_id TEXT NOT NULL, item_id TEXT NOT NULL, first_sequence INTEGER NOT NULL,
    item_json TEXT NOT NULL, PRIMARY KEY(session_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_code_items_order ON code_items(session_id, first_sequence);
CREATE TABLE IF NOT EXISTS code_steers (
    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, client_turn_key TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, status TEXT NOT NULL, accepted_sequence INTEGER, native_uuid TEXT,
    PRIMARY KEY(session_id, client_turn_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_steers_one_per_turn ON code_steers(session_id, turn_id)
    WHERE status IN ('reserved', 'committed', 'unknown');
`;

export type CodeNativePolicy = Pick<CodeCreateSessionRequest, 'model' | 'effort' | 'permissionMode'>;

/** INTERNAL ONLY: never return this record from HTTP or put it on an event bus. */
export interface CodeSessionRecord extends Omit<CodeSessionInfo, 'resume' | 'rollback'> {
    nativeCursor: string | null;
    nativeStarted: boolean;
    nativePolicy: CodeNativePolicy | null;
    /** Replay after a lower sequence answers `invalid_sequence`: those events describe a rolled-back history. */
    replayFloorSequence: number;
    /** First sequence of a kept user row whose turn has a native prompt boundary. */
    rollbackSince: number | null;
}

export interface CodeStoreOwner { sessionId: string; turnId: string | null; epoch: number }
export interface CodeStoreMutation { session: CodeSessionInfo; events: CodeWireEvent[] }
export interface CodeTurnAdmission extends CodeStoreMutation {
    receipt: CodePromptReceipt;
    duplicate: boolean;
    /** INTERNAL ONLY: the native input identity to send this turn with (Claude); null otherwise. */
    promptUuid: string | null;
}
export interface CodeTurnSettlement extends CodeStoreMutation { receipt: CodePromptReceipt }
export interface CodeStoreOptions { now?: () => number; newId?: () => string; limits?: Partial<CodeStoreLimits> }
export interface CodeSessionCreate extends CodeCreateSessionRequest {
    capabilities: CodeCapabilities;
    sessionId?: string;
    title?: string | null;
}
export interface CodeAdmitTurn extends CodePromptRequest {
    sessionId: string;
    expectedRevision?: number;
}
export interface CodeSettleTurn {
    status: 'completed' | 'cancelled' | 'failed';
    error?: CodeSessionError | null;
    /** Native ids of committed follow-ups no native result consumed; their items read `phase: 'unknown'`. */
    undeliveredFollowUps?: readonly string[];
    /** false: the prompt never left for the native runtime, so it is not a boundary. Omitted keeps it. */
    dispatched?: boolean;
}
/** A turn and its private native prompt boundary; null means it cannot bound a rollback. */
export interface CodeRollbackTurn { turnId: string; promptUuid: string | null }
/** INTERNAL ONLY: provider input for a rollback, validated against the stored transcript. */
export interface CodeRollbackPlan {
    target: { turnId: string; promptUuid: string };
    kept: CodeRollbackTurn[];
    later: CodeRollbackTurn[];
    revision: number;
    epoch: number;
    nativeCursor: string;
    title: string | null;
}
export interface CodeRollbackCommit {
    sessionId: string;
    upToItemId: string;
    expectedRevision: number;
    expectedEpoch: number;
    expectedCursor: string;
    forkCursor: string;
    remapped: Array<{ turnId: string; promptUuid: string }>;
    cleared: string[];
}
export interface CodeSteerAdmission extends CodeSteerRequest { sessionId: string }
/** `receipt` is the stored receipt of an already committed key; otherwise the key is now reserved. */
export interface CodeSteerReservation { reservationId: string; receipt: CodePromptReceipt | null }
export interface CodeSessionListOptions {
    cwd?: string;
    archived?: boolean;
    limit?: number;
    /** Keyset cursor: resume strictly after this row in the stable creation order. */
    cursor?: CodeSessionCursor;
}

export class CodeStoreError extends Error {
    constructor(public readonly code: string, message: string, public readonly statusCode: 400 | 404 | 409 | 503) {
        super(message);
        this.name = 'CodeStoreError';
    }
}

type SessionRow = {
    session_id: string; provider: CodeSessionInfo['provider']; cwd: string; title: string | null;
    model: string; effort: string | null; permission_mode: CodeSessionInfo['permissionMode'];
    status: CodeSessionStatus; active_turn_id: string | null; archived_at: number | null;
    error_json: string | null; native_cursor: string | null; native_started: number;
    native_policy_json: string | null; capabilities_json: string;
    epoch: number; sequence: number; revision: number; created_at: number; last_used_at: number;
    last_turn_completed_at: number | null; last_visited_at: number | null; thinking: number | null;
    replay_floor_sequence: number; history_generation: number; rollback_since: number | null;
};
type TurnRow = {
    turn_id: string; client_turn_key: string; prompt_hash: string;
    status: CodePromptReceipt['status']; accepted_sequence: number; removed_generation: number | null;
};
type PlanTurnRow = { turn_id: string; status: string; accepted_sequence: number; native_prompt_uuid: string | null };
/**
 * The first kept user row whose turn still has a native prompt boundary, as a correlated
 * subquery on `code_sessions.session_id`. User rows are admitted in turn order, so the earliest
 * boundary turn (walked on idx_code_turns_boundary) that still has its row owns the minimum.
 */
const ROLLBACK_SINCE_SQL = `(SELECT i.first_sequence FROM code_turns t
    JOIN code_items i ON i.session_id = t.session_id AND i.item_id = t.turn_id || ':user'
    WHERE t.session_id = code_sessions.session_id AND t.native_prompt_uuid IS NOT NULL AND t.removed_generation IS NULL
    ORDER BY t.accepted_sequence LIMIT 1)`;
// `rollback_since` is stored: it is refreshed only where boundaries or user rows change, so a
// session read on the streaming path never walks the session's turns.
const SESSION_COLUMNS = `session_id, provider, cwd, title, model, effort, permission_mode,
    status, active_turn_id, archived_at, error_json, native_cursor, native_started,
    native_policy_json, capabilities_json, epoch, sequence, revision, created_at, last_used_at,
    last_turn_completed_at, last_visited_at, thinking, replay_floor_sequence, history_generation, rollback_since`;
const TURN_COLUMNS = 'turn_id, client_turn_key, prompt_hash, status, accepted_sequence, removed_generation';
type SteerRow = {
    turn_id: string; client_turn_key: string; prompt_hash: string;
    status: 'reserved' | 'committed' | 'rejected' | 'unknown'; accepted_sequence: number | null; native_uuid: string | null;
};
const STEER_COLUMNS = 'turn_id, client_turn_key, prompt_hash, status, accepted_sequence, native_uuid';
const promptHash = (text: string): string => createHash('sha256').update(text).digest('hex');
function steerItem(turnId: string, clientTurnKey: string, text: string, at: number): CodeItem {
    return { itemId: `${turnId}:steer:${clientTurnKey}`, turnId, kind: 'user_message', status: 'done',
        text, clientTurnKey, createdAt: at, updatedAt: at };
}
export const isBusy = (status: CodeSessionStatus): boolean =>
    status === 'starting' || status === 'streaming' || status === 'stopping';

function mapCapabilities(value: CodeCapabilities): CodeCapabilities {
    return {
        resume: value.resume, interrupt: value.interrupt, permissions: value.permissions,
        setModelMidSession: value.setModelMidSession, efforts: [...value.efforts],
        permissionModes: [...value.permissionModes],
    };
}

function mapError(value: CodeSessionError | null): CodeSessionError | null {
    return value === null ? null : {
        code: value.code, message: value.message, at: value.at, recoverable: value.recoverable,
    };
}

/** Input is already normalized/redacted; retain only the public item fields. */
function mapItem(item: CodeItem, firstSequence: number): CodeItem {
    return {
        itemId: item.itemId, firstSequence, turnId: item.turnId, kind: item.kind, status: item.status,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        ...(item.phase !== undefined ? { phase: item.phase } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.clientTurnKey !== undefined ? { clientTurnKey: item.clientTurnKey } : {}),
        ...(item.parentItemId !== undefined ? { parentItemId: item.parentItemId } : {}),
        ...(item.tool ? { tool: {
            name: item.tool.name,
            ...(item.tool.input !== undefined ? { input: item.tool.input } : {}),
            ...(item.tool.detail !== undefined ? { detail: item.tool.detail } : {}),
            ...(item.tool.output !== undefined ? { output: item.tool.output } : {}),
        } } : {}),
        ...(item.truncation ? { truncation: {
            storedChars: item.truncation.storedChars, sourceChars: item.truncation.sourceChars,
            reason: item.truncation.reason,
        } } : {}),
        ...(item.permission ? { permission: {
            permissionId: item.permission.permissionId, sessionId: item.permission.sessionId,
            turnId: item.permission.turnId, epoch: item.permission.epoch,
            title: item.permission.title, detail: item.permission.detail, requestedAt: item.permission.requestedAt,
            options: item.permission.options.map(option => ({ optionId: option.optionId, label: option.label, kind: option.kind })),
        } } : {}),
    };
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
type EventBudgetMode = 'ordinary' | 'control' | 'settlement';
type ItemRow = { first_sequence: number; item_json: string };

function compactUpdate(before: CodeItem, after: CodeItem): CodeItemUpdate | null {
    const { text: oldText, tool: oldTool, status: oldStatus, phase: oldPhase, updatedAt: _oldTime, ...oldMetadata } = before;
    const { text, tool, status, phase, updatedAt, ...metadata } = after;
    if (!isDeepStrictEqual(oldMetadata, metadata) || (oldPhase !== undefined && phase === undefined)) return null;
    if ((oldTool === undefined) !== (tool === undefined)) return null;
    const { output: oldOutput, ...oldToolMetadata } = oldTool ?? { name: '' };
    const { output, ...toolMetadata } = tool ?? { name: '' };
    if (!isDeepStrictEqual(oldToolMetadata, toolMetadata)) return null;
    if (oldText !== text && (text === undefined || !text.startsWith(oldText ?? ''))) return null;
    if (oldOutput !== output && (output === undefined || !output.startsWith(oldOutput ?? ''))) return null;
    return {
        itemId: after.itemId, turnId: after.turnId, firstSequence: after.firstSequence!, updatedAt,
        ...(oldText !== text ? { appendText: text!.slice((oldText ?? '').length) } : {}),
        ...(oldOutput !== output ? { appendToolOutput: output!.slice((oldOutput ?? '').length) } : {}),
        ...(oldStatus !== status ? { status } : {}),
        ...(oldPhase !== phase && phase !== undefined ? { phase } : {}),
    };
}

// Upper bound for a terminal status-only frame, including maximum safe integer
// watermarks. Reserve this before admitting each unresolved item.
function settlementCost(sessionId: string, item: Pick<CodeItem, 'itemId' | 'turnId' | 'status'> | undefined): number {
    return item && (item.status === 'pending' || item.status === 'running')
        ? 512 + jsonBytes(sessionId) + jsonBytes(item.itemId) + jsonBytes(item.turnId) : 0;
}

/** Explicit allowlist, including nested metadata; private record additions stay private. */
export function toCodeSessionInfo(record: CodeSessionRecord): CodeSessionInfo {
    const reason = record.archivedAt !== null ? 'archived'
        : !record.capabilities.resume ? 'unsupported'
            : record.nativeCursor ? null : record.nativeStarted ? 'resume_unavailable' : 'not_started';
    const rollback = record.provider !== 'claude' ? 'unsupported' : reason ?? (record.rollbackSince === null ? 'no_boundary' : null);
    return {
        sessionId: record.sessionId, provider: record.provider, cwd: record.cwd, title: record.title,
        model: record.model, effort: record.effort, permissionMode: record.permissionMode,
        status: record.status, turnId: record.turnId, archivedAt: record.archivedAt,
        error: mapError(record.error), resume: { available: reason === null, reason },
        rollback: { available: rollback === null, reason: rollback, sinceSequence: record.rollbackSince },
        historyGeneration: record.historyGeneration,
        capabilities: mapCapabilities(record.capabilities), epoch: record.epoch,
        sequence: record.sequence, revision: record.revision, createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt, lastTurnCompletedAt: record.lastTurnCompletedAt,
        lastVisitedAt: record.lastVisitedAt, thinking: record.thinking,
    };
}

function rowToRecord(row: SessionRow): CodeSessionRecord {
    return {
        sessionId: row.session_id, provider: row.provider, cwd: row.cwd, title: row.title,
        model: row.model, effort: row.effort, permissionMode: row.permission_mode,
        status: row.status, turnId: row.active_turn_id, archivedAt: row.archived_at,
        error: row.error_json === null ? null : JSON.parse(row.error_json) as CodeSessionError,
        nativeCursor: row.native_cursor, nativeStarted: row.native_started === 1,
        nativePolicy: row.native_policy_json === null ? null : JSON.parse(row.native_policy_json) as CodeNativePolicy,
        capabilities: JSON.parse(row.capabilities_json) as CodeCapabilities,
        epoch: row.epoch, sequence: row.sequence, revision: row.revision,
        createdAt: row.created_at, lastUsedAt: row.last_used_at,
        lastTurnCompletedAt: row.last_turn_completed_at, lastVisitedAt: row.last_visited_at,
        // Claude thinking defaults on, including rows written before the column existed.
        thinking: row.provider === 'claude' ? row.thinking !== 0 : null,
        replayFloorSequence: row.replay_floor_sequence, historyGeneration: row.history_generation,
        rollbackSince: row.rollback_since,
    };
}

/** A turn a rollback removed is no longer current: its receipt reads cancelled. */
function receipt(row: TurnRow): CodePromptReceipt {
    return { turnId: row.turn_id, clientTurnKey: row.client_turn_key,
        sequence: row.accepted_sequence, status: row.removed_generation === null ? row.status : 'cancelled' };
}

function pageLimit(value: number | undefined, max: number): number {
    if (value === undefined) return max;
    if (!Number.isSafeInteger(value) || value < 1) throw new CodeStoreError('invalid_limit', 'Limit must be a positive integer', 400);
    return Math.min(value, max);
}

/** Synchronous transactions return committed events; the service alone publishes them. */
export class CodeStore {
    private readonly now: () => number;
    private readonly newId: () => string;
    private readonly limits: CodeStoreLimits;

    constructor(private readonly database: SqliteDatabase, options: CodeStoreOptions = {}) {
        this.now = options.now ?? Date.now;
        this.newId = options.newId ?? randomUUID;
        this.limits = { ...CODE_STORE_LIMITS, ...options.limits };
        for (const key of Object.keys(CODE_STORE_LIMITS) as Array<keyof CodeStoreLimits>) {
            if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > CODE_STORE_LIMITS[key]) {
                throw new CodeStoreError('invalid_limit', `${key} must be a positive integer within its hard limit`, 400);
            }
        }
        this.database.exec(CREATE_CODE_SCHEMA_SQL);
        this.ensureSessionListIndex();
        this.ensureBudgetColumns();
        this.ensureActivityColumns();
        this.ensureRollbackColumns();
    }

    /** Rebuild the list index only when it does not already match the page key. */
    private ensureSessionListIndex(): void {
        const columns = (this.database.prepare("PRAGMA index_info('idx_code_sessions_list')").all() as { name: string }[])
            .map(column => column.name).join(',');
        if (columns === SESSION_LIST_INDEX_COLUMNS) return;
        this.database.transaction(() => {
            this.database.exec('DROP INDEX IF EXISTS idx_code_sessions_list');
            this.database.exec(`CREATE INDEX idx_code_sessions_list ON code_sessions(${SESSION_LIST_INDEX_COLUMNS})`);
        })();
    }

    /** Adds the sidebar activity clocks and the thinking switch to databases created before them; all stay NULL. */
    private ensureActivityColumns(): void {
        const names = new Set((this.database.prepare('PRAGMA table_info(code_sessions)').all() as { name: string }[])
            .map(column => column.name));
        if (names.has('last_turn_completed_at') && names.has('last_visited_at') && names.has('thinking')) return;
        this.database.transaction(() => {
            if (!names.has('last_turn_completed_at')) this.database.exec('ALTER TABLE code_sessions ADD COLUMN last_turn_completed_at INTEGER');
            if (!names.has('last_visited_at')) this.database.exec('ALTER TABLE code_sessions ADD COLUMN last_visited_at INTEGER');
            if (!names.has('thinking')) this.database.exec('ALTER TABLE code_sessions ADD COLUMN thinking INTEGER');
        }).immediate();
    }

    /**
     * Adds the rollback columns to databases created before them. Existing turns keep a
     * NULL prompt boundary, so they are never rollback targets; floors and generations start at 0.
     * A stored rollback start that did not exist yet is computed once for every session.
     */
    private ensureRollbackColumns(): void {
        const columns = (table: string) => new Set((this.database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
            .map(column => column.name));
        const sessions = columns('code_sessions'), turns = columns('code_turns');
        const indexed = !!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_code_turns_boundary'").get();
        if (indexed && sessions.has('rollback_since') && sessions.has('replay_floor_sequence') && sessions.has('history_generation')
            && turns.has('native_prompt_uuid') && turns.has('removed_generation')) return;
        this.database.transaction(() => {
            if (!sessions.has('replay_floor_sequence')) this.database.exec('ALTER TABLE code_sessions ADD COLUMN replay_floor_sequence INTEGER NOT NULL DEFAULT 0');
            if (!sessions.has('history_generation')) this.database.exec('ALTER TABLE code_sessions ADD COLUMN history_generation INTEGER NOT NULL DEFAULT 0');
            if (!turns.has('native_prompt_uuid')) this.database.exec('ALTER TABLE code_turns ADD COLUMN native_prompt_uuid TEXT');
            if (!turns.has('removed_generation')) this.database.exec('ALTER TABLE code_turns ADD COLUMN removed_generation INTEGER');
            this.database.exec(`CREATE INDEX IF NOT EXISTS idx_code_turns_boundary ON code_turns(session_id, accepted_sequence)
                WHERE native_prompt_uuid IS NOT NULL AND removed_generation IS NULL`);
            if (!sessions.has('rollback_since')) {
                this.database.exec('ALTER TABLE code_sessions ADD COLUMN rollback_since INTEGER');
                this.database.exec(`UPDATE code_sessions SET rollback_since = ${ROLLBACK_SINCE_SQL}`);
            }
        }).immediate();
    }

    private ensureBudgetColumns(): void {
        this.database.transaction(() => {
            const columns = this.database.prepare('PRAGMA table_info(code_turns)').all() as { name: string }[];
            const names = new Set(columns.map(column => column.name));
            for (const column of ['event_bytes', 'control_event_bytes', 'settlement_bytes']) {
                if (!names.has(column)) this.database.exec(`ALTER TABLE code_turns ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
            }
            if (!names.has('event_bytes')) this.database.exec(`UPDATE code_turns SET event_bytes = (
                SELECT COALESCE(SUM(length(CAST(e.event_json AS BLOB))), 0) FROM code_events e
                WHERE e.session_id = code_turns.session_id AND e.sequence >= code_turns.accepted_sequence - 2
                AND e.sequence < COALESCE((SELECT MIN(t.accepted_sequence) - 2 FROM code_turns t
                    WHERE t.session_id = code_turns.session_id AND t.accepted_sequence > code_turns.accepted_sequence), 9223372036854775807)
            )`);
            if (!names.has('settlement_bytes')) this.database.exec(`UPDATE code_turns SET settlement_bytes = (
                SELECT COALESCE(SUM(512 + length(CAST(json_quote(i.session_id) AS BLOB))
                    + length(CAST(json_quote(i.item_id) AS BLOB)) + length(CAST(json_quote(code_turns.turn_id) AS BLOB))), 0)
                FROM code_items i WHERE i.session_id = code_turns.session_id
                AND json_extract(i.item_json, '$.turnId') = code_turns.turn_id
                AND json_extract(i.item_json, '$.status') IN ('pending', 'running')
            )`);
        }).immediate();
    }

    private write<T>(operation: () => T): T {
        // A nested savepoint could return events before the caller's outer COMMIT.
        if (this.database.inTransaction) throw new CodeStoreError('nested_transaction', 'Code writes must own their commit', 409);
        return this.database.transaction(operation).immediate();
    }

    /** Provider/service-only access; all public reads below return the mapped DTO. */
    readRecord(sessionId: string): CodeSessionRecord | null {
        const row = this.database.prepare(`SELECT ${SESSION_COLUMNS} FROM code_sessions WHERE session_id = ?`)
            .get(sessionId) as SessionRow | undefined;
        return row ? rowToRecord(row) : null;
    }

    private requireRecord(sessionId: string): CodeSessionRecord {
        const record = this.readRecord(sessionId);
        if (!record) throw new CodeStoreError('session_not_found', 'Code session not found', 404);
        return record;
    }

    /**
     * Refresh the stored rollback start after boundaries or user rows change, before the session
     * event that saves it. Every writer of either calls this.
     */
    private readRollbackSince(sessionId: string): number | null {
        return (this.database.prepare(`SELECT ${ROLLBACK_SINCE_SQL} AS since FROM code_sessions WHERE session_id = ?`)
            .get(sessionId) as { since: number | null } | undefined)?.since ?? null;
    }

    read(sessionId: string): CodeSessionInfo | null {
        const record = this.readRecord(sessionId);
        return record ? toCodeSessionInfo(record) : null;
    }

    /**
     * Pages follow a stable creation order, newest first, ties broken by id.
     *
     * `last_used_at` cannot order a paginated list: every write moves the row
     * forward, so an OFFSET or a cursor on that key silently skips the sessions
     * it passed. `created_at` is immutable, so a cursor on (created_at,
     * session_id) walks a fixed sequence — no row already inside the filter is
     * skipped or repeated. Rows created or newly matching a filter ahead of the
     * cursor belong to a later from-scratch read, never to this stream.
     */
    list(options: CodeSessionListOptions = {}): CodeSessionInfo[] {
        const limit = pageLimit(options.limit, CODE_SNAPSHOT_ITEM_MAX);
        const cursor = options.cursor;
        if (cursor !== undefined && (!Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0
            || typeof cursor.sessionId !== 'string' || !cursor.sessionId || cursor.sessionId.length > 240)) {
            throw new CodeStoreError('invalid_cursor', 'Cursor must carry a creation time and session id', 400);
        }
        const rows = this.database.prepare(`SELECT ${SESSION_COLUMNS} FROM code_sessions
            WHERE (? IS NULL OR cwd = ?) AND (? IS NULL OR (archived_at IS NOT NULL) = ?)
            AND (? IS NULL OR created_at < ? OR (created_at = ? AND session_id > ?))
            ORDER BY created_at DESC, session_id ASC LIMIT ?`)
            .all(options.cwd ?? null, options.cwd ?? null,
                options.archived === undefined ? null : Number(options.archived),
                options.archived === undefined ? null : Number(options.archived),
                cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
                cursor?.sessionId ?? null, limit) as SessionRow[];
        return rows.map(row => toCodeSessionInfo(rowToRecord(row)));
    }

    snapshot(sessionId: string, options: { limit?: number } = {}): CodeSnapshot {
        const limit = pageLimit(options.limit, CODE_SNAPSHOT_ITEM_MAX);
        return this.database.transaction(() => {
            const session = toCodeSessionInfo(this.requireRecord(sessionId));
            const snapshot: CodeSnapshot = { session, items: [], sequence: session.sequence, pendingPermissions: [], truncated: false };
            let bytes = jsonBytes(snapshot);
            const reserve = (size: number, required: boolean): boolean => {
                if (bytes + size <= this.limits.maxSnapshotBytes) return true;
                if (required) throw new CodeStoreError('snapshot_limit', 'Complete active Code transcript exceeds snapshot byte limit', 409);
                return false;
            };
            reserve(0, true);
            // Control reads do not depend on the history window or its row limit.
            if (session.turnId !== null && isBusy(session.status)) {
                const permissions = this.database.prepare(`SELECT item_id,
                    length(CAST(json_extract(item_json, '$.permission') AS BLOB)) AS byte_length FROM code_items
                    WHERE session_id = ? AND json_extract(item_json, '$.kind') = 'permission_request'
                    AND json_extract(item_json, '$.status') = 'pending'
                    AND json_extract(item_json, '$.permission.sessionId') = ?
                    AND json_extract(item_json, '$.permission.turnId') = ?
                    AND json_extract(item_json, '$.permission.epoch') = ? ORDER BY first_sequence`)
                    .iterate(sessionId, sessionId, session.turnId, session.epoch) as IterableIterator<{ item_id: string; byte_length: number }>;
                for (const row of permissions) {
                    const comma = Number(snapshot.pendingPermissions.length > 0);
                    reserve(row.byte_length + comma, true);
                    const value = this.database.prepare(`SELECT json_extract(item_json, '$.permission') AS permission_json
                        FROM code_items WHERE session_id = ? AND item_id = ?`).get(sessionId, row.item_id) as { permission_json: string };
                    snapshot.pendingPermissions.push(JSON.parse(value.permission_json) as CodePermissionRequest);
                    bytes += row.byte_length + comma;
                }
            }
            const append = (row: { item_id: string; byte_length: number }, required: boolean): boolean => {
                const comma = Number(snapshot.items.length > 0);
                if (!reserve(row.byte_length + comma, required)) return false;
                const value = this.database.prepare('SELECT first_sequence, item_json FROM code_items WHERE session_id = ? AND item_id = ?')
                    .get(sessionId, row.item_id) as ItemRow;
                const item = mapItem(JSON.parse(value.item_json) as CodeItem, value.first_sequence);
                const size = jsonBytes(item) + comma;
                if (!reserve(size, required)) return false;
                bytes += size;
                snapshot.items.push(item);
                return true;
            };
            if (session.turnId !== null) {
                const active = this.database.prepare(`SELECT item_id, length(CAST(item_json AS BLOB)) AS byte_length FROM code_items
                    WHERE session_id = ? AND json_extract(item_json, '$.turnId') = ? ORDER BY first_sequence`)
                    .iterate(sessionId, session.turnId) as IterableIterator<{ item_id: string; byte_length: number }>;
                for (const row of active) append(row, true);
            }
            const history = this.database.prepare(`SELECT item_id, length(CAST(item_json AS BLOB)) AS byte_length FROM code_items
                WHERE session_id = ? AND (? IS NULL OR json_extract(item_json, '$.turnId') IS NOT ?)
                ORDER BY first_sequence DESC`).iterate(sessionId, session.turnId, session.turnId) as IterableIterator<{ item_id: string; byte_length: number }>;
            for (const row of history) {
                if (snapshot.items.length >= limit || !append(row, false)) {
                    snapshot.truncated = true;
                    break;
                }
            }
            snapshot.items.sort((a, b) => a.firstSequence! - b.firstSequence!);
            return snapshot;
        })();
    }

    readEvents(sessionId: string, afterSequence = 0, limit?: number): CodeEventsPage {
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new CodeStoreError('invalid_sequence', 'Sequence must be a nonnegative integer', 400);
        }
        const size = pageLimit(limit, CODE_EVENT_PAGE_MAX);
        return this.database.transaction(() => {
            const record = this.requireRecord(sessionId);
            const throughSequence = record.sequence;
            if (afterSequence > throughSequence) throw new CodeStoreError('invalid_sequence', 'Sequence exceeds session watermark', 409);
            // Events before a rollback describe items it removed; only a new snapshot is consistent.
            if (afterSequence < record.replayFloorSequence) throw new CodeStoreError('invalid_sequence', 'Conversation was rolled back; take a new snapshot', 409);
            const events: CodeWireEvent[] = [];
            let bytes = jsonBytes({ events, nextSequence: throughSequence, throughSequence, hasMore: false });
            if (bytes > this.limits.maxReplayPageBytes) throw new CodeStoreError('event_too_large', 'Replay envelope exceeds byte limit', 409);
            const rows = this.database.prepare(`SELECT sequence, length(CAST(event_json AS BLOB)) AS byte_length FROM code_events
                WHERE session_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`)
                .iterate(sessionId, afterSequence, throughSequence, size) as IterableIterator<{ sequence: number; byte_length: number }>;
            for (const row of rows) {
                if (row.byte_length > this.limits.maxEventBytes || bytes + row.byte_length + Number(events.length > 0) > this.limits.maxReplayPageBytes) {
                    if (events.length === 0) throw new CodeStoreError('event_too_large', 'Code event cannot fit the replay byte limit', 409);
                    break;
                }
                const value = this.database.prepare('SELECT event_json FROM code_events WHERE session_id = ? AND sequence = ?')
                    .get(sessionId, row.sequence) as { event_json: string };
                const event = JSON.parse(value.event_json) as CodeWireEvent;
                const itemId = event.item?.itemId ?? event.update?.itemId;
                if (itemId !== undefined) {
                    const projected = this.database.prepare('SELECT first_sequence FROM code_items WHERE session_id = ? AND item_id = ?')
                        .get(sessionId, itemId) as { first_sequence: number } | undefined;
                    if (!projected) throw new Error('Code event item projection is missing');
                    if (event.item) event.item = mapItem(event.item, projected.first_sequence);
                    if (event.update) event.update.firstSequence = projected.first_sequence;
                }
                const eventBytes = jsonBytes(event) + Number(events.length > 0);
                if (eventBytes - Number(events.length > 0) > this.limits.maxEventBytes || bytes + eventBytes > this.limits.maxReplayPageBytes) {
                    if (events.length === 0) throw new CodeStoreError('event_too_large', 'Code event cannot fit the replay byte limit', 409);
                    break;
                }
                events.push(event);
                bytes += eventBytes;
            }
            const nextSequence = events.at(-1)?.sequence ?? afterSequence;
            return { events, nextSequence, throughSequence, hasMore: nextSequence < throughSequence };
        })();
    }

    history(sessionId: string, beforeSequence = Number.MAX_SAFE_INTEGER, limit = 100): CodeHistoryPage {
        if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 0) {
            throw new CodeStoreError('invalid_sequence', 'History cursor must be a nonnegative integer', 400);
        }
        const size = pageLimit(limit, CODE_SNAPSHOT_ITEM_MAX);
        return this.database.transaction(() => {
            const sequence = this.requireRecord(sessionId).sequence;
            const page: CodeHistoryPage = { items: [], beforeSequence: null, hasMore: false, sequence };
            let bytes = jsonBytes(page) + 64;
            const rows = this.database.prepare(`SELECT item_id, first_sequence,
                length(CAST(item_json AS BLOB)) AS byte_length FROM code_items
                WHERE session_id = ? AND first_sequence < ? ORDER BY first_sequence DESC`)
                .iterate(sessionId, beforeSequence) as IterableIterator<{ item_id: string; first_sequence: number; byte_length: number }>;
            for (const row of rows) {
                if (page.items.length >= size || bytes + row.byte_length + 1 > this.limits.maxSnapshotBytes) {
                    if (page.items.length === 0) throw new CodeStoreError('snapshot_limit', 'History item exceeds byte limit', 409);
                    page.hasMore = true;
                    break;
                }
                const value = this.database.prepare('SELECT first_sequence, item_json FROM code_items WHERE session_id = ? AND item_id = ?')
                    .get(sessionId, row.item_id) as ItemRow;
                const item = mapItem(JSON.parse(value.item_json) as CodeItem, value.first_sequence);
                const itemBytes = jsonBytes(item) + 1;
                if (bytes + itemBytes > this.limits.maxSnapshotBytes) {
                    if (page.items.length === 0) throw new CodeStoreError('snapshot_limit', 'History item exceeds byte limit', 409);
                    page.hasMore = true;
                    break;
                }
                page.items.push(item);
                bytes += itemBytes;
            }
            page.items.reverse();
            page.beforeSequence = page.items[0]?.firstSequence ?? null;
            return page;
        })();
    }

    private save(record: CodeSessionRecord): void {
        this.database.prepare(`UPDATE code_sessions SET title = ?, model = ?, effort = ?, permission_mode = ?,
            status = ?, active_turn_id = ?, archived_at = ?, error_json = ?, native_cursor = ?, native_started = ?,
            native_policy_json = ?, epoch = ?, sequence = ?, revision = ?, last_used_at = ?,
            last_turn_completed_at = ?, last_visited_at = ?, thinking = ?, replay_floor_sequence = ?,
            history_generation = ?, rollback_since = ? WHERE session_id = ?`)
            .run(record.title, record.model, record.effort, record.permissionMode, record.status, record.turnId,
                record.archivedAt, record.error === null ? null : JSON.stringify(mapError(record.error)),
                record.nativeCursor, Number(record.nativeStarted),
                record.nativePolicy === null ? null : JSON.stringify(record.nativePolicy), record.epoch,
                record.sequence, record.revision, record.lastUsedAt, record.lastTurnCompletedAt, record.lastVisitedAt,
                record.thinking === null ? null : Number(record.thinking), record.replayFloorSequence,
                record.historyGeneration, record.rollbackSince, record.sessionId);
    }

    private persistEvent(record: CodeSessionRecord, event: CodeWireEvent, mode: EventBudgetMode,
        settlementDelta = 0, budgetTurnId: string | null = record.turnId): CodeWireEvent {
        const encoded = JSON.stringify(event);
        const bytes = Buffer.byteLength(encoded, 'utf8');
        const eventLimit = mode === 'ordinary' ? this.limits.maxEventBytes : Math.min(this.limits.maxEventBytes, CODE_CONTROL_FRAME_BYTES);
        if (bytes > eventLimit || (mode === 'ordinary' && event.session && jsonBytes(event.session) > CODE_CONTROL_FRAME_BYTES / 2)) {
            throw new CodeStoreError('event_too_large', 'Code event exceeds its byte limit', 409);
        }
        if (budgetTurnId !== null) {
            const budget = this.database.prepare(`SELECT event_bytes, control_event_bytes, settlement_bytes FROM code_turns
                WHERE session_id = ? AND turn_id = ?`).get(record.sessionId, budgetTurnId) as {
                    event_bytes: number; control_event_bytes: number; settlement_bytes: number;
                };
            if (mode === 'ordinary' && budget.event_bytes - budget.control_event_bytes + bytes > this.limits.maxTurnEventBytes) {
                throw new CodeStoreError('transcript_limit', 'Code turn event byte limit reached', 409);
            }
            const controlBytes = budget.control_event_bytes + (mode === 'ordinary' ? 0 : bytes);
            const settlementBytes = Math.max(0, budget.settlement_bytes + settlementDelta);
            const reserved = mode === 'settlement' ? 0 : settlementBytes + CODE_SETTLEMENT_TAIL_BYTES;
            if (controlBytes + reserved > CODE_TERMINAL_RESERVE_BYTES) {
                throw new CodeStoreError('transcript_limit', 'Code turn terminal reserve would be exhausted', 409);
            }
            this.database.prepare(`UPDATE code_turns SET event_bytes = event_bytes + ?, control_event_bytes = ?, settlement_bytes = ?
                WHERE session_id = ? AND turn_id = ?`).run(bytes, controlBytes, settlementBytes, record.sessionId, budgetTurnId);
        }
        this.database.prepare('INSERT INTO code_events (session_id, sequence, event_json) VALUES (?, ?, ?)')
            .run(record.sessionId, event.sequence, encoded);
        this.save(record);
        return event;
    }

    /** `reserve` holds extra settlement bytes for a frame this item may need at settlement. */
    private event(record: CodeSessionRecord, item?: CodeItem, mode: EventBudgetMode = 'ordinary', budgetTurnId = record.turnId,
        reserve = 0): CodeWireEvent {
        record.sequence += 1;
        let retainedItem: CodeItem | undefined;
        let previousItem: CodeItem | undefined;
        let update: CodeItemUpdate | null = null;
        if (item) {
            const previous = this.database.prepare('SELECT first_sequence, item_json FROM code_items WHERE session_id = ? AND item_id = ?')
                .get(record.sessionId, item.itemId) as ItemRow | undefined;
            retainedItem = mapItem(item, previous?.first_sequence ?? record.sequence);
            if (settlementCost(record.sessionId, retainedItem) > Math.min(this.limits.maxEventBytes, CODE_CONTROL_FRAME_BYTES)) {
                throw new CodeStoreError('event_too_large', 'Code item identity cannot fit a terminal control event', 409);
            }
            if (previous) {
                previousItem = mapItem(JSON.parse(previous.item_json) as CodeItem, previous.first_sequence);
                const knownFields = isDeepStrictEqual({ ...item, firstSequence: retainedItem.firstSequence }, retainedItem);
                if (knownFields) update = compactUpdate(previousItem, retainedItem);
            }
        }
        const event: CodeWireEvent = {
            topic: 'code', event: update ? 'code_item_update' : item ? 'code_item' : 'code_session', sessionId: record.sessionId,
            sequence: record.sequence, epoch: record.epoch,
            ...(update ? { update } : retainedItem ? { item: retainedItem } : { session: toCodeSessionInfo(record) }),
        };
        this.persistEvent(record, event, mode, settlementCost(record.sessionId, retainedItem) - settlementCost(record.sessionId, previousItem) + reserve,
            budgetTurnId);
        if (item) this.database.prepare(`INSERT INTO code_items (session_id, item_id, first_sequence, item_json)
            VALUES (?, ?, ?, ?) ON CONFLICT(session_id, item_id) DO UPDATE SET item_json = excluded.item_json`)
                .run(record.sessionId, item.itemId, retainedItem!.firstSequence, JSON.stringify(retainedItem));
        return event;
    }

    create(input: CodeSessionCreate): CodeStoreMutation {
        return this.write(() => {
            const now = this.now();
            const sessionId = input.sessionId ?? this.newId();
            this.database.prepare(`INSERT INTO code_sessions
                (session_id, provider, cwd, title, model, effort, permission_mode, status,
                 capabilities_json, created_at, last_used_at, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`)
                .run(sessionId, input.provider, input.cwd, input.title ?? null, input.model, input.effort,
                    input.permissionMode, JSON.stringify(mapCapabilities(input.capabilities)), now, now,
                    input.thinking === undefined ? null : Number(input.thinking));
            const record = this.requireRecord(sessionId);
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    private checkOwner(owner: CodeStoreOwner): CodeSessionRecord {
        const record = this.requireRecord(owner.sessionId);
        if (record.epoch !== owner.epoch || record.turnId !== owner.turnId) {
            throw new CodeStoreError('stale_owner', 'Code turn ownership has changed', 409);
        }
        return record;
    }

    readTurn(sessionId: string, clientTurnKey: string): CodePromptReceipt | null {
        const row = this.database.prepare(`SELECT ${TURN_COLUMNS} FROM code_turns WHERE session_id = ? AND client_turn_key = ?`)
            .get(sessionId, clientTurnKey) as TurnRow | undefined;
        if (!row) this.refuseSteerKey(sessionId, clientTurnKey);
        return row ? receipt(row) : null;
    }

    /** One client key names one message: a prompt key is never a follow-up key, or the reverse. */
    private refuseSteerKey(sessionId: string, clientTurnKey: string): void {
        if (this.database.prepare('SELECT 1 FROM code_steers WHERE session_id = ? AND client_turn_key = ?').get(sessionId, clientTurnKey)) {
            throw new CodeStoreError('turn_key_conflict', 'Client turn key was used for a follow-up', 409);
        }
    }

    private steerRow(sessionId: string, clientTurnKey: string): SteerRow | undefined {
        return this.database.prepare(`SELECT ${STEER_COLUMNS} FROM code_steers WHERE session_id = ? AND client_turn_key = ?`)
            .get(sessionId, clientTurnKey) as SteerRow | undefined;
    }

    /** A follow-up receipt reports its owning turn as a prompt receipt does: a turn a rollback removed reads cancelled. */
    private turnStatus(sessionId: string, turnId: string): CodePromptReceipt['status'] {
        const turn = this.database.prepare('SELECT status, removed_generation FROM code_turns WHERE session_id = ? AND turn_id = ?')
            .get(sessionId, turnId) as { status: CodePromptReceipt['status']; removed_generation: number | null };
        return turn.removed_generation === null ? turn.status : 'cancelled';
    }

    /** The follow-up key state machine; null means a new key that may be reserved. */
    private steerKey(sessionId: string, clientTurnKey: string, text: string): CodePromptReceipt | null {
        if (!text.trim() || !clientTurnKey.trim()) throw new CodeStoreError('invalid_prompt', 'Text and client turn key are required', 400);
        this.requireRecord(sessionId);
        if (this.database.prepare('SELECT 1 FROM code_turns WHERE session_id = ? AND client_turn_key = ?').get(sessionId, clientTurnKey)) {
            throw new CodeStoreError('turn_key_conflict', 'Client turn key was used for a prompt', 409);
        }
        const row = this.steerRow(sessionId, clientTurnKey);
        if (!row) return null;
        if (row.prompt_hash !== promptHash(text)) throw new CodeStoreError('turn_key_conflict', 'Client turn key was used for different content', 409);
        if (row.status === 'reserved') throw new CodeStoreError('steer_in_flight', 'This follow-up is still being delivered', 409);
        if (row.status === 'rejected') throw new CodeStoreError('steer_key_spent', 'This follow-up was refused; send it again as a new message', 409);
        if (row.status === 'unknown') throw new CodeStoreError('steer_outcome_unknown', 'Follow-up delivery could not be confirmed', 503);
        return { turnId: row.turn_id, clientTurnKey, sequence: row.accepted_sequence!, status: this.turnStatus(sessionId, row.turn_id) };
    }

    /** The committed receipt of a follow-up key, whatever its turn has become since. */
    readSteer(sessionId: string, input: Pick<CodeSteerRequest, 'text' | 'clientTurnKey'>): CodePromptReceipt | null {
        return this.database.transaction(() => this.steerKey(sessionId, input.clientTurnKey, input.text))();
    }

    /**
     * Take the running turn's one follow-up slot before any native offer. No events: the
     * message joins the transcript only through commitSteer, after the runtime accepted it.
     */
    reserveSteer(input: CodeSteerAdmission): CodeSteerReservation {
        return this.write(() => {
            const replay = this.steerKey(input.sessionId, input.clientTurnKey, input.text);
            if (replay) return { reservationId: input.clientTurnKey, receipt: replay };
            const record = this.requireRecord(input.sessionId);
            if (record.epoch !== input.epoch || record.turnId !== input.turnId) {
                throw new CodeStoreError('stale_owner', 'Code turn ownership has changed', 409);
            }
            if (record.archivedAt !== null || record.status !== 'streaming' || record.turnId === null) {
                throw new CodeStoreError('session_not_steerable', 'This turn does not take a follow-up right now', 409);
            }
            const turnId = record.turnId;
            if (this.database.prepare(`SELECT 1 FROM code_steers WHERE session_id = ? AND turn_id = ?
                AND status IN ('reserved', 'committed', 'unknown')`).get(input.sessionId, turnId)) {
                throw new CodeStoreError('steer_queue_full', 'The running turn already has its follow-up', 409);
            }
            // Refuse before the native offer what commitSteer could not store, including the reserve for
            // the settlement frame that may re-mark this item; digits a later sequence adds are covered.
            const item = steerItem(turnId, input.clientTurnKey, input.text, this.now());
            const bytes = jsonBytes({ topic: 'code', event: 'code_item', sessionId: record.sessionId, sequence: record.sequence + 1,
                epoch: record.epoch, item: mapItem(item, record.sequence + 1) }) + 32;
            const budget = this.database.prepare(`SELECT event_bytes, control_event_bytes, settlement_bytes FROM code_turns
                WHERE session_id = ? AND turn_id = ?`).get(record.sessionId, turnId) as {
                    event_bytes: number; control_event_bytes: number; settlement_bytes: number;
                };
            if (bytes > this.limits.maxEventBytes
                || budget.event_bytes - budget.control_event_bytes + bytes > this.limits.maxTurnEventBytes
                || budget.control_event_bytes + budget.settlement_bytes + settlementCost(record.sessionId, { ...item, status: 'pending' })
                    + CODE_SETTLEMENT_TAIL_BYTES > CODE_TERMINAL_RESERVE_BYTES) {
                throw new CodeStoreError('transcript_limit', 'Code turn event byte limit reached', 409);
            }
            this.database.prepare(`INSERT INTO code_steers (session_id, turn_id, client_turn_key, prompt_hash, status)
                VALUES (?, ?, ?, ?, 'reserved')`).run(input.sessionId, turnId, input.clientTurnKey, promptHash(input.text));
            return { reservationId: input.clientTurnKey, receipt: null };
        });
    }

    /** The runtime accepted the follow-up: append it to the running turn and spend the reservation. */
    commitSteer(sessionId: string, reservationId: string, text: string, nativeId: string | null): CodeStoreMutation & { receipt: CodePromptReceipt } {
        return this.write(() => {
            const row = this.steerRow(sessionId, reservationId);
            const record = this.requireRecord(sessionId);
            if (!row || row.status !== 'reserved' || row.prompt_hash !== promptHash(text) || record.turnId !== row.turn_id
                || record.archivedAt !== null || record.status !== 'streaming') {
                throw new CodeStoreError('stale_owner', 'Follow-up reservation is no longer open', 409);
            }
            const item = steerItem(row.turn_id, reservationId, text, this.now());
            const events = [this.event(record, item, 'ordinary', row.turn_id, settlementCost(sessionId, { ...item, status: 'pending' }))];
            this.database.prepare(`UPDATE code_steers SET status = 'committed', accepted_sequence = ?, native_uuid = ?
                WHERE session_id = ? AND client_turn_key = ?`).run(record.sequence, nativeId, sessionId, reservationId);
            return { session: toCodeSessionInfo(record), events,
                receipt: { turnId: row.turn_id, clientTurnKey: reservationId, sequence: record.sequence, status: this.turnStatus(sessionId, row.turn_id) } };
        });
    }

    /**
     * A definitive refusal before native acceptance: the key is spent, the turn's slot is free again.
     * A turn that settled while the offer was in flight left the row `unknown`; the in-flight call
     * that then learns the runtime refused the offer is the one owner that can make it definitive.
     */
    rejectSteer(sessionId: string, reservationId: string): void {
        this.write(() => {
            this.database.prepare(`UPDATE code_steers SET status = 'rejected' WHERE session_id = ? AND client_turn_key = ?
                AND status IN ('reserved', 'unknown')`).run(sessionId, reservationId);
        });
    }

    /** Native input left the process without a durable record: the slot stays spent and the key answers unknown. */
    markSteerUnknown(sessionId: string, reservationId: string): void {
        this.write(() => {
            this.database.prepare(`UPDATE code_steers SET status = 'unknown' WHERE session_id = ? AND client_turn_key = ?
                AND status <> 'committed'`).run(sessionId, reservationId);
        });
    }

    admitTurn(input: CodeAdmitTurn): CodeTurnAdmission {
        return this.write(() => {
            if (!input.text.trim() || !input.clientTurnKey.trim()) throw new CodeStoreError('invalid_prompt', 'Text and client turn key are required', 400);
            const record = this.requireRecord(input.sessionId);
            const hash = promptHash(input.text);
            const previous = this.database.prepare(`SELECT ${TURN_COLUMNS} FROM code_turns WHERE session_id = ? AND client_turn_key = ?`)
                .get(input.sessionId, input.clientTurnKey) as TurnRow | undefined;
            if (previous) {
                if (previous.prompt_hash !== hash) throw new CodeStoreError('turn_key_conflict', 'Client turn key was used for different content', 409);
                return { session: toCodeSessionInfo(record), events: [], receipt: receipt(previous), duplicate: true, promptUuid: null };
            }
            this.refuseSteerKey(input.sessionId, input.clientTurnKey);
            if (record.archivedAt !== null) throw new CodeStoreError('session_archived', 'Code session is archived', 409);
            if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
                throw new CodeStoreError('revision_conflict', 'Code metadata changed', 409);
            }
            if (isBusy(record.status)) throw new CodeStoreError('session_busy', 'Code session already has an active turn', 409);
            if (record.nativeStarted && !record.nativeCursor) throw new CodeStoreError('resume_unavailable', 'Native history has no resumable identity', 409);
            const now = this.now();
            const turnId = this.newId();
            record.turnId = turnId;
            record.epoch += 1;
            record.status = 'starting';
            record.error = null;
            record.lastUsedAt = now;
            if (record.title === null) record.title = initialTitle(input.text) || null;
            record.nativePolicy = { model: record.model, effort: record.effort, permissionMode: record.permissionMode };
            const acceptedSequence = record.sequence + 3;
            // The private native input identity; the provider sends the prompt under it.
            const promptUuid = record.provider === 'claude' ? randomUUID() : null;
            this.database.prepare(`INSERT INTO code_turns
                (session_id, turn_id, client_turn_key, prompt_hash, status, accepted_sequence, native_prompt_uuid)
                VALUES (?, ?, ?, ?, 'accepted', ?, ?)`)
                .run(input.sessionId, turnId, input.clientTurnKey, hash, acceptedSequence, promptUuid);
            const events = [
                this.event(record, { itemId: `${turnId}:user`, turnId, kind: 'user_message', status: 'done',
                    text: input.text, clientTurnKey: input.clientTurnKey, createdAt: now, updatedAt: now }),
                this.event(record, { itemId: `${turnId}:started`, turnId, kind: 'turn_started', status: 'running', createdAt: now, updatedAt: now }),
            ];
            record.rollbackSince = this.readRollbackSince(input.sessionId);
            events.push(this.event(record));
            return { session: toCodeSessionInfo(record), events, duplicate: false, promptUuid,
                receipt: { turnId, clientTurnKey: input.clientTurnKey, sequence: acceptedSequence, status: 'accepted' } };
        });
    }

    commitItem(owner: CodeStoreOwner, item: CodeItem): CodeStoreMutation {
        return this.write(() => {
            const record = this.checkOwner(owner);
            if (!isBusy(record.status) || owner.turnId === null || item.turnId !== owner.turnId) {
                throw new CodeStoreError('stale_owner', 'Item does not belong to an active Code turn', 409);
            }
            if (item.kind === 'turn_completed' || item.kind === 'turn_failed' || item.kind === 'turn_cancelled') {
                throw new CodeStoreError('terminal_item_owned', 'Turn terminal items must be committed by settleTurn', 409);
            }
            const previous = this.database.prepare('SELECT item_json FROM code_items WHERE session_id = ? AND item_id = ?')
                .get(owner.sessionId, item.itemId) as { item_json: string } | undefined;
            if (previous && (JSON.parse(previous.item_json) as CodeItem).turnId !== item.turnId) {
                throw new CodeStoreError('item_owner_conflict', 'Item identity belongs to another turn', 409);
            }
            if (item.permission && (item.permission.sessionId !== owner.sessionId || item.permission.turnId !== owner.turnId || item.permission.epoch !== owner.epoch)) {
                throw new CodeStoreError('stale_owner', 'Permission does not belong to this Code turn', 409);
            }
            const events = [this.event(record, item)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** The Manager opened this session. A read receipt: the metadata revision does not move. */
    markVisited(sessionId: string): CodeStoreMutation {
        return this.write(() => {
            const record = this.requireRecord(sessionId);
            record.lastVisitedAt = this.now();
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** Reserve an explicit resume without inventing a prompt or consuming a client key. */
    beginAttach(sessionId: string, expectedRevision?: number): CodeStoreMutation {
        return this.write(() => {
            const record = this.requireRecord(sessionId);
            if (record.archivedAt !== null) throw new CodeStoreError('session_archived', 'Code session is archived', 409);
            if (expectedRevision !== undefined && expectedRevision !== record.revision) {
                throw new CodeStoreError('revision_conflict', 'Code metadata changed', 409);
            }
            if (isBusy(record.status)) throw new CodeStoreError('session_busy', 'Code session already has active work', 409);
            if (!record.nativeCursor || !record.capabilities.resume) throw new CodeStoreError('resume_unavailable', 'Code session cannot resume native history', 409);
            record.epoch += 1;
            record.status = 'starting';
            record.error = null;
            record.lastUsedAt = this.now();
            record.nativePolicy = { model: record.model, effort: record.effort, permissionMode: record.permissionMode };
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** Runtime-only transitions; metadata revision is deliberately independent. */
    setRuntimeState(owner: CodeStoreOwner, status: 'streaming' | 'stopping' | 'suspended' | 'idle' | 'failed', error?: CodeSessionError | null): CodeStoreMutation {
        return this.write(() => {
            const record = this.checkOwner(owner);
            if (record.archivedAt !== null || (isBusy(status) !== (record.turnId !== null))) {
                throw new CodeStoreError('invalid_runtime_state', 'Runtime state does not match turn ownership', 409);
            }
            if (record.status === 'stopping' && status === 'streaming') throw new CodeStoreError('stale_owner', 'Turn is already stopping', 409);
            if (record.status === status) return { session: toCodeSessionInfo(record), events: [] };
            record.status = status;
            record.error = error ?? null;
            record.lastUsedAt = this.now();
            if (status === 'streaming') this.database.prepare(`UPDATE code_turns SET status = 'running' WHERE session_id = ? AND turn_id = ?`)
                .run(record.sessionId, record.turnId);
            const events = [this.event(record, undefined, status === 'streaming' ? 'ordinary' : 'control')];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** null marks an actually started native operation whose identity is not yet available. */
    writeNativeCursor(owner: CodeStoreOwner, cursor: string | null): CodeStoreMutation {
        return this.write(() => {
            const record = this.checkOwner(owner);
            if (record.archivedAt !== null || record.status === 'stopping') throw new CodeStoreError('stale_owner', 'Native cursor owner is no longer writable', 409);
            if (cursor !== null && !cursor.trim()) throw new CodeStoreError('invalid_cursor', 'Native cursor must be nonempty', 400);
            // Boundaries belong to the native session that recorded them. A replaced identity
            // retires them; the first identity, and the active turn now sent to it, keep theirs.
            if (cursor !== null && record.nativeCursor !== null && cursor !== record.nativeCursor) {
                this.database.prepare('UPDATE code_turns SET native_prompt_uuid = NULL WHERE session_id = ? AND turn_id IS NOT ?')
                    .run(record.sessionId, record.turnId);
            }
            record.nativeStarted = true;
            if (cursor !== null) record.nativeCursor = cursor;
            record.rollbackSince = this.readRollbackSince(record.sessionId);
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** `lostRuntime`: a restart settles the turn, and nothing can confirm what its runtime consumed. */
    private finish(record: CodeSessionRecord, result: CodeSettleTurn, lostRuntime = false): CodeTurnSettlement {
        const turn = this.database.prepare(`SELECT ${TURN_COLUMNS} FROM code_turns WHERE session_id = ? AND turn_id = ?`)
            .get(record.sessionId, record.turnId) as TurnRow | undefined;
        if (!turn) throw new CodeStoreError('turn_not_found', 'Code turn not found', 404);
        const turnId = turn.turn_id;
        const errorChars = Math.min(CODE_ERROR_MAX_CHARS, Math.floor(this.limits.maxEventBytes / 16));
        const error = result.error ? { ...mapError(result.error)!, code: result.error.code.slice(0, 64), message: result.error.message.slice(0, errorChars) } : null;
        const now = this.now();
        const events: CodeWireEvent[] = [];
        let after = 0;
        while (true) {
            // Fetch only control metadata; a large materialized answer is never
            // loaded or copied into its terminal status event.
            const item = this.database.prepare(`SELECT item_id, first_sequence,
                json_extract(item_json, '$.kind') AS kind, json_extract(item_json, '$.status') AS status
                FROM code_items WHERE session_id = ? AND first_sequence > ?
                AND json_extract(item_json, '$.turnId') = ?
                AND json_extract(item_json, '$.status') IN ('pending', 'running') ORDER BY first_sequence LIMIT 1`)
                .get(record.sessionId, after, turnId) as { item_id: string; first_sequence: number; kind: CodeItem['kind']; status: CodeItem['status'] } | undefined;
            if (!item) break;
            const status = item.kind === 'permission_request' ? 'cancelled'
                : result.status === 'failed' ? 'error' : result.status === 'cancelled' ? 'cancelled'
                    : item.kind === 'tool_call' || item.kind === 'file_change' ? 'cancelled' : 'done';
            record.sequence += 1;
            events.push(this.persistEvent(record, {
                topic: 'code', event: 'code_item_update', sessionId: record.sessionId, sequence: record.sequence, epoch: record.epoch,
                update: { itemId: item.item_id, turnId, firstSequence: item.first_sequence, status, updatedAt: now },
            }, 'settlement', -settlementCost(record.sessionId, { itemId: item.item_id, turnId, status: item.status }), turnId));
            this.database.prepare(`UPDATE code_items SET item_json = json_set(item_json,
                '$.status', ?, '$.updatedAt', ?, '$.firstSequence', first_sequence) WHERE session_id = ? AND item_id = ?`)
                .run(status, now, record.sessionId, item.item_id);
            after = item.first_sequence;
        }
        // A follow-up no native result consumed may never have reached Claude; say so on its item.
        // After a restart every committed follow-up of the turn reads that way.
        const undelivered = new Set(result.undeliveredFollowUps ?? []);
        const steers = this.database.prepare(`SELECT client_turn_key, native_uuid FROM code_steers
            WHERE session_id = ? AND turn_id = ? AND status = 'committed'`).all(record.sessionId, turnId) as Array<{ client_turn_key: string; native_uuid: string | null }>;
        for (const steer of steers) {
            const itemId = `${turnId}:steer:${steer.client_turn_key}`;
            const projected = this.database.prepare('SELECT first_sequence FROM code_items WHERE session_id = ? AND item_id = ?')
                .get(record.sessionId, itemId) as { first_sequence: number } | undefined;
            const unconfirmed = lostRuntime || (steer.native_uuid !== null && undelivered.has(steer.native_uuid));
            if (!unconfirmed || !projected) continue;
            record.sequence += 1;
            events.push(this.persistEvent(record, {
                topic: 'code', event: 'code_item_update', sessionId: record.sessionId, sequence: record.sequence, epoch: record.epoch,
                update: { itemId, turnId, firstSequence: projected.first_sequence, phase: 'unknown', updatedAt: now },
            }, 'settlement', -settlementCost(record.sessionId, { itemId, turnId, status: 'pending' }), turnId));
            this.database.prepare(`UPDATE code_items SET item_json = json_set(item_json, '$.phase', 'unknown', '$.updatedAt', ?)
                WHERE session_id = ? AND item_id = ?`).run(now, record.sessionId, itemId);
        }
        // A reservation still open here may already have been offered to the runtime: its key answers
        // unknown (never "send it again"), and the turn's slot stays spent.
        this.database.prepare(`UPDATE code_steers SET status = 'unknown' WHERE session_id = ? AND turn_id = ? AND status = 'reserved'`)
            .run(record.sessionId, turnId);
        const kind = result.status === 'completed' ? 'turn_completed' : result.status === 'failed' ? 'turn_failed' : 'turn_cancelled';
        events.push(this.event(record, { itemId: `${record.turnId}:terminal`, turnId: record.turnId, kind,
            status: result.status === 'completed' ? 'done' : result.status === 'failed' ? 'error' : 'cancelled',
            ...(error ? { text: error.message } : {}), createdAt: now, updatedAt: now }, 'settlement', turnId));
        this.database.prepare('UPDATE code_turns SET status = ? WHERE session_id = ? AND turn_id = ?')
            .run(result.status, record.sessionId, record.turnId);
        // A prompt that never reached the native runtime is absent from its history.
        if (result.dispatched === false) {
            this.database.prepare('UPDATE code_turns SET native_prompt_uuid = NULL WHERE session_id = ? AND turn_id = ?')
                .run(record.sessionId, record.turnId);
            record.rollbackSince = this.readRollbackSince(record.sessionId);
        }
        record.turnId = null;
        record.status = result.status === 'failed' ? 'failed' : 'idle';
        record.error = error;
        record.lastUsedAt = now;
        // The unread clock: a user-stopped turn is one they were watching, so it does not count.
        if (result.status !== 'cancelled') record.lastTurnCompletedAt = now;
        events.push(this.event(record, undefined, 'settlement', turnId));
        return { session: toCodeSessionInfo(record), events, receipt: { ...receipt(turn), status: result.status } };
    }

    settleTurn(owner: CodeStoreOwner, result: CodeSettleTurn): CodeTurnSettlement {
        return this.write(() => {
            const record = this.requireRecord(owner.sessionId);
            if (record.epoch === owner.epoch && record.turnId === null && owner.turnId !== null) {
                const previous = this.database.prepare(`SELECT ${TURN_COLUMNS} FROM code_turns WHERE session_id = ? AND turn_id = ?`)
                    .get(owner.sessionId, owner.turnId) as TurnRow | undefined;
                if (previous && previous.status !== 'accepted' && previous.status !== 'running') {
                    return { session: toCodeSessionInfo(record), events: [], receipt: receipt(previous) };
                }
            }
            this.checkOwner(owner);
            if (record.turnId === null || !isBusy(record.status)) throw new CodeStoreError('stale_owner', 'Code turn is no longer active', 409);
            return this.finish(record, result);
        });
    }

    patchSession(sessionId: string, patch: CodePatchSessionRequest): CodeStoreMutation {
        return this.write(() => {
            const record = this.requireRecord(sessionId);
            if (record.revision !== patch.expectedRevision) throw new CodeStoreError('revision_conflict', 'Code metadata changed', 409);
            const policyChange = patch.model !== undefined || patch.effort !== undefined || patch.permissionMode !== undefined
                || patch.thinking !== undefined;
            if (isBusy(record.status) && (policyChange || patch.archived !== undefined)) {
                throw new CodeStoreError('session_busy', 'Active Code sessions cannot change policy or archive', 409);
            }
            if (patch.title !== undefined) record.title = patch.title;
            if (patch.model !== undefined) record.model = patch.model;
            if (patch.effort !== undefined) record.effort = patch.effort;
            if (patch.permissionMode !== undefined) record.permissionMode = patch.permissionMode;
            if (patch.thinking !== undefined) record.thinking = patch.thinking;
            if (patch.archived !== undefined) record.archivedAt = patch.archived ? record.archivedAt ?? this.now() : null;
            // Invalidates idle runtime callbacks after reconfiguration or archive.
            if (policyChange || patch.archived !== undefined) record.epoch += 1;
            record.revision += 1;
            record.lastUsedAt = this.now();
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** Kept and later turns around a settled `${turnId}:user` target; removed turns are not part of the conversation. */
    private rollbackTurns(record: CodeSessionRecord, upToItemId: string): { kept: PlanTurnRow[]; later: PlanTurnRow[] } {
        const item = this.database.prepare(`SELECT json_extract(item_json, '$.kind') AS kind, json_extract(item_json, '$.turnId') AS turn_id
            FROM code_items WHERE session_id = ? AND item_id = ?`).get(record.sessionId, upToItemId) as { kind: unknown; turn_id: unknown } | undefined;
        const turnId = item?.turn_id;
        if (!item || item.kind !== 'user_message' || typeof turnId !== 'string' || `${turnId}:user` !== upToItemId) {
            throw new CodeStoreError('rollback_target_not_found', 'Rollback target is not a turn in this conversation', 404);
        }
        const turns = this.database.prepare(`SELECT turn_id, status, accepted_sequence, native_prompt_uuid FROM code_turns
            WHERE session_id = ? AND removed_generation IS NULL ORDER BY accepted_sequence`).all(record.sessionId) as PlanTurnRow[];
        const index = turns.findIndex(turn => turn.turn_id === turnId);
        const target = turns[index];
        if (!target) throw new CodeStoreError('rollback_target_not_found', 'Rollback target is not a turn in this conversation', 404);
        if (target.status !== 'completed' && target.status !== 'failed' && target.status !== 'cancelled') {
            throw new CodeStoreError('session_busy', 'The rollback target has not settled', 409);
        }
        return { kept: turns.slice(0, index + 1), later: turns.slice(index + 1) };
    }

    /**
     * Validate a rollback to the item's turn without writing anything. The target and the
     * first later turn that carries a boundary must both have one; the provider then proves
     * both are present in native history before any fork.
     */
    readRollbackPlan(sessionId: string, upToItemId: string): CodeRollbackPlan {
        return this.database.transaction(() => {
            const record = this.requireRecord(sessionId);
            if (record.archivedAt !== null) throw new CodeStoreError('session_archived', 'Code session is archived', 409);
            if (record.provider !== 'claude' || !record.nativeCursor) throw new CodeStoreError('rollback_unavailable', 'Conversation history is unavailable', 409);
            const { kept, later } = this.rollbackTurns(record, upToItemId);
            const target = kept.at(-1)!;
            if (!later.length) throw new CodeStoreError('rollback_noop', 'The target is already the latest turn', 409);
            if (target.native_prompt_uuid === null || !later.some(turn => turn.native_prompt_uuid !== null)) {
                throw new CodeStoreError('rollback_boundary_unavailable', 'This turn has no recorded conversation boundary', 409);
            }
            const turn = (row: PlanTurnRow): CodeRollbackTurn => ({ turnId: row.turn_id, promptUuid: row.native_prompt_uuid });
            return { target: { turnId: target.turn_id, promptUuid: target.native_prompt_uuid }, kept: kept.map(turn),
                later: later.map(turn), revision: record.revision, epoch: record.epoch, nativeCursor: record.nativeCursor,
                title: record.title };
        })();
    }

    /**
     * Commit a verified fork in one transaction, compare-and-swap on the revision, epoch and
     * native cursor the plan was read at. Later items and their events leave; their turn rows
     * stay so client keys keep answering, marked removed. Replay below the new floor fails with
     * `invalid_sequence`, and the history generation tells live readers to take a snapshot.
     * Follow-up rows (`code_steers`) stay as they are: their keys remain spent and their native
     * ids are not remapped (only a running turn reads them). The follow-up items of removed turns
     * leave with the other later items, and their receipts read cancelled like the turns'.
     */
    commitRollback(input: CodeRollbackCommit): CodeStoreMutation {
        return this.write(() => {
            const record = this.requireRecord(input.sessionId);
            if (record.revision !== input.expectedRevision || record.epoch !== input.expectedEpoch
                || record.nativeCursor !== input.expectedCursor || record.turnId !== null || isBusy(record.status)
                || record.archivedAt !== null || record.provider !== 'claude') {
                throw new CodeStoreError('revision_conflict', 'Code session changed during rollback', 409);
            }
            if (!input.forkCursor.trim() || input.forkCursor === input.expectedCursor) {
                throw new CodeStoreError('invalid_cursor', 'Rollback fork must be a new native session', 400);
            }
            const { kept, later } = this.rollbackTurns(record, input.upToItemId);
            if (!later.length) throw new CodeStoreError('rollback_noop', 'The target is already the latest turn', 409);
            const keptIds = new Set(kept.map(turn => turn.turn_id));
            if (!input.remapped.every(turn => keptIds.has(turn.turnId) && !!turn.promptUuid.trim())
                || !input.cleared.every(turnId => keptIds.has(turnId))) {
                throw new CodeStoreError('rollback_unavailable', 'Rollback boundaries do not match the kept turns', 409);
            }
            const generation = record.historyGeneration + 1;
            const after = kept.at(-1)!.accepted_sequence;
            const cut = (this.database.prepare(`SELECT MIN(first_sequence) AS cut FROM code_items WHERE session_id = ?
                AND json_extract(item_json, '$.turnId') IN (SELECT turn_id FROM code_turns WHERE session_id = ?
                    AND removed_generation IS NULL AND accepted_sequence > ?)`)
                .get(record.sessionId, record.sessionId, after) as { cut: number | null }).cut;
            if (cut !== null) {
                this.database.prepare('DELETE FROM code_items WHERE session_id = ? AND first_sequence >= ?').run(record.sessionId, cut);
                this.database.prepare('DELETE FROM code_events WHERE session_id = ? AND sequence >= ?').run(record.sessionId, cut);
            }
            this.database.prepare(`UPDATE code_turns SET removed_generation = ? WHERE session_id = ?
                AND removed_generation IS NULL AND accepted_sequence > ?`).run(generation, record.sessionId, after);
            // Every source boundary is retired; only the ones found again in the fork return.
            this.database.prepare('UPDATE code_turns SET native_prompt_uuid = NULL WHERE session_id = ?').run(record.sessionId);
            const remap = this.database.prepare('UPDATE code_turns SET native_prompt_uuid = ? WHERE session_id = ? AND turn_id = ?');
            for (const turn of input.remapped) remap.run(turn.promptUuid, record.sessionId, turn.turnId);
            record.historyGeneration = generation;
            record.nativeCursor = input.forkCursor;
            record.nativeStarted = true;
            record.revision += 1;
            record.epoch += 1;
            record.status = 'idle';
            record.error = null;
            record.lastUsedAt = this.now();
            record.rollbackSince = this.readRollbackSince(record.sessionId);
            record.replayFloorSequence = record.sequence + 1;
            const events = [this.event(record)];
            return { session: toCodeSessionInfo(record), events };
        });
    }

    /** Call once before the manager admits work. Never replays a native prompt. */
    recoverInterrupted(): CodeWireEvent[] {
        return this.write(() => {
            const rows = this.database.prepare(`SELECT ${SESSION_COLUMNS} FROM code_sessions
                WHERE status IN ('starting', 'streaming', 'stopping')`).all() as SessionRow[];
            const events: CodeWireEvent[] = [];
            for (const row of rows) {
                const record = rowToRecord(row);
                record.epoch += 1;
                const error: CodeSessionError = { code: 'orphaned_turn', message: 'Code turn interrupted by server restart', at: this.now(), recoverable: true };
                // A turn is marked streaming before its prompt is handed to the runtime, so one still
                // starting never sent it: its boundary cannot be in native history.
                if (record.turnId !== null) {
                    events.push(...this.finish(record, { status: 'failed', error, ...(row.status === 'starting' ? { dispatched: false } : {}) }, true).events);
                } else {
                    record.status = 'failed';
                    record.error = error;
                    events.push(this.event(record));
                }
            }
            return events;
        });
    }
}
