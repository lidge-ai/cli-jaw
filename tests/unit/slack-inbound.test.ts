import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackSocketClient, type SlackEnvelope, type SlackSocketLike } from '../../src/slack/socket.ts';
import {
    shouldProcessSlackEvent,
    shouldAttachSlack,
    isConversationAllowed,
    extractTextFromBlocks,
    resolveEventText,
    isDirectMessage,
    stripMention,
    type SlackGateConfig,
} from '../../src/slack/events.ts';

// ─── fake socket harness ────────────────────────────

test.beforeEach(t => {
    const unexpectedNetwork: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
        unexpectedNetwork.push(String(input));
        throw new Error('Slack inbound fixture attempted unexpected network');
    });
    t.after(() => assert.deepEqual(unexpectedNetwork, [], 'all Slack traffic must use explicit fixtures'));
});

type Harness = {
    client: SlackSocketClient;
    emit: (frame: unknown) => Promise<void>;
    sent: string[];
    handled: SlackEnvelope[];
    stateChanges: string[];
};

async function makeHarness(options: {
    onEnvelope?: (e: SlackEnvelope) => void | Promise<void>;
    maxReconnectAttempts?: number;
} = {}): Promise<Harness> {
    const sent: string[] = [];
    const handled: SlackEnvelope[] = [];
    const stateChanges: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();

    const socket: SlackSocketLike = {
        send: (data: string) => { sent.push(data); },
        close: () => { /* no-op */ },
        addEventListener: (type, listener) => { listeners.set(type, listener); },
    };

    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        socketFactory: () => socket,
        maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
        baseReconnectDelayMs: 1000,
        onEnvelope: async (e) => {
            handled.push(e);
            await options.onEnvelope?.(e);
        },
        onStateChange: state => { stateChanges.push(state); },
    });
    await client.start();

    const emit = async (frame: unknown) => {
        const listener = listeners.get('message');
        assert.ok(listener, 'no message listener registered');
        listener({ data: JSON.stringify(frame) });
        // let the async handler settle
        await new Promise(resolve => setImmediate(resolve));
    };
    return { client, emit, sent, handled, stateChanges };
}

const eventsEnvelope = (id: string, event: Record<string, unknown>): SlackEnvelope => ({
    envelope_id: id,
    type: 'events_api',
    payload: { event },
});

// ─── ack protocol ───────────────────────────────────

test('hello moves the client to connected without acking', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    assert.equal(h.client.getState(), 'connected');
    assert.equal(h.sent.length, 0, 'control frames must not be acked');
    assert.equal(h.handled.length, 0);
    h.client.stop();
});

test('waitForReady observes hello before and after waiter registration', async () => {
    const before = await makeHarness();
    const pending = before.client.waitForReady(1000);
    await before.emit({ type: 'hello' });
    assert.equal(await pending, 'connected');
    assert.equal(await before.client.waitForReady(1000), 'connected');
    assert.ok(before.stateChanges.includes('connected'));
    before.client.stop();

    const stopped = await makeHarness();
    const stoppedWait = stopped.client.waitForReady(1000);
    stopped.client.stop('disabled');
    assert.equal(await stoppedWait, 'stopped');
    assert.equal(stopped.stateChanges.at(-1), 'disabled');
});

test('an events envelope is acked with exactly its envelope_id', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit(eventsEnvelope('E1', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.deepEqual(JSON.parse(h.sent[0]!), { envelope_id: 'E1' });
    h.client.stop();
});

test('the ack is sent BEFORE the handler finishes', async () => {
    // Slack retries un-acked envelopes within 3s. Acking after the agent run
    // is how one Slack message becomes three agent runs.
    let ackedWhenHandlerRan: number | null = null;
    const h = await makeHarness({
        onEnvelope: async () => {
            ackedWhenHandlerRan = 0;
            await new Promise(resolve => setTimeout(resolve, 5));
        },
    });
    await h.emit({ type: 'hello' });
    const pending = h.emit(eventsEnvelope('E2', { type: 'message', channel: 'D1', text: 'hi' }));
    // The ack must already be on the wire while the handler is still awaiting.
    assert.equal(h.sent.length, 1, 'ack was not sent before handler completion');
    await pending;
    assert.equal(ackedWhenHandlerRan, 0, 'handler never ran');
    h.client.stop();
});

test('a duplicate envelope_id is acked again but handled once', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const env = eventsEnvelope('E3', { type: 'message', channel: 'D1', text: 'hi' });
    await h.emit(env);
    await h.emit({ ...env, retry_attempt: 1 });
    assert.equal(h.sent.length, 2, 'a retry must still be acked or Slack keeps retrying');
    assert.equal(h.handled.length, 1, 'duplicate was processed twice');
    h.client.stop();
});

