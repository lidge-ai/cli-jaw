import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetTranscriptViewMemoryForTests, readTranscriptView, writeTranscriptView } from '../../public/manager/src/code/transcript-view-memory';

test('endpoint/session views are isolated and bounded by LRU and choice caps', () => {
    __resetTranscriptViewMemoryForTests();
    writeTranscriptView('1:s', { open: new Map([['a', true]]) });
    writeTranscriptView('2:s', { open: new Map([['a', false]]) });
    assert.equal(readTranscriptView('1:s').open.get('a'), true);
    assert.equal(readTranscriptView('2:s').open.get('a'), false);
    const many = new Map(Array.from({ length: 65 }, (_, i) => [`row-${i}`, true] as const));
    writeTranscriptView('2:s', { open: many });
    assert.equal(readTranscriptView('2:s').open.size, 64);
    assert.equal(readTranscriptView('2:s').open.has('row-0'), false);
    for (let i = 0; i < 31; i++) writeTranscriptView(`other:${i}`, { open: new Map([['x', true]]) });
    assert.equal(readTranscriptView('1:s').open.size, 0);
    assert.equal(readTranscriptView('2:s').open.size, 64);
});
