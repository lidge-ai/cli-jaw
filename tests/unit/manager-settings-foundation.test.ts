// Phase 1 — Settings shell foundation: client + dirty store unit tests.
// Runs via node:test through tsx (see package.json `test` script).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    SettingsRequestError,
    buildBaseUrl,
    createSettingsClient,
} from '../../public/manager/src/settings/settings-client';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import {
    stripServerOwnedSettingsFields,
    validateImportPayload,
} from '../../public/manager/src/settings/pages/AdvancedExport';

// ─── settings-client ─────────────────────────────────────────────────

test('buildBaseUrl produces /i/{port} prefix', () => {
    assert.equal(buildBaseUrl(3457), '/i/3457');
    assert.equal(buildBaseUrl(24576), '/i/24576');
});

test('createSettingsClient builds /i/{port}/... URLs', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: init?.method || 'GET' });
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;

    try {
        const client = createSettingsClient(3459);
        const got = await client.get<{ ok: boolean }>('/api/settings');
        assert.deepEqual(got, { ok: true });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.url, '/i/3459/api/settings');
        assert.equal(calls[0]?.method, 'GET');

        await client.put('/api/settings', { cli: 'codex' });
        assert.equal(calls[1]?.url, '/i/3459/api/settings');
        assert.equal(calls[1]?.method, 'PUT');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SettingsRequestError surfaces method, path, status, and detail', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response('boom', { status: 503 })) as typeof fetch;

    try {
        const client = createSettingsClient(3457);
        await assert.rejects(
            () => client.get('/api/settings'),
            (err: unknown) => {
                assert.ok(err instanceof SettingsRequestError);
                assert.equal(err.method, 'GET');
                assert.equal(err.path, '/api/settings');
                assert.equal(err.status, 503);
                assert.equal(err.detail, 'boom');
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createSettingsClient rejects non-JSON success responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response('<!doctype html><title>fallback</title>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
        })) as typeof fetch;

    try {
        const client = createSettingsClient(3464);
        await assert.rejects(
            () => client.get('/api/settings'),
            (err: unknown) => {
                assert.ok(err instanceof SettingsRequestError);
                assert.equal(err.status, 200);
                assert.match(err.detail, /expected JSON/);
                assert.match(err.detail, /text\/html/);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ─── dirty-store ─────────────────────────────────────────────────────

test('dirtyStore.set on equal value clears the entry', () => {
    const store = createDirtyStore();
    store.set('profile.name', { value: 'a', original: 'a', valid: true });
    assert.equal(store.pending.size, 0);
    assert.equal(store.isDirty(), false);
});

test('dirtyStore.set on different value retains it', () => {
    const store = createDirtyStore();
    store.set('profile.name', { value: 'b', original: 'a', valid: true });
    assert.equal(store.pending.size, 1);
    assert.equal(store.isDirty(), true);
});

test('dirtyStore.isDirty toggles correctly across edits', () => {
    const store = createDirtyStore();
    assert.equal(store.isDirty(), false);
    store.set('a', { value: 1, original: 0, valid: true });
    assert.equal(store.isDirty(), true);
    store.set('a', { value: 0, original: 0, valid: true });
    assert.equal(store.isDirty(), false);
    store.set('a', { value: 2, original: 0, valid: true });
    store.clear();
    assert.equal(store.isDirty(), false);
});

test('dirtyStore.saveBundle drops invalid entries', () => {
    const store = createDirtyStore();
    store.set('a', { value: 'x', original: 'y', valid: true });
    store.set('b', { value: 'q', original: 'r', valid: false });
    const bundle = store.saveBundle();
    assert.deepEqual(bundle, { a: 'x' });
});

test('dirtyStore.subscribe fires on set/clear and unsubscribe stops it', () => {
    const store = createDirtyStore();
    let count = 0;
    const unsub = store.subscribe(() => {
        count += 1;
    });
    store.set('a', { value: 1, original: 0, valid: true });
    store.set('a', { value: 2, original: 0, valid: true });
    store.clear();
    assert.equal(count, 3);
    unsub();
    store.set('a', { value: 9, original: 0, valid: true });
    assert.equal(count, 3);
});

test('dirtyStore array equality short-circuits identical arrays', () => {
    const store = createDirtyStore();
    store.set('chips', {
        value: ['x', 'y'],
        original: ['x', 'y'],
        valid: true,
    });
    assert.equal(store.isDirty(), false);
    store.set('chips', {
        value: ['x', 'y', 'z'],
        original: ['x', 'y'],
        valid: true,
    });
    assert.equal(store.isDirty(), true);
});

test('Advanced Export/Import strips only schema-owned fields for round-trip PUT', () => {
    const serverDocument = {
        cli: 'claude',
        workingDir: '/work',
        settingsSchemaVersion: 2,
        runtimeDefaultMigration: { id: 'codex-app-default-v2', state: 'pending' },
        nativeTransportMigration: { id: 'native-transport-default-v1', state: 'applied' },
        maxConcurrentDefaultMigration: { id: 'max-concurrent-default-v1', state: 'applied', from: 2, to: 20 },
        slackEnvironmentVariables: ['SLACK_BOT_TOKEN'],
        nested: { keep: true },
    };
    assert.deepEqual(stripServerOwnedSettingsFields(serverDocument), {
        cli: 'claude',
        workingDir: '/work',
        nested: { keep: true },
    });
    assert.deepEqual(validateImportPayload(JSON.stringify(serverDocument)), {
        ok: true,
        value: {
            cli: 'claude',
            workingDir: '/work',
            nested: { keep: true },
        },
    });
});
