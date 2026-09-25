import type { DashboardShortcutAction } from '../types';
import type { GitStatusMapResult } from '../folder-panel/folder-git-types';
import type { GitWorktreeEntry } from '../folder-panel/folder-worktree-types';
import type { GitWorktreeOperation, GitWorktreeOperationPreview } from '../folder-panel/folder-worktree-types';

export type TerminalBridgeApi = {
    list: () => Promise<{ ok: boolean; sessions?: TerminalSessionSnapshot[]; error?: string }>;
    create: (opts?: { cwd?: string; cols?: number; rows?: number }) => Promise<{ ok: boolean; id?: string; shell?: string; cwd?: string; error?: string }>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
    onData: (cb: (id: string, data: string) => void) => () => void;
    onExit: (cb: (id: string, code: number | null) => void) => () => void;
};

export type TerminalSessionSnapshot = {
    id: string;
    shell: string;
    cwd: string;
    cols: number;
    rows: number;
    buffer: string;
};

export type DiffMode = 'unstaged' | 'staged' | 'head' | 'base';

export type DiffOptions = {
    mode: DiffMode;
    ref?: string;
    includeUntracked?: boolean;
};

export type SourceControlGroupId = 'conflicts' | 'staged' | 'changes' | 'untracked';

export type SourceControlFile = {
    path: string;
    repoRelativePath: string;
    kind: string;
    staged: boolean;
    unstaged: boolean;
    conflict: boolean;
};

export type SourceControlGroup = {
    id: SourceControlGroupId;
    label: string;
    files: SourceControlFile[];
};

export type SourceControlSnapshot = {
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    groups: SourceControlGroup[];
};

export type SourceControlOperation = {
    kind: 'stage' | 'unstage';
    paths: string[];
};

export type SourceControlOperationResult = {
    operation: SourceControlOperation['kind'];
    paths: string[];
    snapshot: SourceControlSnapshot;
};

export type DiffRootCandidate = {
    path: string;
    label: string;
    source: 'project' | 'working-dir' | 'pinned' | 'recent' | 'home';
};

export type DiffResolvedRoot = DiffRootCandidate & {
    root: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
};

export type DiffBridgeApi = {
    getRepoRoot: (cwd: string) => Promise<{ ok: boolean; root?: string; error?: string }>;
    getRepoCandidates: (candidates: DiffRootCandidate[]) => Promise<{ ok: boolean; candidates?: DiffResolvedRoot[]; error?: string }>;
    getScmSnapshot: (repoRoot: string, options?: { includeUntracked?: boolean }) => Promise<{ ok: boolean; snapshot?: SourceControlSnapshot; error?: string }>;
    runScmOperation: (repoRoot: string, operation: SourceControlOperation) => Promise<{ ok: boolean; result?: SourceControlOperationResult; error?: string }>;
    getDiffSummary: (repoRoot: string, options: DiffOptions) => Promise<{ ok: boolean; files?: Array<{ path: string; status: string; insertions: number; deletions: number }>; error?: string }>;
    getFileDiff: (repoRoot: string, filePath: string, options: DiffOptions) => Promise<{ ok: boolean; diff?: string; error?: string }>;
};

export type GitBridgeApi = {
    getStatusMap: (
        folderPanelRoot: string,
        repoRoot?: string,
        options?: { includeIgnored?: boolean; includeUntracked?: boolean },
    ) => Promise<{ ok: boolean; status?: GitStatusMapResult; error?: string }>;
    getWorktrees: (
        folderPanelRoot: string,
        repoRoot?: string,
    ) => Promise<{ ok: boolean; repoRoot?: string; worktrees?: GitWorktreeEntry[]; error?: string }>;
    previewWorktreeOperation: (
        folderPanelRoot: string,
        repoRoot: string | undefined,
        operation: GitWorktreeOperation,
    ) => Promise<{ ok: boolean; preview?: GitWorktreeOperationPreview; error?: string }>;
    runWorktreeOperation: (
        folderPanelRoot: string,
        repoRoot: string | undefined,
        operation: GitWorktreeOperation,
        confirmed: boolean,
    ) => Promise<{ ok: boolean; repoRoot?: string; preview?: GitWorktreeOperationPreview; stdout?: string; worktrees?: GitWorktreeEntry[]; error?: string }>;
};

