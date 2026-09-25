import { isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import {
    loadUnifiedMcp, syncToAll,
    ensureWorkingDirSkillsLinks, initMcpConfig,
} from '../../lib/mcp-sync.js';
import {
    settings, persistAndCommit, snapshotSettingsState, migrateSettings, normalizeProjectDirs,
    DEFAULT_SETTINGS,
    RUNTIME_DEFAULT_MIGRATION_ID, type RuntimeDefaultMigration,
    MULTI_SESSION_DEFAULT_MIGRATION_ID, type MultiSessionDefaultMigration,
    type SettingsStateCandidate, type SettingsWrite, slackEnvironmentManagedPatchPaths,
    telegramEnvironmentManagedPatchPaths, discordEnvironmentManagedPatchPaths,
    wikiRouteManagedPatchPaths,
} from './config.js';
import { broadcast } from './bus.js';
import { syncMainSessionToSettings } from './main-session.js';
import { mergeSettingsPatch, sanitizeSettingsInput } from './settings-merge.js';
import { regenerateB } from '../prompt/builder.js';
import { restartMessagingRuntime, initActiveMessagingRuntime } from '../messaging/runtime.js';
import { beginRuntimeSettingsMutation } from './runtime-settings-gate.js';
import { log } from './logger.js';
import { MAX_DISPATCH_APPROVAL_TTL_SECONDS } from './dispatch-approval.js';
import { isRuntimeTransport, isSwitchableNativeCli } from '../agent/runtime/selection.js';

/** Explicit display/next-run preferences must not revoke already admitted runs.
 * Unknown, empty or execution-changing mixtures retain the existing invalidation.
 */
export function settingsPatchPreservesActiveRun(input: Record<string, unknown>): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const keys = Object.keys(input);
    if (!keys.length || keys.some(key => key !== 'presentation' && key !== 'perCli')) return false;
    const sanitized = sanitizeSettingsInput(input, 'api');
    if (sanitized.invalidPaths.length || sanitized.serverOwnedPaths.length || sanitized.rejectedPaths.length) return false;
    const patch = sanitized.value;
    if (Object.keys(patch).length !== keys.length || Object.keys(patch).some(key => !keys.includes(key))) return false;
    if (keys.includes('presentation')) {
        const display = patch['presentation'];
        if (!display || typeof display !== 'object' || Array.isArray(display)
            || Object.keys(display).length !== 1 || !Object.hasOwn(display, 'mode')) return false;
    }
    if (keys.includes('perCli')) {
        const perCli = patch['perCli'];
        if (!perCli || typeof perCli !== 'object' || Array.isArray(perCli) || !Object.keys(perCli).length) return false;
        for (const [cli, value] of Object.entries(perCli)) {
            if (!isSwitchableNativeCli(cli) || !value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'transport')
                || !isRuntimeTransport((value as Record<string, unknown>)['transport'])) return false;
        }
    }
    return true;
}

export type RuntimeDefaultMigrationAction = 'accept' | 'keep';

export class RuntimeDefaultMigrationTerminalError extends Error {
    constructor() {
        super('runtime_default_migration_terminal');
        this.name = 'RuntimeDefaultMigrationTerminalError';
    }
}

export function resolveRuntimeDefaultMigration(
    currentSettings: Record<string, unknown>,
    action: RuntimeDefaultMigrationAction,
): Record<string, unknown> {
    const current = currentSettings["runtimeDefaultMigration"];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new RuntimeDefaultMigrationTerminalError();
    }
    const migration = current as RuntimeDefaultMigration;
    if (migration.id !== RUNTIME_DEFAULT_MIGRATION_ID || migration.state !== 'pending') {
        throw new RuntimeDefaultMigrationTerminalError();
    }
    const runtimeDefaultMigration: RuntimeDefaultMigration = {
        ...migration,
        state: action === 'accept' ? 'accepted' : 'kept',
    };
    return {
        ...(action === 'accept' ? { cli: 'codex-app' } : {}),
        runtimeDefaultMigration,
    };
}

let runtimeDefaultMigrationTail = Promise.resolve();

export async function withRuntimeDefaultMigrationLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = runtimeDefaultMigrationTail;
    runtimeDefaultMigrationTail = previous.then(() => turn);
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

export type MultiSessionDefaultMigrationAction = 'accept' | 'keep';

export class MultiSessionDefaultMigrationTerminalError extends Error {
    constructor() {
        super('multi_session_default_migration_terminal');
        this.name = 'MultiSessionDefaultMigrationTerminalError';
    }
}

