import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function readManagerCss(): string {
    return [
        'public/manager/src/styles.css',
        'public/manager/src/manager-layout.css',
        'public/manager/src/manager-components.css',
        'public/manager/src/manager-persistence.css',
        'public/manager/src/manager-profiles.css',
        'public/manager/src/manager-notes.css',
        'public/manager/src/manager-dashboard-settings.css',
        'public/manager/src/panels/panels.css',
    ].map(read).join('\n');
}

function cssBlock(css: string, mediaQuery: string): string {
    const start = css.indexOf(mediaQuery);
    assert.notEqual(start, -1, `${mediaQuery} media query must exist`);

    let depth = 0;
    let blockStart = -1;
    for (let index = start; index < css.length; index += 1) {
        const char = css[index];
        if (char === '{') {
            depth += 1;
            if (blockStart === -1) {
                blockStart = index + 1;
            }
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0 && blockStart !== -1) {
                return css.slice(blockStart, index);
            }
        }
    }

    assert.fail(`${mediaQuery} media query must be closed`);
}

test('manager responsive components exist', () => {
    [
        'ManagerShell',
        'WorkspaceLayout',
        'Workbench',
        'SidebarRail',
        'CommandCenter',
        'CommandFilters',
        'CommandBar',
        'InstanceGroups',
        'InstanceNavigator',
        'InstanceRow',
        'InstanceDetailPanel',
        'ActivityDock',
        'MobileNav',
        'InstanceDrawer',
        'ProfileChip',
        'ProfileSection',
        'ProfileSummaryCard',
    ].forEach(name => {
        assert.equal(
            existsSync(join(projectRoot, 'public', 'manager', 'src', 'components', `${name}.tsx`)),
            true,
            `${name} component must exist`,
        );
    });
});

test('manager responsive CSS defines shell regions and breakpoints', () => {
    const css = readManagerCss();

    assert.ok(css.includes('manager-shell'), 'CSS must define manager shell');
    assert.ok(css.includes('grid-template-areas'), 'CSS must use named shell regions');
    assert.ok(css.includes('height: 100dvh'), 'manager shell/root must be viewport-height bounded');
    assert.ok(css.includes('grid-template-rows: max-content minmax(0, 1fr)'), 'command row must grow to fit persistence controls');
    assert.ok(css.includes('overflow: hidden'), 'page-level scroll must be disabled');
    assert.ok(css.includes('grid-template-areas: "command" "workspace"'), 'global frame must separate command center from workspace');
    assert.ok(css.includes('grid-template-areas: "sidebar center right" "sidebar bottom right"'), 'workspace must include unified sidebar plus desktop panel regions');
    assert.ok(css.includes('@media (min-width: 1440px)'), 'wide desktop breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 1279px) and (min-width: 1024px)'), 'desktop-sidebar breakpoint must be bounded above tablet');
    assert.ok(css.includes('@media (max-width: 1023px)'), 'tablet breakpoint must exist');
    assert.ok(css.includes('@media (max-width: 767px)'), 'mobile breakpoint must exist');
    assert.ok(css.includes('manager-mobile-nav'), 'mobile nav styling must exist');
    assert.ok(css.includes('drawer-backdrop'), 'drawer styling must exist');
    assert.ok(css.includes('command-primary'), 'command center primary row must exist');
    assert.equal(css.includes('command-secondary'), false, 'command center must not allocate a second command row');
    assert.equal(css.includes('instance-navigator-active'), false, 'navigator must not duplicate the selected instance outside the scroll body');
    assert.ok(css.includes('profile-chip-strip'), 'profile filters must have a stable horizontal strip');
    assert.ok(css.includes('notes-workspace'), 'notes workspace styling must exist');
    assert.ok(css.includes('dashboard-settings-workspace'), 'dashboard settings workspace styling must exist');
});

test('manager tablet and mobile breakpoints override desktop sidebar state', () => {
    const css = readManagerCss();
    const laptop = cssBlock(css, '@media (max-width: 1279px) and (min-width: 1024px)');
    const tablet = cssBlock(css, '@media (max-width: 1023px)');
    const mobile = cssBlock(css, '@media (max-width: 767px)');

    assert.ok(
        laptop.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'laptop breakpoint may keep desktop sidebar state only at 1024px and above',
    );
    assert.ok(
        tablet.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'tablet breakpoint must explicitly override the higher-specificity desktop sidebar selector',
    );
    assert.ok(
        tablet.includes('grid-template-columns: minmax(0, 1fr)'),
        'tablet breakpoint must collapse to one full-width column',
    );
    assert.ok(
        mobile.includes('.dashboard-shell.manager-shell:not(.is-sidebar-collapsed) .manager-workspace'),
        'mobile breakpoint must explicitly override the higher-specificity desktop sidebar selector',
    );
    assert.ok(
        mobile.includes('grid-template-columns: 1fr'),
        'mobile breakpoint must not retain a desktop sidebar column',
    );
});

