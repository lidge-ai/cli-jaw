import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import type { SettingsClient, SaveHandler } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Agent } = await import('../../public/manager/src/settings/pages/Agent');
const { default: Permissions } = await import('../../public/manager/src/settings/pages/Permissions');
const { PermissionQuickSection } = await import('../../public/manager/src/settings/pages/components/agent/PermissionQuickSection');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
const seed = ['bash', 'read', 'write', 'edit', 'mcp.*'];
async function surface(t: TestContext) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network'); });
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, render: async (node: ReactNode) => { await act(async () => root.render(node)); } };
}
function fixture(value: unknown, pending = false) {
    let snapshot: Record<string, unknown> = { cli: 'claude', workingDir: '/fixture', permissions: value,
        perCli: { claude: { model: 'fixture-model', effort: 'low' } } };
    let failure = false;
    const gate = Promise.withResolvers<void>(); if (!pending) gate.resolve();
    const writes: Array<{ path: string; body: unknown }> = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get<T>(path: string) {
            if (path === '/api/settings') { await gate.promise; return structuredClone(snapshot) as T; }
            if (path === '/api/cli-registry') return { claude: { label: 'Claude', models: ['fixture-model'], efforts: ['low'] } } as T;
            if (path === '/api/cli-status') return { claude: { available: true, capabilityReady: true,
                checkedCapability: 'fixture', probeState: 'fresh' } } as T;
            if (path === '/api/memory-files') return {} as T;
            if (path === '/api/employees') return [] as T;
            throw Error('Unexpected GET ' + path);
        },
        async put<T>(path: string, body: unknown) {
            assert.equal(path, '/api/settings'); writes.push({ path, body: structuredClone(body) });
            if (failure) throw Error('fixture save failed');
            snapshot = { ...snapshot, ...body as Record<string, unknown> };
            return { ok: true, data: structuredClone(snapshot) } as T;
        },
        async post() { throw Error('Unexpected POST'); }, async delete() { throw Error('Unexpected DELETE'); },
    };
    return { client, writes, gate, fail: () => { failure = true; }, snapshot: () => snapshot };
}
async function page(t: TestContext, kind: 'agent' | 'detail', value: unknown, pending = false) {
    const view = await surface(t), api = fixture(value, pending), dirty = createDirtyStore();
    let save: SaveHandler | null = null;
    const render = () => view.render(createElement(kind === 'agent' ? Agent : Permissions, {
        port: 43225, instanceUrl: '/i/43225', client: api.client, dirty, registerSave: next => { save = next; },
    }));
    t.after(async () => { await act(async () => api.gate.resolve()); });
    await render();
    const label = () => kind === 'agent'
        ? view.container.querySelector('#agent-configured-policy')?.textContent
        : view.container.querySelector('.settings-readonly-line')?.textContent;
    return { ...view, api, dirty, render, label,
        save: async () => { assert.ok(save); await act(async () => { await save!(); }); },
        modeId: kind === 'agent' ? 'agent-permissions-mode' : 'permissions-mode' };
}
async function choose(container: HTMLElement, id: string, prefix: string) {
    const trigger = container.querySelector<HTMLButtonElement>('#' + id); assert.ok(trigger);
    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('#' + id + '-listbox [role="option"]')];
    // Safe joined Auto/Custom: it is a real stored policy and hiding it from the editor is what
    // let a Safe instance be silently widened to Auto.
    assert.equal(options.length, 3, 'Auto/Safe/Custom are the editor options');
    const option = options.find(el => el.querySelector('span')?.textContent?.startsWith(prefix)); assert.ok(option);
    await act(async () => option.click());
}

test('mounted Agent shows configured Safe as Safe in the editor, with no writes on load or rerender', bounded, async t => {
    const h = await page(t, 'agent', 'safe');
    assert.equal(h.label(), 'Configured policy: Safe');
    // The editor used to render Safe as "Auto (YOLO)". A user who then touched this control
    // could not see the permission they were about to widen, and any save carried 'auto'.
    assert.equal(h.container.querySelector('#agent-permissions-mode .settings-select-value')?.textContent, 'Safe');
    assert.match(h.container.querySelector('#agent-permissions-mode')?.getAttribute('aria-label') ?? '', /^Change policy to:/);
    await h.render(); await h.save();
    assert.deepEqual(h.api.writes, []); assert.equal(h.dirty.pending.has('permissions'), false);
    assert.equal(h.api.snapshot().permissions, 'safe');
});

