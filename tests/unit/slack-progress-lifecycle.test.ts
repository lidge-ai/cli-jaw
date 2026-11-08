import { configureSlackFailureStore, SlackFailureStore } from '../../src/slack/failure-store.ts';
import '../setup/isolated-home.ts';
import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { settings } from '../../src/core/config.ts';
import { loadLocales, t } from '../../src/core/i18n.ts';
import { broadcast } from '../../src/core/bus.ts';
import { sessionLanes } from '../../src/orchestrator/session-lanes.ts';
import { recordSelfDelivery } from '../../src/messaging/turn-delivery.ts';
import { notifyRuntimeLiveness } from '../../src/agent/runtime/liveness.ts';
import { initQueueNoticeStore, getQueueNoticeStore, __resetQueueNoticeStoreForTests } from '../../src/messaging/queue-notice-store.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
loadLocales(fileURLToPath(new URL('../../public/locales/', import.meta.url)));

type Call = { method: string; body: Record<string, unknown>; signal?: AbortSignal | null };
type Saved = { ts: string; channel: string; text?: string; blocks?: Array<Record<string, unknown>>; streaming_state?: string };
type Collected = { text: string; data: Record<string, unknown> };
const calls: Call[] = [];
const saved = new Map<string, Saved>();
const admissions: Array<Record<string, unknown>> = [];
const tails = new Set<Promise<void>>();
let queued = false, steered = false, seq = 0, messageSeq = 0, credentialSeq = 0;
let inlineControl: ((admission: Record<string, unknown>) => void) | undefined;
let collect: (meta: Record<string, unknown>) => Promise<Collected> = async () => ({ text: 'answer', data: {} });
let override: ((call: Call) => Promise<Response | undefined> | Response | undefined) | undefined;
let releases: Array<() => void> = [];
let database: Database.Database;
const response = (value: Record<string, unknown>) => new Response(JSON.stringify(value));
const fallbackProgress = (body: Record<string, unknown>) => String(body['text'] ?? '').startsWith('Request progress');
const bodyCalls = () => calls.filter(call => call.method === 'chat.postMessage' && !fallbackProgress(call.body));
function applyChunks(message: Saved, value: unknown) {
    const plan = message.blocks?.find(block => block['type'] === 'plan') ?? { type: 'plan', tasks: [] };
    const tasks = plan['tasks'] as Array<Record<string, unknown>>;
    for (const chunk of (value ?? []) as Array<Record<string, unknown>>) {
        if (chunk['type'] === 'plan_update') plan['title'] = chunk['title'];
        if (chunk['type'] === 'task_update') {
            let row = tasks.find(task => task['task_id'] === chunk['id']);
            if (!row) { row = { task_id: chunk['id'] }; tasks.push(row); }
            row['title'] = chunk['title']; row['status'] = chunk['status'];
            if (typeof chunk['details'] === 'string') row['details'] = String(row['details'] ?? '') + chunk['details'];
        }
    }
    plan['tasks'] = tasks; message.blocks = [plan];
}
mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    assert.equal(String(url), `https://slack.com/api/${method}`, 'non-Slack network is denied');
    const body = new Headers(init?.headers).get('content-type')?.includes('x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(String(init?.body))) : JSON.parse(String(init?.body ?? '{}'));
    const call: Call = { method, body, signal: init?.signal }; calls.push(call);
    const special = await override?.(call); if (special) return special;
    if (method === 'auth.test') return response({ ok: true, team_id: 'T_TEST', user_id: 'U_BOT' });
    if (method === 'users.info') return response({ ok: true, user: { id: 'UTEST', is_bot: false } });
    if (method === 'reactions.add' || method === 'reactions.remove') return response({ ok: true });
    if (method === 'chat.startStream' || method === 'chat.postMessage') {
        const ts = `200.${++messageSeq}`;
        const message: Saved = { ts, channel: String(body['channel']),
            ...(body['text'] !== undefined ? { text: body['text'] } : {}),
            ...(body['blocks'] ? { blocks: structuredClone(body['blocks']) } : {}) };
        if (method === 'chat.startStream') { message.streaming_state = 'streaming'; applyChunks(message, body['chunks']); }
        saved.set(ts, message); return response({ ok: true, ts });
    }
    if (method === 'conversations.replies') {
        return response({ ok: true, messages: [...saved.values()].filter(message => message.channel === body['channel']), has_more: false });
    }
    if (method === 'chat.stopStream') {
        const message = saved.get(String(body['ts']));
        if (!message) return response({ ok: false, error: 'message_not_found' });
        if (message.streaming_state !== 'streaming') return response({ ok: false, error: 'message_not_in_streaming_state' });
        applyChunks(message, body['chunks']); message.streaming_state = 'completed';
        return response({ ok: true });
    }
    if (method === 'chat.appendStream') {
        const message = saved.get(String(body['ts'])); assert.ok(message);
        applyChunks(message, body['chunks']); return response({ ok: true });
    }
    if (method === 'chat.update') {
        const message = saved.get(String(body['ts'])); assert.ok(message);
        message.text = String(body['text']); message.blocks = body['blocks'] ?? [];
        return response({ ok: true });
    }
    if (method === 'chat.delete') { saved.delete(String(body['ts'])); return response({ ok: true }); }
    throw new Error(`Unexpected method: ${method}`);
});
mock.module('../../src/orchestrator/collect.ts', { namedExports: {
    orchestrateAndCollectData: async (_prompt: string, meta: Record<string, unknown>) => collect(meta),
    orchestrateAndCollect: async () => { throw new Error('Unexpected text-only collector'); },
} });
mock.module('../../src/orchestrator/gateway.ts', { namedExports: {
    submitMessage: (_prompt: string, meta: Record<string, unknown>) => {
        const requestId = `lifecycle-${++seq}`;
        const sessionContext = { scope: String(meta['scope']), chatSessionId: String(meta['chatSessionId']) };
        const admission = { ...meta, requestId, sessionContext };
        admissions.push(admission);
        inlineControl?.(admission);
        return { action: queued ? 'queued' : 'started', ...(queued ? { queued: true } : { disposition: steered ? 'steered' : 'new_run' }),
            pending: 1, requestId, sessionContext };
    },
} });
const identity = await import('../../src/slack/identity.ts');
mock.module('../../src/slack/identity.ts', { namedExports: { ...identity,
    resolveSenderIdentity: async () => ({ id: 'U_TEST', name: 'User', kind: 'user' }),
    buildSenderPrompt: (_identity: unknown, text: string) => text,
    buildSenderDisplay: (_identity: unknown, text: string) => text,
} });
const ingress = await import('../../src/slack/ingress.ts');
mock.module('../../src/slack/ingress.ts', { namedExports: { ...ingress,
    admitSlackRun: (params: Parameters<typeof ingress.admitSlackRun>[0]) => {
        const result = ingress.admitSlackRun(params);
        if (result.laneTail) {
            tails.add(result.laneTail);
            void result.laneTail.finally(() => tails.delete(result.laneTail!));
        }
        return result;
    },
} });
const ledgerModule = await import('../../src/slack/reply-delivery.ts');
let deliveryLedger: ReturnType<typeof ledgerModule.createSlackReplyDeliveryLedger>;
mock.module('../../src/slack/reply-delivery.ts', { namedExports: {
    createSlackReplyDeliveryLedger: () => {
        deliveryLedger = ledgerModule.createSlackReplyDeliveryLedger();
        return deliveryLedger;
    },
} });
const bot = await import('../../src/slack/bot.ts');
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function tick(context: TestContext, ms = 0) { await settle(); context.mock.timers.tick(ms); await settle(); }
async function until(context: TestContext, condition: () => boolean) {
    for (let i = 0; i < 100; i++) { await tick(context); if (condition()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.fail(`condition not observed; methods=${calls.map(call => call.method).join(',')}`);
}
function deferred<T>(fallback: T) {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    releases.push(() => resolve(fallback)); return { promise, resolve };
}
function target(): RemoteTarget { return { channel: 'slack', targetKind: 'channel', peerKind: 'direct', targetId: `D_CASE_${seq + 1}`, threadId: '100.1', guildId: 'T_TEST' }; }
async function run(context: TestContext, destination = target(), signal = new AbortController().signal, fields: Record<string, unknown> = {}) {
    if (fields['type'] === 'block_actions') {
        destination.targetId = `DCASE${seq + 1}`;
        bot.setSlackSelfIdentityForTest({ userId: 'U_BOT', botId: 'BBOT' });
        const env = { envelope_id: `click-${seq + 1}`, type: 'interactive' as const, payload: {
            type: 'block_actions', team: { id: 'T_TEST' }, user: { id: 'UTEST' },
            container: { type: 'message', channel_id: destination.targetId, message_ts: '100.1' },
            message: { ts: '100.1', user: 'U_BOT', bot_id: 'BBOT' },
            actions: [{ action_id: 'agent:test', action_ts: `100.${seq + 2}` }],
        } };
        assert.equal(await bot.preflightSlackEnvelope(env), 'committed');
        await bot.handleSlackEnvelope(env);
    } else {
        await bot.processSlackMessageEvent({ user: 'U_TEST', channel: destination.targetId, channel_type: destination.peerKind === 'direct' ? 'im' : 'channel', ts: '100.2', thread_ts: destination.threadId, ...fields } as never,
            destination, 'hello', signal);
    }
    await until(context, () => admissions.some(admission => (admission['target'] as RemoteTarget).targetId === destination.targetId));
    return admissions.find(admission => (admission['target'] as RemoteTarget).targetId === destination.targetId)!;
}
function event(admission: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const ctx = admission['sessionContext'] as { scope: string; chatSessionId: string };
    return { requestId: admission['requestId'], origin: 'slack', scope: ctx.scope, sessionId: ctx.chatSessionId,
        target: admission['target'], ...extra };
}
const progressMessages = () => [...saved.values()].filter(message => message.streaming_state);
const complete = () => progressMessages().length > 0 && progressMessages().every(message => message.streaming_state === 'completed');
const reaction = (name: string) => calls.filter(call => call.method === 'reactions.add' && call.body['name'] === name);

test.beforeEach(async context => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    calls.length = admissions.length = 0; saved.clear(); releases = []; queued = false; steered = false; inlineControl = undefined; override = undefined;
    collect = async () => ({ text: 'answer', data: {} });
    Object.assign(settings, { locale: 'en', port: 3457, multiSession: { enabled: true, channels: { slack: true }, maxConcurrent: 4 },
        slack: { enabled: true, botToken: `fake-lifecycle-${++credentialSeq}`, appToken: '', teamId: 'T_TEST', conversationContext: false,
            ack: { enabled: true, scope: 'all' } } });
    __resetQueueNoticeStoreForTests(); database = new Database(':memory:'); initQueueNoticeStore(database); configureSlackFailureStore(new SlackFailureStore(database));
    await bot.initSlack(); // Configured outbound-only: no socket or auth request.
    calls.length = 0;
});
test.afterEach(async context => {
    for (const release of releases) release();
    const closing = bot.shutdownSlack(); await settle(); context.mock.timers.tick(2000); await settle();
    await closing; await Promise.allSettled([...tails]);
    __resetQueueNoticeStoreForTests(); configureSlackFailureStore(null); database.close(); context.mock.timers.reset();
});

test('direct synchronous tool is observed and final progress follows the real body receipt', async context => {
    collect = async meta => {
        broadcast('agent_tool', { ...meta, sessionId: meta['chatSessionId'], traceRunId: 'tr-test', stepRef: 'read', label: 'Read', status: 'done', toolType: 'tool', detail: 'PRIVATE_CANARY command=cat secret' });
        return { text: 'answer', data: {} };
    };
    await run(context); await until(context, complete);
    const bodyIndex = calls.findIndex(call => call.method === 'chat.postMessage');
    const ackIndex = calls.findIndex(call => call.method === 'reactions.add' && call.body['name'] === 'white_check_mark');
    const stopIndex = calls.findIndex(call => call.method === 'chat.stopStream');
    assert.ok(bodyIndex >= 0 && bodyIndex < ackIndex && ackIndex < stopIndex);
    assert.match(JSON.stringify(progressMessages()), /Read: Done/);
    assert.doesNotMatch(JSON.stringify(progressMessages()), /PRIVATE_CANARY/);
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
});

test('an expired Slack stream keeps a long direct job observable and its final body is delivered once', async context => {
    const output = deferred<Collected>({ text: 'final answer', data: {} });
    collect = () => output.promise;
    const began = Date.now();
    override = call => {
        if (call.method === 'chat.appendStream' && Date.now() - began >= 300000) {
            const message = saved.get(String(call.body['ts']));
            if (message) message.streaming_state = 'completed';
            return response({ ok: false, error: 'message_not_in_streaming_state' });
        }
        return undefined;
    };
    const admission = await run(context);
    for (let minute = 0; minute < 19; minute++) {
        notifyRuntimeLiveness({ runId: 'example-long-run', sessionId: String(admission['chatSessionId']),
            scope: String(admission['scope']), origin: 'slack', requestId: String(admission['requestId']) });
        await tick(context, 60000); await tick(context, 3200);
    }
    assert.equal(bodyCalls().length, 0);
    assert.equal(reaction('x').length, 0); assert.equal(reaction('white_check_mark').length, 0);
    assert.ok(calls.some(call => call.method === 'chat.update'));
    assert.equal(calls.filter(call => call.method === 'chat.startStream').length, 1);
    output.resolve({ text: 'final answer', data: {} });
    await until(context, () => bodyCalls().length === 1 && reaction('white_check_mark').length === 1);
    await tick(context, 10000);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('x').length, 0);
});

