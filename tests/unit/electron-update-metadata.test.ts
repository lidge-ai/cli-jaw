import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { verifyElectronUpdateMetadata } from '../../scripts/verify-electron-update-metadata.mjs';

function fixture(t: test.TestContext, version = '2.17.55') {
  const root = mkdtempSync(join(tmpdir(), 'jaw-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'electron', 'dist');
  const appResources = join(dist, 'mac-arm64', 'cli-jaw.app', 'Contents', 'Resources');
  mkdirSync(appResources, { recursive: true });
  const packagePath = join(root, 'electron', 'package.json');
  writeFileSync(packagePath, JSON.stringify({ version }));
  const zipName = `cli-jaw-${version}-arm64-mac.zip`;
  const zipPath = join(dist, zipName);
  const bytes = Buffer.from('signed-update-fixture');
  writeFileSync(zipPath, bytes);
  writeFileSync(`${zipPath}.blockmap`, '{}');
  const digest = createHash('sha512').update(bytes).digest('base64');
  const dmgName = `cli-jaw-${version}-arm64.dmg`;
  const dmgPath = join(dist, dmgName);
  const dmgBytes = Buffer.from('stapled-dmg-fixture');
  writeFileSync(dmgPath, dmgBytes);
  const dmgDigest = createHash('sha512').update(dmgBytes).digest('base64');
  const metadataPath = join(dist, 'latest-mac.yml');
  writeFileSync(metadataPath, stringify({
    version,
    files: [
      { url: dmgName, sha512: dmgDigest, size: dmgBytes.length },
      { url: zipName, sha512: digest, size: bytes.length },
    ],
    path: zipName,
    sha512: digest,
  }));
  const appUpdatePath = join(appResources, 'app-update.yml');
  writeFileSync(appUpdatePath, stringify({ provider: 'github', owner: 'lidge-ai', repo: 'cli-jaw' }));
  return { root, dist, packagePath, metadataPath, appUpdatePath, zipPath, dmgPath };
}

function winFixture(t: test.TestContext, version = '2.17.55') {
  const root = mkdtempSync(join(tmpdir(), 'jaw-update-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'electron', 'dist');
  const appResources = join(dist, 'win-unpacked', 'resources');
  mkdirSync(appResources, { recursive: true });
  const packagePath = join(root, 'electron', 'package.json');
  writeFileSync(packagePath, JSON.stringify({ version }));
  const exeName = `cli-jaw-Setup-${version}.exe`;
  const exePath = join(dist, exeName);
  const bytes = Buffer.from('unsigned-windows-update-fixture');
  writeFileSync(exePath, bytes);
  writeFileSync(`${exePath}.blockmap`, '{}');
  const digest = createHash('sha512').update(bytes).digest('base64');
  const metadataPath = join(dist, 'latest.yml');
  writeFileSync(metadataPath, stringify({
    version,
    files: [{ url: exeName, sha512: digest, size: bytes.length }],
    path: exeName,
    sha512: digest,
  }));
  const appUpdatePath = join(appResources, 'app-update.yml');
  writeFileSync(appUpdatePath, stringify({ provider: 'github', owner: 'lidge-ai', repo: 'cli-jaw' }));
  return { root, dist, packagePath, metadataPath, appUpdatePath, exePath };
}

function mutateYaml(path: string, mutate: (value: ReturnType<typeof parse>) => void) {
  const value = parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, stringify(value));
}

test('accepts stable and preview update metadata with matching provider and payload', (t) => {
  for (const version of ['2.17.55', '2.17.55-preview.20260922010101']) {
    const f = fixture(t, version);
    const report = verifyElectronUpdateMetadata({ projectRoot: f.root });
    assert.equal(report.version, version);
    assert.equal(report.metadataPath, f.metadataPath);
  }
});

test('rejects a payload whose bytes no longer match the published hash', (t) => {
  const f = fixture(t);
  writeFileSync(f.zipPath, 'tampered');
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /size mismatch|SHA-512/);
});

test('rejects a DMG entry that still describes the bytes from before stapling', (t) => {
  const f = fixture(t);
  // Same length, different bytes: only the hash can catch it.
  writeFileSync(f.dmgPath, 'stapled-dmg-FIXTURE');
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /arm64\.dmg SHA-512 does not match/);
  writeFileSync(f.dmgPath, 'stapled-dmg-fixture plus an appended ticket');
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /arm64\.dmg size mismatch/);
});

test('rejects metadata that lists a DMG the build did not leave behind', (t) => {
  const f = fixture(t);
  rmSync(f.dmgPath);
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /Missing listed update artifact/);
});

