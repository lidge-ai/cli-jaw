import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
    AsideCatalog, AsideCatalogErrorCode, AsideCachedModelId, AsideConfiguredDefault,
    AsideContext, AsideModelEntry, AsideSelection, AsideThinkingLevel,
} from '../shared/aside-contract.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDERS = 64;
const MAX_MODELS_PER_PROVIDER = 512;
const MAX_TOTAL_MODELS = 2048;
const MAX_CACHED_IDS = 2048;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_TOKENS = 1_000_000_000;
const THINKING_LEVELS: readonly AsideThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MESSAGES: Record<AsideCatalogErrorCode, string> = {
    invalid_context: 'Aside requires an explicit valid account.',
    unsupported_host: 'Aside catalog discovery supports the local host only.',
    unsafe_path: 'Aside profile path is not safe for local discovery.',
    read_failed: 'Aside catalog file could not be read.',
    malformed_catalog: 'Aside catalog data is malformed.',
    limit_exceeded: 'Aside catalog data exceeds discovery limits.',
    duplicate_model: 'Aside catalog contains duplicate model identities.',
    catalog_unavailable: 'Aside catalog is unavailable.',
    default_unavailable: 'Aside has no concrete configured default model.',
    model_unavailable: 'Aside model is not present in the observed catalog.',
    effort_unavailable: 'Aside effort is not supported by the observed model metadata.',
};

/** Messages never include raw JSON, account paths, credentials or caught errors. */
export class AsideCatalogError extends Error {
    constructor(public readonly code: AsideCatalogErrorCode) {
        super(MESSAGES[code]);
        this.name = 'AsideCatalogError';
    }
}

export interface AsideCatalogReadOptions {
    /** Trusted composition/test seam: OS user home, not an arbitrary catalog file. */
    homeDir?: string;
}

function fail(code: AsideCatalogErrorCode): never { throw new AsideCatalogError(code); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('malformed_catalog');
    return value as Record<string, unknown>;
}
function identifier(value: unknown, provider = false): string {
    if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) return fail('malformed_catalog');
    const pattern = provider ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9_./:+\[\]-]*$/;
    if (!pattern.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) return fail('malformed_catalog');
    return value;
}
function thinkingLevel(value: unknown): AsideThinkingLevel {
    if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as AsideThinkingLevel)) return fail('malformed_catalog');
    return value as AsideThinkingLevel;
}
function tokenCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TOKENS) return fail('malformed_catalog');
    return value;
}
function modelEntry(value: unknown, provider: string): AsideModelEntry {
    const row = record(value);
    const modelId = identifier(row['id']);
    const entry: AsideModelEntry = {
        id: `${provider}/${modelId}`, provider, modelId, name: modelId,
        efforts: [], thinkingLevelMap: {}, capability: 'unknown',
    };
    if (row['name'] !== undefined) {
        const name = row['name'];
        if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) return fail('malformed_catalog');
        entry.name = name;
    }
    if (row['thinkingLevelMap'] !== undefined) {
        const map = record(row['thinkingLevelMap']);
        if (Object.keys(map).length > 16) return fail('limit_exceeded');
        for (const level of THINKING_LEVELS) {
            const mapped = map[level];
            if (mapped === null || mapped === undefined) continue;
            if (typeof mapped === 'string') {
                if (!mapped || mapped.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(mapped)) return fail('malformed_catalog');
            } else if (typeof mapped !== 'number' || !Number.isSafeInteger(mapped) || mapped < 0 || mapped > MAX_TOKENS) {
                return fail('malformed_catalog');
            }
            entry.thinkingLevelMap[level] = mapped;
            entry.efforts.push(level);
        }
        entry.capability = 'registered';
    }
    if (row['reasoning'] !== undefined) {
        if (typeof row['reasoning'] !== 'boolean') return fail('malformed_catalog');
        entry.reasoning = row['reasoning'];
    }
    if (row['input'] !== undefined) {
        const input = row['input'];
        if (!Array.isArray(input) || input.length > 4 || input.some(v => !['text', 'image', 'audio', 'video'].includes(v))) return fail('malformed_catalog');
        entry.input = [...new Set(input)] as NonNullable<AsideModelEntry['input']>;
    }
    if (row['contextWindow'] !== undefined) entry.contextWindow = tokenCount(row['contextWindow']);
    if (row['maxTokens'] !== undefined) entry.maxTokens = tokenCount(row['maxTokens']);
    return entry;
}

