// wp29 browser-only fixture. Real channel/consumer/view; no ws bootstrap or provider.
import type { BurstBinding, BurstCycle } from './native-activity-burst-server.mts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';
import { parseRuntimeEvent } from '../../src/shared/runtime-event-parse.js';
import { activityRetainedChars } from '../../src/shared/activity-state.js';
import {
    setEventChannelScopeProvider, subscribe as subscribeChannel, onChannelOpen,
    onChannelDisconnect, onChannelUnavailable, connectEventChannel, closeEventChannel,
} from '../../public/js/event-channel.js';
import {
    configureLiveActivityHost, setLiveActivityIdentity, setActivityTransportHealthy,
    ingestLiveActivity, findLiveActivity, clearLiveActivity,
} from '../../public/js/features/activity-live.js';
import { addMessage } from '../../public/js/features/chat-messages.js';
import { cleanupToolActivity, replaceAgentAnswer } from '../../public/js/ui.js';
import { state } from '../../public/js/state.js';
import { getVirtualScroll } from '../../public/js/virtual-scroll.js';
import { cancelPostRender } from '../../public/js/render/post-render.js';
import { initI18n } from '../../public/js/features/i18n.js';

export interface BurstPreview {
    entryCount: number; retainedChars: number; observedFieldChars: number;
    omittedEntries: number; omittedTextChars: number; latestAction: string;
    retainedIds: string[]; visibleRows: number; omissionVisible: boolean;
}
interface ControlObservation {
    queuedAt: number; completedAt: number | null; frameAt: number | null;
    queuedOrdinal: number; completedOrdinal: number | null; frameOrdinal: number | null;
    open: boolean | null;
}
interface RawProof {
    runId: string; seq: number; outputBytes: number; prefix: string; suffix: string;
}
export interface BurstBrowserSnapshot {
    protocol: 'wp29-burst-v2'; binding: BurstBinding | null; ready: boolean; terminal: boolean;
    receivedCount: number; ingestedCount: number; retiredCallbackHits: number;
    retiredCallbackHitsTotal: number; suppressedIngestions: number;
    activeEventSources: number; maxEventSources: number;
    bulk: BurstPreview | null; final: BurstPreview | null;
    finalText: string | null; finalDomRaw: string | null; finalDomText: string | null;
    answerCount: number; controls: ControlObservation[]; frames: Array<[number, number]>;
    ingest: { count: number; p50Ms: number; p95Ms: number; maxMs: number };
    errors: string[]; rawProof: RawProof[];
}
export interface BurstDisposal {
    activeEventSources: number; rootConnected: boolean; handlerCount: number;
    retiredPending: boolean; errors: string[];
}
declare global {
    interface Window {
        __wp29Probe: {
            prepare(binding: BurstBinding): Promise<void>;
            snapshot(): BurstBrowserSnapshot;
            disposeCycle(): Promise<BurstDisposal>;
            takeBulkCapture(): { receivedCount: number; html: string };
            readDiagnostics(): { timeOrigin: number; now: number; reads: ProbeReadDiagnostic[]; disposals: ProbeDisposalDiagnostic[] };
        };
    }
}

