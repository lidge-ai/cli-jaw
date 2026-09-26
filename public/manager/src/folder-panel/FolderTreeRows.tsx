import type { FolderPanelEntry, FolderPanelRowDecoration } from './folder-panel-types';
import { FOLDER_PANEL_DRAG_MIME, encodeFolderPanelDragPayload } from './folder-drag-payload';
import { isDescendantPath } from './folder-panel-state';
import { FolderInlineNameEditor } from './FolderInlineNameEditor';
import { isPlatformToggleClick } from './folder-shortcuts';
import type { FolderInlineMutationState } from './use-folder-mutations';
import type { FolderDragSelection } from './use-folder-selection';

type FolderTreeRowsProps = {
    entries: FolderPanelEntry[];
    parentPath: string | null;
    depth: number;
    expanded: Set<string>;
    childrenCache: Map<string, FolderPanelEntry[]>;
    selectedPaths: Set<string>;
    focusedPath: string | null;
    decorationsByPath: Map<string, FolderPanelRowDecoration>;
    dropTargetPath: string | null;
    dragSelection: FolderDragSelection | null;
    inlineMutation: FolderInlineMutationState | null;
    isMutating: boolean;
    canUseNativeActions: boolean;
    setDragSelection: (selection: FolderDragSelection | null) => void;
    setDropTargetPath: (path: string | null) => void;
    getDragSelectionFor: (entry: FolderPanelEntry) => FolderDragSelection;
    requestMove: (sourceEntry: FolderPanelEntry, targetEntry: FolderPanelEntry) => void;
    handleEntryKeyDown: (event: React.KeyboardEvent, entry: FolderPanelEntry) => void;
    selectEntry: (entry: FolderPanelEntry, options?: { range?: boolean; toggle?: boolean; preview?: boolean }) => void;
    toggleEntryExpansion: (entry: FolderPanelEntry) => void;
    openFileEntry: (entry: FolderPanelEntry) => void;
    openContextMenu: (entry: FolderPanelEntry, x: number, y: number) => void;
    submitInlineMutation: (name: string) => void;
    cancelInlineMutation: () => void;
};

function emitFolderPanelDrag(active: boolean): void {
    window.dispatchEvent(new CustomEvent('jaw-folder-panel-drag', { detail: { active } }));
}

