// 110 ON-07b — the cohort rules were written around "a new install has no settings.json",
// but the documented install path writes one. If that document does not say which schema
// it belongs to, the loader reads it as v1 and hands a brand-new install the legacy
// baseline plus a migration offer for a state it never had.
//
// This runs the real `init` rather than reading its source, because what matters is the
// document that lands on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SCHEMA_VERSION } from '../../src/core/config.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runInit(home: string, extraArgs: string[] = []): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [
        '--import', 'tsx',
        join(projectRoot, 'bin/commands/init.ts'),
        'init', '--non-interactive', ...extraArgs,
    ], {
        // What this suite asserts is the settings document init writes. Installing
        // provider CLIs, MCP servers, and skill deps is a different concern, and on
        // a clean CI runner those npm installs take longer than the step allows —
        // the run then fails before the first assertion. Same skip switches the
        // sibling init suites use.
        env: {
            ...process.env,
            CLI_JAW_HOME: home,
            CLI_JAW_SKIP_CLI_TOOLS: '1',
            CLI_JAW_SKIP_MCP_SERVERS: '1',
            CLI_JAW_SKIP_SKILL_DEPS: '1',
            CLI_JAW_SKIP_CLAUDE: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
    });
    return { status: result.status, output: [result.stdout, result.stderr].filter(Boolean).join('\n') };
}

function withHome(fn: (home: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), 'cli-jaw-init-schema-'));
    try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('init writes a document that names its schema and carries what that schema requires', () => {
    withHome((home) => {
        const { status, output } = runInit(home);
        assert.equal(status, 0, output);

        const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(written['settingsSchemaVersion'], SETTINGS_SCHEMA_VERSION,
            'an unstamped document reads as v1 and the install is classified as legacy');
        const sessions = written['multiSession'] as Record<string, unknown> | undefined;
        assert.ok(sessions, 'a document claiming this schema must carry the block this schema writes');
        assert.equal(sessions?.['enabled'], true, 'a new install starts with sessions on');
        assert.equal(sessions?.['maxConcurrent'], 20);
        assert.equal(written['multiSessionDefaultMigration'], null,
            'there is no prior state to migrate from, so there is nothing to ask about');
        assert.equal((written['nativeTransportMigration'] as { state?: string } | undefined)?.state, 'already-native');
        assert.equal((written['maxConcurrentDefaultMigration'] as { state?: string } | undefined)?.state, 'already-at-target');
    });
});

// Rerunning init over an existing installation is the same mistake pointing the other way:
// stamping that document would let a genuine legacy install claim the current schema, skip
// its migration, and be switched on without ever being asked.
test('init over an existing document does not restamp it as the current schema', () => {
    withHome((home) => {
        writeFileSync(join(home, 'settings.json'), JSON.stringify({
            cli: 'claude',
            multiSession: { enabled: false, maxConcurrent: 1 },
        }, null, 2));

        const { status, output } = runInit(home, ['--force']);
        assert.equal(status, 0, output);

        const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
        assert.equal('settingsSchemaVersion' in written, false,
            'an existing installation stays in its own cohort and gets asked');
    });
});
