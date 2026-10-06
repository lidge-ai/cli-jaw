import { slackCredentialKey } from './tool-context.js';
// ─── Slack Send Handler ──────────────────────────────
// Adapts the channel-agnostic ChannelSendRequest to Slack's Web API.

import type { ChannelSendRequest } from '../messaging/send.js';
import { slackTargetFromId } from '../messaging/slack-target.js';
import { getSlackSendClient, resolveSlackDmChannel, sendSlackText } from './send-only-client.js';
import { sendSlackFile } from './slack-file.js';

export async function slackSendHandler(
    req: ChannelSendRequest,
): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const client = getSlackSendClient();
    if (!client.token) {
        return { ok: false, error: client.reason ?? 'slack_unavailable', status: client.status ?? 503 };
    }
    if (req.slackCredentialKey && slackCredentialKey(client.token) !== req.slackCredentialKey) return { ok: false, error: 'slack_credential_changed', status: 409, retryable: false };
    if (req.signal?.aborted) return { ok: false, error: 'slack_send_aborted', status: 499, retryable: false };
    const signalOpt = { ...(req.signal ? { signal: req.signal } : {}),
        ...(req.slackWriteGuard ? { writeGuard: req.slackWriteGuard } : {}) };
    let target = req.target;
    if (!target) return { ok: false, error: 'slack_target_missing', status: 400 };

    // A U... id is a user, not a conversation: open the DM first.
    if (target.targetId.toUpperCase().startsWith('U')) {
        const dm = await resolveSlackDmChannel(client.token, target.targetId);
        if (!dm.ok || !dm.channelId) {
            return { ok: false, error: dm.error || 'dm_open_failed', status: 502 };
        }
        target = slackTargetFromId(dm.channelId, target.threadId ? { threadTs: target.threadId } : {});
    }

    switch (req.type) {
        case 'text':
            if (!req.text) return { ok: false, error: 'empty_text', status: 400 };
            return sendSlackText(client.token, target, req.text, { ...signalOpt, ...(req.blocks ? { blocks: req.blocks } : {}) });
        case 'keyboard': {
            // Slack's inline-keyboard analogue is Block Kit, whose callbacks need
            // interactive-envelope routing this tree does not have, so
            // `interactiveActions` is declared false for Slack.
            //
            // This used to send the text anyway and say nothing. The message arrived
            // without its actions and the caller had no way to find out — a silent
            // loss of fidelity that read as success. Now the caller decides: opt in
            // with `interactiveFallback: 'text'` and get the text plus a recorded
            // downgrade, or get an explicit refusal.
            if (req.interactiveFallback !== 'text') {
                return {
                    ok: false,
                    error: 'interactive_actions_unsupported',
                    status: 501,
                    channel: 'slack',
                    unsupported: { operation: 'interactiveActions', reason: 'capability_not_declared' },
                };
            }
            if (!req.text) return { ok: false, error: 'empty_text', status: 400 };
            const result = await sendSlackText(client.token, target, req.text, signalOpt);
            return result.ok
                ? { ...result, downgraded: { operation: 'interactiveActions', to: 'text' } }
                : result;
        }
        case 'photo':
        case 'document':
        case 'voice': {
            if (!req.filePath) return { ok: false, error: 'missing_file_path', status: 400 };
            return sendSlackFile(client.token, target, req.filePath, { ...signalOpt, ...(req.caption ? { caption: req.caption } : {}) });
        }
        default:
            return { ok: false, error: `unsupported_outbound_type_${String(req.type)}`, status: 400 };
    }
}
