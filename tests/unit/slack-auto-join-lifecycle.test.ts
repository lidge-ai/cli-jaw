// Auto-join lifecycle: cancellation must survive the re-init race.
//
// The interesting failure is not shutdown, it is two runs overlapping. An init
// replaces the transport while an older scan is still pacing between joins; the
// older scan must stop, and its late cleanup must not clear the controller
// belonging to the run that replaced it. Driving runSlackAutoJoin directly lets
// the test observe both halves without a live socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSlackAutoJoin, SLACK_AUTO_JOIN_DEFAULTS } from '../../src/slack/auto-join.ts';

function pagingFetch(channels: string[]) {
    const joins: string[] = [];
    let listed = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const method = String(url).split('/').pop() ?? '';
        const body: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(String(init.body ?? ''))) body[k] = v;
        let payload: Record<string, unknown>;
        if (method === 'conversations.list') {
            payload = listed
                ? { ok: true, channels: [], response_metadata: { next_cursor: '' } }
                : { ok: true, channels: channels.map(id => ({ id, is_member: false })), response_metadata: { next_cursor: '' } };
            listed = true;
        } else {
            joins.push(String(body['channel'] ?? ''));
            payload = { ok: true };
        }
        const text = JSON.stringify(payload);
        return {
            ok: true, status: 200,
            headers: { get: () => null },
            async text() { return text; },
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, joins };
}

const config = { ...SLACK_AUTO_JOIN_DEFAULTS, exclude: [] as string[] };

test('a superseded generation stops the scan mid-run', async () => {
    // This is the re-init race: generation moves on while the old scan is
    // between joins. isCurrent() is what runSlackInit passes, so flipping it
    // reproduces exactly what a second init does to the first one's scan.
    const { fetchImpl, joins } = pagingFetch(['C_A', 'C_B', 'C_C']);
    let current = true;
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config, fetchImpl,
        // The pacing sleep is where a real re-init lands.
        sleep: async () => { current = false; },
        isCurrent: () => current,
    });
    assert.equal(result.cancelled, true, 'a superseded run must report itself cancelled');
    assert.equal(joins.length, 1, 'no further joins once the generation moved on');
    assert.deepEqual(joins, ['C_A']);
});

test('an aborted scan leaves the workspace alone from that point on', async () => {
    const { fetchImpl, joins } = pagingFetch(['C_A', 'C_B', 'C_C']);
    const controller = new AbortController();
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config, fetchImpl, signal: controller.signal,
        sleep: async () => { controller.abort(); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(joins.length, 1);
});

test('a signal already aborted before the run starts makes zero calls', async () => {
    // shutdownSlack aborts, then a queued init could still call through.
    const { fetchImpl, joins } = pagingFetch(['C_A']);
    const controller = new AbortController();
    controller.abort();
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config, fetchImpl, signal: controller.signal, sleep: async () => {},
    });
    assert.equal(result.cancelled, true);
    assert.deepEqual(joins, []);
});

test('the runner never throws, so a background scan cannot take the transport down', async () => {
    const fetchImpl = (async () => { throw new Error('network is gone'); }) as unknown as typeof fetch;
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config, fetchImpl, sleep: async () => {},
    });
    // slackApi turns a network throw into {ok:false}, and the runner reports it.
    assert.equal(result.joined.length, 0);
    assert.ok(result.abortedReason, 'the failure must be reported, not swallowed silently');
});

test('bot.ts starts the scan without awaiting it', async () => {
    // The contract that matters at the call site: runSlackInit uses `void` so a
    // multi-minute reconciliation cannot delay the socket being usable. Proven
    // by source shape because the alternative is booting a real transport.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/slack/bot.ts', import.meta.url), 'utf8');
    assert.match(src, /void runSlackAutoJoin\(/,
        'the scan must be fire-and-forget, never awaited during init');
    assert.match(src, /if \(autoJoinAbort === controller\) autoJoinAbort = null;/,
        'cleanup must be identity-guarded so a stale run cannot clear a newer controller');
    assert.match(src, /autoJoinAbort\?\.abort\(\);/,
        'teardown must abort the in-flight scan');
    assert.match(src, /autoJoinTimer = setInterval\(/,
        'new channels must be reconciled after startup');
    assert.match(src, /if \(autoJoinTimer\) clearInterval\(autoJoinTimer\);/,
        'shutdown must stop periodic reconciliation');
});
