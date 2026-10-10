import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><select id="selCli"><option value="aside">Aside</option></select><div><select id="selModel"></select></div><select id="selEffort"></select><select id="flushCli"><option value="">active</option></select><select id="flushModel"></select><div id="heartbeatModal"><div id="hbJobsList"></div></div></body></html>', { url: 'http://localhost/' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, navigator: dom.window.navigator };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
const writes: unknown[] = [];
let model = 'default', effort = 'low';
let mainCli = 'aside';
let activeOverrides: { aside: { model: string; effort: string } } | undefined;
let pickerReadGate: Promise<void> | null = null;
let settingsReads = 0;
mock.module('../../public/js/provider-icons.js', { namedExports: { providerIcon: () => '', providerLabel: (value: string) => value } });
mock.module('../../public/js/api.js', { namedExports: {
    API_BASE: '', getAuthToken: async () => '', apiFire: async () => {},
    api: async (path: string) => path.startsWith('/api/i18n/') ? JSON.parse(readFileSync(new URL(`../../public/locales/${path.split('/').at(-1)}.json`, import.meta.url), 'utf8')) : path === '/api/heartbeat' ? { jobs: [] } : path === '/api/cli-registry' ? {
        aside: { label: 'Aside', models: ['default', 'vendor/first', 'vendor/second', 'custom/no-thinking'], efforts: ['low', 'high'], observedDefaultModel: 'vendor/first',
            effortsByModel: { default: ['low'], 'vendor/first': ['low'], 'vendor/second': ['high'], 'custom/no-thinking': [] } },
        claude: { label: 'Claude', models: ['sonnet'], efforts: [] },
    } : path === '/api/settings' ? await (async () => {
        settingsReads++;
        if (pickerReadGate && settingsReads > 1) await pickerReadGate;
        return { cli: mainCli, perCli: { aside: { model, effort } }, activeOverrides };
    })() : path === '/api/memory-files' ? { cli: '', model: 'default' } : null,
    apiJson: async (_path: string, _method: string, body: unknown) => { writes.push(body); return {}; },
} });
const { initI18n, t: translate } = await import('../../public/js/features/i18n');
const { openHeartbeatModal } = await import('../../public/js/features/heartbeat');
const { loadCliRegistry } = await import('../../public/js/constants');
const { loadSettings, onCliChange, saveActiveCliSettings, loadFlushAgentSidebar } = await import('../../public/js/features/settings-core');
after(() => { mock.restoreAll(); dom.window.close(); for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
} });
const select = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('Classic live picker labels concrete default, narrows effort, excludes custom entry/cached additions and reads never save', async () => {
    await loadCliRegistry(); onCliChange(false); await settle();
    assert.equal(select('selModel').selectedOptions[0]!.textContent, 'Default (vendor/first)');
    assert.deepEqual(Array.from(select('selEffort').options, o => o.value), ['', 'low']);
    assert.ok(!document.getElementById('selModelCustom'));
    assert.ok(!Array.from(select('selModel').options).some(o => o.value === '__custom__'));
    assert.equal(writes.length, 0);
    select('selModel').value = 'vendor/second'; select('selEffort').value = '';
    select('selModel').dispatchEvent(new dom.window.Event('change')); await settle();
    assert.deepEqual(Array.from(select('selEffort').options, o => o.value), ['', 'high']);
    select('selEffort').value = 'high'; await saveActiveCliSettings();
    assert.deepEqual(writes.at(-1), { activeOverrides: { aside: { model: 'vendor/second', effort: 'high' } } });
});
test('Classic preserves unavailable saved model and effort, blocks save, disables inherited Aside flush', async () => {
    const count = writes.length; model = 'cache/only'; effort = 'max';
    onCliChange(false); await settle();
    assert.equal(select('selModel').value, 'cache/only');
    assert.equal(select('selModel').selectedOptions[0]!.textContent, 'cache/only (unavailable)');
    assert.equal(select('selEffort').value, 'max');
    assert.match(select('selEffort').selectedOptions[0]!.textContent!, /unavailable/);
    await saveActiveCliSettings(); assert.equal(writes.length, count);
    await loadFlushAgentSidebar(); assert.equal(select('flushModel').disabled, true);
    assert.equal(writes.length, count);
});

