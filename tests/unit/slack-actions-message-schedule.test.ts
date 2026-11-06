import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageActions } from '../../src/slack/actions-message.ts';
import { scheduleActions } from '../../src/slack/actions-schedule.ts';
import type { ActionContext, ActionResult, ActionVerification } from '../../src/slack/action-types.ts';
import type { ActionResource } from '../../src/slack/action-store.ts';
import type { SlackApiResult } from '../../src/slack/api.ts';
import { configureRtsOutputStore, RtsOutputStore } from '../../src/slack/rts-output-store.ts';
import Database from 'better-sqlite3';

const now = 1800000000;
const future = now + 7200;
type Reply = SlackApiResult<Record<string, unknown>>;
function fixture(operation: string, handler: (method: string, body: Record<string, unknown>) => Reply | Promise<Reply>, beforeAdmission?: (method: string) => void) {
    const clock = { ms: now * 1000 };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const rows = new Map<string, ActionResource>();
    const result = (verification: ActionVerification, data?: unknown, resourceIds: string[] = []): ActionResult => ({ ok: verification === 'verified', operation, verification, retryable: false, resourceIds, data });
    const ctx: ActionContext = {
        token: 'fixture', workspace: 'T1', botUserId: 'UBOT', actor: 'UACTOR', channel: 'D1', credentialKey: 'key1', operator: false,
        async api<T>(method: string, body: Record<string, unknown>, beforeDispatch?: () => void | Promise<void>) { beforeAdmission?.(method); await beforeDispatch?.(); calls.push({ method, body }); return await handler(method, body) as SlackApiResult<T>; },
        now: () => clock.ms,
        remember(kind, id, metadata = {}) { rows.set(id, { workspace: 'T1', actor: 'UACTOR', channel: 'D1', botUserId: 'UBOT', credentialKey: 'key1', kind, id, status: 'active', metadata }); },
        resource: (_kind, id) => rows.get(id), resources: kind => [...rows.values()].filter(r => r.kind === kind),
        retire(_kind, id) { const row = rows.get(id)!; row.status = 'retired'; row.metadata = {}; }, checkCurrent() {},
        async download() { throw new Error('unexpected download'); }, result,
        fail(error, status = 400, resourceIds = []) { return { ...result('failed', undefined, resourceIds), error, status }; },
    };
    const run = (args: Record<string, unknown> = {}) => [...messageActions, ...scheduleActions].find(d => d.operation === operation)!.prepare({ operation, channel: 'D1', invocationId: 'inv1', ...args }).execute(ctx);
    return { ctx, calls, rows, run, clock };
}
const ok = (data: Record<string, unknown>): Reply => ({ ok: true, data });
const empty = () => ok({ scheduled_messages: [], response_metadata: { next_cursor: '' } });

