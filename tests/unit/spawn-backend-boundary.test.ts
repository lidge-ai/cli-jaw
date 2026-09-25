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

test('backend modules never import spawn.ts at runtime', () => {
    assert.deepEqual([...SPAWN_BACKEND_FILES].sort(), BACKENDS.map((b) => b.file).sort());
    for (const file of [...SPAWN_BACKEND_FILES, 'backend-context.ts', 'types.ts']) {
        const src = readSpawnFile(file);
        const valueImports = src.split('\n').filter((l) => /^import\s+(?!type\b)[^;]*from '\.\.\/spawn(\.js)?';/.test(l));
        assert.deepEqual(valueImports, [], `${file} must not value-import ../spawn.js`);
    }
});
