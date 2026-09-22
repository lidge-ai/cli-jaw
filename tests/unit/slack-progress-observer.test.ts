import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadLocales } from '../../src/core/i18n.ts';
import { broadcast } from '../../src/core/bus.ts';
import { publish } from '../../src/core/event-bus.ts';
import { notifyRuntimeLiveness } from '../../src/agent/runtime/liveness.ts';
import { createSlackProgressLifecycle } from '../../src/slack/progress-lifecycle.ts';
import { RuntimeProjection } from '../../src/agent/runtime/projection.ts';
loadLocales(fileURLToPath(new URL('../../public/locales/', import.meta.url)));
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
type Call = { method: string; body: Record<string, unknown> };
let serial = 0;
function fixture(context: TestContext, options: { workingDir?: string; closeStreamAfterMs?: number } = {}) {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const calls: Call[] = [];
    const began = Date.now();
    context.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
        assert.ok(String(url).startsWith('https://slack.com/api/chat.'), 'unexpected network is rejected');
        calls.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
        if (String(url).endsWith('/chat.appendStream') && options.closeStreamAfterMs !== undefined
            && Date.now() - began >= options.closeStreamAfterMs) {
            return new Response(JSON.stringify({ ok: false, error: 'message_not_in_streaming_state' }));
        }
        return new Response(JSON.stringify({ ok: true, ts: '100.2' }));
    });
    const identity = { requestId: `observer-${++serial}`, scope: 'scope', sessionId: 'session', origin: 'slack', runId: 'run-own' };
    const registered = new Set<(signal?: AbortSignal) => Promise<void>>();
    let closed = 0, activity = 0;
    const outcomes: string[] = [];
    const life = createSlackProgressLifecycle({
        token: `fake-${serial}`, target: { channel: 'slack', targetKind: 'channel', peerKind: 'direct', targetId: 'D_TEST', threadId: '100.1' },
        ...identity, locale: 'en', ...options,
        registerTeardown: (_id, _seal, drain) => { registered.add(drain); return () => { registered.delete(drain); }; },
        onPosted: () => {}, onTerminalConfirmed: () => { closed++; },
        onActivity: () => { activity++; }, onExecutionOutcome: outcome => { outcomes.push(outcome); },
    });
    life.start({ initialPhase: 'running' });
    context.after(async () => { await life.finish('expired'); context.mock.timers.reset(); });
    const tick = async (ms = 0) => { await settle(); context.mock.timers.tick(ms); await settle(); };
    const print = (overrides: Record<string, unknown> = {}) => broadcast('agent_tool', {
        ...identity, traceRunId: identity.runId, stepRef: 'one', toolType: 'tool', label: 'Read', status: 'done',
        detail: 'PRIVATE_CANARY /private/source', ...overrides,
    });
    const native = (overrides: Record<string, unknown> = {}) => publish('agent', 'agent_runtime', {
        version: 1, runId: identity.runId, scope: identity.scope, sessionId: identity.sessionId,
        turnId: 'turn', itemId: 'one', seq: 1, kind: 'tool', name: 'Read', status: 'done', input: 'PRIVATE_CANARY', ...overrides,
    });
    const titles = () => calls.flatMap(c => ((c.body['chunks'] ?? []) as Array<Record<string, unknown>>)
        .filter(x => String(x['id']).startsWith('recent-')).map(x => String(x['title'])));
    return { life, calls, tick, print, native, identity, registered, titles, outcomes,
        closed: () => closed, activity: () => activity };
}

test('print activity requires the captured request and rejects conflicting scope/session/origin', async context => {
    const f = fixture(context); await f.tick();
    for (const patch of [{ requestId: 'foreign' }, { requestId: undefined }, { scope: 'foreign' },
        { sessionId: 'foreign' }, { origin: 'web' }, { toolType: 'thinking' }, { icon: '💬' }]) {
        f.print({ ...patch, label: 'Write' });
    }
    await f.tick(); assert.equal(f.titles().length, 0);
    f.print(); await f.tick();
    assert.ok(f.titles().some(title => title.includes('Read')));
    assert.ok(f.titles().every(title => !title.includes('File editing')));
    assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE_CANARY|private\/source/);
});

