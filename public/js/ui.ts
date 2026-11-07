import { state } from './state.js';
import { preserveTableActionFocus } from './render/table-actions.js';
import { renderMarkdown, escapeHtml, stripOrchestration, linkifyFilePaths } from './render.js';
import { renderMermaidBlocks, releaseMermaidNodes } from './render.js';
import { generateId } from './uuid.js';
import { getAppName } from './features/appname.js';
import { getAgentAvatarMarkup, getUserAvatarMarkup } from './features/avatar.js';
import { t } from './features/i18n.js';
import { api } from './api.js';
import { cacheMessages, getCachedMessages, appendCachedMessage, upsertMessage, setMessageScope, getScopedMessages } from './features/idb-cache.js';
import { getVirtualScroll, VS_THRESHOLD, type RestoreReason, type VirtualItem } from './virtual-scroll.js';
import { bootstrapVirtualHistory, type VirtualHistoryBootstrapDeps } from './virtual-scroll-bootstrap.js';
import { createStreamRenderer, appendChunk, finalizeStream, hydrateStreamRenderer, type StreamState } from './streaming-render.js';
import { activateWidgets } from './diagram/iframe-renderer.js';
import { renderLiveToolActivity, cleanupToolElements, type ToolLogEntry } from './features/tool-ui.js';
import { initMessageActions } from './features/message-actions.js';
import { addSystemMsg, addMessage, removeSkeleton } from './features/chat-messages.js';
import { buildLazyVirtualMessageItem } from './features/message-item-html.js';
import { loadMessages, registerVirtualScrollCallbacks, ensureActivityVirtualCallbacks } from './features/message-history.js';
import { isChatNearBottom, reconcileChatBottomAfterLayout, showChatRestoreIndicator, hideChatRestoreIndicator, hideChatRestoreIndicatorAfterSettle, reconcileChatBottomAfterRestore, scrollToBottom, ensureScrollTracking, canFollowAfterRestore, markFollowingBottom } from './features/chat-scroll.js';
import { currentProcessBlockFromDom, hasAgentToolBlock, normalizeAgentToolBlocks, removeAgentToolBlocks, serializeProcessStepsForToolLog } from './features/process-block-dom.js';
import { mergeExplicitAndLiveToolLogs, normalizeMessageToolLog, parseToolLog, sanitizedToolLogEntries, sanitizedToolLogJson, sanitizedToolLogJsonFromEntries, toProcessSteps, type ActiveRunSnapshot, type MessageItem, type QueuedOverlayItem } from './features/process-log-adapter.js';
import { setStatus, updateQueueBadge, updateStatMsgs, loadStats } from './features/ui-status.js';
import { ICONS, resolveIcon, emojiToStatus, isCompletionEmoji } from './icons.js';
import { providerIcon } from './provider-icons.js';
import { findProcessStepByIdentity, findRunningProcessStepMatch, sameProcessStepIdentity } from './features/process-step-match.js';
import {
    parseToolLogBounded,
    sanitizeToolLogForDurableStorage,
    serializeSanitizedToolLog,
    type SanitizedToolLogEntry,
} from '../../src/shared/tool-log-sanitize.js';
import {
    createProcessBlock,
    addStep,
    replaceStep,
    updateStepStatus,
    collapseBlock,
    stopBlockTicker,
    buildProcessBlockHtml,
    getStoredProcessStepDetail,
    mergeStoredProcessStepDetail,
    setStoredProcessStepDetail,
    processStepMetaFromStore,
    releaseProcessBlockDetails,
    type ProcessStep,
    type ProcessBlockState,
} from './features/process-block.js';


export {
    setStatus, updateQueueBadge, loadStats, loadMessages,
    addSystemMsg, addMessage,
    isChatNearBottom, reconcileChatBottomAfterLayout, showChatRestoreIndicator,
    hideChatRestoreIndicator, hideChatRestoreIndicatorAfterSettle, reconcileChatBottomAfterRestore,
    scrollToBottom,
};

