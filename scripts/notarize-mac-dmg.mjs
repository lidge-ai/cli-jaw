#!/usr/bin/env node
/**
 * Notarize and staple the signed macOS disk image, then re-describe it.
 *
 * electron-builder 25.1.8 notarizes and staples the app bundle, and with
 * `dmg.sign` it signs the disk image, but it never notarizes the disk image.
 * A user who downloads the DMG therefore opens a container Gatekeeper cannot
 * vouch for: `spctl --type open` rejects it and the stapler finds no ticket.
 *
 * Stapling is the part that needs care. dmg-builder hashes the DMG into its
 * blockmap immediately after signing it (dmg-builder/out/dmg.js:62-67) and
 * that hash is what lands in latest-mac.yml. Stapling appends the ticket to
 * the file, so every description written before it (the DMG entry in
 * latest-mac.yml and the .blockmap next to the DMG) would describe bytes that
 * no longer exist. This script rebuilds both from the stapled file with the
 * same app-builder command electron-builder uses, and only touches the DMG
 * entry: the ZIP entry and the legacy top-level path/sha512 fields are the
 * updater payload and must stay byte-for-byte what electron-builder wrote.
 *
 * Every step fails closed. A DMG that is unsigned, signed by another team,
 * rejected by the notary service, or not stapled stops the release here
 * instead of being uploaded as if it were trusted.
 */
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const CREDENTIAL_NAMES = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

