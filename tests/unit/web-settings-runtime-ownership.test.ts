import '../setup/isolated-home.ts';
import test, { after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs, { readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';

// Block eager OS credential discovery and any accidental runtime subprocess.
// The route/wrapper/settings DB/persistence below are the actual owners.
for (const name of ['execFileSync', 'execSync', 'execFile', 'exec', 'spawn', 'spawnSync', 'fork'] as const) {
    mock.method(childProcess, name, () => { throw new Error('No subprocess allowed in settings ownership tests'); });
}
syncBuiltinESMExports();
const config = await import('../../src/core/config.ts');
const database = await import('../../src/core/db.ts');
const ownership = await import('../../src/agent/session-persistence.ts');
const { applySettingsPatch } = await import('../../src/core/session-ops.ts');
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const { settingsPatchPreservesActiveRun } = await import('../../src/core/runtime-settings.ts');
const { reloadSettingsFromDisk } = await import('../../src/core/settings-watch.ts');
const { resolveScopedSessionBucket } = await import('../../src/agent/args.ts');
const { runtimeSessionBucket, resolveRuntimeTransport } = await import('../../src/agent/runtime/selection.ts');
const home = config.JAW_HOME;
const bucket = 'native-v1:claude:owned-a';

beforeEach(() => {
    const value = structuredClone(config.DEFAULT_SETTINGS);
    Object.assign(value, { cli: 'claude', workingDir: home, projectDirs: [home], permissions: 'auto',
        presentation: { mode: 'activity' },
        perCli: { ...value['perCli'], claude: { model: 'sonnet', effort: '', transport: 'native' } },
        messaging: { ...value['messaging'], enabledChannels: [] },
        memory: { ...value['memory'], enabled: false }, heartbeat: { ...value['heartbeat'], enabled: false } });
    config.saveSettings(value);
    database.updateSession.run('claude', 'owned-native-session', 'singleton-sentinel', 'auto', home, 'high');
    database.upsertSessionBucket.run(bucket, 'owned-native-session', 'native-model', 'resume-key', 7);
    ownership.resetSessionOwnershipGenerationForTest();
});
after(() => {
    database.db.close(); rmSync(home, { recursive: true, force: true });
    mock.restoreAll(); syncBuiltinESMExports();
});
function tokens() { return ['owned-a', 'owned-b'].map(scope => ({ scope, token: ownership.getSessionOwnershipGeneration(scope) })); }
function assertCurrent(captured: ReturnType<typeof tokens>, current: boolean) {
    for (const { scope, token } of captured) assert.equal(ownership.isCurrentSessionOwner(token, scope), current, scope);
}
function snapshot() { return { session: database.getSession(), bucket: database.getSessionBucket.get(bucket) }; }

for (const mode of ['legacy', 'activity']) {
    test(`actual web wrapper preserves live owners for presentation ${mode}`, async () => {
        const owners = tokens(), before = snapshot();
        await applySettingsPatch({ presentation: { mode } });
        assertCurrent(owners, true); assert.deepEqual(snapshot(), before);
        assert.equal(config.settings['presentation'].mode, mode);
        assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).presentation.mode, mode);
    });
}
for (const cli of ['cursor', 'grok', 'claude']) for (const transport of ['print', 'native']) {
    test(`actual web wrapper defers ${cli} ${transport} to the next run`, async () => {
        const owners = tokens(), before = snapshot();
        await applySettingsPatch({ perCli: { [cli]: { transport } } });
        assertCurrent(owners, true); assert.deepEqual(snapshot(), before);
        assert.equal(config.settings['perCli'][cli].transport, transport);
        assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).perCli[cli].transport, transport);
        assert.equal(config.settings['permissions'], 'auto');
        assert.equal(config.settings['perCli'].claude.model, 'sonnet');
    });
}
test('display plus eligible transport still leaves the admitted run owned', async () => {
    const owners = tokens(), before = snapshot();
    await applySettingsPatch({ presentation: { mode: 'legacy' }, perCli: { claude: { transport: 'print' } } });
    assertCurrent(owners, true); assert.deepEqual(snapshot(), before);
});
// A project-root change used to revoke the running turn, which the Claude native
// runtime reported as "Claude native runtime failed. Check … login".
test('project root change leaves the admitted run owned and applies the root', async () => {
    const owners = tokens(), before = snapshot();
    await applySettingsPatch({ projectDirs: [home] });
    assertCurrent(owners, true); assert.deepEqual(snapshot(), before);
    assert.deepEqual(config.settings['projectDirs'], [fs.realpathSync.native(home)]);
});
test('clearing the project root with null leaves the admitted run owned', async () => {
    const owners = tokens();
    await applySettingsPatch({ projectDirs: null });
    assertCurrent(owners, true);
    assert.equal(config.settings['projectDirs'], null);
});
test('project root mixed with an execution change keeps the invalidation', async () => {
    const owners = tokens();
    await applySettingsPatch({ projectDirs: [home], perCli: { claude: { model: 'opus' } } });
    assertCurrent(owners, false);
});
for (const [name, patch] of [
    ['permissions', { presentation: { mode: 'legacy' }, permissions: 'safe' }],
    ['model', { perCli: { claude: { transport: 'print', model: 'opus' } } }],
    ['empty', {}],
] as const) test(`${name} keeps the existing execution invalidation`, async () => {
    const owners = tokens(); await applySettingsPatch(patch); assertCurrent(owners, false);
});

