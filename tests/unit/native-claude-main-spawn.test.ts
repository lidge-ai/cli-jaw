import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.js';
import { EXPLICIT_USER_STOP_KILL_REASON } from '../../src/agent/spawn/kill-reason.ts';

const root = fs.mkdtempSync(join(tmpdir(), 'native-claude-spawn-'));
let detectedBinary = process.execPath;
const childCode = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
let turns=0, waiting;
const finish=(message,text)=> {
 const result={type:'result',subtype:'success',is_error:false,session_id:'private-claude-session',
  uuid:'result-'+turns,user_message_uuid:message.uuid,num_turns:turns,duration_ms:25,total_cost_usd:turns*0.125,
  usage:{input_tokens:11,output_tokens:7,cache_read_input_tokens:3}};
 if(!text.includes('ABSENT_FINAL')) result.result=text.includes('EMPTY_FINAL')?'':'CLAUDE_FINAL';
 send({type:'assistant',parent_tool_use_id:null,message:{id:'final-'+turns,content:[{type:'text',text:'CLAUDE_FINAL'}]}});
 send(result);
};
readline.createInterface({input:process.stdin}).on('line',line=> {
 const message=JSON.parse(line);
 if(message.fixtureDecision) {
  const value=waiting; waiting=null;
  if(value.id) send({type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:value.id,content:'late fixture tool output'}]}});
  finish(value.message,value.text); return;
 }
 turns++;
 const content=message.message.content;
 const text=typeof content==='string'?content:content.filter(x=>x.type==='text').map(x=>x.text).join('');
 process.stderr.write('fixture progress\n');
 send({type:'system',subtype:'init',session_id:'private-claude-session',permissionMode:'default'});
 send({type:'assistant',parent_tool_use_id:null,message:{id:'partial-'+turns,content:[{type:'text',text:'PRE-TOOL COMMENTARY'}]}});
 if(text.includes('HOLD_PARTIAL_PROGRESS')) { waiting={message,text}; send({fixturePause:true}); return; }
 if(text.includes('HOLD_NATIVE_FIXTURE')) return;
 const tool='Read', id='private-tool-'+turns, input={file_path:'fixture.txt'};
 send({type:'assistant',parent_tool_use_id:null,message:{id:'tool-'+turns,content:[{type:'tool_use',id,name:tool,input}]}});
 if(text.includes('HOLD_TOOL_PROGRESS')) { waiting={message,text,id}; send({fixturePause:true}); return; }
 if(!text.includes('OMIT_TOOL_RESULT')) send({type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:id,content:'fixture tool output'}]}});
 finish(message,text);
});
setTimeout(()=>process.exit(99),10000);
`;
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: detectedBinary }) } });
type QueryInput = Parameters<NonNullable<ClaudeSessionOptions['queryFactory']>>[0];
const queries: Array<{ options: QueryInput['options']; child: ChildProcessWithoutNullStreams; messages: any[]; decisions: any[]; done: Promise<void> }> = [];
let beforeFixtureResume: (() => Promise<void>) | undefined;
let sdkMissing = false;
test.mock.module('../../src/agent/runtime/claude-sdk-loader.js', { namedExports: { loadClaudeSdk: async () => {
    if (sdkMissing) throw new Error('Claude native SDK unavailable');
    return { query: ({ prompt, options }: QueryInput) => {
    const controller = new AbortController();
    const child = options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', childCode],
        cwd: options.cwd, env: process.env, signal: controller.signal }) as ChildProcessWithoutNullStreams;
    const messages: any[] = [], decisions: any[] = [];
    const done = (async () => { for await (const message of prompt) { messages.push(message); child.stdin.write(JSON.stringify(message) + '\n'); } })();
    void done.catch(() => {});
    queries.push({ options, child, messages, decisions, done });
    return {
        close() { controller.abort(); child.stdin.end(); },
        async *[Symbol.asyncIterator]() {
            for await (const line of createInterface({ input: child.stdout })) {
                const frame = JSON.parse(line);
                if (frame.fixturePause) {
                    await beforeFixtureResume?.(); child.stdin.write(JSON.stringify({ fixtureDecision: true }) + '\n');
                } else yield frame;
            }
        },
    };
} }; } } });
// Install this boundary before Session/Projection capture their recorder import.
const trace = await import('../../src/trace/store.ts');
let failJournal = false;
test.mock.module('../../src/trace/store.js', { namedExports: { ...trace,
    appendTraceEvent: (...args: Parameters<typeof trace.appendTraceEvent>) => {
        if (failJournal) throw new Error('fixture journal failure'); return trace.appendTraceEvent(...args);
    } } });
const factory = await import('../../src/agent/runtime/claude-sdk-session.ts');
const sessions: InstanceType<typeof factory.ClaudeSdkSession>[] = [];
const inputs: ClaudeSessionOptions[] = [];
const factoryDone: Promise<void>[] = [];
let beforeFactory: ((input: ClaudeSessionOptions) => Promise<void>) | undefined;
test.mock.module('../../src/agent/runtime/claude-sdk-session.js', { namedExports: { ...factory,
    createClaudeSdkSession: (input: ClaudeSessionOptions) => {
        const result = (async () => {
            inputs.push(input); await beforeFactory?.(input);
            const session = await factory.createClaudeSdkSession({ ...input }); sessions.push(session); return session;
        })();
        factoryDone.push(result.then(() => {}, () => {})); return result;
    } } });
const lifecycle = await import('../../src/agent/lifecycle-handler.ts');
let beforeLifecycle: ((input: Parameters<typeof lifecycle.handleAgentExit>[0]) => Promise<void>) | undefined;
test.mock.module('../../src/agent/lifecycle-handler.js', { namedExports: { ...lifecycle,
    handleAgentExit: async (input: Parameters<typeof lifecycle.handleAgentExit>[0]) => {
        await beforeLifecycle?.(input); return lifecycle.handleAgentExit(input);
    } } });
const { spawnAgent, killActiveAgent, killAgentById, killAllAgents, waitForExitSettled, waitForProcessEnd,
    waitForMainProcessEnd, waitForAllProcessesEnd, activeMainProcesses, activeProcesses, enqueueMessage, messageQueue, removeQueuedMessage } = await import('../../src/agent/spawn.ts');
const database = await import('../../src/core/db.ts');
const { db, getMaxMessageId, getSteerSalvageAfter } = database;
const { subscribe } = await import('../../src/core/event-bus.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { runtimeRequests } = await import('../../src/agent/runtime/requests.ts');
const { hasClaudeRuns, hasClaudeWorker, reserveClaudeRun } = await import('../../src/agent/runtime/claude-run-controls.ts');
const { beginSteerInput } = await import('../../src/agent/steer-input-guard.ts');
const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
const { getLiveRun, beginLiveRun, setLiveRunTraceId, replaceLiveRunTools, clearLiveRun } = await import('../../src/agent/live-run-state.ts');
const { claimWorker, getWorkerSlot, getWorkerProgressSnapshot, clearWorkersForScope } = await import('../../src/orchestrator/worker-registry.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
let serial = 0;
const gates: Array<() => void> = [];
function deferred() {
    const value = Promise.withResolvers<void>(); gates.push(value.resolve); return value;
}
function options() {
    const id = ++serial;
    const chatSessionId = createChatSession('Native journal fixture ' + id).id;
    setActiveChatSession('default');
    return { cli: 'claude', model: 'default', effort: 'low', origin: 'web', scopeKey: 'claude-scope-' + id,
        chatSessionId, requestId: 'claude-request-' + id,
        sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true };
}
const runTest = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { concurrency: false, timeout: 6000 }, fn);
function assistantRows(session: string) {
    return db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(session, 'assistant');
}
function assertTerminalOrder(events: Array<{ type: string; data: Record<string, any> }>, runId: string) {
    const order = events.filter(event => event.data.runId === runId || event.data.traceRunId === runId)
        .flatMap(event => event.type === 'agent_done' ? ['compat']
            : event.type === 'agent_runtime' && ['turn-start', 'turn-end'].includes(event.data.kind) ? [event.data.kind] : []);
    assert.deepEqual(order, ['turn-start', 'compat', 'turn-end']);
}
test.beforeEach(t => {
    inputs.length = 0; queries.length = 0; factoryDone.length = 0; beforeFactory = undefined; beforeLifecycle = undefined; failJournal = false;
    beforeFixtureResume = undefined; detectedBinary = process.execPath; sdkMissing = false;
    config.settings.cli = 'claude'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, claude: { model: 'default', effort: 'low', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in native Claude fixture'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    beforeFactory = undefined; beforeLifecycle = undefined; gates.splice(0).forEach(resolve => resolve());
    killAllAgents('user'); await waitForAllProcessesEnd(2000); lifecycle.clearGoalTimers();
    await Promise.all(factoryDone);
    for (const session of sessions.splice(0)) await session.close();
    for (const query of queries) {
        await query.done;
        assert.ok(query.child.exitCode !== null || query.child.signalCode !== null);
    }
    assert.equal(hasClaudeRuns(), false); assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

runTest('scoped and global Stop fence pending redirects before synchronous Claude cancellation callbacks', async () => {
    for (const global of [false, true]) {
        const opts = options(), guard = beginSteerInput(opts.scopeKey), observed: boolean[] = [];
        const control = reserveClaudeRun({ runId: opts.requestId, scope: opts.scopeKey,
            workerId: 'stop-order-' + opts.requestId, cancel: () => { observed.push(guard.isCancelled()); } });
        try {
            assert.equal(global ? killAllAgents('user') : killActiveAgent(opts.scopeKey, 'user'), true);
            assert.deepEqual(observed, [true], 'pending input cannot survive a synchronous provider callback');
            assert.equal(hasClaudeWorker('stop-order-' + opts.requestId), true, 'Stop still retains physical-cleanup ownership');
        } finally { control.finish(); guard.release(); }
    }
});

runTest('main metadata retains the actual Safe override for dispatch consumers', async () => {
    const opts = { ...options(), permissions: 'safe' };
    let observed = false;
    beforeFactory = async input => {
        assert.equal(input.prepared.permissions, 'safe');
        assert.equal(activeMainProcesses.get(opts.scopeKey)?.meta?.permissions, 'safe');
        observed = true;
    };
    const result = await spawnAgent('captured permission fixture', opts).promise;
    assert.equal(result.code, 0); assert.equal(observed, true);
});

runTest('main two turns use the public factory once and deliver full lifecycle results with final-only messages', async () => {
    const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const first = await spawnAgent('first fixture', opts).promise;
        const second = await spawnAgent('second fixture', opts).promise;
        for (const result of [first, second]) {
            assert.equal(result.code, 0); assert.equal(result.text, 'CLAUDE_FINAL');
            assert.equal(result.runtimeOutcome?.partialText, 'CLAUDE_FINAL');
            assert.equal(result.sessionId, 'private-claude-session');
            assert.equal(result.cost, 0.125); assert.ok(result.tools?.length); assert.ok(result.smoke); assert.equal(result.diagnostic, '');
        }
        assert.notEqual(first.traceRunId, second.traceRunId);
        assert.equal(inputs.length, 1); assert.equal(queries.length, 1); assert.equal(queries[0]!.messages.length, 2);
        assert.equal(inputs[0]!.deferTurnEnd, true);
        assert.equal(events.some(event => event.type === 'agent_output'), false);
        const native = events.filter(event => event.type === 'agent_runtime').map(event => event.data);
        assert.equal(native.filter(event => event.kind === 'turn-end').length, 2);
        assert.ok(native.some(event => event.kind === 'tool'));
        assert.ok(native.some(event => event.kind === 'message' && event.text === 'PRE-TOOL COMMENTARY'));
        assert.ok(native.every(event => event.scope === opts.scopeKey && event.sessionId === opts.chatSessionId));
        const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
        for (const result of [first, second]) {
            const page = readActivityPage({ runId: result.traceRunId!, sessionId: opts.chatSessionId, after: 0, limit: 40 })!;
            assert.deepEqual(page.events, native.filter(e => e.runId === result.traceRunId));
            assert.equal(page.incomplete, false);
            assert.equal(trace.getTraceRun(result.traceRunId!)?.session_id, opts.chatSessionId);
            assert.equal(trace.getTraceRun(result.traceRunId!)?.scope_key, opts.scopeKey);
        }
        assert.doesNotMatch(JSON.stringify(native), /private-claude-session|private-tool-/);
        assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }, { content: 'CLAUDE_FINAL' }]);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
    } finally { off(); }
});

runTest('journal failure preserves direct final and scoped child I/O liveness', async () => {
    failJournal = true; const opts = options(), identities: any[] = [];
    const result = await spawnAgent('fixture', { ...opts, lifecycle: {
        onActivity: (source, identity) => { assert.equal(source, 'native-runtime'); identities.push(identity); },
        onExit: () => { throw new Error('fixture observer failure'); },
    } }).promise;
    assert.equal(result.text, 'CLAUDE_FINAL'); assert.equal(result.code, 0);
    assert.ok(identities.length > 0);
    assert.ok(identities.every(value => value.scope === opts.scopeKey && value.sessionId === opts.chatSessionId && value.requestId === opts.requestId));
    assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }]);
});

runTest('missing native tool terminal cannot become a completed legacy tool on a successful parent', async () => {
    const result = await spawnAgent('OMIT_TOOL_RESULT', options()).promise;
    assert.equal(result.code, 0); assert.equal(result.text, 'CLAUDE_FINAL');
    assert.ok(result.tools?.some(tool => tool.label === 'Read' && tool.status === 'stopped'));
    assert.equal(result.tools?.some(tool => tool.status === 'done'), false);
});

for (const kind of ['EMPTY_FINAL', 'ABSENT_FINAL']) runTest(`${kind} never promotes commentary or partial final into MESSAGE`, async () => {
    const opts = options(), result = await spawnAgent(kind, opts).promise;
    assert.equal(result.code, 0); assert.equal(result.text, '');
    assert.equal(result.runtimeOutcome?.finalText, kind === 'EMPTY_FINAL' ? '' : null);
    assert.ok(assistantRows(opts.chatSessionId).every((row: any) => !row.content.includes('COMMENTARY') && !row.content.includes('CLAUDE_FINAL')));
});

runTest('Stop steer writes interrupted salvage before the captured exit-settle barrier resolves', async () => {
    const opts = options(), watermark = getMaxMessageId(opts.chatSessionId);
    let barrier: Promise<void> | undefined, salvage: string | null | undefined;
    const off = subscribe(event => {
        if (event.event !== 'agent_runtime' || event.data['kind'] !== 'message' || barrier) return;
        assert.equal(killActiveAgent(opts.scopeKey, 'steer'), true);
        barrier = waitForExitSettled(opts.scopeKey).then(() => { salvage = getSteerSalvageAfter(opts.chatSessionId, watermark); });
    });
    try {
        const result = await spawnAgent('HOLD_NATIVE_FIXTURE', opts).promise;
        assert.ok(barrier); await barrier;
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(salvage, '⏹️ [interrupted]\n\nPRE-TOOL COMMENTARY');
        assert.equal(activeMainProcesses.has(opts.scopeKey), false); assert.equal(hasClaudeRuns(opts.scopeKey), false);
    } finally { off(); }
});

runTest('explicit scope/chat binding survives multi-session off', async () => {
    config.settings.multiSession.enabled = false;
    const opts = { ...options(), origin: 'heartbeat', scopeKey: 'mention-watch:claude-fixture' };
    assert.equal((await spawnAgent('fixture', opts).promise).text, 'CLAUDE_FINAL');
    assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }]);
});

runTest('generation invalidated during pending factory cannot attach or write a user message', async () => {
    const entered = deferred(), gate = deferred(), opts = options();
    beforeFactory = async () => { entered.resolve(); await gate.promise; };
    const run = spawnAgent('stale owner', opts); await entered.promise;
    bumpScopeSessionGeneration(opts.scopeKey); gate.resolve();
    assert.notEqual((await run.promise).code, 0);
    assert.deepEqual(db.prepare('SELECT role FROM messages WHERE session_id=?').all(opts.chatSessionId), []);
    assert.equal(activeMainProcesses.has(opts.scopeKey), false);
});

runTest('pending main factory cancellation settles logically but retains scoped and global cleanup waits', async () => {
    const entered = deferred(), gate = deferred(), opts = options();
    const events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    let factorySettled = false, mainDone = false, scopedDone = false, shutdownDone = false;
    const waits: Promise<void>[] = [];
    beforeFactory = async () => { entered.resolve(); await gate.promise; };
    const run = spawnAgent('pending main factory', opts);
    try {
        await entered.promise;
        const creation = Promise.all(factoryDone).then(() => { factorySettled = true; });
        assert.equal(activeMainProcesses.has(opts.scopeKey), true); assert.equal(hasClaudeRuns(opts.scopeKey), true);
        assert.equal(killActiveAgent(opts.scopeKey, EXPLICIT_USER_STOP_KILL_REASON), true);
        const result = await run.promise;
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(result.stopCause, 'user_stop');
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
        assert.equal(factorySettled, false); assert.equal(queries.length, 0);
        waits.push(waitForMainProcessEnd(opts.scopeKey, 2000).then(() => { mainDone = true; }));
        waits.push(waitForProcessEnd(opts.scopeKey, 2000).then(() => { scopedDone = true; }));
        waits.push(waitForAllProcessesEnd(2000).then(() => { shutdownDone = true; }));
        // A microtask checkpoint can expose an immediate return but cannot run
        // the waiters' polling/deadline timers. No wall-time success inference.
        await Promise.resolve();
        assert.equal(hasClaudeRuns(opts.scopeKey), true, 'main control must survive logical map removal until factory cleanup');
        assert.equal(mainDone, false, 'main-only wait must include retained main acquisition cleanup');
        assert.equal(scopedDone, false); assert.equal(shutdownDone, false);
        assert.ok(result.traceRunId); assertTerminalOrder(events, result.traceRunId);
        const terminal = structuredClone(events);
        gate.resolve(); await creation; await Promise.all(waits);
        assert.equal(hasClaudeRuns(opts.scopeKey), false); assert.equal(factorySettled, true);
        assert.equal(mainDone, true);
        assert.equal(scopedDone, true); assert.equal(shutdownDone, true);
        assert.equal(inputs.length, 1); assert.equal(sessions.length, 0); assert.equal(queries.length, 0);
        assert.deepEqual(assistantRows(opts.chatSessionId), []); assert.deepEqual(events, terminal);
        assert.strictEqual(await run.promise, result);
    } finally {
        gate.resolve(); killActiveAgent(opts.scopeKey, 'user');
        await run.promise; await Promise.all(factoryDone);
        for (const session of sessions) await session.close();
        for (const query of queries) {
            await query.done;
            assert.ok(query.child.exitCode !== null || query.child.signalCode !== null);
        }
        await Promise.all(waits); off();
    }
});

for (const stage of ['acquire', 'ready', 'settle'] as const) runTest(`${stage} failure wakes one queued follow-up through actual spawn and lifecycle`, async t => {
    const opts = { ...options(), _isSmokeContinuation: false }, entered = deferred(), gate = deferred(), completed = deferred();
    beforeFactory = async () => {
        if (inputs.length !== 1) return;
        entered.resolve(); await gate.promise;
        if (stage === 'acquire') throw new Error('fixture acquire failed');
    };
    if (stage !== 'acquire') {
        const statement = stage === 'ready' ? database.insertMessage : database.insertMessageWithTraceRun;
        const original = statement.run; let first = true;
        t.mock.method(statement, 'run', function (...args: any[]) {
            if (first) { first = false; throw new Error('fixture insert failed'); }
            return Reflect.apply(original, statement, args);
        });
    }
    const requestId = 'queued-' + opts.requestId, terminals: any[] = [], events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => {
        events.push({ type: event.event, data: event.data });
        if (event.event === 'orchestrate_done' && event.data['requestId'] === requestId) { terminals.push(event.data); completed.resolve(); }
    });
    let queueId: string | undefined;
    try {
        const first = spawnAgent('first native run', opts); await entered.promise;
        queueId = enqueueMessage('queued fixture', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId, requestId });
        gate.resolve(); const failed = await first.promise; assert.notEqual(failed.code, 0);
        assert.ok(failed.traceRunId); assertTerminalOrder(events, failed.traceRunId);
        await completed.promise; await waitForProcessEnd(opts.scopeKey, 2000);
        assert.equal(terminals.length, 1); assert.equal(terminals[0].text, 'CLAUDE_FINAL');
        assert.equal(messageQueue.some(item => item.id === queueId), false); assert.equal(inputs.length, 2);
    } finally { gate.resolve(); off(); if (queueId && messageQueue.some(item => item.id === queueId)) removeQueuedMessage(queueId); }
});

for (const failure of ['malformed image', 'lifecycle throw']) runTest(`${failure} leaves neither a running trace nor live run`, async () => {
    const opts = options(), statuses: any[] = [];
    const events: Array<{ type: string; data: Record<string, any> }> = [];
    if (failure === 'lifecycle throw') beforeLifecycle = async () => { throw new Error('fixture lifecycle failure'); };
    const off = subscribe(event => {
        events.push({ type: event.event, data: event.data });
        if (event.event === 'agent_status' && event.data['scope'] === opts.scopeKey) statuses.push(event.data);
    });
    try {
        const run = spawnAgent('failure fixture', { ...opts,
            ...(failure === 'malformed image' ? { images: [{ mimeType: 'image/invalid', data: 'broken' }] } : {}) });
        const result = await run.promise;
        assert.notEqual(result.code, 0); assert.ok(result.traceRunId);
        assertTerminalOrder(events, result.traceRunId);
        const recorded = trace.getTraceRun(result.traceRunId!);
        assert.equal(recorded?.status, 'error'); assert.ok(recorded?.finished_at);
        assert.equal(getLiveRun(opts.scopeKey).running, false); assert.equal(activeMainProcesses.has(opts.scopeKey), false);
        assert.equal(hasClaudeRuns(opts.scopeKey), false);
        assert.ok(statuses.some(value => value.running === true)); assert.ok(statuses.some(value => value.running === false));
        if (failure === 'malformed image') assert.equal(queries[0]!.messages.length, 0);
    } finally { off(); }
});

runTest('Stop before the acquisition microtask publishes one known fallback without input', async () => {
    const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const run = spawnAgent('never send', opts);
        assert.equal(killActiveAgent(opts.scopeKey, 'user'), true);
        const result = await run.promise;
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.ok(result.traceRunId); assertTerminalOrder(events, result.traceRunId);
        assert.equal(inputs.length, 0); assert.equal(queries.length, 0);
        assert.deepEqual(db.prepare('SELECT role FROM messages WHERE session_id=?').all(opts.chatSessionId), []);
        assert.equal(trace.getTraceRun(result.traceRunId)?.status, 'interrupted');
    } finally { off(); }
});

runTest('failed fallback recording still returns one diagnostic without a fabricated canonical final', async () => {
    failJournal = true; const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    beforeFactory = async () => { throw new Error('owned acquisition failed'); };
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const result = await spawnAgent('no SDK input', opts).promise;
        assert.equal(result.runtimeOutcome?.status, 'error'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(events.filter(event => event.type === 'agent_runtime').length, 0);
        assert.equal(events.filter(event => event.type === 'agent_runtime_gap').length, 1);
        assert.equal(events.filter(event => event.type === 'agent_done').length, 1);
        assert.equal(trace.getTraceRun(result.traceRunId!)?.status, 'error');
        assert.equal(queries.length, 0); assert.deepEqual(assistantRows(opts.chatSessionId), []);
    } finally { off(); }
});

runTest('journal failure still persists interrupted salvage before the actual exit-settle barrier', async () => {
    failJournal = true; const opts = options(), watermark = getMaxMessageId(opts.chatSessionId);
    let barrier: Promise<void> | undefined, salvage: string | null | undefined;
    beforeFixtureResume = async () => {
        // The async query has already yielded the parent frame here.
        assert.equal(killActiveAgent(opts.scopeKey, 'steer'), true);
        barrier = waitForExitSettled(opts.scopeKey).then(() => { salvage = getSteerSalvageAfter(opts.chatSessionId, watermark); });
    };
    const result = await spawnAgent('HOLD_PARTIAL_PROGRESS', opts).promise;
    assert.ok(barrier); await barrier;
    assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
    assert.equal(result.runtimeOutcome?.partialText, 'PRE-TOOL COMMENTARY');
    assert.equal(salvage, '⏹️ [interrupted]\n\nPRE-TOOL COMMENTARY');
    assert.equal(hasClaudeRuns(opts.scopeKey), false);
});

runTest('optional SDK load failure ends explicit native mode without print or fallback', async () => {
    sdkMissing = true; const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const result = await spawnAgent('no SDK available', opts).promise;
        assert.equal(result.runtimeOutcome?.status, 'error'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(queries.length, 0); assert.ok(result.traceRunId); assertTerminalOrder(events, result.traceRunId);
        assert.equal(events.some(event => event.type === 'agent_fallback' || event.type === 'agent_output'), false);
        assert.deepEqual(assistantRows(opts.chatSessionId), []);
    } finally { off(); }
});

runTest('old failed terminalization closes its trace without replacing a foreign live tool list', async () => {
    const opts = options(), replacementTrace = 'replacement-' + opts.requestId;
    let oldTrace: string | undefined, replacement: ReturnType<typeof getLiveRun> | undefined;
    beforeLifecycle = async input => {
        oldTrace = input.ctx.traceRunId;
        assert.ok(oldTrace); assert.equal(getLiveRun(opts.scopeKey).traceRunId, oldTrace);
        assert.ok(input.ctx.toolLog.some(tool => tool.label === 'Read'), 'old run must have tools available to overwrite the replacement');
        beginLiveRun(opts.scopeKey, 'claude'); setLiveRunTraceId(opts.scopeKey, replacementTrace);
        replaceLiveRunTools(opts.scopeKey, [{ icon: 'x', label: 'replacement-only tool', toolType: 'tool',
            status: 'running', detail: 'owned by the replacement trace' }]);
        replacement = getLiveRun(opts.scopeKey);
        throw new Error('fixture lifecycle failed after live ownership changed');
    };
    try {
        const result = await spawnAgent('old run with tool output', opts).promise;
        assert.notEqual(result.code, 0); assert.equal(result.traceRunId, oldTrace);
        assert.ok(oldTrace); assert.ok(replacement);
        const closed = trace.getTraceRun(oldTrace);
        assert.equal(closed?.status, 'error'); assert.ok(closed?.finished_at);
        assert.deepEqual(getLiveRun(opts.scopeKey), replacement);
        assert.equal(getLiveRun(opts.scopeKey).running, true);
        assert.deepEqual(getLiveRun(opts.scopeKey).toolLog.map(tool => tool.label), ['replacement-only tool']);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false); assert.equal(hasClaudeRuns(opts.scopeKey), false);
    } finally {
        if (getLiveRun(opts.scopeKey).traceRunId === replacementTrace) clearLiveRun(opts.scopeKey);
    }
});
