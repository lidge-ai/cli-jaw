// Phase 3 — Channels (Telegram) page.
//
// Settings keys:
//   messaging.enabledChannels
//   messaging.homeChannel
//   telegram.enabled
//   telegram.token            (SecretField, masked, never logged)
//   telegram.allowedChatIds   (number[], rendered as numeric chips)
//   telegram.forwardAll
//   telegram.mentionOnly

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ToggleField, SecretField, ChipListField } from '../fields';
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
import { HealthBadge, interpretTelegramProbe } from './components/HealthBadge';
import type { MessengerChannel } from './components/ChannelEnablementControl';
import { TransportStatusChips } from './components/TransportStatusChips';
import { ChannelSetupEntry } from './components/ChannelSetupEntry';
import { ChannelEnablementControl } from './components/ChannelEnablementControl';

type MessagingBlock = {
    enabledChannels?: MessengerChannel[];
    homeChannel?: MessengerChannel;
};

type TelegramBlock = {
    enabled?: boolean;
    token?: string;
    allowedChatIds?: number[];
    forwardAll?: boolean;
    mentionOnly?: boolean;
};

type TelegramSnapshot = {
    channel?: MessengerChannel;
    telegram?: TelegramBlock;
    telegramEnvironmentVariables?: string[];
    messaging?: MessagingBlock;
    [key: string]: unknown;
};

const TELEGRAM_KEYS = [
    'messaging.enabledChannels',
    'messaging.homeChannel',
    'telegram.enabled',
    'telegram.token',
    'telegram.allowedChatIds',
    'telegram.forwardAll',
    'telegram.mentionOnly',
] as const;

const CONNECTION_KEYS = ['telegram.enabled', 'telegram.token', 'telegram.allowedChatIds'];

// ── pure helpers (exported for tests) ────────────────────────────────

/** Strict numeric-string check: digits, optional leading minus. No floats, no "1e9". */
export function isValidChatId(chip: string): boolean {
    if (!chip) return false;
    return /^-?\d+$/.test(chip.trim());
}

/** Filter chips that fail validation; keep order. Returns { valid, invalid }. */
export function partitionChatIds(chips: ReadonlyArray<string>): {
    valid: string[];
    invalid: string[];
} {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const chip of chips) {
        if (isValidChatId(chip)) valid.push(chip.trim());
        else invalid.push(chip);
    }
    return { valid, invalid };
}

/** Format `number[] → string[]` for the chip list UI. */
export function chatIdsToChips(ids: ReadonlyArray<number> | undefined): string[] {
    if (!ids) return [];
    return ids.filter((n) => Number.isFinite(n)).map((n) => String(n));
}

/** Parse `string[] → number[]` for save. Drops invalid chips defensively. */
export function chipsToChatIds(chips: ReadonlyArray<string>): number[] {
    const out: number[] = [];
    for (const chip of chips) {
        if (!isValidChatId(chip)) continue;
        const parsed = Number(chip);
        if (Number.isFinite(parsed)) out.push(parsed);
    }
    return out;
}

// ── component ────────────────────────────────────────────────────────