function parseModels(value: unknown): Pick<AsideCatalog, 'entries' | 'cachedIds'> {
    const root = record(value);
    const providers = root['providers'] === undefined ? {} : record(root['providers']);
    const pairs = Object.entries(providers);
    if (pairs.length > MAX_PROVIDERS) return fail('limit_exceeded');
    const entries: AsideModelEntry[] = [];
    const cachedIds: AsideCachedModelId[] = [];
    const seen = new Set<string>();
    const seenCached = new Set<string>();
    for (const [providerId, raw] of pairs) {
        const provider = identifier(providerId, true);
        const row = record(raw);
        if (row['models'] !== undefined) {
            const models = row['models'];
            if (!Array.isArray(models)) return fail('malformed_catalog');
            if (models.length > MAX_MODELS_PER_PROVIDER || entries.length + models.length > MAX_TOTAL_MODELS) return fail('limit_exceeded');
            for (const value of models) {
                const entry = modelEntry(value, provider);
                if (seen.has(entry.id)) return fail('duplicate_model');
                seen.add(entry.id);
                entries.push(entry);
            }
        }
        if (row['accountModelCatalog'] !== undefined) {
            const cache = record(row['accountModelCatalog']);
            const ids = cache['modelIds'];
            if (!Array.isArray(ids)) return fail('malformed_catalog');
            if (ids.length > MAX_CACHED_IDS || cachedIds.length + ids.length > MAX_CACHED_IDS) return fail('limit_exceeded');
            for (const value of ids) {
                const modelId = identifier(value);
                const id = `${provider}/${modelId}`;
                if (seenCached.has(id)) return fail('duplicate_model');
                seenCached.add(id);
                cachedIds.push({ id, provider, modelId, capability: 'unknown' });
            }
        }
    }
    return { entries, cachedIds };
}

function parseDefault(value: unknown): AsideConfiguredDefault | null {
    const root = record(value);
    if (root['defaultModel'] === undefined || root['defaultModel'] === null) return null;
    const row = record(root['defaultModel']);
    const result: AsideConfiguredDefault = { provider: identifier(row['provider'], true), modelId: identifier(row['modelId']) };
    if (row['thinkingLevel'] !== undefined) result.thinkingLevel = thinkingLevel(row['thinkingLevel']);
    if (row['fastMode'] !== undefined) {
        if (typeof row['fastMode'] !== 'boolean') return fail('malformed_catalog');
        result.fastMode = row['fastMode'];
    }
    return result;
}

function validateContext(context: AsideContext): void {
    if (!context || context.host !== 'local') return fail('unsupported_host');
    if (typeof context.account !== 'string' || !/^u(?:0|[1-9][0-9]{0,8})$/.test(context.account)) return fail('invalid_context');
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

/** Check every account-path component, including in-profile links to other accounts. */
async function profileIdentity(home: string, account: string): Promise<Array<{ path: string; stat: Stats }>> {
    const paths = [join(home, '.aside'), join(home, '.aside', 'u'), join(home, '.aside', 'u', account.slice(1))];
    const identities: Array<{ path: string; stat: Stats }> = [];
    for (const path of paths) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) return fail('unsafe_path');
        identities.push({ path, stat });
    }
    return identities;
}

