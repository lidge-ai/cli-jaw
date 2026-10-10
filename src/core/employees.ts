// ─── Employee Management ─────────────────────────────
// Shared employee seeding logic for web, telegram, discord contexts.

import crypto from 'node:crypto';
import { getEmployees, deleteEmployee, insertEmployee, db, clearEmployeeSession, clearAllEmployeeSessions } from './db.js';
import { settings } from './config.js';
import { stripUndefined } from './strip-undefined.js';
import { broadcast } from './bus.js';
import { resolveCliDefaultModel } from '../cli/opencodex-models.js';
import { regenerateB } from '../prompt/builder.js';
import type { CliEngine } from '../types/cli-engine.js';

export const DEFAULT_EMPLOYEES = [
    { name: 'Frontend', role: 'UI/UX, CSS, components' },
    { name: 'Backend', role: 'API, DB, server logic' },
    { name: 'Docs', role: 'Documentation, README, API docs' },
];

// ─── Static (code-defined) employees ─────────────────────────────
// Registry kept for future static specialists; Computer Use is now provided
// by the jaw-computer-use MCP rather than a static employee.

/**
 * @deprecated Prefer `CliEngine` from `src/types/cli-engine.ts`. This alias
 * is retained to avoid a renaming churn across employees.ts call sites; it
 * will be removed in P19/P20 cleanup once consumers have migrated.
 */
export type EmployeeCli = Exclude<CliEngine, 'aside'>;

export interface StaticEmployeeRuntimeHints {
    /**
     * Platforms on which this employee can actually run. Empty/absent means
     * "no platform constraint". Values are `process.platform` strings, which
     * is what the dispatch-time check receives; a WSL process reports `linux`
     * and is therefore denied by omission rather than by a separate probe.
     */
    supportedPlatforms?: NodeJS.Platform[];
    /**
     * @deprecated Use `supportedPlatforms`. Retained because this object is
     * serialized to clients through `GET /api/employees` (see `EmployeeListing`),
     * so removing it would break external consumers. Always DERIVED from
     * `supportedPlatforms` by `withDerivedRuntimeHints()` — never set it by hand,
     * or the two fields can disagree.
     */
    requiresDarwin?: boolean;
}

/**
 * A boolean cannot express `darwin | win32`. Rather than let the legacy field
 * drift from the real constraint, we compute it: it is true only when darwin is
 * the sole supported platform. Enforcement itself never reads it — that is
 * `checkRuntimeHints`, which the dispatch route turns into a 412.
 */
export function withDerivedRuntimeHints(
    hints: StaticEmployeeRuntimeHints | undefined,
): StaticEmployeeRuntimeHints | undefined {
    if (!hints) return hints;
    const platforms = hints.supportedPlatforms;
    if (!platforms || platforms.length === 0) return hints;
    return { ...hints, requiresDarwin: platforms.length === 1 && platforms[0] === 'darwin' };
}

export interface StaticEmployee {
    name: string;
    cli: EmployeeCli;
    model?: string;
    description: string;
    skills: string[];
    /** Path relative to src/prompt/templates/; loaded at dispatch time. */
    systemPromptPatchFile?: string;
    runtimeHints?: StaticEmployeeRuntimeHints;
    delegation?: {
        mode: 'preferred_for_long_sessions' | 'exclusive';
        boss_may_self_serve?: boolean;
    };
    defer?: {
        when: 'not-gui-automation';
        back_to: 'Boss';
    };
}

/**
 * Shape of a row returned by `getEmployees.all()` (see ./db.ts).
 * Derived from the schema in db.ts; keep in sync if the schema changes.
 */
export interface EmployeeRow {
    id: string;
    name: string;
    cli: string;          // not narrowed to CliEngine yet — DB may carry legacy values
    model: string | null;
    role: string | null;
    [k: string]: unknown; // allow forward-compatible columns
}

export interface EmployeeResumeKeyLike {
    cli?: unknown;
    model?: unknown;
}

function resumeKeyPart(value: unknown): string {
    return String(value ?? '');
}

export function employeeResumeKeyChanged(
    before: EmployeeResumeKeyLike | null | undefined,
    after: EmployeeResumeKeyLike | null | undefined,
): boolean {
    if (!before || !after) return false;
    return resumeKeyPart(before.cli) !== resumeKeyPart(after.cli)
        || resumeKeyPart(before.model) !== resumeKeyPart(after.model);
}

export function clearEmployeeSessionIfResumeKeyChanged(
    employeeId: string,
    before: EmployeeResumeKeyLike | null | undefined,
    after: EmployeeResumeKeyLike | null | undefined,
): boolean {
    if (!employeeId || !employeeResumeKeyChanged(before, after)) return false;
    clearEmployeeSession.run(employeeId);
    return true;
}

export function clearStaleEmployeeSessionIfResumeKeyMismatch(
    employeeId: string,
    stored: EmployeeResumeKeyLike | null | undefined,
    current: EmployeeResumeKeyLike | null | undefined,
): boolean {
    if (!employeeId || !stored || !current) return false;
    if (!employeeResumeKeyChanged(stored, current)) return false;
    clearEmployeeSession.run(employeeId);
    return true;
}

