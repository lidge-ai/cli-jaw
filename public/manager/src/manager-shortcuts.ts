import type { DashboardShortcutAction, DashboardShortcutKeymap } from './types';

export const MANAGER_SHORTCUT_ACTIONS: DashboardShortcutAction[] = [
    'toggleInstanceSettings',
    'focusInstances',
    'focusActiveSession',
    'focusNotes',
    'previousInstance',
    'nextInstance',
    'toggleBottomPanel',
    'toggleRightPanel',
    'focusTerminal',
    'newTerminalSession',
    'openDiff',
    'openFolderTree',
    'closeFocusedTab',
    'switchTab1',
    'switchTab2',
    'switchTab3',
    'switchTab4',
    'previousTab',
    'nextTab',
    'browserReload',
    'browserHardReload',
    'browserFocusUrl',
    'browserBack',
    'browserForward',
    'terminalClear',
    'terminalNewTab',
    'toggleLeftSidebar',
    'resetSidebarWidth',
    'jumpInstance1',
    'jumpInstance2',
    'jumpInstance3',
    'jumpInstance4',
    'jumpInstance5',
    'jumpInstance6',
    'jumpInstance7',
    'jumpInstance8',
    'jumpInstance9',
];

export const DEFAULT_MANAGER_SHORTCUT_KEYMAP: DashboardShortcutKeymap = {
    toggleInstanceSettings: 'Meta+,',
    focusInstances: 'Alt+I',
    focusActiveSession: 'Alt+P',
    focusNotes: 'Alt+N',
    previousInstance: 'Alt+K',
    nextInstance: 'Alt+J',
    toggleBottomPanel: 'Meta+J',
    toggleRightPanel: 'Meta+B',
    focusTerminal: 'Ctrl+`',
    newTerminalSession: 'Ctrl+Shift+`',
    openDiff: 'Meta+Shift+D',
    openFolderTree: 'Meta+Shift+E',
    closeFocusedTab: 'Meta+W',
    switchTab1: 'Meta+1',
    switchTab2: 'Meta+2',
    switchTab3: 'Meta+3',
    switchTab4: 'Meta+4',
    previousTab: 'Meta+Shift+[',
    nextTab: 'Meta+Shift+]',
    browserReload: 'Meta+R',
    browserHardReload: 'Meta+Shift+R',
    browserFocusUrl: 'Meta+L',
    browserBack: 'Meta+Left',
    browserForward: 'Meta+Right',
    terminalClear: 'Meta+K',
    terminalNewTab: 'Meta+T',
    toggleLeftSidebar: 'Meta+Shift+B',
    resetSidebarWidth: 'Alt+Shift+B',
    jumpInstance1: 'Alt+1',
    jumpInstance2: 'Alt+2',
    jumpInstance3: 'Alt+3',
    jumpInstance4: 'Alt+4',
    jumpInstance5: 'Alt+5',
    jumpInstance6: 'Alt+6',
    jumpInstance7: 'Alt+7',
    jumpInstance8: 'Alt+8',
    jumpInstance9: 'Alt+9',
};

const MANAGER_SHORTCUT_ALIASES: Partial<Record<DashboardShortcutAction, string[]>> = {
    toggleRightPanel: ['Meta+B'],
    focusTerminal: ['Ctrl+`', 'Meta+`'],
    newTerminalSession: ['Ctrl+Shift+`'],
};

type ParsedShortcut = {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
};

function normalizeKey(value: string): string {
    const lower = value.trim().toLowerCase();
    if (!lower) return '';
    if (lower === 'space') return ' ';
    if (lower.length === 1) return lower;
    if (lower === 'arrowup') return 'arrowup';
    if (lower === 'arrowdown') return 'arrowdown';
    if (lower === 'arrowleft') return 'arrowleft';
    if (lower === 'arrowright') return 'arrowright';
    return lower;
}

function parseShortcut(raw: string): ParsedShortcut | null {
    const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const parsed: ParsedShortcut = {
        key: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
    };
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'alt' || lower === 'option') parsed.altKey = true;
        else if (lower === 'ctrl' || lower === 'control') parsed.ctrlKey = true;
        else if (lower === 'meta' || lower === 'cmd' || lower === 'command') parsed.metaKey = true;
        else if (lower === 'shift') parsed.shiftKey = true;
        else parsed.key = normalizeKey(part);
    }
    return parsed.key ? parsed : null;
}

export function normalizeManagerShortcutKeymap(value: unknown): DashboardShortcutKeymap {
    const input = value && typeof value === 'object' ? value as Partial<Record<DashboardShortcutAction, unknown>> : {};
    const keymap = { ...DEFAULT_MANAGER_SHORTCUT_KEYMAP };
    for (const action of MANAGER_SHORTCUT_ACTIONS) {
        const shortcut = input[action];
        keymap[action] = typeof shortcut === 'string' && shortcut.trim() ? shortcut : DEFAULT_MANAGER_SHORTCUT_KEYMAP[action];
    }
    return keymap;
}

function resolveEventKey(event: KeyboardEvent): string {
    if (event.code === 'Backquote') return '`';
    if (event.altKey && event.code?.startsWith('Digit')) return event.code.slice(5);
    const k = normalizeKey(event.key);
    if (k.length === 1) return k;
    // macOS Option+letter produces special chars (e.g. ∆ for Alt+J).
    // Fall back to event.code to recover the original letter.
    if (event.altKey && event.code?.startsWith('Key')) {
        return event.code.slice(3).toLowerCase();
    }
    return k;
}

export function shortcutMatches(event: KeyboardEvent, raw: string): boolean {
    const parsed = parseShortcut(raw);
    if (!parsed) return false;
    return event.altKey === parsed.altKey
        && event.ctrlKey === parsed.ctrlKey
        && event.metaKey === parsed.metaKey
        && event.shiftKey === parsed.shiftKey
        && resolveEventKey(event) === parsed.key;
}

/**
 * Actions whose keyboard shortcut is owned by the Electron application menu
 * accelerator (single source of truth), so the renderer keydown matcher must
 * NOT also match them — otherwise ⌘R fires twice (menu + keydown). The actions
 * stay in MANAGER_SHORTCUT_ACTIONS so the menu can still dispatch them by name;
 * only the renderer-side keyboard binding is suppressed. This also makes a
 * persisted user keymap carrying Meta+R harmless, and preserves the browser's
 * native ⌘R in a pure web build (no menu, no match → no preventDefault).
 */
export const RENDERER_DISABLED_SHORTCUT_ACTIONS = new Set<DashboardShortcutAction>([
    'browserReload',
    'browserHardReload',
]);

export function actionForShortcutEvent(
    event: KeyboardEvent,
    keymap: unknown,
): DashboardShortcutAction | null {
    const shortcuts = normalizeManagerShortcutKeymap(keymap);
    for (const action of MANAGER_SHORTCUT_ACTIONS) {
        if (RENDERER_DISABLED_SHORTCUT_ACTIONS.has(action)) continue;
        if (shortcutMatches(event, shortcuts[action])) return action;
        if (MANAGER_SHORTCUT_ALIASES[action]?.some(shortcut => shortcutMatches(event, shortcut))) return action;
    }
    return null;
}

export function formatShortcut(raw: string): string {
    return raw
        .split('+')
        .map(part => part.trim())
        .filter(Boolean)
        .join(' + ');
}

export function isManagerShortcutEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.closest('[contenteditable="true"], .cm-editor, .ProseMirror, [data-milkdown-root]'));
}
