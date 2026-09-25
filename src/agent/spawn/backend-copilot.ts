// Extracted from spawnAgent (src/agent/spawn.ts). Body moved verbatim; the two
// destructuring lines bind the same names the branch read from spawnAgent scope.
import { AcpClient } from '../../cli/acp-client.js';
import { broadcast } from '../../core/bus.js';
import { settings } from '../../core/config.js';
import { clearEmployeeSession, insertMessage } from '../../core/db.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { appendTraceEvent, stampTraceTool, startTraceRun } from '../../trace/store.js';
import { asCliEventRecord, fieldString } from '../../types/cli-events.js';
import { extractFromAcpUpdate } from '../events.js';
import { appendAssistantTextSegment, emitAgentTool } from '../events/helpers.js';
import { handleAgentExit } from '../lifecycle-handler.js';
import { beginLiveRun, clearLiveRun, replaceLiveRunTools, setLiveRunTraceId } from '../live-run-state.js';
import { getEmployeeMcpServers } from '../mcp-passthrough.js';
import { withHistoryPrompt, withSteerContext } from '../prompt-context.js';
import { createPrintActivity, finishPrintActivity } from '../runtime/print-activity.js';
import { persistMainSession } from '../session-persistence.js';
import { detectSmokeResponse } from '../smoke-detector.js';
import { settleExit } from './exit-settle.js';
import { isLifecycleSteerReason } from './kill-reason.js';
import { FALLBACK_MAX_RETRIES } from './queue.js';
import { shouldEmitHeartbeat } from './resume.js';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import type { SpawnBackendHost, SpawnBackendLocals } from './backend-context.js';
import type { CopilotSpawnContext, SpawnResult } from './types.js';

