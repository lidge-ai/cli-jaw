import { verifiedSlackWorkspace } from './verified-workspace.js';
import { slackCredentialKey, type SlackToolSource } from './tool-context.js';
import { isSlackMention, matchesTrustedBotTrigger, readTrustedBotTriggers } from './events.js';
import { captureSlackWorkflow, prepareSlackWorkflow, renderSlackWorkflow, isWorkflowReplyUnconfirmed, workflowDiagnosticText, type SlackWorkflowMetadata, type SlackWorkflowSelection } from './workflow.js';
// ─── Slack Bot ───────────────────────────────────────
// Slack transport implementation for the cli-jaw messaging runtime.
// Mirrors src/discord/bot.ts structurally: init/shutdown lifecycle, an inbound
// handler that gates then dispatches into submitMessage/orchestrateAndCollect,
// and a forwarder for non-Slack-origin agent output.

import { JAW_HOME, SKILLS_DIR, isSettingsPersistenceBlocked, readPersistedSlackAttachPort, saveSettings, settings } from '../core/config.js';
import { withSessionScope } from '../core/session-context.js';
import { log } from '../core/logger.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollectData } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { isContinueIntent } from '../orchestrator/parser.js';
import {
    setLastActiveTarget, setLatestSeenTarget,
    revokeMessagingTransport, startMessagingTransport,
    transportStarted, transportNotStarted, type TransportInitContext, type TransportStartOutcome,
} from '../messaging/runtime.js';
import { slackTargetFromId, resolveSlackThreadPlacement } from '../messaging/slack-target.js';
import { isRemoteTarget, type RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import { matchesRunPin } from '../messaging/run-pin.js';
import { sessionLanes } from '../orchestrator/session-lanes.js';
import { createSlackReplyDeliveryLedger } from './reply-delivery.js';
import { buildMediaPromptMany } from '../agent/spawn.js';
import {
    addSlackReaction,
    describeSlackError,
    removeSlackReaction,
    slackApi,
} from './api.js';
import {
    createAckHandle,
    resolveAckConfig,
    shouldAck,
    SLACK_ACK_DEFAULTS,
    type AckHandle,
} from '../messaging/ack-reaction.js';
import { QueueNoticeRegistry } from '../messaging/queue-notice.js';
import { OutboundSendRegistry } from '../messaging/outbound-lifecycle.js';
import {
    recordSlackScopeObservation,
    getSlackScopeStatus,
    describeSlackScopeGaps,
    resetSlackScopeStatus,
} from './scope-status.js';
import { HELLO_DEADLINE_MS, SlackSocketClient, type SlackConnectionState, type SlackEnvelope, type SlackPreflightResult } from './socket.js';
import {
    SLACK_TOKEN_CLAIM_FRESH_MS,
    acquireSlackTokenClaim,
    inspectSlackTokenClaim,
    type SlackTokenClaimAcquireResult,
    type SlackTokenClaimLease,
} from './token-claim.js';
import { runSlackAutoJoin, mergeSlackAutoJoin } from './auto-join.js';
import { createHash } from 'node:crypto';
import { admitIngress, getIngressJournal, settleIngress, type IngressAdmission } from '../messaging/durable-ingress.js';
import { getQueueNoticeStore } from '../messaging/queue-notice-store.js';
import { createSlackNoticeTransport } from './notice-transport.js';
import { currentGenerationForEnvelope } from '../messaging/ingress-generation.js';
import { slackInboundEnvelope } from '../messaging/inbound-envelope.js';
import { readSlackAllowlist, resolveEventText, shouldAttachSlack, shouldProcessSlackEvent, type SlackMessageEvent } from './events.js';
import { captureMentionWatchInbox } from './mention-watch-inbox.js';
import {
    markThreadParticipated, threadParticipationKind,
    claimThreadPrefetch, commitThreadPrefetch,
    releaseThreadPrefetch, resetThreadPrefetchClaims,
} from './thread-tracker.js';
import { sendSlackText, getSlackSendClient } from './send-only-client.js';
import { createSlackProgressLifecycle, type SlackProgressLifecycle } from './progress-lifecycle.js';
import { createSlackProgressRestorer } from './progress-restore.js';
import type { SlackProgressOutcome } from './progress.js';
import { createSlackForwarder, relaySlackImages } from './forwarder.js';
import { nextDeliverySeq, wasSelfDelivered } from '../messaging/turn-delivery.js';
import { shouldSkipForwarding } from '../messaging/forwarder-origin.js';
import { requiresNativeBodyDelivery } from '../messaging/native-body.js';
import { createQueueNoticeRecorder } from '../messaging/queue-notice-record.js';
import { admitTargetReply } from '../messaging/target-reply-guard.js';
import { handleSlackSlashCommand } from './commands.js';
import { logErrorText, redactOutboundText } from '../messaging/redact.js';
import { downloadAndSaveSlackFiles, type FailedSlackFile } from './inbound-file.js';
import { admitSlackRun, claimSlackEvent, commitSlackEvent, currentIngressGeneration, enqueueSlackIngress, isIngressGenerationCurrent, resetSlackIngress, resolveSlackScopeForTarget, slackEventKey, slackIngressLaneKey, type SlackRunContext } from './ingress.js';
import { buildSenderDisplay, buildSenderPrompt, resolveSenderIdentity } from './identity.js';
import {
    admitHistoryStart, cachedNameMap, resolveConversationInfo, resolveThreadInfo, THREAD_FETCH_LIMIT,
} from './conversation.js';
import { fetchSlackHistory, formatHistoryForAgent } from './history.js';
import { buildSlackContextBlock, applySlackContext, buildThreadPreamble, ROSTER_PREVIEW } from './context.js';
import { fetchSlackChannelMembers } from './roster.js';
import type { SlackIdentity } from './identity.js';
import { recoverSlackAttachments } from './attachment-recovery.js';
import { getSessionOwnershipGeneration, type SessionOwnerToken } from '../agent/session-persistence.js';
import { resetSlackIdentityCache } from './identity.js';
import { resetSlackConversationCache } from './conversation.js';
import { handleApprovalCommand, handleApprovalCallback, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';
import { parseApprovalCallbackData } from '../messaging/approval-presentation.js';

let socketClient: SlackSocketClient | null = null;
let forwarderHandler: BroadcastListener | null = null;
let selfUserId: string | null = null;
let slackInitLock = false;
let activeClaimArbiter: ClaimArbiter | null = null;
let claimRecheckTimer: ReturnType<typeof setTimeout> | null = null;
let sharedTokenOptOutLogged = false;
/**
 * Request ids a live queued-reply listener is already waiting on. The
 * target-reply forwarder checks this so a result does not get posted twice: once
 * by the requester that is still here, once by the fallback that exists for the
 * requester that is not (#407).
 */
const pendingQueueRequestIds = new Set<string>();
/**
 * Queue-notice teardowns, owned by the shared lifecycle module rather than by
 * hand-rolled closures. Shutdown drains this instead of dropping callbacks, so a
 * turn that never answered gets its notice rewritten rather than left claiming
 * the agent is still working on it.
 */
const slackProgressRegistry = new QueueNoticeRegistry();
const slackProgressSealers = new Set<() => void>();
const liveSlackProgressRequestIds = new Set<string>();
let slackStopping = false;
const SLACK_PROGRESS_DRAIN_MS = 1500;
const SLACK_QUEUE_WAIT_MS = 300000;
const SLACK_RUN_IDLE_MS = 1200000;

function registerSlackProgressTeardown(
    requestId: string, seal: () => void, drain: (signal?: AbortSignal) => Promise<void>,
): () => void {
    slackProgressSealers.add(seal);
    liveSlackProgressRequestIds.add(requestId);
    const unregister = slackProgressRegistry.add(drain);
    return () => {
        unregister();
        slackProgressSealers.delete(seal);
        liveSlackProgressRequestIds.delete(requestId);
    };
}

const slackProgressRestorer = createSlackProgressRestorer({
    getStore: getQueueNoticeStore,
    getToken: () => getSlackSendClient().token,
    getGeneration: () => lifecycleGeneration,
    isLive: id => pendingQueueRequestIds.has(id) || liveSlackProgressRequestIds.has(id),
    getLocale: currentLocale,
    registerDrain: drain => slackProgressRegistry.add(drain),
    onError: () => log.info('[slack:progress] restore incomplete'),
});

/**
 * In-flight ANSWER sends (#417). The notice registry above cancels cleanup;
 * this one cancels the answer body, chunk-retry sleeps, and image uploads —
 * the calls that used to outlive the process because no signal reached them.
 */
const slackOutboundRegistry = new OutboundSendRegistry();

/**
 * A reaction transition is best-effort, so it gets a tighter bound than an
 * ordinary cleanup call: settle() may run remove THEN apply sequentially, and
 * the running apply can still be in flight ahead of both.
 */
const SLACK_ACK_TIMEOUT_MS = 2500;

/** Live ack config, re-read per turn so a settings change needs no restart. */
function slackAckConfig() {
    return resolveAckConfig(settings["slack"]?.ack, SLACK_ACK_DEFAULTS);
}

/**
 * Build the ACK handle for one inbound message.
 *
 * The transport throws on vendor failure because slackApi RESOLVES with
 * {ok:false}; without that check the handle would record a reaction that never
 * landed and then try to remove something that is not there. already_reacted and
 * no_reaction are successes: they mean the desired state is already true.
 */
function buildSlackAck(
    token: string,
    target: RemoteTarget,
    anchorTs: string,
    context: { isDirect: boolean; isMention: boolean },
): AckHandle | null {
    const config = slackAckConfig();
    if (!shouldAck(config, context)) return null;
    return createAckHandle(config, {
        // Slack has no atomic replace, so the previous reaction must come off first.
        mode: 'remove-then-add',
        apply: async (emoji) => {
            const r = await addSlackReaction(token, target.targetId, anchorTs, emoji,
                { timeoutMs: SLACK_ACK_TIMEOUT_MS });
            if (!r.ok && r.error !== 'already_reacted') {
                throw new Error(describeSlackError(r.error, r.data));
            }
        },
        remove: async (emoji) => {
            const r = await removeSlackReaction(token, target.targetId, anchorTs, emoji,
                { timeoutMs: SLACK_ACK_TIMEOUT_MS });
            if (!r.ok && r.error !== 'no_reaction') {
                throw new Error(describeSlackError(r.error, r.data));
            }
        },
        // Any workspace emoji name is valid; the wrapper strips colons.
        coerce: (emoji) => emoji,
    }, (e) => log.info('[slack:ack]', logErrorText(e)));
}

function hasPendingQueueWaiter(requestId: string): boolean {
    return pendingQueueRequestIds.has(requestId);
}

// ─── Durable notice records (#418) ──────────────────
// The handles above are process-local; this wraps the store that outlives the
// process. Best-effort by contract: a durable write is a convenience for the
// NEXT boot, and letting it throw here would fail the turn the user is actually
// waiting on. The contract is shared with the other two bots (#699).
const slackNoticeRecord = createQueueNoticeRecorder('slack', '[slack:queue-notice]');

/**
 * Close a queue notice as ANSWERED from a path that never held the live handle.
 *
 * The standing target-reply forwarder posts queued answers when no waiter is
 * listening any more (restart, missed requestId). It used to stop there, which
 * left the "대기열에 추가됨" message sitting in the thread next to the answer —
 * the user-reported leak (#411 family). The durable record (#418) still knows
 * the posted ts, so the answer's own delivery path can finish the promise:
 * delete the notice message and drop the record. Best-effort like every other
 * durable-notice touch; the answer is already out.
 */
async function closeSlackNoticeAsAnsweredByRequestId(
    requestId: string, token: string, signal: AbortSignal, generation: number,
): Promise<void> {
    const current = () => !signal.aborted && generation === lifecycleGeneration && !slackStopping;
    try {
        if (!current()) return;
        const record = getQueueNoticeStore()?.findByRequestId(requestId);
        if (!record) return;
        if (record.messageId) {
            await createSlackNoticeTransport(token, record.target.targetId, record.messageId).delete(signal);
        }
        if (current()) slackNoticeRecord.close(requestId);
    } catch (e) {
        log.info('[slack:queue-notice] answered-close failed', logErrorText(e));
    }
}

/** Restore only recorded status messages; never infer a finished execution. */
export async function restoreSlackQueueNotices(): Promise<void> {
    if (!slackStopping) await slackProgressRestorer.restore();
}

/** Stand in for a live queued-reply listener without opening a socket. */
export function claimSlackQueueRequestForTest(requestId: string): void {
    pendingQueueRequestIds.add(requestId);
}
export function releaseSlackQueueRequestForTest(requestId: string): void {
    pendingQueueRequestIds.delete(requestId);
}
/**
 * Bumped by every init and shutdown. An `initSlack` suspended on an await
 * checks it afterwards, so a shutdown that races the auth round-trip cannot be
 * undone by the stale initialization resuming and resurrecting the transport.
 */
let lifecycleGeneration = 0;
/**
 * Set when an init arrives while another is already running. The in-flight
 * init drains it on the way out, so a rapid disable/re-enable cannot leave
 * Slack permanently off just because its start request landed mid-teardown.
 */
let initRequestPending = false;

type ClaimArbiter = {
    readonly generation: number;
    readonly client: SlackSocketClient;
    readonly startEpoch: number;
    readonly lease: SlackTokenClaimLease | null;
    arbitrate(trigger: 'init' | 'hello'): Promise<SlackTokenClaimAcquireResult>;
    recordPresence(): SlackTokenClaimAcquireResult;
    noteDisconnected(): void;
    releaseOwnLeaseOnly(): void;
    applyForeignLiveOnce(fn: () => void): boolean;
};

function createClaimArbiter(options: {
    generation: number;
    client: SlackSocketClient;
    startEpoch: number;
    appToken: string;
    home: string;
    port: string;
}): ClaimArbiter {
    let lease: SlackTokenClaimLease | null = null;
    let inFlight: Promise<SlackTokenClaimAcquireResult> | null = null;
    let settled: SlackTokenClaimAcquireResult | null = null;
    let foreignApplied = false;
    const acquireConnected = (): SlackTokenClaimAcquireResult => {
        if (lease) {
            const heldLease = lease;
            if (heldLease.markConnected() === 'ok') return { kind: 'acquired', lease: heldLease };
            heldLease.release();
            lease = null;
        }
        const result = acquireSlackTokenClaim({
            appToken: options.appToken,
            home: options.home,
            port: options.port,
            connected: true,
        });
        if (result.kind === 'acquired') lease = result.lease;
        return result;
    };
    return {
        generation: options.generation,
        client: options.client,
        startEpoch: options.startEpoch,
        get lease() { return lease; },
        arbitrate() {
            if (settled) return Promise.resolve(settled);
            if (inFlight) return inFlight;
            inFlight = Promise.resolve().then(acquireConnected).then(result => {
                settled = result;
                return result;
            }).finally(() => { inFlight = null; });
            return inFlight;
        },
        recordPresence() {
            if (lease) return { kind: 'acquired', lease };
            const result = acquireSlackTokenClaim({
                appToken: options.appToken,
                home: options.home,
                port: options.port,
                connected: false,
            });
            if (result.kind === 'acquired') lease = result.lease;
            return result;
        },
        noteDisconnected() {
            lease?.markDisconnected();
            settled = null;
        },
        releaseOwnLeaseOnly() {
            lease?.release();
            lease = null;
            settled = null;
        },
        applyForeignLiveOnce(fn) {
            if (foreignApplied) return false;
            foreignApplied = true;
            fn();
            return true;
        },
    };
}

function clearSlackClaimRecheck(): void {
    if (!claimRecheckTimer) return;
    clearTimeout(claimRecheckTimer);
    claimRecheckTimer = null;
}

function armSlackClaimRecheck(generation: number): void {
    if (claimRecheckTimer) return;
    claimRecheckTimer = setTimeout(() => {
        claimRecheckTimer = null;
        if (generation !== lifecycleGeneration || !settings['slack']?.enabled) return;
        void startMessagingTransport('slack');
    }, SLACK_TOKEN_CLAIM_FRESH_MS + Math.floor(Math.random() * 5001));
    claimRecheckTimer.unref?.();
}

let slackApprovalIngress: DispatchApprovalTransport | null = null;
function createSlackSocketIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'slack' as const });
    registerProductionTransport(transport);
    return transport;
}
export function getSlackSelfUserId(): string | null { return selfUserId; }
export function setSlackSelfUserIdForTest(value: string | null): void { selfUserId = value; }
export function getSlackConnectionState(): string {
    return socketClient?.getState() ?? 'disconnected';
}

