import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

// Classic now hosts the shared Slack page through the settings iframe.
// Lane A owns the shared page, registry, reset/setup and credential assertions below.
test('Classic settings has one lazy shared iframe and no duplicate Slack fields', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(read('public/index.html'), { url: 'http://127.0.0.1:3457/' });
    try {
        const tab = dom.window.document.querySelector('#settingsPage')!;
        assert.equal(tab.children.length, 1);
        const frame = tab.querySelector('iframe')!;
        assert.equal(frame.getAttribute('src'), 'dist/settings/index.html');
        assert.equal(frame.getAttribute('loading'), 'lazy');
        assert.equal(frame.getAttribute('title'), 'Instance settings');
        assert.equal(frame.hasAttribute('sandbox'), false);
        assert.equal(tab.querySelector('input, select, button'), null);
        assert.ok(dom.window.document.querySelector('#tabAgents #selCli'));
    } finally { dom.window.close(); }
});

test('Classic iframe bridge preserves proxy URL, accepts only its frame and disposes listeners', async t => {
    const { setupWebUiDom, resetWebUiDom } = await import('./web-ui-test-dom.ts');
    setupWebUiDom();
    t.after(resetWebUiDom);
    // Import the real bridge with no live API traffic from barrel initialization.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    t.after(() => { globalThis.fetch = originalFetch; });
    document.head.innerHTML = '<base href="http://127.0.0.1/i/3465/">';
    document.body.innerHTML = '<div class="chat-area"><div class="chat-header"><button id="btnSettings" aria-pressed="false">Settings</button></div><textarea id="chatInput"></textarea></div><section id="settingsPage" hidden><iframe></iframe></section>';
    document.documentElement.dataset['theme'] = 'dark';
    t.mock.module('../../public/js/provider-icons.js', { namedExports: { providerIcon: () => '', providerLabel: (value: string) => value } });
    const { initSettingsFrame, toggleSettingsPage } = await import('../../public/js/features/settings.ts');
    const dispose = initSettingsFrame();
    t.after(dispose);
    const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
    assert.equal(frame.src, 'http://127.0.0.1/i/3465/dist/settings/index.html');
    const messages: Array<{ data: unknown; origin: string }> = [];
    frame.contentWindow!.postMessage = (data: unknown, origin: string) => { messages.push({ data, origin }); };
    frame.dispatchEvent(new window.Event('load'));
    assert.deepEqual(messages, [{ data: { type: 'jaw-preview-theme-sync', theme: 'dark' }, origin: window.location.origin }]);
    const receive = (source: Window, origin: string, type = 'jaw-settings-ready') => window.dispatchEvent(
        new window.MessageEvent('message', { source, origin, data: { type } }),
    );
    receive(window, window.location.origin);
    receive(frame.contentWindow!, 'https://other.invalid');
    receive(frame.contentWindow!, window.location.origin, 'jaw-settings-saved');
    assert.equal(messages.length, 1);
    receive(frame.contentWindow!, window.location.origin);
    assert.equal(messages.length, 2);
    document.documentElement.dataset['theme'] = 'light';
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.deepEqual(messages.at(-1)?.data, { type: 'jaw-preview-theme-sync', theme: 'light' });
    const header = document.querySelector('.chat-header');
    toggleSettingsPage(true);
    assert.equal(document.querySelector('#settingsPage .chat-header'), header);
    assert.equal(document.querySelector<HTMLElement>('.chat-area')?.inert, true);
    assert.equal(document.querySelector('#settingsPage iframe'), frame);
    assert.equal(document.getElementById('btnSettings')?.getAttribute('aria-pressed'), 'true');
    toggleSettingsPage(false);
    assert.deepEqual(messages.at(-1)?.data, { type: 'settings:request-back' });
    assert.equal(document.getElementById('settingsPage')?.hidden, false, 'frame owns dirty confirmation');
    receive(window, window.location.origin, 'settings:back');
    receive(frame.contentWindow!, 'https://other.invalid', 'settings:back');
    assert.equal(document.getElementById('settingsPage')?.hidden, false);
    receive(frame.contentWindow!, window.location.origin, 'settings:back');
    assert.equal(document.getElementById('settingsPage')?.hidden, true);
    assert.equal(document.querySelector('.chat-area .chat-header'), header);
    assert.equal(document.querySelector<HTMLElement>('.chat-area')?.inert, false);
    assert.equal(document.activeElement?.id, 'chatInput');
    const before = messages.length;
    dispose();
    frame.dispatchEvent(new window.Event('load'));
    receive(frame.contentWindow!, window.location.origin);
    document.documentElement.dataset['theme'] = 'auto';
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(messages.length, before);
});

// ─── routes and manager registration ────────────────

