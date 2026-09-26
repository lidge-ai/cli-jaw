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

test('an exact Code mode must be the one init confirms', async t => {
    const f = await fixture({ prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '',
        permissions: 'safe', fastMode: false, sdkMode: 'plan', allowDangerouslySkipPermissions: true, sessionGrants: true } });
    t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    assert.equal((await turn).status, 'error');
    assert.equal(f.session.lastError, 'claude_permission_mode_not_confirmed');
});

test('a live permission switch calls the query and moves the approval gate', async t => {
    const modes: string[] = [];
    const output = stream();
    const f = await fixture({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '',
            permissions: 'auto', fastMode: false, sdkMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, sessionGrants: true },
        queryFactory: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
            void (async () => { for await (const _ of prompt) { /* drain */ } })();
            return { ...output, close() { output.close(); }, async setPermissionMode(mode: string) { modes.push(mode); } };
        },
    });
    t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'bypassPermissions' });
    output.push(result('ok'));
    assert.equal((await turn).finalText, 'ok');
    await f.session.setPermissionMode('plan');
    assert.deepEqual(modes, ['plan']);
});

test('a live permission switch without query support fails loudly', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    f.output.push(result('ok'));
    await turn;
    await assert.rejects(() => f.session.setPermissionMode('plan'), /claude_permission_mode_unavailable/);
});

function reconfigurable(fail: { model?: number; flags?: number } = {}) {
    const calls: unknown[] = [];
    const output = stream();
    let modelCalls = 0, flagCalls = 0;
    return { calls, output, factory: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        void (async () => { for await (const _ of prompt) { /* drain */ } })();
        return { ...output, close() { output.close(); },
            async setModel(model?: string) { modelCalls++; if (fail.model === modelCalls) throw new Error('model_failed'); calls.push(['model', model]); },
            async applyFlagSettings(settings: unknown) { flagCalls++; if (fail.flags === flagCalls) throw new Error('flags_failed'); calls.push(['flags', settings]); } };
    } };
}
const liveOn = { model: 'claude-opus-5-5', effort: 'high' as const };
const liveOff = { model: 'claude-sonnet-5', effort: null };

