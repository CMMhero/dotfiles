#!/usr/bin/env bash
# ==============================================================================
# uninstall.sh - Resets the machine back to its pre-install.sh state.
#
# Removes every config deployed by GNU Stow, reverts to the distro-default
# login shell, and (with --purge) uninstalls all packages installed by
# install.sh, then deletes the dotfiles repo.
#
# Usage:
#   ./uninstall.sh              # unstow configs, restore default shell, keep packages
#   ./uninstall.sh --purge      # also uninstall brew formulas + apt packages
#   ./uninstall.sh --purge --yes  # non-interactive (no confirmation prompts)
#
# WARNING: --purge removes CLI tools, brew, vite+ runtimes, herdr, and the pi /
# omp / opencode agent configs. Existing data in ~/.local/share (atuin history,
# claude/opencode sessions, pnpm store) is preserved unless --purge-data is passed.
# ==============================================================================

set -euo pipefail

# Visual log helpers
log_info()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$*"; }
log_ok()    { printf "\033[1;32m[OK]\033[0m %s\n" "$*"; }
log_warn()  { printf "\033[1;33m[WARN]\033[0m %s\n" "$*"; }
log_err()   { printf "\033[1;31m[ERROR]\033[0m %s\n" "$*"; }

PURGE=0
PURGE_DATA=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --purge)      PURGE=1 ;;
    --purge-data) PURGE=1; PURGE_DATA=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --help|-h)    sed -n '2,16p' "$0"; exit 0 ;;
    *)            log_err "Unknown option: $arg"; exit 1 ;;
  esac
done

# ------------------------------------------------------------------------------
# 1. Locate the dotfiles repo
# ------------------------------------------------------------------------------
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
DOTFILES_REPO="https://github.com/CMMhero/dotfiles.git"
DOTFILES_DIR="$HOME/dotfiles"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || echo "")"

if [ ! -d "$SCRIPT_DIR/.git" ] || [ "$SCRIPT_DIR" != "$DOTFILES_DIR" ]; then
  if [ ! -d "$DOTFILES_DIR" ]; then
    log_err "No dotfiles repo found at $DOTFILES_DIR and no local copy of this script."
    log_err "Clone it first: git clone $DOTFILES_REPO $DOTFILES_DIR"
    exit 1
  fi
  exec "$DOTFILES_DIR/uninstall.sh" "$@"
fi

DOTFILES_DIR="$SCRIPT_DIR"

# Same package list install.sh deploys (wezterm is Windows-only, never stowed).
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
  go
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

APT_PACKAGES=(
  build-essential
  curl
  file
  git
  procps
  stow
  ca-certificates
)

if [ "$(id -u)" -eq 0 ]; then
  log_err "Do not run this script as root. Run as a regular user with sudo access."
  exit 1
fi

log_info "Dotfiles directory: $DOTFILES_DIR"

# ------------------------------------------------------------------------------
# 2. Confirmation
# ------------------------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  log_warn "This will remove the following stowed configs:"
  printf '  %s\n' "${STOW_PACKAGES[@]}"
  echo ""
  if [ "$PURGE" -eq 1 ]; then
    log_warn "--purge is set: Homebrew formulas, apt packages, vite+, herdr, and global npm/pnpm packages will also be removed."
  fi
  echo ""
  read -r -p "Continue? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) log_info "Aborted."; exit 0 ;;
  esac
fi
# ------------------------------------------------------------------------------
# 3. Unstow configs (GNU Stow)
# ------------------------------------------------------------------------------
# NOTE: do not combine -D with -R. GNU stow keeps only the last mode flag, so
# `-D -R` degrades into a restow and silently unlinks nothing.
if command -v stow >/dev/null 2>&1; then
  log_info "Unstowing dotfiles packages..."
  cd "$DOTFILES_DIR"
  for pkg in "${STOW_PACKAGES[@]}"; do
    if [ -d "$DOTFILES_DIR/$pkg" ]; then
      if stow -v -D -t "$HOME" "$pkg" 2>/dev/null; then
        log_ok "Unstowed: $pkg"
      else
        log_warn "Could not unstow $pkg (was it ever stowed?)"
      fi
    fi
  done
else
  log_warn "stow not found in PATH; skipping unstow step."
fi

# omp is linked file-by-file rather than stowed (install.sh explains why), so it
# is unlinked the same way. Only the three managed files are removed; every
# directory under ~/.omp, and all per-machine state inside it, is left alone.
OMP_MANAGED_FILES=(
  .omp/agent/config.yml
  .omp/plugins/package.json
  .omp/agent/extensions/opencode-zen-fix.ts
)
log_info "Unlinking managed omp files..."
for rel in "${OMP_MANAGED_FILES[@]}"; do
  target="$HOME/$rel"
  if [ -L "$target" ]; then
    rm -f "$target"
    log_ok "Unlinked omp: $rel"
  fi
done
# Drop directories left empty by the unlink, never the ones holding real files.
find "$HOME/.omp" -depth -type d -empty -delete 2>/dev/null || true

