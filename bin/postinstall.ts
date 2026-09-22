#!/usr/bin/env node

// ─── Node version guard ─────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major! < 22) {
    console.error(`[jaw:init] ❌ Node.js >= 22 required (current: ${process.version})`);
    console.error(`[jaw:init]    Install: https://nodejs.org or nvm install 22`);
    process.exit(1);
}

/**
 * postinstall.js — Phase 12.1
 * Sets up symlink structure and MCP config for agent tool compatibility.
 *
 * Created structure (isolated-by-default):
 *   ~/.cli-jaw/           (config dir)
 *   ~/.cli-jaw/skills/    (default skills source)
 *   ~/.cli-jaw/uploads/   (media uploads)
 *   ~/.cli-jaw/mcp.json   (unified MCP config)
 *
 * Shared home paths (~/.agents, ~/.agent, ~/.claude) are NOT modified by default.
 * Opt-in: CLI_JAW_MIGRATE_SHARED_PATHS=1 npm install -g cli-jaw
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { ensureSharedHomeSkillsLinks, initMcpConfig, copyDefaultSkills, propagateSkillsToInstances, migrateAllJawHomes, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';
import { resolveHomePath } from '../src/core/path-expand.js';
import { launchSpec } from '../src/core/exec-name.js';

// ─── External-process seam (#274) ────────────────────
// Every external spawn in this file goes through runTool(), which resolves the
// Windows launch spec before handing off — both the shim name (npm -> npm.cmd)
// and the cmd.exe wrapper a .cmd script needs, since Node refuses to execFile
// a batch file directly. Resolution deliberately lives in production code
// rather than in the injected adapter: a fake that replaced the whole runner
// would only ever observe the pre-resolution command, which is exactly the
// logic a #274 regression test needs to see.
//
// Failure semantics are unchanged — callers here use `throw` for control flow
// (brew upgrade falling back to install, presence probes), so runTool throws
// like execFileSync does instead of returning a result object.
type ExecFileAdapter = (file: string, args: string[], opts: Record<string, unknown>) => string | Buffer;

let execFileAdapter: ExecFileAdapter = execFileSync as unknown as ExecFileAdapter;
let toolPlatform: NodeJS.Platform = process.platform;

/** Test seam. Returns a restore function. Not for production use. */
export function __setToolEnvironment(
    adapter: ExecFileAdapter,
    platform: NodeJS.Platform = process.platform,
): () => void {
    const prevAdapter = execFileAdapter;
    const prevPlatform = toolPlatform;
    execFileAdapter = adapter;
    toolPlatform = platform;
    return () => { execFileAdapter = prevAdapter; toolPlatform = prevPlatform; };
}

// Mirrors execFileSync's own typing: with `encoding` set the caller gets a
// string, otherwise a Buffer. Without this the callers that .trim() the output
// would have to cast at every site.
export function runTool(command: string, args: string[], opts: { encoding: string } & Record<string, unknown>): string;
export function runTool(command: string, args: string[], opts?: Record<string, unknown>): Buffer;
export function runTool(command: string, args: string[], opts: Record<string, unknown> = {}): string | Buffer {
    const spec = launchSpec(command, args, toolPlatform);
    try {
        return execFileAdapter(spec.file, spec.args, opts);
    } catch (error) {
        // ENOENT on Windows reads like "npm is missing" when the real story is
        // that the resolved launcher was not on PATH. Name what we ran.
        const err = error as Error & { code?: string | number; resolvedCommand?: string };
        err.resolvedCommand = `${spec.file} ${spec.args.join(' ')}`;
        if (err.code === 'ENOENT') {
            err.message = `${err.message} (resolved command: ${err.resolvedCommand})`;
        }
        throw error;
    }
}
import { buildServicePath } from '../src/core/runtime-path.js';
import { classifyClaudeInstall } from '../src/core/claude-install.js';
import {
    isWindowsNodeLaunchedFromWsl,
    resolveInvocationCwd,
    resolvePlatformKind,
} from '../src/core/platform-kind.js';
import {
    isSpawnableCliFile,
    listCliBinaryCandidates,
    readProcessPath,
} from '../src/core/cli-detect.js';
import { asArray, asRecord, errString, fieldString } from './_http-client.js';

// ─── JAW_HOME inline (config.ts → registry.ts import 체인 제거) ───
const JAW_HOME = (() => {
    if (!process.env["CLI_JAW_HOME"]) return path.join(os.homedir(), '.cli-jaw');
    const resolved = resolveHomePath(process.env["CLI_JAW_HOME"]);
    const userHome = os.homedir();
    if (process.env["NODE_ENV"] !== 'test' && !resolved.startsWith(userHome + path.sep) && resolved !== userHome) {
        console.error(`[jaw:init] ❌ CLI_JAW_HOME must be under user home (${userHome}): ${resolved}`);
        process.exit(1);
    }
    return resolved;
})();

const home = os.homedir();
const jawHome = JAW_HOME;
const PATH_LOOKUP_CMD = process.platform === 'win32' ? 'where.exe' : 'which';
const MCP_SERVERS_SKIP = process.env["CLI_JAW_SKIP_MCP_SERVERS"] === '1'
    || process.env["CLI_JAW_SKIP_MCP_SERVERS"] === 'true';
const SKILL_DEPS_SKIP = process.env["CLI_JAW_SKIP_SKILL_DEPS"] === '1'
    || process.env["CLI_JAW_SKIP_SKILL_DEPS"] === 'true';
const CLAUDE_NATIVE_INSTALL_URL = 'https://claude.ai/install.sh';
const CLAUDE_NATIVE_INSTALL_PS_URL = 'https://claude.ai/install.ps1';

export type ClaudeInstructionCleanupResult =
    | 'missing'
    | 'removed-symlink'
    | 'removed-mirror'
    | 'kept-custom'
    | 'error';

