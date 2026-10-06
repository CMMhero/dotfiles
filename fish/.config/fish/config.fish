# ============================================================
# fish config
# WSL Ubuntu @ /home/cmmhero
# ============================================================

if not status is-interactive
    exit 0
end

# Silence fish's "Welcome to fish, the friendly interactive shell" banner.
# Empty (not unset) is what suppresses it; unset would let fish print its
# default. Set before anything else so it applies to every interactive start.
set -g fish_greeting ""

# ---------- mise first ----------
# mise supplies every tool except the apt base set, including node and pnpm.
# `mise activate` hooks the shell so tool versions follow the directory, and
# prepends the shims dir so mise binaries win over ~/.local/bin and /usr/bin.
#
# Use the absolute path: on a fresh login there may be no mise on PATH yet.
if test -x "$HOME/.local/bin/mise"
    "$HOME/.local/bin/mise" activate fish | source
else if type -q mise
    mise activate fish | source
end

# ---------- homebrew ----------
# brew shellenv prepends $HOMEBREW_PREFIX/{bin,sbin}. Keep this above every
# other PATH edit below so brew binaries win over ~/.local/bin and /usr/bin.
# rustup is keg-only (conflicts with the `rust` formula) and is NOT linked
# into brew/bin, so its rustc/cargo/clippy shims need an explicit add.
eval (/home/linuxbrew/.linuxbrew/bin/brew shellenv fish)
fish_add_path /home/linuxbrew/.linuxbrew/opt/rustup/bin

set -gx HOMEBREW_PREFIX /home/linuxbrew/.linuxbrew

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

# ---------- pnpm ----------
# pnpm is a mise tool (core:pnpm). PNPM_HOME stays so global packages such as
# omp land on a path that is already here.
set -gx PNPM_HOME "$HOME/.local/share/pnpm"
test -d "$PNPM_HOME"; and fish_add_path "$PNPM_HOME"
fish_add_path "$HOME/.local/bin"
# ---------- Starship prompt ----------
if command -q starship
    starship init fish | source
end

# ---------- Zoxide (cd = __zoxide_z, cdi = __zoxide_zi) ----------
if command -q zoxide
    zoxide init --cmd cd fish | source
    # zoxide --cmd cd already provides `cdi` (interactive); keep explicit
    # alias as well for muscle memory in case init ever changes:
    alias cdi='cd -i'
end

# ---------- fzf keybindings (Ctrl-T / Ctrl-R / Alt-C feel) ----------
# fzf; Ctrl-R is owned by atuin, which binds the same muscle memory.
set -gx FZF_DEFAULT_COMMAND 'fd --type f --hidden --follow --exclude .git'
# Styled popup + previews for Ctrl-T (files) / Alt-C (dirs). Ctrl-R is owned
# by atuin, so FZF_DEFAULT_COMMAND only feeds the file pickers.
# Colours come from conf.d/catppuccin.fish (Catppuccin Macchiato, matching
# wezterm/.wezterm.lua); only the layout flags are set here.
set -gx FZF_DEFAULT_OPTS "$FZF_CATPPUCCIN_OPTS"
set -gx FZF_CTRL_T_COMMAND $FZF_DEFAULT_COMMAND
set -gx FZF_CTRL_T_OPTS "--preview 'bat --color=always -n --line-range :500 {}'"
set -gx FZF_ALT_C_COMMAND 'fd --type d --hidden --follow --exclude .git'
set -gx FZF_ALT_C_OPTS "--preview 'eza --icons=always --tree --color=always {} | head -200'"
# fzf's shell/key-bindings.fish is vendored in conf.d/: the aqua fzf package
# ships only the binary and no shell integrations, so without this file
# Ctrl-T / Alt-C would silently stop working.
fzf_key_bindings

# ---------- atuin ----------
# Load only if present.
if command -q atuin
    atuin init fish | source
end

