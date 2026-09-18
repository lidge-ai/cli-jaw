import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventBody } from '../../shared/runtime-contract.js';
import { parseRuntimeEvent } from '../../shared/runtime-event-parse.js';
import { FULLTEXT_MAX_CHARS } from '../events/fulltext-bound.js';
import { recordRuntimeEvent, recordRuntimeProjectionLoss, type RuntimeEventContext } from './events.js';
import type { NativeRuntimeSession, RuntimePrompt, RuntimeTurnResult, RuntimeInputAcceptance } from './session.js';
import { runtimeRequests, type RuntimeRequests } from './requests.js';
import { createClaudeInput } from './claude-sdk-input.js';
import { buildClaudeSdkOptions, type PreparedClaudeOptions } from './claude-sdk-options.js';
import { loadClaudeSdk } from './claude-sdk-loader.js';
import { createClaudeProcessOwner } from './claude-sdk-process.js';
import { createClaudeClose } from './claude-sdk-close.js';
import { createClaudeMetadata, type ClaudeResultMetadata } from './claude-sdk-metadata.js';
import { claudeForegroundHooks } from './claude-sdk-hooks.js';
import type { ClaudeRootWaitOptions } from './claude-sdk-roots.js';
import { RuntimeProjection, type RuntimeEnd, type RuntimeTranscriptObserver } from './projection.js';
import { ClaudeSdkEvents } from './claude-sdk-events.js';
import { createClaudePermissions } from './claude-sdk-permissions.js';
import { makeClaudeUserMessage } from './claude-sdk-content.js';
import { ClaudeSdkChildren, type ClaudeChildOwner } from './claude-sdk-children.js';
import { ClaudeSdkOwners, claudeToolIds } from './claude-sdk-owners.js';

