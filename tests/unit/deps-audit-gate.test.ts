import '../setup/isolated-home.ts';
// #460: the old "Deps security check" compared three hardcoded version rules
// (ws, node-fetch x2) and reported PASS for everything else, so the mermaid
// prototype pollution of #456 cleared CI and sat in dev. These pin the shape of
// the replacement: every advisory needs a recorded decision, and the decision
// has to say something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { advisoryId, classifyAudit } from '../../scripts/deps-audit-classify.ts';

const root = join(import.meta.dirname, '..', '..');
const allowlist = JSON.parse(
    readFileSync(join(root, 'scripts/audit-allowlist.json'), 'utf8'),
) as { allow: Array<{ package: string; severity: string; reason: string; review: string; advisories?: string[] }> };

test('DAG-001: every allowlist entry carries a reachability reason and a review date', () => {
    // An empty list is a valid state: it means every advisory was fixed by an
    // upgrade. The classifier fails any unlisted advisory, so emptiness cannot
    // hide an unexamined finding.
    assert.ok(Array.isArray(allowlist.allow), 'allow must be an array');
    for (const entry of allowlist.allow) {
        assert.ok(entry.package, 'entry needs a package');
        assert.match(entry.review, /^\d{4}-\d{2}-\d{2}$/, `${entry.package}: review must be a date`);
        // A reason short enough to be "low severity" or "dev only" is not a
        // reachability analysis. The entry has to name why the path is absent.
        assert.ok(entry.reason.length >= 60,
            `${entry.package}: reason must explain why the vulnerable path is unreachable here`);
        for (const id of entry.advisories ?? []) {
            assert.match(id, /^(GHSA-[\w-]+|\d+)$/, `${entry.package}: advisory ids are GHSA ids or npm source numbers`);
        }
    }
});

test('DAG-002: package names are unique so one entry cannot silently shadow another', () => {
    const names = allowlist.allow.map(e => e.package);
    assert.deepEqual(names.length, new Set(names).size, 'duplicate package entries');
});

test('DAG-003: CI runs the gate, and package.json exposes it', () => {
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    assert.ok(workflow.includes('npm run check:deps:audit'),
        'the gate must run in CI — a script nobody calls catches nothing');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts['check:deps:audit']?.includes('check-deps-audit'),
        'check:deps:audit must point at the gate script');
});

// DAG-004..: the classifier is the policy. An entry waives named advisories, so a
// new advisory under an allowlisted package (the undici case of 2026-10) fails.
const ghsa = (id: string, title = id) => ({ title, url: `https://github.com/advisories/${id}` });
const entry = (pkg: string, advisories?: string[]) => ({
    package: pkg, severity: 'high', reason: 'x'.repeat(60), review: '2099-01-01',
    ...(advisories ? { advisories } : {}),
});

test('DAG-004: an unlisted package fails', () => {
    const r = classifyAudit({ dompurify: { severity: 'low', via: [ghsa('GHSA-p98j-92pf-mc4p', 'XSS')] } }, [], 'low', '2026-10-02');
    assert.equal(r.unexpected.length, 1);
    assert.match(r.unexpected[0]!, /LOW dompurify — XSS/);
});

test('DAG-005: a listed package passes only for the advisories it names', () => {
    const vulns = { undici: { severity: 'high', via: [ghsa('GHSA-old'), ghsa('GHSA-new', 'TLS bypass')] } };
    const covered = classifyAudit({ undici: { severity: 'high', via: [ghsa('GHSA-old')] } }, [entry('undici', ['GHSA-old'])], 'low', '2026-10-02');
    assert.deepEqual(covered.unexpected, []);
    assert.equal(covered.allowedCount, 1);
    const grown = classifyAudit(vulns, [entry('undici', ['GHSA-old'])], 'low', '2026-10-02');
    assert.equal(grown.allowedCount, 0);
    assert.equal(grown.unexpected.length, 1);
    assert.match(grown.unexpected[0]!, /GHSA-new TLS bypass is not covered/);
});

test('DAG-006: an entry without advisory ids cannot waive a package that has advisories', () => {
    const r = classifyAudit({ undici: { severity: 'high', via: [ghsa('GHSA-a')] } }, [entry('undici')], 'low', '2026-10-02');
    assert.equal(r.allowedCount, 0);
    assert.match(r.unexpected[0]!, /must list the advisory IDs it waives \(GHSA-a\)/);
});

test('DAG-007: a transitive-only finding needs the entry, not advisory ids', () => {
    const vulns = { 'discord.js': { severity: 'moderate', via: ['undici'] } };
    assert.equal(classifyAudit(vulns, [entry('discord.js')], 'low', '2026-10-02').allowedCount, 1);
    const missing = classifyAudit(vulns, [], 'low', '2026-10-02');
    assert.match(missing.unexpected[0]!, /MODERATE discord\.js — via undici/);
});

test('DAG-008: findings below the threshold are ignored and overdue reviews are reported', () => {
    const below = classifyAudit({ esbuild: { severity: 'low', via: [ghsa('GHSA-e')] } }, [], 'moderate', '2026-10-02');
    assert.deepEqual(below.unexpected, []);
    const overdue = classifyAudit(
        { vite: { severity: 'high', via: [ghsa('GHSA-v')] } },
        [{ ...entry('vite', ['GHSA-v']), review: '2026-01-01' }],
        'low', '2026-10-02',
    );
    assert.deepEqual(overdue.stale, ['vite (review was due 2026-01-01)']);
});

test('DAG-009: advisoryId reads the GHSA id from the url and falls back to the npm source', () => {
    assert.equal(advisoryId({ url: 'https://github.com/advisories/GHSA-hrr3-gc8f-f4qj' }), 'GHSA-hrr3-gc8f-f4qj');
    assert.equal(advisoryId({ source: 1234 }), '1234');
});

