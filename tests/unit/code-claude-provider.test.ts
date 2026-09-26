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
