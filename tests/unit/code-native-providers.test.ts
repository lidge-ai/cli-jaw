import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CodeOpenOptions, CodeRuntimeResource, CodeTurnContext } from '../../src/code-mode/provider.ts';
import type { RuntimeEvent, RuntimePhase, RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { CodexAppClientOptions, CodexThreadOptions } from '../../src/agent/codex-app-client.ts';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.ts';
import type { CursorSessionOptions } from '../../src/agent/runtime/acp/cursor-session.ts';
import { RuntimeRequests, runtimeRequests } from '../../src/agent/runtime/requests.ts';
import { hasChildExited, ownProcess } from '../../src/agent/spawn/process-kill.ts';

let jawEffects = 0;
const forbidden = () => { jawEffects++; throw new Error('Unexpected Jaw side effect'); };
mock.module('../../src/trace/activity-journal.js', {
    namedExports: { appendActivityBody: forbidden, markActivityFailure: forbidden },
});
mock.module('../../src/core/event-bus.js', { namedExports: { publish: forbidden } });
const { createCodeProviders } = await import('../../src/code-mode/providers/catalog.ts');
const { CodexAppClient } = await import('../../src/agent/codex-app-client.ts');
const { AcpSession } = await import('../../src/agent/runtime/acp/session.ts');
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');

function owner(patch: Partial<CodeOpenOptions> = {}) {
    let current = true, sequence = 0;
    let context: CodeTurnContext = { runId: 'code-run-1', sessionId: 'code-session', scope: 'code:code-session',
        turnId: 'code-turn-1', epoch: 7, audience: 'internal', isCurrent: () => current };
    const controller = new AbortController();
    const registry = new RuntimeRequests();
    const resources: CodeRuntimeResource[] = [];
    const events: RuntimeEvent[] = [], exits: Array<Error | null> = [];
    const cursors: Array<{ cursor: string | null; context?: RuntimeEventContext }> = [];
    const patches: Array<{ context: RuntimeEventContext; kind: string; ref: string; text: string;
        operation: string; phase: RuntimePhase }> = [];
    const closes: RuntimeTurnOutcome['status'][] = [];
    const options: CodeOpenOptions = { sessionId: 'code-session', cwd: process.cwd(), model: 'fixture-model',
        effort: null, permissionMode: 'auto', nativeCursor: null, signal: controller.signal, registry,
        onResource: resource => { resources.push(resource); },
        getTurnContext: () => context,
        record: (captured, body) => {
            assert.equal(captured.audience, 'internal');
            const event: RuntimeEvent = { ...captured, ...body, version: 1, seq: ++sequence };
            events.push(event); return event;
        },
        transcript: captured => ({
            text(kind, ref, text, operation, phase) { patches.push({ context: captured, kind, ref, text, operation, phase }); },
            tool() {}, close(end) { closes.push(end.status); },
        }),
        resolveTranscriptParent: () => 'code-parent',
        onNativeCursor(cursor, captured) { cursors.push({ cursor, ...(captured ? { context: captured } : {}) }); },
        onExit: error => { exits.push(error); }, ...patch };
    return { options, controller, registry, resources, events, patches, cursors, exits, closes,
        context: () => context, stale: () => { current = false; },
        next() { context = { ...context, runId: 'code-run-2', turnId: 'code-turn-2', epoch: 8 }; } };
}
const detection = (binary: string) => ({ available: true, path: `/native/${binary}` });

class CodexFixture extends CodexAppClient {
    running = false;
    thread = '';
    turn: string | null = null;
    scope = '';
    closes = 0;
    starts = 0;
    resumes = 0;
    interrupts = 0;
    failure: 'initialize' | 'resume' | null = null;
    threadOptions: CodexThreadOptions | undefined;
    script: (client: CodexFixture) => void = client => {
        client.message('native-message', 'x'.repeat(6000), true);
        client.finish();
    };
    constructor(readonly input: CodexAppClientOptions) { super(input); }
    override get alive() { return this.running; }
    override spawn() { this.running = true; }
    override async initialize() {
        if (this.failure === 'initialize') throw new Error('fixture_initialize_failed');
        return {};
    }
    override async startThread(scope: string, options: CodexThreadOptions) {
        this.starts++; this.scope = scope; this.threadOptions = options; this.thread = 'native-thread'; return this.thread;
    }
    override async resumeThread(scope: string, id: string, options: CodexThreadOptions) {
        this.resumes++; this.scope = scope; this.threadOptions = options;
        if (this.failure === 'resume') throw new Error('fixture_resume_failed');
        this.thread = id; return id;
    }
    override getThreadId() { return this.thread; }
    override getActiveTurnId() { return this.turn; }
    override async startTurn() {
        this.turn = 'native-turn';
        this.notification('turn/started', { turn: { id: this.turn } });
        this.script(this);
    }
    notification(method: string, body: Record<string, unknown>, wire: Record<string, unknown> = {}) {
        this.emit(`notification:${this.scope}`, method, { threadId: this.thread, turnId: this.turn, ...body, ...wire },
            { threadId: this.thread, turnId: this.turn });
    }
    message(id: string, text: string, delta = false, phase = 'final_answer') {
        this.notification('item/started', { item: { id, type: 'agentMessage', phase } });
        if (delta) this.notification('item/agentMessage/delta', { itemId: id, delta: text.slice(0, 20) });
        this.notification('item/completed', { item: { id, type: 'agentMessage', phase, text } });
    }
    finish(status = 'completed') {
        this.notification('turn/completed', { turn: { id: this.turn, status } }); this.turn = null;
    }
    override async interruptTurn() { this.interrupts++; this.finish('interrupted'); }
    override async closeGracefully() { this.closes++; this.running = false; this.emit('exit', 0, null); }
    override cleanup() { this.removeAllListeners(); }
    request(patch: Record<string, unknown> = {}, method = 'item/commandExecution/requestApproval', signal = new AbortController().signal) {
        return this.input.serverRequest!(method, {
            threadId: this.thread, turnId: this.turn, itemId: 'native-tool', ...patch,
        }, 'rpc-1', signal);
    }
}

async function codexFixture(patch: Partial<CodeOpenOptions> = {}, configure?: (client: CodexFixture) => void) {
    const f = owner(patch);
    let client!: CodexFixture;
    const providers = createCodeProviders({ detect: detection, codex: input => {
        client = new CodexFixture(input); configure?.(client); return client;
    } });
    const session = await providers['codex-app'].open(f.options);
    return { ...f, session, client };
}

test('catalog is exhaustive, detached from native factories, and honest about registry and policies', () => {
    const lookedUp: string[] = [];
    const providers = createCodeProviders({ detect: binary => { lookedUp.push(binary); return detection(binary); },
        codex: forbidden, claude: forbidden, cursor: forbidden, grok: forbidden, liveModels: () => null });
    assert.deepEqual(Object.keys(providers), ['codex-app', 'claude', 'cursor', 'grok']);
    const catalogs = Object.values(providers).map(provider => provider.describe());
    assert.deepEqual(lookedUp, ['codex', 'claude', 'cursor-agent', 'grok']);
    assert.deepEqual(catalogs.map(c => c.capabilities.permissionModes), [
        ['ask', 'auto', 'read-only'], ['ask', 'accept-edits', 'plan', 'auto-review', 'dont-ask', 'auto'], ['ask', 'auto'], ['auto'],
    ]);
    assert.ok(catalogs.every(c => c.available && c.modelSource === 'registry' && !c.capabilities.setModelMidSession));
    assert.ok(catalogs.every(c => c.models.includes(c.defaultModel)));
    catalogs[0]!.models.length = 0;
    assert.ok(providers['codex-app'].describe().models.length > 0);
    assert.equal(jawEffects, 0);
});

test('a live Codex catalog replaces the static model list for codex-app only', () => {
    const live = { models: ['gpt-6-astra', 'anthropic/claude-opus-5'], source: 'opencodex' as const,
        effortsByModel: { 'gpt-6-astra': ['low', 'ultra'], 'anthropic/claude-opus-5': [] },
        defaultEffortByModel: { 'gpt-6-astra': 'low' }, efforts: ['low', 'ultra'] };
    const providers = createCodeProviders({ detect: detection, codex: forbidden, claude: forbidden,
        cursor: forbidden, grok: forbidden, liveModels: () => live });
    const codex = providers['codex-app'].describe();
    assert.equal(codex.modelSource, 'live');
    assert.deepEqual(codex.models, ['gpt-6-astra', 'anthropic/claude-opus-5']);
    assert.deepEqual(codex.capabilities.efforts, ['low', 'ultra']);
    assert.deepEqual(codex.effortsByModel?.['anthropic/claude-opus-5'], []);
    // The static default (gpt-5.5) is not in the live catalog, so it must not survive.
    assert.equal(codex.defaultModel, 'gpt-6-astra');
    // A shared snapshot must not leak into the ACP/SDK runtimes.
    for (const id of ['claude', 'cursor', 'grok'] as const) {
        assert.equal(providers[id].describe().modelSource, 'registry');
    }
    // Callers must not be able to mutate the shared snapshot through the catalog.
    codex.models.length = 0;
    assert.equal(providers['codex-app'].describe().models.length, 2);
});

test('an empty or degraded live snapshot leaves the registry catalog intact', () => {
    const empty = { models: [], effortsByModel: {}, defaultEffortByModel: {}, efforts: [], source: 'static' as const };
    const noEfforts = { models: ['routed/only'], effortsByModel: { 'routed/only': [] },
        defaultEffortByModel: {}, efforts: [], source: 'opencodex' as const };
    const build = (liveModels: () => typeof empty | typeof noEfforts | null) => createCodeProviders({
        detect: detection, codex: forbidden, claude: forbidden, cursor: forbidden, grok: forbidden, liveModels,
    })['codex-app'].describe();
    const fallback = build(() => empty);
    assert.equal(fallback.modelSource, 'registry');
    assert.ok(fallback.models.length > 0);
    // An all-routed catalog offers no effort at all; the union must not go empty
    // or every model loses its effort control at once.
    const routed = build(() => noEfforts);
    assert.deepEqual(routed.models, ['routed/only']);
    assert.ok(routed.capabilities.efforts.length > 0);
});

test('only the proxied runtime reads the live snapshot', () => {
    let reads = 0;
    const providers = createCodeProviders({ detect: detection, codex: forbidden, claude: forbidden,
        cursor: forbidden, grok: forbidden, liveModels: () => { reads += 1; return null; } });
    // Reading a Claude or Cursor catalog must not schedule a Codex probe.
    for (const id of ['claude', 'cursor', 'grok'] as const) providers[id].describe();
    assert.equal(reads, 0);
    providers['codex-app'].describe();
    assert.equal(reads, 1);
});

test('missing binaries remain unavailable without native factory calls', async () => {
    const providers = createCodeProviders({ detect: () => ({ available: false, path: null }),
        codex: forbidden, claude: forbidden, cursor: forbidden, grok: forbidden });
    for (const provider of Object.values(providers)) {
        assert.equal(provider.describe().available, false);
        await assert.rejects(provider.open(owner().options), /unavailable/);
    }
});

for (const mode of ['ask', 'auto', 'read-only'] as const) {
    test(`Codex ${mode} maps native thread policy and keeps resume cursor`, async t => {
        const f = await codexFixture({ permissionMode: mode, nativeCursor: 'saved-thread' });
        t.after(() => f.session.close());
        const expected = { ask: ['untrusted', 'workspace-write'], auto: ['never', 'danger-full-access'],
            'read-only': ['never', 'read-only'] }[mode];
        assert.equal(f.client.threadOptions?.approvalPolicy, expected[0]);
        assert.equal(f.client.threadOptions?.sandbox, expected[1]);
        assert.equal(f.client.starts, 0); assert.equal(f.client.resumes, 1);
        assert.equal(f.cursors[0]?.cursor, 'saved-thread');
        assert.equal(f.cursors[0]?.context?.turnId, 'code-turn-1');
    });
}

for (const delta of [false, true]) test(`Codex terminal fulltext uses the same item with partial deltas=${delta}`, async t => {
    const text = 'terminal '.repeat(900);
    const f = await codexFixture({}, client => { client.script = c => { c.message('same-item', text, delta); c.finish(); }; });
    t.after(() => f.session.close());
    const outcome = await f.session.send('prompt');
    assert.equal(outcome.finalText, text);
    const messages = f.patches.filter(p => p.kind === 'message');
    assert.deepEqual([...new Set(messages.map(p => p.ref))], ['same-item']);
    assert.equal(messages.at(-1)?.text, text);
    assert.equal(messages.at(-1)?.operation, 'replace');
    assert.deepEqual(f.closes, ['done']);
    assert.ok(f.events.filter(e => e.kind === 'message').every(e => e.text.length <= 3000));
});

test('Codex terminal-only restatement, continuation, and trailing commentary retain native answer selection', async t => {
    const f = await codexFixture({}, client => { client.script = c => {
        c.message('first', 'answer'); c.message('repeat', 'answer'); c.message('continuation', ' continued');
        c.message('comment', 'progress', false, 'commentary'); c.finish();
    }; });
    t.after(() => f.session.close());
    assert.equal((await f.session.send('prompt')).finalText, 'answer continued');
    assert.equal(f.patches.filter(p => p.operation === 'replace').length, 4);
});

for (const value of [null, '', ' \n\t ']) test(`Codex absent/empty/whitespace final: ${JSON.stringify(value)}`, async t => {
    const f = await codexFixture({}, client => { client.script = c => {
        if (value !== null) c.message('final', value); c.finish();
    }; });
    t.after(() => f.session.close());
    assert.equal((await f.session.send('prompt')).finalText, value);
});

test('Codex terminal corrections replace a partial item rather than aggregate it twice', async t => {
    const f = await codexFixture({}, client => { client.script = c => {
        c.notification('item/started', { item: { id: 'edit', type: 'agentMessage', phase: 'final_answer' } });
        c.notification('item/agentMessage/delta', { itemId: 'edit', delta: 'incorrect' });
        c.notification('item/completed', { item: { id: 'edit', type: 'agentMessage', phase: 'final_answer', text: 'correct' } });
        c.finish();
    }; });
    t.after(() => f.session.close());
    assert.equal((await f.session.send('prompt')).finalText, 'correct');
});

test('Codex foreign notification identities never reach the Code transcript', async t => {
    const f = await codexFixture({}, client => { client.script = c => {
        c.notification('item/completed', { item: { id: 'foreign', type: 'agentMessage', text: 'foreign text' } }, { threadId: 'foreign' });
        c.notification('item/agentMessage/delta', { itemId: 'foreign', delta: 'old text' }, { turnId: 'old-turn' });
        c.message('owned', 'owned text'); c.finish();
    }; });
    t.after(() => f.session.close());
    assert.equal((await f.session.send('prompt')).finalText, 'owned text');
    assert.deepEqual([...new Set(f.patches.map(p => p.ref))], ['owned']);
});

async function asking(mode: CodeOpenOptions['permissionMode'] = 'ask') {
    const f = await codexFixture({ permissionMode: mode }, client => {
        client.script = c => c.notification('item/started', {
            item: { id: 'native-tool', type: 'commandExecution', command: 'pwd' },
        });
    });
    const turn = f.session.send('prompt');
    return { ...f, turn };
}

test('Codex approval uses opaque one-time handles and rejects native/persistent decision values', async t => {
    const f = await asking(); t.after(() => f.session.close());
    const answer = f.client.request();
    const pending = f.registry.list('code-session')[0]!;
    assert.equal(pending.runId, 'code-run-1');
    const handles = pending.view.fields[0]!.options;
    assert.deepEqual(handles.map(h => h.label), ['Allow once', 'Decline']);
    for (const invalid of ['accept', 'acceptForSession', 'native-tool']) {
        assert.throws(() => f.registry.respond(pending.requestId, f.context(), { optionId: invalid }), /invalid_option/);
    }
    f.registry.respond(pending.requestId, f.context(), { optionId: handles[0]!.id });
    assert.deepEqual(await answer, { decision: 'accept' });
    assert.equal(f.registry.list('code-session').length, 0);
    assert.equal(runtimeRequests.list('code-session').length, 0);
    f.client.finish(); assert.equal((await f.turn).status, 'done');
});

for (const mismatch of [{ threadId: 'foreign' }, { turnId: 'previous' }, { itemId: 'unknown' },
    { threadId: undefined }, { availableDecisions: ['acceptForSession'] }]) {
    test(`Codex denies unverified request ${JSON.stringify(mismatch)}`, async t => {
        const f = await asking('auto'); t.after(() => f.session.close());
        assert.deepEqual(await f.client.request(mismatch), { decision: 'decline' });
        assert.equal(f.registry.list('code-session').length, 0);
        f.client.finish(); await f.turn;
    });
}

test('Codex read-only declines both plain approvals and structured permission requests explicitly', async t => {
    const f = await asking('read-only'); t.after(() => f.session.close());
    assert.deepEqual(await f.client.request(), { decision: 'decline' });
    // An empty granted profile is the runtime's decline, so read-only answers it
    // here rather than leaving the client fallback to speak for an unhandled method.
    assert.deepEqual(await f.client.request({ permissions: { network: true } }, 'item/permissions/requestApproval'),
        { permissions: {}, scope: 'turn' });
    assert.equal(f.registry.list('code-session').length, 0);
    f.client.finish(); await f.turn;
});

test('Codex declines completed items and mismatched native tool approval methods', async t => {
    const f = await asking('auto'); t.after(() => f.session.close());
    assert.deepEqual(await f.client.request({}, 'item/fileChange/requestApproval'), { decision: 'decline' });
    f.client.notification('item/completed', { item: { id: 'native-tool', type: 'commandExecution', status: 'completed' } });
    assert.deepEqual(await f.client.request(), { decision: 'decline' });
    f.client.finish(); await f.turn;
});

test('Codex item completion invalidates an already displayed permission before selection', async t => {
    const f = await asking(); t.after(() => f.session.close());
    const answer = f.client.request();
    const pending = f.registry.list('code-session')[0]!;
    f.client.notification('item/completed', { item: { id: 'native-tool', type: 'commandExecution', status: 'completed' } });
    assert.throws(() => f.registry.respond(pending.requestId, f.context(), {
        optionId: pending.view.fields[0]!.options[0]!.id,
    }), /request_not_current/);
    assert.deepEqual(await answer, { decision: 'decline' });
    f.client.finish(); await f.turn;
});

test('Codex stale ownership and native request abort both expire the owned decision', async t => {
    const f = await asking(); t.after(() => f.session.close());
    const controller = new AbortController();
    const answer = f.client.request({}, undefined, controller.signal);
    assert.equal(f.registry.list('code-session').length, 1);
    controller.abort();
    assert.deepEqual(await answer, { decision: 'decline' });
    f.stale();
    assert.deepEqual(await f.client.request(), { decision: 'decline' });
    await f.session.close(); assert.equal((await f.turn).status, 'stopped');
});

test('Codex cancel interrupts once and repeated close owns one cleanup and exit', async () => {
    const f = await asking();
    const answer = f.client.request();
    await f.session.cancel(); await f.session.close(); await f.session.close();
    assert.equal(f.session.closed, true);
    assert.deepEqual(await answer, { decision: 'decline' });
    assert.equal((await f.turn).status, 'stopped');
    assert.equal(f.client.interrupts, 1); assert.equal(f.client.closes, 1); assert.equal(f.exits.length, 1);
});

test('Codex process-less cleanup rejection cannot invent an exit or a closed receipt', async () => {
    const f = await codexFixture();
    f.client.closeGracefully = async () => { f.client.closes++; throw new Error('fixture_close_failed'); };
    await assert.rejects(f.session.close(), /fixture_close_failed/);
    await assert.rejects(f.session.close(), /fixture_close_failed/);
    assert.equal(f.client.closes, 1); assert.equal(f.exits.length, 0);
    assert.equal(f.session.closed, false);
});

test('Codex process-less factory needs successful cleanup even after its synthetic exit event', async () => {
    const f = await codexFixture();
    let finish!: () => void, started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    f.client.closeGracefully = () => {
        f.client.emit('exit', 0, null); started();
        return new Promise<void>(resolve => { finish = resolve; });
    };
    const closing = f.session.close(); await begun;
    assert.equal(f.session.closed, false);
    finish(); await closing;
    assert.equal(f.session.closed, true);
});

for (const failure of ['initialize', 'resume'] as const) test(`Codex ${failure} failure closes without a fresh fallback`, async () => {
    let client!: CodexFixture;
    const providers = createCodeProviders({ detect: detection, codex: input => {
        client = new CodexFixture(input); client.failure = failure; return client;
    } });
    const f = owner({ nativeCursor: 'saved' });
    await assert.rejects(providers['codex-app'].open(f.options), /fixture_/);
    assert.equal(client.starts, 0); assert.equal(client.closes, 1); assert.deepEqual(f.cursors, []);
});

async function ownedCodexFixture(t: TestContext, graceful: 'hung' | 'reject' | 'resolved', exitOnKill = true) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(new EventEmitter(), { pid: 900011, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, killed: false });
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let gracefulStarted!: () => void, terminated!: () => void;
    const started = new Promise<void>(resolve => { gracefulStarted = resolve; });
    const termSent = new Promise<void>(resolve => { terminated = resolve; });
    let cleanupCalls = 0;
    const physicalExit = (signal: NodeJS.Signals | null = null) => {
        if (hasChildExited(child as unknown as ChildProcess)) return;
        if (signal) child.signalCode = signal; else child.exitCode = 0;
        child.emit('exit', child.exitCode, child.signalCode);
        child.emit('close', child.exitCode, child.signalCode);
    };
    // Install the owner before the adapter sees the child: fake PIDs never reach OS signalling.
    const owned = ownProcess(child as unknown as ChildProcess, { terminateTree(pid, signal = 'SIGTERM') {
        signals.push({ pid, signal }); child.killed = true;
        if (signal === 'SIGTERM') terminated();
        if (signal === 'SIGKILL' && exitOnKill) physicalExit(signal);
    } });
    const f = await codexFixture({}, client => {
        client.proc = child as unknown as ChildProcess;
        client.closeGracefully = () => {
            client.closes++; gracefulStarted();
            if (graceful === 'reject') return Promise.reject(new Error('fixture_unsubscribe_failed'));
            if (graceful === 'resolved') return Promise.resolve();
            return new Promise<void>(() => {});
        };
        client.cleanup = () => { cleanupCalls++; assert.equal(hasChildExited(client.proc), true); client.removeAllListeners(); };
    });
    t.after(() => { physicalExit(); owned.complete(); });
    return { ...f, child, signals, owned, started, termSent, physicalExit,
        get cleanupCalls() { return cleanupCalls; } };
}

