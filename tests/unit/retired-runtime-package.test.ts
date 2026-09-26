import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDefaultInstall, checkPackedFiles } from '../../scripts/retired-runtime-package-smoke.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(root, 'scripts/check-electron-sidecar-no-jwc.cjs');
const forbidden = [
    'node_modules/jawcode/package.json',
    'node_modules/jwc/package.json',
    'node_modules/bun/package.json',
    'node_modules/kept/node_modules/bun/package.json',
    'node_modules/@oven/bun-linux/package.json',
    'node_modules/@jawcode-dev/natives/package.json',
    'node_modules/@jawcode-internal/runtime/package.json',
    'node_modules/@jawcode/engine-sdk/package.json',
    'node_modules/@gajae-code/natives/package.json',
    'node_modules/kept/node_modules/@jawcode/new-package/package.json',
    'node_modules/kept/node_modules/@gajae-code/coding-agent/package.json',
    'node_modules/kept/node_modules/.bin/jwc',
    'node_modules/kept/node_modules/.bin/bun.cmd',
    'bun', 'bun.exe', 'bin/bun', 'bin/bun.exe', 'bin/bun.cmd', 'bin/bun.ps1',
    'jwc', 'jwc.exe',
    'bin/jwc', 'bin/jwc.cmd', 'bin/jwc.ps1', 'bin/jwc.exe',
    'dist/src/lib/tui/bun-shim.mjs',
    'dist/src/lib/tui/components/editor.js',
    'dist/src/lib/tui/jawcode-tui-bundle.mjs',
    'dist/src/lib/native/pi_natives.darwin-arm64.node',
    'dist/src/lib/native/pi_natives.linux-x64.node',
    'dist/src/cli/tui/jawcode-render.js',
    'dist/src/agent/jwc-runtime.js',
    'dist/bin/commands/jwc.js',
    'electron/sidecar/jawcode/packages/jwc/package.json',
    'node_modules/claude-e/package.json',
    'node_modules/claude-exec/package.json',
    'node_modules/@bitkyc08/ai-e/package.json',
    'node_modules/kept/node_modules/@bitkyc08/ai-e/package.json',
    'node_modules/kept/node_modules/.bin/claude-e',
    'node_modules/kept/node_modules/.bin/jaw-claude-i',
    'bin/jaw-claude-i',
    'bin/jaw-claude-i.exe',
    'bin/claude-e',
    'bin/claude-exec',
    'jaw-claude-i',
];
const manifest = { name: 'cli-jaw', bin: { jaw: 'dist/bin/cli-jaw.js' },
    dependencies: { 'better-sqlite3': '13.0.2' }, optionalDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.282' } };
const required = ['package.json', 'dist/bin/cli-jaw.js'];
const packed = (paths: string[]) => paths.map(path => ({ path }));

function fixture(run: (dir: string, put: (file: string, content?: string) => void) => void) {
    const owned = mkdtempSync(join(tmpdir(), 'jaw-retired-package-'));
    const put = (file: string, content = '') => {
        mkdirSync(dirname(join(owned, file)), { recursive: true });
        writeFileSync(join(owned, file), content);
    };
    try { run(owned, put); } finally { rmSync(owned, { recursive: true, force: true }); }
}
function check(dir: string) {
    const result = spawnSync(process.execPath, [checker, '--server-root', dir], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
    });
    assert.equal(result.error, undefined);
    return result;
}

test('staged and platform layouts retain Node/Jaw and unrelated native providers', () => {
    for (const layout of ['electron/sidecar/server', 'mac/cli-jaw.app/Contents/Resources/server',
        'win-unpacked/resources/server', 'linux-unpacked/resources/server']) fixture((dir, put) => {
        put(`${layout}/${layout.startsWith('win') ? 'node.exe' : 'node'}`);
        put(`${layout}/bin/${layout.startsWith('win') ? 'jaw.cmd' : 'jaw'}`);
        put(`${layout}/package.json`, JSON.stringify(manifest));
        for (const file of ['node_modules/better-sqlite3/build/Release/better_sqlite3.node',
            'node_modules/@mariozechner/pi-coding-agent/dist/index.js',
            'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
            'node_modules/@github/copilot/index.js', 'dist/src/agent/pi-runtime.js']) put(`${layout}/${file}`);
        assert.equal(check(join(dir, layout)).status, 0);
    });
});

