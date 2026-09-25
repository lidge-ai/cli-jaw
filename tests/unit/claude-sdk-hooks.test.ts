import test from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallback, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { claudeForegroundHooks } from '../../src/agent/runtime/claude-sdk-hooks.ts';

const agentDenial: HookJSONOutput = {
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Native runtime supports foreground Agent/Task only; set run_in_background:false.',
    },
};
const bashDenial: HookJSONOutput = {
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Native runtime supports foreground Bash only; set run_in_background:false.',
    },
};
const base = { session_id: 'session', transcript_path: '/unused/transcript', cwd: '/unused' };

function callback(): HookCallback {
    const hooks = claudeForegroundHooks().PreToolUse;
    assert.ok(hooks);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].hooks.length, 1);
    return hooks[0].hooks[0];
}

function input(tool_name: string, tool_input: unknown): PreToolUseHookInput {
    return { ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'tool' };
}

function invoke(tool: string, toolInput: unknown, signal = new AbortController().signal) {
    return callback()(input(tool, toolInput), 'tool', { signal });
}

test('registers only a PreToolUse matcher for the exact built-in Agent, Task and Bash tools', () => {
    const hooks = claudeForegroundHooks();
    assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
    callback();
    const matcher = hooks.PreToolUse?.[0].matcher;
    assert.equal(typeof matcher, 'string');
    assert.ok(matcher);
    const pattern = new RegExp(matcher);
    for (const tool of ['Agent', 'Task', 'Bash']) assert.equal(pattern.test(tool), true, tool);
    for (const tool of ['Read', 'TaskOutput', 'mcp__server__Agent', 'AgentExtra', 'OtherBash']) {
        assert.equal(pattern.test(tool), false, tool);
    }
});

for (const tool of ['Agent', 'Task']) {
    test(`${tool}: exact false returns neutral output without rewriting arguments`, async () => {
        const args = Object.freeze({ prompt: 'work', run_in_background: false });
        assert.deepEqual(await invoke(tool, args), {});
        assert.deepEqual(args, { prompt: 'work', run_in_background: false });
    });

    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 removes the option from the tool schema,
    // so a call without it is a foreground call and must not be refused.
    test(`${tool}: omitted flag returns neutral output (background disabled at source)`, async () => {
        const args = Object.freeze({ prompt: 'work' });
        assert.deepEqual(await invoke(tool, args), {});
        assert.deepEqual(args, { prompt: 'work' });
    });

    test(`${tool}: an input object with no flag at all is the omitted case`, async () => {
        assert.deepEqual(await invoke(tool, {}), {});
    });

    const deniedInputs: [string, unknown][] = [
        ['true', { run_in_background: true }],
        ['undefined', { run_in_background: undefined }], ['null flag', { run_in_background: null }],
        ['string false', { run_in_background: 'false' }], ['zero', { run_in_background: 0 }],
        ['object flag', { run_in_background: {} }], ['array flag', { run_in_background: [] }],
        ['missing input', undefined], ['null input', null], ['string input', 'false'], ['array input', []],
    ];
    for (const [label, args] of deniedInputs) {
        test(`${tool}: ${label} is denied without a grant or argument update`, async () => {
            const before = structuredClone(args);
            assert.deepEqual(await invoke(tool, args), agentDenial);
            assert.deepEqual(args, before);
        });
    }
}

test('Bash: explicit background true is denied without rewriting arguments', async () => {
    const args = Object.freeze({ command: 'echo hello', run_in_background: true });
    assert.deepEqual(await invoke('Bash', args), bashDenial);
    assert.deepEqual(args, { command: 'echo hello', run_in_background: true });
});

for (const flag of [false, undefined, 'true', 1, null]) {
    test(`Bash: ${JSON.stringify(flag)} stays neutral for the existing permission engine`, async () => {
        assert.deepEqual(await invoke('Bash', { command: 'echo hello', run_in_background: flag }), {});
    });
}

test('Bash: omitted background flag stays neutral, including shell background syntax', async () => {
    assert.deepEqual(await invoke('Bash', { command: 'echo hello &' }), {});
});

test('unrelated tools stay neutral even when they carry a background flag', async () => {
    for (const tool of ['Read', 'TaskOutput', 'mcp__server__Agent', 'AgentExtra']) {
        assert.deepEqual(await invoke(tool, { run_in_background: true }), {});
    }
});

test('non-PreToolUse events stay neutral', async () => {
    assert.deepEqual(await callback()({ ...base, hook_event_name: 'SessionEnd', reason: 'other' }, undefined,
        { signal: new AbortController().signal }), {});
});

for (const tool of ['Agent', 'Task', 'Bash']) {
    test(`${tool}: aborted signal denies even an explicitly foreground invocation`, async () => {
        const controller = new AbortController();
        controller.abort();
        assert.deepEqual(await invoke(tool, { run_in_background: false }, controller.signal), {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Native runtime tool request was aborted.',
            },
        });
    });
}
