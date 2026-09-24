import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDashboardShutdown } from '../../src/manager/shutdown.js';
import { closeSseConnections, trackSseConnection, trackedSseConnectionCount } from '../../src/routes/sse-connections.js';
import { PLANNED_RESTART_CODE } from '../../src/core/process-codes.js';
import type { DashboardLifecycleResult } from '../../src/manager/types.js';

function makeLifecycleResult(port: number, ok = true): DashboardLifecycleResult {
    return {
        ok,
        action: 'stop',
        port,
        status: ok ? 'stopped' : 'error',
        message: ok ? `Stopped ${port}` : `Failed ${port}`,
        home: `/tmp/.cli-jaw-${port}`,
        pid: 1000 + port,
        command: ['jaw', 'serve', '--port', String(port)],
        expectedStateAfter: ok ? 'offline' : undefined,
    };
}

test('dashboard shutdown stops managed children before closing preview and server', async () => {
    const calls: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: {
            async stopAll(mode) {
                calls.push(`stopAll:${mode ?? 'default'}`);
                return [makeLifecycleResult(3457)];
            },
        },
        previewProxy: {
            async close() {
                calls.push('preview.close');
            },
        },
        server: {
            close(callback) {
                calls.push('server.close');
                callback?.();
            },
        },
        exit(code) {
            calls.push(`exit:${code}`);
        },
    });

    await shutdown();

    assert.deepEqual(calls, ['stopAll:locked-skip', 'preview.close', 'server.close', 'exit:0']);
});

test('dashboard shutdown logs lifecycle failures and continues cleanup', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: {
            async stopAll(mode) {
                calls.push(`stopAll:${mode ?? 'default'}`);
                return [makeLifecycleResult(3457, false)];
            },
        },
        previewProxy: {
            async close() {
                calls.push('preview.close');
            },
        },
        server: {
            close(callback) {
                calls.push('server.close');
                callback?.();
            },
        },
        exit(code) {
            calls.push(`exit:${code}`);
        },
        log: {
            warn(message) {
                warnings.push(message);
            },
            error(message) {
                calls.push(`error:${message}`);
            },
        },
    });

    await shutdown();

    assert.deepEqual(calls, ['stopAll:locked-skip', 'preview.close', 'server.close', 'exit:0']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /failed to stop managed Jaw on port 3457/);
});

test('dashboard shutdown logs server close errors and still exits zero', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: {
            async stopAll(mode) {
                calls.push(`stopAll:${mode ?? 'default'}`);
                return [];
            },
        },
        previewProxy: {
            async close() {
                calls.push('preview.close');
            },
        },
        server: {
            close(callback) {
                calls.push('server.close');
                callback?.(new Error('close failed'));
            },
        },
        exit(code) {
            calls.push(`exit:${code}`);
        },
        log: {
            warn(message) {
                calls.push(`warn:${message}`);
            },
            error(message) {
                errors.push(message);
            },
        },
    });

    await shutdown();

    assert.deepEqual(calls, ['stopAll:locked-skip', 'preview.close', 'server.close', 'exit:0']);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /failed to close manager server: close failed/);
});

test('dashboard shutdown skips stopAll when CLI_JAW_TEST_MODE is set', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const originalEnv = process.env['CLI_JAW_TEST_MODE'];
    process.env['CLI_JAW_TEST_MODE'] = '1';
    try {
        const shutdown = createDashboardShutdown({
            lifecycle: {
                async stopAll() {
                    calls.push('stopAll');
                    return [];
                },
            },
            previewProxy: { async close() { calls.push('preview.close'); } },
            server: { close(callback) { calls.push('server.close'); callback?.(); } },
            exit(code) { calls.push(`exit:${code}`); },
            log: {
                warn(message) { warnings.push(message); },
                error() {},
            },
        });

        await shutdown();

        assert.ok(!calls.includes('stopAll'), 'stopAll should not be called in test mode');
        assert.ok(calls.includes('preview.close'));
        assert.ok(calls.includes('server.close'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /test mode: skipping stopAll/);
    } finally {
        if (originalEnv === undefined) delete process.env['CLI_JAW_TEST_MODE'];
        else process.env['CLI_JAW_TEST_MODE'] = originalEnv;
    }
});

test('dashboard shutdown passes mode parameter to stopAll', async () => {
    const modes: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: {
            async stopAll(mode) {
                modes.push(mode ?? 'undefined');
                return [];
            },
        },
        previewProxy: { async close() {} },
        server: { close(callback) { callback?.(); } },
        exit() {},
    });

    await shutdown('full');
    assert.deepEqual(modes, ['full']);
});

