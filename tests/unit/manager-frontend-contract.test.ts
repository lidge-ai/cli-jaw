import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(projectRoot, path), 'utf8'));
}

test('vite config includes manager entry and react plugin', () => {
    const vite = read('vite.config.ts');

    assert.ok(vite.includes("@vitejs/plugin-react"), 'Vite must include React plugin');
    assert.ok(vite.includes("manager: 'public/manager/index.html'"), 'Vite must include manager entry');
    assert.ok(vite.includes("app: 'public/index.html'"), 'Vite must preserve existing app entry');
});

test('frontend tsconfig typechecks manager TSX', () => {
    const tsconfig = read('tsconfig.frontend.json');

    assert.ok(tsconfig.includes('"jsx": "react-jsx"'), 'frontend tsconfig must enable react-jsx');
    assert.ok(tsconfig.includes('public/manager/src/**/*.tsx'), 'frontend tsconfig must include manager TSX');
    assert.ok(tsconfig.includes('public/manager/src/**/*.ts'), 'frontend tsconfig must include manager TS');
});

test('app icon validation stays scoped to packaged app assets', () => {
    const manifest = read('public/manifest.json');
    const pkg = read('package.json');
    const iconChecker = read('scripts/check-app-icon-assets.cjs');
    const managerCss = read('public/manager/src/manager-components.css');

    assert.ok(pkg.includes('"check:app-icons": "node scripts/check-app-icon-assets.cjs"'), 'package scripts must expose app icon validation');
    assert.ok(manifest.includes('"src": "/icons/icon-192.png"'), 'manifest must keep the normal 192 app icon');
    assert.ok(manifest.includes('"src": "/icons/icon-512.png"'), 'manifest must keep the normal 512 app icon');
    assert.ok(manifest.includes('"src": "/icons/icon-512-maskable.png"'), 'manifest must keep the maskable 512 app icon');
    assert.ok(manifest.includes('"purpose": "maskable"'), 'manifest must preserve a dedicated maskable icon entry');
    assert.ok(iconChecker.includes('electron/build/icon.png'), 'app icon checker must validate the Electron packaged app PNG');
    assert.ok(iconChecker.includes('electron/build/icon.icns'), 'app icon checker must validate the macOS packaged app ICNS');
    assert.ok(iconChecker.includes('public/icons/icon-192.png'), 'app icon checker must validate public app icon inputs');
    assert.equal(iconChecker.includes('manager-components.css'), false, 'app icon checker must not validate manager-internal provider/avatar CSS');
    assert.equal(managerCss.includes('platform-specific icon'), false, 'manager CSS must not gain platform-specific icon shape rules for this goal');
});

test('manager frontend has API entry and Open action', () => {
    assert.equal(existsSync(join(projectRoot, 'public/manager/index.html')), true);
    const api = read('public/manager/src/api.ts');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const command = read('public/manager/src/components/CommandBar.tsx');

    assert.ok(api.includes('/api/dashboard/instances'), 'manager API must call dashboard instances endpoint');
    assert.ok(api.includes('/api/dashboard/lifecycle/'), 'manager API must call dashboard lifecycle endpoint');
    assert.ok(api.includes('/api/dashboard/registry'), 'manager API must call dashboard registry endpoint');
    assert.ok(api.includes('/api/dashboard/notes/tree'), 'manager API must call dashboard notes tree endpoint');
    assert.ok(api.includes('/api/dashboard/notes/file'), 'manager API must call dashboard notes file endpoint');
    assert.ok(api.includes('/api/dashboard/notes/folder'), 'manager API must call dashboard notes folder endpoint');
    assert.ok(api.includes('/api/dashboard/notes/rename'), 'manager API must call dashboard notes rename endpoint');
    assert.ok(api.includes('/api/dashboard/notes/trash'), 'manager API must call dashboard notes trash endpoint');
    assert.ok(row.includes('Open'), 'manager UI must expose Open action');
    assert.ok(row.includes('props.instance.url'), 'Open must link to instance URL');
    assert.ok(row.includes('props.instance.ok'), 'Open must gate on instance reachability');
    assert.ok(command.includes('Search port, home, CLI, model'), 'manager UI must include search');
});

