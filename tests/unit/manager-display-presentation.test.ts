import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import type { SaveHandler, SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The root tsx runner uses classic JSX for imported Manager components.
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Display } = await import('../../public/manager/src/settings/pages/Display');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

function settingsClient(initial: Record<string, unknown>, wrapped = false) {
    let snapshot = initial;
    let failure: Error | null = null;
    let pendingPut: Promise<void> | null = null;
    let reads = 0;
    const writes: { path: string; body: unknown }[] = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get<T>(path: string) {
            assert.equal(path, '/api/settings');
            reads += 1;
            return snapshot as T;
        },
        async put<T>(path: string, body: unknown) {
            writes.push({ path, body });
            if (pendingPut) await pendingPut;
            if (failure) throw failure;
            snapshot = { ...snapshot, ...(body as Record<string, unknown>) };
            return (wrapped ? { data: snapshot } : snapshot) as T;
        },
        async post() { throw new Error('Unexpected POST'); },
        async delete() { throw new Error('Unexpected DELETE'); },
    };
    return {
        client, writes, fail: (error: Error | null) => { failure = error; }, reads: () => reads,
        deferPut() {
            const deferred = Promise.withResolvers<void>();
            pendingPut = deferred.promise;
            return deferred;
        },
    };
}

async function mountDisplay(t: TestContext, client: SettingsClient) {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    const root = createRoot(container);
    const dirty = createDirtyStore();
    let save: SaveHandler | null = null;
    let mounted = true;
    const registerSave = (handler: SaveHandler | null) => { save = handler; };
    const render = async (nextClient: SettingsClient, port = 3457) => {
        await act(async () => {
            root.render(createElement(Display, { port, instanceUrl: `/i/${port}`, client: nextClient, dirty, registerSave }));
        });
    };
    const unmount = async () => {
        if (!mounted) return;
        await act(async () => { root.unmount(); });
        mounted = false;
        container.remove();
    };
    t.after(unmount);
    await render(client);
    const control = () => {
        const button = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label^="Presentation:"]');
        assert.ok(button, 'mounted Display must expose the Presentation SelectField');
        return button;
    };
    const choose = async (label: string) => {
        await act(async () => { control().click(); });
        const option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
            .find(button => button.textContent === label);
        assert.ok(option, `missing presentation option: ${label}`);
        await act(async () => { option.click(); });
    };
    return {
        container, dirty, render, unmount, control, choose,
        registered: () => save,
        save: async () => {
            const handler = save;
            assert.ok(handler);
            await act(async () => { await handler(); });
        },
        submit: async () => {
            const form = container.querySelector('form');
            assert.ok(form);
            await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
        },
    };
}

test('fresh absent preference renders Activity, and reverting a draft clears its dirty entry', async t => {
    const api = settingsClient(Object.freeze({ tui: Object.freeze({ themeSeed: 'jaw-dark' }) }));
    const view = await mountDisplay(t, api.client);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    await view.choose('Legacy transcript');
    assert.deepEqual(view.dirty.pending.get('presentation.mode'), { value: 'legacy', original: 'activity', valid: true });
    await view.choose('Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    await view.save();
    assert.deepEqual(api.writes, []);
});

for (const wrapped of [false, true]) {
    test(`registered save sends only the presentation patch and reloads persisted legacy (${wrapped ? 'wrapped' : 'direct'})`, async t => {
        const initial = Object.freeze({ tui: Object.freeze({ themeSeed: 'jaw-dark' }), permissions: 'manual' });
        const api = settingsClient(initial, wrapped);
        const view = await mountDisplay(t, api.client);
        await view.choose('Legacy transcript');
        await view.save();
        assert.deepEqual(api.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
        assert.ok(api.reads() >= 2, 'successful save refreshes settings');
        assert.equal(view.dirty.isDirty(), false);
        assert.equal(view.control().textContent, 'Legacy transcript');
        assert.deepEqual(initial, { tui: { themeSeed: 'jaw-dark' }, permissions: 'manual' });
        await view.choose('Activity (default)');
        assert.deepEqual(view.dirty.pending.get('presentation.mode'), { value: 'activity', original: 'legacy', valid: true });
        await view.unmount();
        const reloaded = await mountDisplay(t, api.client);
        assert.equal(reloaded.control().textContent, 'Legacy transcript');
        assert.equal(reloaded.dirty.isDirty(), false);
    });
}

test('registered save rejects to the shell while retaining the draft and dirty entry', async t => {
    const api = settingsClient({});
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    api.fail(new Error('Settings write rejected'));
    await assert.rejects(view.save(), /Settings write rejected/);
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    assert.equal(view.container.querySelector('[role="alert"]'), null, 'registered errors belong to SettingsShell');
    api.fail(null);
    await view.save();
    assert.equal(view.dirty.isDirty(), false);
});

test('inline submit catches rejection visibly, retains draft, and clears error after successful retry', async t => {
    const api = settingsClient({});
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    api.fail(new Error('Settings write rejected'));
    await view.submit();
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? '', /Settings write rejected/);
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    api.fail(null);
    await view.submit();
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.dirty.isDirty(), false);
});

