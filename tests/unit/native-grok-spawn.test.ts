import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import { buildRemoteBindingKey } from '../../src/messaging/session-key.ts';
import { MainReplacementOwnerMismatchError } from '../../src/agent/runtime/replace-turn.ts';
import { EXPLICIT_USER_STOP_KILL_REASON } from '../../src/agent/spawn/kill-reason.ts';

const root = fs.mkdtempSync(join(tmpdir(), 'native-grok-spawn-'));
const binary = join(root, 'grok.mjs'), wirePath = join(root, 'wire.jsonl');
fs.writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const log = value => fs.appendFileSync(process.env.GROK_TEST_WIRE, JSON.stringify(value)+'\\n');
const send = value => console.log(JSON.stringify(value));
const nativeId='private-grok-native', setup={sessionId:nativeId,models:{currentModelId:'grok-4.6',availableModels:[
 {modelId:'grok-4.6',name:'Grok',_meta:{supportsReasoningEffort:true,reasoningEffort:'low',reasoningEfforts:[
 {id:'low',value:'low',label:'Low'},{id:'high',value:'high',label:'High'}]}}]}};
let promptId, secret='', badCancel=false;
const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,update:u}});
const text=(value,id)=>update({sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text:value}});
log({kind:'spawn',pid:process.pid,argv:process.argv.slice(2),grant:Boolean(process.env.JAW_SLACK_TURN_GRANT)});
for await(const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:r.id,result});log(r);
 if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cached_token'}]});
 if(r.method==='authenticate') reply({});
 if(r.method==='session/new'||r.method==='session/load') reply(setup);
 if(r.method==='session/set_model') reply({});
 if(r.method==='session/prompt') {
  promptId=r.id; const p=r.params.prompt[0].text;
  if(p.includes('NONCE_A')) secret='NONCE_A';
  badCancel=p.includes('BAD_CANCEL');
  text('PRE-TOOL COMMENTARY','private-message-pre');
  update({sessionUpdate:'tool_call',toolCallId:'private-tool',title:'read',rawInput:{path:'fixture.txt'}});
  if(p.includes('HOLD_NATIVE_FIXTURE')) continue;
  update({sessionUpdate:'tool_call_update',toolCallId:'private-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'tool output'}}]});
  text(p==='RECALL' ? secret : 'GROK_MAIN_FINAL','private-message-final');
  reply({stopReason:'end_turn',_meta:{usage:{inputTokens:40,outputTokens:7,cachedReadTokens:30}}});
 }
 if(r.method==='session/cancel') {
  log({kind:'original-response',stopReason:badCancel?'end_turn':'cancelled'});
  send({jsonrpc:'2.0',id:promptId,result:{stopReason:badCancel?'end_turn':'cancelled'}});
 }
}
`);
fs.chmodSync(binary, 0o755);
const config = await import('../../src/core/config.ts');
config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
let detections = 0;
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => { detections++; return { available: true, path: binary }; } } });
const factory = await import('../../src/agent/runtime/acp/grok-session.ts');
const sessions: AcpSession[] = [];
const inputs: Parameters<typeof factory.createGrokSession>[0][] = [];
let beforeFactory: (() => Promise<void>) | undefined;
test.mock.module('../../src/agent/runtime/acp/grok-session.js', { namedExports: { ...factory,
    createGrokSession: async (input: Parameters<typeof factory.createGrokSession>[0]) => {
        inputs.push(input); await beforeFactory?.();
        const session = await factory.createGrokSession({ ...input, controlTimeoutMs: 500, drainTimeoutMs: 500 });
        sessions.push(session); return session;
    } } });
const trace = await import('../../src/trace/store.ts');
let failJournal = false;
test.mock.module('../../src/trace/store.js', { namedExports: { ...trace,
    appendTraceEvent: (...args: Parameters<typeof trace.appendTraceEvent>) => {
        if (failJournal) throw new Error('fixture journal failure'); return trace.appendTraceEvent(...args);
    } } });
const { spawnAgent, steerAgent, canSteerAgent, killActiveAgent, activeMainProcesses,
    enqueueMessage, messageQueue, setQueueHold, clearQueueHold, removeQueuedMessage } = await import('../../src/agent/spawn.ts');
const database = await import('../../src/core/db.ts');
const { db } = database;
const { subscribe } = await import('../../src/core/event-bus.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
const { AcpRuntimeSession } = await import('../../src/agent/runtime/acp/runtime-session.ts');
const { isNativeAdapterImplemented, isNativeWorkerImplemented } = await import('../../src/agent/runtime/selection.ts');
const { admitRequest, pendingRequestIds, settleAllPending } = await import('../../src/orchestrator/request-registry.ts');
const { reserveSlackToolGrant, slackCredentialKey } = await import('../../src/slack/tool-context.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
let serial = 0;
test.beforeEach(t => {
    failJournal = false; inputs.length = 0; detections = 0; beforeFactory = undefined;
    fs.writeFileSync(wirePath, '');
    config.settings.cli = 'grok'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = ['cursor']; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, grok: { model: 'default', effort: 'low', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in native fixture'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    clearGoalTimers();
    for (const [scope, run] of activeMainProcesses) if (run.meta.cli === 'grok') killActiveAgent(scope, 'user');
    for (const session of sessions.splice(0)) await session.close();
    settleAllPending('dropped', 'fixture-cleanup');
    assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function options() {
    const id = ++serial;
    const chatSessionId = createChatSession('Native journal fixture ' + id).id;
    setActiveChatSession('default');
    return { cli: 'grok', origin: 'web', scopeKey: 'grok-scope-' + id, chatSessionId,
        requestId: 'grok-request-' + id, env: { GROK_TEST_WIRE: wirePath, XAI_API_KEY: '' },
        sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true };
}
function wire(): Array<Record<string, any>> {
    return fs.readFileSync(wirePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function rows(sessionId: string) {
    return db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY id').all(sessionId) as Array<{ role: string; content: string }>;
}
function capture() {
    const events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    return { events, off };
}

async function held(opts: ReturnType<typeof options>, suffix = '') {
    const ready = Promise.withResolvers<void>();
    const off = subscribe(event => {
        if (event.event === 'agent_runtime' && event.data['scope'] === opts.scopeKey && event.data['kind'] === 'tool') ready.resolve();
    });
    const run = spawnAgent('HOLD_NATIVE_FIXTURE NONCE_A ' + suffix, opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([ready.promise, run.promise.then(() => { throw new Error('fixture completed before hold'); }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture hold timeout')), 2500); })]);
        return run;
    } finally { off(); if (timer) clearTimeout(timer); }
}

test('actual Grok main emits final-only output, canonical usage and reuses native PID/session', { timeout: 5000 }, async () => {
    const opts = options(), { events, off } = capture();
    try {
        for (const prompt of ['first', 'second']) {
            const result = await spawnAgent(prompt, opts).promise;
            assert.equal(result.code, 0); assert.equal(result.text, 'GROK_MAIN_FINAL');
            assert.equal(result.runtimeOutcome?.partialText, 'PRE-TOOL COMMENTARYGROK_MAIN_FINAL');
        }
        assert.equal(inputs.length, 1); assert.equal(inputs[0]!.model, 'grok-build');
        assert.equal(inputs[0]!.binary, binary); assert.equal(inputs[0]!.permissions, 'auto');
        const native = events.filter(e => e.type === 'agent_runtime').map(e => e.data);
        assert.equal(native.filter(e => e['kind'] === 'turn-end').length, 2);
        assert.ok(native.some(e => e['kind'] === 'usage' && e['inputTokens'] === 40 && e['outputTokens'] === 7 && e['cachedTokens'] === 30));
        assert.ok(native.every(e => e['scope'] === opts.scopeKey && e['sessionId'] === opts.chatSessionId));
        const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
        for (const runId of new Set(native.map(e => String(e.runId)))) {
            const page = readActivityPage({ runId, sessionId: opts.chatSessionId, after: 0, limit: 40 })!;
            assert.deepEqual(page.events, native.filter(e => e.runId === runId));
            assert.equal(page.incomplete, false);
            assert.equal(trace.getTraceRun(runId)?.session_id, opts.chatSessionId);
            assert.equal(trace.getTraceRun(runId)?.scope_key, opts.scopeKey);
        }
        assert.doesNotMatch(JSON.stringify(native), /private-grok-native|private-tool|private-message/);
        assert.equal(events.some(e => e.type === 'agent_output'), false);
        assert.deepEqual(rows(opts.chatSessionId).filter(r => r.role === 'assistant').map(r => r.content), ['GROK_MAIN_FINAL', 'GROK_MAIN_FINAL']);
        assert.equal(wire().filter(e => e['kind'] === 'spawn').length, 1);
        assert.deepEqual(wire()[0]!['argv'], ['agent', '--no-leader', '--always-approve', 'stdio']);
        assert.equal(wire().filter(e => e['method'] === 'authenticate')[0]!['params'].methodId, 'cached_token');
    } finally { off(); }
});

test('heartbeat native Grok launches request-lifetime with its destination grant in env', { timeout: 5000 }, async () => {
    const opts = options();
    const target: RemoteTarget = {
        channel: 'slack',
        targetKind: 'channel',
        peerKind: 'channel',
        targetId: 'C1HEART',
        threadId: '1.001',
    };
    Object.assign(opts, { origin: 'heartbeat', target });
    assert.equal(reserveSlackToolGrant({
        teamId: 'T1HEART',
        actorId: 'U1HEART',
        destination: target,
        credentialKey: slackCredentialKey('xoxb-fixture'),
        enforceDestination: true,
    }, {
        requestId: opts.requestId,
        scope: opts.scopeKey,
        chatSessionId: opts.chatSessionId,
    }), true);
    const result = await spawnAgent('heartbeat grant fixture', opts).promise;
    assert.equal(result.code, 0);
    assert.equal(wire().find(item => item.kind === 'spawn')?.grant, true);
    assert.equal(poolStats().busy, 0, 'request-lifetime lease retires instead of keeping the grant-bearing process resident');
});

test('concurrent C queues as busy while the first replacement B remains dispatched', { timeout: 5000 }, async () => {
    const opts = options(), run = await held(opts), { events, off } = capture();
    const holdId = 'fixture-hold-' + opts.scopeKey;
    let queueId: string | undefined;
    setQueueHold(opts.scopeKey, holdId);
    try {
        const b = steerAgent(opts.scopeKey, 'RECALL', 'web');
        const c = steerAgent(opts.scopeKey, 'queued C', 'web').then(outcome => {
            if (outcome === 'fallback-queue') queueId = enqueueMessage('queued C', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId });
            return outcome;
        });
        assert.equal(await c, 'fallback-queue'); assert.equal(await b, 'steered');
        assert.equal((await run.promise).text, 'NONCE_A');
        assert.ok(queueId); assert.equal(messageQueue.find(item => item.id === queueId)?.prompt, 'queued C');
        assert.equal(events.find(e => e.type === 'steer_rejected')?.data['reason'], 'busy');
        assert.deepEqual(wire().filter(e => e['method'] === 'session/prompt').slice(1).map(e => e['params'].prompt[0].text), ['RECALL']);
        assert.equal(rows(opts.chatSessionId).some(row => row.role === 'user' && row.content === 'queued C'), false);
    } finally {
        if (queueId) removeQueuedMessage(queueId);
        clearQueueHold(opts.scopeKey, holdId, { resume: false }); off();
    }
});

test('cancel drains original A before B, retains context and commits B before its fast final', { timeout: 5000 }, async () => {
    const opts = options(), { events, off } = capture();
    try {
        const run = await held(opts);
        assert.equal(canSteerAgent(opts.scopeKey), true);
        admitRequest('replace-B', opts.scopeKey);
        assert.equal(await steerAgent(opts.scopeKey, 'RECALL', 'web', { chatSessionId: opts.chatSessionId, requestId: 'replace-B' }), 'steered');
        const result = await run.promise;
        assert.equal(result.text, 'NONCE_A'); assert.equal(result.runtimeOutcome?.status, 'done');
        const messages = rows(opts.chatSessionId);
        assert.deepEqual(messages.slice(1), [{ role: 'user', content: 'RECALL' }, { role: 'assistant', content: 'NONCE_A' }]);
        const frames = wire(), prompts = frames.filter(e => e['method'] === 'session/prompt');
        assert.equal(prompts.length, 2); assert.equal(inputs.length, 1);
        assert.equal(prompts[1]!['params'].prompt[0].text, 'RECALL');
        assert.equal(prompts[0]!['params'].sessionId, prompts[1]!['params'].sessionId);
        const cancelIndex = frames.findIndex(e => e['method'] === 'session/cancel');
        assert.ok(cancelIndex > frames.indexOf(prompts[0]!));
        assert.ok(frames.findIndex(e => e['kind'] === 'original-response') > cancelIndex);
        assert.ok(frames.indexOf(prompts[1]!) > frames.findIndex(e => e['kind'] === 'original-response'));
        const started = events.filter(e => e.type === 'steer_started');
        assert.equal(started.length, 1); assert.equal(started[0]!.data['mode'], 'cancel-reprompt');
        assert.equal(started[0]!.data['localDispatch'], true);
        assert.equal(events.filter(e => e.type === 'request_settled' && e.data['requestId'] === 'replace-B').length, 1);
        assert.equal(pendingRequestIds().includes('replace-B'), false);
        assert.equal(events.filter(e => e.type === 'agent_runtime' && e.data['kind'] === 'turn-end').length, 1);
        assert.equal(events.filter(e => e.type === 'new_message' && e.data['role'] === 'user').length, 1);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
    } finally { off(); }
});

for (const failure of ['cancel', 'dispatch', 'insert', 'broadcast', 'settle'] as const) {
    test(`fatal ${failure} propagates to caller without automatic queue, print or restart`, { timeout: 5000 }, async t => {
        const opts = options(), { events, off } = capture();
        const run = await held(opts, failure === 'cancel' ? 'BAD_CANCEL' : '');
        let insertAttempts = 0, resolved = false;
        const requestId = 'replace-failure-' + opts.requestId;
        admitRequest(requestId, opts.scopeKey);
        const listener = (type: string, data: Record<string, unknown>) => {
            if (failure === 'broadcast' && type === 'new_message' && data['content'] === 'RECALL') throw new Error('fixture broadcast failed');
            if (failure === 'settle' && type === 'request_settled' && data['requestId'] === requestId) throw new Error('fixture settle failed');
        };
        addBroadcastListener(listener);
        if (failure === 'dispatch') t.mock.method(sessions[0]!, 'prompt', async () => { throw new Error('fixture dispatch failed'); });
        if (failure === 'insert') t.mock.method(database.insertMessage, 'run', () => { insertAttempts++; throw new Error('fixture insert failed'); });
        try {
            // The gateway queues only a resolved fallback; CLI await takes the same rejection.
            await assert.rejects(steerAgent(opts.scopeKey, 'RECALL', 'web', { chatSessionId: opts.chatSessionId, requestId }).then(outcome => {
                resolved = true;
                if (outcome === 'fallback-queue') enqueueMessage('RECALL', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId });
                return outcome;
            }));
            const result = await run.promise;
            assert.equal(resolved, false); assert.equal(result.runtimeOutcome?.status, 'error');
            assert.equal(result.runtimeOutcome?.finalText, null);
            assert.match(result.runtimeOutcome?.partialText || '', /PRE-TOOL COMMENTARY/);
            assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
            assert.equal(inputs.length, 1); assert.equal(wire().filter(e => e['kind'] === 'spawn').length, 1);
            assert.equal(events.filter(e => e.type === 'agent_runtime' && e.data['kind'] === 'turn-end').length, 1);
            assert.equal(events.filter(e => e.type === 'steer_started').length, failure === 'settle' ? 1 : 0);
            assert.equal(rows(opts.chatSessionId).filter(r => r.role === 'user' && r.content === 'RECALL').length,
                failure === 'broadcast' || failure === 'settle' ? 1 : 0);
            if (failure === 'insert') assert.equal(insertAttempts, 1);
        } finally { off(); removeBroadcastListener(listener); }
    });
}

test('real gateway settles a fatal replacement as failed without enqueueing it', { timeout: 5000 }, async () => {
    const { submitMessage } = await import('../../src/orchestrator/gateway.ts');
    const opts = options(), { events, off } = capture(), run = await held(opts, 'BAD_CANCEL');
    const noFallback = Promise.withResolvers<never>();
    const offFallback = subscribe(event => {
        if (event.event === 'steer_rejected' && event.data['scope'] === opts.scopeKey) {
            noFallback.reject(new Error('fatal replacement unexpectedly reached gateway fallback'));
        }
    });
    try {
        const submitted = submitMessage('RECALL', { origin: 'web', scope: opts.scopeKey, chatSessionId: opts.chatSessionId });
        assert.equal(submitted.disposition, 'steered');
        assert.equal((await Promise.race([run.promise, noFallback.promise])).runtimeOutcome?.status, 'error');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.filter(e => e.type === 'request_settled' && e.data['requestId'] === submitted.requestId
            && e.data['outcome'] === 'failed').length, 1);
        assert.equal(pendingRequestIds().includes(submitted.requestId!), false);
        assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
        assert.equal(rows(opts.chatSessionId).some(r => r.role === 'user' && r.content === 'RECALL'), false);
        assert.equal(inputs.length, 1);
    } finally { off(); offFallback(); }
});

test('real CLI steer propagates fatal dispatch without its follow-up queue path', { timeout: 5000 }, async t => {
    const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
    const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
    const { withSessionScope } = await import('../../src/core/session-context.ts');
    const opts = options(), run = await held(opts);
    const ctx = makeCommandCtx('cli', 'en', { applySettings: () => assert.fail('unexpected settings write'),
        clearSession: () => assert.fail('unexpected session reset') });
    t.mock.method(sessions[0]!, 'prompt', async () => { throw new Error('fixture dispatch failed'); });
    await assert.rejects(withSessionScope({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId },
        () => steerHandler(['RECALL'], ctx)));
    assert.equal((await run.promise).runtimeOutcome?.status, 'error');
    assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
    assert.equal(inputs.length, 1);
});

for (const conflict of ['chat', 'remoteKey', 'target', 'guild', 'targetKind'] as const) {
    test(`gateway rejects foreign ${conflict} before replacement dispatch, row insertion or queueing`, { timeout: 5000 }, async t => {
        const { submitMessage } = await import('../../src/orchestrator/gateway.ts');
        const target: RemoteTarget = { channel: 'slack', peerKind: 'channel', targetKind: 'channel',
            targetId: 'COWNER', threadId: '1.001', guildId: 'TOWNER' };
        const opts = { ...options(), target, remoteKey: buildRemoteBindingKey(target) }, run = await held(opts);
        const captured = activeMainProcesses.get(opts.scopeKey)!;
        const hook = t.mock.method(captured, 'replaceTurn', async () => assert.fail('foreign binding reached replacement hook'));
        const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get(), { events, off } = capture();
        try {
            const suppliedTarget = { ...target,
                ...(conflict === 'target' ? { targetId: 'CFOREIGN' } : {}),
                ...(conflict === 'guild' ? { guildId: 'TFOREIGN' } : {}),
                ...(conflict === 'targetKind' ? { targetKind: 'user' as const } : {}) };
            const submitted = submitMessage('foreign B', { origin: 'web', scope: opts.scopeKey,
                chatSessionId: conflict === 'chat' ? 'foreign-chat' : opts.chatSessionId,
                remoteKey: conflict === 'remoteKey' ? 'jaw:slack:channel:CFOREIGN' : opts.remoteKey, target: suppliedTarget });
            await new Promise(resolve => setImmediate(resolve));
            const settled = events.filter(e => e.type === 'request_settled' && e.data['requestId'] === submitted.requestId);
            assert.equal(settled.length, 1); assert.equal(settled[0]!.data['outcome'], 'failed');
            assert.equal(settled[0]!.data['error'], 'native_replacement_owner_mismatch');
            assert.equal(hook.mock.callCount(), 0);
            assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), before);
            assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
            assert.equal(wire().filter(e => e['method'] === 'session/prompt').length, 1);
            assert.equal(wire().some(e => e['method'] === 'session/cancel'), false);
            assert.equal(events.some(e => e.type === 'steer_started' || e.type === 'steer_rejected' || e.type === 'new_message'), false);
        } finally { off(); killActiveAgent(opts.scopeKey, 'user'); await run.promise; }
    });
}

test('CLI rejects a foreign chat with the fixed typed owner error and no dispatch, row or queue', { timeout: 5000 }, async t => {
    const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
    const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
    const { withSessionScope } = await import('../../src/core/session-context.ts');
    const opts = options(), run = await held(opts), captured = activeMainProcesses.get(opts.scopeKey)!;
    const hook = t.mock.method(captured, 'replaceTurn', async () => assert.fail('foreign chat reached replacement hook'));
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    const ctx = makeCommandCtx('cli', 'en', { applySettings: () => assert.fail('unexpected settings write'),
        clearSession: () => assert.fail('unexpected session reset') });
    try {
        await assert.rejects(withSessionScope({ scope: opts.scopeKey, chatSessionId: 'foreign-chat' },
            () => steerHandler(['foreign B'], ctx)), error => error instanceof MainReplacementOwnerMismatchError
                && error.code === 'native_replacement_owner_mismatch' && error.message === error.code);
        assert.equal(hook.mock.callCount(), 0);
        assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), before);
        assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
        assert.equal(wire().filter(e => e['method'] === 'session/prompt').length, 1);
        assert.equal(wire().some(e => e['method'] === 'session/cancel'), false);
    } finally { killActiveAgent(opts.scopeKey, 'user'); await run.promise; }
});

test('matching remote binding captures its target before asynchronous dispatch', { timeout: 5000 }, async () => {
    const target: RemoteTarget = { channel: 'slack', peerKind: 'channel', targetKind: 'channel', targetId: 'COWNER',
        threadId: '1.001', guildId: 'TOWNER' };
    const opts = { ...options(), target, remoteKey: buildRemoteBindingKey(target) }, run = await held(opts);
    const supplied = { ...target }, { events, off } = capture();
    try {
        const steering = steerAgent(opts.scopeKey, 'RECALL', 'web', {
            chatSessionId: opts.chatSessionId, remoteKey: opts.remoteKey, target: supplied,
        });
        supplied.targetId = 'CMUTATED'; supplied.guildId = 'TMUTATED';
        assert.equal(await steering, 'steered');
        assert.equal((await run.promise).text, 'NONCE_A');
        assert.deepEqual(events.find(event => event.type === 'steer_started')?.data['target'], target);
    } finally { off(); }
});

test('native finalizer removes only its captured replacement hook', { timeout: 5000 }, async () => {
    const opts = options(), run = await held(opts), captured = activeMainProcesses.get(opts.scopeKey)!;
    const replacement = async () => ({ kind: 'unavailable' as const, reason: 'replacement-owner' });
    const listener = (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_done' && data['sessionId'] === opts.chatSessionId) captured.replaceTurn = replacement;
    };
    addBroadcastListener(listener);
    try {
        assert.equal(await steerAgent(opts.scopeKey, 'RECALL', 'web'), 'steered');
        await run.promise; assert.equal(captured.replaceTurn, replacement);
    } finally { removeBroadcastListener(listener); }
});

test('startup no-start and stale generation fall back with explicit reason and no input row', { timeout: 5000 }, async () => {
    const opts = options(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    beforeFactory = async () => { entered.resolve(); await gate.promise; };
    const { events, off } = capture(), run = spawnAgent('first', opts);
    try {
        await entered.promise;
        assert.equal(await steerAgent(opts.scopeKey, 'not started', 'web'), 'fallback-queue');
        assert.equal(rows(opts.chatSessionId).length, 0);
        bumpScopeSessionGeneration(opts.scopeKey);
        assert.equal(await steerAgent(opts.scopeKey, 'lost owner', 'web'), 'fallback-queue');
        assert.deepEqual(events.filter(e => e.type === 'steer_rejected').map(e => e.data['reason']), ['native-turn-not-started', 'native-owner-lost']);
        assert.equal(events.filter(e => e.type === 'steer_started').length, 0);
        gate.resolve(); assert.notEqual((await run.promise).code, 0);
    } finally { gate.resolve(); off(); }
});

test('facade distinguishes busy/raced receipts from unavailable without recording input', { timeout: 5000 }, async t => {
    const opts = options(), run = await held(opts), { events, off } = capture();
    let reason = 'not-running';
    t.mock.method(AcpRuntimeSession.prototype, 'steer', async () => ({
        mode: 'cancel-reprompt', accepted: false, turnId: '', reason,
    }));
    try {
        const reasons = ['busy', 'superseded', 'not-current', 'not-running', 'not-started', 'promptunsupported'];
        for (reason of reasons) {
            const receipt = await activeMainProcesses.get(opts.scopeKey)!.replaceTurn!('RECALL', () => assert.fail('no-start invoked commit'));
            assert.deepEqual(receipt, { kind: reasons.indexOf(reason) < 3 ? 'race' : 'unavailable', reason });
            assert.equal(await steerAgent(opts.scopeKey, 'RECALL', 'web'), 'fallback-queue');
        }
        assert.equal(rows(opts.chatSessionId).some(r => r.content === 'RECALL'), false);
        assert.deepEqual(events.filter(e => e.type === 'steer_rejected').map(e => e.data['reason']), reasons);
        assert.equal(events.some(e => e.type === 'steer_started' || e.type === 'new_message'), false);
        killActiveAgent(opts.scopeKey, 'user'); await run.promise;
    } finally { off(); }
});

for (const mismatch of ['callback-without-acceptance', 'acceptance-without-callback', 'duplicate-callback'] as const) {
    test(`inconsistent ${mismatch} is fatal`, { timeout: 5000 }, async t => {
        const opts = options(), run = await held(opts);
        t.mock.method(AcpRuntimeSession.prototype, 'steer', async (_prompt, callback) => {
            if (mismatch === 'callback-without-acceptance') callback?.();
            if (mismatch === 'duplicate-callback') { callback?.(); callback?.(); }
            return { mode: 'cancel-reprompt', accepted: mismatch === 'acceptance-without-callback', turnId: '' };
        });
        await assert.rejects(steerAgent(opts.scopeKey, 'RECALL', 'web'), /inconsistent_receipt|duplicate_dispatch/);
        assert.equal((await run.promise).runtimeOutcome?.status, 'error');
        assert.equal(inputs.length, 1); assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
        assert.equal(rows(opts.chatSessionId).filter(r => r.role === 'user' && r.content === 'RECALL').length,
            mismatch === 'acceptance-without-callback' ? 0 : 1);
    });
}

test('mention-watch binding and private I/O identity survive disabled multi-session', { timeout: 5000 }, async () => {
    config.settings.multiSession.enabled = false;
    const opts = { ...options(), origin: 'heartbeat', scopeKey: 'mention-watch:grok-thread' };
    const activity: unknown[] = [], { events, off } = capture();
    try {
        const result = await spawnAgent('fixture', { ...opts, lifecycle: { onActivity: (_source, identity) => activity.push(identity) } }).promise;
        assert.equal(result.text, 'GROK_MAIN_FINAL');
        assert.ok(activity.length > 0);
        assert.ok(activity.every(identity => (identity as Record<string, unknown>)['scope'] === opts.scopeKey
            && (identity as Record<string, unknown>)['sessionId'] === opts.chatSessionId));
        assert.ok(events.filter(e => e.type === 'agent_runtime').every(e => e.data['scope'] === opts.scopeKey && e.data['sessionId'] === opts.chatSessionId));
        assert.deepEqual(rows(opts.chatSessionId).filter(r => r.role === 'assistant'), [{ role: 'assistant', content: 'GROK_MAIN_FINAL' }]);
    } finally { off(); }
});

test('optional journal failure preserves final and explicit stop uses native cancellation', { timeout: 5000 }, async () => {
    const opts = options(); failJournal = true;
    assert.equal((await spawnAgent('fixture', opts).promise).text, 'GROK_MAIN_FINAL');
    failJournal = false;
    const stoppedOpts = options(), run = await held(stoppedOpts);
    killActiveAgent(stoppedOpts.scopeKey, EXPLICIT_USER_STOP_KILL_REASON);
    const result = await run.promise;
    assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
    assert.equal(result.stopCause, 'user_stop');
    assert.ok(wire().some(e => e['method'] === 'session/cancel'));
});

for (const rejection of ['restrictive', 'worker'] as const) {
    test(`${rejection} native Grok rejects before detection, factory, prompt files or DB writes`, async t => {
        const opts = options();
        if (rejection === 'restrictive') config.settings.permissions = 'safe';
        const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
        const write = t.mock.method(fs, 'writeFileSync', () => { assert.fail('rejected request wrote a prompt file'); });
        const result = await spawnAgent('not admitted', { ...opts, ...(rejection === 'worker' ? { agentId: 'worker-grok' } : {}) }).promise;
        assert.equal(result.code, 78); assert.match(result.text, rejection === 'worker' ? /worker/ : /restrictive/);
        assert.equal(inputs.length, 0); assert.equal(detections, 0); assert.equal(write.mock.callCount(), 0);
        assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), before);
        assert.equal(isNativeAdapterImplemented('grok'), true); assert.equal(isNativeWorkerImplemented('grok'), false);
    });
}
