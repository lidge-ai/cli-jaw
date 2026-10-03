// Source contract for the onboarding wizard: the popup must exist for all
// three channels, be reachable from each settings section, and be the thing
// an unconfigured channel activation opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

test('every channel section exposes a wizard trigger', () => {
    for (const channel of ['telegram', 'discord']) {
        const page = read(`public/manager/src/settings/pages/Channels${channel[0]!.toUpperCase()}${channel.slice(1)}.tsx`);
        assert.match(page, new RegExp(`<ChannelSetupEntry channel="${channel}"`));
    }
    const entry = read('public/manager/src/settings/pages/components/ChannelSetupEntry.tsx');
    assert.match(entry, /data-onboard-channel=\{channel\}/);
    assert.match(entry, /<ChannelSetupDialog/);
    const slack = read('public/manager/src/settings/pages/ChannelsSlack.tsx');
    assert.match(slack, /data-onboard-channel="slack" onClick=\{openSetup\}/);
    assert.match(slack, /<SlackSetup/);
});

test('the wizard is initialized once from main.ts', () => {
    const main = read('public/js/main.ts');
    assert.match(main, /initChannelOnboarding\(\)/);
    assert.match(main, /from '\.\/features\/channel-onboarding\.js'/);
});

test('activating an unconfigured channel opens the wizard, not the read-only dialog', () => {
    const guide = read('public/js/features/channel-setup-guide.ts');
    assert.match(guide, /openChannelOnboarding\(ch\)/);
    assert.ok(!guide.includes('openHelpDialog('), 'the guard should no longer open the passive help dialog');
});

test('the wizard validates through the server route before saving', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.ok(mod.includes("'/api/channels/validate'"), 'no validation call');
    assert.ok(mod.includes("apiJson('/api/settings', 'PUT'"), 'no settings save');
    // Saving re-checks the verification gate instead of trusting the UI: the
    // save handler asks the flow whether step 3 is still satisfied.
    assert.match(mod, /blockerForStep\(\{ \.\.\.flow, step: 3 \}\)/);
});

test('the wizard renders four gated steps with a visible position', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /\$\{state\.step\}\/\$\{TOTAL_STEPS\}/, 'no 1/4 style step counter');
    assert.ok(mod.includes('data-onboard-next'), 'no next control');
    assert.ok(mod.includes('data-onboard-back'), 'no back control');
    // Advancing goes through the flow gate, never a raw step increment.
    assert.match(mod, /flow = advance\(flow\)/);
    assert.ok(!/state\.step \+ 1/.test(mod), 'the UI must not move steps by itself');
});

test('the step machine is a DOM-free module so its gates are testable', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    assert.ok(!flowMod.includes('document.'), 'the flow module must stay DOM-free');
    assert.ok(!/^import /m.test(flowMod), 'the flow module must stay import-free');
});

test('the popup behaves like a form: autofocus, Enter, Escape', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /focusFirstEmptyField\(\)/, 'no autofocus after render');
    assert.match(mod, /key !== 'Enter'/, 'Enter is not handled in the fields');
    assert.match(mod, /primaryAction\(\)/, 'Enter must trigger the step primary action');
    assert.match(mod, /ev\.key !== 'Escape'/, 'Escape does not close the popup');
    // Escape must be capture-phase like help-dialog, so the two overlays never
    // both react to one key press.
    assert.match(mod, /addEventListener\('keydown',[\s\S]{0,400}?\}, true\)/);
});

test('every credential field shows an example and where it comes from', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    const mod = read('public/js/features/channel-onboarding.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;

    // Placeholders are illustrative shapes, wired from the field definitions.
    assert.match(mod, /placeholder="\$\{escapeHtml\(field\.example\)\}"/);
    for (const example of [...flowMod.matchAll(/example: '([^']+)'/g)].map(m => m[1]!)) {
        assert.ok(example.length > 0);
        assert.ok(!/^[0-9a-f]{32,}$/i.test(example), 'examples must not look like real credentials');
    }
    // Every field has a source hint in ko.
    const channelFields: Record<string, string[]> = {
        telegram: ['botToken'],
        discord: ['botToken', 'guildId'],
        slack: ['botToken', 'appToken'],
    };
    for (const [channel, keys] of Object.entries(channelFields)) {
        for (const key of keys) {
            assert.ok(ko[`onboarding.hint.${channel}.${key}`], `ko.json missing hint for ${channel}.${key}`);
        }
    }
});