for (const graceful of ['hung', 'reject', 'resolved'] as const) {
    test(`Codex ${graceful} graceful close escalates a SIGTERM-ignoring child and awaits actual exit`, async t => {
        const f = await ownedCodexFixture(t, graceful);
        let resolved = false;
        const closing = f.session.close().then(() => { resolved = true; });
        await f.started;
        if (graceful === 'hung') t.mock.timers.tick(1000);
        await f.termSent;
        assert.equal(f.owned.reason, 'shutdown');
        assert.equal(f.child.killed, true); assert.equal(hasChildExited(f.client.proc), false);
        assert.equal(f.session.alive, true); assert.equal(resolved, false); assert.equal(f.cleanupCalls, 0);
        assert.equal(f.session.closed, false);
        await assert.rejects(f.session.send('cannot dispatch while closing'), /not_idle/);
        t.mock.timers.tick(2000);
        await closing;
        assert.deepEqual(f.signals.map(entry => entry.signal), ['SIGTERM', 'SIGKILL']);
        assert.ok(f.signals.every(entry => entry.pid === 900011));
        assert.equal(f.session.alive, false); assert.equal(f.cleanupCalls, 1);
        assert.equal(f.session.closed, true);
        await f.session.close(); assert.equal(f.client.closes, 1); assert.equal(f.exits.length, 1);
    });
}

