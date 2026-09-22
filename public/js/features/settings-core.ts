import { isRetiredCliSelection } from '../../../src/types/cli-engine.js';
import { preserveRetiredRuntimeOption } from './retired-runtime-option.js';
// ── Settings Core ──
import { MODEL_MAP, loadCliRegistry, getCliKeys, getCliMeta, PRIMARY_CLIS } from '../constants.js';
import type { CliEntry } from '../constants.js';
import { escapeHtml } from '../render.js';
import { syncStoredLocale } from '../locale.js';
import { t } from './i18n.js';
import { API_BASE, api, apiJson, apiFire, getAuthToken } from '../api.js';
import { shouldHydrateRuntimeMigrationResponse, type PerCliConfig, type SettingsData } from './settings-types.js';
import { setCachedPi } from './pi-settings.js';
import { providerIcon, providerLabel } from '../provider-icons.js';
import { postPreviewInvalidate } from '../preview-parent-origin.js';
import { formatProjectLabel } from './project-label.js';
import { loadHeaderGitStatus, refreshHeaderGitStatusFromSettingsChange } from './project-git-status.js';
import { applyPresentationSettings, beginPresentationRead } from './presentation-preference.js';

const activeSettingsSaves = new Set<Promise<void>>();
let configuredPermission: unknown;
let permissionSavePending = false;
let permissionRevision = 0;
let cliPickerReadGeneration = 0;
let cliPickerEditRevision = 0;

type MigrationResponse = SettingsData | { ok?: boolean; data?: SettingsData; settings?: SettingsData };

function unwrapMigrationSettings(payload: MigrationResponse | null): SettingsData | null {
    if (!payload || typeof payload !== 'object') return null;
    if ('settings' in payload && payload.settings) return payload.settings;
    if ('data' in payload && payload.data) return payload.data;
    return payload as SettingsData;
}

async function resolvePendingRuntimeMigration(snapshot: SettingsData): Promise<SettingsData> {
    if (snapshot.runtimeDefaultMigration?.state !== 'pending') return snapshot;
    const action = window.confirm('신규 설치의 기본 런타임이 Codex App으로 변경되었습니다. 지금 Codex App을 사용하시겠습니까?')
        ? 'accept'
        : 'keep';
    try {
        const token = await getAuthToken();
        const response = await fetch(`${API_BASE}/api/settings/runtime-default-migration`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ action }),
        });
        const payload = await response.json().catch(() => null) as MigrationResponse | null;
        if (shouldHydrateRuntimeMigrationResponse(response.status)) {
            return unwrapMigrationSettings(payload) ?? snapshot;
        }
        window.alert(`런타임 선택을 저장하지 못했습니다 (${response.status}). 다음 설정 진입 때 다시 안내합니다.`);
    } catch {
        window.alert('런타임 선택을 저장하지 못했습니다. 다음 설정 진입 때 다시 안내합니다.');
    }
    return snapshot;
}

async function resolvePendingMultiSessionMigration(snapshot: SettingsData): Promise<SettingsData> {
    if (snapshot.multiSessionDefaultMigration?.state !== 'pending') return snapshot;
    // The prompt names both halves because accepting applies both: sessions on, and a
    // second lane so a second tab does not queue behind the first. Turning it on without
    // the lane would change what the screen shows and nothing about how it runs.
    const action = window.confirm(
        '이제 대화 세션을 여러 개 열 수 있습니다. 켜면 동시 실행도 20으로 올라가서, 두 번째 세션이 첫 번째가 끝나기를 기다리지 않습니다. 지금 켤까요?',
    ) ? 'accept' : 'keep';
    try {
        const token = await getAuthToken();
        const response = await fetch(`${API_BASE}/api/settings/multi-session-default-migration`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ action }),
        });
        const payload = await response.json().catch(() => null) as MigrationResponse | null;
        if (shouldHydrateRuntimeMigrationResponse(response.status)) {
            return unwrapMigrationSettings(payload) ?? snapshot;
        }
        window.alert(`세션 선택을 저장하지 못했습니다 (${response.status}). 다음 설정 진입 때 다시 안내합니다.`);
    } catch {
        window.alert('세션 선택을 저장하지 못했습니다. 다음 설정 진입 때 다시 안내합니다.');
    }
    return snapshot;
}

