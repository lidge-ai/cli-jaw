// Slack event tap: compact JSONL copy of message/reaction events for watchers
// that would otherwise poll history/replies/reactions.get (Tier 3 budget).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slackEventTapLine, tapSlackEvent } from '../../src/slack/event-tap.ts';

test('thread reply keeps channel, ts, thread_ts, user, text and files', () => {
    const line = slackEventTapLine({
        type: 'message', channel: 'D1', channel_type: 'im', ts: '2.0', thread_ts: '1.0', user: 'U1',
        text: 'hi', files: [{ id: 'F1', name: 'a.png', url_private: 'https://files.slack.com/x', thumb_64: 'drop' }],
    }, 5);
    assert.equal(line?.['channel'], 'D1');
    assert.equal(line?.['thread_ts'], '1.0');
    assert.equal(line?.['received_at'], 5);
    assert.deepEqual((line?.['files'] as Array<Record<string, unknown>>)[0]?.['name'], 'a.png');
    assert.equal('thumb_64' in ((line?.['files'] as Array<Record<string, unknown>>)[0] || {}), false);
});

test('reaction events are keyed by item channel/ts', () => {
    const line = slackEventTapLine({ type: 'reaction_added', user: 'U1', reaction: 'one',
        item: { type: 'message', channel: 'C1', ts: '9.9' }, event_ts: '10.0' });
    assert.equal(line?.['channel'], 'C1');
    assert.deepEqual(line?.['item'], { type: 'message', channel: 'C1', ts: '9.9' });
});

test('other event types and channel-less events are not tapped', () => {
    assert.equal(slackEventTapLine({ type: 'app_mention', channel: 'C1', ts: '1.0' }), null);
    assert.equal(slackEventTapLine({ type: 'message', ts: '1.0' }), null);
    assert.equal(slackEventTapLine({ type: 'reaction_added', item: {} }), null);
});

test('tap writes only when its directory exists and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tap-'));
    tapSlackEvent({ type: 'message', channel: 'C1', ts: '1.0', text: 'x' }, dir);
    tapSlackEvent(null, dir);
    tapSlackEvent({ type: 'message', channel: 'C1', ts: '2.0' }, join(dir, 'missing'));
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const lines = readFileSync(join(dir, files[0] as string), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] as string).ts, '1.0');
});
