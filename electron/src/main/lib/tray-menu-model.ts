// Pure helpers for the menu bar (tray) instance list. No electron import on purpose:
// unit tests load this module directly.

export type TrayInstanceStatus = 'online' | 'offline' | 'timeout' | 'error' | 'unknown';

export interface TrayInstance {
  port: number;
  label: string;
  status: TrayInstanceStatus;
  cli: string | null;
  model: string | null;
}

export interface TrayInstancesSnapshot {
  instances: TrayInstance[];
  /** Epoch ms of the last successful refresh, or null before the first one. */
  updatedAt: number | null;
  /** Consecutive failed refreshes since the last success. */
  failures: number;
}

export const TRAY_INSTANCE_LIMIT = 8;
export const TRAY_STALE_AFTER_FAILURES = 2;

export const EMPTY_TRAY_INSTANCES: TrayInstancesSnapshot = { instances: [], updatedAt: null, failures: 0 };

const STATUSES = new Set<TrayInstanceStatus>(['online', 'offline', 'timeout', 'error', 'unknown']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lastPathSegment(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] ?? null : null;
}

/** Reads GET /api/dashboard/instances. Hidden rows and malformed rows are skipped. */
export function parseDashboardInstances(body: unknown): TrayInstance[] {
  const rows = (body as { instances?: unknown } | null)?.instances;
  if (!Array.isArray(rows)) throw new Error('unexpected instances response');
  const out: TrayInstance[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const port = row['port'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (row['hidden'] === true) continue;
    const status = STATUSES.has(row['status'] as TrayInstanceStatus) ? row['status'] as TrayInstanceStatus : 'unknown';
    const label = text(row['label']) ?? lastPathSegment(text(row['homeDisplay'])) ?? `cli-jaw ${port}`;
    out.push({ port, label, status, cli: text(row['currentCli']), model: text(row['currentModel']) });
  }
  return out;
}

export function orderInstances(instances: readonly TrayInstance[]): TrayInstance[] {
  return [...instances].sort((a, b) => {
    const online = Number(b.status === 'online') - Number(a.status === 'online');
    return online !== 0 ? online : a.port - b.port;
  });
}

export function instanceMenuLabel(instance: TrayInstance): string {
  const dot = instance.status === 'online' ? '●' : '○';
  const runtime = [instance.cli, instance.model].filter(Boolean).join('/');
  return `${dot} ${instance.label}  :${instance.port}${runtime ? ` · ${runtime}` : ''}`;
}

export function isTrayInstancesStale(snapshot: TrayInstancesSnapshot): boolean {
  return snapshot.failures >= TRAY_STALE_AFTER_FAILURES;
}

export function instancesSummaryLabel(snapshot: TrayInstancesSnapshot): string {
  if (snapshot.updatedAt === null) return snapshot.failures > 0 ? 'Instances — unavailable' : 'Instances — loading…';
  const online = snapshot.instances.filter(instance => instance.status === 'online').length;
  const base = `Instances — ${online} online of ${snapshot.instances.length}`;
  return isTrayInstancesStale(snapshot) ? `${base} (stale)` : base;
}

/** Visible rows plus the number of rows that did not fit. */
export function visibleInstances(snapshot: TrayInstancesSnapshot, limit = TRAY_INSTANCE_LIMIT): { rows: TrayInstance[]; hidden: number } {
  const ordered = orderInstances(snapshot.instances);
  return { rows: ordered.slice(0, limit), hidden: Math.max(0, ordered.length - limit) };
}
