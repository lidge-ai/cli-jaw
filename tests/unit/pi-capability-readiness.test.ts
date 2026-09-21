import '../setup/isolated-home.ts';
import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as cp from 'node:child_process';
import { Socket } from 'node:net';
import { setImmediate as turn } from 'node:timers/promises';
import type { PiExecutionCleanupReceipt, PiPromptResult } from '../../src/agent/pi-runtime.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;

type Row = { role: string; kind: string; pid?: number; request?: { type: string; message?: string }; [key: string]: unknown };
type Tracked = { child: cp.ChildProcess; role: string; closed: boolean; exited: boolean; revoked: boolean;
    done: Promise<void>; lateSignals: number; stdout: string; signals: Array<{ signal: string | number; at: number }> };
type Owner = { bin: string; root: string; config: Record<string, unknown>; children: Tracked[]; syncCloses: number;
    observers: Set<() => void>; clock: () => number; disposing: boolean; settlements: Promise<unknown>[] };
let current: Owner | null = null;
function track(owner: Owner, child: cp.ChildProcess, role: string): Tracked {
    let closed!: () => void;
    const notify = () => { for (const observe of owner.observers) observe(); };
    const entry: Tracked = { child, role, closed: false, exited: false, revoked: false,
        done: new Promise<void>(resolve => { closed = resolve; }), lateSignals: 0, stdout: '', signals: [] };
    owner.children.push(entry);
    child.once('exit', () => { entry.revoked = true; entry.exited = true; notify(); });
    child.once('error', () => { entry.revoked = true; notify(); });
    child.once('close', () => { entry.revoked = true; entry.closed = true; closed(); notify(); });
    child.stdout?.on('data', chunk => { entry.stdout = (entry.stdout + String(chunk)).slice(0, 4096); notify(); });
    const kill = child.kill.bind(child);
    child.kill = signal => {
        if (entry.revoked) { entry.lateSignals++; return false; }
        entry.signals.push({ signal: signal ?? 'SIGTERM', at: owner.clock() });
        return kill(signal);
    };
    return entry;
}
// Real children and real close events. Only the command boundary is observed;
// no capability result, accumulator, session, or readiness API is substituted.
mock.module('node:child_process', { namedExports: { ...cp,
    spawn: (file: string, args: readonly string[], options: cp.SpawnOptions) => {
        assert.ok(current && (file === current.bin || file === 'npm' && current.config.npmFallback
            && options.env?.PATH?.startsWith(path.join(current.root, 'bin') + path.delimiter)), 'only the owned Pi fixture may spawn');
        const owner = current, role = args.includes('--version') ? 'version' : 'rpc';
        if (file === 'pi') assert.ok(owner.config.pathSelection
            && options.env?.PATH?.split(path.delimiter)[0] === path.dirname(String(owner.config.pathBinary)), 'PATH must select the owned target');
        if (role === 'version' && owner.config.versionSpawnThrow) throw new Error('owned version spawn setup failure');
        const executable = role === 'version' && owner.config.versionSpawnError ? path.join(owner.root, 'missing-executable') : file;
        assert.ok(Array.isArray(options.stdio));
        const child = cp.spawn(executable, [...args], { ...options, stdio: [...options.stdio, 'ipc'] });
        const entry = track(owner, child, role);
        child.on('message', (message: unknown, handle: cp.SendHandle) => {
            if (!message || typeof message !== 'object' || !('holdPipe' in message)) return;
            assert.ok(handle instanceof Socket, 'fixture must transfer its actual stdout endpoint');
            if (owner.disposing) { handle.destroy(); return; }
            const holder = cp.spawn(process.execPath, [fixtureSource, '--pipe-holder'], {
                cwd: owner.root, env: { ...options.env, PI_CAPABILITY_FIXTURE_DIR: owner.root },
                stdio: ['ignore', handle, 'pipe', 'ipc'],
            });
            track(owner, holder, 'holder'); handle.destroy();
            holder.once('message', () => {
                if (!entry.revoked && child.connected) child.send({ holderReady: true }, () => {});
            });
        });
        if (role === 'rpc' && owner.config.stdinWriteFailure) {
            assert.ok(child.stdin);
            const originalWrite = child.stdin.write.bind(child.stdin);
            const failure = owner.config.stdinWriteFailure;
            child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
                const promptOnly = failure === 'prompt';
                if (!promptOnly || String(chunk).includes('"type":"prompt"')) {
                    throw new Error(promptOnly ? 'owned prompt stdin write failure' : 'owned post-spawn stdin write failure');
                }
                owner.config.promptPreludeWriteSeen = true;
                return Reflect.apply(originalWrite, child.stdin, [chunk, ...args]) as boolean;
            }) as typeof child.stdin.write;
        }
        return child;
    },
    spawnSync: (file: string, args: readonly string[], options: cp.SpawnSyncOptions) => {
        assert.ok(current && (file === current.bin || file === 'pi' && current.config.npmFallback) && args.includes('--version'), 'no ambient CLI discovery/install');
        if (file === 'pi' && current.config.pathSelection) assert.equal(options.env?.PATH?.split(path.delimiter)[0], path.dirname(String(current.config.pathBinary)));
        const result = cp.spawnSync(file === 'pi' && current.config.npmFallback ? path.join(current.root, 'bin/pi') : file, [...args],
            current.config.pathSelection ? { ...options, env: { ...options.env, PI_CAPABILITY_AVAILABILITY: 'owned-path-probe' } } : options);
        assert.equal(result.error, undefined, 'primary RED must be the fixture self-deadline, not failed spawn');
        assert.notEqual(result.status, null); current.syncCloses++;
        return result;
    },
} });

