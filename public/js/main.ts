// ── App Entry Point ──
// All event bindings happen here (no inline onclick in HTML). CSS imports are bundled by Vite.
import 'katex/dist/katex.min.css';

const STALE_BUNDLE_RELOAD_KEY = 'jaw:stale-bundle-reload-pending';
function recoverFromStaleBundle(error: unknown): boolean {
    const message = typeof error === 'string' ? error
        : error instanceof Error ? error.message
        : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message
        : '';
    if (!/(failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|chunkloaderror)/i.test(message)) return false;
    console.warn('[stale-bundle] detected dynamic import failure:', message);
    try { if (sessionStorage.getItem(STALE_BUNDLE_RELOAD_KEY) === '1') return true; sessionStorage.setItem(STALE_BUNDLE_RELOAD_KEY, '1'); } catch {}
    const reload = () => window.location.reload();
    if ('serviceWorker' in navigator) {
        void navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {}).finally(reload);
        return true;
    }
    reload();
    return true;
}

// ── Global Error Boundary ──
window.addEventListener('unhandledrejection', (e) => {
    if (recoverFromStaleBundle(e.reason)) {
        e.preventDefault();
        return;
    }
    console.error('[unhandled]', e.reason);
    e.preventDefault();
});
window.addEventListener('error', (e) => {
    if (recoverFromStaleBundle(e.error || e.message)) {
        e.preventDefault();
        return;
    }
    console.error('[error]', e.message, e.filename, e.lineno);
});

import { connect, reopenChannel } from './ws.js';
import { switchTab, handleSave, loadMessages, initMsgCopy } from './ui.js';
import { prewarmMermaid } from './render.js';
import { sendMessage, handleKey, clearAttachedFiles, removeAttachedFile, clearChat, initDragDrop, initAutoResize } from './features/chat.js';
import {
    loadCommands, update as updateSlashDropdown, handleKeydown as handleSlashKeydown,
    handleClick as handleSlashClick, handleOutsideClick as handleSlashOutsideClick,
} from './features/slash-commands.js';
import { toggleSkill, filterSkills, searchSkills } from './features/skills.js';
import {
    loadSettings, setPerm, onCliChange,
    saveActiveCliSettings, openPromptModal, initSettingsFrame, toggleSettingsPage,
    onFlushCliChange, loadFlushAgentSidebar,
    closePromptModal, savePromptFromModal, syncMcpServers, installMcpGlobal,
    openMcpModal, initMcpModal,
    loadCliStatus, scheduleCliStatusRefresh, setCliStatusInterval,
    initCliStatusToggle, initCliStatusPreviewHooks, isCliStatusExpanded, expandCliStatus, isEmbeddedPreviewFrame,
    openTemplateModal, saveTemplateFromModal, closeTemplateModal, templateGoBack, toggleDevMode
} from './features/settings.js';
import { initChannelOnboarding } from './features/channel-onboarding.js';
const {
    loadEmployees, addEmployee, deleteEmployee, updateEmployee,
    onEmpCliChange, onEmpRoleChange
} = await import('./features/employees.js');
import {
    openHeartbeatModal, closeHeartbeatModal, addHeartbeatJob,
    removeHeartbeatJob, renderHeartbeatJobs, toggleHeartbeatJob, saveHeartbeatJobs,
    initHeartbeatBadge
} from './features/heartbeat.js';
import {
    openMemoryModal, closeMemoryModal, switchMemTab, setMemEnabled,
    saveMemSettings, deleteMemFile, viewMemFile,
    rerunAdvancedBootstrap, reindexAdvancedMemory, upgradeSoulMemory, synthesizeSoul, openCorruptedFolder,
    bindAdvancedProviderUi, triggerFlushNow, refreshMemorySidebar
} from './features/memory.js';
import { state } from './state.js';
import { loadCliRegistry } from './constants.js';
import { initAppName } from './features/appname.js';
import { initAvatar } from './features/avatar.js';
import { initSidebar, toggleLeft, toggleRight } from './features/sidebar.js';
import { initResizeGuard } from './features/resize-guard.js';
import { initTheme } from './features/theme.js';
import { initPreviewShortcutBridge } from './features/preview-shortcut-bridge.js';
import { ensurePreviewCapabilityListener, ensurePreviewInsertTextListener } from './preview-parent-origin.js';
import { initGestures } from './features/gesture.js';
import { initI18n, setLang, getLang, t } from './features/i18n.js';
import { toggleRecording, cancelRecording } from './features/voice-recorder.js';
import { hydrateIcons } from './icons.js';
import { hydrateProviderIcons } from './provider-icons.js';
import { initPendingQueue } from './features/pending-queue.js';
import { initBgtaskBadge } from './features/bgtask-badge.js';
import { initAttentionBadge } from './features/attention-badge.js';
import { initHelpDialog } from './features/help-dialog.js';
import { initChatSearch, toggleChatSearch, closeChatSearch } from './features/chat-search.js';
import { initMediaLightbox } from './features/media-lightbox.js';
import { currentEventScope, initializeSessionView } from './features/session-hub.js';
import { setEventChannelScopeProvider } from './event-channel.js';