test('the per-channel slack send route mirrors discord', () => {
    const routes = read('src/routes/messaging.ts');
    assert.ok(routes.includes(`'/api/slack/send'`), 'no /api/slack/send route');
    assert.match(routes, /channel: 'slack'/);
    // It must reuse the shared error helpers rather than inventing a shape.
    const slackBlock = routes.slice(routes.indexOf(`'/api/slack/send'`));
    assert.match(slackBlock, /sendResultHttpStatus\(result\)/);
    assert.match(slackBlock, /httpStatus\(e, 500\)/);
});

test('Slack registry entry is reachable through shared settings navigation', async t => {
    const { SETTINGS_REGISTRY, entriesForScopes } = await import('../../public/manager/src/settings/settings-registry');
    const entries = SETTINGS_REGISTRY.filter(entry => entry.id === 'channels-slack');
    assert.equal(entries.length, 1); assert.equal(entries[0]!.scope, 'instance');
    assert.ok(entriesForScopes(['instance'], true, 'en').some(entry => entry.id === 'channels-slack'));
    assert.equal(entriesForScopes(['manager'], false, 'en').some(entry => entry.id === 'channels-slack'), false);
    const { JSDOM } = await import('jsdom'); const React = await import('react');
    const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', { url: 'http://localhost:24576' });
    const globals = globalThis as unknown as Record<string, unknown>;
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globals, values);
    const { createRoot } = await import('react-dom/client'); const { act } = React;
    const { SettingsShell } = await import('../../public/manager/src/settings/SettingsShell');
    const container = dom.window.document.getElementById('root')!, root = createRoot(container);
    t.after(async () => {
        await act(async () => root.unmount()); dom.window.close();
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key]; }
    });
    const requests: string[] = [];
    const client: import('../../public/manager/src/settings/types').SettingsClient = {
        url: (path) => path,
        async get<T>(path: string) { requests.push(path); return (path === '/api/settings' ? { slack: {} } : {}) as T; },
        async put() { throw new Error('Unexpected write'); }, async post() { throw new Error('Unexpected write'); }, async delete() { throw new Error('Unexpected write'); },
    };
    await act(async () => root.render(React.createElement(SettingsShell, { initialId: 'display', scopes: ['instance'], port: 3465, instanceUrl: '/i/3465', client })));
    const slack = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-sidebar button')).find(button => button.textContent === 'Channels — Slack')!;
    await act(async () => { slack.click(); await entries[0]!.load(); });
    assert.equal(slack.getAttribute('aria-current'), 'page');
    assert.equal(container.querySelector<HTMLInputElement>('#sl-botToken')?.type, 'password');
    assert.equal(container.querySelector<HTMLInputElement>('#sl-appToken')?.type, 'password');
    assert.ok(requests.includes('/api/settings'));
});

test('manager shared components accept slack', () => {
    const toggle = read('public/manager/src/settings/pages/components/ActiveChannelToggle.tsx');
    assert.match(toggle, /'telegram' \| 'discord' \| 'slack'/);
    assert.match(toggle, /value: 'slack', label: 'Slack'/);
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.match(chips, /slack: TransportStatus/);
    assert.match(chips, /channel: 'telegram' \| 'discord' \| 'slack'/, 'the channel prop must accept slack');
    assert.match(chips, /\n\s+slack,\n/, 'the parser must return a slack member');
});

test('manager slack page masks both tokens', () => {
    const page = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(page, /SecretField[\s\S]{0,200}sl-botToken/);
    assert.match(page, /SecretField[\s\S]{0,200}sl-appToken/);
});

test('the outbound-only state is surfaced on the slack page, not the shared chips', () => {
    // The shared status chips are frozen for cross-channel behavior changes, so
    // missing_app_token is explained on the Slack page itself.
    const chips = read('public/manager/src/settings/pages/components/TransportStatusChips.tsx');
    assert.ok(!chips.includes('missing_app_token'), 'shared chips must stay channel-agnostic');
    const page = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(page, /OUTBOUND-ONLY/);
    assert.match(page, /outboundOnly/);
});

// ─── behavior (not source text) ─────────────────────

test('the slack slug is resolvable, not just present in the icon map', () => {
    // The asset and the map entry are NOT enough: resolveProviderSlug returns
    // null for an unregistered slug and providerIcon then returns '', so the
    // header icon renders empty. The module cannot be imported here because it
    // uses Vite `?raw` imports, so all three required pieces are asserted.
    const source = read('public/js/provider-icons.ts');
    assert.match(source, /\| 'slack'/, 'ProviderSlug union is missing slack');
    assert.match(source, /if \(normalized === 'slack'\) return 'slack';/, 'resolveProviderSlug has no slack branch');
    assert.match(source, /slack:\s*\{\s*color: slackSvg/, 'PROVIDER_ICONS has no slack entry');
    assert.match(source, /import slackSvg from '\.\.\/assets\/providers\/slack\.svg\?raw'/);
});

test('the slack provider asset is well-formed and matches the house convention', () => {
    const svg = read('public/assets/providers/slack.svg').trim();
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /fill="currentColor"/);
    assert.match(svg, /<title>Slack<\/title>/);
    assert.match(svg, /<\/svg>$/);
});

