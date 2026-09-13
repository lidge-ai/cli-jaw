// Send validation behavior tests — Phase 9
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type SlackTarget = {
    channel: 'slack';
    targetKind: 'channel' | 'user';
    peerKind: 'channel' | 'group' | 'direct';
    targetId: string;
    threadId?: string;
};

const slackTarget = (targetId = 'C_CURRENT', threadId = '1710000000.000100'): SlackTarget => ({
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId,
    ...(threadId ? { threadId } : {}),
});

async function withIsolatedSlack(
    run: (capture: { requests: Array<Record<string, any>> }) => Promise<void>,
    channelIds: string[] = [],
) {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport } = await import('../../src/messaging/send.js');
    const { clearTargetState } = await import('../../src/messaging/runtime.js');
    const previousSlack = settings.slack;
    const previousChannel = settings.channel;
    const previousMessaging = settings.messaging;
    const capture = { requests: [] as Array<Record<string, any>> };
    try {
        clearTargetState();
        settings.channel = 'slack';
        settings.slack = { ...(settings.slack || {}), channelIds };
        registerSendTransport('slack', async req => {
            capture.requests.push(structuredClone(req));
            return { ok: true };
        });
        await run(capture);
    } finally {
        clearTargetState();
        settings.slack = previousSlack;
        settings.channel = previousChannel;
        settings.messaging = previousMessaging;
    }
}

// ─── validateTarget behavior ─────────────────────────

test('validateTarget rejects null/undefined target', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    assert.equal(validateTarget(null as any, 'discord'), false);
    assert.equal(validateTarget(undefined as any, 'discord'), false);
});

test('validateTarget rejects empty targetId', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    assert.equal(validateTarget({ channel: 'discord', targetId: '', targetKind: 'channel', peerKind: 'channel' }, 'discord'), false);
});

test('validateTarget rejects channel mismatch', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    const target = { channel: 'telegram' as const, targetId: '123', targetKind: 'user' as const, peerKind: 'direct' as const };
    assert.equal(validateTarget(target, 'discord'), false);
});

test('validateTarget accepts matching channel with valid targetId', async () => {
    const { validateTarget } = await import('../../src/messaging/send.js');
    const target = { channel: 'discord' as const, targetId: '123456', targetKind: 'channel' as const, peerKind: 'channel' as const };
    // When no channelIds configured (empty), all targets pass
    assert.equal(validateTarget(target, 'discord'), true);
});

test('sendChannelOutput rejects explicit chatId when allowlist is empty', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: [] };
        registerSendTransport('discord', async () => ({ ok: true }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            chatId: '123456',
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    } finally {
        settings.discord = previousDiscord;
    }
});

test('sendChannelOutput allows explicit chatId only when configured', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: ['123456'] };
        registerSendTransport('discord', async req => ({
            ok: true,
            targetId: req.target?.targetId,
            chatId: req.chatId,
        }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            chatId: '123456',
        });
        assert.equal(result.ok, true);
        assert.equal(result.targetId, '123456');
    } finally {
        settings.discord = previousDiscord;
    }
});

test('sendChannelOutput rejects disallowed explicit target with 403 status', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const previousDiscord = settings.discord;
    try {
        settings.discord = { ...(settings.discord || {}), channelIds: ['allowed-channel'] };
        registerSendTransport('discord', async () => ({ ok: true }));
        const result = await sendChannelOutput({
            channel: 'discord',
            type: 'text',
            text: 'hello',
            target: {
                channel: 'discord',
                targetKind: 'channel',
                peerKind: 'channel',
                targetId: 'not-allowed',
            },
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    } finally {
        settings.discord = previousDiscord;
    }
});

test('normalizeChannelSendRequest rejects invalid outbound type and channel', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    assert.throws(
        () => normalizeChannelSendRequest({ channel: 'discord', type: 'sticker' }),
        /invalid_outbound_type/,
    );
    assert.throws(
        // 'slack' became a real channel in 260802_slack_channel wp1, so it is no
        // longer a valid stand-in for "unknown channel". Use one that is not.
        () => normalizeChannelSendRequest({ channel: 'signal', type: 'text' }),
        /invalid_channel/,
    );
    assert.throws(
        () => normalizeChannelSendRequest({ channel: false, type: 'text' }),
        /invalid_channel/,
    );
    assert.throws(
        () => normalizeChannelSendRequest({ channel: 'discord', type: false }),
        /invalid_outbound_type/,
    );
});

