// Phase 3 — Channels (Discord) page.
//
// Settings keys:
//   messaging.enabledChannels
//   messaging.homeChannel
//   discord.enabled
//   discord.token             (SecretField, masked, never logged)
//   discord.guildId
//   discord.channelIds        (string[])
//   discord.forwardAll
//   discord.allowBots
//   discord.mentionOnly

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ToggleField, SecretField, ChipListField, TextField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
    SettingsActions,
    SettingsKeyValue,
    StatusBadge,
} from './page-shell';
import { expandPatch } from './path-utils';
import { slackText } from './components/SlackSetup';
import { HealthBadge, interpretDiscordHealth } from './components/HealthBadge';
import type { MessengerChannel } from './components/ChannelEnablementControl';
import { TransportStatusChips } from './components/TransportStatusChips';
import { ChannelSetupEntry } from './components/ChannelSetupEntry';
import { ChannelEnablementControl } from './components/ChannelEnablementControl';

type MessagingBlock = {
    enabledChannels?: MessengerChannel[];
    homeChannel?: MessengerChannel;
};

type DiscordBlock = {
    enabled?: boolean;
    token?: string;
    guildId?: string;
    channelIds?: string[];
    forwardAll?: boolean;
    allowBots?: boolean;
    mentionOnly?: boolean;
};

type DiscordSnapshot = {
    channel?: MessengerChannel;
    discord?: DiscordBlock;
    discordEnvironmentVariables?: string[];
    messaging?: MessagingBlock;
    [key: string]: unknown;
};

const DISCORD_KEYS = [
    'messaging.enabledChannels',
    'messaging.homeChannel',
    'discord.enabled',
    'discord.token',
    'discord.guildId',
    'discord.channelIds',
    'discord.forwardAll',
    'discord.allowBots',
    'discord.mentionOnly',
] as const;

const CONNECTION_KEYS = ['discord.enabled', 'discord.token', 'discord.guildId', 'discord.channelIds'];

/** Discord IDs are snowflakes — long numeric strings. Be lenient: 16+ digits typical. */
export function isValidSnowflake(chip: string): boolean {
    if (!chip) return false;
    return /^\d{5,32}$/.test(chip.trim());
}

