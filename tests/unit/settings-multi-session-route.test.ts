import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

const home = mkdtempSync(join(tmpdir(), 'cli-jaw-session-route-'));
process.env['CLI_JAW_HOME'] = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const config = await import('../../src/core/config.ts');
const runtimeSettings = await import('../../src/core/runtime-settings.ts');

const allowAuth = (_req: Request, _res: Response, next: NextFunction): void => next();

function pendingMarker(state: 'pending' | 'accepted' | 'kept' | 'already-enabled' = 'pending') {
    return { id: config.MULTI_SESSION_DEFAULT_MIGRATION_ID, state };
}

function sessionsOff() {
    return { enabled: false, maxConcurrent: 1, midRunPolicy: 'steer', channels: { telegram: false, discord: false, slack: true } };
}

async function startRouteApp(
    applySettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, allowAuth, applySettings, process.cwd());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function seed(state: 'pending' | 'accepted' | 'kept' | 'already-enabled', multiSession = sessionsOff()) {
    config.replaceSettings({
        ...config.settings,
        settingsSchemaVersion: config.SETTINGS_SCHEMA_VERSION,
        multiSessionDefaultMigration: pendingMarker(state),
        multiSession,
        cli: 'codex-app',
    }, 'present');
}

// 110 §4d — accept means both halves of what the prompt offered. Turning sessions on
// without the second lane would change what the screen shows and nothing about how it
// runs, and the prompt names both.
test('MSR-001: accept turns sessions on and lifts the single lane', async () => {
    seed('pending');
    const patch = runtimeSettings.resolveMultiSessionDefaultMigration(config.settings, 'accept');
    assert.deepEqual(patch["multiSession"], { enabled: true, maxConcurrent: 20 });
    assert.equal((patch["multiSessionDefaultMigration"] as { state: string }).state, 'accepted');
});

// A concurrency the user moved off 1 is theirs. Stated in terms of the value rather than
// of intent, because a stored 1 and a chosen 1 are the same byte (110 §4d).
test('MSR-002: accept leaves a concurrency that is not the old default alone', async () => {
    seed('pending', { ...sessionsOff(), maxConcurrent: 4 });
    const patch = runtimeSettings.resolveMultiSessionDefaultMigration(config.settings, 'accept');
    assert.deepEqual(patch["multiSession"], { enabled: true });
});

test('MSR-003: keep changes nothing but the marker', async () => {
    seed('pending');
    const patch = runtimeSettings.resolveMultiSessionDefaultMigration(config.settings, 'keep');
    assert.equal(patch["multiSession"], undefined, 'keep must not touch the settings it asked about');
    assert.equal((patch["multiSessionDefaultMigration"] as { state: string }).state, 'kept');
});

// ON-31 — asked and answered once. A replay is a conflict, not a second answer.
test('MSR-004: a terminal marker refuses a second answer', async () => {
    seed('accepted');
    assert.throws(
        () => runtimeSettings.resolveMultiSessionDefaultMigration(config.settings, 'keep'),
        runtimeSettings.MultiSessionDefaultMigrationTerminalError,
    );
});

test('MSR-005: the route rejects anything that is not one action', async () => {
    seed('pending');
    const app = await startRouteApp(async () => ({ ...config.settings }));
    try {
        for (const body of [{}, { action: 'maybe' }, { action: 'accept', extra: 1 }, [], null]) {
            const response = await fetch(`${app.base}/api/settings/multi-session-default-migration`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        }
    } finally {
        await app.close();
    }
});

test('MSR-006: a terminal marker answers 409 with the current settings', async () => {
    seed('kept');
    const app = await startRouteApp(async () => ({ ...config.settings }));
    try {
        const response = await fetch(`${app.base}/api/settings/multi-session-default-migration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'accept' }),
        });
        assert.equal(response.status, 409);
        const payload = await response.json() as { error: string; settings?: Record<string, unknown> };
        assert.equal(payload.error, 'multi_session_default_migration_terminal');
        assert.ok(payload.settings, 'the caller gets the state it lost the race to');
    } finally {
        await app.close();
    }
});

// ON-31 — two answers arriving together must not both apply. The second sees a marker
// that is already terminal.
test('MSR-007: concurrent accept and keep produce exactly one winner', async () => {
    seed('pending');
    let applied = 0;
    // apply is made slow on purpose. Without it the first request finishes its whole
    // resolve-and-apply before the second is even parsed, so the test would pass with no
    // serialisation at all — which is exactly what it is supposed to be checking.
    let releaseFirst!: () => void;
    const firstApplyStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const app = await startRouteApp(async (patch) => {
        applied += 1;
        if (applied === 1) {
            releaseFirst();
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        config.replaceSettings({ ...config.settings, ...patch }, 'present');
        return { ...config.settings };
    });
    try {
        const first = fetch(`${app.base}/api/settings/multi-session-default-migration`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'accept' }),
        });
        // The second request is sent while the first is mid-apply, so without the lock it
        // would read a marker that is still pending and answer it a second time.
        await firstApplyStarted;
        const second = fetch(`${app.base}/api/settings/multi-session-default-migration`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'keep' }),
        });
        const [a, b] = await Promise.all([first, second]);
        const statuses = [a.status, b.status].sort();
        assert.deepEqual(statuses, [200, 409]);
        assert.equal(applied, 1, 'only the winner reaches the settings');
    } finally {
        await app.close();
    }
});

// ON-32 — a v1 install has both markers pending, and resolving one must leave the other
// exactly where it was.
test('MSR-008: resolving the session marker leaves the runtime marker alone', async () => {
    const runtimeMarker = {
        id: config.RUNTIME_DEFAULT_MIGRATION_ID, state: 'pending' as const,
        fromCli: 'claude', toCli: 'codex-app' as const,
    };
    config.replaceSettings({
        ...config.settings,
        settingsSchemaVersion: config.SETTINGS_SCHEMA_VERSION,
        runtimeDefaultMigration: runtimeMarker,
        multiSessionDefaultMigration: pendingMarker(),
        multiSession: sessionsOff(),
        cli: 'claude',
    }, 'present');

    const patch = runtimeSettings.resolveMultiSessionDefaultMigration(config.settings, 'accept');
    assert.equal(patch["runtimeDefaultMigration"], undefined, 'it must not carry an answer it was not given');
    assert.equal(patch["cli"], undefined, 'and must not decide the runtime question');

    const runtimePatch = runtimeSettings.resolveRuntimeDefaultMigration(config.settings, 'keep');
    assert.equal(runtimePatch["multiSessionDefaultMigration"], undefined);
    assert.equal(runtimePatch["multiSession"], undefined);
});
