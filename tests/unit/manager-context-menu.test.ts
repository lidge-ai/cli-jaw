import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost:43226' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ContextMenu, useContextMenu } = await import('../../public/manager/src/components/context-menu/ContextMenu');
type Entry = import('../../public/manager/src/components/context-menu/ContextMenu').ContextMenuEntry;
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});

async function mount(entries: (setInput: (v: boolean) => void) => Entry[], at = { x: 40, y: 50 }) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    let openMenu: () => void = () => {};
    function Host() {
        const contextMenu = useContextMenu();
        const [input, setInput] = useState(false);
        openMenu = () => contextMenu.openAtElement(document.getElementById('opener') as HTMLElement);
        return createElement('div', null,
            createElement('button', { id: 'opener', type: 'button' }, 'row'),
            input ? createElement('input', { id: 'rename', autoFocus: true }) : null,
            createElement(ContextMenu, { state: contextMenu.state && { ...contextMenu.state, ...at }, entries: entries(setInput),
                label: 'Row actions', onClose: contextMenu.close }));
    }
    await act(async () => root.render(createElement(Host)));
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    await act(async () => openMenu());
    return { container, opener, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const menu = () => document.querySelector<HTMLElement>('.jaw-context-menu');
const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.jaw-context-menu [role="menuitem"]'));
const nextFrame = () => act(async () => { await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve())); });

test('renders into document.body with icons, shortcuts, separators and focuses the first enabled item', async () => {
    const { container, cleanup } = await mount(() => [
        { id: 'a', label: 'Rename', shortcut: 'R', disabled: true, onSelect: () => {} },
        { id: 'b', label: 'Pin', onSelect: () => {} },
        { kind: 'separator', id: 's' },
        { id: 'c', label: 'Delete', danger: true, onSelect: () => {} },
    ]);
    try {
        assert.ok(menu());
        assert.equal(menu()!.parentElement, document.body, 'menu is portalled out of the row container');
        assert.equal(container.querySelector('.jaw-context-menu'), null);
        assert.equal(menu()!.getAttribute('aria-label'), 'Row actions');
        assert.deepEqual(items().map(item => item.textContent), ['RenameR', 'Pin', 'Delete']);
        assert.equal(document.querySelectorAll('.jaw-context-menu [role="separator"]').length, 1);
        assert.ok(items()[2]!.classList.contains('is-danger'));
        assert.equal(document.activeElement, items()[1]);
        assert.equal(menu()!.style.left, '40px');
        assert.equal(menu()!.style.top, '50px');
    } finally { await cleanup(); }
});

test('arrow keys wrap over enabled items; Escape closes and restores focus to the opener', async () => {
    const { opener, cleanup } = await mount(() => [
        { id: 'a', label: 'One', onSelect: () => {} },
        { id: 'b', label: 'Two', disabled: true, onSelect: () => {} },
        { id: 'c', label: 'Three', onSelect: () => {} },
    ]);
    try {
        const key = async (k: string, target: Element) => act(async () => {
            target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
        });
        await key('ArrowDown', document.activeElement!);
        assert.equal(document.activeElement, items()[2]);
        await key('ArrowDown', document.activeElement!);
        assert.equal(document.activeElement, items()[0]);
        await key('End', document.activeElement!);
        assert.equal(document.activeElement, items()[2]);
        await key('Escape', document.activeElement!);
        assert.equal(menu(), null);
        assert.equal(document.activeElement, opener);
    } finally { await cleanup(); }
});

