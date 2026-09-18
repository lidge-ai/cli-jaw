import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeClose } from '../../src/agent/runtime/claude-sdk-close.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.ts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
// Recorders are injected here; module loading must not initialize shared SQLite.
mock.module('../../src/trace/activity-journal.js', { namedExports: { appendActivityBody: () => null, markActivityFailure: () => {} } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

test('close latches before reentrant callbacks and awaits the actual barrier', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = []; let reentered;
    const close = createClaudeClose({ timeoutMs: 100,
        fence: () => { order.push('fence'); reentered = close(); },
        startTermination: () => { order.push('terminate'); }, settlePending: () => { order.push('settle'); },
        readerDone: () => barrier, onClosed: () => { order.push('closed'); } });
    const first = close(); assert.equal(first, reentered); assert.equal(first, close());
    assert.deepEqual(order, ['fence', 'terminate', 'settle']);
    release(); await first; assert.deepEqual(order, ['fence', 'terminate', 'settle', 'closed']);
});
test('all thrown values reject cleanup without stranding local pending settlement', async () => {
    for (const thrown of [undefined, null, false, 0, new Error('private secret')]) {
        let settled = false, closed = false, waited = false;
        const close = createClaudeClose({ timeoutMs: 100, fence() {}, startTermination() { throw thrown; },
            settlePending() { settled = true; }, readerDone: async () => { waited = true; }, onClosed() { closed = true; } });
        await assert.rejects(close(), /claude_close_failed/);
        assert.equal(settled, true); assert.equal(waited, true); assert.equal(closed, false);
    }
});
test('fence or settlement errors do not skip termination and barrier', async () => {
    for (const where of ['fence', 'settle']) {
        let terminated = false, waited = false;
        const close = createClaudeClose({ timeoutMs: 100,
            fence() { if (where === 'fence') throw new Error('private'); },
            startTermination() { terminated = true; },
            settlePending() { if (where === 'settle') throw new Error('private'); },
            readerDone: async () => { waited = true; } });
        await assert.rejects(close(), /claude_close_failed/); assert.ok(terminated && waited);
    }
});
test('never-ending or rejected barrier cannot claim successful close', async () => {
    for (const reject of [false, true]) {
        let closed = false;
        const close = createClaudeClose({ timeoutMs: 10, fence() {}, startTermination() {}, settlePending() {},
            readerDone: () => reject ? Promise.reject(new Error('private')) : new Promise(() => {}), onClosed() { closed = true; } });
        await assert.rejects(close(), /claude_close_(timeout|failed)/); assert.equal(closed, false);
        await assert.rejects(close(), /claude_close_(timeout|failed)/);
    }
});
test('successful close clears its timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let closed = 0;
    const close = createClaudeClose({ timeoutMs: 100, fence() {}, startTermination() {}, settlePending() {},
        readerDone: async () => {}, onClosed() { closed++; } });
    await close(); t.mock.timers.tick(1000); await close(); assert.equal(closed, 1);
});

