import test from 'node:test';
import assert from 'node:assert/strict';
import {
    firstInputLine, firstToolField, parseToolArguments, parseToolInput, prettyToolInput,
} from '../../src/shared/tool-input.ts';

test('JSON tool input decodes the recognised argument and description', () => {
    const command = 'ssh host \'cat > f <<EOF\nline one\nEOF\'';
    const parsed = parseToolInput(JSON.stringify({ command, description: 'Install hook on host' }));
    assert.equal(parsed.field, 'command');
    assert.equal(parsed.value, command);
    assert.equal(parsed.description, 'Install hook on host');
});

test('path, query and url families resolve in priority order', () => {
    assert.equal(parseToolInput('{"file_path":"/a/b.ts"}').value, '/a/b.ts');
    assert.equal(parseToolInput('{"path":"/a/b.ts"}').field, 'path');
    assert.equal(parseToolInput('{"pattern":"foo.*bar"}').value, 'foo.*bar');
    assert.equal(parseToolInput('{"query":"foo"}').field, 'query');
    assert.equal(parseToolInput('{"url":"https://x.dev"}').field, 'url');
    const both = parseToolInput('{"url":"https://x.dev","cmd":"ls -la"}');
    assert.equal(both.field, 'command');
    assert.equal(both.value, 'ls -la');
});

test('non-JSON and unrecognised JSON stay out of the decoded value', () => {
    assert.equal(parseToolInput('ls -la').value, null);
    assert.equal(parseToolInput('ls -la').object, null);
    assert.equal(parseToolInput('{"other":1,"n":2}').value, null);
    assert.ok(parseToolInput('{"other":1}').object);
    assert.equal(parseToolInput('{not json').object, null);
    assert.equal(parseToolInput('[1,2]').object, null);
    assert.equal(parseToolInput(undefined).object, null);
});

test('firstToolField honours key order and skips empty strings', () => {
    const object = { a: '  ', b: 'bee', c: 'see' };
    assert.equal(firstToolField(object, ['a', 'b']), 'bee');
    assert.equal(firstToolField(object, ['x', 'c']), 'see');
    assert.equal(firstToolField({ n: 4 }, ['n']), null);
});

test('firstInputLine collapses the first non-empty line only', () => {
    assert.equal(firstInputLine('\n\n  ssh   host\t cat  \nsecond line'), 'ssh host cat');
    assert.equal(firstInputLine('   '), '');
});

test('prettyToolInput reprints JSON at two-space indent and leaves raw text alone', () => {
    assert.equal(prettyToolInput('{"command":"ls","n":1}'), '{\n  "command": "ls",\n  "n": 1\n}');
    assert.equal(prettyToolInput('echo hi'), 'echo hi');
});
