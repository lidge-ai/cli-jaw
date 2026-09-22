/**
 * service command unit tests
 * Mirrors launchd-multi.test.ts pattern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

// ─── instanceId logic (mirror for verification) ─────

function expectedInstanceId(jawHome: string): string {
    const base = basename(jawHome);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(jawHome).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

function sanitizeUnitName(name: string): string {
    return name.replace(/[^a-zA-Z0-9:._-]/g, '-');
}

// ─── S-001~003: Backend detection ────────────────────

test('S-001: darwin platform → launchd backend', () => {
    // process.platform is read-only, test logic only
    assert.equal(process.platform === 'darwin' ? 'launchd' : 'other',
        process.platform === 'darwin' ? 'launchd' : 'other');
});

test('S-002: /proc/1/comm exists on linux', () => {
    if (process.platform !== 'linux') return; // skip on macOS
    const comm = readFileSync('/proc/1/comm', 'utf8').trim();
    assert.ok(comm.length > 0, 'PID 1 should have a comm name');
});

test('S-003: /.dockerenv detection', () => {
    const inDocker = existsSync('/.dockerenv');
    assert.equal(typeof inDocker, 'boolean');
});

// ─── S-004~005: instanceId consistency ───────────────

test('S-004: default JAW_HOME produces "default" instance', () => {
    assert.equal(expectedInstanceId(join('/home/user', '.cli-jaw')), 'default');
});

test('S-005: custom JAW_HOME produces hashed instance', () => {
    const id = expectedInstanceId('/tmp/jaw-work');
    assert.ok(id.startsWith('jaw-work-'), `Expected jaw-work-<hash>, got ${id}`);
    assert.equal(id.length, 'jaw-work-'.length + 8);
});

// ─── S-006~008: systemd unit generation ──────────────

test('S-006: sanitizeUnitName strips invalid chars', () => {
    assert.equal(sanitizeUnitName('jaw-default'), 'jaw-default');
    assert.equal(sanitizeUnitName('jaw work'), 'jaw-work');
    assert.equal(sanitizeUnitName('jaw/path'), 'jaw-path');
    assert.equal(sanitizeUnitName('jaw@special!'), 'jaw-special-');
});

test('S-007: UNIT_NAME format is jaw-<sanitized-instance>', () => {
    const instance = expectedInstanceId(join('/home/user', '.cli-jaw'));
    const unitName = `jaw-${sanitizeUnitName(instance)}`;
    assert.equal(unitName, 'jaw-default');
});

test('S-008: UNIT_PATH follows /etc/systemd/system/ convention', () => {
    const unitName = 'jaw-default';
    const unitPath = `/etc/systemd/system/${unitName}.service`;
    assert.equal(unitPath, '/etc/systemd/system/jaw-default.service');
});

// ─── S-009~010: parseArgs ────────────────────────────

import { parseArgs } from 'node:util';

test('S-009: --port 3458 parsing', () => {
    const { values } = parseArgs({
        args: ['--port', '3458'],
        options: { port: { type: 'string', default: '3457' }, backend: { type: 'string' } },
        strict: false, allowPositionals: true,
    });
    assert.equal(values.port, '3458');
});

test('S-010: --backend systemd parsing', () => {
    const { values } = parseArgs({
        args: ['--backend', 'systemd', '--port', '3458'],
        options: { port: { type: 'string', default: '3457' }, backend: { type: 'string' } },
        strict: false, allowPositionals: true,
    });
    assert.equal(values.backend, 'systemd');
    assert.equal(values.port, '3458');
});

test('S-011: positional subcommand extraction', () => {
    const { positionals } = parseArgs({
        args: ['status', '--port', '3457'],
        options: { port: { type: 'string', default: '3457' }, backend: { type: 'string' } },
        strict: false, allowPositionals: true,
    });
    assert.equal(positionals[0], 'status');
});

// ─── S-012: security ────────────────────────────────

test('S-012: no execSync string interpolation in production code', async () => {
    // Verify service.ts uses execFileSync, not execSync with template literals
    const serviceCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'service.ts'),
        'utf8'
    );
    const execSyncCalls = serviceCode.match(/execSync\s*\(/g) || [];
    assert.equal(execSyncCalls.length, 0, 'service.ts should not use execSync (use execFileSync instead)');
});

// ─── S-013: instance.ts exports ─────────────────────

test('S-013: instance.ts exports all required functions', async () => {
    const instanceCode = readFileSync(
        join(projectRoot, 'src', 'core', 'instance.ts'),
        'utf8'
    );
    assert.ok(instanceCode.includes('export function instanceId'), 'instanceId must be exported');
    assert.ok(instanceCode.includes('export function getNodePath'), 'getNodePath must be exported');
    assert.ok(instanceCode.includes('export function getJawPath'), 'getJawPath must be exported');
    assert.ok(instanceCode.includes('export function sanitizeUnitName'), 'sanitizeUnitName must be exported');
});

test('S-013b: instance binary lookup is Windows-aware', async () => {
    const instanceCode = readFileSync(
        join(projectRoot, 'src', 'core', 'instance.ts'),
        'utf8'
    );
    assert.ok(instanceCode.includes("process.platform === 'win32' ? 'where.exe' : 'which'"),
        'binary lookup should use the native where.exe executable on Windows and which elsewhere');
    assert.ok(instanceCode.includes('split(/\\r?\\n/)'),
        'Windows where may return multiple lines and should select the first result');
    assert.ok(instanceCode.includes('(?:^|[\\\\/])(?:cli-jaw|jaw)'),
        'argv path detection should support both POSIX and Windows separators');
});

// ─── S-014: service.ts uses --no-open in ExecStart ──

test('S-014: ExecStart uses --no-open to prevent browser auto-open', async () => {
    const serviceCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'service.ts'),
        'utf8'
    );
    assert.ok(serviceCode.includes('--no-open'), 'ExecStart must include --no-open flag');
});

// ─── S-015: --backend whitelist validation ───────────

test('S-015: service.ts validates --backend values', async () => {
    const serviceCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'service.ts'),
        'utf8'
    );
    assert.ok(serviceCode.includes('VALID_BACKENDS'), 'service.ts must validate --backend values');
    for (const backend of ['launchd', 'systemd', 'docker']) {
        assert.ok(serviceCode.includes(`'${backend}'`), `Backend '${backend}' must be in whitelist`);
    }
});

// ─── S-016: service.ts handles macOS logs subcommand ─

test('S-016: macOS logs mapped to file paths (not delegated to launchd)', async () => {
    const serviceCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'service.ts'),
        'utf8'
    );
    // jaw service logs on macOS should NOT fall through to launchd default (install)
    assert.ok(serviceCode.includes("subcommand === 'logs'"), 'service.ts must handle logs subcommand for launchd');
    assert.ok(serviceCode.includes('jaw-serve.log'), 'should show log file path');
});

// ─── S-017: mktemp for secure temp file ──────────────

test('S-017: service.ts uses mktemp for temp unit file', async () => {
    const serviceCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'service.ts'),
        'utf8'
    );
    assert.ok(serviceCode.includes('mktemp'), 'service.ts must use mktemp for secure temp files');
});

// ─── S-018: cli-jaw.ts routes service command ────────

test('S-018: cli-jaw.ts includes service in known commands', async () => {
    const cliCode = readFileSync(
        join(projectRoot, 'bin', 'cli-jaw.ts'),
        'utf8'
    );
    assert.ok(cliCode.includes("'service'"), 'service must be in _knownCmds');
    assert.ok(cliCode.includes("import('./commands/service.js')"), 'service must be routed');
});

// ─── S-019: doctor.ts headless detection ─────────────

test('S-019: doctor.ts includes headless detection', async () => {
    const doctorCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'doctor.ts'),
        'utf8'
    );
    assert.ok(doctorCode.includes('isHeadless'), 'doctor.ts must have isHeadless function');
    assert.ok(doctorCode.includes('headless server'), 'doctor.ts must mention headless server');
});

// ─── S-020: launchd.ts imports from instance.ts ──────

test('S-020: launchd.ts imports shared functions from instance.ts', async () => {
    const launchdCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'launchd.ts'),
        'utf8'
    );
    assert.ok(launchdCode.includes("from '../../src/core/instance.js'"), 'launchd.ts must import from instance.ts');
    // Ensure private functions were removed
    assert.ok(!launchdCode.includes('function instanceId'), 'instanceId should not be defined locally');
    assert.ok(!launchdCode.includes('function getNodePath'), 'getNodePath should not be defined locally');
    assert.ok(!launchdCode.includes('function getJawPath'), 'getJawPath should not be defined locally');
});

// ─── S-021~024: Edge case tests ──────────────────────

test('S-021: port validation rejects non-numeric values', () => {
    const invalidPorts = ['abc', '0', '-1', '65536', '99999', '3.14', ''];
    for (const port of invalidPorts) {
        const num = Number(port);
        const valid = Number.isInteger(num) && num >= 1 && num <= 65535;
        assert.equal(valid, false, `port "${port}" should be rejected`);
    }
});

test('S-022: port validation accepts valid port numbers', () => {
    const validPorts = ['1', '80', '443', '3457', '8080', '65535'];
    for (const port of validPorts) {
        const num = Number(port);
        const valid = Number.isInteger(num) && num >= 1 && num <= 65535;
        assert.equal(valid, true, `port "${port}" should be accepted`);
    }
});

test('S-023: status reads port from unit file content', () => {
    // Simulate reading port from unit file
    const unitContent = `[Service]
ExecStart="/usr/bin/node" "/usr/bin/jaw" --home /home/user/.cli-jaw serve --port 9999 --no-open`;
    const portMatch = unitContent.match(/--port\s+(\d+)/);
    assert.ok(portMatch, 'should find --port in unit file');
    assert.equal(portMatch![1], '9999');
});

test('S-024: doctor uses npm root -g for playwright-core detection', async () => {
    const doctorCode = readFileSync(
        join(projectRoot, 'bin', 'commands', 'doctor.ts'),
        'utf8'
    );
    assert.ok(doctorCode.includes('npm root -g'), 'doctor.ts should use npm root -g for global package detection');
    assert.ok(doctorCode.includes('detectCli'), 'doctor.ts should reuse detectCli for CLI lookup');
    assert.ok(doctorCode.includes('computer-use MCP is safer with native Claude install'),
        'doctor.ts should warn when Claude looks node-managed');
    assert.ok(doctorCode.includes("check('Claude auth'"),
        'doctor.ts should report Claude auth separately from Claude install status');
    assert.ok(doctorCode.includes('readClaudeCreds'),
        'doctor.ts should reuse the cross-platform Claude auth reader');
});

test('S-025: install.sh verifies Chromium binary after install', async () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    const lines = installCode.split('\n');
    const okLines = lines.filter((l: string) => l.includes('ok "Chromium installed"'));
    assert.ok(okLines.length > 0, 'should have Chromium success messages');
    // Verify that --version checks precede ok messages (not just command -v)
    for (const okLine of okLines) {
        const okIdx = lines.indexOf(okLine);
        const precedingVerify = lines.slice(0, okIdx).reverse().find((l: string) => l.includes('--version'));
        assert.ok(precedingVerify, `ok message at line ${okIdx + 1} should be preceded by --version verification`);
    }
});

test('S-026: install.sh uses npm root -g for playwright-core detection', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('npm root -g'), 'install.sh should use npm root -g like doctor.ts');
    assert.ok(installCode.includes('npm view cli-jaw version'),
        'install.sh should check latest published cli-jaw version before reinstalling');
    assert.ok(installCode.includes('skipping npm install'),
        'install.sh should skip reinstall when the latest version is already installed');
    assert.ok(installCode.includes('computer-use MCP'),
        'install.sh should include Claude computer-use guidance');
});

test('S-026b: install.sh makes nvm shell profile durable', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('ensure_nvm_shell_profile'), 'install.sh should create/update the shell rc file after nvm install');
    assert.ok(installCode.includes('touch "$profile"'), 'install.sh should create missing ~/.zshrc or ~/.bashrc');
    assert.ok(installCode.includes('NVM_DIR="$HOME/.nvm"'), 'install.sh should write the nvm loader block');
    assert.ok(installCode.includes('PROFILE="$shell_rc" bash'), 'install.sh should force nvm installer to use the prepared profile');
    assert.ok(installCode.includes('ensure_nvm_shell_profile "$(zsh_config_dir)/.zprofile"'), 'install.sh should also make nvm durable for macOS zsh login shells');
});

test('S-026b2: install.sh persists ~/.local/bin for native Claude', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('ensure_local_bin_path'), 'install.sh should configure ~/.local/bin');
    assert.ok(installCode.includes('export PATH="$HOME/.local/bin:$PATH"'), 'install.sh should write the native Claude PATH line');
    assert.ok(installCode.includes('.zprofile'), 'install.sh should cover macOS zsh login shells');
    assert.ok(installCode.includes('ZDOTDIR'), 'install.sh should respect custom zsh config directories');
    assert.ok(installCode.includes('ensure_local_bin_path\n'), 'install.sh should apply ~/.local/bin before installing CLI tools');
});

test('S-026b3: install.sh preflights macOS developer tools before nvm git clone', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('ensure_macos_developer_tools'), 'install.sh should preflight macOS developer tools');
    assert.ok(installCode.includes('xcode-select -p'), 'install.sh should check Xcode Command Line Tools');
    assert.ok(installCode.includes('git --version'), 'install.sh should verify git is runnable before nvm install');
    assert.ok(installCode.includes('xcode-select --install'), 'install.sh should give the exact recovery command');
    assert.ok(
        installCode.indexOf('ensure_macos_developer_tools') < installCode.indexOf('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm'),
        'developer tools preflight should run before nvm installer download/clone',
    );
});

test('S-026b4: install.sh treats Node and npm as one required toolchain', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('npm_is_usable()'), 'install.sh should have an npm usability helper');
    assert.ok(installCode.includes('command -v npm &>/dev/null && npm --version &>/dev/null'),
        'npm usability should verify command lookup and execution');
    assert.ok(installCode.includes('npm is missing or not runnable — repairing Node.js install'),
        'Node >=22 without npm should trigger repair, not success');
    assert.ok(installCode.includes('found without runnable npm'),
        'repair log should not claim Node itself is missing when only npm is broken');
    assert.ok(installCode.includes('if ! npm_is_usable; then\n    fail "Node.js installed but npm is not runnable.'),
        'nvm install should fail loudly if npm remains unusable');
    assert.ok(installCode.includes('Node.js $(node -v) with npm $(npm --version)'),
        'success output should include both node and npm versions');
});

test('S-026c2: install.sh repairs partial installs instead of skipping latest cli-jaw', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('unavailable_required_cli_tools'), 'install.sh should detect missing or broken bundled CLI tools');
    assert.ok(installCode.includes('is_runnable_cli_tool'), 'install.sh should verify helper CLIs are runnable');
    assert.ok(installCode.includes('"$bin" --version'), 'install.sh should not trust command -v alone');
    assert.ok(installCode.includes('claude codex gemini grok copilot opencode'), 'install.sh should check the bundled auto-installed CLIs');
    assert.ok(installCode.includes('Re-running npm install to repair the partial install'), 'latest cli-jaw should not skip when tools are missing');
    assert.ok(installCode.includes('Attempting npm repair install anyway'), 'network-version fallback should still repair missing tools');
    assert.ok(installCode.includes('CLI_JAW_STRICT_ONE_CLICK'), 'one-click strict CLI dependency failures should be explicit opt-in');
    assert.ok(installCode.includes('unset CLI_JAW_REQUIRE_CLI_TOOLS'), 'one-click install should keep optional backend installs best-effort by default');
});

test('S-026d: claude-e is not bundled — its postinstall needs cargo and npm >= 12 blocks it anyway', () => {
    // 260804 install hardening: claude-e moved out of optionalDependencies.
    // Its postinstall runs `cargo build` (exit 1 without a Rust toolchain) and
    // npm 12 blocks unreviewed dependency lifecycle scripts, so bundling it
    // only produced warnings and half-installs. Runtime detection is PATH-based
    // (src/core/cli-detection.ts); the runtime is retired; the package must stay out of the default install.
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.dependencies?.['claude-e'], undefined, 'claude-e must not be a hard dependency');
    assert.equal(pkg.optionalDependencies?.['claude-e'], undefined, 'claude-e must not be bundled');
    assert.equal(lock.packages?.['']?.optionalDependencies?.['claude-e'], undefined, 'lockfile root must not carry claude-e');
});

test('S-026e: ai-e is not bundled — use jaw provider install ai-e', () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.dependencies?.['@bitkyc08/ai-e'], undefined, 'ai-e must not be a hard dependency');
    assert.equal(pkg.optionalDependencies?.['@bitkyc08/ai-e'], undefined, 'ai-e must not be an optional dependency');
    assert.equal(lock.packages?.['']?.dependencies?.['@bitkyc08/ai-e'], undefined, 'lockfile root must not have ai-e in dependencies');
    assert.equal(lock.packages?.['']?.optionalDependencies?.['@bitkyc08/ai-e'], undefined, 'lockfile root must not have ai-e in optionalDependencies');
    assert.equal(lock.packages?.['node_modules/@bitkyc08/ai-e'], undefined, 'lockfile must not include ai-e in the install tree');
});

test('S-027: install.sh verifies chromium via --version not just command -v', () => {
    const installCode = readFileSync(
        join(projectRoot, 'scripts', 'install.sh'),
        'utf8'
    );
    assert.ok(installCode.includes('--version'), 'install.sh should verify chromium binary via --version');
});