async function sessionFixture(id: string, closeError = false, overrides: Partial<Omit<ClaudeSessionOptions, 'queryFactory'>> = {}) {
    const frames: unknown[] = []; let wake: (() => void) | undefined, stopped = false, offered = 0, closed = 0;
    let sdkOptions!: Options;
    const output = async function* () { while (!stopped) { if (frames.length) yield frames.shift(); else await new Promise<void>(resolve => { wake = resolve; }); } };
    const push = (frame: unknown) => { frames.push(frame); wake?.(); wake = undefined; };
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => ({ runId: id, sessionId: id, scope: id, turnId: id, audience: 'internal', isCurrent: () => true }),
        record: () => null,
        ...overrides,
        queryFactory: ({ prompt, options }) => {
            sdkOptions = options;
            void (async () => { for await (const _message of prompt) offered++; })();
            return { [Symbol.asyncIterator]: output, close() { closed++; stopped = true; wake?.(); if (closeError) throw undefined; } };
        },
    });
    return { session, push, get options() { return sdkOptions; }, get offered() { return offered; }, get closed() { return closed; } };
}
test('Stop after input yield closes exactly once and leaves independent session running', async () => {
    const a = await sessionFixture('a'), b = await sessionFixture('b');
    const first = a.session.send({ text: 'a' }, () => {}), second = b.session.send({ text: 'b' }, () => {});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(a.offered, 1);
    a.push({ type: 'system', subtype: 'init', session_id: 'native-a', permissionMode: 'default' });
    await new Promise(resolve => setImmediate(resolve));
    await a.session.cancel(); assert.equal((await first).status, 'stopped');
    assert.equal(a.session.nativeSessionId, 'native-a'); assert.equal(b.session.alive, true);
    b.push({ type: 'result', subtype: 'success', is_error: false, result: 'b answer' });
    assert.equal((await second).finalText, 'b answer'); await b.session.close();
    assert.equal(a.closed, 1); assert.equal(b.closed, 1);
});
test('terminal committed before Stop remains done while falsy close failure rejects cleanup', async () => {
    const f = await sessionFixture('done', true);
    const turn = f.session.send({ text: 'a' }, () => {});
    f.push({ type: 'result', subtype: 'success', is_error: false, result: 'final' });
    assert.equal((await turn).status, 'done');
    await assert.rejects(f.session.close(), /claude_close_failed/); assert.equal(f.closed, 1);
});
test('malformed SDK frames retain a specific safe failure code', async () => {
    const f = await sessionFixture('malformed');
    const turn = f.session.send({ text: 'a' }, () => {});
    f.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: -1 } });
    assert.equal((await turn).status, 'error');
    assert.equal(f.session.lastError, 'claude_sdk_frame_malformed');
    await f.session.close();
});
test('already-aborted acquisition never creates a query', async () => {
    const signal = AbortSignal.abort(); let factories = 0;
    await assert.rejects(createClaudeSdkSession({ signal,
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 100, getTurnContext: () => { throw new Error('unreachable'); },
        queryFactory: () => { factories++; throw new Error('unreachable'); },
    }), /claude_acquire_aborted/);
    assert.equal(factories, 0);
});

const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
const toolFrame = (parent: string | null, id: string, name = 'Bash') => ({ type: 'assistant', parent_tool_use_id: parent,
    message: { id: 'message-' + id, content: [{ type: 'tool_use', id, name, input: name === 'Agent'
        ? { prompt: 'Fixture child', description: 'Fixture', subagent_type: 'general-purpose', run_in_background: false }
        : { command: 'printf child' } }] } });
const finalFrame = () => ({ type: 'result', subtype: 'success', is_error: false, result: 'PARENT', uuid: 'result-a' });

async function decisionFixture(t: TestContext, recording = true) {
    const events: RuntimeEvent[] = [], registry = new RuntimeRequests();
    let current = true, turnId = 'turn-a', seq = 0;
    const f = await sessionFixture('decision', false, { registry, deferTurnEnd: true, promptTimeoutMs: 3000,
        getTurnContext: () => ({ runId: 'run-' + turnId, sessionId: 'chat', scope: 'execution-scope', turnId,
            audience: 'internal', isCurrent: () => current }),
        record: (context, body) => {
            if (!recording) return null;
            const event: RuntimeEvent = { ...context, version: 1, seq: ++seq, ...body }; events.push(event); return event;
        } });
    t.after(() => f.session.close());
    return { ...f, get closed() { return f.closed; }, get offered() { return f.offered; },
        events, registry, revoke: () => { current = false; }, next: () => { turnId = 'turn-b'; },
        ask: (id: string, signal = new AbortController().signal) => f.options.canUseTool!('Bash', { command: 'printf child' },
            { signal, toolUseID: id, requestId: 'sdk-control-' + id }),
        finalize: () => {
            const outcome = f.session.claimTurnOutcome(turnId); assert.ok(outcome);
            assert.equal(f.session.finalizeTurn(turnId, { kind: 'turn-end', status: outcome.status, finalText: outcome.finalText }), true);
        } };
}

