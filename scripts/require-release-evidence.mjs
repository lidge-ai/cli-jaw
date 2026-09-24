#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Installer-sensitive path set (issue #333 gap G1)
//
// This list used to be hand-maintained here, in parallel with the trigger list
// in .github/workflows/postinstall-platform.yml. The two drifted: 21 paths the
// platform workflow considers installer-sensitive were missing here, including
// scripts/install.ps1, src/core/install-integrity.ts, scripts/postinstall-guard.cjs
// and bin/cli-jaw.ts. A change touching only scripts/install.ps1 therefore
// reached the npm `latest` dist-tag with zero platform CI evidence behind it.
//
// The workflow is now the single source of truth: its trigger paths are parsed
// at runtime and unioned with a short, explicitly justified extras list below.
// ---------------------------------------------------------------------------

const PLATFORM_WORKFLOW_PATH = '.github/workflows/postinstall-platform.yml';

// The platform workflow's trigger paths answer "does Postinstall Platform
// Checks need to run?". These extra entries answer the wider release question
// "does this change need fresh-machine install evidence?", and are deliberately
// NOT in that workflow because none of them changes what the platform matrix
// would execute.
const EXTRA_SENSITIVE_PATHS = [
  // The four READMEs carry the copy-pasteable install instructions users
  // actually run. Editing them cannot change platform CI behaviour, but it can
  // absolutely break a fresh install, so release evidence is still required.
  'README.md',
  'README.ko.md',
  'README.ja.md',
  'README.zh-CN.md',
  // The release drivers themselves: they build, gate, tag, push and publish the
  // artifact users install. They are not part of the installed surface the
  // platform matrix exercises, so they do not belong in the workflow triggers,
  // but a change to either one changes how a release is produced.
  'scripts/promote-to-main.sh',
  'scripts/release-preview.sh',
];

/**
 * Minimal, deliberately strict reader for a GitHub Actions trigger `paths:`
 * block.
 *
 * This script runs in .github/workflows/publish.yml BEFORE `npm ci`, so no
 * dependency (including the `yaml` package already in package.json) is
 * importable here. Hence a hand-rolled reader.
 *
 * It is strict on purpose: every unexpected shape throws. A detector that
 * silently degrades to a short or empty path list fails OPEN, which is strictly
 * worse than the drift bug it replaces.
 */
function parseWorkflowTriggerPaths(source, eventName) {
  const fail = (message) => {
    throw new Error(`${PLATFORM_WORKFLOW_PATH}: ${message} (on.${eventName}.paths)`);
  };
  const lines = source.split(/\r?\n/);
  const ignorable = (line) => line.trim() === '' || line.trim().startsWith('#');
  const indentOf = (line) => /^ */.exec(line)[0].length;

  // Locate the top-level `on:` mapping. Note YAML 1.1 would fold a bare `on`
  // key to the boolean `true`; GitHub keeps it literal, and so do we.
  const onIndex = lines.findIndex((line) => line === 'on:');
  if (onIndex === -1) fail('no top-level `on:` block found');

  const blockEnd = (startIndex, parentIndent) => {
    for (let i = startIndex; i < lines.length; i += 1) {
      if (ignorable(lines[i])) continue;
      if (lines[i].startsWith('\t')) fail(`tab indentation on line ${i + 1}`);
      if (indentOf(lines[i]) <= parentIndent) return i;
    }
    return lines.length;
  };

  const findSoleKey = (from, to, key, minIndent) => {
    const hits = [];
    for (let i = from; i < to; i += 1) {
      if (ignorable(lines[i])) continue;
      if (lines[i].trim() !== `${key}:`) continue;
      if (indentOf(lines[i]) <= minIndent) continue;
      hits.push(i);
    }
    if (hits.length === 0) fail(`no \`${key}:\` key found`);
    if (hits.length > 1) fail(`expected exactly one \`${key}:\` key, found ${hits.length}`);
    return hits[0];
  };

  const onEnd = blockEnd(onIndex + 1, 0);
  const eventIndex = findSoleKey(onIndex + 1, onEnd, eventName, 0);
  const eventIndent = indentOf(lines[eventIndex]);
  const eventEnd = blockEnd(eventIndex + 1, eventIndent);
  const pathsIndex = findSoleKey(eventIndex + 1, eventEnd, 'paths', eventIndent);
  const pathsIndent = indentOf(lines[pathsIndex]);

  const collected = [];
  for (let i = pathsIndex + 1; i < eventEnd; i += 1) {
    const line = lines[i];
    if (ignorable(line)) continue;
    if (line.startsWith('\t')) fail(`tab indentation on line ${i + 1}`);
    const indent = indentOf(line);
    if (indent <= pathsIndent) break;
    const item = /^ *- (.+?) *$/.exec(line);
    if (!item) fail(`unexpected non-list line ${i + 1}: ${JSON.stringify(line)}`);
    let value = item[1];
    const quote = value[0];
    if (quote === "'" || quote === '"') {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        fail(`unterminated quoted entry on line ${i + 1}`);
      }
      value = value.slice(1, -1);
      if (quote === "'") value = value.replace(/''/g, "'");
    } else if (/[#'"]/.test(value)) {
      // Bare scalars with quotes or trailing comments need real YAML rules.
      fail(`entry on line ${i + 1} needs quoting: ${JSON.stringify(item[1])}`);
    }
    if (value === '') fail(`empty entry on line ${i + 1}`);
    // Path matching here is exact string equality (stdin mode) and per-file git
    // comparison (base-ref mode); neither can express a glob. Today no entry
    // uses one. If that changes, refuse loudly instead of quietly under-matching.
    if (/[*?[\]!]/.test(value)) {
      fail(
        `entry on line ${i + 1} uses a glob or negation (${JSON.stringify(value)}); `
        + 'this detector only supports literal paths — teach it globs before adding one',
      );
    }
    collected.push(value);
  }

  if (collected.length === 0) fail('trigger path list is empty');
  return collected;
}

