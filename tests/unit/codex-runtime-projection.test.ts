import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// Recorders are injected here; module loading must not initialize shared SQLite.
let unexpectedDefaultWrites = 0;
mock.module('../../src/trace/activity-journal.js', { namedExports: { markActivityFailure: () => { unexpectedDefaultWrites++; throw new Error('Injected recorder reached the default loss writer'); }, appendActivityBody: () => {
    unexpectedDefaultWrites++; throw new Error('Pure projection test reached the default trace writer');
} } });
test.after(() => assert.equal(unexpectedDefaultWrites, 0));
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
const { CodexProjection } = await import('../../src/agent/runtime/codex-projection.ts');
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import { encodeRuntimeBody, decodeRuntimeBody } from '../../src/trace/runtime-body-codec.ts';
import { stringifyTraceValue } from '../../src/trace/redact.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';

function harness(scope = 'scope-a') {
    const events: RuntimeEvent[] = [];
    const notices: string[] = [];
    let seq = 0;
    const state = new RuntimeProjection({ runId: 'run-' + scope, sessionId: 'jaw-chat',
        scope, turnId: 'run-' + scope, audience: 'internal', parentItemId: 'jaw-parent' },
    (context, body) => {
        const event: RuntimeEvent = { ...context, version: 1, seq: seq += 3, ...body };
        events.push(event);
        return event;
    }, reason => { notices.push(reason); });
    state.start('codex-app');
    const projection = new CodexProjection(state);
    const observe = (method: string, params: Record<string, unknown>, phase = '') => projection.observe(method, params, null, phase);
    return { state, events, notices, observe };
}
const tools = (events: RuntimeEvent[]) => events.filter((e): e is RuntimeEvent & Extract<RuntimeEventBody, { kind: 'tool' }> => e.kind === 'tool');

test('Codex output snapshots reconcile and terminal is exactly once', () => {
    const h = harness();
    h.observe('item/started', { item: { id: 'native-secret', type: 'commandExecution', command: 'pwd' } });
    h.observe('item/commandExecution/outputDelta', { itemId: 'native-secret', delta: 'one' });
    h.observe('item/commandExecution/outputDelta', { itemId: 'native-secret', delta: 'two' });
    const done = { item: { id: 'native-secret', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'onetwo' } };
    h.observe('item/completed', done);
    h.observe('item/completed', done);
    assert.equal(tools(h.events).at(-1)?.output, 'onetwo');
    assert.equal(tools(h.events).at(-1)?.name, 'command');
    assert.equal(tools(h.events).filter(e => e.status === 'done').length, 1);
    assert.equal(new Set(tools(h.events).map(e => e.itemId)).size, 1);
    assert.ok(!JSON.stringify(h.events).includes('native-secret'));
    assert.equal(h.events.filter(e => e.kind === 'message').length, 0);
    h.state.close({ kind: 'turn-end', status: 'done', finalText: 'policy-approved answer' });
    h.state.close({ kind: 'turn-end', status: 'done', finalText: 'must not win' });
    assert.equal(h.events.filter(e => e.kind === 'turn-end').length, 1);
    assert.ok(h.events.every(e => e.seq % 3 === 0 && e.parentItemId === 'jaw-parent'));
});

