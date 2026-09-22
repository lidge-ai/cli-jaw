import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { ChildProcess } from 'node:child_process';
import { readIsolatedQaPolicy, type IsolatedQaPolicy } from '../../src/shared/isolated-qa.js';

const require = createRequire(import.meta.url);
const entry = resolve('electron/src/main/index.ts');
const boundaryExports: Record<string, string[]> = {
  'install-cli': ['promptInstallCli', 'isCliInstalled', 'installCli'],
  'reminder-popover': ['createReminderPopover'], 'reminder-badge': ['createReminderBadgePoller'],
  'health-check': ['waitForManagerReady', 'isManagerHealthy', 'probeOnce'],
  'dialog': ['showJawNotFoundDialog', 'showCrashLoopDialog', 'showSpawnFailedDialog'],
  'app-metrics': ['startAppMetricsCollector'], 'terminal/index': ['registerTerminalIpc', 'cleanupTerminals'],
  'git/ipc': ['registerDiffIpc'], 'folder/ipc': ['registerFolderIpc', 'cleanupFolderWatchers'],
  'browser/ipc': ['registerBrowserIpc', 'markOwnedEmbeddedBrowserWebContents'],
  'clipboard/ipc': ['registerClipboardIpc'], 'permission-diagnostics/ipc': ['registerPermissionDiagnosticsIpc'],
  'window/ipc': ['broadcastFullscreenChanged', 'registerWindowIpc'],
  'mac-automation-permission': ['primeMacAutomationPermission'], 'quit-progress': ['showQuitProgress'],
  'process-kill': ['killProcessTree'],
};
const compiled = await build({ stdin: { contents: `export { gracefulShutdown } from './electron/src/main/lib/jaw-spawn.ts'; import './electron/src/main/index.ts';`,
  resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.url': JSON.stringify(new URL('../../electron/src/main/index.ts', import.meta.url).href) },
  plugins: [{ name: 'external-boundaries', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake-electron' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake-electron' }, () => ({ contents: 'module.exports = globalThis.electronBoundary;' }));
    builder.onResolve({ filter: /^electron-updater$/ }, () => ({ path: 'electron-updater', namespace: 'fake-electron-updater' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake-electron-updater' }, () => ({ contents: `module.exports = { autoUpdater: {
      on() { return this; }, off() { return this; }, checkForUpdates() { return Promise.resolve(); },
      downloadUpdate() { return Promise.resolve(); }, quitAndInstall() {},
    } };` }));
    builder.onResolve({ filter: /^fix-path$/ }, () => ({ path: 'fix-path', namespace: 'fake-fix-path' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake-fix-path' }, () => ({ contents: 'module.exports = () => globalThis.record("fixPath");' }));
    builder.onResolve({ filter: /\.js$/ }, args => {
      const name = Object.keys(boundaryExports).find(key => args.path.endsWith(`/${key}.js`));
      return name ? { path: name, namespace: 'boundary' } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents:
      boundaryExports[args.path].map(name => `export const ${name} = (...args) => globalThis.boundary(${JSON.stringify(name)}, ...args);`).join('\n'),
    }));
  } }],
});
const mainCode = compiled.outputFiles[0].text;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-qa-electron-')));
  const roots = { HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
    XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CLI_JAW_HOME: 'manager',
    CLI_JAW_DASHBOARD_HOME: 'dashboard', CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude',
    PI_CODING_AGENT_DIR: 'providers/pi' };
  const env: NodeJS.ProcessEnv = { CLI_JAW_ISOLATED_QA_ROOT: root, PATH: '/usr/bin:/bin',
    DASHBOARD_PORT: '31401', DASHBOARD_SCAN_FROM: '31402', DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PREVIEW_FROM: '31403',
    JAW_MANAGER_URL: 'http://127.0.0.1:31401/', JAW_MANAGER_PORT: '31401',
    OPENAI_API_KEY: 'fixture-secret', NODE_OPTIONS: '--fixture-unsafe', JAW_BIN: '/forbidden/personal/jaw',
    CLI_JAW_ELECTRON_RENDERER_TOKEN: 'inherited-not-a-task-token', HTTP_PROXY: 'http://forbidden.invalid' };
  for (const [key, suffix] of Object.entries(roots)) env[key] = join(root, suffix);
  for (const suffix of [...Object.values(roots), 'worker', 'electron/userData', 'electron/sessionData',
    'electron/logs', 'electron/crashDumps', 'resources/server/bin', 'resources/server/dist/bin']) {
    mkdirSync(join(root, suffix), { recursive: true });
  }
  for (const file of ['node', 'node.exe', 'bin/jaw', 'bin/jaw.cmd', 'dist/bin/cli-jaw.js']) {
    const path = join(root, 'resources/server', file);
    writeFileSync(path, 'fixture artifact; never executed'); chmodSync(path, 0o755);
  }
  return { root, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

type Call = { name: string; args: unknown[] };
function launch(env: NodeJS.ProcessEnv, root: string, args = ['--spawn'], options: { packaged?: boolean; lock?: boolean; probeFailure?: boolean;
  probeFault?: { status: number; signal?: string | null; code?: string }; platform?: string; cooperative?: boolean } = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...values: unknown[]) => { calls.push({ name, args: values }); };
  const paths: Record<string, string> = { userData: join(root, 'electron/userData') };
  const menus: Array<Array<Record<string, unknown>>> = [];
  const timers = new Map<object, { fn: () => void; delay: number }>();
  const setTimer = (fn: () => void, delay: number) => {
    const handle = { unref() {} }; timers.set(handle, { fn, delay }); return handle;
  };
  const clearTimer = (handle: object) => { timers.delete(handle); };
  class FakeChild extends EventEmitter {
    pid: number | undefined = 41001;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    stdout = new EventEmitter(); stderr = new EventEmitter();
    killResult = true;
    killError: Error | null = null;
    kill(signal: string) {
      record('handleKill', signal);
      if (this.killError) throw this.killError;
      if (this.killResult && options.cooperative !== false) queueMicrotask(() => {
        this.exitCode = 0; this.emit('exit', 0, null); this.emit('close', 0, null);
      });
      return this.killResult;
    }
  }
  const children: FakeChild[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: options.packaged !== false, isReady: () => true,
    setPath: (key: string, value: string) => { record('setPath', key, value); paths[key] = value; },
    setAppLogsPath: (value: string) => { record('setLogs', value); paths.logs = value; },
    getPath: (key: string) => { record('getPath', key); return paths[key]; },
    requestSingleInstanceLock: () => { record('lock'); return options.lock !== false; },
    enableSandbox: () => record('sandbox'), setAsDefaultProtocolClient: () => record('protocol'),
    setLoginItemSettings: (...args: unknown[]) => record('login', ...args),
    whenReady: () => ready, getPreferredSystemLanguages: () => ['en-US'], getVersion: () => 'fixture',
    quit: () => record('quit'), exit: (code: number) => record('exit', code),
  });
  const sessionObject = {
    setUserAgent: () => {}, cookies: { flushStore: async () => {} },
    webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: (...args: unknown[]) => record('csp', ...args) },
    setPermissionRequestHandler: (...args: unknown[]) => record('permissionRequest', ...args),
    setPermissionCheckHandler: (...args: unknown[]) => record('permissionCheck', ...args),
  };
  const windows: Window[] = [];
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { getUserAgent: () => 'fixture', setUserAgent: () => {},
      setWindowOpenHandler: () => {}, send: () => {}, getURL: () => env.JAW_MANAGER_URL,
      openDevTools: () => {}, getZoomFactor: () => 1, setZoomFactor: () => {} });
    constructor(opts: unknown) { super(); windows.push(this); record('window', opts); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isFullScreen() { return false; }
    setTitleBarOverlay(value: unknown) { record('overlay', this, value); }
    show() {} focus() {} restore() {} hide() {}
    async loadURL(url: string) { record('loadURL', url); }
  }
  class FakeTray extends EventEmitter {
    constructor(_icon: unknown) { super(); record('tray'); }
    setToolTip() {} setTitle() {} destroy() {} isDestroyed() { return false; }
    getBounds() { return { x: 0, y: 0, width: 20, height: 20 }; }
    popUpContextMenu() { record('popup'); }
  }
  const boundary = (name: string, ...values: unknown[]) => {
    record(name, ...values);
    if (name === 'isCliInstalled') return false;
    if (name === 'installCli') return Promise.resolve({ ok: true, message: 'fixture' });
    if (name === 'promptInstallCli') return Promise.resolve();
    if (name === 'waitForManagerReady' || name === 'isManagerHealthy' || name === 'probeOnce') return Promise.resolve(true);
    if (name === 'showJawNotFoundDialog') return Promise.resolve('pick');
    if (name === 'createReminderPopover') return { destroy() {}, toggle() {}, hide() {} };
    if (name === 'createReminderBadgePoller') return { stop() {}, start() {}, refreshNow() {} };
    if (name === 'startAppMetricsCollector') return { stop() {} };
  };
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const electronBoundary = { app, BrowserWindow: Window, Tray: FakeTray,
    Menu: { buildFromTemplate: (items: Array<Record<string, unknown>>) => { menus.push(items); return items; }, setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    nativeTheme,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) },
    session: { get defaultSession() { record('session'); return sessionObject; }, fromPartition: () => { record('session'); return sessionObject; } },
    globalShortcut: { register: () => { record('shortcut'); return true; }, unregister: () => record('unregister') },
    ipcMain: { on: (...args: unknown[]) => record('ipcOn', ...args), handle: () => {} },
    dialog: { showErrorBox: (...args: unknown[]) => record('error', ...args),
      showMessageBox: async () => { record('messageBox'); return { response: 0 }; },
      showOpenDialog: async () => { record('picker'); return { canceled: true, filePaths: [] }; } },
    clipboard: { writeText: () => {} }, Notification: { isSupported: () => false }, shell: { openExternal: async () => record('external') },
  };
  const fakeProcess = { env: { ...env }, argv: ['electron', entry, ...args], resourcesPath: join(root, 'resources'),
    platform: options.platform ?? 'darwin', execPath: '/fixture/electron', versions: { chrome: '130', electron: 'fixture' },
    kill: (...args: unknown[]) => { record('numericKill', ...args); throw Object.assign(new Error('absent'), { code: 'ESRCH' }); } };
  const childProcess = {
    execFileSync: (command: string, args: string[], opts: unknown) => {
      record('exec', command, args, opts);
      if (command === 'which') return '/normal/jaw\n';
      if (options.probeFault) throw Object.assign(new Error('fixture execution failure'), { stdout:'Usage: jaw dashboard', ...options.probeFault });
      if (options.probeFailure) throw Object.assign(new Error('fixture timeout'), { status: null, stdout: 'Usage: jaw dashboard' });
      throw Object.assign(new Error('fixture probe'), { status: 1, stdout: 'Unknown dashboard command: __jaw_electron_probe__' });
    },
    spawn: (...args: unknown[]) => { record('spawn', ...args); const child = new FakeChild(); children.push(child); return child; },
  };
  const module = { exports: {} as { gracefulShutdown: (child: ChildProcess, timeout?: number, policy?: IsolatedQaPolicy | null) => Promise<void> } };
  let error: unknown;
  try {
    runInNewContext(mainCode, { exports: module.exports, module, process: fakeProcess, __dirname: resolve('electron/src/main'),
      require: (name: string) => {
        if (name === 'node:child_process') return childProcess;
        if (name === 'node:net') return { createServer: () => { throw new Error('unfenced network forbidden'); } };
        if (name === 'node:os') return { ...require(name), homedir: () => join(root, 'home') };
        if (name === 'node:fs') {
          const fs = require(name);
          return { ...fs,
            existsSync: (file: string) => file.startsWith(root + '/') && fs.existsSync(file),
            statSync: (file: string) => {
              if (file !== root && !file.startsWith(root + '/')) throw new Error('outside fixture');
              return fs.statSync(file);
            },
          };
        }
        return require(name);
      }, electronBoundary, boundary, record, console: { error: (...args: unknown[]) => record('consoleError', ...args) },
      Buffer, URL, setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setTimer, clearInterval: clearTimer,
    }, { filename: entry });
  } catch (caught) { error = caught; }
  resolveReady();
  return { calls, app, menus, error, env: fakeProcess.env, children, windows, nativeTheme, api: module.exports,
    deadline: (delay: number) => {
      for (const [handle, timer] of [...timers]) if (timer.delay === delay) { timers.delete(handle); timer.fn(); }
    },
    settle: async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); } };
}
const named = (run: ReturnType<typeof launch>, name: string) => run.calls.filter(call => call.name === name);
const forbidden = ['protocol', 'login', 'shortcut', 'unregister', 'primeMacAutomationPermission', 'promptInstallCli', 'isCliInstalled', 'installCli', 'fixPath', 'picker', 'showJawNotFoundDialog', 'external'];

test('theme listener follows one live window and stale callbacks cannot affect its replacement', async () => {
  const f = fixture();
  try {
    const run = launch(f.env, f.root, ['--spawn'], { platform: 'linux' });
    assert.equal(run.error, undefined); await run.settle();
    assert.equal(run.windows.length, 1);
    assert.equal(run.nativeTheme.listenerCount('updated'), 1);

    const first = run.windows[0]!;
    const firstThemeCallback = run.nativeTheme.listeners('updated')[0] as () => void;
    const staleClosedCallback = first.listeners('closed')[0] as () => void;
    first.destroyed = true;
    first.emit('closed');
    assert.equal(run.nativeTheme.listenerCount('updated'), 0);

    run.app.emit('activate'); await run.settle();
    assert.equal(run.windows.length, 2);
    assert.equal(run.nativeTheme.listenerCount('updated'), 1);
    const second = run.windows[1]!;
    const secondThemeCallback = run.nativeTheme.listeners('updated')[0] as () => void;
    assert.notEqual(secondThemeCallback, firstThemeCallback);

    firstThemeCallback();
    staleClosedCallback();
    run.app.emit('activate'); await run.settle();
    assert.equal(run.windows.length, 2, 'stale callbacks must not clear or update the replacement window');
    assert.equal(named(run, 'overlay').length, 0);

    run.nativeTheme.shouldUseDarkColors = true;
    run.nativeTheme.emit('updated');
    assert.equal(named(run, 'overlay').length, 1);
    assert.equal(named(run, 'overlay')[0]!.args[0], second);

    second.destroyed = true;
    second.emit('closed');
    assert.equal(run.nativeTheme.listenerCount('updated'), 0);
    run.app.emit('activate'); await run.settle();
    assert.equal(run.windows.length, 3);
    assert.equal(run.nativeTheme.listenerCount('updated'), 1);
    assert.notEqual(run.nativeTheme.listeners('updated')[0], secondThemeCallback);
  } finally { f.dispose(); }
});

test('actual main/tray/spawn preserves isolated startup order, argv/environment, IPC and repeat bootstrap', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'electron/userData/tray-preferences.json'), JSON.stringify({ startAtLogin: true }));
    const run = launch(f.env, f.root);
    assert.equal(run.error, undefined); await run.settle();
    assert.equal(named(run, 'error').length, 0);
    assert.equal(named(run, 'window').length, 1);
    assert.equal(named(run, 'lock').length, 1); assert.equal(named(run, 'sandbox').length, 1);
    const names = run.calls.map(call => call.name);
    assert.ok(names.lastIndexOf('setPath') < names.indexOf('lock'));
    assert.ok(names.indexOf('setLogs') < names.indexOf('lock'));
    assert.ok(names.indexOf('lock') < names.indexOf('session'));
    assert.deepEqual(named(run, 'setPath').map(call => call.args), [
      ['home', join(f.root, 'home')], ['userData', join(f.root, 'electron/userData')],
      ['sessionData', join(f.root, 'electron/sessionData')], ['temp', join(f.root, 'tmp')],
      ['crashDumps', join(f.root, 'electron/crashDumps')],
    ]);
    const spawn = named(run, 'spawn')[0]; assert.ok(spawn);
    const [command, argv, opts] = spawn.args as [string, string[], { env: NodeJS.ProcessEnv; cwd: string; shell?: boolean }];
    assert.equal(command, join(f.root, 'resources/server/node'));
    assert.deepEqual(Array.from(argv), [join(f.root, 'resources/server/dist/bin/cli-jaw.js'), 'dashboard', 'serve', '--port', '31401', '--no-open', '--from', '31402', '--count', '1']);
    assert.equal(opts.shell, undefined); assert.equal(opts.cwd, join(f.root, 'home'));
    for (const key of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'JAW_BIN', 'HTTP_PROXY']) assert.equal(opts.env[key], undefined, key);
    assert.equal(opts.env.CLI_JAW_HOME, join(f.root, 'manager'));
    assert.equal(opts.env.DASHBOARD_PREVIEW_FROM, '31403'); assert.equal(opts.env.DASHBOARD_SCAN_COUNT, '1');
    assert.match(opts.env.CLI_JAW_ELECTRON_RENDERER_TOKEN!, /^[a-f0-9]{64}$/);
    const probeOpts = named(run, 'exec')[0].args[2] as { env: NodeJS.ProcessEnv; timeout: number };
    assert.equal(probeOpts.timeout, 2000); assert.equal(probeOpts.env.CLI_JAW_ELECTRON_RENDERER_TOKEN, undefined);
    assert.ok(named(run, 'permissionRequest').length); assert.ok(named(run, 'csp').length);
    const windowOpts = named(run, 'window')[0].args[0] as { webPreferences: Record<string, unknown> };
    assert.equal(windowOpts.webPreferences.sandbox, true); assert.equal(windowOpts.webPreferences.contextIsolation, true);
    assert.equal(windowOpts.webPreferences.nodeIntegration, false);
    const popup = named(run, 'ipcOn').find(call => call.args[0] === 'tray:popup-menu'); assert.ok(popup);
    const popupHandler = popup.args[1] as (event: { senderFrame: { url: string } }) => void;
    popupHandler({ senderFrame: { url: 'http://127.0.0.1:31402/' } });
    assert.equal(named(run, 'popup').length, 0);
    popupHandler({ senderFrame: { url: 'http://127.0.0.1:31401/' } });
    assert.equal(named(run, 'popup').length, 1);
    // Captured policy survives later environment mutation and another bootstrap.
    delete run.env.CLI_JAW_ISOLATED_QA_ROOT;
    run.app.emit('open-url', { preventDefault() {} }, 'jaw://open?path=/'); await run.settle();
    assert.equal(named(run, 'tray').length, 1);
    assert.equal(named(run, 'registerTerminalIpc').length, 1);
    const restart = run.menus.flat().find(item => item.label === 'Restart Server')!;
    (restart.click as () => void)(); await run.settle();
    assert.equal(named(run, 'spawn').length, 2);
    for (const call of named(run, 'spawn')) assert.equal(call.args[0], join(f.root, 'resources/server/node'));
    for (const menu of run.menus) for (const item of menu) {
      if (item.label === 'Start at Login' || item.label === 'Install CLI to Terminal') {
        assert.equal(item.enabled, false);
        await (item.click as (item: { checked: boolean }) => unknown)({ checked: true });
      }
    }
    for (const name of forbidden) assert.equal(named(run, name).length, 0, name);
  } finally { f.dispose(); }
});

test('malformed QA raw input is rejected before paths, lock, origin-dependent bootstrap or execution', async () => {
  const f = fixture();
  const cases: Array<[NodeJS.ProcessEnv, string[]]> = [
    [{ CLI_JAW_ISOLATED_QA_ROOT: '' }, []], [{ HOME: join(f.root, 'worker') }, []],
    [{ DASHBOARD_PORT: '0' }, []], [{ DASHBOARD_SCAN_FROM: '31401' }, []],
    [{ JAW_MANAGER_PORT: '0' }, []], [{ JAW_MANAGER_URL: '' }, []],
    [{ JAW_MANAGER_URL: 'http://localhost:31401/' }, []], [{ JAW_MANAGER_URL: 'http://127.0.0.1:31401/?x=1' }, []],
    [{}, ['--port']], [{}, ['--port=0']], [{}, ['--port=31402']], [{}, ['--port=31401junk']],
    [{}, ['--manager-url']], [{}, ['--manager-url=']], [{}, ['--manager-url=http://127.0.0.1:31401']],
    [{}, ['--spawn', '--attach-only']], [{ PATH: 'relative/bin' }, []],
  ];
  try {
    for (const [patch, argv] of cases) {
      const run = launch({ ...f.env, ...patch }, f.root, argv); await run.settle();
      assert.ok(run.error, JSON.stringify({ keys: Object.keys(patch), argv }));
      assert.match(String(run.error), /isolated[-_]qa/);
      assert.equal(run.calls.length, 0);
    }
    const env = { ...f.env }; delete env.JAW_MANAGER_URL;
    assert.ok(launch(env, f.root, []).error);
    const validFlag = launch(env, f.root, ['--manager-url=http://127.0.0.1:31401/', '--port', '31401', '--attach-only']);
    await validFlag.settle(); assert.equal(validFlag.error, undefined); assert.equal(named(validFlag, 'spawn').length, 0);
    assert.equal(named(validFlag, 'window').length, 1);
  } finally { f.dispose(); }
});

test('QA packaged failure never probes personal candidates or opens chooser, including repeated bootstrap', async () => {
  const f = fixture();
  try {
    for (const options of [{ packaged: false }, { probeFailure: true }]) {
      const run = launch(f.env, f.root, ['--spawn'], options); await run.settle();
      assert.equal(named(run, 'spawn').length, 0); assert.equal(named(run, 'error').length, 1);
      run.app.emit('open-url', { preventDefault() {} }, 'jaw://open?path=/'); await run.settle();
      for (const name of forbidden) assert.equal(named(run, name).length, 0, name);
      assert.ok(named(run, 'exec').every(call => call.args[0] === join(f.root, 'resources/server/node')));
    }
    rmSync(join(f.root, 'resources/server/node'));
    const missing = launch(f.env, f.root); await missing.settle();
    assert.equal(named(missing, 'exec').length, 0); assert.equal(named(missing, 'spawn').length, 0);
    assert.equal(named(missing, 'showJawNotFoundDialog').length, 0);
  } finally { f.dispose(); }
});

for (const fault of [
  { status:1, signal:null, code:'ETIMEDOUT' }, { status:1, signal:null, code:'ENOBUFS' },
  { status:1, signal:null, code:'ENOENT' }, { status:1, signal:null, code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
  { status:1, signal:'SIGTERM' },
]) test(`QA refuses mixed probe failure ${fault.code ?? fault.signal} even with status-one help`, async () => {
  const f=fixture();
  try {
    const run=launch(f.env,f.root,['--spawn'],{probeFault:fault}); await run.settle();
    assert.equal(named(run,'spawn').length,0,'failed probe cannot authorize a Manager spawn');
    assert.equal(named(run,'error').length,1);
    for (const name of forbidden) assert.equal(named(run,name).length,0,name);
  } finally { f.dispose(); }
});

test('normal startup retains protocol, installer, login, shortcut, Automation and direct menu behavior', async () => {
  const f = fixture();
  try {
    const env = { PATH: '/usr/bin:/bin', JAW_MANAGER_URL: 'http://127.0.0.1:31401/' };
    const run = launch(env, f.root, ['--attach-only']); await run.settle();
    assert.equal(run.error, undefined); assert.equal(named(run, 'error').length, 0);
    assert.equal(named(run, 'setPath').length, 0); assert.equal(named(run, 'lock').length, 1);
    for (const name of ['protocol', 'login', 'shortcut', 'primeMacAutomationPermission', 'promptInstallCli']) assert.equal(named(run, name).length, 1, name);
    const menu = run.menus.find(items => items.some(item => item.label === 'Start at Login'))!;
    const login = menu.find(item => item.label === 'Start at Login')!;
    assert.equal(login.enabled, true); (login.click as (item: { checked: boolean }) => void)({ checked: true });
    assert.equal(named(run, 'login').length, 2);
    await (menu.find(item => item.label === 'Install CLI to Terminal')!.click as () => Promise<void>)();
    assert.equal(named(run, 'installCli').length, 1);
    const denied = launch(f.env, f.root, ['--spawn'], { lock: false }); await denied.settle();
    assert.equal(named(denied, 'quit').length, 1); assert.equal(named(denied, 'session').length, 0);
    assert.equal(named(denied, 'spawn').length, 0);
  } finally { f.dispose(); }
});

test('normal missing-sidecar path retains fix-path, lookup and the file-picker fallback', async () => {
  const f = fixture();
  try {
    const run = launch({ PATH: '/usr/bin:/bin', HOME: join(f.root, 'home'), JAW_MANAGER_URL: 'http://127.0.0.1:31401/' },
      f.root, ['--spawn'], { packaged: false });
    await run.settle();
    assert.equal(run.error, undefined);
    assert.equal(named(run, 'fixPath').length, 1);
    assert.ok(named(run, 'exec').some(call => call.args[0] === 'which'));
    assert.equal(named(run, 'showJawNotFoundDialog').length, 1);
    assert.equal(named(run, 'picker').length, 1);
  } finally { f.dispose(); }
});

test('Windows QA chooses bundled native node.exe without a cmd shell and receives mapped profile roots', async () => {
  const f = fixture();
  try {
    const run = launch(f.env, f.root, ['--spawn', '--background'], { platform: 'win32' }); await run.settle();
    assert.equal(run.error, undefined); assert.equal(named(run, 'error').length, 0);
    const [command, argv, opts] = named(run, 'spawn')[0].args as [string, string[], { shell?: boolean; env: NodeJS.ProcessEnv }];
    assert.equal(command, join(f.root, 'resources/server/node.exe'));
    assert.equal(argv[0], join(f.root, 'resources/server/dist/bin/cli-jaw.js')); assert.equal(opts.shell, undefined);
    assert.equal(opts.env.USERPROFILE, join(f.root, 'home'));
    assert.equal(opts.env.APPDATA, join(f.root, 'xdg/data')); assert.equal(opts.env.LOCALAPPDATA, join(f.root, 'xdg/cache'));
    assert.equal(named(run, 'window').length, 0);
    for (const name of forbidden) assert.equal(named(run, name).length, 0, name);
  } finally { f.dispose(); }
});

function assertNoNumericCleanup(run: ReturnType<typeof launch>) {
  assert.equal(named(run, 'numericKill').length, 0);
  assert.equal(named(run, 'killProcessTree').length, 0);
  assert.ok(named(run, 'exec').every(call => call.args[0] !== 'pgrep'));
}

test('QA quit observes cooperative exit/close via retained handle; normal quit retains numeric cleanup', async () => {
  const f = fixture();
  try {
    const run = launch(f.env, f.root); await run.settle();
    run.app.emit('before-quit', { preventDefault() {} }); await run.settle();
    assert.deepEqual(named(run, 'handleKill').map(call => call.args), [['SIGTERM']]);
    assert.deepEqual(named(run, 'exit').map(call => call.args), [[0]]);
    assertNoNumericCleanup(run);
    const normal = launch({ PATH: '/usr/bin:/bin', JAW_MANAGER_URL: 'http://127.0.0.1:31401/' }, f.root, ['--spawn']);
    await normal.settle();
    normal.app.emit('before-quit', { preventDefault() {} }); await normal.settle();
    normal.deadline(100); await normal.settle();
    assert.ok(named(normal, 'killProcessTree').some(call => call.args[1] === 'SIGTERM'));
    assert.ok(named(normal, 'exec').some(call => call.args[0] === 'pgrep'));
    assert.equal(named(normal, 'handleKill').length, 0);
    assert.deepEqual(named(normal, 'exit').map(call => call.args), [[0]]);
  } finally { f.dispose(); }
});

test('QA deadline retains uncertainty, forbids future signals/restart, and never claims clean app exit', async () => {
  const f = fixture();
  try {
    for (const action of ['quit', 'restart']) {
      const run = launch(f.env, f.root, ['--spawn'], { cooperative: false }); await run.settle();
      const restart = run.menus.flat().find(item => item.label === 'Restart Server')!.click as () => void;
      if (action === 'quit') run.app.emit('before-quit', { preventDefault() {} }); else restart();
      await run.settle();
      assert.equal(named(run, 'handleKill').length, 1);
      run.deadline(5000); await run.settle();
      assert.equal(named(run, 'exit').length, 0);
      assert.ok(named(run, 'error').some(call => String(call.args[0]).includes('cleanup uncertain')));
      delete run.env.CLI_JAW_ISOLATED_QA_ROOT;
      run.children[0].pid = 99123; run.children[0].exitCode = null; run.children[0].signalCode = null;
      restart(); run.app.emit('before-quit', { preventDefault() {} }); await run.settle();
      assert.equal(named(run, 'spawn').length, 1); assert.equal(named(run, 'handleKill').length, 1);
      assert.equal(named(run, 'exit').length, 0); assertNoNumericCleanup(run);
    }
  } finally { f.dispose(); }
});

test('spawn-time exit/error latches survive reused-looking fields and shutdown after reaping', async () => {
  const f = fixture();
  try {
    for (const terminal of ['cooperative', 'signal', 'error', 'close-only']) {
      const run = launch(f.env, f.root, ['--spawn'], { cooperative: false }); await run.settle();
      const child = run.children[0];
      if (terminal === 'cooperative') { child.emit('exit', 0, null); child.emit('close', 0, null); }
      if (terminal === 'signal') child.emit('exit', null, 'SIGTERM');
      if (terminal === 'error') child.emit('error', new Error('fixture error'));
      if (terminal === 'close-only') child.emit('close', 0, null);
      child.pid = 91919; child.exitCode = null; child.signalCode = null;
      const shutdown = run.api.gracefulShutdown(child as unknown as ChildProcess, 100);
      if (terminal === 'cooperative') await shutdown;
      else await assert.rejects(shutdown, /cleanup uncertain/);
      await run.settle(); run.deadline(100); await run.settle();
      if (terminal !== 'cooperative') {
        run.app.emit('before-quit', { preventDefault() {} }); await run.settle();
        assert.equal(named(run, 'exit').length, 0);
        assert.ok(named(run, 'error').some(call => String(call.args[0]).includes('cleanup uncertain')));
      }
      assert.equal(named(run, 'handleKill').length, 0); assertNoNumericCleanup(run);
    }
  } finally { f.dispose(); }
});

test('QA changed PID, unobserved exit/signalCode and disappearance revoke retained authority permanently', async () => {
  const f = fixture();
  try {
    for (const state of ['pid', 'exitCode', 'signalCode', 'missing', 'false-kill', 'throw-kill']) {
      const run = launch(f.env, f.root, ['--spawn'], { cooperative: false }); await run.settle();
      const child = run.children[0];
      if (state === 'pid') child.pid = 90001;
      if (state === 'exitCode') child.exitCode = 0;
      if (state === 'signalCode') child.signalCode = 'SIGTERM';
      if (state === 'missing') child.pid = undefined;
      if (state === 'false-kill') child.killResult = false;
      if (state === 'throw-kill') child.killError = Object.assign(new Error('gone'), { code: 'ESRCH' });
      await assert.rejects(run.api.gracefulShutdown(child as unknown as ChildProcess, 100), /cleanup uncertain/);
      const signals = named(run, 'handleKill').length;
      assert.equal(signals, state.endsWith('kill') ? 1 : 0);
      child.pid = 41001; child.exitCode = null; child.signalCode = null; child.killResult = true; child.killError = null;
      await assert.rejects(run.api.gracefulShutdown(child as unknown as ChildProcess, 100), /cleanup uncertain/);
      assert.equal(named(run, 'handleKill').length, signals); assertNoNumericCleanup(run);
    }
    const run = launch(f.env, f.root, ['--spawn'], { cooperative: false }); await run.settle();
    const unowned = Object.assign(new EventEmitter(), { pid: 41001, exitCode: null, signalCode: null,
      kill: () => { throw new Error('must not signal unowned child'); } });
    await assert.rejects(run.api.gracefulShutdown(unowned as ChildProcess, 100, readIsolatedQaPolicy(f.env, 'electron')), /unowned child/);
    assertNoNumericCleanup(run);
  } finally { f.dispose(); }
});

test('exit before grace expiry never escalates; close is required and late close cannot erase timeout failure', async () => {
  const f = fixture();
  try {
    for (const closeBeforeDeadline of [true, false]) {
      const run = launch(f.env, f.root, ['--spawn'], { cooperative: false }); await run.settle();
      const child = run.children[0];
      const shutdown = run.api.gracefulShutdown(child as unknown as ChildProcess, 100);
      const observed = shutdown.then(() => 'complete', () => 'uncertain');
      child.emit('exit', 0, null);
      child.pid = 91919; child.signalCode = null; child.exitCode = null;
      if (closeBeforeDeadline) child.emit('close', 0, null);
      run.deadline(100);
      if (!closeBeforeDeadline) child.emit('close', 0, null);
      assert.equal(await observed, closeBeforeDeadline ? 'complete' : 'uncertain');
      assert.deepEqual(named(run, 'handleKill').map(call => call.args), [['SIGTERM']]);
      assertNoNumericCleanup(run);
    }
  } finally { f.dispose(); }
});
