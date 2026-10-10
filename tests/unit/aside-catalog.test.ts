import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsideCatalogError, readAsideCatalog, resolveAsideSelection } from '../../src/agent/aside-catalog.ts';
import type { AsideContext } from '../../src/shared/aside-contract.ts';

const context: AsideContext = { account: 'u0', host: 'local' };
const secret = 'FIXTURE_CREDENTIAL_DO_NOT_EXPOSE';
async function fixture(t: test.TestContext) {
    const homeDir = await mkdtemp(join(tmpdir(), 'jaw-aside-catalog-'));
    t.after(() => rm(homeDir, { recursive: true, force: true }));
    for (const account of ['0', '1']) await mkdir(join(homeDir, '.aside', 'u', account), { recursive: true });
    const path = (file: string, account = '0') => join(homeDir, '.aside', 'u', account, file);
    const put = (file: string, data: unknown, account = '0') => writeFile(path(file, account), JSON.stringify(data));
    return { homeDir, path, put, read: (selected = context) => readAsideCatalog(selected, { homeDir }) };
}
const model = (id = 'family/model', extra: Record<string, unknown> = {}) => ({
    id, name: 'Fixture Model', reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', high: 'high', max: 0 },
    input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, ...extra,
});
const models = (rows: unknown[] = [model()]) => ({ providers: { custom: { models: rows } } });
function error(code: string) {
    return (value: unknown) => value instanceof AsideCatalogError && value.code === code
        && !value.message.includes(secret);
}

test('explicit account/host rejects traversal, remote and absent context before any file lookup', async () => {
    for (const account of ['', '../1', 'u../1', 'u01', 'u-1', 'u1234567890', secret]) {
        await assert.rejects(readAsideCatalog({ account, host: 'local' }, { homeDir: '/does-not-exist' }), error('invalid_context'));
    }
    await assert.rejects(readAsideCatalog({ account: 'u0', host: 'remote' } as unknown as AsideContext), error('unsupported_host'));
    await assert.rejects(readAsideCatalog({ account: 'u0' } as AsideContext), error('unsupported_host'));
});

test('projects exact registered metadata, non-null maps and separate cached provenance without credentials', async t => {
    const f = await fixture(t);
    await f.put('models.json', { apiKey: secret, providers: {
        custom: { apiKey: secret, headers: { Authorization: secret }, models: [model('family/model', { apiKey: secret, extra: { token: secret } })], accountModelCatalog: { modelIds: ['family/model', 'cached-only'], credentialFingerprint: secret } },
        other: { models: [model('family/model', { thinkingLevelMap: { high: 'HIGH', ultra: null } })] },
    } });
    await f.put('settings.json', { defaultModel: { provider: 'other', modelId: 'family/model', thinkingLevel: 'high', fastMode: false, token: secret }, mcp: { token: secret } });
    const catalog = await f.read();
    assert.equal(catalog.status, 'available');
    assert.equal(catalog.source, 'local-files');
    assert.deepEqual(catalog.entries[0], {
        id: 'custom/family/model', provider: 'custom', modelId: 'family/model', name: 'Fixture Model',
        efforts: ['low', 'high', 'max'], thinkingLevelMap: { low: 'low', high: 'high', max: 0 }, capability: 'registered',
        reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000,
    });
    assert.deepEqual(catalog.cachedIds, [
        { id: 'custom/family/model', provider: 'custom', modelId: 'family/model', capability: 'unknown' },
        { id: 'custom/cached-only', provider: 'custom', modelId: 'cached-only', capability: 'unknown' },
    ]);
    assert.deepEqual(catalog.configuredDefault, { provider: 'other', modelId: 'family/model', thinkingLevel: 'high', fastMode: false });
    assert.equal(JSON.stringify(catalog).includes(secret), false);
    assert.deepEqual(resolveAsideSelection(catalog), { account: 'u0', host: 'local', provider: 'other', modelId: 'family/model', model: 'other/family/model', effort: 'high' });
    assert.equal(resolveAsideSelection(catalog, 'custom/family/model', 'low').effort, 'low');
    assert.throws(() => resolveAsideSelection(catalog, 'family/model'), error('model_unavailable'));
    assert.throws(() => resolveAsideSelection(catalog, 'custom/cached-only'), error('model_unavailable'));
    assert.throws(() => resolveAsideSelection(catalog, 'custom/family/model', 'off'), error('effort_unavailable'));
    assert.throws(() => resolveAsideSelection(catalog, 'custom/family/model', 'ultra'), error('effort_unavailable'));
    assert.throws(() => resolveAsideSelection(catalog, 'custom/family/model', 'ultrabrowse'), error('effort_unavailable'));
});

