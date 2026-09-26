import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeTurnContext } from '../../src/agent/runtime/claude-sdk-session.ts';
import { createClaudeProcessOwner } from '../../src/agent/runtime/claude-sdk-process.ts';
// Session recording is injected below; do not initialize a real shared SQLite.
mock.module('../../src/trace/activity-journal.js', { namedExports: { appendActivityBody: () => null, markActivityFailure: () => {} } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

function stream() {
    const values: unknown[] = [];
    let waiting: ((x: IteratorResult<unknown>) => void) | undefined;
    let ended = false;
    return {
        push(value: unknown) { if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value }); } else values.push(value); },
        close() { ended = true; waiting?.({ done: true, value: undefined }); waiting = undefined; },
        [Symbol.asyncIterator]() { return this; },
        next(): Promise<IteratorResult<unknown>> {
            if (values.length) return Promise.resolve({ done: false, value: values.shift() });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise(resolve => { waiting = resolve; });
        },
    };
}
async function fixture(extra: Record<string, unknown> = {}) {
    const output = stream();
    let context = { runId: 'run1', sessionId: 'jaw', scope: 'scope', turnId: 'turn1', audience: 'internal', isCurrent: () => true };
    const sent: unknown[] = [], events: unknown[] = [], metadata: unknown[] = [];
    let queryCount = 0, contextReads = 0, closed = 0, seq = 0;
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: 'instructions', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => { contextReads++; return context; },
        onMetadata: (owner, data) => metadata.push({ owner, data }),
        record: (owner, body) => { const event = { version: 1, ...owner, ...body, seq: seq += 3 }; events.push(event); return event; },
        queryFactory: ({ prompt }) => { queryCount++; void (async () => { for await (const message of prompt) sent.push(message); })(); return { ...output, close() { closed++; output.close(); } }; },
        ...extra,
    });
    return { session, output, sent, events, metadata,
        get queryCount() { return queryCount; }, get contextReads() { return contextReads; }, get closed() { return closed; },
        context(value: typeof context) { context = value; } };
}
const result = (text: unknown = 'answer') => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'native', usage: { input_tokens: 3, output_tokens: 4 } });

test('session-created hook exposes the owner before the query factory can fail', async () => {
    const order: string[] = [];
    await assert.rejects(fixture({
        onSessionCreated(session: Awaited<ReturnType<typeof createClaudeSdkSession>>) {
            order.push('registered'); assert.equal(session.alive, false); assert.equal(session.activeProcessCount, 0);
        },
        queryFactory() { order.push('factory'); throw new Error('fixture_start_failed'); },
    }), /fixture_start_failed/);
    assert.deepEqual(order, ['registered', 'factory']);
});

test('native session ID callback precedes result metadata and excludes child and invalid init frames', async t => {
    const observed: Array<{ context: Readonly<ClaudeTurnContext> | null; id: string }> = [];
    let initialized!: () => void;
    const ready = new Promise<void>(resolve => { initialized = resolve; });
    const f = await fixture({ onNativeSessionId(context: Readonly<ClaudeTurnContext> | null, id: string) {
        assert.equal(f.session.nativeSessionId, id);
        observed.push({ context, id }); initialized();
    } });
    t.after(() => f.session.close());
    let settled = false;
    const pending = f.session.send({ text: 'one' }, () => {}).then(value => { settled = true; return value; });
    f.output.push({ type: 'system', subtype: 'init', session_id: 'child', parent_tool_use_id: 'unknown-child', permissionMode: 'default' });
    f.output.push({ type: 'system', subtype: 'init', session_id: '', permissionMode: 'default' });
    f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    await ready;
    assert.equal(settled, false); assert.deepEqual(f.metadata, []);
    assert.deepEqual(observed.map(entry => entry.id), ['native']);
    assert.equal(observed[0]?.context?.turnId, 'turn1');
    f.output.push(result('answer'));
    assert.equal((await pending).finalText, 'answer'); assert.equal(f.metadata.length, 1);
    assert.equal(observed.length, 1, 'terminal metadata is a separate existing callback');
});

test('idle valid root init reports null context while idle child init remains private', async t => {
    const observed: Array<{ context: Readonly<ClaudeTurnContext> | null; id: string }> = [];
    let initialized!: () => void;
    const ready = new Promise<void>(resolve => { initialized = resolve; });
    const f = await fixture({ onNativeSessionId(context: Readonly<ClaudeTurnContext> | null, id: string) {
        observed.push({ context, id }); initialized();
    } });
    t.after(() => f.session.close());
    f.output.push({ type: 'system', subtype: 'init', session_id: 'child', parent_tool_use_id: 'stale-child', permissionMode: 'default' });
    f.output.push({ type: 'system', subtype: 'init', session_id: 'idle-native', permissionMode: 'default' });
    await ready;
    assert.deepEqual(observed, [{ context: null, id: 'idle-native' }]);
    assert.equal(f.session.nativeSessionId, 'idle-native'); assert.equal(f.contextReads, 0);
});

