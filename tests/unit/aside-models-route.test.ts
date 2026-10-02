import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { AsideCatalogError, resolveAsideSelection, readAsideCatalog as readCatalog } from '../../src/agent/aside-catalog.ts';
import type { AsideCatalog, AsideContext } from '../../src/shared/aside-contract.ts';

const homeDir = await mkdtemp(join(tmpdir(), 'jaw-aside-route-'));
const secret = 'FIXTURE_PRIVATE_VALUE';
for (const [account, model] of [['0', 'first'], ['1', 'second']]) {
    const directory = join(homeDir, '.aside', 'u', account!);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'models.json'), JSON.stringify({ token: secret, providers: {
        fixture: { apiKey: secret, models: [{ id: model, thinkingLevelMap: { high: 'high' } }],
            accountModelCatalog: { modelIds: ['cached-only'] } },
    } }));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ token: secret,
        defaultModel: { provider: 'fixture', modelId: model, thinkingLevel: 'high' } }));
}
let reads = 0;
let unexpected = false;
mock.module('../../src/agent/aside-catalog.js', { namedExports: {
    AsideCatalogError, resolveAsideSelection,
    readAsideCatalog: async (context: AsideContext) => {
        reads++;
        if (unexpected) throw new Error(`${secret}: ${homeDir}`);
        return readCatalog(context, { homeDir });
    },
} });
// This route must not reach any CLI inventory or live-provider boundary.
mock.module('../../src/cli/registry-live.js', { namedExports: {
    buildLiveCliRegistry: async () => { throw new Error('unrelated inventory invoked'); },
} });
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const { settings } = await import('../../src/core/config.ts');
const beforeSettings = structuredClone(settings);
let writes = 0;
const app = express();
registerSettingsRoutes(app, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    next();
}, async () => { writes++; throw new Error('settings write invoked'); }, process.cwd());
const server = app.listen(0);
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}/api/aside/models`;
const request = (query: string, auth = true) => fetch(`${endpoint}${query}`, {
    headers: auth ? { authorization: 'Bearer fixture' } : {},
});
test.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
});

async function files(): Promise<Record<string, string>> {
    const data: Record<string, string> = {};
    for (const account of ['0', '1']) {
        const directory = join(homeDir, '.aside', 'u', account);
        for (const name of await readdir(directory)) data[`${account}/${name}`] = await readFile(join(directory, name), 'utf8');
    }
    return data;
}

test('Aside route executes the supplied auth wrapper before reading or parsing', async () => {
    const count = reads;
    const response = await request('?account=u0&host=local', false);
    assert.equal(response.status, 401);
    assert.equal(reads, count);
});

test('Aside route rejects missing, repeated, structured and unknown wire query fields without fallback', async () => {
    const count = reads;
    for (const query of ['', '?account=u0', '?host=local', '?account=&host=local',
        '?account=u0&host=', '?account=u0&account=u1&host=local', '?account=u0&host=local&host=local',
        '?account[]=u0&host=local', '?account[u]=u0&host=local', '?account=u0&host=local&path=/tmp',
        '?account=u0&host=local&homeDir=/tmp', '?account=u01&host=local', '?account=../0&host=local',
        '?account=u1234567890&host=local', '?account=%20u0&host=local']) {
        const response = await request(query);
        assert.equal(response.status, 400, query);
        assert.deepEqual(await response.json(), { ok: false, error: 'invalid_context' }, query);
    }
    const remote = await request('?account=u0&host=remote');
    assert.equal(remote.status, 400);
    assert.deepEqual(await remote.json(), { ok: false, error: 'unsupported_host' });
    assert.equal(reads, count);
});

test('Aside route returns the raw ok/data envelope and safe account-isolated catalog without persistence', async () => {
    const before = await files();
    for (const [account, model] of [['u0', 'first'], ['u1', 'second']]) {
        const response = await request(`?account=${account}&host=local`);
        assert.equal(response.status, 200);
        const body = await response.json() as { ok: boolean; data: AsideCatalog };
        assert.deepEqual(Object.keys(body).sort(), ['data', 'ok']);
        assert.equal(body.ok, true);
        assert.deepEqual(body.data.context, { account, host: 'local' });
        assert.equal(body.data.status, 'available');
        assert.deepEqual(body.data.entries.map(entry => entry.id), [`fixture/${model}`]);
        assert.equal(body.data.defaultModel, `fixture/${model}`);
        assert.equal(JSON.stringify(body).includes(secret), false);
        assert.equal(JSON.stringify(body).includes(homeDir), false);
    }
    assert.deepEqual(await files(), before);
    assert.deepEqual(settings, beforeSettings);
    assert.equal(writes, 0);
});

test('valid unavailable and partial catalogs stay HTTP 200 with diagnostics', async () => {
    const missing = await request('?account=u2&host=local');
    assert.equal(missing.status, 200);
    const body = await missing.json() as { ok: boolean; data: AsideCatalog };
    assert.equal(body.data.status, 'unavailable');
    assert.equal(body.data.defaultModel, null);
    await writeFile(join(homeDir, '.aside', 'u', '1', 'models.json'), '{invalid');
    const partial = await request('?account=u1&host=local');
    assert.equal(partial.status, 200);
    const broken = await partial.json() as { ok: boolean; data: AsideCatalog };
    assert.equal(broken.data.status, 'partial');
    assert.deepEqual(broken.data.entries, []);
    assert.equal(broken.data.diagnostics[0]?.code, 'malformed_catalog');
    assert.equal(writes, 0);
});

test('unexpected errors return a safe 500 code without exception detail', async () => {
    unexpected = true;
    try {
        const response = await request('?account=u0&host=local');
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { ok: false, error: 'read_failed' });
    } finally { unexpected = false; }
});
