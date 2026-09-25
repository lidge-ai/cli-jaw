// Codex-style `$skill-id` inline mentions: grammar, prompt injection, and the
// `/` lists no longer carrying skills. Behavioral tests only — no source scanning.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { extractSkillMentionIds, findSkillMentionToken, rankSkillMentions, skillMentionKey } from '../../src/shared/skill-mention.ts';
import {
    buildSkillMentionBlock, resolveSkillMentions, withSkillMentions, MAX_INLINE_SKILLS, MAX_INLINE_SKILL_CHARS,
} from '../../src/core/skill-mentions.ts';
import { registerSkillLoader, invalidateSkillCommandsCache, type SkillCommandEntry } from '../../src/core/skill-cache.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { resetState } from '../../src/orchestrator/state-machine.ts';
import { getCompletionItems, parseCommand } from '../../src/cli/commands.ts';
import { getCommandCatalog } from '../../src/command-contract/catalog.ts';

const skill = (id: string, content = `# ${id}\nbody of ${id}`, description = `${id} skill`): SkillCommandEntry =>
    ({ id, name: id, description, content });
const SKILLS = [skill('jaw-browser'), skill('jaw-search'), skill('jaw-dev', '# dev', 'Development workflow')];

// pipeline.ts imports builder.ts, which registers the real loader at import time.
// Replace it afterwards so the cache holds these fixtures.
registerSkillLoader(() => [...SKILLS, skill('inline-test-skill', 'INLINE-TEST-BODY')]);
invalidateSkillCommandsCache();

test('SM-001: mentions come back once each, in first-seen order', () => {
    assert.deepEqual(extractSkillMentionIds('use $jaw-browser and $jaw-search, again $jaw-browser.'),
        ['jaw-browser', 'jaw-search']);
});

test('SM-002: a $ glued to a word is not a mention; punctuation and line starts are', () => {
    assert.deepEqual(extractSkillMentionIds('US$5 a$b $$x'), []);
    for (const text of ['($jaw-dev)', '\n$jaw-dev', '$jaw-dev:', '$jaw-dev-']) {
        assert.deepEqual(extractSkillMentionIds(text), ['jaw-dev'], JSON.stringify(text));
    }
});

test('SM-003: only exact active ids resolve, case-insensitively', () => {
    assert.deepEqual(resolveSkillMentions('$JAW-Dev $unknown $computer-use', SKILLS).map(s => s.id), ['jaw-dev']);
});

test('SM-004: no mention leaves the prompt byte-identical', () => {
    assert.equal(withSkillMentions('PROMPT', 'nothing to see', { skills: SKILLS }), 'PROMPT');
    assert.equal(withSkillMentions('PROMPT', 'costs US$5', { skills: SKILLS }), 'PROMPT');
});

