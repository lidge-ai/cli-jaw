// Cursor model/effort helpers.
// Cursor CLI does not expose --effort; effort is encoded in account model IDs.

export const CURSOR_EFFORT_CHOICES = [
    'none', 'none-fast', 'low', 'low-fast', 'medium', 'medium-fast',
    'high', 'high-fast', 'xhigh', 'xhigh-fast', 'max', 'max-fast',
] as const;

export const CURSOR_MODEL_IDS = [
    'auto',
    'gpt-5.3-codex-low',
    'gpt-5.3-codex-low-fast',
    'gpt-5.3-codex',
    'gpt-5.3-codex-fast',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-high-fast',
    'gpt-5.3-codex-xhigh',
    'gpt-5.3-codex-xhigh-fast',
    'gpt-5.2',
    'gpt-5.2-codex-low',
    'gpt-5.2-codex-low-fast',
    'gpt-5.2-codex',
    'gpt-5.2-codex-fast',
    'gpt-5.2-codex-high',
    'gpt-5.2-codex-high-fast',
    'gpt-5.2-codex-xhigh',
    'gpt-5.2-codex-xhigh-fast',
    'gpt-5.1-codex-max-low',
    'gpt-5.1-codex-max-low-fast',
    'gpt-5.1-codex-max-medium',
    'gpt-5.1-codex-max-medium-fast',
    'gpt-5.1-codex-max-high',
    'gpt-5.1-codex-max-high-fast',
    'gpt-5.1-codex-max-xhigh',
    'gpt-5.1-codex-max-xhigh-fast',
    'composer-2.5',
    'gpt-5.5-high',
    'gpt-5.5-high-fast',
    'claude-opus-4-7-thinking-high',
    'gpt-5.4-high',
    'gpt-5.4-high-fast',
    'claude-4.6-opus-high-thinking',
    'claude-4.6-opus-high-thinking-fast',
    'composer-2.5-fast',
    'gpt-5.5-none',
    'gpt-5.5-none-fast',
    'gpt-5.5-low',
    'gpt-5.5-low-fast',
    'gpt-5.5-medium',
    'gpt-5.5-medium-fast',
    'gpt-5.5-extra-high',
    'gpt-5.5-extra-high-fast',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'claude-4.6-sonnet-medium',
    'claude-4.6-sonnet-medium-thinking',
    'claude-sonnet-5',
    'claude-opus-4-7-low',
    'claude-opus-4-7-low-fast',
    'claude-opus-4-7-medium',
    'claude-opus-4-7-medium-fast',
    'claude-opus-4-7-high',
    'claude-opus-4-7-high-fast',
    'claude-opus-4-7-xhigh',
    'claude-opus-4-7-xhigh-fast',
    'claude-opus-4-7-max',
    'claude-opus-4-7-max-fast',
    'claude-opus-4-7-thinking-low',
    'claude-opus-4-7-thinking-low-fast',
    'claude-opus-4-7-thinking-medium',
    'claude-opus-4-7-thinking-medium-fast',
    'claude-opus-4-7-thinking-high-fast',
    'claude-opus-4-7-thinking-xhigh',
    'claude-opus-4-7-thinking-xhigh-fast',
    'claude-opus-4-7-thinking-max',
    'claude-opus-4-7-thinking-max-fast',
    'claude-opus-4-8-thinking-high',
    'claude-opus-4-8-low',
    'claude-opus-4-8-low-fast',
    'claude-opus-4-8-medium',
    'claude-opus-4-8-medium-fast',
    'claude-opus-4-8-high',
    'claude-opus-4-8-high-fast',
    'claude-opus-4-8-xhigh',
    'claude-opus-4-8-xhigh-fast',
    'claude-opus-4-8-max',
    'claude-opus-4-8-max-fast',
    'claude-opus-4-8-thinking-low',
    'claude-opus-4-8-thinking-low-fast',
    'claude-opus-4-8-thinking-medium',
    'claude-opus-4-8-thinking-medium-fast',
    'claude-opus-4-8-thinking-high-fast',
    'claude-opus-4-8-thinking-xhigh',
    'claude-opus-4-8-thinking-xhigh-fast',
    'claude-opus-4-8-thinking-max',
    'claude-opus-4-8-thinking-max-fast',
    // claude-opus-5: effort ladder low..max per opencodex
    // src/adapters/cursor/effort-map.ts. No `-thinking` variants — upstream
    // CURSOR_STATIC_MODELS does not list one (unlike fable-5 / opus-4-8).
    'claude-opus-5-low',
    'claude-opus-5-low-fast',
    'claude-opus-5-medium',
    'claude-opus-5-medium-fast',
    'claude-opus-5-high',
    'claude-opus-5-high-fast',
    'claude-opus-5-xhigh',
    'claude-opus-5-xhigh-fast',
    'claude-opus-5-max',
    'claude-opus-5-max-fast',
    // Cursor account inventory: Opus 5.5 has low..max, each with a fast ID.
    'claude-opus-5-5-low',
    'claude-opus-5-5-low-fast',
    'claude-opus-5-5-medium',
    'claude-opus-5-5-medium-fast',
    'claude-opus-5-5-high',
    'claude-opus-5-5-high-fast',
    'claude-opus-5-5-xhigh',
    'claude-opus-5-5-xhigh-fast',
    'claude-opus-5-5-max',
    'claude-opus-5-5-max-fast',
    'grok-4.5',
    'grok-4.5-fast',
    'gpt-5.4-low',
    'gpt-5.4-medium',
    'gpt-5.4-medium-fast',
    'gpt-5.4-xhigh',
    'gpt-5.4-xhigh-fast',
    'claude-4.6-opus-high',
    'claude-4.6-opus-max',
    'claude-4.6-opus-max-thinking',
    'claude-4.6-opus-max-thinking-fast',
    'claude-4.5-opus-high',
    'claude-4.5-opus-high-thinking',
    'gpt-5.2-low',
    'gpt-5.2-low-fast',
    'gpt-5.2-fast',
    'gpt-5.2-high',
    'gpt-5.2-high-fast',
    'gpt-5.2-xhigh',
    'gpt-5.2-xhigh-fast',
    'gemini-3.1-pro',
    'gpt-5.4-mini-none',
    'gpt-5.4-mini-low',
    'gpt-5.4-mini-medium',
    'gpt-5.4-mini-high',
    'gpt-5.4-mini-xhigh',
    'gpt-5.4-nano-none',
    'gpt-5.4-nano-low',
    'gpt-5.4-nano-medium',
    'gpt-5.4-nano-high',
    'gpt-5.4-nano-xhigh',
    'claude-4.5-sonnet',
    'claude-4.5-sonnet-thinking',
    'gpt-5.1-low',
    'gpt-5.1',
    'gpt-5.1-high',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.5-flash',
    'gpt-5.1-codex-mini-low',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-mini-high',
    'claude-4-sonnet',
    'claude-4-sonnet-thinking',
    'gpt-5-mini',
    'glm-5.2',
    'kimi-k2.7-code',

    // Live account catalogue (cursor-agent models, 2026-08-20).
    // Grok is why #394 was filed: the account exposes it ONLY under a
    // cursor- prefix, and the fast variants carry that prefix too — so the
    // opencodex rule (prefix on non-fast only) does not transfer to the CLI
    // --model surface this runtime actually uses.
    // The other 78 were absent for the same reason nobody noticed Grok: the
    // list was maintained by hand against release notes instead of against
    // the account. Entries above that this account does not expose are left
    // in place; catalogues differ per plan, and dropping one would break a
    // user whose account still has it.
    'claude-fable-5-high',
    'claude-fable-5-low',
    'claude-fable-5-max',
    'claude-fable-5-medium',
    'claude-fable-5-thinking-high',
    'claude-fable-5-thinking-low',
    'claude-fable-5-thinking-max',
    'claude-fable-5-thinking-medium',
    'claude-fable-5-thinking-xhigh',
    'claude-fable-5-xhigh',
    'claude-opus-5-thinking-high',
    'claude-opus-5-thinking-high-fast',
    'claude-opus-5-thinking-low',
    'claude-opus-5-thinking-low-fast',
    'claude-opus-5-thinking-max',
    'claude-opus-5-thinking-max-fast',
    'claude-opus-5-thinking-medium',
    'claude-opus-5-thinking-medium-fast',
    'claude-opus-5-thinking-xhigh',
    'claude-opus-5-thinking-xhigh-fast',
    'claude-sonnet-5-high',
    'claude-sonnet-5-low',
    'claude-sonnet-5-max',
    'claude-sonnet-5-medium',
    'claude-sonnet-5-thinking-high',
    'claude-sonnet-5-thinking-low',
    'claude-sonnet-5-thinking-max',
    'claude-sonnet-5-thinking-medium',
    'claude-sonnet-5-thinking-xhigh',
    'claude-sonnet-5-xhigh',
    'cursor-grok-4.5-high',
    'cursor-grok-4.5-high-fast',
    'cursor-grok-4.5-low',
    'cursor-grok-4.5-low-fast',
    'cursor-grok-4.5-medium',
    'cursor-grok-4.5-medium-fast',
    'cursor-grok-4.6-high',
    'cursor-grok-4.6-high-fast',
    'cursor-grok-4.6-low',
    'cursor-grok-4.6-low-fast',
    'cursor-grok-4.6-medium',
    'cursor-grok-4.6-medium-fast',
    'cursor-grok-4.6-xhigh',
    'cursor-grok-4.6-xhigh-fast',
    // Grok 4.7 uses unprefixed wire IDs and has no max rung.
    'grok-4.7-low',
    'grok-4.7-low-fast',
    'grok-4.7-medium',
    'grok-4.7-medium-fast',
    'grok-4.7-high',
    'grok-4.7-high-fast',
    'grok-4.7-xhigh',
    'grok-4.7-xhigh-fast',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-minimal',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-medium',
    'glm-5.2-high',
    'glm-5.2-max',
    'glm-5.3-low',
    'glm-5.3-high',
    'glm-5.3-max',
    'gpt-5.6-luna-high',
    'gpt-5.6-luna-high-fast',
    'gpt-5.6-luna-low',
    'gpt-5.6-luna-low-fast',
    'gpt-5.6-luna-max',
    'gpt-5.6-luna-max-fast',
    'gpt-5.6-luna-medium',
    'gpt-5.6-luna-medium-fast',
    'gpt-5.6-luna-none',
    'gpt-5.6-luna-none-fast',
    'gpt-5.6-luna-xhigh',
    'gpt-5.6-luna-xhigh-fast',
    'gpt-5.6-sol-high',
    'gpt-5.6-sol-high-fast',
    'gpt-5.6-sol-low',
    'gpt-5.6-sol-low-fast',
    'gpt-5.6-sol-max',
    'gpt-5.6-sol-max-fast',
    'gpt-5.6-sol-medium',
    'gpt-5.6-sol-medium-fast',
    'gpt-5.6-sol-none',
    'gpt-5.6-sol-none-fast',
    'gpt-5.6-sol-xhigh',
    'gpt-5.6-sol-xhigh-fast',
    'gpt-5.6-terra-high',
    'gpt-5.6-terra-high-fast',
    'gpt-5.6-terra-low',
    'gpt-5.6-terra-low-fast',
    'gpt-5.6-terra-max',
    'gpt-5.6-terra-max-fast',
    'gpt-5.6-terra-medium',
    'gpt-5.6-terra-medium-fast',
    'gpt-5.6-terra-none',
    'gpt-5.6-terra-none-fast',
    'gpt-5.6-terra-xhigh',
    'gpt-5.6-terra-xhigh-fast',
    'kimi-k3-high',
    'kimi-k3-low',
    'kimi-k3-max',
] as const;

