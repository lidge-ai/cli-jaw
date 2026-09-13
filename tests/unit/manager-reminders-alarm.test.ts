import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyReminderDue } from '../../src/manager/reminders/due-time.js';
import { dispatchReminderNotification } from '../../src/manager/reminders/dispatcher.js';
import { startRemindersScheduler } from '../../src/manager/reminders/scheduler.js';
import { RemindersStore } from '../../src/manager/reminders/store.js';

test('reminder due-time classifier handles due future invalid and attempted rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-reminders-due-'));
    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const due = store.createLocal({ title: 'Due', remindAt: '2026-05-09T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm1', port: 1 } });
        const future = store.createLocal({ title: 'Future', remindAt: '2026-05-10T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm2', port: 1 } });
        const invalid = store.createLocal({ title: 'Invalid', remindAt: 'not-a-date', link: { instanceId: 'port:1', messageId: 'm3', port: 1 } });
        store.markNotificationAttempt(future.id, 'no_channel', 'none', '2026-05-09T00:00:00.000Z');

        assert.equal(classifyReminderDue(due, new Date('2026-05-09T00:00:01.000Z')).status, 'due');
        assert.equal(classifyReminderDue(store.get(future.id)!, new Date('2026-05-09T00:00:01.000Z')).status, 'skipped');
        assert.equal(classifyReminderDue(invalid, new Date('2026-05-09T00:00:01.000Z')).status, 'invalid_remind_at');
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('RemindersStore lists only due pending reminders and exposes next due timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-reminders-due-store-'));
    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const due = store.createLocal({ title: 'Due', remindAt: '2026-05-09T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm1', port: 1 } });
        store.createLocal({ title: 'Later', remindAt: '2026-05-09T01:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm2', port: 1 } });
        const done = store.createLocal({ title: 'Done', status: 'done', remindAt: '2026-05-09T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm3', port: 1 } });
        store.markNotificationAttempt(done.id, 'delivered', null, '2026-05-09T00:00:00.000Z');

        const dueRows = store.listDueReminders('2026-05-09T00:30:00.000Z');
        assert.deepEqual(dueRows.map(row => row.id), [due.id]);
        assert.equal(store.getNextReminderDueAt(), '2026-05-09T00:00:00.000Z');
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('dispatchReminderNotification maps channel results to typed notification statuses and events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-reminders-dispatch-'));
    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const reminder = store.createLocal({ title: 'Send me', notes: 'body', remindAt: '2026-05-09T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm1', port: 1 } });
        const events: unknown[] = [];
        const seen: Array<Record<string, unknown>> = [];
        const delivered = await dispatchReminderNotification(reminder, {
            send: async (req) => { seen.push(req as Record<string, unknown>); return { ok: true }; },
            observability: { publish: event => events.push(event) },
            now: () => new Date('2026-05-09T00:00:01.000Z'),
        });
        assert.equal(delivered.status, 'delivered');
        assert.equal(events.length, 1);
        assert.equal(seen[0]?.preferConfiguredTarget, true);
        assert.equal(seen[0]?.allowActiveFallback, false);

        const noChannel = await dispatchReminderNotification(reminder, {
            send: async () => ({ ok: false, error: 'No target available for slack' }),
        });
        assert.equal(noChannel.status, 'no_channel');
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startRemindersScheduler uses a stoppable timeout tick and records delivery attempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-reminders-scheduler-'));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelay: number | undefined;
    const fakeHandle = { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    let clearCalled = false;

    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const due = store.createLocal({ title: 'Due', remindAt: '2026-05-09T00:00:00.000Z', link: { instanceId: 'port:1', messageId: 'm1', port: 1 } });
        const events: unknown[] = [];

        globalThis.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
            scheduledDelay = timeout;
            scheduledCallback = () => {
                if (typeof callback === 'function') callback(...args);
            };
            return fakeHandle;
        }) as typeof setTimeout;
        globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
            assert.equal(handle, fakeHandle);
            clearCalled = true;
        }) as typeof clearTimeout;

        const stop = startRemindersScheduler({
            intervalMs: 1,
            store,
            dispatcher: async () => ({ ok: true }),
            observability: { publish: event => events.push(event) },
            now: () => new Date('2026-05-09T00:00:01.000Z'),
        });
        assert.equal(scheduledDelay, 1000);
        assert.ok(scheduledCallback);

        scheduledCallback();
        await new Promise<void>(resolve => originalSetTimeout(resolve, 0));

        assert.equal(store.get(due.id)?.notificationStatus, 'delivered');
        assert.equal(events.length, 1);
        stop();
        assert.equal(clearCalled, true);
        store.close();
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        rmSync(dir, { recursive: true, force: true });
    }
});
