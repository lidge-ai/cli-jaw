import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '../..');

function read(file: string): string {
    return fs.readFileSync(join(root, file), 'utf8');
}

test('install path scripts preserve executable cli-jaw entrypoint', () => {
    const atomicBuild = read('scripts/atomic-build.sh');
    assert.ok(atomicBuild.includes('chmod +x "$STAGING/bin/cli-jaw.js"'), 'atomic build must chmod staged CLI entry before dist swap');
    assert.ok(atomicBuild.indexOf('chmod +x "$STAGING/bin/cli-jaw.js"') < atomicBuild.indexOf('mv "$STAGING" dist'), 'chmod must run before staged dist becomes active');
    assert.ok(atomicBuild.includes('MINGW*|MSYS*|CYGWIN*'), 'atomic build should skip POSIX chmod on Git Bash style Windows shells');

    const linker = read('scripts/link-current-nvm-bin.cjs');
    assert.ok(linker.includes('function ensureRepoBinExecutable()'), 'postbuild linker should have a standalone executable-bit repair helper');
    assert.ok(linker.indexOf('ensureRepoBinExecutable();') < linker.indexOf('if (!isNvmNode())'), 'postbuild must repair executable bit before non-nvm link skip');
    assert.ok(linker.includes('chmod ok; skip linking because node is not from nvm'), 'non-nvm skip message should confirm chmod still ran');
    assert.ok(linker.includes('is a real install, not a symlink'), 'nvm linker must skip a real global install instead of failing the build');
});

test('cli bin link checker enforces package bin metadata and POSIX execute bit', () => {
    const checker = read('scripts/check-cli-bin-links.cjs');
    assert.ok(checker.includes("'cli-jaw': 'dist/bin/cli-jaw.js'"), 'checker should enforce cli-jaw bin target');
    assert.ok(checker.includes("jaw: 'dist/bin/cli-jaw.js'"), 'checker should enforce jaw bin target');
    assert.ok(checker.includes('#!/usr/bin/env node'), 'checker should enforce node shebang');
    assert.ok(checker.includes('CLI entry is not executable'), 'checker should fail with clear executable-bit error');
    assert.ok(checker.includes('npmPrefix()'), 'checker should inspect current npm global prefix when available');

    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string>; bin?: Record<string, string> };
    assert.equal(pkg.scripts?.['check:cli-bin-links'], 'node scripts/check-cli-bin-links.cjs');
    assert.equal(pkg.bin?.['cli-jaw'], 'dist/bin/cli-jaw.js');
    assert.equal(pkg.bin?.jaw, 'dist/bin/cli-jaw.js');
});
