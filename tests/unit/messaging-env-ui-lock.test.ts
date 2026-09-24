import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><body>
    <input id="tgToken" value="">
    <input id="tgChatIds" value="">
    <button id="tgOn" class="active"></button>
    <button id="tgOff"></button>
    <button id="telegram-onboarding-trigger"></button>
    <div id="telegram-environment-managed" style="display:none"></div>
    <input id="dcToken" value="">
    <input id="dcGuildId" value="">
    <input id="dcChannelIds" value="">
    <button id="dcOn" class="active"></button>
    <button id="dcOff"></button>
    <button id="discord-onboarding-trigger"></button>
    <div id="discord-environment-managed" style="display:none"></div>
</body>`, { url: 'http://127.0.0.1:3459/' });

Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[] = [];
let alerts: string[] = [];

Object.defineProperty(dom.window, 'alert', {
    configurable: true,
    value: (message: string) => alerts.push(message),
});

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/auth/token')) {
        return new Response(JSON.stringify({ token: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    fetchCalls.push({
        url,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
};

const { loadTelegramSettings, saveTelegramSettings, setTelegram } =
    await import('../../public/js/features/settings-telegram.ts');
const { loadDiscordSettings, saveDiscordSettings, setDiscord } =
    await import('../../public/js/features/settings-discord.ts');

function input(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
}

function button(id: string): HTMLButtonElement {
    return document.getElementById(id) as HTMLButtonElement;
}

beforeEach(() => {
    fetchCalls = [];
    alerts = [];
    for (const id of ['tgToken', 'tgChatIds', 'dcToken', 'dcGuildId', 'dcChannelIds']) {
        input(id).value = '';
        input(id).disabled = false;
    }
    for (const id of ['tgOn', 'tgOff', 'telegram-onboarding-trigger', 'dcOn', 'dcOff', 'discord-onboarding-trigger']) {
        button(id).disabled = false;
    }
    for (const id of ['telegram-environment-managed', 'discord-environment-managed']) {
        const notice = document.getElementById(id);
        if (notice) { notice.style.display = 'none'; notice.textContent = ''; }
    }
});

test('environment metadata proactively locks Telegram connection controls and shows only variable names', () => {
    loadTelegramSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        telegram: { enabled: true, token: '', allowedChatIds: [] },
        telegramEnvironmentVariables: ['TELEGRAM_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS'],
    });

    for (const id of ['tgToken', 'tgChatIds']) {
        assert.equal(input(id).disabled, true, `${id} should be read-only`);
        assert.equal(input(id).value, '', `${id} should be blanked`);
    }
    for (const id of ['tgOn', 'tgOff', 'telegram-onboarding-trigger']) {
        assert.equal(button(id).disabled, true, `${id} should be disabled`);
    }
    const notice = document.getElementById('telegram-environment-managed');
    assert.equal(notice?.style.display, '');
    assert.equal(notice?.textContent, 'settings.telegram.managedByEnvironment');
});

test('environment metadata proactively locks Discord connection controls and shows only variable names', () => {
    loadDiscordSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        discord: { enabled: true, token: '', guildId: '', channelIds: [] },
        discordEnvironmentVariables: ['DISCORD_TOKEN'],
    });

    for (const id of ['dcToken', 'dcGuildId', 'dcChannelIds']) {
        assert.equal(input(id).disabled, true, `${id} should be read-only`);
        assert.equal(input(id).value, '', `${id} should be blanked`);
    }
    for (const id of ['dcOn', 'dcOff', 'discord-onboarding-trigger']) {
        assert.equal(button(id).disabled, true, `${id} should be disabled`);
    }
    const notice = document.getElementById('discord-environment-managed');
    assert.equal(notice?.style.display, '');
    assert.equal(notice?.textContent, 'settings.discord.managedByEnvironment');
});

test('Telegram controls stay editable and writable without environment ownership', async () => {
    loadTelegramSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        telegram: { enabled: true, token: 'file-tg-token', allowedChatIds: [42] },
    });

    assert.equal(input('tgToken').disabled, false);
    assert.equal(input('tgToken').value, 'file-tg-token');
    assert.equal(input('tgChatIds').value, '42');
    assert.equal(document.getElementById('telegram-environment-managed')?.style.display, 'none');

    await setTelegram(false);
    assert.deepEqual(fetchCalls.map(({ url, method, body }) => ({ url, method, body })), [{
        url: '/api/settings', method: 'PUT', body: { telegram: { enabled: false } },
    }]);
});

test('Discord controls stay editable and writable without environment ownership', async () => {
    loadDiscordSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        discord: { enabled: true, token: 'file-dc-token', guildId: 'file-guild', channelIds: ['file-ch'] },
    });

    assert.equal(input('dcToken').disabled, false);
    assert.equal(input('dcToken').value, 'file-dc-token');
    assert.equal(input('dcGuildId').value, 'file-guild');
    assert.equal(input('dcChannelIds').value, 'file-ch');
    assert.equal(document.getElementById('discord-environment-managed')?.style.display, 'none');

    await setDiscord(false);
    assert.deepEqual(fetchCalls.map(({ url, method, body }) => ({ url, method, body })), [{
        url: '/api/settings', method: 'PUT', body: { discord: { enabled: false } },
    }]);
});

test('Telegram save/enable bail before any write while environment-managed', async () => {
    loadTelegramSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        telegram: { enabled: true, token: '' },
        telegramEnvironmentVariables: ['TELEGRAM_TOKEN'],
    });
    input('tgToken').value = 'ui-tg-token';

    await saveTelegramSettings();
    await setTelegram(false);

    assert.deepEqual(alerts, [
        'settings.telegram.managedByEnvironment',
        'settings.telegram.managedByEnvironment',
    ]);
    assert.equal(fetchCalls.length, 0);
});

test('Discord save/enable bail before any write while environment-managed', async () => {
    loadDiscordSettings({
        cli: 'codex', workingDir: '', permissions: 'auto',
        discord: { enabled: true, token: '' },
        discordEnvironmentVariables: ['DISCORD_TOKEN'],
    });
    input('dcToken').value = 'ui-dc-token';

    await saveDiscordSettings();
    await setDiscord(false);

    assert.deepEqual(alerts, [
        'settings.discord.managedByEnvironment',
        'settings.discord.managedByEnvironment',
    ]);
    assert.equal(fetchCalls.length, 0);
});
