import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Express, RequestHandler } from 'express';
import { registerEmbeddedBrowserRoutes, __resetEmbeddedBrowserStateForTests as reset, __setInstanceFetchTimeoutForTests } from '../../src/manager/routes/embedded-browser.js';

type Reply = { code: number; body: any };
type Handler = (req: any, res: any) => Promise<void>;
const token = 'lease-test-token';
process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'] = token;
const mount = (generation = 1, mountSeq = 1, ownerId = 'owner', authorityId = 'authority') => ({ authorityId, ownerId, generation, mountSeq });
const tab = (webContentsId = 1, targetId = 'tab') => ({ targetId, webContentsId, url: 'https://example.test', title: 'Example', sharedWithAgent: true });
let routes: Map<string, Handler>;
let originalFetch: typeof fetch;
let remote: Map<number, Array<{ id: string; label: string; text: string }>>;
let deleteFailures: number;
let blockNextGet: (() => Promise<void>) | undefined;
let blockNextDelete: (() => Promise<void>) | undefined;

beforeEach(() => {
    reset();
    routes = new Map();
    remote = new Map();
    deleteFailures = 0;
    blockNextGet = undefined;
    blockNextDelete = undefined;
    const register = (method: string) => (path: string, ...chain: any[]) => {
        routes.set(`${method} ${path}`, async (req, res) => {
            for (const fn of chain) {
                if (fn.name === 'jsonParser') continue;
                if (fn.length >= 3) {
                    let next = false;
                    await fn(req, res, () => { next = true; });
                    if (!next) return;
                } else { await fn(req, res); return; }
            }
        });
    };
    registerEmbeddedBrowserRoutes({ get: register('GET'), post: register('POST') } as unknown as Express, ((_req, _res, next) => next()) as RequestHandler, { scanFrom: 7100, scanCount: 20, managerPort: 24576 });
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const port = Number(url.port);
        const entries = remote.get(port) ?? [];
        remote.set(port, entries);
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
            if (blockNextGet) { const block = blockNextGet; blockNextGet = undefined; await block(); }
            return { ok: true, status: 200, json: async () => entries.map(entry => ({ ...entry })) } as Response;
        }
        if (method === 'DELETE') {
            if (blockNextDelete) { const block = blockNextDelete; blockNextDelete = undefined; await block(); }
            if (deleteFailures > 0) { deleteFailures--; return { ok: false, status: 500 } as Response; }
            const id = decodeURIComponent(url.pathname.split('/').pop()!);
            const index = entries.findIndex(entry => entry.id === id);
            if (index >= 0) entries.splice(index, 1);
        } else {
            const body = JSON.parse(String(init?.body));
            entries.push({ id: `${Date.now()}-${entries.length}`, label: body.label, text: body.text });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;
});
afterEach(() => { reset(); globalThis.fetch = originalFetch; });
async function call(method: string, path: string, data: any = {}, onJson?: (body: any) => void): Promise<Reply> {
    const handler = routes.get(`${method} ${path}`);
    assert.ok(handler, `route ${method} ${path} registered`);
    let code = 200; let body: any;
    const res = { status(value: number) { code = value; return this; }, json(value: any) { body = value; onJson?.(value); } };
    await handler({ headers: {}, get: () => token, query: {}, params: {}, ...data }, res);
    return { code, body };
}
const publish = (m = mount(), snapshotSeq = 1, targets: any[] = [tab()], guestEpoch = 0) => call('POST', '/api/manager/embedded-browser/targets', { body: { lease: { ...m, snapshotSeq }, targets, guestEpoch } });
const revoke = (body: object, onJson?: (body: any) => void) => call('POST', '/api/manager/embedded-browser/lease/revoke', { body }, onJson);
const list = () => call('GET', '/api/manager/embedded-browser/targets');
const poll = (m?: object) => call('GET', '/api/manager/embedded-browser/commands', { query: m ?? { wait: '25000' } });
const action = (kind: 'screenshot' | 'snapshot' | 'act', targetId = 'tab') => call('POST', `/api/manager/embedded-browser/:targetId/${kind}`, { params: { targetId }, body: { act: { kind: 'click', x: 1, y: 1 } } });
const relay = (port: number, m = mount(), selected = true) => call('POST', '/api/dashboard/instances/:port/embedded-browser/targets', { params: { port: String(port) }, body: { lease: m, selected } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('main revoke clears targets and settles every pending command before responding', async () => {
    assert.equal((await publish()).code, 200);
    const pending = ['screenshot', 'snapshot', 'act'].map(kind => action(kind as 'screenshot' | 'snapshot' | 'act'));
    await tick();
    let clearedAtResponse = false;
    const response = await revoke(mount(), () => { clearedAtResponse = true; });
    assert.equal(response.code, 200); assert.equal(clearedAtResponse, true);
    assert.deepEqual((await list()).body.targets, []);
    for (const result of await Promise.all(pending)) { assert.equal(result.code, 410); assert.equal(result.body.code, 'target_unavailable'); }
});

test('unmount and delayed first publish are rejected while remount is accepted', async () => {
    assert.equal((await revoke(mount())).code, 200);
    assert.equal((await publish()).body.reason, 'revoked');
    assert.equal((await publish(mount(1, 2))).code, 200);
    assert.equal((await publish(mount(), 2)).body.reason, 'revoked');
});

test('reload and cross-window late publish and revoke preserve newer window', async () => {
    assert.equal((await publish()).code, 200);
    await revoke({ ...mount(), mountSeq: undefined });
    assert.equal((await publish(mount(2, 2, 'window-B'))).code, 200);
    assert.equal((await publish(mount(), 2)).code, 409);
    await revoke(mount());
    assert.equal((await list()).body.targets.length, 1);
});

test('guest epoch, tombstones, old generation and reused target IDs', async () => {
    await publish(mount(), 1, [tab(1), tab(2, 'other')]);
    const pending = action('snapshot'); await tick();
    await revoke({ ...mount(), mountSeq: undefined, guestEpoch: 1, webContentsIds: [1] });
    assert.equal((await pending).code, 410);
    assert.deepEqual((await list()).body.targets.map((t: any) => t.targetId), ['other']);
    assert.equal((await publish(mount(), 2, [tab()], 0)).body.reason, 'guest-epoch');
    assert.equal((await publish(mount(), 3, [tab(), tab(2, 'other')], 1)).body.count, 1);
    assert.equal((await publish(mount(), 4, [tab(3)], 1)).body.count, 1);
    await publish(mount(2, 2), 1, [tab(4)], 1);
    await revoke({ ...mount(), mountSeq: undefined, guestEpoch: 2, webContentsIds: [5] });
    assert.equal((await publish(mount(2, 2), 2, [tab(5)], 2)).body.count, 1);
});

test('tombstone overflow revokes the mount but allows a later mount', async () => {
    await publish();
    for (let start = 1; start <= 257; start += 64) {
        const webContentsIds = Array.from({ length: Math.min(64, 258 - start) }, (_, i) => start + i);
        await revoke({ ...mount(), mountSeq: undefined, guestEpoch: start, webContentsIds });
    }
    assert.equal((await list()).body.targets.length, 0);
    assert.equal((await publish(mount(), 2, [tab()], 257)).body.reason, 'revoked');
    assert.equal((await publish(mount(1, 2), 1, [tab()], 257)).code, 200);
});

test('mount replacement settles pending command; polling requires and filters lease', async () => {
    await publish();
    const pending = action('screenshot'); await tick();
    assert.deepEqual((await poll()).body.commands, []);
    assert.deepEqual((await poll(mount(1, 2))).body.commands, []);
    const commands = (await poll(mount())).body.commands;
    assert.equal(commands.length, 1); assert.equal(commands[0].webContentsId, 1); assert.deepEqual(commands[0].lease, mount());
    await publish(mount(1, 2));
    assert.equal((await pending).code, 410);
    const result = await call('POST', '/api/manager/embedded-browser/commands/:id/result', { params: { id: commands[0].id }, body: { ok: true, settleToken: commands[0].settleToken } });
    assert.equal(result.code, 404);
});

test('relay withdraws previous port and never re-delivers on selected:false', async () => {
    await publish();
    assert.equal((await relay(7101)).body.added, 1);
    assert.equal((await relay(7102)).body.added, 1);
    await relay(7101, mount(), false);
    assert.equal(remote.get(7101)?.length, 0); assert.equal(remote.get(7102)?.length, 1);
});

test('switching ports handles previous-port failure and retries its withdrawal', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
        await publish(); await relay(7101);
        deleteFailures = 1;
        assert.equal((await relay(7102)).code, 200);
        await tick();
        assert.deepEqual(unhandled, []);
        assert.equal(remote.get(7102)?.length, 1);
        assert.equal(remote.get(7101)?.length, 1);
        await new Promise(resolve => setTimeout(resolve, 1150));
        assert.equal(remote.get(7101)?.length, 0);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('revoke during reconcile triggers another pass and leaves port empty', async () => {
    await publish();
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextGet = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    const request = relay(7101); await entered;
    const revocation = revoke(mount()); release(); await Promise.all([revocation, request]);
    assert.equal(remote.get(7101)?.length, 0);
});

test('revoke settles commands immediately and responds after worker deletion', async () => {
    await publish(); await relay(7101);
    const pending = action('snapshot'); await tick();
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextDelete = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    let responded = false;
    const revocation = revoke(mount(), () => { responded = true; });
    await entered;
    try {
        assert.equal((await pending).code, 410);
        assert.equal(responded, false);
    } finally { release(); await revocation; }
    assert.equal(remote.get(7101)?.length, 0);
    assert.equal(responded, true);
});

test('app-quit waits for a slow instance GET and deletion while settling commands immediately', async () => {
    await publish(); await relay(7101);
    const pending = action('snapshot'); await tick();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextGet = async () => { started(); await new Promise(resolve => setTimeout(resolve, 1800)); };
    let responded = false;
    const revocation = revoke({ ...mount(), reason: 'app-quit' }, () => { responded = true; });
    await entered;
    assert.equal((await pending).code, 410);
    assert.deepEqual((await list()).body.targets, []);
    assert.equal(responded, false);
    const response = await revocation;
    assert.equal(response.code, 200);
    assert.equal(remote.get(7101)?.length, 0, 'DELETE must finish before the response');
});

test('app-quit retries a failed DELETE before responding', async () => {
    await publish(); await relay(7101);
    deleteFailures = 1;
    assert.equal((await revoke({ ...mount(), reason: 'app-quit' })).code, 200);
    assert.equal(deleteFailures, 0);
    assert.equal(remote.get(7101)?.length, 0, 'retry must delete before the response');
});

test('app-quit also waits for dirty ports left by an earlier revoke', async () => {
    await publish(); await relay(7101);
    deleteFailures = 1;
    await revoke(mount());
    assert.equal(remote.get(7101)?.length, 1);
    assert.equal((await revoke({ ...mount(), reason: 'app-quit' })).code, 200);
    assert.equal(remote.get(7101)?.length, 0);
});

test('app-quit retries a failed port while another port remains blocked', async () => {
    await publish(); await relay(7101);
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextGet = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    await relay(7102); await entered;
    deleteFailures = 1;
    const revocation = revoke({ ...mount(), reason: 'app-quit' });
    try {
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(remote.get(7102)?.length, 0, 'blocked port must not delay another port retry');
    } finally { release(); await revocation; }
});

test('app-quit responds within eight seconds when an instance never answers', async () => {
    await publish(); await relay(7101);
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextGet = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    const start = Date.now();
    const revocation = revoke({ ...mount(), reason: 'app-quit' });
    await entered;
    try {
        assert.equal((await revocation).code, 200);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 7000 && elapsed < 9500, `response took ${elapsed}ms`);
    } finally { release(); await tick(); }
});

test('revoke responds within its bound when worker does not answer', async () => {
    await publish(); await relay(7101);
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    blockNextGet = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    const start = Date.now();
    const revocation = revoke(mount());
    await entered;
    try {
        assert.equal((await revocation).code, 200);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 1300 && elapsed < 3000, `response took ${elapsed}ms`);
    } finally { release(); await tick(); }
});

test('timed-out instance request releases a dirty revoke for retry', async () => {
    __setInstanceFetchTimeoutForTests(30);
    await publish(); await relay(7101);
    const normalFetch = globalThis.fetch;
    let started!: () => void; let abortHeld!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    let aborted = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (first && (!init?.method || init.method === 'GET')) {
            first = false;
            return new Promise<Response>((_resolve, reject) => {
                const abort = () => { aborted = true; reject(new Error('aborted')); };
                abortHeld = abort;
                init?.signal?.addEventListener('abort', abort, { once: true });
                started();
            });
        }
        return normalFetch(input, init);
    }) as typeof fetch;
    const request = relay(7101); await entered;
    const revocation = revoke(mount());
    try {
        await new Promise(resolve => setTimeout(resolve, 1400));
        assert.equal(aborted, true);
        assert.equal(remote.get(7101)?.length, 0);
    } finally {
        if (!aborted) abortHeld();
        await Promise.all([request, revocation]);
    }
});

