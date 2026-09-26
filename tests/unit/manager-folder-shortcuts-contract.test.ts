import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { folderShortcutAction, isPlatformToggleClick } from '../../public/manager/src/folder-panel/folder-shortcuts.js';

const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');
const folderRowsSource = readFileSync('public/manager/src/folder-panel/FolderTreeRows.tsx', 'utf8');
const folderCss = readFileSync('public/manager/src/folder-panel/folder-panel.css', 'utf8');
const shortcutsSource = readFileSync('public/manager/src/manager-shortcuts.ts', 'utf8');
const folderShortcutsSource = readFileSync('public/manager/src/folder-panel/folder-shortcuts.ts', 'utf8');
const clientPlatformSource = readFileSync('public/manager/src/client-platform.ts', 'utf8');
const folderContextMenuSource = readFileSync('public/manager/src/folder-panel/FolderContextMenu.tsx', 'utf8');
const folderContextMenuHookSource = readFileSync('public/manager/src/folder-panel/use-folder-context-menu.ts', 'utf8');
const sharedContextMenuSource = readFileSync('public/manager/src/components/context-menu/ContextMenu.tsx', 'utf8');
const sharedContextMenuCss = readFileSync('public/manager/src/components/context-menu/context-menu.css', 'utf8');

function keyEvent(overrides: Partial<Parameters<typeof folderShortcutAction>[0]>): Parameters<typeof folderShortcutAction>[0] {
    return {
        key: '',
        code: '',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        target: null,
        ...overrides,
    };
}

test('FolderPanel keeps folder shortcuts local instead of global Manager actions', () => {
    assert.equal(shortcutsSource.includes('folderCopyPath'), false);
    assert.equal(shortcutsSource.includes('folderRevealPath'), false);
    assert.ok(folderPanelSource.includes('handleEntryKeyDown'), 'FolderPanel must own row-local keyboard actions');
    assert.ok(folderRowsSource.includes('props.handleEntryKeyDown(event, entry)'), 'row component must call FolderPanel-owned keyboard actions');
});

test('FolderPanel row shortcuts copy paths and activate rows locally', () => {
    assert.ok(folderPanelSource.includes('folderShortcutAction(event'), 'row shortcuts must route through the shared folder shortcut helper');
    assert.ok(folderPanelSource.includes('event.stopPropagation()'), 'row copy shortcut must not bubble into global shortcuts');
    assert.ok(folderPanelSource.includes("event.key === 'Enter'"), 'Enter must activate focused row');
    assert.ok(folderPanelSource.includes("event.key === ' '"), 'Space must have explicit row behavior');
    assert.ok(folderPanelSource.includes('selectEntry(entry)'), 'file/space activation must use the selection helper');
    assert.ok(folderRowsSource.includes('props.selectEntry(entry, { range: event.shiftKey, toggle: isPlatformToggleClick(event), preview: false })'), 'row click must route through the selection helper without opening files');
    assert.ok(folderRowsSource.includes('props.toggleEntryExpansion(entry)'), 'row expansion must stay separate from selection');
    assert.ok(folderRowsSource.includes('else props.openFileEntry(entry)'), 'row double-click must open files explicitly');
});

test('FolderPanel shortcut helper supports quick keys and VS Code aliases', () => {
    assert.equal(folderShortcutAction(keyEvent({ key: 'c', code: 'KeyC', metaKey: true, altKey: true }), { chordActive: false, platform: 'MacIntel' }), 'copy-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'r', code: 'KeyR', metaKey: true, altKey: true }), { chordActive: false, platform: 'MacIntel' }), 'reveal-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), { chordActive: false, platform: 'Win32' }), 'copy-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'r', code: 'KeyR', ctrlKey: true, altKey: true }), { chordActive: false, platform: 'Linux x86_64' }), 'reveal-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }), { chordActive: false, platform: 'MacIntel' }), 'start-chord');
    assert.equal(folderShortcutAction(keyEvent({ key: 'p', code: 'KeyP' }), { chordActive: true, platform: 'MacIntel' }), 'copy-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'r', code: 'KeyR' }), { chordActive: true, platform: 'MacIntel' }), 'reveal-path');
});