test('a deferred progress start cannot prevent body delivery; late receipt is closed once', async context => {
    const start = deferred(response({ ok: false, error: 'internal_error' }));
    override = call => call.method === 'chat.startStream' ? start.promise : undefined;
    await run(context); await until(context, () => bodyCalls().length === 1);
    assert.equal(calls.some(call => call.method === 'chat.stopStream'), false);
    saved.set('300.1', { ts: '300.1', channel: String(admissions[0]!['target'] && (admissions[0]!['target'] as RemoteTarget).targetId), streaming_state: 'streaming' });
    start.resolve(response({ ok: true, ts: '300.1' }));
    await until(context, complete);
    assert.equal(bodyCalls().length, 1);
    assert.equal(calls.filter(call => call.method === 'chat.stopStream').length, 1);
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
});

for (const data of [{ executionFailed: true }, { runtimeFinality: 'present', runtimeStatus: 'error' }, { runtimeFinality: 'present', runtimeStatus: 'stopped' }]) {
    test(`delivered final failure is not a success reaction: ${JSON.stringify(data)}`, async context => {
        collect = async () => ({ text: 'salvaged answer', data });
        await run(context); await until(context, complete);
        assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 0);
        assert.equal(reaction('x').length, 1);
        assert.match(JSON.stringify(progressMessages()), /Answer delivered/);
    });
}

