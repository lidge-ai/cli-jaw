// ─── Settings Merge Logic ────────────────────────────
// Phase 9.4 — server.js의 applySettingsPatch에서 추출한 deep merge 로직

import { mergeAckSettings } from '../messaging/ack-reaction.js';
import { mergeSlackAutoJoin } from '../slack/auto-join.js';
import { isRuntimeTransport, isSwitchableNativeCli } from '../agent/runtime/selection.js';
import { isPresentationMode } from '../shared/presentation.js';
import { isPermissionsPolicy } from '../shared/permissions.js';

export type SettingsInputSource = 'boot' | 'watch' | 'api';
export type SettingsPersistenceShape = 'absent' | 'present';

export type SanitizedSettingsInput = {
    value: Record<string, any>;
    persistenceShape: SettingsPersistenceShape;
    serverOwnedPaths: string[];
    invalidPaths: string[];
    rejectedPaths: string[];
};

function isPlainRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Apply the shared nested settings policy at every untrusted ingress.
 * Boot/watch consume full documents, so an absent or invalid gate becomes the
 * execution default false while persistence shape remains absent. API input is
 * a patch, so a missing gate must not overwrite the current runtime value.
 */
export function sanitizeSettingsInput(
    input: Record<string, any>,
    source: SettingsInputSource,
): SanitizedSettingsInput {
    const value = { ...input };
    const serverOwnedPaths: string[] = [];
    const invalidPaths: string[] = [];
    const rejectedPaths: string[] = [];
    let persistenceShape: SettingsPersistenceShape = 'absent';

    if (Object.hasOwn(input, 'presentation')) {
        if (!isPlainRecord(input['presentation'])) {
            delete value['presentation'];
            invalidPaths.push('presentation');
        } else {
            const presentation = { ...input['presentation'] };
            if (Object.hasOwn(presentation, 'mode') && !isPresentationMode(presentation['mode'])) {
                delete presentation['mode'];
                invalidPaths.push('presentation.mode');
            }
            value['presentation'] = presentation;
        }
    }

    if (isPlainRecord(input['perCli'])) {
        const perCli = Object.fromEntries(Object.entries(input['perCli']).map(([cli, entry]) => {
            if (!isPlainRecord(entry)) return [cli, entry];
            const provider = { ...entry };
            if (isSwitchableNativeCli(cli) && Object.hasOwn(provider, 'transport')
                && !isRuntimeTransport(provider['transport'])) {
                delete provider['transport'];
                invalidPaths.push(`perCli.${cli}.transport`);
            }
            return [cli, provider];
        }));
        value['perCli'] = perCli;
    }

    const runtimeInput = isPlainRecord(input["runtime"]) ? input["runtime"] : null;
    const codexAppInput = runtimeInput && isPlainRecord(runtimeInput["codexApp"])
        ? runtimeInput["codexApp"]
        : null;
    const runtime = runtimeInput ? { ...runtimeInput } : {};
    const codexApp = codexAppInput ? { ...codexAppInput } : {};

    if (codexAppInput && Object.prototype.hasOwnProperty.call(codexAppInput, 'laneMode')) {
        const path = 'runtime.codexApp.laneMode';
        delete codexApp["laneMode"];
        rejectedPaths.push(path);
        if (source === 'api') serverOwnedPaths.push(path);
    }

    if (codexAppInput && Object.prototype.hasOwnProperty.call(codexAppInput, 'multiplex')) {
        if (typeof codexAppInput["multiplex"] === 'boolean') {
            persistenceShape = 'present';
        } else {
            delete codexApp["multiplex"];
            invalidPaths.push('runtime.codexApp.multiplex');
        }
    }

    if (source !== 'api' && persistenceShape === 'absent') {
        codexApp["multiplex"] = false;
    }

    if (runtimeInput || source !== 'api') {
        runtime["codexApp"] = codexApp;
        value["runtime"] = runtime;
    }

    // `multiSession` has to be a plain object or not be here at all. A non-object survives
    // the merge as-is and then meets `if (!s["multiSession"])` in migrateSettings, which
    // reads falsy as absent and fills the block with the current defaults — so a single
    // `{"multiSession": null}` would switch sessions on for a user who never accepted the
    // migration. Both ingresses that can carry one, the API patch and the settings-file
    // watcher, pass through here, which is why the guard lives in this function rather
    // than at either call site (110 §4b-3).
    if (Object.prototype.hasOwnProperty.call(input, 'multiSession') && !isPlainRecord(input["multiSession"])) {
        delete value["multiSession"];
        invalidPaths.push('multiSession');
    } else if (isPlainRecord(input["multiSession"])) {
        const block = { ...input["multiSession"] };
        // Same reasoning one level down: a non-object `channels` reaches the per-channel
        // reads as something that is not indexable.
        if (Object.prototype.hasOwnProperty.call(block, 'channels') && !isPlainRecord(block["channels"])) {
            delete block["channels"];
            invalidPaths.push('multiSession.channels');
        }
        value["multiSession"] = block;
    }

    // `permissions` has a public shape — 'auto' | 'safe' | token[] — shared with the
    // native ACP consumer, which fails closed (invalid_native_permissions) on anything
    // else. Without this guard an authenticated patch like {permissions:{}} reached disk
    // and each surface read the same stored bytes differently (#788).
    if (Object.hasOwn(input, 'permissions') && !isPermissionsPolicy(input['permissions'])) {
        delete value['permissions'];
        invalidPaths.push('permissions');
    }

    return {
        value,
        persistenceShape,
        serverOwnedPaths,
        invalidPaths,
        rejectedPaths,
    };
}

