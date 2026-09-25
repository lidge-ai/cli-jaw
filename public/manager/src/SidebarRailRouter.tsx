import { useCallback, useEffect, useRef, useState, type ReactNode, Suspense } from 'react';
import { ActivityDock } from './components/ActivityDock';
import { InstanceDrawer } from './components/InstanceDrawer';
import { InstanceNavigator } from './components/InstanceNavigator';
import { MobileNav } from './components/MobileNav';
import { SidebarRail } from './components/SidebarRail';
import { Workbench } from './components/Workbench';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { lazy } from 'react';
import { RightSidebar } from './panels/RightSidebar';
import { BottomPanel, type BottomPanelRenderControls } from './panels/BottomPanel';
import { usePanelLayout } from './panels/PanelLayoutProvider';
import { currentManagerSurface } from './panels/panel-capabilities';
import { getDesktop } from './panels/desktop-bridge';
import type { RightSidebarTabKind, RightSidebarOpenTab, BottomPanelTab } from './panels/types';
import type { FolderPanelSessionState } from './folder-panel/folder-panel-session';
import type { WorkbenchRepoRootMode } from './workbench/workbench-resource-types';

const TerminalPanel = lazy(() => import('./terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const DiffPanel = lazy(() => import('./diff-panel/DiffPanel').then(m => ({ default: m.DiffPanel })));
const FolderPanel = lazy(() => import('./folder-panel/FolderPanel').then(m => ({ default: m.FolderPanel })));
const DocPanel = lazy(() => import('./doc-panel/DocPanel').then(m => ({ default: m.DocPanel })));
const BrowserPanel = lazy(() => import('./browser-panel/BrowserPanel').then(m => ({ default: m.BrowserPanel })));
const DesignPanel = lazy(() => import('./design-panel/DesignPanel').then(m => ({ default: m.DesignPanel })));
import { FileFolderSplitPanel } from './panels/FileFolderSplitPanel';
import { InstancePreview, type PreviewInsertTextRequest, type PreviewInsertTextResult } from './InstancePreview';
import { type DashboardSettingsSection } from './dashboard-settings/DashboardSettingsSidebar';
import { SettingsPage } from './settings/SettingsPage';
import { DashboardSettingsWorkspace } from './dashboard-settings/DashboardSettingsWorkspace';
import { NotesSidebar, type NotesSidebarMode } from './notes/NotesSidebar';
import { NotesWorkspace } from './notes/NotesWorkspace';
import { DashboardBoardSidebar } from './dashboard-board/DashboardBoardSidebar';
import { DashboardBoardWorkspace } from './dashboard-board/DashboardBoardWorkspace';
import type { BoardView } from './dashboard-board/board-view';
import { DashboardScheduleSidebar, type ScheduleGroup } from './dashboard-schedule/DashboardScheduleSidebar';
import { DashboardScheduleWorkspace } from './dashboard-schedule/DashboardScheduleWorkspace';
import { DashboardRemindersSidebar, type RemindersView } from './dashboard-reminders/DashboardRemindersSidebar';
import { DashboardRemindersWorkspace } from './dashboard-reminders/DashboardRemindersWorkspace';
import { useRemindersFeed } from './dashboard-reminders/useRemindersFeed';
import { useEmbeddedBrowserTargetSync } from './browser-panel/use-embedded-target-sync';
import {
    describeDroppedPathsEvent,
    firstDirectory,
    firstFile,
    useElectronDroppedPaths,
    type ElectronDroppedPathsEvent,
} from './hooks/useElectronDroppedPaths';
import type { HelpTopicId } from './help/helpContent';
import { NotesCommandPalette } from './notes/NotesCommandPalette';
import { NotesCommandProvider } from './notes/notes-command-registry';
import type { NotesModelState } from './notes/useNotesModel';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardNotesAuthoringMode,
    DashboardNotesGraphSettings,
    DashboardNotesViewMode,
    DashboardScanResult,
    DashboardSidebarMode,
    DashboardViewMode,
    NoteMetadata,
    DashboardLocale,
    ManagerEvent,
    DashboardRegistryUi,
    DashboardShortcutAction,
} from './types';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { JawCeoConsole } from './jaw-ceo/JawCeoConsole';
import type { JawCeoController } from './jaw-ceo/useJawCeo';
import type { JawCeoVoiceController } from './jaw-ceo/useJawCeoVoice';
import { ModeSwitch } from './code/ModeSwitch';
const CodeCanvas = lazy(() => import('./code/CodeCanvas').then(m => ({ default: m.CodeCanvas })));
import './code/code.css';
import { registerInstanceJumpSelector } from './components/sidebar-keyboard';

type WorkspaceSurfaceProps = {
    active: boolean;
    children: ReactNode;
};

function WorkspaceSurface(props: WorkspaceSurfaceProps) {
    return <section className={`workspace-surface${props.active ? ' is-active' : ''}`} hidden={!props.active} aria-hidden={!props.active}>{props.children}</section>;
}

function expandDesktopHomePath(path: string): string {
    if (!path.startsWith('~/')) return path;
    const home = getDesktop()?.getHomePath?.()?.replace(/\/+$/, '');
    return home ? `${home}/${path.slice(2)}` : path;
}

type Props = {
    sidebarCollapsed: boolean;
    activityDockCollapsed: boolean;
    activityDockHeight: number;
    drawerOpen: boolean;
    onCloseDrawer: () => void;
    onlineCount: number;
    sidebarMode: DashboardSidebarMode;
    scheduleWorkspaceEnabled: boolean;
    remindersWorkspaceEnabled: boolean;
    onSidebarModeChange: (mode: DashboardSidebarMode) => void;
    onToggleSidebar: () => void;
    helpOpen: boolean;
    onToggleHelp: () => void;
    onOpenHelpTopic: (topic: HelpTopicId) => void;
    settingsSection: DashboardSettingsSection;
    locale: DashboardLocale;
    onSettingsSectionChange: (section: DashboardSettingsSection) => void;
    notesModel: NotesModelState;
    notesSelectedPath: string | null;
    notesSelectedNote: NoteMetadata | null;
    notesDirtyPath: string | null;
    notesHighlightedPath: string | null;
    notesTreeWidth: number;
    notesSidebarMode: NotesSidebarMode;
    notesSearchFocusToken: number;
    notesViewMode: DashboardNotesViewMode;
    notesAuthoringMode: DashboardNotesAuthoringMode;
    notesWordWrap: boolean;
    notesVimMode: boolean;
    onNotesSidebarModeChange: (mode: NotesSidebarMode) => void;
    notesGraphSettings?: DashboardNotesGraphSettings | undefined;
    onOpenNotesSearch: () => void;
    onNotesSelectedPathChange: (path: string | null) => void;
    onNotesDirtyPathChange: (path: string | null) => void;
    onNotesViewModeChange: (mode: DashboardNotesViewMode) => void;
    onNotesAuthoringModeChange: (mode: DashboardNotesAuthoringMode) => void;
    onNotesWordWrapChange: (value: boolean) => void;
    onNotesVimModeChange: (value: boolean) => void;
    onNotesTreeWidthChange: (value: number) => void;
    onNotesGraphSettingsChange: (settings: DashboardNotesGraphSettings) => void;
    onOpenNotesFromPreview?: (path: string) => void;
    boardView: BoardView;
    onBoardViewChange: (view: BoardView) => void;
    scheduleGroup: ScheduleGroup;
    onScheduleGroupChange: (group: ScheduleGroup) => void;
    instances: DashboardInstance[];
    selectedInstance: DashboardInstance | null;
    data: DashboardScanResult | null;
    titlesByPort: Record<number, string>;
    busyPorts: Set<number>;
    activeDetailTab: DashboardDetailTab;
    onSettingsDirtyChange: (entry: 'dashboard', dirty: boolean) => void;
    onSettingsSaved?: () => void;
    onDetailTabChange: (tab: DashboardDetailTab) => void;
    workbenchHeader: ReactNode;
    detailContent: (tab: DashboardDetailTab) => ReactNode;
    previewEnabled: boolean;
    previewRefreshKey: number;
    previewTheme: 'dark' | 'light';
    lifecycleMessage: string | null;
    onDismissLifecycleMessage: () => void;
    instanceListContent: ReactNode;
    jawCeoWorkbenchButton?: ReactNode | undefined;
    jawCeoVoiceOverlay?: ReactNode | undefined;
    jawCeo?: JawCeoController | undefined;
    jawCeoVoice?: JawCeoVoiceController | undefined;
    jawCeoOpen?: boolean | undefined;
    jawCeoSelectedPort?: number | null | undefined;
    onJawCeoOpenChange?: ((open: boolean) => void) | undefined;
    onJawCeoOpenWorker?: ((port: number, messageId?: number) => void) | undefined;
    loading: boolean;
    error: string | null;
    registryMessage: string | null;
    managerEvents: ManagerEvent[];
    onToggleActivity: () => void;
    onActivityHeightChange: (height: number) => void;
    onOpenDrawer: () => void;
    onSelectTab: (tab: DashboardDetailTab) => void;
    onToggleActivityFromMobile: () => void;
    drawerProfileFilters: ReactNode;
    dashboardSettingsUi: Parameters<typeof DashboardSettingsWorkspace>[0]['ui'];
    titleSupport: Parameters<typeof DashboardSettingsWorkspace>[0]['titleSupport'];
    onDashboardSettingsPatch: Parameters<typeof DashboardSettingsWorkspace>[0]['onUiPatch'];
    viewMode: DashboardViewMode;
    onViewModeChange: (mode: DashboardViewMode) => void;
    port: number;
    workingDir: string;
    /** Resolved `newCodeSession` chord, shown as the sidebar button's hint. */
    codeNewSessionShortcut?: string;
    query: string;
    onQueryChange: (value: string) => void;
    onSelectInstance: (instance: DashboardInstance) => void;
};

type RightPanelRenderContext = {
    /** Active module tab id (keep-alive bodies need to know visibility). */
    activeTabId: string | null;
    /** Selected instance's primary projectDir (Design OD-2 snapshot source). */
    primaryProjectDir: string | null;
    /** Fallback Files root for tabs that have no root of their own yet. */
    fallbackFolderRootPath: string | null;
    /** The Files tab whose state feeds the singleton Diff panel (active or first). */
    diffFilesTab: RightSidebarOpenTab | null;
    gitRefreshVersion: number;
    onOpenFileGlobal: (path: string) => void;
    onTabPreviewFile: (tabId: string, path: string) => void;
    onTabRootChange: (tabId: string, path: string | null) => void;
    onTabRepoRootChange: (tabId: string, path: string | null, mode?: WorkbenchRepoRootMode) => void;
    onFollowInstanceRepoRoot: (tabId: string | null, path: string | null) => void;
    onBrowserPageState: (tabId: string, state: { url: string; title: string }) => void;
    onOpenBrowserWindow: (url: string) => void;
    onInsertCommentIntoPreview: (port: number, text: string) => Promise<PreviewInsertTextResult>;
    onGitRefresh: () => void;
    selectedInstance: DashboardInstance | null;
    dashboardSettingsUi: DashboardRegistryUi;
    onDashboardSettingsPatch: (patch: Partial<DashboardRegistryUi>) => void;
    notesModel: NotesModelState;
    folderSessions: Record<string, FolderPanelSessionState | null>;
    onFolderSessionChange: (tabId: string, state: FolderPanelSessionState) => void;
};

function renderRightPanelContent(
    kind: RightSidebarTabKind,
    tab: RightSidebarOpenTab,
    ctx: RightPanelRenderContext,
): ReactNode {
    const fallback = <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: '12px' }}>Loading...</div>;
    switch (kind) {
        case 'diff': {
            const refTab = ctx.diffFilesTab;
            const files = refTab?.files ?? {};
            return <Suspense fallback={fallback}><DiffPanel
                selectedInstance={ctx.selectedInstance}
                settings={ctx.dashboardSettingsUi}
                folderRootPath={files.folderRootPath ?? ctx.fallbackFolderRootPath}
                repoRootPath={files.repoRootPath ?? null}
                repoRootMode={files.repoRootMode ?? 'instance'}
                selectedFilePath={files.activeFilePath ?? null}
                onRepoRootChange={(path, mode) => { if (refTab) ctx.onTabRepoRootChange(refTab.id, path, mode); }}
                onFollowInstanceRepoRoot={path => ctx.onFollowInstanceRepoRoot(refTab?.id ?? null, path)}
                onPreviewFile={ctx.onOpenFileGlobal}
                onGitRefresh={ctx.onGitRefresh}
                onSettingsPatch={ctx.onDashboardSettingsPatch}
            /></Suspense>;
        }
        case 'files': {
            const files = tab.files ?? {};
            const folderRoot = files.folderRootPath ?? ctx.fallbackFolderRootPath;
            const repoRootMode = files.repoRootMode ?? 'instance';
            return <FileFolderSplitPanel
                filePane={<Suspense fallback={fallback}><DocPanel filePath={files.activeFilePath ?? undefined} onOpenLocalFile={path => ctx.onTabPreviewFile(tab.id, path)} /></Suspense>}
                folderPane={<Suspense fallback={fallback}><FolderPanel selectedFilePath={files.activeFilePath ?? null} externalRootPath={folderRoot} repoRootPath={repoRootMode === 'instance' ? files.repoRootPath ?? null : null} gitRefreshVersion={ctx.gitRefreshVersion} notesTree={ctx.notesModel.tree} notesRoot={ctx.notesModel.notesRoot} onRootChange={path => ctx.onTabRootChange(tab.id, path)} onRepoRootChange={path => ctx.onTabRepoRootChange(tab.id, path)} onGitRefresh={ctx.onGitRefresh} onPreviewFile={path => ctx.onTabPreviewFile(tab.id, path)} sessionState={ctx.folderSessions[tab.id] ?? null} onSessionStateChange={state => ctx.onFolderSessionChange(tab.id, state)} /></Suspense>}
            />;
        }
        case 'browser': return <Suspense fallback={fallback}><BrowserPanel
            singlePage
            initialUrl={tab.browser?.url}
            isActivePanel={tab.id === ctx.activeTabId}
            moduleTabId={tab.id}
            selectedInstancePort={ctx.selectedInstance?.port ?? null}
            onInsertCommentIntoPreview={ctx.onInsertCommentIntoPreview}
            onPageStateChange={state => ctx.onBrowserPageState(tab.id, state)}
            onOpenNewWindow={ctx.onOpenBrowserWindow}
        /></Suspense>;
        case 'design': return <Suspense fallback={fallback}><DesignPanel
            tab={tab}
            primaryProjectDir={ctx.primaryProjectDir}
            selectedInstancePort={ctx.selectedInstance?.port ?? null}
            onOpenInBrowser={ctx.onOpenBrowserWindow}
        /></Suspense>;
        default: return null;
    }
}

