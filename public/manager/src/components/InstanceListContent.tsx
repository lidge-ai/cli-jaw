import type { ReactNode } from 'react';
import { EmptyNavigator } from './EmptyNavigator';
import { InstanceGroups } from './InstanceGroups';
import { InstanceSessionList } from './InstanceSessionList';
import { useActiveSessionDisclosure } from '../hooks/useActiveSessionDisclosure';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardProfile,
    DashboardScanResult,
} from '../types';

type InstanceListContentProps = {
    error: string | null;
    loading: boolean;
    instances: DashboardInstance[];
    filtered: DashboardInstance[];
    selectedInstance: DashboardInstance | null;
    data: DashboardScanResult | null;
    lifecycleBusyPort: number | null;
    transitioningPort: number | null;
    transitionAction: DashboardLifecycleAction | null;
    activityUnreadByPort: Record<string, number>;
    latestTitleByPort: Record<number, string>;
    busyPorts?: Set<number>;
    showLatestActivityTitles: boolean;
    showInlineLabelEditor: boolean;
    showSidebarRuntimeLine: boolean;
    showSelectedRowActions: boolean;
    profiles: DashboardProfile[];
    getLabel: (instance: DashboardInstance) => string;
    formatUptime: (seconds: number | null) => string;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onToggleFavorite?: (instance: DashboardInstance) => void;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

export function InstanceListContent(props: InstanceListContentProps) {
    // Session disclosure state lives with the list it decorates (260806 D2);
    // App.tsx stays inside its 500-line dashboard budget.
    const { activeSessionCount, sessionsOpen, setSessionsOpen } =
        useActiveSessionDisclosure(props.selectedInstance?.ok ? props.selectedInstance.port : null);
    const showEmpty = !props.error && !props.loading && props.instances.length === 0
        && !props.instances.some(instance => instance.hidden);
    const visibleInstances = props.selectedInstance && !props.filtered.some(instance => instance.port === props.selectedInstance?.port)
        ? [props.selectedInstance, ...props.filtered]
        : props.filtered;
    const handleSelect = (instance: DashboardInstance): void => {
        if (instance.ok) {
            props.onPreview(instance);
            return;
        }
        props.onSelect(instance);
    };
    const renderActiveSessionList = (port: number): ReactNode =>
        <InstanceSessionList key={port} port={port} open={sessionsOpen} />;

    return (
        <>
            {props.error && <section className="state error-state">Scan failed: {props.error}</section>}
            {!props.error && props.loading && <section className="state">Scanning local Jaw instances...</section>}
            {showEmpty && props.data?.manager && (
                <EmptyNavigator
                    rangeFrom={props.data.manager.rangeFrom}
                    rangeTo={props.data.manager.rangeTo}
                />
            )}
            {!props.error && !showEmpty && (
                <InstanceGroups
                    instances={visibleInstances}
                    selectedPort={props.selectedInstance?.port || null}
                    lifecycleBusyPort={props.lifecycleBusyPort}
                    transitioningPort={props.transitioningPort}
                    transitionAction={props.transitionAction}
                    activityUnreadByPort={props.activityUnreadByPort}
                    latestTitleByPort={props.latestTitleByPort}
                    {...(props.busyPorts !== undefined ? { busyPorts: props.busyPorts } : {})}
                    showLatestActivityTitles={props.showLatestActivityTitles}
                    showInlineLabelEditor={props.showInlineLabelEditor}
                    showSidebarRuntimeLine={props.showSidebarRuntimeLine}
                    showSelectedRowActions={props.showSelectedRowActions}
                    activeSessionCount={activeSessionCount}
                    activeSessionsOpen={sessionsOpen}
                    onToggleActiveSessions={() => setSessionsOpen(open => !open)}
                    renderActiveSessionList={renderActiveSessionList}
                    profiles={props.profiles}
                    getLabel={props.getLabel}
                    formatUptime={props.formatUptime}
                    onSelect={handleSelect}
                    onPreview={props.onPreview}
                    onMarkActivitySeen={props.onMarkActivitySeen}
                    onInstanceLabelSave={props.onInstanceLabelSave}
                    {...(props.onToggleFavorite !== undefined ? { onToggleFavorite: props.onToggleFavorite } : {})}
                    onLifecycle={props.onLifecycle}
                />
            )}
        </>
    );
}
