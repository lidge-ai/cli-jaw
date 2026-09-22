import test from 'node:test';
import assert from 'node:assert/strict';
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
  const metadataPath = join(dist, 'latest-mac.yml');
  writeFileSync(metadataPath, stringify({
    version,
    files: [
      { url: dmgName, sha512: 'unused-by-updater-verifier', size: 123 },
      { url: zipName, sha512: digest, size: bytes.length },
    ],
    path: zipName,
    sha512: digest,
  }));
  const appUpdatePath = join(appResources, 'app-update.yml');
  writeFileSync(appUpdatePath, stringify({ provider: 'github', owner: 'lidge-jun', repo: 'cli-jaw' }));
  return { root, dist, packagePath, metadataPath, appUpdatePath, zipPath };
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
