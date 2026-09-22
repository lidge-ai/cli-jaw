import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRuntimeSession, type PiSessionTransport } from '../../src/agent/runtime/pi-runtime-session.ts';
import type { PiPromptResult } from '../../src/agent/pi-runtime.ts';
import { PiRuntimeError } from '../../src/agent/runtime/pi-turn.ts';
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
    failure: unknown;
    hold: Promise<void> | null = null;

    get alive(): boolean { return !this.poisoned && !this.killed; }
    async sendPrompt(message: string): Promise<PiPromptResult> {
        this.lastPrompt = message;
        if (this.hold) await this.hold;
        if (this.failure !== undefined) throw this.failure;
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

test('failure observer receives the derived immutable outcome before callback and remains nonfatal', async () => {
    const transport = new FakeTransport();
    const derived = { status: 'error', finalText: null, partialText: 'accepted partial' } satisfies RuntimeTurnOutcome;
    const failure = new PiRuntimeError(new Error('provider rejected'), derived);
    transport.failure = failure;
    let observed: { error: Error; outcome: RuntimeTurnOutcome } | undefined;
    const runtime = new PiRuntimeSession(transport, {
        lifetime: 'oneshot', deferTurnEnd: true,
        getTurnContext: () => ({ turnId: 'failure-turn', isCurrent: () => true }),
        onFailure: (error, outcome) => { observed = { error, outcome }; throw new Error('observer failed'); },
    });
    const outcome = await runtime.send({ text: 'go' }, () => {});
    assert.deepEqual(outcome, derived);
    assert.equal(observed?.error, failure);
    assert.deepEqual(observed?.outcome, derived);
    assert.equal(Object.isFrozen(observed?.outcome), true);
});

test('resolved stderr observer runs once without changing the outcome when it throws', async () => {
    const transport = new FakeTransport();
    transport.result = { text: '', stderr: '429 retry later', runtimeOutcome: { status: 'error', finalText: null, partialText: '' } };
    const observed: string[] = [];
    const runtime = new PiRuntimeSession(transport, {
        lifetime: 'oneshot', deferTurnEnd: true,
        getTurnContext: () => ({ turnId: 'stderr-turn', isCurrent: () => true }),
        onStderr: stderr => { observed.push(stderr); throw new Error('observer failed'); },
    });
    assert.deepEqual(await runtime.send({ text: 'go' }, () => {}), { status: 'error', finalText: null, partialText: '' });
    assert.deepEqual(observed, ['429 retry later']);
});

test('callbacks require captured current ownership and stay isolated across sequential turns', async () => {
    const transport = new FakeTransport();
    let turnId = 'turn-1';
    let current = true;
    const failures: string[] = [];
    const stderrs: string[] = [];
    const runtime = new PiRuntimeSession(transport, {
        lifetime: 'oneshot', deferTurnEnd: true,
        getTurnContext: () => ({ turnId, isCurrent: () => current }),
        onFailure: () => failures.push(turnId),
        onStderr: stderr => stderrs.push(`${turnId}:${stderr}`),
    });

    transport.failure = new Error('stale failure');
    current = false;
    assert.equal((await runtime.send({ text: 'first' }, () => {})).status, 'error');
    assert.deepEqual(failures, []);
    assert.equal(runtime.claimTurnOutcome('turn-1')?.status, 'error');
    assert.equal(runtime.finalizeTurn('turn-1', { kind: 'turn-end', status: 'error', finalText: null }), true);

    turnId = 'turn-2';
    current = true;
    transport.failure = undefined;
    transport.result = { text: 'ok', stderr: 'second stderr', runtimeOutcome: { status: 'done', finalText: 'ok', partialText: 'ok' } };
    assert.equal((await runtime.send({ text: 'second' }, () => {})).status, 'done');
    assert.deepEqual(failures, []);
    assert.deepEqual(stderrs, ['turn-2:second stderr']);
});

test('cancelled rejection reports a stopped outcome to the failure observer', async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    transport.hold = new Promise<void>(resolve => { release = resolve; });
    transport.failure = new Error('cancelled transport');
    const statuses: RuntimeTurnOutcome['status'][] = [];
    const runtime = new PiRuntimeSession(transport, {
        lifetime: 'oneshot', deferTurnEnd: true,
        getTurnContext: () => ({ turnId: 'cancelled-turn', isCurrent: () => true }),
        onFailure: (_error, outcome) => statuses.push(outcome.status),
    });
    const sending = runtime.send({ text: 'go' }, () => {});
    await runtime.cancel();
    release();
    assert.equal((await sending).status, 'stopped');
    assert.deepEqual(statuses, ['stopped']);
});
