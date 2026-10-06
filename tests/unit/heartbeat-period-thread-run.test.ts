import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../../src/core/config.ts';
import { runHeartbeatJob, getHeartbeatRunRecord, type HeartbeatJobDeps } from '../../src/memory/heartbeat.ts';
import { resolveHeartbeatBinding } from '../../src/memory/heartbeat-destination.ts';
import { capturePeriodKey } from '../../src/memory/period-thread-key.ts';
import { periodThreadReplyHash, periodThreadRootHash, readPeriodReplyInfo } from '../../src/memory/period-thread-state.ts';
import { parseHeartbeatReport } from '../../src/memory/heartbeat-report.ts';
import { resolveSlackToolGrant, SLACK_TOOL_GRANT_ENV } from '../../src/slack/tool-context.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';

const destination = { channel: 'slack' as const, targetId: 'C0TESTCHANNEL', scope: 'period_thread' as const,
    periodThread: { rootKey: 'run-root', period: 'day' as const, role: 'creator' as const, slot: 'report', title: 'Test period' } };
const teamId = 'T0TESTTEAM';
const botUserId = 'U0TESTBOT';
let sequence = 0;
function fresh<T>(run: () => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-run-'));
    const previous = process.env['CLI_JAW_SHARED_HOME'];
    process.env['CLI_JAW_SHARED_HOME'] = home;
    return run().finally(() => {
        if (previous === undefined) delete process.env['CLI_JAW_SHARED_HOME']; else process.env['CLI_JAW_SHARED_HOME'] = previous;
        fs.rmSync(home, { recursive: true, force: true });
    });
}
function harness(overrides: Partial<HeartbeatJobDeps> = {}, output = 'status: ok\nsummary: Ready') {
    const id = `period-run-${++sequence}`;
    const job = { id, name: id, enabled: true, schedule: { kind: 'every', minutes: 10 }, prompt: 'Report', destination };
    const sent: Array<Record<string, unknown>> = [];
    const grants: Array<{ threadId?: string; flag?: boolean }> = [];
    const prompts: string[] = [];
    let collected = 0;
    const deps: HeartbeatJobDeps = {
        verifyDestination: async value => resolveHeartbeatBinding(value),
        ensurePeriodThread: async () => ({ ok: true, ts: '1791349260', teamId, botUserId }),
        verifyPeriodParent: async () => ({ ok: true }),
        listPeriodReplies: async () => ({ ok: true, found: false }),
        reserveDestinationGrant: async (binding, _id, options) => {
            grants.push({ threadId: binding.target.threadId, flag: options?.serverOwnedDelivery }); return () => {};
        },
        collectData: (async prompt => { prompts.push(prompt); collected++; return { text: output, data: {} }; }) as HeartbeatJobDeps['collectData'],
        sendOutput: (async request => { sent.push(request as unknown as Record<string, unknown>); return { ok: true }; }) as HeartbeatJobDeps['sendOutput'],
        ...overrides,
    };
    return { job, deps, sent, grants, prompts, collected: () => collected };
}

test('injection binds grant and final send to verified thread, with server instructions and reply claim', async () => fresh(async () => {
    const h = harness();
    await runHeartbeatJob(h.job, h.deps);
    assert.deepEqual(h.grants, [{ threadId: '1791349260', flag: true }]);
    assert.equal(h.sent.length, 1);
    assert.equal((h.sent[0]?.['target'] as { threadId: string }).threadId, '1791349260');
    assert.match(h.prompts[0]!, /\/api\/slack\/history\?channel=C0TESTCHANNEL&thread_ts=1791349260/);
    assert.match(h.prompts[0]!, /\[SILENT\]/);
    const captured = capturePeriodKey(getHeartbeatRunRecord(h.job.id)!.startedAt, 'day');
    const hash = periodThreadReplyHash(periodThreadRootHash(teamId, destination, captured), destination.periodThread.slot, botUserId);
    assert.equal(readPeriodReplyInfo(hash)?.status, 'delivered');
    assert.equal(getHeartbeatRunRecord(h.job.id)?.delivery, 'delivered');
}));

