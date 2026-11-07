import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runSlackPreSendHook } from '../../src/messaging/slack-pre-send-hook.ts';

const target = { channel: 'slack' as const, targetKind: 'channel' as const, peerKind: 'channel' as const, targetId: 'TEST_CHANNEL' };
const context = { channel: 'TEST_CHANNEL', requester: 'TEST_USER', jobKind: 'test_job', requestId: 'request-1', turnId: 'turn-1' };

async function withScript(source: string, fn: (script: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'cli-jaw-hook-test-'));
    const script = join(root, 'hook.mjs');
    await writeFile(script, source, { mode: 0o700 });
    try { await fn(script); } finally { await rm(root, { recursive: true, force: true }); }
}

test('unset hook is an exact no-op', async () => {
    const result = await runSlackPreSendHook('original', target, context, { env: {} });
    assert.deepEqual(result, { ok: true, text: 'original' });
});

test('configured hook can return repaired text through the output file and receives context', async () => {
    await withScript(`
      import { readFileSync, writeFileSync } from 'node:fs';
      const [contextFile, textFile, outputFile] = process.argv.slice(2);
      const context = JSON.parse(readFileSync(contextFile, 'utf8'));
      const text = readFileSync(textFile, 'utf8');
      writeFileSync(outputFile, context.jobKind + ': ' + text.replace('bad', 'good'));
      process.stdout.write(JSON.stringify({ok: true}) + '\\n');
    `, async script => {
        const env = {
            ...process.env,
            JAW_SLACK_PRE_SEND_HOOK: process.execPath,
            JAW_SLACK_PRE_SEND_HOOK_ARGS: JSON.stringify([script, '{context_file}', '{text_file}', '{output_file}']),
        };
        const result = await runSlackPreSendHook('bad', target, context, { env });
        assert.deepEqual(result, { ok: true, text: 'test_job: good' });
    });
});

test('validator failure blocks the original destination and preserves violations/notification receipt', async () => {
    await withScript(`
      process.stdout.write(JSON.stringify({ok: false, error: 'voice_blocked', violations: ['over_5_lines'], notification: {ok: true}}) + '\\n');
      process.exitCode = 2;
    `, async script => {
        const env = {
            ...process.env,
            JAW_SLACK_PRE_SEND_HOOK: process.execPath,
            JAW_SLACK_PRE_SEND_HOOK_ARGS: JSON.stringify([script]),
        };
        const result = await runSlackPreSendHook('bad', target, context, { env });
        assert.deepEqual(result, {
            ok: false,
            error: 'voice_blocked',
            violations: ['over_5_lines'],
            notificationSent: true,
        });
    });
});

test('hook timeout fails closed', async () => {
    await withScript(`setTimeout(() => {}, 500);`, async script => {
        const env = {
            ...process.env,
            JAW_SLACK_PRE_SEND_HOOK: process.execPath,
            JAW_SLACK_PRE_SEND_HOOK_ARGS: JSON.stringify([script]),
            JAW_SLACK_PRE_SEND_HOOK_TIMEOUT_MS: '25',
        };
        const result = await runSlackPreSendHook('bad', target, context, { env });
        assert.equal(result.ok, false);
        assert.equal(result.error, 'pre_send_hook_timeout');
    });
});

test('non-Slack targets remain no-op even when a hook is configured', async () => {
    const result = await runSlackPreSendHook('original', { ...target, channel: 'telegram', targetId: 'TEST_CHAT' }, context, {
        env: { JAW_SLACK_PRE_SEND_HOOK: '/missing/executable' },
    });
    assert.deepEqual(result, { ok: true, text: 'original' });
});
