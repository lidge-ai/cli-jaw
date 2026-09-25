#!/usr/bin/env bash
# Collect fresh-machine install evidence for supported CLI-JAW targets.
set -uo pipefail

TARGET="auto"
SKIP_INSTALL=0
SKIP_DOCTOR=0
OUT_DIR=""
INSTALL_SCRIPT="${CLI_JAW_INSTALL_SCRIPT:-}"
VERIFIER_SCRIPT="${CLI_JAW_VERIFIER_SCRIPT:-}"
INSTALL_REF="${CLI_JAW_INSTALL_REF:-main}"
RAW_BASE="${CLI_JAW_RAW_BASE:-https://raw.githubusercontent.com/lidge-ai/cli-jaw/${INSTALL_REF}}"
FAILURES=0

usage() {
  cat <<'USAGE'
Usage: collect-fresh-install-evidence.sh [options]

Options:
  --target macos|wsl|linux|auto   Target to verify. Default: auto.
  --skip-install                  Do not run the one-click installer; only collect and verify.
  --skip-doctor                   Pass --skip-doctor to verify-fresh-install.sh.
  --out-dir DIR                   Evidence output directory.
  --install-script FILE           Local installer path override for the selected target.
  --verifier-script FILE          Local verifier path override.
  --install-ref REF               Git ref for raw.githubusercontent.com installer fetches.
  --raw-base URL                  Override raw script base URL.
  -h, --help                      Show this help.

Environment:
  CLI_JAW_INSTALL_SCRIPT          Default local installer path when --install-script is omitted.
  CLI_JAW_VERIFIER_SCRIPT         Default local verifier path when --verifier-script is omitted.
  CLI_JAW_INSTALL_REF             Default git ref when --install-ref is omitted.
  CLI_JAW_RAW_BASE                Default raw base URL when --raw-base is omitted.
  CLI_JAW_EVIDENCE_DIR            Default output directory when --out-dir is omitted.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || { echo "Missing value for --target" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-doctor)
      SKIP_DOCTOR=1
      shift
      ;;
    --out-dir)
      [ "$#" -ge 2 ] || { echo "Missing value for --out-dir" >&2; exit 2; }
      OUT_DIR="$2"
      shift 2
      ;;
    --install-script)
      [ "$#" -ge 2 ] || { echo "Missing value for --install-script" >&2; exit 2; }
      INSTALL_SCRIPT="$2"
      shift 2
      ;;
    --verifier-script)
      [ "$#" -ge 2 ] || { echo "Missing value for --verifier-script" >&2; exit 2; }
      VERIFIER_SCRIPT="$2"
      shift 2
      ;;
    --install-ref)
      [ "$#" -ge 2 ] || { echo "Missing value for --install-ref" >&2; exit 2; }
      INSTALL_REF="$2"
      RAW_BASE="https://raw.githubusercontent.com/lidge-ai/cli-jaw/${INSTALL_REF}"
      shift 2
      ;;
    --raw-base)
      [ "$#" -ge 2 ] || { echo "Missing value for --raw-base" >&2; exit 2; }
      RAW_BASE="${2%/}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

detect_target() {
  local kernel
  kernel="$(uname -s 2>/dev/null || true)"
  case "$kernel" in
    Darwin) echo "macos" ;;
    Linux)
      if grep -qiE "microsoft|wsl" /proc/version /proc/sys/kernel/osrelease 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "native-windows"
      ;;
    *)
      echo "unsupported"
      ;;
  esac
}

if [ "$TARGET" = "auto" ]; then
  TARGET="$(detect_target)"
fi

case "$TARGET" in
  macos|wsl|linux) ;;
  native-windows)
    echo "Native Windows/Git Bash is not a supported CLI-JAW install target. Use WSL." >&2
    exit 2
    ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    exit 2
    ;;
esac

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="${CLI_JAW_EVIDENCE_DIR:-$HOME/cli-jaw-fresh-install-evidence-$(date -u +%Y%m%d-%H%M%S)}"
fi
mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.txt"
: > "$SUMMARY"

