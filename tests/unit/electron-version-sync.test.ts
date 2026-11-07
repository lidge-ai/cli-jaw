// The Electron shell's version has to equal the root package.json's, because
// electron-builder names desktop artifacts from it and desktop-release.yml
// builds from a tag checkout. It drifted for the entire life of the shell
// (0.1.0 against a root that reached 2.2.7), so every release shipped
// identically-named installers.
//
// These tests RUN the script. A source-text assertion would have passed
// throughout the drift, which is exactly how the drift survived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const script = join(projectRoot, 'scripts', 'sync-electron-version.cjs');

const readVersion = (pkgPath: string) =>
    (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

/**
 * A throwaway repo shaped like this one: a root manifest and an electron/
 * manifest plus its lockfile. Real files are copied so the lockfile keeps its
 * true shape; only the versions are posed.
 */
function makeFixture(rootVersion: string, electronVersion: string) {
    const dir = mkdtempSync(join(tmpdir(), 'electron-version-'));
    const electronDir = join(dir, 'electron');
    const scriptsDir = join(dir, 'scripts');

    cpSync(join(projectRoot, 'electron'), electronDir, {
        recursive: true,
        filter: (src) => !src.includes('node_modules') && !src.includes(`${'dist'}/`)
            && !src.endsWith('/dist') && !src.includes('/out') && !src.includes('/sidecar'),
    });
    cpSync(join(projectRoot, 'scripts', 'sync-electron-version.cjs'),
        join(scriptsDir, 'sync-electron-version.cjs'), { recursive: false, force: true });

    const setVersion = (pkgPath: string, version: string) => {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        pkg["version"] = version;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    };

    writeFileSync(join(dir, 'package.json'),
        `${JSON.stringify({ name: 'cli-jaw', version: rootVersion }, null, 2)}\n`);
    setVersion(join(electronDir, 'package.json'), electronVersion);

    return {
        dir,
        script: join(scriptsDir, 'sync-electron-version.cjs'),
        electronPkg: join(electronDir, 'package.json'),
        electronLock: join(electronDir, 'package-lock.json'),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

const run = (target: string, args: string[] = []) =>
    spawnSync(process.execPath, [target, ...args], { encoding: 'utf8', timeout: 60_000 });

test('the shipped manifests are in sync', () => {
    const result = run(script, ['--check']);
    assert.equal(result.status, 0,
        `versions diverged: ${(result.stdout ?? '') + (result.stderr ?? '')}`);
    assert.equal(
        readVersion(join(projectRoot, 'electron', 'package.json')),
        readVersion(join(projectRoot, 'package.json')),
    );
});

test('--check fails on a divergence and names BOTH versions', () => {
    // "versions differ" leaves the reader guessing which side to fix, so the
    // message is part of the contract, not decoration.
    const fixture = makeFixture('9.9.9', '0.1.0');
    try {
        const result = run(fixture.script, ['--check']);
        assert.notEqual(result.status, 0, 'a divergence must fail the check');
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        assert.match(output, /0\.1\.0/, 'the electron version is missing from the message');
        assert.match(output, /9\.9\.9/, 'the root version is missing from the message');
        assert.match(output, /sync:electron-version/, 'the message must name the fix');
    } finally {
        fixture.cleanup();
    }
});

test('--check leaves the files alone', () => {
    const fixture = makeFixture('9.9.9', '0.1.0');
    try {
        run(fixture.script, ['--check']);
        assert.equal(readVersion(fixture.electronPkg), '0.1.0',
            'the check mode must not write');
    } finally {
        fixture.cleanup();
    }
});

test('the write mode moves the manifest AND the lockfile', () => {
    // The lockfile carries the version in two root entries. Writing only the
    // manifest leaves a divergence that surfaces later as unexplained churn in
    // somebody else's dependency diff.
    const fixture = makeFixture('9.9.9', '0.1.0');
    try {
        const result = run(fixture.script);
        assert.equal(result.status, 0,
            `sync failed: ${(result.stdout ?? '') + (result.stderr ?? '')}`);
        assert.equal(readVersion(fixture.electronPkg), '9.9.9');

        const lock = JSON.parse(readFileSync(fixture.electronLock, 'utf8')) as
            { version: string; packages: Record<string, { version?: string }> };
        assert.equal(lock.version, '9.9.9', 'the lockfile root version did not move');
        assert.equal(lock.packages[""]?.version, '9.9.9',
            'the lockfile package entry did not move');
    } finally {
        fixture.cleanup();
    }
});

test('the write mode preserves everything except the version', () => {
    const fixture = makeFixture('9.9.9', '0.1.0');
    try {
        const before = JSON.parse(readFileSync(fixture.electronPkg, 'utf8')) as
            Record<string, unknown>;
        run(fixture.script);
        const after = JSON.parse(readFileSync(fixture.electronPkg, 'utf8')) as
            Record<string, unknown>;

        assert.deepEqual(Object.keys(after), Object.keys(before), 'key order changed');
        for (const key of Object.keys(before)) {
            if (key === 'version') continue;
            assert.deepEqual(after[key], before[key], `${key} was altered`);
        }
    } finally {
        fixture.cleanup();
    }
});

test('both release paths sync before they gate and stage the result', () => {
    // release.sh bumps the root version and THEN runs gate:all. Adding
    // the gate without the sync would have failed every preview release on its
    // next run -- the audit caught this in a path the original plan never read.
    for (const path of ['scripts/release.sh']) {
        const source = readFileSync(join(projectRoot, path), 'utf8');

        const syncAt = source.indexOf('node scripts/sync-electron-version.cjs');
        const gateAt = source.indexOf('npm run gate:all');
        const stageAt = source.indexOf('git add package.json package-lock.json');

        assert.ok(syncAt > 0, `${path} never syncs the Electron version`);
        assert.ok(gateAt > syncAt, `${path} gates before it syncs`);
        assert.ok(stageAt > syncAt, `${path} stages before it syncs`);
        assert.match(
            source.slice(stageAt, stageAt + 120),
            /git add package\.json package-lock\.json electron\/package\.json electron\/package-lock\.json/,
            `${path} does not stage the Electron manifests, so the sync would not reach the tag`,
        );
    }
});

test('the gate is registered and addressable', () => {
    const gates = readFileSync(join(projectRoot, 'scripts', 'release-gates.mjs'), 'utf8');
    assert.match(gates, /'electron-version':\s*\{/, 'the gate is not in the GATES object');

    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as
        { scripts: Record<string, string> };
    assert.equal(pkg.scripts["gate:electron-version"],
        'node scripts/release-gates.mjs electron-version');
    assert.equal(pkg.scripts["sync:electron-version"],
        'node scripts/sync-electron-version.cjs');
});