test('ensure failure skips collection; pre-send parent and reply failures prevent delivery', async () => fresh(async () => {
    const missing = harness({ ensurePeriodThread: async () => ({ ok: false, code: 'root_missing' }) });
    await runHeartbeatJob(missing.job, missing.deps);
    assert.equal(missing.collected(), 0);
    assert.equal(getHeartbeatRunRecord(missing.job.id)?.reason, 'root_missing');
    const invalid = harness({ verifyPeriodParent: async () => ({ ok: false, code: 'parent_invalid' }) });
    await runHeartbeatJob(invalid.job, invalid.deps);
    assert.equal(invalid.sent.length, 0);
    assert.equal(getHeartbeatRunRecord(invalid.job.id)?.reason, 'parent_invalid');
    const incomplete = harness({ listPeriodReplies: async () => ({ ok: false, code: 'replies_unverified' }) });
    await runHeartbeatJob(incomplete.job, incomplete.deps);
    assert.equal(incomplete.sent.length, 0);
    assert.equal(getHeartbeatRunRecord(incomplete.job.id)?.reason, 'replies_unverified');
}));

test('existing bot reply suppresses server send; claimed slot skips the next run', async () => fresh(async () => {
    const replied = harness({ listPeriodReplies: async () => ({ ok: true, found: true }) });
    await runHeartbeatJob(replied.job, replied.deps);
    assert.equal(replied.sent.length, 0);
    const second = harness();
    await runHeartbeatJob(second.job, second.deps);
    assert.equal(second.collected(), 0);
    assert.equal(getHeartbeatRunRecord(second.job.id)?.reason, 'slot_already_attempted');
}));

test('silent result leaves reply slot available for a later run', async () => fresh(async () => {
    const quiet = harness({}, '[SILENT]');
    await runHeartbeatJob(quiet.job, quiet.deps);
    assert.equal(quiet.sent.length, 0);
    const next = harness();
    await runHeartbeatJob(next.job, next.deps);
    assert.equal(next.sent.length, 1);
}));

test('captured period stays fixed when collection crosses KST midnight', async () => fresh(async () => {
    const beforeMidnight = Date.UTC(2026, 9, 6, 14, 59, 59);
    let observed = '';
    const h = harness({
        now: () => beforeMidnight,
        ensurePeriodThread: async (_destination, captured) => {
            observed = captured.periodKey;
            return { ok: true, ts: '1791280000', teamId, botUserId };
        },
        verifyPeriodParent: async (_destination, captured) => {
            assert.equal(captured.periodKey, '2026-10-06');
            return { ok: true };
        },
    });
    await runHeartbeatJob(h.job, h.deps);
    assert.equal(observed, '2026-10-06');
    assert.equal(h.sent.length, 1);
}));

test('default reservation passes serverOwnedDelivery into the active Slack grant', async () => fresh(async () => {
    const oldFetch = globalThis.fetch;
    const oldSlack = settings['slack'];
    settings['slack'] = { ...oldSlack, botToken: 'fake-token', enabled: true };
    globalThis.fetch = (async input => {
        if (String(input).endsWith('/auth.test')) return Response.json({ ok: true, team_id: teamId, user_id: botUserId });
        throw new Error('unexpected Slack request');
    }) as typeof fetch;
    resetVerifiedSlackWorkspace();
    try {
        const h = harness({ reserveDestinationGrant: undefined, activateDestinationGrant: undefined });
        const scriptJob = { ...h.job, runner: 'script', command: ['unused'] };
        const deps: HeartbeatJobDeps = { ...h.deps,
            runScript: async (_command, env) => {
                const grant = resolveSlackToolGrant(env[SLACK_TOOL_GRANT_ENV]!);
                assert.equal(grant?.serverOwnedDelivery, true);
                assert.equal(grant?.destination.threadId, '1791349260');
                return parseHeartbeatReport('status: ok\nsummary: Ready');
            },
        };
        await runHeartbeatJob(scriptJob, deps);
        assert.equal(h.sent.length, 1);
    } finally {
        globalThis.fetch = oldFetch;
        settings['slack'] = oldSlack;
        resetVerifiedSlackWorkspace();
    }
}));