export function runCopilotBackend(backendLocals: SpawnBackendLocals, backendHost: SpawnBackendHost): SpawnResult {
    const { agentLabel, cfg, chatSessionId, cli, currentBucket, effectiveLiveScope, effort, empSid, empTag, forceNew, historyBlock, isEmployee, isResume, liveScope, mainManaged, mainRun, model, opts, origin, ownerGeneration, parentLiveScopeForChild, permissions, persistenceOwner, prompt, resolve, resultPromise, resumeKey, resumeSessionId, runPin, runtimeTransport, scopeKey, spawnCwd, spawnEnv, traceAudience } = backendLocals;
    const { activeProcesses, appendParentLiveRunTool, broadcastAgentOutput, buildHistoryBlock, cleanupEmployeeTmpDir, consumeKillReason, processQueue, queueCtrl, registerActiveProcess, releaseMainRun } = backendHost;
    // Write model + reasoning_effort to ~/.copilot/config.json (CLI flags unsupported)
    try {
        const cfgPath = join(os.homedir(), '.copilot', 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        let changed = false;

        // Sync model
        if (model && model !== 'default') {
            if (cfg.model !== model) { cfg.model = model; changed = true; }
        }

        // Sync effort
        if (effort) {
            if (cfg.reasoning_effort !== effort) { cfg.reasoning_effort = effort; changed = true; }
        } else if (cfg.reasoning_effort) {
            delete cfg.reasoning_effort; changed = true;
        }

        if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    } catch (e: unknown) { console.warn('[jaw:copilot] config.json sync failed:', (e as Error).message); }

    const acp = new AcpClient({ model, workDir: spawnCwd, permissions, env: spawnEnv });
    acp.spawn();
    const child = acp.proc;
    if (!child) {
        throw new Error('Copilot ACP process was not created');
    }
    if (mainManaged) mainRun!.process = child;
    else registerActiveProcess(agentLabel, child);
    if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });
    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

    // ─── DIFF-C: ACP error guard — prevent uncaught EventEmitter crash ───
    let acpSettled = false;  // guard: error→exit can fire sequentially
    acp.on('error', (err: Error) => {
        if (acpSettled) return;
        acpSettled = true;
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        opts.lifecycle?.onExit?.(null);
        const msg = `Copilot ACP spawn failed: ${err.message}`;
        console.error(`[acp:error] ${msg}`);
        if (mainManaged) {
            releaseMainRun(scopeKey, child, ownerGeneration);
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
        } else {
            activeProcesses.delete(agentLabel);
        }
        broadcast('agent_done', { ...runPin, text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        finishPrintActivity(ctx, { kind: 'turn-end', status: 'error', finalText: null, error: msg });
        resolve!({ text: '', code: 1 });
        if (mainManaged) void processQueue(scopeKey);
    });

    if (mainManaged && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', prompt, cli, model, settings["workingDir"] || null, chatSessionId);
    }
    if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);
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
    ctx.printActivity = createPrintActivity({ runId: traceRunId, sessionId: chatSessionId,
        scope: scopeKey, turnId: traceRunId, audience: traceAudience }, cli);

    // Flush accumulated 💭 thinking buffer as a single merged event
    function flushThinking() {
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

    // session/update → broadcast mapping
    let replayMode = false;  // Phase 17.2: suppress events during loadSession replay
    let lastVisibleBroadcastTs = Date.now();
    let heartbeatSent = false;

    acp.on('session/update', (params) => {
        if (replayMode) return;  // 리플레이 중 모든 이벤트 무시
        const update = asCliEventRecord(asCliEventRecord(params)["update"]);
        appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: fieldString(update.sessionUpdate, 'session/update'), raw: params });
        const parsed = extractFromAcpUpdate(params, ctx);
        if (!parsed) return;

        if (parsed.tool) {
            const parsedTool = parsed.tool;
            // Buffer 💭 thought chunks → flush when different event arrives
            if (parsedTool.icon === '💭') {
                ctx.printActivity?.reasoning(parsedTool.detail || parsedTool.label, 'append');
                ctx.thinkingBuf += parsedTool.detail || parsedTool.label;
                return;
            }
            // Non-💭 tool → flush any pending thinking first
            flushThinking();
            // [I3] Include stepRef + status in dedupe key to allow repeated same-name tool calls
            const key = `${parsedTool.icon}:${parsedTool.label}:${parsedTool.stepRef || ''}:${parsedTool.status || ''}`;
            if (!ctx.seenToolKeys.has(key)) {
                ctx.seenToolKeys.add(key);
                stampTraceTool(parsedTool, ctx, parsedTool.toolType || 'tool');
                ctx.toolLog.push(parsedTool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, parsedTool);
                emitAgentTool(ctx, agentLabel, parsedTool, empTag);
                // Reset heartbeat gate on actually visible broadcast (not 💭)
                lastVisibleBroadcastTs = Date.now();
                heartbeatSent = false;
            }
        }
        if (parsed.text) {
            flushThinking();
            // NARRATION-BOUNDARY-01: a changed ACP messageId means a NEW
            // assistant message, so what accumulated was progress narration
            // rather than part of this answer. External channels deliver text
            // derived from ctx.fullText; the live UI keeps the narration via
            // the agent_output broadcast below. Chunks without a messageId
            // carry no boundary signal and simply accumulate.
            if (parsed.messageId && ctx.acpAssistantMessageId !== undefined
                && ctx.acpAssistantMessageId !== parsed.messageId) {
                ctx.printActivity?.nextMessage();
                ctx.fullText = '';
                ctx.outputTextStarted = false;
            }
            if (parsed.messageId) ctx.acpAssistantMessageId = parsed.messageId;
            ctx.printActivity?.message(parsed.text, 'append', 'unknown');
            const segment = appendAssistantTextSegment(ctx, parsed.text);
            if (segment) {
                broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
                lastVisibleBroadcastTs = Date.now();
                heartbeatSent = false;
            }
        }
        opts.lifecycle?.onActivity?.('acp');
    });

    // [P2-3.14] session/cancelled → route through extractFromAcpUpdate for UI notification
    acp.on('session/cancelled', (params: Record<string, unknown>) => {
        appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: 'session/cancelled', raw: params });
        const parsed = extractFromAcpUpdate({
            update: { sessionUpdate: 'session_cancelled', ...(params || {}) },
        });
        if (parsed?.tool) {
            stampTraceTool(parsed.tool, ctx, parsed.tool.toolType || 'tool');
            ctx.toolLog.push(parsed.tool);
            if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
            appendParentLiveRunTool(ctx, parsed.tool);
            emitAgentTool(ctx, agentLabel, parsed.tool, empTag);
        }
    });

    // [P2-3.15] session/request_permission → audit record in toolLog
    acp.on('session/request_permission', (params: Record<string, unknown>) => {
        appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: 'session/request_permission', raw: params });
        const parsed = extractFromAcpUpdate({
            update: { sessionUpdate: 'request_permission', ...(params || {}) },
        });
        if (parsed?.tool) {
            stampTraceTool(parsed.tool, ctx, parsed.tool.toolType || 'tool');
            ctx.toolLog.push(parsed.tool);
            if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
            appendParentLiveRunTool(ctx, parsed.tool);
            emitAgentTool(ctx, agentLabel, parsed.tool, empTag);
        }
    });

    // stderr_activity → stderrBuf accumulation + conditional heartbeat
    acp.on('stderr_activity', (text: string) => {
        appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr_activity', raw: text });
        // Accumulate stderr for diagnostics (capped)
        if (ctx.stderrBuf.length < 4000) {
            ctx.stderrBuf += text + '\n';
        }
        opts.lifecycle?.onActivity?.('stderr');
        // Conditional heartbeat: visible progress absent for N seconds
        if (shouldEmitHeartbeat(lastVisibleBroadcastTs, heartbeatSent)) {
            heartbeatSent = true;
            const elapsed = Math.round((Date.now() - lastVisibleBroadcastTs) / 1000);
            console.log(`  ⏳ agent active (no visible event for ${elapsed}s)`);
            emitAgentTool(ctx, agentLabel, {
                icon: '⏳',
                label: 'working... (no visible progress)',
            }, empTag);
        }
    });

    // Run ACP flow
    let promptCompleted = false;
    (async () => {
        try {
            const initResult = await acp.initialize();
            if (process.env["DEBUG"]) console.log('[acp:init]', JSON.stringify(initResult).slice(0, 200));

            replayMode = true;  // Phase 17.2: mute during session load
            let loadSessionOk = false;
            if (isResume && resumeSessionId) {
                try {
                    await acp.loadSession(resumeSessionId);
                    loadSessionOk = true;
                    console.log(`[acp:session] loadSession OK: ${resumeSessionId.slice(0, 12)}...`);
                } catch (loadErr: unknown) {
                    console.warn(`[acp:session] loadSession FAILED: ${(loadErr as Error).message} — falling back to createSession`);
                    if (empSid && opts.agentId) {
                        clearEmployeeSession.run(opts.agentId);
                        console.warn(`[acp:session] cleared stale employee resume for ${opts.agentId}`);
                    }
                    await acp.createSession(spawnCwd, getEmployeeMcpServers());
                }
            } else {
                await acp.createSession(spawnCwd, getEmployeeMcpServers());
            }
            replayMode = false;  // Phase 17.2: unmute after session load
            ctx.sessionId = acp.sessionId;

            // Reset accumulated text from loadSession replay (ACP replays full history)
            ctx.fullText = '';
            ctx.toolLog = [];
            ctx.seenToolKeys.clear();
            ctx.thinkingBuf = '';  // Phase 17.2: clear replay thinking too
            if (mainManaged && !opts.internal) {
                beginLiveRun(liveScope, cli);
                if (ctx.traceRunId) setLiveRunTraceId(liveScope, ctx.traceRunId);
            }

            // If loadSession failed (or not resuming), inject history into prompt
            const needsHistoryFallback = isResume && !loadSessionOk;
            const fallbackHistory = needsHistoryFallback && !opts._skipHistory ? buildHistoryBlock(prompt, settings["workingDir"], chatSessionId) : '';
            const acpPrompt = needsHistoryFallback
                ? withHistoryPrompt(prompt, fallbackHistory)
                : (isResume ? prompt : withHistoryPrompt(prompt, historyBlock));
            const acpPromptWithSteer = withSteerContext(acpPrompt, opts.steerContext);
            const { promise: promptPromise } = acp.prompt(acpPromptWithSteer);
            const promptResult = await promptPromise;
            promptCompleted = true;
            if (process.env["DEBUG"]) console.log('[acp:prompt:result]', JSON.stringify(promptResult).slice(0, 200));

            // Save session BEFORE shutdown — acp.shutdown() causes SIGTERM (code=null),
            // which skips the exit handler's code===0 gate, losing session continuity.
            const persistedAcpSessionId = ctx.sessionId;
            if (persistedAcpSessionId && persistMainSession(stripUndefined({
                persistenceOwner,
                scopeKey,
                forceNew,
                employeeSessionId: empSid,
                sessionId: persistedAcpSessionId,
                isFallback: opts._isFallback,
                cli,
                model,
                resumeKey,
                effort: cfg.effort || '',
                skipSessionPersist: opts._skipSessionPersist === true,
                // Without this the save falls back to the bare, unscoped bucket, and a
                // successful turn in another session writes its vendor id into the row
                // the default session resumes from. The exit handler below passes the
                // same value; this path runs first and must not disagree with it.
                runtimeTransport,
                scopedBucket: currentBucket,
            }))) {
                console.log(`[jaw:session] saved ${cli} session=${persistedAcpSessionId.slice(0, 12)}... (pre-shutdown)`);
            }

            await acp.shutdown();
        } catch (err: unknown) {
            console.error(`[acp:error] ${(err as Error).message}`);
            if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += (err as Error).message;
            acp.kill();
        }
    })();

    acp.on('exit', ({ code, signal }) => {
        if (acpSettled) return;  // error handler already resolved
        acpSettled = true;
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        opts.lifecycle?.onExit?.(code ?? null);
        // [I2] Consume per-process kill reason
        const acpKillReason = consumeKillReason(acp.proc?.pid);
        if (code !== 0 && !acpKillReason) {
            console.warn(`[acp:unexpected-exit] code=${code} signal=${signal} sessionId=${ctx.sessionId || 'none'}`);
        }
        const wasKilled = !!acpKillReason;
        const wasSteer = isLifecycleSteerReason(acpKillReason);
        flushThinking();  // Flush any remaining thinking buffer

        const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, code, cli);
        const acpCode = promptCompleted ? 0 : (code ?? 1);

        // Delegated to lifecycle-handler.ts → handleAgentExit:
        //   - smoke continuation (guarded by !wasSteer)
        //   - output: ⏹️ [interrupted] prefix (wasSteer && mainManaged && !opts.internal)
        //   - error: code !== 0 && !wasKilled → classifyExitError
        //   - trace: if (traceText) traceText = `⏹️ [interrupted]…`
        handleAgentExit({
            ctx, code: acpCode, childExitCode: code, cli, model, agentLabel, mainManaged, origin,
            killReason: acpKillReason,
            onRuntimeEnd: end => ctx.printActivity?.finish(end),
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
            childProcess: child,
            releaseMainRun,
            retryState: queueCtrl.retryStateForScope(scopeKey),
            fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
            fallbackMaxRetries: FALLBACK_MAX_RETRIES,
            processQueue,
        }).catch((err: Error) => {
            console.error('[jaw:lifecycle] handleAgentExit failed (ACP):', err.message);
        }).finally(() => settleExit(scopeKey));
    });

    return { child, promise: resultPromise };
}
