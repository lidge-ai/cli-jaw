import { SelectField } from '../../../fields';
import { SettingsSection } from '../../page-shell';
import { metaFor, auxiliaryRuntimeOptions, isRetiredCliSelection, retiredRuntimeLabel, type CliMeta } from './agent-meta';

type FlushAgentSectionProps = {
    activeCli: string;
    flushCli: string;
    flushModel: string;
    cliOptions: ReadonlyArray<string>;
    modelOptions: ReadonlyArray<{ value: string; label: string }>;
    cliMeta?: Record<string, CliMeta> | null;
    loading?: boolean;
    error?: string | null;
    onFlushCliChange(next: string): void;
    onFlushModelChange(next: string): void;
};

export function FlushAgentSection({
    activeCli,
    flushCli,
    flushModel,
    cliOptions,
    modelOptions,
    cliMeta,
    loading,
    error,
    onFlushCliChange,
    onFlushModelChange,
}: FlushAgentSectionProps) {
    const effectiveCli = flushCli || activeCli;
    const unsupported = effectiveCli === 'aside';
    const effectiveCliLabel = effectiveCli ? metaFor(effectiveCli, cliMeta).label || effectiveCli : 'active';
    return (
        <SettingsSection
            title="Flush Agent"
            hint="Separate summary agent used for context flush and compact work."
        >
            <details className="settings-agent-flush">
                <summary>
                    <span>Flush runtime</span>
                    <code>{effectiveCliLabel}{flushModel && flushModel !== 'default' ? ` / ${flushModel}` : ''}</code>
                </summary>
                {loading ? <p className="settings-agent-note">Loading flush settings...</p> : null}
                {error ? <p className="settings-field-error" role="alert">{error}</p> : null}
                <div className="settings-agent-runtime-grid">
                    <SelectField
                        id="agent-flush-cli"
                        label="Flush CLI"
                        value={flushCli}
                        missingValueLabel={!flushCli && activeCli === 'aside' ? '(active CLI unavailable)' : flushCli === 'aside' ? 'Aside (main-only)' : isRetiredCliSelection(flushCli) ? retiredRuntimeLabel(flushCli) : undefined}
                        error={unsupported ? 'Aside cannot run memory flush. Choose a separate runtime.' : isRetiredCliSelection(effectiveCli) ? 'The saved flush runtime is retired. Choose an available runtime.' : null}
                        options={[
                            ...(activeCli === 'aside' ? [] : [{ value: '', label: '(active CLI)' }]),
                            ...auxiliaryRuntimeOptions(cliOptions).map((value) => ({ value, label: metaFor(value, cliMeta).label || value })),
                        ]}
                        onChange={onFlushCliChange}
                    />
                    <SelectField
                        id="agent-flush-model"
                        label="Flush model"
                        value={flushModel}
                        disabled={unsupported || isRetiredCliSelection(effectiveCli)}
                        options={[{ value: '', label: '(default)' }, ...modelOptions]}
                        onChange={onFlushModelChange}
                    />
                </div>
            </details>
        </SettingsSection>
    );
}
