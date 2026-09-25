import test from 'node:test';
import assert from 'node:assert/strict';
import { findSkillMentionMatch, listSkillMentionItems } from '../../src/cli/tui/skill-mention.ts';
import { findAtMentionMatch } from '../../src/cli/tui/file-mention.ts';
import {
    createComposerState, setComposerText, insertAtMention, flattenComposerForSubmit, getTrailingTextSegment,
} from '../../src/cli/tui/composer.ts';

const SKILLS = [
    { id: 'jaw-browser', description: 'Chrome browser control' },
    { id: 'jaw-search', description: 'Unified search hub' },
    { id: 'jaw-dev', description: 'Development workflow' },
];

test('findSkillMentionMatch detects a $ token under the cursor', () => {
    assert.deepEqual(findSkillMentionMatch('use $jaw-d', 10), { query: 'jaw-d', replaceStart: 4 });
    assert.deepEqual(findSkillMentionMatch('$', 1), { query: '', replaceStart: 0 });
});

test('findSkillMentionMatch ignores a $ glued to a word and a finished token', () => {
    assert.equal(findSkillMentionMatch('US$5', 4), null);
    assert.equal(findSkillMentionMatch('$jaw-dev ', 9), null);
});

test('@$ stays an @file token so the overlay keeps the file popup first', () => {
    // The overlay evaluates @ first; the $ grammar alone would also match here.
    assert.ok(findAtMentionMatch('@$jaw', 5));
    assert.ok(findSkillMentionMatch('@$jaw', 5));
});

test('listSkillMentionItems ranks by id prefix and inserts $<id>', () => {
    const items = listSkillMentionItems('jaw-b', SKILLS);
    assert.equal(items[0]?.name, 'jaw-browser');
    assert.equal(items[0]?.kind, 'skill-mention');
    assert.equal(items[0]?.insertText, '$jaw-browser');
    assert.equal(items[0]?.desc, 'Chrome browser control');
    assert.deepEqual(listSkillMentionItems('', SKILLS).map(item => item.name), ['jaw-browser', 'jaw-dev', 'jaw-search']);
    assert.deepEqual(listSkillMentionItems('zzz', SKILLS), []);
});

test('insertAtMention with the $ sigil replaces the typed token and keeps the tail', () => {
    const state = createComposerState();
    setComposerText(state, 'hi $jaw-b', 9);
    const match = findSkillMentionMatch(getTrailingTextSegment(state).text, state.cursor);
    assert.ok(match);
    insertAtMention(state, match!.replaceStart, 'jaw-browser', '$');
    assert.equal(flattenComposerForSubmit(state), 'hi $jaw-browser ');

    const middle = createComposerState();
    setComposerText(middle, 'open $jaw please', 9);
    const inner = findSkillMentionMatch(getTrailingTextSegment(middle).text, middle.cursor);
    insertAtMention(middle, inner!.replaceStart, 'jaw-browser', '$');
    assert.equal(flattenComposerForSubmit(middle), 'open $jaw-browser  please');
});

test('insertAtMention defaults to the @ sigil for file mentions', () => {
    const state = createComposerState();
    setComposerText(state, 'see @src/cl', 11);
    insertAtMention(state, 4, 'src/cli/chat.ts');
    assert.equal(flattenComposerForSubmit(state), 'see @src/cli/chat.ts ');
});