test('two profiles stay isolated; replacement and settings changes are read fresh and failures forget old data', async t => {
    const f = await fixture(t);
    await f.put('models.json', models());
    await f.put('models.json', models([model('second')]), '1');
    assert.equal((await f.read({ account: 'u1', host: 'local' })).entries[0]?.id, 'custom/second');
    await f.put('settings.json', { defaultModel: { provider: 'custom', modelId: 'family/model', thinkingLevel: 'low' } });
    assert.equal(resolveAsideSelection(await f.read()).effort, 'low');
    await f.put('replacement.json', models([model('new')]));
    await rename(f.path('replacement.json'), f.path('models.json'));
    await f.put('settings.json', { defaultModel: { provider: 'custom', modelId: 'new', thinkingLevel: 'high' } });
    assert.equal(resolveAsideSelection(await f.read()).model, 'custom/new');
    await writeFile(f.path('models.json'), `{invalid ${secret}`);
    const failed = await f.read();
    assert.deepEqual(failed.entries, []);
    assert.deepEqual(failed.cachedIds, []);
    assert.deepEqual(failed.diagnostics, [{ source: 'models', code: 'malformed_catalog', message: 'Aside catalog data is malformed.' }]);
    assert.equal(JSON.stringify(failed).includes(secret), false);
    assert.throws(() => resolveAsideSelection(failed), error('catalog_unavailable'));
    assert.equal((await f.read({ account: 'u2', host: 'local' })).status, 'unavailable');
});

test('missing and empty inventory never invent defaults or completeness; default-only is partial', async t => {
    const f = await fixture(t);
    const absent = await f.read();
    assert.equal(absent.status, 'unavailable');
    assert.equal(absent.defaultModel, null);
    assert.throws(() => resolveAsideSelection(absent), error('catalog_unavailable'));
    await f.put('models.json', models([]));
    await f.put('settings.json', {});
    assert.equal((await f.read()).status, 'unavailable');
    await f.put('settings.json', { defaultModel: { provider: 'builtin', modelId: 'observed-default', thinkingLevel: 'medium', fastMode: true } });
    const observed = await f.read();
    assert.equal(observed.status, 'partial');
    assert.equal(observed.entries.length, 0);
    assert.equal(observed.defaultModel, 'builtin/observed-default');
    assert.equal(resolveAsideSelection(observed).effort, 'medium');
    assert.throws(() => resolveAsideSelection(observed, 'default', 'high'), error('effort_unavailable'));
    await f.put('settings.json', {});
    await f.put('models.json', models());
    const noDefault = await f.read();
    assert.equal(noDefault.defaultModel, null);
    assert.throws(() => resolveAsideSelection(noDefault), error('default_unavailable'));
});

test('cached-only IDs and absent capability maps do not advertise inferred effort support', async t => {
    const f = await fixture(t);
    await f.put('models.json', { providers: { builtin: { accountModelCatalog: { modelIds: ['cached'] } } } });
    const cached = await f.read();
    assert.equal(cached.status, 'partial');
    assert.deepEqual(cached.entries, []);
    assert.throws(() => resolveAsideSelection(cached, 'builtin/cached'), error('model_unavailable'));
    await f.put('models.json', models([{ id: 'unknown' }]));
    const unknown = await f.read();
    assert.deepEqual(unknown.entries[0], { id: 'custom/unknown', provider: 'custom', modelId: 'unknown', name: 'unknown', efforts: [], thinkingLevelMap: {}, capability: 'unknown' });
    assert.equal(resolveAsideSelection(unknown, 'custom/unknown').effort, null);
    assert.throws(() => resolveAsideSelection(unknown, 'custom/unknown', 'high'), error('effort_unavailable'));
});

