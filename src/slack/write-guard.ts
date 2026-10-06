import { activeServerOwnedChannels, type SlackToolGrant } from './tool-context.js';
import { slackToolDenied, type SlackToolPrincipal } from './tool-access.js';

/** Evaluate the channel that will actually receive the write, not a source
 * channel used for history, quotes, or membership verification. */
export function assertSlackWriteAllowed(principal: SlackToolPrincipal, grant: SlackToolGrant | null,
    destinationChannelId: string): void {
    if (grant?.serverOwnedDelivery === true) throw slackToolDenied('slack_server_owned_delivery', 409);
    if (principal.kind === 'operator' && !grant && activeServerOwnedChannels().has(destinationChannelId)) {
        throw slackToolDenied('slack_channel_leased_by_heartbeat', 409);
    }
}
