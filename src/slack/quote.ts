import { sanitizeIdentityName } from './identity.js';
import { createHash } from 'node:crypto';
import type { RemoteTarget } from '../messaging/types.js';
import { redactChannelSecrets } from '../messaging/redact.js';
import { slackApi, type SlackCallOptions } from './api.js';
import { readExactSlackMessage, readSlackMessageSnapshot, slackMessageRevision, type SlackMessagePointer } from './message.js';
import { buildSlackBlockPayloads } from './blocks.js';
import { verifiedSlackWorkspace } from './verified-workspace.js';
import { sendSlackText } from './send-only-client.js';
import { slackToolContext, slackToolDenied, withSlackToolAccess, type SlackToolPrincipal } from './tool-access.js';

function enforcedSlackDest(principal: SlackToolPrincipal): RemoteTarget | null {
    if (principal.kind === 'turn') return principal.grant.destination;
    const dest = slackToolContext(principal)?.destination;
    return slackToolContext(principal)?.enforceDestination === true && dest ? dest : null;
}
import { getRtsOutputStore, RTS_OUTPUT_MARKER } from './rts-output-store.js';
import { slackCredentialKey } from './tool-context.js';

export type SlackQuoteInput = { source: SlackMessagePointer; excerpt?: string; summary?: string; destination?: RemoteTarget; expectedAuthorId?: string };
export type SlackQuoteReceipt = { ok: boolean; sent: boolean | 'unknown'; retryable: false; messageTs: string[];
    sourceVerification: 'exact_quote' | 'normalized_quote' | 'references_only' | 'failed'; contentVerification: 'verified' | 'failed'; error?: string };
function quoteContent(blocks: unknown): string {
    let nodes = 0;
    const walk = (value: unknown, depth = 0): unknown => {
        if (++nodes > 1000 || depth > 12) throw slackToolDenied('slack_quote_readback_invalid', 502);
        if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
        if (!value || typeof value !== 'object') throw slackToolDenied('slack_quote_readback_invalid', 502);
        const node = value as Record<string, unknown>;
        if (node['type'] === 'text') return { type: 'text', text: node['text'] };
        if (node['type'] === 'link') return { type: 'link', text: node['text'], url: node['url'] };
        if (['rich_text', 'rich_text_section', 'rich_text_quote'].includes(String(node['type'])) && Array.isArray(node['elements'])) {
            return { type: node['type'], elements: walk(node['elements'], depth + 1) };
        }
        throw slackToolDenied('slack_quote_readback_invalid', 502);
    };
    return JSON.stringify(walk(blocks));
}

