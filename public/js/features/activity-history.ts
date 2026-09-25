import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import type { RuntimeEvent } from '../../../src/shared/runtime-contract.js';
import { MAX_SAVED_ACTIVITY_ANSWER_BYTES, readActivityRun, readSavedActivityAnswer,
    type ActivityRunReadResult, type SavedActivityAnswer } from '../../../src/shared/activity-read.js';
import { readActivityHttp, ActivityReadError } from './activity-http.js';
import { findLiveActivity, mountHistoryActivity, recycleActivityHost, remountLiveActivity,
    restoreLiveActivity, setActivityReadHealth, settleLiveActivity, closeActivityTrace,
    isCurrentActivityMessage, reconcileSavedActivityAnswer } from './activity-live.js';
import { getMessageScope } from './idb-cache.js';

export type RecoveredAnswer = { kind: 'saved'; message: SavedActivityAnswer } | { kind: 'absent' } | { kind: 'unavailable' };
export interface RecoveredActivityTerminal {
    runId: string; sessionId: string; scope: string; turnId?: string;
    status: 'done' | 'error' | 'stopped'; message: HTMLElement; cacheScope: string; answer: RecoveredAnswer;
}
interface Callbacks {
    terminal(value: RecoveredActivityTerminal): void;
    refreshIdentity(): Promise<void>;
}
type Host = {
    message: HTMLElement; runId: string; cacheScope: string; controller: AbortController;
    box: HTMLElement; status: HTMLElement; retry: HTMLButtonElement;
    pending: boolean; loaded: boolean; promise: Promise<void> | null; resolve: (() => void) | null;
};
const SELECTOR = '.msg-agent[data-trace-run-id]';
const MAX_HOSTS = 64, MAX_QUEUED = 16, READ_DEADLINE_MS = 30_000;
let identity: ActivityIdentity | null = null;
let callbacks: Callbacks | null = null;
let loadedSession: string | null = null;
let loadedRuns = new Set<string>();
let generation = 0, loadingTranscript = false, automaticReads = false;
let identityRefreshKey = '';
let observer: IntersectionObserver | null = null, modeObserver: MutationObserver | null = null;
let active: Host | null = null;
const hosts = new Map<HTMLElement, Host>(), queued = new Map<HTMLElement, Host>();
const mode = () => document.documentElement.dataset['presentationMode'] !== 'legacy';
const chat = () => document.getElementById('chatMessages');
const locationKey = () => `${window.location.pathname}${window.location.search}`;

function messageRoot(message: HTMLElement): boolean {
    const root = chat(), parent = message.parentElement;
    return !!root && (parent === root
        || parent?.classList.contains('vs-inner') === true && parent.parentElement === root);
}
function owns(message: HTMLElement, runId: string, sessionId: string): boolean {
    return messageRoot(message) && message.dataset['traceRunId'] === runId
        && message.dataset['messageSessionId'] === sessionId
        && (loadedSession === sessionId && loadedRuns.has(runId)
            || findLiveActivity(runId)?.message === message || message.dataset['activitySession'] === sessionId
            || message.hasAttribute('data-active-run-hydrated'));
}
function current(host: Host, captured: ActivityIdentity, epoch: number, path: string): boolean {
    return hosts.get(host.message) === host && !host.controller.signal.aborted && host.message.isConnected
        && generation === epoch && path === locationKey() && identity?.sessionId === captured.sessionId
        && identity.scope === captured.scope && owns(host.message, host.runId, captured.sessionId);
}
function traceAllowed(message: HTMLElement, allowed: boolean): void {
    message.querySelectorAll<HTMLElement>('.process-step-trace').forEach(button => {
        button.setAttribute('aria-disabled', String(!allowed));
        button.tabIndex = allowed ? 0 : -1;
        if (button instanceof window.HTMLButtonElement) button.disabled = !allowed;
    });
}
function finishPromise(host: Host): void {
    host.retry.disabled = false;
    host.pending = false; host.resolve?.(); host.resolve = null; host.promise = null;
}
/** Status and retry never stand alone in the message flow: they live inside the
    mounted Activity disclosure when one exists, otherwise inside this host's own
    collapsed details so the text only appears once expanded. */
