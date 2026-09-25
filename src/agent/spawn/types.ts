// Types shared by spawnAgent (src/agent/spawn.ts) and its backend modules.
// Kept in a leaf module so backends never import spawn.ts.
import type { ChildProcess } from 'child_process';
import type { PolicyVerdict } from '../../core/policy-hooks.js';
import type { RemoteTarget } from '../../messaging/types.js';
import type { RuntimeLivenessIdentity, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { SpawnContext } from '../../types/agent.js';
import type { MainReplacementResult } from '../runtime/replace-turn.js';
import type { RuntimePrompt } from '../runtime/session.js';

// Current Boss main session context — set when a mainManaged spawnAgent starts,
// cleared on exit. Used by dispatch routes to capture the original channel
// (web/telegram/discord + chatId) so that disconnected worker results can be
// replayed to the correct scope instead of defaulting to 'system'.
export interface MainSessionMeta {
    origin: string;
    permissions?: string | string[];
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    replyViaTarget?: boolean;
    scopeId?: string;
    chatSessionId?: string;
    remoteKey?: string;
    cli?: string;
    model?: string;
    effectiveProvider?: string;
    policyVerdicts?: PolicyVerdict[];
}

export type MainRunState = {
    process: ChildProcess | null;
    starting: boolean;
    steering: boolean;
    ownerGeneration: number;
    meta: MainSessionMeta;
    cancelPending?: (reason: string) => void;
    cancelTurn?: (reason: string) => void;
    /**
     * In-band same-turn steer for runtimes that support it (codex-app turn/steer).
     * Installed only while a steerable turn is actually in flight, so its mere
     * presence is the capability check. 'unavailable' = race/lost turn (caller
     * queues); 'rejected' = the turn kind rejects steer (review/compact; caller
     * queues with a reason broadcast).
     */
    steerTurnInBand?: (text: string) => Promise<'steered' | 'unavailable' | 'rejected'>;
    /** Native local-dispatch hook; failure must never become queued input. */
    replaceTurn?: (text: string, commitInput: () => void) => Promise<MainReplacementResult>;
};

export type SpawnPromiseResult = {
    text: string;
    code: number;
    executionInterrupted?: boolean;
    executionFailed?: boolean;
    runtimeOutcome?: RuntimeTurnOutcome;
    stopCause?: import('./stop-cause.js').StopCause;
    traceRunId?: string;
    agyCheckpointSeen?: boolean;
    agyPlannerOnly?: boolean;
};

export interface CopilotSpawnContext extends SpawnContext {
    thinkingBuf: string;
}

export interface SpawnLifecycle {
    onActivity?: (source: string, identity?: RuntimeLivenessIdentity) => void;
    onExit?: (code: number | null) => void;
}

export interface SpawnOpts {
    images?: RuntimePrompt['images'];
    /** Server-owned canonical lineage, never a native parent/item ID. */
    runtimeParentItemId?: string;
    internal?: boolean;
    _isFallback?: boolean;
    _retryAttempt?: number;  // 429 exponential backoff attempt counter (0-based)
    _isCapacityFallback?: boolean;
    _isSmokeContinuation?: boolean;  // Auto-retry after smoke response detected
    _isGoalContinuation?: boolean;
    _skipInsert?: boolean;
    _skipHistory?: boolean;
    _skipResume?: boolean;
    _skipSessionPersist?: boolean;
    _employeeFreshSessionRetry?: boolean;
    _kiroFreshRetry?: boolean;
    _agyStaleFreshRetry?: boolean;
    forceNew?: boolean;
    agentId?: string;
    sysPrompt?: string;
    origin?: string;
    target?: RemoteTarget;
    requestId?: string;
    replyViaTarget?: boolean;
    employeeSessionId?: string;
    employeeOutputLen?: number;
    chatId?: string | number;
    scopeKey?: string;
    chatSessionId?: string;
    remoteKey?: string;
    cli?: string;
    model?: string;
    effort?: string;
    permissions?: string | string[];
    memorySnapshot?: string;
    workspaceContext?: string;
    env?: Record<string, string>;
    lifecycle?: SpawnLifecycle;
    _settingsGateWaited?: boolean;
    _heartbeatAnchorId?: number;
    /**
     * Salvaged partial output of a steer-interrupted turn. When present, it is
     * prepended to the outgoing prompt (resume and fresh paths alike) via
     * withSteerContext so the follow-up model sees what the interrupted turn
     * had been doing. Empty/undefined keeps prompts byte-identical.
     */
    steerContext?: string;
}

export type SpawnResult = {
    child: ChildProcess | null;
    promise: Promise<SpawnPromiseResult>;
};
