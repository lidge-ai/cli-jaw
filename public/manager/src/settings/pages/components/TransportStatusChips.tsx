import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsClient } from '../../types';
import { StatusBadge } from '../page-shell';

export type MessengerChannel = 'telegram' | 'discord' | 'slack';

export type TransportStatus = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type ChannelHealth = {
    /** @deprecated Use activeInboundChannels for the actual running set. */
    activeInbound: MessengerChannel;
    activeInboundChannels: MessengerChannel[];
    telegram: TransportStatus;
    discord: TransportStatus;
    slack: TransportStatus;
};

function isTransportStatus(value: unknown): value is TransportStatus {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row['configured'] === 'boolean'
        && typeof row['activeInbound'] === 'boolean'
        && typeof row['sendCapable'] === 'boolean';
}

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return value === 'telegram' || value === 'discord' || value === 'slack';
}

export function parseChannelHealth(payload: unknown): ChannelHealth | null {
    if (!payload || typeof payload !== 'object') return null;
    const channels = (payload as { channels?: unknown }).channels;
    if (!channels || typeof channels !== 'object') return null;
    const row = channels as Record<string, unknown>;
    const rawActiveChannels = row['activeInboundChannels'];
    let activeInboundChannels: MessengerChannel[] | null;
    if (rawActiveChannels !== undefined) {
        activeInboundChannels = Array.isArray(rawActiveChannels)
            && rawActiveChannels.every(isMessengerChannel)
            ? [...new Set(rawActiveChannels)]
            : null;
    } else {
        const legacyActive = row['activeInbound'];
        activeInboundChannels = isMessengerChannel(legacyActive) ? [legacyActive] : null;
    }
    if (!activeInboundChannels) return null;
    const active = row['activeInbound'];
    if (!isMessengerChannel(active)) return null;
    if (!isTransportStatus(row['telegram']) || !isTransportStatus(row['discord'])) return null;
    // Slack is tolerated as absent: a newer Manager can be pointed at an older
    // running cli-jaw, and rejecting the whole payload would hide Telegram and
    // Discord health too.
    const slack = isTransportStatus(row['slack'])
        ? row['slack']
        : { configured: false, activeInbound: false, sendCapable: false, reason: 'unavailable' };
    return {
        activeInbound: active,
        activeInboundChannels,
        telegram: row['telegram'],
        discord: row['discord'],
        slack,
    };
}

export function transportChipLabels(status: TransportStatus): string[] {
    const chips: string[] = [];
    chips.push(status.configured ? 'Configured' : 'Not configured');
    if (status.sendCapable) chips.push('Send-capable');
    if (status.activeInbound) chips.push('Active inbound');
    return chips;
}

type Props = {
    client: SettingsClient;
    channel: 'telegram' | 'discord' | 'slack';
};

export function TransportStatusChips({ client, channel }: Props) {
    const [health, setHealth] = useState<ChannelHealth | null>(null);
    const [error, setError] = useState<string | null>(null);
    const mounted = useRef(true);

    const refresh = useCallback(async () => {
        try {
            const payload = await client.get<unknown>('/api/health');
            if (!mounted.current) return;
            const parsed = parseChannelHealth(payload);
            setHealth(parsed);
            setError(parsed ? null : 'Channel health unavailable on this instance.');
        } catch (err: unknown) {
            if (!mounted.current) return;
            setHealth(null);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        return () => {
            mounted.current = false;
        };
    }, [refresh]);

    const status = health?.[channel] ?? null;
    const showHint = Boolean(status?.configured && status.sendCapable && !status.activeInbound);

    return (
        <div className="settings-transport-status settings-card-toolbar" role="status" aria-live="polite">
            {error ? <span className="settings-field-hint">{error}</span> : null}
            {status ? (
                <>
                    {transportChipLabels(status).map(label => (
                        <StatusBadge
                            key={label}
                            tone={label === 'Not configured' ? 'neutral' : 'ok'}
                        >
                            {label}
                        </StatusBadge>
                    ))}
                    {showHint ? (
                        <span className="settings-field-hint">
                            This transport is not receiving inbound messages, but send-only delivery remains available.
                        </span>
                    ) : null}
                </>
            ) : null}
            <button
                type="button"
                className="settings-action"
                onClick={() => void refresh()}
            >
                Refresh transport status
            </button>
        </div>
    );
}