test('reconfigure moves the model and then the effort on the idle query, sending only what changed', async t => {
    const q = reconfigurable();
    const f = await fixture({ queryFactory: q.factory }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    q.output.push(result('ok')); await turn;
    await f.session.reconfigure(liveOff, liveOn);
    assert.deepEqual(q.calls, [['model', 'claude-sonnet-5'], ['flags', { effortLevel: null }]]);
    q.calls.length = 0;
    await f.session.reconfigure({ ...liveOff, effort: 'low' }, liveOff);
    await f.session.reconfigure({ model: 'claude-opus-5-5', effort: 'low' }, { ...liveOff, effort: 'low' });
    assert.deepEqual(q.calls, [['flags', { effortLevel: 'low' }], ['model', 'claude-opus-5-5']],
        'an effort-only change skips setModel and a model-only change skips the flags');
});

test('a live medium effort clears effortLevel, as the open omits medium', async t => {
    const { buildClaudeSdkOptions } = await import('../../src/agent/runtime/claude-sdk-options.ts');
    const q = reconfigurable();
    const f = await fixture({ queryFactory: q.factory }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    q.output.push(result('ok')); await turn;
    await f.session.reconfigure({ ...liveOn, effort: 'medium' }, liveOn);
    assert.deepEqual(q.calls, [['flags', { effortLevel: null }]]);
    const open = buildClaudeSdkOptions({ cwd: process.cwd(), binary: process.execPath, env: {}, model: 'claude-opus-5-5',
        systemPrompt: '', permissions: 'safe', fastMode: false, effort: 'medium' });
    assert.equal(Object.hasOwn(open, 'effort'), false, 'the open leaves medium to the provider too');
});

test('reconfigure is refused mid-turn and without query support', async t => {
    const q = reconfigurable();
    const f = await fixture({ queryFactory: q.factory }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    await assert.rejects(() => f.session.reconfigure(liveOff, liveOn), /claude_query_control_unavailable/);
    assert.deepEqual(q.calls, []);
    q.output.push(result('ok')); await turn;
    const bare = await fixture(); t.after(() => bare.session.close());
    const other = bare.session.send({ text: 'one' }, () => {});
    bare.output.push(result('ok')); await other;
    await assert.rejects(() => bare.session.reconfigure(liveOff, liveOn), /claude_query_control_unavailable/);
});

test('a failed effort step puts the previous model and effort back; a failed rollback retires the process', async t => {
    const q = reconfigurable({ flags: 1 });
    const f = await fixture({ queryFactory: q.factory }); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    q.output.push(result('ok')); await turn;
    await assert.rejects(() => f.session.reconfigure(liveOff, liveOn), /flags_failed/);
    assert.deepEqual(q.calls, [['model', 'claude-sonnet-5'], ['model', 'claude-opus-5-5'], ['flags', { effortLevel: 'high' }]]);
    assert.equal(f.session.alive, true);

    const broken = reconfigurable({ flags: 1, model: 2 });
    const g = await fixture({ queryFactory: broken.factory }); t.after(() => g.session.close());
    const next = g.session.send({ text: 'one' }, () => {});
    broken.output.push(result('ok')); await next;
    await assert.rejects(() => g.session.reconfigure(liveOff, liveOn), (error: unknown) =>
        error instanceof AggregateError && error.message === 'claude_reconfigure_inconsistent');
    assert.equal(g.session.alive, false);
});

// Code in-band follow-up. Probe (CLI 2.1.283): a follow-up offered while a tool runs folds
// into the running turn (one result echoing both uuids); one offered during a plain answer
// runs as a separate CLI turn after the first result (a result per uuid).
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const echo = (...ids: string[]) => ({ user_message_uuid: ids.at(-1), user_message_uuids: ids });
const started = (id: string, ...ids: string[]) => ({ type: 'stream_event', ...echo(...ids), event: { type: 'message_start', message: { id } } });
const said = (id: string, text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
async function steering(t: TestContext, extra: Record<string, unknown> = {}) {
    const f = await fixture({ inBandSteer: true, ...extra }); t.after(() => f.session.close());
    let settled = false;
    const turn = f.session.send({ text: 'primary' }, () => {}).then(value => { settled = true; return value; });
    await tick();
    const primary = (f.sent[0] as { uuid: string }).uuid;
    return { f, turn, primary, get settled() { return settled; } };
}

test('without the Code switch an echoed turn still refuses a follow-up and offers nothing', async t => {
    const f = await fixture(); t.after(() => f.session.close());
    const turn = f.session.send({ text: 'one' }, () => {});
    await tick();
    const primary = (f.sent[0] as { uuid: string }).uuid;
    f.output.push(started('m1', primary)); await tick();
    const refusal = await f.session.steer({ text: 'more' });
    assert.equal(refusal.accepted, false); assert.equal(refusal.reason, 'Use the scoped follow-up policy');
    f.output.push(result()); await turn; await tick();
    assert.equal(f.sent.length, 1);
});

test('a follow-up waits for the primary echo; a singular-only echo never opens it', async t => {
    const s = await steering(t);
    assert.equal((await s.f.session.steer({ text: 'early' })).reason, 'not-ready');
    s.f.output.push({ type: 'stream_event', user_message_uuid: s.primary, event: { type: 'message_start', message: { id: 'm1' } } });
    s.f.output.push({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: s.primary, message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } });
    await tick();
    assert.equal((await s.f.session.steer({ text: 'still early' })).reason, 'not-ready', 'an older producer never echoes the array');
    s.f.output.push(started('m2', s.primary)); await tick();
    const accepted = await s.f.session.steer({ text: 'now' });
    assert.equal(accepted.accepted, true); assert.equal(accepted.turnId, 'turn1');
    await tick(); assert.equal(s.f.sent.length, 2);
    s.f.output.push({ ...result('both'), ...echo(s.primary, accepted.nativeId!) });
    assert.equal((await s.turn).finalText, 'both');
});

test('one follow-up per turn joins the live input without priority; a second is queue-full', async t => {
    const s = await steering(t);
    s.f.output.push(started('m1', s.primary)); await tick();
    const first = await s.f.session.steer({ text: 'also this' });
    assert.equal(first.accepted, true);
    const second = await s.f.session.steer({ text: 'and this' });
    assert.deepEqual({ accepted: second.accepted, reason: second.reason }, { accepted: false, reason: 'queue-full' });
    await tick();
    assert.equal(s.f.sent.length, 2);
    const offered = s.f.sent[1] as Record<string, unknown>;
    assert.equal(offered['uuid'], first.nativeId); assert.notEqual(offered['uuid'], s.primary);
    assert.equal('priority' in offered, false, 'the CLI default `next`; `now` would abort the running turn');
    assert.deepEqual((offered['message'] as { content: unknown }).content, [{ type: 'text', text: 'also this' }]);
    s.f.output.push({ ...result('done'), ...echo(s.primary, first.nativeId!) });
    await s.turn;
    assert.equal((await s.f.session.steer({ text: 'late' })).reason, 'not-current');
});

test('a follow-up folded into the running turn settles on the one result that echoes both', async t => {
    const s = await steering(t);
    s.f.output.push(started('m1', s.primary)); await tick();
    const follow = await s.f.session.steer({ text: 'fold me' });
    s.f.output.push({ ...result('answered both'), num_turns: 2, ...echo(s.primary, follow.nativeId!) });
    assert.deepEqual(await s.turn, { status: 'done', finalText: 'answered both', partialText: '' });
    assert.deepEqual(s.f.session.unconsumedFollowUps(), []);
    assert.equal(s.f.events.filter(event => (event as { kind: string }).kind === 'turn-end').length, 1);
});

test('a follow-up run as its own CLI turn continues the logical turn to the second result', async t => {
    const transcript: unknown[][] = [];
    const s = await steering(t, { transcript: () => ({
        text: (...args: unknown[]) => transcript.push(['text', args[1], args[2], args[4]]),
        tool: (ref: string, patch: { status?: string }) => transcript.push(['tool', ref, patch.status]),
        close: (end: { status: string }) => transcript.push(['close', end.status]) }) });
    s.f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    s.f.output.push(started('m1', s.primary));
    s.f.output.push(said('m1', 'story'));
    await tick();
    const follow = await s.f.session.steer({ text: 'now reply GAMMA' });
    s.f.output.push({ ...result('story'), ...echo(s.primary) });
    await tick();
    assert.equal(s.settled, false, 'the first result only ends a segment');
    assert.equal(s.f.session.idle, false);
    assert.deepEqual(s.f.session.unconsumedFollowUps(), [follow.nativeId]);
    s.f.output.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' });
    s.f.output.push(started('m2', follow.nativeId!));
    s.f.output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'true' } }] } });
    s.f.output.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] } });
    s.f.output.push(said('m3', 'GAMMA'));
    s.f.output.push({ ...result('GAMMA'), usage: { input_tokens: 9, output_tokens: 1 }, ...echo(follow.nativeId!) });
    assert.deepEqual(await s.turn, { status: 'done', finalText: 'GAMMA', partialText: 'GAMMA' });
    assert.equal(s.f.session.lastError, null, 'no claude_correlation_stale on the follow-up result');
    assert.deepEqual(s.f.session.unconsumedFollowUps(), []);
    const kinds = s.f.events.map(event => (event as { kind: string }).kind);
    assert.equal(kinds.filter(kind => kind === 'turn-end').length, 1);
    assert.equal(kinds.filter(kind => kind === 'usage').length, 1, 'usage comes from the logical turn\'s last result');
    assert.equal(s.f.metadata.length, 1);
    assert.deepEqual((s.f.metadata[0] as { data: { tokens: unknown } }).data.tokens, { input: 9, output: 1 });
    assert.deepEqual(transcript.filter(row => row[0] === 'close'), [['close', 'done']]);
    const closeAt = transcript.findIndex(row => row[0] === 'close');
    assert.ok(transcript.findIndex(row => row[0] === 'text' && row[1] === 'claude:message:m1' && row[3] === 'final') < closeAt,
        'segment one\'s answer is recorded final without closing the transcript');
    assert.ok(transcript.some(row => row[0] === 'tool' && row[1] === 'claude:tool:tool-2' && row[2] === 'done'));
    assert.ok(transcript.findIndex(row => row[0] === 'text' && row[1] === 'claude:message:m3' && row[2] === 'GAMMA') < closeAt);
    const next = s.f.session.send({ text: 'next' }, () => {});
    await tick();
    const third = (s.f.sent[2] as { uuid: string }).uuid;
    s.f.output.push({ ...result('fine'), ...echo(third) });
    assert.equal((await next).finalText, 'fine');
});