/** Explicit text leaves quote source data literally, without mention/Markdown execution. */
export async function publishSlackQuote(token: string, principal: SlackToolPrincipal, input: SlackQuoteInput,
    options: SlackCallOptions & { currentCredential?: () => string | null } = {}, rtsInvocation?: string): Promise<SlackQuoteReceipt> {
    const pinnedDest = enforcedSlackDest(principal);
    const destination = pinnedDest ?? input.destination;
    if (!destination || destination.channel !== 'slack') throw slackToolDenied('slack_quote_destination_required', 400);
    if (pinnedDest && input.destination && (input.destination.targetId !== pinnedDest.targetId
        || (input.destination.threadId ?? '') !== (pinnedDest.threadId ?? ''))) throw slackToolDenied('slack_destination_mismatch');
    const sensitive = { ...options, sensitiveResponse: true };
    return withSlackToolAccess<SlackQuoteReceipt>(token, principal, input.source.channel, async signal => {
        const callOptions = { ...sensitive, ...(signal ? { signal } : {}) };
        const snapshot = await readSlackMessageSnapshot(token, input.source, callOptions);
        if (input.expectedAuthorId && snapshot.message.user !== input.expectedAuthorId) throw slackToolDenied('slack_source_author_changed', 409);
        if (!(typeof snapshot.message.user === 'string' && /^[UW][A-Z0-9]{1,63}$/.test(snapshot.message.user))
            && !(typeof snapshot.message.botId === 'string' && /^B[A-Z0-9]{1,63}$/.test(snapshot.message.botId))) throw slackToolDenied('slack_source_author_unverified', 409);
        if (snapshot.message.edited && !/^\d{1,13}\.\d{1,6}$/.test(snapshot.message.edited.ts)) throw slackToolDenied('slack_source_metadata_unverified', 409);
        const sourceText = snapshot.message.text;
        if (!sourceText) throw slackToolDenied('slack_source_text_unavailable', 409);
        if (input.excerpt !== undefined && !sourceText.includes(input.excerpt)) throw slackToolDenied('slack_quote_not_in_source', 400);
        const selected = input.summary ?? input.excerpt ?? sourceText.slice(0, 2500).replace(/[\uD800-\uDBFF]$/, '');
        const text = redactChannelSecrets(selected);
        const normalized = snapshot.message.textFromBlocks || text !== selected;
        const label = input.summary !== undefined ? '요약 · 원문 링크 확인' : normalized ? '원문에서 읽은 내용' : '직접 인용';
        const excerpt = !input.summary && selected !== sourceText ? ' · 발췌' : '';
        let author = snapshot.message.user ? `사용자 ${snapshot.message.user}` : `봇 ${snapshot.message.botId ?? 'unknown'}`;
        if (snapshot.message.user) {
            const identity = await slackApi<{ user?: { id?: string; name?: string; real_name?: string; profile?: { display_name?: string } } }>(token, 'users.info', { user: snapshot.message.user }, callOptions);
            if (identity.error === 'ratelimited' || identity.error === 'rate_limited') throw slackToolDenied('slack_tool_rate_limited', 429);
            if (identity.ok && identity.data?.user?.id === snapshot.message.user) {
                const name = identity.data.user.profile?.display_name || identity.data.user.real_name || identity.data.user.name;
                if (typeof name === 'string') author = `${sanitizeIdentityName(name, snapshot.message.user)} (${snapshot.message.user})`;
            }
        }
        const when = new Date(Number(snapshot.message.ts) * 1000).toISOString();
        const heading = redactChannelSecrets(`${label}${excerpt} · ${author}\n${when} · ts=${snapshot.message.ts}${snapshot.message.edited ? ` · 수정 ts=${snapshot.message.edited.ts}` : ''}\n원문 확인: ${new Date().toISOString()}`);
        const outputMarker = rtsInvocation ? `${RTS_OUTPUT_MARKER}:${rtsInvocation}` : undefined;
        const blocks = [{ type: 'rich_text', ...(outputMarker ? { block_id: outputMarker } : {}), elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: heading }] },
            { type: input.summary !== undefined ? 'rich_text_section' : 'rich_text_quote', elements: [{ type: 'text', text }] },
            { type: 'rich_text_section', elements: [{ type: 'link', url: snapshot.permalink, text: '원문' }] },
        ] }];
        const current = await readExactSlackMessage(token, input.source, callOptions);
        if (slackMessageRevision(current) !== snapshot.revision) throw slackToolDenied('slack_source_changed', 409);
        await withSlackToolAccess(token, principal, input.source.channel, async () => true, options.fetchImpl, undefined, true);
        if (options.currentCredential && options.currentCredential() !== token) throw slackToolDenied('slack_credential_changed', 409);
        const store = rtsInvocation ? getRtsOutputStore() : null;
        if (rtsInvocation && (!store || principal.kind !== 'turn')) throw slackToolDenied('slack_rts_privacy_unavailable', 503);
        const teamId = principal.kind === 'turn' ? principal.grant.teamId : '';
        let rtsPayload: ReturnType<typeof buildSlackBlockPayloads>[number] | undefined;
        let publisherBot: string | undefined;
        if (rtsInvocation) {
            if (!/^[A-Za-z0-9:_-]{1,64}$/.test(rtsInvocation)) throw slackToolDenied('slack_rts_invocation_invalid', 400);
            const prepared = buildSlackBlockPayloads('원문을 확인한 인용을 전달했습니다.', blocks);
            if (prepared.length !== 1 || Buffer.byteLength(JSON.stringify(prepared[0])) > 65536 || text.length > 9000) throw slackToolDenied('slack_rts_single_payload_required', 400);
            rtsPayload = prepared[0];
            const identity = await verifiedSlackWorkspace(token, { ...callOptions, refresh: true });
            if (identity?.teamId !== teamId || !identity.userId) throw slackToolDenied('slack_rts_publisher_unverified', 403);
            publisherBot = identity.userId;
            if (options.currentCredential && options.currentCredential() !== token) throw slackToolDenied('slack_credential_changed', 409);
            if (signal?.aborted) throw slackToolDenied('slack_rts_publisher_cancelled', 409);
        }
        // A hold is created only after the source reread; normal source access cannot mask itself.
        if (rtsInvocation && !store!.begin(teamId, destination.targetId, rtsInvocation, { threadTs: destination.threadId ?? null, expectedOutputs: 1, actor: principal.kind === 'turn' ? principal.grant.actorId : '', botUserId: publisherBot!, credentialKey: slackCredentialKey(token) })) throw slackToolDenied('slack_rts_publication_pending', 409);
        const lease = rtsInvocation ? store!.publication(teamId, destination.targetId, rtsInvocation)!.lease : undefined;
        let contentVerified = false;
        let sent: boolean | 'unknown' = 'unknown';
        const messageTs: string[] = [];
        try {
            // RTS owns exactly one direct POST; the ordinary quote path retains its renderer/retry policy.
            const result = rtsInvocation ? await (async () => {
                const posted = await slackApi<{ ts?: string }>(token, 'chat.postMessage', {
                    channel: destination.targetId, ...rtsPayload!, ...(destination.threadId ? { thread_ts: destination.threadId } : {}),
                }, callOptions);
                return { ok: posted.ok, ts: posted.data?.ts, sent: posted.ok };
            })() : await sendSlackText(token, destination, '원문을 확인한 인용을 전달했습니다.', { ...callOptions, blocks });
            const ids = ('delivery' in result ? result.delivery?.messageTs : undefined) ?? (result.ts ? [result.ts] : []);
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^\d{1,13}\.\d{1,6}$/.test(id))) { sent = 'unknown'; throw new Error('slack_quote_output_id_invalid'); }
            sent = ids.length > 0 && (result.ok || result.sent === true) ? true : 'unknown';
            messageTs.push(...ids);
            if (store) for (const id of ids) store.record(teamId, destination.targetId, id);
            if (!result.ok || ids.length !== 1) return { ok: false, sent, retryable: false, messageTs, sourceVerification: 'failed', contentVerification: 'failed', error: 'slack_quote_delivery_unverified' };
            const readback = await slackApi<{ messages?: Array<{ ts?: string; blocks?: unknown; user?: string; thread_ts?: string }> }>(token,
                destination.threadId ? 'conversations.replies' : 'conversations.history', {
                    channel: destination.targetId, ...(destination.threadId ? { ts: destination.threadId } : {}),
                    oldest: ids[0], latest: ids[0], inclusive: true, limit: 2,
                }, { ...callOptions, form: true });
            const matches = Array.isArray(readback.data?.messages) ? readback.data.messages.filter(message => message?.ts === ids[0]) : [];
            const saved = matches.length === 1 ? matches[0] : undefined;
            const marker = !rtsInvocation || (Array.isArray(saved?.blocks) && saved.blocks.some(block => block?.block_id === outputMarker));
            const owned = !rtsInvocation || (!!saved && saved.user === publisherBot && (destination.threadId ? saved.thread_ts === destination.threadId : !saved.thread_ts || saved.thread_ts === saved.ts));
            if (!readback.ok || !saved || !marker || !owned || quoteContent(saved.blocks) !== quoteContent(blocks)) {
                return { ok: false, sent: true, retryable: false, messageTs, sourceVerification: 'failed', contentVerification: 'failed', error: 'slack_quote_content_mismatch' };
            }
            if (signal?.aborted) return { ok: false, sent: true, retryable: false, messageTs, sourceVerification: 'failed', contentVerification: 'verified', error: 'slack_quote_cancelled_after_send' };
            contentVerified = true;
            return { ok: true, sent: true, retryable: false, messageTs,
                sourceVerification: input.summary !== undefined ? 'references_only' : normalized ? 'normalized_quote' : 'exact_quote', contentVerification: 'verified' };
        } catch {
            return { ok: false, sent, retryable: false, messageTs, sourceVerification: 'failed', contentVerification: 'failed', error: 'slack_quote_publication_unknown' };
        } finally {
            if (store && rtsInvocation && lease) {
                try {
                    store.terminal(teamId, destination.targetId, rtsInvocation, lease, messageTs, contentVerified);
                    if (contentVerified) store.finish(teamId, destination.targetId, rtsInvocation);
                } catch {
                    // A failed terminal write deliberately leaves the durable destination hold.
                    return { ok: false, sent, retryable: false, messageTs, sourceVerification: 'failed', contentVerification: 'failed', error: 'slack_rts_terminal_unrecorded' };
                }
            }
        }
    }, options.fetchImpl, receipt => ({ ...receipt, ok: false, retryable: false, error: 'slack_quote_cancelled_after_dispatch' }), true);
}