// ─── Legacy migration ───
// Moved into runPostinstall() to prevent side effects on dynamic import.
// (init.ts imports this module for installCliTools/etc — must not trigger fs.renameSync)

function postinstallExecEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const currentPath = env["PATH"] || env["Path"] || env["path"] || '';
    const safePath = buildServicePath(currentPath);
    const out: NodeJS.ProcessEnv = { ...env };
    delete out["PATH"];
    delete out["Path"];
    delete out["path"];
    out[process.platform === 'win32' ? 'Path' : 'PATH'] = safePath;
    return out;
}

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[jaw:init] created ${dir}`);
    }
}


export function removeJawHomeClaudeInstructionFile(baseDir = jawHome): ClaudeInstructionCleanupResult {
    const agentsMd = path.join(baseDir, 'AGENTS.md');
    const claudeMd = path.join(baseDir, 'CLAUDE.md');
    try {
        if (!fs.existsSync(claudeMd)) return 'missing';

        const stat = fs.lstatSync(claudeMd);
        if (stat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(claudeMd);
            const resolvedTarget = path.resolve(path.dirname(claudeMd), linkTarget);
            const resolvedAgents = path.resolve(agentsMd);
            if (resolvedTarget === resolvedAgents || path.basename(linkTarget) === 'AGENTS.md') {
                fs.unlinkSync(claudeMd);
                console.log(`[jaw:init] removed deprecated CLAUDE.md symlink: ${claudeMd}`);
                return 'removed-symlink';
            }
            console.warn(`[jaw:init] keeping custom CLAUDE.md symlink: ${claudeMd} -> ${linkTarget}`);
            return 'kept-custom';
        }

        if (stat.isFile() && fs.existsSync(agentsMd)) {
            const claudeText = fs.readFileSync(claudeMd, 'utf8');
            const agentsText = fs.readFileSync(agentsMd, 'utf8');
            if (claudeText === agentsText) {
                fs.unlinkSync(claudeMd);
                console.log(`[jaw:init] removed deprecated CLAUDE.md mirror: ${claudeMd}`);
                return 'removed-mirror';
            }
        }

        console.warn(`[jaw:init] keeping custom CLAUDE.md: ${claudeMd}`);
        return 'kept-custom';
    } catch (e: unknown) {
        console.warn(`[jaw:init] CLAUDE.md cleanup failed: ${claudeMd} (${errString(e) || 'unknown'})`);
        return 'error';
    }
}

function findBinaryPath(name: string): string | null {
    try {
        const out = runTool(PATH_LOOKUP_CMD, [name], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000,
            env: postinstallExecEnv(),
        }).trim();
        const first = out.split(/\r?\n/).map(x => x.trim()).find(Boolean);
        return first || null;
    } catch {
        return null;
    }
}

export function npmGlobalBinDirFromPrefix(prefix: string | null | undefined, platform: NodeJS.Platform = process.platform): string | null {
    const trimmed = String(prefix || '').trim();
    if (!trimmed) return null;
    return platform === 'win32' ? trimmed : path.join(trimmed, 'bin');
}

export function isPathEntryPresent(pathValue: string | null | undefined, dir: string, platform: NodeJS.Platform = process.platform): boolean {
    const target = path.normalize(dir).replace(/[\\/]+$/, '');
    const normalizedTarget = platform === 'win32' ? target.toLowerCase() : target;
    const separator = platform === 'win32' ? ';' : path.delimiter;
    return String(pathValue || '')
        .split(separator)
        .map((entry) => path.normalize(entry.trim()).replace(/[\\/]+$/, ''))
        .filter(Boolean)
        .some((entry) => (platform === 'win32' ? entry.toLowerCase() : entry) === normalizedTarget);
}

function readNpmGlobalPrefix(): string | null {
    try {
        return runTool('npm', ['prefix', '-g'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000,
            env: postinstallExecEnv(),
        }).trim();
    } catch {
        return null;
    }
}

function persistWindowsUserPathDir(dir: string): boolean {
    const ps = process.env["SystemRoot"] ? path.join(process.env["SystemRoot"], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
    const script = `
