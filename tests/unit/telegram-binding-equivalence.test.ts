import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../../src/core/db.ts';
import { resolveOrCreateRemoteSession } from '../../src/core/chat-sessions.ts';
import { buildRemoteBindingKey, normalizedThreadId } from '../../src/messaging/session-key.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';
import { threadKey } from '../../src/manager/telegram-hub/hub-bot.ts';
import { readSource } from './source-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botSrc = readSource(join(__dirname, '../../src/telegram/bot.ts'), 'utf8');
const discordBotSrc = readSource(join(__dirname, '../../src/discord/bot.ts'), 'utf8');
const gatewaySrc = readSource(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');
const pipelineSrc = readSource(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');

const telegramTarget = (threadId?: string): RemoteTarget => ({
    channel: 'telegram',
    targetKind: 'channel',
    peerKind: 'group',
    targetId: '-100123',
    ...(threadId ? { threadId } : {}),
});

test('Telegram General-topic bot and hub targets share the unsuffixed binding key', () => {
    const expected = 'jaw:telegram:group:-100123';
    assert.equal(buildRemoteBindingKey(telegramTarget()), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(1))), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget('0')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget('-3')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(undefined))), expected);
});

test('Telegram General-topic normalization is shared by binding, queue, and dedup keys', () => {
    assert.equal(normalizedThreadId(telegramTarget('1')), undefined);
    assert.equal(normalizedThreadId(telegramTarget('42')), '42');
    assert.match(gatewaySrc, /dedupKey\([^\n]+normalizedThreadId\(meta\.target\)\)/);
});

test('Telegram forum-topic bot and hub targets share the same threaded binding key', () => {
    const expected = 'jaw:telegram:group:-100123:thread:42';
    assert.equal(buildRemoteBindingKey(telegramTarget('42')), expected);
    assert.equal(buildRemoteBindingKey(telegramTarget(threadKey(42))), expected);
});

test('callback-query Telegram targets use ctx.msg topic metadata', () => {
    const fnStart = botSrc.indexOf('function buildTelegramTarget');
    const fnEnd = botSrc.indexOf('async function telegramSendHandler', fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'buildTelegramTarget block should be bounded');
    const block = botSrc.slice(fnStart, fnEnd);
    assert.match(block, /ctx\.msg\?\.is_topic_message/, 'callback-query ctx should resolve through ctx.msg');
    assert.match(block, /messageThreadId\s*>\s*1|ctx\.msg\.message_thread_id\s*>\s*1/, 'General and non-topic threads should normalize away');
    assert.match(block, /String\((?:messageThreadId|ctx\.msg\.message_thread_id)\)/, 'real callback-query topics should retain their id');
    assert.ok(!block.includes('ctx.message?.message_thread_id'), 'ctx.message must not split callback-query targets');
});

test('Telegram normalization does not alter Slack or Discord thread keys', () => {
    const slack: RemoteTarget = {
        channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1', threadId: '171.2',
    };
    const discord: RemoteTarget = {
        channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: '123', threadId: '123',
    };
    assert.equal(buildRemoteBindingKey(slack), 'jaw:slack:channel:C1:thread:171.2');
    assert.equal(buildRemoteBindingKey(discord), 'jaw:discord:channel:123:thread:123');
});

test('Telegram and Discord collect paths preserve the admitted session context', () => {
    const telegramCollect = botSrc.slice(
        botSrc.indexOf('orchestrateAndCollectData(prompt'),
        botSrc.indexOf('clearInterval(typingInterval)', botSrc.indexOf('orchestrateAndCollectData(prompt')),
    );
    for (const field of ['scope', 'chatSessionId', 'remoteKey']) {
        assert.match(telegramCollect, new RegExp(`${field}: result\\.sessionContext\\?\\.${field}`));
    }
    assert.match(telegramCollect, /target: responseTarget/);

    const discordCollect = discordBotSrc.slice(
        discordBotSrc.indexOf('orchestrateAndCollectData(prompt'),
        discordBotSrc.indexOf('const channel = asSendable', discordBotSrc.indexOf('orchestrateAndCollectData(prompt')),
    );
    for (const field of ['scope', 'chatSessionId', 'remoteKey']) {
        assert.match(discordCollect, new RegExp(`${field}: result\\.sessionContext\\?\\.${field}`));
    }
});

test('SubmitResult returns sessionContext for every started and queued admission', () => {
    assert.match(gatewaySrc, /sessionContext\?: \{ scope: string; chatSessionId: string; remoteKey\?: string \}/);
    const admissionReturns = gatewaySrc.split('\n').filter(line =>
        /return \{ action: '(?:started|queued)'/.test(line),
    );
    assert.ok(admissionReturns.length >= 6, 'all immediate and mid-run admission branches should be covered');
    for (const line of admissionReturns) {
        assert.match(line, /sessionContext/, `missing sessionContext: ${line.trim()}`);
    }
});

test('pipeline spawn runs inside the resolved session context', () => {
    const spawnStart = pipelineSrc.indexOf('const spawn = (fallback?: { cli: string }) => runSpawnAgent');
    const spawnEnd = pipelineSrc.indexOf('const nativeOutcome: RuntimeTurnOutcome', spawnStart);
    assert.ok(spawnStart >= 0 && spawnEnd > spawnStart);
    const spawnBlock = pipelineSrc.slice(spawnStart, spawnEnd);
    assert.match(spawnBlock, /withSessionScope\(\{ scope, chatSessionId \}, \(\) => spawn\(\)\)/);
    // The native fallback re-run belongs to the same session as the run it replaces.
    assert.match(spawnBlock, /withSessionScope\(\{ scope, chatSessionId \}, \(\) => spawn\(\{ cli: fallbackCli \}\)\)/);
});

test('legacy Telegram :thread:1 binding is rebound to the General-topic key', () => {
    const canonicalKey = 'jaw:telegram:group:-100987654321';
    const legacyKey = `${canonicalKey}:thread:1`;
    const sessionId = 'tg-general-fallback';
    try {
        db.prepare('INSERT INTO chat_sessions (id, seq, label) VALUES (?, ?, ?)').run(sessionId, 987654, legacyKey);
        db.prepare('INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)').run(legacyKey, sessionId);

        assert.equal(resolveOrCreateRemoteSession(canonicalKey), sessionId);
        assert.equal(
            (db.prepare('SELECT chat_session_id FROM remote_session_bindings WHERE remote_key = ?').get(canonicalKey) as { chat_session_id: string }).chat_session_id,
            sessionId,
        );
        assert.equal(db.prepare('SELECT 1 FROM remote_session_bindings WHERE remote_key = ?').get(legacyKey), undefined);
    } finally {
        db.prepare('DELETE FROM remote_session_bindings WHERE remote_key IN (?, ?)').run(canonicalKey, legacyKey);
        db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    }
});
