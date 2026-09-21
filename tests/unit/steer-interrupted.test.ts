import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    EXPLICIT_USER_STOP_KILL_REASON,
    isLifecycleExitSettleReason,
    isLifecycleSteerReason,
    STEER_KILL_REASON,
    INTERRUPT_KILL_REASON,
    DUP_REGISTRATION_KILL_REASON,
} from '../../src/agent/spawn/kill-reason.ts';
import { shouldAnnounceStallTruncation } from '../../src/agent/error-classifier.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

// ─── SI-001: killReasons Map and consumeKillReason exist ───

test('SI-001: killActiveAgent sets killReason to the given reason', () => {
    assert.ok(
        spawnSrc.includes('const killReasons = new Map'),
        'killReasons Map should be declared',
    );
    assert.ok(
        spawnSrc.includes('killReasons.set('),
        'killActiveAgent should set reason in killReasons Map',
    );
});

test('SI-002: killActiveAgent defaults reason to "user"', () => {
    assert.ok(
        /export function killActiveAgent\(scopeKeyOrReason\s*=\s*['"]user['"],\s*scopedReason\?:\s*string\)/.test(spawnSrc)
            && spawnSrc.includes('const reason = scopedReason ?? scopeKeyOrReason'),
        'killActiveAgent default reason should be "user"',
    );
});

// ─── SI-003: the lifecycle steer class, stated once ───
//
// These replace six source-grep assertions that pinned the literal `'steer'` inside
// each runtime's exit handler. Those greps did not describe a behaviour, and they
// actively froze the bug in #681: an adapter that accepted only `'steer'` satisfied
// them, so the incomplete classification passed review for months.

test('SI-003: lifecycle control keeps explicit Stop in the intentional-stop class', () => {
    for (const reason of [
        STEER_KILL_REASON,
        INTERRUPT_KILL_REASON,
        EXPLICIT_USER_STOP_KILL_REASON,
        DUP_REGISTRATION_KILL_REASON,
    ]) {
        assert.equal(isLifecycleSteerReason(reason), true, `${reason} is an intentional stop`);
    }
    for (const reason of [STEER_KILL_REASON, INTERRUPT_KILL_REASON, EXPLICIT_USER_STOP_KILL_REASON]) {
        assert.equal(isLifecycleExitSettleReason(reason), true, `${reason} arms exit settlement`);
    }
    assert.equal(isLifecycleExitSettleReason(DUP_REGISTRATION_KILL_REASON), false);
});

test('SI-004: isLifecycleSteerReason rejects failures, shutdowns and absent reasons', () => {
    // 'agy-complete' matters most: a quiet-output completion is a normal finish, and
    // classifying it as a steer would suppress the answer the run just produced.
    for (const reason of ['user', 'api', 'shutdown', 'planned-restart', 'agy-complete', '', null, undefined]) {
        assert.equal(isLifecycleSteerReason(reason), false, `${String(reason)} is not an intentional stop`);
    }
});

test('SI-005: every intentional stop suppresses the stall truncation notice', () => {
    // wasSteer is what tells the reader "you stopped this", so a runtime that
    // misclassifies an interrupt would also apologise for a timeout that never
    // happened (#405).
    for (const reason of [
        STEER_KILL_REASON,
        INTERRUPT_KILL_REASON,
        EXPLICIT_USER_STOP_KILL_REASON,
        DUP_REGISTRATION_KILL_REASON,
    ]) {
        assert.equal(
            shouldAnnounceStallTruncation({
                stallReason: 'idle 90s', wasSteer: isLifecycleSteerReason(reason),
                mainManaged: true, internal: false,
            }),
            false,
            `${reason} must not produce a timeout notice`,
        );
    }
    assert.equal(
        shouldAnnounceStallTruncation({
            stallReason: 'idle 90s', wasSteer: isLifecycleSteerReason('user'),
            mainManaged: true, internal: false,
        }),
        true,
        'a real stall still announces truncation',
    );
});

test('SI-006: no runtime exit path re-derives the steer class from a literal', () => {
    // The one assertion here that still reads source, and deliberately negative: it
    // cannot be satisfied by a comment and it pins no string that must exist. It only
    // says that the seven exit handlers delegate instead of each keeping their own set.
    const literalClassification = /wasSteer(?::|\s*=)\s*[^;\n]*===\s*['"]/g;
    const offenders = spawnSrc.match(literalClassification) ?? [];
    assert.deepEqual(
        offenders, [],
        `every wasSteer must come from isLifecycleSteerReason; found: ${offenders.join(' | ')}`,
    );
    const helperUses = spawnSrc.match(/wasSteer(?::|\s*=)\s*isLifecycleSteerReason\(/g) ?? [];
    assert.equal(helperUses.length, 6, 'all six spawn.ts exit paths classify through the helper');
});

// ─── SI-007: killReason is consumed after exit ───

test('SI-007: killReason is consumed (set to null) after mainManaged exit', () => {
    assert.ok(
        spawnSrc.includes('consumeKillReason('),
        'consumeKillReason should be called in exit handlers',
    );
    // Both ACP and CLI paths should consume
    const acpConsume = spawnSrc.includes('acpKillReason = consumeKillReason') || spawnSrc.includes('consumeKillReason(acp');
    const stdConsume = spawnSrc.includes('stdKillReason = consumeKillReason') || spawnSrc.includes('consumeKillReason(child');
    assert.ok(acpConsume, 'ACP exit should consume kill reason');
    assert.ok(stdConsume, 'CLI exit should consume kill reason');
});

// ─── Structural: the salvage prefix is emitted once, by the shared handler ───

test('SI-STRUCT: the interrupted prefix lives in lifecycle-handler, not per adapter', () => {
    // Previously each adapter block was required to contain its own copy of the
    // prefix logic. It never did: the matches were the explanatory comments. The
    // real emitter is shared, which is why one classifier is enough.
    const lifecycleSrc = fs.readFileSync(join(__dirname, '../../src/agent/lifecycle-handler.ts'), 'utf8');
    assert.ok(
        lifecycleSrc.includes('wasSteer && mainManaged && !opts.internal'),
        'the shared exit handler gates the salvage prefix on wasSteer',
    );
    assert.ok(lifecycleSrc.includes('⏹️ [interrupted]'), 'the shared exit handler owns the prefix');
});

// ─── steerAgent exports and flow ───

test('steerAgent calls killActiveAgent with "steer" reason', () => {
    const steerFnMatch = spawnSrc.match(/export async function steerAgent[\s\S]*?^}/m);
    assert.ok(steerFnMatch, 'steerAgent function should exist');
    const steerBody = steerFnMatch[0];
    assert.ok(
        steerBody.includes("killActiveAgent(scopeKey, 'steer')"),
        'steerAgent should call killActiveAgent for its scope with "steer" reason',
    );
    assert.ok(
        steerBody.includes('waitForMainProcessEnd'),
        'steerAgent should wait for process end after kill',
    );
});

test('steerAgent inserts user message and broadcasts before orchestrating', () => {
    const steerFnMatch = spawnSrc.match(/export async function steerAgent[\s\S]*?^}/m);
    assert.ok(steerFnMatch, 'steerAgent function should exist');
    const steerBody = steerFnMatch[0];

    assert.ok(
        steerBody.includes('insertMessage.run'),
        'steerAgent should insert the new prompt as user message',
    );
    assert.ok(
        steerBody.includes("broadcast('new_message'"),
        'steerAgent should broadcast new_message',
    );
});

// ─── buildHistoryBlock uses trace for assistant messages ───

test('buildHistoryBlock prefers trace over content for assistant messages', () => {
    assert.ok(
        spawnSrc.includes("role === 'assistant' && row.trace"),
        'buildHistoryBlock should check for trace on assistant messages',
    );
});
