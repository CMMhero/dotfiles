# dotfiles

Modular dotfiles managed with **GNU Stow**, with `install.sh` / `uninstall.sh` for a zero-to-hero setup or a full reset on fresh Linux / Ubuntu installations.

---

## What's Included

- **Shell (managed)**: Fish (`~/.config/fish`)
- **CLI Tools (via Homebrew)**: `atuin`, `bat`, `btop`, `chafa`, `eza`, `fastfetch`, `fd`, `fish`, `fresh-editor`, `fzf`, `gh`, `go`, `hunk`, `jq`, `lazygit`, `llmfit`, `models`, `neovim`, `opencode`, `pi-coding-agent`, `ripgrep`, `rustup`, `starship`, `stow`, `superfile`, `tealdeer`, `uv`, `zoxide`
- **Python**: `uv` (installed via brew / official script)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` — **Windows-only**. `wezterm/.wezterm.lua` is kept in the repo for reference (WSL domain, pwsh `default_prog`, Acrylic backdrop) but is **not stowed** and wezterm is **not installed** on Linux.
- **Editor**: `fresh-editor` (`~/.config/fresh`) with the Catppuccin theme package, the `color-highlighter` plugin, a `dotfiles-fresh-language` grammar, vi mode enabled at startup, and a **"Toggle vi mode"** command in the palette (Ctrl+P)
- **Runtimes & Package Managers**: pnpm and Node.js via `mise` (`core:pnpm`, `core:node`). Vite+ has been removed.
- **Theme**: Catppuccin Macchiato is the source of truth (defined once in `wezterm/.wezterm.lua`). `bat` uses it directly (`bat/.config/bat/config`), `fzf` gets an equivalent palette via `fish/.config/fish/conf.d/catppuccin.fish`, and `omp` uses its built-in `dark-catppuccin` — that one is **Mocha**-flavoured, since omp ships no Macchiato and `grep -c macchiato` over its dist returns 0.
- **AI Coding Agents**:
  - `omp` (`@oh-my-pi/pi-coding-agent` via pnpm) — **narrowly** stowed: only `~/.omp/agent/config.yml` and `~/.omp/plugins/package.json`. Everything else in `~/.omp` (sessions, run, logs, cache, `stats.db`, `install-id`, plugin `node_modules`) stays per-machine.
  - `pi` (via Homebrew) and `opencode` (via Homebrew) — installed, configs **not** managed
- **Skills**: not managed. `~/.agents/skills` and `~/skills-lock.json` stay per-machine, as do the `opencode/` / `pi/` / `omp/` skill dirs. Install with the `skills` wrapper (`pnpm dlx`, global by default): `skills add <pkg>`.

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
1. Update APT and install the base essentials: `ca-certificates`, `curl`, `git`, `stow`, `fish`.
2. Install mise (via `curl https://mise.run`) -- it replaces both Homebrew and Vite+.
3. Install every CLI tool through mise, plus `go`, `rust`, `node`, `pnpm`, and
   oh-my-pi (`github:can1357/oh-my-pi`).
4. Configure pnpm's global bin dir to `~/.local/bin`.
5. Back up any conflicting system defaults to `~/.dotfiles_backup/<timestamp>/`.
6. Link the stow packages, and link fresh / superfile / omp file-by-file.
7. Install Oh-My-Pi plugins via `pnpm`.
8. Configure Fish as the default login shell (`chsh -s $(which fish)`).
9. Hand off to a fresh fish so the new config is live.

---

## Managing Stow Packages Manually

From within `~/dotfiles`:

```bash
# Stow all managed packages to $HOME (bash/pi/opencode/wezterm excluded — not managed)
stow -v -R -t ~ fish git starship atuin bat btop fastfetch herdr hunk lazygit superfile

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
```

**Agent data is never deleted.** `~/.pi`, `~/.omp`, `~/.opencode` and `~/.agents` hold session history, credentials and caches that outlive the packages. No flag removes them — `--purge-data` was removed and now exits with an error rather than silently doing nothing.

---

## Pushing to your Remote Git Repository

```bash
cd ~/dotfiles
git remote add origin git@github.com:CMMhero/dotfiles.git
git branch -M main
git push -u origin main
```
