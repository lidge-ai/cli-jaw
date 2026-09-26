import { createClaudeSdkSession, type ClaudeSdkSession } from '../../agent/runtime/claude-sdk-session.js';
import { loadClaudeHistory } from '../../agent/runtime/claude-sdk-history-loader.js';
import type { PreparedClaudeOptions } from '../../agent/runtime/claude-sdk-options.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { CodeLiveSettings, CodeProvider } from '../provider.js';
import type { CodePermissionMode } from '../wire.js';
import { CodeStoreError } from '../store.js';
import { claudeModelGateMessage } from '../../cli/claude-default-model-boot.js';
import { admitCodeOpen, captureCodeContext, CODE_PROMPT_TIMEOUT_MS, type CodeProviderDependencies } from './acp.js';
import { forkClaudeHistory } from './claude-history.js';

/** The in-process history helpers read these from process.env; the runtime must see the same projects dir. */
const HISTORY_ENVIRONMENT = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME'] as const;

function claudeEffort(value: string | null): PreparedClaudeOptions['effort'] {
    if (value === null) return undefined;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    throw new Error('code_provider_effort_unsupported');
}

const CLAUDE_CODE_MODES = {
    ask: 'default',
    'accept-edits': 'acceptEdits',
    plan: 'plan',
    'auto-review': 'auto',
    'dont-ask': 'dontAsk',
    auto: 'bypassPermissions',
} as const satisfies Record<Exclude<CodePermissionMode, 'read-only'>, PermissionMode>;

/** Code picker value -> exact SDK permission mode. `auto` stays YOLO; SDK `auto` is `auto-review`. */
export function claudeCodePermissionMode(mode: CodePermissionMode): PermissionMode {
    if (mode === 'read-only') throw new Error('code_provider_policy_unsupported');
    return CLAUDE_CODE_MODES[mode];
}