test('FolderPanel shortcut helper preserves existing row copy aliases', () => {
    assert.equal(folderShortcutAction(keyEvent({ key: 'c', code: 'KeyC', metaKey: true }), { chordActive: false, platform: 'MacIntel' }), 'copy-relative-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }), { chordActive: false, platform: 'MacIntel' }), 'copy-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), { chordActive: false, platform: 'Win32' }), 'copy-relative-path');
    assert.equal(folderShortcutAction(keyEvent({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), { chordActive: false, platform: 'Linux x86_64' }), 'copy-path');
});

test('FolderPanel click toggle helper follows VS Code platform modifiers', () => {
    assert.equal(isPlatformToggleClick({ metaKey: true, ctrlKey: false }, 'MacIntel'), true);
    assert.equal(isPlatformToggleClick({ metaKey: false, ctrlKey: true }, 'MacIntel'), false);
    assert.equal(isPlatformToggleClick({ metaKey: false, ctrlKey: true }, 'Win32'), true);
    assert.equal(isPlatformToggleClick({ metaKey: true, ctrlKey: false }, 'Linux x86_64'), false);
});

test('FolderPanel shortcut helper guards browser globals for tests and SSR', () => {
    assert.ok(folderShortcutsSource.includes("from '../client-platform'"), 'folder shortcuts must use the shared client platform helper');
    assert.ok(clientPlatformSource.includes("typeof navigator === 'undefined'"), 'platform detection must not assume browser navigator exists');
    assert.ok(folderShortcutsSource.includes("typeof HTMLElement === 'undefined'"), 'editable target checks must not assume browser HTMLElement exists');
});

test('FolderPanel context menu exposes native path actions through the shared ContextMenu', () => {
    for (const label of ['Copy Path', 'Copy Relative Path', 'Reveal in Finder', 'Open Folder', 'Refresh']) {
        assert.ok(folderContextMenuSource.includes(label), `context menu must include ${label}`);
    }
    assert.ok(folderContextMenuSource.includes("../components/context-menu/ContextMenu"), 'folder menu must delegate to the shared ContextMenu');
    assert.ok(folderContextMenuSource.includes("kind: 'separator'"), 'folder menu must group actions with separators');
    assert.ok(sharedContextMenuSource.includes('role="menu"'), 'shared context menu must expose menu role');
    assert.ok(sharedContextMenuSource.includes('role="menuitem"'), 'shared context menu actions must expose menuitem role');
    assert.ok(folderPanelSource.includes('onContextMenuClose={folderContextMenu.closeContextMenu}'), 'overlays must close the menu through the panel-owned hook');
    assert.ok(folderPanelSource.includes("folderContextMenu.closeContextMenu(); void copySelectedPath('absolute')"), 'copy menu actions must close menu before running selected-set copy');
    assert.ok(folderPanelSource.includes('folderContextMenu.closeContextMenu(); void revealSelectedPath()'), 'reveal menu action must close menu before running selected-primary reveal');
    assert.ok(folderPanelSource.includes("folderContextMenu.closeContextMenu(); void refreshVisibleTree('manual')"), 'refresh menu action must close menu before running');
    assert.ok(sharedContextMenuSource.includes("event.key === 'Escape'"), 'keyboard dismissal must be Escape-driven');
    assert.ok(sharedContextMenuSource.includes("window.addEventListener('blur', onDismiss)"), 'menu must close when window focus leaves, including into the preview iframe');
    assert.ok(sharedContextMenuSource.includes("window.addEventListener('pointerdown', onPointerDown, true)"), 'outside pointerdown must dismiss the menu');
    assert.ok(sharedContextMenuSource.includes('event.stopPropagation()'), 'menu keyboard activation must not bubble into row handlers');
    assert.ok(folderContextMenuHookSource.includes('input.selectOnlyPath(entry.path)'), 'opening the menu must still select the target row');
    assert.ok(folderRowsSource.includes('rect.left + 8'), 'keyboard context-menu key must anchor the menu at the focused row');
});

test('FolderPanel focus and context menu styles stay compact', () => {
    assert.ok(folderCss.includes('.folder-entry-btn:focus-visible'), 'row buttons need visible keyboard focus');
    assert.equal(folderCss.includes('.folder-context-menu'), false, 'folder panel must not keep a private menu stylesheet');
    assert.ok(sharedContextMenuCss.includes('.jaw-context-menu'), 'context menu must have shared scoped styles');
    assert.ok(sharedContextMenuCss.includes('position: fixed'), 'context menu must not resize tree rows');
    assert.ok(sharedContextMenuCss.includes('text-overflow: ellipsis'), 'menu text must not overflow');
});