function currentLocale() { return normalizeLocale(settings["locale"], 'ko'); }

function gateConfig() {
    const sc = settings["slack"] || {};
    return {
        selfUserId,
        allowBots: Boolean(sc.allowBots),
        mentionOnly: sc.mentionOnly !== false,
        channelIds: readSlackAllowlist(sc.channelIds),
        // Validated inside the gate, not here: this module does not own the shape.
        trustedBotTriggers: sc.trustedBotTriggers,
        // Thread continuation defaults ON (threadRequireMention=false):
        // once mentioned, a thread keeps flowing without re-mention.
        threadRequireMention: sc.threadRequireMention === true,
        threadParticipation: threadParticipationKind,
    };
}

function buildSlackTarget(event: SlackMessageEvent): RemoteTarget {
    const replyInThread = settings["slack"]?.replyInThread !== false;
    // Reply address and session identity are separate questions: a top-level
    // message's own ts is where a reply would open a thread, but it does not
    // name a conversation (#520). Both callers of this function reach the
    // journal and dispatch paths through the returned target.
    const placement = resolveSlackThreadPlacement(event, replyInThread);
    const teamId = settings["slack"]?.teamId;
    return slackTargetFromId(event.channel as string, {
        ...(placement.threadTs ? { threadTs: placement.threadTs } : {}),
        ...(placement.synthetic ? { threadIsSynthetic: true } : {}),
        ...(teamId ? { teamId: String(teamId) } : {}),
    });
}

/**
 * Answer a queued turn nobody is waiting on any more.
 *
 * The ordinary queued reply rides a temporary listener armed by the request
 * that was queued (see the `queued` branch below). A restart destroys it — and
 * the boot drain (#407) runs exactly those messages. Without this the drain
 * consumes the item, deletes its row, and the answer goes nowhere: the user
 * loses the message instead of merely waiting for it.
 *
 * Installed once at module scope, like the Telegram equivalent
 * (`installTelegramTargetReplyForwarder`), and keyed on the target the item
 * carried through the queue rather than on whoever spoke most recently.
 */
let targetReplyForwarderInstalled = false;

function bodyProgressOutcome(
    data: Record<string, unknown>, delivered: boolean,
    latched: 'error' | 'cancelled' | undefined, stopping: boolean,
): SlackProgressOutcome {
    const native = requiresNativeBodyDelivery(data);
    if ((native && data['runtimeStatus'] === 'stopped') || (!native && data['executionInterrupted'] === true) || latched === 'cancelled') return 'cancelled';
    if (data['collectionFailure'] === 'timeout') return 'expired';
    if (data['workflowUnconfirmed'] === true) return 'error';
    if ((native && data['runtimeStatus'] === 'error') || (!native && data['executionFailed'] === true)
        || data['collectionFailure'] === 'error' || (!native && data['error'] === true) || latched === 'error') return 'error';
    if (!delivered) return stopping ? 'expired' : 'error';
    return 'complete';
}

type SlackReplyOptions = {
    workflow?: SlackWorkflowMetadata;
    token: string; target: RemoteTarget; requestId: string;
    session: { scope: string; chatSessionId: string; remoteKey?: string };
    locale: ReturnType<typeof currentLocale>; generation: number; signal: AbortSignal;
    workingDir?: string;
    ack: AckHandle | null; recipientUserId?: string; initialPhase: 'running' | 'queued';
};
const slackReplyDelivery = createSlackReplyDeliveryLedger();
const activeSlackReplyTrackers = new Map<string, { options: SlackReplyOptions; start(anchor: number): void }>();
let slackReplyAdmissionDepth = 0;
const pendingSteerContexts = new Map<string, { options: SlackReplyOptions; dispose(): void }>();
const SLACK_PENDING_STEER_MAX = 256;
const SLACK_PENDING_STEER_TTL_MS = 300_000;

function matchesSlackReply(options: SlackReplyOptions, data: Record<string, unknown>): boolean {
    return matchesRunPin({
        requestId: options.requestId,
        origin: 'slack',
        scope: options.session.scope,
        sessionId: options.session.chatSessionId,
        remoteKey: options.session.remoteKey,
        target: options.target,
    }, data);
}

function rememberPendingSteer(options: SlackReplyOptions): void {
    if (options.signal.aborted || slackStopping || options.generation !== lifecycleGeneration) return;
    pendingSteerContexts.get(options.requestId)?.dispose();
    while (pendingSteerContexts.size >= SLACK_PENDING_STEER_MAX) pendingSteerContexts.values().next().value!.dispose();
    const dispose = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', dispose);
        slackProgressSealers.delete(dispose);
        if (pendingSteerContexts.get(options.requestId)?.dispose === dispose) pendingSteerContexts.delete(options.requestId);
    };
    const timer = setTimeout(dispose, SLACK_PENDING_STEER_TTL_MS);
    timer.unref?.();
    pendingSteerContexts.set(options.requestId, { options, dispose });
    options.signal.addEventListener('abort', dispose, { once: true });
    slackProgressSealers.add(dispose);
}

function observeSlackReplyControl(type: string, raw: Record<string, unknown>): void {
    if (!['steer_started', 'queue_update', 'queued_run_started', 'request_settled'].includes(type)) return;
    const requestId = raw['requestId'];
    if (typeof requestId !== 'string' || !requestId || slackStopping) return;
    // Copy control identity only; an inline producer may precede admission return.
    const data: Record<string, unknown> = {};
    for (const key of ['requestId', 'origin', 'scope', 'sessionId', 'remoteKey', 'mode', 'outcome']) data[key] = raw[key];
    if (raw['target'] !== undefined) data['target'] = isRemoteTarget(raw['target']) ? { ...raw['target'] } : null;
    const actualStart = type === 'queued_run_started' || (type === 'steer_started' && data['mode'] === 'restart');
    const anchor = actualStart ? nextDeliverySeq() : undefined;
    const generation = lifecycleGeneration;
    const active = activeSlackReplyTrackers.get(requestId);
    if (active && matchesSlackReply(active.options, data) && anchor !== undefined) active.start(anchor);
    // Boot/orphan queue starts have no admission callback to wait for. Keep their
    // proof synchronous so an immediate completion cannot claim before the start.
    if (!active && slackReplyAdmissionDepth === 0 && type === 'queued_run_started'
        && data['origin'] === 'slack' && isRemoteTarget(data['target']) && data['target'].channel === 'slack'
        && typeof data['scope'] === 'string') {
        const pending = pendingSteerContexts.get(requestId);
        if (!pending || matchesSlackReply(pending.options, data)) slackReplyDelivery.started(requestId, data['target'], data['scope'], anchor);
    }
    queueMicrotask(() => {
        if (slackStopping || generation !== lifecycleGeneration) return;
        const pending = pendingSteerContexts.get(requestId);
        if (!pending) {
            const tracker = activeSlackReplyTrackers.get(requestId);
            if (tracker) {
                if (anchor !== undefined && matchesSlackReply(tracker.options, data)) tracker.start(anchor);
            } else if (type === 'queued_run_started' && data['origin'] === 'slack'
                && isRemoteTarget(data['target']) && data['target'].channel === 'slack' && typeof data['scope'] === 'string') {
                slackReplyDelivery.started(requestId, data['target'], data['scope'], anchor);
            }
            return;
        }
        if (!matchesSlackReply(pending.options, data)) return;
        const { options } = pending;
        if (options.signal.aborted || options.generation !== lifecycleGeneration) { pending.dispose(); return; }
        if (type === 'request_settled') {
            if (['steered', 'failed', 'cancelled', 'dropped'].includes(String(data['outcome']))) {
                pending.dispose();
                if (data['outcome'] !== 'steered') void options.ack?.settle('failure');
            }
            return;
        }
        if (type === 'steer_started' && ['native-input', 'cancel-reprompt'].includes(String(data['mode']))) { pending.dispose(); return; }
        if (!actualStart && type !== 'queue_update') return;
        pending.dispose();
        if (anchor !== undefined) slackReplyDelivery.started(requestId, options.target, options.session.scope, anchor);
        trackSlackReply({ ...options, initialPhase: actualStart ? 'running' : 'queued' });
    });
}

