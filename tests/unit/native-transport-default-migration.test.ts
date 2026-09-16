import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
    applyNativeTransportDefaultMigration,
    DB_PATH,
    DEFAULT_SETTINGS,
    isSettingsPersistenceBlocked,
    JAW_HOME,
    loadSettings,
    SETTINGS_PATH,
} from '../../src/core/config.ts';
import { runtimeSessionBucket } from '../../src/agent/runtime/selection.ts';

const engines = ['cursor', 'grok', 'claude'] as const;

function document() {
    const value = structuredClone(DEFAULT_SETTINGS);
    value.cli = 'codex-app';
    value.workingDir = JAW_HOME;
    value.nativeTransportMigration = null;
    value.maxConcurrentDefaultMigration = null;
    return value;
}

function writeSettings(value: unknown) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(value));
}

function disk(): Record<string, any> {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
}

function modesOf(value: Record<string, any>) {
    return engines.map(cli => value.perCli[cli].transport);
}

test.beforeEach(() => {
    if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

test('v4 absent transports + auto become native on memory and disk', () => {
    const existing = document();
    existing.permissions = 'auto';
    for (const cli of engines) delete existing.perCli[cli]!.transport;
    existing.perCli.cursor = {
        ...existing.perCli.cursor!,
        model: 'stored-model',
        effort: 'low',
        auth: { profile: 'stored-auth' },
    };
    existing.messaging = {
        ...existing.messaging,
        enabledChannels: ['slack'],
        homeChannel: 'slack',
    };
    writeSettings(existing);

    const loaded = loadSettings();
    assert.deepEqual(modesOf(loaded), ['native', 'native', 'native']);
    assert.equal(['applied', 'already-native'].includes(loaded.nativeTransportMigration?.state ?? ''), true);
    assert.equal(loaded.perCli.cursor.model, 'stored-model');
    assert.equal(loaded.perCli.cursor.effort, 'low');
    assert.deepEqual(loaded.perCli.cursor.auth, { profile: 'stored-auth' });
    assert.deepEqual(loaded.messaging.enabledChannels, ['slack']);

    const written = disk();
    assert.deepEqual(modesOf(written), ['native', 'native', 'native']);
    assert.equal(written.nativeTransportMigration.state, loaded.nativeTransportMigration.state);
    assert.equal(written.perCli.cursor.model, 'stored-model');
    assert.deepEqual(written.messaging.enabledChannels, ['slack']);
    assert.equal(written.messaging.homeChannel, 'slack');

    const again = loadSettings();
    assert.deepEqual(modesOf(again), ['native', 'native', 'native']);
    assert.equal(again.nativeTransportMigration.state, loaded.nativeTransportMigration.state);
});

test('safe permissions flip only claude and stamp partial', () => {
    const existing = document();
    existing.permissions = 'safe';
    for (const cli of engines) existing.perCli[cli]!.transport = 'print';
    writeSettings(existing);

    const loaded = loadSettings();
    assert.deepEqual(modesOf(loaded), ['print', 'print', 'native']);
    assert.equal(loaded.nativeTransportMigration?.state, 'partial');
    assert.deepEqual(loaded.nativeTransportMigration?.skipped, [
        { cli: 'cursor', reason: 'restrictive_permissions' },
        { cli: 'grok', reason: 'restrictive_permissions' },
    ]);
    assert.deepEqual(modesOf(disk()), ['print', 'print', 'native']);
});

test('custom permissions leave all three print and skip claude', () => {
    for (const permissions of ['custom', ['read']]) {
        const existing = document();
        existing.permissions = permissions as typeof existing.permissions;
        for (const cli of engines) existing.perCli[cli]!.transport = 'print';
        writeSettings(existing);

        const loaded = loadSettings();
        assert.deepEqual(modesOf(loaded), ['print', 'print', 'print'], String(permissions));
        assert.equal(loaded.nativeTransportMigration?.state, 'partial');
        assert.ok(loaded.nativeTransportMigration?.skipped?.some(
            row => row.cli === 'claude' && row.reason === 'unsupported_claude_policy',
        ));
    }
});

test('post-stamp explicit print survives reload', () => {
    const existing = document();
    for (const cli of engines) delete existing.perCli[cli]!.transport;
    writeSettings(existing);
    const first = loadSettings();
    assert.deepEqual(modesOf(first), ['native', 'native', 'native']);

    const next = disk();
    next.perCli.cursor.transport = 'print';
    writeSettings(next);
    const loaded = loadSettings();
    assert.equal(loaded.perCli.cursor.transport, 'print');
    assert.equal(loaded.perCli.grok.transport, 'native');
    assert.equal(disk().perCli.cursor.transport, 'print');
});

test('partial stamp is not finished when permissions later become auto', () => {
    const existing = document();
    existing.permissions = 'safe';
    for (const cli of engines) existing.perCli[cli]!.transport = 'print';
    writeSettings(existing);
    loadSettings();

    const next = disk();
    next.permissions = 'auto';
    writeSettings(next);
    const loaded = loadSettings();
    assert.deepEqual(modesOf(loaded), ['print', 'print', 'native']);
    assert.equal(loaded.nativeTransportMigration?.state, 'partial');
});

test('runtimeSessionBucket prefix is unchanged', () => {
    assert.equal(runtimeSessionBucket('x', 'print'), 'x');
    assert.equal(runtimeSessionBucket('x', 'native'), 'native-v1:x');
});

test('established missing-file stays print across two loads', () => {
    writeFileSync(DB_PATH, 'established-home-marker');
    const first = loadSettings();
    assert.deepEqual(modesOf(first), ['print', 'print', 'print']);
    assert.equal(first.nativeTransportMigration?.state, 'left-in-place');
    assert.equal(first.maxConcurrentDefaultMigration?.state, 'left-in-place');
    assert.equal(first.multiSession.maxConcurrent, 1);
    const written = disk();
    assert.equal(written.nativeTransportMigration.state, 'left-in-place');
    const second = loadSettings();
    assert.deepEqual(modesOf(second), ['print', 'print', 'print']);
    assert.equal(second.multiSession.maxConcurrent, 1);
});

test('fresh missing-file stays native across two loads', () => {
    const first = loadSettings();
    assert.deepEqual(modesOf(first), ['native', 'native', 'native']);
    assert.equal(first.nativeTransportMigration?.state, 'already-native');
    assert.equal(first.maxConcurrentDefaultMigration?.state, 'already-at-target');
    assert.equal(first.multiSession.maxConcurrent, 20);
    const second = loadSettings();
    assert.deepEqual(modesOf(second), ['native', 'native', 'native']);
    assert.equal(second.maxConcurrentDefaultMigration?.state, 'already-at-target');
});

test('persisted partial + from/to stamps reload without latch', () => {
    const existing = document();
    existing.nativeTransportMigration = {
        id: 'native-transport-default-v1',
        state: 'partial',
        skipped: [{ cli: 'cursor', reason: 'restrictive_permissions' }],
    };
    existing.maxConcurrentDefaultMigration = {
        id: 'max-concurrent-default-v1',
        state: 'applied',
        from: 2,
        to: 20,
    };
    existing.perCli.cursor!.transport = 'print';
    existing.perCli.grok!.transport = 'native';
    existing.perCli.claude!.transport = 'native';
    writeSettings(existing);

    const loaded = loadSettings();
    assert.equal(isSettingsPersistenceBlocked(), false);
    assert.equal(loaded.nativeTransportMigration?.state, 'partial');
    assert.equal(loaded.maxConcurrentDefaultMigration?.from, 2);
    assert.equal(loaded.perCli.cursor.transport, 'print');
});

test('exported helper skips a stamped object', () => {
    const s = {
        permissions: 'auto',
        perCli: { cursor: { transport: 'print' }, grok: { transport: 'print' }, claude: { transport: 'print' } },
        nativeTransportMigration: { id: 'native-transport-default-v1', state: 'applied' },
    };
    assert.deepEqual(applyNativeTransportDefaultMigration(s), { didChange: false });
    assert.equal(s.perCli.cursor.transport, 'print');
});
