#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  🦈 CLI-JAW — One-Click Installer (macOS / Linux)
#  Usage:  curl -fsSL https://raw.githubusercontent.com/lidge-ai/cli-jaw/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colors ──
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; exit 1; }

print_banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "   ██████╗██╗     ██╗      ██╗ █████╗ ██╗    ██╗"
  echo "  ██╔════╝██║     ██║      ██║██╔══██╗██║    ██║"
  echo "  ██║     ██║     ██║█████╗██║███████║██║ █╗ ██║"
  echo "  ██║     ██║     ██║╚════╝██║██╔══██║██║███╗██║"
  echo "  ╚██████╗███████╗██║      ██║██║  ██║╚███╔███╔╝"
  echo "   ╚═════╝╚══════╝╚═╝      ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝"
  echo -e "${NC}"
  echo -e "${DIM}  One-Click Installer${NC}"
  echo ""
}

NODE_MAJOR=22

extract_semver() {
  printf '%s' "${1:-}" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true
}

# npm >= 11.16 understands --allow-scripts; npm 12 blocks unreviewed dependency
# lifecycle scripts by default, so without this flag a global install can
# succeed while cli-jaw's postinstall silently never runs. Older npm rejects
# unknown config, so the flag is attached conditionally.
JAW_ALLOW_SCRIPTS="cli-jaw"

jaw_npm_supports_allow_scripts() {
  local npm_version major minor
  npm_version="$(npm --version 2>/dev/null || true)"
  major="$(printf '%s' "$npm_version" | cut -d. -f1)"
  minor="$(printf '%s' "$npm_version" | cut -d. -f2)"
  case "$major" in (''|*[!0-9]*) return 1 ;; esac
  case "$minor" in (''|*[!0-9]*) minor=0 ;; esac
  [ "$major" -gt 11 ] || { [ "$major" -eq 11 ] && [ "$minor" -ge 16 ]; }
}

jaw_allow_scripts_flag() {
  if jaw_npm_supports_allow_scripts; then
    printf '%s' "--allow-scripts=${JAW_ALLOW_SCRIPTS}"
  fi
}

resolve_cmd() {
  command -v "$1" 2>/dev/null || true
}

list_path_cmd_candidates() {
  local name="${1:-}"
  local dir candidate seen=":"
  if [ -z "$name" ]; then
    return 0
  fi

  IFS=':' read -r -a path_parts <<< "${PATH:-}"
  for dir in "${path_parts[@]}"; do
    if [ -z "$dir" ]; then
      dir="."
    fi
    candidate="${dir%/}/$name"
    case "$seen" in
      *":$candidate:"*) continue ;;
    esac
    seen="${seen}${candidate}:"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      printf '%s\n' "$candidate"
    fi
  done
}

get_installed_jaw_binary() {
  local name candidate
  for name in jaw cli-jaw; do
    while IFS= read -r candidate; do
      if [ -z "$candidate" ]; then
        continue
      fi
      if [ -n "$(get_binary_version "$candidate")" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
      warn "$name exists but failed --version: $candidate"
    done < <(list_path_cmd_candidates "$name")
  done
  return 1
}

get_binary_version() {
  local bin_path="${1:-}"
  if [ -z "$bin_path" ]; then
    return 0
  fi
  extract_semver "$("$bin_path" --version 2>/dev/null | head -n1)"
}

get_latest_cli_jaw_version() {
  extract_semver "$(npm view cli-jaw version 2>/dev/null || true)"
}

ensure_macos_developer_tools() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi

  if xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
    return 0
  fi

  fail "Xcode Command Line Tools are required before installing Node via nvm. Run: xcode-select --install  Then rerun this installer after it completes."
}

realpath_fallback() {
  local target="${1:-}"
  if [ -z "$target" ]; then
    return 0
  fi
  node -e "const fs=require('fs');const p=process.argv[1];try{console.log(fs.realpathSync(p));}catch{console.log(p)}" "$target" 2>/dev/null || printf '%s\n' "$target"
}

zsh_config_dir() {
  printf '%s\n' "${ZDOTDIR:-$HOME}"
}

