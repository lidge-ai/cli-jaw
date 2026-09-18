// ─── Slack Event Normalization ───────────────────────
// Pure decision + extraction helpers. No IO, so every gating rule below is
// directly unit-testable without a socket or a workspace.

import { assertSkillId } from '../security/path-guards.js';

export type SlackFileEvent = {
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    mode?: string;
    file_access?: string;
    url_private?: string;
    url_private_download?: string;
};

export type SlackBotProfile = {
    id?: string;
    app_id?: string;
    user_id?: string;
    name?: string;
    team_id?: string;
    deleted?: boolean;
};

export type SlackMessageEvent = {
    action_token?: string;
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    /** Modern granular-permission apps identify themselves here. */
    bot_profile?: SlackBotProfile;
    /** Slack says a present `username` overrides the bot's default name. */
    username?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    blocks?: unknown[];
    files?: SlackFileEvent[];
};

export type SlackGateConfig = {
    selfUserId: string | null;
    allowBots: boolean;
    mentionOnly: boolean;
    channelIds: string[];
    /** true = threads also require a mention (multi-bot escape hatch). */
    threadRequireMention: boolean;
    /**
     * Operator-declared allowances for other bots, straight from settings.json.
     * Deliberately `unknown`: nothing validates that file on read, so the shape
     * is proven here rather than assumed by every caller.
     */
    trustedBotTriggers?: unknown;
    /**
     * How the bot is in this thread, injected so this module stays IO-free.
     * `owned` = the bot's own message parents the thread; `joined` = it was
     * pulled into a conversation already in progress; null = not in it.
     */
    threadParticipation: (channel: string, threadTs: string) => 'owned' | 'joined' | null;
};

export type SlackGateDecision =
    | { process: true }
    | { process: false; reason: string };

/** Message subtypes that are edits/joins/system noise, never user input. */
const IGNORED_SUBTYPES = new Set([
    'message_changed',
    'message_deleted',
    'channel_join',
    'channel_leave',
    'channel_topic',
    'channel_purpose',
    'bot_message',
    'thread_broadcast_deleted',
]);

export function isDirectMessage(event: SlackMessageEvent): boolean {
    return event.channel_type === 'im' || (event.channel || '').toUpperCase().startsWith('D');
}

export function isSlackMention(event: SlackMessageEvent, selfUserId: string | null): boolean {
    return event.type === 'app_mention' || (event.channel_type === 'mpim' && !!selfUserId && mentionsUser(event.text || '', selfUserId));
}

export function mentionsUser(text: string, userId: string): boolean {
    return new RegExp(`<@${userId}(?:\\|[^>]*)?>`).test(text);
}

/** One other bot, in one conversation, saying one agreed word. */
export type TrustedBotTrigger = {
    channelId: string;
    botId: string;
    userId: string;
    textMarker: string;
    workflowSkill?: string;
    /** Give every message this rule admits its own run lane, so a batch of
     *  workflow tickets posted to one channel runs concurrently instead of
     *  queueing behind the conversation's single lane. Off by default: an
     *  ordinary conversation must keep one lane so replies stay ordered. */
    parallelLane?: boolean;
};

const TRUSTED_TRIGGER_KEYS = ['channelId', 'botId', 'userId', 'textMarker'] as const;
const TRUSTED_TRIGGER_ALLOWED_KEYS = new Set<string>([...TRUSTED_TRIGGER_KEYS, 'workflowSkill', 'parallelLane']);
const TRUSTED_TRIGGER_PATTERNS: Record<(typeof TRUSTED_TRIGGER_KEYS)[number], RegExp> = {
    channelId: /^[CG][A-Z0-9]{2,}$/,
    botId: /^B[A-Z0-9]{2,}$/,
    userId: /^[UW][A-Z0-9]{2,}$/,
    textMarker: /^[A-Z][A-Z0-9_]{2,63}$/,
};
const TRUSTED_TRIGGER_MAX = 16;

/**
 * Read the allowance list, or read nothing at all.
 *
 * One malformed rule refuses the whole list. A typo in an inbound-authorization
 * setting has to fail closed: the alternative is a list that half-applies, where
 * the operator sees their rule in the file and cannot tell which half is live.
 */
