// ─── Slack Forwarder ─────────────────────────────────
// Forwards agent_done results to Slack conversations.
// Mirrors src/discord/forwarder.ts; no client object is needed because the
// Slack outbound path is stateless HTTP.

import { reportSlackFailure, slackFailureRoutingEnabled, isSlackTurnFailure } from './failure-routing.js';
import { settings } from '../core/config.js';
import { log } from '../core/logger.js';
import { extractLocalImagePaths } from '../messaging/extract-images.js';
import type { RemoteTarget } from '../messaging/types.js';
import { basename } from 'node:path';
import { assertSendFilePath } from '../security/path-guards.js';
import { sendSlackFile } from './slack-file.js';
import { sendSlackText } from './send-only-client.js';
import { logErrorText } from '../messaging/redact.js';
import { renderAgentErrorBlock } from '../messaging/error-block.js';
import { resolveForwarderTarget } from '../messaging/forwarder-origin.js';
import { slackRecoveryBlocksRoot } from './tool-context.js';

export async function relaySlackImages(
    token: string,
    target: RemoteTarget,
    text: string,
    options: { signal?: AbortSignal } = {},
): Promise<void> {
    for (const candidate of extractLocalImagePaths(text)) {
        if (options.signal?.aborted) return;
        try {
            const filePath = assertSendFilePath(
                candidate,
                settings["workingDir"] || undefined,
                settings["projectDirs"] || null,
            );
            // The answer text was already posted by the caller; a bare file row
            // under it read as "empty message" in the field (#517). Caption with
            // the image's own name so the row says what it is, never the answer again.
            const result = await sendSlackFile(token, target, filePath, {
                caption: basename(filePath),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (!result.ok) {
                log.warn('[slack:image-relay] send failed', {
                    path: candidate,
                    error: result.error || 'unknown error',
                });
            }
        } catch (error: unknown) {
            log.warn('[slack:image-relay] skipped', {
                path: candidate,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export function createSlackForwarder(opts: {
    getToken: () => string | null;
    shouldSkip?: (data: Record<string, unknown>) => boolean;
    log?: (info: { channelId: string; preview: string }) => void;
    prefix?: string;
}) {
    return async (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_done' && slackFailureRoutingEnabled() && (isSlackTurnFailure(data)
            || slackRecoveryBlocksRoot(data['requestId'], resolveForwarderTarget(data, 'slack') ?? undefined))) {
            if (opts.shouldSkip?.(data)) return;
            const token = opts.getToken();
            const target = resolveForwarderTarget(data, 'slack');
            if (token && target) await reportSlackFailure(token, target, data['requestId'] ?? data['runId'] ?? data['traceRunId']);
            return;
        }
        const text = data?.["text"];
        if (type !== 'agent_done' || typeof text !== 'string' || !text) return;
        // A failure the classifier tagged is the one thing worth interrupting a
        // conversation with; every other error payload carries raw exception
        // text, a slice of the model's own output, or an internal diagnostic, and
        // those stay in the trace (#519).
        const errorBlock = data["error"] ? renderAgentErrorBlock(data) : null;
        if (data["error"] && !errorBlock) return;
        if (opts.shouldSkip?.(data)) return;
        // The run's own destination, or nothing. No last-active fallback: that
        // slot belongs to whoever spoke most recently, not to this run (#742).
        const target = resolveForwarderTarget(data, 'slack');
        const token = opts.getToken();
        if (!target?.targetId || !token) return;
        try {
            const body = errorBlock ?? text;
            const result = await sendSlackText(token, target, `${opts.prefix || ''}${body}`);
            if (!result.ok) {
                await reportSlackFailure(token, target, data['requestId'] ?? data['runId'], 'delivery');
                log.error('[slack:forward]', logErrorText(result.error || 'send failed'));
                return;
            }
            // An error block names no image; relaying would re-scan the failure text.
            if (!errorBlock) await relaySlackImages(token, target, text);
            opts.log?.({ channelId: target.targetId, preview: body.slice(0, 60) });
        } catch (e) {
            await reportSlackFailure(token, target, data['requestId'] ?? data['runId'], 'delivery');
            log.error('[slack:forward]', logErrorText(e));
        }
    };
}
