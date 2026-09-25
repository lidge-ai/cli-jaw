import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSource } from './source-normalize.js';
import { readSpawnAgentSource } from '../helpers/spawn-source.mts';

const ROOT = process.cwd();
const PIPELINE = path.join(ROOT, 'src/orchestrator/pipeline.ts');
const DISTRIBUTE = path.join(ROOT, 'src/orchestrator/distribute.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');
const DB = path.join(ROOT, 'src/core/db.ts');

test('P100-001: pipeline uses employeeSessionId-based resume and global clear', () => {
    const src = readSource(PIPELINE, 'utf8') + '\n' + readSource(DISTRIBUTE, 'utf8');
    const dbSrc = readSource(DB, 'utf8');
    assert.match(src, /\.\.\.\(canResume\s*\?\s*\{\s*employeeSessionId:\s*empSessionId[\s\S]*?\}\s*:\s*\{\}\)/);
    assert.match(src, /clearAllEmployeeSessions\.run\(\)/);
    assert.match(src, /isSessionPersistingCli/);
    assert.match(src, /empSession\?\.cli\s*===\s*emp\.cli/);
    assert.match(src, /empSession\?\.model/);
    assert.match(src, /upsertEmployeeSession\.run\(empId,\s*r\.sessionId,\s*emp\.cli,\s*employeeModel(?:,\s*\w+)?\)/);
    assert.match(dbSrc, /model\s+TEXT DEFAULT ''/);
});

test('P100-002: spawn guards main session update when employee session is used', () => {
    const src = readSpawnAgentSource({ normalized: true });
    assert.match(src, /const\s+empSid\s*=\s*opts\._skipResume\s*\?\s*null\s*:\s*\(opts\.employeeSessionId\s*\|\|\s*null\)/);
    assert.match(src, /const\s+mainManaged\s*=\s*!forceNew\s*&&\s*!opts\.agentId\s*&&\s*!empSid\s*&&\s*!opts\.internal/);
    assert.match(src, /employeeSessionId:\s*empSid/);
    assert.match(src, /persistMainSession\(\{/);
});

test('P100-003: db exports global employee session clear statement', () => {
    const src = readSource(DB, 'utf8');
    assert.match(src, /export\s+const\s+clearAllEmployeeSessions\s*=\s*db\.prepare\('DELETE FROM employee_sessions'\)/);
});
