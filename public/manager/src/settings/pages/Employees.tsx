// Compatibility route for the legacy settings.employees editor.
//
// Runtime employee management moved to the Agent page. The helper exports stay
// here so existing tests and imports keep their stable surface.

import type { SettingsPageProps } from '../types';
import { useEffect } from 'react';
import { SettingsSection, SettingsNote } from './page-shell';

export {
    EMPLOYEE_KEYS,
    duplicateNameSet,
    employeeRowError,
    employeesHaveErrors,
    makeDefaultEmployee,
    newEmployeeId,
    normalizeEmployees,
    toPersistShape,
    DEFAULT_CLI_OPTIONS,
} from './components/employees-helpers';
export type { EmployeeRecord } from './components/employees-helpers';

export default function Employees({ registerSave }: SettingsPageProps) {
    useEffect(() => {
        if (!registerSave) return;
        registerSave(null);
        return () => registerSave(null);
    }, [registerSave]);
    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="Employees"
                hint="Runtime employees are now managed from the Agent page."
            >
                <SettingsNote>
                    Open Runtime / Agent to edit dispatchable employees, static employee model
                    overrides, and database-backed employees in one place.
                </SettingsNote>
            </SettingsSection>
        </form>
    );
}
