// Extracted from spawnAgent (src/agent/spawn.ts). Body moved verbatim; the two
// destructuring lines bind the same names the branch read from spawnAgent scope.
import { broadcast } from '../../core/bus.js';
import { insertMessage } from '../../core/db.js';
import { prependRemoteConversationContext } from '../../prompt/conversation-context.js';
import type { RuntimeEvent, RuntimeLivenessIdentity, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import { createTraceId, finalizeTraceRun, stampTraceTool, startTraceRun, updateTraceToolRow } from '../../trace/store.js';
import type { SpawnContext, ToolEntry } from '../../types/agent.js';
import { syncLiveTools } from '../events/helpers.js';
import { handleAgentExit } from '../lifecycle-handler.js';
import { beginLiveRun, clearLiveRun, getLiveRun, setLiveRunTraceId } from '../live-run-state.js';
import { NativeRunFailure, type NativeRunLease, runNativeRuntime } from '../native-runtime-run.js';
import { type CursorAcceptedContext, appendCursorAcceptedInstruction, buildCursorReplacementPrompt } from '../prompt-context.js';
import { acquireCursorRuntime, acquireGrokRuntime } from '../runtime-pool.js';
import { AcpReplacement } from '../runtime/acp/replacement.js';
import { AcpRuntimeSession } from '../runtime/acp/runtime-session.js';
import { recordRuntimeEvent } from '../runtime/events.js';
import { grokMainOptions } from '../runtime/grok-main.js';
import { handoffRuntimeOutcome } from '../runtime/outcome.js';
import { type RuntimeEnd, RuntimeProjection } from '../runtime/projection.js';
import { type MainReplacementResult, replaceAcpMainTurn } from '../runtime/replace-turn.js';
import { clearNativeStartFailure, nativeStartFailure, recordNativeStartFailure } from '../runtime/start-failure.js';
import { isCurrentSessionOwner } from '../session-persistence.js';
import { detectSmokeResponse } from '../smoke-detector.js';
import { type ExitSettler, armExitSettle, captureExitSettler, settleCapturedExit } from './exit-settle.js';
import { isLifecycleExitSettleReason, isLifecycleSteerReason } from './kill-reason.js';
import { FALLBACK_MAX_RETRIES } from './queue.js';
import { stopCauseFromKillReason } from './stop-cause.js';
import { attachWatchdog } from '../watchdog.js';
import type { SpawnBackendHost, SpawnBackendLocals } from './backend-context.js';
import type { SpawnPromiseResult, SpawnResult } from './types.js';

export function runNativeAcpBackend(backendLocals: SpawnBackendLocals, backendHost: SpawnBackendHost): SpawnResult {
    const { agentLabel, cfg, chatSessionId, cli, currentBucket, detected, effectiveLiveScope, effectiveProvider, effort, empSid, forceNew, isResume, liveScope, mainManaged, mainRun, opts, origin, ownerGeneration, parentLiveScopeForChild, permissions, persistenceOwner, prompt, promptForArgs, promptForSnapshot, resolve, resolvedAgyPrintTimeoutMs, resultPromise, resumeKey, resumeSessionId, runPin, runtimeModel, runtimeTransport, scopeKey, slackToolGrant, spawnCwd, spawnEnv, sysPrompt, traceAudience } = backendLocals;
    const { activeMainProcesses, activeProcesses, consumeKillReason, processQueue, queueCtrl, releaseMainRun } = backendHost;
    const grok = cli === 'grok';
    const acquireRuntime = grok ? acquireGrokRuntime : acquireCursorRuntime;
    const capturedRun = mainRun!;
    const nativeCwd = spawnCwd || process.cwd();
    let traceRunId: string;
    try { traceRunId = startTraceRun({ cli, model: runtimeModel, workingDir: nativeCwd, agentLabel, audience: traceAudience, sessionId: chatSessionId, scopeKey }); }
    catch { traceRunId = createTraceId(); console.warn(`[runtime:${cli}] trace creation unavailable`); }
    const identity = Object.freeze({ runId: traceRunId, sessionId: chatSessionId, scope: scopeKey,
        turnId: traceRunId, audience: traceAudience,
        ...(opts.runtimeParentItemId ? { parentItemId: opts.runtimeParentItemId } : {}) });
    const ctx: SpawnContext = { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(),
        hasClaudeStreamEvents: false, sessionId: null, cost: null, turns: null, duration: null, tokens: null,
        stderrBuf: '', runStartedAt: Date.now(), origin,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        liveScope: effectiveLiveScope, parentLiveScope: parentLiveScopeForChild, traceRunId, traceAudience };
    const toolMirror = new Map<string, ToolEntry>();
    const mirrorLimit = 160;
    let facade: AcpRuntimeSession | null = null, ownedLease: NativeRunLease | null = null;
    let failedStart: RuntimeProjection | null = null;
    let nativeStarted = false, runtimeEnded = false, finalizeFailed = false, finalized = false;
    let stopReason: string | null = null, queueRequested = false;
    let capturedExit: ExitSettler | undefined;
    let selectedResult: SpawnPromiseResult | undefined;
    const ownsRun = () => !finalized && activeMainProcesses.get(scopeKey) === capturedRun
        && isCurrentSessionOwner(persistenceOwner, scopeKey);
    const cursorTarget = opts.target ? { ...opts.target } : undefined;
    let acceptedContext: CursorAcceptedContext = { messages: [], omitted: false };
    const prepareReplacement = (instruction: string, partialText: string) => {
        if (!ownsRun()) throw new Error('cursor_acp_owner_lost');
        return { text: buildCursorReplacementPrompt({
            instruction: prependRemoteConversationContext(instruction, cursorTarget),
            originalRequest: promptForSnapshot, accepted: acceptedContext, partialText, sysPrompt,
        }) };
    };
    const cursorReplaceHook = (instruction: string, commitInput: () => void): Promise<MainReplacementResult> =>
        replaceAcpMainTurn(facade, instruction, () => {
            if (!ownsRun()) throw new Error('cursor_acp_owner_lost');
            const next = appendCursorAcceptedInstruction(acceptedContext, instruction);
            const result: unknown = commitInput();
            if (result !== null && (typeof result === 'object' || typeof result === 'function')
                && typeof (result as { then?: unknown }).then === 'function') {
                void Promise.resolve(result).catch(() => undefined);
                throw new Error('cursor_acp_async_input_commit');
            }
            acceptedContext = next;
        });
    const resultFor = (outcome: RuntimeTurnOutcome): SpawnPromiseResult => ({
        text: outcome.finalText?.trim() ?? '', code: outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1,
        runtimeOutcome: outcome, traceRunId,
    });
    // A runtime that never acquired a lease has no facade to ask, so the
    // substring heuristic below could only ever produce the generic sentence
    // for exactly the failures that need naming. The recorded start code is
    // provider-independent by construction, so it decides the wording and is
    // shown alongside it (#658).
    const diagnostic = () => {
        const code = nativeStarted ? undefined : nativeStartFailure(cli)?.code;
        const named = code ? ` (${code})` : '';
        if (grok) return `Grok native runtime failed.${named} Check the native model, effort and existing CLI login.`;
        const configFault = code ? code.startsWith('acp_config_') : facade?.lastError?.includes('config');
        return configFault
            ? `Cursor native model or effort is unsupported.${named} Choose an advertised model/effort; Composer models may require an unset effort.`
            : `Cursor native runtime failed.${named} Check the native model, effort and existing CLI login.`;
    };
    const startFailedRuntime = () => {
        if (!failedStart) {
            failedStart = new RuntimeProjection(identity);
            failedStart.start(cli);
        }
        return failedStart;
    };
    const closeFailedTrace = (outcome: RuntimeTurnOutcome) => {
        try {
            finalizeTraceRun(traceRunId, outcome.status === 'stopped' ? 'interrupted' : outcome.status,
                outcome.status === 'error' ? diagnostic() : null, { onlyIfRunning: true });
        } catch { console.warn(`[runtime:${cli}] failure trace finalization unavailable`); }
    };
    const endRuntime = (end: RuntimeEnd) => {
        if (runtimeEnded) return;
        runtimeEnded = true;
        if (facade?.claimTurnOutcome(traceRunId)) {
            if (!facade.finalizeTurn(traceRunId, end)) finalizeFailed = true;
        } else if (!nativeStarted) {
            startFailedRuntime().close(end);
        } else {
            finalizeFailed = true;
            console.warn(`[runtime:${cli}] missing owned finalizer`);
        }
    };
    const failRuntime = (outcome: RuntimeTurnOutcome): SpawnPromiseResult => {
        ctx.stallWatchdog?.stop();
        const selected = ctx.runtimeTerminalAttempted && ctx.runtimeOutcome ? ctx.runtimeOutcome : {
            status: stopReason || ctx.stallReason ? 'stopped' as const : 'error' as const,
            finalText: null, partialText: outcome.partialText,
        };
        const stopCause = selected.status === 'stopped' ? stopCauseFromKillReason(stopReason) : undefined;
        handoffRuntimeOutcome(ctx, selected);
        try {
            // Admit the captured run before compatibility consumers retire it.
            if (!nativeStarted && !runtimeEnded) startFailedRuntime();
            if (!ctx.runtimeTerminalAttempted) {
                ctx.runtimeTerminalAttempted = true;
                broadcast('agent_done', { ...runPin, traceRunId, cli,
                    text: selected.status === 'stopped' ? '' : `❌ ${diagnostic()}`, error: true,
                    runtimeStatus: selected.status, runtimeFinality: selected.finalText === null ? 'absent' : 'present',
                    ...(stopCause ? { stopCause } : {}),
                }, traceAudience);
            }
        } finally {
            try {
                endRuntime({ kind: 'turn-end', status: selected.status, finalText: selected.finalText,
                    ...(selected.status === 'error' ? { error: diagnostic() } : {}) });
            } finally { closeFailedTrace(selected); }
        }
        return selectedResult ?? { ...resultFor(selected), ...(stopCause ? { stopCause } : {}) };
    };
    let nativeRun!: ReturnType<typeof runNativeRuntime<SpawnPromiseResult>>;
    const cancelHook = (reason: string) => {
        stopReason ??= reason;
        if (isLifecycleExitSettleReason(reason)) {
            armExitSettle(scopeKey);
            capturedExit ??= captureExitSettler(scopeKey);
        }
        nativeRun.cancel(reason);
    };
    const grokReplaceHook = async (text: string, commitInput: () => void): Promise<MainReplacementResult> => {
        if (!ownsRun()) return { kind: 'race', reason: 'native-owner-lost' };
        const result = await replaceAcpMainTurn(facade, text, commitInput);
        return result.kind === 'unavailable' && !ownsRun() ? { kind: 'race', reason: 'native-owner-lost' } : result;
    };
    const replaceHook = grok ? grokReplaceHook : cursorReplaceHook;
    if (grok) capturedRun.replaceTurn = replaceHook;
    capturedRun.starting = true;
    nativeRun = runNativeRuntime<SpawnPromiseResult>({
        turnId: traceRunId, prompt: { text: promptForArgs }, isCurrent: ownsRun,
        acquire: async signal => {
            const lease = await acquireRuntime({
                key: { scopeKey, cwd: nativeCwd, model: runtimeModel === 'default' ? '' : runtimeModel, effort, permissions },
                binary: detected.path || (grok ? 'grok' : 'cursor-agent'), env: spawnEnv, promptTimeoutMs: resolvedAgyPrintTimeoutMs,
                persistenceOwner, isCurrentOwner: token => isCurrentSessionOwner(token, scopeKey), canAcquire: ownsRun,
                storedSessionId: resumeSessionId,
                forceNew: forceNew || Boolean(slackToolGrant),
                ...(slackToolGrant ? { lifetime: 'request' as const } : {}),
                signal,
            });
            facade = new AcpRuntimeSession(lease.session, { provider: cli, deferTurnEnd: true,
                ...(grok ? grokMainOptions : { createReplacement: io => new AcpReplacement(io), prepareReplacement }),
                getTurnContext: () => ({ ...identity, isCurrent: ownsRun }),
                capabilities: { transport: 'native', steer: 'cancel-reprompt', resume: lease.session.agentCapabilities['loadSession'] === true,
                    tools: true, toolOutput: true, approvals: true, questions: false, images: false, subagents: false },
                record: (context, body) => {
                    if (body.kind === 'turn-start') nativeStarted = true;
                    return recordRuntimeEvent(context, body);
                },
            });
            ownedLease = { child: lease.session.child, session: facade,
                release: () => lease.release(), retire: reason => lease.retire(reason) };
            return ownedLease;
        },
        ready: lease => {
            if (!ownsRun()) throw new Error('native_run_owner_lost');
            capturedRun.process = lease.child;
            // This start reached its lease, so the previous start failure is spent.
            clearNativeStartFailure(cli);
            if (!opts._skipInsert) insertMessage.run('user', prompt, cli, runtimeModel, nativeCwd, chatSessionId);
            capturedRun.starting = false;
            ctx.sessionId = lease.session.nativeSessionId || null;
            if (capturedRun.cancelPending === cancelHook) delete capturedRun.cancelPending;
            capturedRun.cancelTurn = cancelHook;
            capturedRun.replaceTurn = replaceHook;
            beginLiveRun(liveScope, cli); setLiveRunTraceId(liveScope, traceRunId);
            const activityIdentity: RuntimeLivenessIdentity = { runId: traceRunId, sessionId: chatSessionId,
                scope: scopeKey, origin, ...(opts.requestId ? { requestId: opts.requestId } : {}) };
            const onIo = () => {
                if (!ownsRun()) return;
                try { opts.lifecycle?.onActivity?.('native-runtime', activityIdentity); }
                catch { console.warn(`[runtime:${cli}] liveness observer failed`); }
            };
            const dispose = () => {
                ctx.stallWatchdog?.stop();
                if (capturedRun.replaceTurn === replaceHook) delete capturedRun.replaceTurn;
                lease.child.stdout?.off('data', onIo); lease.child.stderr?.off('data', onIo);
            };
            try {
                lease.child.stdout?.on('data', onIo); lease.child.stderr?.on('data', onIo);
                ctx.stallWatchdog = attachWatchdog(lease.child, agentLabel, reason => {
                    ctx.stallReason = reason; nativeRun.cancel(reason);
                });
                broadcast('agent_status', { running: true, status: 'running', agentId: agentLabel, cli,
                    scope: scopeKey, sessionId: chatSessionId, traceRunId,
                    ...(opts.requestId ? { requestId: opts.requestId } : {}) }, traceAudience);
                return dispose;
            } catch (error) { dispose(); throw error; }
        },
        event: (event: RuntimeEvent) => {
            if (event.kind === 'usage') {
                ctx.tokens = { ...(event.inputTokens === undefined ? {} : { input_tokens: event.inputTokens }),
                    ...(event.outputTokens === undefined ? {} : { output_tokens: event.outputTokens }),
                    ...(event.cachedTokens === undefined ? {} : { cached_input_tokens: event.cachedTokens }) };
            }
            if (event.kind !== 'tool') return;
            let tool = toolMirror.get(event.itemId);
            if (!tool && toolMirror.size >= mirrorLimit) return;
            const detail = [event.input, event.output, event.detail].filter(value => value !== undefined && value !== '').join('\n');
            if (!tool) {
                tool = { icon: '🔧', label: event.name, toolType: 'tool', status: event.status, detail,
                    stepRef: `runtime:${traceRunId}:${event.itemId}` };
                stampTraceTool(tool, ctx, 'tool'); toolMirror.set(event.itemId, tool);
            } else {
                Object.assign(tool, { label: event.name, status: event.status, detail }); updateTraceToolRow(tool);
            }
            ctx.toolLog = [...toolMirror.values()]; syncLiveTools(ctx);
        },
        settle: async (lease, outcome, problem) => {
            // Immediate Stop can settle without entering acquire/ready/send.
            if (!nativeStarted && !runtimeEnded) startFailedRuntime();
            ctx.stallWatchdog?.stop(); ctx.fullText = outcome.partialText;
            if (problem) ctx.stderrBuf = problem;
            if (lease) ctx.sessionId = lease.session.nativeSessionId || null;
            const recordedReason = consumeKillReason(lease?.child.pid);
            const killReason = stopReason || recordedReason;
            const wasKilled = Boolean(killReason), wasSteer = isLifecycleSteerReason(killReason);
            const code = outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1;
            handoffRuntimeOutcome(ctx, outcome);
            try { opts.lifecycle?.onExit?.(code); } catch { console.warn(`[runtime:${cli}] exit observer failed`); }
            await handleAgentExit({ onRuntimeEnd: endRuntime,
                ctx, code, cli, model: runtimeModel, effectiveProvider, agentLabel, mainManaged, origin,
                killReason,
                resumeKey, prompt, opts, cfg: { ...cfg, effort }, ownerGeneration, persistenceOwner, forceNew, empSid,
                isResume, wasKilled, wasSteer, smokeResult: detectSmokeResponse(outcome.finalText ?? '', ctx.toolLog, code, cli),
                effortDefault: effort, costLine: '', resolve: value => { selectedResult ??= value; },
                activeProcesses, scopeKey, runtimeTransport, scopedBucket: currentBucket, chatSessionId,
                childProcess: lease?.child ?? null, releaseMainRun,
                retryState: queueCtrl.retryStateForScope(scopeKey), fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                fallbackMaxRetries: FALLBACK_MAX_RETRIES, processQueue: () => { queueRequested = true; },
            });
            if (finalizeFailed && lease) await lease.retire(new Error('native_runtime_finalization_failed'));
            return selectedResult ?? resultFor(ctx.runtimeOutcome ?? outcome);
        },
        failed: (error, lease, outcome) => {
            // A null lease means acquire never returned: the runtime failed to
            // start, which is the only class this diagnostic answers (#658).
            // Teardown faults after a claimed answer are a different failure.
            if (!lease) recordNativeStartFailure(cli, error);
            return failRuntime(outcome);
        },
        finalized: () => {
            finalized = true;
            try {
                if (capturedRun.cancelPending === cancelHook) delete capturedRun.cancelPending;
                if (capturedRun.cancelTurn === cancelHook) delete capturedRun.cancelTurn;
                if (capturedRun.replaceTurn === replaceHook) delete capturedRun.replaceTurn;
                if (activeMainProcesses.get(scopeKey) === capturedRun) {
                    const child = ownedLease?.child ?? null;
                    if (releaseMainRun(scopeKey, child, ownerGeneration)) {
                        if (getLiveRun(liveScope).traceRunId === traceRunId) clearLiveRun(liveScope);
                        broadcast('agent_status', { running: false, agentId: agentLabel, cli, scope: scopeKey,
                            sessionId: chatSessionId, traceRunId }, traceAudience);
                    }
                }
            } finally {
                // Projection/listener/cleanup failure must not leave our durable
                // row running or rewrite a lifecycle that already selected a result.
                if (ctx.runtimeOutcome) closeFailedTrace(ctx.runtimeOutcome);
                settleCapturedExit(scopeKey, capturedExit);
                // Exceptional settlement can release the slot before lifecycle requests its normal wake.
                if (queueRequested || !activeMainProcesses.has(scopeKey)) void processQueue(scopeKey);
            }
        },
    });
    capturedRun.cancelPending = cancelHook;
    let resolved = false;
    const resolveOnce = (value: SpawnPromiseResult) => { if (!resolved) { resolved = true; resolve!(value); } };
    nativeRun.done.then(resolveOnce, error => {
        const prior = ctx.runtimeTerminalAttempted && ctx.runtimeOutcome ? ctx.runtimeOutcome
            : error instanceof NativeRunFailure ? { ...error.outcome,
                status: stopReason || ctx.stallReason || error.outcome.status === 'stopped' ? 'stopped' as const : 'error' as const, finalText: null }
                : { status: 'error' as const, finalText: null, partialText: ctx.fullText };
        resolveOnce(selectedResult ?? resultFor(prior));
    });
    return { child: null, promise: resultPromise };
}
