// ─── Codex config.toml (read-only) ──────────────────
// Read-only diagnostics over ~/.codex/config.toml. cli-jaw never writes this
// file: it is shared with Codex used outside cli-jaw.

import os from 'os';
import fs from 'fs';
import { join } from 'path';

const CODEX_CONFIG = join(os.homedir(), '.codex', 'config.toml');

/** Read only the root openai_base_url, never a same-named key inside a TOML table. */
export function readCodexRootOpenAiBaseUrl(content?: string): string | null {
    let source = content;
    if (source === undefined) {
        try { source = fs.readFileSync(CODEX_CONFIG, 'utf8'); }
        catch { return null; }
    }
    const root = source.split('\n').filter((line) => !/^\s*\[/.test(line));
    const firstTableIndex = source.split('\n').findIndex((line) => /^\s*\[/.test(line));
    const rootLines = firstTableIndex < 0 ? root : source.split('\n').slice(0, firstTableIndex);
    for (const line of rootLines) {
        const match = line.match(/^\s*openai_base_url\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
        if (match?.[2]) return match[2];
    }
    return null;
}
