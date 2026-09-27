import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeSessionInfo } from '../../src/code-mode/wire.ts';
import { codeSessionAttention, codeSessionAttentionLabel, codeSessionSection, codeSessionUnread, codeWorkspaceName,
    compareCodeSessions, comparePinnedCodeSessions, groupCodeSessions, groupCodeSessionsByActivity, groupCodeSessionsByWorkspace } from '../../public/manager/src/code/session-order.ts';

function session(patch: Partial<CodeSessionInfo> = {}): CodeSessionInfo {
    return {
        sessionId: 's-1', provider: 'codex-app', cwd: '/work', title: null, model: 'm', effort: null,
        permissionMode: 'ask', status: 'idle', turnId: null, archivedAt: null, error: null,
        resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false, efforts: [], permissionModes: ['ask'] },
        epoch: 1, sequence: 1, revision: 1, createdAt: 100, lastUsedAt: 100, lastTurnCompletedAt: null, lastVisitedAt: null,
        pinnedAt: null, markedUnread: false, ...patch,
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

test('unread means a finished turn after the last visit; never-visited and archived are not unread', () => {
    assert.equal(codeSessionUnread(session({ lastTurnCompletedAt: null, lastVisitedAt: null })), false);
    assert.equal(codeSessionUnread(session({ lastTurnCompletedAt: 10, lastVisitedAt: null })), false);
    assert.equal(codeSessionUnread(session({ lastTurnCompletedAt: 10, lastVisitedAt: 5 })), true);
    assert.equal(codeSessionUnread(session({ lastTurnCompletedAt: 10, lastVisitedAt: 10 })), false);
    assert.equal(codeSessionUnread(session({ lastTurnCompletedAt: 10, lastVisitedAt: 5, archivedAt: 20 })), false);
});

test('an explicit mark-unread reads unread even without a newer completion, except while archived', () => {
    assert.equal(codeSessionUnread(session({ markedUnread: true })), true);
    assert.equal(codeSessionUnread(session({ markedUnread: true, lastTurnCompletedAt: 10, lastVisitedAt: 99 })), true);
    assert.equal(codeSessionUnread(session({ markedUnread: true, archivedAt: 20 })), false);
});

test('pinned rows order by newest pin first and fall back to creation order', () => {
    const old = session({ sessionId: 'old', pinnedAt: 100, createdAt: 5 });
    const fresh = session({ sessionId: 'fresh', pinnedAt: 300, createdAt: 1 });
    const pinned = [old, fresh].sort(comparePinnedCodeSessions);
    assert.deepEqual(pinned.map(s => s.sessionId), ['fresh', 'old']);
});

test('projects view groups by workspace, newest first inside, placed by its newest session, ignoring activity', () => {
    const rows = [
        session({ sessionId: 'a1', cwd: '/a', createdAt: 100 }),
        session({ sessionId: 'b1', cwd: '/b', createdAt: 300, status: 'streaming', lastUsedAt: 9999 }),
        session({ sessionId: 'a2', cwd: '/a', createdAt: 200 }),
    ];
    assert.deepEqual(groupCodeSessionsByWorkspace(rows).map(g => [g.cwd, g.sessions.map(s => s.sessionId)]),
        [['/b', ['b1']], ['/a', ['a2', 'a1']]]);
});

test('activity view: Priority by completion, then Today / Yesterday / Earlier by last use at local midnight', () => {
    const now = new Date(2026, 8, 26, 10, 0, 0).getTime();
    const today = new Date(2026, 8, 26, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 25, 0, 0, 0).getTime();
    const rows = [
        session({ sessionId: 'p-old', lastUsedAt: today + 5, lastTurnCompletedAt: 50, lastVisitedAt: 10 }),
        session({ sessionId: 'p-new', lastUsedAt: 1, lastTurnCompletedAt: 90, lastVisitedAt: 10 }),
        session({ sessionId: 't', lastUsedAt: today }),
        session({ sessionId: 'y', lastUsedAt: yesterday }),
        session({ sessionId: 'e', lastUsedAt: yesterday - 1 }),
    ];
    assert.deepEqual(groupCodeSessionsByActivity(rows, now).map(g => [g.bucket, g.sessions.map(s => s.sessionId)]),
        [['priority', ['p-new', 'p-old']], ['today', ['t']], ['yesterday', ['y']], ['earlier', ['e']]]);
    assert.deepEqual(groupCodeSessionsByActivity([], now), [], 'empty buckets are omitted');
    assert.deepEqual(groupCodeSessionsByActivity(rows, now, 'p-new').map(g => [g.bucket, g.sessions.map(s => s.sessionId)])[0],
        ['priority', ['p-old']], 'the open session leaves Priority before its receipt lands');
});

test('workspace names are the last path segment', () => {
    assert.equal(codeWorkspaceName('/work/alpha/'), 'alpha');
    assert.equal(codeWorkspaceName('C:\\work\\beta'), 'beta');
    assert.equal(codeWorkspaceName('/'), '/');
});
