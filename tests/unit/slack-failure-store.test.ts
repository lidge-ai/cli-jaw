import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSlackFailureStore, SlackFailureStore } from '../../src/slack/failure-store.ts';
import { reportSlackFailure } from '../../src/slack/failure-routing.ts';

const target = { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'channel' as const,
    targetId: 'CSTORETEST', threadId: '100.001' };

for (const response of ['unknown', 'success', 'rejected']) test(`${response} notification claim survives restart and former expiry`, async context => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-failure-store-'));
    const file = join(dir, 'test.db');
    const prior = process.env['JAW_SLACK_FAILURE_DM'];
    const priorFetch = globalThis.fetch;
    let db = new Database(file), calls = 0;
    process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    globalThis.fetch = (async () => {
        calls++;
        assert.equal((db.prepare('SELECT COUNT(*) AS count FROM slack_failure_claims').get() as { count: number }).count, 1, 'claim is committed before dispatch');
        if (response === 'unknown') throw new Error('lost response');
        return new Response(JSON.stringify(response === 'success' ? { ok: true, ts: '100.3' } : { ok: false, error: 'ratelimited' }));
    }) as typeof fetch;
    try {
        configureSlackFailureStore(new SlackFailureStore(db));
        await reportSlackFailure('fake', target, 'durable-request');
        assert.equal(calls, 1);
        const rows = db.prepare('SELECT claim_hash, claimed_at FROM slack_failure_claims').all() as Array<{ claim_hash: string; claimed_at: number }>;
        assert.equal(rows.length, 1);
        assert.match(rows[0]!.claim_hash, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(rows), /CSTORETEST|DOPERATORTEST|durable-request|fake/);
        // Reopen the actual SQLite file through a fresh store, as a new process does.
        configureSlackFailureStore(null); db.close(); db = new Database(file);
        configureSlackFailureStore(new SlackFailureStore(db));
        await reportSlackFailure('fake', target, 'durable-request');
        const initialTime = Date.now();
        context.mock.method(Date, 'now', () => initialTime + 5 * 60 * 60 * 1000);
        await reportSlackFailure('fake', target, 'durable-request');
        context.mock.method(Date, 'now', () => initialTime + 365 * 24 * 60 * 60 * 1000);
        await reportSlackFailure('fake', target, 'durable-request');
        assert.equal(calls, 1, 'neither restart nor age can authorize another POST');
    } finally {
        configureSlackFailureStore(null); db.close(); globalThis.fetch = priorFetch;
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('missing or unwritable durable store never dispatches a notification', async () => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; const priorFetch = globalThis.fetch;
    const db = new Database(':memory:');
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('must not dispatch'); }) as typeof fetch;
    process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    try {
        configureSlackFailureStore(null);
        await reportSlackFailure('fake', target, 'missing');
        configureSlackFailureStore(new SlackFailureStore(db));
        db.pragma('query_only = ON');
        await reportSlackFailure('fake', target, 'unwritable');
        assert.equal(calls, 0);
    } finally {
        configureSlackFailureStore(null); db.close(); globalThis.fetch = priorFetch;
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});

test('capacity fails closed without evicting an old claim', () => {
    const db = new Database(':memory:');
    try {
        const store = new SlackFailureStore(db);
        assert.equal(store.claim('original'), true);
        db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 99999)
            INSERT INTO slack_failure_claims SELECT 'capacity-' || x, 0 FROM n`);
        assert.equal(store.claim('overflow'), false);
        assert.equal(store.claim('original'), false);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM slack_failure_claims').get()?.['count'], 100000);
    } finally { db.close(); }
});
