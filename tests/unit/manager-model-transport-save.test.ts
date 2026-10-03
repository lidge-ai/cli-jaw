import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import type { DirtyEntry, SaveHandler, SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelProvider } = await import('../../public/manager/src/settings/pages/ModelProvider');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
const nativeEntry = (): DirtyEntry => ({ value: 'native', original: 'print', valid: true });
function initial(name: string) {
    return { perCli: { cursor: { model: name + '-model', effort: 'high' }, grok: { model: 'grok-fixture' } },
        fallbackOrder: ['cursor'], activeOverrides: { cursor: { model: 'override' } },
        permissions: 'safe', presentation: { mode: 'activity' } };
}
function fixture(t: TestContext, name: string) {
    let snapshot: Record<string, unknown> = initial(name);
    let registry: Record<string, unknown> = { cursor: { label: name + '-registry', models: [name + '-catalog'], efforts: ['high'] } };
    let failure: Error | null = null;
    let putGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let registrationGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    const readGates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const reads: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const client: SettingsClient = {
        url: (path) => path,
        async get<T>(path: string) {
            assert.ok(path === '/api/settings' || path === '/api/cli-registry'); reads.push(path);
            const value = structuredClone(path === '/api/settings' ? snapshot : registry);
            const gate = readGates.get(path); readGates.delete(path); if (gate) await gate.promise;
            return value as T;
        },
        async put<T>(path: string, body: unknown) {
            assert.equal(path, '/api/settings'); const patch = structuredClone(body) as Record<string, unknown>;
            writes.push({ path, body: patch }); if (putGate) await putGate.promise;
            if (failure) throw failure;
            const perCli = { ...snapshot.perCli as Record<string, Record<string, unknown>> };
            for (const [key, value] of Object.entries(patch.perCli as Record<string, Record<string, unknown>> ?? {}))
                perCli[key] = { ...perCli[key], ...value };
            snapshot = { ...snapshot, ...patch, perCli };
            return { ok: true, data: structuredClone(snapshot) } as T;
        },
        async post<T>(path: string, body: unknown) {
            assert.equal(path, '/api/pi/profiles/register'); assert.ok(registrationGate, 'only explicitly admitted fixture registration');
            const value = body as Record<string, string>; posts.push(structuredClone(value));
            await registrationGate.promise;
            const profile = { id: value.id, label: value.id, model: value.model, mode: value.mode, endpoint: value.endpoint,
                apiKeySet: true, apiKeyLast4: '1234', apiKind: 'openai-completions' };
            const models = [value.model, 'discovery-only-model'];
            // The real route commits both profile and selection before replying.
            snapshot = { ...snapshot, pi: { defaultProfileId: value.id, profiles: [profile], discoveredModels: { [value.id!]: models } },
                perCli: { ...snapshot.perCli as Record<string, unknown>, pi: { provider: value.id, model: value.model } } };
            return { ok: true, data: { models, settings: { pi: snapshot.pi } } } as T;
        }, async delete() { throw Error('Unexpected DELETE'); },
    };
    t.after(async () => { await act(async () => { for (const gate of gates) gate.resolve(); }); });
    return { client, writes, reads, posts, snapshot: () => snapshot,
        fail(error: Error | null) { failure = error; },
        setSnapshot(value: Record<string, unknown>) { snapshot = value; },
        setRegistry(value: Record<string, unknown>) { registry = value; },
        deferPut() { putGate = Promise.withResolvers<void>(); gates.push(putGate); return putGate; },
        deferRegistration() { registrationGate = Promise.withResolvers<void>(); gates.push(registrationGate); return registrationGate; },
        deferRead(path: '/api/settings' | '/api/cli-registry') {
            const gate = Promise.withResolvers<void>(); readGates.set(path, gate); gates.push(gate); return gate;
        },
    };
}
async function mount(t: TestContext, client: SettingsClient) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), dirty = createDirtyStore();
    let handler: SaveHandler | null = null, mounted = true;
    const registerSave = (next: SaveHandler | null) => { handler = next; };
    const render = async (next: SettingsClient, port = 43225) => {
        await act(async () => root.render(createElement(ModelProvider, { client: next, port,
            instanceUrl: `/i/${port}`, dirty, registerSave })));
    };
    t.after(async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; container.remove(); } });
    await render(client);
    return { container, dirty, render,
        handler() { assert.ok(handler); return handler; },
        model() { const input = container.querySelector<HTMLInputElement>('#percli-cursor-model'); assert.ok(input); return input; },
        async edit(entry = nativeEntry(), key = 'perCli.cursor.transport') { await act(async () => dirty.set(key, entry)); },
    };
}

