/**
 * Standalone, built-Manager QA supervisor. No stateful production module is imported
 * before isolation; only the provider factory is mocked. Start with Node's
 * --experimental-test-module-mocks. W/M/P ports must be explicitly allocated by
 * the caller using DASHBOARD_SCAN_FROM / DASHBOARD_PORT / DASHBOARD_PREVIEW_FROM.
 * CODE_NATIVE_QA_MANIFEST must name a NEW absolute file outside the checkout.
 * The browser consumes that manifest and shuts down this owned server. Homes,
 * SQLite and evidence are retained for inspection, never automatically deleted.
 * Optional CODE_NATIVE_QA_MODE=retired-settings supplies read-only legacy worker
 * settings for the retirement browser suite. manager-layout serves owned worker
 * HTML through the real Manager Preview proxy; the default remains Code QA.
 */
import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = process.env.CODE_NATIVE_QA_MANIFEST;
const mode = process.env.CODE_NATIVE_QA_MODE ?? 'code'; // Capture before isolated env replaces inherited values.
if (!['code', 'retired-settings', 'manager-layout'].includes(mode)) throw new Error('Unsupported CODE_NATIVE_QA_MODE');
if (!manifestPath || !isAbsolute(manifestPath) || existsSync(manifestPath)) {
    throw new Error('CODE_NATIVE_QA_MANIFEST must be a new absolute file');
}
const parent = realpathSync(dirname(manifestPath));
const relativeParent = relative(project, parent);
if (relativeParent !== '..' && !relativeParent.startsWith(`..${sep}`) && !isAbsolute(relativeParent)) {
    throw new Error('Evidence must be outside the public checkout');
}
const built = suffix => pathToFileURL(join(project, 'dist', suffix)).href;
const html = ['manager/index.html', 'public/manager/index.html', 'manager.html']
    .map(suffix => join(project, 'public/dist', suffix)).find(existsSync);
if (!html || !existsSync(join(project, 'dist/src/manager/server.js'))) {
    throw new Error('Build Manager and server before starting this harness');
}
const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'jaw-code-native-qa-')));
const layout = {
    HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
    XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CLI_JAW_DASHBOARD_HOME: 'dashboard',
    CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi',
};
for (const suffix of [...Object.values(layout), 'worker', 'manager', 'workspace', 'evidence',
    'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps']) {
    mkdirSync(join(root, suffix), { recursive: true, mode: 0o700 });
}
const { readIsolatedQaPolicy, isolatedQaEnvironment } = await import(built('src/shared/isolated-qa.js'));
const candidate = {
    ...Object.fromEntries(Object.entries(layout).map(([key, suffix]) => [key, join(root, suffix)])),
    CLI_JAW_ISOLATED_QA_ROOT: root, CLI_JAW_HOME: join(root, 'manager'),
    DASHBOARD_SCAN_FROM: process.env.DASHBOARD_SCAN_FROM, DASHBOARD_SCAN_COUNT: '1',
    DASHBOARD_PORT: process.env.DASHBOARD_PORT, DASHBOARD_PREVIEW_FROM: process.env.DASHBOARD_PREVIEW_FROM,
};
const policy = readIsolatedQaPolicy(candidate, 'manager');
if (!policy) throw new Error('Isolation policy missing');
const clean = isolatedQaEnvironment(policy, { PATH: process.env.PATH, LANG: 'en_US.UTF-8' });
// Intentional controlled-launch boundary: HOME/CODEX_HOME/TMPDIR and the other
// reserved environment keys retain their policy-defined meaning, never scratch
// variables. Discard inherited provider credentials before Manager imports.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, clean);
readIsolatedQaPolicy(process.env, 'manager');
const workspace = join(root, 'workspace');
// Prevent normal short idle reaping from turning a warm-handle assertion into a
// wall-clock race. This is ordinary isolated-home configuration, not a code path.
writeFileSync(join(policy.jawHome, 'settings.json'), JSON.stringify({
    workingDir: workspace, locale: 'en', code: { maxConcurrentSessions: 4, idleReapMs: 3_600_000 },
}));

const token = randomUUID();
const handles = [];
const steps = [];
const workerRequests = [];
const workerHtmlLoads = [];
const workerDocumentNonce = mode === 'manager-layout' ? randomUUID() : undefined;
let workerRequestOverflow = false;
let shuttingDown = false;
const controls = new Map();
const labels = { 'codex-app': 'Codex', claude: 'Claude', cursor: 'Cursor', grok: 'Grok' };
const prose = '# Native QA result\n\n**Persisted Markdown** with inline math $x^2 + y^2 = z^2$.\n\n'
    + '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n'
    + '```typescript\nconst wide = "' + 'wide-column-'.repeat(55) + '";\n```\n\n'
    + '[Unsafe link](javascript:alert(1))\n\n<img src=x onerror="alert(1)">\n\nNative QA complete.';
