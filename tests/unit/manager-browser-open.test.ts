import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOpenCommand } from '../../src/core/browser-open.js';
import {
    isHeadlessBrowserEnvironment,
    shouldOpenBrowserByDefault,
} from '../../src/core/browser-open-default.js';
import type { PlatformProbes } from '../../src/core/platform-kind.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

/**
 * Detection now consults the filesystem, so the "desktop Linux" rows must
 * inject inert probes. Without them a WSL CI runner would see the host's real
 * /proc markers and classify these fixtures as WSL.
 */
const inertProbes: PlatformProbes = {
    readText: () => null,
    exists: () => false,
    release: () => '',
};

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('native win32 opener uses cmd start with the URL as the fourth arg (#383)', () => {
    assert.deepEqual(browserOpenCommand('http://localhost:24576', 'win32', {}, inertProbes), {
        command: 'cmd',
        args: ['/c', 'start', '', 'http://localhost:24576'],
    });
});

test('native win32 opener escapes cmd metacharacters in multi-param URLs (#383)', () => {
    // cmd.exe re-parses the start line, so an unescaped & splits the URL and
    // truncates the query string - the exact token-bearing-link failure.
    assert.deepEqual(browserOpenCommand('http://localhost:3457/?a=1&b=2', 'win32', {}, inertProbes), {
        command: 'cmd',
        args: ['/c', 'start', '', 'http://localhost:3457/?a=1^&b=2'],
    });
});

test('WSL opener escapes cmd metacharacters too (#383)', () => {
    const command = browserOpenCommand('http://localhost:24576/?x=1&y=2', 'linux', {
        WSL_DISTRO_NAME: 'Ubuntu',
    }, inertProbes);
    assert.deepEqual(command.args, ['/c', 'start', '', 'http://localhost:24576/?x=1^&y=2']);
});

test('dashboard browser opener uses Windows shell from WSL', () => {
    const command = browserOpenCommand('http://localhost:24576', 'linux', {
        WSL_DISTRO_NAME: 'Ubuntu',
    }, inertProbes);

    assert.deepEqual(command, {
        command: 'cmd.exe',
        args: ['/c', 'start', '', 'http://localhost:24576'],
    });
});

test('the absolute /mnt/c cmd.exe path wins when it is present', () => {
    const mountedProbes: PlatformProbes = {
        readText: () => null,
        exists: (path) => path === '/mnt/c/Windows/System32/cmd.exe',
        release: () => '',
    };

    assert.deepEqual(
        browserOpenCommand('http://localhost:24576', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }, mountedProbes),
        {
            command: '/mnt/c/Windows/System32/cmd.exe',
            args: ['/c', 'start', '', 'http://localhost:24576'],
        },
    );
});

test('dashboard browser opener keeps Linux xdg-open for desktop Linux', () => {
    const command = browserOpenCommand('http://localhost:24576', 'linux', {
        DISPLAY: ':0',
    }, inertProbes);

    assert.deepEqual(command, {
        command: 'xdg-open',
        args: ['http://localhost:24576'],
    });
});

test('a WSL kernel marker wins over a set DISPLAY', () => {
    const wslKernelProbes: PlatformProbes = {
        readText: (path) => (path === '/proc/version'
            ? 'Linux version 5.15.0-microsoft-standard-WSL2'
            : null),
        exists: () => false,
        release: () => '',
    };

    // Env carries no WSL variable at all: the kernel probe is the only signal.
    assert.equal(isHeadlessBrowserEnvironment({ DISPLAY: ':0' }, 'linux', wslKernelProbes), true);
    assert.deepEqual(
        browserOpenCommand('http://localhost:24576', 'linux', { DISPLAY: ':0' }, wslKernelProbes),
        { command: 'cmd.exe', args: ['/c', 'start', '', 'http://localhost:24576'] },
    );
});

test('dashboard does not auto-open by default in headless and WSL environments', () => {
    assert.equal(shouldOpenBrowserByDefault({ WSL_INTEROP: '/run/WSL/1_interop' }, 'linux', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({}, 'linux', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ CI: 'true' }, 'darwin', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ DISPLAY: ':0' }, 'linux', inertProbes), true);
    assert.equal(isHeadlessBrowserEnvironment({ SSH_CONNECTION: 'host 22 host 12345' }, 'linux', inertProbes), true);
});

test('dashboard opener failure is logged without crashing the manager', () => {
    const browserOpen = read('src/core/browser-open.ts');

    assert.ok(browserOpen.includes("opener.on('error'"), 'opener spawn errors must be handled');
    assert.ok(browserOpen.includes('failed to open browser automatically'), 'failure must be visible to the user');
    assert.ok(browserOpen.includes('open manually'), 'manual URL fallback must be printed');
});

test('a background service runtime never auto-opens a browser', () => {
    assert.equal(shouldOpenBrowserByDefault({ CLI_JAW_RUNTIME: 'launchd' }, 'darwin', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ CLI_JAW_RUNTIME: 'systemd', DISPLAY: ':0' }, 'linux', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ JAW_NO_BROWSER: '1' }, 'darwin', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ JAW_OPEN_BROWSER: '0' }, 'darwin', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({}, 'darwin', inertProbes), true);
});
