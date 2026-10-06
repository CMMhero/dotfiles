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
#   # deploy configs only, skip every package install
#   ./install.sh --config-only
#
# Installed:
#   - apt: git, curl, stow, fish (login shell), ca-certificates
#   - mise: every CLI tool, plus go, rust, node and pnpm (replaces Homebrew
#     and Vite+), and oh-my-pi as github:can1357/oh-my-pi
#
# Configs are deployed with GNU Stow, except fresh, superfile and omp which are
# linked file-by-file because stow would link those app directories whole.
# fish is set as the default login shell.
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Root check -- before anything touches the filesystem
# ------------------------------------------------------------------------------
# Everything below assumes a normal user account: mise installs into $HOME,
# `sudo` is used for apt, `chsh` needs the account's own shell. Run as root and
# all of that silently relocates to /root, which is why it is refused.
#
# Under `sudo ./install.sh`, SUDO_USER names the real user, so drop privileges
# and continue as them instead of failing. Without that, `sudo upd dotfiles`
# fails at the last step with a bare "do not run as root" and no way forward.
if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && command -v sudo >/dev/null 2>&1; then
    echo "Re-running as $SUDO_USER (this script must not run as root)..."
    # -H so HOME is the user's home, not /root. Re-exec rather than continue so
    # every later path resolves under their account.
    exec sudo -u "$SUDO_USER" -H bash "$0" "$@"
  fi
  printf "   \033[1;31m[err]\033[0m  Do not run this script as root.\n" >&2
  printf "  Run it as your normal user; it needs your HOME, mise and sudo.\n" >&2
  printf "  If you invoked it through sudo, that is handled automatically --\n" >&2
  printf "  this message means there is no SUDO_USER to fall back to.\n" >&2
  exit 1
fi

# Visual log helpers
#
# Three levels, matching the `upd` fish function so both read the same way:
#
#   log_step  a section header, in the same banner form as "Remaining Manual
#             Steps" -- a rule above and below a bold centred title.
#   log_info  a detail line under the current header, indented.
#   [ok]/[warn]/[err]
#             status, bracketed so they stand out when scrolling back.
#
# log_banner takes an optional colour so a warning-style block (manual steps)
# reads differently from a normal section without duplicating the layout.
log_banner() {
  local colour="$1"; shift
  printf "\033[1;${colour}m===============================================================\033[0m\n"
  printf "\033[1;${colour}m  %-62s\033[0m\n" "$*"
  printf "\033[1;${colour}m===============================================================\033[0m\n"
}
log_step()  { log_banner "32" "$*"; }
log_info()  { printf "   \033[0;36m->\033[0m %s\n" "$*"; }
log_ok()    { printf "   \033[1;32m[ok]\033[0m   %s\n" "$*"; }
log_warn()  { printf "   \033[1;33m[warn]\033[0m %s\n" "$*"; }
log_err()   { printf "   \033[1;31m[err]\033[0m  %s\n" "$*"; }

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

# --config-only deploys the configs and skips every package install.
#
# `upd` already updates apt, mise and the AI agents before it pulls the
# dotfiles and runs install.sh. Without this flag install.sh would redo all of
# it -- apt upgrade, mise installs, omp add -- so one `upd` ran the whole
# package cycle twice. Used by `upd dotfiles`.
SKIP_PACKAGES=0
for arg in "$@"; do
  case "$arg" in
    --config-only) SKIP_PACKAGES=1 ;;
    --help|-h)     sed -n '2,16p' "$0"; exit 0 ;;
    *)             log_err "Unknown option: $arg"; exit 1 ;;
  esac
done

# ------------------------------------------------------------------------------
# 2. Sanity Checks
# ------------------------------------------------------------------------------


# ------------------------------------------------------------------------------
# Hand off to fish, guaranteed.
# ------------------------------------------------------------------------------
# Registered as an EXIT trap rather than placed at the end of the script
# because this runs under `set -euo pipefail`: any non-zero command earlier on
# (a stow conflict, a failing sudo apt-get, a mise install returning non-zero)
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
# Fallback is /usr/bin/fish (apt), not a Homebrew path: that is where fish lives
# now, and a login shell pointing at a removed path is the classic lockout.
FISH_EXEC_BIN="$(command -v fish 2>/dev/null || echo /usr/bin/fish)"
trap handoff_to_fish EXIT

log_info "Dotfiles directory: $DOTFILES_DIR"
log_step "Starting system setup..."