export default function ChannelsTelegram({ port, client, dirty, registerSave, manager }: SettingsPageProps) {
    const t = useMemo(() => slackText(manager?.ui.locale ?? document.documentElement.lang), [manager?.ui.locale]);
    const { state, refresh, setData } = usePageSnapshot<TelegramSnapshot>(client, '/api/settings');

    const [setupOpen, setSetupOpen] = useState(false);
    const [enabledChannels, setEnabledChannels] = useState<MessengerChannel[]>([]);
    const [homeChannel, setHomeChannel] = useState<MessengerChannel>('telegram');
    const [enabled, setEnabled] = useState(false);
    const [token, setToken] = useState('');
    const [chips, setChips] = useState<string[]>([]);
    const [forwardAll, setForwardAll] = useState(true);
    const [mentionOnly, setMentionOnly] = useState(true);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const messaging = state.data.messaging || {};
        const rawEnabled = Array.isArray(messaging.enabledChannels) ? messaging.enabledChannels : [];
        setEnabledChannels(rawEnabled.filter(isMessengerChannel) as MessengerChannel[]);
        setHomeChannel(isMessengerChannel(messaging.homeChannel) ? messaging.homeChannel : 'telegram');
        const tg = state.data.telegram || {};
        setEnabled(Boolean(tg.enabled));
        // Token field starts empty — we never seed the actual secret into the
        // input. The placeholder shows "••••last4" so the user sees that one
        // exists; typing replaces it on save, leaving blank keeps original.
        setToken('');
        setChips(chatIdsToChips(tg.allowedChatIds));
        setForwardAll(tg.forwardAll !== false);
        setMentionOnly(tg.mentionOnly !== false);
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of TELEGRAM_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<TelegramBlock>(() => {
        if (state.kind !== 'ready') return {};
        return state.data.telegram || {};
    }, [state]);

    const environmentVariables = state.kind === 'ready' && Array.isArray(state.data.telegramEnvironmentVariables)
        ? state.data.telegramEnvironmentVariables
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
            throw new Error(policy.t('settings.telegram.managedByEnvironment', { variables: policy.environmentVariables.join(', ') }));
        }
        const patch = expandPatch(bundle);
        const updated = await client.put<TelegramSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: TelegramSnapshot }).data
            : updated) as TelegramSnapshot;
        dirty.clear();
        setData(fresh);
        const freshMessaging = fresh.messaging || {};
        setEnabledChannels(
            Array.isArray(freshMessaging.enabledChannels)
                ? freshMessaging.enabledChannels.filter(isMessengerChannel) as MessengerChannel[]
                : [],
        );
        setHomeChannel(isMessengerChannel(freshMessaging.homeChannel) ? freshMessaging.homeChannel : 'telegram');
        const tg = fresh.telegram || {};
        setEnabled(Boolean(tg.enabled));
        setToken('');
        setChips(chatIdsToChips(tg.allowedChatIds));
        setForwardAll(tg.forwardAll !== false);
        setMentionOnly(tg.mentionOnly !== false);
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
    const { invalid } = partitionChatIds(chips);
    const chipsError = invalid.length > 0
        ? `Numeric chat IDs only — invalid: ${invalid.join(', ')}`
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
                hint="Live transport state plus a token/connectivity probe for this channel."
            >
                <SettingsKeyValue
                    items={[
                        {
                            label: 'Telegram',
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
                <TransportStatusChips client={client} channel="telegram" />
                <HealthBadge
                    client={client}
                    label="Telegram"
                    endpoint="/api/telegram/probe"
                    method="POST"
                    interpret={interpretTelegramProbe}
                />
            </SettingsSection>

            <SettingsSection title="Credentials" hint={environmentManaged
                ? t('settings.telegram.managedByEnvironment', { variables: environmentVariables.join(', ') })
                : 'Bot token and the allow-list for inbound chats.'}>
                <ToggleField
                    id="tg-enabled"
                    label="Telegram enabled"
                    value={enabled}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setEnabled(next);
                        setEntry('telegram.enabled', {
                            value: next,
                            original: Boolean(original.enabled),
                            valid: true,
                        });
                    }}
                />
                <SecretField
                    id="tg-token"
                    label="Bot token"
                    value={token}
                    placeholder={tokenPlaceholder}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setToken(next);
                        // Empty input means "leave existing token alone"; only
                        // emit a dirty entry once the user has typed something.
                        if (next.length === 0) {
                            dirty.remove('telegram.token');
                            return;
                        }
                        setEntry('telegram.token', {
                            value: next,
                            original: original.token ?? '',
                            valid: true,
                        });
                    }}
                />
                <ChipListField
                    id="tg-allowedChatIds"
                    label="Allowed chat IDs"
                    value={chips}
                    placeholder="123456789"
                    error={chipsError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setChips(next);
                        const allValid = next.every(isValidChatId);
                        setEntry('telegram.allowedChatIds', {
                            value: chipsToChatIds(next),
                            original: original.allowedChatIds ?? [],
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
                    pageChannel="telegram"
                    snapshot={state.kind === 'ready' ? state.data : {}}
                    enabledChannels={enabledChannels}
                    homeChannel={homeChannel}
                    setEnabledChannels={setEnabledChannels}
                    setHomeChannel={setHomeChannel}
                    dirty={dirty}
                    idPrefix="tg-channel"
                />
                <ToggleField
                    id="tg-forwardAll"
                    label="Forward all responses"
                    value={forwardAll}
                    onChange={(next) => {
                        setForwardAll(next);
                        setEntry('telegram.forwardAll', {
                            value: next,
                            original: original.forwardAll !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="tg-mentionOnly"
                    label="Mention only"
                    value={mentionOnly}
                    onChange={(next) => {
                        setMentionOnly(next);
                        setEntry('telegram.mentionOnly', {
                            value: next,
                            original: original.mentionOnly !== false,
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
                    <ChannelSetupEntry channel="telegram" client={client} dirty={dirty} disabled={environmentManaged}
                        open={setupOpen} onOpenChange={setSetupOpen} onSaved={async () => setData(await client.get<TelegramSnapshot>('/api/settings'))} />
                </SettingsActions>
            </SettingsSection>
        </form>
    );
}

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return value === 'telegram' || value === 'discord' || value === 'slack';
}
