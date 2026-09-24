import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    createNdjsonFramer,
    MAX_PENDING_LINE_CHARS,
    OVERFLOW_HEAD_SAMPLE_CHARS,
    type NdjsonPushResult,
} from '../../src/agent/spawn/line-buffer.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(projectRoot, p), 'utf8');

/** Feed a payload through the framer in fixed-size chunks, collecting results. */
function feedInChunks(framer: ReturnType<typeof createNdjsonFramer>, payload: string, chunkSize: number): NdjsonPushResult {
    const lines: string[] = [];
    const drops: NdjsonPushResult['drops'] = [];
    for (let i = 0; i < payload.length; i += chunkSize) {
        const r = framer.push(payload.slice(i, i + chunkSize));
        lines.push(...r.lines);
        drops.push(...r.drops);
    }
    return { lines, drops };
}

test('a pending line under the cap is returned untouched at EOF', () => {
    const framer = createNdjsonFramer();
    const line = 'x'.repeat(1024);

    const { lines, drops } = framer.push(line);
    assert.deepEqual(lines, []);
    assert.deepEqual(drops, []);
    assert.equal(framer.end().tail, line, 'normal traffic must not be altered');
});

test('a newline-free stream cannot grow the buffer without limit', () => {
    // Mirrors the reader loop: chunks arrive, no newline ever does.
    const framer = createNdjsonFramer();
    const chunk = 'x'.repeat(1024 * 1024);

    for (let i = 0; i < 64; i++) {
        const { lines, drops } = framer.push(chunk);
        assert.deepEqual(lines, []);
        assert.deepEqual(drops, [], 'no LF yet — the poisoned frame is still draining');
    }

    const { tail, drop } = framer.end();
    assert.equal(tail, '', 'the overflowed frame must not surface as a truncated tail');
    assert.ok(drop, 'the dropped frame must be reported, not silently kept');
    assert.equal(drop!.frameChars, 64 * 1024 * 1024);
    assert.ok(
        drop!.headSample.length <= OVERFLOW_HEAD_SAMPLE_CHARS,
        `head sample grew to ${drop!.headSample.length}, above the diagnostic bound`,
    );
});

test('frames at the cap boundary are accepted, frames over it are dropped', () => {
    const cap = 64;
    for (const len of [cap - 1, cap]) {
        const framer = createNdjsonFramer(cap);
        const payload = 'x'.repeat(len);
        const { lines, drops } = framer.push(payload + '\n');
        assert.deepEqual(lines, [payload], `length ${len} should dispatch`);
        assert.deepEqual(drops, []);
    }

    const framer = createNdjsonFramer(cap);
    const { lines, drops } = framer.push('x'.repeat(cap + 1) + '\n');
    assert.deepEqual(lines, [], 'length cap+1 must be dropped, not truncated');
    assert.equal(drops.length, 1);
    assert.equal(drops[0].frameChars, cap + 1);
});

test('the same payload gets the same verdict however it is chunked', () => {
    // #784: previously a payload over the cap arrived whole (+LF in one chunk)
    // was dispatched intact, while the same bytes split mid-frame were silently
    // truncated — chunk boundaries decided the message.
    const cap = 64;
    const over = `{"type":"message","text":"${'a'.repeat(cap)}"}`; // > cap
    assert.ok(over.length > cap);

    const whole = feedInChunks(createNdjsonFramer(cap), over + '\n', over.length + 1);
    const split = feedInChunks(createNdjsonFramer(cap), over + '\n', 7);
    for (const r of [whole, split]) {
        assert.deepEqual(r.lines, [], 'an over-cap frame must always be dropped');
        assert.equal(r.drops.length, 1);
        assert.equal(r.drops[0].frameChars, over.length);
    }

    const under = `{"type":"message","text":"${'a'.repeat(cap - 40)}"}`; // ≤ cap
    const wholeOk = feedInChunks(createNdjsonFramer(cap), under + '\n', under.length + 1);
    const splitOk = feedInChunks(createNdjsonFramer(cap), under + '\n', 7);
    assert.deepEqual(wholeOk.lines, [under]);
    assert.deepEqual(splitOk.lines, [under]);
});

