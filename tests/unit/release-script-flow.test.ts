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
  # Counters come from the call log, which already holds this call.
  publish_listings="$(grep -c '^run list --workflow publish.yml' "$TEST_LOG" || true)"
  test_successes="$(grep -c '^run list --workflow test.yml .*--status success' "$TEST_LOG" || true)"
  if [ "$workflow" = publish.yml ]; then
    id="$(cat "$TEST_REQUEST")"
    if [ "$publish_listings" -lt "\${PUBLISH_APPEARS_AFTER:-1}" ]; then
      data='[{"databaseId":1,"displayTitle":"other"}]'
    else
      data="$(jq -nc --arg id "$id" '[{databaseId:1,displayTitle:"other"},{databaseId:42,displayTitle:$id}]')"
    fi
  elif [ "$workflow" = test.yml ] && [ "$test_successes" -le "\${TESTS_PENDING_CALLS:-0}" ]; then
    if [ "$status" = success ]; then data='[]'; else data='[{"status":"in_progress","conclusion":""}]'; fi
  elif [ "$workflow" = test.yml ] && [ "\${TESTS_ABSENT:-}" = 1 ]; then
    data='[]'
  elif [ "\${TESTS_FAIL:-}" = 1 ] && [ "$workflow" = test.yml ]; then
    if [ "$status" = success ]; then data='[]'; else data='[{"status":"completed","conclusion":"failure"}]'; fi
  else data='[{"url":"https://example.invalid/run","status":"completed","conclusion":"success"}]'; fi
  printf '%s' "$data" | jq -r "$query"
  exit 0
fi
exit 1
`, { mode: 0o755 });
    // release.sh waits with the external sleep command. The stub records each
    // requested interval and returns at once, so no scenario waits on the wall
    // clock and the interval itself is observable.
    const sleepLog = join(dir, 'sleeps');
    writeFileSync(sleepLog, '');
    writeFileSync(join(bin, 'sleep'), `#!/bin/bash
