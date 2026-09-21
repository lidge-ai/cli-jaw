import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildPiModelsConfig,
    discoverPiProfileModels,
    normalizePiEndpoint,
    normalizePiProfile,
    parsePiModelList,
    parsePiRpcRecord,
    resolvePiCommand,
} from '../../src/agent/pi-runtime.ts';

test('Pi endpoint normalization infers OpenAI chat completions suffix', () => {
    const normalized = normalizePiEndpoint('http://127.0.0.1:18645/v1/chat/completions');
    assert.deepEqual(normalized, {
        baseUrl: 'http://127.0.0.1:18645/v1',
        inferredApiKind: 'openai-completions',
    });
});

test('Pi endpoint normalization infers responses and messages suffixes', () => {
    assert.equal(normalizePiEndpoint('https://api.example.com/v1/responses').inferredApiKind, 'openai-responses');
    assert.equal(normalizePiEndpoint('https://api.example.com/v1/messages').inferredApiKind, 'anthropic-messages');
});

test('Pi basic local proxy accepts empty API key and stores dummy', () => {
    const profile = normalizePiProfile({
        id: 'progrok',
        mode: 'basic',
        endpoint: 'http://localhost:18645/v1',
        model: 'grok-composer-2.5-fast',
        apiKey: '',
    });
    assert.equal(profile.apiKey, 'dummy');
});

test('Pi remote profile requires an API key', () => {
    assert.throws(() => normalizePiProfile({
        id: 'remote',
        mode: 'basic',
        endpoint: 'https://api.example.com/v1',
        model: 'm',
        apiKey: '',
    }), /api key required/);
});

test('Pi models.json config includes provider profile and selected model', () => {
    const profile = normalizePiProfile({
        id: 'progrok',
        endpoint: 'http://127.0.0.1:18645/v1',
        model: 'grok-4.3',
    });
    const config = buildPiModelsConfig({ defaultProfileId: 'progrok', profiles: [profile] });
    const provider = ((config.providers as Record<string, unknown>).progrok as Record<string, unknown>);
    assert.deepEqual((provider.models as Array<Record<string, unknown>>).map((entry) => entry.id), ['grok-4.3']);
    assert.equal(provider.api, 'openai-completions');
});

test('Pi offline model list parser extracts models for the selected provider', () => {
    const output = `provider model context\nprogrok grok-4.3 256000\nprogrok grok-composer-2.5-fast 256000\nother x 1\n`;
    assert.deepEqual(parsePiModelList(output, 'progrok'), ['grok-4.3', 'grok-composer-2.5-fast']);
});

test('Pi RPC parser treats prompt success as non-terminal and agent_end as done', () => {
    assert.deepEqual(parsePiRpcRecord({ id: 1, type: 'response', command: 'prompt', success: true }), {});
    assert.deepEqual(parsePiRpcRecord({ type: 'agent_end', sessionId: 's1' }), { done: true, sessionId: 's1' });
    assert.deepEqual(parsePiRpcRecord({
        type: 'agent_end',
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ],
    }), { done: true, text: 'answer' });
});

test('Pi RPC parser extracts thinking_delta as thinking, not text', () => {
    const event = parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reasoning here' },
    });
    assert.deepEqual(event, { thinking: 'reasoning here' });
    assert.equal(event.text, undefined);
});

test('Pi RPC parser extracts text_delta as text', () => {
    const event = parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello!' },
    });
    assert.deepEqual(event, { text: 'Hello!' });
    assert.equal(event.thinking, undefined);
});

test('Pi RPC parser ignores thinking_start/end and text_start/end boundaries', () => {
    assert.deepEqual(parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    }), {});
    assert.deepEqual(parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Hello!' },
    }), {});
});

test('Pi RPC parser filters thinking from agent_end messages', () => {
    const event = parsePiRpcRecord({
        type: 'agent_end',
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'internal reasoning', thinkingSignature: 'reasoning_content' },
                    { type: 'text', text: 'Hello!' },
                ],
            },
        ],
    });
    assert.equal(event.done, true);
    assert.equal(event.text, 'Hello!');
    assert.ok(!event.text?.includes('internal reasoning'));
});

test('Pi RPC parser extracts sessionId from get_state response data', () => {
    const event = parsePiRpcRecord({
        id: 1, type: 'response', command: 'get_state', success: true,
        data: { sessionId: 'abc-123', model: { id: 'test' } },
    });
    assert.equal(event.sessionId, 'abc-123');
});

test('Pi RPC parser: only tool_execution_end emits tool entry (1 per call)', () => {
    const start = parsePiRpcRecord({
        type: 'tool_execution_start',
        toolCallId: 'call-abc',
        toolName: 'bash',
        args: { command: 'ls /tmp' },
    });
    assert.deepEqual(start, {});

    const update = parsePiRpcRecord({
        type: 'tool_execution_update',
        toolCallId: 'call-abc',
        toolName: 'bash',
        args: { command: 'ls /tmp' },
        partialResult: { content: [] },
    });
    assert.deepEqual(update, {});

    const end = parsePiRpcRecord({
        type: 'tool_execution_end',
        toolCallId: 'call-abc',
        toolName: 'bash',
        args: { command: 'ls /tmp' },
        result: { content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }] },
        isError: false,
    });
    assert.equal(end.tool?.label, 'bash');
    assert.equal(end.tool?.status, 'done');
    assert.ok(end.tool?.detail?.includes('ls /tmp'));
    assert.ok(end.tool?.detail?.includes('file1.txt'));
});

