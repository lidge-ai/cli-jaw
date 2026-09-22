import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import Database from 'better-sqlite3';
import express, { type RequestHandler } from 'express';
import { CodeSessionManager } from '../../src/code-mode/manager.ts';
import type { CodeProvider, CodeProviders } from '../../src/code-mode/provider.ts';
import { CodeStore } from '../../src/code-mode/store.ts';
import type { CodeProviderId, CodeWireEvent } from '../../src/code-mode/wire.ts';
import { createWorkerApiJsonParser } from '../../src/routes/code-body-parser.ts';
import { registerNativeCodeRoutes } from '../../src/routes/code-native.ts';

const capabilities = {
    resume: true, interrupt: true, permissions: true, setModelMidSession: false,
    efforts: ['low'], permissionModes: ['ask'] as Array<'ask'>,
};

test('archived prompt route replays matching receipts while rejecting conflicts and new keys without provider work or events', async t => {
    const database = new Database(':memory:');
    const store = new CodeStore(database, { now: () => 1234, newId: () => 'turn-one' });
    const created = store.create({ sessionId: 'session-one', provider: 'codex-app', cwd: '/workspace/a',
        title: null, model: 'model-a', effort: 'low', permissionMode: 'ask', capabilities });
    const admitted = store.admitTurn({ sessionId: created.session.sessionId, text: 'exact prompt', clientTurnKey: 'key-one' });
    const settled = store.settleTurn({ sessionId: created.session.sessionId, turnId: admitted.receipt.turnId,
        epoch: admitted.session.epoch }, { status: 'completed' });
    store.patchSession(created.session.sessionId, { expectedRevision: 0, archived: true });

    let providerOpens = 0;
    const fakeProvider = (id: CodeProviderId): CodeProvider => ({
        id,
        describe() { return { id, label: id, available: true, reason: null, models: ['model-a'],
            defaultModel: 'model-a', defaultEffort: 'low', modelSource: 'registry', capabilities }; },
        async open() { providerOpens += 1; throw new Error('duplicate receipt must not open a provider'); },
    });
    const providers: CodeProviders = {
        'codex-app': fakeProvider('codex-app'), claude: fakeProvider('claude'),
        cursor: fakeProvider('cursor'), grok: fakeProvider('grok'),
    };
    const published: CodeWireEvent[] = [];
    const manager = new CodeSessionManager({ store, providers, publish: event => published.push(event) });
    t.after(async () => { await manager.dispose(); database.close(); });

    const app = express();
    app.use(createWorkerApiJsonParser());
    const requireAuth: RequestHandler = (req, res, next) => {
        if (req.headers.authorization !== 'Bearer fixture') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
        next();
    };
    registerNativeCodeRoutes(app, requireAuth, () => manager);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const eventCount = store.readEvents(created.session.sessionId).events.length;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/code/sessions/session-one/prompt`, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'exact prompt', clientTurnKey: 'key-one' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ...settled.receipt });

    const conflict = await fetch(`http://127.0.0.1:${address.port}/api/code/sessions/session-one/prompt`, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'different prompt', clientTurnKey: 'key-one' }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { ok: false, error: 'turn_key_conflict' });

    const newKey = await fetch(`http://127.0.0.1:${address.port}/api/code/sessions/session-one/prompt`, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'new prompt', clientTurnKey: 'key-two' }),
    });
    assert.equal(newKey.status, 409);
    assert.deepEqual(await newKey.json(), { ok: false, error: 'session_archived' });
    assert.equal(providerOpens, 0);
    assert.deepEqual(published, []);
    assert.equal(store.readEvents(created.session.sessionId).events.length, eventCount);
});
