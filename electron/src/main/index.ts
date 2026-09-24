import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, screen, session, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import electronUpdater from 'electron-updater';
import { fileURLToPath, URL } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { readIsolatedQaPolicy, isolatedQaEnvironment } from '../../../src/shared/isolated-qa.js';
import { applyIsolatedQaPaths } from './lib/qa-session.js';
import { findJawBinary, spawnJawDashboard, gracefulShutdown } from './lib/jaw-spawn.js';
import { promptInstallCli } from './lib/install-cli.js';
import {
  createTray, isKeepRunning, destroyTray,
  updateServerStatus, notifyServerCrash, setTrayBadge,
  setTrayClickHandler, popUpTrayMenu, getTrayBoundsSafe,
} from './lib/tray-manager.js';
import { createReminderPopover, type ReminderPopover } from './lib/reminder-popover.js';
import { createReminderBadgePoller, type ReminderBadgePoller } from './lib/reminder-badge.js';
import { waitForManagerReady, isManagerHealthy, probeOnce } from './lib/health-check.js';
import {
  buildManagerCsp,
  buildPreviewFrameOrigins,
  externalOpenUrlForNavigation,
  isManagerNavigation,
  isPreviewFrameNavigation,
  normalizeExternalOpenUrl,
} from './lib/navigation-policy.js';
import {
  previewSpawnEnvForManager,
  resolvePreviewFramePolicyForManager,
} from './lib/preview-ports.js';
import {
  showJawNotFoundDialog,
  showCrashLoopDialog,
  showSpawnFailedDialog,
} from './lib/dialog.js';
import {
  extractJawUrlArg,
  focusWindow,
  registerJawProtocol,
  routeJawDeepLink,
} from './lib/deep-link.js';
import { RingBuffer } from './lib/ring-buffer.js';
import { startAppMetricsCollector, type MetricsCollectorHandle } from './lib/app-metrics.js';
import { registerTerminalIpc, cleanupTerminals } from './lib/terminal/index.js';
import { registerDiffIpc } from './lib/git/ipc.js';
import { registerFolderIpc, cleanupFolderWatchers } from './lib/folder/ipc.js';
import { registerBrowserIpc, markOwnedEmbeddedBrowserWebContents } from './lib/browser/ipc.js';
import { registerClipboardIpc } from './lib/clipboard/ipc.js';
import { registerPermissionDiagnosticsIpc } from './lib/permission-diagnostics/ipc.js';
import { broadcastFullscreenChanged, registerWindowIpc } from './lib/window/ipc.js';
import { resolveWindowChromeOptions } from './lib/window/chrome-options.js';
import { isAllowedSender, setAllowedOrigin } from './lib/ipc-origin-guard.js';
import { primeMacAutomationPermission } from './lib/mac-automation-permission.js';
import { showQuitProgress } from './lib/quit-progress.js';
import {
  createAppUpdaterController,
  shouldEnableAppUpdater,
  type AppUpdaterController,
} from './lib/app-updater.js';
import {
  recordElectronPermissionDenial,
  resolveElectronPermissionDecision,
  type ElectronPermissionSurface,
} from './lib/electron-permissions.js';

interface CliFlags {
  port: number;
  attachOnly: boolean;
  spawn: boolean;
  background: boolean;
  managerUrl: string;
  managerUrlExplicit: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ELECTRON_MANAGER_PORT_START = 24577;
const ELECTRON_MANAGER_PORT_END = 24590;
const DEFAULT_MANAGER_PORT = ELECTRON_MANAGER_PORT_START;

function assertLoopbackManagerUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(`[jaw-electron] invalid manager URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[jaw-electron] manager URL must use http: or https:. Got: ${parsed.protocol}`,
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[jaw-electron] manager URL must be loopback (127.0.0.1, localhost, ::1). Got: ${parsed.hostname}`,
    );
  }
}

function parseArgs(argv: string[]): CliFlags {
  let port = Number(process.env.JAW_MANAGER_PORT ?? DEFAULT_MANAGER_PORT);
  let attachOnly = false;
  let spawn = false;
  let background = false;
  let managerUrl = process.env.JAW_MANAGER_URL ?? '';
  let managerUrlExplicit = managerUrl.trim().length > 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = argv[++i];
      if (v) port = Number(v);
    } else if (a?.startsWith('--port=')) {
      port = Number(a.slice('--port='.length));
    } else if (a === '--attach-only') {
      attachOnly = true;
    } else if (a === '--spawn') {
      spawn = true;
    } else if (a === '--manager-url') {
      const v = argv[++i];
      if (v) {
        managerUrl = v;
        managerUrlExplicit = true;
      }
    } else if (a?.startsWith('--manager-url=')) {
      managerUrl = a.slice('--manager-url='.length);
      managerUrlExplicit = managerUrl.trim().length > 0;
    } else if (a === '--background') {
      background = true;
    }
  }
  if (!Number.isFinite(port) || port <= 0) port = DEFAULT_MANAGER_PORT;
  if (!managerUrl) managerUrl = `http://127.0.0.1:${port}/`;
  if (!managerUrl.endsWith('/')) managerUrl = `${managerUrl}/`;
  assertLoopbackManagerUrl(managerUrl);
  return { port, attachOnly, spawn, background, managerUrl, managerUrlExplicit };
}

// Validate raw flags before the legacy parser can normalize invalid input. The
// shared owner alone parses the environment; this adapter checks CLI agreement.
function readQaFlags(argv: string[]): CliFlags | null {
  const policy = QA_POLICY;
  if (!policy) return null;
  let attachOnly = false;
  let spawn = false;
  let background = false;
  let explicitUrl = false;
  if (process.env.JAW_MANAGER_PORT !== undefined && process.env.JAW_MANAGER_PORT !== String(policy.managerPort)) {
    throw new Error('[isolated-qa] JAW_MANAGER_PORT: must match manager port');
  }
  if (process.env.JAW_MANAGER_URL !== undefined) {
    if (process.env.JAW_MANAGER_URL !== policy.managerUrl) throw new Error('[isolated-qa] JAW_MANAGER_URL: must match manager URL');
    explicitUrl = true;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg?.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice(7);
      if (raw !== String(policy.managerPort)) throw new Error('[isolated-qa] --port: must match manager port');
    } else if (arg === '--manager-url' || arg?.startsWith('--manager-url=')) {
      const raw = arg === '--manager-url' ? argv[++i] : arg.slice(14);
      if (raw !== policy.managerUrl) throw new Error('[isolated-qa] --manager-url: must match manager URL');
      explicitUrl = true;
    } else if (arg === '--attach-only') attachOnly = true;
    else if (arg === '--spawn') spawn = true;
    else if (arg === '--background') background = true;
  }
  if (!explicitUrl) throw new Error('[isolated-qa] --manager-url: explicit manager URL required');
  if (attachOnly && spawn) throw new Error('[isolated-qa] --attach-only: conflicts with --spawn');
  return { port: policy.managerPort, managerUrl: policy.managerUrl,
    managerUrlExplicit: true, attachOnly, spawn, background };
}

