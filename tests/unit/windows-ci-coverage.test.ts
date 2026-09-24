import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const workflow = yaml.parse(read('.github/workflows/postinstall-platform.yml'));
const nativeJob = workflow.jobs['windows-native'];

/**
 * Windows CI coverage contract (#371).
 *
 * Most win32 branches are exercised on Linux through injected fixtures, which proves
 * the logic but not that the fixtures match the platform. These assertions pin which
 * suites actually execute on a real `windows-2022` runner, and — just as important —
 * that editing those files TRIGGERS the job at all. A suite that runs in a job nothing
 * schedules is not coverage.
 */

/** The path list on the push trigger (pull_request no longer runs this workflow). */
function triggerPaths(): string[] {
    const on = workflow.on ?? workflow[true];   // yaml parses bare `on:` as boolean true
    return [...(on.push?.paths ?? [])];
}

const WINDOWS_CRITICAL_SOURCES = [
    'src/agent/spawn.ts',
    'src/agent/spawn-env.ts',
    'src/agent/stream-text.ts',
    'src/core/windows-launch-spec.ts',
    'src/core/windows-shell-fallback.ts',
    'src/core/windows-bootstrap.ts',
    'src/core/windows-shell.ts',
    'src/core/instance-identity.ts',
    'src/manager/windows-service.ts',
    'scripts/install.ps1',
    'scripts/windows-bootstrap-manifest.json',
];

const WINDOWS_CRITICAL_SUITES = [
    'tests/unit/spawn-env.test.ts',
    'tests/unit/stream-decode-boundary.test.ts',
    'tests/unit/windows-launch-spec.test.ts',
    'tests/unit/windows-shell-fallback.test.ts',
    'tests/unit/windows-bootstrap.test.ts',
    'tests/unit/instance-identity.test.ts',
    'tests/unit/install-ps1-hardening.test.ts',
    'tests/unit/readme-windows-parity.test.ts',
];

type Step = { name?: string; run?: string; shell?: string; if?: unknown; 'continue-on-error'?: unknown };

/** A step that cannot run is not coverage. */
function isLiveStep(step: Step): boolean {
    if (step['continue-on-error'] === true) return false;
    if (step.if === undefined) return true;
    const condition = String(step.if).trim();
    // A listed-but-unreachable step is how coverage disappears while the name stays.
    if (/false/i.test(condition) && !condition.includes('!=')) return false;
    const eventMatch = condition.match(/event_name\s*==\s*'([^']+)'/);
    if (eventMatch && !['push', 'pull_request', 'workflow_dispatch'].includes(eventMatch[1]!)) return false;
    return true;
}

/** Suites named by an ACTUAL test invocation, not by prose or a Write-Host. */
function executedSuites(steps: Step[]): Set<string> {
    const found = new Set<string>();
    for (const step of steps) {
        if (!step.run || !isLiveStep(step)) continue;
        for (const line of step.run.split('\n')) {
            const command = line.trim();
            if (command.startsWith('#')) continue;
            if (/Write-Host|^echo /i.test(command)) continue;
            if (!/\b(tsx|node|npm|npx)\b/.test(command)) continue;
            if (!/--test|tests\/run\.mts/.test(command)) continue;
            for (const suite of WINDOWS_CRITICAL_SUITES) {
                if (command.includes(suite)) found.add(suite);
            }
        }
    }
    return found;
}

/** Positive paths only: a later '!path' exclusion removes coverage GitHub-side. */
function positivePaths(list: string[] = []): Set<string> {
    const included = new Set<string>();
    for (const entry of list) {
        if (entry.startsWith('!')) included.delete(entry.slice(1));
        else included.add(entry);
    }
    return included;
}

test('WCI-001: the native Windows job exists, can schedule, and is not advisory', () => {
    assert.ok(nativeJob, 'a windows-native job must exist');
    // A runner label that does not exist never schedules, so shape is not enough.
    assert.ok(['windows-2022', 'windows-2025', 'windows-latest'].includes(String(nativeJob['runs-on'])),
        `unknown runner label: ${nativeJob['runs-on']}`);
    assert.notEqual(nativeJob['continue-on-error'], true, 'a lane that may fail is not a gate');
    // A job-level `if: ${{ false }}` keeps every step listed while running none.
    assert.ok(isLiveStep(nativeJob as Step), 'the job must not be gated off by a false condition');
});

test('WCI-002: every Windows-critical suite is actually INVOKED, not merely named', () => {
    // Substring matching over raw `run` text passes for `Write-Host "...test.ts"`
    // and for a step disabled by `if: ${{ false }}`. Require a live step whose
    // command line is a real test invocation.
    const executed = executedSuites(nativeJob.steps as Step[]);
    for (const suite of WINDOWS_CRITICAL_SUITES) {
        assert.ok(executed.has(suite), `${suite} must be invoked by a live step on windows-2022`);
    }
});

