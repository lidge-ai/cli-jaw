import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeInput } from '../../src/agent/runtime/claude-sdk-input.ts';
import { buildClaudeSdkOptions, type PreparedClaudeOptions } from '../../src/agent/runtime/claude-sdk-options.ts';
import { loadClaudeSdk } from '../../src/agent/runtime/claude-sdk-loader.ts';

function prepared(overrides: Partial<PreparedClaudeOptions> = {}): PreparedClaudeOptions {
    return {
        cwd: process.cwd(), binary: process.execPath,
        env: { PATH: '/prepared/bin', CLAUDE_TEST_VALUE: 'prepared', OMITTED: undefined },
        model: 'default', systemPrompt: 'Keep this exact prompt.\n한글',
        permissions: 'safe', fastMode: false, ...overrides,
    };
}

test('input rejects invalid capacities', () => {
    for (const capacity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => createClaudeInput(capacity), /Invalid input capacity/);
    }
});

test('input enforces capacity and FIFO, including undefined values', async () => {
    const input = createClaudeInput<string | undefined>(2);
    assert.equal(input.offer(undefined), true);
    assert.equal(input.offer('second'), true);
    assert.equal(input.size, 2);
    assert.equal(input.offer('rejected'), false);
    const reader = input.stream[Symbol.asyncIterator]();
    assert.deepEqual(await reader.next(), { done: false, value: undefined });
    assert.equal(input.size, 1);
    assert.equal(input.offer('third'), true);
    assert.deepEqual(await reader.next(), { done: false, value: 'second' });
    assert.deepEqual(await reader.next(), { done: false, value: 'third' });
    assert.equal(input.size, 0);
    input.close();
});

test('input permits one consumer and rejects concurrent pending reads without losing the first', async () => {
    const input = createClaudeInput<number>(1);
    const reader = input.stream[Symbol.asyncIterator]();
    assert.throws(() => input.stream[Symbol.asyncIterator](), /one consumer/);
    const pending = reader.next();
    await assert.rejects(reader.next(), /Concurrent input next/);
    assert.equal(input.offer(7), true);
    assert.equal(input.size, 0);
    assert.deepEqual(await pending, { done: false, value: 7 });
    input.close();
});

test('input close cancels a pending read and permanently refuses offers', async () => {
    const input = createClaudeInput<number>(1);
    const reader = input.stream[Symbol.asyncIterator]();
    const pending = reader.next();
    input.close();
    input.close();
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(input.offer(1), false);
    assert.deepEqual(await reader.next(), { done: true, value: undefined });
});

test('input close discards queued messages even before claiming its consumer', async () => {
    const input = createClaudeInput<number>(2);
    input.offer(1);
    input.offer(2);
    input.close();
    assert.equal(input.size, 0);
    assert.deepEqual(await input.stream[Symbol.asyncIterator]().next(), { done: true, value: undefined });
});

test('input iterator return cancels a pending read and early loop exit discards queued values', async () => {
    const input = createClaudeInput<number>(1);
    const reader = input.stream[Symbol.asyncIterator]();
    const pending = reader.next();
    assert.deepEqual(await reader.return!(), { done: true, value: undefined });
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(input.offer(1), false);
    const queued = createClaudeInput<number>(2);
    queued.offer(1);
    queued.offer(2);
    for await (const value of queued.stream) { assert.equal(value, 1); break; }
    assert.equal(queued.size, 0);
    assert.equal(queued.offer(3), false);
});

test('safe options preserve the Claude preset, setting sources and print limits', () => {
    const input = prepared();
    assert.deepEqual(buildClaudeSdkOptions(input), {
        cwd: input.cwd, pathToClaudeCodeExecutable: input.binary, env: input.env,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPrompt },
        settingSources: ['user', 'project', 'local'], includePartialMessages: true,
        maxTurns: 500, permissionMode: 'default',
    });
});