function getAgentIcon(_cli?: string | null): string {
    return getAgentAvatarMarkup();
}

declare global {
    interface Window {
        __jawProcessBlockLayoutMutation?: (anchor: Element | null, mutate: () => void) => void;
    }
}

export function cleanupToolActivity(): void {
    if (state.currentProcessBlock) releaseProcessBlockDetails(state.currentProcessBlock);
    if (state.currentAgentDiv instanceof HTMLElement) releaseProcessBlockDetails(state.currentAgentDiv);
    cleanupToolElements();
    stopBlockTicker();
    state.currentAgentDiv = null;
    state.currentProcessBlock = null;
    currentStream = null;
}

/** Timestamp of last steer — used to suppress late agent_done after steer. */
let lastSteerTs = 0;
export function markSteered(): void { lastSteerTs = Date.now(); }
export function clearSteer(): void { lastSteerTs = 0; }
export function isRecentSteer(): boolean { return Date.now() - lastSteerTs < 8000; }

function hasFollowingUserMessage(el: HTMLElement): boolean {
    for (const user of document.querySelectorAll<HTMLElement>('.msg-user')) {
        if (el.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
    }
    return false;
}

function currentAgentDivForActiveRun(): HTMLElement | null {
    const existing = state.currentAgentDiv && state.currentAgentDiv.isConnected
        ? state.currentAgentDiv as HTMLElement
        : null;
    if (!existing) return null;
    if (!hasFollowingUserMessage(existing)) return existing;
    state.currentAgentDiv = null;
    state.currentProcessBlock = null;
    currentStream = null;
    return null;
}

function latestAgentDivForActiveRun(): HTMLElement | null {
    const agents = Array.from(document.querySelectorAll<HTMLElement>('.msg-agent'));
    const latest = agents.at(-1) ?? null;
    if (!latest || hasFollowingUserMessage(latest)) return null;
    return latest;
}

export function showLiveToolActivity(label: string): void {
    removeSkeleton();
    if (!currentAgentDivForActiveRun()) {
        state.currentAgentDiv = addMessage('agent', '');
    }
    renderLiveToolActivity(state.currentAgentDiv as HTMLElement, label);
    scrollToBottom();
}

export function showProcessStep(step: ProcessStep, runStartedAt?: number): void {
    removeSkeleton();
    let agentDiv = currentAgentDivForActiveRun();
    if (!agentDiv) {
        agentDiv = addMessage('agent', '');
        state.currentAgentDiv = agentDiv;
        state.currentProcessBlock = null;
    }
    normalizeAgentToolBlocks(agentDiv);
    if (!state.currentProcessBlock) {
        const body = agentDiv.querySelector('.agent-body') as HTMLElement;
        if (body) {
            state.currentProcessBlock = currentProcessBlockFromDom(agentDiv);
        }
        if (!state.currentProcessBlock && body) {
            removeAgentToolBlocks(agentDiv);
            state.currentProcessBlock = createProcessBlock(body);
        }
    }
    if (runStartedAt && state.currentProcessBlock && !state.currentProcessBlock.startedAt) {
        state.currentProcessBlock.startedAt = runStartedAt;
    }
    if (state.currentProcessBlock) {
        const rawIcon = step.rawIcon || step.icon;
        // Completion detection: prefer semantic status field, fall back to emoji check
        const resolvedStatus = step.status || emojiToStatus(step.icon) || 'running';
        if (resolvedStatus === 'done' || resolvedStatus === 'error') {
            // Prefer matching by stepRef (stable correlation), fall back to label
            const match = findRunningProcessStepMatch(state.currentProcessBlock.steps, step);
            if (match) {
                step.icon = resolveIcon(step.icon);
                const detailPreview = step.type === 'thinking'
                    ? setStoredProcessStepDetail(match.id, step.detail)
                    : mergeStoredProcessStepDetail(match.id, step.detail);
                replaceStep(state.currentProcessBlock, match.id, {
                    ...match,
                    ...step,
                    id: match.id,
                    rawIcon,
                    detail: detailPreview,
                    detailPreview,
                    label: step.label || match.label,
                    status: resolvedStatus,
                    startTime: match.startTime,
                });
                scrollToBottom();
                return;
            }
            if (step.stepRef && (resolvedStatus === 'done' || resolvedStatus === 'error')) {
                const existingDone = [...state.currentProcessBlock.steps].reverse()
                    .find(s => s.stepRef === step.stepRef && (s.status === 'done' || s.status === 'error'));
                if (existingDone) {
                    step.icon = resolveIcon(step.icon);
                    const detailPreview = step.type === 'thinking'
                        ? setStoredProcessStepDetail(existingDone.id, step.detail)
                        : mergeStoredProcessStepDetail(existingDone.id, step.detail);
                    replaceStep(state.currentProcessBlock, existingDone.id, {
                        ...existingDone,
                        ...step,
                        id: existingDone.id,
                        rawIcon,
                        status: resolvedStatus,
                        detail: detailPreview,
                        detailPreview,
                        startTime: existingDone.startTime,
                    });
                    scrollToBottom();
                    return;
                }
            }
        }
        if (step.stepRef && resolvedStatus === 'running') {
            const existingRunning = [...state.currentProcessBlock.steps].reverse()
                .find(s => s.stepRef === step.stepRef && s.status === 'running');
            if (existingRunning) {
                step.rawIcon = rawIcon;
                step.icon = resolveIcon(step.icon);
                const detailPreview = setStoredProcessStepDetail(existingRunning.id, step.detail);
                replaceStep(state.currentProcessBlock, existingRunning.id, {
                    ...existingRunning,
                    ...step,
                    id: existingRunning.id,
                    rawIcon,
                    status: 'running',
                    detail: detailPreview,
                    detailPreview,
                    label: step.label || existingRunning.label,
                    startTime: existingRunning.startTime,
                });
                scrollToBottom();
                return;
            }
        }
        const identityMatch = findProcessStepByIdentity(state.currentProcessBlock.steps, step, { includeDone: true });
        if (identityMatch) {
            step.rawIcon = rawIcon;
            step.icon = resolveIcon(step.icon);
            const incomingDetail = step.detail || '';
            const existingDetail = getStoredProcessStepDetail(identityMatch.id) || identityMatch.detail || identityMatch.detailPreview || '';
            const detail = incomingDetail.length >= existingDetail.length ? incomingDetail : existingDetail;
            const detailPreview = setStoredProcessStepDetail(identityMatch.id, detail);
            const nextStatus = (identityMatch.status === 'done' || identityMatch.status === 'error') && resolvedStatus === 'running'
                ? identityMatch.status
                : resolvedStatus;
            replaceStep(state.currentProcessBlock, identityMatch.id, {
                ...identityMatch,
                ...step,
                id: identityMatch.id,
                rawIcon,
                status: nextStatus,
                detail: detailPreview,
                detailPreview,
                label: step.label || identityMatch.label,
                startTime: identityMatch.startTime,
            });
            scrollToBottom();
            return;
        }
        // Dedupe: detail이 있는 재broadcast → 같은 label+type의 detail 없는 유령 교체
        if (step.detail) {
            const ghost = [...state.currentProcessBlock.steps].reverse()
                .find(s => s.status === 'running'
                    && s.label === step.label
                    && s.type === step.type
                    && Boolean(s.isEmployee) === Boolean(step.isEmployee)
                    && !s.detail);
            if (ghost) {
                replaceStep(state.currentProcessBlock, ghost.id, step);
                scrollToBottom();
                return;
            }
        }
        // Convert emoji icon to SVG before adding step
        step.rawIcon = rawIcon;
        step.icon = resolveIcon(step.icon);
        addStep(state.currentProcessBlock, step);
    }
    scrollToBottom();
}

let currentStream: StreamState | null = null;

const ACTIVE_RUN_HYDRATED_ATTR = 'data-active-run-hydrated';

function removeStaleHydratedActiveRuns(keep?: HTMLElement | null): void {
    document.querySelectorAll<HTMLElement>(`[${ACTIVE_RUN_HYDRATED_ATTR}="true"]`).forEach(el => {
        if (keep && el === keep) return;
        el.remove();
    });
}

function ensureActiveRunMessage(cli?: string | null): HTMLElement {
    const existing = currentAgentDivForActiveRun() ?? latestAgentDivForActiveRun();
    removeStaleHydratedActiveRuns(existing);
    const div = existing || addMessage('agent', '', cli || null);
    div.setAttribute(ACTIVE_RUN_HYDRATED_ATTR, 'true');
    return div;
}

function richerDetail(existing: ProcessStep, incoming: ProcessStep): string {
    const existingDetail = getStoredProcessStepDetail(existing.id) || existing.detail || existing.detailPreview || '';
    const incomingDetail = incoming.detail || incoming.detailPreview || '';
    return incomingDetail.length >= existingDetail.length ? incomingDetail : existingDetail;
}

// 260613 30 P3: a step with neither stepRef nor positive trace identity can
// only be matched positionally. The parent toolLog is append-only, so the
// ordinal among identity-less steps is stable across hydrations.
function hasDurableStepIdentity(step: ProcessStep): boolean {
    if (step.stepRef) return true;
    return Boolean(step.traceRunId)
        && typeof step.traceSeq === 'number' && Number.isFinite(step.traceSeq) && step.traceSeq > 0;
}

function mergeHydratedProcessSteps(pb: ProcessBlockState, steps: ProcessStep[]): void {
    const ordinalSteps = pb.steps.filter(existing => !hasDurableStepIdentity(existing));
    let ordinal = 0;
    // Ordinal matching assumes both sides saw the SAME append-only sequence.
    // On the first type/isEmployee mismatch the sequences have diverged —
    // keep consuming positions and every later step pairs off-by-one,
    // cascading duplicates (adversarial review #3). Abandon the tier instead.
    let ordinalAligned = true;
    for (const step of steps) {
        let match = pb.steps.find(existing => sameProcessStepIdentity(existing, step)) ?? null;
        if (!match && !hasDurableStepIdentity(step) && ordinalAligned) {
            // Ordinal match (doc 01 F1/F3): same position among identity-less
            // steps, same type/isEmployee — label may have been re-sanitized.
            const candidate = ordinalSteps[ordinal] ?? null;
            if (!candidate) {
                ordinal++; // past the end: a genuinely new tail entry
            } else if (candidate.type === step.type
                && Boolean(candidate.isEmployee) === Boolean(step.isEmployee)) {
                match = candidate;
                ordinal++;
            } else {
                ordinalAligned = false;
            }
        }
        if (!match) {
            // Status-agnostic fuzzy fallback (doc 01 F2): running→done must
            // upgrade in place, not duplicate. Single-candidate rule kept.
            const matches = pb.steps.filter(existing => existing.label === step.label
                && existing.type === step.type
                && Boolean(existing.isEmployee) === Boolean(step.isEmployee));
            match = matches.length === 1 ? matches[0]! : null;
        }
        if (!match) {
            addStep(pb, step);
            if (!hasDurableStepIdentity(step) && ordinalAligned) {
                // Keep ordinal alignment for the rest of this pass: the added
                // step IS the identity-less entry at this position now.
                const added = pb.steps[pb.steps.length - 1];
                if (added) ordinalSteps.push(added);
            }
            continue;
        }
        const detailPreview = setStoredProcessStepDetail(match.id, richerDetail(match, step));
        replaceStep(pb, match.id, {
            ...match,
            ...step,
            id: match.id,
            detail: detailPreview,
            detailPreview,
            label: step.label || match.label,
        });
    }
}

/**
 * Queued items are surfaced exclusively by the pending-queue panel
 * (renderPendingQueue) — they do NOT appear as chat bubbles until they
 * actually start running. This function exists only to clean up legacy
 * overlay bubbles from older builds that may still be in the DOM after
 * a soft reload, and to drop stale snapshots silently.
 */
export function applyQueuedOverlay(_items: QueuedOverlayItem[] = []): void {
    document.querySelectorAll('[data-queued-overlay="true"]').forEach(el => el.remove());
}

// 260613 10 P1-c: restore hooks re-hydrate on every focus/click; identical
// snapshots must be a no-op or the merge + stream-renderer reset reads as a
// constant flicker loop (and compounds the doc-01 duplicate growth).
let lastHydrationSignature = '';

function hydrationSignature(snapshot: ActiveRunSnapshot): string {
    const tools = Array.isArray(snapshot.toolLog) ? snapshot.toolLog : [];
    // detail length included: server-side enrichment of a running tool can be
    // the ONLY delta between snapshots (adversarial review #4) — a signature
    // without it would no-op-skip the update.
    const toolSig = tools
        .map(t => `${t.stepRef || ''}~${t.traceRunId || ''}~${t.traceSeq ?? ''}~${t.status || ''}~${t.label || ''}~${(t.detail || '').length}`)
        .join('|');
    return `${snapshot.traceRunId || ''}:${snapshot.cli || ''}:${(snapshot.text || '').length}:${tools.length}:${toolSig}`;
}

export function resetHydrationSignature(): void { lastHydrationSignature = ''; }

export function hydrateActiveRun(snapshot?: ActiveRunSnapshot | null): void {
    if (!snapshot?.running) {
        lastHydrationSignature = '';
        removeStaleHydratedActiveRuns();
        return;
    }
    const signature = hydrationSignature(snapshot);
    if (signature === lastHydrationSignature && currentAgentDivForActiveRun()) return;
    cleanupToolElements();
    removeSkeleton();
    state.currentAgentDiv = ensureActiveRunMessage(snapshot.cli || null);
    const body = state.currentAgentDiv.querySelector('.agent-body') as HTMLElement | null;
    const snapshotToolLog = sanitizedToolLogEntries(snapshot.toolLog || []);
    normalizeAgentToolBlocks(state.currentAgentDiv);
    state.currentProcessBlock = currentProcessBlockFromDom(state.currentAgentDiv);
    if (body && snapshotToolLog.length) {
        if (!state.currentProcessBlock) {
            removeAgentToolBlocks(state.currentAgentDiv);
            state.currentProcessBlock = createProcessBlock(body);
        }
        if (snapshot.startedAt) state.currentProcessBlock.startedAt = snapshot.startedAt;
        mergeHydratedProcessSteps(state.currentProcessBlock, toProcessSteps(snapshotToolLog, snapshot.startedAt));
    } else {
        state.currentProcessBlock = currentProcessBlockFromDom(state.currentAgentDiv);
    }
    const content = state.currentAgentDiv.querySelector('.msg-content') as HTMLElement | null;
    if (content) {
        currentStream = hydrateStreamRenderer(content, snapshot.text || '');
    }
    lastHydrationSignature = signature;
}

export function appendAgentText(text: string): void {
    if (!text) return;
    removeSkeleton();
    if (!currentAgentDivForActiveRun()) {
        state.currentAgentDiv = addMessage('agent', '');
        currentStream = null;
    }
    const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
    if (content) {
        if (!currentStream) currentStream = createStreamRenderer(content as HTMLElement);
        appendChunk(currentStream, text);
    }
    scrollToBottom();
}

let lastFinalizeTs = 0;

function clearMermaidTransientState(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.mermaid-pending').forEach(el => {
        delete el.dataset['mermaidQueued'];
        delete el.dataset['mermaidQueuedAt'];
    });
}

