/**
 * Live Copilot model inventory, read from the Copilot CLI's headless server.
 *
 * `copilot` has no listing subcommand and `--acp` does not advertise models, but
 * `copilot --headless --stdio` answers the same `models.list` JSON-RPC the
 * official Copilot SDK uses. That list is per account: it holds exactly the
 * models the signed-in plan is entitled to, which a static list cannot know.
 */
import { spawn } from 'node:child_process';
import { detectCli } from '../core/cli-detection.js';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 500;

export interface CopilotModelInventory {
    models: string[];
    /** Per-model effort ladder; an empty set means the model takes no effort. */
    effortsByModel: Record<string, string[]>;
    defaultEffortByModel: Record<string, string>;
    source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse a `models.list` result.
 *
 *   { models: [{ id, policy?: { state }, supportedReasoningEfforts?, defaultReasoningEffort? }] }
 *
 * A model whose policy is anything but `enabled` is left out: Copilot lists
 * models the plan has not enabled or whose terms were not accepted, and those
 * fail when selected. A model without a policy (`auto`) is always selectable.
 * `none` is dropped from effort ladders because cli-jaw spells "no effort" as
 * an empty value.
 */
export function parseCopilotModelList(result: unknown): CopilotModelInventory | null {
    if (!isRecord(result) || !Array.isArray(result['models'])) return null;

    const models: string[] = [];
    const effortsByModel: Record<string, string[]> = {};
    const defaultEffortByModel: Record<string, string> = {};

    for (const row of result['models']) {
        if (models.length >= MAX_MODELS) break;
        if (!isRecord(row)) continue;
        const id = row['id'];
        if (typeof id !== 'string' || !/^[A-Za-z0-9][\w.:/-]*$/.test(id)) continue;
        if (effortsByModel[id]) continue;
        const policy = row['policy'];
        if (isRecord(policy) && policy['state'] !== 'enabled') continue;

        const efforts = Array.isArray(row['supportedReasoningEfforts'])
            ? row['supportedReasoningEfforts'].filter((e): e is string => typeof e === 'string' && e !== 'none')
            : [];
        models.push(id);
        effortsByModel[id] = efforts;
        const defaultEffort = row['defaultReasoningEffort'];
        if (typeof defaultEffort === 'string' && efforts.includes(defaultEffort)) {
            defaultEffortByModel[id] = defaultEffort;
        }
    }

    if (models.length === 0) return null;
    return { models, effortsByModel, defaultEffortByModel, source: 'copilot models.list' };
}

/**
 * Ask a headless Copilot server for its models, then stop it.
 *
 * The server speaks JSON-RPC with `Content-Length` framing, like LSP. Any
 * failure — no binary, not signed in, timeout, malformed frame — answers null.
 */
export async function fetchCopilotModelInventory(
    binary?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CopilotModelInventory | null> {
    const resolvedBinary = binary || detectCli('copilot').path;
    if (!resolvedBinary) return null;

    return new Promise((resolve) => {
        let settled = false;
        let buffered = Buffer.alloc(0);
        const child = spawn(resolvedBinary, ['--headless', '--no-auto-update', '--log-level', 'error', '--stdio'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { ...process.env, NO_COLOR: '1' },
            windowsHide: true,
        });

        const finish = (value: CopilotModelInventory | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout?.removeAllListeners('data');
            if (child.exitCode === null && child.signalCode === null) child.kill();
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);

        child.on('error', () => finish(null));
        child.on('exit', () => finish(null));
        child.stdin?.on('error', () => finish(null));
        child.stdout?.on('data', (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length > MAX_RESPONSE_BYTES) return finish(null);
            for (;;) {
                const headerEnd = buffered.indexOf('\r\n\r\n');
                if (headerEnd < 0) return;
                const length = /Content-Length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString('ascii'));
                if (!length) return finish(null);
                const bodyStart = headerEnd + 4;
                const bodyEnd = bodyStart + Number(length[1]);
                if (buffered.length < bodyEnd) return;
                const body = buffered.subarray(bodyStart, bodyEnd).toString('utf8');
                buffered = buffered.subarray(bodyEnd);
                let message: unknown;
                try { message = JSON.parse(body); } catch { return finish(null); }
                if (isRecord(message) && message['id'] === 1) {
                    return finish(message['error'] ? null : parseCopilotModelList(message['result']));
                }
            }
        });

        const request = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'models.list', params: {} }));
        child.stdin?.write(`Content-Length: ${request.length}\r\n\r\n`);
        child.stdin?.write(request);
    });
}
