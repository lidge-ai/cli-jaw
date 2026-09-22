import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { SettingsData } from '../../public/js/features/settings-types.ts';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

const settingsSnapshot: SettingsData = {
    cli: 'codex',
    workingDir: '/fixture',
    permissions: 'safe',
    locale: 'en',
    activeOverrides: {},
    perCli: {},
};
const localeFixture = {
    'chat.file.sent': 'File: {path}',
    'chat.file.sentWithMsg': '\nMessage: {text}',
};
let settingsWrite: Deferred<SettingsData | null> | null = null;
const apiPosts: Array<{ path: string; body: unknown }> = [];
const firePosts: Array<{ path: string; body: unknown }> = [];

mock.module('../../public/js/api.js', { namedExports: {
    API_BASE: '',
    getAuthToken: async () => '',
    apiFire: async (path: string, _method: string, body: unknown) => {
        firePosts.push({ path, body });
    },
    api: async (path: string) => {
        if (path === '/api/settings') return settingsSnapshot;
        if (path.startsWith('/api/i18n/')) return localeFixture;
        return null;
    },
    apiJson: async (path: string, _method: string, body: unknown) => {
        apiPosts.push({ path, body });
        if (path === '/api/settings' && settingsWrite) return settingsWrite.promise;
        return {};
    },
} });
// The real provider module imports Vite raw-SVG assets, which Node's focused
// test runner cannot load. Only that build-time adapter is replaced here.
mock.module('../../public/js/provider-icons.js', { namedExports: {
    providerIcon: () => '',
    providerLabel: (value: string) => value,
    hydrateProviderIcons: () => {},
} });

let settings: typeof import('../../public/js/features/settings-core.ts');
let chat: typeof import('../../public/js/features/chat.ts');
let state: typeof import('../../public/js/state.ts').state;
let previousFetch: typeof fetch;
const fetchPosts: Array<{ path: string; body: unknown }> = [];

function renderComposer(): HTMLTextAreaElement {
    document.body.innerHTML = `
        <span id="headerCli"></span><button id="headerProject"></button>
        <span id="cliProviderWrap"><span id="cliProviderLabel"></span><select id="selCliProvider"></select></span>
        <select id="selCli"><option value="claude">claude</option><option value="codex">codex</option></select>
        <select id="selModel"></select><select id="selEffort"></select>
        <select id="selPerm"><option value=""></option><option value="safe">safe</option></select>
        <span id="configuredPermText"></span><span id="configuredPerm"></span>
        <span id="inpCwd"></span>
        <main class="chat-area"><div id="chatMessages"></div></main>
        <textarea id="chatInput"></textarea><button id="btnSend"></button>
        <div id="filePreview"><div id="filePreviewList"></div></div><input id="fileInput">
    `;
    const cli = document.getElementById('selCli') as HTMLSelectElement;
    cli.value = 'codex';
    return document.getElementById('chatInput') as HTMLTextAreaElement;
}

