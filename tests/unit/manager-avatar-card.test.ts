import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import { createSettingsClient } from '../../public/manager/src/settings/settings-client';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:43225/' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AvatarCard } = await import('../../public/manager/src/settings/pages/components/AvatarCard');
const { default: Profile } = await import('../../public/manager/src/settings/pages/Profile');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
const kinds = ['agent', 'user'] as const;
type Kind = typeof kinds[number];
const modes = [
    { name: 'direct worker', options: { base: '' }, prefix: '' },
    { name: 'manager proxy', options: {}, prefix: '/i/43225' },
    { name: 'proxied standalone', options: { base: '/i/43226' }, prefix: '/i/43226' },
];
const emoji = (target: Kind) => ({ target, kind: 'emoji', updatedAt: null });
const image = (target: Kind, version = 17) => ({ target, kind: 'image',
    imageUrl: `/api/avatar/${target}/image?v=${version}`, updatedAt: version });
const metadata = (images = false) => ({ agent: images ? image('agent') : emoji('agent'),
    user: images ? image('user') : emoji('user') });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' },
});
async function mount(t: TestContext, element: ReactElement) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    const render = async (next: ReactElement) => { await act(async () => root.render(next)); };
    await render(element);
    return { container, render };
}
function card(container: Element, kind: Kind) {
    const label = kind === 'agent' ? 'Agent avatar preview' : 'User avatar preview';
    const node = container.querySelector(`[aria-label="${label}"]`)?.closest('.settings-avatar-card');
    assert.ok(node, `${kind} card must render`); return node;
}
function currentImage(node: Element) { return node.querySelector<HTMLImageElement>('img[alt$="current"]'); }
async function upload(node: Element, file: File) {
    const input = node.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
    // JSDOM has no native file chooser; provide the same File exposed by a browser selection.
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    assert.equal(input.value, '', 'selection resets after upload');
}
async function clear(node: Element) {
    const button = Array.from(node.querySelectorAll<HTMLButtonElement>('button')).find(el => el.textContent === 'Clear');
    assert.ok(button); await act(async () => button.click());
}

for (const mode of modes) for (const wrapped of [true, false]) {
    test(`Profile avatar read/upload/clear uses ${mode.name}, wrapped=${wrapped}`, bounded, async t => {
        const pack = (data: unknown) => wrapped ? { ok: true, data } : data;
        const calls: Array<{ url: string; method: string; init: RequestInit | undefined }> = [];
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input), method = init?.method ?? 'GET'; calls.push({ url, method, init });
            if (url === `${mode.prefix}/api/settings`) return json({ locale: 'ko', showReasoning: false });
            if (url === `${mode.prefix}/api/avatar`) return json(pack(metadata()));
            for (const kind of kinds) {
                if (url === `${mode.prefix}/api/avatar/${kind}/upload` && method === 'POST') return json(pack(image(kind)));
                if (url === `${mode.prefix}/api/avatar/${kind}/image` && method === 'DELETE') return json(pack(emoji(kind)));
            }
            return new Response('Unexpected avatar route', { status: 404 });
        });
        const client = createSettingsClient(43225, { ...mode.options,
            getHeaders: async () => ({ authorization: 'Bearer fixture-avatar-auth' }) });
        const dirty = createDirtyStore();
        const h = await mount(t, createElement(Profile, { port: 43225, instanceUrl: mode.prefix, client, dirty }));
        assert.equal(h.container.querySelector('[role="alert"]')?.textContent ?? null, null);
        assert.equal(calls.filter(c => c.url === `${mode.prefix}/api/avatar`).length, 2);
        assert.ok(card(h.container, 'agent').querySelector('img[src="/icons/mascot.png"]'));
        assert.ok(card(h.container, 'user').querySelector('.settings-avatar-placeholder'));
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 10]);
        for (const kind of kinds) {
            const node = card(h.container, kind);
            assert.equal(currentImage(node), null);
            const file = new File([bytes], `${kind} 그림.png`, { type: 'image/png' });
            await upload(node, file);
            assert.equal(h.container.querySelector('[role="alert"]')?.textContent ?? null, null);
            assert.equal(currentImage(node)?.getAttribute('src'), `${mode.prefix}/api/avatar/${kind}/image?v=17`);
            const sent = calls.find(c => c.url === `${mode.prefix}/api/avatar/${kind}/upload`); assert.ok(sent);
            assert.equal(sent.method, 'POST'); assert.ok(sent.init?.body instanceof ArrayBuffer);
            assert.deepEqual(new Uint8Array(sent.init.body), bytes);
            const headers = new Headers(sent.init.headers);
            assert.equal(headers.get('content-type'), 'image/png');
            assert.equal(headers.get('x-filename'), encodeURIComponent(file.name));
            await clear(node);
            assert.equal(currentImage(node), null);
            assert.equal(node.querySelector('[role="alert"]')?.textContent ?? null, null);
        }
        for (const call of calls) assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer fixture-avatar-auth');
        assert.deepEqual(calls.map(c => [c.method, c.url]), [
            ['GET', `${mode.prefix}/api/settings`], ['GET', `${mode.prefix}/api/avatar`], ['GET', `${mode.prefix}/api/avatar`],
            ['POST', `${mode.prefix}/api/avatar/agent/upload`], ['DELETE', `${mode.prefix}/api/avatar/agent/image`],
            ['POST', `${mode.prefix}/api/avatar/user/upload`], ['DELETE', `${mode.prefix}/api/avatar/user/image`],
        ]);
        assert.equal(dirty.isDirty(), false, 'avatar writes remain atomic rather than page drafts');
    });
}

