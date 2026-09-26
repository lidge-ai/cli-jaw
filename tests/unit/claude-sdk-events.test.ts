import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// Recorders are injected here; module loading must not initialize shared SQLite.
mock.module('../../src/trace/activity-journal.js', { namedExports: { appendActivityBody: () => null, markActivityFailure: () => {} } });
const { ClaudeSdkEvents } = await import('../../src/agent/runtime/claude-sdk-events.ts');
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';

function harness(failure?: 'null' | 'throw') {
    const events: RuntimeEvent[] = [], notices: string[] = [];
    let seq = 0;
    const projection = new RuntimeProjection({ runId: 'run', sessionId: 'jaw', scope: 'separate-scope',
        turnId: 'turn', audience: 'internal' }, (context, body) => {
        if (failure === 'null') return null;
        if (failure === 'throw') throw new Error('recorder secret');
        const event: RuntimeEvent = { ...context, version: 1, seq: seq += 3, ...body };
        events.push(event);
        return event;
    }, reason => notices.push(reason));
    projection.start('claude');
    const mapper = new ClaudeSdkEvents(projection);
    const stream = (event: object, parent: string | null = null) => mapper.accept({ type: 'stream_event', event, parent_tool_use_id: parent });
    const start = (id = 'm') => stream({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
    const block = (index: number, content_block: object) => stream({ type: 'content_block_start', index, content_block });
    const delta = (index: number, delta: object) => stream({ type: 'content_block_delta', index, delta });
    const stop = (index: number) => stream({ type: 'content_block_stop', index });
    const assistant = (id: string, content: object[], uuid?: string) => mapper.accept({ type: 'assistant', message: { id, content }, uuid });
    const toolResult = (id: string, content: unknown, is_error = false) => mapper.accept({ type: 'user', message: {
        content: [{ type: 'tool_result', tool_use_id: id, content, is_error }],
    } });
    return { mapper, projection, events, notices, stream, start, block, delta, stop, assistant, toolResult };
}
const text = (value: string) => ({ type: 'text', text: value });
const result = (value?: string) => ({ type: 'result', subtype: 'success', is_error: false,
    ...(value === undefined ? {} : { result: value }) });

test('empty final is authoritative and finish alone closes exactly once', () => {
    const h = harness(); h.assistant('m', [text('partial')]);
    const outcome = h.mapper.accept(result(''));
    assert.deepEqual(outcome, { status: 'done', finalText: '', partialText: 'partial' });
    assert.equal(h.events.filter(e => e.kind === 'turn-end').length, 0);
    assert.equal(h.events.filter(e => e.kind === 'message' && e.phase === 'final').length, 0);
    h.mapper.finish(outcome!); h.mapper.finish(outcome!);
    assert.deepEqual(h.events.filter(e => e.kind === 'message' && e.phase === 'final').map(e => e.text), ['']);
    assert.equal(h.events.filter(e => e.kind === 'turn-end').length, 1);
    assert.strictEqual(h.mapper.accept(result('duplicate')), outcome);
});

test('absent final is null and never promotes the assistant snapshot', () => {
    const h = harness(); h.assistant('m', [text('partial')]);
    const outcome = h.mapper.accept(result());
    assert.deepEqual(outcome, { status: 'done', finalText: null, partialText: 'partial' });
    h.mapper.finish(outcome!);
    assert.equal(h.events.filter(e => e.kind === 'message' && e.phase === 'final').length, 0);
});

test('explicit null result remains absent and never promotes a parent snapshot', () => {
    const h = harness(); h.assistant('m', [text('partial')]);
    const outcome = h.mapper.accept({ ...result(), result: null });
    assert.deepEqual(outcome, { status: 'done', finalText: null, partialText: 'partial' });
    h.mapper.finish(outcome!);
    assert.equal(h.events.some(event => event.kind === 'message' && event.phase === 'final'), false);
});

test('ten thousand CJK fragments retain a bounded UTF8 accumulator and public snapshot', () => {
    const h = harness(); h.start(); h.block(0, text(''));
    const fragment = '가'.repeat(128);
    for (let i = 0; i < 10_000; i++) h.delta(0, { type: 'text_delta', text: fragment });
    assert.ok(Buffer.byteLength(h.mapper.partialText) <= 1024 * 1024);
    assert.ok(Buffer.byteLength(h.mapper.partialText) >= 1024 * 1024 - 3);
    assert.ok(h.notices.includes('capacity'));
    assert.ok(h.projection.diagnostics().withinSnapshotCap);
    assert.ok(h.events.length < 30, 'equal clipped replace snapshots must be coalesced');
});

test('EOF salvage is available before any completed assistant snapshot', () => {
    const h = harness(); h.start(); h.block(0, text('')); h.delta(0, { type: 'text_delta', text: 'unfinished' });
    assert.equal(h.mapper.partialText, 'unfinished');
    h.mapper.finish({ status: 'error', finalText: null, partialText: h.mapper.partialText });
    h.delta(0, { type: 'text_delta', text: 'late' });
    assert.equal(h.mapper.partialText, 'unfinished');
    assert.deepEqual(h.events.filter(e => e.kind === 'turn-end').map(e => [e.status, e.finalText]), [['error', null]]);
});

test('SDK .261 single completed blocks replace their stream index without A + AB duplication', () => {
    const h = harness(); h.start();
    h.block(0, text('')); h.delta(0, { type: 'text_delta', text: 'A' }); h.stop(0);
    h.assistant('m', [text('AB')], 'block-0');
    h.block(1, text('')); h.delta(1, { type: 'text_delta', text: 'C' }); h.stop(1);
    h.assistant('m', [text('CD')], 'block-1');
    assert.equal(h.mapper.partialText, 'ABCD');
    assert.equal(new Set(h.events.filter(e => e.kind === 'message').map(e => e.itemId)).size, 1);
});

test('multi-block snapshots replace by index and retain message order', () => {
    const h = harness(); h.start();
    h.block(0, text('A')); h.block(1, text('B'));
    h.assistant('m', [text('AA'), text('BB')]);
    assert.equal(h.mapper.partialText, 'AABB');
    h.assistant('m', [text('X'), text('Y')]);
    assert.equal(h.mapper.partialText, 'XY');
});

test('unstreamed .261 blocks accumulate in stable order and duplicate frame UUID is idempotent', () => {
    const h = harness();
    h.assistant('m', [text('one')], 'a'); h.assistant('m', [text('two')], 'b');
    h.assistant('m', [text('two')], 'b');
    assert.equal(h.mapper.partialText, 'onetwo');
});

test('new parent resets current partial immediately and old message updates do not become latest', () => {
    const h = harness(); h.assistant('old', [text('narration')]); h.start('new');
    assert.equal(h.mapper.partialText, ''); h.block(0, text('answer'));
    h.assistant('old', [text('old update')]);
    assert.equal(h.mapper.partialText, 'answer');
    assert.equal(h.mapper.accept(result('final'))?.finalText, 'final');
});

test('all child families are excluded without disturbing the active parent stream', () => {
    const h = harness(); h.start(); h.block(0, text('parent'));
    for (const frame of [
        { type: 'assistant', message: { id: 'child', content: [text('child-secret')] } },
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'child' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child-secret' } } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'child', content: 'child-secret' }] } },
        result('child-secret'),
    ]) assert.equal(h.mapper.accept({ ...frame, parent_tool_use_id: 'child-task' }), undefined);
    h.delta(0, { type: 'text_delta', text: '!' });
    assert.equal(h.mapper.partialText, 'parent!');
    assert.ok(!JSON.stringify(h.events).includes('child-secret'));
});

test('plaintext reasoning has separate stable items; signatures and redacted thinking stay private', () => {
    const h = harness(); h.start();
    h.block(0, { type: 'thinking', thinking: '' });
    h.delta(0, { type: 'thinking_delta', thinking: 'reason' });
    h.delta(0, { type: 'signature_delta', signature: 'signature-canary' }); h.stop(0);
    h.assistant('m', [{ type: 'thinking', thinking: 'reasoning', signature: 'signature-canary' }]);
    h.block(1, { type: 'redacted_thinking', data: 'encrypted-canary' }); h.stop(1);
    h.block(2, text('answer'));
    assert.equal(h.mapper.partialText, 'answer');
    assert.deepEqual(h.events.filter(e => e.kind === 'reasoning').map(e => e.text).filter(Boolean), ['reason', 'reasoning']);
    assert.equal(new Set(h.events.filter(e => e.kind === 'reasoning').map(e => e.itemId)).size, 1);
    assert.ok(!JSON.stringify(h.events).includes('canary'));
});

test('same-named tools have distinct IDs and block stop never means execution done', () => {
    const h = harness(); h.start();
    for (const [index, id] of ['private-1', 'private-2'].entries()) {
        h.block(index, { type: 'tool_use', id, name: 'Bash', input: { command: 'pwd' } }); h.stop(index);
    }
    assert.ok(h.events.filter(e => e.kind === 'tool').every(e => e.status === 'running'));
    h.toolResult('private-1', '/tmp'); h.toolResult('private-2', [text('failed'), { type: 'image', data: 'binary-canary' }], true);
    const ends = h.events.filter(e => e.kind === 'tool' && e.status !== 'running');
    assert.deepEqual(ends.map(e => [e.name, e.status, e.output]), [['Bash', 'done', '/tmp'], ['Bash', 'error', 'failed']]);
    assert.equal(new Set(ends.map(e => e.itemId)).size, 2);
    assert.ok(!JSON.stringify(h.events).includes('private-'));
    assert.ok(!JSON.stringify(h.events).includes('binary-canary'));
});

test('out-of-order result and duplicate terminal never reopen a tool', () => {
    const h = harness(); h.toolResult('early', 'done'); h.start();
    h.block(0, { type: 'tool_use', id: 'early', name: 'Bash', input: { command: 'pwd' } }); h.stop(0);
    h.mapper.accept({ type: 'tool_progress', tool_use_id: 'early', tool_name: 'Bash', elapsed_time_seconds: 2 });
    h.toolResult('early', 'duplicate');
    const tools = h.events.filter(e => e.kind === 'tool');
    assert.ok(tools.every(e => e.status === 'done'));
    assert.equal(new Set(tools.map(e => e.itemId)).size, 1);
    assert.equal(tools.at(-1)?.name, 'Bash');
    assert.equal(tools.at(-1)?.input, '{"command":"pwd"}');
    assert.ok(tools.every(e => e.output === 'done'));
    assert.ok(tools.every(e => e.detail === undefined));
});

test('empty new assistant message resets current partial', () => {
    const h = harness(); h.assistant('old', [text('old')]); h.assistant('new', []);
    assert.equal(h.mapper.partialText, '');
});

for (const next of ['tool', 'thinking', 'empty-message', 'message-start', 'empty-text']) {
    test(`interrupted context is separate from current partial at ${next}`, () => {
        const h = harness(); h.assistant('old', [text('PARENT_PROGRESS')]);
        if (next === 'tool') h.assistant('new', [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'owned' } }]);
        if (next === 'thinking') h.assistant('new', [{ type: 'thinking', thinking: 'not-parent-text' }]);
        if (next === 'empty-message') h.assistant('new', []);
        if (next === 'message-start') h.start('new');
        if (next === 'empty-text') h.assistant('new', [text('')]);
        assert.equal(h.mapper.partialText, '', 'wp17 current-message reset remains unchanged');
        assert.equal(h.mapper.interruptedText, next === 'empty-text' ? '' : 'PARENT_PROGRESS');
        const outcome = h.mapper.accept(result('')); assert.deepEqual(outcome, { status: 'done', finalText: '', partialText: '' });
        h.mapper.finish(outcome!);
        assert.deepEqual(h.events.filter(e => e.kind === 'message' && e.phase === 'final').map(e => e.text), ['']);
    });
}

