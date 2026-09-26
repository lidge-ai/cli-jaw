import { detectCli } from '../core/cli-detection.js';
import { peekClaudeBundleCatalog, resolveClaudeBundleCatalog, type ClaudeBundleCatalog } from './claude-model-discovery.js';
import { claudeModelNeedsCatalogEntry, getDefaultClaudeModel } from './claude-models.js';

/**
 * Whether the installed Claude Code knows a model id. `[1m]` ids count only when
 * the bundle carries the literal `<id>[1m]` for their base id.
 */
export function claudeCatalogSupports(catalog: ClaudeBundleCatalog, model: string): boolean {
    const oneMillion = model.endsWith('[1m]');
    const base = oneMillion ? model.slice(0, -4) : model;
    const known = catalog.firstParty.includes(base) || Object.values(catalog.aliases).includes(base);
    return oneMillion ? known && catalog.oneMillion.includes(base) : known;
}

/** true/false once the installed catalog was read; null when it could not be read. Warms the cache. */
export async function installedClaudeSupports(model = getDefaultClaudeModel()): Promise<boolean | null> {
    const detection = detectCli('claude');
    if (!detection.available || !detection.path) return null;
    const catalog = await resolveClaudeBundleCatalog(detection.path);
    if (!catalog) return null;
    return claudeCatalogSupports(catalog, model);
}

/**
 * Synchronous preflight for callers that cannot await (spawnAgent). Only a cached
 * catalog can refuse: a cold cache says nothing, and the API's own error stays.
 */
export function claudeModelGateMessage(binaryPath: string | null | undefined, model: string): string | null {
    if (!binaryPath || !claudeModelNeedsCatalogEntry(model)) return null;
    const catalog = peekClaudeBundleCatalog(binaryPath);
    if (!catalog || claudeCatalogSupports(catalog, model)) return null;
    return `Claude Code on this machine does not support ${model}. Update Claude Code (2.1.280 or newer) or pick another model.`;
}
