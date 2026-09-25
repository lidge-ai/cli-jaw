import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    appendAssistantTextSegment,
    formatAssistantTextSegment,
    formatPostToolAssistantLead,
    normalizeAssistantDisplayText,
    resolveSpawnOutputText,
} from '../../src/agent/events/helpers.ts';
import type { SpawnContext } from '../../src/types/agent.ts';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

function baseCtx(overrides: Partial<SpawnContext> = {}): SpawnContext {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        ...overrides,
    };
}

test('formatAssistantTextSegment prefixes later segments with newline bullet', () => {
    const ctx = baseCtx();
    assert.equal(formatAssistantTextSegment(ctx, 'first'), 'first');
    assert.equal(formatAssistantTextSegment(ctx, 'second'), '\n- second');
});

test('appendAssistantTextSegment writes to liveOutputText when present', () => {
    const ctx = baseCtx({ liveOutputText: '', fullText: 'raw stdout noise\n' });
    assert.equal(appendAssistantTextSegment(ctx, 'hello'), 'hello');
    assert.equal(appendAssistantTextSegment(ctx, 'world'), '\n- world');
    assert.equal(ctx.liveOutputText, 'hello\n- world');
    assert.equal(ctx.fullText, 'raw stdout noise\n');
});

test('normalizeAssistantDisplayText converts escaped newline sequences for display', () => {
    assert.equal(normalizeAssistantDisplayText('line 1\\nline 2'), 'line 1\nline 2');
    assert.equal(normalizeAssistantDisplayText('line 1\\r\\nline 2\\rline 3'), 'line 1\nline 2\nline 3');
});

test('appendAssistantTextSegment normalizes escaped newlines before formatting', () => {
    const ctx = baseCtx({ liveOutputText: '' });
    assert.equal(appendAssistantTextSegment(ctx, 'hello\\nworld'), 'hello\nworld');
    assert.equal(ctx.liveOutputText, 'hello\nworld');
});

test('first assistant text after tools uses bullet lead when stream is still empty', () => {
    assert.equal(formatPostToolAssistantLead('Done.'), '- Done.');
});

test('resolveSpawnOutputText prefers longest plain-text preview source', () => {
    const ctx = {
        fullText: 'raw tool noise',
        liveOutputText: '- Done with details',
        kiroDisplayedText: 'Done with details',
        toolLog: [],
        traceLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
    };
    assert.equal(resolveSpawnOutputText(ctx), '- Done with details');
});

test('resolveSpawnOutputText prefers normalized display text over longer raw escaped output', () => {
    const ctx = {
        fullText: 'first\\nsecond\\nthird',
        liveOutputText: 'first\nsecond\nthird',
        toolLog: [],
        traceLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
    };
    assert.equal(resolveSpawnOutputText(ctx), 'first\nsecond\nthird');
});

test('plain-text runtime display branches normalize escaped newlines before broadcast', () => {
    const spawnSrc = readSpawnAgentSource();
    assert.match(spawnSrc, /const segment = normalizeAssistantDisplayText\(event\.text\)/);
    assert.match(spawnSrc, /const displayDelta = normalizeAssistantDisplayText\(delta\)/);
    assert.match(spawnSrc, /const newText = normalizeAssistantDisplayText\(/);
    assert.match(spawnSrc, /const promptEchoStripped = stripAgyPromptEchoPrefix\(visibleFullText, promptForArgs\)\.text/);
    assert.match(spawnSrc, /const trackerStripped = stripInterviewTracker\(promptEchoStripped\)/);
    assert.match(spawnSrc, /const displayFullText = normalizeAssistantDisplayText\(trackerStripped\)/);
    assert.match(spawnSrc, /cli === 'agy' \|\| cli === 'pi'/);
});
