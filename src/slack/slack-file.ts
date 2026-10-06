// ─── Slack File Upload ───────────────────────────────
// files.upload was SUNSET on 2025-11-12. The supported flow is:
//   1. files.getUploadURLExternal  -> { upload_url, file_id }
//   2. POST the bytes to upload_url (multipart, NOT a Slack API method:
//      no Authorization header, no ok:false envelope)
//   3. files.completeUploadExternal -> attaches file to a conversation
// Source: docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay

import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi, describeSlackError, redactSlackTokens, type SlackFetch } from './api.js';
import { redactOutboundText } from '../messaging/redact.js';
import {
    FILE_UNCONFIRMED_STATUS, SLACK_FILE_UNCONFIRMED, type FileConfirmation,
} from '../messaging/file-receipt.js';

// Slack's per-file ceiling is 1 GB, but a chat transport has no business
// streaming that. 50 MiB matches the inbound attachment cap the Discord
// transport already enforces.
export const SLACK_FILE_LIMIT = 50 * 1024 * 1024;

export function validateSlackFileSize(size: number) {
    if (size > SLACK_FILE_LIMIT) {
        throw Object.assign(
            new Error(`File exceeds Slack transport limit: ${(size / 1024 / 1024).toFixed(1)} MiB (max 50 MiB)`),
            { statusCode: 413 },
        );
    }
}

export type SlackFileUploadReceipt = {
    stage: 'validation' | 'reservation' | 'upload' | 'completion';
    state: 'failed' | 'unknown' | 'completed';
    channelId: string;
    threadTs?: string;
    fileId?: string;
    verification: 'not_checked';
};
export type SlackFileSendResult = {
    retryable: false;
    error?: string;
    status?: number;
    grantedScopes?: string;
    retryAfterMs?: number;
    /** The same top-level vocabulary the other two channels now speak. Slack's
     *  behaviour is unchanged: what used to be a bare `ok: false` for a
     *  completion with no `files[]` echo is still `ok: false`, and now also
     *  says WHY in a word every channel shares. */
    confirmation?: FileConfirmation;
} & ({
    ok: true; sent: true;
    upload: SlackFileUploadReceipt & { stage: 'completion'; state: 'completed'; fileId: string };
} | {
    ok: false; sent: boolean | 'unknown'; upload: SlackFileUploadReceipt;
});

