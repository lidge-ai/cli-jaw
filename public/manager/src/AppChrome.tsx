import { useEffect, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { CommandBar } from './components/CommandBar';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import { CommandPalette } from './components/CommandPalette';
import { ManagerShell } from './components/ManagerShell';
import { HelpDrawer } from './help/HelpDrawer';
import { type HelpTopicId } from './help/helpContent';
import { SidebarRailRouter } from './SidebarRailRouter';
import { PanelLayoutProvider, type PanelLayoutState } from './panels/PanelLayoutProvider';
import { ElectronMetricsPanel } from './electron-metrics';
import { IframeBridge } from './sync/IframeBridge';
import { VisibilityBridge } from './sync/VisibilityBridge';
import { instanceLabel } from './instance-label';
import type { BoardView } from './dashboard-board/board-view';
import { type ScheduleGroup } from './dashboard-schedule/DashboardScheduleSidebar';
import { REMINDERS_WORKSPACE_ENABLED, SCHEDULE_WORKSPACE_ENABLED } from './dashboard-features';
import type { NotesModelState } from './notes/useNotesModel';
import type { NotesSidebarMode } from './notes/NotesSidebar';
import type { CommandPaletteApi } from './hooks/useCommandPalette';
import type { ThemeApi } from './hooks/useTheme';
import { useWindowFullscreen } from './hooks/useWindowFullscreen';
import type { useDashboardView } from './hooks/useDashboardView';
import type { DashboardDetailTab, DashboardInstance, DashboardNotesAuthoringMode, DashboardNotesGraphSettings, DashboardNotesViewMode, DashboardScanResult, DashboardShortcutAction, ManagerEvent, NoteMetadata } from './types';
import { createManagerCaptureKeydownHandler } from './manager-shortcut-runner';
import { normalizeManagerShortcutKeymap } from './manager-shortcuts';

type AppChromeProps = {
    view: ReturnType<typeof useDashboardView>;
    palette: CommandPaletteApi;
    theme: ThemeApi;
    query: string;
    loading: boolean;
    showHidden: boolean;
    instances: DashboardInstance[];
    selectedInstance: DashboardInstance | null;
    data: DashboardScanResult | null;
    summary: Record<string, number>;
    scheduleGroup: ScheduleGroup;
    boardView: BoardView;
    notesModel: NotesModelState;
    notesSelectedNote: NoteMetadata | null;
    notesDirtyPath: string | null;
    notesHighlightedPath: string | null;
    notesSidebarMode: NotesSidebarMode;
    notesSearchFocusToken: number;
    settingsSection: Parameters<typeof SidebarRailRouter>[0]['settingsSection'];
    dashboardSettingsUi: Parameters<typeof SidebarRailRouter>[0]['dashboardSettingsUi'];
    titleSupport: Parameters<typeof SidebarRailRouter>[0]['titleSupport'];
    activityEvents: ManagerEvent[];
    busyPorts: Set<number>;
    titlesByPort: Record<number, string>;
    lifecycleMessage: string | null;
    error: string | null;
    registryMessage: string | null;
    onPickProject: (port: number) => void;
    projectPickBusy: boolean;
    onRefreshPreview: () => void;
    onSettingsDirtyChange: (entry: 'dashboard', dirty: boolean) => void;
    detailContent: (tab: DashboardDetailTab) => ReactNode;
    instanceListContent: ReactNode;
    drawerProfileFilters: ReactNode;
    jawCeoWorkbenchButton?: ReactNode;
    jawCeoVoiceOverlay?: ReactNode;
    jawCeo?: Parameters<typeof SidebarRailRouter>[0]['jawCeo'];
    jawCeoVoice?: Parameters<typeof SidebarRailRouter>[0]['jawCeoVoice'];
    jawCeoOpen?: boolean;
    jawCeoSelectedPort?: number | null;
    onJawCeoOpenChange?: (open: boolean) => void;
    onJawCeoOpenWorker?: (port: number, messageId?: number) => void;
    previewEnabled: boolean;
    previewRefreshKey: number;
    autoUnloadNotice: boolean;
    helpOpen: boolean;
    helpTopic: HelpTopicId | null;
    setQuery: Dispatch<SetStateAction<string>>;
    setShowHidden: Dispatch<SetStateAction<boolean>>;
    setPreviewEnabled: Dispatch<SetStateAction<boolean>>;
    setAutoUnloadNotice: Dispatch<SetStateAction<boolean>>;
    setHelpOpen: Dispatch<SetStateAction<boolean>>;
    setHelpTopic: Dispatch<SetStateAction<HelpTopicId | null>>;
    onOpenHelpTopic: (topic: HelpTopicId) => void;
    setNotesSidebarMode: Dispatch<SetStateAction<NotesSidebarMode>>;
    setBoardView: Dispatch<SetStateAction<BoardView>>;
    setScheduleGroup: Dispatch<SetStateAction<ScheduleGroup>>;
    setDashboardSettingsSection: Dispatch<SetStateAction<Parameters<typeof SidebarRailRouter>[0]['settingsSection']>>;
    load: (nextShowHidden?: boolean) => Promise<void>;
    cycleTheme: () => void;
    openSelectedInBrowser: () => void;
    handleSelectInstance: (instance: DashboardInstance) => void;
    handleSidebarModeChange: Parameters<typeof SidebarRailRouter>[0]['onSidebarModeChange'];
    handleSidebarToggle: () => void;
    handleNotesSelectedPathChange: (path: string | null) => void;
    openNotesFromPreview: (path: string) => void;
    handleNotesViewModeChange: (mode: DashboardNotesViewMode) => void;
    handleNotesAuthoringModeChange: (mode: DashboardNotesAuthoringMode) => void;
    handleNotesWordWrapChange: (value: boolean) => void;
    handleNotesVimModeChange: (value: boolean) => void;
    handleNotesTreeWidthChange: (value: number) => void;
    handleNotesGraphSettingsChange: (settings: DashboardNotesGraphSettings) => void;
    openNotesSidebarSearch: () => void;
    setNotesDirtyPath: Dispatch<SetStateAction<string | null>>;
    handleTabChange: (tab: DashboardDetailTab) => void;
    handleActivityToggle: () => void;
    handleActivityHeight: (height: number) => void;
    onDismissLifecycleMessage: () => void;
    handleDashboardSettingsPatch: Parameters<typeof SidebarRailRouter>[0]['onDashboardSettingsPatch'];
    activityUnreadOpenAndMarkSeen: () => void;
    panelInitialState?: Partial<PanelLayoutState> | undefined;
    onPanelStateChange?: ((state: PanelLayoutState) => void) | undefined;
    onShortcutAction: (action: DashboardShortcutAction) => void;
};

export function AppChrome(props: AppChromeProps) {
    useWindowFullscreen();
    useEffect(() => {
        if (!props.view.dashboardShortcutsEnabled) return undefined;
        const handler = createManagerCaptureKeydownHandler(
            () => props.view.dashboardShortcutKeymap,
            props.onShortcutAction,
        );
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [props.view.dashboardShortcutsEnabled, props.view.dashboardShortcutKeymap, props.onShortcutAction]);

    return (
        <>
            <IframeBridge />
            <VisibilityBridge />
            <PanelLayoutProvider initialPanelState={props.panelInitialState} onStateChange={props.onPanelStateChange}>
            <ManagerShell
                sidebarCollapsed={props.view.sidebarCollapsed}
                commandBar={<CommandBar query={props.query} loading={props.loading} onQueryChange={props.setQuery} onRefresh={() => void props.load()} onOpenDrawer={() => props.view.setDrawerOpen(true)} theme={props.theme.theme} onThemeChange={props.theme.setTheme} onOpenPalette={props.palette.toggle} />}
                workspace={(
                    <SidebarRailRouter sidebarCollapsed={props.view.sidebarCollapsed} activityDockCollapsed={props.view.activityDockCollapsed}
                        activityDockHeight={props.view.activityDockHeight} drawerOpen={props.view.drawerOpen} onCloseDrawer={() => props.view.setDrawerOpen(false)}
                        onlineCount={props.summary['online'] || 0} sidebarMode={props.view.sidebarMode} scheduleWorkspaceEnabled={SCHEDULE_WORKSPACE_ENABLED}
                        remindersWorkspaceEnabled={REMINDERS_WORKSPACE_ENABLED} onSidebarModeChange={props.handleSidebarModeChange}
                        onToggleSidebar={props.handleSidebarToggle} helpOpen={props.helpOpen} onToggleHelp={() => { props.setHelpTopic(null); props.setHelpOpen(open => !open); }}
                        onOpenHelpTopic={props.onOpenHelpTopic}
                        settingsSection={props.settingsSection} locale={props.view.locale} onSettingsSectionChange={props.setDashboardSettingsSection}
                        notesModel={props.notesModel} notesSelectedPath={props.view.notesSelectedPath} notesSelectedNote={props.notesSelectedNote}
                        notesDirtyPath={props.notesDirtyPath} notesHighlightedPath={props.notesHighlightedPath} notesTreeWidth={props.view.notesTreeWidth} notesGraphSettings={props.view.notesGraphSettings} notesSidebarMode={props.notesSidebarMode}
                        notesSearchFocusToken={props.notesSearchFocusToken} notesViewMode={props.view.notesViewMode} notesAuthoringMode={props.view.notesAuthoringMode}
                        notesWordWrap={props.view.notesWordWrap} notesVimMode={props.view.notesVimMode} onNotesSidebarModeChange={props.setNotesSidebarMode} onOpenNotesSearch={props.openNotesSidebarSearch}
                        onNotesSelectedPathChange={props.handleNotesSelectedPathChange} onNotesDirtyPathChange={props.setNotesDirtyPath}
                        onNotesViewModeChange={props.handleNotesViewModeChange} onNotesAuthoringModeChange={props.handleNotesAuthoringModeChange}
                        onNotesWordWrapChange={props.handleNotesWordWrapChange} onNotesVimModeChange={props.handleNotesVimModeChange} onNotesTreeWidthChange={props.handleNotesTreeWidthChange} onNotesGraphSettingsChange={props.handleNotesGraphSettingsChange}
                        boardView={props.boardView} onBoardViewChange={props.setBoardView} scheduleGroup={props.scheduleGroup} onScheduleGroupChange={props.setScheduleGroup}
                        instances={props.instances} selectedInstance={props.selectedInstance} data={props.data} titlesByPort={props.titlesByPort}
                        busyPorts={props.busyPorts} activeDetailTab={props.view.activeDetailTab} onDetailTabChange={props.handleTabChange}
                        workbenchHeader={<WorkbenchHeader instance={props.selectedInstance} previewEnabled={props.previewEnabled} onPreviewEnabledChange={props.setPreviewEnabled} onPreviewRefresh={props.onRefreshPreview} onOpenHelpTopic={props.onOpenHelpTopic} onPickProject={props.onPickProject} projectPickBusy={props.projectPickBusy} />} onSettingsDirtyChange={props.onSettingsDirtyChange} detailContent={props.detailContent} previewEnabled={props.previewEnabled}
                        previewRefreshKey={props.previewRefreshKey} previewTheme={props.theme.resolved} onOpenNotesFromPreview={props.openNotesFromPreview} lifecycleMessage={props.lifecycleMessage}
                        onDismissLifecycleMessage={props.onDismissLifecycleMessage} instanceListContent={props.instanceListContent} loading={props.loading}
                        jawCeoWorkbenchButton={props.jawCeoWorkbenchButton} jawCeoVoiceOverlay={props.jawCeoVoiceOverlay}
                        jawCeo={props.jawCeo} jawCeoVoice={props.jawCeoVoice} jawCeoOpen={props.jawCeoOpen} jawCeoSelectedPort={props.jawCeoSelectedPort} onJawCeoOpenChange={props.onJawCeoOpenChange} onJawCeoOpenWorker={props.onJawCeoOpenWorker}
                        error={props.error} registryMessage={props.registryMessage} managerEvents={props.activityEvents}
                        onToggleActivity={props.handleActivityToggle} onActivityHeightChange={props.handleActivityHeight} onOpenDrawer={() => props.view.setDrawerOpen(true)}
                        onSelectTab={props.handleTabChange} onToggleActivityFromMobile={props.activityUnreadOpenAndMarkSeen} drawerProfileFilters={props.drawerProfileFilters}
                        dashboardSettingsUi={props.dashboardSettingsUi} titleSupport={props.titleSupport} onDashboardSettingsPatch={props.handleDashboardSettingsPatch}
                        viewMode={props.view.viewMode} onViewModeChange={props.view.setViewMode}
                        port={Number(window.location.port) || 3457} workingDir={props.view.rightFolderRootPath || ''}
                        codeNewSessionShortcut={normalizeManagerShortcutKeymap(props.view.dashboardShortcutKeymap).newCodeSession}
                        query={props.query} onQueryChange={props.setQuery} onSelectInstance={props.handleSelectInstance} />
                )}
                activityHeight={props.view.activityDockCollapsed ? 48 : props.view.activityDockHeight}
            />
            </PanelLayoutProvider>
            <CommandPalette open={props.palette.open} onClose={props.palette.close} instances={props.instances} getLabel={instanceLabel}
                onSelectInstance={props.handleSelectInstance} theme={props.theme.theme} onCycleTheme={props.cycleTheme} onRefresh={() => void props.load()}
                onToggleHidden={() => { const next = !props.showHidden; props.setShowHidden(next); void props.load(next); }}
                showHidden={props.showHidden} onOpenSelected={props.openSelectedInBrowser} selectedInstance={props.selectedInstance} />
            <ElectronMetricsPanel onUnloadPreview={() => props.setPreviewEnabled(false)} />
            <HelpDrawer open={props.helpOpen} topic={props.helpTopic ?? props.view.sidebarMode} onClose={() => props.setHelpOpen(false)} />
            {props.autoUnloadNotice && (
                <div className="preview-auto-unload-notice" role="status">
                    Preview was unloaded after 5 minutes of inactivity. Toggle the preview switch to re-enable.
                    <button type="button" className="preview-auto-unload-dismiss" aria-label="Dismiss preview auto-unload notice" onClick={() => props.setAutoUnloadNotice(false)}>x</button>
                </div>
            )}
        </>
    );
}
