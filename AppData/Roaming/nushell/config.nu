# config.nu
#
# Installed by:
# version = "0.109.0"
#
# This file is used to override default Nushell settings, define
# (or import) custom commands, or run any other startup tasks.
# See https://www.nushell.sh/book/configuration.html
#
# Nushell sets "sensible defaults" for most configuration settings,
# so your `config.nu` only needs to override these defaults if desired.
#
# You can open this file in your default editor using:
#     config nu
#
# You can also pretty-print and page through the documentation for configuration
# options using:
#     config nu --doc | nu-highlight | less -R

# ------------------------------------------
# Main nushell configuration
# ------------------------------------------
$env.config = {
    show_banner: false # true or false to enable or disable the welcome banner at startup

    # Editor used by `config nu` / `config env` and other editor-invoking commands.
    # Use a fast terminal editor for config/small files instead of Zed.
    buffer_editor: "fresh"

    shell_integration: {
      osc133: false
    }
}

# Default text editor (fast terminal editor; use `c`/`c.` for opening projects in Zed)
$env.EDITOR = "fresh"
$env.VISUAL = "fresh"

# ------------------------------------------
# Fastfetch, Starship, Zoxide
# ------------------------------------------
#fastfetch

# Init atuin
source ~/.local/share/atuin/init.nu

# Init Starship
mkdir ~/.cache/starship
starship init nu | save -f ~/.cache/starship/init.nu
use ~/.cache/starship/init.nu

# Init Zoxide
zoxide init nushell | save -f ~/.zoxide.nu
source ~/.zoxide.nu

# Zoxide aliases
alias cd = __zoxide_z
alias cdi = __zoxide_zi

# ------------------------------------------
# Terminal / navigation
# ------------------------------------------
# Lists files in long format (with icons)
alias ll = eza -lAF --icons=auto

# Lists all files, including hidden ones (with icons)
alias la = eza -AF --icons=auto

# Lists files in simple format (with icons)
alias l = eza -F --icons=auto
alias ls = eza -F --icons=auto

# Lists files in tree format (with icons)
alias tree = eza -AF --tree --icons=auto

# Goes up one directory
alias .. = cd ..

# Goes up two directories
alias ... = cd ../..

# Shows command history
alias h = history

# Opens the current folder in editor
alias c. = zed .

# Opens editor or with editor
alias c = zed

# Opens the current folder in explorer
alias e. = explorer .

# Opens explorer or with explorer
alias e = explorer

# ------------------------------------------
# Git shortcuts
# ------------------------------------------

# Generic git command
alias g = git

# Adds all files
alias ga = git add .

# Commit with a message
alias gc = git commit -m

# Clones a repository
alias gcl = git clone

# Pushes to the remote
alias gp = git push

# Pulls changes from the remote
alias gpl = git pull

# Shows the git status
alias gst = git status

# Compact and graphical git log
alias gl = git log --oneline --graph --decorate

# Switches branch
alias gco = git checkout

# Lists branches
alias gb = git branch

# Pushes the current branch to origin
# alias gpo = git push origin (git branch | lines | get 0)
alias gpo = git push origin

# Launches lazygit
alias lg = lazygit

# ------------------------------------------
# Other shortcuts
# ------------------------------------------
# Show public IP address
alias ip = curl http://ifconfig.me/ip

# Run commands with sudo
alias please = sudo
alias pls = sudo

# Restart nushell in place (re-execs a fresh nu shell)
alias restart = exec nu
alias rn = exec nu

# Update packages (using winget)
alias update = winget upgrade --all

# Fastfetch
alias ff = fastfetch

# ------------------------------------------
# Modern CLI replacements
# ------------------------------------------
# btop is packaged as btop4win on Windows
alias btop = btop4win
alias htop = btop4win
alias top = btop4win

# bat for prettier cat / file viewing
alias cat = bat
alias bcat = bat

# fd as find replacement
alias find = fd
alias fd = fd

# ripgrep as grep replacement
alias grep = rg
alias rg = rg

# vim/nvim
alias vim = fresh
alias nvim = fresh

# ------------------------------------------
# Windows / network utilities
# ------------------------------------------
# Flush DNS cache (requires admin)
alias flushdns = ipconfig /flushdns

# Clear the terminal (nushell has native `clear`; keep cls for muscle memory)
alias cls = clear

# Show local IP configuration
alias ipconfig = ipconfig

# Quick public IP (alias `ip` above)

# ------------------------------------------
# Directory stack / navigation extras
# ------------------------------------------
# Go back multiple dirs
alias cd.. = cd ..
