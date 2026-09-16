import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPiRpc, DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS } from '../../src/agent/pi-runtime.ts';
import { PiRuntimeSession } from '../../src/agent/runtime/pi-runtime-session.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-open-rpc-'));
const binary = join(root, 'pi.mjs');
writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('0.80.4'); process.exit(0); }
const send = (row) => process.stdout.write(JSON.stringify(row) + '\\n');
send({ type: 'get_state', success: true, state: { model: 'fixture' } });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'get_state') send({ type: 'get_state', id: msg.id, success: true, state: { model: 'fixture' } });
});
`);
chmodSync(binary, 0o755);
const previous = process.env.PI_CODING_AGENT_BIN;
process.env.PI_CODING_AGENT_BIN = binary;
test.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_BIN;
    else process.env.PI_CODING_AGENT_BIN = previous;
    rmSync(root, { recursive: true, force: true });
});

test('openPiRpc does not write prompt until session.send', { timeout: 7000 }, async () => {
    const opened = openPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, {
        model: 'fixture', cwd: root, root, env: { ...process.env, PI_CODING_AGENT_BIN: binary },
    });
    let prompts = 0;
    const original = opened.sendPrompt.bind(opened);
    opened.sendPrompt = (message, opts) => {
        prompts += 1;
        return original(message, opts);
    };
    await opened.prepared;
    assert.equal(prompts, 0);
    const writes: string[] = [];
    const stdin = opened.child.stdin;
    assert.ok(stdin);
    const write = stdin.write.bind(stdin);
    stdin.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
        writes.push(String(chunk));
        return write(chunk, encoding as BufferEncoding, cb);
    }) as typeof stdin.write;
    assert.equal(writes.some((line) => line.includes('"type":"prompt"')), false);
    const runtime = new PiRuntimeSession(opened, {
        lifetime: 'oneshot',
        deferTurnEnd: true,
        getTurnContext: () => ({ turnId: 'open-rpc-turn' }),
    });
    const sending = runtime.send({ text: 'FIRST' }, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts, 1);
    assert.ok(writes.some((line) => line.includes('"type":"prompt"')));
    opened.kill();
    void sending.catch(() => {});
});
