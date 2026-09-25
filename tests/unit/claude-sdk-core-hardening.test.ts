import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.ts';
import { createClaudeClose } from '../../src/agent/runtime/claude-sdk-close.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';
// Every recorder in this file is injected; no shared SQLite migration is needed.
mock.module('../../src/trace/activity-journal.js', { namedExports: { appendActivityBody: () => null, markActivityFailure: () => {} } });
const { createClaudeSdkSession, ClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

class Output implements AsyncIterableIterator<SDKMessage> {
    private values: SDKMessage[] = [];
    private reader: ((value: IteratorResult<SDKMessage>) => void) | undefined;
    private ended = false;
    readers = 0;
    [Symbol.asyncIterator]() { this.readers++; return this; }
    next(): Promise<IteratorResult<SDKMessage>> {
        if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => { this.reader = resolve; });
    }
    push(value: Record<string, unknown>): void {
        const message = value as unknown as SDKMessage; // Deliberately exercise the untrusted frame boundary.
        if (this.reader) { const reader = this.reader; this.reader = undefined; reader({ done: false, value: message }); }
        else this.values.push(message);
    }
    end(): void { this.ended = true; this.reader?.({ done: true, value: undefined }); this.reader = undefined; }
}

async function fixture(t: TestContext, patch: Partial<ClaudeSessionOptions> = {}) {
    const output = new Output(), events: RuntimeEvent[] = [];
    let input: AsyncIterator<SDKUserMessage>, current = true, turns = 0, queries = 0, closes = 0, seq = 0;
    let closeAction: (() => void) | undefined, expectedCloseError: string | undefined;
    const options: ClaudeSessionOptions = {
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => ({ runId: 'run-' + (++turns), turnId: 'turn-' + turns,
            sessionId: 'chat', scope: 'scope', audience: 'internal', isCurrent: () => current }),
        record: (owner, body) => { const event: RuntimeEvent = { ...owner, version: 1, seq: ++seq, ...body }; events.push(event); return event; },
        queryFactory: ({ prompt }) => {
            queries++; input = prompt[Symbol.asyncIterator]();
            return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close() { closes++; output.end(); closeAction?.(); } };
        }, ...patch,
    };
    const session = await createClaudeSdkSession(options);
    t.after(async () => {
        output.end();
        if (expectedCloseError) await assert.rejects(session.close(), { message: expectedCloseError });
        else await session.close();
    });
    return { session, output, events, options, revoke: () => { current = false; },
        closeAction: (action: () => void) => { closeAction = action; },
        expectCloseError: (message: string) => { expectedCloseError = message; },
        take: async () => { const value = await input.next(); assert.equal(value.done, false); return value.value; },
        get queries() { return queries; }, get closes() { return closes; } };
}
const result = (uuid: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success',
    is_error: false, result: 'FINAL', session_id: 'native', uuid, num_turns: 1, ...extra });
const partial = (text = 'PARENT') => ({ type: 'assistant', parent_tool_use_id: null,
    message: { id: 'parent-message', content: [{ type: 'text', text }] } });
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

test('an unstarted core is not alive and cannot accept a prompt', async () => {
    const session = new ClaudeSdkSession({ prepared: { cwd: process.cwd(), binary: process.execPath, env: {},
        model: '', systemPrompt: '', permissions: 'safe', fastMode: false }, promptTimeoutMs: 1000,
        getTurnContext: () => { throw new Error('unstarted core must not read a context'); } });
    assert.equal(session.alive, false);
    await assert.rejects(session.send({ text: 'not started' }, () => {}), /session_closed/);
    await session.close();
});

test('duplicate completed result cannot finish a newer turn or retag native identity', async t => {
    const f = await fixture(t), a = f.session.send({ text: 'A' }, () => {}), inputA = await f.take();
    const old = result('result-A', { user_message_uuid: inputA.uuid });
    f.output.push(old); assert.equal((await a).finalText, 'FINAL');
    let settled = false;
    const b = f.session.send({ text: 'B' }, () => {}).then(value => { settled = true; return value; });
    const inputB = await f.take();
    f.output.push({ ...old, session_id: 'wrong-native', result: 'OLD' });
    await checkpoint(); assert.equal(settled, false); assert.equal(f.session.nativeSessionId, 'native');
    f.output.push(result('result-B', { user_message_uuids: [inputB.uuid], result: 'NEW' }));
    assert.equal((await b).finalText, 'NEW'); assert.equal(f.queries, 1); assert.equal(f.output.readers, 1);
    assert.equal(f.events.filter(event => event.kind === 'turn-end').length, 2);
});

