import { registerSlackToolRoutes } from './src/routes/slack-tools.js';
import { SlackActionStore } from './src/slack/action-store.js';
import { SlackActionRuntime } from './src/slack/action-runtime.js';
import { getSlackSendClient } from './src/slack/send-only-client.js';
import { getSlackConnectionState } from './src/slack/bot.js';
import { SlackInteractionStore, configureSlackInteractionStore, isSlackInteractionReady } from './src/slack/interaction-store.js';
import { configureRtsOutputStore, RtsOutputStore } from './src/slack/rts-output-store.js';
import { initializeSlackOperatorAuth } from './src/slack/operator-auth.js';
import { isFullAccessRequest } from './src/http/full-access.js';
// ─── cli-jaw Server (glue + routes) ─────────────────
// All business logic lives in src/ modules.

import express from 'express';
import helmet from 'helmet';
import { log } from './src/core/logger.js';
import { openServeLog } from './src/core/serve-log.js';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { registerBrowserRoutes } from './src/routes/browser.js';
import { registerCodeRoutes } from './src/routes/code.js';
import { registerNativeCodeRoutes } from './src/routes/code-native.js';
import { createWorkerApiJsonParser } from './src/routes/code-body-parser.js';
import { createCodeHost } from './src/code-mode/host.js';
import { registerRuntimeRequestRoutes } from './src/routes/runtime-requests.js';
import { registerEmployeeRoutes } from './src/routes/employees.js';
import { registerHeartbeatRoutes } from './src/routes/heartbeat.js';
import { registerSkillRoutes } from './src/routes/skills.js';
import { registerJawMemoryRoutes } from './src/routes/jaw-memory.js';
import { registerI18nRoutes } from './src/routes/i18n.js';
import { registerOrchestrateRoutes } from './src/routes/orchestrate.js';
import { registerGoalRoutes } from './src/routes/goal.js';
import { registerTaskRoutes } from './src/routes/task.js';
import { registerBgtaskRoutes } from './src/routes/bgtask.js';
import { recoverBgTasks } from './src/bgtask/recover.js';
import { stopAllBgTasks } from './src/bgtask/runner.js';
import { registerEventsRoutes } from './src/routes/events.js';
import { registerInstanceRoutes } from './src/routes/instance.js';
import { registerChatSessionRoutes } from './src/routes/chat-sessions.js';
import { registerSessionPageRoute, registerStaticRoutes } from './src/routes/static.js';
import { registerMessageRoutes } from './src/routes/messages.js';
import { registerSearchRoutes } from './src/routes/search.js';
import { registerSystemRoutes } from './src/routes/system.js';
import { registerAgentControlRoutes } from './src/routes/agent-control.js';
import { registerCommandRoutes } from './src/routes/command.js';
import { registerGoalRunRoutes } from './src/routes/goal-run.js';
import { registerMemoryRoutes } from './src/routes/memory.js';
import { registerSettingsRoutes } from './src/routes/settings.js';
import { registerMessagingRoutes } from './src/routes/messaging.js';
import { registerAvatarRoutes } from './src/routes/avatar.js';
import { registerTraceRoutes } from './src/routes/traces.js';
import { registerLinkPreviewRoutes } from './src/routes/link-preview.js';
import { registerJawCeoRoutes } from './src/routes/jaw-ceo.js';
import { createRuntimeContextRouter } from './src/routes/runtime-context.js';
import { createSecurityAuditRouter } from './src/routes/security-audit.js';
import { getSecurityAuditLog } from './src/security/security-audit-log.js';
import { SearchCoordinator } from './src/search/coordinator.js';
import { SearchProviderRegistry } from './src/search/provider.js';
import { WikiSearchProvider } from './src/search/providers/wiki.js';
import { registerWikiRoutes } from './src/routes/wiki.js';
import {
    currentWikiStartupWarning,
    forbiddenWikiRoots,
    setForbiddenWikiRoots,
} from './src/wiki/config.js';
import { dashboardPath } from './src/manager/dashboard-home.js';
import { ChatSearchProvider } from './src/search/providers/chat.js';
import { MemorySearchProvider } from './src/search/providers/memory.js';
import { createDashboardBoardRouter } from './src/manager/board/routes.js';
import { createDashboardScheduleRouter } from './src/manager/schedule/routes.js';
import {
    ensureWorkingDirSkillsLinks, initMcpConfig, copyDefaultSkills,
} from './lib/mcp-sync.js';

