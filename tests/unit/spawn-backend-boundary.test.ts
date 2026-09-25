import test from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_BACKEND_FILES, readSpawnFile } from '../helpers/spawn-source.mts';

// spawnAgent dispatches four backends to src/agent/spawn/backend-*.ts. These checks keep
// that boundary from eroding: one dispatch per backend in spawn.ts, the backend bodies
// stay out of spawn.ts, and no backend imports spawn.ts at runtime (it would be a cycle).
const BACKENDS = [
    { file: 'backend-native-acp.ts', fn: 'runNativeAcpBackend', marker: 'replaceAcpMainTurn(' },
    { file: 'backend-copilot.ts', fn: 'runCopilotBackend', marker: 'extractFromAcpUpdate(' },
    { file: 'backend-pi.ts', fn: 'runPiBackend', marker: 'appendPiStderr(' },
    { file: 'backend-codex-app.ts', fn: 'runCodexAppBackend', marker: 'abandonTurn(' },
] as const;

test('spawn.ts dispatches each backend exactly once', () => {
    const spawnSrc = readSpawnFile('spawn.ts');
    for (const b of BACKENDS) {
        const calls = spawnSrc.split(`return ${b.fn}(backendLocals, backendHost);`).length - 1;
        assert.equal(calls, 1, `${b.fn} should be dispatched once from spawnAgent`);
    }
});

test('backend bodies live in their modules, not in spawn.ts', () => {
    const spawnSrc = readSpawnFile('spawn.ts');
    for (const b of BACKENDS) {
        assert.ok(readSpawnFile(b.file).includes(b.marker), `${b.file} should own ${b.marker}`);
        assert.ok(!spawnSrc.includes(b.marker), `${b.marker} moved back into spawn.ts`);
    }
});

// Type-only imports are erased at compile time; every other reference to ../spawn
// (static, multi-line, export-from, dynamic import() or require()) loads it at runtime.
// Anchored to a statement start and never crossing another `import`, so an unterminated
// (ASI) type import cannot swallow the runtime import that follows it.
const TYPE_ONLY_SPAWN_IMPORT = /^[ \t]*import\s+type\s(?:(?!\bimport\b)[^;])*?from\s*['"]\.\.\/spawn(?:\.js|\.ts)?['"]\s*;?/gms;
const SPAWN_SPECIFIER = /['"]\.\.\/spawn(?:\.js|\.ts)?['"]/g;

function runtimeSpawnReferences(src: string): string[] {
    return src.replace(TYPE_ONLY_SPAWN_IMPORT, '').match(SPAWN_SPECIFIER) ?? [];
}

test('runtime spawn.ts reference matcher catches every import form', () => {
    for (const form of [
        "import { spawnAgent } from '../spawn.js';",
        "import {\n    spawnAgent,\n} from '../spawn.js';",
        "export { spawnAgent } from '../spawn.js';",
        "const m = await import('../spawn.js');",
        "const m = require('../spawn');",
        "import type { X } from './other.js'\nimport { spawnAgent } from '../spawn.js'",
        "import { type SpawnOpts } from '../spawn.js';",
    ]) assert.equal(runtimeSpawnReferences(form).length, 1, form);
    for (const form of [
        "import type { SpawnOpts } from '../spawn.js';",
        "import type {\n    SpawnOpts,\n} from '../spawn.js';",
        "import { x } from '../spawn/queue.js';",
    ]) assert.equal(runtimeSpawnReferences(form).length, 0, form);
});

test('backend modules never import spawn.ts at runtime', () => {
    assert.deepEqual([...SPAWN_BACKEND_FILES].sort(), BACKENDS.map((b) => b.file).sort());
    for (const file of [...SPAWN_BACKEND_FILES, 'backend-context.ts', 'types.ts']) {
        assert.deepEqual(runtimeSpawnReferences(readSpawnFile(file)), [], `${file} must not load ../spawn.js at runtime`);
    }
});
