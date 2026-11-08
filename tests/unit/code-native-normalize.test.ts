import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { CodeTurnNormalizer, CODE_ITEM_MAX_CHARS, normalizeFileChanges, redactCodeText } from '../../src/code-mode/normalize.ts';
import type { CodeTurnNormalizerOptions } from '../../src/code-mode/normalize.ts';
import type { CodeTurnContext } from '../../src/code-mode/provider.ts';
import type { CodeItem } from '../../src/code-mode/wire.ts';
import { CodeStoreError } from '../../src/code-mode/store.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { RuntimeEnd, RuntimeToolPatch } from '../../src/agent/runtime/projection.ts';
import type { RuntimeEventBody, RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';
import { parseRuntimeEvent } from '../../src/shared/runtime-event-parse.ts';

let journalWrites = 0, publications = 0;
mock.module('../../src/trace/activity-journal.js', { namedExports: {
    appendActivityBody: () => { journalWrites++; throw new Error('unexpected Jaw journal'); },
    markActivityFailure: () => { journalWrites++; },
} });
mock.module('../../src/core/event-bus.js', { namedExports: { publish: () => { publications++; } } });
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
test.after(() => { assert.equal(journalWrites, 0); assert.equal(publications, 0); });

const done: RuntimeTurnOutcome = { status: 'done', finalText: null, partialText: '' };
const end: RuntimeEnd = { kind: 'turn-end', status: 'done', finalText: null };
const approval: Extract<RuntimeEventBody, { kind: 'request' }> = {
    kind: 'request', requestId: 'permission-1', requestType: 'approval', view: {
        title: 'Read README', fields: [{ id: 'decision', label: 'Permission', multiSelect: false, allowFreeform: false,
            options: [{ id: 'opaque-allow', label: 'Allow once' }, { id: 'opaque-deny', label: 'Deny' }] }],
    },
};
function fixture(options: Partial<CodeTurnNormalizerOptions> = {}) {
    let current = true, time = 10;
    const context: CodeTurnContext = { runId: 'run', sessionId: 'session', turnId: 'turn', scope: 'code:session',
        audience: 'internal', epoch: 7, isCurrent: () => current };
    const writes: CodeItem[] = [], items = new Map<string, CodeItem>(), failures: unknown[] = [];
    const normalizer = new CodeTurnNormalizer({ context, now: () => ++time,
        commitItem: item => {
            writes.push(structuredClone(item)); items.set(item.itemId, structuredClone(item));
            return { publish() {} };
        },
        failPersistence: error => { failures.push(error); }, ...options });
    const observer = normalizer.observer(context);
    const rows = (kind?: CodeItem['kind']) => [...items.values()].filter(item => !kind || item.kind === kind);
    return { context, normalizer, observer, writes, items, failures, rows, stale: () => { current = false; } };
}

test('raw observer retains >3000 per field, >160 items and >24000 total through the real preview projection', () => {
    const f = fixture();
    const projection = new RuntimeProjection(f.context, (owner, body) => f.normalizer.record(owner, body), () => {}, f.observer);
    const values = Array.from({ length: 180 }, (_, i) => `${i}:` + 'readable text '.repeat(320));
    for (const [i, value] of values.entries()) projection.text('message', `native-${i}`, value, 'replace', 'commentary');
    projection.tool('beyond-preview', { name: 'Read', input: 'input '.repeat(700), output: 'output '.repeat(700), status: 'done' });
    projection.close(end);
    f.normalizer.finish({ ...done, finalText: values.join('') });
    assert.deepEqual(f.rows('assistant_message').map(item => item.text), values);
    assert.ok(values.every(value => value.length > 3000));
    assert.ok(values.join('').length > 24000);
    assert.equal(f.rows('tool_call')[0]?.tool?.output, 'output '.repeat(700));
    assert.ok(f.normalizer.resolveParent(f.context, 'beyond-preview') === null, 'finished turns reject lookups');
    assert.ok(projection.diagnostics().items <= 160);
    assert.ok(projection.diagnostics().previewChars <= 24000);
    assert.equal(f.rows('notice').length, 0);
    assert.deepEqual(f.failures, []);
});

test('append/replace, empty answers, first appearance order and real phases survive item updates', () => {
    const f = fixture();
    f.observer.text('message', 'a', 'first', 'append', 'commentary');
    f.observer.tool('b', { name: 'Read' }, {});
    const original = f.rows()[0]!;
    f.observer.text('message', 'a', ' second', 'append', 'unknown');
    assert.equal(f.rows()[0]?.text, 'first second');
    assert.equal(f.rows()[0]?.phase, 'commentary');
    f.observer.text('message', 'a', '', 'replace', 'final');
    f.normalizer.finish({ ...done, finalText: 'must not replace authoritative empty' });
    const after = f.rows()[0]!;
    assert.equal(after.itemId, original.itemId);
    assert.equal(after.createdAt, original.createdAt);
    assert.ok(after.updatedAt > original.updatedAt);
    assert.equal(after.text, ''); assert.equal(after.phase, 'final');
    assert.deepEqual(f.rows().map(item => item.kind), ['assistant_message', 'tool_call']);
    assert.equal(after.firstSequence, undefined, 'store alone owns firstSequence');
});

test('split structured JSON secrets remain withheld on every intermediate commit', () => {
    const f = fixture();
    f.observer.tool('json', { delta: '{"password":"first-', outputStructured: true }, {});
    const first = f.rows('tool_call')[0]!;
    assert.equal(first.tool?.output, '[structured content withheld]');
    assert.match(first.truncation!.reason, /structured_incomplete/);
    f.observer.tool('json', { delta: 'second","ok":true}', outputStructured: true, status: 'done' }, {});
    assert.deepEqual(JSON.parse(f.rows('tool_call')[0]!.tool!.output!), { password: '[REDACTED]', ok: true });
    assert.equal(f.rows('tool_call')[0]?.truncation, undefined);
    assert.ok(!JSON.stringify(f.writes).includes('first-'));
    assert.ok(!JSON.stringify(f.writes).includes('second'));
});

test('JSON-shaped message chunks are withheld even without a structured tool hint', () => {
    const f = fixture();
    f.observer.text('message', 'json', '{"token":"private-', 'append', 'unknown');
    f.observer.text('message', 'json', 'value","message":"ok"}', 'append', 'final');
    assert.equal(f.writes[0]?.text, '[structured content withheld]');
    assert.deepEqual(JSON.parse(f.rows('assistant_message')[0]!.text!), { token: '[REDACTED]', message: 'ok' });
    assert.ok(!JSON.stringify(f.writes).includes('private-'));
});

test('a split JSON fence is reconstructed before secret redaction while Markdown links remain prose', () => {
    const f = fixture();
    f.observer.text('message', 'fence', '`', 'append', 'unknown');
    f.observer.text('message', 'fence', '``json\n{"password":"hidden', 'append', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, '[structured content withheld]');
    f.observer.text('message', 'fence', '"}\n```', 'append', 'final');
    assert.ok(!JSON.stringify(f.writes).includes('hidden'));
    f.observer.text('message', 'link', '[', 'append', 'commentary');
    f.observer.text('message', 'link', 'docs](https://example.test) are useful', 'append', 'commentary');
    assert.equal(f.rows('assistant_message')[1]?.text, '[docs](https://example.test) are useful');
});

test('full source redaction precedes clipping and partial plaintext credentials never leak', () => {
    const f = fixture({ maxFieldChars: 64 });
    f.observer.text('message', 'prose', 'prefix TOKEN=' + 'canary'.repeat(40), 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'prefix TOKEN=[REDACTED]');
    f.observer.text('message', 'chunks', 'key sk-partial', 'append', 'unknown');
    f.observer.text('message', 'chunks', 'credentialmaterial0123456789', 'append', 'final');
    assert.ok(!JSON.stringify(f.writes).includes('canary'));
    assert.ok(!JSON.stringify(f.writes).includes('sk-partial'));
});

test('1Mi field cap retains plaintext and exposes accurate source/stored counts with one capacity notice', () => {
    const f = fixture();
    f.observer.text('message', 'large', 'x'.repeat(CODE_ITEM_MAX_CHARS + 100), 'replace', 'final');
    let row = f.rows('assistant_message')[0]!;
    assert.equal(row.text?.length, 1_048_576);
    assert.equal(row.truncation?.storedChars, 1_048_576);
    assert.equal(row.truncation?.sourceChars, 1_048_676);
    assert.match(row.truncation!.reason, /field_limit/);
    const writes = f.writes.length;
    f.observer.text('message', 'large', 'tail', 'append', 'unknown');
    assert.equal(f.writes.length, writes, 'retired source-count-only changes wait for final flush');
    f.normalizer.finish(done);
    row = f.rows('assistant_message')[0]!;
    assert.equal(row.text?.length, 1_048_576);
    assert.equal(row.truncation?.sourceChars, 1_048_680);
    assert.equal(f.rows('notice').length, 1);
});

test('raw cap retirement preserves old text and a fresh replacement can recover', () => {
    const f = fixture({ maxFieldChars: 32 });
    f.observer.text('message', 'm', 'retained', 'append', 'unknown');
    f.observer.text('message', 'm', 'x'.repeat(33), 'append', 'unknown');
    f.observer.text('message', 'm', 'later', 'append', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, 'retained');
    assert.equal(f.rows('assistant_message')[0]?.truncation?.sourceChars, 41, 'later retired counts are not committed yet');
    f.observer.text('message', 'm', 'recovered', 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'recovered');
    assert.equal(f.rows('assistant_message')[0]?.truncation, undefined);
});

test('structured cap retirement never joins a clipped JSON prefix to a later suffix', () => {
    const f = fixture({ maxFieldChars: 48 });
    f.observer.tool('m', { delta: '{"password":"', outputStructured: true }, {});
    f.observer.tool('m', { delta: 'private'.repeat(20), outputStructured: true }, {});
    f.observer.tool('m', { delta: '"}', status: 'done' }, {});
    assert.equal(f.rows('tool_call')[0]?.tool?.output, '[structured content withheld]');
    assert.ok(!JSON.stringify(f.writes).includes('private'));
    assert.match(f.rows('tool_call')[0]!.truncation!.reason, /field_limit/);
    assert.equal(f.rows('notice').length, 1);
});

test('total cap includes raw and sanitized accumulation without evicting existing item text', () => {
    const f = fixture({ maxTotalChars: 100, maxFieldChars: 100 });
    f.observer.text('message', 'a', 'a'.repeat(40), 'replace', 'unknown');
    f.observer.text('message', 'b', 'b'.repeat(40), 'replace', 'unknown');
    f.observer.text('message', 'c', 'c'.repeat(40), 'replace', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, 'a'.repeat(40));
    assert.equal(f.rows('assistant_message')[1]?.text, 'b'.repeat(20));
    assert.match(f.rows('assistant_message')[1]!.truncation!.reason, /total_limit/);
    assert.equal(f.rows('assistant_message').length, 2);
    assert.equal(f.rows('notice').length, 1);
});

test('item cap allocates one reserved capacity notice and existing tools can still settle', () => {
    const f = fixture({ maxItems: 2 });
    f.observer.tool('first', {}, {}); f.observer.tool('second', {}, {});
    for (let i = 0; i < 100; i++) f.observer.tool(`overflow-${i}`, {}, {});
    f.observer.tool('first', { status: 'done', output: 'finished' }, {});
    assert.equal(f.rows().length, 3);
    assert.equal(f.rows('notice').length, 1);
    assert.equal(f.rows('tool_call')[0]?.status, 'done');
    assert.equal(f.normalizer.resolveParent(f.context, 'overflow-0'), null);
});

test('clipping does not leave half of a surrogate pair', () => {
    const f = fixture({ maxFieldChars: 4 });
    f.observer.text('message', 'emoji', 'abc😀tail', 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'abc');
    assert.equal(f.rows('assistant_message')[0]?.truncation?.storedChars, 3);
});

test('stable namespaces distinguish kind, child, nested parent and turn without exposing native refs', () => {
    const f = fixture();
    f.observer.tool('native-secret-ref', { name: 'Agent' }, {});
    const parent = f.normalizer.resolveParent(f.context, 'native-secret-ref')!;
    assert.ok(parent);
    const child: RuntimeEventContext = { ...f.context, parentItemId: parent };
    const observer = f.normalizer.observer(child);
    observer.tool('native-secret-ref', { name: 'Agent' }, {});
    const nested = f.normalizer.resolveParent(child, 'native-secret-ref')!;
    f.normalizer.observer({ ...f.context, parentItemId: nested }).text('message', 'same', 'nested', 'replace', 'final');
    observer.text('message', 'same', 'child', 'replace', 'final');
    f.observer.text('message', 'same', 'root', 'replace', 'final');
    f.observer.text('reasoning', 'same', 'reasoning', 'replace', 'commentary');
    assert.equal(new Set(f.rows().map(item => item.itemId)).size, 6);
    assert.notEqual(parent, nested);
    assert.equal(f.rows('assistant_message')[0]?.parentItemId, nested);
    assert.equal(f.rows('assistant_message')[1]?.parentItemId, parent);
    assert.ok(!JSON.stringify(f.writes).includes('native-secret-ref'));
    const again = fixture(); again.observer.tool('native-secret-ref', { name: 'Agent' }, {});
    assert.equal(again.rows()[0]?.itemId, parent);
    const other = fixture({ context: { ...f.context, turnId: 'other' } });
    other.normalizer.observer({ ...f.context, turnId: 'other' }).tool('native-secret-ref', {}, {});
    assert.notEqual(other.rows()[0]?.itemId, parent);
});

test('a parent cannot be resolved reentrantly before its first commit returns', () => {
    let normalizer: CodeTurnNormalizer | undefined;
    const observations: Array<string | null> = [];
    const f = fixture({ commitItem() {
        observations.push(normalizer!.resolveParent(f.context, 'parent'));
        return { publish() {} };
    } });
    normalizer = f.normalizer;
    f.observer.tool('parent', { name: 'Agent' }, {});
    assert.deepEqual(observations, [null]);
    assert.ok(f.normalizer.resolveParent(f.context, 'parent'));
});

test('child close affects only its own unfinished rows and never commits a global turn terminal', () => {
    const f = fixture(); f.observer.tool('parent', { name: 'Agent' }, {});
    f.observer.tool('root-tool', {}, {});
    const parentItemId = f.normalizer.resolveParent(f.context, 'parent')!;
    const child = f.normalizer.observer({ ...f.context, parentItemId });
    child.tool('child-tool', {}, {}); child.text('message', 'child-message', 'child result', 'append', 'unknown');
    child.close(end); child.close(end);
    child.tool('late', { status: 'done' }, {});
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['running', 'running', 'cancelled']);
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
    f.observer.text('message', 'root', 'root alive', 'append', 'commentary');
    assert.equal(f.rows('assistant_message')[1]?.status, 'running');
    f.normalizer.finish({ ...done, status: 'error' });
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['error', 'error', 'cancelled']);
    assert.equal(f.rows('assistant_message')[1]?.status, 'error');
    assert.ok(f.rows().every(item => !item.kind.startsWith('turn_')));
});