test('duplicate identities reject the whole models file; same raw IDs across providers remain distinct', async t => {
    const f = await fixture(t);
    for (const data of [models([model(), model()]), { providers: { a: { accountModelCatalog: { modelIds: ['x', 'x'] } } } }]) {
        await f.put('models.json', data);
        const catalog = await f.read();
        assert.deepEqual(catalog.entries, []);
        assert.deepEqual(catalog.cachedIds, []);
        assert.equal(catalog.diagnostics[0]?.code, 'duplicate_model');
    }
    await f.put('models.json', { providers: { a: { models: [model()] }, b: { models: [model()] } } });
    assert.deepEqual((await f.read()).entries.map(row => row.id), ['a/family/model', 'b/family/model']);
    await f.put('models.json', { providers: { 'a/b': { models: [{ id: 'c' }] }, a: { models: [{ id: 'b/c' }] } } });
    assert.equal((await f.read()).diagnostics[0]?.code, 'malformed_catalog');
});

test('malformed data and bounded metadata produce stable diagnostics with no raw payload', async t => {
    const f = await fixture(t);
    const bad = [null, [], { providers: [] }, models([null]), models([{ id: '../other' }]),
        models([model('ok', { name: 'x'.repeat(257) })]), models([model('ok', { id: 'x'.repeat(257) })]),
        models([model('ok', { input: ['text', secret] })]), models([model('ok', { reasoning: secret })]),
        models([model('ok', { maxTokens: -1 })]), models([model('ok', { contextWindow: 1.5 })]),
        models([model('ok', { thinkingLevelMap: { low: { apiKey: secret } } })]),
    ];
    for (const data of bad) {
        await f.put('models.json', data);
        const catalog = await f.read();
        assert.equal(catalog.status, 'unavailable');
        assert.equal(catalog.diagnostics[0]?.code, 'malformed_catalog');
        assert.equal(JSON.stringify(catalog).includes(secret), false);
    }
    await f.put('models.json', models());
    await f.put('settings.json', { defaultModel: { provider: secret } });
    const partial = await f.read();
    assert.equal(partial.status, 'partial');
    assert.equal(partial.defaultModel, null);
    assert.equal(partial.diagnostics[0]?.source, 'settings');
    assert.equal(resolveAsideSelection(partial, 'custom/family/model', 'high').effort, 'high');
});

