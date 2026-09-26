import { useCallback, useRef, useState } from 'react';
import { fetchRegistry, patchDashboardRegistry } from '../api';
import { publishInvalidation } from '../sync/invalidation-bus';
import type {
    DashboardInstance,
    DashboardRegistry,
    DashboardRegistryLoadResult,
    DashboardRegistryPatch,
    DashboardRegistryStatus,
} from '../types';

type DashboardRegistryState = {
    registry: DashboardRegistry | null;
    status: DashboardRegistryStatus | null;
    saving: boolean;
    error: string | null;
    apply: (result: DashboardRegistryLoadResult) => DashboardRegistryLoadResult;
    refresh: () => Promise<DashboardRegistryLoadResult>;
    save: (patch: DashboardRegistryPatch) => Promise<DashboardRegistryLoadResult | null>;
};

export function useDashboardRegistry(): DashboardRegistryState {
    const [registry, setRegistry] = useState<DashboardRegistry | null>(null);
    const [status, setStatus] = useState<DashboardRegistryStatus | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const applyResult = useCallback((result: DashboardRegistryLoadResult): DashboardRegistryLoadResult => {
        setRegistry(result.registry);
        setStatus(result.status);
        setError(result.status.error);
        return result;
    }, []);

    const refresh = useCallback(async (): Promise<DashboardRegistryLoadResult> => {
        try {
            return applyResult(await fetchRegistry());
        } catch (err) {
            setError((err as Error).message);
            throw err;
        }
    }, [applyResult]);

    const save = useCallback(async (patch: DashboardRegistryPatch): Promise<DashboardRegistryLoadResult | null> => {
        setSaving(true);
        try {
            return applyResult(await patchDashboardRegistry(patch));
        } catch (err) {
            setError((err as Error).message);
            return null;
        } finally {
            setSaving(false);
        }
    }, [applyResult]);

    return { registry, status, saving, error, apply: applyResult, refresh, save };
}

type FavoriteToggleDeps = {
    save: (patch: DashboardRegistryPatch) => Promise<DashboardRegistryLoadResult | null>;
    reload: () => void;
};

export function useFavoriteToggle({ save, reload }: FavoriteToggleDeps): (instance: DashboardInstance) => void {
    const pending = useRef(new Set<number>());
    return useCallback((instance: DashboardInstance) => {
        const port = instance.port;
        if (pending.current.has(port)) return;
        pending.current.add(port);
        void save({ instances: { [String(port)]: { favorite: !instance.favorite } } })
            .then(result => {
                if (!result) return;
                reload();
                publishInvalidation({ topics: ['instances'], reason: 'instance:favorite-toggled', source: 'ui', sourceId: 'app' });
            })
            .finally(() => pending.current.delete(port));
    }, [save, reload]);
}