const QA_POLICY = readIsolatedQaPolicy(process.env, 'electron');
const FLAGS = readQaFlags(process.argv.slice(1)) ?? parseArgs(process.argv.slice(1));
const ELECTRON_RENDERER_TOKEN = randomBytes(32).toString('hex');
process.env.CLI_JAW_ELECTRON_RENDERER_TOKEN = ELECTRON_RENDERER_TOKEN;
const QA_ENV = QA_POLICY ? isolatedQaEnvironment(QA_POLICY, {
  ...process.env, CLI_JAW_ELECTRON_RENDERER_TOKEN: ELECTRON_RENDERER_TOKEN,
}) : null;
if (QA_POLICY) applyIsolatedQaPaths(app, QA_POLICY);
let MANAGER_URL = FLAGS.managerUrl;
let MANAGER_ORIGIN = new URL(MANAGER_URL).origin;
setAllowedOrigin(MANAGER_ORIGIN);
let PREVIEW_FRAME_POLICY = resolvePreviewFramePolicyForManager(getManagerUrlPort(MANAGER_URL), QA_ENV ?? process.env);

const DEV_TOOLS_ENABLED =
  process.env.NODE_ENV === 'development' || process.env.JAW_ELECTRON_DEVTOOLS === '1';
const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 960;
const WINDOW_WORK_AREA_MARGIN = 80;
const MIN_VISIBLE_WINDOW_WIDTH = 960;
const MIN_VISIBLE_WINDOW_HEIGHT = 640;
const QUIT_WINDOW_HIDE_DELAY_MS = 600;
const TRAY_REMINDERS_ACCELERATOR = 'CommandOrControl+Shift+M';

type ManagerShortcutAction =
  | 'toggleBottomPanel'
  | 'toggleRightPanel'
  | 'focusTerminal'
  | 'newTerminalSession'
  | 'openDiff'
  | 'openFolderTree'
  | 'closeFocusedTab'
  | 'switchTab1'
  | 'switchTab2'
  | 'switchTab3'
  | 'previousTab'
  | 'nextTab'
  | 'browserReload'
  | 'browserHardReload'
  | 'browserFocusUrl'
  | 'browserBack'
  | 'browserForward'
  | 'terminalClear'
  | 'terminalNewTab'
  | 'toggleLeftSidebar'
  | 'resetSidebarWidth';

type DesktopKeyboardInput = {
  type?: string;
  key?: string;
  code?: string;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
  shift?: boolean;
  control?: boolean;
  alt?: boolean;
  meta?: boolean;
};

const ringBuffer = new RingBuffer(1024 * 1024);
let managerProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let rendererCrashReloads: number[] = [];
let pendingDeepLinkUrl: string | null = null;
let restartTimestamps: number[] = [];
let crashLoopStopped = false;
let shuttingDown = false;
let shutdownComplete = false;
let qaCleanupUncertain = false;
let forceQuitRequested = false;
let managerRestarting = false;
let windowCreating = false;
let bootstrapPromise: Promise<void> | null = null;
let shutdownPreparationPromise: Promise<boolean> | null = null;
let managerReadyPromise: Promise<void> | null = null;
let metricsCollector: MetricsCollectorHandle | null = null;
let webContentsHardeningRegistered = false;
let reminderPopover: ReminderPopover | null = null;
let reminderBadgePoller: ReminderBadgePoller | null = null;
let trayPopupMenuIpcRegistered = false;
let trayRemindersShortcutRegistered = false;
let appUpdaterController: AppUpdaterController | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRELOAD_PATH = join(__dirname, '..', 'preload', 'index.js');
const DESKTOP_USER_AGENT_TOKEN = 'cli-jaw-desktop';
const EMBEDDED_BROWSER_PARTITION = 'persist:cli-jaw-browser';

// #229: the webview tag sets a clean per-webview UA, but service workers and other
// background requests in the partition fall back to the session UA, which carries the
// Electron/cli-jaw tokens that search providers flag. Pin the whole session to a plain
// Chrome UA (same shape the renderer builds) plus real Accept-Language so the embedded
// browser presents one consistent, ordinary-browser fingerprint.
function embeddedBrowserUserAgent(): string {
  const chromeVersion = process.versions.chrome;
  const osToken = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function embeddedBrowserAcceptLanguages(): string {
  let preferred: string[] = [];
  try {
    preferred = app.getPreferredSystemLanguages();
  } catch {
    // fall through to defaults
  }
  return [...new Set([...preferred, 'en-US', 'en'])].join(',');
}

function configureEmbeddedBrowserSession(): void {
  const ses = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
  const userAgent = embeddedBrowserUserAgent();
  ses.setUserAgent(userAgent, embeddedBrowserAcceptLanguages());
  // setUserAgent does NOT cover service-worker-initiated fetches — a runtime probe
  // showed they fall back to the Electron-flavored app UA.
  // Force the header at the network layer for every request in this partition.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = userAgent;
    callback({ requestHeaders: details.requestHeaders });
  });
}
const AUTOMATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.enableSandbox();
  if (!QA_POLICY) registerJawProtocol(app);

  app.on('second-instance', (_event, argv) => {
    const deepLink = extractJawUrlArg(argv);
    if (deepLink) {
      void handleDeepLink(deepLink);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createManagerWindow();
    } else {
      focusWindow(mainWindow);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    configureEmbeddedBrowserSession();
    initializeAppUpdater();
    await bootstrapOnce();
    appUpdaterController?.start();
    if (!QA_POLICY) promptInstallCli().catch(() => {});
    if (!metricsCollector) {
      try {
        metricsCollector = startAppMetricsCollector();
      } catch (err) {
        ringBuffer.append(`[metrics start error] ${(err as Error)?.message ?? err}\n`);
      }
    }
    if (pendingDeepLinkUrl) {
      const pending = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      await handleDeepLink(pending);
    }

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        void createManagerWindow();
      }
    });
  }).catch((err) => {
    console.error('[jaw-electron] bootstrap failed', err);
    dialog.showErrorBox('jaw Electron', String(err?.stack ?? err));
    app.quit();
  });
}

