import type { DashboardSidebarMode } from './types';

const SIDEBAR_MODES = new Set<DashboardSidebarMode>([
    'instances',
    'board',
    'schedule',
    'reminders',
    'notes',
    'settings',
]);

export function readInitialSidebarMode(search: string): DashboardSidebarMode | null {
    const mode = new URLSearchParams(search).get('sidebar');
    return SIDEBAR_MODES.has(mode as DashboardSidebarMode) ? mode as DashboardSidebarMode : null;
}

export function readTrayRemindersMode(search: string): boolean {
    return new URLSearchParams(search).get('tray') === '1';
}

/** `?port=<n>` from the menu bar "open instance" item; null when absent or invalid. */
export function readInitialSelectedPort(search: string): number | null {
    const raw = new URLSearchParams(search).get('port');
    if (raw === null || !/^\d{1,5}$/.test(raw)) return null;
    const port = Number(raw);
    return port >= 1 && port <= 65535 ? port : null;
}
