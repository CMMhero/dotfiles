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
# Toolchain:
#   apt    git, stow -- installed before the clone, since this script may run
#          on a bare box where neither exists yet. Skipped entirely when both
#          are already present.
#   brew   Homebrew / Linuxbrew, installed if absent. Supplies fish (the login
#          shell) and mise itself, both at stable prefixes. Only missing
#          formulas are installed.
#   mise   every other tool, installed via the aqua / github / npm / core
#          backends. mise supplies everything except the apt base set, fish and
#          mise.
#
# Deploy order: apt, then clone, then brew, then mise, then configs.
#
# Every package step is non-interactive and auto-accepting: brew runs with
# NONINTERACTIVE=1 and HOMEBREW_NO_AUTO_UPDATE=1, mise with MISE_YES=1. Under
# `curl ... | bash` there is no TTY, so a prompt from either one is a hang with
# nobody to answer it. (sudo may still ask for a password; that one is left
# alone on purpose.)
#
# Each step installs only what is missing. apt, brew and mise all treat a
# re-install of something present as a no-op, but the resolution and the network
# round trips behind it are not free -- so an already-provisioned machine skips
# all three outright instead of paying for no-ops.
#
# Configs go out through GNU Stow. superfile and omp are additionally linked
# file-by-file (fresh is linked both ways), because stow would link those app
# directories whole and anything the tools write there would land in the repo.
# fish -- from Homebrew -- becomes the default login shell.
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
    # every later path resolves under their account. stdin is redirected to the
    # tty because under `curl | bash` it is still the pipe carrying this script;
    # the re-exec'd bash would otherwise resume reading it mid-file.
    if [ -r /dev/tty ]; then
      exec sudo -u "$SUDO_USER" -H bash "$0" "$@" < /dev/tty
    fi
    exec sudo -u "$SUDO_USER" -H bash "$0" "$@" < /dev/null
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

# ---------------------------------------------------------------------------
# Flags -- parsed before anything runs, so apt can honour --config-only.
# ---------------------------------------------------------------------------
# --config-only deploys the configs and skips every package install.
#
# `upd` already updates apt, mise and the AI agents before it pulls the
# dotfiles and runs install.sh. Without this flag install.sh would redo all of
# it -- apt upgrade, mise installs, omp add -- so one `upd` ran the whole
# package cycle twice. Used by `upd dotfiles`.
#
# --apt-done is internal: the clone re-execs the repo's copy of this script, and
# the base packages were already installed before that clone, so the re-exec must
# not run apt a second time.
SKIP_PACKAGES=0
APT_DONE=0
for arg in "$@"; do
  case "$arg" in
    --config-only) SKIP_PACKAGES=1 ;;
    --apt-done)    APT_DONE=1 ;;
    # Print the whole header block: everything from line 2 up to the closing
    # banner. Marking the end structurally rather than with a literal line number
    # means editing the description above cannot silently truncate --help, which
    # is exactly what a hardcoded range did when the brew step was added.
    --help|-h)     awk 'NR == 1 {next}
                         /^# ={20,}/ {if (seen) exit; seen = 1}
                         {print}' "$0"; exit 0 ;;
    *)             log_err "Unknown option: $arg"; exit 1 ;;
  esac
done

