// Message queue controller — factory pattern to avoid spawn.ts circular imports.

import crypto from 'node:crypto';
import type { RuntimeOrigin, RemoteTarget } from '../../messaging/types.js';
import { groupQueueKey, type SessionScope } from '../../messaging/session-key.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { withSessionScope } from '../../core/session-context.js';
import { sessionLanes, type SessionLanes } from '../../orchestrator/session-lanes.js';
import { scopeForChatSession } from '../../orchestrator/scope.js';
import { settleOnce } from '../../orchestrator/request-registry.js';
import { readSlackWorkflowMetadata, type SlackWorkflowMetadata } from '../../slack/workflow.js';
import { runPinFields } from '../../messaging/run-pin.js';

type QueueItem = {
    slackWorkflow?: SlackWorkflowMetadata;
    schemaVersion?: 2;
    id: string;
    prompt: string;
    source: RuntimeOrigin;
    scope: string;
    chatSessionId?: string;
    remoteKey?: string;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    overrides?: { cli?: string; model?: string; effort?: string; systemPrompt?: string };   // P4 per-topic override, carried through the queue
    replyViaTarget?: boolean;
    collect?: boolean;
    priority?: 'head';
    ts: number;
};

type QueueMessageMeta = {
    slackWorkflow?: SlackWorkflowMetadata;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    scope?: string;
    chatSessionId?: string;
    remoteKey?: string;
    overrides?: { cli?: string; model?: string; effort?: string; systemPrompt?: string };
    replyViaTarget?: boolean;
    collect?: boolean;
    front?: boolean;
};

export interface QueueDeps {
    migrateQueuedMessagesV1ToV2(): void;
    isSpawnBusy(scopeKey: string): boolean;
    hasBlockingWorkers(scopeKey: string): boolean;
    hasPendingWorkerReplays(scopeKey: string): boolean;
    insertMessage: { run(...args: any[]): any };
    getActiveChatSession(): string;
    insertQueuedMessage: { run(...args: any[]): any };
    deleteQueuedMessage: { run(...args: any[]): any };
    listQueuedMessages: { all(): Array<{ id: string; payload: string }> };
    broadcast(type: string, data: Record<string, any>, audience?: 'public' | 'internal'): void;
    importPipeline(): Promise<{
        orchestrate: (...args: any[]) => Promise<void>;
        orchestrateContinue: (...args: any[]) => Promise<void>;
        orchestrateReset: (...args: any[]) => Promise<void>;
        isContinueIntent: (text: string) => boolean;
        isResetIntent: (text: string) => boolean;
        drainPendingReplays: (scopeKey: string, opts: { origin: string }) => Promise<void>;
    }>;
    getWorkingDir(): string | null;
    isMultiSessionEnabled(): boolean;
    isLocalSessionScopeEnabled?(): boolean;
    /**
     * Chat session bound to a remote conversation key, when one exists.
     *
     * Injected rather than imported so the queue keeps its test seam, and
     * optional so an embedder that has no remote bindings simply omits it.
     */
    resolveRemoteSession?(remoteKey: string): string | null;
}

export const FALLBACK_MAX_RETRIES = 3;

export type FallbackStateEntry = { fallbackCli?: string; retriesLeft: number };

type RetryState = {
    timer: ReturnType<typeof setTimeout> | null;
    resolve: ((v: { text: string; code: number }) => void) | null;
    origin: string | null;
    isEmployee: boolean;
};

type HoldState = {
    id: string;
    timer: ReturnType<typeof setTimeout>;
};

