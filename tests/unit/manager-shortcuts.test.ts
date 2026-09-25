import assert from 'node:assert/strict';
import test from 'node:test';
import {
    actionForShortcutEvent,
    DEFAULT_MANAGER_SHORTCUT_KEYMAP,
    formatShortcut,
    normalizeManagerShortcutKeymap,
    RENDERER_DISABLED_SHORTCUT_ACTIONS,
    shortcutMatches,
} from '../../public/manager/src/manager-shortcuts.js';

function keyEvent(key: string, modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>> = {}): KeyboardEvent {
    return {
        key,
        code: modifiers.code,
        altKey: modifiers.altKey === true,
        ctrlKey: modifiers.ctrlKey === true,
        metaKey: modifiers.metaKey === true,
        shiftKey: modifiers.shiftKey === true,
    } as KeyboardEvent;
}

// Meta resolves per client platform (⌘ on macOS, Ctrl elsewhere), and Node exposes
// its own navigator.platform, so every assertion that depends on it pins one.
const MAC = 'MacIntel';
const WIN = 'Win32';
const LINUX = 'Linux x86_64';
const onMac = { platform: MAC };

test('manager shortcut matching requires exact modifiers and normalized keys', () => {
    assert.equal(shortcutMatches(keyEvent('i', { altKey: true }), 'Alt+I'), true);
    assert.equal(shortcutMatches(keyEvent('I', { altKey: true }), 'Alt+I'), true);
    assert.equal(shortcutMatches(keyEvent('i', { altKey: true, shiftKey: true }), 'Alt+I'), false);
    assert.equal(shortcutMatches(keyEvent('ArrowUp', { altKey: true }), 'Alt+ArrowUp'), true);
    assert.equal(shortcutMatches(keyEvent('n', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+N'), true);
});

test('manager shortcut action lookup uses the configured keymap', () => {
    assert.equal(
        actionForShortcutEvent(keyEvent('p', { altKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'focusActiveSession',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('j', { altKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'nextInstance',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('j', { ctrlKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        null,
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('~', { ctrlKey: true, shiftKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'newTerminalSession',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('`', { ctrlKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'focusTerminal',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('`', { metaKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'focusTerminal',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('b', { metaKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'toggleRightPanel',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('b', { metaKey: true, shiftKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'toggleLeftSidebar',
    );
});

test('manager shortcut labels render readable chords', () => {
    assert.equal(formatShortcut('Alt+I', LINUX), 'Alt + I');
    assert.equal(formatShortcut('Ctrl + Shift + N', LINUX), 'Ctrl + Shift + N');
});

test('Meta is the primary modifier: ⌘ on macOS, Ctrl on Windows and Linux', () => {
    for (const platform of [WIN, LINUX]) {
        const options = { platform };
        assert.equal(actionForShortcutEvent(keyEvent(',', { ctrlKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), 'toggleInstanceSettings');
        assert.equal(actionForShortcutEvent(keyEvent('b', { ctrlKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), 'toggleRightPanel');
        assert.equal(actionForShortcutEvent(keyEvent('b', { ctrlKey: true, shiftKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), 'toggleLeftSidebar');
        assert.equal(actionForShortcutEvent(keyEvent('1', { ctrlKey: true, code: 'Digit1' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), 'switchTab1');
        // The physical Windows/Super key alone no longer triggers Meta chords off macOS.
        assert.equal(actionForShortcutEvent(keyEvent(',', { metaKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), null);
        assert.equal(actionForShortcutEvent(keyEvent('b', { metaKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, options), null);
        assert.equal(shortcutMatches(keyEvent('k', { ctrlKey: true }), 'Cmd+K', platform), true);
        assert.equal(shortcutMatches(keyEvent('k', { ctrlKey: true }), 'Mod+K', platform), true);
    }
    // macOS keeps the existing meaning, and Ctrl stays a distinct modifier there.
    assert.equal(actionForShortcutEvent(keyEvent(',', { metaKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac), 'toggleInstanceSettings');
    assert.equal(actionForShortcutEvent(keyEvent(',', { ctrlKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac), null);
});

test('Win and Super name the physical meta key on every platform', () => {
    for (const platform of [MAC, WIN, LINUX]) {
        assert.equal(shortcutMatches(keyEvent('e', { metaKey: true }), 'Win+E', platform), true);
        assert.equal(shortcutMatches(keyEvent('e', { metaKey: true }), 'Super+E', platform), true);
        assert.equal(shortcutMatches(keyEvent('e', { ctrlKey: true }), 'Win+E', platform), false);
    }
    const rebound = { ...DEFAULT_MANAGER_SHORTCUT_KEYMAP, openFolderTree: 'Win+E' };
    assert.equal(actionForShortcutEvent(keyEvent('e', { metaKey: true }), rebound, { platform: WIN }), 'openFolderTree');
});

test('menu-owned chords follow the same Meta meaning on Windows desktop', () => {
    const desktop = { menuOwned: true, platform: WIN };
    // The Electron menu accelerator is CommandOrControl+W, i.e. Ctrl+W on Windows:
    // the renderer must yield it or one press closes two tabs.
    assert.equal(actionForShortcutEvent(keyEvent('w', { ctrlKey: true, code: 'KeyW' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, desktop), null);
    assert.equal(actionForShortcutEvent(keyEvent('b', { ctrlKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, desktop), null);
    assert.equal(actionForShortcutEvent(keyEvent('w', { ctrlKey: true, code: 'KeyW' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, { platform: WIN }), 'closeFocusedTab');
    // A non-menu Meta chord still resolves on Windows desktop.
    assert.equal(actionForShortcutEvent(keyEvent('k', { ctrlKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, desktop), 'terminalClear');
});

test('shortcut labels follow the client platform', () => {
    assert.equal(formatShortcut('Meta+Shift+B', MAC), '⌘⇧B');
    assert.equal(formatShortcut('Meta+,', MAC), '⌘,');
    assert.equal(formatShortcut('Alt+I', MAC), '⌥I');
    assert.equal(formatShortcut('Ctrl+`', MAC), '⌃`');
    assert.equal(formatShortcut('Meta+Left', MAC), '⌘←');
    assert.equal(formatShortcut('Win+E', MAC), '⌘E');
    for (const platform of [WIN, LINUX]) {
        assert.equal(formatShortcut('Meta+Shift+B', platform), 'Ctrl + Shift + B');
        assert.equal(formatShortcut('Cmd+,', platform), 'Ctrl + ,');
        assert.equal(formatShortcut('Win+E', platform), 'Win + E');
        assert.equal(formatShortcut('Option+I', platform), 'Alt + I');
        assert.equal(formatShortcut('Ctrl+Meta+K', platform), 'Ctrl + K');
    }
});

test('manager shortcut keymap normalizes legacy registry values', () => {
    const normalized = normalizeManagerShortcutKeymap({
        focusInstances: undefined,
        focusActiveSession: '',
        focusNotes: 'Ctrl+Shift+N',
    });

    assert.equal(normalized.focusInstances, DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusInstances);
    assert.equal(normalized.focusActiveSession, DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusActiveSession);
    assert.equal(normalized.toggleRightPanel, 'Meta+B');
    assert.equal(normalized.focusTerminal, 'Ctrl+`');
    assert.equal(normalized.newTerminalSession, 'Ctrl+Shift+`');
    assert.equal(normalized.focusNotes, 'Ctrl+Shift+N');
    assert.equal(normalized.previousInstance, DEFAULT_MANAGER_SHORTCUT_KEYMAP.previousInstance);
    assert.equal(normalized.nextInstance, DEFAULT_MANAGER_SHORTCUT_KEYMAP.nextInstance);
    assert.equal(actionForShortcutEvent(keyEvent('i', { altKey: true }), undefined, onMac), 'focusInstances');
});

test('reload shortcuts are owned by the Electron menu and ignored by the renderer matcher', () => {
    // Default keymap binds Meta+R / Meta+Shift+R, but the renderer must not match
    // them (the Electron menu accelerator is the single source → no double reload).
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac), null);
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true, shiftKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac), null);

    // Even a persisted keymap explicitly carrying these bindings stays inert.
    const persisted = { ...DEFAULT_MANAGER_SHORTCUT_KEYMAP, browserReload: 'Meta+R', browserHardReload: 'Meta+Shift+R' };
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true }), persisted, onMac), null);
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true, shiftKey: true }), persisted, onMac), null);

    assert.ok(RENDERER_DISABLED_SHORTCUT_ACTIONS.has('browserReload'));
    assert.ok(RENDERER_DISABLED_SHORTCUT_ACTIONS.has('browserHardReload'));
});

test('menu-owned chords resolve on web but not on the Electron desktop', () => {
    const menuOwned = { menuOwned: true, platform: MAC };
    // Menu accelerator chords: the renderer matcher (document keydown and the
    // preview iframe bridge) must ignore them on desktop — the menu already
    // dispatched them via manager:shortcut, so resolving again double-fires.
    for (const event of [
        keyEvent('`', { ctrlKey: true, code: 'Backquote' }),           // Reveal Terminal
        keyEvent('~', { ctrlKey: true, shiftKey: true, code: 'Backquote' }), // New Terminal
        keyEvent('t', { metaKey: true, code: 'KeyT' }),                // New Terminal Tab
        keyEvent('b', { metaKey: true, code: 'KeyB' }),                // Right sidebar
        keyEvent('b', { metaKey: true, shiftKey: true, code: 'KeyB' }),// Left sidebar
        keyEvent('j', { metaKey: true, code: 'KeyJ' }),                // Bottom panel
        keyEvent('w', { metaKey: true, code: 'KeyW' }),                // Close Tab
        keyEvent('1', { metaKey: true, code: 'Digit1' }),              // Overview tab
        keyEvent('e', { metaKey: true, shiftKey: true, code: 'KeyE' }),// Folder panel
        keyEvent('d', { metaKey: true, shiftKey: true, code: 'KeyD' }),// Diff panel
    ]) {
        assert.equal(actionForShortcutEvent(event, DEFAULT_MANAGER_SHORTCUT_KEYMAP, menuOwned), null,
            `desktop matcher must skip menu-owned chord ${JSON.stringify(event)}`);
        assert.notEqual(actionForShortcutEvent(event, DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac), null,
            `web matcher must keep resolving ${JSON.stringify(event)}`);
    }
    // Chords the menu does not own still resolve on desktop.
    assert.equal(
        actionForShortcutEvent(keyEvent('j', { altKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, menuOwned),
        'nextInstance',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('k', { metaKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, menuOwned),
        'terminalClear',
    );
    // A user rebound onto a non-menu chord keeps working on desktop.
    const rebound = { ...DEFAULT_MANAGER_SHORTCUT_KEYMAP, toggleRightPanel: 'Alt+R' };
    assert.equal(actionForShortcutEvent(keyEvent('r', { altKey: true }), rebound, menuOwned), 'toggleRightPanel');
});

test('Alt+Digit recovers jumpInstance even when macOS rewrites the key character', () => {
    assert.equal(
        actionForShortcutEvent(keyEvent('1', { altKey: true, code: 'Digit1' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'jumpInstance1',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('£', { altKey: true, code: 'Digit3' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP, onMac),
        'jumpInstance3',
    );
});

test('instance settings shortcut defaults and overrides survive normalization', () => {
    const defaults = normalizeManagerShortcutKeymap({});
    assert.equal(defaults.toggleInstanceSettings, 'Meta+,');
    assert.equal(actionForShortcutEvent(keyEvent(',', { metaKey: true }), defaults, onMac), 'toggleInstanceSettings');
    assert.equal(actionForShortcutEvent(keyEvent(',', { ctrlKey: true }), defaults, onMac), null);
    assert.equal(actionForShortcutEvent(keyEvent(',', { metaKey: true, shiftKey: true }), defaults, onMac), null);
    const changed = normalizeManagerShortcutKeymap({ toggleInstanceSettings: 'Alt+S' });
    assert.equal(actionForShortcutEvent(keyEvent('s', { altKey: true }), changed, onMac), 'toggleInstanceSettings');
    assert.equal(actionForShortcutEvent(keyEvent(',', { metaKey: true }), changed, onMac), null);
});

test('settings toggle has its own localized label in all Manager locales', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { JSDOM } = await import('jsdom');
    // The workspace now lazy-loads pages through SettingsShell; render the Manager Display page directly.
    const { default: ManagerDisplayPage } = await import('../../public/manager/src/settings/pages/manager/Display');
    const { createDirtyStore } = await import('../../public/manager/src/settings/dirty-store');
    const { defaultDashboardRegistry } = await import('../../src/manager/registry');
    const globals = globalThis as unknown as Record<string, unknown>, previous = globals['React'];
    globals['React'] = React;
    try {
        for (const [locale, expected, expectedTab1] of [
            ['ko', '인스턴스 설정', 'Overview 탭'], ['en', 'Instance settings', 'Overview tab'],
            ['ja', 'インスタンス設定', 'Overview タブ'], ['zh', '实例设置', 'Overview 标签'],
        ] as const) {
            const savedUi = defaultDashboardRegistry().ui;
            const ui = { ...savedUi, locale,
                dashboardShortcutKeymap: normalizeManagerShortcutKeymap(savedUi.dashboardShortcutKeymap) };
            const dom = new JSDOM(renderToStaticMarkup(React.createElement(ManagerDisplayPage, {
                port: 0, instanceUrl: '', client: null as never, dirty: createDirtyStore(), registerSave() {},
                manager: { ui, titleSupport: { ready: 0, legacy: 0, offline: 0, byPort: {} }, onUiPatch() {} },
            } as never)));
            const doc = dom.window.document;
            assert.equal(doc.querySelector('label[for="dashboard-shortcut-toggleInstanceSettings"] > span')?.textContent, expected);
            assert.equal(doc.querySelector<HTMLInputElement>('#dashboard-shortcut-toggleInstanceSettings')?.value, 'Meta+,');
            assert.notEqual(doc.querySelector('label[for="dashboard-shortcut-nextInstance"] > span')?.textContent, expected);
            // Every action row must carry its own localized label — unmapped
            // actions previously all fell back to the "next instance" copy.
            assert.equal(doc.querySelector('label[for="dashboard-shortcut-switchTab1"] > span')?.textContent, expectedTab1);
            assert.equal(doc.querySelector<HTMLInputElement>('#dashboard-shortcut-switchTab1')?.value, 'Meta+1');
            dom.window.close();
        }
    } finally { globals['React'] = previous; }
});
