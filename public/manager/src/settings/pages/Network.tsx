// Phase 7 — Network page: bind host, LAN bypass, remote access mode + sub-fields.
//
// Pure helpers (`parsePublicOriginHint`, `detectSelfLockoutRisk`, `REMOTE_ACCESS_MODES`)
// are exported so the unit tests can exercise validation and self-lock-out
// detection without mounting the React component.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { TextField, SelectField, ToggleField } from '../fields';
import {
    SettingsSection,
    SettingsNote,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { InlineWarn } from './components/InlineWarn';
import { expandPatch } from './path-utils';

export type RemoteAccessMode = 'off' | 'http-only' | 'full';

export const REMOTE_ACCESS_MODES: ReadonlyArray<RemoteAccessMode> = ['off', 'http-only', 'full'];

export function isRemoteAccessMode(value: unknown): value is RemoteAccessMode {
    return value === 'off' || value === 'http-only' || value === 'full';
}

type RemoteAccessBlock = {
    mode?: RemoteAccessMode;
    trustProxies?: boolean;
    trustForwardedFor?: boolean;
    publicOriginHint?: string;
};

type NetworkBlock = {
    bindHost?: string;
    lanBypass?: boolean;
    remoteAccess?: RemoteAccessBlock;
};

type NetworkSnapshot = {
    network?: NetworkBlock;
    [key: string]: unknown;
};

const NETWORK_KEYS = [
    'network.bindHost',
    'network.lanBypass',
    'network.remoteAccess.mode',
    'network.remoteAccess.trustProxies',
    'network.remoteAccess.trustForwardedFor',
    'network.remoteAccess.publicOriginHint',
] as const;

const BIND_HOST_OPTIONS = [
    { value: '127.0.0.1', label: '127.0.0.1 — loopback only (recommended)' },
    { value: '0.0.0.0', label: '0.0.0.0 — all interfaces (LAN exposed)' },
];

const REMOTE_ACCESS_OPTIONS = [
    { value: 'off', label: 'off — block remote requests' },
    { value: 'http-only', label: 'http-only — read-only HTTP from remote' },
    { value: 'full', label: 'full — HTTP + WebSocket from remote' },
];

function normalizeNetworkBlock(block: NetworkBlock): NetworkBlock {
    const next: NetworkBlock = {};
    if (block.bindHost !== undefined) next.bindHost = block.bindHost;
    if (block.lanBypass !== undefined) next.lanBypass = block.lanBypass;
    next.remoteAccess = { ...(block.remoteAccess ?? {}) };
    return next;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────

export type PublicOriginValidation =
    | { kind: 'empty' }
    | { kind: 'valid'; origin: string }
    | { kind: 'invalid'; reason: string };

export function parsePublicOriginHint(input: string): PublicOriginValidation {
    const trimmed = (input || '').trim();
    if (trimmed === '') return { kind: 'empty' };
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return { kind: 'invalid', reason: 'Must be an absolute URL (https://… or http://…).' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { kind: 'invalid', reason: 'Only http:// or https:// origins are accepted.' };
    }
    if (!url.hostname) return { kind: 'invalid', reason: 'Origin must include a host.' };
    if (url.pathname && url.pathname !== '/') {
        return { kind: 'invalid', reason: 'Origin must not include a path.' };
    }
    if (url.search || url.hash) {
        return { kind: 'invalid', reason: 'Origin must not include query or hash.' };
    }
    return { kind: 'valid', origin: url.origin };
}

/**
 * Detect when saving a remote-access change would cut off the active session.
 * Returns true when the dashboard is being viewed over a non-loopback origin
 * AND the new mode would close that channel.
 */
export function detectSelfLockoutRisk(args: {
    currentMode: RemoteAccessMode;
    nextMode: RemoteAccessMode;
    locationHost: string;
}): boolean {
    const host = (args.locationHost || '').toLowerCase();
    const hostname = host.split(':')[0] || '';
    const isLoopback =
        hostname === '' ||
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1';
    if (isLoopback) return false;
    if (args.currentMode === args.nextMode) return false;
    return args.nextMode === 'off';
}

// ─── Page component ──────────────────────────────────────────────────

export default function Network({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<NetworkSnapshot>(client, '/api/settings');
    const [draft, setDraft] = useState<NetworkBlock>({});

    useEffect(() => {
        if (state.kind === 'ready') {
            const block = state.data.network ?? {};
            setDraft(normalizeNetworkBlock(block));
        }
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of NETWORK_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<NetworkBlock>(
        () => (state.kind === 'ready' ? state.data.network ?? {} : {}),
        [state],
    );
    const originalRemote = original.remoteAccess ?? {};
    const draftRemote = draft.remoteAccess ?? {};

    const currentBindHost = draft.bindHost ?? original.bindHost ?? '127.0.0.1';
    const currentLanBypass = Boolean(draft.lanBypass ?? original.lanBypass);
    const currentMode: RemoteAccessMode = isRemoteAccessMode(draftRemote.mode)
        ? draftRemote.mode
        : isRemoteAccessMode(originalRemote.mode)
            ? originalRemote.mode
            : 'off';
    const remoteEnabled = currentMode !== 'off';
    const currentTrustProxies = Boolean(
        draftRemote.trustProxies ?? originalRemote.trustProxies,
    );
    const currentTrustForwardedFor = Boolean(
        draftRemote.trustForwardedFor ?? originalRemote.trustForwardedFor,
    );
    const currentPublicOrigin =
        draftRemote.publicOriginHint ?? originalRemote.publicOriginHint ?? '';

    const publicOriginValidation = parsePublicOriginHint(currentPublicOrigin);
    const lockoutRisk = detectSelfLockoutRisk({
        currentMode: isRemoteAccessMode(originalRemote.mode) ? originalRemote.mode : 'off',
        nextMode: currentMode,
        locationHost: typeof window !== 'undefined' ? window.location.host : '',
    });

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        if (
            lockoutRisk &&
            typeof window !== 'undefined' &&
            !window.confirm(
                'You are accessing this dashboard over a remote origin. Saving with remote access "off" will lock you out. Continue?',
            )
        ) {
            return;
        }
        const patch = expandPatch(bundle);
        const updated = await client.put<NetworkSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: NetworkSnapshot }).data
            : updated) as NetworkSnapshot;
        dirty.clear();
        const block = fresh.network ?? {};
        setDraft(normalizeNetworkBlock(block));
        setData(fresh);
        await refresh();
    }, [client, dirty, lockoutRisk, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const bindHostChanged =
        (draft.bindHost ?? original.bindHost) !== (original.bindHost ?? '127.0.0.1');

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Bind"
                hint={`Listening interface for /i/${port}. Changes require an instance restart.`}
            >
                <SelectField
                    id="network-bindHost"
                    label="Bind host"
                    value={currentBindHost}
                    options={BIND_HOST_OPTIONS}
                    onChange={(next) => {
                        setDraft({ ...draft, bindHost: next });
                        setEntry('network.bindHost', {
                            value: next,
                            original: original.bindHost ?? '127.0.0.1',
                            valid: true,
                        });
                    }}
                />
                {currentBindHost === '0.0.0.0' && (
                    <InlineWarn>
                        Listening on <code>0.0.0.0</code> exposes this instance's API to anyone
                        on your LAN. Pair with auth + firewall rules.
                    </InlineWarn>
                )}
                {bindHostChanged && (
                    <InlineWarn tone="info">
                        Restart the instance for the new bind host to take effect.
                    </InlineWarn>
                )}
                <ToggleField
                    id="network-lanBypass"
                    label="LAN bypass"
                    description="Skip auth checks for clients on the same LAN."
                    value={currentLanBypass}
                    onChange={(next) => {
                        setDraft({ ...draft, lanBypass: next });
                        setEntry('network.lanBypass', {
                            value: next,
                            original: Boolean(original.lanBypass),
                            valid: true,
                        });
                    }}
                />
                {currentLanBypass && (
                    <InlineWarn>
                        LAN bypass disables auth for any client on the same network. Only
                        enable on a trusted network.
                    </InlineWarn>
                )}
            </SettingsSection>

            <SettingsSection
                title="Remote access"
                hint="Mode controls what reaches the API from outside the loopback interface."
            >
                <SelectField
                    id="network-remoteAccess-mode"
                    label="Remote access mode"
                    value={currentMode}
                    options={REMOTE_ACCESS_OPTIONS}
                    onChange={(next) => {
                        if (!isRemoteAccessMode(next)) return;
                        setDraft({
                            ...draft,
                            remoteAccess: { ...draftRemote, mode: next },
                        });
                        setEntry('network.remoteAccess.mode', {
                            value: next,
                            original: isRemoteAccessMode(originalRemote.mode)
                                ? originalRemote.mode
                                : 'off',
                            valid: true,
                        });
                    }}
                />
                <SettingsNote>
                    <strong>off</strong> — only loopback can talk to the API.{' '}
                    <strong>http-only</strong> — remote can issue HTTP requests but no
                    WebSocket upgrades. <strong>full</strong> — HTTP + WebSocket open to
                    remote (use with auth).
                </SettingsNote>
                {lockoutRisk && (
                    <SettingsNote tone="error" role="alert">
                        Saving will close remote access while you're connected from
                        <code> {typeof window !== 'undefined' ? window.location.host : ''} </code>
                        — you will be locked out. Reach the dashboard over loopback first.
                    </SettingsNote>
                )}
                {remoteEnabled && (
                    <>
                        <ToggleField
                            id="network-remoteAccess-trustProxies"
                            label="Trust proxies"
                            description="Honor proxy headers when computing the client origin."
                            value={currentTrustProxies}
                            onChange={(next) => {
                                setDraft({
                                    ...draft,
                                    remoteAccess: { ...draftRemote, trustProxies: next },
                                });
                                setEntry('network.remoteAccess.trustProxies', {
                                    value: next,
                                    original: Boolean(originalRemote.trustProxies),
                                    valid: true,
                                });
                            }}
                        />
                        <ToggleField
                            id="network-remoteAccess-trustForwardedFor"
                            label="Trust X-Forwarded-For"
                            description="Use X-Forwarded-For for the client IP. Only enable behind a known proxy."
                            value={currentTrustForwardedFor}
                            onChange={(next) => {
                                setDraft({
                                    ...draft,
                                    remoteAccess: { ...draftRemote, trustForwardedFor: next },
                                });
                                setEntry('network.remoteAccess.trustForwardedFor', {
                                    value: next,
                                    original: Boolean(originalRemote.trustForwardedFor),
                                    valid: true,
                                });
                            }}
                        />
                        {currentTrustForwardedFor && !currentTrustProxies && (
                            <InlineWarn>
                                Trusting X-Forwarded-For without trusting the proxy chain lets
                                any client spoof its IP. Enable "Trust proxies" too.
                            </InlineWarn>
                        )}
                        <TextField
                            id="network-remoteAccess-publicOriginHint"
                            label="Public origin hint"
                            value={currentPublicOrigin}
                            placeholder="https://your-tunnel-url"
                            error={
                                publicOriginValidation.kind === 'invalid'
                                    ? publicOriginValidation.reason
                                    : null
                            }
                            onChange={(next) => {
                                setDraft({
                                    ...draft,
                                    remoteAccess: { ...draftRemote, publicOriginHint: next },
                                });
                                const validation = parsePublicOriginHint(next);
                                setEntry('network.remoteAccess.publicOriginHint', {
                                    value: validation.kind === 'valid' ? validation.origin : next,
                                    original: originalRemote.publicOriginHint ?? '',
                                    valid: validation.kind !== 'invalid',
                                });
                            }}
                        />
                    </>
                )}
            </SettingsSection>
        </form>
    );
}