test('manager Notes workspace has a mobile path without desktop sidebar forcing', () => {
    const css = read('public/manager/src/manager-notes.css');
    const mobile = cssBlock(css, '@media (max-width: 767px)');

    assert.ok(mobile.includes('.notes-workspace'), 'mobile breakpoint must include Notes workspace rules');
    assert.ok(mobile.includes('grid-template-columns: 1fr'), 'mobile Notes layout must collapse to one column');
    assert.ok(mobile.includes('.notes-tree'), 'mobile Notes tree must not be forced into the desktop sidebar column');
});

test('manager Dashboard settings workspace has a compact mobile path', () => {
    const css = read('public/manager/src/manager-dashboard-settings.css');
    const mobile = cssBlock(css, '@media (max-width: 767px)');

    assert.ok(css.includes('.dashboard-settings-workspace'), 'settings workspace must have a scoped layout root');
    assert.ok(css.includes('.dashboard-settings-row'), 'settings workspace must use aligned row controls');
    assert.ok(css.includes('.dashboard-settings-row-control'), 'settings workspace must keep controls aligned with labels');
    assert.ok(css.includes('.dashboard-settings-status-grid'), 'settings workspace must style title support status cards');
    assert.ok(mobile.includes('.dashboard-settings-workspace'), 'mobile breakpoint must include Dashboard settings workspace rules');
    assert.ok(mobile.includes('.dashboard-settings-row'), 'mobile breakpoint must include Dashboard settings row collapse');
    assert.ok(mobile.includes('.dashboard-settings-row-control'), 'mobile breakpoint must realign Dashboard settings controls');
    assert.ok(mobile.includes('grid-template-columns: 1fr'), 'mobile Dashboard settings status grid must collapse to one column');
});

test('manager desktop layout uses one unified sidebar', () => {
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const shell = read('public/manager/src/components/ManagerShell.tsx');
    const workspace = read('public/manager/src/components/WorkspaceLayout.tsx');
    const css = readManagerCss();

    assert.ok(router.includes('<WorkspaceLayout'), 'SidebarRailRouter must assemble navigator/workbench/inspector through WorkspaceLayout');
    assert.ok(router.includes('navigator={'), 'SidebarRailRouter must pass one navigator surface to WorkspaceLayout');
    assert.ok(appChrome.includes('sidebarCollapsed={props.view.sidebarCollapsed}'), 'AppChrome must pass sidebar collapse state to ManagerShell');
    assert.ok(router.includes('manager-sidebar-list'), 'SidebarRailRouter must place instance list inside the unified sidebar');
    assert.equal(shell.includes('manager-rail'), false, 'ManagerShell must not render a separate rail column');
    assert.equal(shell.includes('manager-list'), false, 'ManagerShell must not render a separate list column');
    assert.ok(workspace.includes('manager-sidebar'), 'WorkspaceLayout must render a single sidebar container');
    assert.ok(css.includes('grid-template-areas: "sidebar center right" "sidebar bottom right"'), 'desktop workspace grid must have one sidebar column and desktop panel regions');
    assert.ok(css.includes('is-sidebar-collapsed'), 'desktop sidebar must have a collapsed grid state');
    assert.equal(css.includes('grid-area: list'), false, 'CSS must not keep a separate list grid area');
    assert.equal(css.includes('grid-area: rail'), false, 'CSS must not keep a separate rail grid area');
});

