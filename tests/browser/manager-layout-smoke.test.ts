import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { withManagerBrowserLock } from './manager-browser-test-lock';

type BoxMetrics = {
    selector: string;
    display: string;
    gridTemplateColumns: string;
    height: number;
    right: number;
    width: number;
    x: number;
    y: number;
};

type LayoutMetrics = {
    viewport: { height: number; width: number };
    document: { bodyScrollWidth: number; clientWidth: number; scrollWidth: number };
    shell: BoxMetrics | null;
    workspace: BoxMetrics | null;
    command: BoxMetrics | null;
    detail: BoxMetrics | null;
    activity: BoxMetrics | null;
    mobileNav: BoxMetrics | null;
};

const CDP_URL = process.env.MANAGER_BROWSER_CDP_URL || 'http://127.0.0.1:9242';
const MANAGER_URL = process.env.MANAGER_DASHBOARD_URL || 'http://127.0.0.1:24576/';
const SCREENSHOT_DIR = process.env.MANAGER_SCREENSHOT_DIR || join(homedir(), '.cli-jaw', 'screenshots');
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 756, height: 469 },
    { width: 390, height: 844 },
] as const;

type DocumentProof = { nonce: string; documentId: string; src: string };
type Scenario = {
    name: string; status: 'INCOMPLETE' | 'PASS' | 'FAIL'; error: string | null;
    viewport: { width: number; height: number } | null; screenshot: string | null; trace: string | null;
    contextClosed: boolean; pageErrors: string[]; requestFailures: Array<{ url: string; error: string }>;
    cleanupErrors: string[]; observations: Record<string, unknown>;
};
const scenarioNames = [
    'manager dashboard shell has measured layout coverage at critical viewports',
    'manager preview iframe survives Workbench tab changes',
    'manager preview header toggles and refreshes the iframe',
    'manager sidebar shell resizes, persists, resets, and collapses',
    'manager settings page has bounded layout and guarded keyboard close',
];
const evidence: {
    version: number; result: 'INCOMPLETE' | 'PASS' | 'FAIL'; workerNonce: string; scenarios: Scenario[];
    shellWidths: Array<{ width: number; height: number; metrics: LayoutMetrics; screenshot: string }>;
    settingsWidths: Array<{ width: number; height: number; metrics: Record<string, number>; screenshot: string }>;
    preview: { retention?: { before: DocumentProof; during: DocumentProof; afterBack: DocumentProof;
        afterPreview: DocumentProof; tabs: Array<DocumentProof & { mode: string }> };
        refresh?: { before: DocumentProof; after: DocumentProof } };
} = { version: 1, result: 'INCOMPLETE', workerNonce: process.env.MANAGER_QA_WORKER_NONCE ?? '',
    scenarios: [], shellWidths: [], settingsWidths: [], preview: {} };
const browsers: Browser[] = [];
function saveEvidence(): void {
    if (!process.env.MANAGER_SCREENSHOT_DIR || !isAbsolute(SCREENSHOT_DIR)) return;
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    writeFileSync(join(SCREENSHOT_DIR, 'layout-evidence.json'), JSON.stringify(evidence, null, 2));
}
function scenario(t: TestContext): Scenario {
    const receipt = evidence.scenarios.find(row => row.name === t.name);
    assert.ok(receipt, 'Every context must have an owning scenario'); return receipt;
}
function layoutTest(name: string, body: (t: TestContext) => Promise<void>): void {
    test(name, async t => withManagerBrowserLock(async () => {
        const receipt: Scenario = { name, status: 'INCOMPLETE', error: null, viewport: null, screenshot: null, trace: null,
            contextClosed: false, pageErrors: [], requestFailures: [], cleanupErrors: [], observations: {} };
        evidence.scenarios.push(receipt); saveEvidence();
        try {
            assert.ok(process.env.MANAGER_BROWSER_CDP_URL, 'Explicit owned CDP required');
            assert.ok(process.env.MANAGER_DASHBOARD_URL, 'Explicit isolated Manager URL required');
            assert.ok(process.env.MANAGER_SCREENSHOT_DIR && isAbsolute(SCREENSHOT_DIR), 'Absolute external artifact directory required');
            assert.match(evidence.workerNonce, /^[0-9a-f-]{36}$/i, 'Explicit worker document nonce required');
            await body(t);
            receipt.status = 'PASS';
        } catch (error) {
            receipt.status = 'FAIL'; receipt.error = String(error); evidence.result = 'FAIL'; throw error;
        } finally { saveEvidence(); }
    }));
}
async function workerDocument(page: Page): Promise<DocumentProof> {
    const frame = await page.locator('iframe.preview-frame').elementHandle();
    assert.ok(frame, 'Real Preview iframe is mounted');
    const content = await frame.contentFrame(); assert.ok(content, 'Preview frame has a document');
    const marker = content.locator('main[data-qa-worker][data-qa-document-id]');
    // Attached is deliberate: settings/Overview hide this same retained document.
    await marker.waitFor({ state: 'attached' });
    const nonce = await marker.getAttribute('data-qa-worker'), documentId = await marker.getAttribute('data-qa-document-id');
    assert.equal(nonce, evidence.workerNonce, "Preview loaded this run's real worker HTML");
    assert.match(documentId ?? '', /^[0-9a-f-]{36}$/i, 'Worker response document ID required');
    const src = await frame.getAttribute('src'); assert.ok(src);
    return { nonce: nonce!, documentId: documentId!, src };
}

