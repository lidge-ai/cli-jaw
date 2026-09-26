import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeCodeProvider } from '../../src/code-mode/providers/claude.ts';
import { CodeStoreError } from '../../src/code-mode/store.ts';

function harness(extra: Record<string, unknown> = {}) {
    let captured: Record<string, any> | undefined;
    const runtime = {
        nativeSessionId: 'native-1', alive: true, idle: true, activeProcessCount: 0,
        lastError: null as string | null, lastTurnFailureText: 'Claude turn failed: reached the turn limit' as string | null,
        onExit: () => () => {}, close: async () => {}, send: async () => ({ status: 'done', finalText: 'ok', partialText: '' }),
        reconfigured: [] as unknown[],
        async reconfigure(next: unknown, previous: unknown) { this.reconfigured.push({ next, previous }); },
    };
    const create = (async (options: Record<string, any>) => { captured = options; return runtime; }) as never;
    const provider = createClaudeCodeProvider({
        describe: () => ({ capabilities: { permissionModes: ['ask', 'auto'] } }) as never,
        binary: () => '/nonexistent/claude',
        environment: () => ({}),
    }, create);
    const usage: unknown[] = [];
    const open = () => provider.open({
        sessionId: 'code-1', cwd: '/tmp', model: 'claude-opus-4-8', effort: null, permissionMode: 'ask', nativeCursor: null,
        signal: new AbortController().signal,
        getTurnContext: () => ({ audience: 'internal', sessionId: 'code-1', isCurrent: () => true }),
        onResource: () => {}, onNativeCursor: () => {}, onExit: () => {},
        onContextUsage: (value: unknown) => usage.push(value), thinking: null, ...extra,
    } as never);
    return { open, usage, runtime, captured: () => captured! };
}

test('Claude Code provider forwards context usage and exposes the last failure reason', async () => {
    const h = harness();
    const handle = await h.open();
    h.captured().onContextUsage({ totalTokens: 1000, modelContextWindow: 200000, updatedAt: 5 });
    assert.deepEqual(h.usage, [{ totalTokens: 1000, inputTokens: null, cachedInputTokens: null, outputTokens: null,
        reasoningOutputTokens: null, processedTokens: null, modelContextWindow: 200000, updatedAt: 5 }]);
    assert.equal(handle.lastTurnFailureText, 'Claude turn failed: reached the turn limit');
    h.runtime.lastTurnFailureText = null;
    assert.equal(handle.lastTurnFailureText, null);
    await handle.close();
});

test('Claude Code provider passes the thinking switch and reconfigures model and effort through the runtime', async () => {
    const off = harness({ thinking: false });
    const handle = await off.open();
    assert.equal(off.captured()['prepared'].thinking, false);
    await handle.reconfigure!({ model: 'claude-sonnet-5', effort: null }, { model: 'claude-opus-4-8', effort: 'high' });
    assert.deepEqual(off.runtime.reconfigured, [{ next: { model: 'claude-sonnet-5', effort: null },
        previous: { model: 'claude-opus-4-8', effort: 'high' } }]);
    await assert.rejects(async () => handle.reconfigure!({ model: 'x', effort: 'ultra' },
        { model: 'claude-opus-4-8', effort: null }), /code_provider_effort_unsupported/);
    await handle.close();
    const unset = harness();
    await (await unset.open()).close();
    assert.equal('thinking' in unset.captured()['prepared'], false, 'null leaves the CLI default');
});

test('Claude Code provider refuses a reconfigure while the runtime is not idle, before any SDK call', async () => {
    const h = harness();
    const handle = await h.open();
    h.runtime.idle = false;
    await assert.rejects(handle.reconfigure!({ model: 'claude-sonnet-5', effort: null }, { model: 'claude-opus-4-8', effort: null }),
        (error: unknown) => error instanceof CodeStoreError && error.code === 'session_busy' && error.statusCode === 409);
    assert.deepEqual(h.runtime.reconfigured, []);
    h.runtime.idle = true;
    await handle.close();
    await assert.rejects(handle.reconfigure!({ model: 'claude-sonnet-5', effort: null }, { model: 'claude-opus-4-8', effort: null }),
        (error: unknown) => error instanceof CodeStoreError && error.code === 'session_busy');
    assert.deepEqual(h.runtime.reconfigured, [], 'a closing runtime is not idle either');
});

