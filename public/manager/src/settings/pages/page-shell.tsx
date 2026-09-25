// Phase 2 — shared visual + state helpers for category pages.
//
// `SettingsSection`, `PageError`, `PageLoading`, `SaveBar` are tiny presentational
// helpers used by all real pages. `usePageSnapshot` is a guarded loader that
// prevents stale state when `port` changes mid-flight.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { DirtyStore, SettingsClient } from '../types';
import { SettingsRequestError } from '../settings-client';

export type SnapshotState<T> =
    | { kind: 'loading' }
    | { kind: 'ready'; data: T }
    | { kind: 'offline' }
    | { kind: 'error'; message: string };

export function usePageSnapshot<T>(
    client: SettingsClient,
    path: string,
    deps: ReadonlyArray<unknown> = [],
): {
    state: SnapshotState<T>;
    refresh: () => Promise<void>;
    setData: (next: T) => void;
} {
    const [state, setState] = useState<SnapshotState<T>>({ kind: 'loading' });
    const [reloadTick, setReloadTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setState({ kind: 'loading' });
        client
            .get<T>(path)
            .then((data) => {
                if (cancelled) return;
                setState({ kind: 'ready', data });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState(toErrorState(err));
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, path, reloadTick, ...deps]);

    const refresh = useCallback(async () => {
        setReloadTick((tick) => tick + 1);
    }, []);

    const setData = useCallback((next: T) => {
        setState({ kind: 'ready', data: next });
    }, []);

    return { state, refresh, setData };
}

function toErrorState(err: unknown): SnapshotState<never> {
    if (err instanceof SettingsRequestError) {
        if (err.status === 401 || err.status === 403) {
            return {
                kind: 'error',
                message: 'Instance requires auth. Open its native UI to grant access.',
            };
        }
        if (err.status >= 500 || err.status === 0) {
            return { kind: 'offline' };
        }
        return { kind: 'error', message: err.message };
    }
    return {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
    };
}

export function SettingsSection({
    title,
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: ReactNode;
}) {
    return (
        <section className="settings-section">
            <header className="settings-section-header">
                <h2>{title}</h2>
                {hint ? <p className="settings-section-hint">{hint}</p> : null}
            </header>
            <div className="settings-section-body">{children}</div>
        </section>
    );
}

export function PageLoading({ label = 'Loading instance settings…' }: { label?: string }) {
    return <div className="settings-loading">{label}</div>;
}

export function PageError({ message }: { message: string }) {
    return (
        <div className="settings-error" role="alert">
            {message}
        </div>
    );
}

export function PageOffline({ port }: { port: number }) {
    return (
        <div className="settings-error" role="alert">
            Instance offline or proxy error. The dashboard could not reach
            <code> /i/{port}/api/settings</code>.
        </div>
    );
}

export type SaveBarProps = {
    saving: boolean;
    isDirty: boolean;
    error?: string | null;
    onDiscard: () => void;
};

export function SaveBar({ saving, isDirty, error, onDiscard }: SaveBarProps) {
    if (!isDirty && !saving && !error) return null;
    return (
        <div
            className="settings-page-savebar"
            role="group"
            aria-label="Page save controls"
        >
            {error ? (
                <span className="settings-savebar-error" role="alert">
                    {error}
                </span>
            ) : null}
            <button
                type="button"
                className="settings-action settings-action-discard"
                onClick={onDiscard}
                disabled={saving || !isDirty}
            >
                Discard
            </button>
            <button
                type="submit"
                className="settings-action settings-action-save"
                disabled={saving || !isDirty}
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    );
}

// ─── Card-body primitives ────────────────────────────────────────────
// Children of `SettingsSection` render as divided rows inside one card.
// These primitives share that row rhythm so pages never hand-roll grids,
// emoji status, or free-floating button strips.

export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral';

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
    return (
        <span className={`settings-status settings-status-${tone}`}>
            <span className="settings-status-dot" aria-hidden="true" />
            {children}
        </span>
    );
}

export type KeyValueItem = { label: string; value: ReactNode; mono?: boolean };

export function SettingsKeyValue({ items }: { items: ReadonlyArray<KeyValueItem> }) {
    return (
        <dl className="settings-kv">
            {items.map((item, index) => (
                <div className="settings-kv-row" key={index}>
                    <dt>{item.label}</dt>
                    <dd className={item.mono ? 'settings-kv-mono' : undefined}>{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function SettingsActions({
    children,
    status,
}: {
    children: ReactNode;
    status?: ReactNode;
}) {
    return (
        <div className="settings-card-actions">
            {status ? <div className="settings-card-actions-status">{status}</div> : null}
            <div className="settings-card-actions-buttons">{children}</div>
        </div>
    );
}

export function SettingsToolbar({ children }: { children: ReactNode }) {
    return <div className="settings-card-toolbar">{children}</div>;
}

export function SettingsNote({
    children,
    tone = 'muted',
    role,
}: {
    children: ReactNode;
    tone?: 'muted' | 'warn' | 'error';
    role?: 'status' | 'alert';
}) {
    return (
        <p className={`settings-card-note settings-card-note-${tone}`} role={role}>
            {children}
        </p>
    );
}
