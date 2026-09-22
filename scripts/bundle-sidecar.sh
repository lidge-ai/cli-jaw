#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo 'Usage: bundle-sidecar.sh <platform> <arch>' >&2
  exit 1
fi
PLATFORM="$1"
ARCH="$2"
NODE_VERSION="24.17.0"
case "$PLATFORM-$ARCH" in
  darwin-arm64|darwin-x64|linux-x64) NODE_PKG="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}" ;;
  win32-x64) NODE_PKG="node-v${NODE_VERSION}-win-x64" ;;
  *) echo "Unsupported: $PLATFORM-$ARCH" >&2; exit 1 ;;
esac
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUTPUT_PARENT="$PROJECT_ROOT/electron/sidecar"
OUTPUT="$OUTPUT_PARENT/server"
LOCK="$OUTPUT_PARENT/.server-build.lock"
BUILD_ROOT=""
EXTRACT_ROOT=""

# Filesystem/provenance boundary only; no application imports or test-mode branch.
# Format 1 is exact: generator/state/target/nodeVersion/packageVersion/invocation,
# sourceSha256 and payloadSha256. Digests include bytes, names, modes and links;
# the payload excludes only its top-level owner receipt. No absolute paths/secrets.
transaction() {
  node --input-type=commonjs - "$@" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [op, projectArg, platform, arch, nodeVersion, ...args] = process.argv.slice(2);
const project = path.resolve(projectArg);
const parent = path.join(project, 'electron/sidecar'), output = path.join(parent, 'server');
const lock = path.join(parent, '.server-build.lock'), receipt = '.jaw-sidecar-build.json';
const fail = message => { throw new Error(message); };
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const realDir = p => {
  if (!fs.lstatSync(p).isDirectory() || fs.realpathSync(p) !== p) fail('Refusing non-real directory: ' + p);
};
const regular = p => { if (!fs.lstatSync(p).isFile()) fail('Expected regular file: ' + p); };
const digest = (root, skip = () => false) => {
  const hash = crypto.createHash('sha256');
  const walk = rel => {
    if (skip(rel)) return;
    const p = path.join(root, rel), s = fs.lstatSync(p);
    hash.update(JSON.stringify([rel, s.mode & 0o777, s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file', s.isFile() ? s.size : 0]));
    if (s.isSymbolicLink()) {
      const resolved = fs.realpathSync(p);
      if (!resolved.startsWith(root + path.sep)) fail('Escaping symlink: ' + rel);
      hash.update(fs.readlinkSync(p));
    } else if (s.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) walk(path.join(rel, name));
    } else if (s.isFile()) hash.update(fs.readFileSync(p));
    else fail('Unsupported filesystem entry: ' + rel);
  };
  walk(''); return hash.digest('hex');
};
const identity = p => { const s = fs.lstatSync(p); return `${s.dev}:${s.ino}`; };
const payload = root => digest(root, rel => rel === receipt);
// Only the two top-level completion files may be added after smoke. The final
// payload seal above still includes the install receipt; nested names are data.
const runtimePayload = root => digest(root, rel => rel === receipt || rel === '.jaw-install-state.json');
const validReceipt = root => {
  realDir(root); regular(path.join(root, receipt));
  if (fs.statSync(path.join(root, receipt)).size > 16 * 1024) fail('Oversized output receipt');
  const r = JSON.parse(fs.readFileSync(path.join(root, receipt), 'utf8'));
  const keys = ['format', 'generator', 'state', 'target', 'nodeVersion', 'packageVersion', 'invocation', 'sourceSha256', 'payloadSha256'];
  if (Object.keys(r).sort().join() !== keys.sort().join() || r.format !== 1 ||
      r.generator !== 'scripts/bundle-sidecar.sh' || r.state !== 'completed' ||
      r.target !== `${platform}-${arch}` || r.nodeVersion !== nodeVersion ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.invocation) ||
      !/^[0-9a-f]{64}$/.test(r.sourceSha256) || !/^[0-9a-f]{64}$/.test(r.payloadSha256)) fail('Unrecognized output receipt');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const install = JSON.parse(fs.readFileSync(path.join(root, '.jaw-install-state.json'), 'utf8'));
  if (pkg.version !== r.packageVersion || install.state !== 'completed' || install.sidecar !== true ||
      install.packageVersion !== pkg.version || install.platform !== platform || install.arch !== arch ||
      install.node !== 'v' + nodeVersion || payload(root) !== r.payloadSha256) fail('Output provenance mismatch');
  regular(path.join(root, 'package-lock.json'));
  regular(path.join(root, platform === 'win32' ? 'node.exe' : 'node'));
  return { identity: identity(root), receipt: r };
};
const sourceNames = (base = project) => fs.readdirSync(base).filter(n =>
  ['src', 'lib', 'bin', 'scripts', 'prompts', 'types', 'public', 'server.ts', 'package.json', 'package-lock.json', 'vite.config.ts'].includes(n) || /^tsconfig.*\.json$/.test(n)).sort();
const sourceHash = (base = project) => {
  const hash = crypto.createHash('sha256');
  const walk = rel => {
    if (rel === path.join('public', 'dist')) return;
    const p = path.join(base, rel), s = fs.lstatSync(p);
    hash.update(JSON.stringify([rel, s.mode & 0o777, s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file', s.isFile() ? s.size : 0]));
    if (s.isSymbolicLink()) {
      const text = fs.readlinkSync(p);
      const inside = candidate => candidate === base || candidate.startsWith(base + path.sep);
      if (path.isAbsolute(text) || !inside(path.resolve(path.dirname(p), text)))
        fail('Source link must be relative and lexically internal: ' + rel);
      let resolved;
      try { resolved = fs.realpathSync(p); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (resolved !== undefined && !inside(resolved)) fail('Source link realpath escapes: ' + rel);
      // Installed-prefix launcher aliases can be internally dangling. Hash the
      // link itself, never traverse it; required inputs still face build gates.
      hash.update(JSON.stringify(text));
    } else if (s.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(rel, name));
    else if (s.isFile()) hash.update(fs.readFileSync(p));
    else fail('Unsupported source entry');
  };
  for (const name of sourceNames(base)) walk(name);
  return hash.digest('hex');
};
const preflight = () => {
  if (process.platform !== platform || process.arch !== arch) fail('Target must match host');
  realDir(project); realDir(path.join(project, 'electron')); realDir(parent);
  regular(path.join(project, 'package.json')); regular(path.join(project, 'package-lock.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  const locked = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
      ![2, 3].includes(locked.lockfileVersion) || locked.packages?.['']?.version !== pkg.version ||
      locked.packages?.['']?.name !== pkg.name) fail('Invalid or mismatched lockfile');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const sorted = value => JSON.stringify(Object.entries(value || {}).sort());
    if (sorted(pkg[key]) !== sorted(locked.packages[''][key])) fail('Mismatched locked dependencies');
  }
  if (exists(output)) validReceipt(output);
};
if (op === 'preflight') {
  preflight();
  const tmp = fs.realpathSync(args[0]); realDir(tmp);
  process.stdout.write(tmp.replaceAll('\\', '/')); // Git Bash and POSIX shell path.
} else if (op === 'acquire') {
  preflight(); // Repeat under the shell's exclusive lock before snapshotting output.
  realDir(lock);
  const state = { invocation: crypto.randomUUID(), lock: identity(lock), parent: identity(parent),
    previous: exists(output) ? validReceipt(output) : null, sourceSha256: sourceHash() };
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(state), { flag: 'wx' });
} else {
  const state = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  realDir(parent); realDir(lock);
  if (identity(parent) !== state.parent || identity(lock) !== state.lock) fail('Transaction ownership changed');
  const [build, extract] = args.map(p => path.resolve(p));
  realDir(build); realDir(extract);
  if (op === 'snapshot') {
    state.build = identity(build); state.extract = identity(extract);
    fs.mkdirSync(path.join(build, 'source'));
    fs.mkdirSync(path.join(build, 'server'));
    fs.mkdirSync(path.join(build, 'server/bin'));
    state.stage = identity(path.join(build, 'server'));
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(state));
    for (const name of sourceNames()) fs.cpSync(path.join(project, name), path.join(build, 'source', name), {
      recursive: true, dereference: false, verbatimSymlinks: true,
      filter: p => p !== path.join(project, 'public/dist'),
    });
    if (sourceHash() !== state.sourceSha256 || sourceHash(path.join(build, 'source')) !== state.sourceSha256)
      fail('Source changed during snapshot');
  } else {
    if (identity(build) !== state.build || identity(extract) !== state.extract) fail('Scratch ownership changed');
    const stage = path.join(build, 'server');
    if (op !== 'cleanup') {
      realDir(stage);
      if (identity(stage) !== state.stage) fail('Staging ownership changed');
    }
    if (op === 'dependencies') {
      realDir(path.join(stage, 'node_modules'));
      payload(stage); // Reject escaping dependency/scope links before literal rm expressions.
    } else if (op === 'extracted') {
      const pkg = `node-v${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`;
      const binary = platform === 'win32' ? path.join(extract, pkg, 'node.exe') : path.join(extract, pkg, 'bin/node');
      realDir(path.dirname(binary)); regular(binary);
      if (fs.realpathSync(binary) !== binary) fail('Extracted Node must be a real file');
    } else if (op === 'capture') {
      if (Object.hasOwn(state, 'runtimePayloadSha256')) fail('Runtime payload already captured');
      if (exists(path.join(stage, receipt)) || exists(path.join(stage, '.jaw-install-state.json')))
        fail('Completion metadata exists before smoke');
      state.runtimePayloadSha256 = runtimePayload(stage);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(state));
    } else if (op === 'gated' || op === 'complete') {
      if (sourceHash() !== state.sourceSha256) fail('Source changed during build');
      realDir(stage);
      regular(path.join(build, 'smoke-report.json'));
      if (typeof state.runtimePayloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(state.runtimePayloadSha256))
        fail('Missing or invalid runtime payload capture');
      if (runtimePayload(stage) !== state.runtimePayloadSha256) fail('Runtime payload changed after capture');
      if (op === 'gated') process.exit(0);
      const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(stage, receipt), JSON.stringify({ format: 1,
        generator: 'scripts/bundle-sidecar.sh', state: 'completed', target: `${platform}-${arch}`,
        nodeVersion, packageVersion: pkg.version, invocation: state.invocation,
        sourceSha256: state.sourceSha256, payloadSha256: payload(stage) }, null, 2), { flag: 'wx' });
      validReceipt(stage);
    } else if (op === 'promote') {
      if (sourceHash() !== state.sourceSha256) fail('Source changed before promotion');
      validReceipt(stage);
      if (state.previous) {
        const current = validReceipt(output);
        if (JSON.stringify(current) !== JSON.stringify(state.previous)) fail('Previous output changed');
        const backup = path.join(build, 'previous-server');
        if (exists(backup)) fail('Backup destination occupied');
        fs.renameSync(output, backup);
      } else if (exists(output)) fail('Unknown output appeared');
      // rename never merges into a destination directory (unlike shell mv).
      // A failure intentionally retains previous-server, stage, evidence and lock.
      if (exists(output)) fail('Promotion destination occupied');
      fs.renameSync(stage, output);
    } else if (op === 'cleanup') {
      // Keep build root/report/backup as recovery evidence; clean extraction only.
      const entries = (dir, expected) => {
        realDir(dir);
        if (fs.readdirSync(dir).sort().join() !== expected.sort().join()) fail('Unknown cleanup contents: ' + dir);
      };
      const pkg = `node-v${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`;
      entries(lock, ['owner.json']);
      entries(extract, [pkg, platform === 'win32' ? 'node.zip' : 'node.tar.gz']);
      entries(path.join(extract, pkg), [platform === 'win32' ? 'node.exe' : 'bin']);
      if (platform !== 'win32') entries(path.join(extract, pkg, 'bin'), ['node']);
      regular(path.join(extract, platform === 'win32' ? 'node.zip' : 'node.tar.gz'));
      regular(path.join(extract, pkg, platform === 'win32' ? 'node.exe' : 'bin/node'));
      const backup = path.join(build, 'previous-server');
      if (state.previous && JSON.stringify(validReceipt(backup)) !== JSON.stringify(state.previous))
        fail('Previous backup changed');
      fs.rmSync(extract, { recursive: true });
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock); // Unknown lock entries are never recursively deleted.
      if (state.previous) console.log('Previous output retained: ' + backup);
    } else fail('Unknown transaction operation');
  }
}
JS
}