test('collector exception provenance chooses fixed diagnostic without raw error leakage', async context => {
    collect = async () => ({ text: 'SECRET_STACK /private/path', data: { collectionFailure: 'error' } });
    await run(context); await until(context, complete);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 0);
    assert.doesNotMatch(JSON.stringify(calls.map(call => call.body)), /SECRET_STACK|private\/path/);
});

for (const [reply, shown] of [['[SILENT]', 'tg.noResponse'], ['Checked the thread.\n\n[SILENT]', 'Checked the thread.']] as const) {
    const expected = () => shown === 'tg.noResponse' ? t(shown, {}, 'en') : shown;
    test(`direct reply ${JSON.stringify(reply)} never posts the SILENT marker`, async context => {
        collect = async () => ({ text: reply, data: {} });
        await run(context); await until(context, complete);
        assert.deepEqual(bodyCalls().map(call => call.body['text']), [expected()]);
        assert.equal(reaction('white_check_mark').length, 1); assert.equal(reaction('x').length, 0);
    });
    test(`queued reply ${JSON.stringify(reply)} never posts the SILENT marker`, async context => {
        queued = true;
        const admission = await run(context); await until(context, () => progressMessages().length === 1);
        broadcast('queued_run_started', event(admission));
        broadcast('orchestrate_done', event(admission, { text: reply, fromQueue: true }));
        await until(context, complete);
        assert.deepEqual(bodyCalls().map(call => call.body['text']), [expected()]);
        assert.equal(reaction('white_check_mark').length, 1); assert.equal(reaction('x').length, 0);
    });
    test(`orphan reply ${JSON.stringify(reply)} never posts the SILENT marker`, async context => {
        const destination = target();
        broadcast('orchestrate_done', { requestId: `silent-orphan-${++seq}`, origin: 'slack', scope: `silent-orphan-${seq}`,
            target: destination, replyViaTarget: true, text: reply });
        await until(context, () => bodyCalls().length === 1);
        assert.deepEqual(bodyCalls().map(call => call.body['text']), [expected()]);
    });
}

test('a SILENT marker inside a sentence is ordinary text', async context => {
    collect = async () => ({ text: 'Reply [SILENT] when idle.', data: {} });
    await run(context); await until(context, complete);
    assert.deepEqual(bodyCalls().map(call => call.body['text']), ['Reply [SILENT] when idle.']);
});

const click = { type: 'block_actions' };
const writes = (channel: string) => calls.filter(call => call.body['channel'] === channel && call.method !== 'conversations.replies')
    .map(call => [call.method, call.body['text'] ?? null]);
test('a block action that answers only [SILENT] leaves nothing in the card thread', async context => {
    collect = async () => ({ text: '[SILENT]', data: {} });
    const destination = target();
    const admission = await run(context, destination, new AbortController().signal, click);
    await Promise.allSettled([...tails]); await tick(context, 1000);
    assert.deepEqual(writes(destination.targetId), []);
    assert.equal(getQueueNoticeStore()!.findByRequestId(String(admission['requestId'])), null);
});
test('a block action with a real answer posts only that answer, without a progress card', async context => {
    collect = async () => ({ text: 'Approved.', data: {} });
    const destination = target();
    await run(context, destination, new AbortController().signal, click);
    await Promise.allSettled([...tails]); await tick(context, 1000);
    assert.deepEqual(writes(destination.targetId), [['chat.postMessage', 'Approved.']]);
});
test('a queued block action that answers only [SILENT] leaves nothing while a queued real answer posts alone', async context => {
    queued = true;
    const silent = target();
    const quiet = await run(context, silent, new AbortController().signal, click);
    const answered = target();
    const loud = await run(context, answered, new AbortController().signal, click);
    await tick(context, 1000);
    for (const admission of [quiet, loud]) assert.equal(getQueueNoticeStore()!.findByRequestId(String(admission['requestId'])), null, 'no record a restart could restore');
    for (const admission of [quiet, loud]) broadcast('queued_run_started', event(admission));
    broadcast('orchestrate_done', event(quiet, { text: '[SILENT]', fromQueue: true }));
    broadcast('orchestrate_done', event(loud, { text: 'Approved.', fromQueue: true }));
    await until(context, () => writes(answered.targetId).length === 1);
    await tick(context, 1000);
    assert.deepEqual(writes(silent.targetId), []);
    assert.deepEqual(writes(answered.targetId), [['chat.postMessage', 'Approved.']]);
});
test('an orphan block action reply of [SILENT] posts nothing while an ordinary one still gets the placeholder', async context => {
    const silent = target();
    broadcast('orchestrate_done', { requestId: `silent-click-${++seq}`, origin: 'slack', scope: `silent-click-${seq}`, target: silent,
        replyViaTarget: true, text: '[SILENT]', preSendContext: { requester: 'U_TEST', jobKind: 'slack_block_action' } });
    const ordinary = { ...target(), targetId: `D_ORDINARY_${seq}` };
    broadcast('orchestrate_done', { requestId: `silent-mention-${++seq}`, origin: 'slack', scope: `silent-mention-${seq}`, target: ordinary,
        replyViaTarget: true, text: '[SILENT]', preSendContext: { requester: 'U_TEST', jobKind: 'slack_turn' } });
    await until(context, () => bodyCalls().length === 1);
    await tick(context, 1000);
    assert.deepEqual(writes(silent.targetId), []);
    assert.deepEqual(bodyCalls().map(call => [call.body['channel'], call.body['text']]), [[ordinary.targetId, t('tg.noResponse', {}, 'en')]]);
});