export async function sendSlackFile(
    token: string, target: RemoteTarget, filePath: string,
    options: { caption?: string; fetchImpl?: SlackFetch; signal?: AbortSignal; writeGuard?: (channelId: string) => void } = {},
): Promise<SlackFileSendResult> {
    const doFetch = options.fetchImpl || fetch;
    const deadline = AbortSignal.timeout(120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let stage: SlackFileUploadReceipt['stage'] = 'validation';
    let fileId: string | undefined;
    const receipt = (state: SlackFileUploadReceipt['state']): SlackFileUploadReceipt => ({
        stage, state, channelId: target.targetId,
        ...(target.threadId ? { threadTs: target.threadId } : {}),
        ...(fileId ? { fileId } : {}), verification: 'not_checked',
    });
    const failure = (error: string, status = 502, state: 'failed' | 'unknown' = 'failed'): SlackFileSendResult => ({
        ok: false, sent: stage === 'completion' && state === 'unknown' ? 'unknown' : false,
        retryable: false, error: redactSlackTokens(error), status, upload: receipt(state),
    });
    if (signal.aborted) return failure('slack_send_aborted', 499);
    let fileStat;
    try { fileStat = await stat(filePath); }
    catch { return failure('File not found', 400); }
    if (!fileStat.isFile()) return failure('slack_file_not_regular', 400);
    try { validateSlackFileSize(fileStat.size); }
    catch { return failure('File exceeds Slack transport limit (max 50 MiB)', 413); }
    if (fileStat.size === 0) return failure('Cannot upload an empty file to Slack', 400);
    const safeFilename = redactOutboundText(basename(filePath));
    stage = 'reservation';
    if (signal.aborted) return failure('slack_send_aborted', 499);
    const reserve = await slackApi<{ upload_url?: string; file_id?: string }>(token,
        'files.getUploadURLExternal', { filename: safeFilename, length: fileStat.size },
        { fetchImpl: doFetch, form: true, signal, maxResponseBytes: 1024 * 1024 });
    const uploadUrl = reserve.data?.upload_url;
    const reservedId = reserve.data?.file_id;
    if (!reserve.ok || !reserve.status || reserve.status < 200 || reserve.status >= 300) {
        return { ...failure(describeSlackError(reserve.error || 'upload_url_missing', reserve.data), reserve.status),
            ...(reserve.grantedScopes !== undefined ? { grantedScopes: reserve.grantedScopes } : {}),
            ...(reserve.retryAfterMs !== undefined ? { retryAfterMs: reserve.retryAfterMs } : {}) };
    }
    if (typeof reservedId !== 'string' || !/^F[A-Z0-9]{1,100}$/.test(reservedId)
        || typeof uploadUrl !== 'string') return failure('slack_upload_reservation_invalid');
    try {
        const url = new URL(uploadUrl);
        if (url.protocol !== 'https:' || url.username || url.password) return failure('slack_upload_url_invalid');
    } catch { return failure('slack_upload_url_invalid'); }
    fileId = reservedId;
    stage = 'upload';
    try {
        if (signal.aborted) return failure('slack_send_aborted', 499);
        const handle = await open(filePath, 'r');
        let buffer: Buffer;
        try {
            const current = await handle.stat();
            if (!current.isFile() || current.size !== fileStat.size) return failure('slack_file_changed', 409);
            buffer = Buffer.alloc(fileStat.size + 1);
            let offset = 0;
            while (offset < buffer.length) {
                if (signal.aborted) return failure('slack_send_aborted', 499);
                const read = await handle.read(buffer, offset, buffer.length - offset, offset);
                if (!read.bytesRead) break;
                offset += read.bytesRead;
            }
            if (offset !== fileStat.size) return failure('slack_file_changed', 409);
            buffer = buffer.subarray(0, offset);
        } finally { await handle.close(); }
        if (signal.aborted) return failure('slack_send_aborted', 499);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(buffer)]), safeFilename);
        const upload = await doFetch(uploadUrl, { method: 'POST', body: form, signal });
        if (!upload.ok) return failure(`Slack upload failed (${upload.status})`, upload.status);
    } catch (error) {
        return signal.aborted || (error as Error)?.name === 'AbortError'
            ? failure('slack_send_aborted', 499) : failure('slack_file_upload_failed');
    }
    stage = 'completion';
    if (signal.aborted) return failure('slack_send_aborted', 499);
    options.writeGuard?.(target.targetId);
    const complete = await slackApi(token, 'files.completeUploadExternal', {
        files: [{ id: fileId, title: safeFilename }], channel_id: target.targetId,
        ...(target.threadId ? { thread_ts: target.threadId } : {}),
        ...(options.caption?.trim() ? { initial_comment: redactOutboundText(options.caption.trim()) } : {}),
    }, { fetchImpl: doFetch, signal, maxResponseBytes: 1024 * 1024 });
    const httpOk = complete.status !== undefined && complete.status >= 200 && complete.status < 300;
    if (!complete.ok || !httpOk) {
        const knownRefusal = httpOk && complete.data?.['ok'] === false && typeof complete.data?.['error'] === 'string';
        return { ...failure(describeSlackError(complete.error, complete.data), complete.status, knownRefusal ? 'failed' : 'unknown'),
            ...(complete.grantedScopes !== undefined ? { grantedScopes: complete.grantedScopes } : {}),
            ...(complete.retryAfterMs !== undefined ? { retryAfterMs: complete.retryAfterMs } : {}) };
    }
    const files = complete.data?.['files'];
    // A completion reply without a files[] echo proves nothing about the file
    // reaching the channel: an intermediary that answers {"ok":true} would be
    // reported as a delivered upload. Confirmation requires the reserved id back.
    if (!Array.isArray(files) || !files.length
        || !files.every(row => row && typeof row === 'object' && typeof row.id === 'string' && /^F[A-Z0-9]{1,100}$/.test(row.id))
        || !files.some(row => row.id === fileId)) {
        return { ...failure(SLACK_FILE_UNCONFIRMED, FILE_UNCONFIRMED_STATUS, 'unknown'), confirmation: 'unconfirmed' };
    }
    const upload = { ...receipt('completed'), stage: 'completion' as const, state: 'completed' as const, fileId: reservedId };
    if (signal.aborted) return { ok: false, sent: true, retryable: false, upload, error: 'slack_send_aborted', status: 499 };
    return { ok: true, sent: true, retryable: false, upload, confirmation: 'confirmed' };
}