test('instance change resets legacy draft, dirty state and inline error to the new absent default', async t => {
    const first = settingsClient({});
    const second = settingsClient({});
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    first.fail(new Error('Old instance failure'));
    await view.submit();
    await view.render(second.client, 4567);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    await view.choose('Legacy transcript');
    await view.save();
    assert.deepEqual(second.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
    assert.equal(first.writes.length, 1);
});

test('unmount removes the presentation cleanup key and releases registered save', async t => {
    const view = await mountDisplay(t, settingsClient({}).client);
    await view.choose('Legacy transcript');
    view.dirty.set('unrelated.value', { value: 1, original: 0, valid: true });
    await view.unmount();
    assert.equal(view.dirty.pending.has('presentation.mode'), false);
    assert.equal(view.dirty.pending.has('unrelated.value'), true);
    assert.equal(view.registered(), null);
});

test('late PUT from the previous instance preserves the new instance snapshot, draft and dirty entry', async t => {
    const first = settingsClient({ tui: { themeSeed: 'jaw-dark' } });
    const second = settingsClient({ presentation: { mode: 'legacy' }, tui: { themeSeed: 'jaw-light' } });
    const deferred = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    const handler = view.registered();
    assert.ok(handler);
    let pending: Promise<void>;
    await act(async () => { pending = handler(); });
    assert.equal(first.writes.length, 1);
    await view.render(second.client, 4567);
    await view.choose('Activity (default)');
    const before = view.container.innerHTML;
    const entries = [...view.dirty.pending];
    await act(async () => { deferred.resolve(); await pending; });
    assert.equal(view.container.innerHTML, before, 'late PUT must not replace B draft or displayed data');
    assert.deepEqual([...view.dirty.pending], entries, 'late PUT must not clear B dirty state');
    assert.equal(second.reads(), 1, 'late PUT must not refresh B');
    await view.choose('Legacy transcript');
    assert.equal(view.dirty.isDirty(), false, 'B original snapshot must still be legacy');
});

test('late PUT after unmount does not clear the shared dirty store', async t => {
    const api = settingsClient({});
    const deferred = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    const handler = view.registered();
    assert.ok(handler);
    let pending: Promise<void>;
    await act(async () => { pending = handler(); });
    await view.unmount();
    view.dirty.set('presentation.mode', { value: 'activity', original: 'legacy', valid: true });
    await act(async () => { deferred.resolve(); await pending; });
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
    assert.equal(api.reads(), 1);
});

test('late inline PUT rejection does not show an old instance error in the new instance', async t => {
    const first = settingsClient({});
    const second = settingsClient({ presentation: { mode: 'legacy' } });
    const deferred = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    await view.submit();
    await view.render(second.client, 4567);
    await view.choose('Activity (default)');
    await act(async () => { deferred.reject(new Error('Old instance failure')); });
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
});

test('one pending save disables Display fields and ignores an already-open option without losing the draft', async t => {
    const api = settingsClient({});
    const gate = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    await act(async () => { view.control().click(); });
    const option = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find(button => button.textContent === 'Activity (default)')!;
    assert.ok(option);
    const handler = view.registered()!;
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = handler(); second = handler(); });
    assert.equal(first, second); assert.equal(api.writes.length, 1);
    assert.equal(view.control().disabled, true);
    assert.ok([...view.container.querySelectorAll<HTMLInputElement>('input')].every(input => input.disabled));
    await act(async () => { option.click(); });
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    await act(async () => { gate.resolve(); await Promise.all([first, second]); });
    assert.equal(view.control().disabled, false); assert.equal(view.control().textContent, 'Legacy transcript');
    assert.equal(view.dirty.isDirty(), false);
});

