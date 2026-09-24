import type { DashboardDetailTab, DashboardInstance, DashboardShortcutAction, DashboardShortcutKeymap, DashboardSidebarMode } from './types';
import { actionForShortcutEvent } from './manager-shortcuts';
import { panelShortcutBus } from './panels/panel-shortcut-bus';
import { getDesktop } from './panels/desktop-bridge';
import { getInstanceJumpSelector, jumpInstanceIndexFromAction, readRenderedInstancePorts } from './components/sidebar-keyboard';

/**
 * Dependencies the manager keyboard-shortcut runner needs from <App>.
 * Extracted from App.tsx to keep the component under the dashboard line budget;
 * behaviour is identical — App passes current render values on every call.
 */
export interface ManagerShortcutRunnerDeps {
    toggleInstanceSettings: () => void;
    selectedInstance: DashboardInstance | null;
    filtered: DashboardInstance[];
    activeDetailTab: DashboardDetailTab;
    setDrawerOpen: (open: boolean) => void;
    handleSidebarModeChange: (mode: DashboardSidebarMode) => void;
    handlePreview: (instance: DashboardInstance) => void;
    selectRelativeInstance: (direction: 1 | -1) => void;
    handleTabChange: (tab: DashboardDetailTab) => void;
    setPreviewRefreshKey: (updater: (key: number) => number) => void;
    handleSidebarToggle: () => void;
}

export function runManagerShortcut(action: DashboardShortcutAction, deps: ManagerShortcutRunnerDeps): void {
    if (action === 'toggleInstanceSettings') { deps.toggleInstanceSettings(); return; }
    if (panelShortcutBus.dispatch(action)) return;
    const jumpIndex = jumpInstanceIndexFromAction(action);
    if (jumpIndex != null) {
        const root = document.getElementById('manager-sidebar-list');
        if (!root) return;
        const port = readRenderedInstancePorts(root)[jumpIndex];
        if (port != null) getInstanceJumpSelector()?.(port);
        return;
    }
    if (action === 'focusInstances') {
        deps.handleSidebarModeChange('instances');
        deps.setDrawerOpen(false);
        return;
    }
    if (action === 'focusActiveSession') {
        const target = deps.selectedInstance?.ok
            ? deps.selectedInstance
            : deps.filtered.find(instance => instance.ok) || null;
        if (target) deps.handlePreview(target);
        else deps.handleSidebarModeChange('instances');
        return;
    }
    if (action === 'focusNotes') {
        deps.handleSidebarModeChange('notes');
        deps.setDrawerOpen(false);
        return;
    }
    if (action === 'previousInstance') {
        deps.selectRelativeInstance(-1);
        return;
    }
    if (action === 'nextInstance') {
        deps.selectRelativeInstance(1);
        return;
    }
    if (action === 'closeFocusedTab') {
        const active = document.activeElement;
        if (active?.closest('.browser-webview-stack, .browser-tab-strip')) {
            document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: 'closeBrowserTab' }));
        } else if (active?.closest('.terminal-panel, .xterm')) {
            document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: 'closeTerminalTab' }));
        } else if (active?.closest('.bottom-panel')) {
            panelShortcutBus.dispatch('closeActiveBottomTab');
        } else if (active?.closest('.right-panel')) {
            panelShortcutBus.dispatch('toggleRightPanel');
        }
        return;
    }
    if (action === 'switchTab1') { deps.handleTabChange('overview'); return; }
    if (action === 'switchTab2') { deps.handleTabChange('preview'); return; }
    if (action === 'switchTab3') { deps.handleTabChange('logs'); return; }
    if (action === 'switchTab4') { deps.handleTabChange('settings'); return; }
    if (action === 'previousTab' || action === 'nextTab') {
        const tabs: DashboardDetailTab[] = ['overview', 'preview', 'logs'];
        const idx = tabs.indexOf(deps.activeDetailTab);
        const dir = action === 'nextTab' ? 1 : -1;
        deps.handleTabChange(tabs[(idx + dir + tabs.length) % tabs.length]);
        return;
    }
    if (action === 'browserReload' || action === 'browserHardReload' || action === 'browserFocusUrl' || action === 'browserBack' || action === 'browserForward') {
        const el = document.activeElement;
        if (el?.closest('.browser-webview-stack, .browser-tab-strip, .browser-panel')) {
            document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: action }));
            return;
        }
        // Focus is NOT in the browser panel → reload acts on the preview or app.
        // Preview focus refreshes the preview for both soft and hard (the iframe
        // has no separate hard-reload concept).
        if (action === 'browserReload' || action === 'browserHardReload') {
            if (el?.closest('.preview-panel')) {
                deps.setPreviewRefreshKey(key => key + 1);
            } else if (action === 'browserReload') {
                getDesktop()?.reloadWindow?.();
            } else {
                getDesktop()?.hardReloadWindow?.();
            }
        }
        // browserFocusUrl / Back / Forward are browser-only → no-op outside the panel.
        return;
    }
    if (action === 'terminalClear' || action === 'terminalNewTab') {
        const el = document.activeElement;
        if (el?.closest('.terminal-panel, .xterm')) {
            document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: action }));
        } else if (action === 'terminalNewTab') {
            panelShortcutBus.dispatch('newTerminalSession');
        }
        return;
    }
    if (action === 'toggleLeftSidebar') {
        deps.handleSidebarToggle();
        return;
    }
    if (action === 'resetSidebarWidth') {
        document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: 'resetSidebarWidth' }));
        return;
    }
}

const CAPTURE_TOGGLE_ACTIONS = new Set<DashboardShortcutAction>([
    'toggleInstanceSettings',
    'toggleLeftSidebar',
    'toggleRightPanel',
    'resetSidebarWidth',
]);

export function createManagerCaptureKeydownHandler(
    getKeymap: () => DashboardShortcutKeymap,
    onAction: (action: DashboardShortcutAction) => void,
): (event: KeyboardEvent) => void {
    return (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof Element && target.closest('[data-keybinding-capture]')) return;
        const action = actionForShortcutEvent(event, getKeymap());
        if (!action || !CAPTURE_TOGGLE_ACTIONS.has(action)) return;
        event.preventDefault();
        event.stopPropagation();
        onAction(action);
    };
}