test('manager UI state is persisted through 10.6 registry without localStorage', () => {
    const app = read('public/manager/src/App.tsx');
    const hook = read('public/manager/src/hooks/useDashboardView.ts');
    const registryHook = read('public/manager/src/hooks/useDashboardRegistry.ts');
    const drawer = read('public/manager/src/components/InstanceDrawer.tsx');
    const detail = read('public/manager/src/components/InstanceDetailPanel.tsx');
    const dashboardMeta = read('public/manager/src/settings/pages/DashboardMeta.tsx');
    const rail = read('public/manager/src/components/SidebarRail.tsx');

    assert.ok(hook.includes('activeDetailTab'), 'view hook must own detail tab state');
    assert.ok(hook.includes('drawerOpen'), 'view hook must own drawer state');
    assert.ok(hook.includes('activityDockCollapsed'), 'view hook must own activity dock state');
    assert.ok(hook.includes('activityDockHeight'), 'view hook must own runtime-only activity dock height');
    assert.ok(hook.includes('sidebarCollapsed'), 'view hook must own runtime-only sidebar collapse state');
    assert.ok(rail.includes('rail-collapse-button'), 'sidebar rail must expose a collapse button');
    assert.ok(rail.indexOf('rail-collapse-button') < rail.indexOf("onModeChange('instances')"), 'collapse button must be the leading rail control');
    assert.ok(rail.includes('aria-pressed={props.collapsed}'), 'collapse button must expose pressed state');
    assert.ok(drawer.includes("event.key === 'Escape'"), 'drawer must close on Escape');
    assert.ok(drawer.includes('previousFocusRef'), 'drawer must restore focus');
    assert.ok(drawer.includes('role="dialog"'), 'drawer must expose dialog semantics');
    assert.ok(detail.includes('InstanceLogsPanel'), 'Logs tab must mount the logs panel when an instance is selected');
    assert.equal(detail.includes('SettingsShell'), false,
        'the detail panel settings branch is unreachable and must not mount a second settings surface');
    assert.ok(dashboardMeta.includes('settings-form'), 'Dashboard meta must expose 10.6 persistence controls');
    assert.equal(app.includes('localStorage'), false, '10.5.x UI must not introduce localStorage persistence');
    assert.equal(hook.includes('localStorage'), false, 'view hook must not persist UI state yet');
    assert.equal(registryHook.includes('localStorage'), false, 'registry hook must not use localStorage');
    assert.ok(app.includes('saveUi'), 'App must persist selected UI state through the registry API');
});

test('manager instance activity unread badge has compact row styling', () => {
    const css = readManagerCss();

    assert.ok(css.includes('.instance-row-title-line'), 'instance row title line must align label and unread count');
    assert.ok(css.includes('.instance-unread-badge'), 'per-instance Activity unread badge styling must exist');
    assert.ok(css.includes('.instance-row-activity-title'), 'latest activity titles must have compact row styling');
    assert.ok(css.includes('.instance-label-input'), 'custom label edit input must have compact row styling');
    assert.ok(css.includes('.instance-label-edit-form'), 'custom label edit form must have compact row styling');
    assert.ok(css.includes('font-variant-numeric: tabular-nums'), 'Activity unread badge must keep counts stable');
    assert.equal(css.includes('.rail-badge'), false, 'Activity unread badge must not attach to the top rail');
});

test('manager activity dock is vertically resizable', () => {
    const appChrome = read('public/manager/src/AppChrome.tsx');
    const app = read('public/manager/src/App.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const shell = read('public/manager/src/components/ManagerShell.tsx');
    const dock = read('public/manager/src/components/ActivityDock.tsx');
    const css = readManagerCss();

    assert.ok(appChrome.includes('activityHeight={props.view.activityDockCollapsed ? 48 : props.view.activityDockHeight}'), 'AppChrome must drive shell activity height');
    assert.ok(app.includes('handleActivityHeight={handleActivityHeight}'), 'App must pass activity resize handler into AppChrome');
    assert.ok(appChrome.includes('onActivityHeightChange={props.handleActivityHeight}'), 'AppChrome must wire activity resize state');
    assert.ok(router.includes('onHeightChange={props.onActivityHeightChange}'), 'SidebarRailRouter must connect ActivityDock resize events to App state');
    assert.ok(shell.includes("'--activity-dock-height'"), 'ManagerShell must expose activity height as CSS variable');
    assert.ok(dock.includes('activity-resize-handle'), 'ActivityDock must render a resize handle');
    assert.ok(dock.includes('pointermove'), 'ActivityDock must handle pointer drag');
    assert.ok(dock.includes('clampActivityHeight'), 'ActivityDock must clamp drag height');
    assert.ok(css.includes('var(--activity-dock-height'), 'CSS grid must use runtime activity height');
    assert.ok(css.includes('cursor: ns-resize'), 'CSS must communicate vertical resizing');
});
