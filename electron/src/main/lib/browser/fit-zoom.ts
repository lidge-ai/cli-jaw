/**
 * Embedded browser fit-to-width zoom computation.
 *
 * Some pages lay out at a fixed minimum width (e.g. naver.com ~1080 CSS px)
 * that exceeds the browser panel's viewport, so the guest renders clipped on
 * the right with a horizontal scrollbar. Auto fit-to-width shrinks the guest
 * zoomFactor until the document's content width fits the viewport.
 *
 * All inputs and outputs are in CSS pixels. `cssLayoutViewport.clientWidth`
 * and `cssContentSize.width` from CDP `Page.getLayoutMetrics` are already
 * expressed in CSS px, so the guest's physical (DIP) width is
 * `viewportCssWidth * zoom` — zoom-invariant, which lets resize refits reuse
 * a previously measured required width without re-overflowing the page.
 *
 * Pure function: unit-tested in tests/unit/electron-browser-fit-zoom.test.ts.
 */

export const FIT_ZOOM_MIN = 0.5;
export const FIT_ZOOM_MAX = 1;
// Sub-pixel layout slack: scrollWidth can exceed the viewport by a fraction
// without producing a scrollbar.
export const FIT_OVERFLOW_EPSILON_PX = 1;
export const FIT_ZOOM_EPSILON = 0.004;

export type FitZoomInput = {
    /** cssLayoutViewport.clientWidth at the current zoom factor. */
    viewportCssWidth: number;
    /** cssContentSize.width — the document's full scrollable width. */
    contentCssWidth: number;
    /** webContents.getZoomFactor() at measure time. */
    currentZoom: number;
    /**
     * Stored required width (CSS px) for the current document, set by a
     * previous overflow measurement. Lets later resize refits recompute the
     * shrink — and grow back toward 1 — while the page fits at its shrunken
     * zoom and reports no overflow.
     */
    requiredWidth: number | null;
    minZoom?: number;
};

export type FitZoomDecision = {
    /** Zoom factor to apply. */
    zoom: number;
    /** Required width to store for the current document (null clears it). */
    requiredWidth: number | null;
};

function clampZoom(zoom: number, minZoom: number): number {
    return Math.round(Math.min(FIT_ZOOM_MAX, Math.max(minZoom, zoom)) * 1000) / 1000;
}

export function computeFitZoom(input: FitZoomInput): FitZoomDecision {
    const minZoom = input.minZoom ?? FIT_ZOOM_MIN;
    const physicalWidth = input.viewportCssWidth * input.currentZoom;

    if (input.contentCssWidth > input.viewportCssWidth + FIT_OVERFLOW_EPSILON_PX) {
        // Overflow: the document is wider than the layout viewport. For a
        // min-width-bound page the content width is zoom-invariant, so the
        // measured width doubles as the required width for resize refits.
        return {
            zoom: clampZoom(physicalWidth / input.contentCssWidth, minZoom),
            requiredWidth: input.contentCssWidth,
        };
    }

    if (input.requiredWidth !== null) {
        // The page fits at its current zoom. A stored required width means it
        // overflowed before and was shrunk — refit proportionally so widening
        // the panel grows the zoom back toward 1.
        if (input.requiredWidth > physicalWidth) {
            return {
                zoom: clampZoom(physicalWidth / input.requiredWidth, minZoom),
                requiredWidth: input.requiredWidth,
            };
        }
        return { zoom: FIT_ZOOM_MAX, requiredWidth: null };
    }

    return { zoom: input.currentZoom, requiredWidth: null };
}
