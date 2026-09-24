import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkIndex, checkRange, checkPush, isPrivatePath } from '../../scripts/check-private-boundary.mjs';

const project = resolve(import.meta.dirname, '../..');
function fixture(t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(join(tmpdir(), 'cli-jaw-boundary-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    return root;
}
function git(root: string, ...args: string[]) {
    return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' }).trim();
}
function put(root: string, path: string, content = 'fixture') {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
}

test('private paths at any depth and case are rejected without hiding public product paths', () => {
    for (const p of ['devlog', 'DEVLOG/plan.md', 'scripts/DevLog/note.md', 'devlog.md',
        'notes/devlog-backup/a', '.jwc/state.json', 'x/_plan/a.md', 'x/_FIN/a.md', 'cli-jaw-internal/a',
        // PR screenshot evidence lives on the orphan `pr-assets` branch only;
        // a same-named directory must never land on a code branch.
        'pr-assets/a.png', 'docs/pr-assets/shot.png', 'PR-ASSETS/x']) {
        assert.equal(isPrivatePath(p), true, p);
    }
    for (const p of ['docs/architecture.md', 'src/core/config.ts', 'tests/unit/private-boundary.test.ts', 'scripts/check-private-boundary.mjs',
        // Mentions of the branch name in ordinary file names stay public.
        'docs/pr-assets.md', 'docs/pr-assets-guide.md']) {
        assert.equal(isPrivatePath(p), false, p);
    }
});

test('an ignored private directory is reported once, by directory, and public untracked work is not', t => {
    const root = fixture(t);
    copyFileSync(join(project, '.gitignore'), join(root, '.gitignore'));
    put(root, 'README.md');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    // Ordinary untracked work must stay silent, or the check becomes noise and
    // gets ignored for the case it exists to catch.
    put(root, 'src/scratch.ts');
    put(root, 'notes.md');
    assert.doesNotThrow(() => checkIndex(root));
    // This is the shape that survived in a real checkout: gitignore hid a whole
    // private plan tree from the index scan while it sat in the working tree.
    put(root, 'devlog/_plan/260908_slug/000_plan.md');
    put(root, 'devlog/_plan/260908_slug/010_phase1.md');
    try {
        checkIndex(root);
        assert.fail('an ignored private tree must fail the boundary check');
    } catch (error) {
        const message = (error as Error).message;
        assert.match(message, /working tree: private paths/);
        // --directory collapses the tree to one actionable line rather than
        // one line per file.
        const listed = message.split('\n').filter(line => line.includes('devlog'));
        assert.deepEqual(listed, ['devlog']);
    }
});

test('Git ignore blocks accidental staging; forced additions and private gitlinks fail the index guard', t => {
    const root = fixture(t);
    copyFileSync(join(project, '.gitignore'), join(root, '.gitignore'));
    const names = ['devlog/note.md', 'x/DEVLOG/plan.md', 'devlog.md', '.jwc/state.json', 'x/_plan/a.md', 'cli-jaw-internal/file'];
    for (const name of names) {
        put(root, name);
        assert.equal(git(root, 'check-ignore', '--', name), name);
    }
    git(root, 'add', '.');
    // An ignored private directory is still a private directory: the rule is
    // about where records live, not about whether Git tracks them.
    assert.throws(() => checkIndex(root), /working tree: private paths/);
    for (const name of names) rmSync(join(root, name.split('/')[0]), { recursive: true, force: true });
    assert.doesNotThrow(() => checkIndex(root));
    put(root, 'devlog/note.md');
    git(root, 'add', '-f', 'devlog/note.md');
    assert.throws(() => checkIndex(root), /private paths/);
    git(root, 'rm', '--cached', 'devlog/note.md');
    git(root, 'commit', '-qm', 'base');
    const sha = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-index', '--add', '--cacheinfo', '160000,' + sha + ',devlog');
    assert.throws(() => checkIndex(root), /devlog/);
});

test('outgoing-history guard catches private files added then deleted before HEAD', t => {
    const root = fixture(t);
    put(root, 'README.md');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'public base');
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'devlog/secret.md');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'private intermediate');
    git(root, 'rm', 'devlog/secret.md'); git(root, 'commit', '-qm', 'deleted at tip');
    const head = git(root, 'rev-parse', 'HEAD');
    assert.doesNotThrow(() => checkIndex(root));
    assert.throws(() => checkRange(root, base, head), /devlog\/secret/);
    assert.throws(() => checkPush(root, 'refs/heads/dev ' + head + ' refs/heads/dev ' + base), /private paths/);
});