test('step 1 offers a real link to the issuing page for every channel', () => {
    const flowMod = read('public/js/features/channel-onboarding-flow.ts');
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(flowMod, /ISSUER_URLS/);
    for (const url of ['t.me/BotFather', 'discord.com/developers/applications', 'api.slack.com/apps']) {
        assert.ok(flowMod.includes(url), `missing issuer URL ${url}`);
    }
    assert.match(mod, /data-onboard-issuer/, 'no issuer button in step 1');
    assert.match(mod, /window\.open\(ISSUER_URLS\[flow\.channel\], '_blank', 'noopener'\)/, 'issuer button must open the issuing page in a new window');
});

test('Slack step 1 generates and copies a named JSON manifest before setup', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /data-onboard-app-name/, 'no Slack app-name input');
    assert.match(mod, /data-onboard-generate-manifest/, 'no manifest generation button');
    assert.match(mod, /data-onboard-manifest-status="1"/, 'no manifest generation status target');
    assert.match(mod, /slackAppName = 'cli-jaw'/, 'Slack app name must default to cli-jaw');
    assert.match(mod, /\/api\/slack\/manifest\?name=/, 'the app name is not sent to the canonical manifest route');
    assert.match(mod, /copyText\(json\)/, 'the JSON manifest must use the shared clipboard bridge');
    assert.doesNotMatch(mod, /pattern="\[a-z0-9\._-\]\+"/, 'app-name input must not impose the bot character class');
    assert.doesNotMatch(mod, /maxlength="35"/, 'HTML code-unit length must not preempt the code-point validator');
    assert.doesNotMatch(mod, /!\/\^\[a-z0-9\._-\]\+\$\/\.test\(appName\)/, 'client validation must not impose the bot character class');
    assert.match(mod, /!appName \|\| Array\.from\(appName\)\.length > 35/, 'client must enforce the app-name length contract');
    assert.match(mod, /data\?\.botDisplayName/, 'the UI must read the server-derived bot handle');
    assert.match(mod, /onboarding\.slackManifestCopiedWithBot/, 'the UI must disclose a changed bot handle');
    assert.doesNotMatch(mod, /postPreviewOpenBrowser/, 'Slack setup must not route through Manager Browser');

    const generationStart = mod.indexOf('async function runSlackManifestGeneration');
    const generationEnd = mod.indexOf('function captureInputs', generationStart);
    const generation = mod.slice(generationStart, generationEnd);
    assert.doesNotMatch(generation, /window\.open/, 'manifest generation must not open a browser window');
    assert.match(mod, /markSlackManifestGenerated\(flow\)/, 'copy success must unlock the issuer action');
    assert.match(mod, /markSlackIssuerOpened\(flow\)/, 'opening the issuer must unlock the next step');
    assert.match(mod, /resetSlackSetup\(flow\)/, 'editing the app name must reset Slack setup progress');
    assert.match(mod, /data-onboard-issuer="1"[^>]*disabled/, 'the issuer button must begin disabled');
    assert.match(mod, /data-onboard-next="1"[^>]*disabled/, 'the Slack next button must be truly disabled before issuer open');

    const css = read('public/css/sidebar.css');
    assert.match(css, /\.perm-btn:disabled/, 'disabled onboarding actions need an explicit visual state');

    const builder = mod.indexOf('data-onboard-generate-manifest');
    const guide = mod.indexOf("t(`onboarding.guide.${state.channel}`)");
    assert.ok(builder >= 0 && guide > builder, 'the existing Slack guide must remain below the new builder');

    for (const locale of ['en', 'ja', 'ko', 'zh']) {
        const dict = JSON.parse(read(`public/locales/${locale}.json`)) as Record<string, string>;
        for (const key of [
            'onboarding.slackAppName',
            'onboarding.slackAppNameHint',
            'onboarding.slackGenerateManifest',
            'onboarding.slackManifestGenerating',
            'onboarding.slackManifestReady',
            'onboarding.slackManifestCopiedWithBot',
            'onboarding.slackManifestError',
            'onboarding.slackAppNameError',
        ]) {
            assert.ok(dict[key], `${locale}.json missing ${key}`);
        }
    }
    const forbiddenSharedClaims = ['both the app and bot', '앱과 봇에 함께', 'アプリとボットの両方', '同时用于应用和机器人'];
    for (const [index, locale] of ['en', 'ko', 'ja', 'zh'].entries()) {
        const dict = JSON.parse(read(`public/locales/${locale}.json`)) as Record<string, string>;
        assert.ok(!dict['onboarding.slackAppNameHint']?.includes(forbiddenSharedClaims[index]!), `${locale}.json still claims one shared name`);
    }
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    assert.equal(ko['onboarding.slackManifestReady'], '복사되었습니다');
    assert.ok(!('onboarding.slackExistingApp' in ko), 'obsolete existing-app guidance must be removed');
});

