import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AsideCatalog, AsideContext } from '../../src/shared/aside-contract.ts';
import type { CompletionCtx } from '../../src/cli/types.ts';
import { AsideCatalogError, resolveAsideSelection } from '../../src/agent/aside-catalog.ts';
import { settings } from '../../src/core/config.ts';

let readContexts: AsideContext[] = [];
let catalog: AsideCatalog | null = null;
let inventoryCalls = 0;
for (const [path, name] of [
    ['kiro-models', 'fetchKiroModelInventory'], ['agy-models', 'fetchAgyModelInventory'],
    ['opencode-models', 'fetchOpencodeModelInventory'], ['copilot-models', 'fetchCopilotModelInventory'],
    ['cursor-model-inventory', 'fetchCursorModelInventory'], ['grok-models', 'fetchGrokModelInventory'],
]) {
    mock.module(`../../src/agent/${path}.js`, { namedExports: {
        [name!]: async () => { inventoryCalls++; return null; },
    } });
}
mock.module('../../src/core/cli-detection.js', { namedExports: { detectCli: () => ({ available: false }), detectAllCli: () => ({}) } });
mock.module('../../src/cli/claude-model-discovery.js', { namedExports: {
    claudeCatalogToChoices: () => [], resolveClaudeBundleCatalog: async () => null,
} });
mock.module('../../src/cli/opencodex-runtime.js', { namedExports: {
    resolveOpenCodexRuntime: async () => null, diagnoseOpenCodexExecution: () => null,
} });
mock.module('../../src/cli/opencodex-models.js', { namedExports: {
    resolveOpenCodexCodexModels: async () => [],
    resolveOpenCodexCodexModelsDetailed: async () => ({ models: [], entries: [], source: 'static' }),
    applyCodexModelsToChoices: (choices: Record<string, string[]>) => choices,
} });
mock.module('../../src/agent/aside-catalog.js', { namedExports: {
    AsideCatalogError, resolveAsideSelection,
    readAsideCatalog: async (context: AsideContext) => {
        readContexts.push({ ...context });
        if (!catalog) throw new Error('fixture unavailable');
        return { ...structuredClone(catalog), context: { ...context } };
    },
} });
const { buildLiveCliRegistry, projectAsideCatalog } = await import('../../src/cli/registry-live.ts');
const { modelArgumentCompletions, cliArgumentCompletions, employeeArgumentCompletions,
    fallbackArgumentCompletions, flushArgumentCompletions } = await import('../../src/cli/handlers-completions.ts');

function fixture(): AsideCatalog {
    return {
        context: { account: 'u1', host: 'local' }, source: 'local-files', status: 'available', diagnostics: [],
        entries: [
            { id: 'fixture/main', provider: 'fixture', modelId: 'main', name: 'Main', efforts: ['low', 'high'], thinkingLevelMap: { low: 'low', high: 'high' }, capability: 'registered' },
            { id: 'fixture/other', provider: 'fixture', modelId: 'other', name: 'Other', efforts: ['max'], thinkingLevelMap: { max: 'max' }, capability: 'registered' },
        ],
        cachedIds: [{ id: 'fixture/cached', provider: 'fixture', modelId: 'cached', capability: 'unknown' }],
        defaultModel: 'fixture/main', configuredDefault: { provider: 'fixture', modelId: 'main', thinkingLevel: 'low' },
    };
}
const ctx: CompletionCtx = { settings: { cli: 'aside', perCli: {
    aside: { account: 'u1', host: 'local', model: 'fixture/saved' }, claude: { model: 'sonnet' },
}, activeOverrides: { aside: { model: 'fixture/override' } } } };

test('registry projection keeps concrete default metadata narrow and cache IDs unselectable', () => {
    const projected = projectAsideCatalog(fixture());
    assert.deepEqual(projected.models, ['default', 'fixture/main', 'fixture/other']);
    assert.deepEqual(projected.effortsByModel['default'], ['low', 'high']);
    assert.deepEqual(projected.effortsByModel['fixture/other'], ['max']);
    assert.deepEqual(projected.defaultEffortByModel, { default: 'low', 'fixture/main': 'low' });
    assert.equal(projected.observedDefaultModel, 'fixture/main');
    assert.equal(projected.catalogStatus, 'available');
});

test('registered entries without effort metadata remain selectable while cache-only IDs do not', () => {
    const observed = fixture();
    observed.entries.push({ id: 'fixture/unknown-effort', provider: 'fixture', modelId: 'unknown-effort',
        name: 'Unknown effort', efforts: [], thinkingLevelMap: {}, capability: 'unknown' });
    const projected = projectAsideCatalog(observed);
    assert.ok(projected.models.includes('fixture/unknown-effort'));
    assert.deepEqual(projected.effortsByModel['fixture/unknown-effort'], []);
    assert.equal(projected.models.includes('fixture/cached'), false);
    observed.defaultModel = 'fixture/unknown-effort';
    observed.configuredDefault = { provider: 'fixture', modelId: 'unknown-effort' };
    assert.deepEqual(projectAsideCatalog(observed).effortsByModel['default'], []);
    observed.configuredDefault.thinkingLevel = 'high';
    assert.deepEqual(projectAsideCatalog(observed).effortsByModel['default'], ['high']);
    assert.deepEqual(projectAsideCatalog(observed).effortsByModel['fixture/unknown-effort'], ['high']);
});

