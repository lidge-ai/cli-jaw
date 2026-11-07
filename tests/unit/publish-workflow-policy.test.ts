import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parse } from 'yaml';
import { tempRepo, git, gitEnv } from './release-git-helper.js';
const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const steps = workflow.jobs.publish.steps;
function run(name: string, cwd: string, env: NodeJS.ProcessEnv) {
    const step = steps.find((candidate: {
        name?: string;
    }) => candidate.name === name);
    assert.ok(step?.run, `missing step ${name}`);
    assert.ok(!step.run.includes('${{'), 'run body must be executable without Actions interpolation');
    return spawnSync('bash', ['-c', step.run], { cwd, env: { ...gitEnv(), ...env }, encoding: 'utf8' });
}
test('publish serializes all releases', () => {
    assert.equal(workflow.concurrency.group, 'npm-publish');
});
test('release ref binds the version and dev ancestry', () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'a'), 'a');
    git(cwd, ['add', 'a']);
    git(cwd, ['commit', '-m', 'initial']);
    const sha = git(cwd, ['rev-parse', 'HEAD']);
    const bare = join(cwd, 'origin.git');
    git(cwd, ['init', '--bare', bare]);
    git(cwd, ['remote', 'add', 'origin', bare]);
    git(cwd, ['push', 'origin', 'HEAD:refs/heads/dev']);
    const base = { GITHUB_SHA: sha, EVENT_NAME: 'workflow_dispatch', INPUT_VERSION: '1.2.3' };
    for (const [ref, dry, ok] of [
        ['refs/tags/v1.2.3', 'false', true],
        ['refs/heads/dev', 'false', false],
        ['refs/heads/dev', 'true', true],
        ['refs/tags/v1.2.4', 'true', false],
        ['refs/heads/main', 'true', false],
    ] as const) {
        assert.equal(run('Verify release ref', cwd, { ...base, GITHUB_REF: ref, INPUT_DRY_RUN: dry }).status === 0, ok, ref);
    }
    writeFileSync(join(cwd, 'b'), 'b');
    git(cwd, ['add', 'b']);
    git(cwd, ['commit', '-m', 'feature']);
    assert.notEqual(run('Verify release ref', cwd, {
        ...base, GITHUB_SHA: git(cwd, ['rev-parse', 'HEAD']), GITHUB_REF: 'refs/tags/v1.2.3', INPUT_DRY_RUN: 'false',
    }).status, 0);
});
test('release config validates channel and writes outputs', () => {
    const cwd = tempRepo();
    const output = join(cwd, 'output');
    const env = { EVENT_NAME: 'workflow_dispatch', INPUT_VERSION: '1.2.3', INPUT_TAG: 'latest', INPUT_DRY_RUN: 'false', GITHUB_OUTPUT: output };
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    assert.equal(run('Resolve release config', cwd, env).status, 0);
    assert.match(readFileSync(output, 'utf8'), /version=1\.2\.3/);
    assert.notEqual(run('Resolve release config', cwd, { ...env, INPUT_TAG: 'preview' }).status, 0);
    assert.notEqual(run('Resolve release config', cwd, { ...env, INPUT_VERSION: '1.2.4' }).status, 0);
});
function certificationFixture() {
    const cwd = tempRepo();
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
query=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --jq ]; then query="$2"; shift; fi
  shift
