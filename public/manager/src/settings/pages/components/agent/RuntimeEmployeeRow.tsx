import { SelectField, TextField } from '../../../fields';
import { SettingsActions, StatusBadge } from '../../page-shell';
import { metaFor, optionList, selectableRuntimeOptions, isRetiredCliSelection, retiredRuntimeLabel, type CliMeta } from './agent-meta';
import {
    isStaticEmployee,
    runtimeEmployeeError,
    type RuntimeEmployeeRecord,
} from './runtime-employees-helpers';

type RuntimeEmployeeRowProps = {
    employee: RuntimeEmployeeRecord;
    index: number;
    cliOptions: ReadonlyArray<string>;
    cliMeta?: Record<string, CliMeta> | null;
    onChange(patch: Partial<RuntimeEmployeeRecord>): void;
    onRemove(): void;
};

export function RuntimeEmployeeRow({
    employee,
    index,
    cliOptions,
    cliMeta,
    onChange,
    onRemove,
}: RuntimeEmployeeRowProps) {
    const locked = isStaticEmployee(employee);
    const meta = metaFor(employee.cli, cliMeta);
    const modelOptions = optionList(meta.models, employee.model);
    const error = runtimeEmployeeError(employee);
    const retired = isRetiredCliSelection(employee.cli);
    const cliChoices = selectableRuntimeOptions(Array.from(new Set([...cliOptions, employee.cli, 'claude'])).filter(Boolean));

    const employeeName = employee.name || `Employee ${index + 1}`;
    return (
        <div className="settings-runtime-employee-row" role="group" aria-label={employeeName}>
            <p className="settings-runtime-employee-head">
                <span className="settings-runtime-employee-name">{employeeName}</span>
                {locked ? <StatusBadge tone="neutral">static</StatusBadge> : null}
            </p>
            <div className="settings-runtime-employee-grid">
                <TextField
                    id={`runtime-employee-${employee.id}-name`}
                    label="Name"
                    value={employee.name}
                    disabled={locked}
                    error={error === 'Name is required' ? error : null}
                    onChange={(next) => onChange({ name: next })}
                />
                <SelectField
                    id={`runtime-employee-${employee.id}-cli`}
                    label="CLI"
                    value={employee.cli}
                    missingValueLabel={isRetiredCliSelection(employee.cli) ? retiredRuntimeLabel(employee.cli) : undefined}
                    error={retired ? 'This saved runtime cannot execute. Choose an available runtime.' : null}
                    disabled={locked}
                    options={cliChoices.map((value) => ({ value, label: metaFor(value, cliMeta).label || value }))}
                    onChange={(next) => {
                        const nextModel = metaFor(next, cliMeta).models[0] || 'default';
                        onChange({ cli: next, model: nextModel });
                    }}
                />
                <SelectField
                    id={`runtime-employee-${employee.id}-model`}
                    label="Model"
                    value={employee.model}
                    disabled={retired}
                    options={modelOptions.length > 0 ? modelOptions : [{ value: 'default', label: 'default' }]}
                    onChange={(next) => onChange({ model: next })}
                />
                <TextField
                    id={`runtime-employee-${employee.id}-role`}
                    label="Role"
                    value={employee.role}
                    disabled={locked}
                    onChange={(next) => onChange({ role: next })}
                />
            </div>
            <SettingsActions
                status={<span>{employee.source}{employee.status ? ` / ${employee.status}` : ''}</span>}
            >
                <button
                    type="button"
                    className="settings-action settings-action-danger"
                    disabled={locked}
                    onClick={onRemove}
                    aria-label={`Remove employee ${employeeName}`}
                >
                    Remove
                </button>
            </SettingsActions>
        </div>
    );
}
