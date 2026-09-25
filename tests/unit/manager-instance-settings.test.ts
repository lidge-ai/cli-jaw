import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createInstanceSettingsNavigation, hydrateInstanceSettings, settingsDirtyAfter, useSettingsDirtyState, useDashboardView } from '../../public/manager/src/hooks/useDashboardView';
import { createManagerCaptureKeydownHandler, runManagerShortcut, type ManagerShortcutRunnerDeps } from '../../public/manager/src/manager-shortcut-runner';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, MANAGER_SHORTCUT_ACTIONS } from '../../public/manager/src/manager-shortcuts';
import type { DashboardRegistryPatch, DashboardRegistryUi, DashboardShortcutAction } from '../../public/manager/src/types';
import type { SettingsClient } from '../../public/manager/src/settings/types';

test('a legacy settings request restores the rail workspace, not a Workbench panel', () => {
    // The in-Workbench panel is gone. A registry written by an older client can still ask for
    // it two ways; both must land on the rail rather than on a tab that no longer exists.
    for (const flag of [undefined, false, true, 'true', 1, null]) {
        assert.deepEqual(hydrateInstanceSettings({ selectedTab: 'settings', sidebarMode: 'instances', instanceSettingsOpen: flag }),
            { selectedTab: 'overview', sidebarMode: 'settings' });
        assert.deepEqual(hydrateInstanceSettings({ selectedTab: 'logs', sidebarMode: 'instances', instanceSettingsOpen: flag }),
            { selectedTab: 'logs', sidebarMode: flag === true ? 'settings' : 'instances' });
    }
    // A saved rail mode survives untouched when no legacy request is present.
    assert.deepEqual(hydrateInstanceSettings({ selectedTab: 'logs', sidebarMode: 'notes' }),
        { selectedTab: 'logs', sidebarMode: 'notes' });

    // The pure function is only half of it: App must actually consume restored.sidebarMode.
    // An earlier revision computed it and then discarded it for ui.sidebarMode, so a legacy
    // registry silently landed on 'instances' while this assertion still passed.
    const app = readFileSync(new URL('../../public/manager/src/App.tsx', import.meta.url), 'utf8');
    assert.ok(app.includes('?? restored.sidebarMode'),
        'App must restore the migrated sidebar mode, not recompute it from the raw registry');
    assert.equal(app.includes('?? ui.sidebarMode'), false,
        'reading ui.sidebarMode directly discards the legacy settings migration');
});
test('the rail settings workspace honours the dirty guard on open and close', () => {
    type Args = Parameters<typeof createInstanceSettingsNavigation>[0];
    const writes: Parameters<Args['saveUi']>[0][] = [], cleared: string[] = [], modes: string[] = [];
    let allowed = false, prompts = 0;
    let sidebarMode: 'instances' | 'settings' = 'instances';
    const view: Args['view'] = { get sidebarMode() { return sidebarMode; }, activeDetailTab: 'preview',
        setSelectedPort() {}, setSidebarMode(next) { modes.push(next as string); sidebarMode = next as typeof sidebarMode; },
        setViewMode() {}, setDrawerOpen() {} };
    const nav = createInstanceSettingsNavigation({ view, selectedPort: 3457, settingsDirty: true,
        panelSettingsDirty: false, dashboardSettingsDirty: true,
        clearDirty: entry => cleared.push(entry), saveUi: async patch => { writes.push(patch); },
        confirmDiscard: () => { prompts++; return allowed; } });

    // Opening from 'instances' is not a departure from the dashboard, so nothing is prompted.
    nav.setDashboardSettingsOpen(true);
    assert.deepEqual(modes, ['settings']);
    assert.equal(writes.at(-1)?.sidebarMode, 'settings');
    assert.equal(writes.at(-1)?.selectedTab, 'preview');
    assert.equal(prompts, 0);

    // Re-opening an already-open workspace is a no-op, not a second write.
    const writeCount = writes.length;
    nav.setDashboardSettingsOpen(true);
    assert.equal(writes.length, writeCount);

    // Leaving with a dirty dashboard draft prompts, and a denial changes nothing.
    nav.setDashboardSettingsOpen(false);
    assert.equal(prompts, 1);
    assert.deepEqual(modes, ['settings']);
    assert.equal(writes.length, writeCount);

    allowed = true;
    nav.setDashboardSettingsOpen(false);
    assert.deepEqual(modes, ['settings', 'instances']);
    assert.deepEqual(cleared, ['dashboard']);
    assert.equal(writes.at(-1)?.sidebarMode, 'instances');
});
test('a port change still confirms the settings draft', () => {
    // The second dirty slot is gone with the panel that produced it, but a port change still
    // departs the one remaining draft and must confirm before discarding it.
    type Args = Parameters<typeof createInstanceSettingsNavigation>[0];
    const cleared: string[] = [];
    let allow = false;
    const view: Args['view'] = { sidebarMode: 'instances', activeDetailTab: 'preview',
        setSelectedPort() {}, setSidebarMode() {}, setViewMode() {}, setDrawerOpen() {} };
    const nav = createInstanceSettingsNavigation({ view, selectedPort: 3457, settingsDirty: true,
        dashboardSettingsDirty: true,
        clearDirty: entry => cleared.push(entry), confirmDiscard: () => allow, saveUi: async () => {} });
    assert.equal(nav.canLeaveDirtySettings(), false); // row / Preview / CEO guard uses this
    assert.equal(nav.guardSettingsTransition({ selectedPort: 3458 }), false);
    assert.deepEqual(cleared, []);
    allow = true;
    assert.equal(nav.guardSettingsTransition({ selectedPort: 3458 }), true);
    assert.deepEqual(cleared, ['dashboard']);
});
test('the dirty reducer tracks the single remaining settings draft', () => {
    let entries = settingsDirtyAfter({ dashboard: false }, 'dashboard', true);
    assert.equal(entries.dashboard, true);
    entries = settingsDirtyAfter(entries, 'dashboard', false);
    assert.equal(entries.dashboard, false);
});
test('shortcut toggle and tab cycling have separate owners', () => {
    let toggles = 0;
    const tabs: string[] = [];
    const deps: ManagerShortcutRunnerDeps = { selectedInstance: null, filtered: [], activeDetailTab: 'logs',
        toggleInstanceSettings() { toggles++; }, handleTabChange(tab) { tabs.push(tab); },
        setDrawerOpen() {}, handleSidebarModeChange() {}, handlePreview() {}, selectRelativeInstance() {},
        setPreviewRefreshKey() {}, handleSidebarToggle() {} };
    runManagerShortcut('toggleInstanceSettings', deps); assert.equal(toggles, 1);
    runManagerShortcut('nextTab', deps); assert.deepEqual(tabs, ['overview']);
    // Meta+4 used to select a fourth Workbench tab that no longer exists. Leaving it bound
    // meant the key silently swapped the whole workspace for the rail settings page, which is
    // not what a tab shortcut should do — switchTab1..3 still name real tabs.
    assert.equal(MANAGER_SHORTCUT_ACTIONS.includes('switchTab4' as never), false,
        'switchTab4 must not survive the Workbench settings tab it selected');
    assert.equal('switchTab4' in DEFAULT_MANAGER_SHORTCUT_KEYMAP, false,
        'a retired action must not keep a default binding');
    assert.equal(toggles, 1);
});

