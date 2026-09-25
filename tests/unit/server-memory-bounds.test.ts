import assert from 'node:assert/strict';
import test from 'node:test';

import { readSpawnAgentSource } from '../helpers/spawn-source.mts';
import {
    appendBoundedFullText,
    FULLTEXT_MAX_CHARS,
} from '../../src/agent/events/fulltext-bound.js';

/**
 * 260803 unit, 030 phase — server memory bounds.
 *
 * D3 is the risky one: `ctx.fullText` is read in full by goal control-flow
 * regexes and session-id extraction, so the bound must be high enough not to
 * clip real answers and must report truncation rather than silently shorten.
 */

test('D3: normal-sized output is appended unchanged and never marked truncated', () => {
    const first = appendBoundedFullText('', 'hello ');
    assert.equal(first.text, 'hello ');
    assert.equal(first.truncated, false);

    const second = appendBoundedFullText(first.text, 'world');
    assert.equal(second.text, 'hello world');
    assert.equal(second.truncated, false);
});

test('D3: the bound matches the agy path, so real answers are never clipped', () => {
    // 8 MiB. Chosen to match AGY_FULLTEXT_MAX_CHARS, NOT the 200k live-run
    // mirror — clipping at 200k would break trailing goal markers.
    assert.equal(FULLTEXT_MAX_CHARS, 8_388_608);

    // A generous real answer stays whole.
    const big = 'x'.repeat(1_000_000);
    const result = appendBoundedFullText('', big);
    assert.equal(result.truncated, false);
    assert.equal(result.text.length, 1_000_000);
});

test('D3: output past the bound is clipped exactly and reports truncation', () => {
    const nearlyFull = 'a'.repeat(FULLTEXT_MAX_CHARS - 10);
    const result = appendBoundedFullText(nearlyFull, 'b'.repeat(100));

    assert.equal(result.truncated, true, 'caller must be able to note the elision');
    assert.equal(result.text.length, FULLTEXT_MAX_CHARS, 'must stop exactly at the bound');
    assert.ok(result.text.endsWith('b'.repeat(10)), 'the retained head is contiguous');
});

test('D3: appending to an already-full buffer is a no-op, not unbounded growth', () => {
    const full = 'a'.repeat(FULLTEXT_MAX_CHARS);
    const result = appendBoundedFullText(full, 'more text');

    assert.equal(result.text.length, FULLTEXT_MAX_CHARS);
    assert.equal(result.truncated, true);
    // Repeated appends must not grow the string at all.
    let acc = full;
    for (let i = 0; i < 100; i += 1) acc = appendBoundedFullText(acc, 'xxxx').text;
    assert.equal(acc.length, FULLTEXT_MAX_CHARS);
});

test('D3: empty segments are harmless', () => {
    const result = appendBoundedFullText('abc', '');
    assert.equal(result.text, 'abc');
    assert.equal(result.truncated, false);
});

test('D3: a missing base is treated as empty rather than throwing on a hot path', () => {
    // Contexts can reach the append helper before fullText is initialized.
    const result = appendBoundedFullText(undefined as unknown as string, 'hello');
    assert.equal(result.text, 'hello');
    assert.equal(result.truncated, false);
});

test('D3: liveOutputText is bounded too, since it is promoted into fullText at close', async () => {
    // The bound is worthless if the streaming mirror grows unchecked and then
    // replaces fullText wholesale — that just relocates the same spike.
    const helpers = await import('node:fs/promises');
    const source = await helpers.readFile(
        new URL('../../src/agent/events/helpers.ts', import.meta.url),
        'utf8',
    );
    assert.ok(
        source.includes('appendBoundedFullText(ctx.liveOutputText'),
        'the liveOutputText branch must route through the same bound as fullText',
    );

    // The Pi streaming path lives in src/agent/spawn/backend-pi.ts; read spawnAgent's
    // whole source (spawn.ts plus its backend modules).
    const spawnSource = readSpawnAgentSource();
    assert.ok(
        spawnSource.includes('appendBoundedFullText(ctx.liveOutputText'),
        'the pi streaming path must bound liveOutputText as well',
    );
});

test('D2: a duplicate-registration kill records a reason and escalates', async () => {
    const { readFile } = await import('node:fs/promises');
    // The dup kill is in spawn.ts; the backend exit handlers moved to spawn/backend-*.ts.
    const source = readSpawnAgentSource();

    // Without a recorded reason the stale exit handler misreads an intentional
    // kill as a genuine agent error and deletes the replacement's map entry.
    assert.ok(
        source.includes('killReasons.set(prevPid, DUP_REGISTRATION_KILL_REASON)'),
        'the dup kill must record a kill reason',
    );
    // Retargeted in #681: the six exit handlers no longer each compare the reason
    // themselves — they delegate to isLifecycleSteerReason, which is where the
    // dup-kill-is-a-steer invariant now lives. The invariant is unchanged; the
    // assertion follows it to its single owner.
    const killReasonSrc = await readFile(new URL('../../src/agent/spawn/kill-reason.ts', import.meta.url), 'utf8');
    assert.ok(
        killReasonSrc.includes('reason === DUP_REGISTRATION_KILL_REASON'),
        'the exit handler must treat a dup kill like a steer so it does not evict the new child',
    );
    assert.ok(
        source.includes('isLifecycleSteerReason(killReason)'),
        'the exit handlers must classify through that shared helper',
    );
    // Escalation is now handled by OwnedProcess: it walks the tree, schedules
    // a grace period, and re-checks the original child before SIGKILL — so a
    // PID recycled during the grace is never signalled. The behavioral test
    // for that guarantee lives in owned-process.test.ts and
    // kill-escalation-liveness.test.ts; here we verify the delegation pattern.
    assert.ok(
        source.includes("ownProcess(prev,"),
        'the dup kill must delegate to OwnedProcess for liveness-guarded escalation',
    );
    assert.ok(
        source.includes(".terminate('duplicate-registration')"),
        'the dup kill must record its reason through the owner',
    );
});