export const CURSOR_REGISTRY_MODELS = [
    'auto',
    'composer-2.5',
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.1',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-fable-5-thinking',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-4-8-thinking',
    'claude-opus-4-7',
    'claude-opus-4-7-thinking',
    'claude-4.6-opus',
    'claude-4.6-sonnet',
    'claude-4.5-opus-high',
    'claude-4.5-sonnet',
    'claude-4-sonnet',
    'gemini-3.1-pro',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    // Grok bases stay unprefixed here — this is the UI's vocabulary. The
    // `cursor-` prefix belongs to the wire id and is applied in
    // resolveCursorModelVariant, so a user picks "grok-4.6" and the runtime
    // sends `cursor-grok-4.6-high` (#394).
    'grok-4.5',
    'grok-4.6',
    'grok-4.7',
    'gpt-5-mini',
    'glm-5.2',
    'glm-5.3',
    // Single-rung base: `gpt-5.5-extra`'s only level is `high`
    // (opencodex src/adapters/cursor/catalog.ts:273-277), so the wire id is
    // always `gpt-5.5-extra-high`. It is account-verified rather than
    // documented publicly, which is why it was missing here.
    'gpt-5.5-extra',
    'kimi-k2.7-code',
    'kimi-k3',
] as const;

const CURSOR_EFFORT_SUFFIX: Record<string, string> = {
    none: 'none',
    'none-fast': 'none-fast',
    low: 'low',
    'low-fast': 'low-fast',
    medium: 'medium',
    'medium-fast': 'medium-fast',
    high: 'high',
    'high-fast': 'high-fast',
    xhigh: 'extra-high',
    'xhigh-fast': 'extra-high-fast',
    max: 'max',
    'max-fast': 'max-fast',
};

