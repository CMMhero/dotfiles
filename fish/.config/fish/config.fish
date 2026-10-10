# ============================================================
# fish config -- interactive only
# WSL Ubuntu @ /home/cmmhero
#
# PATH, tool activation and the exported variables live in profile.fish, which
# runs for every fish process. This file is everything that only matters at a
# prompt: the starship prompt, key bindings, abbreviations, aliases and the
# helper functions. It exits immediately for a non-interactive shell, so
# `fish -c 'some command'` pays for none of it.
# ============================================================

if not status is-interactive
    exit 0
end

# Silence fish's "Welcome to fish, the friendly interactive shell" banner.
# Empty (not unset) is what suppresses it; unset would let fish print its
# default. Set before anything else so it applies to every interactive start.
set -g fish_greeting ""

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
# The FZF_* variables are set in profile.fish, next to the rest of the
# environment. Only the bindings belong to an interactive shell.
#
# fzf's shell/key-bindings.fish is vendored in conf.d/: the aqua fzf package
# ships only the binary and no shell integrations, so without this file
# Ctrl-T / Alt-C would silently stop working.
#
# Called HERE, not just in conf.d/, because fish loads conf.d/ before this file:
# the call in conf.d/ ran before mise was activated (profile.fish, same story)
# and so never found fzf. This is the pass that actually installs the bindings,
# and the pass whose "fzf was not found in path." message means something real.
# Re-calling is safe -- it rebinds, it does not append.
if functions -q fzf_key_bindings
    fzf_key_bindings
end

# ---------- atuin ----------
# ATUIN_NOBIND is already exported by profile.fish; init has to come after it.
# Load only if present.
if command -q atuin
    atuin init fish | source
end

bind \cr _atuin_search
bind -M insert \cr _atuin_search

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
    alias tree='eza --tree -aR --icons=auto --ignore-glob "node_modules|.git"'
    alias dtree='eza --tree -aR --only-dirs --icons=auto --ignore-glob "node_modules|.git"'
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
#   upd                    apt + brew + mise + pi + omp + dotfiles
#   upd apt|brew|mise|pi|omp|dotfiles    just that one
#
# opencode has no target of its own: it is a Homebrew formula now, so `upd brew`
# covers it. It used to be listed here and matched no branch, which made
# `upd opencode` silently do nothing.
#
# Order is deliberate: apt first because it is slowest (sudo, possible password)
# and most likely to fail, so a failure there does not mask the rest. brew next,
# because it is the other system package manager and also needs a refresh before
# anything reads its metadata. dotfiles is last because it re-runs install.sh.
#
# Everything is non-interactive and auto-accepting: apt gets -y, brew runs with
# NONINTERACTIVE=1 and HOMEBREW_NO_AUTO_UPDATE=1, mise gets MISE_YES=1, and
# pi/omp get their approve/force flags. Each of these can otherwise block on a
# prompt that, from a script or a non-interactive run, has nobody to answer it.
# sudo may still ask for a password the first time; that one cannot be bypassed
# and should not be.
function upd --description 'update everything: apt, brew, mise, pi, omp, dotfiles'
    set -l what $argv

    # `selected` is declared up front and only assigned inside the if/else.
    # A `set` that creates a variable inside a fish block is block-local and
    # disappears when the block ends, which would leave every `contains` below
    # matching an empty list -- silently doing nothing.
    set -l selected
    if set -q what[1]
        set selected $what
    else
        set selected apt brew mise pi omp dotfiles
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

    # brew owns fish and mise itself, plus a few formulas installed by hand.
    # Without this step they drift while everything else updates -- the gap that
    # let fish fall behind with nothing in `upd` touching it.
    #
    # `brew update` first, then `brew upgrade`. Order matters and is not
    # interchangeable: upgrade resolves against the metadata update refreshes,
    # so upgrading against stale metadata skips versions that were already
    # published when it last ran.
    #
    # NONINTERACTIVE=1 is the switch that matters. Without it brew can stop on a
    # prompt -- a licence, a tap confirmation, a cleanup question -- and this
    # function has no way to answer it. HOMEBREW_NO_AUTO_UPDATE=1 stops every
    # individual `brew upgrade` from silently re-running `brew update` itself,
    # which would make the explicit update above redundant and slow.
    if contains brew $selected; and type -q brew
        step "brew"
        # shellcheck disable=SC2034 # HOMEBREW_NO_INSTALL_FROM_API speeds up `brew update`
        NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 brew update --quiet
        NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 brew upgrade
        # Plain cleanup, not --prune=all: it reclaims the superseded versions
        # left behind by the upgrade above, and that is the bulk of the space.
        # --prune=all is safe for the current formulae either way, but it also
        # drops every cached bottle, so the next install re-downloads them all.
        NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 brew cleanup
    end

    # mise covers every CLI tool plus node and pnpm. `mise upgrade` updates all
    # of them and reinstalls whatever moved. apt and brew stay separate: mise has
    # no system-package backend, so those are not managed here.
    if contains mise $selected; and type -q mise
        step "mise"
        # MISE_YES=1 auto-accepts mise's trust prompt for any newly seen backend;
        # without a TTY that prompt would hang the whole run.
        MISE_YES=1 mise upgrade
    end

    # The agent BINARIES come from mise (aqua:earendil-works/pi,
    # github:can1357/oh-my-pi), already updated by the mise step above. opencode
    # is a brew formula and is updated by the brew step. What mise does not touch
    # is the extensions and plugins, so these branches handle only those -- no
    # --self-style self-update, which would move the binary behind mise's back and
    # desync the version it pins.
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