$dir = $args[0]
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($current) { $entries = $current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
if (-not ($entries -contains $dir)) {
  $next = if ($current) { "$current;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
}
`;
    try {
        runTool(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, dir], {
            stdio: 'pipe',
            timeout: 10000,
            env: postinstallExecEnv(),
        });
        return true;
    } catch (e: unknown) {
        const message = errString(e);
        console.warn(`[jaw:init] ⚠️  could not persist npm global bin on user PATH: ${message || dir}`);
        return false;
    }
}

function ensureNpmGlobalBinOnUserPath(): void {
    const prefix = readNpmGlobalPrefix();
    const binDir = npmGlobalBinDirFromPrefix(prefix);
    if (!binDir) return;

    const currentPath = process.env["PATH"] || process.env["Path"] || process.env["path"] || '';
    if (isPathEntryPresent(currentPath, binDir)) return;

    if (process.platform === 'win32') {
        if (persistWindowsUserPathDir(binDir)) {
            console.log(`[jaw:init] ✅ added npm global bin to the Windows user PATH: ${binDir}`);
            console.log('[jaw:init]    Open a new PowerShell, then run: jaw --version');
        } else {
            console.warn(`[jaw:init] ⚠️  npm global bin is not on PATH: ${binDir}`);
            console.warn('[jaw:init]    Add it to the Windows user PATH, then open a new PowerShell.');
        }
        return;
    }

    console.warn(`[jaw:init] ⚠️  npm global bin is not on PATH: ${binDir}`);
    console.warn('[jaw:init]    Add it to your shell profile if `jaw` is not found after install.');
}


interface SkillsSymlinkLink {
    action?: unknown;
    status?: unknown;
    backupPath?: unknown;
    linkPath?: unknown;
    message?: unknown;
}

interface SkillsSymlinkReport {
    links?: SkillsSymlinkLink[];
}

function logSkillsSymlinkReport(report: SkillsSymlinkReport) {
    const links = asArray<SkillsSymlinkLink>(report.links);
    if (!links.length) return;

    const moved = links.filter((x) => x.action === 'backup_replace');
    if (moved.length) {
        console.log(`[jaw:init] skills conflicts moved to backup: ${moved.length}`);
        for (const item of moved) {
            const backupPath = fieldString(item.backupPath);
            if (backupPath) {
                console.log(`[jaw:init]   - ${fieldString(item.linkPath)} -> ${backupPath}`);
            }
        }
    }

    const errors = links.filter((x) => x.status === 'error');
    for (const item of errors) {
        console.log(`[jaw:init] ⚠️ symlink error: ${fieldString(item.linkPath)} (${fieldString(item.message, 'unknown')})`);
    }
}


/**
 * 업그레이드 유저의 launchd plist가 ProcessType 키 없으면 새 format으로 재등록.
 * Fresh install(plist 없음)은 skip — jaw launchd 명시 실행 시점에 생성됨.
 */
async function maybeReregisterLaunchd() {
    if (process.platform !== 'darwin') return;
    const label = 'com.cli-jaw.default';
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!fs.existsSync(plistPath)) return;

    try {
        const content = fs.readFileSync(plistPath, 'utf8');
        if (content.includes('<key>ProcessType</key>')) {
            console.log('[jaw:init] ⏭️  launchd plist 이미 최신 포맷');
            return;
        }
    } catch {
        return;
    }

    console.log('[jaw:init] 🔄 launchd plist 구 포맷 감지 — 새 포맷으로 재등록 시도');
    const jawBin = findBinaryPath('jaw') || findBinaryPath('cli-jaw');
    if (!jawBin) {
        console.warn('[jaw:init] ⚠️  jaw 바이너리 탐색 실패 — 수동: jaw launchd');
        return;
    }
    try {
        runTool(jawBin, ['launchd'], { stdio: 'inherit', timeout: 30000, env: postinstallExecEnv() });
    } catch (e: unknown) {
        console.warn(`[jaw:init] ⚠️  launchd 재등록 실패 — 수동: jaw launchd`);
        const message = errString(e);
        if (message) console.warn(`   ${message.slice(0, 120)}`);
    }
}

// ─── Exported install functions (module-level, no side effects) ─────

export type InstallOpts = {
    dryRun?: boolean;
    interactive?: boolean;
    ask?: (question: string, defaultVal: string) => Promise<string>;
};

const XAI_GROK_NATIVE_INSTALL_URL = 'https://x.ai/cli/install.sh';

type CliToolInstall = { bin: string; pkg: string; brew?: string; installer?: 'npm' | 'xai-native' };

const CLI_PACKAGES: CliToolInstall[] = [
    { bin: 'claude', pkg: '@anthropic-ai/claude-code' },
    { bin: 'codex', pkg: '@openai/codex' },
    { bin: 'gemini', pkg: '@google/gemini-cli' },
    { bin: 'grok', pkg: 'Grok Build', installer: 'xai-native' },
    { bin: 'copilot', pkg: '@github/copilot' },
    { bin: 'opencode', pkg: 'opencode-ai' },
];

type PkgMgr = 'bun' | 'npm' | 'brew';

function truthyEnv(value: string | undefined): boolean {
    return value === '1' || value?.toLowerCase() === 'true';
}

export function shouldInstallCliToolsDuringPostinstall(env: NodeJS.ProcessEnv = process.env): boolean {
    return truthyEnv(env["CLI_JAW_INSTALL_CLI_TOOLS"]) || truthyEnv(env["npm_config_jaw_install_cli_tools"]);
}

export function shouldRequireCliToolsDuringPostinstall(env: NodeJS.ProcessEnv = process.env): boolean {
    return truthyEnv(env["CLI_JAW_REQUIRE_CLI_TOOLS"]) || truthyEnv(env["npm_config_jaw_require_cli_tools"]);
}

export function shouldInstallClaudeDuringPostinstall(env: NodeJS.ProcessEnv = process.env): boolean {
    return !truthyEnv(env["CLI_JAW_SKIP_CLAUDE"]) && !truthyEnv(env["npm_config_jaw_skip_claude"]);
}

export function shouldForceClaudeDuringPostinstall(env: NodeJS.ProcessEnv = process.env): boolean {
    return truthyEnv(env["CLI_JAW_FORCE_CLAUDE"]) || truthyEnv(env["npm_config_jaw_force_claude"]);
}

export function shouldDedupeCliTools(env: NodeJS.ProcessEnv = process.env): boolean {
    return truthyEnv(env["CLI_JAW_DEDUPE_CLI_TOOLS"]) || truthyEnv(env["npm_config_jaw_dedupe_cli_tools"]);
}

function shouldMigrateLegacyHome(env: NodeJS.ProcessEnv = process.env): boolean {
    return truthyEnv(env["CLI_JAW_MIGRATE_LEGACY_HOME"]) || truthyEnv(env["npm_config_jaw_migrate_legacy_home"]);
}

function npmPrefixGlobal(): string | null {
    try {
        return runTool('npm', ['prefix', '-g'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 3000,
            env: postinstallExecEnv(),
        }).trim();
    } catch {
        return null;
    }
}

function pathHasSegment(candidate: string, segment: string): boolean {
    return candidate.split(path.sep).includes(segment);
}

export function classifyInstallerFromPath(
    binPath: string,
    options: { binName?: string; npmPrefix?: string | null; realPath?: string | null } = {},
): PkgMgr | null {
    const cleanBinPath = path.normalize(binPath);
    const realPath = path.normalize(options.realPath || binPath);
    const npmPrefix = options.npmPrefix ? path.normalize(options.npmPrefix) : '';
    const binName = options.binName || path.basename(cleanBinPath);

    if (pathHasSegment(cleanBinPath, '.bun') || pathHasSegment(realPath, '.bun')) return 'bun';
    if (pathHasSegment(realPath, 'Cellar')) return 'brew';

    if (npmPrefix) {
        const npmBin = path.join(npmPrefix, 'bin');
        const npmModules = path.join(npmPrefix, 'lib', 'node_modules');
        if (
            cleanBinPath === path.join(npmBin, binName)
            || cleanBinPath.startsWith(`${npmBin}${path.sep}`)
            || realPath.startsWith(`${npmModules}${path.sep}`)
            || realPath === path.join(npmModules, binName)
        ) {
            return 'npm';
        }
    }

    if (pathHasSegment(cleanBinPath, '.nvm') || pathHasSegment(realPath, '.nvm')) return 'npm';
    if (pathHasSegment(cleanBinPath, 'nodejs') || pathHasSegment(realPath, 'nodejs')) return 'npm';
    return null;
}

/** Detect which package manager originally installed a binary. */
export function detectInstaller(binName: string): PkgMgr | null {
    const binPath = findBinaryPath(binName);
    if (!binPath) return null;
    let realPath: string | null = null;
    try {
        realPath = fs.realpathSync(binPath);
    } catch {
        realPath = null;
    }
    return classifyInstallerFromPath(binPath, {
        binName,
        npmPrefix: npmPrefixGlobal(),
        realPath,
    });
}

function buildInstallCmd(mgr: PkgMgr, pkg: string, brewFormula?: string): string {
    switch (mgr) {
        case 'brew': return `brew upgrade ${brewFormula || pkg} 2>/dev/null || brew install ${brewFormula || pkg}`;
        case 'bun':  return `bun install -g ${pkg}@latest`;
        case 'npm':  return `npm i -g ${pkg}@latest`;
    }
}

/** Exported for #274 coverage: the install path must resolve npm.cmd on win32. */
export function runInstallCmd(mgr: PkgMgr, pkg: string, env: NodeJS.ProcessEnv, brewFormula?: string): void {
    const timeout = 180000;
    if (mgr === 'brew') {
        try {
            runTool('brew', ['upgrade', brewFormula || pkg], { stdio: 'pipe', timeout, env });
        } catch {
            runTool('brew', ['install', brewFormula || pkg], { stdio: 'pipe', timeout, env });
        }
    } else if (mgr === 'bun') {
        runTool('bun', ['install', '-g', `${pkg}@latest`], { stdio: 'pipe', timeout, env });
    } else {
        runTool('npm', ['i', '-g', `${pkg}@latest`], { stdio: 'pipe', timeout, env });
    }
}

function buildClaudeNativeInstallCmd(): string {
    if (process.platform === 'win32') {
        return `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Invoke-RestMethod '${CLAUDE_NATIVE_INSTALL_PS_URL}')"`;
    }
    return `curl -fsSL -o /tmp/claude-install.sh ${CLAUDE_NATIVE_INSTALL_URL} && bash /tmp/claude-install.sh`;
}