# ============================================================
# Abbreviations + aliases
# abbr expands visibly; alias where a command is replaced outright (ls/cat/grep/find/vim...) or takes no expansion

# ============================================================

# ----- eza: ll / la / l / ls / tree -----
if command -q eza
    alias l='eza -F --no-filesize --no-permissions --no-user --icons=auto --group-directories-first'
    alias ls='eza -aF --icons=auto --group-directories-first'
    alias la='eza -laF --no-filesize --no-permissions --no-user --icons=auto --group-directories-first'
    alias ll='eza -laF --git --icons=auto --group-directories-first'
    alias tree='eza -F --tree --icons=auto --ignore-glob "node_modules|.git"'
    alias dtree='eza -aF --tree --only-dirs --icons=auto --ignore-glob "node_modules|.git"'
end

# ----- output helpers -----
# Same three levels as install.sh / uninstall.sh, so all three read alike:
#   step  a section header, banner form (rule, bold centred title, rule)
#   info  a detail line under the current header, indented
#   ok / warn / err
#         status, bracketed so they stand out when scrolling back
set -g __CATPPPUCCIN_RULE '==============================================================='

function step --description 'section header, banner form'
    set -l title (string join ' ' $argv)
    set_color yellow --bold
    echo $__CATPPPUCCIN_RULE
    printf '  %s%s\n' (string pad -r -w 62 -- "$title") ''
    echo $__CATPPPUCCIN_RULE
    set_color normal
end

function info --description 'indented detail line'
    printf '   \e[0;36m->\e[0m %s\n' "$argv"
end

function ok --description 'success status line'
    printf '   \e[1;32m[ok]\e[0m   %s\n' "$argv"
end

function warn --description 'warning status line'
    printf '   \e[1;33m[warn]\e[0m %s\n' "$argv"
end

function err --description 'error status line'
    printf '   \e[1;31m[err]\e[0m  %s\n' "$argv"
end

