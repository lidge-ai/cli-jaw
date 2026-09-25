import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServicePath, resolveBundledNodePath } from '../../src/core/runtime-path.ts';
import { makeCleanEnv } from '../../src/agent/spawn.ts';
import { readSource } from './source-normalize.js';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'server.ts');
const CONFIG = path.join(ROOT, 'src/core/config.ts');
const CLI_DETECTION = path.join(ROOT, 'src/core/cli-detection.ts');
const CLI_DETECT = path.join(ROOT, 'src/core/cli-detect.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');
const QUEUE = path.join(ROOT, 'src/agent/spawn/queue.ts');
const LIFECYCLE = path.join(ROOT, 'src/agent/lifecycle-handler.ts');
const DB = path.join(ROOT, 'src/core/db.ts');
const LAUNCHD = path.join(ROOT, 'bin/commands/launchd.ts');
const SERVICE = path.join(ROOT, 'bin/commands/service.ts');
const SERVE = path.join(ROOT, 'bin/commands/serve.ts');
const DASHBOARD = path.join(ROOT, 'bin/commands/dashboard.ts');

test('SRH-001: buildServicePath augments minimal PATH with common service-safe directories', () => {
    const built = buildServicePath('/usr/bin:/bin', []);
    assert.match(built, /\/usr\/local\/bin/);
    assert.match(built, /\/opt\/homebrew\/bin/);
    assert.match(built, /\.claude\/local\/bin/);
    assert.match(built, /\/usr\/bin/);
    assert.match(built, /\.deno\/bin/, 'should include deno bin');
    assert.match(built, /\/opt\/homebrew\/opt\/node@22\/bin/, 'should include keg-only node@22');
});

test('SRH-002: buildServicePath discovers managed node bins from a custom home', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-path-'));
    const nvmBin = path.join(tmpHome, '.nvm', 'versions', 'node', 'v22.9.0', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });

    const built = buildServicePath('/usr/bin:/bin', [], tmpHome);
    assert.ok(
        built.split(path.delimiter).includes(nvmBin),
        'nvm-managed node bin should be included in service PATH',
    );
});

test('SRH-002b: dist sidecars resolve sibling bundled Node before PATH Node', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-sidecar-node-'));
    const distBin = path.join(tmpRoot, 'dist', 'bin');
    fs.mkdirSync(distBin, { recursive: true });
    const entry = path.join(distBin, 'cli-jaw.js');
    const bundledNode = path.join(tmpRoot, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.writeFileSync(entry, '');
    fs.writeFileSync(bundledNode, '');

    assert.equal(resolveBundledNodePath(entry), bundledNode);
});


test('SRH-003: server clears stale employee sessions before heartbeat and seeds employees first', () => {
    const src = readSource(SERVER, 'utf8');
    const clearIdx = src.indexOf('clearAllEmployeeSessions.run()');
    const seedIdx = src.indexOf('const seeded = await seedDefaultEmployees()');
    const heartbeatIdx = src.indexOf('startHeartbeat();');

    assert.ok(clearIdx >= 0, 'startup must clear employee_sessions');
    assert.ok(seedIdx >= 0, 'startup must seed default employees');
    assert.ok(heartbeatIdx >= 0, 'startup must start heartbeat');
    assert.ok(seedIdx < heartbeatIdx, 'heartbeat must start after employees are seeded');
});

