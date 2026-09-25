import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { SelectField, TextField } from '../../fields';
import { SettingsActions, SettingsNote } from '../page-shell';
import type { SettingsClient } from '../../types';
import type { PiProfileMode, PiSettingsView } from './pi-profile';

type Props = {
    client: SettingsClient;
    pi?: PiSettingsView | undefined;
    provider: string;
    model: string;
    onClose: () => void;
    onRegistered: (next: { provider: string; model: string; models: string[]; pi?: PiSettingsView | undefined }) => void;
};

const MODES: PiProfileMode[] = ['basic', 'openai', 'anthropic', 'vertex'];
const INACTIVE_ANCESTOR = '[hidden], [inert], [aria-disabled="true"], fieldset[disabled]';

function dialogControls(root: HTMLDivElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter((element) => {
            if (element.tabIndex < 0 || element.matches(':disabled') || element.closest(INACTIVE_ANCESTOR)) return false;
            for (let node: HTMLElement | null = element; node; node = node.parentElement) {
                const style = node.ownerDocument.defaultView?.getComputedStyle(node);
                if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
            }
            return true;
        });
}

function defaultEndpoint(mode: PiProfileMode): string {
    if (mode === 'anthropic') return 'https://api.anthropic.com/v1/messages';
    if (mode === 'vertex') return 'https://LOCATION-aiplatform.googleapis.com/v1';
    return 'http://127.0.0.1:18645/v1';
}

export function PiProfileDialog({ client, pi, provider, model, onClose, onRegistered }: Props) {
    const rootRef = useRef<HTMLDivElement>(null);
    const current = useMemo(
        () => pi?.profiles?.find((entry) => entry.id === provider) || pi?.profiles?.[0],
        [pi, provider],
    );
    const [mode, setMode] = useState<PiProfileMode>(current?.mode || 'basic');
    const [id, setId] = useState(current?.id || provider || 'progrok');
    const [endpoint, setEndpoint] = useState(current?.endpoint || defaultEndpoint(mode));
    const [modelId, setModelId] = useState(model || current?.model || 'grok-composer-2.5-fast');
    const [apiKey, setApiKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root || root.closest(INACTIVE_ANCESTOR)) return;
        const opener = root.ownerDocument.activeElement;
        const controls = dialogControls(root);
        (controls.find((element) => element.id === 'pi-profile-id') ?? controls[0])?.focus();
        return () => {
            if (opener instanceof HTMLElement && opener.isConnected
                && !opener.matches(':disabled') && !opener.closest(INACTIVE_ANCESTOR)) opener.focus({ preventScroll: true });
        };
    }, []);

    useEffect(() => {
        setEndpoint((value) => value || defaultEndpoint(mode));
    }, [mode]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const root = rootRef.current;
        if (!root || root.closest(INACTIVE_ANCESTOR) || event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        } else if (event.key === 'Tab') {
            const controls = dialogControls(root);
            const first = controls[0], last = controls.at(-1);
            const active = root.ownerDocument.activeElement;
            if (!first || !controls.some((element) => element === active)
                || (event.shiftKey ? active === first : active === last)) {
                event.preventDefault();
                (event.shiftKey ? last ?? root : first ?? root).focus();
            }
        }
    };

    const register = async () => {
        const root = rootRef.current;
        const submit = root?.querySelector<HTMLButtonElement>('.settings-action-save');
        if (root && submit && root.ownerDocument.activeElement === submit && !root.closest(INACTIVE_ANCESTOR)) {
            dialogControls(root).find((element) => element !== submit)?.focus();
        }
        setBusy(true);
        setError(null);
        try {
            const result = await client.post<{
                ok: true;
                data: { models: string[]; settings?: { pi?: PiSettingsView } };
            }>('/api/pi/profiles/register', {
                id,
                label: id,
                mode,
                endpoint,
                model: modelId,
                apiKey,
            });
            const data = result.data;
            onRegistered({ provider: id, model: modelId, models: data.models || [], pi: data.settings?.pi });
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="settings-memory-modal settings-pi-modal" ref={rootRef} role="dialog" aria-modal="true"
            aria-labelledby="pi-profile-title" tabIndex={-1} onKeyDown={onKeyDown}>
            <div className="settings-memory-modal-card">
                <header className="settings-memory-modal-header">
                    <h3 id="pi-profile-title">Pi Settings</h3>
                    <button type="button" className="settings-action settings-action-discard" onClick={onClose}>Close</button>
                </header>
                <div className="settings-section-body">
                    <SelectField
                        id="pi-profile-mode"
                        label="Mode"
                        value={mode}
                        options={MODES.map((value) => ({ value, label: value }))}
                        onChange={(next) => setMode(next as PiProfileMode)}
                    />
                    <TextField id="pi-profile-id" label="Provider" value={id} onChange={setId} placeholder="progrok" />
                    <TextField id="pi-profile-endpoint" label="Endpoint" value={endpoint} onChange={setEndpoint} placeholder={defaultEndpoint(mode)} />
                    <TextField id="pi-profile-model" label="Model" value={modelId} onChange={setModelId} placeholder="grok-composer-2.5-fast" />
                    <TextField id="pi-profile-key" label="API Key" value={apiKey} onChange={setApiKey} placeholder={current?.apiKeySet ? `set (${current.apiKeyLast4 || '****'})` : 'empty for local proxy'} />
                    <SettingsNote>Default: grok-composer-2.5-fast. Bare grok-composer-2.5 currently has no verified team access.</SettingsNote>
                    {error ? <SettingsNote tone="error" role="alert">{error}</SettingsNote> : null}
                    <SettingsActions>
                        <button type="button" className="settings-action settings-action-save" disabled={busy} onClick={() => void register()}>
                            {busy ? 'Registering...' : 'Register'}
                        </button>
                    </SettingsActions>
                </div>
            </div>
        </div>
    );
}