function getInitialWindowBounds(): { width: number; height: number; x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const maxWidth = Math.max(MIN_VISIBLE_WINDOW_WIDTH, workArea.width - WINDOW_WORK_AREA_MARGIN);
  const maxHeight = Math.max(MIN_VISIBLE_WINDOW_HEIGHT, workArea.height - WINDOW_WORK_AREA_MARGIN);
  const width = Math.min(DEFAULT_WINDOW_WIDTH, maxWidth);
  const height = Math.min(DEFAULT_WINDOW_HEIGHT, maxHeight);
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

app.on('window-all-closed', () => {
  if (isKeepRunning()) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  if (isKeepRunning() && !forceQuitRequested) {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return;
  }
  event.preventDefault();
  void requestApplicationQuit('before-quit');
});

async function requestApplicationQuit(reason: string): Promise<void> {
  if (shutdownComplete) {
    app.exit(0);
    return;
  }
  const prepared = await prepareApplicationShutdown(reason);
  if (prepared) app.exit(0);
}

async function prepareApplicationShutdown(reason: string): Promise<boolean> {
  if (shutdownComplete) return true;
  if (shutdownPreparationPromise) return shutdownPreparationPromise;
  shuttingDown = true;
  shutdownPreparationPromise = (async () => {
    appUpdaterController?.dispose();
    appUpdaterController = null;
    destroyTrayReminders();
    destroyTray();
    ringBuffer.append(`[quit] requested by ${reason}\n`);
    showQuitProgress(mainWindow, ringBuffer);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || shutdownComplete) return;
      mainWindow.hide();
    }, QUIT_WINDOW_HIDE_DELAY_MS);
    if (metricsCollector) {
      try {
        metricsCollector.stop();
      } catch {
        // ignore
      }
      metricsCollector = null;
    }
    cleanupTerminals();
    cleanupFolderWatchers();
    try {
      // #229: cookies persist via the partition, but an explicit flush protects
      // fresh logins from being lost when quit follows shortly after sign-in.
      // Raced against a short timeout so a pathological cookie-store hang can
      // never delay application quit.
      await Promise.race([
        session.fromPartition(EMBEDDED_BROWSER_PARTITION).cookies.flushStore(),
        new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
      ]);
    } catch {
      // best-effort — quit must not block on cookie flush
    }
    const child = managerProcess;
    if (!QA_POLICY) managerProcess = null;
    try {
      if (child) await gracefulShutdown(child, 5000, QA_POLICY);
      if (QA_POLICY && qaCleanupUncertain) throw new Error('[isolated-qa] prior cleanup remains uncertain');
      managerProcess = null;
      shutdownComplete = true;
      return true;
    } catch (err) {
      if (!QA_POLICY) {
        shutdownComplete = true;
        ringBuffer.append(`[quit cleanup error] ${(err as Error)?.message ?? err}\n`);
        return true;
      }
      reportQaCleanupUncertain(err);
      shuttingDown = false;
      return false;
    }
  })().finally(() => {
    if (!shutdownComplete) shutdownPreparationPromise = null;
  });
  return shutdownPreparationPromise;
}

async function prepareForUpdateInstall(): Promise<void> {
  forceQuitRequested = true;
  const prepared = await prepareApplicationShutdown('update-install');
  if (!prepared) throw new Error('cli-jaw could not safely stop its bundled server');
}

function initializeAppUpdater(): void {
  if (appUpdaterController) return;
  const { autoUpdater } = electronUpdater;
  appUpdaterController = createAppUpdaterController({
    updater: autoUpdater,
    enabled: shouldEnableAppUpdater({
      platform: process.platform,
      isPackaged: app.isPackaged,
      isolatedQa: QA_POLICY !== null,
      disabledByEnvironment: process.env.JAW_DISABLE_AUTO_UPDATE === '1',
    }),
    currentVersion: app.getVersion(),
    showMessageBox: options => dialog.showMessageBox(options),
    prepareForUpdateInstall,
    log: message => ringBuffer.append(`${message}\n`),
  });
}

function reportQaCleanupUncertain(error: unknown): void {
  qaCleanupUncertain = true;
  crashLoopStopped = true;
  stopTrayReminderBadgePolling();
  const message = `[isolated-qa] cleanup uncertain; retain task profile. ${(error as Error)?.message ?? 'unknown completion'}`;
  ringBuffer.append(`${message}\n`);
  console.error(message);
  updateServerStatus('QA cleanup uncertain — supervisor required');
  dialog.showErrorBox('Isolated QA cleanup uncertain', message);
}

async function forceQuit(): Promise<void> {
  forceQuitRequested = true;
  destroyTrayReminders();
  destroyTray();
  void requestApplicationQuit('tray-quit');
}

function installTrayReminders(): void {
  reminderPopover?.destroy();
  reminderBadgePoller?.stop();
  reminderPopover = createReminderPopover({
    managerUrl: MANAGER_URL,
    managerOrigin: MANAGER_ORIGIN,
    preloadPath: PRELOAD_PATH,
  });
  reminderBadgePoller = createReminderBadgePoller({
    managerUrl: MANAGER_URL,
    setBadge: setTrayBadgeFromReminderPoller,
    log: (message) => ringBuffer.append(`${message}\n`),
  });
  setTrayClickHandler(toggleTrayRemindersPopover);
  registerTrayRemindersShortcut();
  if (!trayPopupMenuIpcRegistered) {
    trayPopupMenuIpcRegistered = true;
    ipcMain.on('tray:popup-menu', (event) => {
      if (!isAllowedSender(event)) return;
      popUpTrayMenu();
    });
    ipcMain.on('tray:open-dashboard', (event) => {
      if (!isAllowedSender(event)) return;
      void openTrayRemindersDashboard();
    });
  }
}

