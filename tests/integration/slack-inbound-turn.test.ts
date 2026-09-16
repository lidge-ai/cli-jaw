/**
 * Slack crossing: socket envelope -> gate -> ingress -> real spawned child ->
 * outbound reply, through a booted product server (#688).
 *
 * Everything below the envelope is the product. The only substitutions are the
 * two things a test cannot be allowed to reach: Slack itself (a scripted
 * fixture, injected through the server child's global fetch, which is the sole
 * seam initSlack leaves open) and the agent binary (a print-mode stub on PATH,
 * which is how spawnAgent resolves a runtime).
 *
 * The existing Slack coverage is 88 unit files that mock.module the API, the
 * socket, or the orchestrator pipeline; none of them run initSlack inside a
 * server or reach spawnAgent. That gap is what let a steered turn post "no
 * response" into a user's thread (#655) and what #697 says
 * steer-superseded-delivery still does not close.
 *
 * One server for all four cases on purpose: a boot costs seconds under tsx and
 * the driver fails a file that goes quiet for 180s, so four boots would spend
 * the budget on process startup rather than on the crossing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSlackFixture } from '../helpers/slack-fixture.mts';
import {
    PROJECT_ROOT, api, findFreePort, requireHarness, startJawServer,
    stopJawServer, waitForInboundChannel, waitForServer, type JawServer,
} from '../helpers/jaw-server.mts';

/** Every localized form of the empty-terminal placeholder (collect.ts t('tg.noResponse')). */
const PLACEHOLDERS = new Set(['en', 'ko', 'ja', 'zh'].map(code => {
    const table = JSON.parse(readFileSync(join(PROJECT_ROOT, 'public', 'locales', code + '.json'), 'utf8')) as Record<string, string>;
    return table['tg.noResponse'] ?? '';
}).filter(Boolean));

function envelope(id: string, text: string, ts: string, channel = 'C1'): Record<string, unknown> {
    // The full Socket Mode shape, and event.ts is mandatory: without it the ACK
    // reaction is skipped (ackTs in src/slack/bot.ts) and ingress dedupe is
    // skipped too, so a retry would spawn a second agent.
    return {
        envelope_id: id,
        type: 'events_api',
        accepts_response_payload: false,
        payload: {
            team_id: 'T1',
            event: {
                type: 'app_mention', channel, channel_type: 'channel',
                user: 'U1', text, ts, event_ts: ts,
            },
        },
    };
}

function stubRecords(dir: string): Record<string, unknown>[] {
    return readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>);
}

/**
 * A timeout here is the failure mode that is hardest to diagnose from CI, so
 * the detail callback is not optional decoration: it is the difference between
 * "the crossing stalled" and knowing which side stalled.
 */
async function waitFor(what: string, probe: () => boolean, timeoutMs = 30_000, detail?: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (probe()) return;
        await new Promise(r => setTimeout(r, 80));
    }
    throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + what + (detail ? '\n' + detail() : ''));
}

function postedTexts(
    fixture: { callsOf(m: string): { body: Record<string, unknown> }[] },
    channel?: string,
): string[] {
    return fixture.callsOf('chat.postMessage')
        .filter(c => channel === undefined || c.body['channel'] === channel)
        .map(c => String(c.body['text'] ?? ''));
}