# ----- update -----
# One entry point for everything this machine keeps current:
#   upd                    apt + mise + pi + omp + opencode + dotfiles
#   upd apt|mise|pi|omp|opencode|dotfiles    just that one
#
# Order is deliberate: apt first because it is slowest (sudo, possible password)
# and most likely to fail, so a failure there does not mask the rest. dotfiles
# is last because it re-runs install.sh.
#
# Everything is non-interactive: apt gets -y, mise needs no flags, and pi/omp
# get their approve/force flags. sudo may still ask for a password the first
# time; that one cannot be bypassed and should not be.
function upd --description 'update everything: apt, mise, pi, omp, opencode, dotfiles'
    set -l what $argv

    # `selected` is declared up front and only assigned inside the if/else.
    # A `set` that creates a variable inside a fish block is block-local and
    # disappears when the block ends, which would leave every `contains` below
    # matching an empty list -- silently doing nothing.
    set -l selected
    if set -q what[1]
        set selected $what
    else
        set selected apt mise pi omp opencode dotfiles
    end

    if contains apt $selected; and command -v apt-get >/dev/null 2>&1
        step "apt"
        sudo apt-get update -y
        # full-upgrade also removes packages that became obsolete, which plain
        # upgrade leaves behind.
        sudo apt-get full-upgrade -y
        sudo apt-get autoremove --purge -y
        sudo apt-get clean
    end

    # mise covers every CLI tool plus node and pnpm. `mise upgrade` updates all
    # of them and reinstalls whatever moved. apt stays separate: mise has no
    # system-package backend, so the base packages are not managed here.
    if contains mise $selected; and type -q mise
        step "mise"
        mise upgrade
    end

    # The agent BINARIES come from mise (aqua:earendil-works/pi,
    # aqua:anomalyco/opencode, github:can1357/oh-my-pi), already updated by the
    # mise step above. What mise does not touch is their extensions and plugins,
    # so these branches handle only those -- no --self-style self-update, which
    # would move the binary behind mise's back and desync the version it pins.
    #
    # pi: --extensions updates the packages from its settings
    # (pi-commandcode-provider, opencode-pi); --approve skips the trust prompt.
    if contains pi $selected; and command -q pi >/dev/null 2>&1
        step "pi extensions"
        pi update --extensions --approve
    end

    # omp: -l updates installed plugins only.
    if contains omp $selected; and command -q omp >/dev/null 2>&1
        step "omp plugins"
        omp update -l
    end

    if contains dotfiles $selected; or contains dotfiles $what
        step "dotfiles"
        # Run from the repo without leaving the caller's cwd behind.
        pushd $HOME/dotfiles >/dev/null

        # Two things made this silently do nothing before:
        #  - `--ff-only` contradicts `pull.rebase = true` in ~/.gitconfig, so
        #    git refused outright.
        #  - Because every config is a stow symlink, editing a config in a live
        #    session writes straight into this repo, so the working tree is
        #    routinely dirty and a plain pull refuses. `--autostash` stashes,
        #    pulls, then restores.
        # Output is shown rather than swallowed so a failure is visible instead
        # of the function just quietly returning.
        git pull --rebase --autostash
        set -l pull_status $status

        # An autostash that will not re-apply cleanly leaves conflict markers in
        # the worktree. That happens routinely here: the live tree is dirty
        # because editing a stowed config writes into this repo, and upstream
        # often edits the same file. Never run install.sh on a conflicted tree.
        set -l conflicts (git diff --name-only --diff-filter=U)
        popd >/dev/null

        if [ (count $conflicts) -gt 0 ]
            echo ""
            info "autostash conflicted on: "(string join -- ', ' $conflicts)
            info "Your local edits are safe in the stash; upstream is already pulled."
            info "Resolve with:  git -C $HOME/dotfiles stash pop"
            info "(or discard with: git -C $HOME/dotfiles checkout -- . && git -C $HOME/dotfiles stash drop)"
            info "install.sh was NOT run."
            return 1
        end

        if [ $pull_status -ne 0 ]
            err "dotfiles pull failed (status $pull_status); skipping install.sh"
            return 1
        end

        # Re-run so the stow symlinks pick up the pulled changes. --config-only
        # matters: this function has already updated apt, mise and the agents
        # above, and a plain ./install.sh would repeat that whole cycle.
        cd $HOME/dotfiles; and ./install.sh --config-only
    end
end

# ----- navigation -----
abbr -a -- .. 'cd ..'
abbr -a -- ... 'cd ../..'
abbr -a -- .... 'cd ../../..'
abbr -a -- h history

# ----- open in editor / explorer  -----
# WSL: zed is the Windows build; explorer.exe opens File Explorer.
if command -q zed
    abbr -a -- c. 'zed .'
    abbr -a -- c zed
else
    abbr -a -- c. '$EDITOR .'
    abbr -a -- c '$EDITOR'
end
abbr -a -- e. 'explorer.exe .'
abbr -a -- e explorer.exe

# ----- git -----
abbr -a -- g git
abbr -a -- ga 'git add .'
abbr -a -- gc 'git commit -m'
abbr -a -- gcl 'git clone'
abbr -a -- gp 'git push'
abbr -a -- gpl 'git pull'
abbr -a -- gst 'git status -s'
abbr -a -- gd 'git diff'
abbr -a -- gl 'git log --oneline --graph --decorate'
abbr -a -- gco 'git checkout'
abbr -a -- gb 'git branch'
abbr -a -- gpo 'git push origin'
if command -q lazygit
    abbr -a -- lg lazygit
end


# Create a private GH repo from the current dir, push, and open the browser.
# No --remote=origin: push.autoSetupRemote=true in ~/.gitconfig already wires
# the new repo's upstream on the first push, so naming it here is redundant.
alias gh-create 'gh repo create --private --source=.; and git push -u --all; and gh browse'

