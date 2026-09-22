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
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Mach-O and universal-binary magic numbers, both endiannesses. */
const MACHO_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, // 32/64-bit, host order
  0xcefaedfe, 0xcffaedfe, // 32/64-bit, byte-swapped
  0xcafebabe, 0xbebafeca, // universal ("fat") binary
  0xcafebabf, 0xbfbafeca, // universal FAT64, both byte orders
]);

/** True when the first four bytes identify a Mach-O image. */
function isMachO(path) {
  let fd;
  let failure;
  let result = false;
  try {
    if (fs.statSync(path).size < 4) return false;
    fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead !== 4) throw new Error(`short read (${bytesRead}/4 bytes)`);
    result = MACHO_MAGIC.has(buf.readUInt32BE(0)) || MACHO_MAGIC.has(buf.readUInt32LE(0));
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'read and close failed') : error;
      }
    }
  }
  if (failure) throw new Error(`[sign-extra] could not inspect ${path}: ${errorMessage(failure)}`);
  return result;
}

/** Every regular file under `dir`, symlinks not followed. */
async function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`[sign-extra] could not traverse ${dir}: ${errorMessage(error)}`);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export default async function signExtraBinaries(context, dependencies = {}) {
  if (context.electronPlatformName !== 'darwin') return;

  const signing = await resolveIdentity(context, dependencies.findIdentity);
  if (!signing) {
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
      const args = [
        '--force',
        '--timestamp',
        '--options', 'runtime',
        '--entitlements', entitlements,
        '--sign', signing.identity,
      ];
      if (signing.keychainFile) args.push('--keychain', signing.keychainFile);
      args.push(binary);
      childProcess.execFileSync('/usr/bin/codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
async function resolveIdentity(context, findIdentityOverride) {
  const packager = context.packager;
  const qualifier = packager.platformSpecificBuildOptions?.identity;
  if (process.env['CSC_IDENTITY_AUTO_DISCOVERY'] === 'false' || qualifier === null) return null;

  let signingInfo;
  try {
    // app-builder-lib 25.1.8 source anchors:
    // out/macPackager.js:25-50 owns CSC_LINK import and keychain cleanup;
    // out/macPackager.js:190-197 awaits this owner before findIdentity.
    signingInfo = await packager.codeSigningInfo.value;
  } catch (error) {
    const stage = credentialPreparationStage(error);
    throw new Error(
      `[sign-extra] electron-builder could not prepare signing credentials${stage ? ` (${stage})` : ''}`,
    );
  }

  const keychainFile = signingInfo?.keychainFile ?? null;
  let identity;
  try {
    const findIdentity = findIdentityOverride ?? loadFindIdentity();
    identity = await findIdentity('Developer ID Application', qualifier, keychainFile);
  } catch {
    throw new Error('[sign-extra] electron-builder could not resolve the Developer ID Application identity');
  }

  if (!identity) {
    if (isSigningRequested(packager, qualifier)) {
      throw new Error('[sign-extra] requested signing but no Developer ID Application identity was found');
    }
    return null;
  }
  return { identity: identity.hash || identity.name, keychainFile };
}

function loadFindIdentity() {
  // This internal path is pinned by electron/package-lock.json to app-builder-lib 25.1.8.
  return require('app-builder-lib/out/codeSign/macCodeSign.js').findIdentity;
}

function isSigningRequested(packager, qualifier) {
  return packager.forceCodeSigning === true ||
    nonEmpty(process.env['CSC_LINK']) ||
    nonEmpty(process.env['CSC_NAME']) ||
    nonEmpty(qualifier) ||
    packager.platformSpecificBuildOptions?.sign != null ||
    (packager.platformSpecificBuildOptions?.notarize != null &&
      packager.platformSpecificBuildOptions.notarize !== false);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error) {
  if (error instanceof AggregateError) return error.errors.map(errorMessage).join('; ');
  return error instanceof Error ? error.message : String(error);
}

/** Report only the failing operation, never certificate paths or passwords. */
function credentialPreparationStage(error) {
  const message = errorMessage(error);
  if (/security[^\n]*\bimport\b/i.test(message)) return 'certificate import failed';
  if (/set-key-partition-list/i.test(message)) return 'keychain access setup failed';
  if (/create-keychain|unlock-keychain|set-keychain-settings/i.test(message)) return 'temporary keychain setup failed';
  if (/list-keychains/i.test(message)) return 'keychain search-list setup failed';
  if (/base64|certificate source|download/i.test(message)) return 'certificate source decode failed';
  return null;
}
