import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { httpStatus } from './_http-error.js';
import { assertMemoryRelPath } from '../security/path-guards.js';
import * as memory from '../memory/memory.js';
import { getMemoryStatus, searchIndexedMemory, readIndexedMemorySnippet, reflectMemory, hasSoulFile, loadSoulSummary, getAdvancedMemoryDir, safeReadFile, readMeta, writeMeta, listMemoryFiles, writeText } from '../memory/runtime.js';
import { ensureAdvancedMemoryStructure, scanSystemProfile } from '../memory/bootstrap.js';
import { reindexSingleFile } from '../memory/indexing.js';
import { getMemory, searchMessagesByTimeWindow } from '../core/db.js';
import { settings, getServerUrl, JAW_HOME } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { broadcast } from '../core/bus.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { buildSoulBootstrapPrompt } from '../prompt/soul-bootstrap-prompt.js';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolveDashboardHome } from '../manager/dashboard-home.js';
import { DASHBOARD_DEFAULT_PORT } from '../manager/constants.js';

function normalizeAdvancedReadPath(file: string): string {
    const value = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return value.startsWith('structured/') ? value.slice('structured/'.length) : value;
}

function countAdvancedMemoryFiles(): number {
    const sections = listMemoryFiles().sections;
    return Object.values(sections).reduce((sum, files) => sum + files.length, 0);
}

function flattenAdvancedMemoryFiles(): string[] {
    const sections = listMemoryFiles().sections;
    return [
        ...sections.profile,
        ...sections.shared,
        ...sections.episodes,
        ...sections.semantic,
        ...sections.procedures,
        ...sections.sessions,
    ];
}

export function buildMemorySyncPayload(reason: string) {
    return {
        reason,
        status: {
            ...getMemoryStatus(),
            hasSoul: hasSoulFile(),
            soulSynthesized: readMeta()?.soulSynthesized || false,
            soulPreview: hasSoulFile() ? loadSoulSummary(200) : '',
            legacyFileCount: memory.list().length,
            advancedFileCount: countAdvancedMemoryFiles(),
        },
    };
}

function broadcastMemorySync(reason: string): void {
    broadcast('memory_status', buildMemorySyncPayload(reason));
}

function saveCanonicalSoul(content: string): string {
    const root = getAdvancedMemoryDir();
    const soulPath = join(root, 'shared', 'soul.md');
    // Soul bootstrap provides a full document, so this path must overwrite.
    writeText(soulPath, String(content || ''));
    reindexSingleFile(root, soulPath);
    return soulPath;
}

