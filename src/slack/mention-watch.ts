// ─── Mention watch ────────────────────────────────
// Finds messages where a WATCHED person was mentioned, so a heartbeat job can
// answer in those threads. This is not the inbound path: `mentionOnly` there
// asks whether the BOT was mentioned, and Slack's `app_mention` event only
// fires for the app itself. Nobody sends us an event when a third party is
// tagged, so the only way to see it is to read history.
//
// WHY POLLING AND NOT SEARCH
//
// `search.messages` would answer this in one call, and it is not available: it
// is a user-token method, and the bot token this app installs with carries
// `channels:history`/`groups:history` but no `search:read` (a bot token cannot
// hold it). So the scan walks the channels the bot is actually in. That bounds
// what this can see, and the bound is honest: a channel the bot never joined
// is invisible here no matter what we do.

import { fetchSlackHistory, SLACK_HISTORY_DEFAULT_LIMIT, SLACK_HISTORY_MAX_LIMIT } from './history.js';
import type { SlackHistoryMessage } from './history.js';
import type { SlackFetch } from './api.js';
import {
    classifyMentionWatch,
    mentionWatchSubjects,
    type HeartbeatMentionWatchCondition,
    type MentionWatchMatch,
} from './mention-watch-match.js';

export type MentionHit = {
    channelId: string;
    /** ts of the message that carried the mention. */
    ts: string;
    /** Where a reply belongs: the thread parent when there is one, else the
     *  message itself. Replying to `ts` when the message already lives in a
     *  thread would start a second thread off a reply. */
    threadTs: string;
    /** True when `threadTs` is the message's OWN ts — a reply address for a
     *  thread that does not exist yet, not a conversation. The session key must
     *  fall back to the channel, exactly as the inbound path does, or the two
     *  producers key the same top-level message differently and a mention answer
     *  lands in a session the conversation cannot read (#520). */
    threadIsSynthetic?: boolean;
    authorId: string | null;
    text: string;
    match?: MentionWatchMatch;
    subjectId?: string | null;
};

export type MentionScanState = {
    /** Last ts already scanned per channel; the next scan starts after it. */
    cursor(channelId: string): string | undefined;
    /** Where an unfinished backward walk stopped, if one did.
     *
     *  A tick that spends its window budget without reaching the cursor has read
     *  a span but not the gap below it. Without remembering where it stopped, the
     *  next tick starts from the newest message again and re-reads the same
     *  windows forever — the deep backlog is never reached. This is the exclusive
     *  upper bound to resume from. */
    resumeBefore?(channelId: string): string | undefined;
    /** True when this exact message was already handed to the agent. */
    seen(channelId: string, ts: string): boolean;
};