for (const mode of ['foreign', 'array', 'malformed-array', 'oversized-array'] as const) {
    test(`explicit ${mode} result correlation fails before final and private-ID mutation`, async t => {
        const f = await fixture(t), pending = f.session.send({ text: 'A' }, () => {}), input = await f.take();
        f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
        const correlation = mode === 'foreign' ? { user_message_uuid: 'foreign' }
            : { user_message_uuids: mode === 'array' ? ['foreign']
                : mode === 'malformed-array' ? [input.uuid, 7] : Array(65).fill(input.uuid) };
        f.output.push(result('wrong', { ...correlation, session_id: 'foreign-native' }));
        assert.equal((await pending).status, 'error'); assert.equal(f.session.nativeSessionId, 'native');
        // Distinct from owner loss, which now reports `claude_owner_stale`.
        assert.equal(f.session.lastError, 'claude_correlation_stale');
        assert.equal(f.events.some(event => event.kind === 'turn-end' && event.finalText !== null), false);
    });
}

test('zero-turn uncorrelated resume handshake is not the offered user result', async t => {
    const f = await fixture(t); let settled = false;
    const pending = f.session.send({ text: 'A' }, () => {}).then(value => { settled = true; return value; });
    f.output.push(result('handshake', { num_turns: 0, result: 'NOT_AN_ANSWER', session_id: 'wrong' }));
    await checkpoint(); assert.equal(settled, false); assert.equal(f.session.nativeSessionId, '');
    const input = await f.take(); f.output.push(result('answer', { user_message_uuid: input.uuid }));
    assert.equal((await pending).finalText, 'FINAL');
});

test('a fabricated early result cannot accumulate a second unconsumed input', async t => {
    const f = await fixture(t), first = f.session.send({ text: 'x'.repeat(1024 * 1024) }, () => {});
    f.output.push(result('early')); await first; // No fake-CLI input read occurred.
    const second = f.session.send({ text: 'B' }, () => {});
    assert.equal((await second).status, 'error'); assert.equal(f.session.alive, false);
    assert.equal(f.session.lastError, 'claude_input_closed');
});

test('safe initialization must confirm default permission mode', async t => {
    const f = await fixture(t), pending = f.session.send({ text: 'A' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'wrong' });
    assert.equal((await pending).status, 'error'); assert.equal(f.session.nativeSessionId, '');
    assert.equal(f.session.lastError, 'claude_safe_mode_not_confirmed');
});

for (const parent of ['', 0, false, [], {}]) {
    test(`invalid child parent ${JSON.stringify(parent)} cannot be borrowed as root output`, async t => {
        const f = await fixture(t), pending = f.session.send({ text: 'A' }, () => {}); await f.take();
        f.output.push(partial()); f.output.push({ ...partial('CHILD'), parent_tool_use_id: parent });
        assert.deepEqual(await pending, { status: 'error', finalText: null, partialText: 'PARENT' });
    });
}

for (const mode of ['revoke', 'stop'] as const) {
    test(`metadata callback ${mode} cannot leave a successful final after ownership changes`, async t => {
        let f: Awaited<ReturnType<typeof fixture>>, stopped: Promise<void> | undefined;
        f = await fixture(t, { onMetadata: () => { if (mode === 'revoke') f.revoke(); else stopped = f.session.cancel(); } });
        const pending = f.session.send({ text: 'A' }, () => {}); await f.take();
        f.output.push(partial()); f.output.push(result('answer'));
        const outcome = await pending; await stopped;
        assert.equal(outcome.status, mode === 'revoke' ? 'error' : 'stopped');
        assert.equal(outcome.finalText, null); assert.equal(outcome.partialText, 'PARENT');
    });
}

