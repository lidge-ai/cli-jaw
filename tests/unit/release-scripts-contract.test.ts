import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

for (const scriptPath of ['scripts/release-preview.sh']) {
    test(`${scriptPath} pushes the tree it just built, not a same-named local branch`, () => {
        // `git push origin main` pushes the LOCAL main branch, which is not
        // necessarily what was just built, committed and tagged: releases are
        // cut from whatever branch is checked out. Caught with local main
        // sitting at v2.2.7 while the release commit was on dev -- the push
        // would have published a tree three releases old, and the tag would
        // have pointed somewhere else entirely.
        const script = read(scriptPath);
        const branch = 'preview';

        assert.ok(
            new RegExp(`git push(?: --force-with-lease="[^"]+")? origin HEAD:${branch}`).test(script),
            `${scriptPath} must push HEAD to ${branch}, not the local ${branch} ref`,
        );

        // A bare `git push origin <branch>` is only acceptable when the script
        // has already established that HEAD is that branch.
        for (const line of script.split('\n')) {
            const bare = new RegExp(`^\\s*git push origin ${branch}\\s*$`);
            if (!bare.test(line)) continue;
            assert.ok(
                /CURRENT_BRANCH/.test(script),
                `${scriptPath} pushes the bare ${branch} ref without checking the current branch`,
            );
        }
    });

    test(`${scriptPath} validates Electron shell before publishing`, () => {
        const script = read(scriptPath);

        assert.ok(script.includes('run_electron_release_checks'), 'release script must define and call Electron release checks');
        assert.ok(script.includes('npm run check:electron-no-native'), 'release script must keep npm package Electron-free');
        assert.ok(script.includes('npm --prefix electron run typecheck'), 'release script must typecheck Electron shell');
        assert.ok(script.includes('npm --prefix electron run build'), 'release script must build Electron shell');
        assert.ok(script.includes('ELECTRON_RELEASE_NOTES'), 'release script must include Electron status in GitHub release notes');
        assert.ok(script.includes('Desktop / Electron'), 'GitHub release notes must include a Desktop / Electron section');
    });

    test(`${scriptPath} delegates desktop distribution to release-triggered GitHub Actions`, () => {
        const script = read(scriptPath);

        assert.ok(
            script.includes('--with-desktop'),
            'release script must keep --with-desktop as a backward-compatible no-op',
        );
        assert.ok(
            script.includes('GitHub Actions builds desktop assets after release publication'),
            'release script must route desktop assets to GitHub Actions',
        );
        assert.ok(
            script.includes('unsigned'),
            'release notes must disclose that Windows desktop artifacts remain unsigned',
        );
        assert.ok(
            script.includes('Developer ID signed, Apple-notarized and stapled'),
            'release notes must describe the macOS trust state',
        );
        assert.ok(
            !script.includes('xattr -d com.apple.quarantine'),
            'signed and notarized macOS releases must not instruct users to bypass Gatekeeper',
        );
        assert.ok(
            script.includes('Existing unsigned installs must install this first signed DMG manually once'),
            'release notes must explain the one-time trust-chain bootstrap',
        );
        assert.ok(
            !script.includes('npm --prefix electron run dist:mac'),
            'release script must not build desktop installers locally',
        );
        assert.ok(
            !script.includes('DESKTOP_ARTIFACTS'),
            'release script must not collect local desktop artifacts',
        );
        assert.ok(
            script.includes('gh release create'),
            'release script must invoke gh release create',
        );
    });

    test(`${scriptPath} waits for the runs publish.yml gates on before dispatching publish`, () => {
        // publish.yml refuses to publish without a SUCCESSFUL PUSH run of
        // test.yml for the exact release SHA, plus postinstall-platform.yml when
        // the installer surface changed. This script pushes and then dispatches,
        // so without a wait the FIRST dispatch of every preview release fails by
        // construction. v2.4.0-preview (18e6337) needed three: 10:29:13 died on
        // "Require successful Tests for this commit" (Tests still running),
        // 10:37:23 died on "Require platform checks when installer surface
        // changed" (Postinstall still running), 10:38:29 finally published.
        const script = read(scriptPath);
        // Collapse backslash-continuations so the multi-line gh invocations can
        // be matched as the single commands they are.
        const flat = script.replace(/\\\r?\n\s*/g, ' ').replace(/[ \t]+/g, ' ');

        assert.ok(
            flat.includes('gh run list --workflow test.yml --branch preview --commit "$RELEASE_SHA" --event push --status success'),
            'release script must wait for a successful PUSH run of test.yml on the exact release SHA',
        );
        assert.ok(
            flat.includes('gh run list --workflow postinstall-platform.yml --branch preview --commit "$RELEASE_SHA" --event push --status success'),
            'release script must wait for a successful PUSH run of postinstall-platform.yml on the exact release SHA',
        );

        const waitIndex = script.indexOf('Waiting for preview Tests');
        // The real dispatch sits at column 0; the resume hint echoes an indented
        // copy of the same command, which must not be mistaken for it.
        const dispatchIndex = script.indexOf('\ngh workflow run publish.yml --ref preview');
        assert.ok(waitIndex !== -1, 'release script must announce the CI wait');
        assert.ok(dispatchIndex !== -1, 'release script must dispatch publish.yml');
        assert.ok(
            waitIndex < dispatchIndex,
            'release script must wait for release CI BEFORE dispatching publish.yml',
        );

        // Mirrors the two wait loops in scripts/promote-to-main.sh.
        assert.ok(script.includes('deadline=$((SECONDS + 1200))'), 'CI wait must be bounded by the same 1200s deadline as promote-to-main.sh');
        assert.ok(script.includes('while [ "$SECONDS" -lt "$deadline" ]'), 'CI wait must poll against the deadline');
        assert.ok(script.includes('sleep 10'), 'CI wait must poll on the promote-to-main.sh interval');
        assert.ok(
            script.includes('failure|cancelled|timed_out|startup_failure|action_required'),
            'CI wait must abort on a failed conclusion instead of polling to the deadline',
        );
        assert.ok(
            script.includes('[ -n "$PREVIEW_TESTS_URL" ] && break'),
            'CI wait must treat an empty result as "run not created yet" and keep polling',
        );
        assert.ok(
            script.includes('ERROR: origin/preview moved while waiting for release CI'),
            'release script must re-check that preview did not move while waiting',
        );

        // postinstall-platform.yml carries `paths:` filters, so it never runs at
        // all for a SHA that touches no installer-sensitive path. Waiting
        // unconditionally would burn the full deadline on a run that will never
        // exist, so the wait is gated on the same detector publish.yml uses.
        assert.ok(
            flat.includes('node scripts/require-release-evidence.mjs --changed-files-stdin'),
            'platform wait must be decided by the shared installer-sensitive path detector',
        );
        assert.ok(
            script.includes('if [ "$PLATFORM_REQUIRED" = true ]'),
            'platform wait must be conditional, not unconditional',
        );

        assert.ok(
            script.includes('publish_dispatch_hint'),
            'every give-up path must print the exact resume dispatch command',
        );
    });

    test(`${scriptPath} describes the dispatch-triggered publish, not the removed push trigger`, () => {
        const script = read(scriptPath);

        assert.ok(
            !script.includes('runs from \\`.github/workflows/publish.yml\\` on the \\`preview\\` branch'),
            'prerelease body must not claim publish is triggered by the preview branch push',
        );
        assert.ok(
            !script.includes('publish.yml?query=branch%3Apreview'),
            'publish.yml has no push trigger, so a branch-filtered actions URL lists nothing',
        );
        assert.ok(
            script.includes('publish.yml?query=event%3Aworkflow_dispatch'),
            'the workflow link must filter on the dispatch event that actually publishes',
        );
    });
}

