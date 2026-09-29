import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import {
    activateSlackToolGrant,
    reserveSlackToolGrant,
    revokeSlackToolScope,
    slackCredentialKey,
} from '../../src/slack/tool-context.ts';
import { mentionWatchTurnFailure } from '../../src/memory/heartbeat-mention-watch.ts';

const root = join(import.meta.dirname, '../..');
const heartbeat = fs.readFileSync(join(root, 'src/memory/heartbeat.ts'), 'utf8');
const mentionWatch = fs.readFileSync(join(root, 'src/memory/heartbeat-mention-watch.ts'), 'utf8');

const answerStart = heartbeat.indexOf('answer: async (hit) => {');
const sendStart = heartbeat.indexOf('send: async (hit, text) => {');
assert.ok(answerStart >= 0 && sendStart > answerStart);
const answer = heartbeat.slice(answerStart, sendStart);

test('mention-watch collect pins the hit target and remoteKey', () => {
    assert.match(answer, /remoteKey:\s*placement\.remoteKey/);
    assert.match(answer, /orchestrateAndCollectData\(prompt, \{[\s\S]*\btarget,/);
    assert.match(heartbeat, /target:\s*destinationBinding\.target/);
});

test('mention-watch reserve activates on placement scope and session, not the job keys', () => {
    assert.match(answer, /scope:\s*placement\.scope/);
    assert.match(answer, /chatSessionId:\s*placement\.chatSessionId/);
    assert.ok(!answer.includes('HEARTBEAT_SCOPE'));
    assert.ok(!answer.includes("chatSessionId: 'default'"));
    assert.match(heartbeat, /activateSlackToolGrant\(id, HEARTBEAT_SCOPE, 'default'\)/);
});

test('grant fail throws before collect so the tick cannot mark the hit seen', () => {
    const throwAt = answer.indexOf("throw new Error('slack_grant_unavailable')");
    const collectAt = answer.indexOf('orchestrateAndCollectData');
    assert.ok(throwAt >= 0 && collectAt > throwAt);
    assert.ok(!/if\s*\(\s*!release\s*\)\s*return\s+null/.test(answer));
    const catchBlock = mentionWatch.slice(
        mentionWatch.indexOf('} catch (error) {'),
        mentionWatch.indexOf('if (!text) {'),
    );
    assert.match(catchBlock, /result\.failed \+= 1/);
    assert.ok(!catchBlock.includes('recordSeenMention'));
    const quiet = mentionWatch.slice(
        mentionWatch.indexOf('if (!text) {'),
        mentionWatch.indexOf('const sent = await deps.send'),
    );
    assert.match(quiet, /recordSeenMention/);
});

test('a failed turn throws before the quiet check, so it is retried rather than retired', () => {
    const failAt = answer.indexOf('mentionWatchTurnFailure(collected.data)');
    const throwAt = answer.indexOf("throw new Error('mention_watch_turn_' + failure)");
    const quietAt = answer.indexOf('isHeartbeatQuietOutput');
    const textAt = answer.indexOf('applyOutputPolicy(String(collected.text)');
    assert.ok(failAt >= 0 && throwAt > failAt, 'failure check missing');
    assert.ok(textAt > throwAt && quietAt > throwAt, 'failure must be decided before text is read');
});

test('mentionWatchTurnFailure names every unfinished turn and passes a finished one', () => {
    assert.equal(mentionWatchTurnFailure({ runtimeStatus: 'done' }), null);
    assert.equal(mentionWatchTurnFailure({}), null);
    assert.equal(mentionWatchTurnFailure(undefined), null);
    assert.equal(mentionWatchTurnFailure({ runtimeStatus: 'error' }), 'runtime_error');
    assert.equal(mentionWatchTurnFailure({ runtimeStatus: 'stopped' }), 'stopped');
    assert.equal(mentionWatchTurnFailure({ executionInterrupted: true }), 'stopped');
    assert.equal(mentionWatchTurnFailure({ executionFailed: true }), 'execution_failed');
    assert.equal(mentionWatchTurnFailure({ collectionFailure: 'timeout' }), 'collection_timeout');
    assert.equal(mentionWatchTurnFailure({ collectionFailure: 'error' }), 'collection_error');
    assert.equal(mentionWatchTurnFailure({ superseded: true, runtimeStatus: 'done' }), 'superseded');
});

test('mention-watch activation keys cannot be satisfied by the job keys', () => {
    revokeSlackToolScope();
    const destination = {
        channel: 'slack' as const,
        targetKind: 'channel' as const,
        peerKind: 'channel' as const,
        targetId: 'CHIT0000001',
        threadId: '1710000000.000200',
    };
    const scope = 'mention-watch:slack:CHIT0000001:1710000000.000200';
    assert.equal(reserveSlackToolGrant({
        teamId: 'T1',
        actorId: 'U1',
        destination,
        credentialKey: slackCredentialKey('xoxb-mention-watch'),
        enforceDestination: true,
    }, { requestId: 'mw-hit', scope, chatSessionId: 'sess-hit' }), true);
    assert.equal(activateSlackToolGrant('mw-hit', 'default', 'default'), undefined);
    assert.ok(activateSlackToolGrant('mw-hit', scope, 'sess-hit'));
    revokeSlackToolScope();
});