function isLocalPreviewOrigin(origin: string): boolean {
    if (origin === window.location.origin) return true;
    try {
        const hostname = new URL(origin).hostname;
        return hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]';
    } catch {
        return false;
    }
}

function isVoiceRecordingShortcut(e: KeyboardEvent): boolean {
    const primarySpace = (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space';
    const fallbackMic = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyM';
    return primarySpace || fallbackMic;
}

// ── Chat Actions ──
document.getElementById('btnSend')?.addEventListener('click', () => { void sendMessage('button'); });
const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement | null;
chatInput?.addEventListener('keydown', (e) => {
    if (handleSlashKeydown(e as KeyboardEvent)) return;
    handleKey(e as KeyboardEvent);
});
let slashInputRaf = 0;
chatInput?.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing) return;
    if (slashInputRaf) cancelAnimationFrame(slashInputRaf);
    slashInputRaf = requestAnimationFrame(() => {
        updateSlashDropdown((e.target as HTMLTextAreaElement)?.value || '');
        slashInputRaf = 0;
    });
});
chatInput?.addEventListener('cmd-execute', () => {
    void sendMessage('cmd-execute');
});
document.getElementById('cmdDropdown')?.addEventListener('click', handleSlashClick);
document.addEventListener('click', handleSlashOutsideClick);
initPendingQueue();
initBgtaskBadge();
document.getElementById('filePreviewClear')?.addEventListener('click', clearAttachedFiles);
document.getElementById('filePreviewList')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest('[data-file-idx]') as HTMLElement | null;
    if (btn) removeAttachedFile(+(btn.dataset['fileIdx'] || '0'));
});
document.querySelector('.btn-attach')?.addEventListener('click', () => {
    (document.getElementById('fileInput') as HTMLInputElement | null)?.click();
});
document.getElementById('btnVoice')?.addEventListener('click', () => toggleRecording());
document.getElementById('btnVoiceCancel')?.addEventListener('click', () => cancelRecording());
window.addEventListener('message', (event) => {
    if (window.parent === window) return;
    if (event.source !== window.parent) return;
    if (!isLocalPreviewOrigin(event.origin)) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== 'jaw-preview-stt-toggle') return;
    toggleRecording();
});

// ── Left Sidebar ──
document.getElementById('memorySidebarBtn')?.addEventListener('click', openMemoryModal);
document.getElementById('btnClearChat')?.addEventListener('click', clearChat);
document.getElementById('hbSidebarBtn')?.addEventListener('click', openHeartbeatModal);

// Language dropdown
document.getElementById('langSelect')?.addEventListener('change', async (e) => {
    const next = (e.target as HTMLSelectElement).value;
    if (!['ko', 'en', 'zh', 'ja'].includes(next)) return;
    await setLang(next);
    // Reopen the event channel with the new locale (Phase 3: SSE)
    reopenChannel();
});

