import { useCallback, useEffect, useRef, useState } from 'react';
import { sendInstanceMessage } from './api';
import { copyText } from './clipboard/copy-text';
import { hasFolderPanelDragPayload, readFolderPanelDragPayload } from './folder-panel/folder-drag-payload';
import { isElectron } from './panels/desktop-bridge';
import { buildPreviewState } from './preview';
import type { PreviewTheme } from './preview';
import type { DashboardInstance, DashboardScanResult } from './types';

type InstancePreviewProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    enabled: boolean;
    active: boolean;
    refreshKey: number;
    theme: PreviewTheme;
    onOpenNotesFromPreview?: (path: string) => void;
    onOpenDocFromPreview?: (absolutePath: string) => void;
    onPreviewDroppedFiles?: (files: File[]) => void;
    docPanelCapable?: boolean;
    previewInsertTextRequest?: PreviewInsertTextRequest | null;
    onPreviewInsertTextResult?: (id: string, result: PreviewInsertTextResult) => void;
    /** One-shot id; a new value asks the mounted preview to open its own settings page. */
    previewSettingsOpenRequest?: string | null;
    onPreviewSettingsOpenResult?: (id: string, result: PreviewInsertTextResult) => void;
};

const PREVIEW_IFRAME_SANDBOX = 'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads';

export type PreviewInsertTextRequest = {
    id: string;
    port: number;
    text: string;
};

export type PreviewInsertTextResult = { ok: true } | { ok: false; error: string };

type PreviewOpenNotesMessage = {
    type?: unknown;
    path?: unknown;
};

type PreviewSendMessage = {
    type?: unknown;
    requestId?: unknown;
    prompt?: unknown;
    sessionId?: unknown;
};

type PreviewDroppedFilesMessage = {
    type?: unknown;
    files?: unknown;
};

type PreviewInsertTextResultMessage = {
    type?: unknown;
    requestId?: unknown;
    ok?: unknown;
    error?: unknown;
};

function normalizeLoopbackHostname(hostname: string): string {
    return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = normalizeLoopbackHostname(hostname);
    return normalized === '127.0.0.1'
        || normalized === 'localhost'
        || normalized === '::1';
}

function loopbackOriginsEquivalent(a: string, b: string): boolean {
    if (a === b) return true;
    try {
        const left = new URL(a);
        const right = new URL(b);
        if (left.protocol !== right.protocol || left.port !== right.port) return false;
        return isLoopbackHostname(left.hostname) && isLoopbackHostname(right.hostname);
    } catch {
        return false;
    }
}

function previewFrameOriginMatches(origin: string, src: string, frame: HTMLIFrameElement | null): boolean {
    if (!origin || origin === 'null') return false;
    const targetOrigin = previewTargetOrigin(src, frame);
    return Boolean(targetOrigin && loopbackOriginsEquivalent(targetOrigin, origin));
}

function isExpectedPreviewMessage(event: MessageEvent, src: string, frame: HTMLIFrameElement | null): boolean {
    return previewFrameOriginMatches(event.origin, src, frame);
}

function postPreviewSendResult(
    source: MessageEventSource | null,
    origin: string,
    requestId: string,
    result: { ok: boolean; status: number; data?: unknown; error?: string },
): void {
    if (!source || !origin || origin === 'null') return;
    try {
        (source as Window).postMessage({
            type: 'jaw-preview-send-result',
            requestId,
            ...result,
        }, origin);
    } catch (error) {
        console.warn('[manager-preview] send relay result skipped', error);
    }
}

function previewTargetOrigin(src: string, frame: HTMLIFrameElement | null): string | null {
    if (typeof window === 'undefined') return 'http://localhost';
    try {
        const actualOrigin = frame?.contentWindow?.location.origin;
        if (actualOrigin && actualOrigin !== 'null') return actualOrigin;
    } catch {
        // Cross-origin previews hide location; fall back to the expected source origin.
    }
    const expectedOrigin = new URL(src, window.location.href).origin;
    return expectedOrigin === 'null' ? null : expectedOrigin;
}

