import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dedupKey } from '../../src/orchestrator/gateway.ts';
import { slackBlockActionEvent } from '../../src/slack/events.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const gatewaySrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');

test('distinct clicks carry action_ts into the real gateway dedup key', () => {
    const click = (actionTs: string) => slackBlockActionEvent({
        type: 'block_actions', team: { id: 'T1' }, user: { id: 'UCEO' }, channel: { id: 'C1' },
        container: { type: 'message', channel_id: 'C1', message_ts: '1700.1' },
        message: { ts: '1700.1', user: 'UBOT', bot_id: 'BBOT' },
        actions: [{ action_id: 'agent:approve', action_ts: actionTs, value: 'yes' }],
    }, 'T1', { userId: 'UBOT', botId: 'BBOT', appId: null });
    const first = click('1730000000.123456')!;
    const second = click('1730000000.123457')!;
    assert.notEqual(dedupKey('scope', 'slack', first.text!, 'C1', first.thread_ts),
        dedupKey('scope', 'slack', second.text!, 'C1', second.thread_ts));
    assert.match(first.text!, /action_ts: "1730000000\.123456"/);
    assert.match(second.text!, /action_ts: "1730000000\.123457"/);
});

// ─── SM-001: empty text → rejected/empty ───

test('SM-001: empty text returns rejected/empty', () => {
    assert.ok(
        gatewaySrc.includes("if (!trimmed) return { action: 'rejected', reason: 'empty' }"),
        'should reject empty input',
    );
});

// ─── SM-002: idle + normal → started ───

test('SM-002: idle + normal message calls insertMessage and orchestrate', () => {
    // The idle path should insert, broadcast, orchestrate, and return started
    const idlePath = gatewaySrc.slice(gatewaySrc.indexOf('// ── idle'));
    assert.ok(idlePath.includes("insertMessage.run('user'"), 'idle path inserts message');
    assert.ok(idlePath.includes("broadcast('new_message'"), 'idle path broadcasts');
    assert.ok(idlePath.includes('orchestrate(trimmed'), 'idle path calls orchestrate');
    assert.ok(idlePath.includes("action: 'started'"), 'idle returns started');
});

// ─── SM-003: busy + normal → queued (NO insertMessage) ───

test('SM-003: busy path enqueues only, does NOT call insertMessage', () => {
    // Extract the busy block
    const busyStart = gatewaySrc.indexOf('// ── busy');
    const busyEnd = gatewaySrc.indexOf('// ── idle');
    const busyBlock = gatewaySrc.slice(busyStart, busyEnd);

    assert.ok(busyBlock.includes('enqueueMessage(trimmed'), 'busy path enqueues');
    assert.ok(
        !busyBlock.includes("insertMessage.run("),
        'busy path must NOT call insertMessage (processQueue handles it)',
    );
    assert.ok(busyBlock.includes("action: 'queued'"), 'busy returns queued');
    assert.ok(busyBlock.includes('pending: messageQueue.length'), 'queued includes pending count');
});

// ─── SM-004: continue intent idle → no pending continue ───

test('SM-004: continue intent when idle → noPendingContinue + orchestrateContinue', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(continueBlock.includes('isContinueIntent(trimmed)'), 'checks continue intent');
    assert.ok(continueBlock.includes('orchestrateContinue('), 'calls orchestrateContinue');
    assert.ok(continueBlock.includes("action: 'started'"), 'returns started');
    assert.ok(continueBlock.includes('noPendingContinue: true'), 'idle continue returns no-pending contract');
    assert.ok(!continueBlock.includes('continued: true'), 'idle continue must not trigger worklog continue UI copy');
});

// ─── SM-005: continue intent busy → rejected/busy ───

test('SM-005: continue intent when busy → rejected/busy', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(
        /if \(isAgentBusy\(scope\)\) \{/.test(continueBlock)
        && /action: 'rejected', reason: 'busy'/.test(continueBlock),
        'continue intent rejects when busy (429 retry-aware)',
    );
    // The rejection must also settle its own admitted requestId, or the entry
    // leaks and the caller never hears back (#276 settle contract).
    assert.ok(
        /settleOnce\(requestId, 'dropped', \{ reason: 'busy' \}\)/.test(continueBlock),
        'a busy rejection must settle the request it already admitted',
    );
});

// ─── SM-006: reset intent idle → started ───

test('SM-006: reset intent when idle → started + orchestrateReset', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(resetBlock.includes('isResetIntent(trimmed)'), 'checks reset intent');
    assert.ok(resetBlock.includes('orchestrateReset('), 'calls orchestrateReset');
    assert.ok(resetBlock.includes("action: 'started'"), 'returns started');
});

// ─── SM-007: reset intent bypasses busy rejection ───

test('SM-007: reset intent when busy still starts reset flow', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(
        !/if\s*\(isAgentBusy\s*\(\s*\)\)\s*return/.test(resetBlock),
        'reset intent should bypass busy rejection so reset remains available during retries',
    );
    assert.ok(resetBlock.includes('orchestrateReset('), 'reset path still calls orchestrateReset');
    assert.ok(resetBlock.includes("action: 'started'"), 'reset path still returns started');
});

// ─── SM-008: displayText is used for insertMessage and broadcast ───