test('child callback becomes actionable after the last parent declaration with no further frame', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'run' }, () => {});
    const answer = f.ask('child');
    f.push(toolFrame('parent', 'child')); await checkpoint();
    assert.equal(f.registry.list('chat').length, 0);
    f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    const pending = f.registry.list('chat')[0]; assert.ok(pending, 'reconcile must not require another provider frame');
    assert.equal(pending.scope, 'execution-scope'); assert.notEqual(pending.runId, pending.turnId);
    assert.ok(f.events.find(event => event.kind === 'request')?.parentItemId);
    f.registry.respond(pending.requestId, pending, { optionId: 'allow' });
    assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'printf child' } });
    f.push(finalFrame()); assert.equal((await turn).finalText, 'PARENT'); f.finalize();
    assert.equal(f.events.filter(event => event.kind === 'request').length, 1);
    assert.equal(f.events.filter(event => event.kind === 'request-settled').length, 1);
    assert.equal(f.registry.list('chat').length, 0);
});

test('Stop in parent recorder reentrancy denies both waiting child callbacks', async t => {
    const f = await decisionFixture(t);
    const turn = f.session.send({ text: 'run' }, event => {
        if (event.kind === 'tool' && event.name === 'Agent') void f.session.cancel();
    });
    const a = f.ask('one'), b = f.ask('two');
    f.push(toolFrame('parent', 'one')); f.push(toolFrame('parent', 'two')); await checkpoint();
    f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    assert.equal((await a)?.behavior, 'deny'); assert.equal((await b)?.behavior, 'deny');
    assert.equal((await turn).status, 'stopped');
    assert.equal(f.registry.list('chat').length, 0);
    assert.equal(f.events.filter(event => event.kind === 'request').length, 0);
});

test('parent done stops unfinished child display before deferred finalization', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'run' }, () => {});
    f.push(toolFrame(null, 'parent', 'Agent')); f.push(toolFrame('parent', 'child')); await checkpoint();
    const child = f.events.find(event => event.kind === 'tool' && event.parentItemId); assert.ok(child && 'itemId' in child);
    f.push(finalFrame()); assert.equal((await turn).status, 'done');
    const terminal = f.events.filter(event => event.kind === 'tool' && event.itemId === child.itemId).at(-1);
    assert.equal(terminal?.kind === 'tool' && terminal.status, 'stopped');
    assert.equal(f.events.some(event => event.kind === 'turn-end'), false);
    assert.equal((await f.ask('child'))?.behavior, 'deny');
    assert.equal(f.registry.list('chat').length, 0);
    f.finalize(); assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 1);
});

test('revoked owner can record only captured terminal child snapshots during Stop', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'run' }, () => {});
    f.push(toolFrame(null, 'parent', 'Agent')); f.push(toolFrame('parent', 'child')); await checkpoint();
    const before = f.events.length; f.revoke(); await f.session.cancel();
    assert.equal((await turn).status, 'stopped');
    const passive = f.events.slice(before);
    assert.ok(passive.length > 0);
    assert.ok(passive.every(event => event.kind === 'tool' && event.status === 'stopped'
        && event.runId === 'run-turn-a' && event.turnId === 'turn-a' && !!event.parentItemId));
    assert.equal((await f.ask('late'))?.behavior, 'deny');
    f.push(toolFrame('parent', 'late')); await checkpoint();
    assert.equal(f.events.length, before + passive.length);
    assert.equal(f.registry.list('chat').length, 0);
    f.finalize();
});

test('per-child callback abort does not cancel a sibling in the captured turn', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'run' }, () => {});
    const signal = new AbortController(), a = f.ask('one', signal.signal), b = f.ask('two');
    f.push(toolFrame('parent', 'one')); f.push(toolFrame('parent', 'two'));
    f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    assert.equal(f.registry.list('chat').length, 2); signal.abort();
    assert.equal((await a)?.behavior, 'deny');
    const pending = f.registry.list('chat')[0]; assert.ok(pending);
    f.registry.respond(pending.requestId, pending, { optionId: 'deny' });
    assert.equal((await b)?.behavior, 'deny');
    f.push(finalFrame()); await turn; f.finalize();
    assert.equal(f.events.filter(event => event.kind === 'request-settled').length, 2);
});