printf '%s\\n' "$1" >> "$TEST_SLEEP_LOG"
# Opt-in real wait, only for the deadline-expiry scenario.
[ "\${TEST_REAL_SLEEP:-}" != 1 ] || /bin/sleep "$1"
`, { mode: 0o755 });
    return {
        cwd, origin, log, sleepLog,
        env: {
            ...gitEnv(), PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_REQUEST: join(dir, 'request'),
            TEST_HOOK_DONE: join(dir, 'hook-done'), TEST_SLEEP_LOG: sleepLog, STAMP: '20261107000000',
            // Pin every wait setting: the gate runs inside a real release whose
            // environment may carry its own values, and they must not leak in.
            JAW_RELEASE_POLL_SECONDS: '0',
            JAW_RELEASE_CI_DISCOVERY_SECONDS: '1200',
            JAW_RELEASE_PUBLISH_DISCOVERY_SECONDS: '120',
        } as NodeJS.ProcessEnv,
    };
}
function release(f: ReturnType<typeof fixture>, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = { ...f.env, ...extra };
    for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete env[key];
    }
    // Generous because a loaded release host runs dozens of git/node children
    // per scenario; no scenario waits on real time (sleep is stubbed).
    return spawnSync('bash', ['scripts/release.sh', ...args], {
        cwd: f.cwd, env, encoding: 'utf8', timeout: 120_000,
    });
}
function sleeps(f: ReturnType<typeof fixture>) {
    return readFileSync(f.sleepLog, 'utf8').split('\n').filter(Boolean);
}
function publishListings(f: ReturnType<typeof fixture>) {
    return readFileSync(f.log, 'utf8').split('\n').filter(line => line.startsWith('run list --workflow publish.yml')).length;
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

test('CI polling uses the injected interval, defaulting to ten seconds', () => {
    const injected = fixture();
    const fast = release(injected, [], { TESTS_PENDING_CALLS: '2', JAW_RELEASE_POLL_SECONDS: '7' });
    assert.equal(fast.status, 0, fast.stderr);
    assert.deepEqual(sleeps(injected), ['7', '7'], 'two pending CI lookups must wait the injected interval');

    const defaulted = fixture();
    const slow = release(defaulted, [], { TESTS_PENDING_CALLS: '2', JAW_RELEASE_POLL_SECONDS: undefined });
    assert.equal(slow.status, 0, slow.stderr);
    assert.deepEqual(sleeps(defaulted), ['10', '10']);
});
test('publish discovery queries once and stops at the injected deadline', () => {
    // The publish run appears on the second listing. A zero deadline must stop
    // after the first, without sleeping; the old loop slept and found it.
    const f = fixture();
    const result = release(f, [], { PUBLISH_APPEARS_AFTER: '2', JAW_RELEASE_PUBLISH_DISCOVERY_SECONDS: '0' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /publish run not found/);
    assert.match(result.stderr, /gh workflow run publish.yml --ref v1\.2\.4/);
    assert.equal(publishListings(f), 1);
    assert.deepEqual(sleeps(f), []);
});
test('publish discovery polls at most every five seconds until the run appears', () => {
    const f = fixture();
    const result = release(f, [], { PUBLISH_APPEARS_AFTER: '2', JAW_RELEASE_POLL_SECONDS: '10' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishListings(f), 2);
    assert.deepEqual(sleeps(f), ['5']);
});
test('invalid wait settings stop before any mutation', () => {
    for (const name of ['JAW_RELEASE_POLL_SECONDS', 'JAW_RELEASE_CI_DISCOVERY_SECONDS', 'JAW_RELEASE_PUBLISH_DISCOVERY_SECONDS']) {
        // 08 is invalid octal in bash arithmetic; the oversized value would wrap.
        for (const value of ['abc', '08', '1e3', '-1', '9999999999999999999']) {
            const f = fixture();
            const head = git(f.cwd, ['rev-parse', 'HEAD']);
            const result = release(f, [], { [name]: value });
            assert.equal(result.status, 2, `${name}=${value}: ${result.stderr}`);
            assert.match(result.stderr, new RegExp(name));
            assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), head);
            assert.ok(!existsSync(f.log), `${name}=${value} must stop before calling gh`);
        }
    }
});

test('a CI run that never appears fails once the injected discovery deadline passes', () => {
    // Real one-second polls, so bash's SECONDS actually advances past the deadline.
    const f = fixture();
    const started = Date.now();
    const result = release(f, [], {
        TESTS_ABSENT: '1', TEST_REAL_SLEEP: '1', JAW_RELEASE_POLL_SECONDS: '1', JAW_RELEASE_CI_DISCOVERY_SECONDS: '2',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Tests failed or was not found/);
    assert.match(result.stderr, /--resume/);
    // Under heavy load the deadline may pass before the first sleep, so only
    // the interval of any recorded sleep is asserted, never the count.
    assert.ok(sleeps(f).every(value => value === '1'));
    assert.ok(Date.now() - started < 60_000, 'expiry must follow the injected deadline, not the 1200s default');
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /workflow run publish.yml/);
});
test('wait settings in the caller environment do not leak into the harness', () => {
    // gate:all runs inside release.sh; a release started with zero deadlines
    // must not change what these scenarios observe.
    const saved = { ...process.env };
    process.env.JAW_RELEASE_PUBLISH_DISCOVERY_SECONDS = '0';
    process.env.JAW_RELEASE_CI_DISCOVERY_SECONDS = '0';
    try {
        const f = fixture();
        const result = release(f, [], { PUBLISH_APPEARS_AFTER: '2' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(publishListings(f), 2);
    } finally {
        for (const key of ['JAW_RELEASE_PUBLISH_DISCOVERY_SECONDS', 'JAW_RELEASE_CI_DISCOVERY_SECONDS']) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
    }
});
