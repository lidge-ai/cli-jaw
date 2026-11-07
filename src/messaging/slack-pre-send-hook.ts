import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { RemoteTarget } from './types.js';

const HOOK_COMMAND_ENV = 'JAW_SLACK_PRE_SEND_HOOK';
const HOOK_ARGS_ENV = 'JAW_SLACK_PRE_SEND_HOOK_ARGS';
const HOOK_TIMEOUT_ENV = 'JAW_SLACK_PRE_SEND_HOOK_TIMEOUT_MS';
const HOOK_OUTPUT_ENV = 'JAW_SLACK_PRE_SEND_HOOK_MAX_OUTPUT_BYTES';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1 * 1024 * 1024;

export type SlackPreSendContext = {
    channel: string;
    requester: string;
    jobKind: string;
    requestId: string;
    turnId: string;
};

export type SlackPreSendBaseContext = Pick<SlackPreSendContext, 'requester' | 'jobKind'>;

export type SlackPreSendResult =
    | { ok: true; text: string }
    | { ok: false; error: string; violations?: string[]; notificationSent?: boolean };

type HookResponse = {
    ok?: unknown;
    text?: unknown;
    error?: unknown;
    violations?: unknown;
    notification?: unknown;
};

type HookOptions = {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
};

function bounded(value: string, addition: string, maxBytes: number): string {
    const next = value + addition;
    if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
    return Buffer.from(next, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function boundedPositive(value: string | undefined, fallback: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.floor(parsed), max);
}

function configuredHook(env: NodeJS.ProcessEnv): { command: string; args: string[]; timeoutMs: number; maxOutputBytes: number } | null {
    const command = env[HOOK_COMMAND_ENV]?.trim();
    if (!command) return null;

    let args: string[] = [];
    const rawArgs = env[HOOK_ARGS_ENV]?.trim();
    if (rawArgs) {
        let parsed: unknown;
        try { parsed = JSON.parse(rawArgs); } catch { throw new Error('invalid_pre_send_hook_args'); }
        if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
            throw new Error('invalid_pre_send_hook_args');
        }
        args = parsed;
    }
    return {
        command,
        args,
        timeoutMs: boundedPositive(env[HOOK_TIMEOUT_ENV], DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        maxOutputBytes: boundedPositive(env[HOOK_OUTPUT_ENV], DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
    };
}

function expandArgs(args: readonly string[], files: { context: string; text: string; output: string }): string[] {
    return args.map(arg => arg
        .replaceAll('{context_file}', files.context)
        .replaceAll('{text_file}', files.text)
        .replaceAll('{output_file}', files.output));
}

function parseJsonLine(stdout: string): HookResponse | null {
    for (const line of stdout.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as HookResponse;
        } catch { /* A hook may write diagnostics before its final JSON line. */ }
    }
    return null;
}

function violations(response: HookResponse | null): string[] | undefined {
    if (!Array.isArray(response?.violations)) return undefined;
    const values = response.violations.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean);
    return values.length ? values.slice(0, 32) : undefined;
}

function blocked(response: HookResponse | null, fallback: string): SlackPreSendResult {
    const error = typeof response?.error === 'string' && response.error.trim()
        ? response.error.trim().slice(0, 160) : fallback;
    const result: SlackPreSendResult = { ok: false, error };
    const foundViolations = violations(response);
    if (foundViolations) result.violations = foundViolations;
    if (response?.notification !== undefined) result.notificationSent = true;
    return result;
}

/**
 * Runs the configured external Slack text validator. The unset path is a true
 * no-op: it does not allocate files, spawn a process, or alter the body.
 */
export async function runSlackPreSendHook(
    text: string,
    target: RemoteTarget,
    context: SlackPreSendContext,
    options: HookOptions = {},
): Promise<SlackPreSendResult> {
    if (target.channel !== 'slack') return { ok: true, text };
    let hook: ReturnType<typeof configuredHook>;
    try { hook = configuredHook(options.env ?? process.env); }
    catch (error) { return { ok: false, error: (error as Error).message }; }
    if (!hook) return { ok: true, text };
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return { ok: false, error: 'pre_send_text_too_large' };

    const root = await mkdtemp(join(tmpdir(), 'cli-jaw-slack-hook-'));
    const files = {
        context: join(root, 'context.json'),
        text: join(root, 'text.txt'),
        output: join(root, 'output.txt'),
    };
    const envelope = JSON.stringify({ text, context, target }, null, 2);
    try {
        await writeFile(files.context, JSON.stringify(context), { mode: 0o600 });
        await writeFile(files.text, text, { mode: 0o600 });

        const args = expandArgs(hook.args, files);
        const response = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; aborted: boolean; timedOut: boolean }>((resolve) => {
            const child = spawn(hook.command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env });
            let stdout = '';
            let stderr = '';
            let settled = false;
            let aborted = false;
            let timedOut = false;
            let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
            const outDecoder = new StringDecoder('utf8');
            const errDecoder = new StringDecoder('utf8');
            const terminate = (timeout: boolean) => {
                if (timeout) timedOut = true;
                child.kill('SIGTERM');
                forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
                forceKillTimer.unref?.();
            };
            const timer = setTimeout(() => terminate(true), hook.timeoutMs);
            timer.unref?.();
            const abort = () => { aborted = true; terminate(false); };
            options.signal?.addEventListener('abort', abort, { once: true });
            const finish = (code: number | null, signal: NodeJS.Signals | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (forceKillTimer) clearTimeout(forceKillTimer);
                options.signal?.removeEventListener('abort', abort);
                stdout = bounded(stdout, outDecoder.end(), hook.maxOutputBytes);
                stderr = bounded(stderr, errDecoder.end(), hook.maxOutputBytes);
                resolve({ code, signal, stdout, stderr, aborted, timedOut });
            };
            child.stdout.on('data', chunk => { stdout = bounded(stdout, outDecoder.write(chunk as Buffer), hook.maxOutputBytes); });
            child.stderr.on('data', chunk => { stderr = bounded(stderr, errDecoder.write(chunk as Buffer), hook.maxOutputBytes); });
            child.once('error', error => {
                stderr = bounded(stderr, error.message, hook.maxOutputBytes);
                finish(null, null);
            });
            child.once('close', finish);
            child.stdin.end(envelope);
        });

        const parsed = parseJsonLine(response.stdout);
        if (response.aborted || options.signal?.aborted) return blocked(parsed, 'pre_send_hook_aborted');
        if (response.timedOut) return blocked(parsed, 'pre_send_hook_timeout');
        if (response.code !== 0) return blocked(parsed, response.code === null ? 'pre_send_hook_spawn_failed' : `pre_send_hook_exit_${response.code}`);
        if (parsed?.ok === false) return blocked(parsed, 'pre_send_hook_blocked');

        let output: string | undefined;
        try {
            const outputBytes = await readFile(files.output);
            if (outputBytes.byteLength > hook.maxOutputBytes) return { ok: false, error: 'pre_send_hook_output_too_large' };
            output = outputBytes.toString('utf8');
        } catch { /* JSON stdout contract may carry the result. */ }
        if (output !== undefined) return output.trim() ? { ok: true, text: output } : blocked(parsed, 'pre_send_hook_empty');
        if (typeof parsed?.text === 'string') return parsed.text.trim() ? { ok: true, text: parsed.text } : blocked(parsed, 'pre_send_hook_empty');
        if (parsed?.ok === true || parsed === null) return { ok: true, text };
        return blocked(parsed, 'invalid_pre_send_hook_result');
    } catch (error) {
        return { ok: false, error: (error as Error).message.slice(0, 160) || 'pre_send_hook_failed' };
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
}