# ----- misc -----
abbr -a -- ip 'curl http://ifconfig.me/ip'
abbr -a -- please sudo
abbr -a -- pls sudo
abbr -a -- reload 'exec fish -l'
abbr -a -- ff fastfetch
abbr -a -- cls clear

# ----- modern CLI replacements -----
abbr -a -- htop btop
abbr -a -- top btop

# bat and fd ship under their real names, so no distro-name shims are needed.
alias cat=bat
alias find=fd

# ripgrep as grep replacement
if command -q rg
    alias grep='rg --color=auto'
end

# ----- pnpm-first (npm->pnpm, npx->pnpm dlx) -----
# Escape hatches: npm-real / npx-real call the real binaries.
if command -q pnpm
    function npm --description 'pnpm passthrough' --wraps pnpm
        pnpm $argv
    end
    function npx --description 'pnpm dlx passthrough; `npx skills` uses the skills defaults' --wraps pnpm
        # Route `npx skills ...` (incl. `npx -y skills`, `skills@latest`) to
        # the skills wrapper below so it picks up the -g/--agent/--yes
        # defaults. Only the first matching token is treated as the package.
        set -l total (count $argv)
        for i in (seq $total)
            switch $argv[$i]
                case '-*' '-y*' '--yes*'
                    # leading npx flag, keep scanning
                case skills 'skills@*'
                    if test $i -lt $total
                        skills $argv[(math $i + 1)..-1]
                    else
                        skills
                    end
                    return
            end
        end
        pnpm dlx $argv
    end
    function npm-real --description 'real npm escape hatch' --wraps npm
        command npm $argv
    end
    function npx-real --description 'real npx escape hatch'
        command npx $argv
    end
end

# ----- pnpm project scaffolding -----
# Replaces the old `vp create` shortcut. pnpm comes from mise now.
if command -q pnpm
    function pncr --description 'pnpm create --editor zed --package-manager pnpm' --wraps pnpm
        pnpm create --editor zed --package-manager pnpm $argv
    end
end

# ----- skills (pnpm dlx; global by default) -----
# `skills` reads no config file or env vars for agent selection, so the defaults
# are injected here. Two things matter and both were wrong before:
#
# 1. Invocation goes through `pnpm dlx`, not `command npx`. `command npx`
#    deliberately bypasses fish functions, so it reached the real npx shim and
#    skipped these defaults entirely.
# 2. Scope flags go AFTER the source. skills 1.7.0's `-a/--agent` is variadic
#    and swallows the source if it comes first, and a leading `-g` is silently
#    ignored, which installed into ~/.agents/skills (project scope) instead of
#    the agent dir. Flags after the source are parsed correctly.
function skills --description 'skills (pnpm dlx; defaults to -g --agent pi claude-code --yes)'
    switch $argv[1]
        case add a
            set -l src $argv[2]
            if test -z "$src"
                echo "skills: missing <package>" >&2
                return 1
            end
            # Everything after the source is the caller's own flags.
            set -l rest $argv[3..]

            # Respect an explicit scope or agent selection.
            set -l scope
            if contains -- --agent $rest;   or contains -- -a $rest
            else if contains -- --all $rest
            else if contains -- -g $rest;    or contains -- --global $rest
            else if contains -- -p $rest;    or contains -- --project $rest
                set scope
            else
                # Default to global so `skills add x` never lands in the cwd.
                set scope -g
            end

            set -l agent
            if not contains -- --agent $rest; and not contains -- -a $rest
                set agent --agent pi claude-code
            end

            set -l yes
            if not contains -- --yes $rest; and not contains -- -y $rest
                set yes --yes
            end

            pnpm dlx skills@latest add $src $scope $agent $yes $rest
        case '*'
            pnpm dlx skills@latest $argv
    end
end

# tealdeer (binary ships as `tldr`); read pages + completions from here.
set -gx TEALDEER_CONFIG_DIR "$HOME/.config/tealdeer"