is_zsh_shell() {
  case "${SHELL:-/bin/bash}" in
    */zsh) return 0 ;;
    *) return 1 ;;
  esac
}

npm_is_usable() {
  command -v npm &>/dev/null && npm --version &>/dev/null
}

ensure_nvm_shell_profile() {
  local profile="${1:-}"
  if [ -z "$profile" ] || [ "$profile" = "your shell config" ]; then
    return 0
  fi

  case "$profile" in
    "~/"*) profile="${HOME}/${profile#~/}" ;;
  esac

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if ! grep -Fq 'NVM_DIR="$HOME/.nvm"' "$profile" 2>/dev/null; then
    {
      echo ''
      echo 'export NVM_DIR="$HOME/.nvm"'
      echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
      echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'
    } >> "$profile"
  fi
}

ensure_path_shell_profile() {
  local profile="${1:-}"
  local path_line="${2:-}"
  if [ -z "$profile" ] || [ -z "$path_line" ] || [ "$profile" = "your shell config" ]; then
    return 0
  fi

  case "$profile" in
    "~/"*) profile="${HOME}/${profile#~/}" ;;
  esac

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if ! grep -Fq "$path_line" "$profile" 2>/dev/null; then
    {
      echo ''
      echo "$path_line"
    } >> "$profile"
  fi
}

ensure_local_bin_path() {
  local path_line='export PATH="$HOME/.local/bin:$PATH"'
  case ":${PATH:-}:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:${PATH:-}" ;;
  esac

  case "${SHELL:-/bin/bash}" in
    */zsh)
      local zdir
      zdir="$(zsh_config_dir)"
      ensure_path_shell_profile "$zdir/.zshrc" "$path_line"
      ensure_path_shell_profile "$zdir/.zprofile" "$path_line"
      ;;
    */bash)
      ensure_path_shell_profile "~/.bashrc" "$path_line"
      ensure_path_shell_profile "~/.bash_profile" "$path_line"
      ;;
    *)
      ensure_path_shell_profile "~/.profile" "$path_line"
      ;;
  esac
}

is_runnable_cli_tool() {
  local bin="${1:-}"
  if [ -z "$bin" ]; then
    return 1
  fi
  command -v "$bin" &>/dev/null && "$bin" --version &>/dev/null
}

unavailable_required_cli_tools() {
  local missing=()
  local bin
  for bin in claude codex gemini grok copilot opencode; do
    if ! is_runnable_cli_tool "$bin"; then
      missing+=("$bin")
    fi
  done

  local joined=""
  if [ "${#missing[@]}" -gt 0 ]; then
    for bin in "${missing[@]}"; do
      if [ -n "$joined" ]; then
        joined="${joined}, ${bin}"
      else
        joined="$bin"
      fi
    done
  fi
  printf '%s\n' "$joined"
}

# Shell-level Claude install classifier — mirrors src/core/claude-install.ts
# Returns: native | node-managed | unknown
classify_claude_install_sh() {
  local bin_path="${1:-}"
  local real_path="${2:-}"
  if [ -z "$bin_path" ]; then
    echo "unknown"
    return 0
  fi

  # Check native paths
  case "$bin_path" in
    "$HOME/.local/bin/claude"|"$HOME/.claude/local/bin/claude")
      echo "native"
      return 0
      ;;
  esac

  # Check realpath for node_modules or native
  if [ -n "$real_path" ]; then
    case "$real_path" in
      */node_modules/@anthropic-ai/claude-code/*)
        echo "node-managed"
        return 0
        ;;
      */.claude/local/*)
        echo "native"
        return 0
        ;;
    esac
  fi

  # Check bun bin
  case "$bin_path" in
    */.bun/bin/claude)
      echo "node-managed"
      return 0
      ;;
  esac

  echo "unknown"
}