test('Pi RPC parser: toolcall_start/end both dropped (no tool entry)', () => {
    const start = parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: {
            type: 'toolcall_start',
            contentIndex: 1,
            partial: {
                role: 'assistant',
                content: [
                    { type: 'toolCall', name: 'bash', arguments: { command: 'echo hi' } },
                ],
            },
        },
    });
    assert.deepEqual(start, {});

    const end = parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: { type: 'toolCall', name: 'grep', arguments: { pattern: 'foo' } },
        },
    });
    assert.deepEqual(end, {});
});

test('Pi RPC parser toolcall_delta returns empty (no text leak)', () => {
    const delta = parsePiRpcRecord({
        type: 'message_update',
        assistantMessageEvent: {
            type: 'toolcall_delta',
            contentIndex: 1,
            delta: '{"command":"ls"}',
        },
    });
    assert.deepEqual(delta, {});
    assert.equal(delta.text, undefined);
    assert.equal((delta as any).thinking, undefined);
});

test('Pi command fallback is command/baseArgs tuple, not a shell string', () => {
    const cmd = resolvePiCommand({ PATH: '' });
    assert.equal(cmd.command, 'npm');
    assert.deepEqual(cmd.baseArgs.slice(0, 4), ['exec', '--yes', '--package', '@earendil-works/pi-coding-agent']);
});

test('Pi model discovery prefers a verified opencodex endpoint', async () => {
    const server = createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'opencodex' }));
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'ocx-model-a' }, { id: 'ocx-model-b' }] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const profile = normalizePiProfile({
        id: 'ocx',
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: 'ocx-model-a',
    });
    try {
        assert.deepEqual(await discoverPiProfileModels({
            defaultProfileId: profile.id,
            profiles: [profile],
        }, profile), {
            models: ['ocx-model-a', 'ocx-model-b'],
            source: 'opencodex',
        });
    } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
});

test('Pi model discovery falls back to the offline Pi inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jaw-pi-discovery-'));
    const executable = join(root, 'pi-stub');
    await writeFile(executable, '#!/bin/sh\nprintf "fallback fallback-model 100000\\n"\n', { mode: 0o755 });
    const previousBin = process.env['PI_CODING_AGENT_BIN'];
    process.env['PI_CODING_AGENT_BIN'] = executable;
    const profile = normalizePiProfile({
        id: 'fallback',
        endpoint: 'http://127.0.0.1:1/v1',
        model: 'fallback-model',
    });
    try {
        assert.deepEqual(await discoverPiProfileModels({
            defaultProfileId: profile.id,
            profiles: [profile],
        }, profile, {
            root: join(root, 'runtime'),
            timeoutMs: 500,
        }), {
            models: ['fallback-model'],
            source: 'pi-offline',
        });
    } finally {
        if (previousBin === undefined) delete process.env['PI_CODING_AGENT_BIN'];
        else process.env['PI_CODING_AGENT_BIN'] = previousBin;
    }
});

test('Pi launch sites retain the shared Windows resolver, and RPC children have one owner', async () => {
    // Previously this pinned the exact `shell: true` guard that #367 removes: any
    // non-.exe command on Windows got a shell. Every plan routes through
    // resolvePiSpawn, which resolves an npm .cmd shim to its interpreter and only
    // falls back to a shell when resolution FAILS.
    const source = await readFile(new URL('../../src/agent/pi-runtime.ts', import.meta.url), 'utf8');
    // Supplemental source wiring only, not Windows execution certification.
    // Three plans remain: list-models, plus the RPC and version pair inside the one
    // launch owner. This used to be five because the persistent and one-shot spawners
    // each carried a byte-identical copy of that pair (#701).
    assert.equal(source.split('resolvePiSpawn(cmd.command').length - 1, 3, 'all three plans must resolve');
    assert.equal(source.split('...(launch.useShell ? { shell: true } : {})').length - 1, 3);
    // The old unconditional guard must be gone.
    assert.doesNotMatch(source, /const isCmdShim = process\.platform === 'win32'/);
    // A bare count cannot tell consolidation apart from a deleted launch site, and the
    // duplication is the actual defect: an abort or cleanup fix kept landing on one
    // spawner only. Pin the property instead — neither RPC entry point launches its
    // own child. The slices stop at each function so that listPiModels and the version
    // probe, which legitimately spawn, stay outside.
    const persistent = source.slice(
        source.indexOf('export function spawnPersistentPiRpc'),
        source.indexOf('export function openPiRpc'),
    );
    const oneShot = source.slice(source.indexOf('export function openPiRpc'), source.indexOf('export function spawnPiRpc'));
    assert.ok(persistent.length > 0 && oneShot.length > 0, 'both Pi RPC entry points must exist');
    for (const [name, body] of [['spawnPersistentPiRpc', persistent], ['openPiRpc', oneShot]] as const) {
        assert.doesNotMatch(body, /\bspawn\(/, name + ' must not launch a child of its own');
        assert.match(body, /launchPiRpcExecution\(/, name + ' must launch through the shared owner');
    }
    const wrapper = source.slice(source.indexOf('export function spawnPiRpc'));
    assert.match(wrapper, /openPiRpc\(/, 'spawnPiRpc remains the compatibility wrapper');
    assert.doesNotMatch(wrapper, /launchPiRpcExecution\(/);
});
