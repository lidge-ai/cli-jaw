import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchInstances, fetchInstanceStatus, runLifecycleAction } from './api';
import { pollUntilSettled } from './lifecycle-poll';
import { InstanceDetailPanel } from './components/InstanceDetailPanel';
import { InstanceListContent } from './components/InstanceListContent';
import { ProfileChip } from './components/ProfileChip';
import { AppChrome } from './AppChrome';
import { type HelpTopicId } from './help/helpContent';
import { isHelpShortcutEditableTarget } from './help/help-shortcuts';
import { loadPreviewEnabled, savePreviewEnabled } from './lib/preview-prefs';
import { useHiddenUnload } from './lib/use-hidden-unload';
import { type DashboardSettingsSection } from './dashboard-settings/DashboardSettingsSidebar';
import { summarizeActivityTitleSupport } from './dashboard-settings/activity-title-support';
import { dashboardSettingsUiFromView } from './dashboard-settings/dashboard-settings-ui';
import { type NotesSidebarMode } from './notes/NotesSidebar';
import { useNotesModel } from './notes/useNotesModel';
import { publishInvalidation } from './sync/invalidation-bus';
import { useInvalidationSubscription } from './sync/useInvalidationSubscription';
import type { BoardView } from './dashboard-board/board-view';
import { type ScheduleGroup } from './dashboard-schedule/DashboardScheduleSidebar';
import { normalizeSidebarModeForBuild, REMINDERS_WORKSPACE_ENABLED } from './dashboard-features';
import { readInitialSelectedPort, readInitialSidebarMode, readTrayRemindersMode } from './dashboard-url-state';
import { TrayRemindersApp } from './dashboard-reminders/TrayRemindersApp';
import { useDashboardRegistry } from './hooks/useDashboardRegistry';
import { useDashboardView, hydrateInstanceSettings, createInstanceSettingsNavigation, useSettingsDirtyState } from './hooks/useDashboardView';
import { useActivityUnread } from './hooks/useActivityUnread';
import { useTheme } from './hooks/useTheme';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useInstanceLabelEditor } from './hooks/useInstanceLabelEditor';
import { useInstanceMessageEvents } from './hooks/useInstanceMessageEvents';
import { useManagerEvents } from './hooks/useManagerEvents';
import { useManagerEventStream } from './hooks/useManagerEventStream';
import { useProjectPicker } from './hooks/useProjectPicker';
import { usePreviewSttLifecycle } from './usePreviewSttLifecycle';
import { usePreviewShortcutMessages } from './usePreviewShortcutMessages';
import { formatUptime, instanceLabel } from './instance-label';
import { useJawCeoDashboardBridge } from './jaw-ceo/useJawCeoDashboardBridge';
import { actionForShortcutEvent, isManagerShortcutEditableTarget } from './manager-shortcuts';
import { reconcileActiveProfileFilter } from './profile-filter';
import type { DashboardDetailTab, DashboardInstance, DashboardInstanceStatus, DashboardLifecycleAction, DashboardNotesAuthoringMode, DashboardNotesGraphSettings, DashboardNotesViewMode, DashboardProfile, DashboardScanResult, DashboardShortcutAction, DashboardSidebarMode } from './types';
import { runManagerShortcut as runManagerShortcutAction } from './manager-shortcut-runner';
import { getDesktop } from './panels/desktop-bridge';
import type { PanelLayoutState } from './panels/PanelLayoutProvider';
import { panelLayoutInitialStateFromUi, panelLayoutUiFromState } from './panels/panel-layout-registry-state';
export function App() { if (readTrayRemindersMode(window.location.search) && REMINDERS_WORKSPACE_ENABLED) return <TrayRemindersApp />;
    const [data, setData] = useState<DashboardScanResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<'all' | DashboardInstanceStatus>('all');
    const [customHome, setCustomHome] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [hydrated, setHydrated] = useState(false);
    const [panelInitialState, setPanelInitialState] = useState<Partial<PanelLayoutState> | undefined>(undefined);
    const [lifecycleBusyPort, setLifecycleBusyPort] = useState<number | null>(null);
    const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
    const [transitioningPort, setTransitioningPort] = useState<number | null>(null);
    const [transitionAction, setTransitionAction] = useState<DashboardLifecycleAction | null>(null);
    const [activeProfileIds, setActiveProfileIds] = useState<string[]>([]);
    const { settingsDirty, dashboardSettingsDirty, setSettingsDirty, onSettingsDirtyChange } = useSettingsDirtyState();
    const [notesDirtyPath, setNotesDirtyPath] = useState<string | null>(null);
    const [notesSidebarMode, setNotesSidebarMode] = useState<NotesSidebarMode>('files');
    const [notesSearchFocusToken, setNotesSearchFocusToken] = useState(0);
    const [dashboardSettingsSection, setDashboardSettingsSection] = useState<DashboardSettingsSection>('display');
    const [boardView, setBoardView] = useState<BoardView>({ kind: 'overall' });
    const [scheduleGroup, setScheduleGroup] = useState<ScheduleGroup>('today');
    const [previewEnabled, setPreviewEnabled] = useState<boolean>(() => loadPreviewEnabled());
    const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
    const [autoUnloadNotice, setAutoUnloadNotice] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [helpTopic, setHelpTopic] = useState<HelpTopicId | null>(null);
    const openHelpTopic = useCallback((topic: HelpTopicId) => {
        setHelpTopic(topic);
        setHelpOpen(true);
    }, []);
    useEffect(() => {
        savePreviewEnabled(previewEnabled);
    }, [previewEnabled]);
    useHiddenUnload({ enabled: previewEnabled, onUnload: () => { setPreviewEnabled(false); setAutoUnloadNotice(true); } });
    useEffect(() => {
        if (!autoUnloadNotice) return undefined;
        if (typeof document === 'undefined') return undefined;
        if (document.hidden) return undefined;
        const timer = setTimeout(() => setAutoUnloadNotice(false), 8000);
        return () => clearTimeout(timer);
    }, [autoUnloadNotice]);
    const registry = useDashboardRegistry();
    const view = useDashboardView();
    const theme = useTheme((next) => {
        if (!hydrated) return;
        void registry.save({ ui: { uiTheme: next } });
    });
    const palette = useCommandPalette();
    const managerEvents = useManagerEvents();
    const instances = data?.instances || [];
    const messageActivity = useInstanceMessageEvents(instances);
    const labelEditor = useInstanceLabelEditor(registry.save, setData);
    const profiles = useMemo(() => data?.manager.profiles || [], [data]);
    const effectiveProfileIds = useMemo(() => {
        const known = new Set(profiles.map(profile => profile.profileId));
        return activeProfileIds.filter(profileId => known.has(profileId));
    }, [activeProfileIds, profiles]);
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return instances.filter((instance) => {
            if (status !== 'all' && instance.status !== status) return false;
            if (effectiveProfileIds.length > 0 && (!instance.profileId || !effectiveProfileIds.includes(instance.profileId))) return false;
            if (!needle) return true;
            return [
                String(instance.port),
                instance.url,
                instanceLabel(instance),
                instance.version,
                instance.workingDir,
                instance.currentCli,
                instance.currentModel,
                instance.healthReason,
                instance.label,
                instance.group,
                instance.profileId,
            ].some(value => String(value || '').toLowerCase().includes(needle));
        });
    }, [effectiveProfileIds, instances, query, status]);
    const selectedInstance = useMemo(() => view.selectedPort == null ? filtered.find(instance => instance.ok) || null : instances.find(instance => instance.port === view.selectedPort) || null, [filtered, instances, view.selectedPort]);
    const activeJawCeoPort = selectedInstance?.port ?? view.selectedPort ?? null;
    const jawCeoBridge = useJawCeoDashboardBridge({ selectedPort: activeJawCeoPort, managerEvents: managerEvents.events, messageEvents: messageActivity.events, onOpenWorker: handleOpenJawCeoWorker });
    usePreviewSttLifecycle(jawCeoBridge.voice);
    usePreviewShortcutMessages({ enabled: view.dashboardShortcutsEnabled, keymap: view.dashboardShortcutKeymap, menuOwned: getDesktop() != null, onAction: runManagerShortcut });
    const activePreviewPort = view.activeDetailTab === 'preview' && view.sidebarMode === 'instances' ? (selectedInstance?.port ?? null) : null;
    const activityEvents = useMemo(() => {
        return [...managerEvents.events, ...messageActivity.events];
    }, [managerEvents.events, messageActivity.events]);
    const activityUnread = useActivityUnread({
        events: activityEvents,
        activityDockCollapsed: view.activityDockCollapsed,
        setActivityDockCollapsed: view.setActivityDockCollapsed,
        saveUi,
        activePreviewPort,
    });
    function cycleTheme(): void {
        const order: ('auto' | 'light' | 'dark')[] = ['auto', 'light', 'dark'];
        const next = order[(order.indexOf(theme.theme) + 1) % order.length];
        theme.setTheme(next);
    }
    function openSelectedInBrowser(): void {
        if (!selectedInstance) return;
        window.open(selectedInstance.url, '_blank', 'noopener,noreferrer');
    }
    useEffect(() => { document.documentElement.lang = view.locale; }, [view.locale]);
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isHelpShortcutEditableTarget(event.target)) return;
            event.preventDefault(); openHelpTopic('shortcuts');
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [openHelpTopic]);

    async function load(nextShowHidden = showHidden, forceFresh = false): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchInstances(nextShowHidden, { fresh: forceFresh });
            const nextProfileIds = reconcileActiveProfileFilter(activeProfileIds, result.manager.profiles || []);
            if (nextProfileIds !== activeProfileIds) { setActiveProfileIds(nextProfileIds); void registry.save({ activeProfileFilter: nextProfileIds }); }
            setData(result);
        } catch (err) { setError((err as Error).message); }
        finally { setLoading(false); }
    }
    async function refreshInstance(port: number): Promise<void> {
        const instance = await fetchInstanceStatus(port);
        if (!instance) return;
        setData((current) => current ? { ...current, instances: current.instances.map(row => row.port === port ? instance : row) } : current);
    }
    useInvalidationSubscription('instances', () => void load(), 'app');
    // #233: worker settings changed (cli/model/projectDirs) — refresh that row
    // immediately instead of waiting for a manual reload.
    useManagerEventStream((port) => {
        void refreshInstance(port);
        publishInvalidation({ topics: ['instances'], reason: 'instance:settings-change', source: 'ui', sourceId: 'app' });
    });
    // #233 follow-up: native folder chooser for the selected instance.
    const projectPicker = useProjectPicker(
        async (port) => {
            await refreshInstance(port);
            publishInvalidation({ topics: ['instances'], reason: 'instance:project-picked', source: 'ui', sourceId: 'app' });
        },
        (message) => setLifecycleMessage(`Project pick failed: ${message}`),
    );
    useEffect(() => {
        async function initialize(): Promise<void> {
            try {
                const loaded = await registry.refresh();
                const ui = loaded.registry.ui;
                const restored = hydrateInstanceSettings(ui);
                view.setSelectedPort(ui.selectedPort); view.setActiveDetailTab(restored.selectedTab); view.setSidebarCollapsed(ui.sidebarCollapsed);
                // Menu bar "open instance" links win over the restored selection without persisting it.
                const urlPort = readInitialSelectedPort(window.location.search);
                if (urlPort !== null) view.setSelectedPort(urlPort);
                view.setActivityDockCollapsed(ui.activityDockCollapsed); view.setActivityDockHeight(ui.activityDockHeight);
                const sidebarMode = normalizeSidebarModeForBuild(readInitialSidebarMode(window.location.search) ?? restored.sidebarMode); // restored carries the legacy settings request
                view.setSidebarMode(sidebarMode);
                if (sidebarMode !== ui.sidebarMode) void saveUi({ sidebarMode });
                view.setNotesSelectedPath(ui.notesSelectedPath); view.setNotesViewMode(ui.notesViewMode); view.setNotesAuthoringMode(ui.notesAuthoringMode ?? 'plain');
                view.setNotesWordWrap(ui.notesWordWrap); view.setNotesVimMode(ui.notesVimMode); view.setNotesTreeWidth(ui.notesTreeWidth);
                view.setNotesGraphSettings(ui.notesGraphSettings);
                view.setShowLatestActivityTitles(ui.showLatestActivityTitles); view.setShowInlineLabelEditor(ui.showInlineLabelEditor); view.setShowSidebarRuntimeLine(ui.showSidebarRuntimeLine);
                view.setShowSelectedRowActions(ui.showSelectedRowActions); view.setDashboardShortcutsEnabled(ui.dashboardShortcutsEnabled); view.setDashboardShortcutKeymap(ui.dashboardShortcutKeymap);
                view.setDiffRootPolicy(ui.diffRootPolicy); view.setDiffPinnedRootByPort(ui.diffPinnedRootByPort); view.setDiffRecentRepoRoots(ui.diffRecentRepoRoots); view.setDiffDefaultMode(ui.diffDefaultMode);
                view.setDiffBaseRef(ui.diffBaseRef); view.setDiffIncludeUntracked(ui.diffIncludeUntracked);
                view.setRightFolderRootPath(ui.rightFolderRootPath);
                view.setLocale(ui.locale);
                activityUnread.hydrateSeenAt(ui.activitySeenAt ?? null, ui.activitySeenByPort || {});
                setActiveProfileIds(loaded.registry.activeProfileFilter || []);
                theme.syncFromRegistry(ui.uiTheme);
                setPanelInitialState(panelLayoutInitialStateFromUi(ui));
            } finally { setHydrated(true); await load(); }
        }
        void initialize();
    }, []);

    async function saveUi(ui: Parameters<typeof registry.save>[0]['ui']): Promise<void> {
        if (!hydrated || ui === undefined) return;
        await registry.save({ ui });
    }
    function handlePanelStateChange(ps: PanelLayoutState): void {
        void saveUi(panelLayoutUiFromState(ps));
    }
    const profileCounts = useMemo(() => {
        return instances.reduce((acc, instance) => {
            if (instance.profileId) acc[instance.profileId] = (acc[instance.profileId] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
    }, [instances]);
    const summary = useMemo(() => {
        return instances.reduce((acc, instance) => {
            acc['total'] += 1;
            acc[instance.status] = (acc[instance.status] || 0) + 1;
            return acc;
        }, { total: 0 } as Record<string, number>);
    }, [instances]);

    function toggleProfile(profileId: string): void {
        const next = activeProfileIds.includes(profileId) ? activeProfileIds.filter(id => id !== profileId) : [...activeProfileIds, profileId];
        setActiveProfileIds(next);
        void registry.save({ activeProfileFilter: next });
    }
    const { canLeaveDirtySettings, guardSettingsTransition, setDashboardSettingsOpen } = createInstanceSettingsNavigation({
        view, settingsDirty, dashboardSettingsDirty, clearDirty: entry => onSettingsDirtyChange(entry, false), saveUi, selectedPort: selectedInstance?.port ?? null,
    });

    function handlePreview(instance: DashboardInstance, openDefaultSession = false): void {
        if (instance.port !== selectedInstance?.port && !canLeaveDirtySettings()) return;
        if (openDefaultSession) { setPreviewEnabled(true); setAutoUnloadNotice(false); setPreviewRefreshKey(key => key + 1); }
        if (instance.port !== selectedInstance?.port) setSettingsDirty(false);
        activityUnread.markPortSeen(instance.port); view.setSelectedPort(instance.port);
        view.setActiveDetailTab('preview'); view.setActivityDockCollapsed(true); view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port, selectedTab: 'preview', activityDockCollapsed: true });
    }
    function handleOpenJawCeoWorker(port: number): void { const instance = instances.find(row => row.port === port); if (instance) handlePreview(instance); }
    function handleSelectInstance(instance: DashboardInstance): void {
        if (instance.port !== selectedInstance?.port && !canLeaveDirtySettings()) return;
        if (instance.port !== selectedInstance?.port) setSettingsDirty(false);
        activityUnread.markPortSeen(instance.port); view.setSelectedPort(instance.port); view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port });
    }
    function handleTabChange(tab: DashboardDetailTab): void {
        if (tab === 'settings') { setDashboardSettingsOpen(true); return; } // retired tab -> rail workspace
        if (view.activeDetailTab === 'preview' && tab !== 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
        }
        view.setActiveDetailTab(tab);
        if (tab === 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
            view.setActivityDockCollapsed(true);
            void saveUi({ selectedTab: tab, activityDockCollapsed: true });
            return;
        }
        void saveUi({ selectedTab: tab });
    }

    function handleSidebarToggle(): void {
        const next = !view.sidebarCollapsed;
        view.setSidebarCollapsed(next);
        void saveUi({ sidebarCollapsed: next });
    }

    function handleActivityToggle(): void {
        if (view.activityDockCollapsed) {
            activityUnread.openAndMarkSeen();
            return;
        }
        activityUnread.closeAndPersistSeen();
    }

    function handleActivityHeight(height: number): void {
        view.setActivityDockHeight(height);
        void saveUi({ activityDockHeight: height });
    }
    function handleSidebarModeChange(mode: DashboardSidebarMode): void {
        const sidebarMode = normalizeSidebarModeForBuild(mode);
        if (!guardSettingsTransition({ sidebarMode })) return;
        if (view.sidebarMode === 'instances' && mode !== 'instances' && view.activeDetailTab === 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
        }
        view.setSidebarMode(sidebarMode); void saveUi({ sidebarMode });
    }

    function handleNotesSelectedPathChange(path: string | null): void { view.setNotesSelectedPath(path); void saveUi({ notesSelectedPath: path }); }
    const [notesHighlightedPath, setNotesHighlightedPath] = useState<string | null>(null);
    const notesHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    function flashNotesPath(path: string): void {
        setNotesHighlightedPath(path);
        if (notesHighlightTimerRef.current) clearTimeout(notesHighlightTimerRef.current);
        notesHighlightTimerRef.current = setTimeout(() => setNotesHighlightedPath(null), 2500);
    }

    function openNotesFromPreview(path: string): void {
        const relPath = path.trim();
        if (!relPath) return;
        if (view.sidebarMode !== 'notes') {
            handleSidebarModeChange('notes');
        }
        handleNotesSelectedPathChange(relPath);
        flashNotesPath(relPath);
    }

    useEffect(() => () => {
        if (notesHighlightTimerRef.current) clearTimeout(notesHighlightTimerRef.current);
    }, []);
    function openNotesSidebarSearch(): void { setNotesSidebarMode('search'); setNotesSearchFocusToken(token => token + 1); }
    function handleNotesViewModeChange(mode: DashboardNotesViewMode): void { view.setNotesViewMode(mode); void saveUi({ notesViewMode: mode }); }
    function handleNotesAuthoringModeChange(mode: DashboardNotesAuthoringMode): void { view.setNotesAuthoringMode(mode); void saveUi({ notesAuthoringMode: mode }); }
    function handleNotesWordWrapChange(value: boolean): void { view.setNotesWordWrap(value); void saveUi({ notesWordWrap: value }); }
    function handleNotesVimModeChange(value: boolean): void { view.setNotesVimMode(value); void saveUi({ notesVimMode: value }); }
    function handleNotesTreeWidthChange(value: number): void { view.setNotesTreeWidth(value); void saveUi({ notesTreeWidth: value }); }
    function handleNotesGraphSettingsChange(value: DashboardNotesGraphSettings): void { view.setNotesGraphSettings(value); void saveUi({ notesGraphSettings: value }); }
    const notesModel = useNotesModel({
        active: view.sidebarMode === 'notes',
        selectedPath: view.notesSelectedPath,
        onSelectedPathChange: handleNotesSelectedPathChange,
    });

    const notesSelectedNote = view.notesSelectedPath
        ? notesModel.index?.notes.find(n => n.path === view.notesSelectedPath) ?? null
        : null;
    function handleDashboardSettingsPatch(ui: NonNullable<Parameters<typeof saveUi>[0]>): void {
        if (ui.showLatestActivityTitles !== undefined) view.setShowLatestActivityTitles(ui.showLatestActivityTitles);
        if (ui.showInlineLabelEditor !== undefined) view.setShowInlineLabelEditor(ui.showInlineLabelEditor);
        if (ui.showSidebarRuntimeLine !== undefined) view.setShowSidebarRuntimeLine(ui.showSidebarRuntimeLine);
        if (ui.showSelectedRowActions !== undefined) view.setShowSelectedRowActions(ui.showSelectedRowActions);
        if (ui.dashboardShortcutsEnabled !== undefined) view.setDashboardShortcutsEnabled(ui.dashboardShortcutsEnabled);
        if (ui.dashboardShortcutKeymap !== undefined) view.setDashboardShortcutKeymap(ui.dashboardShortcutKeymap);
        if (ui.diffRootPolicy !== undefined) view.setDiffRootPolicy(ui.diffRootPolicy); if (ui.diffPinnedRootByPort !== undefined) view.setDiffPinnedRootByPort(ui.diffPinnedRootByPort); if (ui.diffRecentRepoRoots !== undefined) view.setDiffRecentRepoRoots(ui.diffRecentRepoRoots); if (ui.diffDefaultMode !== undefined) view.setDiffDefaultMode(ui.diffDefaultMode);
        if (ui.diffBaseRef !== undefined) view.setDiffBaseRef(ui.diffBaseRef); if (ui.diffIncludeUntracked !== undefined) view.setDiffIncludeUntracked(ui.diffIncludeUntracked);
        if (ui.rightFolderRootPath !== undefined) view.setRightFolderRootPath(ui.rightFolderRootPath);
        if (ui.locale !== undefined) view.setLocale(ui.locale);
        void saveUi(ui);
    }

    function selectRelativeInstance(direction: 1 | -1): void {
        if (filtered.length === 0) return;
        const currentPort = selectedInstance?.port ?? null;
        const currentIndex = currentPort == null
            ? -1
            : filtered.findIndex(instance => instance.port === currentPort);
        const baseIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
        const nextIndex = (baseIndex + direction + filtered.length) % filtered.length;
        const next = filtered[nextIndex];
        if (!next) return;
        handleSelectInstance(next);
    }

    function runManagerShortcut(action: DashboardShortcutAction): void {
        runManagerShortcutAction(action, {
            selectedInstance,
            filtered,
            activeDetailTab: view.activeDetailTab,
            setDrawerOpen: view.setDrawerOpen,
            handleSidebarModeChange,
            handlePreview,
            selectRelativeInstance,
            handleTabChange,
            setPreviewRefreshKey,
            handleSidebarToggle,
            toggleInstanceSettings: () => setDashboardSettingsOpen(view.sidebarMode !== 'settings'),
        });
    }
    useEffect(() => {
        if (!view.dashboardShortcutsEnabled) return undefined;
        const unsubscribe = getDesktop()?.shortcuts?.onAction?.((action) => {
            runManagerShortcut(action);
        });
        return unsubscribe;
    }, [filtered, selectedInstance, view.dashboardShortcutsEnabled, view.sidebarMode, view.activeDetailTab, settingsDirty, dashboardSettingsDirty]);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
                const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
                if (frame?.contentWindow) {
                    event.preventDefault();
                    frame.contentWindow.postMessage({ type: 'jaw-preview-search' }, '*');
                    return;
                }
            }
            if (!view.dashboardShortcutsEnabled) return;
            if (isManagerShortcutEditableTarget(event.target)) return;
            const action = actionForShortcutEvent(event, view.dashboardShortcutKeymap, { menuOwned: getDesktop() != null });
            if (!action) return;
            event.preventDefault();
            runManagerShortcut(action);
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [filtered, selectedInstance, view.dashboardShortcutsEnabled, view.dashboardShortcutKeymap, view.sidebarMode, view.activeDetailTab, settingsDirty, dashboardSettingsDirty]);

    async function handleLifecycle(action: DashboardLifecycleAction, instance: DashboardInstance): Promise<void> {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if (action === 'perm' && !window.confirm(`Register :${instance.port} as a persistent system service? It will auto-start on login and auto-restart on crash.`)) {
            return;
        }
        if (action === 'unperm' && !window.confirm(`Remove persistent service for :${instance.port}? The instance will stop and won't auto-start.`)) {
            return;
        }
        if (action === 'stop' && lifecycle.owner === 'service') {
            if (!window.confirm(`Stop :${instance.port}? This will also remove the persistent service.`)) return;
        } else if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
            return;
        }
        if (!canLeaveDirtySettings()) return;
        setSettingsDirty(false);
        const previousUptime = instance.uptime;
        view.setSelectedPort(instance.port);
        void saveUi({ selectedPort: instance.port });
        setLifecycleBusyPort(instance.port);
        setLifecycleMessage(null);
        setTransitioningPort(instance.port);
        setTransitionAction(action);
        try {
            const home = action === 'start' ? customHome : undefined;
            const result = await runLifecycleAction(action, instance.port, home);
            const expected = result.expectedStateAfter
                || (action === 'start' || action === 'perm' ? 'online' : action === 'stop' || action === 'unperm' ? 'offline' : 'restart-detected');
            const polled = await pollUntilSettled({
                port: instance.port,
                expected,
                previousUptime,
                fetchOnce: (port, signal) => fetchInstanceStatus(port, { signal }),
            });
            if (!polled.settled) {
                setLifecycleMessage(`${result.message} (not yet reachable, refresh manually if needed)`);
            }
            if (polled.instance) {
                setData((current) => current ? { ...current, instances: current.instances.map(row => row.port === instance.port ? polled.instance! : row) } : current);
            }
            await load(showHidden, true);
            publishInvalidation({ topics: ['instances'], reason: 'instance:lifecycle', source: 'ui', sourceId: 'app' });
        } catch (err) {
            setLifecycleMessage((err as Error).message);
        } finally {
            setLifecycleBusyPort(null);
            setTransitioningPort(null);
            setTransitionAction(null);
        }
    }

    const instanceListContent = (
        <InstanceListContent error={error} loading={loading} instances={instances} filtered={filtered}
            selectedInstance={selectedInstance} data={data} lifecycleBusyPort={lifecycleBusyPort}
            transitioningPort={transitioningPort} transitionAction={transitionAction}
            activityUnreadByPort={activityUnread.unreadByPort} latestTitleByPort={messageActivity.titlesByPort}
            busyPorts={messageActivity.busyPorts} showLatestActivityTitles={view.showLatestActivityTitles}
            showInlineLabelEditor={view.showInlineLabelEditor} showSidebarRuntimeLine={view.showSidebarRuntimeLine}
            showSelectedRowActions={view.showSelectedRowActions} profiles={profiles} getLabel={instanceLabel}
            formatUptime={formatUptime} onSelect={handleSelectInstance} onPreview={(instance) => handlePreview(instance, true)}
            onMarkActivitySeen={activityUnread.markPortSeen} onInstanceLabelSave={labelEditor.saveInstanceLabel}
            onLifecycle={(action, instance) => void handleLifecycle(action, instance)} onToggleFavorite={(instance) => { void registry.save({ instances: { [String(instance.port)]: { favorite: !instance.favorite } } }).then(() => { load(); publishInvalidation({ topics: ['instances'], reason: 'instance:favorite-toggled', source: 'ui', sourceId: 'app' }); }); }} />
    );
    const dashboardSettingsUi = dashboardSettingsUiFromView(view, theme.theme), titleSupport = summarizeActivityTitleSupport(messageActivity.titleSupportByPort);
    const profileChipStrip = (chipProfiles: DashboardProfile[]) => chipProfiles.length > 0 ? <div className="profile-chip-strip drawer-chip-strip" aria-label="Profile filters">{chipProfiles.map(profile => <ProfileChip key={profile.profileId} profile={profile} active={activeProfileIds.includes(profile.profileId)} count={profileCounts[profile.profileId] || 0} onToggle={toggleProfile} />)}</div> : null;

    const detailContent = (tab: DashboardDetailTab) => (
        <InstanceDetailPanel
            instance={selectedInstance}
            data={data}
            activeTab={tab}
            onRegistryPatch={(port, patch) => { void registry.save({ instances: { [String(port)]: patch } }).then(() => { load(); publishInvalidation({ topics: ['instances'], reason: 'instance:registry-patched', source: 'ui', sourceId: 'app' }); }); }}
        />
    );

    return <AppChrome view={view} palette={palette} theme={theme} query={query} loading={loading} showHidden={showHidden} instances={instances} selectedInstance={selectedInstance} data={data} summary={summary} scheduleGroup={scheduleGroup} boardView={boardView} notesModel={notesModel} notesSelectedNote={notesSelectedNote} notesDirtyPath={notesDirtyPath} notesHighlightedPath={notesHighlightedPath} notesSidebarMode={notesSidebarMode} notesSearchFocusToken={notesSearchFocusToken} settingsSection={dashboardSettingsSection} dashboardSettingsUi={dashboardSettingsUi} titleSupport={titleSupport} activityEvents={activityEvents} busyPorts={messageActivity.busyPorts} titlesByPort={messageActivity.titlesByPort} lifecycleMessage={lifecycleMessage} error={error} registryMessage={registry.error || labelEditor.error || managerEvents.error} onPickProject={(port) => void projectPicker.pick(port)} projectPickBusy={projectPicker.busyPort != null} onRefreshPreview={() => setPreviewRefreshKey(key => key + 1)} onSettingsDirtyChange={onSettingsDirtyChange} detailContent={detailContent} instanceListContent={instanceListContent} drawerProfileFilters={profileChipStrip(profiles)} jawCeoWorkbenchButton={jawCeoBridge.workbenchButton} jawCeoVoiceOverlay={jawCeoBridge.voiceOverlay} jawCeo={jawCeoBridge.ceo} jawCeoVoice={jawCeoBridge.voice} jawCeoOpen={jawCeoBridge.open} jawCeoSelectedPort={activeJawCeoPort} onJawCeoOpenChange={jawCeoBridge.setOpen} onJawCeoOpenWorker={handleOpenJawCeoWorker} previewEnabled={previewEnabled} previewRefreshKey={previewRefreshKey} autoUnloadNotice={autoUnloadNotice} helpOpen={helpOpen} helpTopic={helpTopic} setQuery={setQuery} setShowHidden={setShowHidden} setPreviewEnabled={setPreviewEnabled} setAutoUnloadNotice={setAutoUnloadNotice} setHelpOpen={setHelpOpen} setHelpTopic={setHelpTopic} onOpenHelpTopic={openHelpTopic} setNotesSidebarMode={setNotesSidebarMode} setBoardView={setBoardView} setScheduleGroup={setScheduleGroup} setDashboardSettingsSection={setDashboardSettingsSection} load={load} cycleTheme={cycleTheme} openSelectedInBrowser={openSelectedInBrowser} handleSelectInstance={handleSelectInstance} handleSidebarModeChange={handleSidebarModeChange} handleSidebarToggle={handleSidebarToggle} handleNotesSelectedPathChange={handleNotesSelectedPathChange} openNotesFromPreview={openNotesFromPreview} handleNotesViewModeChange={handleNotesViewModeChange} handleNotesAuthoringModeChange={handleNotesAuthoringModeChange} handleNotesWordWrapChange={handleNotesWordWrapChange} handleNotesVimModeChange={handleNotesVimModeChange} handleNotesTreeWidthChange={handleNotesTreeWidthChange} handleNotesGraphSettingsChange={handleNotesGraphSettingsChange} openNotesSidebarSearch={openNotesSidebarSearch} setNotesDirtyPath={setNotesDirtyPath} handleTabChange={handleTabChange} handleActivityToggle={handleActivityToggle} handleActivityHeight={handleActivityHeight} onDismissLifecycleMessage={() => setLifecycleMessage(null)} handleDashboardSettingsPatch={handleDashboardSettingsPatch} activityUnreadOpenAndMarkSeen={activityUnread.openAndMarkSeen} panelInitialState={panelInitialState} onPanelStateChange={handlePanelStateChange} onShortcutAction={runManagerShortcut} />;
}
