import test from 'node:test';
import assert from 'node:assert/strict';
import {
    migrateLegacyClaudeValue,
    getDefaultClaudeModel,
    getDefaultClaudeChoices,
    getClaudeModelKind,
    isClaudeCanonicalModel,
    CLAUDE_CANONICAL_MODELS,
    CLAUDE_LEGACY_VALUE_MAP,
} from '../../src/cli/claude-models.ts';

// ─── Canonical set ───────────────────────────────────

test('CM-001: canonical set contains exactly 4 short aliases', () => {
    assert.equal(CLAUDE_CANONICAL_MODELS.length, 4);
    assert.deepEqual([...CLAUDE_CANONICAL_MODELS].sort(), ['haiku', 'opus', 'sonnet', 'sonnet[1m]']);
});

test('CM-002: isClaudeCanonicalModel accepts all canonical values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.ok(isClaudeCanonicalModel(m), `${m} should be canonical`);
    }
});

test('CM-003: isClaudeCanonicalModel rejects non-canonical values', () => {
    assert.equal(isClaudeCanonicalModel('claude-sonnet-4-6'), false);
    assert.equal(isClaudeCanonicalModel('gpt-5.4'), false);
    assert.equal(isClaudeCanonicalModel(''), false);
});

// ─── Legacy migration ────────────────────────────────

test('CM-004: migrateLegacyClaudeValue passes full Claude IDs through unchanged', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6[1m]');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6[1m]'), 'claude-opus-4-6[1m]');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-7'), 'claude-opus-4-7');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-7[1m]'), 'claude-opus-4-7[1m]');
});

test('CM-005: migrateLegacyClaudeValue passes pinned Haiku/Sonnet IDs through unchanged', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6'), 'claude-opus-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-haiku-4-5'), 'claude-haiku-4-5');
    assert.equal(migrateLegacyClaudeValue('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
});

test('CM-007: migrateLegacyClaudeValue preserves unknown explicit values', () => {
    assert.equal(
        migrateLegacyClaudeValue('claude-sonnet-4-7-preview[1m]'),
        'claude-sonnet-4-7-preview[1m]',
    );
});

test('CM-008: migrateLegacyClaudeValue is idempotent on canonical alias values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.equal(migrateLegacyClaudeValue(m), m);
    }
});

// ─── Legacy map ──────────────────────────────────────

test('CM-009: legacy map contains only dot-form → hyphen-form migrations', () => {
    for (const [from, to] of Object.entries(CLAUDE_LEGACY_VALUE_MAP)) {
        assert.ok(from.includes('.'), `legacy key "${from}" should be a dot-form`);
        assert.ok(!to.includes('.'), `legacy target "${to}" should be hyphen-form`);
    }
    assert.equal(CLAUDE_LEGACY_VALUE_MAP['claude-opus-4.7'], 'claude-opus-4-7');
    assert.equal(CLAUDE_LEGACY_VALUE_MAP['claude-sonnet-4.6'], 'claude-sonnet-4-6');
    assert.equal(CLAUDE_LEGACY_VALUE_MAP['claude-haiku-4.5'], 'claude-haiku-4-5');
});

test('CM-009b: migrateLegacyClaudeValue upgrades dot-form to hyphen-form', () => {
    assert.equal(migrateLegacyClaudeValue('claude-opus-4.7'), 'claude-opus-4-7');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4.6'), 'claude-opus-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4.6'), 'claude-sonnet-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4.5'), 'claude-sonnet-4-5');
    assert.equal(migrateLegacyClaudeValue('claude-haiku-4.5'), 'claude-haiku-4-5');
});

// ─── Helpers ─────────────────────────────────────────

test('CM-011: getDefaultClaudeModel returns Opus 5.5 full ID', () => {
    assert.equal(getDefaultClaudeModel(), 'claude-opus-5-5');
});

test('CM-012: getDefaultClaudeChoices returns aliases + verified pinned full IDs', () => {
    const choices = getDefaultClaudeChoices();
    assert.deepEqual([...choices].sort(), [
        // claude-fable-5-1 added 2026-09-02 from opencodex ANTHROPIC_MODELS
        // (src/providers/registry.ts:341). No [1m] sibling: opencodex's 1M rows
        // cover only opus-4-6/4-7/4-8 and sonnet-4-6, so a [1m] variant here
        // would be an id nothing traces to.
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-fable-5[1m]',
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-opus-4-6[1m]',
        'claude-opus-4-7',
        'claude-opus-4-7[1m]',
        'claude-opus-4-8',
        'claude-opus-4-8[1m]',
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-opus-5-5[1m]',
        'claude-opus-5[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6[1m]',
        'claude-sonnet-5',
        'claude-sonnet-5[1m]',
        'haiku',
        'opus',
        'sonnet',
        'sonnet[1m]',
    ]);
});

test('CM-013: getClaudeModelKind classifies correctly', () => {
    assert.equal(getClaudeModelKind('sonnet'), 'canonical');
    assert.equal(getClaudeModelKind('opus'), 'canonical');
    assert.equal(getClaudeModelKind('claude-sonnet-4-6'), 'explicit');
    assert.equal(getClaudeModelKind('claude-opus-4-6[1m]'), 'explicit');
    assert.equal(getClaudeModelKind('claude-opus-4-7'), 'explicit');
    assert.equal(getClaudeModelKind('claude-sonnet-4-7-preview'), 'explicit');
    assert.equal(getClaudeModelKind('default'), 'explicit');
    assert.equal(getClaudeModelKind('claude-opus-4.7'), 'legacy');
    assert.equal(getClaudeModelKind('claude-sonnet-4.6'), 'legacy');
});
