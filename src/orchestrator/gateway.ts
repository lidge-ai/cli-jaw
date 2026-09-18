// ─── submitMessage gateway ──────────────────────────
// Unified message submission for all interfaces (WebUI, REST, Telegram).
// Replaces duplicated intent/queue/orchestrate logic in server.ts + bot.ts.

import { randomUUID } from 'node:crypto';
import { getCurrentMainMeta, hasActiveMainReplacement, isAgentBusy, enqueueMessage, killActiveAgent, messageQueue, purgeQueueOnStop, steerAgent } from '../agent/spawn.js';
import { hasBlockingWorkers } from './worker-registry.js';
import { getSession, insertMessage } from '../core/db.js';
import { resolveMainCli, type MainSessionRecord } from '../core/main-session.js';
import { isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import { getActiveChatSession, getSessionRunPolicy, isActiveRunPolicy, resolveOrCreateRemoteSession, type ActiveRunPolicy } from '../core/chat-sessions.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { broadcast } from '../core/bus.js';
import { withSessionScope } from '../core/session-context.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { getState } from './state-machine.js';
import { channelGateOn, resolveOrcScope } from './scope.js';
import { isRemoteTarget, type RuntimeOrigin, type RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey, normalizedThreadId, type SessionScope } from '../messaging/session-key.js';
import { sessionLanes } from './session-lanes.js';
import { admitRequest, settleOnce } from './request-registry.js';
import { beginSteerInput } from '../agent/steer-input-guard.js';
import type { SlackWorkflowMetadata } from '../slack/workflow.js';
import { sameRunConversation } from '../messaging/run-pin.js';

export type SubmitResult = {
    action: 'started' | 'queued' | 'rejected';
    disposition?: 'new_run' | 'steered';
    reason?: string;
    pending?: number;
    requestId?: string;
    sessionContext?: { scope: string; chatSessionId: string; remoteKey?: string };
    /** Queue item id (only present when action === 'queued') — lets clients
     * tag their optimistic bubble with `data-queued-id` so applyQueuedOverlay's
     * dedup catches it instead of rendering a duplicate. */
    queuedId?: string;
    // backward-compat for REST consumers (chat.js expects these)
    queued?: true;
    continued?: true;
    noPendingContinue?: true;
};

export function publicSubmitResult(result: SubmitResult): SubmitResult {
    const { disposition: _disposition, ...publicResult } = result;
    return publicResult;
}

type SubmitMeta = {
    slackWorkflow?: SlackWorkflowMetadata;
    onAdmitted?: (binding: { requestId: string; scope: string; chatSessionId: string }) => void;
    origin: RuntimeOrigin;
    displayText?: string;
    skipOrchestrate?: boolean;
    ownedExecution?: true;
    target?: RemoteTarget;
    chatId?: string | number;
    scope?: string;
    chatSessionId?: string;
    remoteKey?: string;
    overrides?: { cli?: string; model?: string; effort?: string; systemPrompt?: string };
    replyViaTarget?: boolean;
    external?: boolean;
    midRunPolicy?: ActiveRunPolicy;
    /** Salvaged partial output of a steer-interrupted turn (kill-path callers). */
    _steerContext?: string;
};

function resolveMidRunPolicy(meta: SubmitMeta, chatSessionId: string): ActiveRunPolicy {
    if (isActiveRunPolicy(meta.midRunPolicy)) return meta.midRunPolicy;
    const sessionPolicy = getSessionRunPolicy(chatSessionId);
    if (sessionPolicy) return sessionPolicy;
    const configured = settings["multiSession"]?.midRunPolicy;
    return isActiveRunPolicy(configured) ? configured : 'steer';
}

function applyMidRunPolicy(
    policy: ActiveRunPolicy,
    ctx: { scopeKey: string; chatSessionId: string; text: string; meta: SubmitMeta; requestId: string; remoteKey?: string },
): SubmitResult {
    const sessionContext = {
        scope: ctx.scopeKey,
        chatSessionId: ctx.chatSessionId,
        ...(ctx.remoteKey ? { remoteKey: ctx.remoteKey } : {}),
    };
    const queue = (extra?: { collect?: boolean; front?: boolean }): SubmitResult => {
        const queuedId = enqueueMessage(ctx.text, ctx.meta.origin, stripUndefined({
            target: ctx.meta.target,
            chatId: ctx.meta.chatId,
            requestId: ctx.requestId,
            scope: ctx.scopeKey,
            chatSessionId: ctx.chatSessionId,
            ...(ctx.remoteKey ? { remoteKey: ctx.remoteKey } : {}),
            overrides: ctx.meta.overrides,
            replyViaTarget: ctx.meta.replyViaTarget,
            slackWorkflow: ctx.meta.slackWorkflow,
            ...extra,
        }));
        return { action: 'queued', pending: messageQueue.length, queued: true, requestId: ctx.requestId, queuedId, sessionContext };
    };

    if (policy === 'steer') {
        const owner = getCurrentMainMeta(ctx.scopeKey);
        if (owner && !sameRunConversation(
            { origin: owner.origin, remoteKey: owner.remoteKey
                ?? (isRemoteTarget(owner.target) ? buildRemoteBindingKey(owner.target) : undefined) },
            { origin: ctx.meta.origin, remoteKey: ctx.remoteKey
                ?? (isRemoteTarget(ctx.meta.target) ? buildRemoteBindingKey(ctx.meta.target) : undefined) },
        )) {
            // Native replacement validates every owner dimension and returns a
            // typed failure. Queueing here would preserve the owner's
            // scope/session/target while swapping only remoteKey, which stores
            // another conversation's prompt in the owner's transcript.
            if (hasActiveMainReplacement(ctx.scopeKey)) {
                // Fall through to steerAgent; its immutable owner check rejects.
            } else {
            // Steer changes the turn that is already running. A different
            // remoteKey is a different conversation, so applying its text to
            // this owner would also hand it the owner's progress and terminal
            // delivery. Queue it as its own follow-up instead (#743).
                return queue();
            }
        }
        // 'steer' means the message steers the agent — never a silent queue.
        // A steerable Codex App turn receives in-band input. Native Cursor/Grok
        // use their cancel-reprompt hooks; other runtimes take the kill-steer
        // path, which salvages bounded partial output into the follow-up run
        // (withSteerContext). Queueing is what the 'followup'/'collect' policies
        // are for.
        //
        // submitMessage is a sync contract, so the response stays optimistic
        // ('steered'). The outcome is not fire-and-forget: a raced
        // ('unavailable') or kind-rejected ('rejected': review/compact) in-band
        // steer joins the queue — with its queue_update broadcast — instead of
        // dying silently. Queue is the fallback only for in-band failures,
        // never for missing capability.
        const steerMeta = stripUndefined({ chatSessionId: ctx.chatSessionId, target: ctx.meta.target,
            chatId: ctx.meta.chatId, requestId: ctx.requestId, remoteKey: ctx.remoteKey, replyViaTarget: ctx.meta.replyViaTarget,
            slackWorkflow: ctx.meta.slackWorkflow });
        const inputGuard = beginSteerInput(ctx.scopeKey);
        runDetached(
            steerAgent(ctx.scopeKey, ctx.text, ctx.meta.origin, steerMeta).then(outcome => {
                // Stop settles an undispatched redirect as cancelled; never recreate it after the purge.
                if (outcome !== 'fallback-queue') return;
                if (inputGuard.isCancelled()) {
                    settleOnce(ctx.requestId, 'cancelled', { reason: 'native-steer-stopped', scope: ctx.scopeKey, sessionId: ctx.chatSessionId });
                } else queue();
            }).finally(() => inputGuard.release()),
            'steer',
            { ...ctx.meta, requestId: ctx.requestId, eventScope: { scope: ctx.scopeKey, sessionId: ctx.chatSessionId } },
        );
        return { action: 'started', disposition: 'steered', requestId: ctx.requestId, sessionContext };
    }
    if (policy === 'collect') return queue({ collect: true });
    if (policy === 'interrupt') {
        killActiveAgent(ctx.scopeKey, 'interrupt');
        purgeQueueOnStop(ctx.scopeKey, 'interrupt');
        return queue({ front: true });
    }
    return queue();
}

// ── 5s dedup window ──
// L2 defense against duplicate inserts caused by:
//   (a) rapid user re-submit (impatience / button double-click)
//   (b) dispatch Bash-tool timeout → Boss hallucinates "in progress" → user retypes

const DEDUP_WINDOW_MS = 5000;
const recentSubmissions = new Map<string, { ts: number; requestId: string }>();

/** Exported for unit tests (pure, stateless). */
export function dedupKey(scope: string, origin: string, text: string, chatId?: string | number, threadId?: string): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    // threadId included so identical text in different forum topics is not false-deduped.
    return `${scope}:${origin}:${chatId ?? ''}:${threadId ?? ''}:${normalized}`;
}