test('Codex actual exit during escalation grace cancels the delayed SIGKILL', async t => {
    const f = await ownedCodexFixture(t, 'resolved', false);
    const closing = f.session.close(); await f.started; await f.termSent;
    f.physicalExit(); await closing;
    t.mock.timers.tick(20_000);
    assert.deepEqual(f.signals.map(entry => entry.signal), ['SIGTERM']);
    assert.equal(f.cleanupCalls, 1); assert.equal(f.owned.state, 'complete');
});

test('Codex physical exit completes close even while unsubscribe remains hung', async t => {
    const f = await ownedCodexFixture(t, 'hung');
    const closing = f.session.close(); await f.started;
    f.physicalExit(); await closing;
    t.mock.timers.tick(20_000);
    assert.deepEqual(f.signals, []); assert.equal(f.cleanupCalls, 1);
});

for (const interrupt of ['hung', 'reject'] as const) {
    test(`Codex ${interrupt} interrupt cannot block owned shutdown or settle cancel before physical exit`, async t => {
        const f = await ownedCodexFixture(t, 'resolved');
        f.client.script = () => {};
        let rejectLate: ((error: Error) => void) | undefined;
        f.client.interruptTurn = () => {
            f.client.interrupts++;
            return interrupt === 'reject' ? Promise.reject(new Error('fixture_interrupt_failed'))
                : new Promise<void>((_resolve, reject) => { rejectLate = reject; });
        };
        const turn = f.session.send('pending prompt');
        let cancelled = false;
        const cancellation = f.session.cancel().then(() => { cancelled = true; });
        assert.equal(f.client.interrupts, 1);
        if (interrupt === 'hung') {
            t.mock.timers.tick(999);
            assert.equal(f.client.closes, 0); assert.equal(cancelled, false);
            t.mock.timers.tick(1);
        }
        await f.started; await f.termSent;
        assert.equal(cancelled, false); assert.equal(f.session.closed, false);
        t.mock.timers.tick(2000);
        await cancellation;
        assert.equal((await turn).status, 'stopped');
        assert.equal(f.session.closed, true); assert.equal(f.cleanupCalls, 1);
        assert.deepEqual(f.signals.map(entry => entry.signal), ['SIGTERM', 'SIGKILL']);
        rejectLate?.(new Error('fixture_late_interrupt_rejection'));
        await Promise.resolve();
        assert.equal(f.exits.length, 1);
    });
}

