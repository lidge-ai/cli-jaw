// ─── Config: paths, settings, CLI detection ──────────

import { isCliEngine, isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { join } from 'path';
import { DEFAULT_CLI, buildDefaultPerCli } from '../cli/registry.js';
import { SWITCHABLE_NATIVE_CLIS, resolveRuntimeTransport } from '../agent/runtime/selection.js';
import { presentationMode } from '../shared/presentation.js';
import type { MessengerChannel } from '../messaging/types.js';
import { pickFirstReadyCli } from '../cli/readiness.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';
import { resolveHomePath } from './path-expand.js';
import {
    cloneAckDefaults,
    mergeAckSettings,
    DISCORD_ACK_DEFAULTS,
    SLACK_ACK_DEFAULTS,
    TELEGRAM_ACK_DEFAULTS,
} from '../messaging/ack-reaction.js';
import { SLACK_AUTO_JOIN_DEFAULTS, mergeSlackAutoJoin } from '../slack/auto-join.js';
import type { TrustedBotTrigger } from '../slack/events.js';
import { SETUP_STATE_FILE } from './install-integrity.js';
import {
    sanitizeSettingsInput,
    mergeSettingsLayer,
    SETTINGS_MERGE_SPEC,
    type SettingsPersistenceShape,
} from './settings-merge.js';
export { detectAllCli, detectCli } from './cli-detection.js';
import {
    areMentionWatchConditionsValid,
    areMentionWatchUserIdsValid,
} from '../slack/mention-watch-match.js';
import type { HeartbeatMentionWatchCondition } from '../slack/mention-watch-match.js';
export {
    HEARTBEAT_MENTION_WATCH_MAX_CONDITIONS,
    HEARTBEAT_MENTION_WATCH_MAX_SUBJECTS,
    isHeartbeatMentionWatchCondition,
} from '../slack/mention-watch-match.js';
export type { HeartbeatMentionWatchCondition, MentionWatchMatch } from '../slack/mention-watch-match.js';

// ─── Version (single source of truth: package.json) ──
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

function findPackageJson(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
        const candidate = join(dir, 'package.json');
        if (fs.existsSync(candidate)) return candidate;
        dir = dirname(dir);
    }
    throw new Error('package.json not found');
}
const pkg = JSON.parse(fs.readFileSync(findPackageJson(), 'utf8'));
export const APP_VERSION: string = pkg.version;

// ─── Paths ───────────────────────────────────────────

export const JAW_HOME = process.env["CLI_JAW_HOME"]
    ? resolveHomePath(process.env["CLI_JAW_HOME"])
    : join(os.homedir(), '.cli-jaw');
export const PROMPTS_DIR = join(JAW_HOME, 'prompts');
export const DB_PATH = join(JAW_HOME, 'jaw.db');
export const SETTINGS_PATH = join(JAW_HOME, 'settings.json');
// Remote-auth token file (server.ts writes JAW_AUTH_TOKEN here at boot,
// 0600). Loopback never needs it; LAN/remote API clients and operators do.
export const TOKEN_PATH = join(JAW_HOME, 'token');
export const PIDFILE_PATH = join(JAW_HOME, 'jaw.pid.json');
export const HEARTBEAT_JOBS_PATH = join(JAW_HOME, 'heartbeat.json');
export const UPLOADS_DIR = join(JAW_HOME, 'uploads');
export const WIDGETS_DIR = join(JAW_HOME, 'widgets');
export const MIGRATION_MARKER = join(JAW_HOME, '.migrated-v1');
export const SKILLS_DIR = join(JAW_HOME, 'skills');
export const SKILLS_REF_DIR = join(JAW_HOME, 'skills_ref');

// ─── Server URLs ────────────────────────────────────
export const DEFAULT_PORT = '3457';
export const CDP_PORT_OFFSET = 5783;  // 9240 - 3457
const FIRST_UNPRIVILEGED_PORT = 1024;
const UNPRIVILEGED_PORT_COUNT = 65535 - FIRST_UNPRIVILEGED_PORT + 1;

// Option D rollout: when set, /api/messages rebuilds a
// finished message's tool cards from trace_events (durable, uncapped) instead of the
// messages.tool_log blob. Default OFF — flip per-surface after parity is verified.
export const HYDRATE_TOOL_CARDS_FROM_TRACE =
    ['1', 'true', 'yes'].includes(String(process.env["JAW_HYDRATE_TOOL_CARDS_FROM_TRACE"] || '').toLowerCase());

export function deriveCdpPort(serverPort?: number | string): number {
    const port = Number(serverPort || process.env["PORT"] || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 9240;
    const cdp = port + CDP_PORT_OFFSET;
    if (cdp <= 65535) return cdp;
    return FIRST_UNPRIVILEGED_PORT
        + ((port - FIRST_UNPRIVILEGED_PORT + CDP_PORT_OFFSET) % UNPRIVILEGED_PORT_COUNT);
}

export function getServerUrl(port?: string | number) {
    // 127.0.0.1, not localhost: skips the dual-stack (::1-first) lookup and
    // the happy-eyeballs fallback on every new connection (260613 doc 60).
    return `http://127.0.0.1:${port || process.env["PORT"] || settings["port"] || DEFAULT_PORT}`;
}
export function getWsUrl(port?: string | number) {
    return `ws://127.0.0.1:${port || process.env["PORT"] || settings["port"] || DEFAULT_PORT}`;
}

/** Locate the cli-jaw package root (for bundled skills_ref/) */
export function getProjectDir() {
    return dirname(findPackageJson());
}

// ─── Project workspace dirs ─────────────────────────

export function getProjectDirs(): string[] | null {
    const dirs = settings["projectDirs"];
    if (!Array.isArray(dirs) || dirs.length === 0) return null;
    return dirs;
}

export function setProjectDirs(dirs: string[] | null): void {
    const normalized = normalizeProjectDirs(dirs);
    settings["projectDirs"] = normalized;
    saveSettings(settings);
}

export function clearProjectDirs(): void {
    setProjectDirs(null);
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const MAX_PROJECT_DIRS = 20;
const MAX_PATH_LENGTH = 4096;

export function normalizeProjectDirs(dirs: unknown): string[] | null {
    if (!Array.isArray(dirs) || dirs.length === 0) return null;
    const cleaned = dirs
        .slice(0, MAX_PROJECT_DIRS)
        .filter((d): d is string => typeof d === 'string')
        .map(d => d.trim())
        .filter(d => d.length > 0 && d.length <= MAX_PATH_LENGTH)
        .filter(d => {
            if (CONTROL_CHAR_RE.test(d)) {
                console.warn(`⚠ Skipping path with control characters: ${JSON.stringify(d)}`);
                return false;
            }
            if (!path.isAbsolute(d)) {
                console.warn(`⚠ Skipping non-absolute path: ${d}`);
                return false;
            }
            return true;
        })
        .map(d => {
            try {
                const real = fs.realpathSync.native(d);
                const stat = fs.statSync(real);
                if (!stat.isDirectory()) {
                    console.warn(`⚠ Skipping non-directory path: ${d}`);
                    return null;
                }
                return real;
            } catch {
                console.warn(`⚠ Skipping non-existent path: ${d}`);
                return null;
            }
        })
        .filter((d): d is string => d !== null);
    const deduped = [...new Set(cleaned)];
    return deduped.length > 0 ? deduped : null;
}

// ─── Ensure directories ─────────────────────────────

export function ensureDirs() {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(WIDGETS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.mkdirSync(SKILLS_REF_DIR, { recursive: true });
}

// ─── 1-time migration (Phase 9.2) ───────────────────

export function runMigration(projectDir: string) {
    if (fs.existsSync(MIGRATION_MARKER)) return;

    // Legacy claw.db → jaw.db rename (in-place)
    const legacyClaw = join(JAW_HOME, 'claw.db');
    if (fs.existsSync(legacyClaw) && !fs.existsSync(DB_PATH)) {
        fs.renameSync(legacyClaw, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyClaw + ext;
            const dst = DB_PATH + ext;
            if (fs.existsSync(src)) fs.renameSync(src, dst);
        }
        log.info('[migrate] claw.db → jaw.db');
    }

    const legacySettings = join(projectDir, 'settings.json');
    const legacyDb = join(projectDir, 'jaw.db');
    if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_PATH)) {
        fs.copyFileSync(legacySettings, SETTINGS_PATH);
        log.info('[migrate] settings.json → ~/.cli-jaw/');
    }
    if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
        fs.copyFileSync(legacyDb, DB_PATH);
        for (const ext of ['-wal', '-shm']) {
            const src = legacyDb + ext;
            if (fs.existsSync(src)) fs.copyFileSync(src, DB_PATH + ext);
        }
        log.info('[migrate] jaw.db → ~/.cli-jaw/');
    }
    fs.writeFileSync(MIGRATION_MARKER, JSON.stringify({ migratedAt: new Date().toISOString() }));
}

// ─── Settings ────────────────────────────────────────

export const SETTINGS_SCHEMA_VERSION = 4;
export const RUNTIME_DEFAULT_MIGRATION_ID = 'codex-app-default-v2' as const;
export const MULTI_SESSION_DEFAULT_MIGRATION_ID = 'multi-session-default-v3' as const;
export const NATIVE_TRANSPORT_MIGRATION_ID = 'native-transport-default-v1' as const;
export const MAX_CONCURRENT_DEFAULT_MIGRATION_ID = 'max-concurrent-default-v1' as const;
// The schema version that introduced the session-default flip. Its migration marker is
// keyed to this boundary, not to SETTINGS_SCHEMA_VERSION, so later schema bumps do not
// re-ask a question the user has already answered.
export const MULTI_SESSION_DEFAULT_SCHEMA_VERSION = 3;

export type RuntimeDefaultMigration = {
    id: typeof RUNTIME_DEFAULT_MIGRATION_ID;
    state: 'pending' | 'accepted' | 'kept' | 'already-codex-app';
    fromCli: string;
    toCli: 'codex-app';
};

export type MultiSessionDefaultMigration = {
    id: typeof MULTI_SESSION_DEFAULT_MIGRATION_ID;
    // `already-enabled` is for the opt-in user who turned sessions on before this
    // existed. Offering them a choice they already made would be noise, and accepting
    // on their behalf would change a concurrency they had set deliberately.
    state: 'pending' | 'accepted' | 'kept' | 'already-enabled';
};