function gcRecentSubmissions(now: number): void {
    if (recentSubmissions.size < 32) return; // amortize GC
    for (const [k, v] of recentSubmissions) {
        if (now - v.ts > DEDUP_WINDOW_MS * 2) recentSubmissions.delete(k);
    }
}

/** Exposed for tests. Clears the dedup cache. */
export function __resetSubmitDedupForTest(): void {
    recentSubmissions.clear();
}

function runDetached(
    task: Promise<unknown>,
    label: string,
    meta: { origin: RuntimeOrigin; target?: RemoteTarget; chatId?: string | number; requestId?: string;
        remoteKey?: string; replyViaTarget?: boolean; eventScope?: { scope: string; sessionId: string } },
) {
    task.catch((err: unknown) => {
        const msg = (err as Error)?.message || String(err);
        console.error(`[gateway:${label}]`, msg);
        broadcast('orchestrate_done', {
            text: `[orchestrate error] ${msg}`,
            origin: meta.origin,
            target: meta.target,
            chatId: meta.chatId,
            requestId: meta.requestId,
            ...(meta.remoteKey ? { remoteKey: meta.remoteKey } : {}),
            replyViaTarget: meta.replyViaTarget,
            ...meta.eventScope,
            error: true,
        });
        // The pipeline rejected before reaching its own settle site, so this is
        // the last chance to answer the caller instead of leaking the entry.
        settleOnce(meta.requestId, 'failed', { error: msg });
    });
}

