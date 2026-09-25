import type { EmbeddingProvider } from './provider.js';
import { type VecStore } from './vec-store.js';
import Database from 'better-sqlite3';

export interface SyncResult {
  instanceId: string;
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: string[];
}

export interface SyncOptions {
  instances: Array<{ instanceId: string; dbPath: string; hasDb: boolean }>;
  vecStore: VecStore;
  provider: EmbeddingProvider;
  batchSize?: number;
  concurrency?: number;
  onProgress?: (instanceId: string, done: number, total: number) => void;
  /** Stops scheduling instances and batches; embeddings already requested are not stored. */
  signal?: AbortSignal;
}

interface ChunkRow {
  id: number;
  relpath: string;
  kind: string;
  content_hash: string;
  content: string;
  source_start_line: number;
  source_end_line: number;
}

export async function syncAllInstances(opts: SyncOptions): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const inst of opts.instances) {
    if (opts.signal?.aborted) break;
    if (!inst.hasDb) continue;
    try {
      const r = await syncInstance(inst.instanceId, inst.dbPath, opts);
      results.push(r);
    } catch (err) {
      results.push({
        instanceId: inst.instanceId,
        added: 0, updated: 0, deleted: 0, skipped: 0,
        errors: [String(err)],
      });
    }
  }
  return results;
}

async function syncInstance(
  instanceId: string,
  dbPath: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const srcDb = new Database(dbPath, { readonly: true });
  srcDb.pragma('busy_timeout = 3000');

  const result: SyncResult = { instanceId, added: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? opts.provider.maxBatchSize));

  try {
    const existingMap = opts.vecStore.getExistingHashes(instanceId);
    const srcChunks = srcDb.prepare(
      'SELECT id, relpath, kind, content_hash, content, source_start_line, source_end_line FROM chunks'
    ).all() as ChunkRow[];

    const srcIds = new Set<number>();
    const toEmbed: Array<{ chunk: ChunkRow; existingRowid: number | null }> = [];

    for (const chunk of srcChunks) {
      srcIds.add(chunk.id);
      const existing = existingMap.get(chunk.id);

      if (existing && existing.contentHash === chunk.content_hash) {
        result.skipped++;
        continue;
      }

      if (!chunk.content || chunk.content.trim().length < 10) {
        result.skipped++;
        continue;
      }

      toEmbed.push({
        chunk,
        existingRowid: existing ? existing.rowid : null,
      });
    }

    // Delete orphans (chunks removed from source)
    for (const [chunkId, meta] of existingMap) {
      if (!srcIds.has(chunkId)) {
        opts.vecStore.deleteByRowid(meta.rowid);
        result.deleted++;
      }
    }

    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 2));
    const batches: Array<{ start: number; items: typeof toEmbed }> = [];
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      batches.push({ start: i, items: toEmbed.slice(i, i + batchSize) });
    }

    let completed = 0;
    async function processBatch(batch: typeof batches[0]): Promise<void> {
      try {
        const texts = batch.items.map(b => b.chunk.content);
        let embeddings: Float32Array[];
        try {
          embeddings = await opts.provider.embed(texts);
        } catch {
          await new Promise(r => setTimeout(r, 1000));
          try {
            embeddings = await opts.provider.embed(texts);
          } catch (retryErr) {
            result.errors.push(`Batch ${batch.start}-${batch.start + batch.items.length}: ${String(retryErr)}`);
            return;
          }
        }

        if (opts.signal?.aborted) return;

        if (embeddings.length !== batch.items.length) {
          result.errors.push(`Batch ${batch.start}: expected ${batch.items.length} embeddings, got ${embeddings.length}`);
          return;
        }

        for (let j = 0; j < batch.items.length; j++) {
          const item = batch.items[j]!;
          const embedding = embeddings[j]!;
          opts.vecStore.upsertVec(
            item.existingRowid,
            {
              chunkId: item.chunk.id,
              instanceId,
              relpath: item.chunk.relpath,
              kind: item.chunk.kind,
              contentHash: item.chunk.content_hash,
              snippet: item.chunk.content.slice(0, 700),
              sourceStartLine: item.chunk.source_start_line,
              sourceEndLine: item.chunk.source_end_line,
            },
            embedding,
            opts.provider.name,
            opts.provider.model,
          );
          if (item.existingRowid !== null) result.updated++;
          else result.added++;
        }
      } catch (batchErr) {
        result.errors.push(`Batch ${batch.start} unexpected: ${String(batchErr)}`);
      } finally {
        completed += batch.items.length;
        opts.onProgress?.(instanceId, Math.min(completed, toEmbed.length), toEmbed.length);
      }
    }

    for (let i = 0; i < batches.length; i += concurrency) {
      if (opts.signal?.aborted) break;
      const group = batches.slice(i, i + concurrency);
      await Promise.all(group.map(b => processBatch(b)));
      if (i + concurrency < batches.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } finally {
    srcDb.close();
  }

  return result;
}

export async function syncSingleFile(opts: {
  instanceId: string;
  dbPath: string;
  relpath: string;
  vecStore: VecStore;
  provider: EmbeddingProvider;
}): Promise<SyncResult> {
  const srcDb = new Database(opts.dbPath, { readonly: true });
  const result: SyncResult = {
    instanceId: opts.instanceId,
    added: 0, updated: 0, deleted: 0, skipped: 0, errors: [],
  };

  try {
    const srcChunks = srcDb.prepare(
      'SELECT id, relpath, kind, content_hash, content, source_start_line, source_end_line FROM chunks WHERE relpath = ?'
    ).all(opts.relpath) as ChunkRow[];

    const existingMap = opts.vecStore.getExistingHashesByRelpath(opts.instanceId, opts.relpath);
    const srcIds = new Set<number>();
    const toEmbed: Array<{ chunk: ChunkRow; existingRowid: number | null }> = [];

    for (const chunk of srcChunks) {
      srcIds.add(chunk.id);
      const existing = existingMap.get(chunk.id);
      if (existing && existing.contentHash === chunk.content_hash) {
        result.skipped++;
        continue;
      }
      if (!chunk.content || chunk.content.trim().length < 10) {
        result.skipped++;
        continue;
      }
      toEmbed.push({ chunk, existingRowid: existing?.rowid ?? null });
    }

    for (const [chunkId, meta] of existingMap) {
      if (!srcIds.has(chunkId)) {
        opts.vecStore.deleteByRowid(meta.rowid);
        result.deleted++;
      }
    }

    if (toEmbed.length > 0) {
      const texts = toEmbed.map(b => b.chunk.content);
      const embeddings = await opts.provider.embed(texts);
      for (let j = 0; j < toEmbed.length; j++) {
        const item = toEmbed[j]!;
        opts.vecStore.upsertVec(
          item.existingRowid,
          {
            chunkId: item.chunk.id,
            instanceId: opts.instanceId,
            relpath: item.chunk.relpath,
            kind: item.chunk.kind,
            contentHash: item.chunk.content_hash,
            snippet: item.chunk.content.slice(0, 700),
            sourceStartLine: item.chunk.source_start_line,
            sourceEndLine: item.chunk.source_end_line,
          },
          embeddings[j]!,
          opts.provider.name,
          opts.provider.model,
        );
        item.existingRowid !== null ? result.updated++ : result.added++;
      }
    }
  } finally {
    srcDb.close();
  }
  return result;
}
