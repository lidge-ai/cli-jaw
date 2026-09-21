import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { EXPLICIT_USER_STOP_KILL_REASON } from '../../src/agent/spawn/kill-reason.ts';

const home = process.env['CLI_JAW_HOME']!;
const script = join(home, 'print-provider.mjs');
writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{
 const frames=[
  {type:'thread.started',thread_id:'provider-private-id'},
  {type:'item.completed',item:{type:'agent_message',text:'kept commentary',channel:'commentary'}},
  {type:'item.completed',item:{id:'tool-1',type:'command_execution',command:'echo fixture',status:'completed',exit_code:0,aggregated_output:'fixture'}},
  {type:'item.completed',item:{type:'agent_message',text:process.env.PRINT_FIXTURE_HOLD ? 'PRINT_PARTIAL_SENTINEL' : 'print fixture final'}}
 ];process.stderr.write('stderr-not-an-assistant-message\\n');
 for(const frame of frames)process.stdout.write(JSON.stringify(frame)+'\\n');
 if(process.env.PRINT_FIXTURE_HOLD)setTimeout(()=>process.exit(91),10000);
});`);
let launches = 0;
let launchError = false;
let hold = false;
let captureHeldChild: ((child: childProcess.ChildProcess) => void) | undefined;
async function withHeldProvider<T>(body: () => Promise<T>): Promise<T> {
    let child: childProcess.ChildProcess | undefined;
    const closed = Promise.withResolvers<void>();
    hold = true;
    captureHeldChild = value => { child = value; value.once('close', () => closed.resolve()); };
    try { return await body(); }
    finally {
        hold = false; captureHeldChild = undefined;
        if (child) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([closed.promise, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('held fixture child did not close')), 2000);
                })]);
            } finally { clearTimeout(timer); }
            assert.ok(child.exitCode !== null || child.signalCode !== null, 'physical child must be reaped');
        }
    }
}
test.mock.module('node:child_process', { namedExports: { ...childProcess,
    spawn: (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, process.execPath, 'no provider process may launch');
        assert.deepEqual(args, [script]); launches++;
        if (launchError) return childProcess.spawn(join(home, 'missing-fixture-runtime'), [], options);
        const child = childProcess.spawn(command, [...args], { ...options,
            env: { ...options.env, ...(hold ? { PRINT_FIXTURE_HOLD: '1' } : {}) } });
        captureHeldChild?.(child);
        return child;
    },
} });
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }),
} });
const argsModule = await import('../../src/agent/args.ts');
test.mock.module('../../src/agent/args.js', { namedExports: { ...argsModule,
    buildArgs: () => [script], buildResumeArgs: () => [script],
} });
const { spawnAgent, killActiveAgent, waitForExitSettled, activeMainProcesses, activeProcesses } = await import('../../src/agent/spawn.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
const { db } = await import('../../src/core/db.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');

test('real print child traverses spawn, accepted parser, lifecycle and durable journal with captured identity', { timeout: 15_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    config.settings.workingDir = home;
    config.settings.cli = 'codex'; config.settings.memory.enabled = false;
    config.settings.multiSession.enabled = false; config.settings.activeOverrides = {}; config.settings.fallbackOrder = [];
    config.settings.perCli.codex = { model: 'fixture', effort: '' };
    mkdirSync(join(home, 'prompts'), { recursive: true });
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(event => seen.push(event));
    const owner = createChatSession('captured-print-owner');
    const scope = 'captured-print-scope';
    setActiveChatSession('default');
    try {
        const run = spawnAgent('fixture input', { cli: 'codex', model: 'fixture', sysPrompt: 'fixture system',
            scopeKey: scope, chatSessionId: owner.id, origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true });
        const result = await run.promise;
        assert.equal(result.code, 0); assert.equal(launches, 1);
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start')!;
        assert.ok(start);
        const runId = String(start.data['runId']);
        const replay = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        assert.equal(replay.incomplete, false);
        const end = replay.events.at(-1); assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, 'print fixture final');
        assert.ok(replay.events.some(e => e.kind === 'message' && e.phase === 'commentary' && e.text === 'kept commentary'));
        assert.ok(!JSON.stringify(replay).includes('provider-private-id'));
        assert.ok(!JSON.stringify(replay).includes('stderr-not-an-assistant-message'));
        for (const packet of seen.filter(e => e.event === 'agent_output' || e.event === 'agent_tool')) {
            assert.equal(packet.data['traceRunId'], runId);
            assert.equal(packet.data['sessionId'], owner.id); assert.equal(packet.data['scope'], scope);
        }
        assert.ok(seen.some(e => e.event === 'agent_output'));
        assert.ok(seen.some(e => e.event === 'agent_tool'));
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND trace_run_id=?").get(runId) as { n: number }).n, 1);
        assert.equal(activeMainProcesses.size, 0); assert.equal(activeProcesses.size, 0);
    } finally { unsubscribe(); }
});

for (const reason of ['user', 'steer', EXPLICIT_USER_STOP_KILL_REASON]) test(`held print ${reason} preserves legacy MESSAGE and closes Activity once`, { timeout: 15_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const owner = createChatSession(`print-${reason}-owner`);
    const scope = `print-${reason}-scope`;
    setActiveChatSession('default');
    const beforeDefault = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND session_id='default'").get();
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const accepted = Promise.withResolvers<void>();
    let capturedRunId: string | undefined;
    const unsubscribe = subscribe(event => {
        if (event.event === 'agent_runtime' && event.data['kind'] === 'turn-start'
            && event.data['scope'] === scope && event.data['sessionId'] === owner.id) capturedRunId = String(event.data['runId']);
        if (event.data['scope'] !== scope && (!capturedRunId || event.data['traceRunId'] !== capturedRunId)) return;
        seen.push(event);
        if (event.event === 'agent_output' && typeof event.data['text'] === 'string'
            && event.data['text'].includes('PRINT_PARTIAL_SENTINEL')) accepted.resolve();
    });
    t.after(unsubscribe);
    await withHeldProvider(async () => {
        const run = spawnAgent('held fixture input', { cli: 'codex', model: 'fixture', sysPrompt: 'fixture system',
            scopeKey: scope, chatSessionId: owner.id, origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true });
        const rows = () => db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id);
        const expected = reason === 'user' ? 'PRINT_PARTIAL_SENTINEL' : '⏹️ [interrupted]\n\nPRINT_PARTIAL_SENTINEL';
        await Promise.race([accepted.promise, run.promise.then(() => { throw new Error('child ended before accepted partial'); })]);
        assert.equal(killActiveAgent(scope, reason), true);
        const barrier = reason === 'steer' ? waitForExitSettled(scope).then(() => {
            assert.deepEqual(rows(), [{ content: expected }], 'salvage must already exist when the barrier releases');
            assert.equal(seen.filter(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-end').length, 1);
        }) : Promise.resolve();
        await barrier;
        const result = await run.promise;
        assert.equal(result.text, 'PRINT_PARTIAL_SENTINEL', 'legacy return text is not the prefixed MESSAGE');
        assert.equal(result.stopCause, reason === 'steer' ? 'steer_kill' : 'user_stop');
        assert.deepEqual(rows(), [{ content: expected }]);
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start');
        assert.ok(start);
        const runId = String(start.data['runId']);
        for (const event of seen.filter(e => e.event === 'agent_runtime')) {
            assert.equal(event.data['runId'], runId); assert.equal(event.data['scope'], scope); assert.equal(event.data['sessionId'], owner.id);
        }
        const replay = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 });
        assert.ok(replay); assert.equal(replay.incomplete, false);
        const ends = replay.events.filter(e => e.kind === 'turn-end');
        assert.equal(ends.length, 1); assert.equal(ends[0]!.status, 'stopped'); assert.equal(ends[0]!.finalText, expected);
        const done = seen.filter(e => e.event === 'agent_done');
        assert.equal(done.length, 1); assert.equal(done[0]!.data['text'], expected);
        assert.equal(done[0]!.data['traceRunId'], runId);
        for (const event of seen.filter(e => e.event === 'agent_output')) {
            assert.equal(event.data['sessionId'], owner.id); assert.equal(event.data['traceRunId'], runId);
        }
        assert.doesNotMatch(JSON.stringify(replay), /provider-private-id|stderr-not-an-assistant-message/);
        assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND session_id='default'").get(), beforeDefault);
        assert.equal(activeMainProcesses.has(scope), false); assert.equal(activeProcesses.size, 0);
    });
});

test('held fixture setup failure still resets mode and awaits physical child close', { timeout: 5000 }, async () => {
    const { spawn } = await import('node:child_process');
    let child: childProcess.ChildProcess | undefined;
    let physicallyClosed = false;
    await assert.rejects(withHeldProvider(async () => {
        child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('close', () => { physicallyClosed = true; });
        throw new Error('controlled setup failure before application handle');
    }), /controlled setup failure/);
    assert.ok(child); assert.equal(physicallyClosed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(hold, false); assert.equal(captureHeldChild, undefined);
});

test('EG-007a: real print error reentry and close settle only once and close the journal', { timeout: 15_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    launchError = true;
    const before = launches;
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(event => seen.push(event));
    try {
        let child: childProcess.ChildProcess | null = null;
        let exits = 0;
        const run = spawnAgent('fixture error', { cli: 'codex', model: 'fixture', sysPrompt: 'fixture system', origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true,
            lifecycle: { onExit: () => { exits++; assert.ok(child); child.emit('error', new Error('reentrant fixture')); } },
        });
        child = run.child;
        const result = await run.promise;
        assert.equal(result.code, 127); assert.equal(launches, before + 1);
        assert.equal(exits, 1, 'settled guard precedes any reentrant lifecycle callback');
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start')!;
        assert.ok(start);
        const p = readActivityPage({ runId: String(start.data['runId']), sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(p.status, 'error');
        assert.equal(p.events.at(-1)?.kind, 'turn-end');
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal(activeMainProcesses.size, 0);
    } finally { launchError = false; unsubscribe(); }
});
