import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const version = '9.9.9-registry-fixture';
const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const match = /      - name: Registry smoke\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name: )/.exec(workflow);
assert.ok(match, 'the real workflow must contain a Registry smoke shell step');
const script = match[1]!.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
    .replaceAll('${{ steps.release.outputs.version }}', version);
assert.ok(!script.includes('${{'), 'all workflow expressions in the executed step must be resolved');

async function smoke(mode: 'ready' | 'wrong' | 'never', readyAfter: number) {
    const directory = await mkdtemp(join(tmpdir(), 'jaw-registry-smoke-'));
    const state = join(directory, 'count');
    const calls = join(directory, 'calls');
    try {
        await writeFile(state, '0');
        await writeFile(calls, '');
        await writeFile(join(directory, 'npm'), `#!/bin/sh
set -eu
case "$1" in
  view)
    count=$(cat "$STATE_FILE")
    count=$((count + 1))
    printf '%s' "$count" > "$STATE_FILE"
    if [ "$SMOKE_MODE" = wrong ]; then
      printf '%s\\n' '0.0.0-wrong'
      exit 0
    fi
    if [ "$SMOKE_MODE" = ready ] && [ "$count" -ge "$READY_AFTER" ]; then
      printf '%s\\n' "$EXPECTED_VERSION"
      exit 0
    fi
    printf 'npm error 404 cli-jaw@%s unavailable\\n' "$EXPECTED_VERSION" >&2
    exit 1
    ;;
  dist-tag)
    printf 'dist-tag\\n' >> "$CALL_FILE"
    exit 0
    ;;
  publish)
    printf 'publish\\n' >> "$CALL_FILE"
    exit 93
    ;;
  *) exit 94 ;;
esac
`, { mode: 0o755 });
        await writeFile(join(directory, 'sleep'), '#!/bin/sh\n[ "$1" = 10 ] || exit 95\n', { mode: 0o755 });
        const result = spawnSync('bash', ['-c', script], {
            cwd: directory,
            env: { ...process.env, PATH: `${directory}${delimiter}${process.env['PATH'] || '/usr/bin:/bin'}`,
                STATE_FILE: state, CALL_FILE: calls, SMOKE_MODE: mode,
                READY_AFTER: String(readyAfter), EXPECTED_VERSION: version },
            encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.error, undefined, 'the workflow shell must execute and terminate');
        return { status: result.status, stdout: result.stdout, stderr: result.stderr,
            attempts: Number(await readFile(state, 'utf8')), calls: await readFile(calls, 'utf8') };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// The workflow step runs in Bash on Linux; this harness also executes on macOS.
const bashHost = { skip: process.platform === 'win32' };
test('registry smoke accepts exact visibility after the old thirty-attempt window', bashHost, async () => {
    const result = await smoke('ready', 31);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.attempts, 31);
    assert.equal(result.calls, 'dist-tag\n');
});

test('registry smoke rejects a successful lookup returning a different version', bashHost, async () => {
    const result = await smoke('wrong', 1);
    assert.notEqual(result.status, 0);
    assert.equal(result.attempts, 1);
    assert.equal(result.calls, '');
});

test('registry smoke fails after ninety missing-version attempts without publishing', bashHost, async () => {
    const result = await smoke('never', 999);
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 90);
    assert.match(result.stdout, /registry smoke failed/);
    assert.equal(result.calls, '');
});
