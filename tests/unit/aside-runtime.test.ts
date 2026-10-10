import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAsideRuntime, type AsideRunInput } from '../../src/agent/aside-runtime.ts';
import { completed, snapshot, started, tool, prior } from './fixtures/aside-runtime/transcript.ts';
const childPath = fileURLToPath(new URL('./fixtures/aside-runtime/child.mjs', import.meta.url));
function input(): AsideRunInput { return { binary: 'aside-fixture', cwd: process.cwd(), env: { FIXTURE: 'captured' }, selection: { account: 'u2', host: 'local', provider: 'custom', modelId: 'family/model', model: 'custom/family/model', effort: null }, permission: 'guard', prompt: 'New question' }; }
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function harness(scenario = 'done', stop = 'stop') {
    const calls: string[][] = [];
    const childSeen = deferred<ChildProcess>(), sessionSeen = deferred<string>();
    const starter = (read: (i: AsideRunInput, id: string) => Promise<unknown>) => createAsideRuntime({
        probeMs: 1000, closeMs: 1000, killMs: 1000, turnMs: 3000, read,
        spawn(_binary, args, opts) {
            calls.push([...args]);
            assert.equal(opts.shell, false);
            return spawn(process.execPath, [childPath, args.includes('stop') ? stop : scenario], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
        },
    });
    return { calls, childSeen, sessionSeen, starter, callbacks: { onChild: (c: ChildProcess) => childSeen.resolve(c), onSession: (s: string) => sessionSeen.resolve(s) } };
}

test('exit0 diagnostic/provider errors never certify final; exact replay and callback throws own final', async () => {
    const h = harness(); const output: string[] = [];
    const run = h.starter(async () => snapshot(completed(' \n ')))(input(), {
        onSession() { throw new Error('observer'); }, onChild() { throw new Error('observer'); },
        onOutput(text) { output.push(text); throw new Error('observer'); },
    });
    const result = await run.result;
    assert.equal(result.status, 'done'); assert.equal(result.finalText, ' \n '); assert.equal(result.reusable, true);
    assert.ok(output.join('').includes('DIAGNOSTIC_NOT_FINAL'));
    await run.cancel(); assert.equal(h.calls.length, 1);
    const bad = harness('provider-error');
    const failed = await bad.starter(async () => snapshot(prior))(input()).result;
    assert.equal(failed.status, 'error'); assert.equal(failed.finalText, null); assert.equal(failed.reusable, false);
});
test('immutable selection and owned interruption are verified before local child termination and close', async () => {
    const h = harness('wait'); const selected = input(); const reads: string[] = [];
    const run = h.starter(async (captured, id) => {
        assert.equal(captured.selection.account, 'u2'); assert.equal(captured.selection.model, 'custom/family/model'); assert.equal(captured.env['FIXTURE'], 'captured');
        reads.push(id); return snapshot([...started, tool], h.calls.some(c => c.includes('stop')) ? 'interrupted' : 'running');
    })(selected, h.callbacks);
    const child = await h.childSeen.promise; await h.sessionSeen.promise;
    selected.selection.account = 'u9'; selected.selection.model = 'different/model'; selected.env['FIXTURE'] = 'changed';
    const cancellation = run.cancel();
    const result = await run.result; await cancellation;
    assert.equal(result.status, 'stopped'); assert.equal(result.finalText, null); assert.equal(result.reusable, false);
    assert.equal(result.cleanup, 'confirmed');
    assert.match(result.diagnostic!, /interruption verified/); assert.match(result.diagnostic!, /physical completion is not proved/);
    assert.equal(result.exitCode, 143); assert.equal(child.exitCode, 143);
    assert.deepEqual(reads, ['owned-session', 'owned-session']);
    assert.deepEqual(h.calls[1], ['--account', 'u2', '--host', 'local', 'session', 'stop', 'owned-session']);
});
test('cancel before delayed ID latches, awaits receipt, controls once and waits close', async () => {
    const h = harness('delayed');
    const run = h.starter(async () => snapshot([...started, tool], h.calls.length > 1 ? 'interrupted' : 'running'))(input(), h.callbacks);
    const child = await h.childSeen.promise;
    const first = run.cancel(); const second = run.cancel();
    child.stdin!.write('release-header');
    await Promise.all([first, second]);
    assert.equal(h.calls.filter(c => c.includes('stop')).length, 1);
    assert.match((await run.result).diagnostic!, /interruption verified/);
});
test('failed Stop and conflicting later start remain nonreusable and never publish late final', async () => {
    for (const conflicting of [false, true]) {
        const h = harness('wait', conflicting ? 'stop' : 'stop-failed');
        const run = h.starter(async () => snapshot(h.calls.length > 1 && conflicting ? [...started, tool, ...completed()] : [...started, tool], h.calls.length > 1 ? 'interrupted' : 'running'))(input(), h.callbacks);
        await h.sessionSeen.promise; await run.cancel();
        const result = await run.result;
        assert.equal(result.status, 'stopped'); assert.equal(result.finalText, null); assert.equal(result.reusable, false);
        assert.equal(result.cleanup, 'uncertain');
        assert.match(result.diagnostic!, /cancellation is unresolved/); assert.equal(result.exitCode, 143);
    }
});
test('cancel during final replay cannot publish completion; no control targets an already finished turn', async () => {
    const h = harness(); const entered = deferred<void>(); const release = deferred<unknown>();
    let reads = 0;
    const run = h.starter(async () => { if (++reads === 1) { entered.resolve(); return release.promise; } return snapshot(completed()); })(input(), h.callbacks);
    await entered.promise;
    const cancel = run.cancel(); release.resolve(snapshot(completed()));
    await cancel; const result = await run.result;
    assert.equal(result.status, 'stopped'); assert.equal(result.finalText, null);
    assert.equal(h.calls.length, 1); assert.equal(result.reusable, false);
    assert.equal(result.cleanup, 'confirmed'); assert.match(result.diagnostic!, /terminal verified/);
});
test('resume baseline read precedes dispatch; cancellation before dispatch never stops previous session', async () => {
    const baseline = deferred<unknown>(), entered = deferred<void>(); let spawned = false;
    const run = createAsideRuntime({ read: async () => { entered.resolve(); return baseline.promise; }, spawn() { spawned = true; throw new Error('must not spawn'); } })({ ...input(), sessionId: 'owned-session' });
    await entered.promise; const cancel = run.cancel(); baseline.resolve(snapshot(prior)); await cancel;
    assert.equal(spawned, false); assert.equal((await run.result).status, 'stopped');
});
test('oversize input fails before spawn and early process errors use safe diagnostics', async () => {
    let spawned = false;
    const start = createAsideRuntime({ spawn() { spawned = true; throw new Error('SECRET'); } });
    const huge = await start({ ...input(), prompt: 'x'.repeat(100000) }).result;
    assert.equal(spawned, false); assert.match(huge.diagnostic!, /argv_limit/);
    const failed = await start(input()).result;
    assert.equal(failed.status, 'error'); assert.equal(failed.diagnostic!.includes('SECRET'), false);
});
test('turn deadline seals output and runs captured cancellation rather than claiming timeout success', async () => {
    const h = harness('wait');
    const start = createAsideRuntime({ turnMs: 1000, probeMs: 1000, closeMs: 1000, killMs: 1000,
        read: async () => snapshot([...started, tool], h.calls.length > 1 ? 'interrupted' : 'running'),
        spawn(_binary, args, opts) { h.calls.push(args); return spawn(process.execPath, [childPath, args.includes('stop') ? 'stop' : 'wait'], opts); },
    });
    const result = await start(input()).result;
    assert.equal(result.status, 'stopped'); assert.equal(result.reusable, false); assert.equal(result.exitCode, 143);
});

test('resume selects only the new interval and captures baseline before child admission', async () => {
    const calls: string[][] = []; let reads = 0;
    const start = createAsideRuntime({ read: async () => snapshot(++reads === 1 ? prior : [...prior, ...completed('resumed answer')]),
        spawn(_binary, args, opts) {
            assert.equal(reads, 1); calls.push(args);
            return spawn(process.execPath, ['-e', 'process.stderr.write("continuing existing session: owned-session\\n");process.exit(0)'], opts);
        },
    });
    const result = await start({ ...input(), sessionId: 'owned-session' }).result;
    assert.equal(result.status, 'done'); assert.equal(result.finalText, 'resumed answer');
    assert.equal(result.reusable, true); assert.equal(calls.length, 1);
});
test('pending read is bounded, cancellation cannot hang, and async observer rejection cannot change outcome', async () => {
    const start = createAsideRuntime({ probeMs: 5, read: () => new Promise(() => {}) });
    const run = start({ ...input(), sessionId: 'owned-session' });
    await run.cancel();
    assert.equal((await run.result).status, 'stopped');
    const h = harness();
    const final = await h.starter(async () => snapshot(completed('literal [error | 1ms]')))(input(), {
        onOutput: async () => { throw new Error('observer rejection'); },
    }).result;
    assert.equal(final.finalText, 'literal [error | 1ms]'); assert.equal(final.status, 'done');
});
test('onSession cancellation latches before later output, and missing ID produces uncertainty without stop', async () => {
    const h = harness('wait'); let run: ReturnType<ReturnType<typeof createAsideRuntime>>;
    const outputs: string[] = [];
    run = h.starter(async () => snapshot([...started, tool], h.calls.length > 1 ? 'interrupted' : 'running'))(input(), {
        onSession() { void run.cancel(); }, onOutput(text) { outputs.push(text); },
    });
    assert.equal((await run.result).status, 'stopped'); assert.deepEqual(outputs, []);
    const missing = harness('no-id');
    const unknown = await missing.starter(async () => snapshot(completed()))(input()).result;
    assert.equal(unknown.status, 'error'); assert.equal(unknown.reusable, false); assert.equal(unknown.sessionId, null);
    assert.equal(missing.calls.length, 1);
});

test('actual ENOENT child closes with safe error and no reusable bucket', async () => {
    const result = await createAsideRuntime()({ ...input(), binary: '/nonexistent/jaw-aside-fixture-binary' }).result;
    assert.equal(result.status, 'error'); assert.equal(result.finalText, null); assert.equal(result.reusable, false);
    assert.match(result.diagnostic!, /session_receipt_missing/); assert.equal(result.cleanup, 'uncertain');
});

test('transport failure reconciles exact running external session and retains error outcome', async () => {
    const h = harness('done');
    const start = createAsideRuntime({ read: async () => snapshot([...started, tool], h.calls.length > 1 ? 'interrupted' : 'running'),
        probeMs: 1000, closeMs: 1000, killMs: 1000,
        spawn(_binary, args, opts) {
            h.calls.push(args);
            return spawn(process.execPath, args.includes('stop') ? [childPath, 'stop'] : ['-e', 'process.stderr.write("created new session: owned-session\\n");process.exit(1)'], opts);
        },
    });
    const result = await start(input()).result;
    assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'confirmed'); assert.equal(result.reusable, false);
    assert.equal(h.calls.filter(c => c.includes('stop')).length, 1); assert.match(result.diagnostic!, /agent_transport_failed/);
});