function runClaudeNativeInstall(_cmd: string): void {
    const env = postinstallExecEnv();
    if (process.platform === 'win32') {
        runTool('powershell', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `Invoke-Expression (Invoke-RestMethod '${CLAUDE_NATIVE_INSTALL_PS_URL}')`,
        ], {
            stdio: 'pipe',
            timeout: 180000,
            env,
        });
        return;
    }
    const tmpScript = path.join(os.tmpdir(), `claude-install-${Date.now()}.sh`);
    try {
        runTool('curl', ['-fsSL', '-o', tmpScript, CLAUDE_NATIVE_INSTALL_URL], {
            stdio: 'pipe', timeout: 30000, env,
        });
        runTool('bash', [tmpScript], {
            stdio: 'pipe', timeout: 180000, env,
        });
    } finally {
        try { fs.unlinkSync(tmpScript); } catch {} // best-effort: temp script cleanup
    }
}

function buildGrokNativeInstallCmd(): string {
    return `curl -fsSL ${XAI_GROK_NATIVE_INSTALL_URL} | bash`;
}

function runGrokNativeInstall(): void {
    const env = postinstallExecEnv();
    const tmpScript = path.join(os.tmpdir(), `grok-install-${Date.now()}.sh`);
    try {
        runTool('curl', ['-fsSL', '-o', tmpScript, XAI_GROK_NATIVE_INSTALL_URL], {
            stdio: 'pipe',
            timeout: 30000,
            env,
        });
        runTool('bash', [tmpScript], {
            stdio: 'pipe',
            timeout: 180000,
            env,
        });
    } finally {
        try { fs.unlinkSync(tmpScript); } catch {} // best-effort: temp script cleanup
    }
}

function installGrokCli(): boolean {
    if (process.platform === 'win32') {
        console.warn('[jaw:init] ⚠️  grok: native PowerShell CLI-JAW install is unsupported');
        console.warn(`[jaw:init]    install Grok inside WSL instead: ${buildGrokNativeInstallCmd()}`);
        return false;
    }

    const cmd = buildGrokNativeInstallCmd();
    console.log(`[jaw:init] 📦 grok (xAI native installer): ${cmd}`);
    try {
        runGrokNativeInstall();
    } catch (e: unknown) {
        console.error(`[jaw:init] ⚠️  grok: auto-install failed — install manually: ${cmd}`);
        const message = errString(e);
        if (message) console.error(`             ${message.slice(0, 160)}`);
        return false;
    }

    const existingPath = findRunnableCliBinary('grok');
    if (existingPath) {
        console.log(`[jaw:init] ✅ grok native binary verified → ${existingPath}`);
        return true;
    }

    console.error('[jaw:init] ⚠️  grok: installer completed but binary was not found or not runnable');
    return false;
}

