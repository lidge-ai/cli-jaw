import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractFromEvent,
    extractFromAcpUpdate,
    extractOutputChunk,
    extractSessionId,
    extractToolLabel,
    extractToolLabelsForTest,
    flushOpenCodeBuffers,
    makeClaudeToolKeyForTest,
} from '../src/agent/events.ts';
import { parseGrokChatHistoryToolEntries } from '../src/agent/grok-trace-backfill.ts';
import { startTraceRun, countToolTraceRows, listToolEntriesForRun } from '../src/trace/store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
    const fixturePath = path.join(__dirname, 'fixtures', name);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function createClaudeCtx() {
    return { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
}

test('claude stream_event tool labels are deduped', () => {
    const ctx = createClaudeCtx();
    const evt = readFixture('claude-stream-tool.json');

    const first = extractToolLabelsForTest('claude', evt, ctx);
    const second = extractToolLabelsForTest('claude', evt, ctx);

    assert.deepEqual(first, [{ icon: '🔧', label: 'Bash', toolType: 'tool' }]);
    assert.equal(second.length, 0);
    assert.equal(ctx.hasClaudeStreamEvents, true);
});

test('claude assistant fallback works when stream was not seen', () => {
    const ctx = createClaudeCtx();
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.deepEqual(labels, [{ icon: '🔧', label: 'Read', toolType: 'tool' }]);
});

test('claude assistant signature-only thinking is surfaced as encrypted thinking', () => {
    const ctx = createClaudeCtx();
    const labels = extractToolLabelsForTest('claude', {
        type: 'assistant',
        message: {
            content: [
                { type: 'thinking', thinking: '', signature: 'abc123' },
            ],
        },
    }, ctx);

    assert.deepEqual(labels, [{
        icon: '🔒',
        label: 'encrypted thinking',
        toolType: 'thinking',
        detail: 'server-side reasoning, plaintext withheld - signature 6B',
    }]);
});

test('claude assistant blocks are ignored after stream event', () => {
    const ctx = createClaudeCtx();
    ctx.hasClaudeStreamEvents = true;
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.equal(labels.length, 0);
});

test('claude system compact events emit compacting and boundary labels', () => {
    const ctx = createClaudeCtx();
    const compacting = extractToolLabelsForTest('claude', {
        type: 'system',
        status: 'compacting',
    }, ctx);
    const boundary = extractToolLabelsForTest('claude', {
        type: 'system',
        subtype: 'compact_boundary',
    }, ctx);

    assert.deepEqual(compacting, [{ icon: '🗜️', label: 'compacting...', toolType: 'tool' }]);
    assert.deepEqual(boundary, [{ icon: '✅', label: 'conversation compacted', toolType: 'tool', status: 'done' }]);
});

test('extractSessionId handles all supported CLIs', () => {
    assert.equal(extractSessionId('claude', { type: 'system', session_id: 'claude-1' }), 'claude-1');
    assert.equal(extractSessionId('codex', { type: 'thread.started', thread_id: 'thread-1' }), 'thread-1');
    assert.equal(extractSessionId('grok', { type: 'end', sessionId: 'grok-1' }), 'grok-1');
    assert.equal(extractSessionId('opencode', { sessionID: 'oc-1' }), 'oc-1');
    assert.equal(extractSessionId('unknown', { type: 'x' }), null);
});

test('tool label extraction fixture matrix covers codex and opencode variants', () => {
    const fixtureCases = [
        {
            name: 'claude stream thinking (block_start — buffered, no immediate label)',
            cli: 'claude',
            fixture: 'claude-stream-thinking.json',
            expected: [],
        },
        {
            name: 'codex web search',
            cli: 'codex',
            fixture: 'codex-web-search.json',
            expected: [{ icon: '🔍', label: 'node test runner', toolType: 'search', detail: 'node test runner', status: 'done' }],
        },
        {
            name: 'codex open page',
            cli: 'codex',
            fixture: 'codex-open-page.json',
            expected: [{ icon: '🌐', label: 'example.com', toolType: 'search', detail: 'https://example.com/docs?q=1', status: 'done' }],
        },
        {
            name: 'codex open page invalid fallback',
            cli: 'codex',
            fixture: 'codex-open-page-invalid.json',
            expected: [{ icon: '🌐', label: 'page', toolType: 'search', detail: 'not a url', status: 'done' }],
        },
        {
            name: 'codex command execution',
            cli: 'codex',
            fixture: 'codex-command.json',
            expected: [{ icon: '⚡', label: 'npm run test:events', toolType: 'tool', detail: 'npm run test:events', stepRef: 'codex:item:npm run test:events', status: 'done' }],
        },
        {
            name: 'codex reasoning',
            cli: 'codex',
            fixture: 'codex-reasoning.json',
            expected: [{ icon: '💭', label: 'Plan isolate regression', toolType: 'thinking', detail: 'Plan isolate regression' }],
        },
        {
            name: 'opencode tool use',
            cli: 'opencode',
            fixture: 'opencode-tool-use.json',
            expected: [
                { icon: '✅', label: 'bash', toolType: 'tool', stepRef: 'opencode:call:call_function_abc', detail: 'pwd', status: 'done' },
            ],
        },
        {
            name: 'opencode tool result',
            cli: 'opencode',
            fixture: 'opencode-tool-result.json',
            expected: [{ icon: '✅', label: 'bash', toolType: 'tool', stepRef: 'opencode:call:call_function_abc', status: 'done' }],
        },
    ];

    for (const item of fixtureCases) {
        const ctx = item.cli === 'claude' ? createClaudeCtx() : {};
        const labels = extractToolLabelsForTest(item.cli, readFixture(item.fixture), ctx);
        assert.deepEqual(labels, item.expected, item.name);
    }
});

test('claude non-tool events do not emit labels', () => {
    const ctx = createClaudeCtx();
    const resultLabels = extractToolLabelsForTest('claude', readFixture('claude-result.json'), ctx);
    const errorLabels = extractToolLabelsForTest('claude', readFixture('claude-error.json'), ctx);
    assert.equal(resultLabels.length, 0);
    assert.equal(errorLabels.length, 0);
});

test('claude thinking_delta buffer is flushed on non-thinking event', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Send thinking deltas — they should accumulate in buffer, not emit yet
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think about ' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'thinking delta should not emit immediately');

    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'this problem carefully.' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'second delta should also buffer');

    // Non-thinking event (block_stop) should flush
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'flush should emit one tool label');
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.equal(ctx.toolLog[0].icon, '💭');
    assert.ok(ctx.toolLog[0].label.includes('think about'), 'label should contain thinking content');
    assert.ok(ctx.toolLog[0].detail.includes('this problem carefully'), 'detail should contain full text');
});

test('codex reasoning keeps full detail while preview label stays short', () => {
    const longReasoning = {
        type: 'item.completed',
        item: {
            type: 'reasoning',
            text: '**Plan** isolate regression by checking websocket state hydration and replay handling before UI render',
        },
    };

    const [label] = extractToolLabelsForTest('codex', longReasoning, {});
    assert.equal(label.toolType, 'thinking');
    assert.ok(label.label.length <= 60, 'preview label should remain compact');
    assert.equal(label.detail, 'Plan isolate regression by checking websocket state hydration and replay handling before UI render');
});

test('claude input_json_delta buffer adds detail to tool label on block_stop', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // content_block_start → tool_use "Bash"
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 'test-id' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'tool_use block_start should emit label');
    assert.equal(ctx.toolLog[0].label, 'Bash');
    assert.equal(ctx.toolLog[0].detail, undefined, 'no detail yet');

    // input_json_delta chunks
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command": "ls' } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ' /tmp"}' } },
    }, ctx, 'test');

    // content_block_stop → flush input JSON → add detail
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.ok(ctx.toolLog[0].detail, 'detail should be populated after flush');
    assert.ok(ctx.toolLog[0].detail.includes('ls /tmp'), 'detail should contain command');
});

