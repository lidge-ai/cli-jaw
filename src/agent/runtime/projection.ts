import { createHash } from 'node:crypto';
import { publish } from '../../core/event-bus.js';
import { redactRuntimeContent } from '../../trace/runtime-body-codec.js';
import { FULLTEXT_MAX_CHARS } from '../events/fulltext-bound.js';
import type { RuntimeEvent, RuntimeEventBody, RuntimePhase } from '../../shared/runtime-contract.js';
import { recordRuntimeEvent, recordRuntimeProjectionLoss, type RuntimeEventContext } from './events.js';

export type RuntimeEnd = Extract<RuntimeEventBody, { kind: 'turn-end' }>;
type Tool = Extract<RuntimeEventBody, { kind: 'tool' }>;
type Preview = Extract<RuntimeEventBody, { kind: 'tool' | 'message' | 'reasoning' }>;
type Notice = 'capacity' | 'truncated' | 'persistence' | 'malformed' | 'missing-id';
type Recorder = (context: RuntimeEventContext, body: RuntimeEventBody) => RuntimeEvent | null;
export type RuntimeToolPatch = { semantic?: 'file_change'; fileChanges?: unknown; name?: string; status?: Tool['status']; input?: string;
    output?: string; delta?: string; detail?: string; inputStructured?: boolean; outputStructured?: boolean };
/** Trusted raw patches. The owner must latch write failures before returning or throwing. */
export interface RuntimeTranscriptObserver {
    text(kind: 'message' | 'reasoning', nativeRef: string, value: string,
        operation: 'append' | 'replace', phase: RuntimePhase): void;
    tool(nativeRef: string, patch: RuntimeToolPatch, options: { allowTerminalUpdates?: boolean }): void;
    close(end: RuntimeEnd): void;
}
type SourcePreview = { value: string; structured: boolean; retired: boolean };
const MAX_ITEMS = 160;
const FIELD_CHARS = 3000;
const TOTAL_JSON_CHARS = 24000;
const SNAPSHOT_JSON_CHARS = 64000;
const WITHHELD_PREVIEW = '[structured content withheld]';

export class RuntimeProjection {
    private readonly items = new Map<string, Preview>();
    private readonly notices = new Set<Notice>();
    private readonly sources = new Map<string, SourcePreview>();
    private sourceChars = 0;
    private started = false;
    private ended = false;
    private closingTranscript = false;
    private recordingFailed = false;
    private gapReported = false;
    private nextItem = 0;
    private total = 0;
    private lastSeq: number | null = null;

    constructor(
        private readonly context: RuntimeEventContext,
        private readonly record: Recorder = recordRuntimeEvent,
        private readonly notify: (reason: Notice) => void = (reason) => {
            console.warn('[runtime:projection]', reason, context.runId);
        },
        private readonly observer?: RuntimeTranscriptObserver,
        private readonly recordLoss: typeof recordRuntimeProjectionLoss | undefined =
            record === recordRuntimeEvent ? recordRuntimeProjectionLoss : undefined,
    ) {}

    report(reason: Notice): void {
        if (!this.notices.has(reason) && (reason === 'capacity' || reason === 'truncated')) {
            try { this.recordLoss?.(this.context); }
            catch { this.report('persistence'); }
        }
        if (reason === 'persistence') {
            if (this.recordingFailed) return;
            // Latch before publication: even a reentrant subscriber cannot write.
            this.recordingFailed = true;
            this.sources.clear();
            this.sourceChars = 0;
        }
        // Preview limits are not runtime failures. Report incomplete observation
        // without stopping liveness, terminal recording or provider execution.
        if (!this.gapReported && ['persistence', 'capacity', 'truncated'].includes(reason)
            && this.context.audience === 'public') {
            this.gapReported = true;
            try { publish('agent', 'agent_runtime_gap', {
                runId: this.context.runId, sessionId: this.context.sessionId,
                scope: this.context.scope, reason: 'projection_degraded',
            }); } catch { console.warn('[runtime:projection] gap delivery failed'); }
        }
        if (this.notices.has(reason)) return;
        this.notices.add(reason);
        try { this.notify(reason); }
        catch { console.warn('[runtime:projection] diagnostic delivery failed'); }
    }

    private emit(body: RuntimeEventBody): void {
        if (this.recordingFailed) return;
        try {
            const event = this.record(this.context, body);
            if (event) this.lastSeq = event.seq;
            else this.report('persistence');
        } catch { this.report('persistence'); }
    }

    start(provider: string): void {
        if (this.started || this.ended) return;
        this.started = true;
        this.emit({ kind: 'turn-start', provider });
    }