function isDefaultMissingCdp(error: unknown): boolean {
    return !process.env.MANAGER_BROWSER_CDP_URL && String(error).includes('ECONNREFUSED');
}

async function pageForManager(t: TestContext): Promise<Page | null> {
    // One CDP owner: parallel connections auto-dismiss each other's JS dialogs.
    let browser = browsers[0];
    if (!browser) {
        try {
            browser = await chromium.connectOverCDP(CDP_URL);
        } catch (error) {
            if (isDefaultMissingCdp(error)) {
                t.skip(`manager CDP browser is not running at ${CDP_URL}`);
                return null;
            }
            throw error;
        }
        browsers.push(browser);
    }
    const receipt = scenario(t), index = scenarioNames.indexOf(t.name) + 1;
    const context = await browser.newContext();
    let page: Page | undefined;
    let tracing = false;
    t.after(async () => {
        const cleanupErrors: string[] = [];
        if (page) {
            receipt.viewport = page.viewportSize();
            const screenshot = `layout-${index}-final.png`;
            try { await page.screenshot({ path: join(SCREENSHOT_DIR, screenshot), fullPage: false }); receipt.screenshot = screenshot; }
            catch (error) { cleanupErrors.push(`screenshot: ${String(error)}`); }
        }
        if (tracing) {
            const trace = `layout-${index}-trace.zip`;
            try { await context.tracing.stop({ path: join(SCREENSHOT_DIR, trace) }); receipt.trace = trace; }
            catch (error) { cleanupErrors.push(`trace: ${String(error)}`); }
        }
        try { await context.close(); receipt.contextClosed = true; }
        catch (error) { cleanupErrors.push(`context: ${String(error)}`); }
        receipt.cleanupErrors.push(...cleanupErrors);
        const networkFailures = receipt.requestFailures.filter(request => request.error !== 'net::ERR_ABORTED');
        if (receipt.pageErrors.length || networkFailures.length || cleanupErrors.length) {
            receipt.status = 'FAIL'; evidence.result = 'FAIL';
            receipt.error ??= 'Browser errors or context cleanup failed';
        }
        saveEvidence();
        assert.deepEqual(receipt.pageErrors, [], 'No uncaught page errors');
        assert.deepEqual(networkFailures, [], 'No non-abort network failures');
        assert.deepEqual(cleanupErrors, [], 'Context evidence and teardown must succeed');
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); tracing = true;
    page = await context.newPage();
    page.on('pageerror', error => receipt.pageErrors.push(error.message));
    page.on('requestfailed', request => {
        const error = request.failure()?.errorText ?? 'Unknown request failure';
        // Keep deliberate reload/teardown aborts in the raw ledger; only non-abort
        // failures fail transport checks. Loaded HTML is proved independently.
        receipt.requestFailures.push({ url: request.url(), error });
    });
    return page;
}

async function settleLayout(page: Page): Promise<void> {
    await page.waitForFunction(() => [...document.querySelectorAll('.manager-workspace, .manager-sidebar, .workbench, .settings-full-page')]
        .every(el => el.getAnimations().every(animation => animation.playState !== 'running' && !animation.pending)));
}

async function selectFirstOnlineInstance(page: Page): Promise<void> {
    await page.waitForSelector('.dashboard-shell.manager-shell');
    const port = await page.evaluate(async () => {
        localStorage.setItem('jaw.previewEnabled', 'true');
        const response = await fetch('/api/dashboard/instances?showHidden=1');
        const data = await response.json() as { instances?: Array<{ port: number; ok: boolean }> };
        const selected = data.instances?.find(instance => instance.ok);
        if (!selected) throw new Error('No online instance available for preview smoke');
        const saved = await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ui: { sidebarMode: 'instances', selectedPort: selected.port, selectedTab: 'preview', instanceSettingsOpen: false } }),
        });
        if (!saved.ok) throw new Error(`Registry selection failed: ${saved.status}`);
        return selected.port;
    });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((selectedPort) => {
        return document.body.textContent?.includes(String(selectedPort)) ?? false;
    }, port);
}

