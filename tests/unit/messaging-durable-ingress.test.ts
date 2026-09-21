// Journal tests run against a private in-memory database. The shared jaw.db is one
// file across every test child process, so a suite that writes to it trades a real
// assertion for an intermittent lock failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    IngressJournal,
    assertChildRetentionPredicatesRegistered,
    initIngressJournal,
    getIngressJournal,
    registerChildRetentionPredicate,
    __resetChildRetentionPredicatesForTests,
    __resetIngressJournalForTests,
} from '../../src/messaging/durable-ingress.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

function freshDb(): Database.Database {
    const database = new Database(':memory:');
    // A new connection does NOT inherit the singleton's pragmas. Without this the FK
    // assertions below would pass without ever enforcing anything.
    database.pragma('foreign_keys = ON');
    return database;
}

function envelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: '777',
        eventId: '12345',
        conversationKey: 'telegram:-100999',
        actorId: '42',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
        ...overrides,
    };
}

function journalFor(database: Database.Database, now = () => 1_700_000_000_000): IngressJournal {
    return new IngressJournal(database, { now, bootId: 'boot-1' });
}

test('append persists an envelope and reports it as received', () => {
    const database = freshDb();
    const journal = journalFor(database);
    const result = journal.append(envelope(), 'digest-1', '{"text":"hi"}');
    assert.equal(result.appended, true);
    assert.equal(result.record.state, 'received');
    assert.equal(result.record.attemptCount, 0);
    assert.equal(result.record.payloadJson, '{"text":"hi"}');
    assert.equal(result.record.conversationKey, 'telegram:-100999');
    assert.equal(result.record.actorId, '42');
});

test('the same event appended twice is reported as a duplicate, not a second row', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'digest-1');
    const again = journal.append(envelope(), 'digest-1');
    assert.equal(again.appended, false);
    assert.equal(again.appended === false && again.reason, 'duplicate');
    const rows = database.prepare('SELECT COUNT(*) AS n FROM ingress_events').get() as { n: number };
    assert.equal(rows.n, 1);
});

test('the same event id under a different account is a different event', () => {
    const database = freshDb();
    const journal = journalFor(database);
    assert.equal(journal.append(envelope({ accountId: 'A' }), 'd').appended, true);
    // The account is part of the identity precisely so two workspaces cannot suppress
    // each other's messages by sharing an id space.
    assert.equal(journal.append(envelope({ accountId: 'B' }), 'd').appended, true);
});

test('append refuses anything that is not a valid envelope', () => {
    const database = freshDb();
    const journal = journalFor(database);
    // An empty accountId would namespace every event under the same blank key.
    assert.throws(() => journal.append(envelope({ accountId: '  ' }), 'd'), /valid InboundEnvelope/);
    // A target from another channel would route the reply somewhere the message never
    // came from.
    assert.throws(
        () => journal.append(
            envelope({ target: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1' } }),
            'd',
        ),
        /valid InboundEnvelope/,
    );
});

test('the journal mints a trace id because nothing upstream produces one', () => {
    const database = freshDb();
    const journal = journalFor(database);
    const plain = journal.append(envelope(), 'd');
    assert.equal(plain.record.traceId, 'boot-1:telegram:12345');
    const withRef = journal.append(
        envelope({ eventId: '999', rawEnvelopeRef: 'telegram:update:999' }),
        'd',
    );
    assert.equal(withRef.record.traceId, 'boot-1:telegram:999:telegram:update:999');
});

test('state moves received -> processing -> completed and only from the right state', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'd', '{"text":"hi"}');

    // Completing something never started would erase an event that was never handled.
    assert.equal(journal.markCompleted('telegram', '777', '12345'), false);

    assert.equal(journal.markProcessing('telegram', '777', '12345'), true);
    assert.equal(journal.find('telegram', '777', '12345')?.state, 'processing');
    assert.equal(journal.find('telegram', '777', '12345')?.attemptCount, 1);

    assert.equal(journal.markCompleted('telegram', '777', '12345'), true);
    const done = journal.find('telegram', '777', '12345');
    assert.equal(done?.state, 'completed');
    // The payload is gone but the fact that this event was handled remains, which is
    // the only thing a redelivery needs to read.
    assert.equal(done?.payloadJson, null);
    assert.equal(done?.completedAt, 1_700_000_000_000);
    assert.equal(done?.tombstoneUntil, 1_700_000_000_000 + 48 * 60 * 60 * 1000);
});

