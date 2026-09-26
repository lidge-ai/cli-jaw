import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { CodeSessionManager } from '../code-mode/manager.js';
import { CodeStoreError } from '../code-mode/store.js';
import type {
    CodeCreateSessionRequest, CodePatchSessionRequest, CodePermissionMode, CodeProviderId, CodeRollbackRequest, CodeSessionCursor,
} from '../code-mode/wire.js';
import { asyncHandler } from '../http/async-handler.js';
import { fail } from '../http/response.js';
import { httpCode, httpStatus } from './_http-error.js';
import { CODE_PROMPT_MAX_BYTES } from './code-body-parser.js';

export type CodeRouteService = Pick<CodeSessionManager, 'create' | 'list' | 'snapshot' | 'readEvents' | 'history'
    | 'prompt' | 'steer' | 'cancel' | 'attach' | 'visit' | 'patch' | 'rollback' | 'answerPermission' | 'models'>;
/** Only an opaque Code user row is a rollback target; native message identities are never accepted. */
const ROLLBACK_TARGET = /^[^:\s]{1,200}:user$/;

const PROVIDERS: readonly CodeProviderId[] = ['codex-app', 'claude', 'cursor', 'grok'];
// Provider-agnostic parse; which provider accepts which mode is the manager's call.
const PERMISSION_MODES: readonly CodePermissionMode[] = ['ask', 'auto', 'read-only', 'plan', 'accept-edits', 'dont-ask', 'auto-review'];

function invalid(code: string): never {
    throw new CodeStoreError(code, code.replaceAll('_', ' '), 400);
}

function body(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_body');
    if (Object.keys(value).some(key => !keys.includes(key))) return invalid('unknown_field');
    return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max = 1024): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) return invalid(`invalid_${field}`);
    return value;
}

function id(value: unknown): string { return string(value, 'id', 240); }

function integer(value: unknown, field: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid(`invalid_${field}`);
    return value;
}

function queryInteger(value: unknown, field: string, fallback: number, minimum = 0): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid(`invalid_${field}`);
    return integer(Number(value), field, minimum);
}

function cwd(value: unknown): string {
    const path = string(value, 'cwd', 4096);
    if (!isAbsolute(path)) return invalid('absolute_cwd_required');
    return path;
}

function workspaceFilter(value: unknown): string {
    const path = resolve(cwd(value));
    try { return realpathSync(path); }
    catch { return path; } // Stored canonical directories remain queryable after removal.
}

function permission(value: unknown): CodePermissionMode {
    if (!PERMISSION_MODES.includes(value as CodePermissionMode)) return invalid('invalid_permission_mode');
    return value as CodePermissionMode;
}

