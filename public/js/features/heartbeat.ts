// ── Heartbeat Feature ──
import { state } from '../state.js';
import type { HeartbeatJob, HeartbeatSchedule } from '../state.js';
import { t } from './i18n.js';
import { api, apiJson } from '../api.js';
import { escapeHtml } from '../render.js';
import { ICONS } from '../icons.js';
import {
    validateHeartbeatScheduleInput,
    type HeartbeatScheduleValidationCode,
} from '../../../src/memory/heartbeat-schedule.js';

interface HeartbeatData {
    jobs: HeartbeatJob[];
}

let mainCli: string | undefined;

export async function openHeartbeatModal(): Promise<void> {
    const [data, settings] = await Promise.all([
        api<HeartbeatData>('/api/heartbeat'),
        api<{ cli?: string }>('/api/settings'),
    ]);
    mainCli = settings?.cli;
    state.heartbeatJobs = (data?.jobs || []).map(normalizeHeartbeatJob);
    state.heartbeatErrors = collectHeartbeatErrors(state.heartbeatJobs as HeartbeatJob[]);
    renderHeartbeatJobs();
    document.getElementById('heartbeatModal')?.classList.add('open');
}

export function closeHeartbeatModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('heartbeatModal')?.classList.remove('open');
}

export function renderHeartbeatJobs(): void {
    const container = document.getElementById('hbJobsList');
    if (!container) return;
    const jobs = (state.heartbeatJobs as HeartbeatJob[]).map(normalizeHeartbeatJob);
    state.heartbeatJobs = jobs;
    state.heartbeatErrors = collectHeartbeatErrors(jobs);
    if (jobs.length === 0) {
        container.innerHTML = `<p style="color:var(--text-dim);font-size:12px;text-align:center">${t('hb.empty')}</p>`;
    } else {
        container.innerHTML = jobs.map((job, i) => {
            const schedule = normalizeSchedule(job.schedule);
            const isCron = schedule.kind === 'cron';
            const error = state.heartbeatErrors[job.id];
            const scheduleMeta = error || getHeartbeatScheduleHint(schedule);
            const scheduleMetaClass = error ? 'hb-schedule-meta hb-error' : 'hb-schedule-meta hb-help';
            const scheduleInput = isCron
                ? `<input type="text" value="${escapeHtml(schedule.cron)}" placeholder="${escapeHtml(t('hb.cronPlaceholder'))}"
                    data-hb-cron="${i}">`
                : `<input type="number" value="${schedule.minutes}" min="1" data-hb-minutes="${i}">`;
            const scheduleSuffix = isCron
                ? `<span class="hb-chip">${escapeHtml(t('hb.cronLabel'))}</span>`
                : `<span class="hb-chip">${escapeHtml(t('hb.minutesLabel'))}</span>`;
            return `
                <div class="hb-job-card">
                    <div class="hb-job-header">
                        <input type="text" value="${escapeHtml(String(job.name || ''))}" placeholder="${escapeHtml(t('hb.name'))}"
                            data-hb-name="${i}">
                        <button class="hb-toggle ${job.enabled ? 'on' : 'off'}"
                            data-hb-toggle="${i}" aria-label="${escapeHtml(String(job.name || 'job') + ' toggle')}"></button>
                        <button class="hb-del" data-hb-remove="${i}">${ICONS.close}</button>
                    </div>
                    <div class="hb-job-schedule">
                        <select data-hb-kind="${i}">
                            <option value="every"${isCron ? '' : ' selected'}>${escapeHtml(t('hb.kindEvery'))}</option>
                            <option value="cron"${isCron ? ' selected' : ''}>${escapeHtml(t('hb.kindCron'))}</option>
                        </select>
                        ${scheduleInput}
                        ${scheduleSuffix}
                        <input type="text" value="${escapeHtml(schedule.timeZone || '')}" placeholder="${escapeHtml(timeZonePlaceholder())}"
                            data-hb-timezone="${i}">
                    </div>
                    <p class="${scheduleMetaClass}">${escapeHtml(scheduleMeta)}</p>
                    <textarea class="hb-prompt" rows="2" placeholder="${escapeHtml(t('hb.prompt'))}"
                        data-hb-prompt="${i}">${escapeHtml(String(job.prompt || ''))}</textarea>
                </div>
            `;
        }).join('');
    }
    if (mainCli === 'aside') {
        const notice = document.createElement('p');
        notice.className = 'hb-schedule-meta hb-help';
        notice.setAttribute('role', 'status');
        notice.textContent = t('hb.asideUnsupported');
        container.prepend(notice);
    }
    const active = jobs.filter(j => j.enabled).length;
    const btn = document.getElementById('hbSidebarBtn');
    if (btn) btn.innerHTML = `${ICONS.heartPulse} Heartbeat (${active})`;
}

/** Ids must be unique across one save.
 *
 *  `Date.now()` alone is not enough. `normalizeHeartbeatJob` runs inside a
 *  `.map()`, so two jobs missing an id in the same millisecond both become
 *  `hb_<same-ms>`; two quick clicks on add-job collide the same way. The server
 *  rejects a duplicate id now — two jobs under one id share one mention-watch
 *  ledger namespace and the second inherits the first's cursor — so a collision
 *  that used to silently merge two jobs would fail the entire save. */
let idCounter = 0;

