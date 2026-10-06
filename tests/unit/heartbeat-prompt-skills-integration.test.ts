import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { SKILLS_DIR, loadHeartbeatFile, saveHeartbeatFile, settings } from '../../src/core/config.ts';
import { db } from '../../src/core/db.ts';

const collectUrl = new URL('../../src/orchestrator/collect.ts', import.meta.url).href;
const sendUrl = new URL('../../src/messaging/send.ts', import.meta.url).href;
const stateUrl = new URL('../../src/orchestrator/state-machine.ts', import.meta.url).href;
const spawnUrl = new URL('../../src/agent/spawn.ts', import.meta.url).href;
const registryUrl = new URL('../../src/orchestrator/worker-registry.ts', import.meta.url).href;
const [realSend, realState, realSpawn, realRegistry] = await Promise.all([
    import('../../src/messaging/send.js'), import('../../src/orchestrator/state-machine.js'),
    import('../../src/agent/spawn.js'), import('../../src/orchestrator/worker-registry.js'),
]);
const prompts: string[] = [];
const sent: string[] = [];
mock.module(collectUrl, { namedExports: {
    orchestrateAndCollectData: async (prompt: string) => {
        prompts.push(prompt);
        return { text: 'A test answer', data: { runtimeStatus: 'done' } };
    },
    orchestrateAndCollect: async () => 'unused',
} });
mock.module(sendUrl, { namedExports: { ...realSend, sendChannelOutput: async (input: { text: string }) => {
    sent.push(input.text); return { ok: true };
} } });
mock.module(stateUrl, { namedExports: { ...realState, getState: () => 'IDLE' } });
mock.module(spawnUrl, { namedExports: { ...realSpawn, isAgentBusy: () => false, messageQueue: [] } });
mock.module(registryUrl, { namedExports: { ...realRegistry, hasPendingWorkerReplays: () => false } });
const { runHeartbeatJob, getHeartbeatRunRecord, stopHeartbeat } = await import('../../src/memory/heartbeat.js');
const { registerHeartbeatRoutes } = await import('../../src/routes/heartbeat.js');
const { resolveHeartbeatBinding } = await import('../../src/memory/heartbeat-destination.js');