test('root close leaves child content active until whole-turn finish', () => {
    const f = fixture(); f.observer.tool('parent', { name: 'Agent' }, {});
    const child = f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! });
    child.text('message', 'child', 'first', 'append', 'unknown');
    f.observer.close(end);
    child.text('message', 'child', ' second', 'append', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'first second');
    assert.equal(f.rows('assistant_message')[0]?.status, 'running');
    f.normalizer.finish(done);
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
});

test('terminal tool result survives late start; only explicit terminal refresh replaces authority', () => {
    const f = fixture();
    f.observer.tool('tool', { status: 'error', output: 'original', detail: 'original detail' }, {});
    f.observer.tool('tool', { name: 'Read', input: '{"path":"file"}', status: 'running', output: 'late', detail: 'late' }, {});
    let row = f.rows('tool_call')[0]!;
    assert.equal(row.status, 'error');
    assert.deepEqual(row.tool, { name: 'Read', input: '{"path":"file"}', output: 'original', detail: 'original detail' });
    f.observer.tool('tool', { status: 'done', output: 'ignored' }, {});
    assert.equal(f.rows('tool_call')[0]?.tool?.output, 'original');
    f.observer.tool('tool', { status: 'done', output: 'refreshed' }, { allowTerminalUpdates: true });
    row = f.rows('tool_call')[0]!;
    assert.equal(row.status, 'done'); assert.equal(row.tool?.output, 'refreshed');
    f.observer.close(end); f.observer.tool('tool', { status: 'error' }, { allowTerminalUpdates: true });
    assert.equal(f.rows('tool_call')[0]?.status, 'done');
});

test('aggregate final text never duplicates several observed native assistant items', () => {
    const f = fixture();
    f.observer.text('message', 'one', 'one', 'replace', 'commentary');
    f.observer.text('message', 'two', 'two', 'replace', 'final');
    f.observer.close({ ...end, finalText: 'onetwo' });
    f.normalizer.finish({ ...done, finalText: 'onetwo' });
    assert.deepEqual(f.rows('assistant_message').map(item => [item.text, item.phase]), [['one', 'commentary'], ['two', 'final']]);
});

