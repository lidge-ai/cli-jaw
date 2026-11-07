import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_FIXTURE_MARKDOWN, EXPECTED_EDGE_MODEL } from '../fixtures/markdown-table-fixture.ts';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { CSV_BOM, tableToMarkdown, tableToCsv } from '../../src/shared/markdown-table.ts';
import { TABLE_FIXTURE_MARKDOWN as fixture, REFERENCE_FIXTURE_MARKDOWN as references, EXPECTED_TABLE1_MODEL, EXPECTED_TABLE2_MODEL, EXPECTED_REFERENCE_MODEL, EXPECTED_TABLE1_MARKDOWN, EXPECTED_TABLE2_MARKDOWN, EXPECTED_TABLE1_CSV, EXPECTED_REFERENCE_MARKDOWN } from '../fixtures/markdown-table-fixture.ts';

setupWebUiDom();
test.after(() => resetWebUiDom());
const { renderMarkdown } = await import('../../public/js/render.ts');
const { replaceAgentAnswer } = await import('../../public/js/ui.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let copies: string[] = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copies.push(value); } } });
function message(markdown = fixture, streaming = false): HTMLElement {
    document.querySelectorAll('.msg').forEach(el => el.remove());
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.innerHTML = `<div class="msg-content">${renderMarkdown(markdown, streaming)}</div>`;
    document.body.append(msg);
    return msg;
}
function button(root: Element, index: number, action: string): HTMLButtonElement {
    return root.querySelectorAll('.table-block')[index]!.querySelector(`[data-table-action="${action}"]`)!;
}
function model(block: Element) { return JSON.parse((block as HTMLElement).dataset['tableModel']!); }

test('T2a fixture models, toolbars and sanitized attributes', () => {
    const msg = message();
    const blocks = msg.querySelectorAll('.table-block');
    assert.equal(blocks.length, 2);
    assert.equal(msg.querySelectorAll('.table-actions').length, 2);
    assert.equal(msg.querySelectorAll('.table-action-btn').length, 6);
    assert.deepEqual(model(blocks[0]!), EXPECTED_TABLE1_MODEL);
    assert.deepEqual(model(blocks[1]!), EXPECTED_TABLE2_MODEL);
    assert.equal(tableToMarkdown(model(blocks[0]!)), EXPECTED_TABLE1_MARKDOWN);
    assert.equal(tableToCsv(model(blocks[0]!)), EXPECTED_TABLE1_CSV);
});

test('T2b streaming tables remain wrapped and have no actions', () => {
    const msg = message(fixture, true);
    assert.equal(msg.querySelectorAll('.table-block').length, 0);
    assert.equal(msg.querySelectorAll('.table-wrapper table').length, 2);
});

test('T2c fenced syntax and raw HTML do not receive actions', () => {
    const msg = message('```\n| x |\n| --- |\n```\n\n<table><tr><td>raw</td></tr></table>');
    assert.equal(msg.querySelectorAll('.table-block').length, 0);
    assert.equal(msg.querySelectorAll('.table-wrapper table').length, 1);
});

test('T2d copy each table, including failed clipboard', async () => {
    const msg = message(); copies = [];
    button(msg, 1, 'copy-markdown').click(); await tick();
    button(msg, 0, 'copy-markdown').click(); await tick();
    assert.deepEqual(copies, [EXPECTED_TABLE2_MARKDOWN, EXPECTED_TABLE1_MARKDOWN]);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    const btn = button(msg, 0, 'copy-markdown'); btn.click(); await tick();
    assert.equal(btn.textContent, 'table.actionFailed');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copies.push(value); } } });
});

test('T2e CSV blob, filename and URL cleanup', async () => {
    const msg = message(); let blob: Blob | undefined; let filename = ''; let revoked = '';
    const create = URL.createObjectURL; const revoke = URL.revokeObjectURL; const click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = value => { blob = value as Blob; return 'blob:test'; };
    URL.revokeObjectURL = value => { revoked = value; };
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    try {
        button(msg, 0, 'download-csv').click(); await tick();
        assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob!.arrayBuffer()), CSV_BOM + EXPECTED_TABLE1_CSV);
        assert.equal(filename, 'table.csv'); assert.equal(revoked, 'blob:test');
    } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; HTMLAnchorElement.prototype.click = click; }
});

