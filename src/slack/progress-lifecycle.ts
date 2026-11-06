import { reportSlackFailure, slackFailureRoutingEnabled } from './failure-routing.js';
import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import { subscribe } from '../core/event-bus.js';
import { log } from '../core/logger.js';
import { subscribeRuntimeLiveness } from '../agent/runtime/liveness.js';
import { projectSlackPrintTool, projectSlackRuntimeTool, type SlackActivityTool } from './progress-activity.js';
import { startSlackProgress, type SlackProgressHandle, type SlackProgressOutcome, type SlackProgressPhase } from './progress.js';
import type { RemoteTarget } from '../messaging/types.js';
import { matchesRunPin } from '../messaging/run-pin.js';
import type { RuntimeLivenessIdentity } from '../shared/runtime-contract.js';

export type SlackProgressFinishOptions = { reason?: 'merged' | 'removed'; bodyDelivered?: boolean; routeFailure?: boolean };
export type SlackProgressLifecycle = {
    start(options: { initialPhase: 'queued' | 'running' }): void;
    phase(value: SlackProgressPhase): void;
    finish(outcome: SlackProgressOutcome, options?: SlackProgressFinishOptions): Promise<void>;
    seal(): void;
    drain(signal?: AbortSignal): Promise<void>;
};
export type SlackProgressLifecycleOptions = {
    workflowResponse?: boolean;
    token: string; target: RemoteTarget; requestId: string; scope: string; sessionId: string; locale: string;
    recipientUserId?: string;
    workingDir?: string;
    registerTeardown(requestId: string, seal: () => void, drain: (signal?: AbortSignal) => Promise<void>): () => void;
    onPosted(ts: string): void;
    onTerminalConfirmed(): void;
    onExecutionOutcome?(outcome: 'error' | 'cancelled'): void;
    onSeal?(): void;
    onActivity?(): void;
};
const MAX_BUFFER = 32;
const MAX_CANDIDATES = 4;
const BUFFER_TTL_MS = 30000;
const identityField = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;
type NativePending = { runId: string; seq: number; at: number; tool: SlackActivityTool };

