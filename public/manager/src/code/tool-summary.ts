import type { CodeItem } from '../../../../src/code-mode/wire';
import { firstToolField, parseToolArguments, TOOL_INPUT_KEY_ORDER } from '../../../../src/shared/tool-input.js';

/**
 * One line that says what a tool call did, in the user's terms.
 *
 * A raw tool name plus a JSON blob forces the reader to decode the call before
 * they can tell whether it matters. `Read src/app.ts` is legible at a glance,
 * so the body can stay collapsed until someone actually wants it.
 */
/**
 * [pattern, settled, active]. The settled word is what a finished call reads as
 * and is deliberately unchanged: it is asserted across the summary tests and is
 * the vocabulary the transcript has always used.
 *
 * The active word exists because a running call and a finished one otherwise
 * look identical once the status badge is gone. Tense carries completion, the
 * way it does in a native transcript, instead of a chip that says "Done" on
 * every successful row.
 */
const VERBS: Array<[RegExp, string, string]> = [
    [/^(read|read_file|get_file|open_file|view|cat)$/i, 'Read', 'Reading'],
    [/^(write|write_file|create_file|edit|edit_file|apply_patch|str_replace\w*|update_file)$/i, 'Edit', 'Editing'],
    [/^(bash|shell|exec|exec_command|run|run_command|terminal)$/i, 'Bash', 'Running'],
    [/^(search|grep|rg|ripgrep|glob|find|codebase_search)$/i, 'Search', 'Searching'],
    [/^(fetch|browser\w*|web_\w*|open_url|http)$/i, 'Open', 'Opening'],
    [/^(list|ls|list_dir|list_files)$/i, 'List', 'Listing'],
];

/** A call that has not settled yet reads in the present tense. */
function isActive(status: CodeItem['status']): boolean {
    return status === 'running' || status === 'pending';
}

/** Longest-suffix workspace-relative path, so the row stays scannable. */
export function shortenPath(value: string, workingDir: string): string {
    const trimmed = value.trim();
    if (workingDir && trimmed.startsWith(workingDir)) {
        const relative = trimmed.slice(workingDir.length).replace(/^[\\/]+/, '');
        if (relative) return relative;
    }
    if (trimmed.length <= 64) return trimmed;
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : `…${trimmed.slice(-60)}`;
}

function firstLine(value: string): string {
    const line = value.split(/\r?\n/).find(row => row.trim()) ?? '';
    const collapsed = line.replace(/\s+/g, ' ').trim();
    return collapsed.length > 96 ? `${collapsed.slice(0, 95)}…` : collapsed;
}

/**
 * A tool argument may be a JSON object, a bare command, or a path. Pull the
 * one field a reader would recognise, and fall back to the first line rather
 * than printing an object.
 */
export function summariseToolInput(input: string | undefined, workingDir: string): string {
    if (!input) return '';
    const raw = input.trim();
    if (!raw) return '';
    const parsed = parseToolArguments(raw);
    if (parsed) {
        for (const key of TOOL_INPUT_KEY_ORDER) {
            const value = firstToolField(parsed, [key]);
            if (value !== null) {
                return key === 'path' || key === 'file' || key === 'file_path'
                    ? shortenPath(value, workingDir) : firstLine(value);
            }
        }
        return '';
    }
    return raw.includes('/') && !raw.includes(' ') ? shortenPath(raw, workingDir) : firstLine(raw);
}

export function toolSummary(item: CodeItem, workingDir: string): string {
    const active = isActive(item.status);
    if (item.kind === 'file_change') {
        const target = summariseToolInput(item.tool?.input, workingDir) || item.tool?.detail || '';
        const verb = active ? 'Editing' : 'Edit';
        return target ? `${verb} ${target}` : 'File change';
    }
    const name = item.tool?.name?.trim() || 'Tool';
    const match = VERBS.find(([pattern]) => pattern.test(name));
    const verb = match ? (active ? match[2] : match[1]) : undefined;
    const detail = summariseToolInput(item.tool?.input, workingDir);
    if (verb) return detail ? `${verb} ${detail}` : verb;
    // An unrecognised tool keeps its own name; renaming it would hide which
    // tool actually ran, including MCP tools whose names are the useful part.
    return detail ? `${name} ${detail}` : name;
}

/** Only states worth interrupting the reader for. `done` is the default. */
export function noteworthyStatus(item: CodeItem): string | null {
    if (item.kind === 'turn_cancelled' || item.status === 'cancelled') return 'Stopped';
    if (item.kind === 'turn_failed' || item.status === 'error') return 'Failed';
    if (item.status === 'running') return 'Running';
    if (item.status === 'pending') return 'Pending';
    return null;
}
