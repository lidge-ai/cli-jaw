import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addBroadcastListener, broadcast, removeBroadcastListener } from '../src/core/bus.ts';
import { drainLogRing } from '../src/core/logger.ts';
import {
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
    escapeHtmlTg,
    markdownToTelegramHtml,
} from '../src/telegram/forwarder.ts';

function createBotSpy({ failHtmlOnce = false } = {}) {
    const sent = [];
    const photos = [];
    const events = [];
    let resolvePhoto!: () => void;
    const photoSent = new Promise<void>((resolve) => { resolvePhoto = resolve; });
    let failed = false;
    return {
        sent,
        photos,
        events,
        photoSent,
        bot: {
            api: {
                async sendMessage(chatId, text, opts) {
                    events.push('text');
                    sent.push({ chatId, text, opts });
                    if (failHtmlOnce && !failed && opts?.parse_mode === 'HTML') {
                        failed = true;
                        // The ladder only falls back on a FORMATTING rejection
                        // now: a bare Error could equally be a rate limit or a
                        // network failure, and re-sending those was the defect.
                        throw Object.assign(new Error('unsupported start tag: invalid html'), {
                            error_code: 400,
                        });
                    }
                    return { ok: true };
                },
                async sendPhoto(chatId, file, opts) {
                    events.push('photo');
                    photos.push({ chatId, file, opts });
                    resolvePhoto();
                    return { message_id: 1 };
                },
            },
        },
    };
}

/** The destination a run was admitted with. Forwarders read it off the event
 *  rather than asking the transport who spoke most recently (#742). */
function tgTarget(targetId, threadId) {
    return { channel: 'telegram', targetKind: 'channel', peerKind: 'group',
        targetId: String(targetId), ...(threadId ? { threadId } : {}) };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('forwarder skips telegram-origin responses', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        shouldSkip: (data) => data.origin === 'telegram',
    });

    forward('agent_done', { text: 'A', origin: 'telegram', target: tgTarget(123) });
    forward('agent_done', { text: 'B', origin: 'web', target: tgTarget(123) });
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '123');
    assert.equal(sent[0].opts?.parse_mode, 'HTML');
    assert.equal(sent[0].text, '📡 B');
});

test('forwarder skips error responses', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
    });

    forward('agent_done', { text: 'error text', error: true, origin: 'web', target: tgTarget(123) });
    await flush();
    assert.equal(sent.length, 0);
});

test('forwarder sends watchdog stall diagnostics even when marked error', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
    });

    forward('agent_done', {
        text: '❌ ⏱️ 응답 없음 — unsafe AGY run_command broad home search',
        error: true,
        origin: 'web',
        target: tgTarget(123),
    });
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.includes('응답 없음'), true);
    assert.equal(sent[0].text.includes('broad home search'), true);
});

test('forwarder falls back to plain text when HTML send fails', async () => {
    const { bot, sent } = createBotSpy({ failHtmlOnce: true });
    const forward = createTelegramForwarder({
        bot,
    });

    forward('agent_done', { text: '**bold** <tag>', origin: 'web', target: tgTarget(777) });
    await flush();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].opts?.parse_mode, 'HTML');
    assert.equal(sent[0].text.includes('<b>bold</b>'), true);
    assert.equal(sent[1].opts, undefined);
    assert.equal(sent[1].text.includes('<b>'), false);
    assert.equal(sent[1].text.includes('bold'), true);
});

test('forwarder records an ambiguous text failure once without previewing or relaying images', async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-ambiguous.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const photos = [];
    const previews = [];
    const error = Object.assign(new Error('socket reset before response'), { code: 'ECONNRESET' });
    const bot = {
        api: {
            async sendMessage() { throw error; },
            async sendPhoto(...args) { photos.push(args); return { ok: true }; },
        },
    };
    const before = drainLogRing().length;
    const forward = createTelegramForwarder({ bot, log: (entry) => previews.push(entry) });

    try {
        forward('agent_done', {
            origin: 'web',
            text: `answer\n![generated](${imagePath})`,
            target: tgTarget(123),
        });
        await flush();

        assert.deepEqual(previews, []);
        assert.deepEqual(photos, []);
        const warnings = drainLogRing().slice(before).filter((entry) =>
            entry.level === 'warn' && entry.text.includes('[tg:forward] delivery failed'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].text, /"outcome":"unknown"/);
        assert.match(warnings[0].text, /"retryable":false/);
    } finally {
        fs.rmSync(imagePath, { force: true });
    }
});

