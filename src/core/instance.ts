/**
 * Shared instance utilities for launchd / systemd / docker service management.
 * Zero dependencies beyond node:* and config.ts.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { JAW_HOME } from './config.js';
import { buildServicePath, resolveBundledNodePath } from './runtime-path.js';

/**
 * Derive a human-readable instance ID from JAW_HOME.
 * Default home (~/.cli-jaw) → 'default'
 * Custom home → '<basename>-<hash8>'
 */
export function instanceId(): string {
    const base = basename(JAW_HOME);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(JAW_HOME).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

export { buildServicePath } from './runtime-path.js';

function whichWithServicePath(binary: string): string {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(lookup, [binary], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: buildServicePath(process.env["PATH"] || ''),
        },
    }).trim().split(/\r?\n/)[0]!;
}

/** Resolve absolute path to node binary. */
export function getNodePath(): string {
    const bundledNode = resolveBundledNodePath();
    if (bundledNode) return bundledNode;

    try { return whichWithServicePath('node'); }
    catch { return process.execPath || '/usr/local/bin/node'; }
}

/** Resolve absolute path to jaw binary. */
export function getJawPath(): string {
    if (process.env["CLI_JAW_BIN"]) return process.env["CLI_JAW_BIN"];
    const argvPath = process.argv[1];
    if (argvPath && /(?:^|[\\/])(?:cli-jaw|jaw)(?:\.js)?$/.test(argvPath)) return argvPath;
    try { return whichWithServicePath('jaw'); }
    catch { return whichWithServicePath('cli-jaw'); }
}

/**
 * Sanitize a string for use as a systemd unit name.
 * Allowed: [a-zA-Z0-9:._-]
 * @see systemd.unit(5)
 */
export function sanitizeUnitName(name: string): string {
    return name.replace(/[^a-zA-Z0-9:._-]/g, '-');
}
