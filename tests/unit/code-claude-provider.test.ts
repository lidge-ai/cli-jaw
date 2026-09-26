import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeCodeProvider } from '../../src/code-mode/providers/claude.ts';

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

test('Claude Code provider passes the thinking switch and reconfigures through the runtime', async () => {
    const off = harness({ thinking: false });
    const handle = await off.open();
    assert.equal(off.captured()['prepared'].thinking, false);
    await handle.reconfigure!({ model: 'claude-sonnet-5', effort: null, thinking: true },
        { model: 'claude-opus-4-8', effort: 'high', thinking: false });
    assert.deepEqual(off.runtime.reconfigured, [{ next: { model: 'claude-sonnet-5', effort: null, thinking: true },
        previous: { model: 'claude-opus-4-8', effort: 'high', thinking: false } }]);
    await assert.rejects(async () => handle.reconfigure!({ model: 'x', effort: 'ultra', thinking: true },
        { model: 'claude-opus-4-8', effort: null, thinking: true }), /code_provider_effort_unsupported/);
    await handle.close();
    const unset = harness();
    await (await unset.open()).close();
    assert.equal('thinking' in unset.captured()['prepared'], false, 'null leaves the CLI default');
});
