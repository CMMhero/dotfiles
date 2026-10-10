# ============================================================
# fish profile -- login environment
# WSL Ubuntu @ /home/cmmhero
#
# Runs once per login shell, interactive or not: `fish -c`, `fish script.fish`,
# an editor's shell integration, a herdr pane. Everything here is PATH, exported
# variables and tool activation -- the things a non-interactive fish still needs
# in order to find a command. Everything interactive (prompt, key bindings,
# abbreviations, aliases) lives in config.fish, which exits early when the shell
# is not interactive.
#
# Load order is conf.d/ -> profile.fish -> config.fish, so conf.d/catppuccin.fish
# has already set $FZF_CATPPUCCIN_OPTS by the time the fzf block below reads it.
#
# Split from a single config.fish because that file opened with
# `if not status is-interactive; exit 0`. Everything above was therefore
# invisible to `fish -c`, which is not the same as not being needed: a script
# running under fish had no mise, no brew and no vite+ on its PATH.
# ============================================================

# ---------- mise first ----------
# mise supplies every tool except the apt base set, including node and pnpm.
# `mise activate` hooks the shell so tool versions follow the directory, and
# prepends the shims dir so mise binaries win over ~/.local/bin and /usr/bin.
#
# First because everything below is a PATH edit that has to end up BEHIND the
# shims: brew's own shellenv prepends, so activating mise after it would put
# brew/bin ahead of the tools mise owns.
#
# Use the absolute path: on a fresh login there may be no mise on PATH yet.
if test -x "$HOME/.local/bin/mise"
    "$HOME/.local/bin/mise" activate fish | source
else if type -q mise
    mise activate fish | source
end

# ---------- homebrew ----------
# brew shellenv prepends $HOMEBREW_PREFIX/{bin,sbin}.
# rustup is keg-only (conflicts with the `rust` formula) and is NOT linked
# into brew/bin, so its rustc/cargo/clippy shims need an explicit add.
#
# Guarded, unlike the rest of this file: this now runs for every `fish -c` too,
# and an unguarded eval of a missing brew prints an error into the output of
# whatever script happened to shell out to fish. A machine that has not run
# install.sh yet just gets no brew in its PATH, which is the truth anyway.
if test -x /home/linuxbrew/.linuxbrew/bin/brew
    eval (/home/linuxbrew/.linuxbrew/bin/brew shellenv fish)
    set -gx HOMEBREW_PREFIX /home/linuxbrew/.linuxbrew
    fish_add_path /home/linuxbrew/.linuxbrew/opt/rustup/bin
else if test -x "$HOME/.linuxbrew/bin/brew"
    eval ("$HOME/.linuxbrew/bin/brew" shellenv fish)
    set -gx HOMEBREW_PREFIX "$HOME/.linuxbrew"
    fish_add_path "$HOME/.linuxbrew/opt/rustup/bin"
end

# Every brew call in this shell auto-accepts. Set here rather than only inside
# `upd` so an interactive `brew install`/`brew upgrade` is non-interactive too:
# a prompt with no one to answer it hangs the terminal, and the usual triggers
# (a licence, a tap confirmation, a cleanup question) come up unpredictably.
#
# HOMEBREW_NO_AUTO_UPDATE=1 disables brew's implicit per-command `brew update`,
# which otherwise runs in the background of every other brew command and can
# interleave its own prompts. `upd brew` runs `brew update` explicitly instead,
# where the ordering is visible and the output belongs.
set -gx HOMEBREW_NO_AUTO_UPDATE 1
set -gx HOMEBREW_NO_INSTALL_FROM_API 1
set -gx HOMEBREW_NO_ANALYTICS 1
set -gx HOMEBREW_NO_ENV_HINTS 1
set -gx NONINTERACTIVE 1

