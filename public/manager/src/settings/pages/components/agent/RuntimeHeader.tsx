import { SelectField, TextField } from '../../../fields';
import { SettingsSection } from '../../page-shell';
import { metaFor, orderRuntimeCliOptions, PRIMARY_CLIS, isRetiredCliSelection, retiredRuntimeLabel, type CliMeta } from './agent-meta';

type RuntimeHeaderProps = {
    cli: string;
    cliOptions: ReadonlyArray<string>;
    provider?: string;
    providerOptions?: ReadonlyArray<string>;
    model: string;
    modelOptions: ReadonlyArray<{ value: string; label: string }>;
    effort: string;
    effortOptions: ReadonlyArray<string>;
    workingDir: string;
    workingDirError: string | null;
    cliMeta?: Record<string, CliMeta> | null;
    onCliChange(next: string): void;
    onProviderChange?(next: string): void;
    onModelChange(next: string): void;
    onEffortChange(next: string): void;
    onWorkingDirChange(next: string): void;
};

export function RuntimeHeader({
    cli,
    cliOptions,
    provider = '',
    providerOptions = [],
    model,
    modelOptions,
    effort,
    effortOptions,
    workingDir,
    workingDirError,
    cliMeta,
    onCliChange,
    onProviderChange,
    onModelChange,
    onEffortChange,
    onWorkingDirChange,
}: RuntimeHeaderProps) {
    const orderedCliOptions = orderRuntimeCliOptions(cliOptions);
    const retired = isRetiredCliSelection(cli);
    const orderedPrimaryCliCount = orderedCliOptions.filter((value) => PRIMARY_CLIS.includes(value)).length;

    return (
        <SettingsSection
            title="Agent runtime"
            hint="Active CLI, model, effort, and workspace used by this instance."
        >
            <SelectField
                    id="agent-cli"
                    label="Active CLI"
                    value={cli}
                    missingValueLabel={isRetiredCliSelection(cli) ? retiredRuntimeLabel(cli) : undefined}
                    error={retired ? 'This runtime is retired. Select an available runtime to continue.' : null}
                    options={orderedCliOptions.map((value) => ({ value, label: metaFor(value, cliMeta).label || value }))}
                    collapsedAfter={orderedPrimaryCliCount}
                    onChange={onCliChange}
                />
                {providerOptions.length > 0 ? (
                    <SelectField
                        id={`agent-${cli}-provider`}
                        label="Provider"
                        value={provider}
                        options={providerOptions.map((value) => ({ value, label: value }))}
                        onChange={(next) => onProviderChange?.(next)}
                    />
                ) : null}
                <SelectField
                    id="agent-model"
                    label="Active model"
                    value={model}
                    disabled={retired}
                    options={modelOptions.length > 0 ? modelOptions : [{ value: '', label: '(default)' }]}
                    onChange={onModelChange}
                />
                <SelectField
                    id="agent-effort"
                    label="Effort"
                    value={effort}
                    options={[
                        { value: '', label: '(default)' },
                        ...effortOptions.map((value) => ({ value, label: value })),
                    ]}
                    disabled={retired || effortOptions.length === 0}
                    onChange={onEffortChange}
                />
                <TextField
                    id="agent-workingDir"
                    label="Working directory"
                    value={workingDir}
                    error={workingDirError}
                    placeholder="/path/to/project"
                    onChange={onWorkingDirChange}
                />
        </SettingsSection>
    );
}