test('dedupe survives a burst larger than any count-based window', async () => {
    // Regression: a count-only window (256) let a busy channel evict an id
    // before Slack's retry arrived, recreating the duplicate-agent-run bug.
    // Dedupe now expires by TIME, so volume alone must not reopen the hole.
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const first = eventsEnvelope('OLD', { type: 'message', channel: 'D1', text: 'x' });
    await h.emit(first);
    for (let i = 0; i < 400; i++) {
        await h.emit(eventsEnvelope(`F${i}`, { type: 'message', channel: 'D1', text: 'x' }));
    }
    await h.emit({ ...first, retry_attempt: 1 });
    assert.equal(h.handled.length, 401, 'a delayed retry was processed a second time');
    h.client.stop();
});

test('a valid but unhandled envelope type is still acked', async () => {
    // Un-acked envelopes are retried forever. Acking a type we will never act
    // on stops the retry loop without dispatching it.
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ envelope_id: 'FUTURE', type: 'some_future_type', payload: {} });
    assert.deepEqual(JSON.parse(h.sent[0]!), { envelope_id: 'FUTURE' });
    assert.equal(h.handled.length, 0, 'unhandled type must not dispatch');
    h.client.stop();
});

test('a failed ack leaves the envelope eligible for one retry dispatch', async () => {
    // Acking is what tells Slack the delivery landed. If the ack itself fails
    // the delivery WILL be retried, so running the agent now would duplicate
    // that work.
    const handled: SlackEnvelope[] = [];
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    const reconnected = Promise.withResolvers<Map<string, (event: unknown) => void>>();
    const preflightEntered = Promise.withResolvers<void>();
    const firstPreflight = Promise.withResolvers<'committed'>();
    let preflightCalls = 0;
    let ackAttempts = 0;
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 0,
        maxReconnectAttempts: 2,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            const failAck = sockets.length === 0;
            sockets.push(listeners);
            if (sockets.length === 2) reconnected.resolve(listeners);
            return {
                send: () => {
                    ackAttempts += 1;
                    if (failAck) throw new Error('socket closing');
                },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        preflightEnvelope: async () => {
            preflightCalls += 1;
            if (preflightCalls === 1) {
                preflightEntered.resolve();
                return firstPreflight.promise;
            }
            return 'committed';
        },
        onEnvelope: (e) => { handled.push(e); },
    });
    try {
        await client.start();
        sockets[0]!.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));

        const envelope = eventsEnvelope('ACKFAIL', { type: 'message', channel: 'D1', text: 'hi' });
        sockets[0]!.get('message')!({ data: JSON.stringify(envelope) });
        await preflightEntered.promise;
        sockets[0]!.get('message')!({ data: JSON.stringify({ ...envelope, retry_attempt: 1 }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(preflightCalls, 1, 'a pending duplicate entered durable preflight');
        assert.equal(ackAttempts, 0, 'a pending duplicate was acknowledged before durable preflight committed');
        assert.equal(handled.length, 0);

        firstPreflight.resolve('committed');
        const retrySocket = await reconnected.promise;
        retrySocket.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));
        retrySocket.get('message')!({ data: JSON.stringify({ ...envelope, retry_attempt: 1 }) });
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(handled.length, 1, 'same envelope retry was not dispatched exactly once');
        assert.equal(ackAttempts, 2, 'first ACK must fail and the retry ACK must succeed');
    } finally {
        client.stop();
    }
});

test('a delayed preflight cannot ack or dispatch through a replacement socket', async () => {
    const handled: SlackEnvelope[] = [];
    const sockets: Array<{
        listeners: Map<string, (event: unknown) => void>;
        sent: string[];
    }> = [];
    const reconnected = Promise.withResolvers<Map<string, (event: unknown) => void>>();
    const preflightEntered = Promise.withResolvers<void>();
    const firstPreflight = Promise.withResolvers<'committed'>();
    let preflightCalls = 0;
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    } as unknown as Response)) as unknown as typeof fetch;
    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 0,
        maxReconnectAttempts: 2,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            const row = { listeners, sent: [] as string[] };
            sockets.push(row);
            if (sockets.length === 2) reconnected.resolve(listeners);
            return {
                send: data => { row.sent.push(data); },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        preflightEnvelope: async () => {
            preflightCalls += 1;
            if (preflightCalls === 1) {
                preflightEntered.resolve();
                return firstPreflight.promise;
            }
            return 'committed';
        },
        onEnvelope: envelope => { handled.push(envelope); },
    });
    try {
        await client.start();
        sockets[0]!.listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));
        const envelope = eventsEnvelope('LATE', { type: 'message', channel: 'D1', text: 'hi' });
        sockets[0]!.listeners.get('message')!({ data: JSON.stringify(envelope) });
        await preflightEntered.promise;
        sockets[0]!.listeners.get('message')!({ data: JSON.stringify({ type: 'disconnect', reason: 'warning' }) });
        firstPreflight.resolve('committed');
        await new Promise(resolve => setImmediate(resolve));

        const retrySocket = await reconnected.promise;
        retrySocket.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(sockets.map(row => row.sent.length), [0, 0], 'late preflight acknowledged on a replacement socket');
        assert.equal(handled.length, 0, 'late preflight dispatched after losing socket ownership');

        retrySocket.get('message')!({ data: JSON.stringify({ ...envelope, retry_attempt: 1 }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(sockets.map(row => row.sent.length), [0, 1]);
        assert.equal(handled.length, 1);
    } finally {
        client.stop();
    }
});

