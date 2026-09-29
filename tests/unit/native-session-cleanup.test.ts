import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getSessionBucket, upsertSessionBucket, insertMessageWithTrace } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { withSessionScope } from '../../src/core/session-context.ts';
import { clearSessionState, clearResumableSessionForScope } from '../../src/core/session-ops.ts';
import { autoCompactRefresh, cliSwitchRefresh } from '../../src/core/compact.ts';
import { newSessionHandler } from '../../src/cli/handlers/session-handlers.ts';
import { getSessionOwnershipGeneration, isCurrentSessionOwner, persistMainSession,
    resetSessionOwnershipGenerationForTest } from '../../src/agent/session-persistence.ts';
import { resolveRuntimeTransport, runtimeSessionBucket } from '../../src/agent/runtime/selection.ts';
import { peekPendingBootstrapPrompt } from '../../src/core/main-session.ts';

const providers = ['cursor', 'grok', 'claude'] as const;
function select(cli: string, transport: 'print' | 'native') {
    settings['cli'] = cli; settings['model'] = 'fixture-model';
    settings['perCli'] = { ...settings['perCli'], [cli]: { ...settings['perCli']?.[cli], transport } };
}
function seed(bucket: string, value = bucket) { upsertSessionBucket.run(bucket, value, 'fixture-model', null, 0); }
function sid(bucket: string) { return (getSessionBucket.get(bucket) as { session_id: string } | undefined)?.session_id; }
function singleton() { return (db.prepare("SELECT session_id FROM session WHERE id='default'").get() as { session_id: string | null }).session_id; }
function remaining() { return (db.prepare('SELECT bucket FROM session_buckets ORDER BY bucket').all() as Array<{ bucket: string }>).map(row => row.bucket); }
function seedPair(base: string) { seed(base, 'P:' + base); seed('native-v1:' + base, 'N:' + base); }
test.beforeEach(() => {
    db.prepare('DELETE FROM session_buckets').run();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM memory').run();
    db.prepare("UPDATE session SET session_id='singleton-P',active_chat_session='default' WHERE id='default'").run();
    settings['workingDir'] = ''; // No repository harvest/git subprocess from compact.
    settings['multiSession'] = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer',
        channels: { slack: true, telegram: true, discord: true } };
    select('claude', 'print');
    resetSessionOwnershipGenerationForTest();
});

for (const cli of providers) {
    for (const operation of ['new-buckets', 'clear'] as const) {
        test(`${cli} scoped ${operation} clears exact P/N keys, not colon descendants or similar scopes`, async () => {
            select(cli, 'native');
            const suffixes = ['', ':default', ':local:a', ':local:a:b', ':local:ab', ':local:a_b', ':local:a%b'];
            for (const suffix of suffixes) seedPair(cli + suffix);
            seedPair('other-provider:local:a');
            seed('codex-app:local:a:fixture:high');
            const before = remaining();
            await withSessionScope({ scope: 'local:a', chatSessionId: 'chat-a' }, () =>
                operation === 'clear' ? clearSessionState() : clearResumableSessionForScope());
            assert.deepEqual(remaining(), before.filter(key => key !== `${cli}:local:a` && key !== `native-v1:${cli}:local:a`));
        });
    }
    test(`${cli} instance-wide clear deletes selected P/N plus the existing Codex all-lane exception`, async () => {
        select(cli, 'print');
        for (const suffix of ['', ':default', ':local:a', ':local:a:b', ':local:ab']) seedPair(cli + suffix);
        const other = providers.find(provider => provider !== cli)!;
        seedPair(other); seedPair(other + ':local:a'); seed('codex-app:local:a:fixture:high'); seedPair(cli + '-similar');
        seed('codex-app:scope-b'); seed('codex-app'); seed('codex-app-similar:scope-a');
        seed('native-v1:codex-app:scope-a'); seed('pi');
        const before = remaining();
        await clearSessionState();
        // Baseline codex-session-bucket-db-child.mts:162 requires global reset
        // to clear codex-app: lanes with Claude selected too. Restore exactly
        // that exception, not a blanket other-provider deletion or a weakened
        // scoped-reset oracle; bare/similar Codex keys and Pi must still survive.
        assert.deepEqual(remaining(), before.filter(key => !(key === cli || key.startsWith(cli + ':')
            || key === 'native-v1:' + cli || key.startsWith('native-v1:' + cli + ':')
            || key.startsWith('codex-app:'))));
    });
}

