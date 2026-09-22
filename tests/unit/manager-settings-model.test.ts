// Phase 2 — Model & Provider page helpers.
//
// Validates the pure helpers that drive the Model page: chip-list reorder
// dirty bundles, per-CLI patch construction, and the activeOverrides reset
// patch shape (no DELETE endpoint exists; we synthesize an empty per-cli
// patch instead).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLI_REGISTRY } from '../../src/cli/registry.ts';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import { buildResetOverridesPatch, orderModelCliKeys } from '../../public/manager/src/settings/pages/ModelProvider';
import { metaFor, normalizeCliMetaRegistry, orderRuntimeCliOptions, PRIMARY_CLIS, runtimeModelFor } from '../../public/manager/src/settings/pages/components/agent/agent-meta';
import { piModelOptions } from '../../public/manager/src/settings/pages/components/pi-profile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── ChipListField / fallback order ──────────────────────────────────

test('ChipListField reorder produces a dirty saveBundle in the new order', () => {
    const store = createDirtyStore();
    store.set('fallbackOrder', {
        value: ['codex', 'claude', 'gemini'],
        original: ['claude', 'codex', 'gemini'],
        valid: true,
    });
    const bundle = store.saveBundle();
    assert.deepEqual(bundle, { fallbackOrder: ['codex', 'claude', 'gemini'] });
    const patch = expandPatch(bundle);
    assert.deepEqual(patch, { fallbackOrder: ['codex', 'claude', 'gemini'] });
});

test('Identical fallback order arrays are not dirty', () => {
    const store = createDirtyStore();
    store.set('fallbackOrder', {
        value: ['claude', 'codex'],
        original: ['claude', 'codex'],
        valid: true,
    });
    assert.equal(store.isDirty(), false);
});

// ─── Per-CLI rows ────────────────────────────────────────────────────

test('Per-CLI edits expand to a single perCli node with multiple children', () => {
    const store = createDirtyStore();
    store.set('perCli.codex.model', { value: 'gpt-5.5', original: 'gpt-5.4', valid: true });
    store.set('perCli.codex.effort', { value: 'high', original: 'medium', valid: true });
    store.set('perCli.claude.fastMode', { value: true, original: false, valid: true });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        perCli: {
            codex: { model: 'gpt-5.5', effort: 'high' },
            claude: { fastMode: true },
        },
    });
});

test('Codex-only context-window edits are emitted only when set', () => {
    const store = createDirtyStore();
    store.set('perCli.codex.contextWindowSize', {
        value: 1_200_000,
        original: 1_000_000,
        valid: true,
    });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        perCli: { codex: { contextWindowSize: 1_200_000 } },
    });
});

// ─── Reset overrides ─────────────────────────────────────────────────

test('buildResetOverridesPatch covers every CLI from overrides + perCli', () => {
    const patch = buildResetOverridesPatch({
        perCli: {
            claude: { model: 'x' },
            codex: { model: 'y' },
        },
        activeOverrides: {
            codex: { model: 'override-x' },
            gemini: { model: 'override-y' },
        },
    });
    const keys = Object.keys(patch.activeOverrides).sort();
    assert.deepEqual(keys, ['claude', 'codex', 'gemini']);
    for (const cli of keys) {
        assert.deepEqual(patch.activeOverrides[cli], { model: '', effort: '' });
    }
});

test('buildResetOverridesPatch produces empty top-level when no CLIs known', () => {
    const patch = buildResetOverridesPatch({});
    assert.deepEqual(patch, { activeOverrides: {} });
});

test('buildResetOverridesPatch result PUTs to /api/settings cleanly', () => {
    // Simulate the exact body the page sends: a top-level activeOverrides
    // object with each known CLI cleared.
    const snapshot = {
        perCli: { codex: {}, claude: {} },
        activeOverrides: { codex: { model: 'gpt-5.4', effort: 'high' } },
    };
    const patch = buildResetOverridesPatch(snapshot);
    assert.equal(typeof patch.activeOverrides, 'object');
    assert.equal(patch.activeOverrides.codex.model, '');
    assert.equal(patch.activeOverrides.codex.effort, '');
    // Each CLI from perCli is also enumerated so a future override can't
    // survive the reset just because it's not currently in activeOverrides.
    assert.ok('claude' in patch.activeOverrides);
});