function postPreviewTheme(frame: HTMLIFrameElement | null, src: string, theme: PreviewTheme): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage(
            { type: 'jaw-preview-theme-sync', theme },
            targetOrigin,
        );
    } catch (error) {
        console.warn('[manager-preview] theme sync skipped', error);
    }
}

function postPreviewSttToggle(frame: HTMLIFrameElement | null, src: string): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage(
            { type: 'jaw-preview-stt-toggle' },
            targetOrigin,
        );
    } catch (error) {
        console.warn('[manager-preview] STT shortcut sync skipped', error);
    }
}

/**
 * Ask the instance to open ITS OWN settings page. The manager never renders instance settings;
 * it only sends this request, and the instance decides. Fire-and-forget like the STT toggle:
 * there is nothing to await, and the instance owns the outcome.
 */
function postPreviewSettingsOpen(frame: HTMLIFrameElement | null, src: string): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage({ type: 'jaw-preview-settings-open' }, targetOrigin);
    } catch (error) {
        console.warn('[manager-preview] settings open request skipped', error);
    }
}

function postPreviewVisible(frame: HTMLIFrameElement | null, src: string): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage(
            { type: 'jaw-preview-visibility', visible: true },
            targetOrigin,
        );
    } catch (error) {
        console.warn('[manager-preview] visibility sync skipped', error);
    }
}

function postPreviewCapabilities(frame: HTMLIFrameElement | null, src: string, docPanel: boolean): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage(
            { type: 'jaw-preview-capabilities', docPanel },
            targetOrigin,
        );
    } catch (error) {
        console.warn('[manager-preview] capability sync skipped', error);
    }
}

function replyPreviewCapabilities(source: MessageEventSource | null, origin: string, docPanel: boolean): void {
    if (!source || !origin || origin === 'null') return;
    try {
        (source as Window).postMessage(
            { type: 'jaw-preview-capabilities', docPanel },
            origin,
        );
    } catch (error) {
        console.warn('[manager-preview] capability reply skipped', error);
    }
}

function postPreviewInsertText(
    frame: HTMLIFrameElement | null,
    src: string,
    text: string,
    timeoutMs = 800,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return Promise.resolve({ ok: false, error: 'preview is unavailable' });
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return Promise.resolve({ ok: false, error: 'preview origin is unavailable' });
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
        let settled = false;
        const finish = (result: { ok: true } | { ok: false; error: string }) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onResult);
            window.clearTimeout(timer);
            resolve(result);
        };
        const onResult = (event: MessageEvent) => {
            if (event.source !== targetWindow) return;
            if (!previewFrameOriginMatches(event.origin, src, frame)) return;
            const data = event.data as PreviewInsertTextResultMessage | null;
            if (!data || data.type !== 'jaw-preview-insert-text-result' || data.requestId !== requestId) return;
            if (data.ok === true) finish({ ok: true });
            else finish({ ok: false, error: typeof data.error === 'string' ? data.error : 'preview rejected insert' });
        };
        const timer = window.setTimeout(() => finish({ ok: false, error: 'preview insert timed out' }), timeoutMs);
        window.addEventListener('message', onResult);
        try {
            targetWindow.postMessage({ type: 'jaw-preview-insert-text', requestId, text }, targetOrigin);
        } catch (error) {
            finish({ ok: false, error: (error as Error).message });
        }
    });
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.closest('[contenteditable="true"], .cm-editor, .ProseMirror, [data-milkdown-root]'));
}

function isPreviewSttShortcut(event: KeyboardEvent): boolean {
    const primarySpace = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Space';
    const fallbackMic = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyM';
    return primarySpace || fallbackMic;
}

function extractDroppedFiles(data: PreviewDroppedFilesMessage | null): File[] {
    if (!data || data.type !== 'jaw-preview-dropped-files' || !Array.isArray(data.files)) return [];
    return data.files.filter((item): item is File => item instanceof File);
}

