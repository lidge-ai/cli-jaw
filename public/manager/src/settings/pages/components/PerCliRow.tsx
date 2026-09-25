// Phase 2 — single CLI row (model + effort + fastMode).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { TextField, SelectField, ToggleField } from '../../fields';
import { SettingsToolbar } from '../page-shell';
import type { SettingsClient } from '../../types';
import type { DirtyEntry, DirtyStore } from '../../types';
import { coerceEffortForModel, effortChoicesForModel } from './agent/agent-meta';
import type { CliMeta, PerCliEntry } from './agent/agent-meta';
import { PiProfileDialog } from './PiProfileDialog';
import { piModelOptions, piProfileOptions, type PiSettingsView } from './pi-profile';
import { hasRuntimeTransportChoice, RuntimeTransportField } from './runtime-transport-field';
export type PiRegistration = Parameters<ComponentProps<typeof PiProfileDialog>['onRegistered']>[0];

type Props = {
    cli: string;
    meta: CliMeta;
    original: PerCliEntry;
    value: PerCliEntry;
    setValue: (next: PerCliEntry) => void;
    setEntry: (key: string, entry: DirtyEntry) => void;
    dirty: DirtyStore;
    disabled?: boolean;
    client?: SettingsClient;
    pi?: PiSettingsView | undefined;
    setPi?: (next: PiSettingsView) => void;
    onPiRegistered?: (next: PiRegistration) => void;
};

function entryFor(value: unknown, original: unknown, valid = true): DirtyEntry {
    return { value, original, valid };
}

