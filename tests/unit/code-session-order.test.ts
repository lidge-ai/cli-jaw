import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeSessionInfo } from '../../src/code-mode/wire.ts';
import { codeSessionAttention, codeSessionAttentionLabel, codeSessionSection,
    compareCodeSessions, groupCodeSessions } from '../../public/manager/src/code/session-order.ts';

function session(patch: Partial<CodeSessionInfo> = {}): CodeSessionInfo {
    return {
        sessionId: 's-1', provider: 'codex-app', cwd: '/work', title: null, model: 'm', effort: null,
        permissionMode: 'ask', status: 'idle', turnId: null, archivedAt: null, error: null,
        resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false, efforts: [], permissionModes: ['ask'] },
        epoch: 1, sequence: 1, revision: 1, createdAt: 100, lastUsedAt: 100, lastTurnCompletedAt: null, lastVisitedAt: null, ...patch,
    };
}

test('order is anchored to creation, so activity cannot move a row under the cursor', () => {
    const older = session({ sessionId: 'a', createdAt: 100, lastUsedAt: 999 });
    const newer = session({ sessionId: 'b', createdAt: 200, lastUsedAt: 1 });
    // The server returns last_used_at DESC, which would put the busy session
    // first. Answering a prompt is not a reason for the list to rearrange.
    assert.deepEqual(groupCodeSessions([older, newer])[0]?.sessions.map(s => s.sessionId), ['b', 'a']);
    assert.ok(compareCodeSessions(newer, older) < 0);
});

test('equal creation times still produce one definite order', () => {
    const left = session({ sessionId: 'b', createdAt: 100 });
    const right = session({ sessionId: 'a', createdAt: 100 });
    assert.deepEqual(groupCodeSessions([left, right])[0]?.sessions.map(s => s.sessionId), ['a', 'b']);
});

test('archived sessions become a tail section ordered by when they were put away', () => {
    const live = session({ sessionId: 'live', createdAt: 1 });
    const early = session({ sessionId: 'early', createdAt: 500, archivedAt: 10 });
    const late = session({ sessionId: 'late', createdAt: 2, archivedAt: 900 });
    const groups = groupCodeSessions([early, live, late]);
    assert.deepEqual(groups.map(g => g.section), ['active', 'archived']);
    assert.deepEqual(groups[0]?.sessions.map(s => s.sessionId), ['live']);
    // "When did I put this away" is the question the tail answers, not "when
    // was it created" -- so a recently archived session comes first even though
    // it is older.
    assert.deepEqual(groups[1]?.sessions.map(s => s.sessionId), ['late', 'early']);
    assert.equal(codeSessionSection(live), 'active');
    assert.equal(codeSessionSection(late), 'archived');
});

test('an empty section is not rendered as an empty heading', () => {
    assert.deepEqual(groupCodeSessions([]).map(g => g.section), []);
    assert.deepEqual(groupCodeSessions([session()]).map(g => g.section), ['active']);
    assert.deepEqual(groupCodeSessions([session({ archivedAt: 1 })]).map(g => g.section), ['archived']);
});

test('an unhydrated approval count is unknown, not zero', () => {
    assert.deepEqual(codeSessionAttention(undefined), { kind: 'unknown' });
    assert.deepEqual(codeSessionAttention(0), { kind: 'none' });
    assert.deepEqual(codeSessionAttention(2), { kind: 'approvals', count: 2 });
    assert.equal(codeSessionAttentionLabel({ kind: 'unknown' }), 'Approval status unknown');
    assert.equal(codeSessionAttentionLabel({ kind: 'none' }), 'No pending approvals');
    assert.equal(codeSessionAttentionLabel({ kind: 'approvals', count: 1 }), '1 pending approval');
    assert.equal(codeSessionAttentionLabel({ kind: 'approvals', count: 3 }), '3 pending approvals');
});

