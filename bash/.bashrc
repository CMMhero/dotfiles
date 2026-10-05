# ============================================================
# .bashrc - WSL Ubuntu @ /home/cmmhero - bash 5.x
# Ported from WSL fish config, mirrors Windows nushell config:
#   C:\Users\CMM\AppData\Roaming\nushell\config.nu
# Backup of original: ~/.bashrc.bak-fish-era
# Default login shell: /bin/bash (chsh -s /bin/bash cmmhero)
# Enhanced UI: ble.sh (autosuggestions, syntax highlighting)
# ============================================================

# If not running interactively, do not do anything
case $- in
  *i*) ;;
    *) return ;;
esac

# ---------- Environment & PATH ----------
[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && PATH="$HOME/.local/bin:$PATH"
[ -d "$HOME/.atuin/bin" ] && [[ ":$PATH:" != *":$HOME/.atuin/bin:"* ]] && PATH="$HOME/.atuin/bin:$PATH"
[ -d "$HOME/bin" ] && [[ ":$PATH:" != *":$HOME/bin:"* ]] && PATH="$HOME/bin:$PATH"
export PATH

# ---------- ble.sh: bash line editor (autosuggest + syntax) ----------
# Must be sourced early with --noattach so other tools can hook properly.
# `ble-attach` is invoked at the very bottom of this .bashrc.
if [[ -f "$HOME/.local/share/ble-nightly/ble.sh" ]]; then
  source "$HOME/.local/share/ble-nightly/ble.sh" --noattach
elif [[ -f "$HOME/.local/share/blesh/ble.sh" ]]; then
  source "$HOME/.local/share/blesh/ble.sh" --noattach
fi
if declare -F bleopt >/dev/null 2>&1; then
  bleopt complete_auto_complete=1   # fish-like autosuggestion while typing
  bleopt complete_auto_history=1    # suggest from history matches
  bleopt complete_ambiguous=1       # show completion candidates
  bleopt highlight_syntax=1         # syntax coloring (commands, strings, pipes)
  bleopt history_share=1            # share history across active sessions
fi

# ---------- History & bash options (Ubuntu defaults + extended) ----------
HISTCONTROL=ignoreboth
HISTSIZE=20000
HISTFILESIZE=20000
shopt -s histappend
shopt -s checkwinsize
shopt -s globstar

# make less friendly for non-text input files, see lesspipe(1)
[ -x /usr/bin/lesspipe ] && eval "$(SHELL=/bin/sh lesspipe)"

# identify chroot (fallback prompt)
if [ -z "${debian_chroot:-}" ] && [ -r /etc/debian_chroot ]; then
  debian_chroot=$(cat /etc/debian_chroot)
fi

# prompt fallback when starship is absent
case "$TERM" in
  xterm-color|*-256color) color_prompt=yes ;;
esac
if [ "${color_prompt-}" = yes ]; then
  PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
else
  PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
fi
unset color_prompt

# dircolors for ls & grep
if [ -x /usr/bin/dircolors ]; then
  test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
  alias ls='ls --color=auto'
  alias grep='grep --color=auto'
  alias fgrep='fgrep --color=auto'
  alias egrep='egrep --color=auto'
fi

# programmable completion
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
  fi
fi
# ---------- WezTerm OSC 7: report PWD for resurrect/splits ----------
if [[ -n "${WEZTERM_PANE-}" ]]; then
  __wezterm_osc7() {
    local cwd
    cwd=$(pwd | sed 's/\\/\//g')
    printf '\e]7;file://localhost/%s\e\\' "$cwd"
  }
  PROMPT_COMMAND="__wezterm_osc7${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi

# ---------- Default Editor ----------
if command -v fresh >/dev/null 2>&1; then
  export EDITOR=fresh VISUAL=fresh
elif command -v nvim >/dev/null 2>&1; then
  export EDITOR=nvim VISUAL=nvim
elif command -v vim >/dev/null 2>&1; then
  export EDITOR=vim VISUAL=vim
else
  export EDITOR=nano VISUAL=nano
fi

# ---------- Vite+ (pnpm-first) ----------
export VP_PACKAGE_MANAGER="pnpm@latest"
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"

# ---------- Starship (Prompt) ----------
if command -v starship >/dev/null 2>&1; then
  eval "$(starship init bash)"
fi

# ---------- Zoxide (Smart directory jumping) ----------
if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init --cmd cd bash)"
  alias cdi='cd -i'
