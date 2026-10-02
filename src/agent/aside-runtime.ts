import type { ChildProcess } from 'node:child_process';
import type { AsideSelection } from '../shared/aside-contract.js';
import type { RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import {
    ASIDE_CLOSE_TIMEOUT_MS, ASIDE_KILL_TIMEOUT_MS, ASIDE_PROBE_TIMEOUT_MS,
    AsideTransportError, asideWithin, buildAsideRunArgs, buildAsideStopArgs,
    closeAsideCommand, createAsideHeaderReader, launchAsideCommand, observeAsideCallback,
    readAsideSession, safeAsideDiagnostic, type AsideCommand, type AsideSpawn,
} from './aside-cli.js';
import { captureAsideBaseline, inspectAsideInterval, parseAsideReplay, type AsideBaseline } from './aside-replay.js';

export interface AsideRunInput {
    binary: string; cwd: string; env: NodeJS.ProcessEnv;
    selection: AsideSelection; permission: 'guard' | 'full-access';
    prompt: string; sessionId?: string;
}
export interface AsideRunCallbacks {
    onSession?(id: string): void;
    onOutput?(text: string): void;
    onChild?(child: ChildProcess): void;
}
export interface AsideRunResult extends RuntimeTurnOutcome {
    sessionId: string | null; reusable: boolean; diagnostic?: string; exitCode: number | null;
    /** External logical terminal/interruption and local child close are both observed. */
    cleanup: 'confirmed' | 'uncertain';
}
export interface AsideRuntimeDependencies {
    spawn?: AsideSpawn;
    /** Read boundary for composition and deterministic control/replay race tests. */
    read?: (input: AsideRunInput, sessionId: string) => Promise<unknown>;
    probeMs?: number; closeMs?: number; killMs?: number; turnMs?: number;
}
export const ASIDE_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const INTERRUPTED = 'Aside session interruption verified and local CLI closed. External tool physical completion is not proved; session cannot be reused.';
const UNCERTAIN = 'Aside cancellation is unresolved. Session cannot be reused; external tool physical completion is not proved.';
const CLOSE_UNCERTAIN = 'Aside local CLI closure is unconfirmed. Session cannot be reused.';

/** All dependencies are captured per owner; production has no test-mode switches. */
export function createAsideRuntime(dependencies: AsideRuntimeDependencies = {}) {
    const deps = { ...dependencies };
    return function start(input: AsideRunInput, callbacks: AsideRunCallbacks = {}): { result: Promise<AsideRunResult>; cancel(): Promise<void> } {
        // Capture selectors, process environment and observers synchronously, before any read.
        const captured = { ...input, selection: Object.freeze({ ...input.selection }), env: { ...input.env } };
        const observers = { ...callbacks };
        let cancelled = false, sealed = false;
        let wakeCancel!: () => void;
        const cancellation = new Promise<void>(resolve => { wakeCancel = resolve; });
        let command: AsideCommand | undefined;
        let sessionId: string | null = input.sessionId ?? null;
        let receiptSeen = false;
        let resolveReceipt!: (id: string) => void;
        const receipt = new Promise<string>(resolve => { resolveReceipt = resolve; });
        const probeMs = deps.probeMs ?? ASIDE_PROBE_TIMEOUT_MS;
        const closeMs = deps.closeMs ?? ASIDE_CLOSE_TIMEOUT_MS;
        const killMs = deps.killMs ?? ASIDE_KILL_TIMEOUT_MS;
        let baseline: AsideBaseline = captureAsideBaseline();
        const read = async (id: string) => {
            const value = deps.read
                ? await asideWithin(deps.read(captured, id), probeMs)
                : await readAsideSession(captured, captured.selection, id, deps);
            if (value === undefined) throw new AsideTransportError('replay_timeout');
            return parseAsideReplay(value, id);
        };
        function result(status: 'done' | 'error' | 'stopped', finalText: string | null, exitCode: number | null, diagnostic?: string, cleanup: 'confirmed' | 'uncertain' = 'confirmed'): AsideRunResult {
            return { status, finalText, partialText: '', sessionId, reusable: status === 'done' && cleanup === 'confirmed', exitCode, cleanup,
                ...(diagnostic ? { diagnostic } : {}) };
        }
        async function cleanup(): Promise<boolean> {
            return command ? closeAsideCommand(command, closeMs, killMs) : true;
        }
        async function stopOwned(status: 'stopped' | 'error' = 'stopped', failure?: string): Promise<AsideRunResult> {
            let verified = false, terminal = false;
            try {
                if (!receiptSeen && command) {
                    await asideWithin(Promise.race([receipt, command.completion.then(() => null)]), probeMs);
                }
                if (receiptSeen && sessionId && command) {
                    // Capture the only new start before issuing control. No current-session lookup.
                    const before = await read(sessionId);
                    const interval = inspectAsideInterval(before, baseline);
                    if (interval.outcome === null && !interval.interrupted) {
                        const control = launchAsideCommand(captured, buildAsideStopArgs(captured.selection, sessionId), { ...(deps.spawn ? { spawn: deps.spawn } : {}) });
                        const stopped = await asideWithin(control.completion, probeMs);
                        if (!stopped) await closeAsideCommand(control, closeMs, killMs);
                        if (stopped && stopped.exitCode === 0 && !stopped.failed && !stopped.overflow
                            && safeAsideDiagnostic(stopped.stdout).trim() === 'interrupted' && !stopped.stderr.trim()) {
                            const after = inspectAsideInterval(await read(sessionId), baseline, interval.turnId);
                            terminal = after.outcome !== null;
                            verified = (after.interrupted && after.outcome === null) || terminal;
                        }
                    } else if (interval.outcome !== null) {
                        terminal = true; verified = true;
                    } else if (interval.interrupted && interval.outcome === null) {
                        // Existing exact owned interruption still needs local child closure.
                        verified = true;
                    }
                }
            } catch { /* A safe unresolved diagnostic is the control result, never a guessed stop. */ }
            const closed = await cleanup();
            const exit = command?.closed ? (await command.completion).exitCode : null;
            const confirmed = closed && verified;
            const diagnostic = confirmed
                ? terminal ? 'Aside owned terminal verified and local CLI closed; final withheld.' : INTERRUPTED
                : `${UNCERTAIN}${closed ? '' : ` ${CLOSE_UNCERTAIN}`}`;
            return result(status, null, exit, failure ? `${failure} ${diagnostic}` : diagnostic, confirmed ? 'confirmed' : 'uncertain');
        }
        async function execute(): Promise<AsideRunResult> {
            try {
                const args = buildAsideRunArgs(captured);
                if (captured.sessionId !== undefined) {
                    baseline = captureAsideBaseline(await read(captured.sessionId));
                }
                if (cancelled) return result('stopped', null, null, 'Aside run cancelled before dispatch.');
                const header = createAsideHeaderReader(captured.sessionId);
                const report = (text: string) => {
                    if (!cancelled && !sealed) observeAsideCallback(observers.onOutput, safeAsideDiagnostic(text));
                };
                command = launchAsideCommand(captured, args, {
                    ...(deps.spawn ? { spawn: deps.spawn } : {}),
                    onStdout: report,
                    onStderr: text => {
                        const id = header(text);
                        if (id && !receiptSeen) {
                            sessionId = id; receiptSeen = true; resolveReceipt(id);
                            observeAsideCallback(observers.onSession, id);
                        }
                        report(text);
                    },
                });
                observeAsideCallback(observers.onChild, command.child);
                const admitted = await asideWithin(Promise.race([
                    receipt.then(() => 'receipt' as const), command.completion.then(() => 'closed' as const),
                    cancellation.then(() => 'cancel' as const),
                ]), probeMs);
                if (!admitted || cancelled) {
                    cancelled = true;
                    return await stopOwned();
                }
                const completion = await asideWithin(Promise.race([
                    command.completion.then(value => ({ kind: 'closed' as const, value })),
                    cancellation.then(() => ({ kind: 'cancel' as const })),
                ]), deps.turnMs ?? ASIDE_TURN_TIMEOUT_MS);
                if (cancelled || completion?.kind === 'cancel' || !completion) {
                    cancelled = true;
                    return await stopOwned();
                }
                if (!receiptSeen || !sessionId) throw new AsideTransportError('session_receipt_missing');
                if (completion.value.failed || completion.value.overflow || completion.value.exitCode !== 0) throw new AsideTransportError('agent_transport_failed');
                const replay = await read(sessionId);
                if (cancelled) return await stopOwned();
                const interval = inspectAsideInterval(replay, baseline);
                if (!interval.outcome) throw new AsideTransportError('terminal_missing');
                // No callbacks after authoritative selection, so observers cannot trigger re-selection.
                sealed = true;
                return result(interval.outcome.status, interval.outcome.finalText, completion.value.exitCode,
                    interval.outcome.status === 'done' ? undefined : 'Aside owned turn did not complete successfully.');
            } catch (error) {
                const diagnostic = error instanceof AsideTransportError ? error.message : 'Aside runtime boundary failed.';
                if (command) return await stopOwned(cancelled ? 'stopped' : 'error', cancelled ? undefined : diagnostic);
                // No child was admitted; validation/baseline/spawn failure needs no child cleanup.
                return result(cancelled ? 'stopped' : 'error', null, null, diagnostic);
            } finally { sealed = true; }
        }
        const pending = execute();
        return {
            result: pending,
            cancel() {
                // Synchronous latch precedes every await and is idempotent after terminal selection.
                if (!sealed) { cancelled = true; wakeCancel(); }
                return pending.then(() => undefined);
            },
        };
    };
}
export const startAsideRun: (input: AsideRunInput, callbacks?: AsideRunCallbacks) => {
    result: Promise<AsideRunResult>; cancel(): Promise<void>;
} = createAsideRuntime();
