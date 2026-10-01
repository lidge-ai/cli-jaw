import { countTrayReminderBadgeItems, type TrayReminderDateItem } from '../../../../src/shared/reminders/tray-triage.js';

const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ReminderBadgePoller {
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
}

export function createReminderBadgePoller(opts: {
  managerUrl: string;
  setBadge: (count: number) => void;
  log?: (message: string) => void;
  intervalMs?: number;
  requestTimeoutMs?: number;
}): ReminderBadgePoller {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  function logFailure(err: unknown): void {
    opts.log?.(`[jaw-tray] badge refresh failed: ${(err as Error)?.message ?? err}`);
  }

  function schedule(): void {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runOnceAndSchedule();
    }, intervalMs);
  }

  async function runOnceAndSchedule(): Promise<void> {
    await refreshNow();
    schedule();
  }

  async function refreshNow(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      // A fetch with no timeout can hang forever; inFlight would stay set and
      // the badge would silently stop updating until the next app restart.
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      try {
        const url = new URL('/api/dashboard/reminders', opts.managerUrl).toString();
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = await res.json() as { ok?: unknown; items?: unknown };
        if (body.ok !== true || !Array.isArray(body.items)) {
          throw new Error('unexpected reminders response');
        }
        opts.setBadge(countTrayReminderBadgeItems(body.items as TrayReminderDateItem[], new Date()));
      } catch (err) {
        logFailure(err);
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
      void runOnceAndSchedule();
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    refreshNow,
  };
}