install_locked_production_dependencies() {
  npm ci --omit=dev --ignore-scripts
}

retain() {
  status=$?
  trap - EXIT HUP INT TERM
  echo "Build retained (exit $status); supervisor must prove quiescence before recovery:" >&2
  printf '  build=%s\n  extract=%s\n  lock=%s\n' "$BUILD_ROOT" "$EXTRACT_ROOT" "$LOCK" >&2
  exit "$status"
}
TMP_ROOT="$(transaction preflight "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "${TMPDIR:-/tmp}")"
# Do not adopt/break existing locks, even if they look stale or contain a PID.
mkdir "$LOCK" || { echo "Output locked: $LOCK" >&2; exit 1; }
trap retain EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
transaction acquire "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION"
BUILD_ROOT="$(mktemp -d "$OUTPUT_PARENT/.server-build.XXXXXXXX")"
EXTRACT_ROOT="$(mktemp -d "$TMP_ROOT/jaw-sidecar-extract.XXXXXXXX")"
transaction snapshot "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
SOURCE_ROOT="$BUILD_ROOT/source"
SIDECAR_DIR="$BUILD_ROOT/server"
echo "=== Bundling sidecar: $PLATFORM-$ARCH ==="

# Refuse to build a sidecar whose prune list would strip a runtime dependency.
# Failing here costs a few seconds; failing later costs a shipped app that dies
# on first use, which is exactly what happened with node-fetch.
node "$PROJECT_ROOT/scripts/check-sidecar-prune-safety.mjs"

NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

echo "Downloading Node.js $NODE_VERSION ($PLATFORM-$ARCH)..."
if [[ "$PLATFORM" == "win32" ]]; then
  curl --connect-timeout 30 --max-time 300 -fsSL "$NODE_URL/${NODE_PKG}.zip" -o "$EXTRACT_ROOT/node.zip"
  unzip -qo "$EXTRACT_ROOT/node.zip" "${NODE_PKG}/node.exe" -d "$EXTRACT_ROOT"
  transaction extracted "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
  cp "$EXTRACT_ROOT/${NODE_PKG}/node.exe" "$SIDECAR_DIR/node.exe"
else
  curl --connect-timeout 30 --max-time 300 -fsSL "$NODE_URL/${NODE_PKG}.tar.gz" -o "$EXTRACT_ROOT/node.tar.gz"
  tar -xz -f "$EXTRACT_ROOT/node.tar.gz" -C "$EXTRACT_ROOT" "${NODE_PKG}/bin/node"
  transaction extracted "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
  cp "$EXTRACT_ROOT/${NODE_PKG}/bin/node" "$SIDECAR_DIR/node"
  chmod +x "$SIDECAR_DIR/node"
fi

echo "Building project..."
cd "$SOURCE_ROOT"
npm ci --include=dev --ignore-scripts
# Explicit build only: prebuild/postbuild include native/global-link side effects.
npm run build --ignore-scripts
# Restore the safe postbuild gate explicitly; never run the global-link hook.
bash scripts/verify-dist-assets.sh
npm run build:frontend --ignore-scripts
node "$SOURCE_ROOT/scripts/check-sidecar-prune-safety.mjs"

