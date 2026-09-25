/**
 * The one place that says why a test file can skip, and whether CI is allowed
 * to accept that skip (#689).
 *
 * Skips were not the problem on their own. The problem was that nobody could
 * tell an intentional local affordance from a test that had quietly stopped
 * running: tests/run.mts counts failures and never skips, so a file that opts
 * out is indistinguishable from one that passed. Writing the reason down is
 * half of it; the other half is tests/integration/skip-policy.test.ts, which
 * fails when a file skips without appearing here and when an entry here no
 * longer matches a real skip.
 *
 * Policies:
 *   ci-required        the dependency EXISTS on the CI lane that runs this
 *                      file, so a skip there is a bug. The skip is a local
 *                      affordance and the file must fail closed under CI.
 *   local-skip-allowed the dependency is genuinely optional; skipping is fine
 *                      anywhere, including CI.
 *   opt-in-isolated    needs a flag, a credential or a host CI does not have.
 *                      Intentionally quarantined; see the note for what would
 *                      have to change to make it required.
 *   platform           the skip is an OS or architecture gate. It runs on the
 *                      lane that has that platform and skips on the others,
 *                      which is correct rather than a gap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type SkipPolicy = 'ci-required' | 'local-skip-allowed' | 'opt-in-isolated' | 'platform';

export interface SkipEntry {
    file: string;
    why: string;
    policy: SkipPolicy;
}

export const TESTS_ROOT = resolve(import.meta.dirname, '..');

export const SKIP_POLICY: SkipEntry[] = [
    // ── integration ──────────────────────────────────────────────────────────
    {
        file: 'tests/integration/api-smoke.test.ts',
        policy: 'ci-required',
        why: 'Needs the server the integration job starts on TEST_PORT. Already fails closed: a missing server is assert.fail under CI and a skip only on a developer box. This is the pattern the rest of this table is measured against.',
    },
    {
        file: 'tests/integration/graceful-shutdown.test.ts',
        policy: 'ci-required',
        why: 'Needs dist/bin/cli-jaw.js, which the integration job builds with npm run build before this suite. Both a missing dist and a server that will not become healthy are assert/throw under CI; the skip branches are developer-box affordances only.',
    },
    {
        file: 'tests/integration/compact-api-managed.test.ts',
        policy: 'ci-required',
        why: 'Skips when node_modules/.bin/tsx is absent. CI runs npm ci, so tsx is always there and the skip cannot fire; it exists for a checkout without dependencies.',
    },
    {
        file: 'tests/integration/multi-instance.test.ts',
        policy: 'ci-required',
        why: 'Same tsx-presence guard as compact-api-managed, for the same reason and with the same CI expectation.',
    },
    {
        file: 'tests/integration/codex-app-multiplex-activation.test.ts',
        policy: 'opt-in-isolated',
        why: 'Drives a real codex-cli app-server and needs both CLI_JAW_CODEX_APP_ACTIVATION=1 and live Codex credentials, which CI has neither of. The auth-free half of this surface is covered unskipped by tests/integration/codex-app-multiplex-fixture.test.ts; this file stays for the live lane.',
    },
    {
        file: 'tests/integration/agy-print-smoke.test.ts',
        policy: 'opt-in-isolated',
        why: 'Requires JAW_AGY_SMOKE=1 and a working AGY install performing real inference. Making it CI-required would mean paying for a model call on every PR.',
    },
    {
        file: 'tests/integration/windows-ssh-classic.mts',
        policy: 'opt-in-isolated',
        why: 'Needs a reachable Windows sshd named by JAW_WINDOWS_SSH_HOST. Note it is an .mts file, so --scope integration never collects it at all: the skip inside it is not what keeps it out of CI, the extension is.',
    },
    // ── browser and smoke, outside the PR admission path ─────────────────────
    {
        file: 'tests/browser/manager-layout-smoke.test.ts',
        policy: 'opt-in-isolated',
        why: 'Needs a Chrome DevTools endpoint. The browser scope is not part of the integration job, and this file skips rather than failing when the default CDP port refuses a connection.',
    },
    {
        file: 'tests/smoke/native-activity-burst.mts',
        policy: 'opt-in-isolated',
        why: 'Opt-in burst probe behind CLI_JAW_BURST_BROWSER / CLI_JAW_BURST_LABEL. smoke is not a runner scope and the file is .mts, so it is never collected.',
    },
    // ── unit: platform gates ─────────────────────────────────────────────────
    { file: 'tests/unit/npm-registry-smoke.test.ts', policy: 'platform', why: 'Executes the Linux publish workflow Bash step with POSIX npm/sleep stubs on Linux and macOS; native win32 skips this shell-specific harness.' },
    { file: 'tests/unit/electron-jaw-spawn-orphan-kill.test.ts', policy: 'platform', why: 'POSIX process-group semantics; skipped on win32 and run on the Linux shards.' },
    { file: 'tests/unit/restack-pr-script.test.ts', policy: 'platform', why: 'Drives the bash script scripts/restack-pr.sh against temporary git repositories; skipped on win32 and run on the Linux shards.' },
    { file: 'tests/unit/electron-dropped-paths.test.ts', policy: 'platform', why: 'Needs working symlinks; skips where symlink() throws.' },
    { file: 'tests/unit/copilot-models.test.ts', policy: 'platform', why: 'The two fake headless-server cases need a shebang executable; skipped on win32. The parser, missing-binary and live-registry cases run on every lane.' },
    { file: 'tests/unit/file-open-route.test.ts', policy: 'platform', why: 'POSIX-only file-open behaviour; skipped on win32.' },
    { file: 'tests/unit/cli-status-cache.test.ts', policy: 'platform', why: 'A POSIX-only path case skipped on win32; the rest of the file runs on every lane, so the Windows job loses one case rather than the file.' },
    { file: 'tests/unit/default-runtime-migration.test.ts', policy: 'platform', why: 'A POSIX-only path case skipped on win32; the migration itself is asserted on every lane.' },
    { file: 'tests/unit/path-guards.test.ts', policy: 'platform', why: 'A POSIX-only path case skipped on win32; Windows path guarding has its own cases in the windows-* files.' },
    { file: 'tests/unit/retired-runtime-package.test.ts', policy: 'platform', why: 'POSIX-only packaging case; skipped on win32.' },
    { file: 'tests/unit/safe-install.test.ts', policy: 'platform', why: 'POSIX-only install case; skipped on win32.' },
    { file: 'tests/unit/settings-permissions.test.ts', policy: 'platform', why: 'Asserts POSIX mode bits, which Windows does not have.' },
    { file: 'tests/unit/service-artifact.test.ts', policy: 'platform', why: 'Mixed gates: POSIX aliases skipped on win32, and launchd cases that need darwin.' },
    { file: 'tests/unit/launchd-plist.test.ts', policy: 'platform', why: 'Validates a launchd plist with plutil, which only exists on darwin. Nothing on the Linux or Windows lanes can assert this and no fixture substitutes for the real parser.' },
    { file: 'tests/unit/tcc.test.ts', policy: 'platform', why: 'macOS TCC behaviour; skipped everywhere else.' },
    { file: 'tests/unit/pi-capability-readiness.test.ts', policy: 'platform', why: 'Pi readiness cases that depend on POSIX process behaviour; skipped on win32.' },
    { file: 'tests/unit/gyp-python-pick.test.ts', policy: 'platform', why: 'POSIX-only python discovery; the posixOnly helper is test.skip on win32.' },
    { file: 'tests/unit/officecli-powershell-installer.test.ts', policy: 'platform', why: 'Windows-only installer; skipped off win32.' },
    { file: 'tests/unit/windows-spawn-primitives.test.ts', policy: 'platform', why: 'Windows-only spawn primitives; runs on the windows-unit lane.' },
    { file: 'tests/unit/windows-service-lifecycle-honesty.test.ts', policy: 'platform', why: 'Windows-only service lifecycle; runs on the windows-unit lane.' },
    { file: 'tests/unit/windows-installer-shims.test.ts', policy: 'platform', why: 'Windows-only installer shims; runs on the windows-unit lane.' },
    { file: 'tests/unit/windows-native-cli-detect.test.ts', policy: 'platform', why: 'Windows-only CLI detection; the onWindows helper is test.skip off win32.' },
    { file: 'tests/unit/sidecar-bundle-ownership.test.ts', policy: 'platform', why: 'Only meaningful on the platforms that ship a sidecar (darwin arm64/x64, linux x64); skipped elsewhere.' },
    // ── unit: dependency present on the lane that runs them ──────────────────
    { file: 'tests/unit/manager-notes-routes.test.ts', policy: 'ci-required', why: 'Skips without ripgrep. The Linux test shards install it, so the skip is for developer boxes.' },
    { file: 'tests/unit/browser-connection.test.ts', policy: 'ci-required', why: 'Needs the skills_ref submodule, which CI initialises.' },
    { file: 'tests/unit/browser-skill-policy.test.ts', policy: 'ci-required', why: 'Needs skills_ref skill documents, which CI initialises.' },
    { file: 'tests/unit/codex-imagegen-skill.test.ts', policy: 'ci-required', why: 'Reads the imagegen skill document out of the skills_ref submodule, which CI initialises; the skip covers a checkout that has not pulled submodules.' },
    { file: 'tests/unit/desktop-control-skill-contract.test.ts', policy: 'ci-required', why: 'Reads jaw-desktop-control/SKILL.md out of the skills_ref submodule, which CI initialises; the skip covers a checkout without submodules.' },
    { file: 'tests/unit/skill-phase-naming.test.ts', policy: 'ci-required', why: 'Needs skills_ref documents, which CI initialises.' },
    { file: 'tests/unit/search-skill-policy.test.ts', policy: 'ci-required', why: 'Needs the skills_ref search skill and its siblings, which CI initialises.' },
    { file: 'tests/unit/employee-prompt.test.ts', policy: 'ci-required', why: 'Mixed: skills_ref-dependent cases plus two permanently disabled DEPRECATED patch3 cases that are not environment-dependent at all.' },
    { file: 'tests/unit/orc-snapshot-reconnect.test.ts', policy: 'ci-required', why: 'Guards on public/js sources that exist in the repository; the skip is a stale not-yet-created guard.' },
    { file: 'tests/unit/web-refresh-state-recovery.test.ts', policy: 'ci-required', why: 'Same stale guard on public/js sources that are present.' },
    { file: 'tests/unit/help-renderer.test.ts', policy: 'ci-required', why: 'Skips on ERR_MODULE_NOT_FOUND for a help renderer that exists on this branch; a stale guard, not an environment fact.' },
    { file: 'tests/unit/commands-policy.test.ts', policy: 'ci-required', why: 'Same stale ERR_MODULE_NOT_FOUND guard for a policy module that exists.' },
    { file: 'tests/unit/native-repair-lock.test.ts', policy: 'local-skip-allowed', why: 'Skips unless the shipped lock module exposes its __testing surface, which is a property of the build rather than of the host.' },
    { file: 'tests/unit/orchestrator-parsing.test.ts', policy: 'local-skip-allowed', why: 'Permanently disabled: every case is { skip: "DEPRECATED: patch3" }. Not environment-dependent. Recorded so it is visible; reviving or deleting it is a separate decision.' },
];

const SKIP_PATTERNS: RegExp[] = [
    /\bt\.skip\s*\(/,
    /\bctx\.skip\s*\(/,
    /\b(?:test|it|describe)\.skip\b/,
    /[{,]\s*skip\s*[:}]/,
];

/**
 * Comments are stripped first. Two files carry a comment explaining that they
 * deliberately do NOT skip, and counting those as skips would make the registry
 * describe the opposite of what the file does.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            // Helpers and fixtures are machinery, not tests: a guard inside them
            // is the helper's own control flow, not a test opting out.
            if (entry === 'helpers' || entry === 'fixtures' || entry === 'setup' || entry === 'node_modules') continue;
            walk(full, out);
        } else if (entry.endsWith('.test.ts') || entry.endsWith('.mts')) {
            out.push(full);
        }
    }
    return out;
}

/** Test files that contain at least one skip site, as repository-relative paths. */
export function findSkippingFiles(): string[] {
    const files = walk(TESTS_ROOT, []);
    const hits: string[] = [];
    for (const file of files) {
        const source = stripComments(readFileSync(file, 'utf8'));
        if (SKIP_PATTERNS.some(pattern => pattern.test(source))) {
            hits.push('tests/' + relative(TESTS_ROOT, file).split(sep).join('/'));
        }
    }
    return hits.sort();
}
