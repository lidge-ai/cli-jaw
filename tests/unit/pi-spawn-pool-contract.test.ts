import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activeMainProcesses, killActiveAgent, settleExit } from '../../src/agent/spawn.ts';

test('Pi spawn keeps employees per-turn and sends boss turns through the pool lease', async () => {
    const source = await readFile(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    const branch = source.slice(source.indexOf("if (cli === 'pi')"), source.indexOf("if (cli === 'codex-app')"));
    const employee = branch.indexOf('if (opts.agentId)');
    const employeeOpen = branch.indexOf('openPiRpc(', employee);
    const pooledAcquire = branch.indexOf('acquirePiRuntime({', employee);
    assert.ok(employee > 0 && employeeOpen > employee && pooledAcquire > employeeOpen);
    assert.match(branch, /PiRuntimeSession/);
    assert.match(branch, /bindPiExecutionCancel/);
    assert.equal(branch.includes('lease.session.sendPrompt'), false);
    assert.equal(branch.includes('spawnPiRpc('), false);
    // The kill path used to log a per-CLI literal (`cli=pi action=lease.cancel`).
    // Commit 211531d6 scoped main execution state and merged codex-app/pi into one
    // branch that interpolates the active CLI, so assert the surviving contract:
    // a pi turn registers a cancel hook, and the shared kill path routes pi
    // through it as a lease cancel.
    assert.match(branch, /mainRun\.cancelTurn\s*=\s*cancelHook/);
    // Exercise the shared dispatcher: spelling the Pi allowlist as equality or
    // includes() is immaterial; the captured Pi lease must receive the stop.
    const scope = 'pi-pool-contract';
    const foreignScope = 'pi-pool-contract-other';
    const reasons: string[] = [];
    const foreign = { process: null, starting: false, steering: false, ownerGeneration: 0,
        meta: { origin: 'web', cli: 'pi' }, cancelTurn: () => assert.fail('cancelled another Pi lease') };
    activeMainProcesses.set(foreignScope, foreign);
    activeMainProcesses.set(scope, { ...foreign, cancelTurn: reason => { reasons.push(reason); } });
    try {
        assert.equal(killActiveAgent(scope, 'steer'), true);
        assert.deepEqual(reasons, ['steer']);
        assert.equal(activeMainProcesses.has(scope), false);
        assert.equal(activeMainProcesses.get(foreignScope), foreign);
        assert.equal(killActiveAgent(scope, 'steer'), false, 'removed owner cannot be cancelled twice');
        assert.deepEqual(reasons, ['steer']);
    } finally {
        settleExit(scope);
        activeMainProcesses.delete(scope);
        activeMainProcesses.delete(foreignScope);
    }
    assert.match(source, /action=lease\.cancel/);
});
