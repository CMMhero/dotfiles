# dotfiles

Modular dotfiles managed with **GNU Stow**, with `install.sh` / `uninstall.sh` for a zero-to-hero setup or a full reset on fresh Linux / Ubuntu installations.

---

## What's Included

- **Shells**: Fish (`~/.config/fish`), Bash (`.bashrc`, `.profile`)
- **CLI Tools (via Homebrew)**: `atuin`, `bat`, `btop`, `chafa`, `eza`, `fastfetch`, `fd`, `fish`, `fresh-editor`, `fzf`, `gh`, `go`, `hunk`, `jq`, `lazygit`, `llmfit`, `models`, `neovim`, `opencode`, `pi-coding-agent`, `ripgrep`, `rustup`, `starship`, `stow`, `superfile`, `tealdeer`, `uv`, `zoxide`
- **Python**: `uv` (installed via brew / official script)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` — **Windows-only**. `.wezterm.lua` is kept in the repo for reference (WSL domain, pwsh `default_prog`, Acrylic backdrop) but is **not stowed** and wezterm is **not installed** on Linux.
- **Editor**: `fresh-editor` (`~/.config/fresh`) with the Catppuccin theme package, the `color-highlighter` plugin, a `dotfiles-fresh-language` grammar, vi mode enabled at startup, and a **"Toggle vi mode"** command in the palette (Ctrl+P)
- **Runtimes & Package Managers**: Vite+ (`~/.config/vite-plus`), **pnpm-first by default** (managed through Vite+), Node.js
- **AI Coding Agents**:
  - `pi` (`pi-coding-agent` via Homebrew) with configured models, settings, skills, and extensions (`herdr-agent-state`, `orca-agent-status`, `orca-prefill`, `orca-titlebar-spinner`)
  - `opencode` (via Homebrew) with `~/.config/opencode/`
  - `omp` (`@oh-my-pi/pi-coding-agent` via pnpm) with `config.yml` (Titanium theme, Nerd font preset, Gemini model), the `pi-commandcode-provider` plugin, and extensions (`herdr-omp-agent-state`, `opencode-zen-fix`)
- **Skills**: Global skills in `~/.agents/skills/` (`find-skills`, `herdr`, `unslop`, `vercel-react-best-practices`, `web-design-guidelines`, `writing-guidelines`) pre-linked to Pi and Oh-My-Pi
- **Exclusions (per user request)**: `ghostty`, `deja`, `tuios`, `zsh`, `marksman`, `pipx`, `thefuck`, `zinit`, `bun`

---

## Quick Start on a Fresh Ubuntu Machine

One-liner (clones or pulls the repo, then installs everything):

```bash
curl -fsSL https://raw.githubusercontent.com/CMMhero/dotfiles/main/install.sh | bash
```

Or manually:

```bash
if [[ ! -d "$HOME/dotfiles" ]]; then
  git clone https://github.com/CMMhero/dotfiles.git "$HOME/dotfiles"
else
  cd "$HOME/dotfiles" && git pull --ff-only
fi

cd "$HOME/dotfiles" || exit 1
./install.sh
```

The script will:
1. Update APT and install base essentials (`build-essential`, `curl`, `git`, `stow`, `procps`, `file`, etc.).
2. Install Homebrew (Linuxbrew) and initialize shell environment.
3. Install all Homebrew CLI formulas (including `pi-coding-agent`, `opencode`, `stow`, and `uv`).
4. Install Herdr (`curl -fsSL https://herdr.dev/install.sh | bash`).
5. Install Vite+ (`https://vite.plus`) and configure `pnpm` as the default managed package manager.
6. Install Oh-My-Pi (`omp`) globally via `pnpm`.
7. Back up any conflicting system defaults to `~/.dotfiles_backup/<timestamp>/`.
8. Link all packages into `$HOME` via `gnu stow`.
9. Wire skill symlinks into Pi and install Oh-My-Pi plugins via `pnpm`.
10. Configure Fish as the default login shell (`chsh -s $(which fish)`).

---

## Managing Stow Packages Manually

From within `~/dotfiles`:

```bash
# Stow all packages to $HOME (wezterm excluded — Windows-only)
stow -v -R -t ~ bash fish git starship atuin btop fastfetch fresh herdr hunk lazygit opencode superfile vite-plus pi omp skills

# Stow a specific package (e.g., herdr)
stow -v -R -t ~ herdr

# Unstow a package
stow -v -D -t ~ herdr
```

---

## Updating an Existing Machine

```bash
cd ~/dotfiles && git pull --ff-only && ./install.sh
```

---

## Uninstall / Reset to Default

`uninstall.sh` reverses everything `install.sh` did.

```bash
# unstow all configs, restore the default login shell, delete the repo
./uninstall.sh

# also purge installed packages (brew formulas, apt packages, vite+, herdr, global pnpm)
./uninstall.sh --purge

# non-interactive
./uninstall.sh --purge --yes

# purge packages AND wipe agent data (~/.pi, ~/.omp, ~/.opencode, ~/.agents)
./uninstall.sh --purge-data --yes
```

Session data such as atuin history and the pnpm store is preserved unless you pass `--purge-data`.

---

## Pushing to your Remote Git Repository

```bash
cd ~/dotfiles
git remote add origin git@github.com:CMMhero/dotfiles.git
git branch -M main
git push -u origin main
```