# ------------------------------------------------------------------------------
# APT base essentials -- before the clone
# ------------------------------------------------------------------------------
# Must come first: the documented entry point is `curl ... | bash`, which runs
# before anything is installed, and the clone needs git. Installing the full
# base set up front (rather than a git-only bootstrap) means the clone below can
# rely on a working box.
if [ "$APT_DONE" -eq 0 ] && [ "$SKIP_PACKAGES" -eq 0 ]; then
  log_step "Installing base packages via apt..."
  APT_PREFIX=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || {
      log_err "apt needs sudo and sudo is not available."
      log_err "Run this as a user with sudo, or as root."
      exit 1
    }
    APT_PREFIX="sudo "
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    log_err "No apt-get found. This installer targets Debian/Ubuntu."
    log_err "On another distro, install git, curl and stow manually and re-run."
    exit 1
  fi

  # Trimmed to what this setup actually needs:
  #   git              this repository, and the git config being deployed
  #   stow             the deployment mechanism itself
  #
  # Not in this set: fish and mise (both come from Homebrew below), and
  # ca-certificates/curl (Homebrew brings its own TLS trust and a curl, and on a
  # box that somehow has neither, brew's own installer fetches with its embedded
  # curl, so neither is a hard prerequisite here).
  #
  # Also dropped: build-essential (mise installs prebuilt binaries; nothing
  # compiles), file and procps (no script invokes them; btop/fastfetch/eza cover
  # the same ground). Re-add build-essential if a native module ever needs
  # compiling.
  #
  # Skip whatever is already present. `apt-get install` is a no-op for an
  # installed package, but the `apt-get update` behind it is a network round trip
  # on every run -- so on an already-provisioned machine the whole apt step can
  # be skipped outright instead of paying for a no-op.
  APT_MISSING=()
  for pkg in git stow; do
    # `install ok installed` is dpkg's own wording. Anything else (not-installed,
    # config-files, deinstall ok config-files) counts as needing install.
    if [ "$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)" = "install ok installed" ]; then
      log_info "already installed: $pkg"
    else
      APT_MISSING+=("$pkg")
    fi
  done

  if [ "${#APT_MISSING[@]}" -eq 0 ]; then
    log_ok "Base APT packages already present; skipping apt."
  else
    log_step "Installing via apt: ${APT_MISSING[*]}"
    $APT_PREFIX apt-get update -y
    $APT_PREFIX apt-get install -y "${APT_MISSING[@]}"
    log_ok "Base APT packages installed."
  fi
fi

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
    # --rebase --autostash, not --ff-only. Two independent reasons, and this
    # line used to get both wrong:
    #
    #   1. The stowed .gitconfig sets [pull] rebase = true, so --ff-only is a
    #      contradiction and git refuses outright (exit 128).
    #   2. Every config is a stow symlink, so editing one in a live session
    #      writes straight into this repo and the tree is routinely dirty.
    #      Measured with the repo's own gitconfig: --ff-only exits 128 with
    #      "cannot pull with rebase: You have unstaged changes", and under
    #      `set -euo pipefail` that aborts the whole install here -- before a
    #      single config is deployed.
    #
    # --autostash is what lets the pull proceed anyway, and matches what `upd
    # dotfiles` already does.
    git -C "$DOTFILES_DIR" pull --rebase --autostash
  fi
  # --apt-done: the base packages are already installed above, so the
  # re-exec must not run apt a second time.
  exec "$DOTFILES_DIR/install.sh" --apt-done "$@"
fi

DOTFILES_DIR="$SCRIPT_DIR"
BACKUP_DIR="$HOME/.dotfiles_backup/$(date +%Y%m%d_%H%M%S)"


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

  # Already running under fish: do NOT exec.
  #
  # `exec` here replaces THIS script's process, not the shell that launched it.
  # The exec'd fish becomes a child of the caller's fish, so the user lands in a
  # nested shell: `exit` drops them back to the old one, still on the stale
  # config, which looks exactly like the install did nothing. A child process
  # cannot take over its parent's process slot -- nothing can, short of the parent
  # doing it itself.
  #
  # Verified by PID: invoked from a fish at 838084, this script runs at 838146
  # and the exec'd fish inherits 838146, still parented to 838084.
  #
  # So the only correct move from in here is to tell the user to run `exec fish`
  # themselves. That is the one command that can replace the current shell, and it
  # has to be typed in that shell.
  if [ "$(cat "/proc/$PPID/comm" 2>/dev/null || true)" = "fish" ]; then
    echo ""
    echo "Run this to pick up the new config:"
    echo ""
    echo "    exec fish"
    echo ""
    return $rc
  fi

  echo ""
  echo "Reloading fish with the new config..."
  # Hand the new shell the terminal, not whatever this script was reading.
  #
  # Invoked as `curl ... | bash`, stdin is still the pipe carrying the rest of
  # this script. fish starts, sees a non-tty stdin, and executes those bash
  # lines as commands -- which fails loudly with
  #   "Unsupported use of '='. In fish, please use 'set DOTFILES_DIR ...'"
  # and leaves the shell unusable, so the config looks like it never loaded.
  # Reading the tty instead gives fish a real interactive stdin.
  if [ -r /dev/tty ]; then
    exec "$FISH_EXEC_BIN" -l < /dev/tty
  fi
  exec "$FISH_EXEC_BIN" -l < /dev/null
}
# fish comes from Homebrew, and --config-only skips the brew shellenv above, so
# `command -v fish` can miss on a PATH that never loaded brew. Fall back to the
# brew prefixes directly. A login shell pointed at some other machine's removed
# path is the classic lockout, so /usr/bin/fish (where apt used to put it) stays
# as a last resort.
FISH_EXEC_BIN="$(command -v fish 2>/dev/null || true)"
for fish_candidate in /home/linuxbrew/.linuxbrew/bin/fish "$HOME/.linuxbrew/bin/fish" /usr/bin/fish; do
  if [ -n "$FISH_EXEC_BIN" ]; then break; fi
  if [ -x "$fish_candidate" ]; then FISH_EXEC_BIN="$fish_candidate"; fi