test('a queued request has one stream and its started run survives the original queue deadline', async context => {
    queued = true;
    const admission = await run(context); await until(context, () => progressMessages().length === 1);
    assert.match(JSON.stringify(progressMessages()), /Queued/);
    broadcast('queued_run_started', event(admission)); await tick(context);
    await tick(context, 300001);
    assert.equal(calls.some(call => call.method === 'chat.stopStream'), false);
    assert.equal(bodyCalls().length, 0);
    broadcast('orchestrate_done', event(admission, { text: 'queued answer', fromQueue: true }));
    await until(context, complete);
    assert.equal(calls.filter(call => call.method === 'chat.startStream').length, 1);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 1);
});

for (const outcome of ['cancelled', 'dropped', 'merged']) {
    test(`queued ${outcome} settles the existing stream without another reply`, async context => {
        queued = true; const admission = await run(context); await until(context, () => progressMessages().length === 1);
        broadcast('request_settled', event(admission, { outcome, mergedInto: 'foreign-request' }));
        await until(context, complete);
        assert.equal(bodyCalls().length, 0); assert.equal(reaction('white_check_mark').length, 0);
        assert.equal(reaction('x').length, 1);
        assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
    });
}

test('queued start and terminal arriving during progress POST preserve one message', async context => {
    queued = true; const start = deferred(response({ ok: false, error: 'internal_error' }));
    override = call => call.method === 'chat.startStream' ? start.promise : undefined;
    const admission = await run(context);
    broadcast('queued_run_started', event(admission));
    broadcast('orchestrate_done', event(admission, { text: 'fast answer', fromQueue: true }));
    await until(context, () => bodyCalls().length === 1);
    const destination = (admission['target'] as RemoteTarget).targetId;
    saved.set('300.2', { ts: '300.2', channel: destination, streaming_state: 'streaming' });
    start.resolve(response({ ok: true, ts: '300.2' })); await until(context, complete);
    assert.equal(calls.filter(call => call.method === 'chat.startStream').length, 1);
    assert.equal(calls.filter(call => call.method === 'chat.stopStream').length, 1);
});

test('duplicate queued completion during a held body send cannot reach the orphan forwarder', async context => {
    queued = true; const body = deferred(response({ ok: false, error: 'internal_error' }));
    override = call => call.method === 'chat.postMessage' ? body.promise : undefined;
    const admission = await run(context); await until(context, () => progressMessages().length === 1);
    const done = event(admission, { text: 'one answer', fromQueue: true });
    broadcast('orchestrate_done', done); await until(context, () => bodyCalls().length === 1);
    broadcast('orchestrate_done', done); await tick(context); assert.equal(bodyCalls().length, 1);
    body.resolve(response({ ok: true, ts: '400.1' })); await until(context, complete);
    assert.equal(bodyCalls().length, 1);
});

test('posted table finishes once when rendering readback is unavailable', async context => {
    collect = async () => ({ text: '| A | B |\n| --- | --- |\n| one | two |', data: {} });
    override = call => call.method === 'conversations.replies' ? response({ ok: true, messages: [], has_more: false }) : undefined;
    await run(context); await until(context, complete);
    assert.equal(bodyCalls().length, 1);
    const markdown = (bodyCalls()[0]!.body['blocks'] as Array<Record<string, unknown>>).find(block => block['type'] === 'markdown');
    assert.equal(markdown?.['text'], '| A | B |\n| --- | --- |\n| one | two |');
    assert.equal(calls.filter(call => call.method === 'conversations.replies').length, 1, 'stored table verification is still required');
    // Progress completion acknowledges the posted answer, not verified formatting.
    // Readback evidence remains separate in the sender's delivery receipt.
    assert.equal(reaction('white_check_mark').length, 1); assert.equal(reaction('x').length, 0);
    assert.doesNotMatch(JSON.stringify(progressMessages()), /could not be confirmed/);
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
});

test('failed stream finalization retains a recoverable durable record', async context => {
    override = call => call.method === 'chat.stopStream' ? response({ ok: false, error: 'internal_error' }) : undefined;
    await run(context); await until(context, () => tails.size === 0 && calls.some(call => call.method === 'chat.stopStream'));
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 1);
    assert.equal(bodyCalls().length, 1);
    override = undefined;
    await bot.restoreSlackQueueNotices();
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
    assert.ok(calls.some(call => call.method === 'chat.update'));
});

test('shutdown ignores late queued completion and outbound-only reinit restores ownership', async context => {
    queued = true; const admission = await run(context); await until(context, () => progressMessages().length === 1);
    const closing = bot.shutdownSlack(); await settle(); context.mock.timers.tick(1500); await settle(); await closing;
    const before = bodyCalls().length;
    broadcast('orchestrate_done', event(admission, { text: 'late answer', fromQueue: true })); await tick(context);
    assert.equal(bodyCalls().length, before);
    await bot.initSlack();
    broadcast('orchestrate_done', event(admission, { requestId: 'boot-new-generation', text: 'boot answer', fromQueue: true }));
    await until(context, () => bodyCalls().length === before + 1);
});


test('two live bot requests display only their own tool categories', async context => {
    const first = deferred<Collected>({ text: 'first answer', data: {} });
    const second = deferred<Collected>({ text: 'second answer', data: {} });
    collect = meta => (meta['target'] as RemoteTarget).targetId === 'D_FIRST' ? first.promise : second.promise;
    const a = await run(context, { ...target(), targetId: 'D_FIRST' });
    const b = await run(context, { ...target(), targetId: 'D_SECOND' });
    await until(context, () => progressMessages().length === 2);
    broadcast('agent_tool', event(a, { traceRunId: 'first', stepRef: 'read', toolType: 'tool', label: 'Read', status: 'done' }));
    broadcast('agent_tool', event(b, { traceRunId: 'second', stepRef: 'write', toolType: 'tool', label: 'Write', status: 'done' }));
    await until(context, () => {
        const ready = JSON.stringify(progressMessages().filter(message => message.channel === 'D_FIRST')).includes('Read')
            && JSON.stringify(progressMessages().filter(message => message.channel === 'D_SECOND')).includes('Write');
        if (!ready) context.mock.timers.tick(667); // Shared credential pacing; wait for both actual cards.
        return ready;
    });
    assert.match(JSON.stringify(progressMessages().filter(message => message.channel === 'D_FIRST')), /Read/);
    assert.doesNotMatch(JSON.stringify(progressMessages().filter(message => message.channel === 'D_FIRST')), /Write/);
    assert.match(JSON.stringify(progressMessages().filter(message => message.channel === 'D_SECOND')), /Write/);
    assert.doesNotMatch(JSON.stringify(progressMessages().filter(message => message.channel === 'D_SECOND')), /Read/);
    first.resolve({ text: 'first answer', data: {} }); second.resolve({ text: 'second answer', data: {} });
    await until(context, complete); assert.equal(bodyCalls().length, 2);
});