/**
 * Accept means both halves of what the prompt offered: sessions on, and a second lane so
 * a second tab does not queue behind the first. Turning it on without the lane would
 * change the UI and change nothing about how it runs.
 *
 * A concurrency the user moved off 1 is left alone. A stored 1 and a chosen 1 are the
 * same byte, so this is stated in terms of the value rather than of intent — the prompt
 * says what it will do and this does exactly that (110 §4d).
 */
export function resolveMultiSessionDefaultMigration(
    currentSettings: Record<string, unknown>,
    action: MultiSessionDefaultMigrationAction,
): Record<string, unknown> {
    const current = currentSettings["multiSessionDefaultMigration"];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new MultiSessionDefaultMigrationTerminalError();
    }
    const migration = current as MultiSessionDefaultMigration;
    if (migration.id !== MULTI_SESSION_DEFAULT_MIGRATION_ID || migration.state !== 'pending') {
        throw new MultiSessionDefaultMigrationTerminalError();
    }
    const multiSessionDefaultMigration: MultiSessionDefaultMigration = {
        ...migration,
        state: action === 'accept' ? 'accepted' : 'kept',
    };
    if (action !== 'accept') return { multiSessionDefaultMigration };

    const block = currentSettings["multiSession"];
    const currentMax = (block && typeof block === 'object' && !Array.isArray(block))
        ? (block as Record<string, unknown>)["maxConcurrent"]
        : undefined;
    const keepsOwnConcurrency = Number.isInteger(currentMax) && (currentMax as number) > 1;
    return {
        // A partial patch here is safe because multiSession is a merge boundary; the
        // policy and the channel gates survive it.
        multiSession: {
            enabled: true,
            ...(keepsOwnConcurrency ? {} : { maxConcurrent: DEFAULT_SETTINGS.multiSession.maxConcurrent }),
        },
        multiSessionDefaultMigration,
    };
}

let multiSessionDefaultMigrationTail = Promise.resolve();

export async function withMultiSessionDefaultMigrationLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = multiSessionDefaultMigrationTail;
    multiSessionDefaultMigrationTail = previous.then(() => turn);
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