test('forwarder records a known long rate limit once without previewing or relaying images', async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-rejected.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const photos = [];
    const previews = [];
    const rejection = Object.assign(new Error('Too Many Requests: retry later'), {
        error_code: 429,
        parameters: { retry_after: 30 },
    });
    const bot = {
        api: {
            async sendMessage() { throw rejection; },
            async sendPhoto(...args) { photos.push(args); return { ok: true }; },
        },
    };
    const before = drainLogRing().length;
    const forward = createTelegramForwarder({ bot, log: (entry) => previews.push(entry) });

    try {
        forward('agent_done', {
            origin: 'web',
            text: `answer\n![generated](${imagePath})`,
            target: tgTarget(123),
        });
        await flush();

        assert.deepEqual(previews, []);
        assert.deepEqual(photos, []);
        const warnings = drainLogRing().slice(before).filter((entry) =>
            entry.level === 'warn' && entry.text.includes('[tg:forward] delivery failed'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].text, /"outcome":"failed"/);
        assert.match(warnings[0].text, /"retryable":false/);
    } finally {
        fs.rmSync(imagePath, { force: true });
    }
});

test('forwarder requires body delivery when every format leg is rejected', async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-format-rejected.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const photos = [];
    const previews = [];
    const rejection = Object.assign(new Error('Bad Request: unsupported start tag'), { error_code: 400 });
    const bot = {
        api: {
            async sendMessage() { throw rejection; },
            async sendPhoto(...args) { photos.push(args); return { message_id: 1 }; },
        },
    };
    const before = drainLogRing().length;
    const forward = createTelegramForwarder({ bot, log: (entry) => previews.push(entry) });

    try {
        forward('agent_done', {
            origin: 'web',
            text: `answer\n![generated](${imagePath})`,
            target: tgTarget(123),
        });
        await flush();

        assert.deepEqual(previews, []);
        assert.deepEqual(photos, []);
        const warnings = drainLogRing().slice(before).filter((entry) =>
            entry.level === 'warn' && entry.text.includes('[tg:forward] delivery failed'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].text, /"outcome":"failed"/);
        assert.match(warnings[0].text, /"retryable":false/);
    } finally {
        fs.rmSync(imagePath, { force: true });
    }
});

test('forwarder logs success after format fallback and before image relay', { timeout: 2000 }, async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-success-order.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { bot, events, photoSent } = createBotSpy({ failHtmlOnce: true });
    const forward = createTelegramForwarder({
        bot,
        log: () => events.push('preview'),
    });

    try {
        forward('agent_done', {
            origin: 'web',
            text: `**answer**\n![generated](${imagePath})`,
            target: tgTarget(123),
        });
        await photoSent;

        assert.deepEqual(events, ['text', 'text', 'preview', 'photo']);
    } finally {
        fs.rmSync(imagePath, { force: true });
    }
});

test('forwarder handles mixed origin/error events deterministically', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
        shouldSkip: (data) => data.origin === 'telegram',
    });

    forward('agent_done', { text: 'skip telegram', origin: 'telegram', target: tgTarget(456) });
    forward('agent_done', { text: 'ok web', origin: 'web', target: tgTarget(456) });
    forward('agent_done', { text: 'skip error', origin: 'web', error: true, target: tgTarget(456) });
    forward('agent_done', { text: 'ok cli', origin: 'cli', target: tgTarget(456) });
    await flush();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, '📡 ok web');
    assert.equal(sent[1].text, '📡 ok cli');
});

test('forwarder chunks long messages into multiple sends', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
    });
    const longText = `**head**\n${'x'.repeat(5000)}`;

    forward('agent_done', { text: longText, origin: 'web', target: tgTarget(999) });
    await flush();

    assert.equal(sent.length >= 2, true);
    assert.equal(sent.every((msg) => msg.opts?.parse_mode === 'HTML'), true);
    assert.equal(sent.every((msg) => msg.chatId === '999'), true);
    assert.equal(sent[0].text.startsWith('📡 '), true);
});

test('forwarder does nothing when type is not agent_done or chatId is missing', async () => {
    const { bot, sent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
    });

    forward('agent_tool', { text: 'tool message', origin: 'web', target: tgTarget(123) });
    // No destination on the event: nothing to forward to.
    forward('agent_done', { text: 'done', origin: 'web' });
    await flush();

    assert.equal(sent.length, 0);
});