record() {
  printf '%s %s\n' "$(now_utc)" "$*" >> "$SUMMARY"
}

file_sha256() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$file" | awk '{print $1}'
    return 0
  fi
  return 1
}

archive_local_script() {
  local label="$1"
  local source="$2"
  local dest="$3"

  cp "$source" "$dest"
  chmod +x "$dest" 2>/dev/null || true
  local digest
  digest="$(file_sha256 "$dest" 2>/dev/null || true)"
  record "SCRIPT label=\"$label\" source=\"$source\" file=\"$dest\" sha256=\"$digest\""
}

archive_remote_script() {
  local label="$1"
  local url="$2"
  local dest="$3"

  curl -fsSL -o "$dest" "$url"
  chmod +x "$dest" 2>/dev/null || true
  local digest
  digest="$(file_sha256 "$dest" 2>/dev/null || true)"
  record "SCRIPT label=\"$label\" source=\"$url\" file=\"$dest\" sha256=\"$digest\""
}

archive_collector_script() {
  local source="${BASH_SOURCE[0]:-}"
  local archived_collector="$OUT_DIR/00-collector-script.sh"

  if [ -n "$source" ] && [ -f "$source" ]; then
    archive_local_script "collector" "$source" "$archived_collector"
    return 0
  fi

  record "WARN collector script source is not a readable file; download the collector before running it for release evidence"
  echo "warning: collector script source is not a readable file; release audit will require $archived_collector" >&2
}

record "target=$TARGET"
record "raw_base=$RAW_BASE"
record "install_script=$INSTALL_SCRIPT"
record "verifier_script=$VERIFIER_SCRIPT"
record "skip_install=$SKIP_INSTALL"
record "skip_doctor=$SKIP_DOCTOR"
record "out_dir=$OUT_DIR"

run_logged() {
  local label="$1"
  local logfile="$2"
  shift 2

  echo
  echo "== $label =="
  record "RUN label=\"$label\" log=\"$logfile\" command=\"$*\""
  "$@" 2>&1 | tee "$logfile"
  local status=${PIPESTATUS[0]}
  record "DONE label=\"$label\" status=$status"
  if [ "$status" -ne 0 ]; then
    FAILURES=$((FAILURES + 1))
    echo "!! $label failed with exit $status"
  fi
  return "$status"
}

run_shell_logged() {
  local label="$1"
  local logfile="$2"
  local command="$3"

  echo
  echo "== $label =="
  record "RUN label=\"$label\" log=\"$logfile\" shell=\"bash -lc\" command=\"$command\""
  bash -lc "$command" 2>&1 | tee "$logfile"
  local status=${PIPESTATUS[0]}
  record "DONE label=\"$label\" status=$status"
  if [ "$status" -ne 0 ]; then
    FAILURES=$((FAILURES + 1))
    echo "!! $label failed with exit $status"
  fi
  return "$status"
}

run_optional_logged() {
  local label="$1"
  local logfile="$2"
  shift 2

  echo
  echo "== $label =="
  record "RUN optional label=\"$label\" log=\"$logfile\" command=\"$*\""
  "$@" 2>&1 | tee "$logfile"
  local status=${PIPESTATUS[0]}
  record "DONE optional label=\"$label\" status=$status"
  if [ "$status" -ne 0 ]; then
    echo "!! optional $label failed with exit $status"
  fi
  return 0
}

run_optional_shell_logged() {
  local label="$1"
  local logfile="$2"
  local command="$3"

  echo
  echo "== $label =="
  record "RUN optional label=\"$label\" log=\"$logfile\" shell=\"bash -lc\" command=\"$command\""
  bash -lc "$command" 2>&1 | tee "$logfile"
  local status=${PIPESTATUS[0]}
  record "DONE optional label=\"$label\" status=$status"
  if [ "$status" -ne 0 ]; then
    echo "!! optional $label failed with exit $status"
  fi
  return 0
}

