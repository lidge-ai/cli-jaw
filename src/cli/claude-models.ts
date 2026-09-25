// ─── Claude Model Normalization (single source of truth) ──────────

export const CLAUDE_CANONICAL_MODELS = [
  'opus',
  'sonnet',
  'sonnet[1m]',
  'haiku',
] as const;

export type ClaudeCanonicalModel = (typeof CLAUDE_CANONICAL_MODELS)[number];

// Pinned full IDs offered as Claude Code `--model` values. The `[1m]` suffix is
// parsed by Claude Code itself (not Anthropic): the CLI strips the suffix
// before forwarding the clean model ID and enables the 1M-context window.
// 1M context is supported on Fable 5, Sonnet 5, Opus 5.5, Opus 5, Opus 4.8, Opus 4.7,
// Opus 4.6, and Sonnet 4.6 — Haiku stays at 200k so there is no
// `claude-haiku-4-5[1m]` variant.

// Verified 2026-05-01 via Grok web research.

// `claude-opus-5` verified 2026-07-25 against Claude Code 2.1.218 itself, not
// inferred from a gateway catalog: the model id is absent from the CLI bundle
// (the server resolves it), so both variants were probed live and reported
// `provider: "firstParty"` with `canonicalModel` equal to the requested id —
// `claude-opus-5` at 200k and `claude-opus-5[1m]` at 1M.

export const CLAUDE_PINNED_FULL_IDS = [
  // claude-fable-5-1 added 2026-09-02 from opencodex ANTHROPIC_MODELS
  // (src/providers/registry.ts:341). No [1m] variant: opencodex's own
  // 1M-context metadata rows cover only claude-opus-4-6/4-7/4-8 and
  // claude-sonnet-4-6 (src/generated/model-metadata.ts:41), so offering
  // claude-fable-5-1[1m] would be an id nothing traces to.
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-fable-5[1m]',
  'claude-sonnet-5',
  'claude-sonnet-5[1m]',
  // claude-opus-5-5 verified 2026-09-23 against Claude Code 2.1.280 (bundle and a
  // live turn, both IDs). Claude Code 2.1.278 is rejected by the API with a 400
  // that asks for 2.1.280 or newer.
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
] as const;

// Dot-form model strings that older UI versions persisted into settings.
// These are invalid for the Anthropic API (which uses hyphens), so we
// silently upgrade them to the correct hyphen-form. Full-ID → alias
// rewrites are intentionally absent: passthrough policy preserves the
// user's pinned literal for prompt-cache stability.
export const CLAUDE_LEGACY_VALUE_MAP: Record<string, string> = {
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
};

export function isClaudeCli(cli: string): boolean {
  return cli === 'claude';
}

export function isClaudeCanonicalModel(model: string): model is ClaudeCanonicalModel {
  return (CLAUDE_CANONICAL_MODELS as readonly string[]).includes(model);
}

export function isKnownClaudeLegacyValue(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLAUDE_LEGACY_VALUE_MAP, model);
}

export function migrateLegacyClaudeValue(model: string): string {
  const value = (model || '').trim();
  if (!value) return value;
  return CLAUDE_LEGACY_VALUE_MAP[value] || value;
}

export function getDefaultClaudeModel(): string {
  return 'claude-opus-5-5';
}

/** The default this project shipped before `claude-opus-5-5`; only this exact value migrates. */
export const PREVIOUS_DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

/** Ids Claude Code rejects before 2.1.280; the installed bundle catalog is the capability proof. */
export function claudeModelNeedsCatalogEntry(model: string): boolean {
  return /^claude-opus-5-5(\[1m\])?$/.test(model);
}

export function getDefaultClaudeChoices(): string[] {
  // Aliases first (Claude Code resolves them to the current snapshot via
  // firstPartyNameToCanonical), then pinned full IDs for users who want
  // a stable cache prefix across CLI updates.
  return [...CLAUDE_CANONICAL_MODELS, ...CLAUDE_PINNED_FULL_IDS];
}

export function getClaudeModelKind(model: string): 'canonical' | 'legacy' | 'explicit' {
  const value = (model || '').trim();
  if (!value) return 'explicit';
  if (isClaudeCanonicalModel(value)) return 'canonical';
  if (isKnownClaudeLegacyValue(value)) return 'legacy';
  return 'explicit';
}

// ─── Effort ladder ────────────────────────────────────────────────

/**
 * The efforts Claude Code's `--effort` flag accepts, verbatim from its help text:
 * "Effort level for the current session (low, medium, high, xhigh, max)".
 */
export const CLAUDE_WIRE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * `ultracode` is offered as a sixth rung even though the flag does not accept it.
 * The bundle resolves the tier from `settings.ultracode === true` and reports
 * `xhigh`, so cli-jaw presents one choice and splits it at the wire (see
 * `normalizeClaudeEffort` and `claudeSettingsArgs` in `src/agent/args.ts`).
 *
 * Claude Code refuses ultracode unless the model supports xhigh, dynamic workflows
 * are enabled, and the organization permits xhigh. Only the model condition is
 * knowable here, so that is the one this list encodes; the other two surface as a
 * runtime message from Claude Code itself.
 */
export const CLAUDE_EFFORT_CHOICES = [...CLAUDE_WIRE_EFFORTS, 'ultracode'] as const;

/**
 * Families that predate extended reasoning. Claude Code reports "ultracode runs at
 * xhigh effort, which <model> doesn't support" for these, so offering the rung
 * would advertise a control that always fails.
 *
 * Matching is anchored on the family segment rather than the whole id so it covers
 * both the full id and the short alias: `haiku` and `claude-haiku-4-5` are the same
 * model, and only one of them carries the `claude-` prefix.
 */
const NO_XHIGH_PATTERN = /^(?:claude-)?(?:3-|haiku)/;

export function claudeModelSupportsXhigh(model: string): boolean {
  const value = (model || '').trim();
  if (!value) return false;
  // The remaining short aliases (opus/sonnet/fable) resolve to current flagships,
  // which all reach xhigh.
  return !NO_XHIGH_PATTERN.test(value);
}

/** Per-model effort sets, narrowed so ultracode never appears where it cannot run. */
export function buildClaudeEffortsByModel(models: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const model of models) {
    out[model] = claudeModelSupportsXhigh(model)
      ? [...CLAUDE_EFFORT_CHOICES]
      : [...CLAUDE_WIRE_EFFORTS];
  }
  return out;
}