print_cli_dependency_guidance() {
  echo ""
  info "CLI dependency guidance"

  warn "Claude Code users who need computer-use MCP should prefer Anthropic's native installer:"
  echo -e "${DIM}   curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo -e "${DIM}   or run: claude install${NC}"

  local claude_bin claude_real claude_kind
  claude_bin="$(resolve_cmd claude)"
  if [ -n "$claude_bin" ]; then
    claude_real="$(realpath_fallback "$claude_bin")"
    claude_kind="$(classify_claude_install_sh "$claude_bin" "$claude_real")"
    case "$claude_kind" in
      native)
        ok "Claude CLI looks native (${claude_bin})"
        ;;
      node-managed)
        warn "Claude CLI appears npm/bun-managed (${claude_bin})"
        warn "For computer-use MCP, reinstall Claude natively or run: claude install"
        ;;
      *)
        warn "Claude CLI detected at ${claude_bin} — verify it is native if you need computer-use MCP"
        ;;
    esac
  else
    warn "Claude CLI not detected — install only if you plan to use Claude"
  fi

  local codex_bin
  codex_bin="$(resolve_cmd codex)"
  if [ -n "$codex_bin" ]; then
    ok "Codex CLI detected (${codex_bin}) — npm/bun/global installs are fine"
  else
    info "Optional: install Codex with npm or bun if you want OpenAI as a backend"
  fi
}

# ═══════════════════════════════════════
#  Step 1: Ensure Node.js ≥ 22
# ═══════════════════════════════════════
ensure_node() {
  local install_reason="Node.js ≥ ${NODE_MAJOR} not found"

  # Already have Node.js ≥ 22?
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      if npm_is_usable; then
        ok "Node.js $(node -v) with npm $(npm --version) detected — good to go"
        return 0
      fi
      warn "Node.js $(node -v) found but npm is missing or not runnable — repairing Node.js install..."
      install_reason="Node.js $(node -v) found without runnable npm"
    else
      warn "Node.js $(node -v) found but need ≥ ${NODE_MAJOR}"
      install_reason="Node.js $(node -v) is below ${NODE_MAJOR}"
    fi
  fi

  info "${install_reason} — installing..."

  # Strategy: brew → nvm → fail
  if command -v brew &>/dev/null; then
    info "Homebrew detected — installing Node.js via brew"
    if brew install node@${NODE_MAJOR} 2>/dev/null; then
      brew link --overwrite node@${NODE_MAJOR} 2>/dev/null || true
      hash -r 2>/dev/null || true
      # Verify brew actually delivered a working node >= NODE_MAJOR
      if command -v node &>/dev/null; then
        local brew_ver
        brew_ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$brew_ver" -ge "$NODE_MAJOR" ] 2>/dev/null && npm_is_usable; then
          ok "Node.js $(node -v) with npm $(npm --version) installed via Homebrew"
          return 0
        fi
      fi
      warn "Homebrew installed but Node.js ≥ ${NODE_MAJOR} with npm is not working — falling through to nvm"
    else
      warn "Homebrew install failed — falling through to nvm"
    fi
  fi

  # brew unavailable or failed → install nvm + Node.js
  info "Installing via nvm"
  ensure_macos_developer_tools
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  local shell_rc
  case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="$(zsh_config_dir)/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)      shell_rc="your shell config" ;;
  esac
  ensure_nvm_shell_profile "$shell_rc"
  if is_zsh_shell; then
    ensure_nvm_shell_profile "$(zsh_config_dir)/.zprofile"
  fi

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE="$shell_rc" bash
  fi

  # Source nvm
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if ! command -v nvm &>/dev/null; then
    fail "nvm installation failed. Please install Node.js ≥ ${NODE_MAJOR} manually from https://nodejs.org"
  fi

  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
  if ! npm_is_usable; then
    fail "Node.js installed but npm is not runnable. Please reinstall Node.js ≥ ${NODE_MAJOR} from https://nodejs.org"
  fi
  ok "Node.js $(node -v) with npm $(npm --version) installed via nvm"

  # Remind user to add nvm to their shell
  ensure_nvm_shell_profile "$shell_rc"
  if is_zsh_shell; then
    ensure_nvm_shell_profile "$(zsh_config_dir)/.zprofile"
  fi
  echo ""
  warn "For future sessions, nvm is auto-added to ${shell_rc}"
  echo -e "${DIM}   If 'node' is not found after restarting terminal, run: source ${shell_rc}${NC}"
}

