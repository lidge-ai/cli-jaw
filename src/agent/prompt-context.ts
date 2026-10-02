// Pure prompt assembly helpers for argv/stdin runtimes.
import type { RuntimeTransport } from '../shared/runtime-contract.js';
import { FULLTEXT_MAX_CHARS } from './events/fulltext-bound.js';

export const PROMPT_HISTORY_MAX_ROWS = 10;
export const PROMPT_HISTORY_MAX_CHARS = 8000;

export const HISTORY_BOUNDARY_INSTRUCTION = [
    '[History Boundary]',
    'Recent Context is read-only background. The Current Message below is the only task to execute now.',
    'Do not continue prior plans, audits, commands, questions, or goals unless the Current Message explicitly asks to resume or continue them.',
].join('\n');

export function withHistoryPrompt(prompt: string, historyBlock: string): string {
    const body = String(prompt || '');
    if (!historyBlock) return body;
    return `${historyBlock}\n\n${HISTORY_BOUNDARY_INSTRUCTION}\n\n---\n[Current Message]\n${body}`;
}

/** Max chars of interrupted-turn partial output reinjected into a follow-up run. */
export const STEER_SALVAGE_MAX_CHARS = 4000;

/**
 * Prepend the salvaged partial output of a steer-interrupted turn.
 *
 * Kill-path steer (explicit /steer, /queue steer) kills the running CLI and
 * starts a fresh run. The vendor session only holds COMPLETED items, so the
 * in-flight partial output would otherwise be invisible to the follow-up model
 * (history injection is skipped on successful native resume). This block makes
 * the interruption and the partial output explicit, in both directions of the
 * resume matrix. Identity of the prompt itself is unchanged when there is no
 * salvage, so non-steer spawns are byte-identical to before.
 */
export function withSteerContext(prompt: string, steerContext?: string | null): string {
    const body = String(prompt || '');
    let salvage = String(steerContext || '').trim();
    if (!salvage) return body;
    let truncated = false;
    if (salvage.length > STEER_SALVAGE_MAX_CHARS) {
        salvage = salvage.slice(-STEER_SALVAGE_MAX_CHARS);
        truncated = true;
    }
    return [
        '[Interrupted Turn Context — cli-jaw steer]',
        'The previous turn was interrupted by a new instruction from the user (steer).',
        'Its partial output before the interruption is below and is INCOMPLETE.',
        'Remember what it was doing, do not repeat completed work, and continue with the current message.',
        '[이전 턴이 사용자의 새 지시(steer)로 중단되었습니다. 아래는 중단 시점까지의 미완성 부분 출력입니다.',
        '완료된 작업을 반복하지 말고, 맥락을 기억한 채 현재 메시지를 이어서 수행하세요.]',
        '',
        '<partial_output>',
        `${truncated ? '... [truncated]\n' : ''}${salvage}`,
        '</partial_output>',
        '',
        '---',
        body,
    ].join('\n');
}

export function shouldBuildHistoryBlock(input: {
    skipHistory: boolean;
    isResume: boolean;
    cli: string;
    codexMultiplexMain: boolean;
}): boolean {
    return !input.skipHistory
        && (input.codexMultiplexMain || !input.isResume || input.cli === 'pi');
}

function isArgvPromptRuntime(cli: string, _effectiveProvider?: string | null): boolean {
    return cli === 'aside' || cli === 'cursor'
        || cli === 'kiro-code'
        || cli === 'grok'
        || cli === 'opencode';
}

function isKiroRuntime(cli: string, _effectiveProvider?: string | null): boolean {
    return cli === 'kiro-code';
}

function withOperationalContext(prompt: string, sysPrompt: string): string {
    return `[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\n${sysPrompt}\n\n---\n\n${prompt}`;
}

export function buildPromptForArgs(input: {
    cli: string;
    effectiveProvider?: string | null;
    runtimeTransport?: RuntimeTransport;
    prompt: string;
    historyBlock: string;
    sysPrompt: string;
    isResume: boolean;
}): string {
    if (isKiroRuntime(input.cli, input.effectiveProvider) && input.isResume) {
        return input.prompt;
    }

    const basePrompt = isArgvPromptRuntime(input.cli, input.effectiveProvider)
        ? withHistoryPrompt(input.prompt, input.historyBlock)
        : input.prompt;

    const needsOperationalContext = input.cli === 'aside' || isKiroRuntime(input.cli, input.effectiveProvider)
        || (input.cli === 'cursor' && input.runtimeTransport === 'native');
    if (needsOperationalContext && input.sysPrompt) {
        return withOperationalContext(basePrompt, input.sysPrompt);
    }

    return basePrompt;
}

