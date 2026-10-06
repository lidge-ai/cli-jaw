import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { COMPUTER_USE_APPROVAL_ENV } from './computer-use-constants.js';

export type CuaReplSpec = {
    command: string;
    args: string[];
    env: Record<string, string>;
    version: string;
    configPath: string;
};
export type ApprovalPolicy = 'auto' | 'safe';
export type ElicitationClass = 'cu-approval' | 'cu-unknown' | 'other';
export type JsonRpcResponse = {
    jsonrpc: '2.0';
    id: string | number;
    result?: { action: 'accept'; content: Record<string, never> } | { action: 'decline' };
    error?: { code: number; message: string };
};
export type ProxyIo = { input: Readable; output: Writable; errorOutput: Writable };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject : null;
}

function compareVersions(left: string, right: string): number {
    const a = left.split('.').map(BigInt);
    const b = right.split('.').map(BigInt);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0n) - (b[i] ?? 0n);
        if (difference !== 0n) return difference > 0n ? 1 : -1;
    }
    return 0;
}

/** Find the newest valid bundled cua_repl server without importing Jaw config. */
export function resolveCuaRepl(opts: { codexHome?: string | undefined; exists?: (path: string) => boolean } = {}): CuaReplSpec | null {
    const root = join(opts.codexHome ?? process['env']['CODEX_HOME'] ?? join(homedir(), '.codex'),
        'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
    const exists = opts.exists ?? existsSync;
    let versions: string[];
    try {
        versions = readdirSync(root).filter(version => /^\d+(?:\.\d+)*$/.test(version));
    } catch {
        return null;
    }
    versions.sort((a, b) => compareVersions(b, a));
    for (const version of versions) {
        const configPath = join(root, version, '.mcp.json');
        try {
            const config = object(JSON.parse(readFileSync(configPath, 'utf8')));
            const server = object(object(config?.['mcpServers'])?.['cua_repl']);
            if (!server || typeof server['command'] !== 'string' || !isAbsolute(server['command']) || !exists(server['command'])) continue;
            if (!Array.isArray(server['args']) || !server['args'].every(arg => typeof arg === 'string')) continue;
            const env = object(server['env'] ?? {});
            if (!env || !Object.values(env).every(value => typeof value === 'string')) continue;
            return { command: server['command'], args: server['args'] as string[], env: env as Record<string, string>, version, configPath };
        } catch {
            // A partial or malformed plugin cache entry must not hide an older valid version.
        }
    }
    return null;
}

export function resolveApprovalPolicy(env: NodeJS.ProcessEnv): ApprovalPolicy {
    return env[COMPUTER_USE_APPROVAL_ENV] === 'auto' ? 'auto' : 'safe';
}

function hasId(message: JsonObject): message is JsonObject & { id: string | number } {
    return typeof message['id'] === 'string' || (typeof message['id'] === 'number' && Number.isFinite(message['id']));
}

/** Unknown messages from the same connector fail closed; other connectors pass through. */
export function classifyElicitation(msg: unknown): ElicitationClass {
    const message = object(msg);
    if (message?.['method'] !== 'elicitation/create') return 'other';
    const params = object(message['params']);
    const meta = object(params?.['_meta']);
    if (meta?.['connector_id'] !== 'computer-use') return 'other';
    if (!hasId(message)) return 'cu-unknown';
    if (params?.['mode'] !== undefined && params['mode'] !== 'form') return 'cu-unknown';
    if (meta['codex_approval_kind'] !== 'mcp_tool_call') return 'cu-unknown';
    if (params?.['requestedSchema'] !== undefined) {
        const schema = object(params['requestedSchema']);
        if (!schema || schema['type'] !== 'object') return 'cu-unknown';
        if (schema['required'] !== undefined && (!Array.isArray(schema['required']) || schema['required'].length !== 0)) return 'cu-unknown';
        const properties = schema['properties'] === undefined ? {} : object(schema['properties']);
        if (!properties || Object.keys(properties).length !== 0) return 'cu-unknown';
    }
    return 'cu-approval';
}

export function isComputerUseApproval(msg: unknown): boolean {
    const message = object(msg);
    return message !== null && hasId(message) && classifyElicitation(message) === 'cu-approval';
}

export function approvalReply(id: string | number, policy: ApprovalPolicy): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result: policy === 'auto'
        ? { action: 'accept', content: {} }
        : { action: 'decline' } };
}

export function withElicitationCapability(initializeMsg: unknown): unknown {
    const message = object(initializeMsg);
    if (message?.['method'] !== 'initialize') return initializeMsg;
    const params = object(message['params']) ?? {};
    const capabilities = object(params['capabilities']) ?? {};
    const elicitation = object(capabilities['elicitation']) ?? {};
    return { ...message, params: { ...params, capabilities: {
        ...capabilities, elicitation: { ...elicitation, form: {} },
    } } };
}

function readLines(input: Readable, onLine: (line: string) => void, onEnd: () => void): void {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const consume = (text: string): void => {
        pending += text;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
            const line = pending.slice(0, newline + 1);
            pending = pending.slice(newline + 1);
            onLine(line);
            newline = pending.indexOf('\n');
        }
    };
    input.on('data', (chunk: Buffer | string) => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
    input.once('end', () => {
        consume(decoder.end());
        if (pending) onLine(pending);
        onEnd();
    });
}

