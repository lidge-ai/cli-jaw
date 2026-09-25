import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
import { readSource } from './source-normalize.js';
import {
    classifyInstallerFromPath,
    findRunnableCliBinary,
    installCliTools,
    removeJawHomeClaudeInstructionFile,
    shouldDedupeCliTools,
    shouldForceClaudeDuringPostinstall,
    shouldInstallClaudeDuringPostinstall,
    shouldInstallCliToolsDuringPostinstall,
} from '../../bin/postinstall.js';
import { classifyClaudeInstall } from '../../src/core/claude-install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const postinstallSrc = readSource(join(__dirname, '../../bin/postinstall.ts'), 'utf8');
const initSrc = readSource(join(__dirname, '../../bin/commands/init.ts'), 'utf8');
const officeCliShellSrc = readSource(join(__dirname, '../../scripts/install-officecli.sh'), 'utf8');
const officeCliPowerShellSrc = readSource(join(__dirname, '../../scripts/install-officecli.ps1'), 'utf8');
const readmeSrc = readSource(join(__dirname, '../../README.md'), 'utf8');
const localizedReadmeSrc = [
    readSource(join(__dirname, '../../README.ko.md'), 'utf8'),
    readSource(join(__dirname, '../../README.zh-CN.md'), 'utf8'),
    readSource(join(__dirname, '../../README.ja.md'), 'utf8'),
].join('\n');
const postinstallWorkflowSrc = readSource(join(__dirname, '../../.github/workflows/postinstall-platform.yml'), 'utf8');
const freshInstallSmokeSrc = readSource(join(__dirname, '../../scripts/fresh-install-smoke.ts'), 'utf8');
const freshInstallEvidenceSrc = readSource(join(__dirname, '../../scripts/collect-fresh-install-evidence.sh'), 'utf8');
const freshInstallEvidenceAuditSrc = readSource(join(__dirname, '../../scripts/audit-fresh-install-evidence.mjs'), 'utf8');
const requireReleaseEvidenceSrc = readSource(join(__dirname, '../../scripts/require-release-evidence.mjs'), 'utf8');
const releaseScriptSrc = readSource(join(__dirname, '../../scripts/promote-to-main.sh'), 'utf8');
const releasePreviewScriptSrc = readSource(join(__dirname, '../../scripts/release-preview.sh'), 'utf8');
const gitattributesSrc = readSource(join(__dirname, '../../.gitattributes'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const repoRoot = join(__dirname, '../..');

function writeCli(dir: string, name: string, content: string): string {
    const filePath = join(dir, name);
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o755);
    return filePath;
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

async function captureConsole(fn: () => void | Promise<void>): Promise<string> {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
        await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
    return logs.join('\n');
}

// ── SAF-001: safe guard with JAW_SAFE ──

test('SAF-001: postinstall has JAW_SAFE safe mode guard', () => {
    assert.ok(postinstallSrc.includes("JAW_SAFE === '1'"), 'checks JAW_SAFE');
    assert.ok(postinstallSrc.includes("JAW_SAFE === 'true'"), 'checks JAW_SAFE=true');
});

// ── SAF-002: safe guard with npm_config_jaw_safe ──

test('SAF-002: postinstall has npm_config_jaw_safe guard', () => {
    assert.ok(postinstallSrc.includes("npm_config_jaw_safe === '1'"), 'checks npm_config_jaw_safe=1');
    assert.ok(postinstallSrc.includes("npm_config_jaw_safe === 'true'"), 'checks npm_config_jaw_safe=true');
});

test('SAF-002b: README documents safe install/update before normal install', () => {
    const safePos = readmeSrc.indexOf('JAW_SAFE=1 npm install -g cli-jaw');
    const normalPos = readmeSrc.indexOf('npm install -g cli-jaw');
    assert.ok(safePos >= 0, 'README should document macOS/Linux JAW_SAFE install');
    assert.equal(readmeSrc.includes('$env:JAW_SAFE="1"; npm install -g cli-jaw'), false, 'README must not present native PowerShell as a supported install path');
    // The prose moved into the canonical windows-support block (#373). The contract is
    // unchanged: WSL is the recommended path and native PowerShell is beta, not a
    // supported JAW_SAFE install route.
    assert.ok(
        readmeSrc.includes('WSL is the recommended, stable path'),
        'README should scope Windows installs to WSL',
    );
    assert.ok(readmeSrc.includes('skips optional tool/runtime setup'), 'README should explain safe install boundary');
    assert.ok(safePos <= normalPos, 'safe install should appear before normal install example');
});

test('SAF-002c: README default install claim matches postinstall CLI-tool gating', () => {
    assert.ok(readmeSrc.includes('The default npm install initializes CLI-JAW and attempts native Claude setup'));
    assert.ok(readmeSrc.includes('CLI_JAW_INSTALL_CLI_TOOLS=1 npm install -g cli-jaw'));
    assert.ok(readmeSrc.includes('On Windows, use the WSL install path below'));
    assert.equal(readmeSrc.includes('$env:CLI_JAW_INSTALL_CLI_TOOLS="1"; npm install -g cli-jaw'), false, 'README must not advertise native PowerShell optional CLI install');
    assert.equal(
        readmeSrc.includes('automatically sets up Claude, Codex, Gemini, Copilot, and OpenCode CLIs for you'),
        false,
        'README must not promise full optional CLI setup for default npm install',
    );
});

// ── SAF-003: safe guard exits early ──

test('SAF-003: safe mode returns early (no side effects)', () => {
    const guardStart = postinstallSrc.indexOf('if (isSafeMode)');
    const guardBlock = postinstallSrc.slice(guardStart, guardStart + 500);
    assert.ok(guardBlock.includes('return'), 'returns early in safe mode');
    assert.ok(guardBlock.includes('safe mode'), 'prints safe mode message');
});

test('SAF-003b: postinstall guard safe mode exits before build fallback', () => {
    const result = spawnSync(process.execPath, ['scripts/postinstall-guard.cjs'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            JAW_SAFE: '1',
        },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /safe mode/i);
    assert.doesNotMatch(output, /dist\/ not found, building/i);
    assert.doesNotMatch(output, /setup complete/i);
});

// ── SAF-004: installCliTools exported ──

test('SAF-004: installCliTools is exported', () => {
    assert.ok(postinstallSrc.includes('export async function installCliTools'), 'installCliTools exported');
});

test('SAF-004a: postinstall removes deprecated Jaw-home CLAUDE.md symlink instead of creating one', () => {
    assert.ok(!postinstallSrc.includes('CLAUDE.md → AGENTS.md symlink'), 'must not create CLAUDE.md symlink');
    assert.ok(postinstallSrc.includes('removeJawHomeClaudeInstructionFile(jawHome)'), 'runPostinstall must clean deprecated CLAUDE.md');
});

test('SAF-004a1: deprecated CLAUDE.md symlink to AGENTS.md is removed', { skip: process.platform === 'win32' }, () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'jaw-claude-clean-'));
    try {
        const agents = join(dir, 'AGENTS.md');
        const claude = join(dir, 'CLAUDE.md');
        fs.writeFileSync(agents, 'SYSTEM PROMPT\n');
        fs.symlinkSync(agents, claude);

        assert.equal(removeJawHomeClaudeInstructionFile(dir), 'removed-symlink');
        assert.equal(fs.existsSync(claude), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('SAF-004a2: generated CLAUDE.md mirror is removed but custom file is kept', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'jaw-claude-clean-'));
    try {
        const agents = join(dir, 'AGENTS.md');
        const claude = join(dir, 'CLAUDE.md');
        fs.writeFileSync(agents, 'SYSTEM PROMPT\n');
        fs.writeFileSync(claude, 'SYSTEM PROMPT\n');

        assert.equal(removeJawHomeClaudeInstructionFile(dir), 'removed-mirror');
        assert.equal(fs.existsSync(claude), false);

        fs.writeFileSync(claude, 'custom claude guidance\n');
        assert.equal(removeJawHomeClaudeInstructionFile(dir), 'kept-custom');
        assert.equal(fs.readFileSync(claude, 'utf8'), 'custom claude guidance\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('SAF-004b: postinstall skips CLI tool install/update by default', () => {
    assert.equal(shouldInstallCliToolsDuringPostinstall({}), false);
    assert.equal(shouldInstallCliToolsDuringPostinstall({ CLI_JAW_INSTALL_CLI_TOOLS: '1' }), true);
    assert.equal(shouldInstallCliToolsDuringPostinstall({ npm_config_jaw_install_cli_tools: 'true' }), true);
    assert.equal(shouldInstallClaudeDuringPostinstall({}), true);
    assert.equal(shouldInstallClaudeDuringPostinstall({ CLI_JAW_SKIP_CLAUDE: '1' }), false);
    assert.equal(shouldInstallClaudeDuringPostinstall({ npm_config_jaw_skip_claude: 'true' }), false);
    assert.equal(shouldForceClaudeDuringPostinstall({}), false);
    assert.equal(shouldForceClaudeDuringPostinstall({ CLI_JAW_FORCE_CLAUDE: '1' }), true);
    assert.equal(shouldForceClaudeDuringPostinstall({ npm_config_jaw_force_claude: 'true' }), true);

    const runBlock = postinstallSrc.slice(postinstallSrc.indexOf('export async function runPostinstall'));
    assert.ok(runBlock.includes('shouldInstallCliToolsDuringPostinstall()'), 'runPostinstall must gate installCliTools');
    assert.ok(runBlock.includes('shouldInstallClaudeDuringPostinstall()'), 'runPostinstall must install Claude unless explicitly skipped');
    assert.ok(runBlock.includes('CLI tool install/update skipped by default'), 'default skip must be visible');
});

test('SAF-004c: duplicate CLI uninstall is opt-in', () => {
    assert.equal(shouldDedupeCliTools({}), false);
    assert.equal(shouldDedupeCliTools({ CLI_JAW_DEDUPE_CLI_TOOLS: '1' }), true);
    assert.equal(shouldDedupeCliTools({ npm_config_jaw_dedupe_cli_tools: 'true' }), true);

    const dedupeBlock = postinstallSrc.slice(postinstallSrc.indexOf('function deduplicateCliTool'));
    assert.ok(dedupeBlock.includes('shouldDedupeCliTools()'), 'dedupe must be opt-in before uninstall');
    assert.ok(dedupeBlock.includes('not removing automatically'), 'dedupe default must avoid uninstalling user tools');
});

test('SAF-004c2: npm duplicate cleanup only runs after cli-jaw installs npm', () => {
    const dedupeBlock = postinstallSrc.slice(postinstallSrc.indexOf('function deduplicateCliTool'));
    assert.ok(dedupeBlock.includes('preferredActive?: PkgMgr'), 'dedupe should accept the manager postinstall intentionally used');
    assert.ok(dedupeBlock.includes('isInstalledVia(preferredActive'), 'dedupe should verify the preferred manager was actually installed');
    assert.ok(
        postinstallSrc.includes("deduplicateCliTool(bin, pkg, brew, 'npm')"),
        'dedupe should prefer npm only when cli-jaw actually installed npm',
    );
    assert.ok(!postinstallSrc.includes('deduplicateCliTool(bin, pkg, brew, forceMgr)'), 'forceMgr should not force duplicate cleanup');
});

test('SAF-004d: Homebrew Node npm globals are classified as npm before brew', () => {
    assert.equal(
        classifyInstallerFromPath('/opt/homebrew/bin/codex', {
            binName: 'codex',
            npmPrefix: '/opt/homebrew',
            realPath: '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
        }),
        'npm',
    );
    assert.equal(
        classifyInstallerFromPath('/usr/local/bin/gemini', {
            binName: 'gemini',
            npmPrefix: '/usr/local',
            realPath: '/usr/local/lib/node_modules/@google/gemini-cli/dist/index.js',
        }),
        'npm',
    );
    assert.equal(
        classifyInstallerFromPath('/opt/homebrew/bin/gemini', {
            binName: 'gemini',
            npmPrefix: '/opt/homebrew',
            realPath: '/opt/homebrew/Cellar/gemini-cli/1.2.3/bin/gemini',
        }),
        'brew',
    );
    assert.equal(
        classifyInstallerFromPath('/opt/homebrew/bin/codex', {
            binName: 'codex',
            npmPrefix: '/Users/test/.nvm/versions/node/v22.0.0',
            realPath: '/opt/homebrew/bin/codex',
        }),
        null,
    );
});

test('SAF-004e: Claude CLI install uses the official native installer', () => {
    const cliBlock = postinstallSrc.slice(
        postinstallSrc.indexOf('function buildClaudeNativeInstallCmd'),
        postinstallSrc.indexOf('const MCP_PACKAGES'),
    );
    assert.ok(postinstallSrc.includes('https://claude.ai/install.sh'), 'Claude install should use the official native installer');
    assert.ok(postinstallSrc.includes('https://claude.ai/install.ps1'), 'win32 Claude branch should use the official installer URL');
    assert.ok(cliBlock.includes('CLAUDE_NATIVE_INSTALL_URL'), 'Claude install command should route through the native installer URL');
    assert.ok(cliBlock.includes('CLAUDE_NATIVE_INSTALL_PS_URL'), 'Windows Claude install command should route through the native installer URL');
    // runTool() is the shell-free execFileSync wrapper introduced for #274; the
    // property being asserted is unchanged (no cmd.exe nested quote parsing).
    assert.ok(cliBlock.includes('runTool('), 'Windows Claude install should avoid cmd.exe nested quote parsing');
    assert.ok(cliBlock.includes('findClaudeNativeBinary'), 'postinstall should verify the native Claude binary location');
    assert.ok(cliBlock.includes('findExistingClaudeBinary'), 'postinstall should check existing Claude before installing');
    assert.ok(cliBlock.includes('isSpawnableCliFile'), 'postinstall should avoid accepting broken Unix Claude shims as existing installs');
    assert.ok(cliBlock.includes('findExistingCliBinary'), 'postinstall existing-Claude detection should use the shared PATH scanner');
    assert.ok(postinstallSrc.includes('findRunnableCliBinary(name'), 'shared existing-CLI detection should scan all PATH candidates');
    assert.ok(cliBlock.includes('claude already works'), 'postinstall should skip reinstalling existing Claude by default');
    assert.ok(cliBlock.includes('shouldForceClaudeDuringPostinstall()'), 'postinstall should expose an explicit force-update path for native Claude');
    assert.ok(cliBlock.includes('claude (native installer)'), 'strict failure reporting should identify the native installer path');
    assert.ok(cliBlock.includes('isRunnableClaudeBinary(nativePath)'), 'native Claude install success should require --version verification');
    assert.ok(!cliBlock.includes("process.platform === 'win32' && found"), 'Windows success must require a native Claude binary');
});

test('SAF-004e1: Claude postinstall skips runnable existing CLIs, including Bun/npm installs', () => {
    const installBlock = postinstallSrc.slice(
        postinstallSrc.indexOf('function isRunnableClaudeBinary'),
        postinstallSrc.indexOf('/** Check if a package is installed via a specific manager'),
    );
    assert.ok(installBlock.includes('function isRunnableClaudeBinary'), 'existing Claude should be validated by execution');
    assert.ok(installBlock.includes('isRunnableCliBinary'), 'validation should use the shared --version check');
    assert.ok(postinstallSrc.includes('export function findRunnableCliBinary'), 'runnable existing Claude should be selected by shared runnable scanner');
    assert.ok(installBlock.includes('claude already works'), 'postinstall should still skip working existing Claude');
    assert.ok(!installBlock.includes('non-native claude detected'), 'postinstall must not treat Bun/npm Claude as broken solely by installer kind');
});

test('SAF-004e1b: Claude runnable check is explicit for Windows and Unix', () => {
    const checkBlock = postinstallSrc.slice(
        postinstallSrc.indexOf('function runCliVersionCheck'),
        postinstallSrc.indexOf('function isRunnableClaudeBinary'),
    );
    assert.ok(checkBlock.includes("process.platform === 'win32'"), 'Windows must use its own version-check branch');
    assert.ok(checkBlock.includes("runTool('powershell'"), 'Windows check should use PowerShell for .cmd/.exe paths');
    assert.ok(checkBlock.includes("'& $args[0] --version'"), 'PowerShell should invoke the detected Claude path safely');
    assert.ok(checkBlock.includes("runTool(binaryPath, ['--version']"), 'macOS/Linux should run the detected binary directly');
});

test('SAF-004e1c: Windows native Claude detection accepts LOCALAPPDATA install roots', () => {
    const claudeInstallSrc = fs.readFileSync(join(__dirname, '../../src/core/claude-install.ts'), 'utf8');
    const postinstallRawSrc = fs.readFileSync(join(__dirname, '../../bin/postinstall.ts'), 'utf8');
    assert.ok(claudeInstallSrc.includes('process.env["LOCALAPPDATA"]') || claudeInstallSrc.includes("process.env['LOCALAPPDATA']"), 'classifier should consider Windows user-local app installs');
    assert.ok(claudeInstallSrc.includes("'Programs', 'Claude', 'claude.exe'"), 'classifier should include common LOCALAPPDATA program paths');
    assert.ok(postinstallRawSrc.includes('process.env["LOCALAPPDATA"]') || postinstallRawSrc.includes("process.env['LOCALAPPDATA']"), 'postinstall should scan LOCALAPPDATA candidates after native installer runs');
    assert.ok(postinstallSrc.includes("expected a working native claude binary"), 'failure hint should not claim only the old narrow paths');
});

test('SAF-004e2: Claude native install classification covers Windows native path', () => {
    assert.equal(classifyClaudeInstall(join(os.homedir(), '.local', 'bin', 'claude')), 'native');
    assert.equal(classifyClaudeInstall(join(os.homedir(), '.local', 'bin', 'claude.exe')), 'native');
});

test('SAF-004f: bundled non-Claude CLI tools preserve runnable installs before using npm', () => {
    const packageBlock = postinstallSrc.slice(
        postinstallSrc.indexOf('const CLI_PACKAGES'),
        postinstallSrc.indexOf('type PkgMgr'),
    );
    assert.ok(packageBlock.includes("{ bin: 'codex', pkg: '@openai/codex' }"), 'codex should be listed');
    assert.ok(packageBlock.includes("{ bin: 'gemini', pkg: '@google/gemini-cli' }"), 'gemini should be listed');
    assert.ok(packageBlock.includes("{ bin: 'grok', pkg: 'Grok Build', installer: 'xai-native' }"), 'grok should use the official xAI native installer');
    assert.ok(packageBlock.includes("{ bin: 'copilot', pkg: '@github/copilot' }"), 'copilot should be listed');
    assert.ok(packageBlock.includes("{ bin: 'opencode', pkg: 'opencode-ai' }"), 'opencode should be listed');
    assert.ok(!packageBlock.includes('forceMgr'), 'non-Claude CLIs should not force-reinstall over another package manager');
    assert.ok(!packageBlock.includes("brew: 'gemini-cli'"), 'gemini should not route through brew');

    const installBlock = postinstallSrc.slice(postinstallSrc.indexOf('export async function installCliTools'));
    assert.ok(installBlock.includes('const existingPath = findExistingCliBinary(bin)'), 'install should detect existing CLIs first');
    assert.ok(postinstallSrc.includes('export function findRunnableCliBinary(name'), 'existing CLIs should be validated by --version');
    assert.ok(installBlock.includes('${bin} already works'), 'runnable existing CLIs should be skipped');
    assert.ok(installBlock.includes("buildInstallCmd('npm', pkg, brew)"), 'missing or broken CLIs should install via npm');
    assert.ok(postinstallSrc.includes('https://x.ai/cli/install.sh'), 'Grok should install through the official xAI installer');
    assert.ok(postinstallSrc.includes('native PowerShell CLI-JAW install is unsupported'), 'Grok native installer should not expand CLI-JAW support to native PowerShell');
    assert.ok(!installBlock.includes('detectDefaultPkgMgr'), 'Bun presence should not redirect fresh installs to Bun');
});

test('SAF-004f1: runnable lookup skips a broken first PATH candidate', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'jaw-cli-runnable-'));
    const brokenDir = join(root, 'broken');
    const workingDir = join(root, 'working');
    fs.mkdirSync(brokenDir);
    fs.mkdirSync(workingDir);

    const commandName = 'jaw-test-cli';
    const fileName = process.platform === 'win32' ? `${commandName}.cmd` : commandName;
    const broken = writeCli(
        brokenDir,
        fileName,
        process.platform === 'win32'
            ? '@echo off\r\nexit /b 1\r\n'
            : '#!/usr/bin/env sh\nexit 1\n',
    );
    const working = writeCli(
        workingDir,
        fileName,
        process.platform === 'win32'
            ? '@echo off\r\necho 1.0.0\r\n'
            : '#!/usr/bin/env sh\necho 1.0.0\n',
    );
    const previousPath = process.env["PATH"];
    const previousTitlePath = process.env["Path"];
    const systemPath = process.platform === 'win32'
        ? (previousTitlePath || previousPath || '')
        : ['/usr/bin', '/bin'].join(delimiter);
    process.env["PATH"] = [brokenDir, workingDir, systemPath].filter(Boolean).join(delimiter);
    delete process.env["Path"];

    try {
        assert.equal(findRunnableCliBinary(commandName), working);
        assert.notEqual(findRunnableCliBinary(commandName), broken);
    } finally {
        restoreEnv('PATH', previousPath);
        restoreEnv('Path', previousTitlePath);
    }
});

