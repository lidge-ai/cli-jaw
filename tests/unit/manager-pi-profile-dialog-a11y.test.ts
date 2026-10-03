import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ComponentProps } from 'react';
import type { SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PiProfileDialog } = await import('../../public/manager/src/settings/pages/components/PiProfileDialog');
const { SelectField } = await import('../../public/manager/src/settings/fields/SelectField');
type DialogProps = ComponentProps<typeof PiProfileDialog>;
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };

function assertFocus(expected: HTMLElement, message = 'focus must remain with the expected control') {
    // Comparing DOM objects directly makes a failed node:assert diff walk React's entire fiber graph.
    assert.equal(document.activeElement === expected, true, message);
}

async function key(target: HTMLElement, value: string, shiftKey = false) {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    return event;
}

async function mount(t: TestContext, options: { inert?: boolean; prepare?: (container: HTMLElement) => void } = {}) {
    const opener = document.createElement('button'); opener.textContent = 'Pi Settings opener';
    const container = document.createElement('div');
    document.body.append(opener, container); opener.focus();
    if (options.inert) container.setAttribute('inert', '');
    options.prepare?.(container);
    const root = createRoot(container);
    let restores = 0;
    const focus = opener.focus.bind(opener);
    t.mock.method(opener, 'focus', (opts?: FocusOptions) => { restores++; focus(opts); });
    const response = Promise.withResolvers<unknown>();
    const posts: Array<{ path: string; body: unknown; init: RequestInit | undefined }> = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get() { throw Error('Unexpected GET'); },
        async put() { throw Error('Unexpected PUT'); },
        async delete() { throw Error('Unexpected DELETE'); },
        async post<T>(path: string, body: unknown, init?: RequestInit) {
            posts.push({ path, body: structuredClone(body), init });
            return await response.promise as T;
        },
    };
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network'); });
    const closes: string[] = [], registrations: Array<{ owner: string; next: Parameters<DialogProps['onRegistered']>[0] }> = [];
    const callbacks = (owner: string) => ({
        onClose: () => { closes.push(owner); root.render(null); },
        onRegistered: (next: Parameters<DialogProps['onRegistered']>[0]) => { registrations.push({ owner, next }); },
    });
    const props: DialogProps = { client, provider: 'fixture-provider', model: 'fixture-model', ...callbacks('initial') };
    const render = async (patch: Partial<DialogProps> = {}) => {
        Object.assign(props, patch);
        await act(async () => root.render(createElement(PiProfileDialog, props)));
    };
    t.after(async () => {
        await act(async () => root.unmount());
        container.remove(); opener.remove();
    });
    await render();
    const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
        const element = container.querySelector<T>(selector); assert.ok(element, selector); return element;
    };
    return { container, opener, posts, closes, registrations, response, render, callbacks, get,
        restores: () => restores,
        closeButton: () => get<HTMLButtonElement>('.settings-action-discard'),
        submit: () => get<HTMLButtonElement>('.settings-action-save'),
    };
}

test('Pi dialog focuses Provider only on mount and restores its connected opener once on Escape', bounded, async t => {
    const h = await mount(t);
    assert.equal(document.activeElement?.id, 'pi-profile-id', 'entry focus must move from opener to Provider');
    assert.equal(h.get('[role="dialog"]').getAttribute('aria-labelledby'), 'pi-profile-title');
    const endpoint = h.get<HTMLInputElement>('#pi-profile-endpoint'); endpoint.focus();
    await h.render(h.callbacks('latest'));
    assertFocus(endpoint, 'callback rerender must not steal entry focus');
    assert.equal(h.restores(), 0);
    const event = await key(endpoint, 'Escape');
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.closes, ['latest']);
    assertFocus(h.opener); assert.equal(h.restores(), 1);
    assert.deepEqual(h.posts, []);
});