test('claude text_delta streams prose live and accumulates raw fullText (no bullet formatting)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Token-granular deltas splitting a single word mid-token.
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
    }, ctx, 'test');
    assert.equal(ctx.claudeStreamedText, true, 'text_delta sets the per-message streamed flag');
    assert.equal(ctx.fullText, 'Hel', 'first delta appended raw');
    // Live drain #1 — the dispatcher pulls the pending chunk for broadcast.
    assert.equal(extractOutputChunk('claude', { type: 'stream_event' }, ctx), 'Hel', 'claude drain returns first delta');
    assert.equal(ctx.pendingOutputChunk, '', 'pending cleared after drain');

    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
    }, ctx, 'test');
    assert.equal(extractOutputChunk('claude', { type: 'stream_event' }, ctx), 'lo', 'claude drain returns second delta');
    // Critical: raw concatenation, NOT "Hel\n- lo" that the segment formatter would inject.
    assert.equal(ctx.fullText, 'Hello', 'deltas concatenate raw without bullet injection');
});

test('claude final assistant block is skipped after text_delta stream (no doubling)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Realistic order: text block opens, streams, then the complete assistant arrives.
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
    }, ctx, 'test');
    extractOutputChunk('claude', { type: 'stream_event' }, ctx); // live drain
    assert.equal(ctx.fullText, 'Hello world');

    // Final complete assistant repeats the whole text — must be skipped (260612 F-T4).
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, 'Hello world', 'complete block not re-appended (no doubling)');
    assert.equal(ctx.claudeStreamedText, false, 'per-message flag reset for the next message');
});

test('claude message-boundary reconcile restores segment separators between tool-separated messages', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const delta = (text) => extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    }, ctx, 'test');
    const complete = (text) => extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
    }, ctx, 'test');

    // Message 1: bullet item streamed in token-granular deltas, then canonical block.
    delta('- ㅇ');
    delta('ㅇ');
    complete('- ㅇㅇ');
    assert.equal(ctx.fullText, '- ㅇㅇ', 'single message reconcile is value-identical');

    // (tool events happen here — they never touch fullText)

    // Message 2: raw append alone would produce '- ㅇㅇ- ㅇㅇ' (the reported bug);
    // the complete-block reconcile must restore the '\n' boundary like codex/claude-e.
    delta('- ㅇㅇ');
    complete('- ㅇㅇ');
    assert.equal(ctx.fullText, '- ㅇㅇ\n- ㅇㅇ', 'boundary between messages restored');
});

test('claude plain-text messages get codex-parity segment bullets at the boundary', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const delta = (text) => extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    }, ctx, 'test');
    const complete = (text) => extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
    }, ctx, 'test');

    delta('hello');
    complete('hello');
    assert.equal(ctx.fullText, 'hello', 'first plain message stays unbulleted');

    delta('world');
    complete('world');
    // Matches the codex segment convention (first\n- second).
    assert.equal(ctx.fullText, 'hello\n- world', 'later message gets the segment boundary');
});

test('claude within-message newlines survive reconcile (live-capture fixture)', () => {
    // (boundary tests for NARRATION-BOUNDARY-01 are appended at the end of this file)
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Real deltas captured from claude stream-json on 2026-07-03: ["-", " one\n- two\n- three"]
    for (const text of ['-', ' one\n- two\n- three']) {
        extractFromEvent('claude', {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        }, ctx, 'test');
    }
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '- one\n- two\n- three' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, '- one\n- two\n- three', 'canonical newlines intact, no doubling');
});

test('claude streamed text is retained when the complete block never arrives', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ans' } },
    }, ctx, 'test');
    // Interrupt/kill: no assistant event. Raw streamed text must survive.
    assert.equal(ctx.fullText, 'partial ans');
    assert.equal(ctx.claudeStreamedTextStart, 0, 'anchor recorded for the open message');
});
test('claude falls back to complete assistant block when no text_delta streamed', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // No partial stream events (e.g. --include-partial-messages absent): only the complete assistant.
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Fallback text.' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, 'Fallback text.', 'complete block surfaced when nothing streamed');
    assert.ok(!ctx.claudeStreamedText, 'per-message flag stays falsy in the fallback path');
});

test('claude empty text_delta does not arm the doubling guard (fallback still fires)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // An all-empty text_delta must NOT set claudeStreamedText, else a real complete block is skipped.
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
    }, ctx, 'test');
    assert.ok(!ctx.claudeStreamedText, 'empty delta must not arm the per-message flag');
    // Complete assistant block must still be surfaced via fallback.
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Real prose.' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, 'Real prose.', 'complete block appended when only empty deltas streamed');
});

test('extractFromEvent updates context for each CLI path', () => {
    const claudeCtx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use', name: 'Read' }],
        },
    }, claudeCtx, 'claude-agent');
    extractFromEvent('claude', {
        type: 'result',
        total_cost_usd: 0.12,
        num_turns: 3,
        duration_ms: 777,
        session_id: 'claude-session',
    }, claudeCtx, 'claude-agent');
    assert.equal(claudeCtx.fullText, 'hello ');
    assert.deepEqual(claudeCtx.toolLog, [{ icon: '🔧', label: 'Read', toolType: 'tool' }]);
    assert.equal(claudeCtx.cost, 0.12);
    assert.equal(claudeCtx.turns, 3);
    assert.equal(claudeCtx.duration, 777);
    assert.equal(claudeCtx.sessionId, 'claude-session');

    const codexCtx = { toolLog: [], fullText: '' };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'done' },
    }, codexCtx, 'codex-agent');
    extractFromEvent('codex', {
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 20 },
    }, codexCtx, 'codex-agent');
    assert.equal(codexCtx.fullText, 'done');
    assert.deepEqual(codexCtx.tokens, { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 });

    const opencodeCtx = { toolLog: [], fullText: '' };
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: 'opencode answer' },
    }, opencodeCtx, 'opencode-agent');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'opencode-session',
        part: {
            tokens: { input: 11, output: 22 },
            cost: 0.7,
        },
    }, opencodeCtx, 'opencode-agent');
    assert.equal(opencodeCtx.fullText, 'opencode answer');
    assert.equal(opencodeCtx.sessionId, 'opencode-session');
    assert.deepEqual(opencodeCtx.tokens, { input_tokens: 11, output_tokens: 22, cached_read: 0, cached_write: 0 });
    assert.equal(opencodeCtx.cost, 0.7);
});

test('extractToolLabel keeps backward compatibility and claude keys are deterministic', () => {

    const keyFromIndex = makeClaudeToolKeyForTest(
        { type: 'stream_event', event: { index: 3 } },
        { icon: '🔧', label: 'Bash' }
    );
    const keyFromMessageId = makeClaudeToolKeyForTest(
        { type: 'assistant', message: { id: 'msg_1' } },
        { icon: '🔧', label: 'Read' }
    );
    const keyFromType = makeClaudeToolKeyForTest(
        { type: 'assistant' },
        { icon: '🔧', label: 'Read' }
    );

    assert.equal(keyFromIndex, 'claude:idx:3:🔧:Bash');
    assert.equal(keyFromMessageId, 'claude:msg:msg_1:🔧:Read');
    assert.equal(keyFromType, 'claude:type:assistant:🔧:Read');
});

// ── Phase 3 (P2) tests ──────────────────────────────────────

test('P2-3.1: Claude system event stores model and metadata', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'system',
        model: 'claude-sonnet-4-20250514',
        tools: ['Bash', 'Read'],
        mcp_servers: ['filesystem'],
        version: '1.0.34',
    }, ctx, 'claude');
    assert.equal(ctx.model, 'claude-sonnet-4-20250514');
    assert.deepEqual(ctx.metadata.tools, ['Bash', 'Read']);
    assert.deepEqual(ctx.metadata.mcp_servers, ['filesystem']);
    assert.equal(ctx.metadata.version, '1.0.34');
});

test('P2-3.2: Claude message_start captures input_tokens', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { input_tokens: 1234 } } },
    }, ctx, 'claude');
    assert.deepEqual(ctx.tokens, { input_tokens: 1234, output_tokens: 0 });
});

test('P2-3.4: Codex turn.started pushes trace', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    extractFromEvent('codex', { type: 'turn.started' }, ctx, 'codex');
    assert.ok(ctx.traceLog.some(l => l.includes('codex turn started')));
});

