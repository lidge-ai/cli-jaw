import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { fail, ok } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';
import {
    settings,
    JAW_HOME,
    isSettingsPersistenceBlocked,
    configuredSlackEnvironmentVariables,
    slackEnvironmentManagedPatchPaths,
    configuredTelegramEnvironmentVariables,
    telegramEnvironmentManagedPatchPaths,
    configuredDiscordEnvironmentVariables,
    discordEnvironmentManagedPatchPaths,
    wikiRouteManagedPatchPaths,
} from '../core/config.js';
import { sanitizeSettingsInput } from '../core/settings-merge.js';
import { readCodexContextWindow } from '../core/codex-config.js';
import { regenerateB, getGeneratedPromptProof, A2_PATH, HEARTBEAT_PATH } from '../prompt/builder.js';
import { clearTemplateCache, getTemplateDir } from '../prompt/template-loader.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { readClaudeCreds, readCodexTokens, fetchClaudeUsage, fetchCodexUsage, fetchGrokStatus } from './quota.js';
import { fetchCursorUsage } from './quota-cursor-dashboard.js';
import { fetchAgyUsage } from './quota-agy-reverse.js';
import { fetchKiroUsage } from './quota-kiro-reverse.js';
import { CLI_KEYS } from '../cli/registry.js';
import { fetchOpenCodeUsage } from './quota-opencode-go-api.js';
import { buildLiveCliRegistry } from '../cli/registry-live.js';
import { getCachedCliStatus, getCachedCliStatusForced } from '../cli/cli-status.js';
import { isSwitchableNativeCli, runtimeSelectionStatus } from '../agent/runtime/selection.js';
import { nativeStartFailure } from '../agent/runtime/start-failure.js';
import { fetchCopilotQuota, refreshCopilotFromKeychain } from '../../lib/quota-copilot.js';
import { extractOpenAiApiKey, hasInvalidOpenAiApiKeyInput } from '../jaw-ceo/openai-key.js';
import { getSecurityAuditLog } from '../security/security-audit-log.js';
import { SLACK_ALLOWLIST_MAX } from '../slack/events.js';
import { classifyAllowlistChange, noteAllowlistMove, recordAllowlistNarrowing } from '../slack/allowlist-audit.js';
import { pickFolderNative } from '../core/folder-picker.js';
import { getProjectGitSummary } from '../project-git-summary.js';
import { log } from '../core/logger.js';
import {
    discoverPiProfileModels,
    listPiModels,
    normalizePiProfile,
    normalizePiSettings,
    redactPiSettings,
    type PiProfile,
} from '../agent/pi-runtime.js';
import {
    resolveRuntimeDefaultMigration,
    RuntimeDefaultMigrationTerminalError,
    withRuntimeDefaultMigrationLock,
    type RuntimeDefaultMigrationAction,
    resolveMultiSessionDefaultMigration,
    MultiSessionDefaultMigrationTerminalError,
    withMultiSessionDefaultMigrationLock,
    type MultiSessionDefaultMigrationAction,
} from '../core/runtime-settings.js';
import { isMessengerChannel } from '../core/config.js';

const SERVER_OWNED_SETTINGS_KEYS = [
    'settingsSchemaVersion',
    'runtimeDefaultMigration',
    'multiSessionDefaultMigration',
    'nativeTransportMigration',
    'maxConcurrentDefaultMigration',
    'slackEnvironmentVariables',
    'telegramEnvironmentVariables',
    'discordEnvironmentVariables',
] as const;

function redactSttSettings(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!input) return input;
    const gKey = String(input["geminiApiKey"] || process.env["GEMINI_API_KEY"] || '');
    const oKey = String(input["openaiApiKey"] || '');
    return {
        ...input,
        geminiApiKey: undefined,
        geminiKeySet: !!gKey,
        geminiKeyLast4: gKey.slice(-4) || '',
        openaiApiKey: undefined,
        openaiKeySet: !!oKey,
        openaiKeyLast4: oKey.slice(-4) || '',
    };
}

