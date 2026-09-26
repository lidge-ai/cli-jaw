import type { FolderPanelEntry } from './folder-panel-types';
import { FolderContextMenu } from './FolderContextMenu';
import { FolderMoveConfirmDialog } from './FolderMoveConfirmDialog';

type FolderPanelOverlaysProps = {
    pendingMove: { source: FolderPanelEntry; target: FolderPanelEntry } | null;
    contextMenu: { entry: FolderPanelEntry; x: number; y: number } | null;
    isMoving: boolean;
    skipMoveConfirmChecked: boolean;
    canReveal: boolean;
    canRefresh: boolean;
    canMutate: boolean;
    onSkipMoveConfirmCheckedChange: (checked: boolean) => void;
    onCancelMove: () => void;
    onConfirmMove: () => void;
    onContextMenuClose: () => void;
    onCopyContextPath: () => void;
    onCopyContextRelativePath: () => void;
    onRevealContextPath: () => void;
    onRefreshContext: () => void;
    onCreateContextFile: () => void;
    onCreateContextFolder: () => void;
    onRenameContextPath: () => void;
};

export function FolderPanelOverlays(props: FolderPanelOverlaysProps) {
    return (
        <>
            {props.pendingMove && (
                <FolderMoveConfirmDialog
                    source={props.pendingMove.source}
                    target={props.pendingMove.target}
                    busy={props.isMoving}
                    skipChecked={props.skipMoveConfirmChecked}
                    onSkipCheckedChange={props.onSkipMoveConfirmCheckedChange}
                    onCancel={props.onCancelMove}
                    onConfirm={props.onConfirmMove}
                />
            )}
            {props.contextMenu && (
                <FolderContextMenu
                    entry={props.contextMenu.entry}
                    x={props.contextMenu.x}
                    y={props.contextMenu.y}
                    canReveal={props.canReveal}
                    canRefresh={props.canRefresh}
                    canMutate={props.canMutate}
                    onClose={props.onContextMenuClose}
                    onCopyPath={props.onCopyContextPath}
                    onCopyRelativePath={props.onCopyContextRelativePath}
                    onReveal={props.onRevealContextPath}
                    onRefresh={props.onRefreshContext}
                    onCreateFile={props.onCreateContextFile}
                    onCreateFolder={props.onCreateContextFolder}
                    onRename={props.onRenameContextPath}
                />
            )}
        </>
    );
}