test('P2-3.6: Codex turn.completed stores cached_input_tokens', () => {
    const ctx = { toolLog: [], fullText: '' };
    extractFromEvent('codex', {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 },
    }, ctx, 'codex');
    assert.deepEqual(ctx.tokens, { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 });
});

test('P2-3.10: OpenCode step_start stores model', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    extractFromEvent('opencode', {
        type: 'step_start', part: { model: 'big-pickle' },
    }, ctx, 'opencode');
    assert.equal(ctx.model, 'big-pickle');
    assert.ok(ctx.traceLog.some(l => l.includes('step_start') && l.includes('big-pickle')));
});

test('P2-3.11+3.12+3.13: OpenCode step_finish stores reason, timing, and total tokens', () => {
    const ctx = { toolLog: [], fullText: '' };
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: {
            tokens: { input: 10, output: 20, total: 30, cache: { read: 5, write: 2 } },
            cost: 0.05,
            reason: 'tool-calls',
            time: { start: 1000, end: 2000 },
        },
    }, ctx, 'oc');
    assert.equal(ctx.finishReason, 'tool-calls');
    assert.deepEqual(ctx.metadata.lastStepTime, { start: 1000, end: 2000 });
    assert.equal(ctx.tokens.total_tokens, 30);
    assert.equal(ctx.tokens.cached_read, 5);
    assert.equal(ctx.tokens.cached_write, 2);
});

test('P2-3.14: ACP session_cancelled returns cancel tool entry', () => {
    const result = extractFromAcpUpdate({
        update: { sessionUpdate: 'session_cancelled', reason: 'user abort' },
    });
    assert.equal(result.tool.icon, '⏹️');
    assert.ok(result.tool.label.includes('user abort'));
    assert.equal(result.tool.status, 'cancelled');
});

test('P2-3.15: ACP request_permission returns audit entry', () => {
    const result = extractFromAcpUpdate({
        update: { sessionUpdate: 'request_permission', permission: 'file_write' },
    });
    assert.equal(result.tool.icon, '🔐');
    assert.ok(result.tool.label.includes('file_write'));
    assert.equal(result.tool.status, 'pending');
});

test('P0-1.1: Claude signature_delta is discarded without flushing thinking buffer', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), claudeThinkingBuf: 'still thinking' };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } },
    }, ctx, 'claude');
    // Thinking buffer should NOT be flushed
    assert.equal(ctx.claudeThinkingBuf, 'still thinking');
    assert.equal(ctx.toolLog.length, 0);
});

test('encrypted thinking: opus-4-7 pattern (signature only, no thinking_delta) emits 🔒 badge', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // 1. thinking block opens
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'block_start alone should not emit');
    // 2. only signature_delta arrives (304 chars like real opus-4-7 stream)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x'.repeat(304) } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'signature_delta alone should not emit');
    // 3. block_stop with empty thinking buffer → encrypted badge
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'encrypted thinking should emit one badge');
    assert.equal(ctx.toolLog[0].icon, '🔒');
    assert.equal(ctx.toolLog[0].label, 'encrypted thinking');
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.ok(ctx.toolLog[0].detail.includes('304'), 'detail should mention signature length');
    // 4. state should reset after stop
    assert.equal(ctx.claudeThinkingBlockOpen, false);
    assert.equal(ctx.claudeThinkingHadDelta, false);
});

test('spark-visibility: codex agent_message surfaces a 💬 toolLog entry so lightweight models are visible', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'OK. 7 is prime.' },
    }, ctx, 'spark');
    assert.equal(ctx.fullText, 'OK. 7 is prime.', 'fullText still accumulates');
    assert.equal(ctx.toolLog.length, 1, 'agent_message must create a visible toolLog entry');
    assert.equal(ctx.toolLog[0].icon, '💬');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].stepRef, 'codex:item:item_0');
    assert.ok(ctx.toolLog[0].detail.includes('7 is prime'));
});

test('spark-visibility: empty agent_message text does NOT create a spurious entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: '   \n  ' },
    }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 0);
});

test('spark-visibility: repeated agent_message with same item.id is deduped', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    const evt = {
        type: 'item.completed',
        item: { id: 'item_DUP', type: 'agent_message', text: 'same' },
    };
    extractFromEvent('codex', evt, ctx, 'codex');
    extractFromEvent('codex', evt, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1, 'dedup via stepRef prevents double-entry on replay');
});

test('multi-turn: same tool name across distinct messages keeps separate toolLog entries (dedup fix)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Message A: first tool_use (index 0) with unique id
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_A', name: 'mcp__context7__resolve-library-id' } },
    }, ctx, 'smoke');
    // Message B: second call with same name, also index 0 but distinct id (was colliding before fix)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_B', name: 'mcp__context7__resolve-library-id' } },
    }, ctx, 'smoke');
    assert.equal(ctx.toolLog.length, 2, 'both tool_uses must be recorded, not deduped by index collision');
    assert.equal(ctx.toolLog[0].stepRef, 'claude:tooluse:toolu_A');
    assert.equal(ctx.toolLog[1].stepRef, 'claude:tooluse:toolu_B');
});

test('multi-turn: true duplicate tool_use_id IS deduped (same stepRef → key collision)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Same id replayed (e.g. re-emission in assistant fallback) — should dedupe
    const ev = {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_SAME', name: 'Write' } },
    };
    extractFromEvent('claude', ev, ctx, 'smoke');
    extractFromEvent('claude', ev, ctx, 'smoke');
    assert.equal(ctx.toolLog.length, 1, 'true replay of same tool_use_id must dedupe');
});

test('codex turn.failed surfaces error tool entry with parsed message', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), traceLog: [] };
    extractFromEvent('codex', {
        type: 'turn.failed',
        error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-spark\' model is not supported when using Codex with a ChatGPT account."}}' },
    }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '❌');
    assert.equal(ctx.toolLog[0].status, 'error');
    assert.ok(ctx.toolLog[0].detail.includes('gpt-5.3-spark'), 'nested JSON error.message should be unwrapped');
    assert.ok(!ctx.toolLog[0].detail.includes('"type":"error"'), 'outer JSON envelope should be stripped');
});

test('codex standalone error event surfaces ❌ entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), traceLog: [] };
    extractFromEvent('codex', { type: 'error', message: 'network connection lost' }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].detail, 'network connection lost');
});

test('encrypted thinking: plaintext thinking does NOT also emit 🔒 badge (regression)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Open thinking block
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    }, ctx, 'test');
    // Plaintext thinking_delta arrives (sonnet/opus-4-6 path)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning about the problem.' } },
    }, ctx, 'test');
    // Then signature_delta (also arrives in plaintext path as closing signature)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    }, ctx, 'test');
    // Stop
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'should emit exactly one badge');
    assert.equal(ctx.toolLog[0].icon, '💭', 'plaintext path must keep 💭 icon, not 🔒');
    assert.ok(ctx.toolLog[0].detail.includes('Reasoning about'), 'plaintext content preserved');
});

test('P1-2.2: Claude allowed rate_limit_event does not emit warning tool entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'allowed',
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
        },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 0);
});

test('P1-2.2b: Claude non-allowed rate_limit_event emits running wait entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '⏳');
    assert.equal(ctx.toolLog[0].status, 'running');
    assert.match(ctx.toolLog[0].label, /Claude quota wait/);
    assert.equal(ctx.claudeRateLimitEventSeen, true);
});

test('P1-2.2c: Claude repeated rate_limit_event updates one wait entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 600,
        },
    }, ctx, 'claude');
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'one_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].status, 'running');
    assert.match(ctx.toolLog[0].label, /one_hour/);
});

test('P1-2.2d: Claude allowed rate_limit_event resolves prior wait entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'allowed',
            rateLimitType: 'five_hour',
        },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.match(ctx.toolLog[0].label, /resolved/);
});

test('P1-2.2e: Claude allowed_warning rate_limit_event emits done warning, not wait', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '⚠️');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.match(ctx.toolLog[0].label, /near limit/);
});

