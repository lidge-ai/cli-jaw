// ─── Database: schema + prepared statements ──────────

import Database from 'better-sqlite3';
import { initSessionGeneration } from './session-generation.js';
import fs from 'fs';
import { dirname } from 'path';
import { DB_PATH } from './config.js';
import { stripStallTruncationNotice } from '../agent/stall-notice.js';
import { migrateOversizedToolLogs } from './db-maintenance.js';

function ensureDbDirExists(dbPath: string) {
    const dbDir = dirname(dbPath);
    if (!dbDir) return;
    fs.mkdirSync(dbDir, { recursive: true });
}

function checkOrphanedWal(dbPath: string) {
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (!fs.existsSync(dbPath) && (fs.existsSync(walPath) || fs.existsSync(shmPath))) {
        console.error('[db] ⚠️  WARNING: WAL/SHM files exist without main DB. Cleaning orphaned files.');
        try { fs.unlinkSync(walPath); } catch { /* ignore */ }
        try { fs.unlinkSync(shmPath); } catch { /* ignore */ }
    }
}

ensureDbDirExists(DB_PATH);
checkOrphanedWal(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// ─── Schema: one baseline + versioned migration steps ────
//
// `PRAGMA user_version` is the schema version. Everything a CURRENT database
// must contain lives in the two baseline strings below; MIGRATIONS carries what
// an EXISTING database still needs to reach that shape. The two have to agree,
// and `assertSchemaComplete` is what makes disagreement loud: a column added
// to the baseline without a matching migration step fails there BY NAME, instead
// of killing the process at the first `db.prepare` further down (#691).
//
// Tables and indexes are separate on purpose. `CREATE TABLE IF NOT EXISTS` is a
// no-op on a database that already has the table, so an index over a column that
// only a migration adds would raise `no such column` on exactly the old homes
// this exists to open — and it would do so BEFORE the step that adds the column.
// Every index therefore runs after the migration steps, not with the tables.

export const SCHEMA_VERSION = 1;

/** A database this binary cannot safely open. Never a `db.prepare` crash. */
export class SchemaMigrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SchemaMigrationError';
    }
}

