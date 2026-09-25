// Channels (Slack) page.
//
// Settings keys:
//   channel                   (shared across telegram + discord + slack pages)
//   slack.enabled
//   slack.botToken            (SecretField, masked, never logged)
//   slack.appToken            (SecretField, masked, never logged)
//   slack.teamId
//   slack.channelIds          (string[])
//   slack.forwardAll
//   slack.allowBots
//   slack.mentionOnly
//   slack.replyInThread
//   slack.ack.enabled         (emoji reaction receipts on inbound messages)

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SettingsRequestError } from '../settings-client';
import { SlackSetup, slackText } from './components/SlackSetup';
import { isSlackConfigured, hasSlackBotTokenPrefix, hasSlackAppTokenPrefix } from '../../../../js/features/channel-setup-rules.js';
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
    SettingsNote,
    StatusBadge,
} from './page-shell';
import { expandPatch } from './path-utils';
import type { MessengerChannel } from './components/ChannelEnablementControl';
import { TransportStatusChips } from './components/TransportStatusChips';
import { ChannelEnablementControl } from './components/ChannelEnablementControl';

type SlackBlock = {
    attachPort?: string;
    enabled?: boolean;
    botToken?: string;
    appToken?: string;
    teamId?: string;
    channelIds?: string[];
    forwardAll?: boolean;
    allowBots?: boolean;
    mentionOnly?: boolean;
    replyInThread?: boolean;
    ack?: { enabled?: boolean };
};

type SlackSnapshot = {
    messaging?: {
        enabledChannels?: MessengerChannel[];
        homeChannel?: MessengerChannel;
    };
    slack?: SlackBlock;
    slackEnvironmentVariables?: string[];
    [key: string]: unknown;
};

const SLACK_KEYS = [
    'slack.attachPort',
    'channel',
    'slack.enabled',
    'slack.botToken',
    'slack.appToken',
    'slack.teamId',
    'slack.channelIds',
    'slack.forwardAll',
    'slack.allowBots',
    'slack.mentionOnly',
    'slack.replyInThread',
    'slack.ack.enabled',
] as const;

/**
 * Slack conversation ids are prefix-typed, not numeric snowflakes:
 * C (channel), G (group/MPIM), D (IM) followed by uppercase alphanumerics.
 * This is the Slack analogue of ChannelsDiscord's isValidSnowflake.
 */
export function isValidSlackConversationId(chip: string): boolean {
    if (!chip) return false;
    return /^[CGD][A-Z0-9]{6,20}$/.test(chip.trim().toUpperCase());
}

const CONNECTION_KEYS = ['slack.enabled','slack.botToken','slack.appToken','slack.teamId','slack.channelIds','slack.attachPort'];
const SETUP_KEY = 'slack.setup'; // UI-only, valid:false; never included in an API patch
const SETUP_SAVED_KEYS = ['slack.enabled','slack.botToken','slack.appToken','slack.teamId'];
function unwrap<T>(value: T | {data:T}): T {
    return value && typeof value==='object' && 'data' in value ? (value as {data:T}).data : value as T;
}
function connectionCleared(snapshot: SlackSnapshot): boolean {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.slack) return false;
    const sc=snapshot.slack;
    return !sc?.enabled && !sc?.botToken && !sc?.appToken && !sc?.teamId
        && !sc?.channelIds?.length && !sc?.attachPort;
}

