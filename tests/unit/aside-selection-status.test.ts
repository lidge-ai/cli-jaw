import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCliStatus } from '../../src/cli/cli-status-worker.ts';
import { getCliReadiness } from '../../src/cli/readiness.ts';

test('Aside status never infers account authentication from binary presence or absence', async () => {
    for (const available of [true, false]) {
        const snapshot = await collectCliStatus({ detectAll: () => ({ aside: { available, path: available ? '/fixture/aside' : null } }) });
        assert.equal(snapshot['aside']?.authenticated, null);
        assert.equal(snapshot['aside']?.available, available);
        assert.equal(snapshot['aside']?.binaryInstalled, available);
        assert.equal(snapshot['aside']?.probeState, 'fresh');
        assert.match(snapshot['aside']?.source ?? '', /unverified/);
    }
});

test('Aside readiness reports unknown auth while existing authenticated engines stay ready', () => {
    for (const available of [true, false]) {
        const readiness = getCliReadiness({
            detectAllCli: () => ({ aside: { available, path: '/fixture/aside' }, pi: { available: true, path: '/fixture/pi' } }),
            readClaudeCreds: () => null, readCodexTokens: () => null, hasCopilotAuthSync: () => false,
            probeCodexAppCapability: () => ({ ok: true, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, reason: 'ready' }),
        });
        assert.equal(readiness.find(row => row.cli === 'aside')?.authenticated, null);
        assert.equal(readiness.find(row => row.cli === 'aside')?.installed, available);
        assert.equal(readiness.find(row => row.cli === 'pi')?.authenticated, true);
    }
});