function trackSlackReply(options: SlackReplyOptions): void {
    const { token, target, requestId, session, locale, generation, signal, ack, recipientUserId, initialPhase } = options;
    if (signal.aborted || slackStopping || generation !== lifecycleGeneration || activeSlackReplyTrackers.has(requestId)) return;
    // A synchronous terminal may have reached the orphan owner before admission
    // returned. Its attempted body is not proof this late observer may ACK success.
    if (slackReplyDelivery.claimed(requestId, target)) {
        void ack?.settle('failure');
        return;
    }
    slackReplyDelivery.remember(requestId, target, session.scope);
    let started = initialPhase === 'running';
    let observedAnchor = slackReplyDelivery.anchor(requestId, target);
    let disposed = false;
    let shutdownSealed = false;
    let executionOutcome: 'error' | 'cancelled' | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminal: Promise<void> | null = null;
    let ackSettled = false;
    let display: SlackProgressLifecycle;
    const current = () => !shutdownSealed && !slackStopping && !signal.aborted && generation === lifecycleGeneration;
    const matches = (data: Record<string, unknown>) => matchesSlackReply(options, data);
    async function settleAck(outcome: 'success' | 'failure'): Promise<void> {
        if (ackSettled) return;
        ackSettled = true;
        await ack?.settle(outcome);
    }
    function disposeListener(): void {
        if (disposed) return;
        disposed = true;
        if (timer) clearTimeout(timer);
        removeBroadcastListener(queueHandler);
        activeSlackReplyTrackers.delete(requestId);
    }
    function claimTerminal(run: () => Promise<void>, ownsBody = false): Promise<void> {
        if (!terminal) {
            disposeListener();
            // Expired tracking must not swallow a later orphan reply. A live
            // body claim instead stays present until its send/relay settles.
            if (!ownsBody) pendingQueueRequestIds.delete(requestId!);
            terminal = run()
                .catch(error => log.info('[slack:queue]', logErrorText(error)))
                .finally(() => {
                    signal.removeEventListener('abort', abortInput);
                    pendingQueueRequestIds.delete(requestId!);
                });
        }
        return terminal;
    }
    function endTracking(outcome: SlackProgressOutcome, reason?: 'merged' | 'removed'): Promise<void> {
        return claimTerminal(async () => {
            await Promise.allSettled([
                display.finish(outcome, reason ? { reason } : {}), settleAck('failure'),
            ]);
        });
    }
    function resetTimer(): void {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void endTracking('expired'); }, started ? SLACK_RUN_IDLE_MS : SLACK_QUEUE_WAIT_MS);
        timer.unref?.();
    }
    function abortInput(): void {
        shutdownSealed = true;
        display.seal();
        void display.finish(executionOutcome ?? 'expired');
        void endTracking(executionOutcome ?? 'expired');
    }
    function queueHandler(type: string, data: Record<string, unknown>): void {
        if (disposed || !matches(data)) return;
        if (type === 'queued_run_started') return; // Global receipt owner captures the anchor synchronously.
        if (type === 'request_settled') {
            if (started) return; // The display owner latches outcomes; preserve salvage delivery.
            if (data['outcome'] === 'failed') void endTracking('error');
            if (data['outcome'] === 'cancelled') void endTracking('cancelled');
            if (data['outcome'] === 'dropped') void endTracking('cancelled', 'removed');
            if (data['outcome'] === 'merged') void endTracking('cancelled', 'merged');
            return;
        }
        if (type !== 'orchestrate_done' || data['origin'] !== 'slack') return;
        void claimTerminal(() => {
            let bodyActionStarted = false;
            return slackReplyDelivery.deliver(requestId, target, anchor => {
            bodyActionStarted = true;
            display.phase('delivering');
            return sessionLanes.runDetachedTurn(session.scope, async () => {
            let delivered = false;
            let confirmedDelivery = false;
            let outcomeData = data;
            try {
                if (!current()) { await Promise.allSettled([display.finish(executionOutcome ?? 'expired'), settleAck('failure')]); return; }
                const requireBodyDelivery = requiresNativeBodyDelivery(data);
                const rawText = String(data['text'] ?? '');
                const unconfirmed = data['workflowUnconfirmed'] === true || Boolean(options.workflow && isWorkflowReplyUnconfirmed(rawText, data));
                if (unconfirmed) outcomeData = { ...data, workflowUnconfirmed: true };
                const text = unconfirmed ? workflowDiagnosticText(rawText, t('slack.workflow.unconfirmed', {}, locale))
                    : data['error'] === true && !requireBodyDelivery ? t('slack.progress.failure', {}, locale)
                    : requireBodyDelivery && !rawText.trim() ? '' : rawText;
                display.phase('delivering');
                // Same rule as the direct path, and now literally the same code:
                // the queued/steer turn differs only in where its text and anchor
                // come from, and in keeping the image relay off the body's
                // cancellation domain (#686).
                await deliverSlackTurnBody({
                    token, target, text, data: outcomeData, signal, display, settleAck, current,
                    executionOutcome: () => executionOutcome,
                    since: anchor ?? observedAnchor,
                    skipSendIfEmpty: true,
                    relayMode: 'isolated',
                    relayWhenTextEmpty: false,
                    report: (sentOk, confirmed) => { delivered = sentOk; confirmedDelivery = confirmed; },
                    onRelayError: error => log.error('[slack:queue-relay]', logErrorText(error)),
                });
            } catch (error) {
                log.error('[slack:queue-send]', logErrorText(error));
                await Promise.allSettled([
                    settleAck('failure'),
                    display.finish(bodyProgressOutcome(outcomeData, delivered, executionOutcome, !current()), { bodyDelivered: confirmedDelivery }),
                ]);
            }
            });
            }).finally(async () => {
                if (!bodyActionStarted) {
                    await Promise.allSettled([display.finish(executionOutcome ?? 'expired'), settleAck('failure')]);
                }
            });
        }, true);
    }
    slackNoticeRecord.reserve(requestId, target);
    display = createSlackProgressLifecycle({
        token, target, requestId, scope: session.scope, sessionId: session.chatSessionId, locale,
        workflowResponse: Boolean(options.workflow),
        ...(options.workingDir ? { workingDir: options.workingDir } : {}),
        ...(recipientUserId ? { recipientUserId } : {}),
        registerTeardown: registerSlackProgressTeardown,
        onPosted: ts => slackNoticeRecord.attach(requestId, ts),
        onTerminalConfirmed: () => slackNoticeRecord.close(requestId),
        onExecutionOutcome: outcome => { executionOutcome = outcome; },
        onActivity: () => { if (started) resetTimer(); },
        onSeal: () => { shutdownSealed = true; void settleAck('failure'); void endTracking(executionOutcome ?? 'expired'); },
    });
    function observeStart(anchor: number): void {
        if (disposed || !current()) return;
        observedAnchor = slackReplyDelivery.started(requestId, target, session.scope, anchor);
        if (!started) { started = true; display.phase('running'); resetTimer(); }
    }
    activeSlackReplyTrackers.set(requestId, { options, start: observeStart });
    addBroadcastListener(queueHandler);
    pendingQueueRequestIds.add(requestId);
    signal.addEventListener('abort', abortInput, { once: true });
    resetTimer();
    display.start({ initialPhase });
    void ack?.to('running', { wasQueued: initialPhase === 'queued' });

}

function installSlackTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        observeSlackReplyControl(type, data);
        // Only captured queued/restart delivery authority can use this fallback.
        // Ordinary direct turns retain their awaiting dispatch owner.
        //
        // Errors included: after a restart there is no waiter to show them, so
        // dropping them here means the user's message vanishes without even a
        // failure notice.
        // A steered turn is the same shape of orphan as a queued one: ingress
        // returns early unless the disposition is new_run, so a mid-run steer leaves
        // NO waiter for the follow-up answer (#655). Accept all three identities.
        //
        // `observeSlackReplyControl` above stays OUTSIDE this admission: it acts on
        // steer/queue control events, not on `orchestrate_done`, and folding it in
        // would silence boot/orphan start proof and steer tracking.
        const admitted = admitTargetReply(type, data, {
            channel: 'slack',
            event: 'orchestrate_done',
            accept: ['fromQueue', 'fromSteer', 'replyViaTarget'],
            hasPendingWaiter: hasPendingQueueWaiter,
            stopping: () => slackStopping,
        });
        if (!admitted) return;
        const { target } = admitted;
        const token = getSlackSendClient().token;
        if (!token) return;
        const generation = lifecycleGeneration;
        const requireBodyDelivery = admitted.requireBodyDelivery;
        const text = data['workflowUnconfirmed'] === true
            ? workflowDiagnosticText(String(data['text'] ?? ''), t('slack.workflow.unconfirmed', {}, currentLocale()))
            : data['error'] === true && !requireBodyDelivery
            ? t('slack.progress.failure', {}, currentLocale()) : String(data['text'] ?? '');
        const requestId = admitted.requestId;
        const scope = slackReplyDelivery.scope(requestId, target)
            ?? (typeof data['scope'] === 'string' ? data['scope'] : 'default');
        void slackReplyDelivery.deliver(requestId, target, anchor => sessionLanes.runDetachedTurn(scope, async () => {
            if (generation !== lifecycleGeneration || slackStopping) return;
            if (!text || (requireBodyDelivery && !text.trim())) return;
            const outbound = slackOutboundRegistry.start();
            try {
                const alreadyDelivered = anchor !== undefined && wasSelfDelivered({ target, text, since: anchor });
                const result = alreadyDelivered ? { ok: true } : await sendSlackText(token, target, text, { signal: outbound.signal,
                    ...(requireBodyDelivery ? { requireBodyDelivery: true } : {}) });
                if (outbound.signal.aborted || generation !== lifecycleGeneration || slackStopping) return;
                if (!result.ok) {
                    log.error('[slack:target-reply]', logErrorText(result.error || 'send failed'));
                    return;
                }
                if (target.threadId) markThreadParticipated(target.targetId, target.threadId);
                // The answer is delivered, so the queue notice for this request
                // is now noise. The live waiter usually owns this; when the
                // forwarder delivers instead, it must also keep the promise.
                if (data["requestId"]) {
                    await closeSlackNoticeAsAnsweredByRequestId(String(data["requestId"]), token, outbound.signal, generation);
                }
                await relaySlackImages(token, target, text, { signal: outbound.signal });
            } catch (e) {
                log.error('[slack:target-reply]', logErrorText(e));
            } finally {
                outbound.done();
            }
        })).catch(error => log.error('[slack:target-reply]', logErrorText(error)));
    });
}

