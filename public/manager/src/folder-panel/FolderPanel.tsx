import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDesktop, type FolderBridgeApi } from '../panels/desktop-bridge';
import { copyText } from '../clipboard/copy-text';
import { createElectronFolderSource, createNotesVaultFolderSource, type FolderPanelEntry } from './folder-sources';
import { FolderActionRow } from './FolderActionRow';
import { FolderPanelOverlays } from './FolderPanelOverlays';
import { FolderPanelToolbar } from './FolderPanelToolbar';
import { FolderWorktreeOpsDialog } from './FolderWorktreeOpsDialog';
import { FolderPanelTree } from './FolderPanelTree';
import { dropCachedBranches, isDescendantPath, parentPath, relativeFolderPath } from './folder-panel-state';
import { compatibleFolderPanelSession, folderPanelSessionFromState, snapshotToChildrenCache } from './folder-panel-session';
import { folderShortcutAction } from './folder-shortcuts';
import { useFolderGitStatus } from './use-folder-git-status';
import { useGitWorktrees } from './use-git-worktrees';
import { useFolderChord } from './use-folder-chord';
import { useFolderSelection, type FolderDragSelection } from './use-folder-selection';
import { useFolderVisibleRefresh } from './use-folder-visible-refresh';
import { useFolderPreviewSync } from './use-folder-preview-sync';
import { useFolderWorktreeOperations } from './use-folder-worktree-operations';
import { useFolderMutations } from './use-folder-mutations';
import { useFolderContextMenu } from './use-folder-context-menu';
import type { FolderPanelProps } from './folder-panel-props';
import './folder-panel.css';

function getFolderBridge(): FolderBridgeApi | null {
    return getDesktop()?.folder ?? null;
}
function renamedPreviewPath(currentPath: string | null | undefined, oldPath: string, newPath: string): string | null {
    if (!currentPath || !isDescendantPath(oldPath, currentPath)) return null;
    return currentPath === oldPath ? newPath : `${newPath}${currentPath.slice(oldPath.length)}`;
}

