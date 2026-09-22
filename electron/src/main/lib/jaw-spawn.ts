import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { killProcessTree } from './process-kill.js';
import { existsSync, statSync, readdirSync, accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RingBuffer } from './ring-buffer.js';
import { readIsolatedQaPolicy, isolatedQaEnvironment, type IsolatedQaPolicy } from '../../../../src/shared/isolated-qa.js';

function qaSidecarPaths(): { binary: string; node: string; cli: string } {
  try {
    const root = join(realpathSync(process.resourcesPath), 'server');
    if (realpathSync(root) !== root) throw new Error('noncanonical server');
    const paths = {
      binary: join(root, 'bin', process.platform === 'win32' ? 'jaw.cmd' : 'jaw'),
      node: join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
      cli: join(root, 'dist', 'bin', 'cli-jaw.js'),
    };
    for (const file of Object.values(paths)) {
      if (realpathSync(file) !== file || !statSync(file).isFile()) throw new Error('invalid artifact');
    }
    if (!isExecutable(paths.node) || !isExecutable(paths.binary)) throw new Error('not executable');
    return paths;
  } catch {
    throw new Error('[isolated-qa] packaged sidecar: missing or noncanonical artifact');
  }
}

// This is a launch-boundary assertion, not another environment parser. The
// captured policy prevents later ambient changes from reopening normal fallback.
function qaInvocation(binary: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const paths = qaSidecarPaths();
  if (binary !== paths.binary) throw new Error('[isolated-qa] binary: packaged shim required');
  return { command: paths.node, args: [paths.cli, ...args] };
}

let pathFixed = false;
async function ensureFixedPath(): Promise<void> {
  if (pathFixed) return;
  pathFixed = true;
  try {
    const mod = await import('fix-path');
    const fn = (mod as unknown as { default?: () => void }).default ?? (mod as unknown as () => void);
    if (typeof fn === 'function') fn();
  } catch {
    // fix-path is optional; ignore in dev
  }
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellScriptInvocation(binary: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  if (process.platform === 'win32' && binary.endsWith('.cmd')) {
    return { command: binary, args, shell: true };
  }
  if (process.platform !== 'win32') {
    try {
      const head = readFileSync(binary, 'utf8').slice(0, 80);
      if (head.startsWith('#!') && /\/(?:ba|z|k)?sh\b/.test(head.split(/\r?\n/, 1)[0] ?? '')) {
        return { command: '/bin/sh', args: [binary, ...args] };
      }
    } catch {
      // Fall through to direct execution; executability was checked separately.
    }
  }
  return { command: binary, args };
}

function whichJawCandidates(): string[] {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = process.platform === 'win32' ? ['jaw'] : ['-a', 'jaw'];
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // not found
  }
  return [];
}

function commandOutputFromError(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : String(err.stdout ?? '');
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr ?? '');
  const message = typeof err.message === 'string' ? err.message : '';
  return `${stdout}\n${stderr}\n${message}`;
}

export function hasDashboardCommand(binary: string, policy = readIsolatedQaPolicy(process.env, 'electron')): boolean {
  const qa = policy ? qaInvocation(binary, ['dashboard', '__jaw_electron_probe__']) : null;
  if (!isExecutable(binary)) return false;
  try {
    const invocation = qa ?? shellScriptInvocation(binary, ['dashboard', '__jaw_electron_probe__']);
    execFileSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
      ...(policy ? { env: isolatedQaEnvironment(policy, {
        ...process.env, CLI_JAW_ELECTRON_RENDERER_TOKEN: undefined,
      }), cwd: policy.home } : {}),
      ...(invocation.shell ? { shell: true } : {}),
    });
    return true;
  } catch (error) {
    // A timed-out/killed probe must not become support just because its partial
    // output happens to contain help text.
    if (policy) {
      const result = error as { status?: number | null; signal?: unknown; code?: unknown };
      if (result.status !== 1 || result.signal != null || result.code != null) return false;
    }
    const output = commandOutputFromError(error);
    return (
      output.includes('Unknown dashboard command: __jaw_electron_probe__') ||
      output.includes('Usage: jaw dashboard') ||
      output.includes('jaw dashboard serve')
    );
  }
}

function addCandidate(candidate: string, searched: string[], seen: Set<string>, label = candidate): string | null {
  if (seen.has(candidate)) return null;
  seen.add(candidate);
  if (!isExecutable(candidate)) {
    searched.push(`${label} (not executable)`);
    return null;
  }
  if (!hasDashboardCommand(candidate)) {
    searched.push(`${label} (no dashboard support)`);
    return null;
  }
  searched.push(label);
  return candidate;
}

function expandNvmCandidates(): string[] {
  const out: string[] = [];
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(nvmDir)) return out;
  try {
    for (const ver of readdirSync(nvmDir)) {
      out.push(join(nvmDir, ver, 'bin', 'jaw'));
    }
  } catch {
    // ignore
  }
  return out;
}