export function registerJawMemoryRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/jaw-memory/search', requireAuth, async (req, res) => {
        try {
            const q = String(req.query["q"] || '');

            const embeddingResult = await tryEmbeddingSearch(q);
            if (embeddingResult !== null) {
                res.json({ result: embeddingResult });
                return;
            }

            const mem = getMemoryStatus();
            res.json({ result: mem.routing.searchRead === 'advanced' ? searchIndexedMemory(q) : memory.search(q) });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/read', requireAuth, (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.query["file"] || ''), { allowExt: ['.md', '.txt', '.json'] });
            const mem = getMemoryStatus();
            const content = mem.routing.searchRead === 'advanced'
                ? readIndexedMemorySnippet(normalizeAdvancedReadPath(file), stripUndefined({ lines: req.query["lines"] as string | undefined }))
                : memory.read(file, stripUndefined({ lines: req.query["lines"] as string | undefined }));
            res.json({ content });
        } catch (e: unknown) { res.status(httpStatus(e, 500)).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/save', requireAuth, (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.body.file || ''), { allowExt: ['.md', '.txt', '.json'] });
            const normalizedFile = file.replace(/\\/g, '/');
            const p = normalizedFile === 'shared/soul.md' || normalizedFile === 'structured/shared/soul.md'
                ? saveCanonicalSoul(req.body.content)
                : memory.save(file, req.body.content);
            const payload = buildMemorySyncPayload('save');
            broadcastMemorySync('save');
            res.json({ ok: true, path: p, ...payload });
        } catch (e: unknown) { res.status(httpStatus(e, 500)).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/context', requireAuth, (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.query["file"] || ''), { allowExt: ['.md', '.txt', '.json'] });
            const memDir = getAdvancedMemoryDir() || join(JAW_HOME, 'memory');
            const fullPath = join(memDir, file);
            if (!existsSync(fullPath)) {
                res.status(404).json({ error: `memory file not found: ${file}` });
                return;
            }
            const content = readFileSync(fullPath, 'utf8');
            const mtime = statSync(fullPath).mtime;

            const createdMatch = content.match(/created_at:\s*(.+)/);
            const center = createdMatch?.[1]?.trim() || mtime.toISOString().replace('T', ' ').slice(0, 19);

            const nameMatch = content.match(/name:\s*(.+)/);
            const descMatch = content.match(/description:\s*(.+)/);
            const kindMatch = content.match(/kind:\s*(.+)/);
            let q = (nameMatch?.[1] || '').replace(/[-_]/g, ' ').trim();
            let q2 = (descMatch?.[1] || '').trim().slice(0, 60) || null;

            if (!q) {
                const stem = file.replace(/.*\//, '').replace(/\.\w+$/, '').replace(/[-_]/g, ' ').trim();
                q = stem;
            }
            if (!q2 && kindMatch?.[1]) {
                q2 = kindMatch[1].trim();
            }
            if (!q2 && !q) {
                const bodyStart = content.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 80);
                const firstLine = bodyStart.split('\n')[0]?.trim() || null;
                if (firstLine && firstLine.length > 3) q2 = firstLine;
            }

            if (!q && !q2) {
                res.json({ file, center, hits: [], message: 'no searchable terms extracted from memory file' });
                return;
            }

            const windowHours = Math.min(Math.max(Number(req.query["window"]) || 4, 1), 720);
            const limit = Math.min(Number(req.query["limit"]) || 10, 30);

            const allTerms = `${q} ${q2 || ''}`.split(/\s+/).filter(t => t.length >= 2);
            const primaryTerm = allTerms[0] || '';
            if (!primaryTerm) {
                res.json({ file, center, hits: [], message: 'no searchable terms after split' });
                return;
            }
            const secondaryTerm = allTerms.length > 1 ? allTerms[1] : null;

            const rows = searchMessagesByTimeWindow.all({
                center, window_hours: windowHours, q: primaryTerm, q2: secondaryTerm, limit,
            }) as Array<{ id: number; role: string; content: string; cli: string | null; created_at: string; session_id: string }>;

            res.json({
                file,
                center,
                terms: { q, q2 },
                hits: rows.map(r => ({
                    id: r.id,
                    role: r.role,
                    content: r.content.slice(0, 400),
                    cli: r.cli,
                    created_at: r.created_at,
                    session_id: r.session_id,
                })),
            });
        } catch (e: unknown) { res.status(httpStatus(e, 500)).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/list', requireAuth, (_, res) => {
        try {
            const mem = getMemoryStatus();
            const files = mem.routing.searchRead === 'advanced'
                ? flattenAdvancedMemoryFiles().map(path => ({ path, size: 0, modified: '' }))
                : memory.list();
            res.json({
                files,
                count: files.length,
                mode: mem.routing.searchRead,
                advancedFileCount: countAdvancedMemoryFiles(),
            });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/init', requireAuth, (_, res) => {
        try {
            memory.ensureMemoryDir();
            const payload = buildMemorySyncPayload('init');
            broadcastMemorySync('init');
            res.json({ ok: true, ...payload });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/reflect', requireAuth, (req, res) => {
        try {
            const result = reflectMemory(req.body || {});
            const payload = buildMemorySyncPayload('reflect');
            broadcastMemorySync('reflect');
            res.json({ ok: true, result, ...payload });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/jaw-memory/flush', requireAuth, async (_req, res) => {
        try {
            const { triggerMemoryFlushForCurrentSession } = await import('../agent/memory-flush-controller.js');
            // Single-session by design; the merged flush is the automatic one.
            const outcome = await triggerMemoryFlushForCurrentSession();
            if (outcome === 'unavailable') { res.status(409).json({ error: 'aside_memory_flush_unsupported' }); return; }
            if (outcome === 'locked') {
                // 409 rather than 500: nothing failed, the writer is simply busy.
                res.status(409).json({ ok: false, outcome, message: 'A memory flush is already running' });
                return;
            }
            res.json({
                ok: true,
                outcome,
                message: outcome === 'insufficient' ? 'Nothing new to summarise' : 'Memory flush triggered',
            });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.get('/api/jaw-memory/soul', requireAuth, async (_req, res) => {
        try {
            const { readSoul } = await import('../memory/identity.js');
            res.json({ soul: readSoul() });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/soul/activate', requireAuth, async (_req, res) => {
        try {
            const hadSoul = hasSoulFile();
            ensureAdvancedMemoryStructure();
            const nowHasSoul = hasSoulFile();
            const created = !hadSoul && nowHasSoul;
            if (created) {
                const root = getAdvancedMemoryDir();
                reindexSingleFile(root, join(root, 'shared', 'soul.md'));
            }
            const soul = loadSoulSummary(2000);
            const payload = buildMemorySyncPayload('soul_activate');
            broadcastMemorySync('soul_activate');
            res.json({
                activated: true,
                created,
                preview: soul.slice(0, 200),
                ...payload,
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/soul', requireAuth, async (req, res) => {
        try {
            const { applySoulUpdate } = await import('../memory/identity.js');
            const result = applySoulUpdate(req.body);
            // Mark soul as synthesized when called with reason: 'soul-bootstrap'
            if (result.applied && req.body?.reason === 'soul-bootstrap') {
                writeMeta({
                    soulSynthesized: true,
                    soulSynthesizedAt: new Date().toISOString(),
                    soulSynthesizedCli: settings["cli"] || 'unknown',
                });
            }
            if (!result.applied && req.body?.reason === 'soul-bootstrap' && hasSoulFile()) {
                writeMeta({
                    soulSynthesized: true,
                    soulSynthesizedAt: new Date().toISOString(),
                    soulSynthesizedCli: settings["cli"] || 'unknown',
                });
            }
            const payload = buildMemorySyncPayload(req.body?.reason === 'soul-bootstrap' ? 'soul_bootstrap' : 'soul_update');
            if (result.applied || req.body?.reason === 'soul-bootstrap') {
                broadcastMemorySync(req.body?.reason === 'soul-bootstrap' ? 'soul_bootstrap' : 'soul_update');
            }
            res.json({ ...result, ...payload });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/soul/bootstrap', requireAuth, (req, res) => {
        try {
            const meta = readMeta();
            if (meta?.soulSynthesized) {
                res.json({ ok: false, reason: 'already_synthesized' });
                return;
            }

            const root = getAdvancedMemoryDir();
            const systemProfile = scanSystemProfile();
            const currentSoul = safeReadFile(join(root, 'shared', 'soul.md'));
            const profileContent = safeReadFile(join(root, 'profile.md'));
            const kvEntries = (getMemory.all() as { key: string; value: string }[]) || [];
            const lang = settings["locale"] || req.body?.lang || 'en';

            const prompt = buildSoulBootstrapPrompt({
                systemProfile,
                currentSoul,
                profileContent,
                kvEntries,
                lang,
                serverUrl: getServerUrl(),
                instanceHome: JAW_HOME,
            });

            const result = submitMessage(prompt, {
                origin: 'system',
                displayText: lang === 'ko' ? '🧠 Soul 최적화 중...' : '🧠 Optimizing soul...',
            });

            if (result.action === 'rejected') {
                res.json({ ok: false, reason: result.reason || 'no_active_agent' });
                return;
            }

            res.json({ ok: true, action: result.action, requestId: result.requestId });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });
}

async function tryEmbeddingSearch(query: string): Promise<string | null> {
    try {
        const home = resolveDashboardHome();
        const cfgPath = join(home, 'embedding.json');
        if (!existsSync(cfgPath)) return null;
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (!cfg.enabled) return null;

        const fromEnv = Number(process.env['DASHBOARD_PORT']);
        const port = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : Number(DASHBOARD_DEFAULT_PORT);
        const url = `http://127.0.0.1:${port}/api/dashboard/memory/search?` +
            `q=${encodeURIComponent(query)}&mode=${cfg.searchMode || 'hybrid'}`;
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(5000),
            headers: { host: `127.0.0.1:${port}` },
        });
        if (!resp.ok) return null;

        const data = await resp.json() as { hits?: Array<{ relpath: string; source_start_line: number; source_end_line: number; snippet: string }> };
        if (!data.hits?.length) return null;

        return data.hits.map((h: any) =>
            `${h.relpath}:${h.source_start_line}-${h.source_end_line}\n${h.snippet}`
        ).join('\n\n---\n\n');
    } catch {
        return null;
    }
}
