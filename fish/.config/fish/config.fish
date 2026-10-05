# ============================================================
# fish config
# WSL Ubuntu @ /home/cmmhero
# ============================================================

if not status is-interactive
    exit 0
end

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
#   upd            brew + vite+
#   upd brew       brew only
#   upd vp         vite+ only (it keeps its own node/pnpm copies)
#   upd dotfiles   pull ~/dotfiles and re-run install.sh
# `install.sh` is re-run rather than just `git pull` because a pull updates the
# repo but leaves every stow symlink pointing at what was last deployed.
function upd --description 'update: brew + vite+ (upd brew|vp|dotfiles for one only)'
    set -l what $argv

    if not set -q what[1]; or contains -- $what[1] brew
        if command -q brew
            echo '==> brew'
            brew update
            # cleanup matters: without it old versions and the download cache
            # accumulate indefinitely.
            brew upgrade
            brew cleanup
        end
    end

    if not set -q what[1]; or contains -- $what[1] vp
        if command -q vp
            echo '==> vite+'
            vp upgrade
        end
    end

    if contains -- $what dotfiles
        echo '==> dotfiles'
        cd $HOME/dotfiles
        or return 1
        git pull --ff-only
        or return 1
        # Re-run so the stow symlinks pick up the pulled changes.
        ./install.sh
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
abbr -a -- reload 'exec fish'
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
