import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import type { SaveHandler, SettingsClient, SettingsPageProps } from '../../public/manager/src/settings/types';
import type { AsideCatalog } from '../../src/shared/aside-contract';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Agent } = await import('../../public/manager/src/settings/pages/Agent');
const { default: ModelProvider } = await import('../../public/manager/src/settings/pages/ModelProvider');
const { useAsideModels, asideModelChoices, asideEffortChoices, asideSelectionError, unwrapAsideCatalog } = await import('../../public/manager/src/settings/pages/components/aside-models');
const { runtimeModelFor, auxiliaryRuntimeOptions } = await import('../../public/manager/src/settings/pages/components/agent/agent-meta');
const { sanitizeSettingsInput } = await import('../../src/core/settings-merge');
const { resolveAsideSelection } = await import('../../src/agent/aside-catalog');

after(() => { dom.window.close(); for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
} });

function catalog(account: string, defaultModel: string | null = 'vendor/first'): AsideCatalog {
    return {
        context: { account, host: 'local' }, entries: [
            { id: 'vendor/first', provider: 'vendor', modelId: 'first', name: 'First', efforts: ['low'], thinkingLevelMap: { low: 1 }, capability: 'registered' },
            { id: 'vendor/second', provider: 'vendor', modelId: 'second', name: 'Second', efforts: ['high'], thinkingLevelMap: { high: 2 }, capability: 'registered' },
            { id: 'custom/no-thinking', provider: 'custom', modelId: 'no-thinking', name: 'Custom', efforts: [], thinkingLevelMap: {}, capability: 'unknown' },
        ], cachedIds: [{ id: 'cache/only', provider: 'cache', modelId: 'only', capability: 'unknown' }],
        defaultModel, configuredDefault: defaultModel ? { provider: 'vendor', modelId: defaultModel.split('/')[1]!, thinkingLevel: 'low' } : null,
        status: 'available', source: 'local-files', diagnostics: [],
    };
}
function merge(original: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const out = { ...original };
    for (const [key, value] of Object.entries(patch)) out[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? merge((out[key] || {}) as Record<string, unknown>, value as Record<string, unknown>) : value;
    return out;
}
function apiFixture(initial = {
    cli: 'aside', workingDir: '/fixture', permissions: 'auto',
    perCli: { aside: { account: 'u1', host: 'local', model: 'default', effort: '' }, claude: { model: 'sonnet' } },
    activeOverrides: { aside: { model: 'vendor/second', effort: 'high' } }, fallbackOrder: ['claude'],
}) {
    let snapshot: Record<string, unknown> = initial;
    let failure: Error | null = null;
    let readCatalog: (account: string) => Promise<unknown> = async account => ({ ok: true, data: catalog(account) });
    const writes: Record<string, unknown>[] = [];
    const reads: string[] = [];
    const client: SettingsClient = {
        url: (path: string) => `/i/3457${path}`,
        async get<T>(path: string) {
            reads.push(path);
            if (path.startsWith('/api/aside/models?')) return await readCatalog(new URL(path, 'http://fixture').searchParams.get('account')!) as T;
            if (path === '/api/settings') return snapshot as T;
            if (path === '/api/cli-registry') return { ok: true, data: { aside: { label: 'Aside', models: ['default'], efforts: [] }, claude: { label: 'Claude', models: ['sonnet'], efforts: [] } } } as T;
            if (path === '/api/cli-status') return { aside: { available: true, capabilityReady: true, checkedCapability: 'main', probeState: 'fresh' } } as T;
            if (path === '/api/memory-files') return { cli: 'claude', model: 'sonnet' } as T;
            if (path === '/api/employees') return { ok: true, data: [] } as T;
            throw new Error(`Unexpected GET ${path}`);
        },
        async put<T>(path: string, body: unknown) {
            assert.equal(path, '/api/settings'); writes.push(body as Record<string, unknown>);
            if (failure) throw failure;
            snapshot = merge(snapshot, sanitizeSettingsInput(body as Record<string, unknown>, 'api').value);
            return { ok: true, data: snapshot } as T;
        },
        async post() { throw new Error('Unexpected POST'); }, async delete() { throw new Error('Unexpected DELETE'); },
    };
    return { client, writes, reads, snapshot: () => snapshot, fail: (error: Error | null) => { failure = error; }, catalogs: (fn: typeof readCatalog) => { readCatalog = fn; } };
}
async function mount(t: TestContext, page: typeof Agent | typeof ModelProvider, client: SettingsClient) {
    const container = dom.window.document.createElement('div'); dom.window.document.body.append(container);
    const root = createRoot(container), dirty = createDirtyStore();
    let save: SaveHandler | null = null;
    const registerSave = (handler: SaveHandler | null) => { save = handler; };
    const render = async (nextClient = client, port = 3457, instanceUrl = `/i/${port}`) => {
        await act(async () => root.render(createElement(page, { port, instanceUrl, client: nextClient, dirty, registerSave })));
    };
    await render();
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    const choose = async (id: string, label: string) => {
        const control = container.querySelector<HTMLButtonElement>(`#${id}`); assert.ok(control, id);
        await act(async () => control.click());
        let option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(e => e.textContent === label);
        if (!option) {
            const more = container.querySelector<HTMLButtonElement>('.settings-select-more');
            if (more) await act(async () => more.click());
            option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(e => e.textContent === label);
        }
        assert.ok(option, `${id}: ${label}`); await act(async () => option.click());
    };
    const input = async (id: string, value: string) => {
        const control = container.querySelector<HTMLInputElement>(`#${id}`); assert.ok(control, id);
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(control, value);
            control.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
    };
    return { container, dirty, render, choose, input, handler: () => { assert.ok(save); return save; }, save: async () => {
        assert.ok(save); await act(async () => { await save!(); });
    } };
}

test('wire unwrap validates envelope and account; advertised unknown-effort entry remains selectable without auth inference', () => {
    const data = unwrapAsideCatalog({ ok: true, data: catalog('u1') }, 'u1');
    assert.throws(() => unwrapAsideCatalog(data, 'u1'));
    assert.throws(() => unwrapAsideCatalog({ ok: true, data }, 'u2'));
    const inventory = { kind: 'ready' as const, catalog: data };
    assert.deepEqual(asideModelChoices(inventory).map(e => e.value), ['default', 'vendor/first', 'vendor/second', 'custom/no-thinking']);
    assert.deepEqual(asideEffortChoices(inventory, 'default'), ['low']);
    assert.deepEqual(asideEffortChoices(inventory, 'custom/no-thinking'), []);
    assert.equal(asideSelectionError(inventory, 'custom/no-thinking', ''), null);
    assert.equal(resolveAsideSelection(data, 'custom/no-thinking').model, 'custom/no-thinking');
    assert.equal('authenticated' in data, false);
    assert.deepEqual(auxiliaryRuntimeOptions(['aside', 'claude']), ['claude']);
});

test('default sentinel requires concrete available selection; no cached-only selection or union effort', () => {
    const unavailable = { kind: 'ready' as const, catalog: catalog('u1', null) };
    assert.ok(!asideModelChoices(unavailable).some(e => e.value === 'default'));
    assert.ok(asideSelectionError(unavailable, 'default', ''));
    assert.ok(asideSelectionError(unavailable, 'cache/only', ''));
    assert.deepEqual(asideEffortChoices(unavailable, 'default'), []);
    const invalidDefault = catalog('u1'); invalidDefault.configuredDefault!.thinkingLevel = 'high';
    assert.ok(!asideModelChoices({ kind: 'ready', catalog: invalidDefault }).some(e => e.value === 'default'));
});

for (const [name, page, prefix] of [['Agent', Agent, 'agent-aside'], ['Model defaults', ModelProvider, 'percli-aside']] as const) {
    test(`${name}: account/reset saves atomically, catalog reads never write, failed response preserves draft, reload keeps selection`, async t => {
        const api = apiFixture();
        const view = await mount(t, page, api.client);
        assert.equal(api.writes.length, 0);
        assert.equal(view.dirty.isDirty(), false);
        await view.input(`${prefix}-account`, 'u2');
        await view.choose(`${prefix}-model`, 'vendor/second');
        await view.choose(`${prefix}-effort`, 'high');
        api.fail(new Error('fixture denied'));
        await assert.rejects(view.save(), /fixture denied/);
        assert.equal((view.container.querySelector(`#${prefix}-account`) as HTMLInputElement).value, 'u2');
        assert.ok(view.dirty.isDirty());
        api.fail(null); await view.save();
        const patch = api.writes.at(-1)!;
        assert.equal((patch['perCli'] as Record<string, Record<string, unknown>>)['aside']!['account'], 'u2');
        assert.ok('aside' in (patch['activeOverrides'] as object));
        if (page === ModelProvider) assert.deepEqual((patch['activeOverrides'] as Record<string, unknown>)['aside'], { model: '', effort: '' });
        assert.equal(view.dirty.isDirty(), false);
        assert.equal((view.container.querySelector(`#${prefix}-account`) as HTMLInputElement).value, 'u2');
        assert.equal(view.container.querySelector(`#${prefix}-model`)!.textContent, 'vendor/second');
        assert.equal(view.container.querySelector(`#${prefix}-effort`)!.textContent, 'high');
        assert.ok(!view.container.querySelector('[id$="fastmode"]') || !view.container.querySelector('#percli-aside-fastmode'));
    });
    test(`${name}: account change with unavailable default does not silently save a partial reset`, async t => {
        const api = apiFixture(); api.catalogs(async account => ({ ok: true, data: catalog(account, account === 'u2' ? null : 'vendor/first') }));
        const view = await mount(t, page, api.client);
        await view.input(`${prefix}-account`, 'u2');
        assert.match(view.container.querySelector(`#${prefix}-model`)!.textContent || '', /default.*unavailable/);
        await assert.rejects(view.save(), /unavailable/);
        assert.equal(api.writes.length, 0);
        assert.equal(view.dirty.pending.get('perCli.aside.account')?.value, 'u2');
        await view.choose(`${prefix}-model`, 'custom/no-thinking');
        await view.save();
        assert.equal(api.writes.length, 1);
    });
}

test('account reset then nondefault Model defaults selection resolves to per-CLI choice', async t => {
    const api = apiFixture(); const view = await mount(t, ModelProvider, api.client);
    await view.input('percli-aside-account', 'u2'); await view.save();
    await view.choose('percli-aside-model', 'vendor/second'); await view.choose('percli-aside-effort', 'high'); await view.save();
    const snapshot = api.snapshot() as { perCli: Record<string, { model?: string }>; activeOverrides: Record<string, { model?: string }> };
    assert.equal(runtimeModelFor('aside', snapshot.perCli, snapshot.activeOverrides), 'vendor/second');
    assert.equal(resolveAsideSelection(catalog('u2'), runtimeModelFor('aside', snapshot.perCli, snapshot.activeOverrides), 'high').model, 'vendor/second');
});

function InventoryHarness(props: Pick<SettingsPageProps, 'client' | 'port' | 'instanceUrl'> & { account: string }) {
    const result = useAsideModels(props.client, props.instanceUrl, props.port, props.account);
    return createElement('div', null, JSON.stringify(result.inventory));
}
test('rendered hook rejects A→B→A, port/URL/client stale success/error and unmount', async t => {
    const api = apiFixture();
    const requests: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
    api.catalogs(() => { const deferred = Promise.withResolvers<unknown>(); requests.push(deferred); return deferred.promise; });
    const container = dom.window.document.createElement('div'), root = createRoot(container);
    dom.window.document.body.append(container); let live = true;
    t.after(async () => { if (live) await act(async () => root.unmount()); container.remove(); });
    const render = async (account: string, port = 3457, instanceUrl = `/i/${port}`, client = api.client) => {
        await act(async () => root.render(createElement(InventoryHarness, { account, port, instanceUrl, client })));
    };
    await render('u1'); await render('u2'); await render('u1');
    await act(async () => requests[0]!.resolve({ ok: true, data: catalog('u1') }));
    assert.equal(container.textContent, '{"kind":"loading"}');
    await act(async () => requests[1]!.reject(new Error('old error')));
    assert.equal(container.textContent, '{"kind":"loading"}');
    await act(async () => requests[2]!.resolve({ ok: true, data: catalog('u1') }));
    assert.match(container.textContent!, /vendor\/first/);
    await render('u1', 3458);
    assert.equal(container.textContent, '{"kind":"loading"}');
    await render('u1', 3458, '/different');
    await act(async () => requests[3]!.resolve({ ok: true, data: catalog('u1') }));
    assert.equal(container.textContent, '{"kind":"loading"}');
    await render('u1', 3458, '/different', { ...api.client });
    await act(async () => requests[4]!.reject(new Error('old URL error')));
    assert.equal(container.textContent, '{"kind":"loading"}');
    await act(async () => root.unmount()); live = false;
    await act(async () => requests[5]!.resolve({ ok: true, data: catalog('u1') }));
    assert.equal(container.textContent, '');
    assert.equal(api.writes.length, 0);
});

for (const [name, page, prefix] of [['Agent', Agent, 'agent-aside'], ['Model defaults', ModelProvider, 'percli-aside']] as const) {
    test(`${name}: stale account response/error never restores draft; refresh only reads`, async t => {
        const api = apiFixture();
        const requests: Array<{ account: string; gate: ReturnType<typeof Promise.withResolvers<unknown>> }> = [];
        api.catalogs(account => { const gate = Promise.withResolvers<unknown>(); requests.push({ account, gate }); return gate.promise; });
        const view = await mount(t, page, api.client);
        await view.input(`${prefix}-account`, 'u2'); await view.input(`${prefix}-account`, 'u1');
        assert.deepEqual(requests.map(e => e.account), ['u1', 'u2', 'u1']);
        await act(async () => requests[0]!.gate.resolve({ ok: true, data: catalog('u1') }));
        assert.match(view.container.textContent!, /Loading Aside models/);
        await act(async () => requests[1]!.gate.reject(new Error('old account failure')));
        assert.ok(!view.container.textContent!.includes('Could not read'));
        await act(async () => requests[2]!.gate.resolve({ ok: true, data: catalog('u1') }));
        const before = new Map(view.dirty.pending);
        const refresh = Array.from(view.container.querySelectorAll<HTMLButtonElement>('button')).find(e => e.textContent === 'Refresh Aside models')!;
        await act(async () => refresh.click());
        await act(async () => requests[3]!.gate.resolve({ ok: true, data: catalog('u1') }));
        assert.deepEqual(view.dirty.pending, before);
        assert.equal(api.writes.length, 0);
    });
    test(`${name}: account save singleflight retains new instance draft after late completion`, async t => {
        const api = apiFixture(), gate = Promise.withResolvers<void>();
        const client: SettingsClient = { ...api.client, put: async <T,>(path: string, body: unknown, init?: RequestInit) => {
            await gate.promise; return api.client.put<T>(path, body, init);
        } };
        const view = await mount(t, page, client);
        await view.input(`${prefix}-account`, 'u2');
        let first!: Promise<void>, second!: Promise<void>;
        await act(async () => { first = view.handler()(); second = view.handler()(); });
        const replacement = apiFixture();
        await view.render(replacement.client, 3458);
        await view.input(`${prefix}-account`, 'u3');
        await act(async () => { gate.resolve(); await Promise.all([first, second]); });
        assert.equal(api.writes.length, 1);
        assert.equal(replacement.writes.length, 0);
        assert.equal((view.container.querySelector(`#${prefix}-account`) as HTMLInputElement).value, 'u3');
        assert.equal(view.dirty.pending.get('perCli.aside.account')!.value, 'u3');
    });
}

test('Agent keeps account reset draft valid when switching to another main runtime', async t => {
    const api = apiFixture(), view = await mount(t, Agent, api.client);
    await view.input('agent-aside-account', 'u2');
    await view.choose('agent-cli', 'Claude');
    await view.save();
    assert.deepEqual((api.writes[0]!['activeOverrides'] as Record<string, unknown>)['aside'], { model: '', effort: '' });
    assert.equal((api.writes[0]!['perCli'] as Record<string, Record<string, unknown>>)['aside']!['account'], 'u2');
});

test('Aside filter keeps saved unsupported employee visible and invalid; memory flush inheritance cannot select Aside', async t => {
    const api = apiFixture();
    const client: SettingsClient = { ...api.client, get: async <T,>(path: string, init?: RequestInit) => {
        if (path === '/api/employees') return { ok: true, data: [{ id: 'fixture', name: 'Saved', cli: 'aside', model: 'default', role: '', source: 'db' }] } as T;
        if (path === '/api/memory-files') return { cli: '', model: 'default' } as T;
        return api.client.get<T>(path, init);
    } };
    const view = await mount(t, Agent, client);
    assert.equal(view.container.querySelector('#runtime-employee-fixture-cli')!.textContent, 'Aside (main-only)');
    assert.match(view.container.textContent!, /main agent only|cannot execute/);
    await act(async () => (view.container.querySelector('#runtime-employee-fixture-cli') as HTMLButtonElement).click());
    assert.ok(!Array.from(view.container.querySelectorAll('[role="option"]')).some(e => e.textContent?.startsWith('Aside')));
    await act(async () => (view.container.querySelector('#runtime-employee-fixture-cli') as HTMLButtonElement).click());
    assert.equal(view.container.querySelector('#agent-flush-cli')!.textContent, '(active CLI unavailable)');
    assert.match(view.container.textContent!, /Aside cannot run memory flush/);
    assert.equal((view.container.querySelector('#agent-flush-model') as HTMLButtonElement).disabled, true);
});

test('Agent explicit default effort bypasses saved high for a new model with no efforts', async t => {
    const api = apiFixture({
        cli: 'aside', workingDir: '/fixture', permissions: 'auto',
        perCli: { aside: { account: 'u1', host: 'local', model: 'vendor/second', effort: 'high' }, claude: { model: 'sonnet' } },
        activeOverrides: { aside: { model: '', effort: '' } }, fallbackOrder: ['claude'],
    });
    const view = await mount(t, Agent, api.client);
    await view.choose('agent-aside-model', 'custom/no-thinking');
    await view.choose('agent-aside-effort', '(default)');
    assert.equal(view.dirty.pending.get('activeOverrides.aside.effort')?.value, 'default');
    await view.save();
    const snapshot = api.snapshot() as { perCli: Record<string, { effort: string }>; activeOverrides: Record<string, { model: string; effort: string }> };
    const effectiveEffort = snapshot.activeOverrides['aside']!.effort || snapshot.perCli['aside']!.effort || 'default';
    assert.equal(effectiveEffort, 'default');
    assert.equal(resolveAsideSelection(catalog('u1'), snapshot.activeOverrides['aside']!.model, effectiveEffort).effort, null);
    assert.equal(view.container.querySelector('#agent-aside-effort')!.textContent, '(default)');
});

test('Agent CLI switch roundtrip restores pending Aside model and effort without an account edit', async t => {
    const api = apiFixture(), view = await mount(t, Agent, api.client);
    await view.choose('agent-aside-model', 'vendor/first');
    await view.choose('agent-aside-effort', 'low');
    assert.equal(view.dirty.pending.has('perCli.aside.account'), false);
    await view.choose('agent-cli', 'Claude');
    await view.choose('agent-cli', 'Aside');
    assert.equal(view.container.querySelector('#agent-aside-model')!.textContent, 'vendor/first');
    assert.equal(view.container.querySelector('#agent-aside-effort')!.textContent, 'low');
    await view.save();
    assert.deepEqual((api.writes[0]!['activeOverrides'] as Record<string, unknown>)['aside'], { model: 'vendor/first', effort: 'low' });
});
