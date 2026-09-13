import { sendChannelOutput, type ChannelSendRequest } from '../../messaging/send.js';
import {
    listNotifications,
    markNotificationDelivered,
} from './session.js';
import { redactDiagnosticText } from './diagnostics.js';
import type { WebAiNotificationEvent } from './types.js';

export type WebAiNotificationSender = (req: ChannelSendRequest) => Promise<{ ok: boolean; error?: string }>;

export interface DrainWebAiNotificationsResult {
    attempted: number;
    sent: number;
    failed: number;
}

export async function drainPendingWebAiNotifications(
    sender: WebAiNotificationSender = sendChannelOutput,
): Promise<DrainWebAiNotificationsResult> {
    const pending = listNotifications({ status: 'pending' });
    let sent = 0;
    let failed = 0;
    for (const event of pending) {
        const result = await sender({
            channel: 'active',
            type: 'text',
            text: formatWebAiNotification(event),
            // Drained when a watcher finishes, which can be long after the request
            // that started it — by then last-active names an unrelated thread (#438).
            // Missing configured dest is failed delivery, not last-active.
            preferConfiguredTarget: true,
            allowActiveFallback: false,
        });
        if (result.ok) {
            sent += 1;
            markNotificationDelivered({ eventId: event.eventId, status: 'sent' });
        } else {
            failed += 1;
            markNotificationDelivered({ eventId: event.eventId, status: 'failed', error: result.error || 'send failed' });
        }
    }
    return { attempted: pending.length, sent, failed };
}

export function formatWebAiNotification(event: WebAiNotificationEvent): string {
    const title = notificationTitle(event);
    const lines = [
        `${title}: ${event.vendor}`,
        `session: ${event.sessionId}`,
    ];
    if (event.conversationUrl || event.url) lines.push(`url: ${event.conversationUrl || event.url}`);
    if (event.capabilityMode) lines.push(`capability: ${event.capabilityMode}`);
    if (typeof event.elapsedMs === 'number') lines.push(`elapsed: ${formatElapsed(event.elapsedMs)}`);
    if (event.reason) lines.push(`reason: ${redactDiagnosticText(event.reason, { maxChars: 240 })}`);
    if (event.error) lines.push(`error: ${redactDiagnosticText(event.error, { maxChars: 240 })}`);
    if (event.answerExcerpt) lines.push(`answer: ${redactDiagnosticText(event.answerExcerpt, { maxChars: 400 })}`);
    return lines.join('\n');
}

function notificationTitle(event: WebAiNotificationEvent): string {
    switch (event.type) {
        case 'web-ai.answer.completed':
            return 'web-ai completed';
        case 'web-ai.answer.failed':
            return 'web-ai failed';
        case 'web-ai.session.stale':
            return 'web-ai stale';
        case 'web-ai.capability.unsupported':
            return 'web-ai unsupported capability';
        case 'web-ai.provider.login-required':
            return 'web-ai login required';
    }
}

function formatElapsed(elapsedMs: number): string {
    const seconds = Math.max(0, Math.round(elapsedMs / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
