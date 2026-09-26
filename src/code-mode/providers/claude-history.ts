import { isDeepStrictEqual } from 'node:util';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeHistoryHelpers } from '../../agent/runtime/claude-sdk-history-loader.js';
import type { CodeRollbackFork, CodeRollbackInput } from '../provider.js';
import { CodeStoreError } from '../store.js';

/** The helpers parse the whole transcript on the event loop; larger sessions do not roll back. */
export const CLAUDE_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unavailable = (message: string) => new CodeStoreError('rollback_unavailable', message, 409);
const noBoundary = (message: string) => new CodeStoreError('rollback_boundary_unavailable', message, 409);
const conversation = (message: SessionMessage) => message.type === 'user' || message.type === 'assistant';

/**
 * t3code isClaudeHumanTurnStart: a sanity check at a stored boundary, and the proof that no human
 * turn started in a span a missing boundary is passed over. Never used to count turns.
 */
export function isClaudeHumanTurnStart(message: SessionMessage | undefined): boolean {
    if (message?.type !== 'user' || message.parent_tool_use_id !== null) return false;
    const body = message.message;
    if (!body || typeof body !== 'object' || !('content' in body)) return false;
    const content = body.content;
    return typeof content === 'string' || (Array.isArray(content) && content.some((part: unknown) =>
        !!part && typeof part === 'object' && 'type' in part && part.type !== 'tool_result'));
}

async function read<T>(step: () => Promise<T>, message: string): Promise<T> {
    try { return await step(); }
    catch { throw unavailable(message); }
}

/** Only a fresh UUID other than the source is ever deleted; the source session is never touched. */
async function discard(history: ClaudeHistoryHelpers, dir: string, source: string, fork: string): Promise<void> {
    if (!UUID.test(fork) || fork === source) return;
    try { await history.deleteSession(fork, { dir }); }
    catch { console.warn('[code] claude_fork_cleanup_failed'); }
}

/**
 * Where the fork ends: just before the prompt of the first later turn whose boundary is in
 * history, or after the last entry when none is. A later turn without a boundary (a prompt
 * that never reached Claude) and one whose boundary is absent (a prompt stopped before Claude
 * wrote it) are both passed over, but only while no human turn started after the target's
 * prompt: the entries passed over must all belong to the target's own turn. Any other absence
 * means the history moved, and the rollback fails closed.
 */
function forkPoint(messages: SessionMessage[], target: number, later: CodeRollbackInput['later']): number {
    let skipped = false;
    for (const turn of later) {
        if (turn.promptUuid === null) continue;
        const next = messages.findIndex(message => message.uuid === turn.promptUuid);
        if (next < 0) { skipped = true; continue; }
        if (next <= target || !isClaudeHumanTurnStart(messages[next])) throw noBoundary('The next turn is not in the resumable history');
        if (skipped) assertOnlyTargetTurn(messages, target, next);
        return next;
    }
    // No later boundary is in history: the fork keeps everything, which must be the target's turn.
    assertOnlyTargetTurn(messages, target, messages.length);
    return messages.length;
}

function assertOnlyTargetTurn(messages: SessionMessage[], target: number, end: number): void {
    if (messages.slice(target + 1, end).some(isClaudeHumanTurnStart)) {
        throw noBoundary('A later turn is missing from the resumable history');
    }
}

/**
 * Fork the Claude conversation through the target turn, which must be in the history the
 * source resumes from (a compaction after the target fails closed); see `forkPoint` for where
 * it ends. The fork must then reproduce every retained user/assistant body aligned from the
 * end, and kept boundaries are remapped by that aligned position. Any failure after the fork
 * deletes it.
 */
export async function forkClaudeHistory(history: ClaudeHistoryHelpers, input: CodeRollbackInput): Promise<CodeRollbackFork> {
    const { cwd: dir, nativeCursor: source } = input;
    const info = await read(() => history.getSessionInfo(source, { dir }), 'Claude session metadata could not be read');
    if (typeof info?.fileSize !== 'number' || !Number.isSafeInteger(info.fileSize)) throw unavailable('Claude session size is unknown');
    if (info.fileSize > CLAUDE_HISTORY_MAX_BYTES) throw unavailable('Claude session is too large to roll back');
    const messages = await read(() => history.getSessionMessages(source, { dir, includeSystemMessages: true }), 'Claude history could not be read');
    if (!messages.length) throw unavailable('Claude history is empty');
    const at = (uuid: string) => messages.findIndex(message => message.uuid === uuid);
    const target = at(input.target.promptUuid);
    if (target < 0 || !isClaudeHumanTurnStart(messages[target])) {
        throw noBoundary('The target turn is no longer in the resumable history, for example after compaction');
    }
    const next = forkPoint(messages, target, input.later);
    const upToMessageId = messages[next - 1]!.uuid;
    const fork = await read(() => history.forkSession(source, { dir, upToMessageId, ...(input.title ? { title: input.title } : {}) }),
        'Claude history could not be forked');
    const forkCursor = fork?.sessionId;
    if (typeof forkCursor !== 'string' || !UUID.test(forkCursor) || forkCursor === source) throw unavailable('Claude fork has no new identity');
    const drop = () => discard(history, dir, source, forkCursor);
    try {
        const forked = await read(() => history.getSessionMessages(forkCursor, { dir, includeSystemMessages: true }), 'Claude fork could not be read');
        const retained = messages.slice(0, next).filter(conversation), copy = forked.filter(conversation);
        const offset = copy.length - retained.length;
        if (offset < 0 || retained.some((message, index) => {
            const copied = copy[index + offset];
            return copied?.type !== message.type || !isDeepStrictEqual(copied.message, message.message);
        })) throw unavailable('Claude fork did not reproduce the retained conversation');
        const remapped: CodeRollbackFork['remapped'] = [], cleared: string[] = [];
        for (const turn of input.kept) {
            if (turn.promptUuid === null) continue;
            const position = retained.findIndex(message => message.uuid === turn.promptUuid);
            const copied = position < 0 ? undefined : copy[position + offset];
            if (copied?.type === 'user' && UUID.test(copied.uuid)) remapped.push({ turnId: turn.turnId, promptUuid: copied.uuid });
            else cleared.push(turn.turnId);
        }
        if (!remapped.some(turn => turn.turnId === input.target.turnId)) throw unavailable('Claude fork lost the target turn');
        return { forkCursor, remapped, cleared, discard: drop };
    } catch (error) {
        await drop();
        throw error instanceof CodeStoreError ? error : unavailable('Claude fork could not be verified');
    }
}