export function resetEmployeeSessions(): { cleared: number } {
    const result = clearAllEmployeeSessions.run();
    return { cleared: Number(result.changes || 0) };
}

/**
 * Synthetic row produced when a request resolves to a STATIC_EMPLOYEES entry
 * (no real DB id). Shape mirrors the columns the dispatch path actually reads.
 */
export interface SyntheticEmployeeRow {
    id: string;
    name: string;
    cli: string;
    model: string;
    role: string;
    status: 'idle';
}

export const VIRTUAL_EMPLOYEE_ID_PREFIX = 'virtual:';

export interface VirtualRolePreset {
    value: string;
    label: string;
    role: string;
    skill: string;
}

export const VIRTUAL_ROLE_PRESETS: VirtualRolePreset[] = [
    {
        value: 'security',
        label: 'Security',
        role: 'Security reviewer — auth, secrets, injection, destructive-command, sandbox, and data exposure risks',
        skill: 'jaw-dev-security',
    },
    {
        value: 'testing',
        label: 'Testing',
        role: 'Testing reviewer — unit, integration, regression, smoke, and edge-case coverage',
        skill: 'jaw-dev-testing',
    },
];

export interface VirtualEmployeeInput {
    name?: unknown;
    role?: unknown;
    cli?: unknown;
    model?: unknown;
}

export interface VirtualEmployeeDefaults {
    cli: string;
    model: string;
}

function textValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function slugifyVirtualName(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'employee';
}

export function isVirtualEmployeeId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(VIRTUAL_EMPLOYEE_ID_PREFIX);
}

export function findVirtualRolePreset(value: unknown): VirtualRolePreset | null {
    const needle = textValue(value).toLowerCase();
    if (!needle) return null;
    return VIRTUAL_ROLE_PRESETS.find((preset) => preset.value === needle || preset.label.toLowerCase() === needle) ?? null;
}

export function buildVirtualEmployeeRow(
    input: VirtualEmployeeInput,
    defaults: VirtualEmployeeDefaults,
): SyntheticEmployeeRow {
    const rawName = textValue(input.name);
    const explicitRole = textValue(input.role);
    const rolePreset = findVirtualRolePreset(explicitRole) || findVirtualRolePreset(rawName);
    const displayName = rawName || rolePreset?.label || 'Virtual';
    const role = explicitRole
        ? (rolePreset?.role ?? explicitRole)
        : (rolePreset?.role ?? `${displayName} virtual employee — execute the assigned task directly.`);
    const cli = textValue(input.cli) || defaults.cli;
    const model = textValue(input.model) || defaults.model;

    return {
        id: `${VIRTUAL_EMPLOYEE_ID_PREFIX}${slugifyVirtualName(displayName)}:${crypto.randomUUID()}`,
        name: `Virtual:${displayName}`,
        cli,
        model,
        role,
        status: 'idle',
    };
}

export const STATIC_EMPLOYEES: StaticEmployee[] = [];

export function findStaticEmployee(name: string): StaticEmployee | null {
    const needle = name.trim().toLowerCase();
    return STATIC_EMPLOYEES.find((e) => e.name.toLowerCase() === needle) ?? null;
}

export interface EmployeeListing {
    /** DB employees have no synthetic id here (use row id separately);
     *  static employees use `static:<name-lower>` so the frontend can PUT to
     *  the overrides endpoint. */
    id?: string;
    name: string;
    cli: string;
    model?: string | null;
    role: string;
    source: 'db' | 'static';
    runtimeHints?: StaticEmployeeRuntimeHints;
    skills?: string[];
    systemPromptPatchFile?: string;
    delegation?: StaticEmployee['delegation'];
    defer?: StaticEmployee['defer'];
}

export interface RuntimeHintCheckResult {
    fail: string[];
    warn: string[];
}

/**
 * Evaluate runtime preconditions for a static employee on the current host.
 * Pure (platform probe only). Caller decides how to react: dispatch returns
 * 4xx on fail.
 */
export function checkRuntimeHints(
    spec: StaticEmployee,
    platform: NodeJS.Platform = process.platform,
): RuntimeHintCheckResult {
    const out: RuntimeHintCheckResult = { fail: [], warn: [] };
    const hints = spec.runtimeHints;
    if (!hints) return out;
    const platforms = hints.supportedPlatforms;
    if (platforms && platforms.length > 0 && !platforms.includes(platform)) {
        out.fail.push(
            `${spec.name} supports ${platforms.join(', ')} (current: ${platform})`,
        );
    }
    return out;
}