test('Claude Code provider opens the in-band follow-up path and returns the runtime refusal unchanged', async () => {
    const h = harness();
    const steers: unknown[] = [];
    let answer: Record<string, unknown> = { accepted: true, mode: 'queued', turnId: 'turn-1', nativeId: 'native-follow' };
    Object.assign(h.runtime, { async steer(prompt: unknown) { steers.push(prompt); return answer; }, unconsumedFollowUps: () => ['native-follow'] });
    const handle = await h.open();
    assert.equal(h.captured()['inBandSteer'], true);
    assert.deepEqual(await handle.steer!('more'), { accepted: true, turnId: 'turn-1', nativeId: 'native-follow' });
    assert.deepEqual(steers, [{ text: 'more' }]);
    assert.deepEqual(handle.unconsumedFollowUps!(), ['native-follow']);
    for (const reason of ['queue-full', 'not-ready', 'not-current', 'Use the scoped follow-up policy']) {
        answer = { accepted: false, mode: 'queued', turnId: 'turn-1', reason };
        assert.deepEqual(await handle.steer!('more'), { accepted: false, turnId: 'turn-1',
            reason: reason === 'queue-full' || reason === 'not-ready' ? reason : 'not-current' });
    }
    await assert.rejects(handle.steer!('x'.repeat(1024 * 1024 + 1)), /claude_prompt_limit/);
    assert.equal(steers.length, 5, 'an oversized follow-up throws before dispatch');
    await handle.close();
    assert.deepEqual(await handle.steer!('late'), { accepted: false, turnId: '', reason: 'not-current' });
    assert.equal(steers.length, 5);
});

test('only the Code Claude provider switches the runtime to in-band follow-ups', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
    const users = files('src').filter(file => readFileSync(file, 'utf8').includes('inBandSteer')).sort();
    assert.deepEqual(users, [join('src', 'agent', 'runtime', 'claude-sdk-session.ts'), join('src', 'code-mode', 'providers', 'claude.ts')]);
});

