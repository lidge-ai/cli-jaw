import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { DashboardProcessControlState } from '../../public/manager/src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const cssUrl = new URL('../../public/manager/src/components/process-control.css', import.meta.url).href;
const hooks = registerHooks({ load(url, context, nextLoad) {
    return url === cssUrl ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context);
} });
const { act, createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ProcessControlPanel } = await import('../../public/manager/src/components/ProcessControlPanel');
after(() => {
    hooks.deregister();
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

function snapshot(port: number | null = 3457): DashboardProcessControlState {
    return {
        managed: port === null ? [] : [{ port, pid: 1234, home: null, proof: 'child', canStop: true, canForceRelease: false, reason: 'dashboard-owned' }],
        unsupported: { dashboardService: true, forceRelease: true, reason: 'Unavailable' },
    };
}

async function mount(t: TestContext, strict = false) {
    const requests: { path: string; method: string; response: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
    t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => {
        const response = Promise.withResolvers<Response>();
        requests.push({ path: input, method: init?.method ?? 'GET', response });
        return response.promise;
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    const unmount = async () => {
        if (!mounted) return;
        await act(async () => root.unmount());
        mounted = false;
        container.remove();
    };
    t.after(unmount);
    await act(async () => root.render(strict
        ? createElement(StrictMode, null, createElement(ProcessControlPanel))
        : createElement(ProcessControlPanel)));
    function button(label: string) {
        const result = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label);
        assert.ok(result, `Missing button: ${label}`);
        return result;
    }
    const settle = async (index: number, state = snapshot(), status = 200) => {
        await act(async () => { requests[index]!.response.resolve(new Response(JSON.stringify({ ok: status === 200, state }), { status })); });
    };
    return { container, requests, button, settle, unmount };
}

test('initial loading never claims an empty list; refresh failure is announced and retry clears it', async t => {
    const view = await mount(t);
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /Loading/);
    assert.doesNotMatch(view.container.textContent!, /No managed servers|0 managed servers/);
    assert.ok(view.button('Refreshing…').disabled);
    assert.ok(view.button('Adopt/recover').disabled);
    await view.settle(0, snapshot(), 503);
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /503/);
    assert.doesNotMatch(view.container.textContent!, /No managed servers/);
    await act(async () => view.button('Refresh').click());
    await view.settle(1, snapshot(null));
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent!, /0 managed servers/);
    assert.match(view.container.textContent!, /No managed servers/);
});

test('global scope, readable proof rows and maintenance disclosure preserve action intent', async t => {
    const view = await mount(t);
    const state = snapshot();
    state.managed.push({ ...state.managed[0]!, port: 4567, pid: null, proof: 'registry' });
    await view.settle(0, state);
    assert.match(view.container.querySelector('section')!.getAttribute('aria-label')!, /all instances/);
    assert.deepEqual(Array.from(view.container.querySelectorAll('thead th')).map(el => el.textContent), ['Port', 'PID', 'Ownership proof']);
    assert.match(view.container.querySelector('tbody')!.textContent!, /:34571234Child process/);
    assert.match(view.container.querySelector('tbody')!.textContent!, /:4567UnavailableRegistry record/);
    const disclosure = view.container.querySelector('details')!;
    assert.equal(disclosure.open, false);
    assert.equal(disclosure.querySelector('summary')!.textContent, 'Recovery & stop all');
    assert.ok(disclosure.contains(view.button('Stop all managed')));
    assert.ok(disclosure.contains(view.button('Adopt/recover')));
    assert.doesNotMatch(view.container.textContent!, /Force release port/);
});

test('same-tick actions and refresh cannot overlap; a failed mutation retains explicitly stale rows', async t => {
    const view = await mount(t);
    await view.settle(0);
    const refresh = view.button('Refresh');
    const recover = view.button('Adopt/recover');
    await act(async () => { recover.click(); recover.click(); refresh.click(); });
    assert.equal(view.requests.length, 2);
    assert.equal(view.requests[1]!.path, '/api/dashboard/process-control/adopt');
    assert.equal(view.requests[1]!.method, 'POST');
    assert.ok(view.button('Refresh').disabled);
    assert.ok(view.button('Stop all managed').disabled);
    await view.settle(1, snapshot(), 500);
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /500/);
    assert.match(view.container.textContent!, /Last loaded list/);
    assert.match(view.container.querySelector('tbody')!.textContent!, /:3457/);
    assert.ok(view.button('Stop all managed').disabled);
    await act(async () => view.button('Refresh').click());
    await view.settle(2, snapshot(4567));
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(view.container.textContent!, /Last loaded list/);
    assert.equal(view.button('Stop all managed').disabled, false);
});

test('stop all still requires confirmation, posts once, and renders the returned remaining list', async t => {
    const view = await mount(t);
    await view.settle(0);
    let accepted = false;
    const confirm = t.mock.method(dom.window, 'confirm', (message: string) => {
        assert.match(message, /1 dashboard-managed server across all instances/);
        return accepted;
    });
    await act(async () => view.button('Stop all managed').click());
    assert.equal(view.requests.length, 1);
    accepted = true;
    const stop = view.button('Stop all managed');
    await act(async () => { stop.click(); stop.click(); });
    assert.equal(confirm.mock.callCount(), 2);
    assert.equal(view.requests.length, 2);
    assert.equal(view.requests[1]!.path, '/api/dashboard/process-control/stop-managed');
    assert.equal(view.requests[1]!.method, 'POST');
    assert.ok(view.button('Stopping…').disabled);
    await view.settle(1, snapshot(null));
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /Stop request complete/);
    assert.match(view.container.textContent!, /0 managed servers/);
    assert.ok(view.button('Stop all managed').disabled);
});

test('effect replacement ignores an older response and unmount ignores pending settlement', async t => {
    const view = await mount(t, true);
    assert.equal(view.requests.length, 2);
    await view.settle(1, snapshot(4567));
    await view.settle(0, snapshot(3457));
    assert.match(view.container.querySelector('tbody')!.textContent!, /:4567/);
    assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /:3457/);
    await act(async () => view.button('Adopt/recover').click());
    await view.unmount();
    await view.settle(2, snapshot(), 500);
    assert.equal(view.container.childElementCount, 0);
});
