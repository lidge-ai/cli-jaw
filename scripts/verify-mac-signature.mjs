#!/usr/bin/env node
/**
 * Fail a signed macOS build that only looks signed.
 *
 * electron-builder exits 0 in several states that all read as success from the
 * terminal and all ship a bundle users cannot open:
 *
 *   - no identity was found, so the build silently fell back to ad-hoc
 *   - the app was signed but `hardenedRuntime` was off, so notarization would
 *     have rejected it
 *   - notarization ran but the ticket was never stapled, so the first launch
 *     on a machine with no network shows the malware dialog
 *
 * The release script asserts the end state here instead of trusting the exit
 * code of the step that produced it.
 */
import childProcess from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Capture stdout and stderr because macOS security tools report on stderr. */
function probe(cmd, args) {
  const result = childProcess.spawnSync(cmd, args, { encoding: 'utf8' });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) return { ok: false, text: `${text}${result.error.message}` };
  return { ok: result.status === 0, text };
}

export function verifyMacSignature(options = {}) {
  const appPath = resolve(options.appPath ?? 'electron/dist/mac-arm64/cli-jaw.app');
  const requireStapled = options.requireStapled ?? process.env['VERIFY_REQUIRE_STAPLED'] !== '0';
  const expectedTeamId = normalizeExpectedTeam(options.expectedTeamId ?? process.env['VERIFY_EXPECTED_TEAM_ID']);

  if (!existsSync(appPath)) {
    throw new Error(`No app bundle at ${appPath}. Did the build step run?`);
  }

  const problems = [];

  // 1. Signed by a real authority, not ad-hoc. Treat an execution failure as
  // its own proof failure instead of deriving several misleading field errors.
  const info = probe('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  if (!info.ok) {
    problems.push(`codesign -dv failed:\n${info.text.trim()}`);
  } else {
    if (!info.text.includes('Authority=')) {
      problems.push('bundle carries no certificate authority (unsigned or ad-hoc)');
    }
    if (/Signature\s*=\s*adhoc/.test(info.text)) {
      problems.push('bundle is ad-hoc signed; the Developer ID identity was not used');
    }

    // 2. Developer ID specifically. An Apple Development certificate signs fine
    // and then fails on every machine that is not a registered device.
    if (info.text.includes('Authority=') && !/Authority=Developer ID Application:/.test(info.text)) {
      const authority = (info.text.match(/Authority=(.+)/) ?? [, '(unknown)'])[1];
      problems.push(`signed by "${authority.trim()}" rather than a Developer ID Application certificate`);
    }

    // 3. Hardened runtime. Notarization refuses a bundle without it.
    if (!/flags=\S*runtime/.test(info.text)) {
      problems.push('hardened runtime is not enabled (flags do not include runtime)');
    }

    // 4. A secure timestamp, not the local clock. Without it the signature stops
    // validating the moment the certificate expires.
    if (!/^Timestamp=/m.test(info.text)) {
      problems.push('signature has no secure timestamp');
    }
  }

  const teamId = (info.text.match(/TeamIdentifier=(\S+)/) ?? [, '(unknown)'])[1];
  if (expectedTeamId && teamId !== expectedTeamId) {
    problems.push(`signature team "${teamId}" does not match expected team "${expectedTeamId}"`);
  }

  // 5. The signature actually verifies, nested code included.
  const strict = probe('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (!strict.ok) {
    problems.push(`codesign --verify failed:\n${strict.text.trim()}`);
  }

  // 6. Gatekeeper's own verdict. This is the check that reflects what a user sees.
  const assess = probe('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  if (!assess.ok) {
    problems.push(`spctl rejected the bundle:\n${assess.text.trim()}`);
  }

  // 7. Stapled notarization ticket, so first launch works offline.
  if (requireStapled) {
    const staple = probe('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    if (!staple.ok) {
      problems.push(
        `no stapled notarization ticket:\n${staple.text.trim()}\n` +
          '  (set VERIFY_REQUIRE_STAPLED=0 to check signing only)',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`${appPath}\n\n  - ${problems.join('\n  - ')}`);
  }

  const authority = (info.text.match(/Authority=(.+)/) ?? [, '(unknown)'])[1].trim();
  return { appPath, authority, teamId, requireStapled };
}

function normalizeExpectedTeam(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * The disk image users download is a separate trust decision from the app
 * inside it. Gatekeeper assesses a quarantined DMG with the `open` operation
 * and the primary-signature context; an unsigned image reports "no usable
 * signature" and a signed but unnotarized one reports "Unnotarized Developer
 * ID". Only a notarized, stapled Developer ID image passes offline.
 */
export function verifyMacDiskImage(options = {}) {
  const dmgPath = resolve(options.dmgPath ?? findDiskImage(options.distDir ?? 'electron/dist'));
  const expectedTeamId = normalizeExpectedTeam(options.expectedTeamId ?? process.env['VERIFY_EXPECTED_TEAM_ID']);

  if (!existsSync(dmgPath)) {
    throw new Error(`No disk image at ${dmgPath}. Did the build step run?`);
  }

  const problems = [];
  const info = probe('/usr/bin/codesign', ['-dv', '--verbose=4', dmgPath]);
  if (!info.ok) {
    problems.push(`codesign -dv failed:\n${info.text.trim()}`);
  } else {
    if (!/Authority=Developer ID Application:/.test(info.text)) {
      problems.push('disk image is not signed with a Developer ID Application certificate');
    }
    if (!/^Timestamp=/m.test(info.text)) {
      problems.push('disk image signature has no secure timestamp');
    }
  }

  const teamId = (info.text.match(/TeamIdentifier=(\S+)/) ?? [, '(unknown)'])[1];
  if (expectedTeamId && teamId !== expectedTeamId) {
    problems.push(`disk image team "${teamId}" does not match expected team "${expectedTeamId}"`);
  }

  const strict = probe('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmgPath]);
  if (!strict.ok) {
    problems.push(`codesign --verify failed:\n${strict.text.trim()}`);
  }

  const assess = probe('/usr/sbin/spctl', [
    '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath,
  ]);
  if (!assess.ok || !/source=Notarized Developer ID/.test(assess.text)) {
    problems.push(`spctl did not accept the disk image as notarized:\n${assess.text.trim()}`);
  }

  const staple = probe('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  if (!staple.ok) {
    problems.push(`disk image has no stapled notarization ticket:\n${staple.text.trim()}`);
  }

  if (problems.length > 0) {
    throw new Error(`${dmgPath}\n\n  - ${problems.join('\n  - ')}`);
  }

  const authority = (info.text.match(/Authority=(.+)/) ?? [, '(unknown)'])[1].trim();
  return { dmgPath, authority, teamId };
}

function findDiskImage(distDir) {
  const dir = resolve(distDir);
  if (!existsSync(dir)) throw new Error(`No build output directory at ${dir}`);
  const images = readdirSync(dir).filter(name => name.endsWith('.dmg'));
  if (images.length !== 1) {
    throw new Error(`Expected exactly one .dmg in ${dir}, found ${images.length}`);
  }
  return join(dir, images[0]);
}

function main() {
  if (process.argv[2] === '--dmg') {
    try {
      const report = verifyMacDiskImage({ dmgPath: process.argv[3] });
      console.log('[verify-mac-signature] disk image OK');
      console.log(`  dmg       ${report.dmgPath}`);
      console.log(`  authority ${report.authority}`);
      console.log(`  team      ${report.teamId}`);
      console.log('  notarized yes');
      console.log('  stapled   yes');
    } catch (error) {
      console.error(`\n[verify-mac-signature] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    return;
  }
  try {
    const report = verifyMacSignature({ appPath: process.argv[2] });
    console.log('[verify-mac-signature] OK');
    console.log(`  bundle    ${report.appPath}`);
    console.log(`  authority ${report.authority}`);
    console.log(`  team      ${report.teamId}`);
    console.log('  hardened  yes');
    console.log(`  stapled   ${report.requireStapled ? 'yes' : 'not checked'}`);
  } catch (error) {
    console.error(`\n[verify-mac-signature] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