test('instance list response body is also bounded and retried', async () => {
    __setInstanceFetchTimeoutForTests(30);
    await publish(); await relay(7101);
    const normalFetch = globalThis.fetch;
    let started!: () => void; let abortHeld!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let first = true; let aborted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (first && (!init?.method || init.method === 'GET')) {
            first = false;
            return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
                const abort = () => { aborted = true; reject(new Error('aborted')); };
                abortHeld = abort;
                init?.signal?.addEventListener('abort', abort, { once: true });
                started();
            }) } as Response;
        }
        return normalFetch(input, init);
    }) as typeof fetch;
    const request = relay(7101); await entered;
    const revocation = revoke(mount());
    try {
        await new Promise(resolve => setTimeout(resolve, 1400));
        assert.equal(aborted, true);
        assert.equal(remote.get(7101)?.length, 0);
    } finally {
        if (!aborted) abortHeld();
        await Promise.all([request, revocation]);
    }
});

test('failed DELETE stays dirty and is retried; failed fetch does not block clear', async () => {
    await publish(); await relay(7101);
    deleteFailures = 1;
    await revoke(mount());
    await tick();
    assert.equal(remote.get(7101)?.length, 1);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(remote.get(7101)?.length, 0);
    await publish(mount(1, 2)); await relay(7101, mount(1, 2));
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal((await revoke(mount(1, 2))).code, 200);
    assert.equal((await list()).body.targets.length, 0);
});

test('capacity, missing lease and normal snapshot replacement', async () => {
    assert.equal((await call('POST', '/api/manager/embedded-browser/targets', { body: { targets: [] } })).code, 400);
    for (let i = 0; i < 16; i++) assert.equal((await publish(mount(1, 1, 'owner', `auth-${i}`))).code, 200);
    const overflow = mount(1, 1, 'owner', 'overflow');
    assert.equal((await publish(overflow)).body.reason, 'authority-capacity');
    assert.equal((await revoke(overflow)).body.applied, false);
    assert.equal((await publish(mount(1, 1, 'owner', 'auth-15'), 2, [tab(2, 'replacement')])).code, 200);
    assert.deepEqual((await list()).body.targets.map((t: any) => t.targetId), ['replacement']);
});