test('Pi dialog wraps Tab and ShiftTab only at its boundaries', bounded, async t => {
    const h = await mount(t), first = h.closeButton(), last = h.submit();
    last.focus(); assert.equal((await key(last, 'Tab')).defaultPrevented, true);
    assertFocus(first);
    assert.equal((await key(first, 'Tab', true)).defaultPrevented, true);
    assertFocus(last);
    const provider = h.get('#pi-profile-id'); provider.focus();
    assert.equal((await key(provider, 'Tab')).defaultPrevented, false, 'interior Tab retains browser order');
});

test('Pi entry focus falls back to Close when Provider is hidden', bounded, async t => {
    const style = document.createElement('style'); style.textContent = '#pi-profile-id { display: none; }';
    document.head.append(style); t.after(() => style.remove());
    const h = await mount(t); assertFocus(h.closeButton(), 'hidden Provider must not receive entry focus');
});

test('Pi Tab boundaries exclude hidden, CSS-hidden, disabled, negative-tabindex and inert controls', bounded, async t => {
    const h = await mount(t), dialog = h.get('[role="dialog"]');
    for (const kind of ['hidden', 'display', 'visibility', 'inert', 'disabled', 'fieldset', 'negative']) {
        for (const edge of ['first', 'last']) {
            const wrapper = document.createElement(kind === 'fieldset' ? 'fieldset' : 'div');
            const button = document.createElement('button'); button.textContent = `${kind}-${edge}`; wrapper.append(button);
            if (kind === 'hidden') wrapper.hidden = true;
            if (kind === 'display') wrapper.style.display = 'none';
            if (kind === 'visibility') wrapper.style.visibility = 'hidden';
            if (kind === 'inert') wrapper.setAttribute('inert', '');
            if (kind === 'disabled') button.disabled = true;
            if (kind === 'fieldset') wrapper.setAttribute('disabled', '');
            if (kind === 'negative') button.tabIndex = -1;
            if (edge === 'first') dialog.prepend(wrapper); else dialog.append(wrapper);
        }
    }
    h.submit().focus(); await key(h.submit(), 'Tab'); assertFocus(h.closeButton());
    await key(h.closeButton(), 'Tab', true); assertFocus(h.submit());
});

test('focused Register transfers to Close before disabling; pending keyboard and captured completion retain ownership', bounded, async t => {
    const h = await mount(t), submit = h.submit(), close = h.closeButton(), lastInput = h.get('#pi-profile-key');
    const focus = close.focus.bind(close);
    let transferOptions: FocusOptions | undefined;
    const transfer = t.mock.method(close, 'focus', (options?: FocusOptions) => {
        assert.equal(submit.disabled, false, 'transfer must precede disabled submit state');
        transferOptions = options;
        focus(options);
    });
    submit.focus(); assertFocus(submit);
    await act(async () => submit.click());
    assert.equal(transfer.mock.callCount(), 1);
    assert.notEqual(transferOptions?.preventScroll, true, 'pre-disable focus must permit native scrolling');
    transfer.mock.restore();
    assert.equal(submit.disabled, true); assertFocus(close, 'focused Register must transfer to Close before pending');
    assert.equal(h.posts.length, 1);
    await act(async () => submit.click()); assert.equal(h.posts.length, 1, 'disabled submit must not repeat the admitted POST');
    assert.equal((await key(close, 'Tab', true)).defaultPrevented, true); assertFocus(lastInput);
    assert.equal((await key(lastInput, 'Tab')).defaultPrevented, true); assertFocus(close);
    await h.render(h.callbacks('latest'));
    assertFocus(close, 'pending callback rerender must not steal focus');
    await key(close, 'Escape');
    assert.deepEqual(h.closes, ['latest']); assertFocus(h.opener); assert.equal(h.restores(), 1);
    await act(async () => h.response.resolve({ ok: true, data: { models: ['fixture-model'] } }));
    assert.equal(h.posts.length, 1); assert.equal(h.restores(), 1); assertFocus(h.opener);
    assert.deepEqual(h.closes, ['latest', 'initial']);
    assert.deepEqual(h.registrations.map(row => [row.owner, row.next.provider, row.next.model]),
        [['initial', 'fixture-provider', 'fixture-model']]);
});

