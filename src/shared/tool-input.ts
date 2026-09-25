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
    query: ['pattern', 'query'],
    url: ['url'],
};
export const TOOL_DESCRIPTION_KEYS = ['description'] as const;

export interface ToolInputView {
    /** The parsed object when `input` was a JSON object, else null. */
    object: Record<string, unknown> | null;
    /** The decoded argument to display, real newlines preserved. */
    value: string | null;
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
    if (!object) return { object: null, value: null, field: null, description: null };
    const description = firstToolField(object, TOOL_DESCRIPTION_KEYS);
    for (const field of ['command', 'path', 'query', 'url'] as const) {
        const value = firstToolField(object, TOOL_INPUT_KEYS[field]);
        if (value !== null) return { object, value, field, description };
    }
    return { object, value: null, field: null, description };
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