collect_snapshot() {
  local label="$1"
  local file="$2"
  {
    echo "label=$label"
    echo "timestamp_utc=$(now_utc)"
    echo "target=$TARGET"
    echo "uname=$(uname -a 2>/dev/null || true)"
    if command -v sw_vers >/dev/null 2>&1; then
      sw_vers
    fi
    echo "shell=${SHELL:-}"
    echo "home=$HOME"
    echo "zdotdir=${ZDOTDIR:-}"
    echo "path=${PATH:-}"
    if command -v xcode-select >/dev/null 2>&1; then
      echo "xcode_select=$(xcode-select -p 2>&1 || true)"
    fi
    if [ -r /etc/os-release ]; then
      sed -n '1,20p' /etc/os-release
    fi
    for cmd in zsh bash git curl node npm nvm cargo rustc jaw cli-jaw claude codex gemini grok opencode copilot officecli powershell.exe wsl.exe; do
      if command -v "$cmd" >/dev/null 2>&1; then
        echo "$cmd=$(command -v "$cmd")"
      else
        echo "$cmd=missing"
      fi
    done
  } > "$file" 2>&1
  echo "snapshot: $file"
  record "SNAPSHOT label=\"$label\" file=\"$file\""
}

refresh_runtime_paths() {
  export PATH="$HOME/.local/bin:${PATH:-}"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi
  if command -v nvm >/dev/null 2>&1; then
    nvm use default >/dev/null 2>&1 || nvm use 22 >/dev/null 2>&1 || true
  fi
  if command -v npm >/dev/null 2>&1; then
    local npm_prefix
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$npm_prefix" ] && [ -d "${npm_prefix%/}/bin" ]; then
      export PATH="${npm_prefix%/}/bin:$PATH"
    fi
  fi
}

local_verifier_for_install_script() {
  if [ -z "$INSTALL_SCRIPT" ]; then
    return 1
  fi

  local install_dir
  install_dir="$(dirname "$INSTALL_SCRIPT")"
  if [ -f "$install_dir/verify-fresh-install.sh" ]; then
    printf '%s\n' "$install_dir/verify-fresh-install.sh"
    return 0
  fi
  return 1
}

installer_script_name() {
  case "$TARGET" in
    wsl) echo "install-wsl.sh" ;;
    macos|linux) echo "install.sh" ;;
  esac
}

run_installer() {
  local script_name
  script_name="$(installer_script_name)"
  local archived_installer="$OUT_DIR/02-installer-script.sh"

  if [ "$SKIP_INSTALL" = "1" ]; then
    record "SKIP installer"
    echo "== installer skipped =="
    return 0
  fi

  if [ -n "$INSTALL_SCRIPT" ]; then
    archive_local_script "installer" "$INSTALL_SCRIPT" "$archived_installer"
  else
    archive_remote_script "installer" "$RAW_BASE/scripts/$script_name" "$archived_installer"
  fi
  run_logged "CLI-JAW one-click installer" "$OUT_DIR/01-install.log" bash "$archived_installer"
}

run_verifier() {
  local args=()
  local verifier=""
  local verifier_label="packaged fresh-install verifier"
  local archived_verifier="$OUT_DIR/21-verifier-script.sh"
  if [ "$SKIP_DOCTOR" = "1" ]; then
    args+=(--skip-doctor)
  fi

  if [ -n "$VERIFIER_SCRIPT" ]; then
    verifier="$VERIFIER_SCRIPT"
    verifier_label="local fresh-install verifier"
  elif verifier="$(local_verifier_for_install_script 2>/dev/null || true)" && [ -n "$verifier" ]; then
    verifier_label="local fresh-install verifier from installer checkout"
  elif command -v npm >/dev/null 2>&1; then
    local npm_root
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [ -n "$npm_root" ] && [ -f "$npm_root/cli-jaw/scripts/verify-fresh-install.sh" ]; then
      verifier="$npm_root/cli-jaw/scripts/verify-fresh-install.sh"
    fi
  fi

  if [ -n "$verifier" ]; then
    archive_local_script "verifier" "$verifier" "$archived_verifier"
    run_logged "$verifier_label" "$OUT_DIR/20-verify.log" bash "$archived_verifier" "${args[@]}"
  else
    archive_remote_script "verifier" "$RAW_BASE/scripts/verify-fresh-install.sh" "$archived_verifier"
    run_logged "raw fresh-install verifier" "$OUT_DIR/20-verify.log" bash "$archived_verifier" "${args[@]}"
  fi
}