echo "Copying server artifacts..."
cp -r dist "$SIDECAR_DIR/dist"
cp -r public "$SIDECAR_DIR/public"
cp package.json "$SIDECAR_DIR/package.json"
cp package-lock.json "$SIDECAR_DIR/package-lock.json"

echo "Installing production dependencies..."
cd "$SIDECAR_DIR"
install_locked_production_dependencies
transaction dependencies "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"

echo "Pruning frontend-only dependencies..."
# Every entry here is deleted from the bundled sidecar, so a package the server
# imports must never appear. It did: node-fetch sat in this list from the commit
# that created this script while src/telegram/bot.ts imports it, and every
# packaged desktop app died with ERR_MODULE_NOT_FOUND the moment that module
# loaded. check-sidecar-prune-safety.mjs now fails the build when this list and
# the server's real imports disagree.
PRUNE_PKGS=(
  "@codemirror/autocomplete" "@codemirror/lang-markdown" "@codemirror/language"
  "@codemirror/language-data" "@codemirror/state" "@codemirror/view"
  "@lezer/highlight" "@lucide/icons" "@milkdown/kit" "@replit/codemirror-vim"
  "@tanstack/virtual-core" "@uiw/react-codemirror" "@xterm/addon-fit" "@xterm/xterm"
  "d3" "dompurify" "katex" "marked-highlight" "mermaid"
  "react" "react-dom" "react-markdown" "rehype-katex" "rehype-sanitize"
  "remark-breaks" "remark-gfm" "remark-math"
)
for pkg in "${PRUNE_PKGS[@]}"; do
  rm -rf "$SIDECAR_DIR/node_modules/$pkg" 2>/dev/null || true
