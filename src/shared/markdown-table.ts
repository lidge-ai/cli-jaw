/**
 * Markdown table conversion and CSV export. CSV uses CRLF records, RFC 4180
 * quoting, no BOM or trailing record separator; callers may prepend CSV_BOM.
 * Spreadsheet formula prefixes are guarded, with strict numeric literals exempt.
 */
export type TableAlign = 'left' | 'center' | 'right' | null;
export interface TableCellModel { text: string; markdown: string }
export interface TableModel { align: TableAlign[]; header: TableCellModel[]; rows: TableCellModel[][] }

export const CSV_BOM = '\uFEFF';
export const TABLE_CSV_FILENAME = 'table.csv';

export function normalizeTableModel(m: TableModel): TableModel {
    const width = m['header'].length;
    return {
        align: Array.from({ length: width }, (_, i) => m['align'][i] ?? null),
        header: m['header'].slice(),
        rows: m['rows'].map(row => Array.from({ length: width }, (_, i) => row[i] ?? { text: '', markdown: '' })),
    };
}

export function escapeMarkdownTableCell(source: string): string {
    return source.replace(/\r\n|\r|\n/g, '<br>').replace(/(\\*)\|/g, (_, slashes: string) =>
        slashes + (slashes.length % 2 === 0 ? '\\|' : '|'));
}

export function tableToMarkdown(m: TableModel): string {
    const model = normalizeTableModel(m);
    const row = (cells: TableCellModel[]) => `| ${cells.map(cell => escapeMarkdownTableCell(cell.markdown)).join(' | ')} |`;
    const separators: Record<Exclude<TableAlign, null>, string> = { left: ':---', center: ':---:', right: '---:' };
    return [row(model.header), `| ${model.align.map(align => align === null ? '---' : separators[align]).join(' | ')} |`, ...model.rows.map(row)].join('\n');
}

const STRICT_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$|^[+-]?\.\d+%?$/;
export function guardSpreadsheetFormula(value: string): string {
    if (/^[\t\r]/.test(value)) return "'" + value;
    if (/^[=+\-@]/.test(value.trimStart()) && !STRICT_NUMBER.test(value.trim())) return "'" + value;
    return value;
}

export function tableToCsv(m: TableModel): string {
    const model = normalizeTableModel(m);
    const field = (cell: TableCellModel): string => {
        const value = guardSpreadsheetFormula(cell.text);
        return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
            ? `"${value.replace(/"/g, '""')}"` : value;
    };
    return [model.header, ...model.rows].map(row => row.map(field).join(',')).join('\r\n');
}

export function isTableModel(v: unknown): v is TableModel {
    if (typeof v !== 'object' || v === null) return false;
    const m = v as Record<string, unknown>;
    const cell = (value: unknown): boolean => {
        if (typeof value !== 'object' || value === null) return false;
        const entry = value as Record<string, unknown>;
        return typeof entry['text'] === 'string' && typeof entry['markdown'] === 'string';
    };
    return Array.isArray(m['align']) && m['align'].every(a => a === null || a === 'left' || a === 'center' || a === 'right')
        && Array.isArray(m['header']) && m['header'].every(cell)
        && Array.isArray(m['rows']) && m['rows'].every(row => Array.isArray(row) && row.every(cell));
}

export function inlineLinkMarkdown(label: string, url: string, title?: string | null): string {
    const destination = !url || /[\s()<>]/.test(url) ? `<${url.replace(/[\\<>]/g, '\\$&')}>` : url;
    return `[${label}](${destination}${title == null ? '' : ` "${title.replace(/[\\"]/g, '\\$&')}"`})`;
}

/** FNV-1a over UTF-16 code units; an in-page identity, not a portable checksum. */
export function tableFingerprint(m: TableModel): string {
    const source = tableToMarkdown(m);
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
