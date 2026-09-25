import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';

import {
    maybePromptGithubStar,
    starPromptStatePath,
    starRepo,
    isGhInstalled,
} from '../../bin/star-prompt.js';
import { interactiveConfirm } from '../../bin/interactive-confirm.js';
import { isAgentDriven } from '../../bin/agent-driven.js';
import { PassThrough } from 'node:stream';

test('GHS-001: starPromptStatePath honors CLI_JAW_HOME', async () => {
    const prev = process.env.CLI_JAW_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'jaw-star-home-'));
    process.env.CLI_JAW_HOME = dir;
    try {
        assert.equal(starPromptStatePath(), join(dir, 'state', 'star-prompt.json'));
    } finally {
        if (prev === undefined) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = prev;
        await rm(dir, { recursive: true, force: true });
    }
});

test('GHS-002: starRepo calls gh starred API with hidden Windows console', () => {
    let seenCommand = '';
    let seenArgs: readonly string[] = [];
    let seenOptions: SpawnSyncOptionsWithStringEncoding | undefined;

    const result = starRepo((
        command: string,
        args: readonly string[],
        options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => {
        seenCommand = command;
        seenArgs = args;
        seenOptions = options;
        return {
            status: 0,
            signal: null,
            error: undefined,
            stdout: '',
            stderr: '',
            output: [],
            pid: 1,
        };
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(seenCommand, 'gh');
    assert.deepEqual(seenArgs, ['api', '-X', 'PUT', '/user/starred/lidge-ai/cli-jaw']);
    assert.equal(seenOptions?.windowsHide, true);
});

test('GHS-003: maybePromptGithubStar skips non-TTY sessions', async () => {
    let marked = false;
    await maybePromptGithubStar({
        stdinIsTTY: false,
        stdoutIsTTY: true,
        markPromptedFn: async () => { marked = true; },
    });
    assert.equal(marked, false);
});

test('GHS-004: maybePromptGithubStar marks once and thanks on successful star', async () => {
    const logs: string[] = [];
    let marked = false;

    await maybePromptGithubStar({
        env: {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        hasBeenPromptedFn: async () => false,
        isGhInstalledFn: () => true,
        markPromptedFn: async () => { marked = true; },
        askYesNoFn: async () => true,
        starRepoFn: () => ({ ok: true }),
        logFn: (message: string) => logs.push(message),
    });

    assert.equal(marked, true);
    assert.deepEqual(logs, ['[jaw] Thanks for the star!']);
});

test('GHS-005: maybePromptGithubStar defers to the user when an agent drives the CLI', async () => {
    const logs: string[] = [];
    let marked = false;
    let asked = false;
    let starred = false;

    await maybePromptGithubStar({
        env: { CODEX_THREAD_ID: '019fa50b' },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        hasBeenPromptedFn: async () => false,
        isGhInstalledFn: () => true,
        markPromptedFn: async () => { marked = true; },
        askYesNoFn: async () => { asked = true; return true; },
        starRepoFn: () => { starred = true; return { ok: true }; },
        logFn: (message: string) => logs.push(message),
    });

    // The agent must not answer, and must not spend the user's GitHub identity.
    assert.equal(asked, false);
    assert.equal(starred, false);
    // The one-time state stays unwritten so the user still sees the real prompt.
    assert.equal(marked, false);
    assert.ok(logs.some(line => line.includes('do not answer this yourself')));
    assert.ok(logs.some(line => line.includes('Ask the user whether to star')));
});

test('GHS-006: isGhInstalled requires an authenticated gh, not just an installed one', () => {
    const calls: string[] = [];

    const spawnSyncFn = (
        _command: string,
        args: readonly string[],
    ): SpawnSyncReturns<string> => {
        calls.push(args.join(' '));
        // `gh --version` succeeds, `gh auth status` reports logged out.
        return {
            status: args[0] === '--version' ? 0 : 1,
            signal: null,
            error: undefined,
            stdout: '',
            stderr: '',
            output: [],
            pid: 1,
        };
    };

    assert.equal(isGhInstalled(spawnSyncFn as never), false);
    assert.deepEqual(calls, ['--version', 'auth status']);
});

test('GHS-007: isAgentDriven separates a user shell from an agent harness', () => {
    assert.equal(isAgentDriven({ TERM: 'xterm-256color', SHELL: '/bin/zsh' }), false);
    assert.equal(isAgentDriven({ CLAUDECODE: '1' }), true);
    assert.equal(isAgentDriven({ CODEX_THREAD_ID: '019fa50b' }), true);
    // An empty or whitespace value does not count as set.
    assert.equal(isAgentDriven({ CLAUDECODE: '' }), false);
    assert.equal(isAgentDriven({ CODEX_THREAD_ID: '   ' }), false);
});

test('GHS-008: interactiveConfirm answers on arrow keys, y/n, and a bare enter', async () => {
    const ask = async (keys: string[], defaultYes = true) => {
        const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
        input.isRaw = false;
        input.setRawMode = ((mode: boolean) => { input.isRaw = mode; return input; }) as NodeJS.ReadStream['setRawMode'];

        const painted: string[] = [];
        const output = new PassThrough() as unknown as NodeJS.WriteStream;
        const write = output.write.bind(output);
        output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
            painted.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
            return write(chunk as string, ...(rest as []));
        }) as NodeJS.WriteStream['write'];

        const pending = interactiveConfirm({ question: 'Star it?', defaultYes, input, output });
        for (const key of keys) input.write(key);
        return { answer: await pending, painted: painted.join(''), raw: input.isRaw };
    };

    assert.equal((await ask(['\r'], true)).answer, true);
    assert.equal((await ask(['\r'], false)).answer, false);
    assert.equal((await ask(['\x1b[C', '\r'])).answer, false); // right → No
    assert.equal((await ask(['n'])).answer, false);
    assert.equal((await ask(['y'], false)).answer, true);
    assert.equal((await ask(['\x1b'], true)).answer, false); // escape declines

    const shown = await ask(['\r']);
    assert.ok(shown.painted.includes('Yes'));
    assert.ok(shown.painted.includes('No'));
    assert.equal(shown.raw, false);
});