test('manager server serves built dashboard HTML at /manager while preserving static manager assets', () => {
    const server = read('src/manager/server.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const pkg = read('package.json');

    assert.ok(server.includes("join(distRoot, 'manager', 'index.html')"), 'built manager HTML must remain the first /manager fallback candidate');
    assert.ok(server.includes("join(sourceRoot, 'manager', 'index.html')"), 'source manager HTML may remain a last-resort development fallback');
    assert.ok(
        server.includes("app.use('/manager', express.static(join(sourceRoot, 'manager'), { index: false }))"),
        '/manager static assets must not shadow the built manager HTML index',
    );
    assert.ok(server.includes("htmlPath.startsWith(distRoot) ? 'dist' : 'source'"),
        'manager UI source marker must reflect the actual selected HTML path');
    assert.ok(server.includes("res.setHeader('x-jaw-manager-ui', managerUiSource(htmlPath))"),
        'manager HTML responses must expose a QA source marker');
    assert.ok(server.includes('managerPreviewMicPermissionPolicy'),
        'manager HTML must build a microphone Permissions-Policy for preview origins');
    assert.ok(server.includes("res.setHeader('Permissions-Policy', managerPermissionsPolicy)"),
        'manager HTML must delegate microphone permission to preview iframes before Chrome can show a prompt');
    assert.ok(preview.includes('{ theme: props.theme }'),
        'embedded manager preview must preserve dedicated preview-origin routing so iframe /api and /ws target the managed instance');
    assert.equal(preview.includes("transport: 'legacy-path'"), false,
        'embedded manager preview must not force the legacy /i path because it breaks root-relative instance API and websocket calls');
    assert.ok(pkg.includes('"qa:manager-frontend": "npm run build:frontend && npm run typecheck:frontend"'),
        'manual manager QA must have a build-first helper script');
});

test('manager command bar exposes polished dashboard brand', () => {
    const command = read('public/manager/src/components/CommandBar.tsx');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(command.includes('CLI-JAW'), 'command bar must render compact CLI-JAW wordmark');
    assert.ok(command.includes('DASH'), 'command bar must render one-line DASH label');
    assert.equal(command.includes('🦈'), false, 'top dashboard brand must not use emoji');
    assert.ok(compact.includes('manager-brand-heading'), 'brand heading must have explicit polish styling');
    assert.ok(compact.includes('manager-brand-dash'), 'DASH label must be styled as secondary context');
    assert.ok(compact.includes('font-weight: 600'), 'brand heading must use stronger typography');
    assert.ok(compact.includes('font-size: 13px'), 'brand heading must use compact dashboard type');
    assert.ok(compact.includes('letter-spacing: 0.02em'), 'brand heading must keep tracked wordmark spacing');
    assert.equal(command.includes('☰'), false, 'drawer trigger must not use a hamburger text glyph');
    assert.ok(command.includes('drawer-trigger'), 'command bar must keep the drawer trigger');
    assert.ok(/drawer-trigger[\s\S]*<svg[\s\S]*<path/.test(command), 'drawer trigger must render an SVG path');
});

test('manager frontend exposes one-instance preview controls', () => {
    const app = read('public/manager/src/App.tsx');
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const header = read('public/manager/src/components/WorkbenchHeader.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const themeHook = read('public/manager/src/hooks/useTheme.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const helper = read('public/manager/src/preview.ts');
    const api = read('public/manager/src/api.ts');
    const chat = read('public/js/features/chat.ts');
    const childTheme = read('public/js/features/theme.ts');
    const childHtml = read('public/index.html');
    const components = read('public/manager/src/manager-components.css');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const settingsShell = read('public/manager/src/settings/SettingsShell.tsx');
    const server = read('src/manager/server.ts');

    assert.ok(hook.includes('selectedPort'), 'manager UI must track a selected preview instance');
    assert.ok(app.includes('handleSelectInstance'), 'manager UI must allow selecting any instance row');
    assert.ok(router.includes('InstancePreview'), 'manager UI must render preview component');
    assert.ok(app.includes('refreshInstance'), 'manager UI must refresh one selected instance without a full page reload');
    assert.ok(app.includes('fetchInstanceStatus(port)'), 'selected refresh must use the single-instance status endpoint');
    assert.equal(workbench.includes('contentByMode'), false, 'workbench must not unmount preview through contentByMode switching');
    assert.ok(workbench.includes('workbench-panel-preview'), 'workbench must render preview in a dedicated panel');
    assert.ok(workbench.includes("hidden={props.mode !== 'preview'}"), 'preview panel must hide without unmounting across tab changes');
    assert.equal(workbench.includes('settingsOpen'), false, 'the Workbench no longer hosts an instance settings panel');
    assert.ok(workbench.includes('data-preview-host="persistent"'), 'preview host must be explicitly persistent');
    assert.ok(workbench.includes('{props.preview}'), 'persistent preview panel must render the preview slot');
    assert.ok(header.includes('role="switch"'), 'workbench header must expose a compact preview on/off switch');
    assert.ok(header.includes('onPreviewRefresh'), 'workbench header must expose iframe preview refresh');
    assert.ok(header.includes('projectDirs'), 'workbench header must render selected instance project directories');
    assert.ok(header.includes('compactPath(dir)'), 'workbench header must compact long project directory paths');
    assert.equal(header.includes('instance?.workingDir'), false, 'workbench header must not show workingDir as the selected project path');
    assert.ok(components.includes('.project-dirs'), 'project directory line must have explicit header styling');
    assert.ok(components.includes('flex-wrap: wrap'), 'project directory chips must wrap instead of crowding header actions');
    assert.ok(components.includes('overflow: hidden'), 'project directory row must clip overflow safely');
    assert.ok(app.includes('previewRefreshKey'), 'App must track a preview refresh key');
    assert.ok(router.includes('function WorkspaceSurface'), 'SidebarRailRouter must wrap top-level workspaces in persistent surfaces');
    assert.ok(router.includes('workspace-surface-stack'), 'SidebarRailRouter must keep the top-level workspace stack mounted across sidebar mode changes');
    assert.ok(router.includes('workspace-surface-layer'), 'SidebarRailRouter must separate persistent workspace surfaces from lifecycle messages');
    assert.ok(router.includes("<WorkspaceSurface active={props.sidebarMode === 'instances' && props.viewMode === 'jaw'}>"), 'Instances workbench must hide without unmounting across sidebar mode changes');
    assert.ok(router.includes("<WorkspaceSurface active={props.sidebarMode === 'notes'}>"), 'Notes workspace must hide without unmounting across sidebar mode changes');
    assert.ok(router.includes("<WorkspaceSurface active={props.sidebarMode === 'settings'}>"), 'Dashboard settings workspace must hide without unmounting across sidebar mode changes');
    assert.ok(router.includes('hidden={!props.active}'), 'inactive persistent workspace surfaces must use hidden instead of conditional unmounting');
    assert.ok(appChrome.includes('theme.resolved'), 'AppChrome must pass the concrete resolved dashboard theme to preview');
    assert.ok(app.includes('theme.syncFromRegistry'), 'App must hydrate registry theme through hook state');
    assert.ok(themeHook.includes('syncFromRegistry'), 'theme hook must expose registry sync that updates React state');
    assert.ok(themeHook.includes('setThemeState(next)'), 'registry theme sync must update React state');
    assert.ok(preview.includes('props.enabled'), 'InstancePreview must obey the header preview on/off switch');
    assert.ok(preview.includes('props.refreshKey'), 'InstancePreview must remount the iframe when refreshed');
    assert.equal(preview.includes('sidebarMode'), false, 'InstancePreview iframe key must not include sidebarMode');
    assert.ok(preview.includes('jaw-preview-theme-sync'), 'InstancePreview must post dashboard theme to iframe');
    assert.ok(preview.includes('previewTargetOrigin(src, frame)'), 'InstancePreview must target the actual iframe origin when readable');
    assert.ok(preview.includes("actualOrigin !== 'null'"), 'InstancePreview must skip opaque about:blank origins');
    assert.ok(preview.includes("expectedOrigin === 'null' ? null : expectedOrigin"), 'InstancePreview must not call postMessage with target origin null');
    assert.ok(preview.includes('postPreviewTheme(iframeRef.current, state.src, props.theme)'), 'InstancePreview must route theme sync through guarded postMessage helper');
    assert.ok(preview.includes('function postPreviewVisible('), 'InstancePreview must centralize the visibility ping in a guarded helper');
    assert.ok(/onLoad=\{\(\) => \{[\s\S]*?postPreviewVisible\(iframeRef\.current, state\.src\)/.test(preview), 'InstancePreview onLoad must re-settle the embedded chat on every iframe (re)mount, covering instance switches where active does not transition');
    assert.ok(preview.includes("console.warn('[manager-preview] theme sync skipped'"), 'InstancePreview must not let origin mismatch postMessage errors break the dashboard');
    assert.equal(preview.includes("postMessage(\n            { type: 'jaw-preview-theme-sync', theme: props.theme },\n            '*',"), false, 'InstancePreview must not post preview theme with wildcard origin');
    assert.ok(preview.includes("data.type !== 'jaw-preview-send-message'"), 'Manager preview must listen for child iframe send relay requests');
    assert.ok(preview.includes('previewFrameOriginMatches(event.origin, state.src, iframeRef.current)'), 'Manager preview send relay must validate the actual iframe origin');
    assert.ok(preview.includes('loopbackOriginsEquivalent'), 'Manager preview send relay must treat localhost and 127.0.0.1 as equivalent on loopback');
    assert.ok(preview.includes('sendInstanceMessage(props.instance!.port, prompt, sessionId)'), 'Manager preview send relay must forward the prompt and its session to the selected instance port');
    assert.ok(preview.includes("type: 'jaw-preview-send-result'"), 'Manager preview send relay must answer the child iframe request');
    assert.ok(api.includes('/api/dashboard/instances/${port}/message'), 'manager API must expose a selected-instance message relay');
    assert.ok(server.includes("app.post('/api/dashboard/instances/:port/message'"), 'manager server must implement the selected-instance message relay endpoint');
    assert.ok(server.includes('prompt must be a non-empty string'), 'manager message relay must reject empty prompts');
    assert.ok(server.includes('http://127.0.0.1:${portValue}/api/message'), 'manager message relay must only forward to the validated loopback instance port');
    assert.ok(chat.includes('sendPreviewMessageViaParent'), 'classic preview UI must try the Manager parent send relay when embedded');
    assert.ok(chat.includes("withCurrentSessionBody({ type: 'jaw-preview-send-message'"), 'classic preview UI must request parent relay through postMessage, carrying its session');
    assert.ok(chat.includes("data.type !== 'jaw-preview-send-result'"), 'classic preview UI must wait for the matching parent relay response');
    assert.ok(chat.includes('PREVIEW_SEND_RELAY_TIMEOUT_MS'), 'classic preview UI must fall back if an older parent does not support the relay');
    assert.ok(chat.includes('relayed?.ok'), 'classic preview UI must fall back to direct /api/message when parent relay fails');
    assert.ok(helper.includes('PreviewTheme'), 'preview helper must type dark/light preview themes');
    assert.ok(helper.includes('jawTheme'), 'preview helper must append jawTheme query');
    assert.ok(helper.includes("PreviewTransport = 'origin-port' | 'legacy-path' | 'none'"), 'preview helper must not expose direct transport');
    assert.ok(childHtml.includes('jawTheme'), 'child Web UI first-paint bootstrap must read jawTheme');
    assert.ok(childTheme.includes('jaw-preview-theme-sync'), 'child Web UI must listen for preview theme sync messages');
    assert.ok(childTheme.includes('event.source !== window.parent'), 'child Web UI must only accept theme messages from parent frame');
    assert.ok(childTheme.includes('isLocalThemeOrigin'), 'child Web UI must validate local/same origins');
    assert.ok(childTheme.includes('applyTheme(data.theme)'), 'child Web UI must apply preview theme without using the persistent toggle path');
    assert.equal(childTheme.includes("localStorage.setItem(STORAGE_KEY, data.theme"), false, 'preview message theme changes must not persist to localStorage');
    // The detail host no longer mounts settings; the rail workspace owns that surface and its
    // own save callback. What must survive is the Shell emitting one at all.
    assert.ok(settingsShell.includes('onSaved?.()'), 'SettingsShell must emit a save-complete callback');
    assert.ok(components.includes('.workbench-panel'), 'workbench panels must have stable sizing');
    assert.ok(components.includes('.workbench-panel[hidden]'), 'inactive persistent preview panel must not reserve space');
    const layout = read('public/manager/src/manager-layout.css');
    assert.ok(layout.includes('.workspace-surface-stack'), 'layout CSS must size the persistent workspace stack');
    assert.ok(layout.includes('.workspace-surface-layer'), 'layout CSS must size the persistent workspace layer');
    assert.ok(layout.includes('.workspace-surface[hidden]'), 'hidden workspace surfaces must not reserve visible space');
    assert.ok(components.includes('.preview-switch'), 'preview switch must have compact header styling');
    assert.ok(components.includes('.preview-refresh-button'), 'preview refresh button must have compact header styling');
    assert.ok(preview.includes('<iframe'), 'preview component must mount iframe');
    assert.ok(preview.includes('clipboard-read; clipboard-write'), 'preview iframe must explicitly allow clipboard read/write');
    assert.ok(header.includes('preview-inline-status'), 'workbench header must expose compact preview status');
    assert.equal(preview.includes('preview-status-row'), false, 'preview iframe area must not spend a row on status');
    assert.equal(preview.includes('Enable preview'), false, 'preview tab must not require a second enable toggle');
    assert.equal(preview.includes('<select'), false, 'preview mode dropdown must be removed');
    assert.equal(helper.includes("transport: 'direct'"), false, 'preview helper must not expose direct iframe mode');
    assert.ok(helper.includes('buildPreviewState'), 'preview helper must centralize URL state');
    assert.ok(helper.includes('/i'), 'preview helper must support manager proxy base path');
});

test('manager frontend exposes lifecycle controls without hiding discovery actions', () => {
    const app = read('public/manager/src/App.tsx');
    const api = read('public/manager/src/api.ts');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const types = read('public/manager/src/types.ts');

    assert.ok(types.includes('DashboardLifecycleCapability'), 'frontend types must include lifecycle capability');
    assert.ok(types.includes("'manager'"), 'frontend service mode must represent manager-owned instances');
    assert.ok(app.includes('handleLifecycle'), 'manager UI must keep lifecycle controller');
    assert.ok(api.includes('fresh'), 'manager instance API must support cache-busting fresh scans');
    assert.ok(app.includes('await load(showHidden, true)'), 'lifecycle completion must refresh the full scan with ?fresh=1');
    assert.ok(app.includes('if (polled.instance)'), 'lifecycle polling must patch the row with live single-port status before full reload');
    assert.ok(app.includes('view.setSelectedPort(instance.port);'), 'lifecycle actions must focus the target instance immediately');
    assert.ok(row.includes("onLifecycle('start'"), 'manager UI must expose Start action');
    assert.ok(row.includes("onLifecycle('stop'"), 'manager UI must expose Stop action');
    assert.ok(row.includes('Open'), 'manager UI must keep Open action');
});

test('manager instance activity unread badges are row-scoped and registry-backed', () => {
    const app = read('public/manager/src/App.tsx');
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const rail = read('public/manager/src/components/SidebarRail.tsx');
    const helper = read('public/manager/src/activity-unread.ts');
    const hook = read('public/manager/src/hooks/useActivityUnread.ts');
    const messageHook = read('public/manager/src/hooks/useInstanceMessageEvents.ts');
    const types = read('public/manager/src/types.ts');

    assert.ok(helper.includes('isUnreadActivityEvent'), 'activity unread helper must classify response events');
    assert.ok(helper.includes('countUnreadActivityEvents'), 'activity unread helper must expose count derivation');
    assert.ok(helper.includes('countUnreadActivityEventsByPort'), 'activity unread helper must expose per-instance count derivation');
    assert.ok(helper.includes('latestManagerEventAt'), 'activity unread helper must expose mark-seen timestamp derivation');
    assert.ok(helper.includes('latestManagerEventAtForPort'), 'activity unread helper must expose per-port mark-seen timestamp derivation');
    assert.ok(helper.includes('activityEventDedupeKey'), 'activity unread helper must dedupe repeated events');
    assert.ok(helper.includes("event.kind === 'instance-message' && event.role === 'assistant'"), 'only assistant messages must count for unread activity');
    assert.equal(helper.includes("event.kind === 'health-changed'"), false, 'health changes must not inflate response unread counts');
    assert.equal(helper.includes("event.kind === 'lifecycle-result'"), false, 'lifecycle events must not inflate response unread counts');
    assert.equal(helper.includes("event.kind === 'port-collision'"), false, 'port collisions must not inflate response unread counts');
    assert.ok(hook.includes('seenActivityAt'), 'activity unread hook must track the last seen activity timestamp');
    assert.ok(hook.includes('seenActivityByPort'), 'activity unread hook must track per-port seen timestamps');
    assert.ok(hook.includes('markPortSeen'), 'activity unread hook must expose click-to-clear behavior for one row');
    assert.ok(hook.includes('Date.parse(latest) <= Date.parse(portSeenAt)'), 'markPortSeen must avoid redundant per-port seen saves');
    assert.equal(
        hook.includes('Date.parse(latest) <= Date.parse(seenActivityAt)'),
        false,
        'markPortSeen must NOT short-circuit on the global seen ceiling — per-port suppression is independent',
    );
    assert.ok(app.includes('activitySeenAt'), 'App must hydrate/persist activitySeenAt through registry UI');
    assert.ok(app.includes('activitySeenByPort'), 'App must hydrate/persist per-port activity seen state');
    assert.equal(
        hook.includes('if (!options.activityDockCollapsed) return {}'),
        false,
        'opening the Activity dock must NOT wipe per-port badges for other ports',
    );
    assert.ok(hook.includes('activePreviewPort'), 'activity unread hook must accept the currently-viewed iframe port to suppress its own badge only');
    assert.ok(app.includes('activityUnread.unreadByPort'), 'App must pass per-port unread counts into instance groups');
    assert.ok(app.includes('const activityEvents = useMemo'), 'App must derive one combined activity stream for dock and unread state');
    assert.ok(app.includes('return [...managerEvents.events, ...messageActivity.events]'), 'App must include instance message events in the Activity dock stream');
    assert.ok(appChrome.includes('managerEvents={props.activityEvents}'), 'SidebarRailRouter must receive the combined activity stream');
    assert.ok(app.includes('useInstanceMessageEvents(instances)'), 'App must poll instance messages without dashboard refresh');
    assert.ok(app.includes('activityUnread.markPortSeen'), 'App must mark the selected instance as seen when clicked');
    assert.equal(
        app.includes('messageActivity.events, managerEvents.events, selectedInstance, view.activeDetailTab, view.selectedPort'),
        false,
        'new message events must not auto-clear sidebar unread badges while Preview is selected',
    );
    assert.ok(app.includes('activityUnreadOpenAndMarkSeen={activityUnread.openAndMarkSeen}'), 'App must pass the mobile Activity seen handler through AppChrome');
    assert.ok(appChrome.includes('onToggleActivityFromMobile={props.activityUnreadOpenAndMarkSeen}'), 'mobile Activity open path must mark events as seen');
    assert.ok(types.includes('activitySeenAt: string | null'), 'frontend registry UI type must include activitySeenAt');
    assert.ok(types.includes('activitySeenByPort: Record<string, string>'), 'frontend registry UI type must include per-port seen state');
    assert.ok(groups.includes('activityUnreadByPort'), 'InstanceGroups must accept per-port unread counts');
    assert.ok(row.includes('activityUnreadCount'), 'InstanceRow must accept unread count');
    assert.ok(row.includes('onMarkActivitySeen'), 'InstanceRow must clear the clicked instance unread count');
    assert.ok(row.includes('instance-unread-badge'), 'InstanceRow must render the compact row badge');
    assert.ok(row.includes('99+'), 'InstanceRow badge must cap large counts');
    assert.ok(rail.includes('aria-label="Instances"'), 'SidebarRail must expose the Instances workspace mode');
    assert.ok(rail.includes('aria-label="Notes"'), 'SidebarRail must expose the Notes workspace mode');
    assert.ok(rail.includes("onModeChange('settings')"), 'SidebarRail must switch to Dashboard settings mode');
    assert.ok(rail.includes('aria-label="Dashboard settings"'), 'SidebarRail must expose Dashboard settings without duplicating Workbench Settings');
    assert.equal(rail.includes('label="Preview"'), false, 'SidebarRail must not duplicate the Workbench preview tab');
    assert.equal(rail.includes('label="Activity"'), false, 'SidebarRail must not duplicate the Activity dock toggle');
    assert.equal(rail.includes('label="Settings"'), false, 'SidebarRail must not duplicate the Workbench settings tab');
    assert.equal(rail.includes('activityUnreadCount'), false, 'SidebarRail must not show the unread count on the top Activity item');
    assert.equal(rail.includes('rail-badge'), false, 'SidebarRail must not render the Activity unread badge');
    assert.equal(app.includes('attention-badge'), false, 'manager dashboard must not import legacy chat attention badge');
    assert.equal(app.includes('setAppBadge'), false, 'manager dashboard must not use browser app badge APIs');
    assert.equal(app.includes('document.title'), false, 'manager dashboard must not mutate document title for unread activity');
    assert.ok(messageHook.includes('/i/${port}/api/messages/latest'), 'message unread hook must poll only the latest proxied instance message');
    assert.equal(messageHook.includes('api/messages`'), false, 'message unread hook must not poll full message history');
    assert.ok(messageHook.includes('POLL_INTERVAL_MS = 5_000'), 'message unread hook must refresh without manual dashboard reload');
    assert.ok(messageHook.includes('previousId == null'), 'message unread hook must baseline existing messages without backfilling badges');
});

test('manager lifecycle message can be dismissed', () => {
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const components = read('public/manager/src/manager-components.css');

    assert.ok(router.includes('className="state lifecycle-state"'), 'lifecycle message must keep its status banner styling');
    assert.ok(router.includes('aria-label="Dismiss lifecycle message"'), 'lifecycle message must expose a dismiss button');
    assert.ok(router.includes('onClick={props.onDismissLifecycleMessage}'), 'dismiss button must clear lifecycleMessage');
    assert.ok(components.includes('.state-dismiss'), 'dismiss button must have dedicated compact styling');
    assert.ok(components.includes('overflow-wrap: anywhere'), 'long lifecycle errors must wrap inside the banner');
});

test('manager instance rows support custom labels and latest activity titles', () => {
    const app = read('public/manager/src/App.tsx');
    const list = read('public/manager/src/components/InstanceListContent.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const labelHook = read('public/manager/src/hooks/useInstanceLabelEditor.ts');
    const messageHook = read('public/manager/src/hooks/useInstanceMessageEvents.ts');
    // /api/messages/latest lives in routes/messages.ts since the Phase 2 extraction
    // it is the last handler there, so slice to end of file.
    const server = read('src/routes/messages.ts');
    const db = read('src/core/db.ts');
    const latestRoute = server.slice(
        server.indexOf("app.get('/api/messages/latest'"),
    );

    assert.ok(app.includes('useInstanceLabelEditor'), 'App must use a focused hook for custom label persistence');
    assert.ok(app.includes('messageActivity.titlesByPort'), 'App must pass latest activity titles into the instance list');
    assert.ok(app.includes('messageActivity.titleSupportByPort'), 'App must summarize latest-title endpoint support by instance');
    assert.ok(app.includes('messageActivity.events'), 'App must keep message events in the unread derivation');
    assert.ok(list.includes('latestTitleByPort'), 'InstanceListContent must accept latest title map');
    assert.ok(list.includes('showLatestActivityTitles'), 'InstanceListContent must accept latest title visibility preference');
    assert.ok(list.includes('showInlineLabelEditor'), 'InstanceListContent must accept label editor visibility preference');
    assert.ok(list.includes('showSidebarRuntimeLine'), 'InstanceListContent must accept runtime line visibility preference');
    assert.ok(list.includes('showSelectedRowActions'), 'InstanceListContent must accept selected action visibility preference');
    assert.ok(list.includes('onInstanceLabelSave'), 'InstanceListContent must accept custom label save callback');
    assert.ok(groups.includes('latestActivityTitle={props.latestTitleByPort?.[instance.port] || null}'), 'InstanceGroups must attach titles to matching ports');
    assert.ok(groups.includes('onInstanceLabelSave={props.onInstanceLabelSave}'), 'InstanceGroups must forward label save callback');
    assert.ok(row.includes('instance-label-edit-button'), 'InstanceRow must expose a rename affordance');
    assert.ok(row.includes('instance-label-edit-form'), 'InstanceRow must render inline label edit form');
    assert.ok(row.includes('props.instance.label || props.profile?.label || props.label'), 'explicit instance labels must override profile/generated labels');
    assert.ok(row.includes('instance-row-activity-title'), 'InstanceRow must render a one-line latest activity title');
    assert.ok(labelHook.includes("instances: { [String(port)]: { label: nextLabel } }"), 'label save must patch the registry instance entry');
    assert.ok(labelHook.includes('label?.trim() || null'), 'blank label must clear to fallback');
    assert.ok(messageHook.includes('InstanceMessageActivityState'), 'message hook must return both unread events and titles');
    assert.ok(messageHook.includes('titlesByPort'), 'message hook must derive titles by port');
    assert.ok(messageHook.includes('titleSupportByPort'), 'message hook must expose per-port title support status');
    assert.ok(messageHook.includes("nextSupport[instance.port] = 'offline'"), 'message hook must clear title support for offline instances');
    assert.ok(messageHook.includes('latestAssistantFromEnvelope'), 'message hook must preserve legacy assistant unread baseline');
    assert.ok(messageHook.includes('notifiableAssistantFromEnvelope'), 'message hook must wait for assistant activity before unread notification on new endpoint envelopes');
    assert.ok(latestRoute.includes("app.get('/api/messages/latest'"), 'backend must extend the existing latest endpoint');
    assert.ok(latestRoute.includes('latestAssistant'), 'latest endpoint must preserve latest assistant field');
    assert.ok(latestRoute.includes('activity:'), 'latest endpoint must include latest activity title payload');
    assert.ok(db.includes('substr(content, 1, 240) AS excerpt'), 'latest activity query must fetch only a bounded content excerpt');
    assert.equal(latestRoute.includes('getMessages.all()'), false, 'latest endpoint must not fetch full message history');
});

test('manager workbench modes remain instance-only while Notes renders outside Workbench', async () => {
    const app = read('public/manager/src/App.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const renderer = read('public/manager/src/notes/rendering/MarkdownRenderer.tsx');

    assert.ok(router.includes('NotesWorkspace'), 'SidebarRailRouter must render the Notes workspace');
    assert.ok(router.includes('DashboardSettingsWorkspace'), 'SidebarRailRouter must render Dashboard settings outside Workbench');
    assert.ok(router.includes("props.sidebarMode === 'notes'"), 'Notes must be selected by workspace mode, not a Workbench tab');
    assert.ok(router.includes("props.sidebarMode === 'settings'"), 'Dashboard settings must be selected by workspace mode, not a Workbench tab');
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { JSDOM } = await import('jsdom');
    const { Workbench } = await import('../../public/manager/src/components/Workbench');
    const globals = globalThis as unknown as Record<string, unknown>, previous = globals['React'];
    globals['React'] = React;
    try {
        const dom = new JSDOM(renderToStaticMarkup(React.createElement(Workbench, { mode: 'preview', active: true,
            onModeChange() {}, header: null, overview: null, logs: null, preview: React.createElement('iframe') })));
        assert.deepEqual([...dom.window.document.querySelectorAll('[role="tab"]')].map(el => el.textContent), ['Overview', 'Preview', 'Logs']);
        assert.equal(dom.window.document.querySelector('.workbench-settings-page'), null,
            'settings belong to the rail workspace, not the Workbench');
        assert.equal(dom.window.document.querySelector('[data-preview-host]')?.hasAttribute('hidden'), false);
        dom.window.close();
    } finally { globals['React'] = previous; }
    assert.equal(workbench.includes("'notes'"), false, 'Workbench must not add Notes as a detail tab');
    assert.ok(app.includes('notesSelectedPath'), 'App must hydrate and persist selected note path');
    assert.ok(app.includes('notesViewMode'), 'App must hydrate and persist Notes view mode');
    assert.ok(renderer.includes('splitPreviewFrontmatter'), 'Preview must strip leading YAML frontmatter before rendering body prose');
    assert.equal(renderer.includes('./wysiwyg/'), false, 'MarkdownRenderer must not import WYSIWYG-only frontmatter helpers');
});

test('manager process control panel exposes safe managed-process actions only', () => {
    const panel = read('public/manager/src/components/ProcessControlPanel.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const api = read('public/manager/src/api.ts');
    const types = read('public/manager/src/types.ts');
    const server = read('src/manager/server.ts');

    assert.ok(detail.includes('ProcessControlPanel'), 'overview must render the process control panel');
    assert.ok(panel.includes('Stop all managed'), 'panel must expose Stop all managed');
    assert.ok(panel.includes('Adopt/recover'), 'panel must expose Adopt/recover');
    assert.ok(panel.includes('Force release port'), 'panel must show force release as a planned control');
    assert.ok(panel.includes('<button type="button" disabled'), 'force release must not be clickable in this slice');
    assert.ok(api.includes('/api/dashboard/process-control/stop-managed'), 'frontend API must call stop-managed');
    assert.ok(api.includes('/api/dashboard/process-control/adopt'), 'frontend API must call adopt');
    assert.ok(types.includes('DashboardProcessControlState'), 'frontend types must include process control state');
    assert.ok(server.includes('/api/dashboard/process-control/force-release'), 'backend must explicitly reject force release for now');
    assert.ok(server.includes('501'), 'force release route must be unsupported until strict proof exists');
});

test('manager frontend keeps rows compact while preserving model visibility', () => {
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const compact = read('public/manager/src/manager-p0-1-1.css');
    const polish = read('public/manager/src/manager-polish.css');
    const main = read('public/manager/src/main.tsx');

    assert.ok(row.includes('instance-row-runtime'), 'instance rows must expose CLI/model as a stable runtime line');
    assert.ok(row.includes('instance-row-version'), 'instance rows must keep version metadata addressable');
    assert.ok(row.includes('instance-row-reason'), 'instance rows must keep reason metadata addressable');
    assert.ok(main.includes('./manager-p0-1-1.css'), 'P0-1.1 compact manager CSS must stay loaded');
    assert.ok(main.includes('./manager-dashboard-settings.css'), 'dashboard settings styling must be split into its own CSS module');
    assert.ok(
        main.indexOf('./manager-p0-1-1.css') < main.indexOf('./manager-dashboard-settings.css'),
        'dashboard settings CSS may layer after compact row polish',
    );
    assert.ok(compact.includes('.manager-sidebar .instance-row-version'), 'sidebar polish must hide secondary row metadata in compact mode');
    assert.ok(compact.includes('.manager-sidebar .instance-actions'), 'sidebar polish must control action-row density');
    // 260902 t3 shell (wp2): width lives in useSidebarWidth (default 300,
    // min 220, collapsed 44) and WorkspaceLayout writes the variable.
    const sidebarWidthHook = read('public/manager/src/hooks/useSidebarWidth.ts');
    const workspaceLayout = read('public/manager/src/components/WorkspaceLayout.tsx');
    assert.ok(sidebarWidthHook.includes('SIDEBAR_WIDTH_DEFAULT = 300'), 'expanded sidebar default must stay compact enough to leave preview room');
    assert.ok(sidebarWidthHook.includes('SIDEBAR_MAIN_CONTENT_MIN_WIDTH = 640'), 'sidebar max must reserve main content width');
    assert.ok(workspaceLayout.includes('SIDEBAR_COLLAPSED_WIDTH'), 'sidebar collapse must reclaim detail width through the collapsed constant');
    assert.ok(!/--sidebar-width:\s*(300|280)px/.test(polish), 'polish CSS must not reassign --sidebar-width (JS-owned)');
});

test('manager sidebar actions stay compact and active-group owned', () => {
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const components = read('public/manager/src/manager-components.css');
    const polish = read('public/manager/src/manager-polish.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(groups.includes("group.id === 'active' ? 'active' : 'normal'"), 'only the synthetic Active group should mark rows priority-active');
    assert.ok(groups.includes('priority={priority}'), 'InstanceGroups must pass row priority into InstanceRow');
    assert.ok(row.includes('aria-label="Preview"'), 'compact Prev label must preserve full Preview accessibility text');
    assert.ok(row.includes('Prev'), 'row actions must use compact Prev label');
    assert.ok(row.includes('aria-label="Restart"'), 'compact Res label must preserve full Restart accessibility text');
    assert.ok(row.includes('Res'), 'row actions must use compact Res label');
    assert.ok(components.includes('.instance-row.priority-active.is-selected,'), 'selected tint must cover the top Active row');
    assert.ok(components.includes('.instance-row:not(.priority-active).is-selected {'), 'ordinary selected rows must get a readable selected affordance');
    assert.ok(components.includes('background: var(--accent-soft);'), 'selected rows must use the quiet accent-soft surface');
    assert.equal(components.includes('box-shadow: inset 3px 0 0'), false, 'selected rows must not use a thick left edge stripe');
    assert.equal(components.includes('.instance-row.is-selected {'), false, 'selected styling must stay scoped by row priority');
    assert.equal(components.includes('.instance-row.priority-active.is-selected::before'), false, 'selected Active rows must not render an overlay edge stripe');
    assert.equal(components.includes('.instance-row.is-selected::before'), false, 'ordinary selected rows must not receive the Active-group overlay stripe');
    for (const css of [polish, compact]) {
        assert.ok(css.includes('.manager-sidebar .instance-row.priority-active .instance-actions'), 'Active group rows must always expose compact actions');
        assert.equal(css.includes('.manager-sidebar .instance-row:not(.priority-active).is-selected .instance-actions'), false, 'normal selected rows must keep the three-line text state until hover or focus');
        assert.ok(css.includes('.manager-sidebar .instance-row:not(.priority-active):hover .instance-actions'), 'normal hovered rows must show compact actions');
        assert.ok(css.includes('.manager-sidebar .instance-row:not(.priority-active):focus-within .instance-actions'), 'normal focused rows must show compact actions');
        assert.equal(css.includes('.manager-sidebar .instance-row:not(.priority-active).is-selected .instance-row-meta'), false, 'normal selected rows must keep activity/runtime metadata visible');
        assert.ok(css.includes('.manager-sidebar .instance-row:not(.priority-active):hover .instance-row-meta'), 'normal hovered rows must hide metadata when actions are shown');
        assert.ok(css.includes('.manager-sidebar .instance-row:not(.priority-active):focus-within .instance-row-meta'), 'normal focused rows must hide metadata when actions are shown');
        assert.ok(css.includes('min-height: 24px'), 'sidebar action buttons must use compact button height');
        assert.ok(css.includes('font-size: 10.5px'), 'sidebar action buttons must use compact text size');
    }
});

test('manager dashboard settings workspace controls sidebar display preferences', () => {
    const app = read('public/manager/src/App.tsx');
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const view = read('public/manager/src/hooks/useDashboardView.ts');
    const registry = read('src/manager/registry.ts');
    const workspace = read('public/manager/src/dashboard-settings/DashboardSettingsWorkspace.tsx');
    const developer = read('public/manager/src/dashboard-settings/DashboardDeveloperSettingsSection.tsx');
    const sidebar = read('public/manager/src/dashboard-settings/DashboardSettingsSidebar.tsx');
    const helper = read('public/manager/src/dashboard-settings/activity-title-support.ts');
    const css = read('public/manager/src/manager-dashboard-settings.css');
    const types = read('public/manager/src/types.ts');
    const api = read('public/manager/src/api.ts');
    const shortcuts = read('public/manager/src/manager-shortcuts.ts');

    assert.ok(app.includes('dashboardSettingsUiFromView'), 'App must derive settings UI from live view state');
    assert.ok(app.includes('handleDashboardSettingsPatch'), 'App must patch dashboard settings through registry UI');
    assert.ok(app.includes('actionForShortcutEvent'), 'App must route Manager global shortcuts through the shortcut helper');
    assert.ok(app.includes('isManagerShortcutEditableTarget'), 'App must ignore Manager shortcuts inside editors and inputs');
    assert.ok(view.includes('showLatestActivityTitles'), 'view hook must own latest title visibility');
    assert.ok(view.includes('showInlineLabelEditor'), 'view hook must own inline label editor visibility');
    assert.ok(view.includes('showSidebarRuntimeLine'), 'view hook must own runtime line visibility');
    assert.ok(view.includes('showSelectedRowActions'), 'view hook must own selected row action visibility');
    assert.ok(view.includes('dashboardShortcutsEnabled'), 'view hook must own global shortcut enabled state');
    assert.ok(view.includes('dashboardShortcutKeymap'), 'view hook must own the configurable shortcut keymap');
    assert.ok(view.includes('diffRootPolicy'), 'view hook must own git diff root policy');
    assert.ok(view.includes('diffRecentRepoRoots'), 'view hook must own recent git diff repositories');
    assert.ok(view.includes('diffDefaultMode'), 'view hook must own default git diff mode');
    assert.ok(view.includes('diffIncludeUntracked'), 'view hook must own untracked diff preference');
    assert.ok(registry.includes("'settings'"), 'registry sidebar mode must support Dashboard settings mode');
    assert.ok(registry.includes('showLatestActivityTitles: true'), 'registry defaults must enable latest activity titles');
    assert.ok(registry.includes('dashboardShortcutsEnabled: true'), 'registry defaults must enable dashboard shortcuts');
    assert.ok(registry.includes("diffRootPolicy: 'project-first'"), 'registry defaults must prefer selected instance project roots for diff');
    assert.ok(registry.includes('diffRecentRepoRoots: []'), 'registry defaults must start with no recent diff repositories');
    assert.ok(registry.includes("diffDefaultMode: 'unstaged'"), 'registry defaults must open unstaged diff');
    assert.ok(registry.includes('diffIncludeUntracked: true'), 'registry defaults must include untracked files');
    assert.ok(registry.includes('DEFAULT_DASHBOARD_SHORTCUT_KEYMAP'), 'registry must normalize a configurable shortcut keymap');
    assert.ok(shortcuts.includes('DEFAULT_MANAGER_SHORTCUT_KEYMAP'), 'frontend must define a default Manager shortcut map');
    assert.ok(shortcuts.includes('shortcutMatches'), 'frontend must parse shortcut chords through a testable helper');
    assert.ok(types.includes("DashboardActivityTitleSupportStatus = 'ready' | 'legacy' | 'offline'"), 'frontend types must name latest-title support states');
    assert.ok(types.includes('DashboardShortcutKeymap'), 'frontend types must include a configurable shortcut keymap');
    assert.equal(workspace.includes('ToggleField'), false, 'dashboard settings must not reuse the instance settings toggle layout');
    assert.ok(developer.includes('Repo root priority'), 'developer settings must expose diff root priority');
    assert.ok(developer.includes('Default diff mode'), 'developer settings must expose default diff mode');
    assert.ok(developer.includes('Default base ref'), 'developer settings must expose base ref');
    assert.ok(developer.includes('Include untracked'), 'developer settings must expose untracked toggle');
    assert.ok(types.includes('diffPinnedRootByPort'), 'frontend types must preserve per-instance pinned diff roots through the shared UI object');
    assert.ok(types.includes('diffRecentRepoRoots'), 'frontend types must preserve recent picked diff roots through the shared UI object');
    assert.ok(appChrome.includes('locale={props.view.locale}'), 'settings sidebar must receive the saved dashboard locale');
    assert.equal(workspace.includes('fetchDashboardRuntimeSettings'), false, 'manager dashboard must not call missing root /api/settings for locale');
    assert.equal(workspace.includes('updateDashboardRuntimeSettings'), false, 'manager dashboard must not PUT missing root /api/settings for locale');
    assert.ok(helper.includes('summarizeActivityTitleSupport'), 'support helper must aggregate per-port support status');
    assert.equal(api.includes("fetch('/api/settings'"), false, 'manager API must not call unavailable root settings routes from dashboard mode');
    assert.ok(css.includes('.dashboard-settings-workspace'), 'settings CSS must use dashboard-settings prefix');
    assert.ok(css.includes('.dashboard-settings-row'), 'settings CSS must align each setting in a scoped row');
    assert.ok(css.includes('.dashboard-settings-select'), 'settings CSS must style dashboard language select');
    assert.ok(css.includes('.dashboard-settings-shortcut-input'), 'settings CSS must size shortcut keymap inputs');
    assert.equal(css.includes('.settings-workspace'), false, 'settings CSS must not collide with existing settings-shell prefix');
});

test('manager instance rows are selectable independently from preview availability', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');

    assert.ok(row.includes('className="instance-row-select"'), 'instance row body must expose a dedicated select control');
    assert.ok(row.includes('type="button"'), 'instance row selection must be button-based and keyboard reachable');
    assert.ok(row.includes('onSelect(props.instance)'), 'row click/key must select the row instance');
    assert.ok(groups.includes('onSelect={props.onSelect}'), 'group list must forward row selection');
    // 10.6.10 — row selection must preserve the active workbench tab (no
    // forced reset to overview) so users keep their Preview/Logs/Settings
    // context when hopping between instances. Explicit jumps stay on
    // handlePreview.
    assert.ok(!app.includes("view.setActiveDetailTab('overview')"), 'row selection must NOT force-reset detail tab');
    assert.ok(app.includes('view.setDrawerOpen(false)'), 'row selection must close the mobile drawer');
});

test('manager navigator does not exclude the selected instance from profile groups', () => {
    const app = read('public/manager/src/App.tsx');
    const navigator = read('public/manager/src/components/InstanceNavigator.tsx');
    const list = read('public/manager/src/components/InstanceListContent.tsx');

    assert.equal(app.includes('renderInstanceListContent(true)'), false, 'selected instance must remain in the grouped list after removing duplicate active card');
    assert.equal(app.includes('filtered.filter(instance => instance.port !== selectedInstance.port)'), false, 'App must not remove selected instances from sidebar groups');
    assert.ok(list.includes('[props.selectedInstance, ...props.filtered]'), 'extracted instance list must keep selected instances visible even when filters exclude them');
    assert.equal(navigator.includes('InstanceRow'), false, 'InstanceNavigator must not render a second selected instance card');
});

test('manager profile rows keep Selected/Running grouping while merging profile labels into rows', () => {
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const components = read('public/manager/src/manager-components.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');

    assert.equal(groups.includes("import { ProfileSection }"), false, 'profile groups must not render a separate profile header card');
    assert.ok(groups.includes('is-profile-merged'), 'profile instance groups must expose merged-row styling');
    assert.ok(groups.includes("{ id: 'active', label: 'Selected'"), 'selected summary keeps the stable active group id');
    assert.ok(groups.includes("label: 'Running'"), 'profile merged sidebar must preserve the Running group header');
    assert.equal(groups.includes('selected.forEach(instance => used.add(instance.port))'), false, 'selected active/running rows must remain in their original Running group');
    assert.ok(groups.includes('profileMap.get(instance.profileId)'), 'profile context must be resolved per grouped instance row');
    assert.ok(groups.includes('{ profile }'), 'profile context must be forwarded into the row');
    assert.equal(groups.includes('No online instances for this profile.'), false, 'sidebar must not replace instance groups with profile-empty cards');
    assert.ok(row.includes('props.profile?.label'), 'instance row must use the profile label as the primary merged label');
    assert.equal(row.includes('instanceSecondaryLine'), false, 'instance row must not add path metadata under compact sidebar labels');
    assert.ok(row.includes('instance-row-transition'), 'instance row may still show transition state under the primary label');
    assert.ok(compact.includes('.profile-instance-groups.is-profile-merged .instance-row-main'), 'merged sidebar rows must align primary labels from the top-left row area');
    assert.ok(components.includes('.instance-row-select'), 'base row select styling must exist');
    assert.ok(components.includes('justify-self: stretch'), 'all selected rows must keep the same left alignment width');
    assert.ok(components.includes('width: 100%; min-height: 0'), 'base row selection must span the full row width');
    assert.ok(compact.includes('justify-self: stretch'), 'selected rows must not shrink their select area and visually center labels');
    assert.ok(compact.includes('width: 100%'), 'selected and non-selected rows must share the same left alignment width');
});

test('manager frontend routes layout through responsive shell components', () => {
    const app = read('public/manager/src/App.tsx');
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');

    assert.ok(appChrome.includes('ManagerShell'), 'AppChrome must use ManagerShell after 10.5.2 extraction');
    assert.ok(appChrome.includes('CommandBar'), 'AppChrome must render CommandBar');
    assert.ok(app.includes('InstanceListContent'), 'App must render grouped instance list through extracted content');
    assert.ok(router.includes('ActivityDock'), 'SidebarRailRouter must render ActivityDock');
    assert.ok(workbench.includes("'overview'"), 'workbench must expose Overview tab');
    assert.ok(workbench.includes("'preview'"), 'workbench must expose Preview tab');
    assert.ok(workbench.includes("'logs'"), 'workbench must expose Logs tab');
    assert.ok(detail.includes("props.activeTab === 'overview'"), 'detail panel must render Overview content');
    assert.ok(detail.includes("props.activeTab === 'logs'"), 'detail panel must render Logs content');
    assert.equal(detail.includes("props.activeTab === 'settings'"), false,
        'the detail panel settings branch was unreachable after the rail took over and must stay gone');
});

test('manager frontend exposes 10.6 persistence controls', () => {
    const app = read('public/manager/src/App.tsx');
    const hook = read('public/manager/src/hooks/useDashboardRegistry.ts');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const dashboardMeta = read('public/manager/src/settings/pages/DashboardMeta.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const command = read('public/manager/src/components/CommandBar.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(hook.includes('patchDashboardRegistry'), 'registry hook must save dashboard registry patches');
    assert.ok(app.includes('useDashboardRegistry'), 'App must hydrate and save registry state');
    assert.equal(detail.includes('SettingsShell'), false,
        'the detail panel must not mount a second settings surface');
    assert.ok(dashboardMeta.includes('Pin favorite'), 'Dashboard meta must expose favorite pinning');
    assert.ok(dashboardMeta.includes('Hide by default'), 'Dashboard meta must expose hidden state');
    assert.ok(groups.includes("id: 'active'"), 'InstanceGroups must keep active row in a top group');
    assert.ok(groups.includes("id: 'favorites'"), 'InstanceGroups must keep pinned favorites near the top');
    assert.equal(command.includes('onScanRangeCommit'), false, 'CommandBar must not carry scan controls in the top row');
    assert.ok(main.includes('./manager-persistence.css'), 'manager persistence styling must be split into its own CSS module');
});

test('manager frontend exposes 10.8 profile controls', () => {
    const app = read('public/manager/src/App.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileChip.tsx')), 'ProfileChip must exist');
    assert.ok(existsSync(join(projectRoot, 'public/manager/src/components/ProfileSection.tsx')), 'ProfileSection must exist');
    assert.ok(app.includes('activeProfileIds'), 'App must own active profile filter state');
    assert.ok(app.includes('activeProfileFilter'), 'App must persist active profile filters through registry');
    assert.ok(app.includes('effectiveProfileIds'), 'App must ignore stale profile filters that are absent from the current scan');
    assert.ok(app.includes('known.has(profileId)'), 'App must derive profile filtering from currently visible profile ids');
    assert.ok(groups.includes('is-profile-merged'), 'InstanceGroups must merge profile sections into instance rows');
    assert.ok(drawer.includes('drawer-profile-filters'), 'mobile drawer must mirror profile filters');
    assert.ok(main.includes('./manager-profiles.css'), 'profile styling must stay split from large CSS files');
});

test('board overall view limits done preview and exposes lane detail navigation', () => {
    const app = read('public/manager/src/App.tsx');
    const sidebar = read('public/manager/src/dashboard-board/DashboardBoardSidebar.tsx');
    const workspace = read('public/manager/src/dashboard-board/DashboardBoardWorkspace.tsx');
    const detail = read('public/manager/src/dashboard-board/BoardLaneDetailView.tsx');

    assert.ok(app.includes('boardView'), 'App must own Board view state');
    assert.ok(detail.includes('dashboard-board-compact-row'), 'Lane detail must render compact rows');
});

test('unified registry filters scopes, localizes navigation, and preserves Manager save ownership', async t => {
    const { JSDOM } = await import('jsdom');
    const React = await import('react');
    const { act } = React;
    const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', { url: 'http://localhost:24576' });
    const globals = globalThis as unknown as Record<string, unknown>;
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globals, values);
    const { createRoot } = await import('react-dom/client');
    const { SettingsShell } = await import('../../public/manager/src/settings/SettingsShell');
    const { SETTINGS_REGISTRY, entriesForScopes } = await import('../../public/manager/src/settings/settings-registry');
    const { defaultDashboardRegistry } = await import('../../src/manager/registry');
    const { normalizeManagerShortcutKeymap } = await import('../../public/manager/src/manager-shortcuts');
    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    t.after(async () => {
        await act(async () => root.unmount()); dom.window.close();
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key]; }
    });
    assert.equal(new Set(SETTINGS_REGISTRY.map(e => e.id)).size, SETTINGS_REGISTRY.length);
    const classic = entriesForScopes(['instance'], true, 'en');
    assert.ok(classic.some(e => e.id === 'channels-slack'));
    assert.ok(classic.every(e => e.scope === 'instance' && !e.hidden));
    assert.ok(!classic.some(e => e.id === 'telegram-hub' || e.id === 'dashboard-meta'));
    // Scope is the only visibility axis: the retired requiresInstance flag added a third,
    // undocumented state (manager-scoped but instance-gated) that hid a real bug.
    for (const entry of SETTINGS_REGISTRY) {
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'requiresInstance'), false,
            `registry entry ${entry.id} must not carry the removed requiresInstance flag`);
    }
    assert.equal(read('public/manager/src/settings/settings-registry.ts').includes('requiresInstance'), false,
        'settings-registry must not mention requiresInstance in type, entries, or filter');
    const managerOnly = entriesForScopes(['manager'], false, 'en');
    assert.ok(managerOnly.some(e => e.id === 'dashboard-meta'),
        'dashboard-meta is manager-scoped: the manager server owns /api/dashboard/registry');
    assert.ok(managerOnly.every(e => e.scope === 'manager' && !e.hidden));
    assert.ok(SETTINGS_REGISTRY.every(e => typeof e.load === 'function'));
    const saved = defaultDashboardRegistry().ui;
    let ui = { ...saved, locale: 'en' as const as import('../../public/manager/src/types').DashboardLocale,
        dashboardShortcutKeymap: normalizeManagerShortcutKeymap(saved.dashboardShortcutKeymap) };
    const managerWrites: unknown[] = [], instanceWrites: unknown[] = [];
    const client: import('../../public/manager/src/settings/types').SettingsClient = {
        async get() { throw new Error('Manager-only page must not request instance data'); },
        async put(path, body) { instanceWrites.push({ path, body }); throw new Error('Unexpected PUT'); },
        async post() { throw new Error('Unexpected POST'); }, async delete() { throw new Error('Unexpected DELETE'); },
    };
    const render = async () => {
        await act(async () => root.render(React.createElement(SettingsShell, { initialId: 'manager-display', client,
            scopes: ['instance', 'manager'], manager: { ui, titleSupport: { ready: 1, legacy: 2, offline: 3, byPort: {} },
                onUiPatch(patch) { managerWrites.push(patch); ui = { ...ui, ...patch }; } } })));
        await act(async () => { await SETTINGS_REGISTRY.find(e => e.id === 'manager-display')!.load(); });
    };
    await render();
    assert.equal(container.querySelectorAll('.settings-sidebar h2').length, 1);
    assert.equal(container.querySelector('.settings-sidebar h2')?.textContent, 'Manager');
    assert.equal(container.querySelectorAll('[role="tab"]').length, 0);
    for (const label of ['Instance list display', 'Recent activity preview', 'Rename control', 'Runtime line', 'Expanded row actions', 'Global shortcuts', 'Language', 'Left instance list']) {
        assert.ok(container.querySelector('.settings-page')?.textContent?.includes(label), label);
    }
    assert.equal(container.querySelector<HTMLInputElement>('#dashboard-shortcut-toggleInstanceSettings')?.value, 'Meta+,');
    const language = container.querySelector<HTMLSelectElement>('#dashboard-locale')!;
    await act(async () => { language.value = 'ko'; language.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.deepEqual(managerWrites.at(-1), { locale: 'ko' }); await render();
    assert.equal(container.querySelector('#dashboard-locale'), language, 'locale change preserves the active page node');
    assert.ok(container.textContent?.includes('인스턴스 목록 표시'));
    assert.ok(container.textContent?.includes('최근 작업 미리보기'));
    for (const [locale, label] of [['ko', '사이드바 행'], ['en', 'Sidebar rows'], ['ja', 'サイドバーの行'], ['zh', '侧边栏列表']] as const) {
        ui = { ...ui, locale }; await render();
        assert.equal(container.querySelector('[aria-current="page"]')?.textContent, label);
    }
    ui = { ...ui, locale: 'en' }; await render();
    const developer = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-sidebar button')).find(b => b.textContent === 'Developer tools')!;
    await act(async () => { developer.click(); await SETTINGS_REGISTRY.find(e => e.id === 'manager-developer')!.load(); });
    assert.ok(container.querySelector('.settings-page')?.textContent?.includes('Repo root priority'));
    assert.deepEqual(instanceWrites, []);
});

test('sidebar sibling layout preserves structural span display and named secondary metadata rules', () => {
    const components = read('public/manager/src/manager-components.css');
    const polish = read('public/manager/src/manager-polish.css');
    const compact = read('public/manager/src/manager-p0-1-1.css');
    assert.match(components, /\.instance-row-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
    assert.match(components, /\.instance-row-main\s*\{[^}]*grid-template-columns:\s*12px minmax\(0, 1fr\);/);
    assert.match(components, /\.instance-row-title\s*\{[^}]*display:\s*grid;/);
    for (const name of ['title-line', 'status-line']) {
        assert.match(components, new RegExp(`\\.instance-row-${name}\\s*\\{[^}]*display:\\s*flex;`));
    }
    for (const css of [components, polish, compact]) {
        assert.doesNotMatch(css, /\.instance-row-title\s+span\s*[,\{]/, 'structural spans must not inherit secondary metadata display rules');
    }
    for (const css of [polish, compact]) {
        assert.match(css, /\.instance-row-title \.instance-row-secondary\s*\{[^}]*display:\s*none;/);
    }
    assert.match(compact, /\.is-profile-merged \.instance-row-title \.instance-row-secondary\s*\{[^}]*display:\s*block;/);
    assert.match(components, /\.quick-btn:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/);
    assert.match(components, /@media \(pointer: coarse\)\s*\{\s*\.instance-row \.instance-row-quick \.quick-btn:not\(:disabled\):not\(\.is-disabled\)\s*\{[^}]*opacity:\s*1;/);
});


test('sidebar quick-action reveal consistently excludes disabled buttons and links', () => {
    const css = read('public/manager/src/manager-components.css');
    for (const state of [':hover', ':focus-within', '.is-selected']) {
        assert.ok(css.includes(`.instance-row${state} .instance-row-quick .quick-btn:not(:disabled):not(.is-disabled)`));
    }
    assert.doesNotMatch(css, /\.quick-btn:not\(:disabled\)(?!:not\(\.is-disabled\))/);
    assert.match(css, /\.quick-btn:disabled, \.quick-btn\.is-disabled\s*\{[^}]*pointer-events:\s*none;/);
});


test('narrow instance rows contain text and move whole quick actions below selection', () => {
    const css = read('public/manager/src/manager-components.css');
    assert.match(css, /\.instance-row\s*\{[^}]*container:\s*instance-row \/ inline-size;/);
    assert.match(css, /@container instance-row \(width < 240px\)\s*\{\s*\.instance-row-body\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
    assert.match(css, /@container instance-row[^]*?\.instance-row-quick\s*\{[^}]*justify-self:\s*end;[^}]*max-width:\s*100%;[^}]*flex-wrap:\s*wrap;/);
    assert.match(css, /\.instance-row-title\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    for (const selector of ['instance-row-title-line', 'instance-row-status-line']) {
        assert.match(css, new RegExp(`\\.${selector}\\s*\\{[^}]*width:\\s*100%;[^}]*max-width:\\s*100%;`));
    }
    assert.match(css, /\.instance-row-title strong\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/);
    assert.doesNotMatch(css, /\.(?:instance-row|instance-row-body|instance-row-quick|instance-row-select|quick-btn)\s*\{[^}]*overflow:\s*(?:hidden|clip)/);
});

test('sidebar status labels expose full text and explicit ellipsis', () => {
    const css = read('public/manager/src/manager-components.css');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    assert.match(css, /\.instance-row-status-pill\s*\{[^}]*text-overflow:\s*ellipsis;/);
    assert.ok(row.includes('title={statusLabel}'));
});
