import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerCallbackQueryBestEffort } from '../../src/telegram/callback-query.ts';

test('stale callback acknowledgement errors do not escape the update handler', async () => {
    await assert.doesNotReject(() => answerCallbackQueryBestEffort(async () => {
        throw new Error('400: query is too old');
    }));
});

test('callback acknowledgement still runs on the success path', async () => {
    let called = false;
    await answerCallbackQueryBestEffort(async () => { called = true; });
    assert.equal(called, true);
});
