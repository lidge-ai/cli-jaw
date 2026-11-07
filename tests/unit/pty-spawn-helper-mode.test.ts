import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const script = path.join(repoRoot, 'scripts/ensure-pty-spawn-helper.cjs');
const require = createRequire(import.meta.url);

type Restore = (root: string, platform?: string) => {
    checked: string[];
    changed: { path: string; from: number; to: number }[];
};

function helper(root: string, relative: string, mode: number): string {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    fs.chmodSync(file, mode);
    return file;
}

function mode(file: string): number {
    return fs.statSync(file).mode & 0o777;
}

test('restores readable spawn helpers without following symlinks, idempotently', { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-helper-'));
    try {
        const darwin = helper(root, 'prebuilds/darwin-arm64/spawn-helper', 0o644);
        const linux = helper(root, 'prebuilds/linux-x64/spawn-helper', 0o644);
        const release = helper(root, 'build/Release/spawn-helper', 0o600);
        const windows = helper(root, 'prebuilds/win32-x64/spawn-helper', 0o644);
        const other = helper(root, 'prebuilds/linux-x64/other', 0o644);
        const target = helper(root, 'link-target', 0o644);
        fs.mkdirSync(path.join(root, 'build/Debug'), { recursive: true });
        fs.symlinkSync(target, path.join(root, 'build/Debug/spawn-helper'));
        const restore: Restore = require(script).restoreSpawnHelperModes;
        const result = restore(root);
        assert.deepEqual(new Set(result.checked), new Set([darwin, linux, release]));
        assert.deepEqual(new Set(result.changed.map(({ path: file, from, to }) => `${file}:${from.toString(8)}:${to.toString(8)}`)),
            new Set([`${darwin}:644:755`, `${linux}:644:755`, `${release}:600:700`]));
        assert.equal(mode(darwin), 0o755);
        assert.equal(mode(linux), 0o755);
        assert.equal(mode(release), 0o700);
        assert.equal(mode(windows), 0o644);
        assert.equal(mode(other), 0o644);
        assert.equal(mode(target), 0o644);
        assert.deepEqual(restore(root).changed, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('missing roots and win32 are no-ops', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-helper-'));
    try {
        const file = helper(root, 'prebuilds/linux-x64/spawn-helper', 0o644);
        const restore: Restore = require(script).restoreSpawnHelperModes;
        assert.deepEqual(restore(path.join(root, 'missing')), { checked: [], changed: [] });
        assert.deepEqual(restore(root, 'win32'), { checked: [], changed: [] });
        if (process.platform !== 'win32') assert.equal(mode(file), 0o644);
        const cli = spawnSync(process.execPath, [script, path.join(root, 'missing')], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.match(cli.stdout, /not found|missing/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('electron postinstall restores the installed helper', { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-helper-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
        fs.copyFileSync(script, path.join(root, 'scripts/ensure-pty-spawn-helper.cjs'));
        const electron = path.join(root, 'electron');
        const file = helper(electron, `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`, 0o644);
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'electron/package.json'), 'utf8'));
        const result = spawnSync('bash', ['-c', pkg.scripts.postinstall], { cwd: electron, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(mode(file), 0o755);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
