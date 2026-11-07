import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://manager.test/' });
const originals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: dom.window },
    document: { configurable: true, writable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useEmbeddedBrowserTargetSync } = await import('../../public/manager/src/browser-panel/use-embedded-target-sync');
after(() => { dom.window.close(); for (const [k, d] of originals) d ? Object.defineProperty(globalThis, k, d) : Reflect.deleteProperty(globalThis, k); });

const mount1 = { authorityId: 'auth', ownerId: 'owner', generation: 1, mountSeq: 1 };
const mount2 = { ...mount1, mountSeq: 2 };
const tab = { tabId: 'tab', webContentsId: 42, url: 'https://example.test/', title: 'Example', sharedWithAgent: true };
type Request = { url: string; method: string; body: any; keepalive?: boolean };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };

async function setup(t: TestContext, overrides: Record<string, any> = {}, port: number | null = 3457) {
    const requests: Request[] = [];
    const poll = deferred<any>();
    let onState = () => {};
    const released: any[] = [];
    const actions: any[] = [];
    const bridge: any = {
        acquireTargetLease: async () => ({ ok: true, ...mount1 }),
        releaseTargetLease: async (m: any) => { released.push(m); return { ok: true }; },
        getWebviewTabs: async () => ({ ok: true, tabs: [tab], guestEpoch: 7 }),
        onWebviewState: (cb: () => void) => { onState = cb; return () => {}; },
        performWebviewAction: async (action: any) => { actions.push(action); return { ok: true, screenshot: { dataUrl: 'data:' } }; },
        ...overrides,
    };
    (dom.window as any).cliJawDesktop = { browser: bridge };
    let respond: (req: Request) => any = req => req.url.includes('/commands?') ? poll.promise : { ok: true, status: 200, json: async () => ({ ok: true }) };
    globalThis.fetch = (async (url: any, init: any = {}) => {
        const req = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, keepalive: init.keepalive };
        requests.push(req);
        return respond(req);
    }) as any;
    const container = dom.window.document.createElement('div'); dom.window.document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    function Harness(props: { port: number | null }) { useEmbeddedBrowserTargetSync(true, props.port); return null; }
    const render = async (p: number | null) => { await act(async () => { root.render(createElement(Harness, { port: p })); }); };
    const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); container.remove(); } };
    t.after(unmount);
    await render(port);
    return { requests, poll, released, actions, bridge, render, unmount, state: () => onState(), setResponder: (fn: typeof respond) => { respond = fn; } };
}
const posts = (r: Request[], suffix: string) => r.filter(x => x.url.endsWith(suffix));
const ok = (body: any = {}) => ({ ok: true, status: 200, json: async () => body });
const conflict = (reason: string) => ({ ok: false, status: 409, json: async () => ({ reason }) });

test('old bridge fails closed without acquisition', async t => {
    const f = await setup(t, { acquireTargetLease: undefined }); await tick();
    assert.deepEqual(f.requests, [], 'no targets, commands or instance relay without a lease');
});

test('publishes leased snapshots in call order and forwards guest identity', async t => {
    const first = deferred<any>(); const second = deferred<any>(); let calls = 0;
    const f = await setup(t, { getWebviewTabs: () => (++calls === 1 ? first.promise : second.promise) });
    f.state(); await tick(430);
    second.resolve({ ok: true, tabs: [tab], guestEpoch: 8 }); await tick();
    first.resolve({ ok: true, tabs: [tab], guestEpoch: 7 }); await tick();
    const pushes = posts(f.requests, '/targets').filter(x => x.url.startsWith('/api/manager/'));
    assert.deepEqual(pushes.map(x => x.body.lease), [{ ...mount1, snapshotSeq: 2 }, { ...mount1, snapshotSeq: 1 }]);
    assert.deepEqual(pushes.map(x => x.body.guestEpoch), [8, 7]);
    assert.equal(pushes[0].body.targets[0].webContentsId, 42);
    const poll = f.requests.find(x => x.url.includes('/commands?'))!;
    const params = new URL(poll.url, 'https://manager.test').searchParams;
    for (const [k, v] of Object.entries(mount1)) assert.equal(params.get(k), String(v));
});

test('cleanup revokes and releases mount and withdraws last selected port', async t => {
    const f = await setup(t); await tick(); await f.unmount();
    const revoke = posts(f.requests, '/lease/revoke')[0];
    assert.deepEqual(revoke.body, mount1); assert.equal(revoke.method, 'POST'); assert.equal(revoke.keepalive, true);
    assert.deepEqual(f.released, [mount1]);
    const last = f.requests.filter(x => x.url.includes('/instances/3457/')).at(-1)!;
    assert.deepEqual(last.body, { lease: mount1, selected: false }); assert.equal(last.keepalive, true);
});

