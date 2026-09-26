import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import { createClaudePermissions, encodeClaudeApprovalResponse, validateClaudeApprovalResponse,
    type ClaudePermissionOwner } from '../../src/agent/runtime/claude-sdk-permissions.ts';

type CallbackOptions = Parameters<CanUseTool>[2];
const context = { runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn', audience: 'public' as const };
function options(controller = new AbortController(), toolUseID = 'tool'): CallbackOptions {
    return { signal: controller.signal, toolUseID, requestId: 'sdk-request' };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
function fixture(t: TestContext, permissions: 'auto' | 'safe' = 'safe', registry = new RuntimeRequests()) {
    let current = true;
    const bodies: RuntimeEventBody[] = [];
    const published = deferred<void>();
    const owner: ClaudePermissionOwner = { context, isCurrent: () => current,
        emit: body => { bodies.push(body); if (body.kind === 'request') published.resolve(); } };
    const api = createClaudePermissions({ registry, permissions, resolveOwner: async () => owner });
    t.after(() => api.cancelAll());
    return { api, registry, bodies, owner, published: published.promise, stale: () => { current = false; } };
}
function questionInput(multiSelect = false) {
    return { questions: [{ question: 'Which language?', header: 'Language', multiSelect,
        options: [{ label: 'TypeScript', description: 'Typed' }, { label: 'Python', description: 'Dynamic' }] }] };
}

test('approval encoder/validator accepts only exact allow, deny or cancellation', () => {
    for (const id of ['allow', 'deny', null] as const) {
        assert.deepEqual(encodeClaudeApprovalResponse(id), { optionId: id });
        assert.equal(validateClaudeApprovalResponse({ optionId: id }), id ?? 'cancel');
    }
    for (const value of [null, [], 'allow', {}, { optionId: 'always' }, { optionId: 'allow', updatedInput: {} },
        { optionId: 'deny', [Symbol('extra')]: true }]) assert.throws(() => validateClaudeApprovalResponse(value));
});

test('safe approval preserves an immutable deep snapshot; invalid replies do not consume', async t => {
    const f = fixture(t);
    const input = { command: 'pwd', nested: { x: [1, 2] } };
    const result = f.api.canUseTool('Bash', input, options());
    input.command = 'rm -rf /'; input.nested.x.push(3);
    await f.published;
    const request = f.registry.list('chat')[0]!;
    assert.equal(request.view.title.includes('pwd'), true);
    for (const key of ['runId', 'sessionId', 'scope', 'turnId'] as const) {
        assert.throws(() => f.registry.respond(request.requestId, { ...context, [key]: 'foreign' }, { optionId: 'allow' }));
    }
    for (const response of [{ optionId: 'allow', updatedPermissions: [] }, { optionId: 'bad' }, 'allow']) {
        assert.throws(() => f.registry.respond(request.requestId, context, response));
        assert.equal(f.registry.list('chat').length, 1);
    }
    f.registry.respond(request.requestId, context, { optionId: 'allow' });
    const answer = await result;
    assert.deepEqual(answer, { behavior: 'allow', updatedInput: { command: 'pwd', nested: { x: [1, 2] } } });
    assert.ok(answer?.behavior === 'allow' && Object.isFrozen(answer.updatedInput));
    assert.equal(Object.isFrozen(input), false);
    assert.deepEqual(f.bodies.map(b => b.kind), ['request', 'request-settled']);
});

test('auto ordinary tool allows, while matched ask rule and AskUserQuestion still ask', async t => {
    const f = fixture(t, 'auto');
    assert.deepEqual(await f.api.canUseTool('Bash', { command: 'pwd' }, options()), {
        behavior: 'allow', updatedInput: { command: 'pwd' },
    });
    assert.equal(f.bodies.length, 0);
    const result = f.api.canUseTool('Bash', { command: 'pwd' }, { ...options(),
        matchedAskRule: { source: 'userSettings', toolName: 'Bash' } });
    await f.published;
    f.registry.respond(f.registry.list('chat')[0]!.requestId, context, { optionId: 'deny' });
    assert.equal((await result)?.behavior, 'deny');
    const q = fixture(t, 'auto');
    const answer = q.api.canUseTool('AskUserQuestion', questionInput(), options());
    await q.published;
    assert.equal(q.registry.list('chat')[0]!.requestType, 'question');
    q.api.cancelAll(); assert.equal((await answer)?.behavior, 'deny');
});

test('aborting one callback and cancelAll leave other factory requests untouched', async t => {
    const f = fixture(t), other = fixture(t, 'safe', f.registry);
    const controller = new AbortController();
    const one = f.api.canUseTool('Read', { file_path: '/tmp/a' }, options(controller));
    const two = other.api.canUseTool('Read', { file_path: '/tmp/b' }, options());
    await Promise.all([f.published, other.published]);
    controller.abort(); assert.equal((await one)?.behavior, 'deny');
    f.api.cancelAll(); assert.equal(f.registry.list('chat').length, 1);
    other.api.cancelAll(); assert.equal((await two)?.behavior, 'deny');
    assert.equal(f.bodies.filter(b => b.kind === 'request-settled').length, 1);
});

test('captured owner is checked after resolution and after an allow response', async t => {
    const f = fixture(t);
    const waiting = deferred<ClaudePermissionOwner | null>();
    let calls = 0;
    const api = createClaudePermissions({ registry: f.registry, permissions: 'safe',
        resolveOwner: async id => { calls++; assert.equal(id, 'owned-tool'); return waiting.promise; } });
    t.after(() => api.cancelAll());
    const pending = api.canUseTool('Bash', { command: 'pwd' }, options(undefined, 'owned-tool'));
    f.stale(); waiting.resolve(f.owner);
    assert.equal((await pending)?.behavior, 'deny'); assert.equal(calls, 1); assert.equal(f.bodies.length, 0);
    const next = fixture(t);
    const approved = next.api.canUseTool('Bash', { command: 'pwd' }, options());
    await next.published;
    next.registry.respond(next.registry.list('chat')[0]!.requestId, context, { optionId: 'allow' });
    next.stale(); assert.equal((await approved)?.behavior, 'deny');
});

test('32 callback budget includes owner waits; cancel frees slots and future calls remain usable', async t => {
    const f = fixture(t, 'auto');
    const waiting = deferred<ClaudePermissionOwner | null>();
    let calls = 0;
    const api = createClaudePermissions({ registry: f.registry, permissions: 'auto',
        resolveOwner: () => { calls++; return waiting.promise; } });
    t.after(() => api.cancelAll());
    const pending = Array.from({ length: 32 }, () => api.canUseTool('Bash', { command: 'pwd' }, options()));
    assert.equal((await api.canUseTool('Bash', { command: 'pwd' }, options()))?.behavior, 'deny');
    assert.equal(calls, 32);
    api.cancelAll();
    assert.ok((await Promise.all(pending)).every(result => result?.behavior === 'deny'));
    waiting.resolve(f.owner);
    assert.equal((await api.canUseTool('Bash', { command: 'pwd' }, options()))?.behavior, 'allow');
});

test('already aborted, listener-install abort, owner exceptions and null owner fail closed', async t => {
    const f = fixture(t, 'auto');
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.api.canUseTool('Bash', {}, options(controller)))?.behavior, 'deny');
    const raced = new AbortController();
    t.mock.method(raced.signal, 'addEventListener', () => { raced.abort(); });
    assert.equal((await f.api.canUseTool('Bash', {}, options(raced)))?.behavior, 'deny');
    for (const resolveOwner of [async () => null, async () => { throw new Error('secret'); }]) {
        const api = createClaudePermissions({ registry: f.registry, permissions: 'auto', resolveOwner });
        assert.equal((await api.canUseTool('Bash', {}, options()))?.behavior, 'deny');
    }
    assert.equal(f.bodies.length, 0);
});