test('stable promotion delegates checkout isolation and never auto-rewrites docs', () => {
    const script = read('scripts/promote-to-main.sh');

    assert.ok(script.includes('source "$SCRIPT_DIR/promotion-checkout.sh"'));
    assert.ok(script.includes('prepare_promotion_checkout'));
    assert.ok(script.includes('assert_promotion_checkout_ready_to_push'));
    assert.ok(script.includes('cleanup_promotion_checkout'));
    assert.ok(!script.includes('git worktree add'));
    assert.ok(!script.includes('verify-counts.sh --fix'));
});

test('stable promotion resumes after preview already carries the stable bump', () => {
    // Promoting v2.17.50 left preview at the stable bump and main at its parent:
    // the certification wait gave up before the main push, and re-running was
    // refused by the script's own prerelease check, so the release was finished by
    // hand. The decision is a classifier with fixtures (promotion-state.test.ts);
    // what this test owns is that the script actually routes through it and that
    // resume cannot become a second bump.
    const script = read('scripts/promote-to-main.sh');

    assert.ok(
        script.includes('node scripts/promotion-state.mjs'),
        'promotion must classify the preview state instead of pattern-matching the version inline',
    );
    for (const state of ['prerelease', 'resume', 'already_on_main']) {
        assert.ok(script.includes(state), `promotion must handle the ${state} state`);
    }

    // The bump and the preview push belong to the prerelease path only. On resume
    // the commit already exists and CI has seen it; minting again would replace a
    // certified tree with a same-version copy.
    const resumeBranch = script.slice(script.indexOf('if [ "$RESUME" = true ]; then'), script.indexOf('else', script.indexOf('if [ "$RESUME" = true ]; then')));
    assert.ok(resumeBranch.length > 0, 'promotion must carry an explicit resume branch');
    assert.ok(!resumeBranch.includes('npm version'), 'resume must not re-mint the version bump');
    assert.ok(!resumeBranch.includes('--force-with-lease'), 'resume must not re-push preview');

    // Ordering is the safety property: certification still precedes the main ref
    // update on every path, and main is still never forced.
    assert.ok(
        script.indexOf('wait_for_run test.yml') < script.indexOf('refs/heads/main'),
        'the Tests wait must still precede the main push',
    );
    assert.ok(!/push[^\n]*--force[^-]/.test(script), 'the main push must never use --force');

    // The wait budget used to be a 1200s wall clock covering execution, which is
    // shorter than the 1500s the windows-wsl job alone may take. A run that exists
    // must be waited on for its own lifetime.
    const waiter = script.slice(script.indexOf('wait_for_run() {'), script.indexOf('promote_resume_hint'));
    assert.ok(waiter.includes('discovery_deadline'), 'the deadline must bound discovery, not a running job');
    assert.ok(
        waiter.includes('queued|in_progress'),
        'the waiter must keep polling while a run for this SHA is still live',
    );
    assert.ok(
        /live.*-eq 0/s.test(waiter),
        'a failed conclusion may only be terminal when no live run remains, because cancel-in-progress leaves cancelled rows beside replacements',
    );

    assert.ok(
        script.includes('promote_resume_hint'),
        'giving up after preview moved must tell the operator how to resume',
    );
});

