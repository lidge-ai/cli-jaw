#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + push preview branch
# Auto-detects npm latest, bumps (default patch +1), then appends -preview.TIMESTAMP
# Usage:
#   ./release-preview.sh                 → patch bump (1.6.9 → 1.6.10-preview.*)
#   ./release-preview.sh --minor         → minor bump (1.6.9 → 1.7.0-preview.*)
#   ./release-preview.sh --major         → major bump (1.6.9 → 2.0.0-preview.*)
#   ./release-preview.sh 1.8.0           → explicit base version
#   ./release-preview.sh --require-evidence  → fail if fresh-machine evidence is missing
#                                              (default: warn and continue)
# npm publish is handled by .github/workflows/publish.yml through npm Trusted
# Publishing (OIDC). Desktop artifacts are built and attached by GitHub Actions
# after the GitHub prerelease is published.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh &>/dev/null; then
  echo "❌ gh CLI is required but not found in PATH."
  exit 1
fi

# ─── Flag parsing ──────────────────────────────────────
BUMP_KIND="patch"
REQUIRE_EVIDENCE=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --with-desktop)
      echo "ℹ️  --with-desktop is no longer needed; GitHub Actions builds desktop assets after release publication."
      ;;
    --require-evidence)
      REQUIRE_EVIDENCE=true
      ;;
    --major|major)
      BUMP_KIND="major"
      ;;
    --minor|minor)
      BUMP_KIND="minor"
      ;;
    --patch|patch)
      BUMP_KIND="patch"
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

run_electron_release_checks() {
  echo "🖥️  Checking Electron npm boundary..."
  npm run check:electron-no-native

  echo "🖥️  Type checking Electron shell..."
  npm --prefix electron run typecheck

  echo "🖥️  Building Electron shell..."
  npm --prefix electron run build
}

