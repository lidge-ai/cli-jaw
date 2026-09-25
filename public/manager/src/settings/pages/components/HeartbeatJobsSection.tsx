// Phase 5 — Heartbeat jobs section UI.
//
// Owns the local jobs[] draft + the per-section "Apply jobs" button.
// Synchronises its dirty state into the shared DirtyStore under the
// single key `heartbeat.jobs` so the shell knows the page is dirty,
// but the page-level save handler intentionally skips that key (the
// jobs PUT is a whole-array replace, not a deep-merge patch).

import { useCallback, useEffect, useState } from 'react';
import type { DirtyStore, SettingsClient } from '../../types';
import { PageError, PageOffline, SettingsActions, SettingsNote } from '../page-shell';
import { HeartbeatJobRow, type HbJob } from './HeartbeatJobRow';
import {
    jobScheduleBodyError,
    jobsHaveErrors,
    makeDefaultJob,
    normalizeJobsResponse,
} from './heartbeat-helpers';
import type { SnapshotState } from '../page-shell';

type Props = {
    port: number;
    client: SettingsClient;
    dirty: DirtyStore;
    snapshot: SnapshotState<{ jobs?: unknown }>;
};

export function HeartbeatJobsSection({ port, client, dirty, snapshot }: Props) {
    const [jobs, setJobs] = useState<HbJob[]>([]);
    const [originalJobs, setOriginalJobs] = useState<HbJob[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (snapshot.kind !== 'ready') return;
        const parsed = normalizeJobsResponse(snapshot.data);
        setJobs(parsed);
        setOriginalJobs(parsed);
    }, [snapshot]);

    // Sync local draft into the shared dirty store so the shell knows
    // the page is dirty even though we own the actual save button.
    useEffect(() => {
        dirty.set('heartbeat.jobs', {
            value: jobs,
            original: originalJobs,
            valid: !jobsHaveErrors(jobs),
        });
    }, [jobs, originalJobs, dirty]);

    useEffect(() => {
        return () => {
            dirty.remove('heartbeat.jobs');
        };
    }, [dirty]);

    const onSaveJobs = useCallback(async () => {
        if (jobsHaveErrors(jobs)) {
            setError('Fix invalid schedules before saving.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const result = await client.put<{ jobs?: unknown }>('/api/heartbeat', {
                jobs,
            });
            const fresh = normalizeJobsResponse(result);
            setJobs(fresh);
            setOriginalJobs(fresh);
            dirty.remove('heartbeat.jobs');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, [client, dirty, jobs]);

    if (snapshot.kind === 'loading') {
        return <SettingsNote>Loading jobs…</SettingsNote>;
    }
    if (snapshot.kind === 'offline') return <PageOffline port={port} />;
    if (snapshot.kind === 'error') return <PageError message={snapshot.message} />;

    const dirtyFlag = dirty.pending.has('heartbeat.jobs');
    const invalid = jobsHaveErrors(jobs);

    function updateJob(idx: number, patch: Partial<HbJob>) {
        setJobs((prev) => prev.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
    }
    function addJob() {
        setJobs((prev) => [...prev, makeDefaultJob()]);
    }
    function removeJob(idx: number) {
        setJobs((prev) => prev.filter((_, i) => i !== idx));
    }

    return (
        <>
            {jobs.length === 0 ? (
                <SettingsNote>
                    No jobs configured. Add one below.
                </SettingsNote>
            ) : (
                <>
                    {jobs.map((job, idx) => (
                        <HeartbeatJobRow
                            key={job.id}
                            job={job}
                            index={idx}
                            bodyError={jobScheduleBodyError(job.schedule)}
                            onChange={(patch) => updateJob(idx, patch)}
                            onRemove={() => removeJob(idx)}
                        />
                    ))}
                </>
            )}
            <SettingsActions>
                <button
                    type="button"
                    className="settings-action"
                    onClick={addJob}
                >
                    + Add job
                </button>
                <button
                    type="button"
                    className="settings-action settings-action-save"
                    onClick={() => void onSaveJobs()}
                    disabled={saving || !dirtyFlag || invalid}
                >
                    {saving ? 'Saving…' : 'Apply jobs'}
                </button>
            </SettingsActions>
            {error ? (
                <SettingsNote tone="error" role="alert">
                    {error}
                </SettingsNote>
            ) : null}
        </>
    );
}
