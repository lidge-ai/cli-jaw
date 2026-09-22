import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLI_REGISTRY,
    CLI_KEYS,
    CODEX_MODEL_CHOICES,
    DEFAULT_CLI,
    buildDefaultPerCli,
    buildModelChoicesByCli,
} from '../../src/cli/registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Structure validation ────────────────────────────

test('CLI_KEYS contains exactly 10 known entries', () => {
    assert.deepEqual([...CLI_KEYS].sort(), ['agy', 'claude', 'codex', 'codex-app', 'copilot', 'cursor', 'grok', 'kiro-code', 'opencode', 'pi']);
});

test('DEFAULT_CLI is codex-app', () => {
    assert.equal(DEFAULT_CLI, 'codex-app');
});

test('every CLI entry has required fields', () => {
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key];
        assert.ok(entry, `CLI_REGISTRY["${key}"] is missing`);
        assert.equal(typeof entry.label, 'string', `${key}.label must be string`);
        assert.equal(typeof entry.binary, 'string', `${key}.binary must be string`);
        assert.equal(typeof entry.defaultModel, 'string', `${key}.defaultModel must be string`);
        assert.ok(Array.isArray(entry.models), `${key}.models must be array`);
        assert.ok(entry.models.length > 0 || 'modelNote' in entry, `${key}.models must not be empty (or have modelNote for TUI-managed CLIs)`);
        assert.ok(Array.isArray(entry.efforts), `${key}.efforts must be array`);
    }
});

test('every CLI defaultModel is included in its models list', () => {
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key];
        if (!entry.defaultModel) continue;
        assert.ok(
            entry.models.includes(entry.defaultModel),
            `${key}.defaultModel "${entry.defaultModel}" not found in models list`
        );
    }
});

test('registry defaults for opencode are updated', () => {
    assert.equal(CLI_REGISTRY.opencode.defaultModel, 'opencode-go/kimi-k2.7-code');
    // The default has to be selectable. That invariant is what caught the AGY
    // default pointing at a retired generation, so assert it here too rather than
    // only pinning the string.
    assert.ok(CLI_REGISTRY.opencode.models.includes(CLI_REGISTRY.opencode.defaultModel));
});

test('retired runtime is absent from executable registry and fresh defaults', () => {
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'jwc'), false);
    assert.equal(Object.hasOwn(buildDefaultPerCli(), 'jwc'), false);
    assert.equal(Object.hasOwn(buildModelChoicesByCli(), 'jwc'), false);
});

test('live CLI registry excludes retired runtime while retaining native metadata', async () => {
    const kiroModelsPath = resolve(__dirname, '../../src/agent/kiro-models.js');
    mock.module(kiroModelsPath, {
        namedExports: {
            fetchKiroModelInventory: async () => null,
        },
    });

    const { buildLiveCliRegistry } = await import('../../src/cli/registry-live.ts');
    const registry = await buildLiveCliRegistry();

    assert.equal(Object.hasOwn(registry, 'jwc'), false);
    assert.ok(['opencodex', 'static'].includes(registry.codex.modelSource as string));
    assert.equal(registry['codex-app'].modelSource, registry.codex.modelSource);
});

