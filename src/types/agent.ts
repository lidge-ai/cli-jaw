// ─── Agent Context Types ─────────────────────────────
// Shared type definitions for agent spawn context objects.

import type { WatchdogHandle } from '../agent/watchdog.js';
import type { TracePointer } from '../trace/types.js';
import type { RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import type { ActivityIdentity } from '../shared/presentation.js';
import type { PrintActivityProjection } from '../agent/runtime/print-projection.js';

export interface ToolEntry {
  icon: string;
  rawIcon?: string;
  label: string;
  toolType: string;
  detail?: string;
  /** Bounded purpose explicitly supplied with a tool call; not model reasoning. */
  description?: string;
  stepRef?: string;
  status?: string;
  exitCode?: number;
  isEmployee?: boolean;
  traceRunId?: string;
  traceSeq?: number;
  detailAvailable?: boolean;
  detailBytes?: number;
  rawRetentionStatus?: string;
}

export interface AgyTranscriptError {
  message: string;
  code?: string | number;
  createdAtMs?: number;
}

export type AgyBootstrapAcceptanceMode =
  | 'pending'
  | 'accepted'
  | 'missing'
  | 'not-applicable';

export type AgyTranscriptMode =
  | 'not-started'
  | 'anchored'
  | 'bootstrap-missing'
  | 'fallback-missing'
  | 'fallback-timeout'
  | 'provider-error';

export type AgyLastActivitySource = 'stdout' | 'stderr' | 'transcript' | 'none';

/** Context object created per spawnAgent() invocation. */
export interface SpawnContext {
  /** Captured jaw owner for presentation; sessionId below remains the provider ID. */
  activityIdentity?: ActivityIdentity;
  printActivity?: PrintActivityProjection;
  /** Explicit native result; never inferred from compatibility text or Activity. */
  runtimeOutcome?: RuntimeTurnOutcome;
  /** Private once-only compatibility publication marker, never serialized as an event field. */
  runtimeTerminalAttempted?: boolean;
  fullText: string;
  /** Set when fullText hit FULLTEXT_MAX_CHARS and later output was dropped. */
  fullTextTruncated?: boolean;
  traceLog: string[];
  toolLog: ToolEntry[];
  seenToolKeys: Set<string>;
  hasClaudeStreamEvents: boolean;
  /** Per-message guard: plain `claude` text_delta streamed prose live this message,
   *  so handleClaudeEvent skips the duplicate complete-block append and resets it.
   *  Distinct from run-level hasClaudeStreamEvents (set by ANY content_block_start,
   *  incl tool_use) — that would false-skip a tool-only turn whose prose arrives
   *  only in the complete assistant event. */
  claudeStreamedText?: boolean;
  /** Wall-clock run start; rides on agent_tool broadcasts so the web UI's elapsed
   * timer has one authoritative origin (WP3, zero-seconds bug). */
  runStartedAt?: number;
  /** Identity of the request this run serves, stamped onto agent_tool so a
   *  subscriber can tell its own run's events from a concurrent one's. The bus
   *  cannot supply it: its scope stamp needs multi-session ON and a live ALS
   *  frame, and a child's stdout callback has neither guarantee (#398). */
  requestId?: string;
  /** Transport this run came from, carried alongside requestId for the same reason. */
  origin?: string;
  /** Stream-target offset where the current message's raw text deltas began —
   * consumed by the complete-block reconcile in handleClaudeEvent. */
  claudeStreamedTextStart?: number | undefined;
  sessionId: string | null;
  cost: number | null;
  turns: number | null;
  duration: number | null;
  tokens: Record<string, number> | null;
  stderrBuf: string;
  /** Why this turn failed, in the runtime's own words, when the runtime knows
   *  more than the exit code does. Internally generated, never relayed child
   *  output; lifecycle prefers it over the stderr classification. */
  runtimeDiagnostic?: string;
  hasActiveSubAgent?: boolean;
  showReasoning?: boolean;
  outputTextStarted?: boolean;
  effectiveProvider?: string;
  thinkingBuf?: string;
  liveScope?: string | null;
  parentLiveScope?: string | null;
  _parentSyncedCount?: number;
  traceRunId?: string;
  traceAudience?: 'public' | 'internal';
  /** stepRef → trace pointer, populated at stamp time, so completion handlers can
   *  converge the durable tool row even after the RAM cap evicted the entry.
   * */
  toolTraceIndex?: Map<string, TracePointer>;
  // Phase 3: model/metadata storage
  model?: string;
  metadata?: Record<string, unknown>;
  finishReason?: string;
  pendingOutputChunk?: string;
  grokThoughtBuf?: string;
  grokCurrentThoughtRef?: string;
  grokThoughtSeq?: number;
  grokLastThoughtEmitAt?: number;
  grokLastThoughtEmitChars?: number;
  grokThoughtProgressEmitted?: boolean;
  grokSyntheticToolSeq?: number;
  opencodePreToolText?: string;
  opencodePostToolText?: string;
  opencodeSawToolInStep?: boolean;
  opencodeHadToolErrorInStep?: boolean;
  opencodePendingToolRefs?: string[];
  opencodeTaskCallIds?: Set<string>;
  opencodeStepThinkingToolEmitted?: boolean;
  opencodeRawEvents?: string[];
  opencodeLastEventType?: string;
  opencodeLastEventAt?: number;
  opencodeSpawnAudit?: Record<string, unknown>;
  cursorAssistantText?: string;
  /** Message id of the cursor assistant message currently accumulating into fullText.
   *  A change on a non-delta event is a message boundary (LAST-WINS). */
  cursorAssistantMessageId?: string;
  /** ACP messageId of the assistant message currently accumulating into fullText.
   *  A change is a message boundary (NARRATION-BOUNDARY-01); chunks without an id
   *  carry no signal and accumulate. */
  acpAssistantMessageId?: string;
  cursorAssistantSeq?: number;
  cursorToolCallIds?: Set<string>;
  acpSubagentToolCallIds?: Set<string>;
  acpSubagentLabels?: Map<string, string>;
  // Claude-specific stream buffers (set by events.ts extractFromEvent)
  claudeThinkingBuf?: string;
  claudeInputJsonBuf?: string;
  claudeCurrentToolName?: string;
  claudeILastAssistantId?: string;
  claudeILastAssistantText?: string;
  claudeRateLimitEventSeen?: boolean;
  // Encrypted-thinking detection (opus-4-7: signature_delta only, no thinking_delta)
  claudeThinkingBlockOpen?: boolean;
  claudeThinkingHadDelta?: boolean;
  claudeSignatureLen?: number;
  cliNativeCompactDetected?: boolean;
  stallReason?: string;
  stallWatchdog?: WatchdogHandle;
  agyResumeOffset?: number;
  agyBytesReceived?: number;
  agyTranscriptActive?: boolean;
  agyTranscriptMode?: AgyTranscriptMode;
  agyTranscriptLastReason?: string;
  agyLastActivitySource?: AgyLastActivitySource;
  agyBootstrapSentinel?: string;
  agyBootstrapHash?: string;
  agyBootstrapAccepted?: boolean;
  agyBootstrapAcceptanceMode?: AgyBootstrapAcceptanceMode;
  agyFinalPlannerSeen?: boolean;
  agyFinalPlannerText?: string | undefined;
  agyLastTranscriptError?: AgyTranscriptError | undefined;
  /** Set when agy stdout accumulation hit AGY_FULLTEXT_MAX_CHARS (explicit, not silent). */
  agyFullTextTruncated?: boolean;
  kiroDisplayedText?: string;
  kiroLineBuffer?: string;
  kiroToolSeq?: number;
  kiroActiveToolRef?: string | null;
  kiroActiveToolLabel?: string | null;
  kiroLastVisibleAt?: number;
  kiroHeartbeatSent?: boolean;
  /** Formatted assistant preview text; raw CLI stdout may live separately in fullText. */
  liveOutputText?: string;
  /** Channel of the current codex-app agentMessage item ('commentary' | 'final' | undefined).
   *  Set at item/started, consumed by item/agentMessage/delta to filter commentary
   *  out of fullText so it stays out of agent_done and messaging-channel delivery. */
  codexAppActiveChannel?: string;
  /** Wire item id of the codex-app agentMessage currently accumulating into fullText.
   *  A change of id is a message boundary: LAST-WINS discards the previous message
   *  so progress narration cannot concatenate onto the final answer. */
  codexAppActiveItemId?: string;
  /** True once durable text was appended under an explicit 'final' phase. Protects a
   *  delivered answer from being erased by a trailing commentary/untagged item. */
    codexAppDurableIsFinal?: boolean;
    /** Text the PREVIOUS codex-app item left behind, pending a restatement check.
     *  Set at an item boundary and cleared the moment the new item either covers
     *  it (collapse) or diverges from it (genuine continuation). See #517. */
    codexAppRestatementCandidate?: string | undefined;
    /** The current item's text so far, accumulated only while a candidate is
     *  pending — deltas are token-granular, so the prefix test needs the whole
     *  item rather than one delta. */
    codexAppItemText?: string | undefined;
  scheduleWakeup?: {
    delaySeconds: number;
    prompt: string;
    reason: string;
  };
}

export interface SpawnResult {
  text: string;
  code: number;
  runtimeOutcome?: RuntimeTurnOutcome;
  traceRunId?: string;
  sessionId?: string | null;
  tools?: ToolEntry[];
  cost?: number | null;
  smoke?: string | null;
  diagnostic?: string;
}