    private key(kind: Preview['kind'], nativeRef: string): string {
        return createHash('sha256').update(JSON.stringify([kind, nativeRef])).digest('hex');
    }

    /** Published display linkage only; never allocation or approval authority. */
    itemId(kind: Preview['kind'], nativeRef: string): string | null {
        if (this.recordingFailed) return null;
        return this.items.get(this.key(kind, nativeRef))?.itemId ?? null;
    }

    private id(key: string): string | null {
        const found = this.items.get(key);
        if (found) return found.itemId;
        if (this.items.size >= MAX_ITEMS) { this.report('capacity'); return null; }
        return 'item-' + (++this.nextItem);
    }

    private safePreview(body: Preview): Preview {
        let safe = body;
        const fields = body.kind === 'tool' ? ['name', 'input', 'output', 'detail'] : ['text'];
        for (const field of fields) {
            const value: unknown = Reflect.get(safe, field);
            if (typeof value !== 'string') continue;
            // Shared 041 policy sees the WHOLE source, never a clipped JSON prefix.
            // Known JSON input/output was reconstructed and sanitized by source().
            // Default prose mode here preserves Markdown, commands and answers.
            safe = { ...safe, [field]: redactRuntimeContent(value) };
        }
        return safe;
    }

    private source(key: string, field: string, value: string, append: boolean, hint?: boolean): string {
        if (this.recordingFailed) return WITHHELD_PREVIEW;
        const sourceKey = key + ':' + field;
        const old = this.sources.get(sourceKey);
        const structured = hint ?? old?.structured ?? false;
        if (append && old?.retired) return WITHHELD_PREVIEW;
        if (!old && this.sources.size >= MAX_ITEMS * 3) {
            this.report('capacity');
            return WITHHELD_PREVIEW;
        }
        const oldLength = old?.value.length ?? 0;
        const length = append ? oldLength + value.length : value.length;
        // Bound the private full-source accumulator BEFORE concatenating, never
        // retain a clipped JSON prefix and then append a later raw fragment to it.
        if (length > FULLTEXT_MAX_CHARS || this.sourceChars - oldLength + length > FULLTEXT_MAX_CHARS) {
            this.sourceChars -= oldLength;
            this.sources.set(sourceKey, { value: '', structured, retired: true });
            this.report('capacity');
            return WITHHELD_PREVIEW;
        }
        const full = append ? (old?.value ?? '') + value : value;
        this.sources.set(sourceKey, { value: full, structured, retired: false });
        this.sourceChars += full.length - oldLength;
        try { return redactRuntimeContent(full, { structured }); }
        catch { this.report('persistence'); return WITHHELD_PREVIEW; }
    }

    private save(key: string, body: Preview, preserveTerminal = false): void {
        if (this.ended || this.recordingFailed) return;
        const previous = this.items.get(key);
        const previousJson = previous ? JSON.stringify(previous) : '';
        const available = TOTAL_JSON_CHARS - this.total + previousJson.length;
        let next: Preview;
        try { next = this.safePreview(body); }
        catch { this.report('persistence'); return; }
        const fields = next.kind === 'tool' ? ['name', 'input', 'output', 'detail'] : ['text'];
        for (const field of fields) {
            const value: unknown = Reflect.get(next, field);
            const cap = field === 'name' ? 120 : FIELD_CHARS;
            if (typeof value === 'string' && value.length > cap) {
                next = { ...next, [field]: value.slice(0, cap) };
                this.report('truncated');
            }
        }
        let json = JSON.stringify(next);
        // Enrichment is optional. Never spend the budget by deleting already
        // authoritative terminal fields to make room for newly learned metadata.
        if (preserveTerminal && json.length > available) { this.report('capacity'); return; }
        // Charge JSON escaping too. Keep already retained IDs; no eviction/reopen.
        for (const field of fields.filter(field => field !== 'name').reverse()) {
            if (json.length <= available) break;
            const value: unknown = Reflect.get(next, field);
            if (typeof value !== 'string') continue;
            next = { ...next, [field]: '' };
            json = JSON.stringify(next);
            this.report('truncated');
        }
        if (json.length > available) { this.report('capacity'); return; }
        if (json === previousJson) return;
        this.items.set(key, next);
        this.total += json.length - previousJson.length;
        this.emit(next);
    }

