#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

channel=stable bump='' base='' resume='' require_evidence=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview) channel=preview;;
    --stable) channel=stable;;
    --major|--minor|--patch) [ -z "$bump" ] || { echo 'ERROR: choose one bump' >&2; exit 2; }; bump="${1#--}";;
    --require-evidence) require_evidence=true;;
    --with-desktop) echo 'GitHub Actions builds desktop assets after release publication';;
    --resume) [ "$#" -ge 2 ] || { echo 'ERROR: --resume needs a SHA' >&2; exit 2; }; resume="$2"; shift;;
    [0-9]*.[0-9]*.[0-9]*) [ -z "$base" ] || { echo 'ERROR: duplicate base' >&2; exit 2; }; base="$1";;
    *) echo "Usage: bash scripts/release.sh [--preview] [--major|--minor|--patch|X.Y.Z] [--require-evidence] [--resume SHA]" >&2; exit 2;;
  esac
  shift
done
for tool in git gh node npm jq; do command -v "$tool" >/dev/null || { echo "ERROR: $tool required" >&2; exit 1; }; done
# A clean, current dev checkout keeps unrelated work and stale bases out of releases.
[ -z "$(git status --porcelain)" ] || { echo 'ERROR: dirty worktree' >&2; exit 1; }
gh auth status >/dev/null
git fetch --no-tags --quiet origin +refs/heads/dev:refs/remotes/origin/dev
head_sha="$(git rev-parse HEAD)"
if [ -z "$resume" ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = dev ] || { echo 'ERROR: release must start on dev' >&2; exit 1; }
  [ "$head_sha" = "$(git rev-parse refs/remotes/origin/dev)" ] || { echo 'ERROR: local dev is not origin/dev; pull first' >&2; exit 1; }
else
  [ -z "$bump$base" ] || { echo 'ERROR: --resume cannot change the version' >&2; exit 1; }
  [ "$(git rev-parse "$resume^{commit}")" = "$head_sha" ] || { echo 'ERROR: checkout the release SHA (git switch --detach SHA) before --resume' >&2; exit 1; }
  git merge-base --is-ancestor "$head_sha" refs/remotes/origin/dev || { echo 'ERROR: release SHA is not on origin/dev' >&2; exit 1; }
fi

# Missing package versions are normal; registry failures must never look missing.
npm_view() {
  local value err status
  err="$(mktemp)"
  status=0
  value="$(npm view "$@" 2>"$err")" || status=$?
  if [ "$status" -eq 0 ] && [ -n "$value" ]; then rm -f "$err"; printf '%s' "$value"; return 0; fi
  if [ "$status" -ne 0 ] && grep -q 'E404' "$err"; then rm -f "$err"; return 4; fi
  cat "$err" >&2; rm -f "$err"; echo 'ERROR: npm registry lookup failed' >&2; return 1
}
load_tags() {
  local tags
  tags="$(npm_view cli-jaw dist-tags --json)" || { echo 'ERROR: cannot read dist-tags' >&2; return 1; }
  latest="$(printf '%s' "$tags" | jq -er '.latest | select(type == "string" and length > 0)')" || { echo 'ERROR: missing latest dist-tag' >&2; return 1; }
  preview="$(printf '%s' "$tags" | jq -r '.preview // ""')"
}
assert_unpublished() {
  local result status=0
  result="$(npm_view "cli-jaw@$version" version)" || status=$?
  if [ "$status" -eq 0 ]; then echo "ERROR: cli-jaw@$version already published ($result)" >&2; return 1; fi
  [ "$status" -eq 4 ] || return "$status"
}
# Resolve a new version before mutation; only --resume may reuse a release commit.
load_tags
pkg="$(node -p "require('./package.json').version")"
if [ -n "$resume" ]; then
  version="$pkg"
  subject="$(git log -1 --format=%s)"
  case "$subject" in
    "chore: release v$version") channel=stable;;
    "chore: preview v$version") channel=preview;;
    *) echo 'ERROR: resume requires a matching release commit' >&2; exit 1;;
  esac
  changed="$(git diff-tree --no-commit-id --name-only -r "$head_sha")"
  printf '%s\n' "$changed" | grep -Fxq package.json || { echo 'ERROR: release commit must change package.json' >&2; exit 1; }
  if printf '%s\n' "$changed" | grep -Ev '^(package.json|package-lock.json|electron/package.json|electron/package-lock.json)$' | grep -q .; then echo 'ERROR: release commit contains unrelated files' >&2; exit 1; fi
else
  args=(--channel "$channel" --pkg "$pkg" --npm-latest "$latest")
  [ -z "$bump" ] || args+=(--bump "$bump")
  [ -z "$base" ] || args+=(--base "$base")
  [ "$channel" != preview ] || args+=(--stamp "${STAMP:-$(date +%Y%m%d%H%M%S)}")
  version="$(node scripts/release-version.mjs "${args[@]}")"
fi
assert_unpublished
node scripts/release-version.mjs assert-publishable --channel "$channel" --candidate "$version" --latest "$latest" --preview "$preview"
tag="v$version"
if [ "$channel" = preview ]; then npm_tag=preview; else npm_tag=latest; fi

