import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

test('alert escalation refuses last-active by pairing configured dest with the opt-out', () => {
    const src = fs.readFileSync(join(import.meta.dirname, '../../src/agent/alert-escalation.ts'), 'utf8');
    assert.match(src, /preferConfiguredTarget:\s*true/);
    assert.match(src, /allowActiveFallback:\s*false/);
});