const { spawnPiRpc, spawnPersistentPiRpc, DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS } = await import('../../src/agent/pi-runtime.ts');
const { JAW_HOME } = await import('../../src/core/config.ts');
const { piFailureOutcome } = await import('../../src/agent/runtime/pi-turn.ts');
const fixtureSource = path.resolve(import.meta.dirname, '../fixtures/pi-capability-child.mjs');
function fixture(config: Record<string, unknown> = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-capability-owned-')));
    const bin = path.join(root, 'pi.mjs'); fs.copyFileSync(fixtureSource, bin); fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(root, 'events.ndjson'), '');
    const prior = { PI_CODING_AGENT_BIN: process.env.PI_CODING_AGENT_BIN,
        PI_CAPABILITY_FIXTURE_DIR: process.env.PI_CAPABILITY_FIXTURE_DIR,
        PI_CAPABILITY_SENTINEL: process.env.PI_CAPABILITY_SENTINEL, PATH: process.env.PATH };
    process.env.PI_CODING_AGENT_BIN = bin; process.env.PI_CAPABILITY_FIXTURE_DIR = root;
    const owner: Owner = { bin, root, config, children: [], syncCloses: 0, observers: new Set(), clock: () => Date.now(), disposing: false, settlements: [] }; current = owner;
    fs.rmSync(path.join(JAW_HOME, 'pi', 'rpc-capabilities.json'), { force: true });
    const rows = (): Row[] => fs.readFileSync(path.join(root, 'events.ndjson'), 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
    const release = () => fs.writeFileSync(path.join(root, 'release-version'), 'release');
    const wait = async (check: () => boolean) => {
        if (check()) return;
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: unknown) => { watcher.close(); owner.observers.delete(inspect); realClearTimeout(timer); error ? reject(error) : resolve(); };
            const inspect = () => { try { if (check()) finish(); } catch (error) { finish(error); } };
            const watcher = fs.watch(root, inspect);
            const timer = realSetTimeout(() => finish(new Error('owned fixture observation deadline')), 6000);
            owner.observers.add(inspect);
            inspect();
        });
    };
    const receipt = () => {
        const dir = path.join(JAW_HOME, 'pi'); fs.mkdirSync(dir, { recursive: true });
        const version = `${config.version ?? '0.83.0'}\n\n${config.warning ?? ''}`.trim();
        fs.writeFileSync(path.join(dir, 'rpc-capabilities.json'), JSON.stringify({ schemaVersion: 1,
            profileId: DEFAULT_PI_PROFILE.id, abortEffective: true, probedAt: new Date().toISOString(),
            commandId: JSON.stringify({ source: 'env', command: bin, baseArgs: [], version }) }));
    };
    const releaseHolders = () => {
        for (const entry of owner.children) if (entry.role === 'holder' && !entry.revoked && entry.child.connected)
            entry.child.send({ release: true }, () => {});
    };
    return { root, bin, owner, rows, release, releaseHolders, wait, receipt,
        configure(patch: Record<string, unknown>) { Object.assign(config, patch); fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(config)); },
        options: { model: 'fixture-model', cwd: root, root: path.join(root, 'runtime') },
        async dispose() {
            owner.disposing = true; release(); releaseHolders();
            for (const entry of owner.children) if (!entry.revoked) entry.child.kill('SIGTERM');
            let timer: ReturnType<typeof setTimeout> | undefined;
            const escalation = realSetTimeout(() => {
                for (const entry of owner.children) if (!entry.revoked) entry.child.kill('SIGKILL');
            }, 1000);
            try {
                await Promise.race([(async () => {
                    await Promise.all(owner.children.map(e => e.done)); await Promise.all(owner.settlements);
                })(), new Promise<never>((_, reject) => {
                    timer = realSetTimeout(() => reject(new Error(`unknown fixture close; retain ${root}`)), 4000);
                })]);
                assert.ok(owner.children.every(e => e.closed));
                assert.equal(owner.children.reduce((n, e) => n + e.lateSignals, 0), 0, 'no post-exit retained-handle signal');
                fs.rmSync(root, { recursive: true });
            } finally {
                realClearTimeout(timer); realClearTimeout(escalation); current = null;
                for (const [key, value] of Object.entries(prior)) {
                    if (value === undefined) delete process.env[key]; else process.env[key] = value;
                }
            }
        },
    };
}

type Fixture = ReturnType<typeof fixture>;
type Mode = 'persistent' | 'direct';
type Direct = ReturnType<typeof spawnPiRpc> & { cleanup: Promise<PiExecutionCleanupReceipt> };
function observe<T>(promise: Promise<T>) {
    let settled = false;
    const done = promise.then(value => { settled = true; return { value, error: undefined }; },
        (error: unknown) => { settled = true; return { value: undefined, error }; });
    return { done, get settled() { return settled; } };
}
function start(f: Fixture, mode: Mode, prompt = 'owned prompt') {
    const raw: unknown[] = [], text: string[] = [];
    const onRawRecord = (row: unknown) => { raw.push(row); for (const notify of f.owner.observers) notify(); };
    const onEvent = (event: { kind: string; text?: string }) => { if (event.kind === 'text') text.push(event.text!); };
    const session = mode === 'persistent' ? spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, f.options) : undefined;
    const execution = session ? undefined : spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS,
        { ...f.options, prompt, onRawRecord, onEvent }) as Direct;
    const child = session?.child ?? execution!.child;
    const deliveryOrder: string[] = [];
    if (execution) {
        void execution.cleanup.then(() => { deliveryOrder.push('cleanup'); });
        void execution.done.then(() => { deliveryOrder.push('done'); }, () => { deliveryOrder.push('done'); });
    }
    const pending = observe(session ? session.sendPrompt(prompt, { onRawRecord, onEvent }) : execution!.done);
    f.owner.settlements.push(pending.done);
    return { session, execution, child, pending, raw, text, deliveryOrder,
        send(rows: unknown[]) { child.stdin!.write(JSON.stringify({ type: 'test_rows', rows }) + '\n'); },
    };
}
function outcome(result: { value: PiPromptResult | undefined; error: unknown }): RuntimeTurnOutcome {
    const value = result.error === undefined ? result.value?.runtimeOutcome : piFailureOutcome(result.error);
    assert.ok(value, 'result/error must carry the real typed Pi outcome'); return value;
}
const prompts = (f: Fixture) => f.rows().filter(r => r.kind === 'request' && r.request?.type === 'prompt');
const ends = (raw: unknown[]) => raw.some(r => r && typeof r === 'object' && 'type' in r && r.type === 'agent_end');
const assistant = (text: string | null, stopReason = 'stop') => ({ role: 'assistant', stopReason,
    content: text === null ? [] : [{ type: 'text', text }] });
const end = (text: string | null, stopReason = 'stop', willRetry = false) =>
    ({ type: 'agent_end', messages: [assistant(text, stopReason)], willRetry });
