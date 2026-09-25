#!/usr/bin/env bash
# verify-counts.sh — str_func.md 파일 트리 항목의 멤버십(경로 존재) 검증
# Usage: bash structure/verify-counts.sh [--fix]
# --fix is accepted as a no-op for backward compatibility.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Portable matcher: prefer ripgrep, fall back to grep -E when rg is not on PATH.
if ! command -v rg >/dev/null 2>&1; then
  rg() { grep -E "$@"; }
fi

DOC="structure/str_func.md"
FIX=false
if [[ "${1:-}" == "--fix" ]]; then
  FIX=true
  echo "💡 --fix is now a no-op; str_func.md is a membership map with no line counts to repair."
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0

echo -e "${BOLD}📐 str_func.md 멤버십 검증${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ ! -f "$DOC" ]]; then
  echo -e "  ${RED}❌ 문서 없음: $DOC${RESET}"
  exit 1
fi

# Advisory: tracked files under src/bin/lib/public/electron/scripts that have no entry in str_func.md.
advisory_tmp=$(mktemp)
ADVISORY_SET="${ADVISORY_SET:-src bin lib public electron scripts}"
ADVISORY_EXCLUDE="${ADVISORY_EXCLUDE:-public/dist}"

# Build a set of paths that str_func.md already mentions (file-tree entries only).
mentioned_tmp=$(mktemp)
python3 - "$DOC" <<PY > "$mentioned_tmp"
import re, sys
doc = sys.argv[1]
with open(doc, "r", encoding="utf-8") as f:
    text = f.read()
stack = []
mentioned = set()
for raw in text.splitlines():
    m = re.match(r"^([│ ]*)(?:├──|└──)\s+([^←\s]+)", raw)
    if not m:
        continue
    depth = len(m.group(1)) // 4
    name = m.group(2)
    if name.endswith("/"):
        stack[depth:depth+1] = [name[:-1]]
        stack = stack[:depth+1]
        continue
    if "←" not in raw:
        continue
    rel = "/".join([p for p in stack[:depth] + [name] if p])
    mentioned.add(rel)
for p in sorted(mentioned):
    print(p)
PY

for top in $ADVISORY_SET; do
  if [[ ! -d "$top" ]]; then
    continue
  fi
  git ls-files "$top" | while read -r tracked; do
    skip=false
    for ex in $ADVISORY_EXCLUDE; do
      case "$tracked" in
        $ex/*) skip=true; break ;;
      esac
    done
    $skip && continue
    if ! rg -q -Fx "$tracked" "$mentioned_tmp"; then
      echo "$tracked" >> "$advisory_tmp"
    fi
  done
done

# Membership check: every file-tree entry resolves to a real path.
fail_tmp=$(mktemp)
python3 - "$DOC" "$fail_tmp" <<PY
import re, sys, os
doc = sys.argv[1]
fail_path = sys.argv[2]
with open(doc, "r", encoding="utf-8") as f:
    text = f.read()
stack = []
with open(fail_path, "w", encoding="utf-8") as out:
    for i, raw in enumerate(text.splitlines(), start=1):
        m = re.match(r"^([│ ]*)(?:├──|└──)\s+([^←\s]+)", raw)
        if not m:
            continue
        depth = len(m.group(1)) // 4
        name = m.group(2)
        if name.endswith("/"):
            stack[depth:depth+1] = [name[:-1]]
            stack = stack[:depth+1]
            continue
        if "←" not in raw:
            continue
        rel = "/".join([p for p in stack[:depth] + [name] if p])
        if not os.path.exists(rel):
            out.write(f"{rel}\t{i}\n")
        elif os.path.isdir(rel):
            out.write(f"{rel}\t{i}\tdirectory\n")
PY

if [[ -s "$fail_tmp" ]]; then
  while IFS=$'\t' read -r fpath line kind; do
    if [[ "$kind" == "directory" ]]; then
      echo -e "  ${RED}❌ $fpath (line $line) — 트리 항목이 디렉터리를 가리킴${RESET}"
    else
      echo -e "  ${RED}❌ $fpath (line $line) — 경로가 존재하지 않음${RESET}"
    fi
    FAIL=$((FAIL + 1))
  done < "$fail_tmp"
else
  echo -e "  ${GREEN}✅ 파일 트리 항목 — 모두 실제 경로로 존재${RESET}"
  PASS=$((PASS + 1))
fi

if [[ -s "$advisory_tmp" ]]; then
  echo ""
  echo -e "${DIM}📎 advisory: str_func.md 에 미기재된 tracked 파일${RESET}"
  sort -u "$advisory_tmp" | while read -r tracked; do
    echo -e "  ${DIM}   $tracked${RESET}"
  done
fi

rm -f "$fail_tmp" "$advisory_tmp" "$mentioned_tmp"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🎉 ALL PASS — 멤버십 일치${RESET}"
  exit 0
else
  echo -e "  ${RED}${BOLD}💥 MEMBERSHIP CHECK FAILED — ${FAIL} issue(s)${RESET}"
  exit 1
fi
