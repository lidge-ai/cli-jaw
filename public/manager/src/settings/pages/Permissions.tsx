// Phase 7 — Permissions page: Auto vs Custom (string[] allowlist).
//
// Pure helpers (`isPermissionsAuto`, `parsePermissionsValue`, `isPermissionToken`,
// `seedAutoAllowlist`) are exported so the unit tests can drive the union-typed
// `permissions` field without mounting the React component.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ChipListField, SelectField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { InlineWarn } from './components/InlineWarn';
import { isPermissionToken as isStorePermissionToken, isPermissionsPolicy } from '../../../../../src/shared/permissions';

export type PermissionMode = 'auto' | 'safe' | 'custom';

/** Editing state for the stored value. 'invalid' is the recoverable case: the
 *  stored value matched no public shape, so no policy option is pre-selected
 *  and the saved readout keeps reporting 'Unrecognized' until the user picks
 *  one — never rendered as Auto (#788). */
export type PermissionEditMode = PermissionMode | 'invalid';

type PermissionsSnapshot = {
    permissions?: 'auto' | string[] | unknown;
    [key: string]: unknown;
};

// Permission tokens accepted by the runtime. We don't enforce a closed set —
// MCP namespaces (`mcp.*`) and tool-specific tokens grow over time — but we
// do validate the *shape* so a stray space, control char, or empty chip can't
// slip through. The literal contract lives in src/shared/permissions.

const DEFAULT_AUTO_TOKENS: ReadonlyArray<string> = [
    'bash',
    'read',
    'write',
    'edit',
    'mcp.*',
];

// ─── Pure helpers (exported for tests) ───────────────────────────────

export function configuredPolicyLabel(value: unknown): string {
    if (value === 'auto') return 'Auto (YOLO)';
    if (value === 'safe') return 'Safe';
    if (value === null || value === undefined) return 'Not provided';
    // Count only what the shared validator would store: a token list containing
    // an unwritable entry is not a policy, and labeling it 'Custom' is how an
    // unrecognized value hid inside the readout while the editors disagreed (#788).
    if (Array.isArray(value) && isPermissionsPolicy(value)) {
        return `Custom (${value.length} ${value.length === 1 ? 'entry' : 'entries'})`;
    }
    return 'Unrecognized';
}

export function isPermissionsAuto(value: unknown): value is 'auto' {
    return value === 'auto';
}

/** Coerce the union-typed `permissions` field into a discriminated shape. */
export function parsePermissionsValue(
    value: unknown,
):
    | { mode: 'auto' }
    | { mode: 'safe' }
    | { mode: 'custom'; tokens: string[] }
    | { mode: 'unknown' } {
    if (isPermissionsAuto(value)) return { mode: 'auto' };
    // 'safe' is a real stored policy — the Classic sidebar is its only writer today. Reporting
    // it as 'unknown' is what let callers collapse it to 'auto', silently widening permissions.
    if (value === 'safe') return { mode: 'safe' };
    if (Array.isArray(value)) {
        const tokens = value
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        return { mode: 'custom', tokens };
    }
    return { mode: 'unknown' };
}

export function isPermissionToken(token: string): boolean {
    // Strict shape on the literal — no trim. A token containing whitespace,
    // newline, quote, or control char must fail outright.
    return isStorePermissionToken(token);
}

/** The editing mode a stored value opens in. Anything the shared validator
 *  would not store — including a token list a trim would only clean on
 *  display — lands in 'invalid', so the editors show a recoverable state
 *  instead of silently selecting Auto (#788). */
export function permissionsEditMode(value: unknown): PermissionEditMode {
    if (!isPermissionsPolicy(value)) return 'invalid';
    if (value === 'auto') return 'auto';
    if (value === 'safe') return 'safe';
    return 'custom';
}

/**
 * Provide starter tokens when the user switches Auto (YOLO) → Custom.
 * Use valid supplied tokens when available; otherwise use built-in defaults.
 * These starter tokens do not describe the Auto (YOLO) policy.
 */
export function seedAutoAllowlist(
    resolved?: ReadonlyArray<string> | null,
): string[] {
    if (Array.isArray(resolved) && resolved.length > 0) {
        return Array.from(new Set(resolved.filter(isPermissionToken)));
    }
    return [...DEFAULT_AUTO_TOKENS];
}

export function isAllowlistValid(tokens: ReadonlyArray<string>): boolean {
    if (tokens.length === 0) return false;
    return tokens.every(isPermissionToken);
}

// ─── Page component ──────────────────────────────────────────────────

const MODE_OPTIONS = [
    { value: 'auto', label: 'Auto (YOLO)' },
    { value: 'safe', label: 'Safe' },
    { value: 'custom', label: 'Custom — explicit allowlist below' },
];