# Remove now-empty config dirs left behind by stow (e.g. ~/.config/superfile)
log_info "Cleaning up empty config directories..."
find "$HOME/.config" -maxdepth 1 -mindepth 1 -type d -empty -delete 2>/dev/null || true


# ------------------------------------------------------------------------------
# 4. Restore default login shell (bash)
# ------------------------------------------------------------------------------
DEFAULT_SHELL="$(getent passwd "$USER" | cut -d: -f7)"
log_info "Restoring default login shell to $DEFAULT_SHELL ..."
if [ -x "$DEFAULT_SHELL" ] && [ "$DEFAULT_SHELL" != "$(command -v fish 2>/dev/null || echo "$DEFAULT_SHELL")" ]; then
  sudo chsh -s "$DEFAULT_SHELL" "$USER" || chsh -s "$DEFAULT_SHELL" || log_warn "Could not change shell automatically; run: chsh -s $DEFAULT_SHELL"
  log_ok "Default shell restored: $DEFAULT_SHELL"
else
  log_info "Shell already set to $DEFAULT_SHELL"
fi

# ------------------------------------------------------------------------------
# 5. Purge packages (optional)
# ------------------------------------------------------------------------------
if [ "$PURGE" -eq 1 ]; then
  # ---- Homebrew formulas ----
  if command -v brew >/dev/null 2>&1 || [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv 2>/dev/null || true)"
    log_info "Uninstalling Homebrew formulas..."
    brew uninstall --ignore-dependencies "${BREW_PACKAGES[@]}" 2>/dev/null || true
    log_ok "Homebrew formulas removed."
  else
    log_warn "Homebrew not found; skipping formula purge."
  fi

  # ---- Global pnpm packages (oh-my-pi) ----
  if command -v pnpm >/dev/null 2>&1; then
    log_info "Removing global pnpm packages (oh-my-pi)..."
    pnpm remove -g @oh-my-pi/pi-coding-agent 2>/dev/null || true
  fi

  # ---- herdr ----
  if [ -x "$HOME/.local/bin/herdr" ]; then
    log_info "Removing herdr binary..."
    rm -f "$HOME/.local/bin/herdr"
  fi

  # ---- Vite+ ----
  if [ -d "$HOME/.local/share/vite-plus" ]; then
    log_info "Removing Vite+ runtimes..."
    rm -rf "$HOME/.local/share/vite-plus"
  fi

  # ---- apt packages ----
  log_info "Removing apt packages..."
  sudo apt-get remove -y --purge "${APT_PACKAGES[@]}" 2>/dev/null || true
  sudo apt-get autoremove -y 2>/dev/null || true

  # ---- oh-my-pi / pi / opencode data dirs ----
  # ~/.agents and ~/skills-lock.json are deliberately NOT touched: skills are
  # not managed by this repo, so that data belongs to the user, not to us.
  if [ "$PURGE_DATA" -eq 1 ]; then
    log_warn "--purge-data: removing agent data (~/.pi, ~/.omp, ~/.opencode)..."
    rm -rf "$HOME/.pi" "$HOME/.omp" "$HOME/.opencode"
  fi
fi

# ------------------------------------------------------------------------------
# 6. Move out of the repo, then remove it
# ------------------------------------------------------------------------------
# `cd "$HOME"` moves this script, not the shell that invoked it. If the caller's
# cwd is inside the repo, deleting it leaves their shell on a path that no
# longer exists: the prompt keeps working but `pwd`, tab-completion, and every
# relative path break with "getcwd: No such file or directory". There is no way
# for a child script to change its parent's cwd, so detect it and say so BEFORE
# deleting, rather than leaving a silently broken shell.
CWD_REAL="$(pwd -P 2>/dev/null || pwd 2>/dev/null || echo "")"
DOTFILES_REAL="$(cd "$DOTFILES_DIR" 2>/dev/null && pwd -P || echo "$DOTFILES_DIR")"

if [ -n "$CWD_REAL" ] && [ -n "$DOTFILES_REAL" ]; then
  case "$CWD_REAL" in
    "$DOTFILES_REAL"/*)
      log_warn "your shell's working directory is inside the repo:"
      log_warn "    $CWD_REAL"
      log_warn "It cannot be changed from this script. After this finishes, run:"
      log_warn "    cd ~"
      ;;
  esac
fi

log_info "Removing dotfiles repository at $DOTFILES_DIR ..."
cd "$HOME" || cd /
rm -rf "$DOTFILES_DIR"
echo ""
printf "\033[1;32m===============================================================\033[0m\n"
printf "\033[1;32m  Uninstall Complete.                                        \033[0m\n"
printf "\033[1;32m===============================================================\033[0m\n"
echo "Stowed configs removed; default login shell restored."
if [ "$PURGE" -eq 1 ]; then
  echo "Packages purged (brew formulas, apt packages, vite+, herdr, global pnpm)."
  [ "$PURGE_DATA" -eq 1 ] && echo "Agent data removed (~/.pi, ~/.omp, ~/.opencode). ~/.agents and ~/skills-lock.json left alone."
fi
echo "Dotfiles repo deleted."
echo ""
echo "Open a new terminal (or run 'exec \$SHELL') to pick up the default shell."
echo ""
