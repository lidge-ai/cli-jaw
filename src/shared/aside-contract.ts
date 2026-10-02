/** Local Aside discovery is account-explicit and does not establish entitlement. */
export interface AsideContext {
    account: string;
    host: 'local';
}

export type AsideThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AsideModelEntry {
    /** Qualified provider/modelId; modelId itself may contain slashes. */
    id: string;
    provider: string;
    modelId: string;
    name: string;
    efforts: AsideThinkingLevel[];
    thinkingLevelMap: Partial<Record<AsideThinkingLevel, string | number>>;
    capability: 'registered' | 'unknown';
    reasoning?: boolean;
    input?: Array<'text' | 'image' | 'audio' | 'video'>;
    contextWindow?: number;
    maxTokens?: number;
}

export interface AsideCachedModelId {
    id: string;
    provider: string;
    modelId: string;
    capability: 'unknown';
}

export interface AsideConfiguredDefault {
    provider: string;
    modelId: string;
    thinkingLevel?: AsideThinkingLevel;
    fastMode?: boolean;
}

export type AsideCatalogErrorCode =
    | 'invalid_context' | 'unsupported_host' | 'unsafe_path' | 'read_failed'
    | 'malformed_catalog' | 'limit_exceeded' | 'duplicate_model'
    | 'catalog_unavailable' | 'default_unavailable' | 'model_unavailable' | 'effort_unavailable';

export interface AsideCatalogDiagnostic {
    source: 'context' | 'models' | 'settings';
    code: AsideCatalogErrorCode;
    message: string;
}

export interface AsideCatalog {
    context: AsideContext;
    entries: AsideModelEntry[];
    cachedIds: AsideCachedModelId[];
    configuredDefault: AsideConfiguredDefault | null;
    /** Concrete observed preference only; never the first model or a builtin guess. */
    defaultModel: string | null;
    source: 'local-files';
    status: 'available' | 'partial' | 'unavailable';
    diagnostics: AsideCatalogDiagnostic[];
}

export interface AsideSelection extends AsideContext {
    provider: string;
    modelId: string;
    model: string;
    effort: AsideThinkingLevel | null;
}