test('timeout and response/Stop race deny; abort listeners are removed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const f = fixture(t);
    const controller = new AbortController();
    const removed = t.mock.method(controller.signal, 'removeEventListener');
    const pending = f.api.canUseTool('Bash', { command: 'pwd' }, options(controller));
    await f.published; t.mock.timers.tick(120_000);
    assert.equal((await pending)?.behavior, 'deny'); assert.equal(removed.mock.callCount(), 1);
    const next = fixture(t);
    const approved = next.api.canUseTool('Bash', { command: 'pwd' }, options());
    await next.published;
    next.registry.respond(next.registry.list('chat')[0]!.requestId, context, { optionId: 'allow' });
    next.api.cancelAll(); assert.equal((await approved)?.behavior, 'deny');
});

test('safe views redact full content before clipping and exclude raw env/tool JSON', async t => {
    const f = fixture(t);
    const pending = f.api.canUseTool('WebFetch', { url: 'https://user:pass@example.test/x?token=hidden&TOKEN=' + 'z'.repeat(900),
        env: { TOPSECRET: 'never-visible' }, payload: { private: 'hidden-json' } }, options());
    await f.published;
    const serialized = JSON.stringify(f.bodies);
    for (const secret of ['user:pass', 'hidden', 'never-visible', 'hidden-json', 'zzzzzz']) assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /example\.test/); assert.ok(f.registry.list('chat')[0]!.view.title.length <= 500);
    f.api.cancelAll(); await pending;
});

