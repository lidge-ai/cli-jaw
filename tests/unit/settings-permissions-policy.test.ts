// #788 — the `permissions` field had no shared shape contract: the settings
// ingress accepted values outside 'auto' | 'safe' | string[] (an API patch of
// {permissions:{}} reached disk and replaced a safe policy), the native ACP
// consumer then threw invalid_native_permissions on the same stored bytes, and
// the Manager editors initialized an unrecognized shape's editing mode to Auto
// while the configured readout said 'Unrecognized'.
//
// These tests pin one contract across every surface: the shared validator in
// src/shared/permissions.ts, sanitizer rejection at boot/watch/api ingress,
// the route's 400 (no save, no runtime restart), the boot-time split between
// a corrupt current-schema file (refused, backed up, never overwritten) and a
// legacy v1 migration (repaired fail-closed, not silently widened to Auto),
// the editor's recoverable 'invalid' state, and the unchanged fail-closed
// behavior of the native consumer for known policies.

import '../setup/isolated-home.ts';
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';

const config = await import('../../src/core/config.ts');
const { sanitizeSettingsInput } = await import('../../src/core/settings-merge.ts');
const watcher = await import('../../src/core/settings-watch.ts');
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const {
    isPermissionToken,
    isPermissionsPolicy,
    PERMISSION_TOKEN_LIMIT,
} = await import('../../src/shared/permissions.ts');
const { normalizeNativePermissions } = await import('../../src/agent/runtime/acp/permissions.ts');
const { configuredPolicyLabel, parsePermissionsValue, permissionsEditMode } =
    await import('../../public/manager/src/settings/pages/Permissions.tsx');

const home = config.JAW_HOME;

// Criterion-5 fixture set: object, wrong case, number, mixed array, invalid
// token, over-limit token — plus the falsy variants that used to sneak through
// `|| 'auto'` fallbacks downstream.
const INVALID_POLICIES: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'object', value: {} },
    { name: 'wrong case', value: 'AUTO' },
    { name: 'number', value: 7 },
    { name: 'mixed array', value: ['read', 42] },
    { name: 'invalid token', value: ['read', 'bad token!'] },
    { name: 'over-limit token', value: ['a'.repeat(PERMISSION_TOKEN_LIMIT + 1)] },
    { name: 'falsy null', value: null },
    { name: 'falsy empty string', value: '' },
    { name: 'sparse array', value: new Array(1) },
];

const VALID_POLICIES: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'auto', value: 'auto' },
    { name: 'safe', value: 'safe' },
    { name: 'empty allowlist', value: [] },
    { name: 'custom tokens', value: ['read', 'mcp.*', 'x'.repeat(PERMISSION_TOKEN_LIMIT)] },
];

function writeSettings(doc: Record<string, unknown>): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(config.SETTINGS_PATH, JSON.stringify(doc), 'utf8');
}

function disk(): string {
    return readFileSync(config.SETTINGS_PATH, 'utf8');
}

function corruptBackups(): string[] {
    return fs.readdirSync(home).filter(name => name.startsWith('settings.json.corrupt-'));
}

function validV4Document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const value = structuredClone(config.DEFAULT_SETTINGS);
    Object.assign(value, { cli: 'claude', workingDir: home, permissions: 'safe' }, overrides);
    return value;
}

beforeEach(() => {
    writeSettings(validV4Document());
    config.loadSettings();
});

afterEach(() => {
    try { fs.unlinkSync(config.SETTINGS_PATH); } catch { /* already gone */ }
    for (const name of corruptBackups()) {
        try { fs.unlinkSync(`${home}/${name}`); } catch { /* best effort */ }
    }
});

after(() => {
    rmSync(home, { recursive: true, force: true });
});

// ─── shared validator: shape and token contract ─────────────────────

test('isPermissionsPolicy accepts the three stored shapes, including the empty allowlist', () => {
    for (const { name, value } of VALID_POLICIES) {
        assert.equal(isPermissionsPolicy(value), true, name);
    }
    // The empty custom array is a real policy: an explicitly empty allowlist —
    // fail-closed like 'safe', recorded as a deliberate custom choice.
    assert.equal(isPermissionsPolicy([]), true);
});

test('isPermissionsPolicy rejects every malformed fixture', () => {
    for (const { name, value } of INVALID_POLICIES) {
        assert.equal(isPermissionsPolicy(value), false, name);
    }
    assert.equal(isPermissionsPolicy(undefined), false, 'absent');
    assert.equal(isPermissionsPolicy('deny'), false, 'unknown literal');
    assert.equal(isPermissionsPolicy(['auto']), true, '["auto"] is a token list, not the sentinel');
});

test('isPermissionToken: the shared literal token contract', () => {
    assert.equal(isPermissionToken('bash'), true);
    assert.equal(isPermissionToken('mcp.*'), true);
    assert.equal(isPermissionToken('tool:read'), true);
    assert.equal(isPermissionToken(''), false);
    assert.equal(isPermissionToken(' has-space'), false);
    assert.equal(isPermissionToken('read\nwrite'), false);
    assert.equal(isPermissionToken('a'.repeat(PERMISSION_TOKEN_LIMIT)), true);
    assert.equal(isPermissionToken('a'.repeat(PERMISSION_TOKEN_LIMIT + 1)), false);
});

// ─── sanitizer: every ingress shares the contract ───────────────────

test('sanitizer flags malformed permissions at every ingress and drops the value', () => {
    for (const source of ['api', 'watch', 'boot'] as const) {
        for (const { name, value } of INVALID_POLICIES) {
            const sanitized = sanitizeSettingsInput({ permissions: value }, source);
            assert.deepEqual(sanitized.invalidPaths, ['permissions'], `${source} ${name}`);
            assert.equal('permissions' in sanitized.value, false, `${source} ${name} value dropped`);
        }
    }
});

