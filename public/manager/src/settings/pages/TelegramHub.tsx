// Telegram Hub — manager-level settings page (P3).
//
// Talks to `/api/dashboard/telegram-hub` on the MANAGER itself (NOT the per-instance
// `/i/{port}` proxy). Mirrors DashboardMeta.tsx's managerClient pattern — the injected
// instance `client` would 404 on this manager-side route.

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPageProps } from '../types';
import { ToggleField, SecretField, TextField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    usePageSnapshot,
    SettingsKeyValue,
    SettingsNote,
    StatusBadge,
} from './page-shell';
import type { StatusTone } from './page-shell';

// Local mirror of MANAGED_INSTANCE_PORT_FROM/TO (src/manager/constants.ts). The frontend
// bundle must not import server modules; the backend validates the real range authoritatively.
const PORT_MIN = 3457;
const PORT_MAX = 3506;

type Route = { chatId: string; threadId: string; port: number; label?: string; enabled: boolean; systemPrompt?: string; model?: string };
type HubConfig = { enabled: boolean; hasToken: boolean; chatId: string; defaultPort: number; routes: Route[] };
type HubRuntime = { state: 'stopped' | 'starting' | 'polling' | 'error'; chatId?: string; error?: string };
type HubResponse = { ok: boolean; config: HubConfig; runtime?: HubRuntime };

type ManagerClient = {
    get<T>(path: string): Promise<T>;
    put<T>(path: string, body: unknown): Promise<T>;
    delete<T>(path: string): Promise<T>;
};