/**
 * Evaluate model/CLI precondition at dispatch time — same shape as checkRuntimeHints
 * so the caller (orchestrate.ts) can translate fail/warn into HTTP 412/warning.
 * Pure function: no network, no probes. Encode KNOWN model-level incompatibilities
 * we cannot recover from after spawn.
 *
 * Spark note: `gpt-5.3-codex-spark` does NOT accept the `reasoning.summary` /
 * `reasoning.effort` parameters (server returns 400 "unsupported_parameter").
 * `args.ts` already drops those flags via `isCodexSparkModel`, so no fail is
 * needed here — the guard is exercised at argv-build time, not dispatch time.
 * This scaffold is kept for future model-policy additions.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkModelSupport(
    _cli: string | undefined | null,
    _model: string | undefined | null,
    _env: NodeJS.ProcessEnv = process.env,
): RuntimeHintCheckResult {
    return { fail: _cli === 'aside' ? ['Aside supports main sessions only.'] : [], warn: [] };
}

async function resolveStaticEmployeeModel(
    spec: StaticEmployee,
    override?: { model?: string },
): Promise<string> {
    return override?.model ?? spec.model ?? await resolveCliDefaultModel(spec.cli);
}

/**
 * Resolve an employee name to a dispatchable row-shape used by worker-registry
 * and runSingleAgent. DB rows win; static entries produce a synthetic id.
 */
export async function resolveDispatchableEmployee(
    name: string,
    dbRows: readonly EmployeeRow[] = getEmployees.all() as EmployeeRow[],
): Promise<{ row: EmployeeRow | SyntheticEmployeeRow; source: 'db' | 'static'; spec: StaticEmployee | null } | null> {
    const needle = name.trim().toLowerCase();
    for (const r of dbRows) {
        if ((r.name ?? '').toLowerCase() === needle) {
            if (r.cli === 'aside') return null;
            return { row: r, source: 'db', spec: findStaticEmployee(r.name) };
        }
    }
    const spec = findStaticEmployee(name);
    if (!spec) return null;
    const override = (settings["staticEmployees"] as Record<string, { model?: string }> | undefined)?.[spec.name];
    const model = await resolveStaticEmployeeModel(spec, override);
    return {
        row: {
            id: `static:${spec.name.toLowerCase()}`,
            name: spec.name,
            cli: spec.cli,
            model,
            role: spec.description,
            status: 'idle',
        },
        source: 'static',
        spec,
    };
}

/**
 * Return DB employees merged with STATIC_EMPLOYEES by case-insensitive name.
 * DB rows take precedence when names collide; static entries only fill gaps.
 */
export async function listEmployees(): Promise<EmployeeListing[]> {
    type Row = { id: string; name: string; cli: string; model: string | null; role: string | null };
    const dbRows = getEmployees.all() as Row[];
    const seen = new Set<string>();
    const staticOut: EmployeeListing[] = [];
    const dbOut: EmployeeListing[] = [];
    const overrides = (settings["staticEmployees"] as Record<string, { model?: string }> | undefined) || {};

    // Static employees first (rendered at top of UI list, CLI-locked, model editable).
    for (const s of STATIC_EMPLOYEES) {
        const override = overrides[s.name];
        const model = await resolveStaticEmployeeModel(s, override);
        staticOut.push(stripUndefined({
            // Use synthetic id matching resolveDispatchableEmployee so the frontend
            // can round-trip PUT /api/employees/:id to the override storage.
            id: `static:${s.name.toLowerCase()}`,
            name: s.name,
            cli: s.cli,
            model,
            role: s.description,
            source: 'static',
            runtimeHints: withDerivedRuntimeHints(s.runtimeHints),
            skills: s.skills,
            systemPromptPatchFile: s.systemPromptPatchFile,
            delegation: s.delegation,
            defer: s.defer,
        }));
        seen.add(s.name.toLowerCase());
    }

    for (const r of dbRows) {
        if (!r?.name) continue;
        // DB entries with the same name as a static one take precedence for dispatch,
        // but we keep the static slot visible in UI. Skip the DB dup in listing.
        if (seen.has(r.name.toLowerCase())) continue;
        dbOut.push({
            id: r.id,
            name: r.name,
            cli: r.cli,
            model: r.model,
            role: r.role ?? '',
            source: 'db',
        });
    }

    return [...staticOut, ...dbOut];
}

export async function seedDefaultEmployees({ reset = false, notify = false } = {}) {
    if (settings['cli'] === 'aside' || !db.open) return { seeded: 0, cli: settings['cli'], skipped: true };
    const existing = getEmployees.all() as EmployeeRow[];
    if (reset) {
        clearAllEmployeeSessions.run();
        for (const emp of existing) deleteEmployee.run(emp.id);
    } else if (existing.length > 0) {
        return { seeded: 0, cli: settings["cli"], skipped: true };
    }

    const cli = settings["cli"];
    const defaultModel = await resolveCliDefaultModel(cli);
    for (const emp of DEFAULT_EMPLOYEES) {
        insertEmployee.run(crypto.randomUUID(), emp.name, cli, defaultModel, emp.role);
    }
    if (notify) broadcast('agent_updated', {});
    regenerateB();
    return { seeded: DEFAULT_EMPLOYEES.length, cli, skipped: false };
}