test('notification permission is requested from the save gesture, once', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    const notif = read('public/js/features/notifications.ts');
    assert.match(mod, /maybeRequestNotificationPermission\(\)/);
    // Never on load: the only call site sits in the save path.
    const saveIdx = mod.indexOf('async function runSave');
    assert.ok(mod.indexOf('maybeRequestNotificationPermission()', saveIdx) > saveIdx);
    assert.match(notif, /localStorage\.setItem/, 'the ask must be remembered');
});

// ─── Robustness sweep regressions (260803) ──────────

test('an in-flight request cannot be applied to a different flow', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    // Switching channels mid-validation must not mark the new flow verified
    // with the old channel's result.
    assert.match(mod, /flowGeneration \+= 1/, 'the generation must bump on open');
    const guards = mod.match(/generation !== flowGeneration/g) ?? [];
    assert.ok(guards.length >= 2, `validate and save must both guard, found ${guards.length}`);
});

test('validate and save are single-flight', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /if \(!flow \|\| validating\) return/, 'double-click Validate must be ignored');
    assert.match(mod, /if \(!flow \|\| saving\) return/, 'double-click Save must be ignored');
    // A throwing save must not wedge the button forever.
    assert.match(mod, /finally \{\s*saving = false;\s*\}/);
});

test('the validate response type carries the missing-scope list', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    // Without this the server's missing_scopes detail is silently dropped.
    assert.match(mod, /missing\?: string\[\]/);
    assert.match(mod, /state\.missingScopes\.length/, 'the list must render');
    assert.match(mod, /missingCapabilities\?: string\[\]/);
    assert.match(mod, /state\.missingCapabilities\.length/);
    assert.match(mod, /onboarding-capability-warning/);
});

test('the modal is announced and keyboard-contained', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    assert.match(mod, /aria-labelledby="onboarding-title"/, 'dialog needs an accessible name');
    assert.match(mod, /id="onboarding-title"/);
    assert.match(mod, /role="alert"/, 'errors must be announced');
    assert.match(mod, /role="status" aria-live="polite"/, 'step changes must be announced');
    assert.match(mod, /ev\.key !== 'Tab'/, 'no focus trap: Tab escapes the modal');
    assert.match(mod, /onboarding\.progressLabel/, 'the step counter needs a translated label');
});

