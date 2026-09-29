import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { clearTargetState, setLastActiveTarget } from '../../src/messaging/runtime.ts';
import { buildRemoteBindingKey } from '../../src/messaging/session-key.ts';
import { resolveOrCreateRemoteSession } from '../../src/core/chat-sessions.ts';
import { db } from '../../src/core/db.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// #397: a file built for channel A was uploaded to channel B. The agent's send went
// through /api/channel/send, and with no explicit target that resolves to a single
// per-channel last-active slot which every inbound message overwrites.
//
// Addressing the channel explicitly was the correct move and it 403'd: with no
// configured allowlist the only conversations authorizeExplicitTarget would vouch
// for were those same volatile slots. The safe path was refused and the unsafe one
// accepted. These tests pin that an explicitly addressed, bound conversation is
// authorized even while the slot points somewhere else.

const working: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel',
    targetId: 'C_WORKING', threadId: '1787194176.603639',
};
const noisy: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel',
    targetId: 'C_NOISY', threadId: '1787205619.581069',
};

function withSlack(channelIds: unknown, fn: () => Promise<void>, botToken = '') {
    const prevSlack = settings['slack'];
    const prevMessaging = settings['messaging'];
    settings['slack'] = { ...(prevSlack || {}), channelIds: channelIds as string[], botToken };
    settings['messaging'] = { enabledChannels: ['slack'], homeChannel: 'slack' };
    return fn().finally(() => {
        settings['slack'] = prevSlack;
        settings['messaging'] = prevMessaging;
        clearTargetState();
    });
}

test('CST-001: an explicitly addressed bound conversation wins over the last-active slot', async () => {
    // The bot has been addressed in the working channel, so it is bound.
    resolveOrCreateRemoteSession(buildRemoteBindingKey(working));
    // Meanwhile a different channel spoke most recently and owns the slot.
    const sent: Array<Record<string, any>> = [];
    registerSendTransport('slack', async req => { sent.push(structuredClone(req)); return { ok: true }; });

    await withSlack([], async () => {
        setLastActiveTarget('slack', noisy);

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'for the working channel', target: working });

        assert.equal(result.ok, true, 'addressing the conversation explicitly must not 403');
        assert.equal(sent.at(-1)?.target?.targetId, 'C_WORKING');
        assert.equal(sent.at(-1)?.target?.threadId, working.threadId);
    });

    db.prepare('DELETE FROM remote_session_bindings WHERE remote_key = ?')
        .run(buildRemoteBindingKey(working));
});

test('CST-002: an unbound conversation without a verifiable token is refused', async () => {
    registerSendTransport('slack', async () => ({ ok: true }));

    await withSlack([], async () => {
        setLastActiveTarget('slack', noisy);

        const stranger: RemoteTarget = {
            channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_STRANGER',
        };
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'nope', target: stranger });

        assert.equal(result.ok, false, 'binding is the evidence; without it there is none');
        assert.equal(result.status, 403);
    });
});

const membershipTarget: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C123MEMBERSHIP',
};

function membershipFetch(respond: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push(String(url));
        assert.equal(new URLSearchParams(String(init.body)).get('channel'), membershipTarget.targetId);
        return new Response(JSON.stringify(await respond()), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
}

test('empty allowlist permits an exact bot member for target and chatId sends', async () => {
    const previousFetch = globalThis.fetch;
    const { fetchImpl, calls } = membershipFetch(() => ({ ok: true, channel: { id: membershipTarget.targetId, is_member: true } }));
    globalThis.fetch = fetchImpl;
    const sent: string[] = [];
    registerSendTransport('slack', async req => { sent.push(req.target!.targetId); return { ok: true }; });
    try {
        await withSlack([], async () => {
            assert.equal((await sendChannelOutput({ channel: 'slack', type: 'text', target: membershipTarget, text: 'one' })).ok, true);
            assert.equal((await sendChannelOutput({ channel: 'slack', type: 'text', chatId: membershipTarget.targetId, text: 'two' })).ok, true);
        }, 'xoxb-member-send');
        assert.deepEqual(sent, [membershipTarget.targetId, membershipTarget.targetId]);
        assert.equal(calls.length, 1, 'second send uses the positive membership cache');
    } finally { globalThis.fetch = previousFetch; }
});

test('non-member and API failure refuse with the invite guidance; API failure retries', async () => {
    const previousFetch = globalThis.fetch;
    let answer: Record<string, unknown> = { ok: true, channel: { id: membershipTarget.targetId, is_member: false } };
    const { fetchImpl, calls } = membershipFetch(() => answer);
    globalThis.fetch = fetchImpl;
    registerSendTransport('slack', async () => ({ ok: true }));
    const guidance = `Slack target ${membershipTarget.targetId} is not a channel this bot is verified to be in. Invite the bot there and retry. Do not edit slack.channelIds — it controls which conversations the bot hears.`;
    try {
        await withSlack([], async () => {
            const denied = await sendChannelOutput({ channel: 'slack', type: 'text', target: membershipTarget });
            assert.equal(denied.status, 403);
            assert.equal(denied.error, guidance);
        }, 'xoxb-nonmember-send');
        answer = { ok: false, error: 'missing_scope' };
        await withSlack([], async () => {
            for (let i = 0; i < 2; i++) {
                const denied = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: membershipTarget.targetId });
                assert.equal(denied.status, 403);
                assert.equal(denied.error, guidance);
            }
        }, 'xoxb-api-failure-send');
        assert.equal(calls.length, 3, 'API uncertainty must not be cached');
    } finally { globalThis.fetch = previousFetch; }
});

