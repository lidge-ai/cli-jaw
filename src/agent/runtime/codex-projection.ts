import type { CodexAppEventResult } from '../codex-app-events.js';
import type { RuntimeItemStatus, RuntimePhase } from '../../shared/runtime-contract.js';
import { RuntimeProjection } from './projection.js';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};
const str = (x: unknown): string => typeof x === 'string' ? x : '';
const phaseOf = (x: string): RuntimePhase => x === 'commentary' || x === 'final' ? x : 'unknown';
function preview(x: unknown): string {
    if (x === undefined || x === null) return '';
    return typeof x === 'string' ? x : JSON.stringify(x) ?? '';
}
function parts(x: unknown): string {
    if (typeof x === 'string') return x;
    if (!Array.isArray(x)) return '';
    return x.map(p => typeof p === 'string' ? p : str(obj(p)['text'])).filter(Boolean).join('\n');
}
function completion(item: Obj): { status: RuntimeItemStatus; detail: string } {
    const raw = item['status'];
    const state = str(typeof raw === 'string' ? raw : obj(raw)['type']);
    const exit = item['exitCode'];
    if (['interrupted', 'cancelled', 'canceled', 'stopped'].includes(state)) return { status: 'stopped', detail: state };
    if (item['error'] != null || (typeof exit === 'number' && exit !== 0) || ['failed', 'error', 'declined'].includes(state)) {
        return { status: 'error', detail: item['error'] != null ? preview(item['error'])
            : 'Native status=' + state + '; exit=' + String(exit ?? '') };
    }
    if (['completed', 'done', 'success'].includes(state) || exit === 0) return { status: 'done', detail: state || 'exit=0' };
    // WebSearchItem has no status field in the app-server schema. For that
    // known variant item/completed itself is terminal, not a missing-state error.
    if (item['type'] === 'webSearch' && raw === undefined) return { status: 'done', detail: 'Search completed' };
    return { status: 'error', detail: 'Unknown native completion status: ' + (state || '(missing)') };
}

export class CodexProjection {
    constructor(private readonly projection: RuntimeProjection) {}

    observe(method: string, params: Obj, parsed: CodexAppEventResult | null, effectivePhase: string): void {
        try { this.accept(method, params, parsed, effectivePhase); }
        catch { this.projection.report('malformed'); }
    }

    private accept(method: string, params: Obj, parsed: CodexAppEventResult | null, effectivePhase: string): void {
        const id = str(params['itemId']);
        if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
            if (!id) { this.projection.report('missing-id'); return; }
            this.projection.text('message', id, params['delta'], 'append', phaseOf(effectivePhase));
        } else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
            if (!id) { this.projection.report('missing-id'); return; }
            if (typeof params['delta'] === 'string') this.projection.tool(id, { ...(method === 'item/fileChange/outputDelta' ? { semantic: 'file_change' as const } : {}), delta: params['delta'] });
        } else if (method === 'item/fileChange/patchUpdated') {
            if (!id) { this.projection.report('missing-id'); return; }
            this.projection.tool(id, { semantic: 'file_change', fileChanges: params['changes'] });
        } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
            if (!id) { this.projection.report('missing-id'); return; }
            const channel = method === 'item/reasoning/textDelta' ? 'text' : 'summary';
            if (typeof params['delta'] === 'string') this.projection.text('reasoning', id + '/' + channel, params['delta'], 'append');
        } else if (method === 'item/reasoning/summaryPartAdded') {
            if (id && typeof params['summaryIndex'] === 'number' && params['summaryIndex'] > 0) {
                this.projection.text('reasoning', id + '/summary', '\n', 'append');
            }
        } else if (method === 'item/started' || method === 'item/completed') {
            this.item(obj(params['item']), method === 'item/completed');
        } else if (method === 'thread/tokenUsage/updated') {
            this.projection.usage(parsed?.tokens);
        }
        // Native turn/error signals do not manufacture canonical answer/final.
    }

    private item(item: Obj, completed: boolean): void {
        const id = str(item['id']);
        const type = str(item['type']);
        if (type === 'agentMessage' || type === 'userMessage' || type === 'hookPrompt') return;
        if (!id) { this.projection.report('missing-id'); return; }
        if (type === 'reasoning') {
            const content = parts(item['content']), summary = parts(item['summary']);
            if (content) this.projection.text('reasoning', id + '/text', content, 'replace');
            if (summary) this.projection.text('reasoning', id + '/summary', summary, 'replace');
            return;
        }
        const names: Record<string, string> = {
            commandExecution: 'command', fileChange: 'file change', webSearch: 'web search',
            mcpToolCall: (str(item['server']) || 'mcp') + '/' + (str(item['tool']) || 'call'),
            collabAgentToolCall: 'sub-agent',
        };
        const name = Object.hasOwn(names, type) ? names[type] : undefined;
        if (!name) return;
        const inputValue = type === 'commandExecution' ? item['command']
            : type === 'fileChange' ? item['changes']
            : type === 'webSearch' ? item['query']
            : type === 'mcpToolCall' ? item['arguments'] : item['prompt'];
        const outputValue = item['aggregatedOutput'] ?? item['output'] ?? item['result'];
        this.projection.tool(id, {
            name,
            ...(type === 'fileChange' ? { semantic: 'file_change' as const, fileChanges: item['changes'] } : {}),
            ...(inputValue !== undefined ? { input: preview(inputValue),
                inputStructured: type === 'fileChange' || type === 'mcpToolCall' } : {}),
            ...(outputValue !== undefined ? { output: preview(outputValue),
                outputStructured: outputValue !== null && typeof outputValue === 'object' } : {}),
            ...(completed ? completion(item) : { status: 'running' as const }),
        });
    }
}
