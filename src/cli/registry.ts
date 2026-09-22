// ─── CLI Registry (single source of truth) ──────────

import { CLAUDE_EFFORT_CHOICES, getDefaultClaudeChoices, getDefaultClaudeModel } from './claude-models.js';
import { CURSOR_EFFORT_CHOICES, CURSOR_REGISTRY_MODELS } from '../agent/cursor-runtime.js';
import type { CliEngine } from '../types/cli-engine.js';
import type { RuntimeTransport } from '../shared/runtime-contract.js';
import { isSwitchableNativeCli } from '../agent/runtime/selection.js';

export const CODEX_MODEL_CHOICES = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna'];
/**
 * Static effort fallback for Codex when opencodex is not running. When ocx IS
 * running, registry-live.ts replaces this with the live per-model sets, which
 * can include `max` and `ultra`.
 */
/**
 * Static effort fallback for Codex when opencodex is not running. When ocx IS
 * running, registry-live.ts replaces this with the live per-model sets, which
 * narrow it per model — `gpt-5.6-sol` reaches `ultra` while `gpt-5.6-luna` stops
 * at `max`.
 *
 * The fallback is deliberately the union rather than a per-model table. Its job is
 * to keep the picker from emptying, not to be an accurate catalog, and a hand-kept
 * table here would recreate exactly the manual sync debt live discovery removed.
 * The rung that is wrong for a given model is also unreachable in practice: this
 * list is only used when opencodex is absent, and Codex runs through that proxy.
 *
 * `minimal` is left out. It appears in the live union because some routed models
 * advertise it, but none of the GPT ids in `CODEX_MODEL_CHOICES` were observed to
 * take it, so offering it here would be a rung with nothing behind it.
 */
