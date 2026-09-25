import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { publish, subscribe, type BusEvent } from '../../src/core/event-bus.ts';
import {
    startWorkerEventBridge, stopWorkerEventBridge, getCachedLatestMessage,
} from '../../src/manager/worker-events.ts';
import type { InstanceDiff } from '../../src/manager/instance-registry.ts';

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    readyState = 0;
    closed = false;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }
    close(): void { this.closed = true; this.readyState = 2; }
    emit(payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function diff(d: InstanceDiff): void {
    publish('worker', 'instance-status-changed', { ...d } as unknown as Record<string, unknown>);
}

// Not a Slack stub: this one answers the Manager's own /api/events hydration
// over `json()`. tests/helpers/slack-fetch.mts is the Slack contract; the name
// stays distinct so the two are not mistaken for the same harness.
function makeEventsFetch(latest: Record<string, unknown> | null) {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
        calls.push(url);
        return { ok: true, json: async () => ({ ok: true, data: latest }) };
    };
    return { calls, fetchImpl };
}

function freshBridge(latest: Record<string, unknown> | null, opts: { reconnectBaseMs?: number; reconnectMaxMs?: number } = {}) {
    stopWorkerEventBridge();
    FakeEventSource.instances = [];
    const { calls, fetchImpl } = makeEventsFetch(latest);
    startWorkerEventBridge({
        fetchImpl: fetchImpl as never,
        EventSourceImpl: FakeEventSource as never,
        debounceMs: 1,
        ...opts,
    });
    return { calls };
}

test('appeared-online diff opens a worker SSE stream and hydrates the cache', async () => {
    const { calls } = freshBridge({ latestAssistant: { id: 7, text: 'hello' }, activity: null });
    diff({ port: 3457, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0]!.url, 'http://127.0.0.1:3457/api/events');
    await sleep(30);
    assert.equal(calls.length, 1, 'one hydration prefetch');
    const cached = getCachedLatestMessage(3457);
    assert.ok(cached && cached.latestAssistant?.id === 7);
    stopWorkerEventBridge();
});

