import { sendChannelOutput, type ChannelSendRequest } from '../../messaging/send.js';
import type { Observability } from '../observability.js';
import type { DashboardReminder, DashboardReminderNotificationStatus } from './store.js';

export type ReminderDispatchResult = {
    reminderId: string;
    status: DashboardReminderNotificationStatus;
    error: string | null;
    at: string;
};

export type ReminderDispatcherOptions = {
    send?: (request: ChannelSendRequest) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
    observability?: Pick<Observability, 'publish'>;
    log?: (message: string) => void;
    now?: () => Date;
};

function reminderText(reminder: DashboardReminder): string {
    const lines = [`Reminder: ${reminder.title}`];
    if (reminder.notes) lines.push('', reminder.notes);
    if (reminder.remindAt) lines.push('', `Remind: ${reminder.remindAt}`);
    if (reminder.dueAt) lines.push(`Due: ${reminder.dueAt}`);
    if (reminder.port || reminder.messageId) {
        const source = [
            reminder.port ? `port:${reminder.port}` : null,
            reminder.messageId ? `message:${reminder.messageId}` : null,
            reminder.turnIndex !== null ? `turn:${reminder.turnIndex}` : null,
        ].filter(Boolean).join(' ');
        if (source) lines.push(`Source: ${source}`);
    }
    return lines.join('\n');
}

function statusFromSendResult(result: { ok: boolean; error?: string }): DashboardReminderNotificationStatus {
    if (result.ok) return 'delivered';
    const error = result.error || '';
    return error.includes('No target available') || error.includes('No send transport registered')
        ? 'no_channel'
        : 'failed';
}

export async function dispatchReminderNotification(
    reminder: DashboardReminder,
    options: ReminderDispatcherOptions = {},
): Promise<ReminderDispatchResult> {
    const send = options.send ?? sendChannelOutput;
    const at = (options.now ?? (() => new Date()))().toISOString();
    // A reminder fires on a schedule, so "the active conversation" at that moment
    // is whoever happened to message the bot last — not the person who set the
    // reminder. Resolve to the configured channel instead (#438).
    const result = await send({
        channel: 'active', type: 'text', text: reminderText(reminder),
        preferConfiguredTarget: true,
        allowActiveFallback: false,
    });
    const status = statusFromSendResult(result);
    const error = result.ok ? null : result.error || 'send failed';
    if (status !== 'delivered') options.log?.(`[reminders-dispatch] ${status} ${reminder.id}: ${error}`);
    options.observability?.publish({ kind: 'reminder-delivery', reminderId: reminder.id, status, error, at });
    return { reminderId: reminder.id, status, error, at };
}
