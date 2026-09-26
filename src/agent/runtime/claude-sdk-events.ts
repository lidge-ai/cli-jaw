import type { RuntimeTurnResult } from './session.js';
import type { RuntimeProjection, RuntimeEnd } from './projection.js';
import { ClaudeSdkMessages, CLAUDE_MAX_BLOCKS, CLAUDE_INPUT_BYTES, CLAUDE_TEXT_BYTES,
    type ClaudeBlock } from './claude-sdk-messages.js';

type Obj = Record<string, unknown>;
const knownBlocks = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);
const resultTypes = new Set(['success', 'error_during_execution', 'error_max_turns',
    'error_max_budget_usd', 'error_max_structured_output_retries']);
function malformed(): never { throw new Error('Malformed Claude SDK frame'); }

const FAILURE_REASONS: Partial<Record<string, string>> = {
    max_turns: 'reached the turn limit', budget_exhausted: 'reached the budget limit',
    prompt_too_long: 'the prompt is too long for the model context', blocking_limit: 'hit a usage limit',
    rapid_refill_breaker: 'hit a usage limit', model_error: 'the model returned an error',
    api_error: 'the Claude API returned an error', image_error: 'an image could not be processed',
    hook_stopped: 'a hook stopped the turn', stop_hook_prevented: 'a stop hook prevented completion',
    malformed_tool_use_exhausted: 'repeated malformed tool calls', turn_setup_failed: 'the turn could not be set up',
};

/**
 * A failed turn's reason in words, from the SDK's closed vocabularies only
 * (terminal_reason, then the result subtype). Raw `errors` / result text never
 * reach events: they can carry provider or credential detail.
 */
export function describeClaudeFailure(subtype: string, reason: string | null): string {
    const why = (reason && FAILURE_REASONS[reason])
        || (/^error_[a-z_]+$/.test(subtype) ? subtype.slice('error_'.length).replace(/_/g, ' ') : null);
    return `Claude turn failed${why ? `: ${why}` : ''}`;
}
function object(value: unknown): Obj {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
    return value as Obj;
}
function string(value: unknown): string { return typeof value === 'string' ? value : malformed(); }
function identity(value: unknown): string {
    const id = string(value);
    return id.length > 0 && id.length <= 1024 ? id : malformed();
}
function index(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < CLAUDE_MAX_BLOCKS
        ? value : malformed();
}
function content(value: unknown): unknown[] {
    if (!Array.isArray(value)) return malformed();
    if (value.length > CLAUDE_MAX_BLOCKS) throw new Error('Claude block limit exceeded');
    return value;
}

export class ClaudeSdkEvents {
    private readonly messages: ClaudeSdkMessages;
    private readonly tools = new Set<string>();
    private outcome: RuntimeTurnResult | undefined;
    private finished = false;
    private noticeSeq = 0;
    private lastUsage: Record<string, number> | null = null;
    /** Set by result() for a failed turn; the session hands it to the terminal diagnostic. */
    failureText: string | null = null;
    /** Latest context occupancy this turn reported (compaction or result); read after the result. */
    contextUsage: { totalTokens: number; modelContextWindow: number | null } | null = null;

    constructor(private readonly projection: RuntimeProjection) {
        this.messages = new ClaudeSdkMessages(reason => projection.report(reason));
    }

    get partialText(): string { return this.messages.partialText; }
    get interruptedText(): string { return this.messages.interruptedText; }

    accept(raw: unknown): RuntimeTurnResult | undefined {
        if (this.finished || this.outcome) return this.outcome;
        try {
            const frame = object(raw), type = string(frame['type']);
            if (!['assistant', 'stream_event', 'user', 'result', 'tool_progress', 'system', 'rate_limit_event'].includes(type)) return;
            const parent = frame['parent_tool_use_id'];
            if (parent !== undefined && parent !== null) { identity(parent); return; }
            if (type === 'assistant') this.assistant(frame);
            else if (type === 'stream_event') this.stream(object(frame['event']));
            else if (type === 'user') this.user(frame);
            else if (type === 'tool_progress') this.progress(frame);
            else if (type === 'system') this.system(frame);
            else if (type === 'rate_limit_event') this.rateLimit(object(frame['rate_limit_info']));
            else return this.result(frame);
        } catch (error) {
            this.projection.report('malformed');
            // Never echo untrusted fields, JSON parser snippets or getter exceptions.
            if (error instanceof Error && /^Claude (message|block|snapshot|tool) limit exceeded$/.test(error.message)) throw error;
            throw new Error('Malformed Claude SDK frame');
        }
        return undefined;
    }

