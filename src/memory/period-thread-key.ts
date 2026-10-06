export const PERIOD_THREAD_TIME_ZONE = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

export type CapturedPeriod = { periodKey: string; startMs: number; endMs: number; label: string };

/** Seoul has used UTC+09 since 1988; heartbeat periods are present/future dates. */
export function capturePeriodKey(nowMs: number, period: 'day' | 'week'): CapturedPeriod {
    const local = new Date(nowMs + KST_OFFSET_MS);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth();
    const day = local.getUTCDate();
    const localMidnight = Date.UTC(year, month, day);
    const localStart = period === 'week'
        ? localMidnight - ((local.getUTCDay() + 6) % 7) * DAY_MS
        : localMidnight;
    const startMs = localStart - KST_OFFSET_MS;
    const endMs = startMs + (period === 'week' ? 7 : 1) * DAY_MS;
    const first = new Date(localStart);
    const dateKey = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(first.getUTCDate()).padStart(2, '0')}`;
    const shortDate = (date: Date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    const label = period === 'day'
        ? `${shortDate(first)}(${WEEKDAYS[first.getUTCDay()]})`
        : `${shortDate(first)}~${shortDate(new Date(localStart + 6 * DAY_MS))}`;
    return { periodKey: dateKey, startMs, endMs, label };
}
