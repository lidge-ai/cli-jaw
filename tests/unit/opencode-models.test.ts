import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOpencodeModelList } from '../../src/agent/opencode-models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shaped after real `opencode models` output: one provider/model id per line,
// providers in the CLI's own order.
const OPENCODE_OUTPUT = [
    'google/gemini-3.6-flash',
    'google/gemini-3.1-pro-preview',
    'opencode-go/kimi-k2.7-code',
    'opencode-go/deepseek-v4.1-flash',
    'openrouter/anthropic/claude-opus-5',
    'progrok/grok-4.6',
    '',
].join('\n');

test('OCM-001: lists opencode-go first and keeps the CLI order for the rest', () => {
    const inventory = parseOpencodeModelList(OPENCODE_OUTPUT)!;
    assert.deepEqual(inventory.models, [
        'opencode-go/kimi-k2.7-code',
        'opencode-go/deepseek-v4.1-flash',
        'google/gemini-3.6-flash',
        'google/gemini-3.1-pro-preview',
        'openrouter/anthropic/claude-opus-5',
        'progrok/grok-4.6',
    ]);
    assert.equal(inventory.source, 'opencode models');
});

test('OCM-002: log lines and bare words are never models', () => {
    const noisy = `INFO  2026-09-24 service=models loading\nwarning\n${OPENCODE_OUTPUT}`;
    const inventory = parseOpencodeModelList(noisy)!;
    assert.equal(inventory.models.length, 6);
    assert.equal(inventory.models.some((m) => m.includes(' ')), false);
});

test('OCM-003: duplicates collapse to one choice', () => {
    const inventory = parseOpencodeModelList('opencode-go/glm-5.3\nopencode-go/glm-5.3\n')!;
    assert.deepEqual(inventory.models, ['opencode-go/glm-5.3']);
});

test('OCM-004: an empty listing answers null so the static seed stays', () => {
    assert.equal(parseOpencodeModelList(''), null);
    assert.equal(parseOpencodeModelList('no providers configured\n'), null);
});

test('OCM-005: live registry widens OpenCode models and keeps a served default', async () => {
    mock.module(resolve(__dirname, '../../src/agent/kiro-models.js'), {
        namedExports: { fetchKiroModelInventory: async () => null },
    });
    mock.module(resolve(__dirname, '../../src/agent/opencode-models.js'), {
        namedExports: {
            fetchOpencodeModelInventory: async () => ({
                models: ['opencode-go/kimi-k2.7-code', 'opencode-go/qwen3.8-max', 'google/gemini-3.6-flash'],
                source: 'opencode models',
            }),
        },
    });

    const { buildLiveCliRegistry } = await import('../../src/cli/registry-live.ts');
    const registry = await buildLiveCliRegistry() as Record<string, Record<string, unknown>>;

    assert.deepEqual(registry['opencode']?.['models'], ['opencode-go/kimi-k2.7-code', 'opencode-go/qwen3.8-max', 'google/gemini-3.6-flash']);
    assert.equal(registry['opencode']?.['modelSource'], 'opencode models');
    // The static default is still served, so it must not move.
    assert.equal(registry['opencode']?.['defaultModel'], 'opencode-go/kimi-k2.7-code');
});
