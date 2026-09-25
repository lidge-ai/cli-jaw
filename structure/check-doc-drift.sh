#!/usr/bin/env bash
# check-doc-drift.sh — CI gate for structure docs drift detection
# Validates: commands.md, server_api.md, websocket events, str_func membership
# Exit: 0 = all pass, 1 = drift detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[0;90m'
RESET='\033[0m'

FAIL=0
PASS=0
SKIP=0

pass() { echo -e "  ${GREEN}✅ $1${RESET}"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}❌ $1${RESET}"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${DIM}⏭️  $1${RESET}"; SKIP=$((SKIP + 1)); }
info() { echo -e "  ${DIM}   $1${RESET}"; }

check_commands_doc() {
  echo ""
  echo -e "${BOLD}📋 1/4 — commands.md command counts${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');

const commandsDoc = fs.readFileSync('structure/commands.md', 'utf8');
const commandLines = fs.readFileSync('src/cli/commands.ts', 'utf8').split(/\r?\n/);
const catalog = fs.readFileSync('src/command-contract/catalog.ts', 'utf8');

const entries = [];
for (const line of commandLines) {
  const match = line.match(/^\s*\{\s*name: '([^']+)'/);
  if (!match) continue;
  const ifaceMatch = line.match(/interfaces: \[([^\]]*)\]/);
  const interfaces = ifaceMatch
    ? ifaceMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : [];
  const categoryMatch = line.match(/category: '([^']+)'/);
  const category = categoryMatch ? categoryMatch[1] : 'tools';
  const hidden = /hidden:\s*true/.test(line);
  entries.push({ name: match[1], interfaces, hidden, category });
}

const hiddenMatch = catalog.match(/CMDLINE_HIDDEN = new Set\(\[([\s\S]*?)\]\);/);
if (!hiddenMatch) {
  console.error('commands.md drift: CMDLINE_HIDDEN set not found in src/command-contract/catalog.ts');
  process.exit(1);
}
const cmdlineHidden = hiddenMatch[1]
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

const visible = (iface) => entries.filter((entry) => entry.interfaces.includes(iface) && !entry.hidden).length;
const actual = {
  total: entries.length,
  cli: visible('cli'),
  web: visible('web'),
  telegram: visible('telegram'),
  discord: visible('discord'),
  cmdline: entries.filter((entry) => !cmdlineHidden.includes(entry.name) && entry.category !== 'workflow').length,
};

const summary = commandsDoc.split(/\r?\n/).find((line) => /개 커맨드/.test(line) && /CLI \d+/.test(line));
if (!summary) {
  console.error('commands.md drift: summary line not found');
  process.exit(1);
}

const doc = {
  total: Number((summary.match(/(\d+)개 커맨드/) || [])[1]),
  cli: Number((summary.match(/CLI (\d+)/) || [])[1]),
  web: Number((summary.match(/Web (\d+)/) || [])[1]),
  telegram: Number((summary.match(/Telegram (\d+)/) || [])[1]),
  discord: Number((summary.match(/Discord (\d+)/) || [])[1]),
  cmdline: Number((summary.match(/(\d+)개가 보인다/) || [])[1]),
};

const labels = [
  ['total', 'total command count'],
  ['cli', 'CLI visible count'],
  ['web', 'Web visible count'],
  ['telegram', 'Telegram visible count'],
  ['discord', 'Discord visible count'],
  ['cmdline', 'cmdline visible count'],
];

const mismatches = labels
  .filter(([key]) => doc[key] !== actual[key])
  .map(([key, label]) => `${label}: doc ${doc[key]} vs actual ${actual[key]}`);

if (mismatches.length) {
  console.error('commands.md drift:');
  for (const line of mismatches) console.error(`  - ${line}`);
  process.exit(1);
}
NODE
  then
    pass "commands.md — command totals match live registry"
  else
    fail "commands.md — command totals drifted"
    info "Fix: update the summary line in structure/commands.md"
  fi
}