test('unreviewable safe tools deny, ExitPlanMode uses ordinary approval, input trees are bounded', async t => {
    const f = fixture(t);
    assert.equal((await f.api.canUseTool('opaque', { env: { PRIVATE: 'secret' } }, options()))?.behavior, 'deny');
    const pending = f.api.canUseTool('ExitPlanMode', {}, options());
    await f.published; f.registry.respond(f.registry.list('chat')[0]!.requestId, context, { optionId: 'allow' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: {} });
    const auto = fixture(t, 'auto');
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const input of [cycle, { huge: 'x'.repeat(1024 * 1024 + 1) }, { invalid: Infinity }, { get command() { throw Error('private'); } }]) {
        assert.equal((await auto.api.canUseTool('Bash', input, options()))?.behavior, 'deny');
    }
});

test('question validator rejects missing/extra/duplicate/empty/long answers without consumption', async t => {
    const f = fixture(t);
    const pending = f.api.canUseTool('AskUserQuestion', questionInput(), options());
    await f.published;
    const id = f.registry.list('chat')[0]!.requestId;
    const bad = [null, {}, { answers: {} }, { answers: { q1: { selected: ['o0'] } } },
        { answers: { q0: { selected: ['o0'] } }, extra: true },
        ...[{ selected: [] }, { selected: ['o0', 'o0'] }, { selected: ['o0', 'o1'] }, { selected: ['bad'] },
            { selected: ['o0'], extra: true }, { text: 'free' }, { selected: [], text: '' },
            { selected: [], text: ' ' }, { selected: [], text: 'x'.repeat(2001) }, { selected: ['o0'], text: 'free' }]
            .map(value => ({ answers: { q0: value } }))];
    for (const response of bad) {
        assert.throws(() => f.registry.respond(id, context, response)); assert.equal(f.registry.list('chat').length, 1);
    }
    f.registry.respond(id, context, { answers: { q0: { selected: [], text: 'Rust' } } });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { ...questionInput(), answers: { 'Which language?': 'Rust' } } });
});

test('multi-select joins original labels comma-space and original question keys remain private', async t => {
    const f = fixture(t);
    const input = questionInput(true); input.questions[0]!.question = 'Choose with TOKEN=private';
    const pending = f.api.canUseTool('AskUserQuestion', input, options());
    await f.published;
    assert.equal(JSON.stringify(f.bodies).includes('TOKEN=private'), false);
    f.registry.respond(f.registry.list('chat')[0]!.requestId, context, { answers: { q0: { selected: ['o1', 'o0'] } } });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { ...input, answers: { 'Choose with TOKEN=private': 'Python, TypeScript' } } });
});
test('question cancellation uses exact optionId null and never fabricates an answer', async t => {
    const f = fixture(t);
    const answer = f.api.canUseTool('AskUserQuestion', questionInput(), options()); await f.published;
    const pending = f.registry.list('chat')[0]!;
    for (const response of [{ optionId: 'allow' }, { optionId: null, answers: {} }]) {
        assert.throws(() => f.registry.respond(pending.requestId, context, response));
    }
    f.registry.respond(pending.requestId, context, { optionId: null });
    assert.equal((await answer)?.behavior, 'deny'); assert.equal(f.registry.list('chat').length, 0);
});