test('two pending stopped text blocks reconcile in their original index order', () => {
    const h = harness(); h.start(); h.block(0, text('A')); h.stop(0); h.block(1, text('C')); h.stop(1);
    h.assistant('m', [text('AB')], 'first'); h.assistant('m', [text('CD')], 'second');
    assert.equal(h.mapper.partialText, 'ABCD');
});

test('oversized tool output never leaks a clipped structured secret prefix', () => {
    const h = harness();
    h.toolResult('t', '{"password":"secret-canary","padding":"' + 'x'.repeat(1048576) + '"}');
    assert.ok(h.notices.includes('capacity'));
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
});

test('JSON fragments never reach projection until complete parsed structured input is available', () => {
    const h = harness(); h.start(); h.block(0, { type: 'tool_use', id: 't', name: 'Bash', input: {} });
    h.delta(0, { type: 'input_json_delta', partial_json: '{"password":"secret-canary' });
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
    h.delta(0, { type: 'input_json_delta', partial_json: '","command":"pwd"}' });
    h.stop(0);
    const last = h.events.filter(e => e.kind === 'tool').at(-1);
    assert.ok(last?.input?.includes('[REDACTED]')); assert.ok(last?.input?.includes('pwd'));
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
    assert.equal(last?.status, 'running');
});

