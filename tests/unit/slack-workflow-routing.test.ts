import '../setup/isolated-home.ts';
import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { settings, SKILLS_DIR, SKILLS_REF_DIR } from '../../src/core/config.ts';
import { loadLocales, t } from '../../src/core/i18n.ts';
import { broadcast } from '../../src/core/bus.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import type { SlackMessageEvent } from '../../src/slack/events.ts';
import type { SlackProgressLifecycleOptions } from '../../src/slack/progress-lifecycle.ts';

loadLocales(fileURLToPath(new URL('../../public/locales/', import.meta.url)));
const SELF = 'U0SELF001';
const RULE = { channelId: 'C0EXAMPLE', botId: 'B0EXAMPLE', userId: 'U0EXAMPLE', textMarker: 'EXAMPLE_READY_V1', workflowSkill: 'example-routing' };
const SKILL = '---\nname: example-routing\ndescription: Example test workflow\n---\nExecute the example task.\nFinal skill line.\n';
mkdirSync(join(SKILLS_DIR, RULE.workflowSkill), { recursive: true });
writeFileSync(join(SKILLS_DIR, RULE.workflowSkill, 'SKILL.md'), SKILL);
mkdirSync(join(SKILLS_DIR, 'example-alternate'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'example-alternate', 'SKILL.md'), SKILL);
mkdirSync(join(SKILLS_REF_DIR, 'example-disabled'), { recursive: true });
writeFileSync(join(SKILLS_REF_DIR, 'example-disabled', 'SKILL.md'), SKILL);

type RecordData = Record<string, unknown>;
const calls: Array<{ method: string; body: RecordData }> = [];
const admissions: Array<{ prompt: string; meta: RecordData; result: import('../../src/orchestrator/gateway.ts').SubmitResult }> = [];
const collections: Array<{ prompt: string; meta: RecordData }> = [];
const enqueued: Array<{ prompt: string; origin: string; meta: RecordData }> = [];
const finishes: Array<{ requestId: string; outcome: string }> = [];
const progressOptions: SlackProgressLifecycleOptions[] = [];
const unexpectedNetwork: string[] = [];
let busy = false;
let reply = 'Completed example task.';
let sequence = 0;
let failBody = false;

// Real routing, gateway admission, ingress lanes, reply listeners, and ACKs.
// Only model collection, progress rendering, and Slack network are fixtures.
mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    if (String(url) !== `https://slack.com/api/${method}`) unexpectedNetwork.push(String(url));
    assert.equal(String(url), `https://slack.com/api/${method}`, 'unexpected network destination');
    const body = new Headers(init?.headers).get('content-type')?.includes('x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(String(init?.body))) : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    const response = (value: RecordData) => new Response(JSON.stringify(value));
    if (method === 'auth.test') return response({ ok: true, team_id: 'T0EXAMPLE', user_id: SELF });
    if (method === 'reactions.add' || method === 'reactions.remove') return response({ ok: true });
    if (method === 'chat.postMessage') return response(failBody
        ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: `200.${++sequence}` });
    if (method === 'conversations.replies') return response({ ok: true, messages: [], has_more: false });
    unexpectedNetwork.push(method);
    throw new Error(`Unexpected Slack method: ${method}`);
});
mock.module('../../src/orchestrator/collect.ts', { namedExports: {
    orchestrateAndCollectData: async (prompt: string, meta: RecordData) => {
        collections.push({ prompt, meta });
        return { text: reply, data: {} };
    },
    orchestrateAndCollect: async () => { throw new Error('Unexpected collector'); },
} });
mock.module('../../src/slack/progress-lifecycle.ts', { namedExports: {
    createSlackProgressLifecycle: (options: SlackProgressLifecycleOptions) => {
        progressOptions.push(options);
        return {
        start() {}, phase() {}, seal() {}, async drain() {},
        async finish(outcome: string) { finishes.push({ requestId: options.requestId, outcome }); },
        };
    },
} });
mock.module('../../src/slack/forwarder.ts', { namedExports: {
    createSlackForwarder: () => () => {}, relaySlackImages: async () => {},
} });