function defaultManagerClient(): ManagerClient {
    return {
        async get<T>(path: string): Promise<T> {
            const res = await fetch(path);
            if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
            return (await res.json()) as T;
        },
        async put<T>(path: string, body: unknown): Promise<T> {
            const res = await fetch(path, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
            return (await res.json()) as T;
        },
        async delete<T>(path: string): Promise<T> {
            const res = await fetch(path, { method: 'DELETE' });
            if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`);
            return (await res.json()) as T;
        },
    };
}

const HUB_KEYS = ['hub.enabled', 'hub.token', 'hub.chatId', 'hub.defaultPort'] as const;

export type TelegramHubProps = SettingsPageProps & {
    /** Tests inject a stub client; production uses fetch. */
    managerClient?: ManagerClient;
};

export default function TelegramHub({ port, client, dirty, registerSave, managerClient }: TelegramHubProps) {
    // Reuse page-shell's snapshot only for parity (loading/error scaffolding); the real load
    // runs through managerClient below, because `client` hits /i/{port} and 404s here.
    const { state } = usePageSnapshot<HubResponse>(client, '__telegram_hub_unused__', [port]);
    void state;

    const [config, setConfig] = useState<HubConfig | null>(null);
    const [runtime, setRuntime] = useState<HubRuntime | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [token, setToken] = useState('');        // blank ⇒ keep stored token
    const [chatId, setChatId] = useState('');
    const [defaultPort, setDefaultPort] = useState(PORT_MIN);
    const mClient = managerClient || defaultManagerClient();

    const load = useCallback(async () => {
        setLoadError(null);
        try {
            const res = await mClient.get<HubResponse>('/api/dashboard/telegram-hub');
            setConfig(res.config);
            setRuntime(res.runtime || null);
            setEnabled(res.config.enabled);
            setChatId(res.config.chatId);
            setDefaultPort(res.config.defaultPort);
            setToken('');
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    }, [mClient]);

    useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [port]);
    useEffect(() => () => { for (const k of HUB_KEYS) dirty.remove(k); }, [dirty]);

    const onSave = useCallback(async () => {
        const body: Record<string, unknown> = { enabled, chatId: chatId.trim(), defaultPort };
        if (token.trim()) body['token'] = token.trim();   // omit ⇒ keep stored token
        const res = await mClient.put<HubResponse>('/api/dashboard/telegram-hub', body);
        setConfig(res.config);
        setRuntime(res.runtime || null);
        setToken('');
        for (const k of HUB_KEYS) dirty.remove(k);
    }, [enabled, chatId, defaultPort, token, mClient, dirty]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const removeRoute = useCallback(async (r: Route) => {
        try {
            await mClient.delete(
                `/api/dashboard/telegram-hub/routes/${encodeURIComponent(r.chatId)}/${encodeURIComponent(r.threadId)}`,
            );
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
        await load();
    }, [mClient, load]);

    if (loadError) return <PageError message={loadError} />;
    if (!config) return <PageLoading label="Loading Telegram hub…" />;

    const runtimeTone: StatusTone =
        runtime?.state === 'polling' ? 'ok'
            : runtime?.state === 'starting' ? 'warn'
                : runtime?.state === 'error' ? 'error'
                    : 'neutral';

    return (
        <form className="settings-page-form settings-form" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
            <SettingsSection title="Status" hint="Live hub runtime reported by the manager.">
                <SettingsKeyValue
                    items={[
                        {
                            label: 'Hub',
                            value: enabled ? (
                                <StatusBadge tone="ok">Enabled</StatusBadge>
                            ) : (
                                <StatusBadge tone="neutral">Disabled</StatusBadge>
                            ),
                        },
                        {
                            label: 'Runtime',
                            value: (
                                <StatusBadge tone={runtimeTone}>
                                    {runtime?.state ?? 'unknown'}
                                </StatusBadge>
                            ),
                        },
                        ...(runtime?.chatId
                            ? [{ label: 'Bound chat', value: runtime.chatId, mono: true }]
                            : []),
                    ]}
                />
                {runtime?.error ? (
                    <SettingsNote tone="error" role="alert">{runtime.error}</SettingsNote>
                ) : null}
            </SettingsSection>

            <SettingsSection title="Telegram hub" hint="One dashboard-owned bot routes Telegram chat topics to instances 3457–3506.">
                <ToggleField
                    id="hub-enabled" label="Enable hub" value={enabled}
                    onChange={(next) => { setEnabled(next); dirty.set('hub.enabled', { value: next, original: config.enabled, valid: true }); }}
                />
                <SecretField
                    id="hub-token" label="Bot token" value={token}
                    placeholder={config.hasToken ? '•••• (saved)' : 'paste bot token'}
                    onChange={(next) => { setToken(next); dirty.set('hub.token', { value: next, original: '', valid: true }); }}
                />
                <TextField
                    id="hub-chat-id" label="Hub chat ID" value={chatId} placeholder="823… or -100…"
                    onChange={(next) => { setChatId(next); dirty.set('hub.chatId', { value: next, original: config.chatId, valid: true }); }}
                />
                <label className="settings-field" htmlFor="hub-default-port">
                    <span className="settings-field-label">Default port</span>
                    <input
                        id="hub-default-port" type="number" min={PORT_MIN} max={PORT_MAX} value={defaultPort}
                        onChange={(e) => {
                            const next = Number(e.target.value);
                            setDefaultPort(next);
                            dirty.set('hub.defaultPort', { value: next, original: config.defaultPort, valid: next >= PORT_MIN && next <= PORT_MAX });
                        }}
                    />
                </label>
            </SettingsSection>

            <SettingsSection title="Topic routes" hint="(chatId, threadId) → instance port. Bind in a bot private topic or group topic with /setthread <port>.">
                {config.routes.length === 0 ? (
                    <SettingsNote>No routes yet.</SettingsNote>
                ) : (
                    <div className="settings-card-toolbar">
                        <table className="settings-overrides-table">
                            <thead><tr><th>Thread</th><th>Port</th><th>Label</th><th>Model</th><th>Prompt</th><th>On</th><th /></tr></thead>
                            <tbody>
                                {config.routes.map((r) => (
                                    <tr key={`${r.chatId}:${r.threadId}`}>
                                        <td>{r.threadId}</td><td>{r.port}</td><td>{r.label || '—'}</td>
                                        <td>{r.model || '—'}</td><td>{r.systemPrompt ? '✓' : '—'}</td>
                                        <td>{r.enabled ? '✓' : '—'}</td>
                                        <td>
                                            <button
                                                type="button"
                                                className="settings-action settings-action-danger"
                                                onClick={() => void removeRoute(r)}
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </SettingsSection>
        </form>
    );
}

export const __test__ = { defaultManagerClient };
