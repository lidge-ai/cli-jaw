import { revokeSlackToolGrant } from '../slack/tool-context.js';
// ─── Agent Lifecycle Handler (post-exit logic) ──────
// Extracted from spawn.ts to unify ACP + CLI exit handling.

import type { ChildProcess } from 'child_process';
import { broadcast } from '../core/bus.js';
import { settings, detectCli, resolveFlushEvery } from '../core/config.js';
import { clearEmployeeSession, insertMessage, insertMessageWithTrace, insertMessageWithTraceRun, updateSession, clearSessionBucket, markAnchorConsumed, updateSessionBucketLastRun } from '../core/db.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { persistMainSession, type SessionOwnerToken } from './session-persistence.js';
import { resolveSessionBucket } from './args.js';
import { isRetiredCliSelection } from '../types/cli-engine.js';
import { buildContinuationPrompt, type SmokeDetectionResult } from './smoke-detector.js';
import { shouldInvalidateResumeSession } from './resume-classifier.js';
import { classifyExitError, shouldAnnounceStallTruncation, STALL_TRUNCATION_NOTICE } from './error-classifier.js';
import { backfillGrokTraceTools } from './grok-trace-backfill.js';
import { shouldClearHighTurnSessionBucket, shouldUseTurnCountRefresh } from './spawn/resume.js';
import { recordError, clearErrors } from './alert-escalation.js';
import { noteRuntimeCooldown, isRuntimeCoolingDown, clearRuntimeCooldown, DEFAULT_COOLDOWN_MS } from './error-cooldown.js';
import { stripInterviewTracker } from '../orchestrator/sanitize.js';
import { clearLiveRun, getLiveRun } from './live-run-state.js';
import { sanitizeToolLogForDurableStorage, serializeSanitizedToolLog } from '../shared/tool-log-sanitize.js';
import { scanStructuredFence } from '../shared/structured-fence.js';
import { finalizeTraceRun, linkTraceRunToMessage } from '../trace/store.js';
import { mergeLatestTools } from './merge-tool-log.js';
import type { TraceRunStatus } from '../trace/types.js';
import type { RuntimeEventBody, RuntimeTransport, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { handoffRuntimeOutcome, lifecycleRuntimeOutcome, runtimeOutcomeExitCode } from './runtime/outcome.js';
import type { ToolEntry } from '../types/agent.js';
import type { RemoteTarget } from '../messaging/types.js';
import { runPinFields } from '../messaging/run-pin.js';
import { resolveSpawnOutputText } from './events/helpers.js';
import { isKiroPlainTextCli, isKiroResumeDegradedOutput } from './kiro-runtime.js';
import {
    incrementMemoryFlush,
    countTurnForFlush,
    triggerMemoryFlush,
    memoryFlushCounter,
} from './memory-flush-controller.js';
import { buildGoalContinuation } from '../goal/heartbeat.js';
import { completeGoal, getActiveGoal, goalHasCompletionEvidence } from '../goal/store.js';
import { recordTurn } from '../goal-run/controller.js';
import { applyOutputPolicy } from '../core/policy-hooks.js';
import { evaluateRecordPending } from '../core/policy-flags.js';
import { classifyStopCause, type StopCause } from './spawn/stop-cause.js';

const GOAL_CONT_MAX_ATTEMPTS = 20;
let _goalContAttempts = 0;
let _goalContGoalId: string | null = null;
export function resetGoalContAttempts(): void { _goalContAttempts = 0; _goalContGoalId = null; }

// Goal continuations spawn with _skipInsert (the full continuation prompt is
// internal), so without this row the chat timeline has no user-turn boundary
// between work-phases. That broke reconnect hydration: the client's
// latestAgentDivForActiveRun() heuristic ("last .msg-agent with no following
// user message") re-attached new tool steps onto the PREVIOUS assistant bubble.
// A short durable user row gives
// both live SSE and /api/messages reloads a real message boundary.
function insertGoalContinuationBoundary(label: string): void {
    const content = `🎯 ${label}`;
    try {
        insertMessage.run('user', content, 'goal_continuation', '', settings['workingDir'] || null, getActiveChatSession());
        broadcast('new_message', { role: 'user', content, source: 'goal', cli: 'goal_continuation' });
    } catch (err) {
        console.warn('[jaw:goal] boundary insert failed:', (err as Error).message);
    }
}

const _goalTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function clearGoalTimers(): void {
    for (const t of _goalTimers.values()) clearTimeout(t);
    _goalTimers.clear();
    _goalContAttempts = 0;
    _goalContGoalId = null;
    try {
        insertMessage.run('system', '[goal_boundary]', 'goal_boundary', '', settings['workingDir'] || null, getActiveChatSession());
    } catch { /* DB may not be ready during early init */ }
}

export function kickGoalContinuation(): boolean {
    if (!_spawnAgent) {
        console.warn('[jaw:goal] kickGoalContinuation called but _spawnAgent is not registered');
        return false;
    }
    const goalCont = buildGoalContinuation();
    if (goalCont.shouldContinue && goalCont.prompt) {
        const contGoal = getActiveGoal();
        const contGoalId = contGoal?.id ?? '__none__';
        _goalContAttempts = 1;
        _goalContGoalId = contGoalId;
        console.log(`[jaw:goal] kicking manual goal continuation`);
        broadcast('goal_continuation', { reason: 'manual_kick', attempt: 1 });
        const existingCont = _goalTimers.get(contGoalId);
        if (existingCont) clearTimeout(existingCont);
        insertGoalContinuationBoundary('Goal continue (manual)');
        const { promise: contP } = _spawnAgent(goalCont.prompt!, {
            _isGoalContinuation: true,
            _skipInsert: true,
        });
        contP.catch((err: Error) => {
            console.warn('[jaw:goal] kicked goal continuation failed:', err.message);
            broadcast('goal_continuation_failed', { error: err.message });
        });
        return true;
    }
    return false;
}


// Match /goal done|cancel or cli-jaw goal done|cancel at line start or after whitespace
const GOAL_DONE_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+done\b/im;
const GOAL_CANCEL_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+cancel\b/im;
const GOAL_PAUSE_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+pause\b/im;

function computeBackoff(attempt: number, base = 5000, max = 120_000): number {
    const delay = Math.min(base * 2 ** attempt, max);
    return Math.round(delay * (0.5 + Math.random() * 0.5));
}

const MAIN_MAX_RETRIES = 3;
const EMP_MAX_RETRIES = 2;

/**
 * Did this run already do something a retry would repeat?
 *
 * Retrying re-runs the same prompt, so any tool the previous attempt executed
 * runs again — a second Slack message, a second commit, a second file write.
 * `_skipInsert` only suppresses the local chat row; it does nothing about
 * external effects.
 *
 * Only observably-effectful tools count. Blocking on ANY tool would turn the
 * common "long agentic turn, rate-limited on the final model call" case into a
 * hard failure even when the run merely read and searched, which trades a rare
 * duplicate for a frequent lost turn.
 *
 * `search` covers grep/web-search/read-url and `thinking` is internal, so both
 * are safe to repeat. `command`, `file` and `subagent` can write, send, or spawn
 * further work, so they are treated as effectful. Unknown types are treated as
 * effectful: a new tool kind should fail closed.
 *
 * The same "a real turn ran tools" reasoning already guards stale-resume
 * invalidation elsewhere in this file.
 */
const REPEATABLE_TOOL_TYPES = new Set(['search', 'thinking']);

function performedSideEffects(ctx: ExitContext): boolean {
    return ctx.toolLog.some(tool => !REPEATABLE_TOOL_TYPES.has(tool.toolType));
}

type LifecycleSpawnOptions = {
    requestId?: string;
    internal?: boolean;
    _isFallback?: boolean;
    _retryAttempt?: number;
    _isGoalContinuation?: boolean;
    _isCapacityFallback?: boolean;
    _isSmokeContinuation?: boolean;
    _skipInsert?: boolean;
    _skipResume?: boolean;
    _skipSessionPersist?: boolean;
    _employeeFreshSessionRetry?: boolean;
    _kiroFreshRetry?: boolean;
    agentId?: string;
    employeeSessionId?: string;
    scopeKey?: string;
    chatSessionId?: string;
    remoteKey?: string;
    /** Destination captured when the run was admitted. Survives `...opts`
     *  through fallback and retry respawns so the pin cannot be lost. */
    target?: RemoteTarget;
    cli?: string;
    model?: string;
    _heartbeatAnchorId?: number;
};

type LifecycleResolveResult = {
    text: string;
    code: number;
    executionInterrupted?: boolean;
    executionFailed?: boolean;
    runtimeOutcome?: RuntimeTurnOutcome;
    traceRunId?: string;
    sessionId?: string | null;
    cost?: ExitContext['cost'];
    tools?: ToolEntry[];
    smoke?: SmokeDetectionResult;
    diagnostic?: string;
    agyCheckpointSeen?: boolean;
    agyPlannerOnly?: boolean;
    stopCause?: StopCause;
};

type SpawnAgentRef = (
    prompt: string,
    opts?: LifecycleSpawnOptions,
) => { promise: Promise<LifecycleResolveResult> };

interface LifecycleConfig {
    effort?: string;
}

interface FallbackStateEntry {
    fallbackCli?: string;
    retriesLeft: number;
}

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: SpawnAgentRef;
export function setSpawnAgent(fn: SpawnAgentRef): void {
    _spawnAgent = fn;
}

// Forward reference to setCurrentMainMeta — same reason.
interface MainSessionMetaRef {
    origin: string;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    scopeId?: string;
    chatSessionId?: string;
    remoteKey?: string;
    effectiveProvider?: string;
}

let _setCurrentMainMeta: ((scopeKey: string, meta: MainSessionMetaRef | null) => void) | null = null;
export function setMainMetaHandler(fn: (scopeKey: string, meta: MainSessionMetaRef | null) => void): void {
    _setCurrentMainMeta = fn;
}

/**
 * A saved fallback order can name a retired runtime whose binary is still on
 * PATH. Availability alone would stop the search on that dead name, so the
 * retirement check has to run before detection.
 */
export function isLiveFallbackCandidate(
    fc: string,
    currentCli: string,
    detect: (name: string) => { available: boolean },
    coolingDown: (name: string) => boolean,
): boolean {
    return fc !== currentCli
        && !isRetiredCliSelection(fc)
        && detect(fc).available
        && !coolingDown(fc);
}

/** Compatibility delivery alone collapses whitespace; canonical data stays exact. */
function runtimeCompatibilityText(finalText: string | null): string {
    return finalText === null || finalText.trim().length === 0 ? '' : finalText;
}

/** What a failure is called. The classifier can only name the classes it can
 *  recognize in stderr, and a native runtime that failed on its own terms
 *  already knows better; prefer its sentence when it supplied one. */
function failureMessage(ctx: ExitContext, cli: string, code: number): string {
    const owned = ctx.runtimeDiagnostic?.trim();
    return owned || classifyExitError(cli, code, ctx.stderrBuf).message;
}

/** Tag agent_done with the trace run that produced it so the web UI can drop
 *  SSE replays of already-finished turns instead of mid-turn-finalizing the
 *  in-flight one. */
function runTag(ctx: { traceRunId?: string | null }): Record<string, unknown> {
    return ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {};
}

export interface ExitContext {
    runtimeOutcome?: RuntimeTurnOutcome;
    runtimeTerminalAttempted?: boolean;
    requestId?: string;
    fullText: string;
    /** Set when fullText hit the safety bound and later output was dropped. */
    fullTextTruncated?: boolean;
    sessionId: string | null;
    toolLog: ToolEntry[];
    traceLog: string[];
    stderrBuf: string;
    /** Why this turn failed, in the runtime's own words, when the runtime knows
     *  more than the exit code does. Generated internally — never relayed child
     *  output — so it is safe to show a user and to store in the trace. */
    runtimeDiagnostic?: string;
    metadata?: Record<string, unknown>;
    liveScope?: string | null;
    traceRunId?: string | null;
    liveOutputText?: string;
    kiroDisplayedText?: string;
    cost?: { input?: number; output?: number } | number | null;
    turns?: number | null;
    duration?: number | null;
    cliNativeCompactDetected?: boolean;
    stallReason?: string;
    scheduleWakeup?: {
        delaySeconds: number;
        prompt: string;
        reason: string;
    };
}

export interface ExitHandlerParams {
    onRuntimeEnd?: (end: Extract<RuntimeEventBody, { kind: 'turn-end' }>) => void;
    ctx: ExitContext;
    code: number | null;
    childExitCode?: number | null;
    cli: string;
    model: string;
    effectiveProvider?: string;
    resumeKey: string | null;
    agentLabel: string;
    mainManaged: boolean;
    origin: string;
    prompt: string;
    opts: LifecycleSpawnOptions;
    cfg: LifecycleConfig;
    ownerGeneration: number;
    persistenceOwner: SessionOwnerToken;
    forceNew: boolean;
    empSid: string | null;
    isResume: boolean;
    wasKilled: boolean;
    wasSteer: boolean;
    smokeResult: SmokeDetectionResult;
    /** ACP uses '' (from cfg.effort), CLI uses 'medium' */
    effortDefault: string;
    /** Optional cost display line (CLI builds this, ACP passes '') */
    costLine: string;
    resolve: (result: LifecycleResolveResult) => void;
    activeProcesses: Map<string, ChildProcess>;
    scopeKey: string;
    chatSessionId: string;
    codexAppBucket?: string | undefined;
    // The bucket this run actually used, already keyed by scope (073 §2.1). Passed in
    // rather than recomputed, because recomputing it here loses the scope and lands on
    // the bucket belonging to whichever session is globally active.
    scopedBucket?: string | undefined;
    runtimeTransport?: RuntimeTransport | undefined;
    childProcess: ChildProcess | null;
    releaseMainRun: (scopeKey: string, child: ChildProcess | null, ownerGeneration: number) => boolean;
    retryState: {
        setTimer: (t: ReturnType<typeof setTimeout> | null) => void;
        setResolve: (r: ((result: LifecycleResolveResult) => void) | null) => void;
        setOrigin: (o: string | null) => void;
        setIsEmployee: (v: boolean) => void;
    };
    fallbackState: Map<string, FallbackStateEntry>;
    fallbackMaxRetries: number;
    processQueue: (scopeKey: string) => void;
    outputLen?: number;
}

/**
 * Unified post-exit handler for both ACP and CLI branches.
 *
 * Handles: smoke continuation, process cleanup, session persistence,
 * fallback recovery, output save, error classification, 429 retry, fallback.
 */
export async function handleAgentExit(params: ExitHandlerParams): Promise<void> {
    const {
        ctx, code: processCode, cli, model, agentLabel, mainManaged, origin,
        prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
        isResume, wasKilled, wasSteer, smokeResult,
        effortDefault, costLine, resolve,
        activeProcesses, scopeKey, chatSessionId, childProcess, releaseMainRun,
        retryState, fallbackState, fallbackMaxRetries, processQueue,
    } = params;

    const stopCause = classifyStopCause({
        stallReason: ctx.stallReason,
        wasSteer,
        wasKilled,
        exitCode: params.childExitCode ?? params.code,
    });
    const nativeOutcome = lifecycleRuntimeOutcome(ctx, wasKilled || wasSteer || Boolean(ctx.stallReason));
    const code = runtimeOutcomeExitCode(nativeOutcome, processCode);
    const nativeRequestId = ctx.requestId ?? opts.requestId;
    if (mainManaged) revokeSlackToolGrant(nativeRequestId);
    // This run's identity and destination, carried on every terminal event it
    // emits below. See src/messaging/run-pin.ts for why it is carried and not
    // looked up (#742/#743).
    const donePin = runPinFields({ origin, requestId: nativeRequestId, scope: scopeKey,
        sessionId: chatSessionId, remoteKey: opts.remoteKey, target: opts.target });
    const nativeTraceRunId = ctx.traceRunId;
    const effectiveProvider = params.effectiveProvider;
    const runtimeCli = cli;
    const effortVal = cfg.effort || effortDefault;
    // Every runtime now has a bucket of its own keyed by scope (073 §2.1), so the guard
    // 072 put here is gone: instead of refusing to touch shared state, each session
    // touches only its own. The bucket comes from the run rather than being recomputed,
    // because recomputing loses the scope.
    const runBucket = params.scopedBucket
        ?? params.codexAppBucket
        ?? resolveSessionBucket(cli, model, effectiveProvider);
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};
    const liveScope = ctx.liveScope || 'default';
    const ownsLiveRun = () => nativeOutcome === undefined
        || (typeof ctx.traceRunId === 'string' && getLiveRun(liveScope).traceRunId === ctx.traceRunId);
    const traceStatus = nativeOutcome === undefined
        ? code === 0 ? 'done' : wasKilled ? 'interrupted' : 'error'
        : nativeOutcome.status === 'stopped' ? 'interrupted' : nativeOutcome.status;
    let runtimeFinalText: string | null = null;
    let runtimeEnded = false;
    const finalizeRun = (status: Exclude<TraceRunStatus, 'running'>, error?: string | null): void => {
        if (!runtimeEnded) {
            runtimeEnded = true;
            const stopped = wasKilled || wasSteer || Boolean(ctx.stallReason) || status === 'interrupted';
            try {
                params.onRuntimeEnd?.({
                    kind: 'turn-end',
                    status: nativeOutcome === undefined
                        ? stopped ? 'stopped' : status === 'error' ? 'error' : 'done'
                        : nativeOutcome.status,
                    finalText: runtimeFinalText,
                    ...(error ? { error } : {}),
                });
            } catch { console.warn('[runtime:projection] lifecycle observer failed'); }
        }
        if (nativeOutcome === undefined) {
            try { finalizeTraceRun(ctx.traceRunId, status, error); }
            catch { console.warn('[trace] print finalization failed'); }
        } else {
            try { finalizeTraceRun(nativeTraceRunId, status, error); }
            catch { console.warn('[runtime] outcome trace finalization failed'); }
        }
    };

    // ─── Smoke response auto-continuation ───
    if (
        nativeOutcome === undefined
        && smokeResult.isSmoke
        && smokeResult.confidence !== 'low'
        && !opts._isSmokeContinuation
        && !opts.internal
        && mainManaged
        && !wasSteer
    ) {
        console.warn(
            `[jaw:smoke] ${cli} smoke detected (${smokeResult.confidence}). Auto-continuing.`,
        );
        broadcast('agent_smoke', {
            cli, confidence: smokeResult.confidence,
            reason: smokeResult.reason, agentId: agentLabel,
            ...empTag,
        }, isEmployee ? 'internal' : 'public');

        const smokeSessionId = ctx.sessionId;
        if (smokeSessionId) {
            persistMainSession({
                persistenceOwner, scopeKey, forceNew, employeeSessionId: empSid,
                sessionId: smokeSessionId, isFallback: opts._isFallback === true,
                code, cli, model, provider: effectiveProvider, resumeKey: params.resumeKey, effort: effortVal,
                skipSessionPersist: opts._skipSessionPersist === true,
                outputLen: params.outputLen,
                ...(params.codexAppBucket ? { codexAppBucket: params.codexAppBucket } : {}),
                runtimeTransport: params.runtimeTransport,
                scopedBucket: runBucket,
            });
            console.log(`[jaw:smoke] persisted session ${smokeSessionId.slice(0, 12)}... for continuation`);
        }

        activeProcesses.delete(agentLabel);
        if (releaseMainRun(scopeKey, childProcess, ownerGeneration)) {
            broadcast('agent_status', { running: false, agentId: agentLabel, scope: scopeKey, ...empTag });
        }
        finalizeRun('done');

        const contPrompt = buildContinuationPrompt(prompt, ctx.fullText);
        const { promise: contPromise } = _spawnAgent(contPrompt, {
            ...opts, _isSmokeContinuation: true, _skipInsert: true,
        });
        contPromise.then((r) => resolve(r)).catch(() => {
            broadcast('agent_done', { ...runTag(ctx), ...donePin,
                text: `❌ Smoke continuation failed. Original: ${ctx.fullText.slice(0, 200)}`,
                error: true, origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({
                text: ctx.fullText, code: code ?? 1,
                sessionId: ctx.sessionId, cost: ctx.cost,
                tools: ctx.toolLog, smoke: smokeResult,
            });
            processQueue(scopeKey);
        });
        return;
    }

    // ─── Process cleanup ───
    // When wasSteer, killActiveAgent already cleared activeProcess synchronously
    // and a replacement agent is being spawned. The stale exit handler must NOT
    // overwrite the new agent's references in activeProcesses / activeProcess / meta.
    if (mainManaged) {
        if (!wasSteer) {
            activeProcesses.delete(agentLabel);
            if (releaseMainRun(scopeKey, childProcess, ownerGeneration)) {
                _setCurrentMainMeta?.(scopeKey, null);
                broadcast('agent_status', { running: false, agentId: agentLabel, scope: scopeKey, ...empTag });
            }
        }
    } else {
        activeProcesses.delete(agentLabel);
    }

    if (nativeOutcome !== undefined && wasSteer && mainManaged && !opts.internal
        && nativeOutcome.partialText.length > 0) {
        // The existing MAX(id) salvage query reads MESSAGE rows, not Activity.
        // Commit before asynchronous cleanup and the caller's settleExit barrier.
        const partialTools = sanitizeToolLogForDurableStorage(ctx.toolLog);
        insertMessageWithTrace.run(
            'assistant', '⏹️ [interrupted]\n\n' + nativeOutcome.partialText, cli, model,
            ctx.traceLog.join('\n') || null, serializeSanitizedToolLog(partialTools),
            settings['workingDir'] || null, chatSessionId,
        );
    }

    // Post-flush reindex moved into memory-flush-controller's completion path
    // (032). Firing it here raced the append: this runs before the extractor
    // promise resolves, so it reindexed a file that did not yet contain the
    // entry — and a generation that had already expired could still trigger it.

    // ─── CLI-native compact → auto session refresh (awaited to avoid race with processQueue) ───
    if (nativeOutcome === undefined && ctx.cliNativeCompactDetected && mainManaged && !opts.internal) {
        console.log('[jaw:compact] CLI-native compaction detected — auto-refreshing session');
        try {
            const { autoCompactRefresh } = await import('../core/compact.js');
            await autoCompactRefresh({
                workDir: settings["workingDir"] || '',
                instructions: prompt || '',
                cli,
                model,
                scopeKey,
                chatSessionId,
                sessionBucket: runBucket,
            });
        } catch (e) {
            console.warn('[jaw:compact] auto-refresh failed:', (e as Error).message);
        }
    }

    // ─── Session persistence ───
    const persistedSessionId = ctx.sessionId;
    if (persistedSessionId && persistMainSession({
        persistenceOwner, scopeKey, forceNew, employeeSessionId: empSid,
        sessionId: persistedSessionId, isFallback: opts._isFallback === true,
        code, wasKilled, cli, model, provider: effectiveProvider, resumeKey: params.resumeKey, effort: effortVal,
        skipSessionPersist: opts._skipSessionPersist === true,
        outputLen: params.outputLen,
        ...(params.codexAppBucket ? { codexAppBucket: params.codexAppBucket } : {}),
        runtimeTransport: params.runtimeTransport,
        scopedBucket: runBucket,
    })) {
        console.log(`[jaw:session] saved ${cli} session=${persistedSessionId.slice(0, 12)}...${wasKilled ? ' (post-kill)' : ''}`);
    }
    if (cli === 'agy' && persistedSessionId) {
        const checkpointSeen = ctx.metadata?.['agyCheckpointSeen'] === true;
        const plannerOnly = ctx.metadata?.['agyPlannerOnly'] === true;
        const clean = code === 0 && !wasKilled && !ctx.stallReason && !plannerOnly && !checkpointSeen;
        updateSessionBucketLastRun.run(
            clean ? 1 : 0,
            settings['workingDir'] || '',
            JSON.stringify({ checkpointSeen, plannerOnly, exitCode: code, at: Date.now() }),
            runBucket,
        );
    }

    // ─── Phase 54-A: Proactive compact by turn count ───
    // CLIs without a reliable native compact/resume path get a conservative
    // turn-count refresh. AGY owns its compaction and keeps its conversation.
    if (nativeOutcome === undefined && mainManaged && !opts.internal && code === 0 && !ctx.cliNativeCompactDetected) {
        const turns = ctx.turns ?? memoryFlushCounter;
        const useTurnCountRefresh = shouldUseTurnCountRefresh(runtimeCli);
        if (useTurnCountRefresh && turns >= 35) {
            console.log(`[jaw:compact] ${cli} reached ${turns} turns — forcing auto-refresh`);
            try {
                const { autoCompactRefresh } = await import('../core/compact.js');
                await autoCompactRefresh({
                    workDir: settings["workingDir"] || '',
                    instructions: prompt || '',
                    cli,
                    model,
                    scopeKey,
                    chatSessionId,
                    sessionBucket: runBucket,
                });
            } catch (e) {
                console.warn('[jaw:compact] turn-count auto-refresh failed:', (e as Error).message);
            }
        } else if (useTurnCountRefresh && turns >= 25) {
            console.log(`[jaw:compact] ${cli} at ${turns} turns — suggesting compact`);
            broadcast('system_notice', {
                code: 'compact_suggest',
                text: `Session is at ${turns} turns. Consider running /compact to preserve context.`,
            }, 'public');
        }
    }

    // ─── High-turn native-compaction coordination ───
    // AGY keeps a native compacted conversation. Other CLIs still use the
    // conservative fresh-session guard when their compaction is not observable.
    if (nativeOutcome === undefined && mainManaged && !opts.internal && code === 0 && !ctx.cliNativeCompactDetected) {
        const turns = ctx.turns ?? memoryFlushCounter;
        if (shouldClearHighTurnSessionBucket(runtimeCli, turns)) {
            console.log(`[jaw:compact] ${cli} exited after ${turns} turns — clearing session bucket for fresh start`);
            try {
                const bucket = runBucket;
                clearSessionBucket.run(bucket);
            } catch (e) {
                console.warn('[jaw:compact] session bucket clear failed:', (e as Error).message);
            }
        }
    }

    // ─── Success: clear fallback state (auto-recovery) ───
    if (code === 0 && fallbackState.has(cli)) {
        console.log(`[jaw:fallback] ${cli} recovered — clearing fallback state`);
        fallbackState.delete(cli);
    }
    if (code === 0) clearErrors(cli);
    // Capacity came back: only a successful run proves it, so the park is
    // cleared here and nowhere else. Same key space as the write (#519).
    if (code === 0) clearRuntimeCooldown(runtimeCli);

    if (nativeOutcome === undefined && code === 0 && runtimeCli === 'grok') {
        const recovered = backfillGrokTraceTools(ctx);
        if (recovered > 0) {
            console.log(`[jaw:grok] recovered ${recovered} tool event(s) from Grok trace export`);
        }
    }

    // ─── Kiro stale resume on exit 0 (stdout carries "no saved chat sessions", etc.) ───
    // Only inspect the CLI diagnostic channels (stderr + assistant body) — never tool
    // output (ctx.traceLog), which is arbitrary content that can quote stale phrases.
    // A genuine stale resume does ZERO work, so require an empty toolLog: a turn that
    // actually ran tools must never be reclassified as stale and silently discarded.
    const kiroDiagnosticText = `${ctx.stderrBuf}\n${ctx.fullText}`;
    if (
        nativeOutcome === undefined
        && isKiroPlainTextCli(cli, effectiveProvider)
        && isResume
        && mainManaged
        && !opts.internal
        && !opts._isFallback
        && !opts._skipResume
        && !opts._kiroFreshRetry
        && !wasKilled
        && !wasSteer
        && (code === 0 || code === null)
        && ctx.toolLog.length === 0
        && shouldInvalidateResumeSession(runtimeCli, code, ctx.stderrBuf, kiroDiagnosticText)
    ) {
        const bucket = runBucket;
        if (bucket) {
            try { clearSessionBucket.run(bucket); } catch { /* ignore */ }
        }
        console.log('[jaw:kiro] stale resume detected on success exit — retrying fresh with history');
        try {
            const { peekPendingBootstrapPrompt } = await import('../core/main-session.js');
            if (!peekPendingBootstrapPrompt(scopeKey)) {
                const { autoCompactRefresh } = await import('../core/compact.js');
                await autoCompactRefresh({
                    workDir: settings["workingDir"] || null, instructions: '', cli, model, scopeKey,
                    chatSessionId,
                    sessionBucket: runBucket,
                });
            }
        } catch {}
        broadcast('agent_retry', {
            cli,
            delay: 0,
            reason: 'kiro stale resume — fresh with history',
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
        finalizeRun('error', 'kiro stale resume');
        const { promise: retryP } = _spawnAgent(prompt, {
            ...opts,
            _skipResume: true,
            _kiroFreshRetry: true,
            _skipInsert: true,
        });
        retryP.then(resolve).catch(() => {
            broadcast('agent_done', { ...runTag(ctx), ...donePin,
                text: '❌ kiro stale resume and fresh retry failed',
                error: true,
                origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue(scopeKey);
        });
        return;
    }

    // ─── Output handling ───
    const outputText = nativeOutcome === undefined ? resolveSpawnOutputText(ctx) : '';
    if (nativeOutcome !== undefined) {
        let finalContent = nativeOutcome.finalText;
        if (mainManaged && !opts.internal) {
            const safeTools = sanitizeToolLogForDurableStorage(
                mergeLatestTools(ctx.toolLog, ownsLiveRun() ? getLiveRun(liveScope).toolLog : [], nativeTraceRunId || ''),
            );
            if (finalContent !== null) {
                finalContent = applyOutputPolicy(finalContent, { scope: 'main' }).text;
                evaluateRecordPending(ctx.toolLog, finalContent);
                const structuredFence = scanStructuredFence(finalContent);
                if (structuredFence.status === 'incomplete') {
                    console.warn('[lifecycle] assistant output contains incomplete structured fence before durable insert', {
                        cli, model, traceRunId: nativeTraceRunId || null, chars: finalContent.length,
                        langs: structuredFence.langs, incompleteCount: structuredFence.incompleteCount,
                    });
                }
                // trace_run_id is nullable TEXT, not a FK: missing journal rows
                // cannot suppress final delivery or this history pointer.
                const info = insertMessageWithTraceRun.run(
                    'assistant', finalContent, cli, model, ctx.traceLog.join('\n') || null,
                    serializeSanitizedToolLog(safeTools), settings['workingDir'] || null,
                    nativeTraceRunId || null, chatSessionId,
                );
                const messageId = Number(info.lastInsertRowid);
                if (nativeTraceRunId && Number.isSafeInteger(messageId) && messageId > 0) {
                    try { linkTraceRunToMessage(nativeTraceRunId, messageId); }
                    catch { console.warn('[runtime] outcome trace link failed'); }
                }
            }
            const failed = nativeOutcome.status !== 'done';
            // `ctx.stallReason` is what makes the classifier say "stall" instead
            // of "abnormal exit", and the print paths have always passed it. The
            // native path did not, so a watchdog kill on a native runtime was
            // reported to the user as a crash. The ACTION footer that
            // messaging/error-block.ts builds from `errorKind` is the visible
            // difference: "the runtime stopped responding; sending the same
            // request again starts a new session" versus "the runtime exited
            // abnormally; check the logs if it repeats". Only the first is true
            // of a timeout.
            const errorKind = failed
                ? classifyExitError(runtimeCli, code ?? 1, ctx.stderrBuf, ctx.stallReason).errorKind
                : undefined;
            // Even absent/empty finals must terminate existing UI/collectors.
            // Only compatibility text collapses whitespace; never the outcome.
            handoffRuntimeOutcome(ctx, { ...nativeOutcome, finalText: finalContent });
            ctx.runtimeTerminalAttempted = true;
            const compatibilityText = runtimeCompatibilityText(finalContent);
            // A failed native turn with nothing to show reached the user as the
            // bare "no response" placeholder (orchestrator/collect.ts) even when
            // the runtime had already named its own cause. Carry that sentence
            // instead. Real text always wins, and a stopped run stays silent.
            const terminalText = compatibilityText || (nativeOutcome.status === 'error'
                && ctx.runtimeDiagnostic?.trim() ? `❌ ${ctx.runtimeDiagnostic.trim()}` : '');
            broadcast('agent_done', {
                ...donePin,
                ...(nativeTraceRunId ? { traceRunId: nativeTraceRunId } : {}),
                text: terminalText,
                runtimeFinality: finalContent === null ? 'absent' : 'present',
                runtimeStatus: nativeOutcome.status,
                ...(nativeRequestId !== undefined ? { requestId: nativeRequestId } : {}),
                sessionId: chatSessionId, scope: scopeKey, toolLog: safeTools, origin, ...empTag,
                ...(wasSteer ? { steered: true } : {}),
                ...(stopCause ? { stopCause } : {}),
                ...(failed ? { error: true, errorKind, cli: runtimeCli } : {}),
            });
            if (finalContent !== null) {
                if (opts._heartbeatAnchorId) {
                    try { markAnchorConsumed.run(Date.now(), opts._heartbeatAnchorId); }
                    catch { console.warn('[runtime] heartbeat anchor update failed'); }
                }
                incrementMemoryFlush();
                const threshold = resolveFlushEvery();
                if (settings['memory']?.enabled !== false && countTurnForFlush(threshold)) {
                    void triggerMemoryFlush();
                }
            }
        }
        runtimeFinalText = finalContent;
    } else if (outputText || (code === 0 && ctx.toolLog.length > 0)) {
        const cleaned = (outputText || ctx.fullText.trim())
            .replace(/<\/?tool_call>/g, '')
            .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
            // [#107] Strip inline thinking/reasoning blocks from any CLI
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const displayText = stripInterviewTracker(cleaned || outputText || ctx.fullText.trim());
        let finalContent = displayText + costLine;
        let traceText = ctx.traceLog.join('\n');
        /** Appended to what a reader sees, never to what is stored (#405). */
        let stallNotice = '';

        // Tag interrupted output
        if (wasSteer && mainManaged && !opts.internal) {
            finalContent = `⏹️ [interrupted]\n\n${finalContent}`;
            if (traceText) traceText = `⏹️ [interrupted]\n${traceText}`;
            console.log(`[jaw:steer] saving interrupted output (${finalContent.length} chars)`);
        }

        // A watchdog kill that produced PARTIAL output lands in this branch, not
        // the stall branch below, so its reason never reached the channel: the
        // reply simply stopped mid-thought and read as the model trailing off
        // (#405).
        //
        // The condition is `stallReason` alone, not `stallReason && wasKilled`.
        // The watchdog callback sets `stallReason` and kills the process but
        // never writes `killReasons`, and `wasKilled` is computed purely from
        // `consumeKillReason()` — so `wasKilled` is false for exactly the case
        // this line exists to cover. `stallReason` has no other writer, which is
        // what makes it sufficient by itself.
        //
        // The internal reason (`lastProgress=output x302`) stays out of it: that
        // is our diagnostic, not something the reader can act on. The server log
        // already has all of it.
        if (shouldAnnounceStallTruncation({
            stallReason: ctx.stallReason, wasSteer, mainManaged, internal: !!opts.internal,
        })) {
            // Stored, not just broadcast. Leaving it out of the durable row made
            // the notice vanish on refresh — the reader came back to a partial
            // answer that looked complete, which is the original complaint
            // (#405).
            //
            // What reads this row back as INSTRUCTIONS (history replay, resume
            // fallback, AGY replay, memory flush, compaction, the P-phase plan)
            // goes through `stripStallTruncationNotice` at its query boundary in
            // core/db.ts, so the line is removed once rather than at each of the
            // five call sites that would otherwise have to remember.
            //
            // `ctx.fullText` gets it too: `resolve()` hands that back and the
            // dispatch paths answer from it rather than from the agent_done
            // payload, so appending to only one showed the notice in the web
            // transcript while the Slack reply still trailed off mid-thought.
            stallNotice = `\n\n${STALL_TRUNCATION_NOTICE}`;
            finalContent = `${finalContent}${stallNotice}`;
            ctx.fullText = `${ctx.fullText}${stallNotice}`;
        }

        if (mainManaged && !opts.internal) {
            finalContent = applyOutputPolicy(finalContent, { scope: 'main' }).text;
            evaluateRecordPending(ctx.toolLog, finalContent);
            const structuredFence = scanStructuredFence(finalContent);
            if (structuredFence.status === 'incomplete') {
                console.warn('[lifecycle] assistant output contains incomplete structured fence before durable insert', {
                    cli,
                    model,
                    traceRunId: ctx.traceRunId || null,
                    chars: finalContent.length,
                    langs: structuredFence.langs,
                    incompleteCount: structuredFence.incompleteCount,
                });
            }
            const liveRun = getLiveRun(liveScope);
            const sanitizedToolLog = sanitizeToolLogForDurableStorage(
                mergeLatestTools(ctx.toolLog, liveRun.toolLog, ctx.traceRunId || ''),
            );
            const toolLogJson = serializeSanitizedToolLog(sanitizedToolLog);
            const info = insertMessageWithTraceRun.run(
                'assistant', finalContent, cli, model,
                traceText || null, toolLogJson, settings["workingDir"] || null,
                ctx.traceRunId || null, chatSessionId,
            );
            const messageId = Number(info.lastInsertRowid || 0);
            if (ctx.traceRunId && Number.isInteger(messageId) && messageId > 0) {
                try { linkTraceRunToMessage(ctx.traceRunId, messageId); }
                catch { console.warn('[trace] print link failed'); }
            }
            broadcast('agent_done', { ...runTag(ctx), ...donePin, text: finalContent, toolLog: sanitizedToolLog, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) });

            if (opts._heartbeatAnchorId) {
                try {
                    markAnchorConsumed.run(Date.now(), opts._heartbeatAnchorId);
                } catch (e) {
                    console.error('[lifecycle] Failed to mark heartbeat anchor consumed:', (e as Error).message);
                }
            }

            // Global on purpose: N assistant turns anywhere trigger ONE flush, which then
            // summarises every session holding unflushed rows. #454 stays fixed because
            // the TARGET is global now, not because the trigger is per session — when
            // everyone is summarised together, who spent the counter stops mattering.
            incrementMemoryFlush();
            const threshold = resolveFlushEvery();
            if (settings["memory"]?.enabled !== false && countTurnForFlush(threshold)) {
                // The outcome needs no handling: an insufficient cycle is spent by policy,
                // and a locked one has already queued its own retry.
                void triggerMemoryFlush();
            }
        }
        runtimeFinalText = finalContent;
    } else if (code !== 0 && wasKilled && !wasSteer && ctx.stallReason) {
        // Watchdog kills carry a useful reason, but `wasKilled` intentionally
        // bypasses the generic retry/fallback path below. Surface that reason
        // before the final resolver turns the empty process output into the
        // channel's generic "no response" message.
        const { message: errMsg, errorKind } = classifyExitError(
            runtimeCli,
            code,
            ctx.stderrBuf,
            ctx.stallReason,
            `${ctx.fullText}\n${ctx.traceLog.join('\n')}`,
        );
        if (mainManaged && !opts.internal) {
            insertMessage.run(
                'assistant',
                errMsg,
                cli,
                model,
                settings["workingDir"] || null,
                chatSessionId,
            );
        }
        broadcast(
            'agent_done',
            // Classified like the retry-exhausted site below: a watchdog kill is
            // the one failure the channel MUST show, and the forwarder gate
            // drops anything without errorKind (#519 round 2).
            { ...runTag(ctx), ...donePin, text: `❌ ${errMsg}`, error: true, errorKind, cli: runtimeCli, origin, ...empTag },
            isEmployee ? 'internal' : 'public',
        );
        finalizeRun('error', errMsg);
        resolve({ text: '', code: code ?? 1, diagnostic: errMsg });
        if (mainManaged && !opts.internal) processQueue(scopeKey);
        return;
    } else if (mainManaged && code !== 0 && !wasKilled) {
        // ─── Error handling ───
        const diagnosticText = `${ctx.fullText}\n${ctx.traceLog.join('\n')}`;
        const { is429, isStall, isModelCapacity, isClaudeRateLimit, isTransientStartup, isConnection, message: errMsg, errorKind, detail: errDetail, retryAfterMs } = classifyExitError(
            runtimeCli,
            code,
            ctx.stderrBuf,
            ctx.stallReason,
            diagnosticText,
            ctx.fullText.length > 0,
        );
        const suppressClaudeRateLimitFallback = isClaudeRateLimit;
        // Connection loss rides the same retry machinery as a 429: the request
        // never completed, backoff-and-respawn is the right recovery, and the
        // side-effect gate below already refuses when tools already ran. The
        // classifier keeps auth failures out of isConnection (a locked keychain
        // is not fixed by respawning). Observed live on suji: cursor turns dying
        // on ConnectRPC loss with no retry (2026-08-24).
        const effectiveIs429 = is429 || isClaudeRateLimit || isTransientStartup || isConnection;
        recordError(cli, isStall ? 'stall' : isModelCapacity ? 'model_capacity' : effectiveIs429 ? '429' : 'error');
        // Park the runtime that just refused us so the fallback search below —
        // and the next turn's — can skip it instead of walking back into the
        // same exhausted provider. Keyed by runtimeCli on write AND read (#519).
        if (is429) noteRuntimeCooldown(runtimeCli, retryAfterMs ?? DEFAULT_COOLDOWN_MS);
        // The raw child output is evidence for the trace, not a channel message.
        if (errDetail) ctx.traceLog.push(`[exit-detail] ${errDetail}`);

        const invalidatedResume = isResume
            && shouldInvalidateResumeSession(runtimeCli, code, ctx.stderrBuf, diagnosticText);
        if (invalidatedResume) {
            if (empSid && opts.agentId) {
                clearEmployeeSession.run(opts.agentId);
                console.log(`[jaw:session] invalidated stale employee resume — ${cli} agent=${opts.agentId}`);
            } else if ((scopeKey || 'default') !== 'default') {
                // The singleton session row belongs to the default scope (074 §2.3 G2).
                // A remote session's dead resume must still drop its own bucket, or the
                // next turn resumes a thread that no longer exists, but it does not get
                // to rewrite the CLI and model every other session reads.
                const bucket = runBucket;
                if (bucket) clearSessionBucket.run(bucket);
                console.log(`[jaw:session] invalidated stale resume — ${cli}/${bucket} bucket cleared (scope ${scopeKey})`);
            } else {
                updateSession.run(cli, null, model, settings["permissions"], settings["workingDir"], effortVal);
                const bucket = runBucket;
                if (bucket) clearSessionBucket.run(bucket);
                console.log(`[jaw:session] invalidated stale resume — ${cli}/${bucket} session cleared`);
            }
        }

        if (
            invalidatedResume
            && mainManaged
            && !opts.internal
            && !opts._isFallback
            && !opts._skipResume
            && !opts._kiroFreshRetry
        ) {
            console.log(`[jaw:resume] ${cli} stale resume invalidated — retrying current request without resume`);
            broadcast('agent_retry', {
                cli,
                delay: 0,
                reason: `${errMsg} (retry without stale resume)`,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            finalizeRun('error', errMsg);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                _skipResume: true,
                _skipInsert: true,
            }) as { promise: Promise<{ text: string; code: number }> };
            retryP.then(resolve).catch(() => {
                broadcast('agent_done', { ...runTag(ctx), ...donePin, text: `❌ ${errMsg} (fresh-session retry failed)`, error: true, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) }, isEmployee ? 'internal' : 'public');
                resolve({ text: '', code: 1 });
                if (mainManaged && !opts.internal) processQueue(scopeKey);
            });
            return;
        }

        // ─── Stall kills: do NOT retry — escalate immediately ───
        if (isStall) {
            if (mainManaged && !opts.internal) {
                const canNativeResume = cli === 'claude';
                if (!canNativeResume) {
                    try {
                        const { autoCompactRefresh } = await import('../core/compact.js');
                        await autoCompactRefresh({
                    workDir: settings["workingDir"] || null, instructions: '', cli, model, scopeKey,
                    chatSessionId,
                    sessionBucket: runBucket,
                });
                    } catch {}
                }
                insertMessage.run('assistant', `⏱️ ${errMsg}`, cli, model, settings["workingDir"] || null, chatSessionId);
            }
            broadcast('agent_done', { ...runTag(ctx), ...donePin, text: `❌ ${errMsg}`, error: true, errorKind, cli: runtimeCli, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) }, isEmployee ? 'internal' : 'public');
            finalizeRun('error', errMsg);
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue(scopeKey);
            return;
        }

        // ─── 429 delay retry (exponential backoff, up to MAIN_MAX_RETRIES) ───
        const mainAttempt = opts._retryAttempt ?? 0;
        // `!isStall` is redundant with the stall branch above, which returns
        // before reaching here — state it anyway so reordering these branches
        // cannot silently start retrying stalled runs, which may already have
        // produced side effects.
        if (
            !opts.internal && !opts._isFallback && effectiveIs429 && !isStall
            && !performedSideEffects(ctx)
            && mainAttempt < MAIN_MAX_RETRIES
        ) {
            // Obey a provider that stated its own wait, when it asked for longer
            // than our backoff: retrying before it expires just burns an attempt
            // against a runtime that already said no (#519).
            const delayMs = Math.max(computeBackoff(mainAttempt), retryAfterMs ?? 0);
            const delaySec = Math.round(delayMs / 1000);
            console.log(`[jaw:retry] ${cli} 429 detected — waiting ${delaySec}s before retry (attempt ${mainAttempt + 1}/${MAIN_MAX_RETRIES})`);
            broadcast('agent_retry', { cli, delay: delaySec, reason: errMsg, attempt: mainAttempt + 1, maxRetries: MAIN_MAX_RETRIES, ...empTag }, isEmployee ? 'internal' : 'public');
            finalizeRun('error', errMsg);
            retryState.setIsEmployee(isEmployee);
            retryState.setResolve(resolve);
            retryState.setOrigin(origin);
            retryState.setTimer(setTimeout(() => {
                retryState.setTimer(null);
                retryState.setResolve(null);
                retryState.setOrigin(null);
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, _retryAttempt: mainAttempt + 1, _skipInsert: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx), ...donePin, text: `❌ ${errMsg} (재시도 실패, attempt ${mainAttempt + 1})`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged && !opts.internal) processQueue(scopeKey);
                });
            }, delayMs));
            return;
        }

        if (!opts.internal && !opts._isFallback && effectiveIs429 && !isStall
            && performedSideEffects(ctx) && mainAttempt < MAIN_MAX_RETRIES) {
            // Say why the retry was declined, so this reads as a decision rather
            // than a missing feature.
            console.log(
                `[jaw:retry] ${cli} 429 detected but this run already executed effectful tools — `
                + 'not retrying, because re-running would repeat them',
            );
        }

        // ─── Fallback with retry tracking ───
        // Falling back re-runs the same prompt on a different CLI, so it repeats
        // effectful tools exactly as a retry would; the same gate has to apply or
        // the protection is trivially bypassed.
        if (!opts.internal && !opts._isFallback && !suppressClaudeRateLimitFallback && !performedSideEffects(ctx)) {
            const fallbackCli = (settings["fallbackOrder"] || [])
                // Skip a runtime that just told us it was out of capacity: the
                // whole point of falling back is to reach one that can answer.
                //
                // A saved order can still name a retired runtime, and its binary
                // may even remain on PATH. Skipping it here is what lets the next
                // live candidate answer instead of the turn dying on a dead name.
                .find((fc: string) => isLiveFallbackCandidate(fc, cli, detectCli, isRuntimeCoolingDown));
            if (fallbackCli) {
                const st = fallbackState.get(cli);
                if (st) {
                    st.retriesLeft = Math.max(0, st.retriesLeft - 1);
                    console.log(`[jaw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
                } else {
                    fallbackState.set(cli, { fallbackCli, retriesLeft: fallbackMaxRetries });
                    console.log(`[jaw:fallback] ${cli} → ${fallbackCli}, ${fallbackMaxRetries} retries queued`);
                }
                broadcast('agent_fallback', { from: cli, to: fallbackCli, reason: errMsg, ...empTag }, isEmployee ? 'internal' : 'public');
                finalizeRun('error', errMsg);
                try {
                    const { peekPendingBootstrapPrompt } = await import('../core/main-session.js');
                    if (!peekPendingBootstrapPrompt(scopeKey)) {
                        const { autoCompactRefresh } = await import('../core/compact.js');
                        await autoCompactRefresh({
                    workDir: settings["workingDir"] || null, instructions: '', cli, model, scopeKey,
                    chatSessionId,
                    sessionBucket: runBucket,
                });
                    }
                } catch {}
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx), ...donePin,
                        text: `❌ Fallback (${fallbackCli}) failed`, error: true, origin,
                        ...empTag,
                    }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged && !opts.internal) processQueue(scopeKey);
                });
                return;
            }
        }
        // The `{ ...runTag(ctx), ...donePin,` opening stays on this line: RID-001 in
        // tests/unit/web-sse-replay-idempotency.test.ts matches that exact shape
        // to prove every agent_done carries its trace run id.
        broadcast('agent_done', { ...runTag(ctx), ...donePin,
            text: `❌ ${errMsg}`,
            error: true,
            // Classified here so a forwarder never re-parses Korean prose to
            // decide what happened, and so an untagged error payload stays out
            // of the channel entirely (#519).
            errorKind,
            cli: runtimeCli,
            origin,
            ...(isEmployee ? { audience: 'internal' } : {}),
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
    } else if (isEmployee && code !== 0 && !wasKilled && !opts._isFallback) {
        // ─── Employee transient retry (exponential backoff, up to EMP_MAX_RETRIES) ───
        const diagnosticText = `${ctx.fullText}\n${ctx.traceLog.join('\n')}`;
        const cls = classifyExitError(
            runtimeCli, code, ctx.stderrBuf, ctx.stallReason, diagnosticText, ctx.fullText.length > 0,
        );
        const empAttempt = opts._retryAttempt ?? 0;
        if (
            cls.isTransientStartup
            && isResume
            && empSid
            && opts.agentId
            && !opts._employeeFreshSessionRetry
            && empAttempt === 0
            && !cls.isStall
            && !cls.isAuth
        ) {
            clearEmployeeSession.run(opts.agentId);
            console.log(`[jaw:session] employee stale resume pre-SessionStart — cleared ${opts.agentId} and retrying fresh`);
            broadcast('agent_retry', {
                cli,
                delay: 0,
                reason: `${cls.message} (cleared stale employee resume; retrying fresh session)`,
                isEmployee: true,
                attempt: 1,
                maxRetries: 1,
            }, 'internal');
            finalizeRun('error', cls.message);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                _skipInsert: true,
                _skipResume: true,
                _employeeFreshSessionRetry: true,
            });
            retryP.then((r) => resolve(r)).catch((retryErr: Error) => {
                const retryMessage = retryErr?.message ? `; retry=${retryErr.message}` : '';
                const diagnostic = `${cls.message} (fresh employee session retry failed${retryMessage})`;
                broadcast('agent_done', { ...runTag(ctx), ...donePin, text: `❌ ${diagnostic}`, error: true, origin, isEmployee: true }, 'internal');
                resolve({ text: '', code: 1, diagnostic });
            });
            return;
        }
        if (
            (cls.is429 || cls.isClaudeRateLimit || cls.isTransientStartup || cls.isConnection)
            && !cls.isStall && !cls.isAuth
            && !performedSideEffects(ctx)
            && !opts._employeeFreshSessionRetry
            && empAttempt < EMP_MAX_RETRIES
        ) {
            recordError(cli, '429');
            const empDelayMs = computeBackoff(empAttempt, 3000, 60_000);
            const empDelaySec = Math.round(empDelayMs / 1000);
            console.log(`[jaw:retry] employee ${cli} transient exit — retry in ${empDelaySec}s (attempt ${empAttempt + 1}/${EMP_MAX_RETRIES}, ${cls.message})`);
            broadcast('agent_retry', { cli, delay: empDelaySec, reason: cls.message, isEmployee: true, attempt: empAttempt + 1 }, 'internal');
            finalizeRun('error', cls.message);
            retryState.setIsEmployee(true);
            retryState.setResolve(resolve);
            retryState.setOrigin(origin);
            retryState.setTimer(setTimeout(() => {
                retryState.setTimer(null);
                retryState.setResolve(null);
                retryState.setOrigin(null);
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, _retryAttempt: empAttempt + 1, _skipInsert: true, _skipResume: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx), ...donePin, text: `❌ ${cls.message} (재시도 실패, attempt ${empAttempt + 1})`, error: true, origin, isEmployee: true }, 'internal');
                    resolve({ text: '', code: 1, diagnostic: cls.message });
                });
            }, empDelayMs));
            return;
        }
        // non-retryable employee error → fall through to Final resolve below
    }

    // ─── Kiro resume degraded (empty body) → fresh spawn with history fallback ───
    const kiroOutputText = nativeOutcome === undefined ? resolveSpawnOutputText(ctx) : '';
    if (
        nativeOutcome === undefined
        && isKiroPlainTextCli(cli, effectiveProvider)
        && isResume
        && mainManaged
        && !opts.internal
        && !opts._isFallback
        && !opts._kiroFreshRetry
        && !wasKilled
        && !wasSteer
        && (code === 0 || code === null)
        && isKiroResumeDegradedOutput(kiroOutputText, ctx.toolLog.length, isResume)
    ) {
        const bucket = runBucket;
        if (bucket) {
            try { clearSessionBucket.run(bucket); } catch { /* ignore */ }
        }
        console.log('[jaw:kiro] resume returned empty output — retrying fresh with history (original logic)');
        broadcast('agent_retry', {
            cli,
            delay: 0,
            reason: 'kiro resume empty — fresh with history',
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
        finalizeRun('error', 'kiro resume empty');
        const { promise: retryP } = _spawnAgent(prompt, {
            ...opts,
            _skipResume: true,
            _kiroFreshRetry: true,
            _skipInsert: true,
            _skipSessionPersist: true,
        });
        retryP.then(resolve).catch(() => {
            broadcast('agent_done', { ...runTag(ctx), ...donePin,
                text: '❌ kiro resume empty and fresh retry failed',
                error: true,
                origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue(scopeKey);
        });
        return;
    }

    // ─── Final resolve ───
    const resolvedCode = code;
    finalizeRun(
        traceStatus,
        traceStatus === 'error' ? failureMessage(ctx, runtimeCli, resolvedCode ?? 1) : null,
    );
    const liveOwnedAtFinish = ownsLiveRun();
    if (mainManaged && !wasSteer && liveOwnedAtFinish) clearLiveRun(liveScope);
    if (!opts.internal && !wasSteer && liveOwnedAtFinish) {
        broadcast('agent_status', {
            status: (resolvedCode === 0 || resolvedCode === null) ? 'done' : 'error',
            agentId: agentLabel,
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
    }
    if (agentLabel !== 'main' || code !== null) {
        console.log(`[jaw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);
    }
    const diagnostic = resolvedCode !== 0 && resolvedCode !== null
        ? failureMessage(ctx, runtimeCli, resolvedCode)
        : ctx.stderrBuf.trim().slice(0, 500);
    const resolvedOutcome: RuntimeTurnOutcome | undefined = nativeOutcome === undefined
        ? undefined : { ...nativeOutcome, finalText: runtimeFinalText };
    const answerText = resolvedOutcome === undefined ? ctx.fullText : runtimeCompatibilityText(resolvedOutcome.finalText);
    const executionInterrupted = resolvedOutcome === undefined && (wasKilled || wasSteer) && !ctx.stallReason;
    const executionFailed = resolvedOutcome === undefined && !executionInterrupted
        && (traceStatus === 'error' || Boolean(ctx.stallReason));
    resolve({
        text: answerText, code: resolvedCode ?? 0,
        ...(executionInterrupted ? { executionInterrupted: true } : {}),
        ...(executionFailed ? { executionFailed: true } : {}),
        ...(resolvedOutcome === undefined ? {} : { runtimeOutcome: resolvedOutcome }),
        ...(resolvedOutcome !== undefined && nativeTraceRunId ? { traceRunId: nativeTraceRunId } : {}),
        sessionId: ctx.sessionId, cost: ctx.cost,
        tools: ctx.toolLog, smoke: smokeResult,
        diagnostic,
        ...(typeof ctx.metadata?.['agyCheckpointSeen'] === 'boolean'
            ? { agyCheckpointSeen: ctx.metadata['agyCheckpointSeen'] } : {}),
        ...(typeof ctx.metadata?.['agyPlannerOnly'] === 'boolean'
            ? { agyPlannerOnly: ctx.metadata['agyPlannerOnly'] } : {}),
        ...(params.outputLen ? { outputLen: params.outputLen } : {}),
        ...(stopCause ? { stopCause } : {}),
    });

    // ─── AI-initiated /goal done or /goal cancel ───
    // The AI can't execute slash commands directly. Detect the pattern in output
    // and execute it so the continuation loop stops.
    const controlText = resolvedOutcome === undefined ? ctx.fullText
        : resolvedOutcome.status === 'done' ? resolvedOutcome.finalText ?? '' : '';
    const allowNativeContinuation = resolvedOutcome === undefined
        || (resolvedOutcome.status === 'done' && resolvedOutcome.finalText !== null);
    let goalDoneRejected = false;
    if (mainManaged && !opts.internal && controlText) {
        const activeGoal = getActiveGoal();
        if (activeGoal && activeGoal.status === 'active') {
            // A truncated capture means a trailing marker may have been dropped,
            // so the ABSENCE of one is no longer authoritative. Say so rather
            // than silently treating the clipped text as complete.
            if (resolvedOutcome === undefined && ctx.fullTextTruncated && !GOAL_DONE_RE.test(controlText)) {
                console.warn('[jaw:goal] assistant text was truncated at the safety bound — a trailing /goal marker may have been lost');
            }
            if (GOAL_DONE_RE.test(controlText)) {
                if (goalHasCompletionEvidence(activeGoal)) {
                    completeGoal();
                    clearGoalTimers();
                    console.log('[jaw:goal] AI /goal done — evidence present, goal marked complete');
                    broadcast('goal_done', { goalId: activeGoal.id, source: 'ai_output' });
                } else {
                    goalDoneRejected = true;
                    console.warn('[jaw:goal] AI /goal done REJECTED — no verification evidence on latest checkpoint');
                    broadcast('goal_done_rejected', { goalId: activeGoal.id, reason: 'no_evidence' });
                }
            } else if (GOAL_CANCEL_RE.test(controlText)) {
                // Cancelling used to happen here on sight of the marker, with no
                // gate at all — which made ABANDONING a goal strictly easier than
                // completing one, since /goal done next door demands verification
                // evidence. A model explaining the command ("you can /goal cancel
                // to stop this") destroyed the goal by describing it.
                //
                // Stopping the continuation loop does not require destroying the
                // record, so the marker now does the reversible half: timers stop,
                // the goal survives, and a human decides whether it dies.
                clearGoalTimers();
                console.warn('[jaw:goal] AI output contained /goal cancel — timers cleared, goal left active for a human decision');
                broadcast('goal_cancel_requested', { goalId: activeGoal.id, source: 'ai_output' });
            } else if (GOAL_PAUSE_RE.test(controlText)) {
                clearGoalTimers();
                console.log('[jaw:goal] AI output contained /goal pause — timers cleared');
                broadcast('goal_pause_detected', { goalId: activeGoal.id, source: 'ai_output' });
            }
        }
    }

    // ─── ScheduleWakeup server intercept ───
    // When the AI called ScheduleWakeup, the CLI ignores it (only works in /loop).
    // cli-jaw intercepts the params and schedules a delayed --resume of the same session.
    if (
        allowNativeContinuation
        && ctx.scheduleWakeup
        && ctx.scheduleWakeup.prompt.trim()
        && mainManaged
        && !opts.internal
        && !wasKilled
        && (resolvedCode === 0 || resolvedCode === null)
    ) {
        const { delaySeconds, prompt: wakeupPrompt, reason: wakeupReason } = ctx.scheduleWakeup;
        const clampedDelay = Math.max(60, Math.min(3600, delaySeconds)) * 1000;
        if (clampedDelay !== delaySeconds * 1000) {
            console.log(`[jaw:wakeup] delay clamped: ${delaySeconds}s → ${clampedDelay / 1000}s`);
        }
        const goalAtWakeup = getActiveGoal();
        const goalIdAtWakeup = goalAtWakeup?.id ?? '__none__';
        if (_goalContGoalId !== goalIdAtWakeup) {
            _goalContAttempts = 0;
            _goalContGoalId = goalIdAtWakeup;
        }
        _goalContAttempts++;
        console.log(`[jaw:wakeup] ScheduleWakeup intercepted — resuming in ${clampedDelay / 1000}s (${wakeupReason}) [goal=${goalIdAtWakeup}, attempt=${_goalContAttempts}/${GOAL_CONT_MAX_ATTEMPTS}]`);
        if (_goalContAttempts > GOAL_CONT_MAX_ATTEMPTS) {
            console.warn(`[jaw:wakeup] max attempts reached — not scheduling`);
            broadcast('goal_continuation_limit', { attempts: _goalContAttempts });
            _goalContAttempts = 0;
        } else {
            broadcast('schedule_wakeup', { delaySeconds: clampedDelay / 1000, reason: wakeupReason });
            const existingWakeup = _goalTimers.get(goalIdAtWakeup);
            if (existingWakeup) clearTimeout(existingWakeup);
            const tid = setTimeout(() => {
                _goalTimers.delete(goalIdAtWakeup);
                const currentGoal = getActiveGoal();
                if (!currentGoal || currentGoal.id !== goalIdAtWakeup || currentGoal.status !== 'active') {
                    console.log(`[jaw:wakeup] goal changed or inactive — skipping resume`);
                    return;
                }
                console.log(`[jaw:wakeup] firing delayed resume (${wakeupReason})`);
                insertGoalContinuationBoundary(`Goal resume (${wakeupReason})`);
                const { promise: wakeP } = _spawnAgent(wakeupPrompt, {
                    _skipInsert: true,
                });
                wakeP.catch((err: Error) => {
                    console.warn('[jaw:wakeup] delayed resume failed:', err.message);
                    broadcast('schedule_wakeup_failed', { reason: wakeupReason, error: err.message });
                });
            }, clampedDelay);
            _goalTimers.set(goalIdAtWakeup, tid);
        }
    } else if (
    // ─── Goal auto-continuation (max 20 consecutive attempts) ───
        allowNativeContinuation
        && mainManaged
        && !opts.internal
        && !wasKilled
        && !wasSteer
        && (resolvedCode === 0 || resolvedCode === null)
    ) {
        const goalCont = buildGoalContinuation();
        if (goalCont.shouldContinue && goalCont.prompt) {
            const contGoal = getActiveGoal();
            const contGoalId = contGoal?.id ?? '__none__';
            if (goalCont.reason === 'pause_gate_pending' && opts._isGoalContinuation) {
                recordTurn();
                _goalContAttempts = 0;
                _goalContGoalId = contGoalId;
                console.log('[jaw:goal] pause gate pending after goal continuation — not scheduling another continuation');
                broadcast('goal_pause_gate_pending', { goalId: contGoalId, reason: goalCont.reason });
                return;
            }
            if (_goalContGoalId !== contGoalId) {
                _goalContAttempts = 0;
                _goalContGoalId = contGoalId;
            }
            _goalContAttempts++;
            if (_goalContAttempts > GOAL_CONT_MAX_ATTEMPTS) {
                console.warn(`[jaw:goal] max continuation attempts (${GOAL_CONT_MAX_ATTEMPTS}) reached — stopping`);
                broadcast('goal_continuation_limit', { attempts: _goalContAttempts });
                _goalContAttempts = 0;
            } else {
                recordTurn();
                const delay = opts._isGoalContinuation ? 10000 : 2000;
                console.log(`[jaw:goal] active goal — continuation ${_goalContAttempts}/${GOAL_CONT_MAX_ATTEMPTS} in ${delay}ms`);
                broadcast('goal_continuation', { reason: goalCont.reason, attempt: _goalContAttempts });
                const existingCont = _goalTimers.get(contGoalId);
                if (existingCont) clearTimeout(existingCont);
                const tid = setTimeout(() => {
                    _goalTimers.delete(contGoalId);
                    const currentGoal = getActiveGoal();
                    if (!currentGoal || currentGoal.id !== contGoalId || currentGoal.status !== 'active') {
                        console.log(`[jaw:goal] goal changed or inactive — skipping continuation`);
                        _goalContAttempts = 0;
                        return;
                    }
                    const contPrompt = goalDoneRejected
                        ? `[goal-gate] Your previous \`/goal done\` was REJECTED: the latest checkpoint had no verification evidence. Before declaring done again, run \`cli-jaw goal update "<summary>" --evidence "<test result / changed file>"\` with concrete evidence, and metacognitively confirm every part of the objective is truly finished.\n\n${goalCont.prompt!}`
                        : goalCont.prompt!;
                    insertGoalContinuationBoundary(`Goal continue (${_goalContAttempts}/${GOAL_CONT_MAX_ATTEMPTS})`);
                    const { promise: contP } = _spawnAgent(contPrompt, {
                        ...opts,
                        _isGoalContinuation: true,
                        _skipInsert: true,
                    });
                    contP.catch((err: Error) => {
                        console.warn('[jaw:goal] auto-continuation failed:', err.message);
                        broadcast('goal_continuation_failed', { error: err.message });
                    });
                }, delay);
                _goalTimers.set(contGoalId, tid);
            }
        } else {
            _goalContAttempts = 0;
        }
    }

    if (mainManaged && !wasSteer) processQueue(scopeKey);
}