test('started queue cancellation preserves a later salvaged body without a green ACK', async context => {
    queued = true; const admission = await run(context); await until(context, () => progressMessages().length === 1);
    broadcast('queued_run_started', event(admission));
    broadcast('request_settled', event(admission, { outcome: 'cancelled' })); await tick(context);
    assert.equal(calls.some(call => call.method === 'chat.stopStream'), false, 'cancellation does not discard the final body owner');
    broadcast('orchestrate_done', event(admission, { text: 'saved partial answer', fromQueue: true,
        runtimeFinality: 'present', runtimeStatus: 'stopped' }));
    await until(context, complete);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 0);
    assert.match(JSON.stringify(progressMessages()), /Request cancelled/);
    assert.match(JSON.stringify(progressMessages()), /Answer delivered/);
});

test('foreign activity cannot extend a queued run idle timeout and a later orphan body is not swallowed', async context => {
    queued = true; const admission = await run(context); await until(context, () => progressMessages().length === 1);
    broadcast('queued_run_started', event(admission)); await tick(context, 19 * 60000);
    broadcast('agent_tool', event(admission, { requestId: 'foreign', traceRunId: 'foreign', stepRef: 'x', label: 'Read', status: 'running', toolType: 'tool' }));
    await tick(context, 60001); await until(context, complete);
    assert.match(JSON.stringify(progressMessages()), /Execution may continue/);
    assert.equal(bodyCalls().length, 0);
    broadcast('orchestrate_done', event(admission, { text: 'late but valid answer', fromQueue: true }));
    await until(context, () => bodyCalls().length === 1);
});

test('exact native liveness renews the running queue deadline without fabricating tool activity', async context => {
    queued = true; const admission = await run(context); await until(context, () => progressMessages().length === 1);
    broadcast('queued_run_started', event(admission)); await tick(context, 19 * 60000);
    const ctx = admission['sessionContext'] as { scope: string; chatSessionId: string };
    notifyRuntimeLiveness({ requestId: String(admission['requestId']), origin: 'slack', scope: ctx.scope,
        sessionId: ctx.chatSessionId, runId: 'native-queue-run' });
    await tick(context, 2 * 60000);
    assert.equal(calls.some(call => call.method === 'chat.stopStream'), false);
    assert.doesNotMatch(JSON.stringify(progressMessages()), /Read/);
    broadcast('orchestrate_done', event(admission, { text: 'native answer', fromQueue: true })); await until(context, complete);
});

test('explicit unsupported stream yields one fallback status plus the final body', async context => {
    override = call => call.method === 'chat.startStream' ? response({ ok: false, error: 'unknown_method' }) : undefined;
    await run(context); await until(context, () => tails.size === 0 && calls.some(call => call.method === 'chat.update'));
    assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 2);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 1);
    assert.equal(getQueueNoticeStore()!.listRestorable('slack').length, 0);
});

test('malformed successful stream response never causes a fallback status repost', async context => {
    override = call => call.method === 'chat.startStream' ? response({ ok: true }) : undefined;
    const admission = await run(context); await until(context, () => tails.size === 0 && bodyCalls().length === 1);
    assert.equal(calls.filter(call => call.method === 'chat.startStream').length, 1);
    assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 1);
    assert.equal(getQueueNoticeStore()!.findByRequestId(String(admission['requestId']))?.messageId, null);
});

test('a saved native table shape confirms delivery through the unchanged sender', async context => {
    collect = async () => ({ text: '| A | B |\n| --- | --- |\n| one | two |', data: {} });
    override = call => call.method === 'conversations.replies' ? response({ ok: true, messages: [{
        ts: call.body['oldest'], blocks: [{ type: 'table', rows: [
            [{ type: 'raw_text', text: 'A' }, { type: 'raw_text', text: 'B' }],
            [{ type: 'raw_text', text: 'one' }, { type: 'raw_text', text: 'two' }],
        ] }],
    }], has_more: false }) : undefined;
    await run(context); await until(context, complete);
    assert.equal(bodyCalls().length, 1); assert.equal(reaction('white_check_mark').length, 1);
    assert.match(JSON.stringify(progressMessages()), /Answer delivered/);
});

test('shutdown during a held body request aborts IO and cannot later produce success ACK', async context => {
    const body = deferred(response({ ok: false, error: 'internal_error' }));
    override = call => call.method === 'chat.postMessage' ? body.promise : undefined;
    await run(context); await until(context, () => bodyCalls().length === 1);
    const closing = bot.shutdownSlack(); await settle(); context.mock.timers.tick(1500); await settle(); await closing;
    assert.equal(bodyCalls()[0]?.signal?.aborted, true);
    body.resolve(response({ ok: true, ts: 'late.1' }));
    await until(context, () => tails.size === 0);
    assert.equal(reaction('white_check_mark').length, 0);
    assert.equal(calls.filter(call => call.method === 'chat.startStream').length, 1);
});

test('superseded auth initialization cannot rearm orphan delivery after shutdown', async context => {
    const auth = deferred(response({ ok: false, error: 'invalid_auth' }));
    Object.assign(settings['slack'], { appToken: 'fake-app', attachPort: '3457' });
    override = call => call.method === 'auth.test' ? auth.promise : undefined;
    const starting = bot.initSlack(); await until(context, () => calls.some(call => call.method === 'auth.test'));
    const closing = bot.shutdownSlack(); await settle(); context.mock.timers.tick(1500); await settle(); await closing;
    auth.resolve(response({ ok: true, user_id: 'U_BOT', team_id: 'T_TEST' })); await starting;
    broadcast('orchestrate_done', { requestId: 'stale-init', origin: 'slack', fromQueue: true, target: target(), text: 'must not send' });
    await tick(context); assert.equal(bodyCalls().length, 0);
});

for (const control of ['restart', 'queue_update', 'queued_run_started']) {
    test(`inline steered admission activates exactly one tracker: ${control}`, async context => {
        steered = true;
        inlineControl = admission => broadcast(control === 'restart' ? 'steer_started' : control,
            event(admission, control === 'restart' ? { mode: 'restart' } : {}));
        const admission = await run(context);
        await until(context, () => progressMessages().length === 1);
        if (control === 'queue_update') broadcast('queued_run_started', event(admission));
        broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'steered answer' }));
        await until(context, complete);
        broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'steered answer' }));
        await tick(context);
        assert.equal(bodyCalls().length, 1);
        assert.equal(reaction('white_check_mark').length, 1);
    });
}

for (const mode of ['native-input', 'cancel-reprompt', 'unknown']) {
    test(`logical or unknown steer does not create another stream: ${mode}`, async context => {
        steered = true;
        inlineControl = admission => broadcast('steer_started', event(admission, { mode }));
        const admission = await run(context);
        broadcast('orchestrate_done', event(admission, { text: 'original owner answer' }));
        await tick(context);
        assert.equal(progressMessages().length, 0);
        assert.equal(bodyCalls().length, 0);
        assert.equal(reaction('white_check_mark').length, 0);
    });
}

