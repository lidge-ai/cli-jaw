import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { Express, Request, RequestHandler, Response } from 'express';

// This route fixture never listens, spawns or sends to a provider. Its real
// router imports and any local DB initialization remain inside the file home.
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    test.mock.method(childProcess, method, () => { throw new Error('unexpected subprocess in queue-steer fixture'); });
}
syncBuiltinESMExports();
test.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in queue-steer fixture'); });
test.after(() => { test.mock.restoreAll(); syncBuiltinESMExports(); });

const spawn = await import('../../src/agent/spawn.ts');
const pipeline = await import('../../src/orchestrator/pipeline.ts');
const database = await import('../../src/core/db.ts');
const bus = await import('../../src/core/bus.ts');
const { settings } = await import('../../src/core/config.ts');
const calls: Array<{ name: string; args: unknown[] }> = [];
const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
const item = {
    id: 'queue-wait-A', prompt: 'continue queued work A', source: 'web', scope: 'queue-scope-A',
    chatSessionId: 'queue-chat-A', requestId: 'queue-request-A', chatId: 'thread-A', remoteKey: 'remote-A',
    target: { channel: 'slack', targetId: 'fixture-channel-A' },
};
const queued: Array<typeof item> = [];
let busy = true, inProgress = false, dispatched = false;
let mainGate = Promise.withResolvers<void>(), workerGate = Promise.withResolvers<void>(), exitGate = Promise.withResolvers<void>();
let atWait = Promise.withResolvers<void>(), atExit = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();

test.mock.module('../../src/agent/spawn.js', { namedExports: { ...spawn,
    messageQueue: queued,
    isAgentBusy: (scope: string) => { record('busy', scope); return busy; },
    getSteerWaitMsForActiveAgent: () => 10000,
    isSteerInProgress: () => inProgress,
    setSteerInProgress: (scope: string, value: boolean) => {
        record('steer-state', scope, value); inProgress = value;
        if (!value && dispatched) finished.resolve();
    },
    setQueueHold: (...args: unknown[]) => record('hold', ...args),
    clearQueueHold: (...args: unknown[]) => record('unhold', ...args),
    removeQueuedMessage: (id: string) => {
        record('remove', id); const index = queued.findIndex(row => row.id === id);
        if (index < 0) return { removed: false, pending: queued.length };
        queued.splice(index, 1); return { removed: true, pending: queued.length };
    },
    killActiveAgent: (scope: string, reason: string) => { record('kill', scope, reason); return true; },
    waitForProcessEnd: async (...args: unknown[]) => { record('wait-all', ...args); atWait.resolve(); await workerGate.promise; },
    waitForMainProcessEnd: async (...args: unknown[]) => { record('wait-main', ...args); atWait.resolve(); await mainGate.promise; },
    waitForExitSettled: async (...args: unknown[]) => { record('wait-exit', ...args); atExit.resolve(); await exitGate.promise; },
} });
test.mock.module('../../src/orchestrator/pipeline.js', { namedExports: { ...pipeline,
    isResetIntent: () => false, isContinueIntent: () => false,
    orchestrate: async (...args: unknown[]) => { dispatched = true; record('dispatch', ...args); },
    orchestrateReset: async () => assert.fail('unexpected reset'),
    orchestrateContinue: async () => assert.fail('unexpected continue'),
} });
test.mock.module('../../src/core/db.js', { namedExports: { ...database,
    insertMessage: { run: (...args: unknown[]) => record('insert', ...args) },
    getMaxMessageId: (session: string) => { record('watermark', session); return 41; },
    getSteerSalvageAfter: (session: string, id: number) => {
        record('salvage', session, id); return '⏹️ [interrupted]\n\nretained main partial';
    },
} });
test.mock.module('../../src/core/bus.js', { namedExports: { ...bus,
    broadcast: (...args: unknown[]) => record('broadcast', ...args),
} });

const { registerOrchestrateRoutes } = await import('../../src/routes/orchestrate.ts');
const routes = new Map<string, RequestHandler[]>();
const capture = (method: string) => (url: string, ...handlers: RequestHandler[]) => { routes.set(`${method} ${url}`, handlers); };
const auth: RequestHandler = (_req, _res, next) => { record('auth'); next(); };
registerOrchestrateRoutes({ post: capture('POST'), get: capture('GET'), put: capture('PUT'),
    delete: capture('DELETE'), patch: capture('PATCH') } as unknown as Express, auth);
const handlers = routes.get('POST /api/orchestrate/queue/:id/steer')!;
assert.equal(handlers[0], auth, 'the real registration must retain instance auth');
const handler = handlers.at(-1)!;

async function invoke(id = item.id) {
    const state: { status: number; body?: unknown } = { status: 200 };
    const response = {
        status(value: number) { state.status = value; return response; },
        json(value: unknown) { state.body = value; record('ack', value); return response; },
    };
    const req = { params: { id }, body: {}, headers: {} } as unknown as Request;
    const res = response as unknown as Response;
    let admitted = false;
    auth(req, res, () => { admitted = true; }); assert.equal(admitted, true);
    await handler(req, res, error => { if (error) throw error; });
    return state;
}
test.beforeEach(() => {
    calls.length = 0; queued.splice(0, queued.length, structuredClone(item));
    busy = true; inProgress = false; dispatched = false;
    mainGate = Promise.withResolvers<void>(); workerGate = Promise.withResolvers<void>(); exitGate = Promise.withResolvers<void>();
    atWait = Promise.withResolvers<void>(); atExit = Promise.withResolvers<void>(); finished = Promise.withResolvers<void>();
    settings.multiSession = { ...settings.multiSession, enabled: true };
});
test.afterEach(() => { mainGate.resolve(); workerGate.resolve(); exitGate.resolve(); });