test('internal Pi focus transfers permit scrolling while external opener restoration still prevents it', bounded, async t => {
    const calls: Array<{ phase: string; target: HTMLElement; options: FocusOptions | undefined }> = [];
    let phase = 'mount';
    const originalFocus = dom.window.HTMLElement.prototype.focus;
    t.mock.method(dom.window.HTMLElement.prototype, 'focus', function (this: HTMLElement, options?: FocusOptions) {
        calls.push({ phase, target: this, options });
        originalFocus.call(this, options);
    });
    const h = await mount(t), provider = h.get('#pi-profile-id'), close = h.closeButton(), submit = h.submit();
    phase = 'setup'; submit.focus();
    phase = 'tab-forward'; await key(submit, 'Tab'); assertFocus(close);
    phase = 'tab-backward'; await key(close, 'Tab', true); assertFocus(submit);
    phase = 'pre-disable'; await act(async () => submit.click());
    const trigger = h.get<HTMLButtonElement>('[role="combobox"]');
    phase = 'setup'; trigger.focus(); await key(trigger, ' ');
    const option = h.get('[role="option"]'); option.focus();
    phase = 'popup-escape'; await key(option, 'Escape'); assertFocus(trigger);
    phase = 'external-restore'; await key(trigger, 'Escape'); assertFocus(h.opener);
    phase = 'late-completion';
    await act(async () => h.response.resolve({ ok: true, data: { models: ['fixture-model'] } }));
    assert.equal(h.posts.length, 1); assert.equal(h.restores(), 1);
    assert.equal(calls.filter(call => call.phase === 'late-completion').length, 0);
    const targets: Array<[string, HTMLElement]> = [
        ['mount', provider], ['tab-forward', close], ['tab-backward', submit],
        ['pre-disable', close], ['popup-escape', trigger], ['external-restore', h.opener],
    ];
    const observed = targets.map(([step, target]) => {
        const matches = calls.filter(call => call.phase === step && call.target === target);
        assert.equal(matches.length, 1, `${step} must focus its exact existing target once`);
        return [step, matches[0]!.options?.preventScroll === true];
    });
    assert.deepEqual(observed, [
        ['mount', false], ['tab-forward', false], ['tab-backward', false],
        ['pre-disable', false], ['popup-escape', false], ['external-restore', true],
    ]);
});

test('focused Register does not transfer focus through an inert parent on synthetic activation', bounded, async t => {
    const h = await mount(t), submit = h.submit(), close = h.closeButton();
    const transfer = t.mock.method(close, 'focus', close.focus.bind(close));
    submit.focus(); h.container.setAttribute('inert', '');
    // jsdom allows this synthetic click; a browser owns native inert event suppression.
    await act(async () => submit.click());
    assert.equal(transfer.mock.callCount(), 0, 'parent inert ownership forbids programmatic transfer');
    assert.equal(h.posts.length, 1, 'this repair does not change the existing registration policy');
    await act(async () => h.response.reject(Error('fixture rejection after inert activation')));
    assert.equal(transfer.mock.callCount(), 0); assert.deepEqual(h.closes, []);
});

test('Pi pending submit is excluded from Tab without moving focus on the busy rerender', bounded, async t => {
    const h = await mount(t), lastInput = h.get('#pi-profile-key'); lastInput.focus();
    await act(async () => h.submit().click());
    assert.equal(h.submit().disabled, true); assertFocus(lastInput);
    await key(lastInput, 'Tab'); assertFocus(h.closeButton());
    await key(h.closeButton(), 'Tab', true); assertFocus(lastInput);
    await act(async () => h.response.reject(Error('registration rejected')));
});