done
FISH_EXEC_BIN="${FISH_EXEC_BIN:-/usr/bin/fish}"
trap handoff_to_fish EXIT
# Link one repo file to $HOME, replacing whatever is there (backing up anything
# that is not already a link into this repo).
#
# Defined up here, not beside the stow step: section 4 links the mise config
# through the same helper, so it has to exist before that runs.
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

  # Link RELATIVE to the target's directory, matching what stow itself would
  # create. An absolute link breaks two things:
  #   - the link dies if the repo is ever moved or the tree checked out elsewhere
  #   - stow refuses to adopt it. Given an absolute symlink where it expects to
  #     own a link, it prints "Ignoring an absolute symlink" then "existing
  #     target is not owned by stow", aborts every operation, and exits 1 --
  #     even though the link points at exactly the right file. That is what made
  #     'stow failed for package: fresh' appear on every run.
  #
  # realpath --relative-to is coreutils 8.16+ (2012). The absolute fallback is
  # only for a box that somehow lacks it.
  local relpath_target
  if relpath_target="$(realpath --relative-to="$(dirname "$target")" "$src" 2>/dev/null)" \
     && [ -n "$relpath_target" ]; then
    ln -s "$relpath_target" "$target"
  else
    ln -s "$src" "$target"
  fi
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

log_info "Dotfiles directory: $DOTFILES_DIR"
log_step "Starting system setup..."

# --- package installation: skipped entirely with --config-only ---------------
if [ "$SKIP_PACKAGES" -eq 0 ]; then

# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# Homebrew Installation & Environment
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
# Homebrew CLI Packages Installation
# ------------------------------------------------------------------------------
# Four formulas, and the reason each is here differs.
#   fish      the login shell -- a moving path would break chsh and herdr's
#             default_shell the first time it is upgraded.
#   mise      installs every tool below. Sourcing its own activation from a
#             fixed prefix is more predictable than a version-managed copy that
#             would itself need activating before it could activate anything else.
#   opencode  deliberately NOT a mise tool. mise tracked it behind the aqua
#             backend, which pins an old release (1.18.34 against brew's 2.0.20
#             here) with no channel for the current one. brew ships a bottle, so
#             it tracks upstream on its own.
#   vite-plus the GLOBAL CLI, which owns Node.js and the package managers (see
#             the vite+ section). This is not interchangeable with the
#             `npm:vite-plus` mise tool: that one is the project-local package
#             and has no `vp env` subcommand at all -- "The `env` command is only
#             available in the global `vp` CLI" -- so a mise-installed vite-plus
#             cannot manage a runtime at all. The global CLI is also a superset
#             of the local one, adding env/node/dlx and package management.
#
# Everything else comes from mise.
BREW_PACKAGES=(
  fish
  mise
  opencode
  vite-plus
)

