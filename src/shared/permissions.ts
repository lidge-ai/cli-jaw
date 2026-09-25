// The stored `permissions` policy contract, shared by every surface that reads
// or writes it. Before this file the sanitizer, the settings file, the Manager
// editors and the native ACP consumer each decided what a valid value was, so
// the API accepted `{permissions:{}}`, the file kept it, and the runtime then
// threw `invalid_native_permissions` on the same stored bytes (#788).
//
// Three shapes are storable:
//   'auto'   — auto-approve every native permission request (YOLO).
//   'safe'   — never auto-approve; every request escalates to a human.
//   string[] — an explicit allowlist of tool tokens (the "custom" policy).
// An EMPTY array is a real stored policy, not an invalid one: it names an
// explicitly empty allowlist, so no token is pre-approved and every request
// escalates — fail-closed like 'safe', but recorded as a deliberate custom
// choice rather than the named one. The Manager editors reject an empty
// allowlist at editing time so the value can only arrive via file or API.
//
// Tokens follow the runtime consumer `normalizeNativePermissions`: each entry
// is a string, surrounding whitespace is ignored and blank entries are skipped,
// so the stored value and the native policy it produces always agree.

export type PermissionsPolicy = 'auto' | 'safe' | ReadonlyArray<string>;

export const PERMISSION_TOKEN_LIMIT = 64;
export const PERMISSION_TOKEN_PATTERN = /^[a-zA-Z0-9._:*-]+$/;

export function isPermissionToken(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= PERMISSION_TOKEN_LIMIT
        && PERMISSION_TOKEN_PATTERN.test(value);
}

function isStoredPermissionEntry(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const token = value.trim();
    return token.length === 0 || isPermissionToken(token);
}

export function isPermissionsPolicy(value: unknown): value is PermissionsPolicy {
    if (value === 'auto' || value === 'safe') return true;
    if (!Array.isArray(value)) return false;
    // Iterate explicitly: .every on a sparse array skips holes, and a hole is
    // not a valid entry for storage.
    for (let index = 0; index < value.length; index += 1) {
        if (!isStoredPermissionEntry(value[index])) return false;
    }
    return true;
}