async function readJson(home: string, account: string, filename: 'models.json' | 'settings.json'): Promise<unknown | undefined> {
    try {
        const identity = await profileIdentity(home, account);
        const path = join(home, '.aside', 'u', account.slice(1), filename);
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await realpath(path) !== path) return fail('unsafe_path');
        if (before.size > MAX_FILE_BYTES) return fail('limit_exceeded');
        // NONBLOCK prevents a replacement FIFO from hanging open; NOFOLLOW rejects file links.
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) return fail('unsafe_path');
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            let bytes = 0;
            while (bytes < buffer.length) {
                const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
                if (read.bytesRead === 0) break;
                bytes += read.bytesRead;
            }
            if (bytes > MAX_FILE_BYTES) return fail('limit_exceeded');
            const after = await file.stat();
            if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) return fail('read_failed');
            const current = await profileIdentity(home, account);
            if (identity.some((item, i) => !current[i] || !sameFile(item.stat, current[i]!.stat)) || !sameFile(after, await lstat(path))) return fail('unsafe_path');
            try { return JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown; }
            catch { return fail('malformed_catalog'); }
        } finally { await file.close(); }
    } catch (error) {
        if (missing(error)) return undefined;
        if (error instanceof AsideCatalogError) throw error;
        return fail('read_failed');
    }
}

/** Always reads the selected local profile afresh; never spawns a CLI or queries a provider. */
export async function readAsideCatalog(context: AsideContext, options: AsideCatalogReadOptions = {}): Promise<AsideCatalog> {
    validateContext(context);
    const capturedContext: AsideContext = { account: context.account, host: 'local' };
    const home = await realpath(resolve(options.homeDir ?? homedir())).catch(() => fail('unsafe_path'));
    const catalog: AsideCatalog = {
        context: capturedContext, entries: [], cachedIds: [],
        configuredDefault: null, defaultModel: null, source: 'local-files', status: 'unavailable', diagnostics: [],
    };
    const account = catalog.context.account;
    for (const source of ['models', 'settings'] as const) {
        try {
            const value = await readJson(home, account, `${source}.json`);
            if (value === undefined) continue;
            if (source === 'models') Object.assign(catalog, parseModels(value));
            else {
                catalog.configuredDefault = parseDefault(value);
                if (catalog.configuredDefault) catalog.defaultModel = `${catalog.configuredDefault.provider}/${catalog.configuredDefault.modelId}`;
            }
        } catch (error) {
            const code = error instanceof AsideCatalogError ? error.code : 'read_failed';
            catalog.diagnostics.push({ source, code, message: MESSAGES[code] });
        }
    }
    const data = catalog.entries.length > 0 || catalog.cachedIds.length > 0 || catalog.defaultModel !== null;
    catalog.status = catalog.entries.length > 0 && catalog.diagnostics.length === 0 ? 'available' : data ? 'partial' : 'unavailable';
    return catalog;
}

/** Cached IDs alone cannot select a model; an observed concrete default can resolve the sentinel. */
export function resolveAsideSelection(catalog: AsideCatalog, model = 'default', effort = 'default'): AsideSelection {
    validateContext(catalog.context);
    if (catalog.status === 'unavailable' || catalog.diagnostics.some(d => d.source === 'models')) return fail('catalog_unavailable');
    const selected = model === 'default' ? catalog.defaultModel : model;
    if (!selected) return fail('default_unavailable');
    const entry = catalog.entries.find(row => row.id === selected);
    const preference = catalog.defaultModel === selected ? catalog.configuredDefault : null;
    if (!entry && !preference) return fail('model_unavailable');
    let level: AsideThinkingLevel | null = null;
    if (effort === 'default') level = preference?.thinkingLevel ?? null;
    else if (THINKING_LEVELS.includes(effort as AsideThinkingLevel)) level = effort as AsideThinkingLevel;
    else return fail('effort_unavailable');
    if (level !== null && (entry?.capability === 'registered'
        ? !entry.efforts.includes(level)
        : !preference || level !== preference.thinkingLevel)) return fail('effort_unavailable');
    return {
        account: catalog.context.account, host: 'local', provider: entry?.provider ?? preference!.provider,
        modelId: entry?.modelId ?? preference!.modelId, model: selected, effort: level,
    };
}
