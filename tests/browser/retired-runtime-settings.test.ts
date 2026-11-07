/** Real built standalone instance Settings -> Agent, through the Manager /i/:port proxy.
 * Start code-native-qa-server.mjs with CODE_NATIVE_QA_MODE=retired-settings.
 * Required: CODE_NATIVE_QA_MANIFEST + existing MANAGER_BROWSER_CDP_URL.
 * The worker is a read-only fixture; no routes/DOM/components are intercepted.
 * Save is never clicked. Browser + server ledgers detect attempted auto-writes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { withManagerBrowserLock } from './manager-browser-test-lock';

type Manifest = { version: number; mode: string; token: string; pid: number; root: string;
    managerUrl: string; workerUrl: string; workerPort: number; evidenceDir: string };
type WorkerRequest = { method: string; path: string; at?: string };
type State = { token: string; handles: Array<{ closed: boolean }>; workerRequests: WorkerRequest[]; workerRequestOverflow: boolean };
type Evidence = { name: string; status: 'PASS' | 'FAIL'; screenshot: string;
    capturedAt: string; viewport: { width: number; height: number } | null; error?: string; detail?: unknown };

function readManifest(): Manifest {
    const file = process.env.CODE_NATIVE_QA_MANIFEST;
    assert.ok(file && isAbsolute(file), 'Explicit absolute CODE_NATIVE_QA_MANIFEST required');
    const value = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    assert.equal(value.version, 1); assert.equal(value.mode, 'retired-settings');
    assert.ok(value.token && Number.isInteger(value.pid));
    assert.equal(value.evidenceDir, join(value.root, 'evidence'));
    for (const target of [value.managerUrl, value.workerUrl]) {
        const url = new URL(target);
        assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.ok(url.port);
    }
    assert.equal(Number(new URL(value.workerUrl).port), value.workerPort);
    return value;
}
async function control(manifest: Manifest, command: string, method = 'GET'): Promise<State> {
    const response = await fetch(`${manifest.workerUrl}/__qa/${command}`, {
        method, headers: { 'x-code-qa-token': manifest.token }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${method} ${command}: ${body.slice(0, 4096)}`);
    return JSON.parse(body) as State;
}
function assertReadOnly(state: State, browserWrites: WorkerRequest[]) {
    assert.equal(state.workerRequestOverflow, false, 'Complete worker request evidence required');
    assert.deepEqual(browserWrites, [], 'No browser worker mutation, including automatic PUT');
    assert.deepEqual(state.workerRequests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)), [],
        'Read-only worker must receive no mutation attempts');
}
async function settleDrawer(page: Page) {
    const drawer = page.getByRole('dialog', { name: 'Instance drawer', exact: true });
    if (await drawer.isVisible()) await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => {
        const workspace = document.querySelector('.manager-workspace'), sidebar = document.querySelector('.manager-sidebar');
        if (!workspace || !sidebar || workspace.classList.contains('is-drawer-open')) return false;
        return (!matchMedia('(max-width: 1023px)').matches || sidebar.getBoundingClientRect().right <= 0.5)
            && [...workspace.getAnimations(), ...sidebar.getAnimations()].every(animation => animation.playState !== 'running' && !animation.pending);
    }, undefined, { timeout: 5_000 });
}
async function settleSettings(page: Page) {
    await page.locator('.settings-shell').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Agent', exact: true }).getAttribute('aria-current'), 'page');
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' && !animation.pending), undefined, { timeout: 5_000 });
}
async function choices(page: Page, label: string): Promise<string[]> {
    await page.getByRole('combobox', { name: `${label}: JWC (retired)`, exact: true }).click();
    const list = page.getByRole('listbox', { name: label, exact: true });
    await list.waitFor({ state: 'visible' });
    const more = list.getByRole('button', { name: /더 보기/ });
    if (await more.isVisible()) await more.click();
    const labels = (await list.getByRole('option').allTextContents()).map(text => text.trim());
    assert.ok(labels.includes('Claude'), `${label}: supported Claude choice must exist`);
    assert.ok(labels.every(text => !/jwc|jawcode/i.test(text)), `${label}: retired runtime must not be selectable: ${JSON.stringify(labels)}`);
    assert.equal(await list.locator('[role="option"][aria-selected="true"]').count(), 0, 'Missing value must not select a substitute');
    return labels;
}
async function closeChoices(page: Page, label: string): Promise<void> {
    // SelectField owns Escape. A failed close must be observed, not bypassed by
    // an outside/forced click before testing another control.
    await page.keyboard.press('Escape');
    await page.getByRole('listbox', { name: label, exact: true }).waitFor({ state: 'hidden' });
}
async function fieldLayout(grid: Locator, labels: string[], stacked: boolean) {
    const rows = await grid.evaluate(root => [...root.children].filter(field => field.classList.contains('settings-field')).map(field => {
        const label = field.querySelector('.settings-field-label');
        const control = field.querySelector(':scope > input, :scope > button[role="combobox"]');
        if (!label || !control) throw new Error('Expected a labelled nested settings control');
        const fieldBox = field.getBoundingClientRect(), labelBox = label.getBoundingClientRect(), controlBox = control.getBoundingClientRect();
        return { label: label.textContent?.trim(),
            field: { left: fieldBox.left, right: fieldBox.right },
            labelBox: { left: labelBox.left, right: labelBox.right, bottom: labelBox.bottom },
            control: { left: controlBox.left, right: controlBox.right, top: controlBox.top, bottom: controlBox.bottom,
                width: controlBox.width, height: controlBox.height } };
    }));
    assert.deepEqual(rows.map(row => row.label), labels);
    for (const row of rows) {
        assert.ok(row.control.width > 0 && row.control.height > 0, `${row.label}: control has a visible layout`);
        assert.ok(row.control.left >= row.field.left - 1 && row.control.right <= row.field.right + 1,
            `${row.label}: control stays inside its own field`);
        assert.ok(row.labelBox.left >= row.field.left - 1 && row.labelBox.right <= row.field.right + 1,
            `${row.label}: label stays inside its own field`);
        if (stacked) assert.ok(row.labelBox.bottom <= row.control.top + 1, `${row.label}: label is above its control`);
    }
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!.control, b = rows[j]!.control;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        assert.ok(overlapX <= 1 || overlapY <= 1, `${rows[i]!.label}/${rows[j]!.label}: controls must not overlap`);
    }
    return rows;
}
async function shutdown(manifest: Manifest) {
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
        const timer = setTimeout(() => finish(new Error('Owned Manager shutdown receipt timed out')), 20_000);
        watcher.on('error', finish);
    });
    const results = await Promise.allSettled([exited, control(manifest, 'shutdown', 'POST')]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const proof = JSON.parse(readFileSync(receipt, 'utf8')) as State & { exitCode: number; shutdownRequested: boolean };
    assert.equal(proof.exitCode, 0); assert.equal(proof.shutdownRequested, true);
    assert.equal(proof.handles.length, 0, 'Settings inspection must not open native providers');
    assertReadOnly(proof, []);
}

test('retired saved runtime stays explicit in real Manager settings until user edits a local draft', { timeout: 150_000 }, async () => {
    const manifest = readManifest();
    const evidence: Evidence[] = [];
    const browserWrites: WorkerRequest[] = [];
    const errors: string[] = [];
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let owned = false;
    let failure: unknown;
    async function capture(page: Page, name: string, detail?: unknown) {
        await settleSettings(page);
        const screenshot = join(manifest.evidenceDir, `${name}.png`);
        const capturedAt = new Date().toISOString();
        await page.screenshot({ path: screenshot, fullPage: false });
        evidence.push({ name, status: 'PASS', screenshot, capturedAt, viewport: page.viewportSize(), detail });
    }
    try {
        assert.equal((await control(manifest, 'state')).token, manifest.token); owned = true;
        const cdp = process.env.MANAGER_BROWSER_CDP_URL;
        assert.ok(cdp, 'Explicit Main-owned CDP required');
        await withManagerBrowserLock(async () => {
            browser = await chromium.connectOverCDP(cdp);
            for (const width of [1440, 390]) {
                context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
                const page = await context.newPage();
                page.setDefaultTimeout(15_000);
                page.on('pageerror', error => errors.push(error.message));
                context.on('request', request => {
                    const url = new URL(request.url());
                    const apiRequest = url.pathname.startsWith('/i/') || url.pathname.startsWith('/api/');
                    const managerSelection = request.method() === 'PATCH' && url.pathname === '/api/dashboard/registry';
                    if (apiRequest && !managerSelection && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
                        browserWrites.push({ method: request.method(), path: url.pathname });
                    }
                });
                await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
                try {
                    const requestStart = (await control(manifest, 'state')).workerRequests.length;
                    const healthResponse = await page.request.get(`${manifest.managerUrl}api/dashboard/health`);
                    const health = await healthResponse.json();
                    assert.equal(health.pid, manifest.pid); assert.equal(health.rangeFrom, manifest.workerPort); assert.equal(health.rangeTo, manifest.workerPort);
                    const response = await page.goto(manifest.managerUrl, { waitUntil: 'domcontentloaded' });
                    assert.equal(response?.headers()['x-jaw-manager-ui'], 'dist');
                    await page.locator('.dashboard-shell.manager-shell').waitFor({ state: 'visible' });
                    await page.evaluate(() => localStorage.setItem('jaw.previewEnabled', 'false'));
                    const selection = await page.request.patch(`${manifest.managerUrl}api/dashboard/registry`, { data: { ui: {
                        selectedPort: manifest.workerPort, selectedTab: 'overview', sidebarMode: 'instances', instanceSettingsOpen: false,
                        sidebarCollapsed: false, activityDockCollapsed: true, locale: 'en',
                    } } });
                    assert.equal(selection.status(), 200);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForFunction(async port => {
                        const response = await fetch('/api/dashboard/instances');
                        const body = await response.json();
                        return body.instances?.some((instance: { port: number; ok: boolean }) => instance.port === port && instance.ok);
                    }, manifest.workerPort);
                    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
                    await settleDrawer(page);
                    assert.equal(await page.getByRole('switch', { name: /Preview off/i }).getAttribute('aria-checked'), 'false');
                    await page.getByRole('button', { name: 'Instance settings', exact: true }).click();
                    await page.getByRole('status').filter({ hasText: 'Preview is off. Turn it on from the header to mount the iframe.' }).waitFor({ state: 'visible' });
                    assert.equal(await page.locator('.workbench-settings-page').count(), 0);
                    assert.equal(await page.locator('.settings-full-page').count(), 0);
                    assert.equal(await page.getByRole('button', { name: 'Dashboard settings', exact: true }).getAttribute('aria-pressed'), 'false');
                    assert.equal(await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Agent', exact: true }).count(), 0);
                    assertReadOnly(await control(manifest, 'state'), browserWrites);
                    await page.goto(`${manifest.managerUrl}i/${manifest.workerPort}/dist/settings/index.html`, { waitUntil: 'domcontentloaded' });
                    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Agent', exact: true }).click();
                    const active = page.getByRole('combobox', { name: 'Active CLI: JWC (retired)', exact: true });
                    await active.waitFor({ state: 'visible' });
                    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
                    await settleSettings(page);
                    await active.scrollIntoViewIfNeeded();
                    assert.equal(await active.getAttribute('aria-invalid'), 'true');
                    assert.equal(await page.getByRole('combobox', { name: /^Active model:/ }).isDisabled(), true);
                    assert.equal(await page.getByRole('combobox', { name: /^Effort:/ }).isDisabled(), true);
                    assert.equal(await page.getByRole('region', { name: 'Save changes', exact: true }).count(), 0, 'Loading retirement state must not create a local migration draft');
                    await capture(page, `retired-${width}-active-runtime`);
                    const activeChoices = await choices(page, 'Active CLI');
                    await capture(page, `retired-${width}-available-choices`, activeChoices);
                    await closeChoices(page, 'Active CLI');

                    const employee = page.getByRole('group', { name: 'Retired helper', exact: true });
                    await employee.scrollIntoViewIfNeeded();
                    await employee.getByRole('combobox', { name: 'CLI: JWC (retired)', exact: true }).waitFor({ state: 'visible' });
                    assert.equal(await employee.getByRole('combobox', { name: /^Model:/ }).isDisabled(), true);
                    const employeeLayout = await fieldLayout(employee.locator('.settings-runtime-employee-grid'), ['Name', 'CLI', 'Model', 'Role'], true);
                    const employeeChoices = await choices(page, 'CLI');
                    await closeChoices(page, 'CLI');
                    await capture(page, `retired-${width}-employee`, { choices: employeeChoices, fields: employeeLayout, escapeClosed: true });
                    await page.getByText('Flush runtime', { exact: true }).click();
                    const flush = page.getByRole('combobox', { name: 'Flush CLI: JWC (retired)', exact: true });
                    await flush.scrollIntoViewIfNeeded();
                    assert.equal(await page.getByRole('combobox', { name: /^Flush model:/ }).isDisabled(), true);
                    const flushLayout = await fieldLayout(page.locator('.settings-agent-flush .settings-agent-runtime-grid'), ['Flush CLI', 'Flush model'], false);
                    const flushChoices = await choices(page, 'Flush CLI');
                    await closeChoices(page, 'Flush CLI');
                    await capture(page, `retired-${width}-flush`, { choices: flushChoices, fields: flushLayout, escapeClosed: true });
                    assertReadOnly(await control(manifest, 'state'), browserWrites);

                    await active.scrollIntoViewIfNeeded();
                    await choices(page, 'Active CLI');
                    await page.getByRole('listbox', { name: 'Active CLI', exact: true }).getByRole('option', { name: 'Claude', exact: true }).click();
                    await page.getByRole('combobox', { name: 'Active CLI: Claude', exact: true }).waitFor({ state: 'visible' });
                    await page.getByRole('combobox', { name: 'Active model: qa-claude-settings', exact: true }).waitFor({ state: 'visible' });
                    await page.getByRole('region', { name: 'Save changes', exact: true }).waitFor({ state: 'visible' });
                    const savedResponse = await page.request.get(`${manifest.managerUrl}i/${manifest.workerPort}/api/settings`);
                    assert.equal(savedResponse.status(), 200);
                    const saved = await savedResponse.json();
                    assert.equal(saved.cli, 'jwc'); assert.equal(saved.perCli.jwc.model, 'qa-retired-model');
                    const state = await control(manifest, 'state');
                    assertReadOnly(state, browserWrites);
                    for (const path of ['/dist/settings/index.html', '/api/settings', '/api/cli-registry', '/api/cli-status', '/api/memory-files', '/api/employees']) {
                        assert.ok(state.workerRequests.slice(requestStart).some(request => request.method === 'GET' && request.path === path), `Real Manager must read ${path} at ${width}px`);
                    }
                    await capture(page, `retired-${width}-claude-local-draft`, { savedCli: saved.cli, workerRequests: state.workerRequests });
                    // Explicit local discard; never Save or a transport mutation.
                    await page.getByRole('region', { name: 'Save changes' }).getByRole('button', { name: 'Discard', exact: true }).click();
                    await active.waitFor({ state: 'visible' });
                    await page.getByRole('region', { name: 'Save changes', exact: true }).waitFor({ state: 'detached' });
                    assertReadOnly(await control(manifest, 'state'), browserWrites);
                    await capture(page, `retired-${width}-discard`);
                } catch (error) {
                    const screenshot = join(manifest.evidenceDir, `retired-${width}-failure.png`);
                    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => undefined);
                    evidence.push({ name: `retired-${width}`, status: 'FAIL', screenshot,
                        capturedAt: new Date().toISOString(), viewport: page.viewportSize(), error: String(error) });
                } finally {
                    await context.tracing.stop({ path: join(manifest.evidenceDir, `retired-${width}-trace.zip`) });
                    await context.close(); context = undefined;
                }
            }
            assertReadOnly(await control(manifest, 'state'), browserWrites);
            assert.deepEqual(errors, [], 'No uncaught Manager settings errors');
            assert.deepEqual(evidence.filter(row => row.status === 'FAIL'), [], 'Every viewport must pass');
        });
    } catch (error) { failure = error; }
    finally {
        const cleanupErrors: string[] = [];
        try { await context?.close(); } catch (error) { cleanupErrors.push(String(error)); }
        try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
        if (owned) try { await shutdown(manifest); } catch (error) { cleanupErrors.push(String(error)); }
        await writeFile(join(manifest.evidenceDir, 'retired-runtime-settings.json'), JSON.stringify({
            result: failure || cleanupErrors.length ? 'FAIL' : 'PASS', failure: failure ? String(failure) : null,
            evidence, browserWrites, errors, cleanupErrors, notRun: ['Save/persistence mutation', 'Real worker/provider authentication', 'Auth token path (fixture has no auth route; empty-token fallback)', 'Manual screenshot review'],
        }, null, 2));
        if (!failure && cleanupErrors.length) failure = new Error(cleanupErrors.join('\n'));
    }
    if (failure) throw failure;
});