# ----- du -> dust, df -> duf -----
# dust and duf are drop-in-ish replacements for du and df with better output
# (colour, human-readable sizes by default, and for duf a bar chart).
#
# abbr rather than alias, matching the rest of this file: it expands before the
# command is resolved and cannot recurse into itself, so `du -sh .` becomes
# `dust -sh .` and there is no way for dust to call du back.
#
# Both flags are near-compatible for the common cases but not identical, which is
# why `du-real` / `df-real` exist. The ones worth knowing:
#   du    -h is on by default in dust; -b/-c/-s/-d all still work.
#   df    dust... duf: -h is default; --tree adds a breakdown; df-only flags like
#         -i (inodes) are NOT supported and will error.
# Overriding `df` is the riskier of the two -- scripts that parse df output will
# break -- so `df-real` is the documented way out.
if command -q dust
    abbr -a -- du dust
    function du-real --description 'real du' --wraps du
        command du $argv
    end
end
if command -q duf
    abbr -a -- df duf
    function df-real --description 'real df' --wraps df
        command df $argv
    end
end


# Create a private GH repo from the current dir, push, and open the browser.
# No --remote=origin: push.autoSetupRemote=true in ~/.gitconfig already wires
# the new repo's upstream on the first push, so naming it here is redundant.
alias gh-create 'gh repo create --private --source=.; and git push -u --all; and gh browse'

# ----- misc -----
abbr -a -- ip 'curl http://ifconfig.me/ip'
abbr -a -- please sudo
abbr -a -- pls sudo
abbr -a -- reload 'exec fish'
abbr -a -- ff fastfetch
abbr -a -- cls clear
abbr -a -- add 'mise use -g'

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

# ----- vp-first: npm/npx mapped onto vite+ -----
# vite+ owns node and the package managers, so the wrappers dispatch to `vp`
# rather than shelling out to pnpm. The mapping is not a rename -- vp splits what
# npm treats as one command with an argument:
#   npm install          -> vp install
#   npm install <pkg>    -> vp add <pkg>      (vp install <pkg> also works)
#   npm uninstall <pkg>  -> vp remove <pkg>
#   npm update           -> vp update
#   npm run <script>     -> vp run <script>   (also `vpr`)
#   npx <pkg>            -> vpx <pkg>
# Escape hatches: npm-real / npx-real call the real binaries.
if command -q vp
    function npm --description 'npm mapped to vp: install/add/remove/update/run'
        set -l cmd $argv[1]
        switch $cmd
            case install i
                # `npm install` alone is argv[1] only, count 1. With packages the
                # first one is argv[2] -- testing `-le 2` here silently routed
                # `npm install left-pad` to the no-packages branch.
                if test (count $argv) -le 1
                    vp install
                else
                    vp add $argv[2..-1]
                end
            case uninstall un rm remove
                vp remove $argv[2..-1]
            case update up
                vp update $argv[2..-1]
            case run
                vp run $argv[2..-1]
            case exec
                vpx $argv[2..-1]
            case '*'
                # Guessing here would be worse than failing: a silent passthrough
                # would run `vp <npm-subcommand>`, which is not the same thing.
                echo "npm: '$cmd' has no vp mapping." >&2
                echo "  install|i -> vp install|vp add | remove -> vp remove | update -> vp update" >&2
                echo "  run -> vp run | exec -> vpx        (real npm: npm-real $cmd)" >&2
                return 1
        end
    end

    function npx --description 'npx mapped to vpx; `npx skills` uses the skills defaults' --wraps vpx
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
        vpx $argv
    end

    function npm-real --description 'real npm escape hatch'
        command npm $argv
    end

    function npx-real --description 'real npx escape hatch'
        command npx $argv
    end
end

# ----- project scaffolding -----
# vp create is vite+'s own scaffolder; it takes the same --editor and
# --package-manager flags pnpm create did.
if command -q vp
    function pncr --description 'vp create --editor zed --package-manager pnpm' --wraps vp
        vp create --editor zed --package-manager pnpm $argv
    end
end

# ----- skills (vpx; global by default) -----
# `skills` reads no config file or env vars for agent selection, so the defaults
# are injected here. Two things matter and both were wrong before:
#
# 1. Invocation goes through `vpx`, not `command npx`. `command npx` deliberately
#    bypasses fish functions, so it reached the real npx shim and skipped these
#    defaults entirely.
# 2. Scope flags go AFTER the source. skills 1.7.0's `-a/--agent` is variadic
#    and swallows the source if it comes first, and a leading `-g` is silently
#    ignored, which installed into ~/.agents/skills (project scope) instead of
#    the agent dir. Flags after the source are parsed correctly.
function skills --description 'skills (vpx; defaults to -g --agent pi claude-code --yes)'
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

            vpx skills@latest add $src $scope $agent $yes $rest
        case '*'
            vpx skills@latest $argv
    end
end
