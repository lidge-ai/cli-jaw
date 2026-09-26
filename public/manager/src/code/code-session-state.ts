import type {
    CodeEventsPage, CodeHistoryPage, CodeItem, CodePermissionRequest, CodeSessionInfo,
    CodeSnapshot, CodeWireEvent,
} from '../../../../src/code-mode/wire';

const MAX_BUFFER_EVENTS = 512;
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_ITEM_CHARS = 16 * 1024 * 1024;

export interface CodeSessionState {
    sessionId: string;
    session: CodeSessionInfo | null;
    items: CodeItem[];
    permissions: CodePermissionRequest[];
    cursor: number;
    hydrated: boolean;
    hydrating: boolean;
    synced: boolean;
    needsSnapshot: boolean;
    buffered: CodeWireEvent[];
    hasOlder: boolean;
    beforeSequence: number | null;
    error: string | null;
}
export type CodeSessionAction =
    | { type: 'snapshot-start' }
    | { type: 'snapshot'; snapshot: CodeSnapshot }
    | { type: 'event'; event: CodeWireEvent }
    | { type: 'page'; page: CodeEventsPage }
    | { type: 'history'; page: CodeHistoryPage }
    | { type: 'stale' }
    | { type: 'error'; error: string };

export function emptyCodeSession(sessionId: string): CodeSessionState {
    return { sessionId, session: null, items: [], permissions: [], cursor: 0, hydrated: false,
        hydrating: false, synced: false, needsSnapshot: false, buffered: [], hasOlder: false,
        beforeSequence: null, error: null };
}
export function codeSessionBusy(session: CodeSessionInfo | null): boolean {
    return !!session && ['starting', 'streaming', 'stopping'].includes(session.status);
}
const order = (items: CodeItem[]) => items.sort((a, b) => (a.firstSequence ?? 0) - (b.firstSequence ?? 0));
const itemChars = (items: CodeItem[]) => items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);

function bounded(state: CodeSessionState): CodeSessionState {
    let items = state.items;
    let chars = itemChars(items);
    if (items.length <= MAX_ITEMS && chars <= MAX_ITEM_CHARS) return state;
    items = [...items];
    while (items.length > MAX_ITEMS || chars > MAX_ITEM_CHARS) {
        const index = items.findIndex(item => !state.session?.turnId || item.turnId !== state.session.turnId);
        if (index < 0) return { ...state, items: [], synced: false, needsSnapshot: true, error: 'Conversation exceeds the display capacity.' };
        chars -= JSON.stringify(items[index]).length;
        items.splice(index, 1);
    }
    return { ...state, items, hasOlder: true, beforeSequence: items[0]?.firstSequence ?? null };
}

function apply(state: CodeSessionState, event: CodeWireEvent): CodeSessionState {
    let { items, session, permissions } = state;
    if (event.event === 'code_session') {
        if (!event.session || event.session.sessionId !== state.sessionId) return { ...state, needsSnapshot: true, synced: false };
        // A rollback removed items this state still holds; only a new snapshot drops them.
        if ((event.session.historyGeneration ?? 0) > (state.session?.historyGeneration ?? 0)) return { ...state, needsSnapshot: true, synced: false };
        // Usage is attached at read time, so a stored session event does not
        // carry it. Replacing the record wholesale would blank the meter on
        // every unrelated session change; the last figure stands until a
        // snapshot or a listing supplies a newer one.
        session = event.session.contextUsage === undefined && session?.contextUsage !== undefined
            ? { ...event.session, contextUsage: session.contextUsage }
            : event.session;
        permissions = permissions.filter(p => p.epoch === session!.epoch && p.turnId === session!.turnId);
    } else {
        const id = event.item?.itemId ?? event.update?.itemId;
        const previous = items.find(item => item.itemId === id);
        let item: CodeItem;
        if (event.event === 'code_item' && event.item) {
            item = { ...event.item, firstSequence: previous?.firstSequence ?? event.item.firstSequence ?? event.sequence };
        } else if (event.event === 'code_item_update' && event.update && previous
            && previous.turnId === event.update.turnId) {
            const update = event.update;
            if (update.appendToolOutput !== undefined && !previous.tool) return { ...state, needsSnapshot: true, synced: false };
            item = { ...previous, updatedAt: update.updatedAt,
                ...(update.appendText === undefined ? {} : { text: (previous.text ?? '') + update.appendText }),
                ...(update.appendToolOutput === undefined ? {} : { tool: { ...previous.tool!, output: (previous.tool!.output ?? '') + update.appendToolOutput } }),
                ...(update.status === undefined ? {} : { status: update.status }),
                ...(update.phase === undefined ? {} : { phase: update.phase }),
            };
        } else return { ...state, needsSnapshot: true, synced: false };
        items = order([...items.filter(row => row.itemId !== item.itemId), item]);
        if (item.permission) {
            permissions = permissions.filter(p => p.permissionId !== item.permission!.permissionId);
            if (item.status === 'pending' && item.permission.epoch === session?.epoch && item.permission.turnId === session?.turnId) {
                permissions = [...permissions, item.permission];
            }
        }
    }
    return bounded({ ...state, items, session, permissions, cursor: event.sequence });
}

