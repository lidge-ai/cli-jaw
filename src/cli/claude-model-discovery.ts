/**
 * Live Claude model catalog, read from the installed Claude Code bundle.
 *
 * Claude Code exposes no `--list-models` command and `claude models` does not
 * exist, so the only observation available is the bundle itself. It carries the
 * provider mapping table for every model it accepts (`first_party:"claude-..."`),
 * the short-alias table it resolves `opus`/`sonnet`/`haiku`/`fable` through, and
 * a literal `<id>[1m]` for each model whose 1M context window it enables.
 *
 * Reading a 190MB binary sounds expensive; measured against Claude Code 2.1.263 a
 * streaming scan finishes in ~105ms, which fits the background-refresh pattern the
 * Codex catalog already uses. This is a file read, so it does not violate the
 * "catalogs must never execute a CLI" rule in code-mode/providers/catalog.ts.
 */
import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface ClaudeBundleCatalog {
    /** Full first-party model ids the bundle maps to a provider. */
    firstParty: string[];
    /** Short alias -> full id, as the bundle resolves them. */
    aliases: Record<string, string>;
    /** Model ids for which the bundle carries a literal `<id>[1m]`. */
    oneMillion: string[];
}

/**
 * Generations old enough that the bundle keeps them only for compatibility. They
 * are real ids the CLI would accept, but offering `claude-3-5-sonnet-20241022` in
 * a picker is noise, so discovery keeps the modern families and lets the static
 * seed decide anything older.
 */
const LEGACY_ID_PATTERN = /^claude-(?:3-|opus-4-(?:0|1|20|5)|sonnet-4-(?:0|20|5)|haiku-(?:3|4-5-2))/;

/**
 * `mythos` ids appear in the bundle's provider table but are not offered as coding
 * models by the CLI, so they are excluded rather than surfaced as selectable.
 */
const EXCLUDED_FAMILY_PATTERN = /^claude-mythos-/;

const FIRST_PARTY = /first_party:"(claude-[a-z0-9.-]+)"/g;
const ALIAS_TABLE = /\{fable:"([^"]+)",opus:"([^"]+)",sonnet:"([^"]+)",haiku:"([^"]+)"\}/;
const ONE_MILLION = /"(claude-[a-z0-9.-]+)\[1m\]"/g;

/** Longest pattern we must not split across chunk boundaries. */
const OVERLAP_BYTES = 512;

function isOfferable(id: string): boolean {
    return !LEGACY_ID_PATTERN.test(id) && !EXCLUDED_FAMILY_PATTERN.test(id);
}

/**
 * Accumulate catalog evidence across a chunk sequence.
 *
 * Exported for tests: the parse is a pure fold over strings, so a fixture can
 * exercise it without a 190MB binary. Callers must feed overlapping chunks (see
 * `readClaudeBundleCatalog`) or a pattern spanning a boundary is missed.
 */
export function createClaudeCatalogScanner() {
    const firstParty = new Set<string>();
    const oneMillion = new Set<string>();
    let aliases: Record<string, string> | null = null;

    return {
        push(chunk: string): void {
            FIRST_PARTY.lastIndex = 0;
            for (let m = FIRST_PARTY.exec(chunk); m; m = FIRST_PARTY.exec(chunk)) {
                if (m[1]) firstParty.add(m[1]);
            }
            ONE_MILLION.lastIndex = 0;
            for (let m = ONE_MILLION.exec(chunk); m; m = ONE_MILLION.exec(chunk)) {
                if (m[1]) oneMillion.add(m[1]);
            }
            if (!aliases) {
                const table = ALIAS_TABLE.exec(chunk);
                if (table) {
                    aliases = {
                        fable: table[1]!, opus: table[2]!,
                        sonnet: table[3]!, haiku: table[4]!,
                    };
                }
            }
        },
        result(): ClaudeBundleCatalog {
            const offerable = [...firstParty].filter(isOfferable).sort();
            return {
                firstParty: offerable,
                aliases: aliases ?? {},
                // A 1M literal for a model we do not offer is not useful, and it would
                // otherwise let a filtered legacy id back in through the variant list.
                oneMillion: [...oneMillion].filter(isOfferable).sort(),
            };
        },
    };
}

/** @internal exported for unit tests */
export function parseClaudeBundleCatalog(chunks: readonly string[]): ClaudeBundleCatalog {
    const scanner = createClaudeCatalogScanner();
    for (const chunk of chunks) scanner.push(chunk);
    return scanner.result();
}

/**
 * Expand a catalog into the model list cli-jaw offers.
 *
 * `[1m]` variants are derived from observation rather than listed by hand: the
 * bundle carries the literal only for models whose 1M window it enables, which is
 * why Haiku has no variant. Aliases come first because Claude Code resolves them
 * to the current snapshot, then pinned ids for callers who want a stable cache
 * prefix across CLI updates.
 */
export function claudeCatalogToChoices(catalog: ClaudeBundleCatalog): string[] {
    const oneMillion = new Set(catalog.oneMillion);
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        if (!value || seen.has(value)) return;
        seen.add(value);
        out.push(value);
    };

    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
        if (catalog.aliases[alias]) push(alias);
    }
    for (const id of catalog.firstParty) {
        push(id);
        if (oneMillion.has(id)) push(`${id}[1m]`);
    }
    return out;
}