function edit(input: HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function startBlockedSend(
    text: string,
    options: { attachment?: boolean } = {},
): Promise<{ input: HTMLTextAreaElement; save: Promise<void>; send: Promise<void> }> {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = text;
    if (options.attachment) {
        state.attachedFiles = [{ name: 'evidence.txt', type: 'text/plain', size: 8 } as File];
    }
    settingsWrite = deferred<SettingsData | null>();
    const save = settings.updateSettings();
    const send = chat.sendMessage('button');
    await Promise.resolve();
    return { input, save, send };
}

function finishSettingsSave(value: SettingsData | null = settingsSnapshot): void {
    assert.ok(settingsWrite, 'settings save must be pending');
    settingsWrite.resolve(value);
}

test.before(async () => {
    setupWebUiDom();
    previousFetch = globalThis.fetch;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
        const path = String(request);
        let body: unknown = init?.body;
        if (typeof body === 'string') body = JSON.parse(body);
        fetchPosts.push({ path, body });
        if (path.endsWith('/api/upload')) return Response.json({ path: '/tmp/evidence.txt' });
        if (path.endsWith('/api/command')) return Response.json({ text: 'done' });
        if (path.endsWith('/api/message')) return Response.json({});
        throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    const { initI18n } = await import('../../public/js/features/i18n.ts');
    await initI18n();
    settings = await import('../../public/js/features/settings-core.ts');
    chat = await import('../../public/js/features/chat.ts');
    ({ state } = await import('../../public/js/state.ts'));
});

test.beforeEach(() => {
    renderComposer();
    settingsWrite = null;
    state.attachedFiles = [];
    apiPosts.length = 0;
    firePosts.length = 0;
    fetchPosts.length = 0;
});

test.after(() => {
    globalThis.fetch = previousFetch;
    resetWebUiDom();
    mock.restoreAll();
});

test('ordinary send posts captured text once and preserves a newer draft', async () => {
    const { input, save, send } = await startBlockedSend('ordinary A');
    edit(input, 'ordinary B');
    const duplicate = chat.sendMessage('button');
    finishSettingsSave();
    await Promise.all([save, send, duplicate]);

    const messages = fetchPosts.filter(post => post.path.endsWith('/api/message'));
    assert.deepEqual(messages.map(post => post.body), [{ prompt: 'ordinary A' }]);
    assert.equal(input.value, 'ordinary B');
});

test('slash send preserves a raw-whitespace edit made behind the settings barrier', async () => {
    const { input, save, send } = await startBlockedSend('/help');
    edit(input, '   \n');
    finishSettingsSave();
    await Promise.all([save, send]);

    assert.deepEqual(fetchPosts.filter(post => post.path.endsWith('/api/command')).map(post => post.body), [{ text: '/help', locale: 'en-US' }]);
    assert.equal(input.value, '   \n');
});

test('attachment send preserves an ABA edit even when the final string matches', async () => {
    const { input, save, send } = await startBlockedSend('attachment A', { attachment: true });
    edit(input, 'attachment B');
    edit(input, 'attachment A');
    finishSettingsSave();
    await Promise.all([save, send]);

    const messages = apiPosts.filter(post => post.path === '/api/message');
    assert.equal(messages.length, 1);
    assert.match(String((messages[0]!.body as { prompt?: string }).prompt), /attachment A/);
    assert.equal(input.value, 'attachment A');
});

test('send never clears a replacement textarea with the submitted id and value', async () => {
    const { input, save, send } = await startBlockedSend('identity A');
    const replacement = input.cloneNode() as HTMLTextAreaElement;
    replacement.value = 'identity A';
    input.replaceWith(replacement);
    finishSettingsSave();
    await Promise.all([save, send]);

    assert.equal(document.getElementById('chatInput'), replacement);
    assert.equal(replacement.value, 'identity A');
});

test('unedited ordinary, slash, and attachment submissions retain immediate-clear behavior', async () => {
    for (const scenario of [
        { text: 'ordinary clear', attachment: false },
        { text: '/help', attachment: false },
        { text: 'attachment clear', attachment: true },
    ]) {
        renderComposer();
        state.attachedFiles = [];
        const { input, save, send } = await startBlockedSend(scenario.text, { attachment: scenario.attachment });
        finishSettingsSave();
        await Promise.all([save, send]);
        assert.equal(input.value, '', `${scenario.text} should clear when untouched`);
    }
});

test('failed settings save still preserves a newer draft while sending captured text', async () => {
    const { input, save, send } = await startBlockedSend('failure A');
    edit(input, 'failure B');
    finishSettingsSave(null);
    await Promise.all([save, send]);

    const messages = fetchPosts.filter(post => post.path.endsWith('/api/message'));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.body, { prompt: 'failure A' });
    assert.equal(input.value, 'failure B');
});

test('Stop preserves typed text and bypasses the settings barrier and send endpoints', async () => {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    const button = document.getElementById('btnSend') as HTMLButtonElement;
    input.value = 'keep after Stop';
    button.classList.add('stop-mode');

    await chat.sendMessage('button');

    assert.equal(input.value, 'keep after Stop');
    assert.deepEqual(firePosts.map(post => post.path), ['/api/stop']);
    assert.equal(fetchPosts.length, 0);
    assert.equal(apiPosts.length, 0);
});