// ── Tab Bar (event delegation) ──
document.querySelector('.tab-bar')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest('.tab-btn') as HTMLElement | null;
    if (!btn) return;
    const tabs = [...(btn.parentElement?.children || [])].filter(c => c.classList.contains('tab-btn'));
    const idx = tabs.indexOf(btn);
    const names = ['agents', 'skills'];
    if (names[idx]) switchTab(names[idx], btn);
});
// Roving tab order: ArrowLeft/ArrowRight move between the right-panel tabs (WAI-ARIA tabs pattern).
document.querySelector('.tab-bar')?.addEventListener('keydown', (e) => {
    const event = e as KeyboardEvent;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const current = (event.target as HTMLElement)?.closest('.tab-btn') as HTMLElement | null;
    if (!current) return;
    const tabs = [...(current.parentElement?.children || [])].filter(c => c.classList.contains('tab-btn')) as HTMLElement[];
    const next = tabs[(tabs.indexOf(current) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
});

document.getElementById('btnSettings')?.addEventListener('click', () => toggleSettingsPage());

// ── Save Button ──
document.querySelector('.sidebar-save-bar .btn-save')?.addEventListener('click', handleSave);

// ── Agents Tab ──
document.getElementById('selCli')?.addEventListener('change', () => onCliChange());
document.getElementById('selCliProvider')?.addEventListener('change', () => {
    onCliChange();
    saveActiveCliSettings();
});
document.getElementById('selModel')?.addEventListener('change', () => saveActiveCliSettings());
document.getElementById('selEffort')?.addEventListener('change', () => saveActiveCliSettings());
document.getElementById('selPerm')?.addEventListener('change', (event) => {
    void setPerm((event.target as HTMLSelectElement).value);
});
document.getElementById('flushCli')?.addEventListener('change', () => onFlushCliChange());
document.getElementById('flushModel')?.addEventListener('change', () => onFlushCliChange());
document.querySelector('[data-action="addEmployee"]')?.addEventListener('click', addEmployee);

// ── Employees (Event Delegation) ──
document.getElementById('employeesList')?.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement)?.closest('[data-emp-delete]') as HTMLElement | null;
    if (del) { deleteEmployee(del.dataset['empDelete'] || ''); return; }
});
document.getElementById('employeesList')?.addEventListener('change', (e) => {
    const tgt = e.target as HTMLSelectElement;
    const name = tgt.closest('[data-emp-name]') as HTMLElement | null;
    if (name) { updateEmployee(name.dataset['empName'] || '', { name: tgt.value }); return; }
    const cli = tgt.closest('[data-emp-cli]') as HTMLElement | null;
    if (cli) { onEmpCliChange(cli.dataset['empCli'] || '', tgt.value); return; }
    const model = tgt.closest('[data-emp-model]') as HTMLElement | null;
    if (model) {
        if (tgt.value === '__custom__') {
            const val = prompt(t('model.promptInput'));
            if (val?.trim()) {
                const opt = document.createElement('option');
                opt.value = val.trim(); opt.textContent = val.trim();
                const customOpt = tgt.querySelector('option[value="__custom__"]');
                if (customOpt) tgt.insertBefore(opt, customOpt);
                tgt.value = val.trim();
                updateEmployee(model.dataset['empModel'] || '', { model: val.trim() });
            } else { tgt.value = 'default'; }
        } else { updateEmployee(model.dataset['empModel'] || '', { model: tgt.value }); }
        return;
    }
    const role = tgt.closest('[data-emp-role]') as HTMLElement | null;
    if (role) { onEmpRoleChange(role.dataset['empRole'] || '', tgt.value); return; }
    const custom = tgt.closest('[data-emp-custom]') as HTMLElement | null;
    if (custom) { updateEmployee(custom.dataset['empCustom'] || '', { role: tgt.value }); return; }
});

// ── Skills Tab (Event Delegation) ──
document.getElementById('skillsList')?.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement)?.closest('[data-skill-id]') as HTMLElement | null;
    if (toggle) {
        toggleSkill(toggle.dataset['skillId'] || '', toggle.dataset['skillEnabled'] === 'true');
    }
});
// Skill filter buttons (event delegation)
document.querySelector('#tabSkills')?.addEventListener('click', (e) => {
    const filterBtn = (e.target as HTMLElement)?.closest('.skill-filter') as HTMLElement | null;
    if (filterBtn) {
        const cat = filterBtn.dataset['filter'] || 'all';
        filterSkills(cat, filterBtn);
    }
});
document.getElementById('skillSearchInput')?.addEventListener('input', (e) => {
    searchSkills((e.target as HTMLInputElement).value);
});

// ── Settings Tab ──
document.querySelector('[data-action="openPrompt"]')?.addEventListener('click', openPromptModal);
initChannelOnboarding();
const disposeSettingsFrame = initSettingsFrame();
if (import.meta.hot) import.meta.hot.dispose(disposeSettingsFrame);

