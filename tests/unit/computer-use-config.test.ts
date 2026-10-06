import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { COMPUTER_USE_MCP_NAME } from '../../lib/mcp/computer-use-constants.js';
import { computerUseServerEntry, ensureComputerUseMcp } from '../../lib/mcp/computer-use-config.js';
import { patchCodexToml, syncToAll, toCodexToml } from '../../lib/mcp/format-converters.js';

const entry = computerUseServerEntry({ nodePath: '/bin/node', entryPath: '/tmp/dist/lib/mcp/computer-use-proxy-main.js' });
const found = () => ({ command: '/tmp/cua', args: [], env: {}, version: '1', configPath: '/tmp/cua.json' });

function fixture(run: (paths: { home: string; jawHome: string; unified: string }) => void): void {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'cu-config-'));
    const jawHome = join(home, 'jaw-home');
    const unified = join(jawHome, 'mcp.json');
    fs.mkdirSync(jawHome);
    fs.writeFileSync(unified, JSON.stringify({ servers: { other: { command: 'other' } }, note: 7 }));
    try { run({ home, jawHome, unified }); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function json(path: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, any>;
}

test('provisions only the managed key and preserves existing data across target formats', () => fixture(({ home, jawHome, unified }) => {
    const claude = join(home, '.claude.json');
    const opencode = join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(claude, JSON.stringify({ mcpServers: { user: { command: 'user' } }, theme: 'dark' }));
    fs.writeFileSync(opencode, JSON.stringify({ mcp: { user: { type: 'local', command: ['user'] } }, theme: 'dark' }));
    const opts = { homeDir: home, jawHome, resolve: found, entry };
    const first = ensureComputerUseMcp(opts);
    assert.equal(first.action, 'added');
    assert.deepEqual(new Set(first.targets), new Set([unified, claude, opencode]));
    assert.deepEqual(json(unified).servers.other, { command: 'other' });
    assert.equal(json(unified).note, 7);
    assert.deepEqual(json(claude).mcpServers.user, { command: 'user' });
    assert.deepEqual(json(claude).mcpServers[COMPUTER_USE_MCP_NAME], { args: entry.args, command: entry.command });
    assert.equal(json(claude).theme, 'dark');
    assert.deepEqual(json(opencode).mcp.user, { type: 'local', command: ['user'] });
    assert.deepEqual(json(opencode).mcp[COMPUTER_USE_MCP_NAME].command, [entry.command, ...entry.args]);
    const before = [unified, claude, opencode].map(path => fs.readFileSync(path, 'utf8'));
    assert.deepEqual(ensureComputerUseMcp(opts), { action: 'unchanged', targets: [], skipped: [] });
    assert.deepEqual([unified, claude, opencode].map(path => fs.readFileSync(path, 'utf8')), before);
}));

test('preserves user collision and skips absent plugin', () => fixture(({ home, jawHome, unified }) => {
    assert.equal(ensureComputerUseMcp({ homeDir: home, jawHome, resolve: () => null, entry }).action, 'skipped-no-plugin');
    const original = { servers: { [COMPUTER_USE_MCP_NAME]: { command: '/custom/mcp' } } };
    fs.writeFileSync(unified, JSON.stringify(original));
    assert.equal(ensureComputerUseMcp({ homeDir: home, jawHome, resolve: found, entry }).action, 'preserved-user-entry');
    assert.deepEqual(json(unified), original);
}));

test('skips malformed files independently and never overwrites a user target collision', () => fixture(({ home, jawHome, unified }) => {
    const claude = join(home, '.claude.json');
    const cursor = join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(join(home, '.cursor'));
    fs.writeFileSync(claude, '{invalid');
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { [COMPUTER_USE_MCP_NAME]: { command: '/user/mcp' } } }));
    const result = ensureComputerUseMcp({ homeDir: home, jawHome, resolve: found, entry });
    assert.deepEqual(new Set(result.skipped), new Set([claude, cursor]));
    assert.equal(fs.readFileSync(claude, 'utf8'), '{invalid');
    assert.equal(json(cursor).mcpServers[COMPUTER_USE_MCP_NAME].command, '/user/mcp');
    fs.writeFileSync(unified, '{invalid');
    const unreadable = ensureComputerUseMcp({ homeDir: home, jawHome, resolve: found, entry });
    assert.deepEqual(unreadable, { action: 'skipped-unreadable', targets: [], skipped: [unified] });
    assert.equal(fs.readFileSync(unified, 'utf8'), '{invalid');
}));

