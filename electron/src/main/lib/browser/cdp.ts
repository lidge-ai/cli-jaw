import type { WebContents } from 'electron';

/**
 * Embedded-browser CDP adapter (030 v4/v5).
 *
 * Uses `webContents.debugger` with ONLY the DOM / Overlay / Input /
 * Accessibility domains. The Runtime domain (arbitrary page-side script
 * evaluation) is never enabled or called — 030 forbids injecting or running
 * page scripts, and every capability here is
 * achievable through native Chromium protocol domains:
 *
 *   - v5 element inspect: `Overlay.setInspectMode` makes Chromium paint the
 *     hover box the user expects; `Overlay.inspectNodeRequested` + DOM domain
 *     resolves the picked node's selector/role/bounds/text.
 *   - v5 DOM/AX snapshot: bounded `DOM.getDocument` + `Accessibility` tree.
 *   - v4 actions: `Input.dispatchMouseEvent` / `Input.insertText` /
 *     `Input.dispatchKeyEvent` for click/type/scroll at coordinates or at a
 *     resolved element's center.
 */

const CDP_VERSION = '1.3';
const MAX_NODE_TEXT = 200;
const HIGHLIGHT_CONFIG = {
    showInfo: true,
    contentColor: { r: 111, g: 168, b: 220, a: 0.4 },
    paddingColor: { r: 147, g: 196, b: 125, a: 0.35 },
    borderColor: { r: 111, g: 168, b: 220, a: 0.85 },
    marginColor: { r: 246, g: 178, b: 107, a: 0.3 },
};

export type PickedElement = {
    selector: string;
    tagName: string;
    role: string | null;
    name: string | null;
    text: string | null;
    /** Viewport-relative CSS px (DOM.getBoxModel document bounds minus the visual viewport offset). */
    bounds: { x: number; y: number; width: number; height: number } | null;
};

export type DomSnapshotNode = {
    tag: string;
    role: string | null;
    name: string | null;
    text: string | null;
    selector: string;
    bounds: { x: number; y: number; width: number; height: number } | null;
};

type CdpSession = {
    contents: WebContents;
    inspecting: boolean;
    /** Whether THIS adapter attached the debugger (vs. an external owner like DevTools). */
    attachedByAdapter: boolean;
    onPicked: ((element: PickedElement) => void) | null;
    messageHandler: (event: unknown, method: string, params: unknown) => void;
    detachHandler: () => void;
};

const sessions = new Map<number, CdpSession>();
// Concurrent ensureSession calls must share ONE init; otherwise each call
// attaches its own message listener and the map keeps only the last session.
const sessionInit = new Map<number, Promise<CdpSession>>();

function send<T = unknown>(contents: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    return contents.debugger.sendCommand(method, params ?? {}) as Promise<T>;
}

function ensureSession(contents: WebContents): Promise<CdpSession> {
    const existing = sessions.get(contents.id);
    if (existing) return Promise.resolve(existing);
    const pending = sessionInit.get(contents.id);
    if (pending) return pending;
    const init = createSession(contents).finally(() => sessionInit.delete(contents.id));
    sessionInit.set(contents.id, init);
    return init;
}

async function createSession(contents: WebContents): Promise<CdpSession> {
    let attachedByAdapter = false;
    if (!contents.debugger.isAttached()) {
        contents.debugger.attach(CDP_VERSION);
        attachedByAdapter = true;
    }
    await send(contents, 'DOM.enable');
    await send(contents, 'Overlay.enable');

    const session: CdpSession = {
        contents,
        inspecting: false,
        attachedByAdapter,
        onPicked: null,
        messageHandler: () => undefined,
        detachHandler: () => undefined,
    };

    session.messageHandler = (_event, method, params) => {
        // Ignore events once this session has been superseded or removed.
        if (sessions.get(contents.id) !== session) return;
        if (method === 'Overlay.inspectNodeRequested') {
            const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
            if (typeof backendNodeId === 'number' && session.onPicked) {
                void resolvePickedElement(contents, backendNodeId).then(element => {
                    if (element && session.onPicked) session.onPicked(element);
                }).catch(() => undefined).finally(() => {
                    // Inspect is one-shot: turn the overlay off after a pick.
                    void stopInspect(contents).catch(() => undefined);
                });
            }
        }
    };
    session.detachHandler = () => {
        if (sessions.get(contents.id) === session) sessions.delete(contents.id);
    };
    contents.debugger.on('message', session.messageHandler);
    contents.debugger.once('detach', session.detachHandler);
    contents.once('destroyed', () => detachCdp(contents));
    sessions.set(contents.id, session);
    return session;
}

