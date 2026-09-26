import { useMemo } from 'react';
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from '../components/context-menu/ContextMenu';
import { CopyGlyph, DocGlyph, FolderGlyph, PencilGlyph, RestartGlyph } from '../components/context-menu/icons';
import { isMacLikePlatform } from '../client-platform';
import type { FolderPanelEntry } from './folder-sources';

type FolderContextMenuProps = {
    entry: FolderPanelEntry;
    x: number;
    y: number;
    canReveal: boolean;
    canRefresh: boolean;
    canMutate: boolean;
    onClose: () => void;
    onCopyPath: () => void;
    onCopyRelativePath: () => void;
    onReveal: () => void;
    onRefresh: () => void;
    onCreateFile: () => void;
    onCreateFolder: () => void;
    onRename: () => void;
};

export function FolderContextMenu(props: FolderContextMenuProps) {
    const mac = isMacLikePlatform();
    // ContextMenu's positioning effect keys on `state` identity — keep it stable.
    const menuState = useMemo<ContextMenuState>(() => ({ x: props.x, y: props.y }), [props.x, props.y]);
    const entries: ContextMenuEntry[] = [
        { id: 'copy-path', label: 'Copy Path', icon: <CopyGlyph />, shortcut: mac ? '⇧⌘C' : 'Ctrl+Shift+C', onSelect: props.onCopyPath },
        { id: 'copy-relative-path', label: 'Copy Relative Path', icon: <CopyGlyph />, shortcut: mac ? '⌘C' : 'Ctrl+C', onSelect: props.onCopyRelativePath },
        { kind: 'separator', id: 'sep-reveal' },
        {
            id: 'reveal',
            label: props.entry.kind === 'directory' ? 'Open Folder' : 'Reveal in Finder',
            icon: <FolderGlyph />,
            shortcut: mac ? '⌥⌘R' : 'Ctrl+Alt+R',
            disabled: !props.canReveal,
            onSelect: props.onReveal,
        },
        { kind: 'separator', id: 'sep-create' },
        { id: 'new-file', label: 'New File', icon: <DocGlyph />, disabled: !props.canMutate, onSelect: props.onCreateFile },
        { id: 'new-folder', label: 'New Folder', icon: <FolderGlyph />, disabled: !props.canMutate, onSelect: props.onCreateFolder },
        { kind: 'separator', id: 'sep-rename' },
        { id: 'rename', label: 'Rename', icon: <PencilGlyph />, disabled: !props.canMutate, onSelect: props.onRename },
    ];
    if (props.canRefresh) {
        entries.push(
            { kind: 'separator', id: 'sep-refresh' },
            { id: 'refresh', label: 'Refresh', icon: <RestartGlyph />, onSelect: props.onRefresh },
        );
    }
    return (
        <ContextMenu
            state={menuState}
            entries={entries}
            label={`Folder actions for ${props.entry.name}`}
            onClose={props.onClose}
        />
    );
}