export const CODEX_EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const CLI_REGISTRY = {
    agy: {
        label: 'Antigravity',
        binary: 'agy',
        experimental: true,
        defaultModel: 'Gemini 3.7 Flash (Medium)',
        defaultEffort: '',
        efforts: [],
        // Tier-bearing label form, which is what `agy --model` accepts on its
        // own. cli-jaw never sends --effort for AGY, and a tier-less slug is
        // rejected in that shape ("requires --effort"). `agy models` prints two
        // columns; the SECOND is this form. Do not paste the first (the
        // effort-suffixed slug `gemini-3.7-flash-medium`) here.
        //
        // Refreshed 2026-09-02 against AGY 1.1.13 by reading `agy models`.
        // Google pulls the previous Flash generation from Antigravity soon
        // after the next ships, so this list is checked against the binary
        // rather than derived: 1.1.13 offers 3.7 and 3.6 and no longer offers
        // 3.5 at all.
        //
        // `defaultModel` moved off 3.5 Flash because the earlier note here --
        // "promoting a default is a policy decision, not a catalog sync" --
        // stopped applying once 3.5 disappeared from the binary. Keeping it
        // was no longer a conservative choice; it pointed every new AGY
        // session at a model AGY cannot serve.
        models: [
            'Gemini 3.7 Flash (High)',
            'Gemini 3.7 Flash (Medium)',
            'Gemini 3.7 Flash (Low)',
            'Gemini 3.6 Flash (High)',
            'Gemini 3.6 Flash (Medium)',
            'Gemini 3.6 Flash (Low)',
            'Gemini 3.1 Pro (High)',
            'Gemini 3.1 Pro (Low)',
            'Claude Sonnet 4.6 (Thinking)',
            'Claude Opus 4.6 (Thinking)',
            'GPT-OSS 120B (Medium)',
        ],
    },
    pi: {
        label: 'Pi',
        binary: 'pi',
        experimental: true,
        defaultProvider: 'progrok',
        defaultModel: 'grok-composer-2.5-fast',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortNote: 'Pi thinking level via RPC set_thinking_level',
        models: ['grok-composer-2.5-fast', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
    },
    claude: {
        label: 'Claude',
        binary: 'claude',
        defaultModel: getDefaultClaudeModel(),
        defaultEffort: 'medium',
        // `ultracode` is a Claude Code session setting, not a wire effort; it is
        // normalized to xhigh plus a settings flag in src/agent/args.ts. Live
        // registry narrows it per model, since it needs xhigh support.
        efforts: [...CLAUDE_EFFORT_CHOICES],
        models: getDefaultClaudeChoices(),
    },
    codex: {
        label: 'Codex',
        binary: 'codex',
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        efforts: CODEX_EFFORT_CHOICES,
        models: CODEX_MODEL_CHOICES,
    },
    'codex-app': {
        label: 'Codex App',
        binary: 'codex',
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        efforts: CODEX_EFFORT_CHOICES,
        models: CODEX_MODEL_CHOICES,
    },
    cursor: {
        label: 'Cursor',
        binary: 'cursor-agent',
        experimental: true,
        defaultModel: 'composer-2.5',
        defaultEffort: 'medium',
        efforts: [...CURSOR_EFFORT_CHOICES],
        effortNote: 'Cursor effort resolves to model IDs; cli-jaw never passes --effort',
        models: [...CURSOR_REGISTRY_MODELS],
    },
    grok: {
        label: 'Grok',
        binary: 'grok',
        defaultModel: 'grok-build',
        defaultEffort: '',
        efforts: [],
        effortNote: 'unsupported by grok-build/composer; do not pass --effort',
        models: ['grok-build', 'grok-composer-2.5-fast'],
    },
    'kiro-code': {
        label: 'Kiro',
        binary: 'kiro-cli',
        defaultModel: 'auto',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortNote: 'Kiro CLI forwards --effort; cli-jaw maps xhigh to Kiro max on the wire',
        // Static fallback for when `kiro-cli` is absent or its inventory probe
        // fails (registry-live.ts replaces this wholesale on success). Mirrors
        // opencodex KIRO_MODELS (src/providers/kiro-models.ts) in dot form.
        // `claude-fable-5` is cli-jaw-only and intentionally retained.
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
    opencode: {
        label: 'OpenCode',
        binary: 'opencode',
        defaultModel: 'opencode-go/kimi-k2.7-code',
        defaultEffort: '',
        efforts: ['minimal', 'low', 'high', 'max'],
        // The full opencode-go roster, refreshed 2026-09-02 against
        // opencodex src/generated/model-metadata.ts:50 (24 ids). `defaultModel`
        // follows opencodex's own default for the provider
        // (src/providers/registry.ts:1458, `kimi-k2.7-code`); the previous
        // kimi-k2.6 is kept in the list rather than dropped, since the provider
        // still serves it.
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
        binary: 'copilot',
        defaultModel: 'claude-sonnet-4.6',
        defaultEffort: 'high',
        efforts: ['low', 'medium', 'high'],
        effortNote: '→ ~/.copilot/config.json',
        // gpt-5.6 trio added 2026-09-02 from opencodex
        // src/providers/registry.ts:2866, and they are real routed models rather
        // than seeds -- each carries an explicit `openai-responses` wire
        // declaration at :2874-2881.
        //
        // The cli-jaw-only Claude ids below are deliberately KEPT. opencodex marks
        // this provider `liveModels: true` and calls its own array a cold-start
        // fallback (:2854-2856), so absence there is weak evidence of retirement,
        // not proof of it. Removing a model a user can still select would be a
        // regression dressed as a sync.
        models: [
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'claude-fable-5',
            'claude-opus-4.8',
            'claude-opus-4.7',
            'claude-sonnet-4.6',
            'claude-haiku-4.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex',
            'gpt-4.1',
            'gpt-5-mini',
        ],
    },
};

export const CLI_KEYS = Object.keys(CLI_REGISTRY) as CliEngine[];
const envDefaultCli = process.env['CLI_JAW_DEFAULT_CLI'];
export const DEFAULT_CLI: CliEngine = (envDefaultCli && CLI_KEYS.includes(envDefaultCli as CliEngine))
    ? envDefaultCli as CliEngine
    : CLI_KEYS.includes('codex-app') ? 'codex-app' : (CLI_KEYS[0] ?? 'codex-app');

export function buildDefaultPerCli() {
    const out: Record<string, { model: string; effort: string; transport?: RuntimeTransport }> = {};
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key as keyof typeof CLI_REGISTRY];
        out[key] = {
            model: entry.defaultModel,
            effort: entry.defaultEffort || '',
            ...(isSwitchableNativeCli(key) ? { transport: 'native' as const } : {}),
            ...('defaultProvider' in entry ? { provider: entry.defaultProvider } : {}),
        };
    }
    return out;
}

export function buildModelChoicesByCli() {
    const out: Record<string, string[]> = {};
    for (const key of CLI_KEYS) out[key] = [...(CLI_REGISTRY[key as keyof typeof CLI_REGISTRY].models || [])];
    return out;
}