test('Codex deadline rejects and retains liveness; late exit permits cleanup but cannot rewrite the rejected receipt', async t => {
    const f = await ownedCodexFixture(t, 'hung', false);
    f.controller.abort();
    const closing = f.session.close();
    const rejected = assert.rejects(closing, /code_codex_cleanup_unconfirmed/);
    await f.started; t.mock.timers.tick(1000); await f.termSent;
    t.mock.timers.tick(6000); await rejected;
    assert.deepEqual(f.signals.map(entry => entry.signal), ['SIGTERM', 'SIGKILL']);
    assert.equal(f.session.alive, true); assert.equal(f.cleanupCalls, 0);
    assert.equal(f.session.closed, false); assert.equal(f.exits.length, 0);
    assert.equal(f.session.close(), closing);
    f.physicalExit();
    assert.equal(f.session.alive, false); assert.equal(f.cleanupCalls, 1);
    assert.equal(f.session.closed, true);
    await assert.rejects(f.session.close(), /code_codex_cleanup_unconfirmed/);
    t.mock.timers.tick(20_000);
    assert.equal(f.signals.length, 2); assert.equal(f.exits.length, 1);
});

test('Codex registers before initialization failure and retains the unreaped startup resource', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = owner();
    const child = Object.assign(new EventEmitter(), { pid: 900021, exitCode: null as number | null, signalCode: null });
    let terminated!: () => void;
    const shutdown = new Promise<void>(resolve => { terminated = resolve; });
    ownProcess(child as unknown as ChildProcess, {
        policy: () => ({ initialSignal: 'SIGKILL', graceMs: null }), terminateTree: () => terminated(),
    });
    const exit = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    t.after(exit);
    const providers = createCodeProviders({ detect: detection, codex: input => {
        const client = new CodexFixture(input); client.proc = child as unknown as ChildProcess;
        client.initialize = async () => {
            assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
            throw new Error('fixture_initialize_failed');
        };
        client.closeGracefully = async () => {};
        return client;
    } });
    const opening = providers['codex-app'].open(f.options);
    const rejected = assert.rejects(opening, /code_codex_cleanup_unconfirmed/);
    await shutdown; t.mock.timers.tick(6000); await rejected;
    assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
    assert.deepEqual(f.exits, []);
    exit(); assert.equal(f.resources[0]!.closed, true);
    await assert.rejects(f.resources[0]!.close(), /code_codex_cleanup_unconfirmed/);
});

