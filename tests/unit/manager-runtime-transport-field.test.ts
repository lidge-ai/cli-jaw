import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import type { CliMeta, PerCliEntry } from '../../public/manager/src/settings/pages/components/agent/agent-meta';
import type { DirtyEntry, SettingsClient } from '../../public/manager/src/settings/types';
import type { PiSettingsView } from '../../public/manager/src/settings/pages/components/pi-profile';
// Server policy is an independent test oracle, never a browser dependency.
import { SWITCHABLE_NATIVE_CLIS, runtimeSelectionStatus } from '../../src/agent/runtime/selection';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PerCliRow } = await import('../../public/manager/src/settings/pages/components/PerCliRow');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

const eligible = ['cursor', 'grok', 'claude'];
const nativeLabel = 'Native session (opt-in)';
const printLabel = 'Print compatibility';
const meta: CliMeta = { label: 'Test CLI', models: ['saved-model'], efforts: ['low', 'high'] };

async function mountRow(t: TestContext, cli = 'cursor', transport: unknown = undefined) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const dirty = createDirtyStore();
    const entries: Array<{ key: string; entry: DirtyEntry }> = [];
    const values: PerCliEntry[] = [];
    const http: string[] = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get() { http.push('GET'); throw new Error('Unexpected HTTP'); },
        async put() { http.push('PUT'); throw new Error('Unexpected HTTP'); },
        async post() { http.push('POST'); throw new Error('Unexpected HTTP'); },
        async delete() { http.push('DELETE'); throw new Error('Unexpected HTTP'); },
    };
    // The server input boundary may contain a future/invalid value despite the typed model.
    const original = Object.freeze({ model: 'saved-model', effort: 'low', provider: 'saved-provider',
        fastMode: false, ...(transport === undefined ? {} : { transport }) }) as PerCliEntry;
    let props = {
        cli, meta, original, value: original, dirty, disabled: false, client, pi: undefined as PiSettingsView | undefined,
        setValue: (next: PerCliEntry) => { values.push(next); },
        setEntry: (key: string, entry: DirtyEntry) => { entries.push({ key, entry }); dirty.set(key, entry); },
    };
    const render = async (next: Partial<typeof props> = {}) => {
        props = { ...props, ...next };
        await act(async () => { root.render(createElement(PerCliRow, props)); });
    };
    t.after(async () => { await act(async () => { root.unmount(); }); container.remove(); });
    await render();
    const control = (name = 'Runtime transport') => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')]
            .find(node => node.getAttribute('aria-label')?.startsWith(`${name}:`));
        assert.ok(button, `missing mounted ${name} SelectField`);
        return button;
    };
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const choose = async (label: string, name = 'Runtime transport') => {
        await act(async () => { control(name).click(); });
        const option = options().find(node => node.querySelector('span')?.textContent === label);
        assert.ok(option, `missing ${label} option`);
        await act(async () => { option.click(); });
    };
    return { container, dirty, entries, values, http, original, render, control, options, choose };
}

for (const cli of eligible) {
    test(`${cli}: absent transport is print, native is first opt-in, exact patch and reversal`, async t => {
        const view = await mountRow(t, cli);
        assert.equal(view.control().textContent, printLabel);
        assert.deepEqual(view.dirty.saveBundle(), {});
        await act(async () => { view.control().click(); });
        assert.deepEqual(view.options().map(node => node.querySelector('span')?.textContent), [nativeLabel, printLabel]);
        await act(async () => { view.options()[0]!.click(); });
        assert.equal(view.control().textContent, nativeLabel);
        assert.deepEqual(view.entries, [{ key: `perCli.${cli}.transport`, entry: { value: 'native', original: 'print', valid: true } }]);
        assert.deepEqual(expandPatch(view.dirty.saveBundle()), { perCli: { [cli]: { transport: 'native' } } });
        assert.deepEqual(view.values, []); assert.deepEqual(view.http, []);
        assert.deepEqual(view.original, { model: 'saved-model', effort: 'low', provider: 'saved-provider', fastMode: false });
        await view.choose(printLabel);
        assert.deepEqual(expandPatch(view.dirty.saveBundle()), {});
    });

    test(`${cli}: persisted native and print render honestly and discard restores original`, async t => {
        const view = await mountRow(t, cli, 'native');
        assert.equal(view.control().textContent, nativeLabel);
        assert.equal(view.dirty.isDirty(), false);
        assert.match(view.container.textContent!, /next run/i);
        assert.match(view.container.textContent!, /presentation/i);
        assert.doesNotMatch(view.container.textContent!, /verified ready|readiness verified/i);
        if (cli === 'claude') assert.match(view.container.textContent!, /Auto \(YOLO\).*Safe/);
        else {
            assert.match(view.container.textContent!, /requires Auto \(YOLO\) permissions/);
            assert.match(view.container.textContent!, /no native worker|native workers.*not supported/i);
        }
        await view.choose(printLabel);
        assert.deepEqual(expandPatch(view.dirty.saveBundle()), { perCli: { [cli]: { transport: 'print' } } });
        await act(async () => { view.dirty.clear(); });
        assert.equal(view.control().textContent, nativeLabel);
        await view.render({ original: { ...view.original, transport: 'print' } });
        assert.equal(view.control().textContent, printLabel);
    });
}