async function owned(config: Record<string, unknown>, body: (f: Fixture) => Promise<void>) {
    const f = fixture(config);
    try { await body(f); } finally { await f.dispose(); }
}
function controlledClock(t: TestContext, f: Fixture) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0;
    const timers: Array<{ ms: number; at: number; fired: boolean }> = [];
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
        const entry = { ms, at: now, fired: false }; timers.push(entry);
        for (const notify of f.owner.observers) notify();
        return schedule(() => { entry.fired = true; fn(...args); }, ms);
    }) as typeof setTimeout);
    f.owner.clock = () => now;
    return { timers, tick(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}

test('P3/P4 preparing prompt reserves overlap, local abort sends no RPC abort and late readiness dispatches only its successor',
    { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({}, async f => {
        const r = start(f, 'persistent', 'cancelled A');
        await assert.rejects(r.session!.sendPrompt('overlap B'), /already active/);
        await f.wait(() => f.rows().some(x => x.role === 'version' && x.kind === 'start'));
        assert.equal(prompts(f).length, 0);
        await r.session!.abort();
        assert.deepEqual(outcome(await r.pending.done), { status: 'stopped', finalText: null, partialText: '' });
        assert.equal(f.rows().some(x => x.request?.type === 'abort'), false);
        const successor = observe(r.session!.sendPrompt('successor C')); f.owner.settlements.push(successor.done);
        f.release();
        assert.equal(outcome(await successor.done).finalText, 'FINAL_ONLY');
        assert.deepEqual(prompts(f).map(x => x.request?.message), ['successor C']);
        assert.equal(f.rows().filter(x => x.role === 'version' && x.kind === 'start').length, 1);
        await Promise.resolve(r.session!.close());
    }));

for (const mode of ['persistent', 'direct'] as const) for (const version of ['0.80.4', '0.83.0']) {
    test(`P6 ${mode} ${version} waits after end and accepts each continuation byte only once`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate', version,
            rows: [{ type: 'agent_start' }, { type: 'message_start', message: assistant('FIRST_ONLY') },
                { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'FIRST_ONLY' } },
                { type: 'message_end', message: assistant('FIRST_ONLY') }, end('FIRST_ONLY')] }, async f => {
            const r = start(f, mode); await f.wait(() => ends(r.raw)); await turn();
            assert.equal(r.pending.settled, false);
            if (r.session) await assert.rejects(r.session.sendPrompt('overlap'), /already active/);
            r.send([{ type: 'agent_start' }, { type: 'message_start', message: assistant('LAST_ONLY') },
                { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LAST_ONLY' } },
                { type: 'message_end', message: assistant('LAST_ONLY') }, end('LAST_ONLY'), { type: 'agent_settled' }]);
            assert.deepEqual(outcome(await r.pending.done), { status: 'done', finalText: 'LAST_ONLY', partialText: 'FIRST_ONLYLAST_ONLY' });
            assert.equal(r.text.join(''), 'FIRST_ONLYLAST_ONLY');
            await Promise.resolve(r.session?.close());
        }));
}

for (const mode of ['persistent', 'direct'] as const) for (const [version, versionStatus] of [
    ['0.80.3', 0], ['fake-pi 1.0.0', 0], ['0.83.0-preview', 0], ['0.83.0', 1],
] as const) {
    test(`P7 ${mode} completed ${version}/${versionStatus} retains legacy retry then typed stop semantics`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate', version, versionStatus,
            rows: [end('RETRY_ONLY', 'stop', true)] }, async f => {
            const r = start(f, mode); await f.wait(() => ends(r.raw)); await turn();
            assert.equal(r.pending.settled, false, 'willRetry:true is not terminal even in legacy mode');
            r.send([{ type: 'agent_start' }, end('LAST_ONLY')]);
            assert.deepEqual(outcome(await r.pending.done), { status: 'done', finalText: 'LAST_ONLY', partialText: 'RETRY_ONLYLAST_ONLY' });
            await Promise.resolve(r.session?.close());
        }));
}

for (const mode of ['persistent', 'direct'] as const) for (const [reason, status] of [
    ['aborted', 'stopped'], ['error', 'error'], ['length', 'error'], ['unknown', 'error'],
] as const) {
    test(`P7 ${mode} latest ${reason} never promotes an older successful final`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate',
            rows: [{ type: 'agent_end', messages: [assistant('OLD'), assistant('PARTIAL', reason)], willRetry: false },
                { type: 'agent_settled' }] }, async f => {
            const r = start(f, mode);
            assert.deepEqual(outcome(await r.pending.done), { status, finalText: null, partialText: 'OLDPARTIAL' });
            await Promise.resolve(r.session?.close());
        }));
}

for (const mode of ['persistent', 'direct'] as const) {
    test(`P4 ${mode} stop while preparing closes owned handles and cannot send a late prompt`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({}, async f => {
            const r = start(f, mode);
            await f.wait(() => f.owner.children.length === 2 && f.rows().some(x => x.role === 'version' && x.kind === 'start'));
            if (r.session) r.session.kill(); else r.child.kill('SIGTERM');
            const final = await r.pending.done;
            assert.deepEqual(outcome(final), { status: 'stopped', finalText: null, partialText: '' });
            f.release(); await turn();
            assert.equal(prompts(f).length, 0); assert.ok(f.owner.children.every(x => x.closed));
            if (r.session) { assert.equal(r.session.alive, false); await assert.rejects(r.session.sendPrompt('late')); }
            else assert.deepEqual(await r.execution!.cleanup, { rpc: 'closed', version: 'closed', cwdDisposition: 'removable', reason: null });
        }));

    test(`P8 ${mode} 15000ms observation deadline poisons before dispatch and owns one bounded cleanup`,
        { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'never', longDeadline: true }, async f => {
            const clock = controlledClock(t, f), r = start(f, mode);
            await f.wait(() => f.rows().filter(x => x.kind === 'start').length === 2);
            clock.tick(14999); assert.equal(r.pending.settled, false); assert.equal(prompts(f).length, 0);
            clock.tick(1);
            assert.equal(clock.timers.filter(x => x.ms === 15000 && x.fired).length, 1);
            await f.wait(() => clock.timers.some(x => x.ms === 2000));
            if (r.session) { assert.equal(r.session.alive, false); assert.equal(r.session.abortEffective, false); }
            assert.deepEqual(outcome(await r.pending.done), { status: 'error', finalText: null, partialText: '' });
            assert.ok(f.owner.children.every(x => x.closed)); assert.equal(prompts(f).length, 0);
            assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1, 'one shared drain, not one per process');
            f.release(); await turn();
            if (r.session) await assert.rejects(r.session.sendPrompt('poisoned late prompt'));
        }));
}

