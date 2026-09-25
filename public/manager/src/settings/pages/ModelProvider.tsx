// Phase 2 — Model & Provider page: per-CLI rows + fallback chip list +
// active-overrides table with reset button.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, SettingsClient, DirtyEntry } from '../types';
import { describeError } from '../components/error-normalize';
import { ChipListField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
    type SnapshotState,
} from './page-shell';
import { PerCliRow, type PiRegistration } from './components/PerCliRow';
import { metaFor, normalizeCliMetaRegistry, selectableRuntimeOptions, isRetiredCliSelection, retiredRuntimeLabel } from './components/agent/agent-meta';
import type { CliMeta, PerCliEntry } from './components/agent/agent-meta';
import type { PiSettingsView } from './components/pi-profile';
import { expandPatch } from './path-utils';

type ModelSnapshot = {
    perCli?: Record<string, PerCliEntry>;
    fallbackOrder?: string[];
    activeOverrides?: Record<string, { model?: string; effort?: string }>;
    pi?: PiSettingsView;
    [key: string]: unknown;
};
type ModelInstance = Pick<SettingsPageProps, 'client' | 'port' | 'dirty'>;
type BoundSnapshot = { instance: ModelInstance; value: ModelSnapshot };
const ownsModelKey = (key: string) => key === 'fallbackOrder' || key.startsWith('perCli.');

function savedModelSnapshot(updated: unknown): ModelSnapshot {
    const value = updated && typeof updated === 'object' && 'data' in updated ? updated.data : updated;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings response. Refresh before retrying.');
    return value as ModelSnapshot;
}

export function orderModelCliKeys(keys: string[]): string[] {
    return selectableRuntimeOptions(keys).sort((a, b) => {
        if (a === 'pi') return -1;
        if (b === 'pi') return 1;
        return 0;
    });
}

// Build a patch that clears every active override. Backend `mergeSettingsPatch`
// shallow-merges per-cli, so we must enumerate known cli keys (current
// overrides + perCli registry) and overwrite each one with empty fields. There
// is no DELETE endpoint as of Phase 2.
export function buildResetOverridesPatch(snapshot: ModelSnapshot): {
    activeOverrides: Record<string, { model: string; effort: string }>;
} {
    const keys = new Set<string>();
    for (const k of Object.keys(snapshot.activeOverrides || {})) keys.add(k);
    for (const k of Object.keys(snapshot.perCli || {})) keys.add(k);
    const activeOverrides: Record<string, { model: string; effort: string }> = {};
    for (const cli of keys) activeOverrides[cli] = { model: '', effort: '' };
    return { activeOverrides };
}