test('normalizeChannelSendRequest gives Slack-shaped channel values an actionable transport hint', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    assert.throws(
        () => normalizeChannelSendRequest({ channel: 'C123ABC', type: 'text', text: 'hello' }),
        (error: unknown) => {
            const typed = error as Error & { statusCode?: number; code?: string };
            assert.equal(typed.statusCode, 400);
            assert.equal(typed.code, 'invalid_channel');
            assert.match(typed.message, /channel is (?:a )?transport/i);
            assert.match(typed.message, /chat_id|target\.targetId/);
            return true;
        },
    );
});

test('empty Slack allowlist permits the exact last-active chatId without moving it into that thread', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget());

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'hello', chatId: 'C_CURRENT' });

        assert.equal(result.ok, true);
        assert.equal(capture.requests.length, 1);
        // The last-active slot is evidence the bot belongs in this conversation,
        // which is all it is asked for here. It used to also supply the address:
        // a caller that named the channel had its post moved into whichever
        // thread had spoken most recently (#745). Vouching is not addressing.
        assert.deepEqual(capture.requests[0]?.target, slackTarget('C_CURRENT', ''));
    });
});

test('empty Slack allowlist permits the exact last-active object target and keeps its omitted thread omitted', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget());

        const result = await sendChannelOutput({
            channel: 'slack',
            type: 'text',
            text: 'hello',
            target: slackTarget('C_CURRENT', ''),
        });

        assert.equal(result.ok, true);
        assert.deepEqual(capture.requests[0]?.target, slackTarget('C_CURRENT', ''));
    });
});

test('empty Slack allowlist permits an exact explicit parent thread', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget());

        const result = await sendChannelOutput({
            channel: 'slack',
            type: 'document',
            target: slackTarget(),
        });

        assert.equal(result.ok, true);
        assert.deepEqual(capture.requests[0]?.target, slackTarget());
    });
});

test('latest-seen Slack target authorizes the same explicit chat when last-active is absent', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLatestSeenTarget } = await import('../../src/messaging/runtime.js');
        setLatestSeenTarget('slack', slackTarget());

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: 'C_CURRENT' });

        assert.equal(result.ok, true);
        assert.deepEqual(capture.requests[0]?.target, slackTarget('C_CURRENT', ''));
    });
});

test('empty Slack allowlist does not authorize without trusted runtime state', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: 'C_CURRENT' });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
        assert.equal(capture.requests.length, 0);
    });
});

test('active-equivalent Slack authorization rejects another channel or another thread', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget());

        const otherChannel = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: 'C_OTHER' });
        const otherThread = await sendChannelOutput({
            channel: 'slack',
            type: 'text',
            target: slackTarget('C_CURRENT', '1710000000.999999'),
        });

        assert.equal(otherChannel.ok, false);
        assert.equal(otherChannel.status, 403);
        assert.equal(otherThread.ok, false);
        assert.equal(otherThread.status, 403);
        assert.equal(capture.requests.length, 0);
    });
});

test('forged Slack peerKind never turns a channel ID into a direct-message bypass', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const result = await sendChannelOutput({
            channel: 'slack',
            type: 'text',
            target: {
                channel: 'slack',
                targetKind: 'user',
                peerKind: 'direct',
                targetId: 'C_FORGED',
            },
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
        assert.equal(capture.requests.length, 0);
    });
});

test('malformed explicit Slack target cannot borrow authority from a matching active target', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget());

        const result = await sendChannelOutput({
            channel: 'slack',
            type: 'text',
            target: { channel: 'slack', targetId: 'C_CURRENT' } as never,
        });

        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
        assert.equal(capture.requests.length, 0);
    });
});