# Split into missing vs present. `brew install` already skips installed
# formulas, but it still resolves and prints for each one, and `brew list` is a
# cheap local read -- so on an already-provisioned machine this step becomes a
# no-op that reports what it skipped instead of a working pass over both names.
BREW_MISSING=()
for formula in "${BREW_PACKAGES[@]}"; do
  if brew list --formula "$formula" >/dev/null 2>&1; then
    log_info "already installed: $formula"
  else
    BREW_MISSING+=("$formula")
  fi
done

if [ "${#BREW_MISSING[@]}" -eq 0 ]; then
  log_ok "Homebrew formulas already present; skipping brew install."
else
  log_step "Installing via Homebrew: ${BREW_MISSING[*]}"
  if HOMEBREW_NO_AUTO_UPDATE=1 NONINTERACTIVE=1 brew install "${BREW_MISSING[@]}"; then
    log_ok "Homebrew formulas installed."
  else
    log_err "brew install failed for: ${BREW_MISSING[*]}"
    log_err "Already-installed formulas are fine; re-run to retry the rest."
  fi
fi
# Not fatal either way. The formulas may already be present (mise especially, on
# a machine that installed it by hand), and a failure here must not strand a box
# that could otherwise finish its config. What actually needs mise is section 5,
# which fails loudly on its own if the binary is missing.

# Drop opencode from mise if a previous install tracked it there.
#
# Leaving it registered is not merely untidy. brew/bin is ahead of the mise shims
# on PATH, so brew's binary wins today -- but any later `mise install` would
# restore the shim, and if brew's formula were ever removed the shim would
# silently take over again, resurrecting the old pinned version with no change on
# the user's part.
#
# `mise unuse --global` and not `mise uninstall`: uninstall drops the installed
# copy but leaves the request in config.toml, so the entry survives and the next
# `mise install` brings the shim straight back. unuse edits the config.
#
# unuse only prunes an install when nothing else still needs it, and a leftover
# shim is enough to hold it -- the shim stays on disk after unuse, still on PATH,
# and would error with "No version is set for shim: opencode". So unuse first,
# then uninstall unconditionally to take the install directory and shim with it.
if command -v mise >/dev/null 2>&1 \
   && mise ls --installed 2>/dev/null | grep -q '^aqua:anomalyco/opencode'; then
  log_info "Removing opencode from mise (now a Homebrew formula)..."
  mise unuse --global aqua:anomalyco/opencode >/dev/null 2>&1 || true
  # No --force: if anything genuinely still references the tool, leave it alone
  # and say so rather than deleting a version some other config asked for.
  if mise uninstall aqua:anomalyco/opencode >/dev/null 2>&1; then
    log_ok "mise no longer tracks opencode."
  elif mise ls --installed 2>/dev/null | grep -q '^aqua:anomalyco/opencode'; then
    log_warn "mise still holds an opencode install; finish with:"
    log_warn "  mise unuse --global aqua:anomalyco/opencode"
  else
    log_ok "mise no longer tracks opencode."
  fi
fi

# ------------------------------------------------------------------------------
# 3. mise on PATH
# ------------------------------------------------------------------------------
# mise itself was installed as a Homebrew formula in the previous section, so
# there is nothing to bootstrap here -- this only has to make sure the shellenv
# block earlier in the script actually put it on PATH, and report clearly if not.
#
# The curl bootstrap (curl -fsSL https://mise.run | sh) used to live here. It is
# gone: it installed a second mise into ~/.local/bin, which could shadow brew's
# copy or be shadowed by it depending on PATH order, and uninstall.sh then had
# to remove that copy by hand. One mise, owned by brew.
if command -v mise >/dev/null 2>&1; then
  :
