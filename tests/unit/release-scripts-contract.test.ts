import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('electron-builder copies the sidecar node_modules through its own filtered resource set', () => {
    const config = parse(read('electron/electron-builder.yml')) as {
        extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
    };
    const resources = config.extraResources ?? [];
    const sidecar = resources.find(resource => resource.from === 'sidecar/server');
    const dependencies = resources.find(resource => resource.from === 'sidecar/server/node_modules');
    const expectedFilters = ['**/*', '!**/*.ts', '!**/*.map', '!**/test*', '!**/.cache'];

    assert.deepEqual(sidecar?.filter, expectedFilters, 'the general sidecar copy must retain its release exclusions');
    assert.equal(dependencies?.to, 'server/node_modules', 'production dependencies must be restored at the packaged runtime path');
    assert.deepEqual(dependencies?.filter, expectedFilters,
        'the explicit dependency copy must retain the same source/map/test/cache exclusions');
});

test('desktop release workflow uploads OS matrix artifacts only after GitHub release publication', () => {
    const workflow = read('.github/workflows/desktop-release.yml');
    const workflowConfig = parse(workflow) as {
        jobs?: Record<string, {
            strategy?: { matrix?: { include?: Array<Record<string, string>> } };
            steps?: Array<{ name?: string; run?: string }>;
        }>;
    };
    const desktopJob = workflowConfig.jobs?.['desktop-release'];
    const matrix = desktopJob?.strategy?.matrix?.include ?? [];
    const steps = desktopJob?.steps ?? [];

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
    for (const [platform, script] of Object.entries({
        macos: 'check:electron-dist-mac-smoke',
        windows: 'check:electron-dist-win-smoke',
        linux: 'check:electron-dist-linux-smoke',
    })) {
        const row = matrix.find(candidate => candidate['platform'] === platform);
        assert.equal(row?.['sidecar_smoke_script'], script, `${platform} must map to its packaged sidecar smoke`);
    }
    assert.ok(workflow.includes('Verify packaged app has no JWC payload'), 'desktop workflow must verify packaged app excludes JWC before upload on every OS');
    assert.ok(workflow.includes('npm run ${{ matrix.sidecar_check_script }}'), 'desktop workflow must run the OS-specific final sidecar verifier');
    const smokeAt = steps.findIndex(step => step.name === 'Smoke packaged sidecar');
    assert.ok(smokeAt >= 0, 'desktop workflow must launch the copied sidecar before upload on every OS');
    assert.equal(steps[smokeAt]?.run, 'npm run ${{ matrix.sidecar_smoke_script }}',
        'desktop workflow must run the matrix-selected packaged sidecar smoke');
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
    assert.ok(workflow.includes('--config.mac.notarize=true --config.dmg.sign=true --publish never'), 'macOS packaging must request notarization and a signed DMG without publishing behind the release uploader');
    assert.ok(workflow.includes('- name: Notarize and staple macOS disk image'), 'the downloadable DMG must be notarized and stapled, not only the app inside it');
    assert.ok(workflow.includes('run: node scripts/notarize-mac-dmg.mjs'), 'DMG notarization must use the audited helper that also repairs DMG metadata');
    assert.ok(workflow.includes('npm run verify:mac-dmg'), 'the notarized DMG must be verified before upload');
    assert.ok(
        workflow.indexOf('Remove temporary macOS signing keychain') < workflow.indexOf('- name: Notarize and staple macOS disk image')
            && workflow.indexOf('- name: Notarize and staple macOS disk image') < workflow.indexOf('Verify macOS update metadata and payload integrity'),
        'DMG notarization runs after signing credentials are removed and before metadata verification',
    );
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
    for (const uploadName of ['Upload build artifacts (manual run)', 'Upload desktop assets to release']) {
        const uploadAt = steps.findIndex(step => step.name === uploadName);
        assert.ok(uploadAt > smokeAt, `packaged sidecar smoke must pass before ${uploadName}`);
    }
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

test('release entry points and branch triggers follow dev policy', () => {
    const wrapper = read('scripts/release-preview.sh');
    assert.match(wrapper, /exec .*release\.sh.*--preview/);
    const stub = read('scripts/promote-to-main.sh');
    assert.ok(stub.includes('bash scripts/release.sh --preview'));
    const testWorkflow = parse(read('.github/workflows/test.yml'));
    const platformWorkflow = parse(read('.github/workflows/postinstall-platform.yml'));
    const pages = parse(read('.github/workflows/pages.yml'));
    assert.deepEqual(testWorkflow.on.push.branches, ['dev']);
    assert.deepEqual(platformWorkflow.on.push.branches, ['dev']);
    assert.deepEqual(pages.on.push.branches, ['dev']);
    const files = ['scripts/install.sh', 'scripts/install-wsl.sh', 'scripts/install.ps1',
        'scripts/windows-support-contract.json', 'README.md', 'README.ko.md', 'README.ja.md',
        'README.zh-CN.md', 'docs/index.html', 'docs/windows.html'];
    for (const file of files) {
        const text = read(file);
        assert.doesNotMatch(text, /raw\.githubusercontent\.com\/lidge-ai\/cli-jaw\/(main|preview)\//, file);
        assert.ok(text.includes('/cli-jaw/dev/'), `${file} must use dev URLs`);
    }
    assert.ok(read('scripts/install.sh').includes('/cli-jaw/dev/scripts/install.sh'));
    assert.ok(read('scripts/install-wsl.sh').includes('/cli-jaw/dev/scripts/install-wsl.sh'));
    assert.ok(read('scripts/collect-fresh-install-evidence.sh').includes('INSTALL_REF="${CLI_JAW_INSTALL_REF:-dev}"'));
});

test('publish notes disclose desktop signing and first signed DMG migration', () => {
    const publish = read('.github/workflows/publish.yml');
    assert.ok(publish.includes('Developer ID signed'));
    assert.ok(publish.includes('Apple-notarized and stapled'));
    assert.ok(publish.includes('Windows: artifacts remain unsigned'));
    assert.ok(publish.includes('Existing unsigned installs must install this first signed DMG manually once'));
});
