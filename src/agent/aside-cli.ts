import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AsideSelection } from '../shared/aside-contract.js';
import { createTextStreamReader } from './stream-text.js';
import { redactOutboundText } from '../messaging/redact.js';

export const ASIDE_ARGV_BYTES = 96 * 1024;
const WINDOWS_ARGV_BYTES = 24 * 1024;
export const ASIDE_DIAGNOSTIC_BYTES = 32 * 1024;
export const ASIDE_REPL_BYTES = 4 * 1024 * 1024;
export const ASIDE_HISTORY_LIMIT = 200;
export const ASIDE_PROBE_TIMEOUT_MS = 10_000;
export const ASIDE_CLOSE_TIMEOUT_MS = 5_000;
export const ASIDE_KILL_TIMEOUT_MS = 2_000;
const HEADER_BYTES = 4096;
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class AsideTransportError extends Error {
    constructor(public readonly code: string) {
        super(`Aside transport rejected: ${code}.`);
        this.name = 'AsideTransportError';
    }
}
export function validateAsideSessionId(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new AsideTransportError('invalid_session');
}
export function validateAsideSelection(s: AsideSelection): void {
    if (!/^u(?:0|[1-9][0-9]{0,8})$/.test(s.account) || s.host !== 'local'
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(s.provider)
        || !/^[a-zA-Z0-9][a-zA-Z0-9_./:+\[\]-]{0,255}$/.test(s.modelId)
        || s.modelId.split('/').some(p => !p || p === '.' || p === '..')
        || s.model !== `${s.provider}/${s.modelId}`
        || (s.effort !== null && !LEVELS.includes(s.effort))) {
        throw new AsideTransportError('invalid_selection');
    }
}
function boundedArgv(args: string[]): string[] {
    if (args.some(arg => arg.includes('\0')) || args.reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0) > (process.platform === 'win32' ? WINDOWS_ARGV_BYTES : ASIDE_ARGV_BYTES)) {
        throw new AsideTransportError('argv_limit');
    }
    return args;
}
function selectors(s: AsideSelection): string[] {
    validateAsideSelection(s);
    return ['--account', s.account, '--host', s.host];
}
export function buildAsideRunArgs(input: { selection: AsideSelection; permission: 'guard' | 'full-access'; prompt: string; sessionId?: string }): string[] {
    const args = [...selectors(input.selection), '--model', input.selection.model, '--permission', input.permission];
    if (!['guard', 'full-access'].includes(input.permission) || !input.prompt.trim()) throw new AsideTransportError('invalid_input');
    if (input.selection.effort !== null) args.push('--effort', input.selection.effort);
    if (input.sessionId !== undefined) {
        validateAsideSessionId(input.sessionId);
        args.push('session', 'resume', input.sessionId);
    } else args.push('exec');
    return boundedArgv([...args, '--', input.prompt]);
}
export function buildAsideStopArgs(selection: AsideSelection, id: string): string[] {
    validateAsideSessionId(id);
    return boundedArgv([...selectors(selection), 'session', 'stop', id]);
}

/** Receipt parsing is stderr-only, before any other nonblank diagnostic line. */
export function createAsideHeaderReader(resumeId?: string) {
    let pending = '', sealed = false;
    return (text: string): string | null => {
        if (sealed) return null;
        pending += text;
        if (Buffer.byteLength(pending) > HEADER_BYTES) { sealed = true; return null; }
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = stripVTControlCharacters(pending.slice(0, newline)).trim();
            pending = pending.slice(newline + 1);
            if (!line) continue;
            sealed = true;
            const match = /^(created new session|continuing existing session): ([a-zA-Z0-9_-]{1,128})$/.exec(line);
            if (!match || (resumeId === undefined ? match[1] !== 'created new session' : match[1] !== 'continuing existing session' || match[2] !== resumeId)) return null;
            return match[2] ?? null;
        }
        return null;
    };
}

