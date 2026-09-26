import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import type { ComponentProps, ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import type { DashboardInstance } from '../../public/manager/src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://sidebar.test/' });
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    // Imported Manager TSX uses classic JSX under the root test runner.
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { InstanceRow } = await import('../../public/manager/src/components/InstanceRow');
const { InstanceNavigator } = await import('../../public/manager/src/components/InstanceNavigator');
const { InstanceGroups } = await import('../../public/manager/src/components/InstanceGroups');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function instance(port: number, overrides: Partial<DashboardInstance> = {}): DashboardInstance {
    return {
        port, label: `Workspace ${port}`, url: `https://instance.test/${port}`, status: 'online', ok: true,
        version: '2.0.0', uptime: 60, instanceId: `instance-${port}`, homeDisplay: '/fixture/home',
        workingDir: '/fixture/project', projectDirs: ['/fixture/project'], currentCli: 'codex', currentModel: 'fixture-model',
        serviceMode: 'ad-hoc', lastCheckedAt: '2026-09-08T00:00:00Z', healthReason: null,
        lifecycle: {
            owner: 'manager', canStart: false, canStop: true, canRestart: true, canPerm: true, canUnperm: false,
            reason: 'ok', defaultHome: '/fixture/home', commandPreview: [], pid: 123,
        },
        ...overrides,
    };
}

async function mount(t: TestContext, element: ReactNode) {
    const container = dom.window.document.createElement('div');
    container.className = 'manager-sidebar';
    dom.window.document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
        await act(async () => root.unmount());
        container.remove();
        dom.window.localStorage.clear();
    });
    const render = async (next: ReactNode) => { await act(async () => root.render(next)); };
    await render(element);
    const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
        const node = container.querySelector<T>(selector);
        assert.ok(node, `Missing mounted control: ${selector}`);
        return node;
    };
    return { container, render, get };
}

function controlledTarget(root: HTMLElement, control: HTMLElement): HTMLElement {
    const id = control.getAttribute('aria-controls');
    assert.ok(id, 'disclosure must name its target');
    const target = root.ownerDocument.getElementById(id);
    assert.ok(target && root.contains(target), 'disclosure target must belong to this mounted tree');
    return target;
}

async function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}) {
    target.focus();
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
    await act(async () => { target.dispatchEvent(event); });
    return event;
}

function rowProps(t: TestContext, value = instance(3457)): ComponentProps<typeof InstanceRow> {
    return {
        instance: value, selected: true, busy: false, label: value.label!, uptime: '1m', priority: 'active',
        activityUnreadCount: 2, sessionCount: 2, sessionsOpen: false,
        onSelect: t.mock.fn(), onPreview: t.mock.fn(), onMarkActivitySeen: t.mock.fn(),
        onInstanceLabelSave: t.mock.fn(async () => {}), onLifecycle: t.mock.fn(), onToggleSessions: t.mock.fn(),
    };
}

function navigator(children: ReactNode, onSelectPort: (port: number) => void) {
    return createElement(InstanceNavigator, {
        active: instance(3457), hiddenCount: 0, collapsed: false, query: '', onQueryChange: () => {}, onSelectPort, children,
    });
}

test('mounted row uses sibling selection/actions and phrasing-only selection content', async t => {
    const props = rowProps(t);
    const view = await mount(t, navigator(createElement(InstanceRow, props), () => {}));
    const select = view.get<HTMLButtonElement>('.instance-row-select');
    const quick = view.get('.instance-row-quick');
    assert.equal(select.parentElement, quick.parentElement);
    assert.equal(select.parentElement?.className, 'instance-row-body');
    assert.equal(select.querySelector('button, a, input, [role="button"], [tabindex]'), null);
    assert.ok([...select.querySelectorAll('*')].every(node => ['SPAN', 'STRONG', 'EM'].includes(node.tagName)));
    assert.equal(view.container.querySelectorAll('[data-instance-port]').length, 1);
    for (const name of ['main', 'title', 'title-line', 'status-line', 'meta']) {
        assert.equal(view.get(`.instance-row-${name}`).tagName, 'SPAN');
    }
    assert.equal(view.get('.instance-row-title-line strong').textContent, 'Workspace 3457');
    assert.equal(view.get('.instance-row-status-pill').textContent, 'Online');
    assert.equal(view.get('.instance-unread-badge').getAttribute('aria-label'), '2 unread activity');
    assert.match(view.get('article').title, /\/fixture\/home/);
    assert.equal(view.get('.instance-navigator-header strong').textContent, 'Instances');
    assert.doesNotMatch(view.get('.instance-navigator-header').textContent ?? '', /0 hidden|:3457/);
});