type ApplyRuntimeSettingsOptions = {
    resetFallbackState?: () => void;
    cliSwitchRefresh?: (input: Record<string, unknown>) => Promise<unknown>;
    writeSettings?: SettingsWrite;
    allowWikiLifecycle?: boolean;
    // The messaging restart is the other post-write side effect that can fail
    // and force a rollback. Mocking the whole runtime module to reach it means
    // re-declaring every export, so tests inject just this call instead.
    restartMessaging?: (
        prev: Record<string, any>,
        next: Record<string, any>,
        patch: Record<string, any>,
    ) => Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

function validateDispatchApprovalPatch(patch: Record<string, unknown>): void {
    if (!("dispatchApproval" in patch)) return;
    const block = patch["dispatchApproval"];
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('invalid_dispatch_approval');
    const approval = block as Record<string, unknown>;
    if ("ttlSeconds" in approval && (!Number.isInteger(approval["ttlSeconds"])
        || Number(approval["ttlSeconds"]) < 1
        || Number(approval["ttlSeconds"]) > MAX_DISPATCH_APPROVAL_TTL_SECONDS)) {
        throw new Error('invalid_dispatch_approval_ttl');
    }
    if (!("operators" in approval)) return;
    const operators = approval["operators"];
    if (!operators || typeof operators !== 'object' || Array.isArray(operators)) throw new Error('invalid_dispatch_approval_operators');
    const lists = operators as Record<string, unknown>;
    if ("slack" in lists && (!Array.isArray(lists["slack"]) || !lists["slack"].every(value => typeof value === 'string'))) throw new Error('invalid_dispatch_approval_slack_operators');
    if ("telegram" in lists && (!Array.isArray(lists["telegram"]) || !lists["telegram"].every(value => Number.isSafeInteger(value)))) throw new Error('invalid_dispatch_approval_telegram_operators');
    if ("discord" in lists && (!Array.isArray(lists["discord"]) || !lists["discord"].every(value => typeof value === 'string'))) throw new Error('invalid_dispatch_approval_discord_operators');
}

function selectedModelForCli(cli: string, currentSettings: Record<string, unknown>): string {
    const activeOverrides = asRecord(currentSettings["activeOverrides"]);
    const perCli = asRecord(currentSettings["perCli"]);
    return stringField(asRecord(activeOverrides[cli]), 'model')
        || stringField(asRecord(perCli[cli]), 'model')
        || 'default';
}

function transportConfigFingerprint(channel: 'telegram' | 'discord' | 'slack', snapshot: Record<string, unknown>): string {
    const block = asRecord(snapshot[channel]);
    if (channel === 'telegram') {
        return JSON.stringify({
            enabled: block["enabled"],
            token: stringField(block, 'token'),
            allowedChatIds: block["allowedChatIds"],
        });
    }
    if (channel === 'slack') {
        // Slack's credentials are botToken/appToken, not `token`. Falling
        // through to the Discord shape below would read undefined for both,
        // so a token change would never register as a config change.
        return JSON.stringify({
            enabled: block["enabled"],
            botToken: stringField(block, 'botToken'),
            appToken: stringField(block, 'appToken'),
            teamId: stringField(block, 'teamId'),
            channelIds: block["channelIds"],
        });
    }
    return JSON.stringify({
        enabled: block["enabled"],
        token: stringField(block, 'token'),
        guildId: stringField(block, 'guildId'),
        channelIds: block["channelIds"],
    });
}

async function invalidateSendOnlyClientsIfNeeded(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (transportConfigFingerprint('telegram', prev) !== transportConfigFingerprint('telegram', next)) {
        tasks.push(import('../telegram/bot.js').then(({ invalidateTelegramSendClient }) => {
            invalidateTelegramSendClient();
        }));
    }
    if (transportConfigFingerprint('discord', prev) !== transportConfigFingerprint('discord', next)) {
        tasks.push(import('../discord/send-only-client.js').then(({ invalidateDiscordSendClient }) => {
            invalidateDiscordSendClient();
        }));
    }
    if (transportConfigFingerprint('slack', prev) !== transportConfigFingerprint('slack', next)) {
        tasks.push(import('../slack/send-only-client.js').then(({ invalidateSlackSendClient }) => {
            invalidateSlackSendClient();
        }));
        // A token/workspace change invalidates resolved names too — they are
        // cached per (team, id) and a stale entry would mislabel a sender.
        tasks.push(import('../slack/identity.js').then(({ resetSlackIdentityCache }) => {
            resetSlackIdentityCache();
        }));
    }
    await Promise.all(tasks);
}

function rollbackSettings(
    previous: SettingsStateCandidate,
    context: string,
    write?: SettingsWrite,
): void {
    try {
        persistAndCommit(previous, write);
    } catch (rollbackError: unknown) {
        // persistAndCommit writes before commit, so a failed rollback leaves the
        // last successfully persisted candidate as the in-memory pair as well.
        console.error(`[runtime-settings] ${context} rollback write failed:`, (rollbackError as Error).message);
    }
}

// Every mutation runs to completion before the next one starts. The rollback
// path restores a candidate captured before the patch, so two overlapping
// requests would let a late failure in the first undo a value the second had
// already persisted successfully — the losing write disappears from both the
// file and memory. beginRuntimeSettingsMutation only counts in-flight work; it
// does not serialise, so the tail promise does.
let runtimeSettingsTail = Promise.resolve();

export async function applyRuntimeSettingsPatch(
    rawPatch: Record<string, any> = {},
    opts: ApplyRuntimeSettingsOptions = {},
): Promise<Record<string, any>> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = runtimeSettingsTail;
    runtimeSettingsTail = previous.then(() => turn);
    await previous;
    try {
        return await applyRuntimeSettingsPatchSerialised(rawPatch, opts);
    } finally {
        release();
    }
}

