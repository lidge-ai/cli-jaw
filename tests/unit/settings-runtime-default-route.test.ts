import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

const home = mkdtempSync(join(tmpdir(), 'cli-jaw-runtime-route-'));
process.env['CLI_JAW_HOME'] = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const config = await import('../../src/core/config.ts');

const allowAuth = (_req: Request, _res: Response, next: NextFunction): void => next();
const denyAuth = (_req: Request, res: Response): void => { res.status(401).json({ ok: false, error: 'unauthorized' }); };

function pending() {
    return { id: config.RUNTIME_DEFAULT_MIGRATION_ID, state: 'pending', fromCli: 'claude', toCli: 'codex-app' };
}

function secretSettings(state: 'pending' | 'accepted' | 'kept' = 'pending') {
    return {
        settingsSchemaVersion: 2,
        runtimeDefaultMigration: { ...pending(), state },
        cli: state === 'accepted' ? 'codex-app' : 'claude',
        stt: { geminiApiKey: 'STT_SECRET_LITERAL', openaiApiKey: 'STT_OPENAI_SECRET' },
        jawCeo: { openaiApiKey: 'sk-JAW_CEO_SECRET_LITERAL_123456789' },
        pi: {
            defaultProfileId: 'private',
            profiles: [{
                id: 'private', label: 'Private', mode: 'basic', endpoint: 'http://127.0.0.1:9999/v1',
                apiKind: 'openai-completions', apiKey: 'PI_SECRET_LITERAL', model: 'private-model',
            }],
            discoveredModels: { private: ['private-model'] },
        },
    };
}

async function startRouteApp(
    auth: typeof allowAuth,
    applySettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, auth, applySettings, process.cwd());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

async function request(base: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, json: await response.json() as Record<string, any> };
}

test('RDM-001: generic PUT rejects each schema-owned field before apply', async () => {
    let applies = 0;
    const app = await startRouteApp(allowAuth, async () => { applies += 1; return {}; });
    try {
        for (const body of [
            { settingsSchemaVersion: 2 },
            { runtimeDefaultMigration: pending() },
            { settingsSchemaVersion: 2, runtimeDefaultMigration: pending() },
            { nativeTransportMigration: { id: 'native-transport-default-v1', state: 'applied' } },
            { maxConcurrentDefaultMigration: { id: 'max-concurrent-default-v1', state: 'applied', from: 2, to: 20 } },
        ]) {
            const { response } = await request(app.base, 'PUT', '/api/settings', body);
            assert.equal(response.status, 400);
        }
        assert.equal(applies, 0);
    } finally {
        await app.close();
    }
});

test('RDM-001a: generic PUT rejects every laneMode as server-owned before apply', async () => {
    let applies = 0;
    const app = await startRouteApp(allowAuth, async () => { applies += 1; return {}; });
    try {
        for (const laneMode of ['native', 'fallback', 'user-choice']) {
            const { response, json } = await request(app.base, 'PUT', '/api/settings', {
                runtime: { codexApp: { laneMode } },
            });
            assert.equal(response.status, 400);
            assert.equal(json.error, 'server_owned_settings_field');
        }
        assert.equal(applies, 0);
    } finally {
        await app.close();
    }
});

test('RDM-001c: generic PUT accepts only boolean multiplex values', async () => {
    const patches: Record<string, unknown>[] = [];
    const app = await startRouteApp(allowAuth, async (patch) => {
        patches.push(patch);
        return patch;
    });
    try {
        for (const multiplex of ['true', 1, null]) {
            const { response, json } = await request(app.base, 'PUT', '/api/settings', {
                runtime: { codexApp: { multiplex } },
            });
            assert.equal(response.status, 400);
            assert.equal(json.error, 'invalid_settings_field');
        }
        for (const multiplex of [false, true]) {
            const { response } = await request(app.base, 'PUT', '/api/settings', {
                runtime: { codexApp: { multiplex } },
            });
            assert.equal(response.status, 200);
        }
        assert.equal(patches.length, 2);
        assert.deepEqual(
            patches.map((patch) => (patch["runtime"] as Record<string, any>).codexApp.multiplex),
            [false, true],
        );
    } finally {
        await app.close();
    }
});

test('RDM-001b: GET exposes schema state through the existing redacted settings serializer', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    const app = await startRouteApp(allowAuth, async () => config.settings);
    try {
        const { response, json } = await request(app.base, 'GET', '/api/settings');
        assert.equal(response.status, 200);
        assert.equal(json.data.settingsSchemaVersion, 2);
        assert.equal(json.data.runtimeDefaultMigration.state, 'pending');
        assert.equal(JSON.stringify(json).includes('PI_SECRET_LITERAL'), false);
    } finally {
        await app.close();
    }
});

