import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { SettingsData } from '../../public/js/features/settings-types.ts';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const registry = {
    a: { label: 'Runtime A', models: ['a-default', 'a-local'], efforts: ['low', 'high'] },
    b: { label: 'Runtime B', models: ['b-default', 'b-local'], efforts: ['low', 'high'] },
    split: {
        label: 'Split Runtime',
        defaultProvider: 'alpha',
        providers: ['alpha', 'beta'],
        models: [],
        efforts: [],
        modelsByProvider: {
            alpha: ['alpha-default', 'alpha-local'],
            beta: ['beta-default', 'beta-local'],
        },
        effortsByProvider: { alpha: ['low', 'high'], beta: ['high'] },
    },
};
const reads: Array<Deferred<SettingsData | null>> = [];
const writes: unknown[] = [];

mock.module('../../public/js/provider-icons.js', { namedExports: {
    providerIcon: () => '', providerLabel: (value: string) => value,
} });
mock.module('../../public/js/api.js', { namedExports: {
    API_BASE: '',
    getAuthToken: async () => '',
    apiFire: async () => {},
    api: async (path: string) => {
        if (path === '/api/cli-registry') return registry;
        if (path === '/api/settings') {
            const read = deferred<SettingsData | null>();
            reads.push(read);
            return read.promise;
        }
        return null;
    },
    apiJson: async (_path: string, _method: string, body: unknown) => {
        writes.push(body);
        return { cli: selectedCli() };
    },
} });

let picker: typeof import('../../public/js/features/settings-core.ts');

function selectedCli(): string {
    return document.querySelector<HTMLSelectElement>('#selCli')?.value || '';
}

function modelSelect(): HTMLSelectElement {
    const element = document.querySelector<HTMLSelectElement>('#selModel');
    assert.ok(element);
    return element;
}

function effortSelect(): HTMLSelectElement {
    const element = document.querySelector<HTMLSelectElement>('#selEffort');
    assert.ok(element);
    return element;
}

function providerSelect(): HTMLSelectElement {
    const element = document.querySelector<HTMLSelectElement>('#selCliProvider');
    assert.ok(element);
    return element;
}

function choose(cli: string): Deferred<SettingsData | null> {
    const before = reads.length;
    const select = document.querySelector<HTMLSelectElement>('#selCli')!;
    select.value = cli;
    picker.onCliChange(false);
    assert.equal(reads.length, before + 1, `selecting ${cli} starts one settings read`);
    return reads.at(-1)!;
}