async function applyRuntimeSettingsPatchSerialised(
    rawPatch: Record<string, any> = {},
    opts: ApplyRuntimeSettingsOptions = {},
): Promise<Record<string, any>> {
    const finishSettingsMutation = beginRuntimeSettingsMutation();
    const prevCandidate = snapshotSettingsState();
    const prevSnapshot = prevCandidate.value;
    const prevCli = prevSnapshot["cli"];
    const prevWorkingDir = prevSnapshot["workingDir"];
    let candidateCommitted = false;
    let rollbackHandled = false;

    try {
        const sanitized = sanitizeSettingsInput(rawPatch, 'api');
        if (sanitized.serverOwnedPaths.length > 0) {
            throw new Error('server_owned_settings_field');
        }
        if (sanitized.invalidPaths.length > 0) {
            throw new Error('invalid_settings_field');
        }
        const patch = sanitized.value;
        if (isRetiredCliSelection(patch['cli']) && !isRetiredCliSelection(prevCli)) {
            throw new Error(retiredRuntimeDiagnostic(patch['cli']));
        }
        const presentationOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'presentation');
        // Preserve the older empty/sibling presentation subtree behavior separately
        // from the strict admission-ownership exception for explicit preferences.
        const preserveRuntimeState = presentationOnly || settingsPatchPreservesActiveRun(rawPatch);
        validateDispatchApprovalPatch(patch);
        if (!opts.allowWikiLifecycle && wikiRouteManagedPatchPaths(patch).length > 0) {
            throw new Error('wiki_configuration_requires_wiki_route');
        }
        if (slackEnvironmentManagedPatchPaths(patch).length > 0) {
            throw new Error('slack_connection_managed_by_environment');
        }
        if (telegramEnvironmentManagedPatchPaths(patch).length > 0) {
            throw new Error('telegram_connection_managed_by_environment');
        }
        if (discordEnvironmentManagedPatchPaths(patch).length > 0) {
            throw new Error('discord_connection_managed_by_environment');
        }
        const merged = mergeSettingsPatch(prevSnapshot, patch);
        if ('projectDirs' in patch) {
            merged["projectDirs"] = normalizeProjectDirs(merged["projectDirs"]);
        }
        const migrated = migrateSettings(merged);
        if (isRetiredCliSelection(migrated['cli']) && !isRetiredCliSelection(prevCli)) {
            throw new Error(retiredRuntimeDiagnostic(migrated['cli']));
        }
        const nextShape = sanitized.persistenceShape === 'present'
            ? 'present'
            : prevCandidate.shape;
        persistAndCommit({ value: migrated, shape: nextShape }, opts.writeSettings);
        candidateCommitted = true;

        if (!preserveRuntimeState) opts.resetFallbackState?.();

        // CLI-changed branch delegates main-session clearing to cliSwitchRefresh
        // (which writes a cleared row inside its DB transaction). On refresh failure
        // we revert settings; the original session row is preserved because nothing
        // touched it on this branch (no syncMainSessionToSettings call).
        const cliChanged = !!(prevCli && settings["cli"] && prevCli !== settings["cli"]);
        if (cliChanged) {
            const toCli = settings["cli"];
            const toModel = selectedModelForCli(toCli, settings);
            try {
                const cliSwitchRefresh = opts.cliSwitchRefresh
                    ?? (await import('./compact.js')).cliSwitchRefresh;
                await cliSwitchRefresh({
                    sourceWorkDir: prevWorkingDir || '',
                    targetWorkDir: settings["workingDir"] || '',
                    fromCli: prevCli,
                    toCli,
                    toModel,
                });
            } catch (e: unknown) {
                console.error('[runtime-settings] cli switch refresh failed, rolling back:', (e as Error).message);
                rollbackSettings(prevCandidate, 'cli switch refresh', opts.writeSettings);
                rollbackHandled = true;
                throw e;
            }
        } else if (!preserveRuntimeState) {
            syncMainSessionToSettings(prevCli);
        }

        if (settings["workingDir"] !== prevWorkingDir) {
            try {
                initMcpConfig(settings["workingDir"]);
                ensureWorkingDirSkillsLinks(settings["workingDir"], { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
                syncToAll(loadUnifiedMcp());
                regenerateB();
                log.info(`[jaw:workingDir] artifacts regenerated for ${settings["workingDir"]}`);
            } catch (e: unknown) {
                console.error('[jaw:workingDir]', (e as Error).message);
            }
        }

        await invalidateSendOnlyClientsIfNeeded(prevSnapshot, settings);

        // Unified messaging runtime restart (handles both Telegram and Discord)
        try {
            await (opts.restartMessaging ?? restartMessagingRuntime)(prevSnapshot, settings, patch);
        } catch (e: unknown) {
            // Rollback: restore previous settings AND attempt to re-init previous runtime
            console.error('[runtime-settings] restart failed, rolling back:', (e as Error).message);
            rollbackSettings(prevCandidate, 'messaging restart', opts.writeSettings);
            rollbackHandled = true;
            try {
                await initActiveMessagingRuntime();
            } catch (reInitErr: unknown) {
                console.error('[runtime-settings] rollback re-init also failed:', (reInitErr as Error).message);
            }
            throw e;
        }

        broadcast('settings_change', {
            changedKeys: Object.keys(patch),
            cli: settings["cli"],
            model: selectedModelForCli(settings["cli"], settings),
            projectDirs: settings["projectDirs"] ?? null,
            source: 'apply',
        });

        return settings;
    } catch (error) {
        if (candidateCommitted && !rollbackHandled) {
            rollbackSettings(prevCandidate, 'post-write side effect', opts.writeSettings);
        }
        throw error;
    } finally {
        finishSettingsMutation();
    }
}
