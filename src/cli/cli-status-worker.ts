import { fork, spawn } from 'node:child_process';
import { resolveWindowsLaunchSpec, launchArgv } from '../core/windows-launch-spec.js';
import { decideShellFallback } from '../core/windows-shell-fallback.js';
import { detectCliBinary } from '../core/cli-detect.js';
import { mergeEnvWindowsSafe } from '../agent/spawn-env.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extname } from 'node:path';
import { detectAllCli } from '../core/cli-detection.js';
import { readClaudeCreds, readCodexTokens } from '../routes/quota.js';
import { hasCopilotAuthSync } from '../../lib/quota-copilot.js';
import { killProcessTree, killProcessTreeIfAlive } from '../agent/spawn/process-kill.js';
import { probeCodexAppCapabilityAsync } from './capability-probe.js';
import type { CliStatusRow, CliStatusSnapshot } from './cli-status.js';
import { CLI_KEYS } from './registry.js';

const WORKER_OUTER_TIMEOUT_MS = 60_000;
const WORKER_KILL_GRACE_MS = 250;
const CHILD_MARKER = '--cli-status-worker-child';
const OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface CliStatusWorkerOptions {
    timeoutMs?: number;
    workerPath?: string;
    env?: NodeJS.ProcessEnv;
}

type AuthResult = { authenticated: boolean | null; source: string };
type CapabilityResult = { ready: boolean; reason?: string };

function defaultWorkerPath(): string {
    const extension = extname(fileURLToPath(import.meta.url));
    return fileURLToPath(new URL(`./cli-status-worker${extension}`, import.meta.url));
}

function workerExecArgv(): string[] {
    const args: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const arg = process.execArgv[index];
        if (arg === '--eval' || arg === '-e' || arg === '--print' || arg === '-p') {
            index += 1;
            continue;
        }
        if (arg === '--input-type' || arg?.startsWith('--input-type=')) {
            if (arg === '--input-type') index += 1;
            continue;
        }
        if (arg) args.push(arg);
    }
    return args;
}

function terminateWorker(child: ReturnType<typeof fork>): void {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group may not exist */ }
    }
    killProcessTree(child.pid, 'SIGTERM');
    const escalation = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        killProcessTreeIfAlive(child, child.pid);
    }, WORKER_KILL_GRACE_MS);
    escalation.unref();
}

function isSnapshot(value: unknown): value is CliStatusSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const snapshot = value as Record<string, unknown>;
    return CLI_KEYS.every((cli) => {
        const row = snapshot[cli];
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
        const record = row as Record<string, unknown>;
        return (typeof record['available'] === 'boolean' || record['available'] === null)
            && (typeof record['binaryInstalled'] === 'boolean' || record['binaryInstalled'] === null)
            && (typeof record['capabilityReady'] === 'boolean' || record['capabilityReady'] === null)
            && (typeof record['authenticated'] === 'boolean' || record['authenticated'] === null)
            && (typeof record['path'] === 'string' || record['path'] === null)
            && typeof record['source'] === 'string'
            && typeof record['checkedCapability'] === 'string'
            && ['checking', 'fresh', 'stale', 'unknown'].includes(String(record['probeState']));
    });
}

export function runCliStatusWorker(options: CliStatusWorkerOptions = {}): Promise<CliStatusSnapshot> {
    const workerPath = options.workerPath ?? defaultWorkerPath();
    const child = fork(workerPath, options.workerPath ? [] : [CHILD_MARKER], {
        detached: process.platform !== 'win32',
        env: options.env ?? process.env,
        execArgv: workerExecArgv(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, snapshot?: CliStatusSnapshot): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            child.removeAllListeners();
            if (error) reject(error);
            else resolve(snapshot!);
        };
        const timeout = setTimeout(() => {
            terminateWorker(child);
            finish(new Error(`CLI status worker exceeded ${options.timeoutMs ?? WORKER_OUTER_TIMEOUT_MS}ms`));
        }, options.timeoutMs ?? WORKER_OUTER_TIMEOUT_MS);
        timeout.unref();

        child.once('error', (error) => finish(error));
        child.once('exit', (code, signal) => {
            if (!settled) finish(new Error(`CLI status worker exited before result (${code ?? signal ?? 'unknown'})`));
        });
        child.once('message', (message: unknown) => {
            const payload = message as { ok?: unknown; snapshot?: unknown; error?: unknown; stage?: unknown; cli?: unknown };
            if (payload?.ok === true && isSnapshot(payload.snapshot)) {
                finish(null, payload.snapshot);
                return;
            }
            finish(new Error(formatWorkerFailure(payload)));
        });
    });
}

/**
 * Render a worker failure, keeping the stage the child tagged.
 *
 * #277: without it the parent's message reads identically whether detection,
 * the auth read, or the capability probe failed — which is why the Windows
 * report could never be narrowed past "it never converges". An untagged
 * failure keeps its original shape rather than growing empty brackets.
 */
