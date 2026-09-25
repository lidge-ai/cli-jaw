import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeProviders } from '../../src/code-mode/providers/catalog.ts';
import type { ProviderLiveModels } from '../../src/code-mode/providers/provider-live-models.ts';

const available = () => ({ available: true, path: '/usr/local/bin/stub', rejected: [] });

function providersWith(live: Partial<Record<string, ProviderLiveModels>>) {
    return createCodeProviders({
        detect: available as never,
        liveModels: () => null,
        providerLiveModels: (id) => live[id] ?? null,
    });
}

test('PLM-001: a live snapshot replaces the registry list and marks the source', () => {
    const providers = providersWith({
        cursor: { models: ['composer-2.5', 'grok-4.6'], source: 'cursor-agent --list-models' },
    });
    const catalog = providers.cursor.describe();
    assert.deepEqual(catalog.models, ['composer-2.5', 'grok-4.6']);
    assert.equal(catalog.modelSource, 'live');
});

test('PLM-002: no snapshot leaves the registry list standing', () => {
    const catalog = providersWith({}).cursor.describe();
    assert.equal(catalog.modelSource, 'registry');
    assert.ok(catalog.models.length > 0);
});

test('PLM-003: an empty snapshot is treated as no snapshot', () => {
    // Adopting it would make every model unselectable, since validate() checks
    // the requested model against catalog.models.
    const catalog = providersWith({ cursor: { models: [], source: 'x' } }).cursor.describe();
    assert.equal(catalog.modelSource, 'registry');
    assert.ok(catalog.models.length > 0);
});

test('PLM-004: per-model efforts ride along when the source has them', () => {
    const catalog = providersWith({
        claude: {
            models: ['claude-opus-5', 'claude-haiku-4-5'],
            effortsByModel: {
                'claude-opus-5': ['low', 'high', 'ultracode'],
                'claude-haiku-4-5': ['low', 'high'],
            },
            source: 'claude-bundle',
        },
    }).claude.describe();
    assert.deepEqual(catalog.effortsByModel?.['claude-opus-5'], ['low', 'high', 'ultracode']);
    assert.equal(catalog.effortsByModel?.['claude-haiku-4-5']?.includes('ultracode'), false);
});

test('PLM-005: a default the live catalog dropped falls back to its first model', () => {
    // Keeping it would fail validate() on the very first session.
    const catalog = providersWith({
        cursor: { models: ['composer-9'], source: 'x' },
    }).cursor.describe();
    assert.equal(catalog.defaultModel, 'composer-9');
});

test('PLM-006: a default the live catalog still serves is preserved', () => {
    const registryDefault = providersWith({}).cursor.describe().defaultModel;
    const catalog = providersWith({
        cursor: { models: ['other', registryDefault], source: 'x' },
    }).cursor.describe();
    assert.equal(catalog.defaultModel, registryDefault);
});

test('PLM-007: codex-app keeps its own Codex snapshot path', () => {
    // Passing a provider snapshot for codex-app must not hijack the opencodex
    // reader, whose per-model efforts and routed ids are shaped differently.
    const catalog = providersWith({
        'codex-app': { models: ['hijacked'], source: 'x' },
    })['codex-app'].describe();
    assert.equal(catalog.models.includes('hijacked'), false);
    assert.equal(catalog.modelSource, 'registry');
});

test('PLM-008: reading a catalog never spawns a CLI for cursor or grok', async () => {
    // The rule catalog.ts states: catalogs must never execute a CLI or a login
    // probe. Reads go through the shared snapshot, which only an explicit prime
    // fills for these two. This file exercises the snapshot reader in isolation;
    // the composed HTTP/host proof is CODE-INT-009 (code-native-api.test.ts)
    // and the prime() contract tests in code-native-host.test.ts.
    const { readProviderLiveModels, resetProviderLiveModelsForTest } =
        await import('../../src/code-mode/providers/provider-live-models.ts');
    resetProviderLiveModelsForTest();
    assert.equal(readProviderLiveModels('cursor'), null);
    assert.equal(readProviderLiveModels('grok'), null);
});

test('PLM-009: a seeded snapshot is readable without any probe', async () => {
    const { readProviderLiveModels, resetProviderLiveModelsForTest } =
        await import('../../src/code-mode/providers/provider-live-models.ts');
    resetProviderLiveModelsForTest({ grok: { models: ['grok-4.6'], source: 'grok models' } });
    assert.deepEqual(readProviderLiveModels('grok')?.models, ['grok-4.6']);
    resetProviderLiveModelsForTest();
});