for (const mode of ['persistent', 'direct'] as const) for (const failure of ['overflow-stdout', 'overflow-stderr', 'spawn-error', 'spawn-throw', 'stdin-write', 'prompt-write']) {
    test(`P8 ${mode} ${failure} after owned launch is an asynchronous null-final failure, never a prompt`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({
            versionMode: failure.startsWith('overflow') ? failure : 'immediate',
            versionSpawnError: failure === 'spawn-error', versionSpawnThrow: failure === 'spawn-throw',
            stdinWriteFailure: failure === 'stdin-write' ? true : failure === 'prompt-write' ? 'prompt' : false,
        }, async f => {
            const r = start(f, mode); // Must return the actual RPC child, not throw after launch.
            assert.ok(r.child instanceof cp.ChildProcess);
            assert.deepEqual(outcome(await r.pending.done), { status: 'error', finalText: null, partialText: '' });
            assert.equal(prompts(f).length, 0); assert.ok(f.owner.children.every(x => x.closed));
            if (failure === 'prompt-write') {
                assert.equal(f.owner.config.promptPreludeWriteSeen, true,
                    'preparation write must pass before the prompt-only write failure');
            }
            assert.equal(r.text.join(''), '');
            if (r.session) { assert.equal(r.session.alive, false); assert.equal(r.session.abortEffective, false); await assert.rejects(r.session.sendPrompt('late')); }
            else {
                const receipt = await r.execution!.cleanup;
                assert.equal(receipt.cwdDisposition, 'removable');
                if (failure === 'spawn-throw') assert.deepEqual(receipt,
                    { rpc: 'closed', version: 'not-started', cwdDisposition: 'removable', reason: null });
            }
        }));
}

for (const mode of ['persistent', 'direct'] as const) {
    test(`P4 ${mode} unsolicited pre-dispatch final cannot complete the preparing reservation`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({
            unsolicited: [end('UNSOLICITED'), { type: 'agent_settled' }],
        }, async f => {
            const r = start(f, mode);
            await f.wait(() => f.owner.children.some(x => x.role === 'rpc' && x.stdout.includes('UNSOLICITED')));
            await turn(); assert.equal(r.pending.settled, false); assert.equal(prompts(f).length, 0);
            f.release(); assert.equal(outcome(await r.pending.done).finalText, 'FINAL_ONLY');
            assert.equal(r.text.join(''), 'FINAL_ONLY'); await Promise.resolve(r.session?.close());
        }));

    test(`P10 ${mode} replaced executable during preparation poisons old instance without dispatch`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({}, async f => {
            const r = start(f, mode);
            await f.wait(() => f.rows().some(x => x.role === 'version' && x.kind === 'ready'));
            fs.appendFileSync(f.bin, '\n// owned fixture executable changed during preparation\n');
            f.release(); assert.deepEqual(outcome(await r.pending.done), { status: 'error', finalText: null, partialText: '' });
            assert.equal(prompts(f).length, 0);
            if (r.session) { assert.equal(r.session.alive, false); await assert.rejects(r.session.sendPrompt('stale')); }
            f.configure({ versionMode: 'immediate' });
            const next = start(f, mode, 'fresh instance');
            assert.notEqual(next.child.pid, r.child.pid);
            assert.equal(outcome(await next.pending.done).finalText, 'FINAL_ONLY');
            assert.equal(f.rows().filter(x => x.role === 'version' && x.kind === 'start').length, 2);
            await Promise.resolve(next.session?.close());
        }));
}

test('P9/P10 one persistent observation serves two turns; new same-path instance observes changed version while old semantics stay captured',
    { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate', version: '0.83.0', rows: [end('FIRST_ONLY')] }, async f => {
        const old = start(f, 'persistent'); await f.wait(() => ends(old.raw));
        assert.equal(old.pending.settled, false); old.send([{ type: 'agent_settled' }]);
        assert.equal(outcome(await old.pending.done).finalText, 'FIRST_ONLY');
        f.configure({ version: '0.80.3', rows: [end('LAST_ONLY')] });
        const fresh = start(f, 'persistent');
        assert.notEqual(fresh.child.pid, old.child.pid);
        assert.equal(outcome(await fresh.pending.done).finalText, 'LAST_ONLY');
        old.raw.length = 0;
        const again = observe(old.session!.sendPrompt('second old turn', { onRawRecord: row => {
            old.raw.push(row); for (const notify of f.owner.observers) notify();
        } }));
        f.owner.settlements.push(again.done); await f.wait(() => ends(old.raw)); await turn();
        assert.equal(again.settled, false, 'old modern instance must not borrow the new legacy decision');
        old.send([{ type: 'agent_settled' }]); assert.equal(outcome(await again.done).finalText, 'FIRST_ONLY');
        assert.equal(f.rows().filter(x => x.role === 'version' && x.kind === 'start').length, 2);
        assert.equal(prompts(f).length, 3);
        await Promise.all([Promise.resolve(old.session!.close()), Promise.resolve(fresh.session!.close())]);
    }));

test('P11 version and RPC capture cwd/profile/env and direct options before asynchronous readiness',
    { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({}, async f => {
        process.env.PI_CAPABILITY_SENTINEL = 'captured-original';
        const options = { ...f.options, model: 'original-model', effort: 'low', sysPrompt: 'original system', prompt: 'original prompt' };
        const execution = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, options) as Direct;
        const pending = observe(execution.done); f.owner.settlements.push(pending.done);
        process.env.PI_CAPABILITY_SENTINEL = 'ambient-changed';
        options.model = 'changed-model'; options.effort = 'high'; options.sysPrompt = 'changed system'; options.prompt = 'changed prompt';
        await f.wait(() => f.rows().filter(x => x.kind === 'start').length === 2);
        const starts = f.rows().filter(x => x.kind === 'start');
        assert.deepEqual(starts.map(x => x.cwd), [f.root, f.root]);
        assert.deepEqual(starts.map(x => x.sentinel), ['captured-original', 'captured-original']);
        assert.ok(starts.every(x => x.profile === path.join(f.options.root, DEFAULT_PI_PROFILE.id)));
        assert.equal(prompts(f).length, 0); f.release();
        assert.equal(outcome(await pending.done).finalText, 'FINAL_ONLY');
        assert.deepEqual(prompts(f).map(x => x.request?.message), ['original system\n\noriginal prompt']);
        const rpc = starts.find(x => x.role === 'rpc')!;
        assert.ok(Array.isArray(rpc.args)); assert.equal(rpc.args[rpc.args.indexOf('--model') + 1], 'original-model');
        const requests = f.rows().filter(x => x.kind === 'request').map(x => x.request?.type);
        assert.deepEqual(requests.slice(0, 3), ['get_state', 'set_thinking_level', 'prompt']);
        assert.equal((await execution.cleanup).cwdDisposition, 'removable');
    }));