for (const provider of ['cursor', 'grok'] as const) {
    test(`${provider} spawn receipt survives failed initialization and unconfirmed cleanup until late exit`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = owner();
        const child = Object.assign(new EventEmitter(), { pid: 900022, exitCode: null as number | null, signalCode: null });
        const signals: NodeJS.Signals[] = [];
        let terminated!: () => void;
        const shutdown = new Promise<void>(resolve => { terminated = resolve; });
        const exit = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
        t.after(exit);
        const create = async (input: CursorSessionOptions) => {
            const spawned = input.spawnImpl!(input.binary, ['fixture'], { stdio: 'pipe' });
            assert.equal(spawned, child);
            assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
            // This is the original native helper's policy, installed AFTER the spawn wrapper.
            ownProcess(spawned, { policy: () => ({ initialSignal: 'SIGKILL', graceMs: null }),
                terminateTree(_pid, signal = 'SIGTERM') { signals.push(signal); terminated(); } });
            await f.resources[0]!.close();
            throw new Error('fixture_native_initialize_failed');
        };
        const providers = createCodeProviders({ detect: detection, [provider]: create,
            acpSpawn: (() => child) as unknown as typeof spawn });
        const opening = providers[provider].open(f.options);
        const rejected = assert.rejects(opening, /code_native_cleanup_unconfirmed/);
        await shutdown; t.mock.timers.tick(6000); await rejected;
        assert.deepEqual(signals, ['SIGKILL'], 'Code shares the native owner and policy');
        assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
        exit(); assert.equal(f.resources[0]!.closed, true);
        await assert.rejects(f.resources[0]!.close(), /code_native_cleanup_unconfirmed/);
    });
}

test('Claude pre-start resource is not prematurely closed and survives failed startup cleanup until roots exit', async () => {
    const f = owner();
    let roots = 0, starts = 0;
    const providers = createCodeProviders({ detect: detection, claude: options => createClaudeSdkSession({
        ...options, queryFactory: forbidden,
        onSessionCreated(session) {
            Object.defineProperty(session, 'activeProcessCount', { get: () => roots });
            options.onSessionCreated?.(session);
            assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
            session.close = async () => { throw new Error('fixture_sdk_cleanup_unconfirmed'); };
            session.start = async () => {
                starts++; roots = 1;
                await session.close();
                throw new Error('fixture_sdk_initialize_failed');
            };
        },
    }) });
    await assert.rejects(providers.claude.open(f.options), /fixture_sdk_cleanup_unconfirmed/);
    assert.equal(starts, 1); assert.equal(f.resources.length, 1); assert.equal(f.resources[0]!.closed, false);
    await assert.rejects(f.resources[0]!.close(), /fixture_sdk_cleanup_unconfirmed/);
    roots = 0; assert.equal(f.resources[0]!.closed, true);
});

type Wire = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>;
    result?: Record<string, unknown>; error?: { code: number; message: string } };
function acpFactory(provider: 'cursor' | 'grok', failLoad = false) {
    const writes: Wire[] = [], argumentsSeen: CursorSessionOptions[] = [];
    let closes = 0;
    let prompt: Wire | undefined;
    let send!: (frame: Wire) => void;
    let nativeId = 'acp-native';
    let spawned: ChildProcessWithoutNullStreams | undefined;
    const spawnImpl = (() => { assert.ok(spawned); return spawned; }) as typeof spawn;
    let onPrompt = (frame: Wire) => {
        send({ method: 'session/update', params: { sessionId: nativeId,
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'z'.repeat(7000) } } } });
        send({ id: frame.id, result: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 13, outputTokens: 17, cachedReadTokens: 3 } } } });
    };
    const create = async (input: CursorSessionOptions) => {
        argumentsSeen.push(input);
        const child = Object.assign(new EventEmitter(), { pid: 900001, exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null, stdin: new Writable(), stdout: new PassThrough(), stderr: new PassThrough() });
        send = frame => { child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); };
        const reply = (frame: Wire, result: Record<string, unknown>) => queueMicrotask(() => send({ id: frame.id, result }));
        child.stdin = new Writable({ write(chunk, _encoding, callback) {
            const frame: Wire = JSON.parse(String(chunk)); writes.push(frame);
            if (frame.method === 'initialize') reply(frame, { protocolVersion: 1, agentCapabilities: { loadSession: true },
                authMethods: [{ id: provider === 'cursor' ? 'cursor_login' : 'cached_token' }] });
            else if (frame.method === 'authenticate') reply(frame, {});
            else if (frame.method === 'session/new' || frame.method === 'session/load') {
                if (failLoad && frame.method === 'session/load') queueMicrotask(() => send({ id: frame.id, error: { code: -1, message: 'cannot resume' } }));
                else { nativeId = input.resumeSessionId ?? 'acp-native'; reply(frame, { sessionId: nativeId }); }
            } else if (frame.method === 'session/prompt') { prompt = frame; queueMicrotask(() => onPrompt(frame)); }
            else if (frame.method === 'session/cancel') {
                assert.ok(prompt); reply(prompt, { stopReason: 'cancelled' });
            }
            callback();
        } });
        spawned = child as unknown as ChildProcessWithoutNullStreams;
        assert.ok(input.spawnImpl);
        assert.equal(input.spawnImpl(input.binary, ['fixture'], { stdio: 'pipe' }), spawned);
        const protocol = new AcpSession(spawned, {
            permissions: input.permissions, registry: input.registry, promptTimeoutMs: 1000, failed: input.failed,
            ownedProcessOptions: { terminateTree() {
                closes++; queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); });
            } },
        });
        try {
            await protocol.start({ cwd: input.cwd, authMethodId: provider === 'cursor' ? 'cursor_login' : 'cached_token',
                ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}) });
            return protocol;
        } catch (error) { await protocol.close(); throw error; }
    };
    return { create, spawnImpl, writes, argumentsSeen, get closes() { return closes; }, send: (frame: Wire) => send(frame),
        onPrompt: (value: typeof onPrompt) => { onPrompt = value; } };
}