async function measure(page: Page): Promise<LayoutMetrics> {
    return page.evaluate(`(() => {
        const read = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
                selector,
                display: style.display,
                gridTemplateColumns: style.gridTemplateColumns,
                height: Math.round(rect.height * 100) / 100,
                right: Math.round(rect.right * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                x: Math.round(rect.x * 100) / 100,
                y: Math.round(rect.y * 100) / 100,
            };
        };

        return {
            viewport: { width: innerWidth, height: innerHeight },
            document: {
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                bodyScrollWidth: document.body.scrollWidth,
            },
            shell: read('.dashboard-shell.manager-shell'),
            workspace: read('.manager-workspace'),
            command: read('.manager-command'),
            detail: read('.manager-detail'),
            activity: read('.manager-activity'),
            mobileNav: read('.manager-mobile-nav'),
        };
    })()`) as Promise<LayoutMetrics>;
}

after(async () => {
    try {
        const closed = await Promise.allSettled(browsers.map(browser => browser.close()));
        for (const result of closed) if (result.status === 'rejected') throw result.reason;
        assert.deepEqual(evidence.scenarios.map(row => row.name), scenarioNames);
        for (const row of evidence.scenarios) {
            assert.equal(row.status, 'PASS'); assert.equal(row.contextClosed, true);
            assert.ok(row.trace && row.screenshot); assert.deepEqual(row.cleanupErrors, []);
        }
        assert.deepEqual(evidence.shellWidths.map(row => [row.width, row.height]), VIEWPORTS.map(row => [row.width, row.height]));
        assert.deepEqual(evidence.settingsWidths.map(row => [row.width, row.height]), [1440, 1280, 1024, 1023, 390].map(width => [width, 900]));
        assert.ok(evidence.preview.retention && evidence.preview.refresh);
        evidence.result = 'PASS';
    } catch (error) { evidence.result = 'FAIL'; throw error; }
    finally { saveEvidence(); }
});

layoutTest('manager dashboard shell has measured layout coverage at critical viewports', async (t) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const page = await pageForManager(t);
    if (!page) return;

    for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.dashboard-shell.manager-shell');
        await page.screenshot({
            fullPage: false,
            path: join(SCREENSHOT_DIR, `manager-layout-smoke-${viewport.width}x${viewport.height}.png`),
        });

        const metrics = await measure(page);
        evidence.shellWidths.push({ ...viewport, metrics, screenshot: `manager-layout-smoke-${viewport.width}x${viewport.height}.png` });
        saveEvidence();
        assert.ok(metrics.shell, `${viewport.width}x${viewport.height}: shell must render`);
        assert.ok(metrics.workspace, `${viewport.width}x${viewport.height}: workspace must render`);
        assert.ok(metrics.command, `${viewport.width}x${viewport.height}: command must render`);
        assert.ok(metrics.detail, `${viewport.width}x${viewport.height}: detail/workbench must render`);

        assert.equal(metrics.document.scrollWidth, viewport.width, `${viewport.width}x${viewport.height}: no document horizontal overflow`);
        assert.equal(metrics.document.bodyScrollWidth, viewport.width, `${viewport.width}x${viewport.height}: no body horizontal overflow`);
        assert.ok(Math.abs(metrics.shell.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: shell uses full viewport width`);
        assert.ok(metrics.shell.right <= viewport.width + 1, `${viewport.width}x${viewport.height}: shell cannot create a blank right gutter`);
        assert.ok(Math.abs(metrics.workspace.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: workspace uses full viewport width`);
        assert.ok(metrics.workspace.right <= viewport.width + 1, `${viewport.width}x${viewport.height}: workspace cannot create a blank right gutter`);

        if (viewport.width <= 1023) {
            assert.ok(Math.abs(metrics.command.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: command uses full compact width`);
            assert.ok(Math.abs(metrics.detail.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: workbench uses full compact width`);
            assert.equal(
                metrics.workspace.gridTemplateColumns.includes('300px'),
                false,
                `${viewport.width}x${viewport.height}: compact shell must not leak desktop sidebar column`,
            );
        }

        if (viewport.width <= 767) {
            assert.ok(metrics.mobileNav, `${viewport.width}x${viewport.height}: mobile nav must render`);
            assert.notEqual(metrics.mobileNav.display, 'none', `${viewport.width}x${viewport.height}: mobile nav must be visible`);
            assert.ok(Math.abs(metrics.mobileNav.width - viewport.width) <= 1, `${viewport.width}x${viewport.height}: mobile nav uses full width`);
        }
    }
});

