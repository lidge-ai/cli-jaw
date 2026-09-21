// Remote /stop /queue /approve /deny (M4-A1).
//
// These four are the only commands that go through messaging access-policy.
// /status and /new keep the channel allowlists they already have.

import { currentSessionScope } from '../../core/session-context.js';
import { isAgentBusy, killActiveAgent, getQueuedMessageSnapshotForScope, removeQueuedMessage } from '../../agent/spawn.js';
import { EXPLICIT_USER_STOP_KILL_REASON } from '../../agent/spawn/kill-reason.js';
import { handleApprovalCommand } from '../../core/dispatch-approval-ingress.js';
import { settings } from '../../core/config.js';
import { evaluateMessagingAccess, type MessagingAccessPolicy } from '../../messaging/access-policy.js';
import { resolveRemoteCommandContext, type RemoteCommandContext } from '../../messaging/remote-command-context.js';
import { readSessionGeneration } from '../../core/session-generation.js';
import type { MessengerChannel } from '../../messaging/types.js';
import type { SlashResult } from '../types.js';

const PRIVILEGED = new Set(['stop', 'queue', 'approve', 'deny']);

export function isPrivilegedRemoteCommand(name: string): boolean {
    return PRIVILEGED.has(name);
}

function policyFor(channel: MessengerChannel): MessagingAccessPolicy {
    const operators = settings["dispatchApproval"]?.operators?.[channel];
    const allowlist = Array.isArray(operators) ? operators.map(String) : [];
    return allowlist.length > 0 ? { mode: 'allowlist', allowlist } : { mode: 'deny' };
}

export function authorizePrivilegedRemote(
    name: string,
    input: {
        channel: MessengerChannel;
        actorId?: string;
        conversationKey?: string;
        chatSessionId?: string;
    },
): { ok: true; context: RemoteCommandContext } | { ok: false; text: string } {
    if (!isPrivilegedRemoteCommand(name)) {
        throw new Error(`authorizePrivilegedRemote called for ${name}`);
    }
    let generation = 0;
    if (input.chatSessionId) {
        try { generation = readSessionGeneration({ chatSessionId: input.chatSessionId, conversationKey: input.conversationKey || '' }); }
        catch { return { ok: false, text: '❌ unknown session' }; }
    }
    const resolved = resolveRemoteCommandContext({ ...input, generation });
    if (!resolved.ok) return { ok: false, text: `❌ missing ${resolved.field}` };
    const decision = evaluateMessagingAccess(
        { actorId: resolved.context.actorId, conversationKey: resolved.context.conversationKey },
        policyFor(resolved.context.channel),
    );
    if (decision !== 'allow') return { ok: false, text: '❌ not allowed' };
    return { ok: true, context: resolved.context };
}

function scopeKey(): string {
    return currentSessionScope()?.scope ?? 'default';
}

export async function remoteStopHandler(): Promise<SlashResult> {
    const scope = scopeKey();
    const busy = isAgentBusy(scope);
    if (!busy) return { ok: true, text: 'already_stopped' };
    killActiveAgent(scope, EXPLICIT_USER_STOP_KILL_REASON);
    return { ok: true, text: `⏹️ stopped ${scope}` };
}

export async function remoteQueueHandler(args: string[]): Promise<SlashResult> {
    const scope = scopeKey();
    const action = (args[0] || 'list').toLowerCase();
    const items = getQueuedMessageSnapshotForScope(scope);
    if (action === 'list' || action === '') {
        if (items.length === 0) return { ok: true, text: '(empty queue)' };
        const lines = items.map((item, i) => `${i + 1}. ${item.id.slice(0, 8)} ${item.prompt.slice(0, 60)}`);
        return { ok: true, text: lines.join('\n') };
    }
    if (action === 'drop') {
        const n = Number(args[1]);
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
            return { ok: false, text: '❌ Usage: /queue drop <n>' };
        }
        const target = items[n - 1]!;
        const result = removeQueuedMessage(target.id);
        if (!result.removed) return { ok: false, text: '❌ queue item gone' };
        return { ok: true, text: `dropped ${target.id.slice(0, 8)}` };
    }
    return { ok: false, text: '❌ Usage: /queue [list|drop <n>]' };
}

export async function remoteApproveHandler(args: string[], ctx: Record<string, unknown> = {}): Promise<SlashResult> {
    return runApprovalText('approve', args, ctx);
}

export async function remoteDenyHandler(args: string[], ctx: Record<string, unknown> = {}): Promise<SlashResult> {
    return runApprovalText('deny', args, ctx);
}

function runApprovalText(
    verb: 'approve' | 'deny',
    args: string[],
    ctx: Record<string, unknown>,
): SlashResult {
    const rawText = typeof ctx['rawText'] === 'string' ? ctx['rawText'] : `/${verb} ${args.join(' ')}`;
    const raw = rawText.replace(/^\//, '');
    // Public /deny is the existing cancel transition. Digest stays required.
    const normalized = raw.replace(/^deny\b/i, 'cancel');
    const result = handleApprovalCommand(
        ctx["approvalTransport"] as never,
        ctx["approvalEvent"],
        normalized,
    );
    if (!result.handled) return { ok: false, text: `❌ Usage: /${verb} <jti> <digest>` };
    if (result.approved) return { ok: true, text: 'approved' };
    return { ok: false, text: result.reason || 'rejected' };
}
