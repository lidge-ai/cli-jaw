import { settleOnce } from '../orchestrator/request-registry.js';
import { reserveSlackToolGrant, revokeSlackToolScope, type SlackToolSource } from './tool-context.js';
import { settings } from '../core/config.js';
import { getActiveChatSession, resolveOrCreateRemoteSession } from '../core/chat-sessions.js';
import { channelGateOn, scopeForChatSession } from '../orchestrator/scope.js';
import { submitMessage, type SubmitResult } from '../orchestrator/gateway.js';
import { sessionLanes } from '../orchestrator/session-lanes.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import type { RemoteTarget } from '../messaging/types.js';
import {
    clearSlackEventDedup,
    findSlackEventDedup,
    insertSlackEventDedup,
    sweepSlackEventDedup,
} from '../core/db.js';
import { log } from '../core/logger.js';
import { logErrorText } from '../messaging/redact.js';
import type { SlackWorkflowMetadata } from './workflow.js';

const ingressTails = new Map<string, Promise<void>>();
const controllers = new Set<AbortController>();
const tracked = new Set<Promise<void>>();
const downloadWaiters: Array<() => void> = [];
let activeDownloads = 0;
let generation = 0;
let resetting = false;

/**
 * Message-level dedupe, keyed by the STABLE event identity (team, channel, ts).
 *
 * This is a different layer from the socket's envelope dedupe: that one absorbs a
 * redelivery of the same envelope, this one absorbs two different envelopes that
 * describe the same Slack message. It has to exist because `dedupKey` downstream
 * hashes the prompt body (`gateway.ts`), and sender identity can resolve on one
 * delivery and degrade on the next — different prefixes, split key, message run
 * twice.
 *
 * Placement matters as much as existence: this must be recorded only AFTER the
 * gate accepts an event. Slack sends a `message` copy and an `app_mention` copy of
 * the same mention sharing one `ts`, and the gate drops the `message` copy. If the
 * dropped copy arrived first and claimed the key, it would suppress the canonical
 * `app_mention` and the mention would be ignored entirely.
 */
const EVENT_DEDUP_TTL_MS = 10 * 60 * 1000;
const seenEvents = new Map<string, number>();

export function slackEventKey(teamId: string, channel: string, ts: string): string {
    return `${teamId || 'unknown'}:${channel}:${ts}`;
}

/**
 * RESERVE, not commit (#321). Returns true when this delivery was already
 * handled and the caller should drop it.
 *
 * The reservation is in memory so the same-tick test-and-set stays atomic, and
 * it is checked against the durable record so a runtime that restarted before
 * Slack observed our ACK does not run the redelivery a second time.
 *
 * Deliberately NOT durable at this point: the caller has an `await` and several
 * early returns between here and admission, and Socket Mode acks before doing
 * any work. Writing durably here would turn a recoverable redelivery into a
 * ten-minute silent message loss — duplication is visible and cancellable, a
 * vanished message is not.
 */
export function claimSlackEvent(key: string): boolean {
    const now = Date.now();
    const seenAt = seenEvents.get(key);
    if (seenAt !== undefined && seenAt > now) return true;
    if (isSlackEventCommitted(key, now)) return true;
    // Lazy sweep of expired keys only — no timer, so the loop can still exit.
    if (seenEvents.size > 500) {
        for (const [candidate, expiry] of seenEvents) {
            if (expiry <= now) seenEvents.delete(candidate);
        }
        sweepCommittedSlackEvents(now);
    }
    seenEvents.set(key, now + EVENT_DEDUP_TTL_MS);
    return false;
}

function isSlackEventCommitted(key: string, now: number): boolean {
    try {
        const row = findSlackEventDedup.get(key) as { expires_at?: number } | undefined;
        return typeof row?.expires_at === 'number' && row.expires_at > now;
    } catch (error) {
        // A broken dedupe store must never stop us receiving messages.
        log.warn('[slack:dedupe] durable read failed:', logErrorText(error));
        return false;
    }
}

function sweepCommittedSlackEvents(now: number): void {
    try { sweepSlackEventDedup.run(now); }
    catch { /* best-effort cleanup; expiry is enforced on read anyway */ }
}

/**
 * COMMIT. Called only once a run has actually been admitted, so an event that
 * died before admission is still redeliverable.
 *
 * Fail-open by design: if the write throws, the run is already accepted and
 * cancelling it would risk losing the message. Duplication after a restart is
 * the honest failure direction here.
 */
