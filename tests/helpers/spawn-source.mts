// spawnAgent's source spans src/agent/spawn.ts and the backend modules it dispatches to
// (src/agent/spawn/backend-*.ts). Tests that assert presence, absence or counts of
// spawnAgent source text read this concatenation so the assertion keeps covering the
// whole function. Window/slice assertions must read the one file that owns the text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStrictPropertyAccess } from '../unit/source-normalize.ts';

const AGENT_DIR = join(import.meta.dirname, '..', '..', 'src', 'agent');

export const SPAWN_BACKEND_FILES = [
    'backend-native-acp.ts',
    'backend-copilot.ts',
    'backend-pi.ts',
    'backend-codex-app.ts',
] as const;

export function spawnSourcePath(file = 'spawn.ts'): string {
    return file === 'spawn.ts' ? join(AGENT_DIR, 'spawn.ts') : join(AGENT_DIR, 'spawn', file);
}

/**
 * Text of one spawn source file (spawn.ts or a backend module). `normalized` applies
 * the same strict-property-access normalization as tests/unit/source-normalize.ts.
 */
export function readSpawnFile(file = 'spawn.ts', opts: { normalized?: boolean } = {}): string {
    const text = readFileSync(spawnSourcePath(file), 'utf8');
    return opts.normalized ? normalizeStrictPropertyAccess(text) : text;
}

/** spawn.ts followed by every backend module, separated by a newline. */
export function readSpawnAgentSource(opts: { normalized?: boolean } = {}): string {
    return [readSpawnFile('spawn.ts', opts), ...SPAWN_BACKEND_FILES.map((f) => readSpawnFile(f, opts))].join('\n');
}
