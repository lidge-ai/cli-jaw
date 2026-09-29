// A database that predates PRAGMA user_version has to keep opening. CI never
// exercises that: every run gets a fresh CLI_JAW_HOME, so the migration path is
// dead code there unless a test builds an old home on purpose. This file builds
// one, and asserts the two halves of the schema cannot drift apart (#691).
//
// isolated-home MUST be the first import: it rewrites CLI_JAW_HOME, and
// src/core/config.ts freezes DB_PATH the moment it is evaluated. For the same
// reason src/core/db.ts is imported DYNAMICALLY, after the fixture file exists —
// a static import opens (and thereby creates) an empty database first.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** The schema as it stood before any of the step-1 columns existed.
 *
 *  Exactly the columns MIGRATIONS[0] adds are missing here, and nothing else:
 *  a gap the steps do not cover is a different test (MIG-004). Tables added
 *  later are absent entirely, which is what CREATE TABLE IF NOT EXISTS is for. */
const LEGACY_V0_SQL = `
    CREATE TABLE session (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        active_cli  TEXT DEFAULT 'claude',
        session_id  TEXT,
        model       TEXT DEFAULT 'default',
        permissions TEXT DEFAULT 'auto',
        working_dir TEXT DEFAULT '~',
        effort      TEXT DEFAULT 'medium',
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO session (id) VALUES ('default');

    CREATE TABLE messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        cli         TEXT,
        model       TEXT,
        cost_usd    REAL,
        duration_ms INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE chat_sessions (
        id          TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL UNIQUE,
        label       TEXT DEFAULT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO chat_sessions (id, seq) VALUES ('default', 0);

    CREATE TABLE employee_sessions (
        employee_id TEXT PRIMARY KEY,
        session_id  TEXT,
        cli         TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE session_buckets (
        bucket      TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        model       TEXT NOT NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE trace_runs (
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
        error TEXT
    );

    CREATE TABLE mention_watch_cursor (
        job_id        TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        last_ts       TEXT NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, channel_id)
    );
`;

function writeLegacyDatabase(path: string, sql = LEGACY_V0_SQL): void {
    const fixture = new Database(path);
    try {
        fixture.exec(sql);
        fixture.prepare("INSERT INTO messages(role, content) VALUES('user', ?)").run('older than user_version');
    } finally {
        fixture.close();
    }
}

// Written BEFORE src/core/db.ts is ever evaluated, so the singleton opens this
// file rather than creating an empty one.
const HOME = process.env['CLI_JAW_HOME'];
assert.ok(HOME, 'isolated-home must set CLI_JAW_HOME');
writeLegacyDatabase(join(HOME, 'jaw.db'));

type Shape = { columns: Map<string, Set<string>>; indexes: Set<string> };

function shapeOf(database: Database.Database): Shape {
    const columns = new Map<string, Set<string>>();
    const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    for (const entry of tables) {
        const rows = database.prepare(`PRAGMA table_info(${entry.name})`).all() as { name: string }[];
        columns.set(entry.name, new Set(rows.map(row => row.name)));
    }
    const indexes = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    return { columns, indexes: new Set(indexes.map(row => row.name)) };
}

function sortedEntries(shape: Shape): [string, string[]][] {
    return [...shape.columns.entries()]
        .map(([table, cols]) => [table, [...cols].sort()] as [string, string[]])
        .sort((a, b) => a[0].localeCompare(b[0]));
}

function freshDir(label: string): string {
    return mkdtempSync(join(tmpdir(), `jaw-schema-${label}-`));
}