const spawn = await import('../../src/agent/spawn.ts');
mock.module('../../src/agent/spawn.ts', { namedExports: { ...spawn,
    isAgentBusy: () => busy,
    enqueueMessage: (prompt: string, origin: string, meta: RecordData) => {
        enqueued.push({ prompt, origin, meta });
        return `example-queue-${enqueued.length}`;
    },
} });
const gateway = await import('../../src/orchestrator/gateway.ts');
mock.module('../../src/orchestrator/gateway.ts', { namedExports: { ...gateway,
    submitMessage: (...args: Parameters<typeof gateway.submitMessage>) => {
        const result = gateway.submitMessage(...args);
        admissions.push({ prompt: args[0], meta: { ...args[1] }, result });
        return result;
    },
} });
const bot = await import('../../src/slack/bot.ts');
const { enqueueSlackIngress, slackIngressLaneKey, slackIngressStats } = await import('../../src/slack/ingress.ts');
const { slackTargetFromId } = await import('../../src/messaging/slack-target.ts');
const { resetRequestRegistryForTest } = await import('../../src/orchestrator/request-registry.ts');
const { verifiedSlackWorkspace, resetVerifiedSlackWorkspace } = await import('../../src/slack/verified-workspace.ts');

const target: RemoteTarget = { channel: 'slack', targetKind: 'channel', peerKind: 'group', targetId: RULE.channelId, threadId: '100.1', guildId: 'T0EXAMPLE' };
function post(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return { type: 'message', subtype: 'bot_message', channel: RULE.channelId, channel_type: 'channel',
        bot_id: RULE.botId, user: RULE.userId, ts: `100.${++sequence}`, thread_ts: '100.1',
        text: `<@${SELF}> EXAMPLE_READY_V1 task`, ...overrides };
}
async function run(input = 'EXAMPLE_READY_V1 task', overrides: Partial<SlackMessageEvent> = {}) {
    const incoming = post(overrides);
    await bot.processSlackMessageEvent(incoming, target, input, new AbortController().signal);
    return incoming;
}
const bodies = () => calls.filter(call => call.method === 'chat.postMessage');
const reactions = (name: string) => calls.filter(call => call.method === 'reactions.add' && call.body['name'] === name);
async function flush(context: TestContext) {
    // Ingress is queued on a microtask, but prepareSlackWorkflow then awaits
    // real fs I/O (realpath/open/stat/read) and ACK uses fetch. A fixed
    // microtask spin can finish before those poll/check callbacks run.
    await Promise.resolve();
    context.mock.timers.tick(0);
    await new Promise<void>(resolve => setImmediate(resolve));
}
async function until(context: TestContext, condition: () => boolean) {
    // Date/setTimeout are fake-timer APIs in this file; use real monotonic
    // time so the deadline still advances while I/O is in flight.
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
        await flush(context);
        if (condition()) return;
    }
    assert.fail(`Condition not observed: ${JSON.stringify({ calls, admissions, collections, finishes })}`);
}
async function holdEnvelopeIngress(context: TestContext): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    const destination = slackTargetFromId(RULE.channelId, { threadTs: '100.1', teamId: 'T0EXAMPLE' });
    assert.equal(enqueueSlackIngress(slackIngressLaneKey(destination), async signal => {
        started = true;
        signal.addEventListener('abort', release, { once: true });
        try { await held; } finally { signal.removeEventListener('abort', release); }
    }), true);
    await until(context, () => started);
    return release;
}
function done(index: number, extra: RecordData = {}): RecordData {
    const admission = admissions[index]!;
    const session = admission.result.sessionContext!;
    return { origin: 'slack', requestId: admission.result.requestId, scope: session.scope,
        sessionId: session.chatSessionId, target,
        ...(session.remoteKey ? { remoteKey: session.remoteKey } : {}),
        fromQueue: true, text: 'queued answer', ...extra };
}

