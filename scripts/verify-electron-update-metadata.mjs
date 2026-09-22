#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const EXPECTED_PROVIDER = Object.freeze({
  provider: 'github',
  owner: 'lidge-jun',
  repo: 'cli-jaw',
});

function readYaml(path) {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse YAML at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

export function verifyElectronUpdateMetadata(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  const distDir = resolve(options.distDir ?? join(projectRoot, 'electron', 'dist'));
  const packagePath = resolve(options.packagePath ?? join(projectRoot, 'electron', 'package.json'));
  const appUpdatePath = resolve(
    options.appUpdatePath ?? join(distDir, 'mac-arm64', 'cli-jaw.app', 'Contents', 'Resources', 'app-update.yml'),
  );
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  // electron-builder's GitHub provider always emits latest-mac.yml. For a
  // prerelease, electron-updater first selects a matching tag from the GitHub
  // release feed, tries <channel>-mac.yml, then intentionally falls back to
  // latest-mac.yml inside that selected release.
  const metadataPath = join(distDir, 'latest-mac.yml');

  if (!existsSync(metadataPath)) throw new Error(`Missing update metadata: ${metadataPath}`);
  if (!existsSync(appUpdatePath)) throw new Error(`Missing packaged update provider config: ${appUpdatePath}`);

  const metadata = readYaml(metadataPath);
  if (metadata?.version !== version) {
    throw new Error(`Update metadata version ${String(metadata?.version)} does not match package version ${version}`);
  }
  if (!Array.isArray(metadata?.files) || metadata.files.length !== 1) {
    throw new Error('macOS update metadata must contain exactly one ZIP entry');
  }

  const entry = metadata.files[0];
  if (typeof entry?.url !== 'string' || basename(entry.url) !== entry.url || !entry.url.endsWith('-mac.zip')) {
    throw new Error(`Unsafe or unexpected update ZIP path: ${String(entry?.url)}`);
  }
  const zipPath = join(distDir, entry.url);
  const blockmapPath = `${zipPath}.blockmap`;
  if (!existsSync(zipPath)) throw new Error(`Missing update ZIP: ${zipPath}`);
  if (!existsSync(blockmapPath)) throw new Error(`Missing update blockmap: ${blockmapPath}`);

  const actualSize = statSync(zipPath).size;
  if (entry.size !== actualSize) {
    throw new Error(`Update ZIP size mismatch: metadata=${String(entry.size)} actual=${actualSize}`);
  }
  const actualHash = sha512(zipPath);
  if (entry.sha512 !== actualHash) throw new Error('Update ZIP SHA-512 does not match update metadata');
  if (metadata.path !== entry.url || metadata.sha512 !== entry.sha512) {
    throw new Error('Legacy macOS update metadata fields do not match files[0]');
  }

  const provider = readYaml(appUpdatePath);
  for (const [key, expected] of Object.entries(EXPECTED_PROVIDER)) {
    if (provider?.[key] !== expected) {
      throw new Error(`Packaged update provider ${key}=${String(provider?.[key])}; expected ${expected}`);
    }
  }

  return { metadataPath, zipPath, blockmapPath, version, sha512: actualHash };
}

function main() {
  try {
    const report = verifyElectronUpdateMetadata({
      distDir: process.argv[2],
      appUpdatePath: process.argv[3],
    });
    console.log('[verify-electron-update-metadata] OK');
    console.log(`  version   ${report.version}`);
    console.log(`  metadata  ${report.metadataPath}`);
    console.log(`  zip       ${report.zipPath}`);
    console.log(`  blockmap  ${report.blockmapPath}`);
    console.log(`  sha512    ${report.sha512}`);
  } catch (error) {
    console.error(`\n[verify-electron-update-metadata] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