done
printf '%s' "$RUNS" | jq -r "$query"
`, { mode: 0o755 });
    return { cwd, env: { GITHUB_SHA: 'a'.repeat(40), PATH: `${bin}:${process.env.PATH}` } };
}
test('only successful dev pushes certify tests even if a feature run is newer', () => {
    const { cwd, env } = certificationFixture();
    const runs = [
        { databaseId: 2, headSha: env.GITHUB_SHA, headBranch: 'feature' },
        { databaseId: 1, headSha: env.GITHUB_SHA, headBranch: 'dev' },
    ];
    assert.equal(run('Require successful Tests for this commit', cwd, { ...env, RUNS: JSON.stringify(runs) }).status, 0);
    assert.notEqual(run('Require successful Tests for this commit', cwd, { ...env, RUNS: JSON.stringify(runs.slice(0, 1)) }).status, 0);
});
test('platform evidence is mandatory for the release SHA', () => {
    const { cwd, env } = certificationFixture();
    assert.notEqual(run('Require successful Postinstall Platform Checks', cwd, { ...env, RUNS: '[]' }).status, 0);
    const runs = [{ headSha: env.GITHUB_SHA, url: 'https://example.invalid/run' }];
    assert.equal(run('Require successful Postinstall Platform Checks', cwd, { ...env, RUNS: JSON.stringify(runs) }).status, 0);
});
function githubReleaseFixture() {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'file'), 'x');
    git(cwd, ['add', 'file']);
    git(cwd, ['commit', '-m', 'previous']);
    git(cwd, ['tag', 'v1.2.2']);
    writeFileSync(join(cwd, 'file'), 'y');
    git(cwd, ['add', 'file']);
    git(cwd, ['commit', '-m', 'release']);
    const sha = git(cwd, ['rev-parse', 'HEAD']);
    const origin = join(cwd, 'origin.git');
    git(cwd, ['init', '--bare', origin]);
    git(cwd, ['remote', 'add', 'origin', origin]);
    git(cwd, ['tag', 'v1.2.3']);
    git(cwd, ['push', 'origin', 'refs/tags/v1.2.2']);
    git(cwd, ['push', 'origin', 'refs/tags/v1.2.3']);
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const log = join(cwd, 'commands');
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$LOG"
if [ "$1 $2" = 'release view' ]; then exit 1; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --notes-file ]; then cp "$2" "$LOG.notes"; break; fi
  shift
done
`, { mode: 0o755 });
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$LOG"
echo "\${LATEST:-1.2.3}"
`, { mode: 0o755 });
    return { cwd, log, env: { GITHUB_SHA: sha, RELEASE_VERSION: '1.2.3', RELEASE_TAG: 'latest', REF_NAME: 'v1.2.3', PATH: `${bin}:${process.env.PATH}`, LOG: log } };
}
test('fresh stable release sets Latest without reading the lagging registry', () => {
    const { cwd, log, env } = githubReleaseFixture();
    const result = run('Create GitHub release', cwd, { ...env, EXISTS: 'false', LATEST: '1.2.2' });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /--latest(?:\s|$)/);
    assert.ok(!calls.includes('npm '));
    const notes = readFileSync(`${log}.notes`, 'utf8');
    assert.match(notes, /\*\*Previous\*\*: v1\.2\.2/);
    assert.match(notes, /\*\*Commits\*\*: 1/);
    assert.match(notes, /```sh\nnpm install -g cli-jaw@latest\nnpm install -g cli-jaw@1\.2\.3\n```/);
    for (const text of [
        'Published from `v1.2.3` with npm dist-tag `latest`',
        'npm package gates passed in this workflow',
        'npm registry visibility is verified later in this workflow run',
        'npm provenance was requested through GitHub OIDC Trusted Publishing',
        'Electron shell validated with `npm --prefix electron run typecheck`',
        'Developer ID signed, Apple-notarized and stapled',
        'Team `U9ATA49N28`',
        'preview builds follow preview releases and stable builds follow stable releases',
        'Download and restart/install require explicit confirmation',
        'Existing unsigned installs must install this first signed DMG manually once',
        'Windows: artifacts remain unsigned', 'SmartScreen', 'More info', 'Run anyway',
        'Linux: AppImage downloads may need execute permission', 'CLI-only users can continue to install via',
    ]) {
        assert.ok(notes.includes(text), `missing release note: ${text}`);
    }
});
test('stable recovery marks Latest only when it equals the registry tag', () => {
    const { cwd, log, env } = githubReleaseFixture();
    for (const [latest, expected] of [['1.2.3', '--latest'], ['1.2.4', '--latest=false']] as const) {
        writeFileSync(log, '');
        const result = run('Create GitHub release', cwd, { ...env, EXISTS: 'true', LATEST: latest });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(readFileSync(log, 'utf8').includes(expected));
    }
});
test('preview release uses the prerelease flag and preview title', () => {
    const { cwd, log, env } = githubReleaseFixture();
    const result = run('Create GitHub release', cwd, { ...env, EXISTS: 'false', RELEASE_TAG: 'preview' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(log, 'utf8'), /--prerelease/);
    assert.match(readFileSync(log, 'utf8'), /--title v1\.2\.3 \(preview\)/);
});
test('recovery skips fresh publication and verifies provenance', () => {
    const byName = (name: string) => steps.find((step: {
        name?: string;
    }) => step.name === name);
    assert.match(byName('Assert dist-tag monotonic').if, /exists == 'false'/);
    assert.match(byName('Verify existing package provenance').if, /exists == 'true'/);
    assert.match(byName('Verify existing package provenance').run, /verify-npm-provenance/);
});
function monotonicFixture() {
    const cwd = tempRepo();
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    mkdirSync(join(cwd, 'scripts'));
    // The workflow invokes the actual version policy from an isolated directory.
    writeFileSync(join(cwd, 'scripts/release-version.mjs'), readFileSync('scripts/release-version.mjs'));
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
[ "\${REGISTRY_FAIL:-}" != 1 ] || exit 1
printf '%s' "$TAGS"
`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, RELEASE_VERSION: '1.2.4', RELEASE_TAG: 'latest', TAGS: '{"latest":"1.2.3"}' };
    return { cwd, env };
}

