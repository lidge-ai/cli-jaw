import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';

const registry = await import('../../src/orchestrator/worker-registry.ts');
const outputStore = await import('../../src/orchestrator/worker-output-store.ts');

const {
    claimWorker,
    clearAllWorkers,
} = registry;
const {
    WORKER_RUNS_DIR,
    assertWorkerRunId,
    workerRunDir,
} = outputStore;

test.afterEach(() => {
    clearAllWorkers();
    rmSync(WORKER_RUNS_DIR, { recursive: true, force: true });
});

test('worker run id sanitizes virtual employee ids before durable store use', () => {
    const id = `virtual:security:${randomUUID()}`;
    const slot = claimWorker({ id, name: 'Security' }, 'audit worker run id');

    assert.equal(assertWorkerRunId(slot.runId), slot.runId);
    assert.equal(basename(workerRunDir(slot.runId)), slot.runId);
});

test('worker run id sanitizes static employee ids before durable store use', () => {
    const slot = claimWorker({ id: 'static:future-specialist', name: 'Future Specialist' }, 'audit worker run id');

    assert.equal(assertWorkerRunId(slot.runId), slot.runId);
    assert.equal(basename(workerRunDir(slot.runId)), slot.runId);
});

test('worker run id preserves plain uuid prefix format', () => {
    const id = randomUUID();
    const slot = claimWorker({ id, name: 'UUID Worker' }, 'audit worker run id');

    assert.ok(slot.runId.startsWith(`wr_${id}_`));
    assert.equal(assertWorkerRunId(slot.runId), slot.runId);
});

test('worker run id validator still rejects raw colon ids', () => {
    assert.throws(() => assertWorkerRunId('wr_virtual:x_y_z'), /invalid worker run id/);
});