for (const operation of ['reaction.add', 'reaction.remove']) test(`${operation}: exact fields and own bot state without raw RTS message`, async () => {
    const add = operation.endsWith('add');
    const f = fixture(operation, method => method === 'reactions.get' ? ok({ type: 'message', message: { ts: '1.1', text: 'PRIVATE RTS', reactions: [{ name: 'eyes', count: 7, users: add ? ['UBOT'] : ['UOTHER'] }] } }) : { ok: false, error: add ? 'already_reacted' : 'no_reaction' });
    const result = await f.run({ ts: '1.1', name: 'eyes' });
    assert.equal(result.verification, 'verified');
    assert.deepEqual(f.calls[0]?.body, { channel: 'D1', timestamp: '1.1', name: 'eyes' });
    assert.deepEqual(f.calls[1]?.body, { channel: 'D1', timestamp: '1.1', full: true });
    assert.ok(!JSON.stringify(result).includes('PRIVATE RTS'));
    assert.ok(!JSON.stringify(result).includes('UOTHER'));
    assert.equal((result.data as { reactions: Array<{ usersComplete: boolean }> }).reactions[0]?.usersComplete, false);
});
test('reaction readback failure is unknown; 429 stops immediately', async () => {
    const f = fixture('reaction.remove', () => ({ ok: false, error: 'ratelimited', status: 429 }));
    assert.equal((await f.run({ ts: '1.1', name: 'eyes' })).verification, 'unknown');
    assert.equal(f.calls.length, 1);
});
test('message deletion requires actual bot author, not bot_id', async () => {
    const f = fixture('message.delete', () => ok({ messages: [{ ts: '1.1', user: 'UOTHER', bot_id: 'UBOT' }], has_more: false }));
    assert.equal((await f.run({ ts: '1.1' })).error, 'message_not_bot_owned');
    assert.equal(f.calls.length, 1);
});
test('message deletion unavailable readback cannot prove absence', async () => {
    let reads = 0;
    const f = fixture('message.delete', method => method === 'chat.delete' ? ok({}) : ++reads === 1 ? ok({ messages: [{ ts: '1.1', user: 'UBOT' }], has_more: false }) : { ok: false, error: 'missing_scope' });
    assert.equal((await f.run({ ts: '1.1' })).verification, 'unknown');
    assert.equal(f.calls.filter(c => c.method === 'chat.delete').length, 1);
});
test('message delete proves complete absence and current membership', async () => {
    let reads = 0;
    const f = fixture('message.delete', method => method === 'chat.delete' ? ok({}) : method === 'conversations.info' ? ok({ channel: { is_member: true } }) : ok({ messages: ++reads === 1 ? [{ ts: '1.1', user: 'UBOT' }] : [], has_more: false }));
    assert.equal((await f.run({ ts: '1.1' })).verification, 'verified');
});
test('RTS registered output update is denied before write', async () => {
    const db = new Database(':memory:'); const store = new RtsOutputStore(db);
    configureRtsOutputStore(store); store.record('T1', 'D1', '1.1');
    try {
        const f = fixture('message.update', () => ok({ messages: [{ ts: '1.1', user: 'UBOT', text: 'old' }], has_more: false }));
        assert.equal((await f.run({ ts: '1.1', text: 'new' })).error, 'rts_update_denied');
        assert.equal(f.calls.length, 1);
    } finally { configureRtsOutputStore(undefined); db.close(); }
});
test('schedule create records ownership immediately, no metadata, exact readback', async () => {
    const f = fixture('schedule.create', (method, body) => {
        if (method === 'chat.scheduleMessage') {
            assert.equal(body['metadata'], undefined); assert.equal(body['post_at'], future);
            return ok({ scheduled_message_id: 'Q1' });
        }
        assert.ok(f.rows.has('Q1'));
        return ok({ scheduled_messages: [{ id: 'Q1', channel_id: 'D1', post_at: future, text: 'hello' }] });
    });
    const receipt = await f.run({ postAt: future, text: 'hello' });
    assert.equal(receipt.verification, 'verified'); assert.deepEqual(receipt.resourceIds, ['Q1']);
});
test('schedule cancel rejects rotated token and preserves pending record', async () => {
    const f = fixture('schedule.cancel', () => { throw new Error('must not call'); });
    f.ctx.remember('schedule', 'Q1', { postAt: future }); f.rows.get('Q1')!.credentialKey = 'old';
    assert.equal((await f.run({ scheduledId: 'Q1' })).error, 'schedule_credential_changed');
    assert.equal(f.rows.get('Q1')!.status, 'active'); assert.equal(f.calls.length, 0);
});
test('schedule list filters actor ledger and identifies old-credential pending', async () => {
    const f = fixture('schedule.list', () => ok({ scheduled_messages: ['Q1', 'Q2'].map(id => ({ id, channel_id: 'D1', post_at: future, text: 'SECRET' })) }));
    f.ctx.remember('schedule', 'Q1', { postAt: future });
    f.ctx.remember('schedule', 'Q2', { postAt: future }); f.rows.get('Q2')!.actor = 'UOTHER';
    f.ctx.remember('schedule', 'QOLD', { postAt: future }); f.rows.get('QOLD')!.credentialKey = 'old';
    const receipt = await f.run(); assert.equal(receipt.verification, 'partial');
    assert.deepEqual(receipt.resourceIds, ['Q1']); assert.ok(!JSON.stringify(receipt).includes('SECRET'));
    assert.deepEqual((receipt.data as { oldCredentialPending: string[] }).oldCredentialPending, ['QOLD']);
});
test('cancel 60 second guard and >120 day creation bound', async () => {
    const f = fixture('schedule.cancel', () => { throw new Error('must not call'); });
    f.ctx.remember('schedule', 'Q1', { postAt: now + 60 });
    assert.equal((await f.run({ scheduledId: 'Q1' })).error, 'schedule_cancel_too_late');
    const c = fixture('schedule.create', () => { throw new Error('must not call'); });
    assert.equal((await c.run({ postAt: now + 121 * 86400, text: 'hello' })).error, 'invalid_schedule_time');
});
test('incomplete/repeating list cannot retire cancelled schedule', async () => {
    const f = fixture('schedule.cancel', method => method === 'chat.deleteScheduledMessage' ? ok({}) : ok({ scheduled_messages: [], response_metadata: { next_cursor: 'same' } }));
    f.ctx.remember('schedule', 'Q1', { postAt: future });
    assert.equal((await f.run({ scheduledId: 'Q1' })).verification, 'unknown');
    assert.equal(f.rows.get('Q1')!.status, 'active'); assert.equal(f.calls.length, 3);
});
test('time-only replacement uses retained payload, cancels first, reports partial on new failure', async () => {
    const f = fixture('schedule.update', (method, body) => {
        if (method === 'chat.scheduleMessage') { assert.equal(body['text'], 'retained'); return { ok: false, error: 'ratelimited' }; }
        return method === 'chat.scheduledMessages.list' ? empty() : ok({});
    });
    f.ctx.remember('schedule', 'Q1', { postAt: future, payload: { text: 'retained' } });
    const receipt = await f.run({ scheduledId: 'Q1', postAt: future + 100 });
    assert.equal(receipt.verification, 'partial'); assert.equal(receipt.retryable, false);
    assert.equal(f.rows.get('Q1')!.status, 'retired');
    assert.deepEqual(f.calls.map(c => c.method), ['chat.deleteScheduledMessage', 'chat.scheduledMessages.list', 'chat.scheduleMessage']);
    assert.deepEqual(receipt.resourceIds, ['Q1']);
});
test('invalid replacement fails before cancellation', async () => {
    const f = fixture('schedule.update', () => { throw new Error('must not call'); });
    f.ctx.remember('schedule', 'Q1', { postAt: future, payload: { text: 'retained' } });
    assert.equal((await f.run({ scheduledId: 'Q1', postAt: 1 })).error, 'invalid_schedule_time');
    assert.equal(f.calls.length, 0);
});
test('all parsers reject unknown fields before any remote call', () => {
    for (const action of [...messageActions, ...scheduleActions]) assert.throws(() => action.prepare({ operation: action.operation, channel: 'D1', invocationId: 'i', arbitrary: true }));
});
test('schedule rich/thread omitted readback is partial, not fully verified', async () => {
    const f = fixture('schedule.create', method => method === 'chat.scheduleMessage' ? ok({ scheduled_message_id: 'Q1' }) : ok({ scheduled_messages: [{ id: 'Q1', channel_id: 'D1', post_at: future, text: 'hello' }] }));
    assert.equal((await f.run({ postAt: future, threadTs: '1.1', text: 'hello' })).verification, 'partial');
    assert.equal(f.calls[0]?.body['thread_ts'], '1.1');
});
test('multipart creation retains first ID and never retries second failed part', async () => {
    let posts = 0;
    const f = fixture('schedule.create', method => {
        assert.equal(method, 'chat.scheduleMessage');
        if (++posts === 1) return ok({ scheduled_message_id: 'Q1' });
        assert.ok(f.rows.has('Q1')); throw new Error('timeout');
    });
    const table = { type: 'table', rows: [[{ type: 'raw_text', text: 'cell' }]] };
    const result = await f.run({ postAt: future, text: 'tables', blocks: [table, table] });
    assert.equal(result.verification, 'partial'); assert.deepEqual(result.resourceIds, ['Q1']); assert.equal(posts, 2);
});
test('schedule cancellation readback throw retains active state and ID', async () => {
    const f = fixture('schedule.cancel', method => { if (method === 'chat.deleteScheduledMessage') return ok({}); throw new Error('timeout'); });
    f.ctx.remember('schedule', 'Q1', { postAt: future });
    const result = await f.run({ scheduledId: 'Q1' }); assert.equal(result.verification, 'unknown');
    assert.deepEqual(result.resourceIds, ['Q1']); assert.equal(f.rows.get('Q1')!.status, 'active');
});
test('message update exact content readback detects changed text', async () => {
    const db = new Database(':memory:'); configureRtsOutputStore(new RtsOutputStore(db));
    try {
        for (const text of ['new', 'wrong']) {
            let reads = 0;
            const f = fixture('message.update', method => method === 'chat.update' ? ok({}) : ok({ messages: [{ ts: '1.1', user: 'UBOT', text: ++reads === 1 ? 'old' : text, blocks: [] }], has_more: false }));
            assert.equal((await f.run({ ts: '1.1', text: 'new' })).verification, text === 'new' ? 'verified' : 'failed');
        }
    } finally { configureRtsOutputStore(undefined); db.close(); }
});
test('runtime-masked RTS message cannot be updated without surviving markers', async () => {
    const f = fixture('message.update', () => ok({ messages: [{ ts: '1.1', user: 'UBOT', contentExcluded: true, text: '[검색 응답 내용 제외]', blocks: [] }], has_more: false }));
    assert.equal((await f.run({ ts: '1.1', text: 'replacement' })).error, 'rts_update_denied');
    assert.deepEqual(f.calls.map(c => c.method), ['conversations.history']);
});
test('runtime-masked RTS message retains sufficient bot ownership for deletion', async () => {
    let reads = 0;
    const f = fixture('message.delete', method => method === 'chat.delete' ? ok({}) : method === 'conversations.info' ? ok({ channel: { is_member: true } }) : ok({ messages: ++reads === 1 ? [{ ts: '1.1', user: 'UBOT', contentExcluded: true }] : [], has_more: false }));
    assert.equal((await f.run({ ts: '1.1' })).verification, 'verified');
});
test('runtime resource credential rejection propagates before remote cancellation', async () => {
    const f = fixture('schedule.cancel', () => { throw new Error('must not call'); });
    f.ctx.resource = () => { throw Object.assign(new Error('slack_schedule_credential_changed'), { statusCode: 409 }); };
    await assert.rejects(f.run({ scheduledId: 'Q1' }), /slack_schedule_credential_changed/);
    assert.equal(f.calls.length, 0);
});
test('registered operation names match the frozen wp4 interface', () => {
    assert.deepEqual([...messageActions, ...scheduleActions].map(d => d.operation).sort(), [
        'reaction.add', 'reaction.remove', 'reaction.get', 'message.update', 'message.delete',
        'schedule.create', 'schedule.list', 'schedule.cancel', 'schedule.update',
    ].sort());
});
test('create dispatch hook prevents HTTP when pacing reaches postAt', async () => {
    const f = fixture('schedule.create', () => { throw new Error('no HTTP'); }, () => { f.clock.ms = future * 1000; });
    const receipt = await f.run({ postAt: future, text: 'hello' });
    assert.equal(receipt.verification, 'failed');
    assert.equal(f.calls.length, 0); assert.equal(f.rows.size, 0);
});
test('cancel dispatch hook rejects the exact 60-second boundary after pacing', async () => {
    const f = fixture('schedule.cancel', () => { throw new Error('no HTTP'); }, () => { f.clock.ms = (future - 60) * 1000; });
    f.ctx.remember('schedule', 'Q1', { postAt: future });
    const receipt = await f.run({ scheduledId: 'Q1' });
    assert.equal(receipt.error, 'schedule_cancel_too_late'); assert.equal(f.calls.length, 0);
    assert.equal(f.rows.get('Q1')!.status, 'active');
});
test('replacement expiry at dispatch remains partial after confirmed old cancellation', async () => {
    const f = fixture('schedule.update', method => method === 'chat.scheduledMessages.list' ? empty() : ok({}), method => {
        if (method === 'chat.scheduleMessage') f.clock.ms = (future + 100) * 1000;
    });
    f.ctx.remember('schedule', 'Q1', { postAt: future, payload: { text: 'retained' } });
    const receipt = await f.run({ scheduledId: 'Q1', postAt: future + 100 });
    assert.equal(receipt.verification, 'partial'); assert.equal(receipt.partial, true); assert.equal(receipt.retryable, false);
    assert.equal((receipt.data as { oldCancelled: boolean }).oldCancelled, true);
    assert.deepEqual(receipt.resourceIds, ['Q1']); assert.equal(f.rows.get('Q1')!.status, 'retired');
    assert.deepEqual(f.calls.map(c => c.method), ['chat.deleteScheduledMessage', 'chat.scheduledMessages.list']);
});
test('multipart dispatch expiry preserves acknowledged first part without second HTTP', async () => {
    let admissions = 0;
    const f = fixture('schedule.create', () => ok({ scheduled_message_id: 'Q1' }), () => {
        if (++admissions === 2) f.clock.ms = future * 1000;
    });
    const table = { type: 'table', rows: [[{ type: 'raw_text', text: 'cell' }]] };
    const receipt = await f.run({ postAt: future, text: 'tables', blocks: [table, table] });
    assert.equal(receipt.verification, 'partial'); assert.deepEqual(receipt.resourceIds, ['Q1']);
    assert.equal(f.calls.length, 1); assert.equal(f.rows.get('Q1')!.status, 'active');
});
test('schedule listing propagates incomplete actual ledger before API and never reports complete', async () => {
    const { SlackActionStore } = await import('../../src/slack/action-store.ts');
    const db = new Database(':memory:');
    try {
        const store = new SlackActionStore(db);
        db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
            INSERT INTO slack_tool_resources SELECT 'T1','schedule','Q'||x,'UACTOR','D1','UBOT',CASE WHEN x=1001 THEN 'old' ELSE 'key1' END,'active','{}' FROM n`);
        const f = fixture('schedule.list', empty);
        f.ctx.resources = kind => store.resources('T1', kind, 'D1', 'UACTOR');
        await assert.rejects(f.run(), /slack_action_resource_list_incomplete/);
        assert.equal(f.calls.length, 0);
        assert.equal(store.resource('T1', 'schedule', 'Q1001')!.status, 'active');
    } finally { db.close(); }
});
test('schedule listing treats absent/old creation fingerprints as pending, not current-token proof', async () => {
    const f = fixture('schedule.list', () => ok({ scheduled_messages: ['QCURRENT', 'QOLD', 'QMISSING'].map(id => ({ id, channel_id: 'D1', post_at: future, text: 'not returned' })) }));
    for (const id of ['QCURRENT', 'QOLD', 'QMISSING']) f.ctx.remember('schedule', id, { postAt: future });
    f.rows.get('QOLD')!.credentialKey = 'old'; f.rows.get('QMISSING')!.credentialKey = '';
    const receipt = await f.run();
    assert.equal(receipt.verification, 'partial'); assert.deepEqual(receipt.resourceIds, ['QCURRENT']);
    const data = receipt.data as { complete: boolean; oldCredentialPending: string[] };
    assert.equal(data.complete, false); assert.deepEqual(data.oldCredentialPending.sort(), ['QMISSING', 'QOLD']);
    assert.equal(f.rows.get('QOLD')!.status, 'active'); assert.equal(f.rows.get('QMISSING')!.status, 'active');
});

for (const tombstone of [true, false]) test(`delete readback recognizes only an explicit tombstone: ${tombstone}`, async () => {
    let reads = 0;
    const f = fixture('message.delete', method => method === 'chat.delete' ? ok({})
        : method === 'conversations.info' ? ok({ channel: { is_member: true } })
        : ok({ messages: ++reads === 1 ? [{ ts: '1.1', user: 'UBOT' }]
            : [{ ts: '1.1', user: 'USLACKBOT', text: 'This message was deleted.', ...(tombstone ? { subtype: 'tombstone' } : {}) }], has_more: false }));
    const result = await f.run({ ts: '1.1' });
    assert.equal(result.verification, tombstone ? 'verified' : 'failed');
    assert.deepEqual(result.data, { deleted: tombstone });
    assert.equal(f.calls.filter(c => c.method === 'chat.delete').length, 1);
});

test('tombstone after deletion still requires current bot membership', async () => {
    let reads = 0;
    const f = fixture('message.delete', method => method === 'chat.delete' ? ok({})
        : method === 'conversations.info' ? { ok: false, error: 'not_in_channel' }
        : ok({ messages: ++reads === 1 ? [{ ts: '1.1', user: 'UBOT' }]
            : [{ ts: '1.1', subtype: 'tombstone' }], has_more: false }));
    const result = await f.run({ ts: '1.1' });
    assert.equal(result.verification, 'unknown');
    assert.deepEqual(result.data, { deleted: null });
});

test('a preexisting tombstone never authorizes a new deletion', async () => {
    const f = fixture('message.delete', () => ok({ messages: [{ ts: '1.1', subtype: 'tombstone', user: 'USLACKBOT' }], has_more: false }));
    assert.equal((await f.run({ ts: '1.1' })).error, 'message_not_bot_owned');
    assert.equal(f.calls.length, 1);
});