for (const frame of [{ type: 'system', subtype: 'task_started', is_backgrounded: true },
    { type: 'system', subtype: 'task_updated', patch: { is_backgrounded: true } },
    { type: 'user', tool_use_result: { status: 'async_launched' } }]) {
    test(`unsupported background ${frame.type}/${frame.subtype ?? 'result'} fails closed`, async t => {
        const f = await fixture(t), pending = f.session.send({ text: 'A' }, () => {}); await f.take();
        f.output.push(frame); assert.equal((await pending).status, 'error');
        assert.equal(f.session.lastError, 'claude_background_tasks_unsupported');
    });
}

for (const patch of [{ result: {} }, { is_error: undefined }, { subtype: 'unknown' }, { result: 'x'.repeat(FULLTEXT_MAX_CHARS + 1) }]) {
    test('invalid terminal shape or oversized final cannot promote partial', async t => {
        const f = await fixture(t), pending = f.session.send({ text: 'A' }, () => {}); await f.take();
        f.output.push(partial()); f.output.push(result('bad', patch));
        assert.deepEqual(await pending, { status: 'error', finalText: null, partialText: 'PARENT' });
    });
}

for (const thrown of [undefined, null, false, 0, '']) {
    test(`query close throwing ${String(thrown)} is not successful disposal`, async t => {
        const f = await fixture(t); f.expectCloseError('claude_close_failed'); f.closeAction(() => { throw thrown; });
        let exited = 0; f.session.onExit(() => { exited++; });
        const pending = f.session.send({ text: 'A' }, () => {});
        const close = f.session.close(); assert.equal(f.session.close(), close);
        await assert.rejects(close, /claude_close_failed/);
        assert.equal((await pending).status, 'stopped'); assert.equal(exited, 0); assert.equal(f.closes, 1);
    });
}

test('request cleanup failure still settles the user promise and retires the query', async t => {
    const registry = new RuntimeRequests();
    t.mock.method(registry, 'cancelRun', () => { throw new Error('fixture cleanup failure'); });
    const f = await fixture(t, { registry }), pending = f.session.send({ text: 'A' }, () => {}); await f.take();
    f.output.push(partial()); f.output.push(result('answer'));
    assert.deepEqual(await pending, { status: 'error', finalText: null, partialText: 'PARENT' });
    assert.equal(f.session.alive, false); assert.equal(f.session.lastError, 'claude_request_cleanup_failed');
});

test('terminal capacity rejects reentrant new input at the final boundary', async t => {
    const f = await fixture(t); let reentry: Promise<unknown> | undefined;
    for (let i = 0; i < 512; i++) {
        const pending = f.session.send({ text: 'A' }, event => {
            if (i === 511 && event.kind === 'turn-end') reentry = assert.rejects(f.session.send({ text: 'B' }, () => {}), /terminal_capacity/);
        });
        const input = await f.take(); f.output.push(result(`result-${i}`, { user_message_uuid: input.uuid }));
        assert.equal((await pending).status, 'done');
    }
    await reentry; assert.ok(reentry); assert.equal(f.session.alive, false);
});

test('close helper attempts each phase after a throw and never certifies a timed-out reader', async () => {
    for (const failure of ['fence', 'start', 'settle']) {
        const calls: string[] = [];
        const action = (name: string) => () => { calls.push(name); if (failure === name) throw 0; };
        const close = createClaudeClose({ fence: action('fence'), startTermination: action('start'), settlePending: action('settle'),
            readerDone: async () => { calls.push('reader'); }, timeoutMs: 100, onClosed: () => { calls.push('closed'); } });
        const pending = close(); assert.equal(close(), pending); await assert.rejects(pending, /close_failed/);
        assert.deepEqual(calls, ['fence', 'start', 'settle', 'reader']);
    }
    let release!: () => void, closed = false;
    const reader = new Promise<void>(resolve => { release = resolve; });
    const close = createClaudeClose({ fence() {}, startTermination() {}, settlePending() {}, readerDone: () => reader,
        timeoutMs: 5, onClosed: () => { closed = true; } });
    await assert.rejects(close(), /close_timeout/); release(); await checkpoint(); assert.equal(closed, false);
});