test('the classic health parser tolerates a pre-slack payload', async () => {
    // A newer bundle can be served against an older running server during a
    // rolling update; rejecting the payload would hide Telegram and Discord too.
    const { parseChannelHealth } = await import('../../public/js/features/transport-status-row.ts');
    const legacy = {
        channels: {
            activeInbound: 'telegram',
            telegram: { configured: true, activeInbound: true, sendCapable: true },
            discord: { configured: false, activeInbound: false, sendCapable: false },
        },
    };
    const health = parseChannelHealth(legacy);
    assert.ok(health, 'legacy two-channel payload was rejected outright');
    assert.equal(health.telegram.configured, true);
    assert.equal(health.slack.configured, false, 'slack should degrade, not vanish');
});

test('the classic health parser accepts a slack-bearing payload', async () => {
    const { parseChannelHealth } = await import('../../public/js/features/transport-status-row.ts');
    const health = parseChannelHealth({
        channels: {
            activeInbound: 'slack',
            telegram: { configured: false, activeInbound: false, sendCapable: false },
            discord: { configured: false, activeInbound: false, sendCapable: false },
            slack: { configured: true, activeInbound: true, sendCapable: true },
        },
    });
    assert.ok(health);
    assert.equal(health.activeInbound, 'slack');
    assert.equal(health.slack.sendCapable, true);
});

test('loadSlackSettings honours the true-by-default toggles', async () => {
    // A `!!` read would show mentionOnly/replyInThread off on a fresh install
    // while the backend behaved as on.
    const source = read('public/js/features/settings-slack.ts');
    assert.match(source, /const mentionOnly = sc\.mentionOnly !== false/);
    assert.match(source, /const replyInThread = sc\.replyInThread !== false/);
    // The legacy API remains callable, while its DOM owner has moved to the iframe.
    assert.doesNotMatch(read('public/index.html'), /id="slMentionOn"/);
});

// ─── parity sweep ───────────────────────────────────

test('no two-channel enumeration remains in src or the frontend', () => {
    const files = [
        'src/messaging/types.ts',
        'src/cli/types.ts',
        'public/js/features/settings-types.ts',
        'public/js/features/settings-channel.ts',
        'public/js/features/transport-status-row.ts',
        'public/manager/src/settings/pages/components/ActiveChannelToggle.tsx',
        'public/manager/src/settings/pages/components/TransportStatusChips.tsx',
    ];
    for (const file of files) {
        const source = read(file);
        assert.ok(
            !/'telegram'\s*\|\s*'discord'(?!\s*\|\s*'slack')/.test(source),
            `${file} still has a two-channel union`,
        );
    }
});

test('the manager settings-open relay accepts a cross-port loopback parent and rejects the rest', async t => {
    // Under the default origin-port preview transport the manager runs on a DIFFERENT loopback
    // port than the instance, so a strict same-origin check would silently drop every request.
    // This is the guard that must stay loose, while the iframe guard above stays strict.
    const { setupWebUiDom, resetWebUiDom } = await import('./web-ui-test-dom.ts');
    setupWebUiDom();
    t.after(resetWebUiDom);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    t.after(() => { globalThis.fetch = originalFetch; });
    document.head.innerHTML = '<base href="http://127.0.0.1/i/3465/">';
    document.body.innerHTML = '<div class="chat-area"><div class="chat-header"><button id="btnSettings" aria-pressed="false">Settings</button></div><textarea id="chatInput"></textarea></div><section id="settingsPage" hidden><iframe></iframe></section>';
    t.mock.module('../../public/js/provider-icons.js', { namedExports: { providerIcon: () => '', providerLabel: (value: string) => value } });
    const { initSettingsFrame } = await import('../../public/js/features/settings.ts');
    const dispose = initSettingsFrame();
    const page = document.getElementById('settingsPage')!;
    const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
    frame.contentWindow!.postMessage = () => {};
    const ask = (source: Window | null, origin: string) => window.dispatchEvent(
        new window.MessageEvent('message', { source, origin, data: { type: 'jaw-preview-settings-open' } }),
    );

    // A non-loopback origin must never open the page, whatever it claims to be.
    ask(window.parent, 'https://evil.invalid');
    assert.equal(page.hidden, true, 'a remote origin must not open instance settings');

    // Our own iframe is not the manager; the relay only listens to the parent.
    ask(frame.contentWindow, 'http://127.0.0.1');
    assert.equal(page.hidden, true, 'the settings iframe is not the request source');

    // The manager on another loopback port is the real case.
    ask(window.parent, 'http://localhost:24576');
    assert.equal(page.hidden, false, 'a loopback manager on another port must be accepted');
    assert.equal(document.body.dataset['settingsOpen'], 'true');

    dispose();
    document.body.removeAttribute('data-settings-open');
    page.hidden = true;
    ask(window.parent, 'http://localhost:24576');
    assert.equal(page.hidden, true, 'the disposer must detach the relay listener');
});
