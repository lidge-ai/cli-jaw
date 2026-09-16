import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import * as config from '../../src/core/config.ts';
import { buildDefaultPerCli } from '../../src/cli/registry.ts';
import { sanitizeSettingsInput, mergeSettingsPatch } from '../../src/core/settings-merge.ts';
import { reloadSettingsFromDisk } from '../../src/core/settings-watch.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { getSessionOwnershipGeneration, isCurrentSessionOwner, resetSessionOwnershipGenerationForTest } from '../../src/agent/session-persistence.ts';
import { registerSettingsRoutes } from '../../src/routes/settings.ts';
import { applySettingsPatch } from '../../src/core/session-ops.ts';
import { getSession, getSessionBucket, updateSession, upsertSessionBucket } from '../../src/core/db.ts';
import { resolveScopedSessionBucket } from '../../src/agent/args.ts';
import { resolveRuntimeTransport, runtimeSessionBucket } from '../../src/agent/runtime/selection.ts';

const engines = ['cursor', 'grok', 'claude'] as const;
test.beforeEach(t => {
    t.mock.method(console, 'warn', () => {});
    resetSessionOwnershipGenerationForTest();
    const next = structuredClone(config.DEFAULT_SETTINGS);
    const perCli = { ...next.perCli,
        cursor: { model: 'kept-model', effort: 'high', transport: 'native', auth: { profile: 'kept-auth' } },
        grok: { model: 'kept-grok', effort: 'medium', transport: 'print' },
        claude: { model: 'kept-claude', effort: 'high', transport: 'print' },
    };
    config.persistAndCommit({ value: { ...next, perCli }, shape: 'absent' });
});

test('factory explicitly seeds native only for the three switchable engines', () => {
    const defaults = buildDefaultPerCli();
    for (const engine of engines) assert.equal(Reflect.get(defaults[engine]!, 'transport'), 'native');
    for (const engine of ['pi', 'codex-app', 'copilot']) assert.equal(Object.hasOwn(defaults[engine]!, 'transport'), false);
});

test('sanitizer clones perCli entries and validates only explicit switchable transports', () => {
    for (const source of ['api', 'boot', 'watch'] as const) {
        for (const bad of [null, 1, [], {}, 'automatic', false]) {
            const input = { perCli: {
                cursor: { transport: bad, model: 'm', auth: { profile: 'keep' } },
                pi: { transport: bad, effort: 'keep' },
            } };
            const out = sanitizeSettingsInput(input, source);
            assert.deepEqual(out.invalidPaths, ['perCli.cursor.transport']);
            assert.equal(Object.hasOwn(out.value.perCli.cursor, 'transport'), false);
            assert.deepEqual(out.value.perCli.cursor, { model: 'm', auth: { profile: 'keep' } });
            assert.deepEqual(out.value.perCli.pi, input.perCli.pi);
            assert.notEqual(out.value.perCli, input.perCli);
            assert.notEqual(out.value.perCli.cursor, input.perCli.cursor);
            assert.notEqual(out.value.perCli.pi, input.perCli.pi);
            assert.equal(input.perCli.cursor.transport, bad, 'do not mutate the incoming document');
        }
        for (const transport of ['native', 'print']) {
            assert.equal(sanitizeSettingsInput({ perCli: { grok: { transport } } }, source).value.perCli.grok.transport, transport);
        }
        const absent = sanitizeSettingsInput({ perCli: { cursor: { model: 'new' } } }, source);
        assert.equal(Object.hasOwn(absent.value.perCli.cursor, 'transport'), false, 'patch sanitation must not seed a mode');
    }
});

test('watch missing, invalid and unchanged transport preserve native and ownership', () => {
    const owner = getSessionOwnershipGeneration('scope');
    for (const patch of [{ model: 'new' }, { transport: 'invalid', effort: 'low' }, { transport: 'native' }]) {
        assert.equal(reloadSettingsFromDisk({ readImpl: () => JSON.stringify({ perCli: { cursor: patch } }), lastSavedRaw: null }), true);
        assert.equal(config.settings.perCli.cursor.transport, 'native');
        assert.equal(isCurrentSessionOwner(owner, 'scope'), true);
        assert.deepEqual(config.settings.perCli.cursor.auth, { profile: 'kept-auth' });
    }
    assert.equal(config.settings.perCli.cursor.model, 'new');
    assert.equal(config.settings.perCli.cursor.effort, 'low');
});

