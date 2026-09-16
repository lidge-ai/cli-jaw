export type StopCause = 'watchdog' | 'user_stop' | 'steer_kill';

export function classifyStopCause(input: {
    stallReason?: string;
    wasSteer: boolean;
    wasKilled: boolean;
}): StopCause | undefined {
    if (input.stallReason) return 'watchdog';
    if (input.wasSteer) return 'steer_kill';
    if (input.wasKilled) return 'user_stop';
    return undefined;
}

export function readStopCause(value: unknown): StopCause | undefined {
    if (value === 'watchdog' || value === 'user_stop' || value === 'steer_kill') return value;
    return undefined;
}