function deriveInstallerSensitivePaths() {
  const workflowFile = path.join(repoRoot, PLATFORM_WORKFLOW_PATH);
  let source;
  try {
    source = fs.readFileSync(workflowFile, 'utf8');
  } catch (error) {
    // Fail closed: an unreadable source of truth must never become an empty
    // sensitive set.
    throw new Error(`cannot read ${PLATFORM_WORKFLOW_PATH}: ${error.message}`);
  }
  // `push` is what actually determines whether platform evidence can exist:
  // publish.yml looks for a successful `--event push` run of this workflow.
  // The pull_request trigger was removed when cross-platform evidence moved
  // to the dev push after merge, so on.push.paths is the whole contract now.
  const pushPaths = parseWorkflowTriggerPaths(source, 'push');
  return [...new Set([...pushPaths, ...EXTRA_SENSITIVE_PATHS])];
}

let installerSensitivePaths;
try {
  installerSensitivePaths = deriveInstallerSensitivePaths();
} catch (error) {
  console.error('[release-evidence-required] FAIL cannot derive installer-sensitive paths');
  console.error(`- ${error.message}`);
  console.error(`- Fix ${PLATFORM_WORKFLOW_PATH} (or this reader) before releasing; refusing to guess.`);
  // Exit 2, not 1: publish.yml treats 1 as "sensitive, require platform run"
  // and anything else as a hard detector failure. A broken source of truth must
  // stop the release outright rather than masquerade as a normal gate hit.
  process.exit(2);
}

function usage() {
  console.log(`Usage: require-release-evidence.mjs [options]

Options:
  --base-ref REF    Compare installer-sensitive files against REF instead of the latest v* tag.
  --changed-files-stdin
                    Read changed file paths from stdin and check whether any are installer-sensitive.
                    Cannot be combined with --base-ref.
  --print-paths     Print the derived installer-sensitive path set as JSON and exit.
  -h, --help        Show this help.

The installer-sensitive path set is derived from the trigger paths of
${PLATFORM_WORKFLOW_PATH}, unioned with EXTRA_SENSITIVE_PATHS in this file.
It is never hand-maintained here.

If installer-sensitive files changed, this script requires:
  CLI_JAW_MACOS_EVIDENCE_DIR=/path/to/macos-evidence
  CLI_JAW_WSL_EVIDENCE_DIR=/path/to/wsl-evidence

Then it runs scripts/verify-release-evidence.mjs before publish/release can continue.
`);
}