ELECTRON_RELEASE_NOTES_BASE="### Desktop / Electron
- Electron shell validated with \`npm --prefix electron run typecheck\` and \`npm --prefix electron run build\`.
- npm package boundary validated with \`npm run check:electron-no-native\`; Electron app artifacts remain outside the npm package.
- Desktop app distribution remains separate from \`npm install -g cli-jaw\`.
- macOS, Windows, and Linux desktop assets are built by GitHub Actions after this prerelease is published, then attached to this GitHub Release."

ELECTRON_RELEASE_NOTES_UNSIGNED="
#### ⚠️ Desktop app downloads are unsigned
The desktop assets attached by GitHub Actions are **unsigned** (no Apple Developer ID / Windows code-signing cert configured).

- macOS: Gatekeeper will block first launch. Either right-click → Open → Open, or remove the quarantine attribute:
  \`\`\`sh
  xattr -d com.apple.quarantine /Applications/cli-jaw.app
  \`\`\`
- Windows: SmartScreen will warn on first run. Click \"More info\" → \"Run anyway\".
- Linux: AppImage downloads may need execute permission before launch.
- For trusted distribution, install via \`npm install -g cli-jaw\` instead."

ELECTRON_RELEASE_NOTES="$ELECTRON_RELEASE_NOTES_BASE$ELECTRON_RELEASE_NOTES_UNSIGNED"

# ─── Version detection ─────────────────────────────────
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "")
PKG_VERSION=$(node -p "require('./package.json').version")

max_stable_version() {
  node - "$1" "$2" <<'NODE'
const values = process.argv.slice(2).map((value) => String(value || '0.0.0').replace(/-.*/, ''));
function parts(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}
values.sort((a, b) => {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
});
console.log(values[0]);
NODE
}

# Use the higher stable version from npm latest and package.json. This keeps
# preview releases ahead of npm without moving an ahead checkout backwards.
RAW_VERSION=$(max_stable_version "${NPM_LATEST:-0.0.0}" "$PKG_VERSION")

# Bump per BUMP_KIND so preview > latest in semver
IFS='.' read -r MAJOR MINOR PATCH <<< "$RAW_VERSION"
case "$BUMP_KIND" in
  major) BASE_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) BASE_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) BASE_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

# Allow explicit override: ./release-preview.sh 2.0.0
if [ "${1:-}" != "" ]; then
  BASE_VERSION="$1"
fi

PREID="${PREID:-preview}"
STAMP="${STAMP:-$(date +%Y%m%d%H%M%S)}"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ BASE_VERSION must look like 1.6.10 (got: $BASE_VERSION)"
  exit 1
fi

PREVIEW_VERSION="${BASE_VERSION}-${PREID}.${STAMP}"

echo "🦈 cli-jaw preview release script"
echo "================================="
echo "npm latest:      ${NPM_LATEST:-'(not found)'}"
echo "package.json:    $PKG_VERSION"
echo "Preview version: $PREVIEW_VERSION  (base $RAW_VERSION + $BUMP_KIND bump)"
echo "Dist-tag:        preview"

# ─── Collect changelog from commits since last tag ─────
PREV_TAG=$(set +o pipefail; git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
if [ -n "$PREV_TAG" ]; then
  CHANGELOG=$(git log "$PREV_TAG"..HEAD -n 30 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT=$(git rev-list "$PREV_TAG"..HEAD --count)
else
  CHANGELOG=$(git log --oneline -10 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT="?"
fi

echo ""
echo "📝 Changes since $PREV_TAG ($COMMIT_COUNT commits):"
head -n 10 <<< "$CHANGELOG"
echo ""

# ─── Build ─────────────────────────────────────────────
echo "⬆️  Setting preview version..."
npm version "$PREVIEW_VERSION" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 package.json version: $VERSION"

# The committed Electron version names the desktop artifacts, and
# desktop-release.yml builds from a tag checkout, so the sync has to happen here
# rather than at build time. promote-to-main.sh does the same, for the same
# reason. This also has to run BEFORE gate:all below -- the electron-version
# gate compares the two manifests, and the bump above has just moved the root
# one, so skipping this would fail the preview release outright.
echo "🖥️  Syncing Electron version to $VERSION..."
node scripts/sync-electron-version.cjs

echo "🔎 Type checking..."
# npm, not pnpm. Every other step in this script — build, build:frontend, the
# electron prefix commands, gate:all, pack — runs through npm, CI installs with
# `npm ci`, and promote-to-main.sh never touches pnpm. The lone `pnpm exec` was
# the outlier, and it does not just run a binary: pnpm reconciles the tree
# against pnpm-lock.yaml first, which on a host without node-gyp's toolchain
# fails building better-sqlite3 from source. That happened AFTER the version
# bump and BEFORE the gates, so the release aborted with the working tree
# already carrying a bump and a half-migrated node_modules.
#
# The check itself is not lost: gate:all below runs gate:typecheck, which is
# `tsc --noEmit` over both the server and the frontend project. This line stays
# only to fail fast before the two builds.
npm run typecheck

echo "📦 Building backend..."
npm run build

echo "📦 Building frontend..."
npm run build:frontend

run_electron_release_checks

echo "🛡️  Running release gates (gate:all)..."
npm run gate:all

# The fresh-machine evidence gate is advisory here and enforced with
# --require-evidence. A preview build is the channel you reach for precisely
# when installer changes still need real-machine coverage, so making preview
# stricter had it backwards — it blocked the release that exists to be tested.
#
# The stable path is the strict one: promote-to-main.sh runs the same gate
# unconditionally, so missing evidence fails the promotion rather than the
# preview. Loosening this without tightening that would leave nothing enforcing
# it.
if [ "$REQUIRE_EVIDENCE" = true ]; then
  node scripts/require-release-evidence.mjs
else
  node scripts/require-release-evidence.mjs || echo "⚠️  Evidence gate skipped (pass --require-evidence to enforce)"
fi

echo "🧪 Verifying npm package contents..."
npm pack --dry-run >/dev/null

# ─── Commit + Push ────────────────────────────────────
echo "📝 Creating local commit..."
git add package.json package-lock.json electron/package.json electron/package-lock.json
git commit -m "[agent] chore: preview v$VERSION" --allow-empty

echo "⬆️  Pushing preview branch..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "preview" ]; then
  echo "ℹ️  Current branch is $CURRENT_BRANCH; pushing HEAD to origin/preview."
fi
git fetch origin preview --quiet || true
PREVIEW_LEASE="$(git rev-parse --verify origin/preview 2>/dev/null || true)"
if [ -n "$PREVIEW_LEASE" ]; then
  git push --force-with-lease="refs/heads/preview:$PREVIEW_LEASE" origin HEAD:preview
else
  git push origin HEAD:preview
fi

# ─── Wait for release CI, then dispatch publish ────────
RELEASE_SHA="$(git rev-parse HEAD)"
LIVE_SHA="$(git ls-remote origin refs/heads/preview | cut -f1)"

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" != "$RELEASE_SHA" ]; then
  echo "❌ origin/preview moved after push (expected $RELEASE_SHA, got ${LIVE_SHA:-'(empty)'}). Aborting."
  exit 1
fi

# Printed on every path that gives up before dispatching, so the operator can
# resume the release without reconstructing the command from the workflow file.
publish_dispatch_hint() {
  echo ""
  echo "Resume once the required runs are green:"
  echo "  gh workflow run publish.yml --ref preview \\"
  echo "    -f version=\"$VERSION\" -f tag=preview -f expected-sha=\"$RELEASE_SHA\" -f dry-run=false"
}

# publish.yml refuses to publish without a SUCCESSFUL PUSH run of test.yml for
# this exact SHA -- and, when the installer surface changed, of
# postinstall-platform.yml too. The push above is seconds old, so dispatching
# immediately made the first attempt of every preview release fail by
# construction: v2.4.0-preview (18e6337) needed three dispatches, 10:29:13
# (Tests still running), 10:37:23 (Postinstall still running), 10:38:29 (green).
# So wait for the evidence first, exactly as promote-to-main.sh already does for
# the merged main SHA on the stable path.

# publish.yml derives its range on a fetch-depth: 0 checkout and therefore sees
# every tag. Match that view before deciding below, or a checkout missing the
# newest stable tag answers a different question than the gate will.
git fetch origin --tags --quiet || echo "⚠️  Could not refresh tags; using the local tag list."

# postinstall-platform.yml carries `paths:` filters, so for a SHA that touches
# no installer-sensitive path it never runs at all and waiting for it would burn
# the whole deadline on a run that will never exist. publish.yml decides with
# `require-release-evidence.mjs --changed-files-stdin` over the diff since the
# last stable tag merged into the release SHA, so ask the same detector the same
# question over the same range rather than guessing.
PLATFORM_REQUIRED=false
PREVIOUS_STABLE_TAG="$(git tag --merged "$RELEASE_SHA" --sort=-v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [ -z "$PREVIOUS_STABLE_TAG" ]; then
  echo "ℹ️  No previous stable v* tag; publish.yml treats this as a first release and skips the platform gate."
else
  CHANGED_FILES="$(mktemp)"
  git diff --name-only "$PREVIOUS_STABLE_TAG..$RELEASE_SHA" > "$CHANGED_FILES"
  DETECTOR_STATUS=0
  node scripts/require-release-evidence.mjs --changed-files-stdin < "$CHANGED_FILES" || DETECTOR_STATUS=$?
  rm -f "$CHANGED_FILES"
  case "$DETECTOR_STATUS" in
    0)
      echo "ℹ️  No installer-sensitive changes since $PREVIOUS_STABLE_TAG; platform checks are not required."
      ;;
    1)
      PLATFORM_REQUIRED=true
      ;;
    3)
      echo "ℹ️  Changed files are release-driver extras only; platform checks are not required."
      ;;
    *)
      echo "ERROR: installer-sensitive path detector failed with status $DETECTOR_STATUS" >&2
      publish_dispatch_hint
      exit "$DETECTOR_STATUS"
      ;;
  esac
fi

echo "⏳ Waiting for preview Tests on $RELEASE_SHA..."
deadline=$((SECONDS + 1200))
PREVIEW_TESTS_URL=""
while [ "$SECONDS" -lt "$deadline" ]; do
  PREVIEW_TESTS_URL="$(gh run list \
    --workflow test.yml \
    --branch preview \
    --commit "$RELEASE_SHA" \
    --event push \
    --status success \
    --limit 1 --json url --jq '.[0].url // ""')"
  [ -n "$PREVIEW_TESTS_URL" ] && break
  # An empty result also covers "GitHub has not materialised the run yet", which
  # is the normal state for the first seconds after a push, so keep polling.
  failed="$(gh run list \
    --workflow test.yml \
    --branch preview \
    --commit "$RELEASE_SHA" \
    --event push \
    --status completed \
    --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
  case "$failed" in
    failure|cancelled|timed_out|startup_failure|action_required)
      echo "ERROR: preview Tests completed with $failed" >&2
      publish_dispatch_hint
      exit 1
      ;;
  esac
  sleep 10
done
if [ -z "$PREVIEW_TESTS_URL" ]; then
  echo "ERROR: timed out waiting for successful preview Tests" >&2
  publish_dispatch_hint
  exit 1
fi
echo "✅ Tests: $PREVIEW_TESTS_URL"

if [ "$PLATFORM_REQUIRED" = true ]; then
  echo "⏳ Waiting for preview Postinstall Platform Checks on $RELEASE_SHA..."
  deadline=$((SECONDS + 1200))
  PREVIEW_PLATFORM_URL=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    PREVIEW_PLATFORM_URL="$(gh run list \
      --workflow postinstall-platform.yml \
      --branch preview \
      --commit "$RELEASE_SHA" \
      --event push \
      --status success \
      --limit 1 --json url --jq '.[0].url // ""')"
    [ -n "$PREVIEW_PLATFORM_URL" ] && break
    failed="$(gh run list \
      --workflow postinstall-platform.yml \
      --branch preview \
      --commit "$RELEASE_SHA" \
      --event push \
      --status completed \
      --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
    case "$failed" in
      failure|cancelled|timed_out|startup_failure|action_required)
        echo "ERROR: preview Postinstall Platform Checks completed with $failed" >&2
        publish_dispatch_hint
        exit 1
        ;;
    esac
    sleep 10
  done
  if [ -z "$PREVIEW_PLATFORM_URL" ]; then
    echo "ERROR: timed out waiting for successful preview Postinstall Platform Checks" >&2
    publish_dispatch_hint
    exit 1
  fi
  echo "✅ Postinstall Platform Checks: $PREVIEW_PLATFORM_URL"
fi

LIVE_SHA="$(git ls-remote origin refs/heads/preview | cut -f1)"
if [ "$LIVE_SHA" != "$RELEASE_SHA" ]; then
  echo "ERROR: origin/preview moved while waiting for release CI" >&2
  publish_dispatch_hint
  exit 1
fi

gh workflow run publish.yml --ref preview \
  -f version="$VERSION" -f tag=preview -f expected-sha="$RELEASE_SHA" -f dry-run=false

echo "🚀 publish.yml workflow dispatched for preview v$VERSION (sha $RELEASE_SHA)"

# ─── GitHub Prerelease stub ────────────────────────────
echo "📋 Creating/updating GitHub prerelease stub..."
RELEASE_BODY="## Preview Release v$VERSION

**Base**: $RAW_VERSION → preview patch $BASE_VERSION
**Commits since $PREV_TAG**: $COMMIT_COUNT

### Changes
$CHANGELOG

### Publish
- npm preview publish is dispatched by \`scripts/release-preview.sh\` into \`.github/workflows/publish.yml\` (\`workflow_dispatch\`), pinned to this commit, after preview CI is green.
- npm dist-tag: \`preview\`
- Install after the workflow succeeds: \`npm install -g cli-jaw@preview\`

$ELECTRON_RELEASE_NOTES"

if command -v gh &>/dev/null; then
  if gh release view "v$VERSION" &>/dev/null; then
    gh release edit "v$VERSION" \
      --title "v$VERSION (preview)" \
      --notes "$RELEASE_BODY" \
      --prerelease
    echo "✅ GitHub prerelease v$VERSION updated!"
  else
    gh release create "v$VERSION" \
      --target "$(git rev-parse HEAD)" \
      --title "v$VERSION (preview)" \
      --notes "$RELEASE_BODY" \
      --prerelease
    echo "✅ GitHub prerelease v$VERSION created!"
  fi
  echo "🖥️  Desktop assets will be built by the Desktop Release GitHub Actions workflow."
else
  echo "⚠️  Skipped GitHub prerelease (gh CLI not found)"
fi

echo ""
echo "✅ Preview release queued: cli-jaw@$VERSION"
echo "   Install: npm install -g cli-jaw@preview"
echo "   Exact:   npm install -g cli-jaw@$VERSION"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
echo "   Workflow: https://github.com/lidge-jun/cli-jaw/actions/workflows/publish.yml?query=event%3Aworkflow_dispatch"
