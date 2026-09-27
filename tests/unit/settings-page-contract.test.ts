import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import type { SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globals, replacements);
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SettingsPage } = await import('../../public/manager/src/settings/SettingsPage');
const { Workbench } = await import('../../public/manager/src/components/Workbench');
const { CommandCenter } = await import('../../public/manager/src/components/CommandCenter');
const { ThemeSwitch } = await import('../../public/manager/src/components/ThemeSwitch');
const { settingsIcon } = await import('../../public/manager/src/settings/settings-icons');
await import('../../public/manager/src/settings/pages/Display');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const client: SettingsClient = {
    async get<T>() { return { presentation: { mode: 'activity' }, tui: {} } as T; },
    async put<T>() { return {} as T; }, async post<T>() { return {} as T; }, async delete<T>() { return {} as T; },
};

test('full settings page exposes Back, grouped icon nav, scope title and keyboard return', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); let backs = 0;
    try {
        await act(async () => root.render(createElement(SettingsPage, {
            port: 3457, instanceUrl: '/i/3457', client, initialId: 'display', scopes: ['instance'], onBack: () => { backs++; },
        })));
        const back = container.querySelector<HTMLButtonElement>('.settings-back')!;
        assert.equal(back.textContent?.trim(), 'Back to workspace');
        assert.equal(document.activeElement, back);
        assert.equal(container.querySelector('.settings-page-heading h2')?.textContent, 'Display');
        assert.equal(container.querySelector('.settings-page-badge')?.textContent, 'Instance');
        assert.deepEqual([...container.querySelectorAll('[aria-current="page"]')].map(node => node.textContent?.trim()), ['Display']);
        assert.equal(container.querySelector('[aria-label="Runtime"] h3')?.textContent, 'Runtime');
        for (const item of container.querySelectorAll('.settings-sidebar-item')) {
            assert.ok(item.querySelector('svg'), 'every category has a registry glyph');
            assert.equal(item.getAttribute('title'), item.textContent?.trim());
        }
        await act(async () => back.click()); assert.equal(backs, 1);
        await act(async () => back.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.equal(backs, 2);
        const dialog = document.createElement('dialog'); container.querySelector('.settings-shell')!.append(dialog);
        dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(backs, 2, 'nested dialogs own Escape');
        assert.equal(settingsIcon('unknown-category'), 'settings');
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('the Workbench keeps its preview iframe and hosts no settings panel', async () => {
    // Settings moved to the rail workspace, so the Workbench must not gain a second
    // instance-settings surface — and its preview must still survive tab changes.
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const render = async (mode: 'preview' | 'overview') => act(async () => root.render(createElement(Workbench, {
        mode, onModeChange() {}, header: 'Instance', preview: createElement('iframe', { title: 'Preview' }),
        overview: 'Overview', logs: 'Logs', active: true,
    })));
    try {
        await render('preview'); const frame = container.querySelector('iframe');
        await render('overview');
        assert.equal(container.querySelector('iframe'), frame, 'the preview iframe must not remount');
        assert.equal(container.querySelector<HTMLElement>('[data-preview-host]')?.hidden, true);
        assert.equal(container.querySelector('.workbench-settings-page'), null);
        assert.equal(container.querySelector<HTMLElement>('.workbench-header')?.hidden, false,
            'nothing hides the Workbench header now that the settings panel is gone');
        await render('preview');
        assert.equal(container.querySelector('iframe'), frame);
        assert.equal(container.querySelector<HTMLElement>('[data-preview-host]')?.hidden, false);
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('the command centre carries no settings gear', async () => {
    // The workbench gear was the second settings entry point; the rail is the only one.
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(CommandCenter, { title: 'Dashboard', search: null, mobileMenuButton: null,
            actions: createElement('div', { className: 'command-actions-group' }, createElement(ThemeSwitch, { theme: 'dark', onChange() {} })) })));
        assert.equal(container.querySelector('.workbench-settings-toggle'), null);
        assert.equal(container.querySelector('#command-settings-slot'), null,
            'the portal slot must go with the gear it existed for');
        assert.ok(container.querySelector('button[aria-label="Theme: Dark"][aria-haspopup="menu"]'),
            'the theme menu control stays and names the current theme');
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('settings CSS specifies the measured card, row and responsive navigation geometry', () => {
    const sheet = postcss.parse(readFileSync('public/manager/src/settings-shell.css', 'utf8') + readFileSync('public/manager/src/settings-controls.css', 'utf8'));
    const value = (selector: string, property: string) => {
        let result: string | undefined;
        sheet.walkRules(rule => {
            if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
            rule.walkDecls(property, decl => { result = decl.value; });
        });
        return result;
    };
    assert.equal(value('.settings-shell', 'grid-template-columns'), '264px minmax(0, 1fr)');
    assert.equal(value('.settings-page-main', 'max-width'), '896px');
    assert.equal(value('.settings-page', 'border-radius'), '12px');
    assert.equal(value('.settings-nav-icon svg', 'width'), '16px');
    assert.equal(value('.settings-page-heading h2', 'font-size'), '24px');
    assert.equal(value('.settings-shell .settings-field', 'grid-template-columns'), 'minmax(0,1fr) 192px');
    assert.equal(value('.settings-shell .settings-field', 'padding'), '12px 16px');
    assert.equal(value('.settings-shell .settings-field', 'border-top'), '1px solid var(--settings-border)');
    let mobileGrid: string | undefined;
    sheet.walkAtRules('media', at => { if (at.params === '(max-width: 1023px)') at.walkRules('.settings-shell', rule => { rule.walkDecls('grid-template-columns', decl => { mobileGrid = decl.value; }); }); });
    assert.equal(mobileGrid, '40px minmax(0, 1fr)');
});

test('Dashboard meta refuses to load or write without a selected instance', async () => {
    // SettingsShell passes port ?? 0, and this page PATCHes the MANAGER registry keyed by
    // port. A port-0 render would write under instance key "0", so the guard must run
    // before any hook fires — not as an early return inside the form.
    const { default: DashboardMeta } = await import('../../public/manager/src/settings/pages/DashboardMeta');
    const { createDirtyStore } = await import('../../public/manager/src/settings/dirty-store');
    const managerCalls: string[] = [];
    const managerClient = {
        async get<T>(path: string) { managerCalls.push('GET ' + path); return { registry: { instances: {} } } as T; },
        async patch<T>(path: string) { managerCalls.push('PATCH ' + path); return {} as T; },
    };
    const instanceCalls: string[] = [];
    const spyClient: SettingsClient = {
        async get<T>(path: string) { instanceCalls.push(path); return {} as T; },
        async put<T>() { return {} as T; }, async post<T>() { return {} as T; }, async delete<T>() { return {} as T; },
    };
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(DashboardMeta, {
            port: 0, instanceUrl: '', client: spyClient, dirty: createDirtyStore(), managerClient,
        })));
        assert.deepEqual(managerCalls, [], 'no instance selected must mean no registry read or write');
        assert.deepEqual(instanceCalls, []);
        assert.equal(container.querySelector('form, input, .settings-form'), null,
            'the form must not mount, otherwise a save could target instance key "0"');
        const empty = container.querySelector('.settings-empty');
        assert.ok(empty && /select an instance/i.test(empty.textContent || ''),
            'the guard must say why the page is empty');
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('the dashboard rail settings surface can never expose instance-scoped pages', async () => {
    // The user requirement is literal: the rail gear shows whole-dashboard settings and
    // instance-specific settings must never appear there. Two independent guarantees.
    const { entriesForScopes } = await import('../../public/manager/src/settings/settings-registry');

    // 1. Render the rail's own surface and read the sidebar it actually produces. Asserting
    //    over entriesForScopes(['manager'], ...) alone would be a tautology: the filter tests
    //    scopes.includes(entry.scope) first, so it can never return an instance page.
    const { SettingsSidebar } = await import('../../public/manager/src/settings/SettingsSidebar');
    // The oracle is hardcoded and keyed on id, on purpose. Deriving it from
    // entriesForScopes(['instance'], ...) is a tautology: flipping a page's scope removes it
    // from the instance set at the same moment it enters the manager set, so a mis-scoped page
    // renders in the rail and the comparison still passes. Keying on label instead of id has a
    // narrower version of the same hole — a hidden entry can be unhidden and re-scoped without
    // ever appearing in a label list. These ids are the instance-owned surfaces the user said
    // must never reach the dashboard gear, hidden ones included.
    const instanceOwnedIds = new Set([
        'agent', 'model', 'profile', 'display',
        'channels-telegram', 'channels-discord', 'channels-slack',
        'heartbeat', 'memory', 'employees', 'mcp', 'speech',
        'prompts', 'browser', 'network', 'permissions', 'advanced-export',
    ]);
    const { SETTINGS_REGISTRY } = await import('../../public/manager/src/settings/settings-registry');
    // Scope first: no instance-owned id may claim manager scope, hidden or not.
    for (const entry of SETTINGS_REGISTRY) {
        if (!instanceOwnedIds.has(entry.id)) continue;
        assert.equal(entry.scope, 'instance',
            `"${entry.id}" is instance-owned and must never carry manager scope`);
    }
    // Keep the list honest in the other direction: every id must still exist, so the guard
    // cannot quietly protect pages that were deleted or renamed.
    const registeredIds = new Set(SETTINGS_REGISTRY.map(e => e.id));
    for (const id of instanceOwnedIds) {
        assert.ok(registeredIds.has(id as never),
            `"${id}" is no longer registered; update this list deliberately`);
    }
    const instanceLabels = new Set(SETTINGS_REGISTRY
        .filter(e => instanceOwnedIds.has(e.id))
        .map(e => typeof e.label === 'function' ? e.label('en') : e.label));
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
        // Render the sidebar the rail actually builds, with a port present. The rail supplies
        // one because Dashboard meta edits that instance's manager-registry row; scope, not a
        // missing port, is what fences the surface.
        await act(async () => root.render(createElement(SettingsSidebar, {
            activeId: 'manager-display', scopes: ['manager'], hasInstance: true, locale: 'en',
            onSelect() {},
        })));
        const rendered = [...container.querySelectorAll('.settings-sidebar-item')]
            .map(el => el.textContent?.trim() ?? '');
        assert.ok(rendered.length > 0, 'the rail settings sidebar must render entries');
        for (const label of rendered) {
            assert.equal(instanceLabels.has(label), false,
                `the rail gear exposed the instance page "${label}"`);
        }
        const scopes = [...container.querySelectorAll('.settings-scope-label')].map(el => el.textContent);
        assert.deepEqual(scopes, ['Manager'], 'the rail must render exactly one scope section');
    } finally { await act(async () => root.unmount()); container.remove(); }

    // 2. Call-site: the router must pass a literal manager-only scope and must not hand the
    //    page a port, so hasInstance is false even if an entry were mis-filed.
    const router = readFileSync(new URL('../../public/manager/src/SidebarRailRouter.tsx', import.meta.url), 'utf8');
    assert.ok(router.includes("scopes={['manager']}"),
        'the rail settings page must request manager scope literally');
    assert.equal(router.includes("scopes={selected ? ['instance', 'manager']"), false,
        'the rail must not widen its scope when an instance is selected');
    assert.equal(router.includes('WorkbenchSettingsToggle'), false,
        'the workbench gear is the removed second entry point');
});

test('no settings entry renders the placeholder question-mark glyph', async () => {
    // 'unknown' maps to CircleHelp and resolves through SETTINGS_ICONS itself, not the
    // ?? 'settings' fallback, so a page mapped to it silently ships a question mark in the
    // sidebar. dashboard-meta did exactly that until it became permanently visible.
    const { SETTINGS_REGISTRY } = await import('../../public/manager/src/settings/settings-registry');
    const { settingsIcon } = await import('../../public/manager/src/settings/settings-icons');
    for (const entry of SETTINGS_REGISTRY) {
        assert.notEqual(settingsIcon(entry.id), 'unknown',
            `settings entry "${entry.id}" renders the placeholder question-mark icon`);
    }
});