test('auto opts into both bypass flags and preserves model, resume, explicit high and fast mode', () => {
    const input = prepared({ permissions: 'auto', model: 'claude-sonnet-5', effort: 'high',
        fastMode: true, resumeSessionId: 'provider-session' });
    const options = buildClaudeSdkOptions(input);
    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.equal(options.model, 'claude-sonnet-5');
    assert.equal(options.effort, 'high');
    assert.equal(options.resume, 'provider-session');
    assert.deepEqual(options.settings, { fastMode: true });
    assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: input.systemPrompt });
});

test('print medium omission is preserved; other explicit efforts are forwarded', () => {
    for (const effort of ['low', 'high', 'xhigh', 'max'] as const) {
        assert.equal(buildClaudeSdkOptions(prepared({ effort })).effort, effort);
    }
    for (const effort of [undefined, 'medium'] as const) {
        assert.equal(Object.hasOwn(buildClaudeSdkOptions(prepared({ effort })), 'effort'), false);
    }
});

test('empty/default model and absent resume are omitted', () => {
    for (const model of ['', 'default']) {
        const options = buildClaudeSdkOptions(prepared({ model, systemPrompt: '' }));
        for (const key of ['effort', 'model', 'resume', 'settings', 'allowDangerouslySkipPermissions']) {
            assert.equal(Object.hasOwn(options, key), false, key);
        }
    }
});

test('options snapshot only the prepared environment and do not retain caller mutable objects', () => {
    const input = prepared();
    const first = buildClaudeSdkOptions(input);
    assert.notEqual(first.env, input.env);
    input.env.CLAUDE_TEST_VALUE = 'changed';
    input.systemPrompt = 'changed';
    assert.deepEqual(first.env, { PATH: '/prepared/bin', CLAUDE_TEST_VALUE: 'prepared', OMITTED: undefined });
    assert.deepEqual(first.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Keep this exact prompt.\n한글' });
    first.settingSources?.pop();
    assert.deepEqual(buildClaudeSdkOptions(input).settingSources, ['user', 'project', 'local']);
});

test('options reject runtime policy, path, environment and option shape errors before a caller starts a process', () => {
    const malformed: unknown[] = [null, [], false, {},
        ...['AUTO', 'default', 'bypassPermissions', '', null, true].map(permissions => ({ ...prepared(), permissions })),
        ...['ultra', '', null, 1, true].map(effort => ({ ...prepared(), effort })),
        ...['', ' ', 'relative/path', '/tmp/\0cwd', null].map(cwd => ({ ...prepared(), cwd })),
        ...['', ' ', 'bad\0binary', null, 12].map(binary => ({ ...prepared(), binary })),
        ...[null, 'env', [], { KEY: 1 }, { KEY: 'secret\0value' }, { 'BAD=KEY': 'value' },
            { '': 'value' }, { 'BAD\0KEY': 'value' }].map(env => ({ ...prepared(), env })),
        ...[null, 2, 'bad\0model', '   '].map(model => ({ ...prepared(), model })),
        ...[null, 12, 'bad\0prompt'].map(systemPrompt => ({ ...prepared(), systemPrompt })),
        ...['', ' ', null, 2, 'bad\0id'].map(resumeSessionId => ({ ...prepared(), resumeSessionId })),
        ...[undefined, null, 'false', 1].map(fastMode => ({ ...prepared(), fastMode })),
        { ...prepared(), permissionMode: 'bypassPermissions' },
        { ...prepared(), settings: { fastMode: true } },
    ];
    let starts = 0;
    for (const raw of malformed) {
        assert.throws(() => {
            // Deliberately cross the runtime boundary with malformed values.
            buildClaudeSdkOptions(raw as PreparedClaudeOptions);
            starts++;
        }, /Invalid Claude SDK/);
    }
    assert.equal(starts, 0);
});

test('validation errors never include raw prompt, environment or path values', () => {
    const secret = 'private-value\0invalid';
    for (const raw of [{ ...prepared(), binary: secret }, { ...prepared(), env: { SECRET: secret } },
        { ...prepared(), systemPrompt: secret }]) {
        assert.throws(() => buildClaudeSdkOptions(raw), error => {
            assert.ok(error instanceof Error);
            assert.equal(error.message.includes('private-value'), false);
            return true;
        });
    }
});

test('lazy loader shares in-flight work and successful loads for the same importer', async () => {
    let imports = 0;
    const query = () => { throw new Error('must not invoke query while loading'); };
    const importer = async () => { imports++; return { query }; };
    const first = loadClaudeSdk(importer);
    assert.equal(loadClaudeSdk(importer), first);
    const sdk = await first;
    assert.equal(sdk.query, query);
    assert.equal((await loadClaudeSdk(importer)).query, query);
    assert.equal(imports, 1);
});

test('lazy loader gives a redacted actionable missing-package error and retries a failed import', async () => {
    let imports = 0;
    const query = () => { throw new Error('query should not run'); };
    const importer = async () => {
        if (++imports === 1) throw new Error('Cannot find package at /private/secret/path');
        return { query };
    };
    await assert.rejects(loadClaudeSdk(importer), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Claude native SDK unavailable.*optional dependency.*print/);
        assert.equal(error.message.includes('/private/'), false);
        return true;
    });
    assert.equal((await loadClaudeSdk(importer)).query, query);
    assert.equal(imports, 2);
});

