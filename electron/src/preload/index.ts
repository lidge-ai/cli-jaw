import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { getLatestMetrics, setupMetricsBridge } from './metrics.js';

const DESKTOP_IDENTITY = {
  name: 'cli-jaw-desktop',
  electron: true,
  header: 'X-CLI-Jaw-Electron',
  token: process.env.CLI_JAW_ELECTRON_RENDERER_TOKEN ?? '',
} as const;

function isSameOrigin(input: RequestInfo | URL): boolean {
  try {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawUrl, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function installDesktopFetchHeader(): void {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isSameOrigin(input)) return nativeFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (DESKTOP_IDENTITY.token) headers.set(DESKTOP_IDENTITY.header, DESKTOP_IDENTITY.token);
    return nativeFetch(input, { ...init, headers });
  };
}

function markDesktopDocument(): void {
  try {
    const root = document?.documentElement;
    if (root) {
      root.dataset.cliJawDesktop = 'true';
      root.dataset.cliJawPlatform = process.platform;
      return;
    }
    // Guest webviews can run this preload before documentElement exists.
    document?.addEventListener?.('DOMContentLoaded', () => {
      try {
        document.documentElement.dataset.cliJawDesktop = 'true';
        document.documentElement.dataset.cliJawPlatform = process.platform;
      } catch { /* ignore */ }
    }, { once: true });
  } catch (err) {
    console.warn('[cli-jaw-desktop] failed to mark desktop document', err);
  }
}

function getHomePath(): string {
  try {
    return process.env.HOME || process.env.USERPROFILE || '';
  } catch {
    return '';
  }
}

let cachedFullscreen = false;
const fullscreenListeners = new Set<(value: boolean) => void>();

function setCachedFullscreen(value: boolean): void {
  cachedFullscreen = value === true;
  for (const listener of fullscreenListeners) listener(cachedFullscreen);
}

void ipcRenderer.invoke('window:get-fullscreen').then((value) => {
  setCachedFullscreen(value === true);
}).catch(() => { /* manager origin not ready */ });

ipcRenderer.on('window:fullscreen-changed', (_event, value: unknown) => {
  setCachedFullscreen(value === true);
});