// ─── src/ modules ────────────────────────────────────



import { errorHandler } from './src/http/error-middleware.js';

import { isAllowedHost, isAllowedOrigin, isPrivateIP } from './src/security/network-acl.js';
import { initBossToken } from './src/core/boss-auth.js';
import { createRateLimiter, createRateLimitMiddleware } from './src/core/rate-limit.js';
import * as browser from './src/browser/index.js';

import { ensureMemoryRuntimeReady, hasSoulFile } from './src/memory/runtime.js';
import { refreshHostToolchain } from './src/memory/host-toolchain.js';

import { loadLocales } from './src/core/i18n.js';
import {
    PROMPTS_DIR, DB_PATH, JAW_HOME,
    settings, loadSettings, saveSettings,
    ensureDirs, runMigration, TOKEN_PATH, APP_VERSION,
} from './src/core/config.js';
import { clearPidfileIfOurs, defaultLifecycleDeps, processStartedAt, writePidfile } from './src/core/instance-lifecycle.js';
import { startSettingsWatch } from './src/core/settings-watch.js';
import { startWidgetWatcher } from './src/core/widget-watcher.js';
import {
    db, getLatestAssistantMessage, closeDb,
    clearAllEmployeeSessions,
} from './src/core/db.js';
import { openUrlInBrowser } from './src/core/browser-open.js';
import {
    initPromptFiles, regenerateB,
} from './src/prompt/builder.js';

import { killAllAgents, drainRecoveredQueue, waitForAllProcessesEnd } from './src/agent/spawn.js';
import { resetAllStaleStates } from './src/orchestrator/state-machine.js';

import { submitMessage } from './src/orchestrator/gateway.js';
import { settleAllPending } from './src/orchestrator/request-registry.js';

import { applySettingsPatch } from './src/core/session-ops.js';
import { makeWebCommandCtx } from './src/cli/web-command-ctx.js';

import './src/discord/register.js'; // side-effect: registers discord transport (bot.js + discord.js load lazily on first use)
import './src/slack/register.js'; // side-effect: registers slack transport (send-handler.js loads lazily on first use)
import { initEnabledMessagingRuntimes, shutdownMessagingRuntime, hydrateTargetsFromSettings, getEnabledChannels } from './src/messaging/runtime.js';
import { initIngressJournal } from './src/messaging/durable-ingress.js';
import { initEffectClaimStore } from './src/messaging/effect-once.js';
import { initOutboundOutbox } from './src/messaging/outbound-outbox.js';
import { initQueueNoticeStore } from './src/messaging/queue-notice-store.js';
import { restoreQueueNoticesForEnabledChannels } from './src/messaging/queue-notice-boot.js';
import type { MessengerChannel } from './src/messaging/types.js';

import { startHeartbeat, stopHeartbeat, watchHeartbeatFile, closeHeartbeatWatcher } from './src/memory/heartbeat.js';
import { initAlertDelivery } from './src/agent/alert-escalation.js';

import {
    getCliModelAndEffort,
    syncMainSessionToSettings,
} from './src/core/main-session.js';

import { seedDefaultEmployees } from './src/core/employees.js';
import { buildServicePath } from './src/core/instance.js';
import { readDatabaseStorageStats } from './src/core/db-maintenance.js';
import { startTraceRetention } from './src/trace/retention.js';
import { markStaleTraceRunsInterrupted } from './src/trace/store.js';

// ─── Resolve paths ───────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up to project root (where package.json lives)
// Works from both source (server.ts) and dist (dist/server.js)
function findProjectRoot(): string {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
        if (fs.existsSync(join(dir, 'package.json'))) return dir;
        dir = dirname(dir);
    }
    return __dirname; // fallback
}
const projectRoot = findProjectRoot();

// ─── .env loader (no dependency) ─────────────────────

try {
    const envPath = join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^([A-Z_]+)=(.*)$/);
            if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2]!.trim();
        }
    }
} catch { /* no .env, that's fine */ }

process.env["PATH"] = buildServicePath(process.env["PATH"] || '');

// ─── Init ────────────────────────────────────────────

ensureDirs();
const serveLog = openServeLog(JAW_HOME);
const stopWidgetWatcher = startWidgetWatcher();
fs.mkdirSync(join(projectRoot, 'public'), { recursive: true });
runMigration(projectRoot);
loadSettings();

const PORT = process.env["PORT"] || settings["port"] || 3457;