test('duplicate and malformed questions deny without publishing', async t => {
    const f = fixture(t);
    const question = questionInput().questions[0]!;
    for (const questions of [[], [question, question], Array(9).fill(question), [{ ...question, question: '' }],
        [{ ...question, question: 'x'.repeat(501) }], [{ ...question, multiSelect: 'true' }],
        [{ ...question, options: [] }], [{ ...question, options: Array(21).fill({ label: 'x' }) }]]) {
        assert.equal((await f.api.canUseTool('AskUserQuestion', { questions }, options()))?.behavior, 'deny');
    }
    assert.equal(f.bodies.length, 0);
});

test('pre-publish abort cancels its newly opened handle, and does not emit an actionable request', async t => {
    const f = fixture(t);
    const controller = new AbortController();
    const open = f.registry.open.bind(f.registry);
    t.mock.method(f.registry, 'open', (...args: Parameters<RuntimeRequests['open']>) => {
        const handle = open(...args); controller.abort(); return handle;
    });
    assert.equal((await f.api.canUseTool('Bash', { command: 'pwd' }, options(controller)))?.behavior, 'deny');
    assert.equal(f.registry.list('chat').length, 0);
    assert.deepEqual(f.bodies.map(body => body.kind), ['request-settled']);
});

test('SSE emission failure still permits only an explicit response from the polling surface', async t => {
    const f = fixture(t);
    const emitted = deferred<void>();
    t.mock.method(f.owner, 'emit', () => { emitted.resolve(); throw Error('private failure'); });
    const pending = f.api.canUseTool('Bash', { command: 'pwd' }, options());
    await emitted.promise;
    const request = f.registry.list('chat')[0]!;
    f.registry.respond(request.requestId, context, { optionId: 'allow' });
    assert.equal((await pending)?.behavior, 'allow');
    assert.equal(f.registry.list('chat').length, 0);
});

test('global registry capacity cannot be bypassed and cancelAll leaves external entries alone', async t => {
    const f = fixture(t);
    t.after(() => f.registry.cancelRun(context.runId));
    const view = { title: 'Existing request', fields: [] };
    for (let i = 0; i < 128; i++) f.registry.open({ ...context, requestType: 'approval', view,
        isCurrent: () => true, validate: () => 'deny', cancelled: 'deny' });
    assert.equal((await f.api.canUseTool('Bash', { command: 'pwd' }, options()))?.behavior, 'deny');
    f.api.cancelAll();
    assert.equal(f.registry.list('chat').length, 128); assert.equal(f.bodies.length, 0);
});

test('every question and selection must match the live fields, including total freeform budget', async t => {
    const f = fixture(t);
    const questions = Array.from({ length: 8 }, (_, i) => ({ ...questionInput().questions[0]!, question: `Question ${i}?`,
        options: Array.from({ length: 20 }, (_, j) => ({ label: `Choice ${j}` })) }));
    const pending = f.api.canUseTool('AskUserQuestion', { questions }, options());
    await f.published;
    const request = f.registry.list('chat')[0]!;
    assert.equal(request.view.fields.length, 8); assert.equal(request.view.fields[0]!.options.length, 20);
    const answers = Object.fromEntries(questions.map((_, i) => [`q${i}`, { selected: ['o19'] }]));
    assert.throws(() => f.registry.respond(request.requestId, context, { answers: { ...answers, q8: { selected: ['o0'] } } }));
    const oversized = Object.fromEntries(questions.map((_, i) => [`q${i}`, { selected: [], text: 'a'.repeat(1001) }]));
    assert.throws(() => f.registry.respond(request.requestId, context, { answers: oversized }));
    f.registry.respond(request.requestId, context, { answers });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { questions,
        answers: Object.fromEntries(questions.map(q => [q.question, 'Choice 19'])) } });
});

