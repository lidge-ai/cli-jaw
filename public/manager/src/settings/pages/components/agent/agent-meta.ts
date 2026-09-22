import { isRetiredCliSelection, retiredRuntimeLabel } from '../../../../../../../src/types/cli-engine';
export { isRetiredCliSelection, retiredRuntimeLabel };
import type { RuntimeTransport } from '../../../../../../../src/shared/runtime-contract';

export type CliMeta = {
    label: string;
    models: ReadonlyArray<string>;
    efforts: ReadonlyArray<string>;
    defaultProvider?: string;
    providers?: ReadonlyArray<string>;
    modelsByProvider?: Record<string, ReadonlyArray<string>>;
    effortsByProvider?: Record<string, ReadonlyArray<string>>;
    /**
     * Per-model reasoning-effort sets from a live opencodex catalog. An entry
     * that exists but is EMPTY means the model takes no effort at all, so it
     * must not fall back to `efforts`.
     */
    effortsByModel?: Record<string, ReadonlyArray<string>>;
    defaultEffortByModel?: Record<string, string>;
    /**
     * Provider-scoped per-model efforts, used by runtimes whose model list is
     * split by provider (`ai-e`). A flat map would collide on ids shared across
     * providers — `gpt-5.6-sol` exists under both codex and kiro with different
     * allowed efforts.
     */
    effortsByModelByProvider?: Record<string, Record<string, ReadonlyArray<string>>>;
    defaultEffortByModelByProvider?: Record<string, Record<string, string>>;
    modelSource?: string;
    effortNote?: string;
    modelNote?: string;
};

export type PerCliEntry = {
    transport?: RuntimeTransport;
    provider?: string;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    contextWindowSize?: number;
    contextWindowCompactLimit?: number;
    [key: string]: unknown;
};

export type ActiveOverride = {
    provider?: string;
    model?: string;
    effort?: string;
};

const CODEX_MODELS: ReadonlyArray<string> = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna'];

export const PRIMARY_CLIS: ReadonlyArray<string> = ['pi', 'claude', 'agy', 'codex', 'cursor', 'kiro-code', 'gemini'];