test('early terminal accepts parsed late input rather than freezing the empty stream placeholder', () => {
    const h = harness(); h.toolResult('early', 'done'); h.start();
    h.block(0, { type: 'tool_use', id: 'early', name: 'Bash', input: {} });
    h.delta(0, { type: 'input_json_delta', partial_json: '{"command":"pwd","password":"secret-canary"}' });
    h.stop(0);
    const tools = h.events.filter(e => e.kind === 'tool');
    assert.ok(tools.every(e => e.status === 'done' && e.output === 'done'));
    assert.equal(tools.at(-1)?.name, 'Bash');
    assert.ok(tools.at(-1)?.input?.includes('pwd'));
    assert.ok(tools.at(-1)?.input?.includes('[REDACTED]'));
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
});

test('authoritative tool snapshot before block stop retires pending JSON without malformed diagnostics', () => {
    for (const partial_json of ['{"command":"pwd"}', '{"command":"partial']) {
        const h = harness(); h.start();
        h.block(0, { type: 'tool_use', id: 't', name: 'Bash', input: {} });
        h.delta(0, { type: 'input_json_delta', partial_json });
        h.assistant('m', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } }], 'snapshot');
        const beforeStop = h.events.length;
        h.stop(0); h.stop(0);
        assert.deepEqual(h.notices, []);
        assert.equal(h.events.length, beforeStop);
        const tools = h.events.filter(e => e.kind === 'tool');
        assert.equal(new Set(tools.map(e => e.itemId)).size, 1);
        assert.equal(tools.at(-1)?.input, '{"command":"pwd"}');
        assert.ok(tools.every(e => e.status === 'running'));
        h.toolResult('t', 'TOOL_OK');
        assert.equal(h.events.filter(e => e.kind === 'tool').at(-1)?.status, 'done');
    }
});

