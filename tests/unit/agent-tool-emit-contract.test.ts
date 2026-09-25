// WP4b: every agent_tool SSE emit goes through the
// trace-stamped helper path (or explicitly carries startedAt), so the payload
// always has the authoritative run start and — where a trace run exists —
// traceRunId/traceSeq. Source-contract pattern per tool-log-memory-boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

function src(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

test('spawn.ts has zero direct agent_tool broadcasts — all route through emitAgentTool', () => {
    const spawn = readSpawnAgentSource();
    assert.equal(spawn.includes("broadcast('agent_tool'"), false,
        'direct agent_tool broadcast in spawn.ts bypasses startedAt/updateWorkerTools');
    assert.ok(spawn.includes('emitAgentTool(ctx, agentLabel,'), 'helper path must be in use');
});

test('emitAgentTool stamps the payload with the run start', () => {
    const helpers = src('src/agent/events/helpers.ts');
    assert.ok(helpers.includes('startedAt: ctx.runStartedAt'));
});

test('every spawn context literal seeds runStartedAt', () => {
    const spawn = readSpawnAgentSource();
    const literals = spawn.match(/const ctx: (?:Copilot)?SpawnContext = \{/g) || [];
    const seeds = spawn.match(/runStartedAt: Date\.now\(\),/g) || [];
    assert.ok(literals.length >= 4, `expected >=4 spawn ctx literals, saw ${literals.length}`);
    assert.equal(seeds.length, literals.length,
        'every SpawnContext literal must seed runStartedAt for the elapsed-timer origin');
});

test('web UI step startTime prefers the server startedAt over client arrival time', () => {
    const ws = src('public/js/ws.ts');
    assert.ok(ws.includes("startTime: typeof msg.startedAt === 'number' && msg.startedAt > 0 ? msg.startedAt : Date.now()"));
});