// DB integrity check on startup
{
    const result = (db.prepare('PRAGMA quick_check').pluck().get()) as string;
    if (result !== 'ok') {
        console.error(`[db] ⚠️  INTEGRITY CHECK FAILED: ${result}`);
        console.error('[db] Database may be corrupted. Consider restoring from backup.');
    }
    const storage = readDatabaseStorageStats(db);
    if (storage.pageCount > 0 && storage.freeRatio > 0.3) {
        console.warn(
            `[db] ${storage.freelistCount}/${storage.pageCount} pages are free (${(storage.freeRatio * 100).toFixed(1)}%). Run \`jaw db maintain\` to reclaim disk space.`,
        );
    }
}

{
    const cleared = clearAllEmployeeSessions.run().changes;
    if (cleared > 0) {
        console.log(`[jaw:startup] cleared ${cleared} stale employee resume session(s)`);
    }
}

// Clean orphaned employee tmp dirs from previous crashes
{
    const { tmpdir } = await import('node:os');
    const tmpBase = tmpdir();
    try {
        const orphans = fs.readdirSync(tmpBase).filter(e => e.startsWith('jaw-emp-'));
        for (const e of orphans) {
            fs.rmSync(join(tmpBase, e), { recursive: true, force: true });
        }
        if (orphans.length) console.log(`[jaw:startup] cleaned ${orphans.length} orphaned employee tmp dir(s)`);
    } catch { /* tmpdir read may fail on restricted systems */ }
}

syncMainSessionToSettings();
try {
    ensureMemoryRuntimeReady();
    console.log('[jaw:startup] memory ready, hasSoul:', hasSoulFile());
} catch (e: unknown) {
    console.warn('[jaw:memory-init]', (e as Error).message);
}

// #299: resolve the host toolchain ONCE per start, before the first AGENTS.md
// is generated below. Not inside the prompt builder — regenerateB() runs on
// every agent spawn, and probing there would put subprocess lookups in a hot
// path. A failed scan keeps whatever the previous run learned.
try {
    refreshHostToolchain();
} catch (e: unknown) {
    console.warn('[jaw:toolchain]', (e as Error).message);
}

initPromptFiles();
regenerateB();

// Reset stale orchestration state left by unclean shutdown (single-scope: default only)
resetAllStaleStates();
markStaleTraceRunsInterrupted();


// Trace retention: prune on boot + every 6h to keep jaw.db from growing unbounded.
const traceRetention = startTraceRetention(settings["trace"]);

// ─── Express ─────────────────────────────────────────

type RemoteAccessSettings = {
    mode?: string;
    trustProxies?: boolean;
    trustForwardedFor?: boolean;
};

const remoteAccess = (settings["network"]?.remoteAccess || {}) as RemoteAccessSettings;
const app = express();
const isFullAccess = (req: express.Request) => isFullAccessRequest(req, settings['permissions']);
if (remoteAccess.mode === 'reverse-proxy' && remoteAccess.trustProxies && remoteAccess.trustForwardedFor) {
    app.set('trust proxy', 'loopback');
}
const server = createServer(app);
// 65s > any sane client/poller interval; headers > keepAlive per Node
// guidance. Defaults (5s/60s) raced undici connection reuse on transient
// stalls (260613 doc 60).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ─── Security Headers ───────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CDN 사용 중이므로 비활성
    crossOriginEmbedderPolicy: false,
}));

// ─── CORS (loopback always, LAN opt-in) ─────────────
const lanMode = process.env["JAW_LAN_MODE"] === '1';
const lanAllowed = () => lanMode || settings["network"]?.lanBypass === true;
const LAN_HINT = 'Set settings.network.bindHost="0.0.0.0" and lanBypass=true to allow LAN access.';

// Host header validation (DNS rebinding defense)
app.use((req, res, next) => {
    const host = req.headers.host;
    if (host && !isAllowedHost(host, lanAllowed())) {
        res.status(403).json({ error: 'Host not allowed', hint: LAN_HINT });
        return;
    }
    next();
});

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, req.headers.host, lanAllowed())) {
        res.status(403).json({ error: 'Origin not allowed', hint: LAN_HINT });
        return;
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename,Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});

// ─── Bearer Token Auth (CRITICAL endpoints) ─────────
const JAW_AUTH_TOKEN = process.env["JAW_AUTH_TOKEN"] || crypto.randomBytes(32).toString('hex');

