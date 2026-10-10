// Phase 5 — Heartbeat scheduler & job CRUD page (composition root).
//
// Three independent saves:
//   A. Section A (global) — coalesced into the shared SaveBar via the
//      page's registered save handler. Touches /api/settings under
//      `heartbeat.*` keys. The save handler filters the dirty bundle
//      to only `heartbeat.*` (excluding `heartbeat.jobs` / `heartbeat.md`
//      which are owned by the per-section components).
//   B. Section B (jobs) — see HeartbeatJobsSection. Whole-array PUT
//      to /api/heartbeat. Uses a synthetic `heartbeat.jobs` dirty key
//      so the shell knows the page is dirty but the shared handler
//      skips it.
//   C. Section C (markdown) — see HeartbeatMarkdownSection. Same
//      pattern with key `heartbeat.md`.
//
// Helpers (validators, normalizers) live in components/heartbeat-helpers.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { TextField, ToggleField, SelectField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';
import { HeartbeatJobsSection } from './components/HeartbeatJobsSection';
import { HeartbeatMarkdownSection } from './components/HeartbeatMarkdownSection';
import {
    SECTION_A_KEYS,
    TARGET_FALLBACK,
    isHeartbeatSettingsKey,
    validateHHMM,
    validateInterval,
} from './components/heartbeat-helpers';
import { metaFor, selectableRuntimeOptions, isRetiredCliSelection, retiredRuntimeLabel } from './components/agent/agent-meta';

// Re-export helpers (and types) that tests import from this module.
export {
    SECTION_A_KEYS,
    PAGE_LOCAL_KEYS,
    TARGET_FALLBACK,
    isHeartbeatSettingsKey,
    validateHHMM,
    validateInterval,
    makeDefaultJob,
    normalizeJobsResponse,
    jobScheduleBodyError,
    jobsHaveErrors,
} from './components/heartbeat-helpers';
export type {
    HbJob,
    HbSchedule,
    HbScheduleEvery,
    HbScheduleCron,
} from './components/heartbeat-helpers';

type ActiveHours = { start?: string; end?: string };
type HeartbeatBlock = {
    enabled?: boolean;
    every?: string;
    activeHours?: ActiveHours;
    target?: string;
};
type SettingsSnapshot = {
    cli?: string;
    heartbeat?: HeartbeatBlock;
    perCli?: Record<string, unknown>;
    [key: string]: unknown;
};

