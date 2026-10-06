import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { conflictSettingsFromError, splitAgentSaveBundle } from '../../public/manager/src/settings/pages/Agent';
import { SettingsRequestError } from '../../public/manager/src/settings/settings-client';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import {
    buildRuntimeEmployeeDiff,
    makeDefaultRuntimeEmployee,
    runtimeEmployeeChangeSummary,
    unwrapRuntimeEmployees,
    type RuntimeEmployeeRecord,
} from '../../public/manager/src/settings/pages/components/agent/runtime-employees-helpers';
import {
    metaFor,
    runtimeEffortFor,
    runtimeModelFor,
} from '../../public/manager/src/settings/pages/components/agent/agent-meta';

const dbEmployee: RuntimeEmployeeRecord = {
    id: 'db-1',
    name: 'Frontend',
    cli: 'claude',
    model: 'claude-sonnet-4-6',
    role: 'UI',
    status: 'idle',
    source: 'db',
};

const staticEmployee: RuntimeEmployeeRecord = {
    id: 'static:future-specialist',
    name: 'Future Specialist',
    cli: 'codex',
    model: 'gpt-5.4',
    role: 'Computer use',
    status: 'idle',
    source: 'static',
};

test('splitAgentSaveBundle keeps synthetic keys out of /api/settings patch', () => {
    const bundle = {
        cli: 'codex',
        workingDir: '/work',
        'activeOverrides.codex.model': 'gpt-5.5',
        permissions: 'auto',
        flushCli: 'claude',
        flushModel: 'claude-haiku-4-5',
        runtimeEmployees: [dbEmployee],
    };
    const split = splitAgentSaveBundle(bundle);
    assert.deepEqual(expandPatch(split.settingsBundle), {
        cli: 'codex',
        workingDir: '/work',
        activeOverrides: { codex: { model: 'gpt-5.5' } },
        permissions: 'auto',
    });
    assert.deepEqual(split.flushPatch, { cli: 'claude', model: 'claude-haiku-4-5' });
    assert.deepEqual(split.runtimeEmployeesNext, [dbEmployee]);
});

test('runtime model and effort prefer active overrides over per-cli defaults', () => {
    const perCli = { codex: { model: 'gpt-5.4', effort: 'medium' } };
    const overrides = { codex: { model: 'gpt-5.5', effort: 'high' } };
    assert.equal(runtimeModelFor('codex', perCli, overrides), 'gpt-5.5');
    assert.equal(runtimeEffortFor('codex', perCli, overrides), 'high');
});

test('claude-e id is displayed as Claude E (retired)', () => {
    assert.equal(metaFor('claude-e').label, 'Claude E (retired)');
});

test('runtime employee GET wrapper unwraps { ok, data } responses', () => {
    const rows = unwrapRuntimeEmployees({ ok: true, data: [staticEmployee, dbEmployee] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.source, 'static');
    assert.equal(rows[1]?.source, 'db');
});

test('runtime employee diff respects static model-only edits and DB deletion', () => {
    const nextStatic = { ...staticEmployee, model: 'gpt-5.5' };
    const diff = buildRuntimeEmployeeDiff(
        [staticEmployee, dbEmployee],
        [nextStatic, { ...dbEmployee, role: 'Frontend UI' }],
    );
    assert.deepEqual(diff.updated.map((item) => item.patch), [
        { model: 'gpt-5.5' },
        { role: 'Frontend UI' },
    ]);

    const removed = buildRuntimeEmployeeDiff([staticEmployee, dbEmployee], [staticEmployee]);
    assert.deepEqual(removed.removed, [dbEmployee]);
});

test('runtime employee summary counts added, updated, and removed rows', () => {
    const next: RuntimeEmployeeRecord[] = [
        { ...staticEmployee, model: 'gpt-5.5' },
        { ...dbEmployee, id: 'new:1', name: 'Backend' },
    ];
    const summary = runtimeEmployeeChangeSummary([staticEmployee, dbEmployee], next);
    assert.deepEqual(summary, { added: 1, updated: 1, removed: 1 });
});

test('new runtime employee defaults to first live CLI metadata model', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], {
        codex: {
            label: 'Codex',
            models: ['gpt-5.5', 'kiro/claude-opus-4.8', 'opencode-go/kimi-k2.7-code'],
            efforts: ['low', 'medium', 'high', 'xhigh'],
        },
    });
    assert.equal(row.cli, 'codex');
    assert.equal(row.model, 'gpt-5.5');
});

test('new runtime employee can default to active ocx routed metadata model', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], {
        codex: {
            label: 'Codex',
            models: ['kiro/claude-opus-4.8', 'gpt-5.5'],
            efforts: ['low', 'medium', 'high', 'xhigh'],
        },
    });
    assert.equal(row.model, 'kiro/claude-opus-4.8');
});

test('new runtime employee keeps default model when live CLI metadata is absent', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], null);
    assert.equal(row.cli, 'codex');
    assert.equal(row.model, 'default');
});

test('runtimeEmployees dirty key is valid only when rows are valid', () => {
    const store = createDirtyStore();
    const invalid = [{ ...dbEmployee, model: '' }];
    store.set('runtimeEmployees', { value: invalid, original: [dbEmployee], valid: false });
    assert.equal(store.isDirty(), true);
    assert.equal('runtimeEmployees' in store.saveBundle(), false);
});

