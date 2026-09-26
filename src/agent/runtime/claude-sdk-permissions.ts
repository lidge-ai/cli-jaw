import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEventBody, RuntimeRequestView } from '../../shared/runtime-contract.js';
import { redactRuntimeContent, sanitizeRuntimeRequestView } from '../../trace/runtime-body-codec.js';
import type { RuntimeEventContext } from './events.js';
import type { RuntimeRequests } from './requests.js';

export interface ClaudePermissionOwner {
    context: RuntimeEventContext;
    isCurrent(): boolean;
    emit(body: RuntimeEventBody): void;
}
type CallbackOptions = Parameters<CanUseTool>[2];
type Decision = 'allow' | 'deny' | 'cancel';
type Answer = Decision | Record<string, string>;
type PreparedRequest = { view: RuntimeRequestView; requestType: 'approval' | 'question'; validate(value: unknown): Answer };
const INPUT_BYTES = 1024 * 1024;
const MAX_PENDING = 32;
const REVIEW_TITLE_CHARS = 500;
const FREEFORM_CHARS = 2000;
const TOTAL_FREEFORM_CHARS = 8000;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
    if (!record(value)) throw new Error('invalid_response');
    const keys = Reflect.ownKeys(value);
    if (required.some(key => !Object.hasOwn(value, key))
        || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
            || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
            || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('invalid_response');
}

export function encodeClaudeApprovalResponse(optionId: 'allow' | 'deny' | null) { return { optionId }; }
export function validateClaudeApprovalResponse(value: unknown): Decision {
    exact(value, ['optionId']);
    if (value['optionId'] === null) return 'cancel';
    if (value['optionId'] === 'allow' || value['optionId'] === 'deny') return value['optionId'];
    throw new Error('invalid_option');
}

/** SDK JSON only. Reject accessors, cycles and expansive trees before cloning/freezing. */
function snapshotInput(input: unknown): Record<string, unknown> {
    let budget = INPUT_BYTES, nodes = 0;
    const seen = new Set<object>();
    const consume = (bytes: number) => { budget -= bytes; if (budget < 0) throw new Error('input_limit'); };
    const quote = (value: string) => {
        if (value.length > budget) throw new Error('input_limit');
        consume(Buffer.byteLength(JSON.stringify(value)));
    };
    const copy = (value: unknown, depth: number): unknown => {
        if (++nodes > 32_768 || depth > 32) throw new Error('input_limit');
        if (typeof value === 'string') { quote(value); return value; }
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
            consume(String(value).length); return value;
        }
        if ((!record(value) && !Array.isArray(value)) || seen.has(value)) throw new Error('invalid_input');
        seen.add(value); consume(2);
        const array = Array.isArray(value);
        const keys = Reflect.ownKeys(value).filter(key => !array || key !== 'length');
        if (keys.length > budget || (array && keys.length !== value.length)) throw new Error('input_limit');
        const result = array ? [] : {};
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || (array && key !== String(i))
                || !descriptor?.enumerable || !('value' in descriptor)) throw new Error('invalid_input');
            if (i) consume(1);
            if (!array) { quote(key); consume(1); }
            Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
        }
        return Object.freeze(result);
    };
    if (!record(input)) throw new Error('invalid_input');
    return copy(input, 0) as Record<string, unknown>; // root shape verified above
}

