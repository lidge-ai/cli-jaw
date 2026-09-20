#!/usr/bin/env node
/**
 * Sign the Mach-O binaries electron-builder does not sign.
 *
 * electron-builder signs the app, its frameworks and `asarUnpack` output. It
 * does not walk `extraResources`, and `sidecar/server` is shipped that way. The
 * sidecar tree carries real executables -- a bundled `node`, the Claude agent
 * SDK binary, `macos-trash`, prebuilt `.node` addons -- and every one of them
 * is a separate signing subject to Apple.
 *
 * Apple only tells you about it after the upload. A 278MB submission came back
 * `Invalid` with 21 issues that were all the same four binaries repeated:
 *
 *   The binary is not signed with a valid Developer ID certificate.
 *     .../Resources/server/node_modules/trash/lib/macos-trash
 *     .../Resources/app.asar.unpacked/node_modules/node-pty/.../spawn-helper
 *
 * Note `spawn-helper`: it lives under `asarUnpack`, which electron-builder
 * does sign, but it has no file extension. Selecting binaries by extension --
 * the obvious `*.node`, `*.dylib` filter -- silently skips it and produces
 * exactly this rejection. This script therefore classifies by Mach-O magic
 * bytes and ignores filenames entirely.
 *
 * Runs before electron-builder's own signing pass so the outer bundle seals a
 * tree whose contents are already signed.
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Mach-O and universal-binary magic numbers, both endiannesses. */
const MACHO_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, // 32/64-bit, host order
  0xcefaedfe, 0xcffaedfe, // 32/64-bit, byte-swapped
  0xcafebabe, 0xbebafeca, // universal ("fat") binary
]);

/** True when the first four bytes identify a Mach-O image. */
function isMachO(path) {
  let fd;
  try {
    if (statSync(path).size < 4) return false;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0)) || MACHO_MAGIC.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/** Every regular file under `dir`, symlinks not followed. */
async function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export default async function signExtraBinaries(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const identity = resolveIdentity();
  if (!identity) {
    console.log('[sign-extra] no Developer ID identity available; leaving sidecar binaries to the ad-hoc fallback.');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resources = join(context.appOutDir, appName, 'Contents', 'Resources');
  const entitlements = join(here, 'entitlements.mac.plist');

  const files = await collectFiles(resources);
  const binaries = files.filter(isMachO);

  if (binaries.length === 0) {
    console.log('[sign-extra] no Mach-O binaries found under Resources.');
    return;
  }

  // Deepest first: a container must be signed after everything inside it, or
  // the outer seal is invalidated by the inner signature that lands later.
  binaries.sort((a, b) => b.split('/').length - a.split('/').length);

  console.log(`[sign-extra] signing ${binaries.length} Mach-O binaries under Resources`);
  const failures = [];
  for (const binary of binaries) {
    try {
      execFileSync('/usr/bin/codesign', [
        '--force',
        '--timestamp',
        '--options', 'runtime',
        '--entitlements', entitlements,
        '--sign', identity,
        binary,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      failures.push(`${binary.replace(resources, 'Resources')}: ${(error.stderr ?? '').toString().trim()}`);
    }
  }

  if (failures.length > 0) {
    // Failing loudly here costs seconds. Failing silently costs an upload, a
    // notarization round trip and a rejection log.
    throw new Error(`[sign-extra] could not sign ${failures.length} binaries:\n  ${failures.join('\n  ')}`);
  }
  console.log('[sign-extra] done');
}

/**
 * The identity electron-builder is about to use, if there is one.
 *
 * CSC_IDENTITY_AUTO_DISCOVERY=false is how the unsigned local build opts out,
 * so honour it rather than signing behind its back.
 */
function resolveIdentity() {
  if (process.env['CSC_IDENTITY_AUTO_DISCOVERY'] === 'false') return null;
  if (process.env['CSC_NAME']) return process.env['CSC_NAME'];

  try {
    const out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const match = out.match(/"(Developer ID Application: [^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
