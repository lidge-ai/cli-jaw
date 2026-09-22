import { fetchKiroModelInventory } from '../agent/kiro-models.js';
import { fetchCursorModelInventory } from '../agent/cursor-model-inventory.js';
import { fetchGrokModelInventory } from '../agent/grok-models.js';
import { CLI_REGISTRY } from './registry.js';
import { claudeCatalogToChoices, resolveClaudeBundleCatalog } from './claude-model-discovery.js';
import { buildClaudeEffortsByModel } from './claude-models.js';
import { resolveOpenCodexCodexModelsDetailed } from './opencodex-models.js';
import { diagnoseOpenCodexExecution, resolveOpenCodexRuntime } from './opencodex-runtime.js';
import { readCodexRootOpenAiBaseUrl } from '../core/codex-config.js';
import { detectCli } from '../core/cli-detection.js';

/** Union of every per-model effort set, first-seen order preserved. */
function unionEfforts(effortsByModel: Record<string, string[]>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const efforts of Object.values(effortsByModel)) {
        for (const effort of efforts) {
            if (seen.has(effort)) continue;
            seen.add(effort);
            out.push(effort);
        }
    }
    return out;
}

export async function buildLiveCliRegistry() {
    const registry = structuredClone(CLI_REGISTRY) as Record<string, Record<string, unknown>>;

    const [kiroInventory, openCodexRuntime, claudeCatalog, cursorInventory, grokInventory] = await Promise.all([
        fetchKiroModelInventory(),
        resolveOpenCodexRuntime(),
        resolveClaudeCatalogForRegistry(),
        fetchCursorModelInventory(),
        fetchGrokModelInventory(),
    ]);
    const codexResult = await resolveOpenCodexCodexModelsDetailed(openCodexRuntime);

    const executionCoupling = diagnoseOpenCodexExecution(readCodexRootOpenAiBaseUrl(), openCodexRuntime);
    registry['codex'] = { ...registry['codex'], executionCoupling };
    registry['codex-app'] = { ...registry['codex-app'], executionCoupling };

    const codexModels = codexResult.models;
    if (codexModels.length > 0) {
        // Per-model effort metadata. opencodex advertises a DIFFERENT effort set
        // per model (gpt-5.6-sol reaches `ultra`, gpt-5.6-luna stops at `max`,
        // routed anthropic/* advertised low..max on 2026-09-23 and may advertise
        // none), and the chosen value is
        // forwarded to the wire, so consumers must narrow by model rather than
        // offer the union. `efforts` stays as the union for legacy consumers.
        const effortsByModel: Record<string, string[]> = {};
        const defaultEffortByModel: Record<string, string> = {};
        for (const entry of codexResult.entries) {
            effortsByModel[entry.id] = [...entry.efforts];
            if (entry.defaultEffort) defaultEffortByModel[entry.id] = entry.defaultEffort;
        }
        const merged = unionEfforts(effortsByModel);
        const codexPatch: Record<string, unknown> = {
            models: codexModels,
            modelSource: codexResult.source,
            effortsByModel,
            defaultEffortByModel,
            // Never widen to an empty list: an all-routed catalog would otherwise
            // strip the picker for every model at once.
            ...(merged.length > 0 ? { efforts: merged } : {}),
        };
        // `defaultModel`/`defaultEffort` stay static on purpose: buildDefaultPerCli()
        // seeds user settings from them, so live routing order must not silently
        // rewrite a user's default runtime.
        registry['codex'] = { ...registry['codex'], ...codexPatch };
        registry['codex-app'] = { ...registry['codex-app'], ...codexPatch };
    }

    if (kiroInventory?.models.length) {
        registry['kiro-code'] = {
            ...registry['kiro-code'],
            models: kiroInventory.models,
            defaultModel: kiroInventory.defaultModel,
            modelSource: kiroInventory.source,
            modelDetails: kiroInventory.entries,
        };
    }

    if (cursorInventory?.baseModels.length) {
        // The picker gets the derived base models, not the ~220 wire ids: effort is
        // a separate control, and listing every suffixed id would ask the user to
        // pick the same model a dozen times.
        //
        // `resolveCursorModelVariant` still resolves wire ids from its static set.
        // It runs synchronously on the spawn path, so feeding it a discovered list
        // would make spawning depend on a CLI probe.
        registry['cursor'] = {
            ...registry['cursor'],
            models: cursorInventory.baseModels,
            modelSource: cursorInventory.source,
            effortsByModel: cursorInventory.effortsByModel,
            modelIds: cursorInventory.modelIds,
        };
    }

    if (grokInventory?.models.length) {
        // `defaultModel` stays static even though the CLI names one, for the same
        // buildDefaultPerCli() seeding reason as everywhere else; the observed
        // default is reported separately for diagnostics.
        registry['grok'] = {
            ...registry['grok'],
            models: grokInventory.models,
            modelSource: grokInventory.source,
            ...(grokInventory.defaultModel ? { observedDefaultModel: grokInventory.defaultModel } : {}),
        };
    }

    if (claudeCatalog) {
        // `defaultModel` stays static for the same reason it does for Codex:
        // buildDefaultPerCli() seeds user settings from it, so a bundle update must
        // not silently repoint a user's default. The one exception is a default the
        // live catalog no longer offers, which would be unselectable.
        //
        // Efforts are narrowed per model because `ultracode` needs xhigh support;
        // the flat `efforts` union stays for legacy consumers.
        const claudeEffortsByModel = buildClaudeEffortsByModel(claudeCatalog.models);
        const claudePatch: Record<string, unknown> = {
            models: claudeCatalog.models,
            modelSource: 'claude-bundle',
            modelAliases: claudeCatalog.aliases,
            effortsByModel: claudeEffortsByModel,
        };
        for (const cli of ['claude'] as const) {
            const entry = registry[cli];
            if (!entry) continue;
            const staticDefault = entry['defaultModel'];
            registry[cli] = {
                ...entry,
                ...claudePatch,
                ...(typeof staticDefault === 'string' && !claudeCatalog.models.includes(staticDefault)
                    ? { defaultModel: claudeCatalog.models[0] }
                    : {}),
            };
        }
    }

    return registry;
}

/**
 * Read the installed Claude Code bundle's catalog, if one is installed.
 *
 * A missing binary, an unreadable file or an unrecognized bundle shape all answer
 * null, which leaves the static seed in `claude-models.ts` in place. Discovery
 * never empties the picker.
 */
async function resolveClaudeCatalogForRegistry(): Promise<{ models: string[]; aliases: Record<string, string> } | null> {
    const detection = detectCli('claude');
    if (!detection.available || !detection.path) return null;
    const catalog = await resolveClaudeBundleCatalog(detection.path);
    if (!catalog) return null;
    const models = claudeCatalogToChoices(catalog);
    return models.length > 0 ? { models, aliases: catalog.aliases } : null;
}
