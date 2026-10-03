import { useCallback, useEffect, useRef, useState } from 'react';
import {
    adoptManagedProcesses,
    fetchProcessControlState,
    stopManagedProcesses,
} from '../api';
import type { DashboardProcessControlState } from '../types';
import './process-control.css';

type ProcessOperation = 'refresh' | 'recover' | 'stop';

export function ProcessControlPanel() {
    const [state, setState] = useState<DashboardProcessControlState | null>(null);
    const [busy, setBusy] = useState<ProcessOperation | null>('refresh');
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const mounted = useRef(false);
    const activeRequest = useRef<object | null>(null);
    const managedCount = state?.managed.length ?? 0;

    const run = useCallback(async (
        operation: ProcessOperation,
        request: () => Promise<DashboardProcessControlState>,
    ): Promise<void> => {
        if (!mounted.current || activeRequest.current) return;
        const token = {};
        activeRequest.current = token;
        setBusy(operation);
        setMessage(null);
        setError(null);
        try {
            const next = await request();
            if (!mounted.current || activeRequest.current !== token) return;
            setState(next);
            setMessage(operation === 'stop'
                ? 'Stop request complete. The list shows remaining managed servers.'
                : operation === 'recover' ? 'Recovery complete. Managed process records refreshed.' : null);
        } catch (cause) {
            if (!mounted.current || activeRequest.current !== token) return;
            setError(cause instanceof Error ? cause.message : 'Unable to update managed processes. Try refreshing.');
        } finally {
            if (mounted.current && activeRequest.current === token) {
                activeRequest.current = null;
                setBusy(null);
            }
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void run('refresh', fetchProcessControlState);
        return () => {
            mounted.current = false;
            activeRequest.current = null;
        };
    }, [run]);

    function handleStopAll(): void {
        if (activeRequest.current || managedCount === 0 || error) return;
        if (!window.confirm(`Stop ${managedCount} dashboard-managed server${managedCount === 1 ? '' : 's'} across all instances?`)) return;
        void run('stop', stopManagedProcesses);
    }

    return (
        <section className="process-control-panel" aria-label="Managed processes — all instances">
            <header className="process-control-header">
                <div className="process-control-heading">
                    <h3>Managed processes</h3>
                    <p>All instances in this manager</p>
                </div>
                <button type="button" onClick={() => void run('refresh', fetchProcessControlState)} disabled={busy !== null}>
                    {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
                </button>
            </header>
            <div className="process-control-content" aria-busy={busy !== null}>
                <p className="process-control-count">
                    {state ? `${managedCount} managed server${managedCount === 1 ? '' : 's'}` : 'Process count unavailable'}
                    {error && state && <span> · Last loaded list</span>}
                </p>
                {state && managedCount > 0 && (
                    <table className="process-control-table">
                        <caption className="process-control-sr-only">Dashboard-managed servers across all instances</caption>
                        <thead><tr><th scope="col">Port</th><th scope="col">PID</th><th scope="col">Ownership proof</th></tr></thead>
                        <tbody>
                            {state.managed.map(entry => (
                                <tr key={entry.port}>
                                    <th scope="row">:{entry.port}</th>
                                    <td>{entry.pid ?? 'Unavailable'}</td>
                                    <td>{entry.proof === 'child' ? 'Child process' : 'Registry record'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {state && managedCount === 0 && (
                    <p className="process-control-empty">No managed servers. Start an instance or recover existing records below.</p>
                )}
            </div>
            <div className="process-control-feedback" role="status" aria-live="polite">
                {busy ? (busy === 'refresh' ? 'Loading managed processes…' : busy === 'recover' ? 'Recovering managed processes…' : 'Stopping managed servers…') : message}
            </div>
            {error && <p className="process-control-error" role="alert">{error} Use Refresh to check the current state.</p>}
            <details className="process-control-maintenance">
                <summary>Recovery &amp; stop all</summary>
                <div className="process-control-maintenance-body">
                    <p>These actions apply to all dashboard-managed servers. External instances are not stopped.</p>
                    <div className="process-control-actions">
                        <button type="button" onClick={() => void run('recover', adoptManagedProcesses)} disabled={busy !== null}>
                            {busy === 'recover' ? 'Recovering…' : 'Adopt/recover'}
                        </button>
                        <button type="button" className="process-control-stop" onClick={handleStopAll} disabled={busy !== null || managedCount === 0 || error !== null}>
                            {busy === 'stop' ? 'Stopping…' : 'Stop all managed'}
                        </button>
                    </div>
                    <p className="process-control-hint">Adopt/recover reconnects known managed process records.</p>
                </div>
            </details>
        </section>
    );
}
