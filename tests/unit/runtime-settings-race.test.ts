import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';

const ROOT = process.cwd();
const GATE = path.join(ROOT, 'src/core/runtime-settings-gate.ts');
const RUNTIME = path.join(ROOT, 'src/core/runtime-settings.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');

const gateSrc = fs.readFileSync(GATE, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
const spawnSrc = fs.readFileSync(SPAWN, 'utf8');

test('RSR-001: runtime settings gate is a leaf module', () => {
    assert.doesNotMatch(gateSrc, /from ['"]\.\/runtime-settings/);
    assert.doesNotMatch(gateSrc, /from ['"].*spawn/);
    assert.doesNotMatch(gateSrc, /from ['"].*builder/);
    assert.doesNotMatch(gateSrc, /from ['"].*compact/);
    assert.doesNotMatch(gateSrc, /from ['"].*config/);
    assert.doesNotMatch(gateSrc, /from ['"].*db/);
});

test('RSR-002: applyRuntimeSettingsPatch wraps mutations in a finally-cleared gate', () => {
    assert.match(runtimeSrc, /import\s+\{\s*beginRuntimeSettingsMutation\s*\}\s+from\s+['"]\.\/runtime-settings-gate\.js['"]/);
    assert.match(runtimeSrc, /const\s+finishSettingsMutation\s*=\s*beginRuntimeSettingsMutation\(\)/);
    assert.match(runtimeSrc, /finally\s*\{\s*finishSettingsMutation\(\);\s*\}/);
});

test('RSR-003: spawn waits before reading session bucket state', () => {
    const waitIdx = spawnSrc.indexOf('waitForRuntimeSettingsIdle()');
    const sessionIdx = spawnSrc.indexOf('const session = (getSession() as SessionRow | undefined) ?? {}');
    const bucketIdx = spawnSrc.indexOf('getSessionBucket.get(currentBucket)');
    assert.ok(waitIdx > -1, 'spawn must wait on runtime settings gate');
    assert.ok(sessionIdx > waitIdx, 'session read must happen after wait path');
    assert.ok(bucketIdx > waitIdx, 'bucket read must happen after wait path');
});

test('RSR-005: stop cancels a pending gated main spawn', { timeout: 5000 }, async t => {
    const forbiddenCalls: string[] = [];
    const forbidden = (name: string) => (..._args: unknown[]): never => {
        forbiddenCalls.push(name); assert.fail(`cancelled gated spawn reached ${name}`);
    };
    const processSeams = Object.fromEntries(
        ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, forbidden(name)]),
    );
    t.mock.module('node:child_process', {
        namedExports: { ...childProcess, ...processSeams }, defaultExport: { ...childProcess, ...processSeams },
    });
    const config = await import('../../src/core/config.ts');
    t.mock.module('../../src/core/config.js', { namedExports: { ...config,
        settings: { ...config.settings, cli: 'codex-app', workingDir: config.JAW_HOME, projectDirs: [config.JAW_HOME],
            fallbackOrder: [], multiSession: { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' } },
        detectCli: forbidden('detectCli'), detectAllCli: forbidden('detectAllCli'),
        getProjectDirs: () => [config.JAW_HOME],
    } });
    const { spawnAgent, killActiveAgent, activeMainProcesses, isAgentBusy } = await import('../../src/agent/spawn.ts');
    const { db } = await import('../../src/core/db.ts');
    const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
    const { beginRuntimeSettingsMutation, isRuntimeSettingsMutationInFlight } = await import('../../src/core/runtime-settings-gate.ts');
    const snapshot = () => ({ messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
        buckets: db.prepare('SELECT * FROM session_buckets ORDER BY bucket').all() });
    const before = snapshot();
    t.mock.method(fs, 'writeFileSync', forbidden('writeFileSync'));
    t.mock.method(fs, 'mkdirSync', forbidden('mkdirSync'));
    t.mock.method(globalThis, 'fetch', forbidden('fetch'));
    t.mock.method(console, 'log', () => {});
    const scopeKey = 'settings-gated-cancel', finishMutation = beginRuntimeSettingsMutation();
    try {
        const run = spawnAgent('pending user turn', { cli: 'codex-app', scopeKey, chatSessionId: 'settings-gated-chat',
            sysPrompt: '', _skipHistory: true });
        assert.equal(run.child, null); assert.equal(isAgentBusy(scopeKey), true);
        assert.equal(activeMainProcesses.get(scopeKey)?.starting, true);
        let settled = false;
        void run.promise.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false, 'the actual spawn remains behind the open settings gate');
        assert.equal(killActiveAgent(scopeKey, 'user'), true);
        assert.equal(activeMainProcesses.has(scopeKey), false);
        finishMutation();
        assert.deepEqual(await run.promise, { text: '', code: 130, executionInterrupted: true, stopCause: 'user_stop' });
        assert.equal(isRuntimeSettingsMutationInFlight(), false);
        assert.equal(isAgentBusy(scopeKey), false);
        assert.deepEqual(snapshot(), before, 'cancellation must not persist a resumed user turn');
        assert.deepEqual(forbiddenCalls, [], 'no detection, provider process, prompt preparation or network');
    } finally { finishMutation(); activeMainProcesses.delete(scopeKey); clearGoalTimers(); }
});

test('RSR-006: settings gate only delays direct main user spawns', () => {
    assert.match(
        spawnSrc,
        /const\s+gateEligibleMain\s*=\s*mainManaged\s*&&\s*!opts\.agentId\s*&&\s*!opts\.internal\s*&&\s*!opts\._isFallback\s*&&\s*!opts\._isSmokeContinuation/,
        'gate must exclude internal, agentId, fallback, and smoke-continuation spawns',
    );
    assert.match(
        spawnSrc,
        /if\s*\(\s*gateEligibleMain\s*&&\s*!opts\._settingsGateWaited\s*&&\s*isRuntimeSettingsMutationInFlight\(\)\s*\)/,
        'wait branch should use gateEligibleMain, not broad mainManaged',
    );
});
