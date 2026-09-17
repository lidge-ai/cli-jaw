import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(join(root, 'bin', 'commands', 'service.ts'), 'utf8');

test('SVC-PORT-001: service install defaults to the port of the home it installs', () => {
    assert.match(source, /const homePort = \(\(\) => \{/, 'the installed home must supply the default port');
    assert.match(source, /port: \{ type: 'string', default: homePort \}/, 'parseArgs must use that default');
    assert.doesNotMatch(source, /port: \{ type: 'string', default: '3457' \}/, 'a hardcoded 3457 default collides with the main instance');
});