test('sanitizer keeps known policies and leaves the key present', () => {
    for (const source of ['api', 'watch', 'boot'] as const) {
        for (const { name, value } of VALID_POLICIES) {
            const sanitized = sanitizeSettingsInput({ permissions: value }, source);
            assert.deepEqual(sanitized.invalidPaths, [], `${source} ${name}`);
            assert.deepEqual(sanitized.value['permissions'], value, `${source} ${name}`);
        }
    }
});

// ─── API: 400, no save, no runtime restart ──────────────────────────

test('PUT /api/settings rejects malformed permissions with 400 and never reaches applySettings', async () => {
    let applied = 0;
    const applySettings = async () => { applied += 1; return {}; };
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, (_req, _res, next) => next(), applySettings, process.cwd());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        for (const { name, value } of INVALID_POLICIES) {
            const before = config.snapshotSettingsState();
            const raw = disk();
            const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
                method: 'PUT', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ permissions: value }), signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 400, name);
            assert.equal((await response.json()).error, 'invalid_settings_field', name);
            assert.equal(applied, 0, `${name}: no save or runtime restart dispatched`);
            assert.equal(disk(), raw, `${name}: file untouched`);
            assert.deepEqual(config.snapshotSettingsState(), before, `${name}: memory untouched`);
        }
        // Control: a known policy still flows through the same route to applySettings.
        const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissions: 'safe' }), signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.equal(applied, 1, 'a valid patch is still applied');
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

// ─── boot: corrupt current-schema file vs legacy migration ──────────

test('a current-schema file with malformed permissions is corrupt: latched, backed up, never overwritten', () => {
    for (const { name, value } of INVALID_POLICIES) {
        const original = JSON.stringify(validV4Document({ permissions: value }));
        fs.writeFileSync(config.SETTINGS_PATH, original);
        config.loadSettings();
        assert.equal(config.isSettingsPersistenceBlocked(), true, `${name}: persistence latched`);
        assert.ok(corruptBackups().length > 0, `${name}: file backed up`);
        assert.equal(disk(), original, `${name}: the original file is not overwritten`);
        // In-memory we are on the failsafe defaults — a loud failure state, not a
        // quiet continuation of the stored bytes.
        assert.equal(config.settings['permissions'], 'safe', `${name}: refused permissions fall back to safe, not auto`);
        fs.unlinkSync(config.SETTINGS_PATH);
        for (const backup of corruptBackups()) fs.unlinkSync(`${home}/${backup}`);
        writeSettings(validV4Document());
        config.loadSettings();
        assert.equal(config.isSettingsPersistenceBlocked(), false, `${name}: clean file clears the latch`);
    }
});

test('a legacy v1 file with malformed permissions is repaired fail-closed and migrated', () => {
    // v1 = no settingsSchemaVersion key. The invalid value is repaired to the
    // fail-closed 'safe' the era meant — never silently widened to 'auto' —
    // and the migration writes the current schema back to disk.
    writeSettings({ cli: 'claude', workingDir: home, permissions: {} });
    config.loadSettings();
    assert.equal(config.isSettingsPersistenceBlocked(), false);
    assert.equal(config.settings['permissions'], 'safe');
    const written = JSON.parse(disk());
    assert.equal(written['permissions'], 'safe');
    assert.equal(written['settingsSchemaVersion'], config.SETTINGS_SCHEMA_VERSION);
});

test('a current-schema file with a known policy loads unchanged', () => {
    for (const { name, value } of VALID_POLICIES) {
        writeSettings(validV4Document({ permissions: value }));
        config.loadSettings();
        assert.equal(config.isSettingsPersistenceBlocked(), false, name);
        assert.deepEqual(config.settings['permissions'], value, name);
    }
});

// ─── watch: an external write with malformed permissions keeps memory ──

test('watched file edit with malformed permissions keeps the in-memory policy and the file', () => {
    assert.equal(config.settings['permissions'], 'safe');
    for (const { name, value } of INVALID_POLICIES) {
        writeSettings({ permissions: value });
        const raw = disk();
        assert.equal(watcher.reloadSettingsFromDisk({ lastSavedRaw: null }), true, name);
        assert.equal(config.settings['permissions'], 'safe', `${name}: memory keeps the stored policy`);
        assert.equal(disk(), raw, `${name}: watch reload does not rewrite the external file`);
    }
});

// ─── UI: unknown shape opens as recoverable invalid, not selected Auto ──

test('permissionsEditMode lands unrecognized stored values in recoverable invalid', () => {
    for (const { name, value } of INVALID_POLICIES) {
        assert.equal(permissionsEditMode(value), 'invalid', name);
        const label = configuredPolicyLabel(value);
        assert.ok(label === 'Unrecognized' || label === 'Not provided',
            `${name}: readout never presents an unknown shape as a named policy (${label})`);
    }
    // The lenient display parser reads a mixed array as custom; the edit mode must not.
    assert.equal(parsePermissionsValue(['read', 42]).mode, 'custom');
    assert.equal(permissionsEditMode(['read', 42]), 'invalid');
    for (const { name, value } of VALID_POLICIES) {
        const expected = value === 'auto' ? 'auto' : value === 'safe' ? 'safe' : 'custom';
        assert.equal(permissionsEditMode(value), expected, name);
    }
});

// ─── runtime: native consumer still fails closed on the same fixtures ──

test('normalizeNativePermissions keeps failing closed on malformed values', () => {
    for (const { name, value } of INVALID_POLICIES) {
        assert.throws(() => normalizeNativePermissions(value), /invalid_native_permissions/, name);
    }
    for (const { name, value } of VALID_POLICIES) {
        assert.deepEqual(normalizeNativePermissions(value), value, name);
    }
});