for (const invalid of ['stale-owner', 'wrong-correlation', 'wrong-policy'] as const) {
    test(`native session ID callback cannot escape ${invalid} init admission`, async t => {
        let current = true;
        const ids: string[] = [];
        const f = await fixture({
            getTurnContext: () => ({ runId: 'r', sessionId: 'j', scope: 's', turnId: 't', audience: 'internal', isCurrent: () => current }),
            onNativeSessionId(_context: Readonly<ClaudeTurnContext> | null, id: string) { ids.push(id); },
        });
        t.after(() => f.session.close());
        const pending = f.session.send({ text: 'one' }, () => {});
        if (invalid === 'stale-owner') current = false;
        f.output.push({ type: 'system', subtype: 'init', session_id: 'foreign-native',
            permissionMode: invalid === 'wrong-policy' ? 'bypassPermissions' : 'default',
            ...(invalid === 'wrong-correlation' ? { user_message_uuid: 'foreign-message' } : {}) });
        assert.equal((await pending).status, 'error');
        assert.deepEqual(ids, []); assert.equal(f.session.nativeSessionId, '');
    });
}

const heldChildOptions = () => ({ command: process.execPath,
    args: ['-e', "process.stdout.write('SDK_CHILD_READY\\n'); process.stdin.on('data', data => { if (data.toString().trim() === 'PING') process.stdout.write('SDK_CHILD_PONG\\n'); }); setInterval(()=>{},1000);"],
    env: process.env, signal: new AbortController().signal });

function trackHeldChild(t: TestContext, child: ChildProcessWithoutNullStreams) {
    let buffer = '', bytes = 0, failure: Error | undefined;
    const lines: string[] = [];
    let pending: { expected: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
    const pump = () => {
        if (!pending || (!failure && lines.length === 0)) return;
        const waiting = pending; pending = undefined; clearTimeout(waiting.timer);
        const line = lines.shift();
        if (failure) waiting.reject(failure);
        else if (line !== waiting.expected) waiting.reject(new Error(`Unexpected held-child marker: ${line}`));
        else waiting.resolve();
    };
    child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) { failure = new Error('Held-child output exceeded bound'); pump(); return; }
        buffer += chunk.toString();
        while (buffer.includes('\n')) {
            const at = buffer.indexOf('\n'); lines.push(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        }
        pump();
    });
    child.once('error', error => { failure = error; pump(); });
    const closed = new Promise<void>(resolve => child.once('close', () => {
        failure ??= new Error('Held child closed before requested marker'); pump(); resolve();
    }));
    t.after(async () => {
        if (pending) { clearTimeout(pending.timer); pending = undefined; }
        // This fixed Node fixture creates no descendants. Fallback cleanup must
        // not let a failed owner assertion strand it; it never makes the test pass.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([closed, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Held child cleanup did not close')), 10_000);
            })]);
        } finally { clearTimeout(timer); }
    });
    return { closed, expectLine(expected: string) {
        assert.equal(pending, undefined, 'one held-child observation at a time');
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { pending = undefined; reject(new Error('Held-child marker deadline')); }, 10_000);
            pending = { expected, resolve, reject, timer }; pump();
        });
    } };
}

