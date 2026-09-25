// Display page: conversation presentation and tui.* fields.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { SelectField, NumberField } from '../fields';
import { isPresentationMode, presentationMode, type PresentationMode } from '../../../../../src/shared/presentation';
import { describeError } from '../components/error-normalize';
import {
    SettingsSection,
    SettingsNote,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';

type TuiBlock = {
    pasteCollapseLines?: number;
    pasteCollapseChars?: number;
    keymapPreset?: string;
    diffStyle?: string;
    themeSeed?: string;
};

type DisplaySnapshot = {
    tui?: TuiBlock;
    presentation?: { mode?: PresentationMode };
    [key: string]: unknown;
};

const THEME_OPTIONS = [
    { value: 'jaw-default', label: 'Jaw default' },
    { value: 'jaw-dark', label: 'Jaw dark' },
    { value: 'jaw-light', label: 'Jaw light' },
    { value: 'jaw-contrast', label: 'High contrast' },
];

const KEYMAP_OPTIONS = [
    { value: 'default', label: 'default' },
    { value: 'vim', label: 'vim' },
    { value: 'emacs', label: 'emacs' },
];

const DIFF_OPTIONS = [
    { value: 'summary', label: 'summary' },
    { value: 'unified', label: 'unified' },
    { value: 'side-by-side', label: 'side-by-side' },
];

const DISPLAY_KEYS = [
    'presentation.mode',
    'tui.themeSeed',
    'tui.keymapPreset',
    'tui.pasteCollapseLines',
    'tui.pasteCollapseChars',
    'tui.diffStyle',
] as const;

export default function Display({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<DisplaySnapshot>(client, '/api/settings', [port]);
    const [draft, setDraft] = useState<TuiBlock>({});
    const pendingMode = useSyncExternalStore(dirty.subscribe,
        () => dirty.pending.get('presentation.mode')?.value, () => undefined);
    const mode = isPresentationMode(pendingMode) ? pendingMode
        : presentationMode(state.kind === 'ready' ? state.data : undefined);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const activeInstance = useRef<{ client: SettingsPageProps['client']; port: number } | null>(null);
    const activeSave = useRef<{ instance: NonNullable<typeof activeInstance.current>; promise: Promise<void> } | null>(null);

    // Each committed instance gets a distinct generation, including A -> B -> A.
    // Layout cleanup fences pending writes before they can resume after a commit.
    useLayoutEffect(() => {
        activeInstance.current = { client, port };
        activeSave.current = null;
        setSaving(false);
        return () => { activeInstance.current = null; activeSave.current = null; };
    }, [client, port, dirty]);

    useEffect(() => {
        if (state.kind === 'ready') {
            setDraft({ ...(state.data.tui || {}) });
        }
    }, [state]);

    useEffect(() => {
        setDraft({});
        setSaveError(null);
        return () => {
            for (const key of DISPLAY_KEYS) dirty.remove(key);
        };
    }, [client, port, dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const onSave = useCallback((): Promise<void> => {
        const instance = activeInstance.current;
        if (!instance || instance.client !== client || instance.port !== port) return Promise.resolve();
        if (activeSave.current?.instance === instance) return activeSave.current.promise;
        setSaveError(null);
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return Promise.resolve();
        const patch = expandPatch(bundle);
        const submitted = new Map([...dirty.pending].filter(([key]) => Object.hasOwn(bundle, key)));
        setSaving(true);
        const operation = { instance, promise: Promise.resolve() };
        operation.promise = Promise.resolve().then(async () => {
            if (activeInstance.current !== instance) return;
            const updated = await client.put<DisplaySnapshot>('/api/settings', patch);
            if (activeInstance.current !== instance) return;
            const fresh = (updated && typeof updated === 'object' && 'data' in updated
                ? (updated as { data: DisplaySnapshot }).data
                : updated) as DisplaySnapshot;
            // A completion acknowledges only entries actually submitted by this
            // operation, never a newer or unrelated write into the dirty store.
            for (const [key, entry] of submitted) if (dirty.pending.get(key) === entry) dirty.remove(key);
            setDraft({ ...(fresh.tui || {}) });
            setData(fresh);
            await refresh();
        }).finally(() => {
            if (activeSave.current === operation) activeSave.current = null;
            if (activeInstance.current === instance) setSaving(false);
        });
        activeSave.current = operation;
        return operation.promise;
    }, [client, port, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const original = state.data.tui || {};

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                const instance = activeInstance.current;
                void onSave().catch((error: unknown) => {
                    if (instance && activeInstance.current === instance) setSaveError(describeError(error));
                });
            }}
        >
            <SettingsSection
                title="Conversation display"
                hint="Changes conversation display only. Runtime and permissions stay unchanged."
            >
                {saveError ? <SettingsNote tone="error" role="alert">{saveError}</SettingsNote> : null}
                <SelectField
                    disabled={saving}
                    id="display-presentation-mode"
                    label="Presentation"
                    value={mode}
                    options={[
                        { value: 'activity', label: 'Activity (default)' },
                        { value: 'legacy', label: 'Legacy transcript' },
                    ]}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        if (next !== 'activity' && next !== 'legacy') return;
                        setEntry('presentation.mode', {
                            value: next,
                            original: presentationMode(state.data),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
            <SettingsSection
                title="Display"
                hint={`TUI options applied to /i/${port}.`}
            >
                <SelectField
                    disabled={saving}
                    id="display-themeSeed"
                    label="Theme seed"
                    value={draft.themeSeed ?? original.themeSeed ?? 'jaw-default'}
                    options={THEME_OPTIONS}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        setDraft({ ...draft, themeSeed: next });
                        setEntry('tui.themeSeed', {
                            value: next,
                            original: original.themeSeed ?? 'jaw-default',
                            valid: true,
                        });
                    }}
                />
                <SelectField
                    disabled={saving}
                    id="display-keymapPreset"
                    label="Keymap preset"
                    value={draft.keymapPreset ?? original.keymapPreset ?? 'default'}
                    options={KEYMAP_OPTIONS}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        setDraft({ ...draft, keymapPreset: next });
                        setEntry('tui.keymapPreset', {
                            value: next,
                            original: original.keymapPreset ?? 'default',
                            valid: true,
                        });
                    }}
                />
                <NumberField
                    disabled={saving}
                    id="display-pasteCollapseLines"
                    label="Paste collapse — lines"
                    value={draft.pasteCollapseLines ?? original.pasteCollapseLines ?? 2}
                    min={0}
                    step={1}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        setDraft({ ...draft, pasteCollapseLines: next });
                        setEntry('tui.pasteCollapseLines', {
                            value: next,
                            original: original.pasteCollapseLines ?? 2,
                            valid: Number.isFinite(next) && next >= 0,
                        });
                    }}
                />
                <NumberField
                    disabled={saving}
                    id="display-pasteCollapseChars"
                    label="Paste collapse — chars"
                    value={draft.pasteCollapseChars ?? original.pasteCollapseChars ?? 160}
                    min={0}
                    step={10}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        setDraft({ ...draft, pasteCollapseChars: next });
                        setEntry('tui.pasteCollapseChars', {
                            value: next,
                            original: original.pasteCollapseChars ?? 160,
                            valid: Number.isFinite(next) && next >= 0,
                        });
                    }}
                />
                <SelectField
                    disabled={saving}
                    id="display-diffStyle"
                    label="Diff style"
                    value={draft.diffStyle ?? original.diffStyle ?? 'summary'}
                    options={DIFF_OPTIONS}
                    onChange={(next) => {
                        if (activeSave.current) return;
                        setDraft({ ...draft, diffStyle: next });
                        setEntry('tui.diffStyle', {
                            value: next,
                            original: original.diffStyle ?? 'summary',
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
        </form>
    );
}