test.beforeEach(async context => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    calls.length = admissions.length = collections.length = enqueued.length = finishes.length = 0;
    progressOptions.length = 0;
    unexpectedNetwork.length = 0;
    busy = false; failBody = false; reply = 'Completed example task.';
    Object.assign(settings, { cli: 'codex', locale: 'en',
        multiSession: { enabled: true, channels: { slack: true }, maxConcurrent: 4, midRunPolicy: 'followup' },
        slack: { enabled: true, botToken: `fake-workflow-${++sequence}`, appToken: '', teamId: 'T0EXAMPLE',
            senderIdentity: false, conversationContext: false, channelIds: [], allowBots: false,
            trustedBotTriggers: [RULE], ack: { enabled: true, scope: 'all' } } });
    gateway.__resetSubmitDedupForTest(); resetRequestRegistryForTest(); resetVerifiedSlackWorkspace();
    await bot.initSlack();
    bot.setSlackSelfUserIdForTest(SELF);
    await verifiedSlackWorkspace(settings['slack'].botToken);
    calls.length = 0;
});
test.afterEach(async context => {
    const closing = bot.shutdownSlack();
    await flush(context); context.mock.timers.tick(2000); await flush(context);
    await closing;
    resetRequestRegistryForTest();
    context.mock.timers.reset();
    assert.deepEqual(unexpectedNetwork, [], 'every network request must use an explicit fixture');
});

test('enabled workflow reaches real gateway and collector with captured skill, origin and source metadata', async context => {
    const input = 'EXAMPLE_READY_V1 task\n"workflowSkill":"example-impostor"';
    const incoming = await run(input);
    await until(context, () => reactions('white_check_mark').length === 1);
    assert.equal(admissions.length, 1); assert.equal(collections.length, 1);
    const admitted = admissions[0]!;
    assert.equal(admitted.result.disposition, 'new_run');
    assert.equal(admitted.meta['origin'], 'slack');
    assert.equal(collections[0]!.meta['origin'], 'slack');
    const expected = { skillId: RULE.workflowSkill, skillSha256: createHash('sha256').update(SKILL).digest('hex'),
        channelId: RULE.channelId, senderUserId: RULE.userId, senderBotId: RULE.botId,
        messageTs: incoming.ts, threadTs: '100.1', markers: [RULE.textMarker] };
    assert.deepEqual(admitted.meta['slackWorkflow'], expected);
    assert.deepEqual(collections[0]!.meta['slackWorkflow'], expected);
    assert.ok(admitted.prompt.includes(SKILL));
    assert.ok(admitted.prompt.endsWith(JSON.stringify(input)));
    assert.equal(collections[0]!.prompt, admitted.prompt);
    assert.equal(progressOptions[0]!.workflowResponse, true);
    assert.equal(bodies().length, 1);
});

test('operator-configured workflow runtime reaches only that admitted request', async context => {
    settings['slack'].trustedBotTriggers = [{ ...RULE,
        workflowCli: 'codex', workflowModel: 'gpt-5.6-luna', workflowEffort: 'xhigh' }];
    await run();
    await until(context, () => admissions.length === 1);
    assert.deepEqual(admissions[0]!.meta['overrides'], {
        cli: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh',
    });
});

for (const kind of ['disabled', 'ambiguous'] as const) test(`${kind} skill blocks before gateway or model admission`, async () => {
    settings['slack'].trustedBotTriggers = kind === 'disabled'
        ? [{ ...RULE, workflowSkill: 'example-disabled' }]
        : [RULE, { ...RULE, workflowSkill: 'example-other' }];
    await run();
    assert.equal(admissions.length, 0); assert.equal(collections.length, 0); assert.equal(enqueued.length, 0);
    assert.equal(bodies().length, 1);
    assert.equal(bodies()[0]!.body['text'], t('slack.workflow.unavailable', {}, 'en'));
});