check_server_api_doc() {
  echo ""
  echo -e "${BOLD}📋 2/4 — server_api.md route table${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');
const path = require('path');

const doc = fs.readFileSync('structure/server_api.md', 'utf8');
const ts = require('typescript');

function codeDrift(message) {
  throw new Error(`server_api.md Code drift: ${message}`);
}
const identifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
function literal(node) {
  if (!node || !ts.isStringLiteral(node)) codeDrift('unsupported nonliteral registration');
  return node.text;
}
function sourceFile(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) codeDrift(`invalid source: ${file}`);
  return source;
}
function registrar(source, name) {
  const found = source.statements.filter(node => ts.isFunctionDeclaration(node) && identifier(node.name, name));
  if (found.length !== 1 || !found[0].body || !found[0].modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    codeDrift(`missing or ambiguous registrar: ${name}`);
  }
  return found[0];
}
function directCall(statement) {
  return ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : null;
}
function member(call, owner, method) {
  return call && ts.isPropertyAccessExpression(call.expression)
    && identifier(call.expression.expression, owner) && call.expression.name.text === method;
}

// These two explicit registrars are outside the legacy collector's mount model.
// Inspect their declarations, not comments or a second hardcoded route catalog.
function codeRegistrations() {
  const nativeFile = 'src/routes/code-native.ts', workspaceFile = 'src/routes/code.ts';
  const native = registrar(sourceFile(nativeFile), 'registerNativeCodeRoutes');
  const workspace = registrar(sourceFile(workspaceFile), 'registerCodeRoutes');
  if (!identifier(native.parameters[0]?.name, 'app') || !identifier(workspace.parameters[0]?.name, 'app')) {
    codeDrift('registrar app binding changed');
  }
  if (!identifier(native.parameters[3]?.name, 'prefix')) codeDrift('missing native prefix parameter');
  const prefix = literal(native.parameters[3].initializer);
  if (!/^\/api\/code$/.test(prefix)) codeDrift('native default prefix changed');
  const statements = native.body.statements;
  const mounts = statements.map(directCall).filter(call => member(call, 'app', 'use') && identifier(call.arguments[1], 'router'));
  if (mounts.length !== 1 || mounts[0].arguments.length !== 2 || !identifier(mounts[0].arguments[0], 'prefix')) {
    codeDrift('native router mount changed');
  }
  const declarations = statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations]);
  const routers = declarations.filter(d => identifier(d.name, 'router'));
  if (routers.length !== 1 || !routers[0].initializer || !ts.isCallExpression(routers[0].initializer)
      || !identifier(routers[0].initializer.expression, 'Router')) codeDrift('native router binding changed');
  const retired = declarations.filter(d => identifier(d.name, 'retired'));
  const rejection = retired.length === 1 && retired[0].initializer;
  const rejectCall = rejection && ts.isArrowFunction(rejection) && ts.isBlock(rejection.body)
    && rejection.body.statements.length === 1 && directCall(rejection.body.statements[0]);
  if (!rejectCall || !identifier(rejectCall.expression, 'fail') || rejectCall.arguments[1]?.getText() !== '410'
      || literal(rejectCall.arguments[2]) !== 'code_endpoint_retired') codeDrift('retired handler is not the 410 boundary');

  for (const file of ['server.ts', 'src/manager/server.ts']) {
    const source = sourceFile(file);
    for (const [name, target] of [['registerNativeCodeRoutes', nativeFile], ['registerCodeRoutes', workspaceFile]]) {
      const imports = source.statements.filter(ts.isImportDeclaration).filter(node => {
        const bindings = node.importClause?.namedBindings;
        return bindings && ts.isNamedImports(bindings) && bindings.elements.some(e => identifier(e.name, name) && !e.propertyName)
          && path.resolve(path.dirname(file), literal(node.moduleSpecifier)).replace(/\.js$/, '.ts') === path.resolve(target);
      });
      const calls = source.statements.map(directCall).filter(call => call && identifier(call.expression, name));
      if (imports.length !== 1 || calls.length !== 1 || !identifier(calls[0].arguments[0], 'app')) {
        codeDrift(`${file}: missing mounted ${name}`);
      }
      if (name === 'registerNativeCodeRoutes' && (calls[0].arguments.length !== 4 || literal(calls[0].arguments[3]) !== prefix)) {
        codeDrift(`${file}: native prefix mismatch`);
      }
    }
  }

  const active = new Set(), compatibility = new Set(), helpers = new Set();
  function collect(fn, owner, base, destination) {
    const handled = new Set();
    function add(call, route) {
      const method = call.expression.name.text;
      if (!/^(get|post|put|delete|patch|head|options|all)$/.test(method) || call.arguments.length < 2) {
        codeDrift('unsupported route declaration');
      }
      if (!/^\/[A-Za-z0-9_:/.-]*$/.test(route)) codeDrift('unsupported Code path');
      const isRetired = identifier(call.arguments[call.arguments.length - 1], 'retired');
      if (method === 'all' && !isRetired) codeDrift('functional router.all is not inventoried');
      const key = `${method.toUpperCase()} ${base}${route}`;
      const set = isRetired ? compatibility : destination;
      if (set.has(key)) codeDrift(`duplicate registration: ${key}`);
      set.add(key); handled.add(call);
    }
    for (const statement of fn.body.statements) {
      const call = directCall(statement);
      if (call && ts.isPropertyAccessExpression(call.expression) && identifier(call.expression.expression, owner)
          && call.expression.name.text !== 'use') add(call, literal(call.arguments[0]));
      else if (ts.isForOfStatement(statement)) {
        const variables = ts.isVariableDeclarationList(statement.initializer) && statement.initializer.declarations;
        const loop = ts.isExpressionStatement(statement.statement) ? statement.statement
          : ts.isBlock(statement.statement) && statement.statement.statements.length === 1 && statement.statement.statements[0];
        const registration = loop && directCall(loop);
        if (!variables || variables.length !== 1 || !identifier(variables[0].name, 'path')
            || !ts.isArrayLiteralExpression(statement.expression) || !member(registration, owner, 'all')
            || !identifier(registration.arguments[0], 'path') || !identifier(registration.arguments[1], 'retired')
            || registration.arguments.length !== 2) codeDrift('unsupported compatibility loop');
        for (const element of statement.expression.elements) add(registration, literal(element));
      }
    }
    // Conditional/nested/computed registrations cannot disappear from the inventory.
    function visit(node) {
      if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
          && identifier(node.expression.expression, owner) && !member(node, owner, 'use') && !handled.has(node)) {
        codeDrift('unsupported nested or computed Code registration');
      }
      ts.forEachChild(node, visit);
    }
    visit(fn.body);
  }
  collect(native, 'router', prefix, active);
  collect(workspace, 'app', '', helpers);
  if (!active.size || !helpers.size || !compatibility.size) codeDrift('empty Code registration inventory');
  for (const route of helpers) {
    if (active.has(route)) codeDrift(`duplicate workspace registration: ${route}`);
  }
  for (const route of [...active, ...helpers]) {
    if (compatibility.has(route) || compatibility.has(`ALL ${route.slice(route.indexOf(' ') + 1)}`)) {
      codeDrift(`functional route shadowed by retirement: ${route}`);
    }
  }
  return { active, helpers, compatibility };
}
const code = codeRegistrations();

