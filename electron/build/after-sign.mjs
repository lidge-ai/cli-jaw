import childProcess from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Preserve a real signature, or ad-hoc sign an unsigned bundle when this
 * function is invoked directly.
 *
 * electron-builder is configured to use this hook, but it invokes afterSign
 * only when its mac signing pass runs. The default no-identity packaging path
 * skips both that pass and this hook, then applies its final plain ad-hoc
 * signature through the separate electron:resign:mac command. Unit tests call
 * this function directly; they do not prove that electron-builder invoked it.
 *
 * This hook used to run `codesign --sign -` unconditionally. That was correct
 * while the build was always unsigned, and actively destructive once a
 * Developer ID identity exists: electron-builder signs the app, then this hook
 * replaced that signature with an ad-hoc one, so the artifact could never be
 * notarized and the failure surfaced only at the end of a release as a
 * confusing "not signed with a valid Developer ID".
 *
 * `--deep` is also the wrong tool for a real signature. Apple deprecated it and
 * it signs nested code in the wrong order, clobbering the inside-out signing
 * electron-builder already performed. It stays only on the ad-hoc path, where
 * the signature carries no trust anyway and the goal is merely to make the app
 * launchable on the machine that built it.
 */
export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);

  if (isRealSignature(appPath)) {
    console.log(`[after-sign] ${appName} carries a real signature; leaving it alone.`);
    return;
  }

  console.log(`[after-sign] ${appName} is unsigned; applying an ad-hoc signature.`);
  const entitlementsPath = join(here, 'entitlements.mac.plist');
  childProcess.execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    entitlementsPath,
    appPath,
  ], { stdio: 'inherit' });
}

/**
 * True when the bundle is signed by a certificate authority rather than ad-hoc.
 *
 * An ad-hoc signature reports `Signature=adhoc`; a real one reports an
 * `Authority=` chain. codesign writes this report to stderr even on success.
 * A recognized unsigned result is the only non-zero outcome that enables the
 * fallback; launch, permission and malformed-report failures stop the build.
 */
function isRealSignature(appPath) {
  const looksReal = (text) => text.includes('Authority=') && !/Signature\s*=\s*adhoc/.test(text);
  const result = childProcess.spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error) {
    throw new Error(`[after-sign] could not inspect existing signature: ${result.error.message}`);
  }
  if (result.status === 0) {
    if (looksReal(text)) return true;
    if (/Signature\s*=\s*adhoc/.test(text)) return false;
    throw new Error(`[after-sign] could not inspect existing signature: codesign returned an unrecognized successful report${detail(text)}`);
  }
  if (/code object is not signed at all/i.test(text)) return false;

  const termination = result.signal ? `signal ${result.signal}` : `status ${result.status ?? 'unknown'}`;
  throw new Error(`[after-sign] could not inspect existing signature: codesign exited with ${termination}${detail(text)}`);
}

function detail(text) {
  const trimmed = text.trim();
  return trimmed ? `: ${trimmed}` : '';
}
