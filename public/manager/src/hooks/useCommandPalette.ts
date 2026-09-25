import { useCallback, useEffect, useState } from 'react';
import { currentClientPlatform, isMacLikePlatform } from '../client-platform';

/* 10.6.10 — Cmd/Ctrl+K opens the command palette.
 * Only one global key listener; coexists with InstanceDrawer's Esc handler
 * because they listen for different keys.
 */

export type CommandPaletteApi = {
    open: boolean;
    setOpen: (next: boolean) => void;
    toggle: () => void;
    close: () => void;
};

export function isPaletteShortcut(event: KeyboardEvent, platform: string = currentClientPlatform()): boolean {
    if (event.key !== 'k' && event.key !== 'K') return false;
    return isMacLikePlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function useCommandPalette(): CommandPaletteApi {
    const [open, setOpen] = useState(false);

    const toggle = useCallback(() => setOpen(prev => !prev), []);
    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if (!isPaletteShortcut(event)) return;
            event.preventDefault();
            setOpen(prev => !prev);
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    return { open, setOpen, toggle, close };
}