function extractAppRoutes(text) {
  const routes = [];
  for (const match of text.matchAll(/app\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    const method = match[1].toUpperCase();
    const route = match[2].split('?')[0];
    routes.push(`${method} ${route}`);
  }
  return routes;
}

function extractRouterRoutes(text) {
  const routes = [];
  for (const match of text.matchAll(/(?:router|ctx\.router)\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    const method = match[1].toUpperCase();
    const route = match[2].split('?')[0];
    routes.push(`${method} ${route}`);
  }
  return routes;
}

function prefixedRoutes(file, prefix) {
  return extractRouterRoutes(fs.readFileSync(file, 'utf8')).map((entry) => {
    const [method, route] = entry.split(' ');
    return `${method} ${prefix}${route === '/' ? '' : route}`;
  });
}

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const serverText = fs.readFileSync('server.ts', 'utf8');
const routeTexts = collectTsFiles('src/routes')
  .map((file) => fs.readFileSync(file, 'utf8'));
const browserText = fs.readFileSync('src/routes/browser.ts', 'utf8');
const actualRoutes = new Set([
  ...extractAppRoutes(serverText),
  ...routeTexts.flatMap(extractAppRoutes),
  ...prefixedRoutes('src/routes/runtime-context.ts', '/api/runtime-context'),
  ...prefixedRoutes('src/routes/security-audit.ts', '/api/security-audit'),
  ...prefixedRoutes('src/manager/board/routes.ts', '/api/dashboard/board'),
  ...prefixedRoutes('src/manager/schedule/routes.ts', '/api/dashboard/schedule'),
  ...prefixedRoutes('src/routes/jaw-ceo.ts', '/api/jaw-ceo'),
].filter((route) => route !== 'GET /'));
const dynamicAppRouteCount = [serverText, ...routeTexts]
  .reduce((count, text) => count + [...text.matchAll(/app\.(?:get|post|put|delete|patch)\(\s*\/\^/g)].length, 0);

function expandDocRoutes(token) {
  const [methodsPart, ...rest] = token.trim().split(/\s+/);
  if (!rest.length) return [];
  let routePart = rest.join(' ').replace(/\?.*$/, '');
  const methods = methodsPart.split('/').map((s) => s.trim()).filter(Boolean);
  const paths = routePart.includes(',')
    ? (() => {
        const idx = routePart.lastIndexOf('/');
        const prefix = idx >= 0 ? routePart.slice(0, idx + 1) : '';
        return routePart.slice(idx + 1).split(',').map((part) => prefix + part.trim()).filter(Boolean);
      })()
    : [routePart];
  const out = [];
  for (const method of methods) {
    for (const route of paths) {
      out.push(`${method} ${route}`);
    }
  }
  return out;
}

const lines = doc.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === '## REST API');
const wsIndex = lines.findIndex((line) => line.trim() === '## WebSocket Events');
if (start === -1 || wsIndex === -1) {
  console.error('server_api.md drift: REST API or WebSocket Events section not found');
  process.exit(1);
}

const docRoutes = new Set();
const codeRows = [], compatibilityRows = [];
const restEnd = lines.findIndex((line, index) => index > start && line.trim() === '---');
for (const line of lines.slice(start, restEnd === -1 ? wsIndex : Math.min(restEnd, wsIndex))) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  if (!cells[1] || cells[1] === 'Endpoints' || cells[1].startsWith('-')) continue;
  if (cells[0] === 'Code Mode') { codeRows.push(cells[1]); continue; }
  if (cells[0] === 'Code Mode compatibility (410)') { compatibilityRows.push(cells[1]); continue; }
  for (const token of cells[1].match(/`([^`]+)`/g) || []) {
    for (const route of expandDocRoutes(token.slice(1, -1))) {
      docRoutes.add(route);
    }
  }
}

function codeRow(text, allowAll = false) {
  const tokens = text.match(/`[^`]+`/g) || [];
  if (!tokens.length || text.replace(/`[^`]+`/g, '').trim()) codeDrift('malformed Code row');
  const routes = new Set();
  for (const token of tokens) {
    const value = token.slice(1, -1);
    if (!/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)(?:\/(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS))* \/[A-Za-z0-9_:/.,-]+$/.test(value)
        || (!allowAll && value.startsWith('ALL '))) codeDrift(`malformed Code route: ${value}`);
    for (const route of expandDocRoutes(value)) {
      if (routes.has(route)) codeDrift(`duplicate Code route: ${route}`);
      routes.add(route);
    }
  }
  return routes;
}
if (codeRows.length !== 1 || compatibilityRows.length > 1) codeDrift('missing or duplicate Code row');
const documentedCode = codeRow(codeRows[0]);
const actualCode = new Set([...code.active, ...code.helpers]);
const codeIssues = [
  ...[...actualCode].filter(route => !documentedCode.has(route)).map(route => `missing Code route: ${route}`),
  ...[...documentedCode].filter(route => !actualCode.has(route)).map(route => `extra Code route: ${route}`),
];
if (compatibilityRows.length) {
  for (const route of codeRow(compatibilityRows[0], true)) {
    if (!code.compatibility.has(route) && !code.compatibility.has(`ALL ${route.slice(route.indexOf(' ') + 1)}`)) {
      codeIssues.push(`unregistered compatibility route: ${route}`);
    }
  }
}

const summaries = lines.filter(line => /^>.*(?:총 \d+개 route handler|AST 추출기가 현재 인식하는 범위)/.test(line));
if (summaries.length !== 1) codeDrift('missing or duplicate route summary');
const summary = summaries[0];
const explicit = summary.match(/^> AST 추출기가 현재 인식하는 범위는 총 (\d+)개 route handler다\. 이 추출 범위의 API 엔드포인트는 (\d+)개이고 `\/` 엔트리는 1개다\./);
const legacy = /^>.*총 \d+개 route handler 기준이다\./.test(summary);
if (!explicit && !legacy) codeDrift('unrecognized route summary grammar');
if (explicit && (!summary.includes('전체 API 총수는 아니다.')
    || !summary.includes('`registerNativeCodeRoutes()` 내부의 `router.*`와 `app.use(prefix, router)` 연결은 아직 집계하지 못한다.'))) {
  codeDrift('missing native subset boundary');
}
function summaryCount(pattern, name) {
  const matches = [...summary.matchAll(pattern)];
  if (matches.length !== 1) codeDrift(`missing or duplicate ${name} count`);
  return Number(matches[0][1]);
}
if (explicit && summaryCount(/native Code 핸들러 (\d+)개/g, 'native') !== code.active.size) {
  codeIssues.push('native handler count disagrees with registrations');
}

const docCounts = {
  totalHandlers: summaryCount(/총 (\d+)개 route handler/g, 'handler'),
  apiEndpoints: summaryCount(/API 엔드포인트는 (\d+)개/g, 'API'),
  browserRoutes: summaryCount(/Browser API (\d+)개/g, 'Browser'),
};

const actualCounts = {
  totalHandlers: actualRoutes.size + dynamicAppRouteCount + 1,
  apiEndpoints: actualRoutes.size + dynamicAppRouteCount,
  browserRoutes: extractAppRoutes(browserText).length,
};

const countLabels = [
  ['totalHandlers', 'total route handlers'],
  ['apiEndpoints', 'API endpoints'],
  ['browserRoutes', 'browser endpoint count'],
];

const countMismatches = countLabels
  .filter(([key]) => docCounts[key] !== actualCounts[key])
  .map(([key, label]) => `${label}: doc ${docCounts[key]} vs actual ${actualCounts[key]}`);

// Workspace helpers remain in the subset totals, but their exact pairs were
// already checked in Code Mode. Never exempt the entire /api/code prefix.
const otherRoutes = new Set([...actualRoutes].filter(route => !code.helpers.has(route)));
const missing = [...otherRoutes].filter((route) => !docRoutes.has(route));
const extra = [...docRoutes].filter((route) => !otherRoutes.has(route));

if (countMismatches.length || missing.length || extra.length || codeIssues.length) {
  console.error('server_api.md drift:');
  for (const line of codeIssues) console.error(`  - ${line}`);
  for (const line of countMismatches) console.error(`  - ${line}`);
  if (missing.length) {
    console.error('  missing routes:');
    for (const route of missing) console.error(`    - ${route}`);
  }
  if (extra.length) {
    console.error('  extra routes:');
    for (const route of extra) console.error(`    - ${route}`);
  }
  process.exit(1);
}
NODE
  then
    pass "server_api.md — route table matches live handlers"
  else
    fail "server_api.md — route table drifted"
    info "Fix: update the REST API table and summary lines in structure/server_api.md"
  fi
}

check_websocket_doc() {
  echo ""
  echo -e "${BOLD}📋 3/4 — server_api.md websocket events${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');
const path = require('path');

const doc = fs.readFileSync('structure/server_api.md', 'utf8');

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const actual = new Set();
for (const file of ['server.ts', ...collectTsFiles('src')]) {
  const text = fs.readFileSync(file, 'utf8');
  // The first argument may sit on its own line when the call is wrapped
  // (src/agent/events/helpers.ts), so allow whitespace after the paren.
  for (const match of text.matchAll(/broadcast\(\s*'([^']+)'/g)) {
    actual.add(match[1]);
  }
}

const lines = doc.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === '## WebSocket Events');
if (start === -1) {
  console.error('server_api.md drift: websocket section not found');
  process.exit(1);
}

const docEvents = new Set();
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('## ')) break;
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  const typeCell = cells[0];
  if (!typeCell || typeCell === 'Type' || typeCell.startsWith('-')) continue;
  for (const group of (typeCell.match(/`([^`]+)`/g) || [])) {
    for (const eventName of group.slice(1, -1).split(/\s*\/\s*/)) {
      if (eventName) docEvents.add(eventName);
    }
  }
}

const missing = [...actual].filter((event) => !docEvents.has(event));
const extra = [...docEvents].filter((event) => !actual.has(event));

if (actual.size !== docEvents.size || missing.length || extra.length) {
  console.error('server_api.md websocket drift:');
  console.error(`  counts: doc ${docEvents.size} vs actual ${actual.size}`);
  if (missing.length) {
    console.error('  missing events:');
    for (const event of missing) console.error(`    - ${event}`);
  }
  if (extra.length) {
    console.error('  extra events:');
    for (const event of extra) console.error(`    - ${event}`);
  }
  process.exit(1);
}
NODE
  then
    pass "server_api.md — websocket event list matches live broadcasts"
  else
    fail "server_api.md — websocket event list drifted"
    info "Fix: update the WebSocket Events table in structure/server_api.md"
  fi
}

