import {
  EMPTY_TRAY_INSTANCES,
  parseDashboardInstances,
  type TrayInstancesSnapshot,
} from './tray-menu-model.js';

const DEFAULT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;

export interface TrayInstancesPoller {
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
  snapshot(): TrayInstancesSnapshot;
}

/**
 * Polls the manager's instance list for the menu bar. Modeled on the reminder badge
 * poller: one timer, overlapping refreshes coalesce, failures are logged and never
 * thrown, and the last good list is kept (marked stale by the menu after repeated
 * failures) instead of being cleared.
 */
export function createTrayInstancesPoller(opts: {
  managerUrl: string;
  onUpdate: (snapshot: TrayInstancesSnapshot) => void;
  log?: (message: string) => void;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): TrayInstancesPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let current: TrayInstancesSnapshot = EMPTY_TRAY_INSTANCES;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  function publish(next: TrayInstancesSnapshot): void {
    current = next;
    opts.onUpdate(next);
  }

  function schedule(): void {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshNow().then(schedule);
    }, intervalMs);
  }

  async function refreshNow(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const doFetch = opts.fetchImpl ?? fetch;
        const url = new URL('/api/dashboard/instances', opts.managerUrl).toString();
        const res = await doFetch(url, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const instances = parseDashboardInstances(await res.json());
        publish({ instances, updatedAt: Date.now(), failures: 0 });
      } catch (err) {
        opts.log?.(`[jaw-tray] instances refresh failed: ${(err as Error)?.message ?? err}`);
        publish({ ...current, failures: current.failures + 1 });
      } finally {
        clearTimeout(abort);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    start() {
      if (running) return;
      running = true;
      void refreshNow().then(schedule);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    refreshNow,
    snapshot: () => current,
  };
}
