// @file src/types/cli-engine.ts
// Canonical discriminator for cli-jaw's supported CLI engines.
//
// Single source of truth. Every other module that names the engine union
// (currently: src/core/employees.ts EmployeeCli; future: P10 / P11 / P12)
// MUST import from this file rather than redeclaring the literal union.
//
// Member ordering is alphabetical for stable diffs. Runtime ordering for
// e.g. CLI_KEYS in src/cli/registry.ts is defined separately in that file
// — these are different concerns.
//
// Adding a new engine:
//   1. Add the literal here.
//   2. Add the runtime entry in src/cli/registry.ts (the registry will
//      no longer typecheck without it once P00.5 lands).
//   3. Update fixtures and per-engine event extractors (P11+).

export type ExecutableCliEngine =
    | 'agy'
    | 'aside'
    | 'claude'
    | 'codex'
    | 'codex-app'
    | 'copilot'
    | 'cursor'
    | 'grok'
    | 'kiro-code'
    | 'opencode'
    | 'pi';

/** Historical selections stay readable but never become execution candidates. */
export type RetiredCliSelection = 'ai-e' | 'claude-e' | 'jwc';
export type StoredCliSelection = ExecutableCliEngine | RetiredCliSelection;
export type CliEngine = ExecutableCliEngine;

export const RETIRED_CLI_SELECTIONS = [
    'ai-e',
    'claude-e',
    'jwc',
] as const satisfies readonly RetiredCliSelection[];

export function isRetiredCliSelection(value: unknown): value is RetiredCliSelection {
    return typeof value === 'string' && (RETIRED_CLI_SELECTIONS as readonly string[]).includes(value);
}

export const RETIRED_RUNTIME_DIAGNOSTIC = 'retired_runtime:jwc' as const;

/**
 * Diagnostic code for a stored retired runtime. `jwc` keeps the original
 * literal so every existing contract that pins it stays byte-identical.
 */
export function retiredRuntimeDiagnostic(value: RetiredCliSelection): string {
    return value === 'jwc' ? RETIRED_RUNTIME_DIAGNOSTIC : `retired_runtime:${value}`;
}

const RETIRED_RUNTIME_NAMES: Readonly<Record<RetiredCliSelection, string>> = {
    'ai-e': 'AI-E',
    'claude-e': 'Claude E',
    jwc: 'JWC',
};

/** Short label for a saved retired runtime, e.g. `JWC (retired)`. */
export function retiredRuntimeLabel(value: RetiredCliSelection): string {
    return `${RETIRED_RUNTIME_NAMES[value]} (retired)`;
}

/** Selector label that also tells the reader what to do next. */
export function retiredRuntimeChoiceLabel(value: RetiredCliSelection): string {
    return `${RETIRED_RUNTIME_NAMES[value]} (retired — choose another runtime)`;
}

/**
 * Runtime list of all engines, derived from the type via a `satisfies`
 * check so adding/removing a literal in `CliEngine` forces a corresponding
 * change here. Order is alphabetical to match the type declaration; do
 * NOT use this as the user-facing default ordering (that lives in
 * src/cli/readiness.ts DEFAULT_ORDER).
 */
export const CLI_ENGINES = [
    'agy',
    'aside',
    'claude',
    'codex',
    'codex-app',
    'copilot',
    'cursor',
    'grok',
    'kiro-code',
    'opencode',
    'pi',
] as const satisfies readonly CliEngine[];

export function isCliEngine(value: unknown): value is CliEngine {
    return typeof value === 'string' && (CLI_ENGINES as readonly string[]).includes(value);
}