run_shell_probes() {
  local probe='set -e; printf "node_path="; command -v node; node --version; printf "npm_path="; command -v npm; npm --version; printf "jaw_path="; command -v jaw; jaw --version'

  if [ "$TARGET" = "macos" ]; then
    run_optional_shell_logged "bash login-shell probe (non-default on macOS)" "$OUT_DIR/30-bash-login-probe.log" "$probe"
  else
    run_shell_logged "current bash login-shell probe" "$OUT_DIR/30-bash-login-probe.log" "$probe"
  fi

  if command -v zsh >/dev/null 2>&1; then
    if [ "$TARGET" = "macos" ]; then
      run_logged "zsh login-shell probe" "$OUT_DIR/31-zsh-login-probe.log" zsh -lc "$probe"
      run_logged "zsh interactive-shell probe" "$OUT_DIR/32-zsh-interactive-probe.log" zsh -ic "$probe"
    else
      run_optional_logged "zsh login-shell probe (non-default outside macOS)" "$OUT_DIR/31-zsh-login-probe.log" zsh -lc "$probe"
      run_optional_logged "zsh interactive-shell probe (non-default outside macOS)" "$OUT_DIR/32-zsh-interactive-probe.log" zsh -ic "$probe"
    fi
  else
    record "SKIP zsh probes: zsh not found"
  fi

  if [ "$TARGET" = "wsl" ]; then
    local distro="${WSL_DISTRO_NAME:-Ubuntu}"
    record "PowerShell host probe command: wsl.exe -d $distro -- bash -lc \"jaw --version\""
    if command -v powershell.exe >/dev/null 2>&1; then
      run_logged "PowerShell-to-WSL jaw probe" "$OUT_DIR/33-powershell-to-wsl-probe.log" \
        powershell.exe -NoProfile -Command "\$ErrorActionPreference = 'Stop'; wsl.exe -d '$distro' -- bash -lc 'jaw --version'"
    else
      record "SKIP PowerShell-to-WSL probe: powershell.exe not found inside WSL"
      echo "PowerShell-to-WSL probe skipped: powershell.exe not found inside WSL"
      echo "Run this from Windows PowerShell, then re-run the auditor:"
      cat <<EOF
wsl.exe -d $distro -- bash -lc 'EVIDENCE_DIR="\$(ls -dt ~/cli-jaw-fresh-install-evidence-* | head -1)"; { echo "command=wsl.exe -d $distro -- bash -lc jaw --version"; jaw --version; } | tee "\$EVIDENCE_DIR/33-powershell-to-wsl-probe.log"'
EOF
    fi
  fi
}

echo "CLI-JAW fresh-machine evidence collector"
echo "target=$TARGET"
echo "out_dir=$OUT_DIR"

archive_collector_script
collect_snapshot "before" "$OUT_DIR/00-before.txt"
run_installer || true
refresh_runtime_paths
collect_snapshot "after" "$OUT_DIR/10-after.txt"
run_verifier || true
run_shell_probes || true

if [ "$FAILURES" -eq 0 ]; then
  record "RESULT pass"
  echo
  echo "PASS evidence_dir=$OUT_DIR"
  exit 0
fi

record "RESULT fail failures=$FAILURES"
echo
echo "FAIL failures=$FAILURES evidence_dir=$OUT_DIR"
exit 1
