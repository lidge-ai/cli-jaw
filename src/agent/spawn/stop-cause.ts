import {
    DUP_REGISTRATION_KILL_REASON,
    EXPLICIT_USER_STOP_KILL_REASON,
    INTERRUPT_KILL_REASON,
    STEER_KILL_REASON,
} from './kill-reason.js';

export type StopCause = 'watchdog' | 'user_stop' | 'steer_kill' | 'unattributed';

export function stopCauseFromKillReason(reason: string | null | undefined): StopCause | undefined {
    if (reason === 'user' || reason === 'api' || reason === EXPLICIT_USER_STOP_KILL_REASON) return 'user_stop';
    if (reason === STEER_KILL_REASON || reason === INTERRUPT_KILL_REASON
        || reason === DUP_REGISTRATION_KILL_REASON) return 'steer_kill';
    return undefined;
}

export function classifyStopCause(input: {
    stallReason?: string | undefined;
    wasSteer: boolean;
    wasKilled: boolean;
    killReason?: string | null | undefined;
    exitCode?: number | null;
}): StopCause | undefined {
    if (input.stallReason) return 'watchdog';
    const captured = stopCauseFromKillReason(input.killReason);
    if (captured) return captured;
    if (input.killReason != null) return undefined;
    if (input.wasSteer) return 'steer_kill';
    if (input.wasKilled) return 'user_stop';
    if (input.exitCode === 130) return 'unattributed';
    return undefined;
}

export function readStopCause(value: unknown): StopCause | undefined {
    if (value === 'watchdog' || value === 'user_stop' || value === 'steer_kill' || value === 'unattributed') return value;
    return undefined;
}
