import type { ChildProcess } from 'node:child_process';
import type { RuntimeCapabilities, RuntimeEvent, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import { FULLTEXT_MAX_CHARS } from '../events/fulltext-bound.js';
import type { PiPromptResult, PiRuntimeEvent } from '../pi-runtime.js';
import type { NativeRuntimeSession, RuntimeInputAcceptance, RuntimePrompt } from './session.js';
import { PiRuntimeError } from './pi-turn.js';
import type { RuntimeEnd, RuntimeProjection } from './projection.js';

export interface PiSessionTransport {
    readonly child: ChildProcess;
    readonly alive: boolean;
    readonly abortEffective: boolean;
    sessionId: string | null;
    sendPrompt(message: string, opts?: {
        effort?: string;
        onEvent?: (event: PiRuntimeEvent) => void;
        onRawRecord?: (record: unknown) => void;
    }): Promise<PiPromptResult>;
    abort(): Promise<void>;
    close(): Promise<void> | void;
    kill(): void;
}

export interface PiRuntimeTurnContext {
    turnId: string;
    isCurrent?: () => boolean;
}

export interface PiRuntimeSessionOptions {
    lifetime: 'pooled' | 'oneshot';
    getTurnContext(): PiRuntimeTurnContext;
    deferTurnEnd?: boolean;
    provider?: 'pi';
    projection?: RuntimeProjection;
    effort?: string;
    onPiEvent?: (event: PiRuntimeEvent) => void;
    onRawRecord?: (record: unknown) => void;
    onFailure?: (error: Error) => void;
}

type Pending = { turnId: string; outcome: RuntimeTurnOutcome; claimed?: RuntimeTurnOutcome };

function snapshot(outcome: RuntimeTurnOutcome): RuntimeTurnOutcome {
    return Object.freeze({ status: outcome.status, finalText: outcome.finalText, partialText: outcome.partialText });
}

function outcomeFromResult(result: PiPromptResult, cancelled: boolean): RuntimeTurnOutcome {
    if (cancelled) {
        return snapshot({
            status: 'stopped',
            finalText: null,
            partialText: result.runtimeOutcome?.partialText ?? result.text ?? '',
        });
    }
    if (result.runtimeOutcome) return snapshot(result.runtimeOutcome);
    return snapshot({ status: 'done', finalText: result.text || null, partialText: result.text || '' });
}

/** One resident Pi transport; every send captures the host turnId (never a private UUID). */
export class PiRuntimeSession implements NativeRuntimeSession {
    readonly capabilities: RuntimeCapabilities;
    private pending: Pending | null = null;
    private sending = false;
    private finalizing = false;
    private closing = false;
    private cancelled = false;
    private capturedTurnId: string | null = null;

    constructor(private readonly transport: PiSessionTransport, private readonly options: PiRuntimeSessionOptions) {
        this.capabilities = Object.freeze({
            transport: 'native',
            steer: 'restart',
            resume: true,
            tools: true,
            toolOutput: true,
            approvals: false,
            questions: false,
            images: false,
            subagents: false,
        });
    }

    get alive(): boolean { return !this.closing && this.transport.alive; }
    get nativeSessionId(): string { return this.transport.sessionId ?? ''; }

    async send(prompt: RuntimePrompt, _onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnOutcome> {
        if (this.sending || this.pending) throw new Error('pi_runtime_busy');
        if (typeof prompt.text !== 'string' || prompt.text.length > FULLTEXT_MAX_CHARS || prompt.images?.length) {
            throw new Error('pi_runtime_prompt_unsupported');
        }
        const turnId = this.options.getTurnContext().turnId;
        if (typeof turnId !== 'string' || !turnId) throw new Error('pi_runtime_missing_turn');
        this.capturedTurnId = turnId;
        this.sending = true;
        this.cancelled = false;
        let outcome: RuntimeTurnOutcome;
        try {
            const result = await this.transport.sendPrompt(prompt.text, {
                ...(this.options.effort ? { effort: this.options.effort } : {}),
                ...(this.options.onPiEvent ? { onEvent: this.options.onPiEvent } : {}),
                ...(this.options.onRawRecord ? { onRawRecord: this.options.onRawRecord } : {}),
            });
            outcome = outcomeFromResult(result, this.cancelled);
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            try { this.options.onFailure?.(failure); }
            catch { console.warn('[jaw:pi] failure observer failed'); }
            if (failure instanceof PiRuntimeError) {
                outcome = snapshot(this.cancelled ? { status: 'stopped', finalText: null, partialText: failure.runtimeOutcome.partialText } : failure.runtimeOutcome);
            } else {
                outcome = snapshot({
                    status: this.cancelled ? 'stopped' : 'error',
                    finalText: null,
                    partialText: '',
                });
            }
        } finally {
            this.sending = false;
        }
        if (this.options.deferTurnEnd !== false) this.pending = { turnId, outcome };
        else this.options.projection?.close({ kind: 'turn-end', status: outcome.status, finalText: outcome.finalText });
        return outcome;
    }

    claimTurnOutcome(turnId: string): RuntimeTurnOutcome | null {
        const pending = this.pending;
        if (!pending || pending.turnId !== turnId) return null;
        if (!pending.claimed) {
            if (this.options.lifetime === 'pooled' && !this.transport.alive && pending.outcome.status === 'done') {
                pending.outcome = snapshot({ ...pending.outcome, status: 'error', finalText: null });
            }
            pending.claimed = snapshot(pending.outcome);
        }
        return pending.claimed;
    }

    finalizeTurn(turnId: string, end: RuntimeEnd): boolean {
        const pending = this.pending;
        if (!pending || !pending.claimed || this.finalizing || pending.turnId !== turnId) return false;
        if (end.kind !== 'turn-end' || !['done', 'error', 'stopped'].includes(end.status)
            || (end.finalText !== null && (typeof end.finalText !== 'string' || end.finalText.length > FULLTEXT_MAX_CHARS))
            || (end.status === 'done' && pending.claimed.status !== 'done')) return false;
        this.finalizing = true;
        this.pending = null;
        try {
            this.options.projection?.close({
                kind: 'turn-end',
                status: end.status,
                finalText: end.finalText,
                ...(end.error === undefined ? {} : { error: end.error }),
            });
            return true;
        } finally { this.finalizing = false; }
    }

    async steer(_prompt: RuntimePrompt): Promise<RuntimeInputAcceptance> {
        return {
            mode: 'restart',
            accepted: false,
            turnId: this.capturedTurnId ?? this.options.getTurnContext().turnId ?? '',
            reason: 'Use application restart steering',
        };
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        if (this.pending && !this.pending.claimed) {
            this.pending.outcome = snapshot({ ...this.pending.outcome, status: 'stopped', finalText: null });
        }
        if (this.options.lifetime === 'pooled') {
            if (this.transport.abortEffective) {
                try { await this.transport.abort(); return; } catch { /* fall through to kill */ }
            }
            this.transport.kill();
            return;
        }
        if (this.transport.abortEffective) {
            try { await this.transport.abort(); } catch { /* oneshot still kills */ }
        }
        this.transport.kill();
    }

    async respond(): Promise<void> {
        throw new Error('pi_runtime_no_permission_rpc');
    }

    async close(): Promise<void> {
        this.closing = true;
        this.cancelled = true;
        await this.transport.close();
    }
}