test('a dead letter keeps its payload so it can be replayed', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'd', '{"text":"hi"}');
    journal.markProcessing('telegram', '777', '12345');
    assert.equal(journal.markDeadLetter('telegram', '777', '12345', 'handler exploded'), true);
    const row = journal.find('telegram', '777', '12345');
    assert.equal(row?.state, 'dead_letter');
    assert.equal(row?.payloadJson, '{"text":"hi"}');
    assert.equal(row?.lastError, 'handler exploded');
    assert.deepEqual(journal.listByState('dead_letter').map(r => r.eventId), ['12345']);
});

test('a dead letter can be retried and its attempt count keeps climbing', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'd');
    journal.markProcessing('telegram', '777', '12345');
    journal.markDeadLetter('telegram', '777', '12345', 'boom');
    assert.equal(journal.markProcessing('telegram', '777', '12345'), true);
    assert.equal(journal.find('telegram', '777', '12345')?.attemptCount, 2);
});

test('a scheduled retry returns to received without spending the dead-letter budget', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'd');
    journal.markProcessing('telegram', '777', '12345');
    assert.equal(journal.markRetryScheduled('telegram', '777', '12345', 1_700_000_005_000, 'rate limited'), true);
    const row = journal.find('telegram', '777', '12345');
    assert.equal(row?.state, 'received');
    assert.equal(row?.nextAttemptAt, 1_700_000_005_000);
});

test('the state CHECK rejects a value the FSM does not define', () => {
    const database = freshDb();
    journalFor(database).append(envelope(), 'd');
    assert.throws(
        () => database.prepare("UPDATE ingress_events SET state = 'wandering'").run(),
        /CHECK constraint failed/,
    );
});

test('the channel CHECK rejects a channel this runtime does not speak', () => {
    const database = freshDb();
    journalFor(database);
    assert.throws(
        () => database.prepare(`
            INSERT INTO ingress_events (channel, account_id, event_id, conversation_key,
                actor_id, target_json, ack_policy, trace_id, payload_digest, received_at)
            VALUES ('irc', 'a', 'e', 'c', 'u', '{}', 'transport-managed', 't', 'd', 1)
        `).run(),
        /CHECK constraint failed/,
    );
});

test('a row with an unrecognised state is refused on read rather than guessed at', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope(), 'd');
    // Bypass the CHECK the way a different binary sharing this file could.
    database.pragma('ignore_check_constraints = ON');
    database.prepare("UPDATE ingress_events SET state = 'from-the-future'").run();
    assert.throws(() => journal.find('telegram', '777', '12345'), /unknown state/);
});

test('the sweeper removes an expired tombstone but leaves a live one', () => {
    const database = freshDb();
    let clock = 1_700_000_000_000;
    const journal = new IngressJournal(database, { now: () => clock, bootId: 'boot-1' });
    for (const eventId of ['a', 'b']) {
        journal.append(envelope({ eventId }), 'd');
        journal.markProcessing('telegram', '777', eventId);
    }
    journal.markCompleted('telegram', '777', 'a');
    clock += 49 * 60 * 60 * 1000;
    journal.markCompleted('telegram', '777', 'b');

    assert.equal(journal.sweepExpiredTombstones(), 1);
    assert.equal(journal.find('telegram', '777', 'a'), null);
    assert.notEqual(journal.find('telegram', '777', 'b'), null);
});

test('the sweeper never touches a dead letter, however old', () => {
    const database = freshDb();
    let clock = 1_700_000_000_000;
    const journal = new IngressJournal(database, { now: () => clock, bootId: 'boot-1' });
    journal.append(envelope(), 'd', '{"text":"hi"}');
    journal.markProcessing('telegram', '777', '12345');
    journal.markDeadLetter('telegram', '777', '12345', 'boom');
    clock += 365 * 24 * 60 * 60 * 1000;
    assert.equal(journal.sweepExpiredTombstones(), 0);
    // A dead letter is retention's exception: it is the replay input.
    assert.notEqual(journal.find('telegram', '777', '12345'), null);
});

