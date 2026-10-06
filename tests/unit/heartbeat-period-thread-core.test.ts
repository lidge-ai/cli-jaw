import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import express from 'express';
import { createServer } from 'node:http';
import { isHeartbeatDestination, saveHeartbeatFile } from '../../src/core/config.ts';
import { capturePeriodKey } from '../../src/memory/period-thread-key.ts';
import { ensurePeriodThreadRoot, listBotRepliesSince } from '../../src/memory/period-thread-root.ts';
import { acquirePeriodConsumerSlot, periodThreadRootHash, readPeriodThreadDiagnostic, registerPeriodThreadMarker } from '../../src/memory/period-thread-state.ts';
import { registerHeartbeatRoutes } from '../../src/routes/heartbeat.ts';
import { stopHeartbeat } from '../../src/memory/heartbeat.ts';

const day = capturePeriodKey(Date.UTC(2026, 9, 7, 3), 'day');
const ts = String(day.startMs / 1000 + 60);
const bot = 'U0TESTBOT';
const team = 'T0TESTTEAM';
const destination = (overrides: Record<string, unknown> = {}) => ({
    channel: 'slack' as const, targetId: 'C0TESTCHANNEL', scope: 'period_thread' as const,
    periodThread: { rootKey: 'daily-root', period: 'day' as const, role: 'creator' as const, slot: 'morning', title: 'Test period', ...overrides },
});
function shared<T>(run: (home: string) => Promise<T> | T): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-test-'));
    const before = process.env['CLI_JAW_SHARED_HOME'];
    process.env['CLI_JAW_SHARED_HOME'] = home;
    return Promise.resolve().then(() => run(home)).finally(() => {
        if (before === undefined) delete process.env['CLI_JAW_SHARED_HOME']; else process.env['CLI_JAW_SHARED_HOME'] = before;
        fs.rmSync(home, { recursive: true, force: true });
    });
}
type FakePage = Record<string, unknown>;
function fakeSlack(pages: FakePage[] = [{ ok: true, messages: [], has_more: false }], post: FakePage = { ok: true, ts }) {
    const calls: string[] = [];
    let index = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
        const method = String(input).split('/').pop()!;
        calls.push(method);
        if (method === 'conversations.history') return Response.json(pages[Math.min(index++, pages.length - 1)]);
        if (method === 'conversations.replies') return Response.json({ ok: true, messages: [{ ts, user: bot, text: `Test period ${day.label}` }] });
        if (method === 'chat.postMessage') return Response.json(post);
        throw new Error(`unexpected ${method}`);
    };
    return { calls, fetchImpl: fetchImpl as typeof fetch };
}
const deps = (fetchImpl: typeof fetch, now = day.startMs + 60_000) => ({
    token: 'fake-token', fetchImpl, now: () => now,
    verifyWorkspace: async () => ({ teamId: team, userId: bot }),
});

