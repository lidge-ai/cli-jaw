import { useEffect, useMemo, useRef } from 'react';
import type { DirtyStore, SettingsClient } from '../../types';
import { ChannelSetupDialog, slackText } from './SlackSetup';

type Props = {
    channel: 'telegram' | 'discord';
    client: SettingsClient;
    dirty: DirtyStore;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => Promise<void>;
    disabled?: boolean;
};

/** The page retains its save owner; setup starts only after any page draft is saved. */
export function ChannelSetupEntry({ channel, client, dirty, open, onOpenChange, onSaved, disabled = false }: Props) {
    const trigger = useRef<HTMLButtonElement>(null);
    const active = useRef(false);
    const key = `${channel}.setup`;
    const t = useMemo(() => slackText(document.documentElement.lang), []);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; dirty.remove(key); };
    }, [client, dirty, key]);
    const pendingDraft = !open && dirty.isDirty();
    return <>
        <button ref={trigger} type="button" data-onboard-channel={channel}
            disabled={disabled || open || pendingDraft} onClick={() => {
                if (disabled || dirty.isDirty()) return;
                dirty.set(key, { value: true, original: false, valid: false });
                onOpenChange(true);
            }}>{t('onboarding.open')}</button>
        {pendingDraft && <p className="settings-field-hint">Save or discard your changes before opening setup.</p>}
        {open && <ChannelSetupDialog key={channel} channel={channel} client={client} t={t}
            initialDraft={{}} returnFocus={trigger.current}
            onBeforeSave={() => async () => {
                if (!active.current) return;
                await onSaved();
                if (!active.current) return;
                dirty.remove(key);
            }}
            onClose={() => {
                dirty.remove(key);
                onOpenChange(false);
            }} />}
    </>;
}