/** Run-owned accepted instructions; publish the next copy only after dispatch commits. */
export interface CursorAcceptedContext {
    readonly messages: readonly string[];
    readonly omitted: boolean;
}

const CURSOR_CONTEXT_HEADER = '[Cursor redirect context - read-only]\n';
const CURSOR_ORIGINAL_LABEL = '[Previous request - read-only context]\n';
const CURSOR_ACCEPTED_LABEL = '[Accepted redirect - read-only context]\n';
const CURSOR_CONTEXT_OMITTED = '[Some previous request context was omitted to fit the history limit.]';
const CURSOR_ENTRY_SEPARATOR = '\n\n';

/** Clip only at a UTF-16 boundary; leave user-authored text otherwise untouched. */
function cursorContextSlice(text: string, budget: number, suffix: boolean): string {
    const length = Math.max(0, budget);
    if (text.length <= length) return text;
    let start = suffix ? text.length - length : 0;
    let end = suffix ? text.length : length;
    const splitsPair = (at: number): boolean => at > 0 && at < text.length
        && text.charCodeAt(at - 1) >= 0xD800 && text.charCodeAt(at - 1) <= 0xDBFF
        && text.charCodeAt(at) >= 0xDC00 && text.charCodeAt(at) <= 0xDFFF;
    if (splitsPair(start)) start++;
    if (splitsPair(end)) end--;
    return text.slice(start, Math.max(start, end));
}

/** Bound retained raw instructions independently of the later serialized budget. */
export function appendCursorAcceptedInstruction(context: CursorAcceptedContext, instruction: string): CursorAcceptedContext {
    const candidates = [...context.messages, instruction];
    const first = Math.max(0, candidates.length - (PROMPT_HISTORY_MAX_ROWS - 1));
    const messages: string[] = [];
    let omitted = context.omitted || first > 0;
    let remaining = PROMPT_HISTORY_MAX_CHARS;
    for (let i = candidates.length - 1; i >= first; i--) {
        const message = candidates[i]!;
        const retained = cursorContextSlice(message, remaining, true);
        if (retained.length !== message.length) omitted = true;
        if (retained || !message) messages.push(retained);
        remaining -= retained.length;
    }
    return { messages: messages.reverse(), omitted };
}

function allocateCursorContext(original: string, accepted: CursorAcceptedContext, reserveMarker: boolean): {
    entries: string[]; omitted: boolean;
} {
    const entries: string[] = [];
    const first = Math.max(0, accepted.messages.length - (PROMPT_HISTORY_MAX_ROWS - 1));
    let omitted = accepted.omitted || first > 0;
    let remaining = PROMPT_HISTORY_MAX_CHARS - CURSOR_CONTEXT_HEADER.length
        - (reserveMarker ? CURSOR_ENTRY_SEPARATOR.length + CURSOR_CONTEXT_OMITTED.length : 0);
    const retain = (text: string, label: string, suffix: boolean): void => {
        if (!text) return;
        const overhead = label.length + (entries.length ? CURSOR_ENTRY_SEPARATOR.length : 0);
        const content = cursorContextSlice(text, remaining - overhead, suffix);
        if (content.length !== text.length) omitted = true;
        // A label without any retained content is not a contextual entry.
        if (!content) return;
        entries.push(label + content);
        remaining -= overhead + content.length;
    };
    for (let i = accepted.messages.length - 1; i >= first; i--) {
        retain(accepted.messages[i]!, CURSOR_ACCEPTED_LABEL, true);
    }
    retain(original, CURSOR_ORIGINAL_LABEL, false);
    return { entries: entries.reverse(), omitted };
}

export function buildCursorReplacementPrompt(input: {
    instruction: string;
    originalRequest: string;
    accepted: CursorAcceptedContext;
    partialText: string;
    sysPrompt: string;
}): string {
    // A second allocation reserves the marker before choosing any content.
    let context = allocateCursorContext(input.originalRequest, input.accepted, false);
    if (context.omitted) {
        context = allocateCursorContext(input.originalRequest, input.accepted, true);
        context.entries.push(CURSOR_CONTEXT_OMITTED);
    }
    const historyBlock = CURSOR_CONTEXT_HEADER + context.entries.join(CURSOR_ENTRY_SEPARATOR);
    const prompt = buildPromptForArgs({
        cli: 'cursor', runtimeTransport: 'native', isResume: false,
        prompt: input.instruction, historyBlock, sysPrompt: input.sysPrompt,
    });
    const result = withSteerContext(prompt, input.partialText);
    // Same whole-input contract as AcpRuntimeSession.send: never clip current input.
    if (result.length > FULLTEXT_MAX_CHARS) throw new Error('acp_runtime_prompt_unsupported');
    return result;
}