for (const mode of modes) test(`existing image metadata preserves versioned URLs in ${mode.name}`, bounded, async t => {
    t.mock.method(globalThis, 'fetch', async () => json({ ok: true, data: metadata(true) }));
    const client = createSettingsClient(43225, mode.options);
    const h = await mount(t, createElement('div', null, ...kinds.map(kind => createElement(AvatarCard, { kind, client, key: kind }))));
    for (const kind of kinds) assert.equal(currentImage(card(h.container, kind))?.getAttribute('src'),
        `${mode.prefix}/api/avatar/${kind}/image?v=17`);
});

for (const status of [401, 404, 500]) for (const operation of ['GET', 'POST', 'DELETE']) {
    test(`real ${status} ${operation} avatar error remains visible`, bounded, async t => {
        const calls: string[] = [];
        t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? 'GET'; calls.push(method);
            return method === operation ? new Response('fixture avatar failure', { status }) : json({ ok: true, data: metadata(true) });
        });
        const client = createSettingsClient(43225, { base: '' });
        const h = await mount(t, createElement(AvatarCard, { kind: 'user', client }));
        if (operation === 'POST') await upload(h.container, new File(['fixture'], 'avatar.png', { type: 'image/png' }));
        if (operation === 'DELETE') await clear(h.container);
        const alert = h.container.querySelector('[role="alert"]')?.textContent ?? '';
        assert.ok(alert.includes(String(status)), alert); assert.match(alert, /fixture avatar failure/);
        assert.deepEqual(calls, operation === 'GET' ? ['GET'] : ['GET', operation]);
        if (operation !== 'GET') assert.ok(currentImage(h.container), 'failed mutation retains previous image');
        assert.ok(Array.from(h.container.querySelectorAll<HTMLButtonElement>('button')).every(button => !button.disabled));
    });
}

test('HTML fallback response is reported instead of accepted as empty avatar metadata', bounded, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>wrong route</html>', { headers: { 'content-type': 'text/html' } }));
    const h = await mount(t, createElement(AvatarCard, { kind: 'agent', client: createSettingsClient(43225, { base: '' }) }));
    assert.match(h.container.querySelector('[role="alert"]')?.textContent ?? '', /expected JSON/);
});