test('SRH-004: service installers use shared service PATH builder instead of raw process.env.PATH', () => {
    const launchdSrc = readSource(LAUNCHD, 'utf8');
    const serviceSrc = readSource(SERVICE, 'utf8');

    assert.match(launchdSrc, /buildServicePath\(process\.env\.PATH \|\| ''/);
    assert.match(serviceSrc, /buildServicePath\(process\.env\.PATH \|\| ''/);
    assert.doesNotMatch(launchdSrc, /<string>\$\{xmlEsc\(process\.env\.PATH \|\| ''\)\}<\/string>/);
    assert.doesNotMatch(serviceSrc, /Environment="PATH=\$\{process\.env\.PATH \|\| '\/usr\/local\/bin:\/usr\/bin:\/bin'\}"/);
});

test('SRH-004b: dist-mode service commands prefer sidecar Node over process.execPath', () => {
    const instanceSrc = readSource(path.join(ROOT, 'src/core/instance.ts'), 'utf8');
    const serveSrc = readSource(SERVE, 'utf8');
    const dashboardSrc = readSource(DASHBOARD, 'utf8');

    assert.match(instanceSrc, /resolveBundledNodePath\(\)/,
        'service installers must resolve sidecar Node before PATH node');
    assert.match(serveSrc, /resolveBundledNodePath\(serverPath\) \?\? process\.execPath/,
        'jaw serve must use sidecar Node for dist server startup');
    assert.match(dashboardSrc, /resolveBundledNodePath\(serverJs\) \?\? process\.execPath/,
        'jaw dashboard serve must use sidecar Node for dist manager startup');
});

test('SRH-005: spawn path and detectCli logic use service-safe PATH handling', () => {
    const spawnSrc = readSpawnAgentSource({ normalized: true });
    const configSrc = readSource(CONFIG, 'utf8');
    const cliDetectionSrc = readSource(CLI_DETECTION, 'utf8');
    const cliDetectSrc = readSource(CLI_DETECT, 'utf8');
    const lifecycleSrc = readSource(LIFECYCLE, 'utf8');
    const dbSrc = readSource(DB, 'utf8');

    // Behavioral, not a source regex: the property this guards is "a spawned
    // child gets the service-safe PATH", and the old pattern also pinned the
    // exact ARGUMENT LIST, so adding a parameter broke it without any behavior
    // changing. AGENTS.md asks for this replacement rather than a string bump.
    const spawnedPath = makeCleanEnv({}, { PATH: '/usr/bin' }, 'linux')['PATH'] ?? '';
    assert.ok(spawnedPath.includes('/usr/bin'), 'inherited PATH entries must survive');
    assert.ok(
        spawnedPath.includes('/usr/local/bin') && spawnedPath.includes('.claude/local/bin'),
        'spawned children must receive the service-safe PATH augmentation',
    );
    assert.match(spawnSrc, /const spawnCommand = cli === 'opencode' && process\.platform !== 'win32'/);
    assert.match(spawnSrc, /\? \(resolvedOpencodeBinary \|\| detected\.path \|\| cli\)/);
    assert.match(spawnSrc, /: \(detected\.path \|\| cli\)/);
    assert.doesNotMatch(spawnSrc, /process\.platform === 'win32' \? cli/);
    assert.match(spawnSrc, /clearEmployeeSession\.run\(opts\.agentId\)/);
    assert.match(lifecycleSrc, /clearEmployeeSession\.run\(opts\.agentId\)/);
    assert.match(dbSrc, /export const clearEmployeeSession = db\.prepare\('DELETE FROM employee_sessions WHERE employee_id = \?'\)/);
    assert.match(configSrc, /export \{ detectAllCli, detectCli/);
    assert.match(cliDetectionSrc, /return detectCliBinary\(binary\)/);
    assert.match(cliDetectSrc, /buildCliDetectionEnv\(seedPath\)/);
    assert.match(cliDetectSrc, /buildServicePath\(seedPath\)/);
    assert.match(cliDetectSrc, /\['-a', name\]/);
    assert.match(cliDetectSrc, /text file without shebang/);
});

test('SRH-006: loadSettings warns and backs up unreadable settings instead of silently overwriting them', () => {
    const src = readSource(CONFIG, 'utf8');
    assert.match(src, /if \(err\?\.code === 'ENOENT'\)/);
    assert.match(src, /console\.warn\(`\[jaw:settings\] failed to load/);
    assert.match(src, /copyFileSync\(SETTINGS_PATH, backupPath\)/);
    assert.ok(
        src.indexOf("if (err?.code === 'ENOENT')") < src.indexOf('copyFileSync(SETTINGS_PATH, backupPath)'),
        'backup path must only run after the ENOENT fast-path',
    );
});

// ─── New tests for findings #6-#10 ─────────────────

const DISPATCH = path.join(ROOT, 'bin/commands/dispatch.ts');
const SHARED = path.join(ROOT, 'src/memory/shared.ts');

test('SRH-007: messaging init is awaited before heartbeat starts', () => {
    const src = readSource(SERVER, 'utf8');
    assert.match(src, /await initEnabledMessagingRuntimes\(\)/,
        'messaging init must be awaited, not fire-and-forget');
    const awaitIdx = src.indexOf('await initEnabledMessagingRuntimes()');
    const heartbeatIdx = src.indexOf('startHeartbeat();');
    assert.ok(awaitIdx < heartbeatIdx,
        'messaging must be initialized before heartbeat starts');
});

test('SRH-008: dispatch CLI has retry logic for ECONNREFUSED', () => {
    const src = readSource(DISPATCH, 'utf8');
    assert.match(src, /STARTUP_RETRY_DELAYS_MS/,
        'dispatch must define retry delays for cold-start scenario');
    assert.match(src, /isConnRefused/,
        'dispatch must detect ECONNREFUSED errors');
    assert.match(src, /Server starting up, retrying/,
        'dispatch must inform user about retry during startup');
});

test('SRH-009: message queue is persisted to DB', () => {
    const queueSrc = readSource(QUEUE, 'utf8');
    const dbSrc = readSource(DB, 'utf8');

    assert.match(dbSrc, /queued_messages/,
        'queued_messages table must exist in schema');
    assert.match(dbSrc, /insertQueuedMessage/,
        'insertQueuedMessage statement must be exported');
    assert.match(dbSrc, /deleteQueuedMessage/,
        'deleteQueuedMessage statement must be exported');
    assert.match(queueSrc, /insertQueuedMessage\.run\(item\.id/,
        'enqueueMessage must persist to DB');
    assert.match(queueSrc, /deleteQueuedMessage\.run\(item\.id\)/,
        'processQueue must remove processed items from DB');
    assert.match(queueSrc, /loadPersistedQueue/,
        'queue must be loaded from DB on module init');
});

test('SRH-010: orphaned employee tmp dirs are cleaned on startup', () => {
    const src = readSource(SERVER, 'utf8');
    assert.match(src, /jaw-emp-/,
        'startup must reference jaw-emp- prefix for cleanup');
    assert.match(src, /orphaned employee tmp dir/,
        'startup must log cleanup of orphaned dirs');
});

test('SRH-011: migration lock has PID staleness check', () => {
    const src = readSource(SHARED, 'utf8');
    assert.match(src, /isProcessAlive/,
        'migration lock must check if holding process is alive');
    assert.match(src, /process\.kill\(.*0\)/,
        'must use signal 0 to check PID existence');
    assert.match(src, /stale lock/,
        'must log when removing stale lock');
});

// ─── Phase 1: installer/PATH hardening ─────────────────

const CLAUDE_INSTALL = path.join(ROOT, 'src/core/claude-install.ts');
const DOCTOR = path.join(ROOT, 'bin/commands/doctor.ts');
const INSTALL_SH = path.join(ROOT, 'scripts/install.sh');

test('SRH-012: classifyClaudeInstall extracted to shared module', () => {
    const src = readSource(CLAUDE_INSTALL, 'utf8');
    assert.match(src, /export function classifyClaudeInstall/,
        'classifyClaudeInstall must be exported from shared module');
    assert.match(src, /export type ClaudeInstallKind/,
        'ClaudeInstallKind type must be exported');
});

test('SRH-013: doctor.ts imports classifyClaudeInstall from shared module', () => {
    const src = readSource(DOCTOR, 'utf8');
    assert.match(src, /import \{ classifyClaudeInstall \} from '\.\.\/\.\.\/src\/core\/claude-install\.js'/,
        'doctor must import from shared claude-install module');
    assert.ok(!src.includes('function classifyClaudeInstall'),
        'doctor must NOT define its own classifyClaudeInstall');
});

test('SRH-014: install.sh handles network failure gracefully', () => {
    const src = readSource(INSTALL_SH, 'utf8');
    assert.ok(src.includes('Could not fetch latest version'),
        'install.sh must warn on npm view failure');
    assert.ok(src.includes('keeping existing'),
        'install.sh must keep existing install on network failure');
});

test('SRH-015: install.sh detects package manager from install path', () => {
    const src = readSource(INSTALL_SH, 'utf8');
    // 260804: bun skips lifecycle scripts for untrusted packages; --trust is
    // the only surface that runs them for a global add.
    assert.ok(src.includes('bun add -g --trust cli-jaw'),
        'install.sh must use bun for bun-managed installs');
    assert.ok(src.includes('Detected bun-managed install'),
        'install.sh must inform about bun detection');
});

test('SRH-016: install.sh verifies binary after install', () => {
    const src = readSource(INSTALL_SH, 'utf8');
    assert.ok(src.includes('binary not responding'),
        'install.sh must warn if post-install verification fails');
    assert.ok(src.includes('get_installed_jaw_binary') && src.includes('get_binary_version'),
        'install.sh must re-resolve binary after install');
});

test('SRH-017: install.sh has shell-level classify_claude_install_sh', () => {
    const src = readSource(INSTALL_SH, 'utf8');
    assert.ok(src.includes('classify_claude_install_sh()'),
        'install.sh must define classify_claude_install_sh helper');
    assert.ok(src.includes('mirrors src/core/claude-install.ts'),
        'install.sh must document that shell classifier mirrors TS module');
});

test('SRH-018: runtime-path includes deno and keg-only node paths', () => {
    const src = readSource(path.join(ROOT, 'src/core/runtime-path.ts'), 'utf8');
    assert.ok(src.includes("'.deno', 'bin'"),
        'runtime-path must include deno bin');
    assert.ok(src.includes("'/opt/homebrew/opt/node@22/bin'"),
        'runtime-path must include keg-only node@22');
});

test('SRH-019: postbuild does not signal live dashboard managers', () => {
    const pkg = JSON.parse(readSource(path.join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
    };
    const postbuild = pkg.scripts?.postbuild || '';
    assert.match(postbuild, /link-current-nvm-bin\.cjs/,
        'postbuild should keep current nvm bin linking');
    assert.doesNotMatch(postbuild, /signal-dashboard-restart\.mjs/,
        'npm run build must not signal or restart live dashboard managers');
    assert.doesNotMatch(postbuild, /SIGUSR2|kill|pkill|pgrep/,
        'postbuild must remain free of process-control side effects');
});