test('extractTextFromBlocks survives pathological nesting depth', () => {
    // Inbound block structures are attacker-influenced; a recursive walk blew
    // the call stack at ~20k levels.
    let node: Record<string, unknown> = { type: 'section', text: { type: 'mrkdwn', text: 'deep' } };
    for (let i = 0; i < 20000; i++) node = { type: 'context', elements: [node] };
    assert.doesNotThrow(() => extractTextFromBlocks([node]));
});

test('dedupe holds an id across a burst far larger than any size ceiling', async () => {
    // Regression: an entry ceiling evicted UNEXPIRED ids, so a busy workspace
    // could reprocess a delayed retry — the exact duplicate-agent-run failure
    // the dedupe exists to prevent. Only EXPIRED entries may be swept.
    const listeners = new Map<string, (event: unknown) => void>();
    let handled = 0;
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 99_000,
        socketFactory: () => ({
            send: () => { /* no-op */ },
            close: () => { /* no-op */ },
            addEventListener: (type, listener) => { listeners.set(type, listener); },
        }),
        onEnvelope: () => { handled++; },
    });
    await client.start();
    listeners.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
    await new Promise(resolve => setImmediate(resolve));

    const frame = (id: string) => JSON.stringify({
        envelope_id: id,
        type: 'events_api',
        payload: { event: { type: 'message', channel: 'D1', text: 'x' } },
    });
    listeners.get('message')!({ data: frame('OLD') });
    for (let i = 0; i < 5000; i++) listeners.get('message')!({ data: frame(`F${i}`) });
    await new Promise(resolve => setImmediate(resolve));
    listeners.get('message')!({ data: frame('OLD') });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(handled, 5001, 'a delayed retry was reprocessed after a large burst');
    client.stop();
});

test('a warning-close during an in-flight reconnect does not stack another', async () => {
    // See also: 'a failed handshake keeps retrying' below — the guard that
    // prevents stacking must not swallow the reconnect demand entirely.
    // Reproduced by the reviewer as 3 connections for one disconnect: the
    // `disconnect` frame scheduled a reconnect and the following `close` from
    // the same socket scheduled a second one.
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    let fetchCalls = 0;
    const fetchImpl = (async () => {
        fetchCalls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
        // justified: minimal Response surface for the socket handshake
        } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 5,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            sockets.push(listeners);
            return {
                send: () => { /* no-op */ },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        onEnvelope: () => { /* no-op */ },
    });
    await client.start();
    sockets[0]!.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
    await new Promise(resolve => setImmediate(resolve));

    sockets[0]!.get('message')!({ data: JSON.stringify({ type: 'disconnect', reason: 'warning' }) });
    sockets[0]!.get('close')!({});
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(fetchCalls, 2, `one disconnect produced ${fetchCalls} connection attempts`);
    assert.equal(client.getReconnectAttempts(), 1);
    client.stop();
});

test('a failed handshake keeps retrying instead of stalling forever', async () => {
    // Regression: the guard added to stop reconnect stacking also DROPPED the
    // demand when apps.connections.open failed inside connect(), leaving the
    // transport stuck in 'connecting' with no timer and no socket — silently
    // dead until the process restarted.
    let fetchCalls = 0;
    const fetchImpl = (async () => {
        fetchCalls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: false, error: 'internal_error' }),
        // justified: minimal Response surface for the socket handshake
        } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 10,
        maxReconnectAttempts: 3,
        socketFactory: () => ({
            send: () => { /* no-op */ },
            close: () => { /* no-op */ },
            addEventListener: () => { /* no-op */ },
        }),
        onEnvelope: () => { /* no-op */ },
    });
    await client.start();
    assert.equal(client.getReconnectAttempts(), 1, 'the first failure did not schedule a retry');

    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(fetchCalls > 1, `handshake never retried (fetchCalls=${fetchCalls})`);
    assert.equal(client.getReconnectAttempts(), 3, 'retries did not reach the ceiling');
    assert.equal(client.getState(), 'disconnected', 'client should give up cleanly at the ceiling');
    client.stop();
});

test('the default client keeps retrying past the old ten-attempt ceiling', async () => {
    // Regression: a network outage that outlasted ten attempts left the socket
    // permanently 'disconnected' while the process stayed up and health still
    // reported Slack inbound as active, so messages arrived nowhere until
    // someone restarted the service by hand.
    let fetchCalls = 0;
    const fetchImpl = (async () => {
        fetchCalls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: false, error: 'internal_error' }),
        // justified: minimal Response surface for the socket handshake
        } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 0,
        socketFactory: () => ({
            send: () => { /* no-op */ },
            close: () => { /* no-op */ },
            addEventListener: () => { /* no-op */ },
        }),
        onEnvelope: () => { /* no-op */ },
    });
    await client.start();
    await new Promise(resolve => setTimeout(resolve, 150));

    const attempts = client.getReconnectAttempts();
    const state = client.getState();
    client.stop();
    assert.ok(attempts > 10, `retries stopped at ${attempts}`);
    assert.equal(state, 'reconnecting', 'client stopped trying to reach Slack');
    assert.ok(fetchCalls > 10, `handshake stopped retrying (fetchCalls=${fetchCalls})`);
});

