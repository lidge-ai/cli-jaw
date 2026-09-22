import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(projectRoot, path), 'utf8'));
}

test('browser URL normalization keeps preview host shorthands and Google search distinct', async () => {
    const { DEFAULT_BROWSER_URL, normalizeBrowserTarget } = await import('../../public/manager/src/browser-panel/browser-url.ts');

    assert.equal(DEFAULT_BROWSER_URL, 'https://www.google.com/');
    assert.equal(normalizeBrowserTarget('localhost:3000'), 'http://localhost:3000');
    assert.equal(normalizeBrowserTarget('myapp.local:5173'), 'http://myapp.local:5173');
    assert.equal(normalizeBrowserTarget('example.com'), 'https://example.com');
    assert.equal(
        normalizeBrowserTarget('한글 검색 test'),
        'https://www.google.com/search?q=%ED%95%9C%EA%B8%80%20%EA%B2%80%EC%83%89%20test',
    );
});

test('Electron desktop build refreshes manager frontend assets before packaging', () => {
    const pkg = read('package.json');

    assert.ok(
        pkg.includes('"electron:dist:mac": "npm run build:frontend && npm run sidecar:bundle && npm --prefix electron run build && CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac && npm run electron:resign:mac && npm run check:electron-dist-mac-no-jwc && npm run check:app-icons"'),
        'electron:dist:mac must rebuild assets, bundle the sidecar, package the shell, and verify the final app before success',
    );
    assert.ok(
        pkg.includes('"sidecar:bundle": "bash scripts/bundle-sidecar.sh darwin arm64"'),
        'sidecar:bundle must assemble the Node.js sidecar for local mac packaging',
    );
    assert.ok(
        pkg.includes('"check:electron-sidecar-no-jwc": "node scripts/check-electron-sidecar-no-jwc.cjs"'),
        'package scripts must expose a staging sidecar no-JWC validator',
    );
    assert.ok(
        pkg.includes('"check:electron-dist-mac-no-jwc": "node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/mac-arm64/cli-jaw.app/Contents/Resources/server"'),
        'package scripts must expose a final macOS app no-JWC validator',
    );
    assert.ok(
        pkg.includes('"check:electron-dist-win-no-jwc": "node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/win-unpacked/resources/server"'),
        'package scripts must expose a final Windows app no-JWC validator',
    );
    assert.ok(
        pkg.includes('"check:electron-dist-linux-no-jwc": "node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/linux-unpacked/resources/server"'),
        'package scripts must expose a final Linux app no-JWC validator',
    );
    assert.ok(pkg.includes('"check:app-icons": "node scripts/check-app-icon-assets.cjs"'), 'package scripts must expose app icon validation');
});

test('Electron sidecar bundle excludes JWC payload and verifies the absence contract', () => {
    const script = read('scripts/bundle-sidecar.sh');
    const pkg = JSON.parse(read('package.json'));

    assert.equal(pkg.dependencies?.jawcode, undefined, 'plain npm installs must not install jawcode by default');
    assert.equal(pkg.optionalDependencies?.jawcode, undefined, 'jawcode must not be optional because optional dependencies install by default');
    assert.ok(script.includes('NODE_VERSION="24.17.0"'), 'sidecar must bundle a Node runtime');
    assert.ok(script.includes('npm ci --omit=dev --ignore-scripts'), 'release sidecar bundle must prefer lockfile-based production installs');
    assert.equal(script.includes('CLI_JAW_LOCAL_JAWCODE'), false, 'sidecar bundle must not have a local jawcode override');
    assert.equal(script.includes('CLI_JAW_ELECTRON_JAWCODE_VERSION'), false, 'sidecar bundle must not have an Electron jawcode install override');
    assert.equal(script.includes('jawcode@$JAWCODE_VERSION'), false, 'Electron sidecar must not install jawcode');
    assert.equal(script.includes('jawcode/sdk'), false, 'Electron sidecar must not import jawcode/sdk during bundling');
    assert.equal(script.includes('bin/jwc'), false, 'Electron sidecar must not create a jwc shim');
    assert.equal(script.includes('../jawcode/packages/jwc'), false, 'release sidecar bundle must not depend on an unpinned sibling jawcode checkout');
    assert.equal(script.includes('npm install --omit=dev --ignore-scripts --install-links'), false, 'sidecar bundle must not rely on linked local file dependencies');
    assert.equal(script.includes('"$SIDECAR_DIR/node_modules/jawcode/"'), false, 'sidecar bundle must not rsync jawcode directly into runtime node_modules');
    assert.ok(script.includes('scripts/check-electron-sidecar-no-jwc.cjs'), 'sidecar bundle must run the no-JWC validator after creating shims');
    // Actual payload rejection is covered by retired-runtime-package.test.ts.
});

test('Electron CLI installer rejects incomplete or partially installed sidecar commands', () => {
    const installCli = read('electron/src/main/lib/install-cli.ts');

    assert.ok(installCli.includes('function findInstallConflicts'), 'installCli must check for pre-existing terminal commands before writing symlinks');
    assert.ok(installCli.includes('Existing CLI commands were not overwritten'), 'installCli must refuse to overwrite existing non-sidecar CLI commands');
    assert.ok(installCli.includes('desktop app can still run from its bundled sidecar'), 'installCli conflict messaging must explain that terminal shims are optional');
    assert.ok(installCli.includes('if (missing.length > 0)'), 'installCli must fail when any sidecar command is missing');
    assert.ok(installCli.includes('Incomplete sidecar bundle'), 'installCli must report incomplete sidecar bundles explicitly');
    assert.ok(installCli.includes('if (failed.length > 0)'), 'installCli must fail when any symlink attempt fails after installation starts');
    assert.ok(installCli.includes('Failed to install CLI links'), 'installCli must not present partial symlink failures as success');
    assert.ok(installCli.includes("const CLI_BINS = ['jaw'] as const"), 'Electron terminal installer must only install jaw');
    assert.ok(installCli.includes("if (!getSidecarBinPath('jaw')) return"), 'install prompt must require the jaw sidecar shim before offering install');
    assert.equal(installCli.includes("getSidecarBinPath('jwc')"), false, 'install prompt must not require jwc');
    assert.equal(installCli.includes('and "jwc"'), false, 'installer copy must not claim jwc is installed');
    assert.ok(installCli.includes("buttons: ['Skip', 'Install']"), 'install prompt must make the non-invasive option first');
    assert.ok(installCli.includes('Existing terminal commands are not overwritten'), 'install prompt must disclose that existing commands are protected');
    assert.ok(installCli.includes("if (response === 1)"), 'install prompt must only install after the explicit Install choice');
    assert.ok(installCli.includes('if (hasDeclinedInstallPrompt()) return'), 'install prompt must not re-ask after the user declined once');
    assert.ok(installCli.includes('rememberDeclinedInstallPrompt()'), 'a Skip choice must be persisted so launches stop prompting');
    assert.ok(installCli.includes('Windows installer PATH entry'), 'Windows packaged installs must explain that NSIS owns PATH setup instead of symlinking');
    assert.equal(installCli.includes('Partial failures:'), false, 'installCli must not append partial failures to an ok:true success message');
});

test('serve command honors persisted dashboard port when no explicit port is passed', () => {
    const serve = read('bin/commands/serve.ts');

    assert.ok(serve.includes('settings, loadSettings'), 'serve command must import settings and loadSettings');
    assert.ok(serve.includes('loadSettings();'), 'serve command must hydrate settings before parseArgs defaults are evaluated');
    assert.ok(
        serve.includes('process.env.PORT || settings.port || \'3457\''),
        'serve command must default to persisted settings.port before falling back to 3457',
    );
});

test('Electron desktop mode hides the browser-only desktop link', () => {
    const desktopLink = read('public/manager/src/desktop-link.tsx');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');

    assert.ok(desktopLink.includes('const inElectron = isElectron()'), 'DesktopLink must read Electron state without changing hook order');
    assert.ok(desktopLink.includes('if (inElectron) return;'), 'DesktopLink effect must skip desktop-status fetch inside Electron');
    assert.ok(desktopLink.includes('if (inElectron) return null;'), 'DesktopLink must render nothing inside Electron');
    assert.ok(desktopBridge.includes('hasDesktopDocumentMarker()'), 'Electron detection must fall back to the preload document marker');
    assert.ok(
        desktopBridge.includes("document.documentElement.dataset.cliJawDesktop === 'true'"),
        'Electron detection must use the preload marker when the bridge object is unavailable',
    );
    assert.ok(desktopBridge.includes('hasDesktopUserAgent()'), 'Electron detection must fall back to the Electron user-agent token');
    assert.ok(desktopBridge.includes('cli-jaw-desktop'), 'Electron detection must use the desktop user-agent token');
});

test('Electron shell stamps manager requests with a desktop user-agent token', () => {
    const main = read('electron/src/main/index.ts');

    assert.ok(main.includes("const DESKTOP_USER_AGENT_TOKEN = 'cli-jaw-desktop'"), 'Electron main must define a stable desktop user-agent token');
    assert.ok(main.includes('mainWindow.webContents.setUserAgent'), 'Electron main must stamp BrowserWindow user-agent before loading manager UI');
    assert.ok(main.includes('app.getVersion()'), 'desktop user-agent token should include the packaged app version');
});

