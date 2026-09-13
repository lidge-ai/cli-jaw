import test from 'node:test';
import assert from 'node:assert/strict';
import {
    __resetSessionState,
    createSession,
    enqueueWebAiSessionNotification,
    listNotifications,
    setSessionNotifyOnComplete,
    updateSessionResult,
} from '../../src/browser/web-ai/session.js';
import {
    drainPendingWebAiNotifications,
    formatWebAiNotification,
} from '../../src/browser/web-ai/notifications.js';

const envelope = { vendor: 'chatgpt' as const, prompt: 'notify', attachmentPolicy: 'inline-only' as const };

test('WEB-AI-NOTIFY-001: formatter includes provider, session, URL, and excerpt', () => {
    __resetSessionState();
    const s = createSession({ vendor: 'chatgpt', targetId: 'tn1', url: 'https://chatgpt.com/c/1', conversationUrl: 'https://chatgpt.com/c/1', envelope, assistantCount: 0, timeoutMs: 60_000 });
    setSessionNotifyOnComplete(s.sessionId, true);
    updateSessionResult({ sessionId: s.sessionId, status: 'complete', answerText: 'short answer', url: s.url, conversationUrl: s.conversationUrl });
    const event = listNotifications({ status: 'pending' })[0]!;
    const text = formatWebAiNotification(event);
    assert.match(text, /web-ai completed: chatgpt/);
    assert.match(text, new RegExp(s.sessionId));
    assert.match(text, /https:\/\/chatgpt\.com\/c\/1/);
    assert.match(text, /short answer/);
});

test('WEB-AI-NOTIFY-002: drain sends pending events and marks them sent', async () => {
    __resetSessionState();
    const s = createSession({ vendor: 'gemini', targetId: 'tn2', url: 'https://gemini.google.com/app/2', conversationUrl: 'https://gemini.google.com/app/2', envelope: { vendor: 'gemini', prompt: 'notify', attachmentPolicy: 'inline-only' }, assistantCount: 0, timeoutMs: 60_000 });
    setSessionNotifyOnComplete(s.sessionId, true);
    updateSessionResult({ sessionId: s.sessionId, status: 'complete', answerText: 'gemini answer', url: s.url, conversationUrl: s.conversationUrl });

    const sentTexts: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const result = await drainPendingWebAiNotifications(async (req) => {
        sentTexts.push(String(req.text || ''));
        seen.push(req as Record<string, unknown>);
        return { ok: true };
    });

    assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
    assert.equal(sentTexts.length, 1);
    assert.equal(seen[0]?.preferConfiguredTarget, true);
    assert.equal(seen[0]?.allowActiveFallback, false);
    assert.equal(listNotifications({ status: 'pending' }).length, 0);
    assert.equal(listNotifications({ status: 'sent' }).length, 1);
});

test('WEB-AI-NOTIFY-003: drain records failed delivery without retrying in the same pass', async () => {
    __resetSessionState();
    const s = createSession({ vendor: 'chatgpt', targetId: 'tn3', url: 'https://chatgpt.com/c/3', conversationUrl: 'https://chatgpt.com/c/3', envelope, assistantCount: 0, timeoutMs: 60_000 });
    setSessionNotifyOnComplete(s.sessionId, true);
    updateSessionResult({ sessionId: s.sessionId, status: 'complete', answerText: 'failed answer', url: s.url, conversationUrl: s.conversationUrl });

    const seen: Array<Record<string, unknown>> = [];
    const result = await drainPendingWebAiNotifications(async (req) => {
        seen.push(req as Record<string, unknown>);
        return { ok: false, error: 'no target' };
    });
    assert.equal(seen[0]?.preferConfiguredTarget, true);
    assert.equal(seen[0]?.allowActiveFallback, false);

    assert.deepEqual(result, { attempted: 1, sent: 0, failed: 1 });
    const failed = listNotifications({ status: 'failed' })[0];
    assert.equal(failed?.error, 'no target');
});

test('WEB-AI-NOTIFY-004: completion notification is once per session even if answer text changes', () => {
    __resetSessionState();
    const s = createSession({ vendor: 'chatgpt', targetId: 'tn4', url: 'https://chatgpt.com/c/4', conversationUrl: 'https://chatgpt.com/c/4', envelope, assistantCount: 0, timeoutMs: 60_000 });
    setSessionNotifyOnComplete(s.sessionId, true);
    updateSessionResult({ sessionId: s.sessionId, status: 'complete', answerText: 'first answer', url: s.url, conversationUrl: s.conversationUrl });
    updateSessionResult({ sessionId: s.sessionId, status: 'complete', answerText: 'second answer', url: s.url, conversationUrl: s.conversationUrl });

    assert.equal(listNotifications({ sessionId: s.sessionId }).length, 1);
});

test('WEB-AI-NOTIFY-005: formatter includes event type, capability, elapsed, and redacted reason/error', () => {
    __resetSessionState();
    const s = createSession({
        vendor: 'gemini',
        targetId: 'tn5',
        url: 'https://gemini.google.com/app/5',
        conversationUrl: 'https://gemini.google.com/app/5',
        envelope: { vendor: 'gemini', prompt: 'notify', attachmentPolicy: 'inline-only' },
        assistantCount: 0,
        timeoutMs: 60_000,
        capabilityMode: 'gemini-deep-think',
    });
    const event = enqueueWebAiSessionNotification({
        sessionId: s.sessionId,
        type: 'web-ai.session.stale',
        reason: 'watcher deadline reached for user@example.com',
        error: 'bearer abcdef0123456789',
        elapsedMs: 61_000,
    })!;

    const text = formatWebAiNotification(event);
    assert.match(text, /web-ai stale: gemini/);
    assert.match(text, /capability: gemini-deep-think/);
    assert.match(text, /elapsed: 1m 1s/);
    assert.match(text, /reason: watcher deadline reached for \[email redacted\]/);
    assert.match(text, /error: bearer \[redacted\]/);
});
