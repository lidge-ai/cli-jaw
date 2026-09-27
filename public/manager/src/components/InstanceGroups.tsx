import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { InstanceRow } from './InstanceRow';
import type {
    DashboardInstance,
    DashboardInstanceGroup,
    DashboardLifecycleAction,
    DashboardProfile,
} from '../types';
import { comparePinnedThenPort } from './instance-row-status';
import { useSidebarGroupCollapse } from '../hooks/useSidebarGroupCollapse';
import {
    SETTLED_TAIL_INITIAL_COUNT,
    SETTLED_TAIL_PAGE_COUNT,
    getJumpHintsVisible,
    isSettledStatus,
    pageSettledPorts,
    subscribeJumpHints,
} from './sidebar-keyboard';

type InstanceGroupsProps = {
    instances: DashboardInstance[];
    profiles?: DashboardProfile[];
    selectedPort: number | null;
    lifecycleBusyPort: number | null;
    transitioningPort?: number | null;
    transitionAction?: DashboardLifecycleAction | null;
    activityUnreadByPort?: Record<number, number>;
    latestTitleByPort?: Record<number, string>;
    busyPorts?: Set<number>;
    showLatestActivityTitles?: boolean;
    showInlineLabelEditor?: boolean;
    showSidebarRuntimeLine?: boolean;
    showSelectedRowActions?: boolean;
    density?: 'compact' | 'comfortable' | 'rail';
    /** Session disclosure for the Active row. */
    activeSessionCount?: number;
    activeSessionsOpen?: boolean;
    onToggleActiveSessions?: (port: number) => void;
    renderActiveSessionList?: (port: number) => ReactNode;
    getLabel: (instance: DashboardInstance) => string;
    formatUptime: (seconds: number | null) => string;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onToggleFavorite?: (instance: DashboardInstance) => void;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

type InstanceGroupSectionProps = {
    group: DashboardInstanceGroup;
    props: InstanceGroupsProps;
    profileMap: Map<string, DashboardProfile>;
    collapsed: boolean;
    onToggle: () => void;
    jumpStartIndex: number;
    showJumpHints: boolean;
    settledVisibleCount: number;
    onShowMoreSettled: () => void;
};

function withoutPorts(instances: DashboardInstance[], used: Set<number>): DashboardInstance[] {
    return instances.filter(instance => !used.has(instance.port));
}

function groupInstances(instances: DashboardInstance[], selectedPort: number | null): DashboardInstanceGroup[] {
    const used = new Set<number>();
    const selected = selectedPort == null ? [] : instances.filter(instance => instance.port === selectedPort);

    const favorites = withoutPorts(instances, used).filter(instance => instance.favorite);
    favorites.forEach(instance => used.add(instance.port));

    const userGroups = new Map<string, DashboardInstance[]>();
    for (const instance of withoutPorts(instances, used)) {
        if (!instance.group) continue;
        const group = userGroups.get(instance.group) || [];
        group.push(instance);
        userGroups.set(instance.group, group);
        used.add(instance.port);
    }

    const remaining = withoutPorts(instances, used);
    const running = remaining.filter(instance => instance.status === 'online');
    const attention = remaining.filter(instance => instance.status === 'error');
    const settled = remaining.filter(instance => isSettledStatus(instance.status));
    favorites.sort(comparePinnedThenPort);
    running.sort(comparePinnedThenPort);
    attention.sort(comparePinnedThenPort);
    settled.sort(comparePinnedThenPort);
    for (const group of userGroups.values()) group.sort(comparePinnedThenPort);

    const groups: DashboardInstanceGroup[] = [
        { id: 'active', label: 'Selected', instances: selected },
        { id: 'favorites', label: 'Pinned', instances: favorites },
        ...Array.from(userGroups.entries()).map(([label, group]) => ({
            id: `group-${label}`,
            label,
            instances: group,
        })),
        { id: 'running', label: 'Running', instances: running },
        { id: 'attention', label: 'Attention', instances: attention },
        { id: 'settled', label: 'Settled', instances: settled },
    ];

    return groups.filter(group => group.instances.length > 0);
}

function renderInstanceRow(
    props: InstanceGroupsProps,
    instance: DashboardInstance,
    profile?: DashboardProfile,
    priority: 'active' | 'normal' = 'normal',
    jumpHint?: string | null,
    sessionListId?: string,
) {
    return (
        <InstanceRow
            key={instance.port}
            instance={instance}
            {...(profile !== undefined ? { profile } : {})}
            selected={props.selectedPort === instance.port}
            busy={props.lifecycleBusyPort === instance.port}
            transitioning={props.transitioningPort === instance.port ? props.transitionAction || null : null}
            activityUnreadCount={props.activityUnreadByPort?.[instance.port] || 0}
            latestActivityTitle={props.latestTitleByPort?.[instance.port] || null}
            agentBusy={props.busyPorts?.has(instance.port) || false}
            {...(props.showLatestActivityTitles !== undefined ? { showLatestActivityTitle: props.showLatestActivityTitles } : {})}
            {...(props.showInlineLabelEditor !== undefined ? { showInlineLabelEditor: props.showInlineLabelEditor } : {})}
            {...(props.showSidebarRuntimeLine !== undefined ? { showRuntimeLine: props.showSidebarRuntimeLine } : {})}
            {...(props.showSelectedRowActions !== undefined ? { showSelectedActions: props.showSelectedRowActions } : {})}
            {...(props.density !== undefined ? { density: props.density } : {})}
            {...(priority === 'active' && props.activeSessionCount !== undefined ? { sessionCount: props.activeSessionCount } : {})}
            {...(priority === 'active' && props.activeSessionsOpen !== undefined ? { sessionsOpen: props.activeSessionsOpen } : {})}
            {...(priority === 'active' && props.onToggleActiveSessions ? { onToggleSessions: props.onToggleActiveSessions } : {})}
            {...(sessionListId !== undefined ? { sessionListId } : {})}
            priority={priority}
            label={props.getLabel(instance)}
            uptime={props.formatUptime(instance.uptime)}
            onSelect={props.onSelect}
            onPreview={props.onPreview}
            onMarkActivitySeen={props.onMarkActivitySeen}
            onInstanceLabelSave={props.onInstanceLabelSave}
            {...(props.onToggleFavorite !== undefined ? { onToggleFavorite: props.onToggleFavorite } : {})}
            onLifecycle={props.onLifecycle}
            jumpHint={jumpHint ?? null}
        />
    );
}

function visibleGroupInstances(
    group: DashboardInstanceGroup,
    selectedPort: number | null,
    collapsed: boolean,
    settledVisibleCount: number,
): DashboardInstance[] {
    const selected = group.instances.find(instance => instance.port === selectedPort);
    const pagedSettled = group.id === 'settled'
        ? pageSettledPorts(
            group.instances.map(instance => instance.port),
            settledVisibleCount,
            selectedPort,
        )
        : [];
    const settledByPort = new Map(group.instances.map(instance => [instance.port, instance]));
    const expandedInstances = group.id === 'settled'
        ? pagedSettled.map(port => settledByPort.get(port)).filter((instance): instance is DashboardInstance => instance != null)
        : group.instances;
    return group.id === 'active' || !collapsed
        ? expandedInstances
        : selected ? [selected] : [];
}

function InstanceGroupSection(section: InstanceGroupSectionProps) {
    const idNamespace = useId();
    const { group, props, profileMap, collapsed, onToggle, jumpStartIndex, showJumpHints, settledVisibleCount, onShowMoreSettled } = section;
    const settledExpanded = group.id !== 'settled' || !collapsed;
    const visible = visibleGroupInstances(group, props.selectedPort, collapsed, settledVisibleCount);
    const groupBodyId = `instance-group-body-${idNamespace}`;
    const sessionListId = group.id === 'active' && visible[0]?.ok
        ? `instance-sessions-${idNamespace}-${visible[0].port}`
        : undefined;
    const hiddenSettled = group.id === 'settled' && settledExpanded
        ? Math.max(0, group.instances.length - settledVisibleCount)
        : 0;
    const header = group.id === 'active' ? (
        <div className="instance-group-header">
            <span>{group.label}</span>
            <strong>{group.instances.length}</strong>
        </div>
    ) : (
        <button
            type="button"
            className="instance-group-header instance-group-toggle"
            aria-expanded={!collapsed}
            aria-controls={groupBodyId}
            onClick={onToggle}
        >
            <span>
                <svg className="instance-group-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" /></svg>
                {' '}{group.label}
            </span>
            <strong>{group.instances.length}</strong>
        </button>
    );

    return (
        <section className="instance-group" key={group.id} aria-label={`${group.label} instances`}>
            {header}
            <div id={groupBodyId} hidden={collapsed && visible.length === 0}>
                {visible.map((instance, rowIndex) => {
                    const jumpIndex = jumpStartIndex + rowIndex;
                    const jumpHint = showJumpHints && jumpIndex < 9 ? String(jumpIndex + 1) : null;
                    return renderInstanceRow(
                        props,
                        instance,
                        instance.profileId ? profileMap.get(instance.profileId) : undefined,
                        group.id === 'active' ? 'active' : 'normal',
                        jumpHint,
                        sessionListId,
                    );
                })}
                {group.id === 'active' && visible[0]?.ok ? (
                    <div id={sessionListId}>
                        {props.renderActiveSessionList?.(visible[0].port)}
                    </div>
                ) : null}
                {group.id === 'settled' && settledExpanded && hiddenSettled > 0 ? (
                    <button
                        type="button"
                        className="instance-settled-more"
                        onClick={onShowMoreSettled}
                    >
                        Show {Math.min(hiddenSettled, SETTLED_TAIL_PAGE_COUNT)} more
                    </button>
                ) : null}
            </div>
        </section>
    );
}

export function InstanceGroups(props: InstanceGroupsProps) {
    const groups = groupInstances(props.instances, props.selectedPort);
    const profileMap = new Map((props.profiles || []).map(profile => [profile.profileId, profile]));
    const { isCollapsed, toggle: toggleGroup } = useSidebarGroupCollapse();
    const showJumpHints = useSyncExternalStore(subscribeJumpHints, getJumpHintsVisible);
    const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);

    useEffect(() => {
        setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
    }, [props.instances]);

    if (groups.length === 0 && profileMap.size === 0) {
        return <section className="state">No matching instances found.</section>;
    }

    let jumpCursor = 0;
    const sections = groups.map(group => {
        const collapsed = group.id === 'active' ? false : isCollapsed(group.id);
        const visibleCount = visibleGroupInstances(group, props.selectedPort, collapsed, settledVisibleCount).length;
        const jumpStartIndex = jumpCursor;
        jumpCursor += visibleCount;
        return (
            <InstanceGroupSection
                key={group.id}
                group={group}
                props={props}
                profileMap={profileMap}
                collapsed={collapsed}
                onToggle={() => toggleGroup(group.id)}
                jumpStartIndex={jumpStartIndex}
                showJumpHints={showJumpHints}
                settledVisibleCount={settledVisibleCount}
                onShowMoreSettled={() => setSettledVisibleCount(count => count + SETTLED_TAIL_PAGE_COUNT)}
            />
        );
    });

    if (profileMap.size > 0) {
        return (
            <div className="instance-groups profile-instance-groups is-profile-merged">
                {sections}
            </div>
        );
    }

    return (
        <div className="instance-groups">
            {sections}
        </div>
    );
}
