import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { SpawnContext } from '../../types/agent.js';
import type { AsideContext } from '../../shared/aside-contract.js';
import { readAsideCatalog, resolveAsideSelection, AsideCatalogError } from '../aside-catalog.js';
import { startAsideRun, type AsideRunResult } from '../aside-runtime.js';
import { broadcast } from '../../core/bus.js';
import { getSessionBucket, clearSessionBucket, insertMessage } from '../../core/db.js';
import { consumePendingBootstrapPrompt } from '../../core/main-session.js';
import { stripSkillMentionBlock } from '../../core/skill-mentions.js';
import { startTraceRun } from '../../trace/store.js';
import { resolveScopedSessionBucket } from '../args.js';
import { buildAsideResumeKey } from '../spawn-env.js';
import { buildPromptForArgs, PROMPT_HISTORY_MAX_CHARS, PROMPT_HISTORY_MAX_ROWS } from '../prompt-context.js';
import { shouldResumeBucketSession } from './resume.js';
import { beginLiveRun, setLiveRunTraceId } from '../live-run-state.js';
import { isCurrentSessionOwner } from '../session-persistence.js';
import { handleAgentExit } from '../lifecycle-handler.js';
import { handoffRuntimeOutcome } from '../runtime/outcome.js';
import { createPrintActivity, finishPrintActivity } from '../runtime/print-activity.js';
import { captureExitSettler, settleCapturedExit, type ExitSettler } from './exit-settle.js';
import { isLifecycleSteerReason } from './kill-reason.js';
import { FALLBACK_MAX_RETRIES } from './queue.js';
import { settleOnce } from '../../orchestrator/request-registry.js';
import type { SpawnBackendHost, SpawnBackendLocals } from './backend-context.js';
import type { SpawnResult } from './types.js';

/** Admission is deliberately before bootstrap, isolation, generic argv or NDJSON. */
export function asideAdmissionError(mainManaged: boolean, opts: SpawnBackendLocals['opts'], policy: unknown, origin?: SpawnBackendLocals['origin']): string | null {
    if (!mainManaged || opts.agentId || opts.employeeSessionId || opts.internal || opts.forceNew) return 'aside_main_only';
    if (origin === 'heartbeat') return 'aside_scheduled_unsupported';
    if (opts._isFallback || opts._retryAttempt !== undefined || opts._isSmokeContinuation || opts._isGoalContinuation
        || opts._isCapacityFallback || opts._employeeFreshSessionRetry) return 'aside_automatic_retry_unsupported';
    if (opts.images?.length) return 'aside_images_unsupported';
    if (policy !== 'auto' && policy !== 'safe') return 'aside_policy_unsupported';
    return null;
}

type AsideLocals = Pick<SpawnBackendLocals, 'mainRun' | 'scopeKey' | 'chatSessionId' | 'opts' | 'origin'
    | 'ownerGeneration' | 'persistenceOwner' | 'runPin' | 'prompt' | 'resolve' | 'resultPromise'
    | 'spawnCwd' | 'spawnEnv' | 'sysPrompt' | 'model' | 'effort'> & { context: AsideContext; policy: 'auto' | 'safe'; binary: string };
type AsideHost = Pick<SpawnBackendHost, 'activeMainProcesses' | 'activeProcesses' | 'buildHistoryBlock'
    | 'releaseMainRun' | 'queueCtrl' | 'processQueue' | 'consumeKillReason'>;