for (const [finalText, partialText, expected, phase] of [
    ['fallback', '', 'fallback', 'final'], ['', 'partial', '', 'final'],
    [null, 'partial', 'partial', 'unknown'], [null, '', null, null],
] as const) test(`unobserved final fallback preserves null/empty/partial distinction: ${JSON.stringify(finalText)}, ${partialText}`, () => {
    const f = fixture();
    f.normalizer.finish({ status: 'stopped', finalText, partialText });
    const rows = f.rows('assistant_message');
    if (expected === null) assert.equal(rows.length, 0);
    else { assert.equal(rows[0]?.text, expected); assert.equal(rows[0]?.phase, phase); assert.equal(rows[0]?.status, 'cancelled'); }
});

test('child assistant output does not suppress an unobserved root fallback', () => {
    const f = fixture(); f.observer.tool('parent', {}, {});
    f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! })
        .text('message', 'child', 'child', 'replace', 'final');
    f.normalizer.finish({ ...done, finalText: 'root fallback' });
    assert.deepEqual(f.rows('assistant_message').map(item => item.text), ['child', 'root fallback']);
});

test('preview recording provides monotonic validated internal identities without canonical duplicate writes', () => {
    const f = fixture();
    const bodies: RuntimeEventBody[] = [{ kind: 'turn-start', provider: 'claude' },
        { kind: 'message', itemId: 'preview', text: 'preview only', operation: 'replace', phase: 'final' },
        { kind: 'reasoning', itemId: 'preview', text: 'preview only', operation: 'replace' },
        { kind: 'tool', itemId: 'preview', status: 'done', name: 'Read', output: 'preview only' },
        { kind: 'usage', inputTokens: 7 }, { ...end, finalText: 'x'.repeat(300_000) }];
    const events = bodies.map(body => f.normalizer.record(f.context, body));
    assert.deepEqual(events.map(event => event?.seq), [1, 2, 3, 4, 5, 6]);
    for (const event of events) assert.deepEqual(parseRuntimeEvent(event), event);
    assert.equal(f.writes.length, 0);
    f.observer.text('message', 'native', 'still running', 'replace', 'commentary');
    assert.equal(f.rows()[0]?.status, 'running');
});

test('permission projection uses immutable root epoch even when helper context omits private fields', () => {
    const f = fixture();
    const helper: RuntimeEventContext = { runId: 'run', sessionId: 'session', scope: 'code:session', turnId: 'turn', audience: 'internal' };
    f.context.epoch = 99;
    f.normalizer.record(helper, approval);
    const row = f.rows('permission_request')[0]!;
    assert.equal(row.status, 'pending'); assert.equal(row.permission?.epoch, 7);
    assert.deepEqual(row.permission?.options, [{ optionId: 'opaque-allow', label: 'Allow once', kind: 'approval' },
        { optionId: 'opaque-deny', label: 'Deny', kind: 'approval' }]);
    f.normalizer.record(helper, { kind: 'request-settled', requestId: approval.requestId });
    f.normalizer.record(helper, approval);
    assert.equal(f.rows('permission_request')[0]?.status, 'done');
    assert.equal(f.rows('permission_request').length, 1);
});

test('permission settlement before request metadata cannot reopen a pending approval', () => {
    const f = fixture();
    f.normalizer.record(f.context, { kind: 'request-settled', requestId: approval.requestId });
    f.normalizer.record(f.context, approval);
    assert.equal(f.rows('permission_request').length, 1);
    assert.equal(f.rows('permission_request')[0]?.status, 'done');
    assert.equal(f.rows('permission_request')[0]?.permission, undefined);
});

test('duplicate requests do not spend capacity again and control notices cannot collide with native IDs', () => {
    const f = fixture({ maxTotalChars: 600 });
    f.normalizer.record(f.context, approval);
    f.normalizer.record(f.context, approval);
    assert.equal(f.rows('permission_request').length, 1);
    assert.equal(f.rows('notice').length, 0);
    const capped = fixture({ maxItems: 1 });
    capped.normalizer.record(capped.context, { ...approval, requestType: 'question', requestId: 'capacity' });
    capped.observer.tool('over-capacity', {}, {});
    assert.equal(capped.rows('notice').length, 2);
});

test('recorder allocates distinct sequences even when persistence reenters recording', () => {
    let nestedSequence: number | undefined;
    const f = fixture({ commitItem() {
        nestedSequence = f.normalizer.record(f.context, { kind: 'usage' })?.seq;
        return { publish() {} };
    } });
    const outer = f.normalizer.record(f.context, approval);
    assert.equal(outer?.seq, 1); assert.equal(nestedSequence, 2);
    assert.equal(f.normalizer.record(f.context, { kind: 'usage' })?.seq, 3);
});

test('request labels are sanitized before persistence; unsupported questions are visible without invented answers', () => {
    const f = fixture();
    f.normalizer.record(f.context, { ...approval, view: { ...approval.view, title: 'TOKEN=canary' } });
    f.normalizer.record(f.context, { ...approval, requestId: 'question', requestType: 'question' });
    assert.equal(f.rows('permission_request')[0]?.permission?.title, 'TOKEN=[REDACTED]');
    assert.equal(f.rows('notice').length, 1);
    assert.match(f.rows('notice')[0]!.text!, /Unsupported native question/);
    assert.equal(f.rows('notice')[0]?.permission, undefined);
    assert.ok(!JSON.stringify(f.writes).includes('canary'));
});

test('multi-field/freeform approval cannot be silently flattened', () => {
    const f = fixture();
    for (const [index, fields] of [
        [{ ...approval.view.fields[0]!, allowFreeform: true }],
        [{ ...approval.view.fields[0]!, multiSelect: true }],
        [approval.view.fields[0]!, { ...approval.view.fields[0]!, id: 'second' }],
    ].entries()) f.normalizer.record(f.context, { ...approval, requestId: `unsupported-${index}`, view: { ...approval.view, fields } });
    assert.equal(f.rows('permission_request').length, 0); assert.equal(f.rows('notice').length, 3);
});

test('permission payload capacity is counted and pending permission is cancelled on finish', () => {
    const small = fixture({ maxTotalChars: 64 });
    small.normalizer.record(small.context, approval);
    assert.equal(small.rows('permission_request').length, 0); assert.equal(small.rows('notice').length, 1);
    const f = fixture(); f.normalizer.record(f.context, approval); f.normalizer.finish(done);
    assert.equal(f.rows('permission_request')[0]?.status, 'cancelled');
});

test('wrong session/run/turn/scope/audience/unlinked parent are rejected before writes or sequence allocation', () => {
    const f = fixture();
    for (const patch of [{ sessionId: 'foreign' }, { runId: 'foreign' }, { turnId: 'foreign' },
        { scope: 'foreign' }, { audience: 'public' as const }, { parentItemId: 'missing' }]) {
        const context = { ...f.context, ...patch };
        const observer = f.normalizer.observer(context);
        observer.text('message', 'bad', 'bad', 'replace', 'final'); observer.close(end);
        assert.equal(f.normalizer.record(context, approval), null);
        assert.equal(f.normalizer.resolveParent(context, 'anything'), null);
    }
    assert.equal(f.writes.length, 0);
    assert.equal(f.normalizer.record(f.context, { kind: 'usage' })?.seq, 1);
});

test('captured observer identity survives external mutation, then current predicate fences all late work', () => {
    const f = fixture();
    const mutable = { ...f.context }, observer = f.normalizer.observer(mutable);
    mutable.turnId = 'other'; f.context.turnId = 'also-other';
    observer.text('message', 'm', 'captured', 'replace', 'final');
    assert.equal(f.rows()[0]?.turnId, 'turn');
    f.stale(); observer.text('message', 'm', 'late', 'replace', 'final'); observer.close(end);
    f.normalizer.finish({ ...done, finalText: 'late' });
    assert.equal(f.rows()[0]?.text, 'captured'); assert.equal(f.rows()[0]?.status, 'running');
});

for (const stage of ['text', 'tool', 'close', 'record', 'finish', 'child'] as const) test(`persistence failure at ${stage} latches before throw and blocks all later writes`, () => {
    const error = new Error('injected persistence failure');
    let armed = false, writes = 0;
    const failures: unknown[] = [];
    const f = fixture({ commitItem() { writes++; if (armed) throw error; return { publish() {} }; }, failPersistence: error => { failures.push(error); } });
    let observer = f.observer;
    if (stage === 'child') {
        observer.tool('parent', {}, {});
        observer = f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! });
    }
    if (stage === 'close' || stage === 'finish') observer.tool('unfinished', {}, {});
    armed = true;
    assert.throws(() => {
        if (stage === 'text' || stage === 'child') observer.text('message', 'm', 'text', 'append', 'unknown');
        if (stage === 'tool') observer.tool('tool', {}, {});
        if (stage === 'close') observer.close(end);
        if (stage === 'record') f.normalizer.record(f.context, approval);
        if (stage === 'finish') f.normalizer.finish(done);
    }, error);
    assert.deepEqual(failures, [error]);
    const count = writes;
    observer.text('message', 'late', 'late', 'replace', 'final'); observer.close(end);
    f.normalizer.finish({ ...done, finalText: 'native success' });
    assert.equal(f.normalizer.record(f.context, approval), null);
    assert.equal(writes, count);
});

