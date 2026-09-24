// Regression guard for issue #333 gap G1.
//
// scripts/require-release-evidence.mjs decides whether a release needs
// fresh-machine install evidence, and .github/workflows/publish.yml uses the
// same decision to decide whether a successful Postinstall Platform Checks run
// is required before publishing. For a long time the detector carried its OWN
// hand-written copy of the installer-sensitive path list. It drifted from the
// authoritative list in .github/workflows/postinstall-platform.yml by 21 paths,
// so a change touching only scripts/install.ps1 could reach the npm `latest`
// dist-tag with zero platform CI evidence behind it.
//
// The detector now derives its set from the workflow. These tests are the thing
// that stops the drift coming back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const detectorPath = join(repoRoot, 'scripts/require-release-evidence.mjs');
const workflowPath = join(repoRoot, '.github/workflows/postinstall-platform.yml');

const detectorSrc = fs.readFileSync(detectorPath, 'utf8');
const workflowSrc = fs.readFileSync(workflowPath, 'utf8');

/**
 * Independent reader for the workflow's trigger paths.
 *
 * Deliberately NOT the detector's own parser: if the test reused it, a parser
 * bug would agree with itself and the parity assertion would prove nothing.
 */
function workflowTriggerPaths(event: 'push'): string[] {
    const lines = workflowSrc.split(/\r?\n/);
    const eventIndex = lines.findIndex(line => line.trim() === `${event}:` && /^\s+\S/.test(line));
    assert.notEqual(eventIndex, -1, `workflow should declare an on.${event} trigger`);
    const eventIndent = /^ */.exec(lines[eventIndex]!)![0].length;

    let inPaths = false;
    const out: string[] = [];
    for (let i = eventIndex + 1; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (line.trim() === '') continue;
        const indent = /^ */.exec(line)![0].length;
        if (indent <= eventIndent) break;
        if (line.trim() === 'paths:') { inPaths = true; continue; }
        if (!inPaths) continue;
        const item = /^\s+- '(.+)'$/.exec(line);
        if (!item) { inPaths = false; continue; }
        out.push(item[1]!);
    }
    assert.ok(out.length > 0, `should have read on.${event}.paths entries`);
    return out;
}

/** Runs the real detector and returns the set it actually uses. */
function derivedSensitivePaths(): string[] {
    const result = spawnSync(process.execPath, [detectorPath, '--print-paths'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `--print-paths should succeed:\n${result.stderr}`);
    return JSON.parse(result.stdout) as string[];
}

function runDetectorOnChangedFiles(files: string[], cwd = repoRoot) {
    return spawnSync(process.execPath, [detectorPath, '--changed-files-stdin'], {
        cwd,
        input: `${files.join('\n')}\n`,
        encoding: 'utf8',
    });
}

/**
 * Copies the detector into a throwaway tree next to a caller-supplied workflow
 * file, so fail-closed behaviour can be exercised without touching the repo.
 */
function detectorWithWorkflow(workflowContent: string | null): string {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'jaw-path-parity-'));
    fs.mkdirSync(join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(detectorPath, join(dir, 'scripts/require-release-evidence.mjs'));
    if (workflowContent !== null) {
        fs.mkdirSync(join(dir, '.github/workflows'), { recursive: true });
        fs.writeFileSync(join(dir, '.github/workflows/postinstall-platform.yml'), workflowContent);
    }
    return dir;
}