test('stable promotion cleans up its checkout without leaking a remote branch', () => {
    // The old promotion minted codex/promote-<version>-<sha12> on origin, so the
    // trap had to delete it on every abort between push and merge; five such
    // branches leaked before that was fixed. ff promotion never creates a remote
    // branch at all, so the whole failure mode is gone and the trap is back to
    // one job: remove the local checkout.
    const script = read('scripts/promote-to-main.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));

    assert.ok(cleanup.includes('cleanup() {'), 'promotion script must still install a cleanup trap body');
    assert.ok(
        cleanup.includes('if ! cleanup_promotion_checkout "$WORKTREE"; then'),
        'cleanup must keep removing the local promotion checkout',
    );
    assert.ok(
        cleanup.includes('WARNING: failed to clean promotion checkout'),
        'cleanup must keep warning when the local checkout cannot be removed',
    );

    // No remote branch is created, so nothing may try to delete one.
    assert.ok(
        !/git push origin --delete/.test(script),
        'ff promotion creates no remote branch; a delete path would only be able to remove someone else\'s',
    );

    // The trap fires on the very failure it is cleaning up after, so it must not
    // become the thing that decides the exit code.
    assert.ok(
        /cleanup\(\) \{\n  local status=\$\?\n/.test(script),
        'cleanup must capture the original exit status before running anything else',
    );
    assert.ok(cleanup.includes('exit "$status"'), 'cleanup must re-raise the original exit status');

    // Under `set -e` a bare failing command inside the trap aborts the trap and
    // replaces the real exit code, so every fallible cleanup command has to sit
    // in a condition.
    for (const line of cleanup.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !/\bgit /.test(trimmed)) continue;
        assert.ok(
            /^(if|elif) /.test(trimmed),
            `cleanup runs "${trimmed}" outside a condition: under set -e that aborts the trap and rewrites the exit code`,
        );
    }
});

test('stable promotion fast-forwards instead of squashing through a PR', () => {
    // The invariant: main must never gain a commit preview does not have. A PR
    // merge of any kind mints a new SHA and breaks that, which is what forced the
    // realignment step and, through it, the 2.17.13 code loss.
    const script = read('scripts/promote-to-main.sh');

    assert.ok(!script.includes('gh pr create'), 'promotion must not open a PR');
    assert.ok(!script.includes('gh pr merge'), 'promotion must not merge a PR');
    assert.ok(!script.includes('--squash'), 'promotion must not squash');
    assert.ok(
        script.includes('git -C "$WORKTREE" push origin "$PROMOTION_COMMIT:refs/heads/main"'),
        'promotion must fast-forward main onto the certified commit',
    );
    // The promotion commit is written inside the promotion checkout and nowhere
    // else, so a push issued from the main repository cannot find the object it
    // is asked to send. Every push in this script must run with -C "$WORKTREE".
    for (const pushLine of script.split('\n').filter(line => /^\s*(if )?git .*\bpush\b/.test(line))) {
        assert.match(
            pushLine,
            /git -C "\$WORKTREE" push/,
            `promotion push must run from the checkout that holds the commit: ${pushLine.trim()}`,
        );
    }
    // A plain push is what makes "fast-forward only" enforced by git rather than
    // by convention: git refuses a non-ff update on its own.
    assert.ok(
        !/git push[^\n]*--force[^\n]*refs\/heads\/main/.test(script),
        'the main push must never be forced: refusing a non-ff is the actual guarantee',
    );
    assert.ok(
        script.includes('--force-with-lease="refs/heads/preview:$PREVIEW_SHA"'),
        'the preview push must be leased to the certified SHA so a concurrent push is refused, not discarded',
    );

    // The bump has to be certified on preview before main takes it, because that
    // push run is the evidence publish.yml gates on.
    assert.ok(
        script.indexOf('refs/heads/preview"') < script.indexOf('refs/heads/main"'),
        'preview must move first: main takes only what preview CI already certified',
    );
});

test('desktop release workflow uploads OS matrix artifacts only after GitHub release publication', () => {
    const workflow = read('.github/workflows/desktop-release.yml');

    assert.ok(workflow.includes('release:'), 'desktop workflow must be release-triggered');
    assert.ok(workflow.includes('types: [published]'), 'desktop workflow must run only after release publication');
    assert.ok(workflow.includes('workflow_dispatch:'), 'desktop workflow must also support manual release-tag dispatches');
    assert.ok(workflow.includes('release-tag:'), 'manual desktop release dispatch must accept a release tag');
    assert.ok(workflow.includes('upload-release-assets:'), 'manual desktop release dispatch must have an explicit release upload gate');
    assert.ok(!workflow.includes('push:'), 'desktop workflow must not run on git push');
    assert.ok(workflow.includes('macos-latest'), 'desktop workflow must build macOS artifacts');
    assert.ok(workflow.includes('windows-2022'), 'desktop workflow must pin Windows packaging to the VS 2022 runner for node-gyp native rebuilds');
    assert.ok(!workflow.includes('os: windows-latest'), 'desktop workflow must not use the moving windows-latest label for native packaging');
    assert.ok(workflow.includes('ubuntu-latest'), 'desktop workflow must build Linux artifacts');
    assert.ok(workflow.includes('node-version: 24'), 'desktop workflow host Node must match the Node 24 sidecar release line');
    assert.ok(workflow.includes('npm --prefix electron run typecheck'), 'desktop workflow must typecheck Electron shell');
    assert.ok(workflow.includes('npm --prefix electron run build'), 'desktop workflow must build Electron shell');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-mac-no-jwc'), 'desktop workflow must bind macOS to the mac packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-win-no-jwc'), 'desktop workflow must bind Windows to the Windows packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-linux-no-jwc'), 'desktop workflow must bind Linux to the Linux packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('Verify packaged app has no JWC payload'), 'desktop workflow must verify packaged app excludes JWC before upload on every OS');
    assert.ok(workflow.includes('npm run ${{ matrix.sidecar_check_script }}'), 'desktop workflow must run the OS-specific final sidecar verifier');
    assert.ok(workflow.includes('Verify macOS app icons'), 'desktop workflow must validate macOS app icons separately');
    assert.ok(workflow.includes("if: matrix.platform == 'macos'"), 'macOS icon verification must not run on Windows/Linux matrix legs');
    assert.ok(workflow.includes('npm run check:app-icons'), 'desktop workflow must validate app icon assets before uploading macOS artifacts');
    assert.ok(workflow.includes('Package signed and notarized macOS app'), 'desktop workflow must use a dedicated signed macOS packaging step');
    assert.ok(workflow.includes("if: matrix.platform == 'macos'"), 'Apple credentials must be scoped to macOS-only steps');
    assert.ok(workflow.includes('Import Developer ID certificate into temporary keychain'), 'workflow must own certificate import instead of delegating keychain creation to electron-builder');
    assert.ok(workflow.includes('id: mac-keychain'), 'certificate import must expose the owned keychain path to the packaging step');
    assert.ok(workflow.includes('node scripts/import-mac-signing-certificate.mjs import'), 'workflow must use the audited certificate import helper');
    assert.ok(workflow.includes('CSC_KEYCHAIN: ${{ steps.mac-keychain.outputs.keychain }}'), 'electron-builder must use the already-unlocked owned keychain');
    assert.ok(workflow.includes('Remove temporary macOS signing keychain'), 'workflow must remove the signing keychain immediately after packaging');
    assert.ok(workflow.includes("if: always() && matrix.platform == 'macos' && steps.mac-keychain.outputs.keychain != ''"), 'keychain cleanup must also run after a packaging failure');
    assert.ok(workflow.includes('node scripts/import-mac-signing-certificate.mjs cleanup "$MAC_SIGNING_KEYCHAIN"'), 'cleanup must use the same contained helper');
    assert.ok(workflow.includes('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}'), 'workflow must provide notarization credentials only at runtime');
    assert.ok(workflow.includes('EXPECTED_APPLE_TEAM_ID: U9ATA49N28'), 'credential preflight must pin the release signing team');
    assert.ok(workflow.includes('--config.mac.notarize=true --publish never'), 'macOS packaging must request notarization without publishing behind the release uploader');
    assert.ok(
        workflow.includes('npm --prefix electron run ${{ matrix.script }} -- --publish never'),
        'Windows/Linux packaging must not let electron-builder auto-publish merely because CI is detected',
    );
    assert.ok(workflow.includes('Verify Developer ID signature and notarization ticket'), 'signed macOS artifacts must be verified before upload');
    assert.ok(workflow.includes('Verify macOS update metadata and payload integrity'), 'update metadata and ZIP hash must be verified before upload');
    assert.ok(workflow.includes('VERIFY_EXPECTED_TEAM_ID: U9ATA49N28'), 'signature verification must enforce the expected Developer ID team');
    assert.ok(workflow.includes("if: matrix.platform != 'macos'"), 'unsigned packaging must be limited to Windows and Linux');
    assert.ok(workflow.includes('CSC_IDENTITY_AUTO_DISCOVERY: false'), 'Windows/Linux packaging must keep identity discovery disabled');
    assert.ok(workflow.includes('electron/dist/*-mac.yml'), 'desktop release must upload macOS updater channel metadata');
    assert.ok(workflow.includes('electron/dist/*.blockmap'), 'desktop release must upload differential update metadata when generated');
    assert.ok(
        workflow.indexOf('Verify Developer ID signature and notarization ticket') < workflow.indexOf('Upload build artifacts (manual run)'),
        'signature/notarization verification must run before any artifact upload',
    );
    assert.ok(
        workflow.indexOf('Verify macOS update metadata and payload integrity') < workflow.indexOf('Upload build artifacts (manual run)'),
        'update metadata verification must run before any artifact upload',
    );
    const packageBlock = workflow.slice(
        workflow.indexOf('- name: Package signed and notarized macOS app'),
        workflow.indexOf('- name: Package unsigned Windows or Linux app'),
    );
    assert.ok(!packageBlock.includes('CSC_LINK:'), 'raw certificate material must not remain in the packaging environment');
    assert.ok(!packageBlock.includes('CSC_KEY_PASSWORD:'), 'the p12 password must not be reused as electron-builder keychain password');
    assert.ok(!packageBlock.includes('DEBUG:'), 'release packaging must not enable verbose electron-builder logging around credentials');
    assert.ok(
        workflow.indexOf('Import Developer ID certificate into temporary keychain')
            < workflow.indexOf('Package signed and notarized macOS app'),
        'certificate import must precede packaging',
    );
    assert.ok(
        workflow.indexOf('Package signed and notarized macOS app')
            < workflow.indexOf('Remove temporary macOS signing keychain'),
        'keychain cleanup must follow packaging',
    );
    assert.ok(
        workflow.indexOf('Remove temporary macOS signing keychain')
            < workflow.indexOf('Upload build artifacts (manual run)'),
        'signing credentials must be removed before any artifact upload',
    );
    assert.ok(workflow.includes('gh release upload'), 'desktop workflow must upload artifacts to the existing release');
    assert.ok(
        workflow.includes('ref: ${{ inputs.release-tag || github.event.release.tag_name || github.ref }}'),
        'manual desktop release dispatch must check out the selected release tag',
    );
    assert.ok(
        workflow.includes("github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.release-tag != '' && inputs.upload-release-assets == true)"),
        'manual desktop release dispatch must upload release assets only when a non-empty tag and explicit upload gate are present',
    );
    assert.ok(
        workflow.includes('TAG_NAME: ${{ inputs.release-tag || github.event.release.tag_name }}'),
        'desktop release upload must use the manual release tag when dispatched',
    );
    assert.ok(workflow.includes('--clobber'), 'desktop workflow reruns must replace stale release assets');
});

