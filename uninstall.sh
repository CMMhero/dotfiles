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
#   ./uninstall.sh --purge      # also uninstall mise tools, brew formulas + apt packages
#   ./uninstall.sh --purge --yes  # non-interactive (no confirmation prompts)
#
# WARNING: --purge removes the mise tools, the mise and fish Homebrew formulas,
# the apt base packages, and the pi / omp / opencode agent configs.
#
# fish is the one exception: the purge refuses to remove it while it is still
# the account's login shell, and prints the two commands that do it safely.
#
# Agent data is NEVER deleted, by any flag. ~/.pi, ~/.omp, ~/.opencode and
# ~/.agents hold session history, credentials and caches that outlive the
# packages; removing them is irreversible and there is no override.
# ==============================================================================

set -euo pipefail

# Visual log helpers
# Output style matches the `upd` fish function so both read the same way:
#   ==> section heading      (apt/mise/dotfiles)
#     -> detail              (indented, for per-item progress)
#   [ok] / [warn] / [err]    (kept bracketed so they stand out when scrolled)
log_step() { printf "\033[1;32m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
log_info() { printf "   \033[0;36m->\033[0m %s\n" "$*"; }
log_ok()   { printf "   \033[1;32m[ok]\033[0m   %s\n" "$*"; }
log_warn() { printf "   \033[1;33m[warn]\033[0m %s\n" "$*"; }
log_err()  { printf "   \033[1;31m[err]\033[0m  %s\n" "$*"; }

PURGE=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --purge)      PURGE=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --purge-data)
      log_err "--purge-data has been removed: agent data is never deleted."
      log_err "Session history, credentials and caches under ~/.pi, ~/.omp,"
      log_err "~/.opencode and ~/.agents are yours and are always left intact."
      log_err "Use --purge to remove packages only."
      exit 1
      ;;
    --help|-h)    sed -n '2,18p' "$0"; exit 0 ;;
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

MISE_TOOLS=(
  # aqua backend
  "aqua:atuinsh/atuin"           # shell history
  "aqua:sharkdp/bat"             # cat replacement
  "aqua:aristocratos/btop"       # process viewer
  "aqua:eza-community/eza"       # ls replacement
  "aqua:fastfetch-cli/fastfetch" # system info
  "aqua:sharkdp/fd"              # find replacement
  "aqua:junegunn/fzf"            # fuzzy finder
  "aqua:cli/cli"                 # GitHub CLI
  "aqua:herdrdev/herdr"          # terminal multiplexer
  "aqua:modem-dev/hunk"          # diff viewer / git difftool
  "aqua:jqlang/jq"               # json processor
  "aqua:jesseduffield/lazygit"   # git TUI
  "aqua:neovim/neovim"           # editor
  "aqua:anomalyco/opencode"      # AI coding agent
  "aqua:earendil-works/pi"       # AI coding agent
  "aqua:BurntSushi/ripgrep"      # grep replacement
  "aqua:dandavison/delta"        # git-delta
  "aqua:starship/starship"       # prompt
  "aqua:yorukot/superfile"       # file manager
  "aqua:tealdeer-rs/tealdeer"    # tldr pages
  "aqua:astral-sh/uv"            # python tooling
  "aqua:ajeetdsouza/zoxide"      # cd jumper
  # github backend
  "github:hpjansson/chafa"       # image renderer
  "github:sinelaw/fresh"         # fresh editor
  "github:can1357/oh-my-pi"      # oh-my-pi (omp)
  # npm backend
  "npm:vite-plus"                # vite+ tool; its runtime/PM modes stay system_first
  # core backend
  "core:go"                      # go toolchain
  "core:rust"                    # rust toolchain
  "core:node"                    # node
  "core:pnpm"                    # pnpm
)

