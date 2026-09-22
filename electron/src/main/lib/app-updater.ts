import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

export type UpdateInfoLike = { version: string };
export type DownloadProgressLike = { percent: number };

export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): this;
  on(event: 'download-progress', listener: (progress: DownloadProgressLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AppUpdaterController {
  readonly enabled: boolean;
  start(): void;
  checkManually(): Promise<void>;
  dispose(): void;
}

interface AppUpdaterControllerOptions {
  updater: AppUpdaterLike;
  enabled: boolean;
  currentVersion: string;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  prepareForUpdateInstall(): Promise<void>;
  log(message: string): void;
  startupDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

const DEFAULT_STARTUP_DELAY_MS = 30_000;

export function shouldEnableAppUpdater(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isolatedQa: boolean;
  disabledByEnvironment: boolean;
}): boolean {
  return options.platform === 'darwin' &&
    options.isPackaged &&
    !options.isolatedQa &&
    !options.disabledByEnvironment;
}

export function createAppUpdaterController(options: AppUpdaterControllerOptions): AppUpdaterController {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const listeners: Array<[string, (...args: never[]) => void]> = [];
  let startupTimer: TimerHandle | null = null;
  let started = false;
  let disposed = false;
  let checkPromise: Promise<void> | null = null;
  let manualFeedbackPending = false;
  let downloadPromptOpen = false;
  let restartPromptOpen = false;
  let errorDialogOpen = false;
  let lastLoggedProgressBucket = -1;

  const listen = (event: string, listener: (...args: never[]) => void): void => {
    options.updater.on(event as never, listener as never);
    listeners.push([event, listener]);
  };

  const showError = async (error: unknown): Promise<void> => {
    const detail = error instanceof Error ? error.message : String(error);
    options.log(`[updater] error: ${detail}`);
    if (errorDialogOpen || disposed) return;
    errorDialogOpen = true;
    try {
      await options.showMessageBox({
        type: 'error',
        title: 'Update Failed',
        message: 'cli-jaw could not complete the update.',
        detail: `${detail}\n\nThe current version remains installed and can keep running.`,
        buttons: ['OK'],
        defaultId: 0,
      });
    } finally {
      errorDialogOpen = false;
    }
  };

  const check = async (manual: boolean): Promise<void> => {
    if (!options.enabled || disposed) {
      if (manual) {
        await options.showMessageBox({
          type: 'info',
          title: 'Updates Unavailable',
          message: 'Automatic updates are available only in the installed macOS app.',
          buttons: ['OK'],
          defaultId: 0,
        });
      }
      return;
    }
    if (manual) manualFeedbackPending = true;
    if (checkPromise) return checkPromise;
    checkPromise = options.updater.checkForUpdates()
      .then(() => undefined)
      .catch(async (error: unknown) => {
        // electron-updater also emits `error`; this catch prevents an unhandled
        // rejection. If no event arrived, a manual check still gets feedback;
        // startup network failures remain silent and only enter the log.
        if (manual && manualFeedbackPending) {
          manualFeedbackPending = false;
          await showError(error);
        } else {
          options.log(`[updater] check rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        checkPromise = null;
      });
    return checkPromise;
  };

  return {
    enabled: options.enabled,
    start(): void {
      if (started || disposed) return;
      started = true;
      if (!options.enabled) return;

      options.updater.autoDownload = false;
      options.updater.autoInstallOnAppQuit = false;
      options.updater.allowDowngrade = false;
      options.updater.allowPrerelease = prereleaseChannel(options.currentVersion) !== null;

      listen('update-available', ((info: UpdateInfoLike) => {
        manualFeedbackPending = false;
        options.log(`[updater] version ${info.version} is available`);
        if (downloadPromptOpen || disposed) return;
        downloadPromptOpen = true;
        void options.showMessageBox({
          type: 'info',
          title: 'Update Available',
          message: `cli-jaw ${info.version} is available.`,
          detail: 'Download it now? The current version keeps running until you choose to restart.',
          buttons: ['Later', 'Download'],
          defaultId: 1,
          cancelId: 0,
        }).then(async ({ response }) => {
          if (response !== 1 || disposed) return;
          options.log(`[updater] downloading version ${info.version}`);
          await options.updater.downloadUpdate();
        }).catch(showError).finally(() => {
          downloadPromptOpen = false;
        });
      }) as (...args: never[]) => void);

      listen('update-not-available', ((info: UpdateInfoLike) => {
        options.log(`[updater] no update available (current ${options.currentVersion}, latest ${info.version})`);
        if (!manualFeedbackPending || disposed) return;
        manualFeedbackPending = false;
        void options.showMessageBox({
          type: 'info',
          title: 'No Updates Available',
          message: `cli-jaw ${options.currentVersion} is up to date.`,
          buttons: ['OK'],
          defaultId: 0,
        });
      }) as (...args: never[]) => void);

      listen('download-progress', ((progress: DownloadProgressLike) => {
        const bucket = Math.max(0, Math.min(10, Math.floor(progress.percent / 10)));
        if (bucket === lastLoggedProgressBucket) return;
        lastLoggedProgressBucket = bucket;
        options.log(`[updater] download ${Math.round(progress.percent)}%`);
      }) as (...args: never[]) => void);

      listen('update-downloaded', ((info: UpdateInfoLike) => {
        options.log(`[updater] version ${info.version} downloaded`);
        if (restartPromptOpen || disposed) return;
        restartPromptOpen = true;
        void options.showMessageBox({
          type: 'info',
          title: 'Update Ready',
          message: `cli-jaw ${info.version} is ready to install.`,
          detail: 'Restart cli-jaw now to finish the update?',
          buttons: ['Later', 'Restart and Install'],
          defaultId: 1,
          cancelId: 0,
        }).then(async ({ response }) => {
          if (response !== 1 || disposed) return;
          await options.prepareForUpdateInstall();
          options.log(`[updater] restarting to install version ${info.version}`);
          options.updater.quitAndInstall(false, true);
        }).catch(showError).finally(() => {
          restartPromptOpen = false;
        });
      }) as (...args: never[]) => void);

      listen('error', ((error: Error) => {
        const reportToUser = manualFeedbackPending || downloadPromptOpen || restartPromptOpen;
        manualFeedbackPending = false;
        if (reportToUser) void showError(error);
        else options.log(`[updater] error: ${error.message}`);
      }) as (...args: never[]) => void);

      startupTimer = setTimer(() => {
        startupTimer = null;
        void check(false);
      }, options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
      startupTimer.unref?.();
    },
    checkManually(): Promise<void> {
      return check(true);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (startupTimer) {
        clearTimer(startupTimer);
        startupTimer = null;
      }
      for (const [event, listener] of listeners) options.updater.off(event, listener);
      listeners.length = 0;
    },
  };
}

function prereleaseChannel(version: string): string | null {
  const separator = version.indexOf('-');
  if (separator < 0) return null;
  return version.slice(separator + 1).split('.')[0] || null;
}