export const CLI_META: Record<string, CliMeta> = {
    agy: {
        label: 'Antigravity',
        // Label form is what `agy --model` accepts when no --effort is sent
        // (cli-jaw never sends one for AGY); the bare slug is rejected by
        // AGY 1.1.4 with "requires --effort", so it is not offered at all.
        // A persisted legacy value still renders: optionList() prepends the
        // current value even when it is absent from this catalog.
        models: [
            'Gemini 3.7 Flash (Medium)',
            'Gemini 3.6 Flash (Medium)',
        ],
        efforts: [],
        modelNote: 'AGY model override is version-dependent. Observed AGY 1.1.13 supports --model; cli-jaw probes the installed binary and emits this field only when supported. Leave empty to use native AGY selection.',
        effortNote: 'AGY has no separate effort flag.',
    },
    pi: {
        label: 'Pi',
        defaultProvider: 'progrok',
        providers: ['progrok'],
        models: ['grok-composer-2.5-fast', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortNote: 'Pi runs through --mode rpc. grok-composer-2.5-fast is the verified default; bare grok-composer-2.5 currently has no team access.',
    },
    claude: {
        label: 'Claude',
        // Aliases + pinned full IDs (hyphen form — Anthropic API rejects
        // dot form). Aliases (opus/sonnet/...) follow Claude Code's
        // firstPartyNameToCanonical resolution; pinned IDs reach the API
        // verbatim for stable prompt-cache prefixes. The `[1m]` suffix is
        // parsed by Claude Code (stripped before send, enables 1M context
        // on Fable 5 + Sonnet 5 + Opus 5 + Opus 4.8/4.7/4.6 + Sonnet 4.6). Mirrors getDefaultClaudeChoices()
        // in src/cli/claude-models.ts. Verified via Grok web research
        // 2026-05-01.
        models: [
            'opus',
            'sonnet',
            'sonnet[1m]',
            'haiku',
            'claude-fable-5-1',
            'claude-fable-5',
            'claude-fable-5[1m]',
            'claude-sonnet-5',
            'claude-sonnet-5[1m]',
            'claude-opus-5-5',
            'claude-opus-5-5[1m]',
            'claude-opus-5',
            'claude-opus-5[1m]',
            'claude-opus-4-8',
            'claude-opus-4-8[1m]',
            'claude-opus-4-7',
            'claude-opus-4-7[1m]',
            'claude-opus-4-6',
            'claude-opus-4-6[1m]',
            'claude-sonnet-4-6',
            'claude-sonnet-4-6[1m]',
            'claude-haiku-4-5',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    codex: {
        label: 'Codex',
        models: CODEX_MODELS,
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    'codex-app': {
        label: 'Codex App',
        models: CODEX_MODELS,
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    cursor: {
        label: 'Cursor',
        models: [
            'auto', 'composer-2.5',
            'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
            'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex',
            'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.1',
            'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-thinking',
            'claude-opus-5-5',
            'claude-opus-5',
            'claude-opus-4-8', 'claude-opus-4-8-thinking',
            'claude-opus-4-7', 'claude-opus-4-7-thinking',
            'claude-4.6-opus', 'claude-4.6-sonnet',
            'claude-4.5-opus-high', 'claude-4.5-sonnet', 'claude-4-sonnet',
            'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3.5-flash',
            'grok-4.6', 'grok-4.7', 'grok-4.5', 'gpt-5-mini', 'glm-5.2', 'glm-5.3', 'gpt-5.5-extra', 'kimi-k2.7-code', 'kimi-k3',
            'gemini-3.6-flash', 'gemini-3.7-flash',
        ],
        efforts: ['none', 'none-fast', 'low', 'low-fast', 'medium', 'medium-fast', 'high', 'high-fast', 'xhigh', 'xhigh-fast', 'max', 'max-fast'],
        effortNote: 'Cursor effort resolves to model IDs; no separate --effort flag',
    },
    'kiro-code': {
        label: 'Kiro',
        models: [
            'auto',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'claude-fable-5',
            'claude-sonnet-5',
            'claude-opus-5',
            'claude-opus-4.8',
            'claude-opus-4.7',
            'claude-opus-4.6',
            'claude-sonnet-4.6',
            'claude-opus-4.5',
            'claude-sonnet-4.5',
            'claude-sonnet-4',
            'claude-haiku-4.5',
            'deepseek-3.2',
            'minimax-m2.5',
            'minimax-m2.1',
            'glm-5',
            'qwen3-coder-next',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortNote: 'Kiro CLI forwards --effort; cli-jaw maps xhigh to Kiro max on the wire',
    },
    gemini: {
        label: 'Gemini',
        models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview'],
        efforts: [],
    },
    grok: {
        label: 'Grok',
        models: ['grok-build', 'grok-composer-2.5-fast'],
        efforts: [],
        effortNote: 'unsupported by grok-build/composer; do not pass --effort',
    },
    opencode: {
        label: 'OpenCode',
        models: ['opencode-go/kimi-k2.7-code', 'opencode-go/glm-5.2', 'opencode-go/glm-5.1', 'opencode-go/kimi-k2.6', 'opencode-go/mimo-v2.5-pro', 'opencode-go/mimo-v2.5', 'opencode-go/minimax-m2.7', 'opencode-go/qwen3.7-plus', 'opencode-go/qwen3.6-plus', 'opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4-flash'],
        efforts: ['minimal', 'low', 'high', 'max'],
    },
    copilot: {
        label: 'Copilot',
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'claude-fable-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-sonnet-4.6', 'gpt-5.4'],
        efforts: ['low', 'medium', 'high'],
    },
};

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringArrayRecord(value: unknown): Record<string, string[]> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, string[]> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) out[key] = stringArray(raw);
    return out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw === 'string') out[key] = raw;
    }
    return out;
}

function nestedStringArrayRecord(value: unknown): Record<string, Record<string, string[]>> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, Record<string, string[]>> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const inner = stringArrayRecord(raw);
        if (inner) out[key] = inner;
    }
    return out;
}

function nestedStringRecord(value: unknown): Record<string, Record<string, string>> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const inner = stringRecord(raw);
        if (inner) out[key] = inner;
    }
    return out;
}