export function commitSlackEvent(key: string): void {
    const expiresAt = Date.now() + EVENT_DEDUP_TTL_MS;
    seenEvents.set(key, expiresAt);
    try { insertSlackEventDedup.run(key, expiresAt); }
    catch (error) {
        log.warn('[slack:dedupe] durable commit failed:', logErrorText(error));
    }
}

/**
 * Clears the in-memory reservations only. The durable record is what makes a
 * restart safe, so wiping it here would reintroduce #321; it expires by TTL.
 */
export function resetSlackEventDedup(): void {
    seenEvents.clear();
}

/** Test-only: drops the durable record too. */
export function clearSlackEventDedupForTest(): void {
    seenEvents.clear();
    try { clearSlackEventDedup.run(); } catch { /* table may not exist in a bare fixture */ }
}

/** The ingress lifecycle counter, captured at reserve time and revalidated
 *  before admission: a reset in between means this delivery belongs to a dead
 *  generation and must not be admitted (a redelivery already re-reserved it). */
export function currentIngressGeneration(): number {
    return generation;
}

export function isIngressGenerationCurrent(captured: number): boolean {
    return captured === generation;
}

function downloadLimit(): number {
    const value = Number(settings["slack"]?.inboundDownloadConcurrency ?? 6);
    return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 6;
}

function pumpDownloads(): void {
    while (activeDownloads < downloadLimit()) {
        const start = downloadWaiters.shift();
        if (!start) break;
        activeDownloads += 1;
        start();
    }
}