layoutTest('manager preview iframe survives Workbench tab changes', async (t) => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dashboard-shell.manager-shell');
    await selectFirstOnlineInstance(page);

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.waitForSelector('[data-preview-host="persistent"]');
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });

    const before = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame = frame;
        return {
            hostHidden: host?.hasAttribute('hidden') ?? null,
            hasFrame: Boolean(frame),
            src: frame?.getAttribute('src') || null,
        };
    });

    const beforeDocument = await workerDocument(page);
    assert.equal(before.hostHidden, false, 'preview host should be visible on Preview tab');
    assert.equal(before.hasFrame, true, 'preview iframe should render for an online selected instance');

    const workerFrame = page.frameLocator('iframe.preview-frame');
    const marker = workerFrame.locator('main[data-qa-worker]');
    assert.equal(await marker.getAttribute('data-qa-settings-open-count'), '0');
    await page.getByRole('button', { name: 'Instance settings', exact: true }).click();
    await workerFrame.locator('main[data-qa-worker][data-qa-settings-open-count="1"]').waitFor({ state: 'attached' });
    assert.deepEqual(await workerDocument(page), beforeDocument, 'relay keeps the same worker document and source');
    assert.equal(await marker.getAttribute('data-qa-settings-open-count'), '1');
    await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
    await page.locator('.settings-full-page').waitFor({ state: 'visible' });
    const during = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        return {
            surfaceHidden: host?.closest('.workspace-surface')?.hasAttribute('hidden') ?? null,
            sameFrame: frame === (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame,
            src: frame?.getAttribute('src') || null,
        };
    });

    const duringDocument = await workerDocument(page);
    assert.deepEqual(duringDocument, beforeDocument, 'Settings retains the loaded worker document');
    assert.equal(during.surfaceHidden, true, 'Manager settings hides the WorkspaceSurface containing the retained Preview');
    assert.equal(during.sameFrame, true, 'preview iframe must stay mounted while settings replaces the workspace');
    assert.equal(during.src, before.src, 'opening settings must keep the preview source');

    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await page.locator('.settings-full-page').waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#workbench-tab-overview')?.getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('[data-preview-host]').evaluate(el => el.hasAttribute('hidden')), true,
        'Back returns to Overview with Preview still hidden');
    const afterBackDocument = await workerDocument(page);
    assert.deepEqual(afterBackDocument, beforeDocument, 'Overview after Back retains the worker document');
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();

    const after = await page.evaluate(() => {
        const host = document.querySelector('[data-preview-host="persistent"]');
        const frame = document.querySelector('iframe.preview-frame');
        return {
            hostHidden: host?.hasAttribute('hidden') ?? null,
            sameFrame: frame === (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame,
            src: frame?.getAttribute('src') || null,
        };
    });

    const afterPreviewDocument = await workerDocument(page);
    assert.deepEqual(afterPreviewDocument, beforeDocument);
    assert.equal(await marker.getAttribute('data-qa-settings-open-count'), '1', 'exactly one settings request reached the retained document');
    const retention = { before: beforeDocument, during: duringDocument, afterBack: afterBackDocument, afterPreview: afterPreviewDocument, tabs: [] as Array<DocumentProof & { mode: string }> };
    evidence.preview.retention = retention;
    assert.equal(after.hostHidden, false, 'preview host should show again on Preview tab');
    assert.equal(after.sameFrame, true, 'preview iframe must remain the same DOM node after returning');
    assert.equal(after.src, before.src, 'preview source should not change across tab-only navigation');
    for (const mode of ['Overview', 'Logs', 'Preview']) {
        await page.getByRole('tab', { name: mode, exact: true }).click();
        const state = await page.evaluate(() => ({
            hidden: document.querySelector('[data-preview-host]')?.hasAttribute('hidden'),
            same: document.querySelector('iframe.preview-frame') === (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame,
        }));
        assert.equal(state.hidden, mode !== 'Preview'); assert.equal(state.same, true);
        const documentProof = await workerDocument(page); assert.deepEqual(documentProof, beforeDocument);
        retention.tabs.push({ mode, ...documentProof }); saveEvidence();
    }
});

layoutTest('manager preview header toggles and refreshes the iframe', async (t) => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await selectFirstOnlineInstance(page);

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });
    await page.getByRole('switch', { name: /Preview on/i }).click();
    await page.waitForSelector('iframe.preview-frame', { state: 'detached' });
    await page.getByRole('switch', { name: /Preview off/i }).click();
    await page.waitForSelector('iframe.preview-frame', { timeout: 5000 });

    const beforeDocument = await workerDocument(page);
    const beforeRefresh = await page.evaluate(() => {
        const frame = document.querySelector('iframe.preview-frame');
        (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame = frame;
        return frame?.getAttribute('src') || null;
    });

    await page.locator('.preview-refresh-button').click();
    await page.waitForFunction(() => {
        const frame = document.querySelector('iframe.preview-frame');
        return Boolean(frame && frame !== (window as Window & { __jawPreviewFrame?: Element | null }).__jawPreviewFrame);
    });

    const afterRefresh = await page.evaluate(() => {
        const frame = document.querySelector('iframe.preview-frame');
        return frame?.getAttribute('src') || null;
    });

    const afterDocument = await workerDocument(page);
    assert.notEqual(afterDocument.documentId, beforeDocument.documentId, 'Refresh loads a new worker HTML response');
    assert.equal(afterDocument.src, beforeDocument.src);
    evidence.preview.refresh = { before: beforeDocument, after: afterDocument }; saveEvidence();
    assert.equal(afterRefresh, beforeRefresh, 'refresh must reload the existing preview URL without changing target');
});