test('a segment-two permission request records under the same turn', async t => {
    const registry = new (await import('../../src/agent/runtime/requests.ts')).RuntimeRequests();
    let canUseTool!: NonNullable<import('@anthropic-ai/claude-agent-sdk').Options['canUseTool']>;
    const output = stream(); const sent: Array<{ uuid: string }> = []; const events: Array<{ kind: string }> = [];
    let seq = 0;
    const session = await createClaudeSdkSession({ inBandSteer: true, registry, promptTimeoutMs: 3000, closeTimeoutMs: 100,
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: '', permissions: 'safe', fastMode: false },
        getTurnContext: () => ({ runId: 'run1', sessionId: 'chat', scope: 'scope', turnId: 'turn1', audience: 'internal', isCurrent: () => true }),
        record: (owner, body) => { const event = { version: 1 as const, ...owner, ...body, seq: seq += 1 }; events.push(event); return event; },
        queryFactory: ({ prompt, options }) => {
            canUseTool = options.canUseTool!;
            void (async () => { for await (const message of prompt) sent.push(message as { uuid: string }); })();
            return { ...output, close() { output.close(); } };
        } });
    t.after(() => session.close());
    const turn = session.send({ text: 'primary' }, () => {});
    await tick();
    output.push(started('m1', sent[0]!.uuid)); await tick();
    const follow = await session.steer({ text: 'then run a command' });
    output.push({ ...result('first'), ...echo(sent[0]!.uuid) });
    output.push(started('m2', follow.nativeId!));
    output.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } }] } });
    await tick();
    const answer = canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-2', requestId: 'sdk-1' });
    await tick(); await tick();
    const pending = registry.list('chat')[0];
    assert.ok(pending, 'the continuation still owns live permission requests');
    registry.respond(pending.requestId, pending, { optionId: 'allow' });
    assert.equal((await answer)?.behavior, 'allow');
    output.push({ ...result('second'), ...echo(follow.nativeId!) });
    assert.equal((await turn).finalText, 'second');
    assert.equal(events.filter(event => event.kind === 'request').length, 1);
    assert.equal(events.filter(event => event.kind === 'turn-end').length, 1);
});