export function readTrustedBotTriggers(value: unknown): TrustedBotTrigger[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > TRUSTED_TRIGGER_MAX) return [];
    const rules: TrustedBotTrigger[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const row = raw as Record<string, unknown>;
        if (Reflect.ownKeys(row).some(key => typeof key !== 'string' || !TRUSTED_TRIGGER_ALLOWED_KEYS.has(key))) return [];
        for (const key of TRUSTED_TRIGGER_KEYS) {
            if (!Object.hasOwn(row, key)) return [];
            const field = row[key];
            if (typeof field !== 'string' || !TRUSTED_TRIGGER_PATTERNS[key].test(field)) return [];
        }
        let workflowSkill: string | undefined;
        if (Object.hasOwn(row, 'workflowSkill')) {
            const field = row['workflowSkill'];
            // assertSkillId coerces and trims; settings must already be canonical.
            if (typeof field !== 'string') return [];
            try {
                if (assertSkillId(field) !== field) return [];
            } catch {
                return [];
            }
            workflowSkill = field;
        }
        let parallelLane: boolean | undefined;
        if (Object.hasOwn(row, 'parallelLane')) {
            const field = row['parallelLane'];
            if (typeof field !== 'boolean') return [];
            // A lane per message only makes sense for workflow turns; a plain
            // trigger without a skill keeps conversation ordering.
            if (field && workflowSkill === undefined) return [];
            parallelLane = field;
        }
        rules.push({
            channelId: row['channelId'] as string,
            botId: row['botId'] as string,
            userId: row['userId'] as string,
            textMarker: row['textMarker'] as string,
            ...(workflowSkill !== undefined ? { workflowSkill } : {}),
            ...(parallelLane !== undefined ? { parallelLane } : {}),
        });
    }
    return rules;
}

/**
 * Does this event carry an allowance to start a turn even though a bot sent it?
 *
 * Everything a rule names must line up at once: the text mentions this instance,
 * the payload carries a live bot identity that agrees with itself, and some rule
 * matches its channel, bot id, sender id and marker word. Nothing here widens
 * who may be answered — it only lets a named trigger past the bot refusals.
 */
export function matchingTrustedBotTriggers(event: SlackMessageEvent, config: SlackGateConfig): TrustedBotTrigger[] {
    const rules = readTrustedBotTriggers(config.trustedBotTriggers);
    if (rules.length === 0 || !config.selfUserId) return [];
    if (!mentionsUser(event.text || '', config.selfUserId)) return [];
    const botId = event.bot_id || event.bot_profile?.id;
    const userId = event.user || event.bot_profile?.user_id;
    if (!botId || !userId || userId === config.selfUserId || event.bot_profile?.deleted === true) return [];
    // A payload that disagrees with itself names no one, so it matches no rule.
    if ((event.bot_id && event.bot_profile?.id && event.bot_id !== event.bot_profile.id)
        || (event.user && event.bot_profile?.user_id && event.user !== event.bot_profile.user_id)) return [];
    // Whole words only: EXAMPLE_READY_V1X must never satisfy EXAMPLE_READY_V1.
    const words = new Set((event.text || '').split(/\s+/));
    return rules.filter(rule => rule.channelId === event.channel
        && rule.botId === botId && rule.userId === userId && words.has(rule.textMarker));
}

export function matchesTrustedBotTrigger(event: SlackMessageEvent, config: SlackGateConfig): boolean {
    return matchingTrustedBotTriggers(event, config).length > 0;
}

/**
 * One bot, one elected instance. Socket Mode round-robins events across every
 * connection sharing an app token, so only an explicit non-empty port match
 * may attach. The init owner (slack/bot.ts) handles the one-time unset
 * self-election after a socket opens successfully, and channel-health treats
 * the unset case the same way — only an explicit foreign owner is degraded.
 */
export function shouldAttachSlack(attachPort: unknown, currentPort: unknown): boolean {
    const attach = String(attachPort ?? '').trim();
    const current = String(currentPort ?? '').trim();
    return Boolean(attach && current && attach === current);
}

export function stripMention(text: string, userId: string): string {
    return text.replace(new RegExp(`<@${userId}(?:\\|[^>]*)?>`, 'g'), '').trim();
}

/**
 * Allowlist/DM policy, shared by BOTH the message path and the slash-command
 * path. A slash command that skipped this check would be an allowlist bypass:
 * any user in any channel could invoke orchestration.
 */
export function isConversationAllowed(
    conversationId: string,
    channelIds: string[],
    isDm: boolean,
): boolean {
    if (isDm) return true;
    if (!channelIds.length) return true;
    return channelIds.includes(conversationId);
}