layoutTest('manager sidebar shell resizes, persists, resets, and collapses', async (t) => {
    const page = await pageForManager(t);
    if (!page) return;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dashboard-shell.manager-shell');
    await page.evaluate(() => localStorage.removeItem('jaw.sidebarWidth'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-resize-handle');

    const readSidebar = () => page.evaluate(() => {
        const sidebar = document.querySelector('.manager-sidebar');
        const workspace = document.querySelector('.manager-workspace');
        const handle = document.querySelector('.sidebar-resize-handle');
        return {
            width: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
            cssVar: workspace ? getComputedStyle(workspace).getPropertyValue('--sidebar-width').trim() : null,
            stored: localStorage.getItem('jaw.sidebarWidth'),
            role: handle?.getAttribute('role') ?? null,
            valueNow: handle?.getAttribute('aria-valuenow') ?? null,
            collapsed: workspace?.classList.contains('is-sidebar-collapsed') ?? false,
        };
    });

    const initial = await readSidebar();
    assert.equal(initial.width, 300, 'sidebar default width is the cli-jaw DEFAULT (300px)');
    assert.equal(initial.cssVar, '300px', 'WorkspaceLayout owns --sidebar-width');
    assert.equal(initial.role, 'separator', 'resize handle must be a focusable separator');
    assert.equal(initial.valueNow, '300', 'resize handle exposes the current width');

    // Synthetic DOM geometry only: clone the shipped Selected/Running rows,
    // retain their CSS context, and exercise worst-case controls without API writes.
    await page.waitForSelector('.manager-sidebar .instance-group[aria-label="Selected instances"] .instance-row');
    await page.waitForSelector('.manager-sidebar .instance-group[aria-label="Running instances"] .instance-row');
    type Rect = { x: number; y: number; right: number; bottom: number; width: number; height: number };
    type Part = { name: string; visible: boolean; rect: Rect };
    type NarrowGeometry = {
        actualSidebarWidth: number;
        rows: Array<{ group: string; actualRowContainerWidth: number; rect: Rect; parts: Part[] }>;
    };
    const captures: Array<{ requestedSidebarWidth: number; sessions: boolean; syntheticDOM: true; screenshot: string; geometry: NarrowGeometry }> = [];
    scenario(t).observations['narrowSidebar'] = captures;
    const readNarrow = () => page.evaluate(`(() => {
        const rect = el => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const visible = el => {
            for (let node = el; node; node = node.parentElement) {
                const style = globalThis.getComputedStyle(node);
                if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
            }
            return true;
        };
        const sidebar = globalThis.document.querySelector('.manager-sidebar');
        return {
            actualSidebarWidth: sidebar.getBoundingClientRect().width,
            rows: [...globalThis.document.querySelectorAll('[data-narrow-row]')].map(row => {
                const style = globalThis.getComputedStyle(row);
                const parts = [
                    ['title', row.querySelector('.instance-row-title strong')],
                    ['status', row.querySelector('.instance-row-status-line')],
                    ...[...row.querySelectorAll('.instance-row-quick .quick-btn, .instance-row-quick .port')]
                        .map(el => [el.getAttribute('aria-label') || 'port', el]),
                ];
                return { group: row.getAttribute('data-narrow-row'), rect: rect(row),
                    actualRowContainerWidth: row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                    parts: parts.map(([name, el]) => {
                        if (!el) throw new Error('Missing narrow row part: ' + name);
                        return { name, visible: visible(el), rect: rect(el) };
                    }) };
            }),
        };
    })()`) as Promise<NarrowGeometry>;
    try {
        await page.evaluate(`(() => {
            const scroll = globalThis.document.querySelector('.manager-sidebar .instance-navigator-scroll');
            if (!scroll) throw new Error('Missing sidebar scroll owner');
            const fixture = globalThis.document.createElement('div');
            fixture.className = 'instance-groups profile-instance-groups is-profile-merged';
            fixture.setAttribute('data-narrow-fixture', 'synthetic DOM geometry, not session API proof');
            for (const label of ['Selected', 'Running']) {
                const source = scroll.querySelector('.instance-group[aria-label="' + label + ' instances"] .instance-row');
                if (!source) throw new Error('Missing real ' + label + ' row');
                const section = globalThis.document.createElement('section');
                section.className = 'instance-group';
                const heading = globalThis.document.createElement('div');
                heading.className = 'instance-group-header';
                heading.textContent = label + ' — synthetic geometry';
                const row = source.cloneNode(true);
                row.setAttribute('data-narrow-row', label);
                row.querySelector('.instance-row-title strong').textContent = '아주 긴 한국어 프로젝트 이름과 작업 인스턴스 상태 확인';
                row.querySelector('.instance-row-status-pill').textContent = '온라인 작업 준비 상태 확인';
                row.querySelector('.instance-row-status-pill').title = '온라인 작업 준비 상태 확인';
                row.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
                row.querySelectorAll('[aria-controls]').forEach(el => el.removeAttribute('aria-controls'));
                row.querySelectorAll('.action-sessions').forEach(el => el.remove());
                // Enable inert cloned quick actions to measure the largest visible set.
                row.querySelectorAll('.instance-row-quick .quick-btn').forEach(el => {
                    el.removeAttribute('disabled'); el.classList.remove('is-disabled'); el.removeAttribute('aria-disabled');
                    el.removeAttribute('href'); el.removeAttribute('target');
                });
                row.classList.add('is-selected');
                section.append(heading, row); fixture.append(section);
            }
            for (const child of scroll.children) child.style.display = 'none';
            scroll.append(fixture);
        })()`);
        for (const requestedSidebarWidth of [164, 220, 300]) {
            for (const sessions of [false, true]) {
                await page.evaluate(({ width, sessions }) => {
                    globalThis.document.querySelector<HTMLElement>('.manager-workspace')!.style.setProperty('--sidebar-width', `${width}px`);
                    for (const row of globalThis.document.querySelectorAll('[data-narrow-row]')) {
                        row.querySelector('.action-sessions')?.remove();
                        if (sessions) {
                            const button = globalThis.document.createElement('button');
                            button.type = 'button'; button.className = 'quick-btn action-sessions';
                            button.setAttribute('aria-label', 'Sessions'); button.title = 'Synthetic Sessions geometry';
                            button.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor"/></svg>';
                            row.querySelector('.instance-row-quick')!.prepend(button);
                        }
                    }
                }, { width: requestedSidebarWidth, sessions });
                await page.waitForFunction(width => {
                    const sidebar = globalThis.document.querySelector('.manager-sidebar');
                    return sidebar && Math.abs(sidebar.getBoundingClientRect().width - width) <= 0.5;
                }, requestedSidebarWidth);
                // Poll measured geometry across animation frames, not a fixed delay.
                let geometry = await readNarrow();
                let stableFrames = 0;
                for (let frame = 0; frame < 60 && stableFrames < 3; frame++) {
                    await page.evaluate(() => new Promise<void>(resolve => globalThis.requestAnimationFrame(() => resolve())));
                    const next = await readNarrow();
                    stableFrames = JSON.stringify(next) === JSON.stringify(geometry) ? stableFrames + 1 : 0;
                    geometry = next;
                }
                const statusText = await page.locator('[data-narrow-row] .instance-row-status-pill').evaluateAll(elements => elements.map(element => ({
                    ellipsis: globalThis.getComputedStyle(element).textOverflow,
                    title: element.getAttribute('title'), text: element.textContent,
                })));
                assert.equal(statusText.length, 2);
                for (const status of statusText) {
                    assert.equal(status.ellipsis, 'ellipsis');
                    assert.equal(status.title, status.text, 'full status text remains available in its tooltip');
                }
                const screenshot = `sidebar-synthetic-${requestedSidebarWidth}-${sessions ? 'sessions' : 'no-sessions'}.png`;
                captures.push({ requestedSidebarWidth, sessions, syntheticDOM: true, screenshot, geometry });
                await page.screenshot({ path: join(SCREENSHOT_DIR, screenshot), fullPage: false });
                saveEvidence();
                assert.equal(stableFrames, 3, 'narrow fixture geometry must settle');
                assert.ok(Math.abs(geometry.actualSidebarWidth - requestedSidebarWidth) <= 0.5);
                assert.deepEqual(geometry.rows.map(row => row.group), ['Selected', 'Running']);
                for (const row of geometry.rows) {
                    const label = `${requestedSidebarWidth}px ${row.group} sessions=${sessions}`;
                    assert.ok(row.actualRowContainerWidth > 0, label);
                    assert.equal(row.parts.length, sessions ? 6 : 5, `${label}: title, status, Stop, Open, port and optional Sessions`);
                    assert.deepEqual(row.parts.map(part => part.name), sessions
                        ? ['title', 'status', 'Sessions', 'Stop', 'Open', 'port']
                        : ['title', 'status', 'Stop', 'Open', 'port']);
                    for (const part of row.parts) {
                        const r = part.rect;
                        assert.ok(part.visible && r.width > 0 && r.height > 0, `${label}: ${part.name} must be displayed with positive dimensions`);
                        assert.ok(r.x >= row.rect.x && r.y >= row.rect.y && r.right <= row.rect.right + 0.5 && r.bottom <= row.rect.bottom + 0.5,
                            `${label}: ${part.name} stays inside its row`);
                        assert.ok(r.x >= 0 && r.y >= 0 && r.right <= 1280 && r.bottom <= 800, `${label}: ${part.name} stays on screen`);
                    }
                    for (let a = 0; a < row.parts.length; a++) {
                        for (let b = a + 1; b < row.parts.length; b++) {
                            const left = row.parts[a]!, right = row.parts[b]!;
                            const overlaps = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.x, right.rect.x) > 0.5
                                && Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.y, right.rect.y) > 0.5;
                            assert.equal(overlaps, false, `${label}: ${left.name} must not overlap ${right.name}`);
                        }
                    }
                }
            }
        }
    } finally {
        // Discard all synthetic DOM and CSS overrides before the real drag flow.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sidebar-resize-handle');
        await page.waitForFunction(() => Math.abs(globalThis.document.querySelector('.manager-sidebar')!.getBoundingClientRect().width - 300) <= 0.5);
        await settleLayout(page);
    }

    const box = await page.locator('.sidebar-resize-handle').boundingBox();
    assert.ok(box, 'resize handle must have a layout box');
    const startX = box.x + box.width / 2;
    const y = box.y + 200;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(startX + step * 10, y);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await readSidebar();
    assert.equal(dragged.width, 420, 'dragging the handle 120px widens the sidebar to 420px');
    assert.equal(dragged.stored, '420', 'the width is persisted under jaw.sidebarWidth');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-resize-handle');
    const restored = await readSidebar();
    assert.equal(restored.width, 420, 'the persisted width survives a reload');

    const box2 = await page.locator('.sidebar-resize-handle').boundingBox();
    assert.ok(box2, 'resize handle must still be mounted after reload');
    await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + 200);
    // the grid column animates 180ms (--motion-base); wait for it to settle
    await page.waitForTimeout(400);
    const reset = await readSidebar();
    assert.equal(reset.width, 300, 'double-click resets the width to the default');
    assert.equal(reset.stored, null, 'reset removes the persisted key');

    await page.keyboard.press('ControlOrMeta+Shift+B');
    await page.waitForFunction(() => document.querySelector('.manager-workspace')?.classList.contains('is-sidebar-collapsed'));
    await page.waitForTimeout(400);
    const collapsed = await readSidebar();
    assert.equal(collapsed.width, 44, 'collapsed sidebar leaves the 44px rail');
    assert.equal(collapsed.cssVar, '44px', 'collapsed width comes from the hook constant');
    await page.keyboard.press('ControlOrMeta+Shift+B');
    await page.waitForFunction(() => {
        const workspace = globalThis.document.querySelector('.manager-workspace');
        const sidebar = globalThis.document.querySelector('.manager-sidebar');
        return workspace && sidebar && !workspace.classList.contains('is-sidebar-collapsed')
            && Math.abs(sidebar.getBoundingClientRect().width - 300) <= 0.5;
    });
    await settleLayout(page);
    const expanded = await readSidebar();
    assert.equal(expanded.width, 300, 'final capture waits for the fully expanded default sidebar');
    scenario(t).observations['finalExpandedSidebar'] = expanded;
});