/** Correct an already-owned message without replaying final lifecycle effects. */
export function replaceAgentAnswer(message: HTMLElement, text: string): void {
    const content = message.querySelector<HTMLElement>('.msg-content');
    if (!content) return;
    const raw = stripOrchestration(text);
    if (content.getAttribute('data-raw') === raw && (raw || content.childNodes.length === 0)) return;
    releaseMermaidNodes(content);
    preserveTableActionFocus(content, () => { content.innerHTML = raw ? renderMarkdown(text) : ''; });
    content.setAttribute('data-raw', raw);
    content.classList.remove('lazy-pending');
    activateWidgets(content);
    void renderMermaidBlocks(content, { immediate: true });
}

export function finalizeAgent(text: string | null, toolLog?: ToolLogEntry[], runtimeFinality?: 'present' | 'absent', traceRunId?: string, cacheScope?: string, cacheSessionId?: string): void {
    const nativeFinal = runtimeFinality === 'present' || runtimeFinality === 'absent';
    // Guard: prevent double-render when both agent_done + orchestrate_done fire
    const now = Date.now();
    if (!state.currentAgentDiv && now - lastFinalizeTs < 500) return;
    lastHydrationSignature = ''; // run over — the next run must hydrate fresh

    cleanupToolElements();
    removeSkeleton();
    if (state.currentAgentDiv) normalizeAgentToolBlocks(state.currentAgentDiv);
    const liveToolLog = serializeProcessStepsForToolLog(
        state.currentProcessBlock ?? state.currentAgentDiv,
        true,
    );
    const explicitToolLog = Array.isArray(toolLog) ? toolLog : [];
    const durableToolLog = sanitizedToolLogEntries(
        mergeExplicitAndLiveToolLogs(explicitToolLog, liveToolLog),
    );
    const durableToolLogJson = sanitizedToolLogJsonFromEntries(durableToolLog);
    const hadProcessBlock =
        Boolean(state.currentProcessBlock) ||
        Boolean(state.currentAgentDiv && hasAgentToolBlock(state.currentAgentDiv));
    if (state.currentProcessBlock) {
        collapseBlock(state.currentProcessBlock);
        state.currentProcessBlock = null;
    }
    const hasTools = durableToolLog.length > 0;
    if (text || hasTools || nativeFinal) {
        if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
            state.currentAgentDiv = addMessage('agent', '');
        }
        // Exact current-run recovery preserves the original row even when its
        // journal has no Activity model and the first saved-answer read succeeds.
        const preserveActivityHost = !!(state.currentAgentDiv.dataset['activityKey']
            || state.currentAgentDiv.dataset['activityAnswerPending']
            || traceRunId && cacheSessionId && state.currentAgentDiv.dataset['traceRunId'] === traceRunId
                && state.currentAgentDiv.dataset['messageSessionId'] === cacheSessionId);
        if (traceRunId) state.currentAgentDiv.dataset['traceRunId'] = traceRunId;
        delete state.currentAgentDiv.dataset['activityRecovering'];
        state.currentAgentDiv.removeAttribute(ACTIVE_RUN_HYDRATED_ATTR);
        const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
        // Live stream is preview-only; agent_done text is always authoritative.
        const streamedText = currentStream ? finalizeStream(currentStream, true) : '';
        const finalText = nativeFinal ? text ?? '' : text || streamedText;
        currentStream = null;
        // Empty Markdown renders a "dispatching" placeholder; native empty is a
        // terminal result, not a loading state.
        if (content) content.innerHTML = nativeFinal && !finalText ? '' : renderMarkdown(finalText);
        if (hasTools && state.currentAgentDiv && !hadProcessBlock && !hasAgentToolBlock(state.currentAgentDiv)) {
            const contentEl = state.currentAgentDiv.querySelector('.msg-content') as HTMLElement | null;
            if (contentEl) {
                contentEl.insertAdjacentHTML(
                    'beforebegin',
                    buildProcessBlockHtml(toProcessSteps(durableToolLog), true),
                );
            }
        }
        if (state.currentAgentDiv) normalizeAgentToolBlocks(state.currentAgentDiv);
        if (content) content.setAttribute('data-raw', stripOrchestration(finalText));
        if (content) activateWidgets(content as HTMLElement);

        const vs = getVirtualScroll();
        const willPromoteToVirtualScroll = !!(
            vs.active && state.currentAgentDiv && state.currentAgentDiv.isConnected
        );

        // Direct DOM can render Mermaid now; VS clones render in onPostRender.
        if (content && !willPromoteToVirtualScroll) {
            void renderMermaidBlocks(content as HTMLElement, { immediate: true });
        }

        // Revert activated widgets so VS can re-activate recreated DOM.
        if (willPromoteToVirtualScroll) {
            const div = state.currentAgentDiv;
            clearMermaidTransientState(div);
            div.querySelectorAll('.diagram-widget').forEach(widget => {
                const widgetEl = widget as HTMLElement;
                const encoded = widgetEl.dataset['widgetHtml'];
                const widgetId = widgetEl.dataset['widgetId'];
                if (!encoded && !widgetId) return;
                const pending = document.createElement('div');
                pending.className = 'diagram-widget-pending';
                if (widgetId) pending.dataset['widgetId'] = widgetId;
                else if (encoded) pending.dataset['diagramHtml'] = encoded;
                widget.replaceWith(pending);
            });
            if (durableToolLogJson && !preserveActivityHost) {
                // A first/cleared chat can activate VS from an already-rendered
                // user row without the history loader's lazy callback.
                if (!vs.onLazyRender) registerVirtualScrollCallbacks(vs);
                vs.appendItem(buildLazyVirtualMessageItem({
                    role: 'assistant',
                    content: finalText,
                    cli: null,
                    tool_log: durableToolLogJson,
                    trace_run_id: div.dataset['traceRunId'] ?? null,
                }, vs.count));
                releaseProcessBlockDetails(div);
                vs.scrollToBottom();
            } else {
                div.dataset['turnIndex'] = String(vs.count);
                if (!div.dataset['messageId']) div.dataset['messageId'] = generateId();
                if (preserveActivityHost) ensureActivityVirtualCallbacks(vs);
                vs.appendLiveItem(div);
            }
            div.remove();
        }

        // Cache agent response for offline (use finalText to capture stream-only responses)
        if (finalText || (traceRunId && preserveActivityHost)) upsertMessage({
            role: 'assistant',
            content: finalText,
            tool_log: durableToolLogJson,
            trace_run_id: state.currentAgentDiv?.dataset['traceRunId'] ?? null,
            timestamp: Date.now(),
            ...(cacheScope === undefined ? {} : { scope: cacheScope }),
            ...(cacheSessionId === undefined ? {} : { session_id: cacheSessionId }),
        }).catch(() => {});
    }
    currentStream = null;
    state.currentAgentDiv = null;
    lastFinalizeTs = Date.now();
    setStatus('idle');
    loadStats();
}

export function switchTab(name: string, targetBtn: Element): void {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabMap: Record<string, string> = { agents: 'tabAgents', settings: 'tabSettings', skills: 'tabSkills' };
    document.getElementById(tabMap[name])?.classList.add('active');
    if (targetBtn) {
        targetBtn.classList.add('active');
        targetBtn.setAttribute('aria-selected', 'true');
    }
    // Lazy-load tab content
    if (name === 'agents') { import('./features/employees.js').then(m => m.loadEmployees()); }
    if (name === 'skills') { import('./features/skills.js').then(m => m.loadSkills()); }
}

export function handleSave(): void {
    const isSettings = document.getElementById('tabSettings')?.classList.contains('active');
    if (isSettings) return;
    import('./features/settings.js').then(m => m.updateSettings());
}

export function initMsgCopy(): void {
    initMessageActions({ onStatus: addSystemMsg });
}
