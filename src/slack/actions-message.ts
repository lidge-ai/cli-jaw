import { compareSlackMessageContent } from './message-content.js';
import { defineAction, type ActionContext, type ActionBase } from './action-types.js';
import { baseAction, messageTs, requiredText } from './task-input.js';
import { buildSlackBlockPayloads, type SlackTextPayload } from './blocks.js';
import { getRtsOutputStore, isRtsOutput } from './rts-output-store.js';
import { slackToolDenied } from './tool-access.js';

type MessageArgs = ActionBase & { ts: string; threadTs?: string; payload?: SlackTextPayload };
type RawMessage = { contentExcluded?: boolean; ts?: string; user?: string; text?: string; blocks?: unknown; attachments?: unknown; files?: unknown; thread_ts?: string; subtype?: string };
const reads = ['conversations.history', 'conversations.replies', 'conversations.info'];
function parseMessage(raw: Record<string, unknown>, update: boolean): MessageArgs {
    const base = baseAction(raw, ['ts', 'threadTs', ...(update ? ['text', 'blocks'] : [])], true);
    const threadTs = raw['threadTs'] === undefined ? undefined : messageTs(raw['threadTs']);
    let payload: SlackTextPayload | undefined;
    if (update) {
        const parts = buildSlackBlockPayloads(requiredText(raw['text'], 1048576), raw['blocks']);
        if (parts.length !== 1) throw slackToolDenied('message_update_requires_single_payload', 400);
        payload = parts[0]!;
        if (isRtsOutput(payload.blocks)) throw slackToolDenied('rts_update_denied', 403);
    }
    return { ...base, ts: messageTs(raw['ts']), ...(threadTs ? { threadTs } : {}), ...(payload ? { payload } : {}) };
}
async function lookup(ctx: ActionContext, args: MessageArgs): Promise<{ known: boolean; message?: RawMessage }> {
    const res = await ctx.api<{ messages?: RawMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
        args.threadTs ? 'conversations.replies' : 'conversations.history', {
            channel: args.channel, ...(args.threadTs ? { ts: args.threadTs } : {}), oldest: args.ts, latest: args.ts, inclusive: true, limit: 100,
        });
    if (!res.ok || !Array.isArray(res.data?.messages)) return { known: false };
    const matches = res.data.messages.filter(m => m.ts === args.ts);
    if (matches.length > 1) return { known: false };
    if (matches[0]) return { known: true, message: matches[0] };
    return { known: res.data.has_more === false && !res.data.response_metadata?.next_cursor };
}
async function modify(ctx: ActionContext, args: MessageArgs, update: boolean) {
    const before = await lookup(ctx, args);
    if (!before.known || !before.message) return ctx.fail('message_owner_unverified', 403);
    if (before.message.user !== ctx.botUserId) return ctx.fail('message_not_bot_owned', 403);
    if (update) {
        if (before.message.contentExcluded === true) return ctx.fail('rts_update_denied', 403);
        const store = getRtsOutputStore();
        if (!store) return ctx.fail('slack_privacy_store_unavailable', 503);
        if (store.held(ctx.workspace, args.channel) || store.contains(ctx.workspace, args.channel, args.ts) || isRtsOutput(before.message.blocks)) return ctx.fail('rts_update_denied', 403);
    }
    let response;
    try {
        response = await ctx.api(update ? 'chat.update' : 'chat.delete', {
            channel: args.channel, ts: args.ts, ...(update ? { ...args.payload, blocks: args.payload?.blocks ?? [] } : {}),
        });
    } catch { return ctx.result('unknown', { reason: 'message_write_unconfirmed' }, [args.ts]); }
    if (!response.ok) return ctx.fail(response.error ?? 'message_write_unconfirmed', response.status, [args.ts]);
    let after;
    try { after = await lookup(ctx, args); }
    catch { return ctx.result('unknown', { reason: 'message_readback_unavailable' }, [args.ts]); }
    if (!after.known) return ctx.result('unknown', { reason: 'message_readback_unavailable' }, [args.ts]);
    if (update) {
        if (after.message?.contentExcluded === true) return ctx.result('unknown', { reason: 'message_readback_excluded' }, [args.ts]);
        const content = after.message?.user !== ctx.botUserId ? 'failed'
            : compareSlackMessageContent(args.payload!, after.message);
        return ctx.result(content, { channel: args.channel, ts: args.ts, content: content === 'verified' ? 'verified' : content === 'partial' ? 'not_checked' : 'mismatch' }, [args.ts]);
    }
    // Slack can retain a root placeholder after a successful deletion. Only
    // the explicit tombstone subtype proves removal; text/user heuristics do not.
    if (after.message && after.message.subtype !== 'tombstone') return ctx.result('failed', { deleted: false }, [args.ts]);
    const membership = await ctx.api<{ channel?: { is_member?: boolean; is_im?: boolean; is_mpim?: boolean } }>('conversations.info', { channel: args.channel });
    // Runtime admission checks requester membership; this proves the bot still sees the destination.
    const current = membership.ok && (membership.data?.channel?.is_member === true || membership.data?.channel?.is_im === true);
    return ctx.result(current ? 'verified' : 'unknown', { deleted: current ? true : null }, [args.ts]);
}