test('projection-swallowed observer failure still reaches the owning persistence latch', () => {
    const error = new Error('write failed'), failures: unknown[] = [];
    const f = fixture({ commitItem: () => { throw error; }, failPersistence: error => { failures.push(error); } });
    const projection = new RuntimeProjection(f.context, (owner, body) => f.normalizer.record(owner, body), () => {}, f.observer);
    assert.doesNotThrow(() => projection.text('message', 'm', 'lost', 'replace', 'final'));
    projection.close(end); f.normalizer.finish({ ...done, finalText: 'native success' });
    assert.deepEqual(failures, [error]); assert.equal(projection.diagnostics().recordingFailed, true);
});

test('failure latch precedes reentrant cleanup and preserves the original write error', () => {
    const original = new Error('original write failure'), nested = new Error('cleanup failed');
    let writes = 0, callbacks = 0;
    const f = fixture({ commitItem() { writes++; throw original; }, failPersistence() {
        callbacks++;
        f.normalizer.finish({ ...done, finalText: 'reentrant success' });
        f.observer.tool('late', {}, {});
        throw nested;
    } });
    assert.throws(() => f.observer.text('message', 'm', 'lost', 'replace', 'final'), original);
    assert.equal(writes, 1); assert.equal(callbacks, 1);
});

test('malformed raw patch and invalid recorded event latch normalization failure without leaking content', () => {
    const raw = fixture();
    assert.throws(() => raw.observer.tool('tool', { output: 42 } as unknown as RuntimeToolPatch, {}), /invalid_code_native_text/);
    assert.equal(raw.failures.length, 1); assert.equal(raw.writes.length, 0);
    const record = fixture();
    assert.throws(() => record.normalizer.record(record.context, { kind: 'usage', inputTokens: -1 }), /invalid_runtime_event/);
    assert.equal(record.failures.length, 1); assert.equal(record.writes.length, 0);
    const closed = fixture();
    assert.throws(() => closed.observer.close({ ...end, status: 'running' } as unknown as RuntimeEnd), /invalid_code_native_end/);
    assert.equal(closed.failures.length, 1); assert.equal(closed.writes.length, 0);
});

test('malformed structured text remains explicit withholding, not an invented successful JSON value', () => {
    const f = fixture();
    f.observer.tool('malformed', { output: '{broken password', outputStructured: true, status: 'error' }, {});
    f.normalizer.finish({ ...done, status: 'error' });
    assert.equal(f.rows('tool_call')[0]?.tool?.output, '[structured content withheld]');
    assert.match(f.rows('tool_call')[0]!.truncation!.reason, /structured_incomplete/);
    assert.equal(f.rows('tool_call')[0]?.status, 'error');
});

test('finish is idempotent, ignores later native terminals and never overwrites established tool status', () => {
    const f = fixture(); f.observer.tool('done', { status: 'done', output: 'actual' }, {});
    f.observer.tool('open', {}, {}); f.normalizer.finish({ ...done, status: 'stopped' });
    const before = structuredClone(f.rows());
    f.normalizer.finish({ ...done, finalText: 'late' }); f.observer.close(end);
    f.observer.tool('open', { status: 'done' }, { allowTerminalUpdates: true });
    assert.equal(f.normalizer.record(f.context, { ...end, finalText: 'late' }), null);
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['done', 'cancelled']);
});

test('invalid budgets reject construction rather than disabling bounded accumulation', () => {
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
        assert.throws(() => fixture({ maxFieldChars: value }), /invalid_code_normalizer_limit/);
        assert.throws(() => fixture({ maxTotalChars: value }), /invalid_code_normalizer_limit/);
        assert.throws(() => fixture({ maxItems: value }), /invalid_code_normalizer_limit/);
    }
});

const fencedSecret = 'Before the result:\n```json\n{"password":"canary-value","ok":true}\n```\nAfter the result.';
const fencedSafe = 'Before the result:\n```json\n{"password":"[REDACTED]","ok":true}\n```\nAfter the result.';

test('redactCodeText masks offset JSON fences independently while retaining surrounding prose', () => {
    assert.equal(redactCodeText(fencedSecret), fencedSafe);
    assert.equal(redactCodeText('prose ```json\n{"password":"canary-value"}\n```\ntrailing'),
        'prose ```json\n{"password":"[REDACTED]"}\n```\ntrailing');
    assert.equal(redactCodeText('prose ```json{"password":"canary-value"}``` trailing'),
        'prose [structured content withheld]', 'inline markers do not close a Markdown fence');
    assert.equal(redactCodeText('ordinary [Markdown](https://example.test)'), 'ordinary [Markdown](https://example.test)');
    assert.equal(redactCodeText('{"password":"canary-value"}'), '{"password":"[REDACTED]"}');
    assert.equal(redactCodeText('{"password":"canary-value', true), '[structured content withheld]');
});

test('every split in an embedded JSON fence is safe before each immediate commit', () => {
    for (let split = 1; split < fencedSecret.length; split++) {
        const f = fixture();
        f.observer.text('message', 'm', fencedSecret.slice(0, split), 'append', 'commentary');
        f.observer.text('message', 'm', fencedSecret.slice(split), 'append', 'final');
        f.normalizer.finish(done);
        assert.equal(f.rows('assistant_message')[0]?.text, fencedSafe, `split ${split}`);
        assert.ok(!JSON.stringify(f.writes).includes('canary-value'), `split ${split} leaked`);
    }
});

test('partial language names, opening fences and closing fences stay private during character chunks', () => {
    const f = fixture();
    for (const char of fencedSecret) {
        f.observer.text('message', 'm', char, 'append', 'commentary');
        assert.ok(!JSON.stringify(f.writes.at(-1)).includes('canary'), 'no partial secret may appear either');
    }
    for (const language of ['j', 'js', 'jso', 'json']) {
        assert.equal(redactCodeText(`prefix \`\`\`${language}`), 'prefix [structured content withheld]');
    }
    assert.equal(f.rows('assistant_message')[0]?.text, fencedSafe);
});

test('multiple complete and incomplete blocks preserve interstitial text without leaking later blocks', () => {
    const first = 'one ```json\n{"token":"canary-one"}\n```\nafter one';
    const second = '\ntwo ```json\n{"password":"canary-two"}\n```\nafter two';
    const incomplete = '\nthree ```json\n{"secret":"canary-three';
    const safe = redactCodeText(first + second + incomplete);
    assert.equal(safe, 'one ```json\n{"token":"[REDACTED]"}\n```\nafter one'
        + '\ntwo ```json\n{"password":"[REDACTED]"}\n```\nafter two\nthree [structured content withheld]');
    assert.ok(!safe.includes('canary'));
    assert.equal(redactCodeText('```json\n{"password":"canary-value"}\n```\nplain suffix'),
        '```json\n{"password":"[REDACTED]"}\n```\nplain suffix');
});

test('backticks inside JSON strings and malformed quoted bodies cannot terminate a redaction region', () => {
    assert.equal(redactCodeText('prefix ```json\n{"password":"canary-```-value","ok":true}\n```\nsuffix'),
        'prefix ```json\n{"password":"[REDACTED]","ok":true}\n```\nsuffix');
    assert.equal(redactCodeText('prefix ```json\n{"password":"canary-value\n``` suffix'),
        'prefix [structured content withheld]');
    assert.equal(redactCodeText('prefix ````JSON\n{"password":"canary-value"}\n````\nsuffix'),
        'prefix ````JSON\n{"password":"[REDACTED]"}\n````\nsuffix');
    assert.ok(!redactCodeText('{"password":"canary-value","description":"```json {} ```"}', true).includes('canary'));
});

test('embedded fences remain masked through field and total retirement, replacement and final flush', () => {
    for (const coalesceMs of [0, 50]) for (const caps of [{ maxFieldChars: 80 }, { maxTotalChars: 160 }]) {
        const f = fixture({ ...caps, coalesceMs });
        f.observer.text('message', 'm', 'prefix ```json\n{"password":"', 'append', 'commentary');
        f.observer.text('message', 'm', 'canary-value'.repeat(20), 'append', 'commentary');
        f.observer.text('message', 'm', '"}\n``` after', 'append', 'final');
        f.normalizer.finish(done);
        assert.ok(!JSON.stringify(f.writes).includes('canary'));
        assert.ok(f.rows('assistant_message')[0]?.truncation);
        assert.equal(f.rows('notice').length, 1);
        const replacement = fixture({ ...caps, coalesceMs });
        replacement.observer.text('message', 'm', fencedSecret + 'x'.repeat(300), 'replace', 'final');
        replacement.normalizer.finish(done);
        assert.ok(!JSON.stringify(replacement.writes).includes('canary'));
    }
});