test('incomplete tool JSON reports a bounded diagnostic without exposing the parser error', () => {
    const h = harness(); h.start(); h.block(0, { type: 'tool_use', id: 't', name: 'Bash', input: {} });
    h.delta(0, { type: 'input_json_delta', partial_json: '{"password":"secret-canary' }); h.stop(0);
    assert.ok(h.notices.includes('malformed'));
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
});

test('tool JSON cap retires fragments and cannot publish a later valid suffix', () => {
    const h = harness(); h.start(); h.block(0, { type: 'tool_use', id: 't', name: 'Bash', input: {} });
    h.delta(0, { type: 'input_json_delta', partial_json: ' '.repeat(65537) });
    h.delta(0, { type: 'input_json_delta', partial_json: '{"command":"suffix-canary"}' }); h.stop(0);
    assert.ok(h.notices.includes('capacity'));
    assert.ok(!JSON.stringify(h.events).includes('suffix-canary'));
});

test('aggregate text is bounded across messages and reasoning, with explicit capacity notice', () => {
    const h = harness(); const chunk = '가'.repeat(160000);
    h.assistant('one', [text(chunk)]); h.assistant('two', [{ type: 'thinking', thinking: chunk }]);
    h.assistant('three', [text(chunk)]);
    assert.ok(Buffer.byteLength(h.mapper.partialText) <= 1048576 - Buffer.byteLength(chunk) * 2);
    assert.ok(h.notices.includes('capacity'));
    assert.ok(h.projection.diagnostics().withinSnapshotCap);
});

