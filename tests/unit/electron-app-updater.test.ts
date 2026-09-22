import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAppUpdaterController,
  shouldEnableAppUpdater,
  type AppUpdaterLike,
} from '../../electron/src/main/lib/app-updater.ts';

class FakeUpdater extends EventEmitter implements AppUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = false;
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];

  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return {};
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

type DialogCall = { title?: string; buttons?: string[] };

function fixture(options: { enabled?: boolean; version?: string } = {}) {
  const updater = new FakeUpdater();
  const dialogs: DialogCall[] = [];
  const responses: number[] = [];
  const order: string[] = [];
  const timers: Array<() => void> = [];
  const controller = createAppUpdaterController({
    updater,
    enabled: options.enabled ?? true,
    currentVersion: options.version ?? '2.17.55',
    showMessageBox: async dialog => {
      dialogs.push(dialog);
      return { response: responses.shift() ?? 0, checkboxChecked: false };
    },
    prepareForUpdateInstall: async () => {
      order.push('prepare');
    },
    log: message => order.push(message),
    setTimer: callback => {
      timers.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { updater, dialogs, responses, order, timers, controller };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('automatic updater is restricted to installed macOS outside isolated QA and the kill switch', () => {
  assert.equal(shouldEnableAppUpdater({ platform: 'darwin', isPackaged: true, isolatedQa: false, disabledByEnvironment: false }), true);
  assert.equal(shouldEnableAppUpdater({ platform: 'linux', isPackaged: true, isolatedQa: false, disabledByEnvironment: false }), false);
  assert.equal(shouldEnableAppUpdater({ platform: 'darwin', isPackaged: false, isolatedQa: false, disabledByEnvironment: false }), false);
  assert.equal(shouldEnableAppUpdater({ platform: 'darwin', isPackaged: true, isolatedQa: true, disabledByEnvironment: false }), false);
  assert.equal(shouldEnableAppUpdater({ platform: 'darwin', isPackaged: true, isolatedQa: false, disabledByEnvironment: true }), false);
});

test('start configures fail-closed update policy and performs one silent delayed check', async () => {
  const stable = fixture();
  stable.controller.start();
  assert.equal(stable.updater.autoDownload, false);
  assert.equal(stable.updater.autoInstallOnAppQuit, false);
  assert.equal(stable.updater.allowDowngrade, false);
  assert.equal(stable.updater.allowPrerelease, false);
  assert.equal(stable.timers.length, 1);
  stable.timers[0]!();
  await flush();
  assert.equal(stable.updater.checks, 1);
  assert.equal(stable.dialogs.length, 0, 'startup check must stay silent when no updater event is emitted');

  const preview = fixture({ version: '2.17.55-preview.20260922010101' });
  preview.controller.start();
  assert.equal(preview.updater.allowPrerelease, true);
});

test('manual check reports no update while disabled and when current version is latest', async () => {
  const disabled = fixture({ enabled: false });
  disabled.controller.start();
  await disabled.controller.checkManually();
  assert.equal(disabled.dialogs[0]?.title, 'Updates Unavailable');
  assert.equal(disabled.updater.checks, 0);

  const enabled = fixture();
  enabled.controller.start();
  await enabled.controller.checkManually();
  enabled.updater.emit('update-not-available', { version: '2.17.55' });
  await flush();
  assert.equal(enabled.dialogs.at(-1)?.title, 'No Updates Available');
});

test('update download and restart require explicit consent', async () => {
  const state = fixture();
  state.controller.start();
  state.responses.push(1, 1);

  state.updater.emit('update-available', { version: '2.17.56' });
  await flush();
  assert.equal(state.updater.downloads, 1);
  assert.deepEqual(state.dialogs[0]?.buttons, ['Later', 'Download']);

  state.updater.emit('update-downloaded', { version: '2.17.56' });
  await flush();
  assert.deepEqual(state.dialogs[1]?.buttons, ['Later', 'Restart and Install']);
  assert.deepEqual(state.updater.installs, [[false, true]]);
  const prepareAt = state.order.indexOf('prepare');
  const installAt = state.order.findIndex(message => message.includes('restarting to install'));
  assert.ok(prepareAt >= 0 && installAt > prepareAt, 'sidecar shutdown preparation must finish before quitAndInstall');
});

test('declining download or restart leaves the running version untouched', async () => {
  const state = fixture();
  state.controller.start();
  state.responses.push(0, 0);

  state.updater.emit('update-available', { version: '2.17.56' });
  await flush();
  state.updater.emit('update-downloaded', { version: '2.17.56' });
  await flush();

  assert.equal(state.updater.downloads, 0);
  assert.deepEqual(state.updater.installs, []);
  assert.equal(state.order.includes('prepare'), false);
});

test('concurrent checks are deduplicated and updater errors keep the app running', async () => {
  const state = fixture();
  let resolveCheck!: () => void;
  state.updater.checkForUpdates = () => {
    state.updater.checks += 1;
    return new Promise<void>(resolve => { resolveCheck = resolve; });
  };
  state.controller.start();

  const first = state.controller.checkManually();
  const second = state.controller.checkManually();
  assert.equal(state.updater.checks, 1);
  resolveCheck();
  await Promise.all([first, second]);

  state.updater.emit('error', new Error('network unavailable'));
  await flush();
  assert.equal(state.dialogs.at(-1)?.title, 'Update Failed');
  assert.deepEqual(state.updater.installs, []);
});

test('startup check failures stay silent while a rejected manual check reports failure', async () => {
  const state = fixture();
  state.updater.checkForUpdates = async () => { throw new Error('offline'); };
  state.controller.start();

  state.timers[0]!();
  await flush();
  assert.equal(state.dialogs.length, 0);

  await state.controller.checkManually();
  assert.equal(state.dialogs.at(-1)?.title, 'Update Failed');
});

test('dispose removes updater listeners and suppresses later prompts', async () => {
  const state = fixture();
  state.controller.start();
  state.controller.dispose();
  state.updater.emit('update-available', { version: '2.17.56' });
  await flush();
  assert.equal(state.dialogs.length, 0);
  assert.equal(state.updater.listenerCount('update-available'), 0);
});
