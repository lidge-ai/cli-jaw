import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushClaudeBuffers } from '../../src/agent/events.ts';
import { activeProcesses, isAgentBusy } from '../../src/agent/spawn.ts';
import { shouldBuildHistoryBlock } from '../../src/agent/prompt-context.ts';
import { clearAllBroadcastListeners } from '../../src/core/bus.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import type { SpawnContext } from '../../src/types/agent.ts';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (path: string): string => readFileSync(join(__dirname, '../..', path), 'utf8');

const spawnSrc = readSpawnAgentSource();
const lifecycleSrc = src('src/agent/lifecycle-handler.ts');
const flushSrc = src('src/agent/memory-flush-controller.ts');
const eventsSrc = src('src/agent/events.ts');
const eventsHelpersSrc = existsSync(join(__dirname, '../../src/agent/events/helpers.ts'))
    ? src('src/agent/events/helpers.ts')
    : '';
const persistenceSrc = src('src/agent/session-persistence.ts');

test('memory-flush spawn is not main-managed and uses isolated history/session policy', () => {
    assert.ok(
        spawnSrc.includes('const mainManaged = !forceNew && !opts.agentId && !empSid && !opts.internal'),
        'internal memory-flush must not own activeProcess/isAgentBusy main state',
    );
    assert.ok(flushSrc.includes('forceNew: true'), 'memory flush must not resume main provider session');
    assert.ok(flushSrc.includes('_skipHistory: true'), 'memory flush must not receive full history twice');
    assert.equal(shouldBuildHistoryBlock({
        skipHistory: true,
        isResume: false,
        cli: 'codex-app',
        codexMultiplexMain: true,
    }), false, 'standard history injection must honor _skipHistory');
    assert.ok(
        spawnSrc.includes('needsHistoryFallback && !opts._skipHistory ? buildHistoryBlock'),
        'ACP fallback history must honor _skipHistory',
    );
    assert.ok(
        persistenceSrc.includes('input.forceNew || input.employeeSessionId'),
        'forceNew sidecars must not persist as main provider sessions',
    );
});

test('internal memory-flush does not rely on timer queue drain', () => {
    assert.ok(!flushSrc.includes("await import('./spawn.js')"), 'flush controller must not import processQueue');
    assert.ok(!flushSrc.includes('setTimeout(async () =>'), 'flush controller must not timer-drain the queue');
});

test('internal status and tool broadcasts are guarded from public WebSocket clients', () => {
    assert.ok(
        spawnSrc.includes("if (!opts.internal) broadcast('agent_status', { status: 'running'"),
        'second-phase running status must be suppressed for internal runs',
    );
    assert.ok(
        lifecycleSrc.includes('if (!opts.internal') && lifecycleSrc.includes("broadcast('agent_status'"),
        'final done/error status must be suppressed for internal runs',
    );
    assert.equal(
        (spawnSrc.match(/broadcast\('agent_tool'/g) || []).length,
        0,
        'spawn.ts must route agent_tool through emitAgentTool, not direct broadcasts',
    );
    assert.ok(
        spawnSrc.includes('emitAgentTool(ctx, agentLabel, tool, empTag)'),
        'ACP tool broadcasts must go through the trace-stamped helper',
    );
    const emitSrc = eventsHelpersSrc || eventsSrc;
    assert.ok(
        emitSrc.includes('function emitAgentTool(')
            && emitSrc.includes("ctx.traceAudience === 'internal' ? 'internal' : 'public'"),
        'standard CLI events must route agent_tool through ctx.traceAudience',
    );
    assert.equal(
        (eventsSrc.match(/broadcast\('agent_tool'/g) || []).length,
        0,
        'events.ts must not contain direct public-default agent_tool broadcasts',
    );
});

test('internal sidecars do not inherit parent live-run tool ownership', () => {
    assert.ok(
        spawnSrc.includes("const parentLiveScopeForChild = !opts.internal && isEmployee ? liveScope : null"),
        'internal sidecars must not append tools into a public parent live run',
    );
    assert.equal(
        (spawnSrc.match(/parentLiveScope: isEmployee \? liveScope : null/g) || []).length,
        0,
        'legacy parentLiveScope employee inference must be removed',
    );
});

test('flushClaudeBuffers emits internal tool events without publishing to the public SSE event-bus', () => {
    // X-01: the public browser surface is the SSE event-bus (WS path removed).
    // Internal-audience events must never be published there.
    const published: unknown[] = [];
    const unsub = subscribe(e => { published.push(e); });
    clearAllBroadcastListeners();
    const ctx: SpawnContext = {
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
        traceAudience: 'internal',
        claudeThinkingBuf: 'background memory flush thought',
    };

    flushClaudeBuffers(ctx, 'memory-flush', { isEmployee: true });

    assert.equal(ctx.toolLog.length, 1, 'internal flush thinking still records toolLog internally');
    assert.equal(published.length, 0, 'internal flush tool event must not reach the public SSE event-bus');
    unsub();
    clearAllBroadcastListeners();
});

test('memory-flush can be active by id without making isAgentBusy true', () => {
    const fakeChild = { pid: 999999 } as any;
    activeProcesses.set('memory-flush', fakeChild);
    try {
        assert.equal(isAgentBusy('default'), false, 'active memory-flush sidecar must not block default-scope user messages');
    } finally {
        activeProcesses.delete('memory-flush');
    }
});
