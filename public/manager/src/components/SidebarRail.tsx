import type { DashboardSidebarMode } from '../types';

type SidebarRailProps = {
    onlineCount: number;
    collapsed: boolean;
    mode: DashboardSidebarMode;
    scheduleWorkspaceEnabled: boolean;
    remindersWorkspaceEnabled?: boolean;
    onModeChange: (mode: DashboardSidebarMode) => void;
    onToggleSidebar: () => void;
    helpOpen: boolean;
    onToggleHelp: () => void;
};

function SidebarToggleIcon() {
    return (
        <svg
            className="rail-collapse-chevron"
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <rect x="3" y="4" width="14" height="12" rx="2.5" />
            <path d="M8 4v12" />
        </svg>
    );
}

function MonitorIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="10" rx="1.5" />
            <path d="M8 17h4M10 14v3" />
        </svg>
    );
}

function NoteIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 3h6l3 3v11H6z" />
            <path d="M12 3v4h3M8 10h5M8 13h5" />
        </svg>
    );
}

function BoardIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="12" rx="1.5" />
            <path d="M7 4v12M13 4v12" />
        </svg>
    );
}

function ScheduleIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="14" height="12" rx="1.5" />
            <path d="M3 9h14M7 3v4M13 3v4" />
        </svg>
    );
}

function ReminderIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 4h10v13H5z" />
            <path d="M8 2v4M12 2v4M8 10h4M8 13h3" />
        </svg>
    );
}

function SettingsIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

function HelpIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="7" />
            <path d="M7.6 7.6a2.4 2.4 0 0 1 4.8 0c0 1.4-1.6 1.7-2.2 2.5-.3.4-.3.8-.3 1.2" />
            <circle cx="10" cy="14.2" r="0.6" fill="currentColor" stroke="none" />
        </svg>
    );
}

export function SidebarRail(props: SidebarRailProps) {
    const expanded = !props.collapsed;
    const toggleLabel = expanded ? 'Collapse navigation' : 'Expand navigation';
    return (
        <div className="sidebar-rail">
            <button
                className="rail-collapse-button"
                type="button"
                onClick={props.onToggleSidebar}
                aria-label={toggleLabel}
                aria-expanded={expanded}
                aria-pressed={props.collapsed}
                aria-controls="manager-sidebar-list"
                title={toggleLabel}
            >
                <SidebarToggleIcon />
            </button>
            <button
                className={`rail-button rail-workspace-button${props.mode === 'instances' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('instances')}
                aria-label="Instances"
                aria-pressed={props.mode === 'instances'}
                title="Instances"
            >
                <MonitorIcon />
            </button>
            <button
                className={`rail-button rail-workspace-button${props.mode === 'board' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('board')}
                aria-label="Board"
                aria-pressed={props.mode === 'board'}
                title="Board"
            >
                <BoardIcon />
            </button>
            {props.scheduleWorkspaceEnabled ? (
                <button
                    className={`rail-button rail-workspace-button${props.mode === 'schedule' ? ' is-active' : ''}`}
                    type="button"
                    onClick={() => props.onModeChange('schedule')}
                    aria-label="Schedule"
                    aria-pressed={props.mode === 'schedule'}
                    title="Schedule"
                >
                    <ScheduleIcon />
                </button>
            ) : null}
            {props.remindersWorkspaceEnabled ? (
                <button
                    className={`rail-button rail-workspace-button${props.mode === 'reminders' ? ' is-active' : ''}`}
                    type="button"
                    onClick={() => props.onModeChange('reminders')}
                    aria-label="Reminders"
                    aria-pressed={props.mode === 'reminders'}
                    title="Reminders"
                >
                    <ReminderIcon />
                </button>
            ) : null}
            <button
                className={`rail-button rail-workspace-button${props.mode === 'notes' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('notes')}
                aria-label="Notes"
                aria-pressed={props.mode === 'notes'}
                title="Notes"
            >
                <NoteIcon />
            </button>
            <button
                className={`rail-button rail-workspace-button${props.mode === 'settings' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('settings')}
                aria-label="Dashboard settings"
                aria-pressed={props.mode === 'settings'}
                title="Dashboard settings"
            >
                <SettingsIcon />
            </button>
            <div className="rail-spacer" aria-hidden="true" />
            <button
                className={`rail-button rail-help-button${props.helpOpen ? ' is-active' : ''}`}
                type="button"
                onClick={props.onToggleHelp}
                aria-label="Help guide"
                aria-pressed={props.helpOpen}
                aria-expanded={props.helpOpen}
                title="Help (?)"
            >
                <HelpIcon />
            </button>
            <span className="rail-status-dot" aria-label={`${props.onlineCount} online instances`} />
        </div>
    );
}