test('T2f preview clones table, traps focus and closes via Escape and backdrop', () => {
    const msg = message(); const trigger = button(msg, 1, 'preview'); trigger.focus(); trigger.click();
    const dialog = document.querySelector<HTMLElement>('.table-preview-dialog')!;
    const close = dialog.querySelector<HTMLButtonElement>('button')!;
    const scroll = dialog.querySelector<HTMLElement>('.table-preview-scroll')!;
    assert.ok(dialog.querySelector('table')); assert.notEqual(dialog.querySelector('table'), msg.querySelectorAll('table')[1]);
    assert.equal(document.activeElement, close);
    scroll.focus(); scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, close);
    close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, scroll);
    dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.table-preview-dialog'), null); assert.equal(document.activeElement, trigger);
    trigger.click(); (document.querySelector('.table-preview-backdrop') as HTMLElement).click();
    assert.equal(document.querySelector('.table-preview-dialog'), null); assert.equal(document.activeElement, trigger);
});

test('T2g rerenders remain idempotent and only copy once', async () => {
    const msg = message(); const content = msg.querySelector<HTMLElement>('.msg-content')!;
    for (let i = 0; i < 3; i++) content.innerHTML = renderMarkdown(fixture);
    assert.equal(content.querySelectorAll('.table-actions').length, 2); copies = [];
    button(msg, 0, 'copy-markdown').click(); await tick(); assert.deepEqual(copies, [EXPECTED_TABLE1_MARKDOWN]);
});

test('T2h preview close returns to same message ordinal after replacement', () => {
    const msg = message(); button(msg, 1, 'preview').click();
    msg.querySelector<HTMLElement>('.msg-content')!.innerHTML = renderMarkdown(fixture);
    document.querySelector<HTMLButtonElement>('.table-preview-dialog button')!.click();
    assert.equal(document.activeElement, button(msg, 1, 'preview'));
});

test('T2i math and CJK boundary retain intended content', () => {
    const msg = message('| a | b |\n| --- | --- |\n| $x^2$ | **한국.**다음 |');
    const m = model(msg.querySelector('.table-block')!);
    assert.equal(m.rows[0][0].text, '$x^2$'); assert.equal(m.rows[0][0].markdown, '$x^2$');
    assert.ok(tableToCsv(m).includes('$x^2$')); assert.ok(!JSON.stringify(m).includes('\u200b'));
});

test('T2j 2000 rows retain their full model and source copy', async () => {
    const md = '| a |\n| --- |\n' + Array.from({ length: 2000 }, (_, i) => `| [row ${i}](https://example.com/${i}) |`).join('\n');
    const msg = message(md); const block = msg.querySelector('.table-block')!;
    assert.ok(block.getAttribute('data-table-model')); assert.equal(model(block).rows.length, 2000);
    copies = []; button(msg, 0, 'copy-markdown').click(); await tick(); assert.equal(copies[0], tableToMarkdown(model(block)));
});

test('T2k corrupt model fails closed for all actions', async () => {
    const msg = message(); const block = msg.querySelector<HTMLElement>('.table-block')!;
    block.dataset['tableModel'] = '{broken'; copies = [];
    const copy = button(msg, 0, 'copy-markdown'); copy.click(); await tick();
    assert.deepEqual(copies, []); assert.equal(copy.textContent, 'table.actionFailed');
    let called = false; const create = URL.createObjectURL; URL.createObjectURL = () => { called = true; return ''; };
    try { button(msg, 0, 'download-csv').click(); button(msg, 0, 'preview').click(); assert.equal(called, false); assert.equal(document.querySelector('.table-preview-dialog'), null); }
    finally { URL.createObjectURL = create; }
});