test('rejects a provider that points updates at another repository', (t) => {
  const f = fixture(t);
  const config = parse(readFileSync(f.appUpdatePath, 'utf8'));
  config.repo = 'lookalike';
  writeFileSync(f.appUpdatePath, stringify(config));
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /expected cli-jaw/);
});

test('rejects path traversal in the update ZIP entry', (t) => {
  const f = fixture(t);
  const metadata = parse(readFileSync(f.metadataPath, 'utf8'));
  metadata.files[1].url = `../${metadata.files[1].url}`;
  writeFileSync(f.metadataPath, stringify(metadata));
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /Unsafe update artifact/);
});

test('rejects ambiguous metadata with more than one update ZIP', (t) => {
  const f = fixture(t);
  const metadata = parse(readFileSync(f.metadataPath, 'utf8'));
  metadata.files.push({ ...metadata.files[1], url: `duplicate-${metadata.files[1].url}` });
  writeFileSync(f.metadataPath, stringify(metadata));
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root }), /exactly one ZIP/);
});

test('accepts Windows metadata with one matching installer and provider', (t) => {
  const f = winFixture(t);
  const report = verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' });
  assert.equal(report.metadataPath, f.metadataPath);
  assert.equal(report.payloadPath, f.exePath);
});

test('rejects Windows metadata when latest.yml is missing', (t) => {
  const f = winFixture(t);
  rmSync(f.metadataPath);
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Missing update metadata/);
});

test('rejects Windows metadata with a different version', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.version = '9.9.9'; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /does not match package version/);
});

test('rejects Windows metadata with no installer entry', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.files = []; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /exactly one EXE/);
});

test('rejects Windows metadata with two installer entries', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => {
    metadata.files.push({ ...metadata.files[0], url: `duplicate-${metadata.files[0].url}` });
  });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /exactly one EXE/);
});

test('rejects an unsafe Windows installer URL', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.files[0].url = `../${metadata.files[0].url}`; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Unsafe update artifact/);
});

test('rejects Windows metadata naming an installer that does not exist', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => {
    metadata.files[0].url = 'cli-jaw Setup 2.17.55.exe';
    metadata.path = metadata.files[0].url;
  });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Missing update EXE/);
});

test('rejects a Windows installer size mismatch', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.files[0].size += 1; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /EXE size mismatch/);
});

test('rejects a Windows installer SHA-512 mismatch', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => {
    metadata.files[0].sha512 = createHash('sha512').update('other-bytes').digest('base64');
    metadata.sha512 = metadata.files[0].sha512;
  });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /EXE SHA-512/);
});

test('rejects Windows metadata when the installer blockmap is missing', (t) => {
  const f = winFixture(t);
  rmSync(`${f.exePath}.blockmap`);
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Missing update blockmap/);
});

test('rejects a Windows legacy path that differs from the installer entry', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.path = 'other.exe'; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Legacy Windows/);
});

test('rejects a Windows legacy hash that differs from the installer entry', (t) => {
  const f = winFixture(t);
  mutateYaml(f.metadataPath, metadata => { metadata.sha512 = 'different'; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Legacy Windows/);
});

test('rejects a Windows packaged provider that points elsewhere', (t) => {
  const f = winFixture(t);
  mutateYaml(f.appUpdatePath, provider => { provider.owner = 'lookalike'; });
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /expected lidge-ai/);
});

test('rejects Windows metadata when packaged app-update.yml is missing', (t) => {
  const f = winFixture(t);
  rmSync(f.appUpdatePath);
  assert.throws(() => verifyElectronUpdateMetadata({ projectRoot: f.root, platform: 'win' }), /Missing packaged update provider config/);
});

test('CLI keeps positional macOS paths and removes the platform flag before resolving Windows paths', (t) => {
  const repoVersion = JSON.parse(readFileSync(join(process.cwd(), 'electron', 'package.json'), 'utf8')).version;
  const mac = fixture(t, repoVersion);
  const win = winFixture(t, repoVersion);
  const script = join(process.cwd(), 'scripts', 'verify-electron-update-metadata.mjs');

  const macResult = spawnSync(process.execPath, [script, mac.dist, mac.appUpdatePath], { encoding: 'utf8' });
  assert.equal(macResult.status, 0, macResult.stderr);
  assert.match(macResult.stdout, /latest-mac\.yml/);

  const winResult = spawnSync(process.execPath, [script, win.dist, '--platform', 'win', win.appUpdatePath], { encoding: 'utf8' });
  assert.equal(winResult.status, 0, winResult.stderr);
  assert.match(winResult.stdout, /latest\.yml/);
});
