// ─── Heartbeat mention watch ─────────────────────────
// One tick of "find messages that tagged this person, answer each in its
// thread". The scan itself lives in src/slack/mention-watch.ts; this module owns
// the parts that must be durable: which messages are already answered, how far
// each channel has been read, and the rule that the SERVER posts the answer.
//
// WHY THE SERVER SENDS
//
// Letting the agent post directly makes a tick's success meaningless as evidence
// of delivery: it can answer three threads, fail on two sends, and still exit
// with a clean transcript. Here each item is a separate round trip — ask, send,
// record — so a receipt exists per message and a partial tick leaves the rest
// unrecorded for the next one to pick up.
//
// The guarantee is AT-LEAST-ONCE. If the process dies between a successful post
// and its 'seen' write, the next tick answers that message again. Exactly-once
// needs a durable reservation taken before the send plus an ambiguous state to
// resolve afterwards, which is more machinery than this is worth today. The limit
// is written down rather than papered over.

import {
    hasSeenMention,
    recordSeenMention,
    pruneSeenMentions,
    readCursor,
    advanceCursor,
    setResumeBefore,
    readRotation,
    recordRotation,
} from './mention-watch-ledger.js';
import type { WatchNamespace } from './mention-watch-ledger.js';
import { scanSlackMentions, MENTION_WATCH_DEFAULT_MAX_HITS } from '../slack/mention-watch.js';
import type { MentionHit } from '../slack/mention-watch.js';
import { classifyMentionWatch, mentionWatchSubjects } from '../slack/mention-watch-match.js';
import { readMentionWatchInbox, clearMentionWatchInbox } from '../slack/mention-watch-inbox.js';
import type { HeartbeatMentionWatch } from '../core/config.js';

export type MentionWatchTickResult = {
    /** Messages answered and recorded. */
    answered: number;
    /** Hits the agent chose not to answer. Recorded as handled, because deciding
     *  to stay quiet is a decision about that message. */
    quiet: number;
    /** Sends that failed. Their receipts are NOT written, so they retry. */
    failed: number;
    /** Channels the scan could not read. */
    unreadable: string[];
    /** Configured channels outside the current Slack allowlist, which this tick
     *  did not scan. An answer addressed there would be refused with a 403, so
     *  scanning them would only produce work that cannot be delivered. */
    unauthorized: string[];
    /** Channels beyond the scanner's ceiling. Non-empty means a hand-edited file
     *  got past config validation; reported so it is visible rather than silent. */
    overflow: string[];
    /** At least one channel's backward walk did not reach its cursor this tick.
     *
     *  Deliberately NOT called a backlog. The scanner raises it for a spent window
     *  budget, a 429, a network error, an abort, and a `has_more` page that could
     *  not advance. It is a reason to look, not a measurement. */
    scanIncomplete: boolean;
    /** The global hit cap stopped the scan before every channel was read.
     *
     *  Needed because `scanIncomplete` stays FALSE in that case, so its negation
     *  alone would report caught-up over channels nobody looked at. Caught up is
     *  both of these false. */
    hitCapReached: boolean;
    /** Set when the tick stopped early. */
    stoppedBecause?: 'rate_limited' | 'yielded' | 'aborted' | 'budget';
};

export type MentionWatchDeps = {
    /** Slack bot token. */
    token: string;
    /** The bot own user id, so its posts never read as a hit. */
    selfUserId: string | null;
    /** Channels answers may be addressed to, read FRESH for this tick. */
    allowlist: readonly string[];
    /** Ask the agent for one answer. Returns null to say nothing. */
    answer(hit: MentionHit, job: Record<string, unknown>): Promise<string | null>;
    /** Post it. Returns false when delivery failed. */
    send(hit: MentionHit, text: string): Promise<boolean>;
    /** Called before EACH item. A non-null reason abandons the rest of the tick.
     *
     *  Checking once before the loop is not enough: the first answer can take
     *  minutes, and a user message or a PABCD transition arriving in that window
     *  has to win. Unanswered items are not recorded, so the next tick has them.
     *
     *  The hit is passed because the decision is per CONVERSATION, not global: the
     *  answer runs in the session bound to that thread, so the work that outranks
     *  it is the work in that thread. A global check would either block on an
     *  unrelated conversation or miss the one this item is about to touch. */
    yieldNow(hit: MentionHit): 'yielded' | null;
    fetchImpl?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    now?: () => number;
    /** Wall-clock allowance for the ANSWERING phase, measured from after the scan.
     *
     *  Not from tick entry: the scan legitimately sleeps for minutes on pacing, so
     *  a whole-tick budget could expire with zero answers while the rotation anchor
     *  had already moved.
     *
     *  It bounds what is STARTED, not total wall time — an answer admitted with a
     *  millisecond left still runs to its own idle bound, so the honest worst case
     *  is this budget plus one turn. */
    answerBudgetMs?: number | undefined;
    log?: (message: string) => void;
};