test('Manager rehydrates only a 409 migration conflict snapshot', () => {
    const pending = { cli: 'claude', runtimeDefaultMigration: { state: 'pending' } };
    const terminal = { cli: 'claude', runtimeDefaultMigration: { state: 'kept' } };
    const conflict = new SettingsRequestError(
        'POST',
        '/api/settings/runtime-default-migration',
        409,
        JSON.stringify({ ok: false, error: 'runtime_default_migration_terminal', settings: terminal }),
    );
    assert.deepEqual(conflictSettingsFromError(conflict), terminal);
    assert.equal(conflictSettingsFromError(new SettingsRequestError('POST', '/api/settings/runtime-default-migration', 500, JSON.stringify({ settings: terminal }))), null);
    assert.equal(conflictSettingsFromError(new Error(JSON.stringify({ settings: terminal }))), null);
    assert.equal(pending.runtimeDefaultMigration.state, 'pending', 'ordinary failures leave local pending unchanged');
});

test('an Agent save diffs employees against the server, not a stale page snapshot', async () => {
    // The Classic sidebar writes employees immediately and independently of this page's dirty
    // store. If a row is added or removed there while the Agent page is open, the page's
    // snapshot is stale — and the diff is what issues DELETE calls.
    const { saveAgentRuntime } = await import('../../public/manager/src/settings/pages/components/agent/agent-save');
    const emp = (id: string, name: string) => ({ id, name, cli: 'codex', model: 'default', role: '', source: 'db' as const });

    const calls: string[] = [];
    const serverNow = [emp('a', 'Alice'), emp('c', 'Carol')]; // 'c' was added from the sidebar
    const client = {
        async get<T>(path: string) { calls.push('GET ' + path); return { ok: true, data: serverNow } as T; },
        async put<T>(path: string) { calls.push('PUT ' + path); return {} as T; },
        async post<T>(path: string) { calls.push('POST ' + path); return {} as T; },
        async delete<T>(path: string) { calls.push('DELETE ' + path); return {} as T; },
    };

    await saveAgentRuntime({
        client,
        bundle: { runtimeEmployees: [emp('a', 'Alice renamed')] },
        employeeDraft: [emp('a', 'Alice renamed')],
        // What the page loaded before the sidebar added 'c'.
        employeeOriginal: [emp('a', 'Alice')],
    });

    assert.ok(calls.includes('GET /api/employees'),
        'the save must re-read employees before computing the destructive diff');
    assert.equal(calls.some(call => call.startsWith('DELETE')), false,
        'a row the sidebar added while this page was open must not be deleted by its save');
    assert.ok(calls.some(call => call.startsWith('PUT /api/employees/a')),
        'the intended rename must still be applied');
});

test('a failed employee re-read falls back to the page snapshot rather than blocking the save', async () => {
    const { saveAgentRuntime } = await import('../../public/manager/src/settings/pages/components/agent/agent-save');
    const emp = (id: string, name: string) => ({ id, name, cli: 'codex', model: 'default', role: '', source: 'db' as const });
    const calls: string[] = [];
    const client = {
        async get<T>(): Promise<T> { calls.push('GET'); throw new Error('offline'); },
        async put<T>(path: string) { calls.push('PUT ' + path); return {} as T; },
        async post<T>(path: string) { calls.push('POST ' + path); return {} as T; },
        async delete<T>(path: string) { calls.push('DELETE ' + path); return {} as T; },
    };
    await saveAgentRuntime({
        client,
        bundle: { runtimeEmployees: [emp('a', 'Alice renamed')] },
        employeeDraft: [emp('a', 'Alice renamed')],
        employeeOriginal: [emp('a', 'Alice')],
    });
    assert.ok(calls.some(call => call.startsWith('PUT /api/employees/a')),
        'an unreachable re-read must not silently drop the user\u2019s explicit edit');
});

test('an intentional employee deletion still deletes', async () => {
    // The stale-snapshot guard must not become a blanket refusal to delete: a row the page
    // loaded and the user removed is a real deletion.
    const { saveAgentRuntime } = await import('../../public/manager/src/settings/pages/components/agent/agent-save');
    const emp = (id: string, name: string) => ({ id, name, cli: 'codex', model: 'default', role: '', source: 'db' as const });
    const calls: string[] = [];
    const client = {
        async get<T>() { return { ok: true, data: [emp('a', 'Alice'), emp('b', 'Bob')] } as T; },
        async put<T>(path: string) { calls.push('PUT ' + path); return {} as T; },
        async post<T>(path: string) { calls.push('POST ' + path); return {} as T; },
        async delete<T>(path: string) { calls.push('DELETE ' + path); return {} as T; },
    };
    const draft = [emp('a', 'Alice')];
    await saveAgentRuntime({ client, bundle: { runtimeEmployees: draft }, employeeDraft: draft,
        employeeOriginal: [emp('a', 'Alice'), emp('b', 'Bob')] });
    assert.deepEqual(calls, ['DELETE /api/employees/b']);
});
