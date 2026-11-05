import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A reload keeps the queue. Saving heartbeat.json rebuilds the schedule through
 * startHeartbeat, which must retain a scheduled tick deferred behind a busy
 * main agent after its cron minute has passed.
 */

const collectUrl = new URL('../../src/orchestrator/collect.ts', import.meta.url).href;
const sendUrl = new URL('../../src/messaging/send.ts', import.meta.url).href;
const dbUrl = new URL('../../src/core/db.ts', import.meta.url).href;
const stateUrl = new URL('../../src/orchestrator/state-machine.ts', import.meta.url).href;
const spawnUrl = new URL('../../src/agent/spawn.ts', import.meta.url).href;
const registryUrl = new URL('../../src/orchestrator/worker-registry.ts', import.meta.url).href;

const [realSend, realDb, realState, realSpawn, realRegistry] = await Promise.all([
    import('../../src/messaging/send.js'),
    import('../../src/core/db.js'),
    import('../../src/orchestrator/state-machine.js'),
    import('../../src/agent/spawn.js'),
    import('../../src/orchestrator/worker-registry.js'),
]);

let pabcdState = 'IDLE';
let collectCalls = 0;
const prompts: string[] = [];

mock.module(collectUrl, { namedExports: {
    orchestrateAndCollectData: async (prompt: string) => {
        collectCalls += 1;
        prompts.push(prompt);
        return { text: 'status: ok\nsummary: tick complete', data: {} };
    },
    orchestrateAndCollect: async () => 'unused',
} });
mock.module(sendUrl, { namedExports: {
    ...realSend,
    sendChannelOutput: async () => ({ ok: true }),
} });
mock.module(dbUrl, { namedExports: {
    ...realDb,
    getEmployees: { all: () => [] },
    insertHeartbeatAnchor: { run: () => {} },
} });
mock.module(stateUrl, { namedExports: { ...realState, getState: () => pabcdState } });
mock.module(spawnUrl, { namedExports: { ...realSpawn, isAgentBusy: () => false, messageQueue: [] } });
mock.module(registryUrl, { namedExports: { ...realRegistry, hasPendingWorkerReplays: () => false } });

const { runHeartbeatJob, drainPending, startHeartbeat, stopHeartbeat, getHeartbeatRuntimeState, saveHeartbeatFile } =
    await import('../../src/memory/heartbeat.js');

const destination = { channel: 'telegram' as const, targetId: '1' };
const job = (overrides: Record<string, unknown> = {}) => ({
    id: 'hb-a', name: 'a', enabled: true, runner: 'main', reportPolicy: 'silent', destination,
    schedule: { kind: 'every', minutes: 60 }, prompt: 'old prompt', ...overrides,
});

/** Arms the schedule from `jobs`, then defers one tick of `queued` behind PABCD. */
async function queueOneTick(queued: ReturnType<typeof job>, jobs = [queued]) {
    pabcdState = 'IDLE';
    collectCalls = 0;
    prompts.length = 0;
    stopHeartbeat();
    saveHeartbeatFile({ jobs });
    startHeartbeat();
    pabcdState = 'P';
    await runHeartbeatJob(queued);
    assert.equal(getHeartbeatRuntimeState().pending, 1, 'the tick must be queued');
}

test('HB-RELOAD-001: a reload keeps a queued tick and runs it from the new file', async () => {
    await queueOneTick(job());
    saveHeartbeatFile({ jobs: [job({ prompt: 'new prompt' })] });
    startHeartbeat();
    assert.equal(getHeartbeatRuntimeState().pending, 1, 'the reload must not drop the tick');
    assert.equal(collectCalls, 0, 'still deferred while PABCD is active');

    pabcdState = 'IDLE';
    await drainPending();
    assert.equal(collectCalls, 1, 'the owed tick runs exactly once');
    assert.match(prompts[0] ?? '', /new prompt/);
    assert.doesNotMatch(prompts[0] ?? '', /old prompt/);
    assert.equal(getHeartbeatRuntimeState().pending, 0);
});

test('HB-RELOAD-002: a job removed or disabled by the save loses its queued tick', async () => {
    await queueOneTick(job());
    saveHeartbeatFile({ jobs: [] });
    startHeartbeat();
    assert.equal(getHeartbeatRuntimeState().pending, 0, 'removed');

    await queueOneTick(job());
    saveHeartbeatFile({ jobs: [job({ enabled: false })] });
    startHeartbeat();
    assert.equal(getHeartbeatRuntimeState().pending, 0, 'disabled');
});

test('HB-RELOAD-003: reloading twice does not double the tick', async () => {
    await queueOneTick(job());
    startHeartbeat();
    startHeartbeat();
    assert.equal(getHeartbeatRuntimeState().pending, 1);
    pabcdState = 'IDLE';
    await drainPending();
    assert.equal(collectCalls, 1);
});

test('HB-RELOAD-004: a reload with the path clear runs the owed tick without another caller', async () => {
    await queueOneTick(job());
    pabcdState = 'IDLE';
    startHeartbeat();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(collectCalls, 1);
    assert.equal(getHeartbeatRuntimeState().pending, 0);
});

test('HB-RELOAD-005: a real stop still drops the queue', async () => {
    await queueOneTick(job());
    stopHeartbeat();
    assert.equal(getHeartbeatRuntimeState().pending, 0);
    stopHeartbeat();
});