installSlackTargetReplyForwarder();

// ─── Dispatch (full reply path) ─────────────────────

async function slackOrchestrate(
    target: RemoteTarget,
    prompt: string,
    displayMsg: string,
    signal: AbortSignal,
    dedupe: {
        workflow?: SlackWorkflowMetadata;
        toolSource?: SlackToolSource;
        eventKey?: string;
        reservationGeneration?: number;
        preResolvedScope?: string | null;
        /** The inbound message's ts — the ACK reaction's anchor. Passed explicitly
         *  because this function cannot recover it, and the caller has it. */
        ackTs?: string;
        recipientUserId?: string;
        /** Ack scope inputs, resolved by the caller that knows the event shape. */
        isDirect?: boolean;
        isMention?: boolean;
    } = {},
) {
    const client = getSlackSendClient();
    if (!client.token) return;
    const token = client.token;
    const workingDir = typeof settings['workingDir'] === 'string' ? settings['workingDir'] : undefined;
    target = { ...target };
    const chatId = target.targetId;
    if (signal.aborted || slackStopping) return;
    // #321: the reservation was taken before an `await` and several early
    // returns. If a reset landed in that window this delivery belongs to a dead
    // generation — a redelivery has already re-reserved it, and admitting here
    // would run the same message twice.
    if (dedupe.reservationGeneration !== undefined
        && !isIngressGenerationCurrent(dedupe.reservationGeneration)) {
        log.info('[slack:in] skipped (stale_generation)');
        return;
    }
    // Built before admission: a queued turn never enters runReply (ingress.ts
    // returns early unless disposition is 'new_run'), so a handle created inside
    // it would never exist for exactly the case this feature is for.
    const ack = dedupe.ackTs
        ? buildSlackAck(token, target, dedupe.ackTs, {
            isDirect: dedupe.isDirect ?? false,
            isMention: dedupe.isMention ?? false,
        })
        : null;
    let result: ReturnType<typeof admitSlackRun>;
    slackReplyAdmissionDepth++;
    try {
        result = admitSlackRun({
        target, prompt, displayText: displayMsg, chatId,
        ...(dedupe.workflow ? { workflow: dedupe.workflow } : {}),
        ...(dedupe.toolSource ? { toolSource: dedupe.toolSource } : {}),
        ...(dedupe.preResolvedScope !== undefined
            ? { preResolvedScope: dedupe.preResolvedScope } : {}),
        runReply: async (ctx: SlackRunContext) => {
            const locale = currentLocale();
            const generation = lifecycleGeneration;
            let shutdownSealed = false;
            let executionOutcome: 'error' | 'cancelled' | undefined;
            let ackPromise: Promise<void> | null = null;
            const settleAck = (outcome: 'success' | 'failure'): Promise<void> => {
                ackPromise ??= ack?.settle(outcome) ?? Promise.resolve();
                return ackPromise;
            };
            let bodyAttempted = false;
            let bodySucceeded = false;
            let bodyConfirmed = false;
            let resultData: Record<string, unknown> = {};
            const current = () => !shutdownSealed && !slackStopping && !signal.aborted && generation === lifecycleGeneration;
            if (!current()) return;
            if (ctx.requestId) slackNoticeRecord.reserve(ctx.requestId, target);
            const display = createSlackProgressLifecycle({
                token, target, requestId: ctx.requestId, scope: ctx.scope, sessionId: ctx.chatSessionId, locale,
                workflowResponse: Boolean(dedupe.workflow),
                ...(workingDir ? { workingDir } : {}),
                ...(dedupe.recipientUserId ? { recipientUserId: dedupe.recipientUserId } : {}),
                registerTeardown: registerSlackProgressTeardown,
                onPosted: ts => slackNoticeRecord.attach(ctx.requestId, ts),
                onTerminalConfirmed: () => slackNoticeRecord.close(ctx.requestId),
                onExecutionOutcome: outcome => { executionOutcome = outcome; },
                onSeal: () => { shutdownSealed = true; void settleAck('failure'); },
            });
            const abortInput = () => {
                display.seal();
                void display.finish(executionOutcome ?? 'expired');
            };
            signal.addEventListener('abort', abortInput, { once: true });
            display.start({ initialPhase: 'running' });
            void ack?.to('running');
            const turnStartedAt = nextDeliverySeq();
            try {
                const collected = await withSessionScope(
                    { scope: ctx.scope, chatSessionId: ctx.chatSessionId },
                    () => orchestrateAndCollectData(prompt, {
                        origin: 'slack', target, chatId, requestId: ctx.requestId,
                        ...(dedupe.workflow ? { slackWorkflow: dedupe.workflow } : {}),
                        ...(dedupe.workflow?.runtimeCli || dedupe.workflow?.runtimeModel || dedupe.workflow?.runtimeEffort
                            ? { overrides: {
                                ...(dedupe.workflow.runtimeCli ? { cli: dedupe.workflow.runtimeCli } : {}),
                                ...(dedupe.workflow.runtimeModel ? { model: dedupe.workflow.runtimeModel } : {}),
                                ...(dedupe.workflow.runtimeEffort ? { effort: dedupe.workflow.runtimeEffort } : {}),
                            } } : {}),
                        ...(dedupe.toolSource ? { _strictRequestOwnership: true } : {}),
                        ...(ctx.remoteKey ? { remoteKey: ctx.remoteKey } : {}),
                        chatSessionId: ctx.chatSessionId, scope: ctx.scope, _skipInsert: true,
                    }),
                );
                resultData = collected.data;
                if (!current()) return;
                // A turn retired by a steer has no answer of its own: the follow-up
                // run owns it and the reply tracker delivers it. Posting the no-response
                // placeholder here is what the user saw right after steering (#655).
                if (resultData['superseded'] === true && !String(collected.text ?? '').trim()) {
                    log.info(`[slack:out:superseded] ${target.targetId}: retired by steer`);
                    await settleAck('success');
                    return;
                }
                const unconfirmed = resultData['workflowUnconfirmed'] === true || Boolean(dedupe.workflow && isWorkflowReplyUnconfirmed(collected.text, resultData));
                if (unconfirmed) resultData = { ...resultData, workflowUnconfirmed: true };
                const text = unconfirmed ? workflowDiagnosticText(collected.text, t('slack.workflow.unconfirmed', {}, locale))
                    : collected.data.collectionFailure === 'error' ? t('slack.progress.failure', {}, locale)
                    : collected.data.collectionFailure === 'timeout' ? t('tg.timeout', {}, locale) : collected.text;
                display.phase('delivering');
                await deliverSlackTurnBody({
                    token, target, text, data: resultData, signal, display, settleAck, current,
                    executionOutcome: () => executionOutcome,
                    since: turnStartedAt,
                    // The direct path posts even an empty body: sendSlackText owns
                    // the empty_message rule, and the collector already replaced a
                    // truly empty answer with its no-response placeholder.
                    skipSendIfEmpty: false,
                    relayMode: 'same-outbound',
                    relayWhenTextEmpty: true,
                    onAttempt: () => { bodyAttempted = true; },
                    report: (delivered, confirmed) => { bodySucceeded = delivered; bodyConfirmed = confirmed; },
                    onSent: alreadyDelivered => log.info(`[slack:out${alreadyDelivered ? ':skipped-self-delivered' : ''}] ${target.targetId}: ${redactOutboundText(text).slice(0, 80)}`),
                });
            } catch (err: unknown) {
                log.error('[slack:error]', logErrorText(err));
                if (current()) executionOutcome ??= 'error';
                // Never append a second diagnostic after an ambiguous body attempt.
                if (!bodyAttempted && current()) {
                    bodyAttempted = true;
                    const outbound = slackOutboundRegistry.start(signal);
                    try {
                        const diagnostic = await sendSlackText(token, target, t('slack.progress.failure', {}, locale), { signal: outbound.signal });
                        bodySucceeded = diagnostic.ok;
                        bodyConfirmed = diagnostic.ok && Boolean(diagnostic.ts);
                    } catch (error) { log.error('[slack:diagnostic]', logErrorText(error)); }
                    finally { outbound.done(); }
                }
            } finally {
                signal.removeEventListener('abort', abortInput);
                await settleAck('failure');
                await display.finish(bodyProgressOutcome(resultData, bodySucceeded, executionOutcome, !current()),
                    bodyAttempted ? { bodyDelivered: bodyConfirmed } : {});
            }
        },
        });
    } finally { slackReplyAdmissionDepth--; }
    // Durable commit AFTER admission, with no await in between: an event that
    // died before this line stays redeliverable, which is the whole point of
    // ordering it here rather than at reservation time.
    if (dedupe.eventKey && result.action !== 'rejected') commitSlackEvent(dedupe.eventKey);
    result.laneTail?.catch(error => log.error('[slack:lane]', logErrorText(error)));

    if (result.action === 'queued' || (result.action === 'started' && result.disposition === 'steered')) {
        const requestId = result.requestId;
        if (!requestId) { await ack?.settle('failure'); return; }
        const options: SlackReplyOptions = {
            ...(dedupe.workflow ? { workflow: dedupe.workflow } : {}),
            token, target, requestId, session: { ...result.sessionContext }, locale: currentLocale(),
            generation: lifecycleGeneration, signal, ack, ...(workingDir ? { workingDir } : {}), initialPhase: 'queued',
            ...(dedupe.recipientUserId ? { recipientUserId: dedupe.recipientUserId } : {}),
        };
        if (result.action === 'queued') trackSlackReply(options);
        else rememberPendingSteer(options);
        return;
    }

    if (result.action === 'rejected') {
        // The gateway dedup contract is "absorb silently" — the rejection
        // exists so the SAME message delivered twice costs nothing. Posting
        // ❌ for it is how one user message becomes a visible error.
        if (result.reason === 'duplicate') {
            log.info('[slack:duplicate] absorbed silently');
            return;
        }
        await sendSlackText(token, target, `❌ ${result.reason}`);
        return;
    }

}

type SlackTurnBodyOutcome = { delivered: boolean; confirmed: boolean; outcome: SlackProgressOutcome };

/**
 * The one place a Slack turn's answer reaches the wire (#686).
 *
 * The direct dispatch path and the queued/steer tracker each carried their own
 * copy of send -> early ACK -> progress finish -> image relay. Every delivery
 * fix therefore had to land twice, and the ones that did not became bugs only
 * the queued path kept (#655, #673).
 *
 * The two paths do genuinely disagree, so each disagreement is a PARAMETER
 * rather than a branch inside the spine: the caller derives its own text from
 * its own payload, brings its own delivery-ledger anchor, decides whether an
 * empty body is posted at all, and chooses whether the image relay shares the
 * body's cancellation domain. Collapsing those would silently change live
 * behaviour, which is why this is an extraction and not a merge.
 *
 * Deliberately NOT folded in: the orphan forwarder. It has no ACK handle and no
 * progress card, because it exists precisely for turns whose waiter is gone.
 */