function formatWorkerFailure(payload: { error?: unknown; stage?: unknown; cli?: unknown } | null | undefined): string {
    const base = typeof payload?.error === 'string' ? payload.error : 'Invalid CLI status worker response';
    const where = [
        typeof payload?.stage === 'string' ? payload.stage : null,
        typeof payload?.cli === 'string' ? payload.cli : null,
    ].filter(Boolean).join(' ');
    return where ? `[${where}] ${base}` : base;
}

/** Test seam: the stage tagger and the failure renderer, exercised directly. */
export const inStageForTest = inStage;
export const formatWorkerFailureForTest = formatWorkerFailure;

export function runCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean; outputLimited: boolean }> {
    return new Promise((resolve) => {
        // Shell-free launch on Windows (#367): resolve an npm .cmd shim to its
        // interpreter rather than handing the command to cmd.exe. Falls back to the
        // legacy shell only when resolution fails, matching the staged contract.
        //
        // `which` matters here: a bare command name resolves to null without it, so the
        // worker would take the shell for a CLI that PATHEXT could have found. Passing
        // it strictly reduces shell usage.
        const spec = process.platform === 'win32'
            ? resolveWindowsLaunchSpec(binary, args, { which: (n) => detectCliBinary(n).path || null })
            : null;
        const wantsShell = process.platform === 'win32' && !spec && !binary.toLowerCase().endsWith('.exe');
        // These argv are version/status flags rather than prompts, so the gate should not
        // fire. It is wired because the gate also refuses anything that could split one
        // command into two, and that property must not depend on today's argv.
        if (wantsShell) {
            const decision = decideShellFallback({ argv: args, command: binary });
            if (!decision.allowed) throw new Error(decision.reason);
        }
        const child = spawn(spec ? spec.command : binary, spec ? launchArgv(spec) : args, {
            detached: process.platform !== 'win32',
            shell: wantsShell,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(spec && Object.keys(spec.envDelta).length ? { env: mergeEnvWindowsSafe(process.env, spec.envDelta) } : {}),
        });
        let output = '';
        let bytes = 0;
        let timedOut = false;
        let outputLimited = false;
        let settled = false;

        const finish = (code: number | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const result = { code, output, timedOut, outputLimited };
            if (cleanupDone) void cleanupDone.then(() => resolve(result));
            else resolve(result);
        };
        // Both abort paths face the same process: one that may ignore SIGTERM
        // and may have left a descendant holding the pipe. Terminating only on
        // the timeout path would let a chatty command survive by exceeding the
        // output cap instead of the clock, so they share one escalation.
        //
        // The tree walk alone is not enough. If the direct child obeys SIGTERM
        // and only a grandchild ignores it, the escalation would find the child
        // already gone and return, leaving an orphan that no PID-parent scan
        // can reach any more. On POSIX the child is detached and therefore
        // leads its own process group, so signalling the negated PID covers
        // every descendant regardless of what the direct child did.
        //
        // The escalation must not be unref'd. This runs inside a short-lived
        // worker that exits as soon as the last probe settles, and an unref'd
        // timer simply never fires there: the direct child's pipe closes, the
        // event loop empties, and the process leaves before the grace period is
        // up. Holding a real ref and resolving only after cleanup keeps the
        // worker alive exactly long enough to finish killing what it started.
        let aborted = false;
        let cleanupDone: Promise<void> | null = null;
        const signalGroup = (signal: NodeJS.Signals): void => {
            if (process.platform === 'win32' || !child.pid) return;
            try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
        };
        const abortChild = (): void => {
            if (aborted || !child.pid) return;
            aborted = true;
            killProcessTree(child.pid, 'SIGTERM');
            signalGroup('SIGTERM');
            cleanupDone = new Promise<void>((done) => {
                setTimeout(() => {
                    killProcessTreeIfAlive(child, child.pid);
                    signalGroup('SIGKILL');
                    done();
                }, WORKER_KILL_GRACE_MS);
            });
        };
        const onData = (chunk: Buffer): void => {
            if (settled || outputLimited) return;
            bytes += chunk.byteLength;
            if (bytes > OUTPUT_LIMIT_BYTES) {
                outputLimited = true;
                abortChild();
                finish(null);
                return;
            }
            output += chunk.toString('utf8');
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.once('error', () => finish(null));
        child.once('exit', (code) => finish(code));
        const timer = setTimeout(() => {
            timedOut = true;
            abortChild();
            finish(null);
        }, timeoutMs);
        timer.unref();
    });
}

async function probeCodexApp(binary: string): Promise<CapabilityResult> {
    const result = await probeCodexAppCapabilityAsync(binary);
    return result.ok ? { ready: true } : { ready: false, reason: `app-server ${result.reason}` };
}

async function authForCli(cli: string, path: string | null, _detected: Record<string, { available?: boolean }>): Promise<AuthResult> {
    switch (cli) {
        case 'aside': return { authenticated: null, source: 'selected account authentication is unverified' };
        case 'agy': return { authenticated: true, source: 'installed; auth checked by agy at run time' };
        case 'pi': return { authenticated: true, source: 'profile auth validated at registration' };
        case 'claude': {
            const creds = readClaudeCreds();
            return { authenticated: Boolean(creds?.token) || creds?.source === 'cloud-provider-env', source: creds?.source ?? 'none' };
        }
        case 'codex':
        case 'codex-app': {
            const authenticated = Boolean(readCodexTokens()?.access_token);
            return { authenticated, source: authenticated ? 'auth.json' : 'none' };
        }
        case 'cursor': {
            if (process.env['CURSOR_API_KEY']) return { authenticated: true, source: 'CURSOR_API_KEY' };
            const result = await runCommand(path || 'cursor-agent', ['status'], 5_000);
            const authenticated = result.code === 0 && /logged in|authenticated/i.test(result.output);
            return { authenticated, source: authenticated ? 'cursor-agent status' : 'none' };
        }
        case 'kiro-code': {
            const result = await runCommand(path || 'kiro-cli', ['whoami'], 5_000);
            const authenticated = result.code === 0 && /logged in|email:/i.test(result.output);
            return { authenticated, source: authenticated ? 'kiro-cli whoami' : 'none' };
        }
        case 'grok': {
            const result = await runCommand(path || 'grok', ['models'], 5_000);
            const authenticated = result.code === 0 && /grok-build|Available models/.test(result.output);
            return { authenticated, source: authenticated ? 'grok models' : 'none' };
        }
        case 'copilot': {
            const authenticated = hasCopilotAuthSync();
            return { authenticated, source: authenticated ? 'local-auth-chain' : 'none' };
        }
        case 'opencode': return { authenticated: true, source: 'installed' };
        default: return { authenticated: false, source: 'none' };
    }
}

/**
 * Tag a thrown error with the stage that produced it.
 *
 * #277: on Windows every runtime reported `checking` then `stale` forever while
 * the runtime demonstrably worked, and the worker's single error string could
 * not say whether detection, the auth read, or the capability probe was the one
 * failing. Diagnosing it required guessing. The tag survives the IPC hop.
 */
async function inStage<T>(stage: string, cli: string | null, run: () => Promise<T> | T): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const tagged = error instanceof Error ? error : new Error(String(error));
        const staged = tagged as Error & { cliStatusStage?: string; cli?: string };
        // First writer wins: the innermost stage is the specific one.
        staged.cliStatusStage ??= stage;
        if (cli) staged.cli ??= cli;
        throw staged;
    }
}