/** Intersect the job's channels with the live allowlist.
 *
 *  Re-derived every tick on purpose. The allowlist can shrink after a job was
 *  saved, and the timer holds the job object as it was — so a check made only at
 *  save time would send this scan after channels whose answers now 403. */
function authorizedChannels(
    configured: readonly string[],
    allowlist: readonly string[],
): { allowed: string[]; rejected: string[] } {
    // An empty allowlist does NOT mean "anything goes" for an explicitly
    // addressed send. `authorizeExplicitTarget` falls back to vouching only for
    // conversations this process has evidence for — last-active, latest-seen, or a
    // bound conversation — so a channel with no such evidence is refused with a
    // 403 (src/messaging/send.ts:301).
    //
    // Reading it anyway would be worse than useless: the scan finds a mention,
    // pays for an agent turn to answer it, gets a 403, records no receipt, and
    // does the whole thing again next tick. Refusing to scan is the honest
    // answer, and `unauthorized` says which channels need an allowlist entry.
    if (allowlist.length === 0) return { allowed: [], rejected: [...configured] };
    const permitted = new Set(allowlist);
    const allowed: string[] = [];
    const rejected: string[] = [];
    for (const id of configured) (permitted.has(id) ? allowed : rejected).push(id);
    return { allowed, rejected };
}