export function detachCdp(contents: WebContents): void {
    const session = sessions.get(contents.id);
    if (!session) return;
    try { contents.debugger.removeListener('message', session.messageHandler); } catch { /* ignore */ }
    // Only detach a debugger this adapter attached — an external owner
    // (e.g. DevTools tooling) keeps its own session.
    try { if (session.attachedByAdapter && contents.debugger.isAttached()) contents.debugger.detach(); } catch { /* ignore */ }
    sessions.delete(contents.id);
}

// --- selector / metadata resolution (DOM domain only) ---

type DomDescribeNode = { nodeName?: string; attributes?: string[]; nodeValue?: string };

function selectorFromDescribedNode(node: DomDescribeNode | null | undefined): string {
    const tag = (node?.nodeName ?? 'node').toLowerCase();
    const attrs = node?.attributes ?? [];
    for (let i = 0; i < attrs.length - 1; i += 2) {
        if (attrs[i] === 'id' && attrs[i + 1]) return `${tag}#${cssEscape(attrs[i + 1]!)}`;
    }
    for (let i = 0; i < attrs.length - 1; i += 2) {
        if (attrs[i] === 'class' && attrs[i + 1]) {
            const cls = attrs[i + 1]!.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(cssEscape).join('.');
            if (cls) return `${tag}.${cls}`;
        }
    }
    return tag;
}

async function nodeSelector(contents: WebContents, nodeId: number): Promise<string> {
    try {
        const { node } = await send<{ node: DomDescribeNode }>(contents, 'DOM.describeNode', { nodeId });
        return selectorFromDescribedNode(node);
    } catch {
        return 'node';
    }
}

function cssEscape(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

async function nodeBounds(contents: WebContents, nodeId: number): Promise<PickedElement['bounds']> {
    try {
        const { model } = await send<{ model: { content: number[]; width: number; height: number } }>(contents, 'DOM.getBoxModel', { nodeId });
        const c = model.content;
        return { x: Math.round(c[0] ?? 0), y: Math.round(c[1] ?? 0), width: Math.round(model.width), height: Math.round(model.height) };
    } catch {
        return null;
    }
}

async function backendNodeBounds(contents: WebContents, backendNodeId: number): Promise<PickedElement['bounds']> {
    try {
        const { model } = await send<{ model: { content: number[]; width: number; height: number } }>(contents, 'DOM.getBoxModel', { backendNodeId });
        const c = model.content;
        return { x: Math.round(c[0] ?? 0), y: Math.round(c[1] ?? 0), width: Math.round(model.width), height: Math.round(model.height) };
    } catch {
        return null;
    }
}

function trimNodeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_TEXT);
    return text || null;
}

async function nodeAxInfo(contents: WebContents, backendNodeId: number): Promise<{ role: string | null; name: string | null }> {
    try {
        const { nodes } = await send<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> }>(contents, 'Accessibility.getAXNodeAndAncestors', { backendNodeId });
        const first = nodes?.[0];
        return { role: first?.role?.value ?? null, name: first?.name?.value ?? null };
    } catch {
        return { role: null, name: null };
    }
}

/**
 * Scroll position of the visual viewport inside the document, in CSS px.
 * DOM.getBoxModel returns document-space bounds; subtracting this offset
 * yields viewport-relative coordinates for overlays and input dispatch.
 */
async function visualViewportPageOffset(contents: WebContents): Promise<{ x: number; y: number }> {
    try {
        const metrics = await send<{
            cssVisualViewport?: { pageX?: number; pageY?: number };
            layoutViewport?: { pageX?: number; pageY?: number };
            visualViewport?: { pageX?: number; pageY?: number };
        }>(contents, 'Page.getLayoutMetrics');
        return {
            x: metrics.cssVisualViewport?.pageX ?? metrics.layoutViewport?.pageX ?? metrics.visualViewport?.pageX ?? 0,
            y: metrics.cssVisualViewport?.pageY ?? metrics.layoutViewport?.pageY ?? metrics.visualViewport?.pageY ?? 0,
        };
    } catch {
        return { x: 0, y: 0 };
    }
}

