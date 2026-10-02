import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAsideBaseline, inspectAsideInterval, parseAsideReplay } from '../../src/agent/aside-replay.ts';
import { prior, started, tool, completed, snapshot } from './fixtures/aside-runtime/transcript.ts';
const parse = (storage: unknown[], status = 'idle') => parseAsideReplay(snapshot(storage, status), 'owned-session');

test('stale final cannot cross baseline; latest desc uses storage order rather than timestamp', () => {
    const baseline = captureAsideBaseline(parse(prior));
    assert.throws(() => inspectAsideInterval(parse(prior), baseline), /ambiguous_turn/);
    assert.deepEqual(inspectAsideInterval(parse([...prior, ...completed()]), baseline).outcome, { status: 'done', finalText: 'new answer', partialText: '' });
});
test('empty and whitespace are exact finals; null and missing text are absent', () => {
    for (const text of ['', ' \n\t ', '한🙂']) assert.equal(inspectAsideInterval(parse(completed(text)), captureAsideBaseline()).outcome?.finalText, text);
    const missing = completed(); missing[2] = { role: 'assistant', content: null, stopReason: 'stop', completedAt: 220 } as unknown as typeof missing[2];
    assert.throws(() => inspectAsideInterval(parse(missing), captureAsideBaseline()), /incomplete_final/);
});
test('Stop has tools and no finished event; interrupted proof binds exact single start', () => {
    const replay = parse([...started, tool, { role: 'toolResult', content: [{ type: 'text', text: 'partial' }] }], 'interrupted');
    const interval = inspectAsideInterval(replay, captureAsideBaseline(), 'owned-turn');
    assert.deepEqual(interval, { turnId: 'owned-turn', outcome: null, interrupted: true });
    assert.throws(() => inspectAsideInterval(replay, captureAsideBaseline(), 'different-turn'), /ambiguous_turn/);
});
test('missing anchor, multiple intervals, trailing messages, overlap and duplicate terminal fail closed', () => {
    const base = captureAsideBaseline(parse(prior));
    assert.throws(() => inspectAsideInterval(parse(completed()), base), /baseline_missing/);
    for (const rows of [
        [...completed(), ...completed()], [...started, ...started],
        [...completed(), { role: 'user', content: 'foreign' }],
        [...completed(), completed().at(-1)],
        [completed()[2], ...completed()],
    ]) assert.throws(() => inspectAsideInterval(parse(rows), captureAsideBaseline()));
});
test('truncated fresh history or absent completedAt/stop reason cannot certify success', () => {
    const replay = parse([...Array.from({ length: 196 }, () => ({ role: 'system-message', content: '' })), ...completed()]);
    assert.throws(() => inspectAsideInterval(replay, captureAsideBaseline()), /replay_truncated/);
    for (const stopReason of ['length', 'error', 'toolUse']) {
        const rows = completed(); rows[2] = { ...rows[2], stopReason } as typeof rows[2];
        const select = () => inspectAsideInterval(parse(rows), captureAsideBaseline());
        if (stopReason === 'error') assert.equal(select().outcome?.status, 'error'); else assert.throws(select);
    }
    const noCompleted = completed(); noCompleted[2] = { role: 'assistant', content: [{ type: 'text', text: 'not completed' }], stopReason: 'stop' } as typeof noCompleted[2];
    assert.throws(() => inspectAsideInterval(parse(noCompleted), captureAsideBaseline()), /incomplete_final/);
    assert.throws(() => parseAsideReplay({ ...snapshot(completed()), truncated: true }, 'owned-session'));
    assert.throws(() => parseAsideReplay(snapshot(completed(), 'idle', 'foreign'), 'owned-session'));
});
test('malformed/error lifecycle and changing session status reject at boundary', () => {
    const changed = snapshot(completed()); changed.before.status = 'running';
    assert.throws(() => parseAsideReplay(changed, 'owned-session'));
    assert.throws(() => parse([{ role: 'turn-lifecycle', event: 'unknown', turnId: 't' }]));
    const error = inspectAsideInterval(parse([...started, { role: 'turn-lifecycle', event: 'error', turnId: 'owned-turn' }], 'error'), captureAsideBaseline());
    assert.equal(error.outcome?.status, 'error');
    assert.equal(inspectAsideInterval(parse([...started, { role: 'assistant', stopReason: 'error', content: 'failed' }], 'running'), captureAsideBaseline()).outcome, null);
    assert.throws(() => captureAsideBaseline(parse([...started, tool], 'running')), /resume_not_idle/);
});
