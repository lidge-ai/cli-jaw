/**
 * Embedded browser fit-to-width zoom contract.
 *
 * Locks in:
 * - computeFitZoom shrinks overflowing documents to fit the panel viewport
 * - resize refits reuse the stored required width (grow back toward 1)
 * - zoom clamps to [0.5, 1] and tolerates sub-pixel measurement slack
 * - the IPC layer wires fitToWidth / zoomMode and the main side measures via
 *   the read-only Page.getLayoutMetrics probe (no Page.enable, no Runtime)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeFitZoom, FIT_ZOOM_MIN, FIT_ZOOM_MAX } from '../../electron/src/main/lib/browser/fit-zoom.ts';

const root = process.cwd();
const ipcSource = readFileSync(join(root, 'electron/src/main/lib/browser/ipc.ts'), 'utf-8');
const cdpSource = readFileSync(join(root, 'electron/src/main/lib/browser/cdp.ts'), 'utf-8');
const panelSource = readFileSync(join(root, 'public/manager/src/browser-panel/BrowserPanel.tsx'), 'utf-8');
const bridgeSource = readFileSync(join(root, 'public/manager/src/panels/desktop-bridge.ts'), 'utf-8');

function almost(actual: number, expected: number, epsilon = 0.005): void {
    assert.ok(Math.abs(actual - expected) <= epsilon, `expected ~${expected}, got ${actual}`);
}

test('an overflowing document shrinks to the panel width', () => {
    // Naver-style page: 1080 CSS px content in a 700 px panel at zoom 1.
    const decision = computeFitZoom({
        viewportCssWidth: 700,
        contentCssWidth: 1080,
        currentZoom: 1,
        requiredWidth: null,
    });
    almost(decision.zoom, 700 / 1080);
    assert.equal(decision.requiredWidth, 1080);
});

test('a page that fits keeps its zoom and clears nothing', () => {
    const decision = computeFitZoom({
        viewportCssWidth: 700,
        contentCssWidth: 700,
        currentZoom: 1,
        requiredWidth: null,
    });
    assert.equal(decision.zoom, 1);
    assert.equal(decision.requiredWidth, null);
});

test('resize refit uses the stored required width while shrunk', () => {
    // Panel at 700 physical px, page shrunk to ~0.65: the layout viewport is
    // ~1080 CSS px and content (1080) no longer overflows, so only the stored
    // required width can drive a refit.
    const decision = computeFitZoom({
        viewportCssWidth: 1080,
        contentCssWidth: 1080,
        currentZoom: 0.648,
        requiredWidth: 1080,
    });
    almost(decision.zoom, (1080 * 0.648) / 1080);
    assert.equal(decision.requiredWidth, 1080);
});

test('widening past the required width restores zoom 1 and clears the fit', () => {
    // Panel widened to 1200 physical px: viewport is 1200/0.648 CSS px wide.
    const decision = computeFitZoom({
        viewportCssWidth: 1200 / 0.648,
        contentCssWidth: 1080,
        currentZoom: 0.648,
        requiredWidth: 1080,
    });
    assert.equal(decision.zoom, FIT_ZOOM_MAX);
    assert.equal(decision.requiredWidth, null);
});

test('extreme overflow clamps at the minimum zoom', () => {
    const decision = computeFitZoom({
        viewportCssWidth: 300,
        contentCssWidth: 2400,
        currentZoom: 1,
        requiredWidth: null,
    });
    assert.equal(decision.zoom, FIT_ZOOM_MIN);
    assert.equal(decision.requiredWidth, 2400);
});

test('sub-pixel measurement slack does not count as overflow', () => {
    const decision = computeFitZoom({
        viewportCssWidth: 700,
        contentCssWidth: 700.5,
        currentZoom: 1,
        requiredWidth: null,
    });
    assert.equal(decision.zoom, 1);
    assert.equal(decision.requiredWidth, null);
});

test('a 12px overflow on a 1200px viewport is layout slack and stays at 100%', () => {
    const decision = computeFitZoom({
        viewportCssWidth: 1200,
        contentCssWidth: 1212,
        currentZoom: 1,
        requiredWidth: null,
    });
    assert.equal(decision.zoom, FIT_ZOOM_MAX);
    assert.equal(decision.requiredWidth, null, 'slack leaves no stored required width');
});

test('overflow beyond the relative floor still shrinks', () => {
    const decision = computeFitZoom({
        viewportCssWidth: 1200,
        contentCssWidth: 1600,
        currentZoom: 1,
        requiredWidth: null,
    });
    almost(decision.zoom, 1200 / 1600);
    assert.equal(decision.requiredWidth, 1600);
});

test('fit-to-width uses the read-only Page.getLayoutMetrics probe only', () => {
    assert.ok(cdpSource.includes("'Page.getLayoutMetrics'"), 'metrics come from Page.getLayoutMetrics');
    assert.ok(!cdpSource.includes("'Page.enable'"), 'Page domain is never subscribed');
    assert.ok(!/\.executeJavaScript\s*\(/.test(cdpSource), 'no page script execution');
    assert.ok(!/\.executeJavaScript\s*\(/.test(ipcSource), 'ipc has no page script execution');
});

test('ipc wires auto/manual zoom modes and the fitToWidth command', () => {
    assert.ok(ipcSource.includes("zoomMode: 'auto' | 'manual'"), 'tab registration tracks the zoom mode');
    assert.ok(ipcSource.includes("case 'fitToWidth'"), 'fitToWidth control command exists');
    assert.ok(ipcSource.includes("entry.zoomMode = 'manual'"), 'zoom menu switches the tab to manual');
    assert.ok(ipcSource.includes("entry.zoomMode = 'auto'"), 'zoom reset returns the tab to auto');
    assert.ok(ipcSource.includes("'did-navigate'"), 'new documents reset the auto fit');
    assert.ok(ipcSource.includes("'did-finish-load'"), 'load completion triggers a fit measure');
    assert.ok(ipcSource.includes('computeFitZoom('), 'ipc delegates the decision to computeFitZoom');
});

test('zoomReset restores zoom 1 and clears the stored width before refit', () => {
    const zoomResetCase = ipcSource.split("case 'zoomReset'")[1]?.split('break;')[0] ?? '';
    assert.ok(zoomResetCase.includes('setZoomFactor(1)'), 'Reset puts the page back at 100%');
    assert.ok(zoomResetCase.includes('fitRequiredWidth = null'), 'Reset forgets the previous overflow');
    assert.ok(zoomResetCase.includes('applyFitToWidth'), 'Reset re-fits a still-overflowing page');
});

test('async fit applies only to the document it measured', () => {
    assert.ok(ipcSource.includes('getURL() !== measuredUrl'), 'a navigation during the probe cancels the apply');
});

test('a zoom choice or tab replacement during the probe wins over the pending fit', () => {
    const afterProbe = ipcSource.split('await pageLayoutMetrics(contents)')[1] ?? '';
    const beforeDecision = afterProbe.split('computeFitZoom(')[0] ?? '';
    assert.ok(
        beforeDecision.includes("entry.zoomMode !== 'auto'"),
        'a manual zoom picked while the probe was in flight is not overwritten',
    );
    assert.ok(
        beforeDecision.includes('tabsById.get(entry.tabId) !== entry'),
        'a tab whose registration was replaced is not refit',
    );
});

test('in-page navigation re-arms the auto fit', () => {
    assert.ok(ipcSource.includes("'did-navigate-in-page'"), 'same-document navigations reset the auto fit too');
    const inPage = ipcSource.split("'did-navigate-in-page'")[1]?.split('});')[0] ?? '';
    assert.ok(inPage.includes('scheduleFitMeasure'), 'in-page navigation schedules a refit');
});

test('in-page navigation keeps the current zoom while a real navigation resets it', () => {
    const inPage = ipcSource.split("'did-navigate-in-page'")[1]?.split('});')[0] ?? '';
    assert.ok(inPage.includes('forgetFitWidth()'), 'in-page navigation drops the stale fit width');
    assert.ok(!inPage.includes('setZoomFactor(1)'), 'in-page navigation leaves the zoom the user is looking at');
    const didNavigateReset = ipcSource.split('const resetAutoZoom = ()')[1]?.split('};')[0] ?? '';
    assert.ok(didNavigateReset.includes('setZoomFactor(1)'), 'a real navigation still resets the zoom for its new document');
});

test('picked-element overlay converts page CSS px into DIP under zoom', () => {
    assert.ok(panelSource.includes('zoomFactorRef'), 'panel tracks the live zoom factor');
    assert.ok(
        /element\.bounds\.(x|y) \+ element\.bounds\.(width|height) \/ 2\) \* zoom/.test(panelSource),
        'picked bounds are scaled by the zoom factor before rendering',
    );
    assert.ok(cdpSource.includes('visualViewportPageOffset'), 'main subtracts the visual viewport offset');
    assert.ok(
        /bounds\.x - Math\.round\(viewportOffset\.x\)/.test(cdpSource),
        'getBoxModel document bounds become viewport-relative',
    );
    assert.ok(
        /metrics\.cssVisualViewport\?\.pageX \?\? metrics\.layoutViewport\?\.pageX \?\? metrics\.visualViewport\?\.pageX/.test(cdpSource),
        'the offset falls back through layoutViewport before the legacy visualViewport shape',
    );
});

test('renderer requests a refit on panel resize and on tab activation', () => {
    assert.ok(panelSource.includes('ResizeObserver'), 'panel observes the viewport box');
    assert.ok(panelSource.includes("kind: 'fitToWidth'"), 'renderer sends the fitToWidth command');
    assert.ok(
        (panelSource.match(/kind: 'fitToWidth'/g) ?? []).length >= 2,
        'refit is also sent when a hidden tab becomes active again',
    );
    assert.ok(bridgeSource.includes("kind: 'fitToWidth'"), 'bridge command union includes fitToWidth');
    assert.ok(bridgeSource.includes("zoomMode?: 'auto' | 'manual'"), 'bridge state exposes zoomMode');
});