export type MentionScanOptions = {
    /** The person whose mentions we are looking for. */
    userId: string;
    /** Extra subjects; omit or empty keeps `userId` only. */
    userIds?: string[] | undefined;
    /** OR of mention/talk rules. Omit or empty keeps mention-of-subjects. */
    conditions?: HeartbeatMentionWatchCondition[] | undefined;
    /** Channels to scan. REQUIRED and non-empty.
     *
     *  Enumerating the workspace was the obvious alternative and it does not
     *  work: an answer addressed to a channel is authorized against the
     *  configured allowlist (`authorizeExplicitTarget`), so a channel this scan
     *  discovered on its own would be found and then refused with a 403. The
     *  caller therefore passes a subset of the allowlist, which makes every hit
     *  answerable by construction. */
    channelIds: string[];
    /** Bot's own user id, so its messages never look like a hit. */
    selfUserId?: string | null | undefined;
    limit?: number | undefined;
    /** Cap on hits returned, so one busy morning cannot hand the agent fifty
     *  threads to answer in a single tick. */
    maxHits?: number | undefined;
    /** Channel to begin the rotation at, so a busy channel cannot hold the whole
     *  budget tick after tick.
     *
     *  The hit cap is global, and the scan stops once it is reached. Always
     *  starting at the first configured channel therefore means a channel that
     *  produces mentions faster than the cap starves every channel behind it —
     *  permanently, not just for one tick. The caller persists the channel after
     *  the last one served and passes it back here. Unknown ids are ignored, so a
     *  reconfigured channel list degrades to starting from the top. */
    startAfterChannelId?: string | undefined;
    /** Slack ts floor. Adopting this feature must not answer last month's
     *  backlog, so a job with no cursor yet starts here. */
    since?: string | undefined;
    state: MentionScanState;
    fetchImpl?: SlackFetch | undefined;
    signal?: AbortSignal | undefined;
    /** Pause between channel reads. conversations.history is Tier 3 for
     *  internal apps, and a scan across many channels is the one place this
     *  could burst. */
    pacingMs?: number | undefined;
    /** Windows to walk backward per channel before giving up for this tick. */
    maxWindowsPerChannel?: number | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type MentionScanResult = {
    hits: MentionHit[];
    /** Frontier per channel: the newest ts this tick is FINISHED with. The caller
     *  persists it as the next cursor. Absent for a channel means the cursor must
     *  not move — either work is still outstanding below it, or the walk never
     *  reached the cursor. */
    cursors: Map<string, string>;
    /** Per channel, where an unfinished backward walk stopped, to be persisted
     *  and passed back as `resumeBefore` next tick. A channel that finished its
     *  walk maps to null, which means "clear any stored bound". */
    resumeBounds: Map<string, string | null>;
    /** Last channel this tick actually read, to be persisted and passed back as
     *  `startAfterChannelId`. Null when nothing was read. */
    lastChannelId: string | null;
    /** Channels that could not be read, with Slack's reason. Reported rather
     *  than thrown: one `not_in_channel` must not abandon the whole scan. */
    failed: Array<{ channelId: string; error: string }>;
    /** True when the scan stopped early because Slack answered `ratelimited`.
     *  Channels not reached kept their cursors, so the next tick resumes them. */
    rateLimited: boolean;
    /** True when at least one channel still had unread history when this tick
     *  stopped — whether the window budget ran out, a read failed, or the scan
     *  was aborted. Those cursors did NOT advance and the walk resumes from
     *  `resumeBounds` next tick. Surfaced so a caller can tell "caught up" from
     *  "still draining". */
    truncated: boolean;
    /** True when the global hit cap stopped the channel loop.
     *
     *  Separate from `truncated` because it is a different fact and the two
     *  together are what "caught up" actually requires. The cap breaks out of the
     *  loop WITHOUT touching `truncated`, so a busy morning of five hits leaves
     *  later channels unread while `truncated` stays false — a caller reading that
     *  flag alone would report caught-up over an unread backlog. */
    hitCapReached: boolean;
    /** Channel ids beyond MENTION_WATCH_MAX_CHANNELS, which this tick did not
     *  read. Reported rather than dropped in silence: a channel an operator
     *  believes is watched but is not is the failure this whole feature exists to
     *  avoid. Configuration is validated against the same ceiling before a job
     *  runs, so a non-empty value here means a hand-edited file got past that
     *  check and the caller should say so out loud. */
    overflowChannels: string[];
};

export const MENTION_WATCH_DEFAULT_MAX_HITS = 5;
/** Pause between reads.
 *
 *  `conversations.history` is Tier 3 (50+/min) for an internal app, and 1,200ms
 *  sits exactly on that boundary — leaving nothing for a concurrent
 *  `/api/slack/history` call, which shares the same per-method budget. Backing off
 *  to 2s keeps roughly half the budget free for interactive use. */
export const MENTION_WATCH_DEFAULT_PACING_MS = 2_000;
/** Ceiling on channels read per tick. Extra ids beyond it are dropped rather
 *  than queued, so one tick's call count stays bounded even if an operator
 *  configures a very long list. */
export const MENTION_WATCH_MAX_CHANNELS = 60;

/** Windows read per channel per tick when a backlog is present.
 *
 *  `conversations.history` fills a window with the NEWEST messages after
 *  `oldest`, not the oldest ones, so a single window over a busy channel leaves
 *  older messages behind `has_more`. Walking backward with `latest` is the only
 *  way to reach them.
 *
 *  This bounds the WINDOWS per channel, so a tick asks for at most
 *  `channels x this` windows. HTTP calls can be up to twice that: the history
 *  wrapper retries a retryable failure (`internal_error`, `service_unavailable`,
 *  `request_timeout`, `fatal_error`) once. That retry is wanted — a blip should
 *  not cost a channel its turn — so the doubling is the honest figure rather
 *  than something to design away. `ratelimited` is the exception and is opted
 *  out of, because a 429 ends the tick. */
export const MENTION_WATCH_MAX_WINDOWS_PER_CHANNEL = 4;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Slack ts values are decimal strings whose numeric order is chronological.
 *  Compared as numbers because string order breaks across digit counts. */
function newer(a: string, b: string | undefined): boolean {
    if (!b) return true;
    return Number(a) > Number(b);
}


/** De-duplicated channel list plus whatever did not fit. The bound keeps one
 *  tick's call count knowable: channels x window budget, worst case.
 *
 *  Overflow is RETURNED rather than dropped. A caller that silently watched the
 *  first sixty of a longer list would leave the operator believing the rest are
 *  covered, and missing a mention is the one outcome this feature exists to
 *  prevent. */
function resolveChannels(options: MentionScanOptions): { ordered: string[]; overflow: string[] } {
    const seen = new Set<string>();
    const overflow: string[] = [];
    for (const id of options.channelIds) {
        if (typeof id !== 'string' || !id) continue;
        if (seen.has(id)) continue;
        if (seen.size >= MENTION_WATCH_MAX_CHANNELS) { overflow.push(id); continue; }
        seen.add(id);
    }
    const ordered = [...seen];
    // Rotate so the channel after the last one served comes first.
    const after = options.startAfterChannelId;
    if (!after) return { ordered, overflow };
    const at = ordered.indexOf(after);
    if (at < 0) return { ordered, overflow };
    return { ordered: [...ordered.slice(at + 1), ...ordered.slice(0, at + 1)], overflow };
}

/**
 * Scan for mentions of `userId`. Read-only: persistence of cursors and the seen
 * ledger belongs to the caller, which is what lets a failed tick retry the same
 * messages instead of losing them.
 */
export async function scanSlackMentions(
    token: string,
    options: MentionScanOptions,
): Promise<MentionScanResult> {
    const maxHits = Math.max(1, options.maxHits ?? MENTION_WATCH_DEFAULT_MAX_HITS);
    const limit = Math.min(Math.max(options.limit ?? SLACK_HISTORY_DEFAULT_LIMIT, 1), SLACK_HISTORY_MAX_LIMIT);
    const pacingMs = options.pacingMs ?? MENTION_WATCH_DEFAULT_PACING_MS;
    const maxWindows = Math.max(1, options.maxWindowsPerChannel ?? MENTION_WATCH_MAX_WINDOWS_PER_CHANNEL);
    const sleep = options.sleep ?? defaultSleep;
    const subjects = mentionWatchSubjects({ userId: options.userId, userIds: options.userIds });
    const hits: MentionHit[] = [];
    const cursors = new Map<string, string>();
    const resumeBounds = new Map<string, string | null>();
    const { ordered: channels, overflow: overflowChannels } = resolveChannels(options);
    const failed: Array<{ channelId: string; error: string }> = [];
    let truncated = false;
    let calls = 0;
    let lastChannelId: string | null = null;
    // A 429 means the shared per-method budget is already gone. Continuing to the
    // next channel would spend it again and push the interactive
    // `/api/slack/history` path into the same wall, so the tick stops and the
    // untouched channels wait — their cursors did not move, so nothing is lost.
    let rateLimited = false;
    // Set where the cap actually stops the loop, not inferred from hits.length:
    // a scan that ends with exactly maxHits because that is all there was is not
    // the same as one cut short.
    let hitCapReached = false;

    for (const channelId of channels) {
        if (options.signal?.aborted) break;
        if (rateLimited) break;
        if (hits.length >= maxHits) { hitCapReached = true; break; }
        lastChannelId = channelId;
        const from = options.state.cursor(channelId) ?? options.since;

        // Read backward until the window reaches the cursor, then process the
        // whole span oldest-first.
        //
        // One window is not enough: `conversations.history` fills a window with
        // the NEWEST messages in range, so over a busy channel the older half
        // sits behind `has_more`. Advancing the cursor anyway would step over
        // those messages permanently; refusing to advance would re-read the same
        // newest page forever. Walking `latest` downward is what actually reaches
        // them.
        const collected: SlackHistoryMessage[] = [];
        // Resume where the last unfinished walk stopped. Starting from the newest
        // message again would re-read the same windows every tick and the gap
        // below them would never be reached.
        let latest: string | undefined = options.state.resumeBefore?.(channelId);
        let reachedCursor = true;
        for (let window = 0; window < maxWindows; window += 1) {
            if (options.signal?.aborted) { reachedCursor = false; break; }
            if (calls > 0 && pacingMs > 0) await sleep(pacingMs);
            calls += 1;
            const page = await fetchSlackHistory(token, channelId, {
                limit,
                // A 429 here ends the tick, so the wrapper's bounded retry is a
                // request we have already decided not to make. Letting it fire
                // spends the budget the stop exists to protect, and the
                // interactive `/api/slack/history` path shares that budget.
                noRetryOnRateLimit: true,
                ...(from ? { oldest: from } : {}),
                ...(latest ? { latest } : {}),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (!page.ok) {
                failed.push({ channelId, error: page.error });
                reachedCursor = false;
                if (page.code === 'ratelimited') rateLimited = true;
                break;
            }
            collected.push(...page.messages);
            if (!page.hasMore) break;
            // Oldest ts in this window becomes the next exclusive upper bound.
            const oldestSeen = page.messages.reduce<string | undefined>(
                (acc, m) => (acc === undefined || Number(m.ts) < Number(acc) ? m.ts : acc),
                undefined,
            );
            // No progress possible. Slack said there is more below and then gave
            // nothing to descend past, so the next tick would ask for the exact
            // same window forever. Report it as unreadable instead of spinning in
            // silence: a channel that never advances needs to be visible.
            if (!oldestSeen || oldestSeen === latest) {
                failed.push({ channelId, error: 'history did not advance (has_more with no usable ts)' });
                reachedCursor = false;
                break;
            }
            latest = oldestSeen;
            if (window === maxWindows - 1) {
                // Budget spent with history still unread.
                reachedCursor = false;
                truncated = true;
            }
        }
        // Where the walk stopped, recorded for EVERY unfinished exit — budget
        // spent, 429, network error, abort, or a window that could not advance.
        // Recording it only on budget exhaustion loses the descent whenever the
        // second window fails: the next tick would start from the newest message
        // again and re-read the span it already paid for, so a channel that fails
        // intermittently never reaches its backlog at all.
        //
        // `latest` is undefined only when the FIRST window never returned, and in
        // that case there is no descent to remember — leaving the stored bound
        // untouched is right, because the previous tick's bound is still where
        // this channel belongs.
        //
        // A walk that reached the cursor has no gap left below it, so its stored
        // bound is stale: clear it, or the next tick keeps re-reading a span it
        // has already finished.
        if (reachedCursor) resumeBounds.set(channelId, null);
        else if (latest) { resumeBounds.set(channelId, latest); truncated = true; }
        if (collected.length === 0) continue;

        // Oldest first: hits keep conversational order, and a `maxHits` cut drops
        // the NEWEST rather than the oldest. The oldest unanswered mention is the
        // one that has waited longest.
        const ordered = [...collected].sort((a, b) => Number(a.ts) - Number(b.ts));

        // The cursor is a FRONTIER, not a high-water mark: it may only name a
        // message this tick is finished with, and it stops at the first one it is
        // not. Advancing to the newest ts instead would silently drop every hit
        // that did not fit under `maxHits`.
        //
        // It also stays closed when the backward walk never reached the cursor:
        // an unread gap below the span may hold mentions, and moving the cursor
        // above that gap would skip them for good.
        let frontier: string | undefined;
        let frontierOpen = reachedCursor;
        for (const message of ordered) {
            const classified = classifyMentionWatch(message, {
                subjects,
                selfUserId: options.selfUserId,
                channelId,
                conditions: options.conditions,
            });
            const candidate = classified !== null;
            const alreadyHandled = candidate && options.state.seen(channelId, message.ts);
            const carried = candidate && !alreadyHandled && hits.length < maxHits;
            if (carried && classified) {
                hits.push({
                    channelId,
                    ts: message.ts,
                    threadTs: message.threadTs || message.ts,
                    // Same promotion as the inbound path, so it carries the same
                    // flag: without it this producer keeps minting one session
                    // per top-level mention (#520).
                    ...(message.threadTs ? {} : { threadIsSynthetic: true }),
                    authorId: message.user ?? null,
                    text: message.text,
                    match: classified.match,
                    subjectId: classified.subjectId,
                });
            }
            // Either an unanswered hit this tick could not carry, or one carried
            // but not yet proven delivered — the caller records `seen` only after a
            // successful post. Both close the frontier here so the next tick
            // starts at this message.
            if (candidate && !alreadyHandled) frontierOpen = false;
            if (frontierOpen && newer(message.ts, frontier)) frontier = message.ts;
        }
        if (frontier) cursors.set(channelId, frontier);
    }

    return { hits, cursors, resumeBounds, lastChannelId, failed, truncated, hitCapReached, rateLimited, overflowChannels };
}