test('Electron app configures macOS Automation metadata and startup priming', () => {
    const main = read('electron/src/main/index.ts');
    const helper = read('electron/src/main/lib/mac-automation-permission.ts');
    const builder = read('electron/electron-builder.yml');
    const entitlements = read('electron/build/entitlements.mac.plist');

    assert.ok(builder.includes('NSAppleEventsUsageDescription'), 'Electron Info.plist must explain AppleEvents usage so macOS can show the Automation prompt');
    assert.ok(builder.includes('afterSign: build/after-sign.mjs'), 'mac packaging must configure the afterSign hook for electron-builder signing runs');
    assert.ok(builder.includes('entitlements: build/entitlements.mac.plist'), 'mac packaging must include AppleEvents entitlements when signing is enabled');
    assert.ok(entitlements.includes('com.apple.security.automation.apple-events'), 'mac entitlements must allow prompting for AppleEvents Automation');
    const afterSign = read('electron/build/after-sign.mjs');
    assert.ok(afterSign.includes("execFileSync('/usr/bin/codesign'"), 'direct afterSign fallback must invoke codesign directly');
    assert.ok(afterSign.includes("'--sign',\n    '-'"), 'direct afterSign fallback must use an ad-hoc signature');
    assert.ok(afterSign.includes('entitlements.mac.plist'), 'direct afterSign fallback must pass the AppleEvents entitlements file');
    assert.ok(main.includes("import { primeMacAutomationPermission } from './lib/mac-automation-permission.js'"), 'Electron main must import the Automation priming helper');
    assert.ok(main.includes('primeMacAutomationPermission({'), 'Electron startup must trigger an AppleEvent so cli-jaw appears in Privacy > Automation');
    assert.ok(main.includes('onBlocked: showAutomationPermissionDialog'), 'Electron startup must show a user-visible dialog when Automation priming cannot complete');
    assert.ok(main.includes('Privacy_Automation'), 'Automation permission dialog must offer a direct System Settings path');
    assert.ok(helper.includes('/usr/bin/osascript'), 'Automation priming must use the macOS AppleScript bridge');
    assert.ok(helper.includes('tell application "System Events"'), 'Automation priming must request System Events control');
    assert.ok(helper.includes('com.google.Chrome'), 'Automation priming should also request Chrome control when Chrome is already running');
    assert.ok(helper.includes('CLI_JAW_SKIP_AUTOMATION_PRIME'), 'Automation priming must remain disableable for tests or support cases');
});

test('Electron permission and clipboard bridges are scoped instead of blanket-denied', () => {
    const main = read('electron/src/main/index.ts');
    const permissions = read('electron/src/main/lib/electron-permissions.ts');
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    const managerCopy = read('public/manager/src/clipboard/copy-text.ts');
    const webCopy = read('public/js/features/copy-text.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');

    assert.ok(main.includes('installDefaultSessionPermissionHandlers()'), 'Electron main must install a central permission matrix');
    assert.ok(main.includes("isElectronPermissionAllowed('embedded-browser-webview'"), 'embedded webviews must stay permission-denied by default');
    assert.ok(permissions.includes('PREVIEW_DENYLIST'), 'permission matrix must define an explicit denylist for trusted manager/preview surfaces');
    assert.ok(permissions.includes('allowed for trusted manager/preview surface'), 'manager/preview surfaces must default to allowing web-platform permission requests');
    assert.ok(permissions.includes("surface === 'embedded-browser-webview'"), 'remote webview permission handling must remain isolated from manager/preview handling');
    assert.ok(preload.includes("ipcRenderer.invoke('clipboard:writeText', text)"), 'preload must expose clipboard writes through IPC');
    assert.ok(preload.includes("ipcRenderer.invoke('permissions:getLastDenials')"), 'preload must expose permission denial diagnostics');
    assert.ok(desktopBridge.includes('clipboard?: ClipboardBridgeApi'), 'renderer desktop bridge must type clipboard IPC');
    assert.ok(desktopBridge.includes('permissions?: PermissionDiagnosticsBridgeApi'), 'renderer desktop bridge must type permission diagnostics IPC');
    assert.ok(managerCopy.includes('getDesktop()?.clipboard'), 'React manager copy helper must prefer Electron clipboard bridge');
    assert.ok(webCopy.includes('cliJawDesktop?.clipboard'), 'classic web copy helper must prefer Electron clipboard bridge');
    assert.ok(!preview.includes('getLastDenials()'), 'preview iframe must not surface noisy permission denial notices to the user');
});

test('Electron quit path shows progress and exits after manager cleanup', () => {
    const main = read('electron/src/main/index.ts');
    const quitProgress = read('electron/src/main/lib/quit-progress.ts');

    assert.ok(main.includes("import { showQuitProgress } from './lib/quit-progress.js'"), 'Electron main must import the quit progress overlay helper');
    assert.ok(main.includes('const QUIT_WINDOW_HIDE_DELAY_MS = 600'), 'quit flow must hide the window quickly if shutdown takes longer than a visible beat');
    assert.ok(main.includes("app.on('before-quit', (event) =>"), 'Cmd+Q must use the coordinated quit path');
    assert.ok(main.includes("void requestApplicationQuit('before-quit')"), 'Cmd+Q must not leave the user staring at a blocked window');
    assert.ok(main.includes('async function requestApplicationQuit'), 'Electron main must centralize app quit coordination');
    assert.ok(main.includes('showQuitProgress(mainWindow, ringBuffer)'), 'quit flow must provide visible progress before manager cleanup');
    assert.ok(main.includes('mainWindow.hide()'), 'quit flow must remove the window if cleanup takes too long');
    assert.ok(main.includes('app.exit(0)'), 'quit flow must exit after cleanup without re-entering before-quit');
    assert.ok(main.includes("void requestApplicationQuit('window-close')"), 'red close button must use the same quit behavior as Cmd+Q');
    assert.ok(quitProgress.includes('cli-jaw-quit-overlay'), 'quit overlay must be injected into the renderer');
    assert.ok(quitProgress.includes('Quitting cli-jaw...'), 'quit overlay must tell the user shutdown is in progress');
    assert.ok(quitProgress.includes('animation: cliJawQuitSpin'), 'quit overlay must include a visible spinner');
});

test('Electron updater stays in the trusted main process and preserves coordinated shutdown', () => {
    const main = read('electron/src/main/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const builder = read('electron/electron-builder.yml');
    const vite = read('electron/electron.vite.config.ts');

    assert.ok(main.includes("from './lib/app-updater.js'"), 'Electron main must own updater lifecycle');
    assert.ok(main.includes('initializeAppUpdater();'), 'updater must initialize before the native menu is built');
    assert.ok(main.includes("label: 'Check for Updates…'"), 'macOS native app menu must expose a manual update check');
    assert.ok(main.includes("await prepareApplicationShutdown('update-install')"), 'update install must await sidecar cleanup');
    assert.ok(main.includes('appUpdaterController?.dispose()'), 'shutdown must dispose updater timers and listeners');
    assert.equal(preload.includes('updater'), false, 'renderer preload must not expose update-source or install control');
    assert.ok(builder.includes('provider: github'), 'packaged update config must use the public GitHub provider');
    assert.ok(builder.includes('owner: lidge-jun') && builder.includes('repo: cli-jaw'), 'update provider must pin repository ownership');
    assert.ok(vite.includes("'electron-updater'"), 'electron-updater must remain an external packaged runtime dependency');
});

test('Electron default launch owns its manager server instead of attaching to web UI', () => {
    const main = read('electron/src/main/index.ts');

    assert.ok(main.includes('const ELECTRON_MANAGER_PORT_START = 24577'), 'Electron implicit manager lane must start at 24577, leaving web/CLI dashboard on 24576');
    assert.ok(main.includes('const ELECTRON_MANAGER_PORT_END = 24590'), 'Electron fallback manager lane must reuse the dashboard fallback upper bound 24590');
    assert.ok(main.includes('const DEFAULT_MANAGER_PORT = ELECTRON_MANAGER_PORT_START'), 'Electron default port must be 24577 through the named lane constant');
    assert.ok(main.includes('managerUrlExplicit'), 'Electron flags must track whether the manager URL was explicitly supplied');
    assert.ok(main.includes('function shouldAttachToExistingManager()'), 'Electron main must make attach mode explicit');
    assert.ok(
        main.includes('return FLAGS.attachOnly || (FLAGS.managerUrlExplicit && !FLAGS.spawn);'),
        'Electron should only attach to an existing manager when attach-only or an explicit manager URL is used',
    );
    assert.ok(main.includes('function isTcpPortAvailable'), 'Electron must check port ownership before spawning its own dashboard');
    assert.ok(main.includes('function normalizeElectronPreferredManagerPort'), 'Electron must normalize implicit spawn preferences into the Electron-only manager lane');
    assert.ok(
        main.includes('if (port >= ELECTRON_MANAGER_PORT_START && port <= ELECTRON_MANAGER_PORT_END) return port;'),
        'Electron may honor preferred ports only inside 24577-24590',
    );
    assert.ok(
        main.includes('return ELECTRON_MANAGER_PORT_START;'),
        'Electron must normalize out-of-range or 24576 preferences back to 24577',
    );
    assert.ok(main.includes('function findAvailableManagerPort'), 'Electron must find a free manager port when the default port is busy');
    assert.ok(
        main.includes('for (let candidate = start; candidate <= ELECTRON_MANAGER_PORT_END; candidate += 1)'),
        'Electron fallback scan must be bounded to 24577-24590 and must not probe 24576',
    );
    assert.equal(main.includes('MAX_MANAGER_PORT_PROBES'), false, 'Electron fallback must not use a probe count that can include 24576');
    assert.ok(
        main.includes('ringBuffer.append(`[manager port] ${MANAGER_URL} is busy; spawning dashboard at ${url}\\n`)'),
        'Electron must log when it avoids a busy web dashboard port',
    );
    assert.ok(!main.includes('const PROBE_PORTS'), 'Electron must not probe and attach to arbitrary web dashboard ports by default');
});

test('Electron window fits within the visible display work area', () => {
    const main = read('electron/src/main/index.ts');

    assert.match(main, /import\s+\{[^}]*\bscreen\b[^}]*\}\s+from 'electron'/, 'Electron main must import screen for work-area sizing');
    assert.ok(main.includes('function getInitialWindowBounds()'), 'Electron main must compute initial bounds before creating BrowserWindow');
    assert.ok(main.includes('screen.getPrimaryDisplay()'), 'initial bounds must use the active display work area');
    assert.ok(main.includes('workArea.height - WINDOW_WORK_AREA_MARGIN'), 'initial height must leave a margin inside the visible work area');
    assert.ok(main.includes('...initialWindowBounds'), 'BrowserWindow must use the clamped work-area bounds');
    assert.ok(main.includes('minHeight: MIN_VISIBLE_WINDOW_HEIGHT'), 'BrowserWindow must keep a sane minimum after fitting to the work area');
});