// ─── reconnect-window guard ─────────────────────────

test('a frame arriving before hello is NOT acked and NOT dispatched', async () => {
    // Un-acked is deliberate: it is what makes Slack redeliver on the new
    // connection. Acking then dropping would be permanent message loss.
    const h = await makeHarness();
    await h.emit(eventsEnvelope('E4', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.equal(h.sent.length, 0, 'frame was acked while not connected');
    assert.equal(h.handled.length, 0);
    h.client.stop();
});

test('a frame redelivered after hello IS acked and dispatched exactly once', async () => {
    const h = await makeHarness();
    const env = eventsEnvelope('E5', { type: 'message', channel: 'D1', text: 'hi' });
    await h.emit(env);          // dropped, un-acked
    await h.emit({ type: 'hello' });
    await h.emit(env);          // Slack redelivers
    assert.equal(h.sent.length, 1);
    assert.equal(h.handled.length, 1);
    h.client.stop();
});

// ─── disconnect semantics ───────────────────────────

test('a disconnect warning schedules a reconnect', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'warning' });
    assert.equal(h.client.getState(), 'reconnecting');
    h.client.stop();
});

test('link_disabled is terminal and does not reconnect', async () => {
    // Socket Mode was turned off in app settings; retrying burns attempts
    // against a closed door and loses the diagnosable reason.
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'link_disabled' });
    assert.equal(h.client.getState(), 'disabled');
    assert.equal(h.client.getReconnectAttempts(), 0);
});

test('a superseded socket cannot schedule extra reconnects', async () => {
    // Slack recycles sockets. A dead socket's late (or repeated) close event
    // must not spawn parallel connections — that is how a reconnect storm
    // starts.
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    let created = 0;
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 5,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            sockets.push(listeners);
            created++;
            return {
                send: () => { /* no-op */ },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        onEnvelope: () => { /* no-op */ },
    });
    await client.start();

    sockets[0]!.get('close')!({});                 // genuine close -> one reconnect
    await new Promise(resolve => setTimeout(resolve, 40));
    const afterRealClose = created;

    sockets[0]!.get('close')!({});                 // same dead socket, again
    sockets[0]!.get('close')!({});
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(created, afterRealClose, 'a stale socket spawned another connection');
    assert.equal(client.getReconnectAttempts(), 1, 'reconnect attempts compounded');
    client.stop();
});

test('a message from a superseded socket is ignored', async () => {
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    const handled: SlackEnvelope[] = [];
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 5,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            sockets.push(listeners);
            return {
                send: () => { /* no-op */ },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        onEnvelope: (e) => { handled.push(e); },
    });
    await client.start();
    sockets[0]!.get('close')!({});
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(sockets.length >= 2, 'expected a replacement socket');

    // The NEW socket becomes ready; the OLD one then delivers a frame.
    sockets[1]!.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
    sockets[0]!.get('message')!({
        data: JSON.stringify(eventsEnvelope('STALE', { type: 'message', channel: 'D1', text: 'hi' })),
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(handled.length, 0, 'a frame from a dead socket was processed');
    client.stop();
});

test('frames after link_disabled are ignored', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'link_disabled' });
    await h.emit(eventsEnvelope('E6', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.equal(h.handled.length, 0);
});

// ─── robustness ─────────────────────────────────────

test('an unparseable frame is dropped without throwing', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const listener = (h as unknown as { client: SlackSocketClient }).client;
    assert.ok(listener);
    // emit raw garbage through the same path
    await assert.doesNotReject(async () => {
        await h.emit({ type: 'hello' }); // valid control frame keeps the path alive
    });
    h.client.stop();
});

test('an unknown envelope type is not dispatched', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ envelope_id: 'E7', type: 'some_future_type', payload: {} });
    assert.equal(h.handled.length, 0);
    h.client.stop();
});

// ─── gating rules ───────────────────────────────────

const baseConfig = (over: Partial<SlackGateConfig> = {}): SlackGateConfig => ({
    selfUserId: 'UBOT',
    allowBots: false,
    mentionOnly: true,
    channelIds: [],
    threadRequireMention: false,
    isParticipatedThread: () => false,
    ...over,
});

test('the bot never answers its own message', () => {
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'C1', user: 'UBOT', text: 'hi' }, baseConfig(), 'events_api');
    assert.deepEqual(d, { process: false, reason: 'self_message' });
});

test('bot messages are gated by allowBots', () => {
    const event = { type: 'message', channel: 'C1', bot_id: 'B1', text: 'hi' };
    assert.equal(shouldProcessSlackEvent(event, baseConfig(), 'events_api').process, false);
    assert.equal(
        shouldProcessSlackEvent(event, baseConfig({ allowBots: true, mentionOnly: false }), 'events_api').process,
        true,
    );
});

