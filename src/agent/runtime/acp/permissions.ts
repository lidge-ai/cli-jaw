import { randomUUID } from 'node:crypto';
import type { RuntimeRequestView } from '../../../shared/runtime-contract.js';
import { PERMISSION_TOKEN_LIMIT, PERMISSION_TOKEN_PATTERN } from '../../../shared/permissions.js';

export type AcpPermissionOption = {
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

const OPTION_LIMIT = 20;
const ID_LIMIT = 240;
const TEXT_LIMIT = 1000;

function record(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function permissionOptions(value: unknown): AcpPermissionOption[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > OPTION_LIMIT) {
        throw new Error('acp_invalid_options');
    }
    const seen = new Set<string>();
    const options: AcpPermissionOption[] = [];
    for (const item of value) {
        if (!record(item)) throw new Error('acp_invalid_option');
        const optionId = item['optionId'];
        const name = item['name'];
        const kind = item['kind'];
        if (typeof optionId !== 'string' || !optionId || optionId.length > ID_LIMIT || seen.has(optionId)
            || typeof name !== 'string' || name.length > TEXT_LIMIT
            || (kind !== 'allow_once' && kind !== 'allow_always' && kind !== 'reject_once' && kind !== 'reject_always')) {
            throw new Error('acp_invalid_option');
        }
        seen.add(optionId);
        options.push({ optionId, name, kind });
    }
    return options;
}

export function validatedPermissionParams(value: unknown, nativeSessionId: string): {
    options: AcpPermissionOption[]; title: string;
} {
    if (!record(value)) throw new Error('acp_invalid_permission');
    const sessionId = value['sessionId'];
    if (typeof sessionId !== 'string' || !sessionId || sessionId !== nativeSessionId) {
        throw new Error('acp_wrong_session');
    }
    const tool = value['toolCall'];
    if (!record(tool)) throw new Error('acp_invalid_tool');
    const toolCallId = tool['toolCallId'];
    const title = tool['title'];
    if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > ID_LIMIT
        || (title !== undefined && title !== null && (typeof title !== 'string' || title.length > TEXT_LIMIT))) {
        throw new Error('acp_invalid_tool');
    }
    return {
        options: permissionOptions(value['options']),
        title: typeof title === 'string' ? title : 'Permission request',
    };
}

export function normalizeNativePermissions(value: unknown): 'auto' | 'safe' | ReadonlyArray<string> {
    if (value === 'auto' || value === 'safe') return value;
    if (!Array.isArray(value)) throw new Error('invalid_native_permissions');
    const tokens: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') throw new Error('invalid_native_permissions');
        const token = entry.trim();
        if (!token) continue;
        if (token.length > PERMISSION_TOKEN_LIMIT || !PERMISSION_TOKEN_PATTERN.test(token)) throw new Error('invalid_native_permissions');
        tokens.push(token);
    }
    // Capture policy for this runtime without freezing or modifying persisted settings.
    return Object.freeze(tokens);
}

export function automaticPermission(
    permissions: ReturnType<typeof normalizeNativePermissions>, options: ReadonlyArray<AcpPermissionOption>,
): string | null | undefined {
    if (permissions === 'auto') {
        return (options.find(option => option.kind === 'allow_once')
            ?? options.find(option => option.kind === 'allow_always'))?.optionId ?? null;
    }
    if (permissions === 'safe' || Array.isArray(permissions)) return undefined;
    return null;
}

function responseOptionId(value: unknown): string | null {
    if (!record(value)) throw new Error('invalid_response');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'optionId') throw new Error('invalid_response');
    const optionId = value['optionId'];
    if (optionId !== null && typeof optionId !== 'string') throw new Error('invalid_option');
    return optionId;
}

/** Native-wire-only: accepts native IDs for an already-authorized automatic decision. */
export function permissionResponse(value: unknown, options: ReadonlyArray<AcpPermissionOption>) {
    const optionId = responseOptionId(value);
    if (optionId === null) return { outcome: { outcome: 'cancelled' as const } };
    if (!options.some(option => option.optionId === optionId)) throw new Error('invalid_option');
    return { outcome: { outcome: 'selected' as const, optionId } };
}

export type AcpPermissionResponse = ReturnType<typeof permissionResponse>;

/** Consumes validated options; only the registry may sanitize and publish the returned view. */
export function preparePermissionRequest(title: string, options: ReadonlyArray<AcpPermissionOption>) {
    const nativeByHandle = new Map<string, string>();
    const view: RuntimeRequestView = {
        title,
        fields: [{
            id: randomUUID(), label: 'Permission', multiSelect: false, allowFreeform: false,
            options: options.map(option => {
                const id = randomUUID();
                nativeByHandle.set(id, option.optionId);
                // Do not clip or redact here: the canonical registry boundary owns both.
                return { id, label: option.name };
            }),
        }],
    };
    return {
        view,
        validate(value: unknown): AcpPermissionResponse {
            const handle = responseOptionId(value);
            if (handle === null) return { outcome: { outcome: 'cancelled' } };
            const optionId = nativeByHandle.get(handle);
            if (optionId === undefined) throw new Error('invalid_option');
            return { outcome: { outcome: 'selected', optionId } };
        },
        dispose(): void { nativeByHandle.clear(); },
    };
}