# --- package installation: skipped entirely with --config-only ---------------
if [ "$SKIP_PACKAGES" -eq 0 ]; then

# ------------------------------------------------------------------------------
# 3. APT System Update & Base Essentials
# ------------------------------------------------------------------------------
log_step "Updating apt repositories and installing base packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
# Trimmed to what this setup actually needs:
#   ca-certificates  trust store for apt/curl/mise over HTTPS
#   curl             mise bootstrap (https://mise.run) and every mise download
#   fish             the LOGIN shell, from apt so it sits at a stable
#                    /usr/bin/fish that chsh and herdr can rely on
#   git              this repository, and the git config being deployed
#   stow             the deployment mechanism itself
#
# Dropped: build-essential (mise installs prebuilt binaries; nothing compiles),
# file and procps (no script invokes them; btop/fastfetch/eza cover the same
# ground). Re-add build-essential if a native module ever needs compiling.
sudo apt-get install -y \
  ca-certificates \
  curl \
  fish \
  git \
  stow

log_ok "Base APT packages installed."

# ------------------------------------------------------------------------------
# 4. mise (replaces Homebrew and Vite+)
# ------------------------------------------------------------------------------
# Everything user-facing is installed through mise: the CLI tools that used to
# come from brew, plus node/pnpm which used to come from Vite+.
#
# Two deliberate exceptions:
#   - apt stays for system packages. mise has no apt/dpkg backend at all (its
#     backends are aqua/asdf/cargo/conda/core/gem/github/go/npm/pypi/vfox/...),
#     so build-essential, git, stow and friends cannot move.
#   - fish stays on apt, so the login shell lives at a stable /usr/bin/fish.
#     mise installs into versioned paths that change on upgrade, which would
#     break `chsh` and herdr's default_shell the first time fish is upgraded.
if ! command -v mise >/dev/null 2>&1; then
  log_step "Installing mise (https://mise.jdx.dev)..."
  # Official installer. Deliberately NOT via brew: brew is being removed, and
  # bootstrapping the replacement with the thing it replaces would be circular.
  curl -fsSL https://mise.run | sh >/dev/null 2>&1 || true
  export PATH="$HOME/.local/bin:$PATH"
  [ -x "$HOME/.local/bin/mise" ] || export PATH="/usr/local/bin:$PATH"
fi
command -v mise >/dev/null 2>&1 || { log_err "mise failed to install; cannot continue."; exit 1; }
log_ok "mise ready at $(command -v mise) ($(mise --version 2>/dev/null | head -1))"

# ------------------------------------------------------------------------------
# 5. Tools via mise
# ------------------------------------------------------------------------------
# Backends: aqua (most CLI tools), github (repos without an aqua entry), core
# (go, rust, node, pnpm - the built-in registry).
#
# (pnpm comes from vite+ now; mise does not manage node/pnpm.)
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
  "github:AlexsJones/llmfit"     # local model fit checker
  "github:reyamira/models"       # AI model TUI
  "github:can1357/oh-my-pi"      # oh-my-pi (omp)
  # npm backend
  "npm:vite-plus"                # vite+ tool; its runtime/PM modes stay system_first
  # core backend
  "core:go"                      # replaced the brew `go` formula
  "core:rust"                    # replaced brew `rustup`
  "core:node"                    # node
  "core:pnpm"                    # pnpm
)

log_step "Installing tools via mise..."
MISE_MISSING=()
for tool in "${MISE_TOOLS[@]}"; do
  mise install "$tool" >/dev/null 2>&1 || MISE_MISSING+=("$tool")
done
if [ "${#MISE_MISSING[@]}" -gt 0 ]; then
  log_warn "mise could not install: ${MISE_MISSING[*]}"
else
  log_ok "mise installed ${#MISE_TOOLS[@]} tools."
fi

# Pin them globally so they are on PATH in every shell.
mise use --global --skip-install "${MISE_TOOLS[@]}" >/dev/null 2>&1 || true

# Put mise's shims on PATH for this script's remaining steps.
# Do NOT use `mise where` here: with no argument it prints usage and exits
# non-zero, so the fallback silently produced an empty PATH entry. The shims dir
# is a fixed location under MISE_DATA_DIR (default ~/.local/share/mise).
MISE_SHIMS="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"
mkdir -p "$MISE_SHIMS"
export PATH="$MISE_SHIMS:$PATH"

log_ok "pnpm via mise: $(pnpm --version 2>/dev/null || echo 'pending shell reload')"