test('registered queue steer ACKs before main wait, preserves exit barrier and dispatches one captured insertion', { timeout: 5000 }, async () => {
    const response = await invoke();
    try {
        assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true, pending: 0 });
        await atWait.promise;
        const names = calls.map(call => call.name);
        assert.ok(names.indexOf('remove') < names.indexOf('ack'));
        assert.ok(names.indexOf('ack') < names.indexOf('kill'));
        const wait = calls.find(call => call.name.startsWith('wait-'))!;
        assert.equal(wait.name, 'wait-main', 'queue steer must not select the surviving-worker wait');
        assert.deepEqual(wait.args, [item.scope, 10000]);
        assert.deepEqual(calls.find(call => call.name === 'kill')!.args, [item.scope, 'steer']);
        assert.equal(calls.filter(call => call.name === 'insert').length, 1);
        assert.equal(dispatched, false);
        mainGate.resolve(); await atExit.promise;
        assert.deepEqual(calls.find(call => call.name === 'wait-exit')!.args, [item.scope]);
        assert.equal(dispatched, false); assert.equal(calls.some(call => call.name === 'salvage'), false);
        exitGate.resolve(); await finished.promise;
        const dispatches = calls.filter(call => call.name === 'dispatch'); assert.equal(dispatches.length, 1);
        assert.deepEqual(dispatches[0]!.args, [item.prompt, {
            origin: item.source, target: item.target, chatId: item.chatId, requestId: item.requestId,
            _fromQueue: true, scope: item.scope, chatSessionId: item.chatSessionId,
            remoteKey: item.remoteKey, _steerContext: 'retained main partial', _skipInsert: true, _skipReplayDrain: true,
        }]);
        assert.deepEqual(calls.find(call => call.name === 'watermark')!.args, [item.chatSessionId]);
        assert.deepEqual(calls.find(call => call.name === 'salvage')!.args, [item.chatSessionId, 41]);
        assert.equal(calls.filter(call => call.name === 'insert').length, 1);
        const messages = calls.filter(call => call.name === 'broadcast' && call.args[0] === 'new_message');
        assert.equal(messages.length, 1);
        assert.equal((messages[0]!.args[1] as { fromQueue: boolean }).fromQueue, true);
        assert.equal(inProgress, false);
    } finally {
        mainGate.resolve(); workerGate.resolve(); exitGate.resolve();
        await finished.promise;
    }
});

test('idle registered queue steer dispatches once without kill or either wait', { timeout: 5000 }, async () => {
    busy = false;
    assert.equal((await invoke()).status, 200); await finished.promise;
    assert.equal(calls.some(call => call.name === 'kill' || call.name.startsWith('wait-')), false);
    assert.equal(calls.filter(call => call.name === 'insert').length, 1);
    assert.equal(calls.filter(call => call.name === 'dispatch').length, 1);
    assert.equal(inProgress, false);
});

test('missing or already-steering queue item never inserts or starts a second continuation', async () => {
    assert.equal((await invoke('missing')).status, 404);
    assert.equal(queued.length, 1);
    inProgress = true;
    assert.equal((await invoke()).status, 409);
    assert.equal(queued.length, 1);
    assert.equal(calls.some(call => ['insert', 'remove', 'kill', 'dispatch'].includes(call.name)), false);
});

test('Aside owned queue-steer rejects before hold, removal, stop, insertion or dispatch', async () => {
    spawn.activeMainProcesses.set(item.scope, { process: null, starting: true, steering: false, ownerGeneration: 0,
        meta: { cli: 'aside', origin: 'web', chatSessionId: item.chatSessionId } });
    try {
        const result = await invoke();
        assert.equal(result.status, 409);
        assert.equal(queued.length, 1);
        assert.equal(calls.some(call => ['hold', 'remove', 'kill', 'insert', 'dispatch'].includes(call.name)), false);
    } finally { spawn.activeMainProcesses.delete(item.scope); }
});

test('selected Aside queued item rejects queue-steer even when idle', async () => {
    busy = false;
    queued[0] = Object.assign(structuredClone(item), { overrides: { cli: 'aside' } });
    const result = await invoke();
    assert.equal(result.status, 409);
    assert.equal(queued.length, 1);
    assert.equal(calls.some(call => ['hold', 'remove', 'kill', 'insert', 'dispatch'].includes(call.name)), false);
});

test('Aside reconciliation endpoint requires explicit acknowledgement and retains instance auth', async () => {
    const route = routes.get('POST /api/orchestrate/aside/reconcile')!;
    assert.equal(route[0], auth);
    const handler = route.at(-1)!;
    const state = { status: 200, body: undefined as unknown };
    const response = { status(value: number) { state.status = value; return response; },
        json(value: unknown) { state.body = value; return response; } };
    await handler({ body: { sessionId: 'default' } } as unknown as Request,
        response as unknown as Response, error => { if (error) throw error; });
    assert.equal(state.status, 400);
    state.status = 200;
    await handler({ body: { sessionId: 'unknown', acknowledgementToken: '8a0f4e69-b035-4186-8b99-1783f3adad19', acknowledged: true } } as unknown as Request,
        response as unknown as Response, error => { if (error) throw error; });
    assert.equal(state.status, 404);
});