test('every onboarding i18n key the module uses exists in ko and en', () => {
    const mod = read('public/js/features/channel-onboarding.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    const en = JSON.parse(read('public/locales/en.json')) as Record<string, string>;
    const literal = [...mod.matchAll(/t\('(onboarding\.[a-zA-Z.]+)'/g)].map(m => m[1]!);
    // Only single-variable templates like `onboarding.guide.${channel}` join a
    // prefix to a channel. Two-variable keys (hint.${channel}.${field}) are
    // covered by the per-field hint test instead — matching them here would
    // capture a truncated prefix and assert keys that never existed.
    const templated = [...mod.matchAll(/t\(`(onboarding\.[a-zA-Z.]+)\.\$\{[a-zA-Z.]+\}`/g)].map(m => m[1]!);
    for (const key of new Set(literal)) {
        assert.ok(ko[key], `ko.json missing ${key}`);
        assert.ok(en[key], `en.json missing ${key}`);
    }
    // Every step label must exist, or the header renders a raw key.
    for (let step = 1; step <= 4; step++) {
        assert.ok(ko[`onboarding.step.${step}`], `ko.json missing onboarding.step.${step}`);
        assert.ok(en[`onboarding.step.${step}`], `en.json missing onboarding.step.${step}`);
    }
    // Templated families (title/guide/next/token/error) must cover every channel.
    for (const prefix of new Set(templated)) {
        for (const ch of ['telegram', 'discord', 'slack']) {
            if (prefix === 'onboarding.token' || prefix === 'onboarding.error' || prefix === 'onboarding.step') continue;
            assert.ok(ko[`${prefix}.${ch}`], `ko.json missing ${prefix}.${ch}`);
            assert.ok(en[`${prefix}.${ch}`], `en.json missing ${prefix}.${ch}`);
        }
    }
});

test('every validate-route error code has a user-facing message', () => {
    const route = read('src/messaging/channel-validate.ts');
    const flow = read('public/js/features/channel-onboarding-flow.ts');
    const ko = JSON.parse(read('public/locales/ko.json')) as Record<string, string>;
    const codes = [
        ...[...route.matchAll(/error: '([a-z_]+)'/g)].map(m => m[1]!),
        // The flow's own offline blockers use the same message namespace.
        ...[...flow.matchAll(/return '([a-z_]+)'/g)].map(m => m[1]!),
    ];
    assert.ok(codes.length >= 6, `expected the error vocabulary, found ${codes.length}`);
    for (const code of new Set(codes)) {
        assert.ok(ko[`onboarding.error.${code}`], `no message for error code ${code}`);
    }
});

test('shared Telegram and Discord setup validate before saving and protect page drafts', async t => {
    const { JSDOM } = await import('jsdom');
    const React = await import('react');
    const dom = new JSDOM('<html lang="en"><body><div id="root"></div></body></html>', { url: 'http://localhost:3457' });
    const globals = globalThis as unknown as Record<string, unknown>;
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement, React, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globals, values);
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    dom.window.confirm = () => true;
    const { createRoot } = await import('react-dom/client');
    const { createDirtyStore } = await import('../../public/manager/src/settings/dirty-store');
    const { default: Telegram } = await import('../../public/manager/src/settings/pages/ChannelsTelegram');
    const { default: Discord } = await import('../../public/manager/src/settings/pages/ChannelsDiscord');
    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    const { act } = React;
    t.after(async () => {
        await act(async () => root.unmount());
        dom.window.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
        }
    });
    for (const channel of ['telegram', 'discord'] as const) {
        await t.test(channel, async () => {
            const dirty = createDirtyStore();
            let settingsReads = 0, valid = false;
            let finishSave: () => void = () => {};
            let pageSave: import('../../public/manager/src/settings/types').SaveHandler | null = null;
            const writes: Array<{ path: string; body: unknown }> = [];
            const client: import('../../public/manager/src/settings/types').SettingsClient = {
                url: (path) => path,
                async get<T>(path: string) {
                    if (path === '/api/settings') settingsReads++;
                    return (path === '/api/settings' ? { [channel]: {} } : {}) as T;
                },
                async post<T>(path: string, body: unknown) {
                    writes.push({ path, body });
                    return (valid ? { ok: true, identity: 'test-bot' } : { ok: false, error: 'network' }) as T;
                },
                async put<T>(path: string, body: unknown) {
                    writes.push({ path, body });
                    await new Promise<void>(resolve => { finishSave = resolve; });
                    return {} as T;
                },
                async delete() { throw new Error('Unexpected delete'); },
            };
            const render = () => root.render(React.createElement(channel === 'telegram' ? Telegram : Discord, {
                port: 3457, instanceUrl: 'http://localhost:3457', client, dirty,
                registerSave: handler => { pageSave = handler; },
            }));
            await act(async () => render());
            const trigger = () => container.querySelector<HTMLButtonElement>(`[data-onboard-channel="${channel}"]`)!;
            const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('dialog button')]
                .find(el => el.textContent === name)!;
            const click = async (name: string) => { assert.ok(button(name), name); await act(async () => button(name).click()); };
            await act(async () => trigger().click());
            assert.ok(container.querySelector('dialog[open]'));
            assert.ok(dirty.isDirty());
            await assert.rejects(pageSave!, /Finish channel setup/);
            await click('Next');
            assert.equal(button('Next').disabled, true);
            const inputs = [...container.querySelectorAll<HTMLInputElement>('dialog input')];
            const token = channel === 'telegram' ? '123456:TEST_TOKEN' : 'discord-test-token';
            const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
            for (const [index, input] of inputs.entries()) {
                await act(async () => {
                    setValue.call(input, index === 0 ? token : '123456789012345678');
                    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
                });
            }
            await click('Next');
            assert.equal(button('Next').disabled, true);
            await click('Validate');
            assert.ok(container.querySelector('dialog [role="alert"]'));
            assert.equal(button('Next').disabled, true);
            assert.equal(writes.some(write => write.path === '/api/settings'), false);
            valid = true;
            await click('Validate');
            await click('Next');
            await click('Save');
            assert.equal(button('Close').disabled, true);
            await act(async () => { container.querySelector('dialog')!.dispatchEvent(new dom.window.Event('cancel', { cancelable: true })); });
            assert.ok(container.querySelector('dialog[open]'), 'closing during save must not expose editable stale fields');
            await act(async () => finishSave());
            assert.deepEqual(writes.at(-1), { path: '/api/settings', body: {
                [channel]: { enabled: true, token, ...(channel === 'discord' ? { guildId: '123456789012345678' } : {}) },
            } });
            await click('Close');
            assert.equal(container.querySelector('dialog'), null);
            assert.equal(dirty.isDirty(), false);
            assert.equal(settingsReads, 2);
            dirty.set(`${channel}.token`, { value: 'pending-token', original: '', valid: true });
            await act(async () => render());
            assert.equal(trigger().disabled, true);
            assert.equal(dirty.pending.get(`${channel}.token`)?.value, 'pending-token');
            await act(async () => root.render(null));
        });
    }
});