test('one reader and query serve sequential turns with captured jaw identity', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const first = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    f.context({ runId: 'run2', sessionId: 'jaw2', scope: 'scope2', turnId: 'turn2', audience: 'internal', isCurrent: () => true });
    f.output.push(result('one answer'));
    assert.equal((await first).finalText, 'one answer');
    assert.equal(f.session.nativeSessionId, 'native');
    assert.equal(f.contextReads, 1);
    assert.ok(f.events.every(e => e.runId === 'run1' && e.sessionId === 'jaw'));
    const second = f.session.send({ text: 'two' }, () => {});
    f.output.push(result('two answer'));
    assert.equal((await second).finalText, 'two answer');
    assert.equal(f.queryCount, 1); assert.equal(f.contextReads, 2); assert.equal(f.sent.length, 2);
    assert.equal(f.closed, 0); assert.equal(f.session.idle, true);
    assert.deepEqual(f.metadata[1].data.tokens, { input: 3, output: 4 });
});
test('concurrent input rejects without extra offer; unsupported steer never offers', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    await assert.rejects(f.session.send({ text: 'two' }, () => {}), /busy/);
    assert.equal((await f.session.steer({ text: 'three' })).accepted, false);
    f.output.push(result()); await turn; assert.equal(f.sent.length, 1);
});
test('authoritative empty and absent final never promote parent partial', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    for (const final of ['', undefined]) {
        const turn = f.session.send({ text: 'one' }, () => {});
        f.output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'partial' }] } });
        f.output.push({ ...result(), result: final });
        assert.deepEqual(await turn, { status: 'done', finalText: final ?? null, partialText: 'partial' });
    }
});
test('EOF produces error with parent salvage, excluding child output', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'p', content: [{ type: 'text', text: 'parent' }] } });
    f.output.push({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'c', content: [{ type: 'text', text: 'child' }] } });
    f.output.close();
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: 'parent' });
    assert.equal(f.session.alive, false);
});
test('journal failure cannot suppress direct final outcome', async t => {
    const f = await fixture({ record: () => { throw new Error('disk full'); } }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => { throw new Error('observer'); });
    f.output.push(result('direct')); assert.equal((await turn).finalText, 'direct');
});
test('observer throws after successful recording cannot suppress outcome or close', async () => {
    const f = await fixture();
    let observed = 0;
    try {
        const turn = f.session.send({ text: 'one' }, () => { observed++; throw new Error('observer'); });
        f.output.push(result('direct'));
        assert.equal((await turn).finalText, 'direct');
        assert.deepEqual(f.events.map(event => event.kind), ['turn-start', 'usage', 'message', 'turn-end']);
        assert.equal(observed, f.events.length);
        assert.equal(f.events.find(event => event.kind === 'message')?.phase, 'final');
    } finally { await f.session.close(); }
    assert.equal(f.closed, 1);
    assert.equal(f.session.alive, false);
});
test('timeout retires query and settlement does not wait forever', async t => {
    const f = await fixture({ promptTimeoutMs: 10 }); t.after(() => f.session.close());
    assert.equal((await f.session.send({ text: 'one' }, () => {})).status, 'error');
    assert.equal(f.session.alive, false);
});
test('Stop fences synchronous stale result and resolves stopped once', async () => {
    const f = await fixture();
    const turn = f.session.send({ text: 'one' }, () => {});
    const close = f.session.cancel(); f.output.push(result('stale'));
    assert.equal((await turn).status, 'stopped'); await close;
    await f.session.close(); assert.equal(f.closed, 1);
    await assert.rejects(f.session.send({ text: 'later' }, () => {}), /closed/);
});
test('custom child drains stderr beyond pipe capacity and observes actual exit', async t => {
    const owner = createClaudeProcessOwner();
    t.after(async () => { owner.terminate(); await owner.wait(); });
    const child = owner.spawn({ command: process.execPath,
        args: ['-e', "process.stderr.write('x'.repeat(1024*1024),()=>process.exit(0))"],
        env: process.env, signal: new AbortController().signal });
    child.stdout.resume(); await owner.wait();
    assert.equal(child.exitCode, 0); assert.equal(owner.activeCount, 0); assert.equal(owner.stderrBytes, 1024 * 1024);
});
test('custom child termination waits for exit, not killed flag', { timeout: 15_000 }, async t => {
    const owner = createClaudeProcessOwner();
    const child = owner.spawn(heldChildOptions());
    const observed = trackHeldChild(t, child);
    await observed.expectLine('SDK_CHILD_READY');
    owner.terminate();
    assert.equal(owner.activeCount, 1, 'termination request is not observed process close');
    await owner.wait();
    assert.equal(owner.activeCount, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await observed.closed;
});
test('query factory error after child spawn retires only its created child', { timeout: 15_000 }, async t => {
    const foreignOwner = createClaudeProcessOwner();
    const foreign = foreignOwner.spawn(heldChildOptions());
    const foreignObserved = trackHeldChild(t, foreign);
    await foreignObserved.expectLine('SDK_CHILD_READY');
    let child: ChildProcessWithoutNullStreams | undefined;
    let observed: ReturnType<typeof trackHeldChild> | undefined;
    await assert.rejects(fixture({
        // Real process cleanup uses production's 5000ms default, not the 100ms
        // budget for in-memory fake readers. Windows has a real 2000ms grace.
        closeTimeoutMs: undefined,
        queryFactory: ({ options }) => {
        child = options.spawnClaudeCodeProcess(heldChildOptions());
        observed = trackHeldChild(t, child);
        throw new Error('factory failure');
    } }), /factory failure/);
    assert.ok(child); assert.ok(observed);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await observed.closed;
    foreign.stdin.write('PING\n');
    await foreignObserved.expectLine('SDK_CHILD_PONG');
    assert.equal(foreign.exitCode, null); assert.equal(foreign.signalCode, null);
    assert.equal(foreignOwner.activeCount, 1, 'failed factory owns no sibling process');
});
test('turn-start observer can revoke ownership before input offer', async () => {
    let current = true;
    const f = await fixture({ getTurnContext: () => ({ runId: 'r', sessionId: 'j', scope: 's', turnId: 't', audience: 'internal', isCurrent: () => current }) });
    const result = await f.session.send({ text: 'never send' }, () => { current = false; });
    assert.equal(result.status, 'stopped'); assert.equal(f.sent.length, 0);
    await f.session.close();
});
test('wrong first-frame correlation fences all unmarked foreign frames before metadata', async () => {
    const f = await fixture();
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'stream_event', user_message_uuid: 'foreign', event: { type: 'message_start', message: { id: 'foreign-message' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'foreign text' } } });
    f.output.push({ ...result('foreign'), session_id: 'foreign-session' });
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: '' });
    assert.equal(f.metadata.length, 0); assert.equal(f.session.nativeSessionId, '');
    assert.ok(!JSON.stringify(f.events).includes('foreign text'));
    await f.session.close();
});
test('duplicate previous result UUID cannot finish the next admitted send', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const one = f.session.send({ text: 'one' }, () => {});
    f.output.push({ ...result('first'), uuid: 'result1' }); await one;
    const two = f.session.send({ text: 'two' }, () => {});
    f.output.push({ ...result('first'), uuid: 'result1' });
    f.output.push({ ...result('second'), uuid: 'result2' });
    assert.equal((await two).finalText, 'second');
});
test('streaming delta is available for salvage before any completed assistant snapshot', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    f.output.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'salvage' } } });
    f.output.close();
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: 'salvage' });
});
test('idle result UUID is fenced before next send and cannot replay into its outcome', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    f.output.push({ ...result('idle'), uuid: 'idle-result' });
    await new Promise(resolve => setImmediate(resolve));
    const turn = f.session.send({ text: 'current' }, () => {});
    f.output.push({ ...result('idle'), uuid: 'idle-result', session_id: 'stale-session' });
    f.output.push({ ...result('actual'), uuid: 'actual-result' });
    assert.equal((await turn).finalText, 'actual'); assert.equal(f.metadata.length, 1);
});
test('usage observer revocation cannot return a successful stale final', async () => {
    let current = true;
    const f = await fixture({ getTurnContext: () => ({ runId: 'r', sessionId: 'j', scope: 's', turnId: 't', audience: 'internal', isCurrent: () => current }) });
    const turn = f.session.send({ text: 'one' }, event => { if (event.kind === 'usage') current = false; });
    f.output.push(result('stale answer'));
    assert.deepEqual(await turn, { status: 'error', finalText: null, partialText: '' });
    await f.session.close(); assert.equal(f.session.alive, false);
});

