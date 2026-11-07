import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { TABLE_FIXTURE_MARKDOWN, REFERENCE_FIXTURE_MARKDOWN, EXPECTED_TABLE1_MODEL, EXPECTED_TABLE2_MODEL, EXPECTED_REFERENCE_MODEL, EXPECTED_TABLE1_MARKDOWN, EXPECTED_TABLE2_MARKDOWN, EXPECTED_REFERENCE_MARKDOWN, EXPECTED_TABLE1_CSV } from '../fixtures/markdown-table-fixture';
import { CSV_BOM, tableToCsv, tableToMarkdown, type TableModel } from '../../src/shared/markdown-table';

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MarkdownRenderer } = await import('../../public/manager/src/notes/rendering/MarkdownRenderer');
const { CodeTranscriptItem } = await import('../../public/manager/src/code/CodeTranscript');
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key]; } });
async function surface(t: TestContext) {
    document.documentElement.lang = 'en';
    const container = document.createElement('div'); container.className = 'code-transcript'; container.tabIndex = 0; document.body.append(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, render: async (node: ReactNode) => act(async () => root.render(node)), unmount: async () => act(async () => root.render(null)) };
}
const view = (markdown = TABLE_FIXTURE_MARKDOWN, tableActions?: boolean) => createElement(MarkdownRenderer, { markdown, tableMode: 'linear', tableActions });
const buttons = (el: ParentNode, action: string) => [...el.querySelectorAll<HTMLButtonElement>(`[data-table-action="${action}"]`)];
async function click(el: HTMLElement) { await act(async () => el.click()); }
async function key(el: Element, value: string, shiftKey = false) { await act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })); }); }
async function models(markdown: string) {
    const { remarkCollectTableModels } = await import('../../public/manager/src/notes/rendering/markdown-table-model');
    const map = new Map<number, TableModel>();
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCollectTableModels, map);
    await processor.run(processor.parse(markdown), { value: markdown } as never);
    return [...map.values()];
}