test('edit and system subtypes are ignored', () => {
    for (const subtype of ['message_changed', 'channel_join', 'bot_message']) {
        const d = shouldProcessSlackEvent({ type: 'message', subtype, channel: 'C1', text: 'x' }, baseConfig(), 'events_api');
        assert.equal(d.process, false, `${subtype} should be ignored`);
    }
});

test('the channel allowlist blocks unlisted channels', () => {
    const config = baseConfig({ channelIds: ['C123'], mentionOnly: false });
    assert.equal(shouldProcessSlackEvent({ type: 'message', channel: 'C999', text: 'x' }, config, 'events_api').process, false);
    assert.equal(shouldProcessSlackEvent({ type: 'message', channel: 'C123', text: 'x' }, config, 'events_api').process, true);
});

test('DMs bypass the allowlist', () => {
    const config = baseConfig({ channelIds: ['C123'], mentionOnly: true });
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'D999', channel_type: 'im', text: 'no mention' }, config, 'events_api');
    assert.equal(d.process, true, 'a DM is self-authorizing and needs no mention');
});

test('mentionOnly requires a mention in channels but not DMs', () => {
    const config = baseConfig();
    assert.equal(
        shouldProcessSlackEvent({ type: 'message', channel: 'C1', text: 'plain' }, config, 'events_api').process,
        false,
    );
});

test('a channel message that mentions the bot is dropped — the app_mention envelope owns it', () => {
    // Slack delivers BOTH app_mention and message envelopes for one mention
    // when the app subscribes to both (shipped manifest). Processing both is
    // how one user message became two agent runs and a public "❌ duplicate".
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', text: 'hey <@UBOT> do it' },
        baseConfig(),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_via_app_mention' });
});

test('the mention drop also applies with mentionOnly off', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', text: 'hey <@UBOT> do it' },
        baseConfig({ mentionOnly: false }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_via_app_mention' });
});

test('a DM mentioning the bot is still processed — DMs never get app_mention envelopes', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'D999', channel_type: 'im', text: 'hey <@UBOT> do it' },
        baseConfig(),
        'events_api',
    );
    assert.equal(d.process, true);
});

test('plain channel messages still pass when mentionOnly is off', () => {
    assert.equal(
        shouldProcessSlackEvent({ type: 'message', channel: 'C1', text: 'plain chat' }, baseConfig({ mentionOnly: false }), 'events_api').process,
        true,
    );
});

test('attach guard is fail-closed until a non-empty port matches', () => {
    assert.equal(shouldAttachSlack(undefined, '24575'), false);
    assert.equal(shouldAttachSlack('', '24575'), false);
    assert.equal(shouldAttachSlack('3457', undefined), false);
    assert.equal(shouldAttachSlack('3457', '3457'), true);
    assert.equal(shouldAttachSlack('3457', '24575'), false, 'a second instance must not open the socket');
    assert.equal(shouldAttachSlack(3457, '3457'), true, 'number ports coerce');
    assert.equal(shouldAttachSlack(' 3457 ', '3457'), true);
});

test('app_mention envelopes satisfy mentionOnly by definition', () => {
    const d = shouldProcessSlackEvent({ type: 'app_mention', channel: 'C1', text: 'do it' }, baseConfig(), 'events_api');
    assert.equal(d.process, true);
});

test('an event with no text, blocks, or files is skipped', () => {
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'D1', channel_type: 'im' }, baseConfig(), 'events_api');
    assert.deepEqual(d, { process: false, reason: 'empty_event' });
});

test('isConversationAllowed shares one policy with the slash path', () => {
    assert.equal(isConversationAllowed('C999', ['C123'], true), true, 'DM always allowed');
    assert.equal(isConversationAllowed('C999', [], false), true, 'empty allowlist allows all');
    assert.equal(isConversationAllowed('C999', ['C123'], false), false);
    assert.equal(isConversationAllowed('C123', ['C123'], false), true);
});

test('isDirectMessage recognizes both signals', () => {
    assert.equal(isDirectMessage({ channel_type: 'im', channel: 'X' }), true);
    assert.equal(isDirectMessage({ channel: 'D123' }), true);
    assert.equal(isDirectMessage({ channel: 'C123' }), false);
});

// ─── text extraction ────────────────────────────────

test('stripMention removes the bot mention in both forms', () => {
    assert.equal(stripMention('<@UBOT> hello', 'UBOT'), 'hello');
    assert.equal(stripMention('<@UBOT|bot> hello', 'UBOT'), 'hello');
});

test('extractTextFromBlocks recovers content from nested Block Kit', () => {
    // A forwarded Block Kit message can have an EMPTY text field with all the
    // content in blocks; without this the agent receives an empty prompt.
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: 'outer' } },
        { type: 'context', elements: [{ type: 'plain_text', text: 'inner' }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: 'field-a' }] },
    ];
    const out = extractTextFromBlocks(blocks);
    for (const expected of ['outer', 'inner', 'field-a']) {
        assert.ok(out.includes(expected), `missing ${expected} in ${JSON.stringify(out)}`);
    }
});

