import { readSlackAllowlist, MALFORMED_SLACK_ALLOWLIST } from './events.js';

// ─── Slack OAuth scope drift ────────────────────────
// A Slack app created from an older cli-jaw manifest keeps its original grant
// forever. Adding a scope to `manifest.ts` changes what NEW apps get; it does
// nothing for an app already installed. The transport then connects, health
// reports ok, messages are answered — and every users.info/conversations.info
// call fails with missing_scope, so senders degrade to raw ids.
//
// The gap is knowable for free: Slack returns the token's whole granted set in
// the `x-oauth-scopes` header of every Web API response, and the transport
// already calls auth.test on every start. This module owns the resulting state
// so doctor, /api/health and the identity warning all read one answer instead
// of computing three.
//
// Reported as #340.
import {
    missingSlackScopes,
    missingSlackCapabilityScopes,
} from '../messaging/channel-validate.js';

export type SlackScopeStatus = {
    /** False only when a check actually ran and found a **required** gap. */
    ok: boolean;
    /**
     * True when no `x-oauth-scopes` has ever been observed, so the answer is
     * "cannot check" rather than "nothing missing". Kept separate from `ok`
     * so a header-stripping proxy cannot masquerade as a clean bill of health.
     */
    unknown: boolean;
    /** Missing scopes the transport genuinely needs, in required-list order. */
    missingRequired: string[];
    /** Missing scopes that degrade a feature without breaking messaging. */
    missingCapabilities: string[];
    /** Reinstall URL when the app id is known; null otherwise. */
    reinstallUrl: string | null;
    /** Epoch ms of the last observation, or null if never observed. */
    checkedAt: number | null;
};

const UNOBSERVED: SlackScopeStatus = {
    ok: true,
    unknown: true,
    missingRequired: [],
    missingCapabilities: [],
    reinstallUrl: null,
    checkedAt: null,
};

let current: SlackScopeStatus = { ...UNOBSERVED };

/**
 * Record what Slack said about this token's grant.
 *
 * `granted` is the raw header. `undefined` leaves the status unknown rather
 * than clearing it: not observing a thing is not evidence about the thing.
 */
export function recordSlackScopeObservation(
    granted: string | undefined,
    appId?: string | null,
): void {
    if (granted === undefined) {
        current = {
            ...UNOBSERVED,
            reinstallUrl: slackReinstallUrl(appId),
        };
        return;
    }
    const missingRequired = missingSlackScopes(granted);
    const missingCapabilities = missingSlackCapabilityScopes(granted);
    current = {
        ok: missingRequired.length === 0,
        unknown: false,
        missingRequired,
        missingCapabilities,
        reinstallUrl: slackReinstallUrl(appId),
        checkedAt: Date.now(),
    };
}

export function getSlackScopeStatus(): SlackScopeStatus {
    return { ...current };
}

/** A re-init may authenticate against a different workspace. */
export function resetSlackScopeStatus(): void {
    current = { ...UNOBSERVED };
}

/**
 * Slack does not return the app id from auth.test, so this is null for most
 * installs. An invented URL is worse than none — a wrong app id sends the
 * operator to someone else's app — so the caller falls back to prose.
 */
function slackReinstallUrl(appId?: string | null): string | null {
    const id = String(appId ?? '').trim();
    if (!id) return null;
    return `https://api.slack.com/apps/${id}/install-on-team`;
}

/** One reportable group of missing scopes, carrying its own severity. */
export type SlackScopeGapLine = {
    /** `warn` only when the transport actually cannot do its job. */
    level: 'warn' | 'info';
    text: string;
};

/**
 * Operator-facing lines for the missing scopes, one per severity, or an empty
 * array when there is nothing to say. Empty for the unknown case is deliberate:
 * a warning that fires when we did not measure anything trains people to
 * ignore warnings.
 *
 * Required and optional are reported SEPARATELY because they are different
 * claims. Concatenating them let one severity word govern both lists, so a
 * single missing `chat:write` promoted every optional scope to "the transport
 * needs", and an app missing only optional ones announced a `missing 4
 * scope(s)` count at WARN while the socket was connected and answering (#478).
 * A count that mixes an outage with a degradation is not a count anyone can act
 * on.
 */
export function describeSlackScopeGaps(status: SlackScopeStatus): SlackScopeGapLine[] {
    if (status.unknown) return [];
    const where = status.reinstallUrl
        ? `reinstall: ${status.reinstallUrl}`
        : 'add them under OAuth & Permissions, then reinstall the app to your workspace';
    const lines: SlackScopeGapLine[] = [];
    if (status.missingRequired.length > 0) {
        lines.push({
            level: 'warn',
            text: `the transport needs ${status.missingRequired.length} scope(s): `
                + `${status.missingRequired.join(', ')} — ${where}`,
        });
    }
    if (status.missingCapabilities.length > 0) {
        // info, not warn: existing IM/channel messaging can work without these. The operator who read
        // the old WARN had no way to tell that from a broken transport, and
        // reinstalled the app to find out.
        lines.push({
            level: 'info',
            text: `${status.missingCapabilities.length} optional scope(s) not granted: `
                + `${status.missingCapabilities.join(', ')} — `
                + (() => {
                    const parts: string[] = [];
                    if (status.missingCapabilities.includes('mpim:history')) {
                        parts.push('group DM reception is unavailable (message.mpim requires mpim:history); existing IM/channel messaging can continue');
                    } else {
                        parts.push('some optional features are unavailable');
                    }
                    const others = status.missingCapabilities.filter(s => s !== 'mpim:history');
                    if (others.length) parts.push(`also missing: ${others.join(', ')}`);
                    return parts.join('; ') + '; ';
                })()
                + where,
        });
    }
    return lines;
}

// ─── Inbound conversation scope ─────────────────────

export type SlackChannelScope = {
    ids: string[];
    scope: 'all_conversations' | 'malformed' | `allowlist_${number}`;
};

/**
 * How wide the inbound allowlist is, as a value a reporter can print.
 *
 * An empty `channelIds` means "every conversation" — the shipped default and a
 * normal way to run. doctor used to call that state `missing_channel_ids` and
 * degrade on it, which is why it passed during the incident it should have
 * caught: the list had exactly one entry, so it read as configured (#406).
 *
 * Kept as a pure function so tests can assert the judgment without importing
 * `bin/commands/doctor.ts`, which runs its whole diagnostic at import time.
 */
export function slackChannelScope(channelIds: unknown): SlackChannelScope {
    // Read it the way the gate reads it. Counting the raw array instead was its
    // own kind of silence: doctor would report allowlist_3 for [" C1 ","C1",""]
    // while the gate matched one channel, and all_conversations for a malformed
    // value the gate was refusing outright (#406).
    const ids = readSlackAllowlist(channelIds);
    if (ids.length === 1 && ids[0] === MALFORMED_SLACK_ALLOWLIST) {
        return { ids: [], scope: 'malformed' };
    }
    return {
        ids,
        scope: ids.length === 0 ? 'all_conversations' : `allowlist_${ids.length}`,
    };
}
