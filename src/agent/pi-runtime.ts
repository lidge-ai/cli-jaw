import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { detectCliBinary } from '../core/cli-detect.js';
import { resolveWindowsLaunchSpec, launchArgv } from '../core/windows-launch-spec.js';
import { decideShellFallback } from '../core/windows-shell-fallback.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { JAW_HOME } from '../core/config.js';
import { createNdjsonFramer, MAX_PENDING_LINE_CHARS } from './spawn/line-buffer.js';
import { probeOpenCodexEndpointModels } from '../cli/opencodex-models.js';
import { launchSpec } from '../core/exec-name.js';
import { mergeEnvWindowsSafe } from './spawn-env.js';
import { createTextStreamReader } from './stream-text.js';
import type { RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { PiTurnAccumulator, PiRuntimeError, piSupportsSettled } from './runtime/pi-turn.js';

export type PiProfileMode = 'basic' | 'openai' | 'anthropic' | 'vertex';
export type PiApiKind = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-vertex';

export type PiProfile = {
    id: string;
    label: string;
    mode: PiProfileMode;
    endpoint: string;
    apiKind: PiApiKind;
    apiKey?: string;
    model: string;
    reasoning?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
};

export type PiSettings = {
    defaultProfileId: string;
    profiles: PiProfile[];
    discoveredModels?: Record<string, string[]>;
};

export type PiCommand = {
    command: string;
    baseArgs: string[];
    source: 'env' | 'path' | 'npm-exec';
};

export interface PiModelDiscovery {
    models: string[];
    source: 'opencodex' | 'pi-offline';
}

export type PiRuntimeEvent =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; label: string; status?: string; detail?: string }
    | { kind: 'session'; sessionId: string };

export interface PiRpcSession {
    readonly child: ChildProcess;
    readonly alive: boolean;
    readonly abortEffective: boolean;
    sessionId: string | null;
    sendPrompt(message: string, opts?: {
        effort?: string;
        onEvent?: (event: PiRuntimeEvent) => void;
        onRawRecord?: (record: unknown) => void;
    }): Promise<PiPromptResult>;
    abort(): Promise<void>;
    close(): Promise<void> | void;
    kill(): void;
}

export interface PiPromptResult {
    text: string;
    stderr: string;
    runtimeOutcome?: RuntimeTurnOutcome;
}

export type PiExecutionCleanupReceipt = Readonly<{
    rpc: 'not-started' | 'closed' | 'unconfirmed';
    version: 'not-started' | 'closed' | 'unconfirmed';
    cwdDisposition: 'removable' | 'retain';
    reason: string | null;
}>;

const PI_VERSION_TIMEOUT_MS = 15_000;
const PI_VERSION_OUTPUT_BYTES = 64 * 1024;
const PI_CLEANUP_TIMEOUT_MS = 2_000;
const PI_KILL_GRACE_MS = 1_000;
type PiOwnedHandle = { child: ChildProcess; retired: boolean; closed: boolean; ownGroup: boolean;
    kill: ChildProcess['kill']; sent: Set<NodeJS.Signals> };
const PI_EXECUTION_CANCEL = Symbol('Pi execution cancellation');

/** A recognized child stays handled even after closure; never fall back to stale PID signalling. */
export function cancelPiExecution(child: ChildProcess): boolean {
    const cancel = Reflect.get(child, PI_EXECUTION_CANCEL);
    if (typeof cancel !== 'function') return false;
    cancel(); return true;
}

/** Overwrite the oneshot cancel port. Employee binds this to `session.cancel()` before `runPiTurn`. */
export function bindPiExecutionCancel(child: ChildProcess, cancel: () => void): void {
    Object.defineProperty(child, PI_EXECUTION_CANCEL, { configurable: true, value: () => { cancel(); } });
}