function present(host: Host): void {
    const disclosure = host.message.querySelector<HTMLElement>('.activity-disclosure');
    if (disclosure) {
        if (host.status.parentElement !== disclosure) {
            const footer = disclosure.querySelector('.activity-footer');
            if (footer) footer.before(host.status, host.retry); else disclosure.append(host.status, host.retry);
        }
    } else if (host.status.parentElement !== host.box) host.box.append(host.status, host.retry);
    host.status.hidden = !host.status.textContent;
    host.box.hidden = !!disclosure || (!host.status.textContent && host.retry.hidden);
}
function cancel(host: Host, remove: boolean): void {
    host.controller.abort();
    if (remove) observer?.unobserve(host.message);
    else {
        host.status.textContent = 'Activity read cancelled. Retry to inspect.';
        host.retry.textContent = 'Retry activity'; host.retry.hidden = false;
        present(host);
    }
    if (queued.delete(host.message)) finishPromise(host);
    if (remove) { hosts.delete(host.message); host.status.remove(); host.retry.remove(); host.box.remove(); }
}
function prune(): void {
    for (const host of hosts.values()) if (!host.message.isConnected) cancel(host, true);
    if (hosts.size < MAX_HOSTS) document.getElementById('activityHistoryCapacity')?.remove();
}

function entry(message: HTMLElement, runId: string): Host | null {
    const previous = hosts.get(message);
    if (previous?.runId === runId) { present(previous); return previous; }
    if (previous) cancel(previous, true);
    prune();
    if (hosts.size >= MAX_HOSTS) {
        if (!document.getElementById('activityHistoryCapacity')) {
            const notice = document.createElement('p'); notice.id = 'activityHistoryCapacity';
            notice.className = 'activity-read-capacity'; notice.setAttribute('role', 'status');
            notice.textContent = 'Activity inspection is at its display limit. Existing answers remain available; scroll unused records away before retrying.';
            chat()?.append(notice);
        }
        return null;
    }
    message.querySelectorAll('.activity-read-control, .activity-read-status, .activity-read-retry')
        .forEach(node => node.remove());
    const box = document.createElement('details'); box.className = 'activity-read-control';
    const summary = document.createElement('summary'); summary.className = 'activity-read-summary';
    summary.textContent = 'Activity status';
    const status = document.createElement('p'); status.className = 'activity-read-status';
    status.setAttribute('role', 'status'); status.hidden = true;
    const retry = document.createElement('button'); retry.className = 'activity-read-retry';
    retry.type = 'button'; retry.textContent = 'Load activity';
    box.append(summary, status, retry); message.querySelector('.agent-body')?.prepend(box);
    const host: Host = { message, runId, cacheScope: getMessageScope(), controller: new AbortController(),
        box, status, retry, pending: false, loaded: false, promise: null, resolve: null };
    retry.onclick = () => { void hydrateActivityHost(message, runId, true); };
    hosts.set(message, host); if (mode()) traceAllowed(message, false);
    return host;
}

/** Called by live eviction; deliberately does not schedule another read reentrantly. */
export function markActivityHistoryUnavailable(message: HTMLElement): void {
    if (!identity || !owns(message, message.dataset['traceRunId'] ?? '', identity.sessionId)) return;
    const host = entry(message, message.dataset['traceRunId']!); if (!host) return;
    host.loaded = false; host.retry.hidden = false;
    host.status.textContent = 'Activity preview is no longer retained in memory. Load it again to inspect.';
    present(host);
}