export default function ModelProvider({ port, client, dirty, registerSave }: SettingsPageProps) {
    const instance = useMemo<ModelInstance>(() => ({ client, port, dirty }), [client, port, dirty]);
    const activeInstance = useRef<ModelInstance | null>(null);
    const activeOperation = useRef<{ instance: ModelInstance; kind: 'save' | 'reset'; promise: Promise<void> } | null>(null);
    const metadataGeneration = useRef(0);
    // This private read adapter tags the helper's result, not the HTTP payload.
    // It is never passed to controls or writes. Even a ready result batched with
    // an instance change cannot be displayed as the new instance's settings.
    const snapshotClient = useMemo<SettingsClient>(() => ({ ...client,
        get: async <T,>(path: string, init?: RequestInit) => ({ instance,
            value: await client.get<ModelSnapshot>(path, init) }) as T,
    }), [client, instance]);
    const { state: boundState, refresh, setData: setBoundData } = usePageSnapshot<BoundSnapshot>(snapshotClient, '/api/settings', [port]);
    const state = useMemo<SnapshotState<ModelSnapshot>>(() => boundState.kind === 'ready'
        ? boundState.data.instance === instance ? { kind: 'ready', data: boundState.data.value } : { kind: 'loading' }
        : boundState, [boundState, instance]);
    const setData = useCallback((value: ModelSnapshot) => setBoundData({ instance, value }), [instance, setBoundData]);
    const [perCliDraft, setPerCliDraft] = useState<Record<string, PerCliEntry>>({});
    const [piDraft, setPiDraft] = useState<PiSettingsView | undefined>(undefined);
    const [fallback, setFallback] = useState<string[]>([]);
    const [resetting, setResetting] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [cliMeta, setCliMeta] = useState<Record<string, CliMeta> | null>(null);

    useLayoutEffect(() => {
        activeInstance.current = instance; activeOperation.current = null; ++metadataGeneration.current;
        setSaving(false); setResetting(false); setSaveError(null); setResetError(null); setCliMeta(null);
        return () => { activeInstance.current = null; activeOperation.current = null; ++metadataGeneration.current; };
    }, [instance]);
    const canEdit = useCallback(() => activeInstance.current === instance && !activeOperation.current, [instance]);

    const loadCliMeta = useCallback(async () => {
        if (activeInstance.current !== instance) return;
        const generation = ++metadataGeneration.current;
        try {
            const response = await client.get<{ data?: unknown } | Record<string, unknown>>('/api/cli-registry');
            if (activeInstance.current !== instance || generation !== metadataGeneration.current) return;
            const data = response && typeof response === 'object' && 'data' in response
                ? (response as { data?: unknown }).data
                : response;
            setCliMeta(normalizeCliMetaRegistry(data));
        } catch {
            if (activeInstance.current === instance && generation === metadataGeneration.current) setCliMeta(null);
        }
    }, [client, instance]);

    useEffect(() => {
        void loadCliMeta();
    }, [loadCliMeta]);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const nextPerCli = { ...(state.data.perCli || {}) };
        const ownBundle = Object.fromEntries(Object.entries(dirty.saveBundle()).filter(([key]) => ownsModelKey(key)));
        const pending = expandPatch(ownBundle)['perCli'];
        if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
            for (const [cli, entry] of Object.entries(pending)) {
                if (entry && typeof entry === 'object' && !Array.isArray(entry))
                    nextPerCli[cli] = { ...nextPerCli[cli], ...entry };
            }
        }
        setPerCliDraft(nextPerCli);
        setPiDraft(state.data.pi);
        setFallback([...(state.data.fallbackOrder || [])]);
    }, [state, dirty]);

    const onPiRegistered = useCallback((next: PiRegistration) => {
        if (activeInstance.current !== instance) return;
        // This is completion of an already-admitted server mutation, not a new
        // edit to admit while page input is locked. Keep newer entry identities.
        const original = state.kind === 'ready' ? state.data.perCli?.['pi'] : undefined;
        if (next.pi) setPiDraft(next.pi);
        setPerCliDraft(current => ({ ...current, pi: { ...current['pi'], provider: next.provider, model: next.model } }));
        dirty.set('perCli.pi.provider', { value: next.provider, original: original?.provider ?? 'progrok', valid: true });
        dirty.set('perCli.pi.model', { value: next.model, original: original?.model ?? '', valid: true });
    }, [dirty, instance, state]);

    useEffect(() => {
        return () => {
            for (const key of Array.from(dirty.pending.keys())) {
                if (ownsModelKey(key)) dirty.remove(key);
            }
        };
    }, [dirty, instance]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => { if (canEdit() && ownsModelKey(key)) dirty.set(key, entry); },
        [dirty, canEdit],
    );

    const onSave = useCallback((): Promise<void> => {
        if (activeInstance.current !== instance) return Promise.resolve();
        const pending = activeOperation.current;
        if (pending) return pending.kind === 'save' ? pending.promise
            : Promise.reject(new Error('Wait for the active override reset before saving.'));
        const bundle = Object.fromEntries(Object.entries(dirty.saveBundle()).filter(([key]) => ownsModelKey(key)));
        if (Object.keys(bundle).length === 0) return Promise.resolve();
        const patch = expandPatch(bundle);
        const submitted = new Map([...dirty.pending].filter(([key]) => Object.hasOwn(bundle, key)));
        setSaving(true); setSaveError(null);
        const operation = { instance, kind: 'save' as const, promise: Promise.resolve() };
        operation.promise = Promise.resolve().then(async () => {
            if (activeInstance.current !== instance) return;
            const updated = await client.put<ModelSnapshot>('/api/settings', patch);
            if (activeInstance.current !== instance) return;
            const fresh = savedModelSnapshot(updated);
            for (const [key, entry] of submitted) if (dirty.pending.get(key) === entry) dirty.remove(key);
            setData(fresh);
            await refresh();
            await loadCliMeta();
        }).catch(error => {
            if (activeInstance.current === instance) throw error;
        }).finally(() => {
            if (activeOperation.current === operation) activeOperation.current = null;
            if (activeInstance.current === instance) setSaving(false);
        });
        activeOperation.current = operation;
        return operation.promise;
    }, [client, dirty, instance, loadCliMeta, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const onResetOverrides = useCallback(() => {
        if (!canEdit() || state.kind !== 'ready') return;
        if (!window.confirm('Reset all active overrides?')) return;
        setResetting(true);
        setResetError(null);
        const patch = buildResetOverridesPatch(state.data);
        const operation = { instance, kind: 'reset' as const, promise: Promise.resolve() };
        operation.promise = Promise.resolve().then(async () => {
            if (activeInstance.current !== instance) return;
            const updated = await client.put<ModelSnapshot>('/api/settings', patch);
            if (activeInstance.current !== instance) return;
            const fresh = savedModelSnapshot(updated);
            setData(fresh);
            await refresh();
        }).catch((err: unknown) => {
            if (activeInstance.current === instance) setResetError(describeError(err));
        }).finally(() => {
            if (activeOperation.current === operation) activeOperation.current = null;
            if (activeInstance.current === instance) setResetting(false);
        });
        activeOperation.current = operation;
        return operation.promise;
    }, [canEdit, client, instance, refresh, setData, state]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const data = state.data;
    const perCliOriginal = data.perCli || {};
    const cliKeys = orderModelCliKeys(Object.keys(perCliOriginal));
    const overrides = data.activeOverrides || {};
    const overrideRows = Object.entries(overrides);

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave().catch((error: unknown) => {
                    if (activeInstance.current === instance) setSaveError(describeError(error));
                });
            }}
        >
            {saveError ? <PageError message={saveError} /> : null}
            <SettingsSection
                title="Model defaults"
                hint="Per-CLI model and runtime defaults. Runtime transport applies to the next run; display and permissions stay separate."
            >
                {cliKeys.length === 0 ? (
                    <p className="settings-empty">No CLIs registered for this instance.</p>
                ) : (
                    cliKeys.map((cli) => (
                        <PerCliRow
                            key={cli}
                            cli={cli}
                            meta={metaFor(cli, cliMeta)}
                            original={perCliOriginal[cli] || {}}
                            value={perCliDraft[cli] || perCliOriginal[cli] || {}}
                            dirty={dirty}
                            disabled={saving || resetting}
                            setValue={(next) => { if (canEdit()) setPerCliDraft({ ...perCliDraft, [cli]: next }); }}
                            setEntry={setEntry}
                            client={client}
                            pi={piDraft}
                            setPi={(next) => { if (canEdit()) setPiDraft(next); }}
                            onPiRegistered={onPiRegistered}
                        />
                    ))
                )}
            </SettingsSection>

            <SettingsSection
                title="Fallback order"
                hint="Order of CLIs used when the active CLI fails. Press Enter to add a chip; Backspace to remove the last."
            >
                <ChipListField
                    id="model-fallbackOrder"
                    label="Fallback order"
                    error={(() => {
                        const retired = fallback.find(isRetiredCliSelection);
                        if (!retired) return null;
                        const name = retiredRuntimeLabel(retired).replace(' (retired)', '');
                        return `A saved ${name} fallback is retired. Remove it before changing this order.`;
                    })()}
                    disabled={saving || resetting}
                    value={fallback}
                    onChange={(next) => {
                        if (!canEdit()) return;
                        setFallback(next);
                        setEntry('fallbackOrder', {
                            value: next,
                            original: data.fallbackOrder || [],
                            valid: !next.some(isRetiredCliSelection),
                        });
                    }}
                    placeholder="cli name"
                />
            </SettingsSection>

            <SettingsSection
                title="Active overrides"
                hint="Per-session overrides applied on top of per-CLI defaults."
            >
                {overrideRows.length === 0 ? (
                    <p className="settings-empty">No active overrides.</p>
                ) : (
                    <table className="settings-overrides-table">
                        <thead>
                            <tr>
                                <th scope="col">CLI</th>
                                <th scope="col">Model</th>
                                <th scope="col">Effort</th>
                            </tr>
                        </thead>
                        <tbody>
                            {overrideRows.map(([cli, cfg]) => (
                                <tr key={cli}>
                                    <td>{cli}</td>
                                    <td>
                                        <code>{cfg?.model || '—'}</code>
                                    </td>
                                    <td>
                                        <code>{cfg?.effort || '—'}</code>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="settings-overrides-actions">
                    <button
                        type="button"
                        className="settings-action settings-action-discard"
                        onClick={() => void onResetOverrides()}
                        disabled={saving || resetting || overrideRows.length === 0}
                    >
                        {resetting ? 'Resetting…' : 'Reset overrides'}
                    </button>
                    {resetError ? (
                        <span className="settings-field-error" role="alert">
                            {resetError}
                        </span>
                    ) : null}
                </div>
            </SettingsSection>
        </form>
    );
}
