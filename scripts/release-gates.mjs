#!/usr/bin/env node
/**
 * Phase 22 named release gates for cli-jaw.
 *
 * Each gate has a NAME, a CHECK function, and prints PASS / FAIL.
 * Usage:
 *   node scripts/release-gates.mjs              # run all gates
 *   node scripts/release-gates.mjs <gate-name>  # run one gate
 *
 * Wired through package.json as `gate:<name>`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditClaims, formatClaimAuditReport } from './claim-audit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Windows-safe command resolution for spawnSync.
 * Bare 'npm'/'npx' resolve to .cmd shims on Windows, which Node refuses to
 * spawn without shell:true (EINVAL since the CVE-2024-27980 hardening), so
 * every gate that shelled out reported status=null with empty output on a
 * native-Windows checkout. Run the CLI js entrypoints under the current node
 * binary instead; POSIX resolution is unchanged.
 */
function resolveCliJs(name) {
    const nodeBinDir = path.dirname(process.execPath);
    const candidates = [
        name === 'npm' ? process.env.npm_execpath : null,
        path.join(nodeBinDir, 'node_modules', 'npm', 'bin', `${name}-cli.js`),
        path.join(nodeBinDir, 'lib', 'node_modules', 'npm', 'bin', `${name}-cli.js`),
        path.join(path.dirname(nodeBinDir), 'lib', 'node_modules', 'npm', 'bin', `${name}-cli.js`),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function windowsSafeCommand(cmd, args) {
    if (cmd === 'npm' || cmd === 'npx') {
        const cliJs = resolveCliJs(cmd);
        if (cliJs) return [process.execPath, [cliJs, ...args]];
        if (process.platform === 'win32') return [`${cmd}.cmd`, args, { shell: true }];
        return [cmd, args];
    }
    return [cmd, args];
}

function run(cmd, args, opts = {}) {
    const [bin, finalArgs, extra] = windowsSafeCommand(cmd, args);
    return spawnSync(bin, finalArgs, {
        cwd: repoRoot,
        stdio: opts.stdio || 'pipe',
        encoding: 'utf8',
        ...(extra || {}),
        ...opts,
    });
}

// tsx's dist/cli.mjs run under node works identically on every platform;
// node_modules/.bin/tsx is a bash script that Windows cannot execute.
const tsxCli = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function readFile(rel) {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/**
 * Lines only a git merge conflict produces. A bare `=======` is deliberately
 * absent: it is also a Markdown setext H1 underline, so matching it would fail
 * this gate on ordinary prose. Every real conflict carries the anchored
 * `<<<<<<<`/`>>>>>>>` pair, so the pair is enough to see one.
 */
const CONFLICT_MARKER_RE = '^(<<<<<<< |\\|\\|\\|\\|\\|\\|\\| |>>>>>>> )';

/**
 * tests/fixtures/manager-notes-wysiwyg holds canned conflict text on purpose —
 * it is the INPUT to the notes conflict-rendering tests, not a merge leftover.
 */
const CONFLICT_SCAN_EXCLUDE = ':(exclude)tests/fixtures/manager-notes-wysiwyg/';

/**
 * Tracked files still carrying merge markers. `git grep` reads only tracked
 * paths, so an untracked scratch file cannot fail the build, and `-I` skips
 * binaries. A status other than 0 (found) or 1 (clean) means the scan did not
 * actually run, which is reported rather than silently passed.
 */
function grepConflictMarkers(cwd, prefix) {
    const r = run('git', ['grep', '-n', '-I', '-E', CONFLICT_MARKER_RE, '--', '.', CONFLICT_SCAN_EXCLUDE],
        { timeout: 60_000, cwd });
    if (r.status === 1) return { hits: [] };
    if (r.status !== 0) {
        const why = [r.stderr, r.stdout].filter(Boolean).join(' ').trim() || `status ${r.status}`;
        return { error: `conflict-marker scan could not run in ${prefix || '.'}: ${why}` };
    }
    const hits = String(r.stdout || '').split('\n').filter(Boolean)
        .map(line => (prefix ? `${prefix}/${line}` : line));
    return { hits };
}

/**
 * `git grep` stops at a gitlink, and a marker committed inside a submodule
 * ships when that submodule is published — the same reason
 * check-private-boundary.mjs enumerates submodule contents instead of trusting
 * `ls-files`. So each CHECKED-OUT submodule is scanned in its own right. An
 * uninitialised one holds no working tree to read; it is named in the detail
 * rather than counted as clean, because "nothing to scan" is not "scanned and
 * clean".
 */
function trackedConflictMarkers() {
    const root = grepConflictMarkers(repoRoot, '');
    if (root.error) return root;
    const hits = [...root.hits];
    const unscanned = [];
    const listed = run('git', ['submodule', 'status'], { timeout: 30_000 });
    if (listed.status === 0) {
        for (const line of String(listed.stdout || '').split('\n').filter(Boolean)) {
            // ' <sha> <path> (<describe>)', where a leading '-' means the
            // submodule was never initialised in this checkout.
            const parsed = line.match(/^(.)[0-9a-f]+\s+(\S+)/);
            if (!parsed) continue;
            const [, state, rel] = parsed;
            if (state === '-') { unscanned.push(rel); continue; }
            const nested = grepConflictMarkers(path.join(repoRoot, rel), rel);
            if (nested.error) return nested;
            hits.push(...nested.hits);
        }
    }
    return { hits, unscanned };
}

const FORBIDDEN_IN_READY = [
    /external[-\s]?cdp/i,
    /remote[-\s]?cdp/i,
    /hosted browser/i,
    /browser_type_ref/,
    /browser_navigate/,
    /browser_screenshot/,
    /browser_back/,
    /browser_forward/,
    /browser_reload/,
    /browser_wait_for/,
    /browser_extract_text/,
];

const GATES = {
    'dev-ff-main': {
        description: 'dev branch is fast-forwardable on origin/main',
        check() {
            // actions/checkout leaves HEAD detached, so on Actions read the ref the
            // run was triggered for (push and workflow_dispatch both use
            // refs/heads/<branch>; pull_request uses refs/pull/* and is skipped).
            const ghRef = process.env.GITHUB_REF || '';
            const branch = ghRef.startsWith('refs/heads/')
                ? ghRef.slice('refs/heads/'.length)
                : run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
            if (branch !== 'dev') {
                return { ok: true, detail: `not on dev (branch=${branch}); skipped` };
            }
            // Always refresh: a stale local origin/main would pass vacuously.
            const fetched = run('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: 60_000 });
            if (fetched.status !== 0) {
                return { ok: false, detail: `could not fetch origin/main: ${(fetched.stderr || '').trim()}` };
            }
            const ff = run('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
            if (ff.status !== 0) {
                return { ok: false, detail: 'dev is not fast-forwardable on main: merge/rebase origin/main (AGENTS.md Remote/브랜치 정책)' };
            }
            return { ok: true, detail: 'dev is fast-forwardable on origin/main' };
        },
    },
    'agents-size': {
        description: 'AGENTS.md line-count ratchet',
        check() {
            const AGENTS_MD_MAX_LINES = 480; // rounded-up new line count; lowering is the ratchet
            const text = readFile('AGENTS.md');
            // Same count as `wc -l`: newline characters.
            const lines = (text.match(/\n/g) || []).length;
            if (lines > AGENTS_MD_MAX_LINES) {
                return { ok: false, detail: `AGENTS.md is ${lines} lines (max ${AGENTS_MD_MAX_LINES}); shrink or document the raise` };
            }
            return { ok: true, detail: `AGENTS.md: ${lines}/${AGENTS_MD_MAX_LINES} lines` };
        },
    },
    'typecheck': {
        description: 'tsc --noEmit (server + frontend) clean',
        check() {
            const tasks = ['typecheck', 'typecheck:frontend'];
            for (const t of tasks) {
                const r = run('npm', ['run', t, '--silent']);
                if (r.status !== 0) {
                    return { ok: false, detail: `${t} failed:\n${(r.stderr || r.stdout || '').slice(-2000)}` };
                }
            }
            return { ok: true, detail: `tsc clean for: ${tasks.join(', ')}` };
        },
    },
    'tests': {
        description: 'browser web-ai unit tests pass (mirror parity)',
        check() {
            const targets = [
                'tests/unit/browser-web-ai-target-resolver.test.ts',
                'tests/unit/browser-web-ai-answer-artifact.test.ts',
                'tests/unit/browser-web-ai-source-audit.test.ts',
                'tests/unit/browser-web-ai-cli-contract.test.ts',
                'tests/integration/promotion-checkout.test.ts',
                'tests/unit/release-gates.test.ts',
                'tests/unit/release-scripts-contract.test.ts',
                // Guards the release/build scripts themselves, so it belongs in
                // the suite gate:all actually runs rather than npm test only.
                'tests/unit/electron-version-sync.test.ts',
                'tests/unit/gyp-python-pick.test.ts',
            ].filter((p) => fs.existsSync(path.join(repoRoot, p)));
            if (targets.length === 0) {
                return { ok: false, detail: 'no Phase 22 mirror tests found' };
            }
            const args = [
                'tsx', '--import', './tests/setup/test-home.ts',
                '--experimental-test-module-mocks', '--test',
                ...targets,
            ];
            const r = run('npx', args);
            if (r.status !== 0) {
                return { ok: false, detail: `tests failed:\n${[r.stdout, r.stderr].filter(Boolean).join('\n').slice(-2000)}` };
            }
            return { ok: true, detail: `passed ${targets.length} suite(s): ${targets.join(', ')}` };
        },
    },
    'truth-table-fresh': {
        description: 'CAPABILITY_TRUTH_TABLE.md edited within 7 days OR matches code refs, AND its generated messaging channel matrix matches src/messaging/channel-capabilities.ts',
        check() {
            const rel = 'structure/CAPABILITY_TRUTH_TABLE.md';
            const abs = path.join(repoRoot, rel);
            if (!fs.existsSync(abs)) return { ok: false, detail: `${rel} missing` };
            // The generated messaging block first: a stale matrix is a wrong claim
            // regardless of the file's mtime, so freshness must not excuse it.
            // node_modules/.bin/tsx directly — npx resolution is not a gate dependency.
            const generated = run(process.execPath, [tsxCli, 
                'scripts/generate-channel-capability-table.mts', '--check',
            ], { timeout: 60_000 });
            if (generated.status !== 0) {
                const detail = [generated.stderr, generated.stdout].filter(Boolean).join('\n').trim();
                return { ok: false, detail: `messaging capability matrix drift:\n${detail || `tsx exited with ${generated.status}`}` };
            }
            const stat = fs.statSync(abs);
            const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays <= 7) return { ok: true, detail: `truth table ${ageDays.toFixed(2)}d old; messaging matrix in sync` };
            const text = readFile(rel);
            const required = ['action-intent', 'target-resolver', 'answer-artifact', 'source-audit'];
            for (const term of required) {
                if (!text.includes(term)) {
                    return { ok: false, detail: `truth table stale (${ageDays.toFixed(1)}d) and missing ${term}` };
                }
            }
            return { ok: true, detail: `truth table ${ageDays.toFixed(1)}d old but matches required terms; messaging matrix in sync` };
        },
    },
    'mcp-scope-frozen': {
        description: 'cli-jaw exposes no browser MCP tool surface (agbrowse owns 2 frozen tools)',
        check() {
            // cli-jaw must NOT register browser_* MCP tools — agbrowse is the
            // sole source. Scan src/ for any new declarative MCP tool entries
            // named browser_*.
            const offenders = [];
            const srcDir = path.join(repoRoot, 'src');
            const stack = [srcDir];
            while (stack.length) {
                const dir = stack.pop();
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(full);
                        continue;
                    }
                    if (!/\.(ts|mts|mjs|js|cjs)$/.test(entry.name)) continue;
                    const text = fs.readFileSync(full, 'utf8');
                    // any hint of a registered MCP browser_* tool definition
                    if (/['"]browser_(snapshot|click_ref|type_ref|navigate|back|forward|reload|wait_for|screenshot|extract_text)['"]\s*:\s*{/.test(text)) {
                        offenders.push(path.relative(repoRoot, full));
                    }
                }
            }
            if (offenders.length > 0) {
                return { ok: false, detail: `cli-jaw must not register browser MCP tools; offenders:\n${offenders.join('\n')}` };
            }
            return { ok: true, detail: 'cli-jaw registers no browser MCP tools (agbrowse owns the frozen scope)' };
        },
    },
    'no-experimental-in-readme-ready-section': {
        description: 'README "ready" claims do not include external CDP or unimplemented MCP tools',
        check() {
            const files = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md', 'structure/CAPABILITY_TRUTH_TABLE.md']
                .filter((p) => fs.existsSync(path.join(repoRoot, p)));
            const offending = [];
            for (const rel of files) {
                const text = readFile(rel);
                const sections = text.split(/\n##\s+/);
                for (const sec of sections) {
                    const head = sec.split('\n', 1)[0].toLowerCase();
                    const isReady = head.includes('ready') || head.includes('production') || head.includes('supported') || head.includes('feature');
                    const isExperimentalSection = head.includes('experimental') || head.includes('deferred') || head.includes('out of scope') || head.includes('forbidden') || head.includes('mirror rules');
                    if (!isReady || isExperimentalSection) continue;
                    for (const pat of FORBIDDEN_IN_READY) {
                        if (pat.test(sec)) {
                            offending.push(`${rel} :: ${head} :: ${pat}`);
                        }
                    }
                }
            }
            if (offending.length > 0) {
                return { ok: false, detail: `forbidden terms in ready sections:\n${offending.join('\n')}` };
            }
            return { ok: true, detail: `${files.length} README/truth-table file(s) clean of experimental terms in ready sections` };
        },
    },
    'no-cloud-claims': {
        description: 'no hosted/cloud/stealth/external-CDP/leaderboard claims outside experimental sections (G10 mirror)',
        check() {
            const report = auditClaims({ repoRoot });
            return { ok: report.ok, detail: formatClaimAuditReport(report) };
        },
    },
    'observe-actions-fixtures': {
        description: 'observe-actions module loads and produces ranked candidates from a fixture snapshot (G02 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = tsxCli;
                const fixtureScript = `import { buildObserveActions, formatObserveActions } from '${path.resolve(repoRoot, 'src/browser/web-ai/observe-actions.ts').split(path.sep).join('/')}';\nconst r = buildObserveActions({ snapshotId: 'gate-fixture', url: null, refs: { '@e1': { role: 'button', name: 'Sign in' }, '@e2': { role: 'textbox', name: 'Email' }, '@e3': { role: 'link', name: 'Forgot password?' } } }, 'click sign in');\nif (!r || !Array.isArray(r.candidates) || r.candidates.length < 3) { console.error('candidates<3'); process.exit(2); }\nif (r.candidates[0].ref !== '@e1' || r.candidates[0].action !== 'click') { console.error('rank-fail'); process.exit(3); }\nif (!r.candidates.every(c => c.args.snapshotId === 'gate-fixture')) { console.error('snapId-missing'); process.exit(4); }\nconst t = formatObserveActions(r); if (!t || typeof t !== 'string') { console.error('format-fail'); process.exit(5); }\nconsole.log('OK ' + r.candidates.length);`;
                const res = spawnSync(process.execPath, [tsxBin, '--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `observe-actions fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `observe-actions fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `observe-actions fixture threw: ${(err && err.message) || err}` };
            }
        },
    },
    'observation-bundle-fixtures': {
        description: 'observation-bundle module emits ObservationBundleV1 from a fixture (G06 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = tsxCli;
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/observation-bundle.ts').split(path.sep).join('/');
                const fixtureScript = `import { buildObservationBundle, OBSERVATION_BUNDLE_SCHEMA_VERSION } from '${modPath}';\nconst b = buildObservationBundle({ url: 'https://x.test/', viewport: { width: 800, height: 600 }, snapshotNodes: [{ ref: '@e1', role: 'button', name: 'Go' }, { ref: '...', role: 'note', name: 't' }], boxes: { '@e1': { x: 1, y: 2, width: 10, height: 20 } }, textSummary: 'hello' });\nif (b.schemaVersion !== OBSERVATION_BUNDLE_SCHEMA_VERSION) { console.error('schema-mismatch'); process.exit(2); }\nif (b.refs.length !== 1) { console.error('ref-filter-fail'); process.exit(3); }\nif (!b.refs[0].box || b.refs[0].box.width !== 10) { console.error('box-attach-fail'); process.exit(4); }\nif (b.stats.refCount !== 1 || b.stats.boxCount !== 1 || b.stats.textChars !== 5) { console.error('stats-fail'); process.exit(5); }\nconsole.log('OK refs=' + b.stats.refCount + ' boxes=' + b.stats.boxCount + ' text=' + b.stats.textChars + 'ch');`;
                const res = spawnSync(process.execPath, [tsxBin, '--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `observation-bundle fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `observation-bundle fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `observation-bundle fixture threw: ${(err && err.message) || err}` };
            }
        },
    },
    'browser-primitives-catalog': {
        description: 'action-breadth catalog exposes the agreed primitive set (G03 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = tsxCli;
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/action-breadth.ts').split(path.sep).join('/');
                const fixtureScript = `import { BROWSER_PRIMITIVES, listPrimitiveCommands, BROWSER_PRIMITIVE_SCHEMA_VERSION, auditPrimitiveCoverage } from '${modPath}';\nif (BROWSER_PRIMITIVE_SCHEMA_VERSION !== 'browser-primitives-v1') { console.error('schema-mismatch'); process.exit(2); }\nif (BROWSER_PRIMITIVES.length < 18) { console.error('too-few'); process.exit(3); }\nconst cmds = new Set(listPrimitiveCommands());\nfor (const c of ['select','check','uncheck','upload','drag','scroll','wait-for']) { if (!cmds.has(c)) { console.error('missing:'+c); process.exit(4); } }\nconst fake = [...BROWSER_PRIMITIVES].map(p => 'case ' + JSON.stringify(p.command) + ':').join('\\n');\nconst r = auditPrimitiveCoverage(fake);\nif (!r.ok || r.missing.length !== 0) { console.error('audit-fail'); process.exit(5); }\nconsole.log('OK ' + BROWSER_PRIMITIVES.length + ' primitives');`;
                const res = spawnSync(process.execPath, [tsxBin, '--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `action-breadth fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `action-breadth fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `action-breadth gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'action-memory-safe-replay': {
        description: 'action-memory cache returns hit only when DOM signature matches (G07 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = tsxCli;
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/action-memory.ts').split(path.sep).join('/');
                const fixtureScript = `import { createActionMemory, validateMemoryHit, ACTION_MEMORY_SCHEMA_VERSION } from '${modPath}';\nif (ACTION_MEMORY_SCHEMA_VERSION !== 'action-memory-v1') { console.error('schema-mismatch'); process.exit(2); }\nconst m = createActionMemory();\nm.put({ origin: 'https://x.test', intentId: 'i', signature: 'sig-A', ref: '@e1', hits: 0, validations: { ok: 0, fail: 0 }, lastGoodAt: '' });\nconst hit = m.get('https://x.test', 'i', 'sig-A');\nif (!hit || hit.ref !== '@e1') { console.error('miss-on-match'); process.exit(3); }\nif (m.get('https://x.test', 'i', 'sig-B') !== null) { console.error('hit-on-drift'); process.exit(4); }\nif (validateMemoryHit(hit, 'sig-B') !== null) { console.error('validate-allowed-drift'); process.exit(5); }\nm.clear();\nif (m.size() !== 0) { console.error('clear-failed'); process.exit(6); }\nconsole.log('OK hit-on-match miss-on-drift clear');`;
                const res = spawnSync(process.execPath, [tsxBin, '--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `action-memory fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `action-memory: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `action-memory gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'model-adapter-frozen': {
        description: 'G09 mirror: cli-jaw must not implement an API model adapter or claim parity (negative-parity)',
        async check() {
            try {
                // Truth-table must declare the deferred (frozen) row.
                const truth = readFile('structure/CAPABILITY_TRUTH_TABLE.md');
                const g09Line = truth.match(/^[^\n]*G09[^\n]+model[- ]adapter[^\n]+/im)?.[0] || '';
                if (!g09Line) {
                    return { ok: false, detail: 'CAPABILITY_TRUTH_TABLE.md missing G09 model-adapter row' };
                }
                if (!/(deferred|frozen)/i.test(g09Line)) {
                    return { ok: false, detail: `G09 row must be marked deferred/frozen, got: ${g09Line.slice(0, 200)}` };
                }

                // package.json must NOT depend on provider SDKs.
                const pkg = JSON.parse(readFile('package.json'));
                const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
                const sdkDenylist = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', 'ai'];
                for (const name of Object.keys(allDeps)) {
                    if (sdkDenylist.includes(name) || name.startsWith('@ai-sdk/')) {
                        return { ok: false, detail: `forbidden provider SDK dep: ${name}` };
                    }
                }

                // Source scan limited to browser/web-ai surface (cli-jaw's
                // broader memory/quota system has unrelated OpenAI integration
                // that pre-dates and is independent of the agbrowse G09 freeze).
                const scanRoots = ['src/browser'];
                /** @type {Array<{file:string, hit:string}>} */
                const violations = [];
                const cmdAliasRe = /\b(api-query|model-query|--api\b|--transport\s+api|--mode\s+api)\b/;
                const envRe = /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|MODEL_ADAPTER_[A-Z_]+|AI_SDK_[A-Z_]+)\b/;
                const importRe = /from\s+['"](openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|@ai-sdk\/[^'"]+|ai)['"]/;
                const dirDenylist = ['src/browser/web-ai/model-adapter', 'src/model-adapter', 'src/api-client'];
                for (const dirRel of dirDenylist) {
                    if (fs.existsSync(path.join(repoRoot, dirRel))) {
                        return { ok: false, detail: `forbidden path exists: ${dirRel}/` };
                    }
                }
                /** @param {string} dirAbs */
                function walk(dirAbs) {
                    if (!fs.existsSync(dirAbs)) return;
                    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                        const abs = path.join(dirAbs, entry.name);
                        if (entry.isDirectory()) { walk(abs); continue; }
                        if (!/\.(mjs|cjs|js|ts|tsx|json|md)$/.test(entry.name)) continue;
                        const rel = path.relative(repoRoot, abs);
                        if (rel.endsWith('release-gates.mjs')) continue;
                        if (rel.endsWith('CAPABILITY_TRUTH_TABLE.md')) continue;
                        const text = fs.readFileSync(abs, 'utf8');
                        if (cmdAliasRe.test(text)) violations.push({ file: rel, hit: 'forbidden api-query/--api/--transport api alias' });
                        if (envRe.test(text)) violations.push({ file: rel, hit: 'forbidden API key/MODEL_ADAPTER_/AI_SDK_ env var' });
                        if (importRe.test(text)) violations.push({ file: rel, hit: 'forbidden provider SDK import' });
                    }
                }
                for (const root of scanRoots) walk(path.join(repoRoot, root));
                if (violations.length) {
                    const sample = violations.slice(0, 5).map(v => `${v.file}: ${v.hit}`).join('; ');
                    return { ok: false, detail: `${violations.length} negative-parity violation(s): ${sample}` };
                }

                return { ok: true, detail: 'cli-jaw mirror clean: deferred row present, no SDK deps, no api-* drift' };
            } catch (err) {
                return { ok: false, detail: `model-adapter-frozen mirror gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'workflow-common-layer-no-sdk': {
        description: 'Workflow/goal/goal-run/team/frontend must not import provider SDKs or create model adapter paths',
        async check() {
            try {
                const scanRoots = [
                    'src/workflows',
                    'src/goal',
                    'src/goal-run',
                    'src/team',
                    'public/js',
                ];
                const importRe = /from\s+['"](openai|@openai\/agents|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|@ai-sdk\/[^'"]+|ai)['"]/;
                const envRe = /\b(MODEL_ADAPTER_[A-Z_]+|AI_SDK_[A-Z_]+)\b/;
                /** @type {Array<{file:string, hit:string}>} */
                const violations = [];
                /** @param {string} dirAbs */
                function walk(dirAbs) {
                    if (!fs.existsSync(dirAbs)) return;
                    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                        const abs = path.join(dirAbs, entry.name);
                        if (entry.isDirectory()) { walk(abs); continue; }
                        if (!/\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) continue;
                        const rel = path.relative(repoRoot, abs);
                        if (rel.endsWith('release-gates.mjs')) continue;
                        const text = fs.readFileSync(abs, 'utf8');
                        if (importRe.test(text)) violations.push({ file: rel, hit: 'forbidden provider SDK import' });
                        if (envRe.test(text)) violations.push({ file: rel, hit: 'forbidden MODEL_ADAPTER_/AI_SDK_ env var' });
                    }
                }
                for (const root of scanRoots) walk(path.join(repoRoot, root));
                const dirDenylist = [
                    'src/workflows/model-adapter',
                    'src/goal/model-adapter',
                    'src/goal-run/model-adapter',
                    'src/team/model-adapter',
                ];
                for (const dirRel of dirDenylist) {
                    if (fs.existsSync(path.join(repoRoot, dirRel))) {
                        violations.push({ file: dirRel, hit: 'forbidden model-adapter path' });
                    }
                }
                if (violations.length) {
                    const sample = violations.slice(0, 5).map(v => `${v.file}: ${v.hit}`).join('; ');
                    return { ok: false, detail: `${violations.length} violation(s): ${sample}` };
                }
                return { ok: true, detail: 'workflow common layer clean: no SDK imports, no model-adapter paths' };
            } catch (err) {
                return { ok: false, detail: `workflow-common-layer-no-sdk gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'doc-drift': {
        description: 'no tracked file carries merge conflict markers (every run) + structure docs match live inventory',
        check() {
            // A merge that commits its own conflict markers is the one docs
            // failure CI has to catch: the #660 merge landed 14 unresolved
            // blocks on dev (README.md, AGENTS.md, CLAUDE.md,
            // structure/str_func.md) while gate:all stayed green. This scan is a
            // string match on tracked paths, platform-neutral, and runs first.
            //
            // The inventory steps below used to be skipped on CI because
            // str_func.md carried line counts that differ per checkout (no
            // public/dist, different tracked-file set). str_func.md is now a
            // membership map checked against tracked paths, so they run on CI too.
            const markers = trackedConflictMarkers();
            if (markers.error) return { ok: false, detail: markers.error };
            if (markers.hits.length) {
                const sample = markers.hits.slice(0, 5).join('; ');
                const more = markers.hits.length > 5 ? ` (+${markers.hits.length - 5} more)` : '';
                return { ok: false, detail: `${markers.hits.length} unresolved conflict marker line(s): ${sample}${more}` };
            }
            const unscanned = markers.unscanned?.length
                ? ` (not scanned, uninitialised submodule(s): ${markers.unscanned.join(', ')})`
                : '';
            const steps = [
                { name: 'docs:check', cmd: 'npm', args: ['run', 'docs:check', '--silent'], timeout: 120_000 },
                { name: 'check-doc-drift.sh', cmd: 'bash', args: ['structure/check-doc-drift.sh'], timeout: 120_000 },
            ];
            for (const s of steps) {
                const r = run(s.cmd, s.args, { timeout: s.timeout });
                if (r.status !== 0) {
                    return { ok: false, detail: `${s.name} failed:\n${[r.stdout, r.stderr].filter(Boolean).join('\n').slice(-1500)}` };
                }
            }
            return { ok: true, detail: `conflict-marker scan clean${unscanned}; docs:check + check-doc-drift.sh clean` };
        },
    },
    'path-length': {
        description: 'no tracked path exceeds the Windows MAX_PATH budget (main repo + submodules)',
        check() {
            // Runs on CI too, unlike doc-drift. The condition is platform-neutral
            // (a string length in the index), and the failure it prevents is one
            // Linux CI can never reproduce on its own — which is exactly how it
            // reached users twice (#422, #430).
            const r = run('node', ['scripts/check-path-length.mjs'], { timeout: 120_000 });
            if (r.status !== 0) {
                return {
                    ok: false,
                    detail: [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-1500),
                };
            }
            return { ok: true, detail: (r.stdout || '').trim().slice(-300) };
        },
    },
    'strict-baseline': {
        description: 'any-count ratchet: live counts must not exceed docs/migration/strict-baseline.md',
        check() {
            const r = run('node', ['scripts/check-strict-baseline.mjs'], { timeout: 120_000 });
            if (r.status !== 0) {
                return { ok: false, detail: `strict baseline regressed:\n${[r.stdout, r.stderr].filter(Boolean).join('\n').slice(-1200)}` };
            }
            return { ok: true, detail: 'live any/debt/allow counts within frozen baseline' };
        },
    },
    'redaction-sinks': {
        description: 'channel replies, sends and loggers route through a credential masker',
        check() {
            const r = run('node', ['scripts/check-redaction-sinks.mjs'], { timeout: 60_000 });
            if (r.status !== 0) {
                return { ok: false, detail: `unmasked channel sink:\n${[r.stdout, r.stderr].filter(Boolean).join('\n').slice(-1500)}` };
            }
            return { ok: true, detail: 'no unmasked sink in telegram/discord/slack/telegram-hub' };
        },
    },
    'electron-version': {
        description: 'electron/package.json version matches the root package.json',
        check() {
            const r = run('node', ['scripts/sync-electron-version.cjs', '--check'], { timeout: 60_000 });
            if (r.status !== 0) {
                return { ok: false, detail: [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(-500) };
            }
            return { ok: true, detail: 'desktop artifacts will carry the release version' };
        },
    },
    'sidecar-prune-safety': {
        description: 'the sidecar prune list never deletes a package the server imports',
        check() {
            const r = run('node', ['scripts/check-sidecar-prune-safety.mjs'], { timeout: 60_000 });
            if (r.status !== 0) {
                return { ok: false, detail: [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            return { ok: true, detail: 'packaged sidecar keeps every runtime dependency' };
        },
    },
    'native-load': {
        description: 'shipped native addons actually dlopen, and spawn-helper stays executable',
        check() {
            const r = run('node', ['scripts/check-native-load.cjs'], { timeout: 60_000 });
            // Exit 3 means nothing was probed. Reporting that as a pass with a
            // substantive detail would be a lie of exactly the kind this gate
            // exists to catch, so say what actually happened.
            if (r.status === 3) {
                return { ok: true, detail: 'SKIPPED — electron/node_modules absent, nothing probed' };
            }
            if (r.status !== 0) {
                // The probe prints its notes on stdout and its reasons on
                // stderr. `stdout || stderr` therefore threw the reasons away
                // whenever a single note had been printed, which is how a Linux
                // failure reached CI showing only "prebuilds present" and
                // "round-trip ok" with no stated cause.
                return { ok: false, detail: [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            return { ok: true, detail: 'node-pty loads under this runtime' };
        },
    },
    'sidecar-smoke': {
        description: 'critical sidecar modules import from the bundled tree, not just resolve statically',
        check() {
            const r = run('node', ['scripts/check-sidecar-smoke.mjs'], { timeout: 120_000 });
            if (r.status === 3) {
                return { ok: true, detail: 'SKIPPED — sidecar not bundled, nothing imported' };
            }
            if (r.status !== 0) {
                return { ok: false, detail: [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            return { ok: true, detail: 'bundled sidecar imports its critical entry surfaces' };
        },
    },
    'install-integrity': {
        description: 'scriptless install contract + allow-scripts recovery guidance stay pinned',
        check() {
            const r = run('npx', ['tsx', '--experimental-test-module-mocks', 'tests/run.mts',
                'tests/unit/install-integrity.test.ts',
                'tests/unit/scriptless-install-contract.test.ts'], { timeout: 180_000 });
            if (r.status !== 0) {
                return { ok: false, detail: [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            return { ok: true, detail: 'install-integrity + scriptless contract suites green' };
        },
    },
    'messaging-conformance': {
        description: 'Telegram/Slack/Discord durable ingress and command contract suites + functional certification artifact',
        check() {
            const publicDocs = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md', 'AGENTS.md'];
            for (const rel of publicDocs) {
                const abs = path.join(repoRoot, rel);
                if (!fs.existsSync(abs)) continue;
                const text = fs.readFileSync(abs, 'utf8');
                if (/exactly[- ]once/i.test(text)) {
                    return { ok: false, detail: `${rel} claims exactly-once` };
                }
                if (/release-certified/i.test(text)) {
                    return { ok: false, detail: `${rel} claims release-certified` };
                }
            }
            const suites = [
                'tests/unit/channel-contract-conformance.test.ts',
                'tests/unit/messaging-command-parity.test.ts',
                'tests/unit/messaging-durable-ingress.test.ts',
                'tests/unit/telegram-ingress-journal.test.ts',
                'tests/unit/discord-ingress-journal.test.ts',
                'tests/unit/ingress-generation.test.ts',
                'tests/unit/messaging-trace-context.test.ts',
                'tests/unit/messaging-metrics.test.ts',
            ];
            const missing = suites.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
            if (missing.length > 0) {
                return { ok: false, detail: `channel fixture missing: ${missing.join(', ')}` };
            }
            const tests = run('npx', ['tsx', '--experimental-test-module-mocks', 'tests/run.mts', ...suites], { timeout: 180_000 });
            if (tests.status !== 0) {
                return { ok: false, detail: [tests.stdout, tests.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            const written = run(process.execPath, [tsxCli, 'scripts/write-messaging-certification.mts'], { timeout: 30_000 });
            if (written.status !== 0) {
                return { ok: false, detail: [written.stdout, written.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            const validated = run(process.execPath, [tsxCli, 'scripts/validate-messaging-certification.mts'], { timeout: 30_000 });
            if (validated.status !== 0) {
                return { ok: false, detail: [validated.stdout, validated.stderr].filter(Boolean).join('\n').trim().slice(-800) };
            }
            return { ok: true, detail: 'three-channel messaging suites green; functional-certified artifact valid' };
        },
    },
    'gate-docs': {
        description: 'structure/INDEX.md documents exactly the gates that exist, and each is npm-addressable',
        check() {
            // structure/INDEX.md hardcodes the gate count and enumerates every
            // name. Adding the 16th gate made that row wrong, and nothing
            // noticed: check-docs.mts counts only routes and endpoints, and
            // check-doc-drift.sh never looks at gates. Fixing the row by hand
            // cleared one instance; this closes the class.
            //
            // This gate lives inside release-gates.mjs rather than in its own
            // script because the module calls main() unconditionally at the
            // bottom, so importing GATES from outside would run every gate.
            const names = Object.keys(GATES);
            const doc = readFile('structure/INDEX.md');
            const row = doc.split('\n').find((line) =>
                line.includes('named gates') && line.includes('runs all'));
            if (!row) {
                return { ok: false, detail: 'the release-gates row is gone from structure/INDEX.md' };
            }

            const problems = [];

            const claimed = row.match(/runs all (\d+) named gates/);
            if (!claimed) {
                problems.push('the row no longer states a gate count');
            } else if (Number(claimed[1]) !== names.length) {
                problems.push(`count says ${claimed[1]}, GATES has ${names.length}`);
            }

            // Read ONLY the parenthesised list, not the whole row. The row also
            // carries `scripts/release-gates.mjs`, `package.json`, `gate:all`
            // and `gate:<name>` in prose; scanning the row and filtering those
            // out by shape both accuses innocent prose and lets a phantom like
            // `gate:retired-name` through, because a filter keyed on the token
            // shape cannot tell a stale gate from an ordinary mention.
            const list = row.match(/named gates \(([^)]*)\)/);
            if (!list) {
                problems.push('the parenthesised gate list is gone from the row');
            } else {
                const documented = [...list[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
                const missing = names.filter((name) => !documented.includes(name));
                const stale = documented.filter((name) => !names.includes(name));
                if (missing.length > 0) problems.push(`undocumented: ${missing.join(', ')}`);
                if (stale.length > 0) problems.push(`documented but gone: ${stale.join(', ')}`);
            }

            // The same row promises `gate:<name>` addressability. A gate added
            // without its npm script makes that sentence false while gate:all
            // stays green -- the hand-maintained invariant this gate exists to
            // stop being hand-maintained.
            const pkg = JSON.parse(readFile('package.json'));
            const unaddressable = names.filter((name) =>
                pkg.scripts?.[`gate:${name}`] !== `node scripts/release-gates.mjs ${name}`);
            if (unaddressable.length > 0) {
                problems.push(`no npm script: ${unaddressable.map((n) => `gate:${n}`).join(', ')}`);
            }

            if (problems.length > 0) {
                return { ok: false, detail: `${problems.join('\n')}\nFix structure/INDEX.md / package.json` };
            }
            return { ok: true, detail: `${names.length} gates documented and addressable` };
        },
    },
};

function printResult(name, result) {
    const status = result.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[${status}] gate:${name} — ${GATES[name].description}\n`);
    if (result.detail) process.stdout.write(`        ${result.detail.replace(/\n/g, '\n        ')}\n`);
}

async function main() {
    const target = process.argv[2];
    const names = target ? [target] : Object.keys(GATES);
    let failed = 0;
    for (const name of names) {
        if (!GATES[name]) {
            process.stdout.write(`[FAIL] gate:${name} — unknown gate\n`);
            failed += 1;
            continue;
        }
        let result;
        try {
            result = await GATES[name].check();
        } catch (err) {
            result = { ok: false, detail: `threw: ${err.message}` };
        }
        printResult(name, result);
        if (!result.ok) failed += 1;
    }
    process.stdout.write(failed === 0 ? `\nAll ${names.length} gate(s) passed.\n` : `\n${failed}/${names.length} gate(s) FAILED.\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    process.stderr.write(`release-gates threw: ${err.stack || err}\n`);
    process.exit(1);
});
