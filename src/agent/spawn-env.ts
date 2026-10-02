import type { AsideSelection } from '../shared/aside-contract.js';
import fs from 'fs';
import os from 'os';
import { dirname, join } from 'path';
import { splitPathList } from '../core/runtime-path.js';

const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';
const OPENCODE_ALLOW_PERMISSIONS = [
    '*',
    'bash',
    'codesearch',
    'doom_loop',
    'edit',
    'external_directory',
    'glob',
    'grep',
    'list',
    'lsp',
    'question',
    'read',
    'skill',
    'task',
    'todoread',
    'todowrite',
    'webfetch',
    'websearch',
] as const;

function readPathValue(env: Record<string, string | undefined>): string {
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === 'path' && value) return value;
    }
    return '';
}

function withoutPathKeys(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
    const withoutTrailingSeparators = entry.replace(/[\\/]+$/, '');
    return platform === 'win32'
        ? withoutTrailingSeparators.toLowerCase()
        : withoutTrailingSeparators;
}

function prependPathDir(
    extraEnv: Record<string, string>,
    inheritedEnv: NodeJS.ProcessEnv,
    dir: string,
    platform: NodeJS.Platform,
): Record<string, string> {
    const currentPath = readPathValue(extraEnv) || readPathValue(inheritedEnv);
    const normalizedDir = normalizePathEntry(dir, platform);
    const parts: string[] = [];
    const seen = new Set<string>([normalizedDir]);
    for (const part of splitPathList(currentPath, platform)) {
        const key = normalizePathEntry(part, platform);
        // Windows PATH lookup is case-insensitive, so 'C:\\Tools;c:\\tools' is one
        // directory listed twice (#366). POSIX is case-sensitive and duplicate
        // entries are the caller's business, so only dedupe the preferred dir there.
        if (platform === 'win32') {
            if (seen.has(key)) continue;
            seen.add(key);
        } else if (key === normalizedDir) {
            continue;
        }
        parts.push(part);
    }
    return {
        ...withoutPathKeys(extraEnv),
        PATH: [dir, ...parts].join(platform === 'win32' ? ';' : ':'),
    };
}

export function getOpencodePreferredBinDir(): string {
    return join(os.homedir(), '.bun', 'bin');
}

/**
 * Merge an env delta over a base env without reintroducing duplicate
 * Path/PATH keys on Windows (#382, residual of #366). A plain spread of
 * `{ ...base, ...extra }` where base carries 'Path' and extra carries 'PATH'
 * leaves both keys in the object, and the child resolves whichever was
 * written last. On POSIX the spread is returned unchanged (case-sensitive
 * env, both keys are real variables).
 */
export function mergeEnvWindowsSafe(
    base: NodeJS.ProcessEnv,
    extra: Record<string, string>,
    platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...base, ...extra };
    if (platform !== 'win32') return merged;
    const path = readPathValue(extra) || readPathValue(base);
    for (const key of Object.keys(merged)) {
        if (key.toLowerCase() === 'path') delete merged[key];
    }
    if (path) merged['PATH'] = path;
    return merged;
}

export function applyCliEnvDefaults(
    cli: string,
    extraEnv: Record<string, string> = {},
    inheritedEnv: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): Record<string, string> {

    if (cli === 'agy' || cli === 'kiro-code' || cli === 'grok') {
        return {
            ...extraEnv,
            NO_COLOR: extraEnv["NO_COLOR"] ?? inheritedEnv["NO_COLOR"] ?? '1',
        };
    }

    // cursor-agent on macOS dies on a locked login keychain unless it is told
    // to use file-backed credentials. The launchd plist injects this on the
    // PARENT (launchd-plist.ts), so service children inherit it — the gap is a
    // foreground `jaw serve` or an SSH session, where nothing sets it (#393).
    // Only when unset: a user who chose `keychain` keeps their choice.
    if (cli === 'cursor' && platform === 'darwin') {
        return {
            ...extraEnv,
            AGENT_CLI_CREDENTIAL_STORE: extraEnv["AGENT_CLI_CREDENTIAL_STORE"]
                ?? inheritedEnv["AGENT_CLI_CREDENTIAL_STORE"]
                ?? 'file',
        };
    }

    if (cli !== 'opencode') return extraEnv;
    const withPath = prependPathDir(extraEnv, inheritedEnv, getOpencodePreferredBinDir(), platform);
    if (withPath["OPENCODE_ENABLE_EXA"] !== undefined) return withPath;
    if (inheritedEnv["OPENCODE_ENABLE_EXA"] !== undefined) return withPath;
    return {
        ...withPath,
        OPENCODE_ENABLE_EXA: 'true',
    };
}

function isTruthyEnv(value: string | undefined): boolean {
    if (!value) return false;
    return value === '1' || value.toLowerCase() === 'true';
}

export function buildSessionResumeKey(
    cli: string,
    env: Record<string, string | undefined>,
): string | null {
    if (cli !== 'opencode') return null;
    return `exa=${isTruthyEnv(env["OPENCODE_ENABLE_EXA"]) ? '1' : '0'}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function withOpencodeAlwaysAllowPermissions(config: unknown): Record<string, unknown> {
    const next = isPlainObject(config) ? { ...config } : {};
    if (typeof next["$schema"] !== 'string') next["$schema"] = OPENCODE_CONFIG_SCHEMA;

    const permission = isPlainObject(next["permission"]) ? { ...next["permission"] } : {};
    for (const key of OPENCODE_ALLOW_PERMISSIONS) {
        permission[key] = 'allow';
    }
    next["permission"] = permission;
    return next;
}

export function ensureOpencodeAlwaysAllowPermissions(
    configPath = join(os.homedir(), '.config', 'opencode', 'opencode.json'),
): void {
    try {
        let current: unknown = {};
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8').trim();
            current = raw ? JSON.parse(raw) : {};
        }

        const next = withOpencodeAlwaysAllowPermissions(current);
        const serialized = `${JSON.stringify(next, null, 2)}\n`;
        const currentSerialized = fs.existsSync(configPath)
            ? fs.readFileSync(configPath, 'utf8')
            : '';
        if (currentSerialized === serialized) return;

        fs.mkdirSync(dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, serialized);
    } catch (error) {
        console.warn('[jaw:opencode] permission sync failed:', (error as Error).message);
    }
}

/** Full concrete identity; changing any selector starts a fresh Aside session. */
export function buildAsideResumeKey(selection: AsideSelection, cwd: string, policy: 'auto' | 'safe'): string {
    return JSON.stringify(['aside-v1', selection.account, selection.host, selection.provider,
        selection.modelId, selection.effort, cwd, policy]);
}
