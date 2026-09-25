import { ipcMain, webContents as webContentsRegistry, type BrowserWindow, type WebContents } from 'electron';
import { isAllowedSender } from '../ipc-origin-guard.js';
import { detachCdp, domSnapshot, isInspecting, pageLayoutMetrics, performAct, startInspect, stopInspect, type ActPayload, type PickedElement } from './cdp.js';
import { computeFitZoom, FIT_ZOOM_EPSILON } from './fit-zoom.js';

/**
 * Embedded browser webview IPC (030 v1).
 *
 * The renderer registers a BrowserPanel webview by { tabId, webContentsId }.
 * Only guest webContents that the MAIN process observed being created
 * (markOwnedEmbeddedBrowserWebContents) are accepted, and every native action
 * re-validates that the target is a live guest of type 'webview' — never the
 * Manager window itself. No script-execution bridge is exposed here.
 */

export type BrowserIpcOptions = {
    getManagerWindow: () => BrowserWindow | null;
    normalizeEmbeddedBrowserUrl: (url: string) => string | null;
    isAllowedEmbeddedBrowserUrl: (url: string) => boolean;
    openExternalNavigation: (url: string) => boolean;
};

type RegisteredBrowserTab = {
    tabId: string;
    webContentsId: number;
    sharedWithAgent: boolean;
    /** Compatibility state: Manager Browser targets allow actions by default. */
    actionsEnabled: boolean;
    favicons: string[];
    /**
     * 'auto': fit-to-width may manage zoomFactor (pages wider than the panel
     * get shrunk to fit). 'manual': the user's zoom menu choice wins until
     * zoomReset returns the tab to 'auto'.
     */
    zoomMode: 'auto' | 'manual';
    /** CSS px content width that overflowed this document; resize refit basis. */
    fitRequiredWidth: number | null;
};

const ownedWebContentsIds = new Set<number>();
const devToolsListenerIds = new Set<number>();
const faviconListenerIds = new Set<number>();
const fitToWidthListenerIds = new Set<number>();
const fitToWidthTimers = new Map<number, ReturnType<typeof setTimeout>>();
const tabsById = new Map<string, RegisteredBrowserTab>();
const FIT_TO_WIDTH_DEBOUNCE_MS = 200;
const MAX_ACT_COORD = 100_000;
const MAX_ACT_TEXT = 2_000;
const MAX_SCROLL_DELTA = 5_000;
const ALLOWED_KEY_VALUES = new Set([
    'Enter',
    'Tab',
    'Escape',
    'Backspace',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
]);

export function markOwnedEmbeddedBrowserWebContents(contents: WebContents): void {
    ownedWebContentsIds.add(contents.id);
    contents.once('destroyed', () => {
        ownedWebContentsIds.delete(contents.id);
        devToolsListenerIds.delete(contents.id);
        faviconListenerIds.delete(contents.id);
        fitToWidthListenerIds.delete(contents.id);
        const pendingFit = fitToWidthTimers.get(contents.id);
        if (pendingFit) {
            clearTimeout(pendingFit);
            fitToWidthTimers.delete(contents.id);
        }
        detachCdp(contents);
        for (const [tabId, entry] of tabsById) {
            if (entry.webContentsId === contents.id) tabsById.delete(tabId);
        }
    });
}

function resolveOwnedGuest(webContentsId: number): WebContents | null {
    if (!Number.isInteger(webContentsId) || !ownedWebContentsIds.has(webContentsId)) return null;
    const contents = webContentsRegistry.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) return null;
    if (contents.getType() !== 'webview') return null;
    return contents;
}

function resolveRegisteredGuest(tabId: string): { entry: RegisteredBrowserTab; contents: WebContents } | null {
    const entry = typeof tabId === 'string' ? tabsById.get(tabId) : undefined;
    if (!entry) return null;
    const contents = resolveOwnedGuest(entry.webContentsId);
    if (!contents) {
        tabsById.delete(entry.tabId);
        return null;
    }
    return { entry, contents };
}

function devToolsTargetId(contents: WebContents): string | undefined {
    const candidate = (contents as WebContents & { getOrCreateDevToolsTargetId?: () => string }).getOrCreateDevToolsTargetId;
    if (typeof candidate !== 'function') return undefined;
    try {
        return candidate.call(contents);
    } catch {
        return undefined;
    }
}

function ownKeys(input: Record<string, unknown>): string[] {
    return Object.keys(input).sort();
}

