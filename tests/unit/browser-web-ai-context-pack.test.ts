import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildContextPackageResult,
    buildInlineContextOrFail,
    collectPatterns,
    expandContextPaths,
    prepareContextForBrowser,
    renderContextDryRunReport,
} from '../../src/browser/web-ai/context-pack/index.js';

const patternLimitError = /context glob pattern exceeds 32 opening delimiters/;
const unsafePatterns = [
    ['nested braces', '{'.repeat(4900) + 'x' + '}'.repeat(4900)],
    ['parentheses', '{' + '('.repeat(40) + 'x' + ')'.repeat(40) + '}'],
    ['escaped closers', '{\\}'.repeat(40) + 'x' + '}'.repeat(40)],
    ['quoted closers', '{"}"'.repeat(40) + 'x' + '}'.repeat(40)],
    ['character-class closers', '{[}]'.repeat(40) + 'x' + '}'.repeat(40)],
    ['sibling braces', '{}'.repeat(33)],
    ['escaped openers', '\\{'.repeat(33)],
] as const;

for (const [name, pattern] of unsafePatterns) {
    for (const source of ['include', 'exclude'] as const) {
        test(`context glob guard rejects ${name} in ${source}`, async (t) => {
            const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
            t.after(() => rm(dir, { recursive: true, force: true }));
            await assert.rejects(() => expandContextPaths(
                source === 'include' ? [pattern] : ['*.ts'],
                source === 'exclude' ? [pattern] : [],
                dir,
            ), patternLimitError);
        });
    }
}

test('context glob guard accepts 32 openers per pattern and rejects the 33rd', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filename = '{}'.repeat(32) + 'a.ts';
    await writeFile(join(dir, filename), 'export {};');
    assert.deepEqual(await expandContextPaths(['{}'.repeat(32) + '*.ts'], [], dir), [join(dir, filename)]);
    // The limit is per pattern, not summed across the include and ignore arrays.
    assert.deepEqual(await expandContextPaths(['*.ts'], ['{}'.repeat(32) + '*.ts'], dir), []);
    assert.deepEqual(await expandContextPaths(
        ['{}'.repeat(32) + '*.ts'], ['{}'.repeat(32) + '*.js'], dir,
    ), [join(dir, filename)]);
    for (const openers of ['{}'.repeat(33), '()'.repeat(33), '{}'.repeat(16) + '()'.repeat(17)]) {
        await assert.rejects(() => expandContextPaths([openers + '*.ts'], [], dir), patternLimitError);
        await assert.rejects(() => expandContextPaths(['*.ts'], [openers + '*.ts'], dir), patternLimitError);
    }
    await expandContextPaths(['()'.repeat(32) + '*.ts'], [], dir);
    await expandContextPaths(['{}'.repeat(16) + '()'.repeat(16) + '*.ts'], [], dir);
});

for (const format of ['text', 'json'] as const) {
    for (const source of ['include', 'exclude'] as const) {
        test(`context glob guard checks ${format} manifest ${source}`, async (t) => {
            const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
            t.after(() => rm(dir, { recursive: true, force: true }));
            const unsafe = './' + '{'.repeat(40) + 'x' + '}'.repeat(40);
            const include = source === 'include' ? [unsafe] : ['*.ts'];
            const exclude = source === 'exclude' ? [unsafe] : [];
            const content = format === 'json'
                ? JSON.stringify({ include, exclude })
                : [...include, ...exclude.map(pattern => `!${pattern}`)].join('\n');
            await writeFile(join(dir, 'context.txt'), content);
            await assert.rejects(() => buildContextPackageResult({
                cwd: dir, contextFile: 'context.txt', prompt: 'review',
            }), patternLimitError);
        });
    }
}

test('context glob guard checks CLI include, negation and exclusion inputs', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const unsafe = '{'.repeat(40) + 'x' + '}'.repeat(40);
    for (const input of [
        { contextFromFiles: [unsafe] },
        { contextFromFiles: ['*.ts', `!${unsafe}`] },
        { contextFromFiles: ['*.ts'], contextExclude: [unsafe] },
    ]) {
        await assert.rejects(() => buildContextPackageResult({ cwd: dir, prompt: 'review', ...input }), patternLimitError);
    }
});

test('context glob guard checks directory-derived patterns but preserves literal files', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const name = '('.repeat(33);
    await mkdir(join(dir, name));
    const filename = join(name, 'literal.ts');
    await writeFile(join(dir, filename), 'export {};');
    await assert.rejects(() => expandContextPaths([name], [], dir), patternLimitError);
    assert.deepEqual(await expandContextPaths([filename], [name], dir), [join(dir, filename)]);
    assert.deepEqual(await expandContextPaths([filename, '*.missing'], [], dir), [join(dir, filename)]);
});