for (const mismatch of ['requestId', 'scope', 'sessionId', 'origin', 'target', 'mode']) {
    test(`pending restart rejects contradictory ${mismatch}`, async context => {
        steered = true;
        const admission = await run(context);
        broadcast('steer_started', event(admission, { mode: 'restart',
            [mismatch]: mismatch === 'target' ? { ...(admission['target'] as RemoteTarget), targetId: 'FOREIGN' } : 'wrong' }));
        await tick(context);
        assert.equal(progressMessages().length, 0);
        broadcast('steer_started', event(admission, { mode: 'restart' }));
        await until(context, () => progressMessages().length === 1);
        broadcast('orchestrate_done', event(admission, { text: 'right owner' }));
        await until(context, complete);
        assert.equal(bodyCalls().length, 1);
    });
}

for (const cleanup of ['expiry', 'abort', 'shutdown', 'native-settled', 'failed', 'cancelled', 'dropped']) {
    test(`pending steer cleans up on ${cleanup}`, async context => {
        steered = true;
        const controller = new AbortController();
        const admission = await run(context, target(), controller.signal);
        if (cleanup === 'expiry') await tick(context, 300_001);
        else if (cleanup === 'abort') controller.abort();
        else if (cleanup === 'shutdown') { await bot.shutdownSlack(); await bot.initSlack(); }
        else broadcast('request_settled', event(admission, { outcome: cleanup === 'native-settled' ? 'steered' : cleanup }));
        await tick(context);
        broadcast('steer_started', event(admission, { mode: 'restart' }));
        await tick(context);
        assert.equal(progressMessages().length, 0);
        assert.equal(bodyCalls().length, 0);
        assert.equal(reaction('white_check_mark').length, 0);
    });
}

test('expired restart tracking retains start proof for a fresh self-delivery receipt', async context => {
    steered = true;
    inlineControl = admission => broadcast('steer_started', event(admission, { mode: 'restart' }));
    const admission = await run(context);
    await until(context, () => progressMessages().length === 1);
    await tick(context, 1_200_001);
    await until(context, complete);
    recordSelfDelivery({ target: admission['target'] as RemoteTarget, text: 'already sent' });
    broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'already sent' }));
    await tick(context);
    assert.equal(bodyCalls().length, 0);
});

test('orphan body claim reserves the scope lane synchronously and deduplicates after completion', async context => {
    const destination = target();
    const scope = 'held-orphan-scope';
    const hold = deferred<void>(undefined);
    const blocker = sessionLanes.runDetachedTurn(scope, () => hold.promise);
    const data = { requestId: `orphan-${++seq}`, origin: 'slack', scope, target: destination, replyViaTarget: true, text: 'orphan answer' };
    broadcast('orchestrate_done', data);
    let nextRan = false;
    const next = sessionLanes.runDetachedTurn(scope, async () => { nextRan = true; assert.equal(bodyCalls().length, 1); });
    broadcast('orchestrate_done', data);
    await tick(context);
    assert.equal(bodyCalls().length, 0); assert.equal(nextRan, false);
    hold.resolve(); await blocker;
    await until(context, () => nextRan);
    await next;
    broadcast('orchestrate_done', data);
    await tick(context);
    assert.equal(bodyCalls().length, 1);
});

test('actual start rejects old self receipt while missing start never invents suppression proof', async context => {
    for (const started of [true, false]) {
        const destination = { ...target(), targetId: `D_ANCHOR_${++seq}` };
        const data = { requestId: `anchor-${seq}`, origin: 'slack', scope: `anchor-scope-${seq}`, target: destination,
            fromQueue: true, text: 'same words' };
        recordSelfDelivery({ target: destination, text: 'same words' });
        if (started) { broadcast('queued_run_started', data); await tick(context); }
        broadcast('orchestrate_done', data);
        await until(context, () => bodyCalls().some(call => call.body['channel'] === destination.targetId));
    }
    assert.equal(bodyCalls().length, 2);
});

test('legacy executionInterrupted preserves salvage with a failure ACK', async context => {
    steered = true;
    inlineControl = admission => broadcast('steer_started', event(admission, { mode: 'restart' }));
    const admission = await run(context);
    broadcast('orchestrate_done', event(admission, { text: 'salvage', executionInterrupted: true, executionFailed: true }));
    await until(context, complete);
    assert.equal(bodyCalls().length, 1);
    assert.equal(reaction('white_check_mark').length, 0);
});

test('pending steer capacity evicts oldest tracking without claiming input failure', async context => {
    steered = true;
    let oldest: Record<string, unknown> | undefined;
    let newest: Record<string, unknown> | undefined;
    for (let i = 0; i < 257; i++) {
        newest = await run(context);
        oldest ??= newest;
    }
    broadcast('steer_started', event(oldest!, { mode: 'restart' }));
    await tick(context);
    assert.equal(progressMessages().length, 0);
    assert.equal(reaction('x').length, 0);
    broadcast('steer_started', event(newest!, { mode: 'restart' }));
    await until(context, () => progressMessages().length === 1);
    broadcast('orchestrate_done', event(newest!, { text: 'newest answer' }));
    await until(context, complete);
});

test('inline restart captures sequence before selfsend and copies control identity', async context => {
    steered = true;
    inlineControl = admission => {
        const control = event(admission, { mode: 'restart', target: { ...(admission['target'] as RemoteTarget) } });
        broadcast('steer_started', control);
        (control['target'] as RemoteTarget).targetId = 'MUTATED';
        control['scope'] = 'MUTATED';
        recordSelfDelivery({ target: admission['target'] as RemoteTarget, text: 'inline self answer' });
    };
    const admission = await run(context);
    await until(context, () => progressMessages().length === 1);
    broadcast('orchestrate_done', event(admission, { text: 'inline self answer', replyViaTarget: true }));
    await until(context, complete);
    assert.equal(bodyCalls().length, 0);
    assert.equal(reaction('white_check_mark').length, 1);
});

test('synchronous orphan queued start retains anchor through immediate terminal', async context => {
    const destination = target();
    const data = { requestId: `sync-orphan-${++seq}`, origin: 'slack', scope: 'sync-orphan', target: destination, fromQueue: true, text: 'self answer' };
    broadcast('queued_run_started', data);
    recordSelfDelivery({ target: destination, text: 'self answer' });
    broadcast('orchestrate_done', data);
    await tick(context);
    assert.equal(bodyCalls().length, 0);
});

test('duplicate orphan while its POST is held has one atomic body attempt', async context => {
    const hold = deferred<Response | undefined>(undefined);
    override = call => call.method === 'chat.postMessage' && !fallbackProgress(call.body) ? hold.promise : undefined;
    const data = { requestId: `held-post-${++seq}`, origin: 'slack', target: target(), replyViaTarget: true, text: 'held orphan' };
    broadcast('orchestrate_done', data);
    await until(context, () => bodyCalls().length === 1);
    broadcast('orchestrate_done', data);
    await tick(context);
    assert.equal(bodyCalls().length, 1);
    hold.resolve(undefined);
    await tick(context);
    broadcast('orchestrate_done', data);
    await tick(context);
    assert.equal(bodyCalls().length, 1);
});

