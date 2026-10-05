#!/usr/bin/env zsh
# ============================================================
# Homebrew first: every CLI tool below comes from the Linuxbrew
# prefix. Resolved from the brew symlink (no brew process spawn),
# with a `brew --prefix` fallback. Fall back to /usr/bin only.
# ============================================================
if [[ -z ${HOMEBREW_PREFIX:-} ]]; then
    HOMEBREW_PREFIX="${${(M)$(readlink -f /home/linuxbrew/.linuxbrew/bin/brew 2>/dev/null):-}:h:h:h}"
    [[ -z $HOMEBREW_PREFIX ]] && HOMEBREW_PREFIX="$(brew --prefix 2>/dev/null)"
    export HOMEBREW_PREFIX
fi
typeset -U path PATH
[[ -d "$HOME/.local/bin" ]] && path=( "$HOME/.local/bin" $path )
# Homebrew wins over ~/.local/bin (fresh) and /usr/bin (old apt copies).
# rustup is keg-only (it conflicts with the `rust` formula), so its toolchain
# shims must be added explicitly or rustc/cargo go missing.
path=(
    $HOMEBREW_PREFIX/bin
    $HOMEBREW_PREFIX/sbin
    $HOMEBREW_PREFIX/opt/rustup/bin
    ${path:#$HOMEBREW_PREFIX/bin:$HOMEBREW_PREFIX/sbin:$HOMEBREW_PREFIX/opt/rustup/bin:}
)
export PATH

# ---------- zinit ----------
# HOME_DIR/completions default to ~/.local/share/zinit, matching the already
# cloned plugins; set explicitly so a relocated prefix stays coherent.
# ZINIT must be a global associative array before the keyed assignments.
typeset -gA ZINIT
ZINIT[HOME_DIR]="${ZINIT_HOME:-$HOME/.local/share/zinit}"
ZINIT[BIN_DIR]="$HOMEBREW_PREFIX/opt/zinit"
ZINIT[PLUGINS_DIR]="${ZINIT[HOME_DIR]}/plugins"
ZINIT[COMPLETIONS_DIR]="${ZINIT[HOME_DIR]}/completions"
ZINIT[SNIPPETS_DIR]="${ZINIT[HOME_DIR]}/snippets"
if [[ -r "$ZINIT[BIN_DIR]/zinit.zsh" ]]; then
    source "$ZINIT[BIN_DIR]/zinit.zsh"
fi

# ---------- History ----------
# Native HISTFILE is the fallback and the import source
# (`atuin import zsh`). Ctrl-R / Up-arrow are owned by Atuin.
HISTFILE=$HOME/.zsh_history
HISTSIZE=10000
SAVEHIST=10000
setopt APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE HIST_REDUCE_BLANKS HIST_VERIFY EXTENDED_HISTORY
setopt AUTO_CD AUTO_PUSHD PUSHD_IGNORE_DUPS PUSHD_SILENT EXTENDED_GLOB NO_CASE_GLOB
setopt COMPLETE_IN_WORD ALWAYS_TO_END AUTO_MENU AUTO_LIST AUTO_PARAM_SLASH
setopt NO_BEEP INTERACTIVE_COMMENTS RC_QUOTES LONG_LIST_JOBS
unsetopt FLOW_CONTROL MAIL_WARNING

autoload -Uz compinit
mkdir -p ~/.cache/zsh
compinit -d ~/.cache/zsh/zcompdump
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|=*' 'l:|=* r:|=*'
zstyle ':completion:*' rehash true

# zinit completion (needs compinit above)
autoload -Uz _zinit
(( ${+_comps[zinit]} )) || compdef _zinit zinit

bindkey -e
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
bindkey '^[[A' up-line-or-beginning-search
bindkey '^[[B' down-line-or-beginning-search
bindkey '^P' up-line-or-beginning-search
bindkey '^N' down-line-or-beginning-search
bindkey '^[[1;5C' forward-word
bindkey '^[[1;5D' backward-word

# ---------- Editor ----------
if (( ${+commands[fresh]} )); then
    export EDITOR=fresh VISUAL=fresh
elif (( ${+commands[nvim]} )); then
    export EDITOR=nvim VISUAL=nvim
elif (( ${+commands[vim]} )); then
    export EDITOR=vim VISUAL=vim
else
    export EDITOR=nano VISUAL=nano
fi
export VP_PACKAGE_MANAGER="pnpm@12"

# ============================================================
# zinit: everything below is declared through zinit
# ============================================================

# A single as"null" host plugin (z-shell/null is an empty repo) carries the
# tool integrations; the ices run at load time and the plugin itself sources
# nothing. Re-using one plugin id keeps zinit from cloning it once per tool.

# ---------- Starship (prompt) ----------
zinit ice as"null" atinit'eval "$(starship init zsh)"'
zinit light z-shell/null

# ---------- Zoxide ----------
zinit ice as"null" atinit'eval "$(zoxide init --cmd cd zsh)"; alias cdi="cd -i"'
zinit light z-shell/null

# ---------- fzf ----------
# Loaded BEFORE atuin so Atuin takes over Ctrl-R (history search) while
# fzf keeps Ctrl-T / Alt-C. Completion stays from fzf.
zinit ice as"null" nocompile \
    atinit'source "$HOMEBREW_PREFIX/opt/fzf/shell/key-bindings.zsh"'
zinit light z-shell/null
zinit ice as"null" nocompile \
    atinit'source "$HOMEBREW_PREFIX/opt/fzf/shell/completion.zsh"'
zinit light z-shell/null

# ---------- Atuin: shell history backend ----------
# Atuin prepends its own widget strategy, so it must come after fzf keybindings
zinit ice as"null" nocompile atinit'eval "$(atuin init zsh)"'
zinit light z-shell/null

# ---------- fzf defaults prefer fd ----------
export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_ALT_C_COMMAND="$FZF_DEFAULT_COMMAND"

# Replaces zsh-autosuggestions. Its zsh integration lives in a generated
# file, so the plugin is `pick`ed to a single .plugin.zsh rather than sourced
# Loaded synchronously (no wait"): the zinit scheduler runs deferred loads
# other plugin and silently drop them from the first prompt.

# ---------- zsh-syntax-highlighting ----------
# MUST stay last: it wraps widgets, so anything loaded after it can be
# highlighted incorrectly (and gets warned about).
zinit ice lucid
zinit light zsh-users/zsh-syntax-highlighting

# ============================================================
# Aliases
# ============================================================
alias ll='eza -lAF --icons=auto'
alias la='eza -AF --icons=auto'
alias l='eza -F --icons=auto'
alias ls='eza -F --icons=auto'
alias tree='eza -AF --tree --icons=auto'
alias ..='cd ..'
alias ...='cd ../..'
alias h='history'
# zed lives outside PATH (~/.local/share/zed); alias only when resolvable
(( ${+commands[zed]} )) && { alias c='zed'; alias 'c.'='zed .'; }
alias 'e.'='explorer.exe .'
alias e='explorer.exe'
alias g='git'
alias ga='git add .'
alias gc='git commit -m'
alias gcl='git clone'
alias gp='git push'
alias gpl='git pull'
alias gst='git status'
alias gl='git log --oneline --graph --decorate'
alias gco='git checkout'
alias gb='git branch'
alias gpo='git push origin'
alias lg='lazygit'
alias ip='curl http://ifconfig.me/ip'
alias please='sudo'
alias pls='sudo'
alias reload='exec zsh'
alias ff='fastfetch'
alias cls='clear'

# brew ships `btop`/`bat`/`fd`/`rg` under their real names, so no
# fdfind/batcat compatibility shims are needed any more.
alias htop='btop'
alias top='btop'
alias cat='bat'
alias bcat='bat'
alias find='fd'
alias grep='rg'
alias vim='fresh'
alias nvim='fresh'

# ---------- pnpm ----------
if (( ${+commands[pnpm]} )); then
  npm() { pnpm "$@"; }
  npx() {
    # `npx skills ...` routes to the skills wrapper (global, symlink,
    # crush/pi/claude-code, no prompts). Skip leading npx flags.
    local i=1 a
    for a in "$@"; do
      case "$a" in
        -*) ;;
        skills|skills@*)
          if (( i < $# )); then
            skills "${@:$((i+1))}"
          else
            skills
          fi
          return
          ;;
        *) break ;;
      esac
      i=$((i+1))
    done
    pnpm dlx "$@"
  }
  npm-real() { command npm "$@"; }
  npx-real() { command npx "$@"; }
  # ----- skills defaults: global, symlink, crush/pi/claude-code, no prompts -----
  # `skills` reads no config file or env vars for agent selection, so the
  # defaults are injected here. Symlinking is the CLI default (--copy opts out).
  skills() {
    if [[ "$1" == add || "$1" == a ]]; then
      shift
      local src="$1"
      shift
      case " $* " in
        *" --agent "*|*" -a "*|*" --all "*|*" -g "*|*" --global "*|*" -p "*|*" --project "*|*" --yes "*|*" -y "*) ;;
        *) set -- add -g "$src" --agent crush pi claude-code --yes "$@" ;;
      esac
    fi
    npx-real -y skills@latest "$@"
  }
  alias pi='pnpm install'
  alias pa='pnpm add'
  alias pad='pnpm add -D'
  alias prm='pnpm remove'
  alias prun='pnpm run'
  alias pdx='pnpm dlx'
  alias pup='pnpm update'
  alias pnls='pnpm list'
fi

# ---------- vp (Vite+) ----------
if (( ${+commands[vp]} )); then
  alias vpi='vp install'
  alias vpa='vp add'
  alias vpad='vp add -D'
  alias vpd='vp dev'
  alias vpb='vp build'
  alias vpv='vp preview'
  alias vpc='vp check'
  alias vpf='vp fmt'
  alias vpl='vp lint'
  alias vpr='vp run'
  alias vpx='vp dlx'
  vpcr() { vp create --package-manager pnpm --editor zed "$@"; }
fi