test('Pi dialog contains Tab when all its controls are disabled', bounded, async t => {
    const h = await mount(t), provider = h.get<HTMLInputElement>('#pi-profile-id');
    for (const control of h.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input')) control.disabled = true;
    const event = await key(provider, 'Tab');
    assert.equal(event.defaultPrevented, true);
    assertFocus(h.get('[role="dialog"]'));
});

for (const source of ['trigger', 'option']) test(`Pi open SelectField Escape from ${source} closes popup; second Escape closes dialog`, bounded, async t => {
    const h = await mount(t), trigger = h.get<HTMLButtonElement>('[role="combobox"]'); trigger.focus();
    await key(trigger, ' ');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const target = source === 'option' ? h.get<HTMLButtonElement>('[role="option"]') : trigger; target.focus();
    let escaped = 0;
    const listener = () => { escaped++; }; document.body.addEventListener('keydown', listener);
    t.after(() => document.body.removeEventListener('keydown', listener));
    assert.equal((await key(target, 'Escape')).defaultPrevented, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assertFocus(trigger);
    assert.deepEqual(h.closes, []); assert.equal(escaped, 0);
    assert.equal((await key(trigger, 'Escape')).defaultPrevented, true);
    assert.deepEqual(h.closes, ['initial']); assert.equal(h.restores(), 1); assert.equal(escaped, 0);
    assertFocus(h.opener);
});

test('Pi Escape respects a nested widget that already prevented default', bounded, async t => {
    const h = await mount(t), provider = h.get('#pi-profile-id');
    provider.addEventListener('keydown', event => event.preventDefault());
    await key(provider, 'Escape');
    assert.deepEqual(h.closes, []); assert.equal(h.restores(), 0);
});

for (const barrier of ['inert', 'disabled']) test(`Pi mount and key handlers respect the parent ${barrier} owner`, bounded, async t => {
    const h = await mount(t, { inert: barrier === 'inert', prepare: container => {
        if (barrier === 'disabled') container.setAttribute('aria-disabled', 'true');
    } });
    assertFocus(h.opener, 'inactive ancestor must not lose focus');
    const provider = h.get('#pi-profile-id');
    assert.equal((await key(provider, 'Tab')).defaultPrevented, false);
    assert.equal((await key(provider, 'Escape')).defaultPrevented, false);
    assert.deepEqual(h.closes, []); assert.equal(h.restores(), 0);
});

test('Pi dialog does not refocus or close after its parent becomes inert', bounded, async t => {
    const h = await mount(t); h.container.setAttribute('inert', '');
    h.opener.focus(); const before = h.restores();
    const provider = h.get('#pi-profile-id');
    await key(provider, 'Tab'); await key(provider, 'Escape');
    assertFocus(h.opener); assert.equal(h.restores(), before); assert.deepEqual(h.closes, []);
});

test('Pi Close does not attempt to restore a detached opener', bounded, async t => {
    const h = await mount(t); h.opener.remove();
    await act(async () => h.closeButton().click());
    assert.deepEqual(h.closes, ['initial']); assert.equal(h.restores(), 0);
});

test('Pi failed registration is an alert and retains focus and input', bounded, async t => {
    const h = await mount(t), input = h.get<HTMLInputElement>('#pi-profile-id'); input.focus();
    await act(async () => h.submit().click());
    await act(async () => h.response.reject(Error('Fixture registration unavailable')));
    assert.equal(h.get('[role="alert"]').textContent, 'Fixture registration unavailable');
    assert.equal(input.value, 'fixture-provider'); assertFocus(input);
    assert.equal(h.submit().disabled, false); assert.deepEqual(h.closes, []); assert.equal(h.posts.length, 1);
});

for (const outcome of ['success', 'failure']) test(`Pi pending ${outcome} after Close preserves admitted POST/captured callbacks without duplicate focus restoration`, bounded, async t => {
    const h = await mount(t);
    await act(async () => h.submit().click());
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.posts[0], { path: '/api/pi/profiles/register', body: {
        id: 'fixture-provider', label: 'fixture-provider', mode: 'basic', endpoint: 'http://127.0.0.1:18645/v1',
        model: 'fixture-model', apiKey: '',
    }, init: undefined });
    await h.render(h.callbacks('latest'));
    await act(async () => h.closeButton().click());
    assert.deepEqual(h.closes, ['latest']); assert.equal(h.restores(), 1);
    // Actual route envelope; metadata repair belongs to 040, not this a11y slice.
    await act(async () => {
        if (outcome === 'success') h.response.resolve({ ok: true, data: { models: ['fixture-model'] } });
        else h.response.reject(Error('late registration failure'));
    });
    assert.equal(h.posts.length, 1); assert.equal(h.restores(), 1); assertFocus(h.opener);
    assert.deepEqual(h.closes, outcome === 'success' ? ['latest', 'initial'] : ['latest']);
    assert.deepEqual(h.registrations.map(row => [row.owner, row.next.provider, row.next.model]),
        outcome === 'success' ? [['initial', 'fixture-provider', 'fixture-model']] : []);
});

test('standalone closed SelectField Escape propagates untouched and keyboard/click selection is unchanged', bounded, async t => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), changes: string[] = [];
    let escaped = 0;
    container.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; });
    const render = async (value: string) => act(async () => root.render(createElement(SelectField, {
        id: 'standalone', label: 'Mode', value,
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: next => changes.push(next),
    })));
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    await render('a');
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!; trigger.focus();
    assert.equal((await key(trigger, 'Escape')).defaultPrevented, false); assert.equal(escaped, 1);
    await key(trigger, 'ArrowDown'); await key(trigger, 'Enter');
    assert.deepEqual(changes, ['b']); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await render('b'); await key(trigger, ' '); await key(trigger, 'Home'); await key(trigger, ' ');
    assert.deepEqual(changes, ['b', 'a']);
    await render('a'); await act(async () => trigger.click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
    assert.deepEqual(changes, ['b', 'a', 'b']); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});