test('literal three-provider UI policy matches independent server selection policy', async t => {
    assert.deepEqual([...SWITCHABLE_NATIVE_CLIS].sort(), ['claude', 'cursor', 'grok']);
    const offered: string[] = [];
    for (const cli of [...eligible, 'codex-app', 'pi', 'codex', 'jwc', 'agy', 'gemini', 'opencode', 'copilot', 'kiro-code', 'Cursor', 'cursor.extra', '__proto__']) {
        const view = await mountRow(t, cli);
        const visible = Boolean(view.container.querySelector('[aria-label^="Runtime transport:"]'));
        if (visible) offered.push(cli);
        const switchable = runtimeSelectionStatus(cli, 'print').transport !== runtimeSelectionStatus(cli, 'native').transport;
        assert.equal(visible, switchable, cli);
        assert.deepEqual(view.dirty.saveBundle(), {});
    }
    assert.deepEqual(offered.sort(), ['claude', 'cursor', 'grok']);
});

for (const unknown of ['future-secret-value'.repeat(100), '', null, 0, { future: true }]) {
    test(`unknown ${typeof unknown} (${String(unknown).length}) is generic, invalid and never serialized`, async t => {
        const view = await mountRow(t, 'cursor', unknown);
        assert.equal(view.control().textContent, 'Unrecognized transport');
        assert.equal(view.control().getAttribute('aria-invalid'), 'true');
        assert.ok(view.container.querySelector('[role="alert"]'));
        assert.deepEqual(view.dirty.saveBundle(), {});
        await view.choose('Unrecognized transport');
        assert.deepEqual(view.entries, [], 'UI-only sentinel cannot reach the parent setter');
        await view.choose(nativeLabel);
        assert.equal(view.control().getAttribute('aria-invalid'), 'false');
        assert.equal(view.entries[0]?.entry.original, unknown);
        assert.deepEqual(expandPatch(view.dirty.saveBundle()), { perCli: { cursor: { transport: 'native' } } });
        await act(async () => { view.dirty.clear(); });
        assert.equal(view.control().textContent, 'Unrecognized transport');
    });
}

test('only the own dirty entry overrides server original; stale model draft never owns transport', async t => {
    const view = await mountRow(t);
    await view.render({ value: { ...view.original, transport: 'native' } });
    assert.equal(view.control().textContent, printLabel);
    await act(async () => { view.dirty.set('perCli.grok.transport', { value: 'native', original: 'print', valid: true }); });
    assert.equal(view.control().textContent, printLabel);
    await view.choose(nativeLabel);
    await view.render({ original: { ...view.original, transport: 'print' }, value: { ...view.original, transport: 'print' } });
    assert.equal(view.control().textContent, nativeLabel);
    await act(async () => { view.dirty.remove('perCli.cursor.transport'); });
    assert.equal(view.control().textContent, printLabel);
    assert.deepEqual(view.dirty.saveBundle(), { 'perCli.grok.transport': 'native' });
});

