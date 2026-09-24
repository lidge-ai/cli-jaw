import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { syncAllInstances } from '../../src/manager/memory/embedding/sync.ts';
import type { VecStore } from '../../src/manager/memory/embedding/vec-store.ts';
import type { EmbeddingProvider } from '../../src/manager/memory/embedding/provider.ts';

function sourceDb(dir: string, name: string, chunks: number): string {
    const path = join(dir, `${name}.db`);
    const db = new Database(path);
    db.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, relpath TEXT, kind TEXT, content_hash TEXT, content TEXT, source_start_line INTEGER, source_end_line INTEGER)');
    const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= chunks; i++) insert.run(i, `f${i}.md`, 'md', `h${i}`, `chunk content number ${i}`, 1, 2);
    db.close();
    return path;
}

test('an aborted reindex stops scheduling batches and instances and stores nothing after abort', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'emb-sync-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const abort = new AbortController();
    let embedCalls = 0;
    let upserts = 0;
    const provider = {
        name: 'fake', model: 'fake', maxBatchSize: 1,
        embed: async (texts: string[]) => {
            embedCalls += 1;
            abort.abort();
            return texts.map(() => new Float32Array([0]));
        },
    } as unknown as EmbeddingProvider;
    const vecStore = {
        getExistingHashes: () => new Map(),
        deleteByRowid: () => {},
        upsertVec: () => { upserts += 1; },
    } as unknown as VecStore;

    const results = await syncAllInstances({
        instances: [
            { instanceId: 'a', dbPath: sourceDb(dir, 'a', 6), hasDb: true },
            { instanceId: 'b', dbPath: sourceDb(dir, 'b', 6), hasDb: true },
        ],
        vecStore, provider, batchSize: 1, concurrency: 1, signal: abort.signal,
    });

    assert.equal(embedCalls, 1, 'no batch is scheduled after abort');
    assert.equal(upserts, 0, 'embeddings returned after abort are not stored');
    assert.deepEqual(results.map(result => result.instanceId), ['a'], 'later instances are skipped');
});
