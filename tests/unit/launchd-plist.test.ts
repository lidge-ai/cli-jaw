// P04C: launchd plist generator — session keys for TCC/Computer Use
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { generateLaunchdPlist, type PlistOptions } from '../../src/core/launchd-plist.js';

const defaults: PlistOptions = {
    label: 'com.cli-jaw.default',
    port: '3457',
    nodePath: '/usr/local/bin/node',
    jawPath: '/usr/local/bin/jaw',
    jawHome: '/Users/u/.cli-jaw',
    logDir: '/Users/u/.cli-jaw/logs',
    servicePath: '/usr/local/bin:/usr/bin:/bin',
};

test('P04C-001: plist contains ProcessType=Interactive', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
});

test('P04C-002: plist must NOT set SessionCreate (preserves caller audit session)', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.doesNotMatch(plist, /SessionCreate/);
});

test('P04C-003: plist preserves LimitLoadToSessionType=Aqua (regression)', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
});

test('P04C-004: plist includes --port and --home with correct values', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<string>--port<\/string>/);
    assert.match(plist, /<string>--home<\/string>/);
    assert.match(plist, /<string>3457<\/string>/);
    assert.match(plist, /<string>\/Users\/u\/\.cli-jaw<\/string>/);
});

test('P04C-005: plist escapes XML special characters in jawHome', () => {
    const plist = generateLaunchdPlist({
        ...defaults,
        jawHome: '/tmp/with&ampersand',
    });
    assert.match(plist, /with&amp;ampersand/);
    assert.doesNotMatch(plist, /with&ampersand</);
});

test('P04C-006: plist is valid XML (plutil -lint)', { skip: process.platform !== 'darwin' }, () => {
    const tmp = '/tmp/jaw-test-plist-' + process.pid + '.plist';
    writeFileSync(tmp, generateLaunchdPlist(defaults));
    try {
        execSync(`plutil -lint "${tmp}"`, { stdio: 'pipe' });
    } finally {
        try { unlinkSync(tmp); } catch { /* ok */ }
    }
});

test('P04C-007: plist sets RunAtLoad and KeepAlive', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('P04C-008: plist sets CLI_JAW_HOME env var', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>CLI_JAW_HOME<\/key>\s*<string>\/Users\/u\/\.cli-jaw<\/string>/);
});

// #393: a macOS service is not started from a login shell, so anything the user put in
// ~/.zshenv is absent. cursor-agent refuses to run on macOS when it also sees an
// SSH-looking session and the default credential store, and tells the user to unlock a
// keychain a background service cannot unlock. The result was a runtime that worked
// under `jaw serve` and died under the service on the same machine.
test('P04C-009: the plist carries the credential-store escape hatch on macOS', () => {
    const rendered = generateLaunchdPlist({
        label: 'com.cli-jaw.default',
        port: '3457',
        nodePath: '/usr/local/bin/node',
        jawPath: '/usr/local/bin/jaw',
        jawHome: '/Users/someone/.cli-jaw',
        logDir: '/Users/someone/.cli-jaw/logs',
        servicePath: '/usr/bin:/bin',
        extraEnv: { AGENT_CLI_CREDENTIAL_STORE: 'file' },
    });

    assert.match(rendered, /<key>AGENT_CLI_CREDENTIAL_STORE<\/key>\s*<string>file<\/string>/);
    // The keys it already carried must survive alongside it.
    assert.match(rendered, /<key>CLI_JAW_HOME<\/key>/);
    assert.match(rendered, /<key>CLI_JAW_RUNTIME<\/key>\s*<string>launchd<\/string>/);
});

test('P04C-010: no extra env renders exactly the previous dict', () => {
    const base = {
        label: 'com.cli-jaw.default',
        port: '3457',
        nodePath: '/usr/local/bin/node',
        jawPath: '/usr/local/bin/jaw',
        jawHome: '/Users/someone/.cli-jaw',
        logDir: '/Users/someone/.cli-jaw/logs',
        servicePath: '/usr/bin:/bin',
    };

    const withNone = generateLaunchdPlist(base);
    const withEmpty = generateLaunchdPlist({ ...base, extraEnv: {} });

    assert.equal(withNone, withEmpty, 'an empty map must not leave a stray line behind');
    assert.ok(!withNone.includes('AGENT_CLI_CREDENTIAL_STORE'));
});

test('P04C-011: extra env values are XML-escaped like every other field', () => {
    const rendered = generateLaunchdPlist({
        label: 'com.cli-jaw.default',
        port: '3457',
        nodePath: '/usr/local/bin/node',
        jawPath: '/usr/local/bin/jaw',
        jawHome: '/Users/someone/.cli-jaw',
        logDir: '/Users/someone/.cli-jaw/logs',
        servicePath: '/usr/bin:/bin',
        extraEnv: { WEIRD: 'a & b < c' },
    });

    assert.match(rendered, /<string>a &amp; b &lt; c<\/string>/);
});

test('P04C-012: launchd serve never auto-opens a browser on (re)start', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<string>--no-open<\/string>/, 'a KeepAlive respawn must not pop a browser window');
});