test('row Enter selects once; action Enter stays native and invokes only that action on click', async t => {
    const selected = t.mock.fn<(value: DashboardInstance) => void>();
    const lifecycle = t.mock.fn();
    const disclosure = t.mock.fn();
    const seen = t.mock.fn();
    const props = { ...rowProps(t), onSelect: selected, onLifecycle: lifecycle, onToggleSessions: disclosure, onMarkActivitySeen: seen };
    const view = await mount(t, navigator(createElement(InstanceRow, props), port => {
        assert.equal(port, props.instance.port);
        selected(props.instance);
    }));
    const select = view.get<HTMLButtonElement>('.instance-row-select');
    const enter = await key(select, 'Enter');
    assert.equal(enter.defaultPrevented, true);
    // JSDOM does not synthesize native keyboard clicks. Model the browser default
    // only if unhandled, so a selection key cannot also trigger the click path.
    if (!enter.defaultPrevented) await act(async () => select.click());
    assert.deepEqual(selected.mock.calls.map(call => call.arguments), [[props.instance]]);
    selected.mock.resetCalls();
    for (const selector of ['.action-stop', '.action-sessions', '.action-open']) {
        const action = view.get(selector);
        assert.equal((await key(action, 'Enter')).defaultPrevented, false);
        await act(async () => {
            // Block navigation; React still receives the action click.
            const preventNavigation = (event: Event) => event.preventDefault();
            action.addEventListener('click', preventNavigation, { once: true });
            action.click();
            action.removeEventListener('click', preventNavigation);
        });
        assert.equal(selected.mock.callCount(), 0);
    }
    assert.deepEqual(lifecycle.mock.calls.map(call => call.arguments), [['stop', props.instance]]);
    assert.deepEqual(disclosure.mock.calls.map(call => call.arguments), [[3457]]);
    assert.deepEqual(seen.mock.calls.map(call => call.arguments), [[3457]]);
    const open = view.get<HTMLAnchorElement>('.action-open');
    assert.equal(open.href, props.instance.url);
    assert.equal(open.target, '_blank');
    assert.equal(open.rel, 'noreferrer');
    await act(async () => select.click());
    assert.deepEqual(selected.mock.calls.map(call => call.arguments), [[props.instance]]);
});

