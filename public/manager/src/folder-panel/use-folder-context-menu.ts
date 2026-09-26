import { useCallback, useState } from 'react';
import type { FolderPanelEntry } from './folder-panel-types';

export type FolderContextMenuState = {
    entry: FolderPanelEntry;
    x: number;
    y: number;
};

type UseFolderContextMenuInput = {
    selectedPaths: Set<string>;
    selectOnlyPath: (path: string) => void;
};

/**
 * Owns which folder entry the context menu targets. Dismissal (outside
 * pointerdown, Escape, blur, scroll) and focus restore live in the shared
 * ContextMenu component.
 */
export function useFolderContextMenu(input: UseFolderContextMenuInput) {
    const [contextMenu, setContextMenu] = useState<FolderContextMenuState | null>(null);
    const closeContextMenu = useCallback(() => setContextMenu(null), []);
    const openContextMenu = useCallback((entry: FolderPanelEntry, x: number, y: number) => {
        if (!input.selectedPaths.has(entry.path)) input.selectOnlyPath(entry.path);
        setContextMenu({ entry, x, y });
    }, [input]);

    return {
        contextMenu,
        closeContextMenu,
        openContextMenu,
    };
}
