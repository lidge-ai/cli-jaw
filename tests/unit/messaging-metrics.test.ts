import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChannelHealthSnapshot, buildIngressHealthSnapshot } from '../../src/messaging/channel-health.ts';
import { parseChannelHealth } from '../../public/js/features/transport-status-row.ts';
import {
    admitIngress,
    IngressJournal,
    initIngressJournal,
    __resetIngressJournalForTests,
} from '../../src/messaging/durable-ingress.ts';
import {
    __resetMessagingMetricsForTests,
    inc,
    observe,
    snapshotMetrics,
} from '../../src/messaging/metrics.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

const projectRoot = join(import.meta.dirname, '../..');

function envelope(): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: '777',
        eventId: 'e1',
        conversationKey: 'telegram:-100999',
        actorId: '42',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
    };
}

test.beforeEach(() => {
    __resetMessagingMetricsForTests();
    __resetIngressJournalForTests();
});

test.afterEach(() => {
    __resetMessagingMetricsForTests();
    __resetIngressJournalForTests();
});

test('inc appears in snapshot and drops forbidden labels', () => {
    inc('ingress.admit', { channel: 'telegram', result: 'fresh', actorId: '42', eventId: 'e1' });
    observe('ingress.ack_ms', 12, { channel: 'slack', sessionId: 's1' });
    const snap = snapshotMetrics();
    assert.equal(snap.counters.length, 1);
    assert.deepEqual(snap.counters[0]?.labels, { channel: 'telegram', result: 'fresh' });
    assert.equal(snap.counters[0]?.value, 1);
    assert.equal(snap.histograms.length, 1);
    assert.deepEqual(snap.histograms[0]?.labels, { channel: 'slack' });
    assert.equal(snap.histograms[0]?.count, 1);
    assert.equal(snap.histograms[0]?.sum, 12);
});

test('health snapshot stays parseable and adds ingress zeros without a journal', () => {
    const snapshot = buildChannelHealthSnapshot();
    assert.equal(snapshot.ingress.received, 0);
    assert.equal(snapshot.ingress.oldestOpenReceivedAt, null);
    assert.ok(Array.isArray(snapshot.metrics.counters));
    const parsed = parseChannelHealth({ channels: snapshot });
    assert.ok(parsed);
    assert.equal(parsed?.telegram.configured, snapshot.telegram.configured);
    assert.equal((parsed as { ingress?: unknown } | null)?.ingress, undefined);
});

test('admit increments the live registry and journal snapshot sees open rows', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = initIngressJournal(database, { now: () => 9, bootId: 'boot' });
    admitIngress(journal, envelope(), 'd');
    const counters = snapshotMetrics().counters;
    assert.ok(counters.some((row) => row.name === 'ingress.admit' && row.labels.result === 'fresh' && row.value === 1));
    const ingress = buildIngressHealthSnapshot();
    assert.equal(ingress.processing, 1);
    assert.equal(ingress.oldestOpenReceivedAt, 1_700_000_000_000);
});

test('jaw messaging doctor --json reports local ingress counts', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-msg-doctor-'));
    try {
        const database = new Database(join(home, 'jaw.db'));
        database.pragma('foreign_keys = ON');
        const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
        journal.append(envelope(), 'd', '{}');
        journal.markProcessing('telegram', '777', 'e1');
        journal.markDeadLetter('telegram', '777', 'e1', 'boom');
        database.close();
        const stdout = execFileSync(process.execPath, [
            '--import', 'tsx',
            'bin/cli-jaw.ts', '--home', home,
            'messaging', 'doctor', '--json',
        ], { cwd: projectRoot, encoding: 'utf8' });
        const body = JSON.parse(stdout) as {
            ingress: { dead_letter: number; oldestOpenReceivedAt: number | null };
            events: unknown[];
            metrics: { counters: unknown[] };
        };
        assert.equal(body.ingress.dead_letter, 1);
        assert.equal(body.ingress.oldestOpenReceivedAt, null);
        assert.ok(Array.isArray(body.events));
        assert.ok(Array.isArray(body.metrics.counters));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
