#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  🦈 CLI-JAW — WSL One-Click Installer
#  Usage:  curl -fsSL https://raw.githubusercontent.com/lidge-ai/cli-jaw/main/scripts/install-wsl.sh | bash
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

echo ""
echo -e "${CYAN}${BOLD}"
echo "   ██████╗██╗     ██╗      ██╗ █████╗ ██╗    ██╗"
echo "  ██╔════╝██║     ██║      ██║██╔══██╗██║    ██║"
echo "  ██║     ██║     ██║█████╗██║███████║██║ █╗ ██║"
echo "  ██║     ██║     ██║╚════╝██║██╔══██║██║███╗██║"
echo "  ╚██████╗███████╗██║      ██║██║  ██║╚███╔███╔╝"
echo "   ╚═════╝╚══════╝╚═╝      ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝"
echo -e "${NC}"
echo -e "${DIM}  WSL One-Click Installer${NC}"
echo ""

NODE_MAJOR=22
SUDO=""
HAS_SUDO=false
NPM_PREFIX="$HOME/.local"
NPM_PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

# npm >= 11.16 understands --allow-scripts; npm 12 blocks unreviewed dependency
# lifecycle scripts by default, so without this flag a global install can
# succeed while cli-jaw's postinstall silently never runs. Older npm rejects
# unknown config, so the flag is attached conditionally. (Duplicated from
# install.sh — both files are standalone curl-run scripts.)
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