test('extractTextFromBlocks survives a cyclic payload', () => {
    const node: Record<string, unknown> = { type: 'section', text: { type: 'mrkdwn', text: 'safe' } };
    node['blocks'] = [node];
    assert.doesNotThrow(() => extractTextFromBlocks([node]));
});

test('resolveEventText falls back to blocks and strips the mention', () => {
    assert.equal(resolveEventText({ text: '<@UBOT> run it' }, 'UBOT'), 'run it');
    assert.equal(
        resolveEventText({ text: '', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'from blocks' } }] }, 'UBOT'),
        'from blocks',
    );
});

// ─── activation: inbound reaches the shared agent pipeline ──

test('handleSlackEnvelope dispatches a DM into submitMessage with a slack target', { timeout: 5_000 }, async () => {
    // C-ACTIVATION-GROUNDING-01: this is the proof that the inbound path
    // actually reaches the agent pipeline rather than merely compiling.
    const { mock } = await import('node:test');
    const calls: Array<{ prompt: string; meta: Record<string, unknown> }> = [];
    const collected: string[] = [];

    mock.module('../../src/orchestrator/gateway.ts', {
        namedExports: {
            submitMessage: (prompt: string, meta: Record<string, unknown>) => {
                calls.push({ prompt, meta });
                return { action: 'started', disposition: 'new_run', requestId: `R${calls.length}` };
            },
        },
    });
    mock.module('../../src/orchestrator/collect.ts', {
        namedExports: {
            orchestrateAndCollect: async () => { throw new Error('inbound must use the data collector'); },
            orchestrateAndCollectData: async (prompt: string) => {
                collected.push(prompt);
                return { text: 'agent reply', data: {} };
            },
        },
    });
    mock.module('../../src/slack/send-only-client.ts', {
        namedExports: {
            getSlackSendClient: () => ({ token: 'xoxb-test' }),
            sendSlackText: async () => ({ ok: true }),
            resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
            invalidateSlackSendClient: () => { /* no-op */ },
        },
    });

    // Keep naming/context deterministic without letting invalid fixture tokens
    // reach users.info, conversation history, attachment recovery or reactions.
    const identity = await import('../../src/slack/identity.ts');
    mock.module('../../src/slack/identity.js', { namedExports: {
        ...identity,
        resolveSenderIdentity: async (event: { user?: string }) => ({
            id: event.user || '', name: event.user || '', kind: 'user', isBot: false, resolved: false,
        }),
    } });
    const conversation = await import('../../src/slack/conversation.ts');
    mock.module('../../src/slack/conversation.js', { namedExports: {
        ...conversation,
        resolveConversationInfo: async (_token: string, channel: string) => ({ id: channel, name: channel, kind: 'unknown', resolved: false }),
        resolveThreadInfo: async () => undefined,
        admitHistoryStart: () => false,
    } });
    const attachments = await import('../../src/slack/attachment-recovery.ts');
    mock.module('../../src/slack/attachment-recovery.js', { namedExports: {
        ...attachments, recoverSlackAttachments: async () => [],
    } });
    const api = await import('../../src/slack/api.ts');
    mock.module('../../src/slack/api.js', { namedExports: {
        ...api, addSlackReaction: async () => ({ ok: true }), removeSlackReaction: async () => ({ ok: true }),
    } });
    const progress = await import('../../src/slack/progress.ts');
    mock.module('../../src/slack/progress.js', { namedExports: {
        ...progress, startSlackProgress: async () => ({ update() {}, tool() {}, projectedTool() {}, phase() {}, finish: async () => {}, ready: async () => ({ mode: 'none', ts: null }), abort() {}, terminalConfirmed: () => false, ts: () => null }),
    } });
    const ingress = await import('../../src/slack/ingress.ts');
    const completed: Promise<void>[] = [];
    mock.module('../../src/slack/ingress.js', { namedExports: {
        ...ingress,
        admitSlackRun: (params: Parameters<typeof ingress.admitSlackRun>[0]) => {
            const result = ingress.admitSlackRun(params);
            if (result.laneTail) completed.push(result.laneTail);
            return result;
        },
        enqueueSlackIngress: (key: string, task: (signal: AbortSignal) => Promise<void>) => {
            const completion = Promise.withResolvers<void>();
            void completion.promise.catch(() => undefined); // preserve rejection for deliver() without an unhandled gap
            const accepted = ingress.enqueueSlackIngress(key, async signal => {
                try { await task(signal); completion.resolve(); }
                catch (error) { completion.reject(error); throw error; }
            });
            if (accepted) completed.push(completion.promise);
            return accepted;
        },
    } });

    const { handleSlackEnvelope } = await import('../../src/slack/bot.ts');
    async function deliver(envelope: SlackEnvelope) {
        await handleSlackEnvelope(envelope);
        while (completed.length) await Promise.all(completed.splice(0));
    }
    await deliver({
        envelope_id: 'A1',
        type: 'events_api',
        payload: {
            event: {
                type: 'message',
                channel: 'D1',
                channel_type: 'im',
                user: 'U9',
                text: 'run the thing',
                ts: '1735.0001',
            },
        },
    });
    assert.equal(calls.length, 1, `submitMessage called ${calls.length} times`);
    assert.equal(collected.length, 1, 'admitted run uses the mocked data collector, never a model');
    // The explicit unresolved identity fixture retains the raw sender id.
    assert.ok(calls[0]!.prompt.endsWith('run the thing'), calls[0]!.prompt);
    assert.equal(calls[0]!.meta['origin'], 'slack');
    const target = calls[0]!.meta['target'] as { channel?: string; targetId?: string; threadId?: string };
    assert.equal(target.channel, 'slack');
    assert.equal(target.targetId, 'D1');
    // A top-level message becomes the parent of a new thread.
    assert.equal(target.threadId, '1735.0001');

    // ── same mock, second claim: duplicate-delivery dedup ──
    // Slack sends a `message` copy AND an `app_mention` copy for one mention,
    // sharing a ts. The gate drops the message copy, so event dedup has to claim
    // the key AFTER the gate. Claiming earlier would let the discarded copy take
    // the key and suppress the canonical mention, and the mention would vanish
    // entirely (0 runs) — worse than the duplicate it was meant to stop.
    const { resetSlackEventDedup } = await import('../../src/slack/ingress.ts');
    resetSlackEventDedup();
    const runsBefore = calls.length;
    const SHARED_TS = '1799.5150';
    const mentionEvent = {
        type: 'app_mention', channel: 'C9', user: 'U9',
        text: '<@UBOT> do the thing', ts: SHARED_TS,
    };

    // Reverse order on purpose: the copy that gets REJECTED arrives first.
    await deliver({
        envelope_id: 'E1', type: 'events_api',
        payload: {
            event: {
                type: 'message', channel: 'C9', channel_type: 'channel',
                user: 'U9', text: '<@UBOT> do the thing', ts: SHARED_TS,
            },
        },
    });
    await deliver({ envelope_id: 'E2', type: 'events_api', payload: { event: mentionEvent } });
    assert.equal(calls.length - runsBefore, 1, 'the canonical mention must still run exactly once');

    // A Slack redelivery of the same ts must be absorbed.
    await deliver({ envelope_id: 'E3', type: 'events_api', payload: { event: mentionEvent } });
    assert.equal(calls.length - runsBefore, 1, 'a redelivery of the same ts must not run again');
    assert.equal(collected.length, 2, 'DM and canonical mention each produce exactly one mocked reply');
});