test('save acknowledges only captured dirty entries and retains a newer unrelated entry', async t => {
    const api = settingsClient({});
    const gate = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    view.dirty.set('unrelated.value', { value: 2, original: 1, valid: true });
    await act(async () => { gate.resolve(); await pending; });
    assert.deepEqual(view.dirty.saveBundle(), { 'unrelated.value': 2 });
    assert.deepEqual(api.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
});

test('A to B to A never reuses the first A save generation', async t => {
    const first = settingsClient({}); const second = settingsClient({ presentation: { mode: 'legacy' } });
    const gate = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    await view.render(second.client, 4567);
    await view.render(first.client, 3457);
    await view.choose('Legacy transcript');
    const before = view.container.innerHTML, dirty = [...view.dirty.pending], reads = first.reads();
    await act(async () => { gate.resolve(); await pending; });
    assert.equal(view.container.innerHTML, before); assert.deepEqual([...view.dirty.pending], dirty);
    assert.equal(first.reads(), reads, 'old completion cannot refresh the re-mounted A generation');
    assert.equal(view.control().disabled, false);
});

test('Discard clears the presentation draft and restores the actual saved mode without a PUT', async t => {
    const api = settingsClient({}); const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    await act(async () => { view.dirty.clear(); });
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false); assert.deepEqual(api.writes, []);
});

test('a newer same-field dirty entry remains the displayed intent after an older save completes', async t => {
    const api = settingsClient({}); const gate = api.deferPut();
    const view = await mountDisplay(t, api.client); await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    await act(async () => { view.dirty.set('presentation.mode', { value: 'activity', original: 'legacy', valid: true }); });
    await act(async () => { gate.resolve(); await pending; });
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
});

const { SettingsShell } = await import('../../public/manager/src/settings/SettingsShell');
const { SETTINGS_REGISTRY } = await import('../../public/manager/src/settings/settings-registry');
async function mountShell(t: TestContext, client: SettingsClient) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    let saved = 0, dirty = false;
    const render = async (nextClient = client, port = 3465) => {
        await act(async () => root.render(createElement(SettingsShell, {
            client: nextClient, port, instanceUrl: `/i/${port}`, initialId: 'display', scopes: ['instance'],
            onSaved: () => { ++saved; }, onDirtyChange: value => { dirty = value; },
        })));
        await act(async () => { await SETTINGS_REGISTRY.find(e => e.id === 'display')!.load(); });
    };
    await render();
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    const click = async (label: string) => {
        const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label);
        assert.ok(button, `missing ${label}`); await act(async () => button.click());
    };
    const choose = async () => {
        const control = container.querySelector<HTMLButtonElement>('[aria-label^="Presentation:"]')!;
        await act(async () => control.click()); await click('Legacy transcript');
    };
    return { container, render, click, choose, saved: () => saved, dirty: () => dirty };
}

