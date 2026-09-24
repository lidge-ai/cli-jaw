/**
 * Live AGY model inventory, read from `agy models`.
 *
 * The registry list was refreshed by hand against one AGY release, and Google
 * retires the previous Flash generation from Antigravity soon after the next one
 * ships. Reading the binary keeps the picker on models AGY can actually serve.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectCli } from '../core/cli-detection.js';

const execFileAsync = promisify(execFile);

export interface AgyModelInventory {
    /** Tier-bearing labels, the form `agy --model` accepts without `--effort`. */
    models: string[];
    /** Label → effort-suffixed slug, kept for diagnostics. */
    slugs: Record<string, string>;
    source: string;
}

/**
 * Parse `agy models` output.
 *
 * After a `Fetching available models...` banner, each row is two tab-separated
 * columns: the effort-suffixed slug, then the label.
 *
 *   gemini-3.8-flash-high	Gemini 3.8 Flash (High)
 *   claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
 *
 * Only the label is kept as the choice. cli-jaw never sends `--effort` for AGY,
 * and AGY rejects a tier-less slug in that shape ("requires --effort"). A line
 * without a tab is banner or noise, never a model.
 */
export function parseAgyModelList(stdout: string): AgyModelInventory | null {
    const models: string[] = [];
    const slugs: Record<string, string> = {};
    const seen = new Set<string>();

    for (const rawLine of stdout.split(/\r?\n/)) {
        const tab = rawLine.indexOf('\t');
        if (tab < 0) continue;
        const slug = rawLine.slice(0, tab).trim();
        const label = rawLine.slice(tab + 1).trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || !label) continue;
        if (seen.has(label)) continue;
        seen.add(label);
        models.push(label);
        slugs[label] = slug;
    }

    if (models.length === 0) return null;
    return { models, slugs, source: 'agy models' };
}

/** Run the CLI and parse its listing. Any failure answers null. */
export async function fetchAgyModelInventory(binary?: string): Promise<AgyModelInventory | null> {
    const resolvedBinary = binary || detectCli('agy').path;
    if (!resolvedBinary) return null;
    try {
        const { stdout } = await execFileAsync(resolvedBinary, ['models'], {
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, NO_COLOR: '1' },
        });
        return parseAgyModelList(stdout);
    } catch {
        return null;
    }
}