contextBridge.exposeInMainWorld('cliJawDesktop', {
  identify: () => DESKTOP_IDENTITY,
  getMetrics: () => getLatestMetrics(),
  getHomePath,
  terminal: {
    list: () => ipcRenderer.invoke('terminal:list'),
    create: (opts?: { cwd?: string; cols?: number; rows?: number }) => ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
    onData: (cb: (id: string, data: string) => void) => {
      const handler = (_e: unknown, id: string, data: string) => cb(id, data);
      ipcRenderer.on('terminal:data', handler);
      return () => { ipcRenderer.removeListener('terminal:data', handler); };
    },
    onExit: (cb: (id: string, code: number | null) => void) => {
      const handler = (_e: unknown, id: string, code: number | null) => cb(id, code);
      ipcRenderer.on('terminal:exit', handler);
      return () => { ipcRenderer.removeListener('terminal:exit', handler); };
    },
  },
  diff: {
    getRepoRoot: (cwd: string) => ipcRenderer.invoke('diff:getRepoRoot', cwd),
    getRepoCandidates: (candidates: Array<{ path: string; label: string; source: string }>) => ipcRenderer.invoke('diff:getRepoCandidates', candidates),
    getScmSnapshot: (repoRoot: string, options?: { includeUntracked?: boolean }) => ipcRenderer.invoke('diff:getScmSnapshot', repoRoot, options),
    runScmOperation: (repoRoot: string, operation: { kind: 'stage' | 'unstage'; paths: string[] }) => ipcRenderer.invoke('diff:runScmOperation', repoRoot, operation),
    getDiffSummary: (repoRoot: string, options: { mode: string; ref?: string; includeUntracked?: boolean }) => ipcRenderer.invoke('diff:getDiffSummary', repoRoot, options),
    getFileDiff: (repoRoot: string, filePath: string, options: { mode: string; ref?: string; includeUntracked?: boolean }) => ipcRenderer.invoke('diff:getFileDiff', repoRoot, filePath, options),
  },
  git: {
    getStatusMap: (folderPanelRoot: string, repoRoot?: string, options?: { includeIgnored?: boolean; includeUntracked?: boolean }) =>
      ipcRenderer.invoke('git:getStatusMap', folderPanelRoot, repoRoot, options),
    getWorktrees: (folderPanelRoot: string, repoRoot?: string) =>
      ipcRenderer.invoke('git:getWorktrees', folderPanelRoot, repoRoot),
    previewWorktreeOperation: (folderPanelRoot: string, repoRoot: string | undefined, operation: unknown) =>
      ipcRenderer.invoke('git:previewWorktreeOperation', folderPanelRoot, repoRoot, operation),
    runWorktreeOperation: (folderPanelRoot: string, repoRoot: string | undefined, operation: unknown, confirmed: boolean) =>
      ipcRenderer.invoke('git:runWorktreeOperation', folderPanelRoot, repoRoot, operation, confirmed),
  },
  folder: {
    getDefaultRoot: () => ipcRenderer.invoke('folder:getDefaultRoot'),
    pickFolder: () => ipcRenderer.invoke('folder:pick'),
    pickFile: () => ipcRenderer.invoke('folder:pickFile'),
    authorizeRoot: (rootPath: string) => ipcRenderer.invoke('folder:authorizeRoot', rootPath),
    registerGitWorktreeRoot: (folderPanelRoot: string, repoRoot: string | undefined, worktreePath: string) =>
      ipcRenderer.invoke('folder:registerGitWorktreeRoot', folderPanelRoot, repoRoot, worktreePath),
    listDir: (dirPath: string, depth?: number) => ipcRenderer.invoke('folder:listDir', dirPath, depth),
    readFile: (filePath: string) => ipcRenderer.invoke('folder:readFile', filePath),
    movePath: (sourcePath: string, targetDirectory: string) => ipcRenderer.invoke('folder:movePath', sourcePath, targetDirectory),
    createFile: (parentDirectory: string, name: string) => ipcRenderer.invoke('folder:createFile', parentDirectory, name),
    createFolder: (parentDirectory: string, name: string) => ipcRenderer.invoke('folder:createFolder', parentDirectory, name),
    renamePath: (sourcePath: string, name: string) => ipcRenderer.invoke('folder:renamePath', sourcePath, name),
    revealPath: (path: string) => ipcRenderer.invoke('folder:revealPath', path),
    watchDir: (dirPath: string) => ipcRenderer.invoke('folder:watchDir', dirPath),
    unwatchDir: (dirPath: string) => ipcRenderer.invoke('folder:unwatchDir', dirPath),
    onDirChange: (cb: (dirPath: string) => void) => {
      const handler = (_e: unknown, dirPath: string) => cb(dirPath);
      ipcRenderer.on('folder:changed', handler);
      return () => { ipcRenderer.removeListener('folder:changed', handler); };
    },
  },
  dragDrop: {
    resolveDroppedItems: (files: File[]) => {
      const paths = Array.from(files || [])
        .map(file => {
          try {
            return webUtils.getPathForFile(file);
          } catch {
            return '';
          }
        })
        .filter(path => path.trim().length > 0);
      return ipcRenderer.invoke('folder:resolveDroppedItems', paths);
    },
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  },
  permissions: {
    getLastDenials: () => ipcRenderer.invoke('permissions:getLastDenials'),
  },
  shortcuts: {
    onAction: (cb: (action: string) => void) => {
      const handler = (_e: unknown, action: string) => cb(action);
      ipcRenderer.on('manager:shortcut', handler);
      return () => { ipcRenderer.removeListener('manager:shortcut', handler); };
    },
  },
  trayReminders: {
    popUpMenu: () => ipcRenderer.send('tray:popup-menu'),
    openDashboard: () => ipcRenderer.send('tray:open-dashboard'),
  },
  browser: {
    onOpenUrl: (cb: (payload: { url: string; disposition: 'current-tab' | 'new-tab' }) => void) => {
      const handler = (_e: unknown, payload: { url: string; disposition: 'current-tab' | 'new-tab' }) => cb(payload);
      ipcRenderer.on('browser:open-url', handler);
      return () => { ipcRenderer.removeListener('browser:open-url', handler); };
    },
    registerWebview: (input: { tabId: string; webContentsId: number }) => ipcRenderer.invoke('browser:register-webview', input),
    unregisterWebview: (input: { tabId: string; webContentsId?: number }) => ipcRenderer.invoke('browser:unregister-webview', input),
    controlWebview: (command: unknown) => ipcRenderer.invoke('browser:control-webview', command),
    performWebviewAction: (action: unknown) => ipcRenderer.invoke('browser:perform-webview-action', action),
    getWebviewTabs: () => ipcRenderer.invoke('browser:get-webview-tabs'),
    onElementPicked: (cb: (payload: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on('browser:element-picked', handler);
      return () => { ipcRenderer.removeListener('browser:element-picked', handler); };
    },
    onWebviewState: (cb: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => cb(state);
      ipcRenderer.on('browser:webview-state', handler);
      return () => { ipcRenderer.removeListener('browser:webview-state', handler); };
    },
  },
  reloadWindow: () => ipcRenderer.invoke('window:reload'),
  hardReloadWindow: () => ipcRenderer.invoke('window:hardReload'),
  window: {
    getFullscreenState: () => cachedFullscreen,
    onFullscreenStateChange: (cb: (value: boolean) => void) => {
      fullscreenListeners.add(cb);
      cb(cachedFullscreen);
      return () => { fullscreenListeners.delete(cb); };
    },
  },
});

markDesktopDocument();
installDesktopFetchHeader();
setupMetricsBridge();