for (const provider of ['cursor', 'grok'] as const) {
    test(`${provider} direct factory receives owned registry/policy/cursor; actual ACP terminal returns full output`, async t => {
        const native = acpFactory(provider), f = owner({ nativeCursor: 'saved-acp', permissionMode: provider === 'cursor' ? 'ask' : 'auto' });
        const providers = createCodeProviders({ detect: detection, acpSpawn: native.spawnImpl, [provider]: native.create });
        const session = await providers[provider].open(f.options); t.after(() => session.close());
        assert.equal(session.closed, false);
        const input = native.argumentsSeen[0]!;
        assert.equal(input.binary, provider === 'cursor' ? '/native/cursor-agent' : '/native/grok');
        assert.equal(input.registry, f.registry); assert.equal(input.signal, f.controller.signal);
        assert.equal(input.permissions, provider === 'cursor' ? 'safe' : 'auto');
        assert.equal(input.resumeSessionId, 'saved-acp');
        assert.equal(native.writes.some(frame => frame.method === 'session/new'), false);
        assert.equal(f.cursors[0]?.cursor, 'saved-acp');
        assert.equal((await session.send('prompt')).finalText, 'z'.repeat(7000));
        assert.equal(f.patches.at(-1)?.text.length, 7000); assert.deepEqual(f.closes, ['done']);
        assert.equal(f.patches[0]?.context.audience, 'internal');
        if (provider === 'grok') assert.ok(f.events.some(event => event.kind === 'usage'
            && event.inputTokens === 13 && event.outputTokens === 17 && event.cachedTokens === 3));
        await session.close(); await session.close();
        assert.equal(session.closed, true);
        assert.equal(native.closes, 1); assert.equal(f.exits.length, 1);
    });
    test(`${provider} resume failure retires its child and never starts a fresh session`, async () => {
        const native = acpFactory(provider, true), f = owner({ nativeCursor: 'missing' });
        const providers = createCodeProviders({ detect: detection, acpSpawn: native.spawnImpl, [provider]: native.create });
        await assert.rejects(providers[provider].open(f.options), { message: 'acp_rpc_error:-1' });
        assert.equal(native.closes, 1); assert.deepEqual(f.cursors, []);
        assert.equal(native.writes.some(frame => frame.method === 'session/new'), false);
    });
    test(`${provider} waits for actual RPC terminal and cancellation drains owned protocol`, async t => {
        const native = acpFactory(provider), f = owner();
        let started!: () => void;
        const admitted = new Promise<void>(resolve => { started = resolve; });
        native.onPrompt(() => started());
        const providers = createCodeProviders({ detect: detection, acpSpawn: native.spawnImpl, [provider]: native.create });
        const session = await providers[provider].open(f.options); t.after(() => session.close());
        let settled = false;
        const turn = session.send('wait').then(value => { settled = true; return value; });
        await admitted; assert.equal(settled, false);
        await session.cancel(); assert.equal((await turn).status, 'stopped');
        assert.equal(native.writes.filter(frame => frame.method === 'session/cancel').length, 1);
    });
}

function claudeFactory() {
    const input: ClaudeSessionOptions[] = [];
    const sent: unknown[] = [];
    const queue: SDKMessage[] = [];
    let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined;
    let ended = false, closes = 0;
    const output = {
        [Symbol.asyncIterator]() { return this; },
        next(): Promise<IteratorResult<SDKMessage>> {
            const value = queue.shift();
            if (value) return Promise.resolve({ done: false, value });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise(resolve => { waiting = resolve; });
        },
        close() { closes++; ended = true; waiting?.({ done: true, value: undefined }); waiting = undefined; },
    };
    const push = (raw: Record<string, unknown>) => {
        // Protocol fixtures deliberately include malformed frames in negative cases.
        const value = raw as unknown as SDKMessage;
        if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value }); }
        else queue.push(value);
    };
    const create = (options: ClaudeSessionOptions) => {
        input.push(options);
        return createClaudeSdkSession({ ...options, queryFactory: ({ prompt }) => {
            void (async () => { for await (const message of prompt) sent.push(message); })()
                .catch(error => { push({ type: 'fixture_input_error', error: String(error) }); output.close(); });
            return output;
        } });
    };
    return { input, sent, create, push, crash: () => output.close(), get closes() { return closes; } };
}

function cursorObserved(f: ReturnType<typeof owner>, id: string): Promise<void> {
    const record = f.options.onNativeCursor;
    return new Promise(resolve => {
        f.options.onNativeCursor = (cursor, context) => { record(cursor, context); if (cursor === id) resolve(); };
    });
}

for (const ending of ['cancel', 'crash'] as const) {
    test(`Claude persists root init before result and retains the cursor after ${ending}`, async t => {
        const native = claudeFactory(), f = owner({ permissionMode: 'ask' });
        const initialized = cursorObserved(f, 'early-native');
        const providers = createCodeProviders({ detect: detection, claude: native.create });
        const session = await providers.claude.open(f.options); t.after(() => session.close());
        let settled = false;
        const pending = session.send('prompt').then(value => { settled = true; return value; });
        native.push({ type: 'system', subtype: 'init', session_id: 'early-native', permissionMode: 'default' });
        await initialized;
        assert.equal(settled, false);
        assert.equal(session.nativeSessionId, 'early-native');
        assert.equal(f.cursors.at(-1)?.context?.turnId, 'code-turn-1');
        if (ending === 'cancel') await session.cancel(); else native.crash();
        assert.equal((await pending).status, ending === 'cancel' ? 'stopped' : 'error');
        assert.equal(f.cursors.at(-1)?.cursor, 'early-native');
        assert.deepEqual(f.cursors.map(entry => entry.cursor), [null, 'early-native']);
    });
}

test('Claude idle root init uses the current captured opening context', async t => {
    const native = claudeFactory(), f = owner();
    const initialized = cursorObserved(f, 'idle-native');
    const session = await createCodeProviders({ detect: detection, claude: native.create }).claude.open(f.options);
    t.after(() => session.close());
    native.push({ type: 'system', subtype: 'init', session_id: 'idle-native', permissionMode: 'bypassPermissions' });
    await initialized;
    assert.deepEqual(f.cursors.map(entry => entry.cursor), ['idle-native']);
    assert.equal(f.cursors[0]?.context?.runId, 'code-run-1');
});

test('Claude idle init cannot revive a stale opening owner', async t => {
    const native = claudeFactory(), f = owner();
    let observed!: () => void;
    const delivered = new Promise<void>(resolve => { observed = resolve; });
    const providers = createCodeProviders({ detect: detection, claude: options => native.create({
        ...options, onNativeSessionId(context, id) { options.onNativeSessionId?.(context, id); observed(); },
    }) });
    const session = await providers.claude.open(f.options); t.after(() => session.close());
    assert.equal(session.closed, false);
    f.stale();
    native.push({ type: 'system', subtype: 'init', session_id: 'late-idle-native', permissionMode: 'bypassPermissions' });
    await delivered;
    assert.deepEqual(f.cursors, []);
});

