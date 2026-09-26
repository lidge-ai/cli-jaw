import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';
import type { DashboardInstance, DashboardLifecycleAction, DashboardProfile } from '../types';
import { composeInstanceRowTitle, formatWorkingDurationLabel, resolveInstanceRowStatus } from './instance-row-status';
import { ContextMenu, useContextMenu, type ContextMenuEntry } from './context-menu/ContextMenu';
import {
    ArchiveGlyph,
    CopyGlyph,
    ExternalGlyph,
    EyeGlyph,
    PencilGlyph,
    PinGlyph,
    PlayGlyph,
    RestartGlyph,
    StopGlyph,
} from './context-menu/icons';
import { copyText } from '../clipboard/copy-text';

type InstanceRowProps = {
    instance: DashboardInstance;
    profile?: DashboardProfile;
    selected: boolean;
    busy: boolean;
    agentBusy?: boolean;
    label: string;
    uptime: string;
    density?: 'compact' | 'comfortable' | 'rail';
    priority?: 'active' | 'pinned' | 'normal' | 'hidden';
    transitioning?: DashboardLifecycleAction | null;
    activityUnreadCount?: number;
    latestActivityTitle?: string | null;
    showLatestActivityTitle?: boolean;
    showInlineLabelEditor?: boolean;
    showRuntimeLine?: boolean;
    showSelectedActions?: boolean;
    /** Session disclosure. */
    sessionCount?: number;
    sessionListId?: string;
    sessionsOpen?: boolean;
    onToggleSessions?: (port: number) => void;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onToggleFavorite?: (instance: DashboardInstance) => void;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
    jumpHint?: string | null;
};

const TRANSITION_LABELS: Record<DashboardLifecycleAction, string> = {
    start: 'starting…',
    stop: 'stopping…',
    restart: 'restarting…',
    perm: 'registering…',
    unperm: 'unregistering…',
};

function statusClass(status: DashboardInstance['status']): string {
    return `instance-status status-${status}`;
}

const ChevronIcon = ({ open }: { open: boolean }) => (
    <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.12s' }}>
        <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
);

function WorkingDuration(props: { startedAtMs: number | null }) {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (props.startedAtMs == null) return undefined;
        const id = window.setInterval(() => setTick(tick => tick + 1), 1000);
        return () => window.clearInterval(id);
    }, [props.startedAtMs]);
    if (props.startedAtMs == null) return null;
    return (
        <span className="instance-row-working-duration">
            {formatWorkingDurationLabel(Date.now() - props.startedAtMs)}
        </span>
    );
}

