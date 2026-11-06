import type { SlackApiResult } from './api.js';
import type { ActionResource, HeldSlackAction } from './action-store.js';
export type ActionVerification = 'verified' | 'partial' | 'unknown' | 'failed';
export type ActionResult = { recovery?: { held: HeldSlackAction[]; instruction: string }; ok: boolean; operation: string; verification: ActionVerification; retryable: false; resourceIds: string[]; data?: unknown; error?: string; status?: number; partial?: boolean };
export type ActionBase = { channel: string; invocationId?: string };
export type ActionContext = {
    readonly token: string; readonly workspace: string; readonly botUserId: string; readonly actor: string;
    readonly channel: string; readonly credentialKey: string; readonly operator: boolean; readonly signal?: AbortSignal;
    api<T = Record<string, unknown>>(method: string, body: Record<string, unknown>, beforeDispatch?: () => void | Promise<void>): Promise<SlackApiResult<T>>;
    remember(kind: string, id: string, metadata?: Record<string, unknown>): void;
    resource(kind: string, id: string): ActionResource | undefined;
    resources(kind: string): ActionResource[];
    retire(kind: string, id: string): void;
    checkCurrent(): void;
    now(): number;
    download(url: string): Promise<{ content: string; contentType: string }>;
    result(verification: ActionVerification, data?: unknown, resourceIds?: string[]): ActionResult;
    fail(code: string, status?: number, resourceIds?: string[]): ActionResult;
};
export type PreparedAction = { args: ActionBase; canonical: unknown; execute(ctx: ActionContext): Promise<ActionResult> };
export type ActionDefinition = { operation: string; scopes: readonly string[]; methods: readonly string[]; mutates: boolean; requiresInbound?: boolean; prepare(raw: Record<string, unknown>): PreparedAction };
export function defineAction<T extends ActionBase>(definition: {
    operation: string; scopes: readonly string[]; methods: readonly string[]; mutates: boolean; requiresInbound?: boolean;
    parse(raw: Record<string, unknown>): T; execute(ctx: ActionContext, args: T): Promise<ActionResult>;
}): ActionDefinition {
    return { operation: definition.operation, scopes: definition.scopes, methods: definition.methods, mutates: definition.mutates,
        ...(definition.requiresInbound ? { requiresInbound: true } : {}),
        prepare(raw) { const args = definition.parse(raw); return { args, canonical: args, execute: ctx => definition.execute(ctx, args) }; } };
}
