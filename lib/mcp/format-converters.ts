/**
 * lib/mcp/format-converters.ts
 * CLI format conversions (Claude/Codex/Gemini/OpenCode/Copilot/Cursor/Antigravity/Kiro)
 * and patchJsonFile helper. Grok reads ~/.cursor/mcp.json via compat — no dedicated target.
 */
import fs from 'fs';
import os from 'os';
import { join, dirname } from 'path';
import { COMPUTER_USE_MCP_NAME } from './computer-use-constants.js';

type McpServerConfig = {
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    oauth?: Record<string, unknown>;
};

type UnifiedMcpConfig = {
    servers?: Record<string, McpServerConfig>;
};

function getServers(config: UnifiedMcpConfig): Record<string, McpServerConfig> {
    return config.servers ?? {};
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

// ─── Convert to CLI-specific formats ───────────────

/** → Claude Code / Gemini CLI format (.mcp.json / settings.json mcpServers block) */
export function toClaudeMcp(config: UnifiedMcpConfig) {
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, srv] of Object.entries(getServers(config))) {
        if (srv.url) {
            mcpServers[name] = {
                type: srv.type || 'http',
                url: srv.url,
            };
            if (srv.headers && Object.keys(srv.headers).length) mcpServers[name]!.headers = srv.headers;
            if (srv.oauth && Object.keys(srv.oauth).length) mcpServers[name]!.oauth = srv.oauth;
            continue;
        }

        mcpServers[name] = { args: srv.args || [] };
        if (srv.command !== undefined) mcpServers[name]!.command = srv.command;
        if (srv.env && Object.keys(srv.env).length) mcpServers[name]!.env = srv.env;
    }
    return { mcpServers };
}

/** → Codex config.toml MCP section string */
export function toCodexToml(config: UnifiedMcpConfig) {
    let toml = '';
    for (const [name, srv] of Object.entries(getServers(config))) {
        if (name === COMPUTER_USE_MCP_NAME) continue;
        toml += `[mcp_servers.${name}]\n`;
        if (srv.url) {
            toml += `url = ${tomlString(srv.url)}\n`;
            toml += '\n';
            continue;
        }

        toml += `command = ${tomlString(srv.command || '')}\n`;
        toml += `args = ${JSON.stringify(srv.args || [])}\n`;
        if (srv.env && Object.keys(srv.env).length) {
            toml += `[mcp_servers.${name}.env]\n`;
            for (const [k, v] of Object.entries(srv.env)) {
                toml += `${k} = ${tomlString(String(v))}\n`;
            }
        }
        toml += '\n';
    }
    return toml;
}

/** → OpenCode opencode.json mcp block */
export function toOpenCodeMcp(config: UnifiedMcpConfig) {
    const mcp: Record<string, { type: 'local'; command: string[]; environment?: Record<string, unknown> } | { type: 'remote'; url: string; enabled: boolean }> = {};
    for (const [name, srv] of Object.entries(getServers(config))) {
        if (srv.url) {
            mcp[name] = {
                type: 'remote',
                url: srv.url,
                enabled: true,
            };
            continue;
        }

        const localServer: { type: 'local'; command: string[]; environment?: Record<string, unknown> } = {
            type: 'local',
            command: [srv.command || '', ...(srv.args || [])],
        };
        if (srv.env && Object.keys(srv.env).length) localServer.environment = srv.env;
        mcp[name] = localServer;
    }
    return mcp;
}

// ─── Patch helpers ─────────────────────────────────

/** Replace only sections for MCP names emitted in this sync, including their subtables. */
export function patchCodexToml(existingToml: string, newMcpToml: string, emittedNames: ReadonlySet<string> = new Set()) {
    if (emittedNames.size === 0) return existingToml;
    const lines = existingToml.split('\n');
    const output: string[] = [];
    let removeSection = false;

    for (const line of lines) {
        const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
        if (header) {
            removeSection = false;
            const section = header[1]!;
            if (section.startsWith('mcp_servers.')) {
                const suffix = section.slice('mcp_servers.'.length);
                const quoted = /^("(?:\\.|[^"\\])*")(?=\.|$)/.exec(suffix);
                const literal = /^'([^']+)'(?=\.|$)/.exec(suffix);
                const bare = /^([^\.\s]+)(?=\.|$)/.exec(suffix);
                const name = quoted ? JSON.parse(quoted[1]!) as string : literal?.[1] ?? bare?.[1];
                removeSection = name !== undefined && emittedNames.has(name);
            }
        }
        if (!removeSection) output.push(line);
    }

    // Remove trailing blank lines before appending MCP section
    while (output.length && output[output.length - 1]!.trim() === '') output.pop();
    return output.join('\n') + '\n\n' + newMcpToml;
}

/** Patch JSON file — merge a block into existing JSON without losing other keys */
function patchJsonFile(filePath: string, patchObj: Record<string, unknown>) {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { }
    const merged = { ...existing, ...patchObj };
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 4) + '\n');
}

// ─── Sync to all targets ──────────────────────────

/**
 * Sync unified MCP config to all CLI config files (global paths only).
 * @param {Object} config - Unified MCP config { servers: {...} }
 */