done
# Remove transitive-only packages (types, build tools)
rm -rf "$SIDECAR_DIR/node_modules/typescript" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@types" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@babel" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@vue" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/cytoscape" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/cytoscape-fcose" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/es-toolkit" 2>/dev/null || true

echo "Removing stale .bin symlinks after dependency pruning..."
find "$SIDECAR_DIR/node_modules/.bin" -type l ! -exec test -e {} \; -print -delete 2>/dev/null || true

NODE_BIN="$SIDECAR_DIR/node"
if [[ "$PLATFORM" == "win32" ]]; then
  NODE_BIN="$SIDECAR_DIR/node.exe"
fi

PYTHON_BIN="${PYTHON:-}"
if [ -z "$PYTHON_BIN" ] && [ -x /usr/bin/python3 ]; then
  PYTHON_BIN="/usr/bin/python3"
fi
if [ -z "$PYTHON_BIN" ] && command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3.11)"
fi
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi

echo "Rebuilding better-sqlite3 for bundled Node $NODE_VERSION..."
while IFS= read -r pkg_json; do
  pkg_dir="$(dirname "$pkg_json")"
  # better-sqlite3 >= 13 is Node-API: it ships prebuilds/ inside the package,
  # has NO scripts.install (`npm run install` dies with "Missing script"), and
  # the prebuild is ABI-independent, so no per-Node rebuild is needed at all.
  # v12 keeps the old install script ("prebuild-install || node-gyp rebuild").
  # The verification step below opens the DB with the bundled Node either way.
  has_install_script="$("$NODE_BIN" -e 'const p=require(process.argv[1]);process.stdout.write(p.scripts&&p.scripts.install?"yes":"no")' "$pkg_json")"
  if [ "$has_install_script" = "no" ]; then
    echo "  skip rebuild (v13+ bundled prebuilds): ${pkg_dir#$SIDECAR_DIR/}"
    continue
  fi
  echo "  rebuild: ${pkg_dir#$SIDECAR_DIR/}"
  (
    cd "$pkg_dir"
    PYTHON="$PYTHON_BIN" \
    npm_config_python="$PYTHON_BIN" \
    npm_config_runtime=node \
    npm_config_target="$NODE_VERSION" \
    npm_config_disturl="https://nodejs.org/dist" \
    npm_config_build_from_source=true \
      npm run install --foreground-scripts
  )