export interface QueueController {
    enqueueMessage(prompt: string, source: RuntimeOrigin, meta?: QueueMessageMeta): string;
    removeQueuedMessage(id: string): { removed: QueueItem | null; pending: number };
    processQueue(scopeKey?: string): Promise<void>;
    drainRecoveredQueue(): void;
    setQueueHold(scopeKey: string, idOrTimeout?: string | number, timeoutMs?: number): void;
    clearQueueHold(scopeKey?: string | null, idOrOpts?: string | { resume?: boolean }, opts?: { resume?: boolean }): void;
    getQueueHoldId(scopeKey?: string): string | null;
    isScopedQueue(): boolean;
    clearRetryTimer(scopeKeyOrResume?: string | boolean, resumeQueue?: boolean): void;
    resetFallbackState(scopeKey?: string | null): void;
    getFallbackState(scopeKey?: string | null): Record<string, unknown>;
    getQueuedMessageSnapshotForScope(scope: string): Array<{
        id: string; prompt: string; source: RuntimeOrigin; ts: number;
    }>;
    readonly messageQueue: QueueItem[];
    fallbackStateForScope(scopeKey: string): Map<string, FallbackStateEntry>;
    isRetryPending(scopeKey?: string | null): boolean;
    isQueueBusy(scopeKey?: string | null): boolean;
    purgeQueueOnStop(scopeKey: string | null, reason: string): void;
    retryStateForScope(scopeKey: string): {
        timer: ReturnType<typeof setTimeout> | null;
        resolve: Function | null;
        origin: string | null;
        setTimer: (t: ReturnType<typeof setTimeout> | null) => void;
        setResolve: (r: ((v: { text: string; code: number }) => void) | null) => void;
        setOrigin: (o: string | null) => void;
        setIsEmployee: (v: boolean) => void;
    };
}

