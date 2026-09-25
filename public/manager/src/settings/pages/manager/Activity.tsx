import type { SettingsPageProps } from '../../types';
import { SettingsSection } from '../page-shell';
import { COPY, normalizeDashboardLocale, TitleSupportSummary } from './shared';
export default function Activity({manager}: SettingsPageProps) {
    if (!manager) return null;
    const locale = normalizeDashboardLocale(manager.ui.locale), copy = COPY[locale];
    return (
        <SettingsSection title={copy.activityTitle} hint={copy.activityDescription}>
            <TitleSupportSummary support={manager.titleSupport} locale={locale}/>
        </SettingsSection>
    );
}
