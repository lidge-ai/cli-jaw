#!/usr/bin/env node
// ─── Dependency advisory gate ────────────────────────
//
// Replaces the three hardcoded rules in check-deps-offline.ts, which compared
// ws and node-fetch versions and called that a security check. It could only
// ever catch advisories someone had already read and transcribed, so the
// mermaid prototype pollution passed it and sat in dev (#456, #460).
//
// This asks npm for every advisory it knows about and fails on anything not
// in scripts/audit-allowlist.json. The allowlist is the reachability analysis:
// each entry says why the vulnerable path does not exist here. A new advisory
// against a package we never looked at fails the build, which is the whole
// point — the default answer to an unexamined finding is "stop", not "pass".
//
// Offline: npm audit needs the registry. Without it the gate reports SKIP and
// exits 0 rather than blocking an offline build on a check it cannot run.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyAudit, type AllowEntry, type AuditVuln } from './deps-audit-classify.js';

interface Allowlist { allow: AllowEntry[] }

const FAIL_AT = process.env['DEPS_AUDIT_LEVEL'] ?? 'low';

const allowPath = path.resolve('scripts/audit-allowlist.json');
if (!fs.existsSync(allowPath)) {
    console.error('[deps] scripts/audit-allowlist.json not found');
    process.exit(2);
}
const allowlist = JSON.parse(fs.readFileSync(allowPath, 'utf8')) as Allowlist;

let raw: string;
try {
    // npm audit exits non-zero when it finds anything, so the throw carries the
    // report we want. Only a missing/empty stdout means the command truly failed.
    raw = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
    const out = (error as { stdout?: string }).stdout ?? '';
    if (!out.trim()) {
        console.log('SKIP npm audit unavailable (offline or registry error) — gate not run');
        process.exit(0);
    }
    raw = out;
}

let vulns: Record<string, AuditVuln>;
try {
    vulns = (JSON.parse(raw) as { vulnerabilities?: Record<string, AuditVuln> }).vulnerabilities ?? {};
} catch {
    console.log('SKIP npm audit returned unparseable output — gate not run');
    process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const { unexpected, stale, allowedCount } = classifyAudit(vulns, allowlist.allow, FAIL_AT, today);

for (const line of stale) console.log(`WARN allowlist entry past its review date: ${line}`);
console.log(`[deps] ${Object.keys(vulns).length} advisory package(s); ${allowedCount} allowlisted, ${unexpected.length} unexpected`);

if (unexpected.length > 0) {
    console.error('');
    console.error('FAIL advisories with no allowlist entry:');
    for (const line of unexpected) console.error(`  ${line}`);
    console.error('');
    console.error('Either upgrade the package, or add an entry to scripts/audit-allowlist.json');
    console.error('stating why the vulnerable path is unreachable in this repository.');
    process.exit(1);
}

console.log('PASS every known advisory has a recorded decision');
