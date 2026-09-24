import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgyModelList } from '../../src/agent/agy-models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shaped after real `agy models` output from AGY 1.1.28.
const AGY_OUTPUT = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
    'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    '',
].join('\n');

test('AGYM-001: keeps the label column, the form agy --model accepts alone', () => {
    const inventory = parseAgyModelList(AGY_OUTPUT)!;
    assert.deepEqual(inventory.models, [
        'Gemini 3.8 Flash (High)',
        'Gemini 3.8 Flash (Medium)',
        'Gemini 3.7 Flash (Medium)',
        'Gemini 3.1 Pro (Low)',
        'Claude Sonnet 4.6 (Thinking)',
        'GPT-OSS 120B (Medium)',
    ]);
    // A tier-less or effort-suffixed slug would need --effort, which cli-jaw never sends.
    assert.equal(inventory.models.some((m) => m.startsWith('gemini-')), false);
    assert.equal(inventory.slugs['Gemini 3.8 Flash (High)'], 'gemini-3.8-flash-high');
    assert.equal(inventory.source, 'agy models');
});

test('AGYM-002: the banner and untabbed noise are never models', () => {
    const inventory = parseAgyModelList(`${AGY_OUTPUT}\nWarning: update available\n`)!;
    assert.equal(inventory.models.includes('Fetching available models...'), false);
    assert.equal(inventory.models.some((m) => m.includes('Warning')), false);
});

test('AGYM-003: duplicate labels collapse to one choice', () => {
    const inventory = parseAgyModelList('a-1\tSame (High)\nb-2\tSame (High)\n')!;
    assert.deepEqual(inventory.models, ['Same (High)']);
});

test('AGYM-004: an empty or banner-only listing answers null so the static seed stays', () => {
    assert.equal(parseAgyModelList(''), null);
    assert.equal(parseAgyModelList('Fetching available models...\n'), null);
});

test('AGYM-005: live registry replaces AGY models and repairs a retired default', async () => {
    mock.module(resolve(__dirname, '../../src/agent/kiro-models.js'), {
        namedExports: { fetchKiroModelInventory: async () => null },
    });
    mock.module(resolve(__dirname, '../../src/agent/agy-models.js'), {
        namedExports: {
            fetchAgyModelInventory: async () => ({
                models: ['Gemini 3.9 Flash (High)', 'Gemini 3.9 Flash (Medium)'],
                slugs: {},
                source: 'agy models',
            }),
        },
    });

    const { buildLiveCliRegistry } = await import('../../src/cli/registry-live.ts');
    const registry = await buildLiveCliRegistry() as Record<string, Record<string, unknown>>;

    assert.deepEqual(registry['agy']?.['models'], ['Gemini 3.9 Flash (High)', 'Gemini 3.9 Flash (Medium)']);
    assert.equal(registry['agy']?.['modelSource'], 'agy models');
    // The static default is no longer served, so the first live model replaces it.
    assert.equal(registry['agy']?.['defaultModel'], 'Gemini 3.9 Flash (High)');
});
