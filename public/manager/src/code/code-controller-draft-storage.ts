import type { CodeCreateSessionRequest } from '../../../../src/code-mode/wire';
import type { CodeDraft, CodeDraftBook, CodePendingSettings } from './code-controller-drafts';
import type { CodeResendReason } from './code-types';

const STORAGE_KEY = 'cli-jaw:code-drafts:v1';
const WARNING_KEY = 'cli-jaw:code-draft-warnings:v1';
const VERSION = 1;
const MAX_ENDPOINTS = 4;
const MAX_SESSIONS = 32;
const MAX_TEXT_CHARS = 256 * 1024;
const MAX_ENDPOINT_CHARS = 1024 * 1024;
const MAX_STORAGE_CHARS = 2 * 1024 * 1024;
const STORAGE_WARNING = 'Draft recovery is unavailable in this tab. Your current text remains in memory.';
const INCOMPLETE_WARNING = 'Draft recovery is incomplete: some recent text or request state was not saved for reload. Check your draft before sending.';
const LIMIT_WARNING = 'Draft recovery is incomplete: some text was not saved for reload because this tab reached its recovery limit.';

type DraftSelection = Pick<CodeCreateSessionRequest, 'provider' | 'cwd' | 'model' | 'effort' | 'permissionMode' | 'thinking'>;
export interface StoredCodeDraft {
    input: string;
    edit: number;
    selection: DraftSelection;
    selectionEdit: number;
    creating: boolean;
    creationKey?: string;
    settings?: Omit<CodePendingSettings, 'op'> | null;
    retry: { text: string; key: string; edit: number; resend?: boolean; resendReason?: CodeResendReason } | null;
    stop: { turnId: string | null; operationId?: string; epoch: number } | null;
}
export interface StoredCodeEndpoint {
    endpoint: string;
    selectedId: string | null;
    fresh: StoredCodeDraft;
    sessions: Array<{ id: string; draft: StoredCodeDraft }>;
}
type StoredEnvelope = { version: number; endpoints: StoredCodeEndpoint[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const mutationId = (value: unknown): boolean => value === null || (typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value));
function parseSettings(value: unknown): Omit<CodePendingSettings, 'op'> | null | undefined {
    if (value === undefined || value === null) return null;
    if (!object(value) || !Array.isArray(value['fields']) || !value['fields'].length || value['fields'].length > 4
        || !['pending', 'sent', 'unknown', 'conflict', 'rejected'].includes(String(value['state']))
        || !mutationId(value['mutationId']) || !mutationId(value['watermark'])
        || !(value['expectedRevision'] === null || count(value['expectedRevision']))
        || typeof value['expired'] !== 'boolean' || typeof value['autoRetried'] !== 'boolean'
        || !(value['error'] === null || text(value['error'], 4096))) return undefined;
    const fields: CodePendingSettings['fields'] = [];
    for (const field of value['fields']) {
        if (!object(field) || !['model', 'effort', 'permissionMode', 'thinking'].includes(String(field['field']))
            || fields.some(row => row.field === field['field'])) return undefined;
        const valid = (item: unknown) => field['field'] === 'thinking' ? item === null || typeof item === 'boolean'
            : item === null || text(item, field['field'] === 'model' ? 1024 : 80);
        if (!valid(field['baseline']) || !valid(field['value'])) return undefined;
        const conflict = field['conflict'];
        if (conflict !== undefined && (!object(conflict) || !valid(conflict['theirs'])
            || !(conflict['resolution'] === undefined || conflict['resolution'] === 'mine' || conflict['resolution'] === 'theirs'))) return undefined;
        fields.push({ field: field['field'] as CodePendingSettings['fields'][number]['field'], baseline: field['baseline'] as string | boolean | null,
            value: field['value'] as string | boolean | null,
            ...(conflict === undefined ? {} : { conflict: { theirs: (conflict as Record<string, unknown>)['theirs'] as string | boolean | null,
                ...((conflict as Record<string, unknown>)['resolution'] ? { resolution: (conflict as Record<string, unknown>)['resolution'] as 'mine' | 'theirs' } : {}) } }) });
    }
    if (value['state'] !== 'pending' && value['mutationId'] === null && value['state'] !== 'conflict') return undefined;
    return { fields, state: value['state'] as CodePendingSettings['state'], mutationId: value['mutationId'] as string | null,
        expectedRevision: value['expectedRevision'] as number | null, watermark: value['watermark'] as string | null,
        expired: value['expired'], autoRetried: value['autoRetried'], error: value['error'] as string | null };
}

function parseDraft(value: unknown): StoredCodeDraft | null {
    if (!object(value) || !text(value['input'], MAX_TEXT_CHARS) || !count(value['edit'])
        || !count(value['selectionEdit']) || typeof value['creating'] !== 'boolean') return null;
    const settings = parseSettings(value['settings']);
    if (settings === undefined) return null;
    const selection = value['selection'];
    if (!object(selection) || !['codex-app', 'claude', 'cursor', 'grok'].includes(String(selection['provider']))
        || !text(selection['cwd'], 4096) || !text(selection['model'], 1024)
        || !(selection['effort'] === null || text(selection['effort'], 80))
        || !['ask', 'auto', 'read-only', 'plan', 'accept-edits', 'dont-ask', 'auto-review'].includes(String(selection['permissionMode']))
        || !(selection['thinking'] === undefined || typeof selection['thinking'] === 'boolean')) return null;
    const creationKey = value['creationKey'];
    if (creationKey !== undefined && (typeof creationKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(creationKey) || !value['creating'])) return null;
    const retry = value['retry'], stop = value['stop'];
    if (retry !== null && (!object(retry) || !text(retry['text'], MAX_TEXT_CHARS)
        || !text(retry['key'], 240) || !retry['key'] || !count(retry['edit']) || retry['edit'] > value['edit'])) return null;
    if (stop !== null && (!object(stop) || !count(stop['epoch']) || !((text(stop['turnId'], 240) && !!stop['turnId'] && stop['operationId'] === undefined) || (stop['turnId'] === null && text(stop['operationId'], 240) && !!stop['operationId'])))) return null;
    return {
        settings,
        ...(typeof creationKey === 'string' ? { creationKey } : {}),
        input: value['input'], edit: value['edit'], selectionEdit: value['selectionEdit'], creating: value['creating'],
        selection: { provider: selection['provider'] as DraftSelection['provider'], cwd: selection['cwd'], model: selection['model'], effort: selection['effort'], permissionMode: selection['permissionMode'] as DraftSelection['permissionMode'],
            // Optional: drafts stored before the Thinking switch carry none.
            ...(typeof selection['thinking'] === 'boolean' ? { thinking: selection['thinking'] } : {}) },
        // `resend` is optional on purpose: a draft stored before this field existed
        // must still parse, or recovery is wiped instead of downgraded.
        retry: retry === null ? null : { text: retry['text'] as string, key: retry['key'] as string, edit: retry['edit'] as number,
            ...(retry['resend'] === true ? { resend: true } : {}),
            // An unknown reason downgrades to the generic spent-key copy instead of wiping recovery.
            ...(retry['resend'] === true && retry['resendReason'] === 'rolled-back' ? { resendReason: 'rolled-back' as const } : {}) },
        stop: stop === null ? null : { turnId: stop['turnId'] as string | null, ...(typeof stop['operationId'] === 'string' ? { operationId: stop['operationId'] } : {}), epoch: stop['epoch'] as number },
    };
}
function parseEnvelope(raw: string | null): StoredEnvelope | null {
    if (raw === null) return { version: VERSION, endpoints: [] };
    if (raw.length > MAX_STORAGE_CHARS) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!object(value) || value['version'] !== VERSION || !Array.isArray(value['endpoints']) || value['endpoints'].length > MAX_ENDPOINTS) return null;
    const endpoints: StoredCodeEndpoint[] = [];
    for (const entry of value['endpoints']) {
        if (!object(entry) || !text(entry['endpoint'], 2048) || !(entry['selectedId'] === null || text(entry['selectedId'], 240))
            || !Array.isArray(entry['sessions']) || entry['sessions'].length > MAX_SESSIONS) return null;
        const fresh = parseDraft(entry['fresh']);
        if (!fresh || fresh.retry || fresh.stop) return null;
        const sessions: StoredCodeEndpoint['sessions'] = [];
        for (const row of entry['sessions']) {
            if (!object(row) || !text(row['id'], 240) || !row['id']) return null;
            const draft = parseDraft(row['draft']);
            if (!draft || draft.creating || sessions.some(previous => previous.id === row['id'])) return null;
            sessions.push({ id: row['id'], draft });
        }
        if (entry['selectedId'] !== null && !sessions.some(row => row.id === entry['selectedId'])) return null;
        if (endpoints.some(previous => previous.endpoint === entry['endpoint']) || JSON.stringify(entry).length > MAX_ENDPOINT_CHARS) return null;
        endpoints.push({ endpoint: entry['endpoint'], selectedId: entry['selectedId'], fresh, sessions });
    }
    return { version: VERSION, endpoints };
}