export function FolderTreeRows(props: FolderTreeRowsProps) {
    const createMutation = props.inlineMutation && props.inlineMutation.kind !== 'rename' && props.inlineMutation.parentDirectory === props.parentPath
        ? props.inlineMutation
        : null;

    return (
        <>
            {createMutation && (
                <div className="folder-entry folder-entry-inline">
                    {props.depth > 0 && (
                        <span className="folder-indent" aria-hidden="true">
                            {Array.from({ length: props.depth }, (_, level) => (
                                <span key={level} className="folder-indent-guide" />
                            ))}
                        </span>
                    )}
                    <span className="folder-entry-disclosure is-placeholder" aria-hidden="true">·</span>
                    <FolderInlineNameEditor
                        initialName={createMutation.initialName}
                        busy={props.isMutating}
                        label={createMutation.kind === 'file' ? 'New file name' : 'New folder name'}
                        onSubmit={props.submitInlineMutation}
                        onCancel={props.cancelInlineMutation}
                    />
                </div>
            )}
            {props.entries.map(entry => (
                <div key={entry.path}>
                    {(() => {
                        const decoration = props.decorationsByPath.get(entry.path);
                        const renameMutation = props.inlineMutation?.kind === 'rename' && props.inlineMutation.targetPath === entry.path
                            ? props.inlineMutation
                            : null;
                        return (
                    <div
                        className={[
                            'folder-entry',
                            `folder-entry-${entry.kind}`,
                            decoration?.className ?? '',
                            props.selectedPaths.has(entry.path) ? 'is-selected' : '',
                            props.focusedPath === entry.path ? 'is-focused' : '',
                            props.dropTargetPath === entry.path ? 'is-drop-target' : '',
                            props.dragSelection?.primaryEntry.path === entry.path ? 'is-dragging' : '',
                        ].filter(Boolean).join(' ')}
                        role="treeitem"
                        aria-selected={props.selectedPaths.has(entry.path)}
                        draggable={props.canUseNativeActions}
                        onDragStart={(event) => {
                            if (!props.canUseNativeActions) return;
                            const dragSelection = props.getDragSelectionFor(entry);
                            props.setDragSelection(dragSelection);
                            emitFolderPanelDrag(true);
                            event.dataTransfer.effectAllowed = 'copyMove';
                            event.dataTransfer.setData(FOLDER_PANEL_DRAG_MIME, encodeFolderPanelDragPayload(dragSelection));
                            event.dataTransfer.setData('text/plain', dragSelection.entries.map(item => item.path).join('\n'));
                        }}
                        onDragEnd={() => {
                            emitFolderPanelDrag(false);
                            props.setDragSelection(null);
                            props.setDropTargetPath(null);
                        }}
                        onDragOver={(event) => {
                            const draggedEntry = props.dragSelection?.primaryEntry;
                            if (!draggedEntry || entry.kind !== 'directory') return;
                            if (draggedEntry.path === entry.path) return;
                            if (draggedEntry.kind === 'directory' && isDescendantPath(draggedEntry.path, entry.path)) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            props.setDropTargetPath(entry.path);
                        }}
                        onDragLeave={() => {
                            if (props.dropTargetPath === entry.path) props.setDropTargetPath(null);
                        }}
                        onDrop={(event) => {
                            if (!props.dragSelection || entry.kind !== 'directory') return;
                            event.preventDefault();
                            emitFolderPanelDrag(false);
                            props.setDropTargetPath(null);
                            props.requestMove(props.dragSelection.primaryEntry, entry);
                        }}
                    >
                        {props.depth > 0 && (
                            <span className="folder-indent" aria-hidden="true">
                                {Array.from({ length: props.depth }, (_, level) => (
                                    <span key={level} className="folder-indent-guide" />
                                ))}
                            </span>
                        )}
                        <button
                            type="button"
                            className={entry.kind === 'directory' ? 'folder-entry-disclosure' : 'folder-entry-disclosure is-placeholder'}
                            aria-label={entry.kind === 'directory' ? (props.expanded.has(entry.path) ? `Collapse ${entry.name}` : `Expand ${entry.name}`) : undefined}
                            aria-expanded={entry.kind === 'directory' ? props.expanded.has(entry.path) : undefined}
                            tabIndex={entry.kind === 'directory' ? 0 : -1}
                            disabled={entry.kind !== 'directory'}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (entry.kind === 'directory') props.toggleEntryExpansion(entry);
                            }}
                        >
                            {entry.kind === 'directory' ? (props.expanded.has(entry.path) ? '▾' : '▸') : '·'}
                        </button>
                        {renameMutation ? (
                            <FolderInlineNameEditor
                                initialName={renameMutation.initialName}
                                busy={props.isMutating}
                                label="Rename"
                                onSubmit={props.submitInlineMutation}
                                onCancel={props.cancelInlineMutation}
                            />
                        ) : (
                            <button
                                type="button"
                                className="folder-entry-btn"
                                data-folder-path={entry.path}
                                onKeyDown={(event) => props.handleEntryKeyDown(event, entry)}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    if (event.clientX !== 0 || event.clientY !== 0) {
                                        props.openContextMenu(entry, event.clientX, event.clientY);
                                        return;
                                    }
                                    const rect = event.currentTarget.getBoundingClientRect();
                                    props.openContextMenu(entry, rect.left + 8, rect.bottom);
                                }}
                                onClick={(event) => props.selectEntry(entry, { range: event.shiftKey, toggle: isPlatformToggleClick(event), preview: false })}
                                onDoubleClick={() => {
                                    if (entry.kind === 'directory') props.toggleEntryExpansion(entry);
                                    else props.openFileEntry(entry);
                                }}
                            >
                                <span className="folder-entry-name">{entry.name}</span>
                                {decoration?.label && (
                                    <span className="folder-entry-git-badge" title={decoration.title} aria-label={decoration.title ?? decoration.label}>
                                        {decoration.label}
                                    </span>
                                )}
                            </button>
                        )}
                    </div>
                        );
                    })()}
                    {entry.kind === 'directory' && props.expanded.has(entry.path) && props.childrenCache.has(entry.path) && (
                        <FolderTreeRows
                            {...props}
                            entries={props.childrenCache.get(entry.path)!}
                            parentPath={entry.path}
                            depth={props.depth + 1}
                        />
                    )}
                </div>
            ))}
        </>
    );
}
