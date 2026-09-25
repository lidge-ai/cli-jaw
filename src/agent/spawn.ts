import { calendarContext } from './calendar-context.js';
import { createSlackToolSecretStream, activateSlackToolGrant, revokeSlackToolGrant, revokeSlackToolScope, redactSlackToolSecrets, SLACK_TOOL_GRANT_ENV } from '../slack/tool-context.js';
// ─── Agent Spawn + Kill/Steer/Queue ──────────────────

import fs from 'fs';
import os from 'os';
import crypto from 'node:crypto';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createTextStreamReader, sliceWithoutSplittingSurrogate } from './stream-text.js';
import { resolveWindowsLaunchSpec, launchArgv } from '../core/windows-launch-spec.js';
import { decideShellFallback } from '../core/windows-shell-fallback.js';

/** Cap on retained stderr text used for error classification. */
const STDERR_BUF_CAP = 4000;
import { broadcast } from '../core/bus.js';
import { publish as ssePublish } from '../core/event-bus.js';
// Static: the registry depends only on the bus, so there is no cycle, and a
// dynamic import here would add an avoidable async failure point on a path that
// exists precisely to guarantee the caller hears something.
import { settleOnce } from '../orchestrator/request-registry.js';
import { settings, UPLOADS_DIR, detectCli, getProjectDirs } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import {
    getSession,
    insertMessage,
    getRecentMessages,
    listQueuedMessages,
    insertQueuedMessage,
    deleteQueuedMessage,
    migrateQueuedMessagesV1ToV2,
    getSessionBucket,
    clearSessionBucket,
    setSessionBucketSnapshot,
    getMaxMessageId,
    getSteerSalvageAfter,
} from '../core/db.js';
import { buildTaskSnapshot } from '../memory/runtime.js';
import { getActiveChatSession, getRemoteBoundSessionId } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { getSystemPrompt, regenerateB } from '../prompt/builder.js';
import { prependRemoteConversationContext } from '../prompt/conversation-context.js';
import { extractSessionId, extractFromEvent, extractOutputChunk, logEventSummary, flushClaudeBuffers, flushOpenCodeBuffers } from './events.js';
import { detectSmokeResponse } from './smoke-detector.js';
import { saveUpload as _saveUpload, buildMediaPrompt, buildMediaPromptMany, type SaveUploadOptions } from '../../lib/upload.js';
import { resolveMainCli, consumePendingBootstrapPrompt, peekPendingBootstrapPrompt } from '../core/main-session.js';
import {
    getSessionOwnershipGeneration,
    isCurrentSessionOwner,
} from './session-persistence.js';
import { isCompactMarkerRow } from '../core/compact.js';
import { isRuntimeSettingsMutationInFlight, waitForRuntimeSettingsIdle } from '../core/runtime-settings-gate.js';
import { hasBlockingWorkers, hasPendingWorkerReplays, getActiveWorkers, clearAllWorkers, clearWorkersForScope, cancelWorker } from '../orchestrator/worker-registry.js';
import { sanitizeWorkerProgressTools } from '../orchestrator/worker-progress.js';
import { handleAgentExit, setSpawnAgent, setMainMetaHandler } from './lifecycle-handler.js';
import { buildServicePath } from '../core/runtime-path.js';
import { formatCliUnavailableMessage, detectCliBinary } from '../core/cli-detect.js';
import { LOCAL_SESSION_SCOPE_ACTIVATION, resolveExecutionBinding } from '../orchestrator/scope.js';
import { stripInterviewTracker } from '../orchestrator/sanitize.js';
import { beginLiveRun, appendLiveRunText, setLiveRunTraceId, clearLiveRun, replaceLiveRunTools, appendLiveRunTool } from './live-run-state.js';
import {
    memoryFlushCounter as _memoryFlushCounter,
    flushCycleCount as _flushCycleCount,
    setSpawnRef as setMemorySpawnRef,
} from './memory-flush-controller.js';
import { applyCliEnvDefaults, buildSessionResumeKey, ensureOpencodeAlwaysAllowPermissions, mergeEnvWindowsSafe } from './spawn-env.js';
import {
    buildPromptForArgs,
    shouldBuildHistoryBlock,
    withHistoryPrompt,
    withSteerContext,
    PROMPT_HISTORY_MAX_ROWS,
    PROMPT_HISTORY_MAX_CHARS,
} from './prompt-context.js';
import { attachWatchdog, DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS } from './watchdog.js';
import {
    buildOpencodeRuntimeSnapshot,
    buildOpencodeSpawnAudit,
    pushOpencodeRawEvent,
    resolveOpencodeBinary,
} from './opencode-diagnostics.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import { MainReplacementOwnerMismatchError, type MainReplacementResult } from './runtime/replace-turn.js';
import { beginSteerInput, cancelSteerInputs, cancelAllSteerInputs } from './steer-input-guard.js';
import { startClaudeNativeRun } from './claude-runtime-run.js';
import { hasClaudeRuns, hasClaudeMainRuns, hasClaudeWorker, cancelClaudeWorker, cancelClaudeScope, cancelAllClaudeRuns } from './runtime/claude-run-controls.js';
import type { PreparedClaudeOptions } from './runtime/claude-sdk-options.js';
import { createPrintActivity, finishPrintActivity } from './runtime/print-activity.js';
import { isNativeAdapterImplemented, isNativeWorkerImplemented, isSwitchableNativeCli, resolveRuntimeTransport, runtimeSessionBucket } from './runtime/selection.js';
import { asCliEventRecord, discriminate, fieldString, type CliEventRecord } from '../types/cli-events.js';
import { isRemoteTarget, type RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import { runPinFields, sameRunConversation } from '../messaging/run-pin.js';
import { isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import { runBeforeSpawnChecks } from '../core/policy-hooks.js';
import { appendTraceEvent, stampTraceTool, startTraceRun } from '../trace/store.js';
import {
    AGY_COMPLETE_KILL_REASON,
    appendAgyFullText,
    classifyAgyTranscriptMode,
    describeAgyFinalSource,
    extractAgyConversationId,
    finalizeAgyFallbackText,
    AGY_PLANNER_ONLY_NOTICE,
    isAgyIntermediatePlannerText,
    formatAgyWatchdogContext,
    resolveAgyEmptyCloseError,
    formatAgyTimeoutMessage,
    getAgyQuietCompletionDelayMs,
    isAgyStaleSessionOutput,
    normalizeAgyCloseText,
    shouldFreezeAgyLiveDisplay,
    stripAgyPromptEchoPrefix,
    stripAgyResumeReplayPrefix,
    stripAgyResumeReplayPrefixes,
} from './agy-runtime.js';
import { detectAgyCapabilities } from './agy-capabilities.js';
import {
    buildAgyBootstrapEnvelope,
    resolveAgyPromptOrder,
    type AgyBootstrapEnvelope,
} from './agy-bootstrap.js';
import { startAgyTranscriptWatcher, type AgyTranscriptWatcherHandle } from './agy-transcript-watcher.js';
import { emitAgentTool, normalizeAssistantDisplayText, pushTrace, streamJsonMarksProgress } from './events/helpers.js';
import {
    captureKiroSessionIdAfterExit,
    finalizeKiroFullText,
    flushKiroStdoutContext,
    isKiroPlainTextCli,
    isKiroStaleSessionOutput,
    processKiroStdoutChunk,
    spawnWithKiroSnapshot,
    type KiroStreamEvent,
} from './kiro-runtime.js';
import { resolveCursorModelVariant } from './cursor-runtime.js';
import * as piExecutionControls from './pi-runtime.js';
import type { MainRunState, MainSessionMeta, SpawnOpts, SpawnPromiseResult, SpawnResult } from './spawn/types.js';
import type { SpawnBackendHost, SpawnBackendLocals } from './spawn/backend-context.js';
import { runNativeAcpBackend } from './spawn/backend-native-acp.js';
import { runCopilotBackend } from './spawn/backend-copilot.js';
import { runPiBackend } from './spawn/backend-pi.js';
import { runCodexAppBackend } from './spawn/backend-codex-app.js';
export type { MainRunState, MainSessionMeta, SpawnLifecycle } from './spawn/types.js';

// ─── State ───────────────────────────────────────────

export const activeProcesses = new Map<string, ChildProcess>(); // agentId → child process
export function hasActiveAgent(agentId: string): boolean {
    return activeProcesses.has(agentId) || hasClaudeWorker(agentId);
}

/** Grace before escalating that kill to SIGKILL, matching the sibling kill paths. */
const DUP_REGISTRATION_KILL_GRACE_MS = 2_000;

function cancelOwnedPiProcess(child: ChildProcess, reason?: string): boolean {
    const cancel = piExecutionControls.cancelPiExecution;
    if (typeof cancel !== 'function') return false;
    const live = !hasChildExited(child);
    if (!cancel(child)) return false;
    if (live && child.pid && reason) killReasons.set(child.pid, reason);
    return true;
}

function registerActiveProcess(agentLabel: string, child: ChildProcess): void {
    // Defensive: the concrete spawn site should already own this child, and
    // ownProcess is memoized, so this returns that existing owner rather than
    // installing a second escalation timer.
    ownProcess(child);
    const prev = activeProcesses.get(agentLabel);
    if (prev && prev !== child) {
        // `killed` only records that a signal was delivered, so it is not a
        // liveness test: a CLI that traps SIGTERM stays alive with killed set.
        // Treating it as exited would drop that survivor from the map without
        // even scheduling the escalation below — the exact invisible process
        // this branch exists to prevent.
        if (cancelOwnedPiProcess(prev, DUP_REGISTRATION_KILL_REASON)) {
            // Its captured pair owns cleanup; never start a second tree timer.
        } else if (hasChildExited(prev)) {
            activeProcesses.delete(agentLabel);
        } else {
            // Dropping a live child from the map makes it invisible to
            // killAllAgents, so it survives stop, shutdown, and restart while
            // still holding its own memory. Reap it instead of leaking it.
            console.warn(`[spawn:dup] activeProcesses already has a live child for ${agentLabel} — killing it before overwrite (pid=${prev.pid ?? 'unknown'})`);
            if (prev.pid) {
                const prevPid = prev.pid;
                // Record a kill reason so the stale exit handler classifies this
                // as an intentional kill rather than a genuine agent error.
                killReasons.set(prevPid, DUP_REGISTRATION_KILL_REASON);
                // The owner performs the SIGTERM tree walk, schedules the same
                // grace, and re-checks the original child before escalating —
                // so a PID recycled during the grace is never signalled.
                ownProcess(prev, {
                    policy: () => ({ initialSignal: 'SIGTERM', graceMs: DUP_REGISTRATION_KILL_GRACE_MS }),
                }).terminate('duplicate-registration');
            }
        }
    }
    activeProcesses.set(agentLabel, child);
}

export const activeMainProcesses = new Map<string, MainRunState>();

export function getCurrentMainMeta(scopeKey?: string): MainSessionMeta | null {
    const scope = scopeKey ?? currentSessionScope()?.scope ?? 'default';
    return activeMainProcesses.get(scope)?.meta ?? null;
}

export function setCurrentMainMeta(scopeKey: string, meta: MainSessionMeta | null): void;
export function setCurrentMainMeta(meta: MainSessionMeta | null): void;
export function setCurrentMainMeta(scopeKeyOrMeta: string | MainSessionMeta | null, nextMeta?: MainSessionMeta | null): void {
    const scopeKey = typeof scopeKeyOrMeta === 'string'
        ? scopeKeyOrMeta
        : currentSessionScope()?.scope ?? 'default';
    const meta = typeof scopeKeyOrMeta === 'string' ? nextMeta ?? null : scopeKeyOrMeta;
    const run = activeMainProcesses.get(scopeKey);
    if (!meta) {
        activeMainProcesses.delete(scopeKey);
        return;
    }
    if (run) {
        run.meta = meta;
    } else {
        activeMainProcesses.set(scopeKey, {
            process: null,
            starting: false,
            steering: false,
            ownerGeneration: 0,
            meta,
        });
    }
}

export function releaseMainRun(
    scopeKey: string,
    child: ChildProcess | null,
    ownerGeneration: number,
): boolean {
    const run = activeMainProcesses.get(scopeKey);
    if (!run || run.process !== child || run.ownerGeneration !== ownerGeneration) return false;
    activeMainProcesses.delete(scopeKey);
    return true;
}


interface SessionRow {
    cli?: string;
    model?: string;
    permissions?: string;
    session_id?: string | null;
    working_dir?: string | null;
    effort?: string;
}

interface RecentMessageRow {
    role?: string;
    content?: string;
    cli?: string;
    trace?: string;
}

interface SessionBucketRow {
    session_id?: string | null;
    model?: string | null;
    resume_key?: string | null;
    output_len?: number | null;
    memory_snapshot?: string | null;
    updated_at?: string | number | null;
    last_run_clean?: number | null;
    last_run_cwd?: string | null;
    last_run_meta?: string | null;
}

import { hasChildExited, ownProcess } from './spawn/process-kill.js';
import {
    DUP_REGISTRATION_KILL_REASON,
    isLifecycleExitSettleReason,
    isLifecycleSteerReason,
} from './spawn/kill-reason.js';
import { stopCauseFromKillReason } from './spawn/stop-cause.js';
import { buildSteerStartedEvent } from './spawn/steer-event.js';
import {
    armExitSettle, captureExitSettler, settleCapturedExit, settleExit, waitForExitSettled,
    type ExitSettler,
} from './spawn/exit-settle.js';
import { releaseChildOutputAfterExit } from './spawn/exit-drain.js';
import { createNdjsonFramer, MAX_PENDING_LINE_CHARS } from './spawn/line-buffer.js';
import type { NdjsonDrop } from './spawn/line-buffer.js';

/** No provider turn was dispatched; preserve the captured cancellation receipt. */
function stoppedBeforeStart(reason: string | undefined, traceRunId: string): SpawnPromiseResult {
    const stopCause = stopCauseFromKillReason(reason);
    return { text: '', code: 130, traceRunId,
        runtimeOutcome: { status: 'stopped', finalText: null, partialText: '' },
        ...(stopCause ? { stopCause } : {}) };
}

/** Single choke point for streamed assistant text: appends to the live-run
 *  accumulator and broadcasts agent_output tagged with the owning trace run
 *  id plus the cumulative text length (`textLen`). The web UI uses the pair
 *  as a replay-dedup cursor — SSE reconnect replays re-deliver chunks the
 *  client already rendered. */
function broadcastAgentOutput(
    ctx: SpawnContext,
    agentLabel: string,
    cli: string,
    text: string,
    empTag: Record<string, unknown>,
    audience: 'public' | 'internal',
): void {
    const textLen = ctx.liveScope ? appendLiveRunText(ctx.liveScope, text) : null;
    broadcast('agent_output', {
        agentId: agentLabel,
        cli,
        text,
        ...(textLen !== null ? { textLen } : {}),
        ...empTag,
        ...(ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {}),
        ...(ctx.activityIdentity ?? {}),
    }, audience);
}

function appendParentLiveRunTool(ctx: SpawnContext, tool: ToolEntry): void {
    if (!ctx.parentLiveScope) return;
    const [safeTool] = sanitizeWorkerProgressTools([{ ...tool, isEmployee: true }]);
    if (!safeTool) return;
    appendLiveRunTool(ctx.parentLiveScope, { ...safeTool, isEmployee: true });
    // 260613 20 P2-i: employee runs are internal-audience, so without this the
    // web UI paints employee progress only on interaction-triggered snapshot
    // hydration. Surface the SAME sanitized mirror entry on the SSE bus only —
    // ssePublish (not broadcast) so internal listeners are not notified twice;
    // the call sites already broadcast the raw tool internally.
    ssePublish('agent', 'agent_tool', { ...safeTool, isEmployee: true });
}

function emitKiroStreamEvents(
    events: KiroStreamEvent[],
    ctx: SpawnContext,
    agentLabel: string,
    cli: string,
    empTag: Record<string, unknown>,
    traceAudience: 'public' | 'internal',
): void {
    for (const event of events) {
        ctx.kiroLastVisibleAt = Date.now();
        ctx.kiroHeartbeatSent = false;
        ctx.stallWatchdog?.markProgress();
        if (event.kind === 'assistant_delta') {
            const segment = normalizeAssistantDisplayText(event.text);
            if (!segment) continue;
            ctx.printActivity?.message(segment, 'append', 'unknown');
            if (ctx.liveOutputText !== undefined) {
                ctx.liveOutputText += segment;
            }
            ctx.outputTextStarted = true;
            broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
            continue;
        }
        const tool: ToolEntry = {
            icon: event.icon,
            label: event.label,
            detail: event.detail || '',
            stepRef: event.stepRef,
            status: event.status,
            toolType: 'tool',
        };
        stampTraceTool(tool, ctx, 'tool');
        const existingIdx = ctx.toolLog.findIndex((entry) => entry.stepRef === event.stepRef);
        if (existingIdx >= 0) {
            ctx.toolLog[existingIdx] = { ...ctx.toolLog[existingIdx], ...tool };
        } else {
            ctx.toolLog.push(tool);
        }
        if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
        appendParentLiveRunTool(ctx, tool);
        emitAgentTool(ctx, agentLabel, tool, empTag);
    }
}

export function killAgentById(agentId: string): boolean {
    if (cancelClaudeWorker(agentId, 'user')) return true;
    const proc = activeProcesses.get(agentId);
    if (!proc) return false;
    try {
        if (cancelOwnedPiProcess(proc, 'user')) return true;
        // Record the stop the way killActiveAgent does for a main run (below). Only
        // the Pi branch above used to stamp a reason, so a deliberately stopped
        // employee on every other runtime reached handleAgentExit with
        // wasKilled=false and was classified as a crash. For an employee with a
        // non-zero exit that is not cosmetic: lifecycle-handler's employee retry
        // branch (`isEmployee && code !== 0 && !wasKilled`) respawns the very turn
        // the caller just cancelled.
        //
        // Live pid only, for the same reason cancelOwnedPiProcess checks: stamping
        // an already-exited pid is how a recycled pid inherits a foreign kill reason.
        if (proc.pid && !hasChildExited(proc)) killReasons.set(proc.pid, 'user');
        // Same owner as killActiveAgent. The hand-rolled version here escalated on a
        // bare 3s timer with no liveness re-check, so a CLI that traps SIGTERM either
        // survived or, worse, the delayed SIGKILL landed on a recycled PID. Worker
        // stop (orchestrator/distribute.ts, orchestrator/pipeline.ts) reaches this
        // path, which is why it had different lifetime rules from main stop.
        ownProcess(proc).terminate('cancel');
        // Stdio teardown stays on its own timer: it must happen even when the owner
        // short-circuits because the child had already exited.
        const teardown = setTimeout(() => {
            proc.stdin?.destroy();
            proc.stdout?.destroy();
            proc.stderr?.destroy();
        }, DEFAULT_KILL_ESCALATION_MS);
        teardown.unref?.();
        return true;
    } catch {
        return false;
    }
}
export { memoryFlushCounter, flushCycleCount } from './memory-flush-controller.js';

const queueCtrl = createQueueController({
    isSpawnBusy: (scopeKey) => isAgentBusy(scopeKey),
    hasBlockingWorkers,
    hasPendingWorkerReplays,
    insertMessage,
    getActiveChatSession,
    insertQueuedMessage,
    deleteQueuedMessage,
    listQueuedMessages: listQueuedMessages as unknown as { all(): Array<{ id: string; payload: string }> },
    migrateQueuedMessagesV1ToV2,
    broadcast,
    importPipeline: () => import('../orchestrator/pipeline.js'),
    getWorkingDir: () => settings["workingDir"] || null,
    isMultiSessionEnabled: () => settings["multiSession"]?.enabled === true,
    isLocalSessionScopeEnabled: () => LOCAL_SESSION_SCOPE_ACTIVATION,
    // Lookup only: draining a queue must never mint a session for a conversation
    // that no longer has one.
    resolveRemoteSession: (remoteKey: string) => getRemoteBoundSessionId(remoteKey),
});

export const {
    messageQueue,
    enqueueMessage,
    removeQueuedMessage,
    processQueue,
    // Called by the server once transports are up: this controller is built at
    // module init, so a recovered queue cannot be drained here (#407).
    drainRecoveredQueue,
    setQueueHold,
    clearQueueHold,
    getQueueHoldId,
    isScopedQueue,
    isRetryPending,
    isQueueBusy,
    clearRetryTimer,
    // Exposed so DELETE's 409 paths can be driven end-to-end against the
    // production controller instead of an isolated instance.
    retryStateForScope,
    resetFallbackState,
    getFallbackState,
    getQueuedMessageSnapshotForScope,
    purgeQueueOnStop,
} = queueCtrl;

const piProfileFingerprintKey = crypto.randomBytes(32);

export function setSteerInProgress(scopeKey: string, value: boolean): void;
export function setSteerInProgress(value: boolean): void;
export function setSteerInProgress(scopeKeyOrValue: string | boolean, nextValue?: boolean): void {
    const scopeKey = typeof scopeKeyOrValue === 'string' ? scopeKeyOrValue : 'default';
    const value = typeof scopeKeyOrValue === 'boolean' ? scopeKeyOrValue : nextValue === true;
    const run = activeMainProcesses.get(scopeKey);
    if (!run) return;
    const was = run.steering;
    run.steering = value;
    if (was && !value) queueMicrotask(() => { void processQueue(scopeKey); });
}

export function isSteerInProgress(scopeKey = 'default'): boolean {
    return activeMainProcesses.get(scopeKey)?.steering === true;
}

export function isAgentBusy(scopeKey: string | null = 'default'): boolean {
    if (scopeKey === null) {
        return activeMainProcesses.size > 0
            || queueCtrl.isRetryPending(null);
    }
    return activeMainProcesses.has(scopeKey)
        || queueCtrl.isRetryPending(scopeKey);
}

// ─── Kill / Steer ────────────────────────────────────

// [I2] Per-process kill reason map (replaces global variable to avoid cross-process confusion)
const killReasons = new Map<number, string>();
/** How long a steer waits for the killed child to actually exit.
 *
 *  This is the bound on a WEDGED child, not on the common case: a healthy child
 *  exits in milliseconds and the interval resolves immediately, so raising this
 *  costs nothing when things work. What it buys is that a slow-to-die child is
 *  waited for rather than raced past. The cost is real and worth stating: a truly
 *  wedged child now holds the steer for 10s instead of 3s before the caller
 *  proceeds anyway.
 *
 *  Salvage is NOT the reason — `waitForExitSettled` below already absorbs the
 *  case where the exit handler has not finished writing (#523). */
const DEFAULT_STEER_WAIT_MS = 10_000;
const DEFAULT_KILL_ESCALATION_MS = 2_000;
const DEFAULT_CODEX_APP_TURN_IDLE_MS = 300_000;
const DEFAULT_CODEX_APP_TURN_ABS_MS = 2 * 60 * 60_000;
const DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS = 60_000;
const CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS = 250;

function configuredPositiveMs(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getActiveMainCli(scopeKey: string): string | null {
    const cli = activeMainProcesses.get(scopeKey)?.meta.cli;
    return typeof cli === 'string' ? cli : null;
}

/**
 * Read this scope's `agentTimeout` block, global keys overlaid by per-CLI keys.
 *
 * `settings` is a live binding from core/config, so this reflects a settings edit made
 * after the turn started — which is what a steer wants: it is deciding how long to wait
 * right now, not how long the run was configured to take when it was spawned.
 */
function mergeAgentTimeoutCfg(cli: string | null): Record<string, unknown> {
    const raw = (settings as Record<string, unknown>)['agentTimeout'];
    const global = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const perCli = cli && global[cli] && typeof global[cli] === 'object'
        ? global[cli] as Record<string, unknown> : {};
    return { ...global, ...perCli };
}

export function getSteerWaitMsForActiveAgent(scopeKey = 'default'): number {
    const configured = mergeAgentTimeoutCfg(getActiveMainCli(scopeKey))['steerWaitMs'];
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_STEER_WAIT_MS;
}

/** Get kill reason for a process (by PID), consuming it */
function consumeKillReason(pid: number | undefined): string | null {
    if (!pid) return null;
    const reason = killReasons.get(pid) ?? null;
    if (reason) killReasons.delete(pid);
    return reason;
}

// The steer exit-settle barrier moved to ./spawn/exit-settle.js so it can be imported
// without this module behind it. Re-exported here because every caller — the HTTP
// route, the CLI slash handler and eleven test files — imports it from spawn.
export { armExitSettle, settleExit, waitForExitSettled };

/**
 * Fix A: 사용자 stop은 메모리 큐 + DB persisted_queue + frontend pending row를
 * 모두 폐기한다. exit handler의 scoped queue 자동 드레인이 stop 직후 잔존
 * 메시지를 "스스로 steer" 처럼 실행하던 회귀를 차단.
 */
/**
 * Fix C2: 사용자 stop 시 worker-registry 도 비운다.
 * gateway.submitMessage가 scoped main/worker/replay 상태를 모두 검사하므로,
 * 도 검사하므로, 이걸 비우지 않으면 stop 직후 새 메시지가 busy 분기 → 큐로 떨어지고
 * 프론트는 (1) 낙관 bubble + (2) applyQueuedOverlay 가 만든 queued bubble = 2개를 보여준다.
 */
/**
 * Stop the scope's employees, then forget them.
 *
 * Clearing the registry only forgets the slot; it never stopped the child. Claude
 * employees die earlier, inside cancelClaudeScope(..., includeWorkers), so the gap
 * was invisible there — and every OTHER runtime's employee survived a user stop:
 * still running, still streaming into a scope the boss had abandoned, still holding
 * its isolated cwd. The two sibling paths already get this right: orchestrateReset
 * kills before clearing (orchestrator/pipeline.ts) and the worker timeout calls
 * killAgentById (orchestrator/distribute.ts). Only the stop path was missing it.
 *
 * cancelWorker matches reset for the same reason: deleting a slot leaves its worker
 * run row 'running' forever, because finishWorker and failWorker both no-op once the
 * slot is gone. getActiveWorkers returns a fresh array, so killing inside the loop
 * cannot mutate what is being iterated.
 */
function clearWorkerSlotsOnStop(scopeKey: string, reason: string) {
    const active = getActiveWorkers(scopeKey);
    if (active.length === 0 && !hasPendingWorkerReplays(scopeKey)) return;
    for (const slot of active) {
        killAgentById(slot.agentId);
        cancelWorker(slot.agentId);
    }
    clearWorkersForScope(scopeKey);
    console.log(`[jaw:stop] stopped and cleared worker registry (active=${active.length}, scope=${scopeKey}, reason=${reason})`);
}

function clearMainLiveRunOnStop(scopeKey: string, reason: string): void {
    if (!isImmediateScopeReleaseReason(reason)) return;
    clearLiveRun(scopeKey);
}

function isImmediateScopeReleaseReason(reason: string): boolean {
    return reason === 'api' || reason === 'user' || isLifecycleExitSettleReason(reason);
}

export function killActiveAgent(scopeKey: string, reason: string): boolean;
export function killActiveAgent(reason?: string): boolean;
export function killActiveAgent(scopeKeyOrReason = 'user', scopedReason?: string): boolean {
    const scopeKey = scopedReason === undefined ? 'default' : scopeKeyOrReason;
    const reason = scopedReason ?? scopeKeyOrReason;
    if (reason === 'user' || reason === 'api') revokeSlackToolScope(scopeKey);
    else revokeSlackToolGrant(activeMainProcesses.get(scopeKey)?.meta?.requestId);
    cancelSteerInputs(scopeKey);
    const cancelledClaude = cancelClaudeScope(scopeKey, reason, reason === 'api' || reason === 'user');
    const run = activeMainProcesses.get(scopeKey);
    const hadTimer = queueCtrl.isRetryPending(scopeKey);
    const cancelledPendingMain = run?.cancelPending ? (run.cancelPending(reason), true) : false;
    clearRetryTimer(scopeKey, false);
    if (!cancelledPendingMain) clearMainLiveRunOnStop(scopeKey, reason);
    // Fix A: 사용자 stop은 큐도 폐기. steer/internal kill은 큐 보존.
    // Fix C2: worker registry 도 비워서 hasBlockingWorkers/hasPendingWorkerReplays가 즉시 false.
    if (reason === 'api' || reason === 'user') {
        queueCtrl.purgeQueueOnStop(scopeKey, reason);
        // The queue purge answers everything still waiting, but the run that was
        // actually executing has its own id. Without this a user stop leaves that
        // caller hanging, or worse the pipeline later reports it as `completed`.
        settleOnce(run?.meta?.requestId, 'cancelled', { reason });
        clearWorkerSlotsOnStop(scopeKey, reason);
    }
    if (run?.cancelTurn && ['codex-app', 'pi', 'cursor', 'grok', 'claude'].includes(getActiveMainCli(scopeKey) || '')) {
        if (run.process?.pid) killReasons.set(run.process.pid, reason);
        console.log(`[jaw:kill] reason=${reason} scope=${scopeKey} cli=${getActiveMainCli(scopeKey)} action=lease.cancel`);
        if (isLifecycleExitSettleReason(reason)) armExitSettle(scopeKey);
        run.cancelTurn(reason);
        if (isImmediateScopeReleaseReason(reason)) activeMainProcesses.delete(scopeKey);
        return true;
    }
    const activeProcess = run?.process ?? null;
    if (!activeProcess) {
        if (isImmediateScopeReleaseReason(reason)) activeMainProcesses.delete(scopeKey);
        return hadTimer || cancelledPendingMain || cancelledClaude;
    }
    console.log(`[jaw:kill] reason=${reason} scope=${scopeKey} cli=${getActiveMainCli(scopeKey) || 'unknown'} signal=SIGTERM escalationMs=${DEFAULT_KILL_ESCALATION_MS}`);
    if (activeProcess.pid) killReasons.set(activeProcess.pid, reason);
    if (isLifecycleExitSettleReason(reason)) armExitSettle(scopeKey);
    const proc = activeProcess;
    // One owner runs the whole termination: tree walk, then escalation after the
    // grace that re-checks the ORIGINAL child. The previous escalation guarded on
    // `!proc.killed`, which only records that a signal was delivered — a CLI that
    // traps SIGTERM stays alive with killed set, and was therefore never escalated.
    //
    // No policy override: the owner is memoized on child identity and the FIRST call
    // wins, so a policy passed here would be honoured for a main run and silently
    // dropped for a worker that registerActiveProcess already owns. Taking the
    // default keeps one rule for both.
    ownProcess(proc).terminate(reason === 'steer' ? 'steer' : 'cancel');
    // Immediately sever stdio to stop late output from reaching broadcast handlers
    proc.stdout?.removeAllListeners('data');
    proc.stderr?.removeAllListeners('data');
    // Stdio teardown stays on its own timer: it must happen even when the
    // owner short-circuits because the child had already exited.
    const teardown = setTimeout(() => {
        proc.stdin?.destroy();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
    }, DEFAULT_KILL_ESCALATION_MS);
    teardown.unref?.();
    // Fix C1: 사용자 stop/steer 시 해당 scope busy가 즉시 false가 되도록 참조를 동기 해제.
    // 실제 child 종료는 위 setTimeout SIGKILL이 백그라운드에서 마무리.
    // exit handler의 setActiveProcess(null) / activeProcesses.delete 는 idempotent.
    if (isImmediateScopeReleaseReason(reason)) {
        activeMainProcesses.delete(scopeKey);
    }
    return true;
}

export function killAllAgents(reason = 'user') {
    cancelAllSteerInputs();
    const cancelledClaude = cancelAllClaudeRuns(reason);
    const hadTimer = queueCtrl.isRetryPending(null);
    const mainScopes = [...activeMainProcesses.keys()];
    let killedMain = false;
    for (const scopeKey of mainScopes) {
        killedMain = killActiveAgent(scopeKey, reason) || killedMain;
    }
    if (reason === 'api' || reason === 'user') queueCtrl.purgeQueueOnStop(null, reason);
    let killed = 0;
    for (const [id, proc] of activeProcesses) {
        console.log(`[jaw:killAll] killing ${id}, reason=${reason}`);
        if (proc.pid) killReasons.set(proc.pid, reason);
        if (cancelOwnedPiProcess(proc, reason)) { killed++; continue; }
        // Same owner contract as killActiveAgent: tree walk now, escalation
        // after the grace, guarded by real exit state rather than `killed`.
        ownProcess(proc, {
            policy: () => ({ initialSignal: 'SIGTERM', graceMs: 2000 }),
        }).terminate('shutdown');
        killed++;
        const ref = proc;
        const teardown = setTimeout(() => {
            ref.stdin?.destroy();
            ref.stdout?.destroy();
            ref.stderr?.destroy();
        }, 2000);
        teardown.unref?.();
    }
    if (reason === 'api' || reason === 'user') {
        activeProcesses.clear();
        activeMainProcesses.clear();
        clearAllWorkers();
    }
    return killed > 0 || killedMain || hadTimer || cancelledClaude;
}

export function waitForProcessEnd(scopeKey: string, timeoutMs?: number): Promise<void>;
export function waitForProcessEnd(timeoutMs?: number): Promise<void>;
export function waitForProcessEnd(scopeKeyOrTimeout: string | number = 'default', scopedTimeout = 3000) {
    const scopeKey = typeof scopeKeyOrTimeout === 'string' ? scopeKeyOrTimeout : 'default';
    const timeoutMs = typeof scopeKeyOrTimeout === 'number' ? scopeKeyOrTimeout : scopedTimeout;
    return waitForScopedProcessEnd(scopeKey, timeoutMs, hasClaudeRuns);
}

/** Steer waits for main accounting, including pending main cleanup, but not surviving workers. */
export function waitForMainProcessEnd(scopeKey: string, timeoutMs = 3000): Promise<void> {
    return waitForScopedProcessEnd(scopeKey, timeoutMs, hasClaudeMainRuns);
}

function waitForScopedProcessEnd(scopeKey: string, timeoutMs: number, hasClaude: (scope: string) => boolean): Promise<void> {
    if (!activeMainProcesses.has(scopeKey) && !hasClaude(scopeKey)) return Promise.resolve();
    return new Promise<void>(resolve => {
        const check = setInterval(() => {
            if (!activeMainProcesses.has(scopeKey) && !hasClaude(scopeKey)) { clearInterval(check); clearTimeout(deadline); resolve(); }
        }, 100);
        // The deadline has to be CLEARED on the fast path, not just left to fire.
        // A child normally exits in milliseconds, so the common case resolved the
        // promise and then held a live timer for the rest of the budget — and
        // unlike the teardown timer below it is not unref'd, so it kept the event
        // loop alive. The sibling waitForAllProcessesEnd already does exactly
        // this (#523).
        const deadline = setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
}

/** Wait for EVERY scope to finish exiting, bounded.
 *
 *  `killAllAgents` only sends the signal; it returns long before the children
 *  are gone and before their exit handlers have written anything. Shutdown then
 *  closed the database underneath those handlers, so the last turn of a restart
 *  lost its assistant message, its session row and its trace, and the caller
 *  waiting on that turn was never resolved (#439).
 *
 *  Bounded on purpose: a wedged child must not hold the process open past the
 *  force-exit budget. Returning on timeout is the same outcome as today, minus
 *  the common case where the child would have finished in milliseconds. */
export function waitForAllProcessesEnd(timeoutMs = 2000): Promise<void> {
    if (activeMainProcesses.size === 0 && !hasClaudeRuns()) return Promise.resolve();
    return new Promise<void>(resolve => {
        const check = setInterval(() => {
            if (activeMainProcesses.size === 0 && !hasClaudeRuns()) { clearInterval(check); clearTimeout(deadline); resolve(); }
        }, 50);
        const deadline = setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
}

export function canSteerAgent(scopeKey: string): boolean {
    const run = activeMainProcesses.get(scopeKey);
    // Route CLI steering through either the in-band hook or the native replacement hook.
    // Each owning hook decides whether the current turn can still accept the input.
    return typeof run?.steerTurnInBand === 'function' || typeof run?.replaceTurn === 'function';
}

/** Native replacement owns a stricter mismatch contract than queue fallback:
 * malformed cross-conversation metadata must fail before it is persisted. */
export function hasActiveMainReplacement(scopeKey: string): boolean {
    return typeof activeMainProcesses.get(scopeKey)?.replaceTurn === 'function';
}

export type SteerOutcome = 'steered' | 'fallback-queue' | 'new-run' | 'cancelled' | 'retired';

export async function steerAgent(
    scopeKey: string,
    newPrompt: string,
    source: string,
    meta?: { cli?: string; chatSessionId?: string; target?: RemoteTarget; chatId?: string | number; requestId?: string; remoteKey?: string; replyViaTarget?: boolean },
): Promise<SteerOutcome> {
    const run = activeMainProcesses.get(scopeKey);
    const chatSessionId = meta?.chatSessionId || run?.meta.chatSessionId || getActiveChatSession();
    // This is admission for NEW input, not the already admitted run's selection.
    // A watched settings change must not inject into or stop that run's lease.
    const steerCli = resolveMainCli(meta?.cli, settings, getSession() as SessionRow | undefined);
    if (isRetiredCliSelection(steerCli)) {
        settleOnce(meta?.requestId, 'failed', { error: retiredRuntimeDiagnostic(steerCli),
            scope: scopeKey, sessionId: chatSessionId });
        return 'retired';
    }
    if (typeof run?.replaceTurn === 'function') {
        const capturedSessionOwner = getSessionOwnershipGeneration(scopeKey);
        const owner = run.meta;
        const ownerTarget = isRemoteTarget(owner.target) ? owner.target : undefined;
        const ownerRemoteKey = owner.remoteKey ?? (ownerTarget ? buildRemoteBindingKey(ownerTarget) : undefined);
        const suppliedTarget = meta?.target;
        if ((meta?.chatSessionId !== undefined && meta.chatSessionId !== owner.chatSessionId)
            || (meta?.remoteKey !== undefined && meta.remoteKey !== ownerRemoteKey)
            || (suppliedTarget !== undefined && (!isRemoteTarget(suppliedTarget)
                || buildRemoteBindingKey(suppliedTarget) !== ownerRemoteKey
                || (ownerTarget !== undefined && (buildRemoteBindingKey(suppliedTarget) !== buildRemoteBindingKey(ownerTarget)
                    || suppliedTarget.targetKind !== ownerTarget.targetKind
                    || suppliedTarget.guildId !== ownerTarget.guildId
                    || suppliedTarget.parentTargetId !== ownerTarget.parentTargetId))))) {
            throw new MainReplacementOwnerMismatchError();
        }
        const capturedMeta = { ...meta, ...(suppliedTarget === undefined ? {} : { target: { ...suppliedTarget } }) };
        const capturedOwnerGeneration = run.ownerGeneration;
        const workingDir = settings['workingDir'] || null;
        let attempted = false;
        const inputGuard = beginSteerInput(scopeKey);
        let outcome: MainReplacementResult, inputCancelled: boolean;
        try {
            outcome = await run.replaceTurn(newPrompt, () => {
                if (activeMainProcesses.get(scopeKey) !== run || run.ownerGeneration !== capturedOwnerGeneration
                    || !isCurrentSessionOwner(capturedSessionOwner, scopeKey)) {
                    throw new MainReplacementOwnerMismatchError();
                }
                if (attempted) throw new Error('native_replacement_duplicate_input');
                attempted = true; // A partial recording failure must never retry this input.
                insertMessage.run('user', newPrompt, source, '', workingDir, chatSessionId);
                broadcast('new_message', { role: 'user', content: newPrompt, source, scope: scopeKey, sessionId: chatSessionId });
                broadcast('steer_started', buildSteerStartedEvent({
                    prompt: newPrompt, source, scopeKey, chatSessionId, meta: capturedMeta,
                    mode: 'cancel-reprompt', extra: { localDispatch: true },
                }));
                settleOnce(capturedMeta.requestId, 'steered');
            });
        } finally { inputCancelled = inputGuard.isCancelled(); inputGuard.release(); }
        if (outcome.kind === 'failed') throw outcome.error;
        if ((outcome.kind === 'dispatched') !== attempted) throw new Error('native_replacement_inconsistent_receipt');
        if (outcome.kind === 'dispatched') return 'steered';
        if (outcome.kind === 'cancelled' || inputCancelled) {
            settleOnce(capturedMeta.requestId, 'cancelled', { reason: 'native-steer-stopped', scope: scopeKey, sessionId: chatSessionId });
            return 'cancelled';
        }
        broadcast('steer_rejected', stripUndefined({ prompt: newPrompt, origin: source || 'web', scope: scopeKey,
            sessionId: chatSessionId, reason: outcome.reason, requestId: capturedMeta.requestId }));
        return 'fallback-queue';
    }
    if (run && !sameRunConversation(
        { origin: run.meta.origin, remoteKey: run.meta.remoteKey
            ?? (isRemoteTarget(run.meta.target) ? buildRemoteBindingKey(run.meta.target) : undefined) },
        { origin: source, remoteKey: meta?.remoteKey
            ?? (isRemoteTarget(meta?.target) ? buildRemoteBindingKey(meta.target) : undefined) },
    )) {
        // In-band and kill-steer mutate the turn already owned by `run`.
        // Different remote keys are different conversations, even when a legacy
        // scope collapse put them in the same process slot. Let the caller queue
        // a separate follow-up instead of giving this run another user's input
        // and delivery address (#743).
        return 'fallback-queue';
    }
    if (typeof run?.steerTurnInBand === 'function') {
        // codex-app same-turn steer. The user row is written only AFTER the
        // server accepts — a fallback must not leave a duplicate insert for the
        // queued path to write again.
        let outcome: 'steered' | 'unavailable' | 'rejected';
        try {
            outcome = await run.steerTurnInBand(newPrompt);
        } catch (err) {
            console.error('[jaw:steer] codex-app in-band steer failed:', (err as Error).message);
            return 'fallback-queue';
        }
        if (outcome !== 'steered') {
            if (outcome === 'rejected') {
                // review/compact turns structurally reject steer — tell the user
                // their message was queued instead, not silently swallowed.
                broadcast('steer_rejected', stripUndefined({ prompt: newPrompt, origin: source || 'web', scope: scopeKey, sessionId: chatSessionId, reason: 'turn-not-steerable', requestId: meta?.requestId }));
            }
            return 'fallback-queue';
        }
        insertMessage.run('user', newPrompt, source, '', settings["workingDir"] || null, chatSessionId);
        broadcast('new_message', { role: 'user', content: newPrompt, source, scope: scopeKey, sessionId: chatSessionId });
        broadcast('steer_started', buildSteerStartedEvent({
            prompt: newPrompt, source, scopeKey, chatSessionId, meta, mode: 'native-input',
        }));
        settleOnce(meta?.requestId, 'steered');
        return 'steered';
    }
    // Capture the admitted Slack address before kill/wait can yield ownership.
    const slackRestart = source === 'slack' && isRemoteTarget(meta?.target) && meta.target.channel === 'slack'
        ? stripUndefined({ mode: 'restart' as const, scope: scopeKey, sessionId: chatSessionId,
            target: { ...meta.target }, chatId: meta.chatId, requestId: meta.requestId,
            remoteKey: meta.remoteKey, replyViaTarget: true })
        : undefined;
    const steerWaitMs = getSteerWaitMsForActiveAgent(scopeKey);
    // Snapshot BEFORE the kill: the interrupted partial-output row is identified
    // as the first ⏹️-tagged assistant message with id above this mark. A
    // created_at comparison is not safe (second-resolution UTC column).
    const maxIdBeforeKill = getMaxMessageId(chatSessionId);
    const wasRunning = killActiveAgent(scopeKey, 'steer');
    if (wasRunning) await waitForMainProcessEnd(scopeKey, steerWaitMs);
    // The kill removes the scope's map entry synchronously, so the wait above can
    // return before the exit handler's salvage insert. Wait for the settle barrier
    // armed by the kill so the follow-up run actually sees the partial output.
    if (wasRunning) await waitForExitSettled(scopeKey);
    let steerContext: string | null = null;
    if (wasRunning) {
        const salvage = getSteerSalvageAfter(chatSessionId, maxIdBeforeKill);
        // The ⏹️ tag is a human-facing marker; the model gets the payload only.
        steerContext = salvage ? salvage.replace(/^⏹️ \[interrupted\]\s*/, '') : null;
        // A kill-steer that salvages nothing means the new turn starts blind: the
        // interrupted work is gone and the model will not know it happened. That is
        // survivable, but it is invisible — it looks exactly like a normal steer
        // until the answer contradicts what the user just saw. Say so (#523).
        if (!steerContext) {
            broadcast('steer_context_lost', stripUndefined({
                origin: source || 'web',
                scope: scopeKey,
                sessionId: chatSessionId,
                requestId: meta?.requestId,
            }));
        }
    }
    insertMessage.run('user', newPrompt, source, '', settings["workingDir"] || null, chatSessionId);
    broadcast('new_message', { role: 'user', content: newPrompt, source, scope: scopeKey, sessionId: chatSessionId });
    broadcast('steer_started', buildSteerStartedEvent({
        prompt: newPrompt, source, scopeKey, chatSessionId, meta, mode: 'kill-steer', extra: slackRestart,
    }));
    const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await import('../orchestrator/pipeline.js');
    const origin = source || 'web';
    // Union of both contracts: the #655 steer identity (target/chatId/remoteKey/
    // replyViaTarget/_fromSteer) plus the #654 pre-kill capture (slackRestart),
    // whose mode restart is what the reply-control observer treats as a start.
    const steerMeta = stripUndefined({ origin, scope: scopeKey, chatSessionId, requestId: meta?.requestId,
        target: meta?.target, chatId: meta?.chatId, remoteKey: meta?.remoteKey,
        replyViaTarget: meta?.replyViaTarget, _fromSteer: true,
        ...slackRestart, _skipInsert: true, _steerContext: steerContext || undefined });
    const task = isResetIntent(newPrompt)
        ? orchestrateReset(steerMeta)
        : isContinueIntent(newPrompt)
            ? orchestrateContinue(steerMeta)
            : orchestrate(newPrompt, steerMeta);
    task.catch(async (err: Error) => {
        console.error('[steer:orchestrate]', err.message);
        broadcast('orchestrate_done', stripUndefined({ text: `[error] ${err.message}`, error: true, origin,
            target: meta?.target, chatId: meta?.chatId, replyViaTarget: meta?.replyViaTarget,
            fromSteer: true, requestId: meta?.requestId, ...slackRestart }));
        settleOnce(slackRestart ? slackRestart.requestId : meta?.requestId, 'failed', { error: err.message });
    });
    // The follow-up was started as a new run (kill-path or idle race). The caller
    // must NOT also queue the message.
    return 'new-run';
}


// ─── Helpers ─────────────────────────────────────────

export function makeCleanEnv(
    extraEnv: Record<string, string> = {},
    inheritedEnv: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
) {
    const env: NodeJS.ProcessEnv = { ...inheritedEnv };
    delete env["CLAUDE_CODE_SSE_PORT"];
    // Phase 8: strip boss-only dispatch token from employee spawns so employees
    // cannot authenticate against /api/orchestrate/dispatch even via localhost.
    // Detect employee spawn by the explicit JAW_EMPLOYEE_MODE flag; main spawns
    // pass an empty extraEnv and keep the token inherited from process.env.
    if (extraEnv["JAW_EMPLOYEE_MODE"] === '1') {
        delete env["JAW_BOSS_TOKEN"];
    }
    const isWindows = platform === 'win32';
    // Windows treats 'Path' and 'PATH' as the same variable, so a child inheriting
    // both gets whichever the runtime happens to read first (#366). Collapse them to
    // one canonical key. On POSIX they are genuinely different variables and must
    // both survive untouched.
    const readCaseInsensitivePath = (source: Record<string, string | undefined>): string => {
        for (const [key, value] of Object.entries(source)) {
            if (key.toLowerCase() === 'path' && value) return value;
        }
        return '';
    };
    if (isWindows) {
        const inheritedPath = readCaseInsensitivePath(env);
        for (const key of Object.keys(env)) {
            if (key.toLowerCase() === 'path') delete env[key];
        }
        env["PATH"] = inheritedPath;
    }
    // Pass `platform` through: this function already takes it as a parameter and
    // every branch above respects it, but buildServicePath was left to read
    // process.platform. That disagreement was invisible while the two agreed;
    // win32 PATH-entry normalization made it observable, because a POSIX-only
    // env asserted on a Windows runner then had its entries rewritten.
    env["PATH"] = buildServicePath(env["PATH"] || '', [], os.homedir(), platform);

    const merged: NodeJS.ProcessEnv = { ...env, ...extraEnv };
    const extraPath = isWindows ? readCaseInsensitivePath(extraEnv) : extraEnv["PATH"];
    if (isWindows) {
        for (const key of Object.keys(merged)) {
            if (key.toLowerCase() === 'path') delete merged[key];
        }
    }
    // Same platform passthrough as above. This is the call that produces the
    // RETURNED PATH, so a win32/POSIX disagreement here reaches the child.
    merged["PATH"] = buildServicePath(extraPath || env["PATH"] || '', [], os.homedir(), platform);
    for (const key of Object.keys(merged)) if (key.toUpperCase() === SLACK_TOOL_GRANT_ENV) delete merged[key];
    return merged;
}

function buildHistoryBlock(currentPrompt: string, workingDir: string | null | undefined, chatSessionId: string,
    maxSessions = PROMPT_HISTORY_MAX_ROWS, maxTotalChars = PROMPT_HISTORY_MAX_CHARS) {
    const recent = getRecentMessages.all(workingDir || null, chatSessionId, Math.max(1, maxSessions * 2)) as RecentMessageRow[];
    if (!recent.length) return '';

    const promptText = String(currentPrompt || '').trim();
    let skipCurrentPromptBudget = 2;
    const blocks = [];
    let charCount = 0;

    for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        if (!row) continue;
        if (row.cli === 'goal_boundary') break;
        // Goal-continuation boundary rows are chat-timeline markers only
        // the actual continuation
        // prompt is injected at spawn, so replaying the marker is noise.
        if (row.cli === 'goal_continuation') continue;
        const role = String(row.role || '');
        const content = String(row.content || '').trim();

        // Exclude the just-inserted current prompt when caller path stores user text
        // before spawn (e.g. steer/telegram/queue paths).
        if (promptText && i < 3 && skipCurrentPromptBudget > 0 && role === 'user' && content === promptText) {
            skipCurrentPromptBudget--;
            continue;
        }

        if (isCompactMarkerRow(row)) {
            const summary = String(row.trace || '').trim();
            if (summary && !isStaleWorklogHistoryArtifact(summary) && charCount + summary.length <= maxTotalChars) {
                blocks.push(summary);
            }
            break;
        }

        let entry: string;
        if (role === 'assistant' && row.trace && !isStaleWorklogHistoryArtifact(String(row.trace))) {
            entry = `[assistant trace] ${String(row.trace).slice(0, 2000)}`;
        } else if (content && !isStaleWorklogHistoryArtifact(content)) {
            entry = `[${role || 'user'}] ${content}`;
        } else {
            entry = '';
        }
        if (!entry) continue;
        if (charCount + entry.length > maxTotalChars) break;
        blocks.push(entry);
        charCount += entry.length;
    }

    if (!blocks.length) return '';
    return `[Recent Context]\n${blocks.reverse().join('\n\n')}`;
}

function isStaleWorklogHistoryArtifact(text: string): boolean {
    const value = String(text || '');
    return [
        'Read the previous worklog and continue any incomplete tasks.',
        '이 워크로그는 스텁이네요',
        '이전 worklog 기준으로 이어서 진행합니다.',
        'Continuing from previous worklog.',
        '前回の worklog から続行しています。',
        '正在从上一个 worklog 继续。',
    ].some(marker => value.includes(marker));
}

// The session is passed in rather than read globally: the replay is prepended to THIS
// run's prompt, so it has to come from this run's conversation and not from whichever
// one happens to be active (073 §2.5a).
function getLatestAssistantContentForAgyResume(workingDir: string | null | undefined, chatSessionId: string): string | null {
    const rows = getRecentMessages.all(workingDir || null, chatSessionId, 12) as RecentMessageRow[];
    const row = rows.find((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0);
    return row?.content || null;
}

function getRecentAssistantContentsForAgyResume(workingDir: string | null | undefined, chatSessionId: string): string[] {
    const rows = getRecentMessages.all(workingDir || null, chatSessionId, 20) as RecentMessageRow[];
    return rows
        .filter((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0)
        .map((msg) => String(msg.content || '').trim());
}

import { buildArgs, buildResumeArgs, formatAgyPrintTimeout, resolveScopedSessionBucket, resolveSessionBucket } from './args.js';
export { buildArgs, buildResumeArgs, resolveSessionBucket };

const warnedAgyCapabilityFallbacks = new Set<string>();

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer: Buffer | Uint8Array, originalName: string, options?: SaveUploadOptions) =>
    _saveUpload(UPLOADS_DIR, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), originalName, options);
export { buildMediaPrompt, buildMediaPromptMany };

import { canGuardedAgyResume, resolveAgyNativeResume, shouldEmitHeartbeat, shouldResumeBucketSession } from './spawn/resume.js';
export { canGuardedAgyResume, resolveAgyNativeResume, shouldEmitHeartbeat, shouldResumeBucketSession };
import { createQueueController, FALLBACK_MAX_RETRIES } from './spawn/queue.js';
import { stripSkillMentionBlock } from '../core/skill-mentions.js';
export type { QueueController } from './spawn/queue.js';

function cleanupEmployeeTmpDir(cwd: string, workingDir: string, label: string) {
    if (cwd !== workingDir) {
        try { fs.rmSync(cwd, { recursive: true, force: true }); }
        catch (e) { console.warn(`[jaw:${label}] tmp cleanup failed:`, (e as Error).message); }
    }
}

export function spawnAgent(prompt: string, opts: SpawnOpts = {}): SpawnResult {
    const { forceNew = false, agentId, sysPrompt: customSysPrompt, memorySnapshot } = opts;
    const origin = opts.origin || 'web';
    const empSid = opts._skipResume ? null : (opts.employeeSessionId || null);
    const mainManaged = !forceNew && !opts.agentId && !empSid && !opts.internal;
    const gateEligibleMain = mainManaged && !opts.agentId && !opts.internal && !opts._isFallback && !opts._isSmokeContinuation && !opts._isGoalContinuation;
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const capturedScope = currentSessionScope();
    const binding = resolveExecutionBinding(stripUndefined({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId,
        captured: capturedScope, activeChatSessionId: getActiveChatSession(), origin,
        target: opts.target, chatId: opts.chatId, workingDir: settings['workingDir'] || null,
        persistedScopeId: opts.remoteKey, multiSessionEnabled }));
    const scopeKey = binding.scope, chatSessionId = binding.chatSessionId;
    opts = stripUndefined({ ...opts, scopeKey, chatSessionId,
        ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}) });
    // Captured once, at admission. Every terminal event this run emits carries
    // it, so a forwarder never has to guess the destination from global state
    // and a waiter can tell someone else's completion from its own (#742/#743).
    const runPin = runPinFields({ origin, requestId: opts.requestId, scope: scopeKey,
        sessionId: chatSessionId, remoteKey: opts.remoteKey, target: opts.target });

    let mainRun = mainManaged ? activeMainProcesses.get(scopeKey) : undefined;
    if (mainManaged && mainRun && !opts._settingsGateWaited) {
        console.log(`[jaw] Agent already running for scope=${scopeKey}, skipping`);
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }
    if (mainManaged && !mainRun) {
        mainRun = {
            process: null,
            starting: false,
            steering: false,
            ownerGeneration: 0,
            meta: { origin, scopeId: scopeKey, chatSessionId, ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}) },
        };
        activeMainProcesses.set(scopeKey, mainRun);
    }

    if (gateEligibleMain && !opts._settingsGateWaited && isRuntimeSettingsMutationInFlight()) {
        if (queueCtrl.isRetryPending(scopeKey) || mainRun?.starting) {
            console.log('[jaw] Agent already running, skipping');
            return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
        }
        const waitingRun = mainRun!;
        waitingRun.starting = true;
        let cancelled = false;
        let cancelReason = 'user';
        const cancelThisSpawn = (reason: string) => {
            cancelled = true;
            cancelReason = reason;
        };
        waitingRun.cancelPending = cancelThisSpawn;
        const promise: Promise<SpawnPromiseResult> = (async () => {
            try {
                await waitForRuntimeSettingsIdle();
                if (cancelled) {
                    const stopCause = stopCauseFromKillReason(cancelReason);
                    return { text: '', code: 130, executionInterrupted: true,
                        ...(stopCause ? { stopCause } : {}) };
                }
                const next: SpawnResult = spawnAgent(prompt, { ...opts, _settingsGateWaited: true });
                return await next.promise;
            } finally {
                if (waitingRun.cancelPending === cancelThisSpawn) delete waitingRun.cancelPending;
                waitingRun.starting = false;
                void processQueue(scopeKey);
            }
        })();
        return { child: null, promise };
    }

    let resolve: (value: SpawnPromiseResult) => void;
    const resultPromise = new Promise<SpawnPromiseResult>(r => { resolve = r; });

    const session = (getSession() as SessionRow | undefined) ?? {};
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    const ownerGeneration = persistenceOwner.global;
    if (mainRun) mainRun.ownerGeneration = ownerGeneration;
    let cli = resolveMainCli(opts.cli, settings, session);
    if (mainRun) mainRun.meta.cli = cli;

    if (isRetiredCliSelection(cli)) {
        const diagnostic = retiredRuntimeDiagnostic(cli);
        const message = `${diagnostic}: Select an available runtime before sending another request.`;
        const released = mainManaged && activeMainProcesses.get(scopeKey) === mainRun
            && releaseMainRun(scopeKey, null, ownerGeneration);
        settleOnce(opts.requestId, 'failed', { error: diagnostic, text: message,
            scope: scopeKey, sessionId: chatSessionId });
        broadcast('agent_done', {
            ...runPin, text: message, error: true, cli, ...empTag,
        }, isEmployee ? 'internal' : 'public');
        try { opts.lifecycle?.onExit?.(78); } catch { console.warn('[runtime] retirement exit observer failed'); }
        resolve!({ text: message, code: 78 });
        if (released) void processQueue(scopeKey);
        return { child: null, promise: resultPromise };
    }


    // Namespace selection is captured once for this run. Builtin native
    // Codex/Pi keep their existing bucket keys; only switchable adapters use
    // the new namespace. Reject unavailable native choices before fallback,
    // saved-session reads, bootstrap consumption, or worker isolation.
    const runtimeTransport = isSwitchableNativeCli(cli)
        ? resolveRuntimeTransport(settings['perCli']?.[cli]?.transport) : 'print';
    const selectedPermissions = opts.permissions || settings['permissions'] || session.permissions || 'auto';
    const permissions = Array.isArray(selectedPermissions) ? [...selectedPermissions] : selectedPermissions;
    const capturedPermissions: string | string[] | undefined = typeof permissions === 'string'
        || (Array.isArray(permissions) && permissions.every(value => typeof value === 'string')) ? permissions : undefined;
    const unavailableNative = runtimeTransport === 'native'
        && (!isNativeAdapterImplemented(cli) || (isEmployee && !isNativeWorkerImplemented(cli)));
    const restrictiveNative = runtimeTransport === 'native' && (cli === 'cursor' || cli === 'grok') && permissions !== 'auto';
    const unsupportedClaudePolicy = runtimeTransport === 'native' && cli === 'claude'
        && permissions !== 'auto' && permissions !== 'safe';
    const duplicateClaudeWorker = isEmployee && (hasClaudeWorker(opts.agentId || 'main')
        || (runtimeTransport === 'native' && cli === 'claude' && activeProcesses.has(opts.agentId || 'main')));
    if (unavailableNative || restrictiveNative || unsupportedClaudePolicy || duplicateClaudeWorker) {
        const message = duplicateClaudeWorker ? 'Worker is still completing its previous assignment.'
            : unsupportedClaudePolicy ? 'Claude native supports auto or safe permissions. Select print to retain this permission profile.'
            : unavailableNative
            ? `${cli} native ${isEmployee ? 'worker ' : ''}transport is not implemented in this build. Set perCli.${cli}.transport to "print" to use compatibility mode.`
            : `${cli === 'cursor' ? 'Cursor' : 'Grok'} native restrictive permissions are not verified in this build. Select print transport to retain restrictive permission behavior.`;
        const released = mainManaged && activeMainProcesses.get(scopeKey) === mainRun
            && releaseMainRun(scopeKey, null, ownerGeneration);
        broadcast('agent_done', {
            ...runPin, text: message, error: true, cli, ...empTag,
        }, isEmployee ? 'internal' : 'public');
        resolve!({ text: message, code: 78 });
        if (released) void processQueue(scopeKey);
        return { child: null, promise: resultPromise };
    }

    // Ensure AGENTS.md on disk is fresh before CLI reads it
    // Skip for employee spawns — distribute.ts manages AGENTS.md isolation
    if (!opts.internal && !opts._isFallback && !opts.agentId) regenerateB();

    const liveScope = scopeKey;
    // Employee must not pollute boss's liveRun
    const effectiveLiveScope = mainManaged ? liveScope : null;

    // INVARIANT: 모든 외부 호출은 gateway.ts의 scoped busy admission을 거침.
    // 직접 spawnAgent 호출 시 scope별 retry state도 확인할 것.
    if (mainManaged && mainRun?.starting && gateEligibleMain && !opts._settingsGateWaited) {
        console.log('[jaw] Agent already running, skipping');
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }

    // Capture Boss main session channel so disconnected worker results can be
    // replayed to the correct origin/chatId later. Cleared in lifecycle-handler.
    if (mainManaged) {
        setCurrentMainMeta(scopeKey, stripUndefined({
            origin,
            cli,
            permissions: capturedPermissions,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            replyViaTarget: opts.replyViaTarget,
            scopeId: liveScope,
            chatSessionId,
            ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}),
        }));
    }


    // Phase 52: Bootstrap consumption is moved BELOW the bucket-aware `isResume`
    // computation so we can use the authoritative per-bucket resume decision
    // instead of the legacy `isResumeGuess` heuristic. See comment near line 762.

    // ─── Fallback retry: skip to fallback if retries exhausted ───
    if (runtimeTransport !== 'native' && !opts._isFallback && !opts.internal) {
        const st = queueCtrl.fallbackStateForScope(scopeKey).get(cli);
        if (st?.fallbackCli && st.retriesLeft <= 0) {
            const fbAvail = detectCli(st.fallbackCli)?.available;
            if (fbAvail && !isRetiredCliSelection(st.fallbackCli)) {
                console.log(`[jaw:fallback] ${cli} retries exhausted → direct ${st.fallbackCli}`);
                broadcast('agent_fallback', { from: cli, to: st.fallbackCli, reason: 'retries exhausted', ...empTag }, isEmployee ? 'internal' : 'public');
                return spawnAgent(prompt, {
                    ...opts, cli: st.fallbackCli, _isFallback: true, _skipInsert: true,
                });
            }
        }
    }

    if (cli === 'opencode') {
        ensureOpencodeAlwaysAllowPermissions();
    }
    const cfg = settings["perCli"]?.[cli] || {};
    const ao = settings["activeOverrides"]?.[cli] || {};
    const requestedModel = opts.model || ao.model || cfg.model || 'default';
    const effort = opts.effort ?? ao.effort ?? cfg.effort ?? '';
    const effectiveProvider = cli;
    const model = requestedModel;
    const runtimeModel = cli === 'cursor' && runtimeTransport !== 'native' ? resolveCursorModelVariant(model, effort)
        : cli === 'grok' && runtimeTransport === 'native' && model === 'default' ? 'grok-build' : model;
    const codexMultiplexMain = cli === 'codex-app' && mainManaged && !opts.agentId
        && settings["runtime"]?.codexApp?.multiplex === true;
    if (mainManaged) {
        setCurrentMainMeta(scopeKey, stripUndefined({
            origin,
            permissions: capturedPermissions,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            replyViaTarget: opts.replyViaTarget,
            scopeId: liveScope,
            chatSessionId,
            ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}),
            cli,
            model: runtimeModel,
            effectiveProvider,
        }));
    }
    const includeDirectories = Array.isArray(cfg.includeDirectories)
        ? cfg.includeDirectories.filter((dir: unknown): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        : [];

    // System prompt is computed AFTER the resume decision below (#prompt-cache):
    // the frozen task snapshot needs `isResume`/`bucketRow` to pick stored bytes.
    // Snapshot input must be the raw prompt before bootstrap/wrapper mutations.
    const promptForSnapshot = prompt;

    // Bucket-aware resume: codex-spark is kept in its own session bucket so
    // cross-model resume (gpt-5.4 ↔ gpt-5.3-codex-spark) doesn't send a
    // mismatched session_id to the server.
    // Every runtime now keys its bucket by scope (073 §2.1), which replaces the guard 072
    // put here. That guard gave a non-default scope no bucket at all — no resume, no
    // snapshot, no stale clear — because sharing one was worse. Having its own is better
    // than either. The default scope keeps the bare bucket name, so a session that existed
    // before this change continues the conversation it was already in.
    const currentBucket = runtimeSessionBucket(resolveScopedSessionBucket(
        cli, runtimeModel, effectiveProvider, scopeKey, effort, 'fallback', codexMultiplexMain,
    ), runtimeTransport);
    const envDefaultsCli = cli;
    const cliEnv = applyCliEnvDefaults(envDefaultsCli, opts.env);
    const spawnEnv = makeCleanEnv(cliEnv);
    // Capture a request grant before ANY runtime branch acquires or launches a
    // process. Scheduled work also permits employee runtimes: its server-owned
    // grant is narrower than their ordinary credentials and is the only way
    // they may address Slack during this assignment.
    const slackToolGrantEligible = origin === 'heartbeat'
        || (!isEmployee && ['cursor', 'claude', 'codex', 'grok'].includes(cli));
    const slackToolGrant = slackToolGrantEligible
        ? activateSlackToolGrant(opts.requestId, scopeKey, chatSessionId)
        : undefined;
    if (slackToolGrant) spawnEnv[SLACK_TOOL_GRANT_ENV] = slackToolGrant;
    const bucketRow = currentBucket ? getSessionBucket.get(currentBucket) as SessionBucketRow | undefined : null;
    const bucketSessionId = bucketRow?.session_id || null;
    const bucketModel = typeof bucketRow?.model === 'string' ? bucketRow.model : null;
    const bucketResumeKey = typeof bucketRow?.resume_key === 'string' ? bucketRow.resume_key : null;
    const bucketUpdatedAt = bucketRow?.updated_at ?? null;
    const resumeKey = buildSessionResumeKey(cli, spawnEnv);
    const agyBinaryForCapabilities = cli === 'agy' ? (detectCli('agy').path || 'agy') : null;
    const earlyAgyCapabilities = agyBinaryForCapabilities ? detectAgyCapabilities(agyBinaryForCapabilities) : undefined;
    const agyResumeDecision = canGuardedAgyResume({
        mode: resolveAgyNativeResume(cfg.nativeResume),
        conversationSupported: earlyAgyCapabilities?.conversation === true,
        sessionId: bucketSessionId, bucketUpdatedAt, requestedModel: runtimeModel, bucketModel,
        cwd: settings['workingDir'] || '', lastRunCwd: bucketRow?.last_run_cwd,
        lastRunClean: bucketRow?.last_run_clean, lastRunMeta: bucketRow?.last_run_meta,
        freshBootstrap: forceNew || opts._skipResume === true || Boolean(peekPendingBootstrapPrompt(scopeKey)),
    });
    if (cli === 'agy') console.log(`[agy-resume] ${agyResumeDecision.ok ? 'resume' : 'fresh'} reason=${agyResumeDecision.reason}`);
    // AGY native resume can replay prior stdout and continue stale mid-turn planner
    // state. cli-jaw defaults to DB history; guarded native resume is explicit opt-in.
    const providerSupportsResume = cli !== 'agy'
        ? true
        : agyResumeDecision.ok;
    const canResumeBucketSession = !bucketSessionId || shouldResumeBucketSession(
        cli,
        runtimeModel,
        bucketModel,
        resumeKey,
        bucketResumeKey,
        bucketUpdatedAt,
        Date.now(),
        effectiveProvider,
    );
    const isResume = empSid
        ? true
        : (providerSupportsResume && !opts._skipResume && !forceNew && !!bucketSessionId && canResumeBucketSession);

    // ─── Bootstrap compact 1-shot injection (Phase 52: bucket-aware) ───
    // Vendor-agnostic: compact handler reset session_id and stored bootstrap in DB.
    // Inject only on fresh main spawns (not employee/fallback/internal/resume).
    // Using `isResume` (bucket-aware) instead of legacy `isResumeGuess` so cross-model
    // toggles (e.g. gpt-5.4 ↔ gpt-5.3-codex-spark) get the bootstrap they need.
    if (!opts.agentId && !opts.internal && !isResume) {
        const pending = consumePendingBootstrapPrompt(scopeKey);
        if (pending) {
            console.log(`[jaw:compact] injecting bootstrap (${pending.length} chars)`);
            prompt = `${pending}\n\n---\n\n${prompt}`;
        }
    }

    if (!empSid && !forceNew && bucketSessionId && !canResumeBucketSession) {
        if (!peekPendingBootstrapPrompt(scopeKey)) {
            import('../core/compact.js')
                .then(({ autoCompactRefresh }) => autoCompactRefresh({
                    workDir: settings["workingDir"] || null, instructions: '', cli, model: runtimeModel, scopeKey,
                    chatSessionId,
                    ...(currentBucket ? { sessionBucket: currentBucket } : {}),
                }))
                .catch(() => {});
        }
        try {
            if (currentBucket) clearSessionBucket.run(currentBucket);
        } catch (e) {
            console.warn('[jaw:resume] stale bucket clear failed:', (e as Error).message);
        }
        if (cli === 'opencode' && resumeKey !== (bucketResumeKey ?? null)) {
            console.log(`[jaw:resume] ${cli} resume key changed ${bucketResumeKey ?? 'none'} → ${resumeKey}; starting fresh session`);
        } else {
            console.log(`[jaw:resume] ${cli} model changed ${bucketModel} → ${runtimeModel}; starting fresh session`);
        }
    }

    // ─── Frozen task snapshot (#prompt-cache) ────────────
    // Boss-session turns reuse the snapshot stored at the chain's fresh spawn so
    // the system prompt stays byte-identical across resume turns (cache hits).
    // Regenerated only here on fresh spawns; the row (and snapshot) dies on any
    // bucket clear (compact / model change / stale TTL), matching the agreed
    // "fresh spawn + compact" refresh triggers. Explicit opts.memorySnapshot wins.
    let memorySnapshotForPrompt = memorySnapshot;
    if (!opts.agentId && memorySnapshotForPrompt === undefined && customSysPrompt === undefined && currentBucket) {
        const frozen = isResume && typeof bucketRow?.memory_snapshot === 'string' && bucketRow.memory_snapshot
            ? bucketRow.memory_snapshot
            : null;
        if (frozen) {
            memorySnapshotForPrompt = frozen;
        } else {
            try {
                const built = buildTaskSnapshot(promptForSnapshot, 2800) || '';
                if (built) {
                    memorySnapshotForPrompt = built;
                    setSessionBucketSnapshot.run(currentBucket, runtimeModel, built);
                }
            } catch (e) {
                console.warn('[jaw:snapshot] freeze build failed:', (e as Error).message);
            }
        }
    }

    const sysPrompt = customSysPrompt !== undefined
        ? customSysPrompt
        : getSystemPrompt(stripUndefined({ currentPrompt: promptForSnapshot, forDisk: false, memorySnapshot: memorySnapshotForPrompt, activeCli: cli, freshSession: !isResume }));

    // ─── User prompt wrapper (boss main only) ───
    // #99: compact timestamp + project root (moved from builder.ts system prompt → user prompt)
    // + memory search nudge (regular messages only)
    if (!opts.agentId && !opts.internal) {
        const _d = new Date(); const _p = (n: number) => String(n).padStart(2, '0');
        const _h = _d.getHours(); const _h12 = _h % 12 || 12;
        const ts = `${_p(_d.getFullYear() % 100)}${_p(_d.getMonth() + 1)}${_p(_d.getDate())}-${_p(_h12)}:${_p(_d.getMinutes())}${_h < 12 ? 'AM' : 'PM'}.`;
        const _projDirs = getProjectDirs();
        const projLine = _projDirs && _projDirs.length > 0
            ? _projDirs.map(d => `Project root: ${d}`).join('\n') + '\n'
            : '';
        const memoryNudge = (!opts._isSmokeContinuation && !opts._isGoalContinuation)
            ? '\n(need history? L1: cli-jaw chat/memory search/context | L2: cli-jaw dashboard memory search, cli-jaw dashboard chat search)'
            : '';
        const promptWithConversation = prependRemoteConversationContext(prompt, opts.target);
        prompt = `${ts}\n${calendarContext(_d)}\n${projLine}${promptWithConversation}${memoryNudge}`;
    }

    const resumeSessionId = empSid || (isResume ? bucketSessionId : null);
    const needsHistory = shouldBuildHistoryBlock({
        skipHistory: opts._skipHistory === true,
        isResume,
        cli,
        codexMultiplexMain,
    });
    const historyBlock = needsHistory
        ? buildHistoryBlock(
            prompt,
            settings["workingDir"],
            chatSessionId,
            PROMPT_HISTORY_MAX_ROWS,
            PROMPT_HISTORY_MAX_CHARS,
        )
        : '';
    let agyBootstrap: AgyBootstrapEnvelope | null = null;
    let promptForArgs = buildPromptForArgs({
        cli,
        effectiveProvider,
        runtimeTransport,
        prompt,
        historyBlock,
        sysPrompt,
        isResume,
    });
    promptForArgs = withSteerContext(promptForArgs, opts.steerContext);
    const agyResumeReplayPrefix = cli === 'agy' && isResume
        ? getLatestAssistantContentForAgyResume(settings["workingDir"], chatSessionId)
        : null;
    const agyResumeReplayPrefixes = cli === 'agy' && isResume
        ? getRecentAssistantContentsForAgyResume(settings["workingDir"], chatSessionId)
        : [];
    const agyLogFile = cli === 'agy'
        ? join(os.tmpdir(), `jaw-agy-${agentId || 'main'}-${Date.now()}-${crypto.randomUUID()}.log`)
        : null;
    // The single agentTimeout parse for this run. Claude, the print watchdog and
    // codex-app all read THIS object; before #682 the print path reparsed the same
    // settings a second time, so fixing a timeout knob meant finding which of two
    // parsers a given runtime happened to use.
    const mergedTimeoutCfg = mergeAgentTimeoutCfg(cli);
    const resolvedAgyPrintTimeoutMs = typeof mergedTimeoutCfg['absoluteHardCapMs'] === 'number'
        ? mergedTimeoutCfg['absoluteHardCapMs'] as number
        : DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS;
    const agyPrintTimeout = cli === 'agy'
        ? formatAgyPrintTimeout(resolvedAgyPrintTimeoutMs)
        : undefined;
    const agyCapabilities = earlyAgyCapabilities;
    if (agyCapabilities?.usedFallback && agyBinaryForCapabilities && !warnedAgyCapabilityFallbacks.has(agyBinaryForCapabilities)) {
        warnedAgyCapabilityFallbacks.add(agyBinaryForCapabilities);
        console.warn('[agy-capabilities] probe failed; using legacy emit-all argv compatibility');
    }
    let argOptions = {
        fastMode: cfg.fastMode,
        sysPrompt,
        includeDirectories,
        workingDir: settings["workingDir"],
        ...(agyLogFile ? { agyLogFile } : {}),
        ...(agyPrintTimeout ? { agyPrintTimeout } : {}),
        ...(agyCapabilities ? { agyCapabilities } : {}),
    };
    const buildCurrentArgs = (options: typeof argOptions): string[] => {
        if (!isResume) {
            return buildArgs(cli, runtimeModel, effort, promptForArgs, sysPrompt, permissions, options);
        }
        const sid = resumeSessionId || '';
        console.log(`[jaw:resume] ${cli} session=${sid.slice(0, 12)}...`);
        return buildResumeArgs(cli, runtimeModel, effort, sid, promptForArgs, permissions, options);
    };
    let args: string[] = [];
    if (cli !== 'agy' && runtimeTransport !== 'native') args = buildCurrentArgs(argOptions);

    const agentLabel = agentId || 'main';
    const traceAudience: 'public' | 'internal' = (opts.internal || isEmployee) ? 'internal' : 'public';
    const parentLiveScopeForChild = !opts.internal && isEmployee ? liveScope : null;

    // ─── Universal employee isolation ────────────────────
    // All CLIs auto-read AGENTS.md/CLAUDE.md/GEMINI.md from cwd.
    // Employees must NOT see the Boss's instruction files.
    let spawnCwd = settings["workingDir"];
    let claudeEmployeeTmpDir: string | undefined;
    let piEmployeeTmp: { path: string; dev: bigint; ino: bigint } | undefined;
    const cleanupPiEmployee = () => {
        if (!piEmployeeTmp) return;
        const owned = piEmployeeTmp;
        try {
            const stat = fs.lstatSync(owned.path, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
                || fs.realpathSync(owned.path) !== owned.path) {
                console.warn('[jaw:pi] retaining employee cwd: directory ownership changed', owned.path); return;
            }
            fs.rmSync(owned.path, { recursive: true });
            piEmployeeTmp = undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            console.warn('[jaw:pi] retaining employee cwd: cleanup failed', owned.path);
        }
    };

    if (opts.agentId && (customSysPrompt || sysPrompt)) {
        const empPrompt = customSysPrompt || sysPrompt;
        const empPromptWithWorkspace = opts.workspaceContext
            ? `${opts.workspaceContext}\n\n${empPrompt}`
            : empPrompt;
        const nativeClaude = runtimeTransport === 'native' && cli === 'claude';
        const tmpDir = nativeClaude || cli === 'pi'
            ? fs.mkdtempSync(join(cli === 'pi' ? fs.realpathSync(os.tmpdir()) : os.tmpdir(),
                `jaw-emp-${agentLabel.slice(0, 80).replace(/[^\w.-]/g, '_')}-`))
            : join(os.tmpdir(), `jaw-emp-${agentLabel}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        if (nativeClaude) claudeEmployeeTmpDir = tmpDir;
        if (cli === 'pi') {
            const created = fs.lstatSync(tmpDir, { bigint: true });
            if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('Pi employee cwd ownership unavailable');
            const canonical = fs.realpathSync(tmpDir);
            const stat = fs.lstatSync(canonical, { bigint: true });
            if (canonical !== tmpDir || !stat.isDirectory() || stat.isSymbolicLink()
                || stat.dev !== created.dev || stat.ino !== created.ino) throw new Error('Pi employee cwd ownership unavailable');
            piEmployeeTmp = { path: canonical, dev: stat.dev, ino: stat.ino };
        }

        for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md']) {
            fs.writeFileSync(join(tmpDir, name), empPromptWithWorkspace);
        }
        const dotClaudeDir = join(tmpDir, '.claude');
        fs.mkdirSync(dotClaudeDir, { recursive: true });
        fs.writeFileSync(join(dotClaudeDir, 'CLAUDE.md'), empPromptWithWorkspace);
        try {
            fs.symlinkSync(settings["workingDir"], join(tmpDir, 'workspace'), 'dir');
        } catch {
            // Non-fatal: the absolute Project root in Workspace Context remains authoritative.
        }

        spawnCwd = tmpDir;
        console.log(`[jaw:${agentLabel}] Employee isolated → ${tmpDir}`);
    }

    if (cli === 'agy') {
        agyBootstrap = buildAgyBootstrapEnvelope({
            taskPrompt: prompt,
            historyBlock,
            workingDir: spawnCwd,
            sessionId: resumeSessionId,
            order: resolveAgyPromptOrder(cfg.promptOrder),
            ...(sysPrompt ? { operationalContext: sysPrompt } : {}),
        });
        promptForArgs = agyBootstrap.prompt;
        argOptions = { ...argOptions, workingDir: spawnCwd };
        args = buildCurrentArgs(argOptions);
    }

    const policyVerdicts = runBeforeSpawnChecks({
        cli,
        promptChars: promptForArgs.length + (sysPrompt?.length || 0),
        prompt: `${sysPrompt || ''}\n${promptForArgs}`,
    });
    if (policyVerdicts.length && mainRun) mainRun.meta.policyVerdicts = policyVerdicts;

    // ─── DIFF-A: Preflight — verify CLI binary exists before spawn ───
    const detected = detectCli(cli);
    const resolvedOpencodeBinary = cli === 'opencode'
        ? resolveOpencodeBinary(spawnEnv, '')
        : '';
    const cliAvailable = cli === 'opencode'
        ? detected.available || !!resolvedOpencodeBinary
        : detected.available;
    if (!cliAvailable) {
        const msg = formatCliUnavailableMessage(cli, detected);
        console.error(`[jaw:${agentLabel}] ${msg}`);
        if (mainManaged) clearLiveRun(liveScope);
        broadcast('agent_done', { ...runPin, text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        resolve!({ text: '', code: 127 });
        if (mainManaged) {
            releaseMainRun(scopeKey, null, ownerGeneration);
            void processQueue(scopeKey);
        }
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        return { child: null, promise: resultPromise };
    }

    if (cli === 'copilot') {
        console.log(`[jaw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
    } else {
        console.log(`[jaw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
    }


    // ─── Native Claude: provider adaptation uses the shared host/lifecycle. ───
    if (runtimeTransport === 'native' && cli === 'claude') {
        const cleanupClaudeWorker = () => {
            if (claudeEmployeeTmpDir) cleanupEmployeeTmpDir(claudeEmployeeTmpDir, '', agentLabel);
        };
        const capturedRun = mainRun;
        let capturedExit: ExitSettler | undefined;
        const ownedRun = () => isCurrentSessionOwner(persistenceOwner, scopeKey)
            && (!mainManaged || activeMainProcesses.get(scopeKey) === capturedRun);
        let attachedCancel: ((reason: string) => void) | undefined;
        const watchdog: NonNullable<Parameters<typeof attachWatchdog>[3]> = {};
        for (const key of ['firstProgressMs', 'idleMs', 'absoluteMs', 'absoluteHardCapMs'] as const) {
            const value = mergedTimeoutCfg[key];
            if (typeof value === 'number') watchdog[key] = value;
        }
        const prepared: PreparedClaudeOptions = { cwd: spawnCwd || process.cwd(), binary: detected.path || 'claude',
            env: spawnEnv, model: runtimeModel, systemPrompt: sysPrompt, permissions: permissions as PreparedClaudeOptions['permissions'],
            fastMode: cfg.fastMode === true, ...(effort ? { effort: effort as PreparedClaudeOptions['effort'] } : {}) };
        try {
            return startClaudeNativeRun({ prepared, timeoutMs: resolvedAgyPrintTimeoutMs, watchdog,
                prompt: { text: withSteerContext(withHistoryPrompt(prompt, historyBlock), opts.steerContext), ...(opts.images ? { images: opts.images } : {}) },
                audience: traceAudience, liveScope: effectiveLiveScope, parentLiveScope: parentLiveScopeForChild,
                ...(opts.runtimeParentItemId ? { parentItemId: opts.runtimeParentItemId } : {}),
                storedSessionId: resumeSessionId,
                fresh: forceNew || opts._skipResume === true || isEmployee || Boolean(slackToolGrant),
                cleanupUnleased: cleanupClaudeWorker,
                isCurrent: ownedRun, isCurrentOwner: token => isCurrentSessionOwner(token, scopeKey), consumeKillReason,
                activity: identity => opts.lifecycle?.onActivity?.('native-runtime', identity),
                exited: code => opts.lifecycle?.onExit?.(code),
                cancelling: reason => {
                    if (isLifecycleExitSettleReason(reason)) { armExitSettle(scopeKey); capturedExit ??= captureExitSettler(scopeKey); }
                },
                exit: { cli, model: runtimeModel, effectiveProvider, agentLabel, mainManaged, origin, resumeKey, prompt, opts,
                    cfg: { ...cfg, effort }, ownerGeneration, persistenceOwner, forceNew, empSid, isResume, effortDefault: effort,
                    activeProcesses, scopeKey, runtimeTransport, scopedBucket: currentBucket, chatSessionId, releaseMainRun,
                    retryState: queueCtrl.retryStateForScope(scopeKey), fallbackState: queueCtrl.fallbackStateForScope(scopeKey), fallbackMaxRetries: FALLBACK_MAX_RETRIES },
                starting: cancel => {
                    attachedCancel = cancel;
                    if (capturedRun) { capturedRun.starting = true; capturedRun.cancelPending = cancel; }
                },
                ready: (child, cancel) => {
                    if (!ownedRun()) throw new Error('claude_owner_lost');
                    attachedCancel ??= cancel;
                    if (capturedRun) {
                        capturedRun.process = child; capturedRun.starting = false;
                        if (capturedRun.cancelPending === attachedCancel) delete capturedRun.cancelPending;
                        capturedRun.cancelTurn = attachedCancel;
                    } else registerActiveProcess(agentLabel, child);
                },
                finished: (child, _cancel, queued, cleanupSafe) => {
                    try {
                        if (capturedRun && capturedRun.cancelPending === attachedCancel) delete capturedRun.cancelPending;
                        if (capturedRun && capturedRun.cancelTurn === attachedCancel) delete capturedRun.cancelTurn;
                        if (capturedRun && activeMainProcesses.get(scopeKey) === capturedRun) releaseMainRun(scopeKey, child, ownerGeneration);
                        if (!mainManaged && activeProcesses.get(agentLabel) === child) activeProcesses.delete(agentLabel);
                        if (cleanupSafe) cleanupClaudeWorker();
                    } finally {
                        settleCapturedExit(scopeKey, capturedExit);
                        if (mainManaged && (queued || !activeMainProcesses.has(scopeKey))) void processQueue(scopeKey);
                    }
                },
            });
        } catch {
            if (capturedRun && activeMainProcesses.get(scopeKey) === capturedRun) releaseMainRun(scopeKey, null, ownerGeneration);
            cleanupClaudeWorker();
            const text = 'Claude native runtime could not be admitted.';
            broadcast('agent_done', { ...runPin, text, error: true, cli, ...empTag }, traceAudience);
            if (mainManaged && !activeMainProcesses.has(scopeKey)) void processQueue(scopeKey);
            return { child: null, promise: Promise.resolve({ text, code: 1 }) };
        }
    }

    // ─── Native ACP main: protocol ownership is separate from application settlement. ───
    // Backend branches live in ./spawn/backend-*.ts; they read these values, captured here,
    // and never write back (no spawnAgent binding they read is reassigned after this point).
    const backendLocals: SpawnBackendLocals = { agentLabel, bucketSessionId, cfg, chatSessionId, cleanupPiEmployee, cli, codexMultiplexMain, currentBucket, detected, effectiveLiveScope, effectiveProvider, effort, empSid, empTag, forceNew, historyBlock, isEmployee, isResume, liveScope, mainManaged, mainRun, model, opts, origin, ownerGeneration, parentLiveScopeForChild, permissions, persistenceOwner, prompt, promptForArgs, promptForSnapshot, resolve: (value) => resolve(value), resolvedAgyPrintTimeoutMs, resultPromise, resumeKey, resumeSessionId, runPin, runtimeModel, runtimeTransport, scopeKey, slackToolGrant, spawnCwd, spawnEnv, sysPrompt, traceAudience };
    const backendHost: SpawnBackendHost = { CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS, DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS, DEFAULT_CODEX_APP_TURN_ABS_MS, DEFAULT_CODEX_APP_TURN_IDLE_MS, STDERR_BUF_CAP, activeMainProcesses, activeProcesses, appendParentLiveRunTool, broadcastAgentOutput, buildHistoryBlock, cancelOwnedPiProcess, cleanupEmployeeTmpDir, clearMainLiveRunOnStop, configuredPositiveMs, consumeKillReason, piProfileFingerprintKey, processQueue, queueCtrl, registerActiveProcess, releaseMainRun, stoppedBeforeStart };
    if (runtimeTransport === 'native' && (cli === 'cursor' || cli === 'grok') && mainManaged) return runNativeAcpBackend(backendLocals, backendHost);

    // ─── Copilot ACP branch ──────────────────────
    if (cli === 'copilot') return runCopilotBackend(backendLocals, backendHost);

    // ─── Pi RPC branch ─────────────────────────────
    if (cli === 'pi') return runPiBackend(backendLocals, backendHost);

    // ─── Codex AppServer branch ────────────────────
    if (cli === 'codex-app') return runCodexAppBackend(backendLocals, backendHost);

    // ─── Standard CLI branch (claude/codex/opencode) ──────
    const spawnCommand = cli === 'opencode' && process.platform !== 'win32'
        ? (resolvedOpencodeBinary || detected.path || cli)
        : (detected.path || cli);
    // On Windows, resolve an npm .cmd shim to its interpreter + script so the child can
    // be spawned WITHOUT a shell (#367). Passing shell:true here routes prompt argv
    // through cmd.exe, where metacharacters stop being literal data.
    //
    // If resolution fails we currently keep the legacy shell path rather than refusing
    // to launch: the fail-closed contract only becomes safe once the native Windows
    // gate proves every classified runtime resolves. Until then, refusing here would
    // break working installs on a code path that has no local test coverage.
    const windowsLaunch = process.platform === 'win32'
        ? resolveWindowsLaunchSpec(spawnCommand, args, {
            // A bare name must be discovered before we decide it is "direct": Windows
            // would otherwise resolve e.g. 'copilot' to copilot.cmd through PATHEXT at
            // spawn time, under a shell — the exact defect #367 removes.
            which: (name) => detectCliBinary(name).path || null,
        })
        : null;
    const launchCommand = windowsLaunch ? windowsLaunch.command : spawnCommand;
    const launchArgs = windowsLaunch ? launchArgv(windowsLaunch) : args;
    const launchEnv = windowsLaunch && Object.keys(windowsLaunch.envDelta).length
        ? mergeEnvWindowsSafe(spawnEnv, windowsLaunch.envDelta)
        : spawnEnv;
    const windowsSpawnUsesShell = process.platform === 'win32'
        && !windowsLaunch
        && !spawnCommand.toLowerCase().endsWith('.exe');
    // Stage 2 of #367. Stage 1 removed the shell wherever the resolver succeeded but left
    // the failure path handing argv to cmd.exe unconditionally. When that argv carries the
    // prompt, cmd.exe reparses it and the prompt can start a second command — so refuse
    // instead of launching. The check is on argv CONTENT, not on which CLI is spawning: a
    // per-runtime allowlist fails open the moment a runtime starts passing the prompt
    // positionally, and this cannot go stale that way.
    if (windowsSpawnUsesShell) {
        const decision = decideShellFallback({
            argv: launchArgs,
            prompt: promptForArgs,
            sysPrompt,
            command: spawnCommand,
        });
        if (!decision.allowed) {
            // Settle through the normal pre-spawn failure lifecycle, exactly as the
            // cliAvailable refusal above does. Throwing here would leave the reservation
            // taken in activeMainProcesses: the caller would see one error and then every
            // later request for this scope would be rejected as "already running".
            console.error(`[jaw:${agentLabel}] ${decision.reason}`);
            if (mainManaged) clearLiveRun(liveScope);
            broadcast('agent_done', { ...runPin, text: `❌ ${decision.reason}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
            resolve!({ text: '', code: 126 });
            if (mainManaged) {
                releaseMainRun(scopeKey, null, ownerGeneration);
                void processQueue(scopeKey);
            }
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            return { child: null, promise: resultPromise };
        }
    }
    const opencodeSpawnAudit = cli === 'opencode'
        ? buildOpencodeSpawnAudit({ args, cwd: spawnCwd, env: spawnEnv, binary: spawnCommand })
        : undefined;
    if (opencodeSpawnAudit) {
        console.log(`[jaw:opencode:audit] ${JSON.stringify(opencodeSpawnAudit)}`);
    }
    // The snapshot has to predate the child; the helper owns that ordering (073 §2.4).
    const kiroPlainText = isKiroPlainTextCli(cli, effectiveProvider);
    const { child, kiroConversationIdsBefore, kiroSpawnStartedAt } = spawnWithKiroSnapshot({
        kiroPlainText,
        isFreshMainRun: !isResume && !empSid,
        cwd: spawnCwd,
        spawn: () => spawn(launchCommand, launchArgs, {
            cwd: spawnCwd,
            env: launchEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(windowsSpawnUsesShell ? { shell: true } : {}),
        }),
    });
    if (mainManaged) mainRun!.process = child;
    else registerActiveProcess(agentLabel, child);
    if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });
    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

    // The turn settles on 'close', which waits for every stdio stream to close.
    // A descendant that inherited these pipes can outlive the child and hold
    // them open forever, so bound that wait while still draining short tails.
    const releaseExitDrain = releaseChildOutputAfterExit(child, {
        onRelease: (reason) => {
            console.warn(`[jaw:drain] ${agentLabel} exited but output stayed open — released after ${reason}`);
        },
    });

    // ─── DIFF-A: error guard — prevent uncaught ENOENT crash ───
    let stdSettled = false;  // guard: error→close can fire sequentially
    let lastOpencodeIoAt = Date.now();
    let opencodeIdleTimer: ReturnType<typeof setInterval> | null = null;
    let agyQuietCompletionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearOpencodeIdleTimer = () => {
        if (!opencodeIdleTimer) return;
        clearInterval(opencodeIdleTimer);
        opencodeIdleTimer = null;
    };
    const clearAgyQuietCompletionTimer = () => {
        if (!agyQuietCompletionTimer) return;
        clearTimeout(agyQuietCompletionTimer);
        agyQuietCompletionTimer = null;
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
        clearOpencodeIdleTimer();
        clearAgyQuietCompletionTimer();
        releaseExitDrain();
        if (stdSettled) return;
        stdSettled = true;
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        opts.lifecycle?.onExit?.(null);
        const msg = err.code === 'ENOENT'
            ? `CLI '${cli}' 실행 실패 (ENOENT). 설치/경로를 확인하세요.`
            : err.code === 'ENOEXEC'
                ? `CLI '${cli}' 실행 실패 (ENOEXEC). PATH의 실행 파일이 바이너리 또는 shebang 스크립트가 아닙니다. \`jaw doctor --json\`으로 깨진 shim을 확인하세요.`
                : `CLI '${cli}' 실행 실패: ${err.message}`;
        console.error(`[jaw:${agentLabel}:error] ${msg}`);
        if (mainManaged) {
            releaseMainRun(scopeKey, child, ownerGeneration);
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
        } else {
            activeProcesses.delete(agentLabel);
        }
        broadcast('agent_done', { ...runPin, text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        finishPrintActivity(ctx, { kind: 'turn-end', status: 'error', finalText: null, error: msg });
        resolve!({ text: '', code: 127 });
        if (mainManaged) void processQueue(scopeKey);
    });

    if (mainManaged && !opts.internal && !opts._skipInsert) {
        // The runtime gets the inline-skill block; the chat row keeps what was written.
        insertMessage.run('user', stripSkillMentionBlock(prompt), cli, runtimeModel, settings["workingDir"] || null, chatSessionId);
    }

    if (cli === 'claude') {
        child.stdin.write(withSteerContext(isResume ? prompt : withHistoryPrompt(prompt, historyBlock), opts.steerContext));
    } else if (cli === 'codex' && !isResume) {
        const codexStdin = historyBlock
            ? `${historyBlock}\n\n[User Message]\n${prompt}`
            : `[User Message]\n${prompt}`;
        child.stdin.write(withSteerContext(codexStdin, opts.steerContext));
    } else if (cli === 'codex' && isResume) {
        // Resume passes '-' in argv (see args.ts) so the prompt travels on stdin,
        // matching the fresh path.
        child.stdin.write(withSteerContext(prompt || '', opts.steerContext));
    }
    child.stdin.end();

    if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

    const traceRunId = startTraceRun({ cli, model: runtimeModel, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience, sessionId: chatSessionId, scopeKey });
    if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
    // Native `agy --conversation ... -p` may emit only the current answer.
    // Length-based replay trimming can therefore swallow the whole new answer.
    const agyResumeOffset = 0;
    const ctx: SpawnContext = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        runStartedAt: Date.now(),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...(origin ? { origin } : {}),
        sessionId: ((kiroPlainText || cli === 'agy') && isResume && resumeSessionId) ? resumeSessionId : null,
        cost: null as number | null,
        turns: null as number | null,
        duration: null as number | null,
        tokens: null,
        stderrBuf: '',
        hasActiveSubAgent: false,
        showReasoning: settings["showReasoning"] === true,
        outputTextStarted: false,
        effectiveProvider,
        liveScope: effectiveLiveScope,
        parentLiveScope: parentLiveScopeForChild,
        traceRunId,
        traceAudience,
        activityIdentity: { sessionId: chatSessionId, scope: scopeKey },
        ...(opencodeSpawnAudit ? { opencodeSpawnAudit: opencodeSpawnAudit as Record<string, unknown> } : {}),
        ...(agyResumeOffset > 0 ? { agyResumeOffset, agyBytesReceived: 0 } : {}),
        ...(cli === 'agy' ? {
            agyTranscriptMode: 'not-started' as const,
            agyLastActivitySource: 'none' as const,
            ...(agyBootstrap ? {
                agyBootstrapSentinel: agyBootstrap.sentinel,
                agyBootstrapHash: agyBootstrap.hash,
                metadata: { agyPromptSpill: agyBootstrap.spill },
            } : {}),
            agyBootstrapAccepted: false,
            agyBootstrapAcceptanceMode: agyBootstrap ? 'pending' as const : 'not-applicable' as const,
        } : {}),
        ...(kiroPlainText || cli === 'agy' || cli === 'pi' ? { liveOutputText: '' } : {}),
        ...(kiroPlainText ? { kiroLastVisibleAt: Date.now(), kiroHeartbeatSent: false } : {}),
    };
    ctx.printActivity = createPrintActivity({ runId: traceRunId, sessionId: chatSessionId,
        scope: scopeKey, turnId: traceRunId, audience: traceAudience }, cli);
    let agyClosing = false;
    let agyGuardedStaleDetected = false;
    const scheduleAgyQuietCompletion = () => {
        if (cli !== 'agy') return;
        if (agyClosing) return;
        clearAgyQuietCompletionTimer();
        const quietCompletionDelayMs = getAgyQuietCompletionDelayMs(ctx);
        if (quietCompletionDelayMs === null) return;
        agyQuietCompletionTimer = setTimeout(() => {
            agyQuietCompletionTimer = null;
            if (!child.pid || getAgyQuietCompletionDelayMs(ctx) === null) return;
            console.log(`[jaw:agy] output quiet for ${quietCompletionDelayMs}ms — completing print run`);
            killReasons.set(child.pid, AGY_COMPLETE_KILL_REASON);
            try {
                ownProcess(child).terminate('completion');
            } catch (e) {
                console.warn('[jaw:agy] quiet completion kill failed:', (e as Error).message);
            }
        }, quietCompletionDelayMs);
    };

    // ─── Subprocess stall watchdog (Phase 1: #178 OAuth2 stall recovery) ───
    // Reads the same mergedTimeoutCfg the Claude branch does. This block used to
    // reparse settings.agentTimeout on its own, so a timeout knob behaved differently
    // depending on which parser a runtime happened to reach (#682).
    const watchdogConfig: { firstProgressMs?: number; idleMs?: number; absoluteMs?: number; absoluteHardCapMs?: number } = {};
    if (typeof mergedTimeoutCfg['firstProgressMs'] === 'number') watchdogConfig.firstProgressMs = mergedTimeoutCfg['firstProgressMs'];
    if (typeof mergedTimeoutCfg['idleMs'] === 'number') watchdogConfig.idleMs = mergedTimeoutCfg['idleMs'];
    if (typeof mergedTimeoutCfg['absoluteMs'] === 'number') watchdogConfig.absoluteMs = mergedTimeoutCfg['absoluteMs'];
    if (typeof mergedTimeoutCfg['absoluteHardCapMs'] === 'number') watchdogConfig.absoluteHardCapMs = mergedTimeoutCfg['absoluteHardCapMs'];
    const stallWatchdog = attachWatchdog(child, agentLabel, (reason) => {
        console.log(`[jaw:watchdog] killing ${agentLabel} — ${reason}`);
        ctx.stallReason = reason;
        if (cli === 'agy') {
            ctx.agyTranscriptMode = classifyAgyTranscriptMode(ctx);
            const agyWatchdogContext = formatAgyWatchdogContext(ctx);
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${agyWatchdogContext}` : agyWatchdogContext;
            pushTrace(ctx, agyWatchdogContext);
        }
        ownProcess(child).terminate('stall');
    }, watchdogConfig);
    ctx.stallWatchdog = stallWatchdog;

    let agyTranscriptWatcher: AgyTranscriptWatcherHandle | null = null;
    if (cli === 'agy') {
        agyTranscriptWatcher = startAgyTranscriptWatcher({
            cwd: spawnCwd,
            prompt: promptForArgs,
            getSessionId: () => ctx.sessionId,
            ctx,
            agentLabel,
            cli,
            empTag,
            traceAudience,
            onEmit: (emitCtx, tool, label, _cliName, tag, _audience) => {
                stampTraceTool(tool, emitCtx, tool.toolType || 'tool');
                if (emitCtx.liveScope) replaceLiveRunTools(emitCtx.liveScope, emitCtx.toolLog);
                appendParentLiveRunTool(emitCtx, tool);
                emitAgentTool(emitCtx, label, tool, tag);
                scheduleAgyQuietCompletion();
            },
            onActivity: () => {
                ctx.stallWatchdog?.markProgress();
                scheduleAgyQuietCompletion();
            },
        });
    }

    const ndjsonFramer = createNdjsonFramer();
    const reportNdjsonDrop = (drop: NdjsonDrop): void => {
        console.warn(`[jaw:${agentLabel}] stdout frame exceeded the ${MAX_PENDING_LINE_CHARS}-char limit — dropping the frame and draining to its newline`);
        appendTraceEvent({
            runId: ctx.traceRunId,
            source: 'cli_raw',
            eventType: 'ndjson_overflow',
            raw: { droppedFrameChars: drop.frameChars, headSample: drop.headSample },
        });
    };
    const recordOpencodeEvent = (line: string, event: CliEventRecord) => {
        if (cli !== 'opencode') return;
        ctx.opencodeRawEvents = pushOpencodeRawEvent(ctx.opencodeRawEvents, line);
        ctx.opencodeLastEventType = typeof event?.type === 'string' ? event.type : 'unknown';
        ctx.opencodeLastEventAt = Date.now();
    };
    const dispatchNdjsonLine = (line: string): void => {
        line = redactSlackToolSecrets(line);
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'malformed_json', raw: line });
            return;
        }
        appendTraceEvent({
            runId: ctx.traceRunId,
            source: 'cli_raw',
            eventType: fieldString(asCliEventRecord(raw).type, '<no-type>'),
            raw,
        });
        // A parsed stream-json line is the runtime saying it is still working.
        // Reached only after JSON.parse succeeded above, so this is a real event
        // and not a heartbeat of bytes (#405).
        if (streamJsonMarksProgress(cli, ctx.effectiveProvider)) {
            ctx.stallWatchdog?.markProgress();
        }
        const dispatchCli = cli;
        const event = discriminate(dispatchCli, raw);
        if (!event) {
            const type = fieldString(asCliEventRecord(raw).type, '<no-type>');
            pushTrace(ctx, `[cli:unknown-event] cli=${cli} provider=${dispatchCli} type=${type} preview=${JSON.stringify(raw).slice(0, 200)}`);
            return;
        }
        recordOpencodeEvent(line, event);
        if (process.env["DEBUG"]) {
            console.log(`[jaw:event:${agentLabel}] ${cli} type=${event.type}`);
            console.log(`[jaw:raw:${agentLabel}] ${line.slice(0, 300)}`);
        }
        logEventSummary(agentLabel, dispatchCli, event, ctx);
        if (!ctx.sessionId) ctx.sessionId = extractSessionId(dispatchCli, event);
        extractFromEvent(dispatchCli, event, ctx, agentLabel, empTag);
        // Sub-agent wait: keep stall timer alive
        if (ctx.hasActiveSubAgent) {
            opts.lifecycle?.onActivity?.('heartbeat');
        }
        const outputChunk = extractOutputChunk(dispatchCli, event, ctx);
        if (outputChunk) {
            // Dedicated providers observe before their destructive legacy resets.
            // Copilot's ordinary print fallback exposes only accepted assistant text here.
            if (dispatchCli === 'copilot') ctx.printActivity?.message(outputChunk, 'append', 'unknown');
            broadcastAgentOutput(ctx, agentLabel, cli, outputChunk, empTag, (opts.internal || isEmployee) ? 'internal' : 'public');
        }
    };
    if (cli === 'opencode') {
        opencodeIdleTimer = setInterval(() => {
            const idleMs = Date.now() - lastOpencodeIoAt;
            if (idleMs < 60_000) return;
            const snapshot = buildOpencodeRuntimeSnapshot(ctx);
            const line = `[jaw:opencode:idle] ${idleMs}ms ${JSON.stringify(snapshot)}`;
            console.warn(line);
            pushTrace(ctx, line);
        }, 30_000);
    }

    // One reader per stream, never shared: stdout and stderr are independent byte
    // streams and a UTF-8 code point can straddle any chunk boundary (#372).
    // AGY and Kiro read the same stdout reader rather than owning private decoders,
    // so their routing is preserved without decoding the same bytes twice.
    const stdoutReader = createTextStreamReader();
    const stderrReader = createTextStreamReader();

    child.stdout.on('data', (chunk) => {
        opts.lifecycle?.onActivity?.('stdout');
        lastOpencodeIoAt = Date.now();
        if (cli === 'agy') {
            ctx.agyLastActivitySource = 'stdout';
            const rawText = stdoutReader.write(chunk);
            if (!rawText) return;
            ctx.stallWatchdog?.markProgress();
            // Defensive ANSI strip (belt-and-suspenders with NO_COLOR=1)
            const text = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
            appendAgyFullText(ctx, text);
            if (agyResumeDecision.ok && !agyGuardedStaleDetected && isAgyStaleSessionOutput(text)) {
                agyGuardedStaleDetected = true;
                console.log('[jaw:agy] stale guarded resume output detected — terminating for fresh retry');
                ownProcess(child).terminate('cancel');
                return;
            }
            if (!ctx.sessionId) ctx.sessionId = extractAgyConversationId(ctx.fullText);
            if (ctx.agyResumeOffset && ctx.agyResumeOffset > 0) {
                ctx.agyBytesReceived = (ctx.agyBytesReceived ?? 0) + text.length;
                if (ctx.agyBytesReceived <= ctx.agyResumeOffset) return;
                const newStart = text.length - (ctx.agyBytesReceived - ctx.agyResumeOffset);
                const newText = normalizeAssistantDisplayText(newStart > 0 ? text.slice(newStart) : text);
                ctx.agyResumeOffset = 0;
                if (!newText) return;
                ctx.printActivity?.message(newText, 'append', 'unknown');
                if (ctx.liveOutputText !== undefined) ctx.liveOutputText += newText;
                ctx.outputTextStarted = true;
                appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: newText });
                broadcastAgentOutput(ctx, agentLabel, cli, newText, empTag, traceAudience);
                scheduleAgyQuietCompletion();
                return;
            }
            if (shouldFreezeAgyLiveDisplay(ctx)) {
                // Display frozen past AGY_LIVE_DISPLAY_MAX_CHARS; the close path
                // promotes the full text into the live candidate (finalizeAgyFallbackText).
                scheduleAgyQuietCompletion();
                return;
            }
            const visibleFullText = isResume
                ? stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes).text
                : ctx.fullText;
            const promptEchoStripped = stripAgyPromptEchoPrefix(visibleFullText, promptForArgs).text;
            const trackerStripped = stripInterviewTracker(promptEchoStripped);
            const displayFullText = normalizeAssistantDisplayText(trackerStripped);
            const previousDisplayText = ctx.liveOutputText ?? '';
            const displayText = displayFullText.startsWith(previousDisplayText)
                ? displayFullText.slice(previousDisplayText.length)
                : displayFullText;
            if (ctx.liveOutputText !== undefined) ctx.liveOutputText = displayFullText;
            ctx.outputTextStarted = Boolean(displayFullText.trim());
            if (!displayText) {
                scheduleAgyQuietCompletion();
                return;
            }
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: displayText });
            ctx.printActivity?.message(displayFullText, 'replace', 'unknown');
            broadcastAgentOutput(ctx, agentLabel, cli, displayText, empTag, traceAudience);
            scheduleAgyQuietCompletion();
            return;
        }
        if (kiroPlainText) {
            const text = stdoutReader.write(chunk);
            if (!text) return;
            ctx.stallWatchdog?.markProgress();
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: text });
            const events = processKiroStdoutChunk(ctx, text);
            if (events.length) {
                emitKiroStreamEvents(events, ctx, agentLabel, cli, empTag, traceAudience);
            }
            return;
        }
        const framed = ndjsonFramer.push(stdoutReader.write(chunk));
        for (const drop of framed.drops) reportNdjsonDrop(drop);
        for (const line of framed.lines) {
            if (!line.trim()) continue;
            dispatchNdjsonLine(line);
        }
    });

    const slackStderr = slackToolGrant ? createSlackToolSecretStream() : undefined;
    child.stderr.on('data', (chunk) => {
        opts.lifecycle?.onActivity?.('stderr');
        clearAgyQuietCompletionTimer();
        lastOpencodeIoAt = Date.now();
        // No per-chunk trim: trimming a chunk destroys legitimate leading/trailing
        // whitespace and line boundaries that only exist across chunks (#372).
        const decoded = stderrReader.write(chunk);
        const text = slackStderr ? slackStderr(decoded) : decoded;
        if (!text) return;
        if (cli === 'agy') ctx.agyLastActivitySource = 'stderr';
        if ((kiroPlainText || cli === 'agy') && text) ctx.stallWatchdog?.markProgress();
        appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
        console.error(`[jaw:stderr:${agentLabel}] ${text.trimEnd()}`);
        if (ctx.stderrBuf.length < STDERR_BUF_CAP) {
            // Slice rather than skip: one oversized chunk must not blow past the cap.
            ctx.stderrBuf = sliceWithoutSplittingSurrogate(ctx.stderrBuf + text, STDERR_BUF_CAP);
        }
        scheduleAgyQuietCompletion();
    });

    child.on('close', (code) => {
        clearOpencodeIdleTimer();
        clearAgyQuietCompletionTimer();
        stallWatchdog.stop();
        releaseExitDrain();
        if (stdSettled) return;  // error handler already resolved
        // [I1] Flush the decoders BEFORE dispatching the final line (#372): the last
        // code point's residual bytes belong to that line, so ending the decoder
        // afterwards would drop them permanently.
        const stdoutResidual = stdoutReader.end();
        if (stdoutResidual) {
            if (cli === 'agy') {
                appendAgyFullText(ctx, stdoutResidual);
            } else if (kiroPlainText) {
                emitKiroStreamEvents(processKiroStdoutChunk(ctx, stdoutResidual), ctx, agentLabel, cli, empTag, traceAudience);
            } else {
                const framed = ndjsonFramer.push(stdoutResidual);
                for (const drop of framed.drops) reportNdjsonDrop(drop);
                for (const line of framed.lines) if (line.trim()) dispatchNdjsonLine(line);
            }
        }
        const stderrEnd = stderrReader.end();
        const stderrResidual = slackStderr ? slackStderr(stderrEnd, true) : stderrEnd;
        if (stderrResidual && ctx.stderrBuf.length < STDERR_BUF_CAP) {
            ctx.stderrBuf = sliceWithoutSplittingSurrogate(ctx.stderrBuf + stderrResidual, STDERR_BUF_CAP);
        }
        // Flush residual NDJSON buffer — last event may lack a trailing newline
        const ndjsonTail = ndjsonFramer.end();
        if (ndjsonTail.drop) reportNdjsonDrop(ndjsonTail.drop);
        if (ndjsonTail.tail.trim()) {
            dispatchNdjsonLine(ndjsonTail.tail);
        }
        flushClaudeBuffers(ctx, agentLabel, empTag);  // flush any pending thinking/input buffers
        if (cli === 'opencode') flushOpenCodeBuffers(ctx, agentLabel, empTag);
        if (kiroPlainText) {
            emitKiroStreamEvents(flushKiroStdoutContext(ctx), ctx, agentLabel, cli, empTag, traceAudience);
        }
        const agyTotalOutputLen = cli === 'agy' ? ctx.fullText.length : 0;
        if (cli === 'agy' && agyResumeOffset > 0) {
            ctx.fullText = ctx.fullText.slice(Math.min(agyResumeOffset, ctx.fullText.length));
        }
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);

        // [I2] Consume per-process kill reason
        const stdKillReason = consumeKillReason(child.pid);
        const agyCompletedByQuietOutput = cli === 'agy' && stdKillReason === AGY_COMPLETE_KILL_REASON;
        const wasKilled = !!stdKillReason && !agyCompletedByQuietOutput;
        const wasSteer = isLifecycleSteerReason(stdKillReason);

        if (cli === 'agy' && !ctx.sessionId) ctx.sessionId = extractAgyConversationId(ctx.fullText);
        if (cli === 'agy' && agyLogFile && !ctx.sessionId) {
            try {
                if (fs.existsSync(agyLogFile)) {
                    ctx.sessionId = extractAgyConversationId(fs.readFileSync(agyLogFile, 'utf8'));
                }
            } catch (e) {
                console.warn('[jaw:agy] log session capture failed:', (e as Error).message);
            }
        }
        if (cli === 'agy' && agyLogFile) {
            try { fs.rmSync(agyLogFile, { force: true }); }
            catch (e) { console.warn('[jaw:agy] log cleanup failed:', (e as Error).message); }
        }
        agyClosing = true;
        agyTranscriptWatcher?.stop();
        if (cli === 'agy') {
            ctx.agyTranscriptMode = classifyAgyTranscriptMode(ctx);
        }
        if (cli === 'agy' && isResume && (agyGuardedStaleDetected || isAgyStaleSessionOutput(ctx.fullText))) {
            console.log(`[jaw:agy] stale session detected (Warning: conversation not found) — clearing bucket`);
            try {
                const bucket = currentBucket;
                clearSessionBucket.run(bucket);
            } catch (e) { console.warn('[jaw:agy] stale bucket clear failed:', (e as Error).message); }
            ctx.sessionId = null;
            if (agyResumeDecision.ok && !opts._agyStaleFreshRetry) {
                if (mainManaged) releaseMainRun(scopeKey, child, ownerGeneration);
                else activeProcesses.delete(agentLabel);
                finishPrintActivity(ctx, { kind: 'turn-end', status: 'stopped', finalText: null, error: 'AGY stale resume; retrying fresh' });
                const { promise: freshPromise } = spawnAgent(prompt, {
                    ...opts, _agyStaleFreshRetry: true, _skipResume: true, _skipInsert: true,
                });
                freshPromise.then(resolve!).catch((error: Error) => resolve!({ text: error.message, code: 1 }));
                return;
            }
        }
        if (kiroPlainText) {
            const captured = captureKiroSessionIdAfterExit({
                cwd: spawnCwd,
                spawnStartedAt: kiroSpawnStartedAt,
                beforeIds: kiroConversationIdsBefore,
                stdout: ctx.fullText,
                stderr: ctx.stderrBuf,
                resumeSessionId,
                isResume,
            });
            ctx.sessionId = captured.id;
            if (captured.source) {
                console.log(`[jaw:kiro] session capture source=${captured.source} id=${captured.id?.slice(0, 12) ?? 'none'}...`);
            }
            if (!ctx.sessionId) {
                console.warn(`[jaw:kiro] session id capture failed cwd=${spawnCwd}`);
            }
            if (isResume && isKiroStaleSessionOutput(ctx.fullText)) {
                console.log('[jaw:kiro] stale session detected in output — clearing bucket');
                try {
                    const bucket = currentBucket;
                    clearSessionBucket.run(bucket);
                } catch (e) { console.warn('[jaw:kiro] stale bucket clear failed:', (e as Error).message); }
                ctx.sessionId = null;
            }
            const parsed = finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer);
            const best = [ctx.liveOutputText, ctx.kiroDisplayedText, parsed]
                .map((value) => normalizeAssistantDisplayText(value))
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0];
            if (best) ctx.fullText = best;
            else if (parsed) ctx.fullText = parsed;
        }
        let agyCloseTimedOut = false;
        let agyTimeoutMessage = '';
        if (cli === 'agy') {
            const strippedPromptEcho = stripAgyPromptEchoPrefix(ctx.fullText, promptForArgs);
            if (strippedPromptEcho.stripped) {
                ctx.fullText = strippedPromptEcho.text;
                if (ctx.liveOutputText !== undefined) {
                    ctx.liveOutputText = stripAgyPromptEchoPrefix(ctx.liveOutputText, promptForArgs).text;
                }
            }
            if (isResume && agyResumeReplayPrefixes.length > 0) {
                const strippedReplays = stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes);
                if (strippedReplays.stripped) {
                    ctx.fullText = strippedReplays.text;
                    if (ctx.liveOutputText !== undefined) {
                        ctx.liveOutputText = stripAgyResumeReplayPrefixes(ctx.liveOutputText, agyResumeReplayPrefixes).text;
                    }
                }
            }
            if (isResume && agyResumeReplayPrefix) {
                const strippedReplay = stripAgyResumeReplayPrefix(ctx.fullText, agyResumeReplayPrefix);
                if (strippedReplay.stripped) {
                    ctx.fullText = strippedReplay.text;
                    if (ctx.liveOutputText !== undefined) {
                        ctx.liveOutputText = stripAgyResumeReplayPrefix(ctx.liveOutputText, agyResumeReplayPrefix).text;
                    }
                }
            }
            if (ctx.agyFinalPlannerSeen && ctx.agyFinalPlannerText) {
                if (isAgyIntermediatePlannerText(ctx.agyFinalPlannerText)) {
                    ctx.fullText = AGY_PLANNER_ONLY_NOTICE;
                    if (ctx.liveOutputText !== undefined) ctx.liveOutputText = AGY_PLANNER_ONLY_NOTICE;
                    ctx.agyFinalPlannerSeen = false;
                    ctx.agyFinalPlannerText = undefined;
                    ctx.metadata = { ...ctx.metadata, agyPlannerOnly: true };
                } else {
                    ctx.fullText = ctx.agyFinalPlannerText;
                    if (ctx.liveOutputText !== undefined) ctx.liveOutputText = ctx.agyFinalPlannerText;
                }
            }
            const normalizedCloseText = normalizeAgyCloseText({
                fullText: ctx.fullText,
                liveOutputText: ctx.liveOutputText,
                allowTimeoutSuffixStrip: Boolean(ctx.agyFinalPlannerSeen),
            });
            ctx.fullText = normalizedCloseText.text;
            if (normalizedCloseText.liveText !== undefined) ctx.liveOutputText = normalizedCloseText.liveText;
            agyCloseTimedOut = normalizedCloseText.timedOut;
            agyTimeoutMessage = normalizedCloseText.timeoutMessage;
        }
        const agyTimedOut = cli === 'agy' && agyCloseTimedOut;
        const agyTranscriptErrorMessage = cli === 'agy' && !agyTimedOut
            ? resolveAgyEmptyCloseError(ctx)
            : null;
        if (cli === 'agy' && !agyTimedOut && !agyTranscriptErrorMessage) {
            // Mirror the per-chunk display derivation ORDER (replay → echo → tracker →
            // normalize). The close-path strips above run echo-before-replay and can
            // leave a prompt echo in resumed output; every strip is a prefix-stripper
            // that no-ops when the prefix is already gone, so re-running them in
            // per-chunk order is idempotent and safe.
            const promotedBase = isResume
                ? stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes).text
                : ctx.fullText;
            const promotedEcho = stripAgyPromptEchoPrefix(promotedBase, promptForArgs).text;
            finalizeAgyFallbackText(ctx, normalizeAssistantDisplayText(stripInterviewTracker(promotedEcho)));
        }
        if (cli === 'agy') pushTrace(ctx, describeAgyFinalSource(ctx));
        if (cli === 'agy') {
            ctx.metadata = {
                ...ctx.metadata,
                agyCheckpointSeen: ctx.metadata?.['agyCheckpointSeen'] === true,
                agyPlannerOnly: ctx.metadata?.['agyPlannerOnly'] === true
                    && ctx.toolLog.length === 0
                    && !ctx.agyFinalPlannerSeen,
            };
        }
        const effectiveExitCode = agyCompletedByQuietOutput && !agyTranscriptErrorMessage
            ? 0
            : agyTranscriptErrorMessage
                ? 1
                : agyTimedOut ? 124 : ctx.stallReason ? 124 : code;
        if (agyTimedOut) {
            const message = formatAgyTimeoutMessage(agyTimeoutMessage);
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${message}` : message;
            ctx.fullText = '';
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'runtime_error', raw: message });
        } else if (agyTranscriptErrorMessage) {
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${agyTranscriptErrorMessage}` : agyTranscriptErrorMessage;
            ctx.fullText = '';
            if (ctx.liveOutputText !== undefined) ctx.liveOutputText = '';
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'runtime_error', raw: agyTranscriptErrorMessage });
        }
        opts.lifecycle?.onExit?.(effectiveExitCode ?? null);

        const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, effectiveExitCode, cli);

        // Build cost display line (CLI-only feature)
        const costParts = [];
        if (ctx.cost != null) costParts.push(`$${Number(ctx.cost).toFixed(4)}`);
        if (ctx.turns) costParts.push(`${ctx.turns}턴`);
        if (ctx.duration) costParts.push(`${(ctx.duration / 1000).toFixed(1)}s`);
        const costLine = costParts.length ? `\n\n✅ ${costParts.join(' · ')}` : '';

        // Delegated to lifecycle-handler.ts → handleAgentExit:
        //   - smoke continuation (guarded by !wasSteer)
        //   - output: ⏹️ [interrupted] prefix (wasSteer && mainManaged && !opts.internal)
        //   - error: code !== 0 && !wasKilled → classifyExitError
        //   - trace: if (traceText) traceText = `⏹️ [interrupted]…`
        handleAgentExit({
            ctx, code: effectiveExitCode, cli, model: runtimeModel, effectiveProvider, agentLabel, mainManaged, origin,
            killReason: stdKillReason,
            onRuntimeEnd: end => ctx.printActivity?.finish(end),
            resumeKey,
            prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
            isResume, wasKilled, wasSteer, smokeResult,
            effortDefault: cli === 'grok' ? '' : 'medium', costLine,
            resolve: resolve!,
            activeProcesses,
            scopeKey,
            runtimeTransport,
            scopedBucket: currentBucket,
            chatSessionId,
            childProcess: child,
            releaseMainRun,
            retryState: queueCtrl.retryStateForScope(scopeKey),
            fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
            fallbackMaxRetries: FALLBACK_MAX_RETRIES,
            processQueue,
            ...(agyTotalOutputLen > 0 ? { outputLen: agyTotalOutputLen } : {}),
        }).catch((err: Error) => {
            console.error('[jaw:lifecycle] handleAgentExit failed (CLI):', err.message);
        }).finally(() => settleExit(scopeKey));
    });

    return { child, promise: resultPromise };
}

// ─── Forward References ──────────────────────────────
// Set after spawnAgent is defined to avoid circular deps
setSpawnAgent(spawnAgent);
setMainMetaHandler(setCurrentMainMeta);
setMemorySpawnRef(spawnAgent, activeProcesses);