test('SAF-004f2: non-Claude all-tools dry-run skips repair when later PATH candidate works', async () => {
    const managedRoot = join(os.homedir(), '.nvm', 'versions', 'node');
    fs.mkdirSync(managedRoot, { recursive: true });
    const root = fs.mkdtempSync(join(managedRoot, 'jaw-cli-all-tools-'));
    const brokenDir = join(root, 'v0-broken', 'bin');
    const workingDir = join(root, 'v1-working', 'bin');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });

    const fileName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    writeCli(
        brokenDir,
        fileName,
        process.platform === 'win32'
            ? '@echo off\r\nexit /b 1\r\n'
            : '#!/usr/bin/env sh\nexit 1\n',
    );
    const working = writeCli(
        workingDir,
        fileName,
        process.platform === 'win32'
            ? '@echo off\r\necho 1.0.0\r\n'
            : '#!/usr/bin/env sh\necho 1.0.0\n',
    );
    const previousPath = process.env["PATH"];
    const previousTitlePath = process.env["Path"];
    const previousSkip = process.env["CLI_JAW_SKIP_CLAUDE"];
    const systemPath = process.platform === 'win32'
        ? (previousTitlePath || previousPath || '')
        : ['/usr/bin', '/bin'].join(delimiter);
    process.env["PATH"] = [brokenDir, workingDir, systemPath].filter(Boolean).join(delimiter);
    delete process.env["Path"];
    process.env["CLI_JAW_SKIP_CLAUDE"] = '1';

    try {
        const logs = await captureConsole(() => installCliTools({ dryRun: true }));
        assert.match(logs, new RegExp(`codex already works.*${working.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.doesNotMatch(logs, /would run npm i -g @openai\/codex/);
        assert.doesNotMatch(logs, /codex \(repair via npm\)/);
    } finally {
        restoreEnv('PATH', previousPath);
        restoreEnv('Path', previousTitlePath);
        restoreEnv('CLI_JAW_SKIP_CLAUDE', previousSkip);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('SAF-004f3: CLI_JAW_SKIP_CLAUDE wins over all-tools dry-run', async () => {
    const previousInstall = process.env["CLI_JAW_INSTALL_CLI_TOOLS"];
    const previousSkip = process.env["CLI_JAW_SKIP_CLAUDE"];
    process.env["CLI_JAW_INSTALL_CLI_TOOLS"] = '1';
    process.env["CLI_JAW_SKIP_CLAUDE"] = '1';

    try {
        const logs = await captureConsole(() => installCliTools({ dryRun: true }));
        assert.match(logs, /claude install skipped \(CLI_JAW_SKIP_CLAUDE\)/);
        assert.doesNotMatch(logs, /claude.*native installer/);
    } finally {
        restoreEnv('CLI_JAW_INSTALL_CLI_TOOLS', previousInstall);
        restoreEnv('CLI_JAW_SKIP_CLAUDE', previousSkip);
    }
});

test('SAF-004g: postinstall child processes use service-safe PATH consistently', () => {
    assert.ok(postinstallSrc.includes('function postinstallExecEnv'), 'postinstall should centralize child-process env construction');
    assert.ok(postinstallSrc.includes('delete out.PATH'), 'postinstall env should avoid duplicate PATH variants');
    assert.ok(postinstallSrc.includes('delete out.Path'), 'postinstall env should avoid duplicate Windows Path variants');
    assert.ok(postinstallSrc.includes("process.platform === 'win32' ? 'Path' : 'PATH'"), 'postinstall env should use one platform-appropriate PATH key');

    const depsBlock = postinstallSrc.slice(postinstallSrc.indexOf('export async function installSkillDeps'));
    assert.ok(depsBlock.includes('env: postinstallExecEnv()'), 'skill dependency checks/installers should see service-safe PATH');

    const installBlock = postinstallSrc.slice(postinstallSrc.indexOf('export async function installCliTools'));
    assert.ok(installBlock.includes('env: postinstallExecEnv()'), 'CLI package installs should see service-safe PATH');

    const mcpBlock = postinstallSrc.slice(postinstallSrc.indexOf('export async function installMcpServers'));
    assert.ok(mcpBlock.includes('env: postinstallExecEnv()'), 'MCP global installs should see service-safe PATH');
});

test('SAF-004h: README scopes Windows installation support to WSL', () => {
    const nativeWindowsBetaStart = readmeSrc.indexOf('<summary><b>Native Windows (PowerShell beta)</b>');
    const nativeWindowsBetaEnd = readmeSrc.indexOf('</details>', nativeWindowsBetaStart);
    const readmeOutsideNativeWindowsBeta = nativeWindowsBetaStart >= 0 && nativeWindowsBetaEnd >= 0
        ? readmeSrc.slice(0, nativeWindowsBetaStart) + readmeSrc.slice(nativeWindowsBetaEnd + '</details>'.length)
        : readmeSrc;
    assert.ok(readmeSrc.includes('wsl --install'), 'README should document Windows setup through WSL');
    assert.ok(readmeSrc.includes('wsl.exe -d Ubuntu -- bash -lc "jaw dashboard"'), 'README should document PowerShell-to-WSL login-shell invocation');
    assert.ok(readmeSrc.includes('macOS / Linux / WSL with Node.js 22+ already installed'), 'README default npm install block should be OS-scoped');
    assert.equal(readmeOutsideNativeWindowsBeta.includes('Get-Command jaw'), false, 'README must keep native PowerShell jaw resolution inside the explicitly scoped beta section');
    assert.equal(localizedReadmeSrc.includes('$env:JAW_SAFE="1"; npm install -g cli-jaw'), false, 'localized READMEs must not advertise native PowerShell safe install');
    assert.equal(localizedReadmeSrc.includes('# Windows PowerShell'), false, 'localized READMEs must not present native PowerShell install snippets');
    assert.equal(localizedReadmeSrc.includes('npm bin -g'), false, 'localized README troubleshooting should use npm prefix -g, not removed npm bin -g');
    assert.ok(localizedReadmeSrc.includes('wsl.exe -d Ubuntu -- bash -lc "jaw dashboard"'), 'localized READMEs should document PowerShell-to-WSL login-shell invocation');
});

test('SAF-004i: install risk gate covers fresh-machine installer regressions', () => {
    const gateSrc = fs.readFileSync(join(__dirname, '../../scripts/install-risk-gate.mjs'), 'utf8');
    assert.equal(packageJson.scripts?.['test:install-risk'], 'node scripts/install-risk-gate.mjs');
    assert.ok(gateSrc.includes('tests/unit/install-sh-exec.test.ts'), 'gate should run executable macOS installer harness');
    assert.ok(gateSrc.includes('tests/unit/install-path-contract.test.ts'), 'gate should run install path contract tests');
    assert.ok(gateSrc.includes('tests/unit/fresh-evidence-audit.test.ts'), 'gate should run the evidence auditor fixture tests');
    assert.ok(gateSrc.includes('tests/unit/wsl-installer-exec.test.ts'), 'gate should run WSL installer harness');
    assert.ok(gateSrc.includes('scripts/verify-fresh-install.sh'), 'gate should syntax-check macOS/Linux fresh verifier');
    assert.ok(gateSrc.includes('scripts/collect-fresh-install-evidence.sh'), 'gate should syntax-check the fresh-machine evidence collector');
    assert.ok(gateSrc.includes('scripts/audit-fresh-install-evidence.mjs'), 'gate should syntax-check the fresh-machine evidence auditor');
    assert.ok(gateSrc.includes('scripts/verify-release-evidence.mjs'), 'gate should syntax-check the release evidence matrix gate');
    assert.ok(gateSrc.includes('scripts/require-release-evidence.mjs'), 'gate should syntax-check the publish-time release evidence requirement');
    assert.equal(gateSrc.includes('scripts/verify-fresh-install.ps1'), false, 'gate must not require a native PowerShell fresh-install verifier');
    assert.ok(gateSrc.includes("npm, ['pack', '--dry-run', '--json']"), 'gate should verify npm package contents');
    assert.ok(gateSrc.includes('scripts/postinstall-guard.cjs'), 'gate should ensure postinstall guard is packed');
    assert.ok(gateSrc.includes('scripts/check-cli-bin-links.cjs'), 'gate should syntax-check the CLI bin link verifier');
    assert.ok(gateSrc.includes('check:electron-sidecar-no-jwc'), 'gate should run the staged Electron no-JWC checker when sidecar artifacts exist');
    assert.ok(gateSrc.includes('check:app-icons'), 'gate should run packaged app icon asset checks');
    assert.ok(gateSrc.includes('scripts/require-release-evidence.mjs'), 'gate should ensure publish-time release evidence guard is packed');
    assert.ok(gateSrc.includes("'public/public/'"), 'gate should reject nested Vite publicDir artifacts');
    assert.ok(gateSrc.includes("'public/dist/dist/'"), 'gate should reject nested frontend build output');
    assert.ok(gateSrc.includes('structure/verify-counts.sh'), 'gate should enforce repository structure sync');
    assert.ok(gateSrc.includes("commandExists('rg')"), 'structure sync should require ripgrep before running');
    assert.ok(gateSrc.includes("existsSync('public/dist')"), 'structure sync should wait for frontend build output before running');
});

test('SAF-004j: packaged fresh-install verifiers check new-shell readiness', () => {
    const shellVerifier = fs.readFileSync(join(__dirname, '../../scripts/verify-fresh-install.sh'), 'utf8');
    assert.equal(packageJson.scripts?.['verify:fresh-install'], 'bash scripts/verify-fresh-install.sh');
    assert.ok(shellVerifier.includes('node version is below 22'), 'fresh verifier should enforce the documented Node.js 22+ requirement');
    assert.ok(shellVerifier.includes('should_check_zsh'), 'fresh verifier should only enforce zsh when it is a supported shell surface');
    assert.ok(shellVerifier.includes('zsh -ic'), 'macOS verifier should check interactive zsh resolution');
    assert.ok(shellVerifier.includes('zsh -lc'), 'macOS verifier should check login zsh resolution');
    assert.ok(shellVerifier.includes('run_version cli-jaw'), 'fresh verifier should check the cli-jaw alias directly');
    assert.ok(shellVerifier.includes('command -v cli-jaw'), 'new-shell probes should resolve cli-jaw as well as jaw');
    assert.ok(shellVerifier.includes('not executable'), 'fresh verifier should diagnose non-executable bin targets explicitly');
    assert.ok(shellVerifier.includes('jaw doctor'), 'macOS verifier should run jaw doctor');
    assert.ok(shellVerifier.includes('--skip-doctor'), 'macOS verifier should support CI smoke without doctor');
    assert.ok(readmeSrc.includes('verify-fresh-install.sh'), 'README should document macOS/WSL verifier');
    assert.ok(readmeSrc.includes('source "${ZDOTDIR:-$HOME}/.zshrc"'), 'README should refresh zsh/nvm PATH before running npm-root verifier after curl|bash');
    assert.ok(localizedReadmeSrc.includes('source "${ZDOTDIR:-$HOME}/.zshrc"'), 'localized READMEs should refresh zsh/nvm PATH before verifier');
});

test('SAF-004j1: postinstall guard repairs package bin permissions before safe-mode exit', () => {
    const guardSrc = fs.readFileSync(join(__dirname, '../../scripts/postinstall-guard.cjs'), 'utf8');
    assert.ok(guardSrc.includes('function ensurePackageBinExecutable'), 'postinstall guard should define package-bin repair helper');
    assert.ok(guardSrc.includes("path.join(rootDir, 'dist', 'bin', 'cli-jaw.js')"), 'postinstall guard should repair dist/bin/cli-jaw.js');
    assert.ok(guardSrc.indexOf('ensurePackageBinExecutable(root);') < guardSrc.indexOf('if (safeMode)'), 'package-bin repair should run before safe-mode early exit');
    assert.ok(guardSrc.indexOf('const root =') < guardSrc.indexOf('if (safeMode)'), 'root should be available before safe-mode branch');
    assert.ok(guardSrc.lastIndexOf('ensurePackageBinExecutable(root);') > guardSrc.indexOf('tsc completed but dist/bin/postinstall.js not found'), 'package-bin repair should run again after dev fallback build');
});

test('SAF-004j2: fresh-machine evidence collector documents supported release evidence only', () => {
    assert.equal(packageJson.scripts?.['collect:fresh-install-evidence'], 'bash scripts/collect-fresh-install-evidence.sh');
    assert.equal(packageJson.scripts?.['audit:fresh-install-evidence'], 'node scripts/audit-fresh-install-evidence.mjs');
    assert.equal(packageJson.scripts?.['verify:release-evidence'], 'node scripts/verify-release-evidence.mjs');
    // Evidence gates still run via promote-to-main.sh/release-preview.sh (asserted in SAF-004j3);
    // prepublishOnly only adds the frontend build-output integrity check.
    // The executable lifecycle ordering and fail-closed private-path gate are
    // covered by private-boundary.test.ts, including rejection before build.
    assert.ok(freshInstallEvidenceSrc.includes('--target macos|wsl|linux|auto'), 'collector should require explicit supported target wording');
    assert.ok(freshInstallEvidenceSrc.includes('--install-script FILE'), 'collector should allow branch/local installer verification before release');
    assert.ok(freshInstallEvidenceSrc.includes('--verifier-script FILE'), 'collector should allow local verifier validation before release');
    assert.ok(freshInstallEvidenceSrc.includes('local fresh-install verifier'), 'collector should label verifier override logs accurately');
    assert.ok(freshInstallEvidenceSrc.includes('local_verifier_for_install_script'), 'collector should prefer a checkout verifier when a local installer script is supplied');
    assert.ok(freshInstallEvidenceSrc.includes('local fresh-install verifier from installer checkout'), 'collector should label checkout verifier discovery accurately');
    assert.ok(freshInstallEvidenceSrc.includes('install-wsl.sh'), 'collector should run the WSL installer for Windows-supported evidence');
    assert.ok(freshInstallEvidenceSrc.includes('install.sh'), 'collector should run the macOS/Linux installer for Unix evidence');
    assert.ok(freshInstallEvidenceSrc.includes('verify-fresh-install.sh'), 'collector should run the same post-install verifier');
    assert.ok(freshInstallEvidenceSrc.includes('00-collector-script.sh'), 'collector should archive its own script source for release evidence');
    assert.ok(freshInstallEvidenceSrc.includes('02-installer-script.sh'), 'collector should archive the installer script before executing it');
    assert.ok(freshInstallEvidenceSrc.includes('21-verifier-script.sh'), 'collector should archive the verifier script before executing it');
    assert.ok(freshInstallEvidenceSrc.includes('sha256='), 'collector should record archived script hashes');
    assert.ok(freshInstallEvidenceSrc.includes('release audit will require'), 'collector should warn when it is run from stdin and cannot archive itself');
    assert.ok(freshInstallEvidenceSrc.includes('Native Windows/Git Bash is not a supported CLI-JAW install target'), 'collector should reject native Windows shells');
    assert.ok(freshInstallEvidenceSrc.includes('run_optional_shell_logged "bash login-shell probe (non-default on macOS)"'), 'collector should not fail macOS evidence solely because bash login shell is not configured');
    assert.ok(freshInstallEvidenceSrc.includes('zsh login-shell probe (non-default outside macOS)'), 'collector should not fail WSL/Linux evidence solely because non-default zsh is unconfigured');
    assert.ok(freshInstallEvidenceSrc.includes('wsl.exe -d'), 'collector should record the PowerShell-to-WSL invocation');
    assert.ok(freshInstallEvidenceSrc.includes('powershell.exe'), 'collector should attempt the host PowerShell-to-WSL probe when available');
    assert.ok(freshInstallEvidenceSrc.includes('Run this from Windows PowerShell'), 'collector should print a host-side PowerShell probe command when powershell.exe is absent inside WSL');
    assert.equal(freshInstallEvidenceSrc.includes('verify-fresh-install.ps1'), false, 'collector must not imply native PowerShell install support');
    assert.ok(readmeSrc.includes('collect-fresh-install-evidence.sh'), 'README should expose the VM evidence command for maintainers');
    assert.ok(readmeSrc.includes('--install-script scripts/install.sh --verifier-script scripts/verify-fresh-install.sh'), 'README should show local branch macOS installer and verifier evidence collection');
    assert.ok(readmeSrc.includes('--install-script scripts/install-wsl.sh --verifier-script scripts/verify-fresh-install.sh'), 'README should show local branch WSL installer and verifier evidence collection');
    assert.ok(readmeSrc.includes('audit-fresh-install-evidence.mjs'), 'README should show evidence directory auditing');
    assert.ok(readmeSrc.includes('node scripts/audit-fresh-install-evidence.mjs "$EVIDENCE_DIR" --target macos'), 'README should show local checkout auditor usage');
    assert.ok(readmeSrc.includes('node scripts/verify-release-evidence.mjs --macos /path/to/macos-evidence --wsl /path/to/wsl-evidence'), 'README should show local checkout release gate usage');
    assert.ok(readmeSrc.includes('curl -fsSL https://raw.githubusercontent.com/lidge-ai/cli-jaw/main/scripts/collect-fresh-install-evidence.sh -o "$COLLECTOR"'), 'README should download the collector to a file before executing it');
    assert.ok(readmeSrc.includes('33-powershell-to-wsl-probe.log'), 'README should document host-side PowerShell-to-WSL probe evidence when the collector cannot run it from WSL');
    assert.ok(freshInstallEvidenceAuditSrc.includes('--allow-skip-install'), 'auditor should distinguish release evidence from local smoke evidence');
    assert.ok(freshInstallEvidenceAuditSrc.includes("requireArchivedScript('collector', '00-collector-script.sh')"), 'auditor should require archived collector source for release evidence');
    assert.ok(freshInstallEvidenceAuditSrc.includes("requireArchivedScript('installer', '02-installer-script.sh')"), 'auditor should require archived installer source for release evidence');
    assert.ok(freshInstallEvidenceAuditSrc.includes("requireArchivedScript('verifier', '21-verifier-script.sh')"), 'auditor should require archived verifier source for every evidence run');
    assert.ok(freshInstallEvidenceAuditSrc.includes('sha256 mismatch'), 'auditor should verify archived script hashes');
    assert.ok(freshInstallEvidenceAuditSrc.includes('must be an archived bash script with a bash shebang'), 'auditor should reject archived script files that are not bash scripts');
    assert.ok(freshInstallEvidenceAuditSrc.includes('missing 33-powershell-to-wsl-probe.log'), 'auditor should require PowerShell-to-WSL evidence for WSL by default');
    assert.ok(freshInstallEvidenceAuditSrc.includes('command=wsl.exe -d'), 'auditor should accept externally recorded host PowerShell-to-WSL probe logs only when the command is recorded');
    assert.ok(freshInstallEvidenceAuditSrc.includes('node version is >=22'), 'auditor should require the Node 22+ verifier line');
    assert.ok(freshInstallEvidenceAuditSrc.includes('00-before.txt shows preexisting Node.js'), 'auditor should verify fresh no-Node evidence by default');
    assert.equal(freshInstallEvidenceAuditSrc.includes('verify-fresh-install.ps1'), false, 'auditor must not imply native PowerShell verifier support');
    const releaseEvidenceGateSrc = fs.readFileSync(join(__dirname, '../../scripts/verify-release-evidence.mjs'), 'utf8');
    assert.ok(releaseEvidenceGateSrc.includes('--macos DIR'), 'release gate should require macOS evidence');
    assert.ok(releaseEvidenceGateSrc.includes('--wsl DIR'), 'release gate should require WSL evidence');
    assert.ok(releaseEvidenceGateSrc.includes("'--target', target"), 'release gate should run the strict target auditor');
    assert.equal(releaseEvidenceGateSrc.includes('--allow-skip-install'), false, 'release gate must not pass local-smoke allow flags');
    assert.equal(releaseEvidenceGateSrc.includes('--allow-preexisting-node'), false, 'release gate must not allow non-fresh machines');
    assert.ok(requireReleaseEvidenceSrc.includes('installerSensitivePaths'), 'publish-time evidence guard should define installer-sensitive paths');
    assert.ok(requireReleaseEvidenceSrc.includes('scripts/verify-release-evidence.mjs'), 'publish-time evidence guard should delegate to the strict matrix gate');
    assert.ok(requireReleaseEvidenceSrc.includes('CLI_JAW_MACOS_EVIDENCE_DIR'), 'publish-time evidence guard should require macOS evidence');
    assert.ok(requireReleaseEvidenceSrc.includes('CLI_JAW_WSL_EVIDENCE_DIR'), 'publish-time evidence guard should require WSL evidence');
    assert.ok(requireReleaseEvidenceSrc.includes("relativePath === 'package.json'"), 'publish-time evidence guard should treat package metadata carefully');
    assert.ok(requireReleaseEvidenceSrc.includes('delete parsed.version'), 'publish-time evidence guard should ignore pure version bumps');
    assert.ok(requireReleaseEvidenceSrc.includes('currentPackageVersionTag'), 'publish-time evidence guard should not use the just-created version tag as the comparison base');
    assert.ok(requireReleaseEvidenceSrc.includes('tag !== currentTag'), 'publish-time evidence guard should compare against the previous release tag after a tag is created');
    assert.ok(requireReleaseEvidenceSrc.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+$'), 'publish-time evidence guard should compare against stable release tags, not preview tags');
});

test('SAF-004j3: publish scripts enforce fresh-machine evidence before push or publish', () => {
    // These used to be substring checks against the guard's source, back when it
    // carried its own hand-written path list. That list drifted from the platform
    // workflow by 21 paths (#333 G1), so the guard now derives the set instead —
    // and the assertions have to look at the DERIVED set, not the source text.
    // Full parity coverage lives in tests/unit/installer-sensitive-path-parity.test.ts.
    const printed = spawnSync(process.execPath, [join(repoRoot, 'scripts/require-release-evidence.mjs'), '--print-paths'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    assert.equal(printed.status, 0, `release evidence guard should print its derived path set:\n${printed.stderr}`);
    const sensitivePaths: string[] = JSON.parse(printed.stdout);
    const requiresEvidence = (path: string) => assert.ok(
        sensitivePaths.includes(path),
        `release evidence trigger paths should include ${path}`,
    );
    requiresEvidence('scripts/install.sh');
    requiresEvidence('scripts/install-wsl.sh');
    requiresEvidence('scripts/install.ps1');
    requiresEvidence('scripts/verify-fresh-install.sh');
    requiresEvidence('scripts/audit-fresh-install-evidence.mjs');
    requiresEvidence('scripts/verify-release-evidence.mjs');
    requiresEvidence('scripts/require-release-evidence.mjs');
    requiresEvidence('scripts/promote-to-main.sh');
    requiresEvidence('scripts/release-preview.sh');
    assert.ok(readmeSrc.includes('CLI_JAW_MACOS_EVIDENCE_DIR=/path/to/macos-evidence'), 'README should document release-script evidence env');
    assert.ok(readmeSrc.includes('bash scripts/promote-to-main.sh'), 'README should show stable promotion script with evidence directories');

    const freshEvidencePos = releaseScriptSrc.indexOf('node scripts/require-release-evidence.mjs');
    // ff promotion (#480) pushes refs directly instead of publishing a promotion
    // branch, so the first ref-moving command is the preview fast-forward.
    const pushPos = releaseScriptSrc.indexOf('push --force-with-lease="refs/heads/preview:$PREVIEW_SHA"');
    const publishPos = releaseScriptSrc.indexOf('gh workflow run publish.yml');
    assert.ok(pushPos >= 0, 'promotion script must still push a ref the evidence gate can precede');
    assert.ok(freshEvidencePos >= 0 && freshEvidencePos < pushPos, 'fresh evidence gate must run before git push');
    if (publishPos >= 0) {
        assert.ok(freshEvidencePos >= 0 && freshEvidencePos < publishPos, 'fresh evidence gate must run before publish dispatch');
    }

    const previewGatePos = releasePreviewScriptSrc.indexOf('npm run gate:all');
    const previewFreshEvidencePos = releasePreviewScriptSrc.indexOf('node scripts/require-release-evidence.mjs');
    const previewPublishPos = releasePreviewScriptSrc.indexOf('npm publish "$TARBALL" --tag preview --access public');
    const previewPushCandidates = [
        releasePreviewScriptSrc.indexOf('git push origin preview'),
        releasePreviewScriptSrc.indexOf('git push origin HEAD:preview'),
        releasePreviewScriptSrc.indexOf('git push origin "$CURRENT_BRANCH"'),
    ].filter(position => position >= 0);
    const previewPushPos = Math.min(...previewPushCandidates);
    assert.ok(previewGatePos >= 0 && previewFreshEvidencePos > previewGatePos, 'preview fresh evidence gate should run after normal release gates');
    if (previewPublishPos >= 0) {
        assert.ok(previewFreshEvidencePos >= 0 && previewFreshEvidencePos < previewPublishPos, 'preview evidence gate must run before npm publish');
    }
    assert.ok(previewPushCandidates.length > 0, 'preview release script must push the preview branch');
    assert.ok(previewFreshEvidencePos >= 0 && previewFreshEvidencePos < previewPushPos, 'preview evidence gate must run before git push');
});

test('SAF-004k: postinstall platform workflow runs installer risk gate on macOS and WSL', () => {
    assert.ok(postinstallWorkflowSrc.includes('macos-latest'), 'workflow should cover native macOS installer risks');
    assert.ok(postinstallWorkflowSrc.includes('windows-wsl'), 'workflow should cover the supported Windows path through WSL');
    // 260804 install hardening: native Windows became a declared BETA surface.
    // The workflow must exercise install.ps1 itself (not just raw npm) so the
    // beta claim has activation evidence behind it.
    assert.ok(postinstallWorkflowSrc.includes('windows-native'), 'workflow should exercise the beta native Windows installer');
    assert.ok(postinstallWorkflowSrc.includes('scripts/install.ps1 -TarballPath'), 'the beta job must run install.ps1 itself against the packed tarball');
    assert.ok(postinstallWorkflowSrc.includes('npm run test:install-risk'), 'workflow should run the consolidated installer risk gate');
    assert.ok(postinstallWorkflowSrc.includes('Run installer risk gate in WSL'), 'WSL workflow should run the consolidated installer risk gate, not only a narrow policy subset');
    assert.ok(postinstallWorkflowSrc.includes("'.gitattributes'"), 'workflow triggers should include checkout line-ending policy changes');
    assert.ok(postinstallWorkflowSrc.includes('scripts/install.sh'), 'workflow triggers should include macOS installer script changes');
    assert.ok(postinstallWorkflowSrc.includes('scripts/install-wsl.sh'), 'workflow triggers should include WSL installer changes');
    assert.ok(postinstallWorkflowSrc.includes('scripts/install-officecli.ps1'), 'workflow triggers should include Windows PowerShell installer changes');
    assert.equal(postinstallWorkflowSrc.includes('scripts/verify-fresh-install.ps1'), false, 'workflow must not depend on a native PowerShell fresh verifier');
    assert.ok(postinstallWorkflowSrc.includes('scripts/collect-fresh-install-evidence.sh'), 'workflow triggers should include the fresh-machine evidence collector');
    assert.ok(postinstallWorkflowSrc.includes('scripts/audit-fresh-install-evidence.mjs'), 'workflow triggers should include the fresh-machine evidence auditor');
    assert.ok(postinstallWorkflowSrc.includes('scripts/verify-release-evidence.mjs'), 'workflow triggers should include the release evidence matrix gate');
    assert.ok(postinstallWorkflowSrc.includes('scripts/require-release-evidence.mjs'), 'workflow triggers should include the publish-time release evidence gate');
    assert.ok(postinstallWorkflowSrc.includes('tests/unit/install-sh-exec.test.ts'), 'workflow triggers should include executable installer harness changes');
    assert.ok(postinstallWorkflowSrc.includes('tests/unit/fresh-evidence-audit.test.ts'), 'workflow triggers should include evidence auditor fixture tests');
    assert.ok(postinstallWorkflowSrc.includes('tests/unit/wsl-installer-exec.test.ts'), 'workflow triggers should include WSL installer harness changes');
    assert.ok(postinstallWorkflowSrc.includes('npm run build'), 'workflow should build the package before packed global install smoke');
    assert.ok(postinstallWorkflowSrc.includes('npm run test:fresh-install -- --postinstall --skip-doctor'), 'workflow should smoke-test the packed package global install');
    assert.ok(postinstallWorkflowSrc.includes('shell: wsl-bash {0}'), 'Windows packed install smoke should run inside WSL');
    assert.ok(postinstallWorkflowSrc.includes('wsl.exe -d Ubuntu-24.04 -- bash -lc'), 'workflow should verify PowerShell-to-WSL login-shell invocation');
    assert.ok(postinstallWorkflowSrc.includes("cd \"$(wslpath '${{ github.workspace }}')\""), 'WSL steps should resolve the Windows checkout path inside WSL without relying on env forwarding');
    assert.ok(postinstallWorkflowSrc.includes("$workspaceForWsl = $workspace -replace '\\\\', '/'"), 'PowerShell step should normalize Windows backslashes before wslpath');
    assert.ok(postinstallWorkflowSrc.includes('$linuxWorkspace = (wsl.exe -d Ubuntu-24.04 -- wslpath "$workspaceForWsl").Trim()'), 'PowerShell step should resolve the WSL workspace before bash -lc');
    assert.equal(postinstallWorkflowSrc.includes('`$(wslpath'), false, 'PowerShell step must not let Bash command substitution be parsed by PowerShell');
    assert.ok(gitattributesSrc.includes('*.sh text eol=lf'), 'Windows checkout must preserve LF shell scripts for WSL bash');
    assert.ok(gitattributesSrc.includes('*.ps1 text eol=crlf'), 'PowerShell scripts should keep Windows-friendly line endings');
});

test('SAF-004l: fresh install smoke exercises packed global install without safe mode', () => {
    assert.equal(packageJson.scripts?.['test:fresh-install'], 'tsx scripts/fresh-install-smoke.ts');
    assert.ok(freshInstallSmokeSrc.includes("--postinstall"), 'fresh install smoke should have a postinstall mode');
    assert.ok(freshInstallSmokeSrc.includes('CLI_JAW_SKIP_CLAUDE'), 'postinstall smoke should skip external Claude installer');
    assert.ok(freshInstallSmokeSrc.includes('CLI_JAW_SKIP_MCP_SERVERS'), 'postinstall smoke should skip external MCP network installs');
    assert.ok(freshInstallSmokeSrc.includes('CLI_JAW_SKIP_SKILL_DEPS'), 'postinstall smoke should skip external skill dependency network installs');
    assert.ok(freshInstallSmokeSrc.includes('verify-fresh-install.sh'), 'postinstall smoke should run packaged Unix verifier');
    assert.equal(freshInstallSmokeSrc.includes('verify-fresh-install.ps1'), false, 'postinstall smoke should not imply native PowerShell support');
    assert.ok(freshInstallSmokeSrc.includes('fresh-install-smoke targets macOS/Linux/WSL'), 'fresh install smoke should reject native Windows execution');
    assert.ok(freshInstallSmokeSrc.includes('npm_config_prefix'), 'fresh install smoke should isolate npm global prefix');
    assert.ok(freshInstallSmokeSrc.includes('jawCmd'), 'fresh install smoke should execute the installed global jaw shim');
    assert.ok(freshInstallSmokeSrc.includes('cliJawCmd'), 'fresh install smoke should execute the installed global cli-jaw shim');
    assert.ok(freshInstallSmokeSrc.includes('cli-jaw version mismatch'), 'fresh install smoke should compare jaw and cli-jaw versions');
});

test('SAF-004m: postinstall has opt-out gates for network-heavy optional installers', () => {
    assert.ok(postinstallSrc.includes('CLI_JAW_SKIP_MCP_SERVERS'), 'postinstall should allow CI/fresh smoke to skip MCP network installs');
    assert.ok(postinstallSrc.includes('CLI_JAW_SKIP_SKILL_DEPS'), 'postinstall should allow CI/fresh smoke to skip skill dependency network installs');
    assert.ok(postinstallSrc.includes('MCP server install skipped'), 'MCP skip should be visible in logs');
    assert.ok(postinstallSrc.includes('skill dependency install skipped'), 'skill dependency skip should be visible in logs');
});

// ── SAF-005: installMcpServers exported ──

test('SAF-005: installMcpServers is exported', () => {
    assert.ok(postinstallSrc.includes('export async function installMcpServers'), 'installMcpServers exported');
});

// ── SAF-006: installSkillDeps exported ──

test('SAF-006: installSkillDeps is exported', () => {
    assert.ok(postinstallSrc.includes('export async function installSkillDeps'), 'installSkillDeps exported');
});

test('SAF-006c2: Windows OfficeCLI installer persists LOCALAPPDATA OfficeCli on user PATH', () => {
    assert.ok(officeCliPowerShellSrc.includes('[Environment]::SetEnvironmentVariable("Path"'), 'PowerShell installer should persist user PATH');
    assert.ok(officeCliPowerShellSrc.includes('$env:PATH = "$installDir;$env:PATH"'), 'PowerShell installer should update current process PATH');
    assert.ok(officeCliPowerShellSrc.includes('Open a new PowerShell'), 'PowerShell installer should explain new-shell behavior');
});

test('SAF-006c3: doctor checks the Windows LOCALAPPDATA OfficeCli install location', () => {
    const doctorSrc = fs.readFileSync(join(__dirname, '../../bin/commands/doctor.ts'), 'utf8');
    assert.ok(doctorSrc.includes('process.env["LOCALAPPDATA"]') || doctorSrc.includes("process.env['LOCALAPPDATA']"), 'doctor should know the Windows OfficeCLI install root');
    assert.ok(doctorSrc.includes("'OfficeCli', 'officecli.exe'"), 'doctor should check LOCALAPPDATA OfficeCli binary');
    assert.ok(doctorSrc.includes('install-officecli.ps1'), 'doctor remediation should mention the PowerShell installer on Windows');
});

// ── SAF-007: InstallOpts type exported ──

test('SAF-006d: `jaw init` honours the skill-dep and MCP skip switches', () => {
    // These two variables were read at the top of postinstall.ts and checked
    // only inside runPostinstall(), the npm entry point. `jaw init` called the
    // installers directly, so setting them changed nothing there — every init
    // reached for the network no matter what the caller asked for.
    //
    // That is what timed out CI: the Slack init behavior suite runs six real
    // `jaw init` subprocesses, and a runner has neither `uv` nor
    // `playwright-core`, so each one tried to fetch and install them. It never
    // showed up locally, where both are already present and the check exits
    // immediately.
    //
    // Asserted by RUNNING it, because the previous version of this belief was
    // a source-text assertion that stayed green through the whole outage.
    const home = fs.mkdtempSync(join(os.homedir(), '.cljaw-skip-'));
    try {
        const result = spawnSync(
            process.execPath,
            [
                '--import', 'tsx',
                join(__dirname, '../../bin/cli-jaw.ts'),
                'init', '--non-interactive', '--working-dir', '/tmp', '--cli', 'claude',
            ],
            {
                env: {
                    ...process.env,
                    CLI_JAW_HOME: home,
                    CLI_JAW_SKIP_CLI_TOOLS: '1',
                    CLI_JAW_SKIP_SKILL_DEPS: '1',
                    CLI_JAW_SKIP_MCP_SERVERS: '1',
                    CLI_JAW_SKIP_CLAUDE: '1',
                },
                encoding: 'utf8',
                timeout: 30_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        assert.equal(result.status, 0, `init failed: ${output.slice(-400)}`);
        assert.match(output, /CLI tool install skipped \(CLI_JAW_SKIP_CLI_TOOLS\)/,
            'provider CLIs were installed despite the skip switch');
        assert.match(output, /skill dependency install skipped \(CLI_JAW_SKIP_SKILL_DEPS\)/,
            'skill deps ran despite the skip switch');
        assert.match(output, /MCP server install skipped \(CLI_JAW_SKIP_MCP_SERVERS\)/,
            'MCP servers ran despite the skip switch');
        // The proof that the skip did something: the checks these installers
        // print on the way through must be absent.
        assert.doesNotMatch(output, /checking skill dependencies/,
            'the skill-dep check still ran');
        assert.doesNotMatch(output, /installing CLI tools/,
            'the CLI tool installer still ran');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('SAF-007: InstallOpts type is exported', () => {
    assert.ok(postinstallSrc.includes('export type InstallOpts'), 'InstallOpts type exported');
});

// ── SAF-008: dryRun support in all 3 functions ──

test('SAF-008: all install functions support dryRun', () => {
    const cliBlock = postinstallSrc.slice(postinstallSrc.indexOf('installCliTools'));
    const mcpBlock = postinstallSrc.slice(postinstallSrc.indexOf('installMcpServers'));
    const depsBlock = postinstallSrc.slice(postinstallSrc.indexOf('installSkillDeps'));
    assert.ok(cliBlock.includes('opts.dryRun'), 'installCliTools supports dryRun');
    assert.ok(mcpBlock.includes('opts.dryRun'), 'installMcpServers supports dryRun');
    assert.ok(depsBlock.includes('opts.dryRun'), 'installSkillDeps supports dryRun');
});

// ── SAF-009: isEntryPoint guard ──

test('SAF-009: postinstall has isEntryPoint guard', () => {
    assert.ok(postinstallSrc.includes('isEntryPoint'), 'checks isEntryPoint');
    assert.ok(postinstallSrc.includes("endsWith('postinstall"), 'checks postinstall filename');
    assert.ok(postinstallSrc.includes('runPostinstall()'), 'calls runPostinstall from guard');
});

// ── SAF-010: safe mode guard runs before skills/uploads creation ──

test('SAF-010: safe mode guard is before skills/uploads ensureDir', () => {
    const guardPos = postinstallSrc.indexOf('if (isSafeMode)');
    const skillsDirPos = postinstallSrc.indexOf("ensureDir(path.join(jawHome, 'skills'))");
    const uploadsDirPos = postinstallSrc.indexOf("ensureDir(path.join(jawHome, 'uploads'))");
    assert.ok(guardPos < skillsDirPos, 'safe guard before skills dir creation');
    assert.ok(guardPos < uploadsDirPos, 'safe guard before uploads dir creation');
});

// ── INIT-001: --dry-run option ──

test('INIT-001: init.ts has --dry-run option', () => {
    assert.ok(initSrc.includes("'dry-run': { type: 'boolean'"), '--dry-run option defined');
});

// ── INIT-002: --safe option (safe install mode) ──

test('INIT-002: init.ts has --safe option for safe install mode', () => {
    assert.ok(initSrc.includes("safe: { type: 'boolean'"), '--safe option defined in parseArgs');
    assert.ok(initSrc.includes('--safe                Ask before optional installs'), '--safe help should describe prompt behavior');
    assert.ok(!initSrc.includes('--safe                Safe install (home dir only)'), '--safe help should not promise home-only behavior');
});

// ── INIT-003: no direct import('../postinstall.js') side-effect ──

test('INIT-003: init.ts uses dynamic import for postinstall (no static side-effect)', () => {
    const hasStaticImport = /^import\s+\{[^}]+\}\s+from\s+['"]\.\.[\\/]postinstall/m.test(initSrc);
    assert.ok(!hasStaticImport, 'no static import of postinstall (would cause side effects)');
    assert.ok(
        initSrc.includes("await import('../postinstall.js')"),
        'uses dynamic import() for controlled loading',
    );
});

// ── INIT-004: uses extracted functions ──

test('INIT-004: init.ts imports and calls extracted install functions', () => {
    assert.ok(initSrc.includes('installCliTools'), 'calls installCliTools');
    assert.ok(initSrc.includes('installMcpServers'), 'calls installMcpServers');
    assert.ok(initSrc.includes('installSkillDeps'), 'calls installSkillDeps');
});

// ── INIT-005: --dry-run skips settings write ──

test('INIT-005: --dry-run guards settings/dir writes', () => {
    assert.ok(initSrc.includes("!values['dry-run']"), 'dry-run guards file writes');
    assert.ok(initSrc.includes('[dry-run] would save settings'), 'dry-run reports settings skip');
});

test('OFF-001: shell installer supports update mode', () => {
    assert.ok(officeCliShellSrc.includes('--update'), 'shell installer should expose --update');
    assert.ok(officeCliShellSrc.includes('get_latest_version'), 'shell installer should compare latest version');
});

test('OFF-001b: shell installer fails on checksum mismatch when expected checksum exists', () => {
    const mismatchPos = officeCliShellSrc.indexOf('Checksum mismatch');
    assert.ok(mismatchPos >= 0, 'shell installer should report checksum mismatch');
    const mismatchBlock = officeCliShellSrc.slice(Math.max(0, mismatchPos - 80), mismatchPos + 160);
    assert.ok(mismatchBlock.includes('fail "Checksum mismatch'), 'checksum mismatch should fail, not warn');
    assert.ok(!mismatchBlock.includes('warn "Checksum mismatch'), 'checksum mismatch must not continue as warning');
});

test('OFF-002: PowerShell installer exists for win32 postinstall', () => {
    assert.ok(officeCliPowerShellSrc.includes('officecli-win-x64.exe'), 'PowerShell installer should map Windows x64 asset');
    assert.ok(officeCliPowerShellSrc.includes('$env:LOCALAPPDATA'), 'PowerShell installer should install under LOCALAPPDATA');
});
