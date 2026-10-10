import { createHash } from 'node:crypto';
import type { RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { ASIDE_HISTORY_LIMIT, ASIDE_REPL_BYTES, AsideTransportError } from './aside-cli.js';

interface AsideMessage {
    role: string;
    event?: string;
    turnId?: string;
    stopReason?: string;
    completedAt?: number;
    text: string | null;
    receipt: string;
}
export interface AsideReplay {
    sessionId: string;
    status: string;
    messages: readonly AsideMessage[];
    full: boolean;
}
export interface AsideBaseline { sessionId: string | null; anchor: string | null; turnIds: readonly string[] }
export interface AsideInterval { turnId: string; outcome: RuntimeTurnOutcome | null; interrupted: boolean }
function malformed(): never { throw new AsideTransportError('invalid_replay'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
    return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string') return malformed(); return value; }
function contentText(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length > 512) return malformed();
    const texts: string[] = [];
    for (const block of value) {
        const row = record(block);
        if (row['type'] === 'text') texts.push(string(row['text']));
    }
    return texts.length ? texts.join('') : null;
}
/** Parse once at the structured process boundary. Preserve storage order, never timestamps. */
export function parseAsideReplay(value: unknown, sessionId: string): AsideReplay {
    if (Buffer.byteLength(JSON.stringify(value) ?? '') > ASIDE_REPL_BYTES) throw new AsideTransportError('replay_limit');
    const root = record(value), session = record(root['session']), before = record(root['before']);
    if (session['id'] !== sessionId || before['id'] !== sessionId || session['status'] !== before['status']
        || root['order'] !== 'desc' || root['limit'] !== ASIDE_HISTORY_LIMIT || root['truncated'] === true) return malformed();
    const status = string(session['status']);
    const raw = root['messages'];
    if (!Array.isArray(raw) || raw.length > ASIDE_HISTORY_LIMIT) return malformed();
    const messages = [...raw].reverse().map(value => {
        const row = record(value), role = string(row['role']);
        const message: AsideMessage = { role, text: contentText(row['content']), receipt: createHash('sha256').update(JSON.stringify(row)).digest('hex') };
        if (role === 'turn-lifecycle') {
            message.event = string(row['event']); message.turnId = string(row['turnId']);
            if (!message.turnId || message.turnId.length > 128 || !['started', 'finished', 'aborted', 'error'].includes(message.event)) return malformed();
        }
        if (row['stopReason'] !== undefined) message.stopReason = string(row['stopReason']);
        if (row['completedAt'] !== undefined) {
            if (typeof row['completedAt'] !== 'number' || !Number.isFinite(row['completedAt']) || row['completedAt'] <= 0) return malformed();
            message.completedAt = row['completedAt'];
        }
        return Object.freeze(message);
    });
    return Object.freeze({ sessionId, status, messages: Object.freeze(messages), full: raw.length < ASIDE_HISTORY_LIMIT });
}
export function captureAsideBaseline(replay?: AsideReplay): AsideBaseline {
    if (!replay) return Object.freeze({ sessionId: null, anchor: null, turnIds: Object.freeze([]) });
    const last = replay.messages.at(-1);
    if (replay.status !== 'idle' || (last && (last.role !== 'turn-lifecycle' || last.event !== 'finished'))
        || (!last && !replay.full)) throw new AsideTransportError('resume_not_idle');
    return Object.freeze({ sessionId: replay.sessionId, anchor: last?.receipt ?? null,
        turnIds: Object.freeze(replay.messages.filter(m => m.role === 'turn-lifecycle').map(m => m.turnId!)) });
}
function newMessages(replay: AsideReplay, baseline: AsideBaseline): readonly AsideMessage[] {
    if (baseline.sessionId !== null && baseline.sessionId !== replay.sessionId) throw new AsideTransportError('replay_owner_mismatch');
    if (baseline.anchor === null) {
        if (!replay.full) throw new AsideTransportError('replay_truncated');
        return replay.messages;
    }
    const matches = replay.messages.map((m, i) => m.receipt === baseline.anchor ? i : -1).filter(i => i >= 0);
    if (matches.length !== 1) throw new AsideTransportError('baseline_missing');
    return replay.messages.slice(matches[0]! + 1);
}
export function inspectAsideInterval(replay: AsideReplay, baseline: AsideBaseline, capturedTurnId?: string): AsideInterval {
    const messages = newMessages(replay, baseline);
    const lifecycle = messages.filter(m => m.role === 'turn-lifecycle');
    const starts = lifecycle.filter(m => m.event === 'started');
    if (starts.length !== 1 || !starts[0]?.turnId || baseline.turnIds.includes(starts[0].turnId)
        || (capturedTurnId !== undefined && capturedTurnId !== starts[0].turnId)) throw new AsideTransportError('ambiguous_turn');
    const start = starts[0], turnId = start.turnId!;
    const startIndex = messages.indexOf(start);
    // System metadata may precede creation; user/assistant/tool rows cannot precede the owned start.
    if (messages.slice(0, startIndex).some(m => m.role !== 'system-message')) throw new AsideTransportError('unowned_messages');
    const terminals = lifecycle.filter(m => m.event !== 'started');
    if (terminals.length > 1 || terminals.some(m => m.turnId !== turnId)) throw new AsideTransportError('ambiguous_terminal');
    const terminal = terminals[0];
    const body = messages.slice(startIndex + 1, terminal ? messages.indexOf(terminal) : undefined);
    if (body.filter(m => m.role === 'user').length !== 1) throw new AsideTransportError('ambiguous_input');
    if (terminal && messages.at(-1) !== terminal) throw new AsideTransportError('trailing_messages');
    if (!terminal) {
        return { turnId, outcome: null, interrupted: replay.status === 'interrupted' };
    }
    if (body.some(m => m.role === 'error' || m.stopReason === 'error')) {
        return { turnId, outcome: { status: 'error', finalText: null, partialText: '' }, interrupted: false };
    }
    if (terminal.event === 'aborted') return { turnId, outcome: { status: 'stopped', finalText: null, partialText: '' }, interrupted: false };
    if (terminal.event === 'error') return { turnId, outcome: { status: 'error', finalText: null, partialText: '' }, interrupted: false };
    const finals = body.filter(m => m.role === 'assistant' && m.stopReason === 'stop');
    const final = finals[0];
    if (replay.status !== 'idle' || finals.length !== 1 || !final || final.text === null || final.completedAt === undefined
        || body.at(-1) !== final || body.some(m => m.stopReason === 'aborted' || m.stopReason === 'length')) {
        throw new AsideTransportError('incomplete_final');
    }
    return { turnId, outcome: { status: 'done', finalText: final.text, partialText: '' }, interrupted: false };
}