export function withSlackDownloadSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (resetting || signal?.aborted) return Promise.reject(new Error('ingress_cancelled'));
    return new Promise<T>((resolve, reject) => {
        let started = false;
        const start = () => {
            started = true;
            signal?.removeEventListener('abort', onAbort);
            void task().then(resolve, reject).finally(() => {
                activeDownloads -= 1;
                pumpDownloads();
            });
        };
        const onAbort = () => {
            if (started) return;
            const index = downloadWaiters.indexOf(start);
            if (index >= 0) downloadWaiters.splice(index, 1);
            reject(new Error('ingress_cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        downloadWaiters.push(start);
        pumpDownloads();
    });
}

export function slackIngressLaneKey(target: RemoteTarget): string {
    return settings["multiSession"]?.enabled === true && channelGateOn('slack')
        ? buildRemoteBindingKey(target)
        : 'default';
}

export function enqueueSlackIngress(
    laneKey: string,
    task: (signal: AbortSignal) => Promise<void>,
    options: {
        onDropped?: (reason: 'ingress_cancelled' | 'stale_generation') => void;
    } = {},
): boolean {
    if (resetting) return false;
    const taskGeneration = generation;
    const controller = new AbortController();
    controllers.add(controller);
    const previous = ingressTails.get(laneKey);
    const run = async () => {
        if (controller.signal.aborted || taskGeneration !== generation) {
            options.onDropped?.(controller.signal.aborted ? 'ingress_cancelled' : 'stale_generation');
            return;
        }
        await task(controller.signal);
    };
    const result = previous ? previous.catch(() => undefined).then(run) : Promise.resolve().then(run);
    const tail = result.then(() => undefined, () => undefined);
    ingressTails.set(laneKey, tail);
    tracked.add(result);
    void result.catch(() => undefined).finally(() => {
        controllers.delete(controller);
        tracked.delete(result);
    });
    void tail.then(() => {
        if (ingressTails.get(laneKey) === tail) ingressTails.delete(laneKey);
    });
    return true;
}

export type SlackRunContext = {
    scope: string;
    chatSessionId: string;
    requestId: string;
    remoteKey?: string;
};

export function resolveSlackScopeForTarget(target: RemoteTarget): string | null {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const gateEnabled = multiSessionEnabled && channelGateOn('slack');
    const remoteKey = gateEnabled ? buildRemoteBindingKey(target) : undefined;
    const chatSessionId = multiSessionEnabled && !gateEnabled
        ? 'default'
        : remoteKey ? resolveOrCreateRemoteSession(remoteKey) : getActiveChatSession();
    const scope = scopeForChatSession(chatSessionId, remoteKey, gateEnabled);
    return scope === 'default' ? null : scope;
}

export function admitSlackRun(params: {
    workflow?: SlackWorkflowMetadata;
    toolSource?: SlackToolSource;
    target: RemoteTarget;
    prompt: string;
    displayText: string;
    chatId: string;
    preResolvedScope?: string | null;
    runReply: (ctx: SlackRunContext) => Promise<void>;
}): SubmitResult & { laneTail?: Promise<void>; sessionContext: NonNullable<SubmitResult['sessionContext']> } {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const gateEnabled = multiSessionEnabled && channelGateOn('slack');
    const remoteKey = gateEnabled ? buildRemoteBindingKey(params.target) : undefined;
    const conversationChatSessionId = multiSessionEnabled && !gateEnabled
        ? 'default'
        : remoteKey ? resolveOrCreateRemoteSession(remoteKey) : getActiveChatSession();
    const scope = params.preResolvedScope !== undefined
        ? params.preResolvedScope ?? 'default'
        : scopeForChatSession(conversationChatSessionId, remoteKey, gateEnabled);
    // Parallel workflow lanes also need their own prompt-history session. A
    // distinct scope alone isolates process admission and native resume, but a
    // shared chatSessionId still injects sibling tickets as Recent Context.
    const chatSessionId = params.workflow?.parallelLane === true && params.preResolvedScope
        ? resolveOrCreateRemoteSession(`workflow-lane:${params.preResolvedScope}`)
        : conversationChatSessionId;
    const result = submitMessage(params.prompt, {
        ...(params.toolSource ? { ownedExecution: true as const, onAdmitted: (binding: { requestId: string; scope: string; chatSessionId: string }) => { if (!reserveSlackToolGrant(params.toolSource!, binding)) throw new Error('slack_tool_context_unavailable'); } } : {}),
        origin: 'slack', displayText: params.displayText, skipOrchestrate: true,
        ...(params.workflow ? { slackWorkflow: params.workflow } : {}),
        ...(params.workflow?.runtimeCli || params.workflow?.runtimeModel || params.workflow?.runtimeEffort
            ? { overrides: {
                ...(params.workflow.runtimeCli ? { cli: params.workflow.runtimeCli } : {}),
                ...(params.workflow.runtimeModel ? { model: params.workflow.runtimeModel } : {}),
                ...(params.workflow.runtimeEffort ? { effort: params.workflow.runtimeEffort } : {}),
            } } : {}),
        target: params.target, chatId: params.chatId,
        // A tool turn keeps the default steer policy: its grant is reserved at
        // admission (gateway onAdmitted) under the same requestId the kill-steer
        // follow-up continues with, so the follow-up spawn re-activates it.
        // Only synthetic thread addresses still force followup. (#660 review)
        // A configured automation is its own task, not a steer into someone else's run.
        ...(params.workflow || params.target.threadIsSynthetic === true ? { midRunPolicy: 'followup' as const } : {}),
        ...(remoteKey ? { remoteKey } : {}), chatSessionId, scope,
    });
    const session = result.sessionContext || { scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}) };
    if (result.disposition !== 'new_run') return { ...result, sessionContext: session };
    const laneTail = sessionLanes.run(session.scope, async () => { try { await params.runReply({
        scope: session.scope,
        chatSessionId: session.chatSessionId,
        requestId: result.requestId || '',
        ...(session.remoteKey ? { remoteKey: session.remoteKey } : {}),
    }); } finally { if (params.toolSource) settleOnce(result.requestId, 'dropped', { reason: 'slack_owned_run_closed', scope: session.scope }); } });
    return { ...result, sessionContext: session, laneTail };
}

export async function resetSlackIngress(): Promise<void> {
    revokeSlackToolScope();
    resetting = true;
    generation += 1;
    for (const controller of controllers) controller.abort();
    const pending = [...tracked];
    if (pending.length) {
        const drain = Promise.allSettled(pending).then(() => undefined);
        // The timer must be cleared on the fast path: an un-cleared 5s timer
        // keeps the event loop alive and delays process exit on every shutdown.
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>(resolve => {
            drainTimer = setTimeout(resolve, 5_000);
            drainTimer.unref?.();
        });
        await Promise.race([drain, timeout]);
        if (drainTimer) clearTimeout(drainTimer);
        for (const promise of pending) void promise.catch(() => undefined);
    }
    // Aborting is not the same as forgetting. Anything still registered here
    // carries an already-aborted signal, so leaving it in place would make the
    // NEXT lifecycle inherit dead controllers (and leak them if a task never
    // settled within the drain window).
    controllers.clear();
    tracked.clear();
    ingressTails.clear();
    // A dead generation's keys must not suppress the next lifecycle's messages.
    resetSlackEventDedup();
    resetting = false;
}

export function slackIngressStats(): { lanes: number; activeDownloads: number } {
    return { lanes: ingressTails.size, activeDownloads };
}
