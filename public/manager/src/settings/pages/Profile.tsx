// Phase 2 — Profile page: locale, showReasoning, avatars.

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { SelectField, ToggleField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { AvatarCard } from './components/AvatarCard';
import { expandPatch } from './path-utils';

type ProfileSnapshot = {
    locale?: string;
    showReasoning?: boolean;
    [key: string]: unknown;
};

const LOCALE_OPTIONS = [
    { value: 'ko', label: '한국어 (ko)' },
    { value: 'en', label: 'English (en)' },
    { value: 'ja', label: '日本語 (ja)' },
    { value: 'zh', label: '中文 (zh)' },
];

export default function Profile({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<ProfileSnapshot>(client, '/api/settings');

    // Local field state mirrors snapshot + pending edits so dirty entries survive
    // re-renders without re-reading from snapshot on every keystroke.
    const [draft, setDraft] = useState<ProfileSnapshot>({});

    useEffect(() => {
        if (state.kind === 'ready') setDraft(state.data);
    }, [state]);

    useEffect(() => {
        return () => {
            // Clear dirty entries owned by this page on unmount so a stale draft
            // can't leak into another category's save bundle.
            for (const key of Array.from(dirty.pending.keys())) {
                if (key === 'locale' || key === 'showReasoning') {
                    dirty.remove(key);
                }
            }
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const patch = expandPatch(bundle);
        const updated = await client.put<ProfileSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: ProfileSnapshot }).data
            : updated) as ProfileSnapshot;
        dirty.clear();
        setDraft(fresh);
        setData(fresh);
        await refresh();
    }, [client, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const original = state.data;

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Profile"
                hint="Identity and display preferences for this instance."
            >
                <SelectField
                    id="profile-locale"
                    label="Locale"
                    value={draft.locale ?? original.locale ?? 'ko'}
                    options={LOCALE_OPTIONS}
                    onChange={(next) => {
                        setDraft({ ...draft, locale: next });
                        setEntry('locale', { value: next, original: original.locale ?? 'ko', valid: true });
                    }}
                />
                <ToggleField
                    id="profile-showReasoning"
                    label="Show reasoning traces"
                    value={Boolean(draft.showReasoning ?? original.showReasoning)}
                    onChange={(next) => {
                        setDraft({ ...draft, showReasoning: next });
                        setEntry('showReasoning', {
                            value: next,
                            original: Boolean(original.showReasoning),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>

            <SettingsSection title="Avatars" hint="Uploads write to the instance's home folder.">
                <AvatarCard kind="agent" client={client} />
                <AvatarCard kind="user" client={client} />
            </SettingsSection>
        </form>
    );
}
