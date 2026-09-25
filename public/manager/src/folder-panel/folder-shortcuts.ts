import { currentClientPlatform, isMacLikePlatform } from '../client-platform';

export type FolderShortcutAction = 'copy-path' | 'copy-relative-path' | 'reveal-path' | 'start-chord' | 'cancel-chord';

type KeyboardLike = {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    target?: EventTarget | null;
};

type FolderShortcutOptions = {
    chordActive: boolean;
    platform?: string | undefined;
};

export type FolderClickModifierLike = {
    metaKey: boolean;
    ctrlKey: boolean;
};

export function currentFolderShortcutPlatform(): string {
    return currentClientPlatform();
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
    if (typeof HTMLElement === 'undefined') return false;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.closest('[contenteditable="true"], .cm-editor, .ProseMirror, [data-milkdown-root], [role="textbox"]'));
}

export function isPlatformToggleClick(event: FolderClickModifierLike, platform = currentFolderShortcutPlatform()): boolean {
    return isMacLikePlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function folderShortcutAction(event: KeyboardLike, options: FolderShortcutOptions): FolderShortcutAction | null {
    if (isEditableShortcutTarget(event.target ?? null)) return null;
    const key = event.key.toLowerCase();
    const code = event.code ?? '';
    const isMac = isMacLikePlatform(options.platform ?? currentFolderShortcutPlatform());
    const primary = isMac ? event.metaKey : event.ctrlKey;
    const quickModifier = primary && event.altKey && !event.shiftKey;

    if (options.chordActive) {
        if (key === 'escape') return 'cancel-chord';
        if (primary || event.altKey || event.shiftKey) return null;
        if (key === 'p' || code === 'KeyP') return 'copy-path';
        if (key === 'r' || code === 'KeyR') return 'reveal-path';
        return 'cancel-chord';
    }

    if (primary && !event.altKey && !event.shiftKey && (key === 'k' || code === 'KeyK')) return 'start-chord';
    if (quickModifier && (key === 'c' || code === 'KeyC')) return 'copy-path';
    if (quickModifier && (key === 'r' || code === 'KeyR')) return 'reveal-path';
    if (primary && !event.altKey && key === 'c') return event.shiftKey ? 'copy-path' : 'copy-relative-path';
    return null;
}
