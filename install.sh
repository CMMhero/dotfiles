#!/usr/bin/env bash
# ==============================================================================
# install.sh - Single entrypoint: clones/updates the dotfiles repo, installs
# every package, and deploys all configs with GNU Stow on a fresh Ubuntu box.
#
# Usage:
#   # from a fresh machine (no repo yet)
#   curl -fsSL https://raw.githubusercontent.com/CMMhero/dotfiles/main/install.sh | bash
#
#   # or clone first
#   git clone https://github.com/CMMhero/dotfiles.git ~/dotfiles
#   cd ~/dotfiles && ./install.sh
#
# Exclusions (per user request):
#   - ghostty, deja, tuios, zsh, marksman, pipx, thefuck, zinit, bun
#   - wezterm config is kept in-repo for reference but never stowed (Windows-only)
#   - bash, pi, and opencode configs are NOT managed here; each is left alone on disk
#   - skills are not managed at all (~/.agents/skills stays per-machine)
#
# Installed:
#   - APT base tools (build-essential, git, curl, stow, procps, file, ...)
#   - Homebrew + CLI tools (bat, eza, fzf, ripgrep, atuin, starship,
#     fresh-editor, hunk, fastfetch, lazygit, superfile, btop, llmfit, models,
#     opencode, pi-coding-agent, stow, uv, go, ...)
#   - Vite+ with pnpm as the managed default package manager
#   - Oh-My-Pi (omp) via pnpm; pi + opencode via Homebrew
#   - Herdr workspace manager (https://herdr.dev)
#   - Configs deployed with GNU Stow; fish set as the default login shell
# ==============================================================================

set -euo pipefail

# Visual log helpers
log_info()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$*"; }
log_ok()    { printf "\033[1;32m[OK]\033[0m %s\n" "$*"; }
log_warn()  { printf "\033[1;33m[WARN]\033[0m %s\n" "$*"; }
log_err()   { printf "\033[1;31m[ERROR]\033[0m %s\n" "$*"; }

# ------------------------------------------------------------------------------
# 1. Clone / Update the dotfiles repository
# ------------------------------------------------------------------------------
DOTFILES_REPO="https://github.com/CMMhero/dotfiles.git"
DOTFILES_DIR="$HOME/dotfiles"
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"

# When piped from curl there is no repo on disk yet, so clone it and re-exec
# the real checkout's install.sh so every later path resolves inside the repo.
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || echo "")"
if [ ! -d "$SCRIPT_DIR/.git" ] || [ "$SCRIPT_DIR" != "$DOTFILES_DIR" ]; then
  if [ ! -d "$DOTFILES_DIR" ]; then
    log_info "Cloning dotfiles repository from $DOTFILES_REPO ..."
    git clone "$DOTFILES_REPO" "$DOTFILES_DIR"
  else
    log_info "Dotfiles already cloned, pulling latest..."
    git -C "$DOTFILES_DIR" pull --ff-only
  fi
  exec "$DOTFILES_DIR/install.sh" "$@"
fi

DOTFILES_DIR="$SCRIPT_DIR"
BACKUP_DIR="$HOME/.dotfiles_backup/$(date +%Y%m%d_%H%M%S)"

# ------------------------------------------------------------------------------
# 2. Sanity Checks
# ------------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  log_err "Do not run this script directly as root. Run as a regular user with sudo access."
  exit 1
fi


# ------------------------------------------------------------------------------
# Hand off to fish, guaranteed.
# ------------------------------------------------------------------------------
# Registered as an EXIT trap rather than placed at the end of the script
# because this runs under `set -euo pipefail`: any non-zero command earlier on
# (a stow conflict, a failing sudo apt-get, `brew cleanup` returning non-zero)
# aborts the script right there and the final `exec` is never reached -- leaving
# the user in a shell with the old config and no explanation. An EXIT trap fires
# on success, on `set -e` abort, and on an explicit exit alike.
FISH_HANDED_OFF=0
handoff_to_fish() {
  local rc=$?
  # Never take over the shell for a non-interactive run (CI, a script calling
  # this, or output piped somewhere): an interactive login shell would hang.
  [ "$rc" -eq 0 ] || log_warn "install.sh exited with status $rc; reloading fish anyway."
  [ -t 1 ] || return $rc
  [ "$FISH_HANDED_OFF" -eq 1 ] && return $rc
  [ -x "$FISH_EXEC_BIN" ] || return $rc
  FISH_HANDED_OFF=1
  trap - EXIT
  echo ""
  echo "Reloading fish with the new config..."
  exec "$FISH_EXEC_BIN" -l
}
FISH_EXEC_BIN="$(command -v fish 2>/dev/null || echo /home/linuxbrew/.linuxbrew/bin/fish)"
trap handoff_to_fish EXIT

