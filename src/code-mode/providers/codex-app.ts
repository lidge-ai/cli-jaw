import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { CodexAppClient, type CodexAppClientOptions, type CodexThreadOptions } from '../../agent/codex-app-client.js';
import { applyCodexAppTextEvent, listenCodexAppTurnAdapter, readCodexAppThreadId,
    readCodexAppTurnId } from '../../agent/codex-app-events.js';
import { appendBoundedFullText, FULLTEXT_MAX_CHARS } from '../../agent/events/fulltext-bound.js';
import { hasChildExited, ownProcess } from '../../agent/spawn/process-kill.js';
import { CodexProjection } from '../../agent/runtime/codex-projection.js';
import { RuntimeProjection } from '../../agent/runtime/projection.js';
import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';
import type { SpawnContext } from '../../types/agent.js';
import type { CodeOpenOptions, CodeProvider, CodeProviderSession, CodeTurnContext } from '../provider.js';
import { admitCodeOpen, captureCodeContext, CODE_PROMPT_TIMEOUT_MS, type CodeProviderDependencies } from './acp.js';

type NativeFactory = (options: CodexAppClientOptions) => CodexAppClient;
type Turn = {
    context: Readonly<CodeTurnContext>; projection: RuntimeProjection; text: SpawnContext;
    nativeTurn: string | null; items: Map<string, string>; cancelled: boolean;
    complete(status: RuntimeTurnOutcome['status']): void;
};
const MAX_NATIVE_ITEMS = 4096;
const CODEX_GRACEFUL_CLOSE_MS = 1000;
const CODEX_EXIT_DEADLINE_MS = 6000;
type CodexPermissionMode = Extract<CodeOpenOptions['permissionMode'], 'ask' | 'auto' | 'read-only'>;
const policy: Record<CodexPermissionMode, Pick<CodexThreadOptions, 'approvalPolicy' | 'sandbox'>> = {
    ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
    auto: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
    'read-only': { approvalPolicy: 'never', sandbox: 'read-only' },
};
/** Claude-only modes (plan, accept-edits, dont-ask, auto-review) have no Codex equivalent. */
function codexPolicy(mode: CodeOpenOptions['permissionMode']): Pick<CodexThreadOptions, 'approvalPolicy' | 'sandbox'> {
    if (mode !== 'ask' && mode !== 'auto' && mode !== 'read-only') throw new Error('code_provider_policy_unsupported');
    return policy[mode];
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * An empty granted profile is the native runtime's decline, not a no-op.
 *
 * codex-rs short-circuits an empty profile and records no grant
 * (core/src/session/mod.rs:3118-3141), the TUI's Deny button emits exactly this
 * payload (tui/src/bottom_pane/approval_overlay.rs:1968-2002), and analytics
 * scores it Denied (analytics/src/reducer.rs:3095-3096). Verified against
 * codex-rs 095da4b7e8b70b01afb5c6131ef926dcb8c0d85d.
 */
const PERMISSIONS_DENY = { permissions: {}, scope: 'turn' };
const PERMISSION_REASON_MAX = 200;

/** What the model asked for, in the words the person approving it needs. */
function permissionLabel(requested: Record<string, unknown>, reason: unknown): string {
    const asked = Object.keys(requested).map(key => key === 'fileSystem' ? 'file system' : key).join(' and ');
    const why = typeof reason === 'string' && reason.trim()
        ? `: ${reason.trim().slice(0, PERMISSION_REASON_MAX)}` : '';
    return `Grant ${asked || 'additional'} access for this turn${why}`;
}

class CodeCodexSession implements CodeProviderSession {
    private readonly client: CodexAppClient;
    private readonly scope: string;
    private nativeId = '';
    private active: Turn | null = null;
    private closing: Promise<void> | undefined;
    private exited = false;
    private child: ChildProcess | null = null;
    private cleanupComplete = false;

    constructor(private readonly options: CodeOpenOptions, dependencies: CodeProviderDependencies, create: NativeFactory) {
        this.scope = `code:${options.sessionId}`;
        this.client = create({ binary: dependencies.binary(), workDir: options.cwd, env: dependencies.environment(),
            unknownNotificationPolicy: 'diagnostic-only',
            serverRequest: (method, params, rpcId, signal) => this.approval(method, params, rpcId, signal) });
        this.client.on('exit', (code: number | null) => this.exit(code === 0 ? null : new Error('code_codex_exit')));
        this.client.on('error', () => this.exit(new Error('code_codex_error')));
    }
    get nativeSessionId(): string { return this.nativeId; }
    get alive(): boolean {
        const child = this.child ?? this.client.proc;
        return child ? !hasChildExited(child) : !this.closing && !this.exited && this.client.alive;
    }
    get closed(): boolean {
        const child = this.child ?? this.client.proc;
        return child ? hasChildExited(child) : this.cleanupComplete;
    }
    private exit(error: Error | null): void {
        if (this.exited) return;
        this.exited = true;
        this.active?.complete(this.active.cancelled ? 'stopped' : 'error');
        this.options.onExit(error);
    }
    private abort = () => { void this.close().catch(() => console.warn('[code:codex] cleanup_unconfirmed')); };

    async open(): Promise<void> {
        const context = captureCodeContext(this.options);
        this.options.signal.addEventListener('abort', this.abort, { once: true });
        try {
            if (this.options.signal.aborted || this.closing) throw new Error('code_provider_open_aborted');
            this.client.spawn();
            this.child = this.client.proc;
            if (this.child) ownProcess(this.child);
            await this.client.initialize();
            if (!context.isCurrent() || this.options.signal.aborted) throw new Error('code_provider_open_aborted');
            const thread: CodexThreadOptions = { model: this.options.model, effort: this.options.effort ?? '',
                cwd: this.options.cwd, fastMode: false, ...codexPolicy(this.options.permissionMode) };
            this.nativeId = this.options.nativeCursor === null
                ? await this.client.startThread(this.scope, thread)
                : await this.client.resumeThread(this.scope, this.options.nativeCursor, thread);
            if (!this.nativeId || !context.isCurrent() || this.options.signal.aborted || !this.alive || this.exited || this.closing) {
                throw new Error('code_provider_open_aborted');
            }
            if (this.options.nativeCursor !== null && this.nativeId !== this.options.nativeCursor) {
                throw new Error('code_provider_resume_identity_changed');
            }
            this.options.onNativeCursor(this.nativeId, context);
        } catch (error) { await this.close(); throw error; }
    }

    async send(text: string): Promise<RuntimeTurnOutcome> {
        if (!this.alive || this.exited || this.closing || this.active) throw new Error('code_codex_not_idle');
        if (text.length > FULLTEXT_MAX_CHARS) throw new Error('code_codex_prompt_limit');
        const context = captureCodeContext(this.options);
        const state: SpawnContext = { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(),
            hasClaudeStreamEvents: false, sessionId: null, cost: null, turns: null, duration: null, tokens: null, stderrBuf: '' };
        const projection = new RuntimeProjection(context, this.options.record, undefined, this.options.transcript(context));
        const mapper = new CodexProjection(projection);
        let resolve!: (outcome: RuntimeTurnOutcome) => void;
        const result = new Promise<RuntimeTurnOutcome>(yes => { resolve = yes; });
        let listener: { dispose(): void } | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let completed = false, sawAnswer = false;
        const turn: Turn = { context, projection, text: state, nativeTurn: null, items: new Map(), cancelled: false,
            complete: status => {
                if (completed) return;
                completed = true;
                if (timer) clearTimeout(timer);
                listener?.dispose();
                this.options.registry.cancelRun(context.runId);
                if (turn.cancelled || !context.isCurrent()) status = 'stopped';
                const outcome: RuntimeTurnOutcome = { status,
                    finalText: status === 'done' && sawAnswer ? state.fullText : null, partialText: state.fullText };
                try { projection.close({ kind: 'turn-end', status, finalText: outcome.finalText }); }
                finally { if (this.active === turn) this.active = null; resolve(outcome); }
            } };
        this.active = turn;
        let itemId = '';
        let beforeItem: SpawnContext = { ...state };
        listener = listenCodexAppTurnAdapter(this.client, { threadId: this.nativeId }, this.scope, state, {
            onProgress() {}, onRawNotification() {}, onStderr() {},
            onEvent() {},
            onProjectionNotification: (method, params, parsed) => {
                if (this.active !== turn || !context.isCurrent()) return;
                const nativeTurn = this.client.getActiveTurnId(this.scope);
                if (!nativeTurn || (turn.nativeTurn !== null && turn.nativeTurn !== nativeTurn)) return;
                if (readCodexAppThreadId(params) !== this.nativeId || readCodexAppTurnId(params) !== nativeTurn) return;
                turn.nativeTurn = nativeTurn;
                const item = object(params['item']);
                const ref = item['id'];
                if (typeof ref === 'string' && ref && ref.length <= 1024
                    && (turn.items.has(ref) || turn.items.size < MAX_NATIVE_ITEMS)) {
                    if (method === 'item/completed') turn.items.set(ref, 'completed');
                    else if (method === 'item/started' && !turn.items.has(ref) && typeof item['type'] === 'string') {
                        turn.items.set(ref, item['type']);
                    }
                }
                if (parsed?.itemId && parsed.itemId !== itemId) {
                    itemId = parsed.itemId; beforeItem = { ...state };
                }
                if (parsed && method !== 'error') {
                    const decision = applyCodexAppTextEvent(state, parsed);
                    const appended = appendBoundedFullText(state.fullText, decision.durable);
                    state.fullText = appended.text; state.fullTextTruncated ||= appended.truncated;
                    if (parsed.text !== undefined && state.codexAppActiveChannel !== 'commentary') sawAnswer = true;
                }
                mapper.observe(method, params, parsed, state.codexAppActiveChannel ?? '');
                // Conversation size, reported alongside the turn but not part of
                // it: it is a property of the session, so it is handed to the
                // session rather than folded into this turn's transcript.
                if (parsed?.contextUsage) {
                    this.options.onContextUsage({ ...parsed.contextUsage, updatedAt: Date.now() });
                }
                if (method === 'item/completed' && item['type'] === 'agentMessage'
                    && typeof item['id'] === 'string' && item['id'].length > 0 && item['id'].length <= 1024
                    && typeof item['text'] === 'string') {
                    const id = item['id'], full = item['text'];
                    const phase = item['phase'] === 'commentary' ? 'commentary'
                        : item['phase'] === 'final_answer' ? 'final' : 'unknown';
                    // The native terminal replaces the SAME item, including omitted or corrected deltas.
                    projection.text('message', id, full, 'replace', phase);
                    if (id !== itemId) { itemId = id; beforeItem = { ...state }; }
                    const effective = phase === 'unknown' && state.codexAppActiveItemId === id
                        ? state.codexAppActiveChannel : phase === 'unknown' ? undefined : phase;
                    const rebuilt: SpawnContext = { ...beforeItem };
                    const decision = applyCodexAppTextEvent(rebuilt, {
                        itemId: id, messageStarted: true, text: full, channel: effective,
                    });
                    const bounded = appendBoundedFullText(rebuilt.fullText, decision.durable);
                    rebuilt.fullText = bounded.text; rebuilt.fullTextTruncated ||= bounded.truncated;
                    Object.assign(state, rebuilt);
                    if (effective !== 'commentary') sawAnswer = true;
                }
                if (method === 'turn/completed') {
                    const status = parsed?.turnStatus;
                    turn.complete(status === 'completed' ? 'done' : status === 'interrupted' ? 'stopped' : 'error');
                }
            },
            onError: () => turn.complete('error'), onExit: () => turn.complete('error'),
            onInterruptFailed: () => { turn.complete('error'); this.abort(); },
        });
        if (completed) listener.dispose();
        else {
            timer = setTimeout(() => { turn.complete('error'); this.abort(); }, CODE_PROMPT_TIMEOUT_MS);
            projection.start('codex-app');
            try {
                if (!context.isCurrent() || this.options.signal.aborted) throw new Error('code_codex_owner_stale');
                await this.client.startTurn(this.scope, text);
            } catch { turn.complete('error'); await this.close(); }
        }
        return result;
    }

    private async approval(method: string, params: Record<string, unknown>, _rpcId: number | string,
        signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
        // Each method answers in its own vocabulary. A command decline is not a
        // valid PermissionsRequestApprovalResponse, so they cannot share a body.
        if (method === 'item/permissions/requestApproval') return this.approvePermissions(params, signal);
        if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') return undefined;
        const decline = { decision: 'decline' };
        const turn = this.active;
        if (!turn || this.options.permissionMode === 'read-only') return decline;
        const nativeTurn = this.client.getActiveTurnId(this.scope);
        const requestedItem = params['itemId'];
        const expectedType = method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution';
        const current = () => this.active === turn && this.alive && !this.exited && !this.closing && !turn.cancelled && !signal.aborted
            && turn.context.isCurrent() && !!turn.nativeTurn && this.client.getActiveTurnId(this.scope) === turn.nativeTurn
            && typeof requestedItem === 'string' && turn.items.get(requestedItem) === expectedType;
        if (!nativeTurn || turn.nativeTurn !== nativeTurn || !current()
            || params['threadId'] !== this.nativeId || params['turnId'] !== nativeTurn) return decline;
        const decisions = params['availableDecisions'];
        if (decisions !== undefined && (!Array.isArray(decisions) || !decisions.includes('accept'))) return decline;
        if (this.options.permissionMode === 'auto') return { decision: 'accept' };
        const accept = randomUUID(), reject = randomUUID();
        const request = this.options.registry.open({ ...turn.context, requestType: 'approval',
            view: { title: method === 'item/fileChange/requestApproval' ? 'Approve file change' : 'Approve command',
                fields: [{ id: randomUUID(), label: 'Permission', multiSelect: false, allowFreeform: false,
                    options: [{ id: accept, label: 'Allow once' }, { id: reject, label: 'Decline' }] }] },
            cancelled: decline, isCurrent: current,
            validate(value) {
                const answer = object(value);
                if (Object.keys(answer).length !== 1 || !Object.hasOwn(answer, 'optionId')
                    || (answer['optionId'] !== accept && answer['optionId'] !== reject)) throw new Error('invalid_option');
                return { decision: answer['optionId'] === accept ? 'accept' : 'decline' };
            },
        });
        const abort = () => request.cancel();
        signal.addEventListener('abort', abort, { once: true });
        try {
            if (!current()) request.cancel();
            else if (!this.options.record(turn.context, { kind: 'request', requestId: request.requestId,
                requestType: 'approval', view: request.view })) request.cancel();
            const answer = await request.answer;
            return current() ? answer : decline;
        } finally {
            signal.removeEventListener('abort', abort);
            request.cancel();
            this.options.record(turn.context, { kind: 'request-settled', requestId: request.requestId });
        }
    }

    /**
     * Structured permission requests, which ask mode promised the user would see.
     *
     * These were previously unhandled here, so the client answered them with its
     * own fallback and the request never reached the queue. That fallback is the
     * canonical decline, so nothing was over-granted — but ask mode silently
     * refused network and MCP requests while telling the user it would show them.
     */
    private async approvePermissions(params: Record<string, unknown>,
        signal: AbortSignal): Promise<Record<string, unknown>> {
        const requested = object(params['permissions']);
        const turn = this.active;
        // An empty ask cannot be granted into anything, so it declines before the queue.
        if (!turn || this.options.permissionMode === 'read-only' || Object.keys(requested).length === 0) return PERMISSIONS_DENY;
        const nativeTurn = this.client.getActiveTurnId(this.scope);
        const requestedItem = params['itemId'];
        // A permissions request names the tool item that asked, whose native type
        // this protocol does not fix, so ownership is "this turn has seen it and it
        // has not settled" rather than a command/file type literal.
        const current = () => this.active === turn && this.alive && !this.exited && !this.closing && !turn.cancelled && !signal.aborted
            && turn.context.isCurrent() && !!turn.nativeTurn && this.client.getActiveTurnId(this.scope) === turn.nativeTurn
            && typeof requestedItem === 'string' && turn.items.has(requestedItem) && turn.items.get(requestedItem) !== 'completed';
        if (!nativeTurn || turn.nativeTurn !== nativeTurn || !current()
            || params['threadId'] !== this.nativeId || params['turnId'] !== nativeTurn) return PERMISSIONS_DENY;
        // Core intersects a grant with what was requested, so echoing the request
        // grants exactly what was asked and cannot widen it.
        const grant = { permissions: requested, scope: 'turn' };
        if (this.options.permissionMode === 'auto') return grant;
        const accept = randomUUID(), reject = randomUUID();
        const request = this.options.registry.open({ ...turn.context, requestType: 'approval',
            view: { title: 'Approve additional permissions',
                fields: [{ id: randomUUID(), label: permissionLabel(requested, params['reason']), multiSelect: false,
                    allowFreeform: false, options: [{ id: accept, label: 'Allow once' }, { id: reject, label: 'Decline' }] }] },
            cancelled: PERMISSIONS_DENY, isCurrent: current,
            validate(value) {
                const answer = object(value);
                if (Object.keys(answer).length !== 1 || !Object.hasOwn(answer, 'optionId')
                    || (answer['optionId'] !== accept && answer['optionId'] !== reject)) throw new Error('invalid_option');
                return answer['optionId'] === accept ? grant : PERMISSIONS_DENY;
            },
        });
        const abort = () => request.cancel();
        signal.addEventListener('abort', abort, { once: true });
        try {
            if (!current()) request.cancel();
            else if (!this.options.record(turn.context, { kind: 'request', requestId: request.requestId,
                requestType: 'approval', view: request.view })) request.cancel();
            const answer = await request.answer;
            return current() ? answer : PERMISSIONS_DENY;
        } finally {
            signal.removeEventListener('abort', abort);
            request.cancel();
            this.options.record(turn.context, { kind: 'request-settled', requestId: request.requestId });
        }
    }

    async cancel(): Promise<void> {
        if (!this.active) return;
        this.active.cancelled = true;
        this.options.registry.cancelRun(this.active.context.runId);
        try { await this.gracefulWindow(this.client.interruptTurn(this.scope)); }
        finally { await this.close(); }
    }

    private async gracefulWindow(operation: Promise<void>): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([operation.catch(() => undefined), new Promise<void>(resolve => {
                timer = setTimeout(resolve, CODEX_GRACEFUL_CLOSE_MS);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }

    private async closeOwnedChild(): Promise<void> {
        const child = this.child ?? this.client.proc;
        if (!child) {
            // Constructor-injected clients and failures before spawn have no PID authority.
            await this.client.closeGracefully();
            this.client.cleanup();
            this.cleanupComplete = true;
            this.exit(null);
            return;
        }
        const owned = ownProcess(child);
        let resolveExit!: () => void;
        const exited = new Promise<void>(resolve => { resolveExit = resolve; });
        let cleaned = false;
        let disposalError: unknown;
        const receipt = () => {
            if (cleaned || !hasChildExited(child)) return;
            cleaned = true;
            child.off('exit', receipt); child.off('close', receipt);
            owned.complete();
            try { this.client.cleanup(); this.cleanupComplete = true; this.exit(null); }
            catch (error) { disposalError = error; }
            finally { resolveExit(); }
        };
        // Keep this receipt after a deadline failure: late exit permits safe disposal,
        // but cannot turn the original rejected close promise into a success.
        child.on('exit', receipt); child.on('close', receipt);
        receipt();
        if (cleaned) { if (disposalError !== undefined) throw disposalError; return; }
        await this.gracefulWindow(Promise.race([
            Promise.resolve().then(() => this.client.closeGracefully()), exited,
        ]));
        if (!hasChildExited(child)) owned.terminate('shutdown');
        receipt();
        if (cleaned) { if (disposalError !== undefined) throw disposalError; return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([exited, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    receipt();
                    if (!cleaned) reject(new Error('code_codex_cleanup_unconfirmed'));
                }, CODEX_EXIT_DEADLINE_MS);
            })]);
        } finally { if (timer) clearTimeout(timer); }
        if (disposalError !== undefined) throw disposalError;
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.options.signal.removeEventListener('abort', this.abort);
        if (this.active) {
            this.active.cancelled = true;
            this.options.registry.cancelRun(this.active.context.runId);
        }
        this.closing = Promise.resolve().then(() => this.closeOwnedChild());
        return this.closing;
    }
}

export function createCodexCodeProvider(dependencies: CodeProviderDependencies,
    create: NativeFactory = options => new CodexAppClient(options)): CodeProvider {
    return { id: 'codex-app', describe: dependencies.describe,
        async open(options) {
            admitCodeOpen(options, dependencies);
            const session = new CodeCodexSession(options, dependencies, create);
            try { options.onResource(session); await session.open(); }
            catch (error) { await session.close(); throw error; }
            return session;
        } };
}
