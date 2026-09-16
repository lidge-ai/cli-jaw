/**
 * Isolated product-server harness for integration crossings.
 *
 * The CI integration job owns one server on TEST_PORT, but that process runs
 * with the runner's real home and an empty messaging.enabledChannels
 * (src/core/config.ts), so it can answer read-only API smoke calls and nothing
 * else. Any crossing that needs Slack running, a chosen agent runtime, or a
 * fake binary on PATH has to own its server. compact-api-managed.test.ts and
 * multi-instance.test.ts each hand-rolled that, and both skip when
 * node_modules/.bin/tsx is missing — a skip that is silent under CI.
 *
 * This harness fixes both halves: one spawn path, and a dependency check that
 * fails the run under CI instead of skipping (the api-smoke.test.ts rule).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveTsxSpawn } from '../../src/core/tsx-spawn.ts';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'bin', 'cli-jaw.ts');

export function findFreePort(): Promise<number> {
    return new Promise((ok, no) => {
        const probe = createServer();
        probe.once('error', no);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            if (address === null || typeof address === 'string') { probe.close(); no(new Error('no port')); return; }
            const port = address.port;
            probe.close(() => ok(port));
        });
    });
}

/**
 * tsx is a devDependency, so a checkout without node_modules cannot run this
 * family at all. Locally that is a skip; under CI it is a broken job, because
 * the integration job runs npm ci before the suite. Returning a sentinel and
 * letting each caller decide is what produced the green skips #689 is about.
 */
export function requireHarness(t: { skip(reason: string): void }): boolean {
    let usable = false;
    try {
        const spec = resolveTsxSpawn(PROJECT_ROOT, CLI_ENTRY, null);
        usable = spec.command !== 'tsx';
    } catch { usable = false; }
    if (usable) return true;
    if (process.env['CI']) {
        assert.fail('tsx entry not resolvable under CI — the integration job runs npm ci, so this is a broken job, not a missing local tool');
    }
    t.skip('tsx is not installed; run npm ci to exercise the isolated-server crossings');
    return false;
}

export type JawServer = {
    child: ChildProcess;
    port: number;
    home: string;
    base: string;
    /** Everything the child wrote, for failure messages. */
    output(): string;
};

export type StartOptions = {
    home: string;
    port: number;
    settings: Record<string, unknown>;
    env?: Record<string, string>;
};

/**
 * Schema bookkeeping a settings fixture cannot omit.
 *
 * A document with no settingsSchemaVersion is treated as pre-v4, and the v3
 * gateway migration REPLACES messaging.enabledChannels with the legacy scalar
 * channel — which defaults to telegram (src/core/config.ts). A fixture that
 * writes {messaging:{enabledChannels:['slack']}} and nothing else therefore
 * boots a Telegram install and the Slack transport never starts.
 *
 * Declaring v4 in turn obliges the document to carry a valid multiSession block
 * and the multiSessionDefaultMigration key (assertCurrentSchemaSessionShape),
 * AND a valid messaging gateway block (assertCurrentSchemaMessagingShape). Miss
 * any of them and loadSettings throws, latches persistence, and serves LEGACY
 * defaults instead — multiSession off, one lane — while the server still boots
 * and answers every request. That failure is invisible unless something looks
 * for it, which is what assertSettingsAccepted below is for.
 *
 * Keeping this in one place means a schema bump is one edit, not one per test.
 */
export function withSettingsSchema(settings: Record<string, unknown>): Record<string, unknown> {
    const multiSession = (settings['multiSession'] ?? {}) as Record<string, unknown>;
    const messaging = (settings['messaging'] ?? {}) as Record<string, unknown>;
    return {
        settingsSchemaVersion: 4,
        multiSessionDefaultMigration: null,
        nativeTransportMigration: { id: 'native-transport-default-v1', state: 'left-in-place' },
        maxConcurrentDefaultMigration: { id: 'max-concurrent-default-v1', state: 'left-in-place', from: 1 },
        ...settings,
        multiSession: { enabled: true, maxConcurrent: 4, ...multiSession },
        messaging: { enabledChannels: [], homeChannel: 'telegram', ...messaging },
    };
}

