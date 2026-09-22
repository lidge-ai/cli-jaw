import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadLocales } from '../../src/core/i18n.ts';
import { startSlackProgress } from '../../src/slack/progress.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import { __resetMessagingMetricsForTests, snapshotMetrics } from '../../src/messaging/metrics.ts';
loadLocales(fileURLToPath(new URL('../../public/locales', import.meta.url)));

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
class Clock {
    time = Date.now();
    nextId = 0;
    timers = new Map<number, { at: number; fn: () => void }>();
    now = () => this.time;
    setTimer = ((fn: () => void, ms = 0) => {
        const id = ++this.nextId;
        this.timers.set(id, { at: this.time + ms, fn });
        return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    clearTimer = ((handle: { id: number }) => { this.timers.delete(handle.id); }) as unknown as typeof clearTimeout;
    async advance(ms: number) {
        const end = this.time + ms;
        await settle();
        let count = 0;
        while (true) {
            const next = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(++count < 1000, 'timer loop must make progress');
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].fn();
            await settle();
        }
        this.time = end;
        await settle();
    }
}
type Call = { method: string; body: Record<string, unknown>; at: number; signal?: AbortSignal | null };
type Reply = { payload: Record<string, unknown>; status?: number; retryAfter?: string };
let credentialSeq = 0;
function harness(route?: (call: Call) => Reply | Promise<Reply>, clock = new Clock()) {
    const calls: Call[] = [];
    const token = `fake-progress-${++credentialSeq}`;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const call = { method: String(url).split('/').at(-1)!, body: JSON.parse(String(init?.body)),
            at: clock.time, signal: init?.signal };
        calls.push(call);
        const result = route ? await route(call) : { payload: { ok: true, ts: `111.${calls.length}` } };
        return new Response(JSON.stringify(result.payload), { status: result.status ?? 200,
            headers: result.retryAfter ? { 'retry-after': result.retryAfter } : {} });
    }) as typeof fetch;
    return { calls, clock, token, options: { fetchImpl, draftClock: clock, locale: 'en' } };
}
const target: RemoteTarget = { channel: 'slack', targetKind: 'channel', peerKind: 'direct', targetId: 'D_TEST', threadId: '100.1' };
const tool = (id: string, status = 'running') => ({ label: 'Read', detail: 'DO_NOT_EXPOSE /private/file',
    traceRunId: 'trace-test', stepRef: id, status, toolType: 'tool' });
