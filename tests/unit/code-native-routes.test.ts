import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createWorkerApiJsonParser, createManagerApiJsonParser } from '../../src/routes/code-body-parser.ts';
import { registerCodeRoutes } from '../../src/routes/code.ts';
import { asyncHandler } from '../../src/http/async-handler.ts';
import { httpStatus } from '../../src/routes/_http-error.ts';
import { registerNativeCodeRoutes, type CodeRouteService } from '../../src/routes/code-native.ts';
import { CodeStore, CodeStoreError } from '../../src/code-mode/store.ts';
import { CodeServiceError } from '../../src/code-mode/session.ts';
import type { CodeSessionInfo } from '../../src/code-mode/wire.ts';

function fixture() {
    const session: CodeSessionInfo = {
        sessionId: 'session-one', provider: 'codex-app', cwd: tmpdir(), title: 'Fixture',
        model: 'fixture', effort: 'high', permissionMode: 'ask', status: 'idle', turnId: null,
        archivedAt: null, error: null, resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false,
            efforts: ['high'], permissionModes: ['ask', 'auto', 'read-only'] },
        epoch: 4, sequence: 7, revision: 2, createdAt: 1, lastUsedAt: 2, lastTurnCompletedAt: null, lastVisitedAt: null,
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let duplicate = false;
    const capture = (method: string, ...args: unknown[]) => calls.push({ method, args });
    const service: CodeRouteService = {
        create(input) { capture('create', input); return { ...session, ...input }; },
        list(input) { capture('list', input); return [session]; },
        snapshot(id) { capture('snapshot', id); return { session, items: [], sequence: 7, pendingPermissions: [], truncated: false }; },
        readEvents(...args) { capture('events', ...args); return { events: [], nextSequence: 7, throughSequence: 7, hasMore: false }; },
        history(...args) { capture('history', ...args); return { items: [], beforeSequence: null, sequence: 7, hasMore: false }; },
        prompt(id, input) {
            capture('prompt', id, input);
            return { duplicate, receipt: { turnId: 'turn-one', clientTurnKey: input.clientTurnKey, sequence: 8, status: 'accepted' } };
        },
        async steer(id, input) {
            capture('steer', id, input);
            return { duplicate, receipt: { turnId: input.turnId, clientTurnKey: input.clientTurnKey, sequence: 9, status: 'running' } };
        },
        async cancel(...args) { capture('cancel', ...args); return session; },
        async attach(id) { capture('attach', id); return session; },
        visit(id) { capture('visit', id); return { ...session, lastVisitedAt: 99 }; },
        async patch(id, input) { capture('patch', id, input); return { ...session, title: input.title ?? session.title }; },
        answerPermission(...args) { capture('permission', ...args); },
        models() { capture('models'); return { providers: [], defaultProvider: 'codex-app' }; },
    };
    return { session, calls, service, duplicate() { duplicate = true; } };
}

async function server<T>(
    run: (url: string, fixture: ReturnType<typeof fixture>, reads: () => number) => Promise<T>,
    prefix?: string,
    parserFactory: () => RequestHandler = createWorkerApiJsonParser,
): Promise<T> {
    const f = fixture();
    let reads = 0;
    const app = express();
    app.use(parserFactory());
    app.get('/legacy', (_req, res) => res.json({ legacy: true }));
    const requireAuth: RequestHandler = (req, res, next) => {
        if (req.headers.authorization !== 'Bearer fixture') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
        next();
    };
    registerCodeRoutes(app, requireAuth);
    registerNativeCodeRoutes(app, requireAuth, () => { reads++; return f.service; }, prefix);
    // Observe the selected generic parser or the intact stream left to a downstream owner.
    app.use(asyncHandler(async (req, res) => {
        if (req.body !== undefined) { res.json({ generic: true, body: req.body }); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        res.json({ generic: true, raw: Buffer.concat(chunks).toString('utf8') });
    }));
    const genericError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
        res.status(httpStatus(error, 500)).json({ genericError: true });
    };
    app.use(genericError);
    const http = app.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    try { return await run(`http://127.0.0.1:${address.port}${prefix ?? '/api/code'}`, f, () => reads); }
    finally {
        await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    }
}