let baseRef = '';
let changedFilesStdin = false;
let printPaths = false;
let acceptCiEvidence = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  }
  if (arg === '--print-paths') {
    printPaths = true;
    continue;
  }
  if (arg === '--changed-files-stdin') {
    changedFilesStdin = true;
    continue;
  }
  if (arg === '--accept-ci-evidence') {
    acceptCiEvidence = true;
    continue;
  }
  if (arg === '--base-ref') {
    baseRef = args[++i] || '';
    if (!baseRef) throw new Error('missing value for --base-ref');
    continue;
  }
  throw new Error(`unknown option: ${arg}`);
}

if (baseRef && changedFilesStdin) {
  throw new Error('--changed-files-stdin cannot be combined with --base-ref');
}

if (printPaths) {
  console.log(JSON.stringify(installerSensitivePaths, null, 2));
  process.exit(0);
}

function readChangedFilesFromStdin() {
  const input = fs.readFileSync(0, 'utf8');
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
}

function git(args, options = {}) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false,
  });
}

function requireGit(args, label) {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function isGitRepo() {
  return git(['rev-parse', '--is-inside-work-tree']).status === 0;
}

function currentPackageVersionTag() {
  const packageJson = workingTreeFile('package.json');
  if (!packageJson) return '';
  try {
    const version = JSON.parse(packageJson).version;
    return typeof version === 'string' && version ? `v${version}` : '';
  } catch {
    return '';
  }
}

function latestVersionTag() {
  const result = git(['tag', '--sort=-v:refname']);
  if (result.status !== 0) return '';
  const currentTag = currentPackageVersionTag();
  const tags = result.stdout
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag));
  return tags.find((tag) => tag !== currentTag) || '';
}

