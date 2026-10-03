import assert from 'node:assert/strict';
import { test } from 'node:test';

test('system trash forwards literal paths with globbing disabled', async t => {
    const calls: Array<{ paths: string[]; options: unknown }> = [];
    t.mock.module('trash', {
        defaultExport: async (paths: string[], options: unknown) => { calls.push({ paths, options }); },
    });
    const previous = process.env['CLI_JAW_TEST_SYSTEM_TRASH_DIR'];
    delete process.env['CLI_JAW_TEST_SYSTEM_TRASH_DIR'];
    t.after(() => {
        if (previous === undefined) delete process.env['CLI_JAW_TEST_SYSTEM_TRASH_DIR'];
        else process.env['CLI_JAW_TEST_SYSTEM_TRASH_DIR'] = previous;
    });
    const { moveToSystemTrash } = await import('../../src/manager/notes/system-trash.js');
    const paths = [`/synthetic/${'{'.repeat(64)}literal.md`, '/synthetic/[literal].md'];
    await moveToSystemTrash(paths);
    assert.deepEqual(calls, [{ paths, options: { glob: false } }]);
});
