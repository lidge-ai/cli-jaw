import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClaudeHistory } from '../../src/agent/runtime/claude-sdk-history-loader.ts';

const helpers = { getSessionInfo() {}, getSessionMessages() {}, forkSession() {}, deleteSession() {}, query() {} };

test('history loader exposes only the four checked helpers and fails closed on a partial module', async () => {
    const loaded = await loadClaudeHistory(async () => helpers);
    assert.deepEqual(Object.keys(loaded).sort(), ['deleteSession', 'forkSession', 'getSessionInfo', 'getSessionMessages']);
    assert.equal(loaded.forkSession, helpers.forkSession);
    const { deleteSession: _omitted, ...partial } = helpers;
    await assert.rejects(loadClaudeHistory(async () => partial), /history helpers unavailable/);
    await assert.rejects(loadClaudeHistory(async () => { throw new Error('missing optional dependency'); }), /history helpers unavailable/);
});

test('a failed history load is retryable and a successful one is shared', async () => {
    let calls = 0, ready = false;
    const importer = async () => { calls++; if (!ready) throw new Error('not installed'); return helpers; };
    await assert.rejects(loadClaudeHistory(importer));
    ready = true;
    const [a, b] = await Promise.all([loadClaudeHistory(importer), loadClaudeHistory(importer)]);
    assert.equal(a, b);
    assert.equal(calls, 2);
});

test('the installed SDK exposes the history helpers', async () => {
    const loaded = await loadClaudeHistory();
    for (const name of ['getSessionInfo', 'getSessionMessages', 'forkSession', 'deleteSession'] as const) {
        assert.equal(typeof loaded[name], 'function');
    }
});