function request(url: string, method = 'GET', body?: unknown) {
    return fetch(url, { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('authentication and malformed inputs cannot initialize the lazy Code host', async () => {
    await server(async (url, f, reads) => {
        assert.equal((await fetch(`${url}/models`)).status, 401);
        const cases: Array<[unknown, string]> = [
            [null, 'invalid_body'], [[], 'invalid_body'],
            [{ provider: '__proto__', cwd: tmpdir() }, 'invalid_provider'],
            [{ provider: 'codex-app', cwd: 'relative' }, 'absolute_cwd_required'],
            [{ provider: 'codex-app', cwd: import.meta.filename, model: 'default', permissionMode: 'ask' }, 'workspace_missing'],
            [{ provider: 'claude', cwd: tmpdir(), model: 'default', permissionMode: 'always-allow' }, 'invalid_permission_mode'],
            [{ provider: 'grok', cwd: tmpdir(), nativeCursor: 'forged' }, 'unknown_field'],
            [{ provider: 'claude', cwd: tmpdir() }, 'invalid_model'],
            [{ provider: 'claude', cwd: tmpdir(), model: 'default' }, 'invalid_permission_mode'],
        ];
        for (const [input, code] of cases) {
            const response = await request(`${url}/sessions`, 'POST', input);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, code);
        }
        const malformed = await fetch(`${url}/sessions`, { method: 'POST',
            headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{"broken":' });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid_body' });
        const oversized = await request(`${url}/sessions`, 'POST', { value: 'x'.repeat(6_295_552) });
        assert.equal(oversized.status, 413);
        assert.deepEqual(await oversized.json(), { ok: false, error: 'payload_too_large' });
        assert.equal(reads(), 0);
        assert.deepEqual(f.calls, []);
    });
});

test('all four providers cross the same typed creation boundary without changing selection', async () => {
    await server(async (url, f) => {
        for (const provider of ['codex-app', 'claude', 'cursor', 'grok']) {
            const input = { provider, cwd: tmpdir(), model: 'selected', effort: null, permissionMode: 'auto' };
            const response = await request(`${url}/sessions`, 'POST', input);
            assert.equal(response.status, 201);
            assert.equal((await response.json()).session.provider, provider);
            assert.deepEqual(f.calls.at(-1), { method: 'create', args: [{ ...input, cwd: realpathSync(tmpdir()) }] });
        }
    });
});

test('index, snapshot and replay reads preserve filters, caps and exact returned watermark', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions?scope=cwd`)).status, 400);
        assert.equal((await request(`${url}/sessions?archived=perhaps`)).status, 400);
        assert.equal((await request(`${url}/sessions?limit=0`)).status, 400);
        assert.equal((await request(`${url}/sessions?cursor=not-json`)).status, 400);
        assert.equal((await request(`${url}/sessions?offset=10`)).status, 400);
        assert.equal((await request(`${url}/sessions?offset=abc`)).status, 400);
        assert.equal((await request(`${url}/sessions?cursor=${encodeURIComponent('{"createdAt":-1,"sessionId":"s3"}')}`)).status, 400);
        const cursor = encodeURIComponent(JSON.stringify({ createdAt: 3, sessionId: 's3' }));
        const listing = await request(`${url}/sessions?cwd=${encodeURIComponent(tmpdir())}&archived=false&limit=25&cursor=${cursor}`);
        assert.equal(listing.status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'list', args: [{ cwd: realpathSync(tmpdir()), archived: false, limit: 25,
            cursor: { createdAt: 3, sessionId: 's3' } }] });
        assert.deepEqual(await listing.json(), { ok: true, sessions: [f.session], limit: 25, hasMore: false, nextCursor: null });
        assert.equal((await request(`${url}/sessions/session-one`)).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'snapshot');
        const events = await request(`${url}/sessions/session-one/events?afterSequence=7&limit=9000`);
        assert.deepEqual(await events.json(), { ok: true, events: [], nextSequence: 7, throughSequence: 7, hasMore: false });
        assert.deepEqual(f.calls.at(-1), { method: 'events', args: ['session-one', 7, 500] });
        assert.equal((await request(`${url}/sessions/session-one/events?afterSequence=-1`)).status, 400);
        assert.equal((await request(`${url}/sessions/session-one/events?afterSequence=1.5`)).status, 400);
        const history = await request(`${url}/sessions/session-one/items?beforeSequence=4&limit=20`);
        assert.deepEqual(await history.json(), { ok: true, items: [], beforeSequence: null, sequence: 7, hasMore: false });
        assert.deepEqual(f.calls.at(-1), { method: 'history', args: ['session-one', 4, 20] });
        assert.equal(f.calls.some(call => call.method === 'attach'), false);
    });
});

test('create and list share actual directory identity through aliases and trailing separators', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'code-route-alias-'));
    const target = join(parent, 'real workspace');
    const alias = join(parent, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = realpathSync(target);
    const database = new Database(':memory:');
    const store = new CodeStore(database);
    try {
        await server(async (url, f) => {
            f.service.create = input => store.create({ ...input, capabilities: f.session.capabilities }).session;
            f.service.list = options => store.list(options);
            const created = await request(`${url}/sessions`, 'POST', {
                provider: 'claude', cwd: alias, model: 'default', effort: null, permissionMode: 'ask',
            });
            assert.equal(created.status, 201);
            assert.equal((await created.json()).session.cwd, canonical);
            for (const path of [alias, alias + '/', canonical]) {
                const listed = await request(`${url}/sessions?cwd=${encodeURIComponent(path)}`);
                const data = await listed.json();
                assert.equal(data.sessions.length, 1);
                assert.equal(data.sessions[0].cwd, canonical);
            }
            rmSync(alias, { recursive: true, force: true });
            rmSync(target, { recursive: true });
            const history = await request(`${url}/sessions?cwd=${encodeURIComponent(canonical)}`);
            assert.equal((await history.json()).sessions.length, 1);
        });
    } finally { database.close(); rmSync(parent, { recursive: true, force: true }); }
});

test('prompt responses distinguish committed new admission from an existing receipt', async () => {
    await server(async (url, f) => {
        const input = { text: 'keep exact text\n', clientTurnKey: 'client-one' };
        let response = await request(`${url}/sessions/session-one/prompt`, 'POST', input);
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { ok: true, turnId: 'turn-one', clientTurnKey: 'client-one', sequence: 8, status: 'accepted' });
        f.duplicate();
        response = await request(`${url}/sessions/session-one/prompt`, 'POST', input);
        assert.equal(response.status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'prompt', args: ['session-one', input] });
        assert.equal((await request(`${url}/sessions/session-one/prompt`, 'POST', { ...input, provider: 'grok' })).status, 400);
        assert.equal((await request(`${url}/sessions/session-one/prompt`, 'POST', { text: ' ', clientTurnKey: 'other' })).status, 400);
    });
});

test('cleanup-pending readout crosses list, snapshot and cancel responses unchanged', async () => {
    await server(async (url, f) => {
        const pending = { ...f.session, cleanupPending: true };
        f.service.list = () => [pending];
        f.service.snapshot = () => ({ session: pending, items: [], sequence: 7, pendingPermissions: [], truncated: false });
        f.service.cancel = async () => pending;
        const listed = await (await request(`${url}/sessions`)).json();
        assert.equal(listed.sessions[0].cleanupPending, true);
        const snapshot = await (await request(`${url}/sessions/session-one`)).json();
        assert.equal(snapshot.session.cleanupPending, true);
        const cancelled = await (await request(`${url}/sessions/session-one/cancel`, 'POST', { turnId: 'turn-one', epoch: 4 })).json();
        assert.equal(cancelled.session.status, 'idle');
        assert.equal(cancelled.session.cleanupPending, true);
    });
});

test('cancel and permission answers keep captured owner and opaque choice unchanged', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions/session-one/cancel`, 'POST', { turnId: 'turn-one' })).status, 400);
        const cancel = { turnId: 'turn-one', epoch: 4 };
        assert.equal((await request(`${url}/sessions/session-one/cancel`, 'POST', cancel)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'cancel', args: ['session-one', cancel] });
        const answer = { sessionId: 'session-one', turnId: 'turn-one', epoch: 4, optionId: 'opaque:allow-once' };
        assert.equal((await request(`${url}/permissions/permission-one`, 'POST', answer)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'permission', args: ['permission-one', answer] });
        assert.equal((await request(`${url}/permissions/permission-one`, 'POST', { ...answer, optionId: null })).status, 400);
        f.service.answerPermission = () => { throw new CodeStoreError('stale_permission', 'Stale decision', 409); };
        const stale = await request(`${url}/permissions/permission-one`, 'POST', answer);
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { ok: false, error: 'stale_permission' });
    });
});