test('P1-2.2f: Claude assistant/result resolves stale quota wait when allowed event is absent', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[0].status, 'done');

    const resultCtx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, resultCtx, 'claude');
    extractFromEvent('claude', { type: 'result', total_cost_usd: 0.01 }, resultCtx, 'claude');
    assert.equal(resultCtx.toolLog.length, 1);
    assert.equal(resultCtx.toolLog[0].icon, '✅');
    assert.equal(resultCtx.toolLog[0].status, 'done');
});

test('P1-2.2g: Claude hard rate limit marks watchdog progress and extends deadline', () => {
    const calls = [];
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        seenToolKeys: new Set(),
        stallWatchdog: {
            markProgress() { calls.push(['markProgress']); },
            extendDeadline(extraMs, reason) { calls.push(['extendDeadline', extraMs, reason]); },
            stop() {},
        },
    };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(Date.now() / 1000) + 1200,
        },
    }, ctx, 'claude');

    const extension = calls.find(call => call[0] === 'extendDeadline');
    assert.ok(calls.some(call => call[0] === 'markProgress'));
    assert.ok(extension, 'hard rate-limit should extend watchdog deadline');
    assert.ok(extension[1] > 1_000_000, `expected long extension, got ${extension[1]}`);
    assert.equal(extension[2], 'Claude quota wait');
    assert.ok(ctx.traceLog.some(line => line.includes('[watchdog] extended for Claude quota wait')));
});

test('P1-2.3: Claude result stores cache token breakdown', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'result',
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
    }, ctx, 'claude');
    assert.equal(ctx.tokens.cache_read, 80);
    assert.equal(ctx.tokens.cache_creation, 20);
});

test('P0-1.7+1.8: OpenCode multi-step token accumulation (including total_tokens)', () => {
    const ctx = { toolLog: [], fullText: '' };
    // Step 1
    extractFromEvent('opencode', {
        type: 'step_finish', sessionID: 'oc-1',
        part: { tokens: { input: 10, output: 20, total: 30, cache: { read: 5, write: 1 } }, cost: 0.01 },
    }, ctx, 'oc');
    // Step 2
    extractFromEvent('opencode', {
        type: 'step_finish', sessionID: 'oc-1',
        part: { tokens: { input: 15, output: 25, total: 40, cache: { read: 3, write: 2 } }, cost: 0.02 },
    }, ctx, 'oc');
    assert.equal(ctx.tokens.input_tokens, 25);
    assert.equal(ctx.tokens.output_tokens, 45);
    assert.equal(ctx.tokens.total_tokens, 70);  // 30 + 40, not just 40
    assert.equal(ctx.tokens.cached_read, 8);
    assert.equal(ctx.tokens.cached_write, 3);
    assert.equal(ctx.cost, 0.03);
});

test('P0-1.2: Claude user/tool_result updates existing tool label', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // First emit a tool_use label
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu_abc' }] },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].stepRef, 'claude:tooluse:tu_abc');

    // Now receive tool_result feedback (success)
    extractFromEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_abc', content: 'output here', is_error: false }] },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.ok(ctx.toolLog[0].detail.includes('output here'));

    // Error case
    const ctx2 = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', id: 'tu_def' }] },
    }, ctx2, 'claude');
    extractFromEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_def', content: 'permission denied', is_error: true }] },
    }, ctx2, 'claude');
    assert.equal(ctx2.toolLog[0].icon, '❌');
    assert.equal(ctx2.toolLog[0].status, 'error');
});

test('P1-2.1: Claude message_delta accumulates output_tokens', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 42 } },
    }, ctx, 'claude');
    assert.equal(ctx.tokens.output_tokens, 42);
});

test('P1-2.4: Codex failed command shows error icon and exit code', () => {
    const labels = extractToolLabelsForTest('codex', {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-1', command: 'npm test', exit_code: 1, aggregated_output: 'FAIL' },
    }, {});
    assert.equal(labels[0].icon, '❌');
    assert.equal(labels[0].status, 'error');
    assert.equal(labels[0].exitCode, 1);
    assert.equal(labels[0].stepRef, 'codex:item:cmd-1');
});

test('Codex command labels hide shell login wrappers for display', () => {
    const labels = extractToolLabelsForTest('codex', {
        type: 'item.completed',
        item: {
            type: 'command_execution',
            id: 'cmd-shell',
            command: "/bin/zsh -lc 'git status --short'",
            exit_code: 0,
            aggregated_output: ' M README.md',
        },
    }, {});

    assert.equal(labels[0].label, 'git status --short');
    assert.equal(labels[0].detail, '$ git status --short\n M README.md');
    assert.equal(labels[0].stepRef, 'codex:item:cmd-shell');
});

test('P0-1.3+1.4: Codex item.started emits running label with item.id stepRef', () => {
    const labels = extractToolLabelsForTest('codex', {
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd-42', command: 'ls -la' },
    }, {});
    assert.equal(labels[0].icon, '🔧');
    assert.equal(labels[0].status, 'running');
    assert.equal(labels[0].stepRef, 'codex:item:cmd-42');
});

test('Codex command start emits one process tool row', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd-zsh', command: "/bin/zsh -lc 'git status --short'" },
    }, ctx, 'codex');

    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].label, 'git status --short');
    assert.equal(ctx.toolLog[0].stepRef, 'codex:item:cmd-zsh');
    assert.equal(ctx.toolLog[0].status, 'running');
});

test('P0-1.10: ACP tool_call_update status mapping covers all known + unknown statuses', () => {
    // running
    const running = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r1', status: 'running' },
    });
    assert.equal(running.tool.icon, '🔧');
    assert.equal(running.tool.status, 'running');

    // in_progress
    const ip = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r2', status: 'in_progress' },
    });
    assert.equal(ip.tool.icon, '🔧');
    assert.equal(ip.tool.status, 'running');

    // pending
    const pending = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r3', status: 'pending' },
    });
    assert.equal(pending.tool.icon, '⏳');
    assert.equal(pending.tool.status, 'pending');

    // unknown status → neutral ❔
    const unknown = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r4', status: 'cancelled' },
    });
    assert.equal(unknown.tool.icon, '❔');
    assert.equal(unknown.tool.status, 'cancelled');
});

test('P1-2.6: OpenCode failed exit code shows error icon', () => {
    const labels = extractToolLabelsForTest('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'call_xyz',
            state: { status: 'completed', metadata: { exit: 127 }, input: { command: 'bad-cmd' } },
        },
    }, {});
    assert.equal(labels[0].icon, '❌');
    assert.equal(labels[0].status, 'error');
    assert.equal(labels[0].exitCode, 127);
});

test('21.1: Claude task lifecycle emits subagent steps', () => {
    const ctx = createClaudeCtx();
    const [started] = extractToolLabelsForTest('claude', {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Investigate parser',
        task_type: 'local_agent',
        prompt: 'Check the parser.',
    }, ctx);
    assert.equal(started.icon, '🤖');
    assert.equal(started.toolType, 'subagent');
    assert.equal(started.stepRef, 'claude:task:task-1');
    assert.equal(started.status, 'running');
    assert.ok(started.detail.includes('tool_use_id: toolu-1'));

    const [done] = extractToolLabelsForTest('claude', {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        summary: 'Found the issue',
        usage: { total_tokens: 1200, tool_uses: 2, duration_ms: 3456 },
    }, createClaudeCtx());
    assert.equal(done.icon, '✅');
    assert.equal(done.toolType, 'subagent');
    assert.equal(done.stepRef, 'claude:task:task-1');
    assert.equal(done.status, 'done');
    assert.ok(done.detail.includes('1200 tok'));
});