test('commentary unknown and reasoning stay distinct; item completion is not final', () => {
    const h = harness();
    h.observe('item/agentMessage/delta', { itemId: 'm', delta: 'checking' }, 'commentary');
    h.observe('item/agentMessage/delta', { itemId: 'n', delta: 'answer' });
    h.observe('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'summary' });
    h.observe('item/completed', { item: { id: 'n', type: 'agentMessage', text: 'echo answer' } });
    assert.deepEqual(h.events.filter(e => e.kind === 'message').map(e => e.phase), ['commentary', 'unknown']);
    assert.equal(h.events.filter(e => e.kind === 'reasoning').length, 1);
    assert.equal(h.events.filter(e => e.kind === 'turn-end').length, 0);
});

test('nonzero interrupted and unknown completion never claim success', () => {
    for (const [status, exitCode, expected] of [['completed', 2, 'error'], ['interrupted', undefined, 'stopped'], ['new-state', undefined, 'error']] as const) {
        const h = harness();
        h.observe('item/completed', { item: { id: 't', type: 'commandExecution', status, exitCode } });
        assert.equal(tools(h.events).at(-1)?.status, expected);
    }
});

test('schema-defined statusless web search completes without a fabricated failure', () => {
    const h = harness();
    h.observe('item/started', { item: { id: 'search', type: 'webSearch', query: 'fixture', action: null } });
    h.observe('item/completed', { item: { id: 'search', type: 'webSearch', query: 'fixture', action: null, results: null } });
    assert.equal(tools(h.events).at(-1)?.status, 'done');
    const unknown = harness('unknown-search');
    unknown.observe('item/completed', { item: { id: 'search', type: 'webSearch', status: 'unexpected' } });
    assert.equal(tools(unknown.events).at(-1)?.status, 'error', 'unknown explicit states stay conservative');
});

test('same provider item across scopes stays isolated and preview caps hold', () => {
    const a = harness('a'), b = harness('b');
    a.state.tool('same', { name: 'bash', output: 'a' });
    b.state.tool('same', { name: 'bash', output: 'b' });
    assert.equal(tools(a.events).at(-1)?.output, 'a');
    assert.equal(tools(b.events).at(-1)?.output, 'b');
    for (let i = 0; i < 200; i++) a.state.tool(String(i), { output: '\u0000'.repeat(4000) });
    const d = a.state.diagnostics();
    assert.ok(d.items <= 160 && d.previewChars <= 24000 && d.withinSnapshotCap && d.truncated);
    assert.ok(tools(a.events).every(e => (e.output?.length ?? 0) <= 3000));
});

test('preview truncation and capacity publish one compatible gap without ending the live turn', () => {
    const gaps: Record<string, unknown>[] = [];
    const events: RuntimeEvent[] = [];
    const context = { runId: 'bounded-live', sessionId: 'example-session', scope: 'example-scope', turnId: 'example-turn', audience: 'public' as const };
    const stop = subscribe(e => { if (e.event === 'agent_runtime_gap' && e.data['runId'] === context.runId) gaps.push(e.data); });
    try {
        const p = new RuntimeProjection(context, (owner, body) => {
            const event = { ...owner, version: 1 as const, seq: events.length + 1, ...body }; events.push(event); return event;
        }, () => {});
        p.start('fixture');
        for (let i = 0; i < 250; i++) p.text('message', `message-${i}`, 'x'.repeat(4000), 'replace');
        assert.equal(p.diagnostics().truncated, true);
        assert.equal(p.diagnostics().recordingFailed, false);
        assert.ok(p.diagnostics().previewChars <= 24000 && p.diagnostics().items <= 160);
        assert.deepEqual(gaps, [{ runId: context.runId, sessionId: context.sessionId, scope: context.scope, reason: 'projection_degraded' }]);
        assert.equal(events.some(e => e.kind === 'turn-end'), false);
        p.close({ kind: 'turn-end', status: 'done', finalText: 'Final delivery remains authoritative.' });
        assert.equal(events.at(-1)?.kind, 'turn-end');
        assert.equal(gaps.length, 1);
    } finally { stop(); }
});

test('first persistence failure latches off every later canonical write, including final', () => {
    let attempts = 0;
    const p = new RuntimeProjection({ runId: 'r', sessionId: 's', scope: 'q', turnId: 't', audience: 'internal' },
        () => { attempts++; throw new Error('disk failure'); }, () => {});
    assert.doesNotThrow(() => {
        p.start('codex-app');
        p.tool('native-tool', { name: 'command', output: 'later output' });
        p.text('message', 'native-message', 'later text', 'append');
        p.usage({ input_tokens: 2 });
        p.close({ kind: 'turn-end', status: 'error', finalText: null });
        p.close({ kind: 'turn-end', status: 'done', finalText: 'wrong' });
    });
    assert.equal(attempts, 1);
    assert.equal(p.diagnostics().recordingFailed, true);
});

for (const failure of ['null', 'throw'] as const) {
    test('one public gap, no later writes, and a fresh run is independent: ' + failure, () => {
        let attempts = 0;
        const gaps: Record<string, unknown>[] = [];
        const context = { runId: 'gap-' + failure, sessionId: 'chat', scope: 'scope', turnId: 'turn', audience: 'public' as const };
        const p = new RuntimeProjection(context, (identity, body) => {
            attempts++;
            if (attempts === 2) {
                if (failure === 'throw') throw new Error('recording failed');
                return null;
            }
            return { ...identity, version: 1, seq: attempts * 3, ...body };
        }, () => {});
        const unsubscribe = subscribe(entry => {
            if (entry.event !== 'agent_runtime_gap' || entry.data['runId'] !== context.runId) return;
            gaps.push(entry.data);
            // Reentrant listeners see the latch already set.
            p.usage({ input_tokens: 9 });
        });
        try {
            p.start('codex-app');
            p.tool('first', { name: 'command', output: 'first failed write' });
            p.tool('second', { name: 'command', output: 'must not be written' });
            p.text('message', 'm', 'must not be written', 'append');
            p.report('persistence');
            p.close({ kind: 'turn-end', status: 'done', finalText: 'handled independently' });
            assert.equal(attempts, 2, 'only start success and the first failed record attempt');
            assert.deepEqual(gaps, [{ runId: context.runId, sessionId: 'chat', scope: 'scope', reason: 'projection_degraded' }]);
            assert.equal(p.diagnostics().lastSeq, 3);
            let freshAttempts = 0;
            const fresh = new RuntimeProjection({ ...context, runId: context.runId + '-fresh' }, (identity, body) => {
                freshAttempts++;
                return { ...identity, version: 1, seq: freshAttempts, ...body };
            }, () => {});
            fresh.start('codex-app');
            fresh.close({ kind: 'turn-end', status: 'done', finalText: '' });
            assert.equal(freshAttempts, 2, 'failure latch is per run, not a process/global switch');
        } finally { unsubscribe(); }
    });
}

function codecHarness() {
    const beforeCodec: RuntimeEventBody[] = [];
    const journal: unknown[] = [];
    const delivered: RuntimeEvent[] = [];
    const state = new RuntimeProjection({
        runId: 'producer-codec-run', sessionId: 'jaw-chat', scope: 'separate-scope',
        turnId: 'jaw-turn', audience: 'internal',
    }, (context, body) => {
        beforeCodec.push(body);
        const identity = { version: 1 as const, runId: context.runId,
            sessionId: context.sessionId, scope: context.scope, turnId: context.turnId,
            seq: 3 * (journal.length + 1) };
        const encoded = encodeRuntimeBody(identity, body);
        const stored: unknown = JSON.parse(stringifyTraceValue(encoded.raw));
        journal.push(stored);
        const decoded = decodeRuntimeBody(stored, identity, body.kind);
        assert.ok(decoded, 'real codec round-trip must produce an event');
        delivered.push(decoded);
        return decoded;
    }, () => {});
    state.start('fixture');
    return { state, beforeCodec, journal, delivered };
}

for (const provider of ['codex'] as const) {
    test(provider + ' actual producer redacts long JSON BEFORE preview clip and codec', () => {
        const h = codecHarness();
        const canary = 'ordinaryCanaryValueNearStart_927451';
        const args = { password: canary, padding: 'x'.repeat(10000), note: 'safe' };
        const full = JSON.stringify(args);
        assert.ok(full.indexOf(canary) < 80 && full.length > 3000);
        if (provider === 'codex') {
            const producer = new CodexProjection(h.state);
            producer.observe('item/started', { item: {
                type: 'mcpToolCall', id: 'native-private', server: 'fixture', tool: 'run', arguments: args,
            } }, null, '');
        }
        const body = h.beforeCodec.find(event => event.kind === 'tool');
        assert.ok(body?.kind === 'tool');
        assert.ok(body.input?.includes('[REDACTED]'), 'redaction already happened before the emitter/codec');
        assert.ok((body.input?.length ?? 0) <= 3000);
        assert.ok(!JSON.stringify(h.beforeCodec).includes(canary), 'producer/cache-facing body is safe');
        assert.ok(!JSON.stringify(h.journal).includes(canary), 'stored tuples are safe');
        assert.ok(!JSON.stringify(h.delivered).includes(canary), 'decoded/live value is safe');
        assert.ok(!JSON.stringify(h.delivered).includes('inputStructured'), 'hint is adapter-private');
        assert.ok(!JSON.stringify(h.delivered).includes('native-private'));
        assert.equal(h.state.diagnostics().recordingFailed, false);
    });

    test(provider + ' incomplete known JSON is withheld, then full replacement is redacted', () => {
        const h = codecHarness();
        const canary = 'pieceCanary_572901_nearStart';
        const incomplete = '{"password":"' + canary.slice(0, 12);
        const args = { password: canary, padding: 'y'.repeat(5000) };
        if (provider === 'codex') {
            const producer = new CodexProjection(h.state);
            producer.observe('item/started', { item: { id: 'call', type: 'mcpToolCall',
                server: 'fixture', tool: 'run', arguments: incomplete } }, null, '');
            producer.observe('item/completed', { item: { id: 'call', type: 'mcpToolCall',
                server: 'fixture', tool: 'run', arguments: args, status: 'completed' } }, null, '');
        }
        const bodies = h.beforeCodec.filter(body => body.kind === 'tool');
        assert.equal(bodies[0]?.input, '[structured content withheld]');
        assert.ok(bodies.at(-1)?.input?.includes('[REDACTED]'));
        for (const sink of [h.beforeCodec, h.journal, h.delivered]) {
            assert.ok(!JSON.stringify(sink).includes(canary.slice(0, 12)));
            assert.ok(!JSON.stringify(sink).includes(canary));
        }
    });
}

test('protocol-known JSON output deltas use the private full accumulator, not sanitized fragments', () => {
    const h = codecHarness();
    const canary = 'jsonFragmentCanary_389201';
    h.state.tool('structured', { name: 'json tool', outputStructured: true,
        delta: '{"password":"' + canary.slice(0, 8) });
    h.state.tool('structured', { outputStructured: true, delta: canary.slice(8) + '","ok":true}' });
    const bodies = h.beforeCodec.filter(body => body.kind === 'tool');
    assert.equal(bodies[0]?.output, '[structured content withheld]');
    assert.ok(bodies.at(-1)?.output?.includes('[REDACTED]'));
    assert.ok(!JSON.stringify(h.beforeCodec).includes(canary.slice(0, 8)));
    assert.ok(!JSON.stringify(h.journal).includes(canary));
});

test('ordinary shell brackets and Markdown remain readable through producer and codec', () => {
    const h = codecHarness();
    const producer = new CodexProjection(h.state);
    producer.observe('item/started', { item: { id: 'shell', type: 'commandExecution', command: '[ -f file ]' } }, null, '');
    producer.observe('item/agentMessage/delta', { itemId: 'answer', delta: '[docs](https://example.test)' }, null, 'final');
    const tool = h.delivered.find(event => event.kind === 'tool');
    const message = h.delivered.find(event => event.kind === 'message');
    assert.equal(tool?.kind === 'tool' ? tool.input : null, '[ -f file ]');
    assert.equal(message?.kind === 'message' ? message.text : null, '[docs](https://example.test)');
});

test('Codex known argument JSON masks split, escaped, duplicate and array secrets before every public sink', () => {
    const samples = [
        '{"pass\\u0077ord":"escapedCanary","ok":true}',
        '{"password":"duplicateCanary","password":"[REDACTED]","ok":true}',
        '[{"cookie":"arrayCanary","ok":true}]',
        JSON.stringify({ padding: 'x'.repeat(5000), password: 'lateCanary' }),
    ];
    for (const argumentsText of samples) {
        const h = codecHarness();
        const producer = new CodexProjection(h.state);
        producer.observe('item/started', { item: { id: 'known-args', type: 'mcpToolCall',
            server: 'fixture', tool: 'run', arguments: '{"pass' } }, null, '');
        producer.observe('item/completed', { item: { id: 'known-args', type: 'mcpToolCall',
            server: 'fixture', tool: 'run', arguments: argumentsText, status: 'completed' } }, null, '');
        const first = h.beforeCodec.find(event => event.kind === 'tool');
        assert.ok(first?.kind === 'tool');
        assert.equal(first.input, '[structured content withheld]');
        for (const sink of [h.beforeCodec, h.journal, h.delivered]) {
            assert.ok(!JSON.stringify(sink).includes('Canary'));
        }
        assert.equal(h.state.diagnostics().recordingFailed, false);
    }
});

test('private structured accumulator retires overflowing deltas until a bounded replacement arrives', () => {
    const h = codecHarness();
    h.state.tool('large-json', { name: 'json', outputStructured: true, delta: 'x'.repeat(FULLTEXT_MAX_CHARS + 1) });
    h.state.tool('large-json', { outputStructured: true, delta: 'overflowCanary' });
    const beforeReplacement = tools(h.delivered).at(-1);
    assert.equal(beforeReplacement?.output, '[structured content withheld]');
    h.state.tool('large-json', { outputStructured: true, output: '{"password":"replacementCanary","safe":1}' });
    assert.deepEqual(JSON.parse(tools(h.delivered).at(-1)?.output || '{}'), { password: '[REDACTED]', safe: 1 });
    assert.ok(!JSON.stringify(h.journal).includes('Canary'));
    assert.equal(h.state.diagnostics().truncated, true);
    assert.equal(h.state.diagnostics().recordingFailed, false);
});

test('Codex file change notifications reach transcript observer without changing activity preview', () => {
    const patches: any[] = [], events: RuntimeEvent[] = [];
    const context = { runId: 'r', sessionId: 's', scope: 'q', turnId: 't', audience: 'internal' as const };
    const state = new RuntimeProjection(context, (owner, body) => {
        const event = { ...owner, version: 1 as const, seq: events.length + 1, ...body }; events.push(event); return event;
    }, () => {}, { text() {}, close() {}, tool(ref, patch) { patches.push({ ref, ...patch }); } });
    const projection = new CodexProjection(state);
    const changes = [{ path: 'a', kind: { type: 'update' }, diff: 'fixture' }];
    projection.observe('item/started', { item: { id: 'x', type: 'fileChange', changes } }, null, '');
    projection.observe('item/fileChange/patchUpdated', { itemId: 'x', changes }, null, '');
    projection.observe('item/completed', { item: { id: 'x', type: 'fileChange', status: 'completed', changes } }, null, '');
    assert.equal(patches.length, 3);
    assert.ok(patches.every(p => p.semantic === 'file_change' && p.fileChanges === changes));
    assert.ok(tools(events).some(event => event.input?.includes('fixture')));
});

test('Codex file change projection promotes legacy output and preserves exact patch beside ordinary tools', async () => {
    const { CodeTurnNormalizer } = await import('../../src/code-mode/normalize.ts');
    const context = { runId: 'r', sessionId: 's', scope: 'q', turnId: 't', epoch: 1, audience: 'internal' as const, isCurrent: () => true };
    const items = new Map<string, import('../../src/code-mode/wire.ts').CodeItem>(), events: RuntimeEvent[] = [];
    const normalizer = new CodeTurnNormalizer({ context, commitItem(item) { items.set(item.itemId, structuredClone(item)); return { publish() {} }; },
        failPersistence(error) { throw error; } });
    const state = new RuntimeProjection(context, (owner, body) => {
        const event = { ...owner, version: 1 as const, seq: events.length + 1, ...body }; events.push(event); return event;
    }, () => {}, normalizer.observer(context));
    const p = new CodexProjection(state);
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const changes = [{ path: 'a', kind: { type: 'update' }, diff: patch }];
    p.observe('item/fileChange/outputDelta', { itemId: 'x', delta: 'progress' }, null, '');
    p.observe('item/started', { item: { id: 'x', type: 'fileChange', changes } }, null, '');
    p.observe('item/fileChange/patchUpdated', { itemId: 'x', changes }, null, '');
    p.observe('item/completed', { item: { id: 'x', type: 'fileChange', status: 'completed', changes } }, null, '');
    for (const [id, type] of [['cmd', 'commandExecution'], ['web', 'webSearch'], ['mcp', 'mcpToolCall']]) {
        p.observe('item/started', { item: { id, type, command: 'pwd', query: 'q', arguments: {} } }, null, '');
    }
    const rows = [...items.values()], change = rows.find(item => item.kind === 'file_change')!;
    assert.equal(change.status, 'done');
    assert.equal(change.fileChange?.changes[0]?.diff, patch);
    assert.equal(change.tool?.output, 'progress');
    assert.equal(rows.filter(item => item.kind === 'tool_call').length, 3);
    assert.ok(tools(events).some(event => event.input?.includes('old')));
});
