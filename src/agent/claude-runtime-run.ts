import type { ChildProcess } from 'node:child_process';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import type { RuntimeEvent, RuntimeLivenessIdentity, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import type { RuntimePrompt } from './runtime/session.js';
import type { PreparedClaudeOptions } from './runtime/claude-sdk-options.js';
import type { ClaudeSdkSession } from './runtime/claude-sdk-session.js';
import { runNativeRuntime, NativeRunFailure, type NativeRunLease } from './native-runtime-run.js';
import { acquireClaudeRuntime } from './runtime-pool.js';
import { ClaudeAcquireFailure } from './claude-runtime-pool.js';
import { handleAgentExit, type ExitHandlerParams } from './lifecycle-handler.js';
import { handoffRuntimeOutcome } from './runtime/outcome.js';
import { runPinFields } from '../messaging/run-pin.js';
import { RuntimeProjection, type RuntimeEnd } from './runtime/projection.js';
import { recordRuntimeEvent } from './runtime/events.js';
import { reserveClaudeRun } from './runtime/claude-run-controls.js';
import { startTraceRun, createTraceId, stampTraceTool, updateTraceToolRow, finalizeTraceRun } from '../trace/store.js';
import { insertMessage } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import { beginLiveRun, setLiveRunTraceId, getLiveRun, clearLiveRun } from './live-run-state.js';
import { syncLiveTools } from './events/helpers.js';
import { getWorkerSlot, updateWorkerTools } from '../orchestrator/worker-registry.js';
import { attachWatchdog } from './watchdog.js';
import { isLifecycleSteerReason } from './spawn/kill-reason.js';
import { stopCauseFromKillReason } from './spawn/stop-cause.js';
import { detectSmokeResponse } from './smoke-detector.js';
import { clearNativeStartFailure, recordNativeStartFailure } from './runtime/start-failure.js';

type Result = Parameters<ExitHandlerParams['resolve']>[0];
export type ClaudeExitBase = Omit<ExitHandlerParams, 'ctx' | 'code' | 'killReason' | 'wasKilled' | 'wasSteer' | 'smokeResult'
    | 'costLine' | 'resolve' | 'childProcess' | 'onRuntimeEnd' | 'processQueue'>;
export interface ClaudeNativeRunOptions {
    prepared: PreparedClaudeOptions;
    prompt: RuntimePrompt;
    exit: ClaudeExitBase;
    storedSessionId?: string | null;
    fresh: boolean;
    timeoutMs: number;
    watchdog?: Parameters<typeof attachWatchdog>[3];
    audience: 'public' | 'internal';
    liveScope: string | null;
    parentLiveScope: string | null;
    parentItemId?: string;
    isCurrent(): boolean;
    isCurrentOwner: Parameters<typeof acquireClaudeRuntime>[0]['isCurrentOwner'];
    starting(cancel: (reason: string) => void): void;
    ready(child: ChildProcess, cancel: (reason: string) => void): void | (() => void);
    finished(child: ChildProcess | null, cancel: (reason: string) => void, queueRequested: boolean, cleanupSafe: boolean): void;
    cleanupUnleased?(): void;
    consumeKillReason(pid: number | undefined): string | null;
    activity?(identity: RuntimeLivenessIdentity): void;
    exited?(code: number): void;
    cancelling?(reason: string): void;
}

/** Name the guard that ended the turn. Only an unknown cause keeps the credential hint. */
export function claudeFailureDiagnostic(code: string | null | undefined): string {
    switch (code) {
        case 'claude_background_tasks_unsupported':
            return 'Claude native supports foreground tasks only. Set run_in_background:false.';
        case 'claude_sdk_frame_malformed':
            return 'Claude completed tool activity but returned an SDK frame cli-jaw could not parse. Existing delivered files may still be valid; inspect the run trace instead of changing model or login.';
        case 'claude_owner_stale':
            return 'Claude stopped this turn because the session was reset or a setting that changes how it runs (CLI, model, permissions, working directory) was saved while it was running. Send the message again.';
        default:
            return `Claude native runtime failed${code ? ` (${code})` : ''}. Check the selected model, permissions and existing CLI login.`;
    }
}

/** Claude adaptation only. The shared host owns execution; existing lifecycle owns delivery. */
export function startClaudeNativeRun(input: ClaudeNativeRunOptions): { child: null; promise: Promise<Result> } {
    const base = input.exit, worker = !base.mainManaged;
    const workerSlot = worker ? getWorkerSlot(base.agentLabel) : undefined;
    let traceRunId: string;
    try { traceRunId = startTraceRun({ cli: 'claude', model: base.model, workingDir: input.prepared.cwd,
        agentLabel: base.agentLabel, audience: input.audience, sessionId: base.chatSessionId, scopeKey: base.scopeKey }); }
    catch { traceRunId = createTraceId(); console.warn('[runtime:claude] trace creation unavailable'); }
    const identity = Object.freeze({ runId: traceRunId, sessionId: base.chatSessionId, scope: base.scopeKey,
        turnId: traceRunId, audience: input.audience, ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}) });
    const ctx: SpawnContext = { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(), hasClaudeStreamEvents: false,
        sessionId: null, cost: null, turns: null, duration: null, tokens: null, stderrBuf: '', runStartedAt: Date.now(),
        origin: base.origin, ...(base.opts.requestId ? { requestId: base.opts.requestId } : {}),
        liveScope: input.liveScope, parentLiveScope: input.parentLiveScope, traceRunId, traceAudience: input.audience };
    let facade: ClaudeSdkSession | null = null, owned: NativeRunLease | null = null;
    let fallbackProjection: RuntimeProjection | null = null;
    let finalized = false, started = false, ended = false, finalizeFailed = false, queueRequested = false, cleanupSafe = false;
    let stopReason: string | null = null, selected: Result | undefined;
    let awaitingUnleasedCleanup = false;
    let acquisitionStarted = false;
    let killReasonConsumed = false;
    const consumeCapturedKillReason = (pid: number | undefined) => {
        if (killReasonConsumed) return null;
        killReasonConsumed = true;
        return input.consumeKillReason(pid);
    };
    let run!: ReturnType<typeof runNativeRuntime<Result>>;
    const cancel = (reason: string) => { stopReason ??= reason; input.cancelling?.(reason); run.cancel(reason); };
    let control: ReturnType<typeof reserveClaudeRun>;
    try {
        control = reserveClaudeRun({ runId: traceRunId, scope: base.scopeKey,
            ...(worker ? { workerId: base.agentLabel } : {}), cancel });
    } catch (error) {
        try { finalizeTraceRun(traceRunId, 'error', 'Claude native admission failed'); }
        catch { console.warn('[runtime:claude] admission trace finalization failed'); }
        throw error;
    }
    const current = () => !finalized && control.current() && input.isCurrent();
    const resultFor = (outcome: RuntimeTurnOutcome): Result => ({ text: outcome.finalText?.trim() ?? '',
        code: outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1, runtimeOutcome: outcome,
        traceRunId, sessionId: ctx.sessionId, cost: ctx.cost, tools: ctx.toolLog });
    // Owner loss settles through `settle` → `runtimeDiagnostic` without calling `failed()`
    // (native-runtime-run.ts), so the guard code is logged here, once per run, wherever the
    // diagnostic is first produced. The trace keeps only the user-facing text.
    let failureCodeLogged = false;
    const diagnostic = () => {
        const code = facade?.lastError ?? null;
        if (code && !failureCodeLogged) { failureCodeLogged = true; console.warn(`[runtime:claude] turn failed code=${code}`); }
        return claudeFailureDiagnostic(code);
    };
    const ensureFallbackStarted = () => {
        if (started || ended || fallbackProjection) return;
        fallbackProjection = new RuntimeProjection(identity);
        fallbackProjection.start('claude');
    };
    const end = (value: RuntimeEnd) => {
        if (ended) return;
        if (facade?.claimTurnOutcome(traceRunId)) {
            ended = true;
            if (!facade.finalizeTurn(traceRunId, value)) finalizeFailed = true;
        } else if (!started) {
            ensureFallbackStarted(); ended = true; fallbackProjection!.close(value);
        } else { ended = true; finalizeFailed = true; console.warn('[runtime:claude] missing captured finalizer'); }
    };
    const failed = (outcome: RuntimeTurnOutcome): Result => {
        ctx.stallWatchdog?.stop();
        const final = selected?.runtimeOutcome ?? (ctx.runtimeTerminalAttempted && ctx.runtimeOutcome ? ctx.runtimeOutcome : {
            status: stopReason || ctx.stallReason ? 'stopped' as const : 'error' as const, finalText: null, partialText: outcome.partialText });
        const stopCause = final.status === 'stopped' ? stopCauseFromKillReason(stopReason) : undefined;
        finishTools(final.status);
        handoffRuntimeOutcome(ctx, final);
        try {
            ensureFallbackStarted();
            if (!ctx.runtimeTerminalAttempted && !selected) {
                ctx.runtimeTerminalAttempted = true;
                broadcast('agent_done', { ...runPinFields({ origin: base.origin, requestId: base.opts.requestId,
                        scope: base.scopeKey, sessionId: base.chatSessionId,
                        remoteKey: base.opts.remoteKey, target: base.opts.target }),
                    traceRunId, cli: 'claude', ...(worker ? { isEmployee: true } : {}),
                    text: final.status === 'stopped' ? '' : `❌ ${diagnostic()}`, error: true,
                    runtimeStatus: final.status, runtimeFinality: final.finalText === null ? 'absent' : 'present',
                    ...(stopCause ? { stopCause } : {}) }, input.audience);
            }
        } finally {
            try { end({ kind: 'turn-end', status: final.status, finalText: final.finalText, error: diagnostic() }); }
            finally {
                // Projection completion does not finish the trace row. Lifecycle
                // may never have run (for example, send rejected an image).
                try { finalizeTraceRun(traceRunId, final.status === 'stopped' ? 'interrupted' : final.status,
                    final.status === 'error' ? diagnostic() : null, { onlyIfRunning: true }); }
                catch { console.warn('[runtime:claude] failure trace finalization failed'); }
            }
        }
        return selected ?? { ...resultFor(final), diagnostic: diagnostic(), ...(stopCause ? { stopCause } : {}) };
    };
    const tools = new Map<string, ToolEntry>();
    const syncOwnedTools = () => {
        if (!input.liveScope || getLiveRun(input.liveScope).traceRunId === traceRunId) syncLiveTools(ctx);
    };
    const finishTools = (status: RuntimeTurnOutcome['status']) => {
        for (const tool of tools.values()) {
            if (tool.status !== 'running') continue;
            // A parent result is not a native terminal for an unfinished tool.
            // Match RuntimeProjection.close; only an observed tool result is done.
            tool.status = status === 'error' ? 'error' : 'stopped';
            try { updateTraceToolRow(tool); } catch { console.warn('[runtime:claude] tool completion trace unavailable'); }
        }
        ctx.toolLog = [...tools.values()];
        try {
            syncOwnedTools();
            if (workerSlot && getWorkerSlot(base.agentLabel) === workerSlot) updateWorkerTools(base.agentLabel, ctx.toolLog);
        } catch { console.warn('[runtime:claude] tool completion mirror unavailable'); }
    };
    const event = (value: RuntimeEvent) => {
        if (value.kind !== 'tool') return;
        let tool = tools.get(value.itemId);
        if (!tool && tools.size >= 160) return;
        const detail = [value.input, value.output, value.detail].filter(part => part !== undefined && part !== '').join('\n');
        if (!tool) {
            tool = { icon: '🔧', label: value.name, toolType: 'tool', status: value.status, detail,
                stepRef: `runtime:${traceRunId}:${value.itemId}` };
            stampTraceTool(tool, ctx, 'tool'); tools.set(value.itemId, tool);
        } else { Object.assign(tool, { label: value.name, status: value.status, detail }); updateTraceToolRow(tool); }
        ctx.toolLog = [...tools.values()]; syncOwnedTools();
        if (workerSlot && getWorkerSlot(base.agentLabel) === workerSlot) updateWorkerTools(base.agentLabel, ctx.toolLog);
    };
    run = runNativeRuntime<Result>({ turnId: traceRunId, prompt: input.prompt, isCurrent: current,
        acquire: async signal => {
            acquisitionStarted = true;
            const lease = await acquireClaudeRuntime({ scopeKey: base.scopeKey, chatSessionId: base.chatSessionId,
                ...(worker ? { workerId: base.agentLabel } : {}), prepared: input.prepared,
                persistenceOwner: base.persistenceOwner, isCurrentOwner: input.isCurrentOwner, canAcquire: current,
                ...(input.storedSessionId === undefined ? {} : { storedSessionId: input.storedSessionId }),
                forceNew: input.fresh, signal, promptTimeoutMs: input.timeoutMs,
                binding: { getTurnContext: () => ({ ...identity, isCurrent: current }),
                    onMetadata: (context, metadata) => {
                        if (context.runId !== traceRunId || context.turnId !== traceRunId || !current()) return;
                        if (metadata.sessionId !== undefined) ctx.sessionId = metadata.sessionId;
                        if (metadata.cost !== undefined) ctx.cost = metadata.cost;
                        if (metadata.turns !== undefined) ctx.turns = metadata.turns;
                        if (metadata.durationMs !== undefined) ctx.duration = metadata.durationMs;
                        if (metadata.tokens) ctx.tokens = {
                            ...(metadata.tokens.input === undefined ? {} : { input_tokens: metadata.tokens.input }),
                            ...(metadata.tokens.output === undefined ? {} : { output_tokens: metadata.tokens.output }),
                            ...(metadata.tokens.cache_read === undefined ? {} : { cached_input_tokens: metadata.tokens.cache_read }),
                            ...(metadata.tokens.cache_creation === undefined ? {} : { cache_creation_input_tokens: metadata.tokens.cache_creation }),
                        };
                    },
                    record: (context, body) => { if (body.kind === 'turn-start') started = true; return recordRuntimeEvent(context, body); },
                } }).catch(failure => {
                    if (failure instanceof ClaudeAcquireFailure) {
                        awaitingUnleasedCleanup = true;
                        void failure.cleanup.then(() => {
                            cleanupSafe = true; awaitingUnleasedCleanup = false;
                            if (finalized) {
                                try { if (worker) input.cleanupUnleased?.(); }
                                finally { control.finish(); }
                            }
                        }).catch(() => { console.warn('[runtime:claude] unleased cleanup remains fenced'); });
                    }
                    throw failure;
                });
            facade = lease.session;
            owned = { child: lease.child, session: facade, release: () => lease.release(),
                retire: async reason => {
                    await lease.retire(reason); cleanupSafe = true;
                    if (worker && finalized && control.current()) {
                        try { input.cleanupUnleased?.(); }
                        finally { control.finish(); }
                    }
                } };
            return owned;
        },
        ready: lease => {
            if (!current()) throw new Error('claude_owner_lost');
            // This start reached its lease, so the previous start failure is spent.
            clearNativeStartFailure('claude');
            let detach: (() => void) | undefined;
            const liveness: RuntimeLivenessIdentity = { runId: traceRunId, sessionId: base.chatSessionId, scope: base.scopeKey,
                origin: base.origin, ...(base.opts.requestId ? { requestId: base.opts.requestId } : {}) };
            const io = () => { if (current()) { try { input.activity?.(liveness); } catch { console.warn('[runtime:claude] activity observer failed'); } } };
            const dispose = () => {
                ctx.stallWatchdog?.stop(); lease.child.stdout?.off('data', io); lease.child.stderr?.off('data', io); detach?.();
            };
            try {
                detach = input.ready(lease.child, cancel) || undefined;
                if (base.mainManaged && !base.opts._skipInsert) insertMessage.run('user', base.prompt, 'claude', base.model, input.prepared.cwd, base.chatSessionId);
                if (input.liveScope) { beginLiveRun(input.liveScope, 'claude'); setLiveRunTraceId(input.liveScope, traceRunId); }
                lease.child.stdout?.on('data', io); lease.child.stderr?.on('data', io);
                ctx.stallWatchdog = attachWatchdog(lease.child, base.agentLabel, reason => { ctx.stallReason = reason; cancel(reason); }, input.watchdog);
                broadcast('agent_status', { running: true, status: 'running', agentId: base.agentLabel, cli: 'claude',
                    scope: base.scopeKey, sessionId: base.chatSessionId, traceRunId, ...(worker ? { isEmployee: true } : {}) }, input.audience);
                return dispose;
            } catch (error) { dispose(); throw error; }
        }, event,
        settle: async (lease, outcome, problem) => {
            ctx.stallWatchdog?.stop(); ctx.fullText = outcome.partialText;
            // A session that fails mid-turn — a backgrounded task, a stale owner,
            // a reader fault — settles HERE, not through `failed`, and the shared
            // runner has no Claude-specific reason to offer. `facade.lastError`
            // already names the cause, so hand it to lifecycle instead of letting
            // the turn reach the user as a bare "no response" (#757 follow-up).
            if (problem) ctx.stderrBuf = problem;
            if (outcome.status === 'error') ctx.runtimeDiagnostic = problem || diagnostic();
            if (lease) ctx.sessionId = lease.session.nativeSessionId || null;
            if (worker && lease) { await lease.retire(new Error('Claude worker assignment complete')); cleanupSafe = true; }
            const recordedReason = consumeCapturedKillReason(lease?.child.pid);
            const reason = stopReason || recordedReason;
            const code = outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1;
            finishTools(outcome.status);
            handoffRuntimeOutcome(ctx, outcome);
            try { input.exited?.(code); } catch { console.warn('[runtime:claude] exit observer failed'); }
            // Stop can settle without ever acquiring a SDK session. Its captured
            // fallback must be known before lifecycle publishes the compatibility end.
            ensureFallbackStarted();
            await handleAgentExit({ ...base, ctx, code, killReason: reason, onRuntimeEnd: end, wasKilled: !!reason,
                wasSteer: isLifecycleSteerReason(reason),
                smokeResult: detectSmokeResponse(outcome.finalText ?? '', ctx.toolLog, code, 'claude'), costLine: '',
                childProcess: lease?.child ?? null, resolve: value => { selected ??= value; },
                processQueue: () => { queueRequested = true; } });
            if (finalizeFailed && lease) await lease.retire(new Error('claude_finalizer_failed'));
            return selected ?? resultFor(ctx.runtimeOutcome ?? outcome);
        },
        // A null lease means acquire never returned: the runtime failed to start,
        // which is the class this diagnostic answers (#658).
        failed: (error, lease, outcome) => {
            if (!lease) recordNativeStartFailure('claude', error);
            return failed(outcome);
        },
        finalized: () => {
            finalized = true;
            if (!acquisitionStarted) cleanupSafe = true;
            try { consumeCapturedKillReason(owned?.child.pid); }
            catch { console.warn('[runtime:claude] kill reason cleanup failed'); }
            try {
                try {
                    // A stopped run can finish after its replacement has begun.
                    // Its captured trace owns cleanup even after main-map removal.
                    if (input.liveScope && getLiveRun(input.liveScope).traceRunId === traceRunId) {
                        clearLiveRun(input.liveScope);
                        broadcast('agent_status', { running: false, agentId: base.agentLabel, cli: 'claude',
                            scope: base.scopeKey, sessionId: base.chatSessionId, traceRunId }, input.audience);
                    }
                } finally { input.finished(owned?.child ?? null, cancel, queueRequested, cleanupSafe); }
            }
            finally { if (!awaitingUnleasedCleanup && (!worker || cleanupSafe)) control.finish(); }
        },
    });
    try { input.starting(cancel); } catch { cancel('claude_starting_attachment_failed'); }
    return { child: null, promise: run.done.catch(error => {
        if (selected) return selected;
        const outcome = ctx.runtimeTerminalAttempted && ctx.runtimeOutcome ? ctx.runtimeOutcome
            : error instanceof NativeRunFailure ? error.outcome : { status: 'error' as const, finalText: null, partialText: ctx.fullText };
        return resultFor(outcome);
    }) };
}
