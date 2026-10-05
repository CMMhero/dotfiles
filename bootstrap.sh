#!/usr/bin/env bash
# ==============================================================================
# bootstrap.sh - One-liner entrypoint for a fresh Ubuntu/Debian machine.
#
# Clones (or updates) this dotfiles repository and hands off to setup.sh,
# which installs packages and deploys the configs with GNU Stow.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/CMMhero/dotfiles/main/bootstrap.sh | bash
#   or
#   git clone https://github.com/CMMhero/dotfiles.git ~/dotfiles && ~/dotfiles/bootstrap.sh
# ==============================================================================

set -euo pipefail

DOTFILES_REPO="https://github.com/CMMhero/dotfiles.git"
DOTFILES_DIR="$HOME/dotfiles"

# Stow packages deployed by setup.sh
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

# --- Clone or update the dotfiles repository ---------------------------------
if [[ ! -d "$DOTFILES_DIR" ]]; then
  echo "Cloning dotfiles repository..."
  git clone "$DOTFILES_REPO" "$DOTFILES_DIR"
else
  echo "Dotfiles already cloned, pulling latest..."
  git -C "$DOTFILES_DIR" pull --ff-only
fi

cd "$DOTFILES_DIR" || exit 1

# --- Install packages + deploy configs ---------------------------------------
echo "Running setup.sh (installs Homebrew, CLI tools, runtimes, stows configs)..."
./setup.sh

# --- Confirm the stow deployment ---------------------------------------------
echo "Stowed packages:"
printf '  %s\n' "${STOW_PACKAGES[@]}"

echo "Default login shell:"
getent passwd "$USER" | cut -d: -f7

echo "Dotfiles setup complete!"
echo "Start a fresh shell with: exec fish"