/** Which nested groups survive a PARTIAL document or patch, and how deep.
 *
 *  One table, read by both ingresses: the boot merge in config.loadSettings and
 *  the API/watch merge below. They used to be two hand-maintained lists that
 *  drifted — boot replaced heartbeat/stt/presentation wholesale while the API
 *  merged them, and the API replaced avatar wholesale while boot merged it — so
 *  which sibling keys a partial write destroyed depended on which door it came
 *  through. A key absent from this table is REPLACED wholesale, deliberately:
 *  arrays like messaging.enabledChannels and employees must not be union-merged.
 *
 *  This table is merge policy only. Normalization (ack, slack.autoJoin,
 *  search.engine) runs AFTER a layer and is not expressible here: those rules
 *  repair a value rather than combine two of them. */
export type NestedMergeRule =
    | { kind: 'perEntry' }
    | { kind: 'shallow' }
    | { kind: 'nested'; children: readonly string[] };

export const SETTINGS_MERGE_SPEC: Readonly<Record<string, NestedMergeRule>> = {
    perCli: { kind: 'perEntry' },
    activeOverrides: { kind: 'perEntry' },
    telegram: { kind: 'nested', children: ['ack'] },
    discord: { kind: 'nested', children: ['ack'] },
    slack: { kind: 'nested', children: ['ack', 'autoJoin'] },
    dispatchApproval: { kind: 'nested', children: ['operators'] },
    network: { kind: 'nested', children: ['remoteAccess'] },
    runtime: { kind: 'nested', children: ['codexApp'] },
    multiSession: { kind: 'nested', children: ['channels'] },
    avatar: { kind: 'nested', children: ['agent', 'user'] },
    messaging: { kind: 'nested', children: ['latestSeen', 'lastActive'] },
    heartbeat: { kind: 'shallow' },
    telegramHub: { kind: 'shallow' },
    memory: { kind: 'shallow' },
    stt: { kind: 'shallow' },
    jawCeo: { kind: 'shallow' },
    pi: { kind: 'shallow' },
    tui: { kind: 'shallow' },
    wiki: { kind: 'shallow' },
    code: { kind: 'shallow' },
    search: { kind: 'shallow' },
    trace: { kind: 'shallow' },
    presentation: { kind: 'shallow' },
};

/** Lay the incoming document over the base per SETTINGS_MERGE_SPEC, mutating neither. */
export function mergeSettingsLayer(
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
        const rule = SETTINGS_MERGE_SPEC[key];
        // A scalar, an array or an explicit null replaces the block. Only an
        // object can be merged into one, and only a named key is merged at all.
        if (!rule || !isPlainRecord(value)) {
            result[key] = value;
            continue;
        }
        const current = isPlainRecord(base[key]) ? base[key] : {};
        if (rule.kind === 'perEntry') {
            const merged: Record<string, unknown> = { ...current };
            for (const [entry, cfg] of Object.entries(value)) {
                merged[entry] = isPlainRecord(cfg) && isPlainRecord(merged[entry])
                    ? { ...merged[entry], ...cfg }
                    : cfg;
            }
            result[key] = merged;
            continue;
        }
        const merged: Record<string, unknown> = { ...current, ...value };
        if (rule.kind === 'nested') {
            for (const child of rule.children) {
                if (!isPlainRecord(value[child])) continue;
                const childBase = isPlainRecord(current[child]) ? current[child] : {};
                merged[child] = { ...childBase, ...value[child] };
            }
        }
        result[key] = merged;
    }
    return result;
}

/**
 * settings 객체에 patch를 deep merge
 * @param {object} current - 현재 settings
 * @param {object} patch - 적용할 패치
 * @returns {object} 새 settings (current를 직접 변경하지 않음)
 */
export function mergeSettingsPatch(current: Record<string, any>, patch: Record<string, any>) {
    // The layer speaks in unknown so it adds no any-typed surface; the patch API
    // has always handed callers an indexable settings object, so it keeps doing so.
    const result = mergeSettingsLayer(structuredClone(current), patch) as Record<string, any>;

    // Normalization, not merging. ack.emoji is a third level the spec does not
    // reach, and slack.autoJoin has to be REPAIRED rather than combined: its
    // budget reaches a loop that joins real channels, so {autoJoin:null} and
    // {autoJoin:'yes'} must not survive to disk, where the next boot would read
    // them as absent and quietly restore default-on. Reads the original patch
    // because the layer above has already consumed the key.
    for (const key of ['telegram', 'discord', 'slack']) {
        const patchChannel = patch[key];
        if (!isPlainRecord(patchChannel)) continue;
        const currentChannel = isPlainRecord(current[key]) ? current[key] : undefined;
        const patchAck = patchChannel['ack'];
        if (isPlainRecord(patchAck)) {
            result[key] = { ...result[key], ack: mergeAckSettings(currentChannel?.['ack'], patchAck) };
        }
        // Any mention of autoJoin is repaired, including a malformed one.
        if (key === 'slack' && 'autoJoin' in patchChannel) {
            result[key] = {
                ...result[key],
                autoJoin: mergeSlackAutoJoin(currentChannel?.['autoJoin'], patchChannel['autoJoin']),
            };
        }
    }

    return result;
}