export const messageActions = [
    ...(['add', 'remove', 'get'] as const).map(kind => defineAction({
        operation: `reaction.${kind}`, scopes: kind === 'get' ? ['reactions:read'] : ['reactions:write', 'reactions:read'],
        methods: kind === 'get' ? ['reactions.get'] : [`reactions.${kind}`, 'reactions.get'], mutates: kind !== 'get',
        parse(raw) {
            const base = baseAction(raw, ['ts', ...(kind === 'get' ? [] : ['name'])], kind !== 'get');
            const name = kind === 'get' ? undefined : requiredText(raw['name'], 128);
            if (name && !/^[a-zA-Z0-9_+\-]+(?:::(?:skin-tone-[2-6]))?$/.test(name)) throw slackToolDenied('invalid_reaction_name', 400);
            return { ...base, ts: messageTs(raw['ts']), name };
        },
        async execute(ctx, args) {
            if (kind !== 'get') {
                const res = await ctx.api(`reactions.${kind}`, { channel: args.channel, timestamp: args.ts, name: args.name });
                if (!res.ok && res.error !== (kind === 'add' ? 'already_reacted' : 'no_reaction')) return ctx.result('unknown', { reason: 'reaction_write_unconfirmed' }, [args.ts]);
            }
            const res = await ctx.api<{ type?: string; message?: { ts?: string; reactions?: Array<{ name: string; count: number; users: string[] }> } }>('reactions.get', { channel: args.channel, timestamp: args.ts, full: true });
            if (!res.ok || res.data?.type !== 'message' || res.data.message?.ts !== args.ts) return ctx.result('unknown', { reason: 'reaction_readback_unavailable' }, [args.ts]);
            const reactions = res.data.message.reactions ?? [];
            if (!Array.isArray(reactions) || reactions.some(r => typeof r.name !== 'string' || !Number.isSafeInteger(r.count) || r.count < 0 || !Array.isArray(r.users) || r.users.some(u => typeof u !== 'string'))) return ctx.result('unknown', { reason: 'reaction_readback_invalid' }, [args.ts]);
            const safe = reactions.map(r => ({ name: r.name, count: r.count, ownBot: r.users.includes(ctx.botUserId), usersComplete: new Set(r.users).size === r.count }));
            const own = safe.some(r => r.name === args.name && r.ownBot);
            return ctx.result(kind === 'get' || own === (kind === 'add') ? 'verified' : 'failed', { channel: args.channel, ts: args.ts, reactions: safe }, [args.ts]);
        },
    })),
    ...(['update', 'delete'] as const).map(kind => defineAction({
        operation: `message.${kind}`, scopes: ['chat:write'], methods: [...reads, `chat.${kind}`], mutates: true,
        parse: raw => parseMessage(raw, kind === 'update'), execute: (ctx, args) => modify(ctx, args, kind === 'update'),
    })),
];