test('KST day and week boundaries remain fixed across host time zones', () => {
    const before = capturePeriodKey(Date.UTC(2026, 9, 6, 14, 59), 'day');
    const after = capturePeriodKey(Date.UTC(2026, 9, 6, 15), 'day');
    assert.equal(before.periodKey, '2026-10-06');
    assert.equal(after.periodKey, '2026-10-07');
    assert.equal(after.label, '10/7(수)');
    assert.equal(after.startMs, Date.UTC(2026, 9, 6, 15));
    const sunday = capturePeriodKey(Date.UTC(2026, 9, 4, 14, 59), 'week');
    const monday = capturePeriodKey(Date.UTC(2026, 9, 4, 15), 'week');
    assert.equal(sunday.periodKey, '2026-09-28');
    assert.equal(monday.periodKey, '2026-10-05');
    assert.equal(monday.label, '10/5~10/11');
    assert.equal(after.periodKey, capturePeriodKey(after.endMs - 1, 'day').periodKey);
    const utc = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import {capturePeriodKey} from './src/memory/period-thread-key.ts'; process.stdout.write(capturePeriodKey(Date.UTC(2026,9,6,15),'day').periodKey)"],
    { cwd: process.cwd(), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
    assert.equal(utc, after.periodKey);
});

test('period destination validation and deferred binding shape', async () => {
    assert.equal(isHeartbeatDestination(destination()), true);
    const invalid = [
        destination({ rootKey: 'Bad' }), destination({ slot: '' }), destination({ title: 'bad\nline' }),
        destination({ intro: 'bad\nline' }), destination({ maxPages: 101 }),
        destination({ maxConcurrent: 3 }), destination({ concurrencyWaitSeconds: -1 }),
        destination({ role: 'consumer' }),
        { ...destination(), threadId: ts }, { ...destination(), scope: 'channel_root' },
    ];
    for (const item of invalid) assert.equal(isHeartbeatDestination(item), false);
    const { resolveHeartbeatBinding, verifyHeartbeatThreadBindingLive } = await import('../../src/memory/heartbeat-destination.ts');
    assert.equal(resolveHeartbeatBinding(destination()).state, 'deferred');
    assert.equal((await verifyHeartbeatThreadBindingLive(destination(), { token: '' })).state, 'deferred');
});

test('creator creates once, adopts one parent, and keeps token and body out of shared files', async () => shared(async home => {
    const api = fakeSlack();
    const result = await ensurePeriodThreadRoot(destination(), day, deps(api.fetchImpl));
    assert.deepEqual(result, { ok: true, ts, teamId: team, botUserId: bot });
    assert.equal(api.calls.filter(x => x === 'chat.postMessage').length, 1);
    const adopted = fakeSlack([{ ok: true, messages: [{ ts, user: bot, text: `Test period ${day.label}\nlong body` }], has_more: false }]);
    assert.equal((await ensurePeriodThreadRoot(destination(), day, deps(adopted.fetchImpl))).ok, true);
    assert.equal(adopted.calls.includes('chat.postMessage'), false);
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    for (const file of files(home)) {
        const content = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(content, /fake-token|long body|xoxb-|Test period/);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(path.join(home, 'period-threads')).mode & 0o777, 0o700);
}));

test('root scan refuses missing, multiple, foreign author, incomplete, rate limited and uncertain creation', async () => {
    const cases: Array<[string, FakePage[], Record<string, unknown>, string]> = [
        ['consumer missing', [{ ok: true, messages: [], has_more: false }], { role: 'consumer', creatorUserId: bot }, 'root_missing'],
        ['multiple', [{ ok: true, messages: [{ ts, user: bot, text: `Test period ${day.label}` }, { ts: String(Number(ts) + 1), user: 'U0TESTOTHER', text: `Test period ${day.label}` }], has_more: false }], {}, 'root_multiple'],
        ['foreign', [{ ok: true, messages: [{ ts, user: 'U0TESTOTHER', text: `Test period ${day.label}` }], has_more: false }], {}, 'root_identity_mismatch'],
        ['page cap', [{ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'next' } }], { maxPages: 1 }, 'history_incomplete'],
        ['missing cursor', [{ ok: true, messages: [], has_more: true }], {}, 'history_incomplete'],
        ['repeat cursor', [{ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'same' } }], {}, 'history_incomplete'],
        ['rate', [{ ok: false, error: 'ratelimited' }], {}, 'slack_rate_limited'],
    ];
    for (const [, pages, config, expected] of cases) await shared(async () => {
        const api = fakeSlack(pages);
        assert.deepEqual(await ensurePeriodThreadRoot(destination(config), day, deps(api.fetchImpl)), { ok: false, code: expected });
        assert.equal(api.calls.includes('chat.postMessage'), false);
    });
    await shared(async () => {
        const api = fakeSlack(undefined, { ok: false, error: 'internal_error' });
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(api.fetchImpl)), { ok: false, code: 'create_uncertain' });
        const second = fakeSlack();
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(second.fetchImpl)), { ok: false, code: 'create_uncertain' });
        assert.equal(second.calls.includes('chat.postMessage'), false);
    });
});

test('history ignores replies and out-of-period matches; auth and transport failures fail closed', async () => {
    await shared(async () => {
        const api = fakeSlack([{ ok: true, messages: [
            { ts, user: bot, thread_ts: String(Number(ts) - 1), text: `Test period ${day.label}` },
            { ts: String(day.endMs / 1000 + 1), user: bot, text: `Test period ${day.label}` },
        ], has_more: false }]);
        assert.equal((await ensurePeriodThreadRoot(destination({ role: 'consumer', creatorUserId: bot }), day, deps(api.fetchImpl))).ok, false);
        assert.equal(api.calls.includes('chat.postMessage'), false);
    });
    await shared(async () => {
        const api = fakeSlack();
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, { ...deps(api.fetchImpl), verifyWorkspace: async () => null }),
            { ok: false, code: 'slack_auth_failed' });
        assert.deepEqual(api.calls, []);
    });
    await shared(async () => {
        const api = fakeSlack();
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(api.fetchImpl, day.endMs)),
            { ok: false, code: 'period_rolled_over' });
        assert.equal(api.calls.includes('chat.postMessage'), false);
    });
    await shared(async () => {
        const throwing = (async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/chat.postMessage')) throw new Error('network failed');
            return Response.json({ ok: true, messages: [], has_more: false });
        }) as typeof fetch;
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(throwing)), { ok: false, code: 'create_uncertain' });
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(throwing)), { ok: false, code: 'create_uncertain' });
    });
});