test('db schema: user_version migration of an existing home', async t => {
    const dbModule = await import('../../src/core/db.ts');
    const { db, applySchema, assertSchemaComplete, SCHEMA_VERSION, SchemaMigrationError } = dbModule;

    await t.test('MIG-001: a pre-user_version home opens and is stamped', () => {
        // Importing at all is most of the assertion: the prepared statements are
        // created at module scope, and before #691 a missing column killed the
        // whole process right there.
        assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
        assert.ok(dbModule.getSession());

        const before = dbModule.getMessages.all('default') as unknown[];
        dbModule.insertMessage.run('user', 'after migration', 'codex', 'default', '/tmp', 'default');
        const after = dbModule.getMessages.all('default') as unknown[];
        assert.equal(after.length, before.length + 1);

        // The row written before the migration survived it and landed in the
        // default session rather than being dropped.
        const legacyRow = db.prepare(
            "SELECT session_id FROM messages WHERE content = 'older than user_version'",
        ).get() as { session_id: string } | undefined;
        assert.ok(legacyRow, 'the pre-migration row must still be there');
        assert.equal(legacyRow.session_id, 'default');
    });

    await t.test('MIG-002: the indexes over migrated columns exist', () => {
        // The ordering trap: these index columns are added by a migration step, so
        // creating the indexes alongside the tables raises "no such column" on
        // exactly the old home this feature exists to open.
        const names = new Set((db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index'",
        ).all() as { name: string }[]).map(row => row.name));
        for (const index of [
            'idx_messages_wd', 'idx_messages_trace_run', 'idx_messages_session',
            'idx_trace_runs_session', 'idx_trace_runtime_control',
        ]) {
            assert.ok(names.has(index), `missing index ${index} after migrating a legacy home`);
        }
    });

    await t.test('MIG-003: a migrated database and a fresh one end at the same schema', () => {
        // This is the coupling that keeps CREATE and MIGRATIONS honest. Add a
        // column to the baseline without a migration step and the migrated side
        // lacks it; add one only to a step and the fresh side lacks it.
        const fresh = new Database(join(freshDir('fresh'), 'jaw.db'));
        const migrated = new Database(join(freshDir('migrated'), 'jaw.db'));
        try {
            applySchema(fresh);
            migrated.exec(LEGACY_V0_SQL);
            applySchema(migrated);
            assert.deepEqual(sortedEntries(shapeOf(migrated)), sortedEntries(shapeOf(fresh)));
            assert.deepEqual(
                [...shapeOf(migrated).indexes].sort(),
                [...shapeOf(fresh).indexes].sort(),
            );
            // Guard against the comparison passing vacuously.
            assert.ok(shapeOf(fresh).columns.get('messages')?.has('session_id'));
            assert.ok(shapeOf(fresh).columns.get('session_buckets')?.has('turn_count'));
            assert.ok(shapeOf(fresh).indexes.has('idx_messages_session'));
        } finally {
            fresh.close();
            migrated.close();
        }
    });

    await t.test('MIG-007: existing v1 buckets gain a zero turn count', () => {
        const database = new Database(join(freshDir('v1-turns'), 'jaw.db'));
        try {
            applySchema(database);
            database.exec('ALTER TABLE session_buckets DROP COLUMN turn_count');
            database.prepare('INSERT INTO session_buckets (bucket, session_id, model) VALUES (?, ?, ?)')
                .run('codex', 'existing-session', 'fixture');
            database.pragma('user_version = 1');
            applySchema(database);
            assert.deepEqual(database.prepare('SELECT session_id, turn_count FROM session_buckets WHERE bucket=?').get('codex'),
                { session_id: 'existing-session', turn_count: 0 });
            assert.equal(Number(database.pragma('user_version', { simple: true })), SCHEMA_VERSION);
        } finally {
            database.close();
        }
    });

    await t.test('bucket turns increment independently and reject a stale session id', () => {
        const { upsertSessionBucket, incrementSessionBucketTurns, getSessionBucket } = dbModule;
        db.prepare('DELETE FROM session_buckets').run();
        upsertSessionBucket.run('bucket-a', 'session-a', 'fixture', null, 0);
        upsertSessionBucket.run('bucket-b', 'session-b', 'fixture', null, 0);
        const turns = (bucket: string) => (getSessionBucket.get(bucket) as { turn_count: number }).turn_count;
        assert.deepEqual(incrementSessionBucketTurns.get('bucket-a', 'session-a'), { turn_count: 1 });
        assert.deepEqual(incrementSessionBucketTurns.get('bucket-a', 'session-a'), { turn_count: 2 });
        assert.deepEqual(incrementSessionBucketTurns.get('bucket-b', 'session-b'), { turn_count: 1 });
        upsertSessionBucket.run('bucket-a', 'session-a', 'fixture', null, 0);
        assert.equal(turns('bucket-a'), 2);
        upsertSessionBucket.run('bucket-a', 'replacement', 'fixture', null, 0);
        assert.equal(turns('bucket-a'), 0);
        assert.equal(incrementSessionBucketTurns.get('bucket-a', 'session-a'), undefined);
        assert.equal(turns('bucket-a'), 0);
        assert.equal(turns('bucket-b'), 1);
    });

    await t.test('MIG-004: a gap no step covers fails by name, not at db.prepare', () => {
        const path = join(freshDir('gap'), 'jaw.db');
        // "effort" is in the baseline and in no migration step, so a database
        // missing it is exactly the "added to CREATE only" mistake.
        writeLegacyDatabase(path, LEGACY_V0_SQL.replace("        effort      TEXT DEFAULT 'medium',\n", ''));
        const database = new Database(path);
        try {
            assert.throws(() => applySchema(database), (error: unknown) => {
                assert.ok(error instanceof SchemaMigrationError);
                assert.match(error.message, /session\.effort/);
                return true;
            });
        } finally {
            database.close();
        }
    });

    await t.test('MIG-005: a newer schema is refused instead of downgraded', () => {
        const database = new Database(join(freshDir('newer'), 'jaw.db'));
        try {
            applySchema(database);
            database.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
            assert.throws(() => applySchema(database), (error: unknown) => {
                assert.ok(error instanceof SchemaMigrationError);
                assert.match(error.message, /newer cli-jaw/);
                return true;
            });
        } finally {
            database.close();
        }
    });

    await t.test('MIG-006: applying the schema twice changes nothing', () => {
        const path = join(freshDir('twice'), 'jaw.db');
        writeLegacyDatabase(path);
        const database = new Database(path);
        try {
            applySchema(database);
            const once = sortedEntries(shapeOf(database));
            applySchema(database);
            assert.deepEqual(sortedEntries(shapeOf(database)), once);
            assert.equal(Number(database.pragma('user_version', { simple: true })), SCHEMA_VERSION);
            assert.doesNotThrow(() => assertSchemaComplete(database));
        } finally {
            database.close();
        }
    });
});