export default function ChannelsDiscord({ port, client, dirty, registerSave, manager }: SettingsPageProps) {
    const t = useMemo(() => slackText(manager?.ui.locale ?? document.documentElement.lang), [manager?.ui.locale]);
    const { state, refresh, setData } = usePageSnapshot<DiscordSnapshot>(client, '/api/settings');

    const [setupOpen, setSetupOpen] = useState(false);
    const [enabledChannels, setEnabledChannels] = useState<MessengerChannel[]>([]);
    const [homeChannel, setHomeChannel] = useState<MessengerChannel>('telegram');
    const [enabled, setEnabled] = useState(false);
    const [token, setToken] = useState('');
    const [guildId, setGuildId] = useState('');
    const [channelIds, setChannelIds] = useState<string[]>([]);
    const [forwardAll, setForwardAll] = useState(true);
    const [allowBots, setAllowBots] = useState(false);
    const [mentionOnly, setMentionOnly] = useState(false);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const messaging = state.data.messaging || {};
        const rawEnabled = Array.isArray(messaging.enabledChannels) ? messaging.enabledChannels : [];
        setEnabledChannels(rawEnabled.filter(isMessengerChannel) as MessengerChannel[]);
        setHomeChannel(isMessengerChannel(messaging.homeChannel) ? messaging.homeChannel : 'telegram');
        const dc = state.data.discord || {};
        setEnabled(Boolean(dc.enabled));
        setToken('');
        setGuildId(dc.guildId ?? '');
        setChannelIds(Array.isArray(dc.channelIds) ? [...dc.channelIds] : []);
        setForwardAll(dc.forwardAll !== false);
        setAllowBots(Boolean(dc.allowBots));
        setMentionOnly(Boolean(dc.mentionOnly));
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of DISCORD_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<DiscordBlock>(() => {
        if (state.kind !== 'ready') return {};
        return state.data.discord || {};
    }, [state]);

    const environmentVariables = state.kind === 'ready' && Array.isArray(state.data.discordEnvironmentVariables)
        ? state.data.discordEnvironmentVariables
        : [];
    const environmentManaged = environmentVariables.length > 0;
    const savePolicyRef = useRef({ environmentManaged, environmentVariables, t });
    useLayoutEffect(() => { savePolicyRef.current = { environmentManaged, environmentVariables, t }; },
        [environmentManaged, environmentVariables, t]);

    const onSave = useCallback(async () => {
        if (setupOpen) throw new Error('Finish channel setup before saving settings.');
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const policy = savePolicyRef.current;
        if (policy.environmentManaged && CONNECTION_KEYS.some(key => key in bundle)) {
            throw new Error(policy.t('settings.discord.managedByEnvironment', { variables: policy.environmentVariables.join(', ') }));
        }
        const patch = expandPatch(bundle);
        const updated = await client.put<DiscordSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: DiscordSnapshot }).data
            : updated) as DiscordSnapshot;
        dirty.clear();
        setData(fresh);
        const freshMessaging = fresh.messaging || {};
        setEnabledChannels(
            Array.isArray(freshMessaging.enabledChannels)
                ? freshMessaging.enabledChannels.filter(isMessengerChannel) as MessengerChannel[]
                : [],
        );
        setHomeChannel(isMessengerChannel(freshMessaging.homeChannel) ? freshMessaging.homeChannel : 'telegram');
        const dc = fresh.discord || {};
        setEnabled(Boolean(dc.enabled));
        setToken('');
        setGuildId(dc.guildId ?? '');
        setChannelIds(Array.isArray(dc.channelIds) ? [...dc.channelIds] : []);
        setForwardAll(dc.forwardAll !== false);
        setAllowBots(Boolean(dc.allowBots));
        setMentionOnly(Boolean(dc.mentionOnly));
        await refresh();
    }, [client, dirty, refresh, setData, setupOpen]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const last4 = original.token ? original.token.slice(-4) : '';
    const tokenPlaceholder = original.token ? `••••••••${last4}` : '(empty)';
    const guildError = guildId && !isValidSnowflake(guildId)
        ? 'Guild ID must be a numeric snowflake.'
        : null;
    const invalidChannelIds = channelIds.filter((c) => !isValidSnowflake(c));
    const channelIdsError = invalidChannelIds.length > 0
        ? `Snowflake IDs only — invalid: ${invalidChannelIds.join(', ')}`
        : null;

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <fieldset disabled={setupOpen} className="settings-slack-fields">
            <SettingsSection
                title="Status"
                hint="Live transport state plus a readiness probe for this channel."
            >
                <SettingsKeyValue
                    items={[
                        {
                            label: 'Discord',
                            value: enabled ? (
                                <StatusBadge tone="ok">Enabled</StatusBadge>
                            ) : (
                                <StatusBadge tone="neutral">Disabled</StatusBadge>
                            ),
                        },
                        ...(environmentManaged
                            ? [{ label: 'Managed by', value: environmentVariables.join(', '), mono: true }]
                            : []),
                    ]}
                />
                <TransportStatusChips client={client} channel="discord" />
                <HealthBadge
                    client={client}
                    label="Discord"
                    endpoint="/api/health"
                    method="GET"
                    interpret={interpretDiscordHealth}
                />
            </SettingsSection>

            <SettingsSection title="Credentials" hint={environmentManaged
                ? t('settings.discord.managedByEnvironment', { variables: environmentVariables.join(', ') })
                : 'Bot token, guild, and channel IDs.'}>
                <ToggleField
                    id="dc-enabled"
                    label="Discord enabled"
                    value={enabled}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setEnabled(next);
                        setEntry('discord.enabled', {
                            value: next,
                            original: Boolean(original.enabled),
                            valid: true,
                        });
                    }}
                />
                <SecretField
                    id="dc-token"
                    label="Bot token"
                    value={token}
                    placeholder={tokenPlaceholder}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setToken(next);
                        if (next.length === 0) {
                            dirty.remove('discord.token');
                            return;
                        }
                        setEntry('discord.token', {
                            value: next,
                            original: original.token ?? '',
                            valid: true,
                        });
                    }}
                />
                <TextField
                    id="dc-guildId"
                    label="Guild ID"
                    value={guildId}
                    placeholder="123456789012345678"
                    error={guildError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setGuildId(next);
                        const valid = next.length === 0 || isValidSnowflake(next);
                        setEntry('discord.guildId', {
                            value: next,
                            original: original.guildId ?? '',
                            valid,
                        });
                    }}
                />
                <ChipListField
                    id="dc-channelIds"
                    label="Channel IDs"
                    value={channelIds}
                    placeholder="987654321098765432"
                    error={channelIdsError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setChannelIds(next);
                        const allValid = next.every(isValidSnowflake);
                        setEntry('discord.channelIds', {
                            value: next,
                            original: original.channelIds ?? [],
                            valid: allValid,
                        });
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Routing"
                hint="Choose which channels receive inbound chat and how replies are delivered. Outbound send can still work on any configured channel."
            >
                <ChannelEnablementControl
                    pageChannel="discord"
                    snapshot={state.kind === 'ready' ? state.data : {}}
                    enabledChannels={enabledChannels}
                    homeChannel={homeChannel}
                    setEnabledChannels={setEnabledChannels}
                    setHomeChannel={setHomeChannel}
                    dirty={dirty}
                    idPrefix="di-channel"
                />
                <ToggleField
                    id="dc-forwardAll"
                    label="Forward all"
                    value={forwardAll}
                    onChange={(next) => {
                        setForwardAll(next);
                        setEntry('discord.forwardAll', {
                            value: next,
                            original: original.forwardAll !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="dc-allowBots"
                    label="Allow other bots"
                    value={allowBots}
                    onChange={(next) => {
                        setAllowBots(next);
                        setEntry('discord.allowBots', {
                            value: next,
                            original: Boolean(original.allowBots),
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="dc-mentionOnly"
                    label="Mention only"
                    value={mentionOnly}
                    onChange={(next) => {
                        setMentionOnly(next);
                        setEntry('discord.mentionOnly', {
                            value: next,
                            original: Boolean(original.mentionOnly),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
            </fieldset>
            <SettingsSection
                title="Actions"
                hint="Guided setup validates credentials with the issuer before saving."
            >
                <SettingsActions>
                    <ChannelSetupEntry channel="discord" client={client} dirty={dirty} disabled={environmentManaged}
                        open={setupOpen} onOpenChange={setSetupOpen} onSaved={async () => setData(await client.get<DiscordSnapshot>('/api/settings'))} />
                </SettingsActions>
            </SettingsSection>
        </form>
    );
}

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return value === 'telegram' || value === 'discord' || value === 'slack';
}
