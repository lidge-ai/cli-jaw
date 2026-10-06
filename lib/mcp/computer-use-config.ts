/** Provision the jaw-owned Computer Use proxy without replacing user MCP entries. */
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_USE_MCP_NAME, PROXY_ENTRY_BASENAME } from './computer-use-constants.js';
import { resolveCuaRepl } from './computer-use-proxy.js';
import { toClaudeMcp, toOpenCodeMcp } from './format-converters.js';

type JsonObject = Record<string, unknown>;
type Entry = { command: string; args: string[] };
type Target = { path: string; key: 'mcpServers' | 'mcp'; format: 'claude' | 'opencode' };

export type EnsureResult = {
    action: 'added' | 'updated' | 'unchanged' | 'skipped-no-plugin' | 'preserved-user-entry' | 'skipped-unreadable';
    targets: string[];
    skipped: string[];
};

export function computerUseServerEntry(opts: { nodePath?: string; entryPath?: string } = {}): Entry {
    return {
        command: opts.nodePath ?? process.execPath,
        args: [opts.entryPath ?? fileURLToPath(new URL('./computer-use-proxy-main.js', import.meta.url))],
    };
}

export function isManagedComputerUseEntry(server: unknown): boolean {
    if (!isObject(server)) return false;
    const args = server['args'];
    if (Array.isArray(args) && typeof args[0] === 'string' && basename(args[0]) === PROXY_ENTRY_BASENAME) return true;
    const command = server['command'];
    return Array.isArray(command) && typeof command[1] === 'string' && basename(command[1]) === PROXY_ENTRY_BASENAME;
}

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path: string): JsonObject | null {
    const data: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!isObject(data)) return null;
    return data;
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function writeJson(path: string, value: JsonObject): void {
    fs.writeFileSync(path, JSON.stringify(value, null, 4) + '\n');
}

function targets(home: string): Target[] {
    return [
        { path: join(home, '.claude.json'), key: 'mcpServers', format: 'claude' },
        { path: join(home, '.gemini', 'settings.json'), key: 'mcpServers', format: 'claude' },
        { path: join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp', format: 'opencode' },
        { path: join(home, '.copilot', 'mcp-config.json'), key: 'mcpServers', format: 'claude' },
        { path: join(home, '.cursor', 'mcp.json'), key: 'mcpServers', format: 'claude' },
        { path: join(home, '.gemini', 'antigravity', 'mcp_config.json'), key: 'mcpServers', format: 'claude' },
        { path: join(home, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers', format: 'claude' },
    ];
}

export function ensureComputerUseMcp(opts: {
    homeDir?: string;
    codexHome?: string;
    jawHome?: string;
    resolve?: typeof resolveCuaRepl;
    entry?: Entry;
} = {}): EnsureResult {
    const home = opts.homeDir ?? os.homedir();
    const jawHome = opts.jawHome ?? process.env['CLI_JAW_HOME'] ?? join(home, '.cli-jaw');
    const result: EnsureResult = { action: 'unchanged', targets: [], skipped: [] };
    const unifiedPath = join(jawHome, 'mcp.json');
    let unified: JsonObject;
    try {
        const parsed = readJson(unifiedPath);
        if (!parsed) throw new Error('MCP config must be an object');
        unified = parsed;
    } catch {
        result.action = 'skipped-unreadable';
        result.skipped.push(unifiedPath);
        return result;
    }
    const currentServers = unified['servers'];
    if (currentServers !== undefined && !isObject(currentServers)) {
        result.action = 'skipped-unreadable';
        result.skipped.push(unifiedPath);
        return result;
    }
    const servers: JsonObject = isObject(currentServers) ? currentServers : {};
    const prior = servers[COMPUTER_USE_MCP_NAME];
    if (prior !== undefined && !isManagedComputerUseEntry(prior)) {
        result.action = 'preserved-user-entry';
        return result;
    }
    if (!prior && !(opts.resolve ?? resolveCuaRepl)({ codexHome: opts.codexHome })) {
        result.action = 'skipped-no-plugin';
        return result;
    }

    const entry = opts.entry ?? computerUseServerEntry();
    if (!same(prior, entry)) {
        const updated = { ...unified, servers: { ...servers, [COMPUTER_USE_MCP_NAME]: entry } };
        try {
            writeJson(unifiedPath, updated);
            result.targets.push(unifiedPath);
            result.action = prior ? 'updated' : 'added';
        } catch {
            result.action = 'skipped-unreadable';
            result.skipped.push(unifiedPath);
            return result;
        }
    }

    // A test run must never write the real user's CLI configs. An injected homeDir
    // is already isolated, so only the implicit os.homedir() path is guarded.
    const implicitHome = opts.homeDir === undefined;
    if (implicitHome && (process.env['NODE_ENV'] === 'test' || basename(jawHome).startsWith('cli-jaw-test-'))) return result;
    const claudeEntry = toClaudeMcp({ servers: { [COMPUTER_USE_MCP_NAME]: entry } }).mcpServers[COMPUTER_USE_MCP_NAME];
    const opencodeEntry = toOpenCodeMcp({ servers: { [COMPUTER_USE_MCP_NAME]: entry } })[COMPUTER_USE_MCP_NAME];
    for (const target of targets(home)) {
        if (!fs.existsSync(target.path)) continue;
        try {
            const document = readJson(target.path);
            if (!document) throw new Error('MCP target must be an object');
            const current = document[target.key];
            if (current !== undefined && !isObject(current)) throw new Error('MCP server map must be an object');
            const map = current ?? {};
            const existing = map[COMPUTER_USE_MCP_NAME];
            if (existing !== undefined && !isManagedComputerUseEntry(existing)) {
                result.skipped.push(target.path);
                continue;
            }
            const value = target.format === 'opencode' ? opencodeEntry : claudeEntry;
            if (same(existing, value)) continue;
            writeJson(target.path, { ...document, [target.key]: { ...map, [COMPUTER_USE_MCP_NAME]: value } });
            result.targets.push(target.path);
            if (result.action === 'unchanged') result.action = 'updated';
        } catch {
            result.skipped.push(target.path);
        }
    }
    return result;
}