test('pre-push accepts a public update, rejects malformed input, and allows deletion', t => {
    const root = fixture(t);
    put(root, 'README.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'docs/architecture.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'docs');
    const head = git(root, 'rev-parse', 'HEAD');
    assert.doesNotThrow(() => checkPush(root, 'refs/heads/dev ' + head + ' refs/heads/dev ' + base));
    assert.doesNotThrow(() => checkPush(root, '(delete) ' + '0'.repeat(40) + ' refs/heads/dev ' + head));
    assert.throws(() => checkPush(root, 'malformed'), /Invalid pre-push/);
    const result = spawnSync(process.execPath, [join(project, 'scripts/check-private-boundary.mjs'), '--pre-push'], {
        cwd: root, input: 'refs/heads/dev ' + head + ' refs/heads/dev ' + base, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
});

test('a private remote-tracking ref cannot hide outgoing history from a new public ref', t => {
    const root = fixture(t);
    const remote = join(fixture(t), 'destination.git');
    git(root, 'init', '--bare', '-q', remote);
    put(root, 'README.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'public base');
    git(root, 'push', '-q', remote, 'HEAD:refs/heads/main');
    put(root, 'devlog/private.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'private');
    const intermediate = git(root, 'rev-parse', 'HEAD');
    git(root, 'rm', 'devlog/private.md'); git(root, 'commit', '-qm', 'clean tip');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/private/archive', intermediate);
    const input = 'refs/heads/new ' + head + ' refs/heads/new ' + '0'.repeat(40);
    assert.throws(() => checkPush(root, input), /destination is required/);
    assert.throws(() => checkPush(root, input, remote), /devlog\/private/);
});

test('history the destination already advertises is not re-scanned when another branch fast-forwards onto it', t => {
    // Mirrors the release train: dev detached private records and was pushed; preview and
    // main are then fast-forwarded to commits dev already published at the same remote.
    const root = fixture(t);
    const remote = join(fixture(t), 'destination.git');
    git(root, 'init', '--bare', '-q', remote);
    put(root, 'README.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'public base');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', '-q', remote, 'HEAD:refs/heads/main');
    put(root, 'devlog/old.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'legacy private record');
    git(root, 'rm', '-q', 'devlog/old.md'); git(root, 'commit', '-qm', 'detach private records');
    const dev = git(root, 'rev-parse', 'HEAD');
    // Already published on dev at this destination; a preview fast-forward re-pushes the same commits.
    git(root, 'push', '-q', remote, 'HEAD:refs/heads/dev');
    assert.doesNotThrow(() => checkPush(root, 'refs/heads/preview ' + dev + ' refs/heads/preview ' + base, remote));
    // Without the destination, the range still rejects the intermediate private commit.
    assert.throws(() => checkRange(root, base, dev), /devlog\/old/);
    // New private history above what the destination advertises is still rejected.
    put(root, 'devlog/new.md'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'new private');
    git(root, 'rm', '-q', 'devlog/new.md'); git(root, 'commit', '-qm', 'clean tip');
    const head = git(root, 'rev-parse', 'HEAD');
    assert.throws(() => checkPush(root, 'refs/heads/dev ' + head + ' refs/heads/dev ' + dev, remote), /devlog\/new/);
});

test('prepublish lifecycle rejects private input before build and preserves build/check ordering', t => {
    const root = fixture(t);
    const lifecycle = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).scripts.prepublishOnly;
    copyFileSync(join(project, 'scripts/check-private-boundary.mjs'), join(root, 'boundary.mjs'));
    put(root, 'mark.cjs', "require('fs').appendFileSync('steps.txt', process.argv[2] + '\\n');");
    put(root, 'package.json', JSON.stringify({
        name: 'lifecycle-fixture', version: '1.0.0',
        scripts: {
            prepublishOnly: lifecycle,
            'check:private-boundary': 'node boundary.mjs',
            build: 'node mark.cjs build',
            'build:frontend': 'node mark.cjs frontend',
            'check:frontend-build-output': 'node mark.cjs verify',
        },
    }));
    git(root, 'add', '.');
    const invoke = () => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['run', 'prepublishOnly'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    const good = invoke();
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(join(root, 'steps.txt'), 'utf8'), 'build\nfrontend\nverify\n');
    rmSync(join(root, 'steps.txt'));
    put(root, 'devlog/private.md');
    git(root, 'add', '-f', 'devlog/private.md');
    const bad = invoke();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /private paths must live outside/);
    assert.equal(existsSync(join(root, 'steps.txt')), false, 'no build step runs after private input is rejected');
});

test('npm pack excludes nested private records even with a scripts directory allowlist', t => {
    const root = fixture(t);
    copyFileSync(join(project, '.npmignore'), join(root, '.npmignore'));
    put(root, 'package.json', JSON.stringify({ name: 'boundary-fixture', version: '1.0.0', files: ['scripts/', ...JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).files.filter((p: string) => p.startsWith('!'))] }));
    put(root, 'scripts/public.mjs');
    put(root, 'scripts/devlog/secret.md');
    put(root, 'scripts/_plan/private.md');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(result.status, 0, result.stderr);
    const files = JSON.parse(result.stdout)[0].files.map((f: { path: string }) => f.path);
    assert.ok(files.includes('scripts/public.mjs'));
    assert.deepEqual(files.filter(isPrivatePath), []);
});