/** Per execution, never a PID registry. A receipt is evidence, not cwd ownership. */
function createPiExecutionCleanup() {
    const handles: Partial<Record<'rpc' | 'version', PiOwnedHandle>> = {};
    let started = false, sealed = false, decided = false;
    let receipt: PiExecutionCleanupReceipt | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let gentle: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (receipt: PiExecutionCleanupReceipt) => void;
    const cleanup = new Promise<PiExecutionCleanupReceipt>(yes => { resolve = yes; });
    const signal = (entry: PiOwnedHandle | undefined, name: NodeJS.Signals): boolean => {
        if (!entry || entry.retired || entry.child.exitCode !== null || entry.child.signalCode !== null) return false;
        if (entry.sent.has(name) || entry.sent.has('SIGKILL')) return entry.child.killed;
        entry.sent.add(name);
        try { const sent = entry.kill(name); if (!sent) entry.retired = true; return sent; }
        catch { entry.retired = true; return false; }
    };
    const groupGone = (entry: PiOwnedHandle | undefined): boolean => {
        if (!entry?.ownGroup || !entry.child.pid) return true;
        try { process.kill(-entry.child.pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const decide = (expired = false) => {
        if (!started || !sealed || decided) return;
        if (!expired && Object.values(handles).some(entry => !entry.closed)) return;
        decided = true;
        clearTimeout(deadline); clearTimeout(escalation); clearTimeout(gentle);
        const state = (kind: 'rpc' | 'version') => !handles[kind] ? 'not-started' as const
            : handles[kind]!.closed ? 'closed' as const : 'unconfirmed' as const;
        const rpc = state('rpc'), version = state('version');
        const descendantsGone = !handles.version?.closed || groupGone(handles.version);
        const safe = rpc !== 'unconfirmed' && version !== 'unconfirmed' && descendantsGone;
        // Snapshot BEFORE detaching held pipes; induced close cannot upgrade it.
        receipt = Object.freeze({ rpc, version, cwdDisposition: safe ? 'removable' : 'retain',
            reason: safe ? null : !descendantsGone ? 'descendants-unconfirmed' : 'owned-close-unconfirmed' });
        resolve(receipt);
        if (!safe) for (const entry of Object.values(handles)) {
            if (!entry.closed) { entry.child.stdout?.destroy(); entry.child.stderr?.destroy(); entry.child.unref(); }
        }
    };
    return {
        cleanup,
        get receipt() { return receipt; },
        killRpc: (name: NodeJS.Signals) => signal(handles.rpc, name),
        track(kind: 'rpc' | 'version', child: ChildProcess, ownGroup = false) {
            const entry: PiOwnedHandle = { child, retired: false, closed: false, ownGroup,
                kill: child.kill.bind(child), sent: new Set() };
            handles[kind] = entry;
            child.once('exit', () => { entry.retired = true; });
            child.once('error', () => { entry.retired = true; });
            child.once('close', () => { entry.retired = true; entry.closed = true; decide(); });
        },
        versionGroupGone: () => groupGone(handles.version),
        seal() { sealed = true; decide(); },
        teardown(force = false) {
            if (!started) {
                started = true;
                deadline = setTimeout(() => decide(true), PI_CLEANUP_TIMEOUT_MS);
                escalation = setTimeout(() => {
                    for (const entry of Object.values(handles)) signal(entry, 'SIGKILL');
                }, PI_KILL_GRACE_MS);
                try { handles.rpc?.child.stdin?.end(); } catch { /* retained handle remains owned */ }
                gentle = setTimeout(() => signal(handles.rpc, 'SIGTERM'), 750);
            }
            if (!decided) {
                signal(handles.version, 'SIGTERM');
                if (force) signal(handles.rpc, 'SIGTERM');
                decide();
            }
            return cleanup;
        },
    };
}

function notifyPiRawRecord(observer: ((record: unknown) => void) | undefined, record: unknown): void {
    try { observer?.(record); }
    catch { console.warn('[jaw:pi] raw activity observer failed'); }
}

function notifyPiEvent(observer: ((event: PiRuntimeEvent) => void) | undefined, event: PiRuntimeEvent): void {
    try { observer?.(event); }
    catch { console.warn('[jaw:pi] semantic observer failed'); }
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;
const PI_RPC_CAPABILITY_SCHEMA = 1;
const PI_RPC_CAPABILITY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const PI_RPC_ABORT_TIMEOUT_MS = 15_000;

export const DEFAULT_PI_PROFILE: PiProfile = {
    id: 'progrok',
    label: 'Progrok',
    mode: 'basic',
    endpoint: 'http://127.0.0.1:18645/v1',
    apiKind: 'openai-completions',
    apiKey: 'dummy',
    model: 'grok-composer-2.5-fast',
    reasoning: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
};

export const DEFAULT_PI_SETTINGS: PiSettings = {
    defaultProfileId: DEFAULT_PI_PROFILE.id,
    profiles: [DEFAULT_PI_PROFILE],
    discoveredModels: {
        [DEFAULT_PI_PROFILE.id]: ['grok-composer-2.5-fast', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
    },
};

function cleanId(input: unknown): string {
    const value = String(input || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!value) throw Object.assign(new Error('pi profile id required'), { statusCode: 400 });
    return value.slice(0, 80);
}

function trimString(input: unknown): string {
    return typeof input === 'string' ? input.trim() : '';
}

function modeToApiKind(mode: PiProfileMode): PiApiKind {
    if (mode === 'anthropic') return 'anthropic-messages';
    if (mode === 'vertex') return 'google-vertex';
    return 'openai-completions';
}

export function normalizePiEndpoint(input: string): { baseUrl: string; inferredApiKind: PiApiKind } {
    const raw = input.trim();
    if (!raw) throw Object.assign(new Error('endpoint required'), { statusCode: 400 });
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw Object.assign(new Error('invalid endpoint URL'), { statusCode: 400 });
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    let inferredApiKind: PiApiKind = 'openai-completions';
    if (pathname.endsWith('/chat/completions')) {
        pathname = pathname.slice(0, -'/chat/completions'.length) || '/';
        inferredApiKind = 'openai-completions';
    } else if (pathname.endsWith('/responses')) {
        pathname = pathname.slice(0, -'/responses'.length) || '/';
        inferredApiKind = 'openai-responses';
    } else if (pathname.endsWith('/messages')) {
        pathname = pathname.slice(0, -'/messages'.length) || '/';
        inferredApiKind = 'anthropic-messages';
    }
    url.pathname = pathname || '/';
    url.search = '';
    url.hash = '';
    return { baseUrl: url.toString().replace(/\/$/, ''), inferredApiKind };
}

function isLocalEndpoint(endpoint: string): boolean {
    try {
        return LOCAL_HOST_RE.test(new URL(endpoint).hostname);
    } catch {
        return false;
    }
}

export function normalizePiProfile(input: unknown): PiProfile {
    const src = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const modeRaw = trimString(src['mode']) as PiProfileMode;
    const mode: PiProfileMode = ['basic', 'openai', 'anthropic', 'vertex'].includes(modeRaw) ? modeRaw : 'basic';
    const endpointInfo = normalizePiEndpoint(trimString(src['endpoint']));
    const model = trimString(src['model']);
    if (!model) throw Object.assign(new Error('model required'), { statusCode: 400 });
    const apiKeyInput = trimString(src['apiKey']);
    const apiKey = apiKeyInput || (isLocalEndpoint(endpointInfo.baseUrl) ? 'dummy' : '');
    if (!apiKey) throw Object.assign(new Error('api key required for remote Pi profile'), { statusCode: 400 });
    return {
        id: cleanId(src['id'] || src['provider'] || src['label'] || model),
        label: trimString(src['label']) || cleanId(src['id'] || src['provider'] || model),
        mode,
        endpoint: endpointInfo.baseUrl,
        apiKind: trimString(src['apiKind']) as PiApiKind || (mode === 'basic' ? endpointInfo.inferredApiKind : modeToApiKind(mode)),
        apiKey,
        model,
        reasoning: src['reasoning'] === undefined ? true : Boolean(src['reasoning']),
        supportsDeveloperRole: src['supportsDeveloperRole'] === undefined ? true : Boolean(src['supportsDeveloperRole']),
        supportsReasoningEffort: src['supportsReasoningEffort'] === undefined ? true : Boolean(src['supportsReasoningEffort']),
    };
}

export function normalizePiSettings(input: unknown): PiSettings {
    const src = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const rawProfiles = Array.isArray(src['profiles']) ? src['profiles'] : [];
    const profiles = rawProfiles.length
        ? rawProfiles.map((profile) => normalizePiProfile(profile))
        : [...DEFAULT_PI_SETTINGS.profiles];
    const defaultProfileId = trimString(src['defaultProfileId']) || profiles[0]?.id || DEFAULT_PI_PROFILE.id;
    const discoveredModels = src['discoveredModels'] && typeof src['discoveredModels'] === 'object'
        ? src['discoveredModels'] as Record<string, string[]>
        : { ...DEFAULT_PI_SETTINGS.discoveredModels };
    return { defaultProfileId, profiles, discoveredModels };
}

export function redactPiProfile(profile: PiProfile): Record<string, unknown> {
    const key = profile.apiKey || '';
    return {
        ...profile,
        apiKey: undefined,
        apiKeySet: Boolean(key),
        apiKeyLast4: key.slice(-4),
        apiKeySource: key ? 'settings' : 'none',
    };
}

export function redactPiSettings(input: unknown): Record<string, unknown> {
    const pi = normalizePiSettings(input);
    return {
        ...pi,
        profiles: pi.profiles.map(redactPiProfile),
    };
}

export function buildPiModelsConfig(pi: PiSettings, effort = ''): Record<string, unknown> {
    const providers: Record<string, unknown> = {};
    for (const profile of pi.profiles) {
        const modelIds = [...new Set([profile.model, ...(pi.discoveredModels?.[profile.id] || [])].filter(Boolean))];
        providers[profile.id] = {
            baseUrl: profile.endpoint,
            api: profile.apiKind,
            apiKey: profile.apiKey || 'dummy',
            compat: {
                supportsDeveloperRole: profile.supportsDeveloperRole !== false,
                supportsReasoningEffort: profile.supportsReasoningEffort !== false,
            },
            models: modelIds.map((modelId) => ({
                id: modelId,
                name: modelId,
                reasoning: profile.reasoning !== false,
                input: ['text'],
                contextWindow: modelId.includes('composer') ? 128000 : 1000000,
                maxTokens: 4096,
                ...(effort ? { defaultReasoningEffort: effort } : {}),
            })),
        };
    }
    return { providers };
}

export function buildPiAgentSettings(profile: PiProfile, effort = ''): Record<string, unknown> {
    return {
        defaultProvider: profile.id,
        defaultModel: profile.model,
        ...(effort ? { thinkingLevel: effort } : {}),
    };
}

export function ensurePiRuntimeConfig(piInput: unknown, profileId: string, effort = '', root = join(JAW_HOME, 'pi', 'runtime')): string {
    const pi = normalizePiSettings(piInput);
    const profile = pi.profiles.find((entry) => entry.id === profileId) || pi.profiles[0] || DEFAULT_PI_PROFILE;
    const dir = join(root, profile.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'models.json'), JSON.stringify(buildPiModelsConfig(pi, effort), null, 2));
    fs.writeFileSync(join(dir, 'settings.json'), JSON.stringify(buildPiAgentSettings(profile, effort), null, 2));
    return dir;
}

function commandWorks(command: string, args: string[], timeout = 3000, env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        // Windows npm is npm.cmd, which spawnSync cannot launch without the
        // cmd.exe wrapper — the probe failed on a healthy host (#274).
        const spec = launchSpec(command, args, process.platform, env);
        const result = spawnSync(spec.file, spec.args, { stdio: 'ignore', timeout, env });
        return result.status === 0;
    } catch {
        return false;
    }
}

export function resolvePiCommand(env: NodeJS.ProcessEnv = process.env): PiCommand {
    const explicit = trimString(env['PI_CODING_AGENT_BIN']);
    if (explicit) return { command: explicit, baseArgs: [], source: 'env' };
    if (commandWorks('pi', ['--version'], 3000, env)) return { command: 'pi', baseArgs: [], source: 'path' };
    return {
        // The bare name is correct here: every spawn of a PiCommand routes
        // through launchSpec(), which handles the Windows npm.cmd + cmd.exe
        // resolution at the actual launch site (#274).
        command: 'npm',
        baseArgs: ['exec', '--yes', '--package', PI_PACKAGE, 'pi', '--'],
        source: 'npm-exec',
    };
}

type PiVersionObservation = { stdout: string; stderr: string; status: number };
function resolvePiCommandIdentity(command: PiCommand, result: PiVersionObservation): string {
    const version = `${result.stdout || ''}\n${result.stderr || ''}`.trim() || `exit:${String(result.status)}`;
    return JSON.stringify({ source: command.source, command: command.command, baseArgs: command.baseArgs, version });
}

function loadPiAbortEffective(profileId: string, commandId: string): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(join(JAW_HOME, 'pi', 'rpc-capabilities.json'), 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const capability = raw as Record<string, unknown>;
        if (capability['schemaVersion'] !== PI_RPC_CAPABILITY_SCHEMA
            || capability['abortEffective'] !== true
            || capability['profileId'] !== profileId
            || capability['commandId'] !== commandId) return false;
        const probedAt = Date.parse(typeof capability['probedAt'] === 'string' ? capability['probedAt'] : '');
        return Number.isFinite(probedAt)
            && probedAt <= Date.now()
            && Date.now() - probedAt <= PI_RPC_CAPABILITY_MAX_AGE_MS;
    } catch {
        return false;
    }
}

export function parsePiModelList(output: string, profileId: string): string[] {
    const models = new Set<string>();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^provider\s+model/i.test(line)) continue;
        const parts = line.split(/\s+/);
        if (parts[0] === profileId && parts[1]) models.add(parts[1]);
        else if (parts.length === 1 && parts[0] && !line.includes(' ')) models.add(parts[0]);
    }
    return [...models];
}


