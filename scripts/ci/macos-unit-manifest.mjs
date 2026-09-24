#!/usr/bin/env node
// Validates scripts/ci/macos-unit-manifest.txt — the list of unit test files
// the macos-unit job runs on macos-latest. Same line format and validation
// contract as scripts/ci/windows-unit-manifest.mjs, whose readManifest this
// reuses: one repo-relative POSIX path per line, blank lines and full-line
// '#' comments ignored, no globs, duplicates, traversal, or paths outside
// tests/unit/. Consumed by the macOS job (--print), the gates job (plain
// validation), and tests/unit/macos-unit-manifest.test.ts.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readManifest } from './windows-unit-manifest.mjs';

export const MANIFEST_PATH = 'scripts/ci/macos-unit-manifest.txt';
export { readManifest };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const print = process.argv.slice(2).includes('--print');
    try {
        const entries = readManifest(MANIFEST_PATH);
        if (print) process.stdout.write(entries.join('\n') + '\n');
        else console.log(`macos-unit manifest ok: ${entries.length} files`);
    } catch (error) {
        console.error(`[macos-unit-manifest] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