const jobId = 'hb_fake_lens';
const team = 'TFAKE001';
const subject = 'UFAKE001';
const channel = 'CFAKE001';
const skillId = 'test-lens';
const skillFile = join(SKILLS_DIR, skillId, 'SKILL.md');
const tables = ['mention_watch_seen_v2', 'mention_watch_cursor_v2', 'mention_watch_rotation_v2', 'mention_watch_inbox'] as const;
function snapshot() {
    return Object.fromEntries(tables.map(table => {
        const rows = table === 'mention_watch_inbox'
            ? db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND subject_id = ? ORDER BY channel_id, message_ts`).all(team, subject)
            : db.prepare(`SELECT * FROM ${table} WHERE job_id = ? ORDER BY rowid`).all(jobId);
        return [table, rows];
    }));
}

test('isolated PUT/GET/reload, failed tick preserves four ledgers, recovery answers same hit with skill body', async t => {
    const priorSlack = settings.slack;
    settings.slack = { ...priorSlack, enabled: true, botToken: 'xoxb-test-only', channelIds: [channel] };
    t.after(() => { settings.slack = priorSlack; });
    saveHeartbeatFile({ jobs: [] });
    db.prepare('INSERT INTO mention_watch_seen_v2 VALUES (?, ?, ?, ?, ?, ?)').run(jobId, team, subject, channel, '110.000100', 1);
    db.prepare('INSERT INTO mention_watch_cursor_v2 VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, team, subject, channel, '100.000100', '150.000100', 1);
    db.prepare('INSERT INTO mention_watch_rotation_v2 VALUES (?, ?, ?, ?, ?)').run(jobId, team, subject, channel, 1);
    db.prepare('INSERT INTO mention_watch_inbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(team, subject, channel, '200.000100', '199.000100', 'UAUTHOR01', null, null, `<@${subject}> Review this`, Date.now());
    const originalFetch = globalThis.fetch;
    const slackCalls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('slack.com/api/')) return originalFetch(input, init);
        const method = url.split('/').pop()!;
        slackCalls.push(method);
        if (method === 'auth.test') return Response.json({ ok: true, team_id: team, user_id: 'UBOTFAKE' });
        if (method === 'conversations.history') return Response.json({ ok: true, messages: [], has_more: false });
        throw new Error(`unexpected Slack method ${method}`);
    });
    const app = express(); app.use(express.json());
    registerHeartbeatRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address(); assert.ok(addr && typeof addr === 'object');
    const url = `http://127.0.0.1:${addr.port}/api/heartbeat`;
    const job = { id: jobId, name: 'Fake lens', enabled: false, schedule: { kind: 'every', minutes: 5 },
        prompt: 'Answer the question', promptSkills: [skillId],
        mentionWatch: { channel: 'slack', userId: subject, channelIds: [channel], since: '99.000100' } };
    try {
        const put = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs: [job] }) });
        assert.equal(put.status, 200);
        const get = await (await fetch(url)).json() as { jobs: Array<{ promptSkills?: string[] }> };
        assert.deepEqual(get.jobs[0]?.promptSkills, [skillId]);
        const reloaded = loadHeartbeatFile().jobs[0];
        assert.deepEqual(reloaded?.promptSkills, [skillId]);
        const before = snapshot();
        await runHeartbeatJob({ ...reloaded, enabled: true });
        assert.deepEqual(snapshot(), before, 'failed tick changed a durable watch row');
        assert.equal(getHeartbeatRunRecord(jobId)?.execution, 'skipped');
        assert.equal(getHeartbeatRunRecord(jobId)?.reason, 'prompt_skill_unavailable');
        const failedGet = await (await fetch(url)).json() as { jobs: Array<{ lastRun?: { reason?: string } }> };
        assert.equal(failedGet.jobs[0]?.lastRun?.reason, 'prompt_skill_unavailable');
        assert.equal(prompts.length, 0);
        assert.equal(slackCalls.length, 0);
        fs.mkdirSync(join(SKILLS_DIR, skillId), { recursive: true });
        fs.writeFileSync(skillFile, '---\nname: test-lens\n---\nPinned integration rule.\n');
        await runHeartbeatJob({ ...reloaded, enabled: true });
        assert.equal(prompts.length, 1);
        assert.match(prompts[0]!, /Pinned integration rule/);
        assert.doesNotMatch(prompts[0]!, /name: test-lens/);
        assert.match(prompts[0]!, /Answer the question/);
        assert.deepEqual(sent, ['A test answer']);
        assert.equal(getHeartbeatRunRecord(jobId)?.execution, 'ok');
        const remainingInbox = db.prepare('SELECT count(*) AS n FROM mention_watch_inbox WHERE workspace_id = ? AND subject_id = ?').get(team, subject) as { n: number };
        assert.equal(remainingInbox.n, 0);
        const normalPrompts: string[] = [];
        await runHeartbeatJob({ id: 'hb_fake_normal', name: 'Normal', runner: 'main',
            prompt: 'Ordinary instruction', promptSkills: [skillId],
            destination: { channel: 'discord', targetId: 'fake-room', scope: 'channel_root' },
            schedule: { kind: 'every', minutes: 5 } }, {
            verifyDestination: async destination => resolveHeartbeatBinding(destination),
            reserveDestinationGrant: async () => () => {},
            collectData: async prompt => {
                normalPrompts.push(prompt);
                return { text: '[SILENT]', data: {} } as Awaited<ReturnType<typeof import('../../src/orchestrator/collect.js').orchestrateAndCollectData>>;
            },
        });
        assert.equal(normalPrompts.length, 1);
        assert.match(normalPrompts[0]!, /Pinned integration rule/);
        assert.match(normalPrompts[0]!, /Ordinary instruction/);
        assert.doesNotMatch(normalPrompts[0]!, /name: test-lens/);
    } finally {
        stopHeartbeat(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        saveHeartbeatFile({ jobs: [] });
        fs.rmSync(join(SKILLS_DIR, skillId), { recursive: true, force: true });
    }
});
