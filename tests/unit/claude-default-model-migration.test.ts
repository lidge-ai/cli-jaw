import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
    applyClaudeDefaultModelMigration,
    CLAUDE_DEFAULT_MODEL_MIGRATION_ID,
    DEFAULT_SETTINGS,
    JAW_HOME,
    loadSettings,
    settings,
    SETTINGS_PATH,
    settingsForHomeWithoutSettingsFile,
} from '../../src/core/config.ts';
import { getDefaultClaudeModel, claudeModelNeedsCatalogEntry } from '../../src/cli/claude-models.ts';
import { claudeCatalogSupports } from '../../src/cli/claude-default-model-boot.ts';

function home(model: unknown, extra: Record<string, unknown> = {}): Record<string, any> {
    return { perCli: { claude: { model, effort: 'medium' } }, ...extra };
}

test('default Claude model is Opus 5.5 and only 5.5 ids need a catalog entry', () => {
    assert.equal(getDefaultClaudeModel(), 'claude-opus-5-5');
    assert.equal(claudeModelNeedsCatalogEntry('claude-opus-5-5'), true);
    assert.equal(claudeModelNeedsCatalogEntry('claude-opus-5-5[1m]'), true);
    assert.equal(claudeModelNeedsCatalogEntry('claude-opus-4-8'), false);
    assert.equal(claudeModelNeedsCatalogEntry('opus'), false);
});

test('the previous default moves to Opus 5.5 when the CLI supports it', () => {
    const s = home('claude-opus-4-8');
    assert.deepEqual(applyClaudeDefaultModelMigration(s, true), { didChange: true });
    assert.equal(s.perCli.claude.model, 'claude-opus-5-5');
    assert.equal(s.perCli.claude.effort, 'medium');
    assert.deepEqual(s.claudeDefaultModelMigration, {
        id: CLAUDE_DEFAULT_MODEL_MIGRATION_ID, state: 'applied', from: 'claude-opus-4-8', to: 'claude-opus-5-5',
    });
});

for (const supports of [false, null] as const) {
    test(`no change and no stamp when support is ${supports}, so a later boot can still migrate`, () => {
        const s = home('claude-opus-4-8');
        assert.deepEqual(applyClaudeDefaultModelMigration(s, supports), { didChange: false });
        assert.equal(s.perCli.claude.model, 'claude-opus-4-8');
        assert.equal(s.claudeDefaultModelMigration, undefined);
    });
}

test('a home already on the target is stamped already-at-target', () => {
    const s = home('claude-opus-5-5');
    assert.deepEqual(applyClaudeDefaultModelMigration(s, true), { didChange: true });
    assert.equal(s.claudeDefaultModelMigration.state, 'already-at-target');
});

test('an explicit choice is left in place, and overrides are never touched', () => {
    const s = home('sonnet', { activeOverrides: { claude: { model: 'claude-opus-4-8' } } });
    assert.deepEqual(applyClaudeDefaultModelMigration(s, true), { didChange: true });
    assert.equal(s.perCli.claude.model, 'sonnet');
    assert.deepEqual(s.claudeDefaultModelMigration, { id: CLAUDE_DEFAULT_MODEL_MIGRATION_ID, state: 'left-in-place', from: 'sonnet' });
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-8');
});

test('a stamped home never migrates again', () => {
    const s = home('claude-opus-4-8', { claudeDefaultModelMigration: { id: CLAUDE_DEFAULT_MODEL_MIGRATION_ID, state: 'left-in-place' } });
    assert.deepEqual(applyClaudeDefaultModelMigration(s, true), { didChange: false });
    assert.equal(s.perCli.claude.model, 'claude-opus-4-8');
});

test('a home without a settings file starts at the target', () => {
    const next = settingsForHomeWithoutSettingsFile();
    assert.equal(next.claudeDefaultModelMigration?.state, 'already-at-target');
    assert.equal(next.claudeDefaultModelMigration?.to, 'claude-opus-5-5');
});

test('catalog support: plain ids, aliases and 1M variants', () => {
    const catalog = { firstParty: ['claude-opus-5-5', 'claude-opus-4-8'], aliases: { opus: 'claude-opus-5' }, oneMillion: ['claude-opus-4-8'] };
    assert.equal(claudeCatalogSupports(catalog, 'claude-opus-5-5'), true);
    assert.equal(claudeCatalogSupports(catalog, 'claude-opus-5'), true);
    assert.equal(claudeCatalogSupports(catalog, 'claude-opus-5-5[1m]'), false);
    assert.equal(claudeCatalogSupports(catalog, 'claude-opus-4-8[1m]'), true);
    assert.equal(claudeCatalogSupports({ firstParty: ['claude-opus-4-8'], aliases: {}, oneMillion: [] }, 'claude-opus-5-5'), false);
});

test('a stored stamp survives loading, and a malformed one is not accepted as valid', () => {
    if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
    const value = structuredClone(DEFAULT_SETTINGS) as Record<string, any>;
    value['workingDir'] = JAW_HOME;
    value['claudeDefaultModelMigration'] = { id: CLAUDE_DEFAULT_MODEL_MIGRATION_ID, state: 'applied', from: 'claude-opus-4-8', to: 'claude-opus-5-5' };
    writeFileSync(SETTINGS_PATH, JSON.stringify(value));
    loadSettings();
    assert.deepEqual(settings['claudeDefaultModelMigration'], value['claudeDefaultModelMigration']);
    const onDisk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    assert.equal(onDisk.claudeDefaultModelMigration.state, 'applied');

    value['claudeDefaultModelMigration'] = { id: CLAUDE_DEFAULT_MODEL_MIGRATION_ID, state: 'applied', extra: true };
    writeFileSync(SETTINGS_PATH, JSON.stringify(value));
    loadSettings();
    assert.notDeepEqual(settings['claudeDefaultModelMigration'], value['claudeDefaultModelMigration']);
});

test('the synchronous gate never refuses without a cached catalog or for ungated ids', async () => {
    const { claudeModelGateMessage } = await import('../../src/cli/claude-default-model-boot.ts');
    assert.equal(claudeModelGateMessage(null, 'claude-opus-5-5'), null);
    assert.equal(claudeModelGateMessage('/nonexistent/claude', 'claude-opus-5-5'), null);
    assert.equal(claudeModelGateMessage('/nonexistent/claude', 'claude-opus-4-8'), null);
});
