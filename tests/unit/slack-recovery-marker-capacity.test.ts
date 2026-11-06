import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveSlackToolGrant, revokeSlackToolGrant, revokeSlackToolScope,
    markSlackRecoveryBlocked, slackRecoveryBlocksRoot } from '../../src/slack/tool-context.ts';

const destination = { channel: 'slack' as const, targetKind: 'channel' as const,
    peerKind: 'channel' as const, targetId: 'C000TEST01' };

test('denial marker capacity never poisons unrelated results and recovers after retention', t => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    t.after(() => revokeSlackToolScope());
    const reserve = (id: string) => reserveSlackToolGrant({ teamId: 'T000TEST01', actorId: 'U000TEST01',
        credentialKey: 'fixture-key', destination }, { requestId: id, scope: 'marker-test', chatSessionId: 'fixture-chat' });
    for (let i = 0; i < 1100; i++) markSlackRecoveryBlocked(`unknown-${i}`, destination.targetId);
    assert.equal(slackRecoveryBlocksRoot('unrelated', destination), false);
    assert.equal(reserve('unrelated'), true);
    let admitted = 0;
    for (let i = 0; i < 1100; i++) {
        const id = `denied-${i}`;
        if (!reserve(id)) break;
        admitted++;
        markSlackRecoveryBlocked(id, destination.targetId);
        assert.equal(slackRecoveryBlocksRoot(id, destination), true);
        revokeSlackToolGrant(id);
    }
    assert.ok(admitted > 0 && admitted < 1100, 'new grants stop before denial storage can overflow');
    assert.equal(slackRecoveryBlocksRoot('unrelated', destination), false, 'an admitted unrelated answer stays deliverable');
    assert.equal(reserve('at-capacity'), false);
    now += 5 * 60 * 60_000;
    assert.equal(reserve('after-retention'), true, 'new admission resumes after expired markers are pruned');
    assert.equal(slackRecoveryBlocksRoot('after-retention', destination), false);
});