function safeLabel(value: string, onRedaction?: () => void): string {
    // The common redactor runs on the entire value, before the registry clips it.
    // URL authority/query credentials need an additional URL-aware pass.
    const redacted = redactRuntimeContent(value).replace(
        /(\b[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z_]*\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
        '$1[REDACTED]',
    );
    if (redacted !== value) onRedaction?.();
    return redacted.replace(/https?:\/\/[^\s"'<>]+/g, text => {
        try {
            const url = new URL(text);
            if (url.username || url.password) { onRedaction?.(); url.username = ''; url.password = ''; }
            for (const key of [...url.searchParams.keys()]) {
                if (/token|key|secret|password|credential|authorization|signature/i.test(key)) {
                    if (url.searchParams.getAll(key).some(value => value !== '[REDACTED]')) onRedaction?.();
                    url.searchParams.set(key, '[REDACTED]');
                }
            }
            return url.href;
        } catch { onRedaction?.(); return '[URL withheld]'; }
    });
}
function meaningful(text: string): boolean {
    return !!text.replace(/\[[^\]]*(?:REDACTED|withheld)[^\]]*\]/gi, '').replace(/[\s:={}\[\]"']+/g, '');
}
function approvalView(toolName: string, input: Record<string, unknown>, options: CallbackOptions): RuntimeRequestView | null {
    const candidates = [options['title'], input['command'], options.blockedPath, input['file_path'], input['path'],
        input['url'], input['pattern'], input['description'], input['title']];
    const target = toolName === 'Bash' ? input['command']
        : candidates.find(value => typeof value === 'string' && value.trim());
    let commandRedacted = false;
    const reviewed = typeof target === 'string' ? safeLabel(target, () => { commandRedacted = true; })
        : toolName === 'ExitPlanMode' ? 'Exit plan mode' : '';
    if (toolName === 'Bash' && commandRedacted) return null;
    // URL parsing checks credentials; its normalization must never rewrite shell syntax.
    const description = toolName === 'Bash' && typeof target === 'string' ? target : reviewed;
    if (!meaningful(description)) return null;
    const title = `${safeLabel(toolName)}: ${description}`;
    // Approval authorizes the full original operation: never hide a suffix behind the view's clip.
    if (title.length > REVIEW_TITLE_CHARS) return null;
    // Only selected operation metadata is exposed; never stringify the full input or env.
    return sanitizeRuntimeRequestView({ title, fields: [{
        id: 'decision', label: 'Permission', multiSelect: false, allowFreeform: false,
        options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }],
    }] });
}

type Question = { question: string; header: string; multiSelect: boolean; labels: string[] };
function questionRequest(input: Record<string, unknown>): PreparedRequest {
    if (!Array.isArray(input['questions']) || !input['questions'].length || input['questions'].length > 8) throw new Error('invalid_questions');
    const texts = new Set<string>();
    const bounded = (text: unknown): text is string => typeof text === 'string' && !!text.trim() && text.length <= 500;
    const questions: Question[] = input['questions'].map(value => {
        if (!record(value) || !bounded(value['question']) || texts.has(value['question']) || !bounded(value['header'])
            || (value['multiSelect'] !== undefined && typeof value['multiSelect'] !== 'boolean')
            || !Array.isArray(value['options']) || !value['options'].length || value['options'].length > 20) throw new Error('invalid_questions');
        texts.add(value['question']);
        const labels = value['options'].map(option => {
            if (!record(option) || !bounded(option['label'])) throw new Error('invalid_questions');
            return option['label'];
        });
        return { question: value['question'], header: value['header'], multiSelect: value['multiSelect'] === true, labels };
    });
    const view = sanitizeRuntimeRequestView({ title: safeLabel(questions[0]!['header']), fields: questions.map((q, i) => ({
        id: `q${i}`, label: safeLabel(q['question']), multiSelect: q['multiSelect'], allowFreeform: true,
        options: q.labels.map((label, j) => ({ id: `o${j}`, label: safeLabel(label) })),
    })) });
    if (!view) throw new Error('invalid_questions');
    return { view, requestType: 'question', validate: value => {
        if (record(value) && Object.hasOwn(value, 'optionId')) {
            exact(value, ['optionId']);
            if (value['optionId'] !== null) throw new Error('invalid_response');
            return 'cancel';
        }
        return questionAnswers(value, questions);
    } };
}
function questionAnswers(value: unknown, questions: Question[]): Record<string, string> {
    // Copy the untrusted response before validating, so accessors/mutation cannot change a decision.
    const response = snapshotInput(value);
    exact(response, ['answers']);
    exact(response['answers'], questions.map((_, i) => `q${i}`));
    const answers: Record<string, string> = {};
    let total = 0;
    for (const [i, question] of questions.entries()) {
        const entry = response['answers'][`q${i}`];
        exact(entry, ['selected'], ['text']);
        if (!Array.isArray(entry['selected']) || entry['selected'].length > question.labels.length
            || new Set(entry['selected']).size !== entry['selected'].length) throw new Error('invalid_selection');
        if (entry['text'] !== undefined && (typeof entry['text'] !== 'string' || !entry['text'].trim() || entry['text'].length > FREEFORM_CHARS)) {
            throw new Error('invalid_text');
        }
        const text = typeof entry['text'] === 'string' ? entry['text'] : '';
        total += text.length;
        const count = entry['selected'].length + Number(!!text);
        if (!count || (!question['multiSelect'] && count !== 1) || total > TOTAL_FREEFORM_CHARS) throw new Error('invalid_selection');
        const labels = entry['selected'].map(id => {
            const index = question.labels.findIndex((_, j) => id === `o${j}`);
            if (index < 0) throw new Error('invalid_option');
            return question.labels[index]!;
        });
        if (text) labels.push(text);
        // SDK 0.3.x (re-checked on 0.3.282, sdk-tools.d.ts): full original question -> string, multi-select comma-separated.
        Object.defineProperty(answers, question['question'], { value: labels.join(', '), enumerable: true });
    }
    return Object.freeze(answers);
}

