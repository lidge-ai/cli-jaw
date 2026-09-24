import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The workflow-time helpers under .github/scripts/ carry their own node:test
// suites (*.test.cjs). They cannot sit under tests/ — the screenshot-gate
// workflow fetches the helper raw from the trusted branch — so this wrapper
// runs each suite as a subprocess and keeps it inside the normal unit scope.
const scriptsDir = resolve(import.meta.dirname, '../../.github/scripts');
const suites = readdirSync(scriptsDir)
    .filter(name => name.endsWith('.test.cjs'))
    .map(name => join(scriptsDir, name));

test('workflow helper scripts pass their own node:test suites', () => {
    assert.ok(suites.length > 0, 'expected at least one .github/scripts/*.test.cjs suite');
    for (const suite of suites) {
        const result = spawnSync(process.execPath, ['--test', suite], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${suite}\n${result.stdout}\n${result.stderr}`);
    }
});