test('a result with no echo while a follow-up waits fails closed instead of guessing', async t => {
    const s = await steering(t);
    s.f.output.push(started('m1', s.primary)); await tick();
    assert.equal((await s.f.session.steer({ text: 'more' })).accepted, true);
    s.f.output.push(result('which one?'));
    assert.equal((await s.turn).status, 'error');
    assert.equal(s.f.session.lastError, 'claude_followup_unconfirmed');
    assert.equal(s.f.session.alive, false);
});

test('Stop before a follow-up is consumed settles stopped and reports it unconsumed until the next send', async t => {
    const s = await steering(t);
    s.f.output.push(started('m1', s.primary)); await tick();
    const follow = await s.f.session.steer({ text: 'more' });
    await s.f.session.cancel();
    assert.equal((await s.turn).status, 'stopped');
    assert.deepEqual(s.f.session.unconsumedFollowUps(), [follow.nativeId]);
    const fresh = await steering(t);
    fresh.f.output.push(started('m1', fresh.primary)); await tick();
    const folded = await fresh.f.session.steer({ text: 'fold' });
    fresh.f.output.push({ ...result('ok'), ...echo(fresh.primary, folded.nativeId!) }); await fresh.turn;
    const next = fresh.f.session.send({ text: 'next' }, () => {});
    assert.deepEqual(fresh.f.session.unconsumedFollowUps(), []);
    fresh.f.output.push(result('fine')); await next;
});

test('an accepted follow-up re-arms the turn window once; a refused offer does not', async t => {
    const s = await steering(t, { promptTimeoutMs: 300 });
    s.f.output.push(started('m1', s.primary)); await tick();
    await new Promise(resolve => setTimeout(resolve, 200));
    const follow = await s.f.session.steer({ text: 'more' });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(s.settled, false, 'the original 300ms deadline passed without failing the turn');
    s.f.output.push({ ...result('ok'), ...echo(s.primary, follow.nativeId!) });
    assert.equal((await s.turn).status, 'done');

    // A closed input refuses the offer: the uuid leaves the turn and the window is not extended.
    const output = stream(); let primary = '';
    const g = await fixture({ inBandSteer: true, promptTimeoutMs: 300, queryFactory: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const reader = prompt[Symbol.asyncIterator]();
        void reader.next().then(next => { primary = (next.value as { uuid: string }).uuid; void reader.return?.(); });
        return { ...output, close() { output.close(); } };
    } });
    t.after(() => g.session.close());
    const began = Date.now();
    const turn = g.session.send({ text: 'primary' }, () => {});
    await tick();
    output.push(started('m1', primary)); await tick();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await g.session.steer({ text: 'lost' })).reason, 'not-current');
    assert.equal((await g.session.steer({ text: 'lost again' })).reason, 'not-current', 'the refused uuid did not stay in the turn');
    assert.equal((await turn).status, 'error');
    assert.ok(Date.now() - began < 450, 'the refused offer did not re-arm the timer');
    assert.equal(g.session.lastError, 'claude_prompt_timeout');
});