async function deliverSlackTurnBody(options: {
    token: string;
    target: RemoteTarget;
    /** Already derived by the caller: the two paths read different payloads. */
    text: string;
    data: Record<string, unknown>;
    signal: AbortSignal;
    display: SlackProgressLifecycle;
    settleAck: (outcome: 'success' | 'failure') => Promise<void>;
    /** Re-read, never cached: liveness can flip part-way through a send. */
    current: () => boolean;
    executionOutcome: () => 'error' | 'cancelled' | undefined;
    /** Delivery-ledger anchor. Undefined skips the self-delivery check. */
    since: number | undefined;
    /** Queued: an empty body is never posted. Direct: sendSlackText decides. */
    skipSendIfEmpty: boolean;
    /** isolated: the relay gets its own registration and swallows its error.
     *  same-outbound: the relay shares the body's registration and may throw. */
    relayMode: 'isolated' | 'same-outbound';
    /** NOT the same switch as skipSendIfEmpty: the queued path also skips the
     *  IMAGE relay on an empty body, so one empty-text flag cannot serve both. */
    relayWhenTextEmpty: boolean;
    /** Mirrors the flags out as they change, so a caller's catch and finally see
     *  the same partial state the inline blocks used to leave behind. */
    report?: (delivered: boolean, confirmed: boolean) => void;
    /** Fires once the outbound registration exists, which is the moment the
     *  original inline blocks considered the body attempted. */
    onAttempt?: () => void;
    onSent?: (alreadyDelivered: boolean) => void;
    onRelayError?: (error: unknown) => void;
}): Promise<SlackTurnBodyOutcome> {
    const { token, target, text, data, signal, display, settleAck, current, executionOutcome } = options;
    const requireBodyDelivery = requiresNativeBodyDelivery(data);
    let bodySucceeded = false;
    let bodyConfirmed = false;
    const report = () => options.report?.(bodySucceeded, bodyConfirmed);
    const outbound = slackOutboundRegistry.start(signal);
    let outboundClosed = false;
    const closeOutbound = () => { if (!outboundClosed) { outboundClosed = true; outbound.done(); } };
    options.onAttempt?.();
    try {
        const skipped = options.skipSendIfEmpty && !text;
        const since = options.since;
        const alreadyDelivered = !skipped && since !== undefined
            && wasSelfDelivered({ target, text, since });
        const sent: { ok: boolean; ts?: string } = skipped ? { ok: false }
            : alreadyDelivered ? { ok: true }
            : await sendSlackText(token, target, text, {
                signal: outbound.signal, ...(requireBodyDelivery ? { requireBodyDelivery: true } : {}),
                onPosted: async () => {
                    // Every chunk is posted, so the answer is visible. Settle the
                    // ACK here: readback verification can take seconds per chunk
                    // and must not hold the reaction on running (#417).
                    bodySucceeded = true;
                    report();
                    const early = bodyProgressOutcome(data, true, executionOutcome(), !current());
                    await settleAck(early === 'complete' ? 'success' : 'failure');
                },
            });
        bodySucceeded = sent.ok;
        bodyConfirmed = alreadyDelivered || (sent.ok && Boolean(sent.ts));
        report();
        // The queued path closes the body registration before settling, so a late
        // image upload cannot keep the turn's outbound slot open.
        if (options.relayMode === 'isolated') closeOutbound();
        const outcome = bodyProgressOutcome(data, bodySucceeded, executionOutcome(), !current());
        if (bodySucceeded && target.threadId) markThreadParticipated(target.targetId, target.threadId);
        await settleAck(bodySucceeded && outcome === 'complete' ? 'success' : 'failure');
        await display.finish(outcome, { bodyDelivered: bodyConfirmed });
        if (current() && (options.relayWhenTextEmpty || Boolean(text))) {
            if (options.relayMode === 'isolated') {
                const relay = slackOutboundRegistry.start(signal);
                try { await relaySlackImages(token, target, text, { signal: relay.signal }); }
                catch (error) { options.onRelayError?.(error); }
                finally { relay.done(); }
            } else {
                await relaySlackImages(token, target, text, { signal: outbound.signal });
            }
        }
        if (!skipped) options.onSent?.(alreadyDelivered);
        return { delivered: bodySucceeded, confirmed: bodyConfirmed, outcome };
    } finally { closeOutbound(); }
}

function buildSlackFileFailureWarning(failed: readonly FailedSlackFile[], allFailed = false): string | null {
    if (!failed.length) return null;
    const locale = currentLocale();
    const items = failed.map(file => `- ${file.name}: ${t(`slack.files.error.${file.code}`, {}, locale)}`);
    return `${t(allFailed ? 'slack.files.allFailure' : 'slack.files.partialFailure', {}, locale)}\n${items.join('\n')}`;
}

export async function processSlackMessageEvent(
    event: SlackMessageEvent,
    target: RemoteTarget,
    text: string,
    signal: AbortSignal,
    opts: {
        workflowSelection?: SlackWorkflowSelection;
        socketTeamId?: string;
        prefetchToken?: number;
        prefetchOwner?: SessionOwnerToken;
        preResolvedScope?: string | null;
        eventKey?: string;
        reservationGeneration?: number;
    } = {},
): Promise<void> {
    // The claim was taken synchronously in handleSlackEnvelope, before this task
    // was queued. Every path out of here that did NOT inject history has to give
    // it back, or one skipped attempt silences the thread for the whole runtime.
    // The paths are many (empty prompt, all attachments failed, abort, continue
    // intent, config off, lookup failure, deadline), so the release is a finally
    // rather than a return-by-return audit.
    let prefetchCommitted = false;
    try {
        await runSlackMessageEvent(event, target, text, signal, opts, () => {
            prefetchCommitted = Boolean(opts.prefetchToken && opts.prefetchOwner) && commitThreadPrefetch(
                event.channel || '', event.thread_ts || '', opts.prefetchOwner!, opts.prefetchToken || 0,
            );
        });
    } finally {
        if (opts.prefetchToken && opts.prefetchOwner && !prefetchCommitted) {
            releaseThreadPrefetch(
                event.channel || '', event.thread_ts || '', opts.prefetchOwner, opts.prefetchToken,
            );
        }
    }
}

async function runSlackMessageEvent(
    event: SlackMessageEvent,
    target: RemoteTarget,
    text: string,
    signal: AbortSignal,
    opts: {
        workflowSelection?: SlackWorkflowSelection;
        socketTeamId?: string;
        prefetchToken?: number;
        prefetchOwner?: SessionOwnerToken;
        preResolvedScope?: string | null;
        eventKey?: string;
        reservationGeneration?: number;
    },
    commitPrefetch: () => void,
): Promise<void> {
    const files = event.files || [];
    let prompt = text;
    let displayText = text;
    const workflow = await prepareSlackWorkflow(event, gateConfig(), SKILLS_DIR, opts.workflowSelection);
    if (signal.aborted) return;
    if (workflow.kind === 'blocked') {
        log.warn('[slack:workflow] blocked', { code: workflow.code, channelId: target.targetId });
        const token = getSlackSendClient().token;
        if (token) {
            const sent = await sendSlackText(token, target, t('slack.workflow.unavailable', {}, currentLocale()));
            if (sent.ok && opts.eventKey) commitSlackEvent(opts.eventKey);
        }
        return;
    }
    // Start identity resolution alongside the downloads. Running them in series
    // would add a round trip to every attachment message.
    const identityPromise = resolveSenderIdentity(event, { signal });
    // Several paths below return before awaiting it (all files failed, ingress
    // reset). Absorb now so an early exit cannot leave a floating rejection.
    void identityPromise.catch(() => undefined);
    if (files.length) {
        const token = getSlackSendClient().token;
        if (!token) return;
        const { saved, failed } = await downloadAndSaveSlackFiles(token, files, { signal });
        if (signal.aborted) return;
        const visibleFailed = failed.filter(file => file.code !== 'ingress_cancelled');
        for (const file of failed) {
            const idSuffix = file.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6);
            log.info(`[slack:file] id=...${idSuffix} name=${file.name} code=${file.code}`);
        }
        const warning = buildSlackFileFailureWarning(visibleFailed, saved.length === 0);
        if (warning) await sendSlackText(token, target, warning).catch(() => undefined);
        if (!saved.length) return;
        prompt = buildMediaPromptMany(saved.map(file => file.filePath), text);
        displayText = saved.length === 1
            ? `[📎 ${saved[0]!.name}] ${text}`.trim()
            : `[📎 ${saved.length} files] ${text}`.trim();
    }
    if (!prompt || signal.aborted) return;
    const identity = await identityPromise;
    // The gateway reads continue intent from the prompt body itself
    // (gateway.ts:234). A sender line in front of "계속" stops it being a
    // continuation, so control text travels undecorated. Reset is already
    // intercepted upstream and never reaches here.
    if (workflow.kind === 'ready' || !isContinueIntent(prompt)) {
        // A configured workflow ticket is self-contained. Injecting recent
        // top-level channel history puts sibling tickets into the same prompt,
        // which can make one lane execute other experiments and collide with
        // their owners. Ordinary human/chat turns keep their existing context.
        const block = workflow.kind === 'ready'
            ? ''
            : await buildInboundContextBlock(event, identity, signal, opts, commitPrefetch);
        // An empty block lands EXACTLY on the previous behavior: config off and
        // total lookup failure must be indistinguishable from before this
        // feature existed.
        prompt = block
            ? applySlackContext(block, prompt)
            : buildSenderPrompt(identity, prompt);
        // Display text is unchanged either way: the UI/DB bubble shows who sent
        // the message, and the conversation is already obvious in Slack's own UI.
        displayText = buildSenderDisplay(identity, displayText);
    }
    if (workflow.kind === 'ready') {
        prompt = renderSlackWorkflow(workflow, prompt);
        log.info('[slack:workflow] routed', workflow.metadata);
    }
    // A trigger rule with `parallelLane` gives this one message its own run
    // lane: a batch of workflow tickets posted to one channel then runs
    // concurrently (bounded by multiSession.maxConcurrent) instead of queueing
    // behind the conversation's single lane. Nothing else changes — the reply
    // target, chat session and delivery keys are untouched, and every message
    // outside this rule keeps the conversation lane it has today.
    // The caller always pre-resolves the conversation scope; a lane request
    // replaces that resolution for this one message.
    const laneScope = workflow.kind === 'ready' && workflow.metadata.parallelLane === true
        && settings["multiSession"]?.enabled === true
        ? `${buildRemoteBindingKey(target)}:lane:${workflow.metadata.messageTs}`
        : undefined;
    if (laneScope) log.info('[slack:workflow] lane', { scope: laneScope });
    const sourceToken = getSlackSendClient().token;
    const workspace = sourceToken && opts.socketTeamId ? await verifiedSlackWorkspace(sourceToken).catch(() => null) : null;
    if (signal.aborted) return;
    const toolSource: SlackToolSource | undefined = workspace && workspace.teamId === opts.socketTeamId && event.user && sourceToken
        ? { teamId: workspace.teamId, actorId: event.user, destination: target, credentialKey: slackCredentialKey(sourceToken),
            ...(typeof event.action_token === 'string' ? { actionToken: event.action_token } : {}) } : undefined;
    await slackOrchestrate(target, prompt, displayText, signal, {
        ...(workflow.kind === 'ready' ? { workflow: workflow.metadata } : {}),
        ...(toolSource ? { toolSource } : {}),
        ...(opts.eventKey ? { eventKey: opts.eventKey } : {}),
        ...(opts.reservationGeneration !== undefined
            ? { reservationGeneration: opts.reservationGeneration } : {}),
        ...(laneScope !== undefined ? { preResolvedScope: laneScope }
            : opts.preResolvedScope !== undefined ? { preResolvedScope: opts.preResolvedScope } : {}),
        // The ACK anchor is the user's own message. Only this caller has the raw
        // event, so the scope inputs are resolved here rather than re-derived.
        ...(event.ts ? { ackTs: event.ts } : {}),
        ...(event.user ? { recipientUserId: event.user } : {}),
        isDirect: event.channel_type === 'im',
        // A trusted bot trigger is addressed to this instance as surely as a
        // human mention, and `isSlackMention` deliberately stays narrow.
        isMention: isSlackMention(event, selfUserId) || matchesTrustedBotTrigger(event, gateConfig()),
    });
}