test('enforces byte, provider, per-provider model, total model and cached count limits', async t => {
    const f = await fixture(t);
    for (const source of ['models', 'settings']) {
        await writeFile(f.path(`${source}.json`), ' '.repeat(2 * 1024 * 1024 + 1));
        assert.ok((await f.read()).diagnostics.some(row => row.source === source && row.code === 'limit_exceeded'));
        await f.put(`${source}.json`, {});
    }
    const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));
    for (const data of [
        { providers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, {}])) },
        models(makeRows(513)),
        { providers: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}`, { models: makeRows(512) }])) },
        { providers: { p: { accountModelCatalog: { modelIds: makeRows(2049).map(row => row.id) } } } },
    ]) {
        await f.put('models.json', data);
        const catalog = await f.read();
        assert.deepEqual(catalog.entries, []);
        assert.equal(catalog.diagnostics[0]?.code, 'limit_exceeded');
    }
    await f.put('models.json', models(makeRows(512)));
    assert.equal((await f.read()).entries.length, 512);
});

test('profile, account root, file symlinks and hard links cannot import another account', async t => {
    const f = await fixture(t);
    await f.put('models.json', models([model('private-profile')]), '1');
    await symlink(f.path('models.json', '1'), f.path('models.json'));
    assert.equal((await f.read()).diagnostics[0]?.code, 'unsafe_path');
    await rm(f.path('models.json'));
    await link(f.path('models.json', '1'), f.path('models.json'));
    assert.equal((await f.read()).diagnostics[0]?.code, 'unsafe_path');
    await rm(join(f.homeDir, '.aside', 'u', '0'), { recursive: true });
    await symlink(join(f.homeDir, '.aside', 'u', '1'), join(f.homeDir, '.aside', 'u', '0'));
    const linked = await f.read();
    assert.equal(linked.status, 'unavailable');
    assert.deepEqual(linked.entries, []);
    assert.equal(linked.diagnostics[0]?.code, 'unsafe_path');
    await rm(join(f.homeDir, '.aside', 'u', '0'));
    await rename(join(f.homeDir, '.aside', 'u'), join(f.homeDir, '.aside', 'profiles'));
    await symlink(join(f.homeDir, '.aside', 'profiles'), join(f.homeDir, '.aside', 'u'));
    assert.equal((await f.read()).diagnostics[0]?.code, 'unsafe_path');
});

test('discovery preserves settings/model bytes and a mismatched preferred effort never silently degrades', async t => {
    const f = await fixture(t);
    await f.put('models.json', models());
    await f.put('settings.json', { defaultModel: { provider: 'custom', modelId: 'family/model', thinkingLevel: 'xhigh' } });
    const before = await readFile(f.path('settings.json'), 'utf8');
    const catalog = await f.read();
    assert.throws(() => resolveAsideSelection(catalog), error('effort_unavailable'));
    assert.throws(() => resolveAsideSelection(catalog, 'custom/family/model', secret), error('effort_unavailable'));
    assert.equal(await readFile(f.path('settings.json'), 'utf8'), before);
});


test('unsupported advertised ultra/ultrabrowse cannot become executable efforts', async t => {
    const f = await fixture(t);
    await f.put('models.json', models([model('ok', { thinkingLevelMap: { high: 'high', ultra: 'ultra', ultrabrowse: 'ultrabrowse' } })]));
    const catalog = await f.read();
    assert.deepEqual(catalog.entries[0]?.efforts, ['high']);
    assert.deepEqual(catalog.entries[0]?.thinkingLevelMap, { high: 'high' });
    for (const level of ['ultra', 'ultrabrowse']) {
        assert.throws(() => resolveAsideSelection(catalog, 'custom/ok', level), error('effort_unavailable'));
        await f.put('settings.json', { defaultModel: { provider: 'custom', modelId: 'ok', thinkingLevel: level } });
        const invalid = await f.read();
        assert.equal(invalid.defaultModel, null);
        assert.equal(invalid.diagnostics[0]?.code, 'malformed_catalog');
    }
});


test('caller context changes during an async read cannot redirect the captured profile', async t => {
    const f = await fixture(t);
    await f.put('models.json', models([model('original')]));
    await f.put('models.json', models([model('different')]), '1');
    const mutable: AsideContext = { account: 'u0', host: 'local' };
    const reading = f.read(mutable);
    mutable.account = 'u1';
    const catalog = await reading;
    assert.equal(catalog.context.account, 'u0');
    assert.equal(catalog.entries[0]?.modelId, 'original');
});

test('a profile directory replaced between or after file reads discards the whole projection', async t => {
    for (const swapAfter of ['models', 'settings'] as const) {
        const f = await fixture(t);
        await f.put('models.json', models([model('original')]));
        const replacement = join(f.homeDir, '.aside', 'u', 'replacement');
        await mkdir(replacement);
        await writeFile(join(replacement, 'models.json'), JSON.stringify(models([model('swapped')])));
        await writeFile(join(replacement, 'settings.json'), JSON.stringify({ defaultModel: { provider: 'custom', modelId: 'swapped' } }));
        const catalog = await readAsideCatalog(context, { homeDir: f.homeDir, afterRead: async source => {
            if (source !== swapAfter) return;
            await rename(join(f.homeDir, '.aside', 'u', '0'), join(f.homeDir, '.aside', 'u', 'old'));
            await rename(replacement, join(f.homeDir, '.aside', 'u', '0'));
        } });
        assert.equal(catalog.status, 'unavailable', swapAfter);
        assert.deepEqual(catalog.entries, []);
        assert.deepEqual(catalog.cachedIds, []);
        assert.equal(catalog.defaultModel, null);
        assert.equal(catalog.configuredDefault, null);
        assert.ok(catalog.diagnostics.length > 0 && catalog.diagnostics.every(d => d.code === 'unsafe_path'));
        assert.throws(() => resolveAsideSelection(catalog), error('catalog_unavailable'));
    }
});