export default function Heartbeat({ port, client, dirty, registerSave }: SettingsPageProps) {
    const settingsSnap = usePageSnapshot<SettingsSnapshot>(client, '/api/settings');
    const jobsSnap = usePageSnapshot<{ jobs?: unknown }>(client, '/api/heartbeat');
    const mdSnap = usePageSnapshot<{ content?: string }>(client, '/api/heartbeat-md');

    const [hbEnabled, setHbEnabled] = useState(false);
    const [hbEvery, setHbEvery] = useState('30m');
    const [hbStart, setHbStart] = useState('08:00');
    const [hbEnd, setHbEnd] = useState('22:00');
    const [hbTarget, setHbTarget] = useState('all');

    useEffect(() => {
        if (settingsSnap.state.kind !== 'ready') return;
        const hb = settingsSnap.state.data.heartbeat || {};
        setHbEnabled(Boolean(hb.enabled));
        setHbEvery(typeof hb.every === 'string' ? hb.every : '30m');
        setHbStart(hb.activeHours?.start ?? '08:00');
        setHbEnd(hb.activeHours?.end ?? '22:00');
        setHbTarget(typeof hb.target === 'string' ? hb.target : 'all');
    }, [settingsSnap.state]);

    useEffect(() => {
        return () => {
            for (const key of SECTION_A_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const originalHb: HeartbeatBlock = useMemo(() => {
        if (settingsSnap.state.kind !== 'ready') return {};
        return settingsSnap.state.data.heartbeat || {};
    }, [settingsSnap.state]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    // Race guard: a stale promise (instance switch, port change, double
    // click) can't stomp fresh local state.
    const saveTokenRef = useRef(0);

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(bundle)) {
            if (isHeartbeatSettingsKey(key)) filtered[key] = value;
        }
        if (Object.keys(filtered).length === 0) return;
        const token = ++saveTokenRef.current;
        const patch = expandPatch(filtered);
        const updated = await client.put<SettingsSnapshot>('/api/settings', patch);
        if (token !== saveTokenRef.current) return;
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: SettingsSnapshot }).data
            : updated) as SettingsSnapshot;
        // Only clear keys we actually saved; leave heartbeat.jobs +
        // heartbeat.md alone so their per-section buttons stay armed.
        for (const key of SECTION_A_KEYS) dirty.remove(key);
        settingsSnap.setData(fresh);
        const hb = fresh.heartbeat || {};
        setHbEnabled(Boolean(hb.enabled));
        setHbEvery(typeof hb.every === 'string' ? hb.every : '30m');
        setHbStart(hb.activeHours?.start ?? '08:00');
        setHbEnd(hb.activeHours?.end ?? '22:00');
        setHbTarget(typeof hb.target === 'string' ? hb.target : 'all');
        await settingsSnap.refresh();
    }, [client, dirty, settingsSnap]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (settingsSnap.state.kind === 'loading') return <PageLoading />;
    if (settingsSnap.state.kind === 'offline') return <PageOffline port={port} />;
    if (settingsSnap.state.kind === 'error')
        return <PageError message={settingsSnap.state.message} />;

    const everyError = !validateInterval(hbEvery)
        ? 'Use the form `<n>s|m|h`, e.g. `30m`'
        : null;
    const startError = !validateHHMM(hbStart) ? 'Use HH:MM (24h)' : null;
    const endError = !validateHHMM(hbEnd) ? 'Use HH:MM (24h)' : null;

    const perCli = settingsSnap.state.data.perCli || {};
    const cliKeys = selectableRuntimeOptions(Object.keys(perCli));
    const targetSource = cliKeys.length > 0 ? cliKeys : [...TARGET_FALLBACK];
    const targetOptions = [
        { value: 'all', label: 'all (broadcast)' },
        ...targetSource.map((cli) => ({ value: cli, label: metaFor(cli).label || cli })),
    ];
    if (!isRetiredCliSelection(hbTarget) && !targetOptions.some((opt) => opt.value === hbTarget)) {
        targetOptions.push({ value: hbTarget, label: `${metaFor(hbTarget).label || hbTarget} (legacy)` });
    }

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Heartbeat"
                hint="Background prompts the agent runs on a schedule."
            >
                {settingsSnap.state.data.cli === 'aside' ? (
                    <div className="settings-inline-notice" role="status">
                        <p>Scheduled heartbeat runs are unsupported with Aside as the main runtime and will be rejected. Choose another main runtime in Agent settings to use heartbeat.</p>
                    </div>
                ) : null}
                <ToggleField
                    id="hb-enabled"
                    label="Heartbeat enabled"
                    value={hbEnabled}
                    onChange={(next) => {
                        setHbEnabled(next);
                        setEntry('heartbeat.enabled', {
                            value: next,
                            original: Boolean(originalHb.enabled),
                            valid: true,
                        });
                    }}
                />
                <TextField
                    id="hb-every"
                    label="Default interval"
                    value={hbEvery}
                    placeholder="30m"
                    error={everyError}
                    onChange={(next) => {
                        setHbEvery(next);
                        setEntry('heartbeat.every', {
                            value: next,
                            original: originalHb.every ?? '30m',
                            valid: validateInterval(next),
                        });
                    }}
                />
                <TextField
                    id="hb-start"
                    label="Active hours start"
                    value={hbStart}
                    placeholder="08:00"
                    error={startError}
                    onChange={(next) => {
                        setHbStart(next);
                        setEntry('heartbeat.activeHours.start', {
                            value: next,
                            original: originalHb.activeHours?.start ?? '08:00',
                            valid: validateHHMM(next),
                        });
                    }}
                />
                <TextField
                    id="hb-end"
                    label="Active hours end"
                    value={hbEnd}
                    placeholder="22:00"
                    error={endError}
                    onChange={(next) => {
                        setHbEnd(next);
                        setEntry('heartbeat.activeHours.end', {
                            value: next,
                            original: originalHb.activeHours?.end ?? '22:00',
                            valid: validateHHMM(next),
                        });
                    }}
                />
                <SelectField
                    id="hb-target"
                    label="Target"
                    value={hbTarget}
                    missingValueLabel={isRetiredCliSelection(hbTarget) ? retiredRuntimeLabel(hbTarget) : undefined}
                    error={isRetiredCliSelection(hbTarget) ? 'The saved target runtime is retired. Choose an available target.' : null}
                    options={targetOptions}
                    onChange={(next) => {
                        setHbTarget(next);
                        setEntry('heartbeat.target', {
                            value: next,
                            original: originalHb.target ?? 'all',
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Jobs"
                hint="Each job replaces the entire heartbeat.json on save. Concurrent edits from multiple browsers will overwrite — last write wins."
            >
                <HeartbeatJobsSection
                    port={port}
                    client={client}
                    dirty={dirty}
                    snapshot={jobsSnap.state}
                />
            </SettingsSection>

            <SettingsSection
                title="Default heartbeat prompt template"
                hint="Markdown shown to the agent when a heartbeat fires without a job-specific prompt."
            >
                <HeartbeatMarkdownSection
                    port={port}
                    client={client}
                    dirty={dirty}
                    snapshot={mdSnap.state}
                />
            </SettingsSection>
        </form>
    );
}