test('P13 TERM-ignoring owned handles escalate once at1000ms within one total2000ms cleanup budget',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'never', longDeadline: true, ignoreTerm: true, ignoreEof: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'persistent');
        await f.wait(() => f.rows().filter(x => x.kind === 'ready').length === 2);
        r.session!.kill();
        await f.wait(() => ['rpc', 'version'].every(role => f.rows().some(x => x.role === role && x.kind === 'term-ignored')));
        clock.tick(999); assert.equal(r.pending.settled, false);
        assert.ok(f.owner.children.every(x => !x.signals.some(s => s.signal === 'SIGKILL')));
        clock.tick(1);
        assert.deepEqual(outcome(await r.pending.done), { status: 'stopped', finalText: null, partialText: '' });
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
        assert.equal(clock.timers.filter(x => x.ms === 1000 && x.fired).length, 1);
        for (const entry of f.owner.children) {
            assert.equal(entry.closed, true); assert.equal(entry.lateSignals, 0);
            assert.equal(entry.signals.filter(x => x.signal === 'SIGKILL').length, 1);
            assert.equal(entry.signals.find(x => x.signal === 'SIGKILL')!.at, 1000);
        }
        clock.tick(1000); assert.ok(f.owner.children.every(x => x.lateSignals === 0));
    }));

test('P13 direct raw cancellation starts paired cleanup and1000ms escalation while both owned handles ignore TERM',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'never', longDeadline: true, ignoreTerm: true, ignoreEof: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'direct');
        await f.wait(() => f.rows().filter(x => x.kind === 'ready').length === 2);
        assert.equal(r.child.kill('SIGTERM'), true);
        await f.wait(() => f.rows().some(x => x.role === 'rpc' && x.kind === 'term-ignored'));
        clock.tick(999); assert.equal(r.pending.settled, false);
        clock.tick(1); await turn();
        const proof = { cleanupTimers: clock.timers.filter(x => x.ms === 2000),
            escalationTimers: clock.timers.filter(x => x.ms === 1000),
            handles: f.owner.children.map(x => ({ role: x.role, exited: x.exited, closed: x.closed, signals: x.signals })),
            prompts: prompts(f).length, resultSettled: r.pending.settled };
        console.log('P13_DIRECT_CANCELLATION_PROOF', JSON.stringify(proof));
        assert.equal(proof.cleanupTimers.length, 1, 'direct cancellation must start the paired2000ms cleanup owner before RPC exit');
        assert.equal(proof.escalationTimers.filter(x => x.fired).length, 1);
        for (const entry of f.owner.children) {
            assert.equal(entry.signals.filter(x => x.signal === 'SIGKILL' && x.at === 1000).length, 1);
        }
        assert.deepEqual(outcome(await r.pending.done), { status: 'stopped', finalText: null, partialText: '' });
        assert.deepEqual(await r.execution!.cleanup, { rpc: 'closed', version: 'closed', cwdDisposition: 'removable', reason: null });
        assert.equal(prompts(f).length, 0);
    }));

test('version output and exit with a real held stdout pipe cannot dispatch until actual close',
    { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'pipe-held' }, async f => {
        const r = start(f, 'direct');
        await f.wait(() => f.owner.children.some(x => x.role === 'version' && x.exited));
        const version = f.owner.children.find(x => x.role === 'version')!;
        assert.equal(version.closed, false); assert.ok(version.stdout.includes('0.83.0'));
        assert.equal(prompts(f).length, 0); assert.equal(r.pending.settled, false);
        f.releaseHolders(); await version.done;
        assert.equal(outcome(await r.pending.done).finalText, 'FINAL_ONLY');
        assert.deepEqual(await r.execution!.cleanup, { rpc: 'closed', version: 'closed', cwdDisposition: 'removable', reason: null });
        assert.ok(f.owner.children.every(x => x.closed));
    }));

test('RPC exit starts companion cancellation before RPC close, and both held pipes share one immutable2000ms retain receipt',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'pipe-held', rpcPipeHeld: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'direct');
        let receiptDone = false, resultCount = 0;
        const cleanup = r.execution!.cleanup.then(value => { receiptDone = true; return value; });
        void r.pending.done.then(() => { resultCount++; });
        await f.wait(() => f.owner.children.some(x => x.role === 'version' && x.exited));
        r.child.stdin!.write(JSON.stringify({ type: 'test_exit' }) + '\n');
        await f.wait(() => f.owner.children.filter(x => x.role !== 'holder').every(x => x.exited));
        assert.ok(f.owner.children.filter(x => x.role !== 'holder').every(x => !x.closed));
        await f.wait(() => clock.timers.some(x => x.ms === 2000));
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1, 'exit, not held close, starts teardown');
        clock.tick(1999); assert.equal(receiptDone, false); assert.equal(r.pending.settled, false);
        r.child.emit('error', new Error('late-owned-event-secret'));
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1, 'late event cannot reset or duplicate drain');
        clock.tick(1);
        const receipt = await cleanup;
        assert.equal(receipt.rpc, 'unconfirmed'); assert.equal(receipt.version, 'unconfirmed');
        assert.equal(receipt.cwdDisposition, 'retain'); assert.equal(typeof receipt.reason, 'string');
        assert.ok(receipt.reason!.length <= 256); assert.doesNotMatch(receipt.reason!, /late-owned-event-secret|\/|\\/);
        assert.deepEqual(outcome(await r.pending.done), { status: 'error', finalText: null, partialText: '' });
        assert.deepEqual(r.deliveryOrder, ['cleanup', 'done']);
        assert.equal(receiptDone, true); assert.equal(resultCount, 1); assert.equal(prompts(f).length, 0);
        const frozen = { ...receipt }; f.releaseHolders();
        await Promise.all(f.owner.children.map(x => x.done)); await turn();
        assert.strictEqual(await r.execution!.cleanup, receipt); assert.deepEqual(receipt, frozen);
        assert.equal(resultCount, 1); assert.ok(fs.existsSync(f.root));
        assert.ok(f.owner.children.every(x => x.lateSignals === 0));
    }));

