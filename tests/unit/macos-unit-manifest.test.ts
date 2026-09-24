import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { readManifest, MANIFEST_PATH } from '../../scripts/ci/macos-unit-manifest.mjs';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const workflow = yaml.parse(readFileSync(join(projectRoot, '.github/workflows/test.yml'), 'utf8'));

test('MUM-001: the committed manifest validates and lists only existing tests/unit files', () => {
    const entries = readManifest(MANIFEST_PATH, { root: projectRoot });
    assert.ok(entries.length >= 15, `expected the macOS lane files, got ${entries.length}`);
    assert.equal(new Set(entries).size, entries.length);
    for (const e of entries) assert.match(e, /^tests\/unit\/[A-Za-z0-9_-]+\.test\.ts$/);
});

test('MUM-002: CLI --print emits the validated list and exits 1 on a defect', () => {
    const ok = spawnSync(process.execPath, ['scripts/ci/macos-unit-manifest.mjs', '--print'], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const printed = ok.stdout.trim().split('\n');
    assert.deepEqual(printed, readManifest(MANIFEST_PATH, { root: projectRoot }));
});

test('MUM-003: the cross-platform lanes are scheduled off pull_request and into ci-aggregate', () => {
    // The PR contract is the minimal Linux set; windows-unit and macos-unit
    // produce their evidence on push to dev/preview/main and on dispatch. A
    // lane that could schedule on pull_request — or that the aggregate does
    // not wait on — is the drift this test exists to catch.
    const jobs = (workflow.jobs ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of ['windows-unit', 'macos-unit']) {
        const job = jobs[name];
        assert.ok(job, `${name} job must exist in test.yml`);
        const condition = String(job['if'] ?? '');
        assert.match(condition, /event_name\s*!=\s*'pull_request'/,
            `${name} must not be schedulable on pull_request (got: ${condition})`);
        assert.match(condition, /changes\.outputs\.code/,
            `${name} must stay behind the changes classifier`);
        const aggregate = jobs['ci-aggregate'];
        assert.ok(aggregate, 'ci-aggregate job must exist');
        assert.ok((aggregate['needs'] as string[]).includes(name),
            `ci-aggregate needs must include ${name}`);
        const env = JSON.stringify(
            (aggregate['steps'] as Record<string, Record<string, unknown>>[])
                .map(step => step['env'] ?? {}));
        const envKey = name === 'windows-unit' ? 'WINDOWS_UNIT_RESULT' : 'MACOS_UNIT_RESULT';
        assert.ok(env.includes(envKey), `ci-aggregate must read ${envKey}`);
    }
    assert.equal(String(jobs['macos-unit']!['runs-on']), 'macos-latest',
        'the macOS lane must run on a real darwin runner');
});
