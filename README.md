# dotfiles

Modular dotfiles managed with **GNU Stow**, with `install.sh` / `uninstall.sh` for a zero-to-hero setup or a full reset on fresh Linux / Ubuntu installations.

---

## What's Included

- **Shell (managed)**: Fish (`~/.config/fish`), installed as a **Homebrew formula**, not from apt — brew holds it at a fixed path (`/home/linuxbrew/.linuxbrew/bin/fish`) so upgrading it never breaks `chsh` or herdr's `default_shell`
- **Package managers**: `apt` for the base system, **Homebrew / Linuxbrew** for `fish` and `mise` itself, `mise` for everything else
- **CLI Tools (via `mise`)**: `atuin`, `bat`, `btop`, `chafa`, `delta`, `eza`, `fastfetch`, `fd`, `fzf`, `gh`, `go`, `herdr`, `hunk`, `jq`, `lazygit`, `neovim`, `node`, `opencode`, `pi`, `pnpm`, `ripgrep`, `rust`, `starship`, `superfile`, `tealdeer`, `uv`, `vite+`, `zoxide`
- **Python**: `uv` (via `mise`)
- **Terminal Workspace & Emulators**:
  - `herdr` (`~/.config/herdr/config.toml`) with custom keybindings, tabs, and Catppuccin theme
  - `wezterm` — **Windows-only**. `wezterm/.wezterm.lua` is kept in the repo for reference (WSL domain, pwsh `default_prog`, Acrylic backdrop) but is **not stowed** and wezterm is **not installed** on Linux.
- **Editor**: `fresh-editor` (`~/.config/fresh`) with the Catppuccin theme package, the `color-highlighter` plugin, a `dotfiles-fresh-language` grammar, vi mode enabled at startup, and a **"Toggle vi mode"** command in the palette (Ctrl+P)
- **Runtimes & Package Managers**: node and pnpm via `mise` (`core:node`, `core:pnpm`). `vite+` is installed as a tool too, but its config sets every runtime and package-manager mode to `system_first`, so it defers to mise instead of managing its own copies.
- **Theme**: Catppuccin Macchiato is the source of truth (defined once in `wezterm/.wezterm.lua`). `bat` uses it directly (`bat/.config/bat/config`), `fzf` gets an equivalent palette via `fish/.config/fish/conf.d/catppuccin.fish`, and `omp` uses its built-in `dark-catppuccin` — that one is **Mocha**-flavoured, since omp ships no Macchiato and `grep -c macchiato` over its dist returns 0.
- **AI Coding Agents**:
  - `omp` (via `mise` as `github:can1357/oh-my-pi`) — **narrowly** stowed: only `~/.omp/agent/config.yml`, `~/.omp/plugins/package.json` and `~/.omp/agent/extensions/opencode-zen-fix.ts`. Everything else in `~/.omp` (sessions, run, logs, cache, `stats.db`, `install-id`, plugin `node_modules`) stays per-machine.
  - `pi` (`aqua:earendil-works/pi`) and `opencode` (`aqua:anomalyco/opencode`) — installed via `mise`, configs **not** managed
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

The script will, in order:
1. Install the apt base essentials: `ca-certificates`, `curl`, `fish`, `git`, `stow`.
   This runs **before** the clone, because the `curl | bash` entry point may run
   on a machine where nothing is installed yet -- which is why the clone cannot
   come first.
2. Clone the repository (or pull, if it already exists).
3. Install `mise` via `curl https://mise.run`.
4. Install every other tool through mise: the CLI tools plus `go`, `rust`,
   `node`, `pnpm`, `vite+` and oh-my-pi (`github:can1357/oh-my-pi`).
5. Point pnpm's global bin dir at `~/.local/bin`.
6. Back up conflicting files to `~/.dotfiles_backup/<timestamp>/`.
7. Link the stow packages, and link `fresh` / `superfile` / `omp` file-by-file
   (stow would link those app directories whole).
8. Install omp's plugins with `pnpm`.
9. Set fish as the default login shell.
10. Hand off to a fresh fish so the new config is live.

Re-running is safe. `./install.sh --config-only` deploys only the configs, which
is what `upd dotfiles` uses so it does not repeat the package work.

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

# also purge installed packages (mise tools, mise itself, apt packages, global pnpm)
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