export function createQueueController(
    deps: QueueDeps,
    lanes: SessionLanes = sessionLanes,
): QueueController {
    const multiSessionEnabled = deps.isMultiSessionEnabled();
    const localSessionScopeEnabled = deps.isLocalSessionScopeEnabled?.() === true;
    if (multiSessionEnabled) deps.migrateQueuedMessagesV1ToV2();

    function normalizeQueueItem(row: { id: string; payload: string }): QueueItem[] {
        try {
            const parsed = JSON.parse(row.payload) as Partial<QueueItem>;
            if (typeof parsed?.id !== 'string' || typeof parsed?.prompt !== 'string' || typeof parsed?.source !== 'string') {
                return [];
            }
            const remoteKey = typeof parsed.remoteKey === 'string' ? parsed.remoteKey : undefined;
            // A payload written before this field existed, or one whose id was
            // dropped somewhere upstream, still knows WHICH conversation it came
            // from. Falling straight to 'default' threw that away and the item
            // was later inserted into whatever session happened to be active (#399).
            const chatSessionId = typeof parsed.chatSessionId === 'string'
                ? parsed.chatSessionId
                : (remoteKey ? deps.resolveRemoteSession?.(remoteKey) ?? 'default' : 'default');
            const persistedScope = multiSessionEnabled && typeof parsed.scope === 'string' ? parsed.scope : 'default';
            const slackWorkflow = parsed.source === 'slack' ? readSlackWorkflowMetadata(parsed.slackWorkflow, parsed.target) : undefined;
            if (parsed.slackWorkflow !== undefined && !slackWorkflow) return [];
            // `localSessionScopeEnabled` governs LOCAL scopes: whether a plain chat
            // session gets a scope of its own. A remote conversation is not that, and
            // passing the local flag as the gate made an unpersisted Slack item collapse
            // to 'default' even though its remoteKey was right there (#399). Remote
            // items are gated by multi-session being on at all.
            const scope = persistedScope === 'default'
                ? scopeForChatSession(
                    chatSessionId,
                    remoteKey,
                    remoteKey ? multiSessionEnabled : localSessionScopeEnabled,
                )
                : persistedScope;
            return [stripUndefined({
                ...(multiSessionEnabled ? { schemaVersion: 2 as const } : {}),
                id: parsed.id,
                prompt: parsed.prompt,
                source: parsed.source,
                scope,
                ...((multiSessionEnabled || parsed.source === 'slack') ? {
                    chatSessionId,
                    ...(remoteKey ? { remoteKey } : {}),
                } : {}),
                target: parsed.target,
                chatId: parsed.chatId,
                requestId: parsed.requestId,
                overrides: parsed.overrides,
                replyViaTarget: parsed.replyViaTarget === true,
                ...(slackWorkflow ? { slackWorkflow } : {}),
                ...(multiSessionEnabled && parsed.collect === true ? { collect: true } : {}),
                ...(multiSessionEnabled && parsed.priority === 'head' ? { priority: 'head' as const } : {}),
                ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
            })];
        } catch {
            return [];
        }
    }

    function loadPersistedQueue(): QueueItem[] {
        const recovered = (deps.listQueuedMessages.all() as Array<{ id: string; payload: string }>).flatMap(normalizeQueueItem);
        if (!multiSessionEnabled) return recovered;
        // Restore each scope's internal order, not a global one. Hoisting every
        // `head` item to the front of the whole queue re-created the ordering bug
        // that enqueueing was just fixed for: an interrupt saved by session A came
        // back ahead of session B, which had been waiting first (#453).
        const byScope = new Map<string, QueueItem[]>();
        for (const item of recovered) {
            const scope = item.scope ?? 'default';
            const bucket = byScope.get(scope);
            if (bucket) bucket.push(item);
            else byScope.set(scope, [item]);
        }
        for (const [scope, items] of byScope) {
            byScope.set(scope, [
                ...items.filter(item => item.priority === 'head'),
                ...items.filter(item => item.priority !== 'head'),
            ]);
        }
        // Scopes keep the order they were first seen in, so cross-scope fairness
        // survives the restart too.
        const seen = new Set<string>();
        const ordered: QueueItem[] = [];
        for (const item of recovered) {
            const scope = item.scope ?? 'default';
            if (seen.has(scope)) continue;
            seen.add(scope);
            ordered.push(...(byScope.get(scope) ?? []));
        }
        return ordered;
    }

    const messageQueue: QueueItem[] = loadPersistedQueue();
    if (messageQueue.length > 0) {
        console.log(`[queue] recovered ${messageQueue.length} persisted message(s) from previous session`);
    }
    /**
     * Put an interrupt ahead of its OWN scope, not ahead of everyone.
     *
     * `unshift` sent it to the head of the global array, so interrupting session
     * A promoted that turn past session B's older waiting message. Interrupt is a
     * scope-local policy — "drop what I am doing and take this instead" — and it
     * was silently reordering conversations that had nothing to do with it.
     *
     * Landing before the first item of the same scope preserves that meaning and
     * leaves every other scope's relative order untouched.
     */
    function insertAheadOfScope(item: QueueItem): void {
        const scope = normalizeScope(item.scope);
        const at = messageQueue.findIndex(queued => normalizeScope(queued.scope) === scope);
        if (at === -1) messageQueue.push(item);
        else messageQueue.splice(at, 0, item);
    }
    /**
     * Wake the queue we just recovered.
     *
     * Recovering is not delivering: nothing on the boot path called
     * `processQueue`, so messages that arrived while the process was down sat in
     * the queue until a NEW message happened to arrive and drag them out. From
     * the outside the bot had simply gone quiet (#407).
     *
     * Not called here. This controller is built during module init
     * (spawn.ts:405), before settings load (server.ts) and before the transports
     * exist, so a turn started at construction has nowhere to answer. The server
     * calls this once it is actually ready.
     */
    function drainRecoveredQueue(): void {
        if (messageQueue.length === 0) return;
        const scopes = new Set(messageQueue.map(item => normalizeScope(item.scope)));
        console.log(`[queue] boot drain: ${messageQueue.length} message(s) across ${scopes.size} scope(s)`);
        for (const scope of scopes) {
            // One kick per scope. `processQueue` takes a single item and
            // schedules its own successor, so this starts each lane rather than
            // draining it here.
            void processQueue(scope).catch(err =>
                console.error('[queue:boot-drain]', (err as Error).message));
        }
    }
    const QUEUE_HOLD_TIMEOUT_MS = 10_000;
    const drainingScopes = new Set<string>();
    const retryByScope = new Map<string, RetryState>();
    const fallbackByScope = new Map<string, Map<string, FallbackStateEntry>>();
    const holdByScope = new Map<string, HoldState>();
    const scheduledItemIds = new Set<string>();
    const normalizeScope = (scopeKey = 'default') => multiSessionEnabled ? scopeKey : 'default';

    function retryEntry(scopeKey: string): RetryState {
        const scope = normalizeScope(scopeKey);
        let state = retryByScope.get(scope);
        if (!state) {
            state = { timer: null, resolve: null, origin: null, isEmployee: false };
            retryByScope.set(scope, state);
        }
        return state;
    }

    function fallbackStateForScope(scopeKey: string): Map<string, FallbackStateEntry> {
        const scope = normalizeScope(scopeKey);
        let state = fallbackByScope.get(scope);
        if (!state) {
            state = new Map<string, FallbackStateEntry>();
            fallbackByScope.set(scope, state);
        }
        return state;
    }

    function clearRetryTimer(scopeKeyOrResume: string | boolean = 'default', resumeQueue = true): void {
        const legacyCall = typeof scopeKeyOrResume === 'boolean';
        const scope = normalizeScope(legacyCall ? 'default' : scopeKeyOrResume);
        const shouldResume = legacyCall ? scopeKeyOrResume : resumeQueue;
        const state = retryByScope.get(scope);
        if (state?.timer) {
            clearTimeout(state.timer);
            state.timer = null;
            console.log(`[jaw:retry] timer cancelled scope=${scope}`);

            if (state.resolve) {
                deps.broadcast('agent_done', {
                    text: '⏹️ 재시도 취소됨',
                    error: true,
                    origin: state.origin || 'web',
                    ...(state.isEmployee ? { isEmployee: true } : {}),
                }, state.isEmployee ? 'internal' : 'public');
                state.resolve({ text: '', code: -1 });
                state.resolve = null;
                state.origin = null;
                state.isEmployee = false;
            }
            if (shouldResume) void processQueue(scope);
        }
    }

    function resetFallbackState(scopeKey: string | null = 'default') {
        if (scopeKey === null) {
            for (const scope of retryByScope.keys()) clearRetryTimer(scope, false);
            retryByScope.clear();
            fallbackByScope.clear();
        } else {
            const scope = normalizeScope(scopeKey);
            clearRetryTimer(scope, false);
            retryByScope.delete(scope);
            fallbackByScope.delete(scope);
        }
        console.log('[jaw:fallback] state reset');
    }

    function getFallbackState(scopeKey: string | null = 'default'): Record<string, unknown> {
        if (scopeKey === null) {
            return Object.fromEntries([...fallbackByScope].map(([scope, state]) => [scope, Object.fromEntries(state)]));
        }
        return Object.fromEntries(fallbackStateForScope(scopeKey));
    }

    function setQueueHold(scopeKey: string, idOrTimeout?: string | number, timeoutMs = QUEUE_HOLD_TIMEOUT_MS): void {
        const legacyCall = typeof idOrTimeout !== 'string';
        const scope = normalizeScope(legacyCall ? 'default' : scopeKey);
        const id = legacyCall ? scopeKey : idOrTimeout;
        const timeout = typeof idOrTimeout === 'number' ? idOrTimeout : timeoutMs;
        const previous = holdByScope.get(scope);
        if (previous) clearTimeout(previous.timer);
        const timer = setTimeout(() => {
            if (holdByScope.get(scope)?.id !== id) return;
            console.warn(`[queue:hold] hold for ${id} expired after ${timeout}ms scope=${scope}`);
            clearQueueHold(scope, id);
        }, timeout);
        holdByScope.set(scope, { id, timer });
        console.log(`[queue:hold] set for ${id} scope=${scope}`);
    }

    function clearQueueHold(
        scopeKey: string | null = 'default',
        idOrOpts?: string | { resume?: boolean },
        opts?: { resume?: boolean },
    ): void {
        const legacyCall = typeof idOrOpts === 'object' || (arguments.length === 1 && typeof scopeKey === 'string');
        const requestedId = legacyCall ? scopeKey ?? undefined : idOrOpts;
        const clearOpts = typeof idOrOpts === 'object' ? idOrOpts : opts;
        let scope: string;
        if (scopeKey === null) {
            if (!requestedId) return;
            const match = [...holdByScope].find(([, hold]) => hold.id === requestedId);
            if (!match) return;
            scope = match[0];
        } else {
            scope = normalizeScope(legacyCall ? 'default' : scopeKey);
        }
        const hold = holdByScope.get(scope);
        if (!hold || (requestedId && hold.id !== requestedId)) return;
        clearTimeout(hold.timer);
        holdByScope.delete(scope);
        console.log(`[queue:hold] cleared (was ${hold.id}) scope=${scope}`);
        if (clearOpts?.resume ?? true) queueMicrotask(() => { void processQueue(scope); });
    }

    function getQueueHoldId(scopeKey = 'default'): string | null {
        return holdByScope.get(normalizeScope(scopeKey))?.id ?? null;
    }

    function getQueuedMessageSnapshotForScope(scope: string): Array<{
        id: string; prompt: string; source: RuntimeOrigin; ts: number;
    }> {
        return messageQueue
            .filter(item => item.scope === scope)
            .map(item => ({
                id: item.id,
                prompt: item.prompt,
                source: item.source,
                ts: item.ts,
            }));
    }

    function queueUpdatePayload(scope = 'default'): { pending: number; queued: ReturnType<typeof getQueuedMessageSnapshotForScope>; scope?: string } {
        return {
            pending: messageQueue.length,
            queued: getQueuedMessageSnapshotForScope(scope),
            ...(multiSessionEnabled ? { scope } : {}),
        };
    }

    function drainHeartbeatPendingSoon(): void {
        queueMicrotask(() => {
            import('../../memory/heartbeat.js')
                .then(({ drainPending }) => drainPending())
                .catch(err => console.error('[processQueue:heartbeat-drain]', (err as Error).message));
        });
    }

    function removeQueuedMessage(id: string): { removed: QueueItem | null; pending: number } {
        const idx = messageQueue.findIndex(item => item.id === id);
        if (idx === -1) return { removed: null, pending: messageQueue.length };
        const [removed] = messageQueue.splice(idx, 1);
        settleOnce(removed?.requestId, 'dropped', { reason: 'deleted' });
        scheduledItemIds.delete(id);
        try { deps.deleteQueuedMessage.run(id); } catch (err) {
            console.warn(`[queue] DB delete failed for ${id}:`, (err as Error).message);
        }
        console.log(`[queue] -1 (${messageQueue.length} pending) removed=${id}`);
        deps.broadcast('queue_update', queueUpdatePayload(removed!.scope));
        return { removed: removed!, pending: messageQueue.length };
    }

    function enqueueMessage(prompt: string, source: RuntimeOrigin, meta?: QueueMessageMeta): string {
        const item: QueueItem = stripUndefined({
            ...(multiSessionEnabled ? { schemaVersion: 2 as const } : {}),
            id: crypto.randomUUID(),
            prompt,
            source,
            scope: multiSessionEnabled ? (meta?.scope || 'default') : 'default',
            ...((multiSessionEnabled || source === 'slack') ? {
                chatSessionId: meta?.chatSessionId || deps.getActiveChatSession(),
                ...(meta?.remoteKey ? { remoteKey: meta.remoteKey } : {}),
            } : {}),
            target: meta?.target,
            chatId: meta?.chatId,
            requestId: meta?.requestId,
            overrides: meta?.overrides,
            replyViaTarget: meta?.replyViaTarget,
            ...(source === 'slack' && meta?.slackWorkflow ? { slackWorkflow: meta.slackWorkflow } : {}),
            ...(multiSessionEnabled && meta?.collect === true ? { collect: true } : {}),
            ...(multiSessionEnabled && meta?.front === true ? { priority: 'head' as const } : {}),
            ts: Date.now(),
        });
        deps.insertQueuedMessage.run(item.id, JSON.stringify(item));
        if (multiSessionEnabled && meta?.front === true) insertAheadOfScope(item);
        else messageQueue.push(item);
        console.log(`[queue] +1 (${messageQueue.length} pending)`);
        deps.broadcast('queue_update', {
            ...queueUpdatePayload(item.scope),
            ...(item.requestId ? runPinFields({
                requestId: item.requestId,
                origin: item.source || 'web',
                scope: item.scope,
                sessionId: item.chatSessionId,
                remoteKey: item.remoteKey,
                target: item.target,
            }) : {}),
        });
        void processQueue(item.scope);
        return item.id;
    }

    // Queue policy: "fair" — batch head runs, tail goes after remaining.
    // Pending worker replays are intentionally not gated here: orchestrate()
    // drains them at entry, avoiding the documented processQueue deadlock.
    async function processQueue(scopeKey = 'default'): Promise<void> {
        const requestedScope = normalizeScope(scopeKey);
        if (
            !deps.isSpawnBusy(requestedScope)
            && !deps.hasBlockingWorkers(requestedScope)
            && deps.hasPendingWorkerReplays(requestedScope)
        ) {
            queueMicrotask(() => {
                deps.importPipeline()
                    .then(({ drainPendingReplays }) => drainPendingReplays(requestedScope, { origin: 'system' }))
                    .catch(err => console.error('[processQueue:drain]', (err as Error).message));
            });
        }
        if (
            !deps.isSpawnBusy(requestedScope)
            && !deps.hasBlockingWorkers(requestedScope)
            && !deps.hasPendingWorkerReplays(requestedScope)
            && messageQueue.length === 0
            && !holdByScope.has(requestedScope)
        ) {
            drainHeartbeatPendingSoon();
        }

        let item: QueueItem | undefined;
        for (const candidate of messageQueue) {
            const candidateScope = normalizeScope(candidate.scope);
            if (scheduledItemIds.has(candidate.id) || drainingScopes.has(candidateScope) || holdByScope.has(candidateScope)) continue;
            if (deps.isSpawnBusy(candidateScope) || deps.hasBlockingWorkers(candidateScope)) continue;
            if (deps.hasPendingWorkerReplays(candidateScope)) {
                queueMicrotask(() => {
                    deps.importPipeline()
                        .then(({ drainPendingReplays }) => drainPendingReplays(candidateScope, { origin: 'system' }))
                        .catch(err => console.error('[processQueue:drain]', (err as Error).message));
                });
                continue;
            }
            item = candidate;
            break;
        }
        if (!item) return;

        const itemScope = normalizeScope(item.scope);
        drainingScopes.add(itemScope);
        scheduledItemIds.add(item.id);
        queueMicrotask(() => { void processQueue(itemScope); });

        await lanes.runDetachedTurn(itemScope, async () => {
            const liveIndex = messageQueue.findIndex(candidate => candidate.id === item!.id);
            if (liveIndex === -1) {
                // Deleted after scheduling: nothing will run, so settle it here
                // rather than leaving the submitter waiting forever.
                settleOnce(item!.requestId, 'dropped', { reason: 'removed-before-run', scope: itemScope });
                scheduledItemIds.delete(item!.id);
                drainingScopes.delete(itemScope);
                queueMicrotask(() => { void processQueue(itemScope); });
                return;
            }
            const collectedItems = multiSessionEnabled && item!.collect
                ? messageQueue.filter(candidate => normalizeScope(candidate.scope) === itemScope
                    && candidate.collect === true
                    && candidate.remoteKey === item!.remoteKey
                    && !scheduledItemIds.has(candidate.id))
                : [];
            const runItems = [item!, ...collectedItems];
            const runIds = new Set(runItems.map(candidate => candidate.id));
            for (let index = messageQueue.length - 1; index >= 0; index--) {
                if (runIds.has(messageQueue[index]!.id)) messageQueue.splice(index, 1);
            }
            for (const runItem of runItems) scheduledItemIds.delete(runItem.id);
            // A collect run merges N requests but carries only the first id
            // forward, so the other N-1 callers would otherwise never hear back.
            for (const merged of collectedItems) {
                settleOnce(merged.requestId, 'merged', {
                    scope: itemScope,
                    ...(item!.requestId ? { mergedInto: item!.requestId } : {}),
                });
            }
        const groupKey = groupQueueKey(item.source, item.target);
        const combined = runItems.map(candidate => candidate.prompt).join('\n\n');
        const source = item.source;
        const target = item.target;
        const chatId = item.chatId;
        const requestId = item.requestId;
        const overrides = item.overrides;
        const replyViaTarget = item.replyViaTarget;
        const origin: RuntimeOrigin = source || 'web';
        console.log(`[queue] processing message for ${groupKey}, ${messageQueue.length} remaining`);

        // The globally active session is the right fallback for a local item and the
        // wrong one for a remote item: "whoever is on screen right now" has nothing to
        // do with the Slack thread this message came from.
        const remoteSessionId = item.remoteKey
            ? deps.resolveRemoteSession?.(item.remoteKey) ?? null
            : null;
        const effectiveSessionId = multiSessionEnabled || source === 'slack'
            ? (item.chatSessionId || remoteSessionId || (source === 'slack' ? 'default' : deps.getActiveChatSession()))
            : deps.getActiveChatSession();
        let inserted = false;
        try {
            const sessionScope: SessionScope = { scope: item.scope, chatSessionId: effectiveSessionId };
            const eventScope = multiSessionEnabled
                ? { scope: item.scope, sessionId: effectiveSessionId }
                : undefined;
            deps.insertMessage.run('user', combined, source, '', deps.getWorkingDir(), effectiveSessionId);
            inserted = true;
            for (const runItem of runItems) {
                try { deps.deleteQueuedMessage.run(runItem.id); } catch (err) {
                    console.warn(`[queue] DB delete failed for ${runItem.id}:`, (err as Error).message);
                }
            }
            if (multiSessionEnabled) {
                deps.broadcast('new_message', { role: 'user', content: combined, source, fromQueue: true, ...eventScope });
            } else {
                deps.broadcast('new_message', { role: 'user', content: combined, source, fromQueue: true });
            }
            // The queued turn is now RUNNING, and this is the only place that
            // knows which request it is. A listener waiting to anchor its
            // delivery claim needs that identity: a scope-blind "an agent
            // started" signal can latch while the PREVIOUS turn is still going,
            // and a claim that turn records afterwards would then sort as newer
            // than the anchor and swallow this turn's answer.
            //
            // Outside the multi-session branch above: the queue drains the same
            // way either way, and a single-session install has the same queued
            // turns with the same duplicate to prevent.
            if (requestId) deps.broadcast('queued_run_started', stripUndefined({
                requestId, origin, scope: item.scope, target, sessionId: effectiveSessionId,
                remoteKey: item.remoteKey,
                slackWorkflow: item.slackWorkflow,
            }));
            deps.broadcast('queue_update', queueUpdatePayload(item.scope));

            await withSessionScope(sessionScope, async () => {
                const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await deps.importPipeline();
                const scopedMeta = stripUndefined({
                    origin, target, chatId, requestId, scope: item.scope,
                    chatSessionId: effectiveSessionId,
                    ...(item.remoteKey ? { remoteKey: item.remoteKey } : {}),
                    overrides, replyViaTarget, _skipInsert: true,
                    slackWorkflow: item.slackWorkflow,
                    // Marks the completion so a channel can answer a turn whose
                    // original requester is gone — a boot-drained item has no
                    // listener left (#407). Ordinary turns must NOT carry this,
                    // or the dispatch path and the fallback both post.
                    _fromQueue: true,
                });
                const task = isResetIntent(combined)
                    ? orchestrateReset(scopedMeta)
                    : isContinueIntent(combined)
                        ? orchestrateContinue(scopedMeta)
                        : orchestrate(combined, scopedMeta);

                try {
                    await task;
                } catch (err: unknown) {
                    const msg = (err as Error).message;
                    console.error('[queue:orchestrate]', msg);
                    deps.broadcast('orchestrate_done', {
                        ...runPinFields({ requestId, origin, scope: item.scope, sessionId: effectiveSessionId,
                            remoteKey: item.remoteKey, target }),
                        text: `[error] ${msg}`, error: true, chatId, replyViaTarget, fromQueue: true,
                    });
                    // The pipeline threw before reaching its own settle site, so
                    // this is the last place that can answer the caller.
                    settleOnce(requestId, 'failed', { error: msg });
                }
            });
        } catch (setupErr) {
            console.error('[queue:setup]', setupErr);
            if (!inserted) {
                messageQueue.unshift(...runItems);
            } else {
                deps.broadcast('orchestrate_done', {
                    ...runPinFields({ requestId, origin, scope: item.scope, sessionId: effectiveSessionId,
                        remoteKey: item.remoteKey, target }),
                    text: `[error] setup failed: ${(setupErr as Error).message}`, error: true,
                    chatId, replyViaTarget, fromQueue: true,
                });
                // Re-queued items settle on their eventual run; these do not get
                // another chance, so answer the caller here.
                settleOnce(requestId, 'failed', { error: `setup failed: ${(setupErr as Error).message}` });
            }
        } finally {
            for (const runItem of runItems) scheduledItemIds.delete(runItem.id);
            drainingScopes.delete(itemScope);
            queueMicrotask(() => { void processQueue(itemScope); });
        }
        });
    }

    function purgeQueueOnStop(scopeKey: string | null, reason: string): void {
        const scope = scopeKey === null ? null : normalizeScope(scopeKey);
        const droppedItems = messageQueue.filter(item => scope === null || normalizeScope(item.scope) === scope);
        if (droppedItems.length === 0) return;
        for (const item of droppedItems) settleOnce(item.requestId, 'cancelled', { reason });
        const droppedIds = new Set(droppedItems.map(item => item.id));
        const scopes = new Set(droppedItems.map(item => item.scope));
        for (let index = messageQueue.length - 1; index >= 0; index--) {
            const item = messageQueue[index]!;
            if (!droppedIds.has(item.id)) continue;
            messageQueue.splice(index, 1);
            scheduledItemIds.delete(item.id);
            try { deps.deleteQueuedMessage.run(item.id); } catch { /* best-effort */ }
        }
        console.log(`[jaw:stop] cleared ${droppedItems.length} pending message(s) (reason=${reason})`);
        if (multiSessionEnabled) {
            for (const scope of scopes) deps.broadcast('queue_update', queueUpdatePayload(scope));
        } else {
            deps.broadcast('queue_update', queueUpdatePayload());
        }
    }

    return {
        enqueueMessage,
        removeQueuedMessage,
        processQueue,
        drainRecoveredQueue,
        setQueueHold,
        clearQueueHold,
        getQueueHoldId,
        // The gate is read once at construction, so every scope collapses onto 'default'
        // for the whole process life when it is off. Callers that build a scope key must
        // ask this instead of re-reading settings, or they look at a lane the queue never
        // uses (a live-settings read made session deletion miss real work).
        isScopedQueue: () => multiSessionEnabled,
        clearRetryTimer,
        resetFallbackState,
        getFallbackState,
        getQueuedMessageSnapshotForScope,
        messageQueue,
        fallbackStateForScope,
        isRetryPending: (scopeKey: string | null = 'default') => scopeKey === null
            ? [...retryByScope.values()].some(state => state.timer !== null)
            : Boolean(retryByScope.get(normalizeScope(scopeKey))?.timer),
        isQueueBusy: (scopeKey: string | null = 'default') => scopeKey === null
            ? drainingScopes.size > 0
            : drainingScopes.has(normalizeScope(scopeKey)),
        purgeQueueOnStop,
        retryStateForScope: (scopeKey: string) => {
            const state = retryEntry(scopeKey);
            return {
                get timer() { return state.timer; },
                get resolve() { return state.resolve as Function | null; },
                get origin() { return state.origin; },
                setTimer: (t: ReturnType<typeof setTimeout> | null) => { state.timer = t; },
                setResolve: (r: ((v: { text: string; code: number }) => void) | null) => { state.resolve = r; },
                setOrigin: (o: string | null) => { state.origin = o; },
                setIsEmployee: (v: boolean) => { state.isEmployee = v; },
            };
        },
    };
}
