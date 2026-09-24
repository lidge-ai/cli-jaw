/**
 * Live model snapshots for the Code catalog's non-Codex providers.
 *
 * `CodeProvider.describe()` is synchronous and runs on every catalog read, so it
 * cannot await a discovery probe. `live-models.ts` already solved that for Codex
 * with an in-memory snapshot plus a background refresh; this is the same shape for
 * Claude, Cursor and Grok.
 *
 * The difference is what filling a snapshot costs. Codex reads HTTP and Claude
 * reads a file, but Cursor and Grok SPAWN THEIR CLI. catalog.ts states the rule
 * that makes that unacceptable on a read path: "catalogs must never execute a CLI
 * or a login probe". A catalog render must not start a process, wait on a login
 * prompt, or block on a slow binary.
 *
 * So the two are separated. A read never probes for Cursor or Grok; only an
 * explicit prime does — `CodeHost.prime()`, called once by server startup, is
 * the sole owner — and `describe()` returns whatever is already in memory.
 */
import { claudeCatalogToChoices, resolveClaudeBundleCatalog } from '../../cli/claude-model-discovery.js';
import { buildClaudeEffortsByModel } from '../../cli/claude-models.js';
import { fetchCursorModelInventory } from '../../agent/cursor-model-inventory.js';
import { fetchGrokModelInventory } from '../../agent/grok-models.js';
import { detectCli } from '../../core/cli-detection.js';

/** Providers whose catalog this module can fill. Codex keeps its own module. */
export type LiveCatalogProviderId = 'claude' | 'cursor' | 'grok';

export interface ProviderLiveModels {
    models: string[];
    effortsByModel?: Record<string, string[]>;
    source: string;
}

/**
 * Whether a read is allowed to schedule a refresh for this provider.
 *
 * Claude's source is a file read, which is safe to trigger from a render. Cursor
 * and Grok spawn a CLI, so only an explicit prime may fill them.
 */
const REFRESH_ON_READ: Record<LiveCatalogProviderId, boolean> = {
    claude: true, cursor: false, grok: false,
};

/** How long a snapshot is served before a read schedules a refresh. */
const REFRESH_AFTER_MS = 60_000;
/**
 * Floor between attempts after a failed probe, so a permanently absent CLI does
 * not start work on every catalog read.
 */
const RETRY_AFTER_MS = 300_000;

interface SnapshotSlot {
    value: ProviderLiveModels | null;
    fetchedAt: number;
    attemptedAt: number;
    inFlight: Promise<void> | null;
}

const slots = new Map<LiveCatalogProviderId, SnapshotSlot>();

function slotOf(id: LiveCatalogProviderId): SnapshotSlot {
    let slot = slots.get(id);
    if (!slot) {
        slot = { value: null, fetchedAt: 0, attemptedAt: 0, inFlight: null };
        slots.set(id, slot);
    }
    return slot;
}

async function probe(id: LiveCatalogProviderId): Promise<ProviderLiveModels | null> {
    if (id === 'claude') {
        const detection = detectCli('claude');
        if (!detection.available || !detection.path) return null;
        const catalog = await resolveClaudeBundleCatalog(detection.path);
        if (!catalog) return null;
        const models = claudeCatalogToChoices(catalog);
        return models.length > 0
            ? { models, effortsByModel: buildClaudeEffortsByModel(models), source: 'claude-bundle' }
            : null;
    }
    if (id === 'cursor') {
        const inventory = await fetchCursorModelInventory();
        return inventory && inventory.baseModels.length > 0
            ? { models: inventory.baseModels, effortsByModel: inventory.effortsByModel, source: inventory.source }
            : null;
    }
    const inventory = await fetchGrokModelInventory();
    return inventory && inventory.models.length > 0
        ? { models: inventory.models, source: inventory.source }
        : null;
}

function refresh(id: LiveCatalogProviderId, force: boolean): Promise<void> | null {
    const slot = slotOf(id);
    if (slot.inFlight) return slot.inFlight;
    if (!force && slot.attemptedAt && Date.now() - slot.attemptedAt < RETRY_AFTER_MS) return null;
    slot.attemptedAt = Date.now();
    slot.inFlight = probe(id)
        .then(result => {
            // A failed probe keeps the previous snapshot: one unreachable poll
            // should not empty a picker that was working a moment ago.
            if (!result) return;
            slot.value = result;
            slot.fetchedAt = Date.now();
        })
        .catch(() => { /* the previous snapshot stays authoritative */ })
        .finally(() => { slot.inFlight = null; });
    return slot.inFlight;
}

/**
 * Last known catalog for a provider, or null before the first successful prime.
 * Never blocks, and never spawns a CLI.
 */
export function readProviderLiveModels(id: LiveCatalogProviderId): ProviderLiveModels | null {
    const slot = slotOf(id);
    if (REFRESH_ON_READ[id] && (!slot.value || Date.now() - slot.fetchedAt > REFRESH_AFTER_MS)) {
        refresh(id, false);
    }
    return slot.value;
}

/**
 * Fill every provider snapshot, including the ones a read will not fill on its
 * own. This is the only path that spawns Cursor's or Grok's CLI.
 */
export async function primeProviderLiveModels(): Promise<void> {
    const ids: LiveCatalogProviderId[] = ['claude', 'cursor', 'grok'];
    await Promise.all(ids.map(id => refresh(id, true) ?? Promise.resolve()));
}

/** @internal exported for unit tests */
export function resetProviderLiveModelsForTest(
    seed?: Partial<Record<LiveCatalogProviderId, ProviderLiveModels>>,
): void {
    slots.clear();
    for (const [id, value] of Object.entries(seed ?? {})) {
        slots.set(id as LiveCatalogProviderId, {
            value: value ?? null, fetchedAt: Date.now(), attemptedAt: Date.now(), inFlight: null,
        });
    }
}