for (const outcome of [
    { runtimeFinality: 'absent', runtimeStatus: 'done', text: '' },
    { runtimeFinality: 'present', runtimeStatus: 'stopped', text: 'native salvage' },
    { runtimeFinality: 'present', runtimeStatus: 'error', text: 'native failure' },
]) {
    test(`restart native terminal cannot claim success: ${outcome.runtimeStatus}`, async context => {
        steered = true;
        inlineControl = admission => broadcast('steer_started', event(admission, { mode: 'restart' }));
        const admission = await run(context);
        broadcast('orchestrate_done', event(admission, { ...outcome, replyViaTarget: true }));
        await until(context, complete);
        assert.equal(bodyCalls().length, outcome.text ? 1 : 0);
        assert.equal(reaction('white_check_mark').length, 0);
    });
}

test('orphan native no-final terminal is a claimed attempt, not an implicit retry', async context => {
    const data = { requestId: `empty-orphan-${++seq}`, origin: 'slack', target: target(), replyViaTarget: true,
        runtimeFinality: 'absent', runtimeStatus: 'done', text: '' };
    broadcast('orchestrate_done', data);
    broadcast('orchestrate_done', { ...data, runtimeFinality: 'present', text: 'duplicate changed body' });
    await tick(context);
    assert.equal(bodyCalls().length, 0);
});

test('expired tracker keeps target ownership against a contradictory orphan completion', async context => {
    steered = true;
    inlineControl = admission => broadcast('steer_started', event(admission, { mode: 'restart' }));
    const admission = await run(context);
    await until(context, () => progressMessages().length === 1);
    await tick(context, 1_200_001);
    await until(context, complete);
    broadcast('orchestrate_done', event(admission, { target: { ...(admission['target'] as RemoteTarget), targetId: 'WRONG' }, replyViaTarget: true, text: 'wrong destination' }));
    await tick(context);
    assert.equal(bodyCalls().length, 0);
    broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'captured destination' }));
    await until(context, () => bodyCalls().length === 1);
    assert.equal(bodyCalls()[0]?.body['channel'], (admission['target'] as RemoteTarget).targetId);
});

test('start and completion emitted synchronously inside admission do not create a dangling tracker', async context => {
    steered = true;
    inlineControl = admission => {
        broadcast('steer_started', event(admission, { mode: 'restart' }));
        broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'inline terminal' }));
    };
    const admission = await run(context);
    await until(context, () => bodyCalls().length === 1);
    await tick(context);
    assert.equal(progressMessages().length, 0);
    assert.equal(reaction('white_check_mark').length, 0);
    broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'inline terminal' }));
    await tick(context, 1_200_001);
    assert.equal(progressMessages().length, 0);
    assert.equal(bodyCalls().length, 1);
});

test('a tracker whose ledger action is skipped closes without fabricated delivery success', async context => {
    steered = true;
    inlineControl = admission => {
        // Exercise the real ledger's conflicting-target skip, rather than mocking
        // deliver itself or assuming a duplicate invokes its action.
        deliveryLedger.remember(String(admission['requestId']),
            { ...(admission['target'] as RemoteTarget), targetId: 'OTHER_OWNED_TARGET' },
            String((admission['sessionContext'] as Record<string, unknown>)['scope']));
        broadcast('steer_started', event(admission, { mode: 'restart' }));
    };
    const admission = await run(context);
    await until(context, () => progressMessages().length === 1);
    broadcast('orchestrate_done', event(admission, { replyViaTarget: true, text: 'must not send' }));
    await until(context, complete);
    assert.equal(bodyCalls().length, 0);
    assert.equal(reaction('white_check_mark').length, 0);
    assert.equal(progressMessages().length, 1);
});

for (const restored of [false, true]) for (const selfDelivered of [false, true]) {
    test(`single-session queued native reply keeps admitted session after chat switch, restored=${restored}, self=${selfDelivered}`, async context => {
        queued = true;
        settings.multiSession.enabled = false;
        const chats = await import('../../src/core/chat-sessions.ts');
        const { createQueueController } = await import('../../src/agent/spawn/queue.ts');
        const { SessionLanes } = await import('../../src/orchestrator/session-lanes.ts');
        chats.setActiveChatSession('default');
        try {
            const admission = await run(context);
            await until(context, () => progressMessages().length === 1);
            const captured = (admission.sessionContext as { chatSessionId: string }).chatSessionId;
            let busy = true;
            const persisted = new Map<string, string>();
            const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
            const producer = (type: string, data: Record<string, unknown>) => { emitted.push({ type, data }); broadcast(type, data); };
            const text = 'native answer after active chat changed';
            const pipeline = {
                isResetIntent: () => false, isContinueIntent: () => false,
                orchestrateContinue: async () => {}, orchestrateReset: async () => {}, drainPendingReplays: async () => {},
                orchestrate: async (_prompt: string, meta: Record<string, unknown>) => {
                    assert.equal(meta.chatSessionId, captured);
                    if (selfDelivered) recordSelfDelivery({ target: admission.target as RemoteTarget, text });
                    producer('orchestrate_done', { origin: meta.origin, target: meta.target, requestId: meta.requestId,
                        scope: meta.scope, sessionId: meta.chatSessionId, fromQueue: true, text,
                        runtimeFinality: 'present', runtimeStatus: 'done' });
                },
            };
            const create = () => createQueueController({
                migrateQueuedMessagesV1ToV2() {}, isSpawnBusy: () => busy,
                hasBlockingWorkers: () => false, hasPendingWorkerReplays: () => false,
                insertMessage: { run() {} }, getActiveChatSession: chats.getActiveChatSession,
                insertQueuedMessage: { run(id: string, payload: string) { persisted.set(id, payload); } },
                deleteQueuedMessage: { run(id: string) { persisted.delete(id); } },
                listQueuedMessages: { all: () => [...persisted].map(([id, payload]) => ({ id, payload })) },
                broadcast: producer, importPipeline: async () => pipeline,
                getWorkingDir: () => null, isMultiSessionEnabled: () => false,
            }, new SessionLanes(() => 1));
            let controller = create();
            controller.enqueueMessage('fixture', 'slack', { scope: 'default', chatSessionId: captured,
                target: admission.target as RemoteTarget, requestId: String(admission.requestId) });
            chats.createChatSession('unrelated active chat');
            assert.notEqual(chats.getActiveChatSession(), captured);
            if (restored) controller = create();
            busy = false;
            await controller.processQueue('default');
            await until(context, complete);
            assert.equal(emitted.find(item => item.type === 'queued_run_started')?.data.sessionId, captured);
            assert.equal(bodyCalls().length, selfDelivered ? 0 : 1);
            const terminal = emitted.find(item => item.type === 'orchestrate_done')!;
            broadcast(terminal.type, terminal.data);
            await tick(context);
            assert.equal(bodyCalls().length, selfDelivered ? 0 : 1, 'duplicate terminal must not resend');
        } finally { chats.setActiveChatSession('default'); }
    });
}