test('the dirty callback stays stable through renders and clears on unmount', async () => {
    const React = await import('react');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const globals = globalThis as unknown as Record<string, unknown>;
    const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(replacements)) globals[key] = value;
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(dom.window.document.getElementById('root')!);
    let state: ReturnType<typeof useSettingsDirtyState> | undefined;
    let notifications = 0, cleanups = 0;
    function Panel(props: { onDirtyChange: (dirty: boolean) => void }) {
        React.useEffect(() => {
            notifications++;
            assert.ok(notifications < 5, 'dirty notifications must settle, not loop');
            props.onDirtyChange(true);
        }, [props.onDirtyChange]);
        React.useEffect(() => () => { cleanups++; props.onDirtyChange(false); }, [props.onDirtyChange]);
        return null;
    }
    // SettingsShell keys its dirty notification and unmount cleanup to callback identity, so an
    // unstable callback would re-notify on every render or leak a stale dirty flag.
    function Harness(props: { open: boolean }) {
        state = useSettingsDirtyState();
        const notify = React.useCallback((dirty: boolean) => state!.onSettingsDirtyChange('dashboard', dirty), [state!.onSettingsDirtyChange]);
        return props.open ? React.createElement(Panel, { onDirtyChange: notify }) : null;
    }
    try {
        await React.act(async () => { root.render(React.createElement(Harness, { open: true })); });
        assert.equal(state?.dashboardSettingsDirty, true);
        const callback = state?.onSettingsDirtyChange;
        await React.act(async () => { root.render(React.createElement(Harness, { open: true })); });
        assert.equal(state?.onSettingsDirtyChange, callback);
        assert.equal(notifications, 1); assert.equal(cleanups, 0);
        await React.act(async () => { root.render(React.createElement(Harness, { open: false })); });
        assert.equal(cleanups, 1); assert.equal(state?.dashboardSettingsDirty, false);
        assert.equal(state?.settingsDirty, false);
    } finally {
        await React.act(async () => { root.unmount(); });
        dom.window.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globals[key];
        }
    }
});

