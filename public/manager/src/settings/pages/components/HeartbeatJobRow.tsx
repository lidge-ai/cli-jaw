// Phase 5 — single editable row in the Heartbeat jobs list.
//
// Pure presentational component: owns no state, propagates changes
// through `onChange` so the parent list keeps the canonical jobs[]
// array. Conditionally renders the schedule-body field based on
// `schedule.kind` to avoid stale `cron` strings hanging around when
// the user toggles to `every`, and vice versa.
//
// Layout follows the shared row language used by MCP servers and memory
// entries: a `settings-card-actions` header (name + enabled/kind badges +
// Remove) then the standard `.settings-field` rows. The component returns a
// fragment so the header lands as a direct child of
// `.settings-section-body` and picks up the standard item divider.

import { useId } from 'react';
import { TextField, ToggleField, SelectField } from '../../fields';
import { StatusBadge } from '../page-shell';

export type HbScheduleEvery = {
    kind: 'every';
    minutes: number;
    timeZone?: string;
};

export type HbScheduleCron = {
    kind: 'cron';
    cron: string;
    timeZone?: string;
};

export type HbSchedule = HbScheduleEvery | HbScheduleCron;

export type HbJob = {
    id: string;
    name: string;
    enabled: boolean;
    schedule: HbSchedule;
    prompt: string;
};

const KIND_OPTIONS = [
    { value: 'every', label: 'every (interval)' },
    { value: 'cron', label: 'cron expression' },
];

type Props = {
    job: HbJob;
    index: number;
    bodyError?: string | null;
    timeZoneError?: string | null;
    onChange: (patch: Partial<HbJob>) => void;
    onRemove: () => void;
};

export function HeartbeatJobRow({
    job,
    index,
    bodyError,
    timeZoneError,
    onChange,
    onRemove,
}: Props) {
    const idBase = useId();
    const kind = job.schedule.kind;
    const tz = job.schedule.timeZone ?? '';
    const title = job.name || `Job ${index + 1}`;

    return (
        <div
            className="settings-card-group"
            role="group"
            aria-label={`Heartbeat job ${index + 1}${job.name ? ` (${job.name})` : ''}`}
        >
            <div className="settings-card-actions">
                <div className="settings-card-actions-status">
                    <strong>{title}</strong>{' '}
                    {job.enabled ? (
                        <StatusBadge tone="ok">Enabled</StatusBadge>
                    ) : (
                        <StatusBadge tone="neutral">Disabled</StatusBadge>
                    )}{' '}
                    <StatusBadge tone="neutral">
                        {kind === 'every' ? 'interval' : 'cron'}
                    </StatusBadge>
                </div>
                <div className="settings-card-actions-buttons">
                    <button
                        type="button"
                        className="settings-action settings-action-danger"
                        onClick={onRemove}
                        aria-label={`Remove heartbeat job ${title}`}
                    >
                        Remove job
                    </button>
                </div>
            </div>

            <ToggleField
                id={`${idBase}-enabled`}
                label="Enabled"
                value={job.enabled}
                onChange={(next) => onChange({ enabled: next })}
            />

            <TextField
                id={`${idBase}-name`}
                label="Name"
                value={job.name}
                placeholder="Morning summary"
                onChange={(next) => onChange({ name: next })}
            />

            <SelectField
                id={`${idBase}-kind`}
                label="Schedule kind"
                value={kind}
                options={KIND_OPTIONS}
                onChange={(next) => {
                    if (next === 'every' && kind !== 'every') {
                        onChange({
                            schedule: {
                                kind: 'every',
                                minutes: 30,
                                ...(tz ? { timeZone: tz } : {}),
                            },
                        });
                    } else if (next === 'cron' && kind !== 'cron') {
                        onChange({
                            schedule: {
                                kind: 'cron',
                                cron: '0 9 * * *',
                                ...(tz ? { timeZone: tz } : {}),
                            },
                        });
                    }
                }}
            />

            {kind === 'every' ? (
                <TextField
                    id={`${idBase}-minutes`}
                    label="Every (minutes)"
                    value={String((job.schedule as HbScheduleEvery).minutes ?? '')}
                    placeholder="30"
                    error={bodyError ?? null}
                    onChange={(next) => {
                        const trimmed = next.trim();
                        const minutes = Number(trimmed);
                        onChange({
                            schedule: {
                                kind: 'every',
                                minutes: Number.isFinite(minutes) ? minutes : NaN,
                                ...(tz ? { timeZone: tz } : {}),
                            },
                        });
                    }}
                />
            ) : (
                <TextField
                    id={`${idBase}-cron`}
                    label="Cron expression"
                    value={(job.schedule as HbScheduleCron).cron ?? ''}
                    placeholder="0 9 * * *"
                    error={bodyError ?? null}
                    onChange={(next) =>
                        onChange({
                            schedule: {
                                kind: 'cron',
                                cron: next,
                                ...(tz ? { timeZone: tz } : {}),
                            },
                        })
                    }
                />
            )}

            <TextField
                id={`${idBase}-tz`}
                label="Time zone (optional)"
                value={tz}
                placeholder="Asia/Seoul"
                error={timeZoneError ?? null}
                onChange={(next) => {
                    const trimmed = next.trim();
                    if (kind === 'every') {
                        const everySchedule: HbScheduleEvery = {
                            kind: 'every',
                            minutes: (job.schedule as HbScheduleEvery).minutes,
                            ...(trimmed ? { timeZone: trimmed } : {}),
                        };
                        onChange({ schedule: everySchedule });
                    } else {
                        const cronSchedule: HbScheduleCron = {
                            kind: 'cron',
                            cron: (job.schedule as HbScheduleCron).cron,
                            ...(trimmed ? { timeZone: trimmed } : {}),
                        };
                        onChange({ schedule: cronSchedule });
                    }
                }}
            />

            <label
                className="settings-field settings-field-textarea"
                htmlFor={`${idBase}-prompt`}
            >
                <span className="settings-field-label">Prompt</span>
                <textarea
                    id={`${idBase}-prompt`}
                    rows={3}
                    value={job.prompt}
                    placeholder="What should this heartbeat do?"
                    onChange={(event) => onChange({ prompt: event.target.value })}
                />
            </label>
        </div>
    );
}
