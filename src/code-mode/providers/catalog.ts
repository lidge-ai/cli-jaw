import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_REGISTRY } from '../../cli/registry.js';
import { buildCliDetectionEnv, prioritizeCliCandidates, readProcessPath, selectSpawnableCliPath,
    type CliDetection } from '../../core/cli-detect.js';
import { splitPathList } from '../../core/runtime-path.js';
import { applyCliEnvDefaults, mergeEnvWindowsSafe } from '../../agent/spawn-env.js';
import type { CodeProviders } from '../provider.js';
import type { CodePermissionMode, CodeProviderCatalog, CodeProviderId } from '../wire.js';
import type { CodeProviderDependencies } from './acp.js';
import { createCodexCodeProvider } from './codex-app.js';
import { createClaudeCodeProvider } from './claude.js';
import { createCursorCodeProvider } from './cursor.js';
import { createGrokCodeProvider } from './grok.js';
import { readCodexLiveModels, type CodexLiveModels } from './live-models.js';
import { readProviderLiveModels, type LiveCatalogProviderId, type ProviderLiveModels } from './provider-live-models.js';

const MODES: Record<CodeProviderId, CodePermissionMode[]> = {
    'codex-app': ['ask', 'auto', 'read-only'],
    claude: ['ask', 'accept-edits', 'plan', 'auto-review', 'dont-ask', 'auto'],
    cursor: ['ask', 'auto'], grok: ['auto'],
};

/** Filesystem-only discovery: catalogs must never execute a CLI or a login probe. */
function detect(binary: string): CliDetection {
    const env = buildCliDetectionEnv(readProcessPath());
    const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
    const candidates = splitPathList(readProcessPath(env), process.platform)
        .flatMap(directory => extensions.map(extension => join(directory, binary + extension)))
        .filter(candidate => existsSync(candidate));
    return selectSpawnableCliPath(prioritizeCliCandidates(binary, candidates));
}

export interface CodeProviderFactories {
    acpSpawn?: Parameters<typeof createCursorCodeProvider>[2];
    codex?: Parameters<typeof createCodexCodeProvider>[1];
    claude?: Parameters<typeof createClaudeCodeProvider>[1];
    claudeHistory?: Parameters<typeof createClaudeCodeProvider>[2];
    cursor?: Parameters<typeof createCursorCodeProvider>[1];
    grok?: Parameters<typeof createGrokCodeProvider>[1];
    detect?: (binary: string) => CliDetection;
    /** Live Codex catalog reader; defaults to the opencodex snapshot. */
    liveModels?: () => CodexLiveModels | null;
    /** Live catalog reader for the other providers; defaults to the shared snapshots. */
    providerLiveModels?: (id: LiveCatalogProviderId) => ProviderLiveModels | null;
}

/**
 * Codex runs behind opencodex, which advertises a routed catalog far wider than
 * the static registry list (routed `anthropic/*`, `xai/*`, newer GPT ids) and a
 * DIFFERENT effort set per model.
 */
function liveCatalogPatch(id: CodeProviderId, read: () => CodexLiveModels | null): CodexLiveModels | null {
    // Read only for the proxied runtime. Calling first and filtering after would
    // make a Claude or Cursor catalog read schedule a Codex probe.
    if (id !== 'codex-app') return null;
    const live = read();
    return live && live.models.length > 0 ? live : null;
}

/**
 * The other three runtimes now have observed catalogs too — Claude from its
 * installed bundle, Cursor and Grok from their CLIs. Reading them here is a memory
 * lookup: `provider-live-models.ts` keeps the rule that a catalog read never spawns
 * a CLI, so Cursor and Grok are only filled by an explicit prime.
 */
function providerCatalogPatch(
    id: CodeProviderId,
    read: (id: LiveCatalogProviderId) => ProviderLiveModels | null,
): ProviderLiveModels | null {
    if (id === 'codex-app') return null;
    const live = read(id);
    return live && live.models.length > 0 ? live : null;
}

export function createCodeProviders(factories: CodeProviderFactories = {}): CodeProviders {
    const dependencies = (id: CodeProviderId): CodeProviderDependencies => {
        const entry = CLI_REGISTRY[id];
        const binaryName = id === 'cursor' ? 'cursor-agent' : entry.binary;
        const detection = () => (factories.detect ?? detect)(binaryName);
        return {
            describe(): CodeProviderCatalog {
                const found = detection();
                const live = liveCatalogPatch(id, factories.liveModels ?? readCodexLiveModels);
                const providerLive = providerCatalogPatch(id, factories.providerLiveModels ?? readProviderLiveModels);
                const base: CodeProviderCatalog = { id, label: entry.label, available: found.available && !!found.path,
                    reason: found.available && found.path ? null : 'Native CLI executable unavailable',
                    models: [...entry.models], defaultModel: entry.defaultModel,
                    defaultEffort: entry.defaultEffort || null, modelSource: 'registry',
                    capabilities: { resume: true, interrupt: true, permissions: true,
                        setModelMidSession: id === 'claude', efforts: [...entry.efforts], permissionModes: [...MODES[id]] } };
                if (providerLive) {
                    return { ...base, models: [...providerLive.models], modelSource: 'live',
                        ...(providerLive.effortsByModel
                            ? { effortsByModel: structuredClone(providerLive.effortsByModel) }
                            : {}),
                        // Same rule as Codex: a default the live catalog no longer
                        // serves would fail validate() on the very first session.
                        defaultModel: providerLive.models.includes(base.defaultModel)
                            ? base.defaultModel
                            : providerLive.models[0] ?? base.defaultModel };
                }
                if (!live) return base;
                // Never widen the effort union to empty: an all-routed catalog would
                // otherwise strip the effort control for every model at once.
                const efforts = live.efforts.length > 0 ? [...live.efforts] : base.capabilities.efforts;
                return { ...base, models: [...live.models], modelSource: 'live',
                    effortsByModel: structuredClone(live.effortsByModel),
                    defaultEffortByModel: { ...live.defaultEffortByModel },
                    capabilities: { ...base.capabilities, efforts },
                    // A default the live catalog no longer serves would fail validate()
                    // on the very first session, so fall back to its first model.
                    defaultModel: live.models.includes(base.defaultModel) ? base.defaultModel : live.models[0] ?? base.defaultModel };
            },
            binary() {
                const found = detection();
                if (!found.available || !found.path) throw new Error('code_provider_unavailable');
                return found.path;
            },
            environment() {
                const env = buildCliDetectionEnv(readProcessPath());
                return mergeEnvWindowsSafe(env, applyCliEnvDefaults(id, {}, env));
            },
        };
    };
    return Object.freeze({
        'codex-app': createCodexCodeProvider(dependencies('codex-app'), factories.codex),
        claude: createClaudeCodeProvider(dependencies('claude'), factories.claude, factories.claudeHistory),
        cursor: createCursorCodeProvider(dependencies('cursor'), factories.cursor, factories.acpSpawn),
        grok: createGrokCodeProvider(dependencies('grok'), factories.grok, factories.acpSpawn),
    });
}
