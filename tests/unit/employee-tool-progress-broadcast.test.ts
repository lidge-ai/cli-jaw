import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

test('employee tool events update worker progress without duplicate public rebroadcast', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'events', 'helpers.ts'), 'utf8');
    assert.match(src, /ctx\.parentLiveScope/);
    assert.match(src, /empTag\["isEmployee"\]\s*===\s*true/);
    assert.doesNotMatch(src, /broadcast\('agent_tool',\s*payload,\s*'public'\)/);
    assert.match(src, /updateWorkerTools\(agentLabel,\s*ctx\.toolLog\)/);
    assert.match(src, /sanitizeWorkerProgressTools\(newTools\)/);
    // The unsynced tail must be captured BEFORE replaceLiveRunTools splices the
    // capped sanitize back into ctx.toolLog, or the parent mirror freezes past
    // the entry cap (doc 86 §4 follow-up).
    const captureAt = src.indexOf('ctx.toolLog.slice(synced)');
    const spliceAt = src.indexOf('replaceLiveRunTools(scope, ctx.toolLog)');
    assert.ok(captureAt > -1 && spliceAt > -1 && captureAt < spliceAt,
        'parent tail capture must precede the live-run splice');
});

test('parent mirror keeps receiving employee tools past the entry cap (doc 86 §4)', async () => {
    const { syncLiveTools } = await import('../../src/agent/events/helpers.ts');
    const { beginLiveRun, getLiveRun, clearLiveRun } = await import('../../src/agent/live-run-state.ts');
    const { MAX_TOOL_LOG_ENTRIES } = await import('../../src/shared/tool-log-sanitize.ts');

    const childScope = 'emp:cap-regression';
    const parentScope = 'boss:cap-regression';
    beginLiveRun(childScope, 'claude');
    beginLiveRun(parentScope, 'claude');
    try {
        const ctx = {
            toolLog: [] as unknown[],
            liveScope: childScope,
            parentLiveScope: parentScope,
        } as never as Parameters<typeof syncLiveTools>[0];

        const total = MAX_TOOL_LOG_ENTRIES + 30;
        for (let i = 0; i < total; i++) {
            ctx.toolLog.push({ icon: '🔧', label: `tool-${i}`, toolType: 'tool', status: 'done' });
            syncLiveTools(ctx);
        }

        // Pre-fix: the after-splice slice went empty once the child log hit the
        // cap, so the parent never saw tool-160..tool-189.
        const labels = getLiveRun(parentScope).toolLog.map((t) => t.label);
        assert.ok(labels.includes(`tool-${total - 1}`), 'newest employee tool must reach the parent mirror');
        assert.ok(labels.includes(`tool-${MAX_TOOL_LOG_ENTRIES + 5}`), 'tools appended past the cap must reach the parent mirror');
    } finally {
        clearLiveRun(childScope);
        clearLiveRun(parentScope);
    }
});

test('spawn parent live-run employee appends use worker progress sanitizer', () => {
    const src = readSpawnAgentSource();
    assert.match(src, /sanitizeWorkerProgressTools/);
    assert.match(src, /function\s+appendParentLiveRunTool/);
    assert.doesNotMatch(src, /appendLiveRunTool\(ctx\.parentLiveScope,\s*\{\s*\.\.\.(?:tool|parsedTool|parsed\.tool)/);
    assert.match(src, /appendLiveRunTool\(ctx\.parentLiveScope,\s*\{\s*\.\.\.safeTool/);
    assert.match(src, /appendParentLiveRunTool\(ctx,\s*tool\)/);
    assert.match(src, /appendParentLiveRunTool\(ctx,\s*parsedTool\)/);
});