export default function Permissions({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<PermissionsSnapshot>(
        client,
        '/api/settings',
    );
    const [mode, setMode] = useState<PermissionEditMode>('auto');
    const [tokens, setTokens] = useState<string[]>([]);

    const original = useMemo(
        () => (state.kind === 'ready' ? parsePermissionsValue(state.data.permissions) : null),
        [state],
    );

    useEffect(() => {
        if (state.kind !== 'ready') return;
        // A Safe instance must read as Safe. Showing it as Auto (YOLO) hides the policy the
        // user is about to change and reports 'auto' as the original, so a round trip
        // through Custom and back writes a widened policy the user never chose. Anything
        // the shared stored-shape validator would not have written opens as 'invalid' —
        // recoverable, not Auto (#788).
        const editMode = permissionsEditMode(state.data.permissions);
        const parsed = parsePermissionsValue(state.data.permissions);
        setMode(editMode);
        setTokens(editMode === 'custom' && parsed.mode === 'custom' ? parsed.tokens : []);
    }, [state]);

    useEffect(() => {
        return () => {
            dirty.remove('permissions');
        };
    }, [dirty]);

    const writeEntry = useCallback(
        (entry: DirtyEntry) => dirty.set('permissions', entry),
        [dirty],
    );

    const storedPermissions = state.kind === 'ready' ? state.data.permissions : undefined;

    const originalSerialized = useMemo<unknown>(() => {
        if (!original) return 'auto';
        if (original.mode === 'custom') return original.tokens;
        if (original.mode === 'safe') return 'safe';
        // Keep the actual stored value as the dirty-entry original: reporting 'auto'
        // here is what let an Unrecognized policy read as Auto (#788).
        if (original.mode === 'unknown') return storedPermissions;
        return 'auto';
    }, [original, storedPermissions]);

    const handleModeChange = useCallback(
        (next: string) => {
            if (next === 'auto') {
                setMode('auto');
                setTokens([]);
                writeEntry({
                    value: 'auto',
                    original: originalSerialized,
                    valid: true,
                });
                return;
            }
            if (next === 'safe') {
                setMode('safe');
                setTokens([]);
                writeEntry({
                    value: 'safe',
                    original: originalSerialized,
                    valid: true,
                });
                return;
            }
            if (next === 'custom') {
                setMode('custom');
                const seed =
                    original && original.mode === 'custom' && original.tokens.length > 0
                        ? [...original.tokens]
                        : seedAutoAllowlist(null);
                setTokens(seed);
                writeEntry({
                    value: seed,
                    original: originalSerialized,
                    valid: isAllowlistValid(seed),
                });
            }
        },
        [original, originalSerialized, writeEntry],
    );

    const handleTokensChange = useCallback(
        (next: string[]) => {
            const cleaned = next.map((t) => t.trim()).filter((t) => t.length > 0);
            setTokens(cleaned);
            writeEntry({
                value: cleaned,
                original: originalSerialized,
                valid: isAllowlistValid(cleaned),
            });
        },
        [originalSerialized, writeEntry],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        // Save bundle from this page only carries `permissions`. We trust the
        // dirty store's `valid` flag — invalid entries are already filtered.
        const updated = await client.put<PermissionsSnapshot>('/api/settings', bundle);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: PermissionsSnapshot }).data
            : updated) as PermissionsSnapshot;
        dirty.clear();
        const editMode = permissionsEditMode(fresh.permissions);
        const parsed = parsePermissionsValue(fresh.permissions);
        setMode(editMode);
        setTokens(editMode === 'custom' && parsed.mode === 'custom' ? parsed.tokens : []);
        setData(fresh);
        await refresh();
    }, [client, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const invalidChips = tokens.filter((t) => !isPermissionToken(t));
    const hasInvalid = invalidChips.length > 0;
    const isEmpty = mode === 'custom' && tokens.length === 0;

    const activeSummary = configuredPolicyLabel(state.data.permissions);

    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="Permissions"
                hint="Selecting a value changes the draft. Save applies it. Auto (YOLO) requests automatic approval or permission bypass. Behavior varies by runtime."
            >
                <SelectField
                    id="permissions-mode"
                    label="Change policy to"
                    value={mode}
                    options={MODE_OPTIONS}
                    onChange={handleModeChange}
                    missingValueLabel={mode === 'invalid' ? 'Unrecognized saved policy' : undefined}
                />
                {mode === 'invalid' && (
                    <InlineWarn role="alert">
                        The saved permissions value is not a recognized policy.
                        Pick a policy above to replace it.
                    </InlineWarn>
                )}
                {mode === 'custom' && (
                    <>
                        <ChipListField
                            id="permissions-allowlist"
                            label="Allowlist"
                            value={tokens}
                            onChange={handleTokensChange}
                            placeholder="bash, read, mcp.*"
                            error={
                                hasInvalid
                                    ? `Invalid token${invalidChips.length === 1 ? '' : 's'}: ${invalidChips.join(', ')}`
                                    : isEmpty
                                        ? 'Allowlist cannot be empty in Custom mode.'
                                        : null
                            }
                        />
                        <p className="settings-section-hint">
                            Each chip is a permission token. Examples: <code>bash</code>,
                            <code> read</code>, <code> write</code>, <code> mcp.*</code>.
                        </p>
                        {isEmpty && (
                            <InlineWarn role="alert">
                                An empty Custom allowlist cannot be saved.
                                Add at least one token or switch back to Auto (YOLO).
                            </InlineWarn>
                        )}
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                title="Saved policy"
                hint="Shows the saved permission policy."
            >
                <p className="settings-readonly-line">
                    <span className="settings-field-label">Configured policy:</span>{' '}
                    <span>{activeSummary}</span>
                </p>
                {original?.mode === 'unknown' ? (
                    <p className="settings-section-hint">Unrecognized value: choose a policy above (or in Agent) to replace it.</p>
                ) : null}
            </SettingsSection>
        </form>
    );
}