/** The page cursor is an opaque JSON pair minted by a previous list response. */
function sessionCursor(value: unknown): CodeSessionCursor {
    let parsed: unknown;
    try { parsed = JSON.parse(string(value, 'cursor', 1024)); }
    catch { return invalid('invalid_cursor'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('invalid_cursor');
    const cursor = parsed as Record<string, unknown>;
    return { createdAt: integer(cursor['createdAt'], 'cursor'), sessionId: string(cursor['sessionId'], 'cursor', 240) };
}

function createInput(value: unknown): CodeCreateSessionRequest {
    const input = body(value, ['provider', 'cwd', 'model', 'effort', 'permissionMode', 'thinking']);
    if (!PROVIDERS.includes(input['provider'] as CodeProviderId)) return invalid('invalid_provider');
    let directory: string;
    try {
        directory = realpathSync(cwd(input['cwd']));
        if (!statSync(directory).isDirectory()) return invalid('workspace_missing');
    } catch (error) {
        if (error instanceof CodeStoreError) throw error;
        return invalid('workspace_missing');
    }
    return {
        provider: input['provider'] as CodeProviderId,
        cwd: directory,
        model: string(input['model'], 'model'),
        effort: input['effort'] == null ? null : string(input['effort'], 'effort', 80),
        permissionMode: permission(input['permissionMode']),
        ...('thinking' in input ? { thinking: bool(input['thinking'], 'invalid_thinking') } : {}),
    };
}

function bool(value: unknown, code: string): boolean {
    return typeof value === 'boolean' ? value : invalid(code);
}

function patchInput(value: unknown): CodePatchSessionRequest {
    const input = body(value, ['expectedRevision', 'title', 'model', 'effort', 'permissionMode', 'thinking', 'archived']);
    const patch: CodePatchSessionRequest = { expectedRevision: integer(input['expectedRevision'], 'revision') };
    if ('title' in input) {
        if (input['title'] !== null && (typeof input['title'] !== 'string' || input['title'].length > 240 || input['title'].includes('\0'))) return invalid('invalid_title');
        patch.title = input['title'];
    }
    if ('model' in input) patch.model = string(input['model'], 'model');
    if ('effort' in input) patch.effort = input['effort'] === null ? null : string(input['effort'], 'effort', 80);
    if ('permissionMode' in input) patch.permissionMode = permission(input['permissionMode']);
    if ('thinking' in input) patch.thinking = bool(input['thinking'], 'invalid_thinking');
    if ('archived' in input) {
        if (typeof input['archived'] !== 'boolean') return invalid('invalid_archived');
        patch.archived = input['archived'];
    }
    if (Object.keys(patch).length === 1) return invalid('empty_patch');
    return patch;
}

function rollbackInput(value: unknown): CodeRollbackRequest {
    const input = body(value, ['expectedRevision', 'expectedEpoch', 'upToItemId']);
    const target = input['upToItemId'];
    if (typeof target !== 'string' || !ROLLBACK_TARGET.test(target)) return invalid('invalid_rollback_target');
    return { expectedRevision: integer(input['expectedRevision'], 'revision'),
        expectedEpoch: integer(input['expectedEpoch'], 'epoch'), upToItemId: target };
}

/** The service getter is invoked after authentication and input parsing. */
export function registerNativeCodeRoutes(
    app: Router,
    requireAuth: RequestHandler,
    getService: () => CodeRouteService,
    prefix = '/api/code',
): void {
    const router = Router();
    router.use(requireAuth);
    const retired: RequestHandler = (_req, res) => {
        fail(res, 410, 'code_endpoint_retired', { message: 'Use native Code sessions and session settings.' });
    };
    router.get('/sessions/stored', retired);
    router.post('/sessions/load', retired);
    for (const path of ['/model-default', '/model-assignments', '/model-presets', '/model-assignments/:role']) router.all(path, retired);
    for (const path of ['/sessions/:id/ext', '/sessions/:id/fork', '/sessions/:id/config', '/sessions/:id/model']) router.all(path, retired);

    router.get('/models', asyncHandler(async (_req, res) => res.json({ ok: true, ...getService().models() })));
    router.get('/sessions', asyncHandler(async (req, res) => {
        const scope = req.query['scope'];
        if (scope !== undefined && scope !== 'all' && scope !== 'cwd') return invalid('invalid_scope');
        const directory = req.query['cwd'] === undefined ? undefined : workspaceFilter(req.query['cwd']);
        if (scope === 'cwd' && directory === undefined) return invalid('absolute_cwd_required');
        const archived = req.query['archived'];
        if (archived !== undefined && archived !== 'true' && archived !== 'false') return invalid('invalid_archived');
        if (req.query['offset'] !== undefined) return invalid('offset_unsupported');
        const limit = Math.min(queryInteger(req.query['limit'], 'limit', 100, 1), 1000);
        const cursor = req.query['cursor'] === undefined ? undefined : sessionCursor(req.query['cursor']);
        const sessions = getService().list({ limit, ...(cursor === undefined ? {} : { cursor }),
            ...(directory === undefined ? {} : { cwd: directory }),
            ...(archived === undefined ? {} : { archived: archived === 'true' }) });
        const last = sessions.at(-1);
        const hasMore = sessions.length === limit;
        res.json({ ok: true, sessions, limit, hasMore,
            nextCursor: hasMore && last ? JSON.stringify({ createdAt: last.createdAt, sessionId: last.sessionId }) : null });
    }));
    router.get('/sessions/:id', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        res.json({ ok: true, ...getService().snapshot(sessionId) });
    }));
    router.get('/sessions/:id/events', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const after = queryInteger(req.query['afterSequence'], 'sequence', 0);
        const limit = Math.min(queryInteger(req.query['limit'], 'limit', 500, 1), 500);
        res.json({ ok: true, ...getService().readEvents(sessionId, after, limit) });
    }));
    router.get('/sessions/:id/items', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const before = queryInteger(req.query['beforeSequence'], 'sequence', Number.MAX_SAFE_INTEGER);
        const limit = Math.min(queryInteger(req.query['limit'], 'limit', 100, 1), 1000);
        res.json({ ok: true, ...getService().history(sessionId, before, limit) });
    }));
    router.post('/sessions', asyncHandler(async (req, res) => {
        const input = createInput(req.body);
        res.status(201).json({ ok: true, session: getService().create(input) });
    }));
    router.patch('/sessions/:id', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const input = patchInput(req.body);
        const service = getService();
        try { res.json({ ok: true, session: await service.patch(sessionId, input) }); }
        catch (error) {
            if (httpCode(error) !== 'revision_conflict') throw error;
            fail(res, 409, 'revision_conflict', { session: service.snapshot(sessionId).session });
        }
    }));
    router.post('/sessions/:id/prompt', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const input = body(req.body, ['text', 'clientTurnKey']);
        const text = string(input['text'], 'prompt', CODE_PROMPT_MAX_BYTES);
        if (Buffer.byteLength(text) > CODE_PROMPT_MAX_BYTES) return invalid('invalid_prompt');
        const key = id(input['clientTurnKey']);
        const admitted = getService().prompt(sessionId, { text, clientTurnKey: key });
        res.status(admitted.duplicate ? 200 : 202).json({ ok: true, ...admitted.receipt });
    }));
    router.post('/sessions/:id/steer', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const input = body(req.body, ['text', 'clientTurnKey', 'turnId', 'epoch']);
        const text = string(input['text'], 'prompt', CODE_PROMPT_MAX_BYTES);
        if (Buffer.byteLength(text) > CODE_PROMPT_MAX_BYTES) return invalid('invalid_prompt');
        // A follow-up joins a running turn as plain text; a command there would not run as one.
        if (text.trimStart().startsWith('/')) return invalid('steer_command_unsupported');
        const steer = { text, clientTurnKey: id(input['clientTurnKey']), turnId: id(input['turnId']), epoch: integer(input['epoch'], 'epoch') };
        const admitted = await getService().steer(sessionId, steer);
        res.status(admitted.duplicate ? 200 : 202).json({ ok: true, ...admitted.receipt });
    }));
    router.post('/sessions/:id/cancel', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const input = body(req.body, ['turnId', 'epoch']);
        const command = { turnId: id(input['turnId']), epoch: integer(input['epoch'], 'epoch') };
        res.json({ ok: true, session: await getService().cancel(sessionId, command) });
    }));
    router.post('/sessions/:id/attach', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        body(req.body ?? {}, []);
        res.json({ ok: true, session: await getService().attach(sessionId) });
    }));
    router.post('/sessions/:id/rollback', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        const input = rollbackInput(req.body);
        const service = getService();
        try { res.json({ ok: true, session: await service.rollback(sessionId, input) }); }
        catch (error) {
            if (httpCode(error) !== 'revision_conflict') throw error;
            fail(res, 409, 'revision_conflict', { session: service.snapshot(sessionId).session });
        }
    }));
    router.post('/sessions/:id/visit', asyncHandler(async (req, res) => {
        const sessionId = id(req.params['id']);
        body(req.body ?? {}, []);
        res.json({ ok: true, session: getService().visit(sessionId) });
    }));
    router.post('/permissions/:id', asyncHandler(async (req, res) => {
        const permissionId = id(req.params['id']);
        const input = body(req.body, ['sessionId', 'turnId', 'epoch', 'optionId']);
        const answer = { sessionId: id(input['sessionId']), turnId: id(input['turnId']),
            epoch: integer(input['epoch'], 'epoch'), optionId: id(input['optionId']) };
        getService().answerPermission(permissionId, answer);
        res.json({ ok: true, accepted: true });
    }));
    router.use((_req, res) => fail(res, 404, 'code_route_not_found'));
    const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
        if (res.headersSent) { next(error); return; }
        const candidate = httpStatus(error, 500);
        const status = [400, 404, 409, 410, 413, 503].includes(candidate) ? candidate : 500;
        const rawCode = httpCode(error);
        const parserType = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
        const code = parserType === 'entity.parse.failed' ? 'invalid_body'
            : parserType === 'entity.too.large' ? 'payload_too_large'
                : typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(rawCode) ? rawCode : 'code_request_failed';
        if (status >= 500) console.warn('[code:http]', code);
        fail(res, status, code);
    };
    router.use(onError);
    app.use(prefix, router);
    // A parent application's JSON parser runs before the nested router. Format
    // its errors too, without opening the Code host or changing other APIs.
    app.use(prefix, onError);
}
