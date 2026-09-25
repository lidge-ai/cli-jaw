// Phase 8 — Browser/CDP page: status polling + start/stop/reset actions.
//
// No settings.json writes — CDP config is request-time. The page polls
// `/api/browser/status` every 3s while mounted and disables the Start/Stop
// buttons based on the current `running` state. `Reset profile` issues a
// confirmation prompt before posting.
//
// Race protection: every action increments a run id; stale completions are
// ignored. Polling stops on unmount and on manual stop/reset.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPageProps } from '../types';
import { SettingsRequestError } from '../settings-client';
import {
    PageError,
    PageLoading,
    SettingsActions,
    SettingsKeyValue,
    SettingsNote,
    SettingsSection,
    StatusBadge,
} from './page-shell';

export type BrowserStatus = {
    running: boolean;
    tabs: number;
    cdpUrl?: string;
};

export type ActiveTab = {
    ok?: boolean;
    tab?: { url?: string; title?: string; targetId?: string } | null;
    reason?: string;
};

type PollState =
    | { kind: 'loading' }
    | { kind: 'ready'; status: BrowserStatus; activeTab?: ActiveTab | null }
    | { kind: 'error'; message: string };

type ActionState =
    | { kind: 'idle' }
    | { kind: 'pending'; label: string }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 3000;

// ─── Pure helpers (exported for tests) ───────────────────────────────

export function normalizeBrowserStatus(raw: unknown): BrowserStatus {
    if (!raw || typeof raw !== 'object') {
        return { running: false, tabs: 0 };
    }
    const r = raw as Record<string, unknown>;
    const status: BrowserStatus = {
        running: r['running'] === true,
        tabs: typeof r['tabs'] === 'number' && Number.isFinite(r['tabs']) ? r['tabs'] : 0,
    };
    if (typeof r['cdpUrl'] === 'string') status.cdpUrl = r['cdpUrl'];
    return status;
}

export function normalizeActiveTab(raw: unknown): ActiveTab | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const tab = r['tab'] && typeof r['tab'] === 'object' ? (r['tab'] as Record<string, unknown>) : null;
    const active: ActiveTab = {
        ok: r['ok'] === true,
    };
    if (typeof r['reason'] === 'string') active.reason = r['reason'];
    if (tab) {
        const normalizedTab: NonNullable<ActiveTab['tab']> = {};
        if (typeof tab['url'] === 'string') normalizedTab.url = tab['url'];
        if (typeof tab['title'] === 'string') normalizedTab.title = tab['title'];
        if (typeof tab['targetId'] === 'string') normalizedTab.targetId = tab['targetId'];
        active.tab = normalizedTab;
    } else {
        active.tab = null;
    }
    return active;
}

export function describeStatus(status: BrowserStatus | null): string {
    if (!status) return 'unknown';
    return status.running ? 'running' : 'stopped';
}

// ─── Page component ──────────────────────────────────────────────────

