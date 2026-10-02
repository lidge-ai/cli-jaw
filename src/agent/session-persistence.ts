import { settings } from '../core/config.js';
import { db, updateSession, upsertSessionBucket } from '../core/db.js';
import { resolveSessionBucket, resolveScopedSessionBucket } from './args.js';
import { currentSessionScope } from '../core/session-context.js';
import type { RuntimeTransport } from '../shared/runtime-contract.js';
import { isNativeSessionBucket, isSwitchableNativeCli, runtimeSessionBucket } from './runtime/selection.js';

export type SessionOwnerToken = { global: number; scope: number };

export type SessionPersistenceInput = {
    persistenceOwner: SessionOwnerToken;
    scopeKey: string;
    forceNew?: boolean;
    employeeSessionId?: string | null;
    sessionId?: string | null;
    isFallback?: boolean;
    code?: number | null;
    wasKilled?: boolean;
    skipSessionPersist?: boolean;
    cli: string;
    model: string;
    provider?: string | null | undefined;
    resumeKey?: string | null;
    effort: string;
    permissions?: string;
    workingDir?: string;
    outputLen?: number | undefined;
    codexAppBucket?: string | undefined;
    // The bucket the run actually used, already keyed by scope (073 §2.1).
    scopedBucket?: string | undefined;
    runtimeTransport?: RuntimeTransport | undefined;
};

let globalGeneration = 0;
const scopeGenerations = new Map<string, number>();

export function getSessionOwnershipGeneration(scopeKey: string): SessionOwnerToken {
    return {
        global: globalGeneration,
        scope: scopeGenerations.get(scopeKey) ?? 0,
    };
}

export function bumpSessionOwnershipGeneration(): number {
    globalGeneration += 1;
    return globalGeneration;
}

export function bumpScopeSessionGeneration(scopeKey: string): number {
    const nextGeneration = (scopeGenerations.get(scopeKey) ?? 0) + 1;
    scopeGenerations.set(scopeKey, nextGeneration);
    return nextGeneration;
}

// Clearing or resetting ONE session must invalidate only that session's in-flight run.
// The global bump is for changes that genuinely affect every run — a settings change
// that alters how any of them would behave. Using it for a session-local reset made a
// second session's turn fail its ownership check on the way out and silently discard
// the conversation it had just created (073 §2.2).
export function bumpGenerationForSessionLocalReset(): number {
    const scope = currentSessionScope()?.scope;
    return scope ? bumpScopeSessionGeneration(scope) : bumpSessionOwnershipGeneration();
}

export function resetSessionOwnershipGenerationForTest(): void {
    globalGeneration = 0;
    scopeGenerations.clear();
}

export function isCurrentSessionOwner(token: SessionOwnerToken, scopeKey: string): boolean {
    return token.global === globalGeneration
        && token.scope === (scopeGenerations.get(scopeKey) ?? 0);
}

export function shouldPersistMainSession(input: SessionPersistenceInput): boolean {
    if (input.skipSessionPersist) return false;
    if (input.cli === 'aside' && (input.wasKilled || input.code !== 0)) return false;
    if (input.forceNew || input.employeeSessionId || !input.sessionId || input.isFallback) return false;
    // User-initiated kill (SIGTERM/SIGKILL) yields exit codes like 143/137/1 depending on
    // the CLI's signal handler. Allow persistence when wasKilled=true so resume works for
    // CLIs (claude, copilot) that don't translate SIGTERM to exit 0.
    if (
        input.code !== undefined && input.code !== null && input.code !== 0
        && !input.wasKilled
    ) return false;
    return isCurrentSessionOwner(input.persistenceOwner, input.scopeKey);
}

export function persistMainSession(input: SessionPersistenceInput): boolean {
    const codexAppBucket = input.codexAppBucket;
    if (
        codexAppBucket !== undefined
        && (
            typeof codexAppBucket !== 'string'
            || !codexAppBucket.startsWith('codex-app:')
            || codexAppBucket.slice('codex-app:'.length).trim().length === 0
        )
    ) {
        console.warn('[jaw:session] rejected invalid codexAppBucket before persistence');
        return false;
    }
    if (!shouldPersistMainSession(input)) return false;
    const isolatedNative = isSwitchableNativeCli(input.cli) && input.runtimeTransport === 'native';
    const nativeKey = typeof input.scopedBucket === 'string' && isNativeSessionBucket(input.scopedBucket);
    const expectedNative = isolatedNative ? runtimeSessionBucket(resolveScopedSessionBucket(
        input.cli, input.model, input.provider, input.scopeKey || 'default', input.effort, 'fallback', false,
    ), 'native') : null;
    if (isolatedNative !== nativeKey || (isolatedNative && input.scopedBucket !== expectedNative)) {
        console.warn('[jaw:session] rejected mismatched runtime transport bucket before persistence');
        return false;
    }
    // Mirror into per-bucket table so codex-spark keeps a session independent from
    // plain codex (gpt-5.4 etc.) — avoids 'thread/resume failed: no rollout found'
    // on cross-model toggles. Both writes go together: a singleton row pointing at
    // a thread the bucket never recorded sends the next resume to the wrong place.
    const bucket = input.scopedBucket
        ?? codexAppBucket
        ?? resolveSessionBucket(input.cli, input.model, input.provider);
    // A caller that forgets `scopedBucket` used to land here on the bare, unscoped name —
    // which is the default session's row. Silently writing another session's vendor id
    // there is the worst outcome available, so a non-default scope scopes the fallback
    // itself. Two pre-shutdown saves reached this state before it was caught by review.
    //
    // This shape matches what the read path builds for every runtime except one: a
    // codex-app run multiplexing on a FALLBACK lane folds model and effort into its key,
    // which is not knowable here. That combination would write a row nothing looks up, so
    // it is reported rather than left to look like a successful save.
    const usedFallback = Boolean(bucket) && !input.scopedBucket && !codexAppBucket;
    const isScoped = (input.scopeKey || 'default') !== 'default';
    if (usedFallback && input.cli === 'codex-app') {
        console.warn(
            `[jaw:session] codex-app save reached the bucket fallback (scope=${input.scopeKey || 'default'}); `
            + 'a multiplexed fallback lane needs its lease bucket or the next resume will not find this thread',
        );
    }
    const scopedFallback = usedFallback && isScoped ? `${bucket}:${input.scopeKey}` : bucket;
    // The bucket is per scope now, but the singleton `session` row is still one row for
    // the instance. Only the default scope owns it; a second session writing there would
    // point the next default resume at a thread that belongs to someone else (073 §2.1).
    const ownsSingletonRow = (input.scopeKey || 'default') === 'default' && !isolatedNative;
    db.transaction(() => {
        if (ownsSingletonRow) {
            updateSession.run(
                input.cli,
                input.sessionId,
                input.model,
                input.permissions || settings["permissions"] || 'auto',
                input.workingDir || settings["workingDir"] || '~',
                input.effort,
            );
        }
        if (scopedFallback && input.sessionId) {
            upsertSessionBucket.run(scopedFallback, input.sessionId, input.model, input.resumeKey || null, input.outputLen ?? 0);
        }
    })();
    return true;
}