# Guard: reject Windows HOME (e.g. /mnt/c/Users/...)
case "$HOME" in
  /mnt/*) fail "HOME points to Windows path: $HOME — launch a proper WSL shell (wsl.exe -d Ubuntu)" ;;
esac

wsl_npm_is_usable() {
  local npm_path
  npm_path="$(command -v npm 2>/dev/null || true)"
  [ -n "$npm_path" ] || return 1
  case "$npm_path" in
    /mnt/*) return 1 ;;
  esac
  npm --version >/dev/null 2>&1
}

ensure_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    HAS_SUDO=true
    SUDO=""
    ok "Running as root — full system install available"
    return 0
  fi

  if ! command -v sudo &>/dev/null; then
    warn "sudo not found — system package install will be skipped"
    return 0
  fi

  info "Requesting sudo once for WSL system setup..."
  if sudo -v; then
    HAS_SUDO=true
    SUDO="sudo"
    ok "sudo ready — system dependencies can be installed"
  else
    warn "sudo authentication failed — continuing with user-space setup only"
  fi
}

# ═══════════════════════════════════════
#  Step 0: System prerequisites
# ═══════════════════════════════════════
install_prerequisites() {
  local packages=(
    curl
    unzip
    git
    ca-certificates
    build-essential
    python3
    make
    g++
    pkg-config
    xdg-utils
    file
    fonts-noto-cjk
  )

  if [ "$HAS_SUDO" = true ]; then
    info "Installing WSL system prerequisites..."
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq "${packages[@]}"
    ok "System prerequisites installed"
  else
    warn "Skipping apt prerequisites (sudo unavailable)"
    warn "Recommended packages: ${packages[*]}"
  fi
}

# ═══════════════════════════════════════
#  Step 1: Node.js version manager
# ═══════════════════════════════════════
install_node() {
  # Check if Node.js >= 22 already exists AND is WSL-native
  if command -v node &>/dev/null; then
    local node_path
    node_path="$(command -v node)"
    # Reject Windows Node accessed via /mnt/c (not usable in WSL)
    case "$node_path" in
      /mnt/*)
        warn "Found Windows Node at $node_path — not usable in WSL, installing WSL-native..."
        ;;
      *)
        local ver
        ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$ver" -ge "$NODE_MAJOR" ] 2>/dev/null; then
          local npm_path
          npm_path="$(command -v npm 2>/dev/null || true)"
          # Also verify npm is WSL-native and runnable before early return
          case "$npm_path" in
            /mnt/*) warn "Node is WSL-native but npm resolves to Windows: $npm_path — reinstalling..." ;;
            "")
              warn "Node is WSL-native but npm is missing — reinstalling..."
              ;;
            *)
              if ! npm --version >/dev/null 2>&1; then
                warn "Node is WSL-native but npm is not runnable at $npm_path — reinstalling..."
              else
                ok "Node.js $(node -v) already installed (>= $NODE_MAJOR) at $node_path"
                return 0
              fi
              ;;
          esac
        else
          warn "Node.js $(node -v) found but < $NODE_MAJOR — upgrading..."
        fi
        ;;
    esac
  fi

  # Prefer fnm (fast, single binary), fall back to nvm if already present
  # Skip Windows version managers found via /mnt/c PATH
  local use_fnm=false use_nvm=false
  if command -v fnm &>/dev/null; then
    case "$(command -v fnm)" in
      /mnt/*) warn "Ignoring Windows fnm at $(command -v fnm)" ;;
      *) use_fnm=true ;;
    esac
  fi
  if ! $use_fnm; then
    if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
      case "$(command -v nvm 2>/dev/null || echo "$HOME/.nvm/nvm.sh")" in
        /mnt/*) warn "Ignoring Windows nvm at $(command -v nvm)" ;;
        *) use_nvm=true ;;
      esac
    fi
  fi

  if $use_fnm; then
    info "fnm detected — installing Node.js $NODE_MAJOR..."
    fnm install "$NODE_MAJOR" && fnm use "$NODE_MAJOR" && fnm default "$NODE_MAJOR"
  elif $use_nvm; then
    info "nvm detected — installing Node.js $NODE_MAJOR..."
    # shellcheck disable=SC1091
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    nvm install "$NODE_MAJOR" && nvm alias default "$NODE_MAJOR"
  else
    info "Installing fnm (Fast Node Manager)..."
    curl -fsSL https://fnm.vercel.app/install | bash

    # Load fnm into current session
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)"

    info "Installing Node.js $NODE_MAJOR via fnm..."
    fnm install "$NODE_MAJOR" && fnm use "$NODE_MAJOR" && fnm default "$NODE_MAJOR"
  fi

  # Verify Node is installed AND WSL-native
  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Please install manually: https://nodejs.org"
  fi
  local final_node
  final_node="$(command -v node)"
  case "$final_node" in
    /mnt/*) fail "Node.js installed but resolves to Windows path: $final_node — install WSL-native Node" ;;
  esac
  if ! wsl_npm_is_usable; then
    local final_npm
    final_npm="$(command -v npm 2>/dev/null || true)"
    case "$final_npm" in
      /mnt/*) fail "npm resolves to Windows path: $final_npm — install WSL-native Node" ;;
      "") fail "Node.js installed but npm is missing — install WSL-native Node with npm" ;;
      *) fail "npm is installed at $final_npm but failed to run" ;;
    esac
  fi
  ok "Node.js $(node -v) with npm $(npm --version) ready at $final_node"
}

# ═══════════════════════════════════════
#  Step 2: Configure user-local npm prefix
# ═══════════════════════════════════════
add_npm_path_to_profile() {
  local profile="$1"
  [ -n "$profile" ] || return 0

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if ! grep -Fq "$NPM_PATH_LINE" "$profile" 2>/dev/null; then
    {
      echo ''
      echo '# CLI-JAW: user-local npm global bin'
      echo "$NPM_PATH_LINE"
    } >> "$profile"
    ok "Added ~/.local/bin to ${profile/#$HOME/~}"
  fi
}

configure_bash_path_profiles() {
  add_npm_path_to_profile "$HOME/.bashrc"

  # Bash login shells read the first existing file among .bash_profile,
  # .bash_login, and .profile. Update existing higher-priority files without
  # creating them, so we do not accidentally stop Bash from reading .profile.
  [ -f "$HOME/.bash_profile" ] && add_npm_path_to_profile "$HOME/.bash_profile"
  [ -f "$HOME/.bash_login" ] && add_npm_path_to_profile "$HOME/.bash_login"
  add_npm_path_to_profile "$HOME/.profile"
}

resolve_wsl_tool_path() {
  local tool="$1"
  local candidate

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    case "$candidate" in
      "$NPM_PREFIX/bin/$tool"|/mnt/*) continue ;;
      *) printf '%s\n' "$candidate"; return 0 ;;
    esac
  done < <(type -P -a "$tool" 2>/dev/null || true)

  return 1
}

link_node_tools_to_local_bin() {
  local tool target link
  mkdir -p "$NPM_PREFIX/bin"

  for tool in node npm npx corepack; do
    target="$(resolve_wsl_tool_path "$tool" || true)"
    [ -n "$target" ] || continue
    link="$NPM_PREFIX/bin/$tool"
    ln -sfn "$target" "$link"
  done

  hash -r 2>/dev/null || true
}

configure_npm_prefix() {
  local prefix="$NPM_PREFIX"

  # Sanitize npm env vars that can override prefix or config paths
  unset npm_config_prefix NPM_CONFIG_PREFIX
  unset npm_config_globalconfig NPM_CONFIG_GLOBALCONFIG
  unset npm_config_userconfig NPM_CONFIG_USERCONFIG
  unset npm_config_cache NPM_CONFIG_CACHE
  unset PREFIX

  mkdir -p "$prefix/bin" "$prefix/lib"
  npm config set prefix "$prefix"
  export PATH="$prefix/bin:$PATH"
  link_node_tools_to_local_bin
  hash -r 2>/dev/null || true

  # Verify effective prefix is WSL-native and matches intent
  local effective
  effective="$(npm config get prefix 2>/dev/null || echo "$prefix")"
  case "$effective" in
    /mnt/*) fail "npm effective prefix points to Windows: $effective" ;;
  esac
  if [ "$effective" != "$prefix" ]; then
    warn "npm prefix mismatch: expected $prefix, got $effective"
  fi

  configure_bash_path_profiles
  if [ -f "$HOME/.zshrc" ] || [ "${SHELL:-}" != "${SHELL%zsh}" ]; then
    add_npm_path_to_profile "$HOME/.zshrc"
  fi

  ok "npm global prefix set to $effective"
}

verify_jaw_command() {
  local jaw_bin="$NPM_PREFIX/bin/jaw"
  export PATH="$NPM_PREFIX/bin:$PATH"
  hash -r 2>/dev/null || true

  if ! command -v jaw &>/dev/null; then
    fail "cli-jaw installed, but 'jaw' is not on PATH. Expected $jaw_bin"
  fi

  jaw --version >/dev/null 2>&1 || fail "jaw is on PATH but failed to run"
}

# ═══════════════════════════════════════
#  Step 3: Install cli-jaw
# ═══════════════════════════════════════
install_jaw() {
  local allow_flag
  allow_flag="$(jaw_allow_scripts_flag)"
  if command -v jaw &>/dev/null; then
    ok "cli-jaw already installed ($(jaw --version 2>/dev/null || echo 'unknown version'))"
    info "Updating to latest..."
    CLI_JAW_INSTALL_CLI_TOOLS=1 \
      npm install -g cli-jaw@latest ${allow_flag:+$allow_flag}
  else
    info "Installing cli-jaw globally..."
    CLI_JAW_INSTALL_CLI_TOOLS=1 \
      npm install -g cli-jaw ${allow_flag:+$allow_flag}
  fi

  verify_jaw_command
  local jaw_version
  jaw_version="$(jaw --version)"
  ok "cli-jaw installed: $jaw_version"
}

# ═══════════════════════════════════════
#  Step 4: Browser + Office dependencies
# ═══════════════════════════════════════
install_browser_deps() {
  info "Installing browser dependencies..."
  npm install -g playwright-core
  ok "playwright-core installed"

  if [ "$HAS_SUDO" = true ]; then
    info "Installing Chromium (best effort)..."
    $SUDO apt-get install -y -qq chromium-browser 2>/dev/null \
      || $SUDO apt-get install -y -qq chromium 2>/dev/null \
      || warn "Chromium package unavailable — Windows Chrome fallback will be used if present"
  else
    warn "Skipping Chromium apt install (sudo unavailable)"
  fi

  verify_browser_readiness
}

verify_browser_readiness() {
  if command -v chromium-browser &>/dev/null && chromium-browser --version >/dev/null 2>&1; then
    ok "Chromium ready: $(chromium-browser --version)"
    return 0
  fi

  if command -v chromium &>/dev/null && chromium --version >/dev/null 2>&1; then
    ok "Chromium ready: $(chromium --version)"
    return 0
  fi

  local win_chrome_paths=(
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  )
  for chrome_path in "${win_chrome_paths[@]}"; do
    if [ -f "$chrome_path" ]; then
      ok "Windows Chrome fallback detected: $chrome_path"
      return 0
    fi
  done

  warn "No runnable Chromium or Windows Chrome fallback detected — browser/web-ai features may need manual Chrome setup"
}

# ═══════════════════════════════════════
#  Step 5: Doctor check
# ═══════════════════════════════════════
run_doctor() {
  info "Running diagnostics..."
  verify_jaw_command
  jaw doctor || true
}

# ═══════════════════════════════════════
#  Main
# ═══════════════════════════════════════
main() {
  info "Starting CLI-JAW installation on WSL..."
  echo ""

  ensure_sudo
  echo ""

  install_prerequisites
  echo ""

  install_node
  echo ""

  configure_npm_prefix
  echo ""

  install_jaw
  echo ""

  install_browser_deps
  echo ""

  run_doctor
  echo ""

  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  🦈 CLI-JAW is ready!${NC}"
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo ""
  echo -e "  Run:  ${CYAN}jaw dashboard${NC}"
  echo -e "  Also: ${CYAN}jaw serve${NC}  ${DIM}# classic server mode${NC}"
  echo -e "  If a new shell cannot find jaw: ${CYAN}source ~/.bashrc${NC}"
  echo -e "  From Windows PowerShell: ${CYAN}wsl.exe -d Ubuntu -- bash -lc \"jaw dashboard\"${NC}"
  echo ""
  echo -e "${DIM}  Tip: Authenticate at least one AI engine:${NC}"
  echo -e "${DIM}    gh auth login        # GitHub Copilot (free)${NC}"
  echo -e "${DIM}    claude auth login     # Anthropic Claude${NC}"
  echo -e "${DIM}    claude auth status    # Verify Claude login${NC}"
  echo -e "${DIM}    codex login           # OpenAI Codex${NC}"
  echo ""
}

if [ "${CLI_JAW_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