test('bounded projection plus an expired five-minute stream retains live status through minute nineteen', async context => {
    const f = fixture(context, { closeStreamAfterMs: 300000 });
    await f.tick();
    notifyRuntimeLiveness(f.identity);
    let records = 0;
    const projection = new RuntimeProjection({ runId: f.identity.runId, sessionId: f.identity.sessionId,
        scope: f.identity.scope, turnId: 'example-turn', audience: 'public' }, (owner, body) => {
        const event = { ...owner, version: 1 as const, seq: ++records, ...body };
        publish('agent', 'agent_runtime', event);
        return event;
    }, () => {});
    projection.start('fixture');
    for (let i = 0; i < 250; i++) projection.text('message', `item-${i}`, 'x'.repeat(4000), 'replace');
    const cappedRecords = records;
    projection.tool('after-cap', { name: 'Write', status: 'running', input: 'PRIVATE_INPUT_CANARY' });
    assert.equal(records, cappedRecords, 'preview capacity can stop detail without stopping execution');
    assert.equal(projection.diagnostics().recordingFailed, false);
    for (let minute = 0; minute < 19; minute++) {
        await f.tick(60000);
        notifyRuntimeLiveness(f.identity);
        await f.tick(3200);
    }
    assert.equal(f.registered.size, 1, 'no five-minute observer expiration');
    assert.equal(f.outcomes.length, 0, 'projection/stream exhaustion is not execution failure');
    assert.equal(f.calls.filter(call => call.method === 'chat.startStream').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'chat.postMessage').length, 0);
    assert.equal(f.calls.filter(call => call.method === 'chat.stopStream').length, 0);
    const updates = f.calls.filter(call => call.method === 'chat.update');
    assert.ok(updates.length > 0);
    const latest = String(updates.at(-1)!.body['text']);
    assert.match(latest, /Activity updates unavailable/);
    assert.match(latest, /Last runtime signal: [0-3]s ago/);
    assert.match(latest, /Last activity: 1\d{3}s ago/);
    assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE_INPUT_CANARY|example-turn|item-249/);
    const activities = f.activity();
    notifyRuntimeLiveness({ ...f.identity, requestId: 'foreign-request' });
    assert.equal(f.activity(), activities);
    projection.close({ kind: 'turn-end', status: 'done', finalText: 'Final answer remains separate.' });
    const finished = f.life.finish('complete', { bodyDelivered: true });
    await f.tick(1100);
    await finished;
    assert.equal(f.closed(), 1);
    assert.match(String(f.calls.at(-1)!.body['text']), /Answer delivered/);
    const finalCount = f.calls.length;
    notifyRuntimeLiveness(f.identity); await f.tick(60000);
    assert.equal(f.calls.length, finalCount);
});

test('native tool buffering grants no ownership before exact private liveness binding', async context => {
    const f = fixture(context); await f.tick();
    f.native(); await f.tick(); assert.equal(f.titles().length, 0);
    notifyRuntimeLiveness({ ...f.identity, requestId: 'foreign' });
    f.native({ kind: 'request', requestId: f.identity.requestId });
    await f.tick(); assert.equal(f.titles().length, 0);
    notifyRuntimeLiveness(f.identity); await f.tick();
    assert.deepEqual(f.titles(), ['Read: Done']);
    f.native({ runId: 'foreign-run', seq: 2, name: 'Write' });
    f.native({ seq: 1, name: 'Write' });
    f.print({ label: 'Write' }); // proven compatibility duplicate for the bound native run
    await f.tick(3200);
    assert.ok(f.titles().every(title => title === 'Read: Done'));
});

test('native prebinding entries expire and oversized identities cannot bind', async context => {
    const f = fixture(context); await f.tick(); f.native();
    await f.tick(30001);
    notifyRuntimeLiveness(f.identity); await f.tick();
    assert.equal(f.titles().length, 0);
    f.native({ seq: 2, itemId: 'x'.repeat(257), name: 'Write' });
    await f.tick(3200);
    assert.equal(f.titles().length, 0);
});