export function addHeartbeatJob(): void {
    (state.heartbeatJobs as HeartbeatJob[]).push({
        // Same-millisecond collision matters here too: two quick clicks on
        // 'add job' would otherwise produce one id twice.
        id: `hb_${Date.now()}_${idCounter++}`,
        name: '',
        enabled: true,
        schedule: withBrowserTimeZone({ kind: 'every', minutes: 5 }),
        prompt: '',
    });
    renderHeartbeatJobs();
    void saveHeartbeatJobs();
}

export function removeHeartbeatJob(i: number): void {
    state.heartbeatJobs.splice(i, 1);
    renderHeartbeatJobs();
    void saveHeartbeatJobs();
}

export function toggleHeartbeatJob(i: number): void {
    const jobs = state.heartbeatJobs as HeartbeatJob[];
    const job = jobs[i];
    if (!job) return;
    job.enabled = !job.enabled;
    renderHeartbeatJobs();
    void saveHeartbeatJobs();
}

export async function saveHeartbeatJobs(): Promise<void> {
    const jobs = (state.heartbeatJobs as HeartbeatJob[]).map(normalizeHeartbeatJob);
    state.heartbeatJobs = jobs;
    state.heartbeatErrors = collectHeartbeatErrors(jobs);
    if (Object.keys(state.heartbeatErrors).length > 0) {
        renderHeartbeatJobs();
        return;
    }
    const data = await apiJson<HeartbeatData>('/api/heartbeat', 'PUT', { jobs });
    if (data?.jobs) {
        state.heartbeatJobs = data.jobs.map(normalizeHeartbeatJob);
        state.heartbeatErrors = collectHeartbeatErrors(state.heartbeatJobs as HeartbeatJob[]);
        renderHeartbeatJobs();
    }
}

export async function initHeartbeatBadge(): Promise<void> {
    try {
        const d = await api<HeartbeatData>('/api/heartbeat');
        // A held job is enabled in the file but never scheduled, so it must not
        // be counted as active. `held` comes from the server, which owns that
        // judgement; the file only carries intent.
        const active = (d?.jobs || []).filter(j => j.enabled !== false && !(j as { held?: string }).held).length;
        const btn = document.getElementById('hbSidebarBtn');
        if (btn) btn.innerHTML = `${ICONS.heartPulse} Heartbeat (${active})`;
    } catch { /* ignore */ }
}

function normalizeHeartbeatJob(job: HeartbeatJob): HeartbeatJob {
    return {
        id: String(job.id || `hb_${Date.now()}_${idCounter++}`),
        name: String(job.name || ''),
        enabled: job.enabled !== false,
        schedule: normalizeSchedule(job.schedule),
        prompt: String(job.prompt || ''),
    };
}

function normalizeSchedule(schedule: HeartbeatJob['schedule']): HeartbeatSchedule {
    const timeZone = normalizeTimeZone(schedule?.timeZone);
    if (schedule?.kind === 'cron') {
        const cron = typeof schedule.cron === 'string'
            ? schedule.cron.trim().replace(/\s+/g, ' ')
            : '0 9 * * *';
        return timeZone ? { kind: 'cron', cron, timeZone } : { kind: 'cron', cron };
    }
    const minutes = typeof schedule?.minutes === 'number' && Number.isFinite(schedule.minutes) && schedule.minutes > 0
        ? Math.max(1, Math.floor(schedule.minutes))
        : 5;
    return timeZone ? { kind: 'every', minutes, timeZone } : { kind: 'every', minutes };
}

function normalizeTimeZone(value: unknown): string | undefined {
    const timeZone = typeof value === 'string' ? value.trim() : '';
    return timeZone || undefined;
}

function withBrowserTimeZone(schedule: HeartbeatSchedule): HeartbeatSchedule {
    const timeZone = detectBrowserTimeZone();
    if (!timeZone) return schedule;
    return { ...schedule, timeZone };
}

function detectBrowserTimeZone(): string | undefined {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
}

function timeZonePlaceholder(): string {
    const browserTimeZone = detectBrowserTimeZone();
    return browserTimeZone ? `${t('hb.timezoneAuto')} ${browserTimeZone}` : t('hb.timezoneAuto');
}

function collectHeartbeatErrors(jobs: HeartbeatJob[]): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const job of jobs) {
        const error = validateHeartbeatDraft(job);
        if (error) errors[job.id] = error;
    }
    return errors;
}

function validateHeartbeatDraft(job: HeartbeatJob): string | null {
    const result = validateHeartbeatScheduleInput(job.schedule);
    if (result.ok) return null;
    return formatHeartbeatValidationError(result.code, result.error);
}

function formatHeartbeatValidationError(code: HeartbeatScheduleValidationCode, fallback: string): string {
    switch (code) {
        case 'invalid_cron':
            return t('hb.invalidCron');
        case 'invalid_timezone':
            return t('hb.invalidTimeZone');
        case 'invalid_minutes':
            return t('hb.invalidMinutes');
        default:
            return fallback || t('hb.invalidSchedule');
    }
}

function getHeartbeatScheduleHint(schedule: HeartbeatSchedule): string {
    const timeZone = schedule.timeZone || detectBrowserTimeZone() || 'Asia/Seoul';
    if (schedule.kind === 'cron') {
        return t('hb.scheduleHintCron', { cron: '0 9 * * *', timeZone });
    }
    return t('hb.scheduleHintEvery', { minutes: schedule.minutes, timeZone });
}
