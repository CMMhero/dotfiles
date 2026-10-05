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
# ---------- Starship (starship init nu) ----------
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
# brew fzf; nu gets this via atuin/fzf muscle memory.
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

# ---------- atuin (source ~/.local/share/atuin/init.nu) ----------
# Not installed in WSL right now — load only if present.
if command -q atuin
    atuin init fish | source
end

# ============================================================
# Abbreviations + aliases — mirrors nu aliases 1:1
# abbr expands visibly (fish-idiomatic); alias where nu
# replaced a command outright (ls/cat/grep/find/vim...).
# ============================================================

# ----- eza (nu: ll / la / l / ls / tree) -----
if command -q eza
    alias l='eza -F --no-filesize --no-permissions --no-user --icons=auto --group-directories-first'
    alias ls='eza -aF --icons=auto --group-directories-first'
    alias la='eza -laF --no-filesize --no-permissions --no-user --icons=auto --group-directories-first'
    alias ll='eza -laF --git --icons=auto --group-directories-first'
    alias tree='eza -F --tree --icons=auto --ignore-glob "node_modules|.git"'
    alias dtree='eza -aF --tree --only-dirs --icons=auto --ignore-glob "node_modules|.git"'
end

# ----- updates -----
# Package updates. brew cleanup is included because upgrading without it lets
# the download cache and old versions pile up indefinitely.
if command -q brew
    alias ub='brew update; and brew upgrade; and brew cleanup'
end
# Vite+ keeps its own node/pnpm copies, so it upgrades independently of brew.
if command -q vp
    alias uv-up='vp upgrade'
end

# Dotfiles: pull, then re-run install.sh so both the repo copy and every stow
# symlink are refreshed. `git pull` alone would update the repo but leave the
# linked files pointing at whatever stow last deployed.
alias ud='cd $HOME/dotfiles; and git pull --ff-only; and ./install.sh'

# ----- navigation -----
abbr -a -- .. 'cd ..'
abbr -a -- ... 'cd ../..'
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
abbr -a -- gh-create 'gh repo create --private --source=.; and git push -u --all; and gh browse'

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
    function npm --description 'pnpm passthrough (mirrors nu)' --wraps pnpm
        pnpm $argv
    end
    function npx --description 'pnpm dlx passthrough (mirrors nu); `npx skills` uses the skills defaults' --wraps pnpm
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
    abbr -a -- vpi 'vp install'
    abbr -a -- vpa 'vp add'
    abbr -a -- vpad 'vp add -D'
    abbr -a -- vpd 'vp dev'
    abbr -a -- vpb 'vp build'
    abbr -a -- vpv 'vp preview'
    abbr -a -- vpc 'vp check'
    abbr -a -- vpf 'vp fmt'
    abbr -a -- vpl 'vp lint'
    abbr -a -- vpr 'vp run'
    abbr -a -- vpx 'vp dlx'
    function vpcr --description 'vp create --package-manager pnpm --editor zed --agent agents,claude' --wraps vp
        vp create --package-manager pnpm --editor zed --agent agents,claude $argv
    end
end

# ----- skills defaults: global, symlink, crush/pi/claude-code, no prompts -----
# `skills` reads no config file or env vars for agent selection, so the
# defaults are injected in the shell. Symlinking is the CLI's default mode
# (--copy is the opt-out), so it is never passed here.
# -g/--global goes right after the subcommand so `-p/--project` still wins.
function skills --description 'skills (add defaults: -g --agent crush pi claude-code --yes)'
    switch $argv[1]
        case add a
            # Flags go right after the source: -a/--agent is variadic and
            # would swallow the source if it came first.
            set -l args $argv[2..]
            set -l tail $args[2..]
            # Respect an explicit -a/--agent or --all the caller gave.
            if not contains -- --agent $args; and not contains -- -a $args; and not contains -- --all $args
                set args $args[1] --agent crush pi claude-code $tail
            end
            if not contains -- -g $args; and not contains -- --global $args; and not contains -- -p $args; and not contains -- --project $args
                set args $args[1] -g $args[2..]
            end
            if not contains -- --yes $args; and not contains -- -y $args; and not contains -- --all $args
                set args $args[1] --yes $args[2..]
            end
            command npx -y skills@latest add $args
        case '*'
            command npx -y skills@latest $argv
    end
end
# opencode
fish_add_path /home/cmmhero/.opencode/bin

# tealdeer (binary ships as `tldr`); read pages + completions from here.
set -gx TEALDEER_CONFIG_DIR "$HOME/.config/tealdeer"