test('permission titles, details and options share the embedded fence redactor before bounded view encoding', () => {
    const f = fixture();
    const label = 'Read ```json\n{"password":"canary-value"}\n```\nplease';
    f.normalizer.record(f.context, { ...approval, view: { title: label, fields: [{
        ...approval.view.fields[0]!, label, options: [{ id: 'opaque', label }],
    }] } });
    const permission = f.rows('permission_request')[0]!.permission!;
    const expected = 'Read ```json\n{"password":"[REDACTED]"}\n```\nplease';
    assert.equal(permission.title, expected); assert.equal(permission.detail, expected);
    assert.equal(permission.options[0]?.label, expected);
    assert.ok(!JSON.stringify(f.writes).includes('canary'));
});

test('10,000 quick appends coalesce before commits and final flush retains exactly 1,000,000 characters', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const f = fixture({ coalesceMs: 50 });
    const chunk = '0123456789'.repeat(10);
    for (let i = 0; i < 10_000; i++) f.observer.text('message', 'm', chunk, 'append', 'commentary');
    assert.equal(f.writes.length, 1, 'first item only; no intermediate store sequence allocations');
    assert.equal(scheduled.mock.callCount(), 1, 'one shared timer, not one per patch');
    f.normalizer.finish(done);
    assert.equal(f.writes.length, 2, 'final content and status share a full-item flush');
    assert.equal(f.rows('assistant_message')[0]?.text, chunk.repeat(10_000));
    assert.equal(f.rows('assistant_message')[0]?.text?.length, 1_000_000);
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
    assert.ok(cleared.mock.calls.some(call => call.arguments[0] === scheduled.mock.calls[0]?.result));
    t.mock.timers.tick(5000);
    assert.equal(f.writes.length, 2); assert.equal(scheduled.mock.callCount(), 1);
});

test('timed flush publishes full replacements, with immediate first parents, controls and terminal tool state', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ coalesceMs: 50 });
    f.observer.text('message', 'm', 'one', 'append', 'commentary');
    f.observer.text('message', 'm', ' two', 'append', 'commentary');
    f.observer.tool('parent', { name: 'Agent' }, {});
    assert.ok(f.normalizer.resolveParent(f.context, 'parent'));
    f.normalizer.record(f.context, approval);
    assert.equal(f.rows('permission_request')[0]?.status, 'pending');
    f.observer.tool('parent', { delta: 'tool output' }, {});
    f.observer.tool('parent', { status: 'done' }, {});
    assert.equal(f.rows('tool_call')[0]?.tool?.output, 'tool output');
    assert.equal(f.rows('tool_call')[0]?.status, 'done');
    t.mock.timers.tick(49);
    assert.equal(f.rows('assistant_message')[0]?.text, 'one');
    t.mock.timers.tick(1);
    assert.equal(f.rows('assistant_message')[0]?.text, 'one two');
    f.observer.text('message', 'm', ' three', 'append', 'final');
    f.observer.close(end);
    assert.equal(f.rows('assistant_message')[0]?.text, 'one two three');
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
    const writes = f.writes.length;
    t.mock.timers.tick(1000); f.normalizer.finish(done);
    assert.equal(f.writes.length, writes);
});

test('child close flushes its own pending content while the root coalescing timer remains active', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ coalesceMs: 50 }); f.observer.tool('parent', {}, {});
    const child = f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! });
    f.observer.text('message', 'root', 'root', 'append', 'commentary');
    child.text('message', 'child', 'child', 'append', 'commentary');
    f.observer.text('message', 'root', ' pending', 'append', 'commentary');
    child.text('message', 'child', ' pending', 'append', 'final');
    child.close(end);
    assert.deepEqual(f.rows('assistant_message').map(row => row.text), ['root', 'child pending']);
    t.mock.timers.tick(50);
    assert.deepEqual(f.rows('assistant_message').map(row => row.text), ['root pending', 'child pending']);
    f.normalizer.finish(done);
});

test('coalesced tool metadata remains authoritative before flush and native detail survives close', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ coalesceMs: 50 });
    f.observer.tool('terminal', { status: 'done', output: 'authoritative' }, {});
    f.observer.tool('terminal', { name: 'Read', input: 'original input' }, {});
    f.observer.tool('terminal', { name: 'Wrong', input: 'wrong input', output: 'wrong output' }, {});
    f.observer.tool('unfinished', {}, {});
    f.observer.tool('unfinished', { delta: 'retained output', detail: 'native progress' }, {});
    f.observer.close(end);
    assert.deepEqual(f.rows('tool_call')[0]?.tool, { name: 'Read', input: 'original input', output: 'authoritative' });
    assert.equal(f.rows('tool_call')[1]?.tool?.detail, 'native progress');
    assert.equal(f.rows('tool_call')[1]?.tool?.output, 'retained output');
    assert.equal(f.rows('tool_call')[1]?.status, 'cancelled');
    const before = f.writes.length; t.mock.timers.tick(5000);
    assert.equal(f.writes.length, before);
});

test('coalesced embedded JSON never leaks at a timer boundary or the final flush', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ coalesceMs: 50 });
    for (const char of fencedSecret) {
        f.observer.text('message', 'm', char, 'append', 'commentary');
        t.mock.timers.tick(50);
        assert.ok(!JSON.stringify(f.writes.at(-1)).includes('canary'));
    }
    f.normalizer.finish(done);
    assert.equal(f.rows('assistant_message')[0]?.text, fencedSafe);
});

for (const coalesceMs of [0, 50]) test(`retired source-count-only changes wait until close, with no repeated writes or timers (${coalesceMs})`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const f = fixture({ maxFieldChars: 10, coalesceMs });
    f.observer.text('message', 'm', 'x'.repeat(20), 'replace', 'commentary');
    const firstWrites = f.writes.length;
    for (let i = 0; i < 10_000; i++) f.observer.text('message', 'm', 'y', 'append', 'unknown');
    assert.equal(f.writes.length, firstWrites); assert.equal(scheduled.mock.callCount(), 0);
    assert.equal(f.rows('assistant_message')[0]?.truncation?.sourceChars, 20);
    f.observer.close(end);
    assert.equal(f.writes.length, firstWrites + 1);
    assert.equal(f.rows('assistant_message')[0]?.text, 'x'.repeat(10));
    assert.equal(f.rows('assistant_message')[0]?.truncation?.sourceChars, 10_020);
});

test('unchanged full items and repeated terminal patches do not create duplicate commits', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const coalesceMs of [0, 50]) {
        const f = fixture({ coalesceMs });
        f.observer.text('message', 'm', 'same', 'replace', 'final');
        f.observer.tool('t', { status: 'done', output: 'same' }, {});
        for (let i = 0; i < 10; i++) {
            f.observer.text('message', 'm', 'same', 'replace', 'final');
            f.observer.tool('t', { status: 'done', output: 'same' }, { allowTerminalUpdates: true });
        }
        t.mock.timers.tick(50);
        assert.equal(f.writes.length, 2);
        f.normalizer.finish(done);
        assert.equal(f.writes.length, 3, 'only assistant status actually changed');
    }
});

for (const fence of ['stale-callback', 'stale-timer', 'failure', 'finish'] as const) test(`coalescing timer is cleared by ${fence}`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    let writes = 0, fail = false;
    const failures: unknown[] = [];
    const f = fixture({ coalesceMs: 50, commitItem() { if (fail) throw new Error('write failed'); writes++; return { publish() {} }; },
        failPersistence: error => { failures.push(error); } });
    f.observer.text('message', 'm', 'one', 'append', 'commentary');
    f.observer.text('message', 'm', ' two', 'append', 'commentary');
    if (fence === 'finish') f.normalizer.finish(done);
    else if (fence === 'failure') { fail = true; assert.throws(() => f.observer.tool('immediate', {}, {}), /write failed/); }
    else { f.stale(); if (fence === 'stale-callback') f.observer.close(end); }
    if (fence !== 'stale-timer') assert.ok(cleared.mock.calls.some(call => call.arguments[0] === scheduled.mock.calls[0]?.result));
    const before = writes;
    assert.doesNotThrow(() => t.mock.timers.tick(5000));
    assert.equal(writes, before); assert.equal(scheduled.mock.callCount(), 1);
    assert.equal(failures.length, fence === 'failure' ? 1 : 0);
});

