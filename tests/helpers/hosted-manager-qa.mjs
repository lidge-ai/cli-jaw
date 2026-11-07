/** Manual hosted QA: one real Manager/fixture and owned Chromium at a time.
 * This executable is deliberately outside the ordinary test-file collector.
 * The internal runner observes node:test events; browser receipts are separate
 * evidence, and neither replaces owned process/listener shutdown.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
    openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const project = resolve(dirname(self), '../..');
const layoutNames = [
    'manager dashboard shell has measured layout coverage at critical viewports',
    'manager preview iframe survives Workbench tab changes',
    'manager preview header toggles and refreshes the iframe',
    'manager sidebar shell resizes, persists, resets, and collapses',
    'manager settings page has bounded layout and guarded keyboard close',
];
const phases = [
    { id: 'native-code', mode: 'code', file: 'tests/browser/code-native-workbench.test.ts',
        names: ['native Code workbench on isolated real Manager'], timeout: 330_000 },
    { id: 'retired-settings', mode: 'retired-settings', file: 'tests/browser/retired-runtime-settings.test.ts',
        names: ['retired saved runtime stays explicit in real Manager settings until user edits a local draft'], timeout: 240_000 },
    { id: 'manager-layout', mode: 'manager-layout', file: 'tests/browser/manager-layout-smoke.test.ts',
        names: layoutNames, timeout: 330_000 },
];
const nativeSteps = [
    'built-manager-isolation', 'create-two-providers-and-drafts', 'stream-sse-and-stop', 'approval-wide',
    'approval-mobile-390', 'rename-archive-restore-reload', 'markdown-math-and-virtual-rows-wide',
    'markdown-math-mobile-390', 'file-change-cards', 'reentry-restores-anchor-and-disclosure',
    'reentry-following-returns-to-latest', 'reentry-delayed-hydration-and-user-scroll-wins',
    'reentry-session-isolation', 'korean-title-and-unsent-draft',
    ...[1024, 768, 320].flatMap(width => ['light', 'dark'].map(theme => `korean-${width}-${theme}-keyboard-reduced-motion`)),
    'browser-errors-and-native-evidence',
];
const shellSizes = [[1440, 900], [1280, 800], [1024, 768], [756, 469], [390, 844]];
const settingsSizes = [1440, 1280, 1024, 1023, 390].map(width => [width, 900]);
const message = error => error instanceof Error ? error.stack || error.message : String(error);
const now = () => new Date().toISOString();
const delay = ms => new Promise(yes => setTimeout(yes, ms));
function json(file, value) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function within(root, file) {
    const rel = relative(root, file);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function exact(actual, expected, label) {
    assert.ok(Array.isArray(actual), `${label}: missing array`);
    assert.equal(new Set(actual).size, actual.length, `${label}: duplicate entries`);
    assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}
function empty(value, label) { assert.deepEqual(value, [], label); }
function artifact(root, file) {
    assert.equal(typeof file, 'string', 'missing artifact path');
    assert.ok(file.length > 0, 'empty artifact path');
    const target = resolve(root, file);
    assert.ok(within(root, target) && within(root, realpathSync(target)), `artifact escapes owner: ${file}`);
    assert.ok(lstatSync(target).isFile() && statSync(target).size > 0, `artifact missing/empty: ${file}`);
    return target;
}
function args() {
    const values = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        assert.ok(['--expected-sha', '--artifact-dir', '--run-file'].includes(key) && !Object.hasOwn(values, key), 'invalid argument');
        assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `missing ${key}`);
        values[key] = argv[i + 1];
    }
    assert.ok(isAbsolute(values['--artifact-dir'] || ''), 'explicit absolute artifact directory required');
    return values;
}

async function runFile(options) {
    const phase = phases.find(value => value.id === options['--run-file']);
    assert.ok(phase && Object.keys(options).length === 2, 'internal runner accepts one known phase');
    const dir = realpathSync(options['--artifact-dir']);
    const eventsFile = join(dir, 'test-events.jsonl');
    writeFileSync(eventsFile, '', { flag: 'wx' });
    const { run } = await import('node:test');
    const { spec } = await import('node:test/reporters');
    const absolute = join(project, phase.file);
    const seen = [], failures = [], skipped = [], unexpected = [];
    let summary = null;
    const stream = run({ files: [absolute], concurrency: 1, isolation: 'process', forceExit: false,
        execArgv: ['--import', import.meta.resolve('tsx'), '--experimental-test-module-mocks',
            '--import', pathToFileURL(join(project, 'tests/setup/test-home.ts')).href] });
    stream.on('data', event => {
        appendFileSync(eventsFile, JSON.stringify(event, (_key, value) => value instanceof Error
            ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value) + '\n');
        const data = event.data;
        if (event.type === 'test:summary') summary = data;
        if (event.type === 'test:fail') failures.push(data.name);
        if (event.type === 'test:pass' || event.type === 'test:fail') {
            if (data.skip || data.todo) skipped.push(data.name);
            if (phase.names.includes(data.name)) seen.push(data.name);
            else if (data.name !== absolute && data.name !== phase.file && data.details?.type !== 'suite') unexpected.push(data.name);
        }
    });
    let failure = null;
    try {
        // Consume one stream while also recording its events. Finish the reporter
        // before writing the terminal receipt; a truncated stream is not success.
        for await (const line of stream.compose(spec)) process.stdout.write(line);
        assert.ok(summary?.counts, 'missing node:test terminal summary');
        for (const key of ['failed', 'cancelled', 'skipped', 'todo']) assert.equal(summary.counts[key], 0, `summary ${key}`);
        exact(seen, phase.names, 'named test cases');
        empty(failures, 'test failures'); empty(skipped, 'skip/todo'); empty(unexpected, 'unexpected cases');
    } catch (error) { failure = message(error); }
    json(join(dir, 'counts.json'), { phase: phase.id, result: failure ? 'FAIL' : 'PASS', names: seen,
        failures, skipped, unexpected, summary, error: failure });
    if (failure) { process.stderr.write(failure + '\n'); process.exitCode = 1; }
}

// Linux process groups are created here, never discovered/adopted by port.
function proc(pid) {
    try {
        const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { pid: Number(pid), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTicks: fields[19] };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
function members(owner) {
    if (!owner.pid) return [];
    const current = proc(owner.pid);
    assert.ok(!current || !owner.startTicks || current.startTicks === owner.startTicks, 'owned PID was reused');
    const processes = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(proc).filter(Boolean);
    const selected = new Map();
    for (const value of processes) {
        let tagged = false;
        // Chromium crash handlers may establish a separate process group. The
        // fresh launch token also identifies inherited descendants after reparent.
        try { tagged = readFileSync(`/proc/${value.pid}/environ`).toString().split('\0').includes(`JAW_HOSTED_QA_OWNER=${owner.token}`); }
        catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
        if (value.group === owner.pid || owner.identities.get(value.pid) === value.startTicks || tagged) selected.set(value.pid, value);
    }
    let changed;
    do {
        changed = false;
        for (const value of processes) if (!selected.has(value.pid) && selected.has(value.parent)) {
            selected.set(value.pid, value); changed = true;
        }
    } while (changed);
    for (const value of selected.values()) owner.identities.set(value.pid, value.startTicks);
    return [...selected.values()];
}
function launch(label, command, argv, env, dir, owners) {
    const out = openSync(join(dir, `${label}.stdout.log`), 'wx');
    const err = openSync(join(dir, `${label}.stderr.log`), 'wx');
    let child;
    const token = randomUUID();
    try { child = spawn(command, argv, { cwd: project, env: { ...env, JAW_HOSTED_QA_OWNER: token }, detached: true, stdio: ['ignore', out, err] }); }
    finally { closeSync(out); closeSync(err); }
    const owner = { label, child, token, identities: new Map(), pid: child.pid, startTicks: child.pid ? proc(child.pid)?.startTicks : null,
        startedAt: now(), exited: false, code: null, signal: null, error: null };
    owner.exit = new Promise(yes => {
        child.once('error', error => { owner.error = message(error); owner.exited = true; yes(); });
        child.once('exit', (code, signal) => { owner.exited = true; owner.code = code; owner.signal = signal; yes(); });
    });
    owners.push(owner);
    return owner;
}
async function bounded(promise, ms, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_yes, no) => { timer = setTimeout(() => no(new Error(`${label} timed out`)), ms); })]); }
    finally { clearTimeout(timer); }
}
let interrupted = null;
let notifyInterruption;
const interruption = new Promise(yes => { notifyInterruption = yes; });
async function waitFor(label, fn, ms, owner) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        if (interrupted) throw new Error(interrupted);
        if (owner?.exited) throw new Error(`${label}: owned ${owner.label} exited: ${owner.error || owner.code}`);
        try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
        await delay(100);
    }
    throw new Error(`${label} timed out${last ? ': ' + message(last) : ''}`);
}
async function http(url, token, method = 'GET') {
    const response = await fetch(url, { method, ...(token ? { headers: { 'x-code-qa-token': token } } : {}),
        signal: AbortSignal.timeout(3_000) });
    const text = await response.text();
    assert.ok(text.length < 4 * 1024 * 1024, 'unexpected fixture response size');
    assert.equal(response.status, 200, `${method} ${url}: ${response.status} ${text.slice(0, 200)}`);
    return { response, text };
}
async function getJson(url, token, method) { return JSON.parse((await http(url, token, method)).text); }
async function reserve() {
    const servers = [], ports = [];
    try {
        for (let i = 0; i < 3; i++) {
            const server = net.createServer(); servers.push(server);
            await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
            ports.push(server.address().port);
        }
        return ports;
    } finally { await Promise.all(servers.filter(server => server.listening).map(server => new Promise(yes => server.close(yes)))); }
}
async function freePort(port) {
    const server = net.createServer();
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
    await new Promise(yes => server.close(yes));
}
function environment(root) {
    for (const name of ['home', 'tmp', 'config', 'cache', 'data']) mkdirSync(join(root, name), { recursive: true });
    assert.ok(process.env.PATH?.split(':').every(isAbsolute), 'approved absolute PATH required');
    return { PATH: process.env.PATH, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
        XDG_DATA_HOME: join(root, 'data'), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        NODE_OPTIONS: '', NO_COLOR: '1' };
}
async function stopOwned(owner, graceful) {
    const receipt = { label: owner.label, pid: owner.pid, startTicks: owner.startTicks, code: owner.code,
        signal: owner.signal, stopped: false, forced: false, errors: [], gracefulError: null, residual: [] };
    try {
        members(owner); // Capture descendants before asking the parent to exit.
        if (!owner.exited && graceful) {
            try { await bounded(graceful(), 5_000, `${owner.label} shutdown request`); }
            catch (error) { receipt.gracefulError = message(error); }
        }
        try {
            await bounded(owner.exit, graceful ? 20_000 : 1_000, `${owner.label} exit`);
            const until = Date.now() + 5_000;
            while (members(owner).length && Date.now() < until) await delay(100);
            assert.equal(members(owner).length, 0, `${owner.label} descendants remain`);
        } catch (error) {
            receipt.forced = true; receipt.errors.push(message(error));
            for (const signal of ['SIGTERM', 'SIGKILL']) {
                const remaining = members(owner);
                if (!remaining.length) break;
                for (const processInfo of remaining) {
                    const current = proc(processInfo.pid);
                    if (!current || current.startTicks !== processInfo.startTicks) continue;
                    try { process.kill(processInfo.pid, signal); }
                    catch (error) { if (error.code !== 'ESRCH') throw error; }
                }
                await delay(1_000);
            }
            await bounded(owner.exit, 3_000, `${owner.label} forced exit`);
        }
        receipt.residual = members(owner);
        receipt.stopped = owner.exited && receipt.residual.length === 0;
        receipt.code = owner.code; receipt.signal = owner.signal;
        if (owner.error) receipt.errors.push(owner.error);
        if (!receipt.stopped || owner.signal || owner.code === null || (owner.label !== 'runner' && owner.code !== 0)) {
            receipt.errors.push('owned process did not exit normally');
        }
    } catch (error) { receipt.errors.push(message(error)); }
    return receipt;
}
function validateManifest(file, phaseRoot, helper, phase, ports) {
    const value = readJson(file);
    assert.equal(value.version, 1); assert.equal(value.mode, phase.mode); assert.equal(value.pid, helper.pid);
    assert.equal(typeof value.token, 'string'); assert.ok(value.token);
    assert.ok(isAbsolute(value.root) && within(phaseRoot, realpathSync(value.root)));
    assert.equal(value.evidenceDir, join(value.root, 'evidence'));
    assert.equal(value.workspace, join(value.root, 'workspace'));
    assert.equal(value.workerPort, ports[0]); assert.equal(value.previewPort, ports[2]);
    assert.equal(value.managerUrl, `http://127.0.0.1:${ports[1]}/`);
    assert.equal(value.workerUrl, `http://127.0.0.1:${ports[0]}`);
    if (phase.mode === 'manager-layout') assert.match(value.workerDocumentNonce, /^[a-f0-9-]{36}$/);
    return value;
}
async function ready(manifest, helper, layout) {
    await waitFor('fixture owner', async () => {
        const state = await getJson(`${manifest.workerUrl}/__qa/state`, manifest.token);
        assert.equal(state.token, manifest.token); return true;
    }, 30_000, helper);
    const health = await waitFor('built Manager health', async () => {
        const value = await getJson(`${manifest.managerUrl}api/dashboard/health`);
        assert.equal(value.pid, helper.pid); assert.equal(value.rangeFrom, manifest.workerPort);
        assert.equal(value.rangeTo, manifest.workerPort); assert.equal(value.service, 'manager-dashboard'); return value;
    }, 30_000, helper);
    const html = await http(manifest.managerUrl);
    assert.equal(html.response.headers.get('x-jaw-manager-ui'), 'dist');
    if (!layout) return { health };
    const registryResponse = await fetch(`${manifest.managerUrl}api/dashboard/registry`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3_000),
        body: JSON.stringify({ ui: { locale: 'en', sidebarMode: 'instances', selectedPort: manifest.workerPort,
            selectedTab: 'overview', instanceSettingsOpen: false, sidebarCollapsed: false,
            activityDockCollapsed: true, dashboardShortcutsEnabled: true } }),
    });
    assert.equal(registryResponse.status, 200);
    const registry = await getJson(`${manifest.managerUrl}api/dashboard/registry`);
    assert.equal(registry.registry.ui.locale, 'en');
    assert.equal(registry.registry.ui.dashboardShortcutKeymap.toggleInstanceSettings, 'Meta+,');
    const scan = await waitFor('real Preview proxy', async () => {
        const value = await getJson(`${manifest.managerUrl}api/dashboard/instances?showHidden=1&fresh=1`);
        assert.deepEqual(value.instances.filter(row => row.ok).map(row => row.port), [manifest.workerPort]);
        empty(value.peerDashboards, 'no foreign Manager');
        const proxy = value.manager.proxy.preview.instances[String(manifest.workerPort)];
        assert.equal(proxy.status, 'ready'); assert.equal(proxy.previewPort, manifest.previewPort); return value;
    }, 30_000, helper);
    const preview = await http(`http://127.0.0.1:${manifest.previewPort}/0`);
    assert.equal(preview.response.headers.get('x-jaw-preview-proxy'), 'origin-port');
    assert.equal(preview.response.headers.get('x-jaw-preview-port'), String(manifest.previewPort));
    assert.equal(preview.response.headers.get('x-jaw-target-port'), String(manifest.workerPort));
    assert.match(preview.response.headers.get('content-type'), /text\/html/);
    assert.ok(preview.text.includes(`data-qa-worker="${manifest.workerDocumentNonce}"`));
    const settings = await getJson(`${manifest.managerUrl}i/${manifest.workerPort}/api/settings`);
    assert.equal(settings.tui.pasteCollapseLines, 2); assert.equal(settings.cli, 'codex-app');
    return { health, scan, previewHeaders: Object.fromEntries(preview.response.headers), registry: registry.registry.ui };
}

function validateBrowserEvidence(phase, manifest, screenshots) {
    const evidence = manifest.evidenceDir;
    const counts = readJson(join(screenshots, 'counts.json'));
    assert.equal(counts.result, 'PASS'); exact(counts.names, phase.names, 'runner case set');
    const provider = readJson(join(evidence, 'provider-events.json'));
    assert.equal(provider.exitCode, 0); assert.equal(provider.shutdownRequested, true);
    assert.ok(provider.handles.every(handle => handle.closed), 'unclosed native handle');
    if (phase.mode !== 'code') {
        empty(provider.handles, 'settings/layout must not open native providers');
        assert.equal(provider.workerRequestOverflow, false);
        empty(provider.workerRequests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method)), 'worker mutation attempts');
    }
    if (phase.mode === 'code') {
        const value = readJson(join(evidence, 'browser-evidence.json'));
        assert.equal(value.result, 'PASS'); exact(value.steps.map(row => row.name), nativeSteps, `native ${nativeSteps.length} steps`);
        empty(value.pageErrors, 'native page errors'); empty(value.cleanupErrors, 'native cleanup');
        for (const row of value.steps) {
            assert.equal(row.status, 'PASS'); assert.equal(row.capture.settled, true); artifact(evidence, row.screenshot);
        }
        artifact(evidence, 'trace.zip'); artifact(evidence, 'stop-pending.png'); artifact(evidence, 'approval-pending-390.png');
        artifact(evidence, 'provider-state.json');
        return { namedTests: 1, nativeSteps: nativeSteps.length };
    }
    if (phase.mode === 'retired-settings') {
        const value = readJson(join(evidence, 'retired-runtime-settings.json'));
        assert.equal(value.result, 'PASS');
        empty(value.browserWrites, 'retired browser writes'); empty(value.errors, 'retired page errors');
        empty(value.cleanupErrors, 'retired cleanup');
        const expected = [1440, 390].flatMap(width => ['active-runtime', 'available-choices', 'employee', 'flush', 'claude-local-draft', 'discard']
            .map(name => `retired-${width}-${name}`));
        exact(value.evidence.map(row => row.name), expected, 'retired checkpoint set');
        for (const row of value.evidence) {
            assert.equal(row.status, 'PASS'); artifact(evidence, row.screenshot);
            const width = Number(row.name.split('-')[1]);
            assert.deepEqual(row.viewport, { width, height: width === 390 ? 844 : 1000 });
        }
        for (const width of [1440, 390]) artifact(evidence, `retired-${width}-trace.zip`);
        return { namedTests: 1, retiredWidths: 2, retiredCheckpoints: 12 };
    }
    const value = readJson(join(screenshots, 'layout-evidence.json'));
    assert.equal(value.version, 1); assert.equal(value.result, 'PASS');
    assert.equal(value.workerNonce, manifest.workerDocumentNonce);
    exact(value.scenarios.map(row => row.name), layoutNames, 'layout five cases');
    for (const [index, name] of layoutNames.entries()) {
        const row = value.scenarios.find(row => row.name === name);
        assert.equal(row.status, 'PASS'); assert.equal(row.error, null); assert.equal(row.contextClosed, true);
        empty(row.pageErrors, 'layout page errors'); empty(row.cleanupErrors, 'layout cleanup');
        assert.ok(Array.isArray(row.requestFailures));
        empty(row.requestFailures.filter(row => row.error !== 'net::ERR_ABORTED'), 'unexpected layout request failures');
        assert.equal(row.screenshot, `layout-${index + 1}-final.png`);
        assert.equal(row.trace, `layout-${index + 1}-trace.zip`);
        artifact(screenshots, row.screenshot); artifact(screenshots, row.trace);
    }
    for (const [rows, sizes, prefix] of [[value.shellWidths, shellSizes, 'manager-layout-smoke'],
        [value.settingsWidths, settingsSizes, '060_settings-page']]) {
        exact(rows.map(row => `${row.width}x${row.height}`), sizes.map(([w, h]) => `${w}x${h}`), `${prefix} sizes`);
        for (const row of rows) {
            assert.equal(row.screenshot, `${prefix}-${row.width}x${row.height}.png`); artifact(screenshots, row.screenshot);
            assert.ok(row.metrics && typeof row.metrics === 'object', 'missing layout metrics');
        }
    }
    const document = proof => {
        assert.equal(proof.nonce, manifest.workerDocumentNonce);
        assert.match(proof.documentId, /^[a-f0-9-]{36}$/);
        const url = new URL(proof.src);
        assert.equal(url.origin, `http://127.0.0.1:${manifest.previewPort}`); assert.equal(url.pathname, '/0');
        assert.ok(provider.workerHtmlLoads.some(row => row.nonce === proof.nonce && row.documentId === proof.documentId), 'document absent from worker ledger');
    };
    const retained = value.preview.retention;
    document(retained.before);
    for (const proof of [retained.during, retained.afterBack, retained.afterPreview, ...retained.tabs]) {
        document(proof);
        assert.equal(proof.documentId, retained.before.documentId); assert.equal(proof.src, retained.before.src);
    }
    exact(retained.tabs.map(row => row.mode), ['Overview', 'Logs', 'Preview'], 'preview tab observations');
    const refreshed = value.preview.refresh;
    document(refreshed.before); document(refreshed.after);
    assert.equal(refreshed.before.src, refreshed.after.src); assert.notEqual(refreshed.before.documentId, refreshed.after.documentId);
    const observed = value.scenarios.find(row => row.name === layoutNames[4]).observations;
    for (const key of ['dirtyDismissed', 'acceptedBackOverview', 'shortcutReopened', 'shortcutClosed']) assert.equal(observed[key], true, key);
    return { namedTests: 5, layoutCases: 5, shellViewports: 5, settingsViewports: 5 };
}
function collectFixture(manifest, phaseRoot, output) {
    if (!manifest) return;
    const source = realpathSync(manifest.evidenceDir);
    assert.ok(within(phaseRoot, source), 'fixture evidence outside owned phase');
    const target = join(output, 'fixture'); mkdirSync(target);
    for (const name of readdirSync(source)) {
        if (!/\.(json|png|zip)$/.test(name)) continue;
        copyFileSync(artifact(source, name), join(target, name));
    }
}
async function executePhase(phase, runtimeRoot, output, chromium) {
    const root = join(runtimeRoot, phase.id), dir = join(output, phase.id);
    mkdirSync(root); mkdirSync(dir);
    const result = { phase: phase.id, result: 'INCOMPLETE', startedAt: now(), failure: null, cleanupErrors: [],
        counts: null, teardown: [], ports: [], manifest: null };
    json(join(dir, 'phase.json'), result);
    const owners = [];
    let manifest, helper, browserOwner, cdp;
    try {
        const helperEnv = environment(join(root, 'helper'));
        const ports = await reserve(); result.ports = ports;
        const manifestPath = join(root, 'manifest.json');
        helper = launch('fixture', process.execPath, ['--experimental-test-module-mocks', join(project, 'tests/helpers/code-native-qa-server.mjs')],
            { ...helperEnv, CODE_NATIVE_QA_MODE: phase.mode, CODE_NATIVE_QA_MANIFEST: manifestPath,
                DASHBOARD_SCAN_FROM: String(ports[0]), DASHBOARD_SCAN_COUNT: '1',
                DASHBOARD_PORT: String(ports[1]), DASHBOARD_PREVIEW_FROM: String(ports[2]) }, dir, owners);
        manifest = await waitFor('fixture manifest', () => existsSync(manifestPath)
            ? validateManifest(manifestPath, root, helper, phase, ports) : null, 30_000, helper);
        result.manifest = { ...manifest, token: '[owned ephemeral token omitted]' };
        json(join(dir, 'readiness.json'), await ready(manifest, helper, phase.mode === 'manager-layout'));
        const profile = join(root, 'chromium-profile'); mkdirSync(profile);
        browserOwner = launch('chromium', chromium.executablePath(), ['--headless=new', '--no-sandbox', '--enable-logging=stderr',
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
            environment(join(root, 'browser')), dir, owners);
        const active = join(profile, 'DevToolsActivePort');
        cdp = await waitFor('owned Chromium CDP', async () => {
            if (!existsSync(active)) return null;
            const [port, browserPath] = readFileSync(active, 'utf8').trim().split('\n');
            assert.match(port, /^\d+$/); assert.ok(Number(port) > 0 && Number(port) <= 65535);
            const url = `http://127.0.0.1:${port}`;
            const version = await getJson(`${url}/json/version`);
            assert.equal(new URL(version.webSocketDebuggerUrl).pathname, browserPath);
            json(join(dir, 'chromium.json'), { ...version, executable: chromium.executablePath(), pid: browserOwner.pid });
            return url;
        }, 30_000, browserOwner);
        result.ports.push(Number(new URL(cdp).port));
        const runner = launch('runner', process.execPath, [self, '--run-file', phase.id, '--artifact-dir', dir],
            { ...environment(join(root, 'runner')), CODE_NATIVE_QA_MANIFEST: manifestPath,
                MANAGER_BROWSER_CDP_URL: cdp, MANAGER_DASHBOARD_URL: manifest.managerUrl,
                MANAGER_SCREENSHOT_DIR: dir, ...(manifest.workerDocumentNonce
                    ? { MANAGER_QA_WORKER_NONCE: manifest.workerDocumentNonce } : {}) }, dir, owners);
        await bounded(Promise.race([runner.exit, interruption.then(() => { throw new Error(interrupted); })]), phase.timeout, `${phase.id} runner`);
        assert.equal(runner.error, null); assert.equal(runner.code, 0); assert.equal(runner.signal, null);
    } catch (error) { result.failure = message(error); }
    finally {
        // Runner contexts first, then Manager/providers/SSE/Preview, then the real
        // Chrome process. A test's CDP disconnect does not close owned Chrome.
        for (const owner of [...owners].sort((a, b) => ['runner', 'fixture', 'chromium'].indexOf(a.label) - ['runner', 'fixture', 'chromium'].indexOf(b.label))) {
            let graceful;
            if (owner === helper && manifest) graceful = () => getJson(`${manifest.workerUrl}/__qa/shutdown`, manifest.token, 'POST');
            if (owner === browserOwner && cdp) graceful = async () => {
                const connection = await chromium.connectOverCDP(cdp, { timeout: 3_000 });
                try { const session = await connection.newBrowserCDPSession(); await session.send('Browser.close'); }
                finally { await connection.close(); }
            };
            const stopped = await stopOwned(owner, graceful);
            result.teardown.push(stopped);
            if (stopped.forced || stopped.errors.length || !stopped.stopped) result.cleanupErrors.push(`${owner.label}: ${stopped.errors.join('; ')}`);
        }
        for (const port of result.ports) {
            try { await freePort(port); } catch (error) { result.cleanupErrors.push(`port ${port} remains occupied: ${message(error)}`); }
        }
        if (!result.failure && !result.cleanupErrors.length) {
            try { result.counts = validateBrowserEvidence(phase, manifest, dir); }
            catch (error) { result.failure = message(error); }
        }
        try { collectFixture(manifest, root, dir); } catch (error) { result.cleanupErrors.push(`artifact copy: ${message(error)}`); }
        result.endedAt = now(); result.result = result.failure || result.cleanupErrors.length ? 'FAIL' : 'PASS';
        result.quiescent = result.teardown.every(row => row.stopped) && !result.cleanupErrors.length;
        json(join(dir, 'teardown.json'), { quiescent: result.quiescent, processes: result.teardown,
            checkedPorts: result.ports, errors: result.cleanupErrors });
        json(join(dir, 'phase.json'), result);
    }
    return result;
}
function inventory(root) {
    // The workflow's tee owns this log until our process exits, including the
    // final banner below. Upload it, but never attest a still-writable digest.
    const excluded = [
        { path: 'supervisor.log', reason: 'Workflow tee remains active until the supervisor exits' },
        { path: 'artifact-inventory.json', reason: 'Inventory cannot hash its own final bytes' },
    ];
    const rows = [];
    function walk(dir) {
        for (const name of readdirSync(dir).sort()) {
            const file = join(dir, name);
            if (excluded.some(entry => entry.path === relative(root, file))) continue;
            const info = lstatSync(file);
            assert.ok(!info.isSymbolicLink(), 'artifact inventory contains symlink');
            if (info.isDirectory()) walk(file);
            else if (info.isFile()) rows.push({ path: relative(root, file), bytes: info.size,
                sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
        }
    }
    walk(root); return { version: 1, files: rows, excluded };
}
async function main(options) {
    assert.equal(Object.keys(options).length, 2, 'expected SHA and artifact directory required');
    assert.equal(process.platform, 'linux', 'hosted supervisor requires Linux process ownership observations');
    const output = realpathSync(options['--artifact-dir']);
    assert.ok(!within(project, output), 'artifacts must be outside checkout');
    const receipt = join(output, 'supervisor.json');
    assert.ok(!existsSync(receipt), 'refusing to reuse previous supervisor receipt');
    const report = { version: 1, result: 'INCOMPLETE', startedAt: now(), expectedSha: options['--expected-sha'],
        actualSha: null, node: process.version, platform: process.platform, phases: [], failure: null,
        notRun: ['Live provider authentication/inference', 'Full Classic worker rendering', 'Electron/macOS/Windows', 'Manual screenshot inspection'] };
    json(receipt, report);
    const signalHandler = signal => { interrupted = `supervisor received ${signal}`; notifyInterruption(); };
    const onTerm = () => signalHandler('SIGTERM'), onInt = () => signalHandler('SIGINT');
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    try {
        assert.match(report.expectedSha, /^[a-f0-9]{40}$/);
        const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
        report.actualSha = sha(); assert.equal(report.actualSha, report.expectedSha); assert.equal(process.env.GITHUB_SHA, report.expectedSha);
        for (const file of ['dist/src/manager/server.js', 'public/dist/manager/index.html', 'public/dist/.vite/manifest.json']) artifact(project, file);
        report.lockSha256 = createHash('sha256').update(readFileSync(join(project, 'package-lock.json'))).digest('hex');
        report.frontendManifestSha256 = createHash('sha256').update(readFileSync(join(project, 'public/dist/.vite/manifest.json'))).digest('hex');
        report.playwrightVersion = readJson(join(project, 'node_modules/playwright-core/package.json')).version;
        const { chromium } = await import('playwright-core');
        artifact(dirname(chromium.executablePath()), chromium.executablePath());
        // Chromium puts SingletonSocket below TMPDIR; long artifact paths exceed
        // Linux's 108-byte Unix socket address. Keep this exclusive runtime root
        // short while retaining all phase/home containment and artifact checks.
        const runtimeRoot = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'jaw-qa-')));
        report.runtimeRoot = runtimeRoot;
        for (const phase of phases) {
            if (interrupted || report.phases.some(row => !row.quiescent)) {
                report.phases.push({ phase: phase.id, result: 'NOT RUN', reason: interrupted || 'preceding teardown not proved' });
                continue;
            }
            const result = await executePhase(phase, runtimeRoot, output, chromium);
            report.phases.push(result); json(receipt, report);
        }
        assert.equal(sha(), report.actualSha, 'checkout moved during hosted QA');
        assert.ok(report.phases.length === 3 && report.phases.every(row => row.result === 'PASS'), 'all three phases must pass');
        report.totals = Object.fromEntries(['namedTests', 'nativeSteps', 'retiredWidths', 'retiredCheckpoints', 'layoutCases',
            'shellViewports', 'settingsViewports'].map(key => [key, report.phases.reduce((total, row) => total + (row.counts[key] || 0), 0)]));
        assert.deepEqual(report.totals, { namedTests: 7, nativeSteps: nativeSteps.length, retiredWidths: 2, retiredCheckpoints: 12,
            layoutCases: 5, shellViewports: 5, settingsViewports: 5 });
        report.result = 'PASS';
    } catch (error) { report.failure = message(error); report.result = 'FAIL'; }
    finally {
        report.endedAt = now(); json(receipt, report);
        try { json(join(output, 'artifact-inventory.json'), inventory(output)); }
        catch (error) { report.result = 'FAIL'; report.failure = `${report.failure || ''}\nartifact inventory: ${message(error)}`; json(receipt, report); }
        process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    }
    console.log(`[hosted-manager-qa] ${report.result}: ${receipt}`);
    if (report.result !== 'PASS') process.exitCode = 1;
}
try {
    const options = args();
    if (options['--run-file']) await runFile(options); else await main(options);
} catch (error) { console.error(message(error)); process.exitCode = 1; }