// opencodex advertises a per-model effort set (gpt-5.6-sol reaches `ultra`,
// gpt-5.6-luna stops at `max`, routed models take none) and the picked value is
// forwarded to the wire as `-c model_reasoning_effort=` (src/agent/args.ts:214).
// The live registry must therefore carry the sets per model, not just a union.
test('live CLI registry carries per-model Codex efforts including max and ultra', async () => {
    // kiro-models is already mocked by the preceding test in this file.
    const opencodexPath = resolve(__dirname, '../../src/cli/opencodex-models.js');
    mock.module(opencodexPath, {
        namedExports: {
            resolveOpenCodexCodexModelsDetailed: async () => ({
                models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'anthropic/claude-fable-5'],
                entries: [
                    { id: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
                    { id: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
                    { id: 'anthropic/claude-fable-5', efforts: [] },
                ],
                source: 'opencodex',
            }),
        },
    });

    const moduleUrl = new URL('../../src/cli/registry-live.ts', import.meta.url);
    moduleUrl.searchParams.set('case', `efforts-${Date.now()}`);
    const { buildLiveCliRegistry } = await import(moduleUrl.href) as typeof import('../../src/cli/registry-live.ts');
    const registry = await buildLiveCliRegistry() as Record<string, Record<string, unknown>>;

    for (const key of ['codex', 'codex-app']) {
        const effortsByModel = registry[key]?.['effortsByModel'] as Record<string, string[]>;
        assert.ok(effortsByModel, `${key} must expose effortsByModel`);
        assert.ok(effortsByModel['gpt-5.6-sol']?.includes('ultra'), `${key}: gpt-5.6-sol must offer ultra`);
        assert.ok(effortsByModel['gpt-5.6-sol']?.includes('max'), `${key}: gpt-5.6-sol must offer max`);
        // luna stops at max — offering ultra here would reach the wire and fail.
        assert.equal(effortsByModel['gpt-5.6-luna']?.includes('ultra'), false);
        // An effort-less routed model gets an explicit empty set, not a fallback.
        assert.deepEqual(effortsByModel['anthropic/claude-fable-5'], []);

        const efforts = registry[key]?.['efforts'] as string[];
        assert.ok(efforts.includes('max') && efforts.includes('ultra'), `${key}: union must reach max/ultra`);

        const defaults = registry[key]?.['defaultEffortByModel'] as Record<string, string>;
        assert.equal(defaults['gpt-5.6-sol'], 'low');
        assert.equal(defaults['anthropic/claude-fable-5'], undefined);

        // defaultModel/defaultEffort seed user settings (buildDefaultPerCli), so
        // live routing order must never rewrite them.
        assert.equal(registry[key]?.['defaultModel'], 'gpt-5.5');
        assert.equal(registry[key]?.['defaultEffort'], 'medium');
    }
});
test('Antigravity registry exposes AGY as a top-level runtime, not an ai-e provider', () => {
    assert.equal(CLI_REGISTRY.agy.label, 'Antigravity');
    assert.equal(CLI_REGISTRY.agy.binary, 'agy');
    assert.equal(CLI_REGISTRY.agy.defaultModel, 'Gemini 3.7 Flash (Medium)');
    assert.deepEqual(CLI_REGISTRY.agy.efforts, []);
    assert.ok(CLI_REGISTRY.agy.models.length >= 8);
    assert.ok(CLI_REGISTRY.agy.models.includes('Gemini 3.7 Flash (Medium)'));
    // The default must be selectable, which is the invariant that broke: AGY
    // 1.1.13 no longer lists any 3.5 Flash tier, so the previous default was
    // unreachable. Asserting membership rather than only the string keeps a
    // future generation bump from re-introducing that gap silently.
    assert.ok(CLI_REGISTRY.agy.models.includes(CLI_REGISTRY.agy.defaultModel));
    assert.equal(CLI_REGISTRY.agy.models.some((m) => m.includes('3.5 Flash')), false);
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'ai-e'), false);
});

test('Pi registry exposes Pi as a top-level runtime above AI-E, not an ai-e provider', () => {
    assert.equal(CLI_REGISTRY.pi.label, 'Pi');
    assert.equal(CLI_REGISTRY.pi.binary, 'pi');
    assert.equal(CLI_REGISTRY.pi.defaultProvider, 'progrok');
    assert.equal(CLI_REGISTRY.pi.defaultModel, 'grok-composer-2.5-fast');
    assert.ok(CLI_REGISTRY.pi.models.includes('grok-4.3'));
    assert.equal(CLI_KEYS.includes('pi'), true);
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'ai-e'), false);
});

test('Kiro registry exposes kiro-code as a top-level runtime', () => {
    assert.equal(CLI_REGISTRY['kiro-code'].label, 'Kiro');
    assert.equal(CLI_REGISTRY['kiro-code'].binary, 'kiro-cli');
    assert.equal(CLI_REGISTRY['kiro-code'].defaultModel, 'auto');
    assert.ok(CLI_REGISTRY['kiro-code'].models.includes('claude-sonnet-4.6'));
    assert.deepEqual(CLI_REGISTRY['kiro-code'].efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'ai-e'), false);
});