export async function runMentionWatchTick(
    ns: WatchNamespace,
    job: Record<string, unknown>,
    watch: HeartbeatMentionWatch,
    deps: MentionWatchDeps,
): Promise<MentionWatchTickResult> {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? (() => {});
    const result: MentionWatchTickResult = {
        answered: 0, quiet: 0, failed: 0,
        unreadable: [], unauthorized: [], overflow: [],
        scanIncomplete: false, hitCapReached: false,
    };

    const { allowed, rejected } = authorizedChannels(watch.channelIds, deps.allowlist);
    result.unauthorized = rejected;
    if (rejected.length) {
        // Two different situations, and an operator needs to be told which. An
        // empty allowlist is the shipped default and reads as "every conversation"
        // for an ordinary reply, but an explicitly addressed send still needs a
        // configured list or prior evidence for that conversation — so a watch
        // running under it would find mentions it cannot answer.
        const reason = deps.allowlist.length === 0
            ? 'slack.channelIds is empty, so an explicitly addressed send has nothing to authorize against; add the watched channels to it'
            : 'outside slack.channelIds';
        log(`mention watch: skipped ${rejected.length} channel(s) — ${reason}: ${rejected.join(', ')}`);
    }
    if (allowed.length === 0) return result;

    // Thread replies first, from the live capture.
    //
    // The scan below reads conversations.history, which never returns a thread
    // reply. Anything tagged inside a thread reaches this process only on the
    // event stream, and mention-watch-inbox.ts is where it was kept. Drained
    // BEFORE the scan so a rate limit that ends the tick cannot starve it — the
    // captured rows cost no API calls, and a message someone is waiting on
    // outranks a backward walk through history.
    const inboxOwned = new Set(allowed);
    const subjects = mentionWatchSubjects(watch);
    const inboxHits: MentionHit[] = [];
    const inboxSettled: MentionHit[] = [];
    for (const row of readMentionWatchInbox(ns.workspaceId, watch.userId)) {
        // Another job owns this channel. Leaving the row alone is the point:
        // deleting it here would consume a mention this job may not answer.
        if (!inboxOwned.has(row.channelId)) continue;
        // The floor an operator set when the job was (re)started. Without it a
        // fresh start would answer everything captured before it.
        if (watch.since && Number(row.ts) <= Number(watch.since)) {
            clearMentionWatchInbox(ns.workspaceId, watch.userId, row.channelId, row.ts);
            continue;
        }
        if (hasSeenMention(ns, row.channelId, row.ts)) {
            clearMentionWatchInbox(ns.workspaceId, watch.userId, row.channelId, row.ts);
            continue;
        }
        // Same classifier the scan uses, so capture stays liberal and exactly one
        // place decides what deserves an answer.
        const classified = classifyMentionWatch({
            ts: row.ts,
            text: row.text,
            ...(row.threadTs ? { threadTs: row.threadTs } : {}),
            ...(row.authorId ? { user: row.authorId } : {}),
            ...(row.botId ? { botId: row.botId } : {}),
            ...(row.subtype ? { subtype: row.subtype } : {}),
        }, {
            subjects,
            selfUserId: deps.selfUserId,
            channelId: row.channelId,
            ...(watch.conditions?.length ? { conditions: watch.conditions } : {}),
        });
        if (!classified) {
            clearMentionWatchInbox(ns.workspaceId, watch.userId, row.channelId, row.ts);
            continue;
        }
        inboxHits.push({
            channelId: row.channelId,
            ts: row.ts,
            threadTs: row.threadTs || row.ts,
            ...(row.threadTs ? {} : { threadIsSynthetic: true }),
            authorId: row.authorId ?? null,
            text: row.text,
            match: classified.match,
            subjectId: classified.subjectId,
        });
    }

    const rotationAnchor = readRotation(ns);
    const scan = await scanSlackMentions(deps.token, {
        userId: watch.userId,
        ...(watch.userIds?.length ? { userIds: watch.userIds } : {}),
        ...(watch.conditions?.length ? { conditions: watch.conditions } : {}),
        channelIds: allowed,
        selfUserId: deps.selfUserId,
        maxHits: watch.maxHits ?? MENTION_WATCH_DEFAULT_MAX_HITS,
        ...(watch.since ? { since: watch.since } : {}),
        ...(rotationAnchor ? { startAfterChannelId: rotationAnchor } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        state: {
            cursor: (channelId) => readCursor(ns, channelId).lastTs,
            resumeBefore: (channelId) => readCursor(ns, channelId).resumeBefore,
            seen: (channelId, ts) => hasSeenMention(ns, channelId, ts),
        },
    });

    result.unreadable = scan.failed.map(f => f.channelId);
    result.overflow = scan.overflowChannels;
    // Computed by the scanner and, until now, dropped on the floor here.
    result.scanIncomplete = scan.truncated;
    result.hitCapReached = scan.hitCapReached;
    if (scan.overflowChannels.length) {
        log(`mention watch: ${scan.overflowChannels.length} channel(s) past the scanner ceiling were not read: ${scan.overflowChannels.join(', ')}`);
    }
    for (const failure of scan.failed) log(`mention watch: ${failure.channelId} unreadable: ${failure.error}`);

    // Rotation and resume bounds are persisted BEFORE any answering, because they
    // describe what the SCAN did. Writing them afterwards would lose them
    // whenever the answering loop exits early, and the next tick would repeat the
    // same reads.
    if (scan.lastChannelId) recordRotation(ns, scan.lastChannelId, now());
    for (const [channelId, bound] of scan.resumeBounds) {
        setResumeBefore(ns, channelId, bound, now());
    }

    // The answering clock starts HERE, after the scan, for the reason given on
    // `answerBudgetMs`.
    const answeringSince = now();
    // The scan can surface a top-level message the capture already holds. One
    // answer per message, and the captured copy wins because it is the one with a
    // row to retire.
    const fromInbox = new Set(inboxHits.map(hit => hit.channelId + '/' + hit.ts));
    const pending = [...inboxHits, ...scan.hits.filter(hit => !fromInbox.has(hit.channelId + '/' + hit.ts))];
    for (const hit of pending) {
        if (deps.signal?.aborted) { result.stoppedBecause = 'aborted'; break; }
        // Before the answer, never after: checking afterwards would spend a full
        // orchestrator turn to discover the tick was already over. An unanswered
        // hit keeps no receipt, so the next tick has it.
        if (deps.answerBudgetMs !== undefined && now() - answeringSince >= deps.answerBudgetMs) {
            result.stoppedBecause = 'budget';
            break;
        }
        // Re-checked per item, not once for the batch: the previous answer may
        // have taken minutes, and a user who started typing during it outranks
        // the rest of this backlog.
        const yielded = deps.yieldNow(hit);
        if (yielded) { result.stoppedBecause = yielded; break; }

        let text: string | null;
        try {
            text = await deps.answer(hit, job);
        } catch (error) {
            result.failed += 1;
            log(`mention watch: answer failed for ${hit.channelId}/${hit.ts}: ${(error as Error).message}`);
            continue;
        }
        if (!text) {
            // Deliberate silence is a decision about this message, so record it:
            // otherwise every tick asks again and pays for the same answer.
            recordSeenMention(ns, hit.channelId, hit.ts, now());
            if (fromInbox.has(hit.channelId + '/' + hit.ts)) inboxSettled.push(hit);
            result.quiet += 1;
            continue;
        }
        const sent = await deps.send(hit, text);
        if (!sent) {
            // No receipt on a failed send: the next tick must be free to retry.
            result.failed += 1;
            log(`mention watch: send failed for ${hit.channelId}/${hit.ts}`);
            continue;
        }
        recordSeenMention(ns, hit.channelId, hit.ts, now());
        if (fromInbox.has(hit.channelId + '/' + hit.ts)) inboxSettled.push(hit);
        result.answered += 1;
    }

    // Captured rows are retired only once their message is settled. A row left
    // behind by a failed send or an exhausted budget is exactly what the next
    // tick needs to find.
    for (const hit of inboxSettled) {
        clearMentionWatchInbox(ns.workspaceId, watch.userId, hit.channelId, hit.ts);
    }

    if (scan.rateLimited) result.stoppedBecause ??= 'rate_limited';

    // Cursors move LAST, because only now is delivery known.
    //
    // The scanner's frontier deliberately stops BEFORE any hit it carried: at scan
    // time it cannot know whether that message will be answered, so it refuses to
    // step over it. Delivery is this function's knowledge, so the settled hits are
    // folded in here. Without that the cursor would never pass a mention at all
    // and every tick would re-read the same window forever.
    const unsettled = new Set<string>();
    const settledHigh = new Map<string, string>();
    for (const hit of scan.hits) {
        if (!hasSeenMention(ns, hit.channelId, hit.ts)) {
            unsettled.add(hit.channelId);
            continue;
        }
        const high = settledHigh.get(hit.channelId);
        if (high === undefined || Number(hit.ts) > Number(high)) settledHigh.set(hit.channelId, hit.ts);
    }

    const advanceTo = new Map<string, string>();
    for (const [channelId, frontier] of scan.cursors) advanceTo.set(channelId, frontier);
    for (const [channelId, ts] of settledHigh) {
        // Only for a channel whose backward walk actually reached the cursor. A
        // truncated walk leaves an unread gap BELOW this span, and moving the
        // cursor above that gap would skip whatever is in it for good.
        if (scan.resumeBounds.get(channelId) !== null) continue;
        const existing = advanceTo.get(channelId);
        if (existing === undefined || Number(ts) > Number(existing)) advanceTo.set(channelId, ts);
    }

    for (const [channelId, frontier] of advanceTo) {
        // One unsettled hit holds the whole channel: the cursor may not pass a
        // message this tick failed to answer, even if a later one succeeded.
        if (unsettled.has(channelId)) continue;
        advanceCursor(ns, channelId, frontier, now());
        // Receipts at or below the frontier can never be consulted again: the
        // next scan reads strictly above it.
        pruneSeenMentions(ns, channelId, frontier);
    }

    return result;
}