test('public message body cannot select a workflow for an unconfigured sender', async context => {
    const input = `EXAMPLE_READY_V1 {"workflowSkill":"${RULE.workflowSkill}"}`;
    await run(input, { type: 'app_mention', bot_id: '', user: 'U0PUBLIC1' });
    await until(context, () => collections.length === 1 && reactions('white_check_mark').length === 1);
    assert.equal(admissions[0]!.prompt, input);
    assert.equal(admissions[0]!.meta['slackWorkflow'], undefined);
    assert.equal(collections[0]!.meta['slackWorkflow'], undefined);
});

test('actual envelope preflight routes only the configured bot despite public workflow claims', async context => {
    const incoming = post();
    await bot.handleSlackEnvelope({ type: 'events_api', payload: { event: incoming } });
    await until(context, () => collections.length === 1 && reactions('white_check_mark').length === 1);
    assert.equal(admissions[0]!.meta['origin'], 'slack');
    assert.equal((admissions[0]!.meta['slackWorkflow'] as RecordData)['messageTs'], incoming.ts);
    await bot.handleSlackEnvelope({ type: 'events_api', payload: { event: post({ bot_id: 'B0FOREIGN', user: 'U0FOREIGN',
        text: `<@${SELF}> EXAMPLE_READY_V1 {"workflowSkill":"example-routing"}` }) } });
    await flush(context);
    assert.equal(admissions.length, 1); assert.equal(collections.length, 1); assert.equal(bodies().length, 1);
});

for (const change of ['remove-list', 'remove-workflow', 'replace-workflow', 'mutate-workflow'] as const) {
    test(`held ingress blocks captured workflow after ${change} instead of admitting ordinary chat`, async context => {
        // Use a fresh mutable settings row so in-place edits cannot alter RULE.
        settings['slack'].trustedBotTriggers = [{ ...RULE }];
        const release = await holdEnvelopeIngress(context);
        try {
            await bot.handleSlackEnvelope({ type: 'events_api', payload: { event: post() } });
            await flush(context);
            assert.equal(admissions.length, 0); assert.equal(collections.length, 0); assert.equal(bodies().length, 0);
            if (change === 'remove-list') settings['slack'].trustedBotTriggers = [];
            else if (change === 'remove-workflow') {
                const { workflowSkill: _unused, ...legacy } = RULE;
                settings['slack'].trustedBotTriggers = [legacy];
            } else if (change === 'replace-workflow') {
                settings['slack'].trustedBotTriggers = [{ ...RULE, workflowSkill: 'example-alternate' }];
            } else settings['slack'].trustedBotTriggers[0]!.workflowSkill = 'example-alternate';
        } finally { release(); }
        await until(context, () => bodies().length === 1 && slackIngressStats().lanes === 0);
        assert.equal(bodies()[0]!.body['text'], t('slack.workflow.unavailable', {}, 'en'));
        assert.equal(admissions.length, 0); assert.equal(collections.length, 0); assert.equal(enqueued.length, 0);
        assert.equal(reactions('white_check_mark').length, 0);
        context.mock.timers.tick(10000); await flush(context);
        assert.equal(bodies().length, 1); assert.equal(collections.length, 0);
    });
}

test('legacy event held before enablement stays ordinary after workflow is added', async context => {
    const { workflowSkill: _unused, ...legacy } = RULE;
    settings['slack'].trustedBotTriggers = [legacy];
    reply = '[SILENT]';
    const release = await holdEnvelopeIngress(context);
    try {
        await bot.handleSlackEnvelope({ type: 'events_api', payload: { event: post() } });
        await flush(context);
        assert.equal(admissions.length, 0); assert.equal(collections.length, 0); assert.equal(bodies().length, 0);
        settings['slack'].trustedBotTriggers = [{ ...RULE }];
    } finally { release(); }
    await until(context, () => reactions('white_check_mark').length === 1 && slackIngressStats().lanes === 0);
    assert.equal(admissions.length, 1); assert.equal(collections.length, 1);
    assert.equal(admissions[0]!.prompt, 'EXAMPLE_READY_V1 task');
    assert.equal(collections[0]!.prompt, 'EXAMPLE_READY_V1 task');
    assert.equal(admissions[0]!.meta['slackWorkflow'], undefined);
    assert.equal(collections[0]!.meta['slackWorkflow'], undefined);
    assert.equal(bodies().length, 1); assert.equal(bodies()[0]!.body['text'], '[SILENT]');
    assert.equal(reactions('x').length, 0);
});