async function resolvePickedElement(contents: WebContents, backendNodeId: number): Promise<PickedElement | null> {
    try {
        await send(contents, 'Accessibility.enable').catch(() => undefined);
        const { node } = await send<{ node: DomDescribeNode }>(contents, 'DOM.describeNode', { backendNodeId, depth: 0 });
        const [bounds, ax, viewportOffset] = await Promise.all([
            backendNodeBounds(contents, backendNodeId),
            nodeAxInfo(contents, backendNodeId),
            visualViewportPageOffset(contents),
        ]);
        // Text comes ONLY from the accessibility name. Raw outerHTML stripping
        // could leak hidden attributes / input values / script text from a
        // logged-in page into agent-facing surfaces.
        return {
            selector: selectorFromDescribedNode(node),
            tagName: (node.nodeName ?? 'NODE').toLowerCase(),
            role: ax.role,
            name: trimNodeText(ax.name),
            text: trimNodeText(ax.name),
            bounds: bounds
                ? {
                    x: bounds.x - Math.round(viewportOffset.x),
                    y: bounds.y - Math.round(viewportOffset.y),
                    width: bounds.width,
                    height: bounds.height,
                }
                : null,
        };
    } catch {
        return null;
    }
}

async function frontendNodeIdFromBackend(contents: WebContents, backendNodeId: number): Promise<number | null> {
    try {
        const { nodeIds } = await send<{ nodeIds: number[] }>(contents, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
        const nodeId = nodeIds?.[0];
        return typeof nodeId === 'number' ? nodeId : null;
    } catch {
        return null;
    }
}

// --- v5 inspect mode ---

export async function startInspect(contents: WebContents, onPicked: (element: PickedElement) => void): Promise<void> {
    const session = await ensureSession(contents);
    session.onPicked = onPicked;
    session.inspecting = true;
    await send(contents, 'Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: HIGHLIGHT_CONFIG,
    });
}

export async function stopInspect(contents: WebContents): Promise<void> {
    const session = sessions.get(contents.id);
    if (!session) return;
    session.inspecting = false;
    session.onPicked = null;
    try { await send(contents, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG }); } catch { /* ignore */ }
}

export function isInspecting(contents: WebContents): boolean {
    return sessions.get(contents.id)?.inspecting === true;
}

// --- v5 DOM/AX snapshot (bounded, no script execution) ---

export async function domSnapshot(contents: WebContents, maxNodes = 120): Promise<DomSnapshotNode[]> {
    await ensureSession(contents);
    await send(contents, 'DOM.getDocument', { depth: 1, pierce: false }).catch(() => undefined);
    await send(contents, 'Accessibility.enable').catch(() => undefined);
    const { nodes } = await send<{ nodes: Array<{ nodeId?: number; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; ignored?: boolean }> }>(
        contents,
        'Accessibility.getFullAXTree',
        // Chromium's current param name is `depth` (`max_depth` is the
        // pre-Chrome-96 spelling and is ignored by modern builds).
        { depth: 12 },
    );
    const out: DomSnapshotNode[] = [];
    for (const node of nodes) {
        if (node.ignored || !node.role?.value) continue;
        if (out.length >= maxNodes) break;
        const role = node.role.value;
        if (role === 'none' || role === 'generic' || role === 'InlineTextBox') continue;
        const name = trimNodeText(node.name?.value);
        let selector = '';
        let bounds: DomSnapshotNode['bounds'] = null;
        const nodeId = typeof node.nodeId === 'number'
            ? node.nodeId
            : typeof node.backendDOMNodeId === 'number'
                ? await frontendNodeIdFromBackend(contents, node.backendDOMNodeId)
                : null;
        if (nodeId !== null) {
            selector = await nodeSelector(contents, nodeId).catch(() => '');
            bounds = await nodeBounds(contents, nodeId).catch(() => null);
        }
        out.push({
            tag: role,
            role,
            name,
            text: name,
            selector,
            bounds,
        });
    }
    return out;
}

// --- fit-to-width: read-only layout metrics probe ---

export type PageLayoutMetrics = {
    /** cssLayoutViewport.clientWidth — viewport width in CSS px at current zoom. */
    viewportCssWidth: number;
    /** cssContentSize.width — full document scroll width in CSS px. */
    contentCssWidth: number;
};