// The gate is the one place every settings path passes through: the route, the
// file watcher, direct runtime patches, and an agent editing settings.json by
// hand. A value it cannot parse must not hand out MORE access than one it can
// (#406).
test('readSlackAllowlist never widens on a malformed value', async () => {
    const { readSlackAllowlist, isConversationAllowed, MALFORMED_SLACK_ALLOWLIST } =
        await import('../../src/slack/events.js');

    // Absent means 'every conversation' — the shipped default.
    assert.deepEqual(readSlackAllowlist(undefined), []);
    assert.equal(isConversationAllowed('C1', readSlackAllowlist(undefined), false), true);

    // Malformed must DENY channels, not allow them all.
    // `null` and an all-blank list belong here, not with absence: the route
    // refuses to write either, so reading them as "every conversation" would be
    // a widening from a value nobody was allowed to set.
    for (const bad of ['C1', 42, null, { 0: 'C1' }, ['C1', 7], [''], ['   '], ['', '  ']]) {
        const ids = readSlackAllowlist(bad);
        assert.deepEqual(ids, [MALFORMED_SLACK_ALLOWLIST], `not parsed as a list: ${JSON.stringify(bad)}`);
        assert.equal(
            isConversationAllowed('C1', ids, false), false,
            'a value we cannot read must not allow every channel',
        );
        assert.equal(isConversationAllowed('D1', ids, true), true, 'DMs stay reachable');
    }

    // Padding matches nothing in Slack, so it is trimmed rather than kept verbatim.
    assert.deepEqual(readSlackAllowlist([' C1 ', 'C2']), ['C1', 'C2']);
    assert.equal(isConversationAllowed('C1', readSlackAllowlist([' C1 ']), false), true);

    // Duplicates would make doctor report allowlist_3 for two channels.
    assert.deepEqual(readSlackAllowlist(['C1', 'C1', 'C2']), ['C1', 'C2']);

    // Empty entries are dropped, not treated as a channel.
    assert.deepEqual(readSlackAllowlist(['C1', '', '   ']), ['C1']);

    // An explicitly empty list is the one way to say 'every conversation'.
    assert.deepEqual(readSlackAllowlist([]), []);
    assert.equal(isConversationAllowed('C1', readSlackAllowlist([]), false), true);
});