test('Model defaults imports canonical CLI metadata from agent-meta', () => {
    const source = readFileSync('public/manager/src/settings/pages/ModelProvider.tsx', 'utf8');
    assert.ok(source.includes("from './components/agent/agent-meta'"));
    assert.ok(source.includes('Model defaults'));
    assert.deepEqual(metaFor('codex').models, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna']);
    assert.equal(metaFor('agy').label, 'Antigravity');
    // Label form only: AGY rejects a tier-less slug when no --effort is sent,
    // and cli-jaw never sends one for AGY.
    assert.equal(metaFor('agy').models.includes('Gemini 3.6 Flash (Medium)'), true);
    assert.equal(metaFor('agy').models.includes('gemini-3.5-flash'), false);
    assert.match(metaFor('agy').modelNote || '', /probes the installed binary/);
    assert.match(metaFor('agy').modelNote || '', /--model/);
    assert.match(metaFor('agy').effortNote || '', /no separate effort flag/);
    assert.equal(metaFor('cursor').models.includes('gpt-5.5'), true);
    assert.equal(metaFor('cursor').models.includes('gpt-5.1-codex-mini'), true);
    assert.equal(metaFor('cursor').models.includes('claude-opus-5'), true);
    assert.equal(metaFor('cursor').models.includes('claude-opus-5-5'), true);
    assert.equal(metaFor('cursor').models.includes('grok-4.7'), true);
    assert.equal(metaFor('cursor').efforts.includes('medium-fast'), true);
    assert.equal(PRIMARY_CLIS.includes('agy'), true);
    assert.equal(PRIMARY_CLIS.includes('cursor'), true);
    assert.equal(metaFor('kiro-code').label, 'Kiro');
    assert.equal(metaFor('kiro-code').models.includes('auto'), true);
    assert.equal(PRIMARY_CLIS.includes('kiro-code'), true);
    const jwcMeta = metaFor('jwc');
    assert.equal(PRIMARY_CLIS.includes('jwc'), false);
    assert.equal(jwcMeta.label, 'JWC (retired)');
    assert.deepEqual(jwcMeta.models, []);
    const kiroRequired = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-opus-5'];
    const managerKiro = metaFor('kiro-code').models;
    for (const model of kiroRequired) {
        assert.equal(managerKiro.includes(model), true, `manager kiro-code fallback is missing ${model}`);
    }
    assert.equal(managerKiro[0], 'auto');
    assert.deepEqual(jwcMeta.efforts, []);
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'jwc'), false);
    assert.equal(PRIMARY_CLIS.includes('claude-e'), false);
    assert.deepEqual(
        orderRuntimeCliOptions(['gemini', 'jwc', 'claude-e', 'agy', 'custom-cli']),
        ['agy', 'gemini', 'custom-cli'],
    );
    const runtimeHeaderSource = readFileSync(
        join(__dirname, '../../public/manager/src/settings/pages/components/agent/RuntimeHeader.tsx'),
        'utf8',
    );
    const perCliRowSource = readFileSync(
        join(__dirname, '../../public/manager/src/settings/pages/components/PerCliRow.tsx'),
        'utf8',
    );
    const agentEmployeesSectionSource = readFileSync(
        join(__dirname, '../../public/manager/src/settings/pages/components/agent/AgentEmployeesSection.tsx'),
        'utf8',
    );
    assert.ok(runtimeHeaderSource.includes('orderRuntimeCliOptions(cliOptions)'));
    assert.ok(runtimeHeaderSource.includes('orderedCliOptions.map'));
    assert.ok(runtimeHeaderSource.includes('collapsedAfter={orderedPrimaryCliCount}'));
    assert.ok(perCliRowSource.includes('settings-percli-note'));
    assert.ok(perCliRowSource.includes('meta.modelNote'));
    assert.ok(perCliRowSource.includes('meta.effortNote'));
    assert.ok(
        agentEmployeesSectionSource.includes('makeDefaultRuntimeEmployee(cliOptions, cliMeta)'),
        'new runtime employees must use live CLI metadata for model defaults',
    );
    assert.equal(metaFor('pi').label, 'Pi');
    assert.equal(PRIMARY_CLIS[0], 'pi');
});

test('Manager live CLI metadata overrides static Codex model fallback', () => {
    const registry = normalizeCliMetaRegistry({
        codex: {
            label: 'Codex',
            models: [
                'gpt-5.5',
                'gpt-5.4',
                'gpt-5.4-mini',
                'gpt-5.3-codex-spark',
                'kiro/claude-opus-4.8',
                'opencode-go/kimi-k2.7-code',
            ],
            efforts: ['low', 'medium', 'high', 'xhigh'],
        },
    });
    assert.deepEqual(metaFor('codex', registry).models, [
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
        'kiro/claude-opus-4.8',
        'opencode-go/kimi-k2.7-code',
    ]);
});

test('Pi model defaults render first and use discovered models for dropdown options', () => {
    assert.deepEqual(orderModelCliKeys(['agy', 'jwc', 'ai-e', 'claude', 'pi']), ['pi', 'agy', 'claude']);
    assert.deepEqual(piModelOptions({
        defaultProfileId: 'progrok',
        profiles: [{ id: 'progrok', label: 'Progrok', mode: 'basic', endpoint: 'http://127.0.0.1:18645/v1', model: 'grok-composer-2.5-fast' }],
        discoveredModels: { progrok: ['grok-4.3', 'grok-composer-2.5-fast'] },
    }, 'progrok', 'grok-4.3'), ['grok-4.3', 'grok-composer-2.5-fast']);
    const rowSource = readFileSync('public/manager/src/settings/pages/components/PerCliRow.tsx', 'utf8');
    assert.match(rowSource, /isPi[\s\S]*<SelectField[\s\S]*id=\{`percli-\$\{cli\}-model`\}/);
    assert.match(rowSource, /PiProfileDialog/);
});

test('active runtime override wins over per-CLI defaults', () => {
    const model = runtimeModelFor(
        'codex',
        { codex: { model: 'gpt-5.4' } },
        { codex: { model: 'gpt-5.5' } },
    );
    assert.equal(model, 'gpt-5.5');
});