test('explicit rejection permits only the next numbered creation claim', async () => shared(async () => {
    const rejected = fakeSlack(undefined, { ok: false, error: 'not_in_channel' });
    assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(rejected.fetchImpl)), { ok: false, code: 'create_rejected' });
    const accepted = fakeSlack();
    assert.equal((await ensurePeriodThreadRoot(destination(), day, deps(accepted.fetchImpl))).ok, true);
    assert.equal(readPeriodThreadDiagnostic(destination(), day).claims.create, 2);
}));

test('existing creation claim holds as in progress; a rejected 429 permits retry', async () => {
    await shared(async home => {
        const hash = periodThreadRootHash(team, destination(), day);
        const claims = path.join(home, 'period-threads', 'claims');
        fs.mkdirSync(claims, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(claims, `${hash}.create.1`), JSON.stringify({ pid: 123, host: 'test', at: 1 }), { mode: 0o600 });
        const api = fakeSlack();
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(api.fetchImpl)), { ok: false, code: 'create_in_progress' });
        assert.equal(api.calls.includes('chat.postMessage'), false);
    });
    await shared(async () => {
        const rate = (async (input: RequestInfo | URL) => String(input).endsWith('/chat.postMessage')
            ? Response.json({ ok: false, error: 'ratelimited' }, { status: 429 })
            : Response.json({ ok: true, messages: [], has_more: false })) as typeof fetch;
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(rate)), { ok: false, code: 'create_rejected' });
        const accepted = fakeSlack();
        assert.equal((await ensurePeriodThreadRoot(destination(), day, deps(accepted.fetchImpl))).ok, true);
    });
});

test('parent verification rejects changed author and failed lookup', async () => {
    await shared(async () => {
        const changed = (async (input: RequestInfo | URL) => String(input).endsWith('/conversations.replies')
            ? Response.json({ ok: true, messages: [{ ts, user: 'U0TESTOTHER', text: `Test period ${day.label}` }] })
            : Response.json({ ok: true, messages: [{ ts, user: bot, text: `Test period ${day.label}` }], has_more: false })) as typeof fetch;
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(changed)), { ok: false, code: 'parent_invalid' });
    });
    await shared(async () => {
        const unavailable = (async (input: RequestInfo | URL) => String(input).endsWith('/conversations.replies')
            ? Response.json({ ok: false, error: 'ratelimited' }, { status: 429 })
            : Response.json({ ok: true, messages: [{ ts, user: bot, text: `Test period ${day.label}` }], has_more: false })) as typeof fetch;
        assert.deepEqual(await ensurePeriodThreadRoot(destination(), day, deps(unavailable)), { ok: false, code: 'parent_unverified' });
    });
});

test('different root keys in separate homes cannot adopt the same period marker', async () => shared(async () => {
    const original = process.env['CLI_JAW_HOME'];
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-home-a-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-home-b-'));
    try {
        const first = destination({ rootKey: 'first' });
        const second = destination({ rootKey: 'second' });
        process.env['CLI_JAW_HOME'] = homeA;
        const created = fakeSlack();
        assert.equal((await ensurePeriodThreadRoot(first, day, deps(created.fetchImpl))).ok, true);
        process.env['CLI_JAW_HOME'] = homeB;
        const rejected = fakeSlack();
        assert.deepEqual(await ensurePeriodThreadRoot(second, day, deps(rejected.fetchImpl)), { ok: false, code: 'root_marker_ambiguous' });
        assert.deepEqual(rejected.calls, []);
    } finally {
        if (original === undefined) delete process.env['CLI_JAW_HOME']; else process.env['CLI_JAW_HOME'] = original;
        fs.rmSync(homeA, { recursive: true, force: true });
        fs.rmSync(homeB, { recursive: true, force: true });
    }
}));

test('reply scan checks later cursor even after finding a bot reply', async () => shared(async () => {
    const response = (async () => Response.json({ ok: true,
        messages: [{ ts: String(Number(ts) + 100), user: bot }], has_more: true })) as typeof fetch;
    assert.deepEqual(await listBotRepliesSince(destination(), ts, bot, Number(ts) * 1000, deps(response)),
        { ok: false, code: 'replies_unverified' });
}));

test('marker registration is shared across homes within one period and resets next period', async () => shared(async () => {
    const first = destination({ rootKey: 'root-a' });
    const second = destination({ rootKey: 'root-b' });
    const original = process.env['CLI_JAW_HOME'];
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-home-a-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-period-home-b-'));
    try {
        process.env['CLI_JAW_HOME'] = homeA;
        assert.equal(registerPeriodThreadMarker(first, day), true);
        process.env['CLI_JAW_HOME'] = homeB;
        assert.equal(registerPeriodThreadMarker(second, day), false);
        assert.equal(registerPeriodThreadMarker(second, capturePeriodKey(day.endMs, 'day')), true);
    } finally {
        if (original === undefined) delete process.env['CLI_JAW_HOME']; else process.env['CLI_JAW_HOME'] = original;
        fs.rmSync(homeA, { recursive: true, force: true });
        fs.rmSync(homeB, { recursive: true, force: true });
    }
}));