test('message events debounce into a single prefetch; disappeared invalidates', async () => {
    const { calls } = freshBridge({ latestAssistant: { id: 9, text: 'x' }, activity: null });
    diff({ port: 3460, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    const es = FakeEventSource.instances[0]!;
    await sleep(30); // hydration
    es.emit({ topic: 'message', event: 'new_message' });
    es.emit({ topic: 'agent', event: 'agent_done' });
    es.emit({ topic: 'message', event: 'new_message' });
    await sleep(30);
    assert.equal(calls.length, 2, 'hydration + one debounced prefetch for three events');
    diff({ port: 3460, change: 'disappeared', prev: { status: 'online', version: '2.2.0' } });
    assert.equal(getCachedLatestMessage(3460), undefined, 'cache invalidated');
    assert.equal(es.closed, true);
    stopWorkerEventBridge();
});

test('unsupported worker is re-probed only when it restarts (status/version diff)', async () => {
    freshBridge(null);
    diff({ port: 3458, change: 'appeared', next: { status: 'online', version: '2.1.3' } });
    const es = FakeEventSource.instances[0]!;
    es.onerror?.({ code: 404 }); // legacy worker — marked unsupported
    assert.equal(es.closed, true);

    // A stable legacy worker emits no diffs → zero retries while it runs.
    assert.equal(FakeEventSource.instances.length, 1, 'no retry without a diff');

    // The realistic upgrade flow surfaces as status diffs (offline rows carry
    // version:null, so computeDiffs swallows the version change) — coming back
    // online must clear the mark and re-probe once.
    diff({ port: 3458, change: 'status', prev: { status: 'online', version: '2.1.3' }, next: { status: 'offline', version: null } });
    diff({ port: 3458, change: 'status', prev: { status: 'offline', version: null }, next: { status: 'online', version: '2.2.0' } });
    assert.equal(FakeEventSource.instances.length, 2, 'restart (offline→online) re-probes once');

    FakeEventSource.instances[1]!.onerror?.({ code: 404 });
    diff({ port: 3458, change: 'version', prev: { status: 'online', version: '2.2.0' }, next: { status: 'online', version: '2.3.0' } });
    assert.equal(FakeEventSource.instances.length, 3, 'version diff also clears the mark and resubscribes');
    stopWorkerEventBridge();
});

test('getCachedLatestMessage returns undefined without a live stream', async () => {
    freshBridge({ latestAssistant: { id: 1, text: 'y' }, activity: null });
    assert.equal(getCachedLatestMessage(3470), undefined);
    diff({ port: 3470, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    await sleep(30);
    assert.ok(getCachedLatestMessage(3470));
    diff({ port: 3470, change: 'status', prev: { status: 'online', version: '2.2.0' }, next: { status: 'offline', version: '2.2.0' } });
    assert.equal(getCachedLatestMessage(3470), undefined, 'offline drops the stream and cache');
    stopWorkerEventBridge();
});

test('settings_change from a worker republishes as worker_settings_change (#233)', async () => {
    freshBridge(null);
    diff({ port: 3463, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    const es = FakeEventSource.instances[0]!;
    const seen: BusEvent[] = [];
    const unsub = subscribe((entry) => {
        if (entry.topic === 'worker' && entry.event === 'worker_settings_change') seen.push(entry);
    });
    es.emit({ topic: 'settings', event: 'settings_change', changedKeys: ['projectDirs'], projectDirs: ['/tmp/x'] });
    unsub();
    assert.equal(seen.length, 1, 'one relay publish per worker settings_change');
    assert.equal(seen[0]!.data["port"], 3463);
    assert.deepEqual(seen[0]!.data["changedKeys"], ['projectDirs']);
    stopWorkerEventBridge();
});

test('stopWorkerEventBridge closes every stream and clears state', async () => {
    freshBridge(null);
    diff({ port: 3461, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    diff({ port: 3462, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    assert.equal(FakeEventSource.instances.length, 2);
    stopWorkerEventBridge();
    assert.ok(FakeEventSource.instances.every(i => i.closed));
    assert.equal(getCachedLatestMessage(3461), undefined);
});

// #791: a terminal transient failure (eventsource@3 goes CLOSED on any non-2xx,
// e.g. the /api/events capacity 503) used to leave a stable-online worker
// unwatched forever — no diff would ever arrive to re-trigger connect().
test('terminal disconnect on a stable-online worker schedules exactly one bounded-backoff reconnect', async (context: TestContext) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    context.after(() => { stopWorkerEventBridge(); context.mock.timers.reset(); });
    freshBridge(null, { reconnectBaseMs: 100, reconnectMaxMs: 400 });
    diff({ port: 3471, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    assert.equal(FakeEventSource.instances.length, 1);

    const es1 = FakeEventSource.instances[0]!;
    es1.readyState = 2; // terminal CLOSED — no internal retry coming
    es1.onerror?.({ code: 503 });
    assert.equal(es1.closed, true);

    context.mock.timers.tick(99);
    assert.equal(FakeEventSource.instances.length, 1, 'no reconnect before the backoff elapses');
    context.mock.timers.tick(1);
    assert.equal(FakeEventSource.instances.length, 2, 'latest snapshot is online → one reconnect');

    context.mock.timers.tick(10_000);
    assert.equal(FakeEventSource.instances.length, 2, 'healthy replacement — no retry loop');

    // A further terminal failure reschedules with a grown (but capped) delay.
    const es2 = FakeEventSource.instances[1]!;
    es2.readyState = 2;
    es2.onerror?.({ code: 503 });
    context.mock.timers.tick(199);
    assert.equal(FakeEventSource.instances.length, 2, 'backoff doubled: 200ms not 100ms');
    context.mock.timers.tick(1);
    assert.equal(FakeEventSource.instances.length, 3);
});

test('a pending reconnect is cancelled when the worker flaps offline or disappears', async (context: TestContext) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    context.after(() => { stopWorkerEventBridge(); context.mock.timers.reset(); });
    freshBridge(null, { reconnectBaseMs: 100, reconnectMaxMs: 400 });
    diff({ port: 3472, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    diff({ port: 3473, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    for (const es of FakeEventSource.instances) {
        es.readyState = 2;
        es.onerror?.({ code: 503 });
    }
    diff({ port: 3472, change: 'status', prev: { status: 'online', version: '2.2.0' }, next: { status: 'offline', version: '2.2.0' } });
    diff({ port: 3473, change: 'disappeared', prev: { status: 'online', version: '2.2.0' } });
    context.mock.timers.tick(10_000);
    assert.equal(FakeEventSource.instances.length, 2, 'snapshot offline/gone before the delay → no reconnect');
});

test('a stale reconnect timer is generation-fenced and cannot replace a newer connection', async (context: TestContext) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    context.after(() => { stopWorkerEventBridge(); context.mock.timers.reset(); });
    freshBridge(null, { reconnectBaseMs: 100, reconnectMaxMs: 400 });
    diff({ port: 3474, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    const es1 = FakeEventSource.instances[0]!;
    es1.readyState = 2;
    es1.onerror?.({ code: 503 }); // retry armed on generation 1

    // A successor connection is established before the stale timer fires.
    diff({ port: 3474, change: 'appeared', next: { status: 'online', version: '2.2.0' } });
    assert.equal(FakeEventSource.instances.length, 2);
    const es2 = FakeEventSource.instances[1]!;

    context.mock.timers.tick(10_000);
    assert.equal(FakeEventSource.instances.length, 2, 'stale timer fired but created nothing');
    assert.equal(es2.closed, false, 'successor connection untouched');
});