test('disabled trigger and already-open transport option cannot mutate; re-enable works', async t => {
    const view = await mountRow(t);
    await act(async () => { view.control().click(); });
    const option = view.options()[0]!;
    await view.render({ disabled: true });
    assert.equal(view.control().disabled, true);
    await act(async () => { option.click(); });
    assert.deepEqual(view.entries, []); assert.deepEqual(view.values, []);
    assert.deepEqual(view.dirty.saveBundle(), {}); assert.deepEqual(view.http, []);
    await view.render({ disabled: false });
    await view.choose(nativeLabel);
    assert.equal(view.control().textContent, nativeLabel);
});

test('row disables model/effort/fast controls and guards an already-open effort option', async t => {
    const view = await mountRow(t);
    await act(async () => { view.control('Effort').click(); });
    const option = view.options().find(node => node.querySelector('span')?.textContent === 'high')!;
    assert.ok(option);
    await view.render({ disabled: true });
    assert.ok([...view.container.querySelectorAll<HTMLInputElement>('input')].every(node => node.disabled));
    assert.ok([...view.container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].every(node => node.disabled));
    await act(async () => { option.click(); });
    assert.deepEqual(view.entries, []); assert.deepEqual(view.values, []);
    await view.render({ disabled: false });
    await view.choose('high', 'Effort');
    assert.deepEqual(view.dirty.saveBundle(), { 'perCli.cursor.effort': 'high' });
});

test('temporary row disable keeps an existing Pi dialog and its unsubmitted draft', async t => {
    const view = await mountRow(t, 'pi');
    const settings = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Settings')!;
    await act(async () => { settings.click(); });
    const dialog = view.container.querySelector('[role="dialog"]'); assert.ok(dialog);
    await view.choose('anthropic', 'Mode');
    await view.render({ disabled: true });
    assert.equal(view.container.querySelector('[role="dialog"]'), dialog, 'save must not discard an unrelated dialog draft');
    assert.ok(dialog.closest('[inert]'));
    await view.render({ disabled: false });
    assert.equal(view.control('Mode').querySelector('.settings-select-value')?.textContent, 'anthropic');
    assert.deepEqual(view.http, []); assert.deepEqual(view.entries, []);
});

test('Pi layout modifier is mounted only on the Pi grid, not other CLI rows', async t => {
    // Structure/routing contract only: jsdom cannot prove physical track widths.
    for (const cli of ['pi', 'claude', 'cursor', 'grok', 'codex-app', 'Pi']) {
        const view = await mountRow(t, cli);
        const grid = view.container.querySelector('.settings-percli-grid');
        assert.ok(grid);
        assert.equal(grid.classList.contains('settings-percli-grid--pi'), cli === 'pi', cli);
        assert.equal(view.container.querySelectorAll('.settings-percli-grid--pi').length, cli === 'pi' ? 1 : 0);
        assert.deepEqual(view.values, []); assert.deepEqual(view.entries, []); assert.deepEqual(view.http, []);
    }
});