function combine(seed: ActivityRunReadResult, tail: ActivityRunReadResult): RuntimeEvent[] {
    if (seed.scope !== tail.scope) throw new Error('activity_scope_changed');
    const result = [...seed.events, ...tail.events];
    if (result.length > 4096) throw new Error('activity_run_limit');
    let bytes = 0; const encoder = new TextEncoder(); const turnId = result[0]?.turnId;
    for (const event of result) {
        if (event.turnId !== turnId) throw new Error('activity_turn_changed');
        bytes += encoder.encode(JSON.stringify(event)).length;
        if (bytes > 4 * 1024 * 1024) throw new Error('activity_run_limit');
    }
    return result;
}

async function execute(host: Host): Promise<void> {
    const captured = identity; if (!captured) return;
    const epoch = generation, path = locationKey();
    const timer = setTimeout(() => host.controller.abort(new DOMException('Activity read deadline', 'TimeoutError')), READ_DEADLINE_MS);
    const hadFocus = host.retry === document.activeElement;
    if (isCurrentActivityMessage(host.message) && host.message.dataset['activitySaved'] !== 'true')
        host.message.dataset['activityRecovering'] = 'true';
    let seed: ActivityRunReadResult | undefined, tail: ActivityRunReadResult | undefined;
    try {
        await restoreLiveActivity(async signal => {
            seed = await readActivityRun({ runId: host.runId, sessionId: captured.sessionId, signal, read: readActivityHttp });
            if (!current(host, captured, epoch, path)) throw new DOMException('History context changed', 'AbortError');
            tail = await readActivityRun({ runId: host.runId, sessionId: captured.sessionId,
                after: seed.through, signal, read: readActivityHttp });
            if (!current(host, captured, epoch, path)) throw new DOMException('History context changed', 'AbortError');
            return combine(seed, tail);
        }, { runId: host.runId, signal: host.controller.signal });
        if (!current(host, captured, epoch, path) || !seed || !tail) return;
        // Validated history ownership survives removal of the transient active
        // snapshot marker, including an empty journal's first successful answer.
        host.message.dataset['activitySession'] = captured.sessionId;
        const result = tail;
        let turn = findLiveActivity(host.runId);
        const recordedEnd = [...seed.events, ...result.events].find(event => event.kind === 'turn-end');
        const status = turn?.model.end?.status ?? (recordedEnd?.kind === 'turn-end' ? recordedEnd.status
            : result.status === 'interrupted' ? 'stopped' : result.status);
        const incomplete = seed.incomplete || result.incomplete;
        traceAllowed(host.message, true);
        let answer: RecoveredAnswer = { kind: 'unavailable' };
        let answerError: unknown;
        if (status !== 'running') {
            try {
                const saved = await readSavedActivityAnswer({ runId: host.runId, sessionId: captured.sessionId,
                    signal: host.controller.signal,
                    read: (request, signal) => readActivityHttp(request, signal, MAX_SAVED_ACTIVITY_ANSWER_BYTES) });
                answer = saved ? { kind: 'saved', message: saved } : { kind: 'absent' };
            } catch (error) { answerError = error; }
            if (!current(host, captured, epoch, path)) return;
        }
        // A duplicate saved association must not move one run's view between rows.
        if (!(answerError instanceof ActivityReadError && answerError.status === 409))
            turn = mountHistoryActivity(host.message, host.runId) ?? turn;
        if (status !== 'running') settleLiveActivity(host.runId, status);
        setActivityReadHealth(host.runId, incomplete);
        if (status !== 'running') {
            callbacks?.terminal({ runId: host.runId, sessionId: captured.sessionId, scope: result.scope,
                ...(turn ? { turnId: turn.model.identity.turnId } : {}), status,
                message: host.message, cacheScope: host.cacheScope, answer });
            turn = findLiveActivity(host.runId);
            if (answer.kind === 'saved') {
                const message = turn?.message ?? host.message;
                if (!reconcileSavedActivityAnswer(message, answer.message, host.cacheScope))
                    answerError = new Error('saved_message_identity_changed');
            }
        }
        if (!current(host, captured, epoch, path)) return;
        host.loaded = true;
        const noActivity = !turn;
        host.status.textContent = answerError instanceof ActivityReadError ? answerError.message
            : answerError ? 'The saved answer could not be recovered. Retry; existing text is unchanged.'
            : incomplete ? 'Some recorded activity is unavailable. Existing saved or live answers are unchanged.'
            : noActivity ? 'No detailed Activity is retained. The saved transcript and authorized Trace remain available.'
            : status !== 'running' && answer.kind === 'absent' ? 'No saved answer is linked to this run. Inspect retained Activity in Trace.'
            : '';
        host.retry.textContent = 'Refresh activity';
        host.retry.hidden = !incomplete && !noActivity && !answerError && status !== 'running' && answer.kind === 'saved';
        present(host);
        if (hadFocus && ((!host.status.textContent && host.retry.hidden)
            || !!host.retry.closest('details:not([open])'))) {
            host.message.querySelector<HTMLElement>('.activity-summary')?.focus({ preventScroll: true });
        }
    } catch (error) {
        if (hosts.get(host.message) !== host || generation !== epoch || path !== locationKey()) return;
        if (host.controller.signal.aborted && host.controller.signal.reason?.name !== 'TimeoutError') return;
        host.status.textContent = error instanceof ActivityReadError ? error.message
            : 'Activity could not be restored. The transcript is unchanged; retry to inspect it.';
        host.retry.hidden = false; host.retry.textContent = 'Retry activity'; present(host);
        if (error instanceof ActivityReadError && error.status === 404) {
            try {
                await readActivityHttp(`/api/traces/${encodeURIComponent(host.runId)}?${new URLSearchParams({ session: captured.sessionId })}`,
                    host.controller.signal);
                if (current(host, captured, epoch, path)) {
                    traceAllowed(host.message, true);
                    host.status.textContent = 'Detailed Activity was not recorded for this turn. The saved transcript is shown.';
                    host.retry.hidden = true; present(host);
                }
            } catch { /* A copied/foreign/expired pointer does not gain raw authority. */ }
        }
    } finally {
        clearTimeout(timer);
        if (hosts.get(host.message) === host) {
            if (!host.controller.signal.aborted || host.controller.signal.reason?.name === 'TimeoutError') host.loaded = true;
        }
    }
}