for (const mode of ['persistent', 'direct'] as const) test(`SRC02 ${mode} post-ready exit without a terminal starts cleanup despite already-closed version`,
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'immediate', rows: [], rpcPipeHeld: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, mode);
        let resultCount = 0;
        void r.pending.done.then(() => { resultCount++; });
        await f.wait(() => prompts(f).length === 1 && f.owner.children.some(x => x.role === 'version' && x.closed));
        assert.equal(ends(r.raw), false); assert.equal(r.pending.settled, false);
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 0);
        r.child.stdin!.write(JSON.stringify({ type: 'test_exit' }) + '\n');
        await f.wait(() => f.owner.children.some(x => x.role === 'rpc' && x.exited));
        await turn(); // The real exit listener, not a synthetic close, must activate the owner.
        const rpc = f.owner.children.find(x => x.role === 'rpc')!;
        assert.equal(rpc.closed, false);
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1, 'post-ready exit independently starts the same bounded owner');
        clock.tick(1999); assert.equal(r.pending.settled, false);
        clock.tick(1);
        const result = await r.pending.done;
        assert.deepEqual(outcome(result), { status: 'error', finalText: null, partialText: '' });
        assert.equal(resultCount, 1); assert.equal(prompts(f).length, 1); assert.equal(r.text.join(''), '');
        let receipt: PiExecutionCleanupReceipt | undefined;
        if (r.execution) {
            receipt = await r.execution.cleanup;
            assert.equal(receipt.rpc, 'unconfirmed'); assert.equal(receipt.version, 'closed');
            assert.equal(receipt.cwdDisposition, 'retain'); assert.equal(typeof receipt.reason, 'string');
            assert.ok(receipt.reason!.length <= 256);
            assert.deepEqual(r.deliveryOrder, ['cleanup', 'done']);
        } else {
            assert.equal(r.session!.alive, false); assert.equal(r.session!.abortEffective, false);
            await assert.rejects(r.session!.sendPrompt('post-exit revival'));
        }
        const frozen = receipt && { ...receipt };
        f.releaseHolders(); await Promise.all(f.owner.children.map(x => x.done)); await turn();
        assert.strictEqual(await r.pending.done, result); assert.equal(resultCount, 1);
        if (r.execution) { assert.strictEqual(await r.execution.cleanup, receipt); assert.deepEqual(receipt, frozen); }
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
        assert.ok(f.owner.children.every(x => x.lateSignals === 0)); assert.ok(fs.existsSync(f.root));
    }));

test('SRC03 persistent post-dispatch stdin failure owns result before late valid terminal and until physical cleanup',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'immediate', rows: [],
        ignoreTerm: true, ignoreEof: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'persistent');
        let resultCount = 0;
        void r.pending.done.then(() => { resultCount++; });
        await f.wait(() => prompts(f).length === 1 && f.owner.children.some(x => x.role === 'version' && x.closed));
        assert.equal(r.pending.settled, false);
        // Real stream ingress fault followed by an already-buffered valid terminal:
        // parser, first-failure selection and cleanup owner remain actual production.
        r.child.stdin!.emit('error', new Error('owned-first-stdin-failure'));
        assert.equal(r.session!.alive, false); assert.equal(r.session!.abortEffective, false);
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
        r.child.stdout!.emit('data', Buffer.from(JSON.stringify(end('LATE_AFTER_FAILURE')) + '\n'
            + JSON.stringify({ type: 'agent_settled' }) + '\n'));
        await turn();
        assert.equal(r.pending.settled, false, 'late terminal cannot resolve the captured failure before cleanup');
        assert.equal(r.text.join(''), '', 'late data cannot mutate the first-failure partial');
        clock.tick(999); assert.equal(r.pending.settled, false);
        assert.equal(f.owner.children.find(x => x.role === 'rpc')!.closed, false);
        clock.tick(1);
        const result = await r.pending.done;
        assert.ok(result.error instanceof Error); assert.match(result.error.message, /owned-first-stdin-failure/);
        assert.deepEqual(outcome(result), { status: 'error', finalText: null, partialText: '' });
        assert.equal(resultCount, 1); assert.ok(f.owner.children.every(x => x.closed));
        await assert.rejects(r.session!.sendPrompt('late retry'));
        r.child.stdout!.emit('data', Buffer.from(JSON.stringify(end('AFTER_CLOSE')) + '\n'
            + JSON.stringify({ type: 'agent_settled' }) + '\n'));
        await turn();
        assert.strictEqual(await r.pending.done, result); assert.equal(resultCount, 1); assert.equal(r.text.join(''), '');
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1); assert.equal(prompts(f).length, 1);
    }));

test('persistent close while companion pipe is held rejects uncertified at shared boundary and never unpoisons',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'pipe-held' }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'persistent');
        await f.wait(() => f.owner.children.some(x => x.role === 'version' && x.exited));
        const closing = r.session!.close(); assert.ok(closing instanceof Promise);
        const closed = observe(Promise.resolve(closing)); f.owner.settlements.push(closed.done);
        assert.equal(r.session!.alive, false); assert.equal(r.session!.abortEffective, false);
        await f.wait(() => f.owner.children.some(x => x.role === 'rpc' && x.closed));
        clock.tick(1999); assert.equal(closed.settled, false); assert.equal(r.pending.settled, false);
        clock.tick(1); const failure = await closed.done;
        assert.ok(failure.error instanceof Error); assert.match(failure.error.message, /cleanup.*unconfirmed|uncertified/i);
        assert.deepEqual(outcome(await r.pending.done), { status: 'stopped', finalText: null, partialText: '' });
        f.releaseHolders(); await Promise.all(f.owner.children.map(x => x.done));
        await assert.rejects(r.session!.sendPrompt('late success must not revive'));
        assert.equal(prompts(f).length, 0); assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
    }));