/**
 * Inbound deadline for the whole context phase.
 *
 * Larger than identity's 400ms because this is up to two round trips, but still
 * a hard bound: naming a conversation must never hold a user's message. Work
 * that outlives the deadline keeps running and warms the cache, so the next
 * message in the same conversation gets the full block.
 */
// Two round trips against Slack, so 700ms lost the race often enough that the
// first message in a thread — the only one carrying history — regularly arrived
// with no context at all. The socket acks BEFORE dispatch (socket.ts), so a
// longer deadline cannot cause redelivery; it only delays this one reply (#518).
const INBOUND_CONTEXT_DEADLINE_MS = 2500;

async function buildInboundContextBlock(
    event: SlackMessageEvent, identity: SlackIdentity, signal: AbortSignal,
    opts: { prefetchToken?: number; preResolvedScope?: string | null } = {},
    commitPrefetch: () => void = () => { },
): Promise<string> {
    const channel = event.channel || '';
    // The caller's finally releases an uncommitted claim, so early returns here
    // need no cleanup of their own.
    if (settings["slack"]?.conversationContext === false) return '';
    if (!channel) return '';
    const token = getSlackSendClient().token;
    if (!token) return '';
    const teamId = String(settings["slack"]?.teamId || 'unknown');
    const threadTs = event.thread_ts || '';

    const work = (async (): Promise<string> => {
        // First entry into a conversation already in progress: give the agent
        // what was said before it was pulled in. Once only per owner generation
        // (thread-tracker claim) — later messages ride the agent session, and
        // re-injecting would waste tokens and Tier 3 budget.
        const shouldPrefetch = Boolean(opts.prefetchToken) || opts.preResolvedScope === null;
        // A top-level channel message has no thread to read; the channel's own
        // recent history (ending before this event) is its context (#518 r2).
        const isTopLevelChannel = !threadTs
            && (event.channel_type === 'channel' || event.channel_type === 'group' || event.channel_type === 'mpim');
        // Independent lookups: serial would double the round trips inside a
        // deadline that exists to stay small.
        const [conversation, thread, channelHistory] = await Promise.all([
            resolveConversationInfo(token, channel, { teamId, signal }),
            threadTs
                ? resolveThreadInfo(token, channel, threadTs, { teamId, signal })
                : Promise.resolve(undefined),
            // Paced like the other Tier-3 lookups: declined rather than queued,
            // and a declined window just means this message goes without.
            shouldPrefetch && isTopLevelChannel && event.ts && admitHistoryStart()
                ? fetchSlackHistory(token, channel, {
                    latest: event.ts, limit: THREAD_FETCH_LIMIT,
                    noRetryOnRateLimit: true, signal,
                })
                : Promise.resolve(undefined),
        ]);
        const roster = await resolveRosterContext(token, channel, teamId, conversation.kind, signal);
        const block = buildSlackContextBlock({
            identity, conversation, ...(thread ? { thread } : {}),
            ...(roster ? { roster } : {}), selfUserId,
        });
        const messages = thread?.resolved && thread.messages?.length
            ? thread.messages
            : channelHistory?.ok ? channelHistory.messages : [];
        if (!shouldPrefetch || !messages.length) return block;
        // The current message is already the prompt body; repeating it here
        // would show the agent its own input twice.
        const prior = messages.filter(message => message.ts !== event.ts);
        if (!prior.length) return block;
        const authorIds = prior.map(message => message.user || message.botId || '').filter(Boolean);
        const preamble = buildThreadPreamble(
            formatHistoryForAgent(prior, selfUserId, cachedNameMap(teamId, authorIds)),
            thread?.replyCount ?? prior.length,
            thread,
        );
        if (!preamble) return block;
        // History is actually going into the prompt: the claim is spent.
        commitPrefetch();
        return block ? `${block}\n${preamble}` : preamble;
    })();

    return raceContextDeadline(work, INBOUND_CONTEXT_DEADLINE_MS);
}

/** Opt-in channel roster. Off by default: see 021 contract §설정. */
async function resolveRosterContext(
    token: string, channel: string, teamId: string,
    kind: string, signal: AbortSignal,
): Promise<{ names: string[]; total: number; approximate?: boolean } | undefined> {
    if (settings["slack"]?.channelRoster !== true) return undefined;
    // In a DM the other party is the sender; a roster line would just repeat it.
    if (kind === 'dm') return undefined;
    const result = await fetchSlackChannelMembers(token, channel, { teamId, signal, limit: 200 });
    if (!result.ok) return undefined;
    const humans = result.members.filter(member => !member.isBot);
    return {
        names: humans.slice(0, ROSTER_PREVIEW).map(member => member.name),
        total: humans.length,
        // The walk is page-bounded, so a truncated result is a lower bound.
        ...(result.hasMore ? { approximate: true } : {}),
    };
}

function raceContextDeadline(work: Promise<string>, ms: number): Promise<string> {
    return new Promise<string>(resolve => {
        const timer = setTimeout(() => resolve(''), ms);
        // unref: a pending deadline must never hold the process open.
        timer.unref?.();
        void work.then(
            value => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(''); },
        );
    });
}


// ─── Durable ingress preflight (M3c) ────────────────

/**
 * Journals a Slack event BEFORE the socket acknowledges it. Runs the same gate the
 * dispatch path runs, because Slack sends a `message` copy and an `app_mention` copy
 * of one mention under a shared ts: journaling the copy the gate drops would claim
 * the key and suppress the canonical delivery.
 *
 * Throws when the journal write fails. That is deliberate — the socket layer turns a
 * throw into a withheld ack, so Slack redelivers instead of considering a message it
 * never recorded as delivered.
 */
export async function preflightSlackEnvelope(envelope: SlackEnvelope): Promise<SlackPreflightResult> {
    if (envelope.type !== 'events_api') return 'committed';

    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event?.channel || !event?.ts) return 'committed';

    // BEFORE the gate, and before the journal short-circuit, because this is the
    // only place a third-party mention is ever seen. The gate is about to drop it
    // — correctly, since the bot was not addressed — and conversations.history
    // will never show it again if it lives inside a thread. Capturing here is
    // what makes a thread reply answerable at all.
    captureMentionWatchInbox(event);

    const journal = getIngressJournal();
    if (!journal) return 'committed';

    const decision = shouldProcessSlackEvent(event, gateConfig(), envelope.type);
    if (!decision.process) {
        // The dispatch consumer of this gate logs its reason (see the
        // handleSlackEvent path below); this one did not. That asymmetry is why
        // an allowlist mistake reads as "the bot is dead": preflight drops the
        // event, nothing ever reaches dispatch, and nothing is logged (#406).
        //
        // Only channel_not_allowed. self_message, bot_message and the
        // app_mention/message duplicate are ordinary traffic that would bury the
        // one reason that means a human configured us out of a conversation.
        if (decision.reason === 'channel_not_allowed') {
            log.info(`[slack:gate] dropped ${event.channel} (channel_not_allowed)`);
        }
        return 'ignored';
    }

    const inbound = slackInboundEnvelope({
        teamId: String(settings['slack']?.teamId || ''),
        channelId: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        userId: event.user,
        botId: event.bot_id,
        envelopeId: envelope.envelope_id,
        replyInThread: settings['slack']?.replyInThread !== false,
        target: buildSlackTarget(event),
    });
    if (!inbound) return 'committed';

    const admission = admitIngress(journal, inbound, slackPayloadDigest(event), undefined, inbound ? currentGenerationForEnvelope(inbound) : 0);
    if (!admission.admit) return 'duplicate';
    stashSlackAdmission(envelope, admission);
    return 'committed';
}

const SLACK_ADMISSION_TTL_MS = 10 * 60 * 1000;
const slackAdmissions = new Map<string, { admission: IngressAdmission; expiresAt: number }>();

function slackAdmissionKey(envelope: SlackEnvelope): string {
    if (envelope.envelope_id) return `eid:${envelope.envelope_id}`;
    const event = (envelope.payload as { event?: SlackMessageEvent } | undefined)?.event;
    const team = String(settings['slack']?.teamId || '');
    if (event?.channel && event?.ts && team) return `ev:${team}:${event.channel}:${event.ts}`;
    return '';
}

function stashSlackAdmission(envelope: SlackEnvelope, admission: IngressAdmission): void {
    const key = slackAdmissionKey(envelope);
    if (!key || !admission.admit || !admission.journaled) return;
    const now = Date.now();
    for (const [held, row] of slackAdmissions) {
        if (row.expiresAt <= now) slackAdmissions.delete(held);
    }
    if (slackAdmissions.size >= 256) {
        const first = slackAdmissions.keys().next().value;
        if (first) slackAdmissions.delete(first);
    }
    slackAdmissions.set(key, { admission, expiresAt: now + SLACK_ADMISSION_TTL_MS });
}

function takeSlackAdmission(envelope: SlackEnvelope): IngressAdmission | undefined {
    const key = slackAdmissionKey(envelope);
    if (!key) return undefined;
    const row = slackAdmissions.get(key);
    slackAdmissions.delete(key);
    if (!row || row.expiresAt <= Date.now()) return undefined;
    return row.admission;
}

function settleSlackAdmission(admission: IngressAdmission | undefined, error?: unknown): void {
    if (!admission) return;
    settleIngress(
        getIngressJournal(),
        admission,
        error,
        error === undefined ? undefined : { onError: 'dead_letter' },
    );
}

