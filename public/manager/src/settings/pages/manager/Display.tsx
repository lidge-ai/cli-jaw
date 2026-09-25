import type { SettingsPageProps } from '../../types';
import type { DashboardShortcutAction } from '../../../types';
import { formatShortcut, MANAGER_SHORTCUT_ACTIONS } from '../../../manager-shortcuts';
import { SettingsSection } from '../page-shell';
import { COPY, LOCALE_OPTIONS, normalizeDashboardLocale, DashboardSettingToggle, DashboardSettingSelect, DashboardShortcutInput, shortcutCopyKey } from './shared';
export default function Display({manager}: SettingsPageProps) {
    if (!manager) return null;
    const props = manager;
    const locale = normalizeDashboardLocale(props.ui.locale);
    const copy = COPY[locale];
    function patchShortcut(action: DashboardShortcutAction, value: string): void {
        props.onUiPatch({
            dashboardShortcutKeymap: {
                ...props.ui.dashboardShortcutKeymap,
                [action]: value,
            },
        });
    }

    return (
                <SettingsSection title={copy.displayTitle} hint={copy.displayDescription}>
                        <DashboardSettingToggle
                            id="dashboard-show-activity-title"
                            label={copy.fields.activity.label}
                            scope={copy.fields.activity.scope}
                            value={props.ui.showLatestActivityTitles}
                            description={copy.fields.activity.description}
                            onChange={(next) => props.onUiPatch({ showLatestActivityTitles: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-label-editor"
                            label={copy.fields.rename.label}
                            scope={copy.fields.rename.scope}
                            value={props.ui.showInlineLabelEditor}
                            description={copy.fields.rename.description}
                            onChange={(next) => props.onUiPatch({ showInlineLabelEditor: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-runtime-line"
                            label={copy.fields.runtime.label}
                            scope={copy.fields.runtime.scope}
                            value={props.ui.showSidebarRuntimeLine}
                            description={copy.fields.runtime.description}
                            onChange={(next) => props.onUiPatch({ showSidebarRuntimeLine: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-row-actions"
                            label={copy.fields.actions.label}
                            scope={copy.fields.actions.scope}
                            value={props.ui.showSelectedRowActions}
                            description={copy.fields.actions.description}
                            onChange={(next) => props.onUiPatch({ showSelectedRowActions: next })}
                        />
                        <DashboardSettingSelect
                            id="dashboard-locale"
                            label={copy.fields.language.label}
                            scope={copy.fields.language.scope}
                            value={locale}
                            options={LOCALE_OPTIONS}
                            description={copy.fields.language.description}
                            onChange={(next) => props.onUiPatch({ locale: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-shortcuts-enabled"
                            label={copy.fields.shortcuts.label}
                            scope={copy.fields.shortcuts.scope}
                            value={props.ui.dashboardShortcutsEnabled}
                            description={copy.fields.shortcuts.description}
                            onChange={(next) => props.onUiPatch({ dashboardShortcutsEnabled: next })}
                        />
                        {MANAGER_SHORTCUT_ACTIONS.map(action => {
                            const field = copy.fields[shortcutCopyKey(action)];
                            return (
                                <DashboardShortcutInput
                                    key={action}
                                    action={action}
                                    label={field.label}
                                    scope={field.scope}
                                    value={props.ui.dashboardShortcutKeymap[action]}
                                    description={`${field.description} Current: ${formatShortcut(props.ui.dashboardShortcutKeymap[action])}`}
                                    onChange={patchShortcut}
                                />
                            );
                        })}
                </SettingsSection>
    );
}