function destroyTrayReminders(): void {
  unregisterTrayRemindersShortcut();
  reminderBadgePoller?.stop();
  reminderBadgePoller = null;
  reminderPopover?.destroy();
  reminderPopover = null;
}

function toggleTrayRemindersPopover(): void {
  reminderPopover?.toggle(getTrayBoundsSafe());
  refreshTrayReminderBadge();
}

function registerTrayRemindersShortcut(): void {
  if (QA_POLICY) return;
  if (trayRemindersShortcutRegistered) return;
  const registered = globalShortcut.register(TRAY_REMINDERS_ACCELERATOR, toggleTrayRemindersPopover);
  if (!registered) {
    ringBuffer.append('[tray-reminders] shortcut registration failed\n');
    return;
  }
  trayRemindersShortcutRegistered = true;
}

function unregisterTrayRemindersShortcut(): void {
  if (!trayRemindersShortcutRegistered) return;
  globalShortcut.unregister(TRAY_REMINDERS_ACCELERATOR);
  trayRemindersShortcutRegistered = false;
}

function setTrayBadgeFromReminderPoller(count: number): void {
  if (shuttingDown || shutdownComplete || crashLoopStopped) return;
  setTrayBadge(count);
}

function refreshTrayReminderBadge(): void {
  void reminderBadgePoller?.refreshNow();
}

function trayRemindersDashboardUrl(): string {
  return new URL('/?sidebar=reminders', MANAGER_URL).toString();
}

async function openTrayRemindersDashboard(): Promise<void> {
  await createManagerWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadURL(trayRemindersDashboardUrl());
    focusWindow(mainWindow);
    reminderPopover?.hide();
  } catch (err) {
    ringBuffer.append(`[tray-reminders] open dashboard failed: ${(err as Error)?.message ?? err}\n`);
  }
}

function startTrayReminderBadgePolling(): void {
  reminderBadgePoller?.start();
}

function stopTrayReminderBadgePolling(): void {
  reminderBadgePoller?.stop();
}

function markManagerRunning(status = 'Server: Running'): void {
  updateServerStatus(status);
  startTrayReminderBadgePolling();
  refreshTrayReminderBadge();
}

async function createManagerWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (windowCreating) return;
  windowCreating = true;
  try {
    await createWindow();
    markManagerRunning();
    if (!metricsCollector) {
      try {
        metricsCollector = startAppMetricsCollector();
      } catch (err) {
        ringBuffer.append(`[metrics restart error] ${(err as Error)?.message ?? err}\n`);
      }
    }
  } catch (err) {
    ringBuffer.append(`[createManagerWindow error] ${(err as Error)?.message ?? err}\n`);
    updateServerStatus('Server: Unreachable');
  } finally {
    windowCreating = false;
  }
}

async function restartManagerServer(): Promise<void> {
  if (QA_POLICY && qaCleanupUncertain) return;
  managerRestarting = true;
  stopTrayReminderBadgePolling();
  updateServerStatus('Server: Restarting...');
  const child = managerProcess;
  if (!QA_POLICY) managerProcess = null;
  try {
    if (child) {
      if (QA_POLICY) child.removeListener('exit', handleManagerExit);
      else child.removeAllListeners('exit');
      await gracefulShutdown(child, 5000, QA_POLICY);
    }
    managerProcess = null;
    await ensureManagerRunning();
    markManagerRunning();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(MANAGER_URL);
    }
  } catch (err) {
    if (QA_POLICY) reportQaCleanupUncertain(err);
    ringBuffer.append(`[restart error] ${(err as Error)?.message ?? err}\n`);
    stopTrayReminderBadgePolling();
    updateServerStatus('Server: Restart failed');
    notifyServerCrash();
  } finally {
    managerRestarting = false;
  }
}

// bootstrapOnce() clears its promise in .finally(), so a deep link arriving
// after a failed bootstrap re-runs this body. ipcMain.handle() throws on a
// duplicate channel, which would reject the second bootstrap mid-way and leave
// the app partially initialized. Register the IPC surface exactly once.
let ipcSurfaceRegistered = false;

async function bootstrap(): Promise<void> {
  installManagerApplicationMenu();
  installSecurityHeaders(MANAGER_ORIGIN);
  installDefaultSessionPermissionHandlers();

  if (!ipcSurfaceRegistered) {
    ipcSurfaceRegistered = true;
    registerTerminalIpc(() => mainWindow);
    registerDiffIpc();
    registerFolderIpc(() => mainWindow);
    registerBrowserIpc({
      getManagerWindow: () => mainWindow,
      normalizeEmbeddedBrowserUrl: normalizeAllowedEmbeddedBrowserUrl,
      isAllowedEmbeddedBrowserUrl,
      openExternalNavigation,
    });
    registerClipboardIpc();
    registerPermissionDiagnosticsIpc();
    registerWindowIpc();
  }

  createTray({
    onOpenDashboard: () => {
      void createManagerWindow();
    },
    onRestartServer: () => {
      void restartManagerServer();
    },
    onQuit: () => {
      void forceQuit();
    },
    getManagerUrl: () => MANAGER_URL,
  }, QA_POLICY);

  await ensureManagerRunning();
  installTrayReminders();
  markManagerRunning();
  if (FLAGS.background) {
    markManagerRunning('Server: Running (background)');
  } else {
    await createManagerWindow();
  }
  if (!QA_POLICY) primeMacAutomationPermission({
    log: ringBuffer,
    onBlocked: showAutomationPermissionDialog,
  });
}