test('Model save serializes only owned transport fields and retains unrelated dirty intent', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client);
    await view.edit();
    const unrelated = { value: 'legacy', original: 'activity', valid: true };
    await view.edit(unrelated, 'presentation.mode');
    await act(async () => { await view.handler()(); });
    assert.deepEqual(api.writes, [{ path: '/api/settings', body: { perCli: { cursor: { transport: 'native' } } } }]);
    assert.equal(view.dirty.pending.get('presentation.mode'), unrelated);
    assert.equal(view.dirty.pending.has('perCli.cursor.transport'), false);
    assert.equal(api.snapshot().permissions, 'safe');
    assert.deepEqual(api.snapshot().presentation, { mode: 'activity' });
});

test('duplicate save joins one request and disables edits including reset while pending', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), gate = api.deferPut();
    await view.edit(); let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = view.handler()(); second = view.handler()(); });
    assert.equal(api.writes.length, 1);
    assert.equal(view.model().disabled, true);
    const reset = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reset overrides')!;
    assert.ok(reset); assert.equal(reset.disabled, true);
    await act(async () => { gate.resolve(); await Promise.all([first, second]); });
    assert.equal(view.model().disabled, false);
});

test('failed registered save retains the transport entry and allows explicit retry', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), entry = nativeEntry();
    await view.edit(entry); api.fail(Error('OWNED SAVE REJECTED'));
    await act(async () => { await assert.rejects(view.handler()(), /OWNED SAVE REJECTED/); });
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), entry);
    api.fail(null); await act(async () => { await view.handler()(); });
    assert.equal(api.writes.length, 2); assert.equal(view.dirty.pending.has('perCli.cursor.transport'), false);
});

test('save completion acknowledges captured entry identities, not a newer same-key intent', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), gate = api.deferPut();
    await view.edit(); let work!: Promise<void>;
    await act(async () => { work = view.handler()(); });
    const newer = nativeEntry(); await view.edit(newer);
    await act(async () => { gate.resolve(); await work; });
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), newer);
    assert.equal(api.writes.length, 1);
});

test('old A save success after A to B to A cannot acknowledge the current generation', bounded, async t => {
    const a = fixture(t, 'A'), b = fixture(t, 'B'), view = await mount(t, a.client), gate = a.deferPut();
    await view.edit(); let work!: Promise<void>;
    await act(async () => { work = view.handler()(); });
    await view.render(b.client, 43226); await view.render(a.client, 43225);
    const newer = nativeEntry(); await view.edit(newer, 'perCli.grok.transport');
    const readsBefore = a.reads.length;
    await act(async () => { gate.resolve(); await work; });
    assert.equal(view.dirty.pending.get('perCli.grok.transport'), newer);
    assert.equal(a.reads.length, readsBefore, 'retired save must not refresh the new generation');
    assert.equal(b.writes.length, 0);
});

test('old registered callback cannot start a new PUT after its view was replaced', bounded, async t => {
    const a = fixture(t, 'A'), b = fixture(t, 'B'), view = await mount(t, a.client);
    const retired = view.handler(); await view.render(b.client, 43226);
    const entry = nativeEntry(); await view.edit(entry);
    await act(async () => { await retired(); });
    assert.deepEqual(a.writes, []); assert.deepEqual(b.writes, []);
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), entry);
});

test('changing port with a reused client invalidates the earlier settings read', bounded, async t => {
    const api = fixture(t, 'A'), gate = api.deferRead('/api/settings'), view = await mount(t, api.client);
    api.setSnapshot(initial('B')); await view.render(api.client, 43226);
    await act(async () => { gate.resolve(); });
    assert.equal(view.model().value, 'B-model');
    assert.equal(api.reads.filter(path => path === '/api/settings').length, 2);
});

test('late metadata from A cannot replace the current B catalog label', bounded, async t => {
    const a = fixture(t, 'A'), b = fixture(t, 'B'), gate = a.deferRead('/api/cli-registry');
    const view = await mount(t, a.client); await view.render(b.client, 43226);
    assert.match(view.container.textContent!, /B-registry/);
    await act(async () => { gate.resolve(); });
    assert.match(view.container.textContent!, /B-registry/); assert.doesNotMatch(view.container.textContent!, /A-registry/);
});

