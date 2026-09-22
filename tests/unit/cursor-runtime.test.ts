import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CURSOR_MODEL_IDS, CURSOR_REGISTRY_MODELS, resolveCursorModelVariant, isCursorFullModelId } from '../../src/agent/cursor-runtime.ts';
import { buildArgs, buildResumeArgs } from '../../src/agent/args.ts';
import { shouldResumeBucketSession } from '../../src/agent/spawn/resume.ts';

test('Cursor effort resolves to model IDs instead of CLI flags', () => {
    assert.equal(resolveCursorModelVariant('auto', 'high'), 'auto');
    assert.equal(resolveCursorModelVariant('composer-2.5', 'medium-fast'), 'composer-2.5-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.5', 'medium-fast'), 'gpt-5.5-medium-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.5', 'xhigh'), 'gpt-5.5-extra-high');
    assert.equal(resolveCursorModelVariant('gpt-5.3-codex', 'medium-fast'), 'gpt-5.3-codex-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.3-codex', 'xhigh-fast'), 'gpt-5.3-codex-xhigh-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.2', 'medium-fast'), 'gpt-5.2-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.4-mini', 'high-fast'), 'gpt-5.4-mini-high');
    // Grok resolves through the account's prefixed ids (#394). Picking the base
    // `grok-4.5` used to yield `grok-4.5-fast`/`grok-4.5`, neither of which the
    // account exposes, so the CLI silently ran something else.
    assert.equal(resolveCursorModelVariant('grok-4.5', 'medium-fast'), 'cursor-grok-4.5-medium-fast');
    assert.equal(resolveCursorModelVariant('grok-4.5', 'medium'), 'cursor-grok-4.5-medium');
    // The reason the issue was filed: 4.6 was unreachable from the UI entirely.
    assert.equal(resolveCursorModelVariant('grok-4.6', 'high'), 'cursor-grok-4.6-high');
    assert.equal(resolveCursorModelVariant('grok-4.6', 'high-fast'), 'cursor-grok-4.6-high-fast');
    assert.equal(resolveCursorModelVariant('grok-4.6', 'xhigh'), 'cursor-grok-4.6-xhigh');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'high'), 'grok-4.7-high');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'xhigh-fast'), 'grok-4.7-xhigh-fast');
    // An id the account already spells out is passed through untouched.
    assert.equal(resolveCursorModelVariant('cursor-grok-4.6-high', 'low'), 'cursor-grok-4.6-high');
    assert.equal(resolveCursorModelVariant('claude-opus-4-7-thinking', 'high'), 'claude-opus-4-7-thinking-high');
    assert.equal(resolveCursorModelVariant('claude-opus-4-8-thinking', 'high'), 'claude-opus-4-8-thinking-high');
    assert.equal(resolveCursorModelVariant('claude-opus-4-8', 'max'), 'claude-opus-4-8-max');
    // claude-opus-5 must resolve like its opus siblings. xhigh stays verbatim
    // here (only gpt-5.5 maps xhigh -> extra-high, see cursorEffortSuffix).
    assert.equal(resolveCursorModelVariant('claude-opus-5', 'max'), 'claude-opus-5-max');
    assert.equal(resolveCursorModelVariant('claude-opus-5', 'xhigh'), 'claude-opus-5-xhigh');
    assert.equal(resolveCursorModelVariant('claude-opus-5', 'xhigh-fast'), 'claude-opus-5-xhigh-fast');
    assert.equal(resolveCursorModelVariant('claude-opus-5-5', 'max-fast'), 'claude-opus-5-5-max-fast');
});