function renderBottomTabContent(tab: BottomPanelTab, controls: BottomPanelRenderControls, selectedInstancePort: number | null, onInsertCommentIntoPreview: (port: number, text: string) => Promise<PreviewInsertTextResult>): ReactNode {
    const fallback = <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: '12px' }}>Loading...</div>;
    switch (tab) {
        case 'terminal': return <Suspense fallback={fallback}><TerminalPanel onCollapse={controls.onCollapse} onEmptySessions={controls.onCloseTab} /></Suspense>;
        case 'browser': return <Suspense fallback={fallback}><BrowserPanel onCollapse={controls.onCollapse} selectedInstancePort={selectedInstancePort} onInsertCommentIntoPreview={onInsertCommentIntoPreview} /></Suspense>;
        default: return null;
    }
}

export function SidebarRailRouter(props: Props) {
    const dashboardDirty = useCallback((dirty: boolean) => props.onSettingsDirtyChange('dashboard', dirty), [props.onSettingsDirtyChange]);
    const selected = props.selectedInstance;
    const settingsTarget = selected ? { port: selected.port, instanceUrl: selected.url } : {};
    const managerSettings = { ui: props.dashboardSettingsUi, titleSupport: props.titleSupport, onUiPatch: props.onDashboardSettingsPatch };
    // The rail gear is the only settings entry point, and it renders manager scope only.
    // Instance settings belong to the instance; see wp4 for how the manager reaches them.
    const settingsVisible = props.sidebarMode === 'settings';
    const panelLayout = usePanelLayout();
    // Per-Files-tab resource state lives in the tab metadata (020 §5 Option B).
    // The registry's rightFolderRootPath remains the fallback root for tabs
    // that have not picked their own root yet.
    const fallbackFolderRootPath = props.dashboardSettingsUi.rightFolderRootPath;
    const openTabs = panelLayout.state.rightPanel.tabs.openTabs;
    const activeTabId = panelLayout.state.rightPanel.tabs.activeTabId;
    const activeTab = openTabs.find(t => t.id === activeTabId) ?? null;
    const targetFilesTab = activeTab?.kind === 'files' ? activeTab : (openTabs.find(t => t.kind === 'files') ?? null);
    const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
    const bumpGitRefresh = useCallback(() => setGitRefreshVersion(version => version + 1), []);
    const [folderSessions, setFolderSessions] = useState<Record<string, FolderPanelSessionState | null>>({});
    const [, setRecentDroppedPaths] = useState<ElectronDroppedPathsEvent | null>(null);
    const [dropNotice, setDropNotice] = useState<string | null>(null);
    const [remindersView, setRemindersView] = useState<RemindersView>('matrix');
    const remindersFeed = useRemindersFeed({ active: props.sidebarMode === 'reminders' });
    const isElectron = currentManagerSurface() === 'electron';
    const desktopPanelsAvailable = isElectron;
    const [previewInsertTextRequest, setPreviewInsertTextRequest] = useState<PreviewInsertTextRequest | null>(null);
    const previewInsertSeqRef = useRef(0);
    const previewInsertResolversRef = useRef(new Map<string, (result: PreviewInsertTextResult) => void>());
    // Instance settings live in the instance. The manager only asks the mounted preview to
    // open its own page; a one-shot id keeps repeat clicks addressable.
    const [previewSettingsOpenRequest, setPreviewSettingsOpenRequest] = useState<string | null>(null);
    const previewSettingsSeqRef = useRef(0);
    const [instanceSettingsNotice, setInstanceSettingsNotice] = useState<string | null>(null);
    // 030 v2/v3: keep the server registry in sync, deliver shares to the
    // selected instance's runtime-context, and relay screenshot commands.
    useEmbeddedBrowserTargetSync(isElectron, props.selectedInstance?.port ?? null);
    const rightPanelOpen = desktopPanelsAvailable && panelLayout.effectiveRightOpen;
    const codeWorkingDir = targetFilesTab?.files?.folderRootPath || fallbackFolderRootPath || props.workingDir || '';

    const handleInsertCommentIntoPreview = useCallback((port: number, text: string): Promise<PreviewInsertTextResult> => {
        if (props.selectedInstance?.port !== port) {
            return Promise.resolve({ ok: false, error: 'selected instance changed before preview insert' });
        }
        if (!props.previewEnabled) {
            return Promise.resolve({ ok: false, error: 'Preview is off. Turn it on before inserting a browser comment.' });
        }
        if (props.sidebarMode !== 'instances' || props.viewMode !== 'jaw' || props.activeDetailTab !== 'preview') {
            return Promise.resolve({ ok: false, error: 'Open the selected instance Preview tab before inserting a browser comment.' });
        }
        const id = `browser-comment-${Date.now()}-${++previewInsertSeqRef.current}`;
        setPreviewInsertTextRequest({ id, port, text });
        return new Promise(resolve => {
            const timer = window.setTimeout(() => {
                previewInsertResolversRef.current.delete(id);
                setPreviewInsertTextRequest(current => current?.id === id ? null : current);
                resolve({ ok: false, error: 'preview insert timed out; reopen the selected instance Preview tab and try again' });
            }, 1400);
            previewInsertResolversRef.current.set(id, result => {
                window.clearTimeout(timer);
                resolve(result);
            });
        });
    }, [props.activeDetailTab, props.previewEnabled, props.selectedInstance?.port, props.sidebarMode, props.viewMode]);

    const handlePreviewInsertTextResult = useCallback((id: string, result: PreviewInsertTextResult): void => {
        const resolve = previewInsertResolversRef.current.get(id);
        if (!resolve) return;
        previewInsertResolversRef.current.delete(id);
        setPreviewInsertTextRequest(current => current?.id === id ? null : current);
        resolve(result);
    }, []);

    const requestInstanceSettings = useCallback((): void => {
        setInstanceSettingsNotice(null);
        previewSettingsSeqRef.current += 1;
        setPreviewSettingsOpenRequest(`settings-open-${previewSettingsSeqRef.current}`);
    }, []);
    const handlePreviewSettingsOpenResult = useCallback((id: string, result: PreviewInsertTextResult): void => {
        setPreviewSettingsOpenRequest(current => current === id ? null : current);
        setInstanceSettingsNotice(result.ok ? null : result.error);
    }, []);

    // CEO: handled through right sidebar tab system now. CEO is hidden in v1,
    // but we keep the overlay console for non-Electron surfaces.
    const ceoConsoleOpen = !isElectron && props.jawCeoOpen;
    const handleCloseCeo = useCallback(() => {
        props.onJawCeoOpenChange?.(false);
    }, [props.onJawCeoOpenChange]);

    const jawCeoPanel = (ceoConsoleOpen && props.jawCeo && props.jawCeoVoice) ? (
        <JawCeoConsole
            open
            selectedPort={props.jawCeoSelectedPort ?? null}
            ceo={props.jawCeo}
            voice={props.jawCeoVoice}
            onClose={handleCloseCeo}
            onOpenWorker={props.onJawCeoOpenWorker ?? (() => {})}
        />
    ) : null;
    const bottomPanelOpen = desktopPanelsAvailable && panelLayout.state.bottomPanel.open;
    const notesSelectedHiddenByFilter = Boolean(
        props.notesModel.tagFilter
        && props.notesSelectedPath
        && props.notesSelectedNote
        && !props.notesSelectedNote.tags?.includes(props.notesModel.tagFilter),
    );

    useEffect(() => {
        registerInstanceJumpSelector(port => {
            const instance = props.instances.find(row => row.port === port)
                ?? (props.selectedInstance?.port === port ? props.selectedInstance : null);
            if (instance) props.onSelectInstance(instance);
        });
        return () => {
            registerInstanceJumpSelector(null);
        };
    }, [props.instances, props.selectedInstance, props.onSelectInstance]);
    // External file open: focus/create a Files tab and assign the file to it.
    // Stable identity matters: this is passed as `onLocalFileOpen` into
    // MarkdownRenderer (via CodeCanvas/DocPanel), and a fresh function each
    // render defeats its React.memo and the memoized components object.
    // Depend on `dispatch`, not `panelLayout`: the context value is rebuilt on
    // every panel state change, which would churn this identity right back.
    const panelDispatch = panelLayout.dispatch;
    const handleRightPreviewFile = useCallback((path: string): void => {
        const previewPath = expandDesktopHomePath(path.trim());
        if (!previewPath) return;
        panelDispatch({ type: 'OPEN_FILE_IN_FILES_TAB', path: previewPath });
    }, [panelDispatch]);

    // Per-tab callbacks bound to a specific Files module tab.
    const handleTabPreviewFile = useCallback((tabId: string, path: string): void => {
        const previewPath = expandDesktopHomePath(path.trim());
        if (!previewPath) return;
        panelLayout.dispatch({ type: 'SET_FILES_TAB_FILE', tabId, path: previewPath });
    }, [panelLayout]);

    const handleTabRootChange = useCallback((tabId: string, path: string | null): void => {
        setFolderSessions(current => (current[tabId] ? { ...current, [tabId]: null } : current));
        panelLayout.dispatch({ type: 'SET_FILES_TAB_ROOT', tabId, path });
        props.onDashboardSettingsPatch({ rightFolderRootPath: path });
    }, [panelLayout, props.onDashboardSettingsPatch]);

    const handleTabRepoRootChange = useCallback((tabId: string, path: string | null, mode: WorkbenchRepoRootMode = 'instance'): void => {
        panelLayout.dispatch({ type: 'SET_FILES_TAB_REPO_ROOT', tabId, path, mode });
    }, [panelLayout]);

    const handleFollowInstanceRepoRoot = useCallback((tabId: string | null, path: string | null): void => {
        if (!tabId) return;
        // Explicit follow-instance reset clears a manual pin.
        panelLayout.dispatch({ type: 'SET_FILES_TAB_REPO_ROOT', tabId, path, mode: 'follow-instance' });
    }, [panelLayout]);

    const handleFolderSessionChange = useCallback((tabId: string, state: FolderPanelSessionState): void => {
        setFolderSessions(current => ({ ...current, [tabId]: state }));
    }, []);

    // Browser module page state: the module tab owns its page url/title.
    const handleBrowserPageState = useCallback((tabId: string, state: { url: string; title: string }): void => {
        panelLayout.dispatch({ type: 'SET_BROWSER_TAB_STATE', tabId, url: state.url, title: state.title });
    }, [panelLayout]);

    // "Open in new tab" from an embedded page creates a new Browser module tab.
    const handleOpenBrowserWindow = useCallback((url: string): void => {
        panelLayout.dispatch({ type: 'OPEN_BROWSER_MODULE_TAB', url });
    }, [panelLayout]);

    // Code workspace root change: update the target Files tab root (without
    // forcing the sidebar open) and keep the registry fallback in sync.
    const targetFilesTabId = targetFilesTab?.id ?? null;
    const handleCodeWorkingDirChange = useCallback((path: string | null): void => {
        if (targetFilesTabId) {
            panelLayout.dispatch({ type: 'SET_FILES_TAB_ROOT', tabId: targetFilesTabId, path });
        }
        props.onDashboardSettingsPatch({ rightFolderRootPath: path });
    }, [panelLayout, props.onDashboardSettingsPatch, targetFilesTabId]);

    const handleDroppedPaths = useCallback((event: ElectronDroppedPathsEvent): void => {
        setRecentDroppedPaths(event);
        setDropNotice(describeDroppedPathsEvent(event));
        if (event.source === 'preview') return;
        const directory = firstDirectory(event.entries);
        if (directory) {
            panelLayout.dispatch({ type: 'OPEN_FOLDER_IN_FILES_TAB', path: directory.path });
            props.onDashboardSettingsPatch({ rightFolderRootPath: directory.path });
            return;
        }
        const file = firstFile(event.entries);
        if (file) handleRightPreviewFile(file.path);
    }, [panelLayout, props.onDashboardSettingsPatch]);

    const electronDrop = useElectronDroppedPaths({ onDroppedPaths: handleDroppedPaths });

    const handlePreviewDroppedFiles = useCallback((files: File[]): void => {
        void electronDrop.resolveDroppedFiles(files, 'preview');
    }, [electronDrop]);
    const primaryProjectDir = props.selectedInstance?.projectDirs?.[0]?.trim() || null;
    const handleLoadPrimaryProjectDir = useCallback((): void => {
        if (!primaryProjectDir) return;
        panelLayout.dispatch({ type: 'OPEN_FOLDER_IN_FILES_TAB', path: primaryProjectDir });
        props.onDashboardSettingsPatch({ rightFolderRootPath: primaryProjectDir });
    }, [panelLayout, primaryProjectDir, props.onDashboardSettingsPatch]);

    const sidebar = useSidebarWidth({
        rightPanelOpen,
        rightPanelWidth: panelLayout.state.rightPanel.width,
    });

    useEffect(() => {
        function onShortcutAction(event: Event) {
            const detail = (event as CustomEvent<DashboardShortcutAction>).detail;
            if (detail === 'resetSidebarWidth') sidebar.reset();
        }
        document.addEventListener('jaw:shortcut-action', onShortcutAction);
        return () => document.removeEventListener('jaw:shortcut-action', onShortcutAction);
    }, [sidebar.reset]);

    return (
        <NotesCommandProvider>
        {props.jawCeoVoiceOverlay}
        <WorkspaceLayout
            navigatorLabel={props.viewMode === 'code' && props.sidebarMode === 'instances' ? 'Code sessions' : undefined}
            sidebarCollapsed={settingsVisible || props.sidebarCollapsed}
            sidebarWidth={sidebar.width}
            onSidebarWidthDelta={sidebar.addDelta}
            onSidebarWidthEnd={sidebar.persist}
            onSidebarWidthReset={sidebar.reset}
            inspectorCollapsed={props.activityDockCollapsed}
            inspectorHeight={props.activityDockCollapsed ? 48 : props.activityDockHeight}
            drawerOpen={props.drawerOpen}
            onCloseDrawer={props.onCloseDrawer}
            rightPanelOpen={rightPanelOpen}
            rightPanelWidth={panelLayout.state.rightPanel.width}
            rightPanelContent={rightPanelOpen ? <RightSidebar onLoadProjectFolder={handleLoadPrimaryProjectDir} loadProjectFolderDisabled={!primaryProjectDir || (targetFilesTab?.files?.folderRootPath ?? fallbackFolderRootPath) === primaryProjectDir} renderPanel={(kind, tab) => renderRightPanelContent(kind, tab, {
                activeTabId,
                primaryProjectDir,
                fallbackFolderRootPath,
                diffFilesTab: targetFilesTab,
                gitRefreshVersion,
                onOpenFileGlobal: handleRightPreviewFile,
                onTabPreviewFile: handleTabPreviewFile,
                onTabRootChange: handleTabRootChange,
                onTabRepoRootChange: handleTabRepoRootChange,
                onFollowInstanceRepoRoot: handleFollowInstanceRepoRoot,
                onBrowserPageState: handleBrowserPageState,
                onOpenBrowserWindow: handleOpenBrowserWindow,
                onInsertCommentIntoPreview: handleInsertCommentIntoPreview,
                onGitRefresh: bumpGitRefresh,
                selectedInstance: props.selectedInstance,
                dashboardSettingsUi: props.dashboardSettingsUi,
                onDashboardSettingsPatch: props.onDashboardSettingsPatch,
                notesModel: props.notesModel,
                folderSessions,
                onFolderSessionChange: handleFolderSessionChange,
            })} /> : undefined}
            bottomPanelOpen={bottomPanelOpen}
            bottomPanelHeight={panelLayout.state.bottomPanel.height}
            bottomPanelContent={panelLayout.state.bottomPanel.tabs.length > 0 ? <BottomPanel renderTab={(tab, controls) => renderBottomTabContent(tab, controls, props.selectedInstance?.port ?? null, handleInsertCommentIntoPreview)} /> : undefined}
            navigator={(
                <>
                    <SidebarRail
                        onlineCount={props.onlineCount}
                        collapsed={settingsVisible || props.sidebarCollapsed}
                        mode={props.sidebarMode}
                        scheduleWorkspaceEnabled={props.scheduleWorkspaceEnabled}
                        remindersWorkspaceEnabled={props.remindersWorkspaceEnabled}
                        onModeChange={props.onSidebarModeChange}
                        onToggleSidebar={props.onToggleSidebar}
                        helpOpen={props.helpOpen}
                        onToggleHelp={props.onToggleHelp}
                    />
                    {!settingsVisible && <ModeSwitch codeMode={props.viewMode === 'code'} onChange={code => { props.onViewModeChange(code ? 'code' : 'jaw'); if (code && props.sidebarMode !== 'instances') props.onSidebarModeChange('instances'); }} />}
                    <div id="manager-sidebar-list" className="manager-sidebar-list" hidden={settingsVisible}>
                        {props.sidebarMode === 'settings' ? (
                            null
                        ) : props.sidebarMode === 'notes' ? (
                            <NotesSidebar tree={props.notesModel.filteredTree} loading={props.notesModel.loading} error={props.notesModel.error} notesRoot={props.notesModel.notesRoot} selectedPath={props.notesSelectedPath} dirtyPath={props.notesDirtyPath} highlightedPath={props.notesHighlightedPath} externalFocusPath={props.notesSelectedPath} treeWidth={props.notesTreeWidth} mode={props.notesSidebarMode} searchFocusToken={props.notesSearchFocusToken} tagFilter={props.notesModel.tagFilter} selectedHiddenByFilter={notesSelectedHiddenByFilter} onModeChange={props.onNotesSidebarModeChange} onOpenSearch={props.onOpenNotesSearch} onSelectedPathChange={props.onNotesSelectedPathChange} onRefreshTree={props.notesModel.refresh} onClearTagFilter={() => props.notesModel.setTagFilter(null)} />
                        ) : props.sidebarMode === 'board' ? (
                            <DashboardBoardSidebar view={props.boardView} onViewChange={props.onBoardViewChange} instances={props.instances} titlesByPort={props.titlesByPort} busyPorts={props.busyPorts} />
                        ) : props.scheduleWorkspaceEnabled && props.sidebarMode === 'schedule' ? (
                            <DashboardScheduleSidebar activeGroup={props.scheduleGroup} onGroupChange={props.onScheduleGroupChange} />
                        ) : props.remindersWorkspaceEnabled && props.sidebarMode === 'reminders' ? (
                            <DashboardRemindersSidebar view={remindersView} onViewChange={setRemindersView} items={remindersFeed.items} loading={remindersFeed.loading} onRefresh={() => void remindersFeed.refresh()} onUpdate={(id, patch) => void remindersFeed.update(id, patch)} />
                        ) : props.viewMode === 'code' ? (
                            <section className="code-manager-session-navigator" aria-label="Code sessions">
                                <div id="code-session-sidebar-host" className="code-session-sidebar-host" />
                            </section>
                        ) : (
                            <InstanceNavigator
                                active={props.selectedInstance}
                                hiddenCount={props.instances.filter(instance => instance.hidden).length}
                                collapsed={props.sidebarCollapsed}
                                query={props.query}
                                onQueryChange={props.onQueryChange}
                                onSelectPort={port => {
                                    const instance = props.instances.find(row => row.port === port)
                                        ?? (props.selectedInstance?.port === port ? props.selectedInstance : null);
                                    if (instance) props.onSelectInstance(instance);
                                }}
                            >
                                {props.instanceListContent}
                            </InstanceNavigator>
                        )}
                    </div>
                </>
            )}
            workbench={(
                <div className="workspace-surface-stack">
                    <NotesCommandPalette active={props.sidebarMode === 'notes'} />
                    {props.lifecycleMessage && (
                        <section className="state lifecycle-state" role="status">
                            <span>{props.lifecycleMessage}</span>
                            <button type="button" className="state-dismiss" aria-label="Dismiss lifecycle message" onClick={props.onDismissLifecycleMessage}>X</button>
                        </section>
                    )}
                    {dropNotice && (
                        <section className="state lifecycle-state" role="status">
                            <span>{dropNotice}</span>
                            <button type="button" className="state-dismiss" aria-label="Dismiss dropped file message" onClick={() => setDropNotice(null)}>X</button>
                        </section>
                    )}
                    {instanceSettingsNotice && (
                        <section className="state lifecycle-state" role="status">
                            <span>{instanceSettingsNotice}</span>
                            <button type="button" className="state-dismiss" aria-label="Dismiss instance settings message" onClick={() => setInstanceSettingsNotice(null)}>X</button>
                        </section>
                    )}
                    <div className="workspace-surface-layer">
                        <WorkspaceSurface active={props.sidebarMode === 'instances' && props.viewMode === 'jaw'}>
                            <Workbench mode={props.activeDetailTab} onModeChange={props.onDetailTabChange} header={props.workbenchHeader} modeActions={(<>{props.jawCeoWorkbenchButton}<button type="button" className="workbench-instance-settings-request" aria-label="Instance settings" title="Open this instance's own settings page" disabled={!props.selectedInstance?.ok} onClick={requestInstanceSettings}>Settings</button></>)} active={props.sidebarMode === 'instances' && props.viewMode === 'jaw'} overview={props.detailContent('overview')} preview={(
                                <InstancePreview instance={props.selectedInstance} data={props.data} enabled={props.previewEnabled} active={props.sidebarMode === 'instances' && props.activeDetailTab === 'preview'} refreshKey={props.previewRefreshKey} theme={props.previewTheme} {...(props.onOpenNotesFromPreview ? { onOpenNotesFromPreview: props.onOpenNotesFromPreview } : {})} onOpenDocFromPreview={handleRightPreviewFile} onPreviewDroppedFiles={handlePreviewDroppedFiles} docPanelCapable={desktopPanelsAvailable} previewInsertTextRequest={previewInsertTextRequest} onPreviewInsertTextResult={handlePreviewInsertTextResult} previewSettingsOpenRequest={previewSettingsOpenRequest} onPreviewSettingsOpenResult={handlePreviewSettingsOpenResult} />
                            )} logs={props.detailContent('logs')} />
                        </WorkspaceSurface>
                        {props.viewMode === 'code' && props.sidebarMode === 'instances' ? (
                            <WorkspaceSurface active>
                                <Suspense fallback={<div style={{ padding: '24px', color: 'var(--text-dim)', fontSize: '13px' }}>Loading Code workspace...</div>}>
                                    <CodeCanvas port={props.port} workingDir={codeWorkingDir} onWorkingDirChange={handleCodeWorkingDirChange} onOpenLocalFile={handleRightPreviewFile} newSessionShortcut={props.codeNewSessionShortcut} />
                                </Suspense>
                            </WorkspaceSurface>
                        ) : null}
                        <WorkspaceSurface active={props.sidebarMode === 'notes'}>
                            <NotesWorkspace active={props.sidebarMode === 'notes'} selectedPath={props.notesSelectedPath} selectedNote={props.notesSelectedNote} vaultIndex={props.notesModel.index} viewMode={props.notesViewMode} authoringMode={props.notesAuthoringMode} wordWrap={props.notesWordWrap} vimMode={props.notesVimMode} treeWidth={props.notesTreeWidth} notesGraphSettings={props.notesGraphSettings} tagFilter={props.notesModel.tagFilter} onOpenSidebarSearch={props.onOpenNotesSearch} onSelectedPathChange={props.onNotesSelectedPathChange} onDirtyPathChange={props.onNotesDirtyPathChange} onViewModeChange={props.onNotesViewModeChange} onAuthoringModeChange={props.onNotesAuthoringModeChange} onWordWrapChange={props.onNotesWordWrapChange} onVimModeChange={props.onNotesVimModeChange} onTreeWidthChange={props.onNotesTreeWidthChange} onNotesGraphSettingsChange={props.onNotesGraphSettingsChange} onTagSelect={props.notesModel.setTagFilter} onWikiLinkNavigate={props.onNotesSelectedPathChange} />
                        </WorkspaceSurface>
                        <WorkspaceSurface active={props.sidebarMode === 'settings'}>
                            {/* Manager scope only. The selected instance is still supplied because
                                'Dashboard meta' edits that instance's manager-registry row and is
                                otherwise unreachable; scopes={['manager']} is what keeps every
                                instance-owned page out of this surface. */}
                            {props.sidebarMode === 'settings' && <SettingsPage key={selected?.port ?? 'manager-only'} {...settingsTarget}
                                onBack={() => props.onSidebarModeChange('instances')} title="Dashboard settings"
                                initialId={({ display: 'manager-display', activity: 'manager-activity', developer: 'manager-developer', embedding: 'manager-embedding', telegramHub: 'telegram-hub' } as const)[props.settingsSection]}
                                manager={managerSettings} scopes={['manager']} onDirtyChange={dashboardDirty}
                                {...(props.onSettingsSaved ? { onSaved: props.onSettingsSaved } : {})} />}
                        </WorkspaceSurface>
                        <WorkspaceSurface active={props.sidebarMode === 'board'}>
                            <DashboardBoardWorkspace active={props.sidebarMode === 'board'} view={props.boardView} onViewChange={props.onBoardViewChange} instances={props.instances} selectedPort={props.selectedInstance?.port ?? null} titlesByPort={props.titlesByPort} busyPorts={props.busyPorts} onOpenHelpTopic={props.onOpenHelpTopic} />
                        </WorkspaceSurface>
                        {props.scheduleWorkspaceEnabled ? (
                            <WorkspaceSurface active={props.sidebarMode === 'schedule'}>
                                <DashboardScheduleWorkspace active={props.sidebarMode === 'schedule'} activeGroup={props.scheduleGroup} busyPorts={props.busyPorts} onOpenHelpTopic={props.onOpenHelpTopic} />
                            </WorkspaceSurface>
                        ) : null}
                        {props.remindersWorkspaceEnabled ? (
                            <WorkspaceSurface active={props.sidebarMode === 'reminders'}>
                                <DashboardRemindersWorkspace active={props.sidebarMode === 'reminders'} view={remindersView} feed={remindersFeed} onRefresh={() => void remindersFeed.refresh()} onCreate={(input) => void remindersFeed.create(input).catch(() => {})} onUpdate={(id, patch) => void remindersFeed.update(id, patch)} onOpenHelpTopic={props.onOpenHelpTopic} />
                            </WorkspaceSurface>
                        ) : null}
                    </div>
                </div>
            )}
            inspector={(
                <ActivityDock
                    collapsed={props.activityDockCollapsed}
                    height={props.activityDockHeight}
                    loading={props.loading}
                    error={props.error}
                    lifecycleMessage={props.lifecycleMessage}
                    selectedInstance={props.selectedInstance}
                    registryMessage={props.registryMessage}
                    events={props.managerEvents}
                    onToggle={props.onToggleActivity}
                    onHeightChange={props.onActivityHeightChange}
                />
            )}
            sidePanel={(!isElectron && ceoConsoleOpen) ? jawCeoPanel : undefined}
            mobileNav={<MobileNav activeTab={props.activeDetailTab} onOpenInstances={props.onOpenDrawer} onSelectTab={props.onSelectTab} onToggleActivity={props.onToggleActivityFromMobile} />}
            drawer={(
                <InstanceDrawer open={props.drawerOpen} profileFilters={props.drawerProfileFilters} onClose={props.onCloseDrawer}>
                    {props.instanceListContent}
                </InstanceDrawer>
            )}
        />
        </NotesCommandProvider>
    );
}