/** Identity of the event body. Never the body itself: the journal is not an archive. */
function slackPayloadDigest(event: SlackMessageEvent): string {
    return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

// ─── Envelope routing ───────────────────────────────


function slackInteractiveUserId(payload: Record<string, unknown>): string {
    const user = payload['user'];
    if (typeof user === 'string') return user;
    if (user && typeof user === 'object' && 'id' in user) return String((user as { id: unknown }).id);
    return '';
}
export async function handleSlackEnvelope(envelope: SlackEnvelope, approvalTransport = slackApprovalIngress): Promise<void> {
    const admission = takeSlackAdmission(envelope);
    let settled = false;
    const settleOk = (): void => {
        if (settled) return;
        settled = true;
        settleSlackAdmission(admission);
    };
    const settleErr = (error: unknown): void => {
        if (settled) return;
        settled = true;
        settleSlackAdmission(admission, error);
    };
    if (envelope.type === 'slash_commands') {
        await handleSlackSlashCommand(envelope.payload || {});
        return;
    }
    if (envelope.type === 'interactive') {
        const payload = envelope.payload || {};
        const actions = payload['actions'];
        const actionId = Array.isArray(actions) && actions[0] && typeof actions[0] === 'object'
            ? String((actions[0] as { action_id?: unknown })['action_id'] || '')
            : '';
        const parsed = parseApprovalCallbackData(actionId);
        if (!parsed) {
            const token = getSlackSendClient().token;
            if (token) {
                const { consumeSlackInteractionCallback } = await import('./actions-interactions.js');
                await consumeSlackInteractionCallback(payload, token);
            }
            log.info('[slack:interactive] received (not an approval action)');
            return;
        }
        const result = handleApprovalCallback(
            approvalTransport,
            payload,
            parsed.opaqueId,
            parsed.action,
            {
                conversationKey: slackInteractiveUserId(payload),
                sessionGeneration: 0,
            },
        );
        const reply = result.approved ? 'approved' : (result.reason || 'rejected');
        const channel = typeof payload['channel'] === 'object' && payload['channel']
            ? String((payload['channel'] as { id?: unknown })['id'] || '')
            : '';
        const token = getSlackSendClient().token;
        if (token && channel) {
            await sendSlackText(token, slackTargetFromId(channel), redactOutboundText(reply)).catch(() => undefined);
        }
        return;
    }
    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event) {
        settleOk();
        return;
    }

    const receiveGate = gateConfig();
    const workflowSelection = captureSlackWorkflow(event, receiveGate);
    const approval = workflowSelection.kind === 'none' ? handleApprovalCommand(approvalTransport, {
        ...event,
        __jawSelf: Boolean(event.user && event.user === getSlackSelfUserId()),
    }, String(event.text || '')) : { handled: false };
    if (approval.handled) {
        settleOk();
        return;
    }

    const target = buildSlackTarget(event);
    const decision = shouldProcessSlackEvent(event, receiveGate, envelope.type);
    if (!decision.process) {
        log.info(`[slack:in] skipped (${decision.reason})`);
        settleOk();
        return;
    }
    // Carried to the admission site so the durable commit happens only after a
    // run is accepted, and so a reset in between invalidates this delivery.
    let reservedEventKey: string | undefined;
    let reservationGeneration: number | undefined;
    // Message-level dedupe goes HERE — after the gate, before identity resolution.
    // After the gate, because Slack delivers a `message` copy and an `app_mention`
    // copy of one mention under the same ts; the gate drops the former, and letting
    // a dropped copy claim the key would suppress the canonical one and swallow the
    // mention. Before resolution, because the downstream dedupKey hashes the prompt
    // body, so a sender name that resolves on one delivery and degrades on the next
    // would split the key and run the same message twice.
    if (event.channel && event.ts) {
        const eventKey = slackEventKey(
            String(settings["slack"]?.teamId || ''), event.channel, event.ts,
        );
        if (claimSlackEvent(eventKey)) {
            log.info('[slack:in] skipped (duplicate_event)');
            settleOk();
            return;
        }
        reservedEventKey = eventKey;
        reservationGeneration = currentIngressGeneration();
    }
    const preResolvedScope = resolveSlackScopeForTarget(target);
    const prefetchOwner = preResolvedScope
        ? getSessionOwnershipGeneration(preResolvedScope)
        : undefined;
    if ((isSlackMention(event, selfUserId) || matchesTrustedBotTrigger(event, gateConfig())) && event.channel) {
        // A top-level mention starts a thread the bot will parent, so the whole
        // thread belongs to it. A mention INSIDE an existing thread is an
        // invitation into someone else's conversation, and only that (#400).
        markThreadParticipated(
            event.channel,
            event.thread_ts || event.ts || '',
            event.thread_ts ? 'joined' : 'owned',
        );
        if (!event.thread_ts && event.ts) {
            // A thread WE start needs no history: the parent mention and our
            // reply are already the session's own context. Spend the claim now
            // so the first follow-up does not re-inject what the agent said.
            if (prefetchOwner) {
                const token = claimThreadPrefetch(event.channel, event.ts, prefetchOwner);
                commitThreadPrefetch(event.channel, event.ts, prefetchOwner, token);
            }
        }
    }
    // Claim the one-time thread prefetch HERE, synchronously, before the ingress
    // task is queued. Asking inside the queue task instead would be a dead
    // branch for app_mention (the mark above already ran) and a race for
    // DM/listen-all channels (they are marked only after a successful reply,
    // which is not awaited). On the accepted message-event path no `await` runs
    // between this function's entry and this line, so the test-and-set is atomic
    // against a second envelope in the same tick.
    const prefetchSubject = event.thread_ts
        ?? ((event.channel_type === 'channel' || event.channel_type === 'group' || event.channel_type === 'mpim') ? '' : undefined);
    const prefetchToken = prefetchSubject !== undefined && prefetchOwner
        ? claimThreadPrefetch(event.channel || '', prefetchSubject, prefetchOwner)
        : 0;
    let prefetchHandedOff = false;
    try {
        setLastActiveTarget('slack', target);
        setLatestSeenTarget('slack', target);

        const text = resolveEventText(event, selfUserId);
        let hasFiles = Boolean(event.files?.length);
        // app_mention 봉투에는 files 가 없고, 첨부를 가진 message 사본은 위
        // shouldProcessSlackEvent 에서 mention_via_app_mention 으로 드롭된다.
        // 그래서 멘션과 함께 올린 파일은 여기서 되찾지 않으면 영영 사라진다.
        // app_mention envelopes drop files, so they need the history recovery.
        // A message.mpim mention already carries its files inline; when it has
        // none there is no twin envelope to recover from, only a wasted call.
        if (!hasFiles && event.type === 'app_mention' && isSlackMention(event, selfUserId) && event.channel && event.ts) {
            const recoverToken = getSlackSendClient().token;
            if (recoverToken) {
                const recovered = await recoverSlackAttachments(
                    recoverToken, event.channel, event.ts,
                    event.thread_ts ? { threadTs: event.thread_ts } : {},
                );
                if (recovered.length) {
                    event.files = recovered;
                    hasFiles = true;
                    log.info(`[slack:recover] ${event.channel} ts=${event.ts}: ${recovered.length} attachment(s)`);
                }
            }
        }
        if (!text && !hasFiles) {
            settleOk();
            return;
        }
        if (text) log.info(`[slack:in] ${event.channel}: ${redactOutboundText(text).slice(0, 80)}`);

        if (!hasFiles && workflowSelection.kind === 'none' && isResetIntent(text)) {
            const client = getSlackSendClient();
            const result = submitMessage(text, { origin: 'slack', target });
            if (client.token) {
                await sendSlackText(client.token, target, result.action === 'rejected'
                    ? t('ws.agentBusy', {}, currentLocale())
                    : t('tg.resetDone', {}, currentLocale()));
            }
            settleOk();
            return;
        }

        prefetchHandedOff = enqueueSlackIngress(slackIngressLaneKey(target), async signal => {
            try {
                await processSlackMessageEvent(event, target, text, signal, {
                    workflowSelection,
                    ...(typeof envelope.payload?.['team_id'] === 'string' ? { socketTeamId: envelope.payload['team_id'] } : {}),
                    prefetchToken,
                    ...(prefetchOwner ? { prefetchOwner } : {}),
                    preResolvedScope,
                    ...(reservedEventKey ? { eventKey: reservedEventKey } : {}),
                    ...(reservationGeneration !== undefined ? { reservationGeneration } : {}),
                });
                settleOk();
            } catch (error) {
                settleErr(error);
                throw error;
            }
        });
        if (!prefetchHandedOff) settleErr(new Error('enqueue_refused'));
    } catch (error) {
        settleErr(error);
        throw error;
    } finally {
        if (prefetchToken && prefetchOwner && !prefetchHandedOff) {
            releaseThreadPrefetch(
                event.channel || '', event.thread_ts || '', prefetchOwner, prefetchToken,
            );
        }
    }
}

// ─── Init / Shutdown ────────────────────────────────

export async function initSlack(ctx?: TransportInitContext): Promise<TransportStartOutcome> {
    if (slackInitLock) {
        // Do not discard the request: the running init may be about to abort
        // because THIS caller's shutdown superseded it.
        log.info('[slack] initSlack already in progress — queuing a follow-up');
        initRequestPending = true;
        return transportNotStarted('superseded');
    }
    slackInitLock = true;
    let outcome: TransportStartOutcome;
    try {
        outcome = await runSlackInit(ctx);
    } catch (err) {
        // A thrown init still owes the queue a drain, exactly as the old
        // `finally` did — otherwise a crash mid-start leaves Slack off until
        // something unrelated happens to call init again.
        await settleSlackInit(ctx);
        throw err;
    }
    // The follow-up is the call that actually opened the socket; this one only
    // lost the race, so its `superseded` outcome must not shadow the real one.
    return (await settleSlackInit(ctx)) ?? outcome;
}

/**
 * Release the lock, then run a queued request and hand back ITS outcome
 * (`null` when nothing was queued). Deliberately not a `finally` block: that
 * can only replace a return value by returning from `finally`, which also
 * swallows in-flight throws. Order is unchanged — the lock is dropped before
 * the follow-up runs, so the retry takes the normal path rather than queuing
 * itself forever.
 */
async function settleSlackInit(ctx?: TransportInitContext): Promise<TransportStartOutcome | null> {
    slackInitLock = false;
    if (!initRequestPending) return null;
    initRequestPending = false;
    return initSlack(ctx);
}