test('broken journal cannot fabricate a parent display ID for child approval', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await decisionFixture(t, false), turn = f.session.send({ text: 'run' }, () => {});
    const answer = f.ask('child');
    f.push(toolFrame('parent', 'child')); f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    assert.equal(f.registry.list('chat').length, 0); t.mock.timers.tick(1001);
    assert.equal((await answer)?.behavior, 'deny');
    f.push(finalFrame()); assert.equal((await turn).finalText, 'PARENT'); f.finalize();
    assert.equal(f.events.length, 0);
});

test('retired IDs fail closed on a later send without granting or rebinding', async t => {
    const f = await decisionFixture(t), a = f.session.send({ text: 'a' }, () => {});
    f.push(toolFrame(null, 'reused')); f.push(finalFrame()); await a; f.finalize();
    f.next(); const b = f.session.send({ text: 'b' }, () => {}), answer = f.ask('reused');
    f.push({ type: 'assistant', message: { id: 'partial-b', content: [{ type: 'text', text: 'B ONLY' }] } });
    f.push(toolFrame(null, 'reused'));
    assert.equal((await answer)?.behavior, 'deny');
    assert.deepEqual(await b, { status: 'error', finalText: null, partialText: 'B ONLY' });
    assert.equal(f.session.lastError, 'claude_reader_failed'); assert.equal(f.session.alive, false);
    await f.session.close(); assert.equal(f.closed, 1);
    assert.equal(f.registry.list('chat').length, 0);
    assert.equal(f.events.filter(event => event.kind === 'request').length, 0);
    const fresh = await decisionFixture(t), next = fresh.session.send({ text: 'fresh' }, () => {});
    fresh.push(finalFrame()); assert.equal((await next).status, 'done'); fresh.finalize();
});

test('idle child traffic cannot prelink a canary into the next borrower', async t => {
    const f = await decisionFixture(t), a = f.session.send({ text: 'a' }, () => {});
    f.push(finalFrame()); await a;
    f.push({ type: 'assistant', parent_tool_use_id: 'future-parent', message: {
        id: 'idle', content: [{ type: 'text', text: 'IDLE CHILD CANARY' }] } }); await checkpoint();
    f.finalize(); f.next(); const b = f.session.send({ text: 'b' }, () => {});
    f.push(toolFrame(null, 'future-parent', 'Agent')); f.push({ ...finalFrame(), uuid: 'result-b' }); await b; f.finalize();
    assert.ok(!JSON.stringify(f.events).includes('IDLE CHILD CANARY'));
});

test('reverse nested prelink reaches a live callback without any extra provider frame', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'nested' }, () => {});
    const answer = f.ask('deep-tool');
    f.push(toolFrame('agent-c', 'deep-tool'));
    f.push(toolFrame('agent-b', 'agent-c', 'Agent'));
    f.push(toolFrame('agent-a', 'agent-b', 'Agent'));
    f.push(toolFrame(null, 'agent-a', 'Agent')); await checkpoint();
    const pending = f.registry.list('chat')[0]; assert.ok(pending, 'all received nested declarations must reconcile');
    assert.ok(f.events.filter(event => event.kind === 'tool' && event.parentItemId).length >= 3);
    f.registry.respond(pending.requestId, pending, { optionId: 'deny' });
    assert.equal((await answer)?.behavior, 'deny');
    f.push(finalFrame()); await turn; f.finalize();
    assert.equal(f.events.filter(event => event.kind === 'request').length, 1);
    assert.equal(f.registry.list('chat').length, 0);
});

