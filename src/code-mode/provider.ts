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
    /** Claude only: adaptive thinking on/off; null for providers without the switch. */
    thinking: boolean | null;
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

/** What a resident runtime may change in place; thinking is fixed at open. */
export type CodeLiveSettings = { model: string; effort: string | null };

export interface CodeProviderSession extends CodeRuntimeResource {
    readonly nativeSessionId: string;
    readonly alive: boolean;
    /** True only when owned native resources have actually exited/drained. */
    readonly closed: boolean;
    send(text: string): Promise<RuntimeTurnOutcome>;
    /**
     * Optional (Claude): offer one follow-up to the running turn. It throws only before
     * dispatch; `nativeId` names the offered input for `unconsumedFollowUps`.
     */
    steer?(text: string): Promise<{ accepted: boolean; turnId: string; nativeId?: string;
        reason?: 'queue-full' | 'not-current' | 'not-ready' }>;
    /** Optional (Claude): accepted follow-ups of the current or last turn that no native result consumed. */
    unconsumedFollowUps?(): readonly string[];
    /** Optional: the specific reason the last turn failed, when the runtime names one. */
    readonly lastTurnFailureText?: string | null;
    /** Optional: switch the resident runtime's permission mode without restarting it (Claude). */
    setPermissionMode?(mode: CodePermissionMode): Promise<void>;
    /** Optional: change model and effort on the idle resident runtime (Claude); busy answers `session_busy`. */
    reconfigure?(next: CodeLiveSettings, previous: CodeLiveSettings): Promise<void>;
    cancel(): Promise<void>;
    close(): Promise<void>;
}

export interface CodeProvider {
    readonly id: CodeProviderId;
    describe(): CodeProviderCatalog;
    open(options: CodeOpenOptions): Promise<CodeProviderSession>;
}

export type CodeProviders = Readonly<Record<CodeProviderId, CodeProvider>>;