test('shared Shell saves Display through its direct client with singleflight and discard restoration', async t => {
    const api = settingsClient({}); const view = await mountShell(t, api.client);
    await view.choose(); assert.equal(view.dirty(), true);
    await view.click('Discard');
    assert.equal(view.container.querySelector('[aria-label^="Presentation:"]')?.textContent, 'Activity (default)');
    assert.deepEqual(api.writes, []);
    await view.choose();
    const pending = api.deferPut();
    const save = view.container.querySelector<HTMLButtonElement>('.settings-action-save')!;
    await act(async () => { save.click(); save.click(); });
    assert.equal(api.writes.length, 1);
    assert.deepEqual(api.writes[0], { path: '/api/settings', body: { presentation: { mode: 'legacy' } } });
    assert.equal(save.disabled, true);
    await act(async () => { pending.resolve(); await pending.promise; });
    assert.equal(view.saved(), 1); assert.equal(view.dirty(), false);
});

test('shared Shell refuses dirty navigation and ignores old target save completion', async t => {
    const first = settingsClient({}), second = settingsClient({});
    const view = await mountShell(t, first.client);
    await view.choose();
    const form = view.container.querySelector('form');
    const previousConfirm = window.confirm; window.confirm = () => false;
    t.after(() => { window.confirm = previousConfirm; });
    await view.click('Profile');
    assert.equal(view.container.querySelector('form'), form);
    assert.equal(view.dirty(), true);
    const pending = first.deferPut(); await view.click('Save');
    await view.render(second.client, 3470); await view.choose();
    await act(async () => { pending.resolve(); await pending.promise; });
    assert.equal(view.saved(), 0); assert.equal(view.dirty(), true);
    assert.equal(view.container.querySelector('.settings-toast'), null);
    await view.click('Save');
    assert.equal(second.writes.length, 1, 'old cleanup must not clear the new registration');
});