test('a Safe instance is never widened to Auto by an unrelated Agent save', bounded, async t => {
    // Two distinct paths, both verified here. An UNTOUCHED control contributes nothing to the
    // bundle, so an unrelated save cannot carry permissions — that half held even before the
    // fix. The real downgrade needed the user to TOUCH the selector while it displayed
    // "Auto (YOLO)" for a Safe instance: they could not see what they were widening, and
    // re-selecting the value shown wrote 'auto'. That is the half the fix closes, and it is
    // asserted below rather than implied.
    const h = await page(t, 'agent', 'safe');
    const input = [...h.container.querySelectorAll<HTMLInputElement>('input')].find(el => el.value === '/fixture'); assert.ok(input);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '/elsewhere');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(h.dirty.pending.has('permissions'), false,
        'an untouched permissions control must contribute nothing to the save bundle');
    await h.save();
    for (const write of h.api.writes) {
        const body = (write as { body?: Record<string, unknown> }).body ?? {};
        assert.equal('permissions' in body, false, 'an unrelated save must not carry permissions');
    }
    assert.equal(h.api.snapshot().permissions, 'safe');

    // Now the path that actually lost the policy: re-select whatever the editor is showing.
    // With the editor telling the truth, that is Safe, so it stays Safe.
    const shown = h.container.querySelector('#agent-permissions-mode .settings-select-value')?.textContent;
    assert.equal(shown, 'Safe', 'the editor must not display a Safe instance as Auto (YOLO)');
    await choose(h.container, h.modeId, shown!.startsWith('Auto') ? 'Auto' : 'Safe');
    await h.save();
    assert.equal(h.api.snapshot().permissions, 'safe',
        're-selecting the displayed policy must never widen it');
});

test('Safe is reachable from the Agent editor, not only readable', bounded, async t => {
    const h = await page(t, 'agent', 'auto');
    await choose(h.container, h.modeId, 'Safe');
    assert.deepEqual(h.dirty.saveBundle(), { permissions: 'safe' });
    await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { permissions: 'safe' } }]);
    assert.equal(h.label(), 'Configured policy: Safe');
});

test('mounted Agent unrelated workingDir save retains configured Safe and excludes permissions', bounded, async t => {
    const h = await page(t, 'agent', 'safe');
    const input = [...h.container.querySelectorAll<HTMLInputElement>('input')].find(el => el.value === '/fixture'); assert.ok(input);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '/changed');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { workingDir: '/changed' } }]);
    assert.equal(h.label(), 'Configured policy: Safe'); assert.equal(h.api.snapshot().permissions, 'safe');
});

for (const mode of ['Auto', 'Custom']) test(`mounted Agent explicit ${mode} preserves exact payload; readout follows only saved snapshot`, bounded, async t => {
    const h = await page(t, 'agent', 'safe'); await choose(h.container, h.modeId, mode);
    const expected = mode === 'Auto' ? 'auto' : seed;
    assert.deepEqual(h.dirty.saveBundle(), { permissions: expected });
    assert.equal(h.label(), 'Configured policy: Safe'); assert.deepEqual(h.api.writes, []);
    await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { permissions: expected } }]);
    assert.equal(h.label(), mode === 'Auto' ? 'Configured policy: Auto (YOLO)' : 'Configured policy: Custom (5 entries)');
});

test('detailed Permissions shows Safe as Safe and treats widening it as a real write', bounded, async t => {
    // This used to be a NOOP: Safe parsed as 'unknown', the editor rendered it as Auto, and
    // originalSerialized reported 'auto' — so picking Auto matched the "original" and wrote
    // nothing, while the readout kept claiming Safe. Both halves of that were wrong. Safe is a
    // real policy, so widening it is a real change the user must be able to see and save.
    const h = await page(t, 'detail', 'safe');
    assert.equal(h.label(), 'Configured policy: Safe');
    assert.equal(h.container.querySelector('#permissions-mode .settings-select-value')?.textContent, 'Safe');
    assert.match(h.container.querySelector('#permissions-mode')?.getAttribute('aria-label') ?? '', /^Change policy to:/);
    assert.equal((h.container.textContent ?? '').includes('Use Agent to change this configured policy.'), false,
        'Safe is editable here now, so the redirect to Agent no longer applies');
    await choose(h.container, h.modeId, 'Auto');
    assert.deepEqual(h.dirty.saveBundle(), { permissions: 'auto' });
    await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { permissions: 'auto' } }]);
    assert.equal(h.label(), 'Configured policy: Auto (YOLO)');
});