test('quoted shell credentials cannot hide part of a command behind an approval', async t => {
    const f = fixture(t);
    const answer = await f.api.canUseTool('Bash', { command: 'TOKEN="very private value" curl https://example.test' }, options());
    assert.equal(answer?.behavior, 'deny'); assert.equal(f.bodies.length, 0);
});
test('redaction cannot conceal executable Bash fragments behind an approval', async t => {
    const f = fixture(t);
    t.mock.method(f.owner, 'emit', (body: RuntimeEventBody) => {
        f.bodies.push(body);
        if (body.kind === 'request') f.registry.respond(body.requestId, context, { optionId: 'allow' });
    });
    // A string-only permission fixture: this command is never executed.
    const command = 'API_KEY=$(printf${IFS}hidden-action);printf ok';
    const result = await f.api.canUseTool('Bash', { command }, options());
    assert.equal(result?.behavior, 'deny'); assert.equal(f.bodies.length, 0);
});
test('ordinary safe Bash and URL formatting remain reviewable and execute unchanged input', async t => {
    for (const command of ['printf ok', 'curl https://example.test']) {
        const f = fixture(t);
        const pending = f.api.canUseTool('Bash', { command }, options()); await f.published;
        const request = f.registry.list('chat')[0]!;
        f.registry.respond(request.requestId, context, { optionId: 'allow' });
        assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command } });
    }
    const auto = fixture(t, 'auto'), command = 'TOKEN="literal credential" printf ok';
    assert.deepEqual(await auto.api.canUseTool('Bash', { command }, options()), { behavior: 'allow', updatedInput: { command } });
    assert.equal(auto.bodies.length, 0);
});
test('Bash URL dot-segment normalization cannot remove executable syntax from the review', async t => {
    const f = fixture(t);
    const command = 'curl https://example.test/$(printf${IFS}hidden-action)/../';
    let title = '';
    t.mock.method(f.owner, 'emit', (body: RuntimeEventBody) => {
        if (body.kind === 'request') { title = body.view.title; f.registry.respond(body.requestId, context, { optionId: 'allow' }); }
    });
    // Handler-only fixture. No shell execution or provider request occurs.
    const answer = await f.api.canUseTool('Bash', { command }, options());
    assert.equal(title, 'Bash: ' + command);
    assert.deepEqual(answer, { behavior: 'allow', updatedInput: { command } });
});

for (const scenario of [
    { name: 'safe without SDK title', permissions: 'safe' as const, extra: {} },
    { name: 'safe with generic short SDK title', permissions: 'safe' as const, extra: { title: 'Run a harmless command' } },
    { name: 'auto with matched ask rule', permissions: 'auto' as const,
        extra: { title: 'Run a harmless command', matchedAskRule: { source: 'userSettings', toolName: 'Bash' } } },
]) test(`unreviewable Bash suffix denies without opening a request: ${scenario.name}`, async t => {
    const f = fixture(t, scenario.permissions);
    const originalEmit = f.owner.emit;
    // If the defect opens a request, answer it so RED observes the erroneous allow without waiting for TTL.
    t.mock.method(f.owner, 'emit', (body: RuntimeEventBody) => {
        originalEmit(body);
        if (body.kind === 'request') f.registry.respond(body.requestId, context, { optionId: 'allow' });
    });
    const command = `printf '%s' '${'harmless'.repeat(80)}'; touch /tmp/hidden-extra-action`;
    assert.equal((await f.api.canUseTool('Bash', { command }, { ...options(), ...scenario.extra }))?.behavior, 'deny');
    assert.deepEqual(f.bodies, []);
    assert.deepEqual(f.registry.list('chat'), []);
});

test('Bash review shows actual command over a generic title and includes the complete 500-character boundary', async t => {
    const f = fixture(t);
    const command = 'echo ' + 'x'.repeat(489); // 494 + "Bash: " = exactly 500.
    const pending = f.api.canUseTool('Bash', { command }, { ...options(), title: 'Run command' });
    await f.published;
    const request = f.registry.list('chat')[0]!;
    f.registry.respond(request.requestId, context, { optionId: 'allow' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command } });
    assert.equal(request.view.title, `Bash: ${command}`);
});