export function InstancePreview(props: InstancePreviewProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const loadedSrcRef = useRef<string | null>(null);
    const handledInsertRequestRef = useRef<string | null>(null);
    const handledSettingsRequestRef = useRef<string | null>(null);
    const [pathDropStatus, setPathDropStatus] = useState<string | null>(null);
    const [folderDragActive, setFolderDragActive] = useState(false);
    const state = buildPreviewState(
        props.instance,
        props.data,
        // Keep the dedicated preview origin as the default. The legacy `/i`
        // path is only a fallback because root-relative `/api` and `/ws`
        // requests must keep targeting the managed instance.
        { theme: props.theme, desktop: isElectron() },
    );
    const disabledReason = props.instance?.ok
        ? 'Preview is off. Turn it on from the header to mount the iframe.'
        : state.reason;
    const syncTheme = useCallback((): void => {
        if (!props.enabled || !state.canPreview || !state.src) return;
        if (loadedSrcRef.current !== state.src) return;
        postPreviewTheme(iframeRef.current, state.src, props.theme);
    }, [props.enabled, props.theme, state.canPreview, state.src]);

    useEffect(() => {
        const request = props.previewInsertTextRequest;
        if (!request || handledInsertRequestRef.current === request.id) return;
        handledInsertRequestRef.current = request.id;
        const finish = (result: PreviewInsertTextResult): void => {
            props.onPreviewInsertTextResult?.(request.id, result);
        };
        if (!props.instance?.ok || props.instance.port !== request.port) {
            finish({ ok: false, error: 'selected instance preview is not mounted' });
            return;
        }
        if (!props.enabled || !state.canPreview || !state.src) {
            finish({ ok: false, error: disabledReason || 'selected instance preview is unavailable' });
            return;
        }
        if (loadedSrcRef.current !== state.src) {
            finish({ ok: false, error: 'selected instance preview is still loading' });
            return;
        }
        void postPreviewInsertText(iframeRef.current, state.src, request.text)
            .then(finish)
            .catch(error => finish({ ok: false, error: (error as Error).message }));
    }, [disabledReason, props.enabled, props.instance, props.onPreviewInsertTextResult, props.previewInsertTextRequest, state.canPreview, state.src]);

    useEffect(() => {
        const id = props.previewSettingsOpenRequest;
        if (!id || handledSettingsRequestRef.current === id) return;
        handledSettingsRequestRef.current = id;
        const finish = (result: PreviewInsertTextResult): void => {
            props.onPreviewSettingsOpenResult?.(id, result);
        };
        // Deliberately independent of props.active: the preview iframe stays mounted when the
        // Preview tab is not showing, so the request still lands. What it cannot survive is an
        // unmounted or still-loading frame, which is what these guards report.
        if (!props.instance?.ok) {
            finish({ ok: false, error: 'selected instance is not online' });
            return;
        }
        if (!props.enabled || !state.canPreview || !state.src) {
            finish({ ok: false, error: disabledReason || 'turn Preview on to open this instance\u2019s settings' });
            return;
        }
        if (loadedSrcRef.current !== state.src) {
            finish({ ok: false, error: 'selected instance preview is still loading' });
            return;
        }
        postPreviewSettingsOpen(iframeRef.current, state.src);
        finish({ ok: true });
    }, [disabledReason, props.enabled, props.instance, props.onPreviewSettingsOpenResult, props.previewSettingsOpenRequest, state.canPreview, state.src]);

    const handleFolderPathDrop = useCallback(async (event: React.DragEvent): Promise<void> => {
        if (!hasFolderPanelDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setFolderDragActive(false);
        const payload = readFolderPanelDragPayload(event.dataTransfer);
        const text = event.dataTransfer.getData('text/plain');
        const insertedText = payload?.entries?.length
            ? payload.entries.map(entry => entry.path).join('\n')
            : payload?.path || text;
        if (!insertedText || !state.src) return;
        const inserted = await postPreviewInsertText(iframeRef.current, state.src, insertedText);
        if (inserted.ok) {
            setPathDropStatus('Inserted path into preview');
            return;
        }
        const copied = await copyText(insertedText);
        setPathDropStatus(copied.ok ? 'Preview did not accept text. Copied path instead.' : copied.error ?? inserted.error);
    }, [state.src]);

    useEffect(() => {
        syncTheme();
    }, [syncTheme]);

    useEffect(() => {
        const handleFolderDrag = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean }>).detail;
            setFolderDragActive(Boolean(detail?.active));
        };
        window.addEventListener('jaw-folder-panel-drag', handleFolderDrag);
        return () => window.removeEventListener('jaw-folder-panel-drag', handleFolderDrag);
    }, []);

    useEffect(() => {
        if (!props.enabled || !state.canPreview || !state.src || !props.instance?.ok) return undefined;
        function onPreviewSend(event: MessageEvent): void {
            if (event.source !== iframeRef.current?.contentWindow) return;
            if (!state.src || !previewFrameOriginMatches(event.origin, state.src, iframeRef.current)) return;
            const data = event.data as PreviewSendMessage | null;
            if (!data || data.type !== 'jaw-preview-send-message') return;
            const requestId = typeof data.requestId === 'string' ? data.requestId : '';
            const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
            if (!requestId) return;
            if (!prompt) {
                postPreviewSendResult(event.source, event.origin, requestId, {
                    ok: false,
                    status: 400,
                    error: 'prompt must be a non-empty string',
                });
                return;
            }
            // Forward the session the preview is showing, or the instance writes into
            // whichever session happens to be globally active instead.
            const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
            void sendInstanceMessage(props.instance!.port, prompt, sessionId)
                .then(result => {
                    postPreviewSendResult(event.source, event.origin, requestId, {
                        ok: result.ok,
                        status: result.status,
                        data: result.data,
                        ...(result.data.error ? { error: result.data.error } : {}),
                    });
                })
                .catch(error => {
                    postPreviewSendResult(event.source, event.origin, requestId, {
                        ok: false,
                        status: 502,
                        error: (error as Error).message,
                    });
                });
        }
        window.addEventListener('message', onPreviewSend);
        function onPreviewOpenNotes(event: MessageEvent): void {
            if (!state.src || !isExpectedPreviewMessage(event, state.src, iframeRef.current)) return;
            const data = event.data as PreviewOpenNotesMessage | null;
            if (!data || data.type !== 'jaw-preview-open-notes') return;
            const path = typeof data.path === 'string' ? data.path.trim() : '';
            if (!path) return;
            props.onOpenNotesFromPreview?.(path);
        }
        window.addEventListener('message', onPreviewOpenNotes);
        function onPreviewOpenDoc(event: MessageEvent): void {
            if (!state.src || !isExpectedPreviewMessage(event, state.src, iframeRef.current)) return;
            const data = event.data as { type?: unknown; path?: unknown } | null;
            if (!data || data.type !== 'jaw-preview-open-doc') return;
            const path = typeof data.path === 'string' ? data.path.trim() : '';
            if (!path) return;
            props.onOpenDocFromPreview?.(path);
        }
        window.addEventListener('message', onPreviewOpenDoc);
        function onPreviewCapabilitiesRequest(event: MessageEvent): void {
            if (!state.src || !isExpectedPreviewMessage(event, state.src, iframeRef.current)) return;
            const data = event.data as { type?: unknown } | null;
            if (!data || data.type !== 'jaw-preview-capabilities-request') return;
            replyPreviewCapabilities(event.source, event.origin, props.docPanelCapable === true);
        }
        window.addEventListener('message', onPreviewCapabilitiesRequest);
        function onPreviewDroppedFiles(event: MessageEvent): void {
            if (event.source !== iframeRef.current?.contentWindow) return;
            if (!state.src || !previewFrameOriginMatches(event.origin, state.src, iframeRef.current)) return;
            const files = extractDroppedFiles(event.data as PreviewDroppedFilesMessage | null);
            if (files.length === 0) return;
            props.onPreviewDroppedFiles?.(files);
        }
        window.addEventListener('message', onPreviewDroppedFiles);
        return () => {
            window.removeEventListener('message', onPreviewSend);
            window.removeEventListener('message', onPreviewOpenNotes);
            window.removeEventListener('message', onPreviewOpenDoc);
            window.removeEventListener('message', onPreviewCapabilitiesRequest);
            window.removeEventListener('message', onPreviewDroppedFiles);
        };
    }, [props.enabled, props.instance, props.onOpenNotesFromPreview, props.onOpenDocFromPreview, props.onPreviewDroppedFiles, props.docPanelCapable, state.canPreview, state.src]);

    useEffect(() => {
        if (!props.active || !props.enabled || !state.canPreview || !state.src) return undefined;
        function onKeyDown(event: KeyboardEvent): void {
            if (event.defaultPrevented) return;
            if (isEditableShortcutTarget(event.target)) return;
            if (!isPreviewSttShortcut(event)) return;
            event.preventDefault();
            postPreviewSttToggle(iframeRef.current, state.src || '');
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [props.active, props.enabled, state.canPreview, state.src]);

    const prevActiveRef = useRef(false);
    useEffect(() => {
        const wasActive = prevActiveRef.current;
        prevActiveRef.current = props.active;
        if (!wasActive && props.active && state.src) {
            postPreviewVisible(iframeRef.current, state.src);
            postPreviewCapabilities(iframeRef.current, state.src, props.docPanelCapable === true);
        }
    }, [props.active, state.src, props.docPanelCapable]);

    useEffect(() => {
        if (!props.enabled || !state.canPreview || !state.src) return;
        if (loadedSrcRef.current !== state.src) return;
        postPreviewCapabilities(iframeRef.current, state.src, props.docPanelCapable === true);
    }, [props.enabled, props.docPanelCapable, state.canPreview, state.src]);

    return (
        <aside
            className="preview-panel"
            aria-label="Instance preview"
            onDragOver={(event) => {
                if (!hasFolderPanelDragPayload(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(event) => { void handleFolderPathDrop(event); }}
        >
            {(!props.enabled || !state.canPreview) && <div className="preview-empty">{disabledReason}</div>}
            {pathDropStatus && (
                <div className="preview-path-drop-status" role="status">
                    {pathDropStatus}
                    <button type="button" aria-label="Dismiss path drop status" onClick={() => setPathDropStatus(null)}>x</button>
                </div>
            )}

            {props.enabled && state.canPreview && state.src && (
                <iframe
                    key={`${props.instance?.port || 'none'}:${props.refreshKey}`}
                    title={`Jaw instance ${props.instance?.port} preview`}
                    ref={iframeRef}
                    className="preview-frame"
                    src={state.src}
                    sandbox={isElectron() ? undefined : PREVIEW_IFRAME_SANDBOX}
                    allow="clipboard-read; clipboard-write; microphone"
                    onLoad={() => {
                        loadedSrcRef.current = state.src;
                        syncTheme();
                        // Every (re)mount is a fresh document. The active-tab
                        // effect only pings on a !wasActive→active transition, so
                        // an instance switch (port/key changes, active stays true)
                        // remounts without re-settling. Ping here so the embedded
                        // chat runs its jaw-preview-visibility re-settle path.
                        if (state.src) {
                            postPreviewVisible(iframeRef.current, state.src);
                            postPreviewCapabilities(iframeRef.current, state.src, props.docPanelCapable === true);
                        }
                    }}
                />
            )}
            {folderDragActive && (
                <div
                    className="preview-path-drop-overlay"
                    onDragOver={(event) => {
                        if (!hasFolderPanelDragPayload(event.dataTransfer)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'copy';
                    }}
                    onDragLeave={() => setFolderDragActive(false)}
                    onDrop={event => void handleFolderPathDrop(event)}
                />
            )}
        </aside>
    );
}