test('Claude Code provider sends a turn under its private prompt UUID', async () => {
    const h = harness();
    const sent: unknown[] = [];
    h.runtime.send = (async (...args: unknown[]) => { sent.push(args); return { status: 'done', finalText: 'ok', partialText: '' }; }) as never;
    const handle = await h.open();
    await handle.send('first', { promptUuid: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    await handle.send('second');
    assert.deepEqual(sent.map(args => (args as unknown[])[2]), [{ uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' }, {}]);
    await handle.close();
});

type Message = { type: 'user' | 'assistant' | 'system'; uuid: string; session_id: string; message: unknown; parent_tool_use_id: string | null; parent_agent_id: string | null };
const SOURCE = '11111111-1111-4111-8111-111111111111';
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
function msg(type: Message['type'], content: unknown, id = uuid()): Message {
    return { type, uuid: id, session_id: SOURCE, message: type === 'system' ? undefined : { role: type, content }, parent_tool_use_id: null, parent_agent_id: null };
}
/** Two-turn-plus history: T1 runs a tool, T2 and T3 answer in text. */
function transcript() {
    const t1 = msg('user', [{ type: 'text', text: 'first' }]);
    const toolUse = msg('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]);
    const toolResult = msg('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }]);
    const a1 = msg('assistant', [{ type: 'text', text: 'done one' }]);
    const t2 = msg('user', [{ type: 'text', text: 'second SECRET' }]);
    const a2 = msg('assistant', [{ type: 'text', text: 'two' }]);
    const t3 = msg('user', [{ type: 'text', text: 'third' }]);
    const a3 = msg('assistant', [{ type: 'text', text: 'three' }]);
    return { t1, toolUse, toolResult, a1, t2, a2, t3, a3, all: [t1, toolUse, toolResult, a1, t2, a2, t3, a3] };
}
function fakeHistory(sessions: Map<string, Message[]>, options: { fileSize?: number | undefined; forkId?: string; mutate?: (fork: Message[]) => Message[] } = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    const helpers = {
        async getSessionInfo(id: string, opts: unknown) { calls.push(['info', id, opts]); return sessions.has(id) ? { sessionId: id, summary: '', lastModified: 0, ...('fileSize' in options ? { fileSize: options.fileSize } : { fileSize: 2048 }) } : undefined; },
        async getSessionMessages(id: string, opts: unknown) { calls.push(['messages', id, opts]); return structuredClone(sessions.get(id) ?? []); },
        async forkSession(id: string, opts: { dir?: string; upToMessageId?: string; title?: string }) {
            calls.push(['fork', id, opts]);
            const source = sessions.get(id)!;
            const cut = source.findIndex(entry => entry.uuid === opts.upToMessageId);
            const forkId = options.forkId ?? uuid();
            let copy = source.slice(0, cut + 1).map(entry => ({ ...structuredClone(entry), uuid: uuid(), session_id: forkId }));
            if (options.mutate) copy = options.mutate(copy);
            sessions.set(forkId, copy);
            return { sessionId: forkId };
        },
        async deleteSession(id: string, opts: unknown) { calls.push(['delete', id, opts]); sessions.delete(id); },
    };
    return { helpers: helpers as never, calls };
}
function rollbackProvider(history: unknown, environment: NodeJS.ProcessEnv = { ...process.env }) {
    let loads = 0;
    const provider = createClaudeCodeProvider({ describe: () => ({ capabilities: { permissionModes: ['ask'] } }) as never,
        binary: () => '/nonexistent/claude', environment: () => environment },
    (async () => { throw new Error('no runtime is opened by a rollback'); }) as never,
    async () => { loads++; if (history instanceof Error) throw history; return history as never; });
    return { provider, get loads() { return loads; } };
}
const input = (h: ReturnType<typeof transcript>, overrides: Record<string, unknown> = {}) => ({
    cwd: '/work', nativeCursor: SOURCE, title: 'Session title', target: { turnId: 'turn-1', promptUuid: h.t1.uuid },
    kept: [{ turnId: 'turn-1', promptUuid: h.t1.uuid }],
    later: [{ turnId: 'turn-2', promptUuid: h.t2.uuid }, { turnId: 'turn-3', promptUuid: h.t3.uuid }], ...overrides });
const codeError = (code: string) => (error: unknown) => error instanceof CodeStoreError && error.code === code && error.statusCode === 409;

test('Claude rollback forks the stored cursor through the entry before the next boundary and remaps kept turns', async () => {
    const h = transcript();
    const sessions = new Map([[SOURCE, h.all]]);
    const fake = fakeHistory(sessions);
    const result = await rollbackProvider(fake.helpers).provider.rollback!(input(h));
    assert.deepEqual(fake.calls.slice(0, 3), [
        ['info', SOURCE, { dir: '/work' }],
        ['messages', SOURCE, { dir: '/work', includeSystemMessages: true }],
        ['fork', SOURCE, { dir: '/work', upToMessageId: h.a1.uuid, title: 'Session title' }],
    ]);
    const fork = sessions.get(result.forkCursor)!;
    assert.deepEqual(fork.map(entry => entry.message), [h.t1, h.toolUse, h.toolResult, h.a1].map(entry => entry.message),
        'the tool call and its result stay with the kept turn; the removed prompt does not');
    assert.deepEqual(result.remapped, [{ turnId: 'turn-1', promptUuid: fork[0]!.uuid }]);
    assert.deepEqual(result.cleared, []);
    assert.deepEqual(sessions.get(SOURCE), h.all, 'the source conversation is never changed');
    await result.discard();
    assert.equal(sessions.has(result.forkCursor), false);
    assert.deepEqual(fake.calls.at(-1), ['delete', result.forkCursor, { dir: '/work' }]);
});

test('Claude rollback skips an undispatched later turn, never a missing one, and fails closed without the target', async () => {
    const h = transcript();
    const sessions = new Map([[SOURCE, h.all]]);
    const fake = fakeHistory(sessions);
    const { provider } = rollbackProvider(fake.helpers);
    const skipped = await provider.rollback!(input(h, { later: [{ turnId: 'turn-2', promptUuid: null }, { turnId: 'turn-3', promptUuid: h.t3.uuid }],
        kept: [{ turnId: 'turn-1', promptUuid: h.t1.uuid }], title: null }));
    assert.deepEqual(fake.calls.find(call => call[0] === 'fork'), ['fork', SOURCE, { dir: '/work', upToMessageId: h.a2.uuid }], 'no title: the SDK derives one');
    assert.equal(sessions.get(skipped.forkCursor)!.length, 6);
    const forks = () => fake.calls.filter(call => call[0] === 'fork').length;
    const before = forks();
    await assert.rejects(provider.rollback!(input(h, { later: [{ turnId: 'turn-2', promptUuid: uuid() }, { turnId: 'turn-3', promptUuid: h.t3.uuid }] })),
        codeError('rollback_boundary_unavailable'), 'a later boundary missing from history is never skipped');
    await assert.rejects(provider.rollback!(input(h, { target: { turnId: 'turn-1', promptUuid: uuid() } })), codeError('rollback_boundary_unavailable'));
    await assert.rejects(provider.rollback!(input(h, { target: { turnId: 'turn-1', promptUuid: h.toolResult.uuid } })), codeError('rollback_boundary_unavailable'),
        'a tool result is not a human turn start');
    await assert.rejects(provider.rollback!(input(h, { later: [{ turnId: 'turn-2', promptUuid: null }] })), codeError('rollback_boundary_unavailable'));
    await assert.rejects(provider.rollback!(input(h, { later: [{ turnId: 'turn-0', promptUuid: h.t1.uuid }], target: { turnId: 'turn-2', promptUuid: h.t2.uuid } })),
        codeError('rollback_boundary_unavailable'), 'a later boundary before the target is out of order');
    sessions.set(SOURCE, []);
    await assert.rejects(provider.rollback!(input(h)), codeError('rollback_unavailable'));
    assert.equal(forks(), before);
});

test('Claude rollback deletes a fork that does not reproduce the retained conversation', async () => {
    const h = transcript();
    for (const mutate of [(fork: Message[]) => fork.slice(1), (fork: Message[]) => fork.map((entry, index) => index === 2 ? { ...entry, message: { role: 'user', content: 'changed' } } : entry)]) {
        const sessions = new Map([[SOURCE, h.all]]);
        const fake = fakeHistory(sessions, { mutate });
        await assert.rejects(rollbackProvider(fake.helpers).provider.rollback!(input(h)), codeError('rollback_unavailable'));
        const fork = fake.calls.find(call => call[0] === 'fork');
        const created = [...sessions.keys()].filter(id => id !== SOURCE);
        assert.equal(created.length, 0, 'the unverified fork is deleted');
        assert.ok(fork && fake.calls.some(call => call[0] === 'delete'));
        assert.deepEqual(sessions.get(SOURCE), h.all);
    }
    for (const forkId of [SOURCE, 'not-a-uuid']) {
        const sessions = new Map([[SOURCE, h.all]]);
        const fake = fakeHistory(sessions, { forkId });
        await assert.rejects(rollbackProvider(fake.helpers).provider.rollback!(input(h)), codeError('rollback_unavailable'));
        assert.equal(fake.calls.some(call => call[0] === 'delete'), false, 'only a fresh UUID other than the source is deleted');
        assert.ok(sessions.has(SOURCE));
    }
});

test('Claude rollback remaps by aligned position, leaves unrecorded turns alone and clears unaligned ones', async () => {
    const h = transcript();
    const summary = msg('user', 'This session is being continued. SUMMARY');
    const sessions = new Map([[SOURCE, [summary, ...h.all.slice(4)]]]);
    const fake = fakeHistory(sessions, { mutate: fork => [msg('system', null), ...fork] });
    const result = await rollbackProvider(fake.helpers).provider.rollback!(input(h, {
        target: { turnId: 'turn-2', promptUuid: h.t2.uuid },
        kept: [{ turnId: 'turn-0', promptUuid: null }, { turnId: 'turn-1', promptUuid: h.t1.uuid }, { turnId: 'turn-2', promptUuid: h.t2.uuid }],
        later: [{ turnId: 'turn-3', promptUuid: h.t3.uuid }] }));
    const fork = sessions.get(result.forkCursor)!;
    assert.deepEqual(result.remapped, [{ turnId: 'turn-2', promptUuid: fork[2]!.uuid }], 'system entries are outside the alignment');
    assert.deepEqual(result.cleared, ['turn-1'], 'a compacted kept turn has no aligned message');
});

test('Claude rollback is bounded by transcript size and the history configuration, before any read', async () => {
    const h = transcript();
    for (const fileSize of [32 * 1024 * 1024 + 1, undefined]) {
        const fake = fakeHistory(new Map([[SOURCE, h.all]]), { fileSize });
        await assert.rejects(rollbackProvider(fake.helpers).provider.rollback!(input(h)), codeError('rollback_unavailable'));
        assert.deepEqual(fake.calls.map(call => call[0]), ['info'], 'no transcript parse and no fork');
    }
    const fake = fakeHistory(new Map([[SOURCE, h.all]]));
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME']) {
        const guarded = rollbackProvider(fake.helpers, { ...process.env, [key]: '/elsewhere' });
        await assert.rejects(guarded.provider.rollback!(input(h)), codeError('rollback_unavailable'));
        assert.equal(guarded.loads, 0);
    }
    assert.deepEqual(fake.calls, []);
    const missing = rollbackProvider(new Error('optional dependency missing'));
    await assert.rejects(missing.provider.rollback!(input(h)), codeError('rollback_unavailable'));
    const failing = fakeHistory(new Map([[SOURCE, h.all]]));
    (failing.helpers as { forkSession: unknown }).forkSession = async () => { throw new Error('ENOENT private path'); };
    await assert.rejects(rollbackProvider(failing.helpers).provider.rollback!(input(h)),
        (error: unknown) => codeError('rollback_unavailable')(error) && !String((error as Error).message).includes('private path'));
});
