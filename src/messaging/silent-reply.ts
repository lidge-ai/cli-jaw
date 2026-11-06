// ─── Standalone [SILENT] reply marker ────────────────
// The system prompt tells the agent to answer [SILENT] when it has nothing to
// report. A line holding only that marker is a control token for the runtime,
// never text for a person: a heartbeat suppresses it, a registered Slack
// workflow records it as unconfirmed, and a chat reply strips it. A reply that
// was only the marker shows the same placeholder an empty answer does, so the
// turn still settles as delivered. The marker inside a sentence is ordinary
// text and stays.

const SILENT_LINE = /(?:^|\n)\s*\[SILENT\]\s*(?=\n|$)/i;
const SILENT_LINES = /(?:^|\n)\s*\[SILENT\]\s*(?=\n|$)/gi;

export function hasSilentLine(text: string): boolean {
    return SILENT_LINE.test(text);
}

export function withoutSilentLines(text: string): string {
    return hasSilentLine(text) ? text.replace(SILENT_LINES, '').trim() : text;
}

export function visibleReplyText(text: string, emptyText: string): string {
    return hasSilentLine(text) ? withoutSilentLines(text) || emptyText : text;
}