test('Claude init callback invokes the Code persistence failure latch before native success can settle', async t => {
    const native = claudeFactory(), f = owner();
    let failure: Error | null = null;
    let failed!: () => void;
    const failureObserved = new Promise<void>(resolve => { failed = resolve; });
    const record = f.options.onNativeCursor;
    f.options.onNativeCursor = (cursor, context) => {
        if (cursor === 'unwritable-native') {
            failure ??= new Error('fixture_cursor_write_failed');
            f.controller.abort(); failed(); throw failure;
        }
        record(cursor, context);
    };
    const session = await createCodeProviders({ detect: detection, claude: native.create }).claude.open(f.options);
    t.after(() => session.close());
    const pending = session.send('prompt');
    native.push({ type: 'system', subtype: 'init', session_id: 'unwritable-native', permissionMode: 'bypassPermissions' });
    await failureObserved;
    native.push({ type: 'result', subtype: 'success', is_error: false, result: 'late success', session_id: 'unwritable-native' });
    assert.notEqual((await pending).status, 'done');
    assert.ok(failure);
    assert.equal(f.closes.includes('done'), false);
    assert.equal(f.cursors.some(entry => entry.cursor === 'unwritable-native'), false);
});

for (const mode of ['ask', 'auto'] as const) test(`Claude ${mode} forwards metadata with captured context and owns query cleanup`, async t => {
    const native = claudeFactory(), f = owner({ permissionMode: mode });
    const providers = createCodeProviders({ detect: detection, claude: native.create });
    const session = await providers.claude.open(f.options); t.after(() => session.close());
    const prepared = native.input[0]!;
    assert.equal(prepared.registry, f.registry); assert.equal(prepared.prepared.permissions, mode === 'ask' ? 'safe' : 'auto');
    assert.equal(prepared.prepared.sdkMode, mode === 'ask' ? 'default' : 'bypassPermissions');
    assert.equal(prepared.prepared.sessionGrants, true);
    assert.equal(prepared.prepared.allowDangerouslySkipPermissions, true);
    assert.equal(prepared.resolveTranscriptParent, f.options.resolveTranscriptParent);
    assert.equal(f.cursors.length, 0, 'opening without input has not consumed a prompt');
    const pending = session.send('prompt');
    assert.equal(f.cursors[0]?.cursor, null);
    const captured = f.context(); f.next();
    native.push({ type: 'system', subtype: 'init', session_id: 'claude-native', permissionMode: mode === 'ask' ? 'default' : 'bypassPermissions' });
    native.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-native', result: 'a'.repeat(6000) });
    const result = await pending;
    assert.equal(result.finalText, 'a'.repeat(6000));
    assert.equal(f.cursors.at(-1)?.cursor, 'claude-native');
    assert.equal(f.cursors.at(-1)?.context?.turnId, captured.turnId);
    assert.equal(f.patches.at(-1)?.context.turnId, captured.turnId);
    assert.equal(f.patches.at(-1)?.text.length, 6000);
    await session.close(); await session.close(); assert.equal(native.closes, 1); assert.equal(f.exits.length, 1);
    assert.equal(session.closed, true);
});

test('Claude resumes exactly the supplied cursor without a null start marker', async t => {
    const native = claudeFactory(), f = owner({ nativeCursor: 'saved-claude' });
    const providers = createCodeProviders({ detect: detection, claude: native.create });
    const session = await providers.claude.open(f.options); t.after(() => session.close());
    assert.equal(native.input[0]?.prepared.resumeSessionId, 'saved-claude');
    const pending = session.send('prompt');
    native.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'saved-claude', result: '' });
    assert.equal((await pending).finalText, '');
    assert.equal(f.cursors.some(c => c.cursor === null), false);
});

test('Claude rejects invalid or busy input before writing the actual-start marker', async t => {
    const native = claudeFactory(), f = owner();
    const providers = createCodeProviders({ detect: detection, claude: native.create });
    const session = await providers.claude.open(f.options); t.after(() => session.close());
    assert.throws(() => session.send('x'.repeat(1024 * 1024 + 1)), /prompt_limit/);
    assert.deepEqual(f.cursors, []);
    const pending = session.send('prompt');
    assert.throws(() => session.send('second'), /not_idle/); assert.equal(f.cursors.length, 1);
    await session.cancel(); assert.equal((await pending).status, 'stopped');
});

test('Claude SDK startup failure rejects once without inventing native history', async () => {
    const f = owner({ nativeCursor: 'saved-claude' });
    let queries = 0;
    const providers = createCodeProviders({ detect: detection, claude: options => createClaudeSdkSession({
        ...options, queryFactory() { queries++; throw new Error('fixture_sdk_start_failed'); },
    }) });
    await assert.rejects(providers.claude.open(f.options), /fixture_sdk_start_failed/);
    assert.equal(queries, 1); assert.deepEqual(f.cursors, []);
    assert.equal(f.registry.list('code-session').length, 0);
});

for (const provider of ['codex-app', 'claude', 'cursor', 'grok'] as const) {
    test(`${provider} reuses one healthy native handle with fresh captured context on each send`, async t => {
        const f = owner(), claude = claudeFactory(), acp = acpFactory(provider === 'grok' ? 'grok' : 'cursor');
        let codex!: CodexFixture;
        let codexCreates = 0;
        const providers = createCodeProviders({ detect: detection,
            codex: input => { codexCreates++; codex = new CodexFixture(input); return codex; },
            claude: claude.create, cursor: acp.create, grok: acp.create, acpSpawn: acp.spawnImpl });
        const session = await providers[provider].open(f.options); t.after(() => session.close());
        assert.equal(f.resources.length, 1);
        assert.equal(f.resources[0]!.closed, false);
        for (const index of [1, 2]) {
            if (index === 2) f.next();
            const runId = f.context().runId, start = f.patches.length;
            const answer = `answer ${index}`;
            if (provider === 'codex-app') codex.script = c => { c.message(`message-${index}`, answer); c.finish(); };
            if (provider === 'cursor' || provider === 'grok') acp.onPrompt(frame => {
                acp.send({ method: 'session/update', params: { sessionId: session.nativeSessionId,
                    update: { sessionUpdate: 'agent_message_chunk', messageId: `message-${index}`, content: { type: 'text', text: answer } } } });
                acp.send({ id: frame.id, result: { stopReason: 'end_turn' } });
            });
            const pending = session.send(`prompt ${index}`);
            if (provider === 'claude') {
                if (index === 1) claude.push({ type: 'system', subtype: 'init', session_id: 'claude-native', permissionMode: 'bypassPermissions' });
                claude.push({ type: 'result', subtype: 'success', is_error: false,
                    session_id: 'claude-native', result: answer, uuid: `result-${index}` });
            }
            assert.equal((await pending).finalText, answer);
            assert.equal(session.alive, true); assert.equal(f.controller.signal.aborted, false);
            assert.equal(session.closed, false);
            assert.equal(f.resources[0]!.closed, false);
            assert.ok(f.patches.length > start);
            assert.ok(f.patches.slice(start).every(patch => patch.context.runId === runId));
            assert.equal(f.registry.list('code-session').length, 0);
        }
        assert.equal(provider === 'codex-app' ? codexCreates : provider === 'claude' ? claude.input.length : acp.argumentsSeen.length, 1);
        assert.deepEqual(f.closes, ['done', 'done']); assert.deepEqual(f.exits, []);
        assert.equal(jawEffects, 0);
        await session.close(); assert.equal(session.closed, true);
        assert.equal(f.resources[0]!.closed, true);
    });
}