function parseLine(line: string): JsonObject | null {
    try { return object(JSON.parse(line)); } catch { return null; }
}

const MISSING_PLUGIN_MESSAGE = 'precondition failed: Codex Computer Use (unified-computer-use cua_repl) not found under <codexHome>/plugins/cache/openai-bundled. Install the ChatGPT desktop app with Computer Use enabled.';

function writeResponse(output: Writable, reply: JsonRpcResponse): void {
    output.write(`${JSON.stringify(reply)}\n`);
}

function logValue(value: unknown): string {
    return typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 200) : '-';
}

export async function runComputerUseProxy(io: ProxyIo, opts: {
    spec: CuaReplSpec | null;
    policy: ApprovalPolicy;
    spawnChild?: (spec: CuaReplSpec) => ChildProcessWithoutNullStreams;
    onChild?: (child: ChildProcessWithoutNullStreams) => void;
}): Promise<number> {
    if (!opts.spec) {
        return new Promise(resolve => {
            let finished = false;
            readLines(io.input, line => {
                if (finished) return;
                const msg = parseLine(line);
                if (!msg || !hasId(msg) || typeof msg['method'] !== 'string') return;
                writeResponse(io.output, { jsonrpc: '2.0', id: msg['id'],
                    error: { code: -32002, message: MISSING_PLUGIN_MESSAGE } });
                if (msg['method'] === 'initialize') {
                    finished = true;
                    io.output.end();
                    resolve(1);
                }
            }, () => resolve(1));
        });
    }

    const spec = opts.spec;
    return new Promise(resolve => {
        let child: ChildProcessWithoutNullStreams;
        let pendingInitializeId: string | number | undefined;
        let initialized = false;
        let settled = false;
        const finish = (code: number): void => {
            if (settled) return;
            settled = true;
            resolve(code);
        };
        try {
            child = opts.spawnChild
                ? opts.spawnChild(spec)
                : spawn(spec['command'], spec['args'], { env: { ...process['env'], ...spec['env'] }, stdio: 'pipe' });
            opts.onChild?.(child);
        } catch (error) {
            io.errorOutput.write(`[jaw-computer-use] spawn failed: ${String(error)}\n`);
            finish(1);
            return;
        }

        child.stderr.pipe(io.errorOutput, { end: false });
        child.once('error', error => {
            io.errorOutput.write(`[jaw-computer-use] spawn failed: ${error.message}\n`);
            if (pendingInitializeId !== undefined) writeResponse(io.output, { jsonrpc: '2.0', id: pendingInitializeId,
                error: { code: -32002, message: `precondition failed: Computer Use proxy child could not start: ${error.message}` } });
            finish(1);
        });
        // 'close' follows stdout/stderr EOF, so the final protocol line is observed first.
        child.once('close', code => finish(code ?? 0));
        child.stdin.on('error', error => {
            if (!settled && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
                io.errorOutput.write(`[jaw-computer-use] child stdin failed: ${error.message}\n`);
            }
        });

        readLines(io.input, line => {
            if (settled) return;
            const msg = parseLine(line);
            // Newer clients probe with server/discover before initialize. cua_repl's
            // rmcp transport treats any pre-initialize request as fatal and exits, so
            // answer the probe here and let the client fall back to initialize.
            if (!initialized && msg && hasId(msg) && msg['method'] === 'server/discover') {
                writeResponse(io.output, { jsonrpc: '2.0', id: msg['id'],
                    error: { code: -32601, message: 'Method not found: server/discover' } });
                return;
            }
            if (msg?.['method'] === 'initialize') {
                initialized = true;
                if (hasId(msg)) pendingInitializeId = msg['id'];
                child.stdin.write(`${JSON.stringify(withElicitationCapability(msg))}\n`);
            } else {
                child.stdin.write(line);
            }
        }, () => { if (!settled) child.stdin.end(); });

        readLines(child.stdout, line => {
            if (settled) return;
            const msg = parseLine(line);
            if (msg && pendingInitializeId !== undefined && msg['id'] === pendingInitializeId) pendingInitializeId = undefined;
            const kind = classifyElicitation(msg);
            if (kind === 'other') {
                io.output.write(line);
                return;
            }
            if (!msg || !hasId(msg)) {
                io.errorOutput.write('[jaw-computer-use] dropped id-less computer-use elicitation\n');
                return;
            }
            const action = kind === 'cu-approval' && opts.policy === 'auto' ? 'accept' : 'decline';
            writeResponse(child.stdin, approvalReply(msg['id'], action === 'accept' ? 'auto' : 'safe'));
            const meta = object(object(msg['params'])?.['_meta']);
            const app = object(meta?.['tool_params'])?.['app'];
            io.errorOutput.write(`[jaw-computer-use] ${action} ${logValue(meta?.['tool_name'])} ${logValue(app)}\n`);
        }, () => undefined);
    });
}