/**
 * The allowlist as the gate must read it: trimmed, deduplicated, and never
 * silently widened by a malformed value.
 *
 * An empty list means every conversation, so a non-array — or an array holding
 * non-strings — used to collapse to "allow everything". That is backwards: a
 * value we cannot parse should not hand out MORE access than the one we can.
 * The route rejects such a write, but settings also arrive from the file
 * watcher and from direct runtime patches, and an agent can edit settings.json
 * itself. This is the one place every path passes through (#406).
 *
 * A malformed value is treated as a single unmatchable id, which denies every
 * channel while still letting DMs through — visible immediately, and safe.
 */
export const MALFORMED_SLACK_ALLOWLIST = '\u0000malformed-slack-allowlist';

/**
 * A ceiling on the allowlist. The dedup below is quadratic, and settings reach
 * this reader from the file watcher and direct edits as well as the route, so a
 * bound that lives only in the route does not bind. Measured on this reader:
 * 1k ids ~0.8ms, 10k ~62ms — per event.
 *
 * No Slack workspace allowlists this many conversations on purpose, so a list
 * this long is a mistake, and a mistake must not open access.
 */
export const SLACK_ALLOWLIST_MAX = 1000;

export function readSlackAllowlist(raw: unknown): string[] {
    // `undefined` is absence — the shipped default is an empty list, so nothing
    // was ever configured and every conversation is allowed. `null` is not the
    // same thing: it is a value someone wrote, the route refuses to write it
    // (`invalidSlackChannelIds`), and reading it as "allow everything" is
    // exactly the widening this reader exists to prevent (#406).
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return [MALFORMED_SLACK_ALLOWLIST];
    if (raw.length > SLACK_ALLOWLIST_MAX) return [MALFORMED_SLACK_ALLOWLIST];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') return [MALFORMED_SLACK_ALLOWLIST];
        const id = entry.trim();
        // A padded id matches nothing, so keeping it verbatim would quietly
        // block the channel the operator meant to allow.
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    // A list that named conversations and resolved to none of them is not the
    // empty default. `[""]` would collapse to "every conversation" — a WIDENING
    // from a write the route rejects outright. Dropping blanks beside real ids
    // stays safe because the result still narrows; only an all-blank list has to
    // fail closed (#406).
    if (raw.length > 0 && ids.length === 0) return [MALFORMED_SLACK_ALLOWLIST];
    return ids;
}

export function shouldProcessSlackEvent(
    event: SlackMessageEvent,
    config: SlackGateConfig,
    envelopeType: string,
): SlackGateDecision {
    // Computed once: three refusals below ask the same question, and re-deriving
    // it would let the answer drift between them.
    const trustedTrigger = matchesTrustedBotTrigger(event, config);
    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)
        && !(event.subtype === 'bot_message' && trustedTrigger)) {
        return { process: false, reason: `subtype_${event.subtype}` };
    }
    // Self-echo: our own posts arrive back as message events. Without this the
    // bot answers itself forever.
    if (config.selfUserId && event.user === config.selfUserId) {
        return { process: false, reason: 'self_message' };
    }
    // `bot_id` alone is not the whole bot signal: a granular-permission app can
    // send `bot_profile` without it, and that payload used to walk straight past
    // allowBots:false into an agent run (audit 002 §R2-6).
    if ((event.bot_id || event.bot_profile) && !config.allowBots && !trustedTrigger) {
        return { process: false, reason: 'bot_message' };
    }
    if (!event.channel) {
        return { process: false, reason: 'missing_channel' };
    }

    const dm = isDirectMessage(event);
    if (!isConversationAllowed(event.channel, config.channelIds, dm)) {
        return { process: false, reason: 'channel_not_allowed' };
    }
    // Slack delivers BOTH an app_mention envelope and a message envelope for
    // the same mention when the app subscribes to both (the shipped manifest
    // does). Without this drop, one mention becomes two agent runs within
    // milliseconds and the gateway dedup slams the second with a public
    // "❌ duplicate". The app_mention copy is the canonical path; DMs never
    // produce app_mention envelopes, so they are unaffected.
    // MPIM message events must stand alone; do not wait for an app_mention twin.
    // A trusted trigger keeps its message envelope: the app_mention twin is not
    // guaranteed for a bot post, and the duplicate claim in slack/bot.ts already
    // collapses the pair by (team, channel, ts) when both do arrive.
    if (!trustedTrigger && !dm && event.channel_type !== 'mpim' && event.type !== 'app_mention' && config.selfUserId
        && mentionsUser(event.text || '', config.selfUserId)) {
        return { process: false, reason: 'mention_via_app_mention' };
    }
    // app_mention envelopes are mentions by definition; message events in a
    // channel need the gate. DMs always bypass it.
    if (config.mentionOnly && !dm && event.type !== 'app_mention') {
        if (!config.selfUserId || !mentionsUser(event.text || '', config.selfUserId)) {
            // Thread continuation, but only for a thread the bot itself started:
            // there, its reply is the parent and every follow-up is addressed to
            // it, so re-mentioning would be noise (Hermes thread_require_mention:false semantics).

            // A thread the bot was pulled INTO partway does not qualify. People
            // were already talking there and keep talking to each other; reading
            // one mention as consent for the rest of that conversation is how the
            // bot answered six messages that named other people (#400).
            //
            // Ordering is intentional: the self-echo/bot/allowlist gates above
            // already ran, so a participated thread never bypasses those.
            const inParticipatedThread = !config.threadRequireMention
                && !!event.thread_ts
                && config.threadParticipation(event.channel || '', event.thread_ts) === 'owned';
            if (!inParticipatedThread) {
                return { process: false, reason: 'mention_required' };
            }
        }
    }
    if (envelopeType === 'events_api' && !event.text && !event.blocks?.length && !event.files?.length) {
        return { process: false, reason: 'empty_event' };
    }
    return { process: true };
}

