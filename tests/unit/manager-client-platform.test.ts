import assert from 'node:assert/strict';
import test from 'node:test';
import { currentClientPlatform, isMacLikePlatform } from '../../public/manager/src/client-platform.js';
import { isPaletteShortcut } from '../../public/manager/src/hooks/useCommandPalette.js';
import { isPlatformToggleClick } from '../../public/manager/src/folder-panel/folder-shortcuts.js';
import { normalizeDashboardRegistry } from '../../src/manager/registry.js';

function withNavigator<T>(value: unknown, run: () => T): T {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
    try {
        return run();
    } finally {
        if (previous) Object.defineProperty(globalThis, 'navigator', previous);
        else Reflect.deleteProperty(globalThis, 'navigator');
    }
}

test('client platform prefers userAgentData, then navigator.platform, then userAgent', () => {
    assert.equal(withNavigator({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel', userAgent: 'x' }, currentClientPlatform), 'Windows');
    assert.equal(withNavigator({ platform: 'MacIntel', userAgent: 'Windows NT' }, currentClientPlatform), 'MacIntel');
    assert.equal(withNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, currentClientPlatform),
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    assert.equal(withNavigator(undefined, currentClientPlatform), '');
});

test('mac-like detection covers macOS and iOS spellings only', () => {
    for (const platform of ['MacIntel', 'macOS', 'iPhone', 'iPad', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)']) {
        assert.equal(isMacLikePlatform(platform), true, platform);
    }
    for (const platform of ['Win32', 'Windows', 'Linux x86_64', 'Linux', 'Android', '']) {
        assert.equal(isMacLikePlatform(platform), false, platform);
    }
});

test('command palette and folder panel share the same primary modifier', () => {
    const cmdK = { key: 'k', metaKey: true, ctrlKey: false } as KeyboardEvent;
    const ctrlK = { key: 'k', metaKey: false, ctrlKey: true } as KeyboardEvent;
    assert.equal(isPaletteShortcut(cmdK, 'MacIntel'), true);
    assert.equal(isPaletteShortcut(ctrlK, 'MacIntel'), false);
    assert.equal(isPaletteShortcut(ctrlK, 'Win32'), true);
    assert.equal(isPaletteShortcut(cmdK, 'Win32'), false);
    assert.equal(isPlatformToggleClick({ metaKey: true, ctrlKey: false }, 'macOS'), true);
    assert.equal(isPlatformToggleClick({ metaKey: false, ctrlKey: true }, 'Windows'), true);
});

test('registry normalization keeps Meta as the primary token and preserves Win', () => {
    // The registry persists the dashboard-level actions; interpretation happens on the client.
    const registry = normalizeDashboardRegistry({
        ui: {
            dashboardShortcutKeymap: {
                toggleInstanceSettings: 'win+,',
                focusNotes: 'super + shift + n',
                focusInstances: 'command+i',
                focusActiveSession: 'mod+p',
                previousInstance: 'cmd+k',
            },
        },
    });
    const keymap = registry.ui.dashboardShortcutKeymap;
    assert.equal(keymap.toggleInstanceSettings, 'Win+,');
    assert.equal(keymap.focusNotes, 'Win+Shift+N');
    assert.equal(keymap.focusInstances, 'Meta+I');
    assert.equal(keymap.focusActiveSession, 'Meta+P');
    assert.equal(keymap.previousInstance, 'Meta+K');
    assert.equal(keymap.nextInstance, 'Alt+J');
    assert.equal(normalizeDashboardRegistry({}).ui.dashboardShortcutKeymap.toggleInstanceSettings, 'Meta+,');
});
