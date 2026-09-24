import { SelectField } from '../../../fields';
import { SettingsSection } from '../../page-shell';
import {
    configuredPolicyLabel,
    isAllowlistValid,
    parsePermissionsValue,
    permissionsEditMode,
    seedAutoAllowlist,
} from '../../Permissions';

type PermissionQuickSectionProps = {
    value: unknown;
    configuredValue: unknown;
    onChange(next: 'auto' | 'safe' | string[]): void;
};

const MODE_OPTIONS = [
    { value: 'auto', label: 'Auto (YOLO)' },
    { value: 'safe', label: 'Safe' },
    { value: 'custom', label: 'Custom allowlist' },
];

export function PermissionQuickSection({ value, configuredValue, onChange }: PermissionQuickSectionProps) {
    const parsed = parsePermissionsValue(value);
    // Never fall through to 'auto': a Safe instance shown as Auto (YOLO) means the user cannot
    // see the permission they are about to lose when they touch this control. An unrecognized
    // stored value lands in 'invalid' — no option is pre-selected, and picking one repairs it.
    const mode = permissionsEditMode(value);
    const tokens = parsed.mode === 'custom' ? parsed.tokens : [];
    const summary = parsed.mode === 'custom'
        ? `Editor draft: ${tokens.length} explicit token${tokens.length === 1 ? '' : 's'}`
        : null;

    return (
        <SettingsSection
            title="Permissions"
            hint="Selecting a value changes the draft. Save applies it. Auto (YOLO) requests automatic approval or permission bypass. Behavior varies by runtime."
        >
            <SelectField
                id="agent-permissions-mode"
                label="Change policy to"
                value={mode}
                options={MODE_OPTIONS}
                missingValueLabel={mode === 'invalid' ? 'Unrecognized saved policy' : undefined}
                onChange={(next) => {
                    if (next === 'auto') onChange('auto');
                    else if (next === 'safe') onChange('safe');
                    else onChange(tokens.length > 0 && isAllowlistValid(tokens) ? tokens : seedAutoAllowlist(null));
                }}
            />
            {mode === 'invalid' ? (
                <p className="settings-agent-note" role="alert">
                    The saved permissions value is not a recognized policy. Choose a policy to replace it.
                </p>
            ) : null}
            {summary ? <p className="settings-agent-note">{summary}</p> : null}
            <p className="settings-agent-note" id="agent-configured-policy">Configured policy: {configuredPolicyLabel(configuredValue)}</p>
        </SettingsSection>
    );
}