for (const [label, malformed] of [
    ['missing targetKind', { channel: 'slack', peerKind: 'channel', targetId: 'C_CURRENT' }],
    ['invalid targetKind', { channel: 'slack', targetKind: 'thread', peerKind: 'channel', targetId: 'C_CURRENT' }],
    ['missing peerKind', { channel: 'slack', targetKind: 'channel', targetId: 'C_CURRENT' }],
    ['invalid peerKind', { channel: 'slack', targetKind: 'channel', peerKind: 'workspace', targetId: 'C_CURRENT' }],
    ['non-string threadId', { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_CURRENT', threadId: 123 }],
    ['non-string guildId', { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_CURRENT', guildId: 123 }],
    ['cross-channel candidate', { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: 'C_CURRENT' }],
] as const) {
    test(`malformed persisted Slack state cannot authorize an explicit target: ${label}`, async () => {
        await withIsolatedSlack(async capture => {
            const { sendChannelOutput } = await import('../../src/messaging/send.js');
            const { hydrateTargetsFromSettings } = await import('../../src/messaging/runtime.js');
            hydrateTargetsFromSettings({ messaging: { lastActive: { slack: malformed }, latestSeen: {} } });

            const result = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: 'C_CURRENT' });

            assert.equal(result.ok, false);
            assert.equal(result.status, 403);
            assert.equal(capture.requests.length, 0);
        });
    });
}

test('a non-empty Slack allowlist remains authoritative over current runtime state', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', chatId: 'C_CURRENT' });
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
        assert.equal(capture.requests.length, 0);
    }, ['C_ALLOWED']);
});

// ─── validateDiscordFileSize behavior ────────────────

test('validateDiscordFileSize rejects 11 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    assert.throws(
        () => validateDiscordFileSize('big.bin', 11 * 1024 * 1024),
        /exceeds Discord 10 MiB/,
    );
});

test('validateDiscordFileSize accepts 5 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    assert.doesNotThrow(() => validateDiscordFileSize('ok.bin', 5 * 1024 * 1024));
});

// ─── normalizeChannelSendRequest behavior ────────────

test('normalizeChannelSendRequest maps body fields correctly', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const jawHome = process.env.CLI_JAW_HOME || process.env.JAW_HOME || path.join(os.homedir(), '.cli-jaw');
    const testDir = path.join(jawHome, 'output');
    fs.mkdirSync(testDir, { recursive: true });
    const testPath = path.join(testDir, `send-test-${Date.now()}.png`);
    fs.writeFileSync(testPath, '');
    try {
        const req = normalizeChannelSendRequest({
            channel: 'discord',
            type: 'photo',
            file_path: testPath,
            caption: 'test',
            chat_id: '123',
        });
        assert.equal(req.channel, 'discord');
        assert.equal(req.type, 'photo');
        assert.equal(req.filePath, fs.realpathSync(testPath));
        assert.equal(req.caption, 'test');
        assert.equal(req.chatId, '123');
    } finally {
        try { fs.unlinkSync(testPath); } catch {}
    }
});