test('dashboard shutdown is idempotent while cleanup is in flight', async () => {
    const calls: string[] = [];
    let releaseStopAll: (() => void) | null = null;
    const shutdown = createDashboardShutdown({
        lifecycle: {
            async stopAll(mode) {
                calls.push(`stopAll:${mode ?? 'default'}`);
                await new Promise<void>(resolve => { releaseStopAll = resolve; });
                return [];
            },
        },
        previewProxy: {
            async close() {
                calls.push('preview.close');
            },
        },
        server: {
            close(callback) {
                calls.push('server.close');
                callback?.();
            },
        },
        exit(code) {
            calls.push(`exit:${code}`);
        },
    });

    const first = shutdown();
    const second = shutdown();
    releaseStopAll?.();
    await Promise.all([first, second]);

    assert.deepEqual(calls, ['stopAll:locked-skip', 'preview.close', 'server.close', 'exit:0']);
});

// #790 — an open SSE response is an in-flight request: pre-fix, server.close()
// waited on it forever, so a connected dashboard blocked graceful stop and the
// SIGUSR2 planned restart. These harnesses use a real http.Server and an SSE
// client that never closes on its own.
function makeStreamingServer(): Promise<{
    server: http.Server;
    port: number;
}> {
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write(': connected\n\n');
        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { /* client may be gone */ }
        }, 30_000);
        ping.unref();
        const cleanup = () => {
            clearInterval(ping);
            untrack();
            if (!res.writableEnded) res.end();
        };
        const untrack = trackSseConnection(cleanup);
        req.on('close', cleanup);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as { port: number }).port });
        });
    });
}

async function openSseClient(port: number): Promise<http.ClientRequest> {
    const req = http.get(`http://127.0.0.1:${port}/api/manager/events/stream`);
    const [res] = await once(req, 'response') as unknown as [http.IncomingMessage];
    res.resume();
    return req;
}

test('dashboard shutdown ends a tracked SSE stream so server.close completes without client help', async () => {
    const { server, port } = await makeStreamingServer();
    const baseline = trackedSseConnectionCount();
    const req = await openSseClient(port);
    assert.equal(trackedSseConnectionCount(), baseline + 1);

    const calls: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: { async stopAll() { calls.push('stopAll'); return []; } },
        previewProxy: { async close() { calls.push('preview.close'); } },
        server,
        closeSseConnections,
        serverCloseTimeoutMs: 2_000,
        exit(code) { calls.push(`exit:${code}`); },
    });

    try {
        // The client stays connected — the shutdown must not wait on it.
        await shutdown();
        assert.deepEqual(calls, ['stopAll', 'preview.close', 'exit:0']);
        assert.ok(!server.listening);
        assert.equal(trackedSseConnectionCount(), baseline);
    } finally {
        req.destroy();
    }
});

test('dashboard shutdown reaches the planned-restart exit code with a live SSE client', async () => {
    const { server, port } = await makeStreamingServer();
    const req = await openSseClient(port);

    // Same wiring as src/manager/server.ts: SIGUSR2 sets plannedRestartCode and
    // the injected exit maps it over the generic code.
    let plannedRestartCode: number | null = null;
    const calls: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: { async stopAll(mode) { calls.push(`stopAll:${mode ?? 'default'}`); return []; } },
        previewProxy: { async close() { calls.push('preview.close'); } },
        server,
        closeSseConnections,
        serverCloseTimeoutMs: 2_000,
        exit(code) { calls.push(`exit:${plannedRestartCode ?? code}`); },
    });

    try {
        plannedRestartCode = PLANNED_RESTART_CODE;
        await shutdown('full');
        assert.deepEqual(calls, ['stopAll:full', 'preview.close', `exit:${PLANNED_RESTART_CODE}`]);
        assert.ok(!server.listening);
    } finally {
        req.destroy();
    }
});

test('dashboard shutdown stays bounded when server.close stalls', async () => {
    const calls: string[] = [];
    const shutdown = createDashboardShutdown({
        lifecycle: { async stopAll() { calls.push('stopAll'); return []; } },
        previewProxy: { async close() { calls.push('preview.close'); } },
        // Server whose close callback never fires — a stuck connection the
        // graceful drain cannot reach must not stall shutdown (#790).
        server: { close(_callback) { calls.push('server.close'); } },
        serverCloseTimeoutMs: 50,
        exit(code) { calls.push(`exit:${code}`); },
    });

    await shutdown();
    assert.deepEqual(calls, ['stopAll', 'preview.close', 'server.close', 'exit:0']);
});