export function submitMessage(
    text: string,
    meta: SubmitMeta,
): SubmitResult {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'rejected', reason: 'empty' };

    const display = meta.displayText || trimmed;
    const requestId = randomUUID();

    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const gateOn = !multiSessionEnabled || !meta.target || channelGateOn(meta.target.channel);
    const remoteKey = multiSessionEnabled && meta.target && gateOn
        ? (meta.remoteKey || buildRemoteBindingKey(meta.target))
        : undefined;
    const chatSessionId = multiSessionEnabled && meta.target && !gateOn
        ? 'default'
        : remoteKey
        ? (meta.chatSessionId || resolveOrCreateRemoteSession(remoteKey))
        // A caller that names its session has already had it validated (routes/session-request),
        // and ignoring it here is how a scope and a session id from two different sessions
        // ended up on the same message: the scope named the tab, the id named whatever was
        // globally active, and the write landed in the wrong place (072 §1.1).
        : (multiSessionEnabled && meta.chatSessionId) || getActiveChatSession();
    const scope = multiSessionEnabled
        ? (meta.target && !gateOn ? 'default' : (meta.scope || resolveOrcScope(stripUndefined({
            origin: meta.origin,
            target: meta.target,
            chatId: meta.chatId,
            workingDir: settings["workingDir"] || null,
            persistedScopeId: remoteKey,
            multiSessionEnabled,
        }))))
        : 'default';
    const sessionScope: SessionScope = { scope, chatSessionId };

    // Admit the request the moment its id exists. Every exit below then settles
    // through settleOnce(), so a caller holding this id always hears exactly one
    // terminal event — including on paths that never emit orchestrate_done.
    admitRequest(requestId, scope, Date.now(), {
        origin: meta.origin,
        sessionId: chatSessionId,
        ...(remoteKey ? { remoteKey } : {}),
        ...(meta.target ? { target: meta.target } : {}),
    });
    try { meta.onAdmitted?.({ requestId, scope, chatSessionId }); }
    catch { settleOnce(requestId, 'failed', { error: 'slack_tool_context_unavailable' }); return { action: 'rejected', reason: 'slack_tool_context_unavailable', requestId }; }
    // OFF-mode byte-compat: only expose resolved identity when multi-session is on —
    // /api/message spreads SubmitResult into the HTTP response (routes/command.ts).
    const sessionContext = multiSessionEnabled
        ? { scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}) }
        : undefined;
    const eventScope = multiSessionEnabled || meta.origin === 'slack'
        ? { scope, sessionId: chatSessionId }
        : undefined;

    // Reject before recording input, steering, interrupting or enqueueing. The
    // synchronous response must not advertise a rejected admission as steered.
    const admissionCli = meta.overrides?.cli
        ?? resolveMainCli(null, settings, getSession() as MainSessionRecord | undefined);
    if (isRetiredCliSelection(admissionCli)) {
        const diagnostic = retiredRuntimeDiagnostic(admissionCli);
        settleOnce(requestId, 'failed', { error: diagnostic, scope, sessionId: chatSessionId });
        return { action: 'rejected', reason: diagnostic, requestId,
            ...(sessionContext ? { sessionContext } : {}) };
    }

    // Admission must use the resolved persistent scope, not a pre-resolution transport guess.
    const now = Date.now();
    const key = dedupKey(scope, meta.origin, trimmed, meta.chatId, normalizedThreadId(meta.target));
    const prior = recentSubmissions.get(key);
    if (prior && now - prior.ts < DEDUP_WINDOW_MS) {
        console.log(`[gateway:dedup] suppressed duplicate (${now - prior.ts}ms window) origin=${meta.origin}`);
        // This submission was admitted above but will never run. Settle it under
        // its OWN id: returning the prior id as if it were this caller's is not
        // enough, because that request may already have settled and this caller
        // would then wait for an event that has come and gone.
        settleOnce(requestId, 'dropped', { reason: 'duplicate', mergedInto: prior.requestId });
        return { action: 'rejected', reason: 'duplicate', requestId: prior.requestId };
    }
    gcRecentSubmissions(now);
    recentSubmissions.set(key, { ts: now, requestId });

    // ── continue intent (only when IDLE) ──
    if (getState(scope) === 'IDLE' && isContinueIntent(trimmed)) {
        if (isAgentBusy(scope)) {
            settleOnce(requestId, 'dropped', { reason: 'busy' });
            return { action: 'rejected', reason: 'busy', requestId };
        }
        insertMessage.run('user', display, meta.origin, '', settings["workingDir"] || null, chatSessionId);
        broadcast('new_message', stripUndefined({ role: 'user', content: display, source: meta.origin, external: meta.external ? true : undefined, ...(eventScope || {}) }));
        if (!meta.skipOrchestrate) {
            runDetached(
                sessionLanes.run(scope, () => (
                    multiSessionEnabled
                        ? withSessionScope(sessionScope, () => orchestrateContinue(stripUndefined({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, replyViaTarget: meta.replyViaTarget, scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}), _skipInsert: true })))
                        : orchestrateContinue({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, replyViaTarget: meta.replyViaTarget, _skipInsert: true })
                )),
                'continue',
                { ...meta, requestId, ...(eventScope ? { eventScope } : {}) },
            );
        }
        else if (!meta.ownedExecution) settleOnce(requestId, 'skipped', { reason: 'skipOrchestrate' });
        return { action: 'started', disposition: 'new_run', noPendingContinue: true, requestId, ...(sessionContext ? { sessionContext } : {}) };
    }

    // ── reset intent ──
    if (isResetIntent(trimmed)) {
        insertMessage.run('user', display, meta.origin, '', settings["workingDir"] || null, chatSessionId);
        broadcast('new_message', stripUndefined({ role: 'user', content: display, source: meta.origin, external: meta.external ? true : undefined, ...(eventScope || {}) }));
        if (!meta.skipOrchestrate) {
            runDetached(
                sessionLanes.run(scope, () => (
                    multiSessionEnabled
                        ? withSessionScope(sessionScope, () => orchestrateReset(stripUndefined({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, replyViaTarget: meta.replyViaTarget, scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}), _skipInsert: true })))
                        : orchestrateReset({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, replyViaTarget: meta.replyViaTarget, _skipInsert: true })
                )),
                'reset',
                { ...meta, requestId, ...(eventScope ? { eventScope } : {}) },
            );
        }
        else if (!meta.ownedExecution) settleOnce(requestId, 'skipped', { reason: 'skipOrchestrate' });
        return { action: 'started', disposition: 'new_run', requestId, ...(sessionContext ? { sessionContext } : {}) };
    }

    // ── busy → enqueue only ──
    // NOTE: insertMessage is NOT called here — the scoped queue drain handles it.
    // This fixes the dual-insert bug where bot.ts called both enqueue + insert.
    // NOTE: pending worker replay is intentionally not an admission gate — orchestrate()
    // drains pending replays at entry (pipeline.ts drainPendingReplays), so
    // starting immediately is safe and avoids the processQueue deadlock.

    if (isAgentBusy(scope) || hasBlockingWorkers(scope)) {
        if (multiSessionEnabled) {
            return applyMidRunPolicy(resolveMidRunPolicy(meta, chatSessionId), {
                scopeKey: scope,
                chatSessionId,
                text: trimmed,
                meta,
                requestId,
                ...(remoteKey ? { remoteKey } : {}),
            });
        }
        const queuedId = enqueueMessage(trimmed, meta.origin, stripUndefined({ target: meta.target, chatId: meta.chatId, requestId, scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}), overrides: meta.overrides, replyViaTarget: meta.replyViaTarget }));
        return { action: 'queued', pending: messageQueue.length, queued: true, requestId, queuedId, ...(sessionContext ? { sessionContext } : {}) };
    }

    // ── idle → start immediately ──
    insertMessage.run('user', display, meta.origin, '', settings["workingDir"] || null, chatSessionId);
    broadcast('new_message', stripUndefined({ role: 'user', content: display, source: meta.origin, external: meta.external ? true : undefined, ...(eventScope || {}) }));
    if (!meta.skipOrchestrate) {
        runDetached(
            sessionLanes.run(scope, () => (
                multiSessionEnabled
                    ? withSessionScope(sessionScope, () => orchestrate(trimmed, stripUndefined({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}), _skipInsert: true, overrides: meta.overrides, replyViaTarget: meta.replyViaTarget, _steerContext: meta._steerContext })))
                    : orchestrate(trimmed, stripUndefined({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true, overrides: meta.overrides, replyViaTarget: meta.replyViaTarget, _steerContext: meta._steerContext }))
            )),
            'orchestrate',
            { ...meta, requestId, ...(eventScope ? { eventScope } : {}) },
        );
    }
    else if (!meta.ownedExecution) settleOnce(requestId, 'skipped', { reason: 'skipOrchestrate' });
    return { action: 'started', disposition: 'new_run', requestId, ...(sessionContext ? { sessionContext } : {}) };
}