test('row navigation moves focus only, while rename and action controls retain Home/End/arrows', async t => {
    const select = t.mock.fn();
    const lifecycle = t.mock.fn();
    const props = { ...rowProps(t), onSelect: select, onLifecycle: lifecycle };
    const view = await mount(t, navigator([
        createElement(InstanceRow, { ...props, key: 3457 }),
        createElement(InstanceRow, { ...rowProps(t, instance(3458)), key: 3458, onSelect: select, onLifecycle: lifecycle }),
    ], select));
    const first = view.get('[data-instance-port="3457"]');
    const second = view.get('[data-instance-port="3458"]');
    for (const [from, name, to] of [[first, 'ArrowDown', second], [second, 'ArrowUp', first], [first, 'End', second], [second, 'Home', first]] as const) {
        assert.equal((await key(from, name)).defaultPrevented, true);
        assert.equal(dom.window.document.activeElement, to);
    }
    await key(first, 'F10', { shiftKey: true });
    const renameItem = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.jaw-context-menu [role="menuitem"]')]
        .find(el => el.textContent === 'Rename');
    assert.ok(renameItem, 'context menu must expose Rename');
    await act(async () => renameItem.click());
    const input = view.get<HTMLInputElement>('.instance-label-input');
    for (const name of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
        assert.equal((await key(input, name)).defaultPrevented, false);
        assert.equal(dom.window.document.activeElement, input);
        assert.equal(input.value, 'Workspace 3457');
    }
    for (const selector of ['.action-stop', '.action-sessions', '.action-open', '.instance-label-save']) {
        const control = view.get(selector);
        for (const name of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
            assert.equal((await key(control, name)).defaultPrevented, false);
            assert.equal(dom.window.document.activeElement, control);
        }
    }
    assert.equal((await key(first, 'Enter', { isComposing: true })).defaultPrevented, false);
    assert.equal((await key(first, 'End', { keyCode: 229 })).defaultPrevented, false);
    assert.equal(select.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
});

test('offline and busy row actions keep their disabled contracts without selecting', async t => {
    const selected = t.mock.fn();
    const lifecycle = t.mock.fn();
    const seen = t.mock.fn();
    const props = { ...rowProps(t, instance(3457, { ok: false, status: 'offline' })), busy: true, onSelect: selected, onLifecycle: lifecycle, onMarkActivitySeen: seen };
    const view = await mount(t, navigator(createElement(InstanceRow, props), selected));
    const stop = view.get<HTMLButtonElement>('.action-stop');
    const open = view.get<HTMLAnchorElement>('.action-open');
    assert.equal(stop.disabled, true);
    assert.equal(view.container.querySelector('.action-sessions'), null);
    assert.equal(open.getAttribute('href'), null);
    assert.equal(open.getAttribute('target'), null);
    assert.equal(open.getAttribute('rel'), null);
    assert.equal(open.getAttribute('aria-disabled'), 'true');
    assert.equal(open.tabIndex, -1);
    assert.equal(open.matches(':disabled'), false, 'disabled links need the explicit class guard');
    assert.equal(open.classList.contains('is-disabled'), true);
    assert.equal(open.matches('.quick-btn:not(:disabled):not(.is-disabled)'), false);
    assert.equal(stop.matches('.quick-btn:not(:disabled):not(.is-disabled)'), false);
    const blockedClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { open.dispatchEvent(blockedClick); });
    assert.equal(blockedClick.defaultPrevented, true);
    await act(async () => { stop.click(); open.click(); });
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
    assert.equal(seen.mock.callCount(), 0);
});

test('row context menu groups edit, preview, lifecycle and copy actions', async t => {
    const lifecycle = t.mock.fn();
    const favorite = t.mock.fn();
    const preview = t.mock.fn();
    const props = { ...rowProps(t), onLifecycle: lifecycle, onToggleFavorite: favorite, onPreview: preview };
    const view = await mount(t, navigator(createElement(InstanceRow, props), () => {}));
    const row = view.get('article.instance-row');
    assert.equal(view.container.querySelector('.instance-actions'), null, 'the actions strip is removed');
    assert.equal(view.container.querySelector('.instance-label-edit-button'), null, 'the standalone rename button is removed');

    const openMenu = async () => {
        await act(async () => {
            row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 140 }));
        });
        const menu = dom.window.document.querySelector<HTMLElement>('.jaw-context-menu');
        assert.ok(menu, 'right-click must open the row context menu');
        return menu;
    };
    const item = (menu: HTMLElement, label: string) => {
        const node = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            .find(el => el.textContent?.trim() === label);
        assert.ok(node, `context menu must include ${label}`);
        return node;
    };

    const menu = await openMenu();
    assert.deepEqual(
        [...menu.querySelectorAll('[role="menuitem"]')].map(el => el.textContent?.trim()),
        ['Rename', 'Pin', 'Preview', 'Open in new tab', 'Start', 'Restart', 'Register as persistent service', 'Stop', 'Copy URL', 'Copy port'],
    );
    assert.equal(menu.querySelectorAll('[role="separator"]').length, 3, 'menu groups stay separated');
    assert.equal(item(menu, 'Start').disabled, true, 'canStart=false keeps Start disabled');
    assert.equal(item(menu, 'Stop').disabled, false, 'canStop=true keeps Stop enabled');
    assert.equal(item(menu, 'Stop').classList.contains('is-danger'), true, 'Stop is the destructive entry');
    assert.equal(dom.window.document.activeElement, item(menu, 'Rename'), 'menu focuses its first item');

    await act(async () => item(menu, 'Stop').click());
    assert.deepEqual(lifecycle.mock.calls.map(call => call.arguments), [['stop', props.instance]]);
    assert.equal(dom.window.document.querySelector('.jaw-context-menu'), null, 'selecting an item closes the menu');

    const keyboardMenu = await key(view.get('[data-instance-port="3457"]'), 'ContextMenu');
    assert.equal(keyboardMenu.defaultPrevented, true);
    const reopened = dom.window.document.querySelector<HTMLElement>('.jaw-context-menu');
    assert.ok(reopened, 'ContextMenu key must reopen the row menu');
    await act(async () => item(reopened, 'Pin').click());
    assert.deepEqual(favorite.mock.calls.map(call => call.arguments), [[props.instance]]);

    const third = await openMenu();
    await act(async () => item(third, 'Preview').click());
    assert.deepEqual(preview.mock.calls.map(call => call.arguments), [[props.instance]]);
});

