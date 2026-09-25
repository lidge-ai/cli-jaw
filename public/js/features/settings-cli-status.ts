// ── CLI Status & Quota ──
import { api } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';
import { state } from '../state.js';
import { ICONS } from '../icons.js';
import { providerIcon, providerLabel } from '../provider-icons.js';
import { describeCliProbe, describeNativeStartFailure, isCliStatusUsable, resolveQuotaWindowDisplay, type CliStatusInfo, type QuotaEntry } from './settings-types.js';
import {
    buildAccountParts,
    normalizeQuotaWindowLabel,
    QUOTA_CUSTOM_MSG,
    QUOTA_HIDDEN_CLIS,
    QUOTA_SETUP_HINTS,
    SIDEBAR_HIDDEN_CLIS,
    renderQuotaSetupBox,
    renderSetupHelpMark,
} from './settings-cli-status-render.js';

export { normalizeQuotaWindowLabel } from './settings-cli-status-render.js';

const CLI_STATUS_INTERVAL_VALUES = new Set([0, 600, 1800]);
const DEFAULT_CLI_STATUS_INTERVAL_SEC = 0;
/** Defer heavy /api/quota so chat/history APIs win on initial page load. */
const QUOTA_LOAD_DEFER_MS = 2000;
const CLI_STATUS_REFRESH_DONE_CLEAR_MS = 4000;

type CliStatusRefreshFeedback = 'idle' | 'refreshing' | 'success' | 'error';

let cliStatusTimer: number | null = null;
let cliStatusPreviewHooksRegistered = false;
let cliStatusLoadSeq = 0;
let cliStatusLoadInFlight: Promise<void> | null = null;
let cliStatusRefreshFeedbackTimer: number | null = null;

const CLI_STATUS_COLLAPSED_KEY = 'cliStatusCollapsed';
const CLI_STATUS_UNDETECTED_EXPANDED_KEY = 'cliStatusUndetectedExpanded';

export function isEmbeddedPreviewFrame(): boolean {
    try {
        return window.parent !== window;
    } catch {
        return true;
    }
}

function readCliStatusCollapsed(): boolean {
    try { return localStorage.getItem(CLI_STATUS_COLLAPSED_KEY) === 'true'; }
    catch { return false; }
}

function saveCliStatusCollapsed(collapsed: boolean): void {
    try { localStorage.setItem(CLI_STATUS_COLLAPSED_KEY, collapsed ? 'true' : 'false'); }
    catch { /* ignore */ }
}

function readCliStatusUndetectedExpanded(): boolean {
    try { return localStorage.getItem(CLI_STATUS_UNDETECTED_EXPANDED_KEY) === 'true'; }
    catch { return false; }
}

function saveCliStatusUndetectedExpanded(expanded: boolean): void {
    try { localStorage.setItem(CLI_STATUS_UNDETECTED_EXPANDED_KEY, expanded ? 'true' : 'false'); }
    catch { /* ignore */ }
}