function keysEqual(input: Record<string, unknown>, expected: string[]): boolean {
    const keys = ownKeys(input);
    const want = [...expected].sort();
    return keys.length === want.length && keys.every((key, index) => key === want[index]);
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < min || value > max) return null;
    return Math.round(value);
}

function parseActPayload(input: unknown): { ok: true; act: ActPayload } | { ok: false; error: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'act payload must be an object' };
    const value = input as Record<string, unknown>;
    switch (value.kind) {
        case 'click': {
            if (!keysEqual(value, ['kind', 'x', 'y'])) return { ok: false, error: 'click act accepts only kind, x, y' };
            const x = boundedNumber(value.x, 0, MAX_ACT_COORD);
            const y = boundedNumber(value.y, 0, MAX_ACT_COORD);
            if (x === null || y === null) return { ok: false, error: 'click coordinates out of bounds' };
            return { ok: true, act: { kind: 'click', x, y } };
        }
        case 'type': {
            if (!keysEqual(value, ['kind', 'text'])) return { ok: false, error: 'type act accepts only kind, text' };
            const text = typeof value.text === 'string' ? value.text : '';
            if (!text || text.length > MAX_ACT_TEXT) return { ok: false, error: 'type text length out of bounds' };
            return { ok: true, act: { kind: 'type', text } };
        }
        case 'scroll': {
            if (!keysEqual(value, ['deltaY', 'kind', 'x', 'y'])) return { ok: false, error: 'scroll act accepts only kind, x, y, deltaY' };
            const x = boundedNumber(value.x, 0, MAX_ACT_COORD);
            const y = boundedNumber(value.y, 0, MAX_ACT_COORD);
            const deltaY = boundedNumber(value.deltaY, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
            if (x === null || y === null || deltaY === null || deltaY === 0) return { ok: false, error: 'scroll payload out of bounds' };
            return { ok: true, act: { kind: 'scroll', x, y, deltaY } };
        }
        case 'key': {
            if (!keysEqual(value, ['key', 'kind'])) return { ok: false, error: 'key act accepts only kind, key' };
            const key = typeof value.key === 'string' ? value.key : '';
            if (!ALLOWED_KEY_VALUES.has(key) && !/^[ -~]$/.test(key)) return { ok: false, error: 'key value not allowed' };
            return { ok: true, act: { kind: 'key', key } };
        }
        default:
            return { ok: false, error: 'unknown act kind' };
    }
}

async function ensureDevToolsOpen(contents: WebContents, preferredMode: 'right' | 'bottom' | 'detach'): Promise<boolean> {
    if (contents.isDevToolsOpened()) return true;
    const waitForOpen = async (timeoutMs = 250): Promise<boolean> => {
        if (contents.isDevToolsOpened()) return true;
        return await new Promise<boolean>(resolve => {
            let settled = false;
            const finish = (opened: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                contents.removeListener('devtools-opened', onOpened);
                resolve(opened || contents.isDevToolsOpened());
            };
            const onOpened = () => finish(true);
            const timeout = setTimeout(() => finish(false), timeoutMs);
            contents.once('devtools-opened', onOpened);
        });
    };
    contents.openDevTools({ mode: preferredMode, activate: true });
    if (await waitForOpen()) return true;
    if (preferredMode !== 'detach' && !contents.isDevToolsOpened()) {
        contents.openDevTools({ mode: 'detach', activate: true });
        if (await waitForOpen()) return true;
    }
    return contents.isDevToolsOpened();
}

function clampZoom(n: number): number {
    return Math.min(3, Math.max(0.5, Math.round(n * 10) / 10));
}

function tabState(entry: RegisteredBrowserTab, contents: WebContents) {
    const targetId = devToolsTargetId(contents);
    return {
        tabId: entry.tabId,
        webContentsId: entry.webContentsId,
        url: contents.getURL(),
        title: contents.getTitle(),
        favicons: entry.favicons,
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory?.canGoBack?.() ?? false,
        canGoForward: contents.navigationHistory?.canGoForward?.() ?? false,
        devToolsOpen: contents.isDevToolsOpened(),
        ...(targetId ? { devToolsTargetId: targetId } : {}),
        sharedWithAgent: entry.sharedWithAgent,
        actionsEnabled: entry.actionsEnabled,
        inspecting: isInspecting(contents),
        zoomFactor: contents.getZoomFactor(),
        zoomMode: entry.zoomMode,
    };
}

