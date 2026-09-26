import { createClaudeSdkSession, type ClaudeSdkSession } from '../../agent/runtime/claude-sdk-session.js';
import type { PreparedClaudeOptions } from '../../agent/runtime/claude-sdk-options.js';
import type { CodeProvider } from '../provider.js';
import { claudeModelGateMessage } from '../../cli/claude-default-model-boot.js';
import { admitCodeOpen, captureCodeContext, CODE_PROMPT_TIMEOUT_MS, type CodeProviderDependencies } from './acp.js';

function claudeEffort(value: string | null): PreparedClaudeOptions['effort'] {
    if (value === null) return undefined;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    throw new Error('code_provider_effort_unsupported');
}

export function createClaudeCodeProvider(dependencies: CodeProviderDependencies,
    create: typeof createClaudeSdkSession = createClaudeSdkSession): CodeProvider {
    return {
        id: 'claude', describe: dependencies.describe,
        async open(options) {
            admitCodeOpen(options, dependencies);
            if (options.permissionMode === 'read-only') throw new Error('code_provider_policy_unsupported');
            const modelRefusal = claudeModelGateMessage(dependencies.binary(), options.model);
            if (modelRefusal) throw new Error(modelRefusal);
            const opening = captureCodeContext(options);
            const effort = claudeEffort(options.effort);
            let creationFinished = false;
            let runtime: ClaudeSdkSession;
            try { runtime = await create({
                prepared: { cwd: options.cwd, binary: dependencies.binary(), env: dependencies.environment(),
                    model: options.model, systemPrompt: '', fastMode: false,
                    permissions: options.permissionMode === 'auto' ? 'auto' : 'safe',
                    ...(effort === undefined ? {} : { effort }),
                    ...(options.nativeCursor === null ? {} : { resumeSessionId: options.nativeCursor }) },
                signal: options.signal, registry: options.registry, promptTimeoutMs: CODE_PROMPT_TIMEOUT_MS,
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
                    get alive() { return !closing && runtime.alive; },
                    get closed() { return !runtime.alive && runtime.activeProcessCount === 0; },
                    send(text) {
                        const context = captureCodeContext(options);
                        if (!runtime.idle || closing) throw new Error('code_claude_not_idle');
                        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('claude_prompt_limit');
                        // SDK startup may not reveal its native ID until the first input is offered.
                        if (!runtime.nativeSessionId && options.nativeCursor === null) options.onNativeCursor(null, context);
                        return runtime.send({ text }, () => {});
                    },
                    cancel: () => close(), close,
                };
            } catch (error) { await close(); throw error; }
        },
    };
}