export function startJawServer(options: StartOptions): JawServer {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    writeFileSync(join(options.home, 'settings.json'), JSON.stringify(withSettingsSchema(options.settings), null, 2));
    const spec = resolveTsxSpawn(PROJECT_ROOT, CLI_ENTRY, null);
    const child = spawn(
        spec.command,
        [...spec.args, '--home', options.home, 'serve', '--port', String(options.port), '--no-open'],
        {
            cwd: PROJECT_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        },
    );
    // Captured, not discarded. graceful-shutdown collected stderr and threw it
    // away, which is exactly why a failed boot there reads as an environment
    // fact rather than a stack trace.
    let log = '';
    const keep = (chunk: Buffer) => { log += chunk.toString(); if (log.length > 64_000) log = log.slice(-64_000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    return {
        child,
        port: options.port,
        home: options.home,
        base: 'http://127.0.0.1:' + options.port,
        output: () => log,
    };
}

/**
 * 500ms, not a tight loop: the server rate-limits an unauthenticated loopback
 * caller by path class (src/core/rate-limit.ts), and a readiness probe that
 * trips that limiter reports "not ready" for a server that is perfectly fine.
 */
async function poll(server: JawServer, what: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (server.child.exitCode !== null) {
            throw new Error('server exited with ' + server.child.exitCode + ' while waiting for ' + what + '\n' + server.output());
        }
        try { if (await probe()) return; } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + what + '\n' + server.output());
}

export async function waitForServer(server: JawServer, timeoutMs = 45_000): Promise<void> {
    await poll(server, 'GET /api/session', async () => {
        const res = await fetch(server.base + '/api/session', { signal: AbortSignal.timeout(2000) });
        return res.ok;
    }, timeoutMs);
    assertSettingsAccepted(server);
}

/**
 * A rejected settings document does not stop the boot. loadSettings copies the
 * file to settings.json.corrupt-<ts>.bak, latches persistence and carries on
 * with legacy defaults, so a fixture that gets its schema wrong yields a server
 * that runs with settings nobody asked for — one lane instead of four, an
 * inbound channel that never starts — and every assertion downstream measures
 * the wrong thing. The backup file is the cheapest honest signal that happened.
 */
export function assertSettingsAccepted(server: JawServer): void {
    const rejected = readdirSync(server.home).filter(name => name.includes('settings.json.corrupt-'));
    if (rejected.length === 0) return;
    throw new Error(
        'the server rejected the fixture settings and fell back to defaults (' + rejected.join(', ') + ').\n'
        + 'A v4 document must carry multiSession, multiSessionDefaultMigration and messaging; see withSettingsSchema.\n'
        + server.output(),
    );
}

/**
 * /api/session answering 200 does NOT mean an inbound channel is live: routes
 * are registered before listen, and initEnabledMessagingRuntimes() runs inside
 * the listen callback (server.ts). Channel health is the observable that moves
 * when a transport actually starts (src/messaging/channel-health.ts).
 *
 * "running" still only means init returned started — a transport whose socket
 * has not reached connected is reported as running. Callers that inject inbound
 * traffic must also retry until the product acknowledges it.
 */
export async function waitForInboundChannel(server: JawServer, channel: string, timeoutMs = 45_000): Promise<void> {
    await poll(server, 'channel ' + channel + ' in /api/health activeInboundChannels', async () => {
        const res = await fetch(server.base + '/api/health', { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return false;
        const body = await res.json() as { channels?: { activeInboundChannels?: unknown } };
        const running = body.channels?.activeInboundChannels;
        return Array.isArray(running) && running.includes(channel);
    }, timeoutMs);
}

export async function stopJawServer(server: JawServer): Promise<void> {
    const child = server.child;
    if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
        await new Promise<void>(done => {
            const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); done(); }, 2500);
            child.once('exit', () => { clearTimeout(hard); done(); });
        });
    }
    rmSync(server.home, { recursive: true, force: true });
}

export async function api(server: JawServer, path: string, init?: RequestInit): Promise<Response> {
    return fetch(server.base + path, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(15_000),
    });
}
