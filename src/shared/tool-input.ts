/**
 * Decoded view of a tool call's `input` string.
 *
 * Tool rows and summaries must never print the raw JSON envelope: they pull the
 * one argument a reader recognises (the command, path, URL or query) plus the
 * optional human description the call carried. The decoded command keeps its
 * real newlines; only the row label flattens them.
 */

export type ToolInputField = 'command' | 'path' | 'query' | 'url';

export const TOOL_INPUT_KEYS: Record<ToolInputField, readonly string[]> = {
    command: ['command', 'cmd'],
    path: ['file_path', 'path', 'file'],
    url: ['url'],
    query: ['pattern', 'query'],
};
export const TOOL_DESCRIPTION_KEYS = ['description'] as const;

/**
 * One canonical precedence shared by every surface summarising a tool call. The
 * declaration order is the precedence (a URL outranks a query, the file family
 * outranks both), so entries must not be reordered casually.
 */
export const TOOL_INPUT_KEY_ORDER = Object.values(TOOL_INPUT_KEYS).flat();

const KEY_FAMILY: Record<string, ToolInputField> = {};
for (const [field, keys] of Object.entries(TOOL_INPUT_KEYS) as [ToolInputField, readonly string[]][])
    for (const key of keys) KEY_FAMILY[key] = field;

export interface ToolInputView {
    /** The parsed object when `input` was a JSON object, else null. */
    object: Record<string, unknown> | null;
    /** The decoded argument to display, real newlines preserved. */
    value: string | null;
    /** The concrete input key that produced `value` (e.g. `file_path`). */
    key: string | null;
    /** Which argument family produced `value`. */
    field: ToolInputField | null;
    /** The call's own description when the runtime sent one. */
    description: string | null;
}

export function parseToolArguments(input: string | undefined | null): Record<string, unknown> | null {
    const raw = input?.trim();
    if (!raw || !raw.startsWith('{')) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : null;
    } catch { return null; }
}

/** First non-empty string across `keys`, in order. */
export function firstToolField(object: Record<string, unknown>, keys: readonly string[]): string | null {
    for (const key of keys) {
        const value = object[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

export function parseToolInput(input: string | undefined | null): ToolInputView {
    const object = parseToolArguments(input);
    if (object) {
        const description = firstToolField(object, TOOL_DESCRIPTION_KEYS);
        for (const key of TOOL_INPUT_KEY_ORDER) {
            const value = firstToolField(object, [key]);
            if (value !== null) return { object, value, key, field: KEY_FAMILY[key]!, description };
        }
        return { object, value: null, key: null, field: null, description };
    }
    // Retention can cut a JSON input mid-string: JSON.parse fails but the
    // recognised field is still recoverable, so the row never falls back to
    // printing the raw {"command": envelope.
    const raw = input?.trim() ?? '';
    if (raw.startsWith('{')) {
        const found = looseToolValue(raw, TOOL_INPUT_KEY_ORDER);
        const description = looseToolValue(raw, TOOL_DESCRIPTION_KEYS)?.value ?? null;
        if (found) return { object: null, value: found.value, key: found.key, field: KEY_FAMILY[found.key]!, description };
        if (description) return { object: null, value: null, key: null, field: null, description };
    }
    return { object: null, value: null, key: null, field: null, description: null };
}

/** Decodes a JSON string fragment that may end mid-escape (retention cut). */
function decodeJsonFragment(raw: string): string {
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]!;
        if (ch !== '\\') { out += ch; continue; }
        const next = raw[i + 1];
        if (next === undefined) break;
        if (simple[next] !== undefined) { out += simple[next]!; i++; continue; }
        if (next === 'u') {
            const hex = raw.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
            out += String.fromCharCode(Number.parseInt(hex, 16)); i += 5; continue;
        }
        out += next; i++;
    }
    return out;
}

/** Pulls the first priority `"key": "value"` out of truncated/partial JSON. */
function looseToolValue(input: string, keys: readonly string[]): { key: string; value: string } | null {
    for (const key of keys) {
        const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(input);
        if (!match) continue;
        let raw = '';
        for (let i = match.index + match[0].length; i < input.length; i++) {
            const ch = input[i]!;
            if (ch === '\\' && i + 1 < input.length) { raw += ch + input[++i]!; continue; }
            if (ch === '"') break;
            raw += ch;
        }
        const value = decodeJsonFragment(raw).trim();
        if (value) return { key, value };
    }
    return null;
}

/** First non-empty line, whitespace-collapsed for a one-line label. */
export function firstInputLine(value: string): string {
    const line = value.split(/\r?\n/).find(row => row.trim()) ?? '';
    return line.replace(/\s+/g, ' ').trim();
}

/** Pretty-printed 2-space JSON when the input parsed, else the raw text. */
export function prettyToolInput(input: string): string {
    const object = parseToolArguments(input);
    return object ? JSON.stringify(object, null, 2) : input;
}
