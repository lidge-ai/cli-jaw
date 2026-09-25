import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { readSpawnAgentSource, readSpawnFile } from '../helpers/spawn-source.mts';

const root = join(import.meta.dirname, '../..');
const spawn = readSpawnAgentSource();
const pi = fs.readFileSync(join(root, 'src/agent/pi-runtime.ts'), 'utf8');
const heartbeat = fs.readFileSync(join(root, 'src/memory/heartbeat.ts'), 'utf8');
const distribute = fs.readFileSync(join(root, 'src/orchestrator/distribute.ts'), 'utf8');

test('HGR-001 grant activation precedes every runtime branch', () => {
    const activation = spawn.indexOf('const slackToolGrant = slackToolGrantEligible');
    for (const marker of [
        "if (runtimeTransport === 'native' && cli === 'claude')",
        "if (cli === 'pi')",
        "if (cli === 'codex-app')",
        'const { child, kiroConversationIdsBefore',
    ]) {
        const branch = spawn.indexOf(marker);
        assert.ok(activation >= 0 && branch > activation, marker);
    }
});

test('HGR-002 native pools cannot reuse a process carrying a scheduled grant', () => {
    assert.ok(spawn.includes("...(slackToolGrant ? { lifetime: 'request' as const } : {})"));
    assert.ok((spawn.match(/forceNew: forceNew || Boolean(slackToolGrant)/g) ?? []).length >= 4,
        'Cursor/Grok, Pi, and both Codex App acquisition paths force fresh ownership');
    assert.match(spawn, /fresh: forceNew || opts._skipResume === true || isEmployee || Boolean(slackToolGrant)/,
        'Claude native receives a fresh grant-bearing acquisition');
});

test('HGR-003 Pi launches from the captured env instead of process-global env', () => {
    assert.ok(pi.includes('const inherited = { ...(options.env ?? process.env) }'));
    // The main acquirePiRuntime call lives in the Pi backend module, one indent level
    // shallower than it was inside spawnAgent.
    assert.ok(readSpawnFile('backend-pi.ts').includes('piSettings: pi,\n        env: spawnEnv,'));
    assert.ok((spawn.match(/env: spawnEnv/g) ?? []).length >= 2,
        'both employee spawnPiRpc and main acquirePiRuntime receive the captured env');
});

test('HGR-004 employee and script runners receive the same request grant', () => {
    assert.ok(heartbeat.includes('runEmployee(job, prompt, requestId, destinationBinding.target)'));
    assert.ok(heartbeat.includes('grantEnv = { [SLACK_TOOL_GRANT_ENV]: secret }'));
    assert.ok(distribute.includes('...(isRemoteTarget(meta["target"]) ? { target: { ...meta["target"] } } : {})'));
});

test('HGR-005 enforced grant lifetime exceeds every runner ceiling', () => {
    const toolContext = fs.readFileSync(join(root, 'src/slack/tool-context.ts'), 'utf8');
    assert.ok(toolContext.includes('ENFORCED_GRANT_TTL_MS = 25 * 60_000'));
    assert.ok(heartbeat.includes('timeout: 10 * 60_000'));
    const collect = fs.readFileSync(join(root, 'src/orchestrator/collect.ts'), 'utf8');
    assert.ok(collect.includes('IDLE_TIMEOUT = 1200000'));
});