function defaultRun(cmd, args) {
  const result = childProcess.spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

/** Locate the one DMG electron-builder produced; anything else is ambiguous. */
export function findDiskImage(distDir) {
  if (!existsSync(distDir)) throw new Error(`No build output directory at ${distDir}`);
  const images = readdirSync(distDir).filter(name => name.endsWith('.dmg'));
  if (images.length !== 1) {
    throw new Error(`Expected exactly one .dmg in ${distDir}, found ${images.length}${images.length ? `: ${images.join(', ')}` : ''}`);
  }
  return join(distDir, images[0]);
}

function requireCredentials(env) {
  const missing = CREDENTIAL_NAMES.filter(name => !String(env[name] ?? '').trim());
  if (missing.length > 0) throw new Error(`Missing notarization credential(s): ${missing.join(', ')}`);
  return {
    appleId: String(env['APPLE_ID']).trim(),
    password: String(env['APPLE_APP_SPECIFIC_PASSWORD']).trim(),
    teamId: String(env['APPLE_TEAM_ID']).trim(),
  };
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`;
}

/** Keep the app-specific password out of every message this script can print. */
function redactor(secret) {
  return text => (secret ? String(text).split(secret).join('[redacted]') : String(text));
}

function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

export function resolveAppBuilder() {
  const electronRequire = createRequire(join(projectRoot, 'electron', 'package.json'));
  const { appBuilderPath } = electronRequire('app-builder-bin');
  if (!appBuilderPath || !existsSync(appBuilderPath)) {
    throw new Error(`app-builder binary not found at ${String(appBuilderPath)}; run npm ci --prefix electron`);
  }
  return appBuilderPath;
}

/**
 * Rewrite only the DMG entry of latest-mac.yml. Returns false when the
 * metadata does not list the DMG at all, which leaves nothing stale to fix.
 */
export function updateDiskImageMetadata(metadataPath, dmgName, { sha512, size }) {
  const doc = parseDocument(readFileSync(metadataPath, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`Cannot parse YAML at ${metadataPath}: ${doc.errors[0].message}`);
  if (doc.get('path') === dmgName) {
    throw new Error(`latest-mac.yml names the DMG as the update payload; expected the ZIP`);
  }
  const files = doc.get('files');
  const items = files?.items ?? [];
  const matches = items.filter(item => item?.get?.('url') === dmgName);
  if (matches.length > 1) throw new Error(`latest-mac.yml lists ${dmgName} more than once`);
  if (matches.length === 0) return false;
  matches[0].set('sha512', sha512);
  matches[0].set('size', size);
  writeFileSync(metadataPath, doc.toString());
  return true;
}

export function notarizeMacDiskImage(options = {}) {
  const run = options.run ?? defaultRun;
  const env = options.env ?? process.env;
  const distDir = resolve(options.distDir ?? join(projectRoot, 'electron', 'dist'));
  const dmgPath = options.dmgPath ? resolve(options.dmgPath) : findDiskImage(distDir);
  const metadataPath = options.metadataPath ?? join(distDir, 'latest-mac.yml');
  const credentials = requireCredentials(env);
  const redact = redactor(credentials.password);
  const expectedTeam = String(options.expectedTeamId ?? env['EXPECTED_APPLE_TEAM_ID'] ?? '').trim() || null;
  const log = options.log ?? (message => console.log(message));

  if (!existsSync(dmgPath)) throw new Error(`No disk image at ${dmgPath}`);
  if (expectedTeam && credentials.teamId !== expectedTeam) {
    throw new Error('APPLE_TEAM_ID does not match the expected release signing team');
  }

  // 1. The DMG must already carry our Developer ID signature. dmg-builder
  // skips signing silently when it cannot find an identity.
  const info = run('/usr/bin/codesign', ['-dv', '--verbose=2', dmgPath]);
  const infoText = outputOf(info);
  if (info.error || info.status !== 0) throw new Error(`codesign -dv failed for ${dmgPath}:\n${infoText.trim()}`);
  if (!/Authority=Developer ID Application:/.test(infoText)) {
    throw new Error(`${basename(dmgPath)} is not signed with a Developer ID Application certificate`);
  }
  const signedTeam = (infoText.match(/TeamIdentifier=(\S+)/) ?? [, '(unknown)'])[1];
  if (signedTeam !== credentials.teamId) {
    throw new Error(`${basename(dmgPath)} is signed by team "${signedTeam}", not the notarizing team`);
  }
  if (!/^Timestamp=/m.test(infoText)) throw new Error(`${basename(dmgPath)} signature has no secure timestamp`);

  // 2. Submit and wait for the notary verdict.
  log(`[notarize-mac-dmg] submitting ${basename(dmgPath)}`);
  const submit = run('/usr/bin/xcrun', [
    'notarytool', 'submit', dmgPath,
    '--apple-id', credentials.appleId,
    '--password', credentials.password,
    '--team-id', credentials.teamId,
    '--wait', '--timeout', '45m',
    '--output-format', 'json',
  ]);
  let verdict = null;
  try { verdict = JSON.parse(submit.stdout); } catch { verdict = null; }
  if (submit.error || verdict?.status !== 'Accepted') {
    let detail = redact(outputOf(submit).trim());
    if (typeof verdict?.id === 'string' && /^[0-9a-f-]{36}$/i.test(verdict.id)) {
      const notaryLog = run('/usr/bin/xcrun', [
        'notarytool', 'log', verdict.id,
        '--apple-id', credentials.appleId,
        '--password', credentials.password,
        '--team-id', credentials.teamId,
      ]);
      detail += `\n\nnotary log:\n${redact(outputOf(notaryLog).trim())}`;
    }
    throw new Error(`notarization of ${basename(dmgPath)} was not accepted (status: ${String(verdict?.status ?? 'unknown')})\n${detail}`);
  }
  log(`[notarize-mac-dmg] accepted (submission ${verdict.id})`);

  // 3. Staple so the first open works offline, then prove the ticket is there.
  const staple = run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
  if (staple.error || staple.status !== 0) throw new Error(`stapler staple failed:\n${outputOf(staple).trim()}`);
  const validate = run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  if (validate.error || validate.status !== 0) throw new Error(`stapler validate failed:\n${outputOf(validate).trim()}`);

  // 4. Rebuild the blockmap from the stapled bytes, exactly as electron-builder does.
  const appBuilder = options.appBuilderPath ?? resolveAppBuilder();
  const blockmapPath = `${dmgPath}.blockmap`;
  const blockmap = run(appBuilder, ['blockmap', '--input', dmgPath, '--output', blockmapPath]);
  if (blockmap.error || blockmap.status !== 0) throw new Error(`app-builder blockmap failed:\n${outputOf(blockmap).trim()}`);
  let described;
  try { described = JSON.parse(blockmap.stdout); } catch { described = null; }
  const actualSize = statSync(dmgPath).size;
  const actualHash = sha512Base64(dmgPath);
  if (described?.size !== actualSize || described?.sha512 !== actualHash) {
    throw new Error('app-builder blockmap description does not match the stapled disk image');
  }

  // 5. Point the DMG entry of latest-mac.yml at the stapled bytes.
  const metadataUpdated = existsSync(metadataPath)
    ? updateDiskImageMetadata(metadataPath, basename(dmgPath), { sha512: actualHash, size: actualSize })
    : false;

  return { dmgPath, blockmapPath, metadataPath, metadataUpdated, submissionId: verdict.id, sha512: actualHash, size: actualSize };
}

function main() {
  try {
    const report = notarizeMacDiskImage({ dmgPath: process.argv[2] });
    console.log('[notarize-mac-dmg] OK');
    console.log(`  dmg       ${report.dmgPath}`);
    console.log(`  stapled   yes`);
    console.log(`  blockmap  ${report.blockmapPath}`);
    console.log(`  metadata  ${report.metadataUpdated ? 'DMG entry updated' : 'no DMG entry'}`);
    console.log(`  sha512    ${report.sha512}`);
  } catch (error) {
    console.error(`\n[notarize-mac-dmg] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
