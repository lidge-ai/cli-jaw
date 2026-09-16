// ─── Settings File Watcher (#233 external-write detection) ──
// A separate CLI process (`cli-jaw project set` in a terminal) writes
// settings.json directly, so the running server's in-memory `settings`
// goes stale and no `settings_change` ever reaches web UI or manager.
// This watcher closes that gap: debounced fs.watch on the settings file,
// self-write guard via the fingerprint recorded in saveSettings(), then
// in-memory reload + broadcast.

import fs from 'node:fs';
import path from 'node:path';
import {
    SETTINGS_PATH, settings, replaceSettings, migrateSettings,
    normalizeProjectDirs, getLastSavedSettingsRaw,
    slackEnvironmentManagedPatchPaths, slackEnvironmentManagedSettingKeys,
    wikiRouteManagedPatchPaths, WIKI_ROUTE_MANAGED_SETTING_KEYS,
} from './config.js';
import { mergeSettingsPatch, sanitizeSettingsInput } from './settings-merge.js';
import { broadcast } from './bus.js';
import { classifyAllowlistChange, recordAllowlistNarrowing } from '../slack/allowlist-audit.js';
import { SWITCHABLE_NATIVE_CLIS, resolveRuntimeTransport } from '../agent/runtime/selection.js';
import { bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';

export const SETTINGS_WATCH_DEBOUNCE_MS = 300;
const SERVER_OWNED_SETTINGS_KEYS = [
    'settingsSchemaVersion',
    'runtimeDefaultMigration',
    'multiSessionDefaultMigration',
    'nativeTransportMigration',
    'maxConcurrentDefaultMigration',
    'slackEnvironmentVariables',
] as const;

export type SettingsWatchOptions = {
    debounceMs?: number;
    /** Injectable for tests — must match fs.watch(dir, listener) surface. */
    watchImpl?: (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => { close: () => void };
    /** Injectable for tests — reads the settings file content. */
    readImpl?: (file: string) => string;
};

export type ReloadOptions = {
    readImpl?: (file: string) => string;
    /** Injectable for tests — defaults to the saveSettings fingerprint. */
    lastSavedRaw?: string | null;
};

function selectedModelForCli(cli: unknown, currentSettings: Record<string, unknown>): string {
    const key = typeof cli === 'string' && cli ? cli : 'claude';
    const activeOverrides = currentSettings["activeOverrides"];
    const perCli = currentSettings["perCli"];
    const activeModel = activeOverrides && typeof activeOverrides === 'object'
        ? (activeOverrides as Record<string, Record<string, unknown> | undefined>)[key]?.["model"]
        : null;
    const perCliModel = perCli && typeof perCli === 'object'
        ? (perCli as Record<string, Record<string, unknown> | undefined>)[key]?.["model"]
        : null;
    return typeof activeModel === 'string' && activeModel
        ? activeModel
        : typeof perCliModel === 'string' && perCliModel
        ? perCliModel
        : 'default';
}

/** Re-read settings.json after an external write and broadcast the change.
 *  Exported for direct unit testing without timers. Returns true when a
 *  reload actually happened (false: self-write, unchanged, or bad JSON). */
export function reloadSettingsFromDisk(options: ReloadOptions = {}): boolean {
    const readImpl = options.readImpl ?? ((f: string) => fs.readFileSync(f, 'utf8'));
    let raw: string;
    try {
        raw = readImpl(SETTINGS_PATH);
    } catch (e: unknown) {
        console.warn('[settings-watch] read failed:', (e as Error).message);
        return false;
    }
    const lastSavedRaw = options.lastSavedRaw !== undefined ? options.lastSavedRaw : getLastSavedSettingsRaw();
    if (raw === lastSavedRaw) return false; // self-write echo
    let parsed: Record<string, unknown>;
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            console.warn('[settings-watch] settings.json is not an object — keeping in-memory settings');
            return false;
        }
        parsed = value as Record<string, unknown>;
    } catch {
        console.warn('[settings-watch] settings.json is not valid JSON — keeping in-memory settings');
        return false;
    }
    const sanitized = sanitizeSettingsInput(parsed, 'watch');
    if (sanitized.rejectedPaths.length > 0) {
        console.warn(`[settings-watch] ignored server-owned settings fields: ${sanitized.rejectedPaths.join(', ')}`);
    }
    if (sanitized.invalidPaths.length > 0) {
        console.warn(`[settings-watch] ignored invalid settings fields: ${sanitized.invalidPaths.join(', ')}`);
    }
    const externalPatch = { ...sanitized.value };
    const wikiManagedPaths = wikiRouteManagedPatchPaths(externalPatch);
    if (wikiManagedPaths.length > 0) {
        const wiki = { ...(externalPatch['wiki'] as Record<string, unknown>) };
        for (const key of WIKI_ROUTE_MANAGED_SETTING_KEYS) delete wiki[key];
        if (Object.keys(wiki).length > 0) externalPatch['wiki'] = wiki;
        else delete externalPatch['wiki'];
        console.warn(`[settings-watch] ignored wiki route-managed settings fields: ${wikiManagedPaths.join(', ')}`);
    }
    const environmentManagedSlackPaths = slackEnvironmentManagedPatchPaths(externalPatch);
    if (environmentManagedSlackPaths.length > 0) {
        const slack = { ...(externalPatch["slack"] as Record<string, unknown>) };
        for (const key of slackEnvironmentManagedSettingKeys()) delete slack[key];
        externalPatch["slack"] = slack;
        console.warn(`[settings-watch] ignored environment-managed settings fields: ${environmentManagedSlackPaths.join(', ')}`);
    }
    const ignoredKeys = SERVER_OWNED_SETTINGS_KEYS.filter((key) => key in externalPatch);
    for (const key of ignoredKeys) delete externalPatch[key];
    if (ignoredKeys.length > 0) {
        console.warn(`[settings-watch] ignored server-owned settings keys: ${ignoredKeys.join(', ')}`);
    }
    // Same normalize/migrate path as boot-time load; merge onto current
    // in-memory settings so runtime-only keys survive a partial file.
    // Classified BEFORE the merge, while the previous list is still readable.
    //
    // The route records this too, but it cannot be the only place: `jaw slack
    // setup --channel-ids` writes settings.json and THEN hot-notifies, so on a
    // 300ms debounce this reload can land first and the route then finds nothing
    // left to describe. An agent editing settings.json by hand never reaches the
    // route at all — which is how #406 happened unrecorded.
    const allowlistChange = classifyAllowlistChange(
        (externalPatch["slack"] as Record<string, unknown> | undefined)?.["channelIds"],
        settings["slack"]?.channelIds,
    );
    const merged = mergeSettingsPatch(settings, externalPatch);
    merged["projectDirs"] = normalizeProjectDirs(merged["projectDirs"]);
    const candidate = migrateSettings(merged);
    const transportChanged = SWITCHABLE_NATIVE_CLIS.some(cli =>
        resolveRuntimeTransport(settings['perCli']?.[cli]?.transport)
        !== resolveRuntimeTransport(candidate['perCli']?.[cli]?.transport));
    replaceSettings(candidate, sanitized.persistenceShape);
    if (transportChanged) bumpSessionOwnershipGeneration();
    recordAllowlistNarrowing(allowlistChange, 'settings.json');
    broadcast('settings_change', {
        changedKeys: Object.keys(externalPatch),
        cli: settings["cli"],
        model: selectedModelForCli(settings["cli"], settings),
        projectDirs: settings["projectDirs"] ?? null,
        source: 'external',
    });
    return true;
}

