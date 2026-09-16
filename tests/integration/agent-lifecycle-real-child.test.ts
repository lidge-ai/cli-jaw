/**
 * Agent lifecycle against REAL child processes (#688).
 *
 * tests/integration/multi-session-concurrency.test.ts stays as it is: it proves
 * the lane bookkeeping in-process. What it cannot prove, and says so in its own
 * comments, is the part that has an operating system in it. Its fakeChild is an
 * EventEmitter with an injected terminateTree, so killProcessTree never runs
 * (src/agent/spawn/process-kill.ts short-circuits a pid-less child), no signal
 * is ever delivered, and a restart is never attempted.
 *
 * This file drives the same contract over HTTP against a booted server with two
 * live children: stop one scope, and the other keeps running; then start the
 * stopped scope again.
 *
 * Observation is the stub's own pid record, not an HTTP snapshot: spawn.ts
 * deletes the map entry before the operating system has reaped anything, so
 * /api/runtime can report a scope as free while its process is still alive.
 * A pid is the fact; the map is an opinion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PROJECT_ROOT, api, findFreePort, requireHarness, startJawServer,
    stopJawServer, waitForServer, type JawServer,
} from '../helpers/jaw-server.mts';

type StubRecord = { pid: number; prompt: string; terminatedAt?: string; signal?: string };

function records(dir: string): StubRecord[] {
    return readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as StubRecord);
}

function recordFor(dir: string, token: string): StubRecord | undefined {
    return records(dir).find(entry => entry.prompt.includes('STUB_MODI:hold:' + token)
        || entry.prompt.includes('STUB_MODI:echo:' + token));
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what: string, probe: () => boolean, timeoutMs = 60_000, detail?: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (probe()) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + what + (detail ? '\n' + detail() : ''));
}

test('AGENT-INT: a scoped stop kills one live child and leaves the other running', { timeout: 170_000 }, async t => {
    if (!requireHarness(t)) return;

    const home = mkdtempSync(join(tmpdir(), 'jaw-agent-int-'));
    const workspace = mkdtempSync(join(tmpdir(), 'jaw-agent-ws-'));
    const stubDir = mkdtempSync(join(tmpdir(), 'jaw-agent-stub-'));
    const binDir = join(stubDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, 'tests', 'fixtures', 'print-agent-stub.mjs'), join(binDir, 'claude'));

    const port = await findFreePort();
    const server: JawServer = startJawServer({
        home, port,
        settings: {
            cli: 'claude',
            permissions: 'auto',
            perCli: { claude: { transport: 'print' } },
            workingDir: workspace,
            // Two scopes have to be able to run at once, or the second prompt
            // queues behind the first and there is never a pair of live pids.
            multiSession: { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' },
        },
        env: {
            PATH: binDir + ':' + (process.env['PATH'] ?? ''),
            HOME: home,
            JAW_STUB_DIR: stubDir,
        },
    });

    t.after(async () => { await stopJawServer(server); });
    await waitForServer(server);

    // Read the body ONCE. An assertion message that awaits res.text() is
    // evaluated even when the assertion passes, which consumes the stream and
    // turns the next res.json() into "Body is unusable".
    async function call(path: string, body: unknown): Promise<{ status: number; text: string; json: Record<string, any> }> {
        const res = await api(server, path, { method: 'POST', body: JSON.stringify(body) });
        const text = await res.text();
        let parsed: Record<string, any> = {};
        try { parsed = JSON.parse(text) as Record<string, any>; } catch { /* reported through text */ }
        return { status: res.status, text, json: parsed };
    }

    const created = await call('/api/chat-sessions', { label: 'lane-b' });
    assert.equal(created.status, 200, 'could not create a second chat session: ' + created.text);
    const sessionB = created.json['data']?.id as string | undefined;
    assert.ok(sessionB, 'no session id in ' + created.text);

    // BOTH sends name their session. Creating a session also makes it active, so
    // an unqualified send follows the new one and the two prompts end up in a
    // single scope — where the second is queued behind the first and there is
    // never a second live child to prove anything about.
    const listed = await api(server, '/api/chat-sessions');
    const listedBody = await listed.json() as { data?: { sessions?: { id: string }[] } };
    const sessionA = listedBody.data?.sessions?.map(s => s.id).find(id => id !== sessionB);
    assert.ok(sessionA, 'no first session in ' + JSON.stringify(listedBody));
    assert.notEqual(sessionA, sessionB);

    const send = (prompt: string, sessionId?: string) =>
        call('/api/message', { prompt, ...(sessionId ? { sessionId } : {}) });

    await t.test('AGENT-INT-001 stopping one scope leaves the other alive', async () => {
        const a = await send('lane a please wait STUB_MODI:hold:laneA', sessionA);
        assert.equal(a.status, 200, 'lane A send failed: ' + a.text);
        assert.notEqual(a.json['action'], 'queued', 'lane A was queued: ' + a.text);
        const b = await send('lane b please wait STUB_MODI:hold:laneB', sessionB);
        assert.equal(b.status, 200, 'lane B send failed: ' + b.text);
        assert.notEqual(b.json['action'], 'queued', 'lane B queued behind lane A instead of running beside it: ' + b.text);

        await until('both held children to report a pid',
            () => recordFor(stubDir, 'laneA') !== undefined && recordFor(stubDir, 'laneB') !== undefined,
            60_000, () => 'created session: ' + created.text
                + '\nsend A: ' + a.text
                + '\nsend B: ' + b.text
                + '\nrecords: ' + JSON.stringify(records(stubDir).map(r => ({ pid: r.pid, prompt: r.prompt.slice(-120) })))
                + '\nserver: ' + server.output().slice(-1500));

        const pidA = recordFor(stubDir, 'laneA')!.pid;
        const pidB = recordFor(stubDir, 'laneB')!.pid;
        assert.notEqual(pidA, pidB, 'the two lanes must be different processes');
        assert.ok(alive(pidA) && alive(pidB), 'both children should be running before the stop');

        const stopped = await call('/api/stop', { sessionId: sessionA });
        assert.equal(stopped.status, 200, 'stop failed: ' + stopped.text);

        // Polled, not read once: the kill is SIGTERM with SIGKILL escalating
        // after a couple of seconds, so the pid can legitimately still be alive
        // the instant the HTTP call returns.
        await until('lane A to die', () => !alive(pidA), 30_000,
            () => 'lane A record: ' + JSON.stringify(recordFor(stubDir, 'laneA')));
        // B is checked across that whole window, which is the stronger claim:
        // a kill that took the wrong scope with it would have shown up by now.
        assert.ok(alive(pidB), 'lane B was killed by a stop aimed at the default scope');

        const killed = recordFor(stubDir, 'laneA');
        assert.equal(killed?.signal, 'SIGTERM', 'lane A should have received a real signal, not merely vanished');
    });

    await t.test('AGENT-INT-002 the stopped scope can start a new child', async () => {
        const before = recordFor(stubDir, 'laneA')!.pid;
        const pidB = recordFor(stubDir, 'laneB')!.pid;
        // Different text on purpose: the gateway drops an identical
        // (scope, origin, text, chat, thread) inside a 5s window as a duplicate,
        // and a restart that was silently deduped looks exactly like a restart
        // that silently failed.
        const again = await send('lane a restarted STUB_MODI:echo:laneA2', sessionA);
        assert.equal(again.status, 200, 'restart send failed: ' + again.text);

        await until('a fresh lane A child', () => recordFor(stubDir, 'laneA2') !== undefined, 60_000,
            () => server.output().slice(-2000));
        assert.notEqual(recordFor(stubDir, 'laneA2')!.pid, before, 'the restart reused the killed pid');
        assert.equal(recordFor(stubDir, 'laneB')!.pid, pidB, 'lane B was restarted by someone else');
    });
});
