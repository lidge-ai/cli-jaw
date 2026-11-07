import { visit } from 'unist-util-visit';
import type { Root, Table, TableCell, Definition } from 'mdast';
import type { VFile } from 'vfile';
import { escapeMarkdownTableCell, inlineLinkMarkdown, normalizeTableModel, type TableModel } from '../../../../../src/shared/markdown-table';

type WalkNode = { type: string; value?: string; alt?: string | null; children?: WalkNode[]; identifier?: string; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } };
function plain(node: WalkNode): string {
    switch (node.type) {
        case 'text': case 'inlineCode': return node.value ?? '';
        case 'inlineMath': return `$${node.value ?? ''}$`;
        case 'math': return `$$${node.value ?? ''}$$`;
        case 'html': return /^<br\s*\/?>$/i.test(node.value ?? '') ? '\n' : '';
        case 'break': return '\n';
        case 'image': case 'imageReference': return node.alt ?? '';
        default: return (node.children ?? []).map(plain).join('');
    }
}
function identifier(value: string): string { return value.replace(/\s+/g, ' ').trim().toLowerCase(); }
function labelEnd(raw: string, start: number): number {
    let slashes = 0;
    for (let i = start; i < raw.length; i += 1) {
        const char = raw[i];
        if (char === ']' && slashes % 2 === 0) return i;
        slashes = char === '\\' ? slashes + 1 : 0;
    }
    return raw.length;
}
function cellModel(cell: TableCell, source: string, definitions: Map<string, Definition>) {
    const text = plain(cell as WalkNode);
    const start = cell.position?.start.offset; const end = cell.position?.end.offset;
    if (start == null || end == null || /[\r\n]/.test(source.slice(start, end))) return { text, markdown: escapeMarkdownTableCell(text) };
    let markdown = source.slice(start, end);
    const replacements: { start: number; end: number; value: string }[] = [];
    const walk = (node: WalkNode): void => {
        if (node.type === 'linkReference' || node.type === 'imageReference') {
            const definition = definitions.get(identifier(node.identifier ?? ''));
            const a = node.position?.start.offset; const b = node.position?.end.offset;
            if (definition && a != null && b != null && a >= start && b <= end) {
                const raw = source.slice(a, b); const labelStart = node.type === 'imageReference' ? 2 : 1;
                const children = node.children ?? [];
                const childEnd = children.at(-1)?.position?.end.offset;
                const label = childEnd != null ? source.slice(a + labelStart, childEnd) : raw.slice(labelStart, labelEnd(raw, labelStart));
                replacements.push({ start: a - start, end: b - start, value: (node.type === 'imageReference' ? '!' : '') + inlineLinkMarkdown(label, definition.url, definition.title) });
                return;
            }
        }
        node.children?.forEach(walk);
    };
    walk(cell as WalkNode);
    replacements.sort((a, b) => b.start - a.start).forEach(r => { markdown = markdown.slice(0, r.start) + r.value + markdown.slice(r.end); });
    markdown = markdown.trim().replace(/^\|/, '');
    if (/\|$/.test(markdown)) {
        const preceding = markdown.slice(0, -1).match(/\\*$/)?.[0].length ?? 0;
        if (preceding % 2 === 0) markdown = markdown.slice(0, -1);
    }
    markdown = markdown.trim();
    return { text, markdown };
}
export function remarkCollectTableModels(map: Map<number, TableModel>) {
    return (tree: Root, file: VFile): void => {
        map.clear();
        const definitions = new Map<string, Definition>();
        visit(tree, 'definition', node => { const key = identifier(node.identifier); if (!definitions.has(key)) definitions.set(key, node); });
        const source = String(file.value);
        visit(tree, 'table', (node: Table) => {
            const offset = node.position?.start.offset; if (offset == null || !node.children.length) return;
            const rows = node.children.map(row => row.children.map(cell => cellModel(cell, source, definitions)));
            map.set(offset, normalizeTableModel({ align: node.align ?? [], header: rows[0] ?? [], rows: rows.slice(1) }));
        });
    };
}
