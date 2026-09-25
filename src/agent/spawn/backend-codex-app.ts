// Extracted from spawnAgent (src/agent/spawn.ts). Body moved verbatim; the two
// destructuring lines bind the same names the branch read from spawnAgent scope.
import { broadcast } from '../../core/bus.js';
import { settings } from '../../core/config.js';
import { clearEmployeeSession, insertMessage } from '../../core/db.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { appendTraceEvent, finalizeTraceRun, stampTraceTool, startTraceRun } from '../../trace/store.js';
import { loadCatalogEfforts, resolveCatalogPath, validateModelEffort } from '../codex-app-catalog.js';
import { CodexAppClient, CodexSteerError, isRecoverableResumeError } from '../codex-app-client.js';
import { type CodexAppEventResult, applyCodexAppTextEvent, listenCodexAppTurnAdapter } from '../codex-app-events.js';
import { CodexHostGenerationStaleError, acquireCodexAppLane, prepareCodexAppHost } from '../codex-host-pool.js';
import { appendAssistantRawText, emitAgentTool } from '../events/helpers.js';
import { handleAgentExit } from '../lifecycle-handler.js';
import { clearLiveRun, getLiveRun, replaceLiveRunTools, setLiveRunTraceId } from '../live-run-state.js';
import { withSteerContext } from '../prompt-context.js';
import { acquireCodexAppRuntime } from '../runtime-pool.js';
import { CodexProjection } from '../runtime/codex-projection.js';
import { RuntimeProjection } from '../runtime/projection.js';
import { persistMainSession } from '../session-persistence.js';
import { detectSmokeResponse } from '../smoke-detector.js';
import { settleExit } from './exit-settle.js';
import { isLifecycleSteerReason } from './kill-reason.js';
import { FALLBACK_MAX_RETRIES } from './queue.js';
import { shouldEmitHeartbeat } from './resume.js';
import { attachWatchdog } from '../watchdog.js';
import type { ChildProcess } from 'child_process';
import crypto from 'node:crypto';
import type { SpawnBackendHost, SpawnBackendLocals } from './backend-context.js';
import type { CopilotSpawnContext, SpawnResult } from './types.js';
import { stripSkillMentionBlock } from '../../core/skill-mentions.js';