function showAutomationPermissionDialog(reason: string): void {
  if (QA_POLICY) return;
  void dialog.showMessageBox({
    type: 'warning',
    title: 'cli-jaw Automation permission',
    message: 'macOS Automation permission is not ready.',
    detail: [
      'cli-jaw tried to request Automation access for Computer Use, but macOS did not complete the prompt.',
      '',
      `Reason: ${reason}`,
      '',
      'Open System Settings > Privacy & Security > Automation and enable cli-jaw for System Events and Google Chrome when it appears.',
    ].join('\n'),
    buttons: ['Open Automation Settings', 'OK'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response !== 0) return;
    void shell.openExternal(AUTOMATION_SETTINGS_URL);
  }).catch((err) => {
    ringBuffer.append(`[automation permission dialog error] ${(err as Error).message}\n`);
  });
}

function bootstrapOnce(): Promise<void> {
  if (shuttingDown || shutdownComplete) return Promise.resolve();
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

async function handleDeepLink(raw: string): Promise<void> {
  if (!app.isReady()) {
    pendingDeepLinkUrl = raw;
    return;
  }
  try {
    const routed = await routeJawDeepLink(raw, {
      managerUrl: MANAGER_URL,
      getWindow: () => mainWindow,
      ensureReady: bootstrapOnce,
    });
    if (!routed) focusWindow(mainWindow);
  } catch (err) {
    ringBuffer.append(`[deep-link error] ${(err as Error)?.message ?? err}\n`);
    focusWindow(mainWindow);
  }
}

function installSecurityHeaders(managerOrigin: string): void {
  const csp = buildManagerCsp(
    managerOrigin,
    buildPreviewFrameOrigins(PREVIEW_FRAME_POLICY),
  );

  const filter = { urls: [`${managerOrigin}/*`] };
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'content-security-policy' || lower === 'x-content-type-options') {
        delete headers[key];
      }
    }
    headers['Content-Security-Policy'] = [csp];
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers });
  });
}

function permissionRequestUrl(contents: Electron.WebContents | null, fallback?: string): string {
  return fallback || contents?.getURL() || MANAGER_URL;
}

function permissionSurfaceForUrl(raw: string): ElectronPermissionSurface {
  return isPreviewFrameNavigation(raw, PREVIEW_FRAME_POLICY) ? 'preview-frame' : 'manager-window';
}

function permissionMediaType(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const maybeMediaType = (details as { mediaType?: unknown }).mediaType;
  if (typeof maybeMediaType === 'string') return maybeMediaType;
  const maybeMediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
  if (Array.isArray(maybeMediaTypes)) {
    const first = maybeMediaTypes.find((value): value is string => typeof value === 'string');
    if (first) return first;
  }
  return undefined;
}

function isElectronPermissionAllowed(
  surface: ElectronPermissionSurface,
  permission: string,
  requestingUrl: string,
  mediaType?: string,
): boolean {
  const result = resolveElectronPermissionDecision({
    permission,
    requestingUrl,
    managerOrigin: MANAGER_ORIGIN,
    previewPolicy: PREVIEW_FRAME_POLICY,
    surface,
    ...(mediaType ? { mediaType } : {}),
  });
  if (result.decision === 'allow') return true;
  recordElectronPermissionDenial({
    surface,
    permission,
    requestingUrl,
    reason: result.reason,
  });
  ringBuffer.append(`[permission denied] ${surface} ${permission} ${requestingUrl}: ${result.reason}\n`);
  return false;
}

function installDefaultSessionPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const detailValues = details as { requestingUrl?: string } | undefined;
    const requestingUrl = permissionRequestUrl(contents, detailValues?.requestingUrl);
    callback(isElectronPermissionAllowed(
      permissionSurfaceForUrl(requestingUrl),
      String(permission),
      requestingUrl,
      permissionMediaType(details),
    ));
  });

  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const detailValues = details as { requestingUrl?: string; securityOrigin?: string } | undefined;
    const requestingUrl = permissionRequestUrl(
      contents,
      detailValues?.requestingUrl || detailValues?.securityOrigin || requestingOrigin,
    );
    return isElectronPermissionAllowed(
      permissionSurfaceForUrl(requestingUrl),
      String(permission),
      requestingUrl,
      permissionMediaType(details),
    );
  });
}

function isAllowedFrameNavigation(raw: string): boolean {
  return isManagerNavigation(raw, MANAGER_ORIGIN)
    || isPreviewFrameNavigation(raw, PREVIEW_FRAME_POLICY);
}

function normalizeAllowedEmbeddedBrowserUrl(raw: string): string | null {
  return normalizeExternalOpenUrl(raw);
}

function isAllowedEmbeddedBrowserUrl(raw: string): boolean {
  return normalizeAllowedEmbeddedBrowserUrl(raw) !== null;
}

function embeddedBrowserDisposition(disposition: string): 'current-tab' | 'new-tab' {
  return disposition === 'default' ? 'current-tab' : 'new-tab';
}

function sendEmbeddedBrowserOpenUrl(raw: string, disposition: string, sourceWebContentsId?: number): void {
  const url = normalizeAllowedEmbeddedBrowserUrl(raw);
  if (!url || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('browser:open-url', {
    url,
    disposition: embeddedBrowserDisposition(disposition),
    // Which guest requested the popup: lets the owning BrowserPanel handle it
    // instead of whichever panel currently holds handler priority.
    ...(typeof sourceWebContentsId === 'number' ? { sourceWebContentsId } : {}),
  });
}

function openExternalNavigation(raw: string): boolean {
  const url = externalOpenUrlForNavigation(raw, {
    managerOrigin: MANAGER_ORIGIN,
    ...PREVIEW_FRAME_POLICY,
  });
  if (!url) return false;
  void shell.openExternal(url).catch((err) => {
    ringBuffer.append(`[external open error] ${url}: ${(err as Error)?.message ?? err}\n`);
  });
  return true;
}

function hardenEmbeddedBrowserWebContents(contents: Electron.WebContents): void {
  if (contents.getType() !== 'webview') return;
  installDesktopShortcutForwarder(contents);
  contents.setWindowOpenHandler(({ url, disposition }) => {
    sendEmbeddedBrowserOpenUrl(url, disposition, contents.id);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedEmbeddedBrowserUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedEmbeddedBrowserUrl(url)) event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isElectronPermissionAllowed('embedded-browser-webview', String(permission), details.requestingUrl || wc.getURL()));
  });
  contents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => (
    isElectronPermissionAllowed('embedded-browser-webview', String(permission), details.requestingUrl || details.securityOrigin || requestingOrigin, details.mediaType)
  ));
}

