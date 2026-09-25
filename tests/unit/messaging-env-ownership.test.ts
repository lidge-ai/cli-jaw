import '../setup/isolated-home.ts';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';

const home = process.env['CLI_JAW_HOME'];
assert.ok(home, 'isolated-home.ts must provide CLI_JAW_HOME');

const channelEnvironmentVariables = [
    'TELEGRAM_TOKEN',
    'TELEGRAM_ALLOWED_CHAT_IDS',
    'DISCORD_TOKEN',
    'DISCORD_GUILD_ID',
    'DISCORD_CHANNEL_IDS',
] as const;
for (const key of channelEnvironmentVariables) delete process.env[key];

const auditEntries: Array<Record<string, unknown>> = [];

mock.module('../../src/security/security-audit-log.ts', {
    namedExports: {
        getSecurityAuditLog: () => ({
            append: (_event: string, _actor: string, detail: Record<string, unknown>) => {
                auditEntries.push(detail);
            },
        }),
    },
});

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const config = await import('../../src/core/config.ts');
const runtimeSettings = await import('../../src/core/runtime-settings.ts');
const settingsWatch = await import('../../src/core/settings-watch.ts');

afterEach(() => {
    for (const key of channelEnvironmentVariables) delete process.env[key];
    config.loadSettings();
});

type RouteHandler = (req: any, res: any, next: (error?: unknown) => void) => void;

const allowAuth: RouteHandler = (_req, _res, next): void => next();

function registerRouteApp(
    auth: RouteHandler,
    applySettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>,
    method: 'GET' | 'PUT' | 'POST' = 'PUT',
    path = '/api/settings',
) {
    const routes = new Map<string, RouteHandler[]>();
    const register = (verb: string) => (routePath: string, ...handlers: RouteHandler[]): void => {
        routes.set(`${verb} ${routePath}`, handlers);
    };
    const app = { get: register('GET'), put: register('PUT'), post: register('POST') } as unknown as Express;
    registerSettingsRoutes(app, auth as never, applySettings, process.cwd());
    const route = routes.get(`${method} ${path}`);
    assert.ok(route, `${method} ${path} was not registered`);
    return route;
}

async function routeRequest(handlers: RouteHandler[], body: Record<string, unknown> = {}) {
    return await new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
        let status = 200;
        const response = {
            status(code: number) { status = code; return response; },
            setHeader() { return response; },
            json(body: Record<string, any>) { resolve({ status, json: body }); },
        };
        const request = { body, ip: 'local', query: {}, params: {} };
        const run = (index: number): void => {
            const handler = handlers[index];
            if (!handler) return reject(new Error('route completed without a response'));
            handler(request, response, (error?: unknown) => {
                if (error) reject(error);
                else run(index + 1);
            });
        };
        run(0);
    });
}