export type NativeTransportMigration = {
    id: typeof NATIVE_TRANSPORT_MIGRATION_ID;
    state: 'applied' | 'already-native' | 'partial' | 'left-in-place';
    skipped?: Array<{ cli: 'cursor' | 'grok' | 'claude'; reason: string }>;
};

export type MaxConcurrentDefaultMigration = {
    id: typeof MAX_CONCURRENT_DEFAULT_MIGRATION_ID;
    state: 'applied' | 'already-at-target' | 'left-in-place';
    from?: number;
    to?: number;
};

// What multiSession meant before this flip. A document written by a schema that predates
// the new defaults must resolve absent keys to these, not to the new ones — otherwise the
// upgrade turns sessions on for someone who never asked (110 §4b-1).
export const LEGACY_MULTI_SESSION_BASELINE = {
    enabled: false,
    maxConcurrent: 1,
    midRunPolicy: 'steer' as const,
    channels: { telegram: false, discord: false, slack: true },
};

function createDefaultSettings() {
    // The registry default must stay executable, but a formerly valid explicit
    // environment selection remains an inert stored choice until replaced.
    const environmentDefaultCli = process.env['CLI_JAW_DEFAULT_CLI'];
    return {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        runtimeDefaultMigration: null as RuntimeDefaultMigration | null,
        multiSessionDefaultMigration: null as MultiSessionDefaultMigration | null,
        nativeTransportMigration: null as NativeTransportMigration | null,
        maxConcurrentDefaultMigration: null as MaxConcurrentDefaultMigration | null,
        port: '',  // persisted by server on startup; CLI commands use as fallback
        cli: isRetiredCliSelection(environmentDefaultCli) ? environmentDefaultCli : DEFAULT_CLI,
        fallbackOrder: [],
        showReasoning: false,
        permissions: 'auto',
        workingDir: JAW_HOME,
        perCli: buildDefaultPerCli(),
        presentation: { mode: 'activity' as const },
        pi: {
            defaultProfileId: 'progrok',
            profiles: [{
                id: 'progrok',
                label: 'Progrok',
                mode: 'basic',
                endpoint: 'http://127.0.0.1:18645/v1',
                apiKind: 'openai-completions',
                apiKey: 'dummy',
                model: 'grok-composer-2.5-fast',
                reasoning: true,
                supportsDeveloperRole: true,
                supportsReasoningEffort: true,
            }],
            discoveredModels: {
                progrok: ['grok-composer-2.5-fast', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
            },
        },
        heartbeat: {
            enabled: false,
            every: '30m',
            activeHours: { start: '08:00', end: '22:00' },
            target: 'all',
        },
        dispatchApproval: {
            operators: { slack: [] as string[], telegram: [] as number[], discord: [] as string[] },
            ttlSeconds: 120,
        },
        telegram: {
            enabled: false,
            token: '',
            allowedChatIds: [],
            forwardAll: true,
            allowBots: false,
            mentionOnly: true,
            // Acknowledge an inbound command by reacting to it rather than
            // posting a message. Off by default: reactions need their own
            // permission and an existing install has not granted it.
            ack: cloneAckDefaults(TELEGRAM_ACK_DEFAULTS),
        },
        discord: {
            enabled: false,
            token: '',
            guildId: '',
            channelIds: [] as string[],
            forwardAll: true,
            allowBots: false,
            mentionOnly: false,
            ack: cloneAckDefaults(DISCORD_ACK_DEFAULTS),
        },
        slack: {
            enabled: false,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [] as string[],
            forwardAll: true,
            allowBots: false,
            // Named other bots that may start a turn here. Empty means none, and
            // the inbound gate validates every rule before trusting any of them.
            trustedBotTriggers: [] as TrustedBotTrigger[],
            // Slack bots typically live in shared team channels, where
            // answering every message is antisocial. DMs bypass this gate.
            mentionOnly: true,
            // But a thread the bot participates in keeps flowing without
            // re-mention (true = strict, mention required even in threads).
            threadRequireMention: false,
            replyInThread: true,
            inboundDownloadConcurrency: 6,
            // Tell the agent WHO sent an inbound message. Off = raw ids only,
            // and no human name reaches prompts, DB rows, or broadcasts.
            senderIdentity: true,
            // Conversation context (channel, thread, participants) in the agent
            // prompt. On by default, like sender identity: without it the agent
            // is told to call /api/slack/* with a channel id nobody gave it.
            conversationContext: true,
            // The channel member summary is opt-in. A 200-person list in every
            // prompt is token waste and needless exposure; the pull endpoint
            // /api/slack/members still serves the full roster on demand.
            channelRoster: false,
            identityCacheTtlMs: 21600000,
            // Slack takes emoji NAMES without colons (reactions.add docs), so
            // these defaults are names, not unicode like the other two.
            ack: cloneAckDefaults(SLACK_ACK_DEFAULTS),
            // Public-channel auto-join. A bot token gets not_in_channel from
            // conversations.history unless it is a member, so joining is the
            // only supported way to reach a channel nobody invited it to.
            // On by default, and deliberately visible: each join posts a
            // “has joined the channel” line. maxJoinsPerRun and exclude bound
            // the blast radius; the inbound mention gate is unchanged, so this
            // widens on-demand lookup rather than making the bot answer chatter.
            autoJoin: { ...SLACK_AUTO_JOIN_DEFAULTS, exclude: [] as string[] },
        },
       messaging: {
            enabledChannels: [] as MessengerChannel[],
            homeChannel: 'telegram' as MessengerChannel,
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        },
        multiSession: {
            // Sessions are on by default as of schema v3. An existing install does not
            // get this silently: the merge substitutes the legacy baseline for its
            // cohort and asks (110 §4b).
            enabled: true,
            // 20 is the product default. Existing documents do not inherit it until
            // maxConcurrentDefaultMigration runs.
            maxConcurrent: 20,
            midRunPolicy: 'steer' as const,
            channels: { telegram: false, discord: false, slack: true },
        },
        // Opt-in Markdown vault. Default OFF and nothing is created on
        // disk until it is explicitly enabled, so a user who never turns it on sees no
        // new directory and no change in behaviour.
        wiki: {
            enabled: false,
            root: '~/jaw-wiki',
            promptDigest: false,
        },
        memory: {
            enabled: true,
            flushEvery: 10,
            cli: '',
            model: '',
            retentionDays: 30,
            flushLanguage: 'en',
            autoReflectAfterFlush: false,
            flushMessageWindow: 0,
        },
        search: { engine: 'like' as 'fts5' | 'like' },
        trace: {
            retentionDays: 7,
            maxRows: 50000,
        },
        runtime: {
            codexApp: {
                multiplex: false,
            },
        },
        code: {
            maxConcurrentSessions: 4,
            idleReapMs: 30_000,
        },
        tui: {
            pasteCollapseLines: 2,
            pasteCollapseChars: 160,
            keymapPreset: 'default',
            diffStyle: 'summary',
            themeSeed: 'jaw-default',
        },
        employees: [],
        projectDirs: null as string[] | null,
        locale: 'ko',
        avatar: {
            agent: {
                imagePath: '',
                updatedAt: null,
            },
            user: {
                imagePath: '',
                updatedAt: null,
            },
        },
        stt: {
            engine: 'auto',
            geminiApiKey: '',
            geminiModel: 'gemini-2.5-flash-lite',
            promptPath: 'prompts/stt-system.md',
            whisperModel: 'mlx-community/whisper-large-v3-turbo',
            openaiBaseUrl: '',
            openaiApiKey: '',
            openaiModel: '',
            vertexConfig: '',
        },
        jawCeo: {
            openaiApiKey: '',
        },
        network: {
            bindHost: '127.0.0.1',
            lanBypass: false,
            remoteAccess: {
                mode: 'off' as const,
                trustProxies: false,
                trustForwardedFor: false,
                publicOriginHint: '',
                requireAuth: true,
            },
        },
    };
}

export const DEFAULT_SETTINGS = createDefaultSettings();

/**
 * The keys a document must carry to legitimately claim the current schema.
 *
 * `cli-jaw init` writes a settings file, so a new install is not the ENOENT case the
 * cohort rules were written around. Left unstamped, its document reads as v1 and the
 * person who just installed is offered a migration away from a state they never had.
 * Stamping the version alone is not enough either — the loader holds a document claiming
 * this schema to what this schema writes — so the writer takes the whole set from here
 * rather than assembling it from memory (110 §4b-3).
 */
export function freshInstallSchemaFields(): {
    settingsSchemaVersion: number;
    multiSession: typeof DEFAULT_SETTINGS.multiSession;
    multiSessionDefaultMigration: MultiSessionDefaultMigration | null;
    nativeTransportMigration: NativeTransportMigration | null;
    maxConcurrentDefaultMigration: MaxConcurrentDefaultMigration | null;
} {
    // Same question as the loader asks, answered the same way: `init` running against a
    // home that already has a database is re-initialising, not installing.
    const defaults = settingsForHomeWithoutSettingsFile();
    return {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        multiSession: defaults.multiSession,
        // Null only for a home with no history — there is nothing to migrate from and
        // nothing to ask about. An established home carries the pending marker instead.
        multiSessionDefaultMigration: defaults.multiSessionDefaultMigration,
        nativeTransportMigration: defaults.nativeTransportMigration,
        maxConcurrentDefaultMigration: defaults.maxConcurrentDefaultMigration,
    };
}

// Things a home only has once someone has set it up or used it. A settings file can be
// deleted, lost to a failed write, or restored from a backup that omitted it — none of
// which makes the install new. These do not come back on their own.
//
// The list errs toward "established" on purpose. Calling a new home established costs a
// question the user did not need to answer; calling an established home new turns a
// feature on for someone who was never asked. Those are not the same mistake.
//
// But erring that way only works if every entry is something postinstall CANNOT leave
// behind. `skills/`, `uploads/` and `heartbeat.json` failed that test: a plain
// `npm i -g cli-jaw` writes all three before anyone has run anything (postinstall.ts
// creates the two directories and seeds an empty `{ jobs: [] }`). With them in the list
// the very next `jaw init` asked this function whether the home was new, and the answer
// was drawn from files the installer had just written — so EVERY new install read as
// established and silently got the pre-v3 session defaults plus a pending marker asking
// about a migration it never had (#401). A conservative test that always answers the
// same way is not conservative, it is a constant.
const ESTABLISHED_HOME_ARTIFACTS = [
    DB_PATH,
    MIGRATION_MARKER,
    PROMPTS_DIR,
    // `jaw init` leaves this behind, and an init-only home whose settings file was then
    // lost is exactly the case that must not read as new.
    join(JAW_HOME, SETUP_STATE_FILE),
    WIDGETS_DIR,
];

/**
 * An absent settings file is not proof of a new install, and the difference decides
 * whether sessions start on. Getting it wrong turns a feature on for someone who was
 * never asked, which is the one outcome the whole migration exists to prevent — so the
 * question is answered from the home directory rather than from one file in it.
 */
export function isEstablishedHome(): boolean {
    return ESTABLISHED_HOME_ARTIFACTS.some(path => fs.existsSync(path));
}

/**
 * What a home with no readable settings should start with. A home that has been used
 * before gets the previous meaning plus a pending marker, so it is asked like any other
 * upgrade; only a home with no history at all gets the new defaults.
 */
export function settingsForHomeWithoutSettingsFile(): ReturnType<typeof createDefaultSettings> {
    const next = createDefaultSettings();
    if (!isEstablishedHome()) {
        next.nativeTransportMigration = {
            id: NATIVE_TRANSPORT_MIGRATION_ID,
            state: 'already-native',
        };
        next.maxConcurrentDefaultMigration = {
            id: MAX_CONCURRENT_DEFAULT_MIGRATION_ID,
            state: 'already-at-target',
            from: next.multiSession.maxConcurrent,
            to: next.multiSession.maxConcurrent,
        };
        return next;
    }
    for (const cli of SWITCHABLE_NATIVE_CLIS) {
        next.perCli[cli] = { ...next.perCli[cli]!, transport: 'print' };
    }
    next.multiSession = { ...next.multiSession, ...LEGACY_MULTI_SESSION_BASELINE };
    next.multiSessionDefaultMigration = {
        id: MULTI_SESSION_DEFAULT_MIGRATION_ID,
        state: 'pending',
    };
    next.nativeTransportMigration = {
        id: NATIVE_TRANSPORT_MIGRATION_ID,
        state: 'left-in-place',
    };
    next.maxConcurrentDefaultMigration = {
        id: MAX_CONCURRENT_DEFAULT_MIGRATION_ID,
        state: 'left-in-place',
        from: 1,
    };
    return next;
}

export function normalizeModelForCli(cli: string, model: unknown): unknown {
    if (typeof model !== 'string') return model;
    if (cli === 'claude' || cli === 'claude-e') return migrateLegacyClaudeValue(model);
    if (cli === 'copilot' && model === 'claude-opus-4.6-fast') return 'claude-opus-4.6';
    return model;
}

function normalizePerCliModels(perCli: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(perCli)) {
        const provider = cli === 'ai-e' && typeof cfg?.provider === 'string' ? cfg.provider : undefined;
        next[cli] = {
            ...cfg,
            model: provider === 'claude'
                ? migrateLegacyClaudeValue(cfg?.model || '')
                : normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

function normalizeActiveOverrides(activeOverrides: Record<string, any> = {}, perCli: Record<string, any> = {}) {
    const next: Record<string, any> = {};
    for (const [cli, cfg] of Object.entries(activeOverrides)) {
        const provider = cli === 'ai-e'
            ? (typeof cfg?.provider === 'string' ? cfg.provider : typeof perCli['ai-e']?.provider === 'string' ? perCli['ai-e'].provider : undefined)
            : undefined;
        next[cli] = {
            ...cfg,
            model: provider === 'claude'
                ? migrateLegacyClaudeValue(cfg?.model || '')
                : normalizeModelForCli(cli, cfg?.model),
        };
    }
    return next;
}

/** @internal — exported for unit testing */
const MESSENGER_CHANNELS = ['telegram', 'discord', 'slack'] as const;
export const isMessengerChannel = (value: unknown): value is MessengerChannel =>
    MESSENGER_CHANNELS.includes(value as MessengerChannel);

export function migrateSettings(s: Record<string, any>, sourceVersion = readSettingsSchemaVersion(s)) {
    s['presentation'] = {
        ...(isPlainRecord(s['presentation']) ? s['presentation'] : {}),
        mode: presentationMode(s),
    };
    // Whatever the document claimed on the way in, what leaves this function is written
    // by the current schema and says so. Individual markers below key off `sourceVersion`,
    // which was read before this line, so stamping here does not disarm them.
    s["settingsSchemaVersion"] = SETTINGS_SCHEMA_VERSION;
    if (s["planning"]) {
        if (s["planning"].cli && s["planning"].cli !== s["cli"]) s["cli"] = s["planning"].cli;
        if (isRetiredCliSelection(s['cli'])) {
            s['perCli'] ??= {};
            s['perCli'][s['cli']] ??= {};
        }
        if (s["planning"].model && s["planning"].model !== 'default') {
            const target = s["perCli"]?.[s["cli"]];
            if (target) target.model = s["planning"].model;
        }
        if (s["planning"].effort) {
            const target = s["perCli"]?.[s["cli"]];
            if (target) target.effort = s["planning"].effort;
        }
        delete s["planning"];
    }

    if (sourceVersion === 1) {
        const fromCli = (isCliEngine(s["cli"]) || isRetiredCliSelection(s["cli"])) ? s["cli"] : 'claude';
        s["cli"] = fromCli;
        s["settingsSchemaVersion"] = SETTINGS_SCHEMA_VERSION;
        s["runtimeDefaultMigration"] = {
            id: RUNTIME_DEFAULT_MIGRATION_ID,
            state: fromCli === 'codex-app' ? 'already-codex-app' : 'pending',
            fromCli,
            toCli: 'codex-app',
        } satisfies RuntimeDefaultMigration;
    } else {
        validateRuntimeDefaultMigration(s["runtimeDefaultMigration"]);
    }

    // The session-default flip is its own migration with its own marker. It is NOT
    // folded into the runtime one: the two flips can be rolled back at different times
    // for different reasons, and a shared marker would make that impossible to express.
    // A v1 document crosses both boundaries and so gets both markers in this one pass.
    //
    // The boundary is the version that introduced the flip (3), NOT the current schema
    // version. Pinning it to the current version would re-fire this marker on every
    // later bump and silently overwrite an answer the user already gave.
    if (sourceVersion < MULTI_SESSION_DEFAULT_SCHEMA_VERSION) {
        s["multiSessionDefaultMigration"] = {
            id: MULTI_SESSION_DEFAULT_MIGRATION_ID,
            // Someone who already turned sessions on made this decision before we asked.
            // Offering it again would be noise, and accepting for them would change a
            // concurrency they chose.
            state: s["multiSession"]?.enabled === true ? 'already-enabled' : 'pending',
        } satisfies MultiSessionDefaultMigration;
    } else {
        validateMultiSessionDefaultMigration(s["multiSessionDefaultMigration"]);
    }
    validateNativeTransportMigration(s["nativeTransportMigration"]);
    validateMaxConcurrentDefaultMigration(s["maxConcurrentDefaultMigration"]);

    // A pending marker means the user has not answered yet, so sessions being on
    // contradicts it. The dedicated accept route moves both together, but it is not the
    // only way in: the settings watcher merges an external file write, and a generic
    // settings patch can set `multiSession.enabled` directly. Both strip the marker as
    // server-owned and then leave this pair inconsistent — enabled, and still pending.
    //
    // Resolved by treating an enable while pending AS the answer rather than by refusing
    // it. Someone who reaches in and turns it on has decided; what must not survive is a
    // marker that still claims to be waiting, because the next boot would ask again and
    // the record would no longer mean anything.
    const sessionMigration = s["multiSessionDefaultMigration"] as MultiSessionDefaultMigration | null | undefined;
    if (sessionMigration?.state === 'pending' && s["multiSession"]?.enabled === true) {
        s["multiSessionDefaultMigration"] = { ...sessionMigration, state: 'accepted' };
    }

    // Claude model alias migration
    s["perCli"] = normalizePerCliModels(s["perCli"] || {});
    s["activeOverrides"] = normalizeActiveOverrides(s["activeOverrides"] || {}, s["perCli"] || {});
    if (typeof s["memory"]?.cli === 'string' && typeof s["memory"]?.model === 'string') {
        s["memory"].model = normalizeModelForCli(s["memory"].cli, s["memory"].model);
    }

    // v3 channel -> v4 messaging gateway migration.
    const messaging = s["messaging"] && typeof s["messaging"] === 'object'
        ? s["messaging"]
        : {};
    const legacyChannel: MessengerChannel = isMessengerChannel(s["channel"])
        ? s["channel"]
        : 'telegram';

    if (sourceVersion < 4 || !Array.isArray(messaging.enabledChannels)) {
        // A v3 document has no enabled set yet, so deriving one from the legacy
        // scalar is the migration. A v4 document that reaches here has a MALFORMED
        // set, and `legacyChannel` is always 'telegram' by then because the key it
        // reads was deleted during the v3 migration — so silently "repairing" it
        // would hand a Slack install a Telegram gateway (#445). Preserve whatever
        // channels are still recognisable instead.
        if (sourceVersion >= 4 && messaging.enabledChannels !== undefined) {
            const salvaged = (Array.isArray(messaging.enabledChannels)
                ? messaging.enabledChannels
                : [messaging.enabledChannels]).filter(isMessengerChannel);
            messaging.enabledChannels = salvaged.length ? [...new Set(salvaged)] : [legacyChannel];
        } else {
            messaging.enabledChannels = [legacyChannel];
        }
    } else {
        messaging.enabledChannels = [...new Set(
            messaging.enabledChannels.filter(isMessengerChannel),
        )];
    }
    if (!isMessengerChannel(messaging.homeChannel)) {
        messaging.homeChannel = legacyChannel;
    }
    if (!messaging.enabledChannels.includes(messaging.homeChannel)
        && messaging.enabledChannels.length > 0) {
        messaging.homeChannel = messaging.enabledChannels[0];
    }
    s["messaging"] = messaging;
    delete s["channel"];

    // Telegram mentionOnly migration — existing users had hardcoded always-on behavior
    if (s["telegram"] && s["telegram"].mentionOnly === undefined) {
        s["telegram"].mentionOnly = true;
    }
    // Telegram allowBots migration — added with the self-echo guard (260802).
    // Defaults to false to match Discord: another bot in the group is not a
    // user, and answering one is how loops start.
    if (s["telegram"] && s["telegram"].allowBots === undefined) {
        s["telegram"].allowBots = false;
    }
    // Slack channel migration — added 260802, absent from all prior settings files
    if (!s["slack"]) {
        s["slack"] = {
            enabled: false,
            botToken: '',
            appToken: '',
            teamId: '',
            channelIds: [],
            forwardAll: true,
            allowBots: false,
            mentionOnly: true,
            replyInThread: true,
            inboundDownloadConcurrency: 6,
        };
    }
    // Sender identity migration — added 260811, absent from all prior files.
    if (s["slack"].senderIdentity === undefined) s["slack"].senderIdentity = true;
    // Conversation context migration — added 260812. An existing install gets
    // the block on (like sender identity) and the roster off.
    if (s["slack"].conversationContext === undefined) s["slack"].conversationContext = true;
    if (s["slack"].channelRoster === undefined) s["slack"].channelRoster = false;
    if (!Number.isFinite(s["slack"].identityCacheTtlMs) || s["slack"].identityCacheTtlMs <= 0) {
        s["slack"].identityCacheTtlMs = 21600000;
    }
    if (!Number.isInteger(s["slack"].inboundDownloadConcurrency)
        || s["slack"].inboundDownloadConcurrency < 1
        || s["slack"].inboundDownloadConcurrency > 32) {
        s["slack"].inboundDownloadConcurrency = 6;
    }
    if (!s["messaging"]) {
        s["messaging"] = {
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        };
    } else {
        // Existing installs already have a messaging block; a bare
        // `if (!s["messaging"])` would never add the slack slot for them.
        if (s["messaging"].latestSeen && s["messaging"].latestSeen.slack === undefined) {
            s["messaging"].latestSeen.slack = null;
        }
        if (s["messaging"].lastActive && s["messaging"].lastActive.slack === undefined) {
            s["messaging"].lastActive.slack = null;
        }
    }
    if (!s["multiSession"]) {
        s["multiSession"] = createDefaultSettings().multiSession;
    } else {
        // Deliberately the OLD defaults, not createDefaultSettings(). This function takes
        // an already-merged object and cannot tell which cohort it came from, so handing
        // out the new defaults here would enable sessions for a legacy document that
        // reached this line by some path other than the boot merge. The boot merge fills
        // both keys from the cohort baseline, which makes these two lines unreachable on
        // the normal path — they are the net under it, and a net set to the new defaults
        // is not a net (110 §4b-2).
        if (s["multiSession"].enabled === undefined) {
            s["multiSession"].enabled = LEGACY_MULTI_SESSION_BASELINE.enabled;
        }
        if (s["multiSession"].maxConcurrent === undefined) {
            s["multiSession"].maxConcurrent = LEGACY_MULTI_SESSION_BASELINE.maxConcurrent;
        }
        if (s["multiSession"].midRunPolicy === undefined) s["multiSession"].midRunPolicy = 'steer';
        if (s["multiSession"].channels === undefined) {
            s["multiSession"].channels = { telegram: false, discord: false, slack: true };
        } else {
            if (s["multiSession"].channels.telegram === undefined) s["multiSession"].channels.telegram = false;
            if (s["multiSession"].channels.discord === undefined) s["multiSession"].channels.discord = false;
            if (s["multiSession"].channels.slack === undefined) s["multiSession"].channels.slack = true;
        }
    }
    // Repairing an invalid value means falling back to THE default, not to a
    // second opinion about what the default is (#696).
    s["multiSession"].maxConcurrent = resolveMaxConcurrent(s as Record<string, unknown>);
    if (!['steer', 'followup', 'collect', 'interrupt'].includes(s["multiSession"].midRunPolicy)) {
        s["multiSession"].midRunPolicy = 'steer';
    }
    if (!s["jawCeo"]) {
        s["jawCeo"] = { openaiApiKey: '' };
    }
    if (!s["pi"]) {
        s["pi"] = createDefaultSettings().pi;
    }
    return s;
}

export const SLACK_CONNECTION_ENV_KEYS = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_TEAM_ID',
    'SLACK_CHANNEL_IDS',
] as const;

export const SLACK_CONNECTION_SETTING_KEYS = [
    'enabled',
    'botToken',
    'appToken',
    'teamId',
    'channelIds',
    'attachPort',
] as const;

type SlackConnectionSettingKey = typeof SLACK_CONNECTION_SETTING_KEYS[number];

const SLACK_ENV_SETTING_OWNERSHIP: Record<
    typeof SLACK_CONNECTION_ENV_KEYS[number],
    readonly SlackConnectionSettingKey[]
> = {
    SLACK_BOT_TOKEN: ['enabled', 'botToken'],
    SLACK_APP_TOKEN: ['appToken'],
    SLACK_TEAM_ID: ['teamId'],
    SLACK_CHANNEL_IDS: ['channelIds'],
};

export function configuredSlackEnvironmentVariables(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return SLACK_CONNECTION_ENV_KEYS.filter((key) => Boolean(env[key]));
}

export function slackEnvironmentManagedSettingKeys(
    env: NodeJS.ProcessEnv = process.env,
): SlackConnectionSettingKey[] {
    const managed = new Set<SlackConnectionSettingKey>();
    for (const envKey of SLACK_CONNECTION_ENV_KEYS) {
        if (!env[envKey]) continue;
        for (const settingKey of SLACK_ENV_SETTING_OWNERSHIP[envKey]) managed.add(settingKey);
    }
    return [...managed];
}

export function slackEnvironmentManagedPatchPaths(
    patch: Record<string, unknown>,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const managed = new Set(slackEnvironmentManagedSettingKeys(env));
    if (managed.size === 0) return [];
    const slack = patch["slack"];
    if (!slack || typeof slack !== 'object' || Array.isArray(slack)) return [];
    return SLACK_CONNECTION_SETTING_KEYS
        .filter((key) => managed.has(key) && Object.prototype.hasOwnProperty.call(slack, key))
        .map((key) => `slack.${key}`);
}

export const TELEGRAM_CONNECTION_ENV_KEYS = [
    'TELEGRAM_TOKEN',
    'TELEGRAM_ALLOWED_CHAT_IDS',
] as const;

export const TELEGRAM_CONNECTION_SETTING_KEYS = [
    'enabled',
    'token',
    'allowedChatIds',
] as const;

type TelegramConnectionSettingKey = typeof TELEGRAM_CONNECTION_SETTING_KEYS[number];

const TELEGRAM_ENV_SETTING_OWNERSHIP: Record<
    typeof TELEGRAM_CONNECTION_ENV_KEYS[number],
    readonly TelegramConnectionSettingKey[]
> = {
    TELEGRAM_TOKEN: ['enabled', 'token'],
    TELEGRAM_ALLOWED_CHAT_IDS: ['allowedChatIds'],
};

export function configuredTelegramEnvironmentVariables(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return TELEGRAM_CONNECTION_ENV_KEYS.filter((key) => Boolean(env[key]));
}

export function telegramEnvironmentManagedSettingKeys(
    env: NodeJS.ProcessEnv = process.env,
): TelegramConnectionSettingKey[] {
    const managed = new Set<TelegramConnectionSettingKey>();
    for (const envKey of TELEGRAM_CONNECTION_ENV_KEYS) {
        if (!env[envKey]) continue;
        for (const settingKey of TELEGRAM_ENV_SETTING_OWNERSHIP[envKey]) managed.add(settingKey);
    }
    return [...managed];
}

export function telegramEnvironmentManagedPatchPaths(
    patch: Record<string, unknown>,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const managed = new Set(telegramEnvironmentManagedSettingKeys(env));
    if (managed.size === 0) return [];
    const telegram = patch["telegram"];
    if (!telegram || typeof telegram !== 'object' || Array.isArray(telegram)) return [];
    return TELEGRAM_CONNECTION_SETTING_KEYS
        .filter((key) => managed.has(key) && Object.prototype.hasOwnProperty.call(telegram, key))
        .map((key) => `telegram.${key}`);
}

export const DISCORD_CONNECTION_ENV_KEYS = [
    'DISCORD_TOKEN',
    'DISCORD_GUILD_ID',
    'DISCORD_CHANNEL_IDS',
] as const;

export const DISCORD_CONNECTION_SETTING_KEYS = [
    'enabled',
    'token',
    'guildId',
    'channelIds',
] as const;

type DiscordConnectionSettingKey = typeof DISCORD_CONNECTION_SETTING_KEYS[number];

const DISCORD_ENV_SETTING_OWNERSHIP: Record<
    typeof DISCORD_CONNECTION_ENV_KEYS[number],
    readonly DiscordConnectionSettingKey[]
> = {
    DISCORD_TOKEN: ['enabled', 'token'],
    DISCORD_GUILD_ID: ['guildId'],
    DISCORD_CHANNEL_IDS: ['channelIds'],
};

export function configuredDiscordEnvironmentVariables(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return DISCORD_CONNECTION_ENV_KEYS.filter((key) => Boolean(env[key]));
}

export function discordEnvironmentManagedSettingKeys(
    env: NodeJS.ProcessEnv = process.env,
): DiscordConnectionSettingKey[] {
    const managed = new Set<DiscordConnectionSettingKey>();
    for (const envKey of DISCORD_CONNECTION_ENV_KEYS) {
        if (!env[envKey]) continue;
        for (const settingKey of DISCORD_ENV_SETTING_OWNERSHIP[envKey]) managed.add(settingKey);
    }
    return [...managed];
}

export function discordEnvironmentManagedPatchPaths(
    patch: Record<string, unknown>,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const managed = new Set(discordEnvironmentManagedSettingKeys(env));
    if (managed.size === 0) return [];
    const discord = patch["discord"];
    if (!discord || typeof discord !== 'object' || Array.isArray(discord)) return [];
    return DISCORD_CONNECTION_SETTING_KEYS
        .filter((key) => managed.has(key) && Object.prototype.hasOwnProperty.call(discord, key))
        .map((key) => `discord.${key}`);
}

export const WIKI_ROUTE_MANAGED_SETTING_KEYS = ['enabled', 'root'] as const;

export function wikiRouteManagedPatchPaths(patch: Record<string, unknown>): string[] {
    const wiki = patch['wiki'];
    if (!wiki || typeof wiki !== 'object' || Array.isArray(wiki)) return [];
    return WIKI_ROUTE_MANAGED_SETTING_KEYS
        .filter(key => Object.prototype.hasOwnProperty.call(wiki, key))
        .map(key => `wiki.${key}`);
}

/**
 * Environment-managed channel connections have a single source of truth. Clear
 * persisted connection fields before applying the runtime-only environment
 * overlay; behavior fields such as forwardAll and mentionOnly stay editable.
 */
function clearPersistedConnectionForEnvironment(
    channel: 'slack' | 'telegram' | 'discord',
    input: Record<string, any>,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const managed = channel === 'slack' ? slackEnvironmentManagedSettingKeys(env)
        : channel === 'telegram' ? telegramEnvironmentManagedSettingKeys(env)
        : discordEnvironmentManagedSettingKeys(env);
    if (managed.length === 0) return false;
    const block = input[channel] || {};
    const changed = managed.some((key) => {
        if (key === 'enabled') return block.enabled !== false;
        const value = block[key];
        if (Array.isArray(value)) return value.length > 0;
        return Boolean(value);
    });
    for (const key of managed) delete block[key];
    input[channel] = block;
    return changed;
}

/** Apply environment variable overrides to a settings object */
/** @internal exported so the env-driven home-channel switch can be tested (#444) */
export function applyEnvOverrides(s: Record<string, any>) {
    if (process.env["TELEGRAM_TOKEN"]) {
        s["telegram"] = s["telegram"] || {};
        s["telegram"].token = process.env["TELEGRAM_TOKEN"];
        s["telegram"].enabled = true;
    }
    if (process.env["TELEGRAM_ALLOWED_CHAT_IDS"]) {
        s["telegram"] = s["telegram"] || {};
        s["telegram"].allowedChatIds = process.env["TELEGRAM_ALLOWED_CHAT_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
    }
    if (process.env["DISCORD_TOKEN"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].token = process.env["DISCORD_TOKEN"];
        s["discord"].enabled = true;
        // Auto-switch the home channel when Discord is the only configured one.
        //
        // This wrote `s["channel"]` until v4 deleted that key during migration,
        // and applyEnvOverrides runs AFTER migrateSettings — so the assignment
        // landed on a field nothing reads and the switch silently stopped
        // happening. getHomeChannel() only consults messaging.homeChannel (#444).
        if (!s["telegram"]?.token && !s["telegram"]?.enabled) {
            const messaging = isPlainRecord(s["messaging"]) ? s["messaging"] : {};
            const enabled = Array.isArray(messaging["enabledChannels"]) ? messaging["enabledChannels"] : [];
            s["messaging"] = {
                ...messaging,
                enabledChannels: [...new Set([...enabled, 'discord'])],
                homeChannel: 'discord',
            };
        }
    }
    if (process.env["DISCORD_GUILD_ID"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].guildId = process.env["DISCORD_GUILD_ID"];
    }
    if (process.env["DISCORD_CHANNEL_IDS"]) {
        s["discord"] = s["discord"] || {};
        s["discord"].channelIds = process.env["DISCORD_CHANNEL_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
    }
    // Slack: unlike Discord, presence of a token does NOT auto-switch the
    // active channel. Slack needs BOTH tokens to function, so hijacking the
    // active inbound channel from a half-configured env is a footgun.
    if (process.env["SLACK_BOT_TOKEN"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].botToken = process.env["SLACK_BOT_TOKEN"];
        s["slack"].enabled = true;
    }
    if (process.env["SLACK_APP_TOKEN"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].appToken = process.env["SLACK_APP_TOKEN"];
    }
    if (process.env["SLACK_TEAM_ID"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].teamId = process.env["SLACK_TEAM_ID"];
    }
    if (process.env["SLACK_CHANNEL_IDS"]) {
        s["slack"] = s["slack"] || {};
        s["slack"].channelIds = process.env["SLACK_CHANNEL_IDS"].split(',').map((x: string) => x.trim()).filter(Boolean);
    }
}

/** Mutable settings object — shared across all modules via ESM live binding */
export let settings: Record<string, any> = createDefaultSettings();

/** A stored block that is null or an array is a corrupt document, not an instruction.
 *
 *  The hand-rolled boot merge this replaced wrote `...(raw.telegram || {})` for
 *  every nested block, so a `"telegram": null` in settings.json quietly fell back
 *  to defaults. Carrying the null through the shared layer instead would replace
 *  the block with null and then let the normalizers below rebuild only part of it
 *  — a telegram block holding nothing but `ack`, with the bot token gone.
 *  Dropping the key restores the old meaning.
 *
 *  Only keys the merge spec names are dropped. A top-level scalar is a real value,
 *  and an API patch keeps its own semantics: there, an explicit null IS a write. */
function dropCorruptBlocks(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw };
    for (const key of Object.keys(SETTINGS_MERGE_SPEC)) {
        if (key in out && !isPlainRecord(out[key])) delete out[key];
    }
    return out;
}

/** Runtime defaults for keys whose fallback used to be re-typed at each call site.
 *
 *  The schema said multiSession.maxConcurrent was 2 while the lane allocator used
 *  ?? 1, and memory.flushEvery was declared 10 and then re-declared 10 in four
 *  other files. Changing the schema alone did nothing in the first case, because
 *  the literal at the call site won. These resolvers exist so there is exactly one
 *  answer to "what is the default", and it is the one in DEFAULT_SETTINGS. */
function resolvePositiveInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveFlushEvery(source: Record<string, unknown> = settings): number {
    const memory = source['memory'];
    return resolvePositiveInt(
        isPlainRecord(memory) ? memory['flushEvery'] : undefined,
        DEFAULT_SETTINGS.memory.flushEvery,
    );
}

export function resolveMemoryRetentionDays(source: Record<string, unknown> = settings): number {
    const memory = source['memory'];
    return resolvePositiveInt(
        isPlainRecord(memory) ? memory['retentionDays'] : undefined,
        DEFAULT_SETTINGS.memory.retentionDays,
    );
}

export function resolveMaxConcurrent(source: Record<string, unknown> = settings): number {
    const multiSession = source['multiSession'];
    return resolvePositiveInt(
        isPlainRecord(multiSession) ? multiSession['maxConcurrent'] : undefined,
        DEFAULT_SETTINGS.multiSession.maxConcurrent,
    );
}
let settingsPersistenceShape: SettingsPersistenceShape = 'absent';

export type SettingsStateCandidate = {
    value: typeof settings;
    shape: SettingsPersistenceShape;
};

function readSettingsSchemaVersion(raw: Record<string, any>): 1 | 2 | 3 | 4 {
    if (!("settingsSchemaVersion" in raw)) return 1;
    const version = raw["settingsSchemaVersion"];
    if (!Number.isInteger(version) || version < 1 || version > SETTINGS_SCHEMA_VERSION) {
        throw new Error(`unsupported_settings_schema_version:${String(version)}`);
    }
    return version as 1 | 2 | 3 | 4;
}

function validateRuntimeDefaultMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_runtime_default_migration');
    }
    const migration = value as Record<string, unknown>;
    const keys = Object.keys(migration).sort();
    const expectedKeys = ['fromCli', 'id', 'state', 'toCli'];
    const validState = ['pending', 'accepted', 'kept', 'already-codex-app'].includes(String(migration["state"]));
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
        || migration["id"] !== RUNTIME_DEFAULT_MIGRATION_ID
        || !validState
        || typeof migration["fromCli"] !== 'string'
        || migration["toCli"] !== 'codex-app') {
        throw new Error('invalid_runtime_default_migration');
    }
}

function validateMultiSessionDefaultMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_multi_session_default_migration');
    }
    const migration = value as Record<string, unknown>;
    const keys = Object.keys(migration).sort();
    const validState = ['pending', 'accepted', 'kept', 'already-enabled'].includes(String(migration["state"]));
    if (JSON.stringify(keys) !== JSON.stringify(['id', 'state'])
        || migration["id"] !== MULTI_SESSION_DEFAULT_MIGRATION_ID
        || !validState) {
        throw new Error('invalid_multi_session_default_migration');
    }
}

const NATIVE_TRANSPORT_MIGRATION_STATES = ['applied', 'already-native', 'partial', 'left-in-place'] as const;
const MAX_CONCURRENT_DEFAULT_MIGRATION_STATES = ['applied', 'already-at-target', 'left-in-place'] as const;

function validateNativeTransportMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_native_transport_migration');
    }
    const migration = value as Record<string, unknown>;
    const allowed = new Set(['id', 'state', 'skipped']);
    const keys = Object.keys(migration);
    const validState = NATIVE_TRANSPORT_MIGRATION_STATES.includes(
        migration['state'] as (typeof NATIVE_TRANSPORT_MIGRATION_STATES)[number],
    );
    if (keys.some((key) => !allowed.has(key))
        || !keys.includes('id')
        || !keys.includes('state')
        || migration['id'] !== NATIVE_TRANSPORT_MIGRATION_ID
        || !validState) {
        throw new Error('invalid_native_transport_migration');
    }
    if (!('skipped' in migration)) return;
    if (!Array.isArray(migration['skipped'])) {
        throw new Error('invalid_native_transport_migration');
    }
    for (const item of migration['skipped']) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('invalid_native_transport_migration');
        }
        const row = item as Record<string, unknown>;
        const rowKeys = Object.keys(row);
        if (rowKeys.some((key) => key !== 'cli' && key !== 'reason')
            || !rowKeys.includes('cli')
            || !rowKeys.includes('reason')
            || !SWITCHABLE_NATIVE_CLIS.includes(row['cli'] as typeof SWITCHABLE_NATIVE_CLIS[number])
            || typeof row['reason'] !== 'string') {
            throw new Error('invalid_native_transport_migration');
        }
    }
}