    finish(outcome: RuntimeTurnResult, end?: RuntimeEnd): void {
        if (this.finished) return;
        this.finished = true;
        this.outcome = outcome;
        if (outcome.finalText !== null) this.projection.text('message', this.messages.finalRef, outcome.finalText, 'replace', 'final');
        this.projection.close(end ?? { kind: 'turn-end', status: outcome.status, finalText: outcome.finalText,
            ...(outcome.status === 'error' ? { error: this.failureText ?? 'Claude turn failed' } : {}) });
    }

    finishChild(status: 'done' | 'error' | 'stopped'): void {
        if (this.finished) return;
        this.finished = true;
        for (const id of this.tools) this.projection.tool('claude:tool:' + id, {
            status: status === 'error' ? 'error' : 'stopped',
        });
    }

    private result(frame: Obj): RuntimeTurnResult | undefined {
        const subtype = string(frame['subtype']);
        if (typeof frame['is_error'] !== 'boolean') malformed();
        if (frame['result'] !== undefined && frame['result'] !== null && typeof frame['result'] !== 'string') malformed();
        this.usage(frame['usage']);
        this.modelWindow(frame['modelUsage']);
        // A future subtype is judged by is_error instead of leaving the turn hanging.
        const failed = (resultTypes.has(subtype) && subtype !== 'success') || frame['is_error'] === true;
        const reason = typeof frame['terminal_reason'] === 'string' ? frame['terminal_reason'] : null;
        this.failureText = failed ? describeClaudeFailure(subtype, reason) : null;
        this.outcome = { status: failed ? 'error' : 'done',
            finalText: !failed && typeof frame['result'] === 'string' ? frame['result'] : null,
            partialText: this.partialText };
        return this.outcome;
    }

    private usage(raw: unknown): void {
        // The SDK may omit usage or emit null for an unavailable snapshot/field.
        // Usage is diagnostic metadata, so absence must not turn an otherwise
        // completed tool workflow into a failed turn.
        if (raw === undefined || raw === null) return;
        const usage = object(raw), tokens: Record<string, number> = {};
        for (const [wire, field] of [['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
            ['cache_read_input_tokens', 'cached_input_tokens']] as const) {
            const value = usage[wire];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) malformed();
            tokens[field] = value;
        }
        // Cache creation and monetary metadata remain session-owned; this is the
        // canonical per-turn usage snapshot, never a sum of assistant frames.
        if (Object.keys(tokens).length) {
            this.lastUsage = tokens;
            this.projection.usage(tokens);
        }
    }

    private modelWindow(raw: unknown): void {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const first = Object.values(raw as Obj)[0];
        const window = first && typeof first === 'object' ? (first as Obj)['contextWindow'] : undefined;
        const modelContextWindow = typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null;
        const used = this.lastUsage ? (this.lastUsage['input_tokens'] ?? 0) + (this.lastUsage['cached_input_tokens'] ?? 0) : null;
        if (used !== null && used > 0) this.contextUsage = { totalTokens: used, modelContextWindow };
    }

    private notice(key: string, name: string, status: 'running' | 'done' | 'error', detail?: string): void {
        this.projection.tool('claude:notice:' + key, { name, status, ...(detail ? { detail: detail.slice(0, 500) } : {}) },
            { allowTerminalUpdates: true });
    }

    /** Compaction, API retries, hooks and warnings, mapped onto tool rows the transcript already renders. */
    private system(frame: Obj): void {
        const subtype = typeof frame['subtype'] === 'string' ? frame['subtype'] : '';
        if (subtype === 'compact_boundary') {
            const meta = object(frame['compact_metadata']);
            const pre = meta['pre_tokens'], post = meta['post_tokens'];
            if (typeof pre !== 'number' || !Number.isSafeInteger(pre) || pre < 0) malformed();
            const after = typeof post === 'number' && Number.isSafeInteger(post) && post >= 0 ? post : null;
            this.notice('compact:' + (++this.noticeSeq), 'Context compacted', 'done',
                `${meta['trigger'] === 'manual' ? 'Manual' : 'Automatic'} · ${pre} tokens${after === null ? '' : ` → ${after}`}`);
            if (after !== null) this.contextUsage = { totalTokens: after, modelContextWindow: this.contextUsage?.modelContextWindow ?? null };
        } else if (subtype === 'status') {
            if (frame['status'] === 'compacting') this.notice('compacting', 'Compacting context', 'running');
            else if (frame['compact_result'] === 'failed') this.notice('compacting', 'Compacting context', 'error',
                typeof frame['compact_error'] === 'string' ? frame['compact_error'] : undefined);
            else if (frame['compact_result'] === 'success') this.notice('compacting', 'Compacting context', 'done');
        } else if (subtype === 'api_retry') {
            const attempt = frame['attempt'], max = frame['max_retries'], delay = frame['retry_delay_ms'];
            if (![attempt, max, delay].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) malformed();
            this.notice('api-retry', 'Retrying Claude API', 'running',
                `Attempt ${attempt as number}/${max as number}, next in ${Math.ceil((delay as number) / 1000)}s`);
        } else if (subtype === 'hook_started' || subtype === 'hook_response') {
            const id = identity(frame['hook_id']);
            const name = typeof frame['hook_name'] === 'string' ? frame['hook_name'].slice(0, 120) : 'hook';
            const status = subtype === 'hook_started' ? 'running' : frame['outcome'] === 'success' ? 'done' : 'error';
            const stderr = subtype === 'hook_response' && typeof frame['stderr'] === 'string' && frame['stderr'] ? frame['stderr'] : undefined;
            this.notice('hook:' + id, 'Hook: ' + name, status, stderr);
        } else if (subtype === 'informational' && (frame['level'] === 'warning' || frame['level'] === 'suggestion')
            && typeof frame['content'] === 'string') {
            this.notice('info:' + (++this.noticeSeq), 'Claude notice', 'done', frame['content']);
        }
        // task_* stay with claude-sdk-session.ts (background fail-closed) and the children tracker.
    }