# ------------------------------------------------------------------------------
# 6. pnpm configuration
# ------------------------------------------------------------------------------
# pnpm itself is a mise tool (core:pnpm); this only points its global package
# output at ~/.local/bin so `omp` lands on a path fish already has. vite+ is
# installed too but its runtime/PM modes are system_first, so it defers to
# mise's node/pnpm instead of managing its own.
export PNPM_HOME="$HOME/.local/share/pnpm"
mkdir -p "$HOME/.local/bin" "$PNPM_HOME"
export PATH="$HOME/.local/bin:$PNPM_HOME:$PATH"
pnpm config set global-bin-dir "$HOME/.local/bin" 2>/dev/null || true
pnpm config set store-dir "$PNPM_HOME/store" 2>/dev/null || true
log_ok "pnpm configured (global bin dir: $HOME/.local/bin)."

# ------------------------------------------------------------------------------
# 7. AI Agents: Pi & Oh-My-Pi (omp)
# ------------------------------------------------------------------------------
# pi, opencode and oh-my-pi are all mise tools installed in section 5. Nothing
# is left to do here beyond reporting what actually resolved, since a failed
# mise install should be visible here rather than surfacing later as a missing
# command.
log_step "Checking AI agents..."
AI_AGENTS_OK=1
for agent in pi opencode omp; do
  if command -v "$agent" >/dev/null 2>&1; then
    log_ok "$agent -> $(command -v "$agent")"
  else
    log_warn "$agent not found; check the mise install output above."
    AI_AGENTS_OK=0
  fi
done
[ "$AI_AGENTS_OK" -eq 1 ] || log_info "Retry with: mise install github:can1357/oh-my-pi aqua:anomalyco/opencode aqua:earendil-works/pi"

# ------------------------------------------------------------------------------
# 8. Herdr
# ------------------------------------------------------------------------------
# herdr comes from mise (aqua:herdrdev/herdr), installed in section 5. The
# standalone curl installer is not used: it drops a binary in ~/.local/bin,
# which is a second copy that can shadow the mise one depending on PATH order.
if command -v herdr >/dev/null 2>&1; then
  log_ok "herdr ready at $(command -v herdr) ($(herdr --version 2>/dev/null | head -1))"
else
  log_warn "herdr not found; retry with: mise install aqua:herdrdev/herdr"
fi

else
  log_info "--config-only: skipped apt, mise tools, pi, omp, opencode and herdr."
  log_info "Run './install.sh' without --config-only to install packages."
fi  # end package installation
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

# Packages linked file-by-file instead of stowed.
#
# GNU Stow links a whole directory whenever the target directory does not
# already exist. On a fresh machine ~/.config/fresh and ~/.config/superfile do
# not exist, so 'stow fresh' links ~/.config/fresh as a single symlink into this
# repo -- and everything fresh or superfile writes there lands in the working
# tree. That is the same reason omp moved off stow.
#
# These are linked by walking the package and symlinking each file, with every
# parent directory created as a real directory.
#
# Note: fresh's theme and language PACKAGES must stay in this repo even though
# they are fetched from GitHub. fresh does not re-download them: with
# themes/ removed, the editor silently falls back and never recreates the
# directory (verified). superfile is different -- its themes are built in and
# config.toml selects one by name, so those really are redundant.
EXPLICIT_LINK_PACKAGES=(fresh superfile)

# omp additionally keeps runtime state under ~/.omp (sessions/, agent.db,
# stats.db, cache/, logs/, run/, install-id, plugins/node_modules), so it gets
# an explicit file list rather than a whole-tree walk.
OMP_MANAGED_FILES=(
  .omp/agent/config.yml
  .omp/plugins/package.json
  .omp/agent/extensions/opencode-zen-fix.ts
)