function validateMaxConcurrentDefaultMigration(value: unknown): void {
    if (value === null || value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_max_concurrent_default_migration');
    }
    const migration = value as Record<string, unknown>;
    const allowed = new Set(['id', 'state', 'from', 'to']);
    const keys = Object.keys(migration);
    const validState = MAX_CONCURRENT_DEFAULT_MIGRATION_STATES.includes(
        migration['state'] as (typeof MAX_CONCURRENT_DEFAULT_MIGRATION_STATES)[number],
    );
    if (keys.some((key) => !allowed.has(key))
        || !keys.includes('id')
        || !keys.includes('state')
        || migration['id'] !== MAX_CONCURRENT_DEFAULT_MIGRATION_ID
        || !validState) {
        throw new Error('invalid_max_concurrent_default_migration');
    }
    if ('from' in migration && !Number.isInteger(migration['from'])) {
        throw new Error('invalid_max_concurrent_default_migration');
    }
    if ('to' in migration && !Number.isInteger(migration['to'])) {
        throw new Error('invalid_max_concurrent_default_migration');
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Clobber-protection latch (260806) ───────────────
// When settings.json existed but could not be read at boot (corrupt JSON, an
// unsupported/future schema version, a permission error), the in-memory state is
// defaults — and any later save (messaging.latestSeen, a UI write) would flush those
// defaults over the user's real file, tokens included. That actually happened: a v2
// packaged app read a v3 file and wiped a Slack config. While latched, saves commit
// to memory only and the file on disk is left exactly as it was.
let settingsPersistenceBlockedReason: string | null = null;
let settingsPersistenceBlockedWarned = false;

export function isSettingsPersistenceBlocked(): boolean {
    return settingsPersistenceBlockedReason !== null;
}

/**
 * A v3 document was written by this schema, and this schema always writes both the
 * multiSession block and its migration marker. If either is missing or malformed, the
 * document is not what it claims to be — and the consequence of guessing is specific:
 * an absent block would inherit the new defaults and start running sessions while the
 * marker still said the user had not consented (110 §4b-3). Older documents are held to
 * no such rule: their schema did not know these keys, so absent is normal there and the
 * legacy baseline covers it.
 */
function assertCurrentSchemaSessionShape(raw: Record<string, any>): void {
    const block = raw["multiSession"];
    if (!isPlainRecord(block)) throw new Error('invalid_multi_session_block');
    if (typeof block["enabled"] !== 'boolean') throw new Error('invalid_multi_session_enabled');
    const maxConcurrent = block["maxConcurrent"];
    if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
        throw new Error('invalid_multi_session_max_concurrent');
    }
    if ('channels' in block && !isPlainRecord(block["channels"])) {
        throw new Error('invalid_multi_session_channels');
    }
    if (!('multiSessionDefaultMigration' in raw)) {
        throw new Error('missing_multi_session_default_migration');
    }
    validateMultiSessionDefaultMigration(raw["multiSessionDefaultMigration"]);
}

/**
 * A v4 document must carry the new messaging gateway shape. Malformed enabled/home
 * arrays are rejected at boot so they cannot silently drop or corrupt channels.
 */
function assertCurrentSchemaMessagingShape(raw: Record<string, unknown>): void {
    const messaging = raw["messaging"];
    if (!isPlainRecord(messaging)) throw new Error('invalid_messaging_block');
    const enabled = messaging["enabledChannels"];
    if (!Array.isArray(enabled) || !enabled.every(isMessengerChannel)) {
        throw new Error('invalid_messaging_enabled_channels');
    }
    if (!isMessengerChannel(messaging["homeChannel"])) {
        throw new Error('invalid_messaging_home_channel');
    }
}

export type SettingsDefaultMigrationResult = { didChange: boolean };

function hasNamedMigrationStamp(value: unknown, id: string): boolean {
    return isPlainRecord(value) && value['id'] === id;
}

function nativeTransportSkipReason(cli: typeof SWITCHABLE_NATIVE_CLIS[number]): string {
    return cli === 'claude' ? 'unsupported_claude_policy' : 'restrictive_permissions';
}

function canFlipNativeTransport(
    cli: typeof SWITCHABLE_NATIVE_CLIS[number],
    permissions: unknown,
): boolean {
    return cli === 'claude'
        ? permissions === 'auto' || permissions === 'safe'
        : permissions === 'auto';
}

/** Boot-only. Do not call from migrateSettings, ENOENT, init, or the unreadable catch. */
export function applyNativeTransportDefaultMigration(s: Record<string, any>): SettingsDefaultMigrationResult {
    if (hasNamedMigrationStamp(s['nativeTransportMigration'], NATIVE_TRANSPORT_MIGRATION_ID)) {
        return { didChange: false };
    }
    if (!isPlainRecord(s['perCli'])) s['perCli'] = {};
    const skipped: NonNullable<NativeTransportMigration['skipped']> = [];
    let flipped = false;
    for (const cli of SWITCHABLE_NATIVE_CLIS) {
        const current = isPlainRecord(s['perCli'][cli]) ? s['perCli'][cli] : {};
        if (resolveRuntimeTransport(current['transport']) === 'native') continue;
        if (!canFlipNativeTransport(cli, s['permissions'])) {
            skipped.push({ cli, reason: nativeTransportSkipReason(cli) });
            continue;
        }
        s['perCli'][cli] = { ...current, transport: 'native' };
        flipped = true;
    }
    s['nativeTransportMigration'] = skipped.length > 0
        ? { id: NATIVE_TRANSPORT_MIGRATION_ID, state: 'partial', skipped }
        : {
            id: NATIVE_TRANSPORT_MIGRATION_ID,
            state: flipped ? 'applied' : 'already-native',
        };
    return { didChange: true };
}

/** Boot-only. Rewrites stored 2 to the product default; leaves 1 and every other integer. */
export function applyMaxConcurrentDefaultMigration(s: Record<string, any>): SettingsDefaultMigrationResult {
    if (hasNamedMigrationStamp(s['maxConcurrentDefaultMigration'], MAX_CONCURRENT_DEFAULT_MIGRATION_ID)) {
        return { didChange: false };
    }
    const block = isPlainRecord(s['multiSession']) ? s['multiSession'] : {};
    const n = typeof block['maxConcurrent'] === 'number' && Number.isInteger(block['maxConcurrent'])
        ? block['maxConcurrent']
        : resolveMaxConcurrent(s);
    const target = DEFAULT_SETTINGS.multiSession.maxConcurrent;
    if (n === 2) {
        s['multiSession'] = { ...block, maxConcurrent: target };
        s['maxConcurrentDefaultMigration'] = {
            id: MAX_CONCURRENT_DEFAULT_MIGRATION_ID,
            state: 'applied',
            from: 2,
            to: target,
        };
        return { didChange: true };
    }
    if (n === target) {
        s['maxConcurrentDefaultMigration'] = {
            id: MAX_CONCURRENT_DEFAULT_MIGRATION_ID,
            state: 'already-at-target',
            from: target,
            to: target,
        };
        return { didChange: true };
    }
    s['maxConcurrentDefaultMigration'] = {
        id: MAX_CONCURRENT_DEFAULT_MIGRATION_ID,
        state: 'left-in-place',
        from: n,
    };
    return { didChange: true };
}

export function loadSettings() {
    // A fresh load is a fresh verdict: a successful parse (or a genuinely absent
    // file) below re-enables persistence; only the unreadable-existing-file catch
    // re-arms the latch.
    settingsPersistenceBlockedReason = null;
    settingsPersistenceBlockedWarned = false;
    try {
        let raw: any = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('invalid_settings_document');
        }
        const sanitized = sanitizeSettingsInput(raw, 'boot');
        raw = sanitized.value;
        const nextShape = sanitized.persistenceShape;
        if (sanitized.rejectedPaths.length > 0) {
            console.warn(`[jaw:settings] ignored server-owned settings fields: ${sanitized.rejectedPaths.join(', ')}`);
        }
        if (sanitized.invalidPaths.length > 0) {
            console.warn(`[jaw:settings] ignored invalid settings fields: ${sanitized.invalidPaths.join(', ')}`);
        }
        const sourceVersion = readSettingsSchemaVersion(raw);
        // Dropping a malformed field and carrying on is right for a patch arriving over
        // the API — the rest of the patch is still what the caller meant. It is wrong for
        // a document claiming the current schema at boot: this schema wrote that block,
        // so a malformed one means the file is not what it says, and silently replacing
        // it with defaults is how a pending consent turns into a running feature.
        if (sourceVersion >= 3 && sanitized.invalidPaths.some(path => path.startsWith('multiSession'))) {
            throw new Error(`invalid_multi_session_block:${sanitized.invalidPaths.join(',')}`);
        }
        // A v1 document predates the codex-app default, so an absent or unknown
        // cli is normalised to the historical fallback rather than inheriting
        // the new default. A v2 document was written by this schema and must
        // already name a known runtime; if it does not, the file is not
        // trustworthy enough to silently supply one, so it closes the same way
        // a corrupt or future-versioned document does.
        if (sourceVersion >= 2 && !(isCliEngine(raw["cli"]) || isRetiredCliSelection(raw["cli"]))) {
            throw new Error(`invalid_settings_cli:${String(raw["cli"])}`);
        }
        // A document claiming the current schema must actually carry what this schema
        // writes. Checked before the merge, because after it the absence is gone.
        if (sourceVersion >= 3) assertCurrentSchemaSessionShape(raw);
        if (sourceVersion >= 4) assertCurrentSchemaMessagingShape(raw);
        const legacyCli = sourceVersion === 1 && !(isCliEngine(raw["cli"]) || isRetiredCliSelection(raw["cli"]))
            ? 'claude'
            : raw["cli"];
        const hadPlanning = !!raw.planning;
        const defaults = createDefaultSettings();
        // Everything below v3 predates the session defaults, so absent keys resolve to
        // what they used to mean rather than to the new defaults. The merge runs before
        // migrateSettings, so this is the only place that still knows whether a key was
        // in the document or is about to be invented (110 §4b-1). The boundary is the
        // flip's own version — a v3 document already carries the new meaning.
        const multiSessionBaseline = sourceVersion < MULTI_SESSION_DEFAULT_SCHEMA_VERSION
            ? LEGACY_MULTI_SESSION_BASELINE
            : defaults.multiSession;
        // Deep merge perCli so new CLI defaults (e.g. copilot) are preserved
        const mergedPerCli: Record<string, any> = buildDefaultPerCli();
        // This is an existing document: preserve absence before fresh defaults
        // obscure it. Explicit stored choices were validated by the sanitizer.
        for (const cli of SWITCHABLE_NATIVE_CLIS) {
            mergedPerCli[cli] = {
                ...mergedPerCli[cli],
                transport: resolveRuntimeTransport(raw.perCli?.[cli]?.transport),
            };
        }
        if (raw.perCli) {
            for (const [cli, cfg] of Object.entries(raw.perCli) as [string, Record<string, any>][]) {
                mergedPerCli[cli] = { ...(mergedPerCli[cli] || {}), ...cfg };
            }
        }
        // One merge implementation, shared with the API and file-watch ingress.
        // Boot used to hand-roll its own nested spreads, and the two lists drifted:
        // a partial {heartbeat:{enabled:true}} lost every sibling here but kept them
        // over the API, while a partial {avatar:{agent:...}} was the other way round.
        // Which keys a partial document destroyed depended on which door it arrived
        // through, which is not a property anyone chose.
        const layered = mergeSettingsLayer(
            { ...defaults, multiSession: multiSessionBaseline },
            {
                ...dropCorruptBlocks(raw),
                ...(sourceVersion === 1 ? { cli: legacyCli } : {}),
                perCli: mergedPerCli,
            },
        ) as Record<string, any>;
        // Everything below is normalization, and the merge must not swallow it.
        // ack is a third level the spec does not reach; slack.autoJoin repairs a
        // budget that reaches a loop joining real channels; search.engine is a
        // forced value rather than a merged one. Each reads the stored document
        // directly, because the layer above has already folded the key in.
        layered['telegram'] = {
            ...(isPlainRecord(layered['telegram']) ? layered['telegram'] : {}),
            ack: mergeAckSettings(defaults.telegram.ack, raw.telegram?.ack),
        };
        layered['discord'] = {
            ...(isPlainRecord(layered['discord']) ? layered['discord'] : {}),
            ack: mergeAckSettings(defaults.discord.ack, raw.discord?.ack),
        };
        layered['slack'] = {
            ...(isPlainRecord(layered['slack']) ? layered['slack'] : {}),
            ack: mergeAckSettings(defaults.slack.ack, raw.slack?.ack),
            autoJoin: mergeSlackAutoJoin(defaults.slack.autoJoin, raw.slack?.autoJoin),
        };
        layered['search'] = {
            ...(isPlainRecord(layered['search']) ? layered['search'] : {}),
            engine: raw.search?.engine === 'fts5' ? 'fts5' : 'like',
        };
        const merged = migrateSettings(layered, sourceVersion);
        // Silent v4 stamps. Schema stays 4, so sourceVersion < SETTINGS_SCHEMA_VERSION
        // will not persist a flip on an existing current-schema document.
        const nativeTransportDefault = applyNativeTransportDefaultMigration(merged);
        const maxConcurrentDefault = applyMaxConcurrentDefaultMigration(merged);
        // #64 safety: auto-correct stale workingDir (e.g. copied instance)
        // but allow valid paths to persist (dynamic project targeting)
        // Any document below the current schema was rewritten by the migration above, so
        // it has to reach disk. Leaving it unsaved would keep memory at v3 while the file
        // stayed older, and the next boot would run the migration again — including
        // recreating a marker the user had already resolved.
        let needsSave = sourceVersion < SETTINGS_SCHEMA_VERSION || hadPlanning
            || nativeTransportDefault.didChange
            || maxConcurrentDefault.didChange;
        if (typeof merged["workingDir"] === 'string' && merged["workingDir"] !== JAW_HOME && !fs.existsSync(merged["workingDir"])) {
            console.warn(`[jaw:workingDir] stale path ${merged["workingDir"]}, resetting to JAW_HOME`);
            merged["workingDir"] = JAW_HOME;
            needsSave = true;
        }

        // A previous runtime could have copied its effective environment token
        // into settings.json during an unrelated save. Environment mode is
        // intentionally exclusive, so remove all persisted connection fields.
        if (clearPersistedConnectionForEnvironment('slack', merged)) needsSave = true;
        if (clearPersistedConnectionForEnvironment('telegram', merged)) needsSave = true;
        if (clearPersistedConnectionForEnvironment('discord', merged)) needsSave = true;

        const candidate = { value: merged, shape: nextShape } satisfies SettingsStateCandidate;
        if (needsSave) persistAndCommit(candidate);
        else commitCandidate(candidate);

        // normalize projectDirs on load (reject corrupted/injected values)
        merged["projectDirs"] = normalizeProjectDirs(merged["projectDirs"]);

        // env overrides
        applyEnvOverrides(merged);

        // Heal loose permissions on existing installs: settings.json holds
        // live channel tokens and must be owner-only. Once per load, not per
        // save, so a hand-chmod'd 0644 is caught even before the next write.
        if (process.platform !== 'win32') {
            try {
                const mode = fs.statSync(SETTINGS_PATH).mode;
                if (mode & 0o077) {
                    fs.chmodSync(SETTINGS_PATH, 0o600);
                    console.warn('[jaw:settings] tightened settings.json permissions to 0600 (tokens inside)');
                }
            } catch { /* best-effort */ }
        }

        return merged;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
            // ENOENT means no settings file, not necessarily no install. A home that has
            // a database or an uploads directory has been used, so it is treated as an
            // upgrade and asked rather than switched on.
            const next = settingsForHomeWithoutSettingsFile();
            if (!isRetiredCliSelection(next.cli)) next.cli = pickFirstReadyCli();
            applyEnvOverrides(next);
            persistAndCommit({ value: next, shape: 'absent' });
            return next;
        }

        const next = createDefaultSettings();
        next.cli = 'claude';
        for (const cli of SWITCHABLE_NATIVE_CLIS) {
            next.perCli[cli] = { ...next.perCli[cli]!, transport: 'print' };
        }
        // This branch stands in for a state we could not read — corrupt JSON, an
        // unsupported version, a permission error. The new-install defaults are the wrong
        // thing to borrow here: they would turn sessions on for someone whose real
        // settings might have had them off, and who was never asked. Pinned to what the
        // previous schema meant (110 §4c). The ENOENT branch above is genuinely new and
        // keeps the new defaults.
        next.multiSession = { ...next.multiSession, ...LEGACY_MULTI_SESSION_BASELINE };
        applyEnvOverrides(next);
        commitCandidate({ value: next, shape: 'absent' });

        console.warn(`[jaw:settings] failed to load ${SETTINGS_PATH}: ${err?.message || String(error)}`);
        if (fs.existsSync(SETTINGS_PATH)) {
            // The file is real and we could not read it, so what is in memory now is
            // NOT the user's settings. Latch persistence so no later save clobbers
            // the file; the backup below is a copy, not a license to overwrite.
            settingsPersistenceBlockedReason = err?.message || String(error);
            let backupTimestamp = Date.now();
            let backupPath = `${SETTINGS_PATH}.corrupt-${backupTimestamp}.bak`;
            while (fs.existsSync(backupPath)) {
                backupTimestamp += 1;
                backupPath = `${SETTINGS_PATH}.corrupt-${backupTimestamp}.bak`;
            }
            try {
                fs.copyFileSync(SETTINGS_PATH, backupPath);
                console.warn(`[jaw:settings] backed up unreadable settings to ${backupPath}`);
            } catch (backupErr) {
                console.warn(`[jaw:settings] backup failed: ${(backupErr as Error).message}`);
            }
        }
        return next;
    }
}