test('watch actual mode change commits first and bumps once before publication', () => {
    const owner = getSessionOwnershipGeneration('scope');
    const atPublication: unknown[] = [];
    const listener = (type: string) => {
        if (type === 'settings_change') atPublication.push({
            mode: config.settings.perCli.cursor.transport,
            current: isCurrentSessionOwner(owner, 'scope'),
            generation: getSessionOwnershipGeneration('scope').global,
        });
    };
    addBroadcastListener(listener);
    try {
        reloadSettingsFromDisk({ readImpl: () => JSON.stringify({ perCli: { cursor: { transport: 'print' }, grok: { transport: 'native' } } }), lastSavedRaw: null });
        assert.deepEqual(atPublication, [{ mode: 'print', current: false, generation: owner.global + 1 }]);
        assert.equal(config.settings.perCli.grok.transport, 'native');
        const next = getSessionOwnershipGeneration('scope');
        reloadSettingsFromDisk({ readImpl: () => JSON.stringify({ perCli: { cursor: { transport: 'print' } } }), lastSavedRaw: null });
        assert.deepEqual(getSessionOwnershipGeneration('scope'), next);
    } finally { removeBroadcastListener(listener); }
});

test('watch malformed/read-failed/self-write and non-switchable mode never invalidate owners', () => {
    const owner = getSessionOwnershipGeneration('scope');
    assert.equal(reloadSettingsFromDisk({ readImpl: () => '{broken', lastSavedRaw: null }), false);
    assert.equal(reloadSettingsFromDisk({ readImpl: () => { throw new Error('unreadable fixture'); }, lastSavedRaw: null }), false);
    assert.equal(reloadSettingsFromDisk({ readImpl: () => '{}', lastSavedRaw: '{}' }), false);
    reloadSettingsFromDisk({ readImpl: () => JSON.stringify({ perCli: { pi: { transport: 'other' } } }), lastSavedRaw: null });
    assert.equal(isCurrentSessionOwner(owner, 'scope'), true);
});

