import { isRetiredCliSelection } from '../../src/types/cli-engine.js';
// ── Shared constants (frontend) ──
import { api } from './api.js';

export interface CliEntry {
    label: string;
    efforts: string[];
    models: string[];
    defaultProvider?: string;
    providers?: string[];
    modelsByProvider?: Record<string, string[]>;
    effortsByProvider?: Record<string, string[]>;
    /**
     * Per-model reasoning-effort sets from a live opencodex catalog. An entry
     * that exists but is EMPTY means the model takes no effort at all, so it
     * must not fall back to `efforts`.
     */
    effortsByModel?: Record<string, string[]>;
    defaultEffortByModel?: Record<string, string>;
    /**
     * Provider-scoped per-model efforts for provider-split runtimes (`ai-e`).
     * A flat map would collide on ids shared across providers.
     */
    effortsByModelByProvider?: Record<string, Record<string, string[]>>;
    defaultEffortByModelByProvider?: Record<string, Record<string, string>>;
    modelSource?: string;
    effortNote?: string;
    modelNote?: string;
}

export type CliRegistry = Record<string, CliEntry>;

const FALLBACK_CLI_REGISTRY: CliRegistry = {
    agy: {
        label: 'Antigravity',
        efforts: [],
        effortNote: 'AGY has no separate effort flag',
        // These strings are passed to `agy --model` verbatim (src/agent/args.ts
        // case 'agy'), and cli-jaw never sends --effort for AGY. The bare slug
        // form is rejected in that shape — AGY 1.1.4 answers
        // `--model gemini-3.5-flash` with "requires --effort" — so the offline
        // fallback must use the tier-bearing label form that `agy --model`
        // accepts on its own. (`agy models` prints effort-suffixed slugs like
        // `gemini-3.6-flash-medium`; that is a different form, not this one.)
        // The old bare slug is deliberately NOT offered: it fails every time it
        // is picked. A user who already persisted it still sees it, because
        // renderCliSettings appends an absent selected value as a custom option
        // (public/js/features/settings-core.ts).
        models: [
            'Gemini 3.7 Flash (Medium)',
            'Gemini 3.6 Flash (Medium)',
        ],
    },
    claude: {
        label: 'Claude',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        // Mirrors getDefaultClaudeChoices() in src/cli/claude-models.ts —
        // aliases first, then verified pinned full IDs (hyphen form). The
        // [1m] suffix activates Claude Code's 1M-context window (Fable 5,
        // Sonnet 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6).
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
    },
    codex: {
        label: 'Codex',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna'],
    },
    'codex-app': {
        label: 'Codex App',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna'],
    },
    cursor: {
        label: 'Cursor',
        efforts: ['none', 'none-fast', 'low', 'low-fast', 'medium', 'medium-fast', 'high', 'high-fast', 'xhigh', 'xhigh-fast', 'max', 'max-fast'],
        effortNote: 'Cursor effort resolves to model IDs; cli-jaw never passes --effort',
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
    },
    'kiro-code': {
        label: 'Kiro',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortNote: 'Kiro CLI forwards --effort; cli-jaw maps xhigh to Kiro max on the wire',
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
    },
    gemini: {
        label: 'Gemini',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    grok: {
        label: 'Grok',
        efforts: [],
        effortNote: 'unsupported by grok-build/composer; do not pass --effort',
        models: ['grok-build', 'grok-composer-2.5-fast'],
    },
    opencode: {
        label: 'OpenCode',
        efforts: ['minimal', 'low', 'high', 'max'],
        models: [
            'opencode-go/kimi-k2.7-code',
            'opencode-go/kimi-k3',
            'opencode-go/kimi-k2.6',
            'opencode-go/kimi-k2.5',
            'opencode-go/glm-5.3',
            'opencode-go/glm-5.2',
            'opencode-go/glm-5.1',
            'opencode-go/glm-5',
            'opencode-go/grok-4.6',
            'opencode-go/grok-4.5',
            'opencode-go/minimax-m3',
            'opencode-go/minimax-m2.7',
            'opencode-go/minimax-m2.5',
            'opencode-go/qwen3.7-max',
            'opencode-go/qwen3.7-plus',
            'opencode-go/qwen3.6-plus',
            'opencode-go/qwen3.5-plus',
            'opencode-go/mimo-v2.5-pro',
            'opencode-go/mimo-v2.5',
            'opencode-go/mimo-v2-pro',
            'opencode-go/mimo-v2-omni',
            'opencode-go/deepseek-v4-pro',
            'opencode-go/deepseek-v4-flash',
            'opencode-go/hy3',
        ],
    },
    copilot: {
        label: 'Copilot',
        efforts: ['low', 'medium', 'high'],
        effortNote: '-> ~/.copilot/config.json',
        models: [
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'claude-fable-5',
            'claude-opus-4.8',
            'claude-sonnet-4.6',
            'claude-haiku-4.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex',
            'gpt-4.1',
            'gpt-5-mini',
            'gemini-3-pro-preview',
        ],
    },
};

type ModelMap = Record<string, string[]>;

function toModelMap(registry: CliRegistry): ModelMap {
    const out: ModelMap = {};
    for (const [key, value] of Object.entries(registry)) {
        out[key] = Array.isArray(value?.models) ? [...value.models] : [];
    }
    return out;
}

function normalizeRegistry(input: Record<string, unknown>): CliRegistry {
    const out: CliRegistry = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (isRetiredCliSelection(key)) continue;
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const normalized: CliEntry = {
            label: (v['label'] as string) || key,
            efforts: Array.isArray(v['efforts']) ? [...v['efforts']] as string[] : [],
            models: Array.isArray(v['models']) ? [...v['models']] as string[] : [],
        };
        if (typeof v['effortNote'] === 'string' && v['effortNote'].trim()) {
            normalized['effortNote'] = v['effortNote'];
        }
        if (typeof v['modelNote'] === 'string' && v['modelNote'].trim()) {
            normalized['modelNote'] = v['modelNote'];
        }
        if (typeof v['defaultProvider'] === 'string') normalized.defaultProvider = v['defaultProvider'];
        if (Array.isArray(v['providers'])) normalized.providers = [...v['providers']] as string[];
        if (v['modelsByProvider'] && typeof v['modelsByProvider'] === 'object') {
            normalized.modelsByProvider = Object.fromEntries(
                Object.entries(v['modelsByProvider'] as Record<string, unknown>)
                    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
                    .map(([provider, models]) => [provider, [...models]])
            );
        }
        if (v['effortsByProvider'] && typeof v['effortsByProvider'] === 'object') {
            normalized.effortsByProvider = Object.fromEntries(
                Object.entries(v['effortsByProvider'] as Record<string, unknown>)
                    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
                    .map(([provider, efforts]) => [provider, [...efforts]])
            );
        }
        if (v['effortsByModel'] && typeof v['effortsByModel'] === 'object') {
            normalized.effortsByModel = Object.fromEntries(
                Object.entries(v['effortsByModel'] as Record<string, unknown>)
                    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
                    .map(([model, efforts]) => [model, efforts.filter((e): e is string => typeof e === 'string')])
            );
        }
        if (v['defaultEffortByModel'] && typeof v['defaultEffortByModel'] === 'object') {
            normalized.defaultEffortByModel = Object.fromEntries(
                Object.entries(v['defaultEffortByModel'] as Record<string, unknown>)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            );
        }
        if (typeof v['modelSource'] === 'string') normalized.modelSource = v['modelSource'];
        if (v['effortsByModelByProvider'] && typeof v['effortsByModelByProvider'] === 'object') {
            normalized.effortsByModelByProvider = Object.fromEntries(
                Object.entries(v['effortsByModelByProvider'] as Record<string, unknown>)
                    .filter((entry): entry is [string, Record<string, unknown>] =>
                        Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
                    .map(([provider, byModel]) => [provider, Object.fromEntries(
                        Object.entries(byModel)
                            .filter((e): e is [string, string[]] => Array.isArray(e[1]))
                            .map(([model, efforts]) => [model, efforts.filter((x): x is string => typeof x === 'string')])
                    )])
            );
        }
        if (v['defaultEffortByModelByProvider'] && typeof v['defaultEffortByModelByProvider'] === 'object') {
            normalized.defaultEffortByModelByProvider = Object.fromEntries(
                Object.entries(v['defaultEffortByModelByProvider'] as Record<string, unknown>)
                    .filter((entry): entry is [string, Record<string, unknown>] =>
                        Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
                    .map(([provider, byModel]) => [provider, Object.fromEntries(
                        Object.entries(byModel).filter((e): e is [string, string] => typeof e[1] === 'string')
                    )])
            );
        }
        out[key] = normalized;
    }
    return out;
}

export let CLI_REGISTRY: CliRegistry = normalizeRegistry(FALLBACK_CLI_REGISTRY as unknown as Record<string, unknown>);
export let CLI_KEYS: string[] = Object.keys(CLI_REGISTRY);
export let MODEL_MAP: ModelMap = toModelMap(CLI_REGISTRY);

function applyRegistry(registry: Record<string, unknown>): boolean {
    const normalized = normalizeRegistry(registry);
    if (!Object.keys(normalized).length) return false;
    CLI_REGISTRY = normalized;
    CLI_KEYS = Object.keys(normalized);
    MODEL_MAP = toModelMap(normalized);
    return true;
}

export async function loadCliRegistry(): Promise<CliRegistry> {
    try {
        const data = await api<Record<string, unknown>>('/api/cli-registry');
        if (!data || !applyRegistry(data)) throw new Error('invalid registry');
    } catch (e) {
        console.warn('[cli-registry] fallback:', (e as Error).message);
        applyRegistry(FALLBACK_CLI_REGISTRY as unknown as Record<string, unknown>);
    }
    return CLI_REGISTRY;
}

export function getCliKeys(): string[] {
    return CLI_KEYS;
}

export function getCliMeta(cli: string): CliEntry | null {
    return CLI_REGISTRY[cli] || null;
}

export const PRIMARY_CLIS: readonly string[] = ['pi', 'claude', 'agy', 'codex', 'cursor', 'kiro-code', 'gemini'];

export interface RolePreset {
    value: string;
    labelKey: string;
    label: string;
    prompt: string;
    skill: string | null;
}

export const ROLE_PRESETS: readonly RolePreset[] = [
    { value: 'frontend', labelKey: 'role.label.frontend', label: 'Frontend', prompt: 'Frontend employee — UI/UX, CSS, components', skill: 'jaw-dev-frontend' },
    { value: 'backend', labelKey: 'role.label.backend', label: 'Backend', prompt: 'Backend employee — API, DB, server logic', skill: 'jaw-dev-backend' },
    { value: 'data', labelKey: 'role.label.data', label: 'Data', prompt: 'Data employee — data pipeline, analysis, ML', skill: 'jaw-dev-data' },
    { value: 'docs', labelKey: 'role.label.docs', label: 'Docs', prompt: 'Docs employee — documentation, README, API docs', skill: 'documentation' },
    { value: 'security', labelKey: 'role.label.security', label: 'Security', prompt: 'Security reviewer — auth, secrets, injection, destructive-command, sandbox, and data exposure risks', skill: 'jaw-dev-security' },
    { value: 'testing', labelKey: 'role.label.testing', label: 'Testing', prompt: 'Testing reviewer — unit, integration, regression, smoke, and edge-case coverage', skill: 'jaw-dev-testing' },
    { value: 'custom', labelKey: 'role.label.custom', label: 'Custom...', prompt: '', skill: null },
] as const;