function formatCliStatusRefreshTime(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function clearCliStatusRefreshFeedbackTimer(): void {
    if (cliStatusRefreshFeedbackTimer == null) return;
    window.clearTimeout(cliStatusRefreshFeedbackTimer);
    cliStatusRefreshFeedbackTimer = null;
}

function setCliStatusRefreshFeedback(kind: CliStatusRefreshFeedback, message = ''): void {
    clearCliStatusRefreshFeedbackTimer();

    const button = document.getElementById('cliStatusRefreshBtn') as HTMLButtonElement | null;
    const status = document.getElementById('cliStatusRefreshState');
    const label = button?.querySelector<HTMLElement>('.cli-refresh-label');

    if (button) {
        button.classList.remove('is-refreshing', 'is-success', 'is-error');
        button.disabled = kind === 'refreshing';
        if (kind === 'idle') button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', kind === 'refreshing' ? 'true' : 'false');
        if (kind === 'refreshing') button.classList.add('is-refreshing');
        if (kind === 'success') button.classList.add('is-success');
        if (kind === 'error') button.classList.add('is-error');
    }

    if (label) label.textContent = kind === 'refreshing' ? 'Refreshing...' : 'Refresh';
    if (status) {
        status.textContent = message;
        status.dataset['state'] = kind;
    }
}

function finishCliStatusRefreshFeedback(kind: Exclude<CliStatusRefreshFeedback, 'idle' | 'refreshing'>, message: string): void {
    setCliStatusRefreshFeedback(kind, message);
    cliStatusRefreshFeedbackTimer = window.setTimeout(() => {
        setCliStatusRefreshFeedback('idle');
    }, CLI_STATUS_REFRESH_DONE_CLEAR_MS);
}

let cliStatusExpanded = !readCliStatusCollapsed();

export function isCliStatusExpanded(): boolean {
    return cliStatusExpanded;
}

export function expandCliStatus(): void {
    cliStatusExpanded = true;
    const list = document.getElementById('cliStatusList');
    const header = document.getElementById('cliStatusHeader');
    if (list) list.style.display = 'block';
    if (header) header.classList.add('expanded');
    saveCliStatusCollapsed(false);
    void loadCliStatus(true);
}

export function initCliStatusToggle(): void {
    const header = document.getElementById('cliStatusHeader');
    const list = document.getElementById('cliStatusList');
    if (!header || !list) return;

    if (!cliStatusExpanded) {
        list.style.display = 'none';
    } else {
        list.style.display = 'block';
        header.classList.add('expanded');
    }

    header.addEventListener('click', () => {
        cliStatusExpanded = !cliStatusExpanded;
        list.style.display = cliStatusExpanded ? 'block' : 'none';
        header.classList.toggle('expanded', cliStatusExpanded);
        saveCliStatusCollapsed(!cliStatusExpanded);
        if (cliStatusExpanded) void loadCliStatus(true);
    });
}

function readCliStatusInterval(): number {
    const raw = Number(localStorage.getItem('cliStatusInterval') || DEFAULT_CLI_STATUS_INTERVAL_SEC);
    return CLI_STATUS_INTERVAL_VALUES.has(raw) ? raw : DEFAULT_CLI_STATUS_INTERVAL_SEC;
}

function syncCliStatusIntervalSelect(interval = readCliStatusInterval()): void {
    const select = document.getElementById('cliStatusInterval') as HTMLSelectElement | null;
    if (!select) return;
    const value = String(interval);
    select.value = Array.from(select.options).some(option => option.value === value)
        ? value
        : String(DEFAULT_CLI_STATUS_INTERVAL_SEC);
}

export function scheduleCliStatusRefresh(): void {
    if (cliStatusTimer != null) {
        window.clearInterval(cliStatusTimer);
        cliStatusTimer = null;
    }

    const interval = readCliStatusInterval();
    syncCliStatusIntervalSelect(interval);
    if (interval <= 0) return;

    cliStatusTimer = window.setInterval(() => {
        if (document.hidden || !cliStatusExpanded) return;
        // Parent dashboard keeps focus while iframe preview is visible.
        if (!isEmbeddedPreviewFrame() && !document.hasFocus()) return;
        void loadCliStatus(true);
    }, interval * 1000);
}

export function initCliStatusPreviewHooks(): void {
    if (cliStatusPreviewHooksRegistered || !isEmbeddedPreviewFrame()) return;
    cliStatusPreviewHooksRegistered = true;
    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: unknown; visible?: unknown } | null;
        if (data?.type !== 'jaw-preview-visibility' || data.visible !== true) return;
        if (!cliStatusExpanded) return;
        void loadCliStatus(false);
    });
}