test('SLACK-INT: a mention crosses from socket envelope to posted reply', { timeout: 170_000 }, async t => {
    if (!requireHarness(t)) return;

    const fixture = await startSlackFixture();
    const home = mkdtempSync(join(tmpdir(), 'jaw-slack-int-'));
    const workspace = mkdtempSync(join(tmpdir(), 'jaw-slack-ws-'));
    const stubDir = mkdtempSync(join(tmpdir(), 'jaw-slack-stub-'));
    const binDir = join(stubDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    // spawnAgent resolves a runtime by BINARY NAME off PATH, so the stub has to
    // be called 'claude'. HOME is redirected to the temp home as well, because
    // cli-detect promotes a real ~/.claude/local/bin/claude above anything on
    // PATH; every case still asserts a stub record, so a real binary winning
    // would fail loudly rather than quietly answering for it.
    symlinkSync(join(PROJECT_ROOT, 'tests', 'fixtures', 'print-agent-stub.mjs'), join(binDir, 'claude'));

    const port = await findFreePort();
    const server: JawServer = startJawServer({
        home, port,
        settings: {
            cli: 'claude',
            permissions: 'auto',
            perCli: { claude: { transport: 'print' } },
            workingDir: workspace,
            messaging: { enabledChannels: ['slack'], homeChannel: 'slack' },
            slack: {
                enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', teamId: 'T1',
                channelIds: [], mentionOnly: true, conversationContext: false,
                autoJoin: { enabled: false },
                // ACK reactions are OFF by default (SLACK_ACK_DEFAULTS), and
                // resolveAckConfig only enables them for enabled === true. Without
                // this the reaction assertions below would assert nothing.
                ack: { enabled: true, scope: 'all' },
            },
        },
        env: {
            PATH: binDir + ':' + (process.env['PATH'] ?? ''),
            HOME: home,
            JAW_STUB_DIR: stubDir,
            JAW_TEST_SLACK_API_BASE: fixture.apiBase,
            CLI_JAW_SLACK_ALLOW_SHARED_TOKEN: '1',
            NODE_OPTIONS: '--import ' + join(PROJECT_ROOT, 'tests', 'helpers', 'slack-api-preload.mjs'),
        },
    });

    t.after(async () => { await stopJawServer(server); await fixture.close(); });

    await waitForServer(server);
    await waitForInboundChannel(server, 'slack');
    // Proof the preload landed: these two calls only exist if the product's
    // Slack client reached the fixture instead of slack.com.
    await fixture.waitForCall('auth.test');
    await fixture.waitForCall('apps.connections.open');

    await t.test('SLACK-INT-001 app_mention acks, spawns a real child and posts the answer', async () => {
        await fixture.emitUntilAcked(envelope('E1', '<@UBOT> ping STUB_MODI:echo:one', '1735689600.000100'));
        assert.ok(fixture.acked.has('E1'), 'the product acked the envelope');

        const running = await fixture.waitForCall('reactions.add', c => c.body['name'] === 'eyes');
        assert.equal(running.body['channel'], 'C1');
        assert.equal(running.body['timestamp'], '1735689600.000100');

        await waitFor('a spawned stub child', () => stubRecords(stubDir).length > 0);
        const record = stubRecords(stubDir)[0]!;
        assert.match(String(record['prompt']), /STUB_MODI:echo:one/, 'the stub received the mention text on stdin');

        await fixture.waitForCall('chat.postMessage', c => String(c.body['text'] ?? '').includes('stub reply'));
        await fixture.waitForCall('reactions.add', c => c.body['name'] === 'white_check_mark');
    });

    await t.test('SLACK-INT-002 a steered turn delivers a real answer, never the placeholder', async () => {
        const before = postedTexts(fixture).length;
        const held = stubRecords(stubDir).length;
        await fixture.emitUntilAcked(envelope('E2', '<@UBOT> first STUB_MODI:hold:s1', '1735689601.000100'));
        await waitFor('the held child to start', () => stubRecords(stubDir).length > held);

        // Different text and a different ts: the gateway drops an identical
        // (scope, origin, text, chat, thread) within 5s as a duplicate, which
        // would silently turn this into a one-turn test.
        await fixture.emitUntilAcked(envelope('E3', '<@UBOT> second STUB_MODI:echo:three', '1735689602.000100'));
        writeFileSync(join(stubDir, 'release-s1'), '');

        // The second mention must actually have produced a turn. Without this a
        // steer that silently DROPPED the follow-up would still satisfy the wait
        // below, because releasing the first held child produces a reply on its
        // own — the test would be measuring the release, not the steer.
        await waitFor(
            'a child for the steering mention',
            () => stubRecords(stubDir).some(record => String(record['prompt']).includes('STUB_MODI:echo:three')),
            60_000,
            () => 'stub prompts seen: ' + JSON.stringify(stubRecords(stubDir).map(r => String(r['prompt']).slice(-60))),
        );

        await waitFor(
            'a reply after the steer',
            () => postedTexts(fixture).slice(before).some(text => text.includes('stub reply')),
            90_000,
        );
        // The whole run so far, not a slice: the #655 failure is that a
        // superseded turn posts the placeholder ANYWHERE, and nothing before
        // this point is allowed to have produced one.
        const all = postedTexts(fixture);
        const placeholders = all.filter(text => PLACEHOLDERS.has(text.trim()));
        assert.deepEqual(placeholders, [], 'a turn posted the no-response placeholder; all posts so far: ' + JSON.stringify(all));
    });

    await t.test('SLACK-INT-003 an empty terminal posts the placeholder, and says so', async () => {
        // A channel of its own. Run in C1 the empty turn lands behind the steer
        // sequence above and is retired as superseded, which takes the early
        // return in bot.ts and posts nothing — a true statement about steering,
        // not about an empty terminal. C2 gives this turn its own lane.
        await fixture.emitUntilAcked(envelope('E4', '<@UBOT> quiet STUB_MODI:empty:q1', '1735689603.000100', 'C2'));
        // Polling for the placeholder rather than slicing a window: an earlier
        // turn's reply can still be in flight, and a count-based window would
        // read that as this turn's answer.
        //
        // This pins TODAY'S contract rather than a wish. An empty print terminal
        // becomes t('tg.noResponse') in collect.ts and Slack posts it; the
        // suppression in bot.ts applies only to a superseded turn, which is
        // SLACK-INT-002. If that is ever changed deliberately, this test is what
        // notices, instead of a user's thread.
        await waitFor(
            'the localized no-response placeholder',
            () => postedTexts(fixture, 'C2').some(text => PLACEHOLDERS.has(text.trim())),
            45_000,
            () => 'posted to C2: ' + JSON.stringify(postedTexts(fixture, 'C2'))
                + '\nposted to C1: ' + JSON.stringify(postedTexts(fixture, 'C1'))
                + '\nslack methods: ' + JSON.stringify(fixture.calls.map(c => c.method))
                + '\nserver tail: ' + server.output().slice(-3000),
        );
    });

    await t.test('SLACK-INT-004 a file send reserves, uploads and completes', async () => {
        const filePath = join(workspace, 'fixture-upload.txt');
        writeFileSync(filePath, 'cli-jaw integration upload fixture\n');
        const res = await api(server, '/api/slack/send', {
            method: 'POST',
            // type must name a file kind: the send handler routes 'text' to
            // sendSlackText and rejects it without text, so a file-only body
            // with the default type never reaches sendSlackFile.
            body: JSON.stringify({ chat_id: 'C1', type: 'document', file_path: filePath, caption: 'fixture' }),
        });
        const payload = await res.json() as { ok?: boolean; upload?: Record<string, unknown> };
        assert.equal(res.status, 200, 'send failed: ' + JSON.stringify(payload));
        assert.equal(payload.ok, true);

        const reserved = await fixture.waitForCall('files.getUploadURLExternal');
        assert.equal(reserved.body['filename'], 'fixture-upload.txt');
        // The reservation hands back an https loopback URL because slack-file.ts
        // refuses anything else; the preload downgrades it to this fixture.
        await fixture.waitForCall('upload');
        const completed = await fixture.waitForCall('files.completeUploadExternal');
        const files = completed.body['files'] as { id?: string }[] | undefined;
        assert.equal(files?.[0]?.id, 'F1');
        assert.equal(completed.body['channel_id'], 'C1');
    });
});
