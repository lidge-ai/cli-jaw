import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrayInstancesPoller } from '../../electron/src/main/lib/tray-instances.ts';
import type { TrayInstancesSnapshot } from '../../electron/src/main/lib/tray-menu-model.ts';

const MANAGER_URL = 'http://127.0.0.1:24577/';
const INSTANCES_URL = 'http://127.0.0.1:24577/api/dashboard/instances';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function instancesBody(): unknown {
    return {
        ok: true,
        instances: [
            { port: 3457, label: 'Main', status: 'online', currentCli: 'codex' },
            { port: 3458, label: 'Side', status: 'offline' },
        ],
    };
}

function recorder(): {
    snapshots: TrayInstancesSnapshot[];
    logs: string[];
    onUpdate: (snapshot: TrayInstancesSnapshot) => void;
    log: (message: string) => void;
    last: () => TrayInstancesSnapshot | undefined;
} {
    const snapshots: TrayInstancesSnapshot[] = [];
    const logs: string[] = [];
    return {
        snapshots,
        logs,
        onUpdate: snapshot => { snapshots.push(snapshot); },
        log: message => { logs.push(message); },
        last: () => snapshots[snapshots.length - 1],
    };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('tray instances poller publishes the parsed list with zero failures', async () => {
    const calls: string[] = [];
    const seen = recorder();
    const poller = createTrayInstancesPoller({
        managerUrl: MANAGER_URL,
        onUpdate: seen.onUpdate,
        log: seen.log,
        intervalMs: 50,
        fetchImpl: async (input, init) => {
            calls.push(String(input));
            assert.equal(init?.cache, 'no-store');
            assert.ok(init?.signal instanceof AbortSignal);
            return jsonResponse(instancesBody());
        },
    });

    try {
        await poller.refreshNow();

        assert.deepEqual(calls, [INSTANCES_URL]);
        assert.equal(seen.snapshots.length, 1);
        assert.deepEqual(seen.last()?.instances, [
            { port: 3457, label: 'Main', status: 'online', cli: 'codex', model: null },
            { port: 3458, label: 'Side', status: 'offline', cli: null, model: null },
        ]);
        assert.equal(seen.last()?.failures, 0);
        assert.ok(typeof seen.last()?.updatedAt === 'number');
        assert.equal(poller.snapshot().failures, 0);
        assert.deepEqual(seen.logs, []);
    } finally {
        poller.stop();
    }
});

test('tray instances poller logs failures, counts them, and keeps the last list', async () => {
    const seen = recorder();
    let failing = false;
    const poller = createTrayInstancesPoller({
        managerUrl: MANAGER_URL,
        onUpdate: seen.onUpdate,
        log: seen.log,
        intervalMs: 50,
        fetchImpl: async () => (failing ? jsonResponse({ error: 'boom' }, 503) : jsonResponse(instancesBody())),
    });

    try {
        await poller.refreshNow();
        const updatedAt = poller.snapshot().updatedAt;
        assert.equal(typeof updatedAt, 'number');

        failing = true;
        await poller.refreshNow();

        assert.deepEqual(poller.snapshot().instances.map(row => row.port), [3457, 3458]);
        assert.equal(poller.snapshot().failures, 1);
        assert.equal(poller.snapshot().updatedAt, updatedAt);
        assert.equal(seen.logs.length, 1);
        assert.match(seen.logs[0] ?? '', /^\[jaw-tray\] instances refresh failed: /);
        assert.match(seen.logs[0] ?? '', /503/);

        await poller.refreshNow();

        assert.equal(poller.snapshot().failures, 2);
        assert.deepEqual(poller.snapshot().instances.map(row => row.port), [3457, 3458]);
        assert.equal(seen.logs.length, 2);
        assert.equal(seen.snapshots.length, 3);
    } finally {
        poller.stop();
    }
});

test('overlapping refreshNow calls share one fetch', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen = recorder();
    const poller = createTrayInstancesPoller({
        managerUrl: MANAGER_URL,
        onUpdate: seen.onUpdate,
        log: seen.log,
        intervalMs: 50,
        fetchImpl: async () => {
            calls += 1;
            await gate;
            return jsonResponse(instancesBody());
        },
    });

    try {
        const first = poller.refreshNow();
        const second = poller.refreshNow();
        await delay(0);

        assert.equal(calls, 1);

        release();
        await Promise.all([first, second]);

        assert.equal(calls, 1);
        assert.equal(seen.snapshots.length, 1);
        assert.equal(poller.snapshot().failures, 0);
    } finally {
        poller.stop();
    }
});

test('stop() prevents further scheduled refreshes', async () => {
    let calls = 0;
    const seen = recorder();
    const poller = createTrayInstancesPoller({
        managerUrl: MANAGER_URL,
        onUpdate: seen.onUpdate,
        log: seen.log,
        intervalMs: 10,
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse(instancesBody());
        },
    });

    try {
        poller.start();
        const deadline = Date.now() + 800;
        while (calls < 2 && Date.now() < deadline) await delay(5);
        assert.ok(calls >= 2, `expected repeated scheduled refreshes, saw ${calls}`);

        poller.stop();
        await delay(0);
        const settled = calls;
        await delay(150);

        assert.equal(calls, settled);
        assert.equal(seen.snapshots.length, settled);
    } finally {
        poller.stop();
    }
});