/**
 * Resolve a Pi spawn without a shell on Windows (#367).
 *
 * Pi sends its prompt over RPC stdin, so this is not the prompt-injection boundary the
 * issue names. It is still an injection boundary: review found the shell fallback here
 * carries a model name, an API key, and a session id, and those are only trimmed on the
 * way in. A model identifier containing `&` splits one command into two just as well as
 * a prompt does.
 *
 * So the fallback is now conditional. Argv that cmd.exe could read as command syntax
 * refuses; everything else keeps the legacy path, which matters because that path is
 * what keeps unusual installs working until the native gate proves resolution for every
 * classified runtime.
 */
function resolvePiSpawn(command: string, args: string[]): {
    command: string; args: string[]; useShell: boolean; envDelta: Record<string, string>;
} {
    if (process.platform !== 'win32') return { command, args, useShell: false, envDelta: {} };
    const spec = resolveWindowsLaunchSpec(command, args, {
        which: (name) => detectCliBinary(name).path || null,
    });
    // envDelta carries `env -S FOO=bar` assignments from the target's shebang.
    // Dropping it launches the runtime with a different configuration than its own
    // shim asks for, which is a silent behavior change rather than a loud failure.
    if (spec) return { command: spec.command, args: launchArgv(spec), useShell: false, envDelta: spec.envDelta };
    const wantsShell = !command.toLowerCase().endsWith('.exe');
    if (wantsShell) {
        const decision = decideShellFallback({ argv: args, command });
        if (!decision.allowed) throw new Error(decision.reason);
    }
    return { command, args, useShell: wantsShell, envDelta: {} };
}