/** Dedicated CLI backend; the runtime, rather than a process exit event, selects finality. */
export function runAsideBackend(locals: AsideLocals, host: AsideHost): SpawnResult {
    const { mainRun: run, scopeKey, chatSessionId, ownerGeneration, persistenceOwner, origin, runPin } = locals;
    if (!run) throw new Error('aside_main_owner_required');
    // Every execution selector is copied before the catalog's first await.
    const context = { ...locals.context };
    const cwd = locals.spawnCwd || process.cwd();
    const policy = locals.policy;
    const opts = { ...locals.opts };
    const env = { ...locals.spawnEnv };
    const model = locals.model || 'default', effort = locals.effort || 'default';
    const sysPrompt = locals.sysPrompt;
    const originalPrompt = locals.prompt;
    const owned = () => host.activeMainProcesses.get(scopeKey) === run
        && run.ownerGeneration === ownerGeneration && isCurrentSessionOwner(persistenceOwner, scopeKey);
    let child: ChildProcess | null = null;
    let childClosed = true;
    let handle: ReturnType<typeof startAsideRun> | undefined;
    let cancelled = false, reason: string | null = null, sealed = false;
    let uncertain = false;
    let exitArm: ExitSettler | undefined;
    const cancel = (cause: string) => {
        if (sealed || cancelled) return;
        cancelled = true; reason = cause;
        exitArm = captureExitSettler(scopeKey);
        // Runtime cancellation latches synchronously, including before its session receipt.
        if (handle) void handle.cancel().catch(() => {});
    };
    run.starting = true;
    run.cancelTurn = cancel;
    void (async () => {
        let ctx: SpawnContext | undefined;
        let bucket = '', resumeKey: string | null = null, selectedModel = model, selectedEffort = '';
        let isResume = false;
        let result: AsideRunResult;
        try {
            const catalog = await readAsideCatalog(context);
            const selection = resolveAsideSelection(catalog, model, effort);
            selectedModel = selection.model; selectedEffort = selection.effort || '';
            resumeKey = buildAsideResumeKey(selection, cwd, policy);
            bucket = resolveScopedSessionBucket('aside', selectedModel, 'aside', scopeKey, selectedEffort, 'fallback', false);
            const row = getSessionBucket.get(bucket) as { session_id?: string; model?: string; resume_key?: string } | undefined;
            isResume = !opts._skipResume && !!row?.session_id
                && shouldResumeBucketSession('aside', selectedModel, row.model, resumeKey, row.resume_key);
            if (!owned() || !isCurrentSessionOwner(persistenceOwner, scopeKey)) cancelled = true;
            if (cancelled) {
                result = { status: 'stopped', finalText: null, partialText: '', sessionId: null, reusable: false, exitCode: null, cleanup: 'confirmed' };
            } else {
                run.meta.model = selectedModel; run.meta.effectiveProvider = 'aside';
                const bootstrap = isResume ? '' : consumePendingBootstrapPrompt(scopeKey);
                const prompt = bootstrap ? `${bootstrap}\n\n---\n\n${originalPrompt}` : originalPrompt;
                const history = !isResume && !opts._skipHistory
                    ? host.buildHistoryBlock(originalPrompt, cwd, chatSessionId, PROMPT_HISTORY_MAX_ROWS, PROMPT_HISTORY_MAX_CHARS) : '';
                const fullPrompt = buildPromptForArgs({ cli: 'aside', effectiveProvider: 'aside', prompt:
                    `[Workspace Context]\nProject root: ${cwd}\n${opts.workspaceContext || ''}\n\n${prompt}`,
                    historyBlock: history, sysPrompt, isResume });
                if (!opts._skipInsert) insertMessage.run('user', stripSkillMentionBlock(originalPrompt), 'aside', selectedModel, cwd, chatSessionId);
                // Journal failure cannot change execution or select an empty/error final.
                let traceRunId = `tr_aside_${randomUUID()}`;
                try { traceRunId = startTraceRun({ cli: 'aside', model: selectedModel, workingDir: cwd,
                    agentLabel: 'main', audience: 'public', sessionId: chatSessionId, scopeKey }); }
                catch { console.warn('[aside] trace admission unavailable'); }
                try { beginLiveRun(scopeKey, 'aside'); setLiveRunTraceId(scopeKey, traceRunId); }
                catch { console.warn('[aside] live projection unavailable'); }
                const capturedCtx: SpawnContext = { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(),
                    hasClaudeStreamEvents: false, sessionId: null, stderrBuf: '',
                    cost: null, turns: null, duration: null, tokens: null, runStartedAt: Date.now(),
                    liveScope: scopeKey, traceRunId, traceAudience: 'public', origin,
                    activityIdentity: { sessionId: chatSessionId, scope: scopeKey },
                    ...(opts.requestId ? { requestId: opts.requestId } : {}) };
                ctx = capturedCtx;
                try { capturedCtx.printActivity = createPrintActivity({ runId: traceRunId, sessionId: chatSessionId,
                    scope: scopeKey, turnId: traceRunId, audience: 'public' }, 'aside'); }
                catch { console.warn('[aside] Activity projection unavailable'); }
                try { broadcast('agent_status', { running: true, cli: 'aside', agentId: 'main', scope: scopeKey }); }
                catch { console.warn('[aside] status observer failed'); }
                handle = startAsideRun({ binary: locals.binary, cwd, env,
                    selection, permission: policy === 'safe' ? 'guard' : 'full-access', prompt: fullPrompt,
                    ...(isResume && row?.session_id ? { sessionId: row.session_id } : {}) }, {
                    onChild(proc) {
                        if (sealed) return;
                        child = proc; childClosed = false;
                        proc.once('close', () => { childClosed = true; host.consumeKillReason(proc.pid); });
                        if (owned()) { run.process = proc; run.starting = false; }
                    },
                    onSession(id) { if (!sealed) capturedCtx.sessionId = id; },
                    onOutput(text) {
                        if (sealed) return;
                        // CLI output is bounded diagnostics, never an assistant final or tool proof.
                        capturedCtx.stderrBuf = (capturedCtx.stderrBuf + text).slice(-4000);
                        try { opts.lifecycle?.onActivity?.('aside'); } catch { /* observer only */ }
                    },
                });
                if (cancelled) void handle.cancel().catch(() => {});
                result = await handle.result;
            }
        } catch (error) {
            // A rejected run promise has supplied no physical-close proof.
            uncertain = handle !== undefined;
            result = { status: cancelled ? 'stopped' : 'error', finalText: null, partialText: '',
                sessionId: null, reusable: false, exitCode: null, cleanup: handle ? 'uncertain' : 'confirmed',
                diagnostic: error instanceof AsideCatalogError ? error.message : 'Aside runtime preparation failed.' };
        }
        sealed = true;
        uncertain = result.cleanup === 'uncertain';
        if (uncertain && owned()) {
            run.starting = true;
            const acknowledgementToken = randomUUID();
            const recovery = 'aside_control_uncertain: reconcile the captured session in Aside, then POST /api/orchestrate/aside/reconcile with sessionId, acknowledgementToken and acknowledged:true. All captured local commands must close. Send fresh input afterward.';
            result = { ...result, diagnostic: `${result.diagnostic || 'Aside cleanup is unresolved.'} Jaw chat ID: ${chatSessionId}. External Aside ID: ${result.sessionId || 'unavailable'} (account ${context.account}, local). Acknowledgement token: ${acknowledgementToken}. ${recovery}` };
            // Repeated Stop closes captured commands without repeating external control.
            run.cancelTurn = () => {
                if (owned() && handle) void handle.closeCommands().catch(() => {});
            };
            run.reconcileAside = token => {
                if (token !== acknowledgementToken || !owned() || !childClosed || (handle && !handle.commandsClosed())) return false;
                host.queueCtrl.purgeQueueOnStop(scopeKey, 'aside-manual-reconciliation');
                delete run.cancelTurn;
                delete run.reconcileAside;
                return host.releaseMainRun(scopeKey, child, ownerGeneration);
            };
        }
        try { opts.lifecycle?.onExit?.(result.exitCode); } catch { /* observer only */ }
        if (!owned()) {
            // A captured terminal still settles its caller, but cannot mutate a newer
            // session's MESSAGE history, flush counters, goal or queue via lifecycle.
            const outcome = cancelled ? { ...result, status: 'stopped' as const, finalText: null } : result;
            if (ctx) {
                handoffRuntimeOutcome(ctx, outcome);
                finishPrintActivity(ctx, { kind: 'turn-end', status: outcome.status, finalText: outcome.finalText });
            }
            settleOnce(opts.requestId, outcome.status === 'done' ? 'completed' : outcome.status === 'stopped' ? 'cancelled' : 'failed', {
                text: outcome.finalText ?? '', scope: scopeKey, sessionId: chatSessionId,
                runtimeStatus: outcome.status, runtimeFinality: outcome.finalText === null ? 'absent' : 'present' });
            locals.resolve({ text: outcome.finalText ?? '',
                code: outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1,
                runtimeOutcome: outcome, ...(ctx?.traceRunId ? { traceRunId: ctx.traceRunId } : {}) });
            if (run.cancelTurn === cancel) delete run.cancelTurn;
            settleCapturedExit(scopeKey, exitArm);
            return;
        }
        if (!ctx) {
            if (!uncertain && owned()) host.releaseMainRun(scopeKey, child, ownerGeneration);
            const text = result.status === 'error' ? result.diagnostic || 'Aside unavailable.' : '';
            settleOnce(opts.requestId, result.status === 'stopped' ? 'cancelled' : 'failed', {
                text, scope: scopeKey, sessionId: chatSessionId });
            broadcast('agent_done', { ...runPin, cli: 'aside', text, error: result.status === 'error', runtimeStatus: result.status });
            locals.resolve({ text, code: result.status === 'stopped' ? 130 : 78,
                runtimeOutcome: result, executionInterrupted: result.status === 'stopped', executionFailed: result.status === 'error' });
            if (run.cancelTurn === cancel && !uncertain) delete run.cancelTurn;
            if (!cancelled && !uncertain) void host.processQueue(scopeKey);
            settleCapturedExit(scopeKey, exitArm);
            return;
        }
        // Failed/stopped sessions must not survive in their captured resumable bucket.
        if ((cancelled || !result.reusable || uncertain) && owned() && isCurrentSessionOwner(persistenceOwner, scopeKey)) {
            try { clearSessionBucket.run(bucket); } catch { console.warn('[aside] resumable bucket clear failed'); }
        }
        ctx.sessionId = !uncertain && !cancelled && result.reusable && result.status === 'done' ? result.sessionId : null;
        ctx.metadata = { ...ctx.metadata, asideCleanup: result.cleanup };
        if (result.diagnostic !== undefined) ctx.runtimeDiagnostic = result.diagnostic;
        handoffRuntimeOutcome(ctx, cancelled ? { status: 'stopped', finalText: null, partialText: result.partialText } : result);
        const capturedRun = run;
        try {
            await handleAgentExit({ ctx, code: result.exitCode, cli: 'aside', model: selectedModel, effectiveProvider: 'aside',
                resumeKey, workingDir: cwd, permissions: policy, agentLabel: 'main', mainManaged: true, origin, prompt: originalPrompt,
                opts: { ...opts, _skipSessionPersist: opts._skipSessionPersist === true || !owned() || !result.reusable || cancelled || uncertain },
                cfg: { effort: selectedEffort }, ownerGeneration, persistenceOwner, forceNew: false, empSid: null,
                isResume, wasKilled: cancelled, wasSteer: isLifecycleSteerReason(reason), killReason: reason,
                childExitCode: result.exitCode,
                smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
                effortDefault: '', costLine: '', resolve: locals.resolve, activeProcesses: host.activeProcesses,
                scopeKey, chatSessionId, scopedBucket: bucket, runtimeTransport: 'print', childProcess: child,
                releaseMainRun: (scope, proc, generation) => !uncertain && owned() && host.releaseMainRun(scope, proc, generation),
                retryState: host.queueCtrl.retryStateForScope(scopeKey), fallbackState: host.queueCtrl.fallbackStateForScope(scopeKey),
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue: scope => { if (!cancelled && !uncertain) void host.processQueue(scope); },
                onRuntimeEnd: end => ctx?.printActivity?.finish(end) });
        } catch {
            // Lifecycle/projection failures cannot replace the runtime's selected terminal.
            const outcome = ctx.runtimeOutcome!;
            finishPrintActivity(ctx, { kind: 'turn-end', status: outcome.status, finalText: outcome.finalText });
            if (!ctx.runtimeTerminalAttempted) {
                ctx.runtimeTerminalAttempted = true;
                try { broadcast('agent_done', { ...runPin, cli: 'aside', runtimeStatus: outcome.status,
                    runtimeFinality: outcome.finalText === null ? 'absent' : 'present',
                    text: outcome.finalText ?? '', error: outcome.status === 'error' }); } catch { /* observer only */ }
            }
            locals.resolve({ text: outcome.finalText ?? '',
                code: outcome.status === 'done' ? 0 : outcome.status === 'stopped' ? 130 : 1,
                runtimeOutcome: outcome, ...(ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {}) });
        } finally {
            if (!uncertain) {
                if (capturedRun.cancelTurn === cancel) delete capturedRun.cancelTurn;
                if (owned()) host.releaseMainRun(scopeKey, child, ownerGeneration);
            }
            settleCapturedExit(scopeKey, exitArm);
        }
    })();
    return { child: null, promise: locals.resultPromise };
}