test('Cursor families without a bare id step to the nearest exposed rung instead of sending the bare base', () => {
    // grok-4.7 exposes only -low..-xhigh (and -fast twins); a saved max effort
    // used to fall back to bare `grok-4.7`, which the account does not have.
    assert.equal(resolveCursorModelVariant('grok-4.7', 'high'), 'grok-4.7-high');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'max'), 'grok-4.7-xhigh');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'max-fast'), 'grok-4.7-xhigh-fast');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'none'), 'grok-4.7-low');
    assert.equal(resolveCursorModelVariant('grok-4.7', 'none-fast'), 'grok-4.7-low-fast');
    // A family whose bare id exists keeps the established fallback to it.
    assert.equal(resolveCursorModelVariant('grok-4.5', 'max'), 'grok-4.5');
    // grok-4.6 had the same gap (no bare id, no max rung): it now keeps the
    // #394 prefix and steps down instead of sending bare `grok-4.6`.
    assert.equal(resolveCursorModelVariant('grok-4.6', 'max'), 'cursor-grok-4.6-xhigh');
    assert.equal(resolveCursorModelVariant('grok-4.6', 'high'), 'cursor-grok-4.6-high');
});

test('Cursor full model IDs stay unchanged', () => {
    assert.equal(isCursorFullModelId('gpt-5.5-medium'), true);
    assert.equal(resolveCursorModelVariant('gpt-5.5-medium', 'high-fast'), 'gpt-5.5-medium');
    assert.equal(isCursorFullModelId('grok-4.5-fast'), false);
    assert.equal(resolveCursorModelVariant('grok-4.5-fast', 'high'), 'grok-4.5-fast');
    assert.equal(isCursorFullModelId('cursor-grok-4.6-high'), true);
});

test('Cursor model inventory mirrors observed cursor-agent list-models support', () => {
    // Checked against a live `cursor-agent models` run (2026-08-20): the account
    // listed 204 ids, 92 of which this registry had never heard of. The count is
    // kept as a regrowth guard, but the assertions below are what carry meaning.
    // 237 -> 240 on 2026-09-02: glm-5.3 low/high/max, traceable to opencodex
    // src/adapters/cursor/catalog.ts:184-188.
    assert.equal(CURSOR_MODEL_IDS.length, 258);
    assert.ok(CURSOR_MODEL_IDS.includes('glm-5.3-low'));
    assert.ok(CURSOR_MODEL_IDS.includes('glm-5.3-max'));
    assert.ok(CURSOR_MODEL_IDS.includes('composer-2.5-fast'));
    assert.ok(!CURSOR_MODEL_IDS.includes('grok-composer-2.5-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('gpt-5.5-extra-high-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('claude-opus-4-7-thinking-max-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('claude-opus-4-8-thinking-max-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('gemini-3.1-pro'));
    assert.ok(!CURSOR_MODEL_IDS.includes('grok-4.3'));
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-sonnet-5', 'glm-5.2', 'kimi-k2.7-code', 'gemini-3-pro']) assert.ok(CURSOR_MODEL_IDS.includes(model));
    // claude-opus-5 (opencodex src/adapters/cursor/{discovery,effort-map}.ts):
    // base entry plus the low..max ladder in both plain and -fast forms.
    assert.ok(CURSOR_REGISTRY_MODELS.includes('claude-opus-5'));
    assert.ok(CURSOR_REGISTRY_MODELS.includes('claude-opus-5-5'));
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        assert.ok(CURSOR_MODEL_IDS.includes(`claude-opus-5-${effort}`), `missing claude-opus-5-${effort}`);
        assert.ok(CURSOR_MODEL_IDS.includes(`claude-opus-5-${effort}-fast`), `missing claude-opus-5-${effort}-fast`);
    }
    // The live account DOES list opus-5 thinking variants, unlike the upstream
    // static seed this file was previously written against.
    assert.ok(CURSOR_MODEL_IDS.includes('claude-opus-5-thinking-high'));
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        assert.ok(CURSOR_MODEL_IDS.includes(`claude-opus-5-5-${effort}`));
        assert.ok(CURSOR_MODEL_IDS.includes(`claude-opus-5-5-${effort}-fast`));
    }
    // Legacy unprefixed Grok ids stay: a catalogue differs per plan, and removing
    // one would break an account that still exposes it.
    assert.ok(CURSOR_MODEL_IDS.includes('grok-4.5'));
    assert.ok(CURSOR_MODEL_IDS.includes('grok-4.5-fast'));
    // What the account actually exposes, and what #394 was about.
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
        assert.ok(CURSOR_MODEL_IDS.includes(`cursor-grok-4.6-${effort}`), `missing cursor-grok-4.6-${effort}`);
        assert.ok(CURSOR_MODEL_IDS.includes(`cursor-grok-4.6-${effort}-fast`), `missing cursor-grok-4.6-${effort}-fast`);
    }
    assert.ok(CURSOR_REGISTRY_MODELS.includes('grok-4.6'), 'the UI must be able to offer 4.6');
    assert.ok(CURSOR_REGISTRY_MODELS.includes('grok-4.7'));
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
        assert.ok(CURSOR_MODEL_IDS.includes(`grok-4.7-${effort}`));
        assert.ok(CURSOR_MODEL_IDS.includes(`grok-4.7-${effort}-fast`));
        assert.equal(CURSOR_MODEL_IDS.includes(`cursor-grok-4.7-${effort}`), false);
    }
    assert.equal(CURSOR_MODEL_IDS.includes('grok-4.7-max'), false);
    // Other families the hand-maintained list had fallen behind on.
    for (const model of ['gpt-5.6-sol-xhigh', 'gpt-5.6-terra-max', 'kimi-k3-high', 'gemini-3.7-flash-high', 'glm-5.2-max']) {
        assert.ok(CURSOR_MODEL_IDS.includes(model), `missing ${model}`);
    }
});

