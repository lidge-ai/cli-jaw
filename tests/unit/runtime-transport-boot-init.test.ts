import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as registry from '../../src/cli/registry.ts';

const engines = ['cursor', 'grok', 'claude'] as const;
const root = resolve(import.meta.dirname, '../..');
let pickerCalls = 0;
mock.module(resolve(root, 'src/cli/registry.js'), { namedExports: {
    ...registry,
    buildDefaultPerCli: () => {
        const defaults = registry.buildDefaultPerCli();
        for (const cli of engines) defaults[cli] = { ...defaults[cli]!, transport: 'native' };
        return defaults;
    },
} });
mock.module(resolve(root, 'src/cli/readiness.js'), { namedExports: {
    pickFirstReadyCli: () => { pickerCalls++; return 'codex-app'; },
} });
const config = await import('../../src/core/config.ts');

function document() {
    const value = structuredClone(config.DEFAULT_SETTINGS);
    value.cli = 'codex-app';
    value.workingDir = config.JAW_HOME;
    return value;
}
function writeSettings(value: unknown) {
    writeFileSync(config.SETTINGS_PATH, typeof value === 'string' ? value : JSON.stringify(value));
}
function assertModes(value: Record<string, any>, expected: readonly string[]) {
    assert.deepEqual(engines.map(cli => value.perCli[cli].transport), expected);
}
test.beforeEach(t => {
    t.mock.method(console, 'warn', () => {});
    pickerCalls = 0;
    if (existsSync(config.SETTINGS_PATH)) unlinkSync(config.SETTINGS_PATH);
});

test('future-native factory is real, and a genuinely fresh boot persists its choices', () => {
    assertModes(config.DEFAULT_SETTINGS, ['native', 'native', 'native']);
    assert.equal(config.isEstablishedHome(), false);
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 1);
    assertModes(loaded, ['native', 'native', 'native']);
    assertModes(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')), ['native', 'native', 'native']);
});

test('current existing document migrates absent transports to native after the print pin', () => {
    const existing = document();
    for (const cli of engines) delete existing.perCli[cli]!.transport;
    existing.perCli.cursor = { ...existing.perCli.cursor!, model: 'stored-model', effort: 'low' };
    const input = { ...existing, perCli: { ...existing.perCli,
        cursor: { ...existing.perCli.cursor, auth: { profile: 'stored-auth' } },
    } };
    writeSettings(input);
    const loaded = config.loadSettings();
    assertModes(loaded, ['native', 'native', 'native']);
    assert.equal(loaded.perCli.cursor.model, 'stored-model');
    assert.equal(loaded.perCli.cursor.effort, 'low');
    assert.deepEqual(loaded.perCli.cursor.auth, { profile: 'stored-auth' });
    assert.equal(pickerCalls, 0);
    const written = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    assertModes(written, ['native', 'native', 'native']);
    assert.equal(written.perCli.cursor.model, 'stored-model');
    assert.deepEqual(written.perCli.cursor.auth, { profile: 'stored-auth' });
});

test('legacy missing perCli and unstamped print become native', () => {
    writeSettings({ cli: 'claude' });
    assertModes(config.loadSettings(), ['native', 'native', 'native']);
    const existing = document();
    existing.nativeTransportMigration = null;
    existing.perCli.cursor!.transport = 'native';
    existing.perCli.grok!.transport = 'print';
    delete existing.perCli.claude!.transport;
    writeSettings(existing);
    assertModes(config.loadSettings(), ['native', 'native', 'native']);
    assert.equal(pickerCalls, 0);
});

test('boot invalid transport is removed before defaults without losing siblings', () => {
    const existing = document();
    writeSettings({ ...existing, perCli: { ...existing.perCli,
        cursor: { model: 'stored-model', effort: 'high', transport: { bad: true }, auth: { profile: 'keep' } },
    } });
    const loaded = config.loadSettings();
    assert.equal(loaded.perCli.cursor.transport, 'native');
    assert.equal(loaded.perCli.cursor.model, 'stored-model');
    assert.deepEqual(loaded.perCli.cursor.auth, { profile: 'keep' });
    assert.equal(config.isSettingsPersistenceBlocked(), false);
});

test('established missing-file home is conservative while retaining migration shape', t => {
    writeFileSync(config.DB_PATH, 'established-home-marker');
    t.after(() => unlinkSync(config.DB_PATH));
    assertModes(config.settingsForHomeWithoutSettingsFile(), ['print', 'print', 'print']);
    const loaded = config.loadSettings();
    assertModes(loaded, ['print', 'print', 'print']);
    assert.equal(loaded.multiSession.enabled, false);
    assert.equal(loaded.multiSession.maxConcurrent, 1);
    assert.equal(loaded.multiSessionDefaultMigration?.state, 'pending');
    assert.equal(loaded.nativeTransportMigration?.state, 'left-in-place');
    assert.equal(loaded.maxConcurrentDefaultMigration?.state, 'left-in-place');
    assert.equal(config.isSettingsPersistenceBlocked(), false);
    const again = config.loadSettings();
    assertModes(again, ['print', 'print', 'print']);
    assert.equal(again.multiSession.maxConcurrent, 1);
    assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).nativeTransportMigration.state, 'left-in-place');
});

