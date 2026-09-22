/**
 * lib/mcp/mcp-install.ts
 * npm/uv install for MCP servers, binary lookup.
 */

// Phase 12.1.3: npx package → global binary mapping
const NPX_TO_GLOBAL = {
    '@upstash/context7-mcp': { pkg: '@upstash/context7-mcp', bin: 'context7-mcp' },
} satisfies Record<string, { pkg: string; bin: string }>;

type McpInstallServer = {
    url?: string;
    command?: string;
    args?: string[];
};

type McpInstallConfig = {
    servers?: Record<string, McpInstallServer>;
};

type McpInstallResult = {
    status: 'skip' | 'installed' | 'error';
    reason?: string;
    bin?: string;
    eco?: 'npm' | 'pypi';
    message?: string;
};

function resolveNpxPackage(args: readonly string[] | undefined) {
    const pkg = (args ?? []).find((a) => !a.startsWith('-'));
    return pkg ? NPX_TO_GLOBAL[pkg as keyof typeof NPX_TO_GLOBAL] ?? null : null;
}

/**
 * Phase 12.1.3: Install MCP servers globally.
 * npx-based → npm i -g, uv-based → uv tool install.
 * Returns per-server results.
 */
export async function installMcpServers(config: McpInstallConfig) {
    const { execSync, execFileSync } = await import('child_process');
    const results: Record<string, McpInstallResult> = {};
    const pathLookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const findBinary = (name: string) => {
        try {
            const raw = execFileSync(pathLookupCmd, [name], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
            return raw.split(/\r?\n/).map(x => x.trim()).find(Boolean) || name;
        } catch {
            return name;
        }
    };

    for (const [name, srv] of Object.entries(config.servers || {})) {
        // URL-based remote servers do not need a local binary.
        if (srv.url) {
            results[name] = { status: 'skip', reason: 'remote url' };
            continue;
        }

        // Skip already-global servers
        if (srv.command !== 'npx' && srv.command !== 'uv' && srv.command !== 'uvx') {
            results[name] = { status: 'skip', reason: 'already global' };
            continue;
        }

        try {
            if (srv.command === 'npx') {
                // npm ecosystem
                const info = resolveNpxPackage(srv.args);
                if (!info) { results[name] = { status: 'skip', reason: 'unknown npm pkg' }; continue; }

                console.log(`[mcp:install] npm i -g ${info.pkg} ...`);
                execSync(`npm i -g ${info.pkg}`, { stdio: 'pipe', timeout: 120000 });

                const binPath = findBinary(info.bin);

                srv.command = info.bin;
                srv.args = [];
                results[name] = { status: 'installed', bin: binPath, eco: 'npm' };
                console.log(`[mcp:install] ✅ ${name} → ${binPath}`);

            } else {
                // uv/uvx ecosystem (pypi)
                const pkg = (srv.args || []).find((a) => !a.startsWith('-') && !a.startsWith('/'));
                if (!pkg) { results[name] = { status: 'skip', reason: 'no pypi pkg found' }; continue; }

                console.log(`[mcp:install] uv tool install ${pkg} ...`);
                try {
                    execSync(`uv tool install ${pkg}`, { stdio: 'pipe', timeout: 120000 });
                } catch {
                    try { execSync(`uv tool upgrade ${pkg}`, { stdio: 'pipe', timeout: 120000 }); }
                    catch { /* already latest */ }
                }

                const binPath = findBinary(pkg);

                srv.command = binPath || pkg;
                srv.args = [];
                results[name] = { status: 'installed', bin: binPath, eco: 'pypi' };
                console.log(`[mcp:install] ✅ ${name} → ${binPath}`);
            }
        } catch (e: unknown) {
            results[name] = { status: 'error', message: (e as Error).message?.slice(0, 200) };
            console.error(`[mcp:install] ❌ ${name}: ${(e as Error).message?.slice(0, 100)}`);
        }
    }

    return results;
}