test('Cursor args use print mode, trust, stream-json, force only for auto permissions', () => {
    const args = buildArgs('cursor', 'gpt-5.5', 'medium-fast', 'hi', '', 'auto');
    assert.deepEqual(args, [
        '-p',
        '--trust',
        '--output-format', 'stream-json',
        '--model', 'gpt-5.5-medium-fast',
        '--force',
        'hi',
    ]);
    assert.equal(args.includes('--effort'), false);
    assert.equal(args.includes('--reasoning-effort'), false);
    assert.equal(args.includes('--thinking'), false);

    const safeArgs = buildArgs('cursor', 'gpt-5.5', 'medium-fast', 'hi', '', 'safe');
    assert.equal(safeArgs.includes('--force'), false);
});

test('Cursor resume args put --resume before print mode and preserve prompt positional shape', () => {
    const args = buildResumeArgs('cursor', 'gpt-5.5', 'high-fast', 'sid-1', 'resume hi', 'auto');
    assert.deepEqual(args, [
        '--resume', 'sid-1',
        '-p',
        '--trust',
        '--output-format', 'stream-json',
        '--model', 'gpt-5.5-high-fast',
        '--force',
        'resume hi',
    ]);
});

test('Cursor resume rejects cross-effort bucket reuse', () => {
    assert.equal(
        shouldResumeBucketSession('cursor', 'gpt-5.5-medium-fast', 'gpt-5.5-medium-fast'),
        true,
    );
    assert.equal(
        shouldResumeBucketSession('cursor', 'gpt-5.5-high-fast', 'gpt-5.5-medium-fast'),
        false,
    );
});

test('Cursor spawn plan computes runtimeModel before session boundaries', () => {
    const src = fs.readFileSync('src/agent/spawn.ts', 'utf8');
    assert.match(src, /const runtimeModel = cli === 'cursor'/);
    assert.match(src, /resolveScopedSessionBucket\(\s*cli, runtimeModel/);
    assert.match(src, /shouldResumeBucketSession\(\s*cli,\s*runtimeModel/);
    assert.match(src, /buildArgs\(cli, runtimeModel/);
    assert.match(src, /model: runtimeModel/);
});