test('corrupt and future-version existing files stay print and preserve persistence latch', () => {
    for (const source of ['{broken', JSON.stringify({ settingsSchemaVersion: 99, cli: 'codex-app' })]) {
        writeSettings(source);
        const loaded = config.loadSettings();
        assertModes(loaded, ['print', 'print', 'print']);
        assert.equal(config.isSettingsPersistenceBlocked(), true);
        config.saveSettings({ ...loaded, locale: 'ko' });
        assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), source);
        assert.equal(pickerCalls, 0);
    }
    assert.ok(readdirSync(config.JAW_HOME).some(name => name.startsWith('settings.json.corrupt-')));
});

function initAt(home: string, force = false) {
    const registryUrl = pathToFileURL(join(root, 'src/cli/registry.js')).href;
    const registrySource = pathToFileURL(join(root, 'src/cli/registry.ts')).href;
    const configUrl = pathToFileURL(join(root, 'src/core/config.ts')).href;
    const initPath = join(root, 'bin/commands/init.ts');
    const script = `
        import { mock } from 'node:test';
        const registry = await import(${JSON.stringify(registrySource)});
        mock.module(${JSON.stringify(registryUrl)}, { namedExports: { ...registry, buildDefaultPerCli() {
            const out = registry.buildDefaultPerCli();
            for (const cli of ['cursor', 'grok', 'claude']) out[cli] = { ...out[cli], transport: 'native' };
            return out;
        } } });
        const config = await import(${JSON.stringify(configUrl)});
        process.argv = [process.execPath, ${JSON.stringify(initPath)}, 'init', '--non-interactive'${force ? ", '--force'" : ''}];
        await import(${JSON.stringify(pathToFileURL(initPath).href)});
        const loaded = config.loadSettings();
        const again = config.loadSettings();
        console.log('TRANSPORT_FIXTURE=' + JSON.stringify({
            modes: ['cursor', 'grok', 'claude'].map(cli => loaded.perCli[cli].transport),
            factory: ['cursor', 'grok', 'claude'].map(cli => config.DEFAULT_SETTINGS.perCli[cli].transport),
            nativeTransport: loaded.nativeTransportMigration,
            maxConcurrentDefault: loaded.maxConcurrentDefaultMigration,
            maxConcurrent: loaded.multiSession.maxConcurrent,
            secondModes: ['cursor', 'grok', 'claude'].map(cli => again.perCli[cli].transport),
        }));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '--input-type=module', '-e', script], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CLI_JAW_HOME: home, CLI_JAW_SKIP_CLI_TOOLS: '1', CLI_JAW_SKIP_MCP_SERVERS: '1', CLI_JAW_SKIP_SKILL_DEPS: '1',
            TELEGRAM_TOKEN: '', DISCORD_TOKEN: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', SLACK_TEAM_ID: '', SLACK_CHANNEL_IDS: '' },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const resultLine = child.stdout.split('\n').find(line => line.startsWith('TRANSPORT_FIXTURE='));
    assert.ok(resultLine, child.stdout);
    return JSON.parse(resultLine.slice('TRANSPORT_FIXTURE='.length)) as {
        modes: string[];
        factory: string[];
        nativeTransport?: { state?: string };
        maxConcurrentDefault?: { state?: string };
        maxConcurrent?: number;
        secondModes?: string[];
    };
}

test('actual fresh init writes explicit factory transports which survive reload', t => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-transport-fresh-init-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const result = initAt(home);
    assert.deepEqual(result.factory, ['native', 'native', 'native']);
    const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assertModes(written, ['native', 'native', 'native']);
    assert.deepEqual(result.modes, ['native', 'native', 'native']);
});

test('actual existing --force init is not classified fresh under a future-native factory', t => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-transport-force-init-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ cli: 'claude', perCli: { cursor: { transport: 'native', model: 'old' } } }));
    const result = initAt(home, true);
    assert.deepEqual(result.factory, ['native', 'native', 'native']);
    assert.deepEqual(result.modes, ['native', 'native', 'native'], 'unstamped --force rewrite then loadSettings is the stamped migrator');
});

test('actual init without settings in an established home writes conservative choices', t => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-transport-established-init-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, 'jaw.db'), 'established-marker');
    const result = initAt(home);
    const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assertModes(written, ['print', 'print', 'print']);
    assert.equal(written.nativeTransportMigration?.state, 'left-in-place');
    assert.equal(written.maxConcurrentDefaultMigration?.state, 'left-in-place');
    assert.equal(written.multiSession.maxConcurrent, 1);
    assert.deepEqual(result.modes, ['print', 'print', 'print']);
    assert.equal(result.nativeTransport?.state, 'left-in-place');
    assert.equal(result.maxConcurrentDefault?.state, 'left-in-place');
    assert.equal(result.maxConcurrent, 1);
    assert.deepEqual(result.secondModes, ['print', 'print', 'print']);
});