for (const prelinked of [true, false]) test(`child ID without a waiter is retired before root reuse (prelinked=${prelinked})`, async t => {
    const f = await decisionFixture(t), a = f.session.send({ text: 'a' }, () => {});
    if (prelinked) f.push(toolFrame('parent', 'child-reused'));
    f.push(toolFrame(null, 'parent', 'Agent'));
    if (!prelinked) f.push(toolFrame('parent', 'child-reused'));
    f.push(finalFrame()); await a; f.finalize();
    assert.equal(f.events.filter(event => event.kind === 'request').length, 0, 'A has no callback demand');
    f.next(); const b = f.session.send({ text: 'b' }, () => {});
    f.push({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'B SALVAGE' }] } });
    f.push(toolFrame(null, 'child-reused')); await checkpoint();
    assert.equal(f.session.lastError, 'claude_reader_failed', 'retired child ID must not become a new root owner');
    assert.equal((await f.ask('child-reused'))?.behavior, 'deny');
    assert.deepEqual(await b, { status: 'error', finalText: null, partialText: 'B SALVAGE' });
    assert.equal(f.registry.list('chat').length, 0); await f.session.close(); assert.equal(f.closed, 1);
});

test('duplicate child declarations keep one owner and Stop during nested publication settles waiters', async t => {
    const f = await decisionFixture(t);
    const turn = f.session.send({ text: 'nested' }, event => {
        if (event.kind === 'tool' && event.parentItemId && event.name === 'Agent') void f.session.cancel();
    });
    const answer = f.ask('deep');
    f.push(toolFrame('nested', 'deep')); f.push(toolFrame('root', 'nested', 'Agent'));
    f.push(toolFrame('root', 'nested', 'Agent')); f.push(toolFrame(null, 'root', 'Agent'));
    assert.equal((await answer)?.behavior, 'deny'); assert.equal((await turn).status, 'stopped');
    assert.equal(f.registry.list('chat').length, 0); assert.equal(f.session.lastError, null);
});

test('same-context duplicate child declaration remains answerable exactly once', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'duplicate' }, () => {});
    f.push(toolFrame('parent', 'child')); f.push(toolFrame('parent', 'child'));
    f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    const answer = f.ask('child'); await checkpoint();
    const pending = f.registry.list('chat')[0]; assert.ok(pending);
    f.registry.respond(pending.requestId, pending, { optionId: 'allow' });
    assert.equal((await answer)?.behavior, 'allow'); assert.equal(f.registry.list('chat').length, 0);
    f.push(finalFrame()); assert.equal((await turn).status, 'done'); f.finalize();
    assert.equal(f.session.lastError, null); assert.equal(f.events.filter(event => event.kind === 'request').length, 1);
});

for (const prelinked of [true, false]) test(`ownership revoked by child publication needs no extra frame (prelinked=${prelinked})`, async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'revoke' }, event => {
        if (event.kind === 'tool' && event.parentItemId) f.revoke();
    });
    if (prelinked) f.push(toolFrame('parent', 'child'));
    f.push(toolFrame(null, 'parent', 'Agent'));
    if (!prelinked) f.push(toolFrame('parent', 'child'));
    await checkpoint();
    assert.equal(f.session.lastError, 'claude_owner_stale');
    assert.equal((await turn).status, 'error'); assert.equal(f.registry.list('chat').length, 0);
});

for (const stream of [true, false]) test(`child-owned last declaration resolves descendants without another frame (stream=${stream})`, async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'nested' }, () => {});
    f.push(toolFrame(null, 'root', 'Agent')); await checkpoint();
    if (stream) f.push({ type: 'stream_event', parent_tool_use_id: 'root', event: {
        type: 'message_start', message: { id: 'nested-stream' } } });
    const answer = f.ask('deep'); f.push(toolFrame('nested', 'deep'));
    const frame = toolFrame('root', 'nested', 'Agent');
    f.push(stream ? { type: 'stream_event', parent_tool_use_id: 'root', event: {
        type: 'content_block_start', index: 0, content_block: frame.message.content[0] } } : frame);
    await checkpoint();
    const pending = f.registry.list('chat')[0]; assert.ok(pending, 'child-owned linkage must reconcile before continue');
    f.registry.respond(pending.requestId, pending, { optionId: 'deny' });
    assert.equal((await answer)?.behavior, 'deny'); f.push(finalFrame()); await turn; f.finalize();
    assert.equal(f.events.filter(event => event.kind === 'request').length, 1);
});

