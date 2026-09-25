import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSrc(rel: string): string {
    return fs.readFileSync(join(__dirname, rel), 'utf8');
}

test('spawn.ts imports smoke-detector helpers', () => {
    const src = readSpawnAgentSource({ normalized: true });
    const lifecycleSrc = readSrc('../../src/agent/lifecycle-handler.ts');
    assert.ok(src.includes("from './smoke-detector.js'"));
    assert.ok(src.includes('detectSmokeResponse'));
    assert.ok(lifecycleSrc.includes("from './smoke-detector.js'"));
    assert.ok(lifecycleSrc.includes('buildContinuationPrompt'));
});

test('smoke detection runs before exit handler delegation in both spawn paths', () => {
    const src = readSpawnAgentSource({ normalized: true });
    const stdExit = src.slice(src.indexOf("child.on('close'"));
    const acpExit = src.slice(src.indexOf("acp.on('exit'"));

    // In spawn.ts, detectSmokeResponse is called before handleAgentExit (which contains retry logic)
    const stdSmokeIdx = stdExit.indexOf('detectSmokeResponse');
    const stdHandleIdx = stdExit.indexOf('handleAgentExit');
    assert.ok(stdSmokeIdx > 0 && stdHandleIdx > 0 && stdSmokeIdx < stdHandleIdx,
        'Standard: detectSmokeResponse must come before handleAgentExit');

    const acpSmokeIdx = acpExit.indexOf('detectSmokeResponse');
    const acpHandleIdx = acpExit.indexOf('handleAgentExit');
    assert.ok(acpSmokeIdx > 0 && acpHandleIdx > 0 && acpSmokeIdx < acpHandleIdx,
        'ACP: detectSmokeResponse must come before handleAgentExit');
});

test('smoke continuation keeps main-managed path and emits smoke event', () => {
    const src = readSrc('../../src/agent/lifecycle-handler.ts');
    const smokeSection = src.slice(
        src.indexOf('_isSmokeContinuation: true'),
        src.indexOf('_isSmokeContinuation: true') + 320,
    );
    assert.ok(!smokeSection.includes('forceNew: true'));
    assert.ok(src.includes("'agent_smoke'"));
});

test('frontend and telegram consumers handle agent_smoke', () => {
    assert.ok(readSrc('../../public/js/ws.ts').includes('agent_smoke'));
    assert.ok(readSrc('../../src/telegram/bot.ts').includes('agent_smoke'));
});
