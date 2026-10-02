import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildAsideRunArgs, buildAsideStopArgs, buildAsideReadArgs, createAsideHeaderReader, parseAsideRepl, launchAsideCommand, closeAsideCommand } from '../../src/agent/aside-cli.ts';
import type { AsideSelection } from '../../src/shared/aside-contract.ts';
const selection: AsideSelection = { account: 'u2', host: 'local', provider: 'custom', modelId: 'family/model', model: 'custom/family/model', effort: 'high' };
const input = { selection, permission: 'guard' as const, prompt: '--option $(echo bad) `bad` 한🙂' };
const childPath = fileURLToPath(new URL('./fixtures/aside-runtime/child.mjs', import.meta.url));

test('argv carries explicit selectors, qualified model and one literal prompt after --; resume root opts inherited', () => {
    assert.deepEqual(buildAsideRunArgs(input), ['--account', 'u2', '--host', 'local', '--model', 'custom/family/model', '--permission', 'guard', '--effort', 'high', 'exec', '--', input.prompt]);
    assert.deepEqual(buildAsideRunArgs({ ...input, sessionId: 'owned-session' }).slice(-5), ['session', 'resume', 'owned-session', '--', input.prompt]);
    assert.deepEqual(buildAsideStopArgs(selection, 'owned-session'), ['--account', 'u2', '--host', 'local', 'session', 'stop', 'owned-session']);
    assert.throws(() => buildAsideRunArgs({ ...input, prompt: '한'.repeat(40000) }), /argv_limit/);
    assert.throws(() => buildAsideRunArgs({ ...input, prompt: '\0' }));
    assert.throws(() => buildAsideStopArgs(selection, '../other'));
    assert.throws(() => buildAsideRunArgs({ ...input, selection: { ...selection, host: 'remote' } as unknown as AsideSelection }));
});
test('header is first stderr line only, ANSI/chunk safe and seals before assistant-like text', () => {
    const header = createAsideHeaderReader();
    assert.equal(header('\x1b[2mcreated new sess'), null);
    assert.equal(header('ion: owned-session\x1b[0m\n'), 'owned-session');
    assert.equal(header('created new session: fake\n'), null);
    const noise = createAsideHeaderReader(); assert.equal(noise('other diagnostic\n'), null); assert.equal(noise('created new session: fake\n'), null);
    assert.equal(createAsideHeaderReader('owned-session')('continuing existing session: foreign\n'), null);
    assert.equal(createAsideHeaderReader()('x'.repeat(5000)), null);
});
test('REPL requires unique JSON framing and explicit ok; exit0 error wrapper cannot pass', () => {
    const frame = '12345678-1234-1234-1234-123456789abc';
    const text = `JAW_ASIDE_${frame}_BEGIN{"messages":[]}JAW_ASIDE_${frame}_END\n\x1b[2m[ok | 9ms]\x1b[0m`;
    assert.deepEqual(parseAsideRepl(text, frame), { messages: [] });
    const literal = text.replace('{"messages":[]}', JSON.stringify({ text: '[error | 1ms]', marker: `JAW_ASIDE_${frame}_END` }));
    assert.deepEqual(parseAsideRepl(literal, frame), { text: '[error | 1ms]', marker: `JAW_ASIDE_${frame}_END` });
    for (const bad of [text.replace('[ok | 9ms]', '[error | 9ms]'), text.replace('[ok | 9ms]', ''), text + '\n[error | 1ms]', text + text, text.replace('{"messages":[]}', '{oops')]) assert.throws(() => parseAsideRepl(bad, frame));
    const args = buildAsideReadArgs(selection, 'owned-session', frame);
    assert.ok(args.at(-1)?.includes('await aside.sessions.messages(id,{limit:200,order:"desc"})'));
    assert.ok(!args.at(-1)?.includes('messageRows'));
});
test('real child transport uses shell:false and decodes split UTF8; close follows exact child TERM', async () => {
    let observed = false;
    const launch = (scenario: string) => launchAsideCommand({ binary: process.execPath, cwd: process.cwd(), env: process.env }, [childPath, scenario], {
        spawn(binary, args, options) { assert.equal(options.shell, false); observed = true; return spawn(binary, args, options); },
    });
    assert.equal((await launch('raw').completion).stdout, '한🙂');
    assert.equal((await launch('overflow').completion).overflow, true);
    const waiting = launch('wait');
    await new Promise<void>(resolve => waiting.child.stderr!.once('data', () => resolve()));
    assert.equal(waiting.closed, false);
    assert.equal(await closeAsideCommand(waiting, 1000, 1000), true);
    assert.equal((await waiting.completion).exitCode, 143);
    assert.equal(observed, true);
});

test('signal delivery and exit do not prove close; escalation stays on captured child', async () => {
    const emitter = new EventEmitter(); const signals: NodeJS.Signals[] = [];
    const fake = Object.assign(emitter, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
        kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
    });
    const command = launchAsideCommand({ binary: 'fixture', cwd: '.', env: {} }, [], { spawn: () => fake as unknown as ChildProcess });
    emitter.emit('exit', 143, null);
    assert.equal(command.closed, false);
    assert.equal(await closeAsideCommand(command, 5, 5), false);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    emitter.emit('close', 143, null); await command.completion;
    assert.equal(await closeAsideCommand(command, 5, 5), true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