test('Electron titlebar spacing survives React timing and CSS cascade', () => {
    const preload = read('electron/src/preload/index.ts');
    const compact = read('public/manager/src/manager-p0-1-1.css');
    const reserveMatch = compact.match(/--electron-titlebar-left-reserve:\s*(\d+)px;/);

    assert.ok(preload.includes("document.documentElement.dataset.cliJawDesktop = 'true'"), 'preload must mark the document as cli-jaw Desktop');
    assert.ok(compact.includes(':root[data-cli-jaw-desktop="true"] .command-center.command-bar'), 'desktop titlebar CSS must work from the preload document marker');
    assert.ok(reserveMatch, 'desktop titlebar must define an explicit left reserve for macOS traffic lights');
    assert.ok(Number(reserveMatch[1]) >= 90, 'desktop titlebar left reserve must clear hiddenInset traffic lights');
    assert.ok(
        compact.includes('padding: 0 10px 0 var(--electron-titlebar-left-reserve)'),
        'desktop titlebar padding must consume the explicit traffic-light reserve',
    );
    assert.ok(compact.includes('-webkit-app-region: no-drag'), 'desktop titlebar controls must remain clickable');
    assert.ok(compact.includes('data-window-fullscreen="true"'), 'desktop titlebar CSS must collapse the traffic-light reserve in fullscreen');
    assert.ok(compact.includes('--electron-titlebar-left-reserve: 12px'), 'fullscreen titlebar reserve must collapse to 12px');
    const fullscreenHook = read('public/manager/src/hooks/useWindowFullscreen.ts');
    assert.ok(fullscreenHook.includes('getDesktop()?.window?.getFullscreenState?.()'), 'fullscreen hook must read the optional desktop window bridge');
    assert.ok(preload.includes("ipcRenderer.invoke('window:get-fullscreen')"), 'preload must invoke window:get-fullscreen');
    assert.ok(preload.includes("ipcRenderer.on('window:fullscreen-changed'"), 'preload must listen for window:fullscreen-changed');
    assert.equal(preload.includes('sendSync'), false, 'preload must not use ipcRenderer.sendSync');
});

test('Electron preload bridge avoids unsupported sandbox Node builtins', () => {
    const preload = read('electron/src/preload/index.ts');
    const diffPanel = read('public/manager/src/diff-panel/DiffPanel.tsx');
    const diffRoots = read('public/manager/src/diff-panel/diff-root-candidates.ts');

    assert.ok(!preload.includes('node:os'), 'sandboxed preload must not import node:os because it prevents cliJawDesktop from being exposed');
    assert.ok(preload.includes('contextBridge.exposeInMainWorld'), 'preload must expose cliJawDesktop through contextBridge');
    assert.ok(preload.includes('getHomePath'), 'preload must still provide a home-path bridge helper');
    assert.ok(diffPanel.includes("desktop?.getHomePath?.() || '/tmp'"), 'diff panel must tolerate an empty home path from the sandbox preload');
    assert.ok(diffRoots.includes('projectDirs'), 'diff panel root resolution must prefer selected instance projectDirs before home fallback');
});