export function setCliStatusInterval(value: string): void {
    const parsed = Number(value);
    const interval = CLI_STATUS_INTERVAL_VALUES.has(parsed) ? parsed : DEFAULT_CLI_STATUS_INTERVAL_SEC;
    localStorage.setItem('cliStatusInterval', String(interval));
    syncCliStatusIntervalSelect(interval);
    scheduleCliStatusRefresh();
}

function scheduleEmbeddedQuotaRetry(
    seq: number,
    cliStatus: Record<string, CliStatusInfo>,
    cachedQuota: Record<string, QuotaEntry> | null | undefined,
): void {
    if (!isEmbeddedPreviewFrame()) return;
    void (async () => {
        await new Promise(resolve => window.setTimeout(resolve, 600));
        if (seq !== cliStatusLoadSeq) return;
        const retry = await api<Record<string, QuotaEntry>>('/api/quota');
        if (seq !== cliStatusLoadSeq || !retry) return;
        state.cliStatusCache = { cliStatus, quota: retry } as Record<string, unknown>;
        state.cliStatusTs = Date.now();
        renderCliStatus({ cliStatus, quota: retry });
    })();
}

async function fetchAndRenderQuota(
    seq: number,
    cliStatus: Record<string, CliStatusInfo>,
    cachedQuota: Record<string, QuotaEntry> | null | undefined,
): Promise<boolean> {
    const quota = await api<Record<string, QuotaEntry>>('/api/quota');
    if (seq !== cliStatusLoadSeq) return false;

    const resolvedQuota = quota ?? cachedQuota ?? null;
    state.cliStatusCache = { cliStatus, quota: resolvedQuota } as Record<string, unknown>;
    if (quota) state.cliStatusTs = Date.now();
    renderCliStatus({ cliStatus, quota: resolvedQuota });

    if (!quota) scheduleEmbeddedQuotaRetry(seq, cliStatus, cachedQuota);
    return Boolean(quota);
}

function scheduleQuotaFetch(
    force: boolean,
    seq: number,
    cliStatus: Record<string, CliStatusInfo>,
    cachedQuota: Record<string, QuotaEntry> | null | undefined,
): Promise<boolean> | void {
    const run = () => { void fetchAndRenderQuota(seq, cliStatus, cachedQuota).catch(() => {}); };
    if (force) return fetchAndRenderQuota(seq, cliStatus, cachedQuota);
    window.setTimeout(run, QUOTA_LOAD_DEFER_MS);
}

export async function loadCliStatus(force = false): Promise<void> {
    if (!cliStatusExpanded) return;
    if (force) setCliStatusRefreshFeedback('refreshing', 'Refreshing quota...');

    if (cliStatusLoadInFlight) {
        if (force) await cliStatusLoadInFlight.catch(() => {});
        else return;
    }

    cliStatusLoadInFlight = (async () => {
        const seq = ++cliStatusLoadSeq;
        const el = document.getElementById('cliStatusList');
        try {
            const interval = readCliStatusInterval();
            if (!force && state.cliStatusCache && interval > 0 && (Date.now() - state.cliStatusTs) < interval * 1000) {
                renderCliStatus({
                    cliStatus: (state.cliStatusCache as Record<string, unknown>)?.['cliStatus'] as Record<string, CliStatusInfo> | null,
                    quota: (state.cliStatusCache as Record<string, unknown>)?.['quota'] as Record<string, QuotaEntry> | null,
                });
                return;
            }

            const cachedQuota = (state.cliStatusCache as Record<string, unknown> | null)?.['quota'] as Record<string, QuotaEntry> | null | undefined;
            if (el && !cachedQuota) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Loading...</div>';

            const cliStatus = await api<Record<string, CliStatusInfo>>('/api/cli-status');
            if (seq !== cliStatusLoadSeq) return;
            if (!cliStatus || typeof cliStatus !== 'object') {
                if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Failed to load CLI status</div>';
                if (force) finishCliStatusRefreshFeedback('error', 'Refresh failed');
                return;
            }

            renderCliStatus({ cliStatus, quota: cachedQuota ?? null });

            const quotaUpdated = await scheduleQuotaFetch(force, seq, cliStatus, cachedQuota);
            if (force && seq === cliStatusLoadSeq) {
                const verb = quotaUpdated ? 'Updated' : 'Checked';
                finishCliStatusRefreshFeedback('success', `${verb} ${formatCliStatusRefreshTime(new Date())}`);
            }
        } catch {
            if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Failed to load CLI status</div>';
            if (force) finishCliStatusRefreshFeedback('error', 'Refresh failed');
        }
    })().finally(() => {
        cliStatusLoadInFlight = null;
    });

    await cliStatusLoadInFlight;
}

