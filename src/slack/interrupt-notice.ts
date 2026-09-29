import type { IngressEventRecord } from '../messaging/durable-ingress.js';
import { isRemoteTarget, type RemoteTarget } from '../messaging/types.js';
import type { SlackHistoryResult } from './history.js';

export type InterruptNoticeDeps = {
    rows: IngressEventRecord[];
    mark: (row: IngressEventRecord, outcome: 'answered' | 'notified' | `skipped:${string}`) => void;
    hasQueued: (target: RemoteTarget) => boolean;
    hasActiveRun: (target: RemoteTarget) => boolean;
    hasBgTask: (target: RemoteTarget) => boolean;
    replies: (target: RemoteTarget, messageTs: string, cursor?: string) => Promise<SlackHistoryResult>;
    send: (target: RemoteTarget, text: string) => Promise<{ ok: boolean }>;
    selfUserId: string | null;
    /** auth.test bot_id; our own answers post as the bot, not the user. */
    selfBotId: string | null;
    locale: 'ko' | 'en';
    isCurrent: () => boolean;
    sleep?: (ms: number) => Promise<void>;
};

const COPY = {
    ko: '서버가 재시작되면서 이 요청 처리가 중단됐어요. 아직 필요하면 다시 멘션해 주세요.',
    en: 'The server restarted while this request was in progress, so it was stopped. Mention me again if you still need it.',
};

/** A conservative, bounded check: missing evidence never authorizes a post. */
export async function noticeInterruptedSlackRequests(deps: InterruptNoticeDeps): Promise<void> {
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (const [index, row] of deps.rows.entries()) {
        if (!deps.isCurrent()) return;
        const mark = (outcome: 'answered' | 'notified' | `skipped:${string}`) => deps.mark(row, outcome);
        if (index >= 20) { mark('skipped:cap'); continue; }
        let target: unknown;
        try { target = JSON.parse(row.targetJson ?? ''); }
        catch { mark('skipped:bad_target'); continue; }
        if (!isRemoteTarget(target) || target.channel !== 'slack') {
            mark('skipped:bad_target'); continue;
        }
        if (!target.threadId) { mark('skipped:root_placement'); continue; }
        const messageTs = row.eventId.slice(row.eventId.lastIndexOf(':') + 1);
        if (!/^\d+\.\d+$/.test(messageTs)) { mark('skipped:bad_target'); continue; }
        // Without a self identity no reply can be recognized as ours, and a
        // guessed 'answered' would bury an interrupted request for good. The
        // thread is not even read in that case.
        if (!deps.selfUserId && !deps.selfBotId) { mark('skipped:unknown_self'); continue; }
        try {
            if (deps.hasQueued(target)) { mark('skipped:queued'); continue; }
            if (deps.hasActiveRun(target)) { mark('skipped:active_run'); continue; }
            if (deps.hasBgTask(target)) { mark('skipped:bg_task'); continue; }
            let cursor: string | undefined;
            let answered = false;
            let complete = false;
            for (let page = 0; page < 10; page++) {
                if (!deps.isCurrent()) return;
                if (page > 0) await sleep(1000);
                const result = await deps.replies(target, messageTs, cursor);
                if (!result.ok) break;
                if (result.messages.some(message =>
                    (!!deps.selfUserId && message.user === deps.selfUserId)
                    || (!!deps.selfBotId && message.botId === deps.selfBotId))) {
                    answered = true; break;
                }
                if (!result.hasMore) { complete = true; break; }
                if (!result.nextCursor || result.nextCursor === cursor) break;
                cursor = result.nextCursor;
            }
            if (!deps.isCurrent()) return;
            if (answered) { mark('answered'); continue; }
            if (!complete) { mark('skipped:inconclusive'); continue; }
            let sent: { ok: boolean };
            try { sent = await deps.send(target, COPY[deps.locale]); }
            catch { mark('skipped:send_failed'); continue; }
            if (!deps.isCurrent()) return;
            mark(sent.ok ? 'notified' : 'skipped:send_failed');
        } catch {
            if (deps.isCurrent()) mark('skipped:inconclusive');
        }
    }
}
