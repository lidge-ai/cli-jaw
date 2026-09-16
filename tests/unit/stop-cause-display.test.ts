import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast } from '../../src/core/bus.ts';
import { classifyStopCause, readStopCause } from '../../src/agent/spawn/stop-cause.ts';

const NO_RESPONSE = 'tg.noResponse';
const STOPPED = 'tg.stopped';

const terminalPin = (requestId: string) => ({
    requestId,
    origin: 'slack',
    scope: 'default',
    sessionId: 'default',
});

async function settled<T>(pending: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`collector never settled: ${label}`)), 5_000);
    });
    try { return await Promise.race([pending, guard]); }
    finally { clearTimeout(timer); }
}

test('classifier: stall wins even when steer and kill are also set', () => {
    assert.equal(classifyStopCause({ stallReason: 'watchdog', wasSteer: true, wasKilled: true }), 'watchdog');
});

test('classifier: wasSteer is steer_kill', () => {
    assert.equal(classifyStopCause({ wasSteer: true, wasKilled: true }), 'steer_kill');
});

test('classifier: wasKilled only is user_stop', () => {
    assert.equal(classifyStopCause({ wasSteer: false, wasKilled: true }), 'user_stop');
});

test('classifier: none is undefined', () => {
    assert.equal(classifyStopCause({ wasSteer: false, wasKilled: false }), undefined);
});

test('classifier: exit 130 without a kill is unattributed', () => {
    assert.equal(classifyStopCause({ wasSteer: false, wasKilled: false, exitCode: 130 }), 'unattributed');
});

test('classifier: wasKilled wins over exit 130', () => {
    assert.equal(classifyStopCause({ wasSteer: false, wasKilled: true, exitCode: 130 }), 'user_stop');
});

test('readStopCause accepts the four literals and drops junk', () => {
    assert.equal(readStopCause('watchdog'), 'watchdog');
    assert.equal(readStopCause('user_stop'), 'user_stop');
    assert.equal(readStopCause('steer_kill'), 'steer_kill');
    assert.equal(readStopCause('unattributed'), 'unattributed');
    assert.equal(readStopCause('stopped'), undefined);
});

test.mock.module('../../src/orchestrator/pipeline.ts', {
    namedExports: {
        isContinueIntent: () => false,
        isResetIntent: () => false,
        orchestrateContinue: () => undefined,
        orchestrateReset: () => undefined,
        orchestrate: (_prompt: string, _meta: Record<string, unknown>) => undefined,
    },
});

test('locale keys follow the four causes and fall back', async () => {
    const { stoppedLocaleKey } = await import('../../src/orchestrator/collect.ts');
    assert.equal(stoppedLocaleKey('watchdog'), 'tg.stoppedWatchdog');
    assert.equal(stoppedLocaleKey('user_stop'), 'tg.stoppedUser');
    assert.equal(stoppedLocaleKey('steer_kill'), 'tg.stoppedSteer');
    assert.equal(stoppedLocaleKey('unattributed'), 'tg.stoppedUnattributed');
    assert.equal(stoppedLocaleKey(undefined), STOPPED);
});

test('collector: four causes pick four keys; missing stays tg.stopped; superseded is empty', async () => {
    const { orchestrateAndCollectData } = await import('../../src/orchestrator/collect.ts');
    const cases: Array<{ id: string; cause?: string; want: string; steer?: boolean }> = [
        { id: 'req-wd', cause: 'watchdog', want: 'tg.stoppedWatchdog' },
        { id: 'req-user', cause: 'user_stop', want: 'tg.stoppedUser' },
        { id: 'req-steer', cause: 'steer_kill', want: 'tg.stoppedSteer' },
        { id: 'req-unattr', cause: 'unattributed', want: 'tg.stoppedUnattributed' },
        { id: 'req-missing', want: STOPPED },
        { id: 'req-super', cause: 'watchdog', want: '', steer: true },
    ];
    for (const row of cases) {
        const pending = orchestrateAndCollectData('질문', {
            origin: 'slack', requestId: row.id, scope: 'default', chatSessionId: 'default',
        });
        if (row.steer) {
            broadcast('steer_started', { origin: 'slack', scope: 'default', sessionId: 'default', requestId: `${row.id}-next` });
        }
        broadcast('orchestrate_done', {
            ...terminalPin(row.id),
            text: '',
            runtimeFinality: 'absent',
            runtimeStatus: 'stopped',
            ...(row.cause ? { stopCause: row.cause } : {}),
        });
        const result = await settled(pending, row.id);
        assert.equal(result.text, row.want, row.id);
        assert.notEqual(result.text, NO_RESPONSE, row.id);
    }
});
