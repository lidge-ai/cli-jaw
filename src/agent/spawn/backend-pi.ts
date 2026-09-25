// Extracted from spawnAgent (src/agent/spawn.ts). Body moved verbatim; the two
// destructuring lines bind the same names the branch read from spawnAgent scope.
import { broadcast } from '../../core/bus.js';
import { settings } from '../../core/config.js';
import { insertMessage } from '../../core/db.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { userErrorText } from '../../messaging/redact.js';
import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import { appendTraceEvent, finalizeTraceRun, stampTraceTool, startTraceRun } from '../../trace/store.js';
import type { SpawnContext, ToolEntry } from '../../types/agent.js';
import { appendBoundedFullText } from '../events/fulltext-bound.js';
import { emitAgentTool, normalizeAssistantDisplayText } from '../events/helpers.js';
import { handleAgentExit } from '../lifecycle-handler.js';
import { beginLiveRun, clearLiveRun, getLiveRun, replaceLiveRunTools, setLiveRunTraceId } from '../live-run-state.js';
import { type PiExecutionCleanupReceipt, bindPiExecutionCancel, normalizePiSettings, openPiRpc } from '../pi-runtime.js';
import { withHistoryPrompt, withSteerContext } from '../prompt-context.js';
import { type PiLease, acquirePiRuntime } from '../runtime-pool.js';
import { handoffRuntimeOutcome } from '../runtime/outcome.js';
import { PiProjection } from '../runtime/pi-projection.js';
import { PiRawTrace } from '../runtime/pi-raw-trace.js';
import { PiRuntimeSession } from '../runtime/pi-runtime-session.js';
import { piFailureOutcome } from '../runtime/pi-turn.js';
import { RuntimeProjection } from '../runtime/projection.js';
import { isCurrentSessionOwner } from '../session-persistence.js';
import { detectSmokeResponse } from '../smoke-detector.js';
import { captureExitSettler, settleCapturedExit } from './exit-settle.js';
import { isLifecycleExitSettleReason, isLifecycleSteerReason } from './kill-reason.js';
import { ownProcess } from './process-kill.js';
import { FALLBACK_MAX_RETRIES } from './queue.js';
import { sliceWithoutSplittingSurrogate } from '../stream-text.js';
import { attachWatchdog } from '../watchdog.js';
import type { ChildProcess } from 'child_process';
import crypto from 'node:crypto';
import type { SpawnBackendHost, SpawnBackendLocals } from './backend-context.js';
import type { SpawnPromiseResult, SpawnResult } from './types.js';
import { stripSkillMentionBlock } from '../../core/skill-mentions.js';