test('metadata conflicts return current public state without retrying or accepting immutable fields', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', { title: 'rename' })).status, 400);
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', { expectedRevision: 2, cwd: '/elsewhere' })).status, 400);
        const input = { expectedRevision: 2, title: 'Renamed' };
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', input)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'patch', args: ['session-one', input] });
        f.service.patch = async () => { throw new CodeStoreError('revision_conflict', 'Changed', 409); };
        const conflict = await request(`${url}/sessions/session-one`, 'PATCH', input);
        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), { ok: false, error: 'revision_conflict', session: f.session });
        assert.equal((await request(`${url}/sessions/session-one/attach`, 'POST', {})).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'attach');
        const visited = await request(`${url}/sessions/session-one/visit`, 'POST', {});
        assert.equal(visited.status, 200);
        assert.equal((await visited.json()).session.lastVisitedAt, 99);
        assert.deepEqual(f.calls.at(-1), { method: 'visit', args: ['session-one'] });
        assert.equal((await request(`${url}/sessions/session-one/visit`, 'POST', { extra: 1 })).status, 400);
    });
});

test('retired and unknown endpoints return JSON without initializing a runtime', async () => {
    await server(async (url, _f, reads) => {
        for (const path of ['/sessions/stored', '/model-assignments', '/model-presets']) {
            const response = await request(url + path);
            assert.equal(response.status, 410);
            assert.equal((await response.json()).error, 'code_endpoint_retired');
        }
        assert.equal((await request(`${url}/sessions/session-one/ext`, 'POST', { method: 'unsafe' })).status, 410);
        assert.equal((await request(`${url}/missing`)).status, 404);
        assert.equal(reads(), 0);
    });
});