# NONINTERACTIVE=1 above is NOT enough to stop brew asking. Homebrew 7.x
# added an explicit confirmation to `brew upgrade` and `brew install`, and
# Ask.confirm? checks one thing only -- whether stdin and stdout are a TTY:
#
#     def self.confirm?(action:)
#       return false if !$stdin.tty? || !$stdout.tty?
#       ohai "Do you want to proceed with the #{action}? [y/n]"
#
# No HOMEBREW_* variable and not NONINTERACTIVE is consulted, so from a real
# terminal it prompts unconditionally. `upd brew` is run from a real terminal,
# which is exactly where it showed up:
#
#     ==> Would upgrade 2 outdated packages
#     ==> Do you want to proceed with the upgrade? [y/n]
#
# HOMEBREW_NO_ASK is the switch for it (brew's own words: "Ask mode is the
# default unless $HOMEBREW_NO_ASK is set"). Deliberately left to one variable
# rather than passing `-y` on each command: the prompt is interactive-only, so
# it appears exactly where there is no flag to add.
set -gx HOMEBREW_NO_ASK 1

# ---------- Editor ----------
if command -q fresh
    set -gx EDITOR fresh
    set -gx VISUAL fresh
else if command -q nvim
    set -gx EDITOR nvim
    set -gx VISUAL nvim
else if command -q vim
    set -gx EDITOR vim
    set -gx VISUAL vim
else
    set -gx EDITOR nano
    set -gx VISUAL nano
end

# ---------- vite+ (Node.js + package managers) ----------
# vite+ owns node, npm, pnpm, yarn and bun; mise installs none of them. Source
# vite+'s own fish integration, which prepends its shim dir so `node` resolves
# through it, and wraps the `vp` function so `vp env use` can export
# VP_NODE_VERSION into this session.
#
# Sourced here explicitly rather than left to vite+'s own
# ~/.config/fish/conf.d/vite-plus.fish, which it writes on first setup. That hook
# is written once and `vp env setup --refresh` does NOT rewrite it -- it kept a
# stale path after a VP_HOME change and had to be deleted by hand, which broke
# every fish start until it was regenerated. Reading env.fish directly means the
# path is always whatever vite+ currently has.
#
# The file is generated into ~/.config/vite-plus, so it is machine state, not a
# stowed config -- hence the guard. Guarding also means a machine where the setup
# has not run yet starts normally rather than erroring on a missing file.
if test -r "$HOME/.config/vite-plus/env.fish"
    source "$HOME/.config/vite-plus/env.fish"
else if test -d "$HOME/.local/share/vite-plus/bin"
    # No env.fish, but the shims exist: do the PATH half by hand so node/pnpm
    # still resolve. The `vp env use` wrapper is simply unavailable.
    fish_add_path "$HOME/.local/share/vite-plus/bin"
    fish_add_path -a "$HOME/.local/share/vite-plus/fallback-bin"
end

# ---------- pnpm ----------
# pnpm itself comes from vite+ now. PNPM_HOME stays so global packages such as
# omp land on a path that is already here.
set -gx PNPM_HOME "$HOME/.local/share/pnpm"
test -d "$PNPM_HOME"; and fish_add_path "$PNPM_HOME"
fish_add_path "$HOME/.local/bin"

# ---------- fzf defaults ----------
# fzf; Ctrl-R is owned by atuin, which binds the same muscle memory.
# Styled popup + previews for Ctrl-T (files) / Alt-C (dirs). Ctrl-R is owned
# by atuin, so FZF_DEFAULT_COMMAND only feeds the file pickers.
# Colours come from conf.d/catppuccin.fish (Catppuccin Macchiato, matching
# wezterm/.wezterm.lua); only the layout flags are set here.
set -gx FZF_DEFAULT_COMMAND 'fd --type f --hidden --follow --exclude .git'
set -gx FZF_DEFAULT_OPTS "$FZF_CATPPUCCIN_OPTS"
set -gx FZF_CTRL_T_COMMAND $FZF_DEFAULT_COMMAND
set -gx FZF_CTRL_T_OPTS "--preview 'bat --color=always -n --line-range :500 {}'"
set -gx FZF_ALT_C_COMMAND 'fd --type d --hidden --follow --exclude .git'
set -gx FZF_ALT_C_OPTS "--preview 'eza --icons=always --tree --color=always {} | head -200'"

# ---------- atuin ----------
# ATUIN_NOBIND has to be set before `atuin init`, which config.fish runs after
# this file. It is an env var rather than a binding, so it lives here; the init
# itself and the \cr rebinding stay in config.fish.
set -gx ATUIN_NOBIND "true"

# tealdeer (binary ships as `tldr`); read pages + completions from here.
set -gx TEALDEER_CONFIG_DIR "$HOME/.config/tealdeer"