# Link one repo file to $HOME, replacing whatever is there (backing up anything
# that is not already a link into this repo).
link_one_file() {
  local pkg="$1" rel="$2"
  local src="$DOTFILES_DIR/$pkg/$rel" target="$HOME/$rel"
  local target_real src_real

  [ -f "$src" ] || { log_warn "$pkg: missing in repo, skipped: $rel"; return 0; }

  # Real parent directories, never links.
  mkdir -p "$(dirname "$target")"

  # Resolve first. Comparing resolved paths is what distinguishes "our file
  # reached through a symlinked parent" (leave alone) from a genuine pre-existing
  # file (back up). A test -L cannot: it is false for the first case.
  target_real="$(readlink -f "$target" 2>/dev/null || true)"
  src_real="$(readlink -f "$src" 2>/dev/null || true)"

  if [ -n "$target_real" ] && [ "$target_real" = "$src_real" ]; then
    # Already correctly linked.
    log_info "$pkg: ~/$rel"
    return 0
  fi

  if [ -L "$target" ]; then
    rm -f "$target"          # stale link, possibly pointing at a moved repo file
  elif [ -e "$target" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    log_warn "Backing up existing $pkg file: ~/$rel"
    mv "$target" "$BACKUP_DIR/$rel"
  fi

  ln -s "$src" "$target"
  log_info "$pkg: linked ~/$rel"
}

# Walk a whole package and link each file individually.
link_package_tree() {
  local pkg="$1" rel
  while IFS= read -r rel; do
    link_one_file "$pkg" "${rel#./}"
  done < <(cd "$DOTFILES_DIR/$pkg" 2>/dev/null && find . -type f)
}

link_omp_files() {
  local rel
  for rel in "${OMP_MANAGED_FILES[@]}"; do
    link_one_file omp "$rel"
  done
}

log_step "Deploying configs using GNU Stow..."

# Back up files that would block stowing, then let stow link them.
#
# The `-L` test alone is not enough, and that bug deleted files from this repo.
# GNU Stow links a whole directory whenever the target directory does not already
# exist: ~/.config/bat can become a symlink to ../dotfiles/bat/.config/bat. A
# file reached *through* that link (~/.config/bat/config) is a perfectly ordinary
# file -- test -L says false -- so the old check treated our own repo file as a
# pre-existing conflict and moved it into ~/.dotfiles_backup/. Every run then
# stripped more of the working tree: bat, fastfetch, hunk, lazygit, and the
# fresh plugins/themes/languages packages all vanished from the repo.
#
# Fix: resolve the target to its real path first. If it lands inside this repo,
# it is our own file, not a conflict, and must be left alone.
backup_if_conflict() {
  local pkg="$1" rel_file rel_path target_path target_real
  cd "$DOTFILES_DIR/$pkg" || return 0
  while IFS= read -r rel_file; do
    rel_path="${rel_file#./}"
    target_path="$HOME/$rel_path"
    [ -e "$target_path" ] || continue
    # Already a direct link into the repo: stow is happy with this.
    [ -L "$target_path" ] && continue

    # Resolve through any directory symlinks above it.
    target_real="$(readlink -f "$target_path" 2>/dev/null || true)"
    if [ -n "$target_real" ]; then
      case "$target_real" in
        "$DOTFILES_DIR"/*)
          # This file IS in the repo (reached via a directory symlink).
          continue
          ;;
      esac
    fi

    # Genuine pre-existing file that is not ours: move it aside.
    mkdir -p "$BACKUP_DIR/$(dirname "$rel_path")"
    log_warn "Backing up existing file: $target_path -> $BACKUP_DIR/$rel_path"
    mv "$target_path" "$BACKUP_DIR/$rel_path"
  done < <(find . -type f)
  cd "$DOTFILES_DIR" || return 0
}

cd "$DOTFILES_DIR"
for pkg in "${STOW_PACKAGES[@]}"; do
  [ -d "$DOTFILES_DIR/$pkg" ] || continue
  # Detail, not a section header: there are ~17 packages and a banner each
  # would bury the actual output.
  log_info "$pkg"
  backup_if_conflict "$pkg"
  # stow's own -v prints bare "LINK: x => y" lines that do not match the
  # style used everywhere else here. Run it quiet and report each linked file
  # ourselves, in the same "-> " form used by log_info.
  if ! stow -R -t "$HOME" "$pkg" 2>/dev/null; then
    log_err "stow failed for package: $pkg"
    continue
  fi
  # Detection must compare resolved paths, not test -L: stow links a whole
  # directory when the target directory does not already exist, so
  # ~/.config/herdr/config.toml can be a real file reached *through* a symlinked
  # ~/.config/herdr and would never pass a -L test. This is the same trap that
  # made backup_if_conflict delete repo files.
  (cd "$pkg" && find . -type f | while read -r rel_file; do
    rel_path="${rel_file#./}"
    target_real="$(readlink -f "$HOME/$rel_path" 2>/dev/null || true)"
    src_real="$(readlink -f "$rel_file" 2>/dev/null || true)"
    if [ -n "$target_real" ] && [ "$target_real" = "$src_real" ]; then
      log_info "linked ~/$rel_path"
    fi
  done)
done
log_ok "Stow packages deployed."

log_step "Linking managed omp files (not stowed - see note above)..."
link_omp_files

log_step "Linking files for packages not stowed (fresh, superfile)..."
for pkg in "${EXPLICIT_LINK_PACKAGES[@]}"; do
  log_info "$pkg"
  link_package_tree "$pkg"
done

# ------------------------------------------------------------------------------
# 10. Oh-My-Pi Plugins Setup
# ------------------------------------------------------------------------------
# NOTE: skills are not managed at all. ~/.agents/skills and ~/skills-lock.json
# stay per-machine, as do the opencode/pi/omp skill directories -- each agent
# manages its own installs via the `skills` wrapper (pnpm dlx, global by default).
#
# The `omp` config is linked file-by-file, not stowed: only agent/config.yml,
# plugins/package.json and agent/extensions/opencode-zen-fix.ts come from the
# repo. Everything else under ~/.omp is per-machine state (sessions/, run/,
# logs/, cache/, stats.db, install-id, plugins/node_modules).
if [ -d "$HOME/.omp/plugins" ] && [ -f "$HOME/.omp/plugins/package.json" ]; then
  log_info "Installing Oh-My-Pi plugins via pnpm..."
  # Same build-script gate as above; `2>/dev/null` would otherwise hide the
  # ERR_PNPM_IGNORED_BUILDS error that a blocked postinstall produces.
  (cd "$HOME/.omp/plugins" && pnpm install --allow-build pi-natives --allow-build pi-natives-linux-x64 2>&1 | tail -3) || log_warn "omp plugin install reported an error (see above)."
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
FISH_BIN="$(command -v fish 2>/dev/null || echo /usr/bin/fish)"
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

# omp has no auth.json like pi. It takes credentials from an auth-broker or from
# provider API-key env vars, and the default model role in the stowed config.yml
# names commandcode, so that is the variable worth checking first.
if command -v omp >/dev/null 2>&1; then
  omp_has_creds=0

  # 1. auth-broker configured
  if omp auth-broker status --json 2>/dev/null | grep -q '"ok":true'; then
    omp_has_creds=1
  fi

  # 2. any provider key exported
  if [ "$omp_has_creds" -eq 0 ]; then
    for var in COMMANDCODE_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY \
               OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
      if [ -n "${!var:-}" ]; then
        omp_has_creds=1
        break
      fi
    done
  fi

  if [ "$omp_has_creds" -eq 0 ]; then
    MANUAL_STEPS+=("omp auth-broker login       # sign in, or export COMMANDCODE_API_KEY (matches the default model role in omp config.yml)")
  else
    log_ok "omp credentials found."
  fi
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
# In --config-only mode this whole summary is noise: it is an inventory of
# packages that were deliberately not touched, printed every time `upd` pulls
# the dotfiles. Keep the manual-step warnings (they can change with the machine)
# and drop the rest.
if [ "$SKIP_PACKAGES" -eq 0 ]; then
echo ""
log_step "Machine Bootstrap & Config Sync Complete!"
echo ""
echo "Active environment features:"
echo "  - mise prefix: ${MISE_SHIMS:-$HOME/.local/share/mise/shims}"
echo "  - Brew CLI tools: bat, eza, fd, ripgrep, atuin, starship, fresh, lazygit, superfile, stow, uv, opencode, pi-coding-agent, etc."
echo "  - Python manager: uv (pip/venv/run/build)"
echo "  - Terminal multiplexer: herdr (with custom keybinds & Catppuccin theme)"
echo "  - Terminal emulator config: wezterm (.wezterm.lua, Windows-only; in repo, not stowed on Linux)"
echo "  - Editor: fresh (fresh-editor) with catppuccin theme, color-highlighter plugin, vi-mode + toggle"
echo "  - Runtimes: vite+ (vp), node, pnpm (pnpm-first, managed by vite+)"
echo "  - AI Agents: pi, opencode, oh-my-pi (omp) via mise; configs NOT stowed"
echo "  - Skills: not managed; install with 'skills add <pkg>' (pnpm dlx, global)"
echo "  - Shell: fish with custom aliases, abbreviations, and starship prompt"
echo ""
fi

if [ "${#MANUAL_STEPS[@]}" -gt 0 ]; then
  log_banner "33" "Remaining Manual Steps"
  echo "These need a browser, password, or first-run prompt:"
  echo ""
  for step in "${MANUAL_STEPS[@]}"; do
    log_info "- $step"
  done
  echo ""
else
  log_ok "All account logins already configured on this machine."
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