test('Classic explicit default effort persists sentinel instead of inheriting saved high on a no-effort model', async () => {
    model = 'vendor/second'; effort = 'high'; onCliChange(false); await settle();
    select('selModel').value = 'custom/no-thinking';
    select('selModel').dispatchEvent(new dom.window.Event('change')); await settle();
    // A saved incompatible effort stays visible until the user explicitly picks default.
    select('selEffort').value = ''; await saveActiveCliSettings();
    const patch = writes.at(-1) as { activeOverrides: { aside: { model: string; effort: string } } };
    assert.deepEqual(patch.activeOverrides.aside, { model: 'custom/no-thinking', effort: 'default' });
    const effectiveEffort = patch.activeOverrides.aside.effort || effort || 'default';
    assert.equal(effectiveEffort, 'default');
});

test('Classic reload and picker read inherit saved high through cleared Aside overrides', async () => {
    model = 'vendor/second'; effort = 'high'; activeOverrides = { aside: { model: '', effort: '' } };
    settingsReads = 0;
    const gate = Promise.withResolvers<void>(); pickerReadGate = gate.promise;
    const count = writes.length;
    try {
        // Hold the picker's second GET so the full reload path is asserted independently.
        await loadSettings();
        assert.equal(select('selModel').value, 'vendor/second');
        assert.equal(select('selEffort').value, 'high');
        assert.equal(writes.length, count);
    } finally { gate.resolve(); pickerReadGate = null; }
    await settle();
    assert.equal(select('selEffort').value, 'high');
    onCliChange(false); await settle();
    assert.equal(select('selEffort').value, 'high');
    assert.equal(writes.length, count);
    select('selModel').value = 'custom/no-thinking';
    select('selModel').dispatchEvent(new dom.window.Event('change')); await settle();
    assert.equal(select('selEffort').value, 'high');
    assert.match(select('selEffort').selectedOptions[0]!.textContent!, /unavailable/);
    assert.equal(writes.length, count);
    select('selEffort').value = ''; await saveActiveCliSettings();
    assert.deepEqual(writes.at(-1), { activeOverrides: { aside: { model: 'custom/no-thinking', effort: 'default' } } });
});

test('Classic Aside picker and heartbeat modal explain scheduled rejection in all shipped locales; other main runtime clears notice', async () => {
    await loadCliRegistry();
    for (const locale of ['en', 'ko', 'ja', 'zh']) {
        localStorage.setItem('claw_locale', locale); await initI18n();
        const dict = JSON.parse(readFileSync(new URL(`../../public/locales/${locale}.json`, import.meta.url), 'utf8'));
        assert.ok(dict['cli.asideHelp']); assert.ok(dict['hb.asideUnsupported']);
        select('selCli').value = 'aside'; onCliChange(false); await settle();
        assert.equal(select('selModel').title, dict['cli.asideHelp']);
        if (locale === 'en') {
            assert.match(select('selModel').title, /Scheduled heartbeat runs are unsupported.*will be rejected/);
            assert.match(translate('hb.asideUnsupported'), /Choose another main runtime in Agent settings/);
        }
        mainCli = 'aside'; await openHeartbeatModal();
        const notice = document.querySelector('#hbJobsList [role="status"]');
        assert.ok(notice); assert.equal(notice.textContent, dict['hb.asideUnsupported']);
        mainCli = 'claude'; await openHeartbeatModal();
        assert.equal(document.querySelector('#hbJobsList [role="status"]'), null);
    }
    mainCli = 'aside';
});