function deny(message = 'Claude tool permission was cancelled or declined.'): PermissionResult { return { behavior: 'deny', message }; }
function emit(owner: ClaudePermissionOwner, body: RuntimeEventBody): void {
    try { owner.emit(body); } catch { /* The registry remains the authoritative polling surface. */ }
}

export function createClaudePermissions({ registry, permissions, resolveOwner }: {
    registry: RuntimeRequests;
    permissions: 'auto' | 'safe';
    resolveOwner(toolUseId: string): Promise<ClaudePermissionOwner | null>;
}): { canUseTool: CanUseTool; cancelAll(): void } {
    if (permissions !== 'auto' && permissions !== 'safe') throw new Error('invalid_claude_permissions');
    const active = new Set<() => void>();
    const canUseTool: CanUseTool = async (toolName, input, options) => {
        if (options.signal.aborted || active.size >= MAX_PENDING) return deny();
        let cancelled = false;
        let pending: ReturnType<RuntimeRequests['open']> | undefined;
        let owner: ClaudePermissionOwner | null = null;
        let cancelWait!: (value: null) => void;
        const cancellation = new Promise<null>(resolve => { cancelWait = resolve; });
        const cancel = () => { cancelled = true; pending?.cancel(); cancelWait(null); };
        const current = () => !cancelled && !options.signal.aborted && owner?.isCurrent() === true;
        active.add(cancel);
        try {
            options.signal.addEventListener('abort', cancel, { once: true });
            if (options.signal.aborted) cancel();
            if (cancelled) return deny();
            if (typeof toolName !== 'string' || !/^[A-Za-z0-9_:.\/-]{1,240}$/.test(toolName)
                || typeof options.toolUseID !== 'string' || !options.toolUseID || options.toolUseID.length > 1000) return deny();
            const original = snapshotInput(input);
            const ask = toolName === 'AskUserQuestion' || permissions === 'safe' || options.matchedAskRule !== undefined;
            const request = toolName === 'AskUserQuestion' ? questionRequest(original) : undefined;
            const view = ask && !request ? approvalView(toolName, original, options) : undefined;
            if (ask && !request && !view) return deny('Claude action has no supported reviewable operation or target.');
            // Main resolves native tool IDs to the captured turn, with its bounded frame wait.
            const resolved = await Promise.race([resolveOwner(options.toolUseID), cancellation]);
            if (!resolved) return deny();
            owner = { context: Object.freeze({ ...resolved.context }),
                isCurrent: resolved.isCurrent.bind(resolved), emit: resolved.emit.bind(resolved) };
            if (!current()) return deny();
            if (!ask) return current() ? { behavior: 'allow', updatedInput: original } : deny();
            const prepared = request ?? { view: view!, requestType: 'approval' as const, validate: validateClaudeApprovalResponse };
            pending = registry.open<Answer>({ ...owner.context, ...prepared, cancelled: 'cancel', isCurrent: current });
            if (!current()) { cancel(); return deny(); }
            emit(owner, { kind: 'request', requestId: pending.requestId, requestType: prepared.requestType, view: pending.view });
            const answer = await pending.answer;
            if (!current()) return deny();
            if (answer === 'allow') return { behavior: 'allow', updatedInput: original };
            if (record(answer) && prepared.requestType === 'question') {
                return { behavior: 'allow', updatedInput: Object.freeze({ ...original, answers: answer }) };
            }
            return deny();
        } catch { return deny('Claude tool permission could not be verified.'); }
        finally {
            options.signal.removeEventListener('abort', cancel);
            active.delete(cancel);
            pending?.cancel();
            if (pending && owner) emit(owner, { kind: 'request-settled', requestId: pending.requestId });
        }
    };
    return { canUseTool, cancelAll: () => { for (const cancel of [...active]) cancel(); } };
}