function findClaudeNativeBinary(): string | null {
    const candidates = [
        path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
        path.join(home, '.claude', 'local', 'bin', 'claude'),
        process.platform === 'win32' && process.env["LOCALAPPDATA"]
            ? path.join(process.env["LOCALAPPDATA"], 'Claude', 'claude.exe')
            : null,
        process.platform === 'win32' && process.env["LOCALAPPDATA"]
            ? path.join(process.env["LOCALAPPDATA"], 'Anthropic', 'Claude', 'claude.exe')
            : null,
        process.platform === 'win32' && process.env["LOCALAPPDATA"]
            ? path.join(process.env["LOCALAPPDATA"], 'Programs', 'Claude', 'claude.exe')
            : null,
        findBinaryPath('claude'),
    ].filter((candidate): candidate is string => !!candidate);

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        if (process.platform !== 'win32' && !isSpawnableCliFile(candidate, process.platform).ok) continue;
        try {
            const realPath = fs.realpathSync(candidate);
            if (classifyClaudeInstall(candidate) === 'native' || classifyClaudeInstall(realPath) === 'native') {
                return candidate;
            }
        } catch {
            if (classifyClaudeInstall(candidate) === 'native') return candidate;
        }
    }
    return null;
}

export function findRunnableCliBinary(name: string): string | null {
    const scan = listCliBinaryCandidates(name, readProcessPath());
    for (const candidate of scan.candidates) {
        if (!candidate.spawnable) {
            console.log(`[jaw:init] ⚠️  ${name} candidate is not spawnable → ${candidate.path}`);
            continue;
        }
        if (isRunnableCliBinary(name, candidate.path)) return candidate.path;
    }
    return null;
}

function findExistingCliBinary(name: string): string | null {
    return findRunnableCliBinary(name);
}

function findExistingClaudeBinary(): string | null {
    return findRunnableCliBinary('claude');
}

function outputText(value: unknown): string {
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return fieldString(value);
}

function childFailureOutput(error: unknown): string {
    const err = asRecord(error);
    return [outputText(err["stderr"]), outputText(err["stdout"]), errString(error)]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n');
}

function runCliVersionCheck(binaryPath: string): void {
    const common = {
        encoding: 'utf8' as const,
        stdio: 'pipe' as const,
        timeout: 5000,
        env: postinstallExecEnv(),
    };
    if (process.platform === 'win32') {
        runTool('powershell', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            '& $args[0] --version',
            binaryPath,
        ], common);
        return;
    }
    runTool(binaryPath, ['--version'], common);
}

function isRunnableCliBinary(name: string, binaryPath: string): boolean {
    try {
        runCliVersionCheck(binaryPath);
        return true;
    } catch (e: unknown) {
        const output = childFailureOutput(e);
        console.log(`[jaw:init] ⚠️  ${name} exists but failed --version → ${binaryPath}`);
        if (output) console.log(`             ${output.slice(0, 160)}`);
        return false;
    }
}

function isRunnableClaudeBinary(binaryPath: string): boolean {
    return isRunnableCliBinary('claude', binaryPath);
}

function installClaudeCli(options: { force?: boolean } = {}): boolean {
    const existingPath = findExistingClaudeBinary();
    if (existingPath && !options.force) {
        console.log(`[jaw:init] ⏭️  claude already works → ${existingPath}`);
        return true;
    }

    const cmd = buildClaudeNativeInstallCmd();
    const label = process.platform === 'win32' ? 'native PowerShell installer' : 'native installer';
    console.log(`[jaw:init] 📦 claude (${label}): ${cmd}`);
    try {
        runClaudeNativeInstall(cmd);
    } catch (e: unknown) {
        console.error(`[jaw:init] ⚠️  claude: auto-install failed — install manually: ${cmd}`);
        const message = errString(e);
        if (message) console.error(`             ${message.slice(0, 160)}`);
        return false;
    }

    const nativePath = findClaudeNativeBinary();
    if (nativePath && isRunnableClaudeBinary(nativePath)) {
        console.log(`[jaw:init] ✅ claude native binary verified → ${nativePath}`);
        return true;
    }

    if (nativePath) {
        console.error(`[jaw:init] ⚠️  claude native binary exists but failed --version → ${nativePath}`);
    }

    console.error('[jaw:init] ⚠️  claude: installer completed but native binary was not found or not runnable');
    console.error('[jaw:init]    expected a working native claude binary under ~/.local/bin, ~/.claude, %USERPROFILE%\\.local\\bin, or %LOCALAPPDATA%');
    return false;
}

/** Check if a package is installed via a specific manager (independent of PATH order). */
function isInstalledVia(mgr: PkgMgr, pkg: string, brewFormula?: string): boolean {
    try {
        switch (mgr) {
            case 'npm':
                runTool('npm', ['ls', '-g', pkg, '--depth=0'], { stdio: 'pipe', timeout: 5000, env: postinstallExecEnv() });
                return true;
            case 'bun': {
                const bunGlobal = path.join(home, '.bun', 'install', 'global', 'node_modules', pkg.split('/').pop()!);
                return fs.existsSync(bunGlobal);
            }
            case 'brew':
                runTool('brew', ['list', '--formula', brewFormula || pkg], { stdio: 'pipe', timeout: 5000, env: postinstallExecEnv() });
                return true;
        }
    } catch { return false; }
}

function buildUninstallCmd(mgr: PkgMgr, pkg: string, brewFormula?: string): string {
    switch (mgr) {
        case 'npm':  return `npm uninstall -g ${pkg}`;
        case 'bun':  return `bun remove -g ${pkg}`;
        case 'brew': return `brew uninstall ${brewFormula || pkg}`;
    }
}