test('settings shortcut captures ordinary inputs once and yields to keybinding editors', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<input id="field"><input id="binding" data-keybinding-capture>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
    const actions: string[] = [];
    let bubbled = 0;
    // Meta is the primary modifier; pin macOS so metaKey is the expected chord on every CI OS.
    const handler = createManagerCaptureKeydownHandler(() => DEFAULT_MANAGER_SHORTCUT_KEYMAP, action => actions.push(action), { platform: 'MacIntel' });
    dom.window.addEventListener('keydown', handler, true);
    dom.window.document.addEventListener('keydown', () => { bubbled++; });
    const key = () => new dom.window.KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true });
    try {
        const captured = key(); dom.window.document.getElementById('field')!.dispatchEvent(captured);
        assert.deepEqual(actions, ['toggleInstanceSettings']); assert.equal(captured.defaultPrevented, true);
        assert.equal(bubbled, 0);
        const editing = key(); dom.window.document.getElementById('binding')!.dispatchEvent(editing);
        assert.equal(editing.defaultPrevented, false); assert.equal(actions.length, 1); assert.equal(bubbled, 1);
        const prevented = key(); prevented.preventDefault();
        dom.window.document.getElementById('field')!.dispatchEvent(prevented);
        assert.equal(actions.length, 1);
    } finally {
        dom.window.removeEventListener('keydown', handler, true);
        dom.window.close();
        if (previous) Object.defineProperty(globalThis, 'Element', previous);
        else Reflect.deleteProperty(globalThis, 'Element');
    }
});

test('a compound transition confirms once and clears the departing draft', () => {
    type Args = Parameters<typeof createInstanceSettingsNavigation>[0];
    let accepted = false, prompts = 0;
    const cleared: string[] = [], writes: unknown[] = [];
    const view: Args['view'] = { sidebarMode: 'settings', activeDetailTab: 'preview',
        setSelectedPort() {}, setSidebarMode() {}, setViewMode() {}, setDrawerOpen() {} };
    const nav = createInstanceSettingsNavigation({ view, selectedPort: 3457, settingsDirty: true,
        dashboardSettingsDirty: true, clearDirty: entry => cleared.push(entry),
        saveUi: async patch => { writes.push(patch); }, confirmDiscard: () => { prompts++; return accepted; } });
    // A port change and a mode change both depart the same draft; each confirms exactly once.
    assert.equal(nav.guardSettingsTransition({ selectedPort: 3458 }), false);
    assert.equal(prompts, 1); assert.deepEqual(cleared, []);
    accepted = true;
    assert.equal(nav.guardSettingsTransition({ selectedPort: 3458 }), true);
    assert.equal(prompts, 2); assert.deepEqual(cleared, ['dashboard']);
    cleared.length = 0;
    assert.equal(nav.guardSettingsTransition({ sidebarMode: 'notes' }), true);
    assert.equal(prompts, 3); assert.deepEqual(cleared, ['dashboard']);
});