const BASELINE_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS session (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        -- This SQL default is NOT the product default and has not been for some
        -- time: the runtime resolves settings.cli -> session.active_cli ->
        -- DEFAULT_CLI (src/core/main-session.ts), and DEFAULT_CLI is codex-app.
        -- Changing the literal here would only split fresh databases from existing
        -- ones, since ALTER cannot restate a default on a column that already
        -- exists. Tracked with the other schema/call-site default drift in #696.
        active_cli  TEXT DEFAULT 'claude',
        session_id  TEXT,
        model       TEXT DEFAULT 'default',
        permissions TEXT DEFAULT 'auto',
        working_dir TEXT DEFAULT '~',
        effort      TEXT DEFAULT 'medium',
        active_chat_session TEXT DEFAULT 'default',
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO session (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        cli         TEXT,
        model       TEXT,
        trace       TEXT DEFAULT NULL,
        tool_log    TEXT DEFAULT NULL,
        working_dir TEXT DEFAULT NULL,
        trace_run_id TEXT DEFAULT NULL,
        session_id  TEXT DEFAULT 'default',
        cost_usd    REAL,
        duration_ms INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        value       TEXT NOT NULL,
        source      TEXT DEFAULT 'manual',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employees (
        id          TEXT PRIMARY KEY,
        name        TEXT DEFAULT 'New Agent',
        cli         TEXT DEFAULT 'claude',
        model       TEXT DEFAULT 'default',
        role        TEXT DEFAULT '',
        status      TEXT DEFAULT 'idle',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employee_sessions (
        employee_id TEXT PRIMARY KEY,
        session_id  TEXT,
        cli         TEXT,
        model       TEXT DEFAULT '',
        output_len  INTEGER DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orc_state (
        id         TEXT PRIMARY KEY DEFAULT 'default',
        state      TEXT DEFAULT 'IDLE',
        ctx        TEXT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO orc_state (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL UNIQUE,
        label       TEXT DEFAULT NULL,
        active_run_policy TEXT DEFAULT NULL,
        generation  INTEGER NOT NULL DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO chat_sessions (id, seq) VALUES ('default', 0);

    CREATE TABLE IF NOT EXISTS remote_session_bindings (
        remote_key      TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL UNIQUE,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS queued_messages (
        id         TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- #321: "already handled" has to survive a restart, because "still to
    -- handle" does. The queue above is durable while the ingress dedupe was
    -- process memory, so a reconnect before Slack observed our ACK could admit
    -- the same delivery twice under the next lifecycle. Rows are written only
    -- AFTER a run is admitted and expire on the same 10-minute redelivery
    -- horizon as the in-memory map.
    CREATE TABLE IF NOT EXISTS slack_event_dedup (
        event_key  TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
    );

    -- Per-bucket resumable session storage. Bucket key is a stable CLI+model-family
    -- identifier (e.g. 'codex', 'codex-spark', 'claude'). Prevents cross-model resume
    -- errors like 'thread/resume failed: no rollout found' when the user toggles
    -- between gpt-5.4 and gpt-5.3-codex-spark on the same codex CLI.
    CREATE TABLE IF NOT EXISTS session_buckets (
        bucket      TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        model       TEXT NOT NULL,
        resume_key  TEXT DEFAULT NULL,
        output_len  INTEGER DEFAULT 0,
        memory_snapshot TEXT DEFAULT NULL,
        last_run_clean INTEGER DEFAULT NULL,
        last_run_cwd TEXT DEFAULT NULL,
        last_run_meta TEXT DEFAULT NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Mention-watch bookkeeping, split in two on purpose.
    --
    -- The cursor answers "how far did we read this channel", so the next scan
    -- can ask Slack for a window instead of the same 50 messages forever. The
    -- seen ledger answers "which messages did we already hand to the agent",
    -- which is a different question: a tick that dies midway would otherwise
    -- either re-answer messages it already handled or skip ones it never did.
    --
    -- The cursor is a FRONTIER, not an optimistic high-water mark: it stops at
    -- the first mention still awaiting an answer, so it can sit BEHIND rows the
    -- seen ledger already holds. That is why the two must be separate, and why
    -- pruning is bounded by the cursor rather than by row count.
    --
    -- resume_before carries an unfinished backward walk across ticks. Reading
    -- history newest-first means a busy channel needs several windows to reach
    -- the cursor; without remembering where the descent stopped, the next tick
    -- restarts at the newest message and the backlog below is never reached.
    --
    -- Neither expires on a timer. The slack_event_dedup table above can afford
    -- a 10-minute horizon because it guards against a vendor REDELIVERING one
    -- event; here the same message stays visible in channel history forever, so
    -- a TTL would mean answering it again a day later.
    CREATE TABLE IF NOT EXISTS mention_watch_seen (
        job_id     TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, channel_id, message_ts)
    );

    CREATE TABLE IF NOT EXISTS mention_watch_cursor (
        job_id        TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        last_ts       TEXT NOT NULL,
        resume_before TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, channel_id)
    );

    -- Which channel the last tick finished on, so the next one starts after it.
    -- The hit cap is global, so always starting at the first configured channel
    -- lets a busy channel starve every channel behind it permanently.
    CREATE TABLE IF NOT EXISTS mention_watch_rotation (
        job_id          TEXT PRIMARY KEY,
        last_channel_id TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
    );

    -- v2: the ledger is keyed by WATCH IDENTITY, not by job id alone.
    --
    -- A job id is reusable. PUT /api/heartbeat accepts whatever id the client
    -- sends and mints hb_<millis>_<index> otherwise, with no uniqueness check,
    -- so the same id can name a different watch later. Under the v1 key that
    -- inherited the old cursor, and a cursor outranks the since floor: the new watch
    -- silently skipped everything below it. Missing a mention is the one outcome
    -- this feature exists to prevent, so identity belongs in the key.
    --
    -- Identity is (workspace, user), not user alone: Slack identifies a person as
    -- (team_id, id) and the runtime can re-authenticate against another workspace
    -- without restarting. src/slack/identity.ts keys its cache the same way for
    -- the same reason.
    --
    -- Separate columns rather than one packed string, because a delimiter that
    -- appears in an id would make two identities collide, and nothing validates
    -- the shape of a Slack id beyond non-emptiness.
    --
    -- With the key carrying identity, stale rows are unreachable rather than
    -- wrong: a different watch never reads them. That is why there is no
    -- automatic cleanup — a job absent from the file is not a dead identity, it
    -- is a dormant one that may return under the same key and should resume.
    CREATE TABLE IF NOT EXISTS mention_watch_seen_v2 (
        job_id       TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        message_ts   TEXT NOT NULL,
        seen_at      INTEGER NOT NULL,
        PRIMARY KEY (job_id, workspace_id, user_id, channel_id, message_ts)
    );

    CREATE TABLE IF NOT EXISTS mention_watch_cursor_v2 (
        job_id        TEXT NOT NULL,
        workspace_id  TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        last_ts       TEXT NOT NULL,
        resume_before TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, workspace_id, user_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS mention_watch_rotation_v2 (
        job_id          TEXT NOT NULL,
        workspace_id    TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        last_channel_id TEXT NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (job_id, workspace_id, user_id)
    );

    -- Live capture of third-party mentions, filled from the Socket Mode stream.
    --
    -- The polling scan reads conversations.history, and history NEVER returns
    -- thread replies. A mention posted inside a thread is therefore invisible to
    -- it, no matter how often it runs. The event stream already carries every
    -- such message into this process, so the honest fix is to keep it instead of
    -- dropping it at the gate and then trying to find it again over HTTP.
    --
    -- Rows are claims, not receipts: the tick deletes one only after it has
    -- decided what to do with that message. A crash before that leaves the row
    -- for the next tick, which matches the at-least-once guarantee the seen
    -- ledger already provides.
    CREATE TABLE IF NOT EXISTS mention_watch_inbox (
        workspace_id TEXT NOT NULL,
        subject_id   TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        message_ts   TEXT NOT NULL,
        thread_ts    TEXT,
        author_id    TEXT,
        bot_id       TEXT,
        subtype      TEXT,
        text         TEXT NOT NULL,
        captured_at  INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, subject_id, channel_id, message_ts)
    );

    -- v1 rows cannot be migrated: nobody recorded WHICH workspace and user they
    -- belonged to, and guessing is exactly the misattribution the v2 key exists
    -- to prevent. Leaving them behind is not free either — a watch that starts
    -- with no cursor walks backward through all reachable history and re-answers
    -- what it already answered.
    --
    -- So such a job is QUARANTINED: held out of scheduling regardless of the
    -- enabled flag in heartbeat.json, until an operator explicitly restarts it
    -- with a fresh since floor. The state is durable and lives here rather than in
    -- the config file: the file is the operator's intent, quarantine is the
    -- system's judgement, and writing both to one place lets each erase the other.
    -- It also has to survive a job being absent at upgrade time and returning
    -- under the same id later, which a one-shot check at table creation would miss.
    CREATE TABLE IF NOT EXISTS legacy_mention_watch_quarantine (
        job_id      TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution  TEXT
    );

    -- Where a resolved job's v1 rows go. Kept rather than dropped: they are the
    -- record of what that job actually answered, and an operator judging a
    -- re-quarantine needs to be able to look.
    CREATE TABLE IF NOT EXISTS legacy_mention_watch_archive (
        table_name  TEXT NOT NULL,
        job_id      TEXT NOT NULL,
        channel_id  TEXT,
        message_ts  TEXT,
        payload     TEXT NOT NULL,
        archived_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeat_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id        TEXT,
        job_name      TEXT NOT NULL,
        origin        TEXT NOT NULL DEFAULT 'heartbeat',
        working_dir   TEXT,
        channel       TEXT,
        chat_id       TEXT,
        prompt        TEXT,
        output        TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        delivered_at  INTEGER,
        consumed_at   INTEGER,
        visible       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jaw_ceo_transcript (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        source      TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trace_runs (
        id TEXT PRIMARY KEY,
        message_id INTEGER,
        parent_run_id TEXT,
        cli TEXT NOT NULL,
        model TEXT,
        working_dir TEXT,
        agent_label TEXT,
        audience TEXT NOT NULL DEFAULT 'public',
        status TEXT NOT NULL DEFAULT 'running',
        raw_retention_status TEXT NOT NULL DEFAULT 'available',
        event_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        last_event_at INTEGER,
        error TEXT,
        session_id TEXT,
        scope_key TEXT
    );

    CREATE TABLE IF NOT EXISTS trace_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        preview TEXT,
        raw_json TEXT,
        raw_path TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        retention_status TEXT NOT NULL DEFAULT 'available',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES trace_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS background_tasks (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL,
        pid           INTEGER,
        origin_meta   TEXT,
        result        TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at    DATETIME,
        deadline_at   DATETIME,
        completed_at  DATETIME,
        notified_at   DATETIME
    );
`;

const BASELINE_INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_remote_bindings_chat_session
        ON remote_session_bindings(chat_session_id);
    CREATE INDEX IF NOT EXISTS idx_mention_watch_seen_job
        ON mention_watch_seen (job_id, seen_at);
    CREATE INDEX IF NOT EXISTS idx_mention_watch_seen_v2_ns
        ON mention_watch_seen_v2 (job_id, workspace_id, user_id, seen_at);
    CREATE INDEX IF NOT EXISTS idx_legacy_mention_watch_archive_job
        ON legacy_mention_watch_archive (job_id, table_name);
    CREATE INDEX IF NOT EXISTS idx_jaw_ceo_transcript_at ON jaw_ceo_transcript(at);
    CREATE INDEX IF NOT EXISTS idx_trace_runs_message ON trace_runs(message_id);
    CREATE INDEX IF NOT EXISTS idx_trace_runs_started ON trace_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_trace_events_run_seq ON trace_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);

    -- Indexes over columns that only a migration step adds to an older database.
    -- They are the reason indexes run after MIGRATIONS rather than with the tables.
    CREATE INDEX IF NOT EXISTS idx_messages_wd ON messages(working_dir);
    CREATE INDEX IF NOT EXISTS idx_messages_trace_run ON messages(trace_run_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_trace_runs_session ON trace_runs(session_id, id);

    CREATE INDEX IF NOT EXISTS idx_trace_runtime ON trace_events(run_id, seq) WHERE source = 'runtime';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trace_runtime_control ON trace_events(run_id)
        WHERE source = 'system' AND event_type = 'runtime.control.v1';
`;

type MigrationStep = {
    version: number;
    describe: string;
    apply(database: Database.Database): void;
};

function tableColumns(database: Database.Database, table: string): Set<string> {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map(row => row.name));
}

/** Additive and idempotent, so a step interrupted halfway simply reruns. */
function addColumnIfMissing(
    database: Database.Database,
    table: string,
    column: string,
    ddl: string,
): void {
    if (tableColumns(database, table).has(column)) return;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const MIGRATIONS: readonly MigrationStep[] = [
    {
        version: 1,
        describe: 'adopt the columns that predate user_version',
        apply(database) {
            // Every column here also exists in BASELINE_TABLES_SQL. A fresh database
            // gets it from CREATE; a database made before the column existed gets it
            // here. Both paths must end at the same shape, which is what the
            // fresh-vs-migrated parity test asserts.
            addColumnIfMissing(database, 'trace_runs', 'session_id', 'session_id TEXT');
            addColumnIfMissing(database, 'trace_runs', 'scope_key', 'scope_key TEXT');
            addColumnIfMissing(database, 'messages', 'trace', 'trace TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'messages', 'tool_log', 'tool_log TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'messages', 'working_dir', 'working_dir TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'messages', 'trace_run_id', 'trace_run_id TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'messages', 'session_id', "session_id TEXT DEFAULT 'default'");
            addColumnIfMissing(database, 'session', 'active_chat_session', "active_chat_session TEXT DEFAULT 'default'");
            addColumnIfMissing(database, 'chat_sessions', 'active_run_policy', 'active_run_policy TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'chat_sessions', 'generation', 'generation INTEGER NOT NULL DEFAULT 0');
            addColumnIfMissing(database, 'employee_sessions', 'model', "model TEXT DEFAULT ''");
            addColumnIfMissing(database, 'employee_sessions', 'output_len', 'output_len INTEGER DEFAULT 0');
            addColumnIfMissing(database, 'session_buckets', 'resume_key', 'resume_key TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'session_buckets', 'output_len', 'output_len INTEGER DEFAULT 0');
            // Frozen task snapshot per resume chain (#prompt-cache): regenerated only
            // on fresh spawns, reused byte-identical across resume turns so the system
            // prompt prefix stays cacheable. Dies with the bucket row on any clear.
            addColumnIfMissing(database, 'session_buckets', 'memory_snapshot', 'memory_snapshot TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'session_buckets', 'last_run_clean', 'last_run_clean INTEGER DEFAULT NULL');
            addColumnIfMissing(database, 'session_buckets', 'last_run_cwd', 'last_run_cwd TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'session_buckets', 'last_run_meta', 'last_run_meta TEXT DEFAULT NULL');
            addColumnIfMissing(database, 'mention_watch_cursor', 'resume_before', 'resume_before TEXT DEFAULT NULL');
            // Only the original message link can establish a historical owner. Forked
            // copies also carry trace_run_id, so backfilling from that column would
            // steal ownership.
            database.exec(`UPDATE trace_runs SET session_id = (SELECT session_id FROM messages WHERE id = trace_runs.message_id)
                WHERE session_id IS NULL AND message_id IS NOT NULL`);
        },
    },
];

/** The shape a current database must have, read off the baseline itself.
 *
 *  Derived rather than hand-listed: a second hand-written list of expected
 *  columns is one more place to forget the column you just added, which is the
 *  defect this whole mechanism exists to catch. */
function baselineShape(): { columns: Map<string, Set<string>>; indexes: Set<string> } {
    const probe = new Database(':memory:');
    try {
        probe.exec(BASELINE_TABLES_SQL);
        probe.exec(BASELINE_INDEXES_SQL);
        const columns = new Map<string, Set<string>>();
        const tableRows = probe.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ).all() as { name: string }[];
        for (const row of tableRows) columns.set(row.name, tableColumns(probe, row.name));
        const indexRows = probe.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
        ).all() as { name: string }[];
        return { columns, indexes: new Set(indexRows.map(row => row.name)) };
    } finally {
        probe.close();
    }
}

/** Expected is a SUBSET of actual, never an equality.
 *
 *  The live database legitimately carries more than the baseline: migrateSearchFts
 *  adds the FTS5 virtual tables and their shadow tables, and db-maintenance keeps
 *  its own bookkeeping. Only a MISSING object is a problem. */
export function assertSchemaComplete(database: Database.Database): void {
    const expected = baselineShape();
    const missing: string[] = [];
    for (const [table, wanted] of expected.columns) {
        const actual = tableColumns(database, table);
        if (actual.size === 0) { missing.push(`table:${table}`); continue; }
        for (const column of wanted) if (!actual.has(column)) missing.push(`${table}.${column}`);
    }
    const actualIndexes = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]).map(row => row.name));
    for (const name of expected.indexes) if (!actualIndexes.has(name)) missing.push(`index:${name}`);
    if (missing.length === 0) return;
    throw new SchemaMigrationError(
        `database schema is incomplete at ${DB_PATH}: missing ${missing.join(', ')}. `
        + 'This means the baseline schema in src/core/db.ts gained something that no '
        + 'MIGRATIONS step adds to an existing database. Add the step (and bump '
        + 'SCHEMA_VERSION) rather than relying on CREATE TABLE, which is a no-op here.',
    );
}

/** Bring `database` to SCHEMA_VERSION, or refuse to open it with a reason. */
export function applySchema(database: Database.Database): void {
    database.exec(BASELINE_TABLES_SQL);
    const found = Number(database.pragma('user_version', { simple: true }) ?? 0);
    if (found > SCHEMA_VERSION) {
        throw new SchemaMigrationError(
            `database at ${DB_PATH} was written by a newer cli-jaw (schema v${found}, `
            + `this build understands v${SCHEMA_VERSION}). Upgrade cli-jaw instead of `
            + 'downgrading the database; migrating backwards would drop data.',
        );
    }
    // Skipped entirely once the database is current, so an ordinary boot never
    // takes a write lock. When work IS due, BEGIN IMMEDIATE serializes it: two
    // processes starting on the same old home would otherwise both read version 0
    // and both run ALTER, and the loser died with 'duplicate column name'. The
    // version is re-read inside the lock, so the loser now sees the winner's work.
    if (found !== SCHEMA_VERSION) {
        database.transaction(() => {
            const from = Number(database.pragma('user_version', { simple: true }) ?? 0);
            if (from > SCHEMA_VERSION) return;
            for (const step of MIGRATIONS) if (step.version > from) step.apply(database);
            database.pragma(`user_version = ${SCHEMA_VERSION}`);
        }).immediate();
    }
    database.exec(BASELINE_INDEXES_SQL);
    assertSchemaComplete(database);
}

applySchema(db);

const migratedToolLogs = migrateOversizedToolLogs(db);
if (migratedToolLogs > 0) {
    console.log(`[db:migrate] sanitized ${migratedToolLogs} oversized tool_log row(s)`);
}

const SEARCH_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, tool_log, session_id UNINDEXED,
    content='messages', content_rowid='id', tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trigram USING fts5(
    content, tool_log, session_id UNINDEXED,
    content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_search_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
    INSERT INTO messages_trigram(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_trigram(messages_trigram, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_fts(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
    INSERT INTO messages_trigram(messages_trigram, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_trigram(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
END;
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO messages_trigram(messages_trigram) VALUES('rebuild');
`;

function hasSearchFts(database: Database.Database, name: string): boolean {
    return Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name));
}

const SEARCH_FTS_TRIGGERS = ['messages_search_ai', 'messages_search_ad', 'messages_search_au'] as const;

function hasSearchTrigger(database: Database.Database, name: string): boolean {
    return Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name));
}

/**
 * The tables alone are not a usable index. If a trigger is missing — an
 * interrupted upgrade, a restored dump, a manual DROP — the tables still exist
 * while new messages never reach them, so search silently returns stale
 * results. Probe the whole schema, not just the tables.
 */
function searchFtsSchemaComplete(database: Database.Database): boolean {
    return hasSearchFts(database, 'messages_fts')
        && hasSearchFts(database, 'messages_trigram')
        && SEARCH_FTS_TRIGGERS.every(name => hasSearchTrigger(database, name));
}

/** Create and verify the external-content chat indexes without version metadata. */
export function migrateSearchFts(database: Database.Database): boolean {
    if (searchFtsSchemaComplete(database)) return true;
    try {
        database.transaction(() => {
            database.exec(SEARCH_FTS_SQL);
            const sentinel = `jaw_fts_probe_${Date.now()}_xyz`;
            const inserted = database.prepare(
                "INSERT INTO messages(role, content, session_id) VALUES('system', ?, 'fts-migration-probe')",
            ).run(sentinel);
            const rowid = Number(inserted.lastInsertRowid);
            const match = `"${sentinel}"`;
            const unicodeHit = database.prepare(
                'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid=?',
            ).get(match, rowid);
            const trigramHit = database.prepare(
                'SELECT rowid FROM messages_trigram WHERE messages_trigram MATCH ? AND rowid=?',
            ).get(match, rowid);
            if (!unicodeHit || !trigramHit) throw new Error('search FTS MATCH probe failed');
            database.prepare(
                "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
            ).run();
            database.prepare(
                "INSERT INTO messages_trigram(messages_trigram, rank) VALUES('integrity-check', 1)",
            ).run();
            database.prepare('DELETE FROM messages WHERE id=?').run(rowid);
        })();
        return true;
    } catch (error) {
        console.warn('[search] FTS migration unavailable; LIKE remains active:',
            error instanceof Error ? error.message : String(error));
        return false;
    }
}

const searchFtsReady = migrateSearchFts(db);

// ─── Prepared Statements ─────────────────────────────

export const getSession = () => db.prepare('SELECT * FROM session WHERE id = ?').get('default');
export const updateSession = db.prepare(`
    UPDATE session SET active_cli=?, session_id=?, model=?, permissions=?, working_dir=?, effort=?, updated_at=CURRENT_TIMESTAMP
    WHERE id='default'
`);
// Background runtime hook tasks (src/bgtask/) — registration is durable so
// server restarts can recover watchers and re-deliver unsent notifications.
// Prepared statements live in src/bgtask/registry.ts (module-local); the table
// itself is part of BASELINE_TABLES_SQL above.

export const insertMessage = db.prepare('INSERT INTO messages (role, content, cli, model, trace, working_dir, session_id) VALUES (?, ?, ?, ?, NULL, ?, ?)');
export const insertMessageWithTrace = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
export const insertMessageWithTraceRun = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir, trace_run_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
export const getMessages = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id ASC');
// Two rows distinguish a unique saved answer from ambiguity without loading a
// whole transcript. Oversized content never crosses the SQLite -> JS boundary.
export const getSavedActivityAnswer = db.prepare(`
    SELECT id, role, trace_run_id, session_id,
        CASE WHEN length(CAST(content AS BLOB)) <= @maxBytes THEN content ELSE NULL END AS content,
        length(CAST(content AS BLOB)) AS content_bytes
    FROM messages INDEXED BY idx_messages_trace_run
    WHERE trace_run_id = @runId AND session_id = @sessionId AND role = 'assistant'
    ORDER BY id ASC LIMIT 2
`);
const maxMessageIdStmt = db.prepare('SELECT MAX(id) AS maxId FROM messages WHERE session_id = ?');
const steerSalvageStmt = db.prepare(`SELECT content FROM messages
    WHERE session_id = ? AND id > ? AND role = 'assistant' AND content LIKE '⏹️ [interrupted]%'
    ORDER BY id ASC LIMIT 1`);

/** Snapshot of the newest message id in a session, taken before a steer kill. */
export function getMaxMessageId(sessionId: string): number {
    const row = maxMessageIdStmt.get(sessionId) as { maxId?: number | null } | undefined;
    return typeof row?.maxId === 'number' ? row.maxId : 0;
}

/**
 * Salvage identity for kill-path steer. The interrupted assistant row is the
 * first ⏹️-tagged assistant message with id greater than the pre-kill snapshot.
 * created_at comparisons are NOT safe here: the column is second-resolution UTC
 * and same-second collisions across concurrent scopes misattribute salvage.
 */
export function getSteerSalvageAfter(sessionId: string, afterId: number): string | null {
    const row = steerSalvageStmt.get(sessionId, afterId) as { content?: string } | undefined;
    return typeof row?.content === 'string' ? row.content : null;
}
export const searchMessages = db.prepare(`
    SELECT id, role, content, cli, tool_log, created_at,
           CASE WHEN content LIKE '%' || $q || '%' THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages
    WHERE (content LIKE '%' || $q || '%' OR tool_log LIKE '%' || $q || '%')
      AND session_id = $session_id
      AND ($days IS NULL OR created_at >= datetime('now', '-' || $days || ' days'))
      AND ($recent IS NULL OR id >= COALESCE(
        (SELECT id FROM messages WHERE session_id = $session_id ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
      ))
   ORDER BY id DESC
   LIMIT $limit
`);

export const searchMessagesAllSessions = db.prepare(`
    SELECT id, role, content, cli, tool_log, created_at, session_id,
           CASE WHEN content LIKE '%' || $q || '%' THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages
    WHERE (content LIKE '%' || $q || '%' OR tool_log LIKE '%' || $q || '%')
      AND ($days IS NULL OR created_at >= datetime('now', '-' || $days || ' days'))
      AND ($recent IS NULL OR id >= COALESCE(
        (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
      ))
    ORDER BY id DESC
    LIMIT $limit
`);

export type ChatSearchCandidateEngine = 'unicode61' | 'trigram' | 'like';

export interface ChatSearchCandidateParams {
    match: string;
    like: string;
    session_id: string | null;
    days: number | null;
    recent: number | null;
    limit: number;
    offset: number;
}

export interface ChatSearchCandidateRow {
    id: number;
    role: string;
    content: string;
    cli: string | null;
    tool_log: string | null;
    session_id: string;
    created_at: string;
    match_field: 'content' | 'tool_log';
    source_score?: number | null;
}

const CHAT_SEARCH_SCOPE_SQL = `
    AND ($session_id IS NULL OR m.session_id = $session_id)
    AND ($days IS NULL OR m.created_at >= datetime('now', '-' || $days || ' days'))
    AND ($recent IS NULL OR m.id >= COALESCE(
        (SELECT id FROM messages
         WHERE ($session_id IS NULL OR session_id = $session_id)
         ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
    ))
`;

function prepareChatFtsStatement(sql: string): Database.Statement | null {
    if (!searchFtsReady) return null;
    try {
        return db.prepare(sql);
    } catch (error) {
        console.warn('[search] FTS statement unavailable; LIKE remains active:',
            error instanceof Error ? error.message : String(error));
        return null;
    }
}

const searchChatUnicode = prepareChatFtsStatement(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field,
           bm25(messages_fts) AS source_score
    FROM messages_fts
    JOIN messages AS m ON m.id = messages_fts.rowid
    WHERE messages_fts MATCH $match
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY source_score ASC, m.id DESC
    LIMIT $limit OFFSET $offset
`);

const searchChatTrigram = prepareChatFtsStatement(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field,
           bm25(messages_trigram) AS source_score
    FROM messages_trigram
    JOIN messages AS m ON m.id = messages_trigram.rowid
    WHERE messages_trigram MATCH $match
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY source_score ASC, m.id DESC
    LIMIT $limit OFFSET $offset
`);

const searchChatLike = db.prepare(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages AS m
    WHERE (m.content LIKE '%' || $like || '%' ESCAPE '\\'
       OR COALESCE(m.tool_log, '') LIKE '%' || $like || '%' ESCAPE '\\')
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY m.id DESC
    LIMIT $limit OFFSET $offset
`);

/** Execute one provider-only candidate statement; legacy search statements stay unchanged. */
export function searchChatCandidates(
    engine: ChatSearchCandidateEngine,
    params: ChatSearchCandidateParams,
): ChatSearchCandidateRow[] {
    if (engine === 'like') {
        return searchChatLike.all({
            like: params.like,
            session_id: params.session_id,
            days: params.days,
            recent: params.recent,
            limit: params.limit,
            offset: params.offset,
        }) as ChatSearchCandidateRow[];
    }
    const statement = engine === 'trigram' ? searchChatTrigram : searchChatUnicode;
    if (!statement) throw new Error('chat FTS index unavailable');
    return statement.all(params) as ChatSearchCandidateRow[];
}
export const getMessageContext = db.prepare(`
    SELECT id, role, content, cli, created_at
    FROM messages
    WHERE session_id = $session_id
      AND id BETWEEN ($target_id - $range) AND ($target_id + $range)
    ORDER BY id ASC
`);
export const searchMessagesByTimeWindow = db.prepare(`
    SELECT id, role, content, cli, created_at, session_id
    FROM messages
    WHERE created_at BETWEEN datetime($center, '-' || $window_hours || ' hours')
                        AND datetime($center, '+' || $window_hours || ' hours')
      AND (content LIKE '%' || $q || '%' OR ($q2 IS NOT NULL AND content LIKE '%' || $q2 || '%'))
    ORDER BY created_at DESC
    LIMIT $limit
`);
export const getMessagesWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC');
// Recent-window variants: fetch the most recent N rows (DESC + LIMIT) to keep the
// chat boot payload bounded. Callers reverse the result back to ascending order.
export const getRecentMessagesAll = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getRecentMessagesAllWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getMessageCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?');
export const getLatestAssistantMessage = db.prepare("SELECT id, role, content, created_at FROM messages WHERE role = 'assistant' AND session_id = ? ORDER BY id DESC LIMIT 1");
export const getLatestDashboardActivityMessage = db.prepare("SELECT id, role, substr(content, 1, 240) AS excerpt, created_at FROM messages WHERE role IN ('user', 'assistant') AND session_id = ? ORDER BY id DESC LIMIT 1");
const recentMessagesStmt = db.prepare('SELECT id, role, content, cli, model, trace, tool_log, created_at FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');
// Lightweight variant for per-turn callers that only read {role, content}.
// Avoids loading the heavy trace/tool_log blobs that getRecentMessages carries.
const recentMessagesLiteStmt = db.prepare('SELECT role, content FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');

/**
 * These two are the history-replay readers: their rows are fed back to a model
 * as prior turns (prompt history, resume fallback, AGY replay, memory flush,
 * compaction, the P-phase plan). The stored text may end with the notice a
 * watchdog-killed turn shows its READER, and that sentence reads as an
 * instruction when it comes back as context — so it comes off here, once,
 * rather than at each call site that would have to remember (#405).
 *
 * `/api/messages` deliberately does NOT go through this: the transcript is for
 * a person, and leaving the notice out there is what made it vanish on refresh.
 */
function stripNoticeFromRows<T>(rows: T[]): T[] {
    for (const row of rows) {
        const record = row as { content?: unknown };
        if (typeof record.content === 'string') {
            record.content = stripStallTruncationNotice(record.content);
        }
    }
    return rows;
}

export const getRecentMessages = {
    all: (...args: unknown[]) => stripNoticeFromRows(recentMessagesStmt.all(...args as [])),
};

// Ascending and watermark-bounded, for the merged memory flush.
//
// recentMessagesStmt cannot serve it: DESC + LIMIT keeps the NEWEST n rows, which is
// right for a prompt window and wrong for a summariser. If a session ever falls more
// than n rows behind, the newest-n view silently drops the front of that backlog and
// the watermark then commits past the rows nobody read.
const unflushedMessagesStmt = db.prepare(
    'SELECT id, role, content FROM messages'
    + ' WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? AND id > ?'
    + ' ORDER BY id ASC LIMIT ?',
);
export const getUnflushedMessages = {
    all: (...args: unknown[]) => stripNoticeFromRows(unflushedMessagesStmt.all(...args as [])),
};

// Sessions that actually hold rows in scope. Enumerating chat_sessions instead would
// miss rows whose session row was deleted — messages has no foreign key to it.
export const getSessionIdsWithMessages = db.prepare(
    'SELECT DISTINCT session_id FROM messages WHERE (working_dir = ? OR working_dir IS NULL)',
);
export const getRecentMessagesLite = {
    all: (...args: unknown[]) => stripNoticeFromRows(recentMessagesLiteStmt.all(...args as [])),
};
export const getRecentToolLogs = db.prepare('SELECT id, tool_log, created_at FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? AND tool_log IS NOT NULL AND tool_log != \'\' ORDER BY id DESC LIMIT ?');
export const clearMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
export const clearMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
export const clearMessagesScoped = db.prepare('DELETE FROM messages WHERE working_dir = ? AND session_id = ?');
export const insertJawCeoTranscript = db.prepare('INSERT OR REPLACE INTO jaw_ceo_transcript (id, at, role, text, source) VALUES (?, ?, ?, ?, ?)');
export const getJawCeoTranscript = db.prepare('SELECT id, at, role, text, source FROM jaw_ceo_transcript ORDER BY at DESC, created_at DESC LIMIT ?');
export const pruneJawCeoTranscript = db.prepare('DELETE FROM jaw_ceo_transcript WHERE id NOT IN (SELECT id FROM jaw_ceo_transcript ORDER BY at DESC, created_at DESC LIMIT ?)');
export const getMemory = db.prepare('SELECT key, value, source FROM memory ORDER BY updated_at DESC');
export const upsertMemory = db.prepare(`
    INSERT INTO memory (key, value, source) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=CURRENT_TIMESTAMP
`);
export const deleteMemory = db.prepare('DELETE FROM memory WHERE key = ?');
export const getEmployees = db.prepare('SELECT * FROM employees ORDER BY created_at ASC');
export const insertEmployee = db.prepare('INSERT INTO employees (id, name, cli, model, role) VALUES (?, ?, ?, ?, ?)');
export const deleteEmployee = db.prepare('DELETE FROM employees WHERE id = ?');
export const getEmployeeSession = db.prepare('SELECT * FROM employee_sessions WHERE employee_id = ?');
export const upsertEmployeeSession = db.prepare(
    'INSERT OR REPLACE INTO employee_sessions (employee_id, session_id, cli, model, output_len) VALUES (?, ?, ?, ?, ?)'
);
export const clearEmployeeSession = db.prepare('DELETE FROM employee_sessions WHERE employee_id = ?');
export const clearAllEmployeeSessions = db.prepare('DELETE FROM employee_sessions');

// ─── Session Buckets (per-bucket resume storage) ─────
export const getSessionBucket = db.prepare('SELECT bucket, session_id, model, resume_key, output_len, memory_snapshot, updated_at, last_run_clean, last_run_cwd, last_run_meta FROM session_buckets WHERE bucket = ?');
export const copySessionBucketIfMissing = db.prepare(`
    INSERT OR IGNORE INTO session_buckets (
        bucket, session_id, model, resume_key, output_len, memory_snapshot,
        updated_at, last_run_clean, last_run_cwd, last_run_meta
    )
    SELECT ?, session_id, model, resume_key, output_len, memory_snapshot,
        updated_at, last_run_clean, last_run_cwd, last_run_meta
    FROM session_buckets WHERE bucket = ?
`);
export const upsertSessionBucket = db.prepare(`
    INSERT INTO session_buckets (bucket, session_id, model, resume_key, output_len, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(bucket) DO UPDATE SET
        session_id=excluded.session_id,
        model=excluded.model,
        resume_key=excluded.resume_key,
        output_len=excluded.output_len,
        updated_at=CURRENT_TIMESTAMP
`);
// Frozen snapshot write happens at spawn time, before the turn's session id
// exists — the placeholder row ('' session_id stays falsy for resume checks)
// is later completed by upsertSessionBucket, whose DO UPDATE intentionally
// leaves memory_snapshot untouched. updated_at is NOT bumped on conflict so
// a forceNew snapshot write cannot extend a stale bucket's resume TTL.
export const setSessionBucketSnapshot = db.prepare(`
    INSERT INTO session_buckets (bucket, session_id, model, memory_snapshot)
    VALUES (?, '', ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET memory_snapshot=excluded.memory_snapshot
`);
export const clearSessionBucket = db.prepare('DELETE FROM session_buckets WHERE bucket = ?');
const clearSessionBucketsByPrefixStmt = db.prepare(
    "DELETE FROM session_buckets WHERE bucket = ? OR bucket LIKE ? ESCAPE '\\'",
);

// A scope name reaches this statement verbatim, and a remote binding key is
// percent-encoded (`jaw:slack:T1:C%20name`), so it can carry the very characters LIKE
// treats as wildcards. Unescaped, the prefix for one Slack scope would match — and
// delete — every other scope's bucket. The statement already declared an escape
// character; nothing was using it.
export function escapeLikePattern(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Deletes one bucket and everything beneath it. The caller passes the literal prefix,
 * not a LIKE pattern, so the wildcard is appended here — otherwise every caller would
 * have to remember to escape the prefix but not the trailing `%`, and one of them
 * eventually would not.
 */
export const clearSessionBucketsByPrefix = {
    run: (bucket: string, descendantsOf: string) =>
        clearSessionBucketsByPrefixStmt.run(bucket, `${escapeLikePattern(descendantsOf)}%`),
};
export const updateSessionBucketLastRun = db.prepare('UPDATE session_buckets SET last_run_clean=?, last_run_cwd=?, last_run_meta=? WHERE bucket=?');

// ─── Message Queue Persistence ──────────────────────
export const listQueuedMessages = db.prepare('SELECT id, payload FROM queued_messages ORDER BY created_at ASC');
export const insertQueuedMessage = db.prepare('INSERT OR REPLACE INTO queued_messages (id, payload) VALUES (?, ?)');
export const deleteQueuedMessage = db.prepare('DELETE FROM queued_messages WHERE id = ?');
export const clearQueuedMessages = db.prepare('DELETE FROM queued_messages');

// ─── Slack Event Dedupe Persistence (#321) ──────────
export const findSlackEventDedup = db.prepare('SELECT expires_at FROM slack_event_dedup WHERE event_key = ?');
export const insertSlackEventDedup = db.prepare('INSERT OR REPLACE INTO slack_event_dedup (event_key, expires_at) VALUES (?, ?)');
export const sweepSlackEventDedup = db.prepare('DELETE FROM slack_event_dedup WHERE expires_at <= ?');
export const clearSlackEventDedup = db.prepare('DELETE FROM slack_event_dedup');

// ─── Mention watch v1: quarantine surface only ────
//
// Nothing in src/ writes a v1 row. The scanner writes the namespaced v2 ledger
// through src/memory/mention-watch-ledger.ts, and the only v1 reader left is
// src/memory/legacy-mention-watch-quarantine.ts, which holds such a job until an
// operator restarts it with a fresh floor.
//
// What remains here exists so a TEST can build a home that predates the v2 key —
// there is no other way to produce one now. Production code must not import it:
// a v1 write is the workspace-less row shape that fb07276b0 removed, and writing
// one re-creates the misattribution the v2 key exists to prevent. The v1
// read/prune/rotation statements that had no caller at all are gone.
export const legacyMentionWatchV1Fixture = {
    insertSeen: db.prepare(
        'INSERT OR IGNORE INTO mention_watch_seen (job_id, channel_id, message_ts, seen_at) VALUES (?, ?, ?, ?)'),
    upsertCursor: db.prepare(
        'INSERT INTO mention_watch_cursor (job_id, channel_id, last_ts, updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(job_id, channel_id) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at'),
    insertRotation: db.prepare(
        'INSERT OR REPLACE INTO mention_watch_rotation (job_id, last_channel_id, updated_at) VALUES (?, ?, ?)'),
    hasSeen: db.prepare(
        'SELECT 1 FROM mention_watch_seen WHERE job_id = ? AND channel_id = ? AND message_ts = ?'),
} as const;
// ─── Mention watch v2: namespace-scoped ───────────
// Reached only through src/memory/mention-watch-ledger.ts, which requires a
// WatchNamespace. Every predicate below names all three parts of it.
export const findMentionWatchSeenV2 = db.prepare(
    'SELECT 1 FROM mention_watch_seen_v2 WHERE job_id = ? AND workspace_id = ? AND user_id = ? '
    + 'AND channel_id = ? AND message_ts = ?');
export const insertMentionWatchSeenV2 = db.prepare(
    'INSERT OR IGNORE INTO mention_watch_seen_v2 '
    + '(job_id, workspace_id, user_id, channel_id, message_ts, seen_at) VALUES (?, ?, ?, ?, ?, ?)');
/** Bounded by the CURSOR, not by row count. A count-based prune deletes the
    oldest rows regardless of position, and the cursor legitimately sits behind
    them: it stops at the first mention still awaiting an answer while later ones
    in the same window may already be answered. Dropping those receipts would make
    the next scan answer them again. A row at or below the cursor is unreachable
    instead, since the next scan reads strictly above it. Compared numerically
    because a Slack ts is a decimal string whose string order breaks across digit
    counts. */
export const pruneMentionWatchSeenV2 = db.prepare(
    'DELETE FROM mention_watch_seen_v2 WHERE job_id = ? AND workspace_id = ? AND user_id = ? '
    + 'AND channel_id = ? AND CAST(message_ts AS REAL) <= CAST(? AS REAL)');
export const getMentionWatchCursorV2 = db.prepare(
    'SELECT last_ts, resume_before FROM mention_watch_cursor_v2 '
    + 'WHERE job_id = ? AND workspace_id = ? AND user_id = ? AND channel_id = ?');
/** Move the frontier. `resume_before` is left alone: the two advance on different
    conditions, and folding them into one write would clear a pending descent
    every time a cursor moved. */
export const upsertMentionWatchCursorV2 = db.prepare(
    'INSERT INTO mention_watch_cursor_v2 (job_id, workspace_id, user_id, channel_id, last_ts, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(job_id, workspace_id, user_id, channel_id) DO UPDATE SET '
    + 'last_ts = excluded.last_ts, updated_at = excluded.updated_at');
/** Store where an unfinished backward walk stopped, so the next tick descends
    from there instead of re-reading the newest windows. The subquery carries the
    full namespace too — borrowing another watch's last_ts would be exactly the
    cross-identity leak this schema exists to prevent. */
export const setMentionWatchResumeBeforeV2 = db.prepare(
    'INSERT INTO mention_watch_cursor_v2 '
    + '(job_id, workspace_id, user_id, channel_id, last_ts, resume_before, updated_at) '
    + "VALUES (?, ?, ?, ?, COALESCE((SELECT last_ts FROM mention_watch_cursor_v2 "
    + 'WHERE job_id = ? AND workspace_id = ? AND user_id = ? AND channel_id = ?), \'\'), ?, ?) '
    + 'ON CONFLICT(job_id, workspace_id, user_id, channel_id) DO UPDATE SET '
    + 'resume_before = excluded.resume_before, updated_at = excluded.updated_at');
export const getMentionWatchRotationV2 = db.prepare(
    'SELECT last_channel_id FROM mention_watch_rotation_v2 '
    + 'WHERE job_id = ? AND workspace_id = ? AND user_id = ?');
export const upsertMentionWatchRotationV2 = db.prepare(
    'INSERT INTO mention_watch_rotation_v2 (job_id, workspace_id, user_id, last_channel_id, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(job_id, workspace_id, user_id) DO UPDATE SET '
    + 'last_channel_id = excluded.last_channel_id, updated_at = excluded.updated_at');

// ─── Mention watch inbox: live capture ────────────
// Reached only through src/slack/mention-watch-inbox.ts. Keyed by subject rather
// than by job, because two jobs may watch the same person over different channel
// sets and neither should consume the other's rows for a channel it does not own.
export const insertMentionWatchInbox = db.prepare(
    'INSERT OR IGNORE INTO mention_watch_inbox '
    + '(workspace_id, subject_id, channel_id, message_ts, thread_ts, author_id, bot_id, subtype, text, captured_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
/** Oldest first: the mention that has waited longest is answered first, and a
    maxHits cut then drops the newest rather than starving the backlog. */
export const listMentionWatchInbox = db.prepare(
    'SELECT channel_id, message_ts, thread_ts, author_id, bot_id, subtype, text FROM mention_watch_inbox '
    + 'WHERE workspace_id = ? AND subject_id = ? '
    + 'ORDER BY CAST(message_ts AS REAL) ASC LIMIT ?');
export const deleteMentionWatchInbox = db.prepare(
    'DELETE FROM mention_watch_inbox WHERE workspace_id = ? AND subject_id = ? '
    + 'AND channel_id = ? AND message_ts = ?');
/** Age-based, because an undrained row means no job owns that channel any more —
    a watch was narrowed or disabled — and such a row would otherwise sit there
    forever being re-read by every tick. */
export const pruneMentionWatchInbox = db.prepare(
    'DELETE FROM mention_watch_inbox WHERE captured_at < ?');

// ─── Legacy v1 quarantine ─────────────────────────
// Reached only through src/memory/legacy-mention-watch-quarantine.ts.
/** Every job id that still has a v1 ledger row, in any of the three tables. */
export const countLegacyMentionWatchRows = db.prepare(
    'SELECT job_id FROM mention_watch_seen '
    + 'UNION SELECT job_id FROM mention_watch_cursor '
    + 'UNION SELECT job_id FROM mention_watch_rotation');
export const insertLegacyQuarantine = db.prepare(
    "INSERT OR IGNORE INTO legacy_mention_watch_quarantine (job_id, status, detected_at) VALUES (?, 'pending', ?)");
export const getLegacyQuarantine = db.prepare(
    'SELECT job_id, status, resolution FROM legacy_mention_watch_quarantine WHERE job_id = ?');
/** Compare-and-set, so two concurrent approvals cannot both report success. */
export const resolveLegacyQuarantine = db.prepare(
    "UPDATE legacy_mention_watch_quarantine SET status = 'resolved', resolution = ?, resolved_at = ? "
    + "WHERE job_id = ? AND status = 'pending'");
/** A downgrade wrote v1 rows again after this job was resolved. Those receipts
    exist only in v1, so the hold has to come back. */
export const requarantineLegacy = db.prepare(
    "UPDATE legacy_mention_watch_quarantine SET status = 'pending', detected_at = ?, "
    + 'resolved_at = NULL, resolution = NULL WHERE job_id = ?');

// Archive before delete. v1 rows are the record of what that job actually
// answered, and an operator judging a re-quarantine needs to be able to look.
export const archiveLegacySeen = db.prepare(
    "INSERT INTO legacy_mention_watch_archive (table_name, job_id, channel_id, message_ts, payload, archived_at) "
    + "SELECT 'mention_watch_seen', job_id, channel_id, message_ts, "
    + "json_object('seen_at', seen_at), ? FROM mention_watch_seen WHERE job_id = ?");
export const archiveLegacyCursor = db.prepare(
    "INSERT INTO legacy_mention_watch_archive (table_name, job_id, channel_id, message_ts, payload, archived_at) "
    + "SELECT 'mention_watch_cursor', job_id, channel_id, NULL, "
    + "json_object('last_ts', last_ts, 'resume_before', resume_before, 'updated_at', updated_at), ? "
    + 'FROM mention_watch_cursor WHERE job_id = ?');
export const archiveLegacyRotation = db.prepare(
    "INSERT INTO legacy_mention_watch_archive (table_name, job_id, channel_id, message_ts, payload, archived_at) "
    + "SELECT 'mention_watch_rotation', job_id, last_channel_id, NULL, "
    + "json_object('updated_at', updated_at), ? FROM mention_watch_rotation WHERE job_id = ?");
const deleteLegacySeenForJobStmt = db.prepare('DELETE FROM mention_watch_seen WHERE job_id = ?');
const deleteLegacyCursorForJobStmt = db.prepare('DELETE FROM mention_watch_cursor WHERE job_id = ?');
const deleteLegacyRotationForJobStmt = db.prepare('DELETE FROM mention_watch_rotation WHERE job_id = ?');

/** Archive, delete, and flip the status as ONE unit.
 *
 *  Split apart these produce two half-states: resolved with v1 rows still there,
 *  which re-quarantines on the next load, or rows gone while still pending, which
 *  is safe but makes a retry ambiguous. The caller must already have written the
 *  new floor to heartbeat.json and seen the rename succeed — a crash between the
 *  two leaves the file updated and the job still held, which a retry fixes.
 *
 *  The CAS runs FIRST. A losing claim returns rather than throwing, and a plain
 *  return does not roll a better-sqlite3 transaction back — so archiving and
 *  deleting ahead of it would COMMIT the destructive half of an approval that
 *  reported failure. Claiming first means the loser touches nothing, and any
 *  later throw takes the claim down with it.
 *
 *  Returns false when no pending row was there to claim, so a concurrent approval
 *  cannot also report success. */
export const commitLegacyFreshStart = db.transaction((
    jobId: string,
    resolution: string,
    now: number,
): boolean => {
    if (resolveLegacyQuarantine.run(resolution, now, jobId).changes !== 1) return false;
    archiveLegacySeen.run(now, jobId);
    archiveLegacyCursor.run(now, jobId);
    archiveLegacyRotation.run(now, jobId);
    deleteLegacySeenForJobStmt.run(jobId);
    deleteLegacyCursorForJobStmt.run(jobId);
    deleteLegacyRotationForJobStmt.run(jobId);
    return true;
});

// `clearMentionWatchState` used to live here: a v1-only delete with no archive and
// no caller anywhere in the repository. Releasing a held job goes through
// `commitLegacyFreshStart` above, which archives before it deletes and claims the
// quarantine row first. A second, quieter path to the same tables was a way to
// lose the record of what a job had already answered.

type QueuedMessageMigrationPayload = Record<string, unknown> & {
    schemaVersion?: number;
    chatSessionId?: string;
};
const rewriteQueuedMessage = db.prepare('UPDATE queued_messages SET payload = ? WHERE id = ?');
const queuedSessionExists = db.prepare('SELECT 1 FROM chat_sessions WHERE id = ?');

export const migrateQueuedMessagesV1ToV2 = db.transaction((): void => {
    const droppedIds: string[] = [];
    const rows = listQueuedMessages.all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
        let payload: QueuedMessageMigrationPayload;
        try {
            const parsed = JSON.parse(row.payload) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            payload = parsed as QueuedMessageMigrationPayload;
        } catch {
            continue;
        }
        if (payload.schemaVersion === undefined) {
            payload = { ...payload, schemaVersion: 2, scope: 'default', chatSessionId: 'default' };
            rewriteQueuedMessage.run(JSON.stringify(payload), row.id);
        }
        const sessionId = typeof payload.chatSessionId === 'string' ? payload.chatSessionId : 'default';
        if (!queuedSessionExists.get(sessionId)) {
            deleteQueuedMessage.run(row.id);
            droppedIds.push(row.id);
        }
    }
    if (droppedIds.length > 0) {
        console.warn(`[queue:migrate:v2] dropped deleted-session rows: ${droppedIds.join(', ')}`);
    }
});

// ─── Heartbeat Anchor Persistence ───────────────────
export const insertHeartbeatAnchor = db.prepare(
    `INSERT INTO heartbeat_events (job_id, job_name, working_dir, channel, chat_id, prompt, output, created_at, delivered_at, visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
);
export const getLatestUnconsumedAnchor = db.prepare(
    `SELECT * FROM heartbeat_events
     WHERE working_dir = ? AND consumed_at IS NULL AND visible = 1
     ORDER BY created_at DESC LIMIT 1`
);
export const markAnchorConsumed = db.prepare(
    `UPDATE heartbeat_events SET consumed_at = ? WHERE id = ?`
);
export const getUnconsumedAnchors = db.prepare(
    `SELECT id, job_name, output, created_at FROM heartbeat_events
     WHERE consumed_at IS NULL AND visible = 1`
);

// ─── PABCD State Machine ────────────────────────────
export const getOrcState = db.prepare(
    'SELECT * FROM orc_state WHERE id = ?',
);

export const setOrcState = db.prepare(`
    INSERT INTO orc_state (id, state, ctx, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        ctx = excluded.ctx,
        updated_at = CURRENT_TIMESTAMP
`);

export const resetOrcState = db.prepare(`
    INSERT INTO orc_state (id, state, ctx, updated_at)
    VALUES (?, 'IDLE', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        state = 'IDLE',
        ctx = NULL,
        updated_at = CURRENT_TIMESTAMP
`);

export const listActiveOrcStates = db.prepare(
    "SELECT id, state, ctx, updated_at FROM orc_state WHERE state != 'IDLE'"
);

export const resetAllOrcStates = db.prepare(
    "UPDATE orc_state SET state = 'IDLE', ctx = NULL WHERE state != 'IDLE' AND updated_at < datetime('now', '-24 hours')"
);

/** Unconditional reset, for when the caller knows the in-memory runtime is gone.
 *
 *  The stale variant above deliberately spares recent rows so a restart can
 *  resume a live cycle. That guess is wrong after a crash: the workers a phase
 *  was waiting on live in memory and did not survive, so the row describes a
 *  handoff that can never complete and only a human can say so (#452). */
export const resetEveryOrcState = db.prepare(
    "UPDATE orc_state SET state = 'IDLE', ctx = NULL WHERE state != 'IDLE'"
);

export const deleteNonDefaultOrcStates = db.prepare(
    "DELETE FROM orc_state WHERE id != 'default'"
);

/** Checkpoint WAL and close the database. Call once during graceful shutdown. */
export function closeDb(): void {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* ignore if already closed */ }
    try {
        db.close();
    } catch { /* ignore */ }
}

initSessionGeneration(db);

export { db };