else
  # Re-run shellenv once before giving up: `brew install mise` in a previous run
  # can succeed while this script's own eval was skipped or landed elsewhere.
  if [ -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
  elif [ -x "$HOME/.linuxbrew/bin/brew" ]; then
    eval "$("$HOME/.linuxbrew/bin/brew" shellenv)"
  fi
fi
command -v mise >/dev/null 2>&1 || {
  log_err "mise is not on PATH after installing the Homebrew formula."
  log_err "Check: brew --prefix, and that /home/linuxbrew/.linuxbrew/bin is in PATH."
  exit 1
}
log_ok "mise ready at $(command -v mise) ($(mise --version 2>/dev/null | head -1))"

# ------------------------------------------------------------------------------
# 4. Tools via mise -- driven entirely by the stowed config
# ------------------------------------------------------------------------------
# config.toml is the single source of truth for what is installed. There is no
# tool list in this script, and that is the point: a hardcoded array here had
# already drifted from the config (llmfit and models were deleted from the array
# while the config still declared them, so a fresh machine would have installed
# a config promising tools the installer never fetched).
#
# `mise install` with no arguments installs everything the config asks for.
# mise's own help is explicit that "installing alone does not add the tool to
# your config, so a tool that is not already configured will not be on PATH" --
# and that caveat concerns tools *missing* from the config. Every tool here IS
# declared, so each ends up installed and registered, which is what makes the
# shims resolve. Backends are whatever the config says: aqua for most tools,
# github for repos with no aqua entry, npm for vite+, and the built-in registry
# for go/node/pnpm/rust.
#
# The config is deployed FIRST, before mise runs. That ordering is load-bearing:
# bare `mise install` reads ~/.config/mise/config.toml, and on a first install
# the stow step has not run yet, so without this link mise would find no config
# and install nothing -- silently succeeding while provisioning an empty box.
#
# Removing a tool from the config does NOT uninstall it. `mise install` only ever
# adds, and the old shim keeps working: measured here, deleting the fzf entry left
# `fzf --version` answering 0.74.4 while `mise which fzf` reported it inactive.
# The entry stops it being tracked and updated; to actually drop it you need
# `mise uninstall <tool>` (or `mise prune`). Worth knowing before someone edits
# the config, removes a line, and assumes the binary went away.
MISE_CONFIG_REL=".config/mise/config.toml"
MISE_CONFIG_SRC="$DOTFILES_DIR/mise/$MISE_CONFIG_REL"
# Both are read again by the completion summary, and `set -u` would turn an
# unset one into a crash there -- after the install had otherwise succeeded.
MISE_TOOL_COUNT=0
MISE_CONFIG_OK=0

if [ ! -f "$MISE_CONFIG_SRC" ]; then
  # Not fatal. The usual cause is a checkout older than the mise package -- and
  # `./install.sh` deliberately does not pull, so a stale tree hits this. Aborting
  # here would throw away the whole run: every other config, the login shell, the
  # fish handoff. Only the mise tools are lost, and they are one `mise install`
  # away once the file exists.
  log_warn "No mise config in the repo: mise/$MISE_CONFIG_REL"
  log_warn "Skipping mise's tools. Everything else still gets set up."
  log_info "Fix with:  git -C $DOTFILES_DIR pull"
else
  # Count the entries for reporting. Matching `=` rather than tool names: a value
  # can legitimately contain one, and the count only has to be about right.
  MISE_TOOL_COUNT="$(grep -cE '^[^#[:space:]].*=' "$MISE_CONFIG_SRC" || true)"
  case "$MISE_TOOL_COUNT" in
    ''|*[!0-9]*) MISE_TOOL_COUNT=0 ;;
  esac

  if [ "$MISE_TOOL_COUNT" -eq 0 ]; then
    # Present but empty is a different fault from absent: `mise install` would
    # succeed having done nothing and the run would claim a complete machine.
    log_warn "mise/$MISE_CONFIG_REL declares no tools."
    log_warn "Skipping mise's tools rather than reporting a false success."
  else
    MISE_CONFIG_OK=1
    log_step "Deploying mise config (~/$MISE_CONFIG_REL)"
    link_one_file mise "$MISE_CONFIG_REL"
  fi
fi

