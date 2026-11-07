import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tempRepo, git, gitEnv } from './release-git-helper.js';
const root = process.cwd();
function localName(cwd: string) {
    // Read the real config using --file from a temporary repo, never from the checkout.
    const dotGit = join(root, '.git');
    const pointer = statSync(dotGit).isDirectory() ? dotGit : resolve(root, readFileSync(dotGit, 'utf8').trim().replace(/^gitdir: /, ''));
    const common = existsSync(join(pointer, 'commondir')) ? resolve(pointer, readFileSync(join(pointer, 'commondir'), 'utf8').trim()) : pointer;
    const r = spawnSync('git', ['config', '--file', join(common, 'config'), '--get', 'user.name'], { cwd, env: gitEnv(), encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'release-flow-'));
    const origin = join(dir, 'origin.git');
    const seed = tempRepo();
    git(seed, ['init', '--bare', origin]);
    mkdirSync(join(seed, 'scripts'));
    mkdirSync(join(seed, 'electron'));
    for (const file of ['release.sh', 'release-version.mjs']) {
        copyFileSync(join(root, 'scripts', file), join(seed, 'scripts', file));
    }
    writeFileSync(join(seed, 'scripts/sync-electron-version.cjs'), `const fs = require('fs');
const version = require('../package.json').version;
for (const path of ['electron/package.json', 'electron/package-lock.json']) {
    const data = JSON.parse(fs.readFileSync(path));
    data.version = version;
    fs.writeFileSync(path, JSON.stringify(data));
}
`);
    writeFileSync(join(seed, 'scripts/require-release-evidence.mjs'), '');
    for (const path of ['package.json', 'package-lock.json', 'electron/package.json', 'electron/package-lock.json']) {
        writeFileSync(join(seed, path), JSON.stringify({ name: 'cli-jaw', version: '1.2.3' }));
    }
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'seed']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', 'origin', 'HEAD:refs/heads/dev']);
    const cwd = join(dir, 'work');
    git(seed, ['clone', '--branch', 'dev', origin, cwd]);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'log');
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
set -e
if [ "$1" = view ]; then
  [ "\${FAIL_REGISTRY:-}" != 1 ] || { echo 'network error' >&2; exit 1; }
  case "$2" in cli-jaw) echo '{"latest":"1.2.3"}';; *) if [ "$2" = "cli-jaw@\${PUBLISHED_VERSION:-missing}" ]; then echo "$PUBLISHED_VERSION"; else echo 'npm ERR! E404' >&2; exit 1; fi;; esac
elif [ "$1" = pack ] && [ -n "\${TEST_PACK_HOOK:-}" ]; then
  bash "$TEST_PACK_HOOK"
elif [ "$1" = version ]; then
  node - "$2" <<'NODE'
