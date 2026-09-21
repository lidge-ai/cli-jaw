// ─── orchestrateAndCollect ──────────────────────────
// Extracted from bot.ts. Wraps orchestrate call and collects
// results via broadcast listener into a Promise<string>.
// Used by heartbeat.ts and bot.ts for TG orchestration.

import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { t } from '../core/i18n.js';
import { isRenderableError } from '../messaging/error-block.js';
import { hasNativeRuntimeTags } from '../messaging/native-body.js';
import type { RuntimeLivenessIdentity, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { settings } from '../core/config.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { resolveExecutionBinding } from './scope.js';
import { matchesRunPin } from '../messaging/run-pin.js';
import { isRemoteTarget } from '../messaging/types.js';

export interface CollectedOrchestrateResult {
    text: string;
    data: Record<string, any> & {
        agyPlannerOnly?: boolean;
        agyCheckpointSeen?: boolean;
        runtimeFinality?: 'present' | 'absent';
        runtimeStatus?: RuntimeTurnOutcome['status'];
        /** Collector provenance, not provider finality or model output. */
        collectionFailure?: 'error' | 'timeout';
        executionFailed?: boolean;
        executionInterrupted?: boolean;
    };
}

/** Like orchestrateAndCollect, but resolves the full orchestrate_done payload
 *  (e.g. elicitationSpecs for telegram inline keyboards) alongside the text. */
export function orchestrateAndCollectData(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<CollectedOrchestrateResult> {
    meta = { ...meta };
    return new Promise((resolve) => {
        const binding = resolveExecutionBinding({
            ...meta,
            chatSessionId: meta['chatSessionId'] === undefined ? meta['sessionId'] : meta['chatSessionId'],
            persistedScopeId: meta['remoteKey'],
            captured: currentSessionScope() ?? null,
            activeChatSessionId: getActiveChatSession(),
            multiSessionEnabled: settings['multiSession']?.enabled === true,
        });
        const runMeta = { ...meta, ...binding, origin: meta['origin'] || 'web',
            _onRuntimeActivity: onRuntimeActivity };
        const requestId = meta['requestId'] || undefined;
        const strictTerminalPin = runMeta.origin === 'slack' && requestId
            ? {
                requestId,
                origin: 'slack',
                scope: binding.scope,
                sessionId: binding.chatSessionId,
                remoteKey: meta['remoteKey'],
                target: isRemoteTarget(meta['target']) ? { ...meta['target'] } : undefined,
            }
            : null;
        let collected = '';
        let ownTerminalDiagnostic = '';
        let nativeSeen = false;
        // Set when a LATER request steers this scope. The steer kills this run
        // mid-flight, so its terminal carries no text — but that is a handover,
        // not a failure, and must not surface as the "no response" placeholder.
        let superseded = false;
        let settled = false;
        let runtimeActive = true;
        let nativeRunId: string | undefined;
        let timeout: ReturnType<typeof setTimeout>;
        const IDLE_TIMEOUT = 1200000;

        function resetTimeout() {
            if (settled) return;
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                settled = true;
                runtimeActive = false;
                removeBroadcastListener(handler);
                // This is a collector/application timeout, not a runtime
                // completion. Only collection provenance is added: agent_done does not
                // authorize synthesizing model-final/status tags here. Once a
                // native run is known, only its correlated classified diagnostic
                // may replace the existing timeout copy, never global collected.
                resolve({ text: (nativeSeen ? ownTerminalDiagnostic : collected) || t('tg.timeout', {}, locale), data: { collectionFailure: 'timeout' } });
            }, IDLE_TIMEOUT);
        }

        function onRuntimeActivity(identity: RuntimeLivenessIdentity) {
            if (settled || !runtimeActive || identity.scope !== binding.scope
                || identity.sessionId !== binding.chatSessionId || identity.origin !== runMeta.origin
                || identity.requestId !== requestId || !identity.runId.trim()
                || (nativeRunId !== undefined && identity.runId !== nativeRunId)) return;
            nativeRunId = identity.runId;
            nativeSeen = true;
            resetTimeout();
        }

        const matchesNativeIdentity = (data: Record<string, unknown>): boolean => {
            return (!requestId || data['requestId'] === requestId)
                && data['scope'] === binding.scope
                && data['sessionId'] === binding.chatSessionId
                && data['origin'] === runMeta.origin
                && (nativeRunId === undefined || data['traceRunId'] === nativeRunId);
        };
        const handler = (type: string, data: Record<string, any>) => {
            if (settled) return;
            if (meta['_strictRequestOwnership'] === true && !matchesNativeIdentity(data)) return;
            // Same observation the delivery layer makes, through the neutral
            // predicate rather than the delivery-named one: this listener uses
            // it to ignore a foreign native terminal, not to choose a transport.
            const native = hasNativeRuntimeTags(data);
            // A mismatched native terminal must not remove this request's
            // listener, extend its timeout, or contaminate its diagnostic.
            if (native && !matchesNativeIdentity(data)) return;
            if (native && (type === 'agent_done' || type === 'orchestrate_done')) nativeSeen = true;
            if (native && type === 'agent_done') runtimeActive = false;
            // Live assistant chunks arrive as agent_output (Web UI + spawn.ts); legacy alias agent_chunk.
            if (type === 'agent_chunk' || type === 'agent_output' || type === 'agent_tool' ||
                type === 'agent_status' || type === 'agent_retry' ||
                type === 'agent_done' || type === 'agent_fallback' ||
                type === 'round_start' || type === 'round_done') {
                resetTimeout();
            }
            // agent_output is the live stream event; agent_done remains authoritative.
            if (type === 'agent_done' && data["error"] && data["text"]) {
                collected = collected || data["text"];
                if (typeof meta['requestId'] === 'string' && meta['requestId']
                    && matchesNativeIdentity(data) && isRenderableError(data)
                    && typeof data['text'] === 'string' && data['text'].trim()) {
                    ownTerminalDiagnostic = ownTerminalDiagnostic || data['text'];
                }
            }
            // A steer aimed at THIS conversation retires this turn: the process is
            // killed and the follow-up run owns the answer. Identity is checked so
            // an unrelated scope's steer cannot retire this one, and the requestId
            // must differ — a steer carrying our own id is not a supersession.
            if (type === 'steer_started'
                && data['scope'] === binding.scope
                && data['sessionId'] === binding.chatSessionId
                && data['origin'] === runMeta.origin
                && (meta['remoteKey'] === undefined || data['remoteKey'] === meta['remoteKey'])
                && (!requestId || data['requestId'] !== requestId)) {
                superseded = true;
            }
            if (type === 'orchestrate_done') {
                if (strictTerminalPin && !matchesRunPin(strictTerminalPin, data)) return;
                // Filter by requestId (strongest), then origin, then chatId
                if (meta?.["requestId"] && data?.["requestId"] && data["requestId"] !== meta["requestId"]) return;
                if (meta?.["origin"] && data?.["origin"] && data["origin"] !== meta["origin"]) return;
                if (!meta?.["requestId"] && meta?.["chatId"] && data?.["chatId"] && data["chatId"] !== meta["chatId"]) return;
                clearTimeout(timeout);
                settled = true;
                runtimeActive = false;
                removeBroadcastListener(handler);
                const terminalText = typeof data['text'] === 'string' && data['text'].trim() ? data['text'] : '';
                // An empty terminal has more than one cause, and "no response"
                // reads as a failure for all of them. Two are separable here:
                // a run that was stopped before it finished (native
                // `runtimeStatus: 'stopped'`, or the legacy
                // `executionInterrupted` flag) versus a run that finished and
                // simply had nothing to say.
                //
                const stopped = data['runtimeStatus'] === 'stopped' || data['executionInterrupted'] === true;
                const fallbackKey = stopped ? stoppedLocaleKey(data['stopCause']) : 'tg.noResponse';
                const fallback = superseded ? '' : t(fallbackKey, {}, locale);
                resolve({ text: native
                    ? terminalText || ownTerminalDiagnostic || fallback
                    : data["text"] || collected || fallback,
                    data: superseded ? { ...data, superseded: true } : data });
            }
        };
        addBroadcastListener(handler);
        resetTimeout();
        const run = isResetIntent(prompt)
            ? orchestrateReset(runMeta)
            : isContinueIntent(prompt)
                ? orchestrateContinue(runMeta)
                : orchestrate(prompt, runMeta);
        Promise.resolve(run).catch(err => {
            if (settled) return;
            settled = true;
            runtimeActive = false;
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve({ text: `❌ ${err.message}`, data: { collectionFailure: 'error' } });
        });
    });
}

export async function orchestrateAndCollect(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<string> {
    return (await orchestrateAndCollectData(prompt, meta, locale)).text;
}

export function stoppedLocaleKey(cause: unknown): string {
    if (cause === 'watchdog') return 'tg.stoppedWatchdog';
    if (cause === 'user_stop') return 'tg.stoppedUser';
    if (cause === 'steer_kill') return 'tg.stoppedSteer';
    if (cause === 'unattributed') return 'tg.stoppedUnattributed';
    return 'tg.stopped';
}