function record(kind, detail = {}) { steps.push({ at: new Date().toISOString(), kind, ...detail }); }
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
function provider(id) {
    return {
        id,
        describe: () => ({ id, label: labels[id], available: true, reason: null,
            models: [`qa-${id}`], defaultModel: `qa-${id}`, defaultEffort: null, modelSource: 'native',
            capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false,
                efforts: id === 'cursor' ? [] : ['low', 'high'], permissionModes: id === 'grok' ? ['auto'] : ['ask', 'auto'] } }),
        async open(options) {
            const state = { provider: id, sessionId: options.sessionId, nativeSessionId: options.nativeCursor || `qa-native-${handles.length + 1}`,
                sends: 0, closed: false, cancelRequested: false, closeRequested: false, approval: null };
            handles.push(state);
            let current;
            let closeWork;
            const cancelGate = deferred();
            function releaseCancel() {
                cancelGate.resolve();
                current?.done.resolve({ status: 'stopped', finalText: null, partialText: current.partial });
            }
            const control = {
                advance() {
                    if (!current || current.kind !== 'hold' || !current.context.isCurrent()) throw new Error('No current held turn');
                    current.partial += ' Second deterministic chunk.';
                    current.observer.text('message', 'answer', ' Second deterministic chunk.', 'append', 'commentary');
                    record('stream-advanced', { sessionId: state.sessionId });
                },
                releaseCancel,
            };
            controls.set(state.sessionId, control);
            const handle = {
                nativeSessionId: state.nativeSessionId,
                get alive() { return !state.closed; },
                get closed() { return state.closed; },
                async send(text) {
                    if (state.closed) throw new Error('Fake resource already closed');
                    const context = options.getTurnContext();
                    const observer = options.transcript(context);
                    state.sends++;
                    options.onNativeCursor(state.nativeSessionId, context);
                    options.record(context, { kind: 'turn-start', provider: id });
                    const kind = text.startsWith('qa:hold') ? 'hold' : text.startsWith('qa:approval') ? 'approval'
                        : text.startsWith('qa:rows') ? 'rows' : text.startsWith('qa:file-change') ? 'file-change' : 'markdown';
                    current = { kind, context, observer, done: deferred(), partial: '' };
                    record('send', { sessionId: state.sessionId, nativeSessionId: state.nativeSessionId, scenarioKind: kind, turnId: context.turnId });
                    if (kind === 'hold') {
                        current.partial = 'First deterministic chunk.';
                        observer.text('message', 'answer', current.partial, 'replace', 'commentary');
                        observer.tool('held-tool', { name: 'Read fixture', input: 'owned workspace', status: 'running' }, {});
                        return current.done.promise;
                    }
                    if (kind === 'approval') {
                        const request = options.registry.open({ ...context, requestType: 'approval', cancelled: null,
                            view: { title: 'Read owned fixture?', fields: [{ id: 'decision', label: 'Only the isolated fixture is requested.',
                                options: [{ id: 'opaque-allow-17', label: 'Allow fixture once' }, { id: 'opaque-deny-29', label: 'Deny fixture' }],
                                multiSelect: false, allowFreeform: false }] },
                            validate(value) {
                                if (!value || !['opaque-allow-17', 'opaque-deny-29'].includes(value.optionId)) throw new Error('invalid_option');
                                return value.optionId;
                            }, isCurrent: context.isCurrent });
                        const answer = await request.answer;
                        state.approval = answer;
                        record('approval', { sessionId: state.sessionId, optionId: answer });
                        if (answer === null) return { status: 'stopped', finalText: null, partialText: '' };
                        const finalText = answer === 'opaque-allow-17' ? 'Fixture approved through RuntimeRequests.' : 'Fixture denied.';
                        observer.text('message', 'answer', finalText, 'replace', 'final');
                        return { status: 'done', finalText, partialText: '' };
                    }
                    if (kind === 'file-change') {
                        const changes = [{ path: join(workspace, 'src/app.ts'), kind: { type: 'update', move_path: null },
                            diff: '@@ -1 +1 @@\n-old\n+new\n' }];
                        observer.tool('legacy-fc', { name: 'file change', input: JSON.stringify(changes), inputStructured: true, status: 'done' }, {});
                        observer.tool('fc-one', { name: 'file change', semantic: 'file_change', fileChanges: changes, status: 'running' }, {});
                        observer.tool('fc-one', { status: 'done' }, {});
                        observer.tool('fc-multi', { name: 'file change', semantic: 'file_change', fileChanges: [
                            changes[0], { path: join(workspace, 'src/other.ts'), kind: { type: 'update', move_path: null } },
                        ], status: 'done' }, {});
                    }
                    if (kind === 'rows') {
                        // Real normalizer + CodeStore create every item. No API/history fixture.
                        for (let index = 0; index < 240; index++) observer.text('message', `row-${index}`,
                            `History row ${String(index).padStart(3, '0')} — deterministic retained content.`, 'replace', 'commentary');
                    }
                    observer.text('message', 'answer', prose, 'replace', 'final');
                    return { status: 'done', finalText: prose, partialText: '' };
                },
                async cancel() {
                    state.cancelRequested = true;
                    record('cancel-requested', { sessionId: state.sessionId });
                    if (current?.kind === 'hold' && !shuttingDown) await cancelGate.promise;
                    releaseCancel();
                },
                close() {
                    return closeWork ??= (async () => {
                        state.closeRequested = true;
                        if (current?.kind === 'hold' && state.cancelRequested && !shuttingDown) await cancelGate.promise;
                        releaseCancel();
                        state.closed = true;
                        record('closed-proof', { sessionId: state.sessionId, nativeSessionId: state.nativeSessionId });
                        options.onExit(null);
                    })();
                },
            };
            options.onResource(handle);
            record('open', { sessionId: state.sessionId, provider: id, nativeSessionId: state.nativeSessionId });
            return handle;
        },
    };
}
mock.module(built('src/code-mode/providers/catalog.js'), {
    namedExports: { createCodeProviders: () => Object.fromEntries(Object.keys(labels).map(id => [id, provider(id)])) },
});

