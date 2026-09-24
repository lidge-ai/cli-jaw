import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeHost } from '../../src/code-mode/host.ts';
import { CodeStore } from '../../src/code-mode/store.ts';
import type { CodeProviders } from '../../src/code-mode/provider.ts';
import type { CodeCapabilities, CodeProviderId } from '../../src/code-mode/wire.ts';

const capabilities: CodeCapabilities = {
    resume: true, interrupt: true, permissions: true, setModelMidSession: false,
    efforts: [], permissionModes: ['ask', 'auto'],
};

function providers(): { providers: CodeProviders; opens(): number } {
    let opens = 0;
    const one = (id: CodeProviderId) => ({
        id,
        describe: () => ({ id, label: id, available: true, reason: null, models: ['default'],
            defaultModel: 'default', defaultEffort: null, capabilities, modelSource: 'registry' as const }),
        async open() { opens++; throw new Error('No native process is needed by host read tests'); },
    });
    return { providers: { 'codex-app': one('codex-app'), claude: one('claude'), cursor: one('cursor'), grok: one('grok') }, opens: () => opens };
}

test('constructing or disposing an unused host cannot create storage or recover another process', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const fake = providers();
    const host = createCodeHost({ home, role: 'manager', port: 19001, providers: fake.providers });
    assert.deepEqual(readdirSync(home), []);
    await host.dispose();
    await host.dispose();
    assert.deepEqual(readdirSync(home), []);
    assert.equal(fake.opens(), 0);
    assert.throws(() => host.get(), { code: 'code_host_closed', statusCode: 503 });
});

test('lazy host recovery is isolated by role and port and never launches a provider', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const fake = providers();
    const workerPath = join(home, 'code-worker-19001.sqlite');
    const db = new Database(workerPath);
    const store = new CodeStore(db);
    const created = store.create({ sessionId: 'old', provider: 'codex-app', cwd: home, model: 'default',
        effort: null, permissionMode: 'ask', capabilities });
    store.admitTurn({ sessionId: created.session.sessionId, text: 'old accepted prompt', clientTurnKey: 'old-key' });
    db.close();
    const manager = createCodeHost({ home, role: 'manager', port: 19001, providers: fake.providers });
    const otherWorker = createCodeHost({ home, role: 'worker', port: 19002, providers: fake.providers });
    const worker = createCodeHost({ home, role: 'worker', port: 19001, providers: fake.providers });
    t.after(async () => {
        await Promise.all([manager.dispose(), otherWorker.dispose(), worker.dispose()]);
        rmSync(home, { recursive: true, force: true });
    });
    assert.deepEqual(manager.get().list(), []);
    assert.deepEqual(otherWorker.get().list(), []);
    const check = new Database(workerPath);
    assert.equal(new CodeStore(check).read('old')?.status, 'starting');
    check.close();
    assert.equal(worker.get().snapshot('old').session.status, 'failed');
    assert.equal(fake.opens(), 0);
    assert.ok(existsSync(join(home, 'code-manager-19001.sqlite')));
    assert.ok(existsSync(join(home, 'code-worker-19002.sqlite')));
});

test('catalog reads never prime provider inventory; prime() is the one-shot owner', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const fake = providers();
    let primes = 0;
    const host = createCodeHost({ home, role: 'worker', port: 19001, providers: fake.providers,
        primeLiveModels: async () => { primes += 1; } });
    t.after(async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); });
    // The read path below the HTTP layer: models() renders every catalog.
    assert.equal(host.get().models().providers.length, 4);
    assert.equal(primes, 0);
    assert.equal(fake.opens(), 0);
    await host.prime();
    await host.prime();
    assert.equal(primes, 1);
    assert.equal(fake.opens(), 0);
});

test('a failed prime keeps its receipt and never retries on a second activation', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const fake = providers();
    let primes = 0;
    const host = createCodeHost({ home, role: 'worker', port: 19001, providers: fake.providers,
        primeLiveModels: async () => { primes += 1; throw new Error('inventory unavailable'); } });
    t.after(async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); });
    await assert.rejects(host.prime(), { message: 'inventory unavailable' });
    await assert.rejects(host.prime(), { message: 'inventory unavailable' });
    assert.equal(primes, 1);
    // Failure does not poison the host: the registry catalogs still serve.
    assert.equal(host.get().models().providers.length, 4);
});

test('one host returns one manager and closes its database after disposal', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const fake = providers();
    const host = createCodeHost({ home, role: 'worker', port: 19001, providers: fake.providers });
    t.after(async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); });
    const manager = host.get();
    assert.equal(host.get(), manager);
    manager.create({ provider: 'claude', cwd: home, model: 'default', effort: null, permissionMode: 'ask' });
    assert.equal(manager.list().length, 1);
    await host.dispose();
    assert.throws(() => manager.list(), { code: 'manager_disposed' });
    assert.throws(() => host.get(), { code: 'code_host_closed' });
    const persisted = new Database(join(home, 'code-worker-19001.sqlite'));
    assert.equal(new CodeStore(persisted).list().length, 1);
    persisted.close();
    assert.equal(fake.opens(), 0);
});

test('ephemeral listener identity is resolved lazily rather than opening a port-zero store', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const fake = providers();
    let port = 0;
    let reads = 0;
    const host = createCodeHost({ home, role: 'worker', providers: fake.providers, port: () => { reads++; return port; } });
    t.after(async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); });
    assert.equal(reads, 0);
    assert.deepEqual(readdirSync(home), []);
    port = 19003;
    assert.deepEqual(host.get().list(), []);
    assert.equal(reads, 1);
    assert.ok(existsSync(join(home, 'code-worker-19003.sqlite')));
    assert.equal(existsSync(join(home, 'code-worker-0.sqlite')), false);
});

test('corrupt storage is rejected without replacing user bytes or creating fallback sessions', async t => {
    const home = mkdtempSync(join(tmpdir(), 'code-host-'));
    const file = join(home, 'code-worker-19001.sqlite');
    const original = Buffer.from('preserve this invalid SQLite file');
    writeFileSync(file, original);
    const fake = providers();
    const host = createCodeHost({ home, role: 'worker', port: 19001, providers: fake.providers });
    t.after(async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); });
    assert.throws(() => host.get());
    assert.deepEqual(readFileSync(file), original);
    assert.equal(fake.opens(), 0);
});