done < <(find "$SIDECAR_DIR/node_modules" -path '*/better-sqlite3/package.json' -print | sort)

echo "Verifying better-sqlite3 opens with bundled Node..."
"$NODE_BIN" -e "const Database = require('better-sqlite3'); new Database(':memory:').close()" && echo "  better-sqlite3 OK" || {
  echo "  bundled prebuild failed to load — building from source (v13 build-release)..."
  sidecar_bsql_dir="$SIDECAR_DIR/node_modules/better-sqlite3"
  if [ -d "$sidecar_bsql_dir" ]; then
    (
      cd "$sidecar_bsql_dir"
      PYTHON="$PYTHON_BIN" \
      npm_config_python="$PYTHON_BIN" \
      npm_config_runtime=node \
      npm_config_target="$NODE_VERSION" \
      npm_config_disturl="https://nodejs.org/dist" \
        npm run build-release --foreground-scripts
    )
  fi
  "$NODE_BIN" -e "const Database = require('better-sqlite3'); new Database(':memory:').close()" && echo "  better-sqlite3 OK (source build)" || {
    echo "ERROR: better-sqlite3 failed to open with bundled Node"
    exit 1
  }
}

echo "Creating CLI shims..."
if [[ "$PLATFORM" == "win32" ]]; then
  cat > "$SIDECAR_DIR/bin/jaw.cmd" << 'SHIM'
@echo off
set "DIR=%~dp0.."
"%DIR%\node.exe" "%DIR%\dist\bin\cli-jaw.js" %*
SHIM
else
  cat > "$SIDECAR_DIR/bin/jaw" << 'SHIM'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node" "$DIR/dist/bin/cli-jaw.js" "$@"
SHIM
  chmod +x "$SIDECAR_DIR/bin/jaw"
fi

node "$SOURCE_ROOT/scripts/check-electron-sidecar-no-jwc.cjs" --server-root "$SIDECAR_DIR"

# Static prune analysis runs before the build; this runs after, on the artifact
# that will actually ship. The prune guard reasons about bare specifiers and
# cannot see a computed `import(spec)`, so it can only ever be as complete as
# its manual RUNTIME_LOADED list. Importing the critical modules for real
# closes that gap by construction — a dashboard returning 200 never proved the
# Telegram bot could load.
transaction capture "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
node "$SOURCE_ROOT/scripts/check-sidecar-smoke.mjs" --server-root "$SIDECAR_DIR" --report "$BUILD_ROOT/smoke-report.json"
transaction gated "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"

# Sidecar install-state receipt. The sidecar is deliberately built with
# --ignore-scripts, so postinstall-guard never runs here and its receipt would
# be absent — which the runtime integrity check would misread as a blocked
# install and nag every desktop user. This is a controlled build: writing the
# receipt ourselves, with the sidecar's own package version, is the honest
# record of what happened.
echo "Writing sidecar install-state receipt..."
"$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(root, ".jaw-install-state.json"), JSON.stringify({
  schema: 1,
  state: "completed",
  sidecar: true,
  packageVersion,
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
}, null, 2), { flag: "wx" });
' "$SIDECAR_DIR"

# Windows refuses to rename a directory while the parent Git Bash process has
# that directory as its cwd. Leave staging before the atomic promotion.
cd "$PROJECT_ROOT"
transaction complete "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
transaction promote "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
transaction cleanup "$PROJECT_ROOT" "$PLATFORM" "$ARCH" "$NODE_VERSION" "$BUILD_ROOT" "$EXTRACT_ROOT"
trap - EXIT HUP INT TERM
echo "=== Sidecar ready ==="
echo "Build evidence retained: $BUILD_ROOT"
du -sh "$OUTPUT"