# Mirrors the apt set install.sh actually installs. fish is NOT here: it comes
# from Homebrew and is removed as a formula below. Listing it would only produce
# a spurious "Unable to locate package fish" on every purge.
APT_PACKAGES=(
  git
  stow
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
    log_warn "--purge is set: mise tools, the mise and fish formulas, apt packages, and global pnpm packages will also be removed."
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
  log_step "Unstowing dotfiles packages..."
  cd "$DOTFILES_DIR"
  for pkg in "${STOW_PACKAGES[@]}"; do
    [ -d "$DOTFILES_DIR/$pkg" ] || continue
    # Report what is about to be unlinked. Compared by resolved path rather than
    # test -L, because stow may have linked a whole directory: a file reached
    # through a symlinked parent is a real file and would fail a -L test.
    (cd "$pkg" && find . -type f | while read -r rel_file; do
      rel_path="${rel_file#./}"
      target_real="$(readlink -f "$HOME/$rel_path" 2>/dev/null || true)"
      src_real="$(readlink -f "$rel_file" 2>/dev/null || true)"
      if [ -n "$target_real" ] && [ "$target_real" = "$src_real" ]; then
        log_info "unlinked ~/$rel_path"
      fi
    done)
    if stow -D -t "$HOME" "$pkg" 2>/dev/null; then
      :
    else
      log_warn "Could not unstow $pkg (was it ever stowed?)"
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
log_step "Unlinking managed omp files..."
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
log_step "Cleaning up empty config directories..."
find "$HOME/.config" -maxdepth 1 -mindepth 1 -type d -empty -delete 2>/dev/null || true


# ------------------------------------------------------------------------------
# 4. Restore default login shell (bash)
# ------------------------------------------------------------------------------
DEFAULT_SHELL="$(getent passwd "$USER" | cut -d: -f7)"
log_step "Restoring default login shell to $DEFAULT_SHELL ..."
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
  # ---- mise tools ----
  if command -v mise >/dev/null 2>&1; then
    log_info "Removing mise-managed tools..."
    for tool in "${MISE_TOOLS[@]}"; do
      mise uninstall "$tool" >/dev/null 2>&1 || true
    done
    log_ok "mise tools removed."
  else
    log_warn "mise not found; skipping tool purge."
  fi

  # ---- Global pnpm packages (oh-my-pi) ----
  if command -v pnpm >/dev/null 2>&1; then
    log_info "Removing global pnpm packages (oh-my-pi)..."
    pnpm remove -g @oh-my-pi/pi-coding-agent 2>/dev/null || true
  fi

  # ---- herdr ----
  # Now a mise tool (handled by the MISE_TOOLS loop above). Remove a leftover
  # copy from the old https://herdr.dev/install.sh, which installed to
  # ~/.local/bin and can shadow the mise one depending on PATH order.
  if [ -x "$HOME/.local/bin/herdr" ]; then
    log_info "Removing legacy ~/.local/bin/herdr (installed by the old herdr installer)..."
    rm -f "$HOME/.local/bin/herdr"
  fi

  # ---- mise itself ----
  # mise is a Homebrew formula now, so brew owns the binary. Its data
  # directories are still plain files under $HOME and are removed directly --
  # brew has nothing to say about those.
  if command -v brew >/dev/null 2>&1 && brew list --formula mise >/dev/null 2>&1; then
    log_info "Removing the mise formula via Homebrew..."
    NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 brew uninstall mise || \
      log_warn "brew uninstall mise failed; remove it with: brew uninstall mise"
  elif [ -x "$HOME/.local/bin/mise" ]; then
    # Legacy curl bootstrap (curl -fsSL https://mise.run | sh) put it here.
    log_info "Removing mise and its config..."
    rm -f "$HOME/.local/bin/mise"
  fi

  # The data directories go either way: a purge that removes the binary but
  # leaves ~/.local/share/mise behind leaves every installed tool on disk.
  if [ -d "$HOME/.local/share/mise" ] || [ -d "$HOME/.config/mise" ]; then
    log_info "Removing mise data directories..."
    rm -rf "$HOME/.local/share/mise" "$HOME/.config/mise"
  fi

  # ---- other Homebrew formulas ----
  # fish and mise are the only two install.sh installs through brew.
  #
  # fish gets a guard because it is the login shell. Unstowing configs and
  # restoring the shell happen earlier in this script, but that restore is a
  # no-op whenever the current shell already IS fish (it reads the shell out of
  # getent passwd), so /etc/passwd still points at this binary when the purge
  # runs. Removing it then would leave the account pointing at a path that no
  # longer exists -- the classic lockout. Decline and say how to do it properly
  # rather than breaking the account on the way out.
  if command -v brew >/dev/null 2>&1; then
    if brew list --formula fish >/dev/null 2>&1; then
      CURRENT_LOGIN_SHELL="$(getent passwd "$USER" | cut -d: -f7)"
      case "$CURRENT_LOGIN_SHELL" in
        *linuxbrew*/bin/fish)
          log_warn "NOT removing the fish formula: it is still your login shell"
          log_warn "($CURRENT_LOGIN_SHELL). Change it first, e.g.:"
          log_warn "  chsh -s /bin/bash && brew uninstall fish"
          ;;
        *)
          log_info "Removing the fish formula via Homebrew..."
          NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 brew uninstall fish || \
            log_warn "brew uninstall fish failed; remove it with: brew uninstall fish"
          ;;
      esac
    fi
  fi

  # ---- apt packages ----
  log_info "Removing apt packages..."
  sudo apt-get remove -y --purge "${APT_PACKAGES[@]}" 2>/dev/null || true
  sudo apt-get autoremove -y 2>/dev/null || true

  # Agent data is never deleted, not even with --purge. ~/.pi, ~/.omp,
  # ~/.opencode and ~/.agents hold session history, credentials, and caches
  # that outlive any package; wiping them alongside a package removal is
  # irreversible and buys nothing. There is no flag to override this.
