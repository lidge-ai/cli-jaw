#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const EXPECTED_PROVIDER = Object.freeze({
  provider: 'github',
  owner: 'lidge-ai',
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
  const platform = options.platform ?? 'mac';
  if (platform !== 'mac' && platform !== 'win') {
    throw new Error(`Unsupported update metadata platform: ${String(platform)}`);
  }
  const projectRoot = resolve(options.projectRoot ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  const distDir = resolve(options.distDir ?? join(projectRoot, 'electron', 'dist'));
  const packagePath = resolve(options.packagePath ?? join(projectRoot, 'electron', 'package.json'));
  const appUpdatePath = resolve(
    options.appUpdatePath ?? (platform === 'win'
      ? join(distDir, 'win-unpacked', 'resources', 'app-update.yml')
      : join(distDir, 'mac-arm64', 'cli-jaw.app', 'Contents', 'Resources', 'app-update.yml')),
  );
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  // electron-builder's GitHub provider always emits latest-mac.yml. For a
  // prerelease, electron-updater first selects a matching tag from the GitHub
  // release feed, tries <channel>-mac.yml, then intentionally falls back to
  // latest-mac.yml inside that selected release.
  const metadataPath = join(distDir, platform === 'win' ? 'latest.yml' : 'latest-mac.yml');

  if (!existsSync(metadataPath)) throw new Error(`Missing update metadata: ${metadataPath}`);
  if (!existsSync(appUpdatePath)) throw new Error(`Missing packaged update provider config: ${appUpdatePath}`);

  const metadata = readYaml(metadataPath);
  if (metadata?.version !== version) {
    throw new Error(`Update metadata version ${String(metadata?.version)} does not match package version ${version}`);
  }
  if (!Array.isArray(metadata?.files)) {
    throw new Error(`${platform === 'win' ? 'Windows' : 'macOS'} update metadata must contain artifact entries`);
  }
  for (const file of metadata.files) {
    if (typeof file?.url !== 'string' || basename(file.url) !== file.url) {
      throw new Error(`Unsafe update artifact path: ${String(file?.url)}`);
    }
  }
  const payloadEntries = metadata.files.filter(file => platform === 'win'
    ? file.url.toLowerCase().endsWith('.exe')
    : file.url.endsWith('-mac.zip'));
  if (payloadEntries.length !== 1) {
    throw new Error(`${platform === 'win' ? 'Windows' : 'macOS'} update metadata must contain exactly one ${platform === 'win' ? 'EXE' : 'ZIP'} entry`);
  }

  const entry = payloadEntries[0];
  const payloadPath = join(distDir, entry.url);
  const blockmapPath = `${payloadPath}.blockmap`;
  const payloadLabel = platform === 'win' ? 'EXE' : 'ZIP';
  if (!existsSync(payloadPath)) throw new Error(`Missing update ${payloadLabel}: ${payloadPath}`);
  if (!existsSync(blockmapPath)) throw new Error(`Missing update blockmap: ${blockmapPath}`);

  const actualSize = statSync(payloadPath).size;
  if (entry.size !== actualSize) {
    throw new Error(`Update ${payloadLabel} size mismatch: metadata=${String(entry.size)} actual=${actualSize}`);
  }
  const actualHash = sha512(payloadPath);
  if (entry.sha512 !== actualHash) throw new Error(`Update ${payloadLabel} SHA-512 does not match update metadata`);
  if (metadata.path !== entry.url || metadata.sha512 !== entry.sha512) {
    throw new Error(`Legacy ${platform === 'win' ? 'Windows' : 'macOS'} update metadata fields do not match the updater payload`);
  }

  // The other entries (the DMG) are not the updater payload, but they are
  // published next to it and describe bytes users download. The DMG is
  // stapled after electron-builder hashed it, so a stale description here
  // means the post-staple metadata repair did not run or did not stick.
  const otherArtifacts = [];
  for (const file of platform === 'mac' ? metadata.files : []) {
    if (file === entry) continue;
    const artifactPath = join(distDir, file.url);
    if (!existsSync(artifactPath)) throw new Error(`Missing listed update artifact: ${artifactPath}`);
    const size = statSync(artifactPath).size;
    if (file.size !== size) {
      throw new Error(`${file.url} size mismatch: metadata=${String(file.size)} actual=${size}`);
    }
    if (file.sha512 !== sha512(artifactPath)) {
      throw new Error(`${file.url} SHA-512 does not match update metadata`);
    }
    otherArtifacts.push(artifactPath);
  }

  const provider = readYaml(appUpdatePath);
  for (const [key, expected] of Object.entries(EXPECTED_PROVIDER)) {
    if (provider?.[key] !== expected) {
      throw new Error(`Packaged update provider ${key}=${String(provider?.[key])}; expected ${expected}`);
    }
  }

  return { metadataPath, payloadPath, zipPath: platform === 'mac' ? payloadPath : undefined, blockmapPath, version, sha512: actualHash, otherArtifacts, platform };
}

function parseCliArgs(args) {
  const positional = [];
  let platform = 'mac';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--platform') {
      if (i + 1 >= args.length) throw new Error('--platform requires mac or win');
      platform = args[i + 1];
      i += 1;
      continue;
    }
    positional.push(args[i]);
  }
  return { platform, distDir: positional[0], appUpdatePath: positional[1] };
}

function main() {
  try {
    const report = verifyElectronUpdateMetadata(parseCliArgs(process.argv.slice(2)));
    console.log('[verify-electron-update-metadata] OK');
    console.log(`  version   ${report.version}`);
    console.log(`  metadata  ${report.metadataPath}`);
    console.log(`  payload   ${report.payloadPath}`);
    console.log(`  blockmap  ${report.blockmapPath}`);
    console.log(`  sha512    ${report.sha512}`);
    for (const artifact of report.otherArtifacts) console.log(`  listed    ${artifact} (hash matches)`);
  } catch (error) {
    console.error(`\n[verify-electron-update-metadata] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