test('a failed turn exposes its stop reason, a later success clears it, and occupancy is reported', async t => {
    const usage: unknown[] = [];
    const f = await fixture({ onContextUsage: (value: unknown) => usage.push(value) }); t.after(() => f.session.close());
    const first = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    f.output.push({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', session_id: 'native' });
    assert.equal((await first).status, 'error');
    assert.equal(f.session.lastTurnFailureText, 'Claude turn failed: reached the turn limit');
    const second = f.session.send({ text: 'two' }, () => {});
    f.output.push({ ...result('fine'), usage: { input_tokens: 900, output_tokens: 5, cache_read_input_tokens: 100 },
        modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } } });
    assert.equal((await second).finalText, 'fine');
    assert.equal(f.session.lastTurnFailureText, null);
    assert.equal(usage.length, 1);
    assert.deepEqual({ ...(usage[0] as Record<string, unknown>), updatedAt: 0 }, { totalTokens: 1000, modelContextWindow: 200000, updatedAt: 0 });
});

test('an unknown result subtype fails the turn closed without failing the reader', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'result', subtype: 'future_result', is_error: false, result: 'not promoted', session_id: 'native' });
    const outcome = await turn;
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.finalText, null);
    assert.equal(f.session.lastError, null);
    const next = f.session.send({ text: 'two' }, () => {});
    f.output.push(result('fine'));
    assert.equal((await next).finalText, 'fine');
});