for (const operation of ['new-buckets', 'clear'] as const) {
    test(`default ${operation} deletes bare and exact :default P/N keys only`, async () => {
        for (const suffix of ['', ':default', ':default:child', ':default-extra', ':local:a']) seedPair('claude' + suffix);
        seed('codex-app:default:fixture:high'); seed('codex-app:local:a');
        const before = remaining();
        await withSessionScope({ scope: 'default', chatSessionId: 'default' }, () =>
            operation === 'clear' ? clearSessionState() : clearResumableSessionForScope());
        assert.deepEqual(remaining(), before.filter(key => !['claude', 'claude:default', 'native-v1:claude', 'native-v1:claude:default'].includes(key)));
    });
}

test('scoped wildcard-looking keys remain literal and print/native/print toggles retain independent rows', async () => {
    seedPair('claude:local:a_%'); seedPair('claude:local:a_X'); seedPair('claude:local:a_%:child');
    const observed: Array<string | undefined> = [];
    for (const transport of ['print', 'native', 'print'] as const) {
        select('claude', transport);
        observed.push(sid(runtimeSessionBucket('claude:local:a_%', resolveRuntimeTransport(settings['perCli']['claude']?.transport))));
    }
    assert.deepEqual(observed, ['P:claude:local:a_%', 'N:claude:local:a_%', 'P:claude:local:a_%']);
    await withSessionScope({ scope: 'local:a_%', chatSessionId: 'chat-wildcard' }, clearResumableSessionForScope);
    assert.equal(sid('claude:local:a_%'), undefined); assert.equal(sid('native-v1:claude:local:a_%'), undefined);
    assert.equal(sid('native-v1:claude:local:a_%:child'), 'N:claude:local:a_%:child');
    assert.equal(sid('claude:local:a_X'), 'P:claude:local:a_X');
});

test('native auto compact fallback clears only N and leaves P singleton and adjacent scopes', async () => {
    select('claude', 'native'); seedPair('claude'); seedPair('claude:local:a');
    await autoCompactRefresh({ workDir: '', instructions: '', cli: 'claude', model: 'fixture-model', scopeKey: 'default', chatSessionId: 'default' });
    assert.equal(sid('native-v1:claude'), undefined); assert.equal(sid('claude'), 'P:claude');
    assert.equal(singleton(), 'singleton-P'); assert.equal(sid('native-v1:claude:local:a'), 'N:claude:local:a');
    assert.ok(peekPendingBootstrapPrompt('default'));
});

test('captured native compact stays N after settings toggle to P, never clears print singleton', async () => {
    select('claude', 'native'); seedPair('claude');
    const captured = runtimeSessionBucket('claude', 'native');
    select('claude', 'print');
    const lateOwner = getSessionOwnershipGeneration('default');
    await autoCompactRefresh({ workDir: '', instructions: '', cli: 'claude', model: 'fixture-model', scopeKey: 'default', sessionBucket: captured });
    assert.equal(sid('native-v1:claude'), undefined); assert.equal(sid('claude'), 'P:claude');
    assert.equal(singleton(), 'singleton-P'); assert.equal(isCurrentSessionOwner(lateOwner, 'default'), false);
});

test('captured print compact stays P after settings toggle to N and retains default singleton reset', async () => {
    seedPair('claude'); select('claude', 'native');
    await autoCompactRefresh({ workDir: '', instructions: '', cli: 'claude', model: 'fixture-model', scopeKey: 'default', sessionBucket: 'claude' });
    assert.equal(sid('claude'), undefined); assert.equal(sid('native-v1:claude'), 'N:claude');
    assert.equal(singleton(), null);
});

test('auto refresh leaves a bucket replaced during its async work untouched', async () => {
    seed('claude', 'old-session');
    const beforeMessages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const refresh = autoCompactRefresh({ workDir: '', instructions: '', cli: 'claude',
        model: 'fixture-model', scopeKey: 'default', sessionBucket: 'claude',
        expectedSessionId: 'old-session' });
    // autoCompactRefresh has entered its first awaited import but has not reached mutation.
    seed('claude', 'new-session');
    await refresh;
    assert.equal(sid('claude'), 'new-session');
    assert.equal(singleton(), 'singleton-P');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, beforeMessages);
});