test('Pi layout preserves full model/provider, effort note, model edits and inert dialog draft', async t => {
    const view = await mountRow(t, 'pi');
    const original = { ...view.original, provider: 'progrok', model: 'grok-composer-2.5-fast', effort: 'medium' };
    const note = 'A long Pi effort explanation remains available without replacing the selected provider or model.';
    await view.render({ original, value: original,
        meta: { ...meta, efforts: ['low', 'medium', 'high'], effortNote: note },
        pi: { defaultProfileId: 'progrok', profiles: [], discoveredModels: { progrok: ['grok-4.6'] } },
    });
    const grid = view.container.querySelector('.settings-percli-grid')!;
    assert.deepEqual([...grid.querySelectorAll('[role="combobox"]')].map(node => node.id),
        ['percli-pi-provider', 'percli-pi-model', 'percli-pi-effort']);
    assert.equal(view.control('Provider').querySelector('.settings-select-value')?.textContent, 'progrok');
    assert.equal(view.control('Model').querySelector('.settings-select-value')?.textContent, 'grok-composer-2.5-fast');
    assert.equal(grid.querySelector('.settings-percli-effort .settings-percli-note')?.textContent, note);
    assert.deepEqual(view.dirty.saveBundle(), {});
    await view.choose('grok-4.6', 'Model');
    assert.deepEqual(view.values, [{ ...original, model: 'grok-4.6' }]);
    assert.deepEqual(view.entries, [{ key: 'perCli.pi.model', entry: {
        value: 'grok-4.6', original: 'grok-composer-2.5-fast', valid: true,
    } }]);
    const settings = [...grid.querySelectorAll<HTMLButtonElement>(':scope > button')].find(node => node.textContent === 'Settings');
    assert.ok(settings);
    await act(async () => { settings.click(); });
    const dialog = view.container.querySelector('[role="dialog"]'); assert.ok(dialog);
    await view.choose('anthropic', 'Mode');
    await view.render({ disabled: true });
    assert.equal(settings.disabled, true);
    assert.ok([...grid.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, [role="combobox"]')].every(node => node.disabled));
    assert.equal(view.container.querySelector('[role="dialog"]'), dialog);
    assert.ok(dialog.closest('[inert]'));
    await view.render({ disabled: false });
    assert.equal(view.control('Mode').querySelector('.settings-select-value')?.textContent, 'anthropic');
    assert.deepEqual(view.dirty.saveBundle(), { 'perCli.pi.model': 'grok-4.6' });
    assert.deepEqual(view.http, []);
});

for (const cli of ['pi']) {
    test(`${cli}: already-open provider option is guarded and existing provider behavior resumes`, async t => {
        const view = await mountRow(t, cli);
        await view.render({
            meta: { ...meta, providers: ['saved-provider', 'next-provider'], modelsByProvider: { 'next-provider': ['next-model'] } },
            pi: { defaultProfileId: 'saved-provider', profiles: [
                { id: 'next-provider', label: 'Next', mode: 'basic', endpoint: 'http://fixture.invalid', model: 'next-model' },
            ] },
        });
        await act(async () => { view.control('Provider').click(); });
        const option = view.options().find(node => node.querySelector('span')?.textContent === 'next-provider')!;
        assert.ok(option);
        await view.render({ disabled: true });
        assert.equal(view.control('Provider').disabled, true);
        if (cli === 'pi') {
            assert.equal(view.control('Model').disabled, true);
            const settings = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Settings')!;
            assert.equal(settings.disabled, true);
            await act(async () => { settings.click(); });
            assert.equal(view.container.querySelector('[role="dialog"]'), null);
        }
        await act(async () => { option.click(); });
        assert.deepEqual(view.values, []); assert.deepEqual(view.entries, []); assert.deepEqual(view.http, []);
        await view.render({ disabled: false });
        await view.choose('next-provider', 'Provider');
        assert.equal(view.values[0]?.provider, 'next-provider');
        assert.equal(view.values[0]?.model, 'next-model');
        assert.ok(!Object.keys(view.dirty.saveBundle()).some(key => key.endsWith('.transport')));
    });
}

test('direct field keeps hooks unconditional across unsupported CLIs and subscribes only to its own entry', async t => {
    const { RuntimeTransportField } = await import('../../public/manager/src/settings/pages/components/runtime-transport-field');
    const { Profiler } = await import('react');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), dirty = createDirtyStore();
    let commits = 0;
    const entries: DirtyEntry[] = [];
    const setEntry = (key: string, entry: DirtyEntry) => { entries.push(entry); dirty.set(key, entry); };
    const render = async (cli: string) => {
        await act(async () => { root.render(createElement(Profiler, { id: 'field', onRender: () => { commits++; } },
            createElement(RuntimeTransportField, { cli, original: undefined, dirty, setEntry }))); });
    };
    t.after(async () => { await act(async () => { root.unmount(); }); container.remove(); });
    await render('codex-app');
    assert.equal(container.textContent, '');
    await render('cursor');
    const before = commits;
    await act(async () => { dirty.set('perCli.grok.transport', { value: 'native', original: 'print', valid: true }); });
    assert.equal(commits, before, 'unrelated dirty entry must not rerender the field');
    const control = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    // Keyboard commits the selected missing-default print value, not first-option native.
    await act(async () => { control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await act(async () => { control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    assert.deepEqual(entries, [{ value: 'print', original: 'print', valid: true }]);
    assert.equal(dirty.pending.has('perCli.cursor.transport'), false);
    await act(async () => { dirty.set('perCli.cursor.transport', { value: 'native', original: 'print', valid: true }); });
    assert.equal(control.textContent, nativeLabel);
    await render('cursor.extra');
    assert.equal(container.textContent, '');
    await render('cursor');
    assert.equal(container.querySelector('[role="combobox"]')?.textContent, nativeLabel);
});