layoutTest('manager settings page has bounded layout and guarded keyboard close', async (t) => {
    const page = await pageForManager(t); if (!page) return;
    await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' }); await selectFirstOnlineInstance(page);
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    const toggle = page.getByRole('button', { name: 'Dashboard settings', exact: true });
    await toggle.click();
    const panel = page.locator('.settings-full-page');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await panel.getAttribute('aria-label'), 'Dashboard settings');
    assert.equal(await panel.getAttribute('aria-modal'), null);
    assert.equal(await panel.locator('.settings-shell-host').evaluate(el => getComputedStyle(el).containerType), 'inline-size');
    assert.equal(await page.getByRole('tab', { name: 'Settings', exact: true }).count(), 0);
    for (const width of [1440, 1280, 1024, 1023, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await settleLayout(page);
        const metrics = await panel.evaluate(el => {
            const rect = el.getBoundingClientRect(), body = el.closest('.workspace-surface')!.getBoundingClientRect();
            const shell = el.querySelector('.settings-shell')!, main = el.querySelector('.settings-page-main')!;
            return { width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
                bodyWidth: body.width, bodyHeight: body.height, mainWidth: main.getBoundingClientRect().width,
                navWidth: parseFloat(getComputedStyle(shell).gridTemplateColumns),
                documentWidth: document.documentElement.scrollWidth };
        });
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(SCREENSHOT_DIR, `060_settings-page-${width}x900.png`) });
        evidence.settingsWidths.push({ width, height: 900, metrics, screenshot: `060_settings-page-${width}x900.png` });
        saveEvidence();
        assert.ok(metrics.width > 0 && metrics.height > 0, 'Settings must occupy visible workspace');
        assert.ok(Math.abs(metrics.width - metrics.bodyWidth) <= 1, 'Settings uses the workspace surface width');
        assert.ok(metrics.height <= metrics.bodyHeight + 1 && metrics.bottom <= 901, 'Settings remains inside the viewport');
        assert.ok(metrics.right <= width + 1); assert.equal(metrics.documentWidth, width);
        assert.ok(metrics.mainWidth <= 897, 'Settings content keeps its 896px cap');
        assert.equal(metrics.navWidth, width >= 1024 ? 264 : 40, 'Settings navigation follows the full-page breakpoint');
        assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        // manager-layout.css:293 reduces transitions to at most 0.01ms.
        for (const element of [panel, page.locator('.workbench')]) {
            const durations = await element.evaluate(el => getComputedStyle(el).transitionDuration.split(','));
            for (const duration of durations) {
                const value = duration.trim();
                assert.match(value, /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:ms|s)$/i);
                const seconds = parseFloat(value) * (value.endsWith('ms') ? 0.001 : 1);
                assert.ok(seconds <= 0.00001, `reduced-motion transition duration: ${value}`);
            }
        }
        await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    const meta = panel.getByRole('button', { name: 'Dashboard meta', exact: true });
    assert.equal(await meta.count(), 1);
    assert.equal(await panel.getByRole('tab', { name: 'Dashboard meta', exact: true }).count(), 0);
    await meta.click();
    assert.equal(await meta.getAttribute('aria-current'), 'page');
    assert.equal(await panel.locator('.settings-sidebar-item[aria-current="page"]').count(), 1);
    assert.equal(await panel.locator('.settings-sidebar [role=tab]').count(), 0);
    const field = panel.locator('#dashmeta-label');
    await field.waitFor({ state: 'visible' });
    const draft = `${await field.inputValue()} QA draft`; await field.fill(draft);
    await panel.getByRole('button', { name: 'Back to workspace', exact: true }).focus();
    let escapeDialogs = 0;
    const onEscapeDialog = (dialog: import('playwright-core').Dialog) => {
        escapeDialogs++;
        return escapeDialogs === 1 ? dialog.dismiss() : dialog.accept();
    };
    page.on('dialog', onEscapeDialog);
    await page.keyboard.press('Escape');
    assert.equal(escapeDialogs, 1, 'first Escape must show exactly one dirty-draft confirmation');
    assert.equal(await panel.count(), 1); assert.equal(await field.inputValue(), draft);
    scenario(t).observations['dirtyDismissed'] = true;
    await page.keyboard.press('Escape');
    page.off('dialog', onEscapeDialog);
    assert.equal(escapeDialogs, 2, 'second Escape must show exactly one dirty-draft confirmation');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => document.querySelector('#workbench-tab-overview')?.getAttribute('aria-selected') === 'true');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    scenario(t).observations['acceptedBackOverview'] = true;
    await page.keyboard.press('ControlOrMeta+,'); await panel.waitFor({ state: 'visible' });
    scenario(t).observations['shortcutReopened'] = true;
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('ControlOrMeta+,'); await panel.waitFor({ state: 'detached' });
    scenario(t).observations['shortcutClosed'] = true;
    await page.keyboard.press('ControlOrMeta+,'); await panel.waitFor({ state: 'visible' });
    await meta.click();
    await field.waitFor({ state: 'visible' });
    const shortcutDraft = `${await field.inputValue()} shortcut draft`;
    await field.fill(shortcutDraft);
    let shortcutDialogs = 0;
    const onShortcutDialog = (dialog: import('playwright-core').Dialog) => {
        shortcutDialogs++;
        return shortcutDialogs === 1 ? dialog.dismiss() : dialog.accept();
    };
    page.on('dialog', onShortcutDialog);
    await page.keyboard.press('ControlOrMeta+,');
    assert.equal(shortcutDialogs, 1, 'first shortcut must show exactly one dirty-draft confirmation');
    assert.equal(await panel.count(), 1); assert.equal(await field.inputValue(), shortcutDraft);
    await page.keyboard.press('ControlOrMeta+,');
    page.off('dialog', onShortcutDialog);
    assert.equal(shortcutDialogs, 2, 'second shortcut must show exactly one dirty-draft confirmation');
    await panel.waitFor({ state: 'detached' });
});