for (const input of ['/continue', '/reset']) test(`${input} remains input to the configured workflow`, async context => {
    await run(input);
    await until(context, () => collections.length === 1 && reactions('white_check_mark').length === 1);
    assert.ok(admissions[0]!.prompt.includes(SKILL));
    assert.ok(admissions[0]!.prompt.endsWith(JSON.stringify(input)));
    assert.equal(admissions[0]!.result.continued, undefined);
});

for (const output of ['', '[SILENT]']) test(`direct unconfirmed output ${JSON.stringify(output)} fails ACK once without model retry`, async context => {
    reply = output;
    const incoming = await run();
    await until(context, () => reactions('x').length === 1);
    assert.equal(reactions('white_check_mark').length, 0);
    assert.equal(reactions('x')[0]!.body['timestamp'], incoming.ts);
    assert.equal(bodies().length, 1); assert.doesNotMatch(String(bodies()[0]!.body['text']), /\[SILENT\]/i);
    assert.ok(finishes.some(item => item.outcome === 'error'));
    context.mock.timers.tick(10000); await flush(context);
    assert.equal(admissions.length, 1); assert.equal(collections.length, 1); assert.equal(bodies().length, 1);
});

test('real gateway queue admission preserves server-owned workflow metadata', async () => {
    busy = true;
    await run();
    assert.equal(admissions[0]!.result.action, 'queued');
    assert.equal(collections.length, 0); assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.origin, 'slack');
    assert.equal(enqueued[0]!.prompt, admissions[0]!.prompt);
    assert.deepEqual(enqueued[0]!.meta['slackWorkflow'], admissions[0]!.meta['slackWorkflow']);
    assert.equal(progressOptions[0]!.workflowResponse, true);
});

for (const policy of ['steer', 'collect'] as const) test(`configured workflow queues separately under global ${policy} policy`, async () => {
    busy = true;
    settings['multiSession'].midRunPolicy = policy;
    await run();
    assert.equal(admissions[0]!.meta['midRunPolicy'], 'followup');
    assert.equal(admissions[0]!.result.action, 'queued');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.meta['collect'], undefined);
    assert.equal(collections.length, 0);
});

for (const sender of ['legacy-bot', 'human'] as const) test(`direct ${sender} SILENT keeps legacy behavior without workflow failure`, async context => {
    reply = '[SILENT]';
    if (sender === 'legacy-bot') {
        const { workflowSkill: _unused, ...legacy } = RULE;
        settings['slack'].trustedBotTriggers = [legacy];
    }
    const incoming = await run('ordinary task', sender === 'human' ? { type: 'app_mention', bot_id: '', user: 'U0PUBLIC1' } : {});
    await until(context, () => reactions('white_check_mark').length === 1);
    assert.equal(admissions[0]!.meta['slackWorkflow'], undefined);
    assert.equal(collections[0]!.meta['slackWorkflow'], undefined);
    assert.equal(reactions('x').length, 0);
    assert.equal(progressOptions[0]!.workflowResponse, false);
    assert.equal(reactions('white_check_mark')[0]!.body['timestamp'], incoming.ts);
    assert.equal(bodies().length, 1);
    assert.equal(bodies()[0]!.body['text'], '[SILENT]');
    assert.equal(collections.length, 1);
});