if [ "$MISE_CONFIG_OK" -eq 1 ]; then
  log_step "Installing $MISE_TOOL_COUNT tools declared in the mise config..."
  # MISE_YES=1 accepts mise's trust prompt for a config it has not seen before.
  # Under the documented entry point -- `curl ... | bash` -- there is no TTY, so
  # that prompt blocks on stdin with nobody to answer it and the installer hangs.
  # YES/ASSUME_YES is the same switch under other names; both spellings are set so
  # a version change cannot silently un-set it.
  if MISE_YES=1 YES=1 mise install; then
    log_ok "mise installed the $MISE_TOOL_COUNT tools from its config."
  else
    log_warn "mise reported failures; see above. Any tool without a version set"
    log_warn "will error as 'No version is set for shim: <name>' until re-run."
    log_info "Retry with: mise install   (reads the same config)"
  fi
fi


# Put mise's shims on PATH for this script's remaining steps.
# Do NOT use `mise where` here: with no argument it prints usage and exits
# non-zero, so the fallback silently produced an empty PATH entry. The shims dir
# is a fixed location under MISE_DATA_DIR (default ~/.local/share/mise).
MISE_SHIMS="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"
mkdir -p "$MISE_SHIMS"
export PATH="$MISE_SHIMS:$PATH"

# ------------------------------------------------------------------------------
# 5. vite+ owns Node.js and the package managers
# ------------------------------------------------------------------------------
# mise deliberately does NOT install node or pnpm (they are absent from
# mise/config.toml). vite-plus' global CLI owns them, and its stowed
# config.json sets nodeShimMode and all four packageManagerShimModes to
# "managed" -- the only other valid value being "system_first", which is what
# this used to be set to.
#
# Two steps, both needed, and neither is optional:
#   vp env setup  creates the node/npm/pnpm/yarn/bun shims in VP_HOME/bin. Until
#                 it runs there is no `node` or `pnpm` on PATH at all, because
#                 mise no longer supplies them.
#   vp env on     records managed mode. vite+'s own docs say managed mode is
#                 "on by default" but that "fresh installers record managed mode
#                 ... after the user enables environment management" -- so a
#                 scripted install has to ask for it explicitly.
#
# VP_HOME is vite+'s own directory and is deliberately NOT stowed: it holds the
# downloaded runtimes, the shims, and generated env files. Only the small
# config.json in vite-plus/ is managed.
VP_HOME_DIR="${VP_HOME:-$HOME/.local/share/vite-plus}"
VP_BIN="$VP_HOME_DIR/bin"

if command -v vp >/dev/null 2>&1; then
  log_step "Setting up vite+ as the Node.js and package-manager owner..."
  # --refresh so a re-run repairs shims that were deleted or replaced. Non-
  # interactive: this must not block on a prompt under `curl ... | bash`.
  if NONINTERACTIVE=1 vp env setup --refresh >/dev/null 2>&1; then
    log_ok "vite+ shims ready in $VP_BIN"
  else
    log_warn "vp env setup failed; node/pnpm may be missing. Retry with:"
    log_warn "  vp env setup --refresh"
  fi

  if NONINTERACTIVE=1 vp env on >/dev/null 2>&1; then
    log_ok "vite+ managed mode enabled for node and package managers."
  else
    log_warn "vp env on failed; vite+ will keep preferring system tools."
    log_warn "  Retry with: vp env on"
  fi

  # Put the shim dir first for the rest of this script. Without it `pnpm` below
  # and in the omp section would not resolve, since mise no longer provides it.
  [ -d "$VP_BIN" ] && export PATH="$VP_BIN:$PATH"

  # Drop vite-plus from mise if an older install tracked it there.
  #
  # Same reason as the opencode cleanup above: brew/bin sits ahead of the mise
  # shims, so brew's vp wins today, but the stale `vp` shim would silently take
  # over if the formula were ever uninstalled -- resurrecting the project-local
  # 1.0.0, which has no `vp env` at all and so cannot manage Node.
  if command -v mise >/dev/null 2>&1 \
     && mise ls --installed 2>/dev/null | grep -q '^npm:vite-plus'; then
    log_info "Removing vite-plus from mise (now a Homebrew formula)..."
    mise unuse --global npm:vite-plus >/dev/null 2>&1 || true
    if mise uninstall npm:vite-plus >/dev/null 2>&1; then
      log_ok "mise no longer tracks vite-plus."
    elif mise ls --installed 2>/dev/null | grep -q '^npm:vite-plus'; then
      log_warn "mise still holds a vite-plus install; finish with:"
      log_warn "  mise unuse --global npm:vite-plus"
    else
      log_ok "mise no longer tracks vite-plus."
    fi
  fi

  log_ok "node via vite+: $(node --version 2>/dev/null || echo 'not yet installed')"
  log_ok "pnpm via vite+: $(pnpm --version 2>/dev/null || echo 'not yet installed')"