test('real runtime field save and discard follow persisted original rather than a stale model draft', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client);
    const control = () => view.container.querySelector<HTMLButtonElement>('#percli-cursor-transport')!;
    const choose = async (label: string) => {
        assert.ok(control()); await act(async () => control().click());
        const option = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
            .find(button => button.querySelector('span')?.textContent === label);
        assert.ok(option); await act(async () => option.click());
    };
    await choose('Native session (opt-in)');
    await act(async () => { await view.handler()(); });
    assert.deepEqual(api.writes[0]?.body, { perCli: { cursor: { transport: 'native' } } });
    await choose('Print compatibility');
    await act(async () => view.dirty.clear());
    assert.equal(control().querySelector('.settings-select-value')?.textContent, 'Native session (opt-in)');
    assert.equal(api.writes.length, 1);
});

test('form submission catches a rejected save and exposes its error without dropping intent', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), entry = nativeEntry();
    await view.edit(entry); api.fail(Error('FORM SAVE REJECTED'));
    await act(async () => view.container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? '', /FORM SAVE REJECTED/);
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), entry);
    assert.equal(view.model().disabled, false);
});

test('reset and save cannot race, and reset completion leaves native draft ownership intact', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), gate = api.deferPut(), entry = nativeEntry();
    t.mock.method(dom.window, 'confirm', () => true); await view.edit(entry);
    const reset = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reset overrides')!;
    await act(async () => reset.click());
    assert.equal(api.writes.length, 1); assert.ok(api.writes[0]?.body.activeOverrides);
    await act(async () => { await assert.rejects(view.handler()(), /reset/i); });
    assert.equal(api.writes.length, 1);
    await act(async () => gate.resolve());
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), entry);
    await act(async () => { await view.handler()(); });
    assert.equal(api.writes.length, 2); assert.deepEqual(api.writes[1]?.body, { perCli: { cursor: { transport: 'native' } } });
});

test('a held post-save settings GET cannot hide a newer native transport reversal', bounded, async t => {
    const api = fixture(t, 'A'), view = await mount(t, api.client), put = api.deferPut();
    await view.edit(); let work!: Promise<void>;
    await act(async () => { work = view.handler()(); });
    const read = api.deferRead('/api/settings');
    await act(async () => { put.resolve(); await work; });
    const newer = { value: 'print', original: 'native', valid: true }; await view.edit(newer);
    await act(async () => read.resolve());
    const control = view.container.querySelector<HTMLButtonElement>('#percli-cursor-transport')!;
    assert.ok(control); assert.equal(control.querySelector('.settings-select-value')?.textContent, 'Print compatibility');
    assert.equal(view.dirty.pending.get('perCli.cursor.transport'), newer);
});

test('new same-instance metadata wins over an earlier held registry read', bounded, async t => {
    const api = fixture(t, 'A'), gate = api.deferRead('/api/cli-registry'), view = await mount(t, api.client);
    api.setRegistry({ cursor: { label: 'NEW-CATALOG', models: ['new'], efforts: ['high'] } });
    await view.edit(); await act(async () => { await view.handler()(); });
    assert.match(view.container.textContent!, /NEW-CATALOG/);
    await act(async () => gate.resolve());
    assert.match(view.container.textContent!, /NEW-CATALOG/); assert.doesNotMatch(view.container.textContent!, /A-registry/);
});

test('a retired A save error cannot surface on the current B form', bounded, async t => {
    const a = fixture(t, 'A'), b = fixture(t, 'B'), view = await mount(t, a.client), gate = a.deferPut();
    a.fail(Error('RETIRED A ERROR')); await view.edit(); let work!: Promise<void>;
    await act(async () => { work = view.handler()(); void work.catch(() => {}); });
    await view.render(b.client, 43226);
    await act(async () => { gate.resolve(); await work; });
    assert.equal(view.model().value, 'B-model'); assert.doesNotMatch(view.container.textContent!, /RETIRED A ERROR/);
    assert.deepEqual(b.writes, []);
});

function withPi(name: string) {
    return { ...initial(name), perCli: { ...initial(name).perCli, pi: { provider: 'old-profile', model: 'old-model' } },
        pi: { defaultProfileId: 'old-profile', profiles: [{ id: 'old-profile', label: 'Old', mode: 'basic', endpoint: 'http://fixture.invalid', model: 'old-model' }] } };
}

