import Database from 'better-sqlite3';
import { configureSlackFailureStore, SlackFailureStore } from '../../src/slack/failure-store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSlackFailure, isSlackTurnFailure, slackFailureRoutingEnabled } from '../../src/slack/failure-routing.ts';
import { createSlackForwarder } from '../../src/slack/forwarder.ts';
import { markSlackRecoveryBlocked } from '../../src/slack/tool-context.ts';

let database: Database.Database;
test.beforeEach(() => { database = new Database(':memory:'); configureSlackFailureStore(new SlackFailureStore(database)); });
test.afterEach(() => { configureSlackFailureStore(null); database.close(); });

const target = { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'channel' as const,
    targetId: 'CFAILTEST', threadId: '100.001' };

test('failure notifications are opt-in, private, concise and claimed before ambiguous dispatch', async () => {
    const before = process.env['JAW_SLACK_FAILURE_DM'];
    const fetchBefore = globalThis.fetch;
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        throw new Error('unknown transport result');
    }) as typeof fetch;
    try {
        delete process.env['JAW_SLACK_FAILURE_DM'];
        assert.equal(slackFailureRoutingEnabled(), false);
        await reportSlackFailure('fake', target, 'disabled');
        assert.equal(calls.length, 0);
        process.env['JAW_SLACK_FAILURE_DM'] = 'CINVALID';
        assert.equal(slackFailureRoutingEnabled(), true);
        await reportSlackFailure('fake', target, 'invalid');
        assert.equal(calls.length, 0);
        process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
        await Promise.all([reportSlackFailure('fake', target, 'ambiguous'), reportSlackFailure('fake', target, 'ambiguous')]);
        await reportSlackFailure('fake', target, 'ambiguous');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.['channel'], 'DOPERATORTEST');
        assert.equal(calls[0]?.['thread_ts'], undefined);
        assert.doesNotMatch(String(calls[0]?.['text']), /\n|CFAILTEST|100.001|unknown transport/);
        assert.ok(String(calls[0]?.['text']).length < 100);
    } finally {
        globalThis.fetch = fetchBefore;
        if (before === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = before;
    }
});

test('forwarder suppresses failed bodies (including empty failures) and preserves successful exact targets', async () => {
    const before = process.env['JAW_SLACK_FAILURE_DM'];
    const fetchBefore = globalThis.fetch;
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: '100.2' }));
    }) as typeof fetch;
    try {
        process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
        const forward = createSlackForwarder({ getToken: () => 'fake' });
        await forward('agent_done', { error: true, text: 'PRIVATE exception', requestId: 'forward-fail', target });
        await forward('agent_done', { error: true, text: '', requestId: 'forward-empty', target });
        assert.deepEqual(calls.map(c => c['channel']), ['DOPERATORTEST', 'DOPERATORTEST']);
        assert.doesNotMatch(JSON.stringify(calls), /PRIVATE exception/);
        await forward('agent_done', { text: 'Success', requestId: 'forward-success', target });
        assert.equal(calls.at(-1)?.['channel'], target.targetId);
        assert.equal(calls.at(-1)?.['thread_ts'], target.threadId);
        assert.equal(calls.at(-1)?.['text'], 'Success');
    } finally {
        globalThis.fetch = fetchBefore;
        if (before === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = before;
    }
});

test('native success retains native precedence while execution and timeout failures route privately', () => {
    assert.equal(isSlackTurnFailure({ workflowUnconfirmed: true }), false);
    assert.equal(isSlackTurnFailure({ runtimeFinality: 'present', runtimeStatus: 'done', error: true }), false);
    for (const data of [{ error: true }, { executionFailed: true }, { collectionFailure: 'timeout' },
        { runtimeFinality: 'absent', runtimeStatus: 'error' }]) {
        assert.equal(isSlackTurnFailure(data), true);
    }
});

test('a refused threaded delivery cannot be replaced by a successful root final', async () => {
    const before = process.env['JAW_SLACK_FAILURE_DM']; const oldFetch = globalThis.fetch;
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: '100.3' }));
    };
    try {
        process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
        const { threadId: _thread, ...root } = target;
        markSlackRecoveryBlocked('blocked-root-final', root.targetId);
        const forward = createSlackForwarder({ getToken: () => 'fake' });
        await forward('agent_done', { text: 'Replacement report at channel root', requestId: 'blocked-root-final', target: root });
        assert.deepEqual(calls.map(c => c['channel']), ['DOPERATORTEST']);
        assert.doesNotMatch(JSON.stringify(calls), /Replacement report/);
        await forward('agent_done', { text: 'Valid threaded answer', requestId: 'blocked-root-final', target });
        assert.equal(calls.at(-1)?.['channel'], target.targetId);
        assert.equal(calls.at(-1)?.['thread_ts'], target.threadId);
    } finally {
        globalThis.fetch = oldFetch;
        if (before === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = before;
    }
});