for (const terminal of ['result-same', 'result-distinct', 'completed', 'failed', 'stopped']) {
    test(`terminal child before handoff still retires its declared ID (${terminal})`, async t => {
        const f = await decisionFixture(t), a = f.session.send({ text: 'a' }, () => {});
        f.push(toolFrame('parent', 'child-reused'));
        f.push(terminal.startsWith('result') ? { ...finalFrame(), parent_tool_use_id: 'parent',
            uuid: terminal === 'result-same' ? 'result-a' : 'child-result', result: 'CHILD ONLY' }
            : { type: 'system', subtype: 'task_notification', task_id: 'task', tool_use_id: 'parent',
                status: terminal, output_file: '', summary: 'Fixture terminal', uuid: 'notification', session_id: 'native' });
        f.push(toolFrame(null, 'parent', 'Agent')); f.push(finalFrame());
        assert.equal((await a).finalText, 'PARENT', 'child UUID/terminal cannot replace the parent final'); f.finalize();
        assert.equal(f.events.filter(event => event.kind === 'request').length, 0, 'no callback demand in A');
        f.next(); const b = f.session.send({ text: 'b' }, () => {});
        f.push({ type: 'assistant', message: { id: 'salvage', content: [{ type: 'text', text: 'B ONLY' }] } });
        f.push(toolFrame(null, 'child-reused')); await checkpoint();
        assert.equal(f.session.lastError, 'claude_reader_failed', 'inactive ownership is still retirement history');
        assert.equal((await f.ask('child-reused'))?.behavior, 'deny');
        assert.deepEqual(await b, { status: 'error', finalText: null, partialText: 'B ONLY' });
        assert.equal(f.registry.list('chat').length, 0); await f.session.close(); assert.equal(f.closed, 1);
    });
}

test('a terminal prelinked child denies a callback immediately rather than starting an owner wait', async t => {
    const f = await decisionFixture(t), turn = f.session.send({ text: 'a' }, () => {});
    f.push(toolFrame('parent', 'child'));
    f.push({ ...finalFrame(), parent_tool_use_id: 'parent', uuid: 'child-result' });
    f.push(toolFrame(null, 'parent', 'Agent')); await checkpoint();
    let resolved = false;
    const answer = f.ask('child').then(value => { resolved = true; return value; }); await checkpoint();
    assert.equal(resolved, true, 'inactive declaration must not enter the unknown-owner waiter');
    assert.equal((await answer)?.behavior, 'deny'); assert.equal(f.registry.list('chat').length, 0);
    f.push(finalFrame()); await turn; f.finalize();
});

for (const terminal of ['stop', 'sdk-error', 'pending-stop', 'pending-error']) {
    test(`tool-only parent message cannot erase interruption context (${terminal})`, async t => {
        const f = await decisionFixture(t), turn = f.session.send({ text: 'progress' }, () => {});
        f.push({ type: 'assistant', message: { id: 'narration', content: [{ type: 'text', text: 'PARENT_PROGRESS' }] } });
        f.push(toolFrame(null, 'tool')); await checkpoint();
        if (terminal.startsWith('pending')) {
            f.push({ ...finalFrame(), result: '' });
            assert.deepEqual(await turn, { status: 'done', finalText: '', partialText: '' });
            if (terminal === 'pending-error') {
                f.push({ type: 'system', subtype: 'task_started', is_backgrounded: true }); await checkpoint();
            } else await f.session.cancel();
            const outcome = f.session.claimTurnOutcome('turn-a');
            assert.equal(outcome?.status, terminal === 'pending-stop' ? 'stopped' : 'error');
            assert.equal(outcome?.finalText, null); assert.equal(outcome?.partialText, 'PARENT_PROGRESS');
        } else {
            if (terminal === 'stop') await f.session.cancel();
            else f.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
            assert.deepEqual(await turn, { status: terminal === 'stop' ? 'stopped' : 'error', finalText: null, partialText: 'PARENT_PROGRESS' });
        }
        f.finalize();
        assert.equal(f.events.some(event => event.kind === 'message' && event.phase === 'final' && event.text === 'PARENT_PROGRESS'), false);
    });
}
