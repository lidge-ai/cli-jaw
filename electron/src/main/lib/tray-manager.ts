import { Tray, Menu, nativeImage, app, clipboard, Notification, dialog } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isCliInstalled, installCli } from './install-cli.js';
import { readIsolatedQaPolicy, type IsolatedQaPolicy } from '../../../../src/shared/isolated-qa.js';
import {
  EMPTY_TRAY_INSTANCES,
  instanceMenuLabel,
  instancesSummaryLabel,
  visibleInstances,
  type TrayInstancesSnapshot,
} from './tray-menu-model.js';

const PREFS_FILENAME = 'tray-preferences.json';

interface TrayPrefs {
  keepRunningInBackground: boolean;
  startAtLogin: boolean;
}

const DEFAULT_PREFS: TrayPrefs = {
  keepRunningInBackground: false,
  startAtLogin: false,
};

let prefs: TrayPrefs = { ...DEFAULT_PREFS };

function prefsPath(): string {
  return join(app.getPath('userData'), PREFS_FILENAME);
}

function loadPrefs(): void {
  try {
    if (existsSync(prefsPath())) {
      const data = JSON.parse(readFileSync(prefsPath(), 'utf8'));
      prefs = {
        keepRunningInBackground: data.keepRunningInBackground === true,
        startAtLogin: data.startAtLogin === true,
      };
    }
  } catch { /* ignore corrupt file */ }
}

function savePrefs(): void {
  try {
    writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
  } catch { /* ignore */ }
}

let tray: Tray | null = null;
let callbacks: TrayCallbacks | null = null;
let serverStatus = 'Starting...';
let currentMenu: Menu | null = null;
let onTrayClick: (() => void) | null = null;
let qaPolicy: IsolatedQaPolicy | null = null;
let instancesSnapshot: TrayInstancesSnapshot = EMPTY_TRAY_INSTANCES;

export interface TrayCallbacks {
  onOpenDashboard: () => void;
  onRestartServer: () => void;
  onQuit: () => void;
  getManagerUrl: () => string;
  /** App version shown in the menu header. */
  getAppVersion?: () => string;
  /** Opens the dashboard focused on one instance. */
  onOpenInstance?: (port: number) => void;
  /** Refreshes live data just before the menu opens (must not block). */
  onBeforePopup?: () => void;
  canCheckForUpdates?: () => boolean;
  onCheckForUpdates?: () => void;
  onOpenReleases?: () => void;
}

export function isKeepRunning(): boolean {
  return prefs.keepRunningInBackground;
}

export function createTray(cb: TrayCallbacks, policy = readIsolatedQaPolicy(process.env, 'electron')): Tray {
  qaPolicy = policy;
  loadPrefs();
  callbacks = cb;
  syncLoginItemSetting();

  // bootstrap() can run twice (bootstrapOnce clears its promise in .finally()),
  // and overwriting `tray` would strand the previous native tray icon.
  if (tray && !tray.isDestroyed()) {
    rebuildMenu();
    return tray;
  }

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayTemplate.png')
    : join(__dirname, '..', '..', 'build', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('cli-jaw');
  rebuildMenu();
  tray.on('click', () => (onTrayClick ? onTrayClick() : cb.onOpenDashboard()));
  tray.on('right-click', () => popUpTrayMenu());
  return tray;
}

export function updateServerStatus(status: string): void {
  serverStatus = status;
  rebuildMenu();
}

export function setTrayInstances(snapshot: TrayInstancesSnapshot): void {
  instancesSnapshot = snapshot;
  rebuildMenu();
}

export function setTrayBadge(count: number): void {
  if (!tray) return;
  tray.setTitle(count > 0 ? ` ${count}` : '');
}

export function notifyServerCrash(): void {
  setTrayBadge(1);
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'cli-jaw',
      body: 'Server crashed. Use Restart Server from the menu bar.',
      silent: false,
    });
    n.show();
  }
}

