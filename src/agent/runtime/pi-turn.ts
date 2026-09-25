import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import { appendBoundedFullText } from '../events/fulltext-bound.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {};

function assistant(value: unknown): Omit<RuntimeTurnOutcome, 'partialText'> & { text: string | null } | null {
    const message = record(value);
    if (message['role'] !== 'assistant') return null;
    const content = message['content'];
    let text: string | null = null, tool = false, oversized = false, invalid = !Array.isArray(content);
    for (const part of Array.isArray(content) ? content : []) {
        const block = record(part);
        if (block['type'] === 'toolCall') { tool = true; continue; }
        if (block['type'] === 'thinking') continue;
        if (block['type'] !== 'text' || typeof block['text'] !== 'string') { invalid = true; continue; }
        if (block['text'] === '') { text ??= ''; continue; }
        const bounded = appendBoundedFullText(text ?? '', block['text']);
        text = bounded.text; oversized ||= bounded.truncated;
    }
    const reason = message['stopReason'];
    const status = reason === 'aborted' ? 'stopped'
        : !invalid && !oversized && (reason === 'stop' || reason === 'toolUse') ? 'done' : 'error';
    return { text, status, finalText: status === 'done' && reason === 'stop' && !tool ? text : null };
}

/** agent_settled entered upstream RPC in 0.80.4; willRetry existed before it. */
export function piSupportsSettled(version: string): boolean {
    const match = /^(?:pi\s+)?v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(version.trim());
    if (!match) return false;
    const [, major, minor, patch] = match;
    return Number(major) > 0 || Number(minor) > 80 || (Number(minor) === 80 && Number(patch) >= 4);
}

/** Per admitted RPC prompt; no journal, session IDs, raw snapshots or callbacks retained. */
export class PiTurnAccumulator {
    private partial = '';
    private current = '';
    private runText = '';
    private completed = 0;
    private candidate: Omit<RuntimeTurnOutcome, 'partialText'> = { status: 'done', finalText: null };
    private ended = false;
    private frameLost = false;

    constructor(private readonly settledProtocol: boolean) {}

    private append(text: string): string {
        const previous = this.partial.length;
        this.partial = appendBoundedFullText(this.partial, text).text;
        this.runText = appendBoundedFullText(this.runText, text).text;
        this.current = appendBoundedFullText(this.current, text).text;
        return text.slice(0, this.partial.length - previous);
    }

    private reconcile(text: string | null): string {
        // Snapshots echo prior deltas. A changed snapshot still owns finalText,
        // but must not rewrite or duplicate already accepted salvage bytes.
        if (text === null || !text.startsWith(this.current)) return '';
        return this.append(text.slice(this.current.length));
    }

    observe(value: unknown): { text: string; done: boolean } {
        if (this.ended) return { text: '', done: false };
        const row = record(value);
        let text = '';
        if (row['type'] === 'agent_start') {
            this.current = ''; this.runText = ''; this.completed = 0;
            this.candidate = { status: 'done', finalText: null };
        } else if (row['type'] === 'message_start' && record(row['message'])['role'] === 'assistant') {
            this.current = '';
            this.candidate = { status: 'error', finalText: null };
        } else if (row['type'] === 'message_update') {
            const event = record(row['assistantMessageEvent']);
            const role = record(row['message'])['role'];
            if ((role === undefined || role === 'assistant') && event['type'] === 'text_delta' && typeof event['delta'] === 'string') {
                text = this.append(event['delta']);
            }
        } else if (row['type'] === 'message_end') {
            const message = assistant(row['message']);
            if (message) {
                text = this.reconcile(message.text);
                this.candidate = { status: message.status, finalText: message.finalText };
                this.completed++;
                this.current = '';
            }
        } else if (row['type'] === 'agent_end') {
            text = this.terminal(row['messages']);
            this.ended = !this.settledProtocol && row['willRetry'] !== true;
        } else if (row['type'] === 'agent_settled') {
            this.ended = true;
        }
        return { text, done: this.ended };
    }

    private terminal(value: unknown): string {
        if (!Array.isArray(value)) {
            this.candidate = { status: this.candidate.status === 'stopped' ? 'stopped' : 'error', finalText: null };
            return '';
        }
        let index = 0, added = '';
        // Without message_end boundaries, the aggregate snapshot echoes the
        // low-level run's stream. Consume that prefix by offset, not text identity.
        let streamed = this.completed === 0 ? this.runText : '';
        // An empty/tool-only terminal cannot erase an observed failure. Only
        // an actual assistant snapshot can supply a newer completion status.
        this.candidate = { status: this.candidate.status, finalText: null };
        for (const entry of value) {
            const message = assistant(entry);
            if (!message) continue;
            this.candidate = { status: message.status, finalText: message.finalText };
            if (index++ < this.completed) continue;
            if (this.completed === 0) {
                const snapshot = message.text ?? '';
                const consumed = Math.min(streamed.length, snapshot.length);
                this.current = streamed.slice(0, consumed);
                streamed = streamed.slice(consumed);
            }
            added = appendBoundedFullText(added, this.reconcile(message.text)).text;
            this.current = '';
        }
        this.completed = index;
        return added;
    }

    /** A dropped oversized frame means this turn's protocol record is incomplete. */
    markFrameLost(): void {
        this.frameLost = true;
    }

    snapshot(status?: RuntimeTurnOutcome['status']): RuntimeTurnOutcome {
        if (this.frameLost && !status) return { status: 'error', finalText: null, partialText: this.partial };
        return { status: status ?? this.candidate.status,
            finalText: status ? null : this.candidate.finalText, partialText: this.partial };
    }
}

/** Only this local carrier can supply failure outcome; arbitrary Error fields cannot. */
export class PiRuntimeError extends Error {
    readonly runtimeOutcome: RuntimeTurnOutcome;
    constructor(cause: Error, outcome: RuntimeTurnOutcome) {
        super(cause.message, { cause });
        this.name = 'PiRuntimeError';
        this.runtimeOutcome = { ...outcome };
    }
}

export function piFailureOutcome(error: unknown): RuntimeTurnOutcome | undefined {
    if (!(error instanceof PiRuntimeError) || !Object.hasOwn(error, 'runtimeOutcome')) return undefined;
    return { ...error.runtimeOutcome };
}