const { default: ChannelsSlack } = await import('../../public/manager/src/settings/pages/ChannelsSlack');
const { slackText } = await import('../../public/manager/src/settings/pages/components/SlackSetup');
const { SettingsRequestError } = await import('../../public/manager/src/settings/settings-client');
async function mountSlack(t: TestContext, initial: Record<string, unknown> = { slack: { enabled: true, botToken: '••••stored', attachPort: '3465' } }) {
    document.documentElement.lang = 'en';
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), dirty = createDirtyStore();
    let registered: SaveHandler | null = null, snapshot = initial;
    let resetMode: 'clear' | 'lost' | 'not-cleared' | 'get-fails' | 'environment' = 'clear';
    let pendingGet: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>> | null = null;
    const writes: { method: string; path: string; body: unknown }[] = [], reads: string[] = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get<T>(path: string) {
            reads.push(path);
            if (path.startsWith('/api/slack/manifest')) return { json: '{"display_information":{"name":"cli-jaw"}}' } as T;
            if (path === '/api/health') return {} as T;
            if (resetMode === 'get-fails') throw new Error('offline');
            if (pendingGet) { const next = pendingGet; pendingGet = null; return await next.promise as T; }
            return snapshot as T;
        },
        async put<T>(path: string, body: unknown) {
            writes.push({ method: 'PUT', path, body });
            const patch = body as Record<string, Record<string, unknown>>;
            snapshot = { ...snapshot, slack: { ...(snapshot['slack'] as object), ...patch['slack'] } };
            return snapshot as T;
        },
        async post<T>(path: string, body: unknown) {
            writes.push({ method: 'POST', path, body });
            if (path === '/api/channels/validate') return { ok: true, identity: 'fixture bot', teamId: 'T_FIXTURE' } as T;
            if (resetMode === 'environment') throw new SettingsRequestError('POST', path, 409,
                JSON.stringify({ error: 'slack_connection_managed_by_environment', environmentVariables: ['SLACK_BOT_TOKEN'] }));
            if (resetMode === 'clear' || resetMode === 'lost') snapshot = { ...snapshot, slack: { enabled: false, mentionOnly: true } };
            if (resetMode === 'lost') throw new Error('lost response');
            return {} as T;
        },
        async delete() { throw new Error('Unexpected DELETE'); },
    };
    const confirm = window.confirm, open = window.open;
    window.confirm = () => true; window.open = () => null;
    const host = window as unknown as { cliJawDesktop?: unknown };
    const previousBridge = host.cliJawDesktop;
    host.cliJawDesktop = { clipboard: { writeText: async () => ({ ok: true }) } };
    // JSDOM has no modal layout; native focus/keyboard behavior is covered by browser QA.
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    await act(async () => root.render(createElement(ChannelsSlack, { port: 3465, instanceUrl: '/i/3465', client, dirty,
        registerSave: handler => { registered = handler; } })));
    t.after(async () => {
        await act(async () => root.unmount()); container.remove();
        window.confirm = confirm; window.open = open; host.cliJawDesktop = previousBridge;
    });
    const input = (id: string) => { const element = container.querySelector<HTMLInputElement>(`#${id}`); assert.ok(element, id); return element; };
    const fill = async (id: string, value: string) => {
        const element = input(id);
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
    };
    const click = async (text: string, inDialog = false) => {
        const parent = inDialog ? container.querySelector('dialog')! : container;
        const button = Array.from(parent.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === text);
        assert.ok(button, text); await act(async () => button.click());
    };
    const tr = slackText('en');
    const startSetupSave = async () => {
        await click(tr('onboarding.slackGenerateManifest'), true);
        await click(tr('onboarding.openIssuer'), true);
        await click(tr('onboarding.next'), true);
        await click(tr('onboarding.next'), true);
        await click(tr('onboarding.validate'), true);
        await click(tr('onboarding.next'), true);
        await click(tr('onboarding.save'), true);
    };
    return { container, client, dirty, writes, reads, input, fill, click, tr, startSetupSave,
        registered: () => { assert.ok(registered); return registered; },
        mode: (value: typeof resetMode) => { resetMode = value; },
        deferGet: () => { pendingGet = Promise.withResolvers<Record<string, unknown>>(); return pendingGet; },
        openSetup: () => click(tr('onboarding.open')),
        closeSetup: () => click(tr('onboarding.close'), true),
        reset: () => click(tr('settings.slack.resetConnection')),
    };
}

test('Slack attachPort trims its patch and leaves masked credentials out of the write', async t => {
    const view = await mountSlack(t);
    assert.equal(view.input('sl-attachPort').value, '3465');
    assert.equal(view.input('sl-botToken').value, '');
    assert.equal(view.input('sl-mentionOnly').checked, true);
    assert.equal(view.input('sl-replyInThread').checked, true);
    assert.equal(view.container.querySelector('dialog'), null);
    await view.fill('sl-attachPort', ' 3470 ');
    await act(async () => view.registered()());
    assert.deepEqual(view.writes, [{ method: 'PUT', path: '/api/settings', body: { slack: { attachPort: '3470' } } }]);
});

for (const mode of ['clear', 'lost', 'not-cleared', 'get-fails', 'environment'] as const) {
    test(`Slack reset uses one POST and authoritative GET (${mode})`, async t => {
        const view = await mountSlack(t); await view.fill('sl-attachPort', '3470');
        await act(async () => { view.input('sl-forwardAll').click(); });
        const preference = view.dirty.pending.get('slack.forwardAll');
        window.confirm = () => false; await view.reset(); assert.equal(view.writes.length, 0);
        window.confirm = () => true; view.mode(mode); await view.reset();
        assert.equal(view.writes.length, 1);
        assert.equal(view.writes[0]!.path, '/api/settings/slack/reset');
        assert.ok(view.reads.filter(path => path === '/api/settings').length >= 2);
        assert.equal(view.dirty.pending.get('slack.forwardAll'), preference);
        if (mode === 'clear' || mode === 'lost') {
            assert.equal(view.input('sl-attachPort').value, ''); assert.equal(view.input('sl-enabled').checked, false);
            assert.equal(view.dirty.pending.has('slack.attachPort'), false);
        } else if (mode === 'environment') {
            assert.equal(view.input('sl-botToken').disabled, true);
            assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? '', /SLACK_BOT_TOKEN/);
        } else {
            assert.equal(view.input('sl-attachPort').value, '3470');
            assert.ok(view.container.querySelector('[role="alert"]'));
        }
    });
}