fi

# ------------------------------------------------------------------------------
# 6. Move out of the repo, then remove it
# ------------------------------------------------------------------------------
# `cd "$HOME"` moves THIS SCRIPT, not the shell that invoked it. A child process
# cannot change its parent's working directory, so if the caller was sitting
# inside the repo, deleting it leaves their shell on a path that no longer
# exists: the prompt still renders but `pwd`, tab-completion and every relative
# path fail with "getcwd: No such file or directory".
#
# Record it now, but say so at the very END of the script. Printed before the
# removal it scrolls away under the uninstall output, which is exactly when a
# broken shell is least welcome.
CWD_REAL="$(pwd -P 2>/dev/null || pwd 2>/dev/null || echo "")"
DOTFILES_REAL="$(cd "$DOTFILES_DIR" 2>/dev/null && pwd -P || echo "$DOTFILES_DIR")"
CWD_INSIDE_REPO=0
if [ -n "$CWD_REAL" ] && [ -n "$DOTFILES_REAL" ]; then
  case "$CWD_REAL" in
    "$DOTFILES_REAL"/*) CWD_INSIDE_REPO=1 ;;
  esac
fi

log_step "Removing dotfiles repository at $DOTFILES_DIR ..."
# Leave the script itself in $HOME so anything it does afterwards is relative to
# a directory that certainly exists.
cd "$HOME" || cd /
rm -rf "$DOTFILES_DIR"
log_step "Uninstall Complete."
echo "Stowed configs removed; default login shell restored."
if [ "$PURGE" -eq 1 ]; then
  echo "Packages purged (mise tools, mise + fish formulas, apt packages, global pnpm)."
  # fish is the login shell and the purge refuses to remove it while
  # /etc/passwd still points at it, so say so plainly instead of leaving the
  # user to wonder why one formula survived.
  if command -v brew >/dev/null 2>&1 && brew list --formula fish >/dev/null 2>&1 \
     && case "$(getent passwd "$USER" | cut -d: -f7)" in *linuxbrew*/bin/fish) true ;; *) false ;; esac
  then
    echo "The fish formula was kept: it is still your login shell."
    echo "To finish:  chsh -s /bin/bash && brew uninstall fish"
  fi
  echo "Agent data left intact (~/.pi, ~/.omp, ~/.opencode, ~/.agents)."
fi
echo "Dotfiles repo deleted."
echo ""
if [ "$CWD_INSIDE_REPO" -eq 1 ]; then
  echo "==============================================================="
  echo "  Your shell is still in the directory that was just deleted"
  echo "==============================================================="
  echo "  It was: $CWD_REAL"
  echo ""
  echo "  A script cannot change the shell that launched it, so run this"
  echo "  in your terminal now:"
  echo ""
  echo "      cd ~"
  echo ""
fi
echo "Open a new terminal (or run 'exec \$SHELL') to pick up the default shell."
echo ""