test('image relay activation: agent_done broadcast sends text then sendPhoto', { timeout: 2000 }, async () => {
    assert.ok(process.env["CLI_JAW_HOME"], 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = path.join(process.env["CLI_JAW_HOME"]!, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, 'relay-activation.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { bot, photos, events, photoSent } = createBotSpy();
    const forward = createTelegramForwarder({
        bot,
    });
    addBroadcastListener(forward);
    try {
        broadcast('agent_done', {
            origin: 'web',
            text: `ready\n![generated](${imagePath})`,
            target: tgTarget(123, '42'),
        });
        await photoSent;
        assert.deepEqual(events, ['text', 'photo']);
        assert.equal(photos.length, 1);
        assert.equal(photos[0].chatId, '123');
        assert.equal(photos[0].opts?.message_thread_id, 42);
    } finally {
        removeBroadcastListener(forward);
        fs.rmSync(imagePath, { force: true });
    }
});

test('image relay guard skips and logs a path outside allowed roots', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-relay-denied-'));
    const imagePath = path.join(outsideDir, 'denied.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { bot, sent, photos } = createBotSpy();
    const before = drainLogRing().length;
    const forward = createTelegramForwarder({ bot });
    try {
        const returnValue = forward('agent_done', {
            origin: 'web',
            text: `ready\n![denied](${imagePath})`,
            target: tgTarget(123),
        });
        assert.equal(returnValue, undefined, 'forwarder keeps a synchronous listener signature');
        await flush();
        assert.equal(sent.length, 1, 'text remains available');
        assert.equal(photos.length, 0, 'guarded image is not sent');
        assert.ok(
            drainLogRing().slice(before).some((entry) =>
                entry.level === 'warn' && entry.text.includes('[tg:image-relay] skipped')),
            'guard rejection must leave a warning',
        );
    } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('markdownToTelegramHtml converts markdown while preserving escaped html', () => {
    const html = markdownToTelegramHtml('**B** *I* `C` ~~S~~ <x>');
    assert.equal(html.includes('<b>B</b>'), true);
    assert.equal(html.includes('<i>I</i>'), true);
    assert.equal(html.includes('<code>C</code>'), true);
    assert.equal(html.includes('<s>S</s>'), true);
    assert.equal(html.includes('&lt;x&gt;'), true);
});

test('escapeHtmlTg escapes angle brackets and ampersands', () => {
    assert.equal(escapeHtmlTg('<a&b>'), '&lt;a&amp;b&gt;');
});

test('chunkTelegramMessage splits by newline when possible', () => {
    const input = 'line1\nline2\nline3\nline4';
    const chunks = chunkTelegramMessage(input, 10);
    assert.equal(chunks.length > 1, true);
    assert.equal(chunks.every((chunk) => chunk.length <= 10), true);
    assert.equal(chunks.join(''), input);
});

test('chunkTelegramMessage falls back to hard split without newlines', () => {
    const input = 'abcdefghij';
    const chunks = chunkTelegramMessage(input, 5);
    assert.deepEqual(chunks, ['abcde', 'fghij']);
});

test('createForwarderLifecycle attach/detach is idempotent', () => {
    const added = [];
    const removed = [];
    let buildCount = 0;

    const lifecycle = createForwarderLifecycle({
        addListener: (fn) => added.push(fn),
        removeListener: (fn) => removed.push(fn),
        buildForwarder: () => {
            buildCount += 1;
            return () => { };
        },
    });

    const first = lifecycle.attach({ bot: {} });
    const second = lifecycle.attach({ bot: {} });
    lifecycle.detach();
    lifecycle.detach();

    assert.equal(typeof first, 'function');
    assert.equal(first, second);
    assert.equal(buildCount, 1);
    assert.equal(added.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(lifecycle.getCurrent(), null);
});

test('createForwarderLifecycle can attach again after detach', () => {
    let buildCount = 0;
    const lifecycle = createForwarderLifecycle({
        buildForwarder: () => {
            buildCount += 1;
            return () => { };
        },
    });

    const first = lifecycle.attach();
    lifecycle.detach();
    const second = lifecycle.attach();

    assert.equal(typeof first, 'function');
    assert.equal(typeof second, 'function');
    assert.notEqual(first, second);
    assert.equal(buildCount, 2);
});
