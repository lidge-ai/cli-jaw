import { useMemo, useState } from 'react';
import { ContextMenu, useContextMenu, type ContextMenuEntry } from '../components/context-menu/ContextMenu';
import { CopyGlyph, EyeGlyph, RestartGlyph, StopGlyph } from '../components/context-menu/icons';
import type { BackgroundTaskRow, BackgroundTaskStatus } from './background-task-client';
import { countBackgroundTasksByStatus, useBackgroundTasks } from './useBackgroundTasks';

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
    running: 'Running',
    complete: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
    orphaned: 'Orphaned',
};

function formatTime(value: string | null): string {
    if (!value) return 'unknown';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(parsed));
}

function resultPreview(task: BackgroundTaskRow): string {
    const text = task.result?.trim();
    if (!text) return '';
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function taskSubtitle(task: BackgroundTaskRow): string {
    const time = task.completedAt ?? task.startedAt ?? task.createdAt;
    const parts = [
        task.kind,
        task.status === 'running' ? `started ${formatTime(time)}` : `updated ${formatTime(time)}`,
        task.runnerActive ? 'runner active' : '',
    ];
    return parts.filter(Boolean).join(' · ');
}

function taskCommand(task: BackgroundTaskRow): string {
    if (task.spec.command?.length) return task.spec.command.join(' ');
    if (task.kind === 'web-ai' && task.spec.completion.type === 'session-status') {
        return `web-ai session ${task.spec.completion.sessionId}`;
    }
    if (task.spec.completion.type === 'session-status') return `session ${task.spec.completion.sessionId}`;
    return task.spec.completion.type;
}

function recoveryNote(task: BackgroundTaskRow): string {
    if (task.kind === 'web-ai' && task.status === 'running' && task.spec.completion.type === 'session-status' && !task.runnerActive) {
        return 'Web-ai bridge is registered, but no Manager probe runner is attached. Refresh or restart Manager to recover the observer.';
    }
    if (task.kind === 'web-ai' && task.status === 'running' && task.spec.completion.type === 'session-status') {
        return 'Web-ai bridge is observing a native browser session; BrowserPanel state and Code transcript stay separate.';
    }
    if (task.status === 'orphaned') return 'Previous child process is still alive but no Manager runner owns it.';
    if (task.status === 'failed' && task.result?.includes('lost during server restart')) return 'Task was marked failed during restart recovery.';
    if ((task.status === 'complete' || task.status === 'failed') && !task.notifiedAt) return 'Completion notification is pending recovery delivery.';
    if (task.notifiedAt) return `Completion notification handed to boss queue ${formatTime(task.notifiedAt)}.`;
    return '';
}

type BackgroundTaskRowProps = {
    task: BackgroundTaskRow;
    expanded: boolean;
    busy: boolean;
    onCancel: (taskId: string) => void;
    onCopy: (task: BackgroundTaskRow) => void;
    onRetry: (task: BackgroundTaskRow) => void;
    onToggle: (taskId: string) => void;
};

function BackgroundTaskItem({ task, expanded, busy, onCancel, onCopy, onRetry, onToggle }: BackgroundTaskRowProps) {
    const menu = useContextMenu();
    const preview = resultPreview(task);
    const isRunning = task.status === 'running';
    const canRetry = task.status !== 'running';
    const note = recoveryNote(task);
    const menuEntries: ContextMenuEntry[] = [
        { id: 'details', label: expanded ? 'Hide details' : 'Show details', icon: <EyeGlyph />, onSelect: () => onToggle(task.id) },
        { kind: 'separator', id: 'sep-actions' },
        { id: 'retry', label: 'Retry', icon: <RestartGlyph />, disabled: !canRetry || busy, onSelect: () => onRetry(task) },
        { id: 'cancel', label: 'Cancel', icon: <StopGlyph />, disabled: !isRunning || busy, onSelect: () => onCancel(task.id) },
        { kind: 'separator', id: 'sep-copy' },
        { id: 'copy-result', label: 'Copy result', icon: <CopyGlyph />, disabled: !task.result || busy, onSelect: () => onCopy(task) },
    ];
    return (
        <li className={`code-bg-task-item is-${task.status}`} onContextMenu={menu.openAt}>
            <button
                type="button"
                className="code-bg-task-main"
                onClick={() => onToggle(task.id)}
                aria-expanded={expanded}
                onKeyDown={event => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) menu.openAt(event);
                }}
            >
                <span className={`code-bg-task-status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
                <span className="code-bg-task-title">{task.id}</span>
                <span className="code-bg-task-meta">{taskSubtitle(task)}</span>
            </button>
            <div className="code-bg-task-actions jaw-row-hover-actions">
                <button
                    type="button"
                    className="jaw-row-icon-btn"
                    onClick={() => onRetry(task)}
                    disabled={!canRetry || busy}
                    title="Run this background task spec again"
                    aria-label={`Retry ${task.id}`}
                >
                    <RestartGlyph />
                </button>
                <button
                    type="button"
                    className="jaw-row-icon-btn"
                    onClick={() => onCancel(task.id)}
                    disabled={!isRunning || busy}
                    title="Cancel running background task"
                    aria-label={`Cancel ${task.id}`}
                >
                    <StopGlyph />
                </button>
            </div>
            {expanded && (
                <div className="code-bg-task-detail">
                    <div className="code-bg-task-detail-row">
                        <span>Command</span>
                        <code>{taskCommand(task)}</code>
                    </div>
                    <div className="code-bg-task-detail-row">
                        <span>Completion</span>
                        <code>{task.spec.completion.type}</code>
                    </div>
                    {task.deadlineAt && (
                        <div className="code-bg-task-detail-row">
                            <span>Deadline</span>
                            <code>{task.deadlineAt}</code>
                        </div>
                    )}
                    {note && (
                        <div className={`code-bg-task-recovery-note is-${task.status}`}>
                            {note}
                        </div>
                    )}
                    {preview ? (
                        <div className="code-bg-task-result">
                            <div className="code-bg-task-result-head">
                                <span>Result</span>
                                <button type="button" onClick={() => onCopy(task)} disabled={busy}>Copy</button>
                            </div>
                            <pre>{preview}</pre>
                        </div>
                    ) : null}
                </div>
            )}
            <ContextMenu state={menu.state} entries={menuEntries} label={`Background task ${task.id}`} onClose={menu.close} />
        </li>
    );
}

export function BackgroundTaskMonitorPanel() {
    const { tasks, loading, error, lastUpdate, refresh, cancelTask, retryTask } = useBackgroundTasks();
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    const counts = useMemo(() => countBackgroundTasksByStatus(tasks), [tasks]);
    const visibleTasks = tasks.slice(0, 8);
    const lastStatus = lastUpdate?.changed ? `${lastUpdate.changed.kind} ${lastUpdate.changed.status}` : 'live';

    async function runTaskAction(taskId: string, action: () => Promise<void>): Promise<void> {
        setBusyTaskId(taskId);
        try {
            await action();
        } finally {
            setBusyTaskId(null);
        }
    }

    async function copyResult(task: BackgroundTaskRow): Promise<void> {
        if (!task.result || typeof navigator === 'undefined' || !navigator.clipboard) return;
        await navigator.clipboard.writeText(task.result);
    }

    return (
        <section className="code-bg-task-panel" aria-label="Background task monitor" data-monitor-owner="code-runtime-observability">
            <div className="code-bg-task-header">
                <div>
                    <span className="code-bg-task-kicker">Monitor</span>
                    <strong>Background tasks</strong>
                </div>
                <div className="code-bg-task-summary" aria-live="polite">
                    <span className={counts.running > 0 ? 'is-active' : ''}>{counts.running} running</span>
                    <span>{counts.complete} done</span>
                    <span>{counts.failed + counts.orphaned} attention</span>
                </div>
                <button type="button" className="code-bg-task-refresh" onClick={() => void refresh()} disabled={loading}>
                    Refresh
                </button>
            </div>
            {error && <div className="code-bg-task-error" role="status">{error}</div>}
            {loading ? (
                <div className="code-bg-task-empty">Loading background tasks...</div>
            ) : visibleTasks.length === 0 ? (
                <div className="code-bg-task-empty">No background tasks.</div>
            ) : (
                <ul className="code-bg-task-list">
                    {visibleTasks.map(task => (
                        <BackgroundTaskItem
                            key={task.id}
                            task={task}
                            expanded={expandedTaskId === task.id}
                            busy={busyTaskId === task.id}
                            onCancel={(taskId) => void runTaskAction(taskId, () => cancelTask(taskId))}
                            onCopy={(nextTask) => void runTaskAction(nextTask.id, () => copyResult(nextTask))}
                            onRetry={(nextTask) => void runTaskAction(nextTask.id, () => retryTask(nextTask))}
                            onToggle={(taskId) => setExpandedTaskId(prev => prev === taskId ? null : taskId)}
                        />
                    ))}
                </ul>
            )}
            <div className="code-bg-task-footer">
                <span>{tasks.length} tracked</span>
                <span>{lastStatus}</span>
            </div>
        </section>
    );
}
