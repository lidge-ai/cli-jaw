import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// electron-builder 26.15 dropped app-builder-bin, which notarize-mac-dmg.mjs
// used to rebuild the stapled DMG's blockmap. The replacement helper calls
// app-builder-lib directly. Every other notarize test injects the command, so
// this is the one place the real helper runs. It needs electron/node_modules;
// Desktop Release sets JAW_REQUIRE_ELECTRON_DEPS=1 so absence fails there.

const root = join(import.meta.dirname, '..', '..');
const helper = join(root, 'scripts', 'electron-blockmap.mjs');

function blockmapLibAvailable(): boolean {
    try {
        createRequire(join(root, 'electron', 'package.json')).resolve('app-builder-lib/out/targets/blockmap/blockmap.js');
        return true;
    } catch {
        return false;
    }
}

const required = process.env['JAW_REQUIRE_ELECTRON_DEPS'] === '1';
const available = blockmapLibAvailable();
const skip = !available && !required ? 'electron/node_modules not installed (npm ci --prefix electron)' : false;

test('electron-blockmap: app-builder-lib blockmap implementation resolves', { skip }, () => {
    assert.ok(available, 'app-builder-lib/out/targets/blockmap/blockmap.js must resolve from electron/');
});

test('electron-blockmap: rebuilds a blockmap and reports the file size and SHA-512', { skip }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-blockmap-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const input = join(dir, 'payload.dmg');
    // Large enough to span several blockmap chunks.
    writeFileSync(input, Buffer.alloc(256 * 1024, 0x5a));
    const output = `${input}.blockmap`;

    const result = spawnSync(process.execPath, [helper, 'blockmap', '--input', input, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const described = JSON.parse(result.stdout) as { size: number; sha512: string };
    assert.equal(described.size, statSync(input).size);
    assert.equal(described.sha512, createHash('sha512').update(readFileSync(input)).digest('base64'));
    assert.ok(existsSync(output) && statSync(output).size > 0, 'blockmap file must be written');
});

test('electron-blockmap: malformed arguments exit 2 with usage', () => {
    const result = spawnSync(process.execPath, [helper, 'blockmap', '--input', 'only-one'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: electron-blockmap\.mjs blockmap --input <file> --output <file\.blockmap>/);
});