fi

# ---------- fzf keybindings ----------
if declare -F ble-import >/dev/null 2>&1; then
  ble-import -d integration/fzf-completion 2>/dev/null
  ble-import -d integration/fzf-key-bindings 2>/dev/null
else
  [ -f /usr/share/doc/fzf/examples/key-bindings.bash ] && . /usr/share/doc/fzf/examples/key-bindings.bash
  [ -f /usr/share/doc/fzf/examples/completion.bash ] && . /usr/share/doc/fzf/examples/completion.bash
fi

# ---------- Atuin (History search & sync) ----------
if command -v atuin >/dev/null 2>&1; then
  eval "$(atuin init bash)"
fi
# ============================================================
# Aliases & Functions - mirrors Windows nushell & WSL fish 1:1
# ============================================================

# ----- eza (ll / la / l / ls / tree) -----
if command -v eza >/dev/null 2>&1; then
  alias ll='eza -lAF --icons=auto'
  alias la='eza -AF --icons=auto'
  alias l='eza -F --icons=auto'
  alias ls='eza -F --icons=auto'
  alias tree='eza -AF --tree --icons=auto'
else
  alias ll='ls -alF'
  alias la='ls -A'
  alias l='ls -CF'
fi

# ----- navigation -----
alias ..='cd ..'
alias ...='cd ../..'
alias h='history'

# ----- editor / explorer -----
if command -v zed >/dev/null 2>&1; then
  alias c.='zed .'
  alias c='zed'
else
  alias c.='"$EDITOR" .'
  alias c='"$EDITOR"'
fi
if command -v explorer.exe >/dev/null 2>&1; then
  alias e.='explorer.exe .'
  alias e='explorer.exe'
fi

# ----- git -----
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
command -v lazygit >/dev/null 2>&1 && alias lg='lazygit'

# ----- misc -----
alias ip='curl -s http://ifconfig.me/ip; echo'
alias please='sudo'
alias pls='sudo'
alias restart='exec bash'
alias rn='exec bash'
alias cls='clear'
command -v fastfetch >/dev/null 2>&1 && alias ff='fastfetch'

# nu `update` = winget upgrade --all via Windows host
update() {
  if command -v winget.exe >/dev/null 2>&1; then
    winget.exe upgrade --all --include-unknown --silent \
      --accept-package-agreements --accept-source-agreements \
      --disable-interactivity
  else
    echo "update: winget.exe not found" >&2
    return 1
  fi
}

# nu `flushdns` = ipconfig /flushdns
flushdns() {
  if command -v ipconfig.exe >/dev/null 2>&1; then
    ipconfig.exe /flushdns
  else
    echo "flushdns: ipconfig.exe not found" >&2
    return 1
  fi
}

# ----- modern CLI replacements -----
command -v btop >/dev/null 2>&1 && alias htop='btop' && alias top='btop'
command -v bat >/dev/null 2>&1 && alias cat='bat' && alias bcat='bat'
command -v fd >/dev/null 2>&1 && alias find='fd'
command -v rg >/dev/null 2>&1 && alias grep='rg'
if command -v fresh >/dev/null 2>&1; then
  alias vim='fresh'
  alias nvim='fresh'
fi

# ----- pnpm-first -----
if command -v pnpm >/dev/null 2>&1; then
  npm() { pnpm "$@"; }
  npx() {
    # `npx skills ...` routes to the skills wrapper (global, symlink,
    # crush/pi/claude-code, no prompts). Skip leading npx flags.
    local i=1 a
    for a in "$@"; do
      case "$a" in
        -*) ;;
        skills|skills@*)
          if [ $i -lt $# ]; then
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
    if [ "$1" = add ] || [ "$1" = a ]; then
      shift
      local src="" tail=()
      src="$1"; shift
      tail=("$@")
      case " $* " in
        *" --agent "*|*" -a "*|*" --all "*|*" -g "*|*" --global "*|*" -p "*|*" --project "*|*" --yes "*|*" -y "*) ;;
        *) set -- add -g "$src" --agent crush pi claude-code --yes "${tail[@]}" ;;
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

# ----- Vite+ (vp) -----
if command -v vp >/dev/null 2>&1; then
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

# ----- user-local aliases -----
[ -f ~/.bash_aliases ] && . ~/.bash_aliases

# ---------- ble.sh: attach (MUST be the final line) ----------
if declare -F ble-attach >/dev/null 2>&1; then
  ble-attach
fi
