import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { copyText } from '../../clipboard/copy-text';
import { CSV_BOM, TABLE_CSV_FILENAME, tableToCsv, tableToMarkdown, type TableModel } from '../../../../../src/shared/markdown-table';

type Locale = 'ko' | 'en' | 'zh' | 'ja';
const COPY: Record<Locale, { actions: string; copy: string; copied: string; failed: string; download: string; hint: string; preview: string; title: string; close: string }> = {
    en: { actions: 'Table actions', copy: 'Copy Markdown', copied: 'Copied', failed: 'Copy failed', download: 'Download CSV', hint: 'Cells starting with =, +, - or @ get a leading \' so spreadsheets do not run them as formulas; plain numbers stay numbers.', preview: 'Preview', title: 'Table preview', close: 'Close' },
    ko: { actions: '표 작업', copy: '마크다운 복사', copied: '복사됨', failed: '복사 실패', download: 'CSV 다운로드', hint: '=, +, -, @로 시작하는 셀은 스프레드시트가 수식으로 실행하지 않도록 앞에 \'를 붙입니다. 일반 숫자는 그대로 둡니다.', preview: '미리보기', title: '표 미리보기', close: '닫기' },
    ja: { actions: '表の操作', copy: 'Markdownをコピー', copied: 'コピーしました', failed: 'コピー失敗', download: 'CSVをダウンロード', hint: '=、+、-、@ で始まるセルには、表計算ソフトが数式として実行しないよう先頭に \' を付けます。通常の数値はそのままです。', preview: 'プレビュー', title: '表のプレビュー', close: '閉じる' },
    zh: { actions: '表格操作', copy: '复制 Markdown', copied: '已复制', failed: '复制失败', download: '下载 CSV', hint: '以 =、+、-、@ 开头的单元格会在前面加上 \'，防止电子表格将其作为公式执行；普通数字保持不变。', preview: '预览', title: '表格预览', close: '关闭' },
};
function locale(): Locale {
    if (typeof document === 'undefined') return 'ko';
    const lang = document.documentElement.lang.toLowerCase();
    return lang.startsWith('en') ? 'en' : lang.startsWith('zh') ? 'zh' : lang.startsWith('ja') ? 'ja' : 'ko';
}
function subscribe(callback: () => void): () => void {
    if (typeof document === 'undefined') return () => {};
    const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!Observer) return () => {};
    const observer = new Observer(callback); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
}
function useDocumentLocale(): Locale { return useSyncExternalStore(subscribe, locale, () => 'ko'); }
export const MarkdownTableActionsContext = createContext<{ ready: boolean; models: Map<number, TableModel> }>({ ready: false, models: new Map() });
let preview: { root: Root; host: HTMLElement; trigger: HTMLElement; fallback: HTMLElement | null } | null = null;
function closePreview(): void {
    const current = preview; if (!current) return; preview = null;
    current.root.unmount(); current.host.remove();
    if (current.trigger.isConnected) current.trigger.focus(); else if (current.fallback?.isConnected) current.fallback.focus();
}
function TablePreviewDialog({ model, copy }: { model: TableModel; copy: typeof COPY[Locale] }) {
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => { close.current?.focus(); }, []);
    const row = (cells: TableModel['header'], tag: 'th' | 'td') => cells.map((cell, i) => {
        const Tag = tag;
        return <Tag key={i}>{cell.text.split('\n').map((part, index) => <span key={index}>{index > 0 && <br />}{part}</span>)}</Tag>;
    });
    return <div className="markdown-table-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) closePreview(); }}>
        <div className="markdown-table-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-table-preview-title" onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); closePreview(); return; }
            if (event.key !== 'Tab') return;
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
            if (!items.length) { event.preventDefault(); return; }
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1]?.focus(); }
            else if (!event.shiftKey && (index === items.length - 1 || index < 0)) { event.preventDefault(); items[0]?.focus(); }
        }}>
            <header><h2 id="markdown-table-preview-title">{copy.title}</h2><button ref={close} type="button" aria-label={copy.close} onClick={closePreview}>{copy.close}</button></header>
            <div className="markdown-table-preview-scroll" tabIndex={0}><table><thead><tr>{row(model.header, 'th')}</tr></thead><tbody>{model.rows.map((cells, i) => <tr key={i}>{row(cells, 'td')}</tr>)}</tbody></table></div>
        </div>
    </div>;
}
function openManagerTablePreview(model: TableModel, trigger: HTMLElement, copy: typeof COPY[Locale]): void {
    closePreview();
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    preview = { root, host, trigger, fallback: trigger.closest<HTMLElement>('.code-transcript') };
    root.render(<TablePreviewDialog model={model} copy={copy} />);
}
export function MarkdownTableFrame({ offset, children }: { offset?: number | undefined; children: ReactNode }) {
    const { ready, models } = useContext(MarkdownTableActionsContext); const copy = COPY[useDocumentLocale()];
    const [status, setStatus] = useState<'copied' | 'failed' | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const model = offset == null ? undefined : models.get(offset);
    return <div className="markdown-table-block">
        {ready && model && <div className="markdown-table-actions" role="toolbar" aria-label={copy.actions}>
            <button type="button" className="markdown-table-action" data-table-action="copy-markdown" onClick={async () => {
                const result = await copyText(tableToMarkdown(model)); setStatus(result.ok ? 'copied' : 'failed');
                if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setStatus(null), 1200);
            }}>{status ? copy[status] : copy.copy}</button>
            <button type="button" className="markdown-table-action" data-table-action="download-csv" title={copy.hint} onClick={() => {
                const url = URL.createObjectURL(new Blob([CSV_BOM, tableToCsv(model)], { type: 'text/csv;charset=utf-8' }));
                const anchor = document.createElement('a'); anchor.href = url; anchor.download = TABLE_CSV_FILENAME; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
            }}>{copy.download}</button>
            <button type="button" className="markdown-table-action" data-table-action="preview" aria-haspopup="dialog" onClick={event => openManagerTablePreview(model, event.currentTarget, copy)}>{copy.preview}</button>
        </div>}
        {children}
    </div>;
}