test('real settings HTTP route uses the preserving web wrapper, including reverse edits', async () => {
    const app = express(); app.use(express.json());
    registerSettingsRoutes(app, (_req, _res, next) => next(), applySettingsPatch, process.cwd());
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const owners = tokens(), before = snapshot();
    try {
        for (const patch of [{ presentation: { mode: 'legacy' } }, { perCli: { claude: { transport: 'print' } } },
            { presentation: { mode: 'activity' }, perCli: { claude: { transport: 'native' } } },
            { projectDirs: [home] }, { presentation: { mode: 'legacy' }, projectDirs: [home] }]) {
            const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
                method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
            assertCurrent(owners, true); assert.deepEqual(snapshot(), before);
        }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('strict classifier rejects malformed, empty, inherited and unrelated mixtures', () => {
    for (const input of [null, [], {}, { presentation: {} }, { presentation: { sibling: 'kept' } },
        { presentation: { mode: 'legacy', sibling: 'unknown' } }, { presentation: null },
        { presentation: { mode: 'native' } }, { perCli: null }, { perCli: [] }, { perCli: {} },
        { perCli: { claude: {} } }, { perCli: { claude: [] } }, { perCli: { claude: { transport: 'auto' } } },
        { perCli: { pi: { transport: 'native' } } }, { perCli: { claude: { transport: 'native', model: 'opus' } } },
        { presentation: { mode: 'legacy' }, permissions: 'safe' },
        { presentation: { mode: 'legacy' }, cli: 'cursor' },
        { presentation: { mode: 'legacy' }, workingDir: '/different' },
        { presentation: { mode: 'legacy' }, runtime: { codexApp: { laneMode: 'invalid' } } },
        { presentation: { mode: 'legacy' }, perCli: { cursor: { transport: null } } },
        JSON.parse('{"presentation":{"mode":"legacy"},"__proto__":{"cli":"cursor"}}'),
        JSON.parse('{"perCli":{"constructor":{"transport":"native"}}}'),
        JSON.parse('{"perCli":{"__proto__":{"transport":"native"}}}'),
        Object.create({ presentation: { mode: 'legacy' } }),
        { perCli: { claude: Object.create({ transport: 'native' }) } },
        Object.assign(Object.create({ perCli: { claude: { model: 'opus' } } }), { presentation: { mode: 'legacy' } }),
        // A project-root value that would silently clear or shrink the root mid-turn.
        { projectDirs: 'x' }, { projectDirs: [1] }, { projectDirs: {} }, { projectDirs: [] },
        { projectDirs: ['./rel'] }, { projectDirs: ['/definitely/missing/cli-jaw-dir'] }, { projectDirs: [home, home] },
        { projectDirs: [home], cli: 'cursor' }, { projectDirs: [home], workingDir: '/x' },
    ]) assert.equal(settingsPatchPreservesActiveRun(input as Record<string, unknown>), false, JSON.stringify(input));
    assert.equal(settingsPatchPreservesActiveRun({ presentation: { mode: 'legacy' }, perCli: {
        cursor: { transport: 'native' }, grok: { transport: 'print' }, claude: { transport: 'native' },
    } }), true);
    for (const input of [{ projectDirs: [home] }, { projectDirs: null },
        { presentation: { mode: 'legacy' }, projectDirs: [home] }]) {
        assert.equal(settingsPatchPreservesActiveRun(input), true, JSON.stringify(input));
    }
});

test('safe save failure preserves ownership without swallowing the write error', async t => {
    const owners = tokens(), before = config.snapshotSettingsState(), raw = readFileSync(config.SETTINGS_PATH, 'utf8');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === config.SETTINGS_PATH) throw Error('owned write failure');
        return write(...args);
    });
    await assert.rejects(applySettingsPatch({ presentation: { mode: 'legacy' } }), /owned write failure/);
    assertCurrent(owners, true); assert.deepEqual(config.snapshotSettingsState(), before);
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), raw);
});