function incompleteEndpoints(storage: Storage): string[] {
    const raw = storage.getItem(WARNING_KEY);
    if (!raw || raw.length > 16 * 1024) return [];
    try {
        const value: unknown = JSON.parse(raw);
        return Array.isArray(value) && value.length <= MAX_ENDPOINTS && value.every(entry => text(entry, 2048)) ? value : [];
    } catch { return []; }
}
function markIncomplete(storage: Storage, endpoint: string, incomplete: boolean): void {
    try {
        const endpoints = incompleteEndpoints(storage).filter(entry => entry !== endpoint);
        if (incomplete) endpoints.push(endpoint);
        if (endpoints.length) storage.setItem(WARNING_KEY, JSON.stringify(endpoints.slice(-MAX_ENDPOINTS)));
        else storage.removeItem(WARNING_KEY);
    } catch { /* A blocked storage API cannot retain a warning either; RAM still exposes it. */ }
}

export function browserCodeDraftStorage(): { storage: Storage | null; warning: string | null } {
    if (typeof window === 'undefined') return { storage: null, warning: null };
    try { return { storage: window.sessionStorage, warning: null }; }
    catch { return { storage: null, warning: STORAGE_WARNING }; }
}
export function loadCodeDraftStorage(storage: Storage, endpoint: string): { data: StoredCodeEndpoint | null; warning: string | null } {
    try {
        const envelope = parseEnvelope(storage.getItem(STORAGE_KEY));
        if (!envelope) return { data: null, warning: 'Saved Code drafts could not be read. No saved requests were sent.' };
        const data = envelope.endpoints.find(entry => entry.endpoint === endpoint) ?? null;
        const incomplete = incompleteEndpoints(storage);
        return { data, warning: incomplete.includes(endpoint) || (!data && incomplete.length > 0) ? INCOMPLETE_WARNING : null };
    } catch { return { data: null, warning: STORAGE_WARNING }; }
}
function pack(draft: CodeDraft): StoredCodeDraft | null {
    // Whitelist draft intent only. No permission answers, errors,
    // credentials, transcript, native cursor, metadata revision or live cursor.
    const { provider, cwd, model, effort, permissionMode, thinking } = draft.selection;
    return parseDraft({ input: draft.input, edit: draft.edit, selection: { provider, cwd, model, effort, permissionMode,
        ...(thinking === undefined ? {} : { thinking }) }, selectionEdit: draft.selectionEdit,
        creating: draft.createUnknown || draft.operation.kind === 'creating',
        ...(draft.creationKey ? { creationKey: draft.creationKey } : {}),
        settings: draft.settings ? { fields: draft.settings.fields, state: draft.settings.state, mutationId: draft.settings.mutationId,
            expectedRevision: draft.settings.expectedRevision, watermark: draft.settings.watermark, expired: draft.settings.expired,
            autoRetried: draft.settings.autoRetried, error: draft.settings.error } : null,
        retry: draft.retry ? { text: draft.retry.text, key: draft.retry.key, edit: draft.retry.edit,
            ...(draft.retry.resend ? { resend: true } : {}),
            ...(draft.retry.resend && draft.retry.resendReason ? { resendReason: draft.retry.resendReason } : {}) } : null,
        stop: draft.stopTarget ? { turnId: draft.stopTarget.turnId, ...(draft.stopTarget.operationId ? { operationId: draft.stopTarget.operationId } : {}), epoch: draft.stopTarget.epoch } : null });
}
export function saveCodeDraftStorage(storage: Storage, endpoint: string, book: CodeDraftBook): string | null {
    try {
        const fresh = pack(book.fresh);
        if (!fresh) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; }
        const entry: StoredCodeEndpoint = { endpoint, selectedId: null, fresh, sessions: [] };
        let limited = false;
        const rows = [...book.sessions].sort(([a, ad], [b, bd]) => Number(b === book.selectedId) - Number(a === book.selectedId) || Number(!!bd.settings) - Number(!!ad.settings));
        for (const [id, draft] of rows) {
            if (id !== book.selectedId && !draft.input && !draft.retry && !draft.stopTarget && !draft.settings) continue;
            const packed = pack(draft);
            if (!packed) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; }
            if (entry.sessions.length >= MAX_SESSIONS) { if (draft.settings) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; } limited = true; continue; }
            const candidate = { ...entry, selectedId: id === book.selectedId ? id : entry.selectedId, sessions: [...entry.sessions, { id, draft: packed }] };
            if (JSON.stringify(candidate).length > MAX_ENDPOINT_CHARS) { if (draft.settings) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; } limited = true; continue; }
            entry.sessions = candidate.sessions; entry.selectedId = candidate.selectedId;
        }
        // Do not replace an older checkpoint with a partial version of the selected draft.
        if (book.selectedId !== null && entry.selectedId === null) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; }
        if (JSON.stringify(entry).length > MAX_ENDPOINT_CHARS) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; }
        const previous = storage.getItem(STORAGE_KEY);
        const envelope = parseEnvelope(previous) ?? { version: VERSION, endpoints: [] };
        const endpoints = [...envelope.endpoints.filter(row => row.endpoint !== endpoint), entry];
        let serialized = JSON.stringify({ version: VERSION, endpoints });
        while (endpoints.length > MAX_ENDPOINTS || serialized.length > MAX_STORAGE_CHARS) {
            const removable = endpoints.findIndex(row => row.endpoint !== endpoint && !row.fresh.settings && !row.sessions.some(session => session.draft.settings));
            if (removable < 0) { markIncomplete(storage, endpoint, true); return LIMIT_WARNING; }
            const [removed] = endpoints.splice(removable, 1);
            if (removed) markIncomplete(storage, removed.endpoint, true);
            serialized = JSON.stringify({ version: VERSION, endpoints });
        }
        if (serialized !== previous) storage.setItem(STORAGE_KEY, serialized);
        markIncomplete(storage, endpoint, limited || book.recoveryWarning !== null);
        return limited ? LIMIT_WARNING : null;
    } catch { markIncomplete(storage, endpoint, true); return STORAGE_WARNING; }
}