const ok = (): Reply => ({ payload: { ok: true, ts: '111.222' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

// Original placeholder tests are replaced by these stream/fallback behavioral
// tests because the feature now intentionally retains a terminal status message.
test('native stream uses safe task chunks and one retained message through body delivery', async () => {
    const h = harness();
    const p = await startSlackProgress(h.token, target, 'RAW_INITIAL_TOKEN', h.options);
    assert.equal((await p.ready()).mode, 'native');
    p.tool(tool('private-step'));
    p.tool(tool('private-step', 'done'));
    await h.clock.advance(0);
    p.phase('delivering');
    await h.clock.advance(3200);
    await p.finish('complete', { bodyDelivered: true });
    assert.equal(p.terminalConfirmed(), true);
    assert.equal(h.calls[0]?.body['task_display_mode'], 'plan');
    assert.equal(h.calls.filter(c => c.method === 'chat.startStream').length, 1);
    assert.equal(h.calls.at(-1)?.method, 'chat.stopStream');
    assert.ok(h.calls.some(c => c.method === 'chat.appendStream'));
    assert.ok(!h.calls.some(c => ['chat.postMessage', 'chat.delete'].includes(c.method)));
    assert.doesNotMatch(JSON.stringify(h.calls.map(c => c.body)), /DO_NOT_EXPOSE|private|RAW_INITIAL|trace-test/);
    const final = h.calls.at(-1)?.body['chunks'] as Array<Record<string, unknown>>;
    assert.equal(final.find(c => c['id'] === 'delivery')?.['status'], 'complete');
    await h.clock.advance(60000);
    assert.equal(h.clock.timers.size, 0);
});

test('startup resolves a usable handle before HTTP and a late ts receives only terminal state', async () => {
    const gate = deferred<Reply>();
    const order: string[] = [];
    const h = harness(c => c.method === 'chat.startStream' ? gate.promise : (order.push(c.method), ok()));
    const p = await startSlackProgress(h.token, target, '', { ...h.options, onPosted: () => order.push('posted') });
    let ready = false;
    void p.ready().then(() => { ready = true; });
    await settle();
    assert.equal(ready, false);
    p.tool(tool('one'));
    const finished = p.finish('cancelled');
    assert.equal(p.finish('complete'), finished, 'first terminal promise wins');
    p.tool(tool('late'));
    gate.resolve(ok());
    await finished;
    assert.deepEqual(h.calls.map(c => c.method), ['chat.startStream', 'chat.stopStream']);
    assert.deepEqual(order, ['posted', 'chat.stopStream']);
    assert.equal(p.terminalConfirmed(), true);
});

for (const error of ['unknown_method', 'method_not_supported_for_channel_type', 'channel_type_not_supported']) {
    test(`explicit ${error} falls back once and updates the same retained message`, async () => {
        const h = harness(c => c.method === 'chat.startStream' ? { payload: { ok: false, error } } : ok());
        const p = await startSlackProgress(h.token, target, '', h.options);
        assert.equal((await p.ready()).mode, 'fallback');
        p.tool(tool('one'));
        await h.clock.advance(0);
        const finished = p.finish('error');
        await h.clock.advance(5000);
        await finished;
        assert.equal(h.calls.filter(c => c.method === 'chat.postMessage').length, 1);
        assert.ok(h.calls.filter(c => c.method === 'chat.update').every(c => c.body['ts'] === '111.222'));
        assert.ok(!h.calls.some(c => c.method === 'chat.delete'));
    });
}
for (const error of ['invalid_chunks', 'invalid_auth', 'missing_scope', 'internal_error']) {
    test(`${error} never masquerades as unsupported capability`, async () => {
        const h = harness(() => ({ payload: { ok: false, error } }));
        const p = await startSlackProgress(h.token, target, '', h.options);
        const ready = await p.ready();
        assert.equal(ready.mode, error === 'internal_error' ? 'ambiguous' : 'none');
        await p.finish();
        assert.deepEqual(h.calls.map(c => c.method), ['chat.startStream']);
    });
}

test('a timed-out start aborts even an ignoring fetch and never posts a replacement', async () => {
    const late = deferred<Reply>();
    const h = harness(() => late.promise);
    let posted = 0;
    const p = await startSlackProgress(h.token, target, '', { ...h.options, onPosted: () => posted++ });
    await h.clock.advance(5000);
    assert.equal((await p.ready()).mode, 'ambiguous');
    assert.equal(h.calls[0]?.signal?.aborted, true);
    await p.finish();
    late.resolve(ok());
    await settle();
    assert.equal(posted, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(p.terminalConfirmed(), false);
    assert.equal(h.clock.timers.size, 0);
});

test('burst events coalesce; duplicate events do not manufacture fresh work', async () => {
    const h = harness();
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    for (const id of ['one', 'two', 'three']) p.tool(tool(id));
    await h.clock.advance(0);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    p.tool(tool('three'));
    await h.clock.advance(3200);
    const updates = h.calls.filter(c => c.method === 'chat.appendStream');
    assert.equal(updates.length, 4, 'heartbeat continues while duplicate tool input stays inert');
    assert.match(JSON.stringify(updates.at(-1)?.body), /Last activity: 3s ago/);
    assert.ok(updates.slice(1).every(call => !(call.body.chunks as Array<Record<string, unknown>>).some(chunk => String(chunk.id).startsWith('recent-'))));
    await p.finish();
});

test('quiet time produces measured waiting updates without a fabricated percentage', async () => {
    const h = harness();
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    await h.clock.advance(20000);
    const body = JSON.stringify(h.calls.at(-1)?.body);
    assert.match(body, /20/);
    assert.doesNotMatch(body, /\d+%/);
    assert.equal(h.calls.at(-1)?.method, 'chat.appendStream');
    await p.finish('expired');
});

test('Retry-After applies to another handle with the same credential and method', async () => {
    const clock = new Clock();
    let throttled = false;
    const h = harness(c => {
        if (c.method === 'chat.appendStream' && !throttled) {
            throttled = true; return { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '20' };
        }
        return ok();
    }, clock);
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, target, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    a.tool(tool('a'));
    await clock.advance(0);
    const firstAt = h.calls.find(c => c.method === 'chat.appendStream')!.at;
    b.tool(tool('b'));
    await clock.advance(19999);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    const independent = harness(undefined, clock);
    const other = await startSlackProgress(independent.token, target, '', independent.options);
    await other.ready(); other.tool(tool('other')); await clock.advance(0);
    assert.equal(independent.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    await clock.advance(1);
    assert.ok(h.calls.filter(c => c.method === 'chat.appendStream').slice(1).every(c => c.at >= firstAt + 20000));
    assert.ok(h.calls.filter(c => c.method === 'chat.appendStream').length >= 2);
    await Promise.all([a.finish(), b.finish(), other.finish()]);
    assert.equal(clock.timers.size, 0);
});

test('a shared startup embargo exceeding budget is not bypassed or retried', async () => {
    const h = harness(() => ({ payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '3600' }));
    const a = await startSlackProgress(h.token, target, '', h.options);
    assert.equal((await a.ready()).mode, 'none');
    const b = await startSlackProgress(h.token, target, '', h.options);
    assert.equal((await b.ready()).mode, 'none');
    assert.equal(h.calls.length, 1);
    await Promise.all([a.finish(), b.finish()]);
    await h.clock.advance(3600000);
});

test('finish joins in-flight append and excludes every later working update', async () => {
    const gate = deferred<Reply>();
    const h = harness(c => c.method === 'chat.appendStream' ? gate.promise : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); p.tool(tool('one')); await h.clock.advance(0);
    const done = p.finish('error');
    p.tool(tool('late')); p.phase('running'); p.update('private late command');
    gate.resolve(ok()); await done;
    assert.deepEqual(h.calls.map(c => c.method), ['chat.startStream', 'chat.appendStream', 'chat.stopStream']);
    await h.clock.advance(30000);
    assert.equal(h.calls.length, 3);
});

test('failed terminal update remains unconfirmed and preserves the known timestamp', async () => {
    const h = harness(c => c.method === 'chat.stopStream' ? { payload: { ok: false, error: 'internal_error' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); await p.finish();
    assert.equal(p.terminalConfirmed(), false);
    assert.equal(p.ts(), '111.222');
    assert.equal(h.calls.filter(c => c.method === 'chat.startStream').length, 1);
});

test('parent abort seals IO and subsequent finish does not create another message', async () => {
    const gate = deferred<Reply>();
    const h = harness(() => gate.promise);
    const parent = new AbortController();
    const p = await startSlackProgress(h.token, target, '', { ...h.options, signal: parent.signal });
    parent.abort(); await settle();
    assert.equal(h.calls[0]?.signal?.aborted, true);
    await p.finish('cancelled');
    gate.resolve(ok()); await h.clock.advance(60000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.clock.timers.size, 0);
});

test('channel recipient metadata is captured and missing context is inert', async () => {
    const h = harness();
    const channel = { ...target, targetId: 'C_TEST', peerKind: 'channel' as const, guildId: 'T_TEST' };
    const p = await startSlackProgress(h.token, channel, '', { ...h.options, recipientUserId: 'U_TEST' });
    channel.targetId = 'C_OTHER';
    await p.ready(); await p.finish();
    assert.equal(h.calls[0]?.body['recipient_user_id'], 'U_TEST');
    assert.equal(h.calls[0]?.body['recipient_team_id'], 'T_TEST');
    assert.ok(h.calls.every(c => c.body['channel'] === 'C_TEST'));
    for (const invalid of [{ ...target, threadId: undefined }, { ...channel, guildId: undefined }]) {
        const bad = harness();
        const inert = await startSlackProgress(bad.token, invalid as RemoteTarget, '', bad.options);
        assert.equal((await inert.ready()).mode, 'none'); await inert.finish();
        assert.equal(bad.calls.length, 0);
    }
});

test('server-ended stream disables future appends without fabricating runtime cancellation', async () => {
    const h = harness(c => c.method === 'chat.appendStream' ? { payload: { ok: false, error: 'stopped_by_user' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); p.tool(tool('one')); await h.clock.advance(0);
    p.tool(tool('two')); await h.clock.advance(60000);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    await p.finish('complete', { bodyDelivered: true });
});

test('a stream closed after five minutes continues editing its own status through a long job', async () => {
    const h = harness(c => c.method === 'chat.appendStream' && c.at - h.calls[0]!.at >= 300000
        ? { payload: { ok: false, error: 'message_not_in_streaming_state' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    for (let minute = 0; minute < 19; minute++) await h.clock.advance(60000);
    const updates = h.calls.filter(c => c.method === 'chat.update');
    assert.ok(updates.length > 0);
    assert.match(String(updates.at(-1)!.body['text']), /Elapsed: 11\d\ds/);
    assert.ok(updates.every(c => c.body['ts'] === '111.222'));
    assert.equal(h.calls.filter(c => c.method === 'chat.startStream').length, 1);
    assert.equal(h.calls.filter(c => c.method === 'chat.postMessage').length, 0);
    assert.equal(h.calls.filter(c => c.method === 'chat.stopStream').length, 0, 'live job was not finalized');
    const finished = p.finish('complete', { bodyDelivered: true });
    await h.clock.advance(5000);
    await finished;
    assert.equal(p.terminalConfirmed(), true);
    assert.match(String(h.calls.at(-1)!.body['text']), /Answer delivered/);
    assert.equal(h.clock.timers.size, 0);
});

test('SPS-744: an expired stream whose message is gone stops instead of retrying forever', async () => {
    __resetMessagingMetricsForTests();
    // The live incident: the stream expired, the card fell back to chat.update,
    // and the message was no longer there. Nothing promoted that to "stop", so
    // the idle loop re-dirtied the snapshot every 3.2s and sent the same doomed
    // update 47 times across two and a half minutes (#744).
    const h = harness(c => c.method === 'chat.appendStream'
        ? { payload: { ok: false, error: 'message_not_in_streaming_state' } }
        : c.method === 'chat.update'
            ? { payload: { ok: false, error: 'message_not_found' } }
            : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    await h.clock.advance(60000);
    const afterFirstMinute = h.calls.filter(c => c.method === 'chat.update').length;
    assert.equal(afterFirstMinute, 1, 'one edit discovers the message is gone');

    for (let minute = 0; minute < 5; minute++) await h.clock.advance(60000);
    assert.equal(h.calls.filter(c => c.method === 'chat.update').length, afterFirstMinute,
        'a gone message is never edited again');
    assert.equal(h.calls.filter(c => c.method === 'chat.postMessage').length, 0,
        'a dead card is not replaced by a second one');
    assert.equal(h.clock.timers.size, 0, 'the idle loop is stopped, not merely skipped');

    const before = h.calls.length;
    await p.finish('complete', { bodyDelivered: true });
    assert.equal(h.calls.length, before, 'finalizing spends no request on a message known to be gone');
    assert.equal(p.terminalConfirmed(), true);
    assert.deepEqual(snapshotMetrics().counters.filter(row =>
        row.name === 'slack.progress.stream_state_lost'), [{
        name: 'slack.progress.stream_state_lost',
        labels: { channel: 'slack', result: 'message_not_found' },
        value: 1,
    }], 'one lost card produces one metric, not one per idle tick');
});

test('SPS-744: three consecutive failed edits stop the live loop', async () => {
    // Not every failure names itself. A transport rejecting the same request over
    // and over is the same storm wearing a different error string.
    const h = harness(c => c.method === 'chat.appendStream' || c.method === 'chat.update'
        ? { payload: { ok: false, error: 'internal_error' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    for (let minute = 0; minute < 5; minute++) await h.clock.advance(60000);
    const attempts = h.calls.filter(c => c.method === 'chat.appendStream' || c.method === 'chat.update').length;
    assert.ok(attempts <= 3, `live edits bounded, saw ${attempts}`);
    assert.equal(h.clock.timers.size, 0);
    await p.finish('complete', { bodyDelivered: true });
});

test('stream closure first discovered at finalization updates the same message once', async () => {
    const h = harness(c => c.method === 'chat.stopStream'
        ? { payload: { ok: false, error: 'message_not_in_streaming_state' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); await p.finish('complete', { bodyDelivered: true });
    assert.deepEqual(h.calls.map(c => c.method), ['chat.startStream', 'chat.stopStream', 'chat.update']);
    assert.equal(h.calls[2]!.body['ts'], '111.222');
    assert.equal(p.terminalConfirmed(), true);
});

test('cancellation during an expiring append cannot resurrect a fallback card', async () => {
    const gate = deferred<Reply>();
    const h = harness(c => c.method === 'chat.appendStream' ? gate.promise : ok());
    const controller = new AbortController();
    const p = await startSlackProgress(h.token, target, '', { ...h.options, signal: controller.signal });
    await p.ready(); await h.clock.advance(1000);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    controller.abort();
    gate.resolve({ payload: { ok: false, error: 'message_not_in_streaming_state' } });
    await p.finish('cancelled'); await h.clock.advance(60000);
    assert.equal(h.calls.filter(c => c.method === 'chat.update').length, 0);
    assert.equal(h.calls.filter(c => c.method === 'chat.startStream').length, 1);
    assert.equal(h.calls.filter(c => c.method === 'chat.postMessage').length, 0);
    assert.equal(h.clock.timers.size, 0);
});

test('an unsuccessful closed-stream final edit remains unconfirmed without reposting', async () => {
    const h = harness(c => c.method === 'chat.stopStream'
        ? { payload: { ok: false, error: 'message_not_in_streaming_state' } }
        : c.method === 'chat.update' ? { payload: { ok: false, error: 'cant_update_message' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); await p.finish('complete', { bodyDelivered: true });
    assert.equal(p.terminalConfirmed(), false);
    assert.deepEqual(h.calls.map(c => c.method), ['chat.startStream', 'chat.stopStream', 'chat.update']);
});

test('the finish deadline aborts an unresponsive terminal request and keeps its receipt unconfirmed', async () => {
    const gate = deferred<Reply>();
    const h = harness(c => c.method === 'chat.stopStream' ? gate.promise : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    const done = p.finish('complete', { bodyDelivered: true });
    await settle();
    await h.clock.advance(5000);
    await done;
    assert.equal(h.calls.at(-1)?.signal?.aborted, true);
    assert.equal(p.terminalConfirmed(), false);
    assert.equal(p.ts(), '111.222');
    gate.resolve(ok()); await settle();
    assert.equal(p.terminalConfirmed(), false, 'late network success cannot fabricate confirmation');
    assert.equal(h.clock.timers.size, 0);
});

test('a stop Retry-After embargo is shared and cannot be violated by another finishing handle', async () => {
    const h = harness(c => c.method === 'chat.stopStream'
        ? { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '20' } : ok());
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, target, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    await a.finish(); await b.finish();
    assert.equal(h.calls.filter(c => c.method === 'chat.stopStream').length, 1);
    assert.equal(a.terminalConfirmed(), false);
    assert.equal(b.terminalConfirmed(), false);
    assert.equal(h.clock.timers.size, 0);
});

test('rate-limit key overflow fails conservatively instead of dropping active embargoes', async () => {
    const clock = new Clock();
    let attempts = 0;
    for (let i = 0; i < 150; i++) {
        const h = harness(() => {
            attempts++;
            return { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '60' };
        }, clock);
        const p = await startSlackProgress(h.token, target, '', h.options);
        assert.equal((await p.ready()).mode, 'none');
        await p.finish();
    }
    assert.ok(attempts <= 129, 'overflow must not admit unlimited new credential buckets');
    await clock.advance(60001);
    const h = harness(undefined, clock);
    const p = await startSlackProgress(h.token, target, '', h.options);
    assert.equal((await p.ready()).mode, 'native', 'expired global restriction must be released');
    await p.finish();
});

test('an explicitly rate-limited update keeps the latest snapshot pending until Retry-After', async () => {
    let rejected = false;
    const h = harness(c => {
        if (c.method === 'chat.appendStream' && !rejected) {
            rejected = true; return { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '4' };
        }
        return ok();
    });
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); p.tool(tool('one')); await h.clock.advance(0);
    await h.clock.advance(3999);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.filter(c => c.method === 'chat.appendStream').length, 2);
    assert.match(JSON.stringify(h.calls.at(-1)?.body), /Read/);
    await p.finish();
});

test('append-only Slack task details cannot accumulate repeated snapshots; recent cards stay bounded', async () => {
    const tasks = new Map<string, Record<string, unknown>>();
    const h = harness(c => {
        for (const chunk of (c.body['chunks'] ?? []) as Array<Record<string, unknown>>) {
            if (chunk['type'] !== 'task_update') continue;
            const id = String(chunk['id']);
            const old = tasks.get(id) ?? {};
            // Observed Slack persistence semantics: details append, titles/status replace.
            tasks.set(id, { ...old, ...chunk, ...(typeof chunk['details'] === 'string'
                ? { details: String(old['details'] ?? '') + chunk['details'] } : {}) });
        }
        return ok();
    });
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    for (let i = 0; i < 25; i++) {
        p.tool(tool(String(i), 'done'));
        await h.clock.advance(3200);
    }
    p.phase('delivering');
    await p.finish('complete', { bodyDelivered: true });
    assert.equal(tasks.size, 8, 'one summary, six recent observations and one delivery card');
    assert.ok([...tasks.values()].every(row => !Object.hasOwn(row, 'details')), 'append-only detail field is not a snapshot channel');
    for (let i = 0; i < 6; i++) assert.match(String(tasks.get(`recent-${i}`)?.['title']), /Read.*Done/);
    assert.ok(JSON.stringify([...tasks.values()]).length < 2500, 'persisted surface stays bounded across many updates');
});

test('parent cancellation alone seals a started handle without requiring finish', async () => {
    const h = harness();
    const parent = new AbortController();
    const p = await startSlackProgress(h.token, target, '', { ...h.options, signal: parent.signal });
    await p.ready(); await h.clock.advance(0);
    try {
        parent.abort(); await settle();
        assert.equal(h.clock.timers.size, 0, 'parent abort must remove the idle scheduler itself');
        p.tool(tool('after-parent-abort'));
        await h.clock.advance(60000);
        assert.equal(h.clock.timers.size, 0);
        assert.equal(h.calls.length, 1);
        assert.equal(p.terminalConfirmed(), false);
    } finally { p.abort(); }
});

test('elapsed seconds advance every second without tool events and do not invent activity', async () => {
    const h = harness();
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready();
    await h.clock.advance(5000);
    const updates = h.calls.filter(call => call.method === 'chat.appendStream');
    assert.deepEqual(updates.map(call => call.at - h.calls[0]!.at), [1000, 2000, 3000, 4000, 5000]);
    for (let i = 0; i < updates.length; i++) {
        const chunks = updates[i]!.body.chunks as Array<Record<string, unknown>>;
        assert.match(String(chunks.find(chunk => chunk.id === 'work')?.title), new RegExp(`Elapsed: ${i + 1}s`));
        assert.match(String(chunks.find(chunk => chunk.id === 'work')?.title), new RegExp(`Last activity: ${i + 1}s ago`));
    }
    await p.finish();
    const count = h.calls.length;
    await h.clock.advance(10000);
    assert.equal(h.calls.length, count);
    assert.equal(h.clock.timers.size, 0);
});

test('heartbeat appends only changed cards after the tool card is already confirmed', async () => {
    const h = harness();
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); p.tool(tool('read-once'));
    await h.clock.advance(0);
    await h.clock.advance(1000);
    const update = h.calls.filter(call => call.method === 'chat.appendStream').at(-1)!;
    const chunks = update.body.chunks as Array<Record<string, unknown>>;
    assert.ok(chunks.some(chunk => chunk.id === 'work'));
    assert.ok(!chunks.some(chunk => String(chunk.id).startsWith('recent-')), 'unchanged file card should not be re-sent each second');
    await p.finish();
});

test('slow append coalesces elapsed ticks without a catch-up burst or overlapping requests', async () => {
    const gate = deferred<Reply>(); let appends = 0;
    const h = harness(call => call.method === 'chat.appendStream' && ++appends === 1 ? gate.promise : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); await h.clock.advance(1000);
    await h.clock.advance(2500);
    assert.equal(h.calls.filter(call => call.method === 'chat.appendStream').length, 1);
    gate.resolve(ok()); await settle(); await h.clock.advance(0);
    const updates = h.calls.filter(call => call.method === 'chat.appendStream');
    assert.equal(updates.length, 2);
    assert.match(JSON.stringify(updates.at(-1)!.body), /Elapsed: 3s/);
    await p.finish();
});

test('concurrent native streams share a bounded append budget and retain fresh dispatch state', async () => {
    const h = harness();
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, target, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    await h.clock.advance(800);
    a.tool(tool('first')); b.tool(tool('second'));
    await h.clock.advance(0);
    await h.clock.advance(200);
    b.tool(tool('second', 'done'));
    await h.clock.advance(467);
    let updates = h.calls.filter(call => call.method === 'chat.appendStream');
    assert.equal(updates.length, 2);
    assert.equal(updates[1]!.at - updates[0]!.at, 667);
    assert.match(JSON.stringify(updates[1]!.body), /Elapsed: 1s/);
    assert.match(JSON.stringify(updates[1]!.body), /Read: Done/);
    await h.clock.advance(5000);
    updates = h.calls.filter(call => call.method === 'chat.appendStream');
    assert.ok(updates.slice(1).every((call, index) => call.at - updates[index]!.at >= 667));
    assert.ok(new Set(updates.map(call => call.body.ts)).size === 2, 'both streams receive updates');
    await Promise.all([a.finish(), b.finish()]);
    assert.equal(h.clock.timers.size, 0);
});

test('fallback uses its slower edit budget while still ticking without tool events', async () => {
    const h = harness(call => call.method === 'chat.startStream' ? { payload: { ok: false, error: 'unknown_method' } } : ok());
    const p = await startSlackProgress(h.token, target, '', h.options);
    await p.ready(); await h.clock.advance(10000);
    const updates = h.calls.filter(call => call.method === 'chat.update');
    assert.deepEqual(updates.map(call => call.at - h.calls[0]!.at), [3200, 6400, 9600]);
    const finished = p.finish();
    await h.clock.advance(5000);
    await finished;
});

test('concurrent fallback cards share a live chat.update budget across one credential', async () => {
    const h = harness(call => call.method === 'chat.startStream'
        ? { payload: { ok: false, error: 'unknown_method' } }
        : { payload: { ok: true, ts: `111.${h.calls.length}` } });
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, { ...target, threadId: '100.2' }, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    await h.clock.advance(10000);
    const updates = h.calls.filter(call => call.method === 'chat.update');
    assert.ok(updates.length >= 4, 'both cards keep editing');
    assert.ok(updates.slice(1).every((call, index) => call.at - updates[index]!.at >= 1100));
    assert.equal(new Set(updates.map(call => call.body.ts)).size, 2);
    const finished = Promise.all([a.finish(), b.finish()]);
    await h.clock.advance(5000);
    await finished;
    assert.equal(h.clock.timers.size, 0);
});

test('simultaneous fallback finishes share the same chat.update budget', async () => {
    const h = harness(call => call.method === 'chat.startStream'
        ? { payload: { ok: false, error: 'unknown_method' } }
        : { payload: { ok: true, ts: `111.${h.calls.length}` } });
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, { ...target, threadId: '100.2' }, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    const finished = Promise.all([a.finish(), b.finish()]);
    await settle();
    assert.equal(h.calls.filter(call => call.method === 'chat.update').length, 1);
    await h.clock.advance(1099);
    assert.equal(h.calls.filter(call => call.method === 'chat.update').length, 1);
    await h.clock.advance(1);
    await finished;
    const updates = h.calls.filter(call => call.method === 'chat.update');
    assert.equal(updates.length, 2);
    assert.equal(updates[1]!.at - updates[0]!.at, 1100);
    assert.equal(a.terminalConfirmed(), true);
    assert.equal(b.terminalConfirmed(), true);
    assert.equal(h.clock.timers.size, 0);
});

test('a live chat.update Retry-After outlasting the finish deadline is shared without late IO', async () => {
    let rejected = false;
    const h = harness(call => {
        if (call.method === 'chat.startStream') return { payload: { ok: false, error: 'unknown_method' } };
        if (call.method === 'chat.update' && !rejected) {
            rejected = true;
            return { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '20' };
        }
        return ok();
    });
    const a = await startSlackProgress(h.token, target, '', h.options);
    const b = await startSlackProgress(h.token, { ...target, threadId: '100.2' }, '', h.options);
    await Promise.all([a.ready(), b.ready()]);
    a.tool(tool('rate-limited-live-edit'));
    await h.clock.advance(0);
    assert.equal(h.calls.filter(call => call.method === 'chat.update').length, 1);
    const finished = Promise.all([a.finish(), b.finish()]);
    await h.clock.advance(5000);
    await finished;
    assert.equal(h.calls.filter(call => call.method === 'chat.update').length, 1,
        'terminal edits must not bypass the shared 20s embargo');
    assert.equal(a.terminalConfirmed(), false);
    assert.equal(b.terminalConfirmed(), false);
    await h.clock.advance(20000);
    assert.equal(h.calls.filter(call => call.method === 'chat.update').length, 1,
        'expired embargo cannot resurrect a finished handle');
    assert.equal(h.clock.timers.size, 0);
});

test('a chat.update embargo on one credential does not delay another credential', async () => {
    const clock = new Clock();
    let rejected = false;
    const throttled = harness(call => {
        if (call.method === 'chat.startStream') return { payload: { ok: false, error: 'unknown_method' } };
        if (call.method === 'chat.update' && !rejected) {
            rejected = true;
            return { payload: { ok: false, error: 'ratelimited' }, status: 429, retryAfter: '20' };
        }
        return ok();
    }, clock);
    const independent = harness(call => call.method === 'chat.startStream'
        ? { payload: { ok: false, error: 'unknown_method' } } : ok(), clock);
    const a = await startSlackProgress(throttled.token, target, '', throttled.options);
    const b = await startSlackProgress(independent.token, target, '', independent.options);
    await Promise.all([a.ready(), b.ready()]);
    a.tool(tool('rate-limited-live-edit'));
    await clock.advance(0);
    const finished = Promise.all([a.finish(), b.finish()]);
    await clock.advance(5000);
    await finished;
    assert.equal(throttled.calls.filter(call => call.method === 'chat.update').length, 1);
    assert.equal(a.terminalConfirmed(), false);
    assert.equal(independent.calls.filter(call => call.method === 'chat.update').length, 1);
    assert.equal(b.terminalConfirmed(), true);
    await clock.advance(20000);
    assert.equal(throttled.calls.filter(call => call.method === 'chat.update').length, 1);
    assert.equal(clock.timers.size, 0);
});

test('ten simultaneous fallback finishes stay within the deadline and never resurrect excess edits', async () => {
    const h = harness(call => call.method === 'chat.startStream'
        ? { payload: { ok: false, error: 'unknown_method' } }
        : { payload: { ok: true, ts: `111.${h.calls.length}` } });
    const handles = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        startSlackProgress(h.token, { ...target, threadId: `100.${index + 1}` }, '', h.options)));
    await Promise.all(handles.map(handle => handle.ready()));
    const finished = Promise.all(handles.map(handle => handle.finish('complete', { bodyDelivered: true })));
    await h.clock.advance(5000);
    await finished;
    const updates = h.calls.filter(call => call.method === 'chat.update');
    assert.equal(updates.length, 5, 'only five 1100ms reservations fit in the 5s terminal budget');
    assert.ok(updates.slice(1).every((call, index) => call.at - updates[index]!.at >= 1100));
    assert.equal(handles.filter(handle => handle.terminalConfirmed()).length, 5);
    const callsAtDeadline = h.calls.length;
    await h.clock.advance(20000);
    assert.equal(h.calls.length, callsAtDeadline, 'deadline-rejected edits must not run later');
    assert.equal(handles.filter(handle => handle.terminalConfirmed()).length, 5,
        'unsent terminal edits remain honestly unconfirmed');
    assert.equal(h.clock.timers.size, 0);
});