test('normalizeChannelSendRequest allows configured projectDir file paths', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const { settings } = await import('../../src/core/config.js');
    const previousProjectDirs = settings["projectDirs"];
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-project-dir-'));
    const testPath = path.join(projectDir, 'image.png');
    try {
        fs.writeFileSync(testPath, '');
        settings["projectDirs"] = [fs.realpathSync.native(projectDir)];
        const req = normalizeChannelSendRequest({
            channel: 'telegram',
            type: 'photo',
            file_path: testPath,
        });
        assert.equal(req.filePath, fs.realpathSync.native(testPath));
    } finally {
        settings["projectDirs"] = previousProjectDirs;
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

test('normalizeChannelSendRequest rejects disallowed file paths before send transport', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const { settings } = await import('../../src/core/config.js');
    const previousProjectDirs = settings["projectDirs"];
    const previousWorkingDir = settings["workingDir"];
    const testPath = path.join(os.tmpdir(), `jaw-send-denied-${Date.now()}.txt`);
    try {
        fs.writeFileSync(testPath, 'secret');
        settings["projectDirs"] = [];
        settings["workingDir"] = '';
        assert.throws(() => normalizeChannelSendRequest({
            channel: 'telegram',
            type: 'document',
            file_path: testPath,
        }), /path_not_allowed/);
    } finally {
        settings["projectDirs"] = previousProjectDirs;
        settings["workingDir"] = previousWorkingDir;
        fs.rmSync(testPath, { force: true });
    }
});

test('normalizeChannelSendRequest defaults channel to active', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const req = normalizeChannelSendRequest({ type: 'text', text: 'hello' });
    assert.equal(req.channel, 'active');
});

// ─── chunkDiscordMessage behavior ────────────────────

test('chunkDiscordMessage handles empty string', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    assert.deepEqual(chunkDiscordMessage(''), ['']);
});

test('chunkDiscordMessage handles exactly 2000 chars', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const text = 'x'.repeat(2000);
    const chunks = chunkDiscordMessage(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2000);
});

test('chunkDiscordMessage splits 4000 chars into 2 chunks', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const text = 'x'.repeat(4000);
    const chunks = chunkDiscordMessage(text);
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every(c => c.length <= 2000));
});

test('normalizeChannelSendRequest carries the interactive fallback opt-in', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    // The normalizer is an allowlist, so a field it does not name is dropped before
    // the transport sees it. That silently turned every HTTP keyboard send to a
    // channel without interactive support into an unsupported refusal.
    const snake = normalizeChannelSendRequest({ type: 'keyboard', text: 'hi', interactive_fallback: 'text' });
    assert.equal(snake.interactiveFallback, 'text');
    const camel = normalizeChannelSendRequest({ type: 'keyboard', text: 'hi', interactiveFallback: 'TEXT' });
    assert.equal(camel.interactiveFallback, 'text');
});

test('normalizeChannelSendRequest omits the opt-in when absent', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    const req = normalizeChannelSendRequest({ type: 'keyboard', text: 'hi' });
    assert.equal('interactiveFallback' in req, false, 'absent must stay absent, not become a default');
});

test('normalizeChannelSendRequest rejects an unknown interactive fallback', async () => {
    const { normalizeChannelSendRequest } = await import('../../src/messaging/send.js');
    // A typo must not read as consent to a downgrade the caller never asked for.
    assert.throws(
        () => normalizeChannelSendRequest({ type: 'keyboard', text: 'hi', interactiveFallback: 'blocks' }),
        /invalid_interactive_fallback/,
    );
});

// ─── outbound reads the allowlist the way the gate does ──

// The inbound gate refused every channel on a malformed allowlist while
// validateTarget read `undefined.length`, called it "nothing configured", and
// let an explicit target through. Two readers, two verdicts, on the same
// setting (#406).
test('a malformed slack allowlist denies outbound targets too', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { validateTarget, validateExplicitChatId } = await import('../../src/messaging/send.js');
    const previousSlack = settings.slack;
    try {
        for (const bad of ['C_ESCAPE', null, [''], Array.from({ length: 1001 }, (_, i) => `C${i}`)]) {
            settings.slack = { ...(settings.slack || {}), channelIds: bad };
            assert.equal(
                validateExplicitChatId('slack', 'C_ESCAPE'), false,
                `an unreadable allowlist must not admit a channel: ${JSON.stringify(bad)?.slice(0, 40)}`,
            );
            // DMs stay self-authorizing, as inbound does.
            assert.equal(validateExplicitChatId('slack', 'D_USER'), true);
            assert.equal(
                validateTarget(
                    { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_ESCAPE' },
                    'slack',
                ),
                false,
            );
        }
    } finally {
        settings.slack = previousSlack;
    }
});