    private rateLimit(info: Obj): void {
        const status = info['status'];
        if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') malformed();
        const at = typeof info['resetsAt'] === 'number' && Number.isFinite(info['resetsAt']) ? info['resetsAt'] : 0;
        const resetMs = at > 1_000_000_000_000 ? at : at * 1000;
        const resets = resetMs > 0 ? new Date(resetMs).toLocaleTimeString() : null;
        const kind = typeof info['rateLimitType'] === 'string' ? info['rateLimitType'].replace(/_/g, ' ') : 'usage';
        this.notice('rate-limit', 'Claude rate limit', status === 'rejected' ? 'running' : 'done',
            status === 'allowed' ? 'Available again'
                : `${status === 'rejected' ? 'Limit reached' : 'Approaching limit'} (${kind})${resets ? `, resets ${resets}` : ''}`);
    }

    private stream(event: Obj): void {
        const type = string(event['type']);
        if (type === 'message_start') {
            const message = object(event['message']);
            this.messages.start(identity(message['id'])); return;
        }
        if (type === 'message_delta') { object(event['delta']); return; }
        if (type === 'message_stop') return;
        if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(type)) return;
        const at = index(event['index']), id = this.messages.currentId;
        if (!id) malformed();
        if (type === 'content_block_start') {
            const raw = object(event['content_block']), kind = string(raw['type']);
            if (knownBlocks.has(kind)) this.applyBlock(id, at, raw, true);
            return;
        }
        const block = this.messages.message(id).blocks.get(at);
        if (type === 'content_block_stop') {
            if (block && !block.stopped) { block.stopped = true; this.completeInput(block); }
            return;
        }
        const delta = object(event['delta']), kind = string(delta['type']);
        if (!['text_delta', 'thinking_delta', 'input_json_delta'].includes(kind)) return;
        const value = string(delta[kind === 'text_delta' ? 'text' : kind === 'thinking_delta' ? 'thinking' : 'partial_json']);
        if (!block) malformed();
        const expected = kind === 'text_delta' ? 'text' : kind === 'thinking_delta' ? 'thinking' : 'tool_use';
        if (block.type !== expected) malformed();
        if (block.stopped || block.snapshotted) return;
        if (kind === 'input_json_delta') this.messages.appendJson(block, value);
        else { this.messages.write(block, value, true); this.publishText(id, at, block); }
    }

    private assistant(frame: Obj): void {
        const message = object(frame['message']), id = identity(message['id']);
        const parts = content(message['content']);
        this.messages.message(id);
        const uuid = frame['uuid'] === undefined ? undefined : identity(frame['uuid']);
        if (this.messages.duplicateSnapshot(id, uuid)) return;
        for (const [offset, part] of parts.entries()) {
            const raw = object(part), kind = string(raw['type']);
            if (!knownBlocks.has(kind)) continue;
            const at = parts.length === 1 ? this.messages.snapshotIndex(id, kind,
                kind === 'tool_use' ? identity(raw['id']) : undefined) : offset;
            this.applyBlock(id, at, raw, false);
        }
    }

    private applyBlock(id: string, at: number, raw: Obj, streamed: boolean): void {
        const kind = string(raw['type']);
        const block = this.messages.block(id, at, kind, streamed);
        if (streamed && (block.stopped || block.snapshotted)) return;
        if (kind === 'text' || kind === 'thinking') {
            this.messages.write(block, string(raw[kind === 'text' ? 'text' : 'thinking']), false);
            this.publishText(id, at, block);
        } else if (kind === 'tool_use') {
            const toolId = identity(raw['id']), name = identity(raw['name']);
            if (block.toolId && block.toolId !== toolId) malformed();
            object(raw['input']);
            block.toolId = toolId; block.name = name;
            const input = this.structured(raw['input']);
            // Streaming starts use {} before arguments arrive. Do not fill a terminal
            // tool's missing input with that placeholder and prevent later enrichment.
            block.emptyInputPending = streamed && input === '{}';
            this.projection.tool(this.toolRef(toolId), { name, status: 'running',
                ...(input !== undefined && !block.emptyInputPending ? { input, inputStructured: true } : {}) });
            if (!streamed) this.messages.releaseJson(block);
        }
        if (!streamed) block.snapshotted = true;
    }

    private publishText(id: string, at: number, block: ClaudeBlock): void {
        if (block.type === 'text') this.projection.text('message', 'claude:message:' + id, this.messages.text(id), 'replace');
        else if (block.type === 'thinking') this.projection.text('reasoning', 'claude:reasoning:' + id + ':' + at, block.text, 'replace');
    }

    private completeInput(block: ClaudeBlock): void {
        if (block.type !== 'tool_use' || block.jsonRetired || !block.toolId) return;
        if (!block.hasJson) {
            if (block.emptyInputPending) this.projection.tool(this.toolRef(block.toolId), { input: '{}', inputStructured: true });
            return;
        }
        try {
            const parsed: unknown = JSON.parse(block.json);
            object(parsed);
            const input = this.structured(parsed);
            if (input !== undefined) this.projection.tool(this.toolRef(block.toolId), { input, inputStructured: true });
        } catch { this.projection.report('malformed'); }
        finally { this.messages.releaseJson(block); }
    }

    private toolRef(id: string): string {
        if (!this.tools.has(id)) {
            if (this.tools.size >= CLAUDE_MAX_BLOCKS) throw new Error('Claude tool limit exceeded');
            this.tools.add(id);
        }
        return 'claude:tool:' + id;
    }

    /** Bound structured data BEFORE serialization; never publish a clipped JSON prefix. */
    private structured(value: unknown): string | undefined {
        let bytes = 0, nodes = 0;
        const visit = (part: unknown, depth: number): boolean => {
            if (++nodes > 8192 || depth > 32) return false;
            if (typeof part === 'string') bytes += Buffer.byteLength(part) + 2;
            else if (part === null || typeof part === 'boolean' || typeof part === 'number') bytes += 8;
            else if (typeof part === 'object') {
                bytes += 2;
                for (const key in part) {
                    if (!Object.hasOwn(part, key)) continue;
                    bytes += Buffer.byteLength(key) + 4;
                    if (bytes > CLAUDE_INPUT_BYTES || !visit(Reflect.get(part, key), depth + 1)) return false;
                }
            } else malformed();
            return bytes <= CLAUDE_INPUT_BYTES;
        };
        if (!visit(value, 0)) { this.projection.report('capacity'); return; }
        const json = JSON.stringify(value);
        if (typeof json !== 'string') malformed();
        if (Buffer.byteLength(json) > CLAUDE_INPUT_BYTES) { this.projection.report('capacity'); return; }
        return json;
    }

    private user(frame: Obj): void {
        const message = object(frame['message']);
        if (typeof message['content'] === 'string') return;
        for (const part of content(message['content'])) {
            const raw = object(part);
            if (string(raw['type']) !== 'tool_result') continue;
            const id = identity(raw['tool_use_id']);
            if (raw['is_error'] !== undefined && typeof raw['is_error'] !== 'boolean') malformed();
            let output = '', outputBytes = 0, withheld = false;
            const append = (value: string) => {
                if (withheld) return;
                outputBytes += Buffer.byteLength(value);
                if (outputBytes > CLAUDE_TEXT_BYTES) {
                    this.projection.report('capacity'); withheld = true; output = '[tool output withheld]'; return;
                }
                output += value;
            };
            if (typeof raw['content'] === 'string') append(raw['content']);
            else if (raw['content'] !== undefined) {
                for (const value of content(raw['content'])) {
                    const part = object(value);
                    if (string(part['type']) === 'text') { if (output) append('\n'); append(string(part['text'])); }
                }
            }
            this.projection.tool(this.toolRef(id), { status: raw['is_error'] === true ? 'error' : 'done', output });
        }
    }

    private progress(frame: Obj): void {
        const id = identity(frame['tool_use_id']), name = identity(frame['tool_name']);
        const elapsed = frame['elapsed_time_seconds'];
        if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) malformed();
        if (this.tools.has(id)) this.projection.tool(this.toolRef(id), { name, status: 'running', detail: 'Elapsed ' + elapsed + 's' });
    }
}
