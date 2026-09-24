#!/usr/bin/env bash
# The ci-aggregate decision for .github/workflows/test.yml, kept in a script so
# tests/unit/ci-aggregate-rules.test.ts can drive its truth table. Inputs are the
# producer job results, the change classifier's output and the event name, all
# through env.
#
#   changes must be success and CODE_CHANGED exactly true|false
#   code=true : every producer must be success (a skip is a dropped job, not a pass)
#   code=false: every producer may be success or skipped (docs-only change)
#   windows-unit and macos-unit are never scheduled on pull_request — the PR
#   contract is the minimal Linux set and their evidence lands on the dev push
#   after merge — so on that event alone a skip is the expected state, not a
#   dropped job. On push and workflow_dispatch the normal rule applies.
#   failure, cancelled, empty, or anything unrecognised always fails
set -uo pipefail

failed=0
require_code=""

case "${CHANGES_RESULT:-}" in
  success) echo "PASS  changes: success" ;;
  *)       echo "FAIL  changes: ${CHANGES_RESULT:-<empty>}"; failed=1 ;;
esac

case "${CODE_CHANGED:-}" in
  true|false) require_code="${CODE_CHANGED}"; echo "INFO  changes.outputs.code=${CODE_CHANGED}" ;;
  *)          echo "FAIL  changes.outputs.code was '${CODE_CHANGED:-}', expected true or false"; failed=1 ;;
esac

check() {
  local job="$1" result="$2"
  case "$result" in
    success)
      echo "PASS  $job: success" ;;
    skipped)
      if [ "$require_code" = "false" ]; then
        echo "PASS  $job: skipped (docs-only change)"
      else
        echo "FAIL  $job: skipped although change detection reported code changes"; failed=1
      fi ;;
    failure)   echo "FAIL  $job: failure"; failed=1 ;;
    cancelled) echo "FAIL  $job: cancelled"; failed=1 ;;
    '')        echo "FAIL  $job: no result reported"; failed=1 ;;
    *)         echo "FAIL  $job: unexpected result '$result'"; failed=1 ;;
  esac
}

# The cross-platform lanes are push/dispatch-only by design, so a skipped lane
# on pull_request is the expected shape of a green PR — everywhere else it is
# the same dropped-job signal as any other producer.
check_xplat() {
  local job="$1" result="$2"
  if [ "$result" = "skipped" ] && [ "${EVENT_NAME:-}" = "pull_request" ]; then
    echo "PASS  $job: skipped (cross-platform lanes do not run on pull_request)"
    return
  fi
  check "$job" "$result"
}

check test         "${TEST_RESULT:-}"
check integration  "${INTEGRATION_RESULT:-}"
check gates        "${GATES_RESULT:-}"
check_xplat windows-unit "${WINDOWS_UNIT_RESULT:-}"
check_xplat macos-unit   "${MACOS_UNIT_RESULT:-}"

if [ "$failed" -ne 0 ]; then
  echo "::error::ci-aggregate failed — see the per-job results above"
  exit 1
fi
echo "ci-aggregate: all required jobs succeeded or were legitimately skipped"