// MCP
document.querySelector('[data-action="openMcpModal"]')?.addEventListener('click', openMcpModal);
document.querySelector('[data-action="syncMcp"]')?.addEventListener('click', syncMcpServers);
document.querySelector('[data-action="installMcp"]')?.addEventListener('click', installMcpGlobal);
initMcpModal();
document.querySelector('[data-action="refreshCli"]')?.addEventListener('click', () => {
    if (!isCliStatusExpanded()) expandCliStatus();
    else loadCliStatus(true);
});
document.getElementById('cliStatusInterval')?.addEventListener('change', function (this: HTMLSelectElement) {
    setCliStatusInterval(this.value);
});

// ── Prompt Modal ──
document.getElementById('promptModal')?.addEventListener('click', (e) => closePromptModal(e));
document.querySelector('#promptModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closePrompt"]')?.addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="cancelPrompt"]')?.addEventListener('click', () => closePromptModal());
document.querySelector('[data-action="savePrompt"]')?.addEventListener('click', savePromptFromModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !state.isRecording) closePromptModal(); });

// ── Template Modal ──
document.querySelector('[data-action="openTemplates"]')?.addEventListener('click', openTemplateModal);
document.querySelector('[data-action="saveTemplate"]')?.addEventListener('click', saveTemplateFromModal);
document.querySelector('[data-action="closeTemplate"]')?.addEventListener('click', () => closeTemplateModal());
document.getElementById('templateModal')?.addEventListener('click', (e) => closeTemplateModal(e));
document.querySelector('#templateModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.getElementById('templateBack')?.addEventListener('click', templateGoBack);
document.getElementById('templateDevToggle')?.addEventListener('click', toggleDevMode);

// ── Pi Settings Modal ──
const { openPiSettingsModal, closePiSettingsModal, registerPiProfile, onPiModeChange } = await import('./features/pi-settings.js');
document.getElementById('btnPiSettings')?.addEventListener('click', openPiSettingsModal);
document.getElementById('piSettingsModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closePiSettingsModal(); });
document.querySelector('#piSettingsModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closePiSettings"]')?.addEventListener('click', closePiSettingsModal);
document.getElementById('btnPiRegister')?.addEventListener('click', () => void registerPiProfile());
document.getElementById('piMode')?.addEventListener('change', onPiModeChange);
// ── Heartbeat Modal ──
document.getElementById('heartbeatModal')?.addEventListener('click', (e) => closeHeartbeatModal(e));
document.querySelector('#heartbeatModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeHeartbeat"]')?.addEventListener('click', () => closeHeartbeatModal());
document.querySelector('[data-action="addHeartbeat"]')?.addEventListener('click', addHeartbeatJob);

// Heartbeat jobs (event delegation)
document.getElementById('hbJobsList')?.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement)?.closest('[data-hb-toggle]') as HTMLElement | null;
    if (toggle) { toggleHeartbeatJob(+(toggle.dataset['hbToggle'] || '0')); return; }
    const remove = (e.target as HTMLElement)?.closest('[data-hb-remove]') as HTMLElement | null;
    if (remove) { removeHeartbeatJob(+(remove.dataset['hbRemove'] || '0')); return; }
});
document.getElementById('hbJobsList')?.addEventListener('change', (e) => {
    const tgt = e.target as HTMLInputElement | HTMLSelectElement;
    const name = tgt.closest('[data-hb-name]') as HTMLElement | null;
    if (name) { state.heartbeatJobs[+(name.dataset['hbName'] || '0')].name = tgt.value; saveHeartbeatJobs(); return; }
    const kind = tgt.closest('[data-hb-kind]') as HTMLElement | null;
    if (kind) {
        const i = +(kind.dataset['hbKind'] || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const timeZone = typeof current?.['timeZone'] === 'string' ? current['timeZone'] : undefined;
        state.heartbeatJobs[i].schedule = tgt.value === 'cron'
            ? { kind: 'cron', cron: typeof current?.['cron'] === 'string' && current['cron'].trim() ? current['cron'] : '0 9 * * *', ...(timeZone ? { timeZone } : {}) }
            : { kind: 'every', minutes: typeof current?.['minutes'] === 'number' && current['minutes'] > 0 ? Math.floor(current['minutes']) : 5, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const min = tgt.closest('[data-hb-minutes]') as HTMLElement | null;
    if (min) {
        const i = +(min.dataset['hbMinutes'] || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const minutes = Math.max(1, Math.floor(Number(tgt.value) || 5));
        const timeZone = typeof current?.['timeZone'] === 'string' ? current['timeZone'] : undefined;
        state.heartbeatJobs[i].schedule = { kind: 'every', minutes, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const cron = tgt.closest('[data-hb-cron]') as HTMLElement | null;
    if (cron) {
        const i = +(cron.dataset['hbCron'] || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        const timeZone = typeof current?.['timeZone'] === 'string' ? current['timeZone'] : undefined;
        const cronExpr = tgt.value.trim().replace(/\s+/g, ' ');
        state.heartbeatJobs[i].schedule = { kind: 'cron', cron: cronExpr, ...(timeZone ? { timeZone } : {}) };
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const timeZone = tgt.closest('[data-hb-timezone]') as HTMLElement | null;
    if (timeZone) {
        const i = +(timeZone.dataset['hbTimezone'] || '0');
        const current = state.heartbeatJobs[i]?.schedule as Record<string, unknown> | undefined;
        if (current?.['kind'] === 'cron') {
            state.heartbeatJobs[i].schedule = {
                kind: 'cron',
                cron: typeof current['cron'] === 'string' && current['cron'].trim() ? current['cron'] : '0 9 * * *',
                ...(tgt.value.trim() ? { timeZone: tgt.value.trim() } : {}),
            };
        } else {
            state.heartbeatJobs[i].schedule = {
                kind: 'every',
                minutes: typeof current?.['minutes'] === 'number' && current['minutes'] > 0 ? Math.floor(current['minutes']) : 5,
                ...(tgt.value.trim() ? { timeZone: tgt.value.trim() } : {}),
            };
        }
        renderHeartbeatJobs();
        saveHeartbeatJobs();
        return;
    }
    const prompt = tgt.closest('[data-hb-prompt]') as HTMLElement | null;
    if (prompt) { state.heartbeatJobs[+(prompt.dataset['hbPrompt'] || '0')].prompt = tgt.value; saveHeartbeatJobs(); return; }
});

// ── Memory Modal ──
document.getElementById('memoryModal')?.addEventListener('click', (e) => closeMemoryModal(e));
document.querySelector('#memoryModal .modal-box')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelector('[data-action="closeMemory"]')?.addEventListener('click', () => closeMemoryModal());
document.getElementById('memTabBtnSettings')?.addEventListener('click', () => switchMemTab('settings'));
document.getElementById('memTabBtnAdvOps')?.addEventListener('click', () => switchMemTab('status'));
document.getElementById('memTabBtnFiles')?.addEventListener('click', () => switchMemTab('files'));
document.getElementById('memOn')?.addEventListener('click', () => setMemEnabled(true));
document.getElementById('memOff')?.addEventListener('click', () => setMemEnabled(false));
document.getElementById('memFlushEvery')?.addEventListener('change', saveMemSettings);
document.getElementById('memRetention')?.addEventListener('change', saveMemSettings);
document.getElementById('memFlushLang')?.addEventListener('change', saveMemSettings);
document.getElementById('memFlushNowBtn')?.addEventListener('click', triggerFlushNow);
document.getElementById('advBootstrapBtn')?.addEventListener('click', rerunAdvancedBootstrap);
document.getElementById('advReindexBtn')?.addEventListener('click', reindexAdvancedMemory);
document.getElementById('advReimportBtn')?.addEventListener('click', rerunAdvancedBootstrap);
document.getElementById('advOpenCorruptedBtn')?.addEventListener('click', openCorruptedFolder);
document.getElementById('advStatusBanner')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'advUpgradeSoulBtn') upgradeSoulMemory();
    if ((e.target as HTMLElement)?.id === 'advSynthesizeSoulBtn') synthesizeSoul();
});
bindAdvancedProviderUi();

// Memory files (event delegation)
document.getElementById('basicMemoryFiles')?.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement)?.closest('[data-mem-delete]') as HTMLElement | null;
    if (del) { e.stopPropagation(); deleteMemFile(del.dataset['memDelete'] || ''); return; }
    const view = (e.target as HTMLElement)?.closest('[data-mem-view]') as HTMLElement | null;
    if (view) { viewMemFile(view.dataset['memView'] || ''); return; }
    const back = (e.target as HTMLElement)?.closest('[data-mem-back]');
    if (back) { openMemoryModal(); return; }
});

// ── Init ──
async function bootstrap(): Promise<void> {
    hydrateIcons();
    hydrateProviderIcons();
    initTheme();
    initPreviewShortcutBridge();
    ensurePreviewCapabilityListener();
    ensurePreviewInsertTextListener();
    await initI18n();
    const sessionMode = await initializeSessionView({ cancelRecording });
    if (sessionMode === 'redirect') return;
    // Must run before either connect() below: the channel reads this on every
    // (re)connect, and an unregistered provider opens an unfiltered stream that
    // would carry other sessions' output into this tab.
    setEventChannelScopeProvider(currentEventScope);
    const langSel = document.getElementById('langSelect') as HTMLSelectElement | null;
    if (langSel) langSel.value = getLang();
    initHelpDialog();
    if (sessionMode === 'hub') {
        // The hub has no chat surface, but the badge/help listeners are part of
        // the documented boot order (AB-003 / HD-002): they must be installed
        // before connect() regardless of which view is rendering.
        initAttentionBadge();
        connect();
        return;
    }
    initChatSearch();
    initMediaLightbox();
    document.getElementById('chatSearchTrigger')?.addEventListener('click', toggleChatSearch);
    initAttentionBadge();
    // Connect early: channel-up drives
    // loadMessages(), which only needs i18n + the badge/help listeners above —
    // the CLI-registry fetch below used to serially delay first history paint.
    connect();
    await loadCliRegistry();
    initDragDrop();
    initAutoResize();
    await loadCommands();
    await loadSettings();
    loadFlushAgentSidebar();
    scheduleCliStatusRefresh();
    initCliStatusToggle();
    initCliStatusPreviewHooks();
    if (isCliStatusExpanded()) loadCliStatus();
    // loadMessages() is handled by ws.js onopen (clear + reload)
    initSidebar();
    initResizeGuard();
    loadEmployees();
    initHeartbeatBadge();
    void refreshMemorySidebar();
    initAppName();
    await initAvatar();
    initMsgCopy();
    initGestures();
    if (window.location.hash === '#settings') {
        toggleSettingsPage(true);
    }
    try { sessionStorage.removeItem(STALE_BUNDLE_RELOAD_KEY); } catch {}

    // Phase 127-F2: prewarm Mermaid at idle so first diagram renders fast.
    // 260705_frontend_perf M6: check AFTER history has had a chance to load
    // (channel-up → loadMessages is async) and only prewarm when the DOM
    // actually contains a diagram candidate — otherwise skip the chunk fetch.
    // renderMermaidBlocks still lazy-loads on demand if a diagram streams in.
    setTimeout(() => {
        if (document.querySelector('.mermaid-pending, [data-mermaid-code-raw], .diagram-widget-pending')) {
            prewarmMermaid();
        }
    }, 3000);

    // Register Service Worker (production only — Vite HMR handles dev; skip embedded dashboard preview iframes)
    if ('serviceWorker' in navigator && !import.meta.env.DEV && !isEmbeddedPreviewFrame()) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
}

void bootstrap().catch((err: unknown) => {
    console.error('[bootstrap]', err);
});

// ── Keyboard: Ctrl+F chat search (capture phase beats Chrome's native find) ──
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        toggleChatSearch();
    }
}, true);

// ── Keyboard: Escape closes modals ──────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.body.dataset['settingsOpen'] === 'true') {
            e.preventDefault(); toggleSettingsPage(false); return;
        }
        if (document.getElementById('chatSearch')?.classList.contains('open')) {
            e.preventDefault();
            closeChatSearch();
            return;
        }
        if (state.isRecording) {
            e.preventDefault();
            cancelRecording();
            return;
        }
        document.querySelectorAll('.modal-overlay.open').forEach(m => {
            m.classList.remove('open');
        });
    }
    // Ctrl+Shift+Space (Win/Linux), Cmd+Shift+Space (Mac), or Alt/Option+M toggles voice recording.
    if (isVoiceRecordingShortcut(e)) {
        e.preventDefault();
        toggleRecording();
    }
});

// ── Mobile sidebar toggle (sidebar.js functions reuse) ──
document.getElementById('mobileMenuLeft')?.addEventListener('click', toggleLeft);
document.getElementById('mobileMenuRight')?.addEventListener('click', toggleRight);