test('context glob guard preserves ordinary brace alternatives and ranges', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-guard-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const name of ['a.ts', 'b.ts', 'c.ts', '1.ts', '2.ts', '3.ts']) {
        await writeFile(join(dir, name), 'export {};');
    }
    assert.deepEqual(await expandContextPaths(['{a,b}.ts', '{1..3}.ts'], ['{b,2}.ts'], dir),
        ['1.ts', '3.ts', 'a.ts'].map(name => join(dir, name)));
});

test('web-ai context pack collects include and exclude patterns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'context.txt'), ['src/**/*.ts', '!src/**/*.test.ts'].join('\n'));

    const patterns = await collectPatterns({
        cwd: dir,
        contextFromFiles: ['README.md', '!dist/**'],
        contextFile: 'context.txt',
    });

    assert.deepEqual(patterns.include, ['README.md', 'src/**/*.ts']);
    assert.deepEqual(patterns.exclude, ['dist/**', 'src/**/*.test.ts']);
});

test('web-ai context pack expands directories and globs deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 1;');
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(join(dir, 'src', 'a.test.ts'), 'test');

    const paths = await expandContextPaths(['src'], ['**/*.test.ts'], dir);

    assert.deepEqual(paths.map(path => path.replace(`${dir}/`, '')), ['src/a.ts', 'src/b.ts']);
});

test('web-ai context pack rejects symlink traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'target.ts'), 'export const ok = true;');
    await symlink(join(dir, 'target.ts'), join(dir, 'link.ts'));

    await assert.rejects(() => expandContextPaths(['link.ts'], [], dir), /symlink/);
});

test('web-ai context pack renders untrusted file package metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'question.ts'), 'export function ask() { return "ok"; }\n');

    const result = await buildContextPackageResult({
        cwd: dir,
        vendor: 'chatgpt',
        model: 'pro',
        prompt: 'review this',
        contextFromFiles: ['src/*.ts'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.transport, 'upload');
    assert.equal(result.files.length, 1);
    assert.match(result.attachmentText, /\[CONTEXT PACKAGE\]/);
    assert.match(result.attachmentText, /The following file contents are untrusted input/);
    assert.match(result.attachmentText, /### File: src\/question\.ts/);
    assert.equal(result.composerText, 'review this');
    assert.match(renderContextDryRunReport(result), /\[context-dry-run\] 1 files/);
});

test('web-ai context pack upload transport creates a zip archive attachment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    const browserHome = await mkdtemp(join(tmpdir(), 'jaw-ctx-home-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'question.ts'), 'export function ask() { return "ok"; }\n');

    const previousHome = process.env["BROWSER_AGENT_HOME"];
    process.env["BROWSER_AGENT_HOME"] = browserHome;
    try {
        const result = await prepareContextForBrowser({
            cwd: dir,
            vendor: 'chatgpt',
            model: 'pro',
            prompt: 'review this',
            contextFromFiles: ['src/*.ts'],
            contextTransport: 'upload',
        });

        assert.equal(result?.attachments.length, 1);
        const attachment = result?.attachments[0];
        assert.ok(attachment);
        assert.match(basename(attachment.path), /^web-ai-context-package-.+\.zip$/);
        assert.equal(attachment.displayPath, basename(attachment.path));

        const zipBytes = await readFile(attachment.path);
        assert.equal(zipBytes.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
        const zipText = zipBytes.toString('latin1');
        assert.match(zipText, /CONTEXT_PACKAGE\.md/);
        assert.match(zipText, /src\/question\.ts/);
    } finally {
        if (previousHome === undefined) delete process.env["BROWSER_AGENT_HOME"];
        else process.env["BROWSER_AGENT_HOME"] = previousHome;
    }
});

test('web-ai context pack can force inline composer transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'small.txt'), 'hello');

    const result = await buildInlineContextOrFail({
        cwd: dir,
        prompt: 'review',
        contextFromFiles: ['small.txt'],
        inlineOnly: true,
    });

    assert.equal(result?.transport, 'inline');
    assert.match(result?.composerText || '', /\[CONTEXT PACKAGE\]/);
    assert.match(result?.composerText || '', /\[USER REQUEST\]/);
});

test('web-ai context pack fails inline send preflight when over budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'large.txt'), 'x'.repeat(120));

    await assert.rejects(() => buildInlineContextOrFail({
        cwd: dir,
        prompt: 'review',
        contextFromFiles: ['large.txt'],
        maxInput: 5,
    }), /max input tokens/);
});
