// #449: remote access exposed the bearer token and the secrets it protects.
//
// These are source-shape assertions on purpose. Reproducing them behaviourally
// needs a listening server on a non-loopback interface, which is an integration
// fixture and npm test does not run those. What can be checked here is that the
// guard exists on the route that lacked it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { isLoopbackAddress } from '../../src/http/loopback.ts';

const root = join(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(join(root, p), 'utf8');

test('SEC-449a: loopback detection accepts the IPv4-mapped form', () => {
    // A dual-stack listener reports 127.0.0.1 as ::ffff:127.0.0.1; missing that
    // would lock the local UI out of its own token.
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.50'), false);
    assert.equal(isLoopbackAddress('10.0.0.4'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(undefined), false);
});

test('SEC-449b: the auth-token route refuses non-loopback callers', () => {
    const src = read('src/routes/system.ts');
    const route = src.slice(src.indexOf("'/api/auth/token'"));
    // Bounded by where the token is actually handed out, so the window cannot
    // accidentally exclude the guard it is meant to find.
    const respondIdx = route.indexOf('deps.jawAuthToken');
    assert.ok(respondIdx > -1, 'the route must still return the token somewhere');
    const beforeResponse = route.slice(0, respondIdx);
    assert.match(beforeResponse, /isLoopbackAddress/,
        'Sec-Fetch-Site is absent from curl, so it cannot be the only guard — '
        + 'the loopback check must run before the token is returned');
});

test('SEC-449c: settings and mcp reads are authenticated', () => {
    const src = read('src/routes/settings.ts');
    assert.match(src, /app\.get\('\/api\/settings', requireAuth/);
    assert.match(src, /app\.get\('\/api\/mcp', requireAuth/);
});

test('SEC-449d: channel bot tokens never leave through the settings read', () => {
    const src = read('src/routes/settings.ts');
    const fn = src.slice(src.indexOf('function redactRuntimeSettings'));
    assert.match(fn.slice(0, 2000), /MASKED_SECRET/,
        'only the Slack env case was masked; a file-configured token came back verbatim');
});

test('SEC-449e: env-provided channel tokens are stripped before the file is written', () => {
    const src = read('src/core/config.ts');
    const fn = src.slice(src.indexOf('function serializeSettingsForSave'));
    const body = fn.slice(0, 1200);
    for (const [channel, key] of [['telegram', 'TELEGRAM_TOKEN'], ['discord', 'DISCORD_TOKEN']]) {
        const owner = `${channel}EnvironmentManagedSettingKeys`;
        assert.match(body, new RegExp(`${owner}\\(\\)`),
            `${key} must be stripped like the Slack keys already are`);
        const table = src.slice(src.indexOf(`function ${owner}`) - 1200, src.indexOf(`function ${owner}`));
        assert.match(table, new RegExp(`${key}: \\[[^\\]]*'token'`),
            `${key} must own the ${channel} token field`);
    }
});

// ─── #684: omission-detecting guard scan ─────────────────────────────────────
//
// The original SEC-449f named two routes and asserted the literal "', requireAuth"
// sat next to each. That can only fail when someone deletes a guard from a route
// the list already names. It cannot notice a NEW route that ships without one —
// which is exactly how #684 happened, months after #449 closed the sibling paths.
//
// So this scans instead of matching. It parses the first argument of every
// app.<verb>(...) registration in the covered modules and treats a route as
// guarded only when that argument is exactly the identifier requireAuth. A
// wrapper, a renamed local, or a comment that merely says requireAuth all read
// as unguarded and fail the test.

type ScannedRoute = { method: string; routePath: string | null; guard: string | null };

// These modules attach the guard per route, so a missing one is invisible at the
// server.ts level. Prefix-mounted modules (jaw-ceo, runtime-context, code-native)
// are guarded once by app.use(..., requireAuth, ...); scanning them would report
// every route as unguarded and say nothing.
const COVERED_MODULES = [
    'memory.ts', 'jaw-memory.ts', 'system.ts', 'instance.ts', 'i18n.ts', 'settings.ts',
];

// Exact paths, never prefixes: '/api/health' is a prefix of '/api/heartbeat-md'.
const PUBLIC_ROUTES = new Set(['/api/health', '/api/ready', '/api/slack/manifest']);

// /api/auth/token is neither public nor behind requireAuth, because requireAuth is
// the WEAKER test for it: it also admits LAN peers when lanBypass is on, which
// would turn the token endpoint into a LAN token mint. It carries a loopback-only
// check instead, and SEC-449k proves that check still runs before the token.
const SELF_GUARDED = new Map([['/api/auth/token', 'isLoopbackAddress']]);

// A route that vanishes from the scan is as dangerous as one that loses its guard:
// rewrite a registration into a shape the parser cannot read and SEC-449f goes
// quiet instead of failing. This list is the coverage floor — every path here must
// be SEEN, and seen as guarded.
const REQUIRED_GUARDED: [string, string][] = [
    ['memory.ts', '/api/memory'],
    ['memory.ts', '/api/memory-file'],
    ['memory.ts', '/api/memory-files'],
    ['memory.ts', '/api/memory-files/:filename'],
    ['memory.ts', '/api/memory/status'],
    ['memory.ts', '/api/memory/files'],
    ['jaw-memory.ts', '/api/jaw-memory/search'],
    ['jaw-memory.ts', '/api/jaw-memory/read'],
    ['jaw-memory.ts', '/api/jaw-memory/context'],
    ['jaw-memory.ts', '/api/jaw-memory/list'],
    ['jaw-memory.ts', '/api/jaw-memory/soul'],
    ['system.ts', '/api/session'],
    ['system.ts', '/api/runtime'],
    ['system.ts', '/api/debug/mem'],
    ['instance.ts', '/api/instance/lock'],
    ['i18n.ts', '/api/i18n/languages'],
    ['i18n.ts', '/api/i18n/:lang'],
    ['settings.ts', '/api/settings'],
    ['settings.ts', '/api/mcp'],
    ['settings.ts', '/api/mcp/registry'],
    ['settings.ts', '/api/prompt'],
    ['settings.ts', '/api/prompt-templates'],
    ['settings.ts', '/api/heartbeat-md'],
    ['settings.ts', '/api/quota'],
    ['settings.ts', '/api/cli-registry'],
    ['settings.ts', '/api/cli-status'],
    // messages.ts is not scanned for omissions (another lane owns the file), but
    // the routes #449 closed there must stay closed.
    ['messages.ts', '/api/messages'],
    ['messages.ts', '/api/messages/search'],
];

function skipTrivia(src: string, i: number): number {
    for (;;) {
        while (i < src.length && /\s/.test(src[i] as string)) i += 1;
        if (src.startsWith('//', i)) {
            const nl = src.indexOf('\n', i);
            i = nl === -1 ? src.length : nl + 1;
            continue;
        }
        if (src.startsWith('/*', i)) {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 2;
            continue;
        }
        return i;
    }
}

function readStringLiteral(src: string, i: number): { value: string; next: number } | null {
    const quote = src[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') return null;
    let out = '';
    let j = i + 1;
    while (j < src.length) {
        const ch = src[j] as string;
        if (ch === '\\') { out += src[j + 1] ?? ''; j += 2; continue; }
        if (ch === quote) return { value: out, next: j + 1 };
        out += ch;
        j += 1;
    }
    return null;
}

// Reads one argument expression, stopping at the comma or paren that closes it at
// depth zero. Quotes and nested brackets are tracked so a comma inside them does
// not end the argument early.
function readArgument(src: string, i: number): { text: string; next: number } {
    let depth = 0;
    const start = i;
    while (i < src.length) {
        const ch = src[i] as string;
        if (ch === "'" || ch === '"' || ch === '`') {
            const lit = readStringLiteral(src, i);
            if (!lit) break;
            i = lit.next;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) break;
            depth -= 1;
            i += 1;
            continue;
        }
        if (ch === ',' && depth === 0) break;
        i += 1;
    }
    return { text: src.slice(start, i).trim(), next: i };
}

function scanRoutes(src: string): ScannedRoute[] {
    const calls = /\bapp\.(get|post|put|delete|patch|use)\s*\(/g;
    const found: ScannedRoute[] = [];
    let match: RegExpExecArray | null;
    while ((match = calls.exec(src)) !== null) {
        const method = (match[1] as string).toUpperCase();
        let i = skipTrivia(src, match.index + match[0].length);
        const literal = readStringLiteral(src, i);
        if (!literal) {
            // A computed path cannot be checked here. Report it so it fails loudly
            // instead of disappearing from the scan.
            found.push({ method, routePath: null, guard: null });
            continue;
        }
        i = skipTrivia(src, literal.next);
        if (src[i] !== ',') continue; // app.use(router) with no path argument
        i = skipTrivia(src, i + 1);
        const arg = readArgument(src, i);
        found.push({ method, routePath: literal.value, guard: arg.text || null });
    }
    return found;
}

const isGuarded = (route: ScannedRoute) => route.guard === 'requireAuth';
const routesIn = (file: string) => scanRoutes(read('src/routes/' + file));

test('SEC-449f: no sensitive route in the covered modules answers without a guard', () => {
    const open: string[] = [];
    for (const file of COVERED_MODULES) {
        for (const route of routesIn(file)) {
            if (isGuarded(route)) continue;
            if (route.routePath === null) {
                open.push(file + ': ' + route.method + ' with a computed path the scan cannot verify');
                continue;
            }
            if (PUBLIC_ROUTES.has(route.routePath) || SELF_GUARDED.has(route.routePath)) continue;
            open.push(file + ': ' + route.method + ' ' + route.routePath + ' (guard: ' + (route.guard ?? 'none') + ')');
        }
    }
    assert.deepEqual(open, [],
        'these routes are reachable without requireAuth — add the guard, or add the path to '
        + 'PUBLIC_ROUTES with a reason:\n  ' + open.join('\n  '));
});

test('SEC-449h: every route #449 and #684 closed is still seen by the scan and still guarded', () => {
    const broken: string[] = [];
    const cache = new Map<string, ScannedRoute[]>();
    for (const [file, routePath] of REQUIRED_GUARDED) {
        if (!cache.has(file)) cache.set(file, routesIn(file));
        const matches = (cache.get(file) as ScannedRoute[]).filter(r => r.routePath === routePath);
        if (matches.length === 0) {
            broken.push(file + ' ' + routePath + ': not found by the scan at all');
            continue;
        }
        for (const route of matches) {
            if (!isGuarded(route)) broken.push(file + ' ' + route.method + ' ' + routePath + ': guard is ' + (route.guard ?? 'none'));
        }
    }
    assert.deepEqual(broken, [], 'guard coverage regressed:\n  ' + broken.join('\n  '));
});

test('SEC-449i: the scan actually detects an omission', () => {
    // The assertions above are only worth their runtime if the scanner can fail.
    // These fixtures are the forms a future edit would most plausibly take.
    const fixture = [
        "app.get('/api/guarded', requireAuth, (req, res) => res.json({}));",
        "app.get('/api/plain-open', (req, res) => res.json({}));",
        'app.get(',
        "    '/api/multiline-open',",
        '    async (req, res) => res.json({}),',
        ');',
        'app.post("/api/double-quoted-open", handler);',
        "app.get('/api/comment-spoof-open', /* requireAuth */ handler);",
        "app.put('/api/boolean-spoof-open', requireAuth && handler);",
    ].join('\n');

    const open = scanRoutes(fixture).filter(r => !isGuarded(r)).map(r => r.routePath);
    assert.deepEqual(open.sort(), [
        '/api/boolean-spoof-open',
        '/api/comment-spoof-open',
        '/api/double-quoted-open',
        '/api/multiline-open',
        '/api/plain-open',
    ], 'the scanner must report every unguarded form, including the ones that only look guarded');
    assert.equal(open.includes('/api/guarded'), false, 'a genuinely guarded route must not be reported');
});

test('SEC-449j: server.ts hands the guard to every registrar that needs it', () => {
    // #684: these three took no middleware, or took it and dropped it, so their
    // routes could never be guarded no matter what the module did.
    const src = read('server.ts');
    assert.match(src, /registerSystemRoutes\(app, requireAuth,/);
    assert.match(src, /registerInstanceRoutes\(app, requireAuth\)/);
    assert.match(src, /registerI18nRoutes\(app, requireAuth,/);
    // Signature-shaped, not a file-wide search: i18n's own comment mentions the
    // discarded `_requireAuth` parameter this replaced, and prose should not
    // decide whether the guard is wired.
    assert.match(read('src/routes/i18n.ts'),
        /export function registerI18nRoutes\([^)]*requireAuth: AuthMiddleware/,
        'i18n must take the guard as a used parameter, not discard it as _requireAuth');
    assert.match(read('src/routes/instance.ts'),
        /export function registerInstanceRoutes\([^)]*requireAuth: AuthMiddleware/);
    assert.match(read('src/routes/system.ts'),
        /export function registerSystemRoutes\([^)]*requireAuth: AuthMiddleware/);
});

test('SEC-449k: the token route keeps its own loopback check', () => {
    const src = read('src/routes/system.ts');
    for (const [routePath, guardCall] of SELF_GUARDED) {
        const start = src.indexOf("'" + routePath + "'");
        assert.ok(start > -1, routePath + ' should still exist');
        const route = src.slice(start);
        const respondIdx = route.indexOf('deps.jawAuthToken');
        assert.ok(respondIdx > -1, 'the route must still return the token somewhere');
        assert.match(route.slice(0, respondIdx), new RegExp(guardCall),
            routePath + ' is exempt from requireAuth only because ' + guardCall + ' runs first');
    }
});

test('SEC-449g: health stays public — the guard must not break liveness checks', () => {
    const src = read('src/routes/system.ts');
    const route = src.slice(src.indexOf("'/api/health'"), src.indexOf("'/api/health'") + 200);
    assert.doesNotMatch(route, /requireAuth/,
        'a monitor must be able to poll health without a bearer');
});