export function runCodexAppBackend(backendLocals: SpawnBackendLocals, backendHost: SpawnBackendHost): SpawnResult {
    const { agentLabel, cfg, chatSessionId, cli, codexMultiplexMain, currentBucket, detected, effectiveLiveScope, effort, empSid, empTag, forceNew, historyBlock, isResume, liveScope, mainManaged, mainRun, model, opts, origin, ownerGeneration, parentLiveScopeForChild, persistenceOwner, prompt, resolve, resultPromise, resumeKey, resumeSessionId, runPin, runtimeTransport, scopeKey, slackToolGrant, spawnCwd, spawnEnv, sysPrompt, traceAudience } = backendLocals;
    const { CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS, DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS, DEFAULT_CODEX_APP_TURN_ABS_MS, DEFAULT_CODEX_APP_TURN_IDLE_MS, activeMainProcesses, activeProcesses, appendParentLiveRunTool, broadcastAgentOutput, cleanupEmployeeTmpDir, configuredPositiveMs, consumeKillReason, processQueue, queueCtrl, registerActiveProcess, releaseMainRun, stoppedBeforeStart } = backendHost;
    const catalogPath = resolveCatalogPath();
    if (catalogPath) {
        const verdict = validateModelEffort(model, effort, loadCatalogEfforts(catalogPath));
        if (!verdict.ok) {
            throw new Error(`[codex-app] ${verdict.error}`);
        }
    }
    if (mainManaged && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', stripSkillMentionBlock(prompt), cli, model, settings["workingDir"] || null, chatSessionId);
    }
    if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

    const traceRunId = startTraceRun({ cli, model, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience, sessionId: chatSessionId, scopeKey });
    if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
    const ctx: CopilotSpawnContext = {
        fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
        turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
        thinkingBuf: '',
        runStartedAt: Date.now(),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...(origin ? { origin } : {}),
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
    const codexProjection = new CodexProjection(activity);
    activity.start('codex-app');

    function flushCodexAppThinking() {
        if (!ctx.thinkingBuf) return;
        const merged = ctx.thinkingBuf.trim();
        if (merged) {
            const singleLine = merged.replace(/\s+/g, ' ').trim();
            const label = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
            console.log(`  💭 ${label}`);
            const tool = { icon: '💭', label, toolType: 'thinking' as const, detail: merged };
            stampTraceTool(tool, ctx, 'thinking');
            ctx.toolLog.push(tool);
            if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
            appendParentLiveRunTool(ctx, tool);
            emitAgentTool(ctx, agentLabel, tool, empTag);
        }
        ctx.thinkingBuf = '';
    }

    let lastVisibleBroadcastTs = Date.now();
    let heartbeatSent = false;

    let turnCompleted = false;
    let turnReportedFailure = false;
    let markCodexProgress = () => {};
    let settleTurn!: () => void;
    let rejectTurn!: (err: Error) => void;
    const turnDone = new Promise<void>((resolveTurn, rejectTurnPromise) => {
        settleTurn = resolveTurn;
        rejectTurn = rejectTurnPromise;
    });

    const consumeCodexAppEvent = (method: string, parsed: CodexAppEventResult | null) => {
        if (!parsed) {
            if (method === 'turn/completed') settleTurn();
            return;
        }

        if (parsed.flushThinking) {
            flushCodexAppThinking();
        }
        if (parsed.tool) {
            const parsedTool = parsed.tool;
            if (parsedTool.icon === '💭') {
                ctx.thinkingBuf += parsedTool.detail || parsedTool.label;
                return;
            }
            flushCodexAppThinking();
            const key = `${parsedTool.icon}:${parsedTool.label}:${parsedTool.stepRef || ''}:${parsedTool.status || ''}`;
            if (!ctx.seenToolKeys.has(key)) {
                ctx.seenToolKeys.add(key);
                stampTraceTool(parsedTool, ctx, parsedTool.toolType || 'tool');
                ctx.toolLog.push(parsedTool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, parsedTool);
                emitAgentTool(ctx, agentLabel, parsedTool, empTag);
                lastVisibleBroadcastTs = Date.now();
                heartbeatSent = false;
            }
        }
        // Sticky channel/item bookkeeping and the durable-vs-live decision live
        // in applyCodexAppTextEvent so they can be tested without a live runtime.
        if (parsed.text) flushCodexAppThinking();
        const textDecision = applyCodexAppTextEvent(ctx, parsed);
        if (textDecision.durable) {
            // codex-app streams item/agentMessage/delta at TOKEN granularity;
            // the segment formatter would inject "\n- " between unjoined
            // tokens ("이"+"지만" → "이\n- 지만"). Raw-append like the plain
            // `claude` text_delta path (events/index.ts) instead.
            const segment = appendAssistantRawText(ctx, textDecision.durable);
            if (segment) {
                broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
                lastVisibleBroadcastTs = Date.now();
                heartbeatSent = false;
            }
        } else if (textDecision.live) {
            // Commentary is a transient progress update, not part of the durable
            // response. Broadcast it for live UI preview but keep it out of
            // fullText — that way agent_done (and therefore Slack/Telegram/
            // Discord delivery) contains only the final answer.
            broadcastAgentOutput(ctx, agentLabel, cli, textDecision.live, empTag, traceAudience);
        }
        if (parsed.sessionId && !ctx.sessionId) {
            ctx.sessionId = parsed.sessionId;
        }
        if (parsed.tokens) {
            ctx.tokens = parsed.tokens;
        }
        if (parsed.turnStatus && parsed.turnStatus !== 'completed') {
            console.warn(`[codex-app:turn] final status: ${parsed.turnStatus}`);
            turnReportedFailure = true;
        }
        opts.lifecycle?.onActivity?.('codex-app');
        if (method === 'turn/completed') settleTurn();
    };

    const handleStderr = (text: string) => {
        appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
        if (ctx.stderrBuf.length < 4000) {
            ctx.stderrBuf += text + '\n';
        }
        opts.lifecycle?.onActivity?.('stderr');
        if (shouldEmitHeartbeat(lastVisibleBroadcastTs, heartbeatSent)) {
            heartbeatSent = true;
            const elapsed = Math.round((Date.now() - lastVisibleBroadcastTs) / 1000);
            console.log(`  ⏳ agent active (no visible event for ${elapsed}s)`);
            emitAgentTool(ctx, agentLabel, {
                icon: '⏳',
                label: 'working... (no visible progress)',
            }, empTag);
        }
    };

    const effectiveFastMode = cfg.fastMode ?? settings["perCli"]?.["codex"]?.fastMode ?? false;

    type CodexAppTurnLeaseView = {
        readonly threadId: string;
        readonly reused: boolean;
        readonly resumedThread: boolean;
        readonly bucketKey?: string;
        readonly laneScope: string;
        release(): void;
        cancel(): Promise<void>;
    };
    const runCodexAppTurn = async (
        appClient: CodexAppClient,
        lease: CodexAppTurnLeaseView | null,
        laneScope: string,
    ): Promise<void> => {
        const child = appClient.proc;
        if (!child) throw new Error('Codex AppServer process was not created');
        if (mainManaged) mainRun!.process = child;
        else registerActiveProcess(agentLabel, child);
        if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });

        const processExit: { value: { code: number | null; signal: string | null } | null } = { value: null };
        // The one documented cross-runtime exception. codex-app keeps a 300s idle
        // bound where the shared watchdog defaults to 90s, because an appserver turn
        // reports sparse STRUCTURED progress instead of a continuous stream and
        // nothing here counts stdout as liveness. settings.agentTimeout deliberately
        // does not narrow it either: a global idleMs written for print CLIs would
        // cut the default runtime's bound by two thirds. The env overrides remain
        // the supported knob and are mapped into the watchdog config below.
        const idleMs = configuredPositiveMs(process.env["CODEX_APP_TURN_IDLE_MS"], DEFAULT_CODEX_APP_TURN_IDLE_MS);
        const absoluteMs = configuredPositiveMs(process.env["CODEX_APP_TURN_ABS_MS"], DEFAULT_CODEX_APP_TURN_ABS_MS);
        let watchdogCancel: Promise<void> | null = null;
        let leaseCancel: Promise<void> | null = null;
        const requestLeaseCancel = (): Promise<void> => {
            if (!lease) {
                appClient.kill();
                return Promise.resolve();
            }
            leaseCancel ??= lease.cancel().catch((err: unknown) => {
                console.warn('[codex-app:turn] cancel failed:', (err as Error).message);
            });
            return leaseCancel;
        };
        const cancelHook = (_reason: string) => { void requestLeaseCancel(); };
        if (lease && mainRun) mainRun.cancelTurn = cancelHook;
        // Same-turn steer (turn/steer) for the duration of THIS turn only:
        // installed and torn down with cancelHook so capability reads never
        // outlive the steerable window.
        const steerHook = async (text: string): Promise<'steered' | 'unavailable' | 'rejected'> => {
            try {
                await appClient.steerTurn(laneScope, text, { clientUserMessageId: crypto.randomUUID() });
                return 'steered';
            } catch (err) {
                if (err instanceof CodexSteerError) {
                    // review/compact turns reject steer; a mismatched/finished
                    // turn raced us. Both are queue-fallback territory.
                    return err.code === 'not-steerable' ? 'rejected' : 'unavailable';
                }
                throw err;
            }
        };
        if (mainRun) mainRun.steerTurnInBand = steerHook;
        // The same watchdog every other runtime uses. The bespoke timer pair this
        // replaces never set `ctx.stallReason`, and that field is the ONLY trigger
        // for the #405 truncation notice (`error-classifier.ts:149-159`). So on the
        // DEFAULT runtime a timeout surfaced as a generic error and the #405 fix
        // never applied to the path most turns actually take.
        const turnWatchdog = attachWatchdog(child, agentLabel, reason => {
            if (watchdogCancel) return;
            console.warn(`[codex-app:turn] watchdog stall (${reason}, idleMs=${idleMs}, absoluteMs=${absoluteMs})`);
            ctx.stallReason = reason;
            watchdogCancel = requestLeaseCancel();
            rejectTurn(new Error(`Codex AppServer turn watchdog timeout: ${reason}`));
        }, {
            // This child's stdout IS the JSON-RPC stream and readline already owns
            // it, so counting raw traffic as liveness would keep a wedged turn
            // looking alive forever. Progress comes from the turn adapter instead.
            observeStdio: false,
            // The two bespoke timers map onto the watchdog's two real gates:
            // markProgress slides absoluteDeadline to now+absoluteMs, giving
            // "no progress for idleMs", capped at startedAt+absoluteHardCapMs,
            // giving "total run beyond absoluteMs". firstProgressMs bounds a turn
            // that never reports at all.
            firstProgressMs: idleMs, idleMs, absoluteMs: idleMs, absoluteHardCapMs: absoluteMs,
        });
        ctx.stallWatchdog = turnWatchdog;
        markCodexProgress = () => { turnWatchdog.markProgress(); };
        const listener = listenCodexAppTurnAdapter(appClient, lease, laneScope, ctx, {
            onProgress: () => { markCodexProgress(); },
            onRawNotification: (method, params) => {
                if (method === 'turn/completed' || method === 'turn/started' || method === 'error') {
                    console.log(`[codex-app:notify] ${method}`);
                }
                appendTraceEvent({ runId: ctx.traceRunId, source: 'codex_app_raw', eventType: method, raw: params });
            },
            onDiagnosticNotification: (entry) => {
                appendTraceEvent({
                    runId: ctx.traceRunId,
                    source: 'codex_app_raw',
                    eventType: 'unrouted-notification',
                    raw: entry,
                });
            },
            onEvent: consumeCodexAppEvent,
            onProjectionNotification: (method, params, parsed) => {
                codexProjection.observe(method, params, parsed, ctx.codexAppActiveChannel || '');
            },
            onStderr: handleStderr,
            onExit: (code, signal) => {
                processExit.value = { code, signal };
                rejectTurn(new Error(`Codex AppServer exited (code=${code}, signal=${signal})`));
            },
            onError: rejectTurn,
            onInterruptFailed: (err) => {
                console.warn(`[codex-app:interrupt] ${err.message}`);
            },
        });

        try {
            if (lease) {
                ctx.sessionId = lease.threadId;
                console.log(`[codex-app:pool] thread=${lease.threadId.slice(0, 12)}... reused=${lease.reused} resumed=${lease.resumedThread}`);
            } else {
                const initResult = await appClient.initialize();
                if (process.env["DEBUG"]) console.log('[codex-app:init]', JSON.stringify(initResult).slice(0, 200));
                const threadOptions = {
                    model,
                    effort,
                    cwd: spawnCwd,
                    fastMode: effectiveFastMode,
                    instructions: sysPrompt,
                };

                if (isResume && resumeSessionId) {
                    try {
                        await appClient.resumeThread(laneScope, resumeSessionId, threadOptions);
                        console.log(`[codex-app:session] resumeThread OK: ${resumeSessionId.slice(0, 12)}...`);
                    } catch (resumeErr: unknown) {
                        const message = (resumeErr as Error).message || '';
                        if (!isRecoverableResumeError(message)) throw resumeErr;
                        console.warn(`[codex-app:session] resumeThread FAILED (recoverable): ${message} — starting new thread`);
                        if (empSid && opts.agentId) clearEmployeeSession.run(opts.agentId);
                        await appClient.startThread(laneScope, threadOptions);
                    }
                } else {
                    await appClient.startThread(laneScope, threadOptions);
                }
                ctx.sessionId = appClient.getThreadId(laneScope) ?? '';
            }

            const shouldPrependHistory = lease
                ? !(lease.resumedThread || lease.reused)
                : !(isResume && Boolean(resumeSessionId));
            const codexAppPrompt = (shouldPrependHistory && historyBlock)
                ? `${historyBlock}\n\n[User Message]\n${prompt}`
                : prompt;
            const codexAppPromptWithSteer = withSteerContext(codexAppPrompt, opts.steerContext);

            const startTurn = appClient.startTurn(laneScope, codexAppPromptWithSteer);
            await Promise.race([startTurn, turnDone]);
            await turnDone;
            turnCompleted = !turnReportedFailure;

            flushCodexAppThinking();

            const persistedThreadId = lease?.threadId ?? appClient.getThreadId(laneScope);
            if (persistedThreadId && persistMainSession(stripUndefined({
                persistenceOwner,
                scopeKey,
                forceNew,
                employeeSessionId: empSid,
                sessionId: persistedThreadId,
                isFallback: opts._isFallback,
                cli,
                model,
                resumeKey,
                effort: cfg.effort || '',
                skipSessionPersist: opts._skipSessionPersist === true,
                ...(lease?.bucketKey ? { codexAppBucket: lease.bucketKey } : {}),
                // With multiplex off there is no lease bucket key, and without this the
                // save lands on the bare `codex-app` row that belongs to the default
                // session. codex-app is the default runtime, so that is the common case.
                runtimeTransport,
                scopedBucket: currentBucket,
            }))) {
                console.log(`[jaw:session] saved ${cli} session=${persistedThreadId.slice(0, 12)}... (pre-shutdown)`);
            }
        } catch (err: unknown) {
            console.error(`[codex-app:error] ${(err as Error).message}`);
            if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += (err as Error).message;
            if (!lease) appClient.kill();
        } finally {
            turnWatchdog.stop();
            markCodexProgress = () => {};
            if (watchdogCancel) await watchdogCancel;
            if (mainRun?.cancelTurn === cancelHook) delete mainRun.cancelTurn;
            if (mainRun?.steerTurnInBand === steerHook) delete mainRun.steerTurnInBand;
            listener.dispose();
            if (lease) lease.release();
            else {
                await appClient.closeGracefully();
                appClient.cleanup();
                cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            }
        }

        // A turn that never completed is a failure even when the process it
        // was running on exited cleanly. Trusting the child's status here
        // reports success for a turn that produced nothing, which is exactly
        // what happens when a shared host is closed mid-turn.
        const exitCode = turnCompleted ? 0 : (processExit.value?.code || 1);
        opts.lifecycle?.onExit?.(exitCode);
        const killReason = consumeKillReason(child.pid);
        if (processExit.value && processExit.value.code !== 0 && !killReason) {
            console.warn(`[codex-app:unexpected-exit] code=${processExit.value.code} signal=${processExit.value.signal} threadId=${ctx.sessionId || 'none'}`);
        }
        const wasKilled = !!killReason;
        const wasSteer = isLifecycleSteerReason(killReason);
        flushCodexAppThinking();
        const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, exitCode, cli);
        await handleAgentExit({
            onRuntimeEnd: (end) => { activity.close(end); },
            ctx, code: exitCode, cli, model, agentLabel, mainManaged, origin,
            killReason,
            resumeKey,
            prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
            isResume, wasKilled, wasSteer, smokeResult,
            effortDefault: '', costLine: '',
            resolve: resolve!,
            activeProcesses,
            scopeKey,
            runtimeTransport,
            scopedBucket: currentBucket,
            chatSessionId,
            ...(lease?.bucketKey ? { codexAppBucket: lease.bucketKey } : {}),
            childProcess: child,
            releaseMainRun,
            retryState: queueCtrl.retryStateForScope(scopeKey),
            fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
            fallbackMaxRetries: FALLBACK_MAX_RETRIES,
            processQueue,
        }).catch((err: Error) => {
            activity.close({ kind: 'turn-end', status: 'error', finalText: null, error: 'Lifecycle failed' });
            console.error('[jaw:lifecycle] handleAgentExit failed (codex-app):', err.message);
        }).finally(() => settleExit(scopeKey));
    };

    if (opts.agentId) {
        const employeeLaneScope = `employee:${opts.agentId}`;
        const appClient = new CodexAppClient({
            binary: detected.path || 'codex', workDir: spawnCwd, env: spawnEnv,
        });
        let child: ChildProcess;
        try {
            appClient.spawn();
            if (!appClient.proc) throw new Error('Codex AppServer process was not created');
            child = appClient.proc;
        } catch (error) {
            activity.close({ kind: 'turn-end', status: 'error', finalText: null, error: 'Codex process creation failed' });
            finalizeTraceRun(traceRunId, 'error', 'Codex process creation failed');
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            throw error;
        }
        void runCodexAppTurn(appClient, null, employeeLaneScope);
        return { child, promise: resultPromise };
    }

    type CodexAppAcquiredLease = CodexAppTurnLeaseView & { readonly client: CodexAppClient };
    type CodexAppAcquireOutcome =
        | { kind: 'lease'; lease: CodexAppAcquiredLease }
        | { kind: 'cancelled'; reason: string | undefined };

    mainRun!.starting = true;
    let codexAcquireStopReason: string | undefined;
    const cancelCodexAcquire = (reason: string) => { codexAcquireStopReason ??= reason; };
    const releaseCodexAcquireHook = () => {
        if (mainRun!.cancelPending === cancelCodexAcquire) delete mainRun!.cancelPending;
    };
    mainRun!.cancelPending = cancelCodexAcquire;
    const acquireCodexAppForTurn = async (): Promise<CodexAppAcquireOutcome> => {
        const acquireWasCancelled = () => codexAcquireStopReason !== undefined || activeMainProcesses.get(scopeKey) !== mainRun;

        try {
            if (!codexMultiplexMain) {
                const lease = await acquireCodexAppRuntime({
                    binary: detected.path || 'codex', env: spawnEnv,
                    route: 'legacy',
                    key: {
                        scopeKey,
                        cwd: spawnCwd, model, effort, fastMode: effectiveFastMode,
                    },
                    storedThreadId: resumeSessionId || null,
                    instructions: sysPrompt,
                    forceNew: forceNew || Boolean(slackToolGrant),
                });
                return { kind: 'lease', lease };
            }

            const waitMs = configuredPositiveMs(
                process.env["CODEX_APP_ACQUIRE_WAIT_MS"],
                DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS,
            );
            const deadlineAt = Date.now() + waitMs;
            let lastStaleError: CodexHostGenerationStaleError | null = null;
            let staleAttempts = 0;

            const deadlineError = (stage: 'prepare' | 'acquire'): Error => lastStaleError
                ?? new Error(`Codex App ${stage} timed out after ${waitMs}ms`);
            const awaitWithinDeadline = async <T>(
                stage: 'prepare' | 'acquire',
                pending: Promise<T>,
                onLateValue?: (value: T) => void,
            ): Promise<T> => {
                let deadlineWon = false;
                let timeout: NodeJS.Timeout | undefined;
                void pending.then((value) => {
                    if (deadlineWon) onLateValue?.(value);
                }, () => {});
                const remainingMs = deadlineAt - Date.now();
                if (remainingMs <= 0) {
                    deadlineWon = true;
                    throw deadlineError(stage);
                }
                const deadline = new Promise<never>((_resolveDeadline, rejectDeadline) => {
                    timeout = setTimeout(() => {
                        deadlineWon = true;
                        rejectDeadline(deadlineError(stage));
                    }, remainingMs);
                });
                try {
                    return await Promise.race([pending, deadline]);
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            };

            for (;;) {
                if (acquireWasCancelled()) return { kind: 'cancelled', reason: codexAcquireStopReason };
                // Check the budget before spawning more work. awaitWithinDeadline()
                // only measures what remains once the promise already exists, so a
                // backoff that consumed the last of the budget would still get to
                // start one more prepare.
                if (deadlineAt - Date.now() <= 0) throw lastStaleError ?? deadlineError('prepare');
                try {
                    const prepared = await awaitWithinDeadline('prepare', prepareCodexAppHost({
                        binary: detected.path || 'codex', cwd: spawnCwd,
                        fastMode: effectiveFastMode, env: spawnEnv, model, effort,
                    }));
                    if (acquireWasCancelled()) return { kind: 'cancelled', reason: codexAcquireStopReason };
                    const lease = await awaitWithinDeadline('acquire', acquireCodexAppLane(prepared, {
                        scopeKey,
                        bucketKey: currentBucket!,
                        storedThreadId: resumeSessionId || null,
                        instructions: sysPrompt,
                        forceNew: forceNew || Boolean(slackToolGrant),
                        waitMs: deadlineAt - Date.now(),
                    }), (lateLease) => { lateLease.release(); });
                    if (acquireWasCancelled()) {
                        lease.release();
                        return { kind: 'cancelled', reason: codexAcquireStopReason };
                    }
                    return { kind: 'lease', lease };
                } catch (err: unknown) {
                    if (!(err instanceof CodexHostGenerationStaleError)) throw err;
                    lastStaleError = err;
                    if (acquireWasCancelled()) return { kind: 'cancelled', reason: codexAcquireStopReason };
                    const remainingMs = deadlineAt - Date.now();
                    if (remainingMs <= 0) throw lastStaleError;
                    staleAttempts += 1;
                    const backoffMs = Math.min(
                        remainingMs,
                        CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS,
                        25 * staleAttempts,
                    );
                    await new Promise<void>((done) => { setTimeout(done, backoffMs); });
                }
            }
        } finally {
            // The next promise continuation still owns the acquired lease.
            // Keep its cancellation hook until it hands off or abandons it.
            mainRun!.starting = false;
        }
    };

    // A run that never started a turn owns nothing but its own map slot.
    // releaseMainRun() matches on (process, ownerGeneration), and a pending
    // run has process=null while sharing the global generation with whatever
    // replaced it, so calling it here would delete the replacement's entry.
    // Compare the captured object instead and only drop our own slot.
    const abandonTurn = (lease: { release(): void } | null): void => {
        lease?.release();
        activity.close({ kind: 'turn-end', status: 'stopped', finalText: null });
        finalizeTraceRun(traceRunId, 'interrupted');
        if (!activeMainProcesses.has(scopeKey) || activeMainProcesses.get(scopeKey) === mainRun) {
            const currentLive = getLiveRun(liveScope);
            const ownsLive = currentLive.traceRunId === traceRunId;
            if (ownsLive) clearLiveRun(liveScope);
            if (ownsLive || (!currentLive.running && currentLive.traceRunId === undefined)) {
                broadcast('agent_status', { running: false, agentId: agentLabel });
            }
        }
        resolve!(stoppedBeforeStart(codexAcquireStopReason, traceRunId));
        if (activeMainProcesses.get(scopeKey) === mainRun) activeMainProcesses.delete(scopeKey);
        void processQueue(scopeKey);
    };
    void acquireCodexAppForTurn().then(async (outcome) => {
        releaseCodexAcquireHook();
        if (outcome.kind === 'cancelled') { abandonTurn(null); return; }
        const lease = outcome.lease;
        if (codexAcquireStopReason !== undefined || activeMainProcesses.get(scopeKey) !== mainRun) { abandonTurn(lease); return; }
        await runCodexAppTurn(lease.client, lease, lease.laneScope);
    }).catch((err: Error) => {
        releaseCodexAcquireHook();
        if (codexAcquireStopReason !== undefined) { abandonTurn(null); return; }
        console.error(`[codex-app:pool] acquire failed: ${err.message}`);
        activity.close({ kind: 'turn-end', status: 'error', finalText: null, error: 'Codex acquisition failed' });
        try { finalizeTraceRun(traceRunId, 'error', 'Codex acquisition failed'); }
        catch { console.warn('[runtime] Codex acquisition trace finalization failed'); }
        const ownsRun = activeMainProcesses.get(scopeKey) === mainRun;
        if (ownsRun) {
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
            broadcast('agent_done', { ...runPin, text: `❌ Codex AppServer acquire failed: ${err.message}`, error: true, origin }, 'public');
            releaseMainRun(scopeKey, null, ownerGeneration);
        }
        resolve!({ text: '', code: 1 });
        if (ownsRun) {
            settleExit(scopeKey);
            void processQueue(scopeKey);
        }
    });

    return { child: null, promise: resultPromise };
}