test('queued workflow ignores mismatched callbacks and diagnoses SILENT only for its own request', async context => {
    busy = true;
    const incoming = await run();
    assert.equal(admissions[0]!.result.action, 'queued');
    await until(context, () => reactions('eyes').length > 0 || calls.some(call => call.method === 'reactions.add'));
    // A foreign queued orphan has separate delivery authority; this event is a
    // direct completion and must not settle this request's queued waiter.
    for (const mismatch of [{ requestId: 'example-foreign', fromQueue: false }, { scope: 'example-foreign' },
        { sessionId: 'example-foreign' }, { origin: 'web' }, { target: { ...target, targetId: 'C0FOREIGN' } }]) {
        broadcast('orchestrate_done', done(0, { ...mismatch, text: '[SILENT]' }));
        await flush(context);
    }
    assert.equal(bodies().length, 0); assert.equal(reactions('x').length, 0); assert.equal(reactions('white_check_mark').length, 0);
    broadcast('queued_run_started', done(0));
    const completion = done(0, { text: '[SILENT]' });
    broadcast('orchestrate_done', completion);
    await until(context, () => reactions('x').length === 1);
    assert.equal(reactions('x')[0]!.body['timestamp'], incoming.ts);
    assert.equal(reactions('white_check_mark').length, 0);
    assert.equal(bodies().length, 1); assert.doesNotMatch(String(bodies()[0]!.body['text']), /\[SILENT\]/i);
    broadcast('orchestrate_done', completion); await flush(context);
    context.mock.timers.tick(10000); await flush(context);
    assert.equal(bodies().length, 1); assert.equal(admissions.length, 1); assert.equal(collections.length, 0);
});

test('two queued requests keep ACK anchors and workflow authority separate', async context => {
    busy = true;
    const first = await run();
    const second = await run('ordinary public task', { type: 'app_mention', bot_id: '', user: 'U0PUBLIC1' });
    assert.equal(admissions.length, 2);
    assert.equal(admissions[1]!.meta['slackWorkflow'], undefined);
    assert.notEqual(admissions[0]!.result.requestId, admissions[1]!.result.requestId);
    // Result payload metadata cannot turn a legacy request into a workflow.
    broadcast('queued_run_started', done(1));
    broadcast('orchestrate_done', done(1, { text: '[SILENT]', slackWorkflow: admissions[0]!.meta['slackWorkflow'] }));
    await until(context, () => finishes.some(item => item.requestId === admissions[1]!.result.requestId));
    assert.equal(reactions('x').some(call => call.body['timestamp'] === first.ts), false);
    assert.equal(reactions('white_check_mark').some(call => call.body['timestamp'] === first.ts), false);
    assert.equal(bodies().length, 1);
    assert.equal(bodies()[0]!.body['text'], '[SILENT]', 'public result metadata cannot enable the workflow diagnostic');
    assert.equal(reactions('white_check_mark').filter(call => call.body['timestamp'] === second.ts).length, 1);
    broadcast('queued_run_started', done(0));
    broadcast('orchestrate_done', done(0, { text: '[SILENT]', slackWorkflow: null }));
    await until(context, () => reactions('x').some(call => call.body['timestamp'] === first.ts));
    assert.equal(bodies().length, 2, 'stored workflow authority survives a contradictory result payload');
    assert.equal(bodies()[1]!.body['text'], t('slack.workflow.unconfirmed', {}, 'en'));
    assert.equal(reactions('x').filter(call => call.body['timestamp'] === first.ts).length, 1);
    assert.notEqual(first.ts, second.ts);
    assert.equal(collections.length, 0); assert.equal(enqueued.length, 2);
});

test('failed unconfirmed diagnostic delivery does not cause automatic resend or model rerun', async context => {
    reply = '[SILENT]'; failBody = true;
    await run();
    await until(context, () => reactions('x').length === 1);
    context.mock.timers.tick(10000); await flush(context);
    assert.equal(bodies().length, 1); assert.equal(admissions.length, 1); assert.equal(collections.length, 1);
    assert.equal(reactions('white_check_mark').length, 0);
});
