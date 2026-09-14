// Messaging access-policy substrate. Privileged remote commands and optional
// mention-watch `authors` are the production callers; default-deny is unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessagingAccess } from '../../src/messaging/access-policy.ts';

const req = { actorId: 'U1', conversationKey: 'conv:1' };

test('default policy is deny', () => {
    assert.equal(evaluateMessagingAccess(req), 'deny');
    assert.equal(evaluateMessagingAccess(req, { mode: 'deny' }), 'deny');
});

test('allowlist hits and misses', () => {
    assert.equal(evaluateMessagingAccess(req, { mode: 'allowlist', allowlist: ['U1'] }), 'allow');
    assert.equal(evaluateMessagingAccess(req, { mode: 'allowlist', allowlist: ['U2'] }), 'deny');
    assert.equal(evaluateMessagingAccess(req, { mode: 'allowlist' }), 'deny');
});

test('paired requires exact actor and conversation', () => {
    assert.equal(evaluateMessagingAccess({
        ...req,
        pairedActorId: 'U1',
        pairedConversationKey: 'conv:1',
    }, { mode: 'paired' }), 'allow');
    assert.equal(evaluateMessagingAccess({
        ...req,
        pairedActorId: 'U2',
        pairedConversationKey: 'conv:1',
    }, { mode: 'paired' }), 'deny');
    assert.equal(evaluateMessagingAccess({
        ...req,
        pairedActorId: 'U1',
        pairedConversationKey: 'conv:other',
    }, { mode: 'paired' }), 'deny');
});

test('all allows; missing identity still denies', () => {
    assert.equal(evaluateMessagingAccess(req, { mode: 'all' }), 'allow');
    assert.equal(evaluateMessagingAccess({ actorId: '', conversationKey: 'conv:1' }, { mode: 'all' }), 'deny');
});