export interface CliStatusCollectionDeps {
    detectAll?: () => Record<string, { available?: boolean; path?: string | null; scanError?: string }>;
}

export async function collectCliStatus(deps: CliStatusCollectionDeps = {}): Promise<CliStatusSnapshot> {
    const detected = await inStage('detect', null, () =>
        (deps.detectAll ?? detectAllCli)());
    const rows = await Promise.all(Object.entries(detected).map(async ([cli, info]) => {
        const binaryInstalled = Boolean(info.available);
        const path = typeof info.path === 'string' ? info.path : null;
        const checkedCapability = cli === 'codex-app' && binaryInstalled && path
            ? 'app-server-probe'
            : 'spawn-probe';
        if (info.scanError) {
            const row: CliStatusRow = {
                available: null,
                binaryInstalled: null,
                capabilityReady: null,
                authenticated: null,
                path,
                source: 'probe-unavailable',
                checkedCapability,
                probeState: 'unknown',
                probeError: info.scanError,
            };
            return [cli, row] as const;
        }
        let capability: CapabilityResult = { ready: binaryInstalled };
        if (cli === 'codex-app' && binaryInstalled && path) {
            capability = await inStage('capability', cli, () => probeCodexApp(path));
        }
        const auth = binaryInstalled || cli === 'aside'
            ? await inStage('auth', cli, () => authForCli(cli, path, detected))
            : { authenticated: false, source: 'none' };
        const row: CliStatusRow = {
            available: binaryInstalled && capability.ready,
            binaryInstalled,
            capabilityReady: capability.ready,
            authenticated: auth.authenticated,
            path,
            source: auth.source,
            checkedCapability,
            probeState: 'fresh',
            ...(capability.reason ? { reason: capability.reason } : {}),
        };
        return [cli, row] as const;
    }));
    return Object.fromEntries(rows);
}

async function runChild(): Promise<void> {
    try {
        process.send?.({ ok: true, snapshot: await collectCliStatus() });
    } catch (error) {
        // #277: every failure in here used to arrive as one bare string, so a
        // Windows probe that never converged could not be located — detection,
        // auth read, and capability probe all looked identical from outside.
        // `stage` is set by collectCliStatus() as it moves; an error that
        // carries one names where it died.
        const staged = error as Error & { cliStatusStage?: string; cli?: string };
        process.send?.({
            ok: false,
            error: staged instanceof Error ? staged.message : String(error),
            ...(staged?.cliStatusStage ? { stage: staged.cliStatusStage } : {}),
            ...(staged?.cli ? { cli: staged.cli } : {}),
        });
    } finally {
        process.disconnect?.();
    }
}

if (process.argv.includes(CHILD_MARKER)) void runChild();

/** Fixture helper for tests that need a standalone worker URL. */
export function cliStatusWorkerUrl(): URL {
    return pathToFileURL(defaultWorkerPath());
}