test('a malformed slack allowlist yields no configured fallback target', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { sendChannelOutput, registerSendTransport } = await import('../../src/messaging/send.js');
    const { clearTargetState } = await import('../../src/messaging/runtime.js');
    const previousSlack = settings.slack;
    const previousChannel = settings.channel;
    const requests: Array<Record<string, any>> = [];
    try {
        clearTargetState();
        settings.channel = 'slack';
        // The sentinel is not a conversation id. Falling back to `ids[0]` without
        // checking would have addressed it as one.
        settings.slack = { ...(settings.slack || {}), channelIds: 'C_ESCAPE' };
        registerSendTransport('slack', async req => {
            requests.push(structuredClone(req));
            return { ok: true };
        });
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'hello' });
        assert.equal(result.ok, false, 'an unreadable allowlist is not a send target');
        assert.equal(requests.length, 0, 'nothing may reach the transport');
    } finally {
        clearTargetState();
        settings.slack = previousSlack;
        settings.channel = previousChannel;
    }
});

// ─── allowActiveFallback: non-interactive senders opt out of last-active (#437) ───
//
// The chain below is right for a REPLY: when an agent answers without naming a
// conversation, the one that just spoke is the obvious destination. It is wrong
// for a scheduled report, which has no conversation of its own and would inherit
// whoever happened to message the bot last.

test('a send that opts out of the active fallback fails instead of inheriting the last-active thread', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_SOMEONE_ELSE'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'scheduled report',
            allowActiveFallback: false,
        });

        assert.equal(result.ok, false, 'no target and no fallback must not deliver anywhere');
        assert.match(String(result.error), /No target available/);
        assert.equal(capture.requests.length, 0, 'the unrelated conversation must receive nothing');
    });
});

test('opting out does not disturb a send that carries its own target', async () => {
    // The allowlist is what authorizes an explicit target (#406); with one
    // configured, opting out of the fallback must not interfere with a send that
    // already knows where it is going.
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_SOMEONE_ELSE'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'scheduled report',
            target: slackTarget('C_INTENDED', '1710000000.000999'),
            allowActiveFallback: false,
        });

        assert.equal(result.ok, true);
        assert.equal(capture.requests.length, 1);
        assert.equal(capture.requests[0]?.target?.targetId, 'C_INTENDED');
        assert.equal(capture.requests[0]?.target?.threadId, '1710000000.000999');
    }, ['C_INTENDED']);
});

test('the default is unchanged: omitting the flag still resolves through last-active', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'reply' });

        assert.equal(result.ok, true, 'conversational replies keep the historical behaviour');
        assert.equal(capture.requests[0]?.target?.targetId, 'C_CURRENT');
    });
});

test('resolution falls through last-active to latest-seen when the last-active target is gone', async () => {
    // The three-step order used to be asserted by reading send.ts as text. This
    // exercises it instead: with no last-active recorded, the latest-seen slot is
    // what a reply must reach.
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLatestSeenTarget } = await import('../../src/messaging/runtime.js');
        setLatestSeenTarget('slack', slackTarget('C_SEEN'));

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'reply' });

        assert.equal(result.ok, true);
        assert.equal(capture.requests[0]?.target?.targetId, 'C_SEEN');
    });
});

test('resolution falls through to the configured allowlist when neither slot is set', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'reply' });

        assert.equal(result.ok, true);
        assert.equal(capture.requests[0]?.target?.targetId, 'C_CONFIGURED');
    }, ['C_CONFIGURED']);
});

test('last-active outranks latest-seen', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget, setLatestSeenTarget } = await import('../../src/messaging/runtime.js');
        setLatestSeenTarget('slack', slackTarget('C_SEEN'));
        setLastActiveTarget('slack', slackTarget('C_ACTIVE'));

        await sendChannelOutput({ channel: 'slack', type: 'text', text: 'reply' });

        assert.equal(capture.requests[0]?.target?.targetId, 'C_ACTIVE');
    });
});


