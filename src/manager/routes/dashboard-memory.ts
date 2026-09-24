import express, { type RequestHandler } from 'express';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { searchFederated, searchFederatedEnvelope } from '../memory/federation.js';
import { searchChatFederated } from '../memory/chat-federation.js';
import { listSearchableInstancesFromScan } from '../memory/instance-discovery.js';
import type { ScanItemForFederation } from '../memory/types.js';
import { resolveStructuredMemoryDir } from '../../memory/shared.js';
import { isExpectedHostHeader, isAllowedOriginHeader } from '../security.js';
import { VecStore, createProvider, syncAllInstances, VALID_PROVIDERS } from '../memory/embedding/index.js';
import type { EmbeddingConfig } from '../memory/embedding/index.js';
import { hybridMerge } from '../memory/embedding/hybrid-search.js';
import { getEmbeddingState } from '../memory/embedding/state-machine.js';
import { trackSseConnection } from '../../routes/sse-connections.js';
import Database from 'better-sqlite3';

const MAX_QUERY_LEN = 256;
const MAX_RESULT_LIMIT = 200;
const MAX_RESULT_OFFSET = 1000;
const DEFAULT_RESULT_LIMIT = 50;
const MAX_READ_BYTES = 256 * 1024;

export type ScanSupplier = () => Promise<ScanItemForFederation[]>;

function requireManagerOrigin(managerPort: number): RequestHandler {
    const allowed = [`http://127.0.0.1:${managerPort}`, `http://localhost:${managerPort}`];
    return (req, res, next) => {
        const host = isExpectedHostHeader(req.headers.host, {
            host: '127.0.0.1', port: managerPort, allowLocalhostAlias: true,
        });
        const origin = isAllowedOriginHeader(req.headers.origin, {
            allowedOrigins: allowed, allowMissing: true,
        });
        if (!host || !origin) {
            res.status(403).json({ ok: false, code: 'memory_origin_forbidden' });
            return;
        }
        next();
    };
}

export interface DashboardMemoryRouterOptions {
    managerPort: number;
    scanSupplier: ScanSupplier;
    embeddingConfig: () => EmbeddingConfig | null;
    vecStore: () => VecStore | null;
    dashboardHome: string;
}

