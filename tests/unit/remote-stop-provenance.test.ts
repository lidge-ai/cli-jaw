import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const kills: unknown[][] = [];

test.mock.module('../../src/core/session-context.ts', { namedExports: {
    currentSessionScope: () => ({ scope: 'remote-stop-scope', chatSessionId: 'remote-stop-chat' }),
} });

test.mock.module('../../src/agent/spawn.ts', { namedExports: {
    isAgentBusy: () => true,
    killActiveAgent: (...args: unknown[]) => { kills.push(args); return true; },
    getQueuedMessageSnapshotForScope: () => [],
    removeQueuedMessage: () => false,
} });

const { remoteStopHandler } = await import('../../src/cli/handlers/remote-session-commands.ts');

test('remote /stop captures explicit user-stop provenance without changing interrupt cleanup semantics', async () => {
    kills.length = 0;
    const result = await remoteStopHandler();
    assert.equal(result.ok, true);
    assert.deepEqual(kills, [['remote-stop-scope', 'explicit-user-stop']]);
});