test('npm publish workflow uses dev/preview/main branch policy without release retargeting existing versions', () => {
    const workflow = read('.github/workflows/publish.yml');

    assert.ok(!workflow.includes('- master'), 'publish workflow must not bind the removed master branch');
    assert.ok(!workflow.includes('- dev'), 'publish workflow must not publish from the development branch');
    assert.ok(workflow.includes('id-token: write'), 'publish workflow must support npm Trusted Publishing OIDC');
    assert.ok(workflow.includes('latest:main'), 'real latest publishes must run only from main');
    assert.ok(!workflow.includes('latest:master'), 'real latest publishes must not accept master');
    assert.ok(workflow.includes('expected-sha'), 'publish dispatch must require the expected SHA');
    assert.ok(workflow.includes('Verify dispatched SHA'), 'publish workflow must verify the dispatched SHA matches HEAD');
    assert.ok(workflow.includes('Require successful Tests for this commit'), 'publish workflow must require a passing test run for the same commit');
    // test.yml runs on dev too (#521), and every release cycle fast-forwards dev
    // onto the preview head, so one SHA carries runs from both branches. Without
    // the branch filter a dev run certifies a release; without the list scan a
    // newer dev run is selected and discarded, falsely blocking a real release.
    assert.ok(workflow.includes('.headBranch == "preview" or .headBranch == "main"'),
        'the certifying Tests run must come from a release branch, never from dev');
    assert.ok(!workflow.includes('--limit 1 --json databaseId,headSha --jq'),
        'the Tests lookup must scan the run list, not just the newest run');
    assert.ok(workflow.includes('Check registry package version'), 'publish workflow must detect already-published versions');
    assert.ok(workflow.includes('SKIP - cli-jaw@${{ steps.release.outputs.version }} is already published'),
        'publish workflow must skip npm publish when the exact version already exists');
    assert.ok(workflow.includes('gh release view "$tag"'),
        'publish workflow must check for existing GitHub release before create-or-edit');
    assert.ok(workflow.includes('Create GitHub release'), 'publish workflow must create or update a GitHub Release');
    assert.ok(workflow.includes('--prerelease'), 'preview publishes must create GitHub prereleases');
    assert.ok(workflow.includes('previous_tag='), 'GitHub release notes must derive the previous tag automatically');
    assert.ok(workflow.includes('git rev-list "$previous_tag"..HEAD --count'), 'GitHub release notes must include commit count');
    assert.ok(workflow.includes("git log \"$previous_tag\"..HEAD -n 80 --pretty=format:'- %s' --no-merges"),
        'GitHub release notes must include commit subjects');
    assert.ok(workflow.includes('**Previous**:'), 'GitHub release notes must include a Previous line');
    assert.ok(workflow.includes('### Changes'), 'GitHub release notes must include a Changes section');
    assert.ok(workflow.includes('--target "$GITHUB_SHA"'), 'release edits must retarget the release to the current publish commit');
    assert.ok(workflow.includes('notes-file'), 'GitHub releases should be created from a structured notes file');
});