function registerGlobalWebContentsHardening(): void {
  if (webContentsHardeningRegistered) return;
  webContentsHardeningRegistered = true;
  app.on('web-contents-created', (_event, contents) => {
    hardenEmbeddedBrowserWebContents(contents);
    if (contents.getType() === 'webview') {
      markOwnedEmbeddedBrowserWebContents(contents);
    }
  });
}

function isCode(input: DesktopKeyboardInput, code: string, fallbackKey: string): boolean {
  return input.code === code || String(input.key ?? '').toLowerCase() === fallbackKey;
}

function managerShortcutActionFromInput(input: DesktopKeyboardInput): ManagerShortcutAction | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing) return null;
  const ctrl = input.control === true;
  const meta = input.meta === true;
  const shift = input.shift === true;
  const alt = input.alt === true;

  if (ctrl && shift && !meta && !alt && isCode(input, 'Backquote', '`')) return 'newTerminalSession';
  if (ctrl && !meta && !shift && !alt && isCode(input, 'Backquote', '`')) return 'focusTerminal';
  if (meta && !ctrl && !shift && !alt && isCode(input, 'Backquote', '`')) return 'focusTerminal';
  if (meta && !ctrl && !shift && !alt && isCode(input, 'KeyB', 'b')) return 'toggleRightPanel';
  if (meta && !ctrl && shift && !alt && isCode(input, 'KeyB', 'b')) return 'toggleLeftSidebar';
  if (meta && !ctrl && !shift && !alt && isCode(input, 'KeyJ', 'j')) return 'toggleBottomPanel';
  if (meta && !ctrl && shift && !alt && isCode(input, 'KeyD', 'd')) return 'openDiff';
  if (meta && !ctrl && shift && !alt && isCode(input, 'KeyE', 'e')) return 'openFolderTree';
  return null;
}

function installDesktopShortcutForwarder(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input) => {
    const action = managerShortcutActionFromInput(input);
    if (!action) return;
    event.preventDefault();
    sendManagerShortcut(action);
  });
}

function sendManagerShortcut(action: ManagerShortcutAction): void {
  mainWindow?.webContents.send('manager:shortcut', action);
}

const MAIN_ZOOM_MIN = 0.5;
const MAIN_ZOOM_MAX = 3;
const MAIN_ZOOM_STEP = 0.1;

function applyMainWindowZoom(direction: 'in' | 'out' | 'reset'): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const current = win.webContents.getZoomFactor();
  const next = direction === 'reset'
    ? 1
    : Math.min(MAIN_ZOOM_MAX, Math.max(MAIN_ZOOM_MIN, current + (direction === 'in' ? MAIN_ZOOM_STEP : -MAIN_ZOOM_STEP)));
  win.webContents.setZoomFactor(next);
}

function installManagerApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          enabled: appUpdaterController?.enabled ?? false,
          click: () => { void appUpdaterController?.checkManually(); },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: () => sendManagerShortcut('closeFocusedTab'),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          // Single source of truth for ⌘R: delegate to the renderer's
          // focus-aware handler (browser tab / preview / app window). The
          // renderer keydown matcher excludes these actions so only this
          // accelerator fires — no double reload. App-window reload goes
          // through the guarded window:reload IPC.
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => sendManagerShortcut('browserReload'),
        },
        {
          label: 'Hard Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => sendManagerShortcut('browserHardReload'),
        },
        ...(DEV_TOOLS_ENABLED ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
        { type: 'separator' },
        {
          label: 'Toggle Right Sidebar',
          accelerator: 'CommandOrControl+B',
          click: () => sendManagerShortcut('toggleRightPanel'),
        },
        {
          label: 'Toggle Left Sidebar',
          accelerator: 'CommandOrControl+Shift+B',
          click: () => sendManagerShortcut('toggleLeftSidebar'),
        },
        {
          label: 'Reset Sidebar Width',
          click: () => sendManagerShortcut('resetSidebarWidth'),
        },
        {
          label: 'Toggle Bottom Panel',
          accelerator: 'CommandOrControl+J',
          click: () => sendManagerShortcut('toggleBottomPanel'),
        },
        { type: 'separator' },
        {
          label: 'Open Folder Panel',
          accelerator: 'CommandOrControl+Shift+E',
          click: () => sendManagerShortcut('openFolderTree'),
        },
        {
          label: 'Open Diff Panel',
          accelerator: 'CommandOrControl+Shift+D',
          click: () => sendManagerShortcut('openDiff'),
        },
        { type: 'separator' },
        {
          label: 'Overview',
          accelerator: 'CommandOrControl+1',
          click: () => sendManagerShortcut('switchTab1'),
        },
        {
          label: 'Preview',
          accelerator: 'CommandOrControl+2',
          click: () => sendManagerShortcut('switchTab2'),
        },
        {
          label: 'Logs',
          accelerator: 'CommandOrControl+3',
          click: () => sendManagerShortcut('switchTab3'),
        },
        {
          label: 'Previous Tab',
          accelerator: 'CommandOrControl+Shift+[',
          click: () => sendManagerShortcut('previousTab'),
        },
        {
          label: 'Next Tab',
          accelerator: 'CommandOrControl+Shift+]',
          click: () => sendManagerShortcut('nextTab'),
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', click: () => applyMainWindowZoom('in') },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => applyMainWindowZoom('out') },
        { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', click: () => applyMainWindowZoom('reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Reveal Terminal',
          accelerator: 'Ctrl+`',
          click: () => sendManagerShortcut('focusTerminal'),
        },
        {
          label: 'New Terminal',
          accelerator: 'Ctrl+Shift+`',
          click: () => sendManagerShortcut('newTerminalSession'),
        },
        {
          label: 'New Terminal Tab',
          accelerator: 'CommandOrControl+T',
          click: () => sendManagerShortcut('terminalNewTab'),
        },
        { type: 'separator' },
        {
          label: 'Clear Terminal',
          click: () => sendManagerShortcut('terminalClear'),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function switchManagerUrl(url: string): void {
  MANAGER_URL = url;
  MANAGER_ORIGIN = new URL(url).origin;
  PREVIEW_FRAME_POLICY = resolvePreviewFramePolicyForManager(getManagerUrlPort(url), QA_ENV ?? process.env);
  setAllowedOrigin(MANAGER_ORIGIN);
}

function shouldAttachToExistingManager(): boolean {
  return FLAGS.attachOnly || (FLAGS.managerUrlExplicit && !FLAGS.spawn);
}

function getManagerUrlPort(url: string): number {
  const parsed = new URL(url);
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`[jaw-electron] invalid manager URL port: ${url}`);
  }
  return port;
}

function isTcpPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let done = false;
    const finish = (available: boolean): void => {
      if (done) return;
      done = true;
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(available));
        return;
      }
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