export function syncToAll(config: UnifiedMcpConfig) {
    const results = { claude: false, codex: false, gemini: false, opencode: false, copilot: false, antigravity: false, cursor: false, kiro: false };

    // 1. Claude Code: ~/.claude.json (user scope — NOT ~/.mcp.json which is project-scope only)
    try {
        const claudePath = join(os.homedir(), '.claude.json');
        const claudeData = toClaudeMcp(config);
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = { ...(existing["mcpServers"] as Record<string, unknown> ?? {}), ...claudeData.mcpServers };
        fs.writeFileSync(claudePath, JSON.stringify(existing, null, 4) + '\n');
        results.claude = true;
        console.log(`[mcp-sync] ✅ Claude: ${claudePath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Claude:`, (e as Error).message); }

    // 2. Codex: ~/.codex/config.toml
    try {
        const codexPath = join(os.homedir(), '.codex', 'config.toml');
        if (fs.existsSync(codexPath)) {
            const existing = fs.readFileSync(codexPath, 'utf8');
            const mcpToml = toCodexToml(config);
            const emittedNames = new Set(Object.keys(config.servers ?? {}).filter(name => name !== COMPUTER_USE_MCP_NAME));
            fs.writeFileSync(codexPath, patchCodexToml(existing, mcpToml, emittedNames));
            results.codex = true;
            console.log(`[mcp-sync] ✅ Codex: ${codexPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Codex: config.toml not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Codex:`, (e as Error).message); }

    // 3. Gemini CLI: ~/.gemini/settings.json
    try {
        const geminiPath = join(os.homedir(), '.gemini', 'settings.json');
        if (fs.existsSync(geminiPath)) {
            const geminiData = toClaudeMcp(config);
            patchJsonFile(geminiPath, { mcpServers: geminiData.mcpServers });
            results.gemini = true;
            console.log(`[mcp-sync] ✅ Gemini: ${geminiPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Gemini: settings.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Gemini:`, (e as Error).message); }

    // 4. OpenCode: ~/.config/opencode/opencode.json
    try {
        const opencodePath = join(os.homedir(), '.config', 'opencode', 'opencode.json');
        if (fs.existsSync(opencodePath)) {
            const ocMcp = toOpenCodeMcp(config);
            patchJsonFile(opencodePath, { mcp: ocMcp });
            results.opencode = true;
            console.log(`[mcp-sync] ✅ OpenCode: ${opencodePath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ OpenCode: opencode.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ OpenCode:`, (e as Error).message); }

    // 5. Copilot: ~/.copilot/mcp-config.json
    try {
        const copilotDir = join(os.homedir(), '.copilot');
        const copilotPath = join(copilotDir, 'mcp-config.json');
        const copilotData = toClaudeMcp(config); // same format as Claude
        fs.mkdirSync(copilotDir, { recursive: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(copilotPath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = { ...(existing["mcpServers"] as Record<string, unknown> ?? {}), ...copilotData.mcpServers };
        fs.writeFileSync(copilotPath, JSON.stringify(existing, null, 4) + '\n');
        results.copilot = true;
        console.log(`[mcp-sync] ✅ Copilot: ${copilotPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Copilot:`, (e as Error).message); }

    // 6. Cursor: ~/.cursor/mcp.json
    try {
        const cursorDir = join(os.homedir(), '.cursor');
        const cursorPath = join(cursorDir, 'mcp.json');
        const cursorData = toClaudeMcp(config);
        fs.mkdirSync(cursorDir, { recursive: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = { ...(existing["mcpServers"] as Record<string, unknown> ?? {}), ...cursorData.mcpServers };
        fs.writeFileSync(cursorPath, JSON.stringify(existing, null, 4) + '\n');
        results.cursor = true;
        console.log(`[mcp-sync] ✅ Cursor: ${cursorPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Cursor:`, (e as Error).message); }

    // 7. Antigravity: ~/.gemini/antigravity/mcp_config.json
    try {
        const antigravityPath = join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
        const antigravityData = toClaudeMcp(config); // same mcpServers format
        fs.mkdirSync(dirname(antigravityPath), { recursive: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(antigravityPath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = { ...(existing["mcpServers"] as Record<string, unknown> ?? {}), ...antigravityData.mcpServers };
        fs.writeFileSync(antigravityPath, JSON.stringify(existing, null, 4) + '\n');
        results.antigravity = true;
        console.log(`[mcp-sync] ✅ Antigravity: ${antigravityPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Antigravity:`, (e as Error).message); }

    // 8. Kiro: ~/.kiro/settings/mcp.json (JSON mcpServers — same format as Claude)
    // This is the global MCP config; per-agent override is ~/.kiro/agents/<name>.json.
    // Grok is NOT a dedicated target — it reads ~/.cursor/mcp.json via compat scan (#6).
    try {
        const kiroDir = join(os.homedir(), '.kiro', 'settings');
        const kiroPath = join(kiroDir, 'mcp.json');
        const kiroData = toClaudeMcp(config);
        fs.mkdirSync(kiroDir, { recursive: true });
        patchJsonFile(kiroPath, { mcpServers: kiroData.mcpServers });
        results.kiro = true;
        console.log(`[mcp-sync] ✅ Kiro: ${kiroPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Kiro:`, (e as Error).message); }

    return results;
}