# ═══════════════════════════════════════
#  Step 2: Install CLI-JAW
# ═══════════════════════════════════════
install_cli_jaw() {
  local installed_bin installed_version latest_version missing_cli_tools
  installed_bin="$(get_installed_jaw_binary || true)"
  installed_version="$(get_binary_version "$installed_bin")"
  latest_version="$(get_latest_cli_jaw_version)"
  missing_cli_tools="$(unavailable_required_cli_tools)"

  # If npm view failed (network issue) and we already have a working install, skip
  if [ -z "$latest_version" ] && [ -n "$installed_bin" ] && [ -n "$installed_version" ]; then
    if [ -z "$missing_cli_tools" ]; then
      warn "Could not fetch latest version (network issue?) — keeping existing ${installed_version}"
      ok "CLI-JAW ${installed_version} at ${installed_bin} — skipping update"
      return 0
    fi
    warn "Could not fetch latest version, but bundled CLI tools are missing: ${missing_cli_tools}"
    warn "Attempting npm repair install anyway"
  fi

  if [ -n "$installed_bin" ] && [ -n "$installed_version" ] && [ -n "$latest_version" ] && [ "$installed_version" = "$latest_version" ]; then
    if [ -z "$missing_cli_tools" ]; then
      ok "CLI-JAW ${installed_version} already installed at ${installed_bin} — skipping npm install"
      return 0
    fi
    warn "CLI-JAW ${installed_version} already installed, but bundled CLI tools are missing: ${missing_cli_tools}"
    warn "Re-running npm install to repair the partial install"
  fi

  # Detect package manager from existing install path to avoid shared-path contamination
  local allow_flag pkg_cmd
  allow_flag="$(jaw_allow_scripts_flag)"
  pkg_cmd="npm install -g cli-jaw${allow_flag:+ $allow_flag}"
  if [ -n "$installed_bin" ]; then
    case "$installed_bin" in
      *"/.bun/bin/"*)
        # bun skips lifecycle scripts for untrusted packages; --trust is the
        # only surface that runs them for a global add.
        pkg_cmd="bun add -g --trust cli-jaw"
        info "Detected bun-managed install — using bun"
        ;;
      *)
        info "Using npm for global install"
        ;;
    esac
  fi

  if [ -n "$installed_bin" ] && [ -n "$installed_version" ]; then
    info "Updating CLI-JAW ${installed_version} → ${latest_version:-latest}"
  else
    info "Installing CLI-JAW..."
  fi
  export CLI_JAW_INSTALL_CLI_TOOLS=1
  if [ "${CLI_JAW_STRICT_ONE_CLICK:-0}" = "1" ] \
    || [ "${CLI_JAW_STRICT_ONE_CLICK:-}" = "true" ] \
    || [ "${CLI_JAW_REQUIRE_CLI_TOOLS:-0}" = "1" ] \
    || [ "${CLI_JAW_REQUIRE_CLI_TOOLS:-}" = "true" ] \
    || [ "${npm_config_jaw_require_cli_tools:-0}" = "1" ] \
    || [ "${npm_config_jaw_require_cli_tools:-}" = "true" ]; then
    export CLI_JAW_REQUIRE_CLI_TOOLS=1
  else
    unset CLI_JAW_REQUIRE_CLI_TOOLS 2>/dev/null || true
    unset npm_config_jaw_require_cli_tools 2>/dev/null || true
  fi
  eval "$pkg_cmd"

  hash -r 2>/dev/null || true

  # Post-install verification: re-resolve and check version
  local new_bin new_ver
  new_bin="$(get_installed_jaw_binary || true)"
  new_ver="$(get_binary_version "$new_bin")"
  if [ -n "$new_bin" ] && [ -n "$new_ver" ]; then
    ok "CLI-JAW ${new_ver} installed at ${new_bin}"
  else
    warn "CLI-JAW install completed but binary not responding — check your PATH"
  fi

  # Verify jaw actually runs
  if command -v jaw &>/dev/null; then
    jaw --version >/dev/null 2>&1 || warn "jaw is on PATH but failed to run"
  fi
}