// Self-write fingerprint for the settings watcher: external writers (a separate
// `cli-jaw project set` process) produce content that won't match this string.
let lastSavedSettingsRaw: string | null = null;

export function serializeSettingsForSave(candidate: SettingsStateCandidate): string {
    const value = structuredClone(candidate.value);
    delete value["runtimeSelectionDiagnostic"];
    if (value["slack"] && typeof value["slack"] === 'object') {
        for (const key of slackEnvironmentManagedSettingKeys()) delete value["slack"][key];
    }
    // Same rule, the other two channels. applyEnvOverrides writes the env token
    // onto the live settings object, so any later save — a port write, a target
    // persist — copied that secret onto disk. Slack was stripped here; Telegram
    // and Discord were not, which contradicted the documented promise that env
    // values never enter settings.json (#449). Every field an env variable owns
    // is stripped, not only the token (#787).
    if (value["telegram"] && typeof value["telegram"] === 'object') {
        for (const key of telegramEnvironmentManagedSettingKeys()) delete value["telegram"][key];
    }
    if (value["discord"] && typeof value["discord"] === 'object') {
        for (const key of discordEnvironmentManagedSettingKeys()) delete value["discord"][key];
    }
    const runtime = value["runtime"];
    if (candidate.shape === 'absent' && runtime?.codexApp?.multiplex === false) {
        delete runtime.codexApp.multiplex;
        if (Object.keys(runtime.codexApp).length === 0) delete runtime.codexApp;
        if (Object.keys(runtime).length === 0) delete value["runtime"];
    }
    return JSON.stringify(value, null, 2);
}

