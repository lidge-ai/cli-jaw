// The schema default and the call-site default have to be the same number, and
// the only way to keep them the same is to have one of them (#696).
//
// multiSession.maxConcurrent was declared 2 in the schema while the lane
// allocator used ?? 1, so changing the schema did nothing: the literal at the
// call site won. memory.flushEvery was declared 10 and then re-declared 10 in
// four other files, which agreed only by luck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, resolveFlushEvery, resolveMaxConcurrent, resolveMemoryRetentionDays } from '../../src/core/config.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Settings keys whose default must come from DEFAULT_SETTINGS, nowhere else. */
const SINGLE_SOURCE_KEYS = ['flushEvery', 'maxConcurrent'] as const;

/** config.ts declares the defaults, so it is the one file allowed to name them. */
const OWNER = 'src/core/config.ts';

function* sourceFiles(dir: string): Generator<string> {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            yield* sourceFiles(full);
        } else if (/\.tsx?$/.test(entry.name)) {
            yield full;
        }
    }
}

test('SDS-001: no source file re-declares a settings default the schema already owns', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(projectRoot, 'src'))) {
        const rel = relative(projectRoot, file).split('\\').join('/');
        if (rel === OWNER) continue;
        const source = readFileSync(file, 'utf8');
        for (const key of SINGLE_SOURCE_KEYS) {
            // settings["memory"]?.flushEvery ?? 10  — the shape that wins over the schema.
            const pattern = new RegExp(key + '\\s*\\?\\?\\s*-?\\d');
            if (pattern.test(source)) offenders.push(rel + ': ' + key);
        }
    }
    assert.deepEqual(offenders, [], [
        'These call sites carry their own copy of a settings default.',
        'Use resolveFlushEvery / resolveMaxConcurrent from src/core/config.ts instead,',
        'so changing DEFAULT_SETTINGS actually changes the runtime value.',
    ].join(' '));
});

test('SDS-002: the resolvers answer with the schema value', () => {
    assert.equal(resolveFlushEvery({}), DEFAULT_SETTINGS.memory.flushEvery);
    assert.equal(resolveMaxConcurrent({}), DEFAULT_SETTINGS.multiSession.maxConcurrent);
    assert.equal(resolveMemoryRetentionDays({}), DEFAULT_SETTINGS.memory.retentionDays);
    // And the schema value is not accidentally the old call-site literal for the
    // key where the two disagreed.
    assert.equal(DEFAULT_SETTINGS.multiSession.maxConcurrent, 20);
});