function normalizeElectronPreferredManagerPort(port: number): number {
  if (port >= ELECTRON_MANAGER_PORT_START && port <= ELECTRON_MANAGER_PORT_END) return port;
  return ELECTRON_MANAGER_PORT_START;
}

async function findAvailableManagerPort(preferredPort: number): Promise<number> {
  const start = normalizeElectronPreferredManagerPort(preferredPort);
  for (let candidate = start; candidate <= ELECTRON_MANAGER_PORT_END; candidate += 1) {
    if (await isTcpPortAvailable(candidate)) return candidate;
  }
  throw new Error(
    `[jaw-electron] no free manager port from ${start} to ${ELECTRON_MANAGER_PORT_END}`,
  );
}

async function prepareSpawnManagerUrl(): Promise<void> {
  if (QA_POLICY) return;
  if (FLAGS.managerUrlExplicit) return;
  const port = await findAvailableManagerPort(FLAGS.port);
  const url = `http://127.0.0.1:${port}/`;
  if (url === MANAGER_URL) return;
  ringBuffer.append(`[manager port] ${MANAGER_URL} is busy; spawning dashboard at ${url}\n`);
  switchManagerUrl(url);
  installSecurityHeaders(MANAGER_ORIGIN);
}

async function ensureManagerRunning(): Promise<void> {
  if (QA_POLICY && qaCleanupUncertain) throw new Error('[isolated-qa] cleanup uncertain; restart forbidden');
  if (shouldAttachToExistingManager()) {
    if (await isManagerHealthy(MANAGER_URL)) return;
    const ok = await waitForManagerReady(MANAGER_URL, { timeoutMs: 60_000 });
    if (!ok) {
      await showSpawnFailedDialog(
        `${MANAGER_URL} 에 연결할 수 없습니다. 명시적 attach 모드이므로 서버를 자동 spawn하지 않습니다.`,
      );
      app.quit();
    }
    return;
  }

  if (managerProcess && await isManagerHealthy(MANAGER_URL)) return;
  if (managerReadyPromise) return managerReadyPromise;

  managerReadyPromise = (async () => {
    if (managerProcess && await isManagerHealthy(MANAGER_URL)) return;
    await spawnAndWait();
  })().finally(() => {
    managerReadyPromise = null;
  });

  return managerReadyPromise;
}

async function spawnAndWait(): Promise<void> {
  await prepareSpawnManagerUrl();
  const found = await findJawBinary(QA_POLICY);
  if (!found.path) {
    if (QA_POLICY) throw new Error('[isolated-qa] packaged sidecar: unavailable; fallback forbidden');
    const choice = await showJawNotFoundDialog(found.searched);
    if (choice === 'pick') {
      const picked = await dialog.showOpenDialog({
        title: 'jaw 실행 파일 선택',
        properties: ['openFile'],
      });
      if (!picked.canceled && picked.filePaths[0]) {
        process.env.JAW_BIN = picked.filePaths[0];
        return spawnAndWait();
      }
    }
    app.quit();
    return;
  }

  const managerPort = getManagerUrlPort(MANAGER_URL);
  PREVIEW_FRAME_POLICY = resolvePreviewFramePolicyForManager(managerPort, QA_ENV ?? process.env);
  managerProcess = spawnJawDashboard(found.path, {
    port: managerPort,
    ringBuffer,
    qaPolicy: QA_POLICY,
    env: {
      ...(QA_ENV ?? previewSpawnEnvForManager(managerPort)),
      CLI_JAW_ELECTRON_RENDERER_TOKEN: ELECTRON_RENDERER_TOKEN,
    },
  });

  managerProcess.on('exit', handleManagerExit);
  managerProcess.on('error', (err) => {
    ringBuffer.append(`[spawn error] ${err.message}\n`);
    if (QA_POLICY) reportQaCleanupUncertain(err);
  });

  const ok = await waitForManagerReady(MANAGER_URL, { timeoutMs: 60_000 });
  if (QA_POLICY && qaCleanupUncertain) throw new Error('[isolated-qa] child lifetime failed during readiness');
  if (!ok) {
    await showSpawnFailedDialog(
      `60초 안에 ${MANAGER_URL} 가 응답하지 않았습니다.\n\n최근 로그:\n${ringBuffer.read().slice(-1500)}`,
    );
    app.quit();
  }
}

const PLANNED_RESTART_CODE = 75;

/**
 * Records one restart against the shared 60s budget and reports whether the
 * crash loop breaker tripped. Both the planned and unplanned exit paths go
 * through this, so a server that always exits with PLANNED_RESTART_CODE can no
 * longer respawn forever. A separate per-path counter would effectively double
 * the budget to 6/60s and break the "3 per 60s" intent.
 */
function consumeRestartBudget(): boolean {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter((t) => now - t < 60_000);
  restartTimestamps.push(now);
  return restartTimestamps.length > 3;
}

