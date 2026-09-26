import type { HookCallback, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';

function deny(reason: string): HookJSONOutput {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    };
}

const foregroundOnly: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (signal.aborted) return deny('Native runtime tool request was aborted.');

    const args = input.tool_input;
    const record = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown> : null;
    const hasFlag = record !== null && Object.prototype.hasOwnProperty.call(record, 'run_in_background');
    const background = hasFlag ? record['run_in_background'] : undefined;

    // The pool seeds CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, which removes the option
    // from the Agent schema: an omitted flag runs in the foreground. Only a present,
    // non-false flag (or a malformed input) is refused here; a task that is backgrounded
    // anyway still fails the turn in claude-sdk-session.ts.
    if ((input.tool_name === 'Agent' || input.tool_name === 'Task')
        && (record === null || (hasFlag && background !== false))) {
        return deny('Native runtime supports foreground Agent/Task only; set run_in_background:false.');
    }
    if (input.tool_name === 'Bash' && background === true) {
        return deny('Native runtime supports foreground Bash only; set run_in_background:false.');
    }
    // Neutral output preserves the existing permission engine and original arguments.
    return {};
};

/** Restrict SDK background options; this is not an OS or shell sandbox. */
export function claudeForegroundHooks(): NonNullable<Options['hooks']> {
    return { PreToolUse: [{ matcher: '^(Agent|Task|Bash)$', hooks: [foregroundOnly] }] };
}