test('missing staged payload, Node or Jaw cannot pass as absence proof', () => {
    fixture((dir, put) => {
        assert.equal(check(dir).status, 1);
        put('node');
        assert.equal(check(dir).status, 1);
        rmSync(join(dir, 'node'));
        put('bin/jaw');
        assert.equal(check(dir).status, 1);
    });
});

test('Hono Bun adapters are ordinary package content in staged and packed payloads', () => {
    const adapters = [
        'node_modules/hono/dist/adapter/bun/index.js',
        'node_modules/hono/dist/cjs/adapter/bun/index.js',
        'node_modules/hono/dist/types/adapter/bun/index.d.ts',
        'node_modules/kept/node_modules/hono/dist/adapter/bun/index.js',
    ];
    fixture((dir, put) => {
        put('node'); put('bin/jaw');
        put('node_modules/hono/package.json', JSON.stringify({ name: 'hono' }));
        for (const file of adapters) put(file, 'export {};');
        const result = check(dir);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotThrow(() => checkPackedFiles(packed([...required, ...adapters]), manifest));
    });
});

for (const file of forbidden) test(`staged sidecar and packed files reject ${file}`, () => {
    fixture((dir, put) => {
        put('node'); put('bin/jaw');
        put(file, file.endsWith('package.json') ? '{}' : 'forbidden payload');
        const result = check(dir);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /must not be bundled/);
        assert.throws(() => checkPackedFiles(packed([...required, file]), manifest), /retired payload/);
    });
});

test('a broken retired shim symlink is rejected without following or deleting user data', { skip: process.platform === 'win32' }, () => {
    fixture((dir, put) => {
        put('node'); put('bin/jaw');
        symlinkSync('../missing-external-runtime', join(dir, 'bin/jwc'));
        assert.equal(check(dir).status, 1);
    });
});

test('contained package aliases are inspected and link cycles terminate', { skip: process.platform === 'win32' }, () => {
    fixture((dir, put) => {
        put('node'); put('bin/jaw');
        put('payload/package.json', JSON.stringify({ name: 'kept' }));
        mkdirSync(join(dir, 'node_modules'));
        symlinkSync('../payload', join(dir, 'node_modules/alias'));
        symlinkSync('.', join(dir, 'payload/cycle'));
        assert.equal(check(dir).status, 0);
        put('payload/package.json', JSON.stringify({ name: '@jawcode/engine-sdk' }));
        assert.equal(check(dir).status, 1);
    });
});

test('package and lock manifests reject scoped packages, aliases and nested declarations', () => {
    const cleanLock = { packages: { '': manifest } };
    assert.doesNotThrow(() => checkDefaultInstall(manifest, cleanLock));
    assert.doesNotThrow(() => checkPackedFiles(packed(required), manifest));
    for (const name of ['jawcode', '@jawcode/engine-sdk', '@jawcode-internal/runtime', '@gajae-code/natives', '@oven/bun-linux']) {
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
            const bad = { ...manifest, [field]: { [name]: '1.0.0' } };
            assert.throws(() => checkDefaultInstall(bad, cleanLock), /retired dependency/);
            assert.throws(() => checkPackedFiles(packed(required), bad), /retired dependency/);
            fixture((dir, put) => {
                put('node'); put('bin/jaw');
                put('node_modules/kept/package.json', JSON.stringify(bad));
                assert.equal(check(dir).status, 1);
            });
        }
        assert.throws(() => checkDefaultInstall(manifest, { packages: {
            '': manifest, [`node_modules/kept/node_modules/${name}`]: { version: '1.0.0' },
        } }), /retired/);
    }
    assert.throws(() => checkDefaultInstall({ dependencies: { alias: 'npm:jawcode@1.0.0' } }, cleanLock), /retired dependency/);
    assert.throws(() => checkDefaultInstall({ dependencies: { alias: 'npm:@jawcode/engine-sdk@1.0.0' } }, cleanLock), /retired dependency/);
    assert.throws(() => checkPackedFiles(packed(required), { ...manifest, bin: { jwc: 'runtime.js' } }), /jwc shim/);
});

