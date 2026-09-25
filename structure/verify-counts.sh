#!/usr/bin/env bash
# verify-counts.sh — structure/str_func.md file-tree membership check.
#
# str_func.md is a membership map: every file entry ("├── name ← description")
# must resolve to a real tracked path. It no longer records line or file counts;
# those were derived values that conflicted on every stacked merge.
#
# Usage: bash structure/verify-counts.sh [--verbose] [--fix]
#   --verbose  list every tracked file that has no str_func.md entry (advisory)
#   --fix      accepted for backward compatibility; there is nothing to repair
# Exit: 0 when every listed path exists, 1 otherwise. The advisory list never fails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=1 ;;
    --fix) echo "note: --fix is a no-op; str_func.md carries no counts to repair." ;;
    *) echo "usage: bash structure/verify-counts.sh [--verbose] [--fix]" >&2; exit 2 ;;
  esac
done

VERBOSE="$VERBOSE" node <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');

const DOC = 'structure/str_func.md';
if (!fs.existsSync(DOC)) {
  console.log(`❌ missing ${DOC}`);
  process.exit(1);
}

// Rebuild each entry's path from the tree indentation ("│   " per level).
const lines = fs.readFileSync(DOC, 'utf8').split('\n');
const stack = [];
const listed = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^([│ ]*)(?:├──|└──)\s+([^←\s]+)/);
  if (!m) continue;
  const depth = Math.floor(m[1].length / 4);
  const name = m[2];
  if (name.endsWith('/')) {
    stack[depth] = name.slice(0, -1);
    stack.length = depth + 1;
    continue;
  }
  if (!lines[i].includes('←')) continue;
  listed.push({ rel: [...stack.slice(0, depth), name].filter(Boolean).join('/'), line: i + 1 });
}

// Entries under a submodule that is not checked out (promotion clones use
// --no-recurse-submodules) cannot be verified here; report them, never fail on them.
let submodules = [];
try {
  submodules = execFileSync('git', ['config', '-f', '.gitmodules', '--get-regexp', 'path'], { encoding: 'utf8' })
    .split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
} catch { /* no .gitmodules */ }
const uninitialised = submodules.filter((dir) => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
const underUninitialised = (rel) => uninitialised.some((dir) => rel === dir || rel.startsWith(dir + '/'));
const skipped = listed.filter(({ rel }) => underUninitialised(rel));
const missing = listed.filter(({ rel }) => !underUninitialised(rel) && (!fs.existsSync(rel) || !fs.statSync(rel).isFile()));
console.log('📐 str_func.md membership');
for (const { rel, line } of missing) console.log(`  ❌ ${rel} (str_func.md:${line}) — no such file`);
if (missing.length === 0) console.log(`  ✅ ${listed.length - skipped.length} file entries resolve to real files`);
if (skipped.length > 0) console.log(`  ⏭️  ${skipped.length} entries skipped: submodule not checked out (${uninitialised.join(', ')})`);

// Advisory only: tracked source files with no entry. Never fails the check.
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files', '--', 'src', 'bin', 'lib', 'public', 'electron', 'scripts'], { encoding: 'utf8' })
    .split('\n').filter((p) => p && !p.startsWith('public/dist/'));
} catch {
  console.log('  (advisory skipped: git ls-files unavailable)');
}
const listedSet = new Set(listed.map((e) => e.rel));
const unlisted = tracked.filter((p) => !listedSet.has(p));
if (unlisted.length > 0) {
  const show = process.env.VERBOSE === '1' ? unlisted : unlisted.slice(0, 20);
  console.log(`  📎 advisory: ${unlisted.length} tracked file(s) have no entry${process.env.VERBOSE === '1' ? '' : ' (first 20; --verbose for all)'}`);
  for (const p of show) console.log(`     ${p}`);
}
process.exit(missing.length === 0 ? 0 : 1);
NODE