// ─── The guard that outlives this milestone ─────────

test('a table referencing the journal without a retention predicate is refused', () => {
    const database = freshDb();
    journalFor(database);
    __resetChildRetentionPredicatesForTests();
    database.exec(`
        CREATE TABLE pretend_outbound (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
            state TEXT NOT NULL,
            FOREIGN KEY (channel, account_id, event_id)
                REFERENCES ingress_events(channel, account_id, event_id)
        );
    `);
    // Without this the sweeper would look correct forever and start deleting parents of
    // live children the moment a child table lands — a regression authored by a later
    // milestone, which no test inside this one could otherwise catch.
    assert.throws(
        () => assertChildRetentionPredicatesRegistered(database),
        /pretend_outbound.*without a registered retention predicate/s,
    );
});

test('registering a predicate satisfies the guard and blocks the parent delete', () => {
    const database = freshDb();
    let clock = 1_700_000_000_000;
    const journal = new IngressJournal(database, { now: () => clock, bootId: 'boot-1' });
    __resetChildRetentionPredicatesForTests();
    database.exec(`
        CREATE TABLE pretend_outbound (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
            state TEXT NOT NULL,
            FOREIGN KEY (channel, account_id, event_id)
                REFERENCES ingress_events(channel, account_id, event_id)
        );
    `);
    registerChildRetentionPredicate({
        table: 'pretend_outbound',
        blockingExistsSql: `
            SELECT 1 FROM pretend_outbound c
            WHERE c.channel = e.channel AND c.account_id = e.account_id
              AND c.event_id = e.event_id AND c.state NOT IN ('sent', 'definitive_failed')
        `,
        deleteTerminalSql: `
            DELETE FROM pretend_outbound
            WHERE channel = ? AND account_id = ? AND event_id = ?
              AND state IN ('sent', 'definitive_failed')
        `,
    });
    assert.doesNotThrow(() => assertChildRetentionPredicatesRegistered(database));

    journal.append(envelope(), 'd');
    journal.markProcessing('telegram', '777', '12345');
    journal.markCompleted('telegram', '777', '12345');
    database.prepare(`
        INSERT INTO pretend_outbound (id, channel, account_id, event_id, state)
        VALUES ('o1', 'telegram', '777', '12345', 'ambiguous')
    `).run();
    clock += 49 * 60 * 60 * 1000;

    // An ambiguous send is exactly the case where the parent must survive: an operator
    // still has to decide whether it reached the platform.
    assert.equal(journal.sweepExpiredTombstones(), 0);
    assert.notEqual(journal.find('telegram', '777', '12345'), null);

    database.prepare("UPDATE pretend_outbound SET state = 'sent'").run();
    assert.equal(journal.sweepExpiredTombstones(), 1);
    // Child before parent, and nothing left dangling on either side.
    const orphans = database.prepare('SELECT COUNT(*) AS n FROM pretend_outbound').get() as { n: number };
    assert.equal(orphans.n, 0);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    __resetChildRetentionPredicatesForTests();
});

test('init exposes the journal and creates the table', () => {
    const database = freshDb();
    __resetIngressJournalForTests();
    __resetChildRetentionPredicatesForTests();
    assert.equal(getIngressJournal(), null);
    const journal = initIngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    assert.equal(getIngressJournal(), journal);
    const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ingress_events'")
        .get();
    assert.ok(table, 'init must create the journal table');
    __resetIngressJournalForTests();
});