/** Remove duplicate installations — keep the preferred manager when postinstall just installed one. */
function deduplicateCliTool(bin: string, pkg: string, brew?: string, preferredActive?: PkgMgr): void {
    const detectedActive = detectInstaller(bin);
    const active = preferredActive && isInstalledVia(preferredActive, pkg, brew)
        ? preferredActive
        : detectedActive;
    if (!active) return; // not installed at all
    const others: PkgMgr[] = (['bun', 'npm', 'brew'] as const).filter(m => m !== active);
    const duplicates = others.filter(mgr => isInstalledVia(mgr, pkg, brew));
    if (!duplicates.length) return;
    if (!shouldDedupeCliTools()) {
        console.log(`[jaw:init] ℹ️  ${bin}: duplicate install(s) detected via ${duplicates.join(', ')}; not removing automatically`);
        console.log('[jaw:init]    set CLI_JAW_DEDUPE_CLI_TOOLS=1 to allow automatic duplicate removal');
        return;
    }
    for (const mgr of duplicates) {
        console.log(`[jaw:init] 🧹 ${bin}: removing duplicate from ${mgr} (active: ${active})`);
        try {
            const env = postinstallExecEnv();
            if (mgr === 'npm') runTool('npm', ['uninstall', '-g', pkg], { stdio: 'pipe', timeout: 30000, env });
            else if (mgr === 'bun') runTool('bun', ['remove', '-g', pkg], { stdio: 'pipe', timeout: 30000, env });
            else runTool('brew', ['uninstall', brew || pkg], { stdio: 'pipe', timeout: 30000, env });
            console.log(`[jaw:init]    removed ${pkg} from ${mgr}`);
        } catch {
            console.warn(`[jaw:init]    ⚠️  failed to remove ${pkg} from ${mgr} — remove manually: ${buildUninstallCmd(mgr, pkg, brew)}`);
        }
    }
}