test('21.2: Codex collab_tool_call uses item.tool and toggles active subagent for spawn/wait', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.started',
        item: {
            type: 'collab_tool_call',
            id: 'collab-1',
            tool: 'spawn_agent',
            status: 'in_progress',
            sender_thread_id: 'parent',
        },
    }, ctx, 'codex');
    assert.equal(ctx.hasActiveSubAgent, true);
    assert.equal(ctx.toolLog[0].toolType, 'subagent');
    assert.equal(ctx.toolLog[0].stepRef, 'codex:collab:collab-1');
    assert.equal(ctx.toolLog[0].label, 'spawn_agent...');

    extractFromEvent('codex', {
        type: 'item.completed',
        item: {
            type: 'collab_tool_call',
            id: 'collab-1',
            tool: 'spawn_agent',
            status: 'completed',
            receiver_thread_ids: ['child-1'],
            agents_states: { 'child-1': { status: 'pending_init' } },
        },
    }, ctx, 'codex');
    assert.equal(ctx.hasActiveSubAgent, false);
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].label, 'spawn_agent done');
    assert.ok(ctx.toolLog[0].detail.includes('child-1'));
});

test('21.3: OpenCode task tool is marked as subagent and absorbs same callID tool_result when ctx is present', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), opencodeTaskCallIds: new Set() };
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'task',
            callID: 'task:0',
            state: {
                status: 'completed',
                title: 'Reply DONE',
                input: {
                    description: 'Reply DONE',
                    prompt: 'Reply with DONE.',
                    subagent_type: 'general',
                },
                output: '<task_result>DONE</task_result>',
                metadata: {
                    sessionId: 'ses_child',
                    model: { providerID: 'opencode-go', modelID: 'kimi-k2.6' },
                },
            },
        },
    }, ctx, 'oc');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].toolType, 'subagent');
    assert.equal(ctx.toolLog[0].stepRef, 'opencode:call:task:0');
    assert.ok(ctx.toolLog[0].detail.includes('child_session: ses_child'));
    assert.equal(ctx.opencodeTaskCallIds.has('task:0'), true);

    extractFromEvent('opencode', {
        type: 'tool_result',
        part: { tool: 'task', callID: 'task:0', output: 'DONE' },
    }, ctx, 'oc');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].status, 'done');
});

test('extractOutputChunk returns live assistant text for opencode final step and codex', () => {
    const opencodeCtx = { pendingOutputChunk: '' };
    extractFromEvent('opencode', { type: 'text', part: { text: 'world' } }, opencodeCtx, 'oc');
    assert.equal(
        extractOutputChunk('opencode', { type: 'text', part: { text: 'world' } }, opencodeCtx),
        '',
    );
    extractFromEvent('opencode', { type: 'step_finish', part: { reason: 'stop' }, sessionID: 'oc-1' }, opencodeCtx, 'oc');
    assert.equal(
        extractOutputChunk('opencode', { type: 'step_finish', part: { reason: 'stop' }, sessionID: 'oc-1' }, opencodeCtx),
        'world',
    );
    // [P0-1.5] Codex now returns agent_message text as live chunk
    assert.equal(
        extractOutputChunk('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'codex reply' } }),
        'codex reply',
    );
    // Non-agent_message Codex events still return ''
    assert.equal(
        extractOutputChunk('codex', { type: 'item.completed', item: { type: 'command_execution' } }),
        '',
    );
});
test('grok streaming-json deltas append text and capture end session id', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    extractFromEvent('grok', { type: 'thought', data: 'internal' }, ctx, 'grok');
    assert.equal(extractOutputChunk('grok', { type: 'thought', data: 'internal' }, ctx), '');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].stepRef, 'grok:thinking');
    assert.equal(ctx.toolLog[0].status, 'running');
    assert.equal(ctx.toolLog[0].detail, 'internal');
    extractFromEvent('grok', { type: 'text', data: 'GROK' }, ctx, 'grok');
    assert.equal(extractOutputChunk('grok', { type: 'text', data: 'GROK' }, ctx), 'GROK');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].detail, 'internal');
    extractFromEvent('grok', { type: 'text', data: '_OK' }, ctx, 'grok');
    assert.equal(extractOutputChunk('grok', { type: 'text', data: '_OK' }, ctx), '_OK');
    extractFromEvent('grok', { type: 'end', sessionId: 'grok-session', stopReason: 'EndTurn' }, ctx, 'grok');
    assert.equal(ctx.fullText, 'GROK_OK');
    assert.equal(ctx.sessionId, 'grok-session');
    assert.equal(ctx.metadata?.stopReason, 'EndTurn');
});

test('grok parser preserves visible thinking and correlates multiple tool events', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    extractFromEvent('grok', { type: 'thought', data: 'Plan: call two tools. ' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'thought', data: 'Then summarize.' }, ctx, 'grok');

    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].stepRef, 'grok:thinking');
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.equal(ctx.toolLog[0].status, 'running');
    assert.equal(ctx.toolLog[0].detail, 'Plan: call two tools. Then summarize.');

    extractFromEvent('grok', { type: 'tool_use', id: 'a', name: 'shell', input: { command: 'pwd' } }, ctx, 'grok');
    extractFromEvent('grok', { type: 'tool_use', id: 'a', name: 'shell', input: { command: 'pwd' } }, ctx, 'grok');
    extractFromEvent('grok', { type: 'tool_use', id: 'b', name: 'shell', input: { command: 'printf ok' } }, ctx, 'grok');
    extractFromEvent('grok', { type: 'tool_result', id: 'a', name: 'shell', output: '/tmp' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'tool_result', id: 'b', name: 'shell', output: 'ok' }, ctx, 'grok');

    const toolA = ctx.toolLog.find(t => t.stepRef === 'grok:tool:a');
    const toolB = ctx.toolLog.find(t => t.stepRef === 'grok:tool:b');
    assert.equal(toolA?.status, 'done');
    assert.equal(toolA?.detail, '/tmp');
    assert.equal(toolB?.status, 'done');
    assert.equal(toolB?.detail, 'ok');
    assert.equal(ctx.toolLog.filter(t => t.stepRef?.startsWith('grok:tool:')).length, 2);
});

test('grok parser keeps separate thinking spans and handles part/state tool completion shape', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    extractFromEvent('grok', { type: 'thought', data: 'First plan.' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'text', data: 'Visible answer. ' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'thought', data: 'Second plan.' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'end', sessionId: 'grok-session' }, ctx, 'grok');

    const thinkingSteps = ctx.toolLog.filter(t => t.stepRef?.startsWith('grok:thinking'));
    assert.equal(thinkingSteps.length, 2);
    assert.equal(thinkingSteps[0].stepRef, 'grok:thinking');
    assert.equal(thinkingSteps[0].status, 'done');
    assert.equal(thinkingSteps[0].detail, 'First plan.');
    assert.equal(thinkingSteps[1].stepRef, 'grok:thinking:2');
    assert.equal(thinkingSteps[1].status, 'done');
    assert.equal(thinkingSteps[1].detail, 'Second plan.');

    extractFromEvent('grok', {
        type: 'tool_use',
        part: { tool: 'shell', callID: 'call-1', state: { status: 'running', input: { command: 'pwd' } } },
    }, ctx, 'grok');
    extractFromEvent('grok', {
        type: 'tool_use',
        part: { tool: 'shell', callID: 'call-1', state: { status: 'completed', output: '/repo' } },
    }, ctx, 'grok');

    const tool = ctx.toolLog.find(t => t.stepRef === 'grok:tool:call-1');
    assert.equal(tool?.status, 'done');
    assert.equal(tool?.detail, '/repo');
    assert.equal(ctx.toolLog.filter(t => t.stepRef === 'grok:tool:call-1').length, 1);
});

test('grok parser final end closes stale running thinking spans', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    ctx.toolLog.push(
        { icon: '💭', label: 'Grok thinking', toolType: 'thinking', detail: 'The', status: 'running', stepRef: 'grok:thinking' },
        { icon: '💭', label: 'Grok thinking', toolType: 'thinking', detail: 'I', status: 'running', stepRef: 'grok:thinking:2' },
    );

    extractFromEvent('grok', { type: 'end', sessionId: 'grok-session' }, ctx, 'grok');

    const runningThoughts = ctx.toolLog.filter(t => t.stepRef?.startsWith('grok:thinking') && t.status === 'running');
    assert.equal(runningThoughts.length, 0);
    assert.equal(ctx.toolLog.filter(t => t.stepRef?.startsWith('grok:thinking') && t.status === 'done').length, 2);
});