// preflight is the only consumer that sees an allowlist drop: the dispatch path
// never runs, so its log never fires. Without a line here the bot just goes
// quiet and nothing in the log says why (#406).
test('preflight logs the conversation the allowlist excluded', async () => {
    const { initIngressJournal } = await import('../../src/messaging/durable-ingress.ts');
    const { default: Database } = await import('better-sqlite3');
    const { settings } = await import('../../src/core/config.ts');
    const { log } = await import('../../src/core/logger.ts');

    // preflight returns before the gate when there is no journal (bot.ts).
    initIngressJournal(new Database(':memory:') as never);

    const prevSlack = settings.slack;
    const lines: string[] = [];
    const originalInfo = log.info;
    (log as { info: unknown }).info = (...args: unknown[]) => { lines.push(args.join(' ')); };

    try {
        settings.slack = { ...(prevSlack || {}), enabled: true, teamId: 'T1', channelIds: ['C_ALLOWED'] };
        const { preflightSlackEnvelope } = await import('../../src/slack/bot.ts');

        const verdict = await preflightSlackEnvelope({
            envelope_id: 'E-blocked',
            type: 'events_api',
            payload: { event: { type: 'message', channel: 'C_BLOCKED', ts: '10.1', user: 'U1', text: 'hi' } },
        } as never);

        assert.equal(verdict, 'ignored', 'an excluded conversation must not be journaled');
        assert.ok(
            lines.some(l => l.includes('[slack:gate]') && l.includes('C_BLOCKED')),
            `the drop must name the conversation; saw: ${JSON.stringify(lines)}`,
        );
    } finally {
        (log as { info: unknown }).info = originalInfo;
        settings.slack = prevSlack;
    }
});

// One reason logs, the rest do not. Self-echo and the app_mention twin are
// ordinary traffic on a working bot: logging them would bury the one line that
// says a human's setting excluded the conversation (#406).
test('preflight stays quiet for the drops that are normal traffic', async () => {
    const { initIngressJournal } = await import('../../src/messaging/durable-ingress.ts');
    const { default: Database } = await import('better-sqlite3');
    const { settings } = await import('../../src/core/config.ts');
    const { log } = await import('../../src/core/logger.ts');

    initIngressJournal(new Database(':memory:') as never);

    const prevSlack = settings.slack;
    const lines: string[] = [];
    const originalInfo = log.info;
    (log as { info: unknown }).info = (...args: unknown[]) => { lines.push(args.join(' ')); };

    // The gate reads a module-level selfUserId set at connect time, NOT
    // settings.slack.selfUserId. Writing it into settings looks right and tests
    // nothing: every event then falls to mention_required instead of reaching
    // the branch under test.
    const { setSlackSelfUserIdForTest, getSlackSelfUserId } = await import('../../src/slack/bot.ts');
    const prevSelf = getSlackSelfUserId();
    setSlackSelfUserIdForTest('U_SELF');

    try {
        settings.slack = { ...(prevSlack || {}), enabled: true, teamId: 'T1', channelIds: [] };
        const { preflightSlackEnvelope } = await import('../../src/slack/bot.ts');

        // Prove each event lands on the branch it is meant to exercise, or a
        // silent gate reads as a pass for the wrong reason.
        const { shouldProcessSlackEvent } = await import('../../src/slack/events.ts');
        const reasonFor = (event: Record<string, unknown>) => shouldProcessSlackEvent(
            event as never,
            { selfUserId: 'U_SELF', allowBots: false, mentionOnly: true, channelIds: [],
                threadRequireMention: false, threadParticipation: 'mention' } as never,
            'events_api',
        ).reason;

        const selfEvent = { type: 'message', channel: 'C_OPEN', ts: '20.1', user: 'U_SELF', text: 'mine' };
        const twinEvent = { type: 'message', channel: 'C_OPEN', ts: '20.2', user: 'U1', text: '<@U_SELF> hi' };
        const botEvent = { type: 'message', channel: 'C_OPEN', ts: '20.3', bot_id: 'B1', text: 'beep' };
        assert.equal(reasonFor(selfEvent), 'self_message');
        assert.equal(reasonFor(twinEvent), 'mention_via_app_mention');
        assert.equal(reasonFor(botEvent), 'bot_message');

        // self_message: our own post arriving back as a message event.
        // mention_via_app_mention: the message copy of a mention that also
        // arrives as app_mention.
        // bot_message: frequent on bot_profile traffic.
        for (const [id, event] of [['E-self', selfEvent], ['E-twin', twinEvent], ['E-bot', botEvent]] as const) {
            const verdict = await preflightSlackEnvelope({
                envelope_id: id, type: 'events_api', payload: { event },
            } as never);
            assert.equal(verdict, 'ignored', `${id} must be dropped by the gate`);
        }

        assert.deepEqual(
            lines.filter(l => l.includes('[slack:gate]')), [],
            `only an allowlist drop may log; saw: ${JSON.stringify(lines)}`,
        );
    } finally {
        setSlackSelfUserIdForTest(prevSelf);
        (log as { info: unknown }).info = originalInfo;
        settings.slack = prevSlack;
    }
});