const manifest = { version: 1, mode, token, pid: process.pid, root, workspace, managerUrl: policy.managerUrl,
    workerUrl: `http://127.0.0.1:${policy.workerPort}`, workerPort: policy.workerPort, previewPort: policy.previewPort,
    evidenceDir: join(root, 'evidence'), localFileCallback: false,
    ...(workerDocumentNonce ? { workerDocumentNonce } : {}) };
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
const worker = createServer((req, res) => {
    const url = new URL(req.url || '/', manifest.workerUrl);
    if (url.pathname.startsWith('/__qa/')) {
        if (req.headers['x-code-qa-token'] !== token) return json(res, 403, { error: 'wrong_qa_owner' });
        if (req.method === 'GET' && url.pathname === '/__qa/state') return json(res, 200, { token, handles, steps, workerRequests, workerRequestOverflow, workerHtmlLoads });
        if (req.method === 'POST' && url.pathname === '/__qa/shutdown') {
            json(res, 200, { ok: true });
            setImmediate(() => process.emit('SIGTERM'));
            return;
        }
        const match = /^\/__qa\/(advance|release-cancel)\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'POST' && match) {
            const control = controls.get(decodeURIComponent(match[2]));
            if (!control) return json(res, 404, { error: 'unknown_session' });
            try {
                if (match[1] === 'advance') control.advance(); else control.releaseCancel();
                return json(res, 200, { ok: true });
            } catch (error) { return json(res, 409, { error: String(error) }); }
        }
        return json(res, 404, { error: 'unknown_qa_command' });
    }
    if (mode !== 'code') {
        if (workerRequests.length < 2048) workerRequests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname });
        else workerRequestOverflow = true;
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'fake_worker_read_only' });
    if (mode !== 'code' && url.pathname === '/dist/settings/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(join(project, 'public/dist/settings/index.html')));
        return;
    }
    if (mode === 'manager-layout' && (url.pathname === '/0' || url.pathname === '/')) {
        const documentId = randomUUID();
        if (workerHtmlLoads.length < 2048) workerHtmlLoads.push({
            path: url.pathname, at: new Date().toISOString(), nonce: workerDocumentNonce, documentId,
        });
        else workerRequestOverflow = true;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned layout worker</title><body><main data-qa-worker="${workerDocumentNonce}" data-qa-document-id="${documentId}" data-qa-settings-open-count="0">Owned layout worker</main><script>window.addEventListener('message', event => { if (event.data?.type === 'jaw-preview-settings-open') { const marker = document.querySelector('main'); marker.dataset.qaSettingsOpenCount = String(Number(marker.dataset.qaSettingsOpenCount) + 1); } });</script></body></html>`);
        return;
    }
    if (mode === 'manager-layout' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': isolated worker connected\n\n');
        return;
    }
    const responses = {
        '/api/health': { ok: true, version: 'qa-fixture', uptime: 1 },
        '/api/settings': { jawHome: join(root, 'worker'), workingDir: workspace, projectDirs: [workspace], cli: 'codex-app',
            model: 'qa-codex-app', locale: 'en', multiSession: { enabled: false }, messaging: { enabledChannels: [], homeChannel: null } },
        '/api/runtime': { cli: 'codex-app', model: 'qa-codex-app', status: 'idle' },
        '/api/status': { status: 'idle', busy: false }, '/api/sessions': { sessions: [] },
        '/api/messages': { messages: [] },
    };
    if (mode === 'manager-layout') Object.assign(responses, {
        '/api/settings': { ...responses['/api/settings'], port: policy.workerPort, permissions: 'auto', runtimeDefaultMigration: null,
            activeOverrides: {}, perCli: { 'codex-app': { model: 'qa-codex-app', effort: 'medium' } },
            presentation: { mode: 'activity' }, tui: { pasteCollapseLines: 2, pasteCollapseChars: 160,
                keymapPreset: 'default', diffStyle: 'summary', themeSeed: 'jaw-default' } },
        '/api/cli-registry': { ok: true, data: {
            'codex-app': { label: 'Codex App', models: ['qa-codex-app'], efforts: ['medium', 'high'] },
            claude: { label: 'Claude', models: ['qa-claude'], efforts: ['low', 'high'] },
        } },
        '/api/cli-status': Object.fromEntries(['codex-app', 'claude'].map(cli => [cli, {
            available: true, capabilityReady: true, checkedCapability: 'print', probeState: 'fresh',
        }])),
        '/api/memory-files': { cli: 'codex-app', model: 'qa-codex-app' },
        '/api/employees': { ok: true, data: [] },
    });
    if (mode === 'retired-settings') Object.assign(responses, {
        '/api/settings': { ...responses['/api/settings'], port: policy.workerPort, cli: 'jwc', model: 'qa-retired-model', permissions: 'auto',
            runtimeDefaultMigration: null, activeOverrides: {},
            perCli: { jwc: { model: 'qa-retired-model', effort: 'high' },
                claude: { model: 'qa-claude-settings', effort: 'low' },
                'codex-app': { model: 'qa-codex-settings', effort: 'medium' } } },
        '/api/runtime': { cli: 'jwc', model: 'qa-retired-model', status: 'idle' },
        '/api/cli-registry': { ok: true, data: {
            jwc: { label: 'JWC legacy registry', models: ['qa-retired-model'], efforts: ['high'] },
            claude: { label: 'Claude', models: ['qa-claude-settings'], efforts: ['low', 'high'] },
            'codex-app': { label: 'Codex App', models: ['qa-codex-settings'], efforts: ['medium', 'high'] },
        } },
        '/api/cli-status': Object.fromEntries(['jwc', 'claude', 'codex-app'].map(cli => [cli, {
            available: cli !== 'jwc', capabilityReady: cli !== 'jwc', checkedCapability: 'print', probeState: 'fresh',
        }])),
        '/api/memory-files': { cli: 'jwc', model: 'qa-retired-model' },
        '/api/employees': { ok: true, data: [{ id: 'qa-retired-employee', name: 'Retired helper', cli: 'jwc',
            model: 'qa-retired-model', role: 'Read-only QA fixture', source: 'db', status: 'idle' }] },
    });
    return json(res, Object.hasOwn(responses, url.pathname) ? 200 : 404, responses[url.pathname] || { error: 'unsupported_fixture_read' });
});
async function listen(server, port) {
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
}
const managerReservation = createPortReservation();
const previewReservation = createPortReservation();
function beginShutdown() {
    shuttingDown = true;
    for (const control of controls.values()) control.releaseCancel();
    worker.closeAllConnections(); worker.close();
    if (previewReservation.listening) previewReservation.close();
}
process.prependOnceListener('SIGTERM', beginShutdown);
process.prependOnceListener('SIGINT', beginShutdown);
process.on('exit', exitCode => {
    const receipt = join(root, 'evidence', 'provider-events.json');
    writeFileSync(`${receipt}.tmp`, JSON.stringify({ exitCode, shutdownRequested: shuttingDown, handles, steps, workerRequests, workerRequestOverflow, workerHtmlLoads }, null, 2));
    renameSync(`${receipt}.tmp`, receipt);
});
try {
    // Fail closed on occupied ports; never scan/adopt the occupant. Only layout
    // releases P for the actual Manager proxy. Other modes retain their reservation.
    await listen(worker, policy.workerPort);
    await listen(managerReservation, policy.managerPort);
    await listen(previewReservation, policy.previewPort);
    if (mode === 'manager-layout') {
        await new Promise((yes, no) => previewReservation.close(error => error ? no(error) : yes()));
    }
    await new Promise((yes, no) => managerReservation.close(error => error ? no(error) : yes()));
    await import(built('src/manager/server.js'));
    // Published only after imports succeed. Browser separately verifies live health,
    // exact PID, scan range and x-jaw-manager-ui=dist before sending any mutations.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`CODE_NATIVE_QA_MANIFEST=${manifestPath}`);
    console.log(`CODE_NATIVE_QA_EVIDENCE=${manifest.evidenceDir}`);
} catch (error) {
    beginShutdown();
    if (managerReservation.listening) managerReservation.close();
    console.error('[code-native-qa] startup failed', error);
    process.exit(1);
}