export function createClaudeCodeProvider(dependencies: CodeProviderDependencies,
    create: typeof createClaudeSdkSession = createClaudeSdkSession,
    loadHistory: typeof loadClaudeHistory = loadClaudeHistory): CodeProvider {
    return {
        id: 'claude', describe: dependencies.describe,
        async rollback(input) {
            const environment = dependencies.environment();
            if (HISTORY_ENVIRONMENT.some(key => environment[key] !== process.env[key])) {
                throw new CodeStoreError('rollback_unavailable', 'Claude history lives outside this server\'s configuration directory', 409);
            }
            const history = await loadHistory().catch(() => {
                throw new CodeStoreError('rollback_unavailable', 'Claude history helpers are unavailable', 409);
            });
            return forkClaudeHistory(history, input);
        },
        async open(options) {
            admitCodeOpen(options, dependencies);
            const sdkMode = claudeCodePermissionMode(options.permissionMode);
            const modelRefusal = claudeModelGateMessage(dependencies.binary(), options.model);
            if (modelRefusal) throw new Error(modelRefusal);
            const opening = captureCodeContext(options);
            const effort = claudeEffort(options.effort);
            let creationFinished = false;
            let runtime: ClaudeSdkSession;
            try { runtime = await create({
                prepared: { cwd: options.cwd, binary: dependencies.binary(), env: dependencies.environment(),
                    model: options.model, systemPrompt: '', fastMode: false,
                    ...(options.thinking === null ? {} : { thinking: options.thinking }),
                    permissions: sdkMode === 'bypassPermissions' ? 'auto' : 'safe',
                    // Every Code process may later switch live, including to bypass.
                    sdkMode, sessionGrants: true, allowDangerouslySkipPermissions: true,
                    ...(effort === undefined ? {} : { effort }),
                    ...(options.nativeCursor === null ? {} : { resumeSessionId: options.nativeCursor }) },
                signal: options.signal, registry: options.registry, promptTimeoutMs: CODE_PROMPT_TIMEOUT_MS, inBandSteer: true,
                onSessionCreated(session) {
                    let closeConfirmed = false;
                    let closing: Promise<void> | undefined;
                    options.onResource({
                        get closed() {
                            return closeConfirmed || (creationFinished && !session.alive && session.activeProcessCount === 0);
                        },
                        close() {
                            // close() fences the SDK synchronously, including before start().
                            closing ??= session.close().then(() => { closeConfirmed = true; });
                            return closing;
                        },
                    });
                },
                getTurnContext: () => captureCodeContext(options), record: options.record,
                transcript: options.transcript, resolveTranscriptParent: options.resolveTranscriptParent,
                onNativeSessionId(context, id) {
                    const captured = context ?? opening;
                    if (captured.isCurrent()) options.onNativeCursor(id, captured);
                },
                onContextUsage(usage) {
                    options.onContextUsage({ totalTokens: usage.totalTokens, inputTokens: null, cachedInputTokens: null,
                        outputTokens: null, reasoningOutputTokens: null, processedTokens: null,
                        modelContextWindow: usage.modelContextWindow, updatedAt: usage.updatedAt });
                },
                onMetadata(context, metadata) {
                    if (context.isCurrent() && metadata.sessionId) options.onNativeCursor(metadata.sessionId, context);
                },
            }); } finally { creationFinished = true; }
            let exited = false;
            const exit = (error: Error | null) => {
                if (exited) return;
                exited = true;
                options.onExit(error);
            };
            const unlisten = runtime.onExit(code => exit(code === 0 ? null : new Error(runtime.lastError ?? 'code_claude_exit')));
            let closing: Promise<void> | undefined;
            const close = (): Promise<void> => {
                if (closing) return closing;
                options.signal.removeEventListener('abort', abort);
                closing = Promise.resolve().then(() => runtime.close()).then(() => exit(null), error => {
                    exit(error instanceof Error ? error : new Error('code_claude_close_failed'));
                    throw error;
                }).finally(unlisten);
                return closing;
            };
            const abort = () => { void close().catch(() => { /* close reports the owned failure */ }); };
            options.signal.addEventListener('abort', abort, { once: true });
            try {
                if (options.signal.aborted || !opening.isCurrent() || !runtime.alive) throw new Error('code_provider_open_aborted');
                if (runtime.nativeSessionId) options.onNativeCursor(runtime.nativeSessionId, opening);
                return {
                    get nativeSessionId() { return runtime.nativeSessionId; },
                    get lastTurnFailureText() { return runtime.lastTurnFailureText; },
                    setPermissionMode: (mode: CodePermissionMode) => runtime.setPermissionMode(claudeCodePermissionMode(mode)),
                    reconfigure: async (next: CodeLiveSettings, previous: CodeLiveSettings) => {
                        // Before any SDK call: a running turn or a close owns the query.
                        if (closing || !runtime.idle) {
                            throw new CodeStoreError('session_busy', 'Stop the current turn before changing session settings', 409);
                        }
                        const refusal = claudeModelGateMessage(dependencies.binary(), next.model);
                        if (refusal) throw new Error(refusal);
                        const tuple = (value: CodeLiveSettings) => ({ model: value.model, effort: claudeEffort(value.effort) ?? null });
                        return runtime.reconfigure(tuple(next), tuple(previous));
                    },
                    get alive() { return !closing && runtime.alive; },
                    get closed() { return !runtime.alive && runtime.activeProcessCount === 0; },
                    send(text, sendOptions) {
                        const context = captureCodeContext(options);
                        if (!runtime.idle || closing) throw new Error('code_claude_not_idle');
                        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('claude_prompt_limit');
                        // SDK startup may not reveal its native ID until the first input is offered.
                        if (!runtime.nativeSessionId && options.nativeCursor === null) options.onNativeCursor(null, context);
                        // The turn's rollback boundary is the native input's own identity.
                        return runtime.send({ text }, () => {}, sendOptions?.promptUuid === undefined ? {} : { uuid: sendOptions.promptUuid });
                    },
                    // The only busy-session input path; a refusal is returned, never turned into success.
                    async steer(text) {
                        if (closing || !runtime.alive) return { accepted: false, turnId: '', reason: 'not-current' };
                        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('claude_prompt_limit');
                        const result = await runtime.steer({ text });
                        if (result.accepted) return { accepted: true, turnId: result.turnId, ...(result.nativeId ? { nativeId: result.nativeId } : {}) };
                        const reason = result.reason === 'queue-full' || result.reason === 'not-ready' ? result.reason : 'not-current';
                        return { accepted: false, turnId: result.turnId, reason };
                    },
                    unconsumedFollowUps: () => runtime.unconsumedFollowUps(),
                    cancel: () => close(), close,
                };
            } catch (error) { await close(); throw error; }
        },
    };
}
