import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { attachWatchdog } from '../../src/agent/watchdog.ts';
import { shouldAnnounceStallTruncation, STALL_TRUNCATION_NOTICE } from '../../src/agent/error-classifier.ts';
import { readSpawnAgentSource, readSpawnFile } from '../helpers/spawn-source.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fakeChild(): { child: ChildProcess; stdout: PassThrough } {
    const stdout = new PassThrough();
    const emitter = new EventEmitter() as unknown as ChildProcess;
    Object.assign(emitter, { stdout, stderr: new PassThrough(), pid: 1234 });
    return { child: emitter, stdout };
}

const FAST = { firstProgressMs: 60, idleMs: 60, absoluteMs: 60, absoluteHardCapMs: 10_000, checkIntervalMs: 10 };

function stallWithin(ms: number, cfg: Parameters<typeof attachWatchdog>[3], drive?: (stdout: PassThrough) => void) {
    const { child, stdout } = fakeChild();
    let reason: string | null = null;
    const handle = attachWatchdog(child, 'codex-app-test', r => { reason = r; }, cfg);
    const noise = drive ? setInterval(() => drive(stdout), 10) : null;
    return new Promise<string | null>(resolve => {
        setTimeout(() => {
            if (noise) clearInterval(noise);
            handle.stop();
            resolve(reason);
        }, ms);
    });
}

// ─── CAS-001 ───
//
// codex-app's stdout is the JSON-RPC stream, and CodexAppClient already owns it
// through readline. If the watchdog counted that traffic as liveness, a turn that
// stopped advancing would keep refreshing its own deadline — a wedged turn that
// looks alive forever. That is why the default runtime needs observeStdio: false.

test('CAS-001: observeStdio false ignores protocol chatter and still reports the stall', async () => {
    const reason = await stallWithin(400, { ...FAST, observeStdio: false },
        stdout => stdout.write('{"method":"codex/event","params":{"noise":true}}\n'));
    assert.ok(reason, 'a turn with no structured progress must stall despite stdout traffic');
});

test('CAS-002: the same chatter suppresses the stall when stdio IS observed', async () => {
    const reason = await stallWithin(400, FAST,
        stdout => stdout.write('{"method":"codex/event","params":{"noise":true}}\n'));
    assert.equal(reason, null, 'observed stdio keeps the deadline sliding — the behaviour CAS-001 opts out of');
});

test('CAS-003: structured progress alone keeps a codex-app turn alive', async () => {
    const { child } = fakeChild();
    let reason: string | null = null;
    const handle = attachWatchdog(child, 'codex-app-test', r => { reason = r; }, { ...FAST, observeStdio: false });
    // This is what markCodexProgress does: the turn adapter reports, not the pipe.
    const beat = setInterval(() => handle.markProgress(), 10);
    await new Promise(r => setTimeout(r, 400));
    clearInterval(beat);
    handle.stop();
    assert.equal(reason, null, 'a reporting turn must not be killed');
});

// ─── CAS-004 ───
//
// The whole point of #682. ctx.stallReason is the ONLY trigger for the #405 notice,
// and the bespoke codex-app timers never set it, so the default runtime's timeouts
// reached the user as a generic failure with no explanation and no truncation notice.

test('CAS-004: a codex-app stall reason produces the #405 truncation notice', async () => {
    const ctx: { stallReason?: string } = {};
    const { child } = fakeChild();
    await new Promise<void>(resolve => {
        const handle = attachWatchdog(child, 'codex-app-test', reason => {
            ctx.stallReason = reason;
            handle.stop();
            resolve();
        }, { ...FAST, observeStdio: false });
    });

    assert.ok(ctx.stallReason, 'the watchdog must hand the runtime a reason to record');
    assert.equal(
        shouldAnnounceStallTruncation({
            stallReason: ctx.stallReason, wasSteer: false, mainManaged: true, internal: false,
        }),
        true,
        'the default runtime must now reach the #405 notice',
    );
    assert.ok(STALL_TRUNCATION_NOTICE.length > 0);

    // A user who pressed stop already knows why it stopped.
    assert.equal(
        shouldAnnounceStallTruncation({
            stallReason: ctx.stallReason, wasSteer: true, mainManaged: true, internal: false,
        }),
        false,
    );
});

// ─── CAS-005 ───
//
// Negative and structural: the bespoke pair must not come back beside the shared
// watchdog, and settings.agentTimeout must be parsed once.

test('CAS-005: the codex-app turn owns no private stall timer, and agentTimeout is parsed once', () => {
    const spawnSrc = readSpawnAgentSource();
    // The turn window is sliced from the module that owns it; the agentTimeout count
    // below still covers all of spawnAgent's source.
    const codexAppSrc = readSpawnFile('backend-codex-app.ts');
    const turnStart = codexAppSrc.indexOf('const runCodexAppTurn = async (');
    assert.ok(turnStart > 0, 'the codex-app turn must exist');
    const turnBlock = codexAppSrc.slice(turnStart, turnStart + 14_000);

    assert.doesNotMatch(turnBlock, /idleTimer|absoluteTimer/, 'no hand-rolled turn timer may survive');
    assert.match(turnBlock, /attachWatchdog\(/, 'the turn uses the shared watchdog');
    assert.match(turnBlock, /ctx\.stallReason = reason/, 'and records the reason the notice depends on');

    const parses = spawnSrc.match(/\(settings as Record<string, unknown>\)\[['"]agentTimeout['"]\]/g) ?? [];
    assert.equal(parses.length, 1, `agentTimeout must be read in exactly one place, found ${parses.length}`);
});