// Persist the token for LAN/remote API clients (loopback bypasses auth, so
// local users never need it). The boot log's curl hint references this file;
// before it existed the hint sent operators hunting for a nonexistent path.
// Browser clients use GET /api/auth/token instead (Sec-Fetch-Site-guarded).
try {
    fs.writeFileSync(TOKEN_PATH, `${JAW_AUTH_TOKEN}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* best-effort */ }
    }
} catch (e: unknown) {
    console.warn('[jaw:auth] could not write token file:', (e as Error).message);
}

// Fail closed: Date.now() would let a recycled PID satisfy ownership later.
const startedAt = processStartedAt(process.pid);
const ownPidfileRecord = startedAt ? { pid: process.pid, startedAt, port: Number(PORT), home: JAW_HOME, version: APP_VERSION } : null;
if (ownPidfileRecord) {
    try { writePidfile(ownPidfileRecord, defaultLifecycleDeps); }
    catch (e) { console.warn('[jaw:lifecycle] could not write pidfile:', (e as Error).message); }
} else {
    console.warn('[jaw:lifecycle] no OS start time for this process; skipping pidfile. `jaw service stop` will report no-pidfile for this instance.');
}

// Boss-only dispatch token (phase 8). Server generates and stores in process.env;
// main-agent spawns inherit it, employee spawns strip it in makeCleanEnv.
initBossToken();

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const remoteIp = req.ip || req.socket?.remoteAddress || '';
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    const isLanBypass = lanAllowed() && isPrivateIP(remoteIp);
    if (isLoopback || isLanBypass) {
        return next();
    }
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (token !== JAW_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Rate Limiting (in-memory, API only) ─────────────
const rateLimiter = createRateLimiter();
const rateLimitSweepInterval = setInterval(() => rateLimiter.sweep(), 600_000);
rateLimitSweepInterval.unref();
app.use(createRateLimitMiddleware({
    authToken: JAW_AUTH_TOKEN,
    lanAllowed,
    isPrivateIp: isPrivateIP,
    limiter: rateLimiter,
}));

app.use(createWorkerApiJsonParser());

// Root + media routes → src/routes/static.ts (Phase 2 extraction).
// Must register BEFORE express.static so GET / prefers the Vite dist build.
registerStaticRoutes(app, requireAuth, { projectRoot });

app.use(express.static(join(projectRoot, 'public')));
registerSessionPageRoute(app);

// Live updates flow through GET /api/events (SSE) — the legacy WebSocket
// channel was removed in X-01. Inbound equivalents:
// send_message → POST /api/message, stop → POST /api/stop.

// ─── API Routes ──────────────────────────────────────
// Phase 2 extraction: inline handlers/helpers moved to
// src/routes/{system,instance,messages,chat-sessions,static,agent-control}.ts,
// src/http/locale.ts, src/core/session-ops.ts, src/cli/web-command-ctx.ts.

// command/commands/message → src/routes/command.ts (Phase 2 extraction)
// stop/clear/session-reset → src/routes/agent-control.ts (Phase 2 extraction)

// ─── Route modules ───────────────────────────────────
registerEmployeeRoutes(app, requireAuth);
registerHeartbeatRoutes(app, requireAuth);
registerSkillRoutes(app, requireAuth, makeWebCommandCtx);
registerJawMemoryRoutes(app, requireAuth);
registerOrchestrateRoutes(app, requireAuth, { isFullAccess });
registerGoalRoutes(app, requireAuth);
registerTaskRoutes(app, requireAuth);
registerBgtaskRoutes(app, requireAuth);
registerEventsRoutes(app, requireAuth);
registerInstanceRoutes(app, requireAuth);
registerChatSessionRoutes(app, requireAuth);
registerMessageRoutes(app, requireAuth);
const searchRegistry = new SearchProviderRegistry();
searchRegistry.register(new ChatSearchProvider(settings['search'].engine));
searchRegistry.register(new MemorySearchProvider(settings['memory'].enabled));
// The placeholder is removed rather than left alongside: the registry is keyed by
// provider id, not corpus, so both would take part in every wiki query and the
// placeholder's "disabled" warning would ride along with real results.
searchRegistry.register(new WikiSearchProvider());
registerSearchRoutes(app, requireAuth, new SearchCoordinator(searchRegistry));
// The notes vault is the one root the wiki must never occupy. The path is computed
// lazily so an environment change is picked up without a restart, and passed in rather
// than imported by the wiki module so core keeps no dependency on manager config.
setForbiddenWikiRoots([dashboardPath('notes')]);
registerWikiRoutes(app, requireAuth, { forbiddenRoots: () => forbiddenWikiRoots() });
registerSystemRoutes(app, requireAuth, { jawAuthToken: JAW_AUTH_TOKEN });
registerAgentControlRoutes(app, requireAuth);
registerCommandRoutes(app, requireAuth);
registerGoalRunRoutes(app, requireAuth);
registerMemoryRoutes(app, requireAuth);
registerSettingsRoutes(app, requireAuth, applySettingsPatch, projectRoot);
try { configureRtsOutputStore(new RtsOutputStore(db)); }
catch { configureRtsOutputStore(null); log.error('[slack:privacy] output store unavailable; protected history and RTS publication disabled'); }
let validateSlackOperator: (candidate: string) => boolean = () => false;
try { validateSlackOperator = initializeSlackOperatorAuth(JAW_HOME); }
catch { log.error('[slack:operator] operator credential unavailable; operator access disabled'); }
registerMessagingRoutes(app, requireAuth, { validateSlackOperator, isFullAccess });
let slackActionStore: SlackActionStore | undefined;
try { slackActionStore = new SlackActionStore(db); }
catch { log.error('[slack:actions] action store unavailable; typed actions disabled'); }
try { configureSlackInteractionStore(new SlackInteractionStore(db), {
    getToken: () => getSlackSendClient().token ?? '',
    onVerified: (workspace, key, operation) => slackActionStore?.recordVerified(workspace, key, `${operation}.callback`),
}); }
catch { configureSlackInteractionStore(null); log.error('[slack:interactions] interaction store unavailable; choice tools disabled'); }
const slackInteractionInboundReady = () => isSlackInteractionReady() && getSlackConnectionState() === 'connected';
registerSlackToolRoutes(app, requireAuth, validateSlackOperator, slackActionStore ? {
    store: slackActionStore,
    runtime: new SlackActionRuntime({ getToken: () => getSlackSendClient().token, store: slackActionStore, evidenceSource: 'slack_api', inboundReady: slackInteractionInboundReady }),
    inboundReady: slackInteractionInboundReady,
} : undefined, { isFullAccess });
registerAvatarRoutes(app, requireAuth);
registerTraceRoutes(app, requireAuth);
registerLinkPreviewRoutes(app, requireAuth);
registerJawCeoRoutes(app, requireAuth, {
    repoRoot: projectRoot,
    listInstances: async () => [{
        port: Number(PORT),
        label: `Jaw :${PORT}`,
        status: 'online',
        ok: true,
        currentCli: settings["cli"] || null,
        currentModel: settings["cli"] ? getCliModelAndEffort(settings["cli"], settings).model : null,
        workingDir: settings["workingDir"] || null,
    }],
    fetchLatestMessage: async (targetPort) => {
        if (targetPort !== Number(PORT)) return null;
        const latestAssistant = getLatestAssistantMessage.get() as { id?: number; role?: string; content?: string | null; created_at?: string } | undefined;
        if (!latestAssistant?.id) return { latestAssistant: null, activity: null };
        return {
            latestAssistant: {
                id: Number(latestAssistant.id),
                role: 'assistant',
                ...(latestAssistant.created_at ? { created_at: String(latestAssistant.created_at) } : {}),
                text: String(latestAssistant.content || ''),
            },
            activity: null,
        };
    },
    sendWorkerMessage: async ({ port: targetPort, prompt }) => {
        if (targetPort === Number(PORT)) {
            const result = submitMessage(prompt.trim(), { origin: 'web' });
            return {
                ok: result.action !== 'rejected',
                message: result.action === 'rejected' ? result.reason || 'rejected' : 'sent',
                data: result,
            };
        }
        const response = await fetch(`http://127.0.0.1:${targetPort}/api/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await response.json().catch(() => null) as unknown;
        return {
            ok: response.ok,
            status: response.status,
            message: response.ok ? 'sent' : `worker send failed: ${response.status}`,
            data,
        };
    },
});