test('test jaw homes update only their unified file under the implicit home', () => fixture(({ home, unified }) => {
    const jawHome = join(home, 'cli-jaw-test-abc');
    fs.mkdirSync(jawHome);
    fs.copyFileSync(unified, join(jawHome, 'mcp.json'));
    const claude = join(home, '.claude.json');
    fs.writeFileSync(claude, JSON.stringify({ mcpServers: {} }));
    const previousHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
        const result = ensureComputerUseMcp({ jawHome, resolve: found, entry });
        assert.deepEqual(result.targets, [join(jawHome, 'mcp.json')]);
        assert.deepEqual(json(claude), { mcpServers: {} });
    } finally {
        if (previousHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
    }
}));

test('NODE_ENV=test suppresses global target writes for the implicit home', () => fixture(({ home, jawHome }) => {
    const claude = join(home, '.claude.json');
    fs.writeFileSync(claude, JSON.stringify({ mcpServers: {} }));
    const previous = process.env['NODE_ENV'];
    const previousHome = process.env['HOME'];
    process.env['NODE_ENV'] = 'test';
    // os.homedir() follows HOME on POSIX, so the implicit path still lands in the fixture.
    process.env['HOME'] = home;
    try {
        const result = ensureComputerUseMcp({ jawHome, resolve: found, entry });
        assert.deepEqual(result.targets, [join(jawHome, 'mcp.json')]);
        assert.deepEqual(json(claude), { mcpServers: {} });
    } finally {
        if (previous === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previous;
        if (previousHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
    }
}));

test('Codex emits no jaw proxy and preserves unowned bare and quoted sections', () => {
    const emitted = toCodexToml({ servers: {
        [COMPUTER_USE_MCP_NAME]: entry,
        other: { command: '/new', args: [] },
    } });
    assert.doesNotMatch(emitted, /jaw-computer-use/);
    const existing = '[mcp_servers.computer-use]\ncommand = "native"\n[mcp_servers.computer-use.env]\nA = "x"\n[mcp_servers.node_repl]\ncommand = "node"\n[mcp_servers."jaw-computer-use"]\ncommand = "user"\n[mcp_servers.other]\ncommand = "old"\n[mcp_servers."other".env]\nOLD = "1"\n[mcp_servers.\'other\'.metadata]\nOLD2 = "2"\n[features]\nfoo = true\n';
    const patched = patchCodexToml(existing, emitted, new Set(['other']));
    assert.match(patched, /\[mcp_servers\.computer-use\.env\]\nA = "x"/);
    assert.match(patched, /\[mcp_servers\.node_repl\]\ncommand = "node"/);
    assert.match(patched, /\[mcp_servers\."jaw-computer-use"\]\ncommand = "user"/);
    assert.doesNotMatch(patched, /command = "old"|OLD = "1"|OLD2 = "2"/);
    assert.match(patched, /\[mcp_servers\.other\]\ncommand = "\/new"/);
    assert.equal(patchCodexToml(existing, '', new Set()), existing);
});

test('syncToAll preserves unrelated Copilot, Cursor, and Antigravity servers', () => fixture(({ home }) => {
    const paths = [
        join(home, '.copilot', 'mcp-config.json'),
        join(home, '.cursor', 'mcp.json'),
        join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    ];
    for (const path of paths) {
        fs.mkdirSync(join(path, '..'), { recursive: true });
        fs.writeFileSync(path, JSON.stringify({ mcpServers: { user: { command: 'user' } }, theme: 'dark' }));
    }
    const codex = join(home, '.codex', 'config.toml');
    fs.mkdirSync(join(home, '.codex'));
    fs.writeFileSync(codex, '[mcp_servers.node_repl]\ncommand = "node"\n[mcp_servers.computer-use]\ncommand = "native"\n[mcp_servers."jaw-computer-use"]\ncommand = "custom"\n');
    const homedir = mock.method(os, 'homedir', () => home);
    const log = mock.method(console, 'log', () => undefined);
    try {
        syncToAll({ servers: { other: { command: '/new' }, [COMPUTER_USE_MCP_NAME]: entry } });
    } finally {
        homedir.mock.restore();
        log.mock.restore();
    }
    for (const path of paths) {
        assert.deepEqual(json(path).mcpServers.user, { command: 'user' });
        assert.equal(json(path).mcpServers.other.command, '/new');
        assert.equal(json(path).theme, 'dark');
    }
    const toml = fs.readFileSync(codex, 'utf8');
    assert.match(toml, /\[mcp_servers\.node_repl\]/);
    assert.match(toml, /\[mcp_servers\.computer-use\]/);
    assert.match(toml, /\[mcp_servers\."jaw-computer-use"\]/);
    assert.match(toml, /\[mcp_servers\.other\]/);
}));