test('settings API rejects environment-managed Telegram connection writes but allows behavior settings', async () => {
    process.env['TELEGRAM_TOKEN'] = 'env-tg-token';
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(allowAuth, async (patch) => { patches.push(patch); return patch; });

    const rejected = await routeRequest(put, { telegram: { token: 'ui-tg-token', enabled: false } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error, 'telegram_connection_managed_by_environment');
    assert.deepEqual(rejected.json.environmentVariables, ['TELEGRAM_TOKEN']);
    assert.deepEqual(rejected.json.managedPaths, ['telegram.enabled', 'telegram.token']);
    assert.equal(JSON.stringify(rejected.json).includes('env-tg-token'), false);
    assert.equal(patches.length, 0);

    const allowed = await routeRequest(put, { telegram: { forwardAll: false, mentionOnly: true } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(patches, [{ telegram: { forwardAll: false, mentionOnly: true } }]);
});

test('settings API rejects only the Discord fields owned by configured environment variables', async () => {
    process.env['DISCORD_TOKEN'] = 'env-dc-token';
    const patches: Record<string, unknown>[] = [];
    const put = registerRouteApp(allowAuth, async (patch) => { patches.push(patch); return patch; });

    const rejected = await routeRequest(put, { discord: { token: 'ui-dc-token', enabled: false } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error, 'discord_connection_managed_by_environment');
    assert.deepEqual(rejected.json.environmentVariables, ['DISCORD_TOKEN']);
    assert.deepEqual(rejected.json.managedPaths, ['discord.enabled', 'discord.token']);
    assert.equal(JSON.stringify(rejected.json).includes('env-dc-token'), false);
    assert.equal(patches.length, 0);

    // guildId/channelIds belong to DISCORD_GUILD_ID/DISCORD_CHANNEL_IDS, which are unset.
    const siblings = await routeRequest(put, { discord: { guildId: 'file-guild', channelIds: ['file-ch'] } });
    assert.equal(siblings.status, 200);
    assert.equal(patches.length, 1);

    process.env['DISCORD_GUILD_ID'] = 'env-guild';
    const owned = await routeRequest(put, { discord: { guildId: 'ui-guild' } });
    assert.equal(owned.status, 409);
    assert.deepEqual(owned.json.environmentVariables, ['DISCORD_TOKEN', 'DISCORD_GUILD_ID']);
    assert.deepEqual(owned.json.managedPaths, ['discord.guildId']);
    assert.equal(patches.length, 1);
});

test('settings GET reports Telegram/Discord environment provenance without returning values', async () => {
    process.env['TELEGRAM_TOKEN'] = 'env-tg-token';
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '91,92';
    process.env['DISCORD_TOKEN'] = 'env-dc-token';
    config.loadSettings();
    const get = registerRouteApp(allowAuth, async () => ({}), 'GET');
    const { status, json } = await routeRequest(get);

    assert.equal(status, 200);
    assert.deepEqual(json.data.telegramEnvironmentVariables, ['TELEGRAM_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS']);
    assert.deepEqual(json.data.discordEnvironmentVariables, ['DISCORD_TOKEN']);
    assert.equal(json.data.telegram.enabled, true);
    assert.equal(json.data.telegram.token, '');
    assert.deepEqual(json.data.telegram.allowedChatIds, []);
    assert.equal(json.data.discord.token, '');
    assert.equal(JSON.stringify(json).includes('env-tg-token'), false);
    assert.equal(JSON.stringify(json).includes('env-dc-token'), false);
});

test('shared runtime settings boundary rejects environment-managed Telegram/Discord writes', async () => {
    process.env['TELEGRAM_TOKEN'] = 'env-tg-token';
    process.env['DISCORD_CHANNEL_IDS'] = 'env-ch1,env-ch2';
    await assert.rejects(
        runtimeSettings.applyRuntimeSettingsPatch({ telegram: { enabled: false } }),
        /telegram_connection_managed_by_environment/,
    );
    await assert.rejects(
        runtimeSettings.applyRuntimeSettingsPatch({ discord: { channelIds: ['ui-ch'] } }),
        /discord_connection_managed_by_environment/,
    );
});

test('settings watch ignores environment-managed Telegram/Discord fields on external writes', () => {
    process.env['TELEGRAM_TOKEN'] = 'env-tg-token';
    process.env['DISCORD_GUILD_ID'] = 'env-guild';
    config.loadSettings();

    const reloaded = settingsWatch.reloadSettingsFromDisk({
        readImpl: () => JSON.stringify({
            telegram: { token: 'file-tg-token', allowedChatIds: [5], forwardAll: false },
            discord: { guildId: 'file-guild', allowBots: true },
        }),
        lastSavedRaw: null,
    });
    assert.equal(reloaded, true);

    const s = config.settings as Record<string, any>;
    assert.equal(s.telegram.token, 'env-tg-token');
    assert.equal(s.telegram.enabled, true);
    assert.equal(s.telegram.forwardAll, false);
    // allowedChatIds has no env owner here, so the file value survives.
    assert.deepEqual(s.telegram.allowedChatIds, [5]);
    assert.equal(s.discord.guildId, 'env-guild');
    assert.equal(s.discord.allowBots, true);
});

// The issue's contract: with synthetic env + divergent file/UI values, the
// effective settings must be identical before a save, after a save, and after
// a restart — a UI choice that looks saved must not revert on the next boot.
test('environment-owned Telegram/Discord values are identical before save, after save, and after restart', async () => {
    // The file carries divergent operator values written before env vars existed.
    config.saveSettings({
        ...config.settings,
        telegram: {
            ...(config.settings['telegram'] || {}),
            enabled: false, token: 'file-tg-token', allowedChatIds: [7],
            forwardAll: false, mentionOnly: true,
        },
        discord: {
            ...(config.settings['discord'] || {}),
            enabled: false, token: 'file-dc-token', guildId: 'file-guild', channelIds: ['file-ch'],
            forwardAll: false, mentionOnly: true,
        },
    });
    process.env['TELEGRAM_TOKEN'] = 'env-tg-token';
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '7777777,8888888';
    process.env['DISCORD_TOKEN'] = 'env-dc-token';
    process.env['DISCORD_GUILD_ID'] = 'env-guild';
    process.env['DISCORD_CHANNEL_IDS'] = 'env-ch1,env-ch2';

    const effective = (s: Record<string, any>) => ({
        telegram: {
            enabled: s.telegram.enabled, token: s.telegram.token,
            allowedChatIds: s.telegram.allowedChatIds,
            forwardAll: s.telegram.forwardAll, mentionOnly: s.telegram.mentionOnly,
        },
        discord: {
            enabled: s.discord.enabled, token: s.discord.token,
            guildId: s.discord.guildId, channelIds: s.discord.channelIds,
            forwardAll: s.discord.forwardAll, mentionOnly: s.discord.mentionOnly,
        },
    });

    const before = effective(config.loadSettings() as Record<string, any>);
    assert.deepEqual(before, {
        telegram: {
            enabled: true, token: 'env-tg-token', allowedChatIds: ['7777777', '8888888'],
            forwardAll: false, mentionOnly: true,
        },
        discord: {
            enabled: true, token: 'env-dc-token', guildId: 'env-guild',
            channelIds: ['env-ch1', 'env-ch2'], forwardAll: false, mentionOnly: true,
        },
    });

    // A UI write of env-owned fields is refused outright — nothing commits.
    const put = registerRouteApp(allowAuth, async (patch) => patch);
    const rejected = await routeRequest(put, {
        telegram: { enabled: false, token: 'ui-tg-token' },
        discord: { enabled: false, guildId: 'ui-guild' },
    });
    assert.equal(rejected.status, 409);
    assert.equal(effective(config.settings as Record<string, any>).telegram.token, 'env-tg-token');

    // A non-owned sibling write commits and persists.
    await runtimeSettings.applyRuntimeSettingsPatch(
        { telegram: { forwardAll: true }, discord: { mentionOnly: false } },
        { restartMessaging: async () => {} },
    );
    const afterSave = effective(config.settings as Record<string, any>);
    assert.deepEqual(afterSave, {
        telegram: { ...before.telegram, forwardAll: true },
        discord: { ...before.discord, mentionOnly: false },
    });

    // Restart with the same environment reproduces the same effective values.
    const afterRestart = effective(config.loadSettings() as Record<string, any>);
    assert.deepEqual(afterRestart, afterSave);

    // Environment values and the shadowed file values never land on disk.
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, any>;
    const raw = JSON.stringify(persisted);
    for (const secret of ['env-tg-token', 'env-dc-token', 'env-guild', 'env-ch1', 'env-ch2',
        'file-tg-token', 'file-dc-token', 'file-guild', 'file-ch', '7777777', '8888888']) {
        assert.equal(raw.includes(secret), false, `managed value ${secret} must not persist`);
    }
    assert.equal('token' in (persisted.telegram ?? {}), false);
    assert.equal('enabled' in (persisted.telegram ?? {}), false);
    assert.equal('allowedChatIds' in (persisted.telegram ?? {}), false);
    assert.equal('token' in (persisted.discord ?? {}), false);
    assert.equal('enabled' in (persisted.discord ?? {}), false);
    assert.equal('guildId' in (persisted.discord ?? {}), false);
    assert.equal('channelIds' in (persisted.discord ?? {}), false);
    // Non-owned behavior fields still persist through the same serializer.
    assert.equal(persisted.telegram.forwardAll, true);
    assert.equal(persisted.discord.mentionOnly, false);
});

test('GET /api/settings blanks only the fields a configured variable owns', async () => {
    config.saveSettings({
        ...config.settings,
        telegram: { ...(config.settings['telegram'] || {}), token: 'file-tg-token', allowedChatIds: [7] },
        discord: {
            ...(config.settings['discord'] || {}),
            token: 'file-dc-token', guildId: 'file-guild', channelIds: ['file-ch'],
        },
    });
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '7777777';
    process.env['DISCORD_TOKEN'] = 'env-dc-token';
    config.loadSettings();

    const get = registerRouteApp(allowAuth, async (patch) => patch, 'GET');
    const { json } = await routeRequest(get);
    const body = (json['data'] ?? json) as Record<string, any>;

    assert.deepEqual(body.telegramEnvironmentVariables, ['TELEGRAM_ALLOWED_CHAT_IDS']);
    assert.deepEqual(body.telegram.allowedChatIds, []);
    assert.notEqual(body.telegram.token, '', 'file-held token is masked, not blanked');
    assert.notEqual(body.telegram.token, 'file-tg-token');

    assert.deepEqual(body.discordEnvironmentVariables, ['DISCORD_TOKEN']);
    assert.equal(body.discord.token, '');
    assert.equal(body.discord.guildId, 'file-guild');
    assert.deepEqual(body.discord.channelIds, ['file-ch']);
    assert.equal(JSON.stringify(json).includes('env-dc-token'), false);
});