// ─── Runtime context + Security audit ───────────────
app.use('/api/runtime-context', requireAuth, createRuntimeContextRouter());
app.use('/api/security-audit', createSecurityAuditRouter(requireAuth));

// ─── Dashboard Board / Schedule (P3) ─────────────────
app.use('/api/dashboard/board', requireAuth, createDashboardBoardRouter());
app.use('/api/dashboard/schedule', requireAuth, createDashboardScheduleRouter());

// ─── Browser API (Phase 7) — see src/routes/browser.js
registerBrowserRoutes(app, requireAuth);
// ─── Native Code workspace and session APIs ────────────
registerCodeRoutes(app, requireAuth);
const nativeCodeHost = createCodeHost({ home: JAW_HOME, role: 'worker', port: () => {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : Number(PORT);
},
    maxConcurrentSessions: settings['code']?.['maxConcurrentSessions'], idleReapMs: settings['code']?.['idleReapMs'] });
registerNativeCodeRoutes(app, requireAuth, () => nativeCodeHost.get(), '/api/code');
registerRuntimeRequestRoutes(app, requireAuth);

registerI18nRoutes(app, requireAuth, projectRoot);

// ─── Error Handler (must be last middleware) ─────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────

watchHeartbeatFile();

// ─── Graceful Shutdown ──────────────────────────────
const shutdown = async (sig: string) => {
    console.log(`\n[server] ${sig} received, shutting down...`);
    const forceExitTimer = setTimeout(() => {
        console.warn('[server] force exit (timeout)');
        process.exit(1);
    }, 5000);
    forceExitTimer.unref();
    const codeShutdown = nativeCodeHost.dispose().catch(() => console.warn('[server] Code runtime shutdown failed'));

    try {
        getSecurityAuditLog().append('service_stop', 'server', { signal: sig, port: PORT });
    } catch { /* non-fatal */ }
    stopHeartbeat();
    closeHeartbeatWatcher();
    stopWidgetWatcher();
    clearInterval(rateLimitSweepInterval);
    traceRetention.stop();
    try { stopAllBgTasks(); } catch { /* non-fatal */ }
    killAllAgents('shutdown');
    // Tell anyone still waiting that their request died with the process. The
    // registry lives in memory, so an unannounced shutdown would leave every
    // in-flight caller hanging until its own timeout.
    try {
        const dropped = settleAllPending('dropped', 'server-shutdown');
        if (dropped > 0) console.log(`[jaw:shutdown] settled ${dropped} in-flight request(s) as dropped`);
    } catch { /* non-fatal */ }

    // No longer resetting orc_state on shutdown — 24h staleness filter handles cleanup on startup.
    // Active PABCD sessions should survive graceful restarts.

    try {
        await Promise.race([
            shutdownMessagingRuntime(),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('messaging_shutdown_timeout')), 2000);
            }),
        ]);
    } catch (e) {
        console.warn('[server] messaging shutdown failed:', (e as Error).message);
    }
    console.log('[server] messaging stopped (or timed out)');
    await codeShutdown;

    await new Promise<void>(resolve => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
    });

    // Flush WAL and close SQLite before exiting
    try {
        // killAllAgents only signalled; the exit handlers that persist the last
        // turn run after the child actually dies. Closing the database before
        // they finish threw "connection is not open" and lost that turn (#439).
        await waitForAllProcessesEnd();
        closeDb();
        console.log('[server] database closed');
    } catch (e) {
        console.warn('[server] database close failed:', (e as Error).message);
    }

    if (ownPidfileRecord) {
        try { clearPidfileIfOurs(ownPidfileRecord, defaultLifecycleDeps); }
        catch (e) { console.warn('[jaw:lifecycle] could not clear pidfile:', (e as Error).message); }
    }

    await serveLog.close();

    clearTimeout(forceExitTimer);
    process.exit(0);
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[server] FATAL uncaughtException:', err);
    try { closeDb(); } catch {} // best-effort: DB close during fatal exit
    process.exit(1);
});