test('T2l locale application updates all action labels and attributes', async () => {
    const en = JSON.parse(readFileSync(new URL('../../public/locales/en.json', import.meta.url), 'utf8'));
    const ko = JSON.parse(readFileSync(new URL('../../public/locales/ko.json', import.meta.url), 'utf8'));
    const previous = globalThis.fetch;
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('/ko') ? ko : en), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
        localStorage.setItem('claw_locale', 'en');
        const { initI18n, setLang } = await import('../../public/js/features/i18n.ts'); await initI18n();
        const msg = message(); assert.equal(button(msg, 0, 'copy-markdown').textContent, en['table.copyMarkdown']);
        await setLang('ko');
        assert.equal(button(msg, 0, 'copy-markdown').textContent, ko['table.copyMarkdown']);
        assert.equal(msg.querySelector('.table-actions')!.getAttribute('aria-label'), ko['table.actions']);
        assert.equal(button(msg, 0, 'download-csv').title, ko['table.csvFormulaHint']);
    } finally { globalThis.fetch = previous; }
});

test('T2m preview trap includes links in the cloned table', () => {
    const msg = message(); button(msg, 0, 'preview').click();
    const dialog = document.querySelector<HTMLElement>('.table-preview-dialog')!;
    const link = dialog.querySelector<HTMLAnchorElement>('a[href]')!; const close = dialog.querySelector<HTMLButtonElement>('button')!;
    assert.ok(link); link.focus(); link.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, close);
    close.click();
});

test('T2n reference variants and nested emphasis match shared fixture', () => {
    const msg = message(references); const m = model(msg.querySelector('.table-block')!);
    assert.deepEqual(m, EXPECTED_REFERENCE_MODEL); assert.equal(tableToMarkdown(m), EXPECTED_REFERENCE_MARKDOWN);
});

test('edge image references and entity text match shared fixture', () => {
    const msg = message(EDGE_FIXTURE_MARKDOWN);
    assert.deepEqual(model(msg.querySelector('.table-block')!), EXPECTED_EDGE_MODEL);
});

test('T2o incomplete structured fence does not hide completed final table actions', () => {
    const md = '| a |\n| --- |\n| b |\n\n```dataframe\n{';
    assert.equal(message(md).querySelectorAll('.table-block').length, 1);
    assert.equal(message(md, true).querySelectorAll('.table-block').length, 0);
});

test('T2p replaceAgentAnswer restores focus by key, ordinal and message', () => {
    const first = '| first |\n| --- |\n| A |'; const second = '| second |\n| --- |\n| B |'; const inserted = '| new |\n| --- |\n| C |';
    const msg = message(first + '\n\n' + second); button(msg, 1, 'preview').focus();
    replaceAgentAnswer(msg, first + '\n\n' + second + '\n\nchanged'); assert.equal(document.activeElement, button(msg, 1, 'preview'));
    replaceAgentAnswer(msg, inserted + '\n\n' + first + '\n\n' + second); assert.equal(document.activeElement, button(msg, 2, 'preview'));
    replaceAgentAnswer(msg, first); assert.equal(document.activeElement, button(msg, 0, 'preview'));
    replaceAgentAnswer(msg, 'no tables'); assert.equal(document.activeElement, msg); assert.equal(msg.getAttribute('tabindex'), '-1');
});

test('T2q cells with arrows, angle brackets and ampersands keep their model through sanitize', async () => {
    // DOMPurify SAFE_FOR_XML strips attribute values containing "-->" or "]>"; the model must survive.
    const msg = message('| Step | Code |\n| --- | --- |\n| A --> B ]> C | \x60a<b&c\x60 |'); copies = [];
    const block = msg.querySelector<HTMLElement>('.table-block')!;
    assert.ok(block.hasAttribute('data-table-model'), 'model attribute must survive sanitizeHtml');
    assert.deepEqual(model(block).rows, [[{ text: 'A --> B ]> C', markdown: 'A --> B ]> C' }, { text: 'a<b&c', markdown: '\x60a<b&c\x60' }]]);
    button(msg, 0, 'copy-markdown').click(); await tick();
    assert.deepEqual(copies, ['| Step | Code |\n| --- | --- |\n| A --> B ]> C | \x60a<b&c\x60 |']);
});