test('grok parser prefers per-call ids over shared request id for multi-tool streams', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    extractFromEvent('grok', {
        type: 'tool_use',
        requestId: 'req-1',
        part: { tool: 'read', callID: 'call-1', state: { status: 'running', input: { file: 'a' } } },
    }, ctx, 'grok');
    extractFromEvent('grok', {
        type: 'tool_use',
        requestId: 'req-1',
        part: { tool: 'write', callID: 'call-2', state: { status: 'running', input: { file: 'b' } } },
    }, ctx, 'grok');

    assert.ok(ctx.toolLog.find(t => t.stepRef === 'grok:tool:call-1'));
    assert.ok(ctx.toolLog.find(t => t.stepRef === 'grok:tool:call-2'));
    assert.equal(ctx.toolLog.filter(t => t.stepRef === 'grok:tool:req-1').length, 0);
    assert.equal(ctx.toolLog.filter(t => t.stepRef?.startsWith('grok:tool:')).length, 2);
});

test('grok streaming-json error emits error tool without assistant text', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set(), traceRunId: 'trace-1' };
    extractFromEvent('grok', { type: 'error', data: 'reasoningEffort unsupported', requestId: 'req-1' }, ctx, 'grok');

    assert.equal(ctx.fullText, '');
    assert.equal(ctx.pendingOutputChunk, '');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].status, 'error');
    assert.equal(ctx.toolLog[0].stepRef, 'grok:error:req-1');
    assert.equal(ctx.toolLog[0].detail, 'reasoningEffort unsupported');
});

test('grok streaming-json duplicate errors with same request id are ignored', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set(), traceRunId: 'trace-1' };
    extractFromEvent('grok', { type: 'error', data: 'Rate limited', requestId: 'req-dup' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'error', data: 'Rate limited', requestId: 'req-dup' }, ctx, 'grok');

    assert.equal(ctx.fullText, '');
    assert.equal(ctx.pendingOutputChunk, '');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].stepRef, 'grok:error:req-dup');
    assert.equal(ctx.toolLog[0].detail, 'Rate limited');
});

test('grok trace backfill recovers omitted headless tool calls from chat history', () => {
    const jsonl = [
        JSON.stringify({
            type: 'assistant',
            tool_calls: [{
                id: 'call-1',
                name: 'run_terminal_command',
                arguments: '{"command":"pwd","timeout":120000}',
            }],
        }),
        JSON.stringify({
            type: 'tool_result',
            tool_call_id: 'call-1',
            content: 'exit: 0\n/Users/jun\n',
        }),
    ].join('\n');

    const entries = parseGrokChatHistoryToolEntries(jsonl);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].stepRef, 'grok:tool:call-1');
    assert.equal(entries[0].label, 'run_terminal_command');
    assert.equal(entries[0].status, 'done');
    assert.match(entries[0].detail || '', /"command":"pwd"/);
    assert.match(entries[0].detail || '', /\/Users\/jun/);
});

test('grok trace backfill marks non-zero terminal result as error', () => {
    const jsonl = [
        JSON.stringify({ type: 'assistant', tool_calls: [{ id: 'call-err', name: 'shell', arguments: { command: 'false' } }] }),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-err', content: 'exit: 1\n' }),
    ].join('\n');

    const entries = parseGrokChatHistoryToolEntries(jsonl);
    assert.equal(entries[0].status, 'error');
    assert.equal(entries[0].icon, '❌');
});

test('grok trace backfill marks explicit failed result metadata as error', () => {
    const jsonl = [
        JSON.stringify({ type: 'assistant', tool_calls: [{ id: 'call-meta-err', name: 'search', arguments: { q: 'x' } }] }),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-meta-err', status: 'failed', error: { message: 'permission denied' } }),
    ].join('\n');

    const entries = parseGrokChatHistoryToolEntries(jsonl);
    assert.equal(entries[0].status, 'error');
    assert.equal(entries[0].icon, '❌');
    assert.match(entries[0].detail || '', /permission denied/);
});

test('untagged codex agent_messages are LAST-WINS: narration never joins the final answer', () => {
    // The old contract joined successive untagged messages with "\n- ", which
    // is exactly the "확인합니다.- <답변>" artifact that reached Slack. The
    // last untagged message IS the answer; earlier ones are progress narration.
    const codexCtx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: '확인하겠습니다.' } }, codexCtx, 'codex');
    assert.equal(extractOutputChunk('codex', {}, codexCtx), '확인하겠습니다.');
    extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message', id: 'm2', text: '최종 답변입니다.' } }, codexCtx, 'codex');
    assert.equal(extractOutputChunk('codex', {}, codexCtx), '최종 답변입니다.', 'live stream still shows the new message');
    assert.equal(codexCtx.fullText, '최종 답변입니다.', 'durable text holds ONLY the last message — no \n- join');
});

test('single untagged codex agent_message is unchanged by last-wins', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: 'only answer' } }, ctx, 'codex');
    assert.equal(ctx.fullText, 'only answer');
});

test('tagged commentary codex message stays out of fullText and emits thinking, not tool', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { id: 'c1', type: 'agent_message', text: '위키를 확인합니다.', channel: 'commentary' },
    }, ctx, 'codex');
    assert.equal(ctx.fullText, '', 'commentary never becomes durable answer text');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].toolType, 'thinking', 'external channel status lines drop thinking entries');
    // The raw extractOutputChunk fallback must not resurrect commentary either.
    assert.equal(extractOutputChunk('codex', {
        type: 'item.completed',
        item: { id: 'c1', type: 'agent_message', text: '위키를 확인합니다.', channel: 'commentary' },
    }, undefined), '');
});

test('opencode buffers pre-tool text until step_finish and discards tool-call chatter', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'Let me check that first.' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:plan-0',
            state: { input: { command: 'pwd' } },
        },
    }, ctx, 'oc');
    assert.equal(ctx.fullText, '');
    assert.equal(extractOutputChunk('opencode', { type: 'text', part: { text: 'Let me check that first.' } }, ctx), '');

    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'tool-calls' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '');
    assert.equal(ctx.toolLog.length, 2);
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[1].toolType, 'thinking');
    assert.equal(ctx.toolLog[1].icon, '💭');
    assert.equal(ctx.toolLog[1].detail, 'Let me check that first.');
    assert.equal(
        extractOutputChunk('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'tool-calls' } }, ctx),
        '',
    );

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'Final answer.' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx, 'oc');

    assert.equal(ctx.fullText, 'Final answer.');
    assert.equal(
        extractOutputChunk('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx),
        'Final answer.',
    );
});

test('opencode flushes final text when stream closes without step_finish', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'reasoning',
        part: { text: 'The user is greeting casually.' },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: 'ㅎㅇㅎㅇ! 무엇을 도와줄까?' },
    }, ctx, 'oc');

    assert.equal(ctx.fullText, '');
    assert.equal(extractOutputChunk('opencode', { type: 'text' }, ctx), '');

    flushOpenCodeBuffers(ctx, 'oc');

    assert.equal(ctx.fullText, 'ㅎㅇㅎㅇ! 무엇을 도와줄까?');
    assert.equal(extractOutputChunk('opencode', { type: 'close' }, ctx), 'ㅎㅇㅎㅇ! 무엇을 도와줄까?');
    assert.equal(ctx.opencodePreToolText, '');
    assert.equal(ctx.opencodePostToolText, '');
    assert.equal(ctx.toolLog.filter(t => t.toolType === 'thinking').length, 1);
});

test('opencode close flush preserves tool-call text suppression without step_finish', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'Let me inspect first.' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:close-0',
            state: { input: { command: 'pwd' } },
        },
    }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'The command completed.' } }, ctx, 'oc');

    flushOpenCodeBuffers(ctx, 'oc');

    assert.equal(ctx.fullText, '- The command completed.');
    assert.equal(extractOutputChunk('opencode', { type: 'close' }, ctx), '- The command completed.');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[1].toolType, 'thinking');
    assert.equal(ctx.toolLog[1].detail, 'Let me inspect first.');
});