# ═══════════════════════════════════════
#  Step 3: Browser skill deps (Chromium + playwright-core)
# ═══════════════════════════════════════
install_browser_deps() {
  info "Installing browser skill dependencies..."

  # playwright-core (CDP client)
  # Check global install via npm root -g (matches doctor.ts approach)
  PW_FOUND=false
  if command -v npm &>/dev/null; then
    GLOBAL_ROOT="$(npm root -g 2>/dev/null)"
    if [ -d "$GLOBAL_ROOT/playwright-core" ]; then
      PW_FOUND=true
    fi
  fi
  # Fallback: require.resolve for local installs
  if ! $PW_FOUND && node -e "require.resolve('playwright-core')" 2>/dev/null; then
    PW_FOUND=true
  fi
  if $PW_FOUND; then
    ok "playwright-core already installed"
  else
    npm install -g playwright-core
    ok "playwright-core installed"
  fi

  # Chromium (headless browser) — use --version to verify actual execution (snap transitional may pass command -v but fail to run)
  if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1) || (google-chrome-stable --version &>/dev/null 2>&1) || (google-chrome --version &>/dev/null 2>&1); then
    ok "Browser already installed"
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      # macOS: Chrome 설치 안내 (수동)
      if [ -d "/Applications/Google Chrome.app" ]; then
        ok "Google Chrome found"
      else
        warn "Google Chrome not found — install from https://google.com/chrome"
      fi
      ;;
    Linux)
      # Linux: 자동 설치 시도
      # Determine privilege escalation method
      local SUDO=""
      if [ "$(id -u)" -eq 0 ]; then
        SUDO=""  # already root
      elif command -v sudo &>/dev/null; then
        SUDO="sudo"
      else
        warn "No sudo available and not running as root — skipping Chromium install"
        warn "Install manually: apt install chromium-browser (as root)"
        return 0
      fi

      if command -v apt-get &>/dev/null; then
        info "Installing Chromium via apt..."
        $SUDO apt-get update -qq
        $SUDO apt-get install -y -qq chromium-browser 2>/dev/null \
          || $SUDO apt-get install -y -qq chromium 2>/dev/null \
          || true
        # Verify install actually succeeded (--version confirms binary actually runs)
        if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1); then
          ok "Chromium installed"
        else
          warn "Chromium install failed — install manually: sudo apt install chromium-browser"
        fi
      elif command -v dnf &>/dev/null; then
        info "Installing Chromium via dnf..."
        $SUDO dnf install -y chromium || true
        if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1); then
          ok "Chromium installed"
        else
          warn "Chromium install failed — install manually: sudo dnf install chromium"
        fi
      else
        warn "Could not auto-install Chromium — install manually for your distro"
      fi
      ;;
  esac
}

# ═══════════════════════════════════════
#  Step 5: Doctor check
# ═══════════════════════════════════════
run_doctor() {
  info "Running diagnostics..."
  if command -v jaw &>/dev/null; then
    jaw doctor || true
  else
    warn "jaw not found on PATH — skipping diagnostics"
  fi
}

main() {
  print_banner
  ensure_node
  ensure_local_bin_path
  echo ""
  install_cli_jaw
  echo ""
  install_browser_deps
  echo ""
  run_doctor
  echo ""
  print_cli_dependency_guidance

  echo ""
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  🦈 CLI-JAW is ready!${NC}"
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo ""
  echo -e "  Run:  ${CYAN}jaw dashboard${NC}"
  echo -e "  Also: ${CYAN}jaw serve${NC}  ${DIM}# classic server mode${NC}"
  echo ""
  echo -e "${DIM}  Tip: Authenticate at least one AI engine:${NC}"
  echo -e "${DIM}    gh auth login        # GitHub Copilot (free)${NC}"
  echo -e "${DIM}    claude auth login     # Anthropic Claude${NC}"
  echo -e "${DIM}    codex login           # OpenAI Codex${NC}"
  echo ""
}

if [ "${CLI_JAW_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