export default function ChannelsSlack({ port, client, dirty, registerSave, manager }: SettingsPageProps) {
    const t = useMemo(() => slackText(manager?.ui.locale ?? document.documentElement.lang), [manager?.ui.locale]);
    const [attachPort, setAttachPort] = useState('');
    const [setupOpen, setSetupOpen] = useState(false);
    const setupOpenRef = useRef(false), setupGeneration = useRef(0);
    const setupTriggerRef = useRef<HTMLElement | null>(null);
    const [resetting, setResetting] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [healthRevision, setHealthRevision] = useState(0);
    const resetFlight = useRef(false), alive = useRef(false);
    const epochRef = useRef<object>({});
    const [botTouched, setBotTouched] = useState(false), [appTouched, setAppTouched] = useState(false);
    useLayoutEffect(() => {
        alive.current = true; epochRef.current = {};
        return () => { alive.current = false; epochRef.current = {}; ++setupGeneration.current; };
    }, [port, client]);
    const { state, refresh, setData } = usePageSnapshot<SlackSnapshot>(client, '/api/settings');

    const [enabledChannels, setEnabledChannels] = useState<MessengerChannel[]>([]);
    const [homeChannel, setHomeChannel] = useState<MessengerChannel>('telegram');
    const [enabled, setEnabled] = useState(false);
    const [botToken, setBotToken] = useState('');
    const [appToken, setAppToken] = useState('');
    const [teamId, setTeamId] = useState('');
    const [channelIds, setChannelIds] = useState<string[]>([]);
    const [forwardAll, setForwardAll] = useState(true);
    const [allowBots, setAllowBots] = useState(false);
    const [mentionOnly, setMentionOnly] = useState(true);
    const [replyInThread, setReplyInThread] = useState(true);
    const [ackEnabled, setAckEnabled] = useState(false);

    const applySnapshot = useCallback((sc: SlackBlock) => {
        const remaining = Object.fromEntries([...dirty.pending].filter(([key]) => key.startsWith('slack.') && key !== SETUP_KEY)
            .map(([key, entry]) => [key, entry.value]));
        const draft = expandPatch(remaining)['slack'] as SlackBlock | undefined;
        sc = { ...sc, ...draft, ack: { ...sc.ack, ...draft?.ack } };
        setAttachPort(sc.attachPort ?? '');
        setEnabled(Boolean(sc.enabled));
        setBotToken(String(dirty.pending.get('slack.botToken')?.value ?? ''));
        setAppToken(String(dirty.pending.get('slack.appToken')?.value ?? ''));
        setTeamId(sc.teamId ?? '');
        setChannelIds(Array.isArray(sc.channelIds) ? [...sc.channelIds] : []);
        setForwardAll(sc.forwardAll !== false);
        setAllowBots(Boolean(sc.allowBots));
        // These two default TRUE for Slack, so a Boolean() read would show them
        // off on a fresh install while the backend behaves as on.
        setMentionOnly(sc.mentionOnly !== false);
        setReplyInThread(sc.replyInThread !== false);
        // ACK reactions default OFF in SLACK_ACK_DEFAULTS; a plain Boolean read
        // matches the backend default.
        setAckEnabled(Boolean(sc.ack?.enabled));
    }, [dirty]);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const messaging = state.data.messaging || {};
        const rawEnabled = Array.isArray(messaging.enabledChannels) ? messaging.enabledChannels : [];
        setEnabledChannels(rawEnabled.filter(isMessengerChannel) as MessengerChannel[]);
        setHomeChannel(isMessengerChannel(messaging.homeChannel) ? messaging.homeChannel : 'telegram');
        applySnapshot(state.data.slack || {});
    }, [state, applySnapshot]);

    useEffect(() => {
        return () => {
            for (const key of SLACK_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<SlackBlock>(() => {
        if (state.kind !== 'ready') return {};
        return state.data.slack || {};
    }, [state]);

    const environmentVariables = state.kind === 'ready' && Array.isArray(state.data.slackEnvironmentVariables)
        ? state.data.slackEnvironmentVariables
        : [];
    const environmentManaged = environmentVariables.length > 0;
    const savePolicyRef = useRef({ environmentManaged, environmentVariables, t });
    useLayoutEffect(() => { savePolicyRef.current = { environmentManaged, environmentVariables, t }; },
        [environmentManaged, environmentVariables, t]);

    const onSave = useCallback(async () => {
        const policy = savePolicyRef.current;
        if (resetFlight.current || setupOpenRef.current) throw new Error(policy.t('settings.slack.resetFailed'));
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        if (policy.environmentManaged && CONNECTION_KEYS.some(key => key in bundle)) {
            throw new Error(policy.t('settings.slack.resetManagedByEnvironment', { variables: policy.environmentVariables.join(', ') }));
        }
        const fields = Object.fromEntries(Object.entries(bundle).filter(([key]) =>
            SLACK_KEYS.includes(key as typeof SLACK_KEYS[number]) || key.startsWith('messaging.')));
        const captured = new Map([...dirty.pending].filter(([key]) => key in fields)), epoch = epochRef.current;
        const patch = expandPatch(fields);
        const updated = await client.put<SlackSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: SlackSnapshot }).data
            : updated) as SlackSnapshot;
        if (!alive.current || epoch !== epochRef.current) return;
        removeCaptured(captured);
        setData(fresh);
        applySnapshot(fresh.slack || {});
        await refresh();
    }, [client, dirty, refresh, setData, applySnapshot]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);


    function removeCaptured(entries: Map<string,DirtyEntry>): void {
        for (const [key,entry] of entries) if(dirty.pending.get(key)===entry) dirty.remove(key);
    }
    function openSetup(): void {
        if(savePolicyRef.current.environmentManaged || resetFlight.current || setupOpenRef.current) return;
        setupTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ++setupGeneration.current; setupOpenRef.current=true;
        dirty.set(SETUP_KEY,{value:true,original:false,valid:false});
        setSetupOpen(true);
    }
    function closeSetup(): void {
        ++setupGeneration.current; setupOpenRef.current=false;
        setSetupOpen(false); dirty.remove(SETUP_KEY);
    }
    useEffect(()=>()=>{++setupGeneration.current;setupOpenRef.current=false;dirty.remove(SETUP_KEY);},[dirty]);
    // B1: called synchronously by SlackSetup immediately BEFORE its PUT, never after PUT/GET.
    function captureSetupSave(): () => Promise<void> {
        const generation=setupGeneration.current;
        const captured=new Map([...dirty.pending].filter(([key])=>SETUP_SAVED_KEYS.includes(key) || key===SETUP_KEY));
        return async () => {
            if(!alive.current || !setupOpenRef.current || generation!==setupGeneration.current) return;
            const snapshot=unwrap(await client.get<SlackSnapshot | {data:SlackSnapshot}>('/api/settings'));
            if(!alive.current || !setupOpenRef.current || generation!==setupGeneration.current) return;
            // Only acknowledge the exact entries present at PUT; never remove a replacement entry.
            removeCaptured(captured);
            setData(snapshot); setHealthRevision(n=>n+1);
        };
    }
    async function resetConnection(): Promise<void> {
        if(resetFlight.current) return;
        if(environmentManaged) { setActionError(t('settings.slack.resetManagedByEnvironment',{variables:environmentVariables.join(', ')})); return; }
        // Stored tokens are masked, but their presence still permits reset. Never submit the mask.
        if(!botToken.trim() && !appToken.trim() && !original.botToken && !original.appToken) {
            setActionError(t('settings.slack.resetEmpty')); return;
        }
        if(!window.confirm(t('settings.slack.resetConfirm'))) return;
        const captured=new Map([...dirty.pending].filter(([key])=>CONNECTION_KEYS.includes(key)));
        const epoch=epochRef.current;
        resetFlight.current=true; setResetting(true); setActionError(null);
        let managedVariables: string[] | null=null;
        try {
            try { await client.post('/api/settings/slack/reset',{}); }
            catch(error) {
                if(error instanceof SettingsRequestError && error.status===409) {
                    try {
                        const body: {error?:string;environmentVariables?:unknown}=JSON.parse(error.detail);
                        if(body.error==='slack_connection_managed_by_environment') {
                            managedVariables=Array.isArray(body.environmentVariables)
                                ? body.environmentVariables.filter((v):v is string=>typeof v==='string') : ['SLACK_*'];
                        }
                    } catch { /* GET below still determines state; no raw detail is displayed */ }
                }
                // Lost response is ambiguous: still perform the authoritative GET; never retry POST.
            }
            const snapshot=unwrap(await client.get<SlackSnapshot | {data:SlackSnapshot}>('/api/settings'));
            if(!alive.current || epoch!==epochRef.current) return;
            const vars=managedVariables ?? snapshot.slackEnvironmentVariables ?? [];
            if(vars.length) {
                for(const key of CONNECTION_KEYS)dirty.remove(key);
                setData({...snapshot,slackEnvironmentVariables:vars}); setActionError(t('settings.slack.resetManagedByEnvironment',{variables:vars.join(', ')})); return;
            }
            if(!connectionCleared(snapshot)) { setActionError(t('settings.slack.resetFailed')); return; }
            removeCaptured(captured);
            setBotToken(''); setAppToken(''); setBotTouched(false); setAppTouched(false);
            setData(snapshot); // disabled=false, token/team/channel/attachPort empty from GET
        } catch { if(alive.current && epoch===epochRef.current) setActionError(t('settings.slack.resetFailed')); }
        finally { resetFlight.current=false; if(alive.current && epoch===epochRef.current) {setResetting(false);setHealthRevision(n=>n+1);} }
    }

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const maskOf = (value: string | undefined) =>
        value ? `••••••••${value.slice(-4)}` : '(empty)';
    const invalidChannelIds = channelIds.filter((c) => !isValidSlackConversationId(c));
    const channelIdsError = invalidChannelIds.length > 0
        ? `Slack conversation IDs only (C…/G…/D…) — invalid: ${invalidChannelIds.join(', ')}`
        : null;
    const botTokenError = botTouched && botToken.trim() && !hasSlackBotTokenPrefix(botToken)
        ? t('settings.slack.guide.botTokenError')
        : null;
    const appTokenError = appTouched && appToken.trim() && !hasSlackAppTokenPrefix(appToken)
        ? t('settings.slack.guide.appTokenError')
        : null;
    // Surface the outbound-only state on THIS page rather than changing the
    // shared status chips, which are frozen for cross-channel changes.
    const outboundOnly = Boolean(original.enabled) && Boolean(original.botToken) && !original.appToken;
    const slackHint = environmentManaged
        ? `Connection settings are read-only because they are managed by environment variables: ${environmentVariables.join(', ')}.`
        : outboundOnly
        ? 'Currently OUTBOUND-ONLY: the app-level token (xapp-) is missing, so no inbound Slack events can arrive.'
        : 'Slack needs TWO tokens: a bot token (xoxb-) for the Web API and an app-level token (xapp-) for Socket Mode.';

    return (
        <form
            className="settings-page-form"
            onBlurCapture={event => { const id = event.target.id; if (id === 'sl-botToken') setBotTouched(true); if (id === 'sl-appToken') setAppTouched(true); }}
            onSubmit={(event) => {
                event.preventDefault();
                void onSave().catch(() => setActionError(t('settings.slack.resetFailed')));
            }}
        >
            <fieldset disabled={resetting || setupOpen} className="settings-slack-fields">
            <SettingsSection
                title="Status"
                hint="Live transport state for this channel."
            >
                <SettingsKeyValue
                    items={[
                        {
                            label: 'Slack',
                            value: enabled ? (
                                <StatusBadge tone="ok">Enabled</StatusBadge>
                            ) : (
                                <StatusBadge tone="neutral">Disabled</StatusBadge>
                            ),
                        },
                        ...(outboundOnly
                            ? [{
                                label: 'Mode',
                                value: <StatusBadge tone="warn">Outbound only</StatusBadge>,
                            }]
                            : []),
                        ...(environmentManaged
                            ? [{ label: 'Managed by', value: environmentVariables.join(', '), mono: true }]
                            : []),
                    ]}
                />
                <TransportStatusChips key={healthRevision} client={client} channel="slack" />
            </SettingsSection>

            <SettingsSection
                title="Credentials"
                hint={slackHint}
            >
                <ToggleField
                    id="sl-enabled"
                    label="Slack enabled"
                    value={enabled}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setEnabled(next);
                        setEntry('slack.enabled', {
                            value: next,
                            original: Boolean(original.enabled),
                            valid: true,
                        });
                        if (next && !environmentManaged && !isSlackConfigured(botToken || original.botToken || '')) openSetup();
                    }}
                />
                <SecretField
                    id="sl-botToken"
                    label="Bot token"
                    value={botToken}
                    placeholder={maskOf(original.botToken)}
                    error={botTokenError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setBotToken(next);
                        if (next.trim().length === 0) {
                            dirty.remove('slack.botToken');
                            return;
                        }
                        setEntry('slack.botToken', {
                            value: next.trim(),
                            original: original.botToken ?? '',
                            valid: hasSlackBotTokenPrefix(next),
                        });
                    }}
                />
                <SecretField
                    id="sl-appToken"
                    label="App-level token"
                    value={appToken}
                    placeholder={maskOf(original.appToken)}
                    error={appTokenError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setAppToken(next);
                        if (next.trim().length === 0) {
                            dirty.remove('slack.appToken');
                            return;
                        }
                        setEntry('slack.appToken', {
                            value: next.trim(),
                            original: original.appToken ?? '',
                            valid: hasSlackAppTokenPrefix(next),
                        });
                    }}
                />
                <TextField
                    id="sl-teamId"
                    label="Team ID"
                    value={teamId}
                    placeholder="T01234567 (optional)"
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setTeamId(next);
                        setEntry('slack.teamId', {
                            value: next,
                            original: original.teamId ?? '',
                            valid: true,
                        });
                    }}
                />
                <ChipListField
                    id="sl-channelIds"
                    label="Channel IDs"
                    value={channelIds}
                    placeholder="C01234567"
                    error={channelIdsError}
                    disabled={environmentManaged}
                    onChange={(next) => {
                        setChannelIds(next);
                        setEntry('slack.channelIds', {
                            value: next,
                            original: original.channelIds ?? [],
                            valid: next.every(isValidSlackConversationId),
                        });
                    }}
                />
                <TextField id="sl-attachPort" label={t('settings.slack.attachPort')}
                    value={attachPort} disabled={environmentManaged || resetting || setupOpen}
                    onChange={next => { setAttachPort(next); setEntry('slack.attachPort', {
                        value: next.trim(), original: original.attachPort ?? '', valid: true,
                    }); }} />
            </SettingsSection>

            <SettingsSection
                title="Routing"
                hint="Choose which channels receive inbound chat and how replies are delivered. Outbound send can still work on any configured channel."
            >
                <ChannelEnablementControl
                    pageChannel="slack"
                    snapshot={state.kind === 'ready' ? state.data : {}}
                    enabledChannels={enabledChannels}
                    homeChannel={homeChannel}
                    setEnabledChannels={setEnabledChannels}
                    setHomeChannel={setHomeChannel}
                    dirty={dirty}
                    idPrefix="sl-channel"
                />
                <ToggleField
                    id="sl-mentionOnly"
                    label="Mention only"
                    value={mentionOnly}
                    onChange={(next) => {
                        setMentionOnly(next);
                        setEntry('slack.mentionOnly', {
                            value: next,
                            original: original.mentionOnly !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-replyInThread"
                    label="Reply in thread"
                    value={replyInThread}
                    onChange={(next) => {
                        setReplyInThread(next);
                        setEntry('slack.replyInThread', {
                            value: next,
                            original: original.replyInThread !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-forwardAll"
                    label="Forward all"
                    value={forwardAll}
                    onChange={(next) => {
                        setForwardAll(next);
                        setEntry('slack.forwardAll', {
                            value: next,
                            original: original.forwardAll !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-allowBots"
                    label="Allow bots"
                    value={allowBots}
                    onChange={(next) => {
                        setAllowBots(next);
                        setEntry('slack.allowBots', {
                            value: next,
                            original: Boolean(original.allowBots),
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-ackEnabled"
                    label="Emoji reactions (👀 → ✅)"
                    value={ackEnabled}
                    onChange={(next) => {
                        setAckEnabled(next);
                        setEntry('slack.ack.enabled', {
                            value: next,
                            original: Boolean(original.ack?.enabled),
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
                    <button type="button" className="settings-action settings-action-danger"
                        disabled={environmentManaged || resetting || setupOpen}
                        onClick={() => void resetConnection()}>{t('settings.slack.resetConnection')}</button>
                    <button type="button" className="settings-action"
                        disabled={environmentManaged || resetting || setupOpen}
                        data-onboard-channel="slack" onClick={openSetup}>{t('onboarding.open')}</button>
                </SettingsActions>
                {actionError && (
                    <SettingsNote tone="error" role="alert">{actionError}</SettingsNote>
                )}
            </SettingsSection>
            {setupOpen && <SlackSetup key={port} client={client} t={t}
                initialDraft={{ botToken, appToken }} returnFocus={setupTriggerRef.current} onBeforeSave={captureSetupSave} onClose={closeSetup} />}
        </form>
    );
}

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return value === 'telegram' || value === 'discord' || value === 'slack';
}