export type AsideSpawn = (binary: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface AsideCommandInput { binary: string; cwd: string; env: NodeJS.ProcessEnv }
export interface AsideCommandResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; overflow: boolean; failed: boolean }
export function observeAsideCallback<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try { Promise.resolve(callback?.(value)).catch(() => { /* Observers cannot select the terminal. */ }); }
    catch { /* Observer isolation is part of the outcome contract. */ }
}
/** Resolve on close, never on exit or successful signal delivery. */
export function launchAsideCommand(input: AsideCommandInput, args: string[], options: {
    spawn?: AsideSpawn; maxBytes?: number; onStdout?: (text: string) => void; onStderr?: (text: string) => void;
} = {}) {
    boundedArgv(args);
    const child = (options.spawn ?? spawn)(input.binary, args, {
        cwd: input.cwd, env: input.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closed = false, overflow = false, failed = false, bytes = 0;
    let stdout = '', stderr = '';
    const out = createTextStreamReader(), err = createTextStreamReader();
    const maxBytes = options.maxBytes ?? ASIDE_DIAGNOSTIC_BYTES;
    const consume = (isOut: boolean, chunk: Buffer | string) => {
        const decoded = (isOut ? out : err).write(chunk);
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { overflow = true; return; }
        if (isOut) stdout += decoded; else stderr += decoded;
        observeAsideCallback(isOut ? options.onStdout : options.onStderr, decoded);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => consume(true, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => consume(false, chunk));
    const ioError = () => { failed = true; };
    child.stdout?.on('error', ioError); child.stderr?.on('error', ioError);
    child.on('error', ioError);
    const completion = new Promise<AsideCommandResult>(resolve => child.once('close', (exitCode, signal) => {
        closed = true;
        stdout += out.end(); stderr += err.end();
        resolve({ exitCode, signal, stdout, stderr, overflow, failed });
    }));
    return {
        child, completion,
        get closed() { return closed; },
        get overflow() { return overflow; },
        signal(signal: NodeJS.Signals) {
            if (!closed && child.exitCode === null && child.signalCode === null) {
                try { child.kill(signal); } catch { failed = true; }
            }
        },
    };
}
export type AsideCommand = ReturnType<typeof launchAsideCommand>;
export async function asideWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
}
export async function closeAsideCommand(command: AsideCommand, closeMs = ASIDE_CLOSE_TIMEOUT_MS, killMs = ASIDE_KILL_TIMEOUT_MS): Promise<boolean> {
    if (command.closed) return true;
    command.signal('SIGTERM');
    if (await asideWithin(command.completion, closeMs)) return true;
    command.signal('SIGKILL');
    return (await asideWithin(command.completion, killMs)) !== undefined;
}
export function safeAsideDiagnostic(text: string): string {
    // Bound before the shared redactor's scanning work; decoder preserves chunk UTF-8.
    return redactOutboundText(stripVTControlCharacters(text)).slice(0, ASIDE_DIAGNOSTIC_BYTES);
}
export function buildAsideReadArgs(selection: AsideSelection, id: string, frame: string): string[] {
    validateAsideSessionId(id);
    if (!/^[a-f0-9-]{36}$/.test(frame)) throw new AsideTransportError('invalid_frame');
    const code = `const id=${JSON.stringify(id)};const before=await aside.sessions.get(id);const messages=await aside.sessions.messages(id,{limit:${ASIDE_HISTORY_LIMIT},order:"desc"});const after=await aside.sessions.get(id);const value={session:{id:after.id,status:after.status},before:{id:before.id,status:before.status},messages,limit:${ASIDE_HISTORY_LIMIT},order:"desc"};const json=JSON.stringify(value);if(new TextEncoder().encode(json).length>${ASIDE_REPL_BYTES - 4096})throw new Error("aside_replay_limit");console.log("JAW_ASIDE_${frame}_BEGIN"+json+"JAW_ASIDE_${frame}_END");`;
    return boundedArgv([...selectors(selection), 'repl', '--', code]);
}
export function parseAsideRepl(stdout: string, frame: string): unknown {
    const text = stripVTControlCharacters(stdout).trim();
    if (!/\[ok \| [0-9]+ms\]$/.test(text)) throw new AsideTransportError('repl_failed');
    const begin = `JAW_ASIDE_${frame}_BEGIN`, end = `JAW_ASIDE_${frame}_END`;
    const start = text.indexOf(begin), finish = text.lastIndexOf(end);
    if (start !== 0 || finish < begin.length
        || !/^\s*\[ok \| [0-9]+ms\]$/.test(text.slice(finish + end.length))) throw new AsideTransportError('invalid_repl_frame');
    try { return JSON.parse(text.slice(begin.length, finish)) as unknown; }
    catch { throw new AsideTransportError('invalid_repl_json'); }
}
export async function readAsideSession(input: AsideCommandInput, selection: AsideSelection, id: string, deps: { spawn?: AsideSpawn; probeMs?: number; closeMs?: number; killMs?: number; onCommand?: (command: AsideCommand) => void } = {}): Promise<unknown> {
    const frame = randomUUID();
    const command = launchAsideCommand(input, buildAsideReadArgs(selection, id, frame), { ...deps, maxBytes: ASIDE_REPL_BYTES });
    deps.onCommand?.(command);
    const result = await asideWithin(command.completion, deps.probeMs ?? ASIDE_PROBE_TIMEOUT_MS);
    if (!result) {
        const closed = await closeAsideCommand(command, deps.closeMs, deps.killMs);
        throw new AsideTransportError(closed ? 'repl_timeout' : 'repl_close_unconfirmed');
    }
    if (result.exitCode !== 0 || result.failed || result.overflow || result.stderr.trim()) throw new AsideTransportError('repl_transport_failed');
    return parseAsideRepl(result.stdout, frame);
}