function redactJawCeoSettings(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!input) return input;
    const settingsKey = extractOpenAiApiKey(input["openaiApiKey"]);
    const envKey = extractOpenAiApiKey(process.env["OPENAI_API_KEY"]);
    const key = envKey || settingsKey;
    return {
        ...input,
        openaiApiKey: undefined,
        openaiKeySet: !!key,
        openaiKeyLast4: key.slice(-4) || '',
        openaiKeySource: envKey ? 'env' : settingsKey ? 'settings' : 'none',
        openaiKeyInvalid: hasInvalidOpenAiApiKeyInput(input["openaiApiKey"]),
    };
}

/** Stand-in for a secret that exists but must not travel. Non-empty so a UI
 *  testing for "is a token configured" keeps working. */
const MASKED_SECRET = '••••••••';

/** Mask credential-bearing fields in an MCP config tree.
 *
 *  Values are replaced, keys are not, so the dashboard can still show which
 *  variables a server expects without shipping their contents. */
function redactMcpSecrets(config: unknown): unknown {
    if (!config || typeof config !== 'object') return config;
    if (Array.isArray(config)) return config.map(redactMcpSecrets);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if ((key === 'env' || key === 'headers') && value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .map(([k, v]) => [k, typeof v === 'string' && v ? MASKED_SECRET : v]),
            );
        } else if (key === 'oauth' && value) {
            out[key] = MASKED_SECRET;
        } else {
            out[key] = redactMcpSecrets(value);
        }
    }
    return out;
}

function blankEnvironmentOwnedMessagingFields(safe: {
    telegram?: Record<string, unknown>;
    telegramEnvironmentVariables?: string[];
    discord?: Record<string, unknown>;
    discordEnvironmentVariables?: string[];
}): void {
    const telegramEnvironmentVariables = configuredTelegramEnvironmentVariables();
    safe.telegramEnvironmentVariables = telegramEnvironmentVariables;
    if (telegramEnvironmentVariables.length > 0 && safe.telegram) {
        safe.telegram = {
            ...safe.telegram,
            token: '',
            allowedChatIds: [],
        };
    }
    const discordEnvironmentVariables = configuredDiscordEnvironmentVariables();
    safe.discordEnvironmentVariables = discordEnvironmentVariables;
    if (discordEnvironmentVariables.length > 0 && safe.discord) {
        safe.discord = {
            ...safe.discord,
            token: '',
            guildId: '',
            channelIds: [],
        };
    }
}

function redactRuntimeSettings<T extends Record<string, unknown>>(input: T): T {
    const safe = { ...input } as T & {
        stt?: Record<string, unknown>;
        jawCeo?: Record<string, unknown>;
        pi?: Record<string, unknown>;
        slack?: Record<string, unknown>;
        slackEnvironmentVariables?: string[];
        telegram?: Record<string, unknown>;
        telegramEnvironmentVariables?: string[];
        discord?: Record<string, unknown>;
        discordEnvironmentVariables?: string[];
    };
    const stt = redactSttSettings(safe.stt);
    const jawCeo = redactJawCeoSettings(safe.jawCeo);
    const pi = redactPiSettings(safe.pi);
    if (stt) safe.stt = stt;
    else delete safe.stt;
    if (jawCeo) safe.jawCeo = jawCeo;
    else delete safe.jawCeo;
    if (pi) safe.pi = pi;
    else delete safe.pi;
    const slackEnvironmentVariables = configuredSlackEnvironmentVariables();
    safe.slackEnvironmentVariables = slackEnvironmentVariables;
    if (slackEnvironmentVariables.length > 0 && safe.slack) {
        safe.slack = {
            ...safe.slack,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [],
            attachPort: '',
        };
    }
    blankEnvironmentOwnedMessagingFields(safe);
    // Channel bot tokens are full account credentials, and only the Slack
    // env-managed case was being masked — a file-configured Telegram or Discord
    // token came back verbatim (#449). The UI needs to know whether a token is
    // SET, never what it is, so the boolean survives and the value does not.
    for (const channel of ['telegram', 'discord', 'slack'] as const) {
        const block = safe[channel] as Record<string, unknown> | undefined;
        if (!block || typeof block !== 'object') continue;
        const masked = { ...block };
        for (const key of ['token', 'botToken', 'appToken']) {
            if (typeof masked[key] === 'string' && masked[key]) masked[key] = MASKED_SECRET;
        }
        (safe as Record<string, unknown>)[channel] = masked;
    }
    const messaging = safe["messaging"] as { homeChannel?: unknown } | undefined;
    if (typeof messaging?.homeChannel === 'string') {
        // Deprecated v3 response alias. Never persisted; remove in the next major.
        (safe as Record<string, unknown>)["channel"] = messaging.homeChannel;
    }
    return safe as T;
}