function pump(): void {
    if (active) return;
    const next = queued.entries().next().value as [HTMLElement, Host] | undefined;
    if (!next) return;
    queued.delete(next[0]); const host = next[1];
    if (!host.message.isConnected || host.controller.signal.aborted || hosts.get(host.message) !== host) {
        finishPromise(host); queueMicrotask(pump); return;
    }
    active = host; host.status.textContent = 'Loading recorded activity.'; present(host);
    void execute(host).catch(error => console.warn('[activity] history read failed', error)).finally(() => {
        finishPromise(host); if (active === host) active = null; pump();
    });
}

export function hydrateActivityHost(message: HTMLElement, runId: string, manual = false): Promise<void> {
    if (!identity || !owns(message, runId, identity.sessionId) || !message.isConnected || loadingTranscript) return Promise.resolve();
    if (!manual && (!mode() || !automaticReads)) return Promise.resolve();
    const host = entry(message, runId); if (!host) return Promise.resolve();
    if (host.pending) return host.promise!;
    const turn = findLiveActivity(runId);
    if (!manual && host.loaded) return Promise.resolve();
    if (!manual && turn?.message === message && !turn.degraded && !message.dataset['activityRecovering']) {
        host.status.textContent = ''; host.retry.hidden = true; present(host);
        traceAllowed(message, true); return Promise.resolve();
    }
    if (queued.size >= MAX_QUEUED) {
        host.status.textContent = 'Activity reads are at their limit. Use Load activity to retry.';
        host.retry.hidden = false; present(host); return Promise.resolve();
    }
    host.controller = new AbortController(); host.pending = true;
    host.status.textContent = 'Activity read queued.'; host.retry.disabled = true; present(host);
    host.promise = new Promise(resolve => { host.resolve = resolve; });
    const promise = host.promise; queued.set(message, host); pump(); return promise;
}

