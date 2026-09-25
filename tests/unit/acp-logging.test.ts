import { readSource } from './source-normalize.js';
// ACP diagnostic logging — regression tests
// Validates that unhandled request logging and cancel detection are properly configured

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { readSpawnAgentSource, readSpawnFile } from '../helpers/spawn-source.mts';

const ACP_PATH = new URL('../../src/cli/acp-client.ts', import.meta.url).pathname;
const SPAWN_PATH = new URL('../../src/agent/spawn.ts', import.meta.url).pathname;
const acpSrc = readSource(ACP_PATH, 'utf8');
const spawnSrc = readSpawnAgentSource({ normalized: true });

// ─── acp-client.ts ───────────────────────────────────

test('unhandled agent requests are always logged (not DEBUG-only)', () => {
    // Should have console.warn for unhandled requests
    assert.match(acpSrc, /console\.warn\(.*acp:unhandled/,
        'unhandled agent requests must be logged with console.warn (always, not DEBUG-gated)');
    // Should NOT have DEBUG-gated logging for unsupported requests
    const defaultBlock = acpSrc.slice(acpSrc.indexOf('default:'));
    assert.ok(!defaultBlock.includes('process.env.DEBUG'),
        'unhandled request logging must not be gated behind DEBUG env variable');
});

test('session/cancelled notifications are logged', () => {
    assert.match(acpSrc, /session\/cancelled/,
        'acp-client must handle session/cancelled notifications');
    assert.match(acpSrc, /console\.warn\(.*acp:cancelled/,
        'session/cancelled must be logged with console.warn');
});

// ─── spawn.ts ────────────────────────────────────────

test('ACP unexpected exit is warned', () => {
    assert.match(spawnSrc, /acp:unexpected-exit/,
        'spawn.ts must log unexpected ACP exits (code≠0 && !killReason)');
});

test('unexpected exit check uses consumed killReason to detect truly unexpected exits', () => {
    // The ACP exit handler lives in the Copilot backend module.
    const copilotSrc = readSpawnFile('backend-copilot.ts', { normalized: true });
    const exitHandler = copilotSrc.slice(copilotSrc.indexOf("acp.on('exit'"));
    const consumeIdx = exitHandler.indexOf('consumeKillReason(');
    const unexpectedIdx = exitHandler.indexOf('acp:unexpected-exit');
    assert.ok(consumeIdx > 0, 'consumeKillReason should exist in exit handler');
    assert.ok(unexpectedIdx > 0, 'unexpected-exit warning should exist');
    assert.ok(consumeIdx < unexpectedIdx,
        'consumeKillReason must come before unexpected-exit check (only warns when no kill reason)');
});

// ─── stderr_activity event ───────────────────────────

test('ACP client emits stderr_activity event', () => {
    assert.match(acpSrc, /emit\(['"]stderr_activity['"]/,
        'acp-client must emit stderr_activity event from stderr handler');
});

test('stderr_activity preserves DEBUG logging', () => {
    const stderrBlock = acpSrc.slice(acpSrc.indexOf('stderr'));
    assert.match(stderrBlock, /process\.env\.DEBUG/,
        'stderr handler must preserve DEBUG-gated console.error');
});

test('spawn.ts accumulates stderrBuf from stderr_activity', () => {
    assert.match(spawnSrc, /stderr_activity/,
        'spawn.ts must listen for stderr_activity event');
    assert.match(spawnSrc, /stderrBuf/,
        'spawn.ts must accumulate stderr into ctx.stderrBuf');
});

test('heartbeat is gated via shouldEmitHeartbeat helper', () => {
    assert.match(spawnSrc, /shouldEmitHeartbeat/,
        'spawn.ts must use shouldEmitHeartbeat for conditional heartbeat');
});
