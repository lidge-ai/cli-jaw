import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCopilotModelInventory, parseCopilotModelList } from '../../src/agent/copilot-models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shaped after a real `models.list` result from Copilot CLI 1.0.83.
const MODELS_RESULT = {
    models: [
        { id: 'auto', name: 'Auto', capabilities: {} },
        { id: 'claude-haiku-4.5', policy: { state: 'enabled' }, capabilities: { supports: { reasoningEffort: false } } },
        {
            id: 'gpt-5.4-mini',
            policy: { state: 'enabled' },
            supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium',
        },
        { id: 'claude-opus-4.8', policy: { state: 'unconfigured' } },
        { id: 'gpt-5.5', policy: { state: 'disabled' } },
    ],
};

test('CPM-001: keeps enabled and policy-less models, drops the rest', () => {
    const inventory = parseCopilotModelList(MODELS_RESULT)!;
    assert.deepEqual(inventory.models, ['auto', 'claude-haiku-4.5', 'gpt-5.4-mini']);
    assert.equal(inventory.source, 'copilot models.list');
});

test('CPM-002: narrows efforts per model and drops none', () => {
    const inventory = parseCopilotModelList(MODELS_RESULT)!;
    assert.deepEqual(inventory.effortsByModel['gpt-5.4-mini'], ['low', 'medium', 'high', 'xhigh']);
    // A model with no ladder gets an explicit empty set, not the static fallback.
    assert.deepEqual(inventory.effortsByModel['claude-haiku-4.5'], []);
    assert.deepEqual(inventory.defaultEffortByModel, { 'gpt-5.4-mini': 'medium' });
});

test('CPM-003: malformed or empty results answer null', () => {
    assert.equal(parseCopilotModelList(null), null);
    assert.equal(parseCopilotModelList({ models: 'nope' }), null);
    assert.equal(parseCopilotModelList({ models: [] }), null);
    assert.equal(parseCopilotModelList({ models: [{ id: 'x', policy: { state: 'disabled' } }] }), null);
});

function writeFakeCopilot(body: string): string {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'jaw-copilot-models-'));
    const file = join(dir, 'copilot');
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return file;
}

test('CPM-004: reads a Content-Length framed models.list reply', { skip: process.platform === 'win32' }, async () => {
    const binary = writeFakeCopilot(`
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const h = buf.indexOf('\\r\\n\\r\\n');
    if (h < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const req = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    const send = (o) => { const b = Buffer.from(JSON.stringify(o)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
    send({ jsonrpc: '2.0', method: 'session.lifecycle', params: {} });
    send({ jsonrpc: '2.0', id: req.id, result: ${JSON.stringify(MODELS_RESULT)} });
});
setInterval(() => {}, 1000);
`);
    const inventory = await fetchCopilotModelInventory(binary, 10000);
    assert.deepEqual(inventory?.models, ['auto', 'claude-haiku-4.5', 'gpt-5.4-mini']);
});

test('CPM-005: a server that never answers times out to null', { skip: process.platform === 'win32' }, async () => {
    const binary = writeFakeCopilot('setInterval(() => {}, 1000);');
    assert.equal(await fetchCopilotModelInventory(binary, 300), null);
});

test('CPM-006: a missing binary answers null', async () => {
    assert.equal(await fetchCopilotModelInventory(join(os.tmpdir(), 'jaw-no-such-copilot'), 1000), null);
});

test('CPM-007: live registry takes the entitled list and per-model efforts', async () => {
    mock.module(resolve(__dirname, '../../src/agent/kiro-models.js'), {
        namedExports: { fetchKiroModelInventory: async () => null },
    });
    mock.module(resolve(__dirname, '../../src/agent/copilot-models.js'), {
        namedExports: { fetchCopilotModelInventory: async () => parseCopilotModelList(MODELS_RESULT) },
    });

    const { buildLiveCliRegistry } = await import('../../src/cli/registry-live.ts');
    const registry = await buildLiveCliRegistry() as Record<string, Record<string, unknown>>;
    const copilot = registry['copilot']!;

    assert.deepEqual(copilot['models'], ['auto', 'claude-haiku-4.5', 'gpt-5.4-mini']);
    assert.equal(copilot['modelSource'], 'copilot models.list');
    // The static default (claude-sonnet-4.6) is not in this plan, so it must move.
    assert.equal(copilot['defaultModel'], 'auto');
    assert.deepEqual((copilot['effortsByModel'] as Record<string, string[]>)['gpt-5.4-mini'], ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(copilot['efforts'], ['low', 'medium', 'high', 'xhigh']);
});