function renderCliStatus(data: { cliStatus: Record<string, CliStatusInfo> | null; quota: Record<string, QuotaEntry> | null }): void {
    const { cliStatus, quota } = data;
    const el = document.getElementById('cliStatusList');

    const AUTH_HINTS: Record<string, { install: string; auth: string }> = {
        agy: { install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', auth: 'agy runtime auth, antigravity-usage login, or ~/.gemini oauth for quota' },
        claude: { install: 'npm i -g @anthropic-ai/claude-code', auth: 'claude auth' },
        codex: { install: 'npm i -g @openai/codex', auth: 'codex login' },
        'codex-app': { install: 'npm i -g @openai/codex', auth: 'codex login' },
        cursor: { install: 'curl https://cursor.com/install -fsS | bash', auth: 'cursor-agent login, CURSOR_API_KEY, or CURSOR_SESSION_TOKEN for quota' },
        'kiro-code': { install: 'Install Kiro CLI from https://kiro.dev/docs/cli', auth: 'kiro-cli login' },
        gemini: { install: 'npm i -g @google/gemini-cli', auth: `gemini  (${t('cli.gemini.auth')})` },
        grok: { install: 'curl -fsSL https://x.ai/cli/install.sh | bash', auth: 'grok login --oauth' },
        opencode: { install: 'npm i -g opencode-ai', auth: 'opencode auth' },
        copilot: { install: 'npm i -g copilot', auth: t('cli.copilot.authHint') },
    };

    const usableCards: string[] = [];
    const undetectedCards: string[] = [];

    if (!cliStatus || typeof cliStatus !== 'object') {
        if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Failed to load CLI status</div>';
        return;
    }

    for (const [name, info] of Object.entries(cliStatus)) {
        if (SIDEBAR_HIDDEN_CLIS.has(name)) continue;
        const probeDescription = describeCliProbe(info);
        const checking = probeDescription === 'checking';
        const probeUnknown = probeDescription === 'unknown';
        const probeFailing = probeDescription === 'probe-failing';
        const capabilityFailed = probeDescription === 'capability-failed';
        const q = checking || probeUnknown || probeFailing ? undefined : quota?.[name];
        let dotClass: string;
        if (checking) {
            dotClass = 'checking';
        } else if (probeUnknown || probeFailing) {
            // A preserved snapshot would otherwise render green while every
            // probe is erroring — the dashboard lie #277 reports.
            dotClass = 'warn';
        } else if (!info.available || capabilityFailed) {
            dotClass = 'missing';
        } else if (!q || q.error) {
            dotClass = 'ok';
        } else if (q.authenticated === false) {
            dotClass = 'warn';
        } else {
            dotClass = 'ok';
        }

        let accountLine = '';
        const showSetupBox = q?.quotaCapable === false
            && q.authenticated !== false
            && info.available
            && !QUOTA_CUSTOM_MSG[name]
            && !QUOTA_HIDDEN_CLIS.has(name);
        if (q?.account && !showSetupBox) {
            const parts = buildAccountParts(name, q);
            if (parts.length) accountLine = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 4px 16px">${escapeHtml(parts.join(' · '))}</div>`;
        }

        let authHint = '';
        // A failing probe means we know nothing current about this runtime, so
        // offering install/auth remediation would send the user to fix the
        // wrong thing entirely (#277).
        if (!checking && !probeUnknown && !probeFailing && (!info.available || dotClass === 'warn')) {
            const hint = AUTH_HINTS[name];
            if (hint) {
                const isNotInstalled = !info.available;
                const title = isNotInstalled ? t('cli.authRequired') : t('cli.notAuthenticated');
                const borderColor = isNotInstalled ? 'var(--error)' : 'var(--warning)';
                authHint = `
                    <div style="font-size:10px;margin:4px 0 2px 16px;padding:6px 8px;background:var(--surface);border-radius:4px;border-left:2px solid ${borderColor}">
                        <div style="color:${borderColor};margin-bottom:3px">${title}</div>
                        ${isNotInstalled ? `<div style="color:var(--text-dim)"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.install)}</code></div>` : ''}
                        <div style="color:var(--text-dim)${isNotInstalled ? ';margin-top:2px' : ''}"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.auth)}</code></div>
                    </div>
                `;
            }
        }

        let windowsHtml = '';
        const customQuotaMsg = QUOTA_CUSTOM_MSG[name];
        if (QUOTA_HIDDEN_CLIS.has(name)) {
            // no quota display for this CLI
        } else if (customQuotaMsg && info.available) {
            windowsHtml = `
                <div style="font-size:10px;color:var(--text-dim);margin:4px 0 0 16px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px">
                    ${escapeHtml(customQuotaMsg)}
                </div>
            `;
        } else if (showSetupBox) {
            windowsHtml = renderQuotaSetupBox(name, q);
        } else if (q?.windows?.length) {
            windowsHtml = q.windows.map(w => {
                const display = resolveQuotaWindowDisplay(w);
                const pct = display.percent ?? 0;
                const barColor = pct > 80 ? 'var(--error)' : pct > 50 ? 'var(--warning)' : 'var(--info)';
                const shortLabel = normalizeQuotaWindowLabel(name, w.label);
                let resetStr = '';
                if (w.resetsAt) {
                    const d = new Date(typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : w.resetsAt);
                    const now = new Date();
                    if (d.toDateString() === now.toDateString()) {
                        resetStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
                    } else {
                        resetStr = `${d.getMonth() + 1}/${d.getDate()}`;
                    }
                }
                const usageDisplay = display.percent == null
                    ? `<span style="flex:1"></span><span style="min-width:52px;text-align:right" title="Exact percentage unavailable">${escapeHtml(display.text)}</span>`
                    : `<div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px"></div></div><span style="width:24px;text-align:right">${display.text}</span>`;
                return `
                    <div style="display:flex;align-items:center;gap:4px;margin-left:16px;font-size:10px;color:var(--text-dim)">
                        <span style="min-width:18px;max-width:48px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(shortLabel)}</span>
                        ${usageDisplay}
                        ${resetStr ? `<span style="width:30px;text-align:right;opacity:0.6">${resetStr}</span>` : ''}
                    </div>
                `;
            }).join('');
        } else if (q?.error && info.available) {
            const msg = q.reason === 'rate_limited' ? 'Rate limited — retry in a moment' : 'Usage data unavailable';
            windowsHtml = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 0 16px;opacity:0.7">${ICONS.warning} ${msg}</div>`;
        }

        const quotaHelpMark = q?.quotaCapable && QUOTA_SETUP_HINTS[name]
            ? renderSetupHelpMark(name, q)
            : '';

        const billingLabel = q?.billing?.usedUsd != null && q?.billing?.limitUsd
            ? `<span style="margin-left:auto;font-size:10px;color:var(--text-dim);white-space:nowrap">$${q.billing.usedUsd.toFixed(1)}/$${q.billing.limitUsd}</span>`
            : '';

        const probeLine = checking
            ? '<div role="status" aria-live="polite" style="font-size:10px;color:var(--text-dim);margin:2px 0 0 16px">상태 확인 중</div>'
            : probeUnknown
                ? `<div role="alert" style="font-size:10px;color:var(--warning);margin:2px 0 0 16px">Probe unavailable${info.probeError ? ` · ${escapeHtml(info.probeError)}` : ''}</div>`
            : probeFailing
                ? `<div role="alert" style="font-size:10px;color:var(--warning);margin:2px 0 0 16px">상태 확인 실패 · 재시도 중${info.probeError ? ` · ${escapeHtml(info.probeError)}` : ''}</div>`
                : capabilityFailed
                ? `<div role="status" style="font-size:10px;color:var(--error);margin:2px 0 0 16px">설치됨, app-server 사용 불가${info.reason ? ` · ${escapeHtml(info.reason)}` : ''}</div>`
                : probeDescription === 'stale'
                    ? '<div role="status" style="font-size:10px;color:var(--text-dim);margin:2px 0 0 16px">이전 상태 표시 중 · 새로 확인 중</div>'
                    : '';

        // Independent of the probe line above: a runtime can be installed,
        // authenticated and probing fresh while every native turn dies before it
        // starts. Showing the code here is what makes that visible without the
        // server log (#658).
        const startFailure = describeNativeStartFailure(info);
        const startFailureLine = startFailure
            ? `<div role="alert" style="font-size:10px;color:var(--warning);margin:2px 0 0 16px">${escapeHtml(startFailure.message)}</div>`
            : '';

        const cardHtml = `
            <div class="settings-group" style="margin-bottom:6px;padding:8px 10px">
                <div class="cli-status-row" style="display:flex;align-items:center">
                    <span class="cli-dot ${dotClass}"></span>
                    <span class="cli-provider-icon" aria-hidden="true">${providerIcon(name) || ''}</span>
                    <span class="cli-name" style="font-weight:600">${escapeHtml(providerLabel(name))}${quotaHelpMark}</span>${name === 'copilot' ? `<button id="copilotKeychainBtn" style="font-size:9px;margin-left:6px;padding:1px 5px;background:var(--border);color:var(--text-dim);border:1px solid var(--text-dim);border-radius:3px;cursor:pointer;vertical-align:middle;line-height:1" title="${t('copilot.keychainHint')}">${ICONS.key}</button>` : ''}${billingLabel}
                </div>
                ${accountLine}
                ${probeLine}
                ${startFailureLine}
                ${authHint}
                ${windowsHtml}
            </div>
        `;
        (isCliStatusUsable(info, q) ? usableCards : undetectedCards).push(cardHtml);
    }

    let html = usableCards.join('');
    if (undetectedCards.length) {
        // Collapsed by default: CLIs needing install/auth stop crowding the
        // working list, but stay one click away in the same order.
        const undetectedExpanded = readCliStatusUndetectedExpanded();
        html += `
            <div class="cli-undetected-group">
                <button type="button" id="cliUndetectedToggle" class="cli-status-header cli-undetected-toggle${undetectedExpanded ? ' expanded' : ''}"
                    aria-expanded="${undetectedExpanded}" aria-controls="cliUndetectedList">
                    ${escapeHtml(t('cli.undetectedGroup', { count: undetectedCards.length }))}
                </button>
                <div id="cliUndetectedList"${undetectedExpanded ? '' : ' style="display:none"'}>${undetectedCards.join('')}</div>
            </div>
        `;
    }

    if (el) el.innerHTML = html;

    const allEntries = Object.entries(cliStatus);
    // While probes are failing we cannot tell ready from unready, so the
    // "no ready CLI" alarm would be exactly the false alarm #277 reports —
    // the runtime worked the whole time.
    const anyProbeUnavailable = allEntries.some(([, info]) => {
        const state = describeCliProbe(info);
        return state === 'probe-failing' || state === 'unknown';
    });
    const hasReadyCli = allEntries.some(([name, info]) => {
        if (describeCliProbe(info) !== 'ready') return false;
        const q = quota?.[name];
        return !q || q.authenticated !== false;
    });
    if (!hasReadyCli && !anyProbeUnavailable && allEntries.length > 0 && el) {
        el.insertAdjacentHTML('afterbegin',
            `<div style="padding:8px 10px;margin-bottom:8px;background:var(--warning-dim);border:1px solid var(--warning);border-radius:6px;font-size:11px;color:var(--warning)">
                ${ICONS.warning} ${t('cli.noReadyCli')}
            </div>`
        );
    }

    const undetectedToggle = document.getElementById('cliUndetectedToggle');
    if (undetectedToggle) {
        undetectedToggle.addEventListener('click', () => {
            const expanded = undetectedToggle.getAttribute('aria-expanded') !== 'true';
            undetectedToggle.setAttribute('aria-expanded', String(expanded));
            undetectedToggle.classList.toggle('expanded', expanded);
            const list = document.getElementById('cliUndetectedList');
            if (list) list.style.display = expanded ? 'block' : 'none';
            saveCliStatusUndetectedExpanded(expanded);
        });
    }

    const kcBtn = document.getElementById('copilotKeychainBtn');
    if (kcBtn) {
        kcBtn.addEventListener('click', async () => {
            const btn = kcBtn as HTMLButtonElement;
            btn.disabled = true;
            btn.innerHTML = ICONS.hourglass;
            try {
                const res = await api<{ ok: boolean }>('/api/copilot/refresh', { method: 'POST' });
                btn.innerHTML = res?.ok ? ICONS.check : ICONS.error;
                if (res?.ok) await loadCliStatus(true);
            } catch {
                btn.innerHTML = ICONS.error;
            }
            setTimeout(() => { btn.innerHTML = ICONS.key; btn.disabled = false; }, 2000);
        });
    }

    // Bind CLI setup help ? buttons (rendered as data-cli-help)
    if (el) {
        el.querySelectorAll<HTMLButtonElement>('[data-cli-help]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = btn.getAttribute('data-cli-help') || '';
                const desc = btn.getAttribute('data-cli-help-desc') || undefined;
                const linksRaw = btn.getAttribute('data-cli-help-links');
                let links: Array<{ label: string; url: string }> | undefined;
                if (linksRaw) {
                    try {
                        links = JSON.parse(linksRaw) as Array<{ label: string; url: string }>;
                    } catch {
                        links = undefined;
                    }
                }
                showCliHelpPopup(text, desc, links);
            });
        });
    }
}

function showCliHelpPopup(text: string, description?: string, links?: Array<{ label: string; url: string }>): void {
    const existing = document.getElementById('cliHelpOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cliHelpOverlay';
    overlay.className = 'mcp-help-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const inner = document.createElement('div');
    inner.className = 'mcp-help-inner';
    const lines = text.split('\n').filter(Boolean);
    const descHtml = description
        ? `<p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">${escapeHtml(description)}</p>`
        : '';
    const linksHtml = links?.length
        ? `<ul style="margin:0 0 10px 18px;padding:0;font-size:12px">${links.map(link =>
            `<li style="margin:4px 0"><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`
        ).join('')}</ul>`
        : '';
    inner.innerHTML = `
        <h4>CLI Setup</h4>
        ${descHtml}
        ${linksHtml}
        ${lines.map(l => `<p><code>${escapeHtml(l)}</code></p>`).join('')}
        <div style="text-align:right;margin-top:12px">
            <button type="button" class="btn-save" id="cliHelpClose">OK</button>
        </div>
    `;
    overlay.append(inner);
    document.body.append(overlay);
    inner.querySelector('#cliHelpClose')?.addEventListener('click', () => overlay.remove());
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc, true); }
    }, true);
}