for (const operation of ['new', 'clear'] as const) {
    test(`real ${operation} invalidates existing owner tokens and prevents late P/N repersistence`, async () => {
        seedPair('claude:local:a'); seedPair('claude:local:a:b');
        const owner = getSessionOwnershipGeneration('local:a');
        const neighbour = getSessionOwnershipGeneration('local:a:b');
        await withSessionScope({ scope: 'local:a', chatSessionId: 'chat-a' }, async () => {
            if (operation === 'new') assert.equal((await newSessionHandler(['fixture-new'])).ok, true);
            else await clearSessionState();
        });
        assert.equal(isCurrentSessionOwner(owner, 'local:a'), false);
        assert.equal(isCurrentSessionOwner(neighbour, 'local:a:b'), true);
        for (const transport of ['print', 'native'] as const) {
            const bucket = runtimeSessionBucket('claude:local:a', transport);
            const input = { persistenceOwner: owner, scopeKey: 'local:a', cli: 'claude', model: 'fixture-model', effort: 'high',
                sessionId: 'late-should-not-save', code: 0, scopedBucket: bucket, runtimeTransport: transport };
            assert.equal(persistMainSession(input), false); assert.equal(sid(bucket), undefined);
        }
        assert.equal(sid('native-v1:claude:local:a:b'), 'N:claude:local:a:b');
    });
}

for (const transport of ['print', 'native'] as const) {
    test(`explicit cliSwitchRefresh clears selected ${transport} target only and preserves fresh-start semantics`, async () => {
        select('grok', transport); seedPair('grok'); seedPair('grok:local:a'); seedPair('claude');
        const beforeOwner = getSessionOwnershipGeneration('local:a');
        const result = await cliSwitchRefresh({ sourceWorkDir: '', targetWorkDir: '', fromCli: 'claude', toCli: 'grok', toModel: 'fixture-model' });
        assert.equal(result.refreshed, true); assert.equal(result.targetBucketCleared, true);
        assert.equal(sid(transport === 'native' ? 'native-v1:grok' : 'grok'), undefined);
        assert.equal(sid(transport === 'native' ? 'grok' : 'native-v1:grok'), transport === 'native' ? 'P:grok' : 'N:grok');
        assert.equal(sid('grok:local:a'), 'P:grok:local:a'); assert.equal(sid('native-v1:grok:local:a'), 'N:grok:local:a');
        assert.equal(sid('claude'), 'P:claude'); assert.equal(singleton(), null);
        assert.equal(isCurrentSessionOwner(beforeOwner, 'local:a'), false);
    });
}

test('Codex lane prefix cleanup and builtin Pi unprefixed compact remain unchanged', async () => {
    select('codex-app', 'native');
    seed('codex-app:local:a:fixture:high'); seed('codex-app:local:ab:fixture:high');
    await withSessionScope({ scope: 'local:a', chatSessionId: 'chat-a' }, clearResumableSessionForScope);
    assert.equal(sid('codex-app:local:a:fixture:high'), undefined);
    assert.equal(sid('codex-app:local:ab:fixture:high'), 'codex-app:local:ab:fixture:high');
    select('pi', 'native'); seed('pi'); seed('native-v1:pi');
    await autoCompactRefresh({ workDir: '', instructions: '', cli: 'pi', model: 'fixture-model', scopeKey: 'default' });
    assert.equal(sid('pi'), undefined); assert.equal(sid('native-v1:pi'), 'native-v1:pi'); assert.equal(singleton(), null);
});

test('clear fallback still removes exact P/N keys when compact marker persistence fails', async context => {
    select('claude', 'native'); seedPair('claude:local:a'); seedPair('claude:local:a:b');
    const owner = getSessionOwnershipGeneration('local:a');
    context.mock.method(insertMessageWithTrace, 'run', () => { throw new Error('fixture compact marker write failure'); });
    await withSessionScope({ scope: 'local:a', chatSessionId: 'chat-a' }, clearSessionState);
    assert.equal(sid('claude:local:a'), undefined); assert.equal(sid('native-v1:claude:local:a'), undefined);
    assert.equal(sid('claude:local:a:b'), 'P:claude:local:a:b');
    assert.equal(sid('native-v1:claude:local:a:b'), 'N:claude:local:a:b');
    assert.equal(isCurrentSessionOwner(owner, 'local:a'), false);
});

test('scoped native compact fallback stays exact for every switchable provider', async () => {
    for (const cli of providers) {
        select(cli, 'native'); seedPair(cli + ':local:a'); seedPair(cli + ':local:a:b');
        await autoCompactRefresh({ workDir: '', instructions: '', cli, model: 'fixture-model',
            scopeKey: 'local:a', chatSessionId: 'chat-a' });
        assert.equal(sid(`native-v1:${cli}:local:a`), undefined);
        assert.equal(sid(`${cli}:local:a`), `P:${cli}:local:a`);
        assert.equal(sid(`native-v1:${cli}:local:a:b`), `N:${cli}:local:a:b`);
        assert.equal(singleton(), 'singleton-P');
        assert.ok(peekPendingBootstrapPrompt('local:a'));
    }
});