export function PerCliRow({ cli, meta, original, value, setValue, setEntry, dirty, disabled = false, client, pi, setPi, onPiRegistered }: Props) {
    const modelDatalistId = `percli-${cli}-models`;
    const isPi = cli === 'pi';
    const [piDialogOpen, setPiDialogOpen] = useState(false);
    // An already-open SelectField or asynchronous Pi callback can outlive its
    // enabled render. Read committed disabled state before any setter call.
    const blocked = useRef(disabled);
    useLayoutEffect(() => {
        blocked.current = disabled;
        return () => { blocked.current = true; };
    }, [disabled]);
    const provider = value.provider || meta.defaultProvider || meta.providers?.[0] || 'claude';
    const piModels = isPi ? piModelOptions(pi, provider, value.model || '') : [];
    const hasProviders = !isPi && (meta.providers?.length ?? 0) > 0;
    const modelOptions = isPi
        ? piModels
        : hasProviders
        ? (meta.modelsByProvider?.[provider] ?? meta.models)
        : meta.models;
    const providerEfforts = hasProviders ? (meta.effortsByProvider?.[provider] ?? meta.efforts) : undefined;
    // Per-model effort sets from a live opencodex catalog win over the
    // provider/registry lists; the chosen value is forwarded to the wire.
    const effortOptions = effortChoicesForModel(meta, value.model || '', providerEfforts, hasProviders ? provider : undefined);

    return (
        <div className="settings-percli-row" data-cli={cli}>
            <SettingsToolbar>
                <strong className="settings-percli-title">{meta.label}</strong>
            </SettingsToolbar>
            <div className={`settings-percli-grid${isPi ? ' settings-percli-grid--pi' : ''}`}>
            {isPi && piProfileOptions(pi, provider).length ? (
                <SelectField
                    id={`percli-${cli}-provider`}
                    label="Provider"
                    disabled={disabled}
                    value={provider}
                    options={piProfileOptions(pi, provider).map((p) => ({ value: p, label: p }))}
                    onChange={(next) => {
                        if (blocked.current) return;
                        const nextModels = piModelOptions(pi, next);
                        const nextModel = nextModels.includes(value.model || '') ? (value.model || '') : (nextModels[0] || '');
                        setValue({ ...value, provider: next, model: nextModel });
                        setEntry(`perCli.${cli}.provider`, entryFor(next, original.provider ?? 'progrok'));
                        setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                    }}
                />
            ) : hasProviders ? (
                <SelectField
                    id={`percli-${cli}-provider`}
                    label="Provider"
                    disabled={disabled}
                    value={provider}
                    options={(meta.providers ?? []).map((p) => ({ value: p, label: p }))}
                    onChange={(next) => {
                        if (blocked.current) return;
                        const nextModels = meta.modelsByProvider?.[next] ?? [];
                        const nextEfforts = meta.effortsByProvider?.[next] ?? [];
                        const nextModel = nextModels.includes(value.model || '') ? (value.model || '') : (nextModels[0] || '');
                        // Resolve against the NEW provider+model pair: the same
                        // model id can allow different efforts per provider.
                        const nextEffort = coerceEffortForModel(meta, nextModel, value.effort ?? '', nextEfforts, next);
                        setValue({ ...value, provider: next, model: nextModel, effort: nextEffort });
                        setEntry(`perCli.${cli}.provider`, entryFor(next, original.provider ?? meta.defaultProvider ?? 'claude'));
                        setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                        setEntry(`perCli.${cli}.effort`, entryFor(nextEffort, original.effort ?? ''));
                    }}
                />
            ) : null}
            {isPi && modelOptions.length > 0 ? (
                <SelectField
                    id={`percli-${cli}-model`}
                    label="Model"
                    disabled={disabled}
                    value={value.model ?? modelOptions[0] ?? ''}
                    options={modelOptions.map((m) => ({ value: m, label: m }))}
                    onChange={(next) => {
                        if (blocked.current) return;
                        const nextEffort = coerceEffortForModel(meta, next, value.effort ?? '', providerEfforts, hasProviders ? provider : undefined);
                        setValue({ ...value, model: next, effort: nextEffort });
                        setEntry(`perCli.${cli}.model`, entryFor(next, original.model ?? ''));
                        if (nextEffort !== (value.effort ?? '')) {
                            setEntry(`perCli.${cli}.effort`, entryFor(nextEffort, original.effort ?? ''));
                        }
                    }}
                />
            ) : (
                <TextField
                    id={`percli-${cli}-model`}
                    label="Model"
                    disabled={disabled}
                    value={value.model ?? ''}
                    onChange={(next) => {
                        if (blocked.current) return;
                        setValue({ ...value, model: next });
                        setEntry(`perCli.${cli}.model`, entryFor(next, original.model ?? ''));
                    }}
                    placeholder={modelOptions[0] ?? 'model id'}
                />
            )}
            {meta.modelNote ? (
                <p className="settings-percli-note">{meta.modelNote}</p>
            ) : null}
            {modelOptions.length > 0 ? (
                <datalist id={modelDatalistId}>
                    {modelOptions.map((m) => (
                        <option key={m} value={m} />
                    ))}
                </datalist>
            ) : null}
            {effortOptions.length > 0 ? (
                <div className="settings-percli-effort">
                    <SelectField
                        id={`percli-${cli}-effort`}
                        label="Effort"
                        disabled={disabled}
                        value={value.effort ?? ''}
                        options={[
                            { value: '', label: '(default)' },
                            ...effortOptions.map((e) => ({ value: e, label: e })),
                        ]}
                        onChange={(next) => {
                            if (blocked.current) return;
                            setValue({ ...value, effort: next });
                            setEntry(`perCli.${cli}.effort`, entryFor(next, original.effort ?? ''));
                        }}
                    />
                    {meta.effortNote ? (
                        <p className="settings-percli-note">{meta.effortNote}</p>
                    ) : null}
                </div>
            ) : meta.effortNote ? (
                <p className="settings-percli-note settings-percli-note--effort">{meta.effortNote}</p>
            ) : null}
            {hasRuntimeTransportChoice(cli) ? (
                <RuntimeTransportField cli={cli} original={original.transport} dirty={dirty} disabled={disabled} setEntry={setEntry} />
            ) : null}
            <ToggleField
                id={`percli-${cli}-fastmode`}
                label="Fast mode"
                disabled={disabled}
                value={Boolean(value.fastMode)}
                onChange={(next) => {
                    if (blocked.current) return;
                    setValue({ ...value, fastMode: next });
                    setEntry(`perCli.${cli}.fastMode`, entryFor(next, Boolean(original.fastMode)));
                }}
            />
            {isPi && client ? (
                <button
                    type="button"
                    className="settings-action settings-percli-settings"
                    disabled={disabled}
                    onClick={() => { if (!blocked.current) setPiDialogOpen(true); }}
                >
                    Settings
                </button>
            ) : null}
            </div>
            {isPi && client && piDialogOpen ? (
                <div inert={disabled} aria-busy={disabled}>
                <PiProfileDialog
                    client={client}
                    pi={pi}
                    provider={provider}
                    model={value.model || 'grok-composer-2.5-fast'}
                    onClose={() => setPiDialogOpen(false)}
                    onRegistered={(next) => {
                        // An admitted registration may finish while row input is
                        // disabled. Its instance owner reconciles that completion.
                        if (onPiRegistered) { onPiRegistered(next); return; }
                        if (blocked.current) return;
                        const { provider: nextProvider, model: nextModel, pi: nextPi } = next;
                        if (nextPi && setPi) setPi(nextPi);
                        setValue({ ...value, provider: nextProvider, model: nextModel });
                        setEntry(`perCli.${cli}.provider`, entryFor(nextProvider, original.provider ?? 'progrok'));
                        setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                    }}
                />
                </div>
            ) : null}
        </div>
    );
}