check_str_func_membership() {
  echo ""
  echo -e "${BOLD}📋 4/4 — str_func.md membership${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [[ ! -f structure/verify-counts.sh ]]; then
    skip "verify-counts.sh — not found"
    return
  fi

  if bash structure/verify-counts.sh >/tmp/check-doc-drift.verify.log 2>&1; then
    pass "verify-counts.sh — all listed paths exist"
  else
    VC_EXIT=$?
    cat /tmp/check-doc-drift.verify.log
    fail "verify-counts.sh — ${VC_EXIT} membership issue(s)"
  fi
  rm -f /tmp/check-doc-drift.verify.log
}

check_commands_doc
check_server_api_doc
check_websocket_doc
check_str_func_membership

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🎉 DOC DRIFT CHECK PASSED — ${PASS} check(s) OK, ${SKIP} skipped${RESET}"
  exit 0
else
  echo -e "  ${RED}${BOLD}💥 DOC DRIFT CHECK FAILED — ${FAIL} issue(s) found${RESET}"
  echo -e "  ${DIM}   ${PASS} passed, ${SKIP} skipped${RESET}"
  echo ""
  echo -e "  ${YELLOW}${BOLD}How to fix:${RESET}"
  echo -e "  ${DIM}  1. Read the ❌ messages above${RESET}"
  echo -e "  ${DIM}  2. Update the docs to match reality${RESET}"
  exit 1
fi