test('timer write exceptions latch once without becoming uncaught or allowing native success to flush', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = new Error('timed persistence failure');
    let writes = 0, failures = 0;
    const f = fixture({ coalesceMs: 50, commitItem() { if (++writes > 1) throw original; return { publish() {} }; },
        failPersistence(error) { assert.equal(error, original); failures++; throw new Error('cleanup failed too'); } });
    f.observer.text('message', 'm', 'one', 'append', 'commentary');
    f.observer.text('message', 'm', ' two', 'append', 'commentary');
    assert.doesNotThrow(() => t.mock.timers.tick(50));
    assert.equal(failures, 1); assert.equal(writes, 2);
    f.normalizer.finish({ ...done, finalText: 'late success' });
    f.observer.text('message', 'm', ' late', 'append', 'final');
    t.mock.timers.tick(5000);
    assert.equal(failures, 1); assert.equal(writes, 2);
});

test('coalesce delay accepts zero but rejects invalid or overflowing timers', () => {
    fixture({ coalesceMs: 0 });
    for (const coalesceMs of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
        assert.throws(() => fixture({ coalesceMs }), /invalid_code_coalesce_ms/);
    }
});

test('observed stale ownership cannot revive a cleared pending accumulator', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let current = true;
    const base = fixture();
    const context = { ...base.context, isCurrent: () => current };
    const f = fixture({ context, coalesceMs: 50 });
    f.observer.text('message', 'm', 'first', 'append', 'commentary');
    f.observer.text('message', 'm', ' pending', 'append', 'commentary');
    current = false; t.mock.timers.tick(50);
    current = true;
    f.observer.text('message', 'm', ' revived', 'append', 'final');
    f.normalizer.finish(done); t.mock.timers.tick(1000);
    assert.equal(f.writes.length, 1); assert.equal(f.rows('assistant_message')[0]?.text, 'first');
});

test('tilde and unlabeled JSON fences preserve surrounding prose at every possible split', () => {
    for (const opening of ['~~~json', '~~~', '```', '````json', '````']) {
        const closing = opening.startsWith('~') ? '~~~' : opening.startsWith('````') ? '````' : '```';
        const text = `Before the result.\n${opening}\n{"password":"canary-value","ok":true}\n${closing}\nAfter the result.`;
        const expected = `Before the result.\n${opening}\n{"password":"[REDACTED]","ok":true}\n${closing}\nAfter the result.`;
        assert.equal(redactCodeText(text), expected, opening);
        for (let split = 1; split < text.length; split++) {
            const f = fixture();
            f.observer.text('message', 'm', text.slice(0, split), 'append', 'commentary');
            assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), `${opening}, prefix ${split}`);
            f.observer.text('message', 'm', text.slice(split), 'append', 'final');
            f.normalizer.finish(done);
            assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), `${opening}, completed ${split}`);
            assert.equal(f.rows('assistant_message')[0]?.text, expected);
        }
    }
});

test('tilde partial languages and unlabeled partial bodies remain withheld before a closing line', () => {
    for (const tail of ['~~~', '~~~j', '~~~js', '~~~jso', '~~~json', '~~~\n', '```\n', '~~~\n{',
        '~~~\n{"password":"canary-value', '```\n[{"password":"canary-value"}']) {
        assert.equal(redactCodeText(`Before.\n${tail}`), 'Before.\n[structured content withheld]', tail);
    }
    const text = 'Before.\n~~~\n[{"password":"canary-value"}]\n~~~\nAfter.';
    assert.equal(redactCodeText(text), 'Before.\n~~~\n[{"password":"[REDACTED]"}]\n~~~\nAfter.');
});

test('tilde and unlabeled character chunks never leak through coalesced commit boundaries', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const opening of ['~~~json', '~~~', '```', '````']) {
        const closing = opening.startsWith('~') ? '~~~' : opening;
        const text = `Before.\n${opening}\n{"password":"canary-value"}\n${closing}\nAfter.`;
        const f = fixture({ coalesceMs: 50 });
        for (const char of text) {
            f.observer.text('message', 'm', char, 'append', 'commentary');
            t.mock.timers.tick(50);
            assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), opening);
        }
        f.normalizer.finish(done);
        assert.equal(f.rows('assistant_message')[0]?.text,
            `Before.\n${opening}\n{"password":"[REDACTED]"}\n${closing}\nAfter.`);
    }
});

test('unquoted inline fence runs in malformed JSON cannot expose the remaining body', () => {
    for (const fence of ['```', '~~~', '````']) {
        const text = `Before.\n${fence}json\nnot JSON ${fence} {"password":"canary-value"}\n${fence}\nAfter.`;
        const f = fixture();
        for (const char of text) {
            f.observer.text('message', 'm', char, 'append', 'commentary');
            assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), fence);
        }
        f.normalizer.finish(done);
        assert.equal(f.rows('assistant_message')[0]?.text,
            `Before.\n${fence}json\n[structured content withheld]\n${fence}\nAfter.`);
    }
});

test('mismatched, short, over-indented and suffixed fence lines do not release structured content', () => {
    for (const badClosing of ['~~~', '```', '    ````', '```` trailing', 'inline ````']) {
        const text = `Before.\n\`\`\`\`json\nnot JSON\n${badClosing}\n{"password":"canary-value"}\n\`\`\`\`\nAfter.`;
        const f = fixture();
        for (const char of text) {
            f.observer.text('message', 'm', char, 'append', 'commentary');
            assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), badClosing);
        }
        f.normalizer.finish(done);
        assert.equal(f.rows('assistant_message')[0]?.text,
            'Before.\n````json\n[structured content withheld]\n````\nAfter.');
    }
});

test('longer closing runs, up to three spaces and CRLF retain valid fence formatting', () => {
    const text = 'Before.\r\n~~~JSON\r\n{"password":"canary-value"}\r\n   ~~~~~ \t\r\nAfter.';
    assert.equal(redactCodeText(text),
        'Before.\r\n~~~JSON\r\n{"password":"[REDACTED]"}\r\n   ~~~~~ \t\r\nAfter.');
    assert.equal(redactCodeText('Before.\n````\n{"password":"canary-value"}\n`````\nAfter.'),
        'Before.\n````\n{"password":"[REDACTED]"}\n`````\nAfter.');
});

test('ordinary and empty code fences remain intact beside unlabeled JSON fences', () => {
    const text = 'Before.\n```text\nordinary code\n```\n~~~\n~~~\nBetween.\n```\n{"password":"canary-value"}\n```\nAfter.';
    assert.equal(redactCodeText(text),
        'Before.\n```text\nordinary code\n```\n~~~\n~~~\nBetween.\n```\n{"password":"[REDACTED]"}\n```\nAfter.');
});

test('tilde and unlabeled incomplete bodies remain redacted when raw capacity retires the field', () => {
    for (const opening of ['~~~json', '~~~', '```']) for (const coalesceMs of [0, 50]) {
        const f = fixture({ coalesceMs, maxFieldChars: 80 });
        f.observer.text('message', 'm', `Before.\n${opening}\n{"password":"`, 'append', 'commentary');
        f.observer.text('message', 'm', 'canary-value'.repeat(50), 'append', 'commentary');
        f.observer.text('message', 'm', '"}\n~~~\nAfter.', 'append', 'final');
        f.normalizer.finish(done);
        assert.ok(f.writes.every(item => !JSON.stringify(item).includes('canary-value')), opening);
        assert.ok(f.rows('assistant_message')[0]?.text?.startsWith('Before.\n'));
        assert.match(f.rows('assistant_message')[0]!.truncation!.reason, /field_limit/);
    }
});

test('RT01: publication observes the acknowledged write before reentrant sealing', () => {
    let batch: readonly CodeItem[] | undefined;
    const published: string[] = [];
    const f = fixture({ commitItem(item) {
        return { publish() {
            published.push(item.text ?? '');
            batch = f.normalizer.sealAccepted();
            f.observer.text('message', 'late', 'not accepted', 'replace', 'final');
        } };
    } });
    f.observer.text('message', 'first', 'A', 'replace', 'final');
    assert.deepEqual(published, ['A']);
    assert.deepEqual(batch, [], 'the published first item was already committed');
    assert.deepEqual(f.normalizer.sealAccepted(), []);
    assert.equal(f.normalizer.record(f.context, approval), null);
});

