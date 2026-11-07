/** Real built Manager + API/SQLite/SSE; only native providers are deterministic.
 * Start tests/helpers/code-native-qa-server.mjs separately after the build.
 * Required: CODE_NATIVE_QA_MANIFEST and MANAGER_BROWSER_CDP_URL (existing CDP).
 * No browser/server spawn, build, install, synthetic route/history or default
 * production URL. Evidence and owned homes survive teardown for Main's review.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { withManagerBrowserLock } from './manager-browser-test-lock';
import type { CodeHistoryPage, CodeSnapshot, CodeSessionInfo } from '../../src/code-mode/wire';

interface Manifest {
    version: number; token: string; pid: number; root: string; workspace: string;
    managerUrl: string; workerUrl: string; workerPort: number; previewPort: number;
    evidenceDir: string; localFileCallback: boolean;
}
interface ProviderState {
    token: string;
    handles: Array<{ provider: string; sessionId: string; nativeSessionId: string; sends: number;
        closed: boolean; cancelRequested: boolean; approval: string | null }>;
    steps: Array<{ kind: string; sessionId?: string }>;
}
type EvidenceStep = { name: string; status: 'PASS' | 'FAIL'; screenshot: string; error?: string; detail?: unknown;
    capture: { capturedAt: string; viewport: { width: number; height: number } | null; settled: boolean; settleError?: string } };

function readManifest(): Manifest {
    const file = process.env.CODE_NATIVE_QA_MANIFEST;
    assert.ok(file && isAbsolute(file), 'Explicit absolute CODE_NATIVE_QA_MANIFEST is required');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    assert.equal(manifest.version, 1);
    assert.ok(manifest.token && Number.isInteger(manifest.pid));
    assert.equal(manifest.evidenceDir, join(manifest.root, 'evidence'));
    assert.equal(manifest.workspace, join(manifest.root, 'workspace'));
    for (const value of [manifest.managerUrl, manifest.workerUrl]) {
        const url = new URL(value);
        assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
        assert.ok(url.port);
    }
    return manifest;
}
async function control(manifest: Manifest, path: string, method = 'GET'): Promise<ProviderState> {
    const response = await fetch(`${manifest.workerUrl}/__qa/${path}`, {
        method, headers: { 'x-code-qa-token': manifest.token }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `owned QA control ${method} ${path}: ${body.slice(0, 4096)}`);
    return JSON.parse(body) as ProviderState;
}
async function api<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
    return page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(path, { method, headers: { 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
        return response.json();
    }, { path, method, body }) as Promise<T>;
}
async function waitSession(page: Page, sessionId: string, status: string): Promise<CodeSnapshot> {
    await page.waitForFunction(async ({ sessionId, status }) => {
        const response = await fetch(`/api/code/sessions/${encodeURIComponent(sessionId)}`);
        if (!response.ok) return false;
        return (await response.json()).session.status === status;
    }, { sessionId, status }, { timeout: 20_000, polling: 100 });
    return api<CodeSnapshot>(page, `/api/code/sessions/${encodeURIComponent(sessionId)}`);
}
async function waitDraft(page: Page, text: string) {
    await page.waitForFunction(text => (document.querySelector('[aria-label="Code prompt"]') as HTMLTextAreaElement | null)?.value === text, text);
}
async function waitText(page: Page, text: string) {
    await page.getByRole('log', { name: 'Code transcript' }).getByText(text, { exact: true }).waitFor({ state: 'visible' });
}
async function send(page: Page, text: string) {
    await page.getByRole('textbox', { name: 'Code prompt', exact: true }).fill(text);
    const [admission] = await Promise.all([
        page.waitForResponse(response => /^\/api\/code\/sessions\/[^/]+\/prompt$/.test(new URL(response.url()).pathname)
            && response.request().method() === 'POST'),
        page.getByRole('button', { name: 'Send prompt', exact: true }).click(),
    ]);
    assert.equal(admission.status(), 202, 'Wait for real turn admission before testing settlement');
}
async function createSession(page: Page, provider: 'Codex' | 'Claude', text: string): Promise<CodeSessionInfo> {
    await page.getByRole('button', { name: 'New Code session', exact: true }).click();
    await page.getByRole('button', { name: /^Runtime: / }).click();
    await page.getByRole('listbox', { name: 'Runtime', exact: true }).getByRole('option', { name: provider, exact: true }).click();
    const runtime = page.getByRole('button', { name: `Runtime: ${provider}`, exact: true });
    await runtime.waitFor({ state: 'visible' });
    await runtime.click();
    const selected = page.getByRole('listbox', { name: 'Runtime', exact: true }).getByRole('option', { name: provider, exact: true });
    assert.equal(await selected.getAttribute('aria-selected'), 'true');
    await runtime.click();
    const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/code/sessions'
            && response.request().method() === 'POST'),
        send(page, text),
    ]);
    assert.equal(response.status(), 201);
    const body = await response.json() as { session: CodeSessionInfo };
    assert.equal(body.session.provider, provider === 'Codex' ? 'codex-app' : 'claude');
    await waitSession(page, body.session.sessionId, 'idle');
    return body.session;
}
function sessionRow(page: Page, title: string) {
    return page.locator('.code-session-row').filter({ has: page.getByText(title, { exact: true }) });
}
async function selectSession(page: Page, title: string) {
    const button = sessionRow(page, title).locator('button.code-session-item');
    await button.click();
    await page.waitForFunction(title => document.querySelector('.code-session-header .code-session-title')?.textContent === title, title);
}
// The row menu is a right-click ContextMenu portaled to document.body; no row disclosure exists.
async function rowMenu(page: Page, title: string) {
    await sessionRow(page, title).locator('button.code-session-item').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${title}`, exact: true });
    await menu.waitFor({ state: 'visible' });
    return menu;
}
async function rename(page: Page, oldTitle: string, newTitle: string) {
    const menu = await rowMenu(page, oldTitle);
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const row = sessionRow(page, oldTitle);
    await row.getByRole('textbox', { name: 'Session title', exact: true }).fill(newTitle);
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await sessionRow(page, newTitle).waitFor({ state: 'visible' });
}
async function setArchivedFilter(page: Page, enabled: boolean) {
    const search = page.getByRole('button', { name: 'Search sessions', exact: true });
    if (await search.getAttribute('aria-pressed') !== 'true') await search.click();
    assert.equal(await search.getAttribute('aria-pressed'), 'true');
    const archived = page.getByRole('button', { name: 'Archived', exact: true });
    if (await archived.getAttribute('aria-pressed') !== String(enabled)) await archived.click();
    assert.equal(await archived.getAttribute('aria-pressed'), String(enabled));
}
async function closeVisibleDrawer(page: Page): Promise<boolean> {
    const drawer = page.getByRole('dialog', { name: 'Instance drawer', exact: true });
    const open = await drawer.isVisible();
    if (open) {
        assert.equal(await page.locator('.manager-workspace').evaluate(element => element.classList.contains('is-drawer-open')), true);
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
    }
    // Resize starts a real 200ms CSS transform. A partially translated sidebar
    // is not settled geometry: wait for its observed closed position and actual
    // animation completion, without sleeps, forced styles or hidden DOM.
    await page.waitForFunction(() => {
        const workspace = document.querySelector('.manager-workspace');
        const sidebar = document.querySelector('.manager-sidebar');
        if (!workspace || !sidebar || workspace.classList.contains('is-drawer-open')) return false;
        if (matchMedia('(max-width: 1023px)').matches && sidebar.getBoundingClientRect().right > 0.5) return false;
        return [...workspace.getAnimations(), ...sidebar.getAnimations()]
            .every(animation => animation.playState !== 'running' && !animation.pending);
    }, undefined, { timeout: 5_000 });
    return open;
}
async function containment(page: Page, session: CodeSessionInfo) {
    const closedDrawer = await closeVisibleDrawer(page);
    const metrics = await page.evaluate(() => {
        const selectors = ['.code-canvas', '.code-canvas-main', '.code-composer', '.code-permissions'];
        const targets = [...document.querySelectorAll('.code-permission-actions button, .code-composer textarea, .code-composer button, .code-composer-footer button, .code-composer-footer input')];
        return { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
            drawerOpen: document.querySelector('.manager-workspace')?.classList.contains('is-drawer-open'),
            sidebarRight: document.querySelector('.manager-sidebar')?.getBoundingClientRect().right,
            controls: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
                const rect = element.getBoundingClientRect();
                return { selector, left: rect.left, right: rect.right, width: rect.width };
            })),
            hitTests: targets.map(element => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                // Native disabled semantics, not pointer-events alone, determine
                // eligibility. Disabled buttons intentionally let the parent hit.
                const disabled = element.matches(':disabled');
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return { name: element.getAttribute('aria-label') || element.textContent?.trim(),
                    tag: element.tagName, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    disabled, hitTestRequired: !disabled, pointerEvents: style.pointerEvents,
                    visible: style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0,
                    inViewport: rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= innerWidth + 1
                        && rect.top >= -1 && rect.bottom <= innerHeight + 1,
                    unobscured: hit !== null && element.contains(hit),
                    blocker: hit && !element.contains(hit) ? { tag: hit.tagName, class: hit.getAttribute('class'), label: hit.getAttribute('aria-label') } : null };
            }) };
    });
    assert.ok(metrics.document <= metrics.viewport + 1, JSON.stringify(metrics));
    assert.ok(metrics.body <= metrics.viewport + 1, JSON.stringify(metrics));
    assert.equal(metrics.drawerOpen, false);
    if (metrics.viewport < 1024) assert.ok(metrics.sidebarRight !== undefined && metrics.sidebarRight <= 0.5, JSON.stringify(metrics));
    assert.ok(metrics.controls.length >= 3, 'Workbench and composer must actually render');
    for (const rect of metrics.controls) {
        assert.ok(rect.width > 0 && rect.left >= -1 && rect.right <= metrics.viewport + 1, JSON.stringify(rect));
    }
    assert.ok(metrics.hitTests.some(target => target.name === 'Code prompt'), 'Required control must render: Code prompt');
    const runtimeLabels = { 'codex-app': 'Codex', claude: 'Claude', cursor: 'Cursor', grok: 'Grok' };
    const permissionLabels = { ask: 'Ask first', auto: 'Auto (YOLO)', 'read-only': 'Read only', plan: 'Plan',
        'accept-edits': 'Accept edits', 'dont-ask': "Don't ask", 'auto-review': 'Auto review' };
    for (const name of [`Runtime: ${runtimeLabels[session.provider]}`, `Model: ${session.model}`,
        `Permission: ${permissionLabels[session.permissionMode]}`]) {
        assert.ok(metrics.hitTests.some(target => target.name === name), `Required selected control must render: ${name}`);
    }
    assert.ok(metrics.hitTests.some(target => target.name === 'Send prompt' || target.name === 'Stop current turn'));
    const obstructed = metrics.hitTests.filter(target => !target.visible || !target.inViewport || (target.hitTestRequired && !target.unobscured));
    assert.deepEqual(obstructed, [], `Controls must remain visible and in bounds; enabled controls must receive center hits: ${JSON.stringify(obstructed)}`);
    return { ...metrics, closedDrawer };
}

const fixtureDiff = '@@ -1 +1 @@\n-old\n+new\n';
function transcript(page: Page) { return page.getByRole('log', { name: 'Code transcript' }); }
async function reenter(page: Page) {
    await page.getByRole('tab', { name: 'Jaw', exact: true }).click();
    await transcript(page).waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await transcript(page).waitFor({ state: 'visible' });
}
async function firstVisible(page: Page): Promise<number> {
    return transcript(page).evaluate(node => {
        const top = node.getBoundingClientRect().top;
        const rows = [...node.querySelectorAll<HTMLElement>('[data-code-transcript-idx]')];
        const row = rows.find(element => element.getBoundingClientRect().bottom > top + 1);
        if (!row) throw new Error('No visible transcript row');
        return Number(row.dataset.codeTranscriptIdx);
    });
}
async function scrollToMiddle(page: Page) {
    const log = transcript(page);
    await log.evaluate(node => { node.scrollTop = node.scrollHeight * 0.6; });
    await page.waitForTimeout(300);
    const index = await firstVisible(page);
    const metrics = await log.evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
    assert.ok(metrics.top > 100 && metrics.top < metrics.max - 100, JSON.stringify(metrics));
    return index;
}
async function assertAnchor(page: Page, index: number) {
    await page.waitForFunction(expected => {
        const node = document.querySelector('.code-transcript');
        if (!node) return false;
        const row = [...node.querySelectorAll<HTMLElement>('[data-code-transcript-idx]')]
            .find(element => element.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1);
        return row && Math.abs(Number(row.dataset.codeTranscriptIdx) - expected) <= 1;
    }, index, { timeout: 15_000 });
}
async function assertBottom(page: Page) {
    await page.waitForFunction(() => {
        const node = document.querySelector('.code-transcript');
        return node && node.scrollHeight - node.scrollTop - node.clientHeight <= 64;
    });
}
function card(page: Page, name: string) {
    return transcript(page).locator('details.code-tool-card').filter({ has: page.getByText(name, { exact: true }) });
}

async function shutdownOwned(manifest: Manifest) {
    const receipt = join(manifest.evidenceDir, 'provider-events.json');
    const exited = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
            clearTimeout(timer); clearInterval(check); watcher.close();
            if (error) reject(error); else resolve();
        };
        const observe = () => { if (existsSync(receipt)) finish(); };
        const watcher = watch(manifest.evidenceDir, observe);
        // Some filesystems coalesce the temporary-file and rename notifications.
        const check = setInterval(observe, 100);
        const timer = setTimeout(() => finish(new Error('Owned Manager exit receipt timed out')), 20_000);
        watcher.on('error', finish);
    });
    // Install observation before dispatch, and observe both promises on failure.
    const results = await Promise.allSettled([exited, control(manifest, 'shutdown', 'POST')]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const proof = JSON.parse(readFileSync(receipt, 'utf8')) as ProviderState & { exitCode: number; shutdownRequested: boolean };
    assert.equal(proof.exitCode, 0); assert.equal(proof.shutdownRequested, true);
    assert.ok(proof.handles.every(handle => handle.closed), 'Every owned native resource must report closed on exit');
}

test('native Code workbench on isolated real Manager', { timeout: 320_000 }, async () => {
    const manifest = readManifest();
    const cdp = process.env.MANAGER_BROWSER_CDP_URL;
    const results: EvidenceStep[] = [];
    const network: Array<{ method: string; url: string; status: number }> = [];
    const errors: string[] = [];
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let owned = false;
    let failure: unknown;
    async function step(name: string, run: () => Promise<unknown>, continueOnFailure = false): Promise<boolean> {
        assert.ok(page);
        const screenshot = join(manifest.evidenceDir, `${String(results.length + 1).padStart(2, '0')}-${name}.png`);
        try {
            const detail = await run();
            await closeVisibleDrawer(page);
            const capture = { capturedAt: new Date().toISOString(), viewport: page.viewportSize(), settled: true };
            await page.screenshot({ path: screenshot, fullPage: false });
            results.push({ name, status: 'PASS', screenshot, detail, capture });
            return true;
        } catch (error) {
            let settleError: string | undefined;
            try { await closeVisibleDrawer(page); } catch (error) { settleError = String(error); }
            const capture = { capturedAt: new Date().toISOString(), viewport: page.viewportSize(), settled: !settleError,
                ...(settleError ? { settleError } : {}) };
            await page.screenshot({ path: screenshot, fullPage: false }).catch(() => undefined);
            results.push({ name, status: 'FAIL', screenshot, error: String(error), capture });
            if (!continueOnFailure) throw error;
            return false;
        }
    }
    try {
        assert.equal((await control(manifest, 'state')).token, manifest.token);
        owned = true;
        assert.ok(cdp, 'MANAGER_BROWSER_CDP_URL must point at Main-owned headless CDP');
        await withManagerBrowserLock(async () => {
            browser = await chromium.connectOverCDP(cdp);
            context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
            page = await context.newPage();
            const p = page;
            p.setDefaultTimeout(20_000);
            p.on('pageerror', error => errors.push(error.message));
            p.on('response', response => {
                if (new URL(response.url()).pathname.startsWith('/api/code') || new URL(response.url()).pathname === '/api/events') {
                    network.push({ method: response.request().method(), url: response.url(), status: response.status() });
                }
            });
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            await step('built-manager-isolation', async () => {
                const healthResponse = await p.request.get(`${manifest.managerUrl}api/dashboard/health`);
                const health = await healthResponse.json();
                assert.equal(health.pid, manifest.pid); assert.equal(health.rangeFrom, manifest.workerPort);
                assert.equal(health.rangeTo, manifest.workerPort); assert.equal(health.service, 'manager-dashboard');
                const response = await p.goto(manifest.managerUrl, { waitUntil: 'domcontentloaded' });
                assert.equal(response?.headers()['x-jaw-manager-ui'], 'dist', 'Never accept source fallback as built UI');
                await p.locator('.dashboard-shell.manager-shell').waitFor({ state: 'visible' });
                await api(p, '/api/dashboard/registry', 'PATCH', { ui: { selectedPort: manifest.workerPort,
                    selectedTab: 'overview', sidebarMode: 'instances', sidebarCollapsed: false,
                    activityDockCollapsed: true, rightFolderRootPath: manifest.workspace, locale: 'en' } });
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await p.getByRole('button', { name: 'New Code session', exact: true }).waitFor({ state: 'visible' });
                await p.getByRole('textbox', { name: 'Code prompt', exact: true }).waitFor({ state: 'visible' });
                const catalog = await api<{ providers: Array<{ id: string }> }>(p, '/api/code/models');
                assert.deepEqual(catalog.providers.map(provider => provider.id).sort(), ['claude', 'codex-app', 'cursor', 'grok']);
                return health;
            });
            let a!: CodeSessionInfo;
            let b!: CodeSessionInfo;
            await step('create-two-providers-and-drafts', async () => {
                a = await createSession(p, 'Codex', 'qa:markdown alpha');
                assert.equal(a.cwd, manifest.workspace);
                await rename(p, 'qa:markdown alpha', 'Alpha Codex');
                await p.getByRole('textbox', { name: 'Code prompt' }).fill('Unsent Alpha draft');
                b = await createSession(p, 'Claude', 'qa:markdown beta');
                await rename(p, 'qa:markdown beta', 'Beta Claude');
                await p.getByRole('textbox', { name: 'Code prompt' }).fill('Unsent Beta draft');
                await selectSession(p, 'Alpha Codex'); await waitDraft(p, 'Unsent Alpha draft');
                await selectSession(p, 'Beta Claude'); await waitDraft(p, 'Unsent Beta draft');
                assert.notEqual(a.sessionId, b.sessionId);
                return { alpha: a.sessionId, beta: b.sessionId };
            });
            await step('stream-sse-and-stop', async () => {
                await selectSession(p, 'Alpha Codex');
                await send(p, 'qa:hold stop me');
                await waitText(p, 'First deterministic chunk.');
                await control(manifest, `advance/${a.sessionId}`, 'POST');
                await waitText(p, 'First deterministic chunk. Second deterministic chunk.');
                await p.getByRole('textbox', { name: 'Code prompt' }).fill('Follow-up preserved during Stop');
                // Starting the click alone lets us observe the pending cancel API,
                // which only completes after the fake native resource drains.
                await p.getByRole('button', { name: 'Stop current turn', exact: true }).click();
                await waitSession(p, a.sessionId, 'stopping');
                // CodeComposer.tsx:81-92 puts the stopping announcement beside the icon-only Stop button.
                await p.locator('.code-composer [role="status"]').getByText('Stopping…', { exact: true }).waitFor({ state: 'visible' });
                assert.equal(await p.getByRole('button', { name: 'Stop current turn', exact: true }).isDisabled(), true);
                await closeVisibleDrawer(p);
                await p.screenshot({ path: join(manifest.evidenceDir, 'stop-pending.png'), fullPage: false });
                const before = await control(manifest, 'state');
                assert.equal(before.handles.find(handle => handle.sessionId === a.sessionId)?.closed, false);
                await control(manifest, `release-cancel/${a.sessionId}`, 'POST');
                const snapshot = await waitSession(p, a.sessionId, 'idle');
                assert.ok(snapshot.items.some(item => item.kind === 'turn_cancelled'));
                await waitDraft(p, 'Follow-up preserved during Stop');
                const state = await control(manifest, 'state');
                const handles = state.handles.filter(handle => handle.sessionId === a.sessionId);
                assert.equal(handles.length, 1, 'Second turn uses the warm native handle');
                assert.equal(handles[0]?.sends, 2); assert.equal(handles[0]?.closed, true);
                assert.ok(network.some(row => new URL(row.url).pathname === '/api/events' && row.status === 200));
                return state;
            });
            await step('approval-wide', async () => {
                await selectSession(p, 'Beta Claude');
                await send(p, 'qa:approval request');
                await p.getByRole('button', { name: 'Allow fixture once', exact: true }).waitFor({ state: 'visible' });
                const snapshot = await api<CodeSnapshot>(p, `/api/code/sessions/${b.sessionId}`);
                assert.equal(snapshot.pendingPermissions.length, 1);
                assert.equal(snapshot.pendingPermissions[0]?.options[0]?.optionId, 'opaque-allow-17');
                return containment(p, b);
            }, true);
            await step('approval-mobile-390', async () => {
                await p.setViewportSize({ width: 390, height: 844 });
                await closeVisibleDrawer(p);
                const allow = p.getByRole('button', { name: 'Allow fixture once', exact: true });
                await allow.scrollIntoViewIfNeeded();
                const metrics = await containment(p, b);
                await p.screenshot({ path: join(manifest.evidenceDir, 'approval-pending-390.png'), fullPage: false });
                await allow.click();
                await waitSession(p, b.sessionId, 'idle');
                await waitText(p, 'Fixture approved through RuntimeRequests.');
                assert.equal((await control(manifest, 'state')).handles.find(handle => handle.sessionId === b.sessionId)?.approval, 'opaque-allow-17');
                return metrics;
            }, true);
            await step('rename-archive-restore-reload', async () => {
                await p.setViewportSize({ width: 1440, height: 1000 });
                await rename(p, 'Beta Claude', 'Reviewed Claude');
                await p.getByRole('textbox', { name: 'Code prompt' }).fill('Reload keeps this exact draft');
                const row = sessionRow(p, 'Reviewed Claude');
                await (await rowMenu(p, 'Reviewed Claude')).getByRole('menuitem', { name: 'Archive', exact: true }).click();
                await row.waitFor({ state: 'detached' });
                const archived = await api<CodeSnapshot>(p, `/api/code/sessions/${b.sessionId}`);
                assert.ok(archived.session.archivedAt !== null);
                await setArchivedFilter(p, true);
                await selectSession(p, 'Reviewed Claude');
                assert.equal(await p.getByRole('textbox', { name: 'Code prompt' }).getAttribute('readonly'), '');
                await (await rowMenu(p, 'Reviewed Claude')).getByRole('menuitem', { name: 'Restore', exact: true }).click();
                await row.waitFor({ state: 'detached' });
                await setArchivedFilter(p, false);
                await selectSession(p, 'Reviewed Claude');
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await selectSession(p, 'Reviewed Claude');
                await waitDraft(p, 'Reload keeps this exact draft');
                await waitText(p, 'Fixture approved through RuntimeRequests.');
                return api<CodeSnapshot>(p, `/api/code/sessions/${b.sessionId}`);
            }, true);
            let history: CodeSessionInfo | null = null;
            await step('markdown-math-and-virtual-rows-wide', async () => {
                // A separate session puts row 000 at the start without deriving
                // scroll offsets from the implementation's virtualizer internals,
                // and does not depend on the preceding reload/archive scenario.
                await p.setViewportSize({ width: 1440, height: 1000 });
                await closeVisibleDrawer(p);
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await setArchivedFilter(p, false);
                history = await createSession(p, 'Codex', 'qa:rows virtual history');
                const stored = await waitSession(p, history.sessionId, 'idle');
                assert.equal(stored.items.filter(item => item.text?.startsWith('History row ')).length, 240);
                const recent = await api<CodeHistoryPage>(p, `/api/code/sessions/${history.sessionId}/items?limit=100`);
                assert.equal(recent.items.length, 100); assert.equal(recent.hasMore, true);
                assert.ok(recent.beforeSequence !== null);
                const older = await api<CodeHistoryPage>(p, `/api/code/sessions/${history.sessionId}/items?limit=100&beforeSequence=${recent.beforeSequence}`);
                assert.equal(older.items.length, 100);
                const recentIds = new Set(recent.items.map(item => item.itemId));
                assert.ok(older.items.every(item => !recentIds.has(item.itemId)), 'Real materialized history pages do not overlap');
                const log = p.getByRole('log', { name: 'Code transcript' });
                await log.focus(); await log.press('End');
                await log.locator('.katex').first().scrollIntoViewIfNeeded();
                await log.locator('.katex').first().waitFor({ state: 'visible' });
                assert.equal(await log.locator('a[href^="javascript:"]').count(), 0);
                assert.equal(await log.locator('img[onerror]').count(), 0);
                const emphasis = log.getByText('Persisted Markdown', { exact: true });
                await emphasis.waitFor({ state: 'visible' });
                assert.equal(await emphasis.evaluate(element => element.tagName), 'STRONG');
                const rows = await log.locator('[data-code-item-id]').count();
                assert.ok(rows > 0 && rows < 100, `Virtualized DOM must be bounded: ${rows}/${stored.items.length}`);
                await log.press('Home'); await waitText(p, 'History row 000 — deterministic retained content.');
                await log.press('End'); await log.locator('.katex').first().scrollIntoViewIfNeeded();
                return { rows, persistedItems: stored.items.length, historyPageSizes: [recent.items.length, older.items.length], layout: await containment(p, history) };
            }, true);
            await step('markdown-math-mobile-390', async () => {
                assert.ok(history, 'History session admission is required for the mobile history case');
                await p.setViewportSize({ width: 390, height: 844 });
                await closeVisibleDrawer(p);
                const log = p.getByRole('log', { name: 'Code transcript' });
                await log.focus(); await log.press('End');
                await log.locator('.katex').first().scrollIntoViewIfNeeded();
                await log.locator('.katex').first().waitFor({ state: 'visible' });
                return containment(p, history);
            }, true);
            // These steps reuse the history session and Alpha: the fixture's Code
            // runtime admits four resident sessions and the Korean case below
            // still needs its own.
            const historyTitle = 'qa:rows virtual history';
            let anchor = -1;
            await step('file-change-cards', async () => {
                assert.ok(history, 'History session admission is required for the file change case');
                const session = history;
                await p.setViewportSize({ width: 1440, height: 1000 });
                await closeVisibleDrawer(p);
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await selectSession(p, historyTitle);
                await send(p, 'qa:file-change cards');
                async function checkCards(pass: string) {
                    const log = transcript(p);
                    await log.getByText('Edit src/app.ts', { exact: true }).waitFor();
                    assert.equal(await log.locator('.code-tool-name').filter({ hasText: /^file change(?:\s|$)/ }).count(), 1,
                        `${pass}: the legacy-shaped call still renders as one generic tool row`);
                    const single = card(p, 'Edit src/app.ts');
                    if (await single.getAttribute('open') === null) await single.locator('summary').first().click();
                    const review = single.locator('details.code-file-review');
                    if (await review.getAttribute('open') === null) await single.getByText('Review patch', { exact: true }).click();
                    assert.equal(await single.locator('pre.code-file-diff').textContent(), fixtureDiff, `${pass}: Review shows the exact captured patch`);
                    const multi = card(p, 'Edit 2 files');
                    if (await multi.getAttribute('open') === null) await multi.locator('summary').first().click();
                    const missing = multi.locator('.code-file-entry').filter({ hasText: 'src/other.ts' });
                    // count() does not wait, and the opened body renders after the click.
                    await missing.first().waitFor();
                    assert.equal(await missing.count(), 1, `${pass}: the file without a patch is listed once`);
                    assert.match(await missing.innerText(), /Patch unavailable/, `${pass}: a missing patch says so`);
                    assert.equal(await missing.locator('details.code-file-review').count(), 0, `${pass}: no Review without a captured patch`);
                }
                const live = await waitSession(p, session.sessionId, 'idle');
                await checkCards('live');
                await p.screenshot({ path: join(manifest.evidenceDir, 'file-change-cards-live.png') });
                const changed = live.items.filter(item => item.kind === 'file_change');
                assert.equal(changed.length, 2, 'two semantic file changes are stored');
                assert.ok(live.items.some(item => item.kind === 'tool_call' && item.tool?.name === 'file change'),
                    'the legacy-shaped call stays a tool_call');
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await selectSession(p, historyTitle);
                await checkCards('replay');
                const replay = await waitSession(p, session.sessionId, 'idle');
                assert.deepEqual(replay.items.filter(item => item.kind === 'file_change'), changed, 'replay returns the same items');
                return { session: session.sessionId, diff: fixtureDiff };
            }, true);
            await step('reentry-restores-anchor-and-disclosure', async () => {
                assert.ok(history, 'History session admission is required for re-entry');
                const single = card(p, 'Edit src/app.ts');
                await single.waitFor();
                assert.equal(await single.getAttribute('open'), '', 'the file card was opened in the previous step');
                anchor = await scrollToMiddle(p);
                await reenter(p);
                await assertAnchor(p, anchor);
                // Return to the disclosure to check its state after the remount.
                const log = transcript(p); await log.focus(); await log.press('End');
                await single.waitFor();
                assert.equal(await single.getAttribute('open'), '', 'the opened file card is still open after re-entry');
                assert.equal(await single.locator('details.code-file-review').getAttribute('open'), '', 'its Review is still open');
                await single.scrollIntoViewIfNeeded();
                await p.screenshot({ path: join(manifest.evidenceDir, 'reentry-disclosure-open.png') });
                return { session: history.sessionId, firstVisibleRow: anchor };
            }, true);
            await step('reentry-following-returns-to-latest', async () => {
                assert.ok(history, 'History session admission is required for re-entry');
                await transcript(p).focus(); await transcript(p).press('End');
                await assertBottom(p); await reenter(p); await assertBottom(p);
                return { session: history.sessionId };
            }, true);
            await step('reentry-delayed-hydration-and-user-scroll-wins', async () => {
                assert.ok(history, 'History session admission is required for re-entry');
                anchor = await scrollToMiddle(p);
                const original = anchor;
                const sessionPath = `/api/code/sessions/${encodeURIComponent(history.sessionId)}`;
                let delayed = 0;
                const handler = async (route: import('playwright-core').Route) => {
                    const request = route.request(); const path = new URL(request.url()).pathname;
                    if (request.method() === 'GET' && (path === sessionPath || path === `${sessionPath}/items`)) {
                        delayed++; await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                    await route.continue().catch(() => undefined);
                };
                await p.route('**/api/code/sessions/**', handler);
                try {
                    await reenter(p);
                    assert.equal(await transcript(p).locator('[data-code-item-id]').count(), 0, 'Hydration must begin empty');
                    await assertAnchor(p, anchor);
                    assert.ok(delayed > 0, 'Snapshot or history was actually delayed');
                    await p.getByRole('tab', { name: 'Jaw', exact: true }).click();
                    await p.getByRole('tab', { name: 'Code', exact: true }).click();
                    const log = transcript(p); await log.waitFor();
                    // Wheel while the snapshot is withheld, then again as rows
                    // appear so the wheel has real geometry to scroll.
                    await log.hover(); await p.mouse.wheel(0, 450);
                    await log.locator('[data-code-transcript-idx]').first().waitFor();
                    await p.mouse.wheel(0, 450);
                    await p.waitForTimeout(500);
                    const wheeled = await firstVisible(p);
                    assert.ok(Math.abs(wheeled - anchor) > 1, `Wheel must change the saved anchor: ${anchor} -> ${wheeled}`);
                    await p.unroute('**/api/code/sessions/**', handler);
                    await reenter(p); await assertAnchor(p, wheeled);
                    anchor = wheeled;
                    return { delayedRequests: delayed, original, wheeled };
                } finally { await p.unroute('**/api/code/sessions/**', handler); }
            }, true);
            await step('reentry-session-isolation', async () => {
                assert.ok(history, 'History session admission is required for re-entry');
                await selectSession(p, 'Alpha Codex');
                await assertBottom(p);
                assert.equal(await transcript(p).locator('details.code-tool-card[open]').count(), 0,
                    'another session opens no row the history session opened');
                await reenter(p); await assertBottom(p);
                await selectSession(p, historyTitle);
                await assertAnchor(p, anchor);
                // Endpoint isolation cannot be activated by routing the instance
                // list: the Manager passes its own port to CodeCanvas regardless
                // of the selected instance, and the fixture supervises one worker.
                // The component tests cover two endpoint keys.
                return { other: 'Alpha Codex', history: history.sessionId, anchor };
            }, true);
            const koreanTitle = '네이티브 코드 작업 검토 — 긴 한국어 세션 제목과 좁은 화면에서의 승인 및 초안 보존 확인';
            const koreanDraft = '이 초안은 전송하지 않습니다. 좁은 화면에서도 한국어 문장과 긴 작업 설명이 잘리지 않고 읽히는지 확인해 주세요.\n'
                + '세션을 바꾸거나 테마를 전환해도 작성 중인 내용과 키보드 포커스가 올바르게 유지되어야 합니다.';
            let koreanSession!: CodeSessionInfo;
            const koreanReady = await step('korean-title-and-unsent-draft', async () => {
                await p.setViewportSize({ width: 1440, height: 1000 });
                await closeVisibleDrawer(p);
                await p.getByRole('tab', { name: 'Code', exact: true }).click();
                await setArchivedFilter(p, false);
                // This small independent session keeps geometry reachable even
                // when history or reload failed. It does not repair those cases.
                koreanSession = await createSession(p, 'Codex', 'qa:markdown Korean layout');
                await rename(p, 'qa:markdown Korean layout', koreanTitle);
                await p.getByRole('textbox', { name: 'Code prompt' }).fill(koreanDraft);
                await waitDraft(p, koreanDraft);
            }, true);
            for (const width of [1024, 768, 320]) for (const theme of ['light', 'dark'] as const) {
                    await step(`korean-${width}-${theme}-keyboard-reduced-motion`, async () => {
                        assert.ok(koreanReady, 'Korean session and draft setup is required for this geometry case');
                        // Set the real Manager theme control while its command bar
                        // is visible, then measure the target responsive layout.
                        await p.setViewportSize({ width: 1440, height: 1000 });
                        await p.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
                        await p.getByRole('button', { name: /^Theme:/ }).click();
                        await p.getByRole('menu', { name: 'Theme', exact: true })
                            .getByRole('menuitemradio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
                        await p.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
                        await p.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
                        await closeVisibleDrawer(p);
                        await waitDraft(p, koreanDraft);
                        assert.equal(await p.locator('.code-session-header .code-session-title').textContent(), koreanTitle);
                        const sendButton = p.getByRole('button', { name: 'Send prompt', exact: true });
                        const readSendColors = () => sendButton.evaluate(element => {
                            const style = getComputedStyle(element);
                            // Keep this serialized browser callback self-contained:
                            // tsx keepNames wraps nested named helpers in host __name.
                            const foregroundAlpha = /\/\s*([\d.]+)%?\s*\)$/.exec(style.color)
                                ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(style.color);
                            const backgroundAlpha = /\/\s*([\d.]+)%?\s*\)$/.exec(style.backgroundColor)
                                ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(style.backgroundColor);
                            return { enabled: !element.matches(':disabled'), hovered: element.matches(':hover'),
                                foreground: style.color, background: style.backgroundColor,
                                foregroundVisible: style.color !== 'transparent' && (foregroundAlpha === null || Number(foregroundAlpha[1]) > 0),
                                backgroundVisible: style.backgroundColor !== 'transparent' && (backgroundAlpha === null || Number(backgroundAlpha[1]) > 0) };
                        });
                        await p.mouse.move(0, 0);
                        const normalColors = await readSendColors();
                        await sendButton.hover();
                        const hoverColors = await readSendColors();
                        for (const [state, colors] of [['normal', normalColors], ['hover', hoverColors]] as const) {
                            assert.equal(colors.enabled, true, `${state}: ${JSON.stringify(colors)}`);
                            assert.equal(colors.hovered, state === 'hover', `${state}: ${JSON.stringify(colors)}`);
                            assert.ok(colors.foregroundVisible && colors.backgroundVisible, `${state}: ${JSON.stringify(colors)}`);
                            assert.notEqual(colors.foreground, colors.background, `${state}: ${JSON.stringify(colors)}`);
                        }
                        await p.mouse.move(0, 0);
                        const prompt = p.getByRole('textbox', { name: 'Code prompt', exact: true });
                        const dictation = p.getByRole('button', { name: 'Dictation', exact: true });
                        const dictationSupported = await p.evaluate(() =>
                            typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
                        assert.equal(await dictation.isEnabled(), dictationSupported);
                        await prompt.focus();
                        await p.keyboard.press('Tab');
                        // CodeComposer.tsx:74-85 places Dictation between the prompt and Send when supported.
                        if (dictationSupported) {
                            assert.equal(await dictation.evaluate(element => document.activeElement === element), true);
                            await p.keyboard.press('Tab');
                        }
                        const focus = await sendButton.evaluate(element => {
                            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
                            const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                            return { active: document.activeElement === element, visible: element.matches(':focus-visible'),
                                outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor,
                                unobscured: top !== null && element.contains(top), left: rect.left, right: rect.right,
                                top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
                        });
                        assert.ok(focus.active && focus.visible && focus.unobscured, JSON.stringify(focus));
                        assert.ok(focus.outline !== 'none' && parseFloat(focus.outlineWidth) > 0, JSON.stringify(focus));
                        assert.equal(focus.outline, 'solid', JSON.stringify(focus));
                        assert.equal(parseFloat(focus.outlineWidth), 2, JSON.stringify(focus));
                        assert.ok(focus.top >= 0 && focus.bottom <= focus.viewportHeight, JSON.stringify(focus));
                        // Reverse and replay the full tab path without activating either button.
                        await p.keyboard.press('Shift+Tab');
                        if (dictationSupported) {
                            assert.equal(await dictation.evaluate(element => document.activeElement === element), true);
                            await p.keyboard.press('Shift+Tab');
                        }
                        assert.equal(await prompt.evaluate(element => document.activeElement === element), true);
                        await p.keyboard.press('Tab');
                        if (dictationSupported) {
                            assert.equal(await dictation.evaluate(element => document.activeElement === element), true);
                            await p.keyboard.press('Tab');
                        }
                        assert.equal(await sendButton.evaluate(element => document.activeElement === element), true);
                        const motion = await p.locator('.code-canvas-main').evaluate(element => ({
                            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                            theme: document.documentElement.dataset.theme,
                            activeAnimations: element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
                            scrollBehavior: getComputedStyle(element).scrollBehavior,
                        }));
                        assert.equal(motion.reduced, true); assert.equal(motion.theme, theme);
                        assert.equal(motion.activeAnimations, 0); assert.equal(motion.scrollBehavior, 'auto');
                        return { sendColors: { normal: normalColors, hover: hoverColors }, focus, motion, layout: await containment(p, koreanSession) };
                    }, true);
            }
            await step('browser-errors-and-native-evidence', async () => {
                assert.deepEqual(errors, [], 'No uncaught rendered-app errors');
                return control(manifest, 'state');
            }, true);
            const failedSteps = results.filter(result => result.status === 'FAIL').map(result => ({ name: result.name, error: result.error }));
            assert.deepEqual(failedSteps, [], 'Independent scenarios continue for evidence; every recorded failure still fails the run');
        });
    } catch (error) { failure = error; }
    finally {
        const cleanupErrors: string[] = [];
        const clean = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { cleanupErrors.push(String(error)); } };
        if (context) await clean(() => context!.tracing.stop({ path: join(manifest.evidenceDir, 'trace.zip') }));
        if (context) await clean(() => context!.close());
        if (browser) await clean(() => browser!.close()); // Disconnect Main-owned CDP; never launch/kill Chrome.
        if (owned) {
            await clean(async () => { await writeFile(join(manifest.evidenceDir, 'provider-state.json'), JSON.stringify(await control(manifest, 'state'), null, 2)); });
            await clean(() => shutdownOwned(manifest));
        }
        await writeFile(join(manifest.evidenceDir, 'browser-evidence.json'), JSON.stringify({
            result: failure || cleanupErrors.length ? 'FAIL' : 'PASS', failure: failure ? String(failure) : null,
            steps: results, network, pageErrors: errors, cleanupErrors,
            notRun: ['Live provider processes/authentication', 'Local-file callback / desktop preview', 'Visual screenshot inspection by Main'],
        }, null, 2));
        if (!failure && cleanupErrors.length) failure = new Error(cleanupErrors.join('\n'));
    }
    if (failure) throw failure;
});