test('T3a/b/k: toolbars and exact models and copy for both tables', async t => {
    const h = await surface(t); const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => writes.push(s) } });
    await h.render(view(TABLE_FIXTURE_MARKDOWN, true));
    assert.equal(h.container.querySelectorAll('[role=toolbar]').length, 2); assert.equal(h.container.querySelectorAll('.markdown-table-action').length, 6);
    assert.deepEqual(await models(TABLE_FIXTURE_MARKDOWN), [EXPECTED_TABLE1_MODEL, EXPECTED_TABLE2_MODEL]);
    await click(buttons(h.container, 'copy-markdown')[1]!); await click(buttons(h.container, 'copy-markdown')[0]!);
    assert.deepEqual(writes, [EXPECTED_TABLE2_MARKDOWN, EXPECTED_TABLE1_MARKDOWN]);
});
test('T3c: download exports BOM, exact CSV, and filename', async t => {
    const h = await surface(t); let blob: Blob | undefined; let filename = '';
    t.mock.method(URL, 'createObjectURL', (value: Blob) => { blob = value; return 'blob:test'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { filename = this.download; });
    await h.render(view(TABLE_FIXTURE_MARKDOWN, true)); await click(buttons(h.container, 'download-csv')[0]!);
    assert.equal(filename, 'table.csv'); assert.ok(blob); assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()), CSV_BOM + EXPECTED_TABLE1_CSV);
});
test('T3d/e: ready toggle preserves nodes; legacy GFM, breaks and math render', async t => {
    const h = await surface(t); await h.render(view(TABLE_FIXTURE_MARKDOWN, false));
    const table = h.container.querySelector('.markdown-linear-table'); assert.ok(table); assert.equal(h.container.querySelector('[role=toolbar]'), null);
    await h.render(view(TABLE_FIXTURE_MARKDOWN, true)); assert.equal(h.container.querySelector('.markdown-linear-table'), table); assert.equal(h.container.querySelectorAll('[role=toolbar]').length, 2);
    await h.render(view(TABLE_FIXTURE_MARKDOWN, true)); assert.equal(h.container.querySelectorAll('[role=toolbar]').length, 2);
    await h.render(view('first\nsecond\n\n$x^2$\n\n' + TABLE_FIXTURE_MARKDOWN));
    assert.ok(h.container.querySelector('.markdown-linear-table')); assert.ok(h.container.querySelector('p br')); assert.ok(h.container.querySelector('.katex')); assert.equal(h.container.querySelector('.markdown-table-block'), null);
});
test('T3f: preview focus trap, escape, backdrop and detached trigger fallback', async t => {
    const h = await surface(t); await h.render(view(TABLE_FIXTURE_MARKDOWN, true));
    let trigger = buttons(h.container, 'preview')[0]!; trigger.focus(); await click(trigger);
    let dialog = document.querySelector<HTMLElement>('[role=dialog]')!; assert.ok(dialog.querySelector('table')); const close = dialog.querySelector<HTMLButtonElement>('button')!; assert.equal(document.activeElement, close);
    await key(close, 'Tab', true); assert.equal(document.activeElement, dialog.querySelector('[tabindex="0"]'));
    await key(document.activeElement!, 'Tab'); assert.equal(document.activeElement, close);
    await key(dialog, 'Escape'); assert.equal(document.querySelector('[role=dialog]'), null); assert.equal(document.activeElement, trigger);
    await click(trigger); await click(document.querySelector<HTMLElement>('.markdown-table-preview-backdrop')!); assert.equal(document.querySelector('[role=dialog]'), null);
    trigger = buttons(h.container, 'preview')[0]!; await click(trigger); await h.unmount(); dialog = document.querySelector<HTMLElement>('[role=dialog]')!; assert.ok(dialog); await click(dialog.querySelector('button')!); assert.equal(document.activeElement, h.container);
});
test('T3g: transcript shows actions only for finished statuses', async t => {
    const h = await surface(t);
    for (const status of ['running', 'pending', 'done', 'error'] as const) {
        const item = { itemId: 'a', turnId: 't', kind: 'assistant_message', status, text: TABLE_FIXTURE_MARKDOWN, createdAt: 1, updatedAt: 1, firstSequence: 1 } as const;
        await h.render(createElement(CodeTranscriptItem, { item, provider: 'claude', sessionKey: 's' }));
        assert.equal(h.container.querySelectorAll('[role=toolbar]').length, status === 'running' || status === 'pending' ? 0 : 2);
    }
});
test('T3h/i: nested tables, math and missing/multiline position fallback', async () => {
    const block = '| H | V |\n| --- | --- |\n| *bold* | $x^2$ |';
    for (const input of [block.split('\n').map(s => '> ' + s).join('\n'), '- item\n\n' + block.split('\n').map(s => '  ' + s).join('\n')]) {
        const [model] = await models(input); assert.ok(model); assert.equal(model.rows[0]![0]!.markdown, '*bold*'); assert.equal(model.rows[0]![1]!.text, '$x^2$'); assert.match(tableToMarkdown(model), /\$x\^2\$/); assert.match(tableToCsv(model), /\$x\^2\$/);
    }
    const { remarkCollectTableModels } = await import('../../public/manager/src/notes/rendering/markdown-table-model');
    const map = new Map<number, TableModel>(); const transform = remarkCollectTableModels.call(undefined, map);
    const cell = { type: 'tableCell', children: [{ type: 'text', value: 'a|b' }] };
    const tree = { type: 'root', children: [{ type: 'table', position: { start: { offset: 0 } }, align: [null], children: [{ type: 'tableRow', children: [cell] }] }] };
    transform(tree as never, { value: 'a\nb' } as never); assert.equal([...map.values()][0]!.header[0]!.markdown, 'a\\|b');
    Object.assign(cell, { position: { start: { offset: 0 }, end: { offset: 3 } } });
    transform(tree as never, { value: 'a\nb' } as never); assert.equal([...map.values()][0]!.header[0]!.markdown, 'a\\|b');
});
test('T3j: document locale changes update labels', async t => {
    const h = await surface(t); await h.render(view(TABLE_FIXTURE_MARKDOWN, true)); const before = buttons(h.container, 'copy-markdown')[0]!.textContent;
    await act(async () => { document.documentElement.lang = 'ko'; }); assert.notEqual(buttons(h.container, 'copy-markdown')[0]!.textContent, before);
});
test('T3l: reference variants use outermost source offsets', async t => {
    const [model] = await models(REFERENCE_FIXTURE_MARKDOWN); assert.deepEqual(model, EXPECTED_REFERENCE_MODEL); assert.equal(tableToMarkdown(model!), EXPECTED_REFERENCE_MARKDOWN);
    const h = await surface(t); let copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { copied = s; } } });
    await h.render(view(REFERENCE_FIXTURE_MARKDOWN, true)); await click(buttons(h.container, 'copy-markdown')[0]!); assert.equal(copied, EXPECTED_REFERENCE_MARKDOWN);
});
test('T3m: static locale works without either MutationObserver', async t => {
    const h = await surface(t); const observer = dom.window.MutationObserver; const globalObserver = globals.MutationObserver;
    Object.defineProperty(dom.window, 'MutationObserver', { configurable: true, value: undefined }); globals.MutationObserver = undefined;
    try { document.documentElement.lang = 'ja'; await h.render(view(TABLE_FIXTURE_MARKDOWN, true)); assert.ok(buttons(h.container, 'copy-markdown')[0]!.textContent); await h.unmount(); }
    finally { Object.defineProperty(dom.window, 'MutationObserver', { configurable: true, value: observer }); globals.MutationObserver = globalObserver; }
});