function buildCandidateList(): string[] {
  const cands: string[] = [];
  if (process.env.JAW_BIN) cands.push(process.env.JAW_BIN);
  cands.push('/opt/homebrew/bin/jaw');
  cands.push('/usr/local/bin/jaw');
  cands.push(...expandNvmCandidates());
  cands.push(join(homedir(), '.volta', 'bin', 'jaw'));
  cands.push(join(homedir(), '.fnm', 'aliases', 'default', 'bin', 'jaw'));
  cands.push(join(homedir(), '.fnm', 'current', 'bin', 'jaw'));
  return cands;
}

export interface FindResult {
  path: string | null;
  searched: string[];
}

export async function findJawBinary(policy = readIsolatedQaPolicy(process.env, 'electron')): Promise<FindResult> {
  if (policy) {
    const { app } = await import('electron');
    if (!app.isPackaged) throw new Error('[isolated-qa] Electron: packaged app required');
    const paths = qaSidecarPaths();
    return { path: hasDashboardCommand(paths.binary, policy) ? paths.binary : null,
      searched: ['bundled sidecar (isolated QA)'] };
  }
  await ensureFixedPath();
  const searched: string[] = [];
  const seen = new Set<string>();

  const electron = await import('electron');
  if (electron.app.isPackaged) {
    const sidecarBin = process.platform === 'win32'
      ? join(process.resourcesPath, 'server', 'bin', 'jaw.cmd')
      : join(process.resourcesPath, 'server', 'bin', 'jaw');
    const found = addCandidate(sidecarBin, searched, seen, 'bundled sidecar');
    if (found) return { path: found, searched };
  }

  if (process.env.JAW_BIN) {
    const found = addCandidate(process.env.JAW_BIN, searched, seen, `$JAW_BIN=${process.env.JAW_BIN}`);
    if (found) return { path: found, searched };
  }

  const whichCandidates = whichJawCandidates();
  if (whichCandidates.length === 0) searched.push('which -a jaw → (not found)');
  for (const c of whichCandidates) {
    const found = addCandidate(c, searched, seen, `which -a jaw → ${c}`);
    if (found) return { path: found, searched };
  }

  for (const c of buildCandidateList()) {
    const found = addCandidate(c, searched, seen);
    if (found) return { path: found, searched };
  }

  return { path: null, searched };
}

export interface SpawnOptions {
  port: number;
  ringBuffer: RingBuffer;
  env?: NodeJS.ProcessEnv;
  qaPolicy?: IsolatedQaPolicy | null;
}

export function spawnJawDashboard(
  binary: string,
  opts: SpawnOptions,
): ChildProcess {
  const policy = opts.qaPolicy === undefined ? readIsolatedQaPolicy(process.env, 'electron') : opts.qaPolicy;
  if (policy && opts.port !== policy.managerPort) throw new Error('[isolated-qa] port: must match manager port');
  const args = ['dashboard', 'serve', '--port', String(opts.port), '--no-open'];
  if (policy) args.push('--from', String(policy.workerPort), '--count', '1');
  const invocation = policy ? qaInvocation(binary, args) : shellScriptInvocation(binary, args);
  const env = policy ? isolatedQaEnvironment(policy, {
    ...(opts.env ?? process.env), CLI_JAW_ELECTRON_RENDERER_TOKEN: opts.env?.CLI_JAW_ELECTRON_RENDERER_TOKEN,
  }) : { ...process.env, ...(opts.env ?? {}) };
  // Only the explicit per-launch value from main is an admitted IPC capability;
  // never revive a similarly named ambient provider/session secret.
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    ...(policy ? { cwd: policy.home } : {}),
    // The dev `jaw` shim runs node without exec(), so the real dashboard server
    // is a grandchild. Own a process group here and tear the whole tree down in
    // gracefulShutdown, otherwise the server survives, keeps its port, and the
    // next launch walks to the next port and spawns a second full server.
    detached: process.platform !== 'win32',
    ...(invocation.shell ? { shell: true } : {}),
  });
  if (policy) captureQaLifetime(child, policy);
  child.stdout?.on('data', (d) => opts.ringBuffer.append(d));
  child.stderr?.on('data', (d) => opts.ringBuffer.append(d));
  return child;
}

interface QaLifetime {
  readonly root: string;
  shutdown(timeoutMs: number): Promise<void>;
}
const qaLifetimes = new WeakMap<ChildProcess, QaLifetime>();

function qaCleanupError(reason: string): Error {
  return new Error(`[isolated-qa] cleanup uncertain: ${reason}; retain task profile for supervisor verification`);
}