test('message count is bounded at 128', () => {
    const h = harness(); for (let i = 0; i < 128; i++) h.start('m' + i);
    assert.throws(() => h.start('overflow'), /Claude.*limit/i);
});

test('block count is bounded across messages at 512', () => {
    const h = harness();
    for (let m = 0; m < 2; m++) { h.start('m' + m); for (let i = 0; i < 256; i++) h.block(i, text('')); }
    h.start('last'); assert.throws(() => h.block(0, text('')), /Claude.*limit/i);
});

test('malformed known frames and indexes throw constant redacted errors', () => {
    const invalid = [
        { type: 'assistant', message: { id: 'm', content: 'secret-canary' } },
        { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 5 }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '' }] } },
        { type: 'stream_event', event: null },
        { type: 'stream_event', event: { type: 'content_block_start', index: -1, content_block: text('') } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 512, content_block: text('') } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0.5, delta: { type: 'text_delta', text: 'secret-canary' } } },
        { ...result(), result: 5 },
    ];
    for (const frame of invalid) {
        const h = harness(); h.start();
        assert.throws(() => h.mapper.accept(frame), (error: Error) => /Claude/.test(error.message) && !error.message.includes('canary'));
    }
});

test('unknown SDK extensions and content types are ignored', () => {
    const h = harness(); h.start(); h.block(0, text('ok'));
    for (const raw of [{ type: 'future', payload: 'canary' }, { type: 'system', subtype: 'future' },
        { type: 'stream_event', event: { type: 'future' } },
        { type: 'assistant', message: { id: 'm', content: [{ type: 'future', data: 'canary' }] } },
    ]) assert.equal(h.mapper.accept(raw), undefined);
    assert.equal(h.mapper.partialText, 'ok');
});

test('failed SDK results never promote API error text to final', () => {
    for (const raw of [{ ...result('https://secret-canary'), is_error: true },
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['secret-canary'] }]) {
        const h = harness(); h.assistant('m', [text('partial')]);
        const outcome = h.mapper.accept(raw);
        assert.deepEqual(outcome, { status: 'error', finalText: null, partialText: 'partial' }); h.mapper.finish(outcome!);
        assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
    }
});

test('recorder null or throw retains the exact full result and independent salvage', () => {
    for (const failure of ['null', 'throw'] as const) {
        const h = harness(failure); h.assistant('m', [text('partial')]);
        const full = 'final'.repeat(300000), outcome = h.mapper.accept(result(full));
        assert.deepEqual(outcome, { status: 'done', finalText: full, partialText: 'partial' });
        h.mapper.finish(outcome!);
        assert.deepEqual(h.notices, ['persistence']);
        assert.equal(h.mapper.partialText, 'partial');
    }
});

test('committed non-contiguous seq and shared preview caps are preserved', () => {
    const h = harness(); h.assistant('m', [text('a'.repeat(4000))]);
    h.mapper.finish(h.mapper.accept(result('done'))!);
    assert.deepEqual(h.events.map(e => e.seq), h.events.map((_, index) => (index + 1) * 3));
    assert.ok(h.events.every(e => e.sessionId === 'jaw' && e.scope === 'separate-scope'));
    assert.ok(h.events.filter(e => e.kind === 'message').every(e => e.text.length <= 3000));
    assert.ok(h.projection.diagnostics().withinSnapshotCap);
});