const CURSOR_EFFORTS = new Set<string>(CURSOR_EFFORT_CHOICES);
const CURSOR_MODEL_ID_SET = new Set<string>(CURSOR_MODEL_IDS);
const CURSOR_BASE_MODELS = new Set<string>(CURSOR_REGISTRY_MODELS);

function normalizeCursorValue(value: string | null | undefined): string {
    return String(value || '').trim();
}

function cursorEffortSuffix(base: string, effort: string): string | undefined {
    if ((effort === 'xhigh' || effort === 'xhigh-fast') && base !== 'gpt-5.5') {
        return effort;
    }
    return CURSOR_EFFORT_SUFFIX[effort];
}

export function isCursorFullModelId(model: string): boolean {
    const value = normalizeCursorValue(model);
    if (!value || value === 'default') return false;
    if (CURSOR_BASE_MODELS.has(value)) return false;
    return /-(none|low|medium|high|max|extra-high|xhigh)(-fast)?$/i.test(value)
        || /^composer-\d+(?:\.\d+)?-fast$/i.test(value);
}

export function resolveCursorModelVariant(model: string, effort: string): string {
    const base = normalizeCursorValue(model);
    const selectedEffort = normalizeCursorValue(effort);
    if (!base || base === 'default') return base || 'default';
    if (base === 'auto') return 'auto';
    if (isCursorFullModelId(base)) return base;

    if (base.startsWith('composer-')) {
        return selectedEffort === 'fast' || selectedEffort === 'medium-fast'
            ? `${base}-fast`
            : base;
    }

    if (!selectedEffort || !CURSOR_EFFORTS.has(selectedEffort)) return base;
    const candidates: string[] = [];
    const suffix = cursorEffortSuffix(base, selectedEffort);
    if (suffix) candidates.push(`${base}-${suffix}`);
    if (selectedEffort === 'medium') candidates.push(base);
    if (selectedEffort === 'medium-fast') candidates.push(`${base}-fast`, base);
    if (selectedEffort === 'fast') candidates.push(`${base}-fast`);
    if (selectedEffort.endsWith('-fast')) {
        const baseEffort = selectedEffort.replace(/-fast$/, '');
        const baseSuffix = cursorEffortSuffix(base, baseEffort);
        if (baseSuffix) candidates.push(`${base}-${baseSuffix}`);
    }
    // Grok is the one family the account names with a `cursor-` prefix, and it
    // applies to fast variants too. The UI vocabulary stays unprefixed, so the
    // prefixed form is tried for each candidate before falling back — without
    // this, picking grok-4.6 produced `grok-4.6-high`, which the account does
    // not have, and the resolver silently degraded to the bare base (#394).
    const withPrefix = candidates.flatMap((candidate) => (
        candidate.startsWith('grok-') ? [`cursor-${candidate}`, candidate] : [candidate]
    ));
    const resolved = withPrefix.find((candidate) => CURSOR_MODEL_ID_SET.has(candidate));
    if (resolved) return resolved;
    return base.startsWith('grok-') && CURSOR_MODEL_ID_SET.has(`cursor-${base}`)
        ? `cursor-${base}`
        : base;
}