test('row context menu drops the entries hidden by display props', async t => {
    const props = { ...rowProps(t), showSelectedActions: false, showInlineLabelEditor: false };
    const view = await mount(t, navigator(createElement(InstanceRow, props), () => {}));
    const row = view.get('article.instance-row');
    await act(async () => {
        row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    const menu = dom.window.document.querySelector<HTMLElement>('.jaw-context-menu');
    assert.ok(menu);
    assert.deepEqual(
        [...menu.querySelectorAll('[role="menuitem"]')].map(el => el.textContent?.trim()),
        ['Open in new tab', 'Stop', 'Copy URL', 'Copy port'],
        'rename and selected-row actions stay out of the menu when their props hide them',
    );
});

test('Selected summary retains group identity, session linkage while closed, and lifecycle grouping/paging', async t => {
    const values = [instance(3457), instance(3458), ...Array.from({ length: 12 }, (_, i) => instance(3500 + i, { ok: false, status: 'offline' }))];
    const selected = t.mock.fn();
    const lifecycle = t.mock.fn();
    const disclosure = t.mock.fn();
    function GroupsFixture({ port }: { port: number }) {
        const [open, setOpen] = useState(false);
        return createElement(InstanceGroups, {
            instances: values, selectedPort: port, lifecycleBusyPort: null,
            getLabel: value => value.label!, formatUptime: () => '1m',
            onSelect: selected, onLifecycle: lifecycle, onPreview: () => {}, onMarkActivitySeen: () => {},
            onInstanceLabelSave: async () => {}, activeSessionCount: 2, activeSessionsOpen: open,
            onToggleActiveSessions: target => { disclosure(target); setOpen(value => !value); },
            renderActiveSessionList: target => open ? createElement('div', { className: 'instance-session-list' }, `Sessions for ${target}`) : null,
        });
    }
    const view = await mount(t, navigator(createElement(GroupsFixture, { port: 3457 }), selected));
    const summary = view.get('[aria-label="Selected instances"]');
    assert.ok(summary.querySelector(':scope > div[id]'), 'Selected retains its group body');
    assert.equal(summary.querySelectorAll('[data-instance-port="3457"]').length, 1);
    assert.equal(view.container.querySelectorAll('[data-instance-port="3457"]').length, 2);
    const disclosureButton = view.get<HTMLButtonElement>('[aria-label="Selected instances"] .action-sessions');
    const wrapper = controlledTarget(summary, disclosureButton);
    const originalSessionId = wrapper.id;
    assert.equal(wrapper.childElementCount, 0);
    assert.equal(disclosureButton.getAttribute('aria-expanded'), 'false');
    await act(async () => disclosureButton.click());
    assert.equal(disclosureButton.getAttribute('aria-expanded'), 'true');
    assert.equal(wrapper.textContent, 'Sessions for 3457');
    await act(async () => disclosureButton.click());
    assert.equal(controlledTarget(summary, disclosureButton), wrapper);
    assert.equal(wrapper.childElementCount, 0);
    await view.render(navigator(createElement(GroupsFixture, { port: 3458 }), selected));
    const next = view.get<HTMLButtonElement>('[aria-label="Selected instances"] .action-sessions');
    const nextWrapper = controlledTarget(summary, next);
    assert.notEqual(nextWrapper.id, originalSessionId);
    assert.equal(dom.window.document.getElementById(originalSessionId), null);
    await act(async () => next.click());
    assert.equal(nextWrapper.textContent, 'Sessions for 3458');
    assert.deepEqual(disclosure.mock.calls.map(call => call.arguments), [[3457], [3457], [3458]]);
    await act(async () => view.get('[aria-label="Running instances"] .instance-group-toggle').click());
    const running = controlledTarget(view.container, view.get('[aria-label="Running instances"] .instance-group-toggle'));
    const settled = controlledTarget(view.container, view.get('[aria-label="Settled instances"] .instance-group-toggle'));
    assert.equal(running.querySelectorAll('[data-instance-port]').length, 1);
    assert.ok(running.querySelector('[data-instance-port="3458"]'));
    assert.equal(settled.querySelectorAll('[data-instance-port]').length, 10);
    await act(async () => view.get('.instance-settled-more').click());
    assert.equal(settled.querySelectorAll('[data-instance-port]').length, 12);
    assert.equal(view.container.querySelector('.instance-settled-more'), null);
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
});

test('sidebar and drawer group mounts have unique local targets through disclosure, collapse and port changes', async t => {
    const values = [instance(3457), instance(3458), instance(3459, { status: 'offline', ok: false }), instance(3460, { group: 'Work projects / 개발' })];
    const selected = t.mock.fn();
    const lifecycle = t.mock.fn();
    const disclosures = t.mock.fn();
    function GroupsFixture({ port }: { port: number }) {
        const [open, setOpen] = useState(false);
        return createElement(InstanceGroups, {
            instances: values, selectedPort: port, lifecycleBusyPort: null,
            getLabel: value => value.label!, formatUptime: () => '1m',
            onSelect: selected, onLifecycle: lifecycle, onPreview: () => {}, onMarkActivitySeen: () => {},
            onInstanceLabelSave: async () => {}, activeSessionCount: 2, activeSessionsOpen: open,
            onToggleActiveSessions: target => { disclosures(target); setOpen(value => !value); },
            renderActiveSessionList: target => open ? createElement('div', { className: 'instance-session-list' }, `Sessions for ${target}`) : null,
        });
    }
    const trees = (sidebarPort: number, drawerPort: number) => createElement('div', null,
        createElement('div', { 'data-surface': 'sidebar' }, createElement(GroupsFixture, { port: sidebarPort })),
        createElement('div', { 'data-surface': 'drawer' }, createElement(GroupsFixture, { port: drawerPort })),
    );
    const view = await mount(t, trees(3457, 3457));
    const sidebar = view.get('[data-surface="sidebar"]');
    const drawer = view.get('[data-surface="drawer"]');
    const control = (surface: HTMLElement, selector: string) => {
        const button = surface.querySelector<HTMLButtonElement>(selector);
        assert.ok(button);
        return button;
    };
    const assertLocalTargets = () => {
        const ids = [...view.container.querySelectorAll<HTMLElement>('[id]')].map(node => node.id);
        assert.ok(ids.length > 0);
        assert.equal(new Set(ids).size, ids.length, 'all group-body and session IDs must be unique across mounts');
        for (const id of ids) assert.doesNotMatch(id, /\s/, 'DOM IDs must be single ARIA tokens, even for labels with spaces');
        for (const surface of [sidebar, drawer]) {
            const controls = surface.querySelectorAll<HTMLElement>('[aria-controls]');
            assert.equal(controls.length, 4, 'Sessions, custom group, Running and Settled each keep a local target');
            for (const button of controls) {
                const target = controlledTarget(surface, button);
                assert.ok(button.closest('.instance-group')?.contains(target));
            }
        }
    };
    assertLocalTargets();
    const customGroup = control(sidebar, '[aria-label="Work projects / 개발 instances"] .instance-group-toggle');
    const customBody = controlledTarget(sidebar, customGroup);
    const customId = customBody.id;
    assert.ok(customBody.querySelector('[data-instance-port="3460"]'));
    await act(async () => customGroup.click());
    assert.equal(customBody.hidden, true);
    assert.equal(controlledTarget(sidebar, customGroup), customBody);
    assert.equal(customBody.id, customId);
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem('jaw.sidebarGroupCollapsed')!), { 'group-Work projects / 개발': true });
    assert.equal(control(drawer, '[aria-label="Work projects / 개발 instances"] .instance-group-toggle').getAttribute('aria-expanded'), 'true');
    assertLocalTargets();
    const sidebarSessions = control(sidebar, '.action-sessions');
    const drawerSessions = control(drawer, '.action-sessions');
    const sidebarWrapper = controlledTarget(sidebar, sidebarSessions);
    const drawerWrapper = controlledTarget(drawer, drawerSessions);
    const sidebarId = sidebarWrapper.id;
    const drawerId = drawerWrapper.id;
    assert.notEqual(sidebarId, drawerId);
    assert.equal(sidebarWrapper.childElementCount, 0);
    assert.equal(drawerWrapper.childElementCount, 0);
    await act(async () => sidebarSessions.click());
    assert.equal(sidebarWrapper.textContent, 'Sessions for 3457');
    assert.equal(drawerSessions.getAttribute('aria-expanded'), 'false');
    assert.equal(drawerWrapper.childElementCount, 0);
    await act(async () => sidebarSessions.click());
    assert.equal(controlledTarget(sidebar, sidebarSessions), sidebarWrapper);
    assert.equal(sidebarWrapper.id, sidebarId);
    assert.equal(sidebarWrapper.childElementCount, 0);
    const sidebarRunning = control(sidebar, '[aria-label="Running instances"] .instance-group-toggle');
    const runningBody = controlledTarget(sidebar, sidebarRunning);
    const runningId = runningBody.id;
    await act(async () => sidebarRunning.click());
    assert.equal(sidebarRunning.getAttribute('aria-expanded'), 'false');
    assert.equal(runningBody.querySelectorAll('[data-instance-port]').length, 1);
    assert.equal(control(drawer, '[aria-label="Running instances"] .instance-group-toggle').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem('jaw.sidebarGroupCollapsed')!), { 'group-Work projects / 개발': true, running: true });
    assertLocalTargets();
    await view.render(trees(3458, 3457));
    assertLocalTargets();
    const changedSessions = control(sidebar, '.action-sessions');
    const changedWrapper = controlledTarget(sidebar, changedSessions);
    assert.notEqual(changedWrapper.id, sidebarId);
    assert.equal(dom.window.document.getElementById(sidebarId), null);
    assert.equal(changedWrapper.childElementCount, 0);
    assert.equal(controlledTarget(drawer, drawerSessions), drawerWrapper);
    assert.equal(drawerWrapper.id, drawerId);
    assert.equal(controlledTarget(sidebar, sidebarRunning).id, runningId);
    assert.ok(runningBody.querySelector('[data-instance-port="3458"]'));
    await act(async () => changedSessions.click());
    assert.equal(changedWrapper.textContent, 'Sessions for 3458');
    await view.render(trees(3458, 3458));
    assertLocalTargets();
    const changedDrawerWrapper = controlledTarget(drawer, control(drawer, '.action-sessions'));
    assert.notEqual(changedDrawerWrapper.id, drawerId);
    assert.notEqual(changedDrawerWrapper.id, changedWrapper.id);
    assert.equal(dom.window.document.getElementById(drawerId), null);
    assert.equal(changedDrawerWrapper.childElementCount, 0);
    assert.equal(changedWrapper.textContent, 'Sessions for 3458');
    assert.deepEqual(disclosures.mock.calls.map(call => call.arguments), [[3457], [3457], [3458]]);
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
});

