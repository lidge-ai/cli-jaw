/**
 * Live OpenCode model inventory, read from `opencode models`.
 *
 * The registry carried the opencode-go roster by hand, copied from opencodex
 * metadata. The CLI lists every model the user's configured providers serve,
 * including providers no static list could have predicted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectCli } from '../core/cli-detection.js';

const execFileAsync = promisify(execFile);

/** The provider the static roster and the default model belong to. */
const PREFERRED_PROVIDER = 'opencode-go';
/** A sanity bound; a real listing across many providers stays well below it. */
const MAX_MODELS = 2000;

export interface OpencodeModelInventory {
    /** `provider/model` ids, the form `opencode run -m` takes. */
    models: string[];
    source: string;
}

/**
 * Parse `opencode models` output.
 *
 * Each line is one `provider/model` id. Model ids may themselves contain slashes
 * (`openrouter/anthropic/claude-x`), so only the first segment is the provider.
 *
 *   opencode-go/kimi-k2.7-code
 *   google/gemini-3.6-flash
 *
 * Lines without a slash or with whitespace are logs, never models. The
 * opencode-go provider is listed first because the default lives there; the
 * rest keep the CLI's order.
 */
export function parseOpencodeModelList(stdout: string): OpencodeModelInventory | null {
    const preferred: string[] = [];
    const rest: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!/^[A-Za-z0-9][\w.@:+-]*\/\S+$/.test(line)) continue;
        if (seen.has(line)) continue;
        if (seen.size >= MAX_MODELS) break;
        seen.add(line);
        (line.startsWith(`${PREFERRED_PROVIDER}/`) ? preferred : rest).push(line);
    }

    const models = [...preferred, ...rest];
    if (models.length === 0) return null;
    return { models, source: 'opencode models' };
}

/** Run the CLI and parse its listing. Any failure answers null. */
export async function fetchOpencodeModelInventory(binary?: string): Promise<OpencodeModelInventory | null> {
    const resolvedBinary = binary || detectCli('opencode').path;
    if (!resolvedBinary) return null;
    try {
        const { stdout } = await execFileAsync(resolvedBinary, ['models'], {
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, NO_COLOR: '1' },
        });
        return parseOpencodeModelList(stdout);
    } catch {
        return null;
    }
}