test('SM-008: displayText is used for insert and broadcast when provided', () => {
    assert.ok(
        gatewaySrc.includes('const display = meta.displayText || trimmed'),
        'display falls back to trimmed',
    );
    // All insertMessage and broadcast calls use display
    const insertCalls = gatewaySrc.match(/insertMessage\.run\('user', display/g);
    assert.ok(insertCalls && insertCalls.length >= 3, 'all insert calls use display variable');
});

// ─── SM-009: SubmitResult type has pending field ───

test('SM-009: SubmitResult type includes pending field', () => {
    assert.ok(gatewaySrc.includes('pending?: number'), 'SubmitResult has pending field');
});

// ─── SM-010: origin is passed through to broadcast ───

test('SM-010: origin from meta is used in broadcast and orchestrate', () => {
    assert.ok(
        gatewaySrc.includes('source: meta.origin'),
        'broadcast uses meta.origin as source',
    );
    assert.ok(
        gatewaySrc.includes('origin: meta.origin'),
        'orchestrate receives meta.origin',
    );
});

test('SM-011: detached orchestration calls are rejection-safe', () => {
    assert.ok(
        gatewaySrc.includes('function runDetached('),
        'gateway should wrap detached orchestrate calls',
    );
    assert.ok(
        gatewaySrc.includes('.catch((err: unknown) =>'),
        'detached orchestrate calls should handle rejections',
    );
});

test('SM-012: admission and continue busy checks use the resolved scope', () => {
    const continueBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── continue'), gatewaySrc.indexOf('// ── reset'));
    const busyBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── busy'), gatewaySrc.indexOf('// ── idle'));
    assert.ok(continueBlock.includes('isAgentBusy(scope)'));
    assert.ok(busyBlock.includes('isAgentBusy(scope)'));
    assert.ok(busyBlock.includes('hasBlockingWorkers(scope)'));
    assert.doesNotMatch(gatewaySrc, /isAgentBusy\s*\(\s*\)/);
});

test('SM-013: continue, reset, and idle starts all enter the captured session lane', () => {
    const starts = gatewaySrc.match(/sessionLanes\.run\(scope,/g) || [];
    assert.equal(starts.length, 3, 'continue/reset/idle must each use sessionLanes.run(scope, ...)');
    assert.ok(gatewaySrc.includes('chatSessionId'));
    assert.ok(gatewaySrc.includes('withSessionScope(sessionScope'));
});

test('SM-014: dedup admission happens only after persistent scope resolution', () => {
    const scopeResolved = gatewaySrc.indexOf('const sessionScope: SessionScope = { scope, chatSessionId }');
    const dedupAdmission = gatewaySrc.indexOf('const key = dedupKey(scope,');
    assert.ok(scopeResolved >= 0 && dedupAdmission > scopeResolved);
});

test('SM-015: mid-run policy precedence is request, session, then global default', () => {
    const resolver = gatewaySrc.slice(
        gatewaySrc.indexOf('function resolveMidRunPolicy'),
        gatewaySrc.indexOf('function applyMidRunPolicy'),
    );
    const requestIdx = resolver.indexOf('meta.midRunPolicy');
    const sessionIdx = resolver.indexOf('getSessionRunPolicy(chatSessionId)');
    const globalIdx = resolver.indexOf('settings["multiSession"]?.midRunPolicy');
    assert.ok(requestIdx >= 0 && sessionIdx > requestIdx && globalIdx > sessionIdx);
});

// SM-016 is executed in steer-input-handoff.test.ts: actual gateway delegation,
// forbidden capability/kill seams, new-run without queue, and real fallback enqueue.

test('SM-017: collect and interrupt remain scoped queue operations', () => {
    const policy = gatewaySrc.slice(
        gatewaySrc.indexOf('function applyMidRunPolicy'),
        gatewaySrc.indexOf('// ── 5s dedup window'),
    );
    assert.ok(policy.includes("if (policy === 'collect') return queue({ collect: true })"));
    assert.ok(policy.includes("killActiveAgent(ctx.scopeKey, 'interrupt')"));
    assert.ok(policy.includes("purgeQueueOnStop(ctx.scopeKey, 'interrupt')"));
    assert.ok(policy.includes('return queue({ front: true })'));
});

test('SM-018: all four started paths declare their internal disposition', () => {
    const startedReturns = gatewaySrc.match(/return \{ action: 'started'[^;]+;/g) || [];
    assert.equal(startedReturns.length, 4);
    assert.equal(startedReturns.filter(line => line.includes("disposition: 'new_run'")).length, 3);
    assert.equal(startedReturns.filter(line => line.includes("disposition: 'steered'")).length, 1);
});

test('SM-019: collect and interrupt remain queued without disposition', () => {
    const policy = gatewaySrc.slice(
        gatewaySrc.indexOf('function applyMidRunPolicy'),
        gatewaySrc.indexOf('// ── 5s dedup window'),
    );
    assert.ok(policy.includes("if (policy === 'collect') return queue({ collect: true })"));
    assert.ok(policy.includes('return queue({ front: true })'));
    const queueReturn = policy.match(/return \{ action: 'queued'[^;]+;/)?.[0] || '';
    assert.ok(queueReturn);
    assert.doesNotMatch(queueReturn, /disposition/);
});

test('SM-020: a steer policy queues input from another remote conversation', () => {
    const policy = gatewaySrc.slice(
        gatewaySrc.indexOf('function applyMidRunPolicy'),
        gatewaySrc.indexOf('// ── 5s dedup window'),
    );
    const steer = policy.slice(policy.indexOf("if (policy === 'steer')"));
    const guard = steer.indexOf('sameRunConversation(');
    const dispatch = steer.indexOf('steerAgent(');
    assert.ok(guard >= 0 && dispatch > guard,
        'cross-conversation guard must run before any steer input is dispatched');
    assert.match(steer.slice(guard, dispatch), /return queue\(\)/);
});
