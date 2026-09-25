// ── Resize Guard ──
// A viewport-resize burst (manager sidebar drag resizes the iframe, or a window
// edge drag) reflows every scrollable subtree each frame. Browser scroll
// anchoring then rewrites scrollTop per frame and content visibly jumps.
// While a burst is active `body.is-resizing` lets CSS suppress scroll
// anchoring so the page only reflows.

export const RESIZE_GUARD_SETTLE_MS = 160;

export type ResizeGuardHandlers = {
    onResizeStart: () => void;
    onResizeEnd: () => void;
    settleMs?: number;
};

export function createResizeGuard({ onResizeStart, onResizeEnd, settleMs = RESIZE_GUARD_SETTLE_MS }: ResizeGuardHandlers): () => void {
    let active = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    return () => {
        if (!active) {
            active = true;
            onResizeStart();
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            active = false;
            settleTimer = undefined;
            onResizeEnd();
        }, settleMs);
    };
}

export function initResizeGuard(): void {
    const notify = createResizeGuard({
        onResizeStart: () => document.body.classList.add('is-resizing'),
        onResizeEnd: () => document.body.classList.remove('is-resizing'),
    });
    window.addEventListener('resize', notify, { passive: true });
}
