import type { DashboardShortcutAction, DashboardShortcutKeymap } from './types';
import { currentClientPlatform, isMacLikePlatform } from './client-platform';

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
    'newCodeSession',
    'openDiff',
    'openFolderTree',
    'closeFocusedTab',
    'switchTab1',
    'switchTab2',
    'switchTab3',
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
    newCodeSession: 'Meta+Shift+N',
    openDiff: 'Meta+Shift+D',
    openFolderTree: 'Meta+Shift+E',
    closeFocusedTab: 'Meta+W',
    switchTab1: 'Meta+1',
    switchTab2: 'Meta+2',
    switchTab3: 'Meta+3',
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

/**
 * Keymap modifier tokens. `Meta` (and its spellings `Cmd`, `Command`, `Mod`) is
 * the primary modifier: ⌘ on macOS, Ctrl on Windows/Linux — the same meaning as
 * the Electron menu's `CommandOrControl`. Persisted keymaps keep their `Meta+…`
 * strings; only the interpretation follows the client platform. `Win`/`Super`
 * names the physical Windows/Super key (`metaKey`) on every platform.
 */
const PRIMARY_MODIFIER_TOKENS = new Set(['meta', 'cmd', 'command', 'mod']);
const SUPER_MODIFIER_TOKENS = new Set(['win', 'windows', 'super']);
const CTRL_MODIFIER_TOKENS = new Set(['ctrl', 'control']);
const ALT_MODIFIER_TOKENS = new Set(['alt', 'option']);

export type ShortcutPlatformOptions = {
    /** Client platform string; defaults to the current browser/window platform. */
    platform?: string;
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

function parseShortcut(raw: string, mac: boolean): ParsedShortcut | null {
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
        if (ALT_MODIFIER_TOKENS.has(lower)) parsed.altKey = true;
        else if (CTRL_MODIFIER_TOKENS.has(lower)) parsed.ctrlKey = true;
        else if (PRIMARY_MODIFIER_TOKENS.has(lower)) {
            if (mac) parsed.metaKey = true;
            else parsed.ctrlKey = true;
        } else if (SUPER_MODIFIER_TOKENS.has(lower)) parsed.metaKey = true;
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

export function shortcutMatches(event: KeyboardEvent, raw: string, platform: string = currentClientPlatform()): boolean {
    const parsed = parseShortcut(raw, isMacLikePlatform(platform));
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

/**
 * Chords owned by the Electron application menu accelerators. On desktop the
 * menu dispatches these keys through `manager:shortcut`, so renderer-side
 * matchers (document keydown and the preview-iframe shortcut bridge) must not
 * also resolve them — one press would fire the action twice. The check is on
 * the chord, not the action, so a user keymap rebinding an action to a key the
 * menu does not own keeps working. On web there is no menu, so callers leave
 * `menuOwned` unset and these chords stay renderer-handled.
 */
export const MENU_ACCELERATOR_SHORTCUT_CHORDS: string[] = [
    'Meta+W',
    'Meta+R',
    'Meta+Shift+R',
    'Meta+B',
    'Meta+Shift+B',
    'Meta+J',
    'Meta+Shift+E',
    'Meta+Shift+D',
    'Meta+1',
    'Meta+2',
    'Meta+3',
    'Meta+Shift+[',
    'Meta+Shift+]',
    'Meta+T',
    'Ctrl+`',
    'Ctrl+Shift+`',
];

export function actionForShortcutEvent(
    event: KeyboardEvent,
    keymap: unknown,
    options?: { menuOwned?: boolean } & ShortcutPlatformOptions,
): DashboardShortcutAction | null {
    // Resolve once: the menu-owned check and the keymap must agree on what Meta
    // means, or Ctrl+W on Windows desktop would fire from both menu and renderer.
    const platform = options?.platform ?? currentClientPlatform();
    if (options?.menuOwned && MENU_ACCELERATOR_SHORTCUT_CHORDS.some(chord => shortcutMatches(event, chord, platform))) {
        return null;
    }
    const shortcuts = normalizeManagerShortcutKeymap(keymap);
    for (const action of MANAGER_SHORTCUT_ACTIONS) {
        if (RENDERER_DISABLED_SHORTCUT_ACTIONS.has(action)) continue;
        if (shortcutMatches(event, shortcuts[action], platform)) return action;
        if (MANAGER_SHORTCUT_ALIASES[action]?.some(shortcut => shortcutMatches(event, shortcut, platform))) return action;
    }
    return null;
}

const MAC_KEY_LABELS: Record<string, string> = {
    left: '←', arrowleft: '←', right: '→', arrowright: '→',
    up: '↑', arrowup: '↑', down: '↓', arrowdown: '↓',
};

function macModifierLabel(lower: string): string | null {
    if (PRIMARY_MODIFIER_TOKENS.has(lower) || SUPER_MODIFIER_TOKENS.has(lower)) return '⌘';
    if (CTRL_MODIFIER_TOKENS.has(lower)) return '⌃';
    if (ALT_MODIFIER_TOKENS.has(lower)) return '⌥';
    if (lower === 'shift') return '⇧';
    return null;
}

function otherModifierLabel(lower: string): string | null {
    if (PRIMARY_MODIFIER_TOKENS.has(lower) || CTRL_MODIFIER_TOKENS.has(lower)) return 'Ctrl';
    if (SUPER_MODIFIER_TOKENS.has(lower)) return 'Win';
    if (ALT_MODIFIER_TOKENS.has(lower)) return 'Alt';
    if (lower === 'shift') return 'Shift';
    return null;
}

/**
 * Human label for a stored chord on the client platform: `Meta+Shift+B` reads
 * `⌘⇧B` on macOS and `Ctrl + Shift + B` on Windows/Linux. The stored string is
 * not changed; this is display only.
 */
export function formatShortcut(raw: string, platform: string = currentClientPlatform()): string {
    const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
    const mac = isMacLikePlatform(platform);
    const labels: string[] = [];
    for (const part of parts) {
        const lower = part.toLowerCase();
        const modifier = mac ? macModifierLabel(lower) : otherModifierLabel(lower);
        const label = modifier
            ?? (mac ? (MAC_KEY_LABELS[lower] ?? (part.length === 1 ? part.toUpperCase() : part)) : part);
        // Meta and Ctrl both read Ctrl off macOS; show a doubled modifier once.
        if (modifier && labels.includes(label)) continue;
        labels.push(label);
    }
    return labels.join(mac ? '' : ' + ');
}

export function isManagerShortcutEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.closest('[contenteditable="true"], .cm-editor, .ProseMirror, [data-milkdown-root]'));
}
