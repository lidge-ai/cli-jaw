import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOutputPolicy, loadPolicyHooksConfig, runBeforeSpawnChecks } from '../../src/core/policy-hooks.js';

function home(config?: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-policy-'));
    if (config !== undefined) fs.writeFileSync(path.join(dir, 'policy-hooks.json'), JSON.stringify(config));
    return dir;
}

test('missing config and kill switch preserve output byte-for-byte', () => {
    const text = 'exact\noutput';
    assert.deepEqual(applyOutputPolicy(text, { scope: 'main' }, { jawHome: home() }), { text, verdicts: [] });
    const jawHome = home({ output: { rules: [{ id: 'x', action: 'block', pattern: 'exact' }] } });
    assert.deepEqual(applyOutputPolicy(text, { scope: 'main' }, { jawHome, env: { CLI_JAW_POLICY_HOOKS: '0' } }), { text, verdicts: [] });
    assert.equal(loadPolicyHooksConfig({ jawHome, env: { CLI_JAW_POLICY_HOOKS: '0' } }), null);
});

test('redact and block rules transform bounded output', () => {
    const jawHome = home({ output: { rules: [
        { id: 'secret', action: 'redact', pattern: 'TOKEN-[0-9]+', replacement: '[hidden]' },
        { id: 'stop', action: 'block', pattern: 'forbidden' },
    ] } });
    assert.equal(applyOutputPolicy('TOKEN-42 ok', { scope: 'main' }, { jawHome }).text, '[hidden] ok');
    assert.equal(applyOutputPolicy('forbidden payload', { scope: 'main' }, { jawHome }).text, '[policy] output blocked by rule stop');
});

test('invalid regex is skipped while later rules still apply', () => {
    const jawHome = home({ output: { rules: [
        { id: 'bad', action: 'redact', pattern: '[' },
        { id: 'good', action: 'redact', pattern: 'secret' },
    ] } });
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        assert.equal(applyOutputPolicy('secret', { scope: 'main' }, { jawHome }).text, '[redacted]');
    } finally { console.warn = original; }
    assert.ok(warnings.some(args => String(args.join(' ')).includes('invalid regex bad')));
});

test('beforeSpawn warns above size threshold and stays quiet below', () => {
    const jawHome = home({ beforeSpawn: { promptSizeWarnChars: 10 } });
    assert.equal(runBeforeSpawnChecks({ cli: 'codex', promptChars: 11, prompt: '12345678901' }, { jawHome }).length, 1);
    assert.deepEqual(runBeforeSpawnChecks({ cli: 'codex', promptChars: 10, prompt: '1234567890' }, { jawHome }), []);
});

test('output rules fire only in their configured scope', () => {
    const jawHome = home({ output: { rules: [
        { id: 'heartbeat-only', action: 'redact', pattern: 'secret', scopes: ['heartbeat'], replacement: '[hb]' },
    ] } });
    assert.equal(applyOutputPolicy('secret', { scope: 'main' }, { jawHome }).text, 'secret');
    assert.equal(applyOutputPolicy('secret', { scope: 'heartbeat' }, { jawHome }).text, '[hb]');
});

test('policy wiring: pending reminder prepends before heartbeat anchor assembly', () => {
    // Wiring assertion plus flag lifecycle tests is the accepted activation bar for pipeline injection.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/orchestrator/pipeline.ts'), 'utf8');
    const reminder = src.indexOf('const policyReminder = consumePendingReminder()');
    const anchor = src.indexOf('const anchor = getLatestUnconsumedAnchor.get', reminder);
    assert.ok(reminder >= 0 && anchor > reminder);
    assert.ok(src.slice(reminder, anchor).includes('prompt = `${policyReminder}\\n\\n${prompt}`'));
});

test('policy wiring: lifecycle policy and flag evaluation precede durable insert', () => {
    // Wiring assertion plus output/flag primitive tests is the accepted activation bar for seam A.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agent/lifecycle-handler.ts'), 'utf8');
    const policy = src.indexOf("applyOutputPolicy(finalContent, { scope: 'main' })");
    const flags = src.indexOf('evaluateRecordPending(ctx.toolLog, finalContent)', policy);
    const insert = src.indexOf('insertMessageWithTraceRun.run(', flags);
    assert.ok(policy >= 0 && flags > policy && insert > flags);
});

test('policy wiring: heartbeat redacts before quiet gate and anchor persistence', () => {
    // Wiring assertion plus policy and quiet-helper tests is the accepted activation bar for heartbeat seams.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/memory/heartbeat.ts'), 'utf8');
    const policy = src.indexOf("applyOutputPolicy(rawResult, { scope: 'heartbeat'");
    const quiet = src.indexOf('isHeartbeatQuietOutput(result, extraQuietMarkers)', policy);
    const anchor = src.indexOf('insertHeartbeatAnchor.run(', quiet);
    assert.ok(policy >= 0 && quiet > policy && anchor > quiet);
    // The server-owned pre-send validator may replace `formatted` with repaired
    // text immediately before the transport call.
    const between = src.slice(quiet, anchor);
    assert.ok(between.includes('sendChannelOutput'));
    assert.ok(between.includes('text: checked.text') || between.includes('text: formatted'));
    assert.ok(between.includes('runSlackPreSendHook'));
    assert.ok(between.indexOf('parseHeartbeatReport(result)') < between.indexOf('sendChannelOutput'));
});