test('non-empty and malformed allowlists retain the original refusal and make no lookup', async () => {
    const previousFetch = globalThis.fetch;
    const { fetchImpl, calls } = membershipFetch(() => ({ ok: true, channel: { id: membershipTarget.targetId, is_member: true } }));
    globalThis.fetch = fetchImpl;
    try {
        for (const ids of [['C_OTHER'], null]) {
            await withSlack(ids, async () => {
                const result = await sendChannelOutput({ channel: 'slack', type: 'text', target: membershipTarget });
                assert.equal(result.status, 403);
                assert.equal(result.error, `Invalid or disallowed target for slack: ${membershipTarget.targetId}`);
            }, 'xoxb-listed-send');
        }
        assert.equal(calls.length, 0);
    } finally { globalThis.fetch = previousFetch; }
});

test('token swap during pending membership lookup refuses the old credential result', async () => {
    const previousFetch = globalThis.fetch;
    let release!: (response: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    const { fetchImpl, calls } = membershipFetch(() => response);
    globalThis.fetch = fetchImpl;
    try {
        await withSlack([], async () => {
            const result = sendChannelOutput({ channel: 'slack', type: 'text', target: membershipTarget });
            settings['slack']!.botToken = 'xoxb-swapped-send';
            release({ ok: true, channel: { id: membershipTarget.targetId, is_member: true } });
            assert.equal((await result).status, 403);
        }, 'xoxb-before-swap-send');
        assert.equal(calls.length, 1);
    } finally { globalThis.fetch = previousFetch; }
});

test('CST-003: a configured allowlist still governs', async () => {
    resolveOrCreateRemoteSession(buildRemoteBindingKey(working));
    registerSendTransport('slack', async () => ({ ok: true }));

    await withSlack(['C_SOMETHING_ELSE'], async () => {
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'nope', target: working });

        assert.equal(result.ok, false, 'a binding must not widen a configured allowlist');
        assert.equal(result.status, 403);
    });

    db.prepare('DELETE FROM remote_session_bindings WHERE remote_key = ?')
        .run(buildRemoteBindingKey(working));
});

test('an explicit empty thread posts to the channel root despite a last-active thread', async () => {
    const root: RemoteTarget = { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_ROOT', threadId: '' };
    resolveOrCreateRemoteSession(buildRemoteBindingKey(root));
    const seen: RemoteTarget[] = [];
    registerSendTransport('slack', async req => { seen.push(req.target!); return { ok: true }; });
    await withSlack([], async () => {
        setLastActiveTarget('slack', { ...root, threadId: 'existing.1' });
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'new announcement', target: root });
        assert.equal(result.ok, true);
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.threadId, '', 'a new announcement must not inherit the old thread');
    });
    db.prepare('DELETE FROM remote_session_bindings WHERE remote_key = ?').run(buildRemoteBindingKey(root));
});


test('fullAccess sendChannelOutput requires explicit address and ignores last-active', async () => {
    const seen: string[] = [];
    registerSendTransport('slack', async req => { seen.push(req.target?.targetId ?? ''); return { ok: true }; });
    await withSlack(['CALLOW'], async () => {
        setLastActiveTarget('slack', { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'CLAST' });
        const missing = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'no dest', fullAccess: true } as Parameters<typeof sendChannelOutput>[0] & { fullAccess?: boolean });
        assert.equal(missing.ok, false);
        assert.equal(missing.status, 400);
        assert.equal(missing.code, 'full_access_destination_required');
        assert.equal(seen.length, 0);
        const ok = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'explicit', fullAccess: true,
            target: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'CUNLISTED' },
        } as Parameters<typeof sendChannelOutput>[0] & { fullAccess?: boolean });
        assert.equal(ok.ok, true);
        assert.equal(seen.at(-1), 'CUNLISTED');
    });
});


test('fullAccess sendChannelOutput rejects malformed chatId/target before turn echo', async () => {
    const seen: string[] = [];
    registerSendTransport('slack', async req => { seen.push(req.target?.targetId ?? ''); return { ok: true }; });
    const echo = { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'channel' as const, targetId: 'CTURN' };
    await withSlack(['CALLOW'], async () => {
        setLastActiveTarget('slack', { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'CLAST' });
        for (const chatId of [[123], { id: 123 }, false, Number.NaN, Number.POSITIVE_INFINITY] as const) {
            seen.length = 0;
            const result = await sendChannelOutput({
                channel: 'slack', type: 'text', text: 'nope', fullAccess: true, chatId, turnTarget: echo,
            } as Parameters<typeof sendChannelOutput>[0]);
            assert.equal(result.ok, false, JSON.stringify({ chatId, result }));
            assert.equal(result.status, 400);
            assert.equal(result.error, 'invalid_chat_id');
            assert.equal(seen.length, 0);
        }
        seen.length = 0;
        const emptyTarget = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'nope', fullAccess: true, target: '' as never, turnTarget: echo,
        });
        assert.equal(emptyTarget.ok, false);
        assert.equal(emptyTarget.status, 400);
        assert.equal(emptyTarget.error, 'invalid_outbound_target');
        assert.equal(seen.length, 0);
        seen.length = 0;
        const viaTurn = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'echo', fullAccess: true, turnTarget: echo,
        });
        assert.equal(viaTurn.ok, true, JSON.stringify(viaTurn));
        assert.equal(seen.at(-1), 'CTURN');
        seen.length = 0;
        const coerced = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'legacy', chatId: [123],
        } as Parameters<typeof sendChannelOutput>[0]);
        assert.notEqual(coerced.error, 'invalid_chat_id');
    });
});
