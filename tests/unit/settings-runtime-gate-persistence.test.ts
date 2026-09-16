import test from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenario = process.env['CLI_JAW_SETTINGS_GATE_SCENARIO'];
const thisFile = fileURLToPath(import.meta.url);

function pending() {
    return {
        id: 'codex-app-default-v2',
        state: 'pending',
        fromCli: 'claude',
        toCli: 'codex-app',
    };
}

function document(
    cli = 'codex-app',
    runtime?: Record<string, unknown>,
): Record<string, unknown> {
    return {
        // At the current schema on purpose. These scenarios are about whether the
        // multiplex gate is rewritten to disk, and a document below the current schema
        // would be rewritten by its own migration — which would answer the question
        // before the gate ever got a say.
        settingsSchemaVersion: 4,
        runtimeDefaultMigration: cli === 'claude' ? pending() : null,
        multiSessionDefaultMigration: null,
        nativeTransportMigration: { id: 'native-transport-default-v1', state: 'already-native' },
        maxConcurrentDefaultMigration: {
            id: 'max-concurrent-default-v1',
            state: 'left-in-place',
            from: 2,
        },
        multiSession: {
            enabled: true,
            maxConcurrent: 2,
            midRunPolicy: 'steer',
            channels: { telegram: false, discord: false, slack: true },
        },
        messaging: {
            enabledChannels: ['telegram'],
            homeChannel: 'telegram',
        },
        cli,
        ...(runtime ? { runtime } : {}),
    };
}

function expectedPersisted(value: Record<string, any>): Record<string, any> {
    const expected = structuredClone(value);
    delete expected.runtimeSelectionDiagnostic;
    return expected;
}

function withoutAbsentGate(value: Record<string, any>): Record<string, any> {
    const expected = expectedPersisted(value);
    if (expected.runtime?.codexApp?.multiplex === false) {
        delete expected.runtime.codexApp.multiplex;
        if (Object.keys(expected.runtime.codexApp).length === 0) delete expected.runtime.codexApp;
        if (Object.keys(expected.runtime).length === 0) delete expected.runtime;
    }
    return expected;
}