/**
 * Extract readable text from Block Kit blocks.
 * Slack messages forwarded from apps often have an empty `text` with all the
 * content in `blocks`; without this the agent receives an empty prompt.
 *
 * Traversal is ITERATIVE: a deeply nested payload would blow the call stack
 * in a recursive walk, and inbound block structures are attacker-influenced.
 */
export function extractTextFromBlocksDetailed(blocks: unknown[], maxChars = 6000): { text: string; truncated: boolean } {
    const out: string[] = [];
    const seen = new Set<unknown>();
    const stack: unknown[] = blocks.slice(0, 10000).reverse();
    let budget = Math.max(0, maxChars);
    let visited = 0;
    let truncated = blocks.length > 10000;
    while (stack.length > 0 && budget > 0 && visited < 10000) {
        const node = stack.pop();
        visited += 1;
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (Array.isArray(node)) {
            const remaining = Math.max(0, 10000 - stack.length);
            for (let i = Math.min(node.length, remaining) - 1; i >= 0; i--) stack.push(node[i]);
            if (node.length > remaining) truncated = true;
            continue;
        }
        const obj = node as Record<string, unknown>;
        const text = obj['text'];
        const leaf = typeof text === 'string' ? text
            : obj['type'] === 'link' && typeof obj['url'] === 'string' ? obj['url']
            : obj['type'] === 'user' && typeof obj['user_id'] === 'string' ? `<@${obj['user_id']}>`
            : obj['type'] === 'channel' && typeof obj['channel_id'] === 'string' ? `<#${obj['channel_id']}>`
            : obj['type'] === 'emoji' && typeof obj['name'] === 'string' ? `:${obj['name']}:` : '';
        if (leaf) {
            if (leaf.length > budget) truncated = true;
            out.push(leaf.slice(0, budget));
            budget -= Math.min(leaf.length, budget) + 1;
        } else if (text && typeof text === 'object') stack.push(text);
        for (const key of ['rows', 'elements', 'fields', 'blocks']) {
            const value = obj[key];
            if (Array.isArray(value)) {
                const remaining = Math.max(0, 10000 - stack.length);
                for (let i = Math.min(value.length, remaining) - 1; i >= 0; i--) stack.push(value[i]);
                if (value.length > remaining) truncated = true;
            }
        }
    }
    return { text: out.join('\n').slice(0, maxChars).trim(), truncated: truncated || stack.length > 0 };
}

export function extractTextFromBlocks(blocks: unknown[], maxChars = 6000): string {
    return extractTextFromBlocksDetailed(blocks, maxChars).text;
}

/** The prompt text an agent should receive for this event. */
export function resolveEventText(event: SlackMessageEvent, selfUserId: string | null): string {
    let text = (event.text || '').trim();
    if (!text && event.blocks?.length) text = extractTextFromBlocks(event.blocks);
    if (selfUserId) text = stripMention(text, selfUserId);
    return text.trim();
}