export function createSlackProgressLifecycle(input: SlackProgressLifecycleOptions): SlackProgressLifecycle {
    const config = { ...input, target: { ...input.target } };
    let acceptingTools = true;
    let detached = false;
    let shutdown = false;
    let aborted = false;
    let current: SlackProgressHandle | null = null;
    let handle: Promise<SlackProgressHandle | null> | null = null;
    let terminal: Promise<void> | null = null;
    let pendingPhase: SlackProgressPhase | undefined;
    let pending: SlackActivityTool[] = [];
    let nativePending: NativePending[] = [];
    const pendingGaps = new Map<string, number>();
    let activityUnavailable = false;
    let lastRuntimeAt: number | undefined;
    let boundRun: string | null = null;
    let lastNativeSeq = 0;
    let knownOutcome: 'error' | 'cancelled' | undefined;
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let unregister = () => {};
    let unsubscribeIdentity = () => {};
    let unsubscribeEvents = () => {};
    const enabled = Boolean(config.requestId && config.scope && config.sessionId);
    const notify = (fn: () => void) => { try { fn(); } catch { log.warn('[slack:progress] observer callback failed'); } };
    const matches = (data: Record<string, unknown>): boolean => matchesRunPin({
        requestId: config.requestId,
        origin: 'slack',
        scope: config.scope,
        sessionId: config.sessionId,
    }, data);
    function clearNativeBuffer(): void {
        nativePending = [];
        pendingGaps.clear();
        if (bufferTimer) clearTimeout(bufferTimer);
        bufferTimer = null;
    }
    function scheduleBufferExpiry(): void {
        if (bufferTimer || !nativePending.length || detached) return;
        bufferTimer = setTimeout(() => {
            bufferTimer = null;
            nativePending = nativePending.filter(entry => Date.now() - entry.at < BUFFER_TTL_MS);
            scheduleBufferExpiry();
        }, Math.max(1, nativePending[0]!.at + BUFFER_TTL_MS - Date.now()));
        bufferTimer.unref?.();
    }
    function observe(tool: SlackActivityTool): void {
        if (!acceptingTools || detached) return;
        notify(() => config.onActivity?.());
        if (current) current.projectedTool(tool);
        else {
            pending.push(tool);
            while (pending.length + nativePending.length > MAX_BUFFER) {
                if (nativePending.length) nativePending.shift(); else pending.shift();
            }
        }
    }
    function acceptNative(entry: NativePending): void {
        if (entry.runId !== boundRun || entry.seq <= lastNativeSeq) return;
        lastNativeSeq = entry.seq;
        observe(entry.tool);
    }
    function markUnavailable(): void {
        if (activityUnavailable || !acceptingTools || detached) return;
        activityUnavailable = true;
        current?.phase('unavailable');
    }
    function bind(identity: Readonly<RuntimeLivenessIdentity>): void {
        if (detached || identity.requestId !== config.requestId || identity.origin !== 'slack'
            || identity.scope !== config.scope || identity.sessionId !== config.sessionId
            || !identityField(identity.runId) || (boundRun && boundRun !== identity.runId)) return;
        notify(() => config.onActivity?.());
        if (acceptingTools) {
            lastRuntimeAt = Date.now();
            current?.runtimeLiveness(lastRuntimeAt);
        }
        if (!acceptingTools || boundRun) return;
        boundRun = identity.runId;
        const gapAt = pendingGaps.get(boundRun);
        const entries = nativePending.filter(entry => entry.runId === boundRun && Date.now() - entry.at < BUFFER_TTL_MS)
            .sort((a, b) => a.seq - b.seq);
        clearNativeBuffer();
        for (const entry of entries) acceptNative(entry);
        if (gapAt !== undefined && Date.now() - gapAt < BUFFER_TTL_MS) markUnavailable();
    }
    function legacy(type: string, data: Record<string, unknown>): void {
        if (detached || !data || !matches(data)) return;
        if (type === 'request_settled') {
            const next = data['outcome'] === 'failed' ? 'error'
                : data['outcome'] === 'cancelled' || data['outcome'] === 'dropped' ? 'cancelled' : undefined;
            if (next) { const outcome = knownOutcome ?? next; knownOutcome = outcome; notify(() => config.onExecutionOutcome?.(outcome)); }
            return;
        }
        if (type !== 'agent_tool' || !acceptingTools) return;
        if (boundRun && data['traceRunId'] === boundRun) return;
        const projected = projectSlackPrintTool(data, config.workingDir);
        if (projected) observe(projected);
    }
    function detach(): void {
        if (detached) return;
        detached = true;
        acceptingTools = false;
        removeBroadcastListener(legacy);
        unsubscribeIdentity(); unsubscribeEvents();
        clearNativeBuffer();
    }
    function seal(): void {
        if (shutdown) return;
        shutdown = true;
        detach();
        notify(() => config.onSeal?.());
    }
    function finish(outcome: SlackProgressOutcome, finishOptions: SlackProgressFinishOptions = {}): Promise<void> {
        if (terminal) return terminal;
        detach();
        terminal = Promise.resolve().then(async () => {
            if (finishOptions.routeFailure !== false && slackFailureRoutingEnabled() && (outcome === 'error' || outcome === 'expired')) {
                await reportSlackFailure(config.token, config.target, config.requestId);
            }
            const active = await handle;
            if (!active) return;
            await active.finish(outcome, finishOptions);
            const ready = await active.ready();
            if (active.terminalConfirmed() || ready.mode === 'none') notify(() => config.onTerminalConfirmed());
        }).catch(() => log.warn('[slack:progress] lifecycle finalization failed')).finally(() => {
            pending = [];
            unregister();
        });
        return terminal;
    }
    function drain(signal?: AbortSignal): Promise<void> {
        seal();
        const abort = () => { aborted = true; current?.abort(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        return finish(knownOutcome ?? 'expired').finally(() => signal?.removeEventListener('abort', abort));
    }
    if (enabled) {
        addBroadcastListener(legacy);
        unsubscribeIdentity = subscribeRuntimeLiveness(bind);
        unsubscribeEvents = subscribe(event => {
            const data = event.data;
            if (acceptingTools && !detached && event.topic === 'agent' && event.event === 'agent_runtime_gap'
                && data['scope'] === config.scope && data['sessionId'] === config.sessionId
                && data['reason'] === 'projection_degraded' && identityField(data['runId'])) {
                if (boundRun) {
                    if (data['runId'] === boundRun) markUnavailable();
                } else {
                    pendingGaps.set(data['runId'], Date.now());
                    while (pendingGaps.size > MAX_CANDIDATES) pendingGaps.delete(pendingGaps.keys().next().value!);
                }
                return;
            }
            if (!acceptingTools || detached || event.topic !== 'agent' || event.event !== 'agent_runtime'
                || data['version'] !== 1 || data['scope'] !== config.scope || data['sessionId'] !== config.sessionId
                || data['kind'] !== 'tool' || !identityField(data['runId']) || !identityField(data['turnId'])
                || !identityField(data['itemId']) || !Number.isSafeInteger(data['seq']) || Number(data['seq']) <= 0) return;
            const projected = projectSlackRuntimeTool(data, config.workingDir);
            if (!projected) return;
            const entry = { runId: data['runId'], seq: Number(data['seq']), at: Date.now(), tool: projected };
            if (boundRun) { acceptNative(entry); return; }
            nativePending = nativePending.filter(item => Date.now() - item.at < BUFFER_TTL_MS);
            const candidates = new Set(nativePending.map(item => item.runId));
            if (!candidates.has(entry.runId) && candidates.size >= MAX_CANDIDATES) {
                const oldest = nativePending[0]?.runId;
                nativePending = nativePending.filter(item => item.runId !== oldest);
            }
            nativePending.push(entry);
            while (pending.length + nativePending.length > MAX_BUFFER) nativePending.shift();
            scheduleBufferExpiry();
        });
        unregister = config.registerTeardown(config.requestId, seal, drain);
    }
    return {
        start({ initialPhase }) {
            if (!enabled || handle || terminal || shutdown) return;
            handle = startSlackProgress(config.token, config.target, '', {
                locale: config.locale, initialPhase,
                workflowResponse: config.workflowResponse === true,
                ...(config.workingDir ? { workingDir: config.workingDir } : {}),
                ...(config.recipientUserId ? { recipientUserId: config.recipientUserId } : {}),
                onPosted: ts => notify(() => config.onPosted(ts)),
            }).then(active => {
                current = active;
                if (activityUnavailable) active.phase('unavailable');
                if (lastRuntimeAt !== undefined) active.runtimeLiveness(lastRuntimeAt);
                for (const entry of pending) active.projectedTool(entry);
                pending = [];
                if (pendingPhase) active.phase(pendingPhase);
                if (aborted) active.abort();
                return active;
            }).catch(() => { log.warn('[slack:progress] lifecycle startup failed'); return null; });
        },
        phase(value) {
            if (terminal || shutdown) return;
            pendingPhase = value;
            if (value === 'delivering') { acceptingTools = false; clearNativeBuffer(); }
            current?.phase(value);
        },
        finish, seal, drain,
    };
}