export function runPiBackend(backendLocals: SpawnBackendLocals, backendHost: SpawnBackendHost): SpawnResult {
    const { agentLabel, bucketSessionId, cfg, chatSessionId, cleanupPiEmployee, cli, currentBucket, effectiveLiveScope, effort, empSid, empTag, forceNew, historyBlock, isResume, liveScope, mainManaged, mainRun, opts, origin, ownerGeneration, parentLiveScopeForChild, persistenceOwner, prompt, resolve, resultPromise, resumeKey, runPin, runtimeModel, runtimeTransport, scopeKey, slackToolGrant, spawnCwd, spawnEnv, sysPrompt, traceAudience } = backendLocals;
    const { STDERR_BUF_CAP, activeMainProcesses, activeProcesses, appendParentLiveRunTool, broadcastAgentOutput, cancelOwnedPiProcess, clearMainLiveRunOnStop, consumeKillReason, piProfileFingerprintKey, processQueue, queueCtrl, registerActiveProcess, releaseMainRun, stoppedBeforeStart } = backendHost;
    let piExit = captureExitSettler(scopeKey);
    const settlePiExit = () => { settleCapturedExit(scopeKey, piExit); };
    const pi = normalizePiSettings(settings["pi"]);
    const profileId = cfg.provider || pi.defaultProfileId;
    const profile = pi.profiles.find((entry) => entry.id === profileId) || pi.profiles[0];
    if (!profile) {
        throw new Error('Pi profile is not configured');
    }
    const piSessionId = isResume && bucketSessionId ? bucketSessionId : '';
    console.log(`[jaw:pi] isResume=${isResume}, bucketSessionId=${bucketSessionId || 'none'}, piSessionId=${piSessionId || 'new'}`);
    const piPrompt = withSteerContext(piSessionId ? prompt : withHistoryPrompt(prompt, historyBlock), opts.steerContext);
    const traceRunId = startTraceRun({ cli, model: runtimeModel, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience, sessionId: chatSessionId, scopeKey });
    const ctx: SpawnContext = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        runStartedAt: Date.now(),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...(origin ? { origin } : {}),
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        hasActiveSubAgent: false,
        showReasoning: settings["showReasoning"] === true,
        outputTextStarted: false,
        effectiveProvider: profile.id,
        thinkingBuf: '',
        liveOutputText: '',
        liveScope: effectiveLiveScope,
        parentLiveScope: parentLiveScopeForChild,
        traceRunId,
        traceAudience,
        activityIdentity: { sessionId: chatSessionId, scope: scopeKey },
    };
    const activity = new RuntimeProjection({
        runId: traceRunId, sessionId: chatSessionId, scope: scopeKey,
        turnId: traceRunId, audience: traceAudience,
        ...(opts.runtimeParentItemId ? { parentItemId: opts.runtimeParentItemId } : {}),
    });
    const piProjection = new PiProjection(activity);
    const rawTrace = new PiRawTrace(traceRunId, appendTraceEvent, () => activity.report('persistence'));
    activity.start('pi');
    const onPiRawRecord = (raw: unknown): void => {
        rawTrace.record(raw);
        piProjection.observeRecord(raw);
    };

    function flushPiThinking() {
        if (!ctx.thinkingBuf) return;
        const merged = ctx.thinkingBuf.trim();
        if (merged) {
            const singleLine = merged.replace(/\s+/g, ' ').trim();
            const label = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
            const tool = stripUndefined({ icon: '💭', label, toolType: 'thinking' as const, detail: merged }) as ToolEntry;
            stampTraceTool(tool, ctx, 'thinking');
            ctx.toolLog.push(tool);
            if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
            appendParentLiveRunTool(ctx, tool);
            emitAgentTool(ctx, agentLabel, tool, empTag);
        }
        ctx.thinkingBuf = '';
    }
    const piToolDiscipline = [
        '[Pi Tool Discipline]',
        'Your available tools are strictly lowercase: read, bash, edit, write, grep, find, ls.',
        'Capitalized variants (Read, Bash, Edit, Write, Grep, Find, Ls) do NOT exist and will fail.',
    ].join('\n');
    const piSysPrompt = sysPrompt ? `${sysPrompt}\n\n${piToolDiscipline}` : piToolDiscipline;
    const onPiEvent = (event: import('../pi-runtime.js').PiRuntimeEvent) => {
        piProjection.observe(event);
        try { opts.lifecycle?.onActivity?.('pi-rpc'); }
        catch { console.warn('[jaw:pi] activity observer failed'); }
        if (event.kind === 'thinking') {
            ctx.thinkingBuf = (ctx.thinkingBuf || '') + event.text;
            return;
        }
        if (event.kind === 'text') {
            flushPiThinking();
            const delta = String(event.text || '');
            if (!delta) return;
            {
                // D3: bound fullText — see events/fulltext-bound.ts.
                const bounded = appendBoundedFullText(ctx.fullText, delta);
                ctx.fullText = bounded.text;
                if (bounded.truncated) ctx.fullTextTruncated = true;
            }
            const displayDelta = normalizeAssistantDisplayText(delta);
            if (ctx.liveOutputText !== undefined) {
                // Bound this too: it is promoted into fullText at close.
                const live = appendBoundedFullText(ctx.liveOutputText, displayDelta);
                ctx.liveOutputText = live.text;
                if (live.truncated) ctx.fullTextTruncated = true;
            }
            if (!ctx.outputTextStarted) ctx.outputTextStarted = true;
            broadcastAgentOutput(ctx, agentLabel, cli, displayDelta, empTag, traceAudience);
            return;
        }
        if (event.kind === 'tool') {
            flushPiThinking();
            const tool = stripUndefined({ icon: '🔧', label: event.label, status: event.status, detail: event.detail, toolType: 'tool' as const }) as ToolEntry;
            stampTraceTool(tool, ctx, 'tool');
            ctx.toolLog.push(tool);
            if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
            appendParentLiveRunTool(ctx, tool);
            emitAgentTool(ctx, agentLabel, tool, empTag);
            return;
        }
        if (event.kind === 'session') ctx.sessionId = event.sessionId;
    };
    type PiTurnResult = { text: string; code: number; sessionId?: string | null; runtimeOutcome?: RuntimeTurnOutcome };
    let piFacade: PiRuntimeSession | null = null;
    let piTurnChild: ChildProcess | null = null;
    let piSendStarted = false;
    const piTurnContext = () => ({
        runId: traceRunId, sessionId: chatSessionId, scope: scopeKey,
        turnId: traceRunId, audience: traceAudience,
        isCurrent: () => isCurrentSessionOwner(persistenceOwner, scopeKey)
            && (mainManaged
                ? activeMainProcesses.get(scopeKey) === mainRun
                : piTurnChild !== null && activeProcesses.get(agentLabel) === piTurnChild),
    });
    const appendPiStderr = (stderr: string): void => {
        if (!stderr || ctx.stderrBuf.length >= STDERR_BUF_CAP) return;
        ctx.stderrBuf = sliceWithoutSplittingSurrogate(ctx.stderrBuf + stderr, STDERR_BUF_CAP);
    };
    const onPiFailure = (error: Error, outcome: RuntimeTurnOutcome): void => {
        appendPiStderr(error.message);
        if (outcome.status !== 'error') return;
        const diagnostic = sliceWithoutSplittingSurrogate(userErrorText(error), STDERR_BUF_CAP);
        if (diagnostic.trim() && !ctx.runtimeDiagnostic?.trim()) ctx.runtimeDiagnostic = diagnostic;
    };
    const onPiStderr = (stderr: string): void => appendPiStderr(stderr);
    const mapPiSend = (child: ChildProcess, send: Promise<RuntimeTurnOutcome>): Promise<PiTurnResult> =>
        send.then((outcome): PiTurnResult => ({
            text: outcome.finalText ?? outcome.partialText ?? '',
            code: typeof child.exitCode === 'number' ? child.exitCode
                : outcome.status === 'error' ? 1 : 0,
            sessionId: ctx.sessionId ?? piFacade?.nativeSessionId ?? null,
            runtimeOutcome: outcome,
        }));
    const endPiRuntime = (end: import('../runtime/projection.js').RuntimeEnd) => {
        if (piFacade?.claimTurnOutcome(traceRunId)) {
            if (!piFacade.finalizeTurn(traceRunId, end)) {
                console.warn('[jaw:pi] owned finalizer rejected the terminal');
                activity.close(end);
            }
            return;
        }
        if (piSendStarted) console.warn('[jaw:pi] missing owned finalizer');
        activity.close(end);
    };
    const runPiTurn = (child: ChildProcess, lease: PiLease | null,
        directCleanup: Promise<PiExecutionCleanupReceipt> | null,
        start: () => Promise<PiTurnResult>): void => {
        let leaseCancel: Promise<void> | null = null;
        let cleanupDone = false, queueRequested = false;
        let selectedResult: SpawnPromiseResult | undefined;
        const recordResult = (result: SpawnPromiseResult) => {
            if (selectedResult !== undefined) return;
            selectedResult = result;
            if (cleanupDone) resolve!(result);
        };
        const requestQueue = () => {
            if (cleanupDone) void processQueue(scopeKey);
            else queueRequested = true;
        };
        const requestCancel = (): Promise<void> => {
            if (cleanupDone) return Promise.resolve();
            if (!lease) {
                if (cancelOwnedPiProcess(child)) return Promise.resolve();
                ownProcess(child).terminate('cancel');
                return Promise.resolve();
            }
            leaseCancel ??= lease.cancel();
            return leaseCancel;
        };
        const cancelHook = (reason: string) => {
            if (cleanupDone) return;
            if (isLifecycleExitSettleReason(reason)) piExit = captureExitSettler(scopeKey);
            void requestCancel();
        };
        if (lease && mainRun) mainRun.cancelTurn = cancelHook;
        let piWatchdog: ReturnType<typeof attachWatchdog> | undefined;
        let watchdogStopped = false;
        const stopWatchdog = () => { if (!watchdogStopped) { watchdogStopped = true; piWatchdog?.stop(); } };
        let setupError: unknown;
        try {
            piWatchdog = attachWatchdog(child, agentLabel, (reason) => {
                console.log(`[jaw:watchdog] cancelling ${agentLabel} (pi) — ${reason}`);
                ctx.stallReason = reason;
                void requestCancel();
            });
            ctx.stallWatchdog = piWatchdog;
            if (mainManaged) mainRun!.process = child;
            else registerActiveProcess(agentLabel, child);
            if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, provider: profile.id, ...empTag });
            if (mainManaged && !opts.internal) {
                beginLiveRun(liveScope, cli);
                setLiveRunTraceId(liveScope, traceRunId);
            }
            if (mainManaged && !opts.internal && !opts._skipInsert) {
                insertMessage.run('user', stripSkillMentionBlock(prompt), cli, runtimeModel, settings["workingDir"] || null, chatSessionId);
            }
            if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, provider: profile.id, ...empTag }, traceAudience);
        } catch (error) {
            setupError = error;
            try { void requestCancel().catch(() => { console.warn('[jaw:pi] setup cancellation failed'); }); }
            catch { console.warn('[jaw:pi] setup cancellation failed'); }
        }

        const releaseLease = async (): Promise<void> => {
            try { if (leaseCancel) await leaseCancel; }
            finally {
                if (mainRun?.cancelTurn === cancelHook) delete mainRun.cancelTurn;
                consumeKillReason(child.pid);
                if (lease) lease.release();
                else {
                    let receipt: PiExecutionCleanupReceipt | undefined;
                    try { receipt = await directCleanup ?? undefined; }
                    catch { /* Missing/rejected evidence never authorizes deletion. */ }
                    if (receipt?.cwdDisposition === 'removable') cleanupPiEmployee();
                    else console.warn('[jaw:pi] retaining employee cwd: physical cleanup unconfirmed', spawnCwd);
                }
            }
        };
        const done = start();
        done.then(async (result) => {
            if (setupError !== undefined) throw setupError;
            if (result.runtimeOutcome !== undefined) handoffRuntimeOutcome(ctx, result.runtimeOutcome);
            const killReason = consumeKillReason(child.pid);
            stopWatchdog();
            flushPiThinking();
            if (result.sessionId) ctx.sessionId = result.sessionId;
            if (!ctx.fullText && result.text) ctx.fullText = result.text;
            try { opts.lifecycle?.onExit?.(result.code); }
            catch { console.warn('[jaw:pi] exit observer failed'); }
            const wasKilled = !!killReason;
            const wasSteer = isLifecycleSteerReason(killReason);
            const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, result.code, cli);
            return handleAgentExit({
                onRuntimeEnd: endPiRuntime,
                ctx, code: result.code, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                killReason,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                isResume: false, wasKilled, wasSteer, smokeResult,
                effortDefault: 'medium', costLine: '',
                resolve: recordResult,
                activeProcesses,
                scopeKey,
                runtimeTransport,
                scopedBucket: currentBucket,
                chatSessionId,
                childProcess: child,
                releaseMainRun: (scope, process, generation) => activeMainProcesses.get(scope) === mainRun
                    && releaseMainRun(scope, process, generation),
                retryState: queueCtrl.retryStateForScope(scopeKey),
                fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue: requestQueue,
            });
        }, async (err: Error) => {
            if (setupError !== undefined) throw setupError;
            const failedOutcome = piFailureOutcome(err);
            if (failedOutcome !== undefined) handoffRuntimeOutcome(ctx, failedOutcome);
            const killReason = consumeKillReason(child.pid);
            const wasKilled = !!killReason;
            const wasSteer = isLifecycleSteerReason(killReason);
            stopWatchdog();
            appendPiStderr(err.message);
            console.error('[jaw:pi] runtime failed:', userErrorText(err));
            return handleAgentExit({
                onRuntimeEnd: endPiRuntime,
                ctx, code: 1, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                killReason,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                isResume: false, wasKilled, wasSteer, smokeResult: detectSmokeResponse('', [], 1, cli),
                effortDefault: 'medium', costLine: '',
                resolve: recordResult,
                activeProcesses,
                scopeKey,
                runtimeTransport,
                scopedBucket: currentBucket,
                chatSessionId,
                childProcess: child,
                releaseMainRun: (scope, process, generation) => activeMainProcesses.get(scope) === mainRun
                    && releaseMainRun(scope, process, generation),
                retryState: queueCtrl.retryStateForScope(scopeKey),
                fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue: requestQueue,
            });
        }).catch((handleErr: Error) => {
            endPiRuntime({ kind: 'turn-end', status: 'error', finalText: null, error: 'Lifecycle failed' });
            console.error('[jaw:lifecycle] handleAgentExit failed (Pi):', handleErr.message);
            try { finalizeTraceRun(traceRunId, 'error', 'Lifecycle failed', { onlyIfRunning: true }); }
            catch { console.warn('[runtime] Pi lifecycle trace finalization failed'); }
            if (mainManaged && activeMainProcesses.get(scopeKey) === mainRun) {
                if (releaseMainRun(scopeKey, mainRun!.process, ownerGeneration) && !opts.internal) requestQueue();
                if (getLiveRun(liveScope).traceRunId === traceRunId) clearLiveRun(liveScope);
            } else if (!mainManaged && activeProcesses.get(agentLabel) === child) activeProcesses.delete(agentLabel);
            recordResult({ text: ctx.runtimeOutcome?.finalText ?? '', code: 1,
                ...(ctx.runtimeOutcome === undefined ? {} : { runtimeOutcome: { ...ctx.runtimeOutcome } }) });
        }).finally(async () => {
            try { stopWatchdog(); await releaseLease(); }
            catch {
                console.warn('[jaw:pi] runtime cleanup failed');
                recordResult({ text: '', code: 1 });
            } finally {
                cleanupDone = true;
                settlePiExit();
                if (queueRequested) void processQueue(scopeKey);
                if (selectedResult !== undefined) resolve!(selectedResult);
            }
        });
    };

    if (opts.agentId) {
        let opened: ReturnType<typeof openPiRpc>;
        try {
            opened = openPiRpc(profile, pi, {
                model: runtimeModel,
                ...(piSessionId ? { sessionId: piSessionId } : {}),
                effort, cwd: spawnCwd, env: spawnEnv,
                onEvent: onPiEvent, onRawRecord: onPiRawRecord,
            });
        } catch (error) {
            activity.close({ kind: 'turn-end', status: 'error', finalText: null, error: 'Pi process creation failed' });
            finalizeTraceRun(traceRunId, 'error', 'Pi process creation failed');
            cleanupPiEmployee();
            throw error;
        }
        piTurnChild = opened.child;
        piFacade = new PiRuntimeSession(opened, {
            lifetime: 'oneshot',
            provider: 'pi',
            deferTurnEnd: true,
            projection: activity,
            getTurnContext: piTurnContext,
            ...(effort ? { effort } : {}),
            onPiEvent,
            onRawRecord: onPiRawRecord,
            onFailure: onPiFailure,
            onStderr: onPiStderr,
        });
        bindPiExecutionCancel(opened.child, () => { void piFacade!.cancel(); });
        runPiTurn(opened.child, null, opened.cleanup, () => {
            piSendStarted = true;
            return mapPiSend(opened.child, piFacade!.send({ text: `${piSysPrompt}\n\n${piPrompt}` }, () => {}));
        });
        return { child: opened.child, promise: resultPromise };
    }

    const profileFp = crypto.createHmac('sha256', piProfileFingerprintKey)
        .update(profile.apiKey || '')
        .digest('hex')
        .slice(0, 12);
    mainRun!.starting = true;
    let piAcquireStopReason: string | undefined;
    const cancelPiAcquire = (reason: string) => {
        piAcquireStopReason ??= reason;
        clearMainLiveRunOnStop(scopeKey, reason);
    };
    const finishPiAcquire = () => {
        mainRun!.starting = false;
        if (mainRun!.cancelPending === cancelPiAcquire) delete mainRun!.cancelPending;
    };
    const abandonPiAcquire = () => {
        activity.close({ kind: 'turn-end', status: 'stopped', finalText: null });
        try { finalizeTraceRun(traceRunId, 'interrupted'); }
        catch { console.warn('[runtime] Pi cancelled acquisition trace finalization failed'); }
        if (activeMainProcesses.get(scopeKey) === mainRun) {
            if (getLiveRun(liveScope).traceRunId === traceRunId) clearLiveRun(liveScope);
            releaseMainRun(scopeKey, null, ownerGeneration);
        }
        settlePiExit();
        resolve!(stoppedBeforeStart(piAcquireStopReason, traceRunId));
    };
    mainRun!.cancelPending = cancelPiAcquire;
    void acquirePiRuntime({
        key: {
            scopeKey,
            cwd: spawnCwd,
            profileId: profile.id,
            fullEndpoint: profile.endpoint,
            apiKind: profile.apiKind,
            model: runtimeModel,
            effort,
            profileFp,
        },
        piSettings: pi,
        env: spawnEnv,
        storedSessionId: piSessionId || null,
        instructions: piSysPrompt,
        forceNew: forceNew || Boolean(slackToolGrant),
    }).then((lease) => {
        finishPiAcquire();
        if (piAcquireStopReason !== undefined || activeMainProcesses.get(scopeKey) !== mainRun || !isCurrentSessionOwner(persistenceOwner, scopeKey)) {
            lease.release();
            abandonPiAcquire();
            return;
        }
        ctx.sessionId = lease.session.sessionId;
        console.log(`[jaw:pi:pool] reused=${lease.reused} sessionId=${lease.session.sessionId || 'new'}`);
        piTurnChild = lease.session.child;
        piFacade = new PiRuntimeSession(lease.session, {
            lifetime: 'pooled',
            provider: 'pi',
            deferTurnEnd: true,
            projection: activity,
            getTurnContext: piTurnContext,
            ...(effort ? { effort } : {}),
            onPiEvent,
            onRawRecord: onPiRawRecord,
            onFailure: onPiFailure,
            onStderr: onPiStderr,
        });
        runPiTurn(lease.session.child, lease, null, () => {
            piSendStarted = true;
            return mapPiSend(lease.session.child, piFacade!.send({ text: piPrompt }, () => {}));
        });
    }).catch((err: Error) => {
        finishPiAcquire();
        if (piAcquireStopReason !== undefined) { abandonPiAcquire(); return; }
        console.error(`[jaw:pi:pool] acquire failed: ${err.message}`);
        activity.close({ kind: 'turn-end', status: 'error', finalText: null, error: 'Pi acquisition failed' });
        try { finalizeTraceRun(traceRunId, 'error', 'Pi acquisition failed'); }
        catch { console.warn('[runtime] Pi acquisition trace finalization failed'); }
        const ownsRun = activeMainProcesses.get(scopeKey) === mainRun;
        if (ownsRun) {
            clearLiveRun(liveScope);
            try {
                broadcast('agent_status', { running: false, agentId: agentLabel });
                broadcast('agent_done', { ...runPin, text: `❌ Pi RPC acquire failed: ${err.message}`, error: true, origin }, 'public');
            } catch { console.warn('[jaw:pi] acquisition diagnostic delivery failed'); }
            releaseMainRun(scopeKey, null, ownerGeneration);
        }
        resolve!({ text: '', code: 1 });
        if (ownsRun) {
            settlePiExit();
            void processQueue(scopeKey);
        }
    });
    return { child: null, promise: resultPromise };
}