function setHeaderCli(cli: string): void {
    const hdr = document.getElementById('headerCli');
    if (!hdr) return;
    const ico = providerIcon(cli);
    const label = cliDisplayLabel(cli);
    hdr.innerHTML = ico ? `${ico} ${escapeHtml(label)}` : escapeHtml(label);
}

function setHeaderProject(dirs: readonly string[] | null | undefined): void {
    const el = document.getElementById('headerProject');
    if (!el) return;
    ensureHeaderProjectPicker(el);
    el.hidden = false;
    const label = formatProjectLabel(dirs);
    if (!label) {
        el.classList.add('is-empty');
        el.textContent = 'Project: not set';
        el.title = 'Click to choose the project root folder';
        return;
    }
    el.classList.remove('is-empty');
    el.textContent = `Project ${label.text}`;
    el.title = `${label.title}\n(click to change)`;
}

// #233 follow-up: the label doubles as a button — the server opens the OS
// folder chooser (Finder) and applies the picked folder as projectDirs.
function ensureHeaderProjectPicker(el: HTMLElement): void {
    if (el.dataset['pickerBound']) return;
    el.dataset['pickerBound'] = '1';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    const pick = async (): Promise<void> => {
        if (el.classList.contains('is-picking')) return;
        el.classList.add('is-picking');
        const prevText = el.textContent;
        el.textContent = 'Choosing folder…';
        try {
            const result = await apiJson<{ projectDirs?: string[] | null; cancelled?: boolean }>('/api/project/pick', 'POST', {});
            if (result && !result.cancelled && 'projectDirs' in result) {
                el.classList.remove('is-picking');
                setHeaderProject(result.projectDirs);
                return;
            }
        } catch { /* fall through to restore */ }
        el.classList.remove('is-picking');
        el.textContent = prevText;
    };
    el.addEventListener('click', () => { void pick(); });
    el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); void pick(); }
    });
}

/** SSE settings_change payload → header-only refresh (#233). Never re-runs
 *  loadSettings(): the event may fire on every settings save. */
export function refreshHeaderFromSettingsChange(msg: { cli?: string; projectDirs?: string[] | null; changedKeys?: string[] }): void {
    if (typeof msg.cli === 'string' && msg.cli) setHeaderCli(msg.cli);
    if ('projectDirs' in msg) setHeaderProject(msg.projectDirs);
    refreshHeaderGitStatusFromSettingsChange(msg);
}

function cliDisplayLabel(cli: string): string {
    return getCliMeta(cli)?.label || providerLabel(cli) || cli;
}

function trackSettingsSave(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
        activeSettingsSaves.delete(tracked);
    });
    activeSettingsSaves.add(tracked);
    return tracked;
}

export async function waitForSettingsSaveIdle(): Promise<void> {
    while (activeSettingsSaves.size) await Promise.all(activeSettingsSaves);
}