test('release branch policy is reflected in CI workflows, release script, installers, and public docs', () => {
    const testWorkflow = read('.github/workflows/test.yml');
    const postinstallWorkflow = read('.github/workflows/postinstall-platform.yml');
    const pagesWorkflow = read('.github/workflows/pages.yml');
    const releaseScript = read('scripts/promote-to-main.sh');
    const installScript = read('scripts/install.sh');
    const installWslScript = read('scripts/install-wsl.sh');
    const collectorScript = read('scripts/collect-fresh-install-evidence.sh');
    const readmes = [
        read('README.md'),
        read('README.ko.md'),
        read('README.ja.md'),
        read('README.zh-CN.md'),
    ].join('\n');
    const docs = [
        read('docs/index.html'),
        read('docs/windows.html'),
    ].join('\n');

    // Every branch assertion below is STRUCTURAL: it reads the push-trigger
    // branch list rather than searching the file for a substring, so neither a
    // comment mentioning a branch nor a path entry that happens to look like
    // one can satisfy it.
    const pushBranches = (workflow: string): Set<string> => {
        const on = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('pull_request:'));
        const fromBranches = on.slice(on.indexOf('branches:'));
        const pathsAt = fromBranches.indexOf('paths:');
        const list = pathsAt >= 0 ? fromBranches.slice(0, pathsAt) : fromBranches;
        return new Set([...list.matchAll(/^\s*- ([A-Za-z0-9._/-]+)$/gm)].map(match => match[1]!));
    };

    const testBranches = pushBranches(testWorkflow);
    const platformBranches = pushBranches(postinstallWorkflow);

    for (const [name, branches] of [['test.yml', testBranches], ['postinstall-platform.yml', platformBranches]] as const) {
        assert.ok(branches.has('preview'), `${name} must run on preview`);
        assert.ok(!branches.has('master'), `${name} must not run on removed master`);
    }

    // M0 (b029c67d5) barred '- dev' from both workflows because dev is not a
    // release branch. It still is not — publish.yml accepts a certifying run only
    // from preview/main, and promote-to-main.sh pins --branch preview. What M0
    // also cost was any CI at all for dev HEAD, which is how a241c6222 came to
    // carry live product code with zero check-runs (#521). So test.yml — and only
    // test.yml — now runs on dev.
    assert.ok(testBranches.has('dev'),
        'test.yml must run on dev so dev HEAD is never unverified (#521)');
    assert.ok(!platformBranches.has('dev'),
        'installer-surface certification never runs on dev');

    // test.yml keeps its main run: branch protection on main requires the
    // ci-aggregate check, and that is the workflow which produces it.
    assert.ok(testBranches.has('main'),
        'test.yml must run on main; branch protection requires its ci-aggregate check there');

    // The platform workflow does NOT. Before #480 promotion squashed preview
    // onto main, minting a NEW commit, so main genuinely had a sha no preview
    // run covered and needed a run of its own. ff promotion ended that: main is
    // now fast-forwarded onto the exact commit preview already certified, so a
    // main push re-ran these jobs against a byte-identical tree. That bought no
    // new signal about the code and doubled the release's exposure to
    // runner-side failure — 729f0dca (`wsl.exe --update` answered 403) and
    // 53eff414 (where.exe hit its discovery budget) both painted main red while
    // the preview run for the SAME sha was green.
    assert.ok(!platformBranches.has('main'),
        'platform certification runs once, on preview; main is the same commit after #480');

    // Dropping that trigger is only safe because every consumer resolves the
    // platform run BY COMMIT. If any of them reverted to a branch filter naming
    // main, the release would demand a run that no longer exists — and it would
    // fail at publish time, after preview had already shipped. These three are
    // the load-bearing half of removing the trigger, so they are asserted here
    // rather than left as a comment.
    const publishWorkflow = read('.github/workflows/publish.yml');
    const platformLookup = publishWorkflow.slice(
        publishWorkflow.indexOf('--workflow postinstall-platform.yml'),
    ).slice(0, 400);
    assert.ok(platformLookup.includes('--commit "$GITHUB_SHA"'),
        'publish.yml must find the platform run by commit, not by branch');
    assert.ok(!platformLookup.includes('--branch'),
        'publish.yml must not filter the platform run by branch: only preview produces one');

    const evidenceScript = read('scripts/require-release-evidence.mjs');
    const evidenceLookup = evidenceScript.slice(
        evidenceScript.indexOf("'postinstall-platform.yml'"),
    ).slice(0, 400);
    assert.ok(evidenceLookup.includes("'--commit', headSha"),
        'release-evidence gate must find the platform run by commit, not by branch');
    assert.ok(!evidenceLookup.includes("'--branch'"),
        'release-evidence gate must not filter the platform run by branch');

    assert.ok(
        releaseScript.includes('wait_for_run postinstall-platform.yml "Postinstall Platform Checks" preview'),
        'promotion must wait for the platform run on preview, the only branch that still produces one',
    );
    assert.ok(pagesWorkflow.includes('branches: [main]'), 'Pages deploy must publish docs from main');
    assert.ok(!pagesWorkflow.includes('branches: [master]'), 'Pages deploy must not depend on master');

    assert.ok(
        releaseScript.includes('git merge-base --is-ancestor "$MAIN_SHA" "$PREVIEW_SHA"'),
        'stable promotion script must verify main is an ancestor of preview',
    );
    assert.ok(
        releaseScript.includes('expected-sha="$MERGED_MAIN_SHA"'),
        'stable promotion script must dispatch publish.yml with exact main SHA',
    );

    assert.ok(installScript.includes('/cli-jaw/main/scripts/install.sh'), 'install.sh usage should use main raw URL');
    assert.ok(installWslScript.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'install-wsl.sh usage should use main raw URL');
    assert.ok(collectorScript.includes('INSTALL_REF="${CLI_JAW_INSTALL_REF:-main}"'), 'fresh evidence collector should default to main');

    assert.ok(readmes.includes('/cli-jaw/main/scripts/install.sh'), 'README install URLs should use main');
    assert.ok(readmes.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'README WSL install URLs should use main');
    assert.ok(readmes.includes('/cli-jaw/main/scripts/collect-fresh-install-evidence.sh'), 'README evidence URLs should use main');
    assert.ok(!readmes.includes('raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/'), 'README files must not point installers at master');
    assert.ok(readmes.includes('branch from `dev`') || readmes.includes('`dev`에서 Fork') || readmes.includes('`dev` から Fork') || readmes.includes('从 `dev` Fork'),
        'contributor guidance should direct branches from dev');

    assert.ok(docs.includes('/cli-jaw/main/scripts/install.sh'), 'landing page install URL should use main');
    assert.ok(docs.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'Windows docs install URL should use main');
    assert.ok(!docs.includes('raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install'), 'static docs must not point installers at master');
});

test('electron-builder scripts stay free of POSIX command substitution', () => {
    // `PYTHON="$(bash ../scripts/pick-gyp-python.sh)"` is a macOS-only guard: it
    // finds a python3 that still has distutils for node-gyp. npm runs scripts
    // through cmd.exe on Windows, which does not expand `$(...)`, so the literal
    // string reached Python as a filename:
    //
    //   PYTHON: can't open file 'D:\a\cli-jaw\cli-jaw\electron\=$(bash ..\scripts\pick-gyp-python.sh)'
    //
    // That failed the Windows job of every desktop release from v2.2.11 onward
    // while macOS and Linux stayed green, so the release itself still looked
    // successful. CI does not need the guard anyway: desktop-release.yml pins
    // actions/setup-python to 3.11 for exactly this reason.
    const electronPkg = JSON.parse(read('electron/package.json')) as { scripts?: Record<string, string> };
    const scripts = electronPkg.scripts ?? {};

    for (const [name, body] of Object.entries(scripts)) {
        if (!name.startsWith('dist:')) continue;

        assert.ok(
            !body.includes('$('),
            `${name} must not use POSIX command substitution: npm runs it through cmd.exe on Windows (got: ${body})`,
        );
    }
});