test('retired claude-e / claude-exec / @bitkyc08/ai-e installs are rejected and other @bitkyc08 packages are not', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        for (const name of ['claude-e', 'claude-exec', '@bitkyc08/ai-e']) {
            assert.throws(() => checkDefaultInstall({ ...manifest, [field]: { [name]: '1.0.0' } }, { packages: { '': manifest } }), /retired dependency/);
        }
        assert.doesNotThrow(() => checkDefaultInstall({ ...manifest, [field]: { '@bitkyc08/other': '1.0.0' } }, { packages: { '': manifest } }));
    }
    assert.throws(() => checkDefaultInstall(manifest, { packages: {
        '': manifest, 'node_modules/kept/node_modules/@bitkyc08/ai-e': { version: '1.0.0' },
    } }), /retired/);
    assert.doesNotThrow(() => checkDefaultInstall(manifest, { packages: {
        '': manifest, 'node_modules/kept/node_modules/@bitkyc08/other': { version: '1.0.0' },
    } }));
    assert.throws(() => checkDefaultInstall({ name: '@bitkyc08/ai-e' }, { packages: {} }), /retired package/);
    assert.doesNotThrow(() => checkDefaultInstall({ name: '@bitkyc08/other' }, { packages: {} }));
});

test('empty package inventories and missing packed CLI or manifest fail', () => {
    assert.throws(() => checkPackedFiles([], manifest), /empty/);
    assert.throws(() => checkPackedFiles(packed(['package.json']), manifest), /Jaw entrypoint/);
    assert.throws(() => checkPackedFiles(packed(['dist/bin/cli-jaw.js']), manifest), /package.json/);
});

test('source-only smoke checks all manifests without a build and reports unexecuted artifact checks', () => {
    fixture((dir, put) => {
        const inputs = ['package.json', 'package-lock.json', 'electron/package.json', 'electron/package-lock.json'];
        for (const file of inputs) put(file, JSON.stringify(file.endsWith('package-lock.json')
            ? { packages: { '': manifest } } : manifest));
        mkdirSync(join(dir, 'scripts'));
        for (const name of ['retired-runtime-package-smoke.mjs', 'check-electron-sidecar-no-jwc.cjs']) {
            copyFileSync(join(root, 'scripts', name), join(dir, 'scripts', name));
        }
        const entry = realpathSync(join(dir, 'scripts/retired-runtime-package-smoke.mjs'));
        const run = (args: string[]) => {
            const result = spawnSync(process.execPath, [entry, ...args], {
                cwd: dir, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
            });
            assert.equal(result.error, undefined);
            return result;
        };
        const source = run(['--source-only']);
        assert.equal(source.status, 0, source.stderr);
        assert.match(source.stdout, /source-only\] PASS root\/electron manifests and locks/);
        assert.match(source.stdout, /packed NOT RUN; CLI NOT RUN; staged NOT RUN/);
        assert.doesNotMatch(source.stdout, /PASS manifest, lock, packed files and retired CLI/);

        const full = run([]);
        assert.equal(full.status, 1);
        assert.match(full.stderr, /full smoke requires a built candidate/);
        assert.doesNotMatch(full.stdout, /PASS/);
        assert.equal(run(['--unknown']).status, 1);

        for (const file of inputs) {
            put(file, JSON.stringify({ dependencies: { jawcode: '1.0.0' } }));
            const rejected = run(['--source-only']);
            assert.equal(rejected.status, 1, `${file}: ${rejected.stdout}${rejected.stderr}`);
            assert.match(rejected.stderr, /retired dependency jawcode/);
            put(file, JSON.stringify(file.endsWith('package-lock.json')
                ? { packages: { '': manifest } } : manifest));
        }
    });
});