test('RT01: seal detaches redacted pending content once and closes every callback before currentness', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let ownerReads = 0;
    const f = fixture({ coalesceMs: 50, context: {
        runId: 'run', sessionId: 'session', turnId: 'turn', scope: 'code:session', audience: 'internal', epoch: 7,
        isCurrent() { ownerReads++; return true; },
    } });
    f.observer.text('message', 'answer', 'A', 'replace', 'commentary');
    f.observer.text('message', 'answer', 'B', 'append', 'final');
    f.observer.tool('json', { name: 'Read', output: '{"password":"', outputStructured: true }, {});
    f.observer.tool('json', { delta: 'canary-value","ok":true}', outputStructured: true }, {});
    const before = f.writes.length;
    ownerReads = 0;
    const batch = f.normalizer.sealAccepted();
    const retained = structuredClone(batch);
    assert.equal(batch.length, 2);
    assert.equal(batch[0]?.text, 'AB');
    assert.equal(batch[0]?.phase, 'final');
    assert.equal(batch[0]?.status, 'running');
    assert.deepEqual(JSON.parse(batch[1]!.tool!.output!), { password: '[REDACTED]', ok: true });
    assert.equal(JSON.stringify(batch).includes('canary-value'), false);
    // A new observer's context predicate must not be consulted after the seal.
    const late = f.normalizer.observer({ ...f.context, runId: 'late' });
    f.observer.text('message', 'answer', 'C', 'append', 'final');
    late.tool('other', { output: 'late' }, {});
    f.observer.close(end);
    f.normalizer.finish({ ...done, finalText: 'late fallback' });
    assert.equal(f.normalizer.resolveParent(f.context, 'json'), null);
    assert.equal(f.normalizer.record(f.context, approval), null);
    t.mock.timers.tick(1000);
    assert.deepEqual(batch, retained);
    assert.deepEqual(f.normalizer.sealAccepted(), []);
    assert.equal(f.writes.length, before, 'sealing itself never persists or publishes');
    assert.equal(ownerReads, 0);
});

test('RT01: terminal capture preserves empty replacement and retired metadata-only updates', () => {
    const f = fixture({ coalesceMs: 50, maxFieldChars: 8 });
    f.observer.text('message', 'empty', 'old', 'replace', 'unknown');
    f.observer.text('message', 'empty', '', 'replace', 'final');
    f.observer.text('reasoning', 'large', '123456789', 'replace', 'unknown');
    f.observer.text('reasoning', 'large', 'more', 'append', 'unknown');
    const batch = f.normalizer.sealAccepted();
    assert.equal(batch.length, 2);
    assert.equal(batch[0]?.text, '');
    assert.equal(batch[0]?.phase, 'final');
    assert.equal(batch[1]?.text, '12345678');
    assert.equal(batch[1]?.truncation?.sourceChars, 13);
    assert.equal(batch[1]?.truncation?.reason, 'field_limit');
});

for (const reason of ['stale', 'failed', 'denied'] as const) {
    test(`RT01: ${reason} buffers cannot be reclaimed by the terminal drain`, t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let reject = false, writes = 0, published = 0;
        const f = fixture({ coalesceMs: 50, commitItem() {
            writes++;
            if (reject && reason === 'failed') throw new Error('disk failure');
            if (reject) return null;
            return { publish() { published++; } };
        } });
        f.observer.text('message', 'm', 'A', 'replace', 'unknown');
        f.observer.text('message', 'm', 'B', 'append', 'unknown');
        if (reason === 'stale') { f.stale(); t.mock.timers.tick(50); }
        else {
            reject = true;
            if (reason === 'failed') assert.throws(() => f.observer.tool('fault', {}, {}), /disk failure/);
            else f.observer.tool('fault', {}, {});
        }
        assert.deepEqual(f.normalizer.sealAccepted(), []);
        f.normalizer.finish({ ...done, finalText: 'late success' });
        t.mock.timers.tick(1000);
        assert.equal(writes, reason === 'stale' ? 1 : 2);
        assert.equal(published, 1);
        assert.equal(f.failures.length, reason === 'failed' ? 1 : 0);
    });
}

test('file change promotion retains bounded redacted metadata and terminal authority', () => {
    const f = fixture();
    f.observer.tool('edit', { name: 'file change', input: 'x'.repeat(1000), status: 'running' }, {});
    const id = f.rows('tool_call')[0]!.itemId;
    const chargedBefore = (f.normalizer as any).chars as number;
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [
        { path: 'a', kind: { type: 'add' }, diff: '' },
        { path: 'b', kind: { type: 'update', move_path: 'c' }, diff: 'sk-secret-token' },
        { path: 'd', kind: { type: 'bogus' }, diff: 'private' }, 42,
    ] }, {});
    const item = f.rows('file_change')[0]!;
    assert.equal(item.itemId, id);
    assert.equal(item.tool?.input, undefined);
    assert.ok((f.normalizer as any).chars < chargedBefore);
    assert.deepEqual(item.fileChange, { schema: 'unknown', changes: [
        { path: 'a', kind: 'add', patch: 'captured', diff: '' },
        { path: 'b', kind: 'rename', movePath: 'c', patch: 'withheld' },
        { path: 'd', kind: 'unknown', patch: 'missing' },
    ], unrecognizedChanges: 1 });
    f.observer.tool('edit', { status: 'done' }, {});
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [{ path: 'late', kind: { type: 'add' }, diff: 'late' }] }, {});
    assert.deepEqual(f.rows('file_change')[0]?.fileChange, item.fileChange);
});

test('file change seal drains pending replacement', () => {
    const f = fixture({ coalesceMs: 100 });
    f.observer.tool('edit', { semantic: 'file_change', status: 'running', fileChanges: [{ path: 'a', kind: { type: 'update' }, diff: 'first' }] }, {});
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [{ path: 'a', kind: { type: 'update' }, diff: 'latest' }] }, {});
    assert.equal(f.normalizer.sealAccepted()[0]?.fileChange?.changes[0]?.diff, 'latest');
});

test('file change budgets trim large escaped diffs, count omitted paths and preserve close semantics', () => {
    const f = fixture({ maxFieldChars: 400 });
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [
        { path: 'big', kind: { type: 'add' }, diff: '\u0001'.repeat(200) },
        { path: 'small', kind: { type: 'delete' }, diff: 'ok' },
        ...Array.from({ length: 30 }, (_, i) => ({ path: 'path-' + i, kind: { type: 'update' }, diff: '' })),
    ] }, {});
    const item = f.rows('file_change')[0]!;
    assert.equal(item.fileChange?.changes[0]?.patch, 'truncated');
    assert.ok((item.fileChange?.omittedChanges ?? 0) > 0);
    assert.equal((item.fileChange?.changes.length ?? 0) + (item.fileChange?.omittedChanges ?? 0), 32);
    assert.match(item.truncation?.reason ?? '', /file_change_limit/);
    const parent = f.normalizer.resolveParent(f.context, 'edit');
    assert.ok(parent);
    f.normalizer.observer({ ...f.context, parentItemId: parent }).text('message', 'child', 'ok', 'replace', 'final');
    f.observer.close(end);
    assert.equal(f.rows('file_change')[0]?.status, 'cancelled');
    assert.equal(f.rows('file_change')[0]?.tool?.detail, 'No native terminal tool result received');
    assert.equal(f.rows('assistant_message')[0]?.text, 'ok');
});

test('file change late patchUpdated cannot fill a terminal item but late start can', () => {
    const f = fixture();
    f.observer.tool('edit', { semantic: 'file_change', status: 'done' }, {});
    const changes = [{ path: 'a', kind: { type: 'update' }, diff: 'x' }];
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: changes }, {});
    assert.equal(f.rows('file_change')[0]?.fileChange, undefined);
    f.observer.tool('edit', { semantic: 'file_change', status: 'running', fileChanges: changes }, {});
    assert.equal(f.rows('file_change')[0]?.fileChange?.changes[0]?.diff, 'x');
});

test('file change running replacements obey one whole-event budget and completion keeps latest', () => {
    const f = fixture({ coalesceMs: 0 });
    const patch = 'x'.repeat(500_000);
    for (const ref of ['one', 'two']) {
        f.observer.tool(ref, { semantic: 'file_change', status: 'running', fileChanges: [{ path: ref, kind: { type: 'update' }, diff: patch }] }, {});
    }
    const start = f.writes.length;
    for (let i = 0; i < 30; i++) for (const ref of ['one', 'two']) {
        f.observer.tool(ref, { semantic: 'file_change', fileChanges: [{ path: ref, kind: { type: 'update' }, diff: patch + i }] }, {});
    }
    const runningBytes = f.writes.slice(start).reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1024, 0);
    assert.ok(runningBytes <= 8 * 1024 * 1024);
    for (const ref of ['one', 'two']) f.observer.tool(ref, { status: 'done' }, {});
    assert.deepEqual(f.rows('file_change').map(item => item.fileChange?.changes[0]?.diff?.slice(-2)), ['29', '29']);
});