export function createDashboardMemoryRouter(opts: DashboardMemoryRouterOptions): express.Router {
    const router = express.Router();
    router.use(requireManagerOrigin(opts.managerPort));

    router.get('/instances', async (_req, res) => {
        try {
            const scan = await opts.scanSupplier();
            res.json({ ok: true, instances: listSearchableInstancesFromScan(scan) });
        } catch (err) {
            res.status(500).json({ ok: false, code: 'scan_failed', message: (err as Error).message });
        }
    });

    router.get('/search', async (req, res) => {
        const q = String(req.query["q"] || '').trim();
        if (!q) { res.status(400).json({ ok: false, code: 'invalid_query' }); return; }
        if (q.length > MAX_QUERY_LEN) { res.status(400).json({ ok: false, code: 'query_too_long' }); return; }
        const filter = String(req.query["instance"] || '').split(',').map(s => s.trim()).filter(Boolean);
        const requestedLimit = Number(req.query["limit"]);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.floor(Math.max(1, requestedLimit)), MAX_RESULT_LIMIT)
            : DEFAULT_RESULT_LIMIT;
        const requestedOffset = Number(req.query["offset"]);
        const offset = Number.isFinite(requestedOffset)
            ? Math.min(Math.floor(Math.max(0, requestedOffset)), MAX_RESULT_OFFSET)
            : 0;
        const modeRaw = String(req.query["mode"] || '').trim();
        if (modeRaw && modeRaw !== 'fts5' && modeRaw !== 'embedding' && modeRaw !== 'hybrid') {
            res.status(400).json({ ok: false, code: 'invalid_mode' });
            return;
        }
        const modeOverride = modeRaw as '' | 'fts5' | 'embedding' | 'hybrid';
        try {
            const scan = await opts.scanSupplier();
            const refs = listSearchableInstancesFromScan(scan);
            const targets = filter.length ? refs.filter(r => filter.includes(r.instanceId)) : refs;

            const embConfig = opts.embeddingConfig();
            const searchMode = modeOverride || embConfig?.searchMode || 'fts5';
            const vec = opts.vecStore();

            if (searchMode === 'fts5' || !embConfig?.enabled || !vec) {
                const fetchLimit = limit + offset + 1;
                const result = searchFederated(q, { instances: targets, globalLimit: fetchLimit });
                const paged = result.hits.slice(offset);
                const hitsPage = paged.slice(0, limit);
                res.json({ ok: true, mode: 'fts5', ...result, hits: hitsPage, total: result.hits.length, offset, hasMore: paged.length > limit });
            } else if (searchMode === 'embedding') {
                const fetchLimit = limit + offset + 1;
                const provider = await createProvider(embConfig);
                const embedResult = await provider.embed([q]);
                const queryVec = embedResult[0]!;
                const vecHits = vec.searchScoped(queryVec, fetchLimit, targets.map(t => t.instanceId));
                const allHits = vecHits.map(v => ({
                    path: '',
                    relpath: v.relpath,
                    kind: v.kind,
                    source_start_line: v.sourceStartLine,
                    source_end_line: v.sourceEndLine,
                    snippet: v.snippet,
                    score: 0,
                    instanceId: v.instanceId,
                    embeddingDistance: v.distance,
                }));
                const paged = allHits.slice(offset);
                const hitsPage = paged.slice(0, limit);
                res.json({
                    ok: true,
                    mode: 'embedding',
                    hits: hitsPage,
                    total: allHits.length,
                    offset,
                    hasMore: paged.length > limit,
                    warnings: [],
                    instancesQueried: targets.length,
                    instancesSucceeded: targets.length,
                });
            } else {
                const fetchMultiplier = offset > 0 ? 3 : 2;
                const ftsResult = searchFederated(q, { instances: targets, globalLimit: (limit + offset + 1) * fetchMultiplier });
                const provider = await createProvider(embConfig);
                const embedResult = await provider.embed([q]);
                const queryVec = embedResult[0]!;
                const vecHits = vec.searchScoped(queryVec, (limit + offset + 1) * fetchMultiplier, targets.map(t => t.instanceId));
                const ftsWithInstance = ftsResult.hits.map(h => ({ ...h, instanceId: h.instanceId || 'default' }));
                const merged = hybridMerge({ ftsHits: ftsWithInstance, vecHits, limit: limit + offset + 1 });
                const paged = merged.slice(offset);
                const hitsPage = paged.slice(0, limit);
                res.json({
                    ok: true,
                    mode: 'hybrid',
                    hits: hitsPage,
                    total: merged.length,
                    offset,
                    hasMore: paged.length > limit,
                    warnings: ftsResult.warnings,
                    instancesQueried: ftsResult.instancesQueried,
                    instancesSucceeded: ftsResult.instancesSucceeded,
                });
            }
        } catch (err) {
            res.status(500).json({ ok: false, code: 'search_failed', message: (err as Error).message });
        }
    });

    router.get('/chat/search', async (req, res) => {
        const q = String(req.query["q"] || '').trim();
        if (!q) { res.status(400).json({ ok: false, code: 'invalid_query' }); return; }
        if (q.length > MAX_QUERY_LEN) { res.status(400).json({ ok: false, code: 'query_too_long' }); return; }
        const filter = String(req.query["instance"] || '').split(',').map(s => s.trim()).filter(Boolean);
        const requestedLimit = Number(req.query["limit"]);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.floor(Math.max(1, requestedLimit)), MAX_RESULT_LIMIT)
            : DEFAULT_RESULT_LIMIT;
        const requestedDays = Number(req.query["days"]);
        const days = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.floor(requestedDays) : undefined;
        const envelope = String(req.query["format"] || '') === 'envelope';
        if (envelope) {
            const corpus = req.query["corpus"];
            if ((corpus !== undefined && String(corpus) !== 'chat') || req.query["cursor"] !== undefined) {
                res.status(400).json({ ok: false, code: 'invalid_query' });
                return;
            }
        }
        try {
            const scan = await opts.scanSupplier();
            const refs = listSearchableInstancesFromScan(scan);
            if (envelope) {
                const sessionFilterRaw = String(req.query["sessionFilter"] || '').trim();
                const envelopeOpts: import('../memory/federation.js').FederatedEnvelopeSearchOptions = {
                    instances: refs,
                    limit,
                };
                if (filter.length) envelopeOpts.instanceFilter = filter;
                if (days != null) envelopeOpts.days = days;
                if (sessionFilterRaw) envelopeOpts.sessionFilter = sessionFilterRaw;
                res.json(searchFederatedEnvelope(q, envelopeOpts));
                return;
            }
            const chatOpts: import('../memory/chat-federation.js').ChatFederatedSearchOptions = {
                instances: refs,
                limit,
            };
            if (filter.length) chatOpts.instanceFilter = filter;
            if (days != null) chatOpts.days = days;
            const result = searchChatFederated(q, chatOpts);
            res.json({ ok: true, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, code: 'chat_search_failed', message: (err as Error).message });
        }
    });

    router.get('/read', async (req, res) => {
        const instanceId = String(req.query["instance"] || '');
        const relPath = String(req.query["path"] || '');
        if (!instanceId || !relPath) { res.status(400).json({ ok: false, code: 'invalid_args' }); return; }
        let scan: ScanItemForFederation[];
        try { scan = await opts.scanSupplier(); }
        catch (err) { res.status(500).json({ ok: false, code: 'scan_failed', message: (err as Error).message }); return; }
        const ref = listSearchableInstancesFromScan(scan).find(r => r.instanceId === instanceId);
        if (!ref) { res.status(404).json({ ok: false, code: 'instance_not_found' }); return; }

        let homeReal: string;
        try { homeReal = realpathSync(ref.homePath); }
        catch { res.status(404).json({ ok: false, code: 'home_not_found' }); return; }

        let memRoot: string;
        try { memRoot = realpathSync(resolveStructuredMemoryDir(ref.homePath)); }
        catch { res.status(404).json({ ok: false, code: 'memory_root_not_found' }); return; }

        const rootEscapeRel = relative(homeReal, memRoot).replace(/\\/g, '/');
        if (rootEscapeRel === '..' || rootEscapeRel.startsWith('../') || rootEscapeRel.startsWith('/')) {
            res.status(400).json({ ok: false, code: 'memory_root_escapes_home' });
            return;
        }

        const targetRaw = resolve(memRoot, relPath);
        try {
            const lstat = lstatSync(targetRaw);
            if (lstat.isSymbolicLink()) {
                res.status(400).json({ ok: false, code: 'symlink_forbidden' });
                return;
            }
        } catch {
            res.status(404).json({ ok: false, code: 'file_not_found' });
            return;
        }

        let targetReal: string;
        try { targetReal = realpathSync(targetRaw); }
        catch { res.status(404).json({ ok: false, code: 'file_not_found' }); return; }

        const rel = relative(memRoot, targetReal).replace(/\\/g, '/');
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) {
            res.status(400).json({ ok: false, code: 'path_out_of_root' });
            return;
        }

        if (extname(targetReal).toLowerCase() !== '.md') {
            res.status(400).json({ ok: false, code: 'unsupported_extension' });
            return;
        }

        if (!existsSync(targetReal)) { res.status(404).json({ ok: false, code: 'file_not_found' }); return; }
        const stat = statSync(targetReal);
        if (!stat.isFile()) { res.status(400).json({ ok: false, code: 'not_a_file' }); return; }
        if (stat.size > MAX_READ_BYTES) {
            res.status(413).json({ ok: false, code: 'file_too_large', size: stat.size, max: MAX_READ_BYTES });
            return;
        }
        res.json({ ok: true, instanceId, path: rel, content: readFileSync(targetReal, 'utf8') });
    });

    router.get('/embed-config', (_req, res) => {
        const config = opts.embeddingConfig();
        if (!config) { res.json({ ok: true, config: null }); return; }
        const masked = {
            ...config,
            apiKey: undefined,
            apiKeyPresent: !!config.apiKey,
            apiKeySource: config.apiKey?.startsWith('$') ? 'env' : config.apiKey ? 'direct' : 'none',
            apiKeyPreview: config.apiKey?.startsWith('$') ? config.apiKey : config.apiKey ? `...${config.apiKey.slice(-4)}` : '',
        };
        res.json({ ok: true, config: masked });
    });

    router.post('/embed-config', express.json(), async (req, res) => {
        try {
            const config = req.body as Partial<EmbeddingConfig>;
            if (config.provider && !(VALID_PROVIDERS as readonly string[]).includes(config.provider)) {
                res.status(400).json({ ok: false, code: 'invalid_provider' });
                return;
            }
            const prev = opts.embeddingConfig();
            if (config.apiKey === '' && prev?.apiKey) delete config.apiKey;
            const merged = { ...prev, ...config };
            const settingsPath = join(opts.dashboardHome, 'embedding.json');
            writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });

            const providerChanged = prev && (prev.provider !== merged.provider || prev.model !== merged.model || prev.dimensions !== merged.dimensions);

            if (req.body.test) {
                try {
                    const provider = await createProvider(merged as EmbeddingConfig);
                    await provider.embed(['connection test']);
                    res.json({ ok: true, saved: true, needsReindex: providerChanged || false, testResult: 'ok' });
                } catch (testErr) {
                    res.json({ ok: true, saved: true, needsReindex: providerChanged || false, testResult: 'fail', testError: String(testErr) });
                }
                return;
            }

            res.json({ ok: true, saved: true, needsReindex: providerChanged || false });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    router.post('/reindex', async (_req, res) => {
        const embConfig = opts.embeddingConfig();
        if (!embConfig?.enabled) {
            res.status(400).json({ ok: false, code: 'embedding_not_enabled' });
            return;
        }
        const vec = opts.vecStore();
        if (!vec) {
            res.status(500).json({ ok: false, code: 'vecstore_not_initialized' });
            return;
        }
        try {
            const scan = await opts.scanSupplier();
            const instances = listSearchableInstancesFromScan(scan);
            const provider = await createProvider(embConfig);
            vec.setConfig('provider', embConfig.provider);
            vec.setConfig('model', embConfig.model);
            const results = await syncAllInstances({
                instances,
                vecStore: vec,
                provider,
            });
            vec.setConfig('lastSyncAt', new Date().toISOString());
            res.json({ ok: true, results });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    router.get('/embed-state', async (_req, res) => {
        try {
            const embConfig = opts.embeddingConfig();
            const vec = opts.vecStore();
            let totalSourceChunks = 0;
            try {
                const scan = await opts.scanSupplier();
                const instances = listSearchableInstancesFromScan(scan);
                for (const inst of instances) {
                    if (!inst.hasDb) continue;
                    let instDb: Database.Database | null = null;
                    try {
                        instDb = new Database(inst.dbPath, { readonly: true });
                        const row = instDb.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
                        totalSourceChunks += row.cnt;
                    } catch (e) {
                        console.warn(`[embed-state] chunk count failed for ${inst.instanceId}:`, (e as Error).message);
                    } finally {
                        instDb?.close();
                    }
                }
            } catch {} // best-effort: chunk-count scan degrades to 0 when instances unreachable
            const status = getEmbeddingState({
                settings: embConfig,
                vecStore: vec,
                dashboardRunning: true,
                totalSourceChunks,
                lastTestResult: vec?.getConfig('testResult') as 'ok' | 'fail' | null ?? null,
            });
            res.json({ ok: true, status });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    router.get('/embed-estimate', async (_req, res) => {
        try {
            const scan = await opts.scanSupplier();
            const instances = listSearchableInstancesFromScan(scan);
            let totalChunks = 0;
            let totalChars = 0;
            for (const inst of instances) {
                if (!inst.hasDb) continue;
                let instDb: Database.Database | null = null;
                try {
                    instDb = new Database(inst.dbPath, { readonly: true });
                    const row = instDb.prepare('SELECT COUNT(*) as cnt, SUM(LENGTH(content)) as chars FROM chunks').get() as { cnt: number; chars: number | null };
                    totalChunks += row.cnt;
                    totalChars += row.chars || 0;
                } catch (e) {
                    console.warn(`[embed-estimate] chunk count failed for ${inst.instanceId}:`, (e as Error).message);
                } finally {
                    instDb?.close();
                }
            }
            const estimatedTokens = Math.ceil(totalChars / 3);
            const batches = Math.ceil(totalChunks / 20);
            const estimatedSeconds = Math.round(batches * 0.8);
            const priceMap: Record<string, number> = { openai: 0.02, gemini: 0, voyage: 0.02, vertex: 0.000025, local: 0 };
            const provider = opts.embeddingConfig()?.provider || 'openai';
            const costPerMToken = priceMap[provider] ?? 0.02;
            const estimatedCost = Math.round((estimatedTokens / 1_000_000) * costPerMToken * 10000) / 10000;

            res.json({ ok: true, totalChunks, estimatedTokens, estimatedCost, batches, estimatedSeconds, provider });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    router.get('/reindex-stream', async (req, res) => {
        const embConfig = opts.embeddingConfig();
        if (!embConfig?.enabled) {
            res.status(400).json({ ok: false, code: 'embedding_not_enabled' });
            return;
        }
        const vec = opts.vecStore();
        if (!vec) {
            res.status(500).json({ ok: false, code: 'vecstore_not_initialized' });
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let aborted = false;
        // Tracked so shutdown can abort an in-flight reindex before the HTTP
        // server closes — the open stream would hold close() open (#790).
        const untrack = trackSseConnection(() => {
            aborted = true;
            if (!res.writableEnded) res.end();
        });
        req.on('close', () => { aborted = true; untrack(); });
        res.on('close', untrack);

        try {
            const scan = await opts.scanSupplier();
            const instances = listSearchableInstancesFromScan(scan);
            const provider = await createProvider(embConfig);
            vec.setConfig('provider', embConfig.provider);
            vec.setConfig('model', embConfig.model);
            const results = await syncAllInstances({
                instances,
                vecStore: vec,
                provider,
                onProgress: (instId, done, total) => {
                    if (aborted) return;
                    res.write(`data: ${JSON.stringify({ instanceId: instId, done, total })}\n\n`);
                },
            });
            vec.setConfig('lastSyncAt', new Date().toISOString());
            if (!aborted) res.write(`data: ${JSON.stringify({ complete: true, results })}\n\n`);
        } catch (err) {
            if (!aborted) res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
        }
        if (!aborted) res.end();
    });

    return router;
}