test('a second connection treating the same event as new still stores one row', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-unique-'));
    try {
        const path = join(home, 'jaw.db');
        const firstDb = new Database(path);
        firstDb.pragma('foreign_keys = ON');
        const first = new IngressJournal(firstDb, { now: () => 1, bootId: 'boot-1' });
        assert.equal(first.append(envelope(), 'd').appended, true);

        const secondDb = new Database(path);
        secondDb.pragma('foreign_keys = ON');
        const second = new IngressJournal(secondDb, { now: () => 2, bootId: 'boot-2' });
        const again = second.append(envelope(), 'd');
        assert.equal(again.appended, false);
        assert.equal(again.appended === false && again.reason, 'duplicate');
        const rows = secondDb.prepare('SELECT COUNT(*) AS n FROM ingress_events').get() as { n: number };
        assert.equal(rows.n, 1);
        firstDb.close();
        secondDb.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a unique race after find still returns duplicate instead of throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-race-'));
    try {
        const path = join(home, 'jaw.db');
        const firstDb = new Database(path);
        firstDb.pragma('foreign_keys = ON');
        const first = new IngressJournal(firstDb, { now: () => 1, bootId: 'boot-1' });
        first.append(envelope({ eventId: 'race-1' }), 'd');

        const secondDb = new Database(path);
        secondDb.pragma('foreign_keys = ON');
        const second = new IngressJournal(secondDb, { now: () => 2, bootId: 'boot-2' });
        const originalFind = second.find.bind(second);
        let finds = 0;
        second.find = ((channel, accountId, eventId) => {
            finds += 1;
            if (finds === 1) return null;
            return originalFind(channel, accountId, eventId);
        }) as typeof second.find;
        const raced = second.append(envelope({ eventId: 'race-1' }), 'd');
        assert.equal(raced.appended, false);
        assert.equal(raced.appended === false && raced.reason, 'duplicate');
        assert.ok(finds >= 2, 'the unique catch must look the row up again');
        firstDb.close();
        secondDb.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a locked database still throws instead of looking like a duplicate', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-lock-'));
    try {
        const path = join(home, 'jaw.db');
        const writer = new Database(path);
        writer.pragma('foreign_keys = ON');
        writer.pragma('busy_timeout = 0');
        const journal = new IngressJournal(writer, { now: () => 1, bootId: 'boot-2' });

        const locker = new Database(path);
        locker.pragma('busy_timeout = 0');
        locker.exec('BEGIN EXCLUSIVE');
        assert.throws(() => journal.append(envelope({ eventId: 'locked' }), 'd'), /busy|locked|SQLITE_BUSY/i);
        locker.exec('ROLLBACK');
        locker.close();
        writer.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('oldestOpenReceivedAt ignores completed and dead_letter', () => {
    const database = freshDb();
    const journal = journalFor(database);
    journal.append(envelope({ eventId: 'done' }), 'd1');
    journal.markProcessing('telegram', '777', 'done');
    journal.markCompleted('telegram', '777', 'done');
    journal.append(envelope({ eventId: 'dead', receivedAt: 1_600_000_000_000 }), 'd2');
    journal.markProcessing('telegram', '777', 'dead');
    journal.markDeadLetter('telegram', '777', 'dead', 'boom');
    assert.equal(journal.oldestOpenReceivedAt(), null);
    journal.append(envelope({ eventId: 'live', receivedAt: 1_800_000_000_000 }), 'd3');
    journal.markProcessing('telegram', '777', 'live');
    assert.equal(journal.oldestOpenReceivedAt(), 1_800_000_000_000);
});

test('abandonStaleProcessing moves old processing to dead_letter', () => {
    const database = freshDb();
    const journal = journalFor(database, () => 1_700_000_000_000);
    journal.append(envelope({ eventId: 'stale' }), 'd');
    journal.markProcessing('telegram', '777', 'stale');
    const later = new IngressJournal(database, { now: () => 1_700_000_000_000 + 61 * 60 * 1000, bootId: 'boot-later' });
    assert.equal(later.abandonStaleProcessing(), 1);
    const row = later.find('telegram', '777', 'stale');
    assert.equal(row?.state, 'dead_letter');
    assert.equal(row?.lastError, 'abandoned_stale_processing');
    assert.equal(later.oldestOpenReceivedAt(), null);
});

test('initIngressJournal abandons stale processing on the same database', () => {
    const database = freshDb();
    const seeded = journalFor(database, () => 0);
    seeded.append(envelope({ eventId: 'boot-stale' }), 'd');
    seeded.markProcessing('telegram', '777', 'boot-stale');
    __resetIngressJournalForTests();
    const booted = initIngressJournal(database, { now: () => 61 * 60 * 1000, bootId: 'boot-init' });
    const row = booted.find('telegram', '777', 'boot-stale');
    assert.equal(row?.state, 'dead_letter');
    assert.equal(row?.lastError, 'abandoned_stale_processing');
    __resetIngressJournalForTests();
});
