// ─── Mention watch inbox ──────────────────────────
// Keeps third-party mentions that arrive on the Socket Mode stream, so a watch
// can answer them.
//
// WHY THIS EXISTS AT ALL
//
// The polling scan (src/slack/mention-watch.ts) reads conversations.history, and
// history does not return thread replies — Slack keeps them behind
// conversations.replies, addressed by a parent the scan cannot enumerate once
// that parent falls below its cursor. So a mention posted inside a thread was
// permanently invisible to the watch, and no polling interval could fix it.
//
// The event stream already delivers those messages to this process. They are
// dropped at the inbound gate because the BOT was not mentioned, which is right
// for starting an agent turn and wrong as a reason to forget the message. This
// module is the memory in between.
//
// It captures LIBERALLY and judges later: the drain re-runs classifyMentionWatch
// over the stored row, so the rules that decide what deserves an answer live in
// exactly one place.

import {
    insertMentionWatchInbox,
    listMentionWatchInbox,
    deleteMentionWatchInbox,
    pruneMentionWatchInbox,
} from '../core/db.js';
import { loadHeartbeatFile, isHeartbeatMentionWatch, settings } from '../core/config.js';
import { mentionsUser, type SlackMessageEvent } from './events.js';
import { log } from '../core/logger.js';
import { logErrorText } from '../messaging/redact.js';

/** Rows older than this are dropped. Long enough that a watch held behind a
 *  restart or a busy agent still finds its backlog, short enough that a channel
 *  removed from every watch stops accumulating. */
export const MENTION_WATCH_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Cap on one drain, so a burst cannot hand a tick more work than it can finish. */
export const MENTION_WATCH_INBOX_DRAIN_LIMIT = 50;

export type MentionWatchInboxRow = {
    channelId: string;
    ts: string;
    threadTs?: string | undefined;
    authorId?: string | undefined;
    botId?: string | undefined;
    subtype?: string | undefined;
    text: string;
};

type WatchSubscription = { subjectIds: string[]; channelIds: Set<string> };

/** Who is watched where, read fresh from heartbeat.json.
 *
 *  Not cached: the file is small, this runs once per inbound Slack event, and a
 *  stale copy would keep capturing for a watch an operator just narrowed. */
function subscriptions(): WatchSubscription[] {
    const out: WatchSubscription[] = [];
    for (const job of loadHeartbeatFile().jobs) {
        if (!job?.enabled) continue;
        const watch = (job as Record<string, unknown>)['mentionWatch'];
        if (!isHeartbeatMentionWatch(watch)) continue;
        const subjectIds = [watch.userId, ...(watch.userIds ?? [])].filter(Boolean);
        out.push({ subjectIds, channelIds: new Set(watch.channelIds) });
    }
    return out;
}

/**
 * Record an inbound message that names a watched person.
 *
 * Never throws. It runs on the socket's preflight path, where a throw withholds
 * the ack and makes Slack redeliver — losing a capture is a missed answer, but
 * breaking the ack would stall the whole conversation.
 */
export function captureMentionWatchInbox(event: SlackMessageEvent): void {
    try {
        if (!event.channel || !event.ts) return;
        // app_mention is a duplicate of a message envelope the stream also
        // delivers, and only ever fires for the bot itself.
        if (event.type === 'app_mention') return;
        // Bot authors are dropped at capture as well as at drain. The drain's
        // classifier is still the rule that decides; this is a volume guard.
        // Agents talk to each other far more than people do, and a drain reads a
        // bounded number of rows — letting machine chatter fill the queue would
        // push a human mention past that bound and leave it unanswered.
        if (event.bot_id || event.bot_profile) return;
        const text = String(event.text || '');
        if (!text) return;
        const workspaceId = String(settings['slack']?.teamId || '');
        if (!workspaceId) return;

        const watched = subscriptions();
        if (!watched.length) return;

        const now = Date.now();
        const stored = new Set<string>();
        for (const sub of watched) {
            if (!sub.channelIds.has(event.channel)) continue;
            for (const subjectId of sub.subjectIds) {
                if (stored.has(subjectId)) continue;
                if (!mentionsUser(text, subjectId)) continue;
                stored.add(subjectId);
                insertMentionWatchInbox.run(
                    workspaceId, subjectId, event.channel, event.ts,
                    event.thread_ts ?? null, event.user ?? null,
                    event.bot_id ?? null, event.subtype ?? null,
                    text, now,
                );
            }
        }
        if (stored.size) {
            const where = event.thread_ts ? ' (thread reply)' : '';
            log.info('[slack:mention-watch] captured ' + event.channel + '/' + event.ts
                + where + ' for ' + [...stored].join(', '));
        }
    } catch (error) {
        log.warn('[slack:mention-watch] capture failed: ' + logErrorText(error));
    }
}

/** Everything captured for one subject, oldest first. */
export function readMentionWatchInbox(
    workspaceId: string,
    subjectId: string,
    limit = MENTION_WATCH_INBOX_DRAIN_LIMIT,
): MentionWatchInboxRow[] {
    pruneMentionWatchInbox.run(Date.now() - MENTION_WATCH_INBOX_TTL_MS);
    const rows = listMentionWatchInbox.all(workspaceId, subjectId, limit) as Array<{
        channel_id: string; message_ts: string; thread_ts: string | null;
        author_id: string | null; bot_id: string | null; subtype: string | null; text: string;
    }>;
    return rows.map(row => ({
        channelId: row.channel_id,
        ts: row.message_ts,
        ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
        ...(row.author_id ? { authorId: row.author_id } : {}),
        ...(row.bot_id ? { botId: row.bot_id } : {}),
        ...(row.subtype ? { subtype: row.subtype } : {}),
        text: row.text,
    }));
}

/** Drop a row the tick has finished deciding about. */
export function clearMentionWatchInbox(
    workspaceId: string,
    subjectId: string,
    channelId: string,
    ts: string,
): void {
    deleteMentionWatchInbox.run(workspaceId, subjectId, channelId, ts);
}
