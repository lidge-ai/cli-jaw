import { slackDataForAgent } from './history.js';
import { getRtsOutputStore, isRtsOutput } from './rts-output-store.js';
import { createHash } from 'node:crypto';
import { SlackActionStore } from './action-store.js';
import type { ActionContext, ActionDefinition, ActionResult } from './action-types.js';
import { SlackActionRateLimiter } from './action-rate.js';
import { slackApi, addSlackReaction, removeSlackReaction, deleteSlackMessage, readBoundedResponse, type SlackFetch, type SlackApiResult } from './api.js';
import { readSlackAuthSnapshot } from './verified-workspace.js';
import { slackCredentialKey } from './tool-context.js';
import { slackToolContext, slackToolDenied, withSlackToolAccess, type SlackToolPrincipal } from './tool-access.js';
import type { RemoteTarget } from '../messaging/types.js';

function enforcedSlackDest(principal: SlackToolPrincipal): RemoteTarget | null {
    if (principal.kind === 'turn') return principal.grant.destination;
    const dest = slackToolContext(principal)?.destination;
    return slackToolContext(principal)?.enforceDestination === true && dest ? dest : null;
}
import { redactOutboundPayload } from '../messaging/redact.js';
import { validateSlackDownloadUrl, type SlackInboundUrlOptions } from './inbound-url.js';
const WRITE_METHODS = new Set(['reactions.add','reactions.remove','chat.update','chat.delete','chat.postMessage','chat.scheduleMessage','chat.deleteScheduledMessage','pins.add','pins.remove','bookmarks.add','bookmarks.edit','bookmarks.remove','canvases.create','canvases.edit','canvases.access.set','slackLists.create','slackLists.items.create','slackLists.items.update','slackLists.access.set']);
const SAFE_ERRORS = new Set(['missing_scope','invalid_auth','not_authed','not_in_channel','channel_not_found','message_not_found','invalid_scheduled_message_id','already_reacted','no_reaction','not_pinned','already_pinned','bookmark_not_found','invalid_arguments','invalid_name','permission_denied','restricted_action','list_not_found','row_not_found','canvas_not_found']);
export type ActionRuntimeOptions = { getToken(): string | null; store: SlackActionStore; fetchImpl?: SlackFetch; rateLimiter?: SlackActionRateLimiter; inboundReady?: () => boolean; evidenceSource: 'slack_api' | 'fixture'; resolveHost?: SlackInboundUrlOptions['resolveHost']; now?: () => number };
export class SlackActionRuntime {
    private readonly rate: SlackActionRateLimiter;
    constructor(private readonly options: ActionRuntimeOptions) { this.rate = options.rateLimiter ?? new SlackActionRateLimiter(); }
    async execute(definition: ActionDefinition, raw: Record<string, unknown>, principal: SlackToolPrincipal, requestSignal?: AbortSignal): Promise<ActionResult> {
        const pinnedDest = enforcedSlackDest(principal);
        if (pinnedDest && definition.mutates) {
            const thread = pinnedDest.threadId ?? '';
            if (raw['threadTs'] !== undefined && raw['threadTs'] !== thread) throw slackToolDenied('slack_destination_thread_mismatch');
            if (['schedule.create', 'schedule.update', 'interaction.url', 'interaction.choice'].includes(definition.operation) && thread) raw = { ...raw, threadTs: thread };
        }
        const prepared = definition.prepare(raw); const args = prepared.args;
        const token = this.options.getToken();
        if (!token) throw slackToolDenied('slack_unavailable', 503);
        if (definition.requiresInbound && !this.options.inboundReady?.()) throw slackToolDenied('slack_interaction_inbound_unavailable', 409);
        if (definition.mutates && !args.invocationId) throw slackToolDenied('slack_invocation_required', 400);
        if (definition.mutates && pinnedDest && args.channel !== pinnedDest.targetId) throw slackToolDenied('slack_destination_mismatch');
        const identity = await readSlackAuthSnapshot(token, { ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}), ...(requestSignal ? { signal: requestSignal } : {}) });
        if (!identity?.userId) throw slackToolDenied('slack_bot_identity_unverified', 409);
        if (definition.scopes.length && identity.scopes === null) throw slackToolDenied('slack_action_scopes_unverified', 403);
        if (definition.scopes.some(scope => !identity.scopes?.includes(scope))) throw slackToolDenied('slack_action_scopes_missing', 403);
        const workspace = identity.teamId; const actor = principal.kind === 'turn' ? principal.grant.actorId : 'operator';
        const credentialKey = slackCredentialKey(token); const store = this.options.store;
        const hash = createHash('sha256').update(JSON.stringify({ credentialKey, operation: definition.operation, args: prepared.canonical })).digest('hex');
        const existing = definition.mutates ? store.invocation(workspace, actor, args.invocationId!) : undefined;
        const ids = new Set<string>(); let dispatched = false;
        const base = (verification: ActionResult['verification'], data?: unknown, resourceIds: string[] = [...ids]): ActionResult => {
            const projected = data === undefined ? undefined : slackDataForAgent(data);
            const state = projected?.truncated && verification === 'verified' ? 'partial' : verification;
            return { ok: state === 'verified', operation: definition.operation, verification: state, retryable: false, resourceIds,
                ...(projected ? { data: projected.value } : {}), ...(state === 'partial' ? { partial: true } : {}) };
        };
        return withSlackToolAccess(token, principal, args.channel, async grantSignal => {
            const signal = requestSignal ? (grantSignal ? AbortSignal.any([requestSignal, grantSignal]) : requestSignal) : grantSignal;
            const checkCurrent = () => {
                if (signal?.aborted) throw slackToolDenied('slack_action_cancelled', 499);
                if (this.options.getToken() !== token) throw slackToolDenied('slack_credential_changed', 409);
            };
            checkCurrent();
            if (principal.kind === 'turn' && /^(canvas|list)\./.test(definition.operation)) {
                // File ACLs describe the requester, not every recipient in a group.
                // Until a complete audience ACL proof is available, resource tools
                // run only in the freshly verified requester/bot DM.
                const conversation = await slackApi<{ channel?: { id?: string; is_im?: boolean; user?: string } }>(token, 'conversations.info', { channel: args.channel }, {
                    ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}), ...(signal ? { signal } : {}), sensitiveResponse: true, form: true,
                });
                checkCurrent();
                if (!conversation.ok || conversation.data?.channel?.id !== args.channel || conversation.data.channel.is_im !== true
                    || conversation.data.channel.user !== actor) throw slackToolDenied('slack_resource_requester_dm_required');
            }
            if (existing) {
                if (existing.request_hash !== hash || !['completed','failed'].includes(existing.status) || !existing.receipt_json) throw slackToolDenied('slack_invocation_conflict_or_unknown', 409);
                const receipt: unknown = JSON.parse(existing.receipt_json);
                if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw slackToolDenied('slack_invocation_receipt_invalid', 409);
                return receipt as ActionResult;
            }
            if (definition.mutates && !store.reserve(workspace, actor, args.invocationId!, hash)) throw slackToolDenied('slack_invocation_capacity_or_conflict', 409);
            let calls = 0;
            const context: ActionContext = {
                token, workspace, botUserId: identity.userId!, actor, channel: args.channel, credentialKey, operator: principal.kind === 'operator', ...(signal ? { signal } : {}),
                checkCurrent, now: this.options.now ?? (() => Date.now()),
                api: async <T>(method: string, body: Record<string, unknown>, beforeDispatch?: () => void | Promise<void>): Promise<SlackApiResult<T>> => {
                    checkCurrent();
                    if (!definition.methods.includes(method) || ++calls > 100 || (WRITE_METHODS.has(method) && !definition.mutates)) throw slackToolDenied('slack_action_method_contract', 500);
                    for (const key of ['channel', 'channel_id']) if (body[key] !== undefined && body[key] !== args.channel) throw slackToolDenied('slack_action_target_contract', 400);
                    if (Array.isArray(body['channel_ids']) && body['channel_ids'].some(value => value !== args.channel)) throw slackToolDenied('slack_action_target_contract', 400);
                    await this.rate.admit(workspace, method, signal); checkCurrent();
                    if (WRITE_METHODS.has(method)) {
                        if (pinnedDest) {
                            const thread = pinnedDest.threadId ?? '';
                            if (['chat.postMessage', 'chat.scheduleMessage'].includes(method)) {
                                if (body['thread_ts'] !== undefined && body['thread_ts'] !== thread) throw slackToolDenied('slack_destination_thread_mismatch');
                                body = { ...body, ...(thread ? { thread_ts: thread } : {}) };
                            }
                            const protectedResource = method === 'chat.update' || method === 'chat.delete' ? ['message', body['ts']]
                                : method === 'bookmarks.edit' || method === 'bookmarks.remove' ? ['bookmark', body['bookmark_id']]
                                : method === 'pins.remove' ? ['pin', body['timestamp']] : undefined;
                            if (protectedResource) {
                                const owned = context.resource(protectedResource[0] as string, String(protectedResource[1]));
                                if (!owned || owned.status !== 'active' || owned.credentialKey !== credentialKey) throw slackToolDenied('slack_resource_ownership_unverified');
                            }
                        }
                        await withSlackToolAccess(token, principal, args.channel, async () => true, this.options.fetchImpl, undefined, true);
                        if (beforeDispatch) await beforeDispatch();
                        checkCurrent(); store.dispatched(workspace, actor, args.invocationId!); dispatched = true;
                    }
                    if (!WRITE_METHODS.has(method) && beforeDispatch) { await beforeDispatch(); checkCurrent(); }
                    const options = { ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}), ...(signal ? { signal } : {}), sensitiveResponse: true, maxResponseBytes: 1048576, timeoutMs: 10000 };
                    const result = method === 'reactions.add' ? await addSlackReaction(token, String(body['channel']), String(body['timestamp']), String(body['name']), options)
                        : method === 'reactions.remove' ? await removeSlackReaction(token, String(body['channel']), String(body['timestamp']), String(body['name']), options)
                        : method === 'chat.delete' ? await deleteSlackMessage(token, String(body['channel']), String(body['ts']), options)
                        : await slackApi<T>(token, method, body, { ...options, form: !WRITE_METHODS.has(method) && !method.startsWith('slackLists.') });
                    if (result.ok && WRITE_METHODS.has(method) && result.data && typeof result.data === 'object') {
                        const data = result.data as Record<string, unknown>;
                        const nestedId = (value: unknown) => value && typeof value === 'object' ? (value as Record<string, unknown>)['id'] : undefined;
                        for (const id of [data['ts'], data['scheduled_message_id'], data['canvas_id'], data['list_id'], nestedId(data['bookmark']), nestedId(data['item'])]) {
                            if ((typeof id === 'string' || typeof id === 'number') && /^[A-Za-z0-9_.:-]{1,128}$/.test(String(id))) ids.add(String(id));
                        }
                    }
                    if (result.ok && principal.kind === 'turn') {
                        const data = result.data as Record<string, unknown> | undefined;
                        if (method === 'chat.postMessage' && typeof data?.['ts'] === 'string') context.remember('message', data['ts']);
                        if (method === 'pins.add' && typeof body['timestamp'] === 'string') context.remember('pin', body['timestamp']);
                    }
                    if (!WRITE_METHODS.has(method)) checkCurrent();
                    if (result.error === 'ratelimited' || result.error === 'rate_limited') throw Object.assign(slackToolDenied('slack_action_rate_limited', 429), { retryAfterMs: result.retryAfterMs });
                    if (!WRITE_METHODS.has(method) && definition.operation !== 'rts.reconcile' && result.data !== undefined) return { ...result, data: maskRtsActionMessages(workspace, args.channel, result.data) as T };
                    return result as SlackApiResult<T>;
                },
                remember(kind, id, metadata = {}) {
                    ids.add(id); store.remember({ workspace, kind, id, actor, channel: args.channel, botUserId: identity.userId!, credentialKey, metadata: redactOutboundPayload({ ...metadata, ...(pinnedDest ? { threadTs: pinnedDest.threadId ?? '' } : {}) }) });
                },
                resource(kind, id) {
                    const row = store.resource(workspace, kind, id);
                    if (!row || row.channel !== args.channel || row.botUserId !== identity.userId || (principal.kind !== 'operator' && row.actor !== actor)) return undefined;
                    if (pinnedDest && (row.metadata['threadTs'] ?? '') !== (pinnedDest.threadId ?? '')) return undefined;
                    if (kind === 'schedule' && row.credentialKey !== credentialKey) throw slackToolDenied('slack_schedule_credential_changed', 409);
                    return row;
                },
                resources: kind => store.resources(workspace, kind, args.channel, principal.kind === 'operator' ? undefined : actor).filter(row => row.botUserId === identity.userId),
                retire(kind, id) { if (!context.resource(kind, id)) throw slackToolDenied('slack_resource_ownership_unverified'); store.retire(workspace, kind, id); ids.add(id); },
                download: async url => {
                    let next = url;
                    for (let hop = 0; hop <= 3; hop++) {
                        checkCurrent(); const safe = await validateSlackDownloadUrl(next, this.options.resolveHost ? { resolveHost: this.options.resolveHost } : {}); checkCurrent();
                        const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
                        const response = await (this.options.fetchImpl ?? fetch)(safe, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: downloadSignal });
                        if (response.status >= 300 && response.status < 400) {
                            const location = response.headers.get('location'); void response.body?.cancel().catch(() => {});
                            if (!location) throw slackToolDenied('slack_download_redirect_invalid', 502); next = new URL(location, safe).href; continue;
                        }
                        if (!response.ok) throw slackToolDenied('slack_download_failed', 502);
                        const content = await readBoundedResponse(response, 1048576, downloadSignal); checkCurrent();
                        return { content: redactOutboundPayload(content), contentType: response.headers.get('content-type') ?? '' };
                    }
                    throw slackToolDenied('slack_download_redirect_limit', 502);
                },
                result: base,
                fail: (code, status = 409, resourceIds = [...ids]) => ({ ...base(dispatched ? 'unknown' : 'failed', undefined, resourceIds), error: code, status: status >= 400 && status <= 599 ? status : 502 }),
            };
            let result: ActionResult;
            try { result = await prepared.execute(context); checkCurrent(); }
            catch (error) {
                const code = (error as { code?: string }).code;
                result = { ...base(dispatched ? 'unknown' : 'failed'), error: typeof code === 'string' && (code.startsWith('slack_') || SAFE_ERRORS.has(code)) ? code : 'slack_action_failed', status: (error as { statusCode?: number }).statusCode ?? 502 };
            }
            if (definition.mutates && Buffer.byteLength(JSON.stringify(result)) > 15000) {
                // Durable replay must retain acknowledged addresses even when a
                // provider's readback is larger than the receipt budget.
                result = { ...result, ok: false, verification: result.verification === 'verified' ? 'partial' : result.verification,
                    partial: true, data: { omitted: true, reason: 'receipt_byte_limit' } };
            }
            if (result.verification === 'verified' && this.options.evidenceSource === 'slack_api') store.recordVerified(workspace, credentialKey, definition.operation);
            if (definition.mutates) store.finish(workspace, actor, args.invocationId!, result.verification === 'unknown' || result.verification === 'partial' ? 'unknown' : result.ok ? 'completed' : 'failed', result);
            return result;
        }, this.options.fetchImpl, result => ({ ...result, ok: false, verification: 'unknown', error: 'slack_action_cancelled_after_dispatch' }), true);
    }
}

function maskRtsActionMessages(workspace: string, channel: string, value: unknown, depth = 0): unknown {
    if (depth > 16) throw slackToolDenied('slack_action_response_depth', 502);
    if (Array.isArray(value)) return value.map(item => maskRtsActionMessages(workspace, channel, item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const item = value as Record<string, unknown>; const store = getRtsOutputStore();
    if (typeof item['ts'] === 'string' && (!store || isRtsOutput(item['blocks']) || store.held(workspace, channel) || store.contains(workspace, channel, item['ts']))) {
        return { ts: item['ts'], user: item['user'], bot_id: item['bot_id'], reactions: item['reactions'], contentExcluded: true, text: '[검색 응답 내용 제외]', blocks: [] };
    }
    return Object.fromEntries(Object.entries(item).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, child]) => [key, maskRtsActionMessages(workspace, channel, child, depth + 1)]));
}