test('opencode reasoning event emits thinking tool even when reasoning tokens are zero', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
    };

    extractFromEvent('opencode', {
        type: 'reasoning',
        part: {
            type: 'reasoning',
            text: 'The user wants me to think hard.',
            time: { start: 1, end: 2 },
        },
    }, ctx, 'oc');

    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.equal(ctx.toolLog[0].detail, 'The user wants me to think hard.');
    assert.equal(ctx.opencodeStepThinkingToolEmitted, true);
});

test('opencode accumulates reasoning tokens and emits token-only fallback', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: {
            reason: 'stop',
            tokens: { input: 10, output: 5, total: 20, reasoning: 82 },
        },
    }, ctx, 'oc');

    assert.equal(ctx.tokens.reasoning_tokens, 82);
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.equal(ctx.toolLog[0].label, 'reasoning used: 82 tokens');
    assert.match(ctx.toolLog[0].detail, /did not emit plaintext reasoning content/);
});

test('opencode does not emit token-only fallback after plaintext reasoning in same step', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'glm-5.1' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'reasoning',
        part: { text: 'visible reasoning', time: { start: 1, end: 2 } },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: {
            reason: 'stop',
            tokens: { input: 10, output: 5, total: 20, reasoning: 82 },
        },
    }, ctx, 'oc');

    assert.equal(ctx.tokens.reasoning_tokens, 82);
    assert.equal(ctx.toolLog.filter(t => t.toolType === 'thinking').length, 1);
    assert.equal(ctx.toolLog[0].detail, 'visible reasoning');
});

test('opencode pre-tool thinking suppresses token-only fallback in same step', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'I will inspect the file first.' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:inspect-0',
            state: { input: { command: 'ls' } },
        },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: {
            reason: 'tool-calls',
            tokens: { input: 10, output: 5, total: 20, reasoning: 140 },
        },
    }, ctx, 'oc');

    const thinkingTools = ctx.toolLog.filter(t => t.toolType === 'thinking');
    assert.equal(ctx.tokens.reasoning_tokens, 140);
    assert.equal(thinkingTools.length, 1);
    assert.equal(thinkingTools[0].detail, 'I will inspect the file first.');
    assert.ok(!thinkingTools[0].label.includes('reasoning used'));
});

test('opencode keeps post-tool text during tool-calls steps', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'read',
            callID: 'read:0',
            state: { status: 'error', input: { filePath: '/Users/jun/.config/opencode/config.json' } },
        },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: 'I could not read that file because permission was denied.' },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: { reason: 'tool-calls' },
    }, ctx, 'oc');

    assert.equal(ctx.fullText, '- I could not read that file because permission was denied.');
    assert.equal(
        extractOutputChunk('opencode', {
            type: 'step_finish',
            sessionID: 'oc-1',
            part: { reason: 'tool-calls' },
        }, ctx),
        '- I could not read that file because permission was denied.',
    );
});

test('opencode keeps post-tool progress text after successful tool_use when step_finish reason is tool-calls', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:0',
            state: {
                status: 'completed',
                metadata: { exit: 0 },
                input: { command: 'cat /tmp/example.txt' },
            },
        },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: '좋아요! 파일 있네요! 내용 확인하고 websearch 추가할게요!' },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: { reason: 'tool-calls' },
    }, ctx, 'oc');

    assert.equal(ctx.fullText, '- 좋아요! 파일 있네요! 내용 확인하고 websearch 추가할게요!');
    assert.equal(
        extractOutputChunk('opencode', {
            type: 'step_finish',
            sessionID: 'oc-1',
            part: { reason: 'tool-calls' },
        }, ctx),
        '- 좋아요! 파일 있네요! 내용 확인하고 websearch 추가할게요!',
    );
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].icon, '✅');
});

test('opencode commits only post-tool text during tool-calls step and suppresses pre-tool chatter', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: 'Let me check first.' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:1',
            state: {
                status: 'completed',
                metadata: { exit: 0 },
                input: { command: 'pwd' },
            },
        },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: 'The repo is available; I will inspect the parser next.' },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: { reason: 'tool-calls' },
    }, ctx, 'oc');

    assert.equal(ctx.fullText, '- The repo is available; I will inspect the parser next.');
    assert.ok(!ctx.fullText.includes('Let me check first.'));
    assert.equal(ctx.toolLog[1].toolType, 'thinking');
    assert.equal(ctx.toolLog[1].detail, 'Let me check first.');
    assert.equal(
        extractOutputChunk('opencode', {
            type: 'step_finish',
            sessionID: 'oc-1',
            part: { reason: 'tool-calls' },
        }, ctx),
        '- The repo is available; I will inspect the parser next.',
    );
});

test('opencode marks unresolved bash exec as done when the step finishes cleanly', () => {
    const ctx = {
        toolLog: [],
        fullText: '',
        traceLog: [],
        pendingOutputChunk: '',
        opencodePreToolText: '',
        opencodePostToolText: '',
        opencodeSawToolInStep: false,
        opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [],
    };

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'bash:pending-0',
            state: {
                input: { command: 'cat /tmp/example.txt | head -20' },
            },
        },
    }, ctx, 'oc');

    assert.equal(ctx.toolLog[0].status, undefined);
    assert.equal(ctx.toolLog[0].icon, '🔧');

    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: { reason: 'tool-calls' },
    }, ctx, 'oc');

    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].icon, '✅');
});
test('events.ts facade exports exactly the 12 public symbols', () => {
    const eventsSrc = fs.readFileSync(path.join(__dirname, '../src/agent/events.ts'), 'utf8');
    const exportMatches = eventsSrc.match(/^export\s+(function|const|class|type|interface|enum)\s+(\w+)/gm) || [];
    const reExportMatches = eventsSrc.match(/^export\s+\{[^}]+\}/gm) || [];
    const directExports = exportMatches.map(m => m.replace(/^export\s+\w+\s+/, ''));
    const reExports: string[] = [];
    for (const m of reExportMatches) {
        const inner = m.match(/\{([^}]+)\}/)?.[1] || '';
        reExports.push(...inner.split(',').map(s => s.trim()).filter(Boolean));
    }
    const allExports = [...directExports, ...reExports].sort();
    const expected = [
        'extractFromAcpSubagent',
        'extractFromAcpUpdate',
        'extractFromEvent',
        'extractOutputChunk',
        'extractSessionId',
        'extractToolLabel',
        'extractToolLabelsForTest',
        'flushClaudeBuffers',
        'flushOpenCodeBuffers',
        'logEventSummary',
        'makeClaudeToolKeyForTest',
        'summarizeToolInput',
    ].sort();
    assert.deepEqual(allExports, expected, `events.ts must export exactly 12 symbols, got: ${allExports.join(', ')}`);
});

test('args invariant: only plain claude passes --include-partial-messages', async () => {
    const { buildArgs, buildResumeArgs } = await import('../src/agent/args.ts');
    const claudeArgs = buildArgs('claude', 'claude-sonnet-5', 'medium', 'p', 's');
    assert.ok(claudeArgs.includes('--include-partial-messages'), 'plain claude streams partial messages');
    const claudeResume = buildResumeArgs('claude', 'claude-sonnet-5', 'medium', 'sid', 'p');
    assert.ok(claudeResume.includes('--include-partial-messages'), 'plain claude resume keeps the flag');
});

test('claude reconcile is skipped when the complete block has no text (streamed text survives)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed prose' } },
    }, ctx, 'test');
    // Degenerate complete block with no text content must not delete the streamed text.
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, 'streamed prose', 'truncation must not run without canonical text');
    assert.ok(!ctx.claudeStreamedText, 'per-message flag still resets');
    assert.equal(ctx.claudeStreamedTextStart, undefined, 'anchor still resets');
});

// ─── WP4: durable tool-row convergence via event flow ───