test('default-only and unavailable inventories preserve truthful status and sentinel resolution', () => {
    const onlyDefault = fixture();
    onlyDefault.entries = [];
    onlyDefault.status = 'partial';
    assert.deepEqual(projectAsideCatalog(onlyDefault).models, ['default', 'fixture/main']);
    assert.deepEqual(projectAsideCatalog(onlyDefault).effortsByModel['default'], ['low']);
    const noDefault = fixture();
    noDefault.defaultModel = null;
    noDefault.configuredDefault = null;
    assert.deepEqual(projectAsideCatalog(noDefault).models, ['fixture/main', 'fixture/other']);
    const unavailable = projectAsideCatalog(null);
    assert.deepEqual(unavailable.models, []);
    assert.equal(unavailable.catalogStatus, 'unavailable');
    assert.equal(unavailable.observedDefaultModel, null);
    const malformed = fixture();
    malformed.status = 'partial';
    malformed.diagnostics = [{ source: 'models', code: 'malformed_catalog', message: 'Aside catalog data is malformed.' }];
    assert.deepEqual(projectAsideCatalog(malformed).models, []);
    assert.deepEqual(projectAsideCatalog(malformed).effortsByModel, {});
    assert.deepEqual(projectAsideCatalog(malformed).modelDetails, []);
    malformed.diagnostics[0]!.source = 'context';
    assert.deepEqual(projectAsideCatalog(malformed).models, []);
    assert.deepEqual(projectAsideCatalog(malformed).catalogDiagnostics, malformed.diagnostics);
});

test('live registry captures the saved account and includes default effort metadata without changing settings', async () => {
    const previous = settings['perCli'];
    try {
        settings['perCli'] = { ...previous, aside: { model: 'fixture/saved', effort: 'high', account: 'u1', host: 'local' } };
        const before = structuredClone(settings);
        readContexts = [];
        catalog = fixture();
        const registry = await buildLiveCliRegistry();
        assert.deepEqual(readContexts, [{ account: 'u1', host: 'local' }]);
        assert.deepEqual(registry['aside']?.['effortsByModel'], { 'fixture/main': ['low', 'high'], 'fixture/other': ['max'], default: ['low', 'high'] });
        assert.equal(registry['aside']?.['defaultModel'], 'default');
        assert.equal(registry['aside']?.['observedDefaultModel'], 'fixture/main');
        assert.deepEqual(settings, before);
        settings['perCli'] = { ...previous, aside: { model: 'default', effort: '', account: '', host: 'local' } };
        catalog = null;
        const unavailable = await buildLiveCliRegistry();
        assert.deepEqual(unavailable['aside']?.['models'], []);
        assert.equal(unavailable['aside']?.['catalogStatus'], 'unavailable');
    } finally { settings['perCli'] = previous; }
});

test('dynamic model completions use selected account and preserve saved/override state without other inventory probes', async () => {
    inventoryCalls = 0;
    readContexts = [];
    catalog = fixture();
    const before = structuredClone(ctx);
    const choices = await modelArgumentCompletions(ctx);
    assert.ok(choices.some(choice => choice.value === 'fixture/main' && choice.label === 'aside'));
    assert.ok(choices.some(choice => choice.value === 'fixture/saved'));
    assert.equal(choices.some(choice => choice.value === 'fixture/cached'), false);
    assert.deepEqual(readContexts, [{ account: 'u1', host: 'local' }]);
    assert.equal(inventoryCalls, 0);
    assert.deepEqual(ctx, before);
    assert.ok(cliArgumentCompletions(ctx).some(choice => choice.value === 'aside'));
});

test('employee, fallback and flush options exclude Aside and never read its catalog', async () => {
    readContexts = [];
    catalog = fixture();
    for (const choices of [await employeeArgumentCompletions(ctx, ['cli']),
        await employeeArgumentCompletions(ctx, ['model', 'Worker']),
        fallbackArgumentCompletions(ctx), await flushArgumentCompletions(ctx)]) {
        assert.equal(choices.some(choice => choice.value === 'aside' || choice.value.startsWith('fixture/')), false);
    }
    assert.deepEqual(readContexts, []);
});

test('missing explicit account or remote host yields no inferred catalog or default model', async () => {
    readContexts = [];
    for (const selector of [{ host: 'local' }, { account: 'u0', host: 'remote' }]) {
        const choices = await modelArgumentCompletions({ settings: { perCli: { aside: selector } } });
        assert.equal(choices.some(choice => choice.label === 'aside'), false);
    }
    assert.deepEqual(readContexts, []);
});
