import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
    approvalReply, classifyElicitation, isComputerUseApproval, resolveApprovalPolicy,
    resolveCuaRepl, runComputerUseProxy, withElicitationCapability,
    type CuaReplSpec,
} from '../../lib/mcp/computer-use-proxy.js';
import { COMPUTER_USE_APPROVAL_ENV } from '../../lib/mcp/computer-use-constants.js';

const fakeChild = String.raw`
let pending = '';
let currentToolId;
let negativeReplies = [];
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); continue; }
        if (msg.method === 'initialize') {
            const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: msg.params.capabilities } }) + '\n';
            const cut = Math.floor(reply.length / 2);
            process.stdout.write(reply.slice(0, cut));
            setTimeout(() => process.stdout.write(reply.slice(cut)), 5);
        } else if (msg.method === 'tools/call') {
            currentToolId = msg.id;
            send({ jsonrpc: '2.0', id: 'approval-7', method: 'elicitation/create', params: {
                mode: 'form', requestedSchema: { type: 'object', properties: {} },
                _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
                    tool_name: 'click', tool_params: { app: 'x' } },
            } });
        } else if (msg.id === 'approval-7') {
            send({ jsonrpc: '2.0', id: currentToolId, result: { action: msg.result.action, content: msg.result.content } });
        } else if (msg.method === 'test/negative') {
            currentToolId = msg.id;
            send({ jsonrpc: '2.0', id: 'bad-kind', method: 'elicitation/create', params: {
                _meta: { connector_id: 'computer-use', codex_approval_kind: 'other', tool_name: 'click', tool_params: { app: 'x' } },
            } });
            send({ jsonrpc: '2.0', id: 'bad-schema', method: 'elicitation/create', params: {
                requestedSchema: { type: 'object', required: ['allow'] },
                _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'click', tool_params: { app: 'x' } },
            } });
            send({ jsonrpc: '2.0', method: 'elicitation/create', params: {
                _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'click', tool_params: { app: 'x' } },
            } });
        } else if (msg.id === 'bad-kind' || msg.id === 'bad-schema') {
            negativeReplies.push({ id: msg.id, action: msg.result.action });
            if (negativeReplies.length === 2) send({ jsonrpc: '2.0', id: currentToolId, result: negativeReplies });
        } else if (msg.method === 'test/non-cu') {
            send({ jsonrpc: '2.0', id: 'outside-1', method: 'elicitation/create', params: {
                _meta: { connector_id: 'other' }, requestedSchema: { type: 'object' },
            } });
        } else if (msg.method === 'test/exit') {
            process.exit(7);
        }
    }
});
process.stderr.write('child stderr marker\n');
`;

function fixture(t: { after: (fn: () => void) => void }): { dir: string; spec: CuaReplSpec } {
    const dir = mkdtempSync(join(tmpdir(), 'computer-use-proxy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'fake-child.cjs');
    writeFileSync(script, fakeChild);
    return { dir, spec: { command: process.execPath, args: [script], env: {}, version: '1.0', configPath: join(dir, '.mcp.json') } };
}

function client(t: { after: (fn: () => void) => void }, spec: CuaReplSpec | null, policy: 'auto' | 'safe') {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let pending = '';
    const messages: unknown[] = [];
    let errors = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
            const line = pending.slice(0, newline);
            try { messages.push(JSON.parse(line)); } catch { messages.push(line); }
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
        }
    });
    errorOutput.setEncoding('utf8');
    errorOutput.on('data', (chunk: string) => { errors += chunk; });
    const done = runComputerUseProxy({ input, output, errorOutput }, { spec, policy });
    t.after(() => input.end());
    return { input, messages, done, get errors() { return errors; } };
}

async function waitForMessage(messages: unknown[], predicate: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
        const found = messages.find(msg => msg !== null && typeof msg === 'object' && predicate(msg as Record<string, unknown>));
        if (found) return found as Record<string, unknown>;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

test('resolver picks newest numeric valid plugin and skips invalid entries', t => {
    const { dir } = fixture(t);
    const root = join(dir, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
    for (const version of ['26.92.1', '26.930.31730', '26.1000.1', 'latest']) mkdirSync(join(root, version), { recursive: true });
    writeFileSync(join(root, '26.92.1', '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
        command: process.execPath, args: ['older'], env: { X: '1' },
    } } }));
    writeFileSync(join(root, '26.930.31730', '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
        command: process.execPath, args: ['newer'], env: {},
    } } }));
    writeFileSync(join(root, '26.1000.1', '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
        command: 'relative', args: [], env: {},
    } } }));
    writeFileSync(join(root, 'latest', '.mcp.json'), '{bad json');
    assert.equal(resolveCuaRepl({ codexHome: dir })?.version, '26.930.31730');
    assert.equal(resolveCuaRepl({ codexHome: join(dir, 'empty') }), null);
});