test('WP4: codex running→done replacement carries the trace pointer and converges one row', () => {
    const runId = startTraceRun({ cli: 'codex', audience: 'public' });
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false, traceRunId: runId, traceAudience: 'public' };

    extractFromEvent('codex', {
        type: 'item.started',
        item: { type: 'command_execution', id: 'it1', command: 'ls -la' },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].status, 'running');
    const stampedSeq = ctx.toolLog[0].traceSeq;
    assert.equal(ctx.toolLog[0].traceRunId, runId);
    assert.ok(stampedSeq >= 1);

    extractFromEvent('codex', {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'it1', command: 'ls -la', exit_code: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'done label must replace the running entry');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].traceRunId, runId, 'replacement must inherit the trace pointer');
    assert.equal(ctx.toolLog[0].traceSeq, stampedSeq);

    assert.equal(countToolTraceRows(runId), 1, 'no duplicate row for the replacement');
    const rows = listToolEntriesForRun(runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'done', 'durable row must converge to final status');
});

test('WP4: claude tool_result converges the trace row even after RAM eviction', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false, traceRunId: runId, traceAudience: 'public' };

    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].traceRunId, runId);

    // Simulate the RAM cap evicting the placeholder before the result arrives.
    ctx.toolLog.length = 0;

    extractFromEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'ok' }] }] },
    }, ctx, 'test');

    const rows = listToolEntriesForRun(runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'done', 'evicted placeholder must still converge via toolTraceIndex');
    assert.equal(rows[0].icon, '✅');
    assert.equal(rows[0].detail, 'ok');
});

// ─── NARRATION-BOUNDARY-01: claude family message boundaries ─────────────────
//
// External channels (Slack/Telegram/Discord) deliver text derived from
// ctx.fullText, so narration that survives there reaches the user's final
// answer. The live UI reads pendingOutputChunk separately and keeps everything.

function boundaryCtx() {
    return { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
}

test('claude streaming: message_start discards the previous message narration', () => {
    const ctx = boundaryCtx();
    const messageStart = (id) => extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_start', message: { id, usage: { input_tokens: 10 } } },
    }, ctx, 'test');
    const delta = (text) => extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    }, ctx, 'test');
    const complete = (id, text) => extractFromEvent('claude', {
        type: 'assistant', message: { id, content: [{ type: 'text', text }] },
    }, ctx, 'test');

    messageStart('msg-narration');
    delta('관련 파일을 확인하겠습니다.');
    complete('msg-narration', '관련 파일을 확인하겠습니다.');
    assert.equal(ctx.fullText, '관련 파일을 확인하겠습니다.');

    // A tool ran here; then the model starts a NEW message with the real answer.
    messageStart('msg-answer');
    delta('원인은 메시지 경계 누락입니다.');
    complete('msg-answer', '원인은 메시지 경계 누락입니다.');
    assert.equal(ctx.fullText, '원인은 메시지 경계 누락입니다.', 'narration must not join the answer');
});

test('claude streaming: the first message_start does not discard anything', () => {
    const ctx = boundaryCtx();
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 4 } } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '첫 답변' } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '첫 답변' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, '첫 답변');
});

test('claude streaming: message_start still flushes a pending thinking buffer', () => {
    // The boundary reset must not early-return past the trailing thinking flush.
    const ctx = boundaryCtx();
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '생각 중' } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 1 } } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.filter((t) => t.toolType === 'thinking').length, 1);
    assert.equal(ctx.toolLog[0].detail, '생각 중');
});
test('claude fallback (no deltas): a changed message id discards the previous narration', () => {
    const ctx = boundaryCtx();
    extractFromEvent('claude', {
        type: 'assistant',
        message: { id: 'msg-narration', content: [{ type: 'text', text: '먼저 확인하겠습니다.' }] },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'assistant',
        message: { id: 'msg-answer', content: [{ type: 'text', text: '완료했습니다.' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, '완료했습니다.');
});

test('claude fallback: two events of the SAME message keep both blocks', () => {
    // Keyed on the id, not on "a second event arrived": one message can span
    // several assistant events, and a boolean would delete the first block.
    const ctx = boundaryCtx();
    extractFromEvent('claude', {
        type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '앞부분' }] },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '뒷부분' }] },
    }, ctx, 'test');
    assert.equal(ctx.fullText, '앞부분\n- 뒷부분', 'same id is continuation');
});
test('claude live stream keeps narration the durable answer drops', () => {
    const ctx = boundaryCtx();
    extractFromEvent('claude', {
        type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '확인하겠습니다.' }] },
    }, ctx, 'test');
    assert.equal(extractOutputChunk('claude', { type: 'assistant' }, ctx), '확인하겠습니다.');
    extractFromEvent('claude', {
        type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '완료했습니다.' }] },
    }, ctx, 'test');
    assert.equal(extractOutputChunk('claude', { type: 'assistant' }, ctx), '완료했습니다.');
    assert.equal(ctx.fullText, '완료했습니다.');
});

// ─── NARRATION-BOUNDARY-01: opencode step boundary + grok limitation ─────────

function opencodeCtx() {
    return {
        toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '',
        opencodePreToolText: '', opencodePostToolText: '',
        opencodeSawToolInStep: false, opencodeHadToolErrorInStep: false,
        opencodePendingToolRefs: [], seenToolKeys: new Set(),
    };
}

test('opencode: a tool-less narration step is discarded by the next step', () => {
    const ctx = opencodeCtx();
    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: '먼저 상황을 정리하겠습니다.' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '먼저 상황을 정리하겠습니다.', 'committed by its own step');

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: '최종 답변입니다.' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '최종 답변입니다.', 'a following step proves the earlier text was not the answer');
});

test('opencode: post-tool narration is discarded by the next step', () => {
    const ctx = opencodeCtx();
    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: { tool: 'bash', callID: 'bash:0', state: { status: 'completed', input: { command: 'cat x' } } },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text', part: { text: '좋아요! 파일 있네요! 내용 확인할게요!' },
    }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'tool-calls' } }, ctx, 'oc');

    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: '조사 결과는 다음과 같습니다.' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '조사 결과는 다음과 같습니다.');
});

test('opencode: the last step survives when nothing follows it', () => {
    // Regression guard: a tool-error explanation with no following step is the
    // answer, and last-step-wins must not touch it.
    const ctx = opencodeCtx();
    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'tool_use',
        part: { tool: 'read', callID: 'read:0', state: { status: 'error', input: { filePath: '/x' } } },
    }, ctx, 'oc');
    extractFromEvent('opencode', {
        type: 'text', part: { text: 'I could not read that file because permission was denied.' },
    }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'tool-calls' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '- I could not read that file because permission was denied.');
});

test('opencode live stream keeps the narration the durable answer drops', () => {
    const ctx = opencodeCtx();
    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'text', part: { text: '먼저 확인하겠습니다.' } }, ctx, 'oc');
    extractFromEvent('opencode', { type: 'step_finish', sessionID: 'oc-1', part: { reason: 'stop' } }, ctx, 'oc');
    assert.equal(extractOutputChunk('opencode', {}, ctx), '먼저 확인하겠습니다.', 'live UI saw it');
    extractFromEvent('opencode', { type: 'step_start', part: { model: 'kimi-k2.6' } }, ctx, 'oc');
    assert.equal(ctx.fullText, '', 'durable slot cleared for the next step');
});

test('grok has no message boundary, so narration still joins the answer (known limit)', () => {
    // Recorded, not fixed: grok's streaming-json carries no message identity —
    // 'text' events have no id, 'thought' can follow visible text, tool events are
    // optional in some builds, and 'end' arrives after everything is joined.
    // Forcing a boundary here would truncate real answers (NARRATION-BOUNDARY-01
    // rule 6). This test pins the current contract so it changes deliberately if
    // grok ever emits message ids.
    const ctx = { toolLog: [], fullText: '', traceLog: [], pendingOutputChunk: '', seenToolKeys: new Set() };
    extractFromEvent('grok', { type: 'text', data: '파일을 먼저 확인하겠습니다.' }, ctx, 'grok');
    extractFromEvent('grok', { type: 'tool_use', id: 'read-1', name: 'read', input: { file: 'README.md' } }, ctx, 'grok');
    extractFromEvent('grok', { type: 'text', data: '최종 답변입니다.' }, ctx, 'grok');
    assert.equal(
        ctx.fullText,
        '파일을 먼저 확인하겠습니다.최종 답변입니다.',
        'known limitation: no structural boundary exists in the grok stream',
    );
});