export function recycleActivityHistory(root: ParentNode): void {
    for (const message of root.querySelectorAll<HTMLElement>('[data-activity-key]')) recycleActivityHost(message);
    if (root instanceof HTMLElement && root.dataset['activityKey']) recycleActivityHost(root);
    for (const [message, host] of hosts) if (root === message || root.contains(message)) {
        cancel(host, true); recycleActivityHost(message);
    }
}

export function observeActivityHistory(root: ParentNode): void {
    if (!identity || loadingTranscript) return;
    prune(); remountLiveActivity(root);
    if (!observer && typeof IntersectionObserver !== 'undefined') observer = new IntersectionObserver(entries => {
        for (const item of entries) {
            const message = item.target as HTMLElement, host = hosts.get(message);
            if (item.isIntersecting) void hydrateActivityHost(message, message.dataset['traceRunId'] ?? '');
            else if (host?.pending && !message.contains(document.activeElement)) cancel(host, false);
        }
    }, { root: chat() });
    for (const message of root.querySelectorAll<HTMLElement>(SELECTOR)) {
        const runId = message.dataset['traceRunId']!;
        if (!owns(message, runId, identity.sessionId)) continue;
        const host = entry(message, runId); if (!host) continue;
        if (!mode()) { host.status.textContent = ''; host.retry.hidden = true; present(host);
            traceAllowed(message, true); continue; }
        if (message.closest('details:not([open])')) continue;
        if (observer) observer.observe(message); else void hydrateActivityHost(message, runId);
    }
}

export function prepareActivityTranscript(): void {
    loadingTranscript = true; ++generation;
    for (const host of hosts.values()) if (host.pending) cancel(host, false);
}
export function setActivityTranscript(sessionId: string | null, runIds: ReadonlySet<string>): void {
    loadingTranscript = false; loadedSession = sessionId; loadedRuns = new Set(runIds);
    if (identity && sessionId && identity.sessionId !== sessionId && callbacks) {
        const key = `${locationKey()}:${sessionId}`;
        if (identityRefreshKey !== key) { identityRefreshKey = key; void callbacks.refreshIdentity().catch(() => {}); }
    }
    const root = chat(); if (root) observeActivityHistory(root);
}
export function setActivityHistoryIdentity(next: ActivityIdentity | null, handlers: Callbacks): void {
    callbacks = handlers;
    if (identity?.sessionId !== next?.sessionId || identity?.scope !== next?.scope) {
        ++generation; for (const host of hosts.values()) cancel(host, true);
        observer?.disconnect(); observer = null; closeActivityTrace(); identityRefreshKey = '';
    }
    identity = next ? { ...next } : null;
    if (!modeObserver) {
        modeObserver = new MutationObserver(() => {
            if (!mode()) for (const host of hosts.values()) if (host.pending) cancel(host, false);
            const root = chat(); if (root) observeActivityHistory(root);
        });
        modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-presentation-mode'] });
    }
}
export function setActivityHistoryReadReady(ready: boolean): void {
    automaticReads = ready;
    if (!ready) {
        for (const host of hosts.values()) if (host.pending) cancel(host, false);
    } else { const root = chat(); if (root) observeActivityHistory(root); }
}
export function disposeActivityHistory(): void {
    ++generation; for (const host of hosts.values()) cancel(host, true);
    observer?.disconnect(); observer = null; modeObserver?.disconnect(); modeObserver = null;
    identity = null; loadedSession = null; loadedRuns.clear(); callbacks = null;
}