test('grant after unmount is released without any request', async t => {
    const grant = deferred<any>(); const f = await setup(t, { acquireTargetLease: () => grant.promise });
    await f.unmount(); grant.resolve({ ok: true, ...mount1 }); await tick();
    assert.deepEqual(f.released, [mount1]); assert.deepEqual(f.requests, []);
});

test('non-retryable refusal fails closed', async t => {
    const f = await setup(t, { acquireTargetLease: async () => ({ ok: false, error: 'stale' }) }); await tick();
    assert.deepEqual(f.requests, []);
});

test('malformed successful grant fails closed', async t => {
    const f = await setup(t, { acquireTargetLease: async () => ({ ok: true, ...mount1, mountSeq: 0, retryable: true }) });
    await tick(); assert.deepEqual(f.requests, []);
});

test('retryable refusal retries then publishes', async t => {
    let calls = 0; const f = await setup(t, { acquireTargetLease: async () => ++calls === 1 ? { ok: false, retryable: true } : { ok: true, ...mount1 } });
    await tick(550); assert.equal(calls, 2); assert.equal(posts(f.requests, '/api/manager/embedded-browser/targets').length, 1);
});

test('guest epoch conflict schedules another push', async t => {
    const f = await setup(t, { acquireTargetLease: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, ...mount1 }), 10)) });
    let count = 0; f.setResponder(req => req.url.includes('/commands?') ? f.poll.promise : req.url === '/api/manager/embedded-browser/targets' && ++count === 1 ? conflict('guest-epoch') : ok());
    await tick(40); await tick(450); assert.equal(count, 2);
});

test('revoked conflict reacquires and republishes using new mount', async t => {
    let grants = 0; const f = await setup(t, { acquireTargetLease: async () => { await new Promise(r => setTimeout(r, 10)); return { ok: true, ...(++grants === 1 ? mount1 : mount2) }; } });
    let count = 0; f.setResponder(req => req.url.includes('/commands?') ? f.poll.promise : req.url === '/api/manager/embedded-browser/targets' && ++count === 1 ? conflict('revoked') : ok());
    await tick(80); await tick(40);
    const pushes = posts(f.requests, '/api/manager/embedded-browser/targets');
    assert.equal(grants, 2); assert.equal(pushes[1].body.lease.mountSeq, 2);
    const polls = f.requests.filter(r => r.url.includes('/commands?'));
    assert.deepEqual(polls.map(r => new URL(r.url, 'https://manager.test').searchParams.get('mountSeq')), ['1', '2']);
});

test('stale command is rejected and matching command carries lease and webContentsId', async t => {
    const f = await setup(t); await tick();
    f.poll.resolve(ok({ commands: [
        { id: 'stale', targetId: 'tab', webContentsId: 42, kind: 'screenshot', lease: mount2, settleToken: 's' },
        { id: 'wrong-guest', targetId: 'tab', webContentsId: 43, kind: 'screenshot', lease: mount1, settleToken: 'w' },
        { id: 'good', targetId: 'tab', webContentsId: 42, kind: 'screenshot', lease: mount1, settleToken: 'g' },
    ] })); await tick();
    assert.deepEqual(posts(f.requests, '/commands/stale/result')[0].body, { ok: false, error: 'stale lease', settleToken: 's' });
    assert.deepEqual(posts(f.requests, '/commands/wrong-guest/result')[0].body, { ok: false, error: 'target is no longer available in Manager Browser', settleToken: 'w' });
    assert.deepEqual(f.actions, [{ kind: 'captureScreenshot', tabId: 'tab', webContentsId: 42, agentLease: mount1 }]);
});

test('command delayed until after dispose is rejected without bridge action', async t => {
    const tabs = deferred<any>(); let count = 0;
    const f = await setup(t, { getWebviewTabs: () => ++count === 1 ? Promise.resolve({ ok: true, tabs: [tab], guestEpoch: 0 }) : tabs.promise }); await tick();
    f.poll.resolve(ok({ commands: [{ id: 'late', targetId: 'tab', webContentsId: 42, kind: 'screenshot', lease: mount1 }] })); await tick();
    await f.unmount(); tabs.resolve({ ok: true, tabs: [tab] }); await tick();
    assert.deepEqual(f.actions, []);
    assert.deepEqual(posts(f.requests, '/commands/late/result')[0].body, { ok: false, error: 'stale lease' });
});

test('switching selected port withdraws previous and selects new', async t => {
    let seq = 0; const f = await setup(t, { acquireTargetLease: async () => ({ ok: true, ...mount1, mountSeq: ++seq }) }); await tick();
    await f.render(3458); await tick();
    assert.ok(f.requests.some(r => r.url.includes('/instances/3457/') && r.body.selected === false));
    assert.ok(f.requests.some(r => r.url.includes('/instances/3458/') && r.body.selected === true));
});
