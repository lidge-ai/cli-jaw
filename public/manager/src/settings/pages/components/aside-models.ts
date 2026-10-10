import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SettingsClient } from '../../types';
import type { AsideCatalog, AsideModelEntry, AsideThinkingLevel } from '../../../../../../src/shared/aside-contract';

export const isAsideAccount = (account: string) => /^u(?:0|[1-9][0-9]{0,8})$/.test(account);
const levels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const qualified = (value: unknown): value is string => typeof value === 'string' && /^[^/\s]+\/.+/.test(value);

/** SettingsClient returns raw JSON. Reject mismatched context and malformed wire data. */
export function unwrapAsideCatalog(raw: unknown, account: string): AsideCatalog {
    if (!record(raw) || raw['ok'] !== true || !record(raw['data'])) throw new Error('Aside catalog response is unavailable.');
    const data = raw['data'];
    const context = data['context'];
    if (!record(context) || context['account'] !== account || context['host'] !== 'local'
        || data['source'] !== 'local-files' || !['available', 'partial', 'unavailable'].includes(String(data['status']))
        || !Array.isArray(data['entries']) || !Array.isArray(data['cachedIds']) || !Array.isArray(data['diagnostics'])
        || (data['defaultModel'] !== null && !qualified(data['defaultModel']))) throw new Error('Invalid Aside catalog response.');
    const seen = new Set<string>();
    for (const entry of data['entries']) {
        if (!record(entry) || !qualified(entry['id']) || typeof entry['provider'] !== 'string'
            || typeof entry['modelId'] !== 'string' || entry['id'] !== `${entry['provider']}/${entry['modelId']}`
            || typeof entry['name'] !== 'string' || !['registered', 'unknown'].includes(String(entry['capability']))
            || !Array.isArray(entry['efforts']) || !entry['efforts'].every(e => typeof e === 'string' && levels.includes(e))
            || !record(entry['thinkingLevelMap']) || seen.has(entry['id'])) throw new Error('Invalid Aside model catalog.');
        seen.add(entry['id']);
    }
    const preference = data['configuredDefault'];
    if (preference !== null && (!record(preference) || typeof preference['provider'] !== 'string'
        || typeof preference['modelId'] !== 'string'
        || (preference['thinkingLevel'] !== undefined && !levels.includes(String(preference['thinkingLevel'])))))
        throw new Error('Invalid Aside default model.');
    if (data['defaultModel'] !== null && (!record(preference)
        || data['defaultModel'] !== `${preference['provider']}/${preference['modelId']}`)) throw new Error('Invalid Aside default model.');
    for (const diagnostic of data['diagnostics']) {
        if (!record(diagnostic) || !['context', 'models', 'settings'].includes(String(diagnostic['source']))
            || typeof diagnostic['code'] !== 'string' || typeof diagnostic['message'] !== 'string') throw new Error('Invalid Aside diagnostics.');
    }
    return data as unknown as AsideCatalog;
}

export type AsideInventory = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; catalog: AsideCatalog };
type Context = { client: SettingsClient; instanceUrl: string; port: number; account: string; enabled: boolean; revision: number };

export function useAsideModels(client: SettingsClient, instanceUrl: string, port: number, account: string, enabled = true) {
    const [revision, setRevision] = useState(0);
    const context = useMemo<Context>(() => ({ client, instanceUrl, port, account, enabled, revision }), [client, instanceUrl, port, account, enabled, revision]);
    const generation = useRef(0);
    const [result, setResult] = useState<{ context: Context; value: AsideInventory } | null>(null);
    useLayoutEffect(() => {
        const epoch = ++generation.current;
        let live = true;
        if (enabled && isAsideAccount(account)) {
            void client.get<unknown>(`/api/aside/models?account=${encodeURIComponent(account)}&host=local`).then(raw => {
                if (!live || epoch !== generation.current) return;
                setResult({ context, value: { kind: 'ready', catalog: unwrapAsideCatalog(raw, account) } });
            }).catch(() => {
                if (live && epoch === generation.current) setResult({ context, value: { kind: 'error', message: 'Could not read the local Aside catalog. Refresh to try again.' } });
            });
        }
        return () => { live = false; ++generation.current; };
    }, [context, client, account, enabled]);
    // Hide old inventory in the first render of a changed context, before effects.
    const inventory: AsideInventory = !isAsideAccount(account)
        ? { kind: 'error', message: 'Enter an explicit Aside account (uN).' }
        : result?.context === context ? result.value : { kind: 'loading' };
    const refresh = useCallback(() => setRevision(value => value + 1), []);
    return { inventory, refresh };
}

export function asideModelChoices(inventory: AsideInventory): Array<{ value: string; label: string }> {
    if (inventory.kind !== 'ready') return [];
    const catalog = inventory.catalog;
    if (catalog.status === 'unavailable' || catalog.diagnostics.some(d => d.source === 'models' || d.source === 'context')) return [];
    const ids = new Set(catalog.entries.map(e => e.id));
    if (catalog.defaultModel) ids.add(catalog.defaultModel);
    const defaultEntry = catalog.entries.find(e => e.id === catalog.defaultModel);
    const level = catalog.configuredDefault?.thinkingLevel;
    const defaultReady = !!catalog.defaultModel && (!level || defaultEntry?.capability !== 'registered' || defaultEntry.efforts.includes(level));
    return [
        ...(defaultReady ? [{ value: 'default', label: `Default (${catalog.defaultModel})` }] : []),
        ...Array.from(ids, value => ({ value, label: value })),
    ];
}

export function asideEffortChoices(inventory: AsideInventory, model: string): readonly string[] {
    if (inventory.kind !== 'ready' || !asideModelChoices(inventory).some(e => e.value === (model || 'default'))) return [];
    const catalog = inventory.catalog;
    const concrete = !model || model === 'default' ? catalog.defaultModel : model;
    const entry: AsideModelEntry | undefined = catalog.entries.find(e => e.id === concrete && e.capability === 'registered');
    if (entry) return entry.efforts;
    return concrete === catalog.defaultModel && catalog.configuredDefault?.thinkingLevel ? [catalog.configuredDefault.thinkingLevel] : [];
}

export function asideSelectionError(inventory: AsideInventory, model: string, effort: string): string | null {
    if (inventory.kind === 'loading') return 'Loading Aside models…';
    if (inventory.kind === 'error') return inventory.message;
    if (!asideModelChoices(inventory).some(e => e.value === (model || 'default'))) return 'This model is unavailable for the selected Aside account.';
    const concrete = !model || model === 'default' ? inventory.catalog.defaultModel : model;
    const effectiveEffort = effort && effort !== 'default' ? effort
        : concrete === inventory.catalog.defaultModel ? inventory.catalog.configuredDefault?.thinkingLevel : undefined;
    if (effectiveEffort && !asideEffortChoices(inventory, model).includes(effectiveEffort as AsideThinkingLevel)) return 'This effort is unavailable for the selected Aside model.';
    return null;
}