export function InstanceRow(props: InstanceRowProps) {
    const lifecycle = props.instance.lifecycle;
    const reason = lifecycle?.reason || props.instance.healthReason || 'ok';
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(props.instance.label || props.profile?.label || props.label);
    const [savingLabel, setSavingLabel] = useState(false);
    const [labelError, setLabelError] = useState<string | null>(null);
    const rowMenu = useContextMenu();
    const labelInputRef = useRef<HTMLInputElement | null>(null);

    function stopAction(event: MouseEvent<HTMLElement>): void {
        event.stopPropagation();
    }

    const transitionLabel = props.transitioning ? TRANSITION_LABELS[props.transitioning] : null;
    const rowStatus = resolveInstanceRowStatus(props.instance, {
        busy: Boolean(props.agentBusy),
        transitioning: props.transitioning || null,
    });
    const startedAtRef = useRef<number | null>(null);
    if (rowStatus === 'working') {
        if (startedAtRef.current == null) startedAtRef.current = Date.now();
    } else {
        startedAtRef.current = null;
    }
    const statusLabel = rowStatus === 'transitioning' && transitionLabel
        ? transitionLabel
        : rowStatus === 'working' ? 'Working'
            : rowStatus === 'offline' ? 'Offline'
                : rowStatus === 'attention' ? 'Attention'
                    : 'Online';
    const hideStatusLine = props.density === 'compact' || props.density === 'rail';
    const dotClass = `${statusClass(props.instance.status)}${transitionLabel ? ' is-transitioning' : ''}${props.agentBusy ? ' is-busy' : ''} is-${rowStatus}`;
    const primaryLabel = props.instance.label || props.profile?.label || props.label;

    useEffect(() => {
        if (editing) labelInputRef.current?.focus();
    }, [editing]);

    function startEditing(): void {
        setDraft(props.instance.label || props.profile?.label || props.label);
        setLabelError(null);
        setEditing(true);
    }

    function openMenuFromKey(event: KeyboardEvent<HTMLElement>): void {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            rowMenu.openAt(event);
        }
    }

    function menuEntries(): ContextMenuEntry[] {
        const entries: ContextMenuEntry[] = [];
        if (props.showInlineLabelEditor !== false) {
            entries.push({
                id: 'rename',
                label: 'Rename',
                icon: <PencilGlyph />,
                onSelect: startEditing,
            });
        }
        if (props.onToggleFavorite) {
            entries.push({
                id: 'pin',
                label: props.instance.favorite ? 'Unpin' : 'Pin',
                icon: <PinGlyph />,
                onSelect: () => props.onToggleFavorite?.(props.instance),
            });
        }
        if (entries.length) entries.push({ kind: 'separator', id: 'sep-edit' });
        if (props.showSelectedActions !== false) {
            entries.push({
                id: 'preview',
                label: 'Preview',
                icon: <EyeGlyph />,
                disabled: !props.instance.ok,
                onSelect: () => props.onPreview(props.instance),
            });
        }
        entries.push({
            id: 'open',
            label: 'Open in new tab',
            icon: <ExternalGlyph />,
            disabled: !props.instance.ok,
            onSelect: () => {
                props.onMarkActivitySeen(props.instance.port);
                window.open(props.instance.url, '_blank', 'noreferrer');
            },
        });
        entries.push({ kind: 'separator', id: 'sep-lifecycle' });
        if (props.showSelectedActions !== false) {
            const startTitle = lifecycle?.commandPreview?.join(' ');
            entries.push(
                {
                    id: 'start',
                    label: 'Start',
                    icon: <PlayGlyph />,
                    disabled: !lifecycle?.canStart || props.busy,
                    ...(startTitle ? { title: startTitle } : {}),
                    onSelect: () => props.onLifecycle('start', props.instance),
                },
                {
                    id: 'restart',
                    label: 'Restart',
                    icon: <RestartGlyph />,
                    disabled: !lifecycle?.canRestart || props.busy,
                    onSelect: () => props.onLifecycle('restart', props.instance),
                },
                {
                    id: 'perm',
                    label: 'Register as persistent service',
                    icon: <ArchiveGlyph />,
                    disabled: !lifecycle?.canPerm || props.busy,
                    onSelect: () => props.onLifecycle('perm', props.instance),
                },
            );
        }
        entries.push({
            id: 'stop',
            label: 'Stop',
            icon: <StopGlyph />,
            danger: true,
            disabled: !lifecycle?.canStop || props.busy,
            onSelect: () => props.onLifecycle('stop', props.instance),
        });
        entries.push({ kind: 'separator', id: 'sep-copy' });
        entries.push(
            {
                id: 'copy-url',
                label: 'Copy URL',
                icon: <CopyGlyph />,
                disabled: !props.instance.ok,
                onSelect: () => void copyText(props.instance.url),
            },
            {
                id: 'copy-port',
                label: 'Copy port',
                icon: <CopyGlyph />,
                onSelect: () => void copyText(String(props.instance.port)),
            },
        );
        return entries;
    }

    async function submitLabel(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        event.stopPropagation();
        setSavingLabel(true);
        setLabelError(null);
        try {
            await props.onInstanceLabelSave(props.instance.port, draft);
            setEditing(false);
        } catch (error) {
            setLabelError((error as Error).message);
        } finally {
            setSavingLabel(false);
        }
    }

    return (
        <article
            className={`instance-row density-${props.density || 'comfortable'} priority-${props.priority || 'normal'} ${props.selected ? 'is-selected' : ''}${transitionLabel ? ' is-transitioning-row' : ''} is-${rowStatus}`}
            title={composeInstanceRowTitle(props.instance)}
            aria-current={props.selected ? 'true' : undefined}
            onContextMenu={rowMenu.openAt}
        >
            <div className="instance-row-body">
                <button
                    className="instance-row-select"
                    type="button"
                    data-instance-port={props.instance.port}
                    aria-pressed={props.selected}
                    onClick={() => {
                        props.onSelect(props.instance);
                    }}
                    onKeyDown={openMenuFromKey}
                >
                    <span className="instance-row-main">
                        <span className={dotClass} aria-label={props.instance.status} />
                        <span className="instance-row-title">
                            {!hideStatusLine ? (
                                <span className="instance-row-status-line" data-status={rowStatus}>
                                    <span className={`instance-row-status-pill is-${rowStatus} health-${props.instance.status}`} title={statusLabel}>
                                        {statusLabel}
                                    </span>
                                    {rowStatus === 'working' ? <WorkingDuration startedAtMs={startedAtRef.current} /> : null}
                                </span>
                            ) : null}
                            <span className="instance-row-title-line">
                                <strong>{props.instance.favorite ? `Pinned ${primaryLabel}` : primaryLabel}</strong>
                                {props.activityUnreadCount ? (
                                    <span className="instance-unread-badge" aria-label={`${props.activityUnreadCount} unread activity`}>
                                        ({props.activityUnreadCount > 99 ? '99+' : props.activityUnreadCount})
                                    </span>
                                ) : null}
                            </span>
                            {transitionLabel && <span className="instance-row-secondary"><em className="instance-row-transition">{transitionLabel}</em></span>}
                        </span>
                    </span>
                    <span className="instance-row-meta">
                        {props.priority !== 'active' && props.showLatestActivityTitle !== false && props.latestActivityTitle && <span className="instance-row-activity-title">{props.latestActivityTitle}</span>}
                        {props.showRuntimeLine !== false && <span className="instance-row-runtime">{props.instance.currentCli || 'cli n/a'} / {props.instance.currentModel || 'model n/a'}</span>}
                        {props.priority !== 'active' && <span className="instance-row-version">v{props.instance.version || 'n/a'} · {props.uptime}</span>}
                        {props.priority !== 'active' && <span className="instance-row-reason">{new Date(props.instance.lastCheckedAt).toLocaleTimeString()} · {reason}</span>}
                    </span>
                </button>
                <div className="instance-row-quick" onClick={stopAction}>
                    {props.priority === 'active' && props.instance.ok && (props.sessionCount ?? 0) >= 1 && props.onToggleSessions ? (
                        <button
                            type="button"
                            className="quick-btn action-sessions"
                            aria-controls={props.sessionListId}
                            aria-expanded={props.sessionsOpen === true}
                            aria-label={`Sessions (${props.sessionCount})`}
                            title={`Sessions (${props.sessionCount})`}
                            onClick={(event) => {
                                stopAction(event);
                                props.onToggleSessions?.(props.instance.port);
                            }}
                        >
                            <ChevronIcon open={props.sessionsOpen === true} />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="quick-btn action-stop"
                        onClick={(event) => {
                            stopAction(event);
                            props.onLifecycle('stop', props.instance);
                        }}
                        disabled={!lifecycle?.canStop || props.busy}
                        title="Stop"
                        aria-label="Stop"
                    >
                        <StopGlyph />
                    </button>
                    <a
                        className={`quick-btn action-open${!props.instance.ok ? ' is-disabled' : ''}`}
                        href={props.instance.ok ? props.instance.url : undefined}
                        target={props.instance.ok ? '_blank' : undefined}
                        rel={props.instance.ok ? 'noreferrer' : undefined}
                        title="Open in new tab"
                        aria-label="Open"
                        aria-disabled={!props.instance.ok || undefined}
                        tabIndex={props.instance.ok ? undefined : -1}
                        onClick={(event) => {
                            if (!props.instance.ok) { event.preventDefault(); return; }
                            stopAction(event);
                            props.onMarkActivitySeen(props.instance.port);
                        }}
                    >
                        <ExternalGlyph />
                    </a>
                    <span className="port">:{props.instance.port}</span>
                </div>
            </div>
            {props.showInlineLabelEditor !== false && editing ? (
                <form
                    className="instance-label-edit-form"
                    onSubmit={(event) => void submitLabel(event)}
                    onClick={stopAction}
                    onContextMenu={event => event.stopPropagation()}
                >
                    <input
                        ref={labelInputRef}
                        className="instance-label-input"
                        value={draft}
                        maxLength={120}
                        aria-label={`Rename ${primaryLabel}`}
                        onChange={event => setDraft(event.target.value)}
                    />
                    <button className="instance-label-save" type="submit" disabled={savingLabel}>Save</button>
                    <button
                        className="instance-label-cancel"
                        type="button"
                        disabled={savingLabel}
                        onClick={() => {
                            setDraft(props.instance.label || props.profile?.label || props.label);
                            setLabelError(null);
                            setEditing(false);
                        }}
                    >
                        Cancel
                    </button>
                    {labelError && <span className="instance-label-error">{labelError}</span>}
                </form>
            ) : null}
            {props.jumpHint ? <span className="instance-jump-hint" aria-hidden="true">{props.jumpHint}</span> : null}
            <ContextMenu
                state={rowMenu.state}
                entries={menuEntries()}
                label={`${primaryLabel} actions`}
                onClose={rowMenu.close}
            />
        </article>
    );
}