for (const phase of ['baseline', 'final-replay'] as const) {
    test(`unconfirmed ${phase} probe close retains every captured command`, async () => {
        const probes: ChildProcess[] = [];
        const start = createAsideRuntime({ probeMs: 5, closeMs: 5, killMs: 5,
            spawn(_binary, args) {
                const child = new ChildProcess();
                child.stdout = new PassThrough(); child.stderr = new PassThrough();
                child.kill = () => true;
                if (args.includes('repl')) probes.push(child);
                else queueMicrotask(() => {
                    child.stderr!.emit('data', Buffer.from('created new session: owned-session\n'));
                    child.emit('close', 0, null);
                });
                return child;
            },
        });
        const run = start({ ...input(), ...(phase === 'baseline' ? { sessionId: 'owned-session' } : {}) });
        const result = await run.result;
        assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'uncertain');
        assert.equal(result.reusable, false); assert.match(result.diagnostic!, /repl_close_unconfirmed/);
        assert.ok(probes.length > 0);
        assert.equal(run.commandsClosed(), false);
        for (const probe of probes) probe.emit('exit', 143, null);
        assert.equal(run.commandsClosed(), false, 'exit alone never confirms probe close');
        assert.equal(await run.closeCommands(), false);
        for (const [index, probe] of probes.entries()) {
            probe.emit('close', 143, null);
            assert.equal(run.commandsClosed(), index === probes.length - 1);
        }
        assert.equal(await run.closeCommands(), true);
    });
}

test('unconfirmed control close stays captured after the main command closes', async () => {
    const sessionSeen = deferred<void>();
    let main: ChildProcess | undefined, control: ChildProcess | undefined;
    const run = createAsideRuntime({ probeMs: 5, closeMs: 5, killMs: 5,
        read: async () => snapshot([...started, tool], 'running'),
        spawn(_binary, args) {
            const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { if (child === main) child.emit('close', 143, null); return true; };
            if (args.includes('stop')) control = child;
            else {
                main = child;
                queueMicrotask(() => child.stderr!.emit('data', Buffer.from('created new session: owned-session\n')));
            }
            return child;
        },
    })(input(), { onSession: () => sessionSeen.resolve() });
    await sessionSeen.promise; await run.cancel();
    assert.equal((await run.result).cleanup, 'uncertain');
    assert.equal(run.commandsClosed(), false);
    assert.ok(control); assert.ok(main);
    control.emit('close', 143, null);
    assert.equal(run.commandsClosed(), true);
});
