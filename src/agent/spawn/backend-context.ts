// Values a spawnAgent backend branch reads. spawnAgent captures them once, right
// before dispatching to a backend; no binding listed here is reassigned after that
// point, so a captured value is the value the in-place branch used to read.
import type { ChildProcess } from 'child_process';
import type { settings } from '../../core/config.js';
import type { CliDetection } from '../../core/cli-detect.js';
import type { RuntimeTransport } from '../../shared/runtime-contract.js';
import type { SpawnContext, ToolEntry } from '../../types/agent.js';
import type { SessionOwnerToken } from '../session-persistence.js';
import type { QueueController } from './queue.js';
import type { MainRunState, SpawnOpts, SpawnPromiseResult } from './types.js';

/** Per-CLI settings values are untyped at the source (`settings` is a free-form record). */
type SettingsValue = (typeof settings)[string];

export interface SpawnBackendLocals {
    agentLabel: string;
    bucketSessionId: string | null;
    cfg: SettingsValue;
    chatSessionId: string;
    cleanupPiEmployee: () => void;
    cli: string;
    codexMultiplexMain: boolean;
    currentBucket: string;
    detected: CliDetection;
    effectiveLiveScope: string | null;
    effectiveProvider: string;
    effort: SettingsValue;
    empSid: string | null;
    empTag: { isEmployee: boolean } | { isEmployee?: never };
    forceNew: boolean;
    historyBlock: string;
    isEmployee: boolean;
    isResume: boolean;
    liveScope: string;
    mainManaged: boolean;
    mainRun: MainRunState | undefined;
    model: SettingsValue;
    opts: SpawnOpts;
    origin: string;
    ownerGeneration: number;
    parentLiveScopeForChild: string | null;
    permissions: SettingsValue;
    persistenceOwner: SessionOwnerToken;
    prompt: string;
    promptForArgs: string;
    promptForSnapshot: string;
    resolve: (value: SpawnPromiseResult) => void;
    resolvedAgyPrintTimeoutMs: number;
    resultPromise: Promise<SpawnPromiseResult>;
    resumeKey: string | null;
    resumeSessionId: string | null;
    runPin: Record<string, unknown>;
    runtimeModel: SettingsValue;
    runtimeTransport: RuntimeTransport;
    scopeKey: string;
    slackToolGrant: string | undefined;
    spawnCwd: SettingsValue;
    spawnEnv: NodeJS.ProcessEnv;
    sysPrompt: string;
    traceAudience: 'public' | 'internal';
}

/** Module-level spawn.ts state and helpers the backends use. */
export interface SpawnBackendHost {
    CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS: number;
    DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS: number;
    DEFAULT_CODEX_APP_TURN_ABS_MS: number;
    DEFAULT_CODEX_APP_TURN_IDLE_MS: number;
    STDERR_BUF_CAP: number;
    activeMainProcesses: Map<string, MainRunState>;
    activeProcesses: Map<string, ChildProcess>;
    appendParentLiveRunTool: (ctx: SpawnContext, tool: ToolEntry) => void;
    broadcastAgentOutput: (ctx: SpawnContext, agentLabel: string, cli: string, text: string, empTag: Record<string, unknown>, audience: 'public' | 'internal') => void;
    buildHistoryBlock: (currentPrompt: string, workingDir: string | null | undefined, chatSessionId: string, maxSessions?: number, maxTotalChars?: number) => string;
    cancelOwnedPiProcess: (child: ChildProcess, reason?: string) => boolean;
    cleanupEmployeeTmpDir: (cwd: string, workingDir: string, label: string) => void;
    clearMainLiveRunOnStop: (scopeKey: string, reason: string) => void;
    configuredPositiveMs: (value: string | undefined, fallback: number) => number;
    consumeKillReason: (pid: number | undefined) => string | null;
    piProfileFingerprintKey: Buffer;
    processQueue: (scopeKey?: string) => Promise<void>;
    queueCtrl: QueueController;
    registerActiveProcess: (agentLabel: string, child: ChildProcess) => void;
    releaseMainRun: (scopeKey: string, child: ChildProcess | null, ownerGeneration: number) => boolean;
    stoppedBeforeStart: (reason: string | undefined, traceRunId: string) => SpawnPromiseResult;
}
