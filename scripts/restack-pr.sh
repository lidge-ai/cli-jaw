#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--no-push] [--remote <remote>] [--onto <branch>] [--reviewed-base <sha>] <branch> <old-parent-head>" >&2
  exit 2
}

REMOTE="origin"
ONTO="dev"
NO_PUSH=0
REVIEWED_BASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-push) NO_PUSH=1; shift;;
    --remote) REMOTE="$2"; shift 2;;
    --onto) ONTO="$2"; shift 2;;
    --reviewed-base) REVIEWED_BASE="$2"; shift 2;;
    --help|-h) usage;;
    --*) echo "Unknown option: $1" >&2; usage;;
    *) break;;
  esac
done

if [ $# -ne 2 ]; then usage; fi
BRANCH="$1"
OLD_PARENT_HEAD="$2"

# Require clean worktree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: worktree is not clean" >&2
  exit 1
fi

# Fetch explicit refs; a path remote may not advertise HEAD.
git fetch "$REMOTE" "+refs/heads/*:refs/remotes/restack-pr/*"

REVIEWED_HEAD="$(git rev-parse "restack-pr/${BRANCH}")"

# Never discard local work: a local branch with commits that are not on the
# remote head would be reset by the checkout below.
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  LOCAL_HEAD="$(git rev-parse "refs/heads/${BRANCH}")"
  if ! git merge-base --is-ancestor "$LOCAL_HEAD" "$REVIEWED_HEAD"; then
    echo "ERROR: local ${BRANCH} has commits that are not on ${REMOTE}/${BRANCH}; push or move them first" >&2
    exit 1
  fi
fi

if [ -z "$REVIEWED_BASE" ]; then
  if git merge-base --is-ancestor "$OLD_PARENT_HEAD" "$REVIEWED_HEAD"; then
    REVIEWED_BASE="$OLD_PARENT_HEAD"
  else
    echo "ERROR: branch was rewritten; pass --reviewed-base" >&2
    exit 1
  fi
fi

WANT="$(git diff "$REVIEWED_BASE" "$REVIEWED_HEAD" | git patch-id --stable)"

git checkout -B "$BRANCH" "$REVIEWED_HEAD"

if ! git rebase --onto "restack-pr/${ONTO}" "$REVIEWED_BASE"; then
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  echo "ERROR: rebase conflicts in:" >&2
  echo "$CONFLICTS" >&2
  git rebase --abort
  exit 3
fi

GOT="$(git diff "restack-pr/${ONTO}" HEAD | git patch-id --stable)"

if [ "$WANT" != "$GOT" ]; then
  echo "ERROR: moved diff does not match reviewed diff" >&2
  echo "WANT: $WANT" >&2
  echo "GOT:  $GOT" >&2
  exit 4
fi

if [ "$NO_PUSH" -eq 0 ]; then
  if ! git push --force-with-lease="${BRANCH}:${REVIEWED_HEAD}" "$REMOTE" "HEAD:${BRANCH}"; then
    echo "ERROR: push rejected" >&2
    exit 5
  fi
fi

echo "OK: $BRANCH restacked onto ${REMOTE}/${ONTO}"
