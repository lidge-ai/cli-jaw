import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemindersStore } from '../../src/manager/reminders/store.js';
import { dispatchReminderNotification } from '../../src/manager/reminders/dispatcher.js';

const slackTarget = (targetId = 'C_CURRENT', threadId = '1710000000.000100') => ({
    channel: 'slack' as const,
    targetKind: 'channel' as const,
    peerKind: 'channel' as const,
    targetId,
    ...(threadId ? { threadId } : {}),
});

async function withIsolatedSlack(
    run: (capture: { requests: Array<Record<string, unknown>> }) => Promise<void>,
    channelIds: string[] = [],
) {
    const { settings } = await import('../../src/core/config.js');
    const { registerSendTransport } = await import('../../src/messaging/send.js');
    const { clearTargetState } = await import('../../src/messaging/runtime.js');
    const previousSlack = settings.slack;
    const previousChannel = settings.channel;
    const previousMessaging = settings.messaging;
    const capture = { requests: [] as Array<Record<string, unknown>> };
    try {
        clearTargetState();
        settings.channel = 'slack';
        settings.messaging = { ...(settings.messaging || {}), homeChannel: 'slack', enabledChannels: ['slack'] };
        settings.slack = { ...(settings.slack || {}), channelIds };
        registerSendTransport('slack', async req => {
            capture.requests.push(structuredClone(req) as Record<string, unknown>);
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

test('scheduled reminder plus empty allowlist does not inherit last-active C_CURRENT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-sched-dest-'));
    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const reminder = store.createLocal({
            title: 'Send me',
            remindAt: '2026-05-09T00:00:00.000Z',
            link: { instanceId: 'port:1', messageId: 'm1', port: 1 },
        });
        await withIsolatedSlack(async capture => {
            const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
            setLastActiveTarget('slack', slackTarget('C_CURRENT'));
            const result = await dispatchReminderNotification(reminder);
            assert.equal(result.status, 'no_channel');
            assert.equal(capture.requests.length, 0);
        });
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('scheduled reminder uses configured dest and ignores last-active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-sched-cfg-'));
    try {
        const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
        const reminder = store.createLocal({
            title: 'Send me',
            remindAt: '2026-05-09T00:00:00.000Z',
            link: { instanceId: 'port:1', messageId: 'm1', port: 1 },
        });
        await withIsolatedSlack(async capture => {
            const { setLastActiveTarget } = await import('../../src/messaging/runtime.js');
            setLastActiveTarget('slack', slackTarget('C_CURRENT'));
            const result = await dispatchReminderNotification(reminder);
            assert.equal(result.status, 'delivered');
            assert.equal(capture.requests.length, 1);
            assert.equal((capture.requests[0]?.target as { targetId?: string } | undefined)?.targetId, 'C_CONFIGURED');
            assert.notEqual((capture.requests[0]?.target as { targetId?: string } | undefined)?.targetId, 'C_CURRENT');
        }, ['C_CONFIGURED']);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