test('a truncated head is never spliced with a later suffix into valid JSON', () => {
    // #784 repro: the over-cap prefix used to stay in the buffer, so the closing
    // `"\n}` of the next chunk re-formed a DIFFERENT parseable payload.
    const cap = 48;
    const frame = `{"type":"text","text":"${'a'.repeat(cap)}"}`;
    assert.ok(frame.length > cap);
    const cut = cap - 10; // split inside the string field, like the issue

    const framer = createNdjsonFramer(cap);
    const r1 = framer.push(frame.slice(0, cut));
    const r2 = framer.push(frame.slice(cut) + '\n');

    const delivered = [...r1.lines, ...r2.lines];
    assert.deepEqual(delivered, [], 'nothing from the poisoned frame may dispatch');
    assert.equal(r2.drops.length, 1);
    assert.equal(r2.drops[0].frameChars, frame.length);
});

test('a valid frame after an overflowed one dispatches uncontaminated', () => {
    const cap = 32;
    const framer = createNdjsonFramer(cap);
    const good = '{"ok":1}';

    // Same push: dropped frame and the following frame share a chunk.
    const mixed = framer.push('x'.repeat(cap + 5) + '\n' + good + '\n');
    assert.equal(mixed.drops.length, 1);
    assert.deepEqual(mixed.lines, [good]);

    // Separate push: stream resynced after the poisoned frame's LF.
    const framer2 = createNdjsonFramer(cap);
    framer2.push('y'.repeat(cap + 5));
    const drained = framer2.push('\n' + good + '\n');
    assert.equal(drained.drops.length, 1);
    assert.deepEqual(drained.lines, [good]);
});

test('EOF reports the drop instead of emitting a truncated frame', () => {
    const cap = 32;
    const framer = createNdjsonFramer(cap);
    framer.push('x'.repeat(cap + 10)); // over cap, no LF ever

    const { tail, drop } = framer.end();
    assert.equal(tail, '');
    assert.ok(drop);
    assert.equal(drop!.frameChars, cap + 10);
});

test('EOF dispatches a final frame that never saw a newline', () => {
    const framer = createNdjsonFramer(16);
    framer.push('{"tail":true}');
    const { tail, drop } = framer.end();
    assert.equal(drop, null);
    assert.equal(tail, '{"tail":true}');
});

test('the dropped-frame head sample never splits a surrogate pair (#372)', () => {
    // OVERFLOW_HEAD_SAMPLE_CHARS boundary lands on a high surrogate: the sample
    // must back off rather than emit a lone half-emoji.
    const boundary = OVERFLOW_HEAD_SAMPLE_CHARS - 1;
    const frame = 'x'.repeat(boundary) + '\u{1F600}' + 'y'.repeat(100) + '\n';

    const { drops } = createNdjsonFramer(8).push(frame);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].headSample.length, boundary, 'cut must back off the surrogate pair');
    assert.ok(!/[\uD800-\uDFFF]/.test(drops[0].headSample), 'lone surrogate in sample');
});

test('empty segments and blank lines pass through unchanged', () => {
    const framer = createNdjsonFramer(8);
    const { lines, drops } = framer.push('a\n\n\nbc\n');
    assert.deepEqual(lines, ['a', '', '', 'bc']);
    assert.deepEqual(drops, []);
});

test('every NDJSON reader routes stdout through the bounded framer', () => {
    // The head-keep-then-append splice was the #784 defect; both readers must
    // use the framer that drops the poisoned frame instead.
    for (const file of ['src/agent/spawn.ts', 'src/agent/pi-runtime.ts']) {
        const src = read(file);
        assert.match(src, /createNdjsonFramer\(/, `${file} does not use the bounded framer`);
        assert.doesNotMatch(src, /clampPendingLine/, `${file} still splices a truncated pending head`);
    }
});

test('MAX_PENDING_LINE_CHARS is the pending cap AND the frame cap', () => {
    // Documented contract: over the cap a frame is dropped wholesale even when
    // it arrives in a single write, so the verdict cannot depend on chunking.
    const framer = createNdjsonFramer();
    const { lines, drops } = framer.push('x'.repeat(MAX_PENDING_LINE_CHARS + 1) + '\n');
    assert.deepEqual(lines, []);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].frameChars, MAX_PENDING_LINE_CHARS + 1);
});