function asPlainRecord(value: unknown): Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

// classifyAllowlistChange and recordAllowlistNarrowing live in
// src/slack/allowlist-audit.ts: the settings FILE watcher records the same
// change, and it must not import an Express route module to do it (#406).
export { classifyAllowlistChange } from '../slack/allowlist-audit.js';
export type { AllowlistChange } from '../slack/allowlist-audit.js';

/**
 * Reject a `slack.channelIds` write that is not a list of ids.
 *
 * The settings merge does not type-check channel blocks, and the gate reads a
 * non-array as "no allowlist" — which means every conversation. So a write of
 * `"C1"` or `[1,2]` would not narrow anything, it would silently WIDEN an
 * existing allowlist to everything, and `classifyAllowlistChange` would not even
 * see it as a change. Failing open on a malformed value is the one outcome this
 * whole area exists to prevent (#406).
 */
export function invalidSlackChannelIds(value: unknown): boolean {
    if (value === undefined) return false;
    if (!Array.isArray(value)) return true;
    if (value.length > SLACK_ALLOWLIST_MAX) return true;
    return value.some(id => typeof id !== 'string' || id.trim() === '');
}

function mergePiProfile(piInput: unknown, profile: PiProfile, models: string[]) {
    const pi = normalizePiSettings(piInput);
    const profiles = pi.profiles.filter((entry) => entry.id !== profile.id);
    profiles.push(profile);
    return {
        ...pi,
        defaultProfileId: profile.id,
        profiles,
        discoveredModels: {
            ...(pi.discoveredModels || {}),
            [profile.id]: models,
        },
    };
}

type QuotaStatusEntry = Record<string, unknown>;

