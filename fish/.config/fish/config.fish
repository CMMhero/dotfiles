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

# ---------- Homebrew first ----------
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

# ---------- Vite+ default (pnpm-first) ----------
set -gx VP_PACKAGE_MANAGER "pnpm@latest"
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
# brew fzf; Ctrl-R is owned by atuin, which binds the same muscle memory.
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
source /home/linuxbrew/.linuxbrew/opt/fzf/shell/key-bindings.fish
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

# ----- update -----
# One entry point for everything this machine keeps current:
#   upd                    apt + brew + vite+ + pi + omp + opencode + dotfiles
#   upd apt|brew|vp|pi|omp|opencode|dotfiles    just that one
#
# Order is deliberate: apt first because it is slowest (sudo, possible password)
# and most likely to fail, so a failure there does not mask the rest. dotfiles
# is last because it re-runs install.sh.
#
# Everything is non-interactive: apt gets -y, `brew cleanup` gets -s (it
# otherwise asks "delete this?" per file), and pi/omp get their approve/force
# flags. sudo may still ask for a password on the first call -- that one cannot
# be bypassed, and should not be.
function upd --description 'update all: apt brew vp pi omp opencode dotfiles'
    set -l what $argv

    # `selected` is declared up front and only assigned inside the if/else.
    # A `set` that creates a variable inside a fish block is block-local and
    # disappears when the block ends, which would leave every `contains` below
    # matching an empty list -- silently doing nothing.
    set -l selected
    if set -q what[1]
        set selected $what
    else
        set selected apt brew vp pi omp opencode dotfiles
    end

    if contains apt $selected; and command -v apt-get >/dev/null 2>&1
        echo '==> apt'
        sudo apt-get update -y
        # full-upgrade also removes packages that became obsolete, which plain
        # upgrade leaves behind.
        sudo apt-get full-upgrade -y
        sudo apt-get autoremove --purge -y
        sudo apt-get clean
    end

    if contains brew $selected; and command -q brew >/dev/null 2>&1
        echo '==> brew'
        brew update
        # `brew upgrade` with no arguments upgrades EVERY outdated formula, but
        # formulae only -- casks are a separate namespace and need --cask. There
        # are no casks installed at the moment, so --cask on its own would just
        # error, hence the conditional.
        brew upgrade
        if test (count (brew list --cask 2>/dev/null)) -gt 0
            brew upgrade --cask
        end
        # -s skips the per-file "delete this?" prompt that plain cleanup asks.
        brew cleanup -s
    end

    if contains vp $selected; and command -q vp >/dev/null 2>&1
        echo '==> vite+'
        vp upgrade
    end

    # pi: --all covers pi itself plus the extensions listed in its settings
    # (pi-commandcode-provider, opencode-pi). --approve skips the trust prompt.
    if contains pi $selected; and command -q pi >/dev/null 2>&1
        echo '==> pi'
        pi update --all --approve
    end

    # omp: -f force, -l also update installed plugins.
    if contains omp $selected; and command -q omp >/dev/null 2>&1
        echo '==> omp'
        omp update -f -l
    end

    # opencode is a brew formula, and brew is the single source of truth for it
    # (the self-install at ~/.opencode/bin was removed precisely so there is
    # one copy). `brew upgrade` is non-interactive; `opencode upgrade` would
    # only work if a self-install were still on PATH.
    if contains opencode $selected; and command -q opencode >/dev/null 2>&1
        echo '==> opencode'
        if command -q brew >/dev/null 2>&1
            brew upgrade opencode
        else
            opencode upgrade
        end
    end

    if contains dotfiles $selected; or contains dotfiles $what
        echo '==> dotfiles'
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
            echo "    autostash conflicted on: "(string join -- ', ' $conflicts)
            echo "    Your local edits are safe in the stash; upstream is already pulled."
            echo "    Resolve with:  git -C $HOME/dotfiles stash pop"
            echo "    (or discard with: git -C $HOME/dotfiles checkout -- . && git -C $HOME/dotfiles stash drop)"
            echo "    install.sh was NOT run."
            return 1
        end

        if [ $pull_status -ne 0 ]
            echo "    dotfiles pull failed (status $pull_status); skipping install.sh"
            return 1
        end

        # Re-run so the stow symlinks pick up the pulled changes. --config-only
        # matters here: this function has already run the apt/brew/vite+/agent
        # updates above, and a plain ./install.sh would repeat that entire
        # package cycle a second time.
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

# brew ships bat/fd under their real names — no distro-name shims needed.
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

# ----- Vite+ (`vp`) shortcuts -----
# Only defined when `vp` exists; kept identical otherwise.
if command -q vp
    function vpcr --description 'vp create --package-manager pnpm --editor zed --agent agents,claude' --wraps vp
        vp create --package-manager pnpm --editor zed --agent agents,claude $argv
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
