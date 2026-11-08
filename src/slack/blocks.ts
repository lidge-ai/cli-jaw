// Slack Block Kit preparation shared by the HTTP and direct send paths.
import { marked, type Tokens } from 'marked';
import { chunkFenceAware } from '../messaging/chunk.js';
import { redactOutboundPayload, redactOutboundText } from '../messaging/redact.js';
import { buildSlackTextPayloads } from './format.js';

export type SlackBlock = Record<string, unknown> & { type: string };
export type TableShape = { rows: number; columns: number };
export type SlackTextPayload = { text: string; blocks?: unknown };

function invalid(message: string): never {
    throw Object.assign(new RangeError(message), { statusCode: 400, code: message.split(':')[0] });
}

export function normalizeSlackBlocks(value: unknown): SlackBlock[] | undefined {
    if (value == null) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > 50
        || value.some(b => !b || typeof b !== 'object' || Array.isArray(b)
            || typeof b.type !== 'string' || !b.type)) {
        return invalid('invalid_slack_blocks: expected 1-50 block objects with a type');
    }
    return value as SlackBlock[];
}

function nativeTableShape(block: SlackBlock): TableShape {
    const rows = block['rows'];
    if (!Array.isArray(rows) || !rows.length || rows.length > 100) {
        return invalid('invalid_slack_table_rows: expected 1-100 rows');
    }
    const columns = Array.isArray(rows[0]) ? rows[0].length : 0;
    if (columns < 1 || columns > 20 || rows.some(row => !Array.isArray(row) || row.length !== columns)) {
        return invalid('invalid_slack_table_columns: expected equal rows of 1-20 cells');
    }
    let characters = 0;
    for (const row of rows) for (const cell of row) {
        if (!cell || typeof cell !== 'object') return invalid('invalid_slack_table_cell');
        if (cell.type === 'raw_text') {
            if (typeof cell.text !== 'string') return invalid('invalid_slack_table_cell_text');
            characters += cell.text.length;
        } else if (cell.type === 'raw_number') {
            if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) return invalid('invalid_slack_table_number');
            if (typeof cell.text !== 'string' || !cell.text.length) return invalid('invalid_slack_table_number_text');
            characters += cell.text.length;
        } else if (cell.type === 'rich_text') {
            if (!Array.isArray(cell.elements)) return invalid('invalid_slack_table_rich_text');
            const pending: unknown[] = [...cell.elements];
            while (pending.length) {
                const element = pending.pop();
                if (!element || typeof element !== 'object') continue;
                const item = element as Record<string, unknown>;
                if (typeof item['text'] === 'string') characters += item['text'].length;
                if (Array.isArray(item['elements'])) pending.push(...item['elements']);
            }
        } else return invalid('invalid_slack_table_cell_type');
    }
    if (characters > 10000) return invalid('slack_table_too_long: split the table without dropping cells');
    return { rows: rows.length, columns };
}

/** Count actual table constructs, ignoring fenced examples. */
export function expectedTableShapes(blocks: unknown): TableShape[] {
    const shapes: TableShape[] = [];
    for (const block of normalizeSlackBlocks(blocks) ?? []) {
        if (block.type === 'table') shapes.push(nativeTableShape(block));
        if (block.type === 'markdown' && typeof block['text'] === 'string') {
            marked.walkTokens(marked.lexer(block['text'], { gfm: true }), token => {
                if (token.type === 'table') {
                    const table = token as Tokens.Table;
                    shapes.push({ rows: table.rows.length + 1, columns: table.header.length });
                }
            });
        }
    }
    return shapes;
}

function expandMarkdown(block: SlackBlock): SlackBlock[] {
    if (typeof block['text'] !== 'string') return invalid('invalid_slack_markdown_text');
    const result: SlackBlock[] = [];
    let prose = '';
    const flush = () => {
        if (prose.trim()) {
            result.push(...chunkFenceAware(prose, 3900).map(text => ({ type: 'markdown', text })));
        }
        prose = '';
    };
    for (const token of marked.lexer(block['text'], { gfm: true })) {
        if (token.type === 'table' || (token.type === 'heading'
            && (token as Tokens.Heading).tokens.some(t => !['text', 'escape'].includes(t.type)))) {
            flush();
            for (const part of buildSlackTextPayloads(token.raw)) {
                result.push(...(normalizeSlackBlocks(part.blocks) ?? []));
            }
        } else {
            prose += token.raw;
        }
    }
    flush();
    return result;
}

/** One table per message, with blocks between tables carried to the later table;
 * leading blocks stay with the earlier table only when the markdown limit requires it.
 * Blocks after the last table stay with it.
 * Explicit rich payloads render blocks, so fallback text must not be separately
 * chunked into visible duplicate messages. Invalid input fails before posting. */
export function buildSlackBlockPayloads(text: string, input: unknown): SlackTextPayload[] {
    const blocks = normalizeSlackBlocks(redactOutboundPayload(input));
    if (!blocks) return buildSlackTextPayloads(text);
    const fallback = redactOutboundText(text);
    if (!fallback.trim() || fallback.length > 12000) return invalid('invalid_slack_fallback_text');
    // Slack requires a display string alongside raw_number.value. Older callers
    // supplied only value; derive text without changing numeric type or alignment.
    for (const block of blocks) {
        if (block.type !== 'table' || !Array.isArray(block['rows'])) continue;
        for (const row of block['rows']) {
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
                if (cell?.type === 'raw_number' && cell.text === undefined
                    && typeof cell.value === 'number' && Number.isFinite(cell.value)) cell.text = String(cell.value);
            }
        }
    }
    const expanded = blocks.flatMap(b => b.type === 'markdown' ? expandMarkdown(b) : [b]);
    if (!expanded.length) return invalid('empty_slack_blocks');
    const payloads: SlackTextPayload[] = [];
    let current: SlackBlock[] = [];
    let markdownChars = 0;
    let tableEnd = -1;
    const markdownLength = (block: SlackBlock) => block.type === 'markdown' ? String(block['text']).length : 0;
    const flush = () => {
        if (current.length) payloads.push({ text: fallback, blocks: current });
        current = [];
        markdownChars = 0;
        tableEnd = -1;
    };
    for (const block of expanded) {
        const shapes = expectedTableShapes([block]);
        if (shapes.length > 1) return invalid('slack_nested_tables_require_separate_blocks');
        const chars = markdownLength(block);
        if (shapes.length && tableEnd >= 0) {
            // A second table starts a new payload before any limit is checked, so the
            // blocks introducing it travel with it. Blocks nearest the previous table stay
            // behind only when carrying them would pass the markdown limit.
            let start = tableEnd;
            let carriedChars = current.slice(start).reduce((total, b) => total + markdownLength(b), 0);
            while (start < current.length && carriedChars + chars > 12000) carriedChars -= markdownLength(current[start++]!);
            const carried = current.splice(start);
            flush();
            current = carried;
            markdownChars = carriedChars;
        }
        if (current.length === 50 || markdownChars + chars > 12000) flush();
        current.push(block);
        markdownChars += chars;
        if (shapes.length) tableEnd = current.length;
    }
    flush();
    return payloads;
}
