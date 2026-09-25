// Phase 6 — Memory engine config + read-only browse + flush/reflect actions.
//
// Two independent saves:
//   A. Section A (engine) — coalesced into the shared SaveBar via the
//      page's registered save handler. Writes `memory.*` keys to
//      `/api/settings` PUT. The handler filters the dirty bundle so
//      unrelated keys (which shouldn't exist on this page) never leak.
//   B. Section B (browse) — read-only. Pulls all rows from
//      `/api/memory`, paginates client-side at 50/page. The plan
//      flagged server-side pagination as a P1 follow-up.
//   C. Section C (actions) — fire-and-forget POSTs against the
//      jaw-memory routes. We surface a queued banner because flush
//      runs async and only resolves "triggered" not "completed".

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { NumberField, SelectField, ToggleField } from '../fields';
import {
    SettingsActions,
    SettingsNote,
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';
import { MemoryRow } from './components/MemoryRow';
import {
    MEMORY_SECTION_A_KEYS,
    FLUSH_LANGUAGE_OPTIONS,
    MEMORY_PAGE_SIZE,
    isMemorySettingsKey,
    normalizeMemoryRows,
    paginate,
    validatePositiveInt,
    type MemoryBlock,
    type MemoryEntry,
} from './components/memory-helpers';
import { metaFor, selectableRuntimeOptions, isRetiredCliSelection, retiredRuntimeLabel } from './components/agent/agent-meta';

// Re-export pure helpers for unit tests (Heartbeat pattern).
export {
    MEMORY_SECTION_A_KEYS,
    MEMORY_PAGE_SIZE,
    FLUSH_LANGUAGE_OPTIONS,
    isMemorySettingsKey,
    normalizeMemoryRows,
    paginate,
    previewValue,
    validatePositiveInt,
} from './components/memory-helpers';
export type { MemoryEntry, MemoryBlock } from './components/memory-helpers';

type SettingsSnapshot = {
    memory?: MemoryBlock;
    perCli?: Record<string, unknown>;
    [key: string]: unknown;
};

type ActionState = {
    busy: 'flush' | 'reflect' | null;
    notice: string | null;
    error: string | null;
};

const INITIAL_ACTION_STATE: ActionState = { busy: null, notice: null, error: null };

export default function Memory({ port, client, dirty, registerSave }: SettingsPageProps) {
    const settingsSnap = usePageSnapshot<SettingsSnapshot>(client, '/api/settings');
    const memorySnap = usePageSnapshot<unknown>(client, '/api/memory');

    const [enabled, setEnabled] = useState(true);
    const [flushEvery, setFlushEvery] = useState(10);
    const [cli, setCli] = useState('');
    const [retentionDays, setRetentionDays] = useState(30);
    const [autoReflect, setAutoReflect] = useState(false);
    const [flushLanguage, setFlushLanguage] = useState('en');

    const [page, setPage] = useState(0);
    const [openEntry, setOpenEntry] = useState<MemoryEntry | null>(null);
    const [actionState, setActionState] = useState<ActionState>(INITIAL_ACTION_STATE);

    useEffect(() => {
        if (settingsSnap.state.kind !== 'ready') return;
        const mem = settingsSnap.state.data.memory || {};
        setEnabled(mem.enabled !== false);
        setFlushEvery(typeof mem.flushEvery === 'number' ? mem.flushEvery : 10);
        setCli(typeof mem.cli === 'string' ? mem.cli : '');
        setRetentionDays(typeof mem.retentionDays === 'number' ? mem.retentionDays : 30);
        setAutoReflect(Boolean(mem.autoReflectAfterFlush));
        setFlushLanguage(typeof mem.flushLanguage === 'string' && mem.flushLanguage ? mem.flushLanguage : 'en');
    }, [settingsSnap.state]);

    useEffect(() => {
        return () => {
            for (const key of MEMORY_SECTION_A_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    // Dismiss the modal on Esc and reset on snapshot changes.
    useEffect(() => {
        if (!openEntry) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpenEntry(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [openEntry]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<MemoryBlock>(() => {
        if (settingsSnap.state.kind !== 'ready') return {};
        return settingsSnap.state.data.memory || {};
    }, [settingsSnap.state]);

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(bundle)) {
            if (isMemorySettingsKey(key)) filtered[key] = value;
        }
        if (Object.keys(filtered).length === 0) return;
        const patch = expandPatch(filtered);
        const updated = await client.put<SettingsSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: SettingsSnapshot }).data
            : updated) as SettingsSnapshot;
        for (const key of MEMORY_SECTION_A_KEYS) dirty.remove(key);
        settingsSnap.setData(fresh);
        const mem = fresh.memory || {};
        setEnabled(mem.enabled !== false);
        setFlushEvery(typeof mem.flushEvery === 'number' ? mem.flushEvery : 10);
        setCli(typeof mem.cli === 'string' ? mem.cli : '');
        setRetentionDays(typeof mem.retentionDays === 'number' ? mem.retentionDays : 30);
        setAutoReflect(Boolean(mem.autoReflectAfterFlush));
        setFlushLanguage(typeof mem.flushLanguage === 'string' && mem.flushLanguage ? mem.flushLanguage : 'en');
        await settingsSnap.refresh();
    }, [client, dirty, settingsSnap]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const onFlush = useCallback(async () => {
        setActionState({ busy: 'flush', notice: null, error: null });
        try {
            await client.post('/api/jaw-memory/flush', {});
            setActionState({
                busy: null,
                notice: 'Memory flush queued. Browse refreshes when it completes.',
                error: null,
            });
            await memorySnap.refresh();
        } catch (err: unknown) {
            setActionState({
                busy: null,
                notice: null,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }, [client, memorySnap]);

    const onReflect = useCallback(async () => {
        setActionState({ busy: 'reflect', notice: null, error: null });
        try {
            await client.post('/api/jaw-memory/reflect', {});
            setActionState({
                busy: null,
                notice: 'Reflect complete.',
                error: null,
            });
            await memorySnap.refresh();
        } catch (err: unknown) {
            setActionState({
                busy: null,
                notice: null,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }, [client, memorySnap]);

    const onExport = useCallback(() => {
        if (memorySnap.state.kind !== 'ready') return;
        const rows = normalizeMemoryRows(memorySnap.state.data);
        const blob = new Blob([JSON.stringify(rows, null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jaw-memory-${port}-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, [memorySnap.state, port]);

    if (settingsSnap.state.kind === 'loading') return <PageLoading />;
    if (settingsSnap.state.kind === 'offline') return <PageOffline port={port} />;
    if (settingsSnap.state.kind === 'error')
        return <PageError message={settingsSnap.state.message} />;

    const flushEveryError = validatePositiveInt(flushEvery, 'Flush every');
    const retentionError = validatePositiveInt(retentionDays, 'Retention days');

    const perCli = settingsSnap.state.data.perCli || {};
    const cliKeys = selectableRuntimeOptions(Object.keys(perCli));
    const cliOptions = [
        { value: '', label: '(profile default)' },
        ...cliKeys.map((c) => ({ value: c, label: metaFor(c).label || c })),
    ];
    if (cli && !isRetiredCliSelection(cli) && !cliOptions.some((opt) => opt.value === cli)) {
        cliOptions.push({ value: cli, label: `${metaFor(cli).label || cli} (legacy)` });
    }

    const allRows =
        memorySnap.state.kind === 'ready'
            ? normalizeMemoryRows(memorySnap.state.data)
            : [];
    // Clamp `page` if the row list shrank (e.g. after a flush) — without
    // this the user can sit on an empty page-N with no way back.
    const safePage = Math.min(
        page,
        Math.max(0, Math.ceil(allRows.length / MEMORY_PAGE_SIZE) - 1),
    );
    const { slice, hasMore, pageCount } = paginate(allRows, safePage);

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Memory engine"
                hint="Background memory flush and reflection cadence."
            >
                <ToggleField
                    id="memory-enabled"
                    label="Memory enabled"
                    value={enabled}
                    onChange={(next) => {
                        setEnabled(next);
                        setEntry('memory.enabled', {
                            value: next,
                            original: original.enabled !== false,
                            valid: true,
                        });
                    }}
                />
                <NumberField
                    id="memory-flush-every"
                    label="Flush every (sessions)"
                    value={flushEvery}
                    min={1}
                    error={flushEveryError}
                    onChange={(next) => {
                        setFlushEvery(next);
                        setEntry('memory.flushEvery', {
                            value: next,
                            original: typeof original.flushEvery === 'number' ? original.flushEvery : 10,
                            valid: validatePositiveInt(next, 'Flush every') === null,
                        });
                    }}
                />
                <SelectField
                    id="memory-cli"
                    label="Flush CLI"
                    value={cli}
                    missingValueLabel={isRetiredCliSelection(cli) ? retiredRuntimeLabel(cli) : undefined}
                    error={isRetiredCliSelection(cli) ? 'The saved runtime is retired. Choose an available runtime.' : null}
                    options={cliOptions}
                    onChange={(next) => {
                        setCli(next);
                        setEntry('memory.cli', {
                            value: next,
                            original: original.cli ?? '',
                            valid: true,
                        });
                    }}
                />
                <NumberField
                    id="memory-retention"
                    label="Retention days"
                    value={retentionDays}
                    min={1}
                    error={retentionError}
                    onChange={(next) => {
                        setRetentionDays(next);
                        setEntry('memory.retentionDays', {
                            value: next,
                            original: typeof original.retentionDays === 'number' ? original.retentionDays : 30,
                            valid: validatePositiveInt(next, 'Retention days') === null,
                        });
                    }}
                />
                <ToggleField
                    id="memory-auto-reflect"
                    label="Auto-reflect after flush"
                    value={autoReflect}
                    onChange={(next) => {
                        setAutoReflect(next);
                        setEntry('memory.autoReflectAfterFlush', {
                            value: next,
                            original: Boolean(original.autoReflectAfterFlush),
                            valid: true,
                        });
                    }}
                />
                <SelectField
                    id="memory-flush-language"
                    label="Flush language"
                    value={flushLanguage}
                    options={[...FLUSH_LANGUAGE_OPTIONS]}
                    onChange={(next) => {
                        setFlushLanguage(next);
                        setEntry('memory.flushLanguage', {
                            value: next,
                            original: original.flushLanguage ?? 'en',
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Stored entries"
                hint={`Read-only browse of the key/value memory table (${MEMORY_PAGE_SIZE}/page).`}
            >
                {memorySnap.state.kind === 'loading' ? (
                    <SettingsNote>Loading entries…</SettingsNote>
                ) : memorySnap.state.kind === 'offline' ? (
                    <PageOffline port={port} />
                ) : memorySnap.state.kind === 'error' ? (
                    <PageError message={memorySnap.state.message} />
                ) : allRows.length === 0 ? (
                    <SettingsNote>No memory entries yet.</SettingsNote>
                ) : (
                    <>
                        {slice.map((row) => (
                            <MemoryRow
                                key={row.key}
                                row={row}
                                onOpen={setOpenEntry}
                            />
                        ))}
                        <SettingsActions
                            status={<span>Page {page + 1} / {pageCount}</span>}
                        >
                            <button
                                type="button"
                                className="settings-action"
                                disabled={page === 0}
                                onClick={() => setPage((p) => Math.max(0, p - 1))}
                            >
                                Prev
                            </button>
                            <button
                                type="button"
                                className="settings-action"
                                disabled={!hasMore}
                                onClick={() => setPage((p) => p + 1)}
                            >
                                Next
                            </button>
                        </SettingsActions>
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                title="Actions"
                hint="Flush runs async — the browse list refreshes when it finishes."
            >
                <SettingsActions
                    status={
                        actionState.notice ? (
                            <span role="status">{actionState.notice}</span>
                        ) : undefined
                    }
                >
                    <button
                        type="button"
                        className="settings-action settings-action-save"
                        disabled={actionState.busy !== null}
                        onClick={() => void onFlush()}
                    >
                        {actionState.busy === 'flush' ? 'Queuing…' : 'Flush now'}
                    </button>
                    <button
                        type="button"
                        className="settings-action settings-action-save"
                        disabled={actionState.busy !== null}
                        onClick={() => void onReflect()}
                    >
                        {actionState.busy === 'reflect' ? 'Reflecting…' : 'Reflect soul'}
                    </button>
                    <button
                        type="button"
                        className="settings-action"
                        disabled={memorySnap.state.kind !== 'ready'}
                        onClick={onExport}
                    >
                        Export memory
                    </button>
                </SettingsActions>
                {actionState.error ? (
                    <SettingsNote tone="error" role="alert">
                        {actionState.error}
                    </SettingsNote>
                ) : null}
            </SettingsSection>

            {openEntry ? (
                <div
                    className="settings-memory-modal settings-pi-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Memory entry ${openEntry.key}`}
                    onClick={(event) => {
                        if (event.target === event.currentTarget) setOpenEntry(null);
                    }}
                >
                    <div className="settings-memory-modal-card">
                        <header className="settings-memory-modal-header">
                            <h3>{openEntry.key}</h3>
                            <button
                                type="button"
                                className="settings-action"
                                onClick={() => setOpenEntry(null)}
                                aria-label="Close memory entry"
                            >
                                Close
                            </button>
                        </header>
                        <pre
                            className="settings-memory-modal-body"
                        >
                            {openEntry.value}
                        </pre>
                    </div>
                </div>
            ) : null}
        </form>
    );
}