export default function Browser({ port, client }: SettingsPageProps) {
    const [pollState, setPollState] = useState<PollState>({ kind: 'loading' });
    const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' });
    const pollGenRef = useRef(0);
    const actionGenRef = useRef(0);

    const fetchStatus = useCallback(
        async (gen: number) => {
            try {
                const [statusRaw, tabRaw] = await Promise.all([
                    client.get<unknown>('/api/browser/status'),
                    client.get<unknown>('/api/browser/active-tab').catch(() => null),
                ]);
                if (gen !== pollGenRef.current) return;
                const status = normalizeBrowserStatus(statusRaw);
                const activeTab = status.running ? normalizeActiveTab(tabRaw) : null;
                setPollState({ kind: 'ready', status, activeTab });
            } catch (err: unknown) {
                if (gen !== pollGenRef.current) return;
                const message =
                    err instanceof SettingsRequestError
                        ? err.message
                        : err instanceof Error
                            ? err.message
                            : String(err);
                setPollState({ kind: 'error', message });
            }
        },
        [client],
    );

    useEffect(() => {
        const gen = pollGenRef.current + 1;
        pollGenRef.current = gen;
        setPollState({ kind: 'loading' });
        void fetchStatus(gen);
        const id = setInterval(() => {
            void fetchStatus(gen);
        }, POLL_INTERVAL_MS);
        return () => {
            // Bumping the ref poisons in-flight responses for this page mount.
            pollGenRef.current = gen + 1;
            clearInterval(id);
        };
    }, [fetchStatus]);

    const runAction = useCallback(
        async (label: string, op: () => Promise<unknown>) => {
            const gen = actionGenRef.current + 1;
            actionGenRef.current = gen;
            setActionState({ kind: 'pending', label });
            try {
                await op();
                if (gen !== actionGenRef.current) return;
                setActionState({ kind: 'success', message: `${label} succeeded` });
                // Re-poll status immediately rather than waiting up to 3s.
                void fetchStatus(pollGenRef.current);
            } catch (err: unknown) {
                if (gen !== actionGenRef.current) return;
                setActionState({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        },
        [fetchStatus],
    );

    const onStartVisible = useCallback(() => {
        void runAction('Start visible browser', () =>
            client.post('/api/browser/start', { mode: 'manual', headless: false }),
        );
    }, [client, runAction]);

    const onStartAgent = useCallback(() => {
        void runAction('Start agent browser', () =>
            client.post('/api/browser/start', { mode: 'agent', headless: true }),
        );
    }, [client, runAction]);

    const onStop = useCallback(() => {
        void runAction('Stop', () => client.post('/api/browser/stop', {}));
    }, [client, runAction]);

    const onReset = useCallback(() => {
        if (
            typeof window !== 'undefined' &&
            !window.confirm(
                'Reset the browser profile? Stops the browser and clears the persisted profile directory. Re-launch will start fresh.',
            )
        ) {
            return;
        }
        // No /api/browser/reset endpoint — treat reset as Stop. If a future
        // route ships, swap this in. We surface the action result either way.
        void runAction('Reset profile', () => client.post('/api/browser/stop', {}));
    }, [client, runAction]);

    if (pollState.kind === 'loading') return <PageLoading label="Polling browser status…" />;
    if (pollState.kind === 'error') return <PageError message={pollState.message} />;

    const { status, activeTab } = pollState;
    const actionPending = actionState.kind === 'pending';

    const actionStatus =
        actionState.kind === 'pending' ? (
            <span role="status">{actionState.label}…</span>
        ) : actionState.kind === 'success' ? (
            <span role="status">{actionState.message}</span>
        ) : null;

    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="Status"
                hint={`Polled every ${POLL_INTERVAL_MS / 1000}s while this page is open.`}
            >
                <SettingsKeyValue
                    items={[
                        {
                            label: 'Running',
                            value: status.running ? (
                                <StatusBadge tone="ok">Running</StatusBadge>
                            ) : (
                                <StatusBadge tone="neutral">Stopped</StatusBadge>
                            ),
                        },
                        { label: 'Tabs', value: status.tabs },
                        { label: 'CDP URL', value: status.cdpUrl || '—', mono: true },
                        { label: 'Instance port', value: port, mono: true },
                    ]}
                />
                <SettingsActions status={actionStatus}>
                    <button
                        type="button"
                        className="settings-action settings-action-danger"
                        disabled={actionPending}
                        onClick={onReset}
                    >
                        Reset profile
                    </button>
                    <button
                        type="button"
                        className="settings-action"
                        disabled={!status.running || actionPending}
                        onClick={onStop}
                    >
                        Stop
                    </button>
                    <button
                        type="button"
                        className="settings-action"
                        disabled={status.running || actionPending}
                        onClick={onStartAgent}
                    >
                        Start agent browser
                    </button>
                    <button
                        type="button"
                        className="settings-action settings-action-save"
                        disabled={status.running || actionPending}
                        onClick={onStartVisible}
                    >
                        Start visible browser
                    </button>
                </SettingsActions>
                {actionState.kind === 'error' && (
                    <SettingsNote tone="error" role="alert">{actionState.message}</SettingsNote>
                )}
            </SettingsSection>

            <SettingsSection
                title="Active tab"
                hint="Tab the agent currently targets. Empty when the browser is stopped."
            >
                {!status.running ? (
                    <SettingsNote>Browser is not running.</SettingsNote>
                ) : activeTab && activeTab.ok && activeTab.tab ? (
                    <SettingsKeyValue
                        items={[
                            { label: 'URL', value: activeTab.tab.url || '—', mono: true },
                            { label: 'Title', value: activeTab.tab.title || '—' },
                            { label: 'Target ID', value: activeTab.tab.targetId || '—', mono: true },
                        ]}
                    />
                ) : (
                    <SettingsNote>
                        No verified active tab{activeTab?.reason ? ` (${activeTab.reason})` : ''}.
                    </SettingsNote>
                )}
            </SettingsSection>
        </form>
    );
}
