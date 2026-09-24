// Phase 7 — Permissions page pure helpers + dirty-store wiring.
//
// `permissions` is a union-typed field: `'auto'` (string) or `string[]`.
// These tests exercise the helpers that keep the union-shape correct so a
// mistakenly saved `['auto']` (which would deny everything) can never ship.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import {
    configuredPolicyLabel,
    isAllowlistValid,
    isPermissionsAuto,
    isPermissionToken,
    parsePermissionsValue,
    seedAutoAllowlist,
} from '../../public/manager/src/settings/pages/Permissions';

test('configuredPolicyLabel reports stored shape without changing parser or editor semantics', () => {
    const cases: Array<[unknown, string]> = [
        ['auto', 'Auto (YOLO)'], ['safe', 'Safe'], [[], 'Custom (0 entries)'], [['auto'], 'Custom (1 entry)'],
        [[' read ', ''], 'Custom (2 entries)'], [null, 'Not provided'], [undefined, 'Not provided'],
        ['AUTO', 'Unrecognized'], [' auto ', 'Unrecognized'], ['deny', 'Unrecognized'],
        [42, 'Unrecognized'], [{ secret: 'not for display' }, 'Unrecognized'], [['read', false], 'Unrecognized'],
    ];
    for (const [value, expected] of cases) {
        const before = structuredClone(value);
        assert.equal(configuredPolicyLabel(value), expected);
        assert.deepEqual(value, before);
    }
    // 'safe' is a real stored policy, not an unrecognized shape. Reporting it as unknown is
    // what let the editors collapse it to 'auto' and widen permissions without the user
    // seeing it.
    assert.deepEqual(parsePermissionsValue('safe'), { mode: 'safe' });
    assert.deepEqual(parsePermissionsValue('bogus'), { mode: 'unknown' });
    assert.deepEqual(parsePermissionsValue([' read ', '']), { mode: 'custom', tokens: ['read'] });
});

// ─── isPermissionsAuto + parsePermissionsValue ───────────────────────

test('isPermissionsAuto: only the string literal "auto"', () => {
    assert.equal(isPermissionsAuto('auto'), true);
    assert.equal(isPermissionsAuto(['auto']), false);
    assert.equal(isPermissionsAuto('AUTO'), false);
    assert.equal(isPermissionsAuto(undefined), false);
});

test('parsePermissionsValue: "auto" → mode auto', () => {
    assert.deepEqual(parsePermissionsValue('auto'), { mode: 'auto' });
});

test('parsePermissionsValue: array → mode custom with cleaned tokens', () => {
    const r = parsePermissionsValue(['bash', '  read  ', '', 'mcp.*']);
    assert.deepEqual(r, { mode: 'custom', tokens: ['bash', 'read', 'mcp.*'] });
});

test('parsePermissionsValue: garbage → unknown', () => {
    assert.deepEqual(parsePermissionsValue(undefined), { mode: 'unknown' });
    assert.deepEqual(parsePermissionsValue(42), { mode: 'unknown' });
    assert.deepEqual(parsePermissionsValue({ x: 1 }), { mode: 'unknown' });
});

test('parsePermissionsValue: ["auto"] is custom, NOT auto', () => {
    // Critical: protects against the foot-gun where `['auto']` would be
    // treated as the "auto" sentinel and silently grant nothing.
    const r = parsePermissionsValue(['auto']);
    assert.equal(r.mode, 'custom');
});

// ─── isPermissionToken ───────────────────────────────────────────────

test('isPermissionToken: accepts simple identifiers + wildcards', () => {
    assert.equal(isPermissionToken('bash'), true);
    assert.equal(isPermissionToken('mcp.*'), true);
    assert.equal(isPermissionToken('tool:read'), true);
    assert.equal(isPermissionToken('a-b_c.d:e'), true);
});

test('isPermissionToken: rejects empty, whitespace, control chars', () => {
    assert.equal(isPermissionToken(''), false);
    assert.equal(isPermissionToken('   '), false);
    assert.equal(isPermissionToken('bash read'), false);
    assert.equal(isPermissionToken('bash\n'), false);
    assert.equal(isPermissionToken('"; rm -rf /'), false);
    assert.equal(isPermissionToken('a'.repeat(65)), false);
});

// ─── seedAutoAllowlist ───────────────────────────────────────────────

test('seedAutoAllowlist: null → built-in defaults', () => {
    const seed = seedAutoAllowlist(null);
    assert.ok(seed.length > 0);
    assert.ok(seed.includes('bash'));
    assert.ok(seed.includes('read'));
    assert.ok(seed.includes('mcp.*'));
});

test('seedAutoAllowlist: dedupes and filters invalid tokens', () => {
    const seed = seedAutoAllowlist(['bash', 'bash', 'read', '', 'has space']);
    assert.deepEqual(seed.sort(), ['bash', 'read'].sort());
});

test('seedAutoAllowlist: empty array falls back to defaults', () => {
    const seed = seedAutoAllowlist([]);
    assert.ok(seed.length > 0);
});

// ─── isAllowlistValid ────────────────────────────────────────────────

test('isAllowlistValid: empty array is invalid', () => {
    assert.equal(isAllowlistValid([]), false);
});

test('isAllowlistValid: any invalid token poisons the list', () => {
    assert.equal(isAllowlistValid(['bash', 'mcp.*']), true);
    assert.equal(isAllowlistValid(['bash', '']), false);
    assert.equal(isAllowlistValid(['bash', 'has space']), false);
});

// ─── dirty-store round-trips for the union shape ────────────────────

test('Auto → Custom: writes string[] under "permissions" key', () => {
    const store = createDirtyStore();
    const seed = seedAutoAllowlist(null);
    store.set('permissions', { value: seed, original: 'auto', valid: true });
    const bundle = store.saveBundle();
    assert.equal(Array.isArray(bundle.permissions), true);
    assert.deepEqual(bundle.permissions, seed);
});

test('Custom → Auto: writes literal "auto" string, NOT ["auto"]', () => {
    const store = createDirtyStore();
    store.set('permissions', { value: 'auto', original: ['bash', 'read'], valid: true });
    const bundle = store.saveBundle();
    assert.equal(bundle.permissions, 'auto');
    assert.notEqual(Array.isArray(bundle.permissions), true);
});

test('Reverting Custom→Auto→Custom with same tokens clears dirty', () => {
    const store = createDirtyStore();
    store.set('permissions', { value: 'auto', original: ['bash'], valid: true });
    assert.equal(store.isDirty(), true);
    store.set('permissions', { value: ['bash'], original: ['bash'], valid: true });
    assert.equal(store.isDirty(), false);
});

test('Empty Custom allowlist is invalid → not in saveBundle', () => {
    const store = createDirtyStore();
    store.set('permissions', { value: [], original: 'auto', valid: false });
    const bundle = store.saveBundle();
    assert.equal('permissions' in bundle, false);
});

test('Custom mode with one valid token saves as a single-element array', () => {
    const store = createDirtyStore();
    store.set('permissions', { value: ['read'], original: 'auto', valid: true });
    const bundle = store.saveBundle();
    assert.deepEqual(bundle.permissions, ['read']);
});
