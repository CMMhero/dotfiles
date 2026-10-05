#!/usr/bin/env bash
# ==============================================================================
# Full System Bootstrap & Dotfiles Installer
# Sets up a fresh Linux machine (Ubuntu/Debian) to mirror current WSL setup.
#
# Exclusions (per user request):
#   - ghostty, deja, tuios
#
# Carried over:
#   - APT base tools (build-essential, git, curl, stow, procps, file, etc.)
#   - Homebrew + all active CLI tools (bat, eza, fzf, ripgrep, atuin, starship,
#     fresh-editor, hunk, fastfetch, lazygit, superfile, btop, llmfit, models,
#     opencode, pi-coding-agent, stow, uv, etc.)
#   - Vite+ runtime manager (https://vite.plus)
#   - Bun runtime + Oh-My-Pi (omp) & Pi agent configurations
#   - Python tooling via uv (https://docs.astral.sh/uv/)
#   - Herdr workspace manager (https://herdr.dev) + config
#   - WezTerm configuration (.wezterm.lua)
#   - Opencode AI agent configurations
#   - All global skills (SKILL.md definitions from npx skills)
#   - Full configuration sync via GNU Stow & Git
# ==============================================================================

set -euo pipefail

# Visual log helpers
log_info()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$*"; }
log_ok()    { printf "\033[1;32m[OK]\033[0m %s\n" "$*"; }
log_warn()  { printf "\033[1;33m[WARN]\033[0m %s\n" "$*"; }
log_err()   { printf "\033[1;31m[ERROR]\033[0m %s\n" "$*"; }

# ------------------------------------------------------------------------------
# 1. Environment & Sanity Checks
# ------------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  log_err "Do not run this script directly as root. Run as a regular user with sudo access."
  exit 1
fi

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.dotfiles_backup/$(date +%Y%m%d_%H%M%S)"

log_info "Dotfiles directory: $DOTFILES_DIR"
log_info "Starting system setup..."

# ------------------------------------------------------------------------------
# 2. APT System Update & Base Essentials
# ------------------------------------------------------------------------------
log_info "Updating apt repositories and installing base packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y \
  build-essential \
  curl \
  file \
  git \
  procps \
  stow \
  ca-certificates

log_ok "Base APT packages installed."

# ------------------------------------------------------------------------------
# 3. Homebrew Installation & Environment
# ------------------------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1 && [ ! -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
  log_info "Installing Homebrew (Linuxbrew)..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Load brew into current shell environment