/** Start the debounced watcher. Returns a stop function. */
export function startSettingsWatch(options: SettingsWatchOptions = {}): () => void {
    const debounceMs = options.debounceMs ?? SETTINGS_WATCH_DEBOUNCE_MS;
    const readImpl = options.readImpl ?? ((f: string) => fs.readFileSync(f, 'utf8'));
    const watchImpl = options.watchImpl ?? ((dir, listener) => fs.watch(dir, listener));
    const dir = path.dirname(SETTINGS_PATH);
    const file = path.basename(SETTINGS_PATH);
    let timer: ReturnType<typeof setTimeout> | null = null;

    let watcher: { close: () => void };
    try {
        // Watch the directory, not the file: editors and atomic writers replace
        // the inode (rename), which silently kills a file-level watcher.
        watcher = watchImpl(dir, (_event, filename) => {
            if (filename && String(filename) !== file) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                try {
                    reloadSettingsFromDisk({ readImpl });
                } catch (e: unknown) {
                    console.warn('[settings-watch] reload failed:', (e as Error).message);
                }
            }, debounceMs);
        });
    } catch (e: unknown) {
        console.warn('[settings-watch] watch unavailable:', (e as Error).message);
        return () => {};
    }

    return () => {
        if (timer) clearTimeout(timer);
        timer = null;
        try {
            watcher.close();
        } catch { /* already closed */ }
    };
}