export async function installCliTools(opts: InstallOpts = {}) {
    const failed: string[] = [];

    console.log('[jaw:init] installing CLI tools @latest...');
    for (const { bin, pkg, brew, installer } of CLI_PACKAGES) {
        if (bin === 'claude') {
            if (!shouldInstallClaudeDuringPostinstall()) {
                console.log('[jaw:init] claude install skipped (CLI_JAW_SKIP_CLAUDE)');
                continue;
            }
            const existingPath = findRunnableCliBinary('claude');
            if (existingPath && !shouldForceClaudeDuringPostinstall()) {
                console.log(`[jaw:init] ⏭️  claude already works → ${existingPath}`);
                continue;
            }
            if (opts.dryRun) { console.log(`  [dry-run] would run ${buildClaudeNativeInstallCmd()}`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask('Install claude (native Claude Code installer)? [y/N]', 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
            }
            if (!installClaudeCli({ force: shouldForceClaudeDuringPostinstall() })) failed.push('claude (native installer)');
            continue;
        }
        const existingPath = findExistingCliBinary(bin);
        if (existingPath) {
            console.log(`[jaw:init] ⏭️  ${bin} already works → ${existingPath}`);
            continue;
        }
        if (installer === 'xai-native') {
            if (opts.dryRun) { console.log(`  [dry-run] would run ${buildGrokNativeInstallCmd()}`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask(`Install ${bin} (${pkg} native installer)? [y/N]`, 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
            }
            if (!installGrokCli()) failed.push(`${bin} (${pkg})`);
            continue;
        }
        if (opts.dryRun) {
            console.log(`  [dry-run] would run ${buildInstallCmd('npm', pkg, brew)}`);
            continue;
        }
        if (opts.interactive && opts.ask) {
            const answer = await opts.ask(`Install ${bin} (${pkg})? [y/N]`, 'n');
            if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
        }
        const tag = existingPath ? 'repair via npm' : 'fresh install via npm';
        console.log(`[jaw:init] 📦 ${bin} (${tag}): npm i -g ${pkg}@latest`);
        try {
            runInstallCmd('npm', pkg, postinstallExecEnv(), brew);
            console.log(`[jaw:init] ✅ ${bin} installed`);
        } catch {
            failed.push(`${bin} (${pkg})`);
            console.error(`[jaw:init] ⚠️  ${bin}: auto-install failed — install manually: npm i -g ${pkg}`);
        }
        // Clean up duplicate installations from other package managers only after cli-jaw installs npm.
        deduplicateCliTool(bin, pkg, brew, 'npm');
    }

    if (failed.length > 0) {
        console.error(`[jaw:init] ⚠️  CLI tool install failed: ${failed.join(', ')} — install manually later`);
    }
}

const MCP_PACKAGES = [
    { name: 'context7', pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
];

export async function installMcpServers(opts: InstallOpts = {}) {
    console.log('[jaw:init] installing MCP servers globally...');
    const config = loadUnifiedMcp();
    let updated = false;

    const servers = asRecord(config.servers);

    for (const { name, pkg, bin } of MCP_PACKAGES) {
        try {
            const server = asRecord(servers[name]);
            if (typeof server["url"] === 'string' && server["url"]) {
                console.log(`[jaw:init] ⏭️  ${name} MCP (remote URL, no local install needed)`);
                continue;
            }

            const installedPath = findBinaryPath(bin);
            if (installedPath) {
                console.log(`[jaw:init] ⏭️  ${bin} (already installed)`);
                continue;
            }
            if (opts.dryRun) { console.log(`  [dry-run] would install ${pkg}`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask(`Install MCP server ${bin} (${pkg})? [y/N]`, 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${bin}`); continue; }
            }

            console.log(`[jaw:init] 📦 npm i -g ${pkg} ...`);
            runTool('npm', ['i', '-g', pkg], { stdio: 'pipe', timeout: 120000, env: postinstallExecEnv() });

            const binPath = findBinaryPath(bin) || bin;
            console.log(`[jaw:init] ✅ ${bin} → ${binPath}`);

            for (const srv of Object.values(servers).map(asRecord)) {
                const args = asArray(srv["args"]);
                if (srv["command"] === 'npx' && args.includes(pkg)) {
                    srv["command"] = bin;
                    srv["args"] = [];
                    updated = true;
                }
            }
        } catch (e) {
            console.error(`[jaw:init] ⚠️  ${pkg}: ${(e as Error).message?.slice(0, 80)}`);
        }
    }

    if (updated) saveUnifiedMcp(config);
}

const SKILL_DEPS = [
    {
        name: 'uv',
        check: ['uv', ['--version']] as [string, string[]],
        install: process.platform === 'win32'
            ? { type: 'remote-script' as const, url: 'https://astral.sh/uv/install.ps1', shell: 'powershell' as const }
            : { type: 'remote-script' as const, url: 'https://astral.sh/uv/install.sh', shell: 'sh' as const },
        why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
    },
    {
        name: 'playwright-core',
        check: ['node', ['-e', "require.resolve('playwright-core')"]] as [string, string[]],
        install: { type: 'npm' as const, pkg: 'playwright-core' },
        why: 'Browser control skill (cli-jaw browser)',
    },
];

export function runSkillDepInstall(install: (typeof SKILL_DEPS)[number]['install'], env: NodeJS.ProcessEnv): void {
    if ('pkg' in install) {
        runTool('npm', ['i', '-g', install.pkg], { stdio: 'pipe', timeout: 120000, env });
        return;
    }
    // PowerShell's -File dispatches on the extension: handing it a .sh path
    // is refused outright, which is why the Windows uv install failed with a
    // message that named nothing (#274).
    const suffix = install.shell === 'powershell' ? 'ps1' : 'sh';
    const tmpScript = path.join(os.tmpdir(), `jaw-dep-${Date.now()}.${suffix}`);
    try {
        runTool('curl', ['-fsSL', '-o', tmpScript, install.url], { stdio: 'pipe', timeout: 30000, env });
        if (install.shell === 'powershell') {
            runTool('powershell', ['-ExecutionPolicy', 'ByPass', '-File', tmpScript], { stdio: 'pipe', timeout: 120000, env });
        } else {
            runTool(install.shell, [tmpScript], { stdio: 'pipe', timeout: 120000, env });
        }
    } finally {
        try { fs.unlinkSync(tmpScript); } catch {} // best-effort: temp script cleanup
    }
}

export async function installSkillDeps(opts: InstallOpts = {}) {
    console.log('[jaw:init] checking skill dependencies...');
    for (const dep of SKILL_DEPS) {
        const [checkBin, checkArgs] = dep.check;
        try {
            runTool(checkBin, checkArgs, { stdio: 'pipe', timeout: 10000, env: postinstallExecEnv() });
            console.log(`[jaw:init] ⏭️  ${dep.name} (already installed)`);
        } catch {
            if (opts.dryRun) { console.log(`  [dry-run] would install ${dep.name} (${dep.why})`); continue; }
            if (opts.interactive && opts.ask) {
                const answer = await opts.ask(`Install ${dep.name} (${dep.why})? [y/N]`, 'n');
                if (answer.toLowerCase() !== 'y') { console.log(`  ⏭️  skipped ${dep.name}`); continue; }
            }
            console.log(`[jaw:init] 📦 installing ${dep.name} (${dep.why})...`);
            try {
                runSkillDepInstall(dep.install, postinstallExecEnv());
                console.log(`[jaw:init] ✅ ${dep.name} installed`);
            } catch (err) {
                // #274: the bare "auto-install failed" swallowed the real cause,
                // so a Windows uv failure could not be diagnosed at all. Surface
                // the underlying error and the manual command.
                const reason = err instanceof Error ? err.message : String(err);
                const manual = 'pkg' in dep.install
                    ? `npm i -g ${dep.install.pkg}`
                    : `see ${dep.install.url}`;
                console.error(`[jaw:init] ⚠️  ${dep.name}: auto-install failed — ${reason}`);
                console.error(`[jaw:init]    install manually: ${manual}`);
            }
        }
    }
}

// ─── runPostinstall: setup + install (no top-level side effects) ────
// Called only when running as npm postinstall entry point.
// Dynamic import from init.ts gets clean library exports only.
export async function runPostinstall() {
    // ── Safe mode guard (before ANY side effects) ──
    const isSafeMode = process.env["npm_config_jaw_safe"] === '1'
        || process.env["npm_config_jaw_safe"] === 'true'
        || process.env["JAW_SAFE"] === '1'
        || process.env["JAW_SAFE"] === 'true';

    if (isSafeMode) {
        ensureDir(jawHome);
        console.log('[jaw:postinstall] 🔒 safe mode — home directory created only');
        console.log('[jaw:postinstall] Run `jaw init` to configure interactively');
        return;
    }

    ensureNpmGlobalBinOnUserPath();

    // ── Platform lane ──
    // windows-native and wsl are disjoint by construction, and WSLENV is not a
    // WSL signal: Microsoft documents it as shared with the Windows host, so
    // the previous check fired on ordinary native Windows installs.
    //
    // resolveInvocationCwd() is required rather than process.cwd(): npm runs
    // lifecycle scripts from the installed package root, so only INIT_CWD
    // carries the directory the user actually ran npm from.
    if (isWindowsNodeLaunchedFromWsl(process.platform, resolveInvocationCwd())) {
        console.warn('[jaw:init] ⚠️  Windows Node.js invoked from a WSL directory');
        console.warn('[jaw:init]    npm -g packages will install to Windows, not WSL');
        console.warn('[jaw:init]    Recommended: install Node inside WSL (fnm install 22 or nvm install 22)');
    } else if (resolvePlatformKind() === 'windows-native') {
        console.log('[jaw:init] Windows (native) detected — global CLI shims install to the npm prefix');
    }

    // ── Legacy migration (only in normal mode, NOT safe mode) ──
    const legacyHome = path.join(home, '.cli-jaw');
    const isCustomHome = jawHome !== legacyHome;
    if (isCustomHome && fs.existsSync(legacyHome)) {
        if (fs.existsSync(jawHome)) {
            console.log(`[jaw:init] ⚠️ both ~/.cli-jaw and ${jawHome} exist — using ${jawHome}`);
        } else if (shouldMigrateLegacyHome()) {
            console.log(`[jaw:init] migrating ~/.cli-jaw → ${jawHome} ...`);
            fs.renameSync(legacyHome, jawHome);
            console.log(`[jaw:init] ✅ migration complete`);
        } else {
            console.log(`[jaw:init] legacy ~/.cli-jaw detected; not migrating to ${jawHome} automatically`);
            console.log('[jaw:init] to opt in: CLI_JAW_MIGRATE_LEGACY_HOME=1 npm install -g cli-jaw');
        }
    }

    // 1. Ensure ~/.cli-jaw/ home directory
    ensureDir(jawHome);

    // 2. Ensure sub-directories (only in normal mode)
    ensureDir(path.join(jawHome, 'skills'));
    ensureDir(path.join(jawHome, 'uploads'));

    // 2. Skills symlinks — isolated-by-default (Issue #58)
    // No workingDir compat links in postinstall.
    // Postinstall must remain isolated to ~/.cli-jaw/* only.
    const shouldMigrateSharedPaths =
        process.env["CLI_JAW_MIGRATE_SHARED_PATHS"] === '1'
        || process.env["CLI_JAW_MIGRATE_SHARED_PATHS"] === 'true'
        || process.env["npm_config_jaw_migrate_shared_paths"] === '1'
        || process.env["npm_config_jaw_migrate_shared_paths"] === 'true';

    if (shouldMigrateSharedPaths) {
        const sharedReport = ensureSharedHomeSkillsLinks({
            onConflict: 'backup',
            includeAgents: true,
            includeCompatAgent: true,
            includeClaude: true,
        });
        logSkillsSymlinkReport(sharedReport);
    } else {
        console.log('[jaw:init] shared path migration skipped (isolated-by-default)');
        console.log('[jaw:init] to opt in: CLI_JAW_MIGRATE_SHARED_PATHS=1 npm install -g cli-jaw');
    }

    // 3. Remove deprecated Jaw-home CLAUDE.md mirrors.
    // Boss prompts are already passed through append/system-prompt paths.
    removeJawHomeClaudeInstructionFile(jawHome);

    // 4. Default heartbeat.json
    const heartbeatPath = path.join(jawHome, 'heartbeat.json');
    if (!fs.existsSync(heartbeatPath)) {
        fs.writeFileSync(heartbeatPath, JSON.stringify({ jobs: [] }, null, 2), { mode: 0o600 });
        console.log(`[jaw:init] created ${heartbeatPath}`);
    }

    // 5. MCP config
    initMcpConfig(home);

    // 6. Default skills (base) + propagate to all instances
    copyDefaultSkills();
    propagateSkillsToInstances();

    // 6b. Sweep EVERY home for pre-jaw-* skill directories. Steps 6 and 6a only
    // touch the homes they walk; an upgrade from a pre-rename version leaves
    // other instances (manager, dashboard, per-port runtimes) on legacy names.
    try {
        for (const { home, result } of migrateAllJawHomes()) {
            const parts: string[] = [];
            if (result.renamed.length) parts.push(`${result.renamed.length} ref renamed`);
            if (result.backedUp.length) parts.push(`${result.backedUp.length} backed up`);
            if (result.linked.length) parts.push(`${result.linked.length} compat links`);
            if (parts.length) console.log(`[jaw:skills] ${path.basename(home)}: ${parts.join(', ')}`);
            for (const w of result.warnings) console.warn(`[jaw:skills] ${path.basename(home)}: ${w}`);
        }
    } catch (e) {
        console.warn(`[jaw:skills] namespace migration skipped: ${(e as Error).message}`);
    }

    // 7-9. Optional installs — collect errors, never abort.
    const warnings: string[] = [];

    try {
        if (shouldInstallCliToolsDuringPostinstall()) {
            await installCliTools();
        } else {
            if (shouldInstallClaudeDuringPostinstall()) {
                const ok = installClaudeCli({ force: shouldForceClaudeDuringPostinstall() });
                if (!ok) warnings.push('claude install failed — install manually: https://docs.anthropic.com/claude-code');
            } else {
                console.log('[jaw:init] claude install skipped (CLI_JAW_SKIP_CLAUDE)');
            }
            console.log('[jaw:init] additional CLI tool install/update skipped by default');
            console.log('[jaw:init] to opt in: CLI_JAW_INSTALL_CLI_TOOLS=1 npm install -g cli-jaw');
        }
    } catch (e) { warnings.push(`CLI tools: ${e instanceof Error ? e.message : e}`); }

    try {
        if (MCP_SERVERS_SKIP) {
            console.log('[jaw:init] MCP server install skipped (CLI_JAW_SKIP_MCP_SERVERS)');
        } else {
            await installMcpServers();
        }
    } catch (e) { warnings.push(`MCP servers: ${e instanceof Error ? e.message : e}`); }

    try {
        if (SKILL_DEPS_SKIP) {
            console.log('[jaw:init] skill dependency install skipped (CLI_JAW_SKIP_SKILL_DEPS)');
        } else {
            await installSkillDeps();
        }
    } catch (e) { warnings.push(`Skill deps: ${e instanceof Error ? e.message : e}`); }

    try { await maybeReregisterLaunchd(); }
    catch (e) { warnings.push(`launchd: ${e instanceof Error ? e.message : e}`); }

    if (warnings.length > 0) {
        console.error('\n[jaw:init] ⚠️  setup completed with warnings:');
        for (const w of warnings) console.error(`  - ${w}`);
        console.error('[jaw:init] cli-jaw is installed and functional. Fix the above manually if needed.\n');
    } else {
        console.log('[jaw:init] setup complete ✅');
    }
}

// Auto-run only when executed as CLI entry point (not imported)
const isEntryPoint = process.argv[1]?.endsWith('postinstall.js')
    || process.argv[1]?.endsWith('postinstall.ts');
if (isEntryPoint) {
    runPostinstall().catch(e => { console.error('[jaw:init] ⚠️  postinstall error (non-fatal):', e instanceof Error ? e.message : e); process.exit(0); });
}
