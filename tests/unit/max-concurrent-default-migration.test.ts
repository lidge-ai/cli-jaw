import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
    applyMaxConcurrentDefaultMigration,
    DEFAULT_SETTINGS,
    JAW_HOME,
    loadSettings,
    SETTINGS_PATH,
} from '../../src/core/config.ts';
import { resolveMultiSessionDefaultMigration } from '../../src/core/runtime-settings.ts';

function document(maxConcurrent: number) {
    const value = structuredClone(DEFAULT_SETTINGS);
    value.cli = 'codex-app';
    value.workingDir = JAW_HOME;
    value.nativeTransportMigration = {
        id: 'native-transport-default-v1',
        state: 'already-native',
    };
    value.maxConcurrentDefaultMigration = null;
    value.multiSession = { ...value.multiSession, enabled: true, maxConcurrent };
    return value;
}

function writeSettings(value: unknown) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(value));
}

function disk(): Record<string, any> {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
}

test.beforeEach(() => {
    if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
});

test('stored 2 becomes 20 with applied stamp on memory and disk', () => {
    writeSettings(document(2));
    const loaded = loadSettings();
    assert.equal(loaded.multiSession.maxConcurrent, 20);
    assert.deepEqual(loaded.maxConcurrentDefaultMigration, {
        id: 'max-concurrent-default-v1',
        state: 'applied',
        from: 2,
        to: 20,
    });
    assert.equal(disk().multiSession.maxConcurrent, 20);
    assert.equal(disk().maxConcurrentDefaultMigration.state, 'applied');
});

test('stored 1 stays 1 with left-in-place', () => {
    writeSettings(document(1));
    const loaded = loadSettings();
    assert.equal(loaded.multiSession.maxConcurrent, 1);
    assert.equal(loaded.maxConcurrentDefaultMigration?.state, 'left-in-place');
    assert.equal(loaded.maxConcurrentDefaultMigration?.from, 1);
    assert.equal(disk().multiSession.maxConcurrent, 1);
});

test('stored 4 stays 4 with left-in-place', () => {
    writeSettings(document(4));
    const loaded = loadSettings();
    assert.equal(loaded.multiSession.maxConcurrent, 4);
    assert.equal(loaded.maxConcurrentDefaultMigration?.state, 'left-in-place');
    assert.equal(loaded.maxConcurrentDefaultMigration?.from, 4);
});

test('stored 20 stays 20 with already-at-target', () => {
    writeSettings(document(20));
    const loaded = loadSettings();
    assert.equal(loaded.multiSession.maxConcurrent, 20);
    assert.deepEqual(loaded.maxConcurrentDefaultMigration, {
        id: 'max-concurrent-default-v1',
        state: 'already-at-target',
        from: 20,
        to: 20,
    });
});

test('after applied stamp, explicit 2 survives reload', () => {
    writeSettings(document(2));
    loadSettings();
    const next = disk();
    next.multiSession.maxConcurrent = 2;
    writeSettings(next);
    const loaded = loadSettings();
    assert.equal(loaded.multiSession.maxConcurrent, 2);
    assert.equal(disk().multiSession.maxConcurrent, 2);
});

test('accept-path fallback is the product default 20', () => {
    const home = {
        ...structuredClone(DEFAULT_SETTINGS),
        multiSession: { ...DEFAULT_SETTINGS.multiSession, enabled: false, maxConcurrent: 1 },
        multiSessionDefaultMigration: { id: 'multi-session-default-v3', state: 'pending' },
    };
    const patch = resolveMultiSessionDefaultMigration(home, 'accept');
    assert.equal(patch.multiSession.maxConcurrent, DEFAULT_SETTINGS.multiSession.maxConcurrent);
    assert.equal(patch.multiSession.maxConcurrent, 20);
});

test('exported helper skips a stamped object', () => {
    const s = {
        multiSession: { enabled: true, maxConcurrent: 2 },
        maxConcurrentDefaultMigration: { id: 'max-concurrent-default-v1', state: 'applied', from: 2, to: 20 },
    };
    assert.deepEqual(applyMaxConcurrentDefaultMigration(s), { didChange: false });
    assert.equal(s.multiSession.maxConcurrent, 2);
});
