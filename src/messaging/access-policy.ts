// Messaging access policy substrate (M4-A0).
//
// Production callers: privileged remote /stop /approve (M4-A1) and, when a
// mention-watch condition names `authors`, the mention-watch matcher.
// Default-deny remains the unused-default. There is no denylist on this
// policy — mention-watch `authorDeny` is a local string list, not a mode here.

export type MessagingAccessMode = 'deny' | 'allowlist' | 'paired' | 'all';

export type MessagingAccessDecision = 'allow' | 'deny';

export type MessagingAccessRequest = {
    actorId: string;
    conversationKey: string;
    pairedActorId?: string;
    pairedConversationKey?: string;
};

export type MessagingAccessPolicy = {
    mode: MessagingAccessMode;
    allowlist?: readonly string[];
};

const DEFAULT_POLICY: MessagingAccessPolicy = { mode: 'deny' };

export function evaluateMessagingAccess(
    request: MessagingAccessRequest,
    policy: MessagingAccessPolicy = DEFAULT_POLICY,
): MessagingAccessDecision {
    if (!request.actorId || !request.conversationKey) return 'deny';
    switch (policy.mode) {
        case 'all':
            return 'allow';
        case 'allowlist':
            return policy.allowlist?.includes(request.actorId) ? 'allow' : 'deny';
        case 'paired':
            return request.actorId === request.pairedActorId
                && request.conversationKey === request.pairedConversationKey
                ? 'allow'
                : 'deny';
        case 'deny':
        default:
            return 'deny';
    }
}