for (const provider of ['codex-app', 'claude', 'cursor', 'grok'] as const) {
    test(`${provider} abort during acquisition closes the acquired runtime without a cursor write`, async () => {
        const f = owner();
        let codex: CodexFixture | undefined;
        const claude = claudeFactory(), acp = acpFactory(provider === 'grok' ? 'grok' : 'cursor');
        const providers = createCodeProviders({ detect: detection,
            codex: input => {
                codex = new CodexFixture(input);
                codex.initialize = async () => { f.controller.abort(); return {}; };
                return codex;
            },
            acpSpawn: acp.spawnImpl,
            claude: async options => { const runtime = await claude.create(options); f.controller.abort(); return runtime; },
            cursor: async options => { const runtime = await acp.create(options); f.controller.abort(); return runtime; },
            grok: async options => { const runtime = await acp.create(options); f.controller.abort(); return runtime; },
        });
        await assert.rejects(providers[provider].open(f.options), /open_aborted/);
        assert.deepEqual(f.cursors, []);
        assert.equal(provider === 'codex-app' ? codex?.closes : provider === 'claude' ? claude.closes : acp.closes, 1);
        assert.equal(f.exits.length, 1);
    });
}

test('unsupported provider policies fail before any native constructor', async () => {
    const providers = createCodeProviders({ detect: detection, claude: forbidden, cursor: forbidden, grok: forbidden });
    for (const provider of ['claude', 'cursor', 'grok'] as const) {
        await assert.rejects(providers[provider].open(owner({ permissionMode: 'read-only' }).options), /policy_unsupported/);
    }
    await assert.rejects(providers.grok.open(owner({ permissionMode: 'ask' }).options), /policy_unsupported/);
});

test('all four reject aborted startup and public audience before native construction', async () => {
    const providers = createCodeProviders({ detect: detection, codex: forbidden, claude: forbidden, cursor: forbidden, grok: forbidden });
    for (const provider of Object.values(providers)) {
        const f = owner(); f.controller.abort();
        await assert.rejects(provider.open(f.options), /open_aborted/);
        const publicOwner = owner();
        publicOwner.options.getTurnContext = () => ({ ...publicOwner.context(), audience: 'public' });
        await assert.rejects(provider.open(publicOwner.options), /invalid_owner/);
    }
    assert.equal(jawEffects, 0);
});

// --- #704: structured permission requests reach the queue in ask mode ---
// { permissions: {}, scope: 'turn' } is the runtime's canonical decline, verified
// against codex-rs 095da4b7e: core records no grant for an empty profile
// (core/src/session/mod.rs:3118-3141) and the TUI Deny button emits exactly this
// (tui/src/bottom_pane/approval_overlay.rs:1968-2002). So the old fallback was
// fail-closed - but ask mode never showed the request it promised to show.
const PERMISSIONS = 'item/permissions/requestApproval';
const asked = { network: { enabled: true } };
async function askingPermissions(mode: CodeOpenOptions['permissionMode'] = 'ask', type = 'mcpToolCall') {
    const f = await codexFixture({ permissionMode: mode }, client => {
        client.script = c => c.notification('item/started', { item: { id: 'native-tool', type } });
    });
    const turn = f.session.send('prompt');
    return { ...f, turn };
}

test('ask surfaces a structured permission request and answers only what the user chose', async t => {
    const f = await askingPermissions(); t.after(() => f.session.close());
    const answer = f.client.request({ permissions: asked, reason: 'fetch the changelog' }, PERMISSIONS);
    const pending = f.registry.list('code-session')[0]!;
    assert.ok(pending, 'the request is queued with the same turn ownership as command and file approvals');
    assert.equal(pending.view.title, 'Approve additional permissions');
    assert.match(pending.view.fields[0]!.label, /network/);
    assert.match(pending.view.fields[0]!.label, /fetch the changelog/);
    const handles = pending.view.fields[0]!.options;
    assert.deepEqual(handles.map(h => h.label), ['Allow once', 'Decline']);
    f.registry.respond(pending.requestId, f.context(), { optionId: handles[0]!.id });
    // Echoing the request grants exactly what was asked; core intersects it anyway.
    assert.deepEqual(await answer, { permissions: asked, scope: 'turn' });
    assert.equal(f.registry.list('code-session').length, 0);
    f.client.finish(); await f.turn;
});

test('declining a structured permission request answers the runtime decline', async t => {
    const f = await askingPermissions(); t.after(() => f.session.close());
    const answer = f.client.request({ permissions: asked }, PERMISSIONS);
    const pending = f.registry.list('code-session')[0]!;
    const handles = pending.view.fields[0]!.options;
    f.registry.respond(pending.requestId, f.context(), { optionId: handles[1]!.id });
    assert.deepEqual(await answer, { permissions: {}, scope: 'turn' });
    f.client.finish(); await f.turn;
});

test('auto grants the requested profile without a handle, and denies an empty ask', async t => {
    const f = await askingPermissions('auto'); t.after(() => f.session.close());
    assert.deepEqual(await f.client.request({ permissions: asked }, PERMISSIONS), { permissions: asked, scope: 'turn' });
    assert.equal(f.registry.list('code-session').length, 0, 'auto keeps its labelled behaviour');
    // Nothing was asked for, so there is nothing to grant.
    assert.deepEqual(await f.client.request({ permissions: {} }, PERMISSIONS), { permissions: {}, scope: 'turn' });
    assert.deepEqual(await f.client.request({}, PERMISSIONS), { permissions: {}, scope: 'turn' });
    assert.equal(f.registry.list('code-session').length, 0);
    f.client.finish(); await f.turn;
});

for (const mismatch of [{ threadId: 'foreign' }, { turnId: 'previous' }, { itemId: 'unknown' }, { threadId: undefined }]) {
    test(`Codex denies an unverified permission request ${JSON.stringify(mismatch)}`, async t => {
        const f = await askingPermissions('auto'); t.after(() => f.session.close());
        assert.deepEqual(await f.client.request({ permissions: asked, ...mismatch }, PERMISSIONS),
            { permissions: {}, scope: 'turn' });
        assert.equal(f.registry.list('code-session').length, 0);
        f.client.finish(); await f.turn;
    });
}

test('a settled item can no longer carry a permission request', async t => {
    const f = await askingPermissions(); t.after(() => f.session.close());
    f.client.notification('item/completed', { item: { id: 'native-tool', type: 'mcpToolCall', status: 'completed' } });
    assert.deepEqual(await f.client.request({ permissions: asked }, PERMISSIONS), { permissions: {}, scope: 'turn' });
    assert.equal(f.registry.list('code-session').length, 0);
    f.client.finish(); await f.turn;
});