    tool(nativeRef: string, patch: RuntimeToolPatch, options: { allowTerminalUpdates?: boolean } = {}): void {
        if (this.ended || this.recordingFailed || this.closingTranscript) return;
        try { this.observer?.tool(nativeRef, patch, options); }
        catch { this.report('persistence'); return; }
        if (this.ended || this.recordingFailed) return;
        const key = this.key('tool', nativeRef);
        const previous = this.items.get(key);
        const old = previous?.kind === 'tool' ? previous : undefined;
        const replaceTerminal = options.allowTerminalUpdates === true && patch.status !== undefined && patch.status !== 'running';
        if (old && old.status !== 'running' && !replaceTerminal) {
            // A result may precede its start. Fill only unknown metadata; terminal
            // status, output, detail and established fields remain authoritative.
            const name = (!old.name || old.name === 'tool') && patch.name ? patch.name : old.name;
            const input = old.input === undefined && patch.input !== undefined
                ? this.source(key, 'input', patch.input, false, patch.inputStructured) : old.input;
            this.save(key, { ...old, name, ...(input === undefined ? {} : { input }) }, true);
            return;
        }
        const itemId = this.id(key);
        if (!itemId) return;
        const body: Tool = { kind: 'tool', itemId, name: old?.name && old.name !== 'tool' ? old.name : patch.name || 'tool',
            status: patch.status ?? old?.status ?? 'running',
            ...(old?.input !== undefined ? { input: old.input } : {}),
            ...(old?.output !== undefined ? { output: old.output } : {}),
            ...(old?.detail !== undefined ? { detail: old.detail } : {}),
            ...(patch.input !== undefined ? { input: this.source(key, 'input', patch.input, false, patch.inputStructured) } : {}),
            ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
            ...(patch.output !== undefined ? { output: this.source(key, 'output', patch.output, false, patch.outputStructured) }
                : patch.delta !== undefined ? { output: this.source(key, 'output', patch.delta, true, patch.outputStructured) } : {}),
        };
        if (patch.delta && patch.delta.length > FIELD_CHARS) this.report('truncated');
        this.save(key, body);
    }

    text(kind: 'message' | 'reasoning', nativeRef: string, text: string,
        operation: 'append' | 'replace', phase: RuntimePhase = 'unknown'): void {
        if (this.ended || this.recordingFailed || this.closingTranscript) return;
        try { this.observer?.text(kind, nativeRef, text, operation, phase); }
        catch { this.report('persistence'); return; }
        if (this.ended || this.recordingFailed) return;
        const key = this.key(kind, nativeRef);
        const itemId = this.id(key);
        if (!itemId) return;
        const value = this.source(key, 'text', text, operation === 'append', false);
        if (text.length > FIELD_CHARS) this.report('truncated');
        this.save(key, kind === 'message'
            ? { kind, itemId, text: value, phase, operation: 'replace' }
            : { kind, itemId, text: value, operation: 'replace' });
    }

    usage(tokens: Record<string, number> | undefined): void {
        if (!tokens || this.ended) return;
        const body: Extract<RuntimeEventBody, { kind: 'usage' }> = { kind: 'usage' };
        const input = tokens['input_tokens'], output = tokens['output_tokens'];
        const cached = tokens['cached_input_tokens'];
        if (input !== undefined && Number.isSafeInteger(input) && input >= 0) body.inputTokens = input;
        if (output !== undefined && Number.isSafeInteger(output) && output >= 0) body.outputTokens = output;
        if (cached !== undefined && Number.isSafeInteger(cached) && cached >= 0) body.cachedTokens = cached;
        this.emit(body);
    }

    close(end: RuntimeEnd): void {
        if (this.ended || this.closingTranscript) return;
        this.closingTranscript = true;
        if (this.observer && !this.recordingFailed) {
            try { this.observer.close(end); }
            catch { this.report('persistence'); }
        }
        for (const [key, item] of this.items) {
            if (item.kind !== 'tool' || item.status !== 'running') continue;
            const status = end.status === 'error' ? 'error' : 'stopped';
            this.save(key, { ...item, status, detail: item.detail || 'No native terminal tool result received' });
            // The synthetic detail may not fit; retain existing fields while closing the tool.
            const current = this.items.get(key);
            if (current?.kind === 'tool' && current.status === 'running') this.save(key, { ...item, status }, true);
        }
        this.ended = true;
        this.emit(end);
        this.sources.clear();
        this.sourceChars = 0;
    }

    diagnostics(): { items: number; previewChars: number; snapshotChars: number;
        withinSnapshotCap: boolean; truncated: boolean; lastSeq: number | null; recordingFailed: boolean } {
        const snapshotChars = JSON.stringify([...this.items.values()]).length;
        return { items: this.items.size, previewChars: this.total, snapshotChars,
            withinSnapshotCap: snapshotChars <= SNAPSHOT_JSON_CHARS,
            truncated: this.notices.has('truncated') || this.notices.has('capacity'),
            lastSeq: this.lastSeq, recordingFailed: this.recordingFailed };
    }
}
