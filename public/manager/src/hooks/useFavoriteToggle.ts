import { useCallback, useRef } from 'react';
import { publishInvalidation } from '../sync/invalidation-bus';
import type { DashboardInstance, DashboardRegistryLoadResult, DashboardRegistryPatch } from '../types';

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