export function FolderPanel(props: FolderPanelProps) {
    const bridge = getFolderBridge();
    const repoRootPath = props.repoRootPath ?? null;
    const gitRefreshVersion = props.gitRefreshVersion ?? 0;
    const onGitRefresh = props.onGitRefresh;
    const onRepoRootChange = props.onRepoRootChange;
    const initialRootResolvedRef = useRef(false);
    const source = useMemo(() => bridge ? createElectronFolderSource(bridge) : createNotesVaultFolderSource(props.notesTree ?? [], props.notesRoot ?? null), [bridge, props.notesRoot, props.notesTree]);
    const initialSession = useMemo(() => compatibleFolderPanelSession(props.sessionState ?? null, props.externalRootPath ?? null), [props.externalRootPath, props.sessionState]);
    const [rootPath, setRootPath] = useState<string | null>(() => initialSession?.rootPath ?? null);
    const [entries, setEntries] = useState<FolderPanelEntry[]>(() => initialSession?.entries ?? []);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialSession?.expandedPaths ?? []));
    const [childrenCache, setChildrenCache] = useState<Map<string, FolderPanelEntry[]>>(() => (
        initialSession ? snapshotToChildrenCache(initialSession.childrenCache) : new Map()
    ));
    const [error, setError] = useState<string | null>(null);
    const [unavailableRoot, setUnavailableRoot] = useState<{ path: string; error: string } | null>(null);
    const [dragSelection, setDragSelection] = useState<FolderDragSelection | null>(null);
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const [pendingMove, setPendingMove] = useState<{ source: FolderPanelEntry; target: FolderPanelEntry } | null>(null);
    const [isMoving, setIsMoving] = useState(false);
    const [skipInternalMoveConfirm, setSkipInternalMoveConfirm] = useState(false);
    const [skipMoveConfirmChecked, setSkipMoveConfirmChecked] = useState(false);
    const [actionStatus, setActionStatus] = useState<string | null>(null);
    const [gitRefreshToken, setGitRefreshToken] = useState(0);
    const treeRef = useRef<HTMLDivElement | null>(null);
    const restoredRootLoadRef = useRef<string | null>(null);
    const { folderChordActive, startFolderChord, cancelFolderChord } = useFolderChord();
    const onPreviewFile = props.onPreviewFile;
    const selectedFilePath = props.selectedFilePath;
    const folderSelection = useFolderSelection({
        entries,
        childrenCache,
        expanded,
        initialSelection: initialSession?.selection,
        onPreviewFile,
    });
    const selectedEntry = folderSelection.selectedEntry;
    const selectedEntries = folderSelection.selectedEntries;
    const folderContextMenu = useFolderContextMenu({
        selectedPaths: folderSelection.selectedPaths,
        selectOnlyPath: folderSelection.selectOnlyPath,
    });
    useFolderPreviewSync({
        selectedFilePath: props.selectedFilePath,
        rootPath,
        selectedPath: folderSelection.selectedPath,
        visiblePaths: folderSelection.visiblePaths,
        selectOnlyPath: folderSelection.selectOnlyPath,
    });
    useEffect(() => {
        props.onSessionStateChange?.(folderPanelSessionFromState({
            rootPath,
            entries,
            expanded,
            childrenCache,
            selection: folderSelection.selection,
        }));
    }, [childrenCache, entries, expanded, folderSelection.selection, props.onSessionStateChange, rootPath]);

    const loadDir = useCallback(async (dirPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
        try {
            const nextEntries = await source.listDir(dirPath);
            setEntries(nextEntries);
            setError(null);
            setUnavailableRoot(current => current?.path === dirPath ? null : current);
            return { ok: true };
        } catch (err) {
            const message = (err as Error).message;
            setError(message);
            return { ok: false, error: message };
        }
    }, [source]);
    const openFolderRoot = useCallback(async (
        nextRoot: string,
        options: { registerGitWorktree?: boolean; repoRoot?: string | null } = {},
    ) => {
        try {
            let authorizedRoot = nextRoot;
            if (options.registerGitWorktree) {
                if (!rootPath) throw new Error('Current folder root required');
                await source.registerGitWorktreeRoot?.(rootPath, options.repoRoot ?? undefined, nextRoot);
            } else if (source.authorizeRoot) {
                authorizedRoot = await source.authorizeRoot(nextRoot);
            }
            if (rootPath && source.unwatchDir) void source.unwatchDir(rootPath);
            props.onRootChange?.(authorizedRoot);
            setRootPath(authorizedRoot);
            setExpanded(new Set());
            setChildrenCache(new Map());
            setEntries([]);
            folderSelection.resetSelection();
            setError(null);
            setUnavailableRoot(null);
            const loaded = await loadDir(authorizedRoot);
            if (!loaded.ok) setUnavailableRoot({ path: authorizedRoot, error: loaded.error });
            setGitRefreshToken(token => token + 1);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [folderSelection, loadDir, props, rootPath, source]);

    const loadChildren = useCallback(async (dirPath: string, options: { force?: boolean } = {}) => {
        if (!options.force && childrenCache.has(dirPath)) return;
        try {
            const nextEntries = await source.listDir(dirPath);
            setChildrenCache(prev => new Map(prev).set(dirPath, nextEntries));
        } catch (err) {
            setError((err as Error).message);
        }
    }, [childrenCache, source]);
    const bumpGitRefresh = useCallback(() => {
        setGitRefreshToken(token => token + 1);
    }, []);

    const toggleExpand = useCallback((entryPath: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(entryPath)) {
                next.delete(entryPath);
            } else {
                next.add(entryPath);
                void loadChildren(entryPath);
            }
            return next;
        });
    }, [loadChildren]);

    const pickFolder = useCallback(async () => {
        if (!source.pickRoot) return;
        try {
            const picked = await source.pickRoot();
            if (picked) await openFolderRoot(picked);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [openFolderRoot, source]);

    const clearUnavailableRoot = useCallback(() => {
        props.onRootChange?.(null);
        setRootPath(null);
        setEntries([]);
        folderSelection.resetSelection();
        setUnavailableRoot(null);
        setError(null);
    }, [folderSelection, props]);

    useEffect(() => {
        if (initialRootResolvedRef.current || rootPath !== null || props.externalRootPath) return;
        let cancelled = false;
        void (async () => {
            const nextRoot = await source.getInitialRoot();
            if (cancelled) return;
            initialRootResolvedRef.current = true;
            setRootPath(nextRoot);
            if (nextRoot !== null) await loadDir(nextRoot);
        })();
        return () => { cancelled = true; };
    }, [loadDir, props.externalRootPath, rootPath, source]);

    useEffect(() => {
        const externalRoot = props.externalRootPath;
        if (!externalRoot) return;
        if (externalRoot === rootPath) {
            if (entries.length > 0 || restoredRootLoadRef.current === externalRoot) return;
            restoredRootLoadRef.current = externalRoot;
        } else restoredRootLoadRef.current = null;
        void openFolderRoot(externalRoot);
    }, [entries.length, openFolderRoot, props.externalRootPath, rootPath]);

    const gitStatus = useFolderGitStatus({
        rootPath,
        enabled: source.kind === 'electron-folder',
        refreshToken: gitRefreshToken + gitRefreshVersion,
    });
    const worktreeState = useGitWorktrees({
        folderPanelRoot: rootPath,
        repoRoot: gitStatus.repoRoot ?? repoRootPath,
        enabled: source.kind === 'electron-folder' && gitStatus.available,
        refreshToken: gitRefreshToken + gitRefreshVersion,
    });
    const visibleRefresh = useFolderVisibleRefresh({
        rootPath,
        expanded,
        source,
        loadDir,
        loadChildren,
        bumpGitRefresh,
        onGitRefresh,
        refreshWorktrees: worktreeState.refresh,
    });
    const refreshVisibleTree = visibleRefresh.refreshVisibleTree;
    const worktreeOps = useFolderWorktreeOperations({
        rootPath,
        source,
        worktreeState,
        openFolderRoot,
        refreshVisibleTree,
        bumpGitRefresh,
        setActionStatus,
        setError,
    });

    useEffect(() => {
        if (gitStatus.repoRoot && gitStatus.repoRoot !== repoRootPath) onRepoRootChange?.(gitStatus.repoRoot);
    }, [gitStatus.repoRoot, onRepoRootChange, repoRootPath]);

    const canUseNativeActions = source.kind === 'electron-folder';
    const canMutateEntries = Boolean(source.createFile && source.createFolder && source.renamePath);

    const refreshAfterMove = useCallback(async (sourcePath: string, targetPath: string) => {
        if (!rootPath) return;
        const sourceParent = parentPath(sourcePath);
        setChildrenCache(prev => dropCachedBranches(prev, [sourceParent, targetPath]));
        await refreshVisibleTree('move', { extraPaths: [sourceParent, targetPath] });
    }, [refreshVisibleTree, rootPath]);

    const refreshAfterMutation = useCallback(async (parentDirectory: string, focusPath: string | null, extraDroppedPaths: string[] = []) => {
        if (!rootPath) return;
        setChildrenCache(prev => dropCachedBranches(prev, [parentDirectory, ...extraDroppedPaths]));
        await refreshVisibleTree('mutation', { extraPaths: [parentDirectory] });
        if (focusPath) folderSelection.selectOnlyPath(focusPath);
    }, [folderSelection, refreshVisibleTree, rootPath]);

    const executeMove = useCallback(async (move: { source: FolderPanelEntry; target: FolderPanelEntry }) => {
        if (!source.movePath) return;
        setIsMoving(true);
        try {
            const result = await source.movePath(move.source.path, move.target.path);
            const movedPath = result.moved?.to ?? move.source.path;
            folderSelection.selectOnlyPath(movedPath);
            setActionStatus(`Moved ${move.source.name}`);
            setPendingMove(null);
            await refreshAfterMove(move.source.path, move.target.path);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsMoving(false);
        }
    }, [folderSelection, refreshAfterMove, source]);

    const requestMove = useCallback((sourceEntry: FolderPanelEntry, targetEntry: FolderPanelEntry) => {
        if (!source.movePath || sourceEntry.path === targetEntry.path) return;
        if (sourceEntry.kind === 'directory' && isDescendantPath(sourceEntry.path, targetEntry.path)) return;
        const move = { source: sourceEntry, target: targetEntry };
        if (skipInternalMoveConfirm) {
            void executeMove(move);
            return;
        }
        setSkipMoveConfirmChecked(false);
        setPendingMove(move);
    }, [executeMove, skipInternalMoveConfirm, source.movePath]);

    const folderMutations = useFolderMutations({
        rootPath,
        selectedEntry,
        selectedFilePath,
        source,
        folderSelection,
        refreshAfterMutation,
        renamedPreviewPath,
        onPreviewFile,
        closeContextMenu: folderContextMenu.closeContextMenu,
        setExpanded,
        setActionStatus,
        setError,
    });

    const selectEntry = useCallback((entry: FolderPanelEntry, options?: { range?: boolean; toggle?: boolean; preview?: boolean }) => {
        folderSelection.selectEntry(entry, options);
        folderContextMenu.closeContextMenu();
    }, [folderContextMenu, folderSelection]);

    const openFileEntry = useCallback((entry: FolderPanelEntry) => {
        if (entry.kind !== 'file') return;
        selectEntry(entry);
    }, [selectEntry]);

    const toggleEntryExpansion = useCallback((entry: FolderPanelEntry) => {
        folderSelection.selectEntry(entry, { preview: false });
        folderContextMenu.closeContextMenu();
        if (entry.kind === 'directory') toggleExpand(entry.path);
    }, [folderContextMenu, folderSelection, toggleExpand]);

    const copyEntryPath = useCallback(async (entry: FolderPanelEntry, kind: 'absolute' | 'relative') => {
        const value = kind === 'relative' ? relativeFolderPath(rootPath, entry.path) : entry.path;
        const result = await copyText(value);
        if (result.ok) {
            folderSelection.selectOnlyPath(entry.path);
            setActionStatus(kind === 'relative' ? 'Copied relative path' : 'Copied path');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy path');
        }
    }, [folderSelection, rootPath]);

    const revealEntryPath = useCallback(async (entry: FolderPanelEntry) => {
        if (!source.revealPath) return;
        try {
            await source.revealPath(entry.path);
            folderSelection.selectOnlyPath(entry.path);
            setActionStatus(entry.kind === 'directory' ? 'Opened folder in Finder' : 'Revealed file in Finder');
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [folderSelection, source]);

    const copySelectedPath = useCallback(async (kind: 'absolute' | 'relative') => {
        if (selectedEntries.length === 0) return;
        const value = selectedEntries
            .map(entry => kind === 'relative' ? relativeFolderPath(rootPath, entry.path) : entry.path)
            .join('\n');
        const result = await copyText(value);
        if (result.ok) {
            setActionStatus(kind === 'relative' ? 'Copied relative paths' : 'Copied paths');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy paths');
        }
    }, [rootPath, selectedEntries]);

    const revealSelectedPath = useCallback(async () => {
        if (!selectedEntry) return;
        await revealEntryPath(selectedEntry);
    }, [revealEntryPath, selectedEntry]);

    const handleEntryKeyDown = useCallback((event: React.KeyboardEvent, entry: FolderPanelEntry) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            folderSelection.moveKeyboardSelection(event.key === 'ArrowDown' ? 'down' : 'up', event.shiftKey);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            if (entry.kind === 'directory' && !expanded.has(entry.path)) {
                toggleEntryExpansion(entry);
            }
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (entry.kind === 'directory' && expanded.has(entry.path)) {
                toggleEntryExpansion(entry);
            }
            return;
        }
        const action = folderShortcutAction(event, { chordActive: folderChordActive });
        if (action) {
            event.preventDefault();
            event.stopPropagation();
            if (action === 'start-chord') startFolderChord();
            if (action === 'cancel-chord') cancelFolderChord();
            const useSelection = folderSelection.selectedPaths.has(entry.path);
            if (action === 'copy-path') { cancelFolderChord(); void (useSelection ? copySelectedPath('absolute') : copyEntryPath(entry, 'absolute')); }
            if (action === 'copy-relative-path') { cancelFolderChord(); void (useSelection ? copySelectedPath('relative') : copyEntryPath(entry, 'relative')); }
            if (action === 'reveal-path') { cancelFolderChord(); void (useSelection ? revealSelectedPath() : revealEntryPath(entry)); }
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (entry.kind === 'directory') toggleEntryExpansion(entry);
            else selectEntry(entry);
            return;
        }
        if (event.key === ' ') {
            event.preventDefault();
            selectEntry(entry);
        }
    }, [cancelFolderChord, copyEntryPath, copySelectedPath, expanded, folderChordActive, folderSelection, revealEntryPath, revealSelectedPath, selectEntry, startFolderChord, toggleEntryExpansion]);

    useEffect(() => {
        const focusedPath = folderSelection.selection.focusedPath;
        if (!focusedPath) return;
        const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>('.folder-entry-btn[data-folder-path]');
        const nextButton = Array.from(buttons ?? []).find(button => button.dataset['folderPath'] === focusedPath);
        nextButton?.focus();
    }, [folderSelection.selection.focusedPath]);

    return (
        <div className="folder-panel">
            <FolderPanelToolbar
                canPickRoot={source.canPickRoot}
                label={source.label}
                rootPath={rootPath}
                onPickFolder={() => void pickFolder()}
                onRefresh={() => { if (rootPath !== null) void refreshVisibleTree('manual'); }}
                gitSummary={source.kind === 'electron-folder' ? gitStatus : undefined}
                worktreeSummary={source.kind === 'electron-folder' ? worktreeState : undefined}
                onOpenWorktree={path => void worktreeOps.openWorktreeRoot(path)}
                onCopyWorktreePath={path => void worktreeOps.copyWorktreePath(path)}
                onRevealWorktreePath={path => void worktreeOps.revealWorktreePath(path)}
                onOpenWorktreeOps={() => worktreeOps.setOpen(true)}
            />
            {rootPath !== null && (
                <FolderActionRow
                    hasSelection={Boolean(selectedEntry)}
                    canReveal={Boolean(source.revealPath)}
                    onCopyPath={() => void copySelectedPath('absolute')}
                    onCopyRelativePath={() => void copySelectedPath('relative')}
                    onReveal={() => void revealSelectedPath()}
                    canMutate={canMutateEntries}
                    onCreateFile={() => folderMutations.requestCreateEntry('file')}
                    onCreateFolder={() => folderMutations.requestCreateEntry('directory')}
                    onRename={() => folderMutations.requestRenameSelectedEntry()}
                />
            )}
            {error && <div className="folder-error">{error}</div>}
            {visibleRefresh.watchStatus && !error && <div className="folder-status">{visibleRefresh.watchStatus}</div>}
            {visibleRefresh.refreshStatus && !error && !visibleRefresh.watchStatus && <div className="folder-status">{visibleRefresh.refreshStatus}</div>}
            {actionStatus && !error && !visibleRefresh.refreshStatus && !visibleRefresh.watchStatus && <div className="folder-status">{actionStatus}</div>}
            {folderChordActive && <div className="folder-shortcut-hint">Folder shortcut: press P to copy path or R to reveal</div>}
            {worktreeOps.open && rootPath !== null && (
                <FolderWorktreeOpsDialog
                    folderPanelRoot={rootPath}
                    repoRoot={worktreeState.repoRoot}
                    worktrees={worktreeState.worktrees}
                    busy={worktreeOps.busy}
                    history={worktreeOps.history}
                    onRun={(operation, preview) => void worktreeOps.runWorktreeOperation(operation, preview)}
                    onClose={() => worktreeOps.setOpen(false)}
                />
            )}
            <FolderPanelTree
                treeRef={treeRef}
                rootPath={rootPath}
                error={error}
                entries={entries}
                expanded={expanded}
                childrenCache={childrenCache}
                folderSelection={folderSelection}
                decorationsByPath={gitStatus.decorationsByPath}
                dropTargetPath={dropTargetPath}
                dragSelection={dragSelection}
                inlineMutation={folderMutations.inlineMutation}
                isMutating={folderMutations.isMutating}
                canUseNativeActions={canUseNativeActions}
                sourceKind={source.kind}
                unavailableRoot={unavailableRoot}
                setDragSelection={setDragSelection}
                setDropTargetPath={setDropTargetPath}
                requestMove={requestMove}
                handleEntryKeyDown={handleEntryKeyDown}
                selectEntry={selectEntry}
                toggleEntryExpansion={toggleEntryExpansion}
                openFileEntry={openFileEntry}
                openContextMenu={folderContextMenu.openContextMenu}
                submitInlineMutation={folderMutations.submitInlineMutation}
                cancelInlineMutation={folderMutations.cancelInlineMutation}
                onPickFolder={() => void pickFolder()}
                onClearUnavailableRoot={clearUnavailableRoot}
            />
            <FolderPanelOverlays
                pendingMove={pendingMove}
                contextMenu={folderContextMenu.contextMenu}
                isMoving={isMoving}
                skipMoveConfirmChecked={skipMoveConfirmChecked}
                canReveal={Boolean(source.revealPath)}
                canRefresh={Boolean(rootPath)}
                canMutate={canMutateEntries}
                onSkipMoveConfirmCheckedChange={setSkipMoveConfirmChecked}
                onCancelMove={() => setPendingMove(null)}
                onConfirmMove={() => {
                    if (!pendingMove) return;
                    if (skipMoveConfirmChecked) setSkipInternalMoveConfirm(true);
                    void executeMove(pendingMove);
                }}
                onContextMenuClose={folderContextMenu.closeContextMenu}
                onCopyContextPath={() => { folderContextMenu.closeContextMenu(); void copySelectedPath('absolute'); }}
                onCopyContextRelativePath={() => { folderContextMenu.closeContextMenu(); void copySelectedPath('relative'); }}
                onRevealContextPath={() => { folderContextMenu.closeContextMenu(); void revealSelectedPath(); }}
                onRefreshContext={() => { folderContextMenu.closeContextMenu(); void refreshVisibleTree('manual'); }}
                onCreateContextFile={() => folderMutations.requestCreateEntry('file')}
                onCreateContextFolder={() => folderMutations.requestCreateEntry('directory')}
                onRenameContextPath={() => folderMutations.requestRenameSelectedEntry()}
            />
        </div>
    );
}
