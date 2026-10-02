import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createReminderBadgePoller } from '../../electron/src/main/lib/reminder-badge.ts';
import type { TrayReminderDateItem } from '../../src/shared/reminders/tray-triage.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const originalFetch = globalThis.fetch;

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function item(partial: Partial<TrayReminderDateItem> = {}): TrayReminderDateItem {
    return {
        status: partial.status ?? 'open',
        dueAt: partial.dueAt ?? null,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

test.after(() => {
    globalThis.fetch = originalFetch;
});

test('badge poller maps reminder feed to overdue plus today count', async () => {
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9).toISOString();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18).toISOString();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).toISOString();
    let badge = -1;
    globalThis.fetch = async () => jsonResponse({
        ok: true,
        items: [
            item({ dueAt: yesterday }),
            item({ dueAt: today }),
            item({ dueAt: tomorrow }),
            item({ status: 'done', dueAt: today }),
        ],
    });

    const poller = createReminderBadgePoller({
        managerUrl: 'http://127.0.0.1:24577/',
        setBadge: count => { badge = count; },
    });

    await poller.refreshNow();
    assert.equal(badge, 2);
});

test('badge poller logs failures and does not throw', async () => {
    const logs: string[] = [];
    globalThis.fetch = async () => jsonResponse({ ok: false }, 500);
    const poller = createReminderBadgePoller({
        managerUrl: 'http://127.0.0.1:24577/',
        setBadge: () => { throw new Error('setBadge should not run'); },
        log: message => logs.push(message),
    });

    await assert.doesNotReject(() => poller.refreshNow());
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /^\[jaw-tray\] badge refresh failed:/);
});

test('badge poller coalesces overlapping refreshes', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return await new Promise<Response>(resolve => { resolveFetch = resolve; });
    };
    const poller = createReminderBadgePoller({
        managerUrl: 'http://127.0.0.1:24577/',
        setBadge: () => undefined,
    });

    const first = poller.refreshNow();
    const second = poller.refreshNow();
    resolveFetch?.(jsonResponse({ ok: true, items: [] }));
    await Promise.all([first, second]);

    assert.equal(fetchCount, 1);
});

test('badge poller abandons a hung request instead of stalling forever', async () => {
    const logs: string[] = [];
    let fetchCount = 0;
    globalThis.fetch = (_url: unknown, init?: RequestInit) => {
        fetchCount += 1;
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
    };
    const poller = createReminderBadgePoller({
        managerUrl: 'http://127.0.0.1:24577/',
        setBadge: () => {},
        log: message => logs.push(message),
        requestTimeoutMs: 30,
    });

    await assert.doesNotReject(() => poller.refreshNow());
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /badge refresh failed:.*(Aborted|abort)/i);

    // The next refresh must issue a real fetch — a stale inFlight latch would
    // return the same already-settled promise and never reach fetch again.
    await poller.refreshNow();
    assert.equal(fetchCount, 2);
});

test('main process starts and stops reminder badge polling with manager lifecycle', () => {
    const index = read('electron/src/main/index.ts');
    const badge = read('electron/src/main/lib/reminder-badge.ts');

    assert.ok(index.includes('createReminderBadgePoller'));
    assert.ok(index.includes('startTrayReminderBadgePolling();'));
    assert.ok(index.includes('stopTrayReminderBadgePolling();'));
    assert.ok(index.includes('markManagerRunning'));
    assert.ok(index.includes('reminderBadgePoller?.stop();'));
    assert.ok(index.includes('reminderBadgePoller?.refreshNow();'));
    assert.ok(badge.includes("new URL('/api/dashboard/reminders', opts.managerUrl)"));
    assert.ok(badge.includes('countTrayReminderBadgeItems'));
    assert.ok(badge.includes('setTimeout'));
});

test('badge poller drops a request that settles after stop and refetches after restart', async () => {
    const releases: Array<(response: Response) => void> = [];
    const signals: AbortSignal[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>(resolve => releases.push(resolve));
    }) as typeof fetch;
    const badges: number[] = [];
    const logs: string[] = [];
    const poller = createReminderBadgePoller({
        managerUrl: 'http://127.0.0.1:1',
        setBadge: count => badges.push(count),
        log: message => logs.push(message),
        intervalMs: 60_000,
        requestTimeoutMs: 60_000,
    });
    try {
        const stale = poller.refreshNow();
        poller.stop();
        assert.equal(signals[0]?.aborted, true, 'stop aborts the in-flight request');
        releases[0]!(jsonResponse({ ok: true, items: [item({ dueAt: new Date().toISOString() })] }));
        await stale;
        assert.deepEqual(badges, [], 'a result from before stop must not reach the badge');
        assert.deepEqual(logs, [], 'the aborted request is not reported as a failure');

        const fresh = poller.refreshNow();
        assert.equal(releases.length, 2, 'after stop a refresh issues a new request instead of joining the old one');
        releases[1]!(jsonResponse({ ok: true, items: [] }));
        await fresh;
        assert.deepEqual(badges, [0]);
    } finally {
        poller.stop();
        globalThis.fetch = originalFetch;
    }
});