async function routeApp(apply?: (patch: Record<string, unknown>) => Promise<unknown>) {
    let applies = 0;
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, (_req, _res, next) => next(), async patch => {
        applies++;
        if (apply) return apply(patch);
        const merged = config.migrateSettings(mergeSettingsPatch(config.settings, patch));
        config.persistAndCommit({ value: merged, shape: config.getSettingsPersistenceShape() });
        return config.settings;
    }, process.cwd());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return { applies: () => applies,
        put: (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/settings`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}

test('actual settings PUT rejects invalid transport paths without applying or writing disk', async () => {
    const app = await routeApp();
    const before = readFileSync(config.SETTINGS_PATH, 'utf8');
    try {
        for (const engine of engines) {
            for (const transport of [1, [], 'other', null]) {
                const body = { perCli: { [engine]: { transport, model: 'must-not-write' } } };
                const response = await app.put(body);
                assert.equal(response.status, 400);
                assert.deepEqual(sanitizeSettingsInput(body, 'api').invalidPaths, [`perCli.${engine}.transport`]);
                assert.equal((await response.json()).error, 'invalid_settings_field');
                assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), before);
            }
        }
        assert.equal(app.applies(), 0);
    } finally { await app.close(); }
});

test('actual settings PUT partial updates preserve mode/model/effort/auth siblings', async () => {
    const app = await routeApp();
    try {
        const response = await app.put({ perCli: { cursor: { effort: 'low' } } });
        assert.equal(response.status, 200);
        await response.json();
        assert.deepEqual(config.settings.perCli.cursor, {
            model: 'kept-model', effort: 'low', transport: 'native', auth: { profile: 'kept-auth' },
        });
        assert.deepEqual(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).perCli.cursor, config.settings.perCli.cursor);
        assert.equal(app.applies(), 1);
    } finally { await app.close(); }
});

test('actual PUT -> applySettingsPatch toggles next-run P/N/P while preserving current owners and both buckets/singleton', async () => {
    const cli = 'cursor';
    const scope = 'default';
    const current = config.settings;
    config.persistAndCommit({ value: { ...current, cli,
        perCli: { ...current.perCli, cursor: { ...current.perCli.cursor, transport: 'print' } },
    }, shape: config.getSettingsPersistenceShape() });
    const model = config.settings.perCli.cursor.model;
    const effort = config.settings.perCli.cursor.effort;
    const workingDir = config.settings.workingDir;
    updateSession.run(cli, 'P', model, config.settings.permissions, workingDir, effort);
    const legacyBucket = resolveScopedSessionBucket(cli, model, null, scope, effort, 'fallback', false);
    const printBucket = runtimeSessionBucket(legacyBucket, 'print');
    const nativeBucket = runtimeSessionBucket(legacyBucket, 'native');
    upsertSessionBucket.run(printBucket, 'P', model, 'print-resume-key', 11);
    upsertSessionBucket.run(nativeBucket, 'N', model, 'native-resume-key', 22);
    const printBefore = getSessionBucket.get(printBucket);
    const nativeBefore = getSessionBucket.get(nativeBucket);
    const selectedSid = () => {
        const bucket = runtimeSessionBucket(legacyBucket, resolveRuntimeTransport(config.settings.perCli.cursor.transport));
        return (getSessionBucket.get(bucket) as { session_id: string }).session_id;
    };
    const selected = [selectedSid()];
    const atPublication: Array<{ mode: string; stale: boolean }> = [];
    let owner = getSessionOwnershipGeneration(scope);
    const capture = (type: string) => {
        if (type === 'settings_change') atPublication.push({
            mode: config.settings.perCli.cursor.transport, stale: !isCurrentSessionOwner(owner, scope),
        });
    };
    addBroadcastListener(capture);
    const app = await routeApp(applySettingsPatch);
    try {
        for (const transport of ['native', 'print']) {
            owner = getSessionOwnershipGeneration(scope);
            const response = await app.put({ perCli: { cursor: { transport } } });
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.data.perCli.cursor.transport, transport);
            assert.equal(config.settings.cli, cli, 'same CLI avoids CLI-switch bootstrap');
            assert.equal(config.settings.workingDir, workingDir);
            assert.equal(isCurrentSessionOwner(owner, scope), true);
            assert.equal(getSessionOwnershipGeneration(scope).global, owner.global);
            assert.deepEqual(getSessionBucket.get(printBucket), printBefore);
            assert.deepEqual(getSessionBucket.get(nativeBucket), nativeBefore);
            assert.equal((getSession() as { session_id: string }).session_id, 'P');
            assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).perCli.cursor.transport, transport);
            selected.push(selectedSid());
        }
        assert.deepEqual(selected, ['P', 'N', 'P']);
        assert.deepEqual(atPublication, [{ mode: 'native', stale: false }, { mode: 'print', stale: false }]);
        const beforeInvalid = readFileSync(config.SETTINGS_PATH, 'utf8');
        owner = getSessionOwnershipGeneration(scope);
        const invalid = await app.put({ perCli: { cursor: { transport: 'invalid' } } });
        assert.equal(invalid.status, 400);
        await invalid.json();
        assert.equal(isCurrentSessionOwner(owner, scope), true, 'rejected route input never reaches ownership invalidation');
        assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), beforeInvalid);
        assert.deepEqual(getSessionBucket.get(printBucket), printBefore);
        assert.deepEqual(getSessionBucket.get(nativeBucket), nativeBefore);
        assert.equal((getSession() as { session_id: string }).session_id, 'P');
        assert.equal(app.applies(), 2);
    } finally {
        removeBroadcastListener(capture);
        await app.close();
    }
});

test('watch and API retain environment-owned Slack fields alongside transport changes', async t => {
    const previous = process.env['SLACK_BOT_TOKEN'];
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-fixture-env';
    t.after(() => {
        if (previous === undefined) delete process.env['SLACK_BOT_TOKEN'];
        else process.env['SLACK_BOT_TOKEN'] = previous;
    });
    config.replaceSettings({ ...config.settings, slack: {
        ...config.settings.slack, botToken: 'xoxb-fixture-env', enabled: true, appToken: 'fixture-file-app', attachPort: 'retained',
    } }, 'absent');
    reloadSettingsFromDisk({ readImpl: () => JSON.stringify({ perCli: { cursor: { transport: 'print' } },
        slack: { botToken: 'must-not-overwrite', mentionOnly: false } }), lastSavedRaw: null });
    assert.equal(config.settings.slack.botToken, 'xoxb-fixture-env');
    assert.equal(config.settings.slack.appToken, 'fixture-file-app');
    assert.equal(config.settings.slack.attachPort, 'retained');
    const app = await routeApp();
    try {
        const before = readFileSync(config.SETTINGS_PATH, 'utf8');
        const denied = await app.put({ perCli: { cursor: { transport: 'native' } }, slack: { botToken: 'bad' } });
        assert.equal(denied.status, 409);
        await denied.json();
        assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), before);
        const accepted = await app.put({ perCli: { cursor: { transport: 'native' } } });
        assert.equal(accepted.status, 200);
        await accepted.json();
        const saved = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
        assert.equal(Object.hasOwn(saved.slack, 'botToken'), false);
        assert.equal(saved.slack.appToken, 'fixture-file-app');
        assert.equal(saved.slack.attachPort, 'retained');
    } finally { await app.close(); }
});
