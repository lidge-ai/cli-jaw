import type { RuntimeEvent, RuntimeEventBody, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import type { RuntimeEventContext } from '../agent/runtime/events.js';
import type { RuntimeRequests } from '../agent/runtime/requests.js';
import type { RuntimeTranscriptObserver } from '../agent/runtime/projection.js';
import type { CodeContextUsage, CodePermissionMode, CodeProviderCatalog, CodeProviderId } from './wire.js';

export interface CodeTurnContext extends RuntimeEventContext {
    epoch: number;
    isCurrent(): boolean;
}

export interface CodeRuntimeResource {
    readonly closed: boolean;
    close(): Promise<void>;
}

/** Native adapters receive captured Code ownership, never a Jaw runtime lease. */
export interface CodeOpenOptions {
    sessionId: string;
    cwd: string;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
    nativeCursor: string | null;
    signal: AbortSignal;
    registry: RuntimeRequests;
    /** Register ownership before asynchronous native initialization can fail. */
    onResource(resource: CodeRuntimeResource): void;
    getTurnContext(): CodeTurnContext;
    record(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
    transcript(context: RuntimeEventContext): RuntimeTranscriptObserver;
    resolveTranscriptParent(context: RuntimeEventContext, nativeToolRef: string): string | null;
    onNativeCursor(cursor: string | null, context?: RuntimeEventContext): void;
    /**
     * Latest conversation-wide usage the runtime reported. Held in memory only:
     * it describes a live native process, so a value that outlived that process
     * would be a claim about a session that no longer holds.
     */
    onContextUsage(usage: CodeContextUsage): void;
    onExit(error: Error | null): void;
}

export interface CodeProviderSession extends CodeRuntimeResource {
    readonly nativeSessionId: string;
    readonly alive: boolean;
    /** True only when owned native resources have actually exited/drained. */
    readonly closed: boolean;
    send(text: string): Promise<RuntimeTurnOutcome>;
    /** Optional: the specific reason the last turn failed, when the runtime names one. */
    readonly lastTurnFailureText?: string | null;
    /** Optional: switch the resident runtime's permission mode without restarting it (Claude). */
    setPermissionMode?(mode: CodePermissionMode): Promise<void>;
    cancel(): Promise<void>;
    close(): Promise<void>;
}

export interface CodeProvider {
    readonly id: CodeProviderId;
    describe(): CodeProviderCatalog;
    open(options: CodeOpenOptions): Promise<CodeProviderSession>;
}

export type CodeProviders = Readonly<Record<CodeProviderId, CodeProvider>>;