test('SelectField More transfers focus before unmount so active-element Escape closes only its popup', bounded, async t => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), changes: string[] = [];
    let escaped = 0;
    const observeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') escaped++; };
    // Observe an actual ancestor, outside React's delegated event root.
    document.addEventListener('keydown', observeEscape);
    t.after(async () => {
        document.removeEventListener('keydown', observeEscape);
        await act(async () => root.unmount()); container.remove();
    });
    await act(async () => root.render(createElement(SelectField, {
        id: 'more-focus', label: 'Mode', value: 'a', collapsedAfter: 1,
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }],
        onChange: next => changes.push(next),
    })));
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => trigger.click());
    const more = container.querySelector<HTMLButtonElement>('.settings-select-more');
    assert.ok(more, 'The selected first option leaves More reachable');
    more.focus(); assertFocus(more, 'Click must begin with focus on the button that will be removed');
    await act(async () => more.click());
    assert.equal(more.isConnected, false);
    assert.equal(container.querySelector('.settings-select-more'), null);
    assert.deepEqual([...container.querySelectorAll('[role="option"] span:first-child')].map(el => el.textContent), ['A', 'B', 'C']);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assertFocus(trigger, 'Expansion must transfer focus without test-side restoration');
    assert.equal(trigger.getAttribute('aria-label'), 'Mode: A'); assert.deepEqual(changes, []);
    const escapeTarget = document.activeElement;
    assert.ok(escapeTarget instanceof dom.window.HTMLElement);
    const escape = await key(escapeTarget, 'Escape');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(container.querySelector('[role="listbox"]'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assertFocus(trigger);
    assert.equal(escaped, 0, 'Popup Escape must not reach the enclosing document');
    assert.equal(container.isConnected, true); assert.deepEqual(changes, []);
});