for (const stale of ['success', 'failure']) test(`changing client reloads metadata and ignores stale ${stale}`, bounded, async t => {
    const first = Promise.withResolvers<Response>(), calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        calls.push(String(input));
        return String(input) === '/api/avatar' ? first.promise : json({ ok: true, data: metadata(true) });
    });
    const direct = createSettingsClient(43225, { base: '' }), proxy = createSettingsClient(43225);
    const h = await mount(t, createElement(AvatarCard, { kind: 'user', client: direct }));
    t.after(() => first.resolve(json(metadata())));
    await h.render(createElement(AvatarCard, { kind: 'user', client: proxy }));
    assert.deepEqual(calls, ['/api/avatar', '/i/43225/api/avatar']);
    assert.equal(currentImage(h.container)?.getAttribute('src'), '/i/43225/api/avatar/user/image?v=17');
    await act(async () => first.resolve(stale === 'success' ? json(metadata()) : new Response('old failure', { status: 500 })));
    assert.equal(currentImage(h.container)?.getAttribute('src'), '/i/43225/api/avatar/user/image?v=17');
    assert.equal(h.container.querySelector('[role="alert"]')?.textContent ?? null, null);
});

for (const mode of modes) test(`client preserves raw Blob identity and merged headers in ${mode.name}`, bounded, async t => {
    const body = new Blob([new Uint8Array([0, 255, 128])], { type: 'image/webp' });
    let sent: RequestInit | undefined;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), `${mode.prefix}/api/avatar/agent/upload`); sent = init; return json(image('agent'));
    });
    const client = createSettingsClient(43225, { ...mode.options, getHeaders: async () => ({ authorization: 'Bearer fixture-blob-auth' }) });
    await client.post('/api/avatar/agent/upload', undefined, { body, headers: { 'content-type': 'image/webp', 'x-filename': 'blob.webp' } });
    assert.equal(sent?.body, body); assert.equal(sent?.method, 'POST');
    const headers = new Headers(sent?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-blob-auth');
    assert.equal(headers.get('content-type'), 'image/webp'); assert.equal(headers.get('x-filename'), 'blob.webp');
});

test('avatar metadata retains the standard request timeout', bounded, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let requestSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener('abort', () => reject(new DOMException('Fixture request aborted', 'AbortError')), { once: true });
        });
    });
    const h = await mount(t, createElement(AvatarCard, { kind: 'agent', client: createSettingsClient(43225, { base: '' }) }));
    assert.equal(requestSignal?.aborted, false);
    await act(async () => t.mock.timers.tick(8000));
    assert.equal(requestSignal?.aborted, true);
    assert.match(h.container.querySelector('[role="alert"]')?.textContent ?? '', /Fixture request aborted/);
});

test('slow raw avatar upload is not aborted by the settings metadata timeout', bounded, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const response = Promise.withResolvers<Response>();
    let uploadSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== 'POST') return json(metadata());
        uploadSignal = init.signal;
        uploadSignal?.addEventListener('abort', () => response.reject(new DOMException('Fixture upload aborted', 'AbortError')), { once: true });
        return response.promise;
    });
    const h = await mount(t, createElement(AvatarCard, { kind: 'agent', client: createSettingsClient(43225, { base: '' }) }));
    t.after(() => response.resolve(json(image('agent'))));
    await upload(h.container, new File(['fixture'], 'avatar.png', { type: 'image/png' }));
    assert.ok(uploadSignal); assert.equal(uploadSignal.aborted, false);
    await act(async () => t.mock.timers.tick(8000));
    assert.equal(uploadSignal.aborted, false, 'metadata timeout must not abort the admitted raw upload');
    assert.equal(h.container.querySelector('[role="alert"]')?.textContent ?? null, null);
    assert.equal(h.container.querySelector<HTMLButtonElement>('button')?.disabled, true);
    await act(async () => response.resolve(json(image('agent'))));
    assert.equal(currentImage(h.container)?.getAttribute('src'), '/api/avatar/agent/image?v=17');
    assert.equal(h.container.querySelector<HTMLButtonElement>('button')?.disabled, false);
});