function drain(state: CodeSessionState): CodeSessionState {
    let next = state;
    if (!next.hydrated || next.hydrating || next.needsSnapshot) return next;
    const pending = next.buffered.filter(event => event.sequence > next.cursor);
    while (pending[0]?.sequence === next.cursor + 1) {
        const event = pending[0];
        next = apply(next, event);
        if (next.needsSnapshot) break;
        pending.shift();
    }
    return { ...next, buffered: pending, synced: next.synced && !pending.length && !next.needsSnapshot };
}

function enqueue(state: CodeSessionState, event: CodeWireEvent): CodeSessionState {
    if (event.sessionId !== state.sessionId || event.sequence <= state.cursor
        || state.buffered.some(row => row.sequence === event.sequence)) return state;
    const buffered = [...state.buffered, event].sort((a, b) => a.sequence - b.sequence);
    if (buffered.length > MAX_BUFFER_EVENTS || JSON.stringify(buffered).length > MAX_BUFFER_CHARS) {
        return { ...state, buffered: [], synced: false, needsSnapshot: true, error: 'Live updates exceeded the buffer. Refreshing history.' };
    }
    return drain({ ...state, buffered });
}

/** Snapshot, HTTP catch-up and SSE share the exact same sequence application. */
export function reduceCodeSession(state: CodeSessionState, action: CodeSessionAction): CodeSessionState {
    switch (action.type) {
        case 'stale': return { ...state, synced: false };
        case 'error': return { ...state, hydrating: false, synced: false, error: action.error };
        case 'snapshot-start': return { ...state, hydrating: true, synced: false, error: null };
        case 'event': return enqueue(state, action.event);
        case 'snapshot': {
            const snapshot = action.snapshot;
            if (snapshot.session.sessionId !== state.sessionId || snapshot.sequence < state.cursor) {
                return { ...state, hydrating: false, synced: false, needsSnapshot: true };
            }
            const items = order([...snapshot.items]);
            return drain(bounded({ ...state, session: snapshot.session, items, permissions: snapshot.pendingPermissions,
                cursor: snapshot.sequence, hydrated: true, hydrating: false, synced: true, needsSnapshot: false,
                hasOlder: snapshot.truncated, beforeSequence: items[0]?.firstSequence ?? null, error: null }));
        }
        case 'page': {
            let next = state;
            for (const event of action.page.events) next = enqueue(next, event);
            const complete = next.cursor >= action.page.throughSequence && !next.buffered.length && !next.needsSnapshot;
            return { ...next, synced: complete, error: complete ? null : next.error };
        }
        case 'history': {
            const known = new Set(state.items.map(item => item.itemId));
            const items = order([...state.items, ...action.page.items.filter(item => !known.has(item.itemId))]);
            if (items.length > MAX_ITEMS || itemChars(items) > MAX_ITEM_CHARS) {
                return { ...state, error: 'Older history exceeds the display capacity. Reload to return to recent items.' };
            }
            return { ...state, items, hasOlder: action.page.hasMore, beforeSequence: action.page.beforeSequence };
        }
    }
}