function runIsolatedDetector(workflowContent: string | null) {
    const dir = detectorWithWorkflow(workflowContent);
    try {
        return spawnSync(process.execPath, [join(dir, 'scripts/require-release-evidence.mjs'), '--print-paths'], {
            cwd: dir,
            encoding: 'utf8',
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('G1-parity: every postinstall-platform trigger path is installer-sensitive to the release gate', () => {
    // The pull_request trigger was removed when cross-platform evidence moved
    // to the dev push after merge, so on.push.paths is the whole contract now:
    // every path that can schedule the platform matrix must require evidence.
    const derived = new Set(derivedSensitivePaths());
    const missing = workflowTriggerPaths('push').filter(path => !derived.has(path));
    assert.deepEqual(
        missing,
        [],
        'paths that trigger Postinstall Platform Checks but would NOT require release evidence — '
        + 'these can reach npm with no platform CI behind them',
    );
});

test('G1-parity: the detector does not keep a second hand-written path list', () => {
    assert.ok(
        detectorSrc.includes('parseWorkflowTriggerPaths'),
        'detector must derive its path set from the platform workflow',
    );
    assert.equal(
        /const installerSensitivePaths = \[/.test(detectorSrc),
        false,
        'a literal installerSensitivePaths array is the exact drift bug #333 G1 describes',
    );
    // The extras are allowed, but they must stay a short, justified list rather
    // than a place the workflow list gets re-copied into.
    const extras = /const EXTRA_SENSITIVE_PATHS = \[([\s\S]*?)\n\];/.exec(detectorSrc);
    assert.ok(extras, 'detector should declare EXTRA_SENSITIVE_PATHS');
    const extraEntries = [...extras![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!);
    assert.deepEqual(extraEntries.sort(), [
        'README.ja.md',
        'README.ko.md',
        'README.md',
        'README.zh-CN.md',
        'scripts/promote-to-main.sh',
        'scripts/release-preview.sh',
    ], 'extras beyond the platform workflow must stay deliberate and reviewed');
    assert.ok(extras![1]!.includes('//'), 'each extras entry group must carry a comment explaining why it is here');
});

test('G1-parity: a diff touching only scripts/install.ps1 requires platform evidence', () => {
    // The concrete regression. Before the fix this exited 0 ("SKIP"), which let
    // publish.yml proceed to the npm `latest` dist-tag without a platform run.
    const result = runDetectorOnChangedFiles(['scripts/install.ps1']);
    assert.equal(result.status, 1, `install.ps1 must be installer-sensitive\n${result.stdout}${result.stderr}`);
    assert.ok(result.stderr.includes('scripts/install.ps1'));
});

test('G1-parity: unrelated changes still skip the evidence requirement', () => {
    const result = runDetectorOnChangedFiles(['src/manager/design/store.ts', 'public/js/app.ts']);
    assert.equal(result.status, 0, `unrelated paths must not demand evidence\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes('SKIP'));
});

test('G1-parity: trigger paths contain no globs the detector cannot match', () => {
    // Detection is exact string equality (stdin mode) and per-file git
    // comparison (base-ref mode). Neither can express a glob, so the detector
    // refuses to parse one rather than quietly under-matching.
    const globbed = workflowTriggerPaths('push').filter(path => /[*?[\]!]/.test(path));
    assert.deepEqual(globbed, [], 'add glob support to the detector before adding a glob trigger path');
});

test('G1-parity: an unreadable source of truth fails closed, never to an empty set', () => {
    const missingWorkflow = runIsolatedDetector(null);
    assert.notEqual(missingWorkflow.status, 0, 'a missing platform workflow must not yield a path set');
    assert.equal(missingWorkflow.status, 2, 'detector errors use exit 2; publish.yml treats 1 as "sensitive"');
    assert.ok(missingWorkflow.stderr.includes('cannot derive installer-sensitive paths'));

    const emptied = runIsolatedDetector(workflowSrc.replace(/^ +- '.+'$/gm, ''));
    assert.equal(emptied.status, 2, 'an empty trigger list must be an error, not zero sensitive paths');

    const globbed = runIsolatedDetector(workflowSrc.replace("- 'Dockerfile'", "- 'src/core/**'"));
    assert.equal(globbed.status, 2, 'a glob trigger path must be rejected loudly');
    assert.ok(globbed.stderr.includes('glob'), `expected a glob complaint, got:\n${globbed.stderr}`);

    const truncated = runIsolatedDetector(workflowSrc.replace(/^on:$/m, 'triggers:'));
    assert.equal(truncated.status, 2, 'a workflow with no `on:` block must fail closed');
});