async function runChildScenario(name: string): Promise<void> {
    const home = process.env['CLI_JAW_HOME'];
    assert.ok(home && home.startsWith(tmpdir()) && home !== tmpdir(), 'child requires an isolated temp CLI_JAW_HOME');

    const config = await import('../../src/core/config.ts');
    const write = (value: unknown): string => {
        const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        writeFileSync(config.SETTINGS_PATH, raw);
        return raw;
    };
    const disk = (): string => readFileSync(config.SETTINGS_PATH, 'utf8');
    const expectedAbsentRaw = (value: Record<string, any>): string => JSON.stringify(withoutAbsentGate(value), null, 2);

    if (name === 'unrelated-put') {
        write(document());
        config.loadSettings();
        const runtime = await import('../../src/core/runtime-settings.ts');
        const applied = await runtime.applyRuntimeSettingsPatch({ locale: 'en' });
        assert.equal(config.getSettingsPersistenceShape(), 'absent');
        assert.equal(disk(), expectedAbsentRaw(applied));
        return;
    }

    if (name === 'accept' || name === 'keep' || name === 'rollback') {
        write(document('claude'));
        config.loadSettings();
        const runtime = await import('../../src/core/runtime-settings.ts');
        const before = config.snapshotSettingsState();
        const action = name === 'keep' ? 'keep' : 'accept';
        const patch = runtime.resolveRuntimeDefaultMigration(config.settings, action);
        if (name === 'rollback') {
            await assert.rejects(runtime.applyRuntimeSettingsPatch(patch, {
                cliSwitchRefresh: async () => { throw new Error('golden refresh failure'); },
            }), /golden refresh failure/);
            assert.deepEqual(config.settings, before.value);
            assert.equal(config.getSettingsPersistenceShape(), before.shape);
            assert.equal(disk(), expectedAbsentRaw(before.value));
            return;
        }
        const applied = await runtime.applyRuntimeSettingsPatch(patch, {
            cliSwitchRefresh: async () => undefined,
        });
        assert.equal(config.getSettingsPersistenceShape(), 'absent');
        assert.equal(disk(), expectedAbsentRaw(applied));
        assert.equal(applied.runtimeDefaultMigration.state, name === 'accept' ? 'accepted' : 'kept');
        return;
    }

    if (name === 'port-save') {
        write(document());
        config.loadSettings();
        config.settings.port = '4567';
        config.saveSettings(config.settings);
        assert.equal(config.getSettingsPersistenceShape(), 'absent');
        assert.equal(disk(), expectedAbsentRaw(config.settings));
        return;
    }

    if (name === 'retired-diagnostic-save') {
        write(document('jwc'));
        config.loadSettings();
        assert.equal(config.settings.cli, 'jwc');
        assert.equal(config.settings.runtimeSelectionDiagnostic, 'retired_runtime:jwc');
        config.settings.port = '4567';
        config.saveSettings(config.settings);
        assert.equal(config.getSettingsPersistenceShape(), 'absent');
        assert.equal(disk(), expectedAbsentRaw(config.settings));
        assert.equal(Object.hasOwn(JSON.parse(disk()), 'runtimeSelectionDiagnostic'), false);
        assert.equal(config.settings.cli, 'jwc');
        assert.equal(config.settings.runtimeSelectionDiagnostic, 'retired_runtime:jwc');
        return;
    }

    if (name === 'side-effect-rollback') {
        write(document());
        config.loadSettings();
        const before = config.snapshotSettingsState();
        const runtime = await import('../../src/core/runtime-settings.ts');
        await assert.rejects(runtime.applyRuntimeSettingsPatch({ locale: 'en' }, {
            resetFallbackState: () => { throw new Error('injected post-write side effect failure'); },
        }), /injected post-write side effect failure/);
        assert.deepEqual(config.settings, before.value);
        assert.equal(config.getSettingsPersistenceShape(), before.shape);
        assert.equal(disk(), expectedAbsentRaw(before.value));
        return;
    }

    if (name === 'explicit-false' || name === 'explicit-true') {
        write(document());
        config.loadSettings();
        const runtime = await import('../../src/core/runtime-settings.ts');
        const multiplex = name === 'explicit-true';
        const applied = await runtime.applyRuntimeSettingsPatch({
            runtime: { codexApp: { multiplex } },
        });
        assert.equal(config.getSettingsPersistenceShape(), 'present');
        assert.equal(applied.runtime.codexApp.multiplex, multiplex);
        assert.equal(disk(), JSON.stringify(expectedPersisted(applied), null, 2));
        assert.equal(Object.hasOwn(JSON.parse(disk()), 'runtimeSelectionDiagnostic'), false);
        return;
    }

    if (name.startsWith('sequential-')) {
        write(document('codex-app', { codexApp: { multiplex: true } }));
        config.loadSettings();
        assert.equal(config.settings.runtime.codexApp.multiplex, true);
        assert.equal(config.getSettingsPersistenceShape(), 'present');

        if (name === 'sequential-malformed') {
            const malformed = write(document('codex-app', { codexApp: { multiplex: 'true' } }));
            const loaded = config.loadSettings();
            assert.equal(loaded.runtime.codexApp.multiplex, false);
            assert.equal(config.getSettingsPersistenceShape(), 'absent');
            assert.equal(disk(), malformed);
            return;
        }
        if (name === 'sequential-future') {
            const future = write({ settingsSchemaVersion: 99, cli: 'codex-app' });
            const loaded = config.loadSettings();
            assert.equal(loaded.runtime.codexApp.multiplex, false);
            assert.equal(config.getSettingsPersistenceShape(), 'absent');
            assert.equal(disk(), future);
            return;
        }
        if (name === 'sequential-enoent') {
            unlinkSync(config.SETTINGS_PATH);
            const loaded = config.loadSettings();
            assert.equal(loaded.runtime.codexApp.multiplex, false);
            assert.equal(config.getSettingsPersistenceShape(), 'absent');
            assert.equal(disk(), expectedAbsentRaw(loaded));
            return;
        }
        const corrupt = write('{broken-json');
        const loaded = config.loadSettings();
        assert.equal(loaded.runtime.codexApp.multiplex, false);
        assert.equal(config.getSettingsPersistenceShape(), 'absent');
        assert.equal(disk(), corrupt);
        return;
    }

    if (name === 'write-failure' || name === 'rollback-write-failure') {
        write(document(name === 'rollback-write-failure' ? 'claude' : 'codex-app'));
        config.loadSettings();
        const previous = config.snapshotSettingsState();
        const runtime = await import('../../src/core/runtime-settings.ts');

        if (name === 'write-failure') {
            const beforeRaw = disk();
            await assert.rejects(runtime.applyRuntimeSettingsPatch({
                runtime: { codexApp: { multiplex: true } },
            }, {
                writeSettings: () => { throw new Error('injected write failure'); },
            }), /injected write failure/);
            assert.deepEqual(config.settings, previous.value);
            assert.equal(config.getSettingsPersistenceShape(), previous.shape);
            assert.equal(disk(), beforeRaw);
            return;
        }

        let writes = 0;
        const patch = {
            ...runtime.resolveRuntimeDefaultMigration(config.settings, 'accept'),
            runtime: { codexApp: { multiplex: true } },
        };
        await assert.rejects(runtime.applyRuntimeSettingsPatch(patch, {
            cliSwitchRefresh: async () => { throw new Error('refresh after first write'); },
            writeSettings: (raw) => {
                writes += 1;
                if (writes === 2) throw new Error('injected rollback write failure');
                writeFileSync(config.SETTINGS_PATH, raw);
            },
        }), /refresh after first write/);
        assert.equal(writes, 2);
        assert.equal(config.settings.runtime.codexApp.multiplex, true);
        assert.equal(config.settings.runtimeDefaultMigration.state, 'accepted');
        assert.equal(config.getSettingsPersistenceShape(), 'present');
        assert.equal(disk(), JSON.stringify(expectedPersisted(config.settings), null, 2));
        assert.equal(Object.hasOwn(JSON.parse(disk()), 'runtimeSelectionDiagnostic'), false);
        return;
    }

    assert.fail(`unknown child scenario: ${name}`);
}

if (scenario) {
    await runChildScenario(scenario);
} else {
    const scenarios = [
        'unrelated-put',
        'accept',
        'keep',
        'rollback',
        'side-effect-rollback',
        'port-save',
        'retired-diagnostic-save',
        'explicit-false',
        'explicit-true',
        'sequential-malformed',
        'sequential-future',
        'sequential-enoent',
        'sequential-corrupt',
        'write-failure',
        'rollback-write-failure',
    ];

    for (const name of scenarios) {
        test(`SGP-${name}: isolated persistence scenario`, () => {
            const home = mkdtempSync(join(tmpdir(), `cli-jaw-settings-gate-${name}-`));
            try {
                const result = spawnSync(process.execPath, ['--import', 'tsx', thisFile], {
                    env: {
                        ...process.env,
                        CLI_JAW_HOME: home,
                        CLI_JAW_SETTINGS_GATE_SCENARIO: name,
                    },
                    encoding: 'utf8',
                    timeout: 30_000,
                });
                assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
            } finally {
                if (existsSync(home)) rmSync(home, { recursive: true, force: true });
            }
        });
    }
}