export type SettingsWrite = (raw: string) => void;

function writeSettingsRaw(raw: string): void {
    // settings.json carries live channel tokens (xoxb-/xapp-/bot tokens), so
    // it must never be group/other-readable. writeFileSync's mode applies
    // only at creation — chmod covers the existing-file path.
    fs.writeFileSync(SETTINGS_PATH, raw, { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch { /* best-effort */ }
    }
}

export function commitCandidate(candidate: SettingsStateCandidate): void {
    // Recompute on every load/save/watch commit; this is not a persisted marker.
    const storedCli = candidate.value['cli'];
    candidate.value['runtimeSelectionDiagnostic'] = isRetiredCliSelection(storedCli)
        ? retiredRuntimeDiagnostic(storedCli) : null;
    settings = candidate.value;
    settingsPersistenceShape = candidate.shape;
}

export function persistAndCommit(
    candidate: SettingsStateCandidate,
    write: SettingsWrite = writeSettingsRaw,
): void {
    if (settingsPersistenceBlockedReason !== null) {
        // Memory-only: the file on disk holds the user's real settings in a shape
        // this binary could not read, and writing would destroy them.
        if (!settingsPersistenceBlockedWarned) {
            settingsPersistenceBlockedWarned = true;
            console.warn(`[jaw:settings] persistence disabled: settings.json was unreadable at boot (${settingsPersistenceBlockedReason}); refusing to overwrite it`);
        }
        commitCandidate(candidate);
        return;
    }
    const raw = serializeSettingsForSave(candidate);
    write(raw);
    lastSavedSettingsRaw = raw;
    commitCandidate(candidate);
}

/** The attachPort another instance may have just persisted. Read from disk, not
 *  memory, because the in-memory copy predates the other process's write. */
export function readPersistedSlackAttachPort(): string {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as { slack?: { attachPort?: unknown } };
        return String(raw.slack?.attachPort ?? '').trim();
    } catch {
        return '';
    }
}