function handleManagerExit(code: number | null, signal: NodeJS.Signals | null): void {
  if (!QA_POLICY) return handleManagerExitAfterCleanup(code, signal);
  if (shuttingDown || managerRestarting || qaCleanupUncertain) return;
  const child = managerProcess;
  void (async () => {
    try {
      if (!child) throw new Error('[isolated-qa] unowned exit');
      await gracefulShutdown(child, 5000, QA_POLICY);
      if (managerProcess !== child || shuttingDown || managerRestarting) return;
      managerProcess = null;
      handleManagerExitAfterCleanup(code, signal);
    } catch (err) {
      reportQaCleanupUncertain(err);
    }
  })();
}

function handleManagerExitAfterCleanup(code: number | null, signal: NodeJS.Signals | null): void {
  ringBuffer.append(`[manager exit] code=${code} signal=${signal}\n`);
  if (shuttingDown || crashLoopStopped) return;
  if (managerRestarting) return;
  stopTrayReminderBadgePolling();

  if (code === PLANNED_RESTART_CODE) {
    ringBuffer.append(`[manager exit] planned restart (code ${PLANNED_RESTART_CODE})\n`);
    if (consumeRestartBudget()) {
      crashLoopStopped = true;
      updateServerStatus('Server: Crash loop');
      notifyServerCrash();
      void showCrashLoopDialog(ringBuffer.read()).then(() => app.quit());
      return;
    }
    void (async () => {
      try {
        await ensureManagerRunning();
        markManagerRunning();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            await mainWindow.loadURL(MANAGER_URL);
          } catch (err) {
            ringBuffer.append(`[planned restart reload error] ${(err as Error)?.message ?? err}\n`);
          }
        }
      } catch (err) {
        ringBuffer.append(`[planned restart error] ${(err as Error)?.message ?? err}\n`);
      }
    })();
    return;
  }

  void (async () => {
    if (shouldAttachToExistingManager() && await probeOnce(MANAGER_URL)) {
      ringBuffer.append(`[manager exit] another instance owns ${MANAGER_URL}; attaching\n`);
      managerProcess = null;
      if (mainWindow) {
        try {
          await mainWindow.loadURL(MANAGER_URL);
        } catch (err) {
          ringBuffer.append(`[attach error] ${(err as Error)?.message ?? err}\n`);
        }
      }
      markManagerRunning();
      return;
    }
    stopTrayReminderBadgePolling();
    updateServerStatus('Server: Crashed');
    if (isKeepRunning() && (!mainWindow || mainWindow.isDestroyed())) {
      notifyServerCrash();
    }
    if (consumeRestartBudget()) {
      crashLoopStopped = true;
      updateServerStatus('Server: Crash loop');
      notifyServerCrash();
      void showCrashLoopDialog(ringBuffer.read()).then(() => app.quit());
      return;
    }
    try {
      await ensureManagerRunning();
      markManagerRunning();
      if (await probeOnce(MANAGER_URL)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            await mainWindow.loadURL(MANAGER_URL);
          } catch (err) {
            ringBuffer.append(`[respawn reload error] ${(err as Error)?.message ?? err}\n`);
          }
        }
      }
    } catch (err) {
      ringBuffer.append(`[respawn error] ${(err as Error)?.message ?? err}\n`);
    }
  })();
}

async function createWindow(): Promise<void> {
  const initialWindowBounds = getInitialWindowBounds();
  const chrome = resolveWindowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors);
  mainWindow = new BrowserWindow({
    ...initialWindowBounds,
    minWidth: MIN_VISIBLE_WINDOW_WIDTH,
    minHeight: MIN_VISIBLE_WINDOW_HEIGHT,
    show: true,
    ...chrome,
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      preload: PRELOAD_PATH,
      devTools: DEV_TOOLS_ENABLED,
    },
  });
  const owningWindow = mainWindow;
  const userAgent = mainWindow.webContents.getUserAgent();
  if (!userAgent.includes(DESKTOP_USER_AGENT_TOKEN)) {
    mainWindow.webContents.setUserAgent(`${userAgent} ${DESKTOP_USER_AGENT_TOKEN}/${app.getVersion()}`);
  }

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (!isManagerNavigation(url, MANAGER_ORIGIN)) {
      openExternalNavigation(url);
      event.preventDefault();
    }
  };

  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!isAllowedFrameNavigation(event.url)) {
      openExternalNavigation(event.url);
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : '';
    if (!isAllowedEmbeddedBrowserUrl(src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.plugins = false;
    webPreferences.partition = EMBEDDED_BROWSER_PARTITION;
  });
  registerGlobalWebContentsHardening();
  installDesktopShortcutForwarder(mainWindow.webContents);

  const emitFullscreen = () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    broadcastFullscreenChanged(win, win.isFullScreen());
  };
  mainWindow.on('enter-full-screen', emitFullscreen);
  mainWindow.on('leave-full-screen', emitFullscreen);

  const applyOverlay = () => {
    if (owningWindow.isDestroyed()) return;
    const next = resolveWindowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors);
    if (next.titleBarOverlay) owningWindow.setTitleBarOverlay(next.titleBarOverlay);
  };
  nativeTheme.on('updated', applyOverlay);

  // The Manager renderer must never die into a permanently blank window
  // (observed with embedded-browser webview attach in packaged builds).
  // Log the reason and reload, with a small budget so a hard crash loop
  // cannot spin forever.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    ringBuffer.append(`[manager renderer gone] reason=${details.reason} exitCode=${details.exitCode}\n`);
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    const now = Date.now();
    rendererCrashReloads = rendererCrashReloads.filter(at => now - at < 60_000);
    if (rendererCrashReloads.length >= 3) {
      ringBuffer.append('[manager renderer gone] reload budget exhausted; leaving window for inspection\n');
      return;
    }
    rendererCrashReloads.push(now);
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.reload();
      }, 250);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    nativeTheme.off('updated', applyOverlay);
    if (mainWindow === owningWindow) mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (shutdownComplete || shuttingDown) return;
    if (isKeepRunning()) {
      if (metricsCollector) {
        metricsCollector.stop();
        metricsCollector = null;
      }
      cleanupTerminals();
      cleanupFolderWatchers();
      markManagerRunning('Server: Running (background)');
      return;
    }
    event.preventDefault();
    void requestApplicationQuit('window-close');
  });

  if (DEV_TOOLS_ENABLED) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  await mainWindow.loadURL(MANAGER_URL);
}