/**
 * Stream the bundle and extract its catalog. Returns null on any read failure so
 * the caller keeps whatever it already had.
 */
export async function readClaudeBundleCatalog(binaryPath: string): Promise<ClaudeBundleCatalog | null> {
    if (!binaryPath) return null;
    try {
        const scanner = createClaudeCatalogScanner();
        const stream = createReadStream(binaryPath, { highWaterMark: 1 << 20 });
        let tail = '';
        for await (const chunk of stream) {
            // latin1 keeps one byte per char, so a regex offset cannot desynchronize
            // from the file the way a multi-byte decode would.
            const text = tail + (chunk as Buffer).toString('latin1');
            scanner.push(text);
            tail = text.slice(-OVERLAP_BYTES);
        }
        const catalog = scanner.result();
        // An empty scan means the bundle shape changed. Reporting null lets the
        // static seed stand instead of emptying the picker.
        return catalog.firstParty.length > 0 ? catalog : null;
    } catch {
        return null;
    }
}

interface CachedCatalog {
    key: string;
    catalog: ClaudeBundleCatalog;
}

let cached: CachedCatalog | null = null;

/**
 * Cached read keyed on the bundle's size and mtime. Claude Code replaces the whole
 * file on update, so that pair changes exactly when the catalog can change, and a
 * steady-state install pays the scan once.
 */
export async function resolveClaudeBundleCatalog(binaryPath: string): Promise<ClaudeBundleCatalog | null> {
    if (!binaryPath) return null;
    let key: string;
    try {
        const info = await stat(binaryPath);
        key = `${binaryPath}:${info.size}:${info.mtimeMs}`;
    } catch {
        return null;
    }
    if (cached && cached.key === key) return cached.catalog;
    const catalog = await readClaudeBundleCatalog(binaryPath);
    if (!catalog) return null;
    cached = { key, catalog };
    return catalog;
}

/** Cached catalog for this exact binary (size+mtime), or null when not read yet. Never reads the bundle. */
export function peekClaudeBundleCatalog(binaryPath: string): ClaudeBundleCatalog | null {
    if (!binaryPath || !cached) return null;
    try {
        const info = statSync(binaryPath);
        return cached.key === `${binaryPath}:${info.size}:${info.mtimeMs}` ? cached.catalog : null;
    } catch {
        return null;
    }
}

/** @internal exported for unit tests */
export function resetClaudeBundleCatalogCacheForTest(): void {
    cached = null;
}