function capturePiLaunchIdentity(command: PiCommand, launch: ReturnType<typeof resolvePiSpawn>): () => boolean {
    const files = [...new Set([command.command, launch.command].filter(isAbsolute))];
    const snapshot = (file: string) => {
        try {
            const stat = fs.statSync(file, { bigint: true });
            return [fs.realpathSync(file), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join('\0');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    };
    const before = files.map(snapshot);
    return () => files.every((file, index) => snapshot(file) === before[index]);
}

function startPiVersionProbe(launch: ReturnType<typeof resolvePiSpawn>, cwd: string, env: NodeJS.ProcessEnv,
    owner: ReturnType<typeof createPiExecutionCleanup>, identityCurrent: () => boolean) {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (value: PiVersionObservation) => void, reject!: (error: Error) => void;
    const done = new Promise<PiVersionObservation>((yes, no) => { resolve = yes; reject = no; });
    const fail = (reason: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error(reason));
    };
    try {
        const child = spawn(launch.command, launch.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32', ...(launch.useShell ? { shell: true } : {}) });
        owner.track('version', child, process.platform !== 'win32');
        const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
        let stdout = '', stderr = '', outBytes = 0, errBytes = 0;
        timer = setTimeout(() => fail('pi capability probe timed out'), PI_VERSION_TIMEOUT_MS);
        child.once('error', () => fail('pi capability probe spawn failed'));
        child.stdout?.once('error', () => fail('pi capability stdout failed'));
        child.stderr?.once('error', () => fail('pi capability stderr failed'));
        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) return;
            outBytes += chunk.length;
            if (outBytes > PI_VERSION_OUTPUT_BYTES) { fail('pi capability stdout exceeded limit'); return; }
            stdout += outDecoder.write(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (settled) return;
            errBytes += chunk.length;
            if (errBytes > PI_VERSION_OUTPUT_BYTES) { fail('pi capability stderr exceeded limit'); return; }
            stderr += errDecoder.write(chunk);
        });
        child.once('close', (status, signal) => {
            if (settled) return;
            try {
                if (status === null || signal !== null || !owner.versionGroupGone()) {
                    fail('pi capability probe close unconfirmed'); return;
                }
                if (!identityCurrent()) { fail('pi capability command changed during preparation'); return; }
                stdout += outDecoder.end(); stderr += errDecoder.end();
                settled = true; clearTimeout(timer); resolve({ stdout, stderr, status });
            } catch { fail('pi capability command identity unavailable'); }
        });
    } catch { fail('pi capability probe setup failed'); }
    // A factory can be closed before a caller submits its first prompt.
    void done.catch(() => {});
    return { done, cancel: () => fail('pi capability probe cancelled') };
}
export function listPiModels(piInput: unknown, profileId: string, options: { effort?: string; root?: string; timeoutMs?: number } = {}): Promise<string[]> {
    const dir = ensurePiRuntimeConfig(piInput, profileId, options.effort || '', options.root);
    const cmd = resolvePiCommand();
    const launch = resolvePiSpawn(cmd.command, [...cmd.baseArgs, '--offline', '--list-models', profileId]);
    return new Promise((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
            env: mergeEnvWindowsSafe({ ...process.env, PI_CODING_AGENT_DIR: dir }, launch.envDelta),
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(launch.useShell ? { shell: true } : {}),
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(Object.assign(new Error('pi model discovery timed out'), { statusCode: 504 }));
        }, options.timeoutMs ?? 20_000);
        // One reader per stream (#382): per-chunk toString() splits multi-byte
        // CJK across chunk boundaries (stream-text.ts rule 1).
        const stdoutReader = createTextStreamReader();
        const stderrReader = createTextStreamReader();
        child.stdout.on('data', (chunk) => { stdout += stdoutReader.write(chunk); });
        child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += stderrReader.write(chunk); });
       child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            stdout += stdoutReader.end();
            stderr += stderrReader.end();
            if (code !== 0) {
                reject(Object.assign(new Error(stderr.trim() || `pi list models failed with code ${code}`), { statusCode: 502 }));
                return;
            }
            resolve(parsePiModelList(`${stdout}\n${stderr}`, profileId));
        });
    });
}

export async function discoverPiProfileModels(
    piInput: unknown,
    profile: PiProfile,
    options: { effort?: string; root?: string; timeoutMs?: number } = {},
): Promise<PiModelDiscovery> {
    const openCodexModels = await probeOpenCodexEndpointModels(profile.endpoint, options.timeoutMs ?? 1500);
    if (openCodexModels) return { models: openCodexModels, source: 'opencodex' };

    const models = await listPiModels(piInput, profile.id, options);
    return { models, source: 'pi-offline' };
}

function extractTextOnly(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractTextOnly).join('');
    if (!value || typeof value !== 'object') return '';
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'thinking') return '';
    return extractTextOnly(obj['text']) || extractTextOnly(obj['delta']) || extractTextOnly(obj['content']) || extractTextOnly(obj['message']) || '';
}

function extractAssistantMessagesText(value: unknown): string {
    if (!Array.isArray(value)) return extractTextOnly(value);
    return value
        .filter((entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)['role'] === 'assistant')
        .map(extractTextOnly)
        .join('');
}

export function parsePiRpcRecord(record: unknown): { done?: boolean; text?: string; thinking?: string; sessionId?: string; tool?: { label: string; status?: string; detail?: string } } {
    if (!record || typeof record !== 'object') return {};
    const obj = record as Record<string, unknown>;
    const type = typeof obj['type'] === 'string' ? obj['type'] : '';

    if (type === 'message_update') {
        const ame = obj['assistantMessageEvent'];
        if (ame && typeof ame === 'object') {
            const a = ame as Record<string, unknown>;
            const ameType = typeof a['type'] === 'string' ? a['type'] : '';
            if (ameType === 'thinking_delta') {
                const delta = typeof a['delta'] === 'string' ? a['delta'] : '';
                if (delta) return { thinking: delta };
                return {};
            }
            if (ameType === 'text_delta') {
                const delta = typeof a['delta'] === 'string' ? a['delta'] : '';
                if (delta) return { text: delta };
                return {};
            }
            if (ameType === 'toolcall_end') return {};
        }
        return {};
    }

    if (type === 'agent_end') {
        const finalText = extractAssistantMessagesText(obj['messages']);
        const sid = extractPiSessionId(obj);
        const base = sid ? { done: true, sessionId: sid } : { done: true };
        return finalText ? { ...base, text: finalText } : base;
    }

    if (type === 'tool_execution_end') {
        const name = trimString(obj['toolName'] || obj['name'] || obj['tool_name']) || 'Pi tool';
        const argsStr = obj['args'] != null ? JSON.stringify(obj['args']).slice(0, 2000) : '';
        const resultObj = obj['result'] && typeof obj['result'] === 'object' ? obj['result'] as Record<string, unknown> : null;
        const resultStr = resultObj
            ? extractToolResultText(resultObj).slice(0, 2000)
            : (obj['result'] != null ? JSON.stringify(obj['result']).slice(0, 2000) : '');
        const detail = [argsStr, resultStr].filter(Boolean).join('\n');
        const tool: { label: string; status: string; detail?: string } = { label: name, status: 'done' };
        if (detail) tool.detail = detail;
        return { tool };
    }

    const sid = extractPiSessionId(obj);
    if (sid) return { sessionId: sid };

    if (type === 'response') {
        const data = obj['data'] && typeof obj['data'] === 'object' ? obj['data'] as Record<string, unknown> : {};
        const dataSid = trimString(data['sessionId'] || data['session_id']);
        if (dataSid) return { sessionId: dataSid };
    }

    return {};
}


function extractToolResultText(result: Record<string, unknown>): string {
    const content = result['content'];
    if (!Array.isArray(content)) return typeof result['text'] === 'string' ? result['text'] : '';
    return content
        .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text')
        .map((b) => String((b as Record<string, unknown>)['text'] || ''))
        .join('\n');
}