test('outside pointerdown dismisses; choosing an item runs it and leaves focus to the action', async () => {
    let picked = 0;
    const { cleanup } = await mount(setInput => [
        { id: 'rename', label: 'Rename', onSelect: () => { picked += 1; setInput(true); } },
    ]);
    try {
        await act(async () => { items()[0]!.click(); });
        await nextFrame();
        assert.equal(picked, 1);
        assert.equal(menu(), null);
        assert.equal(document.activeElement, document.getElementById('rename'), 'focus stays on the input the action opened');
    } finally { await cleanup(); }
    const second = await mount(() => [{ id: 'x', label: 'X', onSelect: () => { picked += 1; } }]);
    try {
        await act(async () => { document.body.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true })); });
        assert.equal(menu(), null);
        assert.equal(picked, 1);
        assert.equal(document.activeElement, second.opener);
    } finally { await second.cleanup(); }
});

test('selection restores the captured opener when the action does not move focus', async () => {
    let picked = 0;
    const { opener, cleanup } = await mount(() => [{ id: 'copy', label: 'Copy', onSelect: () => { picked += 1; } }]);
    try {
        await act(async () => { items()[0]!.click(); });
        await nextFrame();
        assert.equal(picked, 1);
        assert.equal(menu(), null);
        assert.equal(document.activeElement, opener);
    } finally { await cleanup(); }
});

test('unmounting before the selection frame does not refocus an opener left in the document', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const pending = new Map<number, FrameRequestCallback>();
    const originalRequest = dom.window.requestAnimationFrame;
    const originalCancel = dom.window.cancelAnimationFrame;
    let nextId = 1;
    dom.window.requestAnimationFrame = callback => { const id = nextId++; pending.set(id, callback); return id; };
    dom.window.cancelAnimationFrame = id => { pending.delete(id); };
    let unmountMenu: () => void = () => {};
    function Host() {
        const [mounted, setMounted] = useState(true);
        const contextMenu = useContextMenu();
        unmountMenu = () => setMounted(false);
        return createElement('div', null,
            createElement('button', { id: 'staying-opener', onContextMenu: contextMenu.openAt }, 'Row'),
            mounted ? createElement(ContextMenu, { state: contextMenu.state,
                entries: [{ id: 'copy', label: 'Copy', onSelect: () => {} }], label: 'Row actions', onClose: contextMenu.close }) : null);
    }
    try {
        await act(async () => root.render(createElement(Host)));
        const opener = document.getElementById('staying-opener') as HTMLButtonElement;
        await act(async () => {
            opener.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
        });
        await act(async () => { items()[0]!.click(); });
        assert.equal(pending.size, 1);
        await act(async () => unmountMenu());
        assert.equal(opener.isConnected, true);
        assert.ok(document.activeElement === document.body, 'focus is on the body before the pending frame');
        assert.equal(pending.size, 0, 'unmount cancels the scheduled frame');
        for (const callback of pending.values()) callback(0);
        assert.ok(document.activeElement === document.body, 'the unmounted menu must not refocus its opener');
    } finally {
        dom.window.requestAnimationFrame = originalRequest;
        dom.window.cancelAnimationFrame = originalCancel;
        await act(async () => root.unmount()); container.remove();
    }
});

test('scrolling a tall menu keeps it open while page scrolling dismisses it', async () => {
    const { opener, cleanup } = await mount(() => [{ id: 'copy', label: 'Copy', onSelect: () => {} }]);
    try {
        await act(async () => { menu()!.dispatchEvent(new dom.window.Event('scroll')); });
        assert.ok(menu());
        await act(async () => { document.dispatchEvent(new dom.window.Event('scroll')); });
        assert.equal(menu(), null);
        assert.equal(document.activeElement, opener);
    } finally { await cleanup(); }
});