test('groups order rows by ascending port even when custom labels are set', async t => {
    const values = [
        instance(3470, { label: null }),
        instance(3457, { label: '내 작업방' }),
        instance(3462, { label: 'zulu' }),
        instance(3468, { label: null }),
        instance(3459, { label: 'aaa', favorite: true }),
    ];
    const selected = t.mock.fn();
    const view = await mount(t, navigator(createElement(InstanceGroups, {
        instances: values, selectedPort: null, lifecycleBusyPort: null,
        getLabel: value => value.label || String(value.port), formatUptime: () => '1m',
        onSelect: selected, onLifecycle: () => {}, onPreview: () => {}, onMarkActivitySeen: () => {},
        onInstanceLabelSave: async () => {},
    }), selected));
    const portsIn = (label: string) => Array.from(
        controlledTarget(view.container, view.get(`[aria-label="${label} instances"] .instance-group-toggle`))
            .querySelectorAll<HTMLElement>('[data-instance-port]'),
    ).map(el => Number(el.dataset['instancePort']));
    assert.deepEqual(portsIn('Running'), [3457, 3462, 3468, 3470], 'a custom label must not move a row out of port order');
    assert.deepEqual(portsIn('Pinned'), [3459], 'favorites keep their own section');
    assert.equal(selected.mock.callCount(), 0);
});