function isQuotaStatusEntry(value: unknown): value is QuotaStatusEntry {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withQuotaMeta(result: unknown, meta: QuotaStatusEntry): QuotaStatusEntry {
    const base = isQuotaStatusEntry(result) ? result : {};
    return Object.fromEntries(
        Object.entries({ ...base, ...meta }).filter(([, value]) => value !== undefined),
    );
}

function buildStatusOnlyQuota(meta: QuotaStatusEntry): QuotaStatusEntry {
    return withQuotaMeta({
        authenticated: true,
        quotaCapable: false,
        windows: [],
    }, meta);
}

export function registerSettingsRoutes(
    app: Express,
    requireAuth: AuthMiddleware,
    applySettings: (patch: Record<string, unknown>) => Promise<unknown>,
    projectRoot: string,
): void {
    app.get('/api/settings', requireAuth, (_, res) => {
        const safe = redactRuntimeSettings(settings);
        ok(res, safe, safe);
    });

    app.put('/api/settings', requireAuth, asyncHandler(async (req, res) => {
        // Boot could not read settings.json (corrupt/future-schema file). Accepting a
        // write here would either not stick or — worse — clobber the user's real file
        // with defaults, so it is refused loudly instead of silently dropped.
        if (isSettingsPersistenceBlocked()) {
            res.status(503).json({ ok: false, error: 'settings_persistence_blocked' });
            return;
        }
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? req.body as Record<string, unknown>
            : {};
        const normalizedBody = { ...body };
        if ('channel' in normalizedBody) {
            if (!isMessengerChannel(normalizedBody["channel"])) {
                fail(res, 400, 'invalid_home_channel');
                return;
            }
            normalizedBody["messaging"] = {
                ...asPlainRecord(normalizedBody["messaging"]),
                enabledChannels: [normalizedBody["channel"]],
                homeChannel: normalizedBody["channel"],
            };
            delete normalizedBody["channel"];
            res.setHeader('Deprecation', 'true');
        }
        const wikiManagedPaths = wikiRouteManagedPatchPaths(body);
        if (wikiManagedPaths.length > 0) {
            fail(res, 409, 'wiki_configuration_requires_wiki_route', {
                managedPaths: wikiManagedPaths,
            });
            return;
        }
        const environmentManagedPaths = slackEnvironmentManagedPatchPaths(body);
        if (environmentManagedPaths.length > 0) {
            fail(res, 409, 'slack_connection_managed_by_environment', {
                environmentVariables: configuredSlackEnvironmentVariables(),
                managedPaths: environmentManagedPaths,
            });
            return;
        }
        const telegramManagedPaths = telegramEnvironmentManagedPatchPaths(body);
        if (telegramManagedPaths.length > 0) {
            fail(res, 409, 'telegram_connection_managed_by_environment', {
                environmentVariables: configuredTelegramEnvironmentVariables(),
                managedPaths: telegramManagedPaths,
            });
            return;
        }
        const discordManagedPaths = discordEnvironmentManagedPatchPaths(body);
        if (discordManagedPaths.length > 0) {
            fail(res, 409, 'discord_connection_managed_by_environment', {
                environmentVariables: configuredDiscordEnvironmentVariables(),
                managedPaths: discordManagedPaths,
            });
            return;
        }
        const sanitized = sanitizeSettingsInput(normalizedBody, 'api');
        if (SERVER_OWNED_SETTINGS_KEYS.some((key) => key in body)
            || sanitized.serverOwnedPaths.length > 0) {
            res.status(400).json({ ok: false, error: 'server_owned_settings_field' });
            return;
        }
        if (sanitized.invalidPaths.length > 0) {
            res.status(400).json({ ok: false, error: 'invalid_settings_field' });
            return;
        }
        // Captured before the write, because afterwards the previous list is gone.
        const incomingSlack = asPlainRecord((sanitized.value as Record<string, unknown>)["slack"]);
        if (invalidSlackChannelIds(incomingSlack["channelIds"])) {
            fail(res, 400, 'invalid_slack_channel_ids', {
                hint: 'slack.channelIds must be an array of conversation id strings. '
                    + `Use [] to allow every conversation. At most ${SLACK_ALLOWLIST_MAX} ids.`,
            });
            return;
        }
        const allowlistChange = classifyAllowlistChange(
            incomingSlack["channelIds"],
            settings["slack"]?.channelIds,
        );
        const result = await applySettings(sanitized.value) as Record<string, unknown>;
        try {
            const keys = Object.keys(req.body || {}).filter(k => !['stt', 'jawCeo'].includes(k));
            getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), { keys });
        } catch { /* non-fatal */ }
        recordAllowlistNarrowing(allowlistChange, String(req.ip || 'local'));
        const safe = redactRuntimeSettings(result);
        ok(res, safe);
    }));

    app.post('/api/settings/slack/reset', requireAuth, asyncHandler(async (req, res) => {
        if (isSettingsPersistenceBlocked()) {
            fail(res, 503, 'settings_persistence_blocked');
            return;
        }
        const environmentVariables = configuredSlackEnvironmentVariables();
        if (environmentVariables.length > 0) {
            fail(res, 409, 'slack_connection_managed_by_environment', { environmentVariables });
            return;
        }
        const result = await applySettings({
            slack: {
                enabled: false,
                botToken: '',
                appToken: '',
                teamId: '',
                channelIds: [],
                attachPort: '',
            },
        }) as Record<string, unknown>;
        // Reset clears the allowlist. That is a move like any other, and the
        // audit dedup has to know: without it, narrowing to the same list again
        // right after a reset read as a repeat of the first narrowing and went
        // unrecorded (#406).
        noteAllowlistMove({ kind: 'clear', from: [], to: [] });
        try {
            getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), {
                keys: ['slack'],
                action: 'reset_connection',
            });
        } catch { /* non-fatal */ }
        ok(res, redactRuntimeSettings(result));
    }));

    app.post('/api/settings/runtime-default-migration', requireAuth, asyncHandler(async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).length !== 1
            || !Object.prototype.hasOwnProperty.call(body, 'action')
            || !['accept', 'keep'].includes(body.action)) {
            res.status(400).json({ ok: false, error: 'invalid_runtime_default_migration_action' });
            return;
        }
        const action = body.action as RuntimeDefaultMigrationAction;
        await withRuntimeDefaultMigrationLock(async () => {
            let patch: Record<string, unknown>;
            try {
                patch = resolveRuntimeDefaultMigration(settings, action);
            } catch (error) {
                if (!(error instanceof RuntimeDefaultMigrationTerminalError)) throw error;
                res.status(409).json({
                    ok: false,
                    error: 'runtime_default_migration_terminal',
                    settings: redactRuntimeSettings(settings),
                });
                return;
            }
            const result = await applySettings(patch) as Record<string, unknown>;
            const migration = result["runtimeDefaultMigration"] as Record<string, unknown> | undefined;
            try {
                getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), {
                    action,
                    migrationId: migration?.["id"],
                    status: migration?.["state"],
                });
            } catch { /* non-fatal */ }
            ok(res, redactRuntimeSettings(result));
        });
    }));

    // Its own route rather than a branch on the runtime one: the two flips resolve
    // independently, and a v1 install has both pending at once. Sharing an endpoint
    // would make one answer look like an answer to the other.
    app.post('/api/settings/multi-session-default-migration', requireAuth, asyncHandler(async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).length !== 1
            || !Object.prototype.hasOwnProperty.call(body, 'action')
            || !['accept', 'keep'].includes(body.action)) {
            res.status(400).json({ ok: false, error: 'invalid_multi_session_default_migration_action' });
            return;
        }
        const action = body.action as MultiSessionDefaultMigrationAction;
        await withMultiSessionDefaultMigrationLock(async () => {
            let patch: Record<string, unknown>;
            try {
                patch = resolveMultiSessionDefaultMigration(settings, action);
            } catch (error) {
                if (!(error instanceof MultiSessionDefaultMigrationTerminalError)) throw error;
                res.status(409).json({
                    ok: false,
                    error: 'multi_session_default_migration_terminal',
                    settings: redactRuntimeSettings(settings),
                });
                return;
            }
            const result = await applySettings(patch) as Record<string, unknown>;
            const migration = result["multiSessionDefaultMigration"] as Record<string, unknown> | undefined;
            try {
                getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), {
                    action,
                    migrationId: migration?.["id"],
                    status: migration?.["state"],
                });
            } catch { /* non-fatal */ }
            ok(res, redactRuntimeSettings(result));
        });
    }));

    // #233 follow-up: open the OS folder chooser and apply the picked folder
    // as the project root. The dialog blocks until the user answers, so the
    // request can stay open for minutes — that is expected.
    app.post('/api/project/pick', requireAuth, asyncHandler(async (req, res) => {
        const result = await pickFolderNative();
        if (result.status === 'busy') {
            res.status(409).json({ ok: false, error: 'folder dialog already open' });
            return;
        }
        if (result.status === 'cancelled') {
            ok(res, { cancelled: true });
            return;
        }
        if (result.status === 'unavailable') {
            res.status(500).json({ ok: false, error: result.reason });
            return;
        }
        const applied = await applySettings({ projectDirs: [result.path] }) as Record<string, unknown>;
        try {
            getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), { keys: ['projectDirs'] });
        } catch { /* non-fatal */ }
        ok(res, { projectDirs: applied["projectDirs"] ?? null });
    }));

    app.get('/api/project/git-summary', requireAuth, asyncHandler(async (_req, res) => {
        res.json(await getProjectGitSummary(settings["projectDirs"]));
    }));

    app.get('/api/codex-context', requireAuth, (_, res) => {
        res.json(readCodexContextWindow());
    });

    app.get('/api/prompt', requireAuth, (req, res) => {
        const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
        res.json({ content: a2, ...(req.query['withGenerated'] === '1' ? { generated: getGeneratedPromptProof() } : {}) });
    });

    app.put('/api/prompt', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null) {
            res.status(400).json({ error: 'content required' });
            return;
        }
        fs.writeFileSync(A2_PATH, content);
        regenerateB();
        res.json({ ok: true });
    });

    app.get('/api/prompt-templates', requireAuth, (_, res) => {
        const dir = getTemplateDir();
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'));
        const templates = files.map((f: string) => ({
            id: f.replace('.md', ''),
            filename: f,
            content: fs.readFileSync(join(dir, f), 'utf8'),
        }));
        const tree = [
            {
                id: 'system', label: 'getSystemPrompt()', emoji: '🟢',
                children: ['a1-system', 'a2-default', 'orchestration', 'skills', 'heartbeat-jobs', 'heartbeat-default', 'vision-click']
            },
            {
                id: 'employee', label: 'getEmployeePrompt()', emoji: '🟡',
                children: ['employee', 'worker-context']
            },
        ];
        res.json({ templates, tree });
    });

    app.put('/api/prompt-templates/:id', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null || typeof content !== 'string') {
            res.status(400).json({ error: 'content required' });
            return;
        }
        const filename = req.params["id"] + '.md';
        if (!/^[a-z0-9-]+\.md$/.test(filename)) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const dir = getTemplateDir();
        fs.writeFileSync(join(dir, filename), content);
        const srcDir = join(projectRoot, 'src/prompt/templates');
        if (fs.existsSync(srcDir)) fs.writeFileSync(join(srcDir, filename), content);
        clearTemplateCache();
        regenerateB();
        res.json({ ok: true });
    });

    app.get('/api/heartbeat-md', requireAuth, (_, res) => {
        const content = fs.existsSync(HEARTBEAT_PATH) ? fs.readFileSync(HEARTBEAT_PATH, 'utf8') : '';
        res.json({ content });
    });

    app.put('/api/heartbeat-md', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null) {
            res.status(400).json({ error: 'content required' });
            return;
        }
        fs.writeFileSync(HEARTBEAT_PATH, content);
        res.json({ ok: true });
    });

    // MCP server definitions carry API keys in `env` and bearer tokens in
    // `headers`. Nothing masked them and the route had no guard, so the whole
    // set was readable by anyone who could reach the port (#449).
    app.get('/api/mcp', requireAuth, (_req, res) => res.json(redactMcpSecrets(loadUnifiedMcp())));

    app.put('/api/mcp', requireAuth, (req, res) => {
        const config = req.body;
        if (!config || !config.servers) {
            res.status(400).json({ error: 'servers object required' });
            return;
        }
        saveUnifiedMcp(config);
        res.json({ ok: true, servers: Object.keys(config.servers) });
    });

    app.post('/api/mcp/sync', requireAuth, (_req, res) => {
        const config = loadUnifiedMcp();
        const results = syncToAll(config);
        res.json({ ok: true, results });
    });

    app.post('/api/mcp/install', requireAuth, async (_req, res) => {
        try {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('../../lib/mcp-sync.js');
            const results = await installMcpServers(config);
            saveUnifiedMcp(config);
            const syncResults = syncToAll(config);
            res.json({ ok: true, results, synced: syncResults });
        } catch (e: unknown) {
            log.error('[mcp:install]', e);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/mcp/reset', requireAuth, (_req, res) => {
        try {
            const mcpPath = join(JAW_HOME, 'mcp.json');
            if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
            const config = initMcpConfig(settings["workingDir"]);
            const results = syncToAll(config);
            res.json({
                ok: true,
                servers: Object.keys(config.servers),
                count: Object.keys(config.servers).length,
                synced: results,
            });
        } catch (e: unknown) {
            log.error('[mcp:reset]', e);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.get('/api/mcp/registry', requireAuth, async (_, res) => {
        try {
            const { fetchMcpRegistry, fetchMcpRegistryLocal } = await import('../../lib/mcp/mcp-registry.js');
            const localCandidates = [
                join(JAW_HOME, 'mcp-ref', 'registry.json'),
                join(os.homedir(), 'Developer', 'new', '700_projects', 'mcp-ref', 'registry.json'),
            ];
            let result: Awaited<ReturnType<typeof fetchMcpRegistry>> = { entries: [], builtins: [] };
            for (const p of localCandidates) {
                result = fetchMcpRegistryLocal(p);
                if (result.entries.length) break;
            }
            if (!result.entries.length) result = await fetchMcpRegistry();
            res.json({ ok: true, ...result });
        } catch (e: unknown) {
            res.status(500).json({ ok: false, error: (e as Error).message, entries: [], builtins: [] });
        }
    });

    app.get('/api/cli-registry', requireAuth, asyncHandler(async (_, res) => {
        ok(res, await buildLiveCliRegistry());
    }));
    // `?force=1` skips the failure backoff. Retries are demand-driven with no
    // timer, so without this a user who fixed the underlying problem would keep
    // seeing the stale failure until the backoff expired, even after an
    // explicit refresh (#277).
    app.get('/api/cli-status', requireAuth, (req, res) => {
        const force = req.query['force'] === '1' || req.query['force'] === 'true';
        const cached = force ? getCachedCliStatusForced() : getCachedCliStatus();
        // `lastStartFailure` is a sibling of the cached row, never a member of it:
        // a runtime that failed to start is per-turn evidence, while the row is
        // cached binary/auth/probe readiness with its own backoff semantics (#277).
        // It is also kept out of `runtimeSelection`, which reports compiled
        // transport support and nothing about a live attempt. Absent means no
        // recorded start failure, so the key is omitted rather than sent as null.
        res.json(Object.fromEntries(Object.entries(cached).map(([cli, row]) => {
            if (!(isSwitchableNativeCli(cli) || cli === 'codex-app' || cli === 'pi')) return [cli, row];
            const runtimeSelection = runtimeSelectionStatus(cli, settings['perCli']?.[cli]?.transport);
            // Only a native run records this, so a row that is no longer native can
            // only be showing a stale native fault — misleading exactly when someone
            // is working out why the print transport is misbehaving.
            const failure = runtimeSelection.transport === 'native' ? nativeStartFailure(cli) : undefined;
            return [cli, { ...row, runtimeSelection, ...(failure ? { lastStartFailure: failure } : {}) }];
        })));
    });

    app.post('/api/pi/profiles/register', requireAuth, asyncHandler(async (req, res) => {
        const profile = normalizePiProfile(req.body);
        const nextPi = mergePiProfile(settings["pi"], profile, [profile.model]);
        const discovery = await discoverPiProfileModels(nextPi, profile);
        const models = discovery.models;
        if (!models.includes(profile.model)) {
            res.status(400).json({ ok: false, error: `Pi model discovery did not include ${profile.model}`, models });
            return;
        }
        const updated = await applySettings({
            pi: mergePiProfile(settings["pi"], profile, models),
            perCli: {
                pi: {
                    provider: profile.id,
                    model: profile.model,
                },
            },
        }) as Record<string, unknown>;
        const redactedProfile = redactPiSettings({ defaultProfileId: profile.id, profiles: [profile] })['profiles'];
        ok(res, {
            profile: Array.isArray(redactedProfile) ? redactedProfile[0] : null,
            models,
            modelSource: discovery.source,
            settings: redactRuntimeSettings(updated),
        });
    }));

    app.get('/api/pi/models', requireAuth, asyncHandler(async (req, res) => {
        const piSettings = normalizePiSettings(settings["pi"]);
        const explicit = typeof req.query['profile'] === 'string' && Boolean(req.query['profile'].trim());
        const profile = explicit
            ? (req.query['profile'] as string).trim()
            : piSettings.defaultProfileId;
        const target = piSettings.profiles.find((entry) => entry.id === profile);
        if (explicit && !target) {
            res.status(400).json({ ok: false, error: `Unknown pi profile: ${profile}` });
            return;
        }
        const selected = target || piSettings.profiles[0];
        const discovery = selected
            ? await discoverPiProfileModels(piSettings, selected)
            : { models: await listPiModels(piSettings, profile), source: 'pi-offline' as const };
        ok(res, {
            profile: selected?.id || profile,
            models: discovery.models,
            modelSource: discovery.source,
        });
    }));

    app.get('/api/quota', requireAuth, async (_, res) => {
        const claudeCreds = readClaudeCreds();
        const codexTokens = readCodexTokens();
        const settleQuota = (read: () => Promise<unknown>) => Promise.resolve().then(read)
            .catch(() => ({ error: true, reason: 'quota_fetch_failed' }));
        const [claudeResult, codexResult, copilotResult, cursorQuota, agyQuota, kiroQuota, opencodeQuota, grokQuota] = await Promise.all([
            settleQuota(() => fetchClaudeUsage(claudeCreds)),
            settleQuota(() => fetchCodexUsage(codexTokens)),
            settleQuota(() => fetchCopilotQuota()),
            settleQuota(() => fetchCursorUsage()),
            settleQuota(() => fetchAgyUsage()),
            settleQuota(() => fetchKiroUsage()),
            settleQuota(() => fetchOpenCodeUsage()),
            settleQuota(() => fetchGrokStatus()),
        ]);

        const classify = (result: unknown, hasCreds: boolean) =>
            result ?? (hasCreds ? { error: true } : { authenticated: false });

        const claudeQuota = classify(claudeResult, !!claudeCreds);
        const codexQuota = classify(codexResult, !!codexTokens);
        const copilotQuota = copilotResult ?? { authenticated: false };
        const opencodeQuotaResolved = opencodeQuota ?? buildStatusOnlyQuota({
            quotaSource: 'not-exposed-by-opencode-cli',
            displayTier: 'OpenCode',
            account: { type: 'opencode', tier: 'auth/status only' },
        });
        const quotaByCli: Record<string, unknown> = {
            agy: agyQuota,
            claude: claudeQuota,
            codex: codexQuota,
            'codex-app': withQuotaMeta(codexQuota, {
                quotaSource: 'codex-app:underlying-codex',
                displayTier: 'Codex App → Codex',
                delegatedProvider: 'codex',
            }),
            cursor: cursorQuota,
            'kiro-code': kiroQuota,
            grok: grokQuota,
            opencode: opencodeQuotaResolved,
            copilot: copilotQuota,
        };
        res.json(Object.fromEntries(CLI_KEYS.map((key) => [key, quotaByCli[key] ?? { authenticated: false }])));
    });

    app.post('/api/copilot/refresh', requireAuth, async (_, res) => {
        try {
            const result = await refreshCopilotFromKeychain();
            res.json(result);
        } catch (e: unknown) {
            res.status(500).json({ ok: false, error: (e as Error).message });
        }
    });
}
