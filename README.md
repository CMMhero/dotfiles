# dotfiles

Modular dotfiles managed with **GNU Stow** and a zero-to-hero bootstrap script (`setup.sh`) for fresh Linux / Ubuntu installations.

---

## What's Included

- **Shells**: Fish (`~/.config/fish`), Bash (`.bashrc`, `.profile`), Zsh (`.zshrc`, `.zshenv`)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` (`~/.wezterm.lua` and `~/.config/wezterm/wezterm.lua`) with Catppuccin Macchiato, 144Hz WebGPU, leader keys, split controls
- **Editor**: `fresh-editor` (`~/.config/fresh`) with Catppuccin theme, vi mode startup, custom key calibration
- **Runtimes**: Vite+ (`~/.config/vite-plus`), Bun, Node, pnpm
- **AI Coding Agents**:
  - `pi` (`@earendil-works/pi-coding-agent`) with configured models, settings, and skills
  - `omp` (`@oh-my-pi/pi-coding-agent`) with `config.yml` (Titanium theme, Nerd font preset, Gemini model) and commandcode plugin
- **Skills**: Global skills in `~/.agents/skills/` (`find-skills`, `herdr`, `unslop`, `vercel-react-best-practices`, `web-design-guidelines`, `writing-guidelines`) pre-linked to Pi and Oh-My-Pi
- **Exclusions**: `ghostty`, `deja`, and `tuios` are excluded.

---

## Quick Start on a Fresh Linux Machine

1. Clone this repository into `~/dotfiles`:

```bash
git clone <YOUR_GIT_REPO_URL> ~/dotfiles
```

2. Run the bootstrap installer:

```bash
cd ~/dotfiles
./setup.sh
```

The script will:
1. Update APT and install base essentials (`build-essential`, `curl`, `git`, `stow`, `procps`, `file`, etc.).
2. Install Homebrew (Linuxbrew) and initialize shell environment.
3. Install all Homebrew CLI formulas (including `uv`).
4. Install Herdr (`curl -fsSL https://herdr.dev/install.sh | bash`).
5. Install Vite+ (`https://vite.plus`) and Bun.
6. Install Pi and Oh-My-Pi agents globally.
7. Back up any conflicting system defaults to `~/.dotfiles_backup/<timestamp>/`.
8. Link all packages into `$HOME` via `gnu stow`.
9. Wire skill symlinks into Pi and install Oh-My-Pi plugins.
10. Configure Fish as the default login shell.

---

## Managing Stow Packages Manually

From within `~/dotfiles`:

```bash
# Stow all packages to $HOME
stow -v -R -t ~ bash zsh fish git starship atuin btop fastfetch fresh herdr hunk lazygit superfile thefuck vite-plus pi omp skills wezterm
```

# Unstow a package
stow -v -D -t ~ herdr
```

---

## Pushing to your Remote Git Repository

```bash
cd ~/dotfiles
git remote add origin git@github.com:<username>/dotfiles.git
git branch -M main
git push -u origin main
```
