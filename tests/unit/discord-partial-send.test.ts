// Discord partial-send receipt (#785).
//
// A long answer splits at Discord's 2000-char limit. When a FOLLOW-UP chunk
// fails — rejection, rate-limit exhaustion, or an abort at the chunk boundary —
// the chunks that already posted stay on screen. That is neither a success nor
// a clean failure: the result must keep the posted prefix's receipt
// (sent/partial/postedChunks/messageIds) without being promoted to success,
// and retryable:false so nothing replays the full body over a visible prefix.
//
// Slack already reports the same boundary this way
// (src/slack/send-only-client.ts); these pin the Discord side of it against
// the real sendDiscordTextRest with an injected scheduler, the same seam the
// cancellation tests use — no network, no Discord.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDiscordSendFailure, sendDiscordDm, sendDiscordTextRest } from '../../src/discord/send-only-client.ts';

type Scheduled = { path: string; body: string; signal?: AbortSignal };
type Reply =
    | { ok: true; value: string | undefined; status: number }
    | { ok: false; failure: { kind: string; retryAfterMs: number; message: string }; status?: number };

function fakeScheduler(replies: Reply[], onSchedule?: (job: Scheduled) => void) {
    const jobs: Scheduled[] = [];
    let calls = 0;
    return {
        jobs,
        scheduler: {
            schedule: async (req: {
                path: string;
                makeInit: () => { body?: unknown } | Promise<{ body?: unknown }>;
                signal?: AbortSignal;
            }) => {
                const init = await req.makeInit();
                const job: Scheduled = {
                    path: req.path,
                    body: String(init.body ?? ''),
                    ...(req.signal ? { signal: req.signal } : {}),
                };
                jobs.push(job);
                onSchedule?.(job);
                return replies[Math.min(calls++, replies.length - 1)];
            },
        },
    };
}

// Two chunks at Discord's 2000-char limit.
const LONG = 'x'.repeat(3_000);

test('a failed follow-up chunk preserves the posted prefix receipt', async () => {
    const { jobs, scheduler } = fakeScheduler([
        { ok: true, value: 'message-1', status: 200 },
        { ok: false, failure: { kind: 'ambiguous', retryAfterMs: 0, message: 'discord_http_503' }, status: 503 },
    ]);

    const result = await sendDiscordTextRest('tok', '555', LONG, { scheduler: scheduler as never });

    assert.equal(result.ok, false, 'the whole answer did not deliver — still a failure');
    assert.equal(result.sent, true, 'at least one chunk already posted');
    assert.equal(result.partial, true);
    assert.equal(result.postedChunks, 1);
    assert.equal(result.totalChunks, 2);
    assert.equal(result.retryable, false,
        'replaying the whole body would duplicate the visible prefix');
    assert.equal(result.platformMessageId, 'message-1');
    assert.deepEqual(result.messageIds, ['message-1']);
    assert.equal(result.deliveryStatus, 'failed');
    assert.equal(result.status, 503);
    assert.equal(result.error, 'discord_http_503');
    assert.equal(jobs.length, 2, 'the failing chunk was attempted, then the loop stopped');
});

test('an abort at the chunk boundary keeps the same partial semantics', async () => {
    const controller = new AbortController();
    const { jobs, scheduler } = fakeScheduler(
        [{ ok: true, value: 'message-1', status: 200 }],
        () => controller.abort(),
    );

    const result = await sendDiscordTextRest('tok', '555', LONG, {
        signal: controller.signal,
        scheduler: scheduler as never,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'discord_send_aborted');
    assert.equal(result.status, 499);
    assert.equal(result.sent, true);
    assert.equal(result.partial, true);
    assert.equal(result.postedChunks, 1);
    assert.equal(result.totalChunks, 2);
    assert.equal(result.retryable, false);
    assert.equal(result.platformMessageId, 'message-1');
    assert.deepEqual(result.messageIds, ['message-1']);
    assert.equal(jobs.length, 1, 'nothing was scheduled past the aborted boundary');
});

test('a first-chunk failure keeps the plain failure shape', async () => {
    const { jobs, scheduler } = fakeScheduler([
        { ok: false, failure: { kind: 'ambiguous', retryAfterMs: 0, message: 'discord_http_503' }, status: 503 },
    ]);

    const result = await sendDiscordTextRest('tok', '555', LONG, { scheduler: scheduler as never });

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    // Nothing posted, so there is no receipt to preserve: the failure keeps the
    // shape it always had instead of inventing partial fields.
    assert.equal('sent' in result, false);
    assert.equal('partial' in result, false);
    assert.equal('postedChunks' in result, false);
    assert.equal('retryable' in result, false);
    assert.equal('platformMessageId' in result, false);
    assert.equal(jobs.length, 1);
});

test('a DM whose follow-up chunk is rejected keeps the posted prefix receipt', async () => {
    let posts = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
        if (String(url).endsWith('/users/@me/channels')) {
            return new Response(JSON.stringify({ id: 'DM1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        posts += 1;
        if (posts === 1) {
            return new Response(JSON.stringify({ id: 'M1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }),
            { status: 403, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const result = await sendDiscordDm('token', 'USER9', LONG, fetchImpl);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.sent, true);
    assert.equal(result.partial, true);
    assert.equal(result.retryable, false);
    assert.equal(result.postedChunks, 1);
    assert.equal(result.totalChunks, 2);
    assert.deepEqual(result.messageIds, ['M1']);
    assert.equal(posts, 2, 'the failed chunk is not replayed');
});

test('a failure description names the posted prefix so logs and thrown errors keep it', () => {
    assert.equal(describeDiscordSendFailure({ error: 'boom' }), 'boom');
    assert.equal(
        describeDiscordSendFailure({ error: 'boom', sent: true, partial: true, retryable: false, postedChunks: 1, totalChunks: 2, messageIds: ['M1'] }),
        'boom (partial: posted 1/2 chunks messageIds=M1)',
    );
});
