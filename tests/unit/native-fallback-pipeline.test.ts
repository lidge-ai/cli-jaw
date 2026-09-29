import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast } from '../../src/core/bus.ts';
import { orchestrateAndCollectData } from '../../src/orchestrator/collect.ts';
import type { spawnAgent } from '../../src/agent/spawn.ts';

type Options = NonNullable<Parameters<typeof spawnAgent>[1]> & { _isFallback?: boolean; cli?: string };

// Real pipeline and collector; only the runtime boundary is faked. The first
// run fails natively and names a fallback, as lifecycle does after a native
// Claude error; the second run answers under a different trace id.
function failingThenFallback() {
    const calls: Options[] = [];
    const spawn = (_prompt: string, opts: Options) => {
        calls.push(opts);
        const first = calls.length === 1;
        const runId = first ? 'claude-run' : 'cursor-run';
        const identity = { runId, scope: opts.scopeKey!, sessionId: opts.chatSessionId!, origin: opts.origin!,
            ...(opts.requestId ? { requestId: opts.requestId } : {}) };
        // Pins the collector to this run, the way native activity does.
        opts.lifecycle?.onActivity?.('native-runtime', identity);
        const pin = { scope: identity.scope, sessionId: identity.sessionId, origin: identity.origin,
            requestId: opts.requestId, traceRunId: runId, runtimeFinality: 'absent' };
        const promise = Promise.resolve().then(() => {
            if (first) {
                broadcast('agent_done', { ...pin, runtimeStatus: 'error', text: '', fallbackPending: 'cursor' });
                return { text: '', code: 1, traceRunId: runId, nativeFallbackCli: 'cursor',
                    runtimeOutcome: { status: 'error' as const, finalText: null, partialText: '' } };
            }
            broadcast('agent_done', { ...pin, runtimeFinality: 'present', runtimeStatus: 'done', text: 'FALLBACK_ANSWER' });
            return { text: 'FALLBACK_ANSWER', code: 0, traceRunId: runId,
                runtimeOutcome: { status: 'done' as const, finalText: 'FALLBACK_ANSWER', partialText: '' } };
        });
        return { child: null, promise };
    };
    return { calls, spawn };
}

test('a native failure handed to fallback resolves the same request with the fallback answer', async () => {
    const io = failingThenFallback();
    const collected = await Promise.race([
        orchestrateAndCollectData('task', { origin: 'heartbeat', scope: 'fb-scope', chatSessionId: 'fb-chat',
            requestId: 'fb-request', _skipReplayDrain: true, _spawnAgent: io.spawn }, 'en'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('collector waited on the failed run')), 3000)),
    ]);
    assert.equal(io.calls.length, 2);
    assert.equal(io.calls[1]!.cli, 'cursor');
    assert.equal(io.calls[1]!._isFallback, true);
    assert.equal(collected.text, 'FALLBACK_ANSWER');
    assert.equal(collected.data['runtimeStatus'], 'done');
});

test('a failure with no fallback named is not re-run', async () => {
    const calls: Options[] = [];
    const spawn = (_prompt: string, opts: Options) => {
        calls.push(opts);
        return { child: null, promise: Promise.resolve({ text: '', code: 1, traceRunId: 'only-run',
            runtimeOutcome: { status: 'error' as const, finalText: null, partialText: '' } }) };
    };
    const collected = await orchestrateAndCollectData('task', { origin: 'heartbeat', scope: 'nofb-scope',
        chatSessionId: 'nofb-chat', requestId: 'nofb-request', _skipReplayDrain: true, _spawnAgent: spawn }, 'en');
    assert.equal(calls.length, 1);
    assert.equal(collected.data['runtimeStatus'], 'error');
});