const fs = require('fs');
for (const path of ['package.json', 'package-lock.json']) {
    const data = JSON.parse(fs.readFileSync(path));
    data.version = process.argv[2];
    fs.writeFileSync(path, JSON.stringify(data));
}
NODE
fi
`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1 $2" = 'auth status' ]; then exit 0; fi
if [ "$1 $2" = 'workflow run' ]; then
  for arg in "$@"; do case "$arg" in request-id=*) printf '%s' "\${arg#request-id=}" > "$TEST_REQUEST";; esac; done
  exit 0
fi
if [ "$1 $2" = 'run view' ]; then printf '{"status":"completed","conclusion":"%s"}' "\${PUBLISH_RESULT:-success}"; exit 0; fi
if [ "$1 $2" = 'run list' ]; then
  if [ -n "\${TEST_GH_HOOK:-}" ] && [ ! -f "$TEST_HOOK_DONE" ]; then touch "$TEST_HOOK_DONE"; bash "$TEST_GH_HOOK"; fi
  query=''; workflow=''; status=''
  while [ "$#" -gt 0 ]; do case "$1" in --workflow) workflow="$2"; shift;; --jq) query="$2"; shift;; --status) status="$2"; shift;; esac; shift; done
  if [ "$workflow" = publish.yml ]; then
    id="$(cat "$TEST_REQUEST")"; data="$(jq -nc --arg id "$id" '[{databaseId:1,displayTitle:"other"},{databaseId:42,displayTitle:$id}]')"
  elif [ "\${TESTS_FAIL:-}" = 1 ] && [ "$workflow" = test.yml ]; then
    if [ "$status" = success ]; then data='[]'; else data='[{"status":"completed","conclusion":"failure"}]'; fi
  else data='[{"url":"https://example.invalid/run","status":"completed","conclusion":"success"}]'; fi
  printf '%s' "$data" | jq -r "$query"
  exit 0
fi
exit 1
`, { mode: 0o755 });
    return { cwd, origin, log, env: { ...gitEnv(), PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_REQUEST: join(dir, 'request'), TEST_HOOK_DONE: join(dir, 'hook-done'), STAMP: '20261107000000' } };
}
function release(f: ReturnType<typeof fixture>, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', ['scripts/release.sh', ...args], {
        cwd: f.cwd, env: { ...f.env, ...extra }, encoding: 'utf8', timeout: 20000,
    });
}
const identityRepo = tempRepo();
const originalUserName = localName(identityRepo);
after(() => {
    assert.equal(localName(identityRepo), originalUserName, 'real checkout local user.name must not change');
});
function assertHappyRelease(preview: boolean) {
    const f = fixture();
    const result = release(f, preview ? ['--preview'] : []);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
    const version = preview ? '1.2.4-preview.20261107000000' : '1.2.4';
    const sha = git(f.cwd, ['rev-parse', 'HEAD']);
    assert.equal(git(f.cwd, ['rev-parse', `v${version}^{commit}`]), sha);
    assert.equal(git(f.cwd, ['ls-remote', 'origin', 'refs/heads/dev']).split(/\s+/)[0], sha);
    const log = readFileSync(f.log, 'utf8');
    assert.match(log, new RegExp(`workflow run publish.yml --ref v${version}`));
    assert.match(log, /run view 42/);
    assert.match(log, /create-github-release=true/);
    assert.deepEqual(git(f.cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').sort(), [
        'electron/package-lock.json', 'electron/package.json', 'package-lock.json', 'package.json',
    ]);
}
test('stable release dispatches its certified tag', () => {
    assertHappyRelease(false);
});
test('preview release dispatches its certified tag', () => {
    assertHappyRelease(true);
});
test('CI failure retains a release commit that can be resumed', () => {
    const f = fixture();
    const result = release(f, [], { TESTS_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--resume/);
    assert.equal(release(f, ['--resume', git(f.cwd, ['rev-parse', 'HEAD'])]).status, 0);
});
test('registry errors stop before committing', () => {
    const f = fixture();
    const old = git(f.cwd, ['rev-parse', 'HEAD']);
    assert.notEqual(release(f, [], { FAIL_REGISTRY: '1' }).status, 0);
    assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), old);
});
test('cancelled publish reports recovery', () => {
    const f = fixture();
    const result = release(f, [], { PUBLISH_RESULT: 'cancelled' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cancelled/);
    assert.match(result.stderr, /gh workflow run publish.yml/);
});
test('already published version stops before committing', () => {
    const f = fixture();
    const old = git(f.cwd, ['rev-parse', 'HEAD']);
    assert.notEqual(release(f, [], { PUBLISHED_VERSION: '1.2.4' }).status, 0);
    assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), old);
});
test('remote tag at another commit prevents dispatch', () => {
    const f = fixture();
    git(f.cwd, ['tag', 'v1.2.4']);
    git(f.cwd, ['push', 'origin', 'refs/tags/v1.2.4']);
    const result = release(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag points elsewhere/);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /workflow run publish.yml/);
});
function concurrentAdvance(f: ReturnType<typeof fixture>) {
    const other = join(f.cwd, '..', 'other');
    git(f.cwd, ['clone', '--branch', 'dev', f.origin, other]);
    const hook = join(f.cwd, '..', 'advance.sh');
    writeFileSync(hook, `#!/bin/bash\nset -e\ncd "$OTHER_REPO"\necho x > concurrent\ngit add concurrent\ngit commit -m concurrent\ngit push origin HEAD:refs/heads/dev\n`, { mode: 0o755 });
    return { other, hook };
}
test('dev moving during CI still dispatches the release commit tag', () => {
    const f = fixture();
    const { other, hook } = concurrentAdvance(f);
    const result = release(f, [], { TEST_GH_HOOK: hook, OTHER_REPO: other });
    assert.equal(result.status, 0, result.stderr);
    const sha = git(f.cwd, ['rev-parse', 'HEAD']);
    assert.equal(git(f.cwd, ['rev-parse', 'v1.2.4']), sha);
    assert.notEqual(git(other, ['rev-parse', 'HEAD']), sha);
});
test('origin moving before push preserves the local commit and stops', () => {
    const f = fixture();
    const { other, hook } = concurrentAdvance(f);
    const result = release(f, [], { TEST_PACK_HOOK: hook, OTHER_REPO: other });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /origin\/dev moved/);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /workflow run publish.yml/);
});
test('a checkout behind origin is refused', () => {
    const f = fixture();
    const other = join(f.cwd, '..', 'other');
    git(f.cwd, ['clone', '--branch', 'dev', f.origin, other]);
    writeFileSync(join(other, 'new'), 'x');
    git(other, ['add', 'new']);
    git(other, ['commit', '-m', 'advance']);
    git(other, ['push', 'origin', 'HEAD:refs/heads/dev']);
    assert.notEqual(release(f).status, 0);
});
test('a dirty checkout is refused', () => {
    const f = fixture();
    writeFileSync(join(f.cwd, 'dirty'), 'x');
    assert.notEqual(release(f).status, 0);
});
test('a branch other than dev is refused', () => {
    const f = fixture();
    git(f.cwd, ['checkout', '-b', 'feature']);
    assert.notEqual(release(f).status, 0);
});