test('ordinary auto bypass retains the full long command without applying the approval display cap', async t => {
    const f = fixture(t, 'auto');
    const input = { command: 'echo ' + 'x'.repeat(600) + '; touch /tmp/extra-action' };
    assert.deepEqual(await f.api.canUseTool('Bash', input, { ...options(), title: 'Run command' }), {
        behavior: 'allow', updatedInput: input,
    });
    assert.deepEqual(f.bodies, []);
});

// ─── Code sessions: "Allow for this session" and a gate that follows live mode switches ───

function grantFixture(t: TestContext, permissions: 'auto' | 'safe' = 'safe') {
    const registry = new RuntimeRequests();
    const bodies: RuntimeEventBody[] = [];
    const owner: ClaudePermissionOwner = { context, isCurrent: () => true, emit: body => { bodies.push(body); } };
    const api = createClaudePermissions({ registry, permissions, sessionGrants: true, resolveOwner: async () => owner });
    t.after(() => api.cancelAll());
    const nextRequest = async () => { for (let i = 0; i < 50 && !registry.list('chat').length; i++) await new Promise(r => setTimeout(r, 2)); return registry.list('chat')[0]!; };
    return { api, registry, bodies, nextRequest };
}

test('session grants add a third option and allow-session is valid only when offered', () => {
    assert.equal(validateClaudeApprovalResponse({ optionId: 'allow-session' }, true), 'allow-session');
    assert.throws(() => validateClaudeApprovalResponse({ optionId: 'allow-session' }));
    assert.deepEqual(encodeClaudeApprovalResponse('allow-session'), { optionId: 'allow-session' });
});

test('allow-session answers with session-scoped updates: rescoped suggestions, else a tool rule', async t => {
    const f = grantFixture(t);
    const withSuggestions = f.api.canUseTool('Bash', { command: 'npm test' }, { ...options(), suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
    ] } as never);
    const first = await f.nextRequest();
    assert.deepEqual(first.view.fields[0]!.options.map(o => o.id), ['allow', 'allow-session', 'deny']);
    f.registry.respond(first.requestId, context, { optionId: 'allow-session' });
    const granted = await withSuggestions as { updatedPermissions?: Array<{ destination: string }> };
    assert.deepEqual(granted.updatedPermissions?.map(u => u.destination), ['session'], 'never written to a settings file');

    const bare = f.api.canUseTool('Bash', { command: 'ls' }, options(new AbortController(), 'tool-2'));
    const second = await f.nextRequest();
    f.registry.respond(second.requestId, context, { optionId: 'allow-session' });
    assert.deepEqual((await bare as { updatedPermissions?: unknown }).updatedPermissions,
        [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);

    const once = f.api.canUseTool('Bash', { command: 'pwd' }, options(new AbortController(), 'tool-3'));
    const third = await f.nextRequest();
    f.registry.respond(third.requestId, context, { optionId: 'allow' });
    assert.equal((await once as { updatedPermissions?: unknown }).updatedPermissions, undefined, 'allow once writes no rule');
});

test('the gate follows live switches: bypass -> safe asks, safe -> bypass stops asking', async t => {
    const f = grantFixture(t, 'auto');
    assert.deepEqual(await f.api.canUseTool('Bash', { command: 'ls' }, options()), { behavior: 'allow', updatedInput: { command: 'ls' } });
    f.api.setGate('safe');
    const asked = f.api.canUseTool('Bash', { command: 'ls' }, options(new AbortController(), 'tool-2'));
    const request = await f.nextRequest();
    assert.ok(request, 'after switching to a safe mode the next tool asks');
    f.registry.respond(request.requestId, context, { optionId: 'deny' });
    assert.equal((await asked).behavior, 'deny');
    f.api.setGate('auto');
    assert.equal((await f.api.canUseTool('Bash', { command: 'ls' }, options(new AbortController(), 'tool-3'))).behavior, 'allow');
});
