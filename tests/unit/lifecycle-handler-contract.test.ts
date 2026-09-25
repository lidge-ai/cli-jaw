import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const lifecycleSrc = readFileSync(join(root, 'src/agent/lifecycle-handler.ts'), 'utf8');

test('lifecycle handler diagnoses incomplete structured fences before durable assistant insert', () => {
    assert.match(lifecycleSrc, /scanStructuredFence/);
    assert.match(lifecycleSrc, /assistant output contains incomplete structured fence before durable insert/);

    const scanIdx = lifecycleSrc.indexOf('scanStructuredFence(finalContent)');
    // The durable FINAL-answer insert. The steer salvage insert that precedes it
    // stores partial text, not a final answer, so the fence diagnostic does not apply.
    const insertIdx = lifecycleSrc.search(/insertMessageWithTraceRun\.run\(\s*'assistant', finalContent/);
    const broadcastIdx = lifecycleSrc.indexOf("broadcast('agent_done'", insertIdx);

    assert.ok(scanIdx >= 0, 'scanStructuredFence(finalContent) must exist');
    assert.ok(insertIdx >= 0, 'durable assistant insert must exist');
    assert.ok(broadcastIdx >= 0, 'agent_done broadcast must exist');
    assert.ok(scanIdx < insertIdx, 'structured fence diagnostic must run before durable insert');
    assert.ok(scanIdx < broadcastIdx, 'structured fence diagnostic must run before agent_done broadcast');
});

test('lifecycle handler does not unconditionally reset the agent pause gate before continuation', () => {
    assert.doesNotMatch(
        lifecycleSrc,
        /if\s*\(\s*!GOAL_PAUSE_RE\.test\(ctx\.fullText\s*\?\?\s*''\)\s*\)\s*{\s*resetAgentPauseCount\(\);\s*}/,
    );
    assert.match(lifecycleSrc, /pause_gate_pending/);
    assert.match(lifecycleSrc, /not scheduling another continuation/);
});