test('result usage is a single validated snapshot, with cache reads separate from cache creation', () => {
    const h = harness();
    const raw = { ...result('done'), usage: { input_tokens: 10, output_tokens: 20,
        cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } };
    const outcome = h.mapper.accept(raw); h.mapper.accept(raw); h.mapper.finish(outcome!);
    assert.deepEqual(h.events.filter(e => e.kind === 'usage').map(e => [e.inputTokens, e.outputTokens, e.cachedTokens]), [[10, 20, 30]]);
    assert.ok(h.events.findIndex(e => e.kind === 'usage') < h.events.findIndex(e => e.kind === 'turn-end'));
});

test('absent, null or unknown usage never manufactures token counts', () => {
    for (const usage of [undefined, null, {}, { input_tokens: null, output_tokens: null, cache_read_input_tokens: null },
        { cache_creation_input_tokens: 40 }]) {
        const h = harness(); h.mapper.accept({ ...result(), usage });
        assert.equal(h.events.filter(e => e.kind === 'usage').length, 0);
    }
});

test('invalid known usage fields throw redacted boundary errors', () => {
    for (const usage of ['secret-canary', { input_tokens: -1 }, { output_tokens: Infinity },
        { cache_read_input_tokens: 1.5 }, { input_tokens: 'secret-canary' }]) {
        const h = harness();
        assert.throws(() => h.mapper.accept({ ...result(), usage }), /^Error: Malformed Claude SDK frame$/);
        assert.equal(h.events.filter(e => e.kind === 'usage' || e.kind === 'turn-end').length, 0);
    }
});

test('empty tool input is authoritative in assistant snapshots and after stream completion', () => {
    const h = harness(); h.toolResult('t1', 'done'); h.assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Empty', input: {} }]);
    h.toolResult('t2', 'done'); h.start('m2'); h.block(0, { type: 'tool_use', id: 't2', name: 'Empty', input: {} }); h.stop(0);
    const tools = h.events.filter(e => e.kind === 'tool' && e.input === '{}');
    assert.equal(tools.length, 2); assert.ok(tools.every(e => e.status === 'done'));
});

// ─── Native parity: compaction, status, retries, hooks, notices, rate limits, stop reasons ───

const toolRows = (h: ReturnType<typeof harness>) => h.events.filter(event => event.kind === 'tool') as Array<RuntimeEvent & { name: string; status: string; detail?: string }>;
const lastRow = (h: ReturnType<typeof harness>, name: string) => toolRows(h).filter(row => row.name === name).at(-1);

test('compaction boundary becomes a done row and reports post-compaction occupancy', () => {
    const h = harness();
    h.mapper.accept({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150000, post_tokens: 20000 } });
    assert.equal(lastRow(h, 'Context compacted')?.status, 'done');
    assert.match(lastRow(h, 'Context compacted')?.detail ?? '', /Manual · 150000 tokens → 20000/);
    assert.deepEqual(h.mapper.contextUsage, { totalTokens: 20000, modelContextWindow: null });
    assert.throws(() => h.mapper.accept({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: -1 } }));
});