export function clearTrayBadge(): void {
  setTrayBadge(0);
}

export function setTrayClickHandler(fn: () => void): void {
  onTrayClick = fn;
}

export function popUpTrayMenu(): void {
  callbacks?.onBeforePopup?.();
  if (tray && currentMenu) tray.popUpContextMenu(currentMenu);
}

export function getTrayBoundsSafe(): Electron.Rectangle | null {
  return tray?.getBounds() ?? null;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  callbacks = null;
  currentMenu = null;
  onTrayClick = null;
  instancesSnapshot = EMPTY_TRAY_INSTANCES;
}

function syncLoginItemSetting(): void {
  if (qaPolicy) return;
  app.setLoginItemSettings({
    openAtLogin: prefs.startAtLogin,
    args: prefs.startAtLogin ? ['--background'] : [],
  });
}

function instancesSubmenu(cb: TrayCallbacks): MenuItemConstructorOptions[] {
  const { rows, hidden } = visibleInstances(instancesSnapshot);
  const items: MenuItemConstructorOptions[] = rows.map((instance) => ({
    label: instanceMenuLabel(instance),
    click: () => (cb.onOpenInstance ? cb.onOpenInstance(instance.port) : cb.onOpenDashboard()),
  }));
  if (items.length === 0) items.push({ label: 'No instances found', enabled: false });
  if (hidden > 0) items.push({ label: `${hidden} more in Dashboard…`, enabled: false });
  items.push({ type: 'separator' }, { label: 'Show All in Dashboard', click: cb.onOpenDashboard });
  return items;
}

function rebuildMenu(): void {
  if (!tray || !callbacks) return;
  const cb = callbacks;
  const version = cb.getAppVersion?.();
  const menu = Menu.buildFromTemplate([
    { label: version ? `cli-jaw v${version}` : 'cli-jaw', enabled: false },
    { label: serverStatus, enabled: false },
    { label: instancesSummaryLabel(instancesSnapshot), submenu: instancesSubmenu(cb) },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: cb.onOpenDashboard,
    },
    {
      label: 'Copy URL',
      click: () => clipboard.writeText(cb.getManagerUrl()),
    },
    {
      label: 'Restart Server',
      click: cb.onRestartServer,
    },
    { type: 'separator' },
    {
      label: 'Keep Running in Background',
      type: 'checkbox',
      checked: prefs.keepRunningInBackground,
      click: (item) => {
        prefs.keepRunningInBackground = item.checked;
        savePrefs();
      },
    },
    {
      label: 'Start at Login',
      enabled: !qaPolicy,
      type: 'checkbox',
      checked: prefs.startAtLogin,
      click: (item) => {
        if (qaPolicy) return;
        prefs.startAtLogin = item.checked;
        savePrefs();
        syncLoginItemSetting();
      },
    },
    {
      label: !qaPolicy && isCliInstalled() ? 'CLI Installed ✓' : 'Install CLI to Terminal',
      enabled: !qaPolicy && app.isPackaged && !isCliInstalled(),
      click: async () => {
        if (qaPolicy) return;
        const result = await installCli();
        await dialog.showMessageBox({
          type: result.ok ? 'info' : 'error',
          message: result.ok ? 'CLI Installed' : 'Installation Failed',
          detail: result.message,
        });
        if (result.ok) rebuildMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      enabled: !qaPolicy && (cb.canCheckForUpdates?.() ?? false),
      click: () => { if (!qaPolicy) cb.onCheckForUpdates?.(); },
    },
    {
      label: 'Open Releases Page',
      enabled: !qaPolicy && Boolean(cb.onOpenReleases),
      click: () => { if (!qaPolicy) cb.onOpenReleases?.(); },
    },
    { type: 'separator' },
    { label: 'Quit cli-jaw', click: cb.onQuit },
  ]);
  currentMenu = menu;
}
