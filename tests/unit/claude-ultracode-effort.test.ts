import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildResumeArgs, isClaudeUltracodeEffort, normalizeClaudeEffort } from '../../src/agent/args.ts';
import {
    buildClaudeEffortsByModel,
    claudeModelSupportsXhigh,
    CLAUDE_EFFORT_CHOICES,
    CLAUDE_WIRE_EFFORTS,
} from '../../src/cli/claude-models.ts';

function settingsOf(args: string[]): Record<string, unknown> | null {
    const index = args.indexOf('--settings');
    return index === -1 ? null : JSON.parse(args[index + 1]!) as Record<string, unknown>;
}

function effortOf(args: string[]): string | null {
    const index = args.indexOf('--effort');
    return index === -1 ? null : args[index + 1]!;
}

// ─── Normalization ───────────────────────────────────

test('UC-001: ultracode normalizes to the xhigh the flag actually accepts', () => {
    assert.equal(normalizeClaudeEffort('ultracode'), 'xhigh');
    assert.ok(isClaudeUltracodeEffort('ultracode'));
});

test('UC-002: every other effort passes through untouched', () => {
    for (const effort of CLAUDE_WIRE_EFFORTS) {
        assert.equal(normalizeClaudeEffort(effort), effort);
        assert.equal(isClaudeUltracodeEffort(effort), false);
    }
});

test('UC-003: an unknown value is not rewritten, so the CLI rejects it rather than us guessing', () => {
    assert.equal(normalizeClaudeEffort('turbo'), 'turbo');
    assert.equal(normalizeClaudeEffort(''), '');
    assert.equal(normalizeClaudeEffort(null), '');
});

// ─── Wire shape ──────────────────────────────────────

test('UC-004: claude sends xhigh on the flag and the switch in settings', () => {
    const args = buildArgs('claude', 'claude-opus-5', 'ultracode', 'p', '', 'auto');
    assert.equal(effortOf(args), 'xhigh');
    assert.deepEqual(settingsOf(args), { ultracode: true });
    // The literal must never reach the CLI: --effort only takes low..max.
    assert.equal(args.includes('ultracode'), false);
});

test('UC-005: fastMode and ultracode merge into one --settings object', () => {
    const args = buildArgs('claude', 'claude-opus-5', 'ultracode', 'p', '', 'auto', { fastMode: true });
    assert.deepEqual(settingsOf(args), { fastMode: true, ultracode: true });
    // A second --settings would replace the first rather than extend it.
    assert.equal(args.filter(a => a === '--settings').length, 1);
});

test('UC-006: fastMode alone keeps its existing payload', () => {
    const args = buildArgs('claude', 'claude-opus-5', 'high', 'p', '', 'auto', { fastMode: true });
    assert.deepEqual(settingsOf(args), { fastMode: true });
    assert.equal(effortOf(args), 'high');
});

test('UC-007: neither knob emits no --settings at all', () => {
    const args = buildArgs('claude', 'claude-opus-5', 'high', 'p', '', 'auto');
    assert.equal(settingsOf(args), null);
});

test('UC-008: medium stays implicit, as before', () => {
    const args = buildArgs('claude', 'claude-opus-5', 'medium', 'p', '', 'auto');
    assert.equal(effortOf(args), null);
});

// ─── Every Claude path ───────────────────────────────

const ULTRACODE_PATHS: Array<[string, string[]]> = [
    ['claude', buildArgs('claude', 'claude-opus-5', 'ultracode', 'p', '', 'auto')],
    ['claude resume', buildResumeArgs('claude', 'claude-opus-5', 'ultracode', 's1', 'p', 'auto')],
];

for (const [label, args] of ULTRACODE_PATHS) {
    test('UC-009 (' + label + '): splits ultracode into xhigh plus the settings flag', () => {
        assert.equal(effortOf(args), 'xhigh');
        assert.deepEqual(settingsOf(args), { ultracode: true });
    });
}

// ─── Ladder exposure ─────────────────────────────────

test('UC-010: ultracode is offered only where xhigh is supported', () => {
    assert.ok(claudeModelSupportsXhigh('claude-opus-5'));
    assert.ok(claudeModelSupportsXhigh('claude-opus-5-5'));
    assert.ok(claudeModelSupportsXhigh('claude-fable-5-1'));
    assert.ok(claudeModelSupportsXhigh('opus'));
    assert.equal(claudeModelSupportsXhigh('claude-haiku-4-5'), false);
    assert.equal(claudeModelSupportsXhigh('haiku'), false);
    assert.equal(claudeModelSupportsXhigh('claude-3-5-sonnet-20241022'), false);
});

test('UC-011: per-model efforts drop ultracode for models that cannot run it', () => {
    const byModel = buildClaudeEffortsByModel(['claude-opus-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    assert.deepEqual(byModel['claude-opus-5'], [...CLAUDE_EFFORT_CHOICES]);
    assert.deepEqual(byModel['claude-opus-5-5'], [...CLAUDE_EFFORT_CHOICES]);
    assert.deepEqual(byModel['claude-haiku-4-5'], [...CLAUDE_WIRE_EFFORTS]);
    assert.equal(byModel['claude-haiku-4-5']!.includes('ultracode'), false);
});

test('UC-012: the ladder extends the wire efforts rather than replacing them', () => {
    assert.deepEqual([...CLAUDE_EFFORT_CHOICES].slice(0, 5), [...CLAUDE_WIRE_EFFORTS]);
    assert.equal(CLAUDE_EFFORT_CHOICES[5], 'ultracode');
});