test('final prefix serves native APIs and does not keep a removed staging alias', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/models`)).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'models');
        assert.equal((await request(`${url}/native/models`)).status, 404);
        f.service.models = () => { throw Object.assign(new Error('private diagnostic sentinel'), { code: 'persistence_failed', statusCode: 503 }); };
        const unavailable = await request(`${url}/models`);
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { ok: false, error: 'persistence_failed' });
    }, '/api/code');
});


function rawRequest(url: string, body: string, method = 'POST', authorization: string | null = 'Bearer fixture') {
    return fetch(url, { method, headers: { 'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }) }, body });
}

function paddedJson(input: unknown, bytes: number): string {
    const encoded = JSON.stringify(input);
    return encoded + ' '.repeat(bytes - Buffer.byteLength(encoded));
}

const hostParsers = [
    { name: 'worker', factory: createWorkerApiJsonParser, genericBytes: 1_048_576 },
    { name: 'manager', factory: createManagerApiJsonParser, genericBytes: 65_536 },
] as const;

for (const host of hostParsers) {
    test(`${host.name}: production parser admits 70k and maximally escaped decoded 1MiB prompts`, async () => {
        await server(async (url, f, reads) => {
            const ordinary = { text: 'x'.repeat(70_000), clientTurnKey: 'ordinary-key' };
            const response = await request(`${url}/sessions/session-one/prompt`, 'POST', ordinary);
            assert.equal(response.status, 202);
            await response.json();
            assert.deepEqual(f.calls, [{ method: 'prompt', args: ['session-one', ordinary] }]);

            // Build raw JSON escapes: JSON.stringify here would double the backslashes.
            const encoded = '{"text":"' + String.raw`\u0061`.repeat(1_048_576)
                + '","clientTurnKey":"' + String.raw`\u006b`.repeat(240) + '"}';
            assert.equal(Buffer.byteLength(encoded), 6_292_926);
            const maximal = await rawRequest(`${url}/sessions/session-one/prompt`, encoded);
            assert.equal(maximal.status, 202);
            await maximal.json();
            assert.deepEqual(f.calls[1], { method: 'prompt', args: ['session-one', {
                text: 'a'.repeat(1_048_576), clientTurnKey: 'k'.repeat(240),
            }] });
            assert.equal(f.calls.length, 2);
            assert.equal(reads(), 2);
        }, '/api/code', host.factory);
    });

    test(`${host.name}: decoded character and UTF-8 byte ceilings reject before lazy admission`, async () => {
        await server(async (url, f, reads) => {
            const escaped = '{"text":"' + String.raw`\u0061`.repeat(1_048_577) + '","clientTurnKey":"over"}';
            assert.ok(Buffer.byteLength(escaped) < 6_295_552, 'the envelope must reach the text validator');
            const multibyte = 'é'.repeat(524_288) + 'a';
            assert.ok(multibyte.length < 1_048_576, 'the character guard must not mask the UTF-8 guard');
            assert.equal(Buffer.byteLength(multibyte), 1_048_577);
            for (const encoded of [escaped, JSON.stringify({ text: multibyte, clientTurnKey: 'over-bytes' })]) {
                const response = await rawRequest(`${url}/sessions/session-one/prompt`, encoded);
                assert.equal(response.status, 400);
                assert.deepEqual(await response.json(), { ok: false, error: 'invalid_prompt' });
            }
            assert.equal(reads(), 0);
            assert.deepEqual(f.calls, []);
        }, '/api/code', host.factory);
    });

    test(`${host.name}: exact envelope ceiling is accepted and one more byte is rejected`, async () => {
        await server(async (url, f, reads) => {
            const input = { text: 'bounded input', clientTurnKey: 'envelope-key' };
            const encoded = paddedJson(input, 6_295_552);
            assert.equal(Buffer.byteLength(encoded), 6_295_552);
            const accepted = await rawRequest(`${url}/sessions/session-one/prompt`, encoded);
            assert.equal(accepted.status, 202);
            await accepted.json();
            assert.deepEqual(f.calls, [{ method: 'prompt', args: ['session-one', input] }]);
            const rejected = await rawRequest(`${url}/sessions/session-one/prompt`, encoded + ' ');
            assert.equal(rejected.status, 413);
            assert.deepEqual(await rejected.json(), { ok: false, error: 'payload_too_large' });
            assert.equal(reads(), 1, 'oversized input must not access the host');
            assert.equal(f.calls.length, 1);
        }, '/api/code', host.factory);
    });

    test(`${host.name}: malformed, unauthorized, retired and unknown requests never open Code`, async () => {
        await server(async (url, f, reads) => {
            for (const authorization of [null, 'Bearer wrong']) {
                const response = await rawRequest(`${url}/sessions/session-one/prompt`,
                    JSON.stringify({ text: 'valid prompt', clientTurnKey: 'unauthorized' }), 'POST', authorization);
                assert.equal(response.status, 401);
                assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
            }
            // Preserve parser-before-auth precedence, including unauthenticated bad JSON.
            for (const authorization of ['Bearer fixture', null]) {
                const malformed = await rawRequest(`${url}/sessions`, '{"broken":', 'POST', authorization);
                assert.equal(malformed.status, 400);
                assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid_body' });
            }
            for (const path of ['/sessions/stored', '/model-assignments', '/model-presets']) {
                const response = await request(url + path);
                assert.equal(response.status, 410);
                assert.deepEqual(await response.json(), { ok: false, error: 'code_endpoint_retired',
                    message: 'Use native Code sessions and session settings.' });
            }
            const retired = await request(`${url}/sessions/session-one/ext`, 'POST', { method: 'unsafe' });
            assert.equal(retired.status, 410);
            await retired.json();
            for (const path of ['/missing', '/native/models']) {
                const response = await request(url + path);
                assert.equal(response.status, 404);
                assert.deepEqual(await response.json(), { ok: false, error: 'code_route_not_found' });
            }
            assert.equal(reads(), 0);
            assert.deepEqual(f.calls, []);
        }, '/api/code', host.factory);
    });

    test(`${host.name}: exact Code prefix leaves generic envelope limits and errors unchanged`, async () => {
        await server(async (url, f, reads) => {
            const origin = new URL(url).origin;
            const input = { text: 'generic input' };
            const encoded = paddedJson(input, host.genericBytes);
            const accepted = await rawRequest(`${origin}/ordinary`, encoded);
            assert.equal(accepted.status, 200);
            assert.deepEqual(await accepted.json(), { generic: true, body: input });
            for (const path of ['/ordinary', '/api/codeevil', '/api/code-native', '/api/codex']) {
                const response = await rawRequest(origin + path, encoded + ' ');
                assert.equal(response.status, 413, path);
                assert.deepEqual(await response.json(), { genericError: true }, path);
            }
            for (const path of ['/api/code', '/api/code/', '/api/code?probe=1', '/API/CoDe/missing']) {
                const response = await rawRequest(origin + path, encoded + ' ');
                assert.equal(response.status, 404, path);
                assert.deepEqual(await response.json(), { ok: false, error: 'code_route_not_found' }, path);
            }
            // Workspace utilities remain before the native router's unknown-route handler.
            const workspace = await request(`${url}/git-info?cwd=relative`);
            assert.equal(workspace.status, 400);
            assert.deepEqual(await workspace.json(), { ok: false, error: 'absolute cwd required' });
            assert.equal(reads(), 0);
            assert.deepEqual(f.calls, []);
        }, '/api/code', host.factory);
    });
}

test('Manager production parser leaves proxy/browser/design streams to their existing owners', async () => {
    await server(async (url, f, reads) => {
        const origin = new URL(url).origin;
        const raw = 'not-json:'.repeat(8_000);
        assert.ok(Buffer.byteLength(raw) > 65_536);
        for (const [method, path] of [
            ['POST', '/i/4000/api/message'],
            ['POST', '/api/manager/embedded-browser/commands/task/result'],
            ['PUT', '/api/dashboard/design/pages/page/files/source.html'],
        ] as const) {
            const response = await rawRequest(origin + path, raw, method);
            assert.equal(response.status, 200, path);
            assert.deepEqual(await response.json(), { generic: true, raw }, path);
        }
        for (const [method, path] of [
            ['POST', '/i/not-a-port/api/message'],
            ['POST', '/api/manager/embedded-browser/commands-evil/result'],
            ['POST', '/api/dashboard/design/pages/page/files/source.html'],
            ['PUT', '/api/dashboard/design/pages/page/files-evil/source.html'],
        ] as const) {
            const response = await rawRequest(origin + path, raw, method);
            assert.equal(response.status, 413, path);
            assert.deepEqual(await response.json(), { genericError: true }, path);
        }
        assert.equal(reads(), 0);
        assert.deepEqual(f.calls, []);
    }, '/api/code', createManagerApiJsonParser);
});

test('POST and PATCH accept every Claude permission mode; provider fit is the manager\'s call', async () => {
    await server(async (url, f) => {
        for (const permissionMode of ['plan', 'accept-edits', 'dont-ask', 'auto-review']) {
            const created = await request(`${url}/sessions`, 'POST', { provider: 'claude', cwd: tmpdir(), model: 'default', permissionMode });
            assert.equal(created.status, 201, permissionMode);
            assert.equal((f.calls.at(-1)?.args[0] as { permissionMode?: string }).permissionMode, permissionMode);
            const patched = await request(`${url}/sessions/session-one`, 'PATCH', { expectedRevision: 2, permissionMode });
            assert.equal(patched.status, 200, permissionMode);
        }
    });
});

test('POST and PATCH carry a boolean thinking switch and refuse anything else', async () => {
    await server(async (url, f) => {
        const created = await request(`${url}/sessions`, 'POST', { provider: 'claude', cwd: tmpdir(), model: 'default', permissionMode: 'ask', thinking: false });
        assert.equal(created.status, 201);
        assert.equal((f.calls.at(-1)?.args[0] as { thinking?: boolean }).thinking, false);
        const bad = await request(`${url}/sessions`, 'POST', { provider: 'claude', cwd: tmpdir(), model: 'default', permissionMode: 'ask', thinking: 'on' });
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).error, 'invalid_thinking');
        const patched = await request(`${url}/sessions/session-one`, 'PATCH', { expectedRevision: 2, thinking: true });
        assert.equal(patched.status, 200);
        assert.equal((f.calls.at(-1)?.args[1] as { thinking?: boolean }).thinking, true);
        const badPatch = await request(`${url}/sessions/session-one`, 'PATCH', { expectedRevision: 2, thinking: 1 });
        assert.equal((await badPatch.json()).error, 'invalid_thinking');
    });
});

test('steer admits a follow-up for the captured turn and keeps every refusal a refusal', async () => {
    await server(async (url, f) => {
        const input = { text: 'also run the tests\n', clientTurnKey: 'steer-one', turnId: 'turn-one', epoch: 4 };
        let response = await request(`${url}/sessions/session-one/steer`, 'POST', input);
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { ok: true, turnId: 'turn-one', clientTurnKey: 'steer-one', sequence: 9, status: 'running' });
        assert.deepEqual(f.calls.at(-1), { method: 'steer', args: ['session-one', input] });
        f.duplicate();
        response = await request(`${url}/sessions/session-one/steer`, 'POST', input);
        assert.equal(response.status, 200);
        const calls = f.calls.length;
        for (const [body, code] of [
            [{ ...input, epoch: undefined }, 'invalid_epoch'], [{ ...input, epoch: 1.5 }, 'invalid_epoch'],
            [{ ...input, turnId: '' }, 'invalid_id'], [{ text: 'x', clientTurnKey: 'k', turnId: 't', epoch: 1, provider: 'grok' }, 'unknown_field'],
            [{ ...input, text: '  /compact now' }, 'steer_command_unsupported'], [{ ...input, text: ' ' }, 'invalid_prompt'],
            [{ ...input, text: 'é'.repeat(600_000) }, 'invalid_prompt'],
        ] as const) {
            const refused = await request(`${url}/sessions/session-one/steer`, 'POST', body);
            assert.equal(refused.status, 400);
            assert.equal((await refused.json()).error, code);
        }
        assert.equal(f.calls.length, calls, 'malformed follow-ups never reach the service');
        for (const [error, status] of [
            [new CodeStoreError('steer_queue_full', 'full', 409), 409], [new CodeStoreError('session_not_steerable', 'busy', 409), 409],
            [new CodeStoreError('stale_owner', 'stale', 409), 409], [new CodeStoreError('steer_in_flight', 'in flight', 409), 409],
            [new CodeStoreError('steer_key_spent', 'spent', 409), 409], [new CodeStoreError('turn_key_conflict', 'conflict', 409), 409],
            [new CodeStoreError('unsupported_capability', 'unsupported', 400), 400],
            [new CodeServiceError('steer_outcome_unknown', 'unknown'), 503], [new CodeServiceError('orphaned_turn', 'orphan'), 503],
        ] as const) {
            f.service.steer = async () => { throw error; };
            const refused = await request(`${url}/sessions/session-one/steer`, 'POST', input);
            assert.equal(refused.status, status);
            assert.deepEqual(await refused.json(), { ok: false, error: error.code });
        }
    });
});
