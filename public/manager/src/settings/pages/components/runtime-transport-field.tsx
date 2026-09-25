import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { RuntimeTransport } from '../../../../../../src/shared/runtime-contract';
import { SelectField } from '../../fields';
import type { DirtyEntry, DirtyStore } from '../../types';

type Props = {
    cli: string;
    original: unknown;
    dirty: DirtyStore;
    disabled?: boolean;
    setEntry: (key: string, entry: DirtyEntry) => void;
};

export function hasRuntimeTransportChoice(cli: string): boolean {
    return cli === 'cursor' || cli === 'grok' || cli === 'claude';
}

function isTransport(value: unknown): value is RuntimeTransport {
    return value === 'native' || value === 'print';
}

const UNKNOWN = 'unrecognized'; // UI only; never a wire value.
const OPTIONS: ReadonlyArray<{ value: RuntimeTransport; label: string }> = [
    { value: 'native', label: 'Native session (opt-in)' },
    { value: 'print', label: 'Print compatibility' },
];

export function RuntimeTransportField({ cli, original, dirty, disabled = false, setEntry }: Props) {
    const key = hasRuntimeTransportChoice(cli) ? `perCli.${cli}.transport` : null;
    const pending = useSyncExternalStore(dirty.subscribe,
        () => key === null ? undefined : dirty.pending.get(key));
    const blocked = useRef(disabled);
    useLayoutEffect(() => {
        blocked.current = disabled;
        return () => { blocked.current = true; };
    }, [disabled]);
    // Missing settings retain print compatibility without synthesizing a PATCH.
    const baseline = original === undefined ? 'print' : original;
    const value = pending ? pending.value : baseline;
    const known = isTransport(value);
    if (key === null) return null;

    return (
        <>
            <SelectField
                id={`percli-${cli}-transport`}
                label="Runtime transport"
                value={known ? value : UNKNOWN}
                options={known ? OPTIONS : [...OPTIONS, { value: UNKNOWN, label: 'Unrecognized transport' }]}
                disabled={disabled}
                error={known ? null : 'Choose a supported runtime transport.'}
                onChange={(next) => {
                    if (blocked.current || !isTransport(next)) return;
                    setEntry(key, { value: next, original: baseline, valid: true });
                }}
            />
            {!known ? <p className="settings-field-error" role="alert">Stored runtime transport is unrecognized.</p> : null}
            <p className="settings-percli-note">Applies to the next run. Independent of Activity / Legacy presentation.</p>
            {value === 'native' ? (
                <p className="settings-percli-note">
                    {cli === 'claude'
                        ? 'Claude native supports Auto (YOLO) / Safe permissions.'
                        : 'Native requires Auto (YOLO) permissions; no native worker assignments.'}
                </p>
            ) : null}
        </>
    );
}