else
  log_warn "vite+ is not on PATH; node and pnpm will be missing."
  log_warn "mise no longer installs them. Retry with: brew install vite-plus"
fi

# ------------------------------------------------------------------------------
# 6. pnpm configuration
# ------------------------------------------------------------------------------
# pnpm itself now comes from vite+; this only points its global package output
# at ~/.local/bin so `omp` lands on a path fish already has.
export PNPM_HOME="$HOME/.local/share/pnpm"
mkdir -p "$HOME/.local/bin" "$PNPM_HOME"
log_step "Configuring pnpm"
pnpm config set global-bin-dir "$HOME/.local/bin" 2>/dev/null || true
pnpm config set store-dir "$PNPM_HOME/store" 2>/dev/null || true
log_ok "pnpm configured (global bin dir: $HOME/.local/bin)."

# ------------------------------------------------------------------------------
# 7. AI Agents
# ------------------------------------------------------------------------------
# pi and oh-my-pi are mise tools installed in section 5; opencode is a Homebrew
# formula from section 3. Nothing is left to do here beyond reporting what
# actually resolved, since a failed install should be visible here rather than
# surfacing later as a missing command.
log_step "Verifying AI agents (pi, opencode, omp)"
AI_AGENTS_OK=1
for agent in pi opencode omp; do
  if command -v "$agent" >/dev/null 2>&1; then
    log_ok "$agent -> $(command -v "$agent")"
  else
    log_warn "$agent is not on PATH; see the install output above."
    AI_AGENTS_OK=0
  fi
done
[ "$AI_AGENTS_OK" -eq 1 ] || log_info "Retry with: brew install opencode; mise use -g github:can1357/oh-my-pi aqua:earendil-works/pi"

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
# on Linux and never installed at all.
STOW_PACKAGES=(
  fish
  git
  mise
  starship
  atuin
  bat
  btop
  fastfetch
  herdr
  hunk
  lazygit
  vite-plus
)

# Packages linked file-by-file instead of stowed. These are NOT in
# STOW_PACKAGES -- being in both is what produced "stow failed for package:
# fresh" on every run. Stow refuses to adopt a link it did not create, so a
# package installed by this loop and then handed to stow is a conflict by
# construction: stow aborts every operation and exits 1.
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


log_step "Deploying configs with GNU Stow (${#STOW_PACKAGES[@]} packages)"

# Create every target directory BEFORE stowing.
#
# GNU Stow links a whole directory when the target directory does not already
# exist, and a per-file link when it does. That distinction matters: with a
# whole-directory link, ~/.config/fish becomes a symlink to the repo package, so
# anything fish writes there lands in the working tree -- fish_variables, and
# for herdr the session files, logs, sockets and .plugins.lock all show up as
# untracked files in the repo.
#
# Pre-creating the directories forces per-file linking, so runtime state stays on
# the machine where it belongs.
ensure_target_dirs() {
  local pkg="$1" rel_path dir
  while IFS= read -r rel_path; do
    dir="$HOME/$(dirname "$rel_path")"
    [ -L "$dir" ] && continue      # already a link; do not follow it
    mkdir -p "$dir" 2>/dev/null || true
  done < <(cd "$DOTFILES_DIR/$pkg" 2>/dev/null && find . -type f | sed 's|^\./||')
}

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
  ensure_target_dirs "$pkg"
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

log_step "Linking omp files (not stowed - see note above)"
link_omp_files