if [ -d "/home/linuxbrew/.linuxbrew" ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
elif [ -d "$HOME/.linuxbrew" ]; then
  eval "$("$HOME/.linuxbrew/bin/brew" shellenv)"
fi

if ! command -v brew >/dev/null 2>&1; then
  log_err "Homebrew could not be located in PATH after installation."
  exit 1
fi
log_ok "Homebrew is available at: $(which brew)"

# ------------------------------------------------------------------------------
# 4. Homebrew CLI Packages Installation
# (Includes pi-coding-agent, opencode, stow, uv; excludes ghostty, deja, tuios)
# ------------------------------------------------------------------------------
BREW_PACKAGES=(
  atuin
  bat
  btop
  chafa
  eza
  fastfetch
  fd
  fish
  fresh-editor
  fzf
  gh
  hunk
  jq
  lazygit
  llmfit
  models
  neovim
  opencode
  pi-coding-agent
  ripgrep
  rustup
  starship
  stow
  superfile
  tealdeer
  uv
  zoxide
)

log_info "Installing CLI tools via Homebrew..."
brew install "${BREW_PACKAGES[@]}"
log_ok "Homebrew formulas installed."

# Initialize tealdeer cache
if command -v tldr >/dev/null 2>&1; then
  tldr --update 2>/dev/null || true
fi

# Fallback check for uv
if ! command -v uv >/dev/null 2>&1; then
  log_info "Installing uv (astral.sh/uv)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
log_ok "uv ready at: $(which uv 2>/dev/null || echo "$HOME/.local/bin/uv")"

# ------------------------------------------------------------------------------
# 5. Vite+ Installation & pnpm Runtime Management (Default)
# ------------------------------------------------------------------------------
if [ ! -d "$HOME/.local/share/vite-plus" ] && ! command -v vp >/dev/null 2>&1; then
  log_info "Installing Vite+ (https://vite.plus)..."
  curl -fsSL https://vite.plus | bash
fi

if [ -f "$HOME/.config/vite-plus/env" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.config/vite-plus/env"
elif [ -d "$HOME/.local/share/vite-plus/bin" ]; then
  export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
fi

log_info "Configuring Vite+ to manage pnpm by default..."
vp env on pnpm 2>/dev/null || true
vp env default pnpm@latest 2>/dev/null || true
vp env install pnpm@latest 2>/dev/null || true

# Configure pnpm environment and global bin directory
export VP_PACKAGE_MANAGER="pnpm@latest"
export PNPM_HOME="$HOME/.local/share/pnpm"
mkdir -p "$HOME/.local/bin" "$PNPM_HOME"
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.local/bin:$PNPM_HOME:$PATH"
if command -v pnpm >/dev/null 2>&1; then
  pnpm config set global-bin-dir "$HOME/.local/bin" 2>/dev/null || true
fi
log_ok "pnpm runtime ready via Vite+ ($(pnpm --version 2>/dev/null || echo 'managed'))."

# ------------------------------------------------------------------------------
# 6. AI Agents: Pi & Oh-My-Pi (omp)
# ------------------------------------------------------------------------------
# Note: pi-coding-agent binary ('pi') is installed via Homebrew.
# Oh-My-Pi ('omp') is installed via pnpm below.
log_info "Installing Oh-My-Pi (omp) globally via pnpm..."
if command -v pnpm >/dev/null 2>&1; then
  pnpm add -g @oh-my-pi/pi-coding-agent || true
fi
log_ok "AI Agents ready: pi, opencode, omp."

# ------------------------------------------------------------------------------
# 7. Herdr Installation (https://herdr.dev)
# ------------------------------------------------------------------------------
if ! command -v herdr >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/herdr" ]; then
  log_info "Installing Herdr terminal workspace manager (https://herdr.dev)..."
  curl -fsSL https://herdr.dev/install.sh | bash || true
fi
log_ok "Herdr ready at: $(which herdr 2>/dev/null || echo "$HOME/.local/bin/herdr")"
# ------------------------------------------------------------------------------
# 8. GNU Stow Dotfiles Deployment
# ------------------------------------------------------------------------------
STOW_PACKAGES=(
  bash
  fish
  git
  starship
  atuin
  btop
  fastfetch
  fresh
  herdr
  hunk
  lazygit
  opencode
  superfile
  vite-plus
  pi
  omp
  skills
  wezterm
)

log_info "Deploying configs using GNU Stow..."

# Function to back up conflicting files before stowing
backup_if_conflict() {
  local pkg="$1"
  cd "$DOTFILES_DIR/$pkg"
  find . -type f | while read -r rel_file; do
    rel_path="${rel_file#./}"
    target_path="$HOME/$rel_path"
    if [ -e "$target_path" ] && [ ! -L "$target_path" ]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$rel_path")"
      log_warn "Backing up existing non-symlink: $target_path -> $BACKUP_DIR/$rel_path"
      mv "$target_path" "$BACKUP_DIR/$rel_path"
    fi
  done
  cd "$DOTFILES_DIR"
}

cd "$DOTFILES_DIR"
for pkg in "${STOW_PACKAGES[@]}"; do
  if [ -d "$DOTFILES_DIR/$pkg" ]; then
    log_info "Stowing package: $pkg"
    backup_if_conflict "$pkg"
    stow -v -R -t "$HOME" "$pkg"
  fi
done
log_ok "All dotfiles stowed successfully."

# ------------------------------------------------------------------------------
# 9. Skills & Agent Symlinks Sync
# ------------------------------------------------------------------------------
log_info "Verifying skills and agent symlinks..."
mkdir -p "$HOME/.pi/skills" "$HOME/.pi/agent/skills"
if [ -d "$HOME/.agents/skills" ]; then
  for skill_dir in "$HOME/.agents/skills"/*; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    ln -sfn "$skill_dir" "$HOME/.pi/skills/$skill_name"
    ln -sfn "$skill_dir" "$HOME/.pi/agent/skills/$skill_name"
  done
  log_ok "Global skills linked to Pi and Oh-My-Pi."
fi

# ------------------------------------------------------------------------------
# 10. Oh-My-Pi Plugins Setup
# ------------------------------------------------------------------------------
if [ -d "$HOME/.omp/plugins" ] && [ -f "$HOME/.omp/plugins/package.json" ]; then
  log_info "Installing Oh-My-Pi plugins via pnpm..."
  (cd "$HOME/.omp/plugins" && (pnpm install 2>/dev/null || true))
  log_ok "Oh-My-Pi plugins installed."
fi

# ------------------------------------------------------------------------------
# 11. Default Shell Setup (Fish)
# ------------------------------------------------------------------------------
FISH_BIN="$(which fish 2>/dev/null || echo "/home/linuxbrew/.linuxbrew/bin/fish")"
if [ -x "$FISH_BIN" ]; then
  if ! grep -q "^$FISH_BIN$" /etc/shells; then
    log_info "Adding $FISH_BIN to /etc/shells..."
    echo "$FISH_BIN" | sudo tee -a /etc/shells >/dev/null
  fi

  CURRENT_SHELL="$(getent passwd "$USER" | cut -d: -f7)"
  if [ "$CURRENT_SHELL" != "$FISH_BIN" ]; then
    log_info "Setting default login shell to $FISH_BIN for $USER..."
    sudo chsh -s "$FISH_BIN" "$USER" || chsh -s "$FISH_BIN" || true
  fi
  export SHELL="$FISH_BIN"
  log_ok "Default login shell configured: $FISH_BIN"
fi

# ------------------------------------------------------------------------------
# 12. Completion Summary
# ------------------------------------------------------------------------------
echo ""
printf "\033[1;32m===============================================================\033[0m\n"
printf "\033[1;32m  Machine Bootstrap & Config Sync Complete!                   \033[0m\n"
printf "\033[1;32m===============================================================\033[0m\n"
echo "Active environment features:"
echo "  - Homebrew prefix: $(brew --prefix 2>/dev/null || echo '/home/linuxbrew/.linuxbrew')"
echo "  - Brew CLI tools: bat, eza, fd, ripgrep, atuin, starship, fresh, lazygit, superfile, stow, uv, opencode, pi-coding-agent, etc."
echo "  - Python manager: uv (pip/venv/run/build)"
echo "  - Terminal multiplexer: herdr (with custom keybinds & Catppuccin theme)"
echo "  - Terminal emulator config: wezterm (.wezterm.lua)"
echo "  - Editor: fresh (fresh-editor)"
echo "  - Runtimes: vite+ (vp), node, pnpm (pnpm-first, managed by vite+)"
echo "  - AI Agents: pi, opencode, oh-my-pi (omp) with synced models, plugins & skills"
echo "  - Skills: imported into ~/.agents/skills and linked to pi"
echo "  - Shell: fish with custom aliases, abbreviations, and starship prompt"
echo ""
if [ -d "$BACKUP_DIR" ]; then
  echo "Pre-existing files were backed up to: $BACKUP_DIR"
fi
echo "To enter your new shell immediately, run:"
echo "  exec fish"
echo ""
