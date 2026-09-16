import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRuntimeSession, type PiSessionTransport } from '../../src/agent/runtime/pi-runtime-session.ts';
import type { PiPromptResult } from '../../src/agent/pi-runtime.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

class FakeTransport extends EventEmitter implements PiSessionTransport {
    child = this as unknown as PiSessionTransport['child'];
    sessionId: string | null = 'pi-session';
    abortEffective = true;
    poisoned = false;
    killed = false;
    abortCount = 0;
    killCount = 0;
    closeCount = 0;
    lastPrompt: string | null = null;
    result: PiPromptResult = { text: 'answer', stderr: '', runtimeOutcome: { status: 'done', finalText: 'answer', partialText: 'answer' } };
    hold: Promise<void> | null = null;

    get alive(): boolean { return !this.poisoned && !this.killed; }
    async sendPrompt(message: string): Promise<PiPromptResult> {
        this.lastPrompt = message;
        if (this.hold) await this.hold;
        return this.result;
    }
    async abort(): Promise<void> { this.abortCount += 1; }
    close(): void { this.closeCount += 1; this.poisoned = true; }
    kill(): void { this.killCount += 1; this.killed = true; }
}

function session(lifetime: 'pooled' | 'oneshot', transport = new FakeTransport(), turnId = 'trace-1') {
    return new PiRuntimeSession(transport, {
        lifetime,
        provider: 'pi',
        deferTurnEnd: true,
        getTurnContext: () => ({ turnId }),
    });
}

test('claim once returns the same snapshot; unknown id is null', async () => {
    const runtime = session('oneshot');
    const outcome = await runtime.send({ text: 'hello' }, () => {});
    const first = runtime.claimTurnOutcome('trace-1');
    assert.deepEqual(first, outcome);
    assert.equal(runtime.claimTurnOutcome('trace-1'), first);
    assert.equal(runtime.claimTurnOutcome('other'), null);
    assert.equal(runtime.finalizeTurn('trace-1', { kind: 'turn-end', status: 'done', finalText: 'app final' }), true);
    assert.equal(runtime.finalizeTurn('trace-1', { kind: 'turn-end', status: 'done', finalText: 'app final' }), false);
});

test('send captures getTurnContext.turnId once and does not mint a private id', async () => {
    let turnId = 'host-turn';
    const transport = new FakeTransport();
    const runtime = new PiRuntimeSession(transport, {
        lifetime: 'oneshot',
        deferTurnEnd: true,
        getTurnContext: () => ({ turnId }),
    });
    const sending = runtime.send({ text: 'p' }, () => {});
    turnId = 'mutated';
    await sending;
    assert.ok(runtime.claimTurnOutcome('host-turn'));
    assert.equal(runtime.claimTurnOutcome('mutated'), null);
});

test('steer is rejected restart', async () => {
    const runtime = session('pooled');
    const result = await runtime.steer({ text: 'more' });
    assert.deepEqual(result, {
        mode: 'restart', accepted: false, turnId: 'trace-1', reason: 'Use application restart steering',
    });
});

test('respond throws because Pi has no permission RPC', async () => {
    const runtime = session('oneshot');
    await assert.rejects(runtime.respond(), /pi_runtime_no_permission_rpc/);
});

test('oneshot cancel aborts then always kills', async () => {
    const transport = new FakeTransport();
    const runtime = session('oneshot', transport);
    await runtime.cancel();
    assert.equal(transport.abortCount, 1);
    assert.equal(transport.killCount, 1);
});

test('pooled cancel aborts without kill when abort is effective', async () => {
    const transport = new FakeTransport();
    const runtime = session('pooled', transport);
    await runtime.cancel();
    assert.equal(transport.abortCount, 1);
    assert.equal(transport.killCount, 0);
});

test('pooled cancel kills when abort is not effective', async () => {
    const transport = new FakeTransport();
    transport.abortEffective = false;
    const runtime = session('pooled', transport);
    await runtime.cancel();
    assert.equal(transport.abortCount, 0);
    assert.equal(transport.killCount, 1);
});

test('send after prepare uses the transport prompt and keeps a stopped map off 130', async () => {
    const transport = new FakeTransport();
    transport.result = { text: '', stderr: '', runtimeOutcome: { status: 'stopped', finalText: null, partialText: 'partial' } };
    const runtime = session('oneshot', transport);
    const outcome = await runtime.send({ text: 'go' }, () => {});
    assert.equal(transport.lastPrompt, 'go');
    assert.deepEqual(outcome, { status: 'stopped', finalText: null, partialText: 'partial' } satisfies RuntimeTurnOutcome);
});