export function registerBrowserIpc(options: BrowserIpcOptions): void {
    /**
     * Origin alone is not enough: other same-origin Electron surfaces (e.g.
     * the tray reminders popover) share the manager origin and preload. Only
     * the Manager window's own webContents may drive embedded-browser IPC.
     */
    function isManagerSender(event: Parameters<Parameters<typeof ipcMain.handle>[1]>[0]): boolean {
        if (!isAllowedSender(event)) return false;
        const win = options.getManagerWindow();
        return !!win && !win.isDestroyed() && event.sender.id === win.webContents.id;
    }

    function emitState(entry: RegisteredBrowserTab, contents: WebContents): void {
        const win = options.getManagerWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('browser:webview-state', tabState(entry, contents));
    }

    function attachDevToolsListeners(entry: RegisteredBrowserTab, contents: WebContents): void {
        if (devToolsListenerIds.has(contents.id)) return;
        devToolsListenerIds.add(contents.id);
        const emit = () => {
            const live = resolveRegisteredGuest(entry.tabId);
            if (live && live.entry.webContentsId === contents.id) emitState(live.entry, live.contents);
        };
        contents.on('devtools-opened', emit);
        contents.on('devtools-closed', emit);
    }

    function attachFaviconListener(entry: RegisteredBrowserTab, contents: WebContents): void {
        if (faviconListenerIds.has(contents.id)) return;
        faviconListenerIds.add(contents.id);
        contents.on('page-favicon-updated', (_event, favicons: string[]) => {
            const live = tabsById.get(entry.tabId);
            if (!live || live.webContentsId !== contents.id) return;
            live.favicons = Array.isArray(favicons)
                ? favicons.filter(item => typeof item === 'string').slice(0, 8)
                : [];
            emitState(live, contents);
        });
    }

    /**
     * Fit-to-width: measure the guest document via a read-only
     * Page.getLayoutMetrics probe and shrink zoomFactor until the content
     * width fits the panel. Skipped entirely once the user picks a zoom level
     * from the zoom menu (zoomMode 'manual'); zoomReset re-arms auto fitting.
     */
    async function applyFitToWidth(entry: RegisteredBrowserTab, contents: WebContents): Promise<void> {
        if (entry.zoomMode !== 'auto' || contents.isDestroyed()) return;
        const metrics = await pageLayoutMetrics(contents);
        if (!metrics || contents.isDestroyed()) return;
        const decision = computeFitZoom({
            viewportCssWidth: metrics.viewportCssWidth,
            contentCssWidth: metrics.contentCssWidth,
            currentZoom: contents.getZoomFactor(),
            requiredWidth: entry.fitRequiredWidth,
        });
        entry.fitRequiredWidth = decision.requiredWidth;
        if (Math.abs(decision.zoom - contents.getZoomFactor()) > FIT_ZOOM_EPSILON) {
            contents.setZoomFactor(decision.zoom);
            emitState(entry, contents);
        }
    }

    function scheduleFitMeasure(tabId: string, contents: WebContents): void {
        const pending = fitToWidthTimers.get(contents.id);
        if (pending) clearTimeout(pending);
        fitToWidthTimers.set(contents.id, setTimeout(() => {
            fitToWidthTimers.delete(contents.id);
            const resolved = resolveRegisteredGuest(tabId);
            if (!resolved || resolved.contents !== contents) return;
            void applyFitToWidth(resolved.entry, resolved.contents);
        }, FIT_TO_WIDTH_DEBOUNCE_MS));
    }

    function attachFitToWidthListeners(entry: RegisteredBrowserTab, contents: WebContents): void {
        if (fitToWidthListenerIds.has(contents.id)) return;
        fitToWidthListenerIds.add(contents.id);
        contents.on('did-navigate', () => {
            const live = tabsById.get(entry.tabId);
            if (!live || live.webContentsId !== contents.id) return;
            live.fitRequiredWidth = null;
            // A new document gets an un-zoomed layout pass; did-finish-load
            // re-fits it if its content still overflows the panel.
            if (live.zoomMode === 'auto' && contents.getZoomFactor() !== 1) {
                contents.setZoomFactor(1);
                emitState(live, contents);
            }
        });
        const refit = () => scheduleFitMeasure(entry.tabId, contents);
        contents.on('did-finish-load', refit);
        contents.on('did-stop-loading', refit);
    }

    ipcMain.handle('browser:register-webview', (event, input: { tabId?: unknown; webContentsId?: unknown }) => {
        if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
        const tabId = typeof input?.tabId === 'string' ? input.tabId.trim() : '';
        const webContentsId = typeof input?.webContentsId === 'number' ? input.webContentsId : NaN;
        if (!tabId) return { ok: false, error: 'tabId required' };
        const contents = resolveOwnedGuest(webContentsId);
        if (!contents) return { ok: false, error: 'not an owned embedded webview' };
        const prior = tabsById.get(tabId);
        const entry: RegisteredBrowserTab = {
            tabId,
            webContentsId,
            // Browser tabs are agent-visible and action-enabled by default.
            sharedWithAgent: prior?.sharedWithAgent ?? true,
            actionsEnabled: true,
            favicons: prior?.webContentsId === webContentsId ? prior.favicons : [],
            zoomMode: prior?.zoomMode ?? 'auto',
            fitRequiredWidth: prior?.webContentsId === webContentsId ? prior.fitRequiredWidth : null,
        };
        tabsById.set(tabId, entry);
        attachDevToolsListeners(entry, contents);
        attachFaviconListener(entry, contents);
        attachFitToWidthListeners(entry, contents);
        return { ok: true, state: tabState(entry, contents) };
    });

    ipcMain.handle('browser:unregister-webview', (event, input: { tabId?: unknown; webContentsId?: unknown }) => {
        if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
        const tabId = typeof input?.tabId === 'string' ? input.tabId : '';
        if (!tabId) return { ok: false, error: 'tabId required' };
        // A stale unmount must not delete a FRESH registration that reused the
        // same logical tab id: when the caller names a webContentsId, only a
        // matching entry is removed.
        const entry = tabsById.get(tabId);
        if (entry && typeof input?.webContentsId === 'number' && entry.webContentsId !== input.webContentsId) {
            return { ok: true, stale: true };
        }
        tabsById.delete(tabId);
        return { ok: true };
    });

    ipcMain.handle('browser:control-webview', async (event, command: { kind?: unknown; tabId?: unknown; url?: unknown; ignoreCache?: unknown }) => {
        if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
        const resolved = resolveRegisteredGuest(typeof command?.tabId === 'string' ? command.tabId : '');
        if (!resolved) return { ok: false, error: 'unknown or stale browser tab' };
        const { entry, contents } = resolved;
        switch (command?.kind) {
            case 'navigate': {
                const normalized = typeof command.url === 'string' ? options.normalizeEmbeddedBrowserUrl(command.url) : null;
                if (!normalized || !options.isAllowedEmbeddedBrowserUrl(normalized)) {
                    return { ok: false, error: 'url not allowed' };
                }
                void contents.loadURL(normalized);
                break;
            }
            case 'reload':
                if (command.ignoreCache === true) contents.reloadIgnoringCache();
                else contents.reload();
                break;
            case 'goBack':
                contents.navigationHistory?.goBack?.();
                break;
            case 'goForward':
                contents.navigationHistory?.goForward?.();
                break;
            case 'stop':
                contents.stop();
                break;
            case 'zoomIn':
                // Explicit zoom wins over auto fit-to-width until Reset.
                entry.zoomMode = 'manual';
                contents.setZoomFactor(clampZoom(contents.getZoomFactor() + 0.1));
                break;
            case 'zoomOut':
                entry.zoomMode = 'manual';
                contents.setZoomFactor(clampZoom(contents.getZoomFactor() - 0.1));
                break;
            case 'zoomReset':
                entry.zoomMode = 'auto';
                await applyFitToWidth(entry, contents);
                break;
            case 'fitToWidth':
                // Panel resize refit: no-op while the tab is in manual zoom.
                await applyFitToWidth(entry, contents);
                break;
            default:
                return { ok: false, error: 'unknown command' };
        }
        return { ok: true, state: tabState(entry, contents) };
    });

    ipcMain.handle('browser:perform-webview-action', async (event, action: { kind?: unknown; tabId?: unknown; mode?: unknown; x?: unknown; y?: unknown; shared?: unknown; enabled?: unknown; act?: unknown }) => {
        if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
        const resolved = resolveRegisteredGuest(typeof action?.tabId === 'string' ? action.tabId : '');
        if (!resolved) return { ok: false, error: 'unknown or stale browser tab' };
        const { entry, contents } = resolved;
        switch (action?.kind) {
            case 'openExternal': {
                const opened = options.openExternalNavigation(contents.getURL());
                if (!opened) return { ok: false, error: 'url not allowed for external open' };
                break;
            }
            case 'openDevTools': {
                const mode = action.mode === 'bottom' || action.mode === 'detach' ? action.mode : 'right';
                const opened = await ensureDevToolsOpen(contents, mode);
                if (!opened) return { ok: false, state: tabState(entry, contents), error: 'DevTools did not open for the embedded browser. Try restarting the desktop app.' };
                break;
            }
            case 'closeDevTools':
                contents.closeDevTools();
                break;
            case 'captureScreenshot': {
                const image = await contents.capturePage();
                const size = image.getSize();
                return {
                    ok: true,
                    state: tabState(entry, contents),
                    screenshot: {
                        tabId: entry.tabId,
                        url: contents.getURL(),
                        title: contents.getTitle(),
                        capturedAt: new Date().toISOString(),
                        width: size.width,
                        height: size.height,
                        dataUrl: image.toDataURL(),
                    },
                };
            }
            case 'inspectElement': {
                const x = typeof action.x === 'number' && Number.isFinite(action.x) ? Math.max(0, Math.round(action.x)) : 0;
                const y = typeof action.y === 'number' && Number.isFinite(action.y) ? Math.max(0, Math.round(action.y)) : 0;
                contents.inspectElement(x, y);
                const opened = await ensureDevToolsOpen(contents, 'right');
                if (!opened) return { ok: false, state: tabState(entry, contents), error: 'Inspect picked a point, but DevTools did not open.' };
                break;
            }
            case 'setSharedWithAgent':
                entry.sharedWithAgent = action.shared === true;
                entry.actionsEnabled = true;
                emitState(entry, contents);
                break;
            case 'setActionsEnabled':
                // Backward-compatible no-op: Manager Browser actions are always
                // allowed for agent-visible targets.
                entry.actionsEnabled = true;
                entry.sharedWithAgent = true;
                emitState(entry, contents);
                break;
            case 'startInspect': {
                // v5 native element inspect: Chromium paints the hover box.
                try {
                    await startInspect(contents, (element: PickedElement) => {
                        const win = options.getManagerWindow();
                        if (win && !win.isDestroyed()) {
                            win.webContents.send('browser:element-picked', { tabId: entry.tabId, element });
                        }
                        emitState(entry, contents);
                    });
                } catch (err) {
                    return { ok: false, state: tabState(entry, contents), error: `inspect unavailable: ${(err as Error).message}` };
                }
                break;
            }
            case 'stopInspect':
                await stopInspect(contents).catch(() => undefined);
                break;
            case 'getDomSnapshot': {
                try {
                    const nodes = await domSnapshot(contents);
                    return { ok: true, state: tabState(entry, contents), snapshot: nodes };
                } catch (err) {
                    return { ok: false, state: tabState(entry, contents), error: `snapshot unavailable: ${(err as Error).message}` };
                }
            }
            case 'act': {
                // v4 interactive action — Manager Browser grants full action
                // capability for agent-visible targets. URL policy and payload
                // validation still apply at execution time.
                if (!entry.sharedWithAgent) {
                    return { ok: false, state: tabState(entry, contents), error: 'target is not shared with the selected agent' };
                }
                if (!options.isAllowedEmbeddedBrowserUrl(contents.getURL())) {
                    return { ok: false, state: tabState(entry, contents), error: 'current page is not an allowed action target' };
                }
                const parsed = parseActPayload((action as { act?: unknown }).act);
                if (!parsed.ok) return { ok: false, state: tabState(entry, contents), error: parsed.error };
                try {
                    await performAct(contents, parsed.act);
                } catch (err) {
                    return { ok: false, state: tabState(entry, contents), error: `act failed: ${(err as Error).message}` };
                }
                break;
            }
            default:
                return { ok: false, error: 'unknown action' };
        }
        return { ok: true, state: tabState(entry, contents) };
    });

    ipcMain.handle('browser:get-webview-tabs', (event) => {
        if (!isManagerSender(event)) return { ok: false, error: 'unauthorized' };
        const tabs = [];
        for (const entry of tabsById.values()) {
            const contents = resolveOwnedGuest(entry.webContentsId);
            if (!contents) continue;
            tabs.push(tabState(entry, contents));
        }
        return { ok: true, tabs };
    });
}
