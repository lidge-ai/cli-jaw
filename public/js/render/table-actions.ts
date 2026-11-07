import type { Token, Tokens } from 'marked';
import { CSV_BOM, TABLE_CSV_FILENAME, escapeMarkdownTableCell, inlineLinkMarkdown, isTableModel, normalizeTableModel, tableFingerprint, tableToCsv, tableToMarkdown, type TableModel } from '../../../src/shared/markdown-table.js';
import { copyText } from '../features/copy-text.js';
import { t } from '../features/i18n.js';
import { escapeHtml } from './html.js';
import type { MathBlock } from './math.js';

let entityDecoder: HTMLTextAreaElement | undefined;
function decodeEntities(value: string): string {
    entityDecoder ??= document.createElement('textarea');
    return value.replace(/[^\x00]+/g, part => {
        entityDecoder!.innerHTML = part;
        return entityDecoder!.value;
    });
}
function restoreMath(value: string, blocks: MathBlock[]): string {
    return value.replace(/\x00MATH-(\d+)\x00/g, (raw, index: string) => {
        const block = blocks[Number(index)];
        if (!block) return raw;
        const marker = block.displayMode ? '$$' : '$';
        return marker + block.tex + marker;
    });
}
function serializeTokens(tokens: Token[]): string {
    return tokens.map(token => {
        if ((token.type === 'link' || token.type === 'image') && /^!?\[/.test(token.raw)) {
            let label = token.type === 'link' ? serializeTokens(token.tokens ?? []) : token.text;
            if (token.type === 'image') {
                let slashes = 0;
                for (let i = 2; i < token.raw.length; i += 1) {
                    const char = token.raw[i];
                    if (char === ']' && slashes % 2 === 0) { label = token.raw.slice(2, i); break; }
                    slashes = char === '\\' ? slashes + 1 : 0;
                }
            }
            return (token.type === 'image' ? '!' : '') + inlineLinkMarkdown(label, token.href, token.title);
        }
        if ((token.type === 'strong' || token.type === 'em' || token.type === 'del') && token.tokens) {
            const original = token.tokens.map(child => child.raw).join('');
            const index = token.raw.indexOf(original);
            if (index >= 0) return token.raw.slice(0, index) + serializeTokens(token.tokens) + token.raw.slice(index + original.length);
        }
        return token.raw;
    }).join('');
}
function textTokens(tokens: Token[]): string {
    return tokens.map((token, index) => {
        if (token.type === 'text') {
            let value = token.tokens ? textTokens(token.tokens) : decodeEntities(token.text);
            if (tokens[index + 1]?.type === 'strong' || tokens[index + 1]?.type === 'em') value = value.replace(/\u200b$/, '');
            return value;
        }
        if (token.type === 'image') return decodeEntities(token.text);
        if (token.type === 'escape' || token.type === 'codespan') return token.text;
        if (token.type === 'strong' || token.type === 'em' || token.type === 'del' || token.type === 'link') {
            const value = textTokens(token.tokens ?? []);
            return (token.type === 'strong' || token.type === 'em') && /\u200b\*+$/u.test(token.raw) ? value.replace(/\u200b$/, '') : value;
        }
        if (token.type === 'br') return '\n';
        if (token.type === 'html') return /^<br\s*\/?>$/i.test(token.raw) ? '\n' : '';
        return token.raw;
    }).join('');
}
export function classicTableModel(token: Tokens.Table, blocks: MathBlock[]): TableModel {
    const cell = (entry: Tokens.TableCell) => ({
        text: restoreMath(textTokens(entry.tokens), blocks),
        markdown: escapeMarkdownTableCell(restoreMath(serializeTokens(entry.tokens).replace(/\u200b(?=\*\*)/g, ''), blocks)),
    });
    return normalizeTableModel({ align: token.align, header: token.header.map(cell), rows: token.rows.map(row => row.map(cell)) });
}
// DOMPurify's SAFE_FOR_XML drops an attribute whose value contains `-->`, `]>` or
// `</style`/`</title`; a table cell like "A --> B" would silently lose its model.
// JSON \u escapes keep the payload identical while removing every `<`, `>` and `&`.
export function encodeClassicTableModel(model: TableModel): string {
    return escapeHtml(JSON.stringify(model).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}
export function decodeClassicTableModel(value: string | undefined): TableModel | null {
    try { const model: unknown = JSON.parse(value ?? ''); return isTableModel(model) ? model : null; } catch { return null; }
}
export function renderTableActionsBlock(html: string, model: TableModel): string {
    const label = (key: string) => escapeHtml(t(key));
    return `<div class="table-block" data-table-model="${encodeClassicTableModel(model)}" data-table-key="${tableFingerprint(model)}"><div class="table-actions" role="toolbar" aria-label="${label('table.actions')}" data-i18n-aria="table.actions"><button type="button" class="table-action-btn" data-table-action="copy-markdown" data-i18n="table.copyMarkdown">${label('table.copyMarkdown')}</button><button type="button" class="table-action-btn" data-table-action="download-csv" data-i18n="table.downloadCsv" title="${label('table.csvFormulaHint')}" data-i18n-title="table.csvFormulaHint">${label('table.downloadCsv')}</button><button type="button" class="table-action-btn" data-table-action="preview" data-i18n="table.preview" aria-haspopup="dialog">${label('table.preview')}</button></div>${html}</div>`;
}

export function preserveTableActionFocus(root: HTMLElement, rerender: () => void): void {
    const active = document.activeElement;
    const button = active instanceof HTMLElement && root.contains(active) ? active.closest<HTMLElement>('.table-action-btn[data-table-action]') : null;
    const block = button?.closest<HTMLElement>('.table-block');
    const oldBlocks = Array.from(root.querySelectorAll<HTMLElement>('.table-block'));
    const ordinal = block ? oldBlocks.indexOf(block) : -1;
    const key = block?.dataset['tableKey']; const action = button?.dataset['tableAction'];
    rerender();
    if (ordinal < 0 || !action) return;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.table-block'));
    const matches = blocks.filter(candidate => key && candidate.dataset['tableKey'] === key);
    const target = matches.find(candidate => blocks.indexOf(candidate) >= ordinal) ?? matches[0] ?? blocks[Math.min(ordinal, blocks.length - 1)];
    const replacement = Array.from(target?.querySelectorAll<HTMLElement>('.table-action-btn[data-table-action]') ?? []).find(candidate => candidate.dataset['tableAction'] === action);
    if (replacement) { replacement.focus(); return; }
    const msg = root.closest<HTMLElement>('.msg');
    if (msg?.isConnected) { if (!msg.hasAttribute('tabindex')) msg.tabIndex = -1; msg.focus(); }
}

let closePreview: (() => void) | undefined;
function openTablePreview(block: HTMLElement, trigger: HTMLElement): void {
    closePreview?.();
    const table = block.querySelector('table');
    if (!table) return;
    const msg = block.closest<HTMLElement>('.msg');
    const ordinal = msg ? Array.from(msg.querySelectorAll('.table-block')).indexOf(block) : -1;
    const backdrop = document.createElement('div'); backdrop.className = 'table-preview-backdrop';
    const dialog = document.createElement('div'); dialog.className = 'table-preview-dialog';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'table-preview-title');
    const heading = document.createElement('h2'); heading.id = 'table-preview-title'; heading.textContent = t('table.previewTitle'); heading.dataset['i18n'] = 'table.previewTitle';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'table-preview-close'; close.textContent = '×'; close.setAttribute('aria-label', t('table.close')); close.dataset['i18nAria'] = 'table.close';
    const scroll = document.createElement('div'); scroll.className = 'table-preview-scroll table-wrapper'; scroll.tabIndex = 0; scroll.append(table.cloneNode(true));
    dialog.append(heading, close, scroll); backdrop.append(dialog); document.body.append(backdrop);
    const dismiss = () => {
        backdrop.remove(); if (closePreview === dismiss) closePreview = undefined;
        if (trigger.isConnected) trigger.focus();
        else if (msg?.isConnected && ordinal >= 0) msg.querySelectorAll<HTMLElement>('.table-block')[ordinal]?.querySelector<HTMLElement>('[data-table-action="preview"]')?.focus();
    };
    closePreview = dismiss; close.addEventListener('click', dismiss);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) dismiss(); });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
        if (event.key !== 'Tab') return;
        const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0);
        if (!focusables.length) { event.preventDefault(); return; }
        const current = focusables.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && current <= 0) { event.preventDefault(); focusables[focusables.length - 1]!.focus(); }
        else if (!event.shiftKey && (current < 0 || current === focusables.length - 1)) { event.preventDefault(); focusables[0]!.focus(); }
    });
    close.focus();
}
function flash(button: HTMLElement, key: string): void {
    button.textContent = t(key);
    setTimeout(() => { const original = button.dataset['i18n']; if (original) button.textContent = t(original); }, 1500);
}
let delegationReady = false;
export function ensureTableActionDelegation(): void {
    if (delegationReady) return;
    delegationReady = true;
    document.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.table-action-btn[data-table-action]') : null;
        const block = button?.closest<HTMLElement>('.table-block');
        if (!button || !block) return;
        const model = decodeClassicTableModel(block.dataset['tableModel']);
        if (!model) { flash(button, 'table.actionFailed'); return; }
        switch (button.dataset['tableAction']) {
            case 'copy-markdown': void copyText(tableToMarkdown(model)).then(result => flash(button, result.ok ? 'table.copied' : 'table.actionFailed')); break;
            case 'download-csv': {
                const url = URL.createObjectURL(new Blob([CSV_BOM + tableToCsv(model)], { type: 'text/csv;charset=utf-8' }));
                const anchor = document.createElement('a'); anchor.href = url; anchor.download = TABLE_CSV_FILENAME; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); break;
            }
            case 'preview': openTablePreview(block, button); break;
        }
    });
}