export interface ClaudeTurnContext extends RuntimeEventContext { isCurrent(): boolean }
export type { ClaudeResultMetadata } from './claude-sdk-metadata.js';
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export interface ClaudeSessionOptions {
    prepared: PreparedClaudeOptions;
    getTurnContext(): ClaudeTurnContext;
    promptTimeoutMs: number;
    closeTimeoutMs?: number;
    registry?: RuntimeRequests;
    signal?: AbortSignal;
    deferTurnEnd?: boolean;
    onMetadata?(context: Readonly<ClaudeTurnContext>, metadata: ClaudeResultMetadata): void;
    onNativeSessionId?(context: Readonly<ClaudeTurnContext> | null, id: string): void;
    onSessionCreated?(session: ClaudeSdkSession): void;
    queryFactory?(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
    record?(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
    recordLoss?: typeof recordRuntimeProjectionLoss;
    transcript?(context: RuntimeEventContext): RuntimeTranscriptObserver;
    resolveTranscriptParent?(context: RuntimeEventContext, nativeToolRef: string): string | null;
}
type Turn = {
    context: Readonly<ClaudeTurnContext>; onEvent(event: RuntimeEvent): void;
    resolve(result: RuntimeTurnResult): void; timer: ReturnType<typeof setTimeout>;
    mapper: ClaudeSdkEvents; uuid: ReturnType<typeof randomUUID>; offered: boolean;
    owner: ClaudeChildOwner;
    terminalChildRecording: boolean;
    passiveFinalizing: boolean;
};
const MAX_PROMPT_BYTES = 1024 * 1024;
const RESULT_TYPES = new Set(['success', 'error_during_execution', 'error_max_turns',
    'error_max_budget_usd', 'error_max_structured_output_retries']);
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('claude_invalid_frame');
    return value as Record<string, unknown>;
}
function validTimeout(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('claude_invalid_timeout');
}

/** A query owns one reader; each admitted send owns an immutable jaw turn binding. */
export class ClaudeSdkSession implements NativeRuntimeSession {
    readonly capabilities: RuntimeCapabilities = Object.freeze({ transport: 'native', steer: 'queued', resume: true,
        tools: true, toolOutput: true, approvals: true, questions: true, images: true, subagents: true });
    readonly supportsInterrupt = true;
    // One active turn can own at most one unconsumed, <=1MiB text message.
    private readonly input = createClaudeInput<SDKUserMessage>(1);
    private readonly processes = createClaudeProcessOwner({ onMultipleRoots: () => this.fail('claude_multiple_root_processes') });
    private query: ClaudeQuery | undefined;
    private reader: Promise<void> = Promise.resolve();
    private readonly exits = new Set<(code: number | null) => void>();
    private turn: Turn | null = null;
    private finishing = false;
    private pendingFinal: { turn: Turn; outcome: RuntimeTurnResult; failed?: boolean; claimed?: Readonly<RuntimeTurnResult> } | null = null;
    private id = '';
    private closing = false;
    private closeOperation: (() => Promise<void>) | undefined;
    private failure = false;
    private failureCode: string | null = null;
    private exited = false;
    private readonly registry: RuntimeRequests;
    private readonly terminalIds = new Set<string>();
    private readonly deferredTurnIds = new Set<string>();
    private readonly readMetadata = createClaudeMetadata();
    private readonly owners = new ClaudeSdkOwners();
    private readonly children: ClaudeSdkChildren;
    private readonly permissions: ReturnType<typeof createClaudePermissions>;

    constructor(private readonly options: ClaudeSessionOptions) {
        this.registry = options.registry ?? runtimeRequests;
        this.children = new ClaudeSdkChildren({ resolveParent: id => this.owners.parent(id),
            ...(options.transcript ? { transcript: options.transcript } : {}),
            ...(options.resolveTranscriptParent ? { resolveTranscriptParent: options.resolveTranscriptParent } : {}) });
        this.permissions = createClaudePermissions({ registry: this.registry, permissions: options.prepared.permissions,
            resolveOwner: async id => {
                const turn = this.turn;
                if (!turn || !this.alive || !this.current(turn.context)) return null;
                const owner = this.children.resolveTool(id) ?? await this.owners.resolve(id);
                return this.turn === turn && this.alive && this.current(turn.context) && owner?.isCurrent() ? owner : null;
            } });
    }
    async start(factory: NonNullable<ClaudeSessionOptions['queryFactory']>): Promise<void> {
        if (this.query || this.closing) throw new Error('claude_session_already_started');
        const options = this.options;
        const prepared = buildClaudeSdkOptions(options.prepared);
        try { this.query = factory({ prompt: this.input.stream, options: {
            ...prepared, spawnClaudeCodeProcess: value => this.processes.spawn(value),
            canUseTool: this.permissions.canUseTool,
            forwardSubagentText: true,
            hooks: claudeForegroundHooks(),
        } });
            this.reader = this.read(this.query);
        } catch (error) { this.failure = true; await this.close(); throw error; }
    }
    get alive(): boolean { return this.query !== undefined && !this.closing && !this.failure; }
    get idle(): boolean { return this.alive && this.turn === null && this.pendingFinal === null && !this.finishing; }
    get nativeSessionId(): string { return this.id; }
    get activeProcessCount(): number { return this.processes.activeCount; }
    get stderrBytes(): number { return this.processes.stderrBytes; }
    get lastError(): string | null { return this.failureCode; }
    get primaryChild() { return this.processes.primaryChild; }
    get rootProcessState() { return this.processes.rootProcessState; }
    waitForPrimaryChild(options?: ClaudeRootWaitOptions) { return this.processes.waitForPrimaryChild(options); }

    async send(prompt: RuntimePrompt, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnResult> {
        if (!this.alive) throw new Error('claude_session_closed');
        if (this.terminalIds.size >= 512) throw new Error('claude_terminal_capacity');
        if (this.turn || this.pendingFinal || this.finishing) throw new Error('claude_session_busy');
        if (typeof prompt.text !== 'string' || Buffer.byteLength(prompt.text) > MAX_PROMPT_BYTES) throw new Error('claude_prompt_limit');
        const message = makeClaudeUserMessage(prompt);
        const context = Object.freeze({ ...this.options.getTurnContext() });
        if (!this.current(context)) throw new Error('claude_owner_stale');
        if (!parseRuntimeEvent({ ...context, version: 1, seq: 1, kind: 'turn-start', provider: 'claude' })) {
            throw new Error('claude_invalid_context');
        }
        if (this.options.deferTurnEnd) {
            if (this.deferredTurnIds.has(context.turnId)) throw new Error('claude_turn_identity_reused');
            if (this.deferredTurnIds.size >= 512) throw new Error('claude_turn_identity_capacity');
            this.deferredTurnIds.add(context.turnId);
        }
        let resolve!: (value: RuntimeTurnResult) => void;
        const result = new Promise<RuntimeTurnResult>(yes => { resolve = yes; });
        const projection = new RuntimeProjection(context, (_context, body) => this.recordEvent(turn, body),
            undefined, this.options.transcript?.(context), this.options.recordLoss
                ?? ((this.options.record ?? recordRuntimeEvent) === recordRuntimeEvent ? recordRuntimeProjectionLoss : undefined));
        const turn: Turn = { context, onEvent, resolve, mapper: new ClaudeSdkEvents(projection), uuid: randomUUID(), offered: false,
            passiveFinalizing: false, terminalChildRecording: false,
            owner: { context, projection, isCurrent: () => this.current(context), isActive: () => this.turn === turn && !this.closing,
                canRecordTerminal: () => turn.terminalChildRecording,
                record: (ownerContext, body) => this.recordChildEvent(turn, ownerContext, body) },
            timer: setTimeout(() => this.fail('claude_prompt_timeout'), this.options.promptTimeoutMs) };
        this.turn = turn;
        projection.start('claude');
        if (this.turn !== turn || this.closing) return result;
        if (!this.current(turn.context)) {
            this.settle({ status: 'stopped', finalText: null, partialText: '' });
            this.kill(); return result;
        }
        turn.offered = true;
        if (!this.input.offer({ ...message, uuid: turn.uuid, session_id: this.id })) this.fail('claude_input_closed');
        return result;
    }
    async steer(_prompt: RuntimePrompt): Promise<RuntimeInputAcceptance> {
        return { accepted: false, mode: 'queued', turnId: this.turn?.context.turnId ?? '', reason: 'Use the scoped follow-up policy' };
    }
    async respond(requestId: string, response: unknown): Promise<void> {
        if (!this.turn || !this.alive) throw new Error('request_not_current');
        this.registry.respond(requestId, this.turn.context, response);
    }
    interrupt(): Promise<void> { return this.cancel(); }
    cancel(): Promise<void> {
        if (this.pendingFinal && !this.pendingFinal.claimed && !this.pendingFinal.failed && !this.failure) {
            this.pendingFinal.outcome = { ...this.pendingFinal.outcome, status: 'stopped', finalText: null,
                partialText: this.pendingFinal.outcome.partialText || this.pendingFinal.turn.mapper.interruptedText };
        }
        return this.close();
    }
    getTurnOutcome(turnId: string): RuntimeTurnResult | null {
        const pending = this.pendingFinal;
        return pending?.turn.context.turnId === turnId ? { ...(pending.claimed ?? pending.outcome) } : null;
    }
    /** Captured completion authority only: claiming never reopens input admission. */
    claimTurnOutcome(turnId: string): RuntimeTurnResult | null {
        const pending = this.pendingFinal;
        if (!pending || pending.turn.context.turnId !== turnId) return null;
        pending.claimed ??= Object.freeze({ ...pending.outcome });
        return pending.claimed;
    }
    finalizeTurn(turnId: string, end: RuntimeEnd): boolean {
        const pending = this.pendingFinal;
        if (!pending || pending.turn.context.turnId !== turnId || !pending.claimed) return false;
        if (!end || end.kind !== 'turn-end' || !['done', 'error', 'stopped'].includes(end.status)) return false;
        if (pending.claimed.status !== 'done' && end.status === 'done') return false;
        if (end.finalText !== null && (typeof end.finalText !== 'string' || end.finalText.length > FULLTEXT_MAX_CHARS)) return false;
        if (end.error !== undefined && typeof end.error !== 'string') return false;
        const terminal: RuntimeEnd = { kind: 'turn-end', status: end.status, finalText: end.finalText,
            ...(end.error === undefined ? {} : { error: end.error }) };
        this.pendingFinal = null;
        this.finishing = true; pending.turn.passiveFinalizing = true;
        try { pending.turn.mapper.finish({ ...pending.claimed, status: terminal.status, finalText: terminal.finalText }, terminal); }
        finally { pending.turn.passiveFinalizing = false; this.finishing = false; }
        if (this.deferredTurnIds.size >= 512) void this.close().catch(() => console.warn('[claude-native] cleanup_failed'));
        return true;
    }
    kill(): void { void this.cancel().catch(() => console.warn('[claude-native] cleanup_failed')); }
    onExit(cb: (code: number | null) => void): () => void {
        if (this.exited) { cb(this.failure ? 1 : 0); return () => {}; }
        this.exits.add(cb); return () => { this.exits.delete(cb); };
    }
    private current(context: Readonly<ClaudeTurnContext>): boolean {
        try { return context.isCurrent() === true; } catch { return false; }
    }
    private recordEvent(turn: Turn, body: RuntimeEventBody): RuntimeEvent | null {
        if (!turn.passiveFinalizing && !this.current(turn.context)) return null;
        return this.publishEvent(turn, turn.context, body);
    }
    private recordChildEvent(turn: Turn, context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null {
        const terminal = turn.terminalChildRecording && body.kind === 'tool' && body.status !== 'running';
        if (!terminal && (!turn.owner.isActive() || !this.current(turn.context))) return null;
        return this.publishEvent(turn, context, body);
    }
    private publishEvent(turn: Turn, context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null {
        try {
            const event = (this.options.record ?? recordRuntimeEvent)(context, body);
            if (event) { try { turn.onEvent(event); } catch { console.warn('[claude-native] observer_failed'); } }
            return event;
        } catch { console.warn('[claude-native] projection_failed'); return null; }
    }
    private settle(outcome: RuntimeTurnResult): void {
        const turn = this.turn;
        if (!turn) return;
        if (outcome.status !== 'done' && !outcome.partialText) outcome = { ...outcome, partialText: turn.mapper.interruptedText };
        this.finishing = true;
        this.turn = null; clearTimeout(turn.timer);
        try {
            try { this.registry.cancelRun(turn.context.runId); }
            catch {
                this.failure = true; this.failureCode ??= 'claude_request_cleanup_failed';
                outcome = { status: 'error', finalText: null, partialText: outcome.partialText };
            }
            this.permissions.cancelAll(); this.owners.cancelPending();
            turn.terminalChildRecording = true;
            try { this.children.stopOwner(turn.context, outcome.status === 'error' ? 'error' : 'stopped'); }
            finally { turn.terminalChildRecording = false; this.owners.retire(turn.context); }
            if (this.options.deferTurnEnd) this.pendingFinal = { turn, outcome, failed: outcome.status === 'error' };
            else turn.mapper.finish(outcome);
        } finally {
            this.finishing = false;
            turn.resolve(outcome);
            if (this.failure || this.owners.saturated || this.terminalIds.size >= 512) void this.close().catch(() => console.warn('[claude-native] cleanup_failed'));
        }
    }
    private fail(reason: string): void {
        this.failureCode ??= reason;
        this.failure = true;
        if (this.pendingFinal && !this.pendingFinal.claimed) {
            this.pendingFinal.failed = true;
            this.pendingFinal.outcome = { ...this.pendingFinal.outcome, status: 'error', finalText: null,
                partialText: this.pendingFinal.outcome.partialText || this.pendingFinal.turn.mapper.interruptedText };
        }
        this.settle({ status: 'error', finalText: null, partialText: this.turn?.mapper.interruptedText ?? '' });
        this.kill();
    }
    private async read(query: ClaudeQuery): Promise<void> {
        try {
            for await (const message of query) {
                if (this.closing) break;
                const raw = record(message);
                if (typeof raw['type'] !== 'string') throw new Error('claude_invalid_frame');
                const patch = raw['type'] === 'system' && raw['subtype'] === 'task_updated' ? raw['patch'] : undefined;
                const toolResult = raw['type'] === 'user' ? raw['tool_use_result'] : undefined;
                if ((raw['type'] === 'system' && raw['subtype'] === 'task_started' && raw['is_backgrounded'] === true)
                    || (patch && typeof patch === 'object' && Reflect.get(patch, 'is_backgrounded') === true)
                    || (toolResult && typeof toolResult === 'object' && Reflect.get(toolResult, 'status') === 'async_launched')) {
                    this.fail('claude_background_tasks_unsupported'); break;
                }
                const parent = raw['parent_tool_use_id'];
                if (parent !== undefined && parent !== null) {
                    if (typeof parent !== 'string' || !parent || parent.length > 1024) throw new Error('claude_invalid_parent');
                }
                const childParent = parent !== undefined && parent !== null;
                const resultId = raw['type'] === 'result' ? raw['uuid'] : undefined;
                if (resultId !== undefined && (typeof resultId !== 'string' || !resultId || resultId.length > 1024)) {
                    throw new Error('claude_invalid_result_id');
                }
                if (!childParent && typeof resultId === 'string' && this.terminalIds.has(resultId)) continue;
                const turn = this.turn;
                if (turn && (!this.current(turn.context) || (!childParent && !this.correlated(raw, turn)))) {
                    this.fail('claude_owner_or_correlation_stale'); break;
                }
                if (turn) {
                    const childOwned = this.children.accept(raw);
                    if (this.closing || this.turn !== turn) continue;
                    if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                    if (childOwned) {
                        this.children.reconcile();
                        if (this.closing || this.turn !== turn) continue;
                        if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                    }
                    for (const [id, owner] of this.children.drainToolOwners()) this.owners.bind(id, owner);
                    this.owners.resolvePending(id => this.children.resolveTool(id));
                    if (childOwned) continue;
                }
                if (childParent) continue; // Idle child traffic cannot prelink into a later send.
                if (raw['type'] === 'system' && raw['subtype'] === 'init' && this.options.prepared.permissions === 'safe'
                    && raw['permissionMode'] !== 'default') { this.fail('claude_safe_mode_not_confirmed'); break; }
                if (raw['type'] === 'system' && raw['subtype'] === 'init') {
                    const id = raw['session_id'];
                    if (typeof id === 'string' && id && id.length <= 1024) {
                        this.id = id;
                        if (this.options.onNativeSessionId) {
                            try { this.options.onNativeSessionId(turn?.context ?? null, id); }
                            catch { console.warn('[claude-native] native_session_id_observer_failed'); }
                            if (this.closing || this.turn !== turn) continue;
                            if (turn && !this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                        }
                    }
                }
                if (typeof resultId === 'string') {
                    if (this.terminalIds.size >= 512) { this.fail('claude_terminal_capacity'); break; }
                    this.terminalIds.add(resultId);
                    if (!turn && this.terminalIds.size >= 512) void this.close().catch(() => console.warn('[claude-native] cleanup_failed'));
                }
                if (!turn) continue;
                if (raw['type'] === 'result' && raw['subtype'] === 'success' && raw['is_error'] === false
                    && raw['num_turns'] === 0 && raw['user_message_uuid'] === undefined && raw['user_message_uuids'] === undefined) continue;
                for (const id of claudeToolIds(raw)) this.owners.bind(id, { context: turn.context,
                    isCurrent: () => turn.owner.isCurrent() && turn.owner.isActive(),
                    emit: body => { this.recordEvent(turn, body); } }, turn.owner);
                this.accept(raw, turn);
                if (this.turn === turn && !this.closing && this.current(turn.context)) {
                    this.children.reconcile();
                    if (this.closing || this.turn !== turn) continue;
                    if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                    for (const [id, owner] of this.children.drainToolOwners()) this.owners.bind(id, owner);
                    this.owners.resolvePending(id => this.children.resolveTool(id));
                }
            }
            if (!this.closing) this.fail('claude_eof');
        } catch (error) {
            if (!this.closing) this.fail(
                error instanceof Error && error.message === 'Malformed Claude SDK frame'
                    ? 'claude_sdk_frame_malformed'
                    : 'claude_reader_failed',
            );
        }
        finally { this.input.close(); }
    }
    private accept(raw: Record<string, unknown>, turn: Turn): void {
        if (raw['type'] === 'result') {
            if (typeof raw['subtype'] !== 'string' || !RESULT_TYPES.has(raw['subtype']) || typeof raw['is_error'] !== 'boolean') {
                throw new Error('claude_invalid_result');
            }
            const status = raw['subtype'] === 'success' && raw['is_error'] === false ? 'done' : 'error';
            const value = raw['result'];
            if (status === 'done' && value !== undefined && value !== null && typeof value !== 'string') {
                throw new Error('claude_invalid_final');
            }
            const finalText = status === 'done' && typeof value === 'string' ? value : null;
            if (finalText !== null && finalText.length > FULLTEXT_MAX_CHARS) throw new Error('claude_final_limit');
        }
        const outcome = turn.mapper.accept(raw);
        if (this.closing || this.turn !== turn) return;
        if (!this.current(turn.context)) { this.fail('claude_owner_stale'); return; }
        if (!outcome) return;
        const nativeId = raw['session_id'];
        if (typeof nativeId === 'string' && nativeId && nativeId.length <= 1024) this.id = nativeId;
        const metadata = this.readMetadata(raw, outcome.status === 'done', this.id);
        try { this.options.onMetadata?.(turn.context, metadata); } catch { console.warn('[claude-native] metadata_failed'); }
        if (this.closing || this.turn !== turn) return;
        if (!this.current(turn.context)) { this.fail('claude_owner_stale'); return; }
        this.settle(outcome);
    }
    private correlated(raw: Record<string, unknown>, turn: Turn): boolean {
        if (!turn.offered) return false;
        const id = raw['user_message_uuid'], ids = raw['user_message_uuids'];
        if (ids !== undefined) {
            if (!Array.isArray(ids) || ids.length > 64 || ids.some(value => typeof value !== 'string')) return false;
            return ids.includes(turn.uuid);
        }
        return id === undefined || id === turn.uuid;
    }
    close(): Promise<void> {
        let outcome: RuntimeTurnResult;
        this.closeOperation ??= createClaudeClose({ timeoutMs: this.options.closeTimeoutMs ?? 5000,
            fence: () => {
                this.closing = true;
                outcome = { status: this.failure ? 'error' : 'stopped', finalText: null, partialText: this.turn?.mapper.interruptedText ?? '' };
            },
            startTermination: () => { try { this.query?.close(); } finally { this.processes.terminate(); } },
            settlePending: () => { this.input.close(); this.settle(outcome); this.permissions.cancelAll(); this.owners.close(); },
            readerDone: () => Promise.all([this.reader, this.processes.wait()]),
            onClosed: () => {
                this.exited = true;
                for (const cb of this.exits) { try { cb(this.failure ? 1 : 0); } catch { console.warn('[claude-native] exit_observer_failed'); } }
                this.exits.clear();
            },
        });
        return this.closeOperation();
    }
}

export async function createClaudeSdkSession(options: ClaudeSessionOptions): Promise<ClaudeSdkSession> {
    const captured: ClaudeSessionOptions = { ...options, prepared: { ...options.prepared } };
    const env = captured.prepared.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) captured.prepared.env = { ...env };
    validTimeout(captured.promptTimeoutMs); validTimeout(captured.closeTimeoutMs ?? 5000);
    buildClaudeSdkOptions(captured.prepared);
    if (captured.signal?.aborted) throw new Error('claude_acquire_aborted');
    const factory = captured.queryFactory ?? (await loadClaudeSdk()).query;
    if (captured.signal?.aborted) throw new Error('claude_acquire_aborted');
    const session = new ClaudeSdkSession(captured);
    if (captured.onSessionCreated) {
        try { captured.onSessionCreated(session); }
        catch (error) { await session.close(); throw error; }
    }
    await session.start(factory);
    if (captured.signal?.aborted) { await session.close(); throw new Error('claude_acquire_aborted'); }
    if (!session.alive) { await session.close(); throw new Error(session.lastError ?? 'claude_acquire_failed'); }
    return session;
}