// ─── #438: scheduled notifications must not inherit a conversation ───
//
// Same defect class as the heartbeat incident, different callers. A reminder,
// a watcher notification and an alert all fire on their own schedule, so the
// conversation that spoke most recently has nothing to do with them.

test('a configured-target send ignores an unrelated last-active conversation', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_SOMEONE_ELSE'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'reminder',
            preferConfiguredTarget: true,
        });

        assert.equal(result.ok, true, 'a notification should still be delivered');
        assert.equal(capture.requests[0]?.target?.targetId, 'C_CONFIGURED',
            'it must land in the channel the operator configured');
    }, ['C_CONFIGURED']);
});

test('preferConfiguredTarget alone still last-resorts when allowlist is empty', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'alert',
            preferConfiguredTarget: true,
        });

        assert.equal(result.ok, true);
        assert.equal(capture.requests[0]?.target?.targetId, 'C_CURRENT');
        assert.equal(capture.requests[0]?.target?.threadId, '1710000000.000100');
    });
});

test('scheduled pair plus empty allowlist sends zero transports', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'alert',
            preferConfiguredTarget: true,
            allowActiveFallback: false,
        });

        assert.equal(result.ok, false);
        assert.equal(capture.requests.length, 0);
        assert.match(String(result.error || ''), /No target available for slack/);
    });
});

test('scheduled pair uses configured dest and ignores last-active', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));

        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'alert',
            preferConfiguredTarget: true,
            allowActiveFallback: false,
        });

        assert.equal(result.ok, true);
        assert.equal(capture.requests.length, 1);
        assert.equal(capture.requests[0]?.target?.targetId, 'C_CONFIGURED');
        assert.notEqual(capture.requests[0]?.target?.targetId, 'C_CURRENT');
    }, ['C_CONFIGURED']);
});

test('conversational sends are untouched by the new preference', async () => {
    await withIsolatedSlack(async capture => {
        const { sendChannelOutput } = await import('../../src/messaging/send.js');
        const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
        setLastActiveTarget('slack', slackTarget('C_CURRENT'));

        await sendChannelOutput({ channel: 'slack', type: 'text', text: 'reply' });

        assert.equal(capture.requests[0]?.target?.targetId, 'C_CURRENT',
            'a reply must still go to the conversation it is replying to');
        // Both ids are allowlisted so the conversation is a legal destination;
        // otherwise this would be testing the allowlist, not the preference.
    }, ['C_CONFIGURED', 'C_CURRENT']);
});


test('validateTarget fullAccess admits a well-shaped unlisted destination and rejects malformed', async () => {
    const { settings } = await import('../../src/core/config.js');
    const { validateTarget, validateExplicitChatId } = await import('../../src/messaging/send.js');
    const previousSlack = settings.slack;
    const previousTelegram = settings.telegram;
    const previousDiscord = settings.discord;
    try {
        settings.slack = { ...(settings.slack || {}), channelIds: ['CALLOW'] };
        settings.telegram = { ...(settings.telegram || {}), allowedChatIds: [111] };
        settings.discord = { ...(settings.discord || {}), channelIds: ['111'] };
        const withFull = { fullAccess: true } as { requireConfiguredAllowlist?: boolean; fullAccess?: boolean };
        assert.equal(validateTarget({ channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'CUNLISTED' }, 'slack', withFull), true);
        assert.equal(validateExplicitChatId('slack', 'CUNLISTED', withFull as never), true);
        assert.equal(validateExplicitChatId('slack', 'CUNLISTED'), false);
        assert.equal(validateTarget({ channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId: '999001' }, 'telegram', withFull), true);
        assert.equal(validateTarget({ channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '888001' }, 'discord', withFull), true);
        assert.equal(validateTarget({ channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: '' }, 'slack', withFull), false);
        assert.equal(validateTarget({ channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '888001' }, 'slack', withFull), false);
    } finally {
        settings.slack = previousSlack;
        settings.telegram = previousTelegram;
        settings.discord = previousDiscord;
    }
});