test('fifth candidate evicts the oldest unbound run without exposing it', async context => {
    const f = fixture(context); await f.tick();
    for (let i = 0; i < 5; i++) f.native({ runId: `candidate-${i}`, seq: i + 1 });
    notifyRuntimeLiveness({ ...f.identity, runId: 'candidate-0' }); await f.tick();
    assert.equal(f.titles().length, 0);
});

test('prebinding count eviction keeps recent entries and immutable run binding', async context => {
    const f = fixture(context); await f.tick();
    f.native({ seq: 1, itemId: 'first', name: 'Write' });
    for (let i = 2; i <= 33; i++) f.native({ seq: i, itemId: `item-${i}` });
    notifyRuntimeLiveness(f.identity); await f.tick();
    assert.ok(f.titles().length <= 6);
    assert.ok(f.titles().every(title => title === 'Read: Done'));
    notifyRuntimeLiveness({ ...f.identity, runId: 'new-run' });
    f.native({ runId: 'new-run', seq: 34, name: 'Write' }); await f.tick(3200);
    assert.ok(f.titles().every(title => title !== 'File editing: Done'));
});

test('skipped/steered/completed settlement is not execution or delivery success', async context => {
    const f = fixture(context); await f.tick();
    for (const outcome of ['skipped', 'steered', 'completed']) broadcast('request_settled', { ...f.identity, outcome });
    await f.tick(); assert.deepEqual(f.outcomes, []); assert.equal(f.closed(), 0);
    broadcast('request_settled', { ...f.identity, outcome: 'failed' });
    assert.deepEqual(f.outcomes, ['error']);
    assert.equal(f.closed(), 0, 'the body owner must still finalize');
});

test('delivering rejects tools; finalization unsubscribes both buses and the registry', async context => {
    const f = fixture(context); await f.tick(); f.print(); await f.tick();
    f.life.phase('delivering');
    f.print({ label: 'Write', stepRef: 'late' });
    await f.life.finish('complete', { bodyDelivered: true });
    assert.equal(f.registered.size, 0); assert.equal(f.closed(), 1);
    const count = f.calls.length, activities = f.activity();
    f.print(); f.native(); notifyRuntimeLiveness(f.identity);
    await f.tick(60000);
    assert.equal(f.calls.length, count); assert.equal(f.activity(), activities);
    assert.ok(f.titles().every(title => !title.includes('File editing')));
});

test('shutdown drain preserves a known cancelled request rather than inventing completion', async context => {
    const f = fixture(context); await f.tick();
    broadcast('request_settled', { ...f.identity, outcome: 'cancelled' });
    await [...f.registered][0]!();
    const stop = f.calls.find(c => c.method === 'chat.stopStream');
    assert.match(JSON.stringify(stop?.body), /Request cancelled/);
    assert.equal(f.registered.size, 0);
});

test('file projection uses captured root and respects print and native ownership', async context => {
    const options = { workingDir: '/project' };
    const f = fixture(context, options);
    options.workingDir = '/project/src';
    await f.tick();
    f.print({ requestId: 'foreign', detail: '/project/FOREIGN.ts' });
    f.print({ detail: '/project/src/print.ts', status: 'done' });
    await f.tick(4000);
    assert.ok(f.titles().includes('Read src/print.ts: Done'));
    f.native({ itemId: 'native-file', input: '{"file_path":"/project/src/native.ts","content":"PRIVATE_BODY"}', status: 'done' });
    await f.tick(4000);
    assert.ok(!f.titles().some(title => title.includes('native.ts')));
    notifyRuntimeLiveness(f.identity);
    await f.tick(4000);
    assert.ok(f.titles().includes('Read src/native.ts: Done'));
    assert.doesNotMatch(JSON.stringify(f.calls), /FOREIGN|PRIVATE_BODY|\/project/);
});
