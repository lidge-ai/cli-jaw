// ─── Slack event tap ──────────────────────────────
// Appends a compact copy of every Socket Mode message / reaction event to a
// daily JSONL file, so a script that needs "what changed in these threads" can
// read the stream this process already receives instead of polling
// conversations.history / conversations.replies / reactions.get every minute.
// Those polls share Slack's per-app, per-method Tier 3 budget with every other
// reader of the same bot token, which is what produced the 429s.
//
// Opt-in and inert by default: the tap writes only when the directory
// `<JAW_HOME>/state/slack-event-tap/` exists. It runs at preflight, before the
// gate drops events that do not address the bot (most of what a watcher needs
// is exactly those), and it never throws — a failed append loses one line of
// a convenience copy, never a delivery.

import { appendFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { JAW_HOME } from '../core/config.js';

export const SLACK_EVENT_TAP_DIR = join(JAW_HOME, 'state', 'slack-event-tap');
const TAP_TYPES = new Set(['message', 'reaction_added', 'reaction_removed']);
const KEEP_DAYS = 7;
const TEXT_MAX = 4000;

type Dict = Record<string, unknown>;

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v ? v : undefined;
}

function pickFiles(files: unknown): Dict[] | undefined {
    if (!Array.isArray(files) || !files.length) return undefined;
    return files.slice(0, 20).map(f => {
        const o = (f || {}) as Dict;
        return {
            id: o['id'], name: o['name'], title: o['title'], mimetype: o['mimetype'], filetype: o['filetype'],
            size: o['size'], url_private: o['url_private'], url_private_download: o['url_private_download'],
        };
    });
}

function pickMessage(m: unknown): Dict | undefined {
    if (!m || typeof m !== 'object') return undefined;
    const o = m as Dict;
    return {
        ts: str(o['ts']), thread_ts: str(o['thread_ts']), user: str(o['user']), bot_id: str(o['bot_id']),
        subtype: str(o['subtype']), text: typeof o['text'] === 'string' ? (o['text'] as string).slice(0, TEXT_MAX) : undefined,
        reply_count: o['reply_count'], latest_reply: str(o['latest_reply']), files: pickFiles(o['files']),
    };
}

/** The line written for one event, or null when the event is not tapped. Exported for tests. */
export function slackEventTapLine(event: Dict, now = Date.now()): Dict | null {
    const type = str(event['type']);
    if (!type || !TAP_TYPES.has(type)) return null;
    if (type === 'message') {
        const channel = str(event['channel']);
        if (!channel) return null;
        return {
            received_at: now, type, subtype: str(event['subtype']), channel, channel_type: str(event['channel_type']),
            ...pickMessage(event),
            event_ts: str(event['event_ts']),
            message: pickMessage(event['message']),
            previous_message: pickMessage(event['previous_message']),
            deleted_ts: str(event['deleted_ts']),
        };
    }
    const item = (event['item'] || {}) as Dict;
    const channel = str(item['channel']);
    if (!channel) return null;
    return {
        received_at: now, type, channel, user: str(event['user']), reaction: str(event['reaction']),
        item: { type: str(item['type']), channel, ts: str(item['ts']) },
        item_user: str(event['item_user']), event_ts: str(event['event_ts']),
    };
}

let lastDay = '';

/** Append the event to today's tap file if the tap directory exists. Never throws. */
export function tapSlackEvent(event: unknown, dir = SLACK_EVENT_TAP_DIR): void {
    try {
        if (!event || typeof event !== 'object' || !existsSync(dir)) return;
        const line = slackEventTapLine(event as Dict);
        if (!line) return;
        const day = new Date().toISOString().slice(0, 10);
        appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(line) + '\n');
        if (day !== lastDay) {
            lastDay = day;
            const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
            for (const f of readdirSync(dir)) {
                if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) unlinkSync(join(dir, f));
            }
        }
    } catch {
        // A convenience copy; the delivery path is unaffected.
    }
}
