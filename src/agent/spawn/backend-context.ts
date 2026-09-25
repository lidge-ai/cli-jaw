// Values a spawnAgent backend branch reads. spawnAgent captures them once, right
// before dispatching to a backend; no binding listed here is reassigned after that
// point, so a captured value is the value the in-place branch used to read.
// Fields are readonly: a backend writing to the snapshot would diverge silently from
// spawnAgent's own binding, so that write must not compile.
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
    readonly agentLabel: string;
    readonly bucketSessionId: string | null;
    readonly cfg: SettingsValue;
    readonly chatSessionId: string;
    readonly cleanupPiEmployee: () => void;
    readonly cli: string;
    readonly codexMultiplexMain: boolean;
    readonly currentBucket: string;
    readonly detected: CliDetection;
    readonly effectiveLiveScope: string | null;
    readonly effectiveProvider: string;
    readonly effort: SettingsValue;
    readonly empSid: string | null;
    readonly empTag: { isEmployee: boolean } | { isEmployee?: never };
    readonly forceNew: boolean;
    readonly historyBlock: string;
    readonly isEmployee: boolean;
    readonly isResume: boolean;
    readonly liveScope: string;
    readonly mainManaged: boolean;
    readonly mainRun: MainRunState | undefined;
    readonly model: SettingsValue;
    readonly opts: SpawnOpts;
    readonly origin: string;
    readonly ownerGeneration: number;
    readonly parentLiveScopeForChild: string | null;
    readonly permissions: SettingsValue;
    readonly persistenceOwner: SessionOwnerToken;
    readonly prompt: string;
    readonly promptForArgs: string;
    readonly promptForSnapshot: string;
    readonly resolve: (value: SpawnPromiseResult) => void;
    readonly resolvedAgyPrintTimeoutMs: number;
    readonly resultPromise: Promise<SpawnPromiseResult>;
    readonly resumeKey: string | null;
    readonly resumeSessionId: string | null;
    readonly runPin: Record<string, unknown>;
    readonly runtimeModel: SettingsValue;
    readonly runtimeTransport: RuntimeTransport;
    readonly scopeKey: string;
    readonly slackToolGrant: string | undefined;
    readonly spawnCwd: SettingsValue;
    readonly spawnEnv: NodeJS.ProcessEnv;
    readonly sysPrompt: string;
    readonly traceAudience: 'public' | 'internal';
}

/** Module-level spawn.ts state and helpers the backends use. */
export interface SpawnBackendHost {
    readonly CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS: number;
    readonly DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS: number;
    readonly DEFAULT_CODEX_APP_TURN_ABS_MS: number;
    readonly DEFAULT_CODEX_APP_TURN_IDLE_MS: number;
    readonly STDERR_BUF_CAP: number;
    readonly activeMainProcesses: Map<string, MainRunState>;
    readonly activeProcesses: Map<string, ChildProcess>;
    readonly appendParentLiveRunTool: (ctx: SpawnContext, tool: ToolEntry) => void;
    readonly broadcastAgentOutput: (ctx: SpawnContext, agentLabel: string, cli: string, text: string, empTag: Record<string, unknown>, audience: 'public' | 'internal') => void;
    readonly buildHistoryBlock: (currentPrompt: string, workingDir: string | null | undefined, chatSessionId: string, maxSessions?: number, maxTotalChars?: number) => string;
    readonly cancelOwnedPiProcess: (child: ChildProcess, reason?: string) => boolean;
    readonly cleanupEmployeeTmpDir: (cwd: string, workingDir: string, label: string) => void;
    readonly clearMainLiveRunOnStop: (scopeKey: string, reason: string) => void;
    readonly configuredPositiveMs: (value: string | undefined, fallback: number) => number;
    readonly consumeKillReason: (pid: number | undefined) => string | null;
    readonly piProfileFingerprintKey: Buffer;
    readonly processQueue: (scopeKey?: string) => Promise<void>;
    readonly queueCtrl: QueueController;
    readonly registerActiveProcess: (agentLabel: string, child: ChildProcess) => void;
    readonly releaseMainRun: (scopeKey: string, child: ChildProcess | null, ownerGeneration: number) => boolean;
    readonly stoppedBeforeStart: (reason: string | undefined, traceRunId: string) => SpawnPromiseResult;
}