/** Re-save the current settings pair for legacy callers that mutate settings in place. */
export function saveSettings(s: Record<string, any>) {
    persistAndCommit({ value: s, shape: settingsPersistenceShape });
}

export function snapshotSettingsState(): SettingsStateCandidate {
    return {
        value: structuredClone(settings),
        shape: settingsPersistenceShape,
    };
}

export function getSettingsPersistenceShape(): SettingsPersistenceShape {
    return settingsPersistenceShape;
}

export function getLastSavedSettingsRaw(): string | null {
    return lastSavedSettingsRaw;
}

/** Replace settings object (for API PUT /api/settings deep merge) */
export function replaceSettings(s: Record<string, any>, shape: SettingsPersistenceShape) {
    commitCandidate({ value: s, shape });
}

// ─── Heartbeat File I/O ──────────────────────────────
// Separated from heartbeat timers so prompt.js can import without circular dep

export interface HeartbeatJob {
    id?: string;
    name?: string;
    enabled?: boolean;
    prompt?: string;
    schedule?: unknown;
    runner?: 'main' | 'employee' | 'script';
    employee?: string;
    command?: string[];
    reportPolicy?: 'always' | 'anomaly_only' | 'silent';
    /** Where this job's report goes. Absent means the legacy behaviour: the
     *  active channel's last-active conversation, which is whoever spoke to the
     *  bot most recently and therefore NOT a stable destination (#437).
     *
     *  Only the three operator-meaningful fields live here. `targetKind` and
     *  `peerKind` are derived from the id by the channel helpers, so an operator
     *  never has to know Slack's C/D/G prefix rules to fill this in. */
    destination?: HeartbeatDestination | null;
    /** Watch a person's mentions instead of running on a bare prompt. Absent
     *  means an ordinary heartbeat, which is every existing job. */
    mentionWatch?: HeartbeatMentionWatch | null;
}