test('reply scan requires every page and detects the bot reply from this run', async () => shared(async () => {
    const replyTs = String(Number(ts) + 100);
    const fetchImpl = (async () => Response.json({ ok: true, messages: [{ ts }, { ts: replyTs, user: bot }], has_more: false })) as typeof fetch;
    assert.deepEqual(await listBotRepliesSince(destination(), ts, bot, Number(ts) * 1000, deps(fetchImpl)), { ok: true, found: true });
    const incomplete = (async () => Response.json({ ok: true, messages: [{ ts }], has_more: true })) as typeof fetch;
    assert.deepEqual(await listBotRepliesSince(destination(), ts, bot, Number(ts) * 1000, deps(incomplete)), { ok: false, code: 'replies_unverified' });
}));

test('GET diagnostic reads shared files without Slack calls or claims', async () => shared(async () => {
    const api = fakeSlack();
    await ensurePeriodThreadRoot(destination(), day, deps(api.fetchImpl));
    const summary = readPeriodThreadDiagnostic(destination(), day);
    assert.equal(summary.root?.ts, ts);
    assert.equal(summary.claims.create, 1);
}));

test('PUT rejects conflicting marker, root contract and mention watch; GET keeps deferred visible', async () => shared(async () => {
    saveHeartbeatFile({ jobs: [] });
    const app = express();
    app.use(express.json());
    registerHeartbeatRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const job = (id: string, dest = destination()) => ({ id, name: id, enabled: false,
        schedule: { kind: 'every', minutes: 10 }, prompt: 'Check', destination: dest });
    const put = async (jobs: unknown[]) => {
        const response = await fetch(`${base}/api/heartbeat`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs }) });
        return { status: response.status, body: await response.json() as { error?: string } };
    };
    try {
        assert.equal((await put([job('one')])).status, 200);
        const get = await fetch(`${base}/api/heartbeat`);
        const body = await get.json() as { jobs: Array<{ held?: string; periodThread?: { periodKey: string; root: unknown } }> };
        assert.equal(body.jobs[0]?.held, undefined);
        assert.ok(body.jobs[0]?.periodThread?.periodKey);
        assert.equal(body.jobs[0]?.periodThread?.root, null);
        const titleConflict = await put([job('one'), job('two', destination({ rootKey: 'other-root' }))]);
        assert.equal(titleConflict.status, 400);
        assert.equal(titleConflict.body.error, 'period_thread title must be unique per channel');
        const rootConflict = await put([job('one'), job('two', destination({ title: 'Other title' }))]);
        assert.equal(rootConflict.status, 400);
        const watched = { ...job('one'), mentionWatch: { channel: 'slack', userId: 'U0TESTUSER', channelIds: ['C0TESTCHANNEL'] } };
        assert.equal((await put([watched])).status, 400);
    } finally {
        stopHeartbeat();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        saveHeartbeatFile({ jobs: [] });
    }
}));

function child(mode: string, file: string, sharedHome: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise(resolve => {
        const childProcess = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/period-thread-child.ts', mode, file], {
            cwd: process.cwd(), env: { ...process.env, CLI_JAW_SHARED_HOME: sharedHome, CLI_JAW_HOME: sharedHome },
        });
        let stdout = ''; let stderr = '';
        childProcess.stdout.on('data', chunk => { stdout += String(chunk); });
        childProcess.stderr.on('data', chunk => { stderr += String(chunk); });
        childProcess.on('close', code => resolve({ stdout, stderr, code }));
    });
}
test('two child processes issue exactly one root creation POST', async () => shared(async home => {
    const file = path.join(home, 'posts.log');
    const results = await Promise.all([child('create', file, home), child('create', file, home)]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
}));
test('three child processes admit at most two consumers and recover a dead sequence', async () => shared(async home => {
    const file = path.join(home, 'slots.log');
    const results = await Promise.all([child('slot', file, home), child('slot', file, home), child('slot', file, home)]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => line.split(' ')[0]);
    let active = 0; let peak = 0;
    for (const event of events) { active += event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    assert.equal(peak, 2);
    assert.equal(active, 0);
    const dead = await child('dead', file, home);
    assert.equal(dead.code, 0, dead.stderr);
    const blocked = await acquirePeriodConsumerSlot(1, 0);
    assert.ok(blocked); blocked();
    const occupied = await acquirePeriodConsumerSlot(1, 0);
    assert.ok(occupied);
    assert.equal(await acquirePeriodConsumerSlot(1, 0), null);
    occupied();
    assert.equal(fs.readdirSync(path.join(home, 'period-threads', 'slots')).filter(name => name.startsWith('seq.')).length, 0);
}));