for (const change of ['command', 'symlink', 'PATH', 'cwd', 'profile-env']) {
    test(`P10 fresh instance after ${change} consumes changed modern-to-legacy capability and captured launch inputs`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate',
            version: '0.83.0', rows: [end('MODERN_ONLY')] }, async f => {
            const alias = path.join(f.root, 'alias.mjs');
            const originalPath = process.env.PATH;
            const pathTargets = [path.join(f.root, 'path-first/pi'), path.join(f.root, 'path-second/pi')];
            if (change === 'symlink') { fs.symlinkSync(f.bin, alias); f.owner.bin = alias; process.env.PI_CODING_AGENT_BIN = alias; }
            if (change === 'PATH') {
                for (const target of pathTargets) {
                    fs.mkdirSync(path.dirname(target)); fs.copyFileSync(fixtureSource, target); fs.chmodSync(target, 0o755);
                }
                delete process.env.PI_CODING_AGENT_BIN; f.owner.bin = 'pi';
                f.configure({ pathSelection: true, pathBinary: pathTargets[0] });
                process.env.PATH = path.dirname(pathTargets[0]!) + path.delimiter + originalPath;
            }
            process.env.PI_CAPABILITY_SENTINEL = 'first-instance-sentinel';
            const first = start(f, 'persistent');
            await f.wait(() => ends(first.raw)); await turn();
            assert.equal(first.pending.settled, false, 'modern instance must wait for settled after its observed end');
            first.send([{ type: 'agent_settled' }]);
            assert.deepEqual(outcome(await first.pending.done), { status: 'done', finalText: 'MODERN_ONLY', partialText: 'MODERN_ONLY' });
            await Promise.resolve(first.session!.close());
            const firstStarts = f.rows().filter(x => x.kind === 'start');
            assert.equal(firstStarts.filter(x => x.role === 'version').length, 1);
            assert.ok(firstStarts.every(x => x.sentinel === 'first-instance-sentinel'));
            if (change === 'PATH') {
                assert.equal(first.child.spawnfile, 'pi');
                assert.ok(firstStarts.every(x => x.executable === pathTargets[0]));
                assert.equal(firstStarts.filter(x => x.role === 'availability').length, 1);
                assert.equal(f.owner.syncCloses, 1);
            }
            const nextBinary = path.join(f.root, 'next-pi.mjs');
            if (change === 'command' || change === 'symlink') {
                fs.copyFileSync(fixtureSource, nextBinary); fs.chmodSync(nextBinary, 0o755);
                if (change === 'symlink') { fs.unlinkSync(alias); fs.symlinkSync(nextBinary, alias); }
                else { f.owner.bin = nextBinary; process.env.PI_CODING_AGENT_BIN = nextBinary; }
            }
            if (change === 'PATH') {
                f.configure({ pathBinary: pathTargets[1] });
                process.env.PATH = path.dirname(pathTargets[1]!) + path.delimiter + originalPath;
            }
            if (change === 'cwd') { f.options.cwd = path.join(f.root, 'new-cwd'); fs.mkdirSync(f.options.cwd); }
            if (change === 'profile-env') f.options.root = path.join(f.root, 'new-profile-root');
            f.configure({ version: '0.80.3', rows: [end('LEGACY_ONLY')] });
            process.env.PI_CAPABILITY_SENTINEL = 'second-instance-sentinel';
            const second = start(f, 'persistent'); assert.notEqual(second.child.pid, first.child.pid);
            assert.deepEqual(outcome(await second.pending.done), { status: 'done', finalText: 'LEGACY_ONLY', partialText: 'LEGACY_ONLY' });
            assert.equal(second.raw.some(x => x && typeof x === 'object' && 'type' in x && x.type === 'agent_settled'), false,
                'new legacy decision completes without a settled record; cached modern would remain pending');
            const starts = f.rows().filter(x => x.kind === 'start');
            assert.equal(starts.filter(x => x.role === 'version').length, 2);
            const latest = starts.slice(-2);
            assert.deepEqual(latest.map(x => x.role).sort(), ['rpc', 'version']);
            assert.ok(latest.every(x => x.cwd === f.options.cwd));
            assert.ok(latest.every(x => x.profile === path.join(f.options.root, DEFAULT_PI_PROFILE.id)));
            assert.ok(latest.every(x => x.pathValue === process.env.PATH));
            assert.ok(latest.every(x => x.sentinel === 'second-instance-sentinel'));
            assert.equal(second.child.spawnfile, f.owner.bin);
            assert.deepEqual(f.owner.children.filter(x => x.role === 'version').map(x => x.stdout.trim()), ['0.83.0', '0.80.3']);
            assert.equal(prompts(f).length, 2);
            assert.equal(f.owner.syncCloses, change === 'PATH' ? 2 : 0, 'availability probes are separate from exactly one capability query per instance');
            if (change === 'PATH') {
                assert.equal(process.env.PI_CODING_AGENT_BIN, undefined);
                assert.ok(latest.every(x => x.executable === pathTargets[1]));
                assert.deepEqual(starts.filter(x => x.role === 'availability').map(x => x.executable), pathTargets);
            }
            if (change === 'command' || change === 'symlink') assert.ok(latest.every(x => x.executable === nextBinary));
            await Promise.resolve(second.session!.close());
        }));
}

test('P11 fake npm fallback preserves ordered baseArgs for version/RPC and reuses one probe for abort identity',
    { timeout: 12000, skip: process.platform === 'win32' }, async () => owned({ versionMode: 'immediate', npmFallback: true }, async f => {
        const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
        for (const name of ['pi', 'npm']) { const file = path.join(bin, name); fs.copyFileSync(fixtureSource, file); fs.chmodSync(file, 0o755); }
        delete process.env.PI_CODING_AGENT_BIN; process.env.PATH = bin + path.delimiter + process.env.PATH;
        const baseArgs = ['exec', '--yes', '--package', '@earendil-works/pi-coding-agent', 'pi', '--'];
        fs.mkdirSync(path.join(JAW_HOME, 'pi'), { recursive: true });
        fs.writeFileSync(path.join(JAW_HOME, 'pi/rpc-capabilities.json'), JSON.stringify({ schemaVersion: 1,
            profileId: DEFAULT_PI_PROFILE.id, abortEffective: true, probedAt: new Date().toISOString(),
            commandId: JSON.stringify({ source: 'npm-exec', command: 'npm', baseArgs, version: '0.83.0' }) }));
        const r = start(f, 'persistent'); assert.equal(r.session!.abortEffective, false);
        assert.equal(outcome(await r.pending.done).finalText, 'FINAL_ONLY');
        assert.equal(r.session!.abortEffective, true);
        const version = f.rows().filter(x => x.role === 'version' && x.kind === 'start');
        const rpc = f.rows().find(x => x.role === 'rpc' && x.kind === 'start')!;
        assert.equal(version.length, 1); assert.deepEqual(version[0]!.args, [...baseArgs, '--version']);
        assert.ok(Array.isArray(rpc.args)); assert.deepEqual(rpc.args.slice(0, 8), [...baseArgs, '--mode', 'rpc']);
        assert.equal(f.owner.syncCloses, 1, 'only the preserved availability resolver may be synchronous');
        await Promise.resolve(r.session!.close());
    }));