// registry-live.ts replaces kiro-code.models from the live kiro-cli inventory.
// Mirrors opencodex KIRO_MODELS (src/providers/kiro-models.ts).
test('Kiro catalogs carry the current opencodex model ids on both surfaces', () => {
    const required = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-opus-5'];
    const topLevel = CLI_REGISTRY['kiro-code'].models;
    for (const model of required) {
        assert.ok(topLevel.includes(model), `kiro-code.models is missing ${model}`);
    }
    // `auto` must stay the first entry: it is the default and any first-entry
    // fallback must not resolve to a concrete model.
    assert.equal(topLevel[0], 'auto');
    assert.equal(CLI_REGISTRY['kiro-code'].defaultModel, 'auto');
});

test('Cursor registry exposes Cursor as a top-level runtime, not an ai-e provider', () => {
    assert.equal(CLI_REGISTRY.cursor.label, 'Cursor');
    assert.equal(CLI_REGISTRY.cursor.binary, 'cursor-agent');
    assert.equal(CLI_REGISTRY.cursor.defaultModel, 'composer-2.5');
    assert.equal(CLI_REGISTRY.cursor.defaultEffort, 'medium');
    assert.ok(CLI_REGISTRY.cursor.models.includes('auto'));
    assert.ok(CLI_REGISTRY.cursor.models.includes('gpt-5.1-codex-mini'));
    assert.ok(CLI_REGISTRY.cursor.efforts.includes('high-fast'));
    assert.match(CLI_REGISTRY.cursor.effortNote || '', /model IDs/);
    assert.equal(Object.hasOwn(CLI_REGISTRY, 'ai-e'), false);
});
test('Codex registry defaults expose only the curated inactive ocx model set', () => {
    assert.deepEqual(CODEX_MODEL_CHOICES, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna']);
    assert.deepEqual(CLI_REGISTRY.codex.models, CODEX_MODEL_CHOICES);
    assert.deepEqual(CLI_REGISTRY['codex-app'].models, CODEX_MODEL_CHOICES);
    assert.equal(CLI_REGISTRY.codex.models.includes('gpt-5.3-codex'), false);
    assert.equal(CLI_REGISTRY.codex.models.includes('gpt-5.2-codex'), false);
    assert.equal(CLI_REGISTRY.codex.models.includes('gpt-5.1-codex-mini'), false);
});
test('grok registry includes build and composer models with effort disabled', () => {
    assert.equal(CLI_REGISTRY.grok.defaultModel, 'grok-build');
    assert.deepEqual(CLI_REGISTRY.grok.models, ['grok-build', 'grok-composer-2.5-fast']);
    assert.equal(CLI_REGISTRY.grok.defaultEffort, '');
    assert.deepEqual(CLI_REGISTRY.grok.efforts, []);
    assert.match(CLI_REGISTRY.grok.effortNote || '', /unsupported by grok-build/);
});

test('opencode registry mirrors the full opencode-go roster', () => {
    // 24 ids, refreshed 2026-09-02 against opencodex
    // src/generated/model-metadata.ts:50. Every id is traceable to that line; none
    // is invented.
    const models = CLI_REGISTRY.opencode.models;
    assert.deepEqual(models, [
        'opencode-go/kimi-k2.7-code',
        'opencode-go/kimi-k3',
        'opencode-go/kimi-k2.6',
        'opencode-go/kimi-k2.5',
        'opencode-go/glm-5.3',
        'opencode-go/glm-5.2',
        'opencode-go/glm-5.1',
        'opencode-go/glm-5',
        'opencode-go/grok-4.6',
        'opencode-go/grok-4.5',
        'opencode-go/minimax-m3',
        'opencode-go/minimax-m2.7',
        'opencode-go/minimax-m2.5',
        'opencode-go/qwen3.7-max',
        'opencode-go/qwen3.7-plus',
        'opencode-go/qwen3.6-plus',
        'opencode-go/qwen3.5-plus',
        'opencode-go/mimo-v2.5-pro',
        'opencode-go/mimo-v2.5',
        'opencode-go/mimo-v2-pro',
        'opencode-go/mimo-v2-omni',
        'opencode-go/deepseek-v4-pro',
        'opencode-go/deepseek-v4-flash',
        'opencode-go/hy3',
    ]);
    assert.equal(new Set(models).size, models.length, 'no duplicate opencode ids');
});

test('copilot registry excludes deprecated claude-opus-4.6-fast', () => {
    assert.ok(!CLI_REGISTRY.copilot.models.includes('claude-opus-4.6-fast'));
});

test('copilot registry excludes claude-opus-4.6', () => {
    assert.ok(!CLI_REGISTRY.copilot.models.includes('claude-opus-4.6'));
});

test('codex and copilot registries include gpt-5.4-mini', () => {
    assert.ok(CLI_REGISTRY.codex.models.includes('gpt-5.4-mini'), 'codex must expose gpt-5.4-mini');
    assert.ok(CLI_REGISTRY.copilot.models.includes('gpt-5.4-mini'), 'copilot must expose gpt-5.4-mini');
});

test('codex/copilot gpt-5.4-mini is listed right after gpt-5.4 (sensible ordering)', () => {
    for (const key of ['codex', 'copilot'] as const) {
        const models = CLI_REGISTRY[key].models;
        const idx54 = models.indexOf('gpt-5.4');
        const idxMini = models.indexOf('gpt-5.4-mini');
        assert.ok(idx54 >= 0 && idxMini >= 0, `${key} must include both gpt-5.4 and gpt-5.4-mini`);
        assert.equal(idxMini, idx54 + 1, `${key}: gpt-5.4-mini should follow gpt-5.4`);
    }
});

// ─── buildDefaultPerCli ──────────────────────────────

test('buildDefaultPerCli returns correct shape', () => {
    const defaults = buildDefaultPerCli();
    assert.equal(typeof defaults, 'object');
    for (const key of CLI_KEYS) {
        assert.ok(defaults[key], `defaults["${key}"] missing`);
        assert.equal(defaults[key].model, CLI_REGISTRY[key].defaultModel);
        assert.equal(typeof defaults[key].effort, 'string');
    }
});

test('buildDefaultPerCli returns a new object each call', () => {
    const a = buildDefaultPerCli();
    const b = buildDefaultPerCli();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
});

// ─── buildModelChoicesByCli ──────────────────────────

test('buildModelChoicesByCli returns models for each CLI', () => {
    const choices = buildModelChoicesByCli();
    for (const key of CLI_KEYS) {
        assert.ok(Array.isArray(choices[key]), `choices["${key}"] must be array`);
        assert.deepEqual(choices[key], [...CLI_REGISTRY[key].models]);
    }
});

test('buildModelChoicesByCli returns independent copies', () => {
    const a = buildModelChoicesByCli();
    const b = buildModelChoicesByCli();
    a.claude.push('test-model');
    assert.ok(!b.claude.includes('test-model'), 'modifying one copy should not affect another');
});

test('doctor CLI checks are driven by canonical registry keys', () => {
    const doctorSrc = fs.readFileSync(join(__dirname, '../../bin/commands/doctor.ts'), 'utf8');
    // Matched on the imported name, not the exact brace contents: doctor now
    // also imports DEFAULT_CLI from the same module, and a punctuation-exact
    // match failed on that without anything actually being wrong.
    assert.match(doctorSrc, /import \{[^}]*\bCLI_KEYS\b[^}]*\} from '\.\.\/\.\.\/src\/cli\/registry\.js'/);
    assert.match(doctorSrc, /for \(const cli of CLI_KEYS\)/);
    assert.doesNotMatch(doctorSrc, /for \(const cli of \['claude', 'codex', 'gemini', 'opencode', 'copilot'\]\)/);
});

test('readiness default order starts with codex-app, covers executable canonical CLIs', async () => {
    const { DEFAULT_READINESS_ORDER } = await import('../../src/cli/readiness.ts');
    assert.equal(DEFAULT_READINESS_ORDER[0], 'codex-app');
    for (const key of CLI_KEYS) {
        assert.equal(DEFAULT_READINESS_ORDER.includes(key), true, `readiness order must include ${key}`);
    }
});

test('AGY readiness is installed-only and does not run a prompt', () => {
    const readinessSrc = fs.readFileSync(join(__dirname, '../../src/cli/readiness.ts'), 'utf8');
    const agyCase = readinessSrc.match(/case 'agy': \{[\s\S]*?break;\n\s*\}/)?.[0] || '';
    assert.match(agyCase, /authenticated\s*=\s*true/);
    assert.match(agyCase, /auth checked by agy at run time/);
    assert.doesNotMatch(agyCase, /execFileSync/);
});