async function registerNewPi(view: Awaited<ReturnType<typeof mount>>) {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('[data-cli="pi"] button')].find(node => node.textContent === 'Settings')!;
    assert.ok(button); await act(async () => button.click());
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        for (const [id, value] of [['pi-profile-id', 'new-profile'], ['pi-profile-model', 'new-model'],
            ['pi-profile-endpoint', 'https://registered.invalid/v1'], ['pi-profile-key', 'fixture-key-1234']]) {
            const input = view.container.querySelector<HTMLInputElement>('#' + id)!; assert.ok(input);
            setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
    });
    await act(async () => view.container.querySelector<HTMLButtonElement>('#pi-profile-mode')!.click());
    const mode = [...view.container.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="option"]')]
        .find(node => node.querySelector('span')?.textContent === 'openai');
    assert.ok(mode); await act(async () => mode.click());
    const register = [...view.container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === 'Register')!;
    assert.ok(register); await act(async () => register.click());
}

for (const saveFails of [true, false]) test(`admitted Pi registration stays visible when overlapping page save ${saveFails ? 'fails' : 'succeeds'}`, bounded, async t => {
    const api = fixture(t, 'A'); api.setSnapshot(withPi('A'));
    const view = await mount(t, api.client); await view.edit();
    const registration = api.deferRegistration(), page = api.deferPut();
    await registerNewPi(view);
    assert.equal(api.posts.length, 1); assert.equal(api.posts[0]!.id, 'new-profile');
    let save!: Promise<void>;
    await act(async () => { save = view.handler()(); void save.catch(() => {}); });
    if (saveFails) api.fail(Error('PAGE SAVE FAILED'));
    await act(async () => registration.resolve());
    assert.equal((api.snapshot().perCli as Record<string, Record<string, string>>).pi!.provider, 'new-profile');
    await act(async () => { page.resolve(); if (saveFails) await assert.rejects(save, /PAGE SAVE FAILED/); else await save; });
    const piRow = view.container.querySelector('[data-cli="pi"]')!;
    assert.ok(piRow); assert.match(piRow.textContent!, /new-profile/); assert.match(piRow.textContent!, /new-model/);
    assert.equal(view.dirty.pending.get('perCli.pi.provider')?.value, 'new-profile');
    assert.equal(view.dirty.pending.get('perCli.pi.model')?.value, 'new-model');
    const model = piRow.querySelector<HTMLButtonElement>('#percli-pi-model'); assert.ok(model);
    await act(async () => model.click());
    assert.ok([...piRow.querySelectorAll('[role="option"] span')].some(node => node.textContent === 'discovery-only-model'));
    await act(async () => model.click());
    const settings = [...piRow.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Settings');
    assert.ok(settings); await act(async () => settings.click());
    assert.equal(view.container.querySelector<HTMLInputElement>('#pi-profile-endpoint')?.value, 'https://registered.invalid/v1');
    assert.equal(view.container.querySelector('#pi-profile-mode .settings-select-value')?.textContent, 'openai');
    const key = view.container.querySelector<HTMLInputElement>('#pi-profile-key'); assert.ok(key);
    assert.equal(key.placeholder, 'set (1234)'); assert.equal(key.value, '', 'reopened dialog never restores a raw key');
});

for (const returnToA of [false, true]) test(`retired Pi registration cannot write current ${returnToA ? 'A after B' : 'B'} draft`, bounded, async t => {
    const a = fixture(t, 'A'), b = fixture(t, 'B'); a.setSnapshot(withPi('A')); b.setSnapshot(withPi('B'));
    const view = await mount(t, a.client), registration = a.deferRegistration();
    await registerNewPi(view); assert.equal(a.posts.length, 1);
    await view.render(b.client, 43226);
    if (returnToA) await view.render(a.client, 43225);
    const current = nativeEntry(); await view.edit(current, 'perCli.grok.transport');
    await act(async () => registration.resolve());
    assert.equal((a.snapshot().perCli as Record<string, Record<string, string>>).pi!.provider, 'new-profile', 'the old admitted server mutation did finish');
    assert.doesNotMatch(view.container.querySelector('[data-cli="pi"]')?.textContent ?? '', /new-profile|new-model/);
    assert.equal(view.dirty.pending.get('perCli.pi.provider'), undefined);
    assert.equal(view.dirty.pending.get('perCli.pi.model'), undefined);
    assert.equal(view.dirty.pending.get('perCli.grok.transport'), current);
    assert.deepEqual(b.posts, []); assert.deepEqual(b.writes, []);
});