test('WCI-003: every Windows-critical file triggers the job, with no later exclusion', () => {
    // A trailing `!path` entry silently removes coverage GitHub-side while a
    // membership check still sees the positive entry. push is the only
    // remaining trigger list: pull_request stopped scheduling this workflow
    // when the cross-platform contract moved to the dev push after merge.
    const on = workflow.on ?? workflow[true];
    const included = positivePaths(on.push?.paths as string[]);
    for (const file of [...WINDOWS_CRITICAL_SOURCES, ...WINDOWS_CRITICAL_SUITES]) {
        assert.ok(included.has(file), `${file} is not effectively included in push triggers`);
    }
});

test('WCI-004: both PowerShell lanes run the installer contract as live gates', () => {
    const steps = nativeJob.steps as Step[];
    for (const shell of ['pwsh', 'powershell']) {
        const matching = steps.filter(s =>
            s.shell === shell
            && /install-ps1-contract\.ps1/.test(s.run ?? '')
            && !/Write-Host/i.test(s.run ?? ''),
        );
        assert.ok(matching.length > 0, `no ${shell} step invokes the installer contract`);
        for (const step of matching) {
            assert.notEqual(step['continue-on-error'], true, `the ${shell} contract step must be a gate`);
            assert.ok(isLiveStep(step), `the ${shell} contract step must be reachable`);
        }
    }
});

test('WCI-005: the push trigger carries the Windows-critical set on dev and preview', () => {
    // Cross-platform evidence moved off pull_request: PRs keep the minimal
    // test.yml contract and this workflow produces its matrix on push to dev
    // (post-merge) and preview (release certification). Pin both ends of that
    // policy: the push list covers the set, pull_request is gone entirely.
    const on = workflow.on ?? workflow[true];
    const push = positivePaths(on.push?.paths as string[]);
    for (const file of [...WINDOWS_CRITICAL_SOURCES, ...WINDOWS_CRITICAL_SUITES]) {
        assert.ok(push.has(file), `${file} missing from push triggers`);
    }
    assert.ok(on.push?.branches?.includes('dev'), 'the dev push must carry the post-merge platform evidence');
    assert.ok(on.push?.branches?.includes('preview'), 'preview stays the release-certifying run');
    assert.equal(on.pull_request, undefined, 'pull_request must not trigger the cross-platform matrix');
    // Manual dispatch is the escape hatch when a release needs the lane on demand.
    assert.ok(on.workflow_dispatch !== undefined, 'workflow_dispatch must remain available');
});

// WCI-006: the WSL lane must not sit on the one runner image that makes
// setup-wsl call `wsl.exe --update`.
//
// setup-wsl v7.0.0 reaches that Microsoft endpoint only when every clause holds
// (SetupWsl.kt:420-427): `wslVersion() != 1`, `ImageOS == "win22"`,
// `RUNNER_ARCH == X64`, `RUNNER_ENVIRONMENT == "github-hosted"`. It answered 403
// on one release SHA and hung for thirty minutes on another. Two clauses are
// ours to choose. Dropping to `wsl-version: 1` is the cheaper one and the wrong
// one: it certifies the installer against WSL1 rather than the WSL2 VM users
// run, and src/core/platform-kind.ts cannot tell the two apart, so the evidence
// would weaken while every test stayed green. Leaving win22 is the choice this
// test pins; the wsl-version fallback stays legal but must be explicit.
test('WCI-006: the WSL lane avoids the win22 --update path without weakening to WSL1', () => {
    const job = (workflow.jobs ?? {})['windows-wsl'];
    assert.ok(job, 'windows-wsl job must exist');
    assert.ok(!job['continue-on-error'], 'windows-wsl must stay a blocking gate');

    assert.notEqual(
        job['runs-on'],
        'windows-2022',
        'windows-2022 is the one ImageOS that makes setup-wsl call wsl.exe --update (SetupWsl.kt:420-427)',
    );

    const setup = (job.steps ?? []).find((step: Record<string, unknown>) =>
        String(step?.['uses'] ?? '').startsWith('Vampire/setup-wsl@'));
    assert.ok(setup, 'the WSL lane must still provision through Vampire/setup-wsl');

    // A hang has to die on its own budget. Asserted downward only: raising this
    // is the move this test exists to notice.
    const stepTimeout = setup['timeout-minutes'];
    assert.equal(typeof stepTimeout, 'number', 'Setup WSL needs its own timeout-minutes');
    assert.ok(stepTimeout <= 5, `Setup WSL timeout-minutes must stay <= 5 (got ${stepTimeout})`);

    const jobTimeout = job['timeout-minutes'];
    if (jobTimeout !== undefined) {
        assert.ok(jobTimeout <= 25, `windows-wsl timeout-minutes must stay <= 25 (got ${jobTimeout})`);
    }

    const inputs = (setup['with'] ?? {}) as Record<string, unknown>;
    // `update` upgrades the distribution's apt packages (SetupWsl.kt:253-255);
    // it never governed the kernel call, so it must not be mistaken for the fix.
    assert.notEqual(inputs['update'], true, 'distribution apt upgrade is not the kernel-update switch');

    // The fallback is allowed, but only as a deliberate value. A WSL1 lane that
    // appeared by accident would silently narrow what this gate proves.
    if (inputs['wsl-version'] !== undefined) {
        assert.ok(
            [1, '1'].includes(inputs['wsl-version'] as string | number),
            'wsl-version, if set, is the recorded WSL1 fallback and must be exactly 1',
        );
    }
});