test('safe save never revives a token invalidated by an execution change', async () => {
    const owners = tokens();
    const changing = applySettingsPatch({ perCli: { claude: { model: 'opus' } } });
    const preference = applySettingsPatch({ presentation: { mode: 'legacy' } });
    await Promise.all([changing, preference]); assertCurrent(owners, false);
    assert.equal(config.settings['perCli'].claude.model, 'opus');
});

for (const from of ['native', 'print'] as const) for (const scopeKey of ['default', 'owned-a']) {
    test(`${scopeKey}: admitted ${from} completion persists to its captured namespace after preference flips`, async () => {
        const to = from === 'native' ? 'print' : 'native';
        config.saveSettings({ ...config.settings, perCli: { ...config.settings['perCli'], claude: {
            ...config.settings['perCli'].claude, transport: from,
        } } });
        const base = resolveScopedSessionBucket('claude', 'sonnet', undefined, scopeKey, '', 'fallback', false);
        const original = runtimeSessionBucket(base, from), next = runtimeSessionBucket(base, to);
        database.upsertSessionBucket.run(original, 'original-session', 'sonnet', 'original-key', 1);
        database.upsertSessionBucket.run(next, 'next-session', 'sonnet', 'next-key', 2);
        const nextBefore = database.getSessionBucket.get(next), singleton = database.getSession();
        const persistenceOwner = ownership.getSessionOwnershipGeneration(scopeKey);
        await applySettingsPatch({ perCli: { claude: { transport: to } } });
        assert.equal(reloadSettingsFromDisk(), false, 'own saved file echo is ignored');
        assert.equal(ownership.persistMainSession({ persistenceOwner, scopeKey, cli: 'claude', model: 'sonnet',
            effort: '', sessionId: 'completed-original', code: 0, runtimeTransport: from,
            scopedBucket: original, workingDir: home, permissions: 'auto' }), true);
        assert.equal((database.getSessionBucket.get(original) as { session_id: string }).session_id, 'completed-original');
        assert.deepEqual(database.getSessionBucket.get(next), nextBefore);
        assert.equal(runtimeSessionBucket(base, resolveRuntimeTransport(config.settings['perCli'].claude.transport)), next);
        if (from === 'native' || scopeKey !== 'default') assert.deepEqual(database.getSession(), singleton);
        else assert.equal((database.getSession() as { session_id: string }).session_id, 'completed-original');
    });
}
