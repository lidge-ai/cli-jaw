/**
 * Real HTTP against real native Code routes over a real store.
 *
 * Routes are mounted ONCE. The service getter is a closure over a mutable
 * `let host` because registerNativeCodeRoutes does app.use(prefix, router)
 * per call and stacking routers would mix owners (src/routes/code-native.ts).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { createCodeHost } from '../../src/code-mode/host.ts';
import { createWorkerApiJsonParser } from '../../src/routes/code-body-parser.ts';
import { registerNativeCodeRoutes } from '../../src/routes/code-native.ts';
import { createFakeCodeProviders, FAKE_CODE_MODEL } from '../helpers/code-fake-providers.mts';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const CHILD_ENTRY = join(PROJECT_ROOT, 'tests/helpers/code-host-child.mts');

type Json = Record<string, unknown>;
type Host = ReturnType<typeof createCodeHost>;

const passThroughAuth: RequestHandler = (_req, _res, next) => next();

function sqlitePath(home: string, hostPort: number): string {
    return join(home, 'code-worker-' + hostPort + '.sqlite');
}

async function request(url: string, method = 'GET', body?: unknown, timeoutMs = 15_000): Promise<{ status: number; json: Json }> {
    const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, json: await response.json() as Json };
}

async function pollSnapshot(url: string, predicate: (body: Json) => boolean, timeoutMs = 8_000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    let last: Json | undefined;
    while (Date.now() < deadline) {
        const response = await request(url);
        assert.equal(response.status, 200);
        last = response.json;
        if (predicate(last)) return last;
        await delay(40);
    }
    throw new Error('timed out waiting for snapshot: ' + JSON.stringify(last));
}

async function waitForStreaming(url: string): Promise<Json> {
    return pollSnapshot(url, body => (body['session'] as Json | undefined)?.['status'] === 'streaming');
}

function createBody(cwd: string) {
    return {
        provider: 'codex-app' as const,
        cwd,
        model: FAKE_CODE_MODEL,
        effort: null,
        permissionMode: 'ask' as const,
    };
}

async function spawnChild(home: string, hostPort: number): Promise<{ child: ChildProcess; httpPort: number; output(): string; kill(): Promise<void> }> {
    // --import tsx, NOT the tsx CLI. The CLI runs the entry in a grandchild, and
    // killing the wrapper leaves that grandchild alive holding the write end of
    // these pipes: the reads never reach EOF, this process cannot exit, and the
    // driver reports it 180s later as a stalled file rather than a leaked child.
    // The loader form keeps everything in the process we actually kill.
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD_ENTRY, JSON.stringify({ home, hostPort })], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
    });
    let log = '';
    const keep = (chunk: Buffer) => {
        log += chunk.toString();
        if (log.length > 64_000) log = log.slice(-64_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const kill = async (): Promise<void> => {
        if (child.exitCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
    };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('code-host-child exited ' + String(child.exitCode) + '\n' + log);
        const line = log.split('\n').find(entry => entry.trim().startsWith('{'));
        if (line) {
            const parsed = JSON.parse(line) as { httpPort?: number };
            assert.equal(typeof parsed.httpPort, 'number');
            return { child, httpPort: parsed.httpPort as number, output: () => log, kill };
        }
        await delay(40);
    }
    await kill();
    throw new Error('timed out waiting for code-host-child httpPort\n' + log);
}

describe('code native HTTP', { concurrency: false }, () => {
    let host: Host | undefined;
    let server: Server;
    let base = '';
    const homes: string[] = [];

    before(async () => {
        const app = express();
        app.use(createWorkerApiJsonParser());
        registerNativeCodeRoutes(app, passThroughAuth, () => {
            if (!host) throw new Error('Code host is not assigned');
            return host.get();
        }, '/api/code');
        server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        base = 'http://127.0.0.1:' + String(address.port);
    });

    after(async () => {
        await new Promise<void>(done => {
            // Close live keep-alive sockets first; server.close() only stops new
            // connections and would otherwise wait on the open ones.
            server.closeAllConnections?.();
            server.close(() => done());
        });
        await host?.dispose().catch(() => undefined);
        for (const home of homes) rmSync(home, { recursive: true, force: true });
    });

    function tempHome(): string {
        const home = mkdtempSync(join(tmpdir(), 'code-native-api-'));
        homes.push(home);
        return home;
    }

    async function assignHost(home: string, hostPort: number, providers = createFakeCodeProviders().providers,
        primeLiveModels?: () => Promise<boolean | void>): Promise<Host> {
        const previous = host;
        host = createCodeHost({
            home,
            role: 'worker',
            port: hostPort,
            providers,
            idleReapMs: 3_600_000,
            ...(primeLiveModels ? { primeLiveModels } : {}),
        });
        await previous?.dispose().catch(() => undefined);
        return host;
    }

    let recovered: {
        sessionId: string;
        turnId: string;
        prompt: { text: string; clientTurnKey: string };
    } | undefined;

    test('CODE-INT-001 create', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        const hostPort = 19_088;
        const db = sqlitePath(home, hostPort);
        await assignHost(home, hostPort);
        assert.equal(existsSync(db), false);
        const created = await request(base + '/api/code/sessions', 'POST', createBody(cwd));
        assert.equal(created.status, 201);
        assert.equal((created.json['session'] as Json)['cwd'], cwd);
        assert.ok(existsSync(db));
    });

    test('CODE-INT-002 prompt + duplicate', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        await assignHost(home, 19_088);
        const created = await request(base + '/api/code/sessions', 'POST', createBody(cwd));
        const sessionId = (created.json['session'] as Json)['sessionId'] as string;
        const prompt = { text: 'hello world', clientTurnKey: 'k1' };
        const first = await request(base + '/api/code/sessions/' + sessionId + '/prompt', 'POST', prompt);
        assert.equal(first.status, 202);
        assert.equal(first.json['status'], 'accepted');
        const second = await request(base + '/api/code/sessions/' + sessionId + '/prompt', 'POST', prompt);
        assert.equal(second.status, 200);
        assert.equal(second.json['turnId'], first.json['turnId']);
    });

    test('CODE-INT-003 snapshot', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        await assignHost(home, 19_088);
        const created = await request(base + '/api/code/sessions', 'POST', createBody(cwd));
        const sessionId = (created.json['session'] as Json)['sessionId'] as string;
        const prompt = { text: 'persist this user message', clientTurnKey: 'k-snapshot' };
        const admitted = await request(base + '/api/code/sessions/' + sessionId + '/prompt', 'POST', prompt);
        assert.equal(admitted.status, 202);
        const early = await request(base + '/api/code/sessions/' + sessionId);
        const earlyItems = early.json['items'] as Array<Json>;
        assert.ok(earlyItems.some(item => item['kind'] === 'user_message' && item['text'] === prompt.text));
        const snapshot = await pollSnapshot(base + '/api/code/sessions/' + sessionId, body => {
            const items = body['items'] as Array<Json>;
            return items.some(item => item['kind'] === 'assistant_message');
        });
        const items = snapshot['items'] as Array<Json>;
        assert.ok(items.some(item => item['kind'] === 'user_message' && item['text'] === prompt.text));
        assert.ok(items.some(item => item['kind'] === 'assistant_message'));
    });

    test('CODE-INT-004 cancel', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        await assignHost(home, 19_088);
        const created = await request(base + '/api/code/sessions', 'POST', createBody(cwd));
        const sessionId = (created.json['session'] as Json)['sessionId'] as string;
        const admitted = await request(base + '/api/code/sessions/' + sessionId + '/prompt', 'POST', {
            text: 'please HOLD this turn', clientTurnKey: 'k-hold',
        });
        assert.equal(admitted.status, 202);
        const live = await waitForStreaming(base + '/api/code/sessions/' + sessionId);
        const started = Date.now();
        const cancelled = await request(base + '/api/code/sessions/' + sessionId + '/cancel', 'POST', {
            turnId: admitted.json['turnId'],
            epoch: (live['session'] as Json)['epoch'],
        }, 2_000);
        assert.ok(Date.now() - started < 2_000);
        assert.equal(cancelled.status, 200);
        assert.equal(cancelled.json['ok'], true);
        const after = await request(base + '/api/code/sessions/' + sessionId);
        // Cancel returns after op.work, so the snapshot has already left streaming.
        assert.notEqual((after.json['session'] as Json)['status'], 'streaming');
    });

    test('CODE-INT-009 catalog read on a fresh host starts no provider inventory', async () => {
        const home = tempHome();
        const fake = createFakeCodeProviders();
        let primes = 0;
        await assignHost(home, 19_088, fake.providers, async () => { primes += 1; });
        // The composed path: HTTP → getService() → host.get() → models().
        // Cursor and Grok discovery spawn a CLI, and prime() — owned by server
        // startup — is the only caller a test must observe; a read is not one.
        const catalog = await request(base + '/api/code/models');
        assert.equal(catalog.status, 200);
        assert.equal((catalog.json['providers'] as Json[]).length, 4);
        assert.equal(primes, 0);
        assert.equal(fake.counts.opens, 0);
        // Explicit activation runs the injected filler exactly once.
        await host?.prime();
        await host?.prime();
        assert.equal(primes, 1);
        assert.equal(fake.counts.opens, 0);
    });

    test('CODE-INT-005 negative contract', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        await assignHost(home, 19_088);
        const relative = await request(base + '/api/code/sessions', 'POST', { ...createBody(cwd), cwd: 'relative' });
        assert.equal(relative.status, 400);
        assert.equal(relative.json['error'], 'absolute_cwd_required');
        const unknown = await request(base + '/api/code/sessions', 'POST', { ...createBody(cwd), extra: true });
        assert.equal(unknown.status, 400);
        assert.equal(unknown.json['error'], 'unknown_field');
        const retired = await request(base + '/api/code/sessions/stored');
        assert.equal(retired.status, 410);
        assert.equal(retired.json['error'], 'code_endpoint_retired');
    });

    test('CODE-INT-006 restart hydration', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        const hostPort = 19_101;
        const child = await spawnChild(home, hostPort);
        try {
            const childBase = 'http://127.0.0.1:' + String(child.httpPort);
            const created = await request(childBase + '/api/code/sessions', 'POST', createBody(cwd));
            assert.equal(created.status, 201);
            const sessionId = (created.json['session'] as Json)['sessionId'] as string;
            const prompt = { text: 'HOLD across crash', clientTurnKey: 'k-crash' };
            const admitted = await request(childBase + '/api/code/sessions/' + sessionId + '/prompt', 'POST', prompt);
            assert.equal(admitted.status, 202);
            await waitForStreaming(childBase + '/api/code/sessions/' + sessionId);
            // Crash the owner mid-turn: no dispose, so the row stays 'streaming'
            // and the next owner's recover() is what has to seal it.
            await request(childBase + '/__crash', 'POST', {}, 5_000).catch(() => undefined);
            await Promise.race([
                once(child.child, 'exit'),
                delay(10_000).then(() => { throw new Error('code-host-child did not exit after /__crash\n' + child.output()); }),
            ]);
            await child.kill();
            const fake = createFakeCodeProviders();
            await assignHost(home, hostPort, fake.providers);
            const recoveredSnap = await request(base + '/api/code/sessions/' + sessionId);
            const session = recoveredSnap.json['session'] as Json;
            const error = session['error'] as Json | null;
            assert.equal(error?.['code'], 'orphaned_turn');
            assert.equal(session['status'], 'failed');
            assert.equal(fake.counts.opens, 0);
            assert.equal(fake.counts.sends, 0);
            recovered = {
                sessionId,
                turnId: admitted.json['turnId'] as string,
                prompt,
            };
        } finally {
            await child.kill();
        }
    });

    test('CODE-INT-008 consumed key after restart', async () => {
        assert.ok(recovered, 'CODE-INT-006 must recover a session before CODE-INT-008');
        const duplicate = await request(base + '/api/code/sessions/' + recovered.sessionId + '/prompt', 'POST', recovered.prompt);
        assert.equal(duplicate.status, 200);
        assert.notEqual(duplicate.json['status'], 'accepted');
        assert.notEqual(duplicate.json['status'], 'running');
        assert.equal(duplicate.json['status'], 'failed');
        assert.equal(duplicate.json['turnId'], recovered.turnId);
        const snapshot = await request(base + '/api/code/sessions/' + recovered.sessionId);
        const items = snapshot.json['items'] as Array<Json>;
        assert.equal(items.filter(item => item['kind'] === 'turn_started').length, 1);
    });

    test('CODE-INT-007 interrupt transcript survives', async () => {
        const home = tempHome();
        const cwd = realpathSync(mkdtempSync(join(home, 'workspace-')));
        const hostPort = 19_088;
        await assignHost(home, hostPort);
        const created = await request(base + '/api/code/sessions', 'POST', createBody(cwd));
        const sessionId = (created.json['session'] as Json)['sessionId'] as string;
        const admitted = await request(base + '/api/code/sessions/' + sessionId + '/prompt', 'POST', {
            text: 'HOLD so sealAccepted can drain', clientTurnKey: 'k-seal',
        });
        const live = await waitForStreaming(base + '/api/code/sessions/' + sessionId);
        await pollSnapshot(base + '/api/code/sessions/' + sessionId, body => {
            const items = body['items'] as Array<Json>;
            return items.some(item => item['kind'] === 'assistant_message'
                && typeof item['text'] === 'string'
                && (item['text'] as string).includes('held assistant text'));
        });
        const cancelled = await request(base + '/api/code/sessions/' + sessionId + '/cancel', 'POST', {
            turnId: admitted.json['turnId'],
            epoch: (live['session'] as Json)['epoch'],
        });
        assert.equal(cancelled.status, 200);
        await assignHost(home, hostPort);
        const snapshot = await request(base + '/api/code/sessions/' + sessionId);
        const items = snapshot.json['items'] as Array<Json>;
        assert.ok(items.some(item => item['kind'] === 'assistant_message'
            && typeof item['text'] === 'string'
            && (item['text'] as string).includes('held assistant text')));
    });
});