test('detailed Permissions can set Safe from Auto', bounded, async t => {
    const h = await page(t, 'detail', 'auto');
    await choose(h.container, h.modeId, 'Safe');
    assert.deepEqual(h.dirty.saveBundle(), { permissions: 'safe' });
    await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { permissions: 'safe' } }]);
    assert.equal(h.label(), 'Configured policy: Safe');
});

test('detailed known Custom keeps its payload and never shows unknown-shape guidance', bounded, async t => {
    const h = await page(t, 'detail', ['read']);
    assert.equal(h.label(), 'Configured policy: Custom (1 entry)');
    assert.doesNotMatch(h.container.textContent ?? '', /Use Agent to change/);
    await choose(h.container, h.modeId, 'Auto'); await h.save();
    assert.deepEqual(h.api.writes, [{ path: '/api/settings', body: { permissions: 'auto' } }]);
    assert.equal(h.label(), 'Configured policy: Auto (YOLO)');
});

test('detailed empty Custom stays invalid for save while its configured count remains truthful', bounded, async t => {
    const h = await page(t, 'detail', ['read']);
    const remove = h.container.querySelector<HTMLButtonElement>('[aria-label="Remove read"]'); assert.ok(remove);
    await act(async () => remove.click());
    assert.equal(h.dirty.pending.get('permissions')?.valid, false);
    await h.save(); assert.deepEqual(h.api.writes, []);
    assert.equal(h.label(), 'Configured policy: Custom (1 entry)');
});

test('failed explicit Agent save preserves configured snapshot and existing dirty intent without retry', bounded, async t => {
    const h = await page(t, 'agent', 'safe'); await choose(h.container, h.modeId, 'Custom'); h.api.fail();
    await assert.rejects(h.save(), /fixture save failed/);
    assert.equal(h.label(), 'Configured policy: Safe'); assert.deepEqual(h.dirty.saveBundle(), { permissions: seed });
    assert.equal(h.api.writes.length, 1);
});

for (const kind of ['agent', 'detail'] as const) test(`${kind} delayed snapshot keeps loading owner then renders absent policy without writes`, bounded, async t => {
    const h = await page(t, kind, undefined, true);
    assert.ok(h.container.querySelector('.settings-loading')); assert.equal(h.label(), undefined);
    await act(async () => h.api.gate.resolve());
    assert.equal(h.label(), 'Configured policy: Not provided');
    assert.deepEqual(h.api.writes, []);
});

test('standalone QuickSection fixed readout matrix never normalizes policy or invokes editor on rerender', bounded, async t => {
    const h = await surface(t), changes: unknown[] = [];
    const cases: Array<[unknown, string]> = [['auto', 'Auto (YOLO)'], ['safe', 'Safe'], [[], 'Custom (0 entries)'],
        [['auto'], 'Custom (1 entry)'], [[' read ', ''], 'Custom (2 entries)'], [null, 'Not provided'],
        [undefined, 'Not provided'], ['AUTO', 'Unrecognized'], ['<img src=x onerror=alert(1)>', 'Unrecognized'],
        [{ secret: 'DO_NOT_RENDER' }, 'Unrecognized'], [['read', 1], 'Unrecognized']];
    for (const [configuredValue, expected] of cases) {
        const before = structuredClone(configuredValue);
        const props = { value: 'auto', configuredValue, onChange: (next: unknown) => { changes.push(next); } };
        await h.render(createElement(PermissionQuickSection, props));
        assert.equal(h.container.querySelector('#agent-configured-policy')?.textContent, 'Configured policy: ' + expected);
        assert.deepEqual(configuredValue, before); assert.deepEqual(changes, []);
        assert.equal(h.container.querySelector('img'), null);
        assert.doesNotMatch(h.container.textContent ?? '', /DO_NOT_RENDER|onerror/);
    }
    await choose(h.container, 'agent-permissions-mode', 'Custom'); assert.deepEqual(changes, [seed]);
});