test('manager desktop panel toggles are Electron-only and do not open sidebars on web', () => {
    const rail = read('public/manager/src/components/SidebarRail.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const commandBar = read('public/manager/src/components/CommandBar.tsx');
    const controls = read('public/manager/src/components/DesktopPanelControls.tsx');
    const capabilities = read('public/manager/src/panels/panel-capabilities.ts');
    const layout = read('public/manager/src/manager-layout.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(commandBar.includes('<DesktopPanelControls />'), 'CommandBar must host desktop panel toggles near the other titlebar actions');
    assert.ok(controls.includes('const surface = currentManagerSurface();'), 'DesktopPanelControls must use capability-based surface detection');
    assert.ok(controls.includes("if (surface !== 'electron') return null"), 'web UI must not render desktop side/bottom panel controls');
    assert.ok(controls.includes('aria-label="Toggle terminal panel"'), 'DesktopPanelControls must expose the bottom terminal panel toggle');
    assert.ok(controls.includes("panelActions.openBottomTab('terminal')"), 'bottom panel toggle must open the terminal tab when closed');
    assert.ok(controls.includes('aria-label="Toggle right panel"'), 'DesktopPanelControls must expose the right panel toggle');
    assert.ok(controls.includes("panelActions.focusOrCreateFirstRightSidebarTab('files')"), 'right panel toggle must open/focus the Files tab when closed');
    assert.ok(
        router.includes("const isElectron = currentManagerSurface() === 'electron'") && router.includes('const desktopPanelsAvailable = isElectron'),
        'SidebarRailRouter must suppress persisted desktop panel state on web',
    );
    assert.ok(router.includes('rightPanelOpen={rightPanelOpen}'), 'WorkspaceLayout must receive the surface-gated right panel state');
    assert.ok(router.includes('bottomPanelOpen={bottomPanelOpen}'), 'WorkspaceLayout must receive the surface-gated bottom panel state');
    assert.ok(capabilities.includes("folder: capability('folder', 'disabled'"), 'web folder side panel capability must be disabled');
    assert.ok(capabilities.includes("doc: capability('doc', 'disabled'"), 'web document side panel capability must be disabled');
    assert.equal(rail.includes('aria-label="Toggle terminal panel"'), false, 'SidebarRail must not render desktop panel toggles that force a second icon row');
    assert.equal(rail.includes('aria-label="Toggle right panel"'), false, 'SidebarRail must keep right-panel controls out of the left rail');
    assert.ok(layout.includes('display: flex'), 'manager sidebar must allow rail height to grow without clipping its list');
    assert.ok(layout.includes('.manager-sidebar-list { flex: 1 1 auto;'), 'sidebar list must size from remaining space, not a fixed rail height');
    assert.ok(
        compact.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .sidebar-rail {\n    min-height: 54px;'),
        'web manager rail must keep the normal single-line height',
    );
    assert.ok(
        compact.includes(':root[data-cli-jaw-desktop="true"] .dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .sidebar-rail'),
        'Electron should get a desktop-only rail override for panel toggles',
    );
    assert.ok(compact.includes('flex-wrap: nowrap'), 'Electron expanded rail must keep desktop panel toggles on one row');
    assert.ok(compact.includes('flex: 1 1 auto'), 'Electron expanded rail spacer must shrink so utility toggles stay in the same row');
    assert.ok(compact.includes('min-width: 4px'), 'Electron expanded rail spacer must keep a small visual gap without forcing a second row');
    assert.ok(compact.includes('.command-panel-toggle'), 'command bar panel toggles must have distinct visible styling');
});

test('Electron panel shortcuts open usable panels when closed', () => {
    const provider = read('public/manager/src/panels/PanelLayoutProvider.tsx');

    assert.ok(
        provider.includes("else dispatch({ type: 'OPEN_BOTTOM_TAB', tab: 'terminal' })"),
        'toggleBottomPanel shortcut must open a terminal tab when the bottom panel is closed',
    );
    assert.ok(
        provider.includes("dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'files' })"),
        'toggleRightPanel shortcut must open/focus the Files tab when the right panel has no open tabs',
    );
    assert.ok(
        provider.includes("dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'diff' })"),
        'openDiff shortcut must focus-or-create the Diff tab',
    );
    assert.ok(
        !provider.includes('OPEN_RIGHT_PANEL') && !provider.includes('SOLO_RIGHT_SUB'),
        'legacy two-slot right panel actions must stay removed',
    );
    const compact = read('public/manager/src/manager-p0-1-1.css');
    assert.equal(
        compact.includes('flex: 0 0 100%'),
        false,
        'Electron panel spacer must not force panel toggles onto a clipped second rail row',
    );
});

test('Electron right sidebar exposes icon panel switcher and document preview path', () => {
    const types = read('public/manager/src/panels/types.ts');
    const provider = read('public/manager/src/panels/PanelLayoutProvider.tsx');
    const sidebar = read('public/manager/src/panels/RightSidebar.tsx');
    const resizer = read('public/manager/src/panels/PanelResizer.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const folder = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const folderTree = read('public/manager/src/folder-panel/FolderPanelTree.tsx');
    const folderToolbar = read('public/manager/src/folder-panel/FolderPanelToolbar.tsx');
    const folderSources = read('public/manager/src/folder-panel/folder-sources.ts');
    const doc = read('public/manager/src/doc-panel/DocPanel.tsx');
    const browserPanel = read('public/manager/src/browser-panel/BrowserPanel.tsx');
    const browserUrl = read('public/manager/src/browser-panel/browser-url.ts');
    const css = read('public/manager/src/panels/panels.css');
    const layoutCss = read('public/manager/src/manager-layout.css');
    const jawCeoCss = read('public/manager/src/jaw-ceo/jaw-ceo.css');
    const workspace = read('public/manager/src/components/WorkspaceLayout.tsx');
    const browserCss = read('public/manager/src/browser-panel/browser-panel.css');

    assert.ok(types.includes("RightSidebarTabKind = 'files' | 'diff' | 'browser' | 'design'"), 'right sidebar tab kinds must be files, diff, browser, and design (CEO hidden)');
    assert.ok(types.includes("['files', 'diff', 'browser', 'design']"), 'tab kind order must match the launcher/tab order');
    assert.ok(types.includes('FILE_FOLDER_FOLDER_ONLY_THRESHOLD = 0.12'), 'Files split must snap to folder-only below the threshold');
    assert.ok(types.includes('FILE_FOLDER_FILE_ONLY_THRESHOLD = 0.88'), 'Files split must snap to file-only above the threshold');
    assert.ok(!provider.includes('SOLO_RIGHT_SUB') && !provider.includes('SET_RIGHT_BOTTOM_MODE'), 'legacy two-slot reducer surface must stay removed');
    assert.ok(provider.includes('focusOrCreateFirstRightSidebarTab'), 'launcher semantics must focus the first open tab of a kind or create it');
    assert.ok(provider.includes('createRightSidebarTab'), 'the plus menu must create new module instances');
    assert.ok(sidebar.includes('right-launcher-button'), 'right sidebar must render icon launcher buttons');
    assert.ok(sidebar.includes('right-sidebar-tab-strip'), 'right sidebar must render the open tab strip');
    assert.ok(sidebar.includes("aria-label={RIGHT_SIDEBAR_TAB_TITLES[kind]}"), 'launcher icon buttons must keep accessible names');
    assert.ok(sidebar.includes("dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind })"), 'launcher buttons must focus-or-create the first tab of the kind');
    assert.ok(sidebar.includes("dispatch({ type: 'CREATE_RIGHT_SIDEBAR_TAB', kind })"), 'the plus menu must create a new module instance');
    assert.ok(sidebar.includes('const widthRef = useRef(rp.width);'), 'right sidebar resize must accumulate drag deltas outside React render timing');
    assert.ok(sidebar.includes('widthRef.current = width;'), 'right sidebar width ref must update immediately during drag');
    assert.ok(resizer.includes('onDeltaRef.current(delta)'), 'PanelResizer must call the latest delta handler without re-registering native listeners mid-drag');
    assert.ok(resizer.includes('const options: AddEventListenerOptions = { capture: true };'), 'PanelResizer must listen in capture phase so webview/iframe surfaces cannot swallow resize move/up events');
    assert.ok(resizer.includes("window.addEventListener('mouseup', stopDragging, options);"), 'PanelResizer must end drags even when mouseup lands outside the React element');
    assert.ok(css.includes('touch-action: none;'), 'PanelResizer must opt out of touch/browser gestures so resize drags are not intercepted');
    assert.ok(css.includes('-webkit-app-region: no-drag;'), 'PanelResizer must not be treated as an app drag region in Electron');
    assert.ok(css.includes('.panel-resizer-horizontal {\n    width: 24px;'), 'right sidebar horizontal resizer must expose a forgiving edge hit area');
    assert.ok(css.includes('margin: 0 -12px;'), 'horizontal resizer hit area must straddle the panel edge instead of living only inside the right panel');
    assert.ok(css.includes('.panel-resizer-horizontal::after {\n    left: 11px;'), 'horizontal resizer must keep a thin visual divider inside the wider hit area');
    assert.ok(css.includes('.right-panel {\n    grid-area: right;\n    position: relative;'), 'right panel must establish a positioning context for an edge-straddling resize hit area');
    assert.ok(css.includes('overflow: visible;'), 'right panel must not clip the resize hit area outside its left edge');
    assert.ok(layoutCss.includes('.manager-workspace.is-right-panel-open .right-panel {\n    display: flex;\n    flex-direction: row;\n    min-height: 0;\n    overflow: visible;'), 'open right panel layout must preserve the outside resize hit area');
    assert.ok(!sidebar.includes('renderHeaderAction'), 'legacy per-slot header actions must stay removed from the tab chrome');
    assert.ok(sidebar.includes('right-files-toolbar'), 'Files tab must render a one-line toolbar (breadcrumb, load/open, folder toggle)');
    assert.ok(sidebar.includes('right-breadcrumb'), 'Files toolbar must render the active file breadcrumb');
    assert.ok(router.includes('primaryProjectDir = props.selectedInstance?.projectDirs?.[0]?.trim() || null'), 'folder load shortcut must deterministically use the first selected instance project dir');
    assert.ok(sidebar.includes('right-files-load-folder'), 'folder load shortcut must render in the Files toolbar');
    assert.ok(sidebar.includes('불러오기'), 'folder load shortcut must use the approved Korean label');
    assert.ok(router.includes('onLoadProjectFolder={handleLoadPrimaryProjectDir}'), 'router must wire the Files-tab scoped project folder action');
    assert.ok(router.includes('loadProjectFolderDisabled={!primaryProjectDir'), 'folder load shortcut must disable when no project dir exists');
    assert.equal(folderToolbar.includes('불러오기'), false, 'folder load shortcut must not be placed in the lower FolderPanel toolbar row');
    assert.ok(css.includes('.right-files-load-folder'), 'folder load shortcut must have compact toolbar styling');
    assert.ok(sidebar.includes('right-sidebar-tab-close'), 'each open tab must keep an explicit close control');
    assert.ok(sidebar.includes('key={activeTab.id}'), 'switching tabs must remount the visible panel instead of leaving stale content painted');
    assert.ok(router.includes("case 'browser': return <Suspense fallback={fallback}><BrowserPanel"), 'right sidebar must be able to render the browser panel');
    assert.ok(router.includes('singlePage'), 'sidebar Browser modules must render one page per module tab');
    assert.ok(browserPanel.includes('function isUrlAllowed(target: string, desktop: boolean): boolean'), 'browser panel URL policy must be desktop-aware');
    assert.ok(browserPanel.includes('if (desktop) return true;'), 'Electron browser webview must allow local/private preview URLs after http/https validation');
    assert.ok(browserPanel.includes('isRestrictedBrowserHost(parsed.hostname)'), 'web UI browser policy must continue blocking local/private hosts');
    assert.ok(browserPanel.includes('Local, private, and same-origin URLs are blocked.'), 'web UI must keep the explicit local/private URL rejection message');
    assert.ok(browserPanel.includes('const inputRef = useRef<HTMLInputElement | null>(null);'), 'browser Go action must read the visible URL input value for native accessibility value injection');
    // 260902 t3 shell (wp6): the address bar is a reducer (browser-address-state.ts).
    // While focused, live-URL syncs land in liveUrl and never overwrite the draft;
    // Go/Enter submit the draft, so the old editing/draft refs are gone.
    const addressState = read('public/manager/src/browser-panel/browser-address-state.ts');
    assert.ok(addressState.includes("if (state.focused) return { ...state, liveUrl: action.liveUrl };"), 'browser address bar must not overwrite a draft being edited when the live URL changes');
    assert.ok(addressState.includes('export function displayedAddress'), 'browser address bar must render liveUrl when blurred and the draft when focused');
    assert.ok(browserPanel.includes("dispatchAddress({ type: 'sync-live', liveUrl: activeTab.url })"), 'webview navigation must sync the live URL through the reducer');
    assert.ok(browserPanel.includes('const pendingNavigationRefs = useRef<Map<string, string>>(new Map());'), 'browser panel must track pending navigation targets so stale webview events cannot cancel a requested URL');
    assert.ok(browserPanel.includes('function sameBrowserUrl'), 'browser panel must compare pending URLs after URL normalization');
    assert.ok(browserPanel.includes('pendingNavigationRefs.current.set(tabId, target);'), 'opening a URL must mark the requested target as pending before React re-renders the webview');
    assert.ok(browserPanel.includes('if (pendingTarget && !sameBrowserUrl(current, pendingTarget))'), 'stale webview refreshes must not overwrite a pending requested URL');
    assert.ok(browserPanel.includes('const failedUrl = failure.validatedURL ?? failure.url;'), 'old webview load aborts must not clear a different pending target');
    assert.ok(browserPanel.includes('const rawTarget = addressState.focused ? addressState.draft : displayedAddress(addressState);'), 'browser Go action must prefer the user draft while the address bar is focused');
    assert.ok(browserPanel.includes('openUrlInTab(activeTab.id, rawTarget)'), 'browser Go action must not depend only on React change events');
    assert.ok(browserPanel.includes('onMouseDown={event => event.preventDefault()}'), 'Go button must avoid blurring the URL input before click navigation reads it');
    assert.ok(browserUrl.includes("DEFAULT_BROWSER_URL = 'https://www.google.com/'"), 'browser tabs must default to Google instead of example.com');
    assert.ok(browserUrl.includes('GOOGLE_SEARCH_URL'), 'browser URL helper must route search-like input through Google');
    assert.ok(browserUrl.includes('function shouldDefaultToHttp'), 'browser panel must treat localhost/private bare targets as http previews instead of defaulting them to https');
    assert.ok(browserUrl.includes('encodeURIComponent(trimmed)'), 'browser search query URLs must encode Korean and space-containing input safely');
    assert.ok(browserPanel.includes('type BrowserTabState'), 'browser panel must track tab-specific URL/loading/error state');
    assert.ok(browserPanel.includes('browser-tab-strip'), 'browser panel must expose a tab strip for multiple browser tabs');
    assert.ok(browserPanel.includes('aria-label="New browser tab"'), 'browser panel must expose an explicit new-tab control');
    assert.ok(browserPanel.includes('<div key={activeTab.id} className="browser-webview-host is-active">'), 'browser panel must mount only the active Electron webview so hidden guest views cannot leave new tabs blank');
    assert.ok(browserPanel.includes('function embeddedBrowserUserAgent()'), 'browser panel must provide a browser-like user agent for embedded pages');
    assert.ok(browserPanel.includes('useragent: webviewUserAgent.current'), 'Electron webview must avoid the default Electron user agent to reduce site challenge loops');
    assert.ok(browserPanel.includes("webview.addEventListener('render-process-gone'"), 'browser panel must detect crashed/killed webview renderers using Electron current API');
    assert.ok(browserPanel.includes('attachWebviewEvents'), 'browser panel must attach navigation/crash handlers per webview, not only to the currently active tab');
    assert.ok(browserPanel.includes("getDesktop()?.browser?.onOpenUrl"), 'browser panel must accept Electron popup/new-window requests and route them into tabs');
    assert.ok(router.includes('files.activeFilePath'), 'router must read the per-tab active file path for document preview');
    assert.ok(router.includes('function expandDesktopHomePath(path: string): string'), 'right panel doc opens must normalize tilde paths before Electron file reads');
    assert.ok(router.includes("getDesktop()?.getHomePath?.()?.replace(/\\/+$/, '')"), 'tilde expansion must use the Electron home-path bridge');
    assert.ok(
        /const handleRightPreviewFile = useCallback\(\s*\(path: string\): void => \{[\s\S]*?panelDispatch\(\{ type: 'OPEN_FILE_IN_FILES_TAB', path: previewPath \}\);[\s\S]*?\},\s*\[panelDispatch\]\);/.test(router),
        'selecting a file must open it in the Files tab file pane through a memoized handler whose identity does not churn on every panel state change',
    );
    assert.ok(
        /const panelDispatch = panelLayout\.dispatch;/.test(router),
        'the Files-tab open handler must alias the stable reducer dispatch rather than reading it off the per-render context value',
    );
    assert.ok(router.includes('onOpenLocalFile={handleRightPreviewFile}'), 'Code mode local file links must open the shared right DocPanel');
    assert.ok(doc.includes('function HtmlPreview'), 'document preview must render local HTML files in the right panel');
    assert.ok(doc.includes('sandbox=""'), 'HTML preview must not grant scripts or same-origin privileges');
    assert.ok(folder.includes('onPreviewFile'), 'folder panel must expose file selection to the preview panel');
    assert.ok(folder.includes('const onPreviewFile = props.onPreviewFile;'), 'clicking a file in Folders must open it in preview through the selection hook');
    assert.ok(folder.includes('onRootChange'), 'folder panel must report manual root changes back to the owning right sidebar');
    assert.ok(router.includes('SET_FILES_TAB_ROOT'), 'the owning Files tab must persist its own folder root');
    assert.ok(router.includes('onRootChange={path => ctx.onTabRootChange(tab.id, path)}'), 'manual Open Folder must update the owning Files tab root');
    assert.ok(folderSources.includes('getInitialRoot'), 'folder panel source must expose explicit initial root policy');
    assert.ok(folderSources.includes('getInitialRoot: async () => null'), 'Electron FolderPanel must start empty instead of opening an implicit root');
    assert.equal(folderSources.includes('bridge.getDefaultRoot()'), false, 'Electron FolderPanel source must not call getDefaultRoot on initial render');
    assert.ok(folderTree.includes('folder-empty-root'), 'empty FolderPanel must expose a scoped empty-root state');
    assert.ok(folderToolbar.includes('Open Folder'), 'empty FolderPanel toolbar must expose an explicit Open Folder action');
    assert.ok(folderSources.includes('createNotesVaultFolderSource'), 'folder panel must expose a web notes-vault fallback source');
    assert.ok(doc.includes('Open Folders and select a file'), 'empty document preview must explain how to view a file');
    assert.ok(css.includes('.right-launcher-row'), 'right sidebar launcher row must be styled');
    assert.equal(jawCeoCss.includes('@media (max-width: 767px) {\n    .jaw-ceo-console {\n    .jaw-ceo-workbench-button'), false, 'jaw ceo mobile CSS must not leave an open nested selector that swallows following panel CSS');
    assert.ok(css.includes('.right-launcher-button.is-active'), 'active launcher icon must have visible state');
    assert.ok(css.includes('.right-sidebar-tab.is-active'), 'active open tab must have visible state');
    assert.ok(css.includes('.right-sidebar-tab-close'), 'tab close controls must be styled as usable controls');
    assert.ok(css.includes('.right-panel-body.is-single-panel > .right-sub-panel'), 'single right panels must consume the full sidebar height');
    assert.ok(css.includes('.right-sub-panel.has-content-owned-chrome > .right-sub-content'), 'right-side chrome-owned panels must give all vertical space to their own content chrome');
    assert.ok(css.includes('flex: 1 1 0;'), 'single right panel content must not collapse to header height');
    assert.ok(css.includes('.right-sub-content {\n    display: flex;'), 'right sidebar content must pass flex height to nested panels');
    assert.ok(css.includes('height: 100%;'), 'right sub content must pass a stable height to nested panels');
    assert.ok(layoutCss.includes('.manager-workspace.is-right-panel-open .right-panel {\n    display: flex;'), 'open right panel must keep flex display even when responsive workspace CSS has higher specificity');
    assert.ok(layoutCss.includes('.manager-workspace.is-right-panel-open .right-panel-shell {\n    display: flex;'), 'right panel shell must remain a flex column so Browser webview can inherit height');
    assert.ok(layoutCss.includes('.manager-workspace.is-right-panel-open .right-panel-body.is-single-panel {\n    display: flex;'), 'single right panel body must pass remaining height to its active sub-panel');
    assert.ok(layoutCss.includes('.manager-workspace.is-right-panel-open .right-sub-content {\n    display: flex;'), 'right sub content must not regress to block and collapse Browser webview height to zero');
    assert.ok(workspace.includes('clampRightPanelRenderWidth'), 'right panel width must be clamped at render time so persisted large widths cannot clip the UI');
    assert.ok(workspace.includes('WORKSPACE_CENTER_MIN_WIDTH'), 'right panel clamp must reserve usable center workspace width');
    assert.ok(browserCss.includes('overflow: hidden'), 'browser panel must clip inside its own panel instead of escaping the sidebar');
    assert.ok(browserCss.includes('min-width: 0'), 'browser panel flex children must be allowed to shrink inside the right sidebar');
    assert.ok(browserCss.includes('.browser-webview-host'), 'browser webview must be hosted in a flex child that owns the remaining vertical height');
    assert.ok(browserCss.includes('.browser-tab-strip'), 'browser tab strip must be styled as a stable toolbar row');
    assert.ok(browserCss.includes('.browser-tab-close'), 'browser tabs must expose visible close controls');
    assert.ok(browserCss.includes('.browser-webview-stack'), 'browser webview stack must preserve tab surfaces inside the remaining height');
    assert.ok(browserCss.includes('.browser-webview-host.is-active'), 'only the active browser tab host should be visible');
    assert.ok(browserCss.includes('.browser-webview-host {\n    display: none;'), 'inactive browser webview hosts must stay hidden');
    assert.ok(browserCss.includes('position: relative;'), 'active browser webview host must anchor the embedded guest surface');
    assert.ok(browserCss.includes('.browser-webview-host.is-active {\n    display: block;'), 'active browser webview host must avoid flex-container rendering that can leave Electron webviews blank');
    assert.ok(browserCss.includes('.browser-webview {\n    position: absolute;'), 'Electron webview must fill the host as a composited replaced element');
    assert.ok(browserCss.includes('inset: 0;'), 'Electron webview must be pinned to all host edges');
    assert.ok(browserCss.includes('display: flex;'), 'Electron webview must keep flex display so its internal guest iframe receives the full viewport height');
    assert.ok(browserCss.includes('contain: strict;'), 'Electron webview compositing should remain isolated from surrounding panel layout');
});

test('Electron diff panel resolves selected instance roots and exposes configurable modes', () => {
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const diffPanel = read('public/manager/src/diff-panel/DiffPanel.tsx');
    const diffRoots = read('public/manager/src/diff-panel/diff-root-candidates.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    const preload = read('electron/src/preload/index.ts');
    const diffIpc = read('electron/src/main/lib/git/ipc.ts');
    const diffService = read('src/manager/git/diff-service.ts');
    const diffCss = read('public/manager/src/diff-panel/diff-panel.css');

    assert.ok(router.includes('<DiffPanel'), 'router must render DiffPanel');
    assert.ok(router.includes('selectedInstance={ctx.selectedInstance}'), 'router must pass selected instance roots into DiffPanel');
    assert.ok(router.includes('settings={ctx.dashboardSettingsUi}'), 'router must pass saved diff settings into DiffPanel');
    assert.ok(router.includes('onSettingsPatch={ctx.onDashboardSettingsPatch}'), 'router must pass diff settings patch callback into DiffPanel');
    assert.ok(diffRoots.includes('settings.diffRootPolicy'), 'diff root helper must honor saved root policy');
    assert.ok(diffRoots.includes('settings.diffPinnedRootByPort'), 'diff root helper must include pinned per-instance repo roots');
    assert.ok(diffRoots.includes('settings.diffRecentRepoRoots'), 'diff root helper must include recent picked repo roots');
    assert.ok(diffRoots.includes('projectDirs'), 'diff root helper must use selected instance projectDirs');
    assert.ok(diffPanel.includes('bridge.getRepoCandidates(candidates)'), 'DiffPanel must resolve repo candidates instead of probing only Electron home');
    assert.ok(diffPanel.includes('diffPinnedRootByPort'), 'DiffPanel must persist the selected repo root by instance port');
    assert.ok(diffPanel.includes('Choose Repository'), 'DiffPanel must expose a native repository picker button');
    assert.ok(diffPanel.includes('Follow Instance'), 'DiffPanel must expose a manual-root reset button');
    assert.ok(diffPanel.includes("repoRootMode === 'manual'"), 'DiffPanel must preserve manual repository override mode');
    assert.ok(diffPanel.includes('folderBridge.pickFolder()'), 'DiffPanel must use the existing Electron folder picker bridge');
    assert.ok(diffPanel.includes('diffRecentRepoRoots'), 'DiffPanel must persist recent picked repositories');
    assert.ok(diffPanel.includes("const DIFF_MODES: DashboardDiffMode[] = ['unstaged', 'staged', 'head', 'base']"), 'DiffPanel must expose the expected diff modes');
    assert.ok(diffPanel.includes('diffIncludeUntracked'), 'DiffPanel must expose an untracked-file toggle');
    assert.ok(desktopBridge.includes('getRepoCandidates'), 'desktop bridge must expose repo candidate resolution');
    assert.ok(preload.includes("ipcRenderer.invoke('diff:getRepoCandidates'"), 'preload must expose repo candidate resolution');
    assert.ok(diffIpc.includes("ipcMain.handle('diff:getRepoCandidates'"), 'Electron main must implement repo candidate resolution');
    assert.ok(diffIpc.includes("from '../../../../../src/manager/git/diff-service.js'"), 'Electron diff IPC must delegate to the shared manager git diff service');
    assert.ok(diffService.includes("'-c', 'core.quotepath=false'"), 'git diff commands must preserve unicode/Korean paths');
    assert.ok(diffService.includes("DIFF_MODES = new Set(['unstaged', 'staged', 'head', 'base'])"), 'git diff service must validate diff mode options');
    assert.ok(diffService.includes("'recent'"), 'git diff service must accept recent picked repo candidates');
    assert.ok(diffService.includes('isValidRef(rawRef)'), 'git diff service must validate base refs before invoking git');
    assert.ok(diffService.includes("ls-files', '--others', '--exclude-standard"), 'git diff service must support untracked file summaries');
    assert.ok(diffService.includes("diff', '--no-color', '--no-index'"), 'git diff service must provide content for untracked file diffs');
    assert.ok(diffCss.includes('.diff-root-select'), 'DiffPanel root selector must be styled');
    assert.ok(diffCss.includes('.diff-follow-instance'), 'DiffPanel Follow Instance reset action must be styled');
    assert.ok(diffCss.includes('.diff-mode-button.is-active'), 'DiffPanel active mode must be visibly styled');
});

test('Electron terminal uses xterm plus a PTY backend and representative shortcut', () => {
    const shortcuts = read('public/manager/src/manager-shortcuts.ts');
    const app = read('public/manager/src/App.tsx');
    const main = read('electron/src/main/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    const previewBridge = read('public/js/features/preview-shortcut-bridge.ts');
    const previewMessages = read('public/manager/src/usePreviewShortcutMessages.ts');
    const terminal = read('public/manager/src/terminal/TerminalPanel.tsx');
    const terminalMain = read('electron/src/main/lib/terminal/index.ts');
    const electronConfig = read('electron/electron.vite.config.ts');
    const terminalCss = read('public/manager/src/terminal/terminal.css');
    const bottomTabBar = read('public/manager/src/panels/BottomPanelTabBar.tsx');
    const panelCss = read('public/manager/src/panels/panels.css');

    assert.ok(shortcuts.includes("focusTerminal: 'Ctrl+`'"), 'terminal focus must default to Ctrl+`');
    assert.ok(shortcuts.includes("newTerminalSession: 'Ctrl+Shift+`'"), 'new terminal session must default to Ctrl+Shift+`');
    assert.ok(shortcuts.includes("focusTerminal: ['Ctrl+`', 'Meta+`']"), 'terminal focus shortcut must keep Meta+` as a legacy reveal alias');
    assert.ok(shortcuts.includes("newTerminalSession: ['Ctrl+Shift+`']"), 'Ctrl+Shift+` must create a new terminal instead of revealing an existing one');
    assert.ok(shortcuts.includes("toggleRightPanel: 'Meta+B'"), 'right side panel must use the expected Cmd+B shortcut');
    assert.ok(shortcuts.includes("toggleRightPanel: ['Meta+B']"), 'right side panel alias list must not conflict with toggleLeftSidebar on Cmd+Shift+B');
    assert.ok(shortcuts.includes("event.code === 'Backquote'"), 'shortcut matching must handle shifted backquote key events');
    assert.ok(main.includes("contents.on('before-input-event'"), 'Electron main must catch shortcuts before iframe/webview focus traps them');
    assert.match(main, /import\s+\{[^}]*\bMenu\b[^}]*\}\s+from 'electron'/, 'Electron main must import Menu for native accelerators');
    assert.ok(main.includes('function sendManagerShortcut'), 'Electron main must route all shortcut sources through one sender');
    assert.ok(main.includes("sendManagerShortcut(action)"), 'Electron before-input-event handler must forward desktop shortcuts to the manager renderer');
    assert.ok(main.includes('function installManagerApplicationMenu()'), 'Electron main must install application menu accelerators for shortcuts that macOS consumes before the page');
    assert.ok(main.includes("accelerator: 'CommandOrControl+B'"), 'right sidebar shortcut must be registered as a native app menu accelerator');
    assert.ok(main.includes("accelerator: 'Ctrl+`'"), 'terminal reveal shortcut must be registered as a native app menu accelerator');
    assert.ok(main.includes("accelerator: 'Ctrl+Shift+`'"), 'new terminal shortcut must be registered as a native app menu accelerator');
    assert.ok(preload.includes("ipcRenderer.on('manager:shortcut', handler)"), 'preload must expose desktop shortcut events');
    assert.ok(desktopBridge.includes('shortcuts?: ShortcutBridgeApi'), 'frontend desktop bridge type must include shortcut events');
    assert.ok(app.includes("getDesktop()?.shortcuts?.onAction"), 'manager app must subscribe to Electron desktop shortcut events');
    assert.ok(
        app.includes("document.activeElement?.tagName === 'IFRAME' && action !== 'browserReload' && action !== 'browserHardReload'"),
        'iframe focus must keep blocking manager chrome shortcuts while allowing Cmd+R/Cmd+Shift+R to refresh the preview',
    );
    assert.ok(previewBridge.includes('e.ctrlKey && !e.metaKey && !e.altKey'), 'classic preview iframe bridge must forward Ctrl+Backquote and Ctrl+Shift+Backquote');
    assert.ok(previewMessages.includes('ctrlKey: !!data.ctrlKey'), 'manager preview shortcut bridge must preserve Ctrl modifier');
    assert.ok(previewMessages.includes('metaKey: !!data.metaKey'), 'manager preview shortcut bridge must preserve Meta modifier');
    assert.ok(terminal.includes("import { Terminal } from '@xterm/xterm'"), 'TerminalPanel must use xterm.js for real terminal input/rendering');
    assert.ok(terminal.includes("import { FitAddon } from '@xterm/addon-fit'"), 'TerminalPanel must fit terminal rows/cols to the panel');
    assert.ok(terminal.includes('term.onData(data => {'), 'xterm input must stream directly to the terminal bridge');
    assert.ok(terminal.includes('term.onResize(({ cols, rows }) => { void resizeTerminal(id, cols, rows); })'), 'terminal resize events must use the shared handled boundary');
    const resizeBoundary = terminal.slice(terminal.indexOf('const resizeTerminal = useCallback'), terminal.indexOf('const fitTerminal = useCallback'));
    assert.match(resizeBoundary, /try\s*\{[\s\S]*await bridge\.resize\(id, cols, rows\)[\s\S]*catch\s*\{[\s\S]*setPresentationError/, 'the shared resize boundary must call PTY resize and handle rejection');
    assert.ok(terminal.includes('createAccessibilityInputBridge'), 'terminal must include an accessibility input bridge for Computer Use/native text injection');
    assert.ok(terminal.includes("textarea.terminal-a11y-input"), 'accessibility input bridge must use a dedicated input instead of xterm internals');
    assert.ok(terminal.includes('aria-label="Terminal automation input"'), 'dedicated accessibility input must not share xterm helper textarea labels');
    assert.equal(terminal.includes("textarea.xterm-helper-textarea"), false, 'accessibility bridge must not read or clear xterm internal helper textarea');
    assert.ok(terminal.includes("void bridge.write(id, value);"), 'dedicated accessibility input must write to the PTY without touching xterm internals');
    assert.ok(terminal.includes("textarea.value = ''"), 'accessibility input bridge must clear the dedicated textarea after forwarding text through xterm');
    assert.ok(terminal.includes("value.replace(/\\r?\\n/g, '\\r')"), 'accessibility input bridge must translate submitted newlines into terminal carriage returns');
    assert.ok(terminal.includes("addEventListener('compositionstart'"), 'accessibility input bridge must pause polling while Korean/CJK IME composition is active');
    assert.ok(terminal.includes("addEventListener('compositionend'"), 'accessibility input bridge must resume polling after IME composition ends');
    assert.equal(terminal.includes('shouldSkipAccessibilityValue'), false, 'accessibility bridge should avoid duplicate-prone direct PTY writes');
    assert.equal(terminal.includes('shouldSkipXtermValue'), false, 'xterm onData should remain the PTY write path for normal user input');
    assert.ok(terminal.includes('autoCreatedRef'), 'terminal must only auto-create the initial session so closing the last session remains possible');
    assert.ok(terminal.includes('const closeSession = useCallback'), 'terminal session tabs must expose a close action');
    assert.ok(terminal.includes('terminal-tab-close'), 'terminal session tabs must render visible close controls');
    assert.ok(terminal.includes('isCreating'), 'terminal must track shell creation separately from the tab list');
    assert.ok(terminal.includes("'No terminal sessions'"), 'terminal empty state must not keep showing a stale Starting shell message after closing the last session');
    assert.ok(terminal.includes('disabled={isCreating}'), 'terminal new-session buttons must avoid duplicate starts while a shell is already being created');
    assert.ok(bottomTabBar.includes('bottom-tab-item'), 'bottom panel tabs must separate the tab button from the close button');
    assert.ok(bottomTabBar.includes('type="button"\n                        className="bottom-tab-close"'), 'bottom panel close control must be a real button, not a hidden nested role span');
    assert.ok(panelCss.includes('.bottom-tab-item'), 'bottom panel tab wrappers must be styled');
    assert.ok(panelCss.includes('.bottom-tab-close:hover'), 'bottom panel close controls must be visibly styled');
    assert.ok(!/\.bottom-tab-close\s*\{[^}]*opacity:\s*0/s.test(panelCss), 'bottom panel close controls must not be hidden until hover');
    assert.ok(terminalMain.includes("import { spawn as spawnPty } from 'node-pty'"), 'Electron terminal backend must use node-pty instead of pipe-backed child_process.spawn');
    assert.ok(terminalMain.includes('loginArgsForShell(shell)'), 'terminal sessions must derive login args per shell/platform');
    assert.ok(terminalMain.includes('session.pty.write(data)'), 'terminal writes must go to the PTY');
    assert.ok(terminalMain.includes('session.pty.resize('), 'terminal resize must resize the PTY');
    assert.ok(electronConfig.includes("'node-pty'"), 'electron-vite must externalize node-pty native bindings');
    assert.ok(terminalCss.includes('.terminal-xterm-host'), 'xterm host must be styled');
    assert.ok(terminalCss.includes('.terminal-a11y-input'), 'dedicated accessibility terminal input must be visually hidden but available to native automation');
    assert.ok(terminalCss.includes('.terminal-tab-close'), 'terminal session close controls must be styled');
});

test('Electron browser panel uses a hardened webview instead of a CSP-blocked iframe', () => {
    const main = read('electron/src/main/index.ts');
    const navigationPolicy = read('electron/src/main/lib/navigation-policy.ts');
    const browser = read('public/manager/src/browser-panel/BrowserPanel.tsx');
    const instancePreview = read('public/manager/src/InstancePreview.tsx');
    const css = read('public/manager/src/browser-panel/browser-panel.css');
    assert.ok(main.includes('webviewTag: true'), 'BrowserWindow must enable webview only for the desktop browser panel');
    assert.ok(main.includes("mainWindow.webContents.on('will-attach-webview'"), 'Electron main must validate every attached webview');
    assert.ok(main.includes('function isAllowedEmbeddedBrowserUrl'), 'webview navigation must use a dedicated URL policy');
    assert.ok(main.includes('function normalizeAllowedEmbeddedBrowserUrl'), 'webview navigation must normalize allowed http/https URLs before forwarding them');
    assert.ok(main.includes('return normalizeExternalOpenUrl(raw);'), 'Electron webview policy must reuse shared external URL normalization');
    assert.ok(navigationPolicy.includes("if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;"), 'Electron URL policy must reject non-http protocols before allowing navigation');
    assert.ok(navigationPolicy.includes('if (parsed.username || parsed.password) return null;'), 'Electron URL policy must reject credential-bearing URLs');
    assert.ok(main.includes('return normalizeAllowedEmbeddedBrowserUrl(raw) !== null;'), 'Electron webview policy must allow local/private http preview URLs after protocol validation');
    assert.ok(!main.includes('BLOCKED_EMBED_HOSTS'), 'Electron webview policy must not block localhost/private preview URLs in the desktop Browser panel');
    assert.ok(main.includes('hardenEmbeddedBrowserWebContents'), 'webview contents must deny permissions and popups');
    assert.ok(main.includes("mainWindow.webContents.send('browser:open-url'"), 'webview popup/new-window requests must be routed back into the Browser panel');
    assert.ok(main.includes('function openExternalNavigation'), 'Electron shell must centralize external app/browser opens for manager and preview frames');
    assert.ok(main.includes("mainWindow.webContents.on('will-frame-navigate'") && main.includes('if (event.isMainFrame) return;'), 'Electron shell must inspect only subframe navigations before they replace the frame');
    assert.ok(main.includes('openExternalNavigation(event.url);'), 'disallowed preview iframe navigations must be opened in the default browser');
    assert.equal(main.includes('EXTERNAL_ALLOWLIST'), false, 'external web links must not be restricted to a stale host allowlist');
    assert.ok(main.includes('registerGlobalWebContentsHardening'), 'global webContents hardening must be registered once instead of per window recreation');
    assert.ok(browser.includes("createElement('webview'"), 'BrowserPanel must render Electron webview, not an iframe');
    assert.ok(browser.includes("allowpopups: 'true'"), 'BrowserPanel must render the Electron allowpopups attribute so main can convert target=_blank clicks into in-app tabs');
    assert.ok(browser.includes("partition: 'persist:cli-jaw-browser'"), 'BrowserPanel must keep a persistent Electron browser session partition');
    assert.ok(browser.includes('browser-external-surface'), 'web UI must present a limited external browser launcher instead of a broken iframe browser');
    assert.ok(browser.includes("window.open(target, '_blank', 'noopener,noreferrer')"), 'web UI browser mode must open external URLs in a browser tab');
    assert.ok(browser.includes('desktopBridge?.identify?.()?.electron === true'), 'BrowserPanel must only use Electron webview when the bridge is present, not from user-agent alone');
    assert.ok(instancePreview.includes('sandbox={isElectron() ? undefined : PREVIEW_IFRAME_SANDBOX}'), 'Electron manager previews must not sandbox the frame that hosts desktop webviews');
    assert.ok(css.includes('.browser-go-btn'), 'browser toolbar must expose an explicit go action');

    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    assert.ok(preload.includes("ipcRenderer.on('browser:open-url', handler)"), 'preload must expose Browser panel popup routing events');
    assert.ok(desktopBridge.includes('browser?: BrowserBridgeApi'), 'desktop bridge type must include Browser panel popup routing events');
    assert.ok(preload.includes("ipcRenderer.invoke('clipboard:writeText', text)"), 'preload must expose the Electron clipboard bridge');
    assert.ok(desktopBridge.includes('clipboard?: ClipboardBridgeApi'), 'desktop bridge type must include the clipboard bridge');
    assert.ok(desktopBridge.includes('permissions?: PermissionDiagnosticsBridgeApi'), 'desktop bridge type must include permission diagnostics');
});

test('Electron bottom terminal and browser panels avoid duplicate generic chrome', () => {
    const bottomPanel = read('public/manager/src/panels/BottomPanel.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const terminal = read('public/manager/src/terminal/TerminalPanel.tsx');
    const terminalCss = read('public/manager/src/terminal/terminal.css');
    const browser = read('public/manager/src/browser-panel/BrowserPanel.tsx');
    const browserCss = read('public/manager/src/browser-panel/browser-panel.css');
    const panelCss = read('public/manager/src/panels/panels.css');

    assert.ok(bottomPanel.includes("const CONTENT_OWNED_CHROME_TABS: BottomPanelTab[] = ['terminal', 'browser']"), 'terminal and browser bottom tabs must own their own chrome instead of showing a duplicate generic row');
    assert.ok(bottomPanel.includes('if (bp.tabs.length === 0) return null'), 'collapsed bottom panels with live tabs must remain mounted for state preservation');
    assert.equal(bottomPanel.includes('if (!bp.open || bp.tabs.length === 0) return null'), false, 'collapse must not unmount terminal/browser panels and kill state');
    assert.ok(bottomPanel.includes('{!ownsChrome && ('), 'generic BottomPanelTabBar must be hidden for content-owned terminal/browser panels');
    assert.ok(router.includes('panelLayout.state.bottomPanel.tabs.length > 0 ? <BottomPanel'), 'SidebarRailRouter must keep BottomPanel mounted while collapsed if tabs still exist');
    assert.equal(router.includes('bottomPanelOpen && panelLayout.state.bottomPanel.tabs.length > 0'), false, 'SidebarRailRouter must not gate BottomPanel mounting on bottomPanelOpen');
    assert.ok(router.includes('<TerminalPanel onCollapse={controls.onCollapse} onEmptySessions={controls.onCloseTab} />'), 'TerminalPanel must receive collapse and empty-session callbacks from BottomPanel');
    assert.ok(router.includes('<BrowserPanel onCollapse={controls.onCollapse} selectedInstancePort={selectedInstancePort} onInsertCommentIntoPreview={onInsertCommentIntoPreview} />'), 'BrowserPanel must receive collapse callback and preview insert relay only in bottom-panel context');
    assert.ok(terminal.includes('onEmptySessions?: () => void'), 'TerminalPanel must expose an empty-session callback for closing the bottom tab after the last PTY exits');
    assert.ok(terminal.includes('notifyEmptySessionsSoon'), 'TerminalPanel must notify after both user-close and process-exit remove the last session');
    assert.ok(terminal.includes('terminal-collapse-button'), 'Terminal collapse control must live in the terminal session tab row');
    assert.ok(terminalCss.includes('.terminal-collapse-button'), 'Terminal collapse control must be visibly styled');
    assert.ok(browser.includes('onCollapse?: () => void'), 'BrowserPanel collapse prop must remain optional because the right sidebar also reuses BrowserPanel');
    assert.ok(browser.includes('browser-collapse-button'), 'Browser collapse control must live in the browser tab strip');
    assert.ok(browser.includes('if (current.length <= 1)'), 'last browser tab close must keep the existing replacement-tab behavior instead of closing the panel');
    assert.ok(browserCss.includes('.browser-collapse-button'), 'Browser collapse control must be visibly styled');
    assert.ok(panelCss.includes('.bottom-panel.has-content-owned-chrome .bottom-panel-content'), 'content-owned bottom panels must let their local chrome own the panel height');
});

test('Electron folder IPC exposes a usable default root for folder/file split view', () => {
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    const folderIpc = read('electron/src/main/lib/folder/ipc.ts');

    assert.ok(preload.includes("getDefaultRoot: () => ipcRenderer.invoke('folder:getDefaultRoot')"), 'preload must expose default folder root');
    assert.ok(desktopBridge.includes('getDefaultRoot: () => Promise'), 'frontend bridge type must include default folder root');
    assert.ok(folderIpc.includes("ipcMain.handle('folder:getDefaultRoot'"), 'folder IPC must implement default root lookup');
    assert.ok(folderIpc.includes('pickedRoots.add(root)'), 'default root must be authorized for subsequent list/read calls');
});

test('workspace polish keeps current center/right/bottom grid areas intact', () => {
    const polish = read('public/manager/src/manager-polish.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(
        !polish.includes('"sidebar detail"'),
        'collapsed inspector polish must not use the obsolete detail grid area name',
    );
    assert.ok(
        !polish.includes('"sidebar detail ceo"'),
        'side panel polish must not use the obsolete ceo grid area name',
    );
    assert.ok(
        polish.includes('--activity-dock-height: 0px'),
        'collapsed inspector polish must collapse the dock without replacing the workspace grid template',
    );
    // 260902 t3 shell (wp2): the sidebar width variable is owned by JS
    // (useSidebarWidth -> WorkspaceLayout inline style), so the CSS polish
    // files must NOT reassign it — the grid template only consumes it.
    const workspaceLayout = read('public/manager/src/components/WorkspaceLayout.tsx');
    const sidebarWidthHook = read('public/manager/src/hooks/useSidebarWidth.ts');
    assert.ok(
        !/--sidebar-width:\s*(300|280|44|56)px/.test(polish) && !/--sidebar-width:\s*44px/.test(compact),
        'polish/compact CSS must not reassign --sidebar-width; the width is JS-owned',
    );
    assert.ok(
        workspaceLayout.includes("'--sidebar-width': props.sidebarCollapsed"),
        'WorkspaceLayout must write --sidebar-width from state instead of replacing grid columns',
    );
    assert.ok(
        sidebarWidthHook.includes('SIDEBAR_COLLAPSED_WIDTH = 44'),
        'collapsed sidebar rail width is the hook constant (44px)',
    );
    assert.ok(
        !compact.includes('grid-template-columns: 44px minmax(0, 1fr)'),
        'collapsed-sidebar compact polish must preserve the right panel grid column',
    );
    assert.ok(
        polish.includes('.manager-workspace.is-right-panel-open'),
        'medium-width polish must explicitly preserve the right panel grid column when the panel is open',
    );
    assert.ok(
        !polish.includes('grid-template-columns: 300px minmax(0, 1fr);'),
        'medium-width polish must not replace the workspace with a two-column grid that pushes the right panel offscreen',
    );
    assert.ok(
        polish.includes('grid-template-areas: "sidebar center right" "sidebar bottom right"'),
        'medium-width polish must keep the current right grid area name',
    );
    assert.ok(
        polish.includes('grid-template-areas: "center";'),
        'narrow collapsed-inspector polish must use the current center grid area name',
    );
    assert.ok(
        polish.includes('grid-template-areas: "center" "mobile-nav";'),
        'mobile collapsed-inspector polish must use the current center grid area name',
    );
    const workspace = read('public/manager/src/components/WorkspaceLayout.tsx');
    const layout = read('public/manager/src/manager-layout.css');
    assert.ok(workspace.includes("props.rightPanelOpen && 'is-right-panel-open'"), 'workspace must expose an open-state class for responsive right panel rules');
    assert.ok(workspace.includes("props.bottomPanelOpen && 'is-bottom-panel-open'"), 'workspace must expose a bottom-panel open class so mobile layouts do not infer it from the legacy inspector state');
    assert.ok(layout.includes('position: relative;'), 'workspace must create a containing block for narrow right-panel overlay layout');
    assert.ok(layout.includes('.manager-workspace.is-right-panel-open .right-panel'), 'narrow layouts must keep the right panel visible as an overlay instead of pushing it offscreen');
    assert.ok(layout.includes('.manager-workspace.is-bottom-panel-open'), 'mobile layouts must keep an explicit bottom panel grid row when the terminal panel is open');
    assert.ok(layout.includes('grid-area: auto;'), 'mobile right panel overlay must clear its desktop right grid area to avoid implicit grid clipping');
    assert.ok(layout.includes('height: auto;'), 'mobile right panel overlay must stretch between top and bottom insets instead of collapsing to its toolbar');
    assert.ok(layout.includes('justify-self: end;'), 'mobile right panel overlay must anchor to the right edge without creating implicit grid columns');
});