export function normalizeCliMetaRegistry(raw: unknown): Record<string, CliMeta> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, CliMeta> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (isRetiredCliSelection(key)) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const modelsByProvider = stringArrayRecord(record['modelsByProvider']);
        const effortsByProvider = stringArrayRecord(record['effortsByProvider']);
        const effortsByModel = stringArrayRecord(record['effortsByModel']);
        const defaultEffortByModel = stringRecord(record['defaultEffortByModel']);
        const effortsByModelByProvider = nestedStringArrayRecord(record['effortsByModelByProvider']);
        const defaultEffortByModelByProvider = nestedStringRecord(record['defaultEffortByModelByProvider']);
        out[key] = {
            label: typeof record['label'] === 'string' ? record['label'] : key,
            models: stringArray(record['models']),
            efforts: stringArray(record['efforts']),
            ...(typeof record['defaultProvider'] === 'string' ? { defaultProvider: record['defaultProvider'] } : {}),
            ...(record['providers'] ? { providers: stringArray(record['providers']) } : {}),
            ...(modelsByProvider ? { modelsByProvider } : {}),
            ...(effortsByProvider ? { effortsByProvider } : {}),
            ...(effortsByModel ? { effortsByModel } : {}),
            ...(defaultEffortByModel ? { defaultEffortByModel } : {}),
            ...(effortsByModelByProvider ? { effortsByModelByProvider } : {}),
            ...(defaultEffortByModelByProvider ? { defaultEffortByModelByProvider } : {}),
            ...(typeof record['modelSource'] === 'string' ? { modelSource: record['modelSource'] } : {}),
            ...(typeof record['effortNote'] === 'string' ? { effortNote: record['effortNote'] } : {}),
            ...(typeof record['modelNote'] === 'string' ? { modelNote: record['modelNote'] } : {}),
        };
    }
    return out;
}

/**
 * Effort choices for one model.
 *
 * A live opencodex catalog advertises a different effort set per model, and the
 * chosen value reaches the wire as `-c model_reasoning_effort=`, so the
 * per-model set wins. An entry that exists but is EMPTY means the model takes
 * no effort and must not fall back to the provider/registry lists.
 */
export function effortChoicesForModel(
    meta: CliMeta,
    model: string,
    providerEfforts?: ReadonlyArray<string>,
    provider?: string,
): ReadonlyArray<string> {
    const key = (model || '').trim();
    // Provider-scoped map wins for provider-split runtimes. When the map exists
    // but the model is absent (e.g. a Claude model under ai-e/claude), fall back
    // to the provider list rather than inventing an empty "no effort" set.
    if (provider) {
        const scoped = meta.effortsByModelByProvider?.[provider]?.[key];
        if (scoped) return scoped;
    }
    const byModel = meta.effortsByModel?.[key];
    if (byModel) return byModel;
    return providerEfforts ?? meta.efforts;
}

/** Keep a saved effort only when the model still advertises it. */
export function coerceEffortForModel(
    meta: CliMeta,
    model: string,
    effort: string,
    providerEfforts?: ReadonlyArray<string>,
    provider?: string,
): string {
    const choices = effortChoicesForModel(meta, model, providerEfforts, provider);
    if (effort && choices.includes(effort)) return effort;
    const key = (model || '').trim();
    const fallback = (provider ? meta.defaultEffortByModelByProvider?.[provider]?.[key] : undefined)
        ?? meta.defaultEffortByModel?.[key]
        ?? '';
    return choices.includes(fallback) ? fallback : '';
}

export function metaFor(cli: string, registry?: Record<string, CliMeta> | null): CliMeta {
    if (isRetiredCliSelection(cli)) return { label: retiredRuntimeLabel(cli), models: [], efforts: [] };
    return registry?.[cli] || CLI_META[cli] || { label: cli, models: [], efforts: [] };
}

export function selectableRuntimeOptions(cliOptions: ReadonlyArray<string>): string[] {
    return cliOptions.filter(value => !isRetiredCliSelection(value));
}

export function orderRuntimeCliOptions(input: ReadonlyArray<string>): string[] {
    const cliOptions = selectableRuntimeOptions(input);
    const primary = PRIMARY_CLIS.filter((value) => cliOptions.includes(value));
    const secondary = cliOptions.filter((value) => !PRIMARY_CLIS.includes(value));
    return [...primary, ...secondary];
}

export function runtimeModelFor(
    cli: string,
    perCli: Record<string, PerCliEntry> = {},
    activeOverrides: Record<string, ActiveOverride> = {},
): string {
    return activeOverrides[cli]?.model || perCli[cli]?.model || '';
}

export function runtimeEffortFor(
    cli: string,
    perCli: Record<string, PerCliEntry> = {},
    activeOverrides: Record<string, ActiveOverride> = {},
): string {
    return activeOverrides[cli]?.effort || perCli[cli]?.effort || '';
}

export function optionList(values: ReadonlyArray<string>, current = ''): Array<{ value: string; label: string }> {
    const unique = new Set<string>();
    if (current) unique.add(current);
    for (const value of values) unique.add(value);
    return Array.from(unique).map((value) => ({ value, label: value }));
}
