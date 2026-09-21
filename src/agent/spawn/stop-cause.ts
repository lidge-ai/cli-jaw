export type StopCause = 'watchdog' | 'user_stop' | 'steer_kill' | 'unattributed';

export function classifyStopCause(input: {
    stallReason?: string | undefined;
    wasSteer: boolean;
    wasKilled: boolean;
    exitCode?: number | null;
}): StopCause | undefined {
    if (input.stallReason) return 'watchdog';
    if (input.wasSteer) return 'steer_kill';
    if (input.wasKilled) return 'user_stop';
    if (input.exitCode === 130) return 'unattributed';
    return undefined;
}

export function readStopCause(value: unknown): StopCause | undefined {
    if (value === 'watchdog' || value === 'user_stop' || value === 'steer_kill' || value === 'unattributed') return value;
    return undefined;
}