test('compaction status runs, then succeeds or fails on the same row', () => {
    const h = harness();
    h.mapper.accept({ type: 'system', subtype: 'status', status: 'compacting' });
    assert.equal(lastRow(h, 'Compacting context')?.status, 'running');
    h.mapper.accept({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    assert.equal(lastRow(h, 'Compacting context')?.status, 'done');
    const f = harness();
    f.mapper.accept({ type: 'system', subtype: 'status', status: 'compacting' });
    f.mapper.accept({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too small' });
    assert.equal(lastRow(f, 'Compacting context')?.status, 'error');
    assert.equal(lastRow(f, 'Compacting context')?.detail, 'too small');
});

test('API retries, hooks and warnings map onto rows; malformed retries and unknown subtypes do not', () => {
    const h = harness();
    h.mapper.accept({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 3100, error_status: 529, error: 'overloaded' });
    assert.match(lastRow(h, 'Retrying Claude API')?.detail ?? '', /Attempt 2\/5, next in 4s/);
    assert.throws(() => h.mapper.accept({ type: 'system', subtype: 'api_retry', attempt: 'x', max_retries: 5, retry_delay_ms: 1 }));
    const g = harness();
    g.mapper.accept({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'lint', hook_event: 'PostToolUse' });
    assert.equal(lastRow(g, 'Hook: lint')?.status, 'running');
    g.mapper.accept({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'lint', hook_event: 'PostToolUse', output: '', stdout: '', stderr: 'failed lint', outcome: 'error' });
    assert.equal(lastRow(g, 'Hook: lint')?.status, 'error');
    assert.equal(lastRow(g, 'Hook: lint')?.detail, 'failed lint');
    g.mapper.accept({ type: 'system', subtype: 'hook_started', hook_id: 'h2', hook_name: 'fmt', hook_event: 'Stop' });
    g.mapper.accept({ type: 'system', subtype: 'hook_response', hook_id: 'h2', hook_name: 'fmt', hook_event: 'Stop', output: '', stdout: '', stderr: '', outcome: 'cancelled' });
    assert.equal(lastRow(g, 'Hook: fmt')?.status, 'error');
    g.mapper.accept({ type: 'system', subtype: 'informational', content: 'Consider /compact', level: 'warning' });
    assert.equal(lastRow(g, 'Claude notice')?.detail, 'Consider /compact');
    const before = toolRows(g).length;
    g.mapper.accept({ type: 'system', subtype: 'informational', content: 'quiet', level: 'info' });
    g.mapper.accept({ type: 'system', subtype: 'something_new', value: 1 });
    assert.equal(toolRows(g).length, before, 'info level and unknown subtypes stay silent');
});

test('an ordinary allowed rate-limit report adds no row', () => {
    const h = harness();
    h.mapper.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, uuid: 'u', session_id: 's' });
    assert.equal(lastRow(h, 'Claude rate limit'), undefined);
});

test('rate limits: rejected runs, warning and allowed are done; malformed status throws', () => {
    const h = harness();
    h.mapper.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790400000, rateLimitType: 'five_hour' }, uuid: 'u', session_id: 's' });
    assert.equal(lastRow(h, 'Claude rate limit')?.status, 'running');
    assert.match(lastRow(h, 'Claude rate limit')?.detail ?? '', /Limit reached \(five hour\), resets /);
    h.mapper.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' }, uuid: 'u2', session_id: 's' });
    assert.match(lastRow(h, 'Claude rate limit')?.detail ?? '', /Approaching limit \(seven day\)/);
    h.mapper.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'u3', session_id: 's' });
    assert.equal(lastRow(h, 'Claude rate limit')?.status, 'done');
    assert.throws(() => h.mapper.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'nope' }, uuid: 'u4', session_id: 's' }));
});

test('failed results name the stop reason from closed vocabularies only', () => {
    const h = harness();
    const outcome = h.mapper.accept({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['secret-canary'] });
    assert.equal(outcome?.status, 'error');
    assert.equal(h.mapper.failureText, 'Claude turn failed: reached the turn limit');
    h.mapper.finish(outcome!);
    assert.ok(!JSON.stringify(h.events).includes('secret-canary'));
    assert.equal(harness().mapper.failureText, null);
    const u = harness();
    u.mapper.accept({ type: 'result', subtype: 'error_during_execution', is_error: true });
    assert.equal(u.mapper.failureText, 'Claude turn failed: during execution');
});

test('an unknown future result subtype resolves by is_error instead of hanging', () => {
    const h = harness();
    assert.deepEqual(h.mapper.accept({ type: 'result', subtype: 'future_x', is_error: false, result: 'ok' }), { status: 'done', finalText: 'ok', partialText: '' });
    const e = harness();
    assert.equal(e.mapper.accept({ type: 'result', subtype: 'future_x', is_error: true })?.status, 'error');
});

test('result usage plus modelUsage reports occupancy with the context window', () => {
    const h = harness();
    h.mapper.accept({ type: 'result', subtype: 'success', is_error: false, result: 'ok',
        usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 },
        modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } } });
    assert.deepEqual(h.mapper.contextUsage, { totalTokens: 2000, modelContextWindow: 200000 });
});