const cfgBind = settings["network"]?.bindHost || '127.0.0.1';
const isLoopbackBind = cfgBind === '127.0.0.1' || cfgBind === '::1' || cfgBind === 'localhost';
const remoteMode = remoteAccess.mode && remoteAccess.mode !== 'off';
const bindHost: string = lanMode ? '0.0.0.0'
    : (remoteMode && isLoopbackBind) ? '0.0.0.0'
    : cfgBind;
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[server] port ${PORT} already in use — exiting`);
        // Platform-correct diagnostics (#383): lsof does not exist on Windows.
        if (process.platform === 'win32') {
            console.error(`[server] diagnose: netstat -ano -p tcp | findstr LISTENING | findstr :${PORT}`);
        } else {
            console.error(`[server] diagnose: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
        }
        console.error(`[server] if this is a stale cli-jaw process, stop that process and restart; no process was killed automatically`);
    } else {
        console.error('[server] listen error:', err.message);
    }
    closeDb();
    process.exit(1);
});
server.listen(PORT, bindHost, async () => {
    // Persist port so CLI commands auto-discover the running server
    const portStr = String(PORT);
    if (settings["port"] !== portStr) {
        settings["port"] = portStr;
        saveSettings(settings);
    }

    // #233: pick up external settings writes (terminal `cli-jaw project set`)
    startSettingsWatch();

    // Bootstrap i18n locale dictionaries
    loadLocales(join(projectRoot, 'public', 'locales'));
    log.info(`\n  🦈 Jaw Agent — http://localhost:${PORT}\n`);
    log.info(`  CLI:    ${settings["cli"]}`);
    log.info(`  Perms:  ${settings["permissions"]}`);
    log.info(`  CWD:    ${settings["workingDir"]}`);

    const wikiWarning = currentWikiStartupWarning();
    if (wikiWarning) log.warn(wikiWarning);

    // Stale PABCD cleanup already runs at module init (line ~195) with 24h filter

    // Warn: lanBypass=true but bindHost=127.0.0.1 → LAN unreachable
    if (settings["network"]?.lanBypass === true && bindHost === '127.0.0.1' && !lanMode) {
        log.warn('  ⚠ lanBypass is enabled but bindHost is 127.0.0.1 — LAN devices cannot connect.');
        log.warn('    → Set network.bindHost to "0.0.0.0" in settings.json, or use: cli-jaw serve --lan');
    }

    // LAN URL hints + security warnings
    if (bindHost === '0.0.0.0') {
        const { networkInterfaces } = await import('node:os');
        const nets = networkInterfaces();
        const urls: string[] = [];
        for (const iface of Object.values(nets)) {
            for (const net of iface || []) {
                if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
            }
        }
        if (urls.length) log.info(`  LAN:    ${urls.join(', ')}`);
        if (settings["network"]?.lanBypass === true) {
            log.warn('  ⚠ LAN auth bypass enabled — only enable on trusted networks.');
        }
    }
    log.info(`  DB:     ${DB_PATH}`);
    log.info(`  Prompts: ${PROMPTS_DIR}`);
    const authDesc = lanAllowed()
        ? 'token required for non-LAN requests'
        : 'token required for remote requests (localhost bypassed)';
    log.info(`  Auth:   ${JAW_AUTH_TOKEN.slice(0, 8)}... (${authDesc})`);
    log.info(`  curl:   localhost needs no token; remote: curl -H "Authorization: Bearer $(cat ${TOKEN_PATH})" http://<host>:${PORT}/api/status\n`);

    // Auto-open browser (opt-in via JAW_OPEN_BROWSER=1, set by `jaw serve --open`)
    // Skip in test environments to prevent browser tabs during npm test
    const isTestEnv = process.env["NODE_ENV"] === 'test'
        || (process.env["npm_lifecycle_event"] || '').includes('test');
    if (process.env["JAW_OPEN_BROWSER"] === '1' && !isTestEnv) {
        const url = `http://localhost:${PORT}`;
        openUrlInBrowser(url, { logPrefix: 'serve' });
    }

    try {
        initMcpConfig(settings["workingDir"]);
        const symlinks = ensureWorkingDirSkillsLinks(settings["workingDir"], { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
        copyDefaultSkills();
        const moved = (symlinks?.links || []).filter(x => x.action === 'backup_replace');
        if (moved.length) {
            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-jaw/backups/skills-conflicts`);
        }
        console.log(`  MCP:    ~/.cli-jaw/mcp.json`);
    } catch (e: unknown) { console.error('[mcp-init]', (e as Error).message); }

    hydrateTargetsFromSettings(settings);
    // Children first, journal second. The journal's constructor asserts that every
    // table with a foreign key into it has registered a retention predicate, and a
    // predicate is only registered by its owning store's constructor. On a FRESH
    // database the old order survived by accident — the child tables did not exist
    // yet, so the assert found nothing to complain about. On any host that has
    // already run this version once, the tables are on disk while the registry is
    // empty at process start, so the assert threw and took the whole boot with it:
    // messaging never initialized and every channel silently went dark.
    //
    // Creating the stores first is also the honest order — the guard is meant to
    // prove the children announced themselves, which it cannot do before they exist.
    initEffectClaimStore(db);
    initOutboundOutbox(db);
    // Before the transports start, for the same reason as the journal: a queued
    // turn can post its notice the moment inbound is live, and the record has to
    // be reservable by then (#418).
    initQueueNoticeStore(db);
    // Before any transport starts: the journal must exist for the first inbound event,
    // and the connection is handed in rather than imported so the module stays testable
    // against a temporary database.
    initIngressJournal(db);
    const messagingBoot = await initEnabledMessagingRuntimes();
    // Only `failed` is an incident. An outbound-only Slack install and a deliberate
    // non-attach instance are operator choices; shouting `init failed` at them on
    // every boot teaches people to skip this line when it finally matters.
    for (const [channel, outcome] of Object.entries(messagingBoot)) {
        if (outcome.started) continue;
        if (!getEnabledChannels().includes(channel as MessengerChannel)) continue;
        if (outcome.reason === 'failed') {
            const detail = outcome.detail ? `: ${outcome.detail}` : '';
            console.error(`[messaging:boot:${channel}] init failed${detail}; other gateways remain active`);
        } else {
            console.log(`[messaging:boot:${channel}] inbound not started (${outcome.reason})`);
        }
    }

    // The transports are up and settings are loaded, so a message recovered from
    // the previous run finally has somewhere to answer. Nothing on the boot path
    // used to start the queue, so those messages waited for a NEW one to drag
    // them out — from the outside, the bot had just gone quiet (#407).
    //
    // Before the drain, not after: the drain re-runs those turns and posts fresh
    // answers, so a notice from the PREVIOUS run has to be closed out first or the
    // channel shows an answer sitting under a notice that still claims to be
    // waiting. Awaited because ordering is the whole point (#418).
    await restoreQueueNoticesForEnabledChannels();
    drainRecoveredQueue();

    try {
        getSecurityAuditLog().append('service_start', 'server', { port: PORT, cli: settings["cli"] });
    } catch { /* non-fatal */ }

    initAlertDelivery();

    // Provider live-model inventory (Cursor/Grok CLI probes) is owned by host
    // activation — startup, here — never by a catalog read (src/code-mode/host.ts).
    void nativeCodeHost.prime().catch(() => { /* static registry lists stand */ });

    // ─── Seed default employees if none exist ────────
    const seeded = await seedDefaultEmployees();
    if (seeded.seeded > 0) {
        console.log(`  Agents: seeded ${seeded.seeded} default employees (CLI: ${seeded.cli})`);
    }
    startHeartbeat();
    try {
        const resumed = browser.webAi.resumeStoredWatchers(browser.getActivePort());
        if (resumed.watchers?.length) {
            log.info(`  WebAI: resumed ${resumed.watchers.length} stored watcher(s)`);
        }
    } catch (e: unknown) {
        log.warn(`  WebAI: watcher resume skipped (${(e as Error).message})`);
    }
    recoverBgTasks().catch((e: Error) => log.warn(`  bgtask: recovery skipped (${e.message})`));

    // ─── Migrate Korean agent names → English ────────
    const NAME_MAP: Record<string, string> = { '프런트': 'Frontend', '프론트': 'Frontend', '백엔드': 'Backend', '데이터': 'Data', '문서': 'Docs', '독스': 'Docs' };
    const allEmps = db.prepare('SELECT id, name FROM employees').all() as Array<{ id: string; name: string }>;
    let migrated = 0;
    for (const emp of allEmps) {
        const en = NAME_MAP[emp.name];
        if (en) { db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(en, emp.id); migrated++; }
    }
    if (migrated > 0) console.log(`  Agents: migrated ${migrated} Korean names → English`);

    // ─── Migrate legacy Claude employee model values → aliases ────────
    const claudeModelMigrations = [
        ['claude-sonnet-4-6', 'sonnet'],
        ['claude-opus-4-6', 'opus'],
        ['claude-sonnet-4-6[1m]', 'sonnet[1m]'],
        ['claude-opus-4-6[1m]', 'opus[1m]'],
    ];
    let empModelMigrated = 0;
    for (const [old, next] of claudeModelMigrations) {
        const r = db.prepare(`UPDATE employees SET model = ? WHERE cli = 'claude' AND model = ?`).run(next, old);
        empModelMigrated += r.changes;
    }
    if (empModelMigrated > 0) console.log(`  Agents: migrated ${empModelMigrated} legacy Claude model values → aliases`);
});