// Independent literal expectations, never imported from the Node generator.
const PROTOCOL = 'wp29-burst-v2';
const SPEC = '512x4096+129-small-v1';
const TOTAL = 643;
const MAX_ERRORS = 64;
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
function requireFact(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const decimal = (value: number, width: number) => String(value).padStart(width, '0');
const finalFor = (binding: BurstBinding) => `WP29 cycle ${decimal(binding.cycle.index, 2)} final`;
function nextCycle(previous: BurstCycle | null): BurstCycle | null {
    if (!previous) return { phase: 'preflight', index: 1 };
    if (previous.index < (previous.phase === 'measured' ? 20 : 5))
        return { phase: previous.phase, index: previous.index + 1 };
    if (previous.phase === 'preflight') return { phase: 'warmup', index: 1 };
    if (previous.phase === 'warmup') return { phase: 'measured', index: 1 };
    return null;
}
function bindingFrom(value: unknown): BurstBinding {
    requireFact(record(value) && exactKeys(value, ['protocol', 'cycle', 'sessionId', 'scope', 'runId', 'turnId', 'specId']), 'binding_shape');
    requireFact(value.protocol === PROTOCOL && value.specId === SPEC, 'binding_protocol');
    requireFact(record(value.cycle) && exactKeys(value.cycle, ['phase', 'index']), 'cycle_shape');
    const { phase, index } = value.cycle;
    requireFact((phase === 'preflight' || phase === 'warmup' || phase === 'measured')
        && typeof index === 'number' && Number.isSafeInteger(index)
        && index >= 1 && index <= (phase === 'measured' ? 20 : 5), 'cycle_range');
    for (const key of ['sessionId', 'scope', 'runId', 'turnId'])
        requireFact(typeof value[key] === 'string' && /^[A-Za-z0-9:_-]{1,240}$/.test(value[key]), 'binding_identity');
    requireFact(value.turnId === value.runId, 'binding_turn');
    return Object.freeze({ protocol: PROTOCOL, specId: SPEC, cycle: Object.freeze({ phase, index }),
        sessionId: value.sessionId as string, scope: value.scope as string,
        runId: value.runId as string, turnId: value.turnId as string });
}
function sameBinding(a: BurstBinding, b: BurstBinding): boolean {
    return a.protocol === b.protocol && a.specId === b.specId && a.cycle.phase === b.cycle.phase
        && a.cycle.index === b.cycle.index && a.sessionId === b.sessionId && a.scope === b.scope
        && a.runId === b.runId && a.turnId === b.turnId;
}

interface CycleState {
    token: number; binding: BurstBinding; retired: boolean; ready: boolean; opened: number;
    terminal: boolean; received: number; ingested: number; suppressed: number; retiredBaseline: number;
    lastSeq: number | null; firstBulkSeq: number | null; lastTailSeq: number | null;
    bulk: BurstPreview | null; final: BurstPreview | null; finalText: string | null;
    message: HTMLElement | null; rawUi: HTMLOutputElement | null;
    controls: ControlObservation[]; frames: Array<[number, number]>;
    timings: Float64Array; timingCount: number; errors: string[]; rawProof: RawProof[];
    abort: AbortController; unsubscribe: (() => void) | null;
    timers: Set<number>; animationFrames: Set<number>; rawPending: Promise<void> | null;
}
let current: CycleState | null = null;
let previous: BurstBinding | null = null;
let serial = 0, activeEventSources = 0, maxEventSources = 0, subscriptions = 0;
// Native construction/close changes this after prepare's initial zero check.
function activeSourceCount(): number { return activeEventSources; }
let retiredCallbackHitsTotal = 0;
let retiredUnsubscribe: (() => void) | null = null;
let retiredRemovalQueued = false;
let pageDisposed = false;
let lastSnapshot: BurstBrowserSnapshot | null = null;
let disposing: Promise<BurstDisposal> | null = null;
let localeReady: Promise<void> | null = null;
let bulkCapture: { receivedCount: number; html: string } | null = null;
interface ProbeReadDiagnostic {
    id: string; path: string; cycle: BurstCycle; startedAt: number; endedAt: number | null;
    doneAt: number | null; timeoutAt: number | null; cycleAbortAt: number | null;
    requireFactAt: number | null; error: string | null;
}
interface ProbeDisposalDiagnostic { cycle: BurstCycle; enteredAt: number; abortAt: number | null }
const readDiagnostics: ProbeReadDiagnostic[] = [], disposalDiagnostics: ProbeDisposalDiagnostic[] = [];
let readSerial = 0;
const pageErrors: string[] = [];
function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180);
}
function note(error: unknown, cycle: CycleState | null = current): void {
    const errors = cycle?.errors ?? pageErrors;
    if (errors.length < MAX_ERRORS) errors.push(errorText(error));
}
const live = (cycle: CycleState) => current === cycle && !cycle.retired && !pageDisposed;

// Pass-through native construction/close, with no strong collection of sources.
const NativeEventSource = window.EventSource;
const sourceOpen = new WeakMap<EventSource, boolean>();
class ObservedEventSource extends NativeEventSource {
    constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        sourceOpen.set(this, true);
        activeEventSources++;
        maxEventSources = Math.max(maxEventSources, activeEventSources);
        if (activeEventSources > 1) note('multiple_event_sources');
    }
    override close(): void {
        super.close();
        if (sourceOpen.get(this)) { sourceOpen.set(this, false); activeEventSources--; }
    }
}
function subscribe(topic: string, event: string | null, callback: (data: Record<string, unknown>) => void): () => void {
    const remove = subscribeChannel(topic, event, callback);
    subscriptions++;
    let removed = false;
    return () => { if (!removed) { removed = true; remove(); subscriptions--; } };
}