log_info "Dotfiles directory: $DOTFILES_DIR"
log_info "Starting system setup..."

# ------------------------------------------------------------------------------
# 3. APT System Update & Base Essentials
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
# 4. Homebrew Installation & Environment
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
# 5. Homebrew CLI Packages Installation
# (Includes pi-coding-agent, opencode, stow, uv; excludes ghostty, deja, tuios)
# ------------------------------------------------------------------------------
BREW_PACKAGES=(
  atuin
  bat
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
  go
  hunk
  jq
  lazygit
  llmfit
  models
  neovim
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
# 6. Vite+ Installation & pnpm Runtime Management (Default)
# ------------------------------------------------------------------------------
# Non-interactive install. The curl|bash bootstrap only forwards these to the
# installed `vp` binary's self-setup, which is what actually asks the
# "manage Node.js with Vite+?" question (it reads stdin from /dev/tty).
# Setting them to "yes" makes it accept managed mode without a TTY, so this
# works over SSH, in CI, and from a piped one-liner.
if [ ! -d "$HOME/.local/share/vite-plus" ] && ! command -v vp >/dev/null 2>&1; then
  log_info "Installing Vite+ (https://vite.plus) with managed Node.js + pnpm..."
  VP_NODE_MANAGER=yes \
  VP_NPM_MANAGER=yes \
  VP_PNPM_MANAGER=yes \
  VP_YARN_MANAGER=yes \
  VP_BUN_MANAGER=yes \
  VP_SELF_SETUP_SHELL=sh \
    curl -fsSL https://vite.plus | bash
fi

if [ -f "$HOME/.config/vite-plus/env" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.config/vite-plus/env"
elif [ -d "$HOME/.local/share/vite-plus/bin" ]; then
  export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
fi

log_info "Enabling Vite+ managed mode for Node.js and package managers..."
VP_NODE_MANAGER=yes vp env on 2>/dev/null || vp env on 2>/dev/null || true
log_info "Setting pnpm as the default managed package manager..."
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
# 7. AI Agents: Pi & Oh-My-Pi (omp)
# ------------------------------------------------------------------------------
# Note: pi-coding-agent binary ('pi') is installed via Homebrew.
# Oh-My-Pi ('omp') is installed via pnpm below.
log_info "Installing Oh-My-Pi (omp) globally via pnpm..."
if command -v pnpm >/dev/null 2>&1; then
  pnpm add -g @oh-my-pi/pi-coding-agent || true
fi
log_ok "AI Agents ready: pi, opencode, omp."

# ------------------------------------------------------------------------------
# 8. Herdr Installation (https://herdr.dev)
# ------------------------------------------------------------------------------
if ! command -v herdr >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/herdr" ]; then
  log_info "Installing Herdr terminal workspace manager (https://herdr.dev)..."
  curl -fsSL https://herdr.dev/install.sh | bash || true
fi
log_ok "Herdr ready at: $(which herdr 2>/dev/null || echo "$HOME/.local/bin/herdr")"
# ------------------------------------------------------------------------------
# 9. GNU Stow Dotfiles Deployment
# ------------------------------------------------------------------------------
# NOTE: `wezterm` is deliberately absent. Its config targets the Windows build
# (WSL domain, pwsh default_prog, Acrylic backdrop, win32_system_backdrop), so
# it is version-controlled in this repo for reference but never linked into $HOME
# on Linux and never installed via brew.
STOW_PACKAGES=(
  fish
  git
  starship
  atuin
  bat
  btop
  fastfetch
  fresh
  herdr
  hunk
  lazygit
  superfile
  vite-plus
)

# omp is NOT stowed. GNU Stow links a whole directory whenever that directory
# contains files, and ~/.omp is exactly the wrong thing to link wholesale:
# sessions/, agent.db, stats.db, cache/, logs/, run/, install-id and
# plugins/node_modules all live under it and are per-machine. On a fresh
# install (no existing ~/.omp) `stow omp` created ~/.omp as a single symlink
# pointing into this repo, which would have pulled all of that runtime state
# into the git working tree. Splitting the package into one-per-subtree did not
# help either: .omp/plugins and .omp/agent/extensions still got linked whole,
# so `pnpm install` would still write node_modules and its lockfile into the
# repo through the link.
#
# So only these three files are linked, by hand, and every directory around them
# is created as a real directory.
OMP_MANAGED_FILES=(
  .omp/agent/config.yml
  .omp/plugins/package.json
  .omp/agent/extensions/opencode-zen-fix.ts
)

link_omp_files() {
  local rel target src
  for rel in "${OMP_MANAGED_FILES[@]}"; do
    src="$DOTFILES_DIR/omp/$rel"
    target="$HOME/$rel"
    [ -f "$src" ] || { log_warn "omp: missing in repo, skipped: $rel"; continue; }

    # Real parent dirs, never links.
    mkdir -p "$(dirname "$target")"

    if [ -L "$target" ]; then
      # Already linked: refresh it in case the repo file moved.
      rm -f "$target"
    elif [ -e "$target" ]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
      log_warn "Backing up existing omp file: $target"
      mv "$target" "$BACKUP_DIR/$rel"
    fi

    ln -s "$src" "$target"
    log_ok "omp linked: $rel"
  done
}

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
log_ok "Stow packages deployed."

log_info "Linking managed omp files (not stowed - see note above)..."
link_omp_files

# ------------------------------------------------------------------------------
# 10. Oh-My-Pi Plugins Setup
# ------------------------------------------------------------------------------
# NOTE: skills are not managed at all. ~/.agents/skills and ~/skills-lock.json
# stay per-machine, as do the opencode/pi/omp skill directories -- each agent
# manages its own installs via the `skills` wrapper (pnpm dlx, global by default).
#
# The `omp` stow package is deliberately narrow: only agent/config.yml and
# plugins/package.json are linked. ~/.omp also holds per-machine state
# (sessions/, run/, logs/, cache/, stats.db, install-id, and the plugins
# node_modules) which must never come from the repo. Stow folds into the
# existing ~/.omp tree instead of replacing it, so those stay real files.
if [ -d "$HOME/.omp/plugins" ] && [ -f "$HOME/.omp/plugins/package.json" ]; then
  log_info "Installing Oh-My-Pi plugins via pnpm..."
  (cd "$HOME/.omp/plugins" && (pnpm install 2>/dev/null || true))
  log_ok "Oh-My-Pi plugins installed."
fi

# ------------------------------------------------------------------------------
# 11. Fresh Editor Packages (plugins / themes / languages)
# ------------------------------------------------------------------------------
# The fresh package tree is stowed from the repo, but fresh keeps a private
# registry cache under ~/.config/fresh/plugins/packages/.index and .cache.
# Those are fetched artifacts, not config, so they are gitignored; a fresh
# install therefore needs the registry re-fetched once to resolve the packages
# that were stowed by reference.
FRESH_DIR="$HOME/.config/fresh"
if [ -d "$FRESH_DIR/plugins/packages" ] || [ -d "$FRESH_DIR/themes/packages" ]; then
  log_info "Refreshing fresh package registry..."
  fresh --cmd update >/dev/null 2>&1 || log_warn "fresh --cmd update failed; stowed packages still apply."

  log_info "Verifying stowed fresh packages..."
  for kind in plugins themes languages; do
    src="$DOTFILES_DIR/fresh/.config/fresh/$kind/packages"
    [ -d "$src" ] || continue
    for pkg in "$src"/*/; do
      [ -d "$pkg" ] || continue
      name="$(basename "$pkg")"
      if [ -d "$FRESH_DIR/$kind/packages/$name" ]; then
        log_ok "  $kind/$name"
      fi
    done
  done
fi

# fresh generates its API type definitions at runtime (`fresh --cmd script types`).
# They are not config and are not stowed, but the stowed tsconfig.json and
# init.ts both reference them, so regenerate them after stowing. Without this a
# fresh install has dangling `/// <reference>` paths in init.ts.
if command -v fresh >/dev/null 2>&1; then
  log_info "Regenerating fresh API type definitions..."
  fresh --cmd script types >/dev/null 2>&1 || log_warn "Could not regenerate fresh types (editor-only nicety)."

  log_info "Validating fresh init.ts..."
  fresh --cmd init check >/dev/null 2>&1 \
    && log_ok "fresh init.ts ok." \
    || log_warn "fresh init check failed; run 'fresh --safe' to diagnose."
fi

# ------------------------------------------------------------------------------
# 12. Default Shell Setup (Fish)
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
# 13. Post-Install: Account Logins & Cache Warmup
# ------------------------------------------------------------------------------
# Everything here that can be done without a browser or a password prompt is
# done automatically. Whatever needs interactive auth is reported at the end
# instead of being silently skipped.

MANUAL_STEPS=()

# --- tealdeer page cache -----------------------------------------------------
if command -v tldr >/dev/null 2>&1; then
  log_info "Warming tealdeer (tldr) page cache..."
  if tldr --update >/dev/null 2>&1; then
    log_ok "tealdeer pages cached."
  else
    log_warn "tldr --update failed; run 'tldr --update' manually."
  fi
fi

# --- atuin: register + sync --------------------------------------------------
# atuin needs `atuin register` (username/password) on a new machine, which
# cannot be automated without a TTY. If a key already exists we can sync.
if command -v atuin >/dev/null 2>&1; then
  if [ -s "$HOME/.local/share/atuin/key" ]; then
    log_info "atuin key found; syncing history..."
    if atuin sync >/dev/null 2>&1; then
      log_ok "atuin synced."
    else
      log_warn "atuin sync failed; run 'atuin login' then 'atuin sync'."
      MANUAL_STEPS+=("atuin login && atuin sync   # sync shell history")
    fi
  else
    log_warn "atuin is not registered on this machine yet."
    MANUAL_STEPS+=("atuin register               # create/sync your atuin account")
  fi
fi

# --- GitHub CLI --------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    log_ok "gh already authenticated ($(gh api user --jq .login 2>/dev/null || echo 'unknown'))."
  else
    log_warn "gh is not authenticated."
    MANUAL_STEPS+=("gh auth login                # GitHub CLI")
  fi
fi

# --- AI agent credentials ----------------------------------------------------
# pi and omp read tokens from ~/.pi/agent/auth.json, which is gitignored and
# therefore never deployed. Each agent prompts for its own key on first run.
if [ ! -s "$HOME/.pi/agent/auth.json" ]; then
  MANUAL_STEPS+=("pi                            # first run prompts for your model provider key")
fi
if [ ! -s "$HOME/.config/opencode/opencode.json" ] && [ ! -s "$HOME/.opencode/auth.json" ]; then
  MANUAL_STEPS+=("opencode                      # first run prompts for your provider key")
fi

# --- atuin sync is enabled in the shell config -------------------------------
# ~/.config/atuin/config.toml ships with [daemon] autostart = true and
# auto_sync commented out; verify the shell actually sources atuin.
if grep -q "atuin init" "$HOME/.config/fish/config.fish" 2>/dev/null; then
  log_ok "atuin is wired into fish (atuin init fish)."
else
  log_warn "atuin is not initialised in ~/.config/fish/config.fish."
fi

# ------------------------------------------------------------------------------
# 14. Completion Summary
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
echo "  - Terminal emulator config: wezterm (.wezterm.lua, Windows-only; in repo, not stowed on Linux)"
echo "  - Editor: fresh (fresh-editor) with catppuccin theme, color-highlighter plugin, vi-mode + toggle"
echo "  - Runtimes: vite+ (vp), node, pnpm (pnpm-first, managed by vite+)"
echo "  - AI Agents: pi, opencode, oh-my-pi (omp) installed via brew/pnpm; configs NOT stowed"
echo "  - Skills: not managed; install with 'skills add <pkg>' (pnpm dlx, global)"
echo "  - Shell: fish with custom aliases, abbreviations, and starship prompt"
echo ""

if [ "${#MANUAL_STEPS[@]}" -gt 0 ]; then
  printf "\033[1;33m===============================================================\033[0m\n"
  printf "\033[1;33m  Remaining Manual Steps                                     \033[0m\n"
  printf "\033[1;33m===============================================================\033[0m\n"
  echo "These need a browser, password, or first-run prompt:"
  echo ""
  for step in "${MANUAL_STEPS[@]}"; do
    echo "  - $step"
    echo ""
  done
else
  printf "\033[1;32m  All account logins already configured on this machine.\033[0m\n"
  echo ""
fi
if [ -d "$BACKUP_DIR" ]; then
  echo "Pre-existing files were backed up to: $BACKUP_DIR"
fi

# Pre-flight the fish config. `fish -n` parses without executing, so a syntax
# error is reported here -- with its file and line -- instead of scrolling past
# inside the shell the user is about to be dropped into. The usual cause is a
# bash-ism (VAR="x", [ ... ], foo=) left in config.fish or a conf.d snippet;
# fish rejects those outright and skips the rest of the file.
if command -v fish >/dev/null 2>&1; then
  FISH_ERR_FILE="$(mktemp)"
  FISH_BAD=0
  while IFS= read -r fish_file; do
    # </dev/null is deliberate: fish inherits this script's stdin, which under
    # `curl ... | bash` is the pipe feeding the script itself. fish can block
    # reading it ("read: interrupted") and the install appears to hang.
    # Detaching guarantees it only parses and exits.
    if ! fish -n "$fish_file" </dev/null 2>"$FISH_ERR_FILE"; then
      [ "$FISH_BAD" -eq 0 ] && log_warn "fish config has a syntax error:"
      FISH_BAD=1
      sed 's/^/    /' "$FISH_ERR_FILE"
    fi
  done < <(find "$HOME/.config/fish" -name '*.fish' -type f 2>/dev/null | sort)
  rm -f "$FISH_ERR_FILE"
  if [ "$FISH_BAD" -eq 1 ]; then
    echo ""
    echo "  fish will still start, but the broken file is skipped."
    echo "  Fix the file(s) above, then run 'exec fish'."
    echo ""
  else
    log_ok "fish config syntax ok."
  fi
fi

# The fish handoff now lives in handoff_to_fish (an EXIT trap registered near
# the top), so it runs even when `set -e` aborts this script partway through.
# Nothing to do here; the trap fires when the script ends.
echo ""