function snapshot(cli: string, model: string, effort: string, provider?: string): SettingsData {
    return {
        cli,
        workingDir: '/fixture',
        permissions: 'safe',
        perCli: { [cli]: { model, effort, ...(provider ? { provider } : {}) } },
    };
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

test.before(async () => {
    setupWebUiDom();
    const constants = await import('../../public/js/constants.ts');
    await constants.loadCliRegistry();
    picker = await import('../../public/js/features/settings-core.ts');
});

test.beforeEach(() => {
    reads.length = 0;
    writes.length = 0;
    document.body.innerHTML = `
        <span id="headerCli"></span>
        <select id="selCli">
            <option value="a">Runtime A</option>
            <option value="b">Runtime B</option>
            <option value="split">Split Runtime</option>
            <option value="jwc">JWC retired</option>
        </select>
        <div id="cliProviderWrap"><label id="cliProviderLabel"></label><select id="selCliProvider"></select></div>
        <div id="modelOwner"><select id="selModel"></select></div>
        <select id="selEffort"></select>`;
});

test.after(() => { resetWebUiDom(); mock.restoreAll(); });

test('superseded A/B reads cannot replace the current B picker state', async () => {
    const readA = choose('a');
    const readB = choose('b');

    readB.resolve(snapshot('b', 'b-local', 'high'));
    await flush();
    assert.equal(selectedCli(), 'b');
    assert.equal(modelSelect().value, 'b-local');
    assert.equal(effortSelect().value, 'high');

    readA.resolve(snapshot('a', 'a-local', 'low'));
    await flush();
    assert.equal(selectedCli(), 'b');
    assert.equal(modelSelect().value, 'b-local');
    assert.equal(effortSelect().value, 'high');
});

test('A to B to A rejects the first A response even though the CLI value matches again', async () => {
    const firstA = choose('a');
    const readB = choose('b');
    const currentA = choose('a');

    currentA.resolve(snapshot('a', 'a-local', 'high'));
    await flush();
    firstA.resolve(snapshot('a', 'a-default', 'low'));
    readB.resolve(snapshot('b', 'b-local', 'low'));
    await flush();

    assert.equal(selectedCli(), 'a');
    assert.equal(modelSelect().value, 'a-local');
    assert.equal(effortSelect().value, 'high');
});

test('a current read cannot overwrite model and effort edits made while it is pending', async () => {
    const readB = choose('b');
    modelSelect().value = 'b-local';
    modelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
    effortSelect().value = 'low';
    await picker.saveActiveCliSettings();

    readB.resolve(snapshot('b', 'b-default', 'high'));
    await flush();
    assert.equal(modelSelect().value, 'b-local');
    assert.equal(effortSelect().value, 'low');
});

test('custom model typing invalidates a pending read before the value is committed', async () => {
    const readB = choose('b');
    modelSelect().value = '__custom__';
    modelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>('#selModelCustom')!;
    input.value = 'typed-model';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    readB.resolve(snapshot('b', 'b-default', 'high'));
    await flush();
    assert.equal(modelSelect().value, '__custom__');
    assert.equal(input.value, 'typed-model');
    assert.equal(input.style.display, 'block');
});

test('provider changes preserve the new provider and its locally selected model', async () => {
    const alphaRead = choose('split');
    assert.equal(providerSelect().value, 'alpha');

    providerSelect().value = 'beta';
    const betaRead = choose('split');
    modelSelect().value = 'beta-local';
    await picker.saveActiveCliSettings();

    alphaRead.resolve(snapshot('split', 'alpha-local', 'low', 'alpha'));
    betaRead.resolve(snapshot('split', 'beta-default', 'high', 'beta'));
    await flush();
    assert.equal(providerSelect().value, 'beta');
    assert.equal(modelSelect().value, 'beta-local');
});

test('a provider value change invalidates its captured read before the change handler runs', async () => {
    const alphaRead = choose('split');
    const before = { model: modelSelect().value, effort: effortSelect().value };
    providerSelect().value = 'beta';

    alphaRead.resolve(snapshot('split', 'alpha-local', 'low', 'alpha'));
    await flush();
    assert.equal(providerSelect().value, 'beta');
    assert.deepEqual({ model: modelSelect().value, effort: effortSelect().value }, before);
});

test('a provider-mismatched snapshot without a model cannot hydrate its effort', async () => {
    choose('split');
    providerSelect().value = 'beta';
    const betaRead = choose('split');
    const before = { model: modelSelect().value, effort: effortSelect().value };

    betaRead.resolve({
        cli: 'split',
        workingDir: '/fixture',
        permissions: 'safe',
        perCli: { split: { provider: 'alpha', effort: 'high' } },
    });
    await flush();
    assert.equal(providerSelect().value, 'beta');
    assert.deepEqual({ model: modelSelect().value, effort: effortSelect().value }, before);
});

test('a fresh untouched snapshot still hydrates model and effort', async () => {
    const readA = choose('a');
    readA.resolve(snapshot('a', 'a-local', 'high'));
    await flush();
    assert.equal(modelSelect().value, 'a-local');
    assert.equal(effortSelect().value, 'high');
});

test('selecting a retired CLI invalidates the prior read before the early return', async () => {
    const readB = choose('b');
    const before = modelSelect().value;
    const retired = document.querySelector<HTMLSelectElement>('#selCli')!;
    retired.value = 'jwc';
    picker.onCliChange(false);
    assert.equal(modelSelect().disabled, true);

    readB.resolve(snapshot('b', 'b-local', 'high'));
    await flush();
    assert.equal(selectedCli(), 'jwc');
    assert.equal(modelSelect().value, before);
});

test('a response cannot write through a detached picker DOM owner', async () => {
    const readA = choose('a');
    const effortBefore = effortSelect().value;
    const replacement = document.createElement('select');
    replacement.id = 'selModel';
    replacement.innerHTML = '<option value="replacement">replacement</option>';
    modelSelect().replaceWith(replacement);

    readA.resolve(snapshot('a', 'a-local', 'high'));
    await flush();
    assert.equal(modelSelect(), replacement);
    assert.equal(replacement.value, 'replacement');
    assert.equal(effortSelect().value, effortBefore);
});

test('a failed current read leaves the initialized picker unchanged', async () => {
    const readA = choose('a');
    const before = { model: modelSelect().value, effort: effortSelect().value };
    readA.resolve(null);
    await flush();
    assert.deepEqual({ model: modelSelect().value, effort: effortSelect().value }, before);
    assert.deepEqual(writes, []);
});