// Per-request byte/time bounds; response payloads never enter retained telemetry.
async function readJson(cycle: CycleState, path: string, limit: number): Promise<unknown> {
    const diagnostic: ProbeReadDiagnostic = { id: String(++readSerial), path, cycle: { ...cycle.binding.cycle },
        startedAt: performance.now(), endedAt: null, doneAt: null, timeoutAt: null, cycleAbortAt: null,
        requireFactAt: null, error: null };
    if (readDiagnostics.length === 128) readDiagnostics.shift();
    readDiagnostics.push(diagnostic);
    const controller = new AbortController();
    const abort = () => { diagnostic.cycleAbortAt = performance.now(); controller.abort(); };
    cycle.abort.signal.addEventListener('abort', abort, { once: true });
    if (cycle.abort.signal.aborted) abort();
    const timer = window.setTimeout(() => { diagnostic.timeoutAt = performance.now(); controller.abort(); }, 5000);
    try {
        const response = await fetch(path, { signal: controller.signal, credentials: 'same-origin',
            headers: { Accept: 'application/json', 'x-wp29-read-id': diagnostic.id } });
        if (!response.ok || !response.headers.get('content-type')?.includes('json') || !response.body) {
            await response.body?.cancel(); throw new Error(`read_status_${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0, text = '';
        let completed = false;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) { completed = true; diagnostic.doneAt = performance.now(); break; }
                bytes += part.value.byteLength;
                if (bytes > limit) diagnostic.requireFactAt = performance.now();
                requireFact(bytes <= limit, 'read_size_limit');
                text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
            return JSON.parse(text) as unknown;
        } finally {
            if (!completed) await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    } catch (error) {
        diagnostic.error = errorText(error); throw error;
    } finally {
        diagnostic.endedAt = performance.now();
        clearTimeout(timer); cycle.abort.signal.removeEventListener('abort', abort);
    }
}
function outputMatches(value: unknown, binding: BurstBinding, index: number): value is string {
    if (typeof value !== 'string' || value.length !== 4096
        || !value.startsWith(`C${decimal(binding.cycle.index, 2)}B${decimal(index, 4)}|`)
        || !value.endsWith(`|END${decimal(index, 4)}`)) return false;
    for (let i = 9; i < 4088; i++) if (value.charCodeAt(i) !== 120) return false;
    return true;
}
function checkEvent(cycle: CycleState, event: RuntimeEvent): void {
    const binding = cycle.binding, ordinal = cycle.received;
    requireFact(event.runId === binding.runId && event.turnId === binding.turnId
        && event.sessionId === binding.sessionId && event.scope === binding.scope
        && event.parentItemId === undefined, 'event_identity');
    requireFact(cycle.lastSeq === null || event.seq > cycle.lastSeq, 'event_sequence');
    requireFact(ordinal <= TOTAL && !cycle.terminal, 'event_after_terminal');
    if (ordinal === 1) requireFact(event.kind === 'turn-start' && event.provider === 'fixture', 'start_body');
    else if (ordinal <= 513) {
        const index = ordinal - 2, id = decimal(index, 4);
        requireFact(event.kind === 'tool' && event.itemId === `bulk-${id}` && event.name === `tool-${id}`
            && event.status === 'done' && event.input === undefined && event.detail === undefined
            && outputMatches(event.output, binding, index), 'bulk_body');
    } else if (ordinal <= 642) {
        const id = decimal(ordinal - 514, 4);
        requireFact(event.kind === 'tool' && event.itemId === `tail-${id}` && event.name === `tail-${id}`
            && event.status === 'done' && event.output === 'ok' && event.input === undefined
            && event.detail === undefined, 'tail_body');
    } else requireFact(event.kind === 'turn-end' && event.status === 'done'
        && event.finalText === finalFor(binding) && event.error === undefined, 'terminal_body');
}
function preview(cycle: CycleState): BurstPreview {
    const turn = findLiveActivity(cycle.binding.runId);
    requireFact(turn, 'missing_live_turn');
    let observedFieldChars = 0;
    for (const entry of turn.model.entries.values()) {
        requireFact(entry.kind === 'tool', 'unexpected_preview_kind');
        observedFieldChars += entry.name.length + (entry.input?.length ?? 0)
            + (entry.output?.length ?? 0) + (entry.detail?.length ?? 0);
    }
    const ids = [...turn.model.entries.keys()];
    requireFact(ids.length <= 128, 'preview_id_limit');
    const root = turn.view.element;
    for (const node of root.querySelectorAll<HTMLElement>('.activity-item')) {
        const id = node.dataset.activityItemId ?? '';
        // Bulk outputs arrive as 4096-byte fields; retention keeps the 9-char
        // name then gives output the remaining 4087 chars, cutting it mid-body.
        const expected = id.startsWith('bulk-')
            ? `C${decimal(cycle.binding.cycle.index, 2)}B${id.slice(5)}|${'x'.repeat(4078)}`
            : 'ok';
        requireFact(node.querySelector('.activity-item-text')?.textContent === expected, 'visible_preview_oracle');
    }
    return { entryCount: turn.model.entries.size, retainedChars: activityRetainedChars(turn.model), observedFieldChars,
        omittedEntries: turn.model.omitted.entries, omittedTextChars: turn.model.omitted.textChars,
        latestAction: turn.model.latestAction, retainedIds: ids, visibleRows: root.querySelectorAll('.activity-item').length,
        omissionVisible: root.querySelector<HTMLElement>('.activity-omitted')?.checkVisibility() === true };
}
function checkPreview(value: BurstPreview, bulk: boolean): void {
    requireFact(value.entryCount === (bulk ? 16 : 128) && value.retainedChars === (bulk ? 65536 : 1408)
        && value.observedFieldChars === (bulk ? 65536 : 1408) && value.omittedEntries === (bulk ? 496 : 513)
        && value.omittedTextChars === 4608 && value.latestAction === (bulk ? 'tool-0511 (done)' : 'tail-0128 (done)')
        && value.visibleRows === (bulk ? 16 : 8) && value.omissionVisible, bulk ? 'bulk_preview_oracle' : 'tail_preview_oracle');
    requireFact(value.retainedIds.every((id, index) => id === (bulk ? `bulk-${decimal(index + 496, 4)}` : `tail-${decimal(index + 1, 4)}`)), 'retained_ids_oracle');
}

function frame(cycle: CycleState, callback: (timestamp: number) => void): void {
    const id = requestAnimationFrame(timestamp => {
        cycle.animationFrames.delete(id);
        if (live(cycle)) callback(timestamp);
    });
    cycle.animationFrames.add(id);
}
function observeFrame(cycle: CycleState): void {
    frame(cycle, timestamp => {
        if (cycle.frames.length === 128) cycle.frames.shift();
        cycle.frames.push([timestamp, cycle.received]);
        if (!cycle.terminal) observeFrame(cycle);
    });
}
function queueControl(cycle: CycleState): void {
    requireFact(cycle.controls.length < 3, 'control_limit');
    const observation: ControlObservation = { queuedAt: performance.now(), completedAt: null, frameAt: null,
        queuedOrdinal: cycle.received, completedOrdinal: null, frameOrdinal: null, open: null };
    cycle.controls.push(observation);
    const timer = window.setTimeout(() => {
        cycle.timers.delete(timer);
        if (!live(cycle)) return;
        try {
            const summary = cycle.message?.querySelector<HTMLElement>('.activity-summary');
            const disclosure = cycle.message?.querySelector<HTMLDetailsElement>('.activity-disclosure');
            requireFact(summary && disclosure, 'control_missing_disclosure');
            const before = disclosure.open;
            summary.click(); // Real native summary default action, not a model setter.
            observation.completedAt = performance.now(); observation.completedOrdinal = cycle.received;
            observation.open = disclosure.open;
            requireFact(before !== disclosure.open, 'control_did_not_toggle');
            frame(cycle, timestamp => { observation.frameAt = timestamp; observation.frameOrdinal = cycle.received; });
        } catch (error) { note(error, cycle); }
    }, 0);
    cycle.timers.add(timer);
}
function removeRetiredAfterDispatch(): void {
    if (retiredRemovalQueued) return;
    retiredRemovalQueued = true;
    queueMicrotask(() => {
        retiredUnsubscribe?.(); retiredUnsubscribe = null; retiredRemovalQueued = false;
    });
}
// Separate lexical environment: a deliberately retained subscriber must never
// capture prepare()'s CycleState through a shared closure environment.
function callbackForToken(token: number): (wire: Record<string, unknown>) => void {
    return wire => receive(token, wire);
}
function receive(token: number, wire: Record<string, unknown>): void {
    const cycle = current;
    if (!cycle || cycle.retired || cycle.token !== token) {
        retiredCallbackHitsTotal++;
        // Splicing event-channel's live subscription array synchronously skips
        // the current subscriber. Retire only after this dispatch has finished.
        removeRetiredAfterDispatch(); return;
    }
    cycle.received++;
    try {
        requireFact(wire.sseReplay !== true, 'replayed_runtime_frame');
        const event = parseRuntimeEvent(wire);
        requireFact(event, 'invalid_runtime_frame');
        checkEvent(cycle, event);
        cycle.lastSeq = event.seq;
        if (cycle.received === 1) observeFrame(cycle);
        if (cycle.received === 2) cycle.firstBulkSeq = event.seq;
        if (cycle.received === 642) cycle.lastTailSeq = event.seq;
        // Fixed preflight4 only: counted wire frame, deliberately no ingest.
        if (cycle.binding.cycle.phase === 'preflight' && cycle.binding.cycle.index === 4 && cycle.received === 129) {
            cycle.suppressed++; return;
        }
        const start = performance.now();
        let turn: ReturnType<typeof ingestLiveActivity>;
        try { turn = ingestLiveActivity(event); }
        finally {
            if (cycle.timingCount < TOTAL) cycle.timings[cycle.timingCount++] = performance.now() - start;
        }
        requireFact(turn && turn.model.seq === event.seq, 'ingest_rejected');
        cycle.ingested++;
        if ([65, 257, 449].includes(cycle.received)) queueControl(cycle);
        if (cycle.received === 513) {
            cycle.bulk = preview(cycle); checkPreview(cycle.bulk, true);
            if (cycle.binding.cycle.phase === 'preflight' && cycle.binding.cycle.index === 1) {
                const html = turn.view.element.outerHTML;
                requireFact(new TextEncoder().encode(html).byteLength <= 131072, 'bulk_capture_bound');
                bulkCapture = { receivedCount: cycle.received, html };
            }
        }
        if (cycle.received === 642) {
            cycle.final = preview(cycle); checkPreview(cycle.final, false);
        }
        if (event.kind === 'turn-end') {
            cycle.terminal = true;
            cycle.finalText = event.finalText;
            replaceAgentAnswer(turn.message, event.finalText ?? '');
            cycle.final = preview(cycle);
            requireFact(cycle.received === TOTAL && cycle.ingested === TOTAL, 'ingestion_count_oracle');
            requireFact(cycle.controls.some(control => control.completedOrdinal !== null && control.frameOrdinal !== null
                && control.completedOrdinal < TOTAL && control.frameOrdinal < TOTAL), 'control_not_serviced_before_terminal');
        }
    } catch (error) { note(error, cycle); }
}

function rawFields(value: unknown, binding: BurstBinding): Record<string, unknown> {
    requireFact(record(value) && value.turnId === binding.turnId && Array.isArray(value.fields)
        && value.fields.length <= 8 && exactKeys(value, ['turnId', 'fields']), 'raw_codec_shape');
    const fields: Record<string, unknown> = Object.create(null);
    for (const pair of value.fields) {
        requireFact(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string'
            && ['kind', 'itemId', 'name', 'status', 'output'].includes(pair[0])
            && !Object.hasOwn(fields, pair[0]), 'raw_field_tuple');
        fields[pair[0]] = pair[1];
    }
    requireFact(exactKeys(fields, ['kind', 'itemId', 'name', 'status', 'output']), 'raw_field_keys');
    return fields;
}
async function inspect(cycle: CycleState): Promise<void> {
    requireFact(cycle.terminal && cycle.firstBulkSeq !== null && cycle.lastTailSeq !== null, 'raw_before_terminal');
    for (const [seq, bulk] of [[cycle.firstBulkSeq, true], [cycle.lastTailSeq, false]] as const) {
        const binding = cycle.binding;
        const envelope = await readJson(cycle, `/api/traces/${encodeURIComponent(binding.runId)}/events/${seq}?session=${encodeURIComponent(binding.sessionId)}`, 65536);
        requireFact(live(cycle) && record(envelope) && envelope.ok === true && record(envelope.data), 'raw_envelope');
        const data = envelope.data;
        requireFact(data.runId === binding.runId && data.seq === seq && data.source === 'runtime'
            && data.eventType === 'tool' && data.retentionStatus === 'available'
            && typeof data.raw === 'string' && data.raw.length > 0 && data.raw.length <= 32768, 'raw_identity');
        const fields = rawFields(JSON.parse(data.raw), binding);
        requireFact(fields.kind === 'tool' && fields.status === 'done'
            && fields.itemId === (bulk ? 'bulk-0000' : 'tail-0128')
            && fields.name === (bulk ? 'tool-0000' : 'tail-0128'), 'raw_body');
        const output = fields.output;
        requireFact(bulk ? outputMatches(output, binding, 0) : output === 'ok', 'raw_output');
        requireFact(typeof output === 'string', 'raw_output_type');
        cycle.rawProof.push({ runId: binding.runId, seq, outputBytes: output.length,
            prefix: bulk ? output.slice(0, 9) : output, suffix: bulk ? output.slice(-8) : output });
    }
    if (live(cycle)) {
        const output = document.createElement('output');
        output.id = 'wp29-raw-proof'; output.setAttribute('role', 'status');
        output.textContent = 'Two owned Trace reads verified: bulk 4096 bytes; compact ok.';
        cycle.message?.after(output); cycle.rawUi = output;
    }
}

function freshSnapshot(): BurstBrowserSnapshot {
    return { protocol: PROTOCOL, binding: null, ready: false, terminal: false,
        receivedCount: 0, ingestedCount: 0, retiredCallbackHits: 0, retiredCallbackHitsTotal,
        suppressedIngestions: 0, activeEventSources, maxEventSources, bulk: null, final: null,
        finalText: null, finalDomRaw: null, finalDomText: null, answerCount: 0,
        controls: [], frames: [], ingest: { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 }, errors: [], rawProof: [] };
}
function snapshot(): BurstBrowserSnapshot {
    const cycle = current;
    let result: BurstBrowserSnapshot;
    if (!cycle) result = { ...(lastSnapshot ?? freshSnapshot()), activeEventSources, maxEventSources, retiredCallbackHitsTotal,
        errors: [...pageErrors, ...(lastSnapshot?.errors ?? [])].slice(0, MAX_ERRORS) };
    else {
        const timings = Array.from(cycle.timings.subarray(0, cycle.timingCount)).sort((a, b) => a - b);
        const quantile = (fraction: number) => timings[Math.max(0, Math.ceil(timings.length * fraction) - 1)] ?? 0;
        const content = cycle.message?.querySelector<HTMLElement>('.msg-content');
        result = { protocol: PROTOCOL, binding: cycle.binding, ready: cycle.ready, terminal: cycle.terminal,
            receivedCount: cycle.received, ingestedCount: cycle.ingested,
            retiredCallbackHits: retiredCallbackHitsTotal - cycle.retiredBaseline, retiredCallbackHitsTotal,
            suppressedIngestions: cycle.suppressed, activeEventSources, maxEventSources,
            bulk: cycle.bulk, final: cycle.final && live(cycle) ? preview(cycle) : cycle.final,
            finalText: cycle.finalText, finalDomRaw: cycle.terminal ? content?.getAttribute('data-raw') ?? null : null,
            finalDomText: cycle.terminal ? content?.innerText ?? null : null,
            answerCount: document.querySelectorAll('#chatMessages .msg-agent').length,
            controls: cycle.controls, frames: cycle.frames,
            ingest: { count: cycle.timingCount, p50Ms: quantile(0.5), p95Ms: quantile(0.95), maxMs: quantile(1) },
            errors: [...pageErrors, ...cycle.errors].slice(0, MAX_ERRORS), rawProof: cycle.rawProof };
    }
    // No DOM/model/event references escape. Returned scalars cannot mutate proof.
    const encoded = JSON.stringify(result);
    requireFact(new TextEncoder().encode(encoded).byteLength <= 32768, 'snapshot_size_limit');
    return JSON.parse(encoded) as BurstBrowserSnapshot;
}
function waitWhilePreparing<T>(cycle: CycleState, work: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, value?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); cycle.timers.delete(timer);
            cycle.abort.signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value as T);
        };
        const abort = () => finish(new Error('prepare_aborted'));
        const timer = window.setTimeout(() => finish(new Error('prepare_timeout')), milliseconds);
        cycle.timers.add(timer);
        cycle.abort.signal.addEventListener('abort', abort, { once: true });
        if (cycle.abort.signal.aborted) abort();
        work.then(value => finish(null, value), error => finish(new Error(errorText(error))));
    });
}
function preparationTick(cycle: CycleState): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (aborted: boolean) => {
            clearTimeout(timer); cycle.timers.delete(timer);
            cycle.abort.signal.removeEventListener('abort', abort);
            if (aborted) reject(new Error('prepare_aborted')); else resolve();
        };
        const abort = () => finish(true);
        const timer = window.setTimeout(() => finish(false), 20);
        cycle.timers.add(timer);
        cycle.abort.signal.addEventListener('abort', abort, { once: true });
        if (cycle.abort.signal.aborted) abort();
    });
}
async function prepare(binding: BurstBinding): Promise<void> {
    const next = bindingFrom(binding), expected = nextCycle(previous?.cycle ?? null);
    requireFact(!pageDisposed && !current && !disposing && activeEventSources === 0, 'prepare_not_idle');
    requireFact(expected && expected.phase === next.cycle.phase && expected.index === next.cycle.index, 'prepare_order');
    if (previous) requireFact(previous.sessionId === next.sessionId && previous.scope === next.scope
        && previous.runId !== next.runId, 'prepare_owner');
    requireFact(location.protocol === 'http:' && location.hostname === '127.0.0.1'
        && location.pathname === '/burst-fixture', 'fixture_origin');
    requireFact(document.getElementById('chatMessages') && !state.currentAgentDiv
        && !document.querySelector('#chatMessages .msg-agent'), 'fixture_host_not_empty');
    const cycle: CycleState = { token: ++serial, binding: next, retired: false, ready: false, opened: 0,
        terminal: false, received: 0, ingested: 0, suppressed: 0, retiredBaseline: retiredCallbackHitsTotal,
        lastSeq: null, firstBulkSeq: null, lastTailSeq: null, bulk: null, final: null, finalText: null,
        message: null, rawUi: null, controls: [], frames: [], timings: new Float64Array(TOTAL), timingCount: 0,
        errors: [], rawProof: [], abort: new AbortController(), unsubscribe: null,
        timers: new Set(), animationFrames: new Set(), rawPending: null };
    current = cycle; previous = next; lastSnapshot = null;
    try {
        await waitWhilePreparing(cycle, localeReady ??= initI18n(), 10000);
        requireFact(live(cycle), 'prepare_disposed');
        setLiveActivityIdentity({ sessionId: next.sessionId, scope: next.scope });
        setActivityTransportHealthy(true);
        // This closure captures only a number, not the retired cycle/model/DOM.
        cycle.unsubscribe = subscribe('agent', 'agent_runtime', callbackForToken(cycle.token));
        connectEventChannel('en');
        const deadline = performance.now() + 10000;
        for (;;) {
            requireFact(live(cycle) && cycle.errors.length === 0 && performance.now() < deadline, 'prepare_channel_failed');
            if (cycle.opened === 1) {
                const response = await readJson(cycle, '/__probe/metrics', 32768);
                requireFact(record(response) && response.ok === true && record(response.data), 'metrics_envelope');
                const metrics = response.data;
                requireFact(metrics.protocol === PROTOCOL && metrics.state === 'prepared'
                    && sameBinding(bindingFrom(metrics.binding), next) && record(metrics.sse), 'metrics_binding');
                if (metrics.sse.activeConnections === 1) break;
            }
            await preparationTick(cycle);
        }
        requireFact(activeSourceCount() === 1 && subscriptions === (retiredUnsubscribe ? 3 : 2), 'subscription_baseline');
        cycle.ready = true;
    } catch (error) { note(error, cycle); throw error; }
}
function boundary(): Promise<boolean> {
    return new Promise(resolve => {
        const timeout = window.setTimeout(() => { cancelAnimationFrame(id); resolve(false); }, 2000);
        const id = requestAnimationFrame(() => { clearTimeout(timeout); resolve(true); });
    });
}
async function dispose(): Promise<BurstDisposal> {
    const cycle = current;
    if (!cycle) return { activeEventSources, rootConnected: false, handlerCount: 0,
        retiredPending: !!retiredUnsubscribe, errors: activeEventSources ? ['disposal_source_still_active'] : [] };
    const disposalErrors: string[] = [];
    const diagnostic: ProbeDisposalDiagnostic = { cycle: { ...cycle.binding.cycle }, enteredAt: performance.now(), abortAt: null };
    if (disposalDiagnostics.length === 64) disposalDiagnostics.shift();
    disposalDiagnostics.push(diagnostic);
    cycle.retired = true; cycle.ready = false;
    bulkCapture = null;
    if (cycle.binding.cycle.phase === 'preflight' && cycle.binding.cycle.index === 2 && cycle.unsubscribe) {
        requireFact(!retiredUnsubscribe, 'retired_already_pending');
        retiredUnsubscribe = cycle.unsubscribe; // One scalar-only retired callback for preflight3.
    } else cycle.unsubscribe?.();
    cycle.unsubscribe = null;
    closeEventChannel(); diagnostic.abortAt = performance.now(); cycle.abort.abort();
    for (const timer of cycle.timers) clearTimeout(timer); cycle.timers.clear();
    for (const id of cycle.animationFrames) cancelAnimationFrame(id); cycle.animationFrames.clear();
    await cycle.rawPending;
    lastSnapshot = snapshot();
    let root: HTMLElement | null = findLiveActivity(cycle.binding.runId)?.view.element ?? null;
    clearLiveActivity(); cancelPostRender(); getVirtualScroll().clear(); cleanupToolActivity();
    cycle.rawUi?.remove(); cycle.rawUi = null;
    cycle.message?.remove(); cycle.message = null;
    const rootConnected = root?.isConnected ?? false;
    let handlerCount = 0;
    for (const node of root ? [root, ...root.querySelectorAll<HTMLElement>('*')] : []) {
        if (node.onclick) handlerCount++;
        if ((node as HTMLDetailsElement).ontoggle) handlerCount++;
    }
    root = null; current = null;
    if (rootConnected || handlerCount || activeEventSources !== 0 || subscriptions !== (retiredUnsubscribe ? 2 : 1))
        disposalErrors.push('disposal_resource_oracle');
    if (!(await boundary()) || !(await boundary())) disposalErrors.push('disposal_frame_timeout');
    return { activeEventSources, rootConnected, handlerCount, retiredPending: !!retiredUnsubscribe,
        errors: disposalErrors };
}
function disposeCycle(): Promise<BurstDisposal> {
    if (!disposing) disposing = dispose().finally(() => { disposing = null; });
    return disposing;
}

requireFact(!window.__wp29Probe, 'duplicate_burst_fixture');
window.EventSource = ObservedEventSource;
setEventChannelScopeProvider(() => current?.binding.scope ?? null);
const removeSentinel = subscribe('*', null, wire => {
    if (wire.sseReplay === true || (wire.topic === 'system' && wire.event === 'replay_gap')) note('transport_replay_or_gap');
});
onChannelOpen(() => {
    if (!current || current.retired) { note('open_without_cycle'); return; }
    if (++current.opened !== 1) note('same_cycle_reconnect');
});
onChannelDisconnect(() => { if (current && !current.retired) { setActivityTransportHealthy(false); note('channel_disconnect'); } });
onChannelUnavailable(() => { if (current && !current.retired) note('channel_unavailable'); });
configureLiveActivityHost({
    currentMessage: () => state.currentAgentDiv,
    useMessage: message => {
        requireFact(current && live(current), 'host_without_cycle');
        state.currentAgentDiv = message; current.message = message;
    },
    createMessage: () => { cleanupToolActivity(); return addMessage('agent', '', 'fixture'); },
    reconcileMessage: (id, update) => getVirtualScroll().reconcileMessage(id, update),
    replaceAnswer: replaceAgentAnswer,
    inspectTrace: (runId, sessionId) => {
        const cycle = current;
        if (!cycle || !live(cycle)) return;
        if (runId !== cycle.binding.runId || sessionId !== cycle.binding.sessionId) { note('inspect_owner', cycle); return; }
        if (cycle.rawPending || cycle.rawProof.length) return;
        cycle.rawPending = inspect(cycle).catch(error => { if (!cycle.retired) note(error, cycle); })
            .finally(() => { cycle.rawPending = null; });
    },
});
window.__wp29Probe = Object.freeze({ prepare, snapshot, disposeCycle,
readDiagnostics() { return { timeOrigin: performance.timeOrigin, now: performance.now(),
    reads: readDiagnostics.map(row => ({ ...row, cycle: { ...row.cycle } })),
    disposals: disposalDiagnostics.map(row => ({ ...row, cycle: { ...row.cycle } })) }; },
takeBulkCapture() {
    requireFact(bulkCapture, 'bulk_capture_unavailable');
    const capture = bulkCapture; bulkCapture = null; return capture;
} });
window.addEventListener('pagehide', () => {
    pageDisposed = true;
    void disposeCycle().finally(() => {
        retiredUnsubscribe?.(); retiredUnsubscribe = null; removeSentinel();
        setEventChannelScopeProvider(null); window.EventSource = NativeEventSource;
    });
}, { once: true });