# Synchronize Electron before gate:all so the release manifests match the package.
if [ -z "$resume" ]; then
  npm version "$version" --no-git-tag-version
  node scripts/sync-electron-version.cjs
  npm run typecheck
  npm run build
  npm run build:frontend
  npm run check:electron-no-native
  npm --prefix electron run typecheck
  npm --prefix electron run build
  npm run gate:all
  npm pack --dry-run >/dev/null
  git add package.json package-lock.json electron/package.json electron/package-lock.json
  git diff --cached --name-only | grep -Fxq package.json || { echo 'ERROR: package.json must change' >&2; exit 1; }
  git commit -m "chore: $([ "$channel" = preview ] && echo preview || echo release) v$version"
  release_sha="$(git rev-parse HEAD)"
  # Recheck the live branch and push without force so concurrent dev work survives.
  live_dev="$(git ls-remote origin refs/heads/dev | cut -f1)"
  [ "$live_dev" = "$head_sha" ] || { echo "ERROR: origin/dev moved; local release commit $release_sha was retained" >&2; exit 1; }
  git push origin HEAD:refs/heads/dev
else
  release_sha="$head_sha"
fi
hint() {
  echo "Resume CI with: bash scripts/release.sh --resume $release_sha" >&2
  echo "If platform CI is missing: git push origin $release_sha:refs/tags/$tag; gh workflow run postinstall-platform.yml --ref $tag" >&2
  echo "After publication, recover with: gh workflow run publish.yml --ref $tag -f version=$version -f tag=$npm_tag -f expected-sha=$release_sha -f dry-run=false -f create-github-release=true" >&2
}
# Bound discovery, not job duration; cancelled runs can coexist with live replacements.
wait_for_run() {
  local workflow="$1" label="$2" url states live failed deadline=$((SECONDS + 1200))
  local -a filters=()
  [ "$workflow" != test.yml ] || filters=(--branch dev --event push)
  while :; do
    url="$(gh run list --workflow "$workflow" --commit "$release_sha" ${filters[@]+"${filters[@]}"} --status success --limit 20 --json url,headSha --jq '.[0].url // ""')"
    [ -z "$url" ] || { echo "$label certified by: $url"; return 0; }
    states="$(gh run list --workflow "$workflow" --commit "$release_sha" ${filters[@]+"${filters[@]}"} --limit 20 --json status,conclusion --jq '.[] | "\(.status) \(.conclusion // "")"')"
    live="$(printf '%s\n' "$states" | grep -cE '^(queued|in_progress|waiting|requested|pending)' || true)"
    failed="$(printf '%s\n' "$states" | grep -m 1 -E '^completed (failure|cancelled|timed_out|startup_failure|action_required)$' || true)"
    if [ "$live" -eq 0 ] && { [ -n "$failed" ] || [ "$SECONDS" -ge "$deadline" ]; }; then echo "ERROR: $label failed or was not found: $failed" >&2; return 1; fi
    sleep 10
  done
}
wait_for_run test.yml Tests || { hint; exit 1; }
wait_for_run postinstall-platform.yml 'Postinstall Platform Checks' || { hint; exit 1; }
# CI evidence must exist before the release evidence gate evaluates this SHA.
if [ "$channel" = stable ] || [ "$require_evidence" = true ]; then
  node scripts/require-release-evidence.mjs --accept-ci-evidence || { hint; exit 1; }
else
  node scripts/require-release-evidence.mjs --accept-ci-evidence || echo 'WARNING: preview evidence unavailable' >&2
fi
# Recheck channel state immediately before dispatch; dev may move while CI runs.
load_tags
assert_unpublished
node scripts/release-version.mjs assert-publishable --channel "$channel" --candidate "$version" --latest "$latest" --preview "$preview"
# Existing tags are reusable only at this SHA; never move an immutable release tag.
local_tag="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)"
remote_tag="$(git ls-remote origin "refs/tags/$tag" | cut -f1)"
[ -z "$local_tag" ] || [ "$local_tag" = "$release_sha" ] || { echo 'ERROR: local tag points elsewhere' >&2; exit 1; }
[ -z "$remote_tag" ] || [ "$remote_tag" = "$release_sha" ] || { echo 'ERROR: remote tag points elsewhere' >&2; exit 1; }
[ -n "$local_tag" ] || git tag "$tag" "$release_sha"
[ -n "$remote_tag" ] || git push origin "refs/tags/$tag"
# A unique ID distinguishes our dispatch from another run for the same commit.
request_id="$(node -e 'console.log(require("node:crypto").randomUUID())')"
gh workflow run publish.yml --ref "$tag" -f "version=$version" -f "tag=$npm_tag" -f "expected-sha=$release_sha" -f dry-run=false -f create-github-release=true -f "request-id=$request_id" || { hint; exit 1; }
# A unique request id distinguishes this run from another dispatch of the same SHA.
deadline=$((SECONDS + 120))
run_id=''
while [ -z "$run_id" ] && [ "$SECONDS" -lt "$deadline" ]; do
  run_id="$(gh run list --workflow publish.yml --event workflow_dispatch --limit 100 --json databaseId,displayTitle,url --jq ".[] | select(.displayTitle | contains(\"$request_id\")) | .databaseId" | head -1)"
  [ -n "$run_id" ] || sleep 5
done
[ -n "$run_id" ] || { echo 'ERROR: publish run not found' >&2; hint; exit 1; }
# A pending publish may be replaced, so wait for this run and report its outcome.
while :; do
  state="$(gh run view "$run_id" --json status,conclusion)"
  status="$(printf '%s' "$state" | jq -r .status)"
  if [ "$status" = completed ]; then
    conclusion="$(printf '%s' "$state" | jq -r .conclusion)"
    [ "$conclusion" = success ] || { echo "ERROR: publish run $run_id concluded $conclusion" >&2; hint; exit 1; }
    break
  fi
  sleep 10
done
echo "Published cli-jaw@$version; npm install -g cli-jaw@$npm_tag"