test('file change redacts paths, withholds secrets and handles an unknown payload', () => {
    const f = fixture();
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [
        { path: 'sk-secret-token', kind: { type: 'delete' }, diff: 'ordinary' },
        { path: 'safe', kind: { type: 'add' }, diff: 'sk-secret-token' },
    ] }, {});
    const value = f.rows('file_change')[0]?.fileChange!;
    assert.equal(value.changes[0]?.path, '[REDACTED]');
    assert.deepEqual(value.changes.map(change => change.patch), ['withheld', 'withheld']);
    assert.ok(!JSON.stringify(value).includes('sk-secret-token'));
    f.observer.tool('other', { semantic: 'file_change', fileChanges: { private: 'do not expose' } }, {});
    assert.deepEqual(f.rows('file_change')[1]?.fileChange, { schema: 'unknown', changes: [] });
});

test('file change diff credentials are withheld on added and removed lines', () => {
    const diffs = ['+  "password": "new-secret"', '+password: hunter2', '+API_KEY=abc123',
        '+const clientSecret = "x"', '+Authorization: Basic abc123', '-password: old'];
    const ordinary = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n+This token is described in prose\n+const count = 42';
    const changes = [...diffs, ordinary].map((diff, i) => ({ path: `file${i}`, kind: { type: 'update' }, diff }));
    const result = normalizeFileChanges(changes, { maxBytes: 100_000, maxChars: 100_000 }).value.changes;
    assert.deepEqual(result.map(change => change.patch), [...diffs.map(() => 'withheld'), 'captured']);
    assert.ok(result.slice(0, -1).every(change => change.diff === undefined));
    assert.equal(result.at(-1)?.diff, ordinary);
});

test('file change diff credentials split across lines or escaped in JSON keys are withheld through the store item', () => {
    const diffs = [
        '@@ -1,2 +1,3 @@\n {\n+  "password":\n+    "hunter2"\n }',
        '@@ -1 +1 @@\n+  "pass\\u0077ord": "hunter2"',
        '@@ -1 +1,2 @@\n+client_secret =\n+  "abc"',
    ];
    const f = fixture();
    diffs.forEach((diff, i) => f.observer.tool(`edit-${i}`, { semantic: 'file_change',
        fileChanges: [{ path: `config${i}.json`, kind: { type: 'update' }, diff }], status: 'done' }, {}));
    const stored = f.rows('file_change');
    assert.equal(stored.length, diffs.length);
    for (const item of stored) {
        assert.equal(item.fileChange?.changes[0]?.patch, 'withheld');
        assert.equal(item.fileChange?.changes[0]?.diff, undefined);
        assert.doesNotMatch(JSON.stringify(item), /hunter2|"abc"/);
    }
});

test('file change trimming matches naive reference and scales to 5000 patches', () => {
    const fits = (value: unknown, maxBytes: number, maxChars: number) => {
        const json = JSON.stringify(value);
        return json.length <= maxChars && Buffer.byteLength(json) <= maxBytes;
    };
    function naive(raw: Array<{ path: string; kind: { type: 'update' }; diff: string }>, maxBytes: number, maxChars: number) {
        const value = { schema: 'known' as const, changes: raw.map(({ path, diff }) =>
            ({ path, kind: 'update' as const, patch: 'captured' as 'captured' | 'truncated', diff: diff as string | undefined })),
            omittedChanges: undefined as number | undefined };
        // Match property order and absence of optional fields in the real payload.
        delete value.omittedChanges;
        if (fits(value, maxBytes, maxChars)) return value;
        const order = value.changes.map((change, index) => ({ change, index }))
            .sort((a, b) => Buffer.byteLength(JSON.stringify(b.change.diff)) - Buffer.byteLength(JSON.stringify(a.change.diff)) || a.index - b.index);
        for (const { change } of order) {
            delete change.diff; change.patch = 'truncated';
            if (fits(value, maxBytes, maxChars)) return value;
        }
        const all = value.changes, count = all.length;
        let low = 0, high = count;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            value.changes = all.slice(0, middle); value.omittedChanges = count - middle;
            if (fits(value, maxBytes, maxChars)) low = middle; else high = middle - 1;
        }
        value.changes = all.slice(0, low);
        if (count - low) value.omittedChanges = count - low;
        return fits(value, maxBytes, maxChars) ? value : { schema: 'known', changes: [], omittedChanges: count };
    }
    let seed = 17;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    for (let trial = 0; trial < 80; trial++) {
        const raw = Array.from({ length: 1 + random() % 25 }, (_, i) => ({ path: `p${i}é`, kind: { type: 'update' as const },
            diff: ['x', 'é', '\n', '😀', '"'][random() % 5]!.repeat(random() % 80) }));
        const maxBytes = 20 + random() % 1800, maxChars = 20 + random() % 1800;
        assert.deepEqual(normalizeFileChanges(raw, { maxBytes, maxChars }).value, naive(raw, maxBytes, maxChars));
    }
    const raw = Array.from({ length: 5000 }, (_, i) => ({ path: `file${i}`, kind: { type: 'update' }, diff: 'x'.repeat(1000) }));
    // Count the characters serialized rather than wall time, which varies with
    // machine load. Re-serializing the whole payload after each dropped patch
    // (the quadratic shape this guards against) serializes about 12.5 billion
    // characters here; linear trimming stays within a few payload sizes.
    const payloadChars = JSON.stringify(raw).length;
    const stringify = JSON.stringify;
    let serialized = 0;
    // A plain swap: a test mock would keep every returned string alive.
    // Stop early once the count already proves quadratic work.
    const limit = 10 * payloadChars;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        const out = stringify(...args);
        serialized += typeof out === 'string' ? out.length : 0;
        if (serialized > limit) throw new Error(`trimming serialized more than ${limit} chars`);
        return out;
    }) as typeof JSON.stringify;
    let result: ReturnType<typeof normalizeFileChanges>;
    try { result = normalizeFileChanges(raw, { maxBytes: 10_000, maxChars: 10_000 }); }
    finally { JSON.stringify = stringify; }
    assert.ok(serialized < 10 * payloadChars, `trimming serialized ${serialized} chars for a ${payloadChars}-char payload`);
    assert.ok(result.value.omittedChanges);
});

test('omitted file change retains source count and clears it after replacement fits', () => {
    const f = fixture({ maxTotalChars: 200 });
    f.observer.tool('edit', { semantic: 'file_change' }, {});
    f.observer.text('message', 'fill', 'x'.repeat(95), 'replace', 'unknown');
    const path = 'file.txt', diff = 'x'.repeat(73);
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [{ path, kind: { type: 'update' }, diff }] }, {});
    let item = f.rows('file_change')[0]!;
    assert.equal(item.fileChange, undefined);
    assert.equal(item.truncation?.sourceChars, path.length + diff.length);
    assert.equal(item.truncation?.storedChars, 0);
    f.observer.text('message', 'fill', '', 'replace', 'unknown');
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: [{ path: 'a', kind: { type: 'update' }, diff: 'ok' }] }, {});
    item = f.rows('file_change')[0]!;
    assert.equal(item.fileChange?.changes[0]?.diff, 'ok');
    assert.equal(item.truncation, undefined);
});

test('file change replacement burst coalesces and commits only its latest value', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ coalesceMs: 50 });
    const changes = (diff: string) => [{ path: 'a', kind: { type: 'update' }, diff }];
    f.observer.tool('edit', { semantic: 'file_change', fileChanges: changes('first') }, {});
    for (let i = 0; i < 20; i++) f.observer.tool('edit', { semantic: 'file_change', fileChanges: changes(String(i)) }, {});
    assert.equal(f.writes.length, 1);
    t.mock.timers.tick(50);
    assert.equal(f.writes.length, 2);
    assert.equal(f.rows('file_change')[0]?.fileChange?.changes[0]?.diff, '19');
});

for (const firstCommit of [false, true]) test(`reentrant seal retains ${firstCommit ? 'first-commit' : 'committed append'} after a rejected save`, () => {
    let calls = 0, batch: readonly CodeItem[] = [];
    let normalizer: CodeTurnNormalizer;
    const f = fixture({ commitItem() {
        if (!firstCommit && calls++ === 0) return { publish() {} };
        batch = normalizer.sealAccepted();
        throw new CodeStoreError('transcript_limit', 'limit', 409);
    } });
    normalizer = f.normalizer;
    if (!firstCommit) f.observer.text('message', 'entry', 'A', 'replace', 'final');
    assert.throws(() => f.observer.text('message', 'entry', firstCommit ? 'first' : 'B', 'append', 'final'), /limit/);
    assert.equal(batch.length, 1);
    assert.equal(batch[0]?.text, firstCommit ? 'first' : 'AB');
});