test('policy is run-bound and absent/invalid env always declines', t => {
    const dir = mkdtempSync(join(tmpdir(), 'computer-use-policy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: 'auto' }));
    assert.equal(resolveApprovalPolicy({ [COMPUTER_USE_APPROVAL_ENV]: 'auto' }), 'auto');
    assert.equal(resolveApprovalPolicy({ [COMPUTER_USE_APPROVAL_ENV]: 'safe' }), 'safe');
    assert.equal(resolveApprovalPolicy({ [COMPUTER_USE_APPROVAL_ENV]: 'AUTO' }), 'safe');
    assert.equal(resolveApprovalPolicy({}), 'safe');
    assert.equal(resolveApprovalPolicy({ CLI_JAW_HOME: dir }), 'safe');
    assert.deepEqual(approvalReply(1, 'safe').result, { action: 'decline' });
    assert.deepEqual(approvalReply(1, 'auto').result, { action: 'accept', content: {} });
});

test('strict Computer Use elicitation classification fails closed', () => {
    const base = { method: 'elicitation/create', id: 3, params: { mode: 'form',
        _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call' },
        requestedSchema: { type: 'object', properties: {}, required: [] },
    } };
    assert.equal(classifyElicitation(base), 'cu-approval');
    assert.equal(isComputerUseApproval(base), true);
    assert.equal(classifyElicitation({ ...base, params: { ...base.params,
        _meta: { ...base.params._meta, codex_approval_kind: 'other' },
    } }), 'cu-unknown');
    assert.equal(classifyElicitation({ ...base, params: { ...base.params,
        requestedSchema: { type: 'object', required: ['allow'] },
    } }), 'cu-unknown');
    assert.equal(classifyElicitation({ ...base, params: { ...base.params,
        requestedSchema: { type: 'object', properties: { allow: {} } },
    } }), 'cu-unknown');
    assert.equal(classifyElicitation({ ...base, params: { ...base.params, mode: 'url' } }), 'cu-unknown');
    assert.equal(classifyElicitation({ ...base, params: { ...base.params,
        _meta: { connector_id: 'other', codex_approval_kind: 'mcp_tool_call' },
    } }), 'other');
    assert.equal(isComputerUseApproval({ ...base, id: undefined }), false);
    assert.equal(classifyElicitation({ method: base.method, params: base.params }), 'cu-unknown');
    assert.deepEqual((withElicitationCapability({ method: 'initialize', params: {
        capabilities: { elicitation: { url: {} }, roots: {} },
    } }) as { params: { capabilities: { elicitation: unknown; roots: unknown } } }).params.capabilities,
    { elicitation: { url: {}, form: {} }, roots: {} });
});

for (const policy of ['auto', 'safe'] as const) {
    test(`line proxy ${policy}: rewrites initialize, intercepts approval, forwards other traffic`, async t => {
        const { spec } = fixture(t);
        const c = client(t, spec, policy);
        const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'test', version: '1' },
        } }) + '\n';
        c.input.write(initialize.slice(0, 25));
        c.input.write(initialize.slice(25));
        const init = await waitForMessage(c.messages, msg => msg.id === 1);
        assert.deepEqual((init.result as { capabilities: unknown }).capabilities, {
            roots: {}, elicitation: { form: {} },
        });
        c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'tools/call', params: {} }) + '\n');
        const result = await waitForMessage(c.messages, msg => msg.id === 55);
        assert.deepEqual(result.result, policy === 'auto'
            ? { action: 'accept', content: {} } : { action: 'decline' });
        assert.equal(c.messages.some(msg => (msg as { id?: unknown }).id === 'approval-7'), false);
        assert.match(c.errors, new RegExp(`\\[jaw-computer-use\\] ${policy === 'auto' ? 'accept' : 'decline'} click x`));
        assert.match(c.errors, /child stderr marker/);
        c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'test/non-cu' }) + '\n');
        const outside = await waitForMessage(c.messages, msg => msg.id === 'outside-1');
        assert.equal(outside.method, 'elicitation/create');
        c.input.write('not-json\n');
        const until = Date.now() + 2000;
        while (!c.messages.includes('not-json') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(c.messages.includes('not-json'), true);
        c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 70, method: 'test/exit' }) + '\n');
        assert.equal(await c.done, 7);
    });
}

test('invalid and id-less Computer Use elicitations never reach the client', async t => {
    const { spec } = fixture(t);
    const c = client(t, spec, 'auto');
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 80, method: 'test/negative' }) + '\n');
    const result = await waitForMessage(c.messages, msg => msg.id === 80);
    assert.deepEqual(result.result, [
        { id: 'bad-kind', action: 'decline' },
        { id: 'bad-schema', action: 'decline' },
    ]);
    assert.equal(c.messages.some(msg => ['bad-kind', 'bad-schema'].includes(String((msg as { id?: unknown }).id))), false);
    assert.match(c.errors, /dropped id-less computer-use elicitation/);
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'test/exit' }) + '\n');
    assert.equal(await c.done, 7);
});

test('pre-initialize server/discover probe is answered by the proxy, not the child', async t => {
    const { spec } = fixture(t);
    const c = client(t, spec, 'auto');
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} }) + '\n');
    const probe = await waitForMessage(c.messages, msg => msg.id === 'discover-1');
    assert.equal((probe.error as { code: number }).code, -32601);
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }) + '\n');
    const init = await waitForMessage(c.messages, msg => msg.id === 1);
    assert.deepEqual((init.result as { capabilities: unknown }).capabilities, { elicitation: { form: {} } });
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'test/exit' }) + '\n');
    assert.equal(await c.done, 7);
});

test('missing plugin rejects requests with -32002 and exits after initialize', async t => {
    const c = client(t, null, 'safe');
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }) + '\n');
    assert.equal(await c.done, 1);
    assert.deepEqual(c.messages.map(msg => (msg as { id: number }).id), [2, 3]);
    for (const msg of c.messages as { error: { code: number; message: string } }[]) {
        assert.equal(msg.error.code, -32002);
        assert.match(msg.error.message, /precondition failed: Codex Computer Use/);
    }
});

test('spawn failure replies to pending initialize and exits 1', async t => {
    const { dir, spec } = fixture(t);
    const c = client(t, { ...spec, command: join(dir, 'not-a-command') }, 'safe');
    c.input.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }) + '\n');
    assert.equal(await c.done, 1);
    const response = await waitForMessage(c.messages, msg => msg.id === 99);
    assert.equal((response.error as { code: number }).code, -32002);
    assert.match(c.errors, /spawn failed/);
});
