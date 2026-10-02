import { SelectField, TextField } from '../../fields';
import { asideEffortChoices, asideModelChoices, asideSelectionError, isAsideAccount, type AsideInventory } from './aside-models';

type Props = {
    id: string; account: string; host?: string | undefined; model: string; effort: string;
    inventory: AsideInventory; disabled?: boolean;
    onAccountChange(value: string): void; onModelChange(value: string): void; onEffortChange(value: string): void;
    refresh(): void;
};

export function AsideSelectionFields({ id, account, host, model, effort, inventory, disabled = false,
    onAccountChange, onModelChange, onEffortChange, refresh }: Props) {
    const models = asideModelChoices(inventory);
    const efforts = asideEffortChoices(inventory, model);
    const error = asideSelectionError(inventory, model, effort);
    return <>
        <p className="settings-percli-note">Experimental · local main agent only. Account selection does not confirm sign-in or model access.</p>
        <TextField id={`${id}-account`} label="Aside account" value={account} placeholder="uN" disabled={disabled}
            error={isAsideAccount(account) ? null : 'Enter an explicit account (uN).'} onChange={onAccountChange} />
        <TextField id={`${id}-host`} label="Host" value={host || 'local'} disabled
            error={host && host !== 'local' ? 'Only the local host is supported. Edit the account to use local.' : null} onChange={() => {}} />
        <SelectField id={`${id}-model`} label="Model" value={model || 'default'} options={models}
            missingValueLabel={`${model || 'default'} (unavailable)`} disabled={disabled || inventory.kind !== 'ready' || models.length === 0}
            error={error} onChange={onModelChange} />
        <SelectField id={`${id}-effort`} label="Effort" value={effort === 'default' ? '' : effort}
            options={[{ value: '', label: '(default)' }, ...efforts.map(value => ({ value, label: value }))]}
            missingValueLabel={`${effort} (unavailable)`} disabled={disabled || inventory.kind !== 'ready' || (efforts.length === 0 && !effort)}
            error={error?.includes('effort') ? error : null} onChange={onEffortChange} />
        {inventory.kind === 'ready' && inventory.catalog.status !== 'available'
            ? <p className="settings-percli-note" role="status">Catalog {inventory.catalog.status}{inventory.catalog.diagnostics.map(d => ` · ${d.code}`).join('')}</p> : null}
        <button type="button" className="settings-action" disabled={disabled || !isAsideAccount(account)} onClick={refresh}>Refresh Aside models</button>
    </>;
}