/** The init body proper. Runs only under `slackInitLock`. */
async function runSlackInit(ctx?: TransportInitContext): Promise<TransportStartOutcome> {
    // Claim the generation FIRST so an external shutdown that lands while
    // we are tearing down or authenticating is not lost, then tear down
    // WITHOUT bumping it — an internal teardown must not invalidate the
    // init it belongs to.
    const generation = ++lifecycleGeneration;
    await disposeSlackRuntime();
    if (generation !== lifecycleGeneration) return transportNotStarted('superseded');
    const sc = settings["slack"];
    if (!sc?.enabled || !sc?.botToken) {
        log.info('[slack] ⏭️  Slack pending (disabled or no bot token)');
        return transportNotStarted('not_configured');
    }
    slackStopping = false;
    if (!sc.appToken) {
        // Outbound still works via the send transport; only inbound needs
        // the app-level token. Say so precisely instead of "failed".
        log.warn('[slack] app-level token missing — outbound only, no inbound events');
        return transportNotStarted('outbound_only');
    }
    // An explicit owner is fail-closed. An unset owner gets one provisional
    // connection attempt; only a successful socket start may elect this port.
    const attachPort = String(sc.attachPort ?? '').trim();
    const currentPort = String(settings["port"] ?? '').trim();
    const selfElectionPending = !attachPort && Boolean(currentPort);
    if (!selfElectionPending && !shouldAttachSlack(attachPort, currentPort)) {
        log.info(`[slack] not the attach instance (attach port ${attachPort || 'unset'}, this :${currentPort || 'unset'}) — socket not opened`);
        return transportNotStarted('not_attach_instance');
    }

    const auth = await slackApi<{ user_id?: string; team_id?: string }>(sc.botToken, 'auth.test');
    // A shutdown may have landed while auth.test was in flight; resuming
    // here would resurrect a transport the caller asked us to stop.
    if (generation !== lifecycleGeneration) {
        log.info('[slack] init superseded during auth — aborting');
        return transportNotStarted('superseded');
    }
    if (!auth.ok) {
        log.error('[slack] auth.test failed:', auth.error);
        return transportNotStarted('failed', 'auth_test_failed');
    }
    selfUserId = auth.data?.user_id || null;
    // The grant is whatever the app was installed with, not whatever the
    // current manifest asks for. Record it here — auth.test already ran, so
    // this costs nothing — and say the whole gap once instead of leaking one
    // scope per failed call from identity.ts (#340).
    //
    // Deliberately behind the earlier returns: an unconfigured, outbound-only,
    // non-attach or superseded init has either no token to ask with or no
    // ownership of this workspace. Outbound-only is the one real gap; it still
    // makes Web API calls but never reaches here, and moving auth.test above
    // that return would make an unconfigured channel hit the network on every
    // start. Documented as a known limitation rather than silently ignored.
    recordSlackScopeObservation(auth.grantedScopes, null);
    for (const gap of describeSlackScopeGaps(getSlackScopeStatus())) {
        // Each group logs at its own level: a missing required scope is a real
        // break, a missing optional one is not, and one shared WARN made them
        // indistinguishable (#478).
        const emit = gap.level === 'warn' ? log.warn : log.info;
        emit(`[slack:scopes] ${gap.text}`);
    }
    // A trusted-trigger list that fails validation is refused whole and in
    // silence, which reads exactly like a bot that never posted. Say it once at
    // boot so a typo is a visible mistake instead of a trigger that vanished.
    const declaredTriggers = Array.isArray(sc.trustedBotTriggers) ? sc.trustedBotTriggers.length : 0;
    if (declaredTriggers > 0) {
        const usable = readTrustedBotTriggers(sc.trustedBotTriggers).length;
        if (usable === 0) {
            log.warn(`[slack:triggers] ${declaredTriggers} trusted bot trigger(s) configured but the list is invalid, so none of them can start a turn — every rule needs channelId (C/G), botId (B), userId (U/W), an uppercase textMarker and, optionally, a valid workflowSkill ID`);
        } else {
            log.info(`[slack:triggers] ${usable} trusted bot trigger(s) active`);
        }
    }
    if (auth.data?.team_id && !sc.teamId) sc.teamId = auth.data.team_id;
    // The team id namespaces every ingress dedup key, and `slackEventKey`
    // degrades an empty one to the literal 'unknown' — so two workspaces,
    // or one workspace across a restart, would share a key space and drop
    // each other's messages as duplicates. Refuse to open the socket at
    // all, the same way Telegram refuses to poll when getMe yields no id.
    if (!String(sc.teamId ?? '').trim()) {
        log.error(logErrorText('[slack] refusing to start inbound: workspace (team) id could not be resolved'));
        return transportNotStarted('failed', 'team_id_unresolved');
    }

    const sharingAllowed = process.env['CLI_JAW_SLACK_ALLOW_SHARED_TOKEN'] === '1';
    if (sharingAllowed && !sharedTokenOptOutLogged) {
        sharedTokenOptOutLogged = true;
        log.info('[slack] shared app-token ownership guard disabled by environment');
    }
    if (!sharingAllowed) {
        const observed = inspectSlackTokenClaim({
            appToken: sc.appToken,
            home: JAW_HOME,
            port: currentPort,
            connected: true,
        });
        if (observed.kind === 'foreign_live') {
            log.warn(`[slack] app token is claimed by another home (${observed.claim.home}, :${observed.claim.port}, pid ${observed.claim.pid})`);
            armSlackClaimRecheck(generation);
            return transportNotStarted('token_shared_other_home');
        }
        if (observed.kind === 'uncertain') {
            log.warn('[slack] token claim inspection unavailable; failing open:', logErrorText(observed.error));
        }
    }

    let arb: ClaimArbiter | null = null;
    const client = new SlackSocketClient({
        appToken: sc.appToken,
        onEnvelope: envelope => handleSlackEnvelope(envelope, slackApprovalIngress),
        preflightEnvelope: preflightSlackEnvelope,
        onStateChange: (state: SlackConnectionState) => {
            if (!arb || sharingAllowed) return;
            if (client !== socketClient || generation !== lifecycleGeneration) {
                arb.releaseOwnLeaseOnly();
                return;
            }
            if (state === 'connected') {
                void arb.arbitrate('hello').then(result => {
                    if (result.kind !== 'foreign_live') return;
                    arb?.applyForeignLiveOnce(() => {
                        client.stop();
                        if (socketClient === client) socketClient = null;
                        revokeMessagingTransport('slack', 'token_shared_other_home', ctx?.startEpoch ?? 0);
                        armSlackClaimRecheck(generation);
                    });
                });
            } else if (state === 'reconnecting') {
                arb.noteDisconnected();
            } else if (state === 'disconnected' || state === 'disabled') {
                arb.releaseOwnLeaseOnly();
            }
        },
    });
    arb = createClaimArbiter({
        generation,
        client,
        startEpoch: ctx?.startEpoch ?? 0,
        appToken: sc.appToken,
        home: JAW_HOME,
        port: currentPort,
    });
    activeClaimArbiter = arb;
    slackApprovalIngress = createSlackSocketIngress();
    socketClient = client;
    try {
        await client.start();
    } catch (error) {
        client.stop();
        if (socketClient === client) socketClient = null;
        arb.releaseOwnLeaseOnly();
        throw error;
    }
    const ready = await client.waitForReady(HELLO_DEADLINE_MS + 1000);
    if (generation !== lifecycleGeneration) {
        log.info('[slack] init superseded during connect — disposing socket');
        client.stop();
        if (socketClient === client) socketClient = null;
        arb.releaseOwnLeaseOnly();
        return transportNotStarted('superseded');
    }
    if (ready === 'stopped') {
        if (socketClient === client) socketClient = null;
        arb.releaseOwnLeaseOnly();
        return transportNotStarted('superseded');
    }
    if (!sharingAllowed) {
        const claim = ready === 'connected'
            ? await arb.arbitrate('init')
            : ready === 'timeout'
                ? arb.recordPresence()
                : null;
        if (claim?.kind === 'unavailable') {
            log.warn('[slack] shared token claim unavailable; failing open:', logErrorText(claim.error));
        }
        if (claim?.kind === 'foreign_live') {
            arb.applyForeignLiveOnce(() => {
                client.stop();
                if (socketClient === client) socketClient = null;
                revokeMessagingTransport('slack', 'token_shared_other_home', ctx?.startEpoch ?? 0);
                armSlackClaimRecheck(generation);
            });
            return transportNotStarted('token_shared_other_home');
        }
    }
    if (selfElectionPending) {
        // Two processes of the SAME home with attachPort unset can both reach
        // this line (different ports bind fine; the pidfile is written, not
        // acquired). Re-read the file right before writing so the second one
        // sees the first one's election and yields instead of overwriting it.
        // This narrows the race to read→write, it does not close it; the
        // operator-set attachPort (jaw slack setup) remains the strong form.
        const onDisk = readPersistedSlackAttachPort();
        if (onDisk && onDisk !== currentPort) {
            log.info(`[slack] another instance (:${onDisk}) elected itself first — disposing socket`);
            client.stop();
            if (socketClient === client) socketClient = null;
            arb.releaseOwnLeaseOnly();
            return transportNotStarted('not_attach_instance');
        }
        if (isSettingsPersistenceBlocked()) {
            log.warn('[slack] attach-port self-election could not be persisted; keeping this successful socket for the current boot');
        } else {
            try {
                saveSettings({
                    ...settings,
                    slack: { ...sc, attachPort: currentPort },
                });
            } catch (error) {
                log.warn('[slack] attach-port self-election persist failed; keeping this successful socket for the current boot:', logErrorText(error));
            }
        }
    }

    forwarderHandler = createSlackForwarder({
        getToken: () => getSlackSendClient().token,
        shouldSkip: (data) => shouldSkipForwarding(data, 'slack'),
    });
    addBroadcastListener(forwarderHandler);
    // Deliberately NOT awaited. A workspace with thousands of channels takes
    // minutes to reconcile at Slack's Tier 2/3 pacing, and the socket must not
    // wait for it — inbound already works the moment the connection is up.
    startSlackAutoJoin(sc, generation);
    log.info(`[slack] ✅ connected as ${selfUserId || 'unknown'}`);
    clearSlackClaimRecheck();
    return transportStarted;
}

export async function shutdownSlack(): Promise<void> {
    lifecycleGeneration++;
    await disposeSlackRuntime();
}

// ─── Public-channel auto-join ──────────────────
// Owned here rather than inside auto-join.ts so the module stays a pure policy
// function the tests can drive without a live transport.
let autoJoinAbort: AbortController | null = null;

/**
 * Kick off the background reconciliation for this init generation.
 *
 * Two guards, and both are load-bearing. The AbortController wakes the pacing
 * sleeps immediately so a shutdown does not wait out a 3-second gap, and the
 * generation check stops a scan whose transport has already been replaced by a
 * newer init. Cleanup is identity-guarded: a stale run that finishes late must
 * not clear the controller belonging to the run that superseded it.
 */
function startSlackAutoJoin(sc: Record<string, unknown>, generation: number): void {
    const config = mergeSlackAutoJoin(undefined, sc?.["autoJoin"]);
    if (!config.enabled) return;
    const token = String(sc?.["botToken"] ?? '').trim();
    if (!token) return;

    autoJoinAbort?.abort();
    const controller = new AbortController();
    autoJoinAbort = controller;

    void runSlackAutoJoin({
        token,
        config,
        signal: controller.signal,
        isCurrent: () => generation === lifecycleGeneration,
        // The inbound allowlist is the operator's boundary; joining past it
        // would grant history access to conversations they silenced.
        allowlist: readSlackAllowlist(sc?.["channelIds"]),
    }).then(result => {
        if (result.cancelled) return;
        if (result.joined.length || result.failed.length || result.abortedReason) {
            log.info(redactOutboundText(
                `[slack:autojoin] scanned=${result.scanned} joined=${result.joined.length}`
                + ` skipped=${result.skipped} failed=${result.failed.length}`
                + (result.budgetExhausted ? ' budget=exhausted' : '')
                + (result.abortedReason ? ` stopped=${result.abortedReason}` : ''),
            ));
        }
        if (result.abortedReason === 'missing_scope') {
            log.warn('[slack:autojoin] channels:join is not granted — add it under'
                + ' OAuth & Permissions and reinstall the app to auto-join public channels');
        }
    }).catch(err => {
        log.warn('[slack:autojoin] run failed:', logErrorText(err));
    }).finally(() => {
        if (autoJoinAbort === controller) autoJoinAbort = null;
    });
}

/**
 * Release every runtime resource WITHOUT touching the lifecycle generation.
 * `initSlack` reuses this for its own teardown; only an external
 * `shutdownSlack` invalidates in-flight initializations.
 */
async function disposeSlackRuntime(): Promise<void> {
    slackStopping = true;
    slackProgressRestorer.abort();
    for (const seal of [...slackProgressSealers]) seal();
    // Begin both cancellation paths before ingress drain can consume the server deadline.
    const outboundDrain = slackOutboundRegistry.drain();
    const progressDrain = slackProgressRegistry.drain(SLACK_PROGRESS_DRAIN_MS);
    await resetSlackIngress();
    // Wakes the pacing sleeps immediately instead of letting a teardown wait
    // out a 3-second gap between conversations.list pages.
    autoJoinAbort?.abort();
    autoJoinAbort = null;
    // A re-init can authenticate against a different workspace, whose app has
    // its own grant. Carrying the previous observation forward would report
    // the old workspace's scopes for the new one.
    resetSlackScopeStatus();
    // Identity is cached per (team, id). A re-init can authenticate against a
    // different workspace, so the cache must not outlive the runtime that filled it.
    resetSlackIdentityCache();
    // Same reasoning for channel names and thread participants: a workspace
    // switch would otherwise attribute the previous team's conversations.
    resetSlackConversationCache();
    // Prefetch claims are per-runtime: a fresh runtime has no agent session, so
    // the next message in a thread should get its history again.
    resetThreadPrefetchClaims();
    if (forwarderHandler) {
        removeBroadcastListener(forwarderHandler);
        forwarderHandler = null;
    }
    await Promise.allSettled([outboundDrain, progressDrain]);
    pendingQueueRequestIds.clear();
    socketClient?.stop();
    socketClient = null;
    activeClaimArbiter?.releaseOwnLeaseOnly();
    activeClaimArbiter = null;
    clearSlackClaimRecheck();
    selfUserId = null;
}
