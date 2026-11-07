import { pathToFileURL } from 'node:url';

function parse(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] };
}
function compareCore(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function compareReleaseVersions(a, b) {
  const x = parse(a), y = parse(b);
  const core = compareCore(x.core, y.core);
  if (core) return core;
  if (x.prerelease === undefined) return y.prerelease === undefined ? 0 : 1;
  if (y.prerelease === undefined) return -1;
  const p = BigInt(x.prerelease), q = BigInt(y.prerelease);
  return p === q ? 0 : p > q ? 1 : -1;
}
export function resolveReleaseVersion({ channel, pkgVersion, npmLatest = '', bump, explicitBase, stamp }) {
  if (!['stable', 'preview'].includes(channel)) throw new Error('Invalid channel');
  const pkg = parse(pkgVersion), latest = parse(npmLatest || '0.0.0');
  if (latest.prerelease !== undefined) throw new Error('latest must be stable');
  if (bump && !['major', 'minor', 'patch'].includes(bump)) throw new Error('Invalid bump');
  let base, reason;
  if (explicitBase) {
    const parsed = parse(explicitBase);
    if (parsed.prerelease !== undefined || compareCore(parsed.core, pkg.core) < 0) throw new Error('Explicit base below package version');
    base = parsed.core; reason = 'explicit';
  } else if (!bump && pkg.prerelease !== undefined && compareCore(pkg.core, latest.core) > 0) {
    base = pkg.core; reason = 'continue';
  } else {
    base = [...(compareCore(pkg.core, latest.core) >= 0 ? pkg.core : latest.core)];
    const index = { major: 0, minor: 1, patch: 2 }[bump || 'patch'];
    base[index]++; for (let i = index + 1; i < 3; i++) base[i] = 0;
    reason = 'bump';
  }
  if (compareCore(base, latest.core) <= 0) throw new Error('Release base must be newer than latest');
  const baseVersion = base.join('.');
  if (channel === 'preview' && !/^\d{14}$/.test(stamp || '')) throw new Error('Preview stamp must have 14 digits');
  return { version: channel === 'preview' ? `${baseVersion}-preview.${stamp}` : baseVersion, base: baseVersion, channel, reason };
}
export function assertPublishable({channel, candidate, latest, preview = ''}) {
  const version = parse(candidate), stable = parse(latest);
  if (stable.prerelease !== undefined) throw new Error('latest must be stable');
  if (channel === 'stable') {
    if (version.prerelease !== undefined || compareReleaseVersions(candidate, latest) <= 0) throw new Error('stable release must exceed latest');
  } else if (channel === 'preview') {
    if (version.prerelease === undefined || compareCore(version.core, stable.core) <= 0 || (preview && compareReleaseVersions(candidate, preview) <= 0)) throw new Error('preview must exceed preview and latest core');
  } else throw new Error('Invalid channel');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), command = args[0]?.startsWith('--') ? '' : args.shift();
    const options = {};
    while (args.length) { const key = args.shift(); if (!key?.startsWith('--') || !args.length) throw new Error('Invalid arguments'); options[key.slice(2)] = args.shift(); }
    if (command === 'assert-newer') { if (options.current && compareReleaseVersions(options.candidate, options.current) <= 0) throw new Error('candidate is not newer'); else parse(options.candidate); }
    else if (command === 'assert-publishable') assertPublishable(options);
    else if (!command) console.log(resolveReleaseVersion({channel:options.channel,pkgVersion:options.pkg,npmLatest:options['npm-latest'],bump:options.bump,explicitBase:options.base,stamp:options.stamp}).version);
    else throw new Error('Unknown command');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