export type FolderBridgeApi = {
    getDefaultRoot: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    pickFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    pickFile?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    authorizeRoot?: (rootPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    registerGitWorktreeRoot?: (folderPanelRoot: string, repoRoot: string | undefined, worktreePath: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    listDir: (dirPath: string, depth?: number) => Promise<{ ok: boolean; entries?: Array<{ name: string; path: string; kind: 'file' | 'directory'; size: number }>; error?: string }>;
    readFile: (filePath: string) => Promise<{ ok: boolean; content?: string; truncated?: boolean; binary?: boolean; error?: string }>;
    movePath: (sourcePath: string, targetDirectory: string) => Promise<FolderMoveResult>;
    createFile: (parentDirectory: string, name: string) => Promise<FolderMutationResult>;
    createFolder: (parentDirectory: string, name: string) => Promise<FolderMutationResult>;
    renamePath: (sourcePath: string, name: string) => Promise<FolderMutationResult>;
    revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>;
    watchDir: (dirPath: string) => Promise<FolderWatchResult>;
    unwatchDir: (dirPath: string) => Promise<FolderWatchResult>;
    onDirChange: (cb: (dirPath: string) => void) => () => void;
};

export type FolderMutationEntry = {
    name: string;
    path: string;
    kind: 'file' | 'directory';
    size: number;
};

export type FolderMutationResult = {
    ok: boolean;
    entry?: FolderMutationEntry;
    error?: string;
    code?: string;
};

export type FolderMoveResult = {
    ok: boolean;
    moved?: { from: string; to: string; name: string; kind: 'file' | 'directory' };
    error?: string;
    code?: string;
};

export type FolderWatchResult = {
    ok: boolean;
    error?: string;
};

export type DroppedPathEntry = {
    name: string;
    path: string;
    kind: 'file' | 'directory';
};

export type DragDropBridgeApi = {
    resolveDroppedItems: (files: File[]) => Promise<{ ok: boolean; entries?: DroppedPathEntry[]; rejected?: Array<{ path: string; reason: string }>; error?: string }>;
};

export type ShortcutBridgeApi = {
    onAction: (cb: (action: DashboardShortcutAction) => void) => () => void;
};

export type TrayRemindersBridgeApi = {
    popUpMenu: () => void;
    openDashboard?: (() => void) | undefined;
};

export type BrowserWebviewTabState = {
    tabId: string;
    webContentsId: number;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    devToolsOpen?: boolean;
    devToolsTargetId?: string;
    sharedWithAgent?: boolean;
    /** v4 compatibility flag: Manager Browser actions are allowed by default. */
    actionsEnabled?: boolean;
    /** v5: native element inspect mode is active on this tab. */
    inspecting?: boolean;
    crashed?: boolean;
    error?: string;
    favicons?: string[];
    zoomFactor?: number;
    /** 'auto': fit-to-width manages zoomFactor; 'manual': user zoom wins. */
    zoomMode?: 'auto' | 'manual';
};

/** v5: element resolved from the native inspect pick (CDP DOM/AX domains). */
export type BrowserPickedElement = {
    selector: string;
    tagName: string;
    role: string | null;
    name: string | null;
    text: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
};

/** v5: bounded accessibility snapshot node. */
export type BrowserDomSnapshotNode = {
    tag: string;
    role: string | null;
    name: string | null;
    text: string | null;
    selector: string;
    bounds: { x: number; y: number; width: number; height: number } | null;
};

/** v4: interactive action payload dispatched through CDP Input domain. */
export type BrowserActPayload =
    | { kind: 'click'; x: number; y: number }
    | { kind: 'type'; text: string }
    | { kind: 'scroll'; x: number; y: number; deltaY: number }
    | { kind: 'key'; key: string };

export type BrowserWebviewCommand =
    | { kind: 'navigate'; tabId: string; url: string }
    | { kind: 'reload'; tabId: string; ignoreCache?: boolean }
    | { kind: 'goBack'; tabId: string }
    | { kind: 'goForward'; tabId: string }
    | { kind: 'stop'; tabId: string }
    | { kind: 'zoomIn'; tabId: string }
    | { kind: 'zoomOut'; tabId: string }
    | { kind: 'zoomReset'; tabId: string }
    | { kind: 'fitToWidth'; tabId: string };

export type BrowserWebviewNativeAction =
    | { kind: 'openExternal'; tabId: string }
    | { kind: 'openDevTools'; tabId: string; mode?: 'right' | 'bottom' | 'detach' }
    | { kind: 'closeDevTools'; tabId: string }
    | { kind: 'captureScreenshot'; tabId: string }
    | { kind: 'inspectElement'; tabId: string; x: number; y: number }
    | { kind: 'setSharedWithAgent'; tabId: string; shared: boolean }
    // v5 native inspect + snapshot
    | { kind: 'startInspect'; tabId: string }
    | { kind: 'stopInspect'; tabId: string }
    | { kind: 'getDomSnapshot'; tabId: string }
    // v4 interactive actions; setActionsEnabled remains for older renderers.
    | { kind: 'setActionsEnabled'; tabId: string; enabled: boolean }
    | { kind: 'act'; tabId: string; act: BrowserActPayload };

export type BrowserWebviewScreenshot = {
    tabId: string;
    url: string;
    title: string;
    capturedAt: string;
    width: number;
    height: number;
    dataUrl: string;
};

export type BrowserBridgeApi = {
    onOpenUrl: (cb: (payload: { url: string; disposition: 'current-tab' | 'new-tab' }) => void) => () => void;
    // Embedded webview target bridge (030 v1). Optional so older shell builds
    // without the bridge keep working; callers must guard.
    registerWebview?: (input: { tabId: string; webContentsId: number }) => Promise<{ ok: boolean; state?: BrowserWebviewTabState; error?: string }>;
    unregisterWebview?: (input: { tabId: string; webContentsId?: number }) => Promise<{ ok: boolean; error?: string }>;
    controlWebview?: (command: BrowserWebviewCommand) => Promise<{ ok: boolean; state?: BrowserWebviewTabState; error?: string }>;
    performWebviewAction?: (action: BrowserWebviewNativeAction) => Promise<{ ok: boolean; state?: BrowserWebviewTabState; screenshot?: BrowserWebviewScreenshot; snapshot?: BrowserDomSnapshotNode[]; error?: string }>;
    getWebviewTabs?: () => Promise<{ ok: boolean; tabs?: BrowserWebviewTabState[]; error?: string }>;
    onWebviewState?: (cb: (state: BrowserWebviewTabState) => void) => () => void;
    onElementPicked?: (cb: (payload: { tabId: string; element: BrowserPickedElement }) => void) => () => void;
};

export type ClipboardBridgeApi = {
    writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
};

export type PermissionDenial = {
    at: string;
    surface: 'manager-window' | 'preview-frame' | 'embedded-browser-webview';
    permission: string;
    requestingUrl: string;
    reason: string;
};

export type PermissionDiagnosticsBridgeApi = {
    getLastDenials: () => Promise<{ ok: boolean; denials?: PermissionDenial[]; error?: string }>;
};

export type DesktopWindowBridgeApi = {
    getFullscreenState?: () => boolean;
    onFullscreenStateChange?: (cb: (fullscreen: boolean) => void) => () => void;
};

export type DesktopShellCapability = 'terminal' | 'diff' | 'git' | 'folder' | 'shortcuts' | 'browser' | 'clipboard' | 'permissions';

/**
 * Electron shell-only bridge.
 *
 * Jawsidian notes and graph data must continue to flow through the dashboard
 * HTTP APIs so the web dashboard and Electron render the same vault index.
 * These capabilities are host integrations, not graph connectivity sources.
 */
export type CliJawDesktopApi = {
    identify: () => { name: string; electron: boolean; header: string };
    getMetrics: () => unknown;
    getHomePath?: (() => string) | undefined;
    terminal?: TerminalBridgeApi | undefined;
    diff?: DiffBridgeApi | undefined;
    git?: GitBridgeApi | undefined;
    folder?: FolderBridgeApi | undefined;
    dragDrop?: DragDropBridgeApi | undefined;
    clipboard?: ClipboardBridgeApi | undefined;
    permissions?: PermissionDiagnosticsBridgeApi | undefined;
    shortcuts?: ShortcutBridgeApi | undefined;
    trayReminders?: TrayRemindersBridgeApi | undefined;
    browser?: BrowserBridgeApi | undefined;
    reloadWindow?: (() => void) | undefined;
    hardReloadWindow?: (() => void) | undefined;
    window?: DesktopWindowBridgeApi | undefined;
};

export function getDesktop(): CliJawDesktopApi | null {
    return (window as unknown as { cliJawDesktop?: CliJawDesktopApi }).cliJawDesktop ?? null;
}

function hasDesktopDocumentMarker(): boolean {
    if (typeof document === 'undefined') return false;
    return document.documentElement.dataset['cliJawDesktop'] === 'true';
}

function hasDesktopUserAgent(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /\bcli-jaw-desktop(?:\/|\b)/.test(navigator.userAgent);
}

export function isElectron(): boolean {
    return getDesktop()?.identify?.()?.electron === true || hasDesktopDocumentMarker() || hasDesktopUserAgent();
}
