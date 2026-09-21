// ─── What counts as an intentional lifecycle stop ───
//
// Every runtime adapter ends a turn in its own exit handler, and each one used to
// re-derive "was this an intentional stop?" from the recorded kill reason. They
// disagreed: native and Claude accepted all three reasons, Pi and codex-app dropped
// `interrupt`, and ACP and the print CLI accepted only `steer` (#681).
//
// That flag is not cosmetic. `wasSteer` simultaneously guards smoke continuation,
// the salvage prefix, whether a stale handler may evict the replacement child's
// `activeProcesses` entry, the queue drain, and goal continuation
// (`lifecycle-handler.ts:404`, `:457-461`, `:737-740`, `:1412`). A runtime that
// classified an interrupt as an ordinary exit therefore lost the user's stop.
//
// Its own leaf module because both `spawn.ts` and `claude-runtime-run.ts` need it and
// `spawn.ts` imports the latter, so the helper cannot live in either. It is also
// deliberately NOT in `process-kill.ts`: that file's `ProcessTerminationReason` is a
// different vocabulary for a different layer — it spells the same event
// `duplicate-registration` — and merging the two would make a typo silently change
// lifecycle behaviour.

/** A steer replaced the turn: the user sent new input while one was running. */
export const STEER_KILL_REASON = 'steer';

/** The gateway's interrupt policy stopped the turn (`orchestrator/gateway.ts`). */
export const INTERRUPT_KILL_REASON = 'interrupt';

/** An explicit channel /stop uses interrupt lifecycle cleanup but user-stop copy. */
export const EXPLICIT_USER_STOP_KILL_REASON = 'explicit-user-stop';

/** Kill reason recorded when a duplicate registration reaps the previous child. */
export const DUP_REGISTRATION_KILL_REASON = 'dup-registration';

/** Reasons that arm the captured exit-settlement barrier and release the scope. */
export function isLifecycleExitSettleReason(reason: string | null | undefined): boolean {
    return reason === STEER_KILL_REASON
        || reason === INTERRUPT_KILL_REASON
        || reason === EXPLICIT_USER_STOP_KILL_REASON;
}

/**
 * Was this exit an intentional lifecycle stop rather than an agent failure?
 *
 * `dup-registration` belongs here for the same reason `steer` does, even though no
 * user asked for it: a replacement child already owns the label, so the stale exit
 * handler must not delete the new child's map entry or drain the queue underneath it.
 */
export function isLifecycleSteerReason(reason: string | null | undefined): boolean {
    return isLifecycleExitSettleReason(reason)
        || reason === DUP_REGISTRATION_KILL_REASON;
}