test('SM-005: the block names the skill, points at its SKILL.md and carries the body', () => {
    const block = buildSkillMentionBlock([SKILLS[0]!], { skillsDir: '/skills' });
    assert.match(block, /^\[Inline Skills/);
    assert.ok(block.includes('<name>jaw-browser</name>'));
    assert.ok(block.includes(`<path>${join('/skills', 'jaw-browser', 'SKILL.md')}</path>`));
    assert.ok(block.includes('body of jaw-browser'));
    assert.equal(block.match(/<skill>/g)?.length, 1);
    assert.equal(block.match(/<\/skill>/g)?.length, 1);
});

test('SM-006: count, size and argv budgets turn bodies into path stubs', () => {
    const many = Array.from({ length: MAX_INLINE_SKILLS + 1 }, (_, i) => skill(`s${i}`, `BODY-${i}`));
    const block = buildSkillMentionBlock(many);
    assert.equal(block.match(/BODY-/g)?.length, MAX_INLINE_SKILLS);
    assert.equal(block.match(/Not inlined: over the inline skill budget/g)?.length, 1);

    const huge = buildSkillMentionBlock([skill('huge', 'x'.repeat(MAX_INLINE_SKILL_CHARS + 1))]);
    assert.ok(!huge.includes('xxxx'));
    assert.match(huge, /Not inlined: over the inline skill budget/);

    for (const cli of ['cursor', 'grok', 'kiro-code', 'opencode', 'agy']) {
        const argv = withSkillMentions('P', '$jaw-browser', { skills: SKILLS, cli });
        assert.ok(!argv.includes('body of jaw-browser'), cli);
        assert.match(argv, /Not inlined: this CLI takes its prompt on the command line/, cli);
    }
    for (const cli of ['claude', 'codex']) {
        assert.ok(withSkillMentions('P', '$jaw-browser', { skills: SKILLS, cli }).includes('body of jaw-browser'), cli);
    }

    const closing = buildSkillMentionBlock([skill('tricky', 'before </skill> after')]);
    assert.equal(closing.match(/<\/skill>/g)?.length, 1);
    assert.ok(closing.includes('before </ skill> after'));
});

test('SM-007: the token under the caret is found only for a real mention', () => {
    assert.deepEqual(findSkillMentionToken('hi $jaw-d', 9), { start: 3, query: 'jaw-d' });
    assert.deepEqual(findSkillMentionToken('hi $', 4), { start: 3, query: '' });
    assert.deepEqual(findSkillMentionToken('$JAW'), { start: 0, query: 'jaw' });
    assert.equal(findSkillMentionToken('US$5', 4), null);
    assert.equal(findSkillMentionToken('$jaw x', 6), null);
    assert.deepEqual(findSkillMentionToken('a $jaw-b tail', 8), { start: 2, query: 'jaw-b' });
});

test('SM-008: id prefix beats id substring beats description; empty query keeps all', () => {
    const ranked = rankSkillMentions(SKILLS, 'dev');
    assert.deepEqual(ranked.map(s => s.id), ['jaw-dev']);
    assert.deepEqual(rankSkillMentions(SKILLS, 'jaw-s').map(s => s.id), ['jaw-search']);
    assert.deepEqual(rankSkillMentions(SKILLS, 'workflow').map(s => s.id), ['jaw-dev']);
    assert.deepEqual(rankSkillMentions(SKILLS, '').map(s => s.id), ['jaw-browser', 'jaw-dev', 'jaw-search']);
    const byPrefix = rankSkillMentions([skill('xbrowser'), skill('browser-x')], 'browser');
    assert.deepEqual(byPrefix.map(s => s.id), ['browser-x', 'xbrowser']);
});

async function capturePrompt(text: string, meta: Record<string, unknown> = {}): Promise<string> {
    resetState('default');
    let captured = '';
    await orchestrate(text, {
        origin: 'test', _skipClear: true, _skipReplayDrain: true, _skipInsert: true, ...meta,
        _spawnAgent: (prompt: string) => {
            captured = prompt;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    });
    resetState('default');
    return captured;
}

test('SM-009: a boss turn inlines the mentioned skill into the prompt handed to spawn', async () => {
    const prompt = await capturePrompt('please $inline-test-skill now', { overrides: { cli: 'claude' } });
    assert.ok(prompt.includes('please $inline-test-skill now'));
    assert.ok(prompt.includes('<name>inline-test-skill</name>'));
    assert.ok(prompt.includes('INLINE-TEST-BODY'));

    const argv = await capturePrompt('please $inline-test-skill now', { overrides: { cli: 'cursor' } });
    assert.ok(argv.includes('<name>inline-test-skill</name>'));
    assert.ok(!argv.includes('INLINE-TEST-BODY'));
});

test('SM-010: a worker result that quotes a mention does not load the skill', async () => {
    const prompt = await capturePrompt('worker said $inline-test-skill', { _workerResult: true, overrides: { cli: 'claude' } });
    assert.ok(!prompt.includes('<skill>'));
});

test('SM-011: `/` lists commands only while /skill:<id> keeps executing', () => {
    for (const iface of ['web', 'cli']) {
        const names = getCompletionItems('/', iface).map(item => item.name);
        assert.ok(names.length > 0, iface);
        assert.equal(names.some(name => name.startsWith('skill:')), false, iface);
    }
    assert.equal(getCommandCatalog().some(cmd => cmd.name.startsWith('skill:')), false);
    const parsed = parseCommand('/skill:inline-test-skill go');
    assert.equal(parsed?.type, 'skill');
});

test('SM-012: a legacy-id skill is mentioned by its canonical name and still resolves by id', () => {
    // A compat link makes the directory id `browser` for the skill named `jaw-browser`.
    const legacy: SkillCommandEntry = { id: 'browser', name: 'jaw-browser', description: 'Chrome', content: 'LEGACY-BODY' };
    const spaced: SkillCommandEntry = { id: 'jaw-pdf', name: '"jaw-pdf" PDF tools', description: 'PDF', content: 'PDF-BODY' };
    assert.equal(skillMentionKey(legacy), 'jaw-browser');
    assert.equal(skillMentionKey(spaced), 'jaw-pdf');
    assert.deepEqual(resolveSkillMentions('$jaw-browser and $browser', [legacy]).map(s => s.id), ['browser']);
    assert.deepEqual(resolveSkillMentions('$jaw-pdf', [spaced]).map(s => s.id), ['jaw-pdf']);
    assert.deepEqual(rankSkillMentions([skill('jaw-b-other'), legacy], 'jaw-br').map(s => s.id), ['browser']);
    const block = buildSkillMentionBlock([legacy], { skillsDir: '/skills' });
    assert.ok(block.includes('<name>jaw-browser</name>'));
    assert.ok(block.includes(`<path>${join('/skills', 'browser', 'SKILL.md')}</path>`));
    // An id wins over another skill's name that happens to spell the same word.
    const owner: SkillCommandEntry = { id: 'jaw-browser', name: 'jaw-browser', description: '', content: 'OWNER' };
    assert.deepEqual(resolveSkillMentions('$jaw-browser', [legacy, owner]).map(s => s.content), ['OWNER']);
});