test('App host guards real settings drafts through document and desktop subscriptions', async (t) => {
    const React = await import('react');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { url: 'http://localhost:24576/' });
    const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
        localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, React };
    const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { createRoot } = await import('react-dom/client');
    const { dashboardSettingsUiFromView } = await import('../../public/manager/src/dashboard-settings/dashboard-settings-ui');
    const { SettingsPage } = await import('../../public/manager/src/settings/SettingsPage');
    // Preload the real page so lazy loading can settle within act without timer polling.
    await import('../../public/manager/src/settings/pages/Display');
    type ChromeProps = import('react').ComponentProps<typeof import('../../public/manager/src/AppChrome').AppChrome>;
    let latest: ChromeProps | undefined;
    const dirty = { panel: false, dashboard: false };
    const writes: DashboardRegistryPatch[] = [];
    const settingsWrites: string[] = [];
    const subscribers = new Set<(action: DashboardShortcutAction) => void>();
    let unsubscribed = 0, reads = 0;
    let ui: DashboardRegistryUi;
    const seed = document.createElement('div'); document.body.append(seed);
    const seedRoot = createRoot(seed);
    function Seed() { ui = dashboardSettingsUiFromView(useDashboardView(), 'dark'); return null; }
    await React.act(async () => { seedRoot.render(React.createElement(Seed)); });
    await React.act(async () => { seedRoot.unmount(); }); seed.remove();
    const initialUi = { ...ui!, selectedPort: 3457, selectedTab: 'preview' as const, locale: 'en' as const };
    const registryResult = { registry: { ui: initialUi, activeProfileFilter: [] }, status: { error: null } };
    const scan = { instances: [{ port: 3457, url: 'http://localhost:3457', ok: true, status: 'online', workingDir: '/fixture' }],
        manager: { port: 24576, profiles: [] } };
    const noop = () => {};
    const registry = { refresh: async () => registryResult, error: null,
        save: async (patch: DashboardRegistryPatch) => { writes.push(structuredClone(patch)); return registryResult; } };
    const activity = { events: [], titlesByPort: {}, titleSupportByPort: {}, busyPorts: new Set<number>() };
    const client: SettingsClient = {
        async get<T>() { return { presentation: { mode: 'activity' }, tui: { pasteCollapseLines: 6 } } as T; },
        async put<T>(path: string): Promise<T> { settingsWrites.push(path); throw new Error('Navigation must not save settings'); },
        async post<T>(path: string): Promise<T> { settingsWrites.push(path); throw new Error('Unexpected settings POST'); },
        async delete<T>(path: string): Promise<T> { settingsWrites.push(path); throw new Error('Unexpected settings DELETE'); },
    };
    function TestChrome(props: ChromeProps) {
        latest = props;
        React.useEffect(() => {
            if (!props.view.dashboardShortcutsEnabled) return;
            const handler = createManagerCaptureKeydownHandler(() => props.view.dashboardShortcutKeymap, props.onShortcutAction, { platform: 'MacIntel' });
            window.addEventListener('keydown', handler, true);
            return () => window.removeEventListener('keydown', handler, true);
        }, [props.view.dashboardShortcutsEnabled, props.view.dashboardShortcutKeymap, props.onShortcutAction]);
        const panelDirty = React.useCallback((value: boolean) => { dirty.panel = value; props.onSettingsDirtyChange('panel', value); }, [props.onSettingsDirtyChange]);
        const dashboardDirty = React.useCallback((value: boolean) => { dirty.dashboard = value; props.onSettingsDirtyChange('dashboard', value); }, [props.onSettingsDirtyChange]);
        const button = (id: string, action: () => void) => React.createElement('button', { id, type: 'button', onClick: action }, id);
        const page = (entry: 'panel' | 'dashboard', onBack: () => void) => React.createElement(SettingsPage, {
            key: `${entry}:${props.selectedInstance?.port}`, port: props.selectedInstance?.port ?? 3457,
            instanceUrl: '/i/3457', client, scopes: ['instance'], initialId: 'display',
            onDirtyChange: entry === 'panel' ? panelDirty : dashboardDirty, onBack,
        });
        // Only the heavy chrome is replaced: real App callbacks decide every transition.
        // Mount lifetimes match Router/Workbench; the retained panel survives mode changes.
        return React.createElement('div', {},
            button('dashboard', () => props.handleSidebarModeChange('settings')),
            button('instances', () => props.handleSidebarModeChange('instances')),
            button('rail-notes', () => props.handleSidebarModeChange('notes')),
            button('gear', () => props.handleSidebarModeChange(
                props.view.sidebarMode === 'settings' ? 'instances' : 'settings')),
            button('keyboard-target', noop),
            React.createElement('div', { 'data-entry': 'dashboard' }, props.view.sidebarMode === 'settings'
                ? page('dashboard', () => props.handleSidebarModeChange('instances')) : null));
    }
    const mocks: Array<[string, Record<string, unknown>]> = [
        ['../../public/manager/src/AppChrome.tsx', { AppChrome: TestChrome }],
        ['../../public/manager/src/api.ts', { fetchInstances: async () => { reads++; return scan; }, fetchInstanceStatus: async () => null, runLifecycleAction: noop }],
        ['../../public/manager/src/hooks/useDashboardRegistry.ts', { useDashboardRegistry: () => registry }],
        ['../../public/manager/src/lib/use-hidden-unload.ts', { useHiddenUnload: noop }],
        ['../../public/manager/src/hooks/useTheme.ts', { useTheme: () => ({ theme: 'dark', resolved: 'dark', setTheme: noop, syncFromRegistry: noop }) }],
        ['../../public/manager/src/hooks/useCommandPalette.ts', { useCommandPalette: () => ({}) }],
        ['../../public/manager/src/hooks/useManagerEvents.ts', { useManagerEvents: () => ({ events: activity.events, error: null }) }],
        ['../../public/manager/src/hooks/useInstanceMessageEvents.ts', { useInstanceMessageEvents: () => activity }],
        ['../../public/manager/src/hooks/useInstanceLabelEditor.ts', { useInstanceLabelEditor: () => ({ error: null, saveInstanceLabel: noop }) }],
        ['../../public/manager/src/hooks/useActivityUnread.ts', { useActivityUnread: () => ({ unreadByPort: {}, markPortSeen: noop, hydrateSeenAt: noop, openAndMarkSeen: noop, closeAndPersistSeen: noop }) }],
        ['../../public/manager/src/hooks/useProjectPicker.ts', { useProjectPicker: () => ({ busyPort: null, pick: noop }) }],
        ['../../public/manager/src/notes/useNotesModel.ts', { useNotesModel: () => ({ index: null }) }],
        ['../../public/manager/src/sync/useInvalidationSubscription.ts', { useInvalidationSubscription: noop }],
        ['../../public/manager/src/hooks/useManagerEventStream.ts', { useManagerEventStream: noop }],
        ['../../public/manager/src/usePreviewSttLifecycle.ts', { usePreviewSttLifecycle: noop }],
        ['../../public/manager/src/jaw-ceo/useJawCeoDashboardBridge.tsx', { useJawCeoDashboardBridge: () => ({ voice: {}, ceo: {}, open: false, setOpen: noop }) }],
        ['../../public/manager/src/components/InstanceDetailPanel.tsx', { InstanceDetailPanel: () => null }],
        ['../../public/manager/src/components/InstanceListContent.tsx', { InstanceListContent: () => null }],
        ['../../public/manager/src/dashboard-reminders/TrayRemindersApp.tsx', { TrayRemindersApp: () => null }],
        // Build flags are supplied by Vite in the product; these tests cover ordinary modes.
        ['../../public/manager/src/dashboard-features.ts', { REMINDERS_WORKSPACE_ENABLED: true,
            normalizeSidebarModeForBuild: (mode: string) => mode === 'schedule' ? 'instances' : mode }],
        ['../../public/manager/src/panels/desktop-bridge.ts', { getDesktop: () => ({ shortcuts: {
            onAction(callback: (action: DashboardShortcutAction) => void) {
                subscribers.add(callback);
                return () => { subscribers.delete(callback); unsubscribed++; };
            },
        } }) }],
    ];
    try {
        for (const [path, namedExports] of mocks) t.mock.module(path, { namedExports });
        const { App } = await import('../../public/manager/src/App');
        // One settings entry point remains: the rail. 'gear' is now the rail toggle, and the
        // Workbench panel and its 'close-panel' source are gone with it.
        const sources = ['back', 'escape', 'gear', 'rail-notes', 'meta', 'keyboard', 'desktop'] as const;
        for (const source of sources) for (const outcome of ['deny', 'accept', ...(['keyboard', 'desktop'].includes(source) ? ['clear'] : [])]) {
            await t.test(`${source}: rail settings draft, ${outcome}`, async () => {
                const host = document.createElement('div'); document.body.append(host);
                const root = createRoot(host);
                let confirmations = 0;
                dom.window.confirm = () => { confirmations++; return outcome === 'accept' && confirmations === 1; };
                const click = async (id: string) => React.act(async () => { host.querySelector<HTMLButtonElement>(`#${id}`)!.click(); });
                const input = (entry: string) => {
                    const node = host.querySelector<HTMLInputElement>(`[data-entry="${entry}"] #display-pasteCollapseLines`);
                    assert.ok(node, `${entry} real Display field is mounted`); return node;
                };
                const edit = async (node: HTMLInputElement, value: string) => React.act(async () => {
                    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
                    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
                });
                try {
                    await React.act(async () => { root.render(React.createElement(App)); });
                    assert.equal(latest?.selectedInstance?.port, 3457);
                    await click('dashboard');
                    const dashboard = input('dashboard');
                    assert.equal(dirty.dashboard, false); assert.equal(dirty.panel, false);
                    const stable = { instance: latest!.selectedInstance, instances: latest!.instances,
                        keymap: latest!.view.dashboardShortcutKeymap, reads, unsubscribed,
                        desktop: [...subscribers][0] };
                    await edit(dashboard, '9');
                    assert.deepEqual(dirty, { panel: false, dashboard: true });
                    assert.equal(latest!.selectedInstance, stable.instance);
                    assert.equal(latest!.instances, stable.instances);
                    assert.equal(latest!.view.dashboardShortcutKeymap, stable.keymap);
                    assert.equal(reads, stable.reads, 'No incidental refresh can repair a stale closure');
                    assert.equal(subscribers.size, 1);
                    assert.ok(unsubscribed > stable.unsubscribed, 'Dirty-only edit releases desktop subscription');
                    assert.notEqual([...subscribers][0], stable.desktop);
                    if (outcome === 'clear') {
                        const beforeClear = [...subscribers][0];
                        await edit(dashboard, '6');
                        assert.deepEqual(dirty, { panel: false, dashboard: false });
                        assert.equal(subscribers.size, 1); assert.notEqual([...subscribers][0], beforeClear);
                    }
                    assert.equal(latest!.view.sidebarMode, 'settings');
                    assert.equal(latest!.view.drawerOpen, false);
                    writes.length = 0; settingsWrites.length = 0;
                    const target = host.querySelector<HTMLButtonElement>('#keyboard-target')!;
                    dashboard.blur(); target.focus();
                    await React.act(async () => {
                        if (source === 'desktop') [...subscribers][0]!('focusNotes');
                        else if (source === 'keyboard' || source === 'meta') target.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                            key: source === 'meta' ? ',' : 'n', altKey: source === 'keyboard', metaKey: source === 'meta', bubbles: true, cancelable: true,
                        }));
                        else if (source === 'escape') host.querySelector<HTMLButtonElement>('[data-entry="dashboard"] .settings-back')!
                            .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                        else if (source === 'back') host.querySelector<HTMLButtonElement>('[data-entry="dashboard"] .settings-back')!.click();
                        else host.querySelector<HTMLButtonElement>(`#${source}`)!.click();
                    });
                    assert.equal(confirmations, outcome === 'clear' ? 0 : 1);
                    assert.equal(latest!.selectedInstance, stable.instance); assert.equal(reads, stable.reads);
                    assert.deepEqual(settingsWrites, []);
                    if (outcome === 'deny') {
                        assert.equal(latest!.view.sidebarMode, 'settings'); assert.equal(input('dashboard'), dashboard);
                        assert.equal(dashboard.value, '9'); assert.equal(dirty.dashboard, true); assert.deepEqual(writes, []);
                    } else {
                        assert.equal(latest!.view.sidebarMode, ['rail-notes', 'keyboard', 'desktop'].includes(source) ? 'notes' : 'instances');
                        assert.equal(dashboard.isConnected, false); assert.equal(dirty.dashboard, false);
                        assert.equal(writes.length, 1, 'One accepted transition persists once');
                        // Re-entering the rail workspace starts a fresh draft, and re-entry
                        // itself must not consume another confirmation.
                        await click('dashboard');
                        assert.equal(confirmations, outcome === 'clear' ? 0 : 1);
                        assert.equal(input('dashboard').value, '6');
                        assert.equal(dirty.dashboard, false);
                    }
                } finally {
                    await React.act(async () => { root.unmount(); }); host.remove();
                    assert.equal(subscribers.size, 0, 'App unmount releases desktop listeners');
                    assert.deepEqual(dirty, { panel: false, dashboard: false });
                }
            });
        }
    } finally {
        dom.window.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
        }
    }
});