for (const admissionMode of ['direct', 'queued', 'restart']) {
    test(`bot captures filename root before admission for ${admissionMode}`, async context => {
        settings.workingDir = '/captured/project';
        queued = admissionMode === 'queued';
        steered = admissionMode === 'restart';
        inlineControl = admission => {
            settings.workingDir = '/captured/project/src';
            if (steered) broadcast('steer_started', event(admission, { mode: 'restart' }));
        };
        const held = deferred<Collected>({ text: 'answer', data: {} });
        collect = async meta => {
            broadcast('agent_tool', { ...meta, sessionId: meta['chatSessionId'], traceRunId: 'file-root', stepRef: 'read',
                toolType: 'tool', label: 'Read', status: 'done', detail: '/captured/project/src/bot.ts' });
            return held.promise;
        };
        const admission = await run(context);
        if (admissionMode !== 'direct') {
            if (queued) broadcast('queued_run_started', event(admission));
            broadcast('agent_tool', event(admission, { traceRunId: 'file-root', stepRef: 'read', toolType: 'tool',
                label: 'Read', status: 'done', detail: '/captured/project/src/bot.ts' }));
        }
        if (admissionMode === 'direct') held.resolve({ text: 'answer', data: {} });
        else broadcast('orchestrate_done', event(admission, { text: 'answer' }));
        await until(context, complete);
        const encoded = JSON.stringify(calls.filter(call => ['chat.startStream', 'chat.appendStream', 'chat.stopStream'].includes(call.method)));
        assert.match(encoded, /src\/bot\.ts/);
        assert.doesNotMatch(encoded, /captured\/project/);
    });
}

for (const isQueued of [false, true]) test(`operator routing suppresses ${isQueued ? 'queued' : 'direct'} failure bodies and clears failure cards`, async context => {
    const previous = process.env['JAW_SLACK_FAILURE_DM'];
    process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    try {
        queued = isQueued;
        collect = async () => ({ text: 'PRIVATE_STACK', data: { collectionFailure: 'error' } });
        const admission = await run(context);
        if (isQueued) {
            broadcast('queued_run_started', event(admission));
            await tick(context);
            broadcast('orchestrate_done', event(admission, { text: 'PRIVATE_STACK', error: true, fromQueue: true }));
        }
        await until(context, () => calls.some(call => call.method === 'chat.update' && call.body['text'] === 'Jaw · Finished'));
        const posts = calls.filter(call => call.method === 'chat.postMessage');
        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.body['channel'], 'DOPERATORTEST');
        assert.doesNotMatch(JSON.stringify(calls.map(call => call.body)), /PRIVATE_STACK/);
        assert.equal(reaction('white_check_mark').length, 0);
    } finally {
        if (previous === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = previous;
    }
});

for (const ambiguous of [false, true]) test(`next fresh turn uses the original parent after ${ambiguous ? 'unknown' : 'blocked'} delivery without replaying the old body`, async context => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    const destination: RemoteTarget = { ...target(), targetId: `C_RETRY_${seq + 1}`, peerKind: 'channel' };
    let blocked = false;
    collect = async () => ({ text: 'first answer', data: {} });
    override = call => {
        if (!blocked && call.method === 'chat.postMessage' && call.body['channel'] === destination.targetId) {
            blocked = true;
            if (ambiguous) throw new Error('response lost after dispatch');
            return response({ ok: false, error: 'thread_not_found' });
        }
        return undefined;
    };
    try {
        await run(context, destination);
        await until(context, () => calls.some(call => call.method === 'chat.update' && call.body['text'] === 'Jaw · Finished'));
        collect = async () => ({ text: 'fresh second answer', data: {} });
        await run(context, destination);
        await until(context, () => calls.some(call => call.method === 'chat.postMessage' && call.body['text'] === 'fresh second answer'));
        const humanPosts = calls.filter(call => call.method === 'chat.postMessage' && call.body['channel'] === destination.targetId);
        assert.deepEqual(humanPosts.map(call => call.body['thread_ts']), [destination.threadId, destination.threadId]);
        assert.deepEqual(humanPosts.map(call => call.body['text']), ['first answer', 'fresh second answer']);
        assert.equal(calls.filter(call => call.method === 'chat.postMessage' && call.body['channel'] === 'DOPERATORTEST').length, 1);
    } finally {
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});

test('workflow-unconfirmed alone preserves its diagnostic body and progress instead of routing a failed turn', async context => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    collect = async () => ({ text: 'workflow diagnostic', data: { workflowUnconfirmed: true } });
    try {
        await run(context); await until(context, complete);
        assert.equal(calls.filter(call => call.method === 'chat.postMessage' && call.body['channel'] === 'DOPERATORTEST').length, 0);
        assert.equal(bodyCalls().length, 1);
        assert.ok(!calls.some(call => call.method === 'chat.update' && call.body['text'] === 'Jaw · Finished'));
    } finally {
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});

test('file input validation remains visible with operator turn-failure routing enabled', async context => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    const destination = target();
    try {
        await bot.processSlackMessageEvent({ user: 'U_TEST', channel: destination.targetId, channel_type: 'im', ts: '100.2',
            files: [{ id: 'FOVERSIZE', name: 'oversize.txt', size: 51 * 1024 * 1024 }] }, destination, 'read attachment', new AbortController().signal);
        await tick(context);
        assert.equal(admissions.length, 0, 'validation did not admit a model turn');
        const posts = calls.filter(call => call.method === 'chat.postMessage');
        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.body['channel'], destination.targetId);
        assert.equal(posts[0]?.body['thread_ts'], destination.threadId);
        assert.match(String(posts[0]?.body['text']), /oversize.txt/);
    } finally {
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});

test('an individual failed tool remains visible when the turn succeeds', async context => {
    const prior = process.env['JAW_SLACK_FAILURE_DM']; process.env['JAW_SLACK_FAILURE_DM'] = 'DOPERATORTEST';
    collect = async meta => {
        broadcast('agent_tool', { ...meta, sessionId: meta['chatSessionId'], traceRunId: 'tool-failure-test',
            stepRef: 'read-failed', label: 'Read', status: 'error', toolType: 'tool' });
        return { text: 'Recovered and completed', data: {} };
    };
    try {
        await run(context); await until(context, complete);
        assert.equal(calls.filter(call => call.method === 'chat.postMessage' && call.body['channel'] === 'DOPERATORTEST').length, 0);
        assert.equal(bodyCalls().length, 1);
        assert.match(JSON.stringify(progressMessages()), /Read/);
        assert.ok(!calls.some(call => call.method === 'chat.update' && call.body['text'] === 'Jaw · Finished'));
    } finally {
        if (prior === undefined) delete process.env['JAW_SLACK_FAILURE_DM']; else process.env['JAW_SLACK_FAILURE_DM'] = prior;
    }
});
