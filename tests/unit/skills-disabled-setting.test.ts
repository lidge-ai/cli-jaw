import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(join(root, 'lib', 'mcp', 'skills-distribution.ts'), 'utf8');

test('SKD-001: settings.skills.disabled suppresses auto-activation', () => {
    assert.match(source, /function disabledSkillIds\(\)/, 'the disabled-skill reader must exist');
    assert.match(source, /if \(disabledSkills\.has\(id\)\) continue;/, 'auto-activation must skip disabled ids');
});

test('SKD-002: a disabled skill already in skills/ is removed, not left behind', () => {
    assert.match(source, /disabled by settings, removed from active/, 'the prune pass must report what it removed');
});
