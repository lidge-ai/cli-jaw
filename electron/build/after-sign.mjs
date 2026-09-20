import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Ad-hoc re-sign, but only when nobody signed the bundle for real.
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
  execFileSync('/usr/bin/codesign', [
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
 * `Authority=` chain. An unsigned bundle makes codesign exit non-zero and write
 * its report to stderr, so that case is handled in the catch rather than being
 * mistaken for a failure of the probe itself.
 */
function isRealSignature(appPath) {
  const looksReal = (text) => text.includes('Authority=') && !/Signature\s*=\s*adhoc/.test(text);
  try {
    return looksReal(
      execFileSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) + '',
    );
  } catch (error) {
    return looksReal(`${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}