/** Watch Slack for messages that tag `userId` and answer in those threads.
 *
 *  Slack has no event for a THIRD PARTY being mentioned — `app_mention` fires
 *  only for the app itself — and `search.messages` needs a user token this bot
 *  install cannot hold. So the only way to see these messages is to read the
 *  history of channels the bot is in, which is why this lives on a scheduled job
 *  rather than on the inbound event path.
 *
 *  `channelIds` is required and must be a subset of `slack.channelIds`: an
 *  answer addressed to a channel is authorized against that allowlist, so a
 *  channel outside it would be found and then refused with a 403. */
export interface HeartbeatMentionWatch {
    channel: 'slack';
    /** Ledger and fresh-start identity. Extra subjects live in `userIds`. */
    userId: string;
    /** Extra people whose mentions (or talk, when conditions say so) count. */
    userIds?: string[];
    channelIds: string[];
    /** Cap on threads answered in one tick. */
    maxHits?: number;
    /** Slack ts floor, so enabling this does not answer last month's backlog. */
    since?: string;
    /** OR of mention/talk rules. Absent or empty keeps mention-of-subjects. */
    conditions?: HeartbeatMentionWatchCondition[];
}

export interface HeartbeatDestination {
    channel: 'telegram' | 'discord' | 'slack';
    targetId: string;
    threadId?: string;
    /** Opt in to posting at the conversation root instead of inside a thread.
     *  Written explicitly so a job that simply has not been given a thread yet
     *  is distinguishable from one whose audience really is the channel (#745). */
    scope?: 'channel_root';
}

/** Channels one mention-watch job may cover.
 *
 *  A tick's Slack call count is channels x window budget, so this ceiling is what
 *  keeps it knowable. It is enforced as a REJECTION rather than a truncation: a
 *  job that quietly watched the first sixty of a longer list would leave an
 *  operator believing the rest are covered. */
export const HEARTBEAT_MENTION_WATCH_MAX_CHANNELS = 60;

/** Validate a mention-watch config on its own terms.
 *
 *  Membership in `slack.channelIds` is deliberately NOT checked here. That
 *  allowlist can shrink after a job is saved, so it has to be re-read at tick
 *  time; checking it here as well would only add a second, staler answer. */
export function isHeartbeatMentionWatch(value: unknown): value is HeartbeatMentionWatch {
    if (!value || typeof value !== 'object') return false;
    const w = value as Record<string, unknown>;
    if (w['channel'] !== 'slack') return false;
    if (typeof w['userId'] !== 'string' || !w['userId'].trim()) return false;
    const ids = w['channelIds'];
    if (!Array.isArray(ids) || ids.length === 0) return false;
    if (!ids.every(id => typeof id === 'string' && id.trim().length > 0)) return false;
    if (ids.length > HEARTBEAT_MENTION_WATCH_MAX_CHANNELS) return false;
    const maxHits = w['maxHits'];
    if (maxHits !== undefined && (typeof maxHits !== 'number' || !Number.isInteger(maxHits) || maxHits < 1)) return false;
    if (w['since'] !== undefined && (typeof w['since'] !== 'string' || !w['since'].trim())) return false;
    if (w['userIds'] !== undefined && !areMentionWatchUserIdsValid(w['userIds'])) return false;
    if (w['conditions'] !== undefined && !areMentionWatchConditionsValid(w['conditions'], ids)) return false;
    return true;
}

/** A destination is only usable when it names both a transport and a conversation.
 *  Anything else is treated as absent rather than half-applied. */
export function isHeartbeatDestination(value: unknown): value is HeartbeatDestination {
    if (!value || typeof value !== 'object') return false;
    const d = value as Record<string, unknown>;
    if (d['channel'] !== 'telegram' && d['channel'] !== 'discord' && d['channel'] !== 'slack') return false;
    if (typeof d['targetId'] !== 'string' || !d['targetId'].trim()) return false;
    if (d['threadId'] !== undefined && typeof d['threadId'] !== 'string') return false;
    if (d['scope'] !== undefined && d['scope'] !== 'channel_root') return false;
    return true;
}
export interface HeartbeatFile { jobs: HeartbeatJob[] }

export function loadHeartbeatFile(): HeartbeatFile {
    try {
        const parsed = JSON.parse(fs.readFileSync(HEARTBEAT_JOBS_PATH, 'utf8')) as HeartbeatFile;
        if (!Array.isArray(parsed.jobs)) return parsed;
        return { ...parsed, jobs: parsed.jobs.map(normalizeHeartbeatJob) };
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') {
            throw Object.assign(new Error(`heartbeat_load_failed: ${err?.message || String(error)}`), {
                statusCode: 500,
                code: 'heartbeat_load_failed',
                cause: error,
            });
        }
        return { jobs: [] };
    }
}

function normalizeHeartbeatJob(job: HeartbeatJob): HeartbeatJob {
    const runner = job.runner ?? 'main';
    const validRunner = runner === 'main' || runner === 'employee' || runner === 'script';
    const validEmployee = runner !== 'employee' || (typeof job.employee === 'string' && job.employee.trim().length > 0);
    const validCommand = runner !== 'script' || (Array.isArray(job.command) && job.command.length > 0 && job.command.every(part => typeof part === 'string' && part.length > 0));
    if (!validRunner || !validEmployee || !validCommand) {
        console.warn(`[heartbeat:${job.name || job.id || 'unknown'}] invalid runner configuration; falling back to main`);
        return { ...job, runner: 'main' };
    }
    const reportPolicy = job.reportPolicy ?? 'always';
    if (reportPolicy !== 'always' && reportPolicy !== 'anomaly_only' && reportPolicy !== 'silent') {
        console.warn(`[heartbeat:${job.name || job.id || 'unknown'}] invalid report policy; falling back to always`);
        return { ...job, runner, reportPolicy: 'always' };
    }
    // A malformed mention-watch DISABLES the job rather than losing the field.
    // Dropping it would leave an enabled job running its prompt as an ordinary
    // heartbeat, and that prompt says "answer the mention below" — so it would
    // post an answer to nothing, to whatever destination the job carries.
    if (job.mentionWatch != null && !isHeartbeatMentionWatch(job.mentionWatch)) {
        console.warn(`[heartbeat:${job.name || job.id || 'unknown'}] invalid mention watch; disabling job`);
        return { ...job, runner, reportPolicy, enabled: false };
    }
    return { ...job, runner, reportPolicy };
}

export function saveHeartbeatFile(data: HeartbeatFile | Record<string, unknown>) {
    // Temp file then rename, so a crash or a full disk mid-write cannot leave a
    // TRUNCATED heartbeat.json behind. Writing in place fails in the worst
    // possible way: the file still parses as JSON right up until it does not,
    // and on the next boot every scheduled job is simply gone.
    //
    // Callers that pair this with a database write depend on the ordering too:
    // the rename is the point after which the file is known good, so the
    // database step belongs strictly after it.
    //
    // Same directory on purpose — rename is only atomic within one filesystem.
    const tmp = `${HEARTBEAT_JOBS_PATH}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, HEARTBEAT_JOBS_PATH);
    } catch (error) {
        // Leaving the temp file would accumulate one per failed save.
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw error;
    }
}