function setSelectOptions(selectEl: HTMLSelectElement | null, values: string[], { includeCustom = false, includeDefault = false, selected = '' } = {}): void {
    if (!selectEl) return;
    const defaultHtml = includeDefault ? '<option value="default">default</option>' : '';
    const customHtml = includeCustom ? `<option value="__custom__">${t('model.customOption')}</option>` : '';
    const opts = (values || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    selectEl.innerHTML = defaultHtml + opts + customHtml;

    if (selected && Array.from(selectEl.options).some(o => o.value === selected)) {
        selectEl.value = selected;
    }
}

function appendCustomOption(selectEl: HTMLSelectElement | null, value: string): void {
    if (!selectEl || !value) return;
    if (Array.from(selectEl.options).some(o => o.value === value)) return;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    const customOpt = selectEl.querySelector('option[value="__custom__"]');
    if (customOpt) selectEl.insertBefore(opt, customOpt);
    else selectEl.appendChild(opt);
}

function syncCliOptionSelects(settings: SettingsData | null = null): void {
    const cliKeys = getCliKeys().filter(cli => !isRetiredCliSelection(cli));

    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (selCli) {
        const current = settings?.cli || selCli.value || cliKeys[0] || 'claude';
        const isPrimary = (cli: string) => PRIMARY_CLIS.includes(cli);
        const currentIsSecondary = !isPrimary(current) && cliKeys.includes(current);
        const wasExpanded = selCli.dataset['expanded'] === '1';
        const primary = cliKeys.filter(isPrimary);
        const secondary = cliKeys.filter(c => !isPrimary(c));
        const showAll = primary.length === 0 || currentIsSecondary || wasExpanded;

        let html = primary.map(cli => {
            const label = getCliMeta(cli)?.label || cli;
            return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
        }).join('');

        if (secondary.length > 0) {
            if (showAll) {
                html += '<option disabled>──────</option>';
                html += secondary.map(cli => {
                    const label = getCliMeta(cli)?.label || cli;
                    return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
                }).join('');
            } else {
                html += `<option value="__show_more__">${t('cli.showMore')}</option>`;
            }
        }
        selCli.innerHTML = html;
        selCli.title = isRetiredCliSelection(current) ? 'The saved runtime is retired and cannot execute.' : '';
        preserveRetiredRuntimeOption(selCli, current);
        if (Array.from(selCli.options).some(o => o.value === current)) selCli.value = current;
    }

    const flushCli = document.getElementById('flushCli') as HTMLSelectElement | null;
    if (flushCli) {
        const current = settings?.memory?.cli || flushCli.value || '';
        flushCli.innerHTML = '<option value="">(active CLI)</option>' +
            cliKeys.map(cli => `<option value="${escapeHtml(cli)}">${escapeHtml(cliDisplayLabel(cli))}</option>`).join('');
        preserveRetiredRuntimeOption(flushCli, current);
        if (Array.from(flushCli.options).some(o => o.value === current)) flushCli.value = current;
    }
}

function normalizeModelForDisplay(_cli: string, model: string): string {
    // Backend passes Claude model strings through unchanged so user-typed
    // pinned IDs (e.g. claude-opus-4-7) survive a refresh and reach
    // `claude --model` literally. The frontend just trims; it must not rewrite.
    return (model || '').trim();
}

/**
 * Effort choices for one model.
 *
 * A live opencodex catalog advertises a different effort set per model
 * (`gpt-5.6-sol` reaches `ultra`, `gpt-5.6-luna` stops at `max`, routed models
 * take none), and the chosen value is forwarded to the wire, so the per-model
 * set wins over the provider/registry lists. An entry that EXISTS but is empty
 * means "no effort for this model" and must not fall back.
 */
function resolveEffortChoices(
    meta: CliEntry | null,
    model: string,
    providerEfforts: string[] | null,
    provider?: string,
): string[] {
    const key = (model || '').trim();
    // Provider-scoped map wins for provider-split runtimes (ai-e): the same model
    // id can allow different efforts per provider. A missing model key falls back
    // to the provider list rather than inventing an empty "no effort" set.
    if (provider) {
        const scoped = meta?.effortsByModelByProvider?.[provider]?.[key];
        if (scoped) return scoped;
    }
    const byModel = meta?.effortsByModel?.[key];
    if (byModel) return byModel;
    return providerEfforts || meta?.efforts || [];
}

function resolveDefaultEffort(meta: CliEntry | null, model: string, provider?: string): string {
    const key = (model || '').trim();
    return (provider ? meta?.defaultEffortByModelByProvider?.[provider]?.[key] : undefined)
        ?? meta?.defaultEffortByModel?.[key]
        ?? '';
}

function getActiveEffortValue(): string {
    return (document.getElementById('selEffort') as HTMLSelectElement | null)?.value || '';
}

function syncActiveEffortOptions(cli: string, selected = '', model?: string): void {
    const selEffort = document.getElementById('selEffort') as HTMLSelectElement | null;
    if (!selEffort) return;
    const meta = getCliMeta(cli);
    const cliProvider = (cli !== 'pi' && meta?.providers?.length) ? getSelectedCliProvider(cli) : '';
    const providerEfforts = cliProvider
        ? (meta?.effortsByProvider?.[cliProvider] || [])
        : null;
    const activeModel = normalizeModelForDisplay(
        cli,
        model ?? (document.getElementById('selModel') as HTMLSelectElement | null)?.value ?? '',
    );
    const effortsList = resolveEffortChoices(meta, activeModel, providerEfforts, cliProvider || undefined);
    if (effortsList.length === 0) {
        const note = meta?.effortNote || '— none';
        selEffort.innerHTML = `<option value="">${escapeHtml(note)}</option>`;
        selEffort.title = note;
        selEffort.disabled = true;
        return;
    }
    const efforts = [''].concat(effortsList);
    const unique = [...new Set(efforts)];
    selEffort.innerHTML = unique.map(v => {
        if (!v) return '<option value="">— none</option>';
        return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
    }).join('');
    selEffort.disabled = false;
    selEffort.title = meta?.effortNote || '';
    // Coerce a saved effort the active model does not support, so the value that
    // reaches `-c model_reasoning_effort=` is always one the model advertises.
    const resolved = !selected || effortsList.includes(selected)
        ? selected
        : resolveDefaultEffort(meta, activeModel, cliProvider || undefined);
    if (Array.from(selEffort.options).some(o => o.value === resolved)) selEffort.value = resolved;
}

function syncAiEProviderOptions(select: HTMLSelectElement | null, current: string, providers: string[]): string {
    if (!select) return current;
    select.innerHTML = providers.map(provider => (
        `<option value="${escapeHtml(provider)}">${escapeHtml(providerLabel(provider) || provider)}</option>`
    )).join('');
    if (Array.from(select.options).some(o => o.value === current)) select.value = current;
    else if (select.options.length > 0) select.value = select.options[0]?.value || current;
    return select.value || current;
}

function getSelectedCliProvider(cli: string): string {
    const select = document.getElementById('selCliProvider') as HTMLSelectElement | null;
    const meta = getCliMeta(cli);
    return select?.value || meta?.defaultProvider || '';
}

function syncCliProviderControl(settings: SettingsData | null, cli: string): string {
    const wrap = document.getElementById('cliProviderWrap') as HTMLElement | null;
    const select = document.getElementById('selCliProvider') as HTMLSelectElement | null;
    const label = document.getElementById('cliProviderLabel') as HTMLElement | null;
    const meta = getCliMeta(cli);
    const hasProviders = cli !== 'pi' && (meta?.providers?.length ?? 0) > 0;
    if (!hasProviders) {
        if (wrap) wrap.style.display = 'none';
        return meta?.defaultProvider || '';
    }
    if (label) label.textContent = 'Provider';
    const current = settings?.perCli?.[cli]?.provider
        || select?.value
        || meta?.defaultProvider
        || '';
    const selected = syncAiEProviderOptions(select, current, meta!.providers!);
    if (wrap) wrap.style.display = '';
    return selected;
}

export async function loadSettings(): Promise<void> {
    const permissionRead = permissionRevision;
    await loadCliRegistry();
    const presentationRead = beginPresentationRead();
    let s = await api<SettingsData>('/api/settings');
    if (!s) return;
    applyPresentationSettings(s, presentationRead);
    s = await resolvePendingRuntimeMigration(s);
    // Runtime first, then sessions: which CLI runs is the earlier decision, and a v1
    // install has both pending at once. The second call takes the snapshot the first
    // returned — passing the pre-call one would write back over the answer just given.
    s = await resolvePendingMultiSessionMigration(s);
    syncStoredLocale(s.locale ?? '');
    syncCliOptionSelects(s);
    setCachedPi(s.pi);
    syncCliProviderControl(s, s.cli || '');

    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (selCli && Array.from(selCli.options).some(o => o.value === s.cli)) {
        selCli.value = s.cli;
        selCli.dataset['prev'] = s.cli;
    }
    const cwdEl = document.getElementById('inpCwd');
    if (cwdEl) cwdEl.textContent = s.workingDir;
    const headerEl = document.getElementById('headerCli');
    if (headerEl) {
        const icon = providerIcon(s.cli);
        const label = cliDisplayLabel(s.cli);
        headerEl.innerHTML = icon ? `${icon} ${escapeHtml(label)}` : escapeHtml(label);
    }
    setHeaderProject(s.projectDirs);
    await loadHeaderGitStatus();
    if (permissionRead === permissionRevision && !permissionSavePending) setPerm(s.permissions, false);

    onCliChange(false);
    const ao = s.activeOverrides?.[s.cli] || {};
    const pc = s.perCli?.[s.cli] || {};
    const activeModel = ao.model || pc.model;
    const activeEffort = ao.effort ?? pc.effort ?? '';
    const selModel = document.getElementById('selModel') as HTMLSelectElement | null;
    if (activeModel && selModel) {
        const displayModel = normalizeModelForDisplay(s.cli, activeModel);
        if (displayModel && !Array.from(selModel.options).some(o => o.value === displayModel)) {
            appendCustomOption(selModel, displayModel);
        }
        selModel.value = displayModel;
    }
    syncActiveEffortOptions(s.cli, activeEffort);
}

export async function updateSettings(): Promise<void> {
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const s: Record<string, unknown> = { cli };
    const activeMeta = getCliMeta(cli);
    if (cli !== 'pi' && activeMeta?.providers?.length) s['perCli'] = { [cli]: { provider: getSelectedCliProvider(cli) } };
    return trackSettingsSave((async () => {
        const result = await apiJson<SettingsData>('/api/settings', 'PUT', s);
        if (!result) {
            await loadSettings();
            return;
        }
        const confirmedCli = result.cli || cli;
        const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
        if (selCli && Array.from(selCli.options).some(o => o.value === confirmedCli)) {
            selCli.value = confirmedCli;
            selCli.dataset['prev'] = confirmedCli;
        }
        setHeaderCli(confirmedCli);
        postPreviewInvalidate(['instances'], 'active-cli-changed');
    })());
}

function configuredPermLabel(value: unknown): string {
    if (value === 'auto') return 'Auto (YOLO)';
    if (value === 'safe') return 'Safe';
    if (value === null || value === undefined) return 'Not provided';
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string'))
        return `Custom (${value.length} ${value.length === 1 ? 'entry' : 'entries'})`;
    return 'Unrecognized';
}

function renderConfiguredPermission(): void {
    const p = configuredPermission;
    const label = configuredPermLabel(p);
    const text = document.getElementById('configuredPermText');
    if (text) text.textContent = `Configured policy: ${label}`;
    const badge = document.getElementById('configuredPerm');
    badge?.classList.toggle('active', p === 'auto');
    badge?.classList.toggle('perm-auto', p === 'auto');
    const select = document.getElementById('selPerm') as HTMLSelectElement | null;
    if (select) {
        select.options[0].textContent = `Configured policy: ${label}`;
        select.value = p === 'auto' || p === 'safe' ? p : '';
        select.disabled = permissionSavePending;
        select.setAttribute('aria-busy', String(permissionSavePending));
    }
}

export async function setPerm(p: unknown, save = true): Promise<void> {
    if (!save) {
        configuredPermission = p;
        renderConfiguredPermission();
        return;
    }
    if ((p !== 'auto' && p !== 'safe') || p === configuredPermission || permissionSavePending) return;
    permissionSavePending = true;
    permissionRevision++;
    renderConfiguredPermission();
    const error = document.getElementById('permSaveError');
    if (error) { error.hidden = true; error.textContent = ''; }
    return trackSettingsSave((async () => {
        try {
            const result = await apiJson<SettingsData>('/api/settings', 'PUT', { permissions: p });
            if (!result) throw new Error('Permission settings save failed');
            configuredPermission = result.permissions;
        } catch {
            if (error) {
                error.textContent = 'Could not save permissions. Please try again.';
                error.hidden = false;
            }
        } finally {
            permissionSavePending = false;
            // Also invalidate reads started during the write, before it committed.
            permissionRevision++;
            renderConfiguredPermission();
        }
    })());
}

export function onCliChange(save = true): void {
    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (!selCli) return;
    const readGeneration = ++cliPickerReadGeneration;
    if (selCli.value === '__show_more__') {
        const prev = selCli.dataset['prev'] || getCliKeys()[0] || 'claude';
        selCli.dataset['expanded'] = '1';
        syncCliOptionSelects(null);
        if (Array.from(selCli.options).some(o => o.value === prev)) selCli.value = prev;
        try { selCli.showPicker(); } catch { /* user-gesture guard */ }
        return;
    }
    selCli.dataset['prev'] = selCli.value;
    const cli = selCli.value || 'claude';
    if (!isRetiredCliSelection(cli)) selCli.title = '';
    const cliProvider = syncCliProviderControl(null, cli);
    const meta = getCliMeta(cli);
    const models = cliProvider && meta?.modelsByProvider?.[cliProvider]
        ? meta.modelsByProvider[cliProvider]
        : (MODEL_MAP[cli] || []);
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    if (isRetiredCliSelection(cli)) {
        if (modelSel) { modelSel.disabled = true; modelSel.title = 'The saved runtime is retired and cannot execute.'; }
        setHeaderCli(cli);
        syncActiveEffortOptions(cli);
        return;
    }
    if (meta?.modelNote && modelSel) {
        modelSel.innerHTML = `<option value="">${escapeHtml(meta.modelNote)}</option>`;
        modelSel.title = meta.modelNote;
        modelSel.disabled = true;
    } else {
        setSelectOptions(modelSel, models, { includeCustom: true, includeDefault: true });
        if (modelSel) { modelSel.disabled = false; modelSel.title = ''; }
    }
    setHeaderCli(cli);
    syncActiveEffortOptions(cli);

    const oldInput = document.getElementById('selModelCustom');
    if (oldInput) oldInput.remove();
    const inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'selModelCustom';
    inp.className = 'custom-model-input';
    inp.placeholder = t('model.placeholder');
    inp.style.display = 'none';
    inp.oninput = () => { cliPickerEditRevision++; };
    inp.onchange = function () {
        const val = (this as HTMLInputElement).value.trim();
        if (!val || !modelSel) return;
        appendCustomOption(modelSel, val);
        modelSel.value = val;
        (this as HTMLInputElement).style.display = 'none';
        // A custom model has no advertised effort set; re-resolve so the picker
        // falls back to the registry list instead of keeping the old model's.
        syncActiveEffortOptions(cli, getActiveEffortValue(), val);
        saveActiveCliSettings();
    };
    if (!modelSel) { if (save) updateSettings(); return; }
    modelSel.parentElement?.appendChild(inp);
    modelSel.onchange = function () {
        if ((this as HTMLSelectElement).value === '__custom__') {
            inp.style.display = 'block';
            inp.focus();
        } else {
            inp.style.display = 'none';
            // Efforts are per-model on a live opencodex catalog, so the picker
            // must follow the model rather than keep the previous model's set.
            syncActiveEffortOptions(cli, getActiveEffortValue(), (this as HTMLSelectElement).value);
            saveActiveCliSettings();
        }
    };

    const readEditRevision = cliPickerEditRevision;
    const providerSel = document.getElementById('selCliProvider');
    const effortSel = document.getElementById('selEffort');
    api<SettingsData>('/api/settings').then(s => {
        if (!s
            || readGeneration !== cliPickerReadGeneration
            || readEditRevision !== cliPickerEditRevision
            || document.getElementById('selCli') !== selCli
            || selCli.value !== cli
            || document.getElementById('selCliProvider') !== providerSel
            || document.getElementById('selModel') !== modelSel
            || document.getElementById('selModelCustom') !== inp
            || document.getElementById('selEffort') !== effortSel
            || ((meta?.providers?.length ?? 0) > 0 && getSelectedCliProvider(cli) !== cliProvider)) return;
        const ao = s.activeOverrides?.[cli] || {};
        const pc = s.perCli?.[cli] || {};
        const model = ao.model || pc.model;
        const effort = ao.effort ?? pc.effort ?? '';
        if (cli !== 'pi' && meta?.providers?.length) {
            const savedProvider = pc.provider || meta.defaultProvider || '';
            if (savedProvider !== cliProvider) return;
        }
        if (model && modelSel) {
            const displayModel = normalizeModelForDisplay(cli, model);
            appendCustomOption(modelSel, displayModel);
            modelSel.value = displayModel;
        }
        syncActiveEffortOptions(cli, effort);
    });

    if (save) updateSettings();
}

export async function saveActiveCliSettings(): Promise<void> {
    cliPickerEditRevision++;
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    let model = modelSel?.value || 'default';
    if (model === '__custom__') {
        model = (document.getElementById('selModelCustom') as HTMLInputElement | null)?.value?.trim() || 'default';
    }
    const effortEl = document.getElementById('selEffort') as HTMLSelectElement | null;
    const overrides: Record<string, PerCliConfig> = {};
    overrides[cli] = { model };
    if (effortEl && !effortEl.disabled) overrides[cli].effort = effortEl.value || '';
    const patch: Record<string, unknown> = { activeOverrides: overrides };
    const patchMeta = getCliMeta(cli);
    if (cli !== 'pi' && patchMeta?.providers?.length) patch['perCli'] = { [cli]: { provider: getSelectedCliProvider(cli) } };
    if (await apiJson('/api/settings', 'PUT', patch)) {
        postPreviewInvalidate(['instances'], 'active-cli-changed');
    }
}

// ── Flush Agent Sidebar ──

export function onFlushCliChange(): void {
    const flushCli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const effectiveCli = flushCli || (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[effectiveCli] || [];
    const flushModelSel = document.getElementById('flushModel') as HTMLSelectElement | null;
    setSelectOptions(flushModelSel, models, { includeDefault: true });
    updateFlushBadge();
    saveFlushAgentSettings();
}

export async function loadFlushAgentSidebar(): Promise<void> {
    const data = await api<{ cli?: string; model?: string }>('/api/memory-files');
    if (!data) return;
    const flushCliSel = document.getElementById('flushCli') as HTMLSelectElement | null;
    const flushModelSel = document.getElementById('flushModel') as HTMLSelectElement | null;
    if (flushCliSel && data.cli) flushCliSel.value = data.cli;

    const effectiveCli = data.cli || (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[effectiveCli] || [];
    setSelectOptions(flushModelSel, models, { includeDefault: true });
    if (flushModelSel && data.model) {
        appendCustomOption(flushModelSel, data.model);
        flushModelSel.value = data.model;
    }
    updateFlushBadge();
}

async function saveFlushAgentSettings(): Promise<void> {
    const cli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const model = (document.getElementById('flushModel') as HTMLSelectElement)?.value || '';
    await apiJson('/api/memory-files/settings', 'PUT', { cli, model });
}

function updateFlushBadge(): void {
    const badge = document.getElementById('flushAgentBadge');
    if (!badge) return;
    const cli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const model = (document.getElementById('flushModel') as HTMLSelectElement)?.value || '';
    const effectiveCli = cli || (document.getElementById('selCli') as HTMLSelectElement)?.value || '';
    const parts: string[] = [];
    if (effectiveCli) parts.push(cli ? cliDisplayLabel(effectiveCli) : `${cliDisplayLabel(effectiveCli)}*`);
    if (model && model !== 'default') parts.push(model);
    badge.textContent = parts.length ? `(${parts.join(' / ')})` : '';
}