function extractPiSessionId(obj: Record<string, unknown>): string {
    return trimString(
        obj['session_id'] || obj['sessionId']
        || ((obj['data'] && typeof obj['data'] === 'object') ? (obj['data'] as Record<string, unknown>)['sessionId'] : '')
        || ((obj['result'] && typeof obj['result'] === 'object') ? (obj['result'] as Record<string, unknown>)['sessionId'] : '')
    );
}

type PersistentPrompt = {
    turn: PiTurnAccumulator | null;
    requestId: number;
    stderrStart: number;
    onEvent: ((event: PiRuntimeEvent) => void) | undefined;
    onRawRecord: ((record: unknown) => void) | undefined;
    resolve: (result: PiPromptResult) => void;
    reject: (error: Error) => void;
};

type AbortWait = {
    id: number;
    onRawRecord: ((record: unknown) => void) | undefined;
    accepted: boolean;
    terminal: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

/**
 * Cap for an RPC session's stderr accumulator. The persistent session is the one
 * that needed it most — it outlives a single run — but both readers share the
 * constant so the two cannot silently drift apart again (#701).
 */
const PI_RPC_STDERR_MAX_CHARS = 4000;

/**
 * The one owner of Pi RPC child creation.
 *
 * `spawnPersistentPiRpc` and `spawnPiRpc` used to carry byte-identical copies of
 * this block, so every abort, capability and cleanup fix had to be applied twice
 * and in practice landed on one path only (#701). What actually differs between a
 * pooled session and a one-shot execution is the turn API layered on top — a
 * long-lived prompt loop versus a single dispatched prompt — not how the child is
 * launched, owned, or paired with its capability probe.
 *
 * The version probe is returned as a thunk rather than started here, on purpose.
 * Both callers must still start it at their own current point, after their stream
 * and lifecycle handlers are attached and before `owner.seal()`, so the relative
 * order of the two children is exactly what it was. For the same reason this
 * function is synchronous: a spawn failure reports through `error` on a later
 * tick, which a caller attaching handlers in the same turn cannot miss.
 */
function launchPiRpcExecution(profile: PiProfile, pi: PiSettings, options: {
    model: string;
    effort?: string;
    cwd: string;
    sessionId?: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
}) {
    const dir = ensurePiRuntimeConfig(pi, profile.id, options.effort || '', options.root);
    const inherited = { ...(options.env ?? process.env) }, cwd = options.cwd;
    const cmd = resolvePiCommand(inherited);
    const args = [
        ...cmd.baseArgs,
        '--mode', 'rpc',
        '--no-context-files',
        '--tools', 'read,bash,edit,write,grep,find,ls',
        '--provider', profile.id,
        '--model', options.model || profile.model,
        '--api-key', profile.apiKey || 'dummy',
        ...(options.sessionId ? ['--session-id', options.sessionId] : []),
    ];
    const launch = resolvePiSpawn(cmd.command, args);
    const versionLaunch = resolvePiSpawn(cmd.command, [...cmd.baseArgs, '--version']);
    const identityCurrent = capturePiLaunchIdentity(cmd, launch);
    const rpcEnv = mergeEnvWindowsSafe({ ...inherited, PI_CODING_AGENT_DIR: dir }, launch.envDelta);
    const versionEnv = mergeEnvWindowsSafe({ ...inherited, PI_CODING_AGENT_DIR: dir }, versionLaunch.envDelta);
    const owner = createPiExecutionCleanup();
    const child = spawn(launch.command, launch.args, {
        cwd,
        env: rpcEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(launch.useShell ? { shell: true } : {}),
    });
    owner.track('rpc', child);
    return { cmd, child, owner,
        startVersionProbe: () => startPiVersionProbe(versionLaunch, cwd, versionEnv, owner, identityCurrent) };
}

/**
 * Shared NDJSON reader for an RPC child's stdout.
 *
 * `flush` is the close-time tail: it drains the decoder and hands over a final
 * partial line. It deliberately carries no receipt check, because both callers'
 * `dispatch` already refuses an unconfirmed child, and it must stay on `close`
 * rather than `exit` so the caller's own settlement still runs after it.
 */
function readPiRpcLines(
    child: ChildProcess, dispatch: (line: string) => void, onDrop: () => void,
): { flush: () => void } {
    const decoder = new StringDecoder('utf8');
    const framer = createNdjsonFramer();
    const reportDrops = (drops: readonly { frameChars: number }[]): void => {
        for (const drop of drops) {
            console.warn(`[jaw:pi] stdout frame exceeded the ${MAX_PENDING_LINE_CHARS}-char limit — dropped ${drop.frameChars} chars`);
            onDrop();
        }
    };
    child.stdout?.on('data', (chunk) => {
        const framed = framer.push(decoder.write(chunk));
        reportDrops(framed.drops);
        for (const line of framed.lines) if (line.trim()) dispatch(line.trim());
    });
    return {
        flush: () => {
            const framed = framer.push(decoder.end());
            reportDrops(framed.drops);
            for (const line of framed.lines) if (line.trim()) dispatch(line.trim());
            const tail = framer.end();
            if (tail.drop) reportDrops([tail.drop]);
            if (tail.tail.trim()) dispatch(tail.tail.trim());
        },
    };
}

/**
 * Shared RPC frame encoder: request id, JSON body, newline.
 *
 * Each caller keeps its OWN liveness guard and refusal message. A pooled session
 * and a one-shot execution genuinely disagree about what "writable" means — the
 * session consults its own closing/poisoned state, the execution consults
 * `doneSettled` and `signalCode` — and collapsing those two predicates into one
 * would quietly change when a prompt is refused. Only the encoding is shared, and
 * `seq` stays per writer.
 */
function createPiFrameWriter(child: ChildProcess, writable: () => boolean, refusal: string) {
    let seq = 1;
    return (type: string, fields: Record<string, unknown> = {}): number => {
        if (!writable()) throw new Error(refusal);
        const id = seq++;
        child.stdin!.write(`${JSON.stringify({ id, type, ...fields })}\n`);
        return id;
    };
}

export function spawnPersistentPiRpc(profile: PiProfile, pi: PiSettings, options: {
    model: string;
    effort?: string;
    cwd: string;
    sessionId?: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
}): PiRpcSession {
    const profileId = profile.id, initialEffort = options.effort;
    const { cmd, child, owner, startVersionProbe } = launchPiRpcExecution(profile, pi, options);
    let stderr = '';
    const stderrReader = createTextStreamReader();
    let activePrompt: PersistentPrompt | null = null;
    let abortWait: AbortWait | null = null;
    let closed = false, closing = false, poisoned = false, stopRequested = false, rpcExited = false;
    let settledProtocol = false, capabilityReady = false, abortEffective = false;
    let version: ReturnType<typeof startPiVersionProbe> | undefined;
    let prepared: Promise<void>;
    let closePromise: Promise<void> | undefined;
    let failureClaim: { error: Error; stopped: boolean } | undefined;

    const write = createPiFrameWriter(child,
        () => session.alive && child.stdin.writable, 'pi rpc session is not writable');
    const settleAbort = (): void => {
        if (!abortWait || !abortWait.accepted || !abortWait.terminal) return;
        const wait = abortWait;
        abortWait = null;
        clearTimeout(wait.timer);
        wait.resolve();
    };
    const dispatchLine = (line: string): void => {
        if (closing || poisoned || owner.receipt?.rpc === 'unconfirmed') return;
        let raw: unknown;
        try { raw = JSON.parse(line); }
        catch {
            console.warn(`[jaw:pi] JSON parse failed (${line.length} chars; payload omitted)`);
            return;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const record = raw as Record<string, unknown>;
        const isAbortResponse = abortWait && record['id'] === abortWait.id
            && record['type'] === 'response' && record['command'] === 'abort';
        // The old prompt may have ended and a newer one may already be active.
        // Its abort acknowledgement still belongs to the captured abort owner.
        // A newer prompt with no observer deliberately owns (and drops) its raw records.
        notifyPiRawRecord(isAbortResponse ? abortWait?.onRawRecord
            : activePrompt ? activePrompt.turn ? activePrompt.onRawRecord : undefined : abortWait?.onRawRecord, raw);
        if (abortWait && record['id'] === abortWait.id && record['type'] === 'response' && record['command'] === 'abort') {
            if (record['success'] === true) abortWait.accepted = true;
            else {
                const wait = abortWait;
                abortWait = null;
                clearTimeout(wait.timer);
                const error = record['error'] && typeof record['error'] === 'object'
                    ? trimString((record['error'] as Record<string, unknown>)['message'])
                    : '';
                wait.reject(new Error(error || 'pi rpc abort rejected'));
            }
        }
        const event = parsePiRpcRecord(record);
        const state = record['data'] && typeof record['data'] === 'object'
            ? record['data'] as Record<string, unknown>
            : null;
        const stateName = state && typeof state['state'] === 'string' ? state['state'].toLowerCase() : '';
        const nonRunning = Boolean(state) && (state?.['running'] === false
            || state?.['isRunning'] === false
            || (stateName !== '' && !['running', 'active', 'generating'].includes(stateName)));
        if (event.sessionId) {
            session.sessionId = event.sessionId;
            notifyPiEvent(activePrompt?.onEvent, { kind: 'session', sessionId: event.sessionId });
        }
        if (event.tool && activePrompt?.turn) notifyPiEvent(activePrompt.onEvent, { kind: 'tool', ...event.tool });
        if (event.thinking && activePrompt?.turn) notifyPiEvent(activePrompt.onEvent, { kind: 'thinking', text: event.thinking });
        if (activePrompt?.turn && record['type'] === 'response' && record['command'] === 'prompt'
            && record['id'] === activePrompt.requestId && record['success'] === false) {
            const message = typeof record['error'] === 'string' ? record['error']
                : trimString((record['error'] as Record<string, unknown> | undefined)?.['message']);
            rejectOutstanding(new Error(message || 'pi rpc prompt rejected'));
            return;
        }
        const accepted = activePrompt?.turn?.observe(record);
        if (accepted?.text) notifyPiEvent(activePrompt?.onEvent, { kind: 'text', text: accepted.text });
        const abortNonRunning = Boolean(isAbortResponse) && nonRunning && !abortWait?.terminal;
        const terminal = accepted?.done || (capabilityReady && !activePrompt && record['type'] === (settledProtocol ? 'agent_settled' : 'agent_end'));
        if (terminal || abortNonRunning) {
            if (activePrompt?.turn) {
                const turn = activePrompt.turn;
                const prompt = activePrompt;
                activePrompt = null;
                const runtimeOutcome = turn.snapshot(abortNonRunning ? 'stopped' : undefined);
                const result = { text: runtimeOutcome.partialText, stderr: stderr.slice(prompt.stderrStart), runtimeOutcome };
                if (rpcExited) void owner.cleanup.then(() => prompt.resolve(result));
                else prompt.resolve(result);
            }
            if (abortWait) abortWait.terminal = true;
        }
        settleAbort();
    };
    const rejectOutstanding = (error: Error, status: 'stopped' | 'error' = child.killed ? 'stopped' : 'error'): void => {
        if (activePrompt) {
            const prompt = activePrompt;
            activePrompt = null;
            prompt.reject(new PiRuntimeError(error, prompt.turn?.snapshot(status)
                ?? { status, finalText: null, partialText: '' }));
        }
        if (abortWait) {
            const wait = abortWait;
            abortWait = null;
            clearTimeout(wait.timer);
            wait.reject(error);
        }
    };

    const claimOutstanding = (status: 'stopped' | 'error') => {
        const prompt = activePrompt, abort = abortWait;
        activePrompt = null; abortWait = null;
        if (abort) clearTimeout(abort.timer);
        const outcome = prompt?.turn?.snapshot(status) ?? { status, finalText: null, partialText: '' };
        return (error: Error) => {
            prompt?.reject(new PiRuntimeError(error, outcome));
            abort?.reject(error);
        };
    };

    const failSession = (error: Error, stopped = stopRequested || child.killed) => {
        if (failureClaim) return;
        failureClaim = { error, stopped };
        poisoned = true; closing = true; abortEffective = false;
        const publish = claimOutstanding(stopped ? 'stopped' : 'error');
        version?.cancel();
        void owner.teardown(true).then(() => publish(error));
    };
    const closeSession = (force: boolean): Promise<void> => {
        stopRequested = true; closing = true; abortEffective = false;
        const publish = closePromise ? null : claimOutstanding('stopped');
        version?.cancel();
        const cleanup = owner.teardown(force);
        closePromise ??= cleanup.then(receipt => {
            publish?.(new Error(receipt.rpc === 'closed'
                ? `pi rpc session exited with code ${String(child.exitCode)}` : 'pi rpc session cleanup unconfirmed'));
            if (receipt.cwdDisposition === 'retain') throw new Error('pi execution cleanup unconfirmed');
        });
        void closePromise.catch(() => { console.warn('[jaw:pi] execution cleanup unconfirmed'); });
        return closePromise;
    };

    const session: PiRpcSession = {
        child,
        get alive() { return !closed && !closing && !poisoned && child.exitCode == null && !child.killed; },
        get abortEffective() { return capabilityReady && !closing && !poisoned && abortEffective; },
        sessionId: options.sessionId || null,
        sendPrompt(message, opts = {}) {
            if (activePrompt) return Promise.reject(new Error('pi rpc prompt already active'));
            if (!session.alive) return Promise.reject(new Error('pi rpc session is not alive'));
            return new Promise((resolve, reject) => {
                // Reset per prompt. The accumulator is only ever read as
                // stderr.slice(stderrStart), so dropping already-consumed bytes
                // keeps that slice exact while bounding retention to one prompt.
                // A head-only cap without this reset would freeze stderr.length
                // and make every later slice() return ''.
                stderr = '';
                const effort = opts.effort;
                const pending: PersistentPrompt = { turn: null, requestId: 0, stderrStart: stderr.length,
                    onEvent: opts.onEvent, onRawRecord: opts.onRawRecord, resolve, reject };
                activePrompt = pending;
                void prepared.then(() => {
                    if (activePrompt !== pending || !session.alive) return;
                    pending.turn = new PiTurnAccumulator(settledProtocol);
                    try {
                        if (effort) write('set_thinking_level', { level: effort });
                        pending.requestId = write('prompt', { message });
                    } catch (error) { failSession(error as Error); }
                }, () => { /* failed readiness settles through the cleanup owner */ });
            });
        },
        abort() {
            if (!activePrompt) return Promise.resolve();
            if (!activePrompt.turn) {
                const pending = activePrompt; activePrompt = null;
                pending.resolve({ text: '', stderr: '', runtimeOutcome: { status: 'stopped', finalText: null, partialText: '' } });
                return Promise.resolve();
            }
            if (abortWait) return Promise.reject(new Error('pi rpc abort already active'));
            return new Promise((resolve, reject) => {
                let id: number;
                try { id = write('abort'); }
                catch (error) { reject(error as Error); return; }
                const timer = setTimeout(() => {
                    if (!abortWait || abortWait.id !== id) return;
                    abortWait = null;
                    reject(new Error('pi rpc abort timed out'));
                }, PI_RPC_ABORT_TIMEOUT_MS);
                abortWait = { id, onRawRecord: activePrompt?.onRawRecord, accepted: false, terminal: false, resolve, reject, timer };
            });
        },
        close: () => closeSession(false),
        kill() { void closeSession(true).catch(() => {}); },
    };

    const stdoutLines = readPiRpcLines(child, dispatchLine, () => {
        // The turn's terminal record may be the one dropped, and the stream position
        // is no longer trustworthy for a reused process: fail the prompt and the session.
        if (!activePrompt?.turn) return;
        activePrompt.turn.markFrameLost();
        failSession(new Error('pi rpc stdout frame dropped'));
    });
    child.stderr?.on('data', (chunk) => {
        // Persistent RPC sessions live for the pool's idle window (15 min) and
        // longer under load, so an uncapped accumulator grows for the whole
        // session lifetime. Every sibling handler in this file caps at 4000.
        // Its own reader, never the shared stdout decoder (#382, rule 1).
        if (stderr.length < PI_RPC_STDERR_MAX_CHARS) stderr += stderrReader.write(chunk);
    });
    child.on('error', (error) => failSession(error));
    child.stdin?.on('error', error => failSession(error));
    child.stdout?.on('error', error => failSession(error));
    child.stderr?.on('error', error => failSession(error));
    child.once('exit', (code, signal) => {
        rpcExited = true; abortEffective = false;
        version?.cancel();
        void owner.teardown().then(() => {
            failSession(new Error(`pi rpc session exited with code ${String(code)}`), Boolean(signal) || child.killed);
        });
    });
    child.on('close', (code) => {
        closed = true;
        // dispatchLine itself refuses an unconfirmed child, so the tail needs no
        // second receipt check here. failSession must stay AFTER the flush: it
        // poisons the session, and dispatchLine drops anything once poisoned.
        stdoutLines.flush();
        failSession(new Error(`pi rpc session exited with code ${String(code)}`));
    });
    version = startVersionProbe();
    prepared = version.done.then(observation => {
        if (!session.alive) throw new Error('pi rpc session closed during preparation');
        settledProtocol = observation.status === 0 && piSupportsSettled(observation.stdout);
        abortEffective = observation.status === 0 && loadPiAbortEffective(profileId, resolvePiCommandIdentity(cmd, observation));
        capabilityReady = true;
        write('get_state');
        if (initialEffort) write('set_thinking_level', { level: initialEffort });
    }).catch(error => { failSession(error as Error); throw error; });
    void prepared.catch(() => {});
    owner.seal();
    return session;
}

export type OpenPiRpcOptions = {
    model: string;
    effort?: string;
    cwd: string;
    sessionId?: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
    onEvent?: (event: PiRuntimeEvent) => void;
    onRawRecord?: (record: unknown) => void;
};

export type PiOneshotResult = PiPromptResult & { code: number; sessionId?: string | null };

export interface PiOneshotRpc {
    readonly child: ChildProcess;
    readonly alive: boolean;
    readonly abortEffective: boolean;
    sessionId: string | null;
    readonly prepared: Promise<void>;
    readonly cleanup: Promise<PiExecutionCleanupReceipt>;
    sendPrompt(message: string, opts?: {
        effort?: string;
        onEvent?: (event: PiRuntimeEvent) => void;
        onRawRecord?: (record: unknown) => void;
    }): Promise<PiOneshotResult>;
    abort(): Promise<void>;
    close(): Promise<void> | void;
    kill(): void;
}

export function sendPiRpcPrompt(
    opened: PiOneshotRpc,
    message: string,
    opts?: { effort?: string; onEvent?: (event: PiRuntimeEvent) => void; onRawRecord?: (record: unknown) => void },
): Promise<PiOneshotResult> {
    return opened.sendPrompt(message, opts);
}

/** Version probe + RPC up, no prompt write. Employee and the spawnPiRpc wrapper share this. */
export function openPiRpc(profile: PiProfile, pi: PiSettings, options: OpenPiRpcOptions): PiOneshotRpc {
    const effort = options.effort;
    let onEvent = options.onEvent, onRawRecord = options.onRawRecord;
    const { cmd, child, owner, startVersionProbe } = launchPiRpcExecution(profile, pi, options);
    let stderr = '';
    const stderrReader = createTextStreamReader();
    let sessionId: string | null = options.sessionId || null;
    let doneSettled = false, promptDispatched = false, promptStarted = false;
    let abortEffective = false;
    let turn: PiTurnAccumulator | null = null;
    let version: ReturnType<typeof startPiVersionProbe> | undefined;
    let promptId = 0;
    let finish!: (code?: number, status?: RuntimeTurnOutcome['status'], error?: Error) => void;
    let resolvePrepared!: () => void;
    let rejectPrepared!: (error: Error) => void;
    const prepared = new Promise<void>((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
    const done = new Promise<PiOneshotResult>((resolve, reject) => {
        finish = (code = 0, status?: RuntimeTurnOutcome['status'], error?: Error) => {
            if (doneSettled) return;
            doneSettled = true;
            const runtimeOutcome = turn?.snapshot(status) ?? { status: status ?? 'error', finalText: null, partialText: '' };
            const selected = { text: runtimeOutcome.partialText, code, sessionId, stderr, runtimeOutcome };
            version?.cancel();
            void owner.teardown(status === 'error' || status === 'stopped').then(() => {
                if (error) reject(new PiRuntimeError(error, runtimeOutcome)); else resolve(selected);
            });
        };
        let parseFailures = 0;
        const dispatchLine = (line: string) => {
            if (doneSettled || owner.receipt?.rpc === 'unconfirmed') return;
            let parsed: unknown;
            try { parsed = JSON.parse(line); }
            catch {
                parseFailures++;
                console.warn(`[jaw:pi] JSON parse failed (${parseFailures}; ${line.length} chars; payload omitted)`);
                return;
            }
            if (!promptDispatched || !turn) return;
            notifyPiRawRecord(onRawRecord, parsed);
            const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
            if (record['type'] === 'response' && record['command'] === 'prompt'
                && record['id'] === promptId && record['success'] === false) {
                finish(1, 'error');
                return;
            }
            const event = parsePiRpcRecord(parsed);
            if (event.sessionId) {
                sessionId = event.sessionId;
                notifyPiEvent(onEvent, { kind: 'session', sessionId });
            }
            if (event.tool) notifyPiEvent(onEvent, { kind: 'tool', ...event.tool });
            if (event.thinking) notifyPiEvent(onEvent, { kind: 'thinking', text: event.thinking });
            const accepted = turn.observe(parsed);
            if (accepted.text) notifyPiEvent(onEvent, { kind: 'text', text: accepted.text });
            if (accepted.done) finish(0);
        };
        child.on('error', error => finish(1, 'error', error));
        child.stdin?.on('error', error => finish(1, child.killed ? 'stopped' : 'error', error));
        child.stdout?.on('error', error => finish(1, 'error', error));
        child.stderr?.on('error', error => finish(1, 'error', error));
        child.once('exit', (code, signal) => {
            version?.cancel();
            void owner.teardown().then(() => finish(code ?? 1, signal || child.killed ? 'stopped' : 'error'));
        });
        const stdoutLines = readPiRpcLines(child, dispatchLine, () => {
            if (!promptDispatched || !turn) return;
            // Settles now, like a terminal record would; the lost frame makes it an error.
            turn.markFrameLost();
            finish(0);
        });
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < PI_RPC_STDERR_MAX_CHARS) stderr += stderrReader.write(chunk);
        });
        child.on('close', (code, signal) => {
            stdoutLines.flush();
            finish(code ?? 1, signal || child.killed ? 'stopped' : 'error');
        });
    });
    const write = createPiFrameWriter(child, () => !doneSettled && child.exitCode === null
        && child.signalCode === null && !child.killed && Boolean(child.stdin?.writable),
        'pi rpc execution is not writable');
    const originalKill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
        const stopSignal = signal === undefined || signal === 15 ? 'SIGTERM'
            : signal === 9 ? 'SIGKILL' : signal === 2 ? 'SIGINT' : signal;
        if (stopSignal !== 'SIGTERM' && stopSignal !== 'SIGKILL' && stopSignal !== 'SIGINT') return originalKill(signal);
        const sent = owner.killRpc(stopSignal);
        if (!doneSettled) finish(1, 'stopped');
        else owner.teardown(true);
        return sent;
    };
    bindPiExecutionCancel(child, () => { child.kill('SIGTERM'); });
    version = startVersionProbe();
    void version.done.then(observation => {
        if (doneSettled) { rejectPrepared(new Error('pi rpc execution settled before prepare')); return; }
        if (child.killed || child.exitCode !== null || child.signalCode !== null) {
            finish(1, child.killed ? 'stopped' : 'error');
            rejectPrepared(new Error('pi rpc execution closed during preparation'));
            return;
        }
        turn = new PiTurnAccumulator(observation.status === 0 && piSupportsSettled(observation.stdout));
        abortEffective = observation.status === 0 && loadPiAbortEffective(profile.id, resolvePiCommandIdentity(cmd, observation));
        write('get_state');
        if (effort) write('set_thinking_level', { level: effort });
        resolvePrepared();
    }).catch(error => {
        finish(1, child.killed ? 'stopped' : 'error', error as Error);
        rejectPrepared(error as Error);
    });
    owner.seal();
    const session: PiOneshotRpc = {
        child,
        get alive() { return !doneSettled && child.exitCode == null && !child.killed; },
        get abortEffective() { return abortEffective && !doneSettled; },
        get sessionId() { return sessionId; },
        set sessionId(value) { sessionId = value; },
        prepared,
        cleanup: owner.cleanup,
        sendPrompt(message, opts = {}) {
            if (promptStarted) return Promise.reject(new Error('pi rpc prompt already active'));
            promptStarted = true;
            if (opts.onEvent) onEvent = opts.onEvent;
            if (opts.onRawRecord) onRawRecord = opts.onRawRecord;
            const sendEffort = opts.effort ?? effort;
            void prepared.then(() => {
                if (doneSettled) return;
                if (child.killed || child.exitCode !== null || child.signalCode !== null) {
                    finish(1, child.killed ? 'stopped' : 'error');
                    return;
                }
                if (sendEffort && sendEffort !== effort) write('set_thinking_level', { level: sendEffort });
                console.log(`[jaw:pi] prompt len=${message.length}, hasHistory=${message.includes('[Recent Context]')}, effort=${sendEffort || 'none'}, sessionId=${sessionId || 'new'}`);
                promptId = write('prompt', { message });
                promptDispatched = true;
            }).catch(error => finish(1, child.killed ? 'stopped' : 'error', error as Error));
            return done;
        },
        async abort() {
            if (doneSettled) return;
            if (!promptDispatched) {
                finish(0, 'stopped');
                return;
            }
            if (!abortEffective) return;
            try { write('abort'); } catch { /* kill follows on oneshot cancel */ }
        },
        close() { session.kill(); return owner.cleanup.then(() => undefined); },
        kill() { child.kill('SIGTERM'); },
    };
    return session;
}

export function spawnPiRpc(profile: PiProfile, pi: PiSettings, options: {
    prompt: string;
    model: string;
    effort?: string;
    cwd: string;
    sysPrompt?: string;
    sessionId?: string;
    onEvent?: (event: PiRuntimeEvent) => void;
    onRawRecord?: (record: unknown) => void;
    root?: string;
    env?: NodeJS.ProcessEnv;
}): { child: ChildProcess; done: Promise<PiOneshotResult>;
    cleanup: Promise<PiExecutionCleanupReceipt> } {
    const opened = openPiRpc(profile, pi, {
        model: options.model,
        cwd: options.cwd,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.root ? { root: options.root } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.onRawRecord ? { onRawRecord: options.onRawRecord } : {}),
    });
    const fullPrompt = options.sysPrompt ? `${options.sysPrompt}\n\n${options.prompt}` : options.prompt;
    const done = sendPiRpcPrompt(opened, fullPrompt, {
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.onRawRecord ? { onRawRecord: options.onRawRecord } : {}),
    });
    return { child: opened.child, done, cleanup: opened.cleanup };
}