test('RDM-002: action body is strict and rejects extra user/server-owned fields', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    let applies = 0;
    const app = await startRouteApp(allowAuth, async () => { applies += 1; return config.settings; });
    try {
        for (const body of [
            {}, { action: 'later' }, { action: 'keep', cli: 'codex' },
            { action: 'accept', settingsSchemaVersion: 2 },
            { action: 'accept', runtimeDefaultMigration: pending() },
        ]) {
            const { response } = await request(app.base, 'POST', '/api/settings/runtime-default-migration', body);
            assert.equal(response.status, 400);
        }
        assert.equal(applies, 0);
    } finally {
        await app.close();
    }
});

test('RDM-003: auth failure exits before snapshot/apply', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    let applies = 0;
    const app = await startRouteApp(denyAuth, async () => { applies += 1; return config.settings; });
    try {
        const { response, json } = await request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'keep' });
        assert.equal(response.status, 401);
        assert.equal(applies, 0);
        assert.equal(JSON.stringify(json).includes('STT_SECRET_LITERAL'), false);
    } finally {
        await app.close();
    }
});

test('RDM-004: accept uses injected apply exactly once and 200 is fully redacted', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    const patches: Record<string, unknown>[] = [];
    const app = await startRouteApp(allowAuth, async (patch) => {
        patches.push(patch);
        config.replaceSettings({ ...config.settings, ...patch }, 'absent');
        return config.settings;
    });
    try {
        const { response, json } = await request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'accept' });
        assert.equal(response.status, 200);
        assert.equal(patches.length, 1);
        assert.equal(patches[0]?.["cli"], 'codex-app');
        assert.equal((patches[0]?.["runtimeDefaultMigration"] as Record<string, unknown>)["state"], 'accepted');
        const serialized = JSON.stringify(json);
        for (const secret of ['STT_SECRET_LITERAL', 'STT_OPENAI_SECRET', 'sk-JAW_CEO_SECRET_LITERAL_123456789', 'PI_SECRET_LITERAL']) {
            assert.equal(serialized.includes(secret), false, `${secret} leaked from 200 response`);
        }
        assert.equal(json.data.stt.geminiKeySet, true);
        assert.equal(json.data.jawCeo.openaiKeySet, true, JSON.stringify(json.data.jawCeo));
        assert.equal(json.data.pi.profiles[0].apiKeySet, true);
    } finally {
        await app.close();
    }
});

test('RDM-004b: keep uses injected apply once without a cli key', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    const patches: Record<string, unknown>[] = [];
    const app = await startRouteApp(allowAuth, async (patch) => {
        patches.push(patch);
        config.replaceSettings({ ...config.settings, ...patch }, 'absent');
        return config.settings;
    });
    try {
        const { response, json } = await request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'keep' });
        assert.equal(response.status, 200);
        assert.equal(patches.length, 1);
        assert.equal('cli' in patches[0]!, false);
        assert.equal((patches[0]?.["runtimeDefaultMigration"] as Record<string, unknown>)["state"], 'kept');
        assert.equal(json.data.cli, 'claude');
    } finally {
        await app.close();
    }
});

test('RDM-005: concurrent accept/keep has one winner and redacted 409 loser snapshot', async () => {
    config.replaceSettings(secretSettings(), 'absent');
    let applies = 0;
    const app = await startRouteApp(allowAuth, async (patch) => {
        applies += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        config.replaceSettings({ ...config.settings, ...patch }, 'absent');
        return config.settings;
    });
    try {
        const results = await Promise.all([
            request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'accept' }),
            request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'keep' }),
        ]);
        assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
        assert.equal(applies, 1);
        const conflict = results.find(({ response }) => response.status === 409)!.json;
        assert.equal(conflict.error, 'runtime_default_migration_terminal');
        assert.equal(conflict.settings.runtimeDefaultMigration.state === 'accepted'
            || conflict.settings.runtimeDefaultMigration.state === 'kept', true);
        const serialized = JSON.stringify(conflict);
        for (const secret of ['STT_SECRET_LITERAL', 'STT_OPENAI_SECRET', 'sk-JAW_CEO_SECRET_LITERAL_123456789', 'PI_SECRET_LITERAL']) {
            assert.equal(serialized.includes(secret), false, `${secret} leaked from 409 response`);
        }
    } finally {
        await app.close();
    }
});

test('RDM-006: another client terminal state returns latest redacted 409 without apply', async () => {
    config.replaceSettings(secretSettings('kept'), 'absent');
    let applies = 0;
    const app = await startRouteApp(allowAuth, async () => { applies += 1; return config.settings; });
    try {
        const { response, json } = await request(app.base, 'POST', '/api/settings/runtime-default-migration', { action: 'accept' });
        assert.equal(response.status, 409);
        assert.equal(applies, 0);
        assert.equal(json.settings.runtimeDefaultMigration.state, 'kept');
        assert.equal(JSON.stringify(json).includes('sk-JAW_CEO_SECRET_LITERAL_123456789'), false);
    } finally {
        await app.close();
    }
});
