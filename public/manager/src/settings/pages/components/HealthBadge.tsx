// Phase 3 — small health badge for Telegram + Discord.
//
// Probes either a per-channel endpoint (e.g. `/api/telegram/probe`) or
// `/api/health` and renders a colored pill. Endpoints may not exist yet
// on every instance: a 404 is treated as "unknown" and shown grey, not
// as a hard error. Network/auth errors surface inline so the user knows
// why the badge is grey.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsClient } from '../../types';
import { SettingsRequestError } from '../../settings-client';
import { StatusBadge } from '../page-shell';
import type { StatusTone } from '../page-shell';

export type HealthState =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ok'; detail?: string }
    | { kind: 'degraded'; detail: string }
    | { kind: 'unknown'; reason: string }
    | { kind: 'error'; reason: string };

type Props = {
    client: SettingsClient;
    label: string;
    /** Primary endpoint, e.g. `/api/telegram/probe` (POST) or `/api/health` (GET). */
    endpoint: string;
    method?: 'GET' | 'POST';
    /** Map the response payload to a health state. Pure — no side effects. */
    interpret: (payload: unknown) => HealthState;
    /** When true, run an automatic probe on mount. */
    auto?: boolean;
};

export function HealthBadge({ client, label, endpoint, method = 'GET', interpret, auto = false }: Props) {
    const [state, setState] = useState<HealthState>({ kind: 'idle' });
    const inflight = useRef<AbortController | null>(null);
    const mounted = useRef(true);

    const probe = useCallback(async () => {
        inflight.current?.abort();
        const controller = new AbortController();
        inflight.current = controller;
        setState({ kind: 'checking' });
        try {
            const payload = method === 'POST'
                ? await client.post<unknown>(endpoint, {}, { signal: controller.signal })
                : await client.get<unknown>(endpoint, { signal: controller.signal });
            if (!mounted.current || controller.signal.aborted) return;
            setState(interpret(payload));
        } catch (err: unknown) {
            if (!mounted.current || controller.signal.aborted) return;
            if (err instanceof SettingsRequestError && err.status === 404) {
                setState({ kind: 'unknown', reason: 'Probe endpoint not implemented on this instance.' });
                return;
            }
            const reason = err instanceof Error ? err.message : String(err);
            setState({ kind: 'error', reason });
        }
    }, [client, endpoint, interpret, method]);

    useEffect(() => {
        mounted.current = true;
        if (auto) void probe();
        return () => {
            mounted.current = false;
            inflight.current?.abort();
        };
    }, [auto, probe]);

    const tone: StatusTone =
        state.kind === 'ok' ? 'ok'
            : state.kind === 'degraded' ? 'warn'
                : state.kind === 'error' ? 'error'
                    : 'neutral';
    return (
        <div className="settings-health-badge settings-card-toolbar" role="status" aria-live="polite">
            <button
                type="button"
                className="settings-action"
                onClick={() => void probe()}
                disabled={state.kind === 'checking'}
            >
                {state.kind === 'checking' ? 'Checking…' : `Check ${label}`}
            </button>
            <StatusBadge tone={tone}>{pillLabel(state)}</StatusBadge>
            {detailFor(state) ? (
                <span className="settings-health-detail settings-field-hint">{detailFor(state)}</span>
            ) : null}
        </div>
    );
}

function pillLabel(state: HealthState): string {
    switch (state.kind) {
        case 'idle': return 'Not checked';
        case 'checking': return 'Checking';
        case 'ok': return 'Healthy';
        case 'degraded': return 'Degraded';
        case 'unknown': return 'Unknown';
        case 'error': return 'Error';
    }
}

function detailFor(state: HealthState): string | null {
    if (state.kind === 'ok' && state.detail) return state.detail;
    if (state.kind === 'degraded') return state.detail;
    if (state.kind === 'unknown') return state.reason;
    if (state.kind === 'error') return state.reason;
    return null;
}

// ─── Interpreters exposed for tests / page reuse ─────────────────────

export function interpretTelegramProbe(payload: unknown): HealthState {
    if (!payload || typeof payload !== 'object') {
        return { kind: 'unknown', reason: 'Empty probe response.' };
    }
    const p = payload as Record<string, unknown>;
    if (p['ok'] === true) {
        const username = typeof p['username'] === 'string' ? p['username'] : undefined;
        return username ? { kind: 'ok', detail: `@${username}` } : { kind: 'ok' };
    }
    const reason = typeof p['error'] === 'string' ? p['error'] : 'Probe failed.';
    return { kind: 'error', reason };
}

export function interpretDiscordHealth(payload: unknown): HealthState {
    if (!payload || typeof payload !== 'object') {
        return { kind: 'unknown', reason: 'Empty health response.' };
    }
    const p = payload as Record<string, unknown>;
    const discord = (p['discord'] && typeof p['discord'] === 'object')
        ? p['discord'] as Record<string, unknown>
        : null;
    if (!discord) {
        return { kind: 'unknown', reason: 'No discord block in /api/health.' };
    }
    if (discord['ready'] === true && discord['degraded'] !== true) {
        return { kind: 'ok' };
    }
    if (discord['degraded'] === true) {
        const why = typeof discord['degradedReason'] === 'string'
            ? discord['degradedReason']
            : 'MESSAGE_CONTENT intent missing — slash commands only.';
        return { kind: 'degraded', detail: why };
    }
    if (discord['ready'] === false) {
        const why = typeof discord['error'] === 'string' ? discord['error'] : 'Bot not connected.';
        return { kind: 'error', reason: why };
    }
    return { kind: 'unknown', reason: 'Discord status indeterminate.' };
}
