import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardRegistryInstance,
    DashboardScanResult,
} from '../types';
import { ProcessControlPanel } from './ProcessControlPanel';
import { InstanceLogsPanel } from './InstanceLogsPanel';
import { formatUptime } from '../instance-label';
import './instance-overview.css';

type InstanceDetailPanelProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    activeTab: DashboardDetailTab;
    onRegistryPatch: (port: number, patch: Partial<DashboardRegistryInstance>) => void;
};

export function InstanceDetailPanel(props: InstanceDetailPanelProps) {
    const instance = props.instance;
    const checkedAt = instance ? new Date(instance.lastCheckedAt) : null;
    const hasCheckedAt = checkedAt != null && Number.isFinite(checkedAt.getTime());

    return (
        <section className="detail-panel" aria-label="Selected instance detail">
                {props.activeTab === 'overview' && (
                    <div className="instance-overview">
                        {instance ? (
                            <section className="overview-instance" aria-label="Instance overview">
                                <header className="overview-status-line">
                                    <div className="overview-status-heading">
                                        <span className={`overview-status is-${instance.status}`}>
                                            <span aria-hidden="true" />
                                            {instance.status}
                                        </span>
                                        <span className="overview-port">:{instance.port}</span>
                                    </div>
                                    <span className="overview-checked">
                                        {hasCheckedAt ? <>Checked <time dateTime={checkedAt.toISOString()} title={checkedAt.toLocaleString()}>{checkedAt.toLocaleTimeString()}</time></> : 'Check time unavailable'}
                                    </span>
                                </header>
                                {!instance.ok && <p className="overview-unavailable">This instance is not responding. Check its logs or use the instance menu to manage it.</p>}
                                <div className="overview-sections">
                                    <section aria-label="Runtime">
                                        <h3>Runtime</h3>
                                        <dl className="overview-properties">
                                            <div><dt>CLI</dt><dd>{instance.currentCli || 'Not reported'}</dd></div>
                                            <div><dt>Model</dt><dd className="overview-mono">{instance.currentModel || 'Not reported'}</dd></div>
                                            <div><dt>Version</dt><dd>{instance.version || 'Not reported'}</dd></div>
                                            <div><dt>Uptime</dt><dd>{instance.ok && instance.uptime != null ? formatUptime(instance.uptime) : 'Not available'}</dd></div>
                                        </dl>
                                    </section>
                                    <section aria-label="Connection">
                                        <h3>Connection</h3>
                                        <dl className="overview-properties">
                                            <div><dt>Address</dt><dd className="overview-mono">{instance.url}</dd></div>
                                            <div><dt>Managed by</dt><dd>{instance.lifecycle?.owner || 'Unknown'}</dd></div>
                                            <div><dt>Process ID</dt><dd className="overview-mono">{instance.lifecycle?.pid ?? 'Not reported'}</dd></div>
                                            <div><dt>Group</dt><dd>{instance.group || 'Ungrouped'}</dd></div>
                                        </dl>
                                    </section>
                                </div>
                                <section className="overview-project" aria-label="Project directories">
                                    <h3>Project</h3>
                                    {instance.projectDirs?.length ? (
                                        <ul>{instance.projectDirs.map(dir => <li key={dir} className="overview-mono">{dir}</li>)}</ul>
                                    ) : <p>{instance.ok && instance.projectDirs != null
                                        ? 'No project selected. Choose a folder from the instance header.'
                                        : 'Project information unavailable.'}</p>}
                                </section>
                                <details className="overview-diagnostics">
                                    <summary>Health &amp; ownership details</summary>
                                    <dl className="overview-properties">
                                        <div><dt>Health reason</dt><dd>{instance.healthReason || 'Not reported'}</dd></div>
                                        <div><dt>Ownership reason</dt><dd>{instance.lifecycle?.reason || 'Not reported'}</dd></div>
                                        <div><dt>Service mode</dt><dd>{instance.serviceMode}</dd></div>
                                    </dl>
                                </details>
                            </section>
                        ) : (
                            <div className="overview-no-selection">
                                <h3>No instance selected</h3>
                                <p>Select an instance in the sidebar to see its runtime and connection details.</p>
                            </div>
                        )}
                        <ProcessControlPanel />
                    </div>
                )}

                {props.activeTab === 'logs' && instance && (
                    <InstanceLogsPanel port={instance.port} />
                )}

                {props.activeTab === 'logs' && !instance && (
                    <div className="detail-empty">
                        Select an instance to view its logs.
                    </div>
                )}

        </section>
    );
}