test('lazy loader rejects malformed exports and synchronous importer failures without poisoning retry', async () => {
    for (const result of [undefined, null, {}, { query: 'not-a-function' }]) {
        let imports = 0;
        const query = () => { throw new Error('query should not run'); };
        const importer = async () => ++imports === 1 ? result : { query };
        await assert.rejects(loadClaudeSdk(importer), /Claude native SDK unavailable/);
        assert.equal((await loadClaudeSdk(importer)).query, query);
    }
    let calls = 0;
    const importer = () => { calls++; throw new Error('synchronous failure'); };
    await assert.rejects(loadClaudeSdk(importer), /Claude native SDK unavailable/);
    await assert.rejects(loadClaudeSdk(importer), /Claude native SDK unavailable/);
    assert.equal(calls, 2);
});

test('Code sessions pin an exact SDK permission mode; jaw-shaped input keeps auto/safe', () => {
    assert.equal(buildClaudeSdkOptions(prepared()).permissionMode, 'default');
    assert.equal(buildClaudeSdkOptions(prepared()).allowDangerouslySkipPermissions, undefined);
    const plan = buildClaudeSdkOptions(prepared({ sdkMode: 'plan', allowDangerouslySkipPermissions: true, sessionGrants: true }));
    assert.equal(plan.permissionMode, 'plan');
    assert.equal(plan.allowDangerouslySkipPermissions, true, 'lets a later live switch to bypass be legal');
    assert.equal(buildClaudeSdkOptions(prepared({ permissions: 'auto', sdkMode: 'bypassPermissions' })).permissionMode, 'bypassPermissions');
    assert.throws(() => buildClaudeSdkOptions(prepared({ sdkMode: 'bypassPermissions' })), 'bypass needs the auto gate');
    assert.throws(() => buildClaudeSdkOptions(prepared({ permissions: 'auto', sdkMode: 'plan' })), 'the auto gate needs bypass');
    assert.throws(() => buildClaudeSdkOptions(prepared({ sdkMode: 'yolo' as never })));
});

test('thinking: on is adaptive with summaries, off is disabled, unset leaves the CLI default', () => {
    const on = buildClaudeSdkOptions(prepared({ thinking: true }));
    assert.deepEqual(on.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(on.settings, { alwaysThinkingEnabled: true, showThinkingSummaries: true });
    const off = buildClaudeSdkOptions(prepared({ thinking: false, fastMode: true }));
    assert.deepEqual(off.thinking, { type: 'disabled' });
    assert.deepEqual(off.settings, { fastMode: true, alwaysThinkingEnabled: false, showThinkingSummaries: false });
    const unset = buildClaudeSdkOptions(prepared());
    assert.equal(unset.thinking, undefined);
    assert.equal(unset.settings, undefined);
    assert.throws(() => buildClaudeSdkOptions(prepared({ thinking: 'yes' as never })));
});
