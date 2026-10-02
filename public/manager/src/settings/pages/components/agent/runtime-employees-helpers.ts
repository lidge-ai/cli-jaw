import type { SettingsClient } from '../../../types';
import { auxiliaryRuntimeOptions, type CliMeta } from './agent-meta';

export type RuntimeEmployeeSource = 'static' | 'db';

export type RuntimeEmployeeRecord = {
    id: string;
    name: string;
    cli: string;
    model: string;
    role: string;
    status?: string;
    source: RuntimeEmployeeSource;
};

export type RuntimeEmployeesResponse = {
    ok: true;
    data: RuntimeEmployeeRecord[];
};

export type RuntimeEmployeeChangeSummary = {
    added: number;
    updated: number;
    removed: number;
};

export type RuntimeEmployeeDiff = {
    added: RuntimeEmployeeRecord[];
    updated: Array<{ before: RuntimeEmployeeRecord; after: RuntimeEmployeeRecord; patch: Partial<RuntimeEmployeeRecord> }>;
    removed: RuntimeEmployeeRecord[];
};

export function isStaticEmployee(row: Pick<RuntimeEmployeeRecord, 'id' | 'source'>): boolean {
    return row.source === 'static' || row.id.startsWith('static:');
}

export function newRuntimeEmployeeId(): string {
    return `new:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function makeDefaultRuntimeEmployee(
    cliOptions: ReadonlyArray<string>,
    cliMeta?: Record<string, CliMeta> | null,
): RuntimeEmployeeRecord {
    const cli = auxiliaryRuntimeOptions(cliOptions)[0] || 'claude';
    const model = cliMeta?.[cli]?.models?.[0] || 'default';
    return {
        id: newRuntimeEmployeeId(),
        name: 'New Agent',
        cli,
        model,
        role: '',
        status: 'idle',
        source: 'db',
    };
}

export function unwrapRuntimeEmployees(response: RuntimeEmployeesResponse | RuntimeEmployeeRecord[]): RuntimeEmployeeRecord[] {
    if (Array.isArray(response)) return response.map(normalizeRuntimeEmployee).filter(Boolean) as RuntimeEmployeeRecord[];
    return response.data.map(normalizeRuntimeEmployee).filter(Boolean) as RuntimeEmployeeRecord[];
}

export function normalizeRuntimeEmployee(value: unknown): RuntimeEmployeeRecord | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'] : '';
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    if (!id || !name) return null;
    const source = row['source'] === 'static' || id.startsWith('static:') ? 'static' : 'db';
    const employee: RuntimeEmployeeRecord = {
        id,
        name,
        cli: typeof row['cli'] === 'string' && row['cli'] ? row['cli'] : 'claude',
        model: typeof row['model'] === 'string' && row['model'] ? row['model'] : 'default',
        role: typeof row['role'] === 'string' ? row['role'] : '',
        source,
    };
    if (typeof row['status'] === 'string') employee.status = row['status'];
    return employee;
}

export function runtimeEmployeeError(row: RuntimeEmployeeRecord): string | null {
    if (!row.name.trim()) return 'Name is required';
    if (row.cli === 'aside') return 'Aside supports the main agent only';
    if (!row.cli.trim()) return 'CLI is required';
    if (!row.model.trim()) return 'Model is required';
    return null;
}

export function runtimeEmployeesHaveErrors(rows: ReadonlyArray<RuntimeEmployeeRecord>): boolean {
    return rows.some((row) => runtimeEmployeeError(row) !== null);
}

export function runtimeEmployeesEqual(
    a: ReadonlyArray<RuntimeEmployeeRecord>,
    b: ReadonlyArray<RuntimeEmployeeRecord>,
): boolean {
    return JSON.stringify(a.map(stableRuntimeEmployee)) === JSON.stringify(b.map(stableRuntimeEmployee));
}

export function buildRuntimeEmployeeDiff(
    original: ReadonlyArray<RuntimeEmployeeRecord>,
    next: ReadonlyArray<RuntimeEmployeeRecord>,
): RuntimeEmployeeDiff {
    const originalById = new Map(original.map((row) => [row.id, row]));
    const nextIds = new Set(next.map((row) => row.id));
    const added: RuntimeEmployeeRecord[] = [];
    const updated: RuntimeEmployeeDiff['updated'] = [];
    const removed: RuntimeEmployeeRecord[] = [];

    for (const row of next) {
        const before = originalById.get(row.id);
        if (!before || row.id.startsWith('new:')) {
            added.push(row);
            continue;
        }
        const patch = changedRuntimeEmployeeFields(before, row);
        if (Object.keys(patch).length > 0) updated.push({ before, after: row, patch });
    }

    for (const row of original) {
        if (!nextIds.has(row.id) && !isStaticEmployee(row)) removed.push(row);
    }

    return { added, updated, removed };
}

export function runtimeEmployeeChangeSummary(
    original: ReadonlyArray<RuntimeEmployeeRecord>,
    next: ReadonlyArray<RuntimeEmployeeRecord>,
): RuntimeEmployeeChangeSummary {
    const diff = buildRuntimeEmployeeDiff(original, next);
    return {
        added: diff.added.length,
        updated: diff.updated.length,
        removed: diff.removed.length,
    };
}

export async function applyRuntimeEmployeesDiff(
    client: SettingsClient,
    original: ReadonlyArray<RuntimeEmployeeRecord>,
    next: ReadonlyArray<RuntimeEmployeeRecord>,
): Promise<void> {
    const diff = buildRuntimeEmployeeDiff(original, next);
    for (const row of diff.removed) {
        await client.delete<{ ok: true }>(`/api/employees/${encodeURIComponent(row.id)}`);
    }
    for (const row of diff.added) {
        await client.post<RuntimeEmployeeRecord>('/api/employees', toDbCreatePayload(row));
    }
    for (const item of diff.updated) {
        await client.put<RuntimeEmployeeRecord>(
            `/api/employees/${encodeURIComponent(item.after.id)}`,
            item.patch,
        );
    }
}

function changedRuntimeEmployeeFields(
    before: RuntimeEmployeeRecord,
    after: RuntimeEmployeeRecord,
): Partial<RuntimeEmployeeRecord> {
    if (isStaticEmployee(after)) {
        return before.model !== after.model ? { model: after.model } : {};
    }
    const patch: Partial<RuntimeEmployeeRecord> = {};
    for (const key of ['name', 'cli', 'model', 'role', 'status'] as const) {
        if ((before[key] || '') !== (after[key] || '')) patch[key] = after[key] || '';
    }
    return patch;
}

function toDbCreatePayload(row: RuntimeEmployeeRecord): Record<string, string> {
    return {
        name: row.name.trim() || 'New Agent',
        cli: row.cli.trim() || 'claude',
        model: row.model.trim() || 'default',
        role: row.role.trim(),
    };
}

function stableRuntimeEmployee(row: RuntimeEmployeeRecord): RuntimeEmployeeRecord {
    const stable: RuntimeEmployeeRecord = {
        id: row.id,
        name: row.name,
        cli: row.cli,
        model: row.model,
        role: row.role,
        source: row.source,
    };
    if (row.status !== undefined) stable.status = row.status;
    return stable;
}