test('right-click captures the row control even when an unrelated input has focus', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    function Host() {
        const contextMenu = useContextMenu();
        return createElement('div', null,
            createElement('input', { id: 'unrelated' }),
            createElement('div', { id: 'row', onContextMenu: contextMenu.openAt },
                createElement('button', { id: 'row-control', type: 'button' }, 'Row')),
            createElement(ContextMenu, { state: contextMenu.state, entries: [{ id: 'copy', label: 'Copy', onSelect: () => {} }],
                label: 'Row actions', onClose: contextMenu.close }));
    }
    try {
        await act(async () => root.render(createElement(Host)));
        (document.getElementById('unrelated') as HTMLInputElement).focus();
        await act(async () => {
            document.getElementById('row')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',
                { bubbles: true, clientX: 40, clientY: 50 }));
        });
        assert.equal(document.activeElement, items()[0]);
        await act(async () => {
            items()[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        assert.equal(menu(), null);
        assert.equal(document.activeElement, document.getElementById('row-control'));
    } finally { await act(async () => root.unmount()); container.remove(); }
});

for (const [key, shiftKey, destination] of [
    ['Tab', false, 'after-one'], ['Shift+Tab', true, 'before-one'],
] as const) {
    test(`${key} closes and focuses the opener's immediate tabbable neighbour`, async () => {
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        function Host() {
            const contextMenu = useContextMenu();
            return createElement('div', null,
                createElement('button', { id: 'before-two' }, 'Before two'),
                createElement('button', { id: 'before-one' }, 'Before one'),
                createElement('button', { hidden: true }, 'Hidden before'),
                createElement('button', { disabled: true }, 'Disabled before'),
                createElement('button', { tabIndex: -1 }, 'Untabbable before'),
                createElement('button', { id: 'tab-opener', onContextMenu: contextMenu.openAt }, 'Opener'),
                createElement('button', { hidden: true }, 'Hidden after'),
                createElement('button', { disabled: true }, 'Disabled after'),
                createElement('button', { tabIndex: -1 }, 'Untabbable after'),
                createElement('button', { id: 'after-one' }, 'After one'),
                createElement('button', { id: 'after-two' }, 'After two'),
                createElement(ContextMenu, { state: contextMenu.state,
                    entries: [{ id: 'copy', label: 'Copy', onSelect: () => {} }], label: 'Row actions', onClose: contextMenu.close }));
        }
        try {
            await act(async () => root.render(createElement(Host)));
            const opener = document.getElementById('tab-opener') as HTMLButtonElement;
            const neighbour = document.getElementById(destination)!;
            let focusCount = 0;
            neighbour.addEventListener('focus', () => { focusCount += 1; });
            opener.focus();
            await act(async () => {
                opener.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
            });
            const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
            await act(async () => { items()[0]!.dispatchEvent(event); });
            assert.equal(event.defaultPrevented, true);
            assert.equal(menu(), null);
            assert.equal(document.activeElement, neighbour);
            assert.equal(focusCount, 1);
        } finally { await act(async () => root.unmount()); container.remove(); }
    });
}

test('clamps to the viewport near the right and bottom edges', async () => {
    const { cleanup } = await mount(() => [{ id: 'x', label: 'X', onSelect: () => {} }], { x: 5000, y: 5000 });
    try {
        const left = Number.parseFloat(menu()!.style.left);
        const top = Number.parseFloat(menu()!.style.top);
        assert.ok(left <= dom.window.innerWidth - 8, `left ${left}`);
        assert.ok(top <= dom.window.innerHeight - 8, `top ${top}`);
    } finally { await cleanup(); }
});

test('inline state and onClose props neither loop nor re-steal focus on parent re-render', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const entries: Entry[] = [{ id: 'a', label: 'A', onSelect: () => {} }, { id: 'b', label: 'B', onSelect: () => {} }];
    const render = (tick: number) => root.render(createElement('div', { 'data-tick': tick },
        createElement(ContextMenu, { state: { x: 10, y: 10 }, entries, label: 'Inline', onClose: () => {} })));
    try {
        await act(async () => render(0));
        await act(async () => {
            document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        assert.equal(document.activeElement, items()[1]);
        await act(async () => render(1));
        assert.equal(document.activeElement, items()[1], 'focus is not reset to the first item');
    } finally { await act(async () => root.unmount()); container.remove(); }
});