/**
 * One-off `Page.getLayoutMetrics` read for fit-to-width zoom. Like
 * `assertPointInViewport` this never enables the Page domain — it is a single
 * read-only command, no subscription, no script execution.
 *
 * When an adapter session already owns the debugger (inspect/act/snapshot in
 * use), the probe rides that session. Otherwise it attaches transiently and
 * detaches afterwards so idle tabs never keep a debugger attached.
 */
export async function pageLayoutMetrics(contents: WebContents): Promise<PageLayoutMetrics | null> {
    const read = async (): Promise<PageLayoutMetrics | null> => {
        const metrics = await send<{
            cssLayoutViewport?: { clientWidth?: number };
            layoutViewport?: { clientWidth?: number };
            cssVisualViewport?: { clientWidth?: number };
            cssContentSize?: { width?: number };
            contentSize?: { width?: number };
        }>(contents, 'Page.getLayoutMetrics');
        const viewportCssWidth = metrics.cssLayoutViewport?.clientWidth
            ?? metrics.layoutViewport?.clientWidth
            ?? metrics.cssVisualViewport?.clientWidth;
        const contentCssWidth = metrics.cssContentSize?.width ?? metrics.contentSize?.width;
        if (typeof viewportCssWidth !== 'number' || typeof contentCssWidth !== 'number') return null;
        if (viewportCssWidth <= 0 || contentCssWidth <= 0) return null;
        return { viewportCssWidth, contentCssWidth };
    };

    if (sessions.get(contents.id) || sessionInit.get(contents.id)) {
        try {
            await ensureSession(contents);
            return await read();
        } catch {
            return null;
        }
    }

    let attached = false;
    try {
        contents.debugger.attach(CDP_VERSION);
        attached = true;
        return await read();
    } catch {
        return null;
    } finally {
        // Leave the debugger attached if an adapter session started using it
        // while the probe ran — its lifecycle now owns the attachment.
        if (attached && !sessions.has(contents.id) && contents.debugger.isAttached()) {
            try { contents.debugger.detach(); } catch { /* ignore */ }
        }
    }
}

// --- v4 interactive actions (Input domain) ---

export type ActPayload =
    | { kind: 'click'; x: number; y: number }
    | { kind: 'type'; text: string }
    | { kind: 'scroll'; x: number; y: number; deltaY: number }
    | { kind: 'key'; key: string };

/**
 * Visible viewport size via the read-only `Page.getLayoutMetrics` call
 * (no `Page.enable`, no events — the Page domain is never subscribed).
 */
async function assertPointInViewport(contents: WebContents, x: number, y: number): Promise<void> {
    const metrics = await send<{
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
        visualViewport?: { clientWidth?: number; clientHeight?: number };
        layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(contents, 'Page.getLayoutMetrics');
    const width = metrics.cssVisualViewport?.clientWidth ?? metrics.visualViewport?.clientWidth ?? metrics.layoutViewport?.clientWidth;
    const height = metrics.cssVisualViewport?.clientHeight ?? metrics.visualViewport?.clientHeight ?? metrics.layoutViewport?.clientHeight;
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
        throw new Error('viewport metrics unavailable');
    }
    if (x < 0 || y < 0 || x > Math.floor(width) || y > Math.floor(height)) {
        throw new Error('act coordinates are outside the page viewport');
    }
}

export async function performAct(contents: WebContents, act: ActPayload): Promise<void> {
    await ensureSession(contents);
    if (act.kind === 'click' || act.kind === 'scroll') {
        await assertPointInViewport(contents, act.x, act.y);
    }
    switch (act.kind) {
        case 'click': {
            const base = { x: act.x, y: act.y, button: 'left' as const, clickCount: 1 };
            await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
            await send(contents, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
            await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
            break;
        }
        case 'type':
            await send(contents, 'Input.insertText', { text: act.text });
            break;
        case 'key':
            await send(contents, 'Input.dispatchKeyEvent', { type: 'keyDown', key: act.key });
            await send(contents, 'Input.dispatchKeyEvent', { type: 'keyUp', key: act.key });
            break;
        case 'scroll':
            await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: act.x, y: act.y, deltaX: 0, deltaY: act.deltaY });
            break;
    }
}