test('Slack setup blocks both the retained and current save callbacks before bundle dispatch', async t => {
    const view = await mountSlack(t); await view.fill('sl-attachPort', '3470');
    const retained = view.registered(); await view.openSetup();
    assert.equal(view.dirty.pending.get('slack.setup')?.valid, false);
    assert.equal(view.dirty.saveBundle()['slack.attachPort'], '3470');
    await assert.rejects(retained()); await assert.rejects(view.registered()());
    assert.equal(view.writes.length, 0); assert.equal(view.dirty.isDirty(), true);
});

for (const reopen of [false, true]) {
    test(`Slack ignores setup GET after close and credential replacement (reopen=${reopen})`, async t => {
        const view = await mountSlack(t); await view.fill('sl-botToken', 'xoxb-before'); await view.openSetup();
        const get = view.deferGet(); await view.startSetupSave();
        assert.equal(view.writes.filter(write => write.method === 'PUT').length, 1);
        await view.closeSetup(); await view.fill('sl-botToken', 'xoxb-newer'); await view.fill('sl-appToken', 'xapp-newer');
        const bot = view.dirty.pending.get('slack.botToken'), app = view.dirty.pending.get('slack.appToken');
        if (reopen) await view.openSetup();
        const setup = view.dirty.pending.get('slack.setup'), reads = view.reads.length;
        await act(async () => { get.resolve({ slack: { enabled: true, botToken: '••••saved', teamId: 'T_SAVED' } }); await get.promise; });
        assert.equal(view.input('sl-botToken').value, 'xoxb-newer');
        assert.equal(view.input('sl-appToken').value, 'xapp-newer');
        assert.equal(view.dirty.pending.get('slack.botToken'), bot); assert.equal(view.dirty.pending.get('slack.appToken'), app);
        assert.equal(view.dirty.pending.get('slack.setup'), setup); assert.equal(view.reads.length, reads);
    });
}

test('Slack setup acknowledges only entries captured before PUT and preserves later replacements', async t => {
    const view = await mountSlack(t); await view.fill('sl-botToken', 'xoxb-before'); await view.openSetup();
    const get = view.deferGet(); await view.startSetupSave();
    const newer = { value: 'xoxb-newer', original: '', valid: true };
    await act(async () => view.dirty.set('slack.botToken', newer));
    await act(async () => { get.resolve({ slack: { enabled: true, botToken: '••••saved', teamId: 'T_SAVED' } }); await get.promise; });
    assert.equal(view.dirty.pending.get('slack.botToken'), newer);
    assert.equal(view.input('sl-botToken').value, 'xoxb-newer');
    assert.equal(view.dirty.pending.has('slack.setup'), false);
});

test('Slack environment-owned connection rejects stale saves while preference writes remain allowed', async t => {
    const view = await mountSlack(t); const retained = view.registered();
    view.mode('environment'); await view.reset();
    await act(async () => view.dirty.set('slack.attachPort', { value: '3470', original: '', valid: true }));
    await assert.rejects(retained()); await assert.rejects(view.registered()());
    assert.equal(view.writes.filter(write => write.method === 'PUT').length, 0);
    await act(async () => { view.dirty.remove('slack.attachPort'); view.input('sl-forwardAll').click(); });
    await act(async () => view.registered()());
    assert.deepEqual(view.writes.at(-1), { method: 'PUT', path: '/api/settings', body: { slack: { forwardAll: false } } });
});