log_step "Linking file-by-file: ${EXPLICIT_LINK_PACKAGES[*]}"
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
  log_step "Installing omp plugins via pnpm..."
  # Same build-script gate as above; `2>/dev/null` would otherwise hide the
  # ERR_PNPM_IGNORED_BUILDS error that a blocked postinstall produces.
  (cd "$HOME/.omp/plugins" && pnpm install --allow-build pi-natives --allow-build pi-natives-linux-x64 2>&1 | tail -3) || log_warn "omp plugin install reported an error (see above)."
  log_ok "omp plugins installed."
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
  log_step "Regenerating fresh API types"
  fresh --cmd script types >/dev/null 2>&1 || log_warn "Could not regenerate fresh types (editor-only nicety)."

  log_info "Checking fresh init.ts"
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
  log_step "Warming the tealdeer (tldr) cache"
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
echo "  - Package sources: apt (base system) + Homebrew (fish, mise, opencode, vite-plus);"
echo "      mise for the rest; vite+ owns node and the package managers"
echo "  - mise prefix: ${MISE_SHIMS:-$HOME/.local/share/mise/shims}"
if [ "$MISE_CONFIG_OK" -eq 1 ]; then
echo "  - Tools via mise ($MISE_TOOL_COUNT, from mise/config.toml):"
# Read the names back out of the config rather than repeating them here. A third
# hardcoded copy of the tool list is exactly the drift this section exists to
# remove: it was already wrong once, and nothing would have caught it.
#
# Cut the KEY, not the value: everything after the first `=` is the version, and
# an earlier attempt printed "latest,latest,..." because it captured that side.
# Keys are optionally quoted, and a bare key (`go = "latest"`) leaves a trailing
# space in the capture, so trim it. `.*/ ` reduces `aqua:sharkdp/bat` to `bat`
# and a leading backend prefix is dropped so `npm:vite-plus` reads `vite-plus` --
# both are the names a user would actually type.
MISE_TOOL_NAMES="$(sed -n 's/^[[:space:]]*"\?\([^"=]*\)"\?[[:space:]]*=.*$/\1/p' \
  "$MISE_CONFIG_SRC" | sed 's|.*/||; s|^[a-z][a-z]*:||; s|[[:space:]]*$||' \
  | paste -sd, -)"
# `fold -s` keeps it inside the ~78 column block the rest of this summary uses.
printf '%s\n' "$MISE_TOOL_NAMES" | fold -s -w 76 | sed 's/^/      /'
else
echo "  - Tools via mise: NONE -- mise/config.toml is missing or empty (see above)"
fi
echo "  - Node.js + package managers: vite+ (managed) -- node $(node --version 2>/dev/null || echo '?'),"
echo "      pnpm $(pnpm --version 2>/dev/null || echo '?'), bun/npm/yarn shims via $VP_BIN"
echo "  - Python manager: uv (pip/venv/run/build)"
echo "  - Terminal multiplexer: herdr (with custom keybinds & Catppuccin theme)"
echo "  - Terminal emulator config: wezterm (.wezterm.lua, Windows-only; in repo, not stowed on Linux)"
echo "  - Editor: fresh (fresh-editor) with catppuccin theme, color-highlighter plugin, vi-mode + toggle"
echo "  - AI Agents: opencode (Homebrew), pi + oh-my-pi (omp) via mise"
echo "  - Skills: not managed; install with 'skills add <pkg>' (pnpm dlx, global)"
echo "  - Shell: fish (Homebrew formula) with custom aliases, abbreviations, and starship prompt"
echo "  - Configs: ${#STOW_PACKAGES[@]} stow packages, plus fresh/superfile walked and omp linked file-by-file"
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
#
# -L is required, not a nicety. Every deployed config is a stow symlink, so a
# plain `-type f` matches none of them: on a correctly stowed machine this check
# used to validate only whatever real .fish file happened to sit in conf.d/
# (vite-plus.fish) and report "fish config syntax ok." while config.fish itself
# went unchecked -- the one file most likely to break.
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
  done < <(find -L "$HOME/.config/fish" -name '*.fish' -type f 2>/dev/null | sort)
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