test('fresh publish rechecks channel monotonicity', () => {
    const { cwd, env } = monotonicFixture();
    assert.equal(run('Assert dist-tag monotonic', cwd, env).status, 0);
    assert.notEqual(run('Assert dist-tag monotonic', cwd, { ...env, TAGS: '{"latest":"1.2.4"}' }).status, 0);
    assert.notEqual(run('Assert dist-tag monotonic', cwd, { ...env, RELEASE_TAG: 'preview', RELEASE_VERSION: '1.2.3-preview.20261107000000' }).status, 0);
});

test('fresh publish fails when the registry is unavailable', () => {
    const { cwd, env } = monotonicFixture();
    assert.notEqual(run('Assert dist-tag monotonic', cwd, { ...env, REGISTRY_FAIL: '1' }).status, 0);
});

test('real publish re-reads the release tag immediately before npm publish', () => {
    // npm publish is irreversible; a tag moved after dispatch must stop it.
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'file'), 'a');
    git(cwd, ['add', 'file']);
    git(cwd, ['commit', '-m', 'release']);
    const releaseSha = git(cwd, ['rev-parse', 'HEAD']);
    writeFileSync(join(cwd, 'file'), 'b');
    git(cwd, ['add', 'file']);
    git(cwd, ['commit', '-m', 'other']);
    const otherSha = git(cwd, ['rev-parse', 'HEAD']);
    const origin = join(cwd, 'origin.git');
    git(cwd, ['init', '--bare', origin]);
    git(cwd, ['remote', 'add', 'origin', origin]);
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const log = join(cwd, 'npm-calls');
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$LOG"\n`, { mode: 0o755 });
    const env = {
        GITHUB_SHA: releaseSha, RELEASE_VERSION: '1.2.3', RELEASE_TAG: 'latest',
        DRY_RUN: 'false', EXISTS: 'false', LOG: log, PATH: `${bin}:${process.env.PATH}`,
    };

    git(cwd, ['push', 'origin', `${otherSha}:refs/tags/v1.2.3`]);
    writeFileSync(log, '');
    const moved = run('Publish or dry-run', cwd, env);
    assert.notEqual(moved.status, 0, 'a moved tag must stop the publish');
    assert.match(moved.stdout + moved.stderr, /no longer points at/);
    assert.equal(readFileSync(log, 'utf8'), '', 'npm publish must not run for a moved tag');

    git(cwd, ['push', 'origin', ':refs/tags/v1.2.3']);
    const deleted = run('Publish or dry-run', cwd, env);
    assert.notEqual(deleted.status, 0, 'a deleted tag must stop the publish');
    assert.equal(readFileSync(log, 'utf8'), '');

    git(cwd, ['push', 'origin', `${releaseSha}:refs/tags/v1.2.3`]);
    const ok = run('Publish or dry-run', cwd, env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(log, 'utf8'), /^publish --tag latest --access public --provenance$/m);
});