/** Capture at spawn, never reconstruct authority from a PID at shutdown time. */
function captureQaLifetime(child: ChildProcess, policy: IsolatedQaPolicy): void {
  const pid = child.pid;
  let retired = false;
  let exited = false;
  let complete = false;
  let failure: Error | null = null;
  let pending: Promise<void> | null = null;
  let changed = () => {};
  const uncertain = (reason: string) => {
    retired = true;
    failure ??= qaCleanupError(reason);
    changed();
  };
  child.once('exit', (code, signal) => {
    retired = true;
    // The direct Node CLI waits for its manager child and propagates its code.
    // Signal death of the CLI does not prove the manager child has terminated.
    if (signal || (code !== 0 && code !== 75)) uncertain('unproved CLI/manager exit');
    else exited = true;
    changed();
  });
  child.once('error', () => uncertain('child error'));
  child.once('close', () => {
    retired = true;
    if (!exited) uncertain('close without cooperative exit');
    else complete = true;
    changed();
  });
  if (!pid || child.exitCode !== null || child.signalCode !== null) uncertain('child was not live at admission');
  qaLifetimes.set(child, { root: policy.root, shutdown(timeoutMs) {
    if (pending) return pending;
    pending = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      changed = () => {
        if (done || (!failure && !complete)) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (failure) reject(failure); else resolve();
      };
      changed();
      if (done) return;
      timer = setTimeout(() => uncertain('completion deadline exceeded'), timeoutMs);
      // A recorded exit revokes signals even if fields later resemble a live,
      // reused PID. Wait only for close; expiry is failure, never group cleanup.
      if (retired) return;
      if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null) {
        uncertain('child lifetime changed without completion');
        return;
      }
      try {
        if (!child.kill('SIGTERM')) uncertain('child disappeared before signal');
      } catch {
        uncertain('signal failed');
      }
    });
    return pending;
  } });
}

/** Collect the full descendant PID list via `pgrep -P`, deepest last. */
function collectDescendants(pid: number): number[] {
  if (process.platform === 'win32') return [];
  const found: number[] = [];
  const walk = (parent: number): void => {
    let kids: number[] = [];
    try {
      const out = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8', timeout: 3000 });
      kids = out.trim().split('\n').filter(Boolean).map(Number).filter((n) => n > 0);
    } catch {
      // no children, or pgrep unavailable
    }
    for (const kid of kids) {
      found.push(kid);
      walk(kid);
    }
  };
  walk(pid);
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function gracefulShutdown(
  child: ChildProcess,
  timeoutMs = 5000,
  qaPolicy: IsolatedQaPolicy | null = null,
): Promise<void> {
  const lifetime = qaLifetimes.get(child);
  // A QA-admitted child cannot drop back into numeric cleanup even if a caller
  // omits policy or the ambient opt-in has subsequently disappeared.
  if (qaPolicy || lifetime) {
    if (!lifetime || (qaPolicy && lifetime.root !== qaPolicy.root)) throw qaCleanupError('unowned child');
    return lifetime.shutdown(timeoutMs);
  }
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;

  // D1: the dev `jaw` shim is /bin/sh and the real dashboard server is its
  // grandchild. Two things follow.
  //
  //   1. Snapshot descendants BEFORE signalling. Once the shim dies, `pgrep -P
  //      <shimPid>` returns nothing and a tree walk at SIGKILL time is blind —
  //      the orphan reparents to PID 1 and survives.
  //   2. The shim usually exits within milliseconds, so `child.once('exit')`
  //      alone would resolve while the server is still shutting down. Wait for
  //      the descendants too, and escalate to SIGKILL on the whole group.
  const descendants = collectDescendants(pid);

  const signalAll = (signal: NodeJS.Signals): void => {
    killProcessTree(pid, signal);
    if (process.platform === 'win32') return;
    // `detached: true` gives the shim its own process group, which catches
    // descendants that already reparented away from the pgrep tree.
    try {
      process.kill(-pid, signal);
    } catch {
      // group already gone
    }
    for (const dpid of descendants) {
      try {
        process.kill(dpid, signal);
      } catch {
        // already dead
      }
    }
  };

  const outstanding = (): boolean => isAlive(pid) || descendants.some(isAlive);

  return new Promise<void>((resolve) => {
    let done = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      // D5: the SIGKILL timer outlives a prompt exit otherwise, holding a dead
      // ChildProcess closure for `timeoutMs` on every restartManagerServer().
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      resolve();
    };

    child.once('exit', () => {
      // Only done once nothing from this tree is left running.
      if (!outstanding()) finish();
    });

    signalAll('SIGTERM');

    pollTimer = setInterval(() => {
      if (!outstanding()) finish();
    }, 100);
    pollTimer.unref?.();

    killTimer = setTimeout(() => {
      killTimer = null;
      if (done) return;
      signalAll('SIGKILL');
      finish();
    }, timeoutMs);
    killTimer.unref?.();
  });
}