function gitFile(ref, relativePath) {
  const result = git(['show', `${ref}:${relativePath}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function workingTreeFile(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizePackageJson(content) {
  const parsed = JSON.parse(content);
  delete parsed.version;
  return stableStringify(parsed);
}

function normalizePackageLock(content) {
  const parsed = JSON.parse(content);
  delete parsed.version;
  if (parsed.packages?.['']) {
    delete parsed.packages[''].version;
  }
  return stableStringify(parsed);
}

function normalizeForEvidence(relativePath, content) {
  if (content === null) return null;
  if (relativePath === 'package.json') return normalizePackageJson(content);
  if (relativePath === 'package-lock.json') return normalizePackageLock(content);
  return content.replace(/\r\n/g, '\n');
}

function changedInstallerFiles(ref) {
  const changed = [];
  for (const relativePath of installerSensitivePaths) {
    const before = normalizeForEvidence(relativePath, gitFile(ref, relativePath));
    const after = normalizeForEvidence(relativePath, workingTreeFile(relativePath));
    if (before !== after) {
      changed.push(relativePath);
    }
  }
  return changed;
}

function shortHash(files) {
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
}

if (changedFilesStdin) {
  const inputFiles = readChangedFilesFromStdin();
  const matched = inputFiles.filter((file) => installerSensitivePaths.includes(file));
  if (matched.length === 0) {
    console.log('[release-evidence-required] SKIP no installer-sensitive paths in stdin');
    process.exit(0);
  }
  // Distinguish workflow-trigger changes (need platform CI) from extra-only changes.
  // Exit 1 = platform CI required, exit 3 = sensitive but platform CI not triggered.
  const workflowPaths = installerSensitivePaths.filter((p) => !EXTRA_SENSITIVE_PATHS.includes(p));
  const workflowMatched = matched.filter((file) => workflowPaths.includes(file));
  console.error(`[release-evidence-required] CHANGED installer-sensitive files (${matched.length}, ${shortHash(matched)})`);
  for (const file of matched) {
    const isExtra = EXTRA_SENSITIVE_PATHS.includes(file) && !workflowPaths.includes(file);
    console.error(`- ${file}${isExtra ? ' (release-driver only, no platform CI trigger)' : ''}`);
  }
  if (workflowMatched.length === 0) {
    console.error('[release-evidence-required] all changed files are release-driver extras, not installer surface');
    console.error('[release-evidence-required] platform CI is not required for these changes');
    process.exit(3);
  }
  process.exit(1);
}

if (!isGitRepo()) {
  console.error('[release-evidence-required] FAIL');
  console.error('- Cannot determine installer-sensitive changes outside a git checkout.');
  console.error('- Publish from the release checkout, or run scripts/verify-release-evidence.mjs manually before packaging.');
  process.exit(1);
}

const ref = baseRef || latestVersionTag();
if (!ref) {
  console.error('[release-evidence-required] no previous v* tag found; treating release as installer-sensitive');
}
if (ref) {
  requireGit(['rev-parse', '--verify', `${ref}^{commit}`], `base ref ${ref}`);
}

const changed = ref ? changedInstallerFiles(ref) : installerSensitivePaths;
if (!changed.length) {
  console.log(`[release-evidence-required] SKIP no installer-sensitive changes since ${ref}`);
  process.exit(0);
}

const macosEvidence = process.env.CLI_JAW_MACOS_EVIDENCE_DIR || process.env.MACOS_EVIDENCE_DIR || '';
const wslEvidence = process.env.CLI_JAW_WSL_EVIDENCE_DIR || process.env.WSL_EVIDENCE_DIR || '';
// Optional third lane (#384): native Windows evidence. WSL is a Linux
// userland, so WSL evidence proves nothing about win32. The lane is optional
// until the ps1 collector and auditor target support land.
const windowsEvidence = process.env.CLI_JAW_WINDOWS_EVIDENCE_DIR || process.env.WINDOWS_EVIDENCE_DIR || '';

console.error(`[release-evidence-required] installer-sensitive changes detected since ${ref || '(initial release)'} (${changed.length}, ${shortHash(changed)})`);
for (const file of changed.slice(0, 30)) {
  console.error(`- ${file}`);
}
if (changed.length > 30) {
  console.error(`- ... ${changed.length - 30} more`);
}

if (!macosEvidence || !wslEvidence) {
  // Option A from #355: accept CI postinstall-platform pass as equivalent evidence.
  if (acceptCiEvidence) {
    const headSha = requireGit(['rev-parse', 'HEAD'], 'resolve HEAD for CI evidence');
    console.log(`[release-evidence-required] checking CI postinstall-platform for ${headSha.slice(0, 12)}...`);
    const ciCheck = spawnSync('gh', [
      'run', 'list',
      '--workflow', 'postinstall-platform.yml',
      '--commit', headSha,
      '--status', 'success',
      '--limit', '1',
      '--json', 'url',
      '--jq', '.[0].url // ""',
    ], { cwd: repoRoot, encoding: 'utf8', shell: false });
    // No --event filter, mirroring bc7c19ba which already made publish.yml
    // accept any-event Postinstall Platform Checks. A merge commit whose diff
    // is empty (e.g. main merged back into preview after a promotion) never
    // produces a push run for its own SHA, so requiring the push event made
    // this gate unpassable for exactly the SHA a promotion certifies. Any
    // successful run of the pinned workflow on this commit is the same
    // evidence regardless of the event that started it.
    const ciUrl = (ciCheck.stdout || '').trim();
    if (ciUrl) {
      console.log(`[release-evidence-required] PASS CI postinstall-platform evidence: ${ciUrl}`);
      process.exit(0);
    }
    console.error('[release-evidence-required] no successful postinstall-platform CI run found for this SHA');
    console.error('Falling back to local evidence requirement.');
  }
  console.error('[release-evidence-required] FAIL');
  console.error('Strict fresh-machine evidence is required before git push or npm publish.');
  console.error('Set both variables and rerun:');
  console.error('  CLI_JAW_MACOS_EVIDENCE_DIR=/path/to/macos-evidence');
  console.error('  CLI_JAW_WSL_EVIDENCE_DIR=/path/to/wsl-evidence');
  console.error('Then verify with:');
  console.error('  node scripts/verify-release-evidence.mjs --macos "$CLI_JAW_MACOS_EVIDENCE_DIR" --wsl "$CLI_JAW_WSL_EVIDENCE_DIR"');
  process.exit(1);
}

const gate = path.join(__dirname, 'verify-release-evidence.mjs');
const gateArgs = [gate, '--macos', macosEvidence, '--wsl', wslEvidence];
if (windowsEvidence) gateArgs.push('--windows', windowsEvidence);
const result = spawnSync(process.execPath, gateArgs, {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('[release-evidence-required] PASS strict fresh-machine release evidence');