type Invocation = { hash: string; receipt?: unknown; pending: boolean };
const turnInvocations = new WeakMap<object, Map<string, Invocation>>();
/** No source bodies/results stored: only a request digest and publication receipt. */
export async function runSlackQuoteInvocation<T>(token: string, principal: SlackToolPrincipal, id: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (principal.kind === 'operator') {
        const store = getRtsOutputStore();
        if (!store) throw slackToolDenied('slack_quote_store_unavailable', 503);
        const owner = slackCredentialKey(token);
        const previous = store.quoteOperation(owner, id);
        if (previous) {
            if (previous.request_hash !== hash || previous.status !== 'completed' || !previous.receipt_json) throw slackToolDenied('slack_invocation_conflict_or_unknown', 409);
            try { return JSON.parse(previous.receipt_json) as T; } catch { throw slackToolDenied('slack_invocation_receipt_invalid', 409); }
        }
        if (!store.reserveQuote(owner, id, hash)) throw slackToolDenied('slack_invocation_capacity', 429);
        try { const receipt = await run(); store.settleQuote(owner, id, receipt); return receipt; }
        catch (error) { store.settleQuote(owner, id); throw error; }
    }
    const key = id;
    const map = turnInvocations.get(principal.grant) ?? new Map<string, Invocation>();
    turnInvocations.set(principal.grant, map);
    const existing = map.get(key);
    if (existing) {
        if (existing.hash !== hash || existing.pending || existing.receipt === undefined) throw slackToolDenied('slack_invocation_conflict_or_unknown', 409);
        return existing.receipt as T;
    }
    if (map.size >= 64) throw slackToolDenied('slack_invocation_capacity', 429);
    const record: Invocation = { hash, pending: true };
    map.set(key, record);
    try { const result = await run(); record.receipt = result; record.pending = false; return result; }
    catch (error) { record.pending = false; throw error; }
}