for (const mode of ['persistent', 'direct'] as const) test(`printed version with exited-but-held pipe reaches15s failure, not legacy dispatch (${mode})`,
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'pipe-held' }, async f => {
        const clock = controlledClock(t, f), r = start(f, mode);
        await f.wait(() => f.owner.children.some(x => x.role === 'version' && x.exited));
        assert.equal(prompts(f).length, 0); assert.equal(r.pending.settled, false);
        clock.tick(15000); await f.wait(() => clock.timers.some(x => x.ms === 2000));
        if (r.session) { assert.equal(r.session.alive, false); assert.equal(r.session.abortEffective, false); }
        await f.wait(() => f.owner.children.some(x => x.role === 'rpc' && x.closed));
        clock.tick(1999); assert.equal(r.pending.settled, false);
        clock.tick(1); assert.deepEqual(outcome(await r.pending.done), { status: 'error', finalText: null, partialText: '' });
        assert.equal(prompts(f).length, 0); assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
        if (r.execution) {
            const receipt = await r.execution.cleanup;
            assert.equal(receipt.rpc, 'closed'); assert.equal(receipt.version, 'unconfirmed'); assert.equal(receipt.cwdDisposition, 'retain');
        }
        f.releaseHolders(); await Promise.all(f.owner.children.map(x => x.done));
        assert.ok(f.owner.children.every(x => x.lateSignals === 0));
    }));

test('a typed successful answer survives UNCERTIFIED direct cleanup and late close cannot upgrade its receipt',
    { timeout: 12000, skip: process.platform === 'win32' }, async t => owned({ versionMode: 'immediate', rpcPipeOnEof: true }, async f => {
        const clock = controlledClock(t, f), r = start(f, 'direct');
        await f.wait(() => f.owner.children.some(x => x.role === 'rpc' && x.exited));
        assert.equal(r.pending.settled, false);
        assert.equal(clock.timers.filter(x => x.ms === 2000).length, 1);
        clock.tick(1999); assert.equal(r.pending.settled, false);
        clock.tick(1);
        const receipt = await r.execution!.cleanup;
        assert.equal(receipt.rpc, 'unconfirmed'); assert.equal(receipt.version, 'closed'); assert.equal(receipt.cwdDisposition, 'retain');
        const result = await r.pending.done;
        assert.deepEqual(outcome(result), { status: 'done', finalText: 'FINAL_ONLY', partialText: 'FINAL_ONLY' });
        assert.deepEqual(r.deliveryOrder, ['cleanup', 'done']);
        const frozen = { ...receipt }; f.releaseHolders(); await Promise.all(f.owner.children.map(x => x.done));
        assert.strictEqual(await r.pending.done, result); assert.strictEqual(await r.execution!.cleanup, receipt);
        assert.deepEqual(receipt, frozen); assert.ok(fs.existsSync(f.root));
    }));

for (const mode of ['persistent', 'direct'] as const) for (const withReceipt of [false, true]) {
    test(`P${withReceipt ? 2 : 1} ${mode}: parent progresses during held version, actual RPC child returns, one query and prompt`,
        { timeout: 12000, skip: process.platform === 'win32' }, async () => {
            const f = fixture({ version: '0.83.0', warning: withReceipt ? 'fixture version warning' : '' });
            if (withReceipt) f.receipt();
            let parentBeforeDeadline = false, promptsBeforeRelease = -1;
            const progress = f.wait(() => f.rows().some(r => r.role === 'version' && r.kind === 'start')).then(async () => {
                await f.wait(() => f.rows().some(r => r.role === 'rpc' && r.kind === 'start'));
                parentBeforeDeadline = !f.rows().some(r => r.kind === 'self-deadline');
                promptsBeforeRelease = f.rows().filter(r => r.kind === 'request' && r.request?.type === 'prompt').length;
                f.release();
            });
            let session: ReturnType<typeof spawnPersistentPiRpc> | undefined;
            let result: Promise<unknown> | undefined;
            try {
                const execution = mode === 'persistent'
                    ? (session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, f.options))
                    : spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, { ...f.options, prompt: 'owned prompt' });
                assert.ok(execution.child instanceof cp.ChildProcess);
                assert.equal(f.owner.children.find(e => e.child === execution.child)?.role, 'rpc');
                if (session) assert.equal(session.abortEffective, false, 'pending version is not proved abort support');
                result = session ? session.sendPrompt('owned prompt') : (execution as ReturnType<typeof spawnPiRpc>).done;
                void result.catch(() => {});
                await progress;
                assert.equal(parentBeforeDeadline, true, 'parent event loop stalled until held version self-deadline');
                assert.equal(promptsBeforeRelease, 0);
                const final = await result as { runtimeOutcome?: { finalText: string | null } };
                assert.equal(final.runtimeOutcome?.finalText, 'FINAL_ONLY');
                assert.equal(f.rows().filter(r => r.role === 'version' && r.kind === 'start').length, 1);
                assert.equal(f.owner.syncCloses, 0, 'explicit command needs no synchronous availability or version probe');
                assert.equal(f.rows().filter(r => r.kind === 'request' && r.request?.type === 'prompt').length, 1);
                if (session && withReceipt) assert.equal(session.abortEffective, true);
            } finally {
                f.release(); await progress;
                await Promise.resolve(session?.close()).catch(() => {});
                await f.dispose(); await result?.catch(() => {});
            }
        });
}
