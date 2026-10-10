// Resume/heartbeat/bucket decision helpers — pure functions, no spawn state mutation.

import { normalizeModelForCli } from '../../core/config.js';

// ─── ACP Heartbeat Helper ────────────────────────────
// Pure function for conditional heartbeat gating.
// "visible" = WebUI + Telegram common baseline. 💭 is WebUI-only
// (bot.ts:337 hides it), so it's NOT counted as visible.
const DEFAULT_HEARTBEAT_GATE_MS = 20_000;

export function shouldEmitHeartbeat(
    lastVisibleTs: number,
    heartbeatSent: boolean,
    gateMs: number = DEFAULT_HEARTBEAT_GATE_MS,
    now: number = Date.now(),
): boolean {
    if (heartbeatSent) return false;
    return (now - lastVisibleTs) > gateMs;
}

export function shouldResumeBucketSession(
    cli: string,
    requestedModel: string,
    bucketModel: string | null | undefined,
    requestedResumeKey?: string | null,
    bucketResumeKey?: string | null,
    bucketUpdatedAt?: string | number | null,
    nowMs: number = Date.now(),
    _effectiveProvider?: string | null,
): boolean {
    if (cli === 'copilot' && bucketModel) {
        return normalizeModelForCli(cli, requestedModel) === normalizeModelForCli(cli, bucketModel);
    }
    if (cli === 'cursor') {
        if (!bucketModel) return false;
        return normalizeModelForCli(cli, requestedModel) === normalizeModelForCli(cli, bucketModel);
    }
    if (cli === 'kiro-code') {
        if (!bucketModel) return false;
        return normalizeModelForCli('kiro-code', requestedModel) === normalizeModelForCli('kiro-code', bucketModel);
    }
    if (cli === 'aside') return Boolean(requestedResumeKey) && requestedResumeKey === bucketResumeKey
        && requestedModel === bucketModel;
    if (cli === 'opencode' && requestedResumeKey) {
        return requestedResumeKey === (bucketResumeKey ?? null);
    }
    if (cli === 'agy') {
        if (!bucketModel) return false;
        if (isExpiredBucket(bucketUpdatedAt, AGY_RESUME_TTL_MS, nowMs)) return false;
        return true;
    }
    return true;
}

export const AGY_RESUME_TTL_MS = 72 * 60 * 60 * 1000;

export type AgyNativeResumeMode = 'off' | 'guarded';
export function resolveAgyNativeResume(value: unknown): AgyNativeResumeMode {
    return value === 'guarded' ? 'guarded' : 'off';
}

export interface GuardedAgyResumeInput {
    mode: AgyNativeResumeMode; conversationSupported: boolean;
    sessionId: string | null | undefined; bucketUpdatedAt: string | number | null | undefined;
    requestedModel: string; bucketModel: string | null | undefined;
    cwd: string; lastRunCwd: string | null | undefined;
    lastRunClean: number | null | undefined; lastRunMeta: string | null | undefined;
    freshBootstrap: boolean; nowMs?: number;
}

export function canGuardedAgyResume(input: GuardedAgyResumeInput): { ok: boolean; reason: string } {
    if (input.mode !== 'guarded') return { ok: false, reason: 'mode-off' };
    if (!input.conversationSupported) return { ok: false, reason: 'no-conversation-capability' };
    if (!input.sessionId) return { ok: false, reason: 'missing-conversation-id' };
    if (isExpiredBucket(input.bucketUpdatedAt, AGY_RESUME_TTL_MS, input.nowMs ?? Date.now())) return { ok: false, reason: 'ttl-expired' };
    if (!input.bucketModel || normalizeModelForCli('agy', input.requestedModel) !== normalizeModelForCli('agy', input.bucketModel)) return { ok: false, reason: 'model-mismatch' };
    if (!input.lastRunCwd || input.lastRunCwd !== input.cwd) return { ok: false, reason: 'cwd-mismatch' };
    if (input.lastRunClean !== 1) return { ok: false, reason: 'last-run-not-clean' };
    if (!input.lastRunMeta) return { ok: false, reason: 'missing-last-run-meta' };
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(input.lastRunMeta) as Record<string, unknown>; }
    catch { return { ok: false, reason: 'invalid-last-run-meta' }; }
    if (meta['plannerOnly'] !== false) return { ok: false, reason: 'planner-only' };
    if (meta['checkpointSeen'] !== false) return { ok: false, reason: 'checkpoint-seen' };
    if (input.freshBootstrap) return { ok: false, reason: 'fresh-bootstrap' };
    return { ok: true, reason: 'guarded-resume' };
}

/**
 * Generic high-turn bucket resets protect CLIs whose resumed session may become
 * stale after internal compaction. AGY persists its own compacted conversation,
 * so preserve that bucket until an explicit guarded-resume invalidation signal.
 */
export function shouldClearHighTurnSessionBucket(cli: string, turns: number): boolean {
    if (turns <= 15) return false;
    return cli === 'codex' || cli === 'opencode' || cli === 'grok';
}

/** AGY owns compaction for its native conversation and does not need refresh-by-turn. */
export function shouldUseTurnCountRefresh(cli: string): boolean {
    return cli !== 'claude' && cli !== 'agy';
}


function parseBucketUpdatedAt(value: string | number | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 10_000_000_000 ? value * 1000 : value;
    }
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed) ? parsed : null;
}

function isExpiredBucket(value: string | number | null | undefined, ttlMs: number, nowMs: number): boolean {
    const updatedAtMs = parseBucketUpdatedAt(value);
    if (updatedAtMs === null) return true;
    return nowMs - updatedAtMs > ttlMs;
}
