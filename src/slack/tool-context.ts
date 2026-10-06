import { createHash, randomBytes } from 'node:crypto';
import type { RemoteTarget } from '../messaging/types.js';

export const SLACK_TOOL_GRANT_ENV = 'JAW_SLACK_TURN_GRANT';
const GRANT_TTL_MS = 15 * 60_000;
const ENFORCED_GRANT_TTL_MS = 25 * 60_000;
const GRANT_CAP = 128;
export type SlackToolSource = {
    teamId: string;
    actorId: string;
    destination: RemoteTarget;
    credentialKey: string;
    actionToken?: string;
    /** Server-owned scheduled work keeps its destination constraint even under
     *  full-local Auto authority. Ordinary interactive turn grants omit this:
     *  Auto remains instance-wide for the trusted operator (#745). */
    enforceDestination?: boolean;
    /** The server alone publishes this heartbeat's final Slack response. */
    serverOwnedDelivery?: boolean;
};
export type SlackToolGrant = Readonly<SlackToolSource & { requestId: string; scope: string; chatSessionId: string; expiresAt: number; signal: AbortSignal }>;
type Entry = { grant: SlackToolGrant; secret: string; active: boolean; controller: AbortController; timer: ReturnType<typeof setTimeout> };
const requests = new Map<string, Entry>();
const secrets = new Map<string, Entry>();

export function slackCredentialKey(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** Authenticated ingress or a server-owned heartbeat supplies source; the HTTP
 * API itself cannot mint grants. */
export function reserveSlackToolGrant(source: SlackToolSource, binding: { requestId: string; scope: string; chatSessionId: string }): boolean {
    if (!/^[UW][A-Z0-9]{1,63}$/.test(source.actorId) || !/^T[A-Z0-9]{1,63}$/.test(source.teamId)
        || !/^[CGD][A-Z0-9]{1,63}$/.test(source.destination.targetId) || (source.actionToken !== undefined && source.actionToken.length > 8192)
        || source.destination.channel !== 'slack' || !binding.requestId
        || requests.has(binding.requestId) || requests.size >= GRANT_CAP) return false;
    const controller = new AbortController();
    const secret = `jaw-slack-grant-${randomBytes(32).toString('hex')}`;
    // A collector may wait 20 minutes for a legitimate long native turn.
    // Scheduled enforcement must outlive that owner; interactive grants retain
    // their existing 15-minute window.
    const ttlMs = source.enforceDestination === true ? ENFORCED_GRANT_TTL_MS : GRANT_TTL_MS;
    const grant: SlackToolGrant = Object.freeze({ ...source, destination: Object.freeze({ ...source.destination }), ...binding,
        expiresAt: Date.now() + ttlMs, signal: controller.signal });
    const timer = setTimeout(() => revokeSlackToolGrant(binding.requestId), ttlMs);
    timer.unref?.();
    const entry: Entry = { grant, secret, active: false, controller, timer };
    requests.set(binding.requestId, entry); secrets.set(secret, entry);
    return true;
}

/** Consume a reservation once before its dedicated process/acquisition launches. */
export function activateSlackToolGrant(requestId: string | undefined, scope: string, chatSessionId: string): string | undefined {
    const entry = requestId ? requests.get(requestId) : undefined;
    if (!entry || entry.active || entry.grant.scope !== scope || entry.grant.chatSessionId !== chatSessionId
        || entry.grant.expiresAt <= Date.now() || entry.controller.signal.aborted) return undefined;
    entry.active = true;
    return entry.secret;
}

export function resolveSlackToolGrant(secret: string): SlackToolGrant | null {
    const entry = secrets.get(secret);
    if (!entry || !entry.active || entry.controller.signal.aborted) return null;
    if (entry.grant.expiresAt <= Date.now()) { revokeSlackToolGrant(entry.grant.requestId); return null; }
    return entry.grant;
}

export function revokeSlackToolGrant(requestId: string | undefined | null): void {
    const entry = requestId ? requests.get(requestId) : undefined;
    if (!entry) return;
    requests.delete(entry.grant.requestId); secrets.delete(entry.secret);
    clearTimeout(entry.timer); entry.controller.abort();
}

export function revokeSlackToolScope(scope?: string): void {
    for (const [id, entry] of requests) if (scope === undefined || entry.grant.scope === scope) revokeSlackToolGrant(id);
}

/** Diagnostic/test view of a live server-owned destination reservation.
 *
 * This is not an authorization gate: process-global gating would block unrelated
 * interactive Slack sends while a long heartbeat runs. Every scheduled runtime
 * receives its own grant header instead. */
export function hasActiveEnforcedSlackDestination(): boolean {
    const now = Date.now();
    for (const entry of requests.values()) {
        if (entry.grant.enforceDestination === true
            && entry.grant.expiresAt > now
            && !entry.controller.signal.aborted) return true;
    }
    return false;
}

/** Channels leased by live server-owned heartbeat grants. Reservations count
 * from creation through revocation, including the time before activation. */
export function activeServerOwnedChannels(): Set<string> {
    const channels = new Set<string>();
    const now = Date.now();
    for (const entry of requests.values()) {
        if (entry.grant.serverOwnedDelivery === true && entry.grant.expiresAt > now
            && !entry.controller.signal.aborted) channels.add(entry.grant.destination.targetId);
    }
    return channels;
}

export function redactSlackToolSecrets(text: string): string {
    return text.replace(/jaw-slack-(?:grant|operator)-[a-f0-9]{64}/g, '[REDACTED_SLACK_TOOL_CREDENTIAL]');
}

/** Complete-line buffering prevents chunk boundaries from splitting credential masking. */
export function createSlackToolSecretStream(): (chunk: string, flush?: boolean) => string {
    let pending = '';
    let dropping = false;
    return (chunk, flush = false) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        const output: string[] = [];
        for (const line of lines) {
            if (dropping) { dropping = false; continue; }
            output.push(line.length > 8192 ? '[stderr truncated]' : redactSlackToolSecrets(line));
        }
        if (pending.length > 8192) { pending = ''; dropping = true; output.push('[stderr truncated]'); }
        if (flush) {
            if (pending && !dropping) output.push(redactSlackToolSecrets(pending));
            pending = ''; dropping = false;
        }
        return output.length ? output.join('\n') + '\n' : '';
    };
}
